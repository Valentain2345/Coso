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

// The repair tool gets the same visual treatment: presets, the fine-tune
// panel, the before/after measurements and a phone-width pass.
console.log('> opening the repair tool');
await page.locator('input[type="file"]').setInputFiles(fixture);
await page.locator('.preview-card').waitFor({ timeout: 30_000 });
await page.getByRole('button', { name: 'Repair audio' }).click();
const repair = page.getByRole('dialog', { name: 'Repair this audio' });
await repair.waitFor({ timeout: 30_000 });
await repair.locator('.repair-presets').waitFor({ timeout: 30_000 });
await shot('01b-repair');
const repairBase = await page.evaluate(() => {
  const dialog = document.querySelector('.repair-body')?.closest('.modal');
  return {
    dialogHeight: Math.round(dialog?.getBoundingClientRect().height ?? 0),
    presets: document.querySelectorAll('.repair-preset').length,
    measured: Boolean(document.querySelector('.repair-levels')),
    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  };
});
await repair.getByRole('button', { name: /Fine-tune/ }).click();
await page.waitForTimeout(400);
await shot('01c-repair-fine-tune');
const repairTune = await page.evaluate(() => ({
  sliders: document.querySelectorAll('.repair-tune input[type="range"]').length,
  switches: document.querySelectorAll('.repair-tune [role="switch"]').length,
  bodyScrolls: (() => {
    const body = document.querySelector('.modal-body');
    return Boolean(body && body.scrollHeight > body.clientHeight);
  })(),
}));
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
await shot('01d-repair-phone');
const repairPhone = await page.evaluate(() => ({
  horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
  presets: document.querySelectorAll('.repair-preset').length,
}));
await page.setViewportSize({ width: 1280, height: 820 });
await repair.getByRole('button', { name: 'Cancel' }).click();
await page.locator('.preview-card').waitFor();
await page.getByRole('button', { name: 'Transcribe all' }).click();

console.log('> starting a transcription');
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
// Emulate a notched phone: the strip is the topmost surface, so its background
// must run under the status bar and its content must stay clear of it.
let safeAreaTop = 0;
try {
  await page.context().newCDPSession(page).then((session) =>
    session.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 47, left: 0, bottom: 34, right: 0 },
    }),
  );
  safeAreaTop = 47;
} catch (error) {
  console.warn('safe-area emulation unavailable:', error.message);
}
await page.waitForTimeout(500);
await shot('04-strip-phone');
const phoneOverflow = await page.evaluate(() => {
  const strip = document.querySelector('.job-strip');
  const text = document.querySelector('.job-strip-text');
  const row = document.querySelector('.job-strip-row');
  const buttons = Array.from(document.querySelectorAll('.job-strip-row .btn'));
  const heights = buttons.map((button) => Math.round(button.getBoundingClientRect().height));
  return {
    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    stripHeight: Math.round(strip?.getBoundingClientRect().height ?? 0),
    stripTop: Math.round(strip?.getBoundingClientRect().top ?? 0),
    stripPaddingTop: Math.round(parseFloat(getComputedStyle(strip).paddingTop || '0')),
    textTop: Math.round(text?.getBoundingClientRect().top ?? 0),
    minButtonHeight: heights.length ? Math.min(...heights) : 0,
    buttonCount: buttons.length,
    rowOverflows: Boolean(row && row.scrollWidth > row.clientWidth + 1),
    panelMaxHeight: getComputedStyle(document.querySelector('.job-strip')).maxHeight,
  };
});

// The details panel on a phone must scroll inside the strip, not swallow the
// workspace below it.
await page.getByRole('button', { name: /transcription details/i }).click();
await page.waitForTimeout(400);
await shot('04b-strip-phone-details');
const phonePanel = await page.evaluate(() => {
  const panel = document.querySelector('.job-strip-panel');
  return {
    panelHeight: Math.round(panel?.getBoundingClientRect().height ?? 0),
    panelScrolls: Boolean(panel && panel.scrollHeight > panel.clientHeight),
    panelMaxHeight: panel ? getComputedStyle(panel).maxHeight : 'none',
    viewportHeight: window.innerHeight,
  };
});
await page.getByRole('button', { name: 'Continue in the background' }).click();
await page.waitForTimeout(200);

// 320 CSS px is the WCAG 1.4.10 reflow floor: nothing may overflow or collapse.
await page.setViewportSize({ width: 320, height: 700 });
await page.waitForTimeout(300);
await shot('04c-strip-phone-narrow');
const narrowPhone = await page.evaluate(() => {
  const text = document.querySelector('.job-strip-text');
  return {
    horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    textWidth: Math.round(text?.getBoundingClientRect().width ?? 0),
    buttons: Array.from(document.querySelectorAll('.job-strip-row .btn')).map((button) =>
      Math.round(button.getBoundingClientRect().height),
    ),
  };
});

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
  repair: { ...repairBase, ...repairTune, phone: repairPhone },
  strip: {
    collapsed: { ...stripGeometry },
    expanded: { ...detailsGeometry },
    phone: { ...phoneOverflow, safeAreaTop, panel: phonePanel, narrow: narrowPhone },
  },
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
