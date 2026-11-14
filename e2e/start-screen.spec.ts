import { test, expect } from '@playwright/test';

test.describe('start screen', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Record a lecture/ })).toBeVisible();
  });

  test('queues several imported files behind the first preview', async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles([
      { name: 'lecture-01.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF') },
      { name: 'lecture-02.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF') },
      { name: 'lecture-03.wav', mimeType: 'audio/wav', buffer: Buffer.from('RIFF') },
    ]);

    await expect(page.getByRole('heading', { name: 'Listen before transcribing' })).toBeVisible();
    await expect(page.getByText('2 more queued after this one.')).toBeVisible();
    await expect(page.getByText('lecture-01.wav')).toBeVisible();

    await page.getByRole('button', { name: /Discard recording/ }).click();
    await expect(page.getByRole('heading', { name: /Record a lecture/ })).toBeVisible();
  });

  test('keeps the default start screen free of warnings', async ({ page }) => {
    await expect(page.locator('.capture-warning')).toHaveCount(0);
  });

  test('warns about precision models and thorough speaker separation', async ({ page }) => {
    await page.locator('.topbar button[aria-label="Settings"]').click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Model', { exact: true }).selectOption('whisper-large-v3-turbo');
    await expect(dialog.locator('.model-note .model-warning')).toContainText(/1–1\.5 GB/);
    await expect(dialog.locator('.model-note .model-warning')).toContainText(/WebGPU/);

    await dialog.getByLabel('Speaker precision').selectOption('thorough');
    await expect(dialog.getByText(/Thorough re-embeds/)).toBeVisible();

    await dialog.getByLabel('Speaker model', { exact: true }).selectOption('pyannote');
    await expect(dialog.getByText(/Pyannote 3\.0 runs a segmentation pass/)).toBeVisible();

    await dialog.getByLabel('Noise removal').selectOption('maximum');
    await expect(dialog.getByText(/Maximum suppression combines/)).toBeVisible();

    await dialog.getByRole('button', { name: 'Done' }).click();
    const warning = page.locator('.capture-warning');
    await expect(warning).toContainText('Whisper Large v3 Turbo');
    await expect(warning).toContainText('Thorough speaker separation');
    await expect(warning).toContainText('Pyannote 3.0');
    await expect(warning).toContainText('Maximum noise removal');
    await expect(warning).toContainText('Settings');

    // The precision choice persists for the next visit (settings save is debounced).
    await page.waitForTimeout(600);
    await page.reload();
    await expect(page.locator('.capture-warning')).toContainText('Whisper Large v3 Turbo');
  });

  test('offers a single Google sign-in button once the copy is configured', async ({ page }) => {
    await page.locator('.topbar button[aria-label="Google Drive"]').click();
    const dialog = page.getByRole('dialog', { name: 'Google Drive' });
    await expect(dialog).toBeVisible();

    // A fresh copy shows the one-time owner setup instead of developer jargon
    // in the everyday flow.
    await expect(dialog.getByText('One-time setup for this copy of Coso')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);

    await dialog.getByLabel('Google OAuth client ID').fill('test-client.apps.googleusercontent.com');
    await dialog.getByRole('button', { name: 'Save client ID' }).click();

    await expect(dialog.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await expect(dialog.getByText(/never sees your password/)).toBeVisible();
    await expect(dialog.getByLabel('Google OAuth client ID')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('shows drawer controls only while the library is a drawer', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.topbar-menu')).toBeHidden();
    await expect(page.locator('.sidebar-close')).toBeHidden();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.topbar-menu')).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.sidebar-close')).toBeHidden();

    const burger = page.locator('.topbar-menu');
    const box = await burger.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);

    await burger.click();
    await expect(page.locator('.topbar-menu')).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.locator('.sidebar-close')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar')).toBeHidden();

    // Reopening and then widening must drop the drawer controls again.
    await burger.click();
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(page.locator('.topbar-menu')).toBeHidden();
    await expect(page.locator('.sidebar-close')).toBeHidden();
    await expect(page.locator('.sidebar')).toBeVisible();
  });

  test('renders the record button in both themes', async ({ page }) => {
    const record = page.getByRole('button', { name: /Start recording/ });
    const toggle = page.locator('.topbar button[title="Toggle theme"]');
    const styles = () =>
      record.evaluate((element) => {
        const computed = getComputedStyle(element);
        return { background: computed.backgroundColor, color: computed.color };
      });

    if ((await page.locator('html').getAttribute('data-theme')) === 'dark') {
      await toggle.click();
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await styles()).toEqual({ background: 'rgb(217, 80, 43)', color: 'rgb(255, 255, 255)' });

    await toggle.click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    expect(await styles()).toEqual({ background: 'rgb(240, 106, 65)', color: 'rgb(26, 16, 12)' });
  });
});
