import fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { androidAvailable, findDebugApk, launchAndroid, closeAndroid } from './helpers/android';

/**
 * Android (Tauri) E2E. Drives the real app on an emulator or device over
 * the WebView debugging socket. Skipped unless an Android device/AVD exists —
 * see README "Phone app (Tauri for Android)" for how to create one.
 */
const available = findDebugApk() !== null && androidAvailable();

test.describe('android shell', () => {
  test.skip(!available, 'Needs an Android emulator or device (or AVD) and the debug APK — see README "Android"');

  let page: Awaited<ReturnType<typeof launchAndroid>>;

  test.beforeEach(async () => {
    page = await launchAndroid();
    // Pin English so the assertions below are deterministic.
    const lang = await page.evaluate(() => localStorage.getItem('coso.uiLang'));
    if (lang !== 'en') {
      await page.evaluate(() => localStorage.setItem('coso.uiLang', 'en'));
      await page.reload();
    }
  });

  test.afterEach(async () => {
    await closeAndroid();
  });

  test('opens the app with the start screen in a real WebView', async () => {
    await expect(page.getByRole('heading', { name: /Record a lecture/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Start recording/ })).toBeVisible();
  });

  test('runs on-device: no server beyond the forwarded debugging socket', async () => {
    expect(page.url()).toMatch(/^https?:\/\/localhost/);
  });

  test('records a short clip and shows the saved session', async () => {
    await page.getByRole('button', { name: 'Start recording' }).click();
    await expect(page.getByRole('button', { name: /Stop & transcribe/ })).toBeVisible();
    await page.waitForTimeout(4000);
    await page.getByRole('button', { name: /Stop & transcribe/ }).click();
    await expect(page.getByText(/saved/).first()).toBeVisible();
  });
});
