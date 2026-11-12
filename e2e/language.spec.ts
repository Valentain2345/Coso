import { test, expect } from '@playwright/test';

/**
 * The English↔Spanish switch lives in Settings and must flip every visible
 * surface instantly, persist across reloads, and never lose the dialog state.
 */
test.describe('app language', () => {
  test('switches the interface to Spanish from Settings and back', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: /Record a lecture/ })).toBeVisible();

    await page.locator('.topbar button[aria-label="Settings"]').click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('radio', { name: 'Español' }).click();
    await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
    // The dialog's accessible name flips with the language, so re-query it.
    await expect(page.getByRole('dialog', { name: 'Ajustes' }).getByText('Modelo', { exact: true })).toBeVisible();

    // The choice persists for the next visit.
    await page.getByRole('dialog', { name: 'Ajustes' }).getByRole('button', { name: 'Listo' }).click();
    await expect(dialog).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('button', { name: /Empezar a grabar/ })).toBeVisible();
    await expect(page.getByText(/Suelta un archivo de audio/)).toBeVisible();

    // Library surfaces flip too: open Settings again and switch back.
    await page.locator('.topbar button[aria-label="Ajustes"]').click();
    const settingsEs = page.getByRole('dialog', { name: 'Ajustes' });
    await expect(settingsEs).toBeVisible();
    await settingsEs.getByRole('radio', { name: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // The dialog's accessible name flipped back with the language.
    await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Start recording/ })).toBeVisible();
  });

  test('keeps the settings panel stable while switching language', async ({ page }) => {
    await page.goto('/');
    await page.locator('.topbar button[aria-label="Settings"]').click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    const panel = page.locator('.modal');

    const before = await panel.boundingBox();
    await dialog.getByRole('radio', { name: 'Español' }).click();
    await expect(page.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
    const after = await panel.boundingBox();

    // The dialog stays top-aligned; switching language must not fling the
    // panel around the screen.
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThan(8);
  });
});
