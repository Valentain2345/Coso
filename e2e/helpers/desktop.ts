import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Desktop (Tauri) E2E driver.
 *
 * Launches the built `coso.exe` with the WebView2 remote-debugging port and
 * attaches Playwright to it over CDP. The desktop shell provides COOP/COEP and
 * a real window, so this exercises the packaged app rather than a plain tab.
 */

const EXE = path.resolve('src-tauri/target/release/coso.exe');
const CDP_PORT = 9223;

let child: ChildProcess | null = null;

/** Kill any leftover app instance (and its WebView2 children) from earlier runs. */
function killLeftovers(): void {
  try {
    execSync('taskkill /F /T /IM coso.exe', { stdio: 'ignore' });
  } catch {
    /* none running */
  }
  // WebView2 shares one browser process per user-data folder. If one survives
  // without the debugging flag, a new launch attaches to it and CDP never
  // appears — so kill the stale ones for this app's profile.
  try {
    const out = execSync(
      'pwsh -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'msedgewebview2.exe\'\\" | Where-Object { $_.CommandLine -match \'coso\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"',
      { stdio: 'ignore', timeout: 20_000 },
    );
    void out;
  } catch {
    /* none running */
  }
}

export async function launchDesktop(attempts = 2): Promise<{ browser: Browser; page: Page }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await launchOnce();
    } catch (error) {
      lastError = error;
      await closeDesktop();
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

/**
 * One launch attempt. A slow or wedged WebView2 can miss the CDP port while a
 * parallel build hogs the machine, so callers get a retry; a launcher that
 * exits on its own is reported immediately instead of waiting out the timeout.
 */
async function launchOnce(): Promise<{ browser: Browser; page: Page }> {
  if (!fs.existsSync(EXE)) {
    throw new Error(
      `Desktop binary not found at ${EXE}. Run "npx tauri build" first (see README "Desktop app").`,
    );
  }

  killLeftovers();
  child = spawn(EXE, [], {
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --remote-allow-origins=*`,
    },
    stdio: 'ignore',
  });
  const launcher = child;

  // Wait for the CDP endpoint to come up.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (launcher.exitCode !== null) {
      throw new Error(`coso.exe exited with code ${launcher.exitCode} during launch`);
    }
    if (Date.now() > deadline) throw new Error('The desktop app did not expose a debugging port');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  // The first seconds after boot can reset sockets while targets register.
  let browser: Browser | null = null;
  for (let attempt = 0; attempt < 5 && !browser; attempt += 1) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!browser) throw new Error('Could not attach Playwright to the desktop app');

  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  // CDP can attach while the WebView is still parked on about:blank, where
  // localStorage is denied; wait until the app origin has committed.
  await page.waitForURL(/tauri\.localhost|tauri:\/\//, { timeout: 60_000 }).catch(() => undefined);
  return { browser, page };
}

export async function closeDesktop(browser?: Browser): Promise<void> {
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  child?.kill();
  child = null;
  // WebView2 children can outlive the launcher process and hold the CDP port.
  killLeftovers();
}

/** Best-effort cleanup guard for tests that throw before closeDesktop. */
export function withDesktop(
  fn: (page: Page, context: BrowserContext) => Promise<void>,
): () => Promise<void> {
  return async () => {
    const { browser, page } = await launchDesktop();
    try {
      await fn(page, browser.contexts()[0]);
    } finally {
      await closeDesktop(browser);
    }
  };
}
