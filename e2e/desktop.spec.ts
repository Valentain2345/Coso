import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { launchDesktop, closeDesktop } from './helpers/desktop';

/**
 * Smoke tests against the packaged Windows app. Skipped unless the Tauri
 * release binary has been built, so a fresh clone only runs the web E2E.
 */
const EXE = 'src-tauri/target/release/coso.exe';
const hasBinary = fs.existsSync(EXE);

test.describe('desktop shell', () => {
  test.skip(!hasBinary, `Build the desktop app first (npx tauri build) to enable: ${EXE} missing`);

  let browser: Awaited<ReturnType<typeof launchDesktop>>['browser'];
  let page: Awaited<ReturnType<typeof launchDesktop>>['page'];

  test.beforeEach(async () => {
    ({ browser, page } = await launchDesktop());
    // The WebView2 profile persists the interface language across runs; pin
    // English so the assertions below are deterministic.
    const lang = await page.evaluate(() => localStorage.getItem('coso.uiLang'));
    if (lang !== 'en') {
      await page.evaluate(() => localStorage.setItem('coso.uiLang', 'en'));
      await page.reload();
    }
  });

  test.afterEach(async () => {
    await closeDesktop(browser);
  });

  test('opens the app in a real window with the start screen', async () => {
    await expect(page.getByRole('heading', { name: /Record a lecture/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('button', { name: /Start recording/ })).toBeVisible();
  });

  test('serves the app with COOP/COEP so multithreaded WASM works', async () => {
    // Cross-origin isolation is what enables threaded inference on desktop.
    const isolated = await page.evaluate(() => crossOriginIsolated === true);
    expect(isolated).toBe(true);
  });

  test('loads with no stray console errors', async () => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.reload();
    await expect(page.getByRole('heading', { name: /Record a lecture/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  // Regression: reopening the app used to leave the window stuck on the boot
  // splash because a stale service worker intercepted the module bundle.
  test('reopens reliably after being closed', async () => {
    await closeDesktop(browser);

    for (let cycle = 1; cycle <= 2; cycle += 1) {
      const reopened = await launchDesktop();
      try {
        const lang = await reopened.page.evaluate(() => localStorage.getItem('coso.uiLang'));
        if (lang !== 'en') {
          await reopened.page.evaluate(() => localStorage.setItem('coso.uiLang', 'en'));
          await reopened.page.reload();
        }
        await expect(
          reopened.page.getByRole('heading', { name: /Record a lecture/ }),
          `launch ${cycle} did not mount`,
        ).toBeVisible({ timeout: 30_000 });
        await expect(
          reopened.page.locator('#boot'),
          `launch ${cycle} stayed on the boot splash`,
        ).toHaveCount(0, { timeout: 5_000 });
        const controlled = await reopened.page.evaluate(() =>
          Boolean(navigator.serviceWorker?.controller),
        );
        expect(controlled, `launch ${cycle} was controlled by a service worker`).toBe(false);
      } finally {
        await closeDesktop(reopened.browser);
      }
    }
  });
});
