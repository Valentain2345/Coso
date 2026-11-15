// Visual and performance check for the background transcription queue.
//
// Drives the built app in Chromium, takes screenshots of the status strip in
// its states (idle, running, details open, phone width, recording while a run
// is in flight), and samples Chrome's performance counters while a real
// transcription downloads models and works, so the UI cost of the queue can be
// checked instead of guessed.
//
// Usage (with `npm run build` done and `npm run preview` serving the app):
//   node tools/ui-check.mjs [url] [outputDir]
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const url = process.argv[2] ?? 'http://localhost:4173';
const outDir = path.resolve(process.argv[3] ?? 'test-results/ui');
const fixture = path.resolve('tests/fixtures/speech.wav');

fs.mkdirSync(outDir, { recursive: true });
const startedAt = Date.now();

const browser = await chromium.launch({
  // Deterministic microphone so recording can be exercised without hardware.
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
const page = await context.newPage();

// Installed before the app boots: long tasks and frame pacing.
await page.addInitScript(() => {
  window.__cosoLongTasks = [];
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.__cosoLongTasks.push({ start: entry.startTime, duration: entry.duration });
    }
  }).observe({ type: 'longtask', buffered: true });

  window.__cosoFrames = [];
  let last = performance.now();
  const tick = (now) => {
    window.__cosoFrames.push(now - last);
    last = now;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});

const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map((entry) => [entry.name, entry.value]));
};

const shot = async (name) => {
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`  screenshot ${name}.png`);
};

console.log(`> loading ${url}`);
const navigationStart = Date.now();
await page.goto(url);
await page.getByRole('heading', { name: /Record a lecture/ }).waitFor();
const startupMs = Date.now() - navigationStart;

const paint = await page.evaluate(() => {
  const nav = performance.getEntriesByType('navigation')[0];
  const fcp = performance.getEntriesByName('first-contentful-paint')[0];
  return {
    domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd),
    loadMs: Math.round(nav.loadEventEnd),
    firstContentfulMs: Math.round(fcp?.startTime ?? 0),
  };
});

await shot('01-start');

console.log('> starting a transcription');
await page.locator('input[type="file"]').setInputFiles(fixture);
await page.locator('.preview-card').waitFor({ timeout: 30_000 });
await page.getByRole('button', { name: 'Transcribe all' }).click();
const strip = page.locator('.main-shell > .job-strip');
await strip.waitFor({ timeout: 30_000 });
await page.waitForTimeout(2000);
await shot('02-strip-running');

const stripGeometry = await page.evaluate(() => {
  const stripEl = document.querySelector('.job-strip');
  const topbar = document.querySelector('.topbar');
  const content = document.querySelector('.content');
  return {
    stripHeight: Math.round(stripEl?.getBoundingClientRect().height ?? 0),
    stripAboveTitle: (stripEl?.getBoundingClientRect().bottom ?? 0) <= (topbar?.getBoundingClientRect().top ?? 0) + 1,
    workspaceTop: Math.round(content?.getBoundingClientRect().top ?? 0),
  };
});

await page.getByRole('button', { name: 'Show transcription details' }).click();
await page.waitForTimeout(500);
await shot('03-strip-details');
const detailsGeometry = await page.evaluate(() => ({
  stripHeight: Math.round(document.querySelector('.job-strip')?.getBoundingClientRect().height ?? 0),
  // The workspace is still mounted and scrollable behind the panel, not replaced.
  workspacePresent: Boolean(document.querySelector('.content .capture')),
  cancelButtons: document.querySelectorAll('.job-strip .btn').length,
}));
await page.getByRole('button', { name: 'Continue in the background' }).click();

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await shot('04-strip-phone');
const phoneOverflow = await page.evaluate(() => ({
  horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  stripHeight: Math.round(document.querySelector('.job-strip')?.getBoundingClientRect().height ?? 0),
}));
await page.setViewportSize({ width: 1280, height: 820 });

// Recording while a transcription is in flight: both must keep working.
console.log('> recording while the queue runs');
await page.getByRole('button', { name: /Start recording/i }).click();
await page.locator('.recording-card').waitFor({ timeout: 20_000 });
await page.waitForTimeout(3000);
const recordingState = await page.evaluate(() => ({
  stripVisible: Boolean(document.querySelector('.job-strip')),
  clock: document.querySelector('.recording-clock')?.textContent?.trim() ?? '',
}));
await shot('05-recording-during-run');
await page.getByRole('button', { name: /Stop & transcribe/i }).click();
await page.locator('.preview-card').waitFor({ timeout: 30_000 });
const queuedLabel = await page.getByRole('button', { name: 'Add to queue' }).count();
await shot('06-preview-queueing');

// Join the running queue with the new recording: the strip must report it.
if (queuedLabel > 0) {
  await page.getByRole('button', { name: 'Add to queue' }).click();
  await page.waitForTimeout(800);
  await shot('06b-strip-queued');
}
const queuedBadge = await page.locator('.job-strip-queued').innerText().catch(() => '');

// Sample the engine while the run continues: CPU busy, heap, long tasks.
console.log('> sampling performance for 45s while scrolling the workspace');
const before = await metrics();
const sampleStart = Date.now();
while (Date.now() - sampleStart < 45_000) {
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(400);
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(400);
}
const after = await metrics();
const wallSeconds = (Date.now() - sampleStart) / 1000;
const longTasks = await page.evaluate(() => window.__cosoLongTasks ?? []);
const frames = await page.evaluate(() => window.__cosoFrames ?? []);
await shot('07-after-sampling');

const taskSeconds = after.TaskDuration - before.TaskDuration;
const heapMb = (value) => Math.round((value / (1024 * 1024)) * 10) / 10;
const sorted = [...frames].sort((a, b) => a - b);
const frameGap = (ratio) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] ?? 0);
const probing = longTasks.filter((task) => task.start > 0);

const report = {
  url,
  startupMs,
  ...paint,
  strip: { ...stripGeometry, ...detailsGeometry, ...phoneOverflow },
  recording: { ...recordingState, addToQueueButton: queuedLabel > 0, queuedBadge },
  perf: {
    windowSeconds: Math.round(wallSeconds),
    mainThreadBusyPercent: Math.round((taskSeconds / wallSeconds) * 100),
    longTasks: probing.length,
    longestTaskMs: Math.round(Math.max(0, ...probing.map((task) => task.duration))),
    heapBeforeMb: heapMb(before.JSHeapUsedSize),
    heapAfterMb: heapMb(after.JSHeapUsedSize),
    documents: after.Documents - before.Documents,
    frames: frames.length,
    p50FrameGapMs: frameGap(0.5),
    p95FrameGapMs: frameGap(0.95),
    worstFrameGapMs: frameGap(1),
  },
  totalSeconds: Math.round((Date.now() - startedAt) / 1000),
};

fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

await browser.close();
