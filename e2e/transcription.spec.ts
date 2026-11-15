import path from 'node:path';
import { test, expect } from '@playwright/test';

const FIXTURE = path.resolve('tests/fixtures/speech.wav');

test('imports audio, transcribes on-device, and downloads the recording', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Record a lecture/ })).toBeVisible();

  // Use the higher-accuracy Pyannote segmentation + WeSpeaker pipeline.
  await page.locator('.topbar button[aria-label="Settings"]').click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await dialog.getByLabel('Speaker model', { exact: true }).selectOption('pyannote');
  await dialog.getByLabel('Speaker precision', { exact: true }).selectOption('thorough');
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.waitForTimeout(600);

  await page.locator('input[type="file"]').setInputFiles(FIXTURE);

  // The preview gate: listen to the first seconds and commit to the run.
  await expect(page.locator('.preview-card')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Transcribe all' }).click();

  // The run continues above the title bar: the start screen stays usable so the
  // next lecture can be recorded or imported while this one is transcribed.
  const strip = page.locator('.main-shell > .job-strip');
  await expect(strip).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Start recording/i })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import audio' })).toBeVisible();

  // The strip is chrome, not part of the scrolling content.
  const stripBox = await strip.boundingBox();
  const topbarBox = await page.locator('.topbar').boundingBox();
  expect(stripBox).not.toBeNull();
  expect(topbarBox).not.toBeNull();
  expect(stripBox!.y).toBeLessThan(topbarBox!.y);
  expect(stripBox!.height).toBeLessThan(60);

  // The step-by-step panel opens inside the strip and folds back again, without
  // taking the workspace away.
  await page.getByRole('button', { name: 'Show transcription details' }).click();
  await expect(strip.locator('.job-strip-panel .progress-card')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Import audio' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue in the background' }).click();
  await expect(strip.locator('.job-strip-panel')).toHaveCount(0);
  await expect(strip).toBeVisible();

  // The first run downloads Whisper Base and the denoiser, then transcribes.
  await expect(page.locator('.transcript-card')).toBeVisible({ timeout: 12 * 60_000 });
  await expect(page.locator('.progress-card')).toHaveCount(0);
  await expect(page.locator('.job-strip')).toHaveCount(0);

  const firstPassage = page.locator('.segment-text').first();
  await expect(firstPassage).not.toHaveText('');
  expect((await firstPassage.innerText()).trim().length).toBeGreaterThan(5);

  await expect(page.locator('.segment-speaker').first()).toContainText('Speaker 1');
  await expect(page.getByRole('region', { name: 'Audio player' })).toBeVisible();

  // Re-process: run the same session again with new settings. The result must
  // replace the transcript without creating a second session.
  await page.getByRole('button', { name: 'Re-transcribe' }).click();
  const quick = page.getByRole('dialog', { name: 'Re-transcribe' });
  await expect(quick).toBeVisible();
  await quick.getByRole('button', { name: 'Re-transcribe now' }).click();
  await expect(page.locator('.progress-card')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.transcript-card')).toBeVisible({ timeout: 5 * 60_000 });

  const downloadStarted = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download audio recording' }).click();
  const download = await downloadStarted;
  expect(download.suggestedFilename()).toMatch(/\.wav$/);

  await page.getByRole('button', { name: 'Export' }).click();
  const audioExport = page.getByRole('menuitem', { name: /Original audio/ });
  await expect(audioExport).toBeVisible();
  await expect(audioExport).toContainText('.wav');

  const textDownloadStarted = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: /Plain text/ }).click();
  const textDownload = await textDownloadStarted;
  expect(textDownload.suggestedFilename()).toMatch(/\.txt$/);

  // The session and its audio survive a reload, so lectures can be revisited later.
  await page.reload();
  const recent = page.locator('.recent-card').first();
  await expect(recent).toBeVisible({ timeout: 60_000 });
  await recent.click();
  await expect(page.locator('.transcript-card')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.segment-text').first()).not.toHaveText('');
  await expect(page.getByRole('button', { name: 'Download audio recording' })).toBeVisible();

  expect(pageErrors).toEqual([]);
});
