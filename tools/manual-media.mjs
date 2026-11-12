#!/usr/bin/env node
/**
 * Generates the beginner-manual media in `public/manual/`.
 *
 * Screenshots and GIFs are captured from the real running app (vite preview of
 * a production build), seeded with realistic sessions in IndexedDB so the
 * pictures show what a returning user sees. One real transcription of the
 * bundled speech fixture produces the progress and transcript images; the
 * Whisper model is cached in a persistent Playwright profile so later runs are
 * fast and offline.
 *
 * Usage: node tools/manual-media.mjs [--skip-build] [--only name,name2]
 */

import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'manual');
const PROFILE = path.join(ROOT, '.manual-profile');
const PORT = 4174;
const BASE = `http://localhost:${PORT}`;

const args = process.argv.slice(2);
const skipBuild = args.includes('--skip-build');
const onlyIndex = (() => {
  const flag = args.find((a) => a.startsWith('--only'));
  return flag ? flag.split('=')[1]?.split(',').filter(Boolean) ?? null : null;
})();

fs.mkdirSync(OUT, { recursive: true });

/* ------------------------------------------------------------------ helpers */

function should(name) {
  return !onlyIndex || onlyIndex.includes(name);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(url, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error(`Server at ${url} did not start`);
}

/** Seed the app database inside the page. `sessions` carry base64 WAV audio that becomes a Blob. */
async function seedSessions(page, sessions) {
  await page.evaluate((list) => {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('coso-audio', 2);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('jobAudio')) db.createObjectStore('jobAudio', { keyPath: 'id' });
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        for (const raw of list) {
          const session = { ...raw };
          if (raw.__wavB64) {
            const bytes = Uint8Array.from(atob(raw.__wavB64), (c) => c.charCodeAt(0));
            session.audioBlob = new Blob([bytes], { type: 'audio/wav' });
            delete session.__wavB64;
          } else {
            session.audioBlob = null;
          }
          store.put(session);
        }
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, sessions);
}

/** A short spoken-ish WAV (word-like bursts), synthesized so no fixture upload is needed. */
function synthWavB64(seconds = 8) {
  const rate = 16000;
  const total = Math.floor(rate * seconds);
  const pcm = Buffer.alloc(total * 2);
  // Envelope of "speech": bursts of 0.5 s with 0.3 s pauses.
  for (let i = 0; i < total; i += 1) {
    const t = i / rate;
    const burst = Math.floor(t / 0.8) % 2 === 0;
    const f0 = 130 + 40 * Math.sin(t * 1.3);
    let sample = 0;
    if (burst) {
      const phase = t * 1000;
      sample =
        0.35 * Math.sin(2 * Math.PI * f0 * t) +
        0.18 * Math.sin(2 * Math.PI * (f0 * 2.3) * t + phase) +
        0.05 * Math.sin(2 * Math.PI * 2400 * t);
      sample *= Math.min(1, Math.sin((t % 0.8) * Math.PI / 0.8) * 1.4);
    } else {
      sample = 0.006 * Math.sin(2 * Math.PI * 90 * t);
    }
    const value = Math.max(-1, Math.min(1, sample));
    pcm.writeInt16LE(Math.round(value * 32767 * 0.9), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]).toString('base64');
}

function b64ToUint8(b64) {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

const SEED_NOW = Date.now();
const DAY = 86_400_000;

function seededSession(index, daysAgo, words) {
  const segments = [];
  const lines = [
    ['Good morning everyone, today we are going to talk about the water cycle.', 0, 6.2],
    ['Evaporation moves water from the ocean into the atmosphere.', 6.4, 12.1],
    ['Then condensation forms the clouds we see every day.', 12.3, 17.5],
    ['Professor, does wind change how fast clouds move?', 18.0, 23.4],
    ['Great question. Yes, wind can move clouds thousands of kilometers.', 23.8, 30.2],
    ['Finally, precipitation returns the water to the ground as rain or snow.', 30.6, 37.0],
  ];
  for (let i = 0; i < lines.length; i += 1) {
    const [text, start, end] = lines[i];
    segments.push({
      id: `seed-${index}-${i}`,
      start,
      end,
      text,
      speaker: i === 3 ? 1 : 0,
      confidence: 0.93,
    });
  }
  const wordCount = words ?? 46;
  return {
    id: `seeded-${index}`,
    title: `Biology — The water cycle${index > 0 ? ` (part ${index + 1})` : ''}`,
    createdAt: SEED_NOW - daysAgo * DAY,
    updatedAt: SEED_NOW - daysAgo * DAY,
    duration: 38,
    language: 'en',
    model: 'whisper-base',
    speakerCount: 2,
    wordCount,
    sourceName: null,
    segments,
    audioBlob: null,
    audioMime: 'audio/wav',
    __wavB64: synthWavB64(38),
    peaks: Array.from({ length: 140 }, (_, i) => {
      const phase = Math.sin(i * 0.23) * 0.5 + Math.sin(i * 0.07) * 0.4;
      return Math.max(0.08, Math.abs(phase) * 0.8 + 0.1);
    }),
  };
}

/* --------------------------------------------------------------- GIF capture */

async function captureGif(page, { out, actions, fps = 5, clip }) {
  const encoder = GIFEncoder();
  const frames = [];
  const finished = actions(page);
  // Capture while the actions run: screenshot as fast as the compositor allows.
  const shooting = (async () => {
    for (;;) {
      const buffer = await page.screenshot({ type: 'png', scale: 'css', ...(clip ? { clip } : {}) });
      frames.push(PNG.sync.read(buffer));
      if (shooting.done) break;
    }
  })();
  await finished;
  await sleep(Math.round(1000 / fps));
  shooting.done = true;
  await shooting;

  const delay = Math.round(1000 / fps);
  for (const frame of frames) {
    const { data, width, height } = frame;
    const palette = quantize(data, 255);
    const index = applyPalette(data, palette);
    encoder.writeFrame(index, width, height, { palette, delay });
  }
  encoder.finish();
  fs.writeFileSync(out, encoder.bytes());
  console.log(`  ✓ ${path.basename(out)} (${frames.length} frames)`);
}

/* --------------------------------------------------------------------- main */

async function main() {
  if (!skipBuild) {
    console.log('Building the app…');
    execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });
  }

  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    shell: true,
    stdio: 'ignore',
  });
  try {
    await waitForServer(BASE);

    const context = await chromium.launchPersistentContext(PROFILE, {
      headless: true,
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
      args: [
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });

    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    /* First pass: seeded library, capture panel, settings, drive, sidebar. */
    {
      const page = await context.newPage();
      await page.goto(BASE, { waitUntil: 'domcontentloaded' });
      await seedSessions(page, [seededSession(0, 0), seededSession(1, 1, 39), seededSession(2, 9, 52)]);
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.evaluate(() => localStorage.setItem('coso.uiLang', 'en'));
      await page.reload({ waitUntil: 'networkidle' });
      await sleep(700);

      // Start screen.
      if (should('img-start')) {
        await page.screenshot({ path: path.join(OUT, 'img-start.png'), scale: 'css' });
        console.log('  ✓ img-start.png');
      }

      // Sidebar with the seeded library.
      if (should('img-sidebar')) {
        await page.keyboard.press('Control+k');
        await sleep(400);
        await page.keyboard.press('Escape');
        await sleep(300);
        const sidebar = page.locator('.sidebar');
        const box = await sidebar.boundingBox();
        await page.screenshot({
          path: path.join(OUT, 'img-sidebar.png'),
          scale: 'css',
          clip: { x: 0, y: 0, width: Math.ceil(box?.width ?? 300), height: 800 },
        });
        console.log('  ✓ img-sidebar.png');
      }

      // Phone view: capture panel + open drawer.
      if (should('img-phone')) {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.reload({ waitUntil: 'networkidle' });
        await sleep(600);
        await page.screenshot({ path: path.join(OUT, 'img-phone.png'), scale: 'css' });
        await page.locator('.topbar-menu').click();
        await sleep(500);
        await page.screenshot({ path: path.join(OUT, 'img-phone-drawer.png'), scale: 'css' });
        await page.setViewportSize({ width: 1280, height: 800 });
        await sleep(400);
        console.log('  ✓ img-phone.png + img-phone-drawer.png');
      }

      // Settings screenshots (model / processing / reading).
      if (should('img-settings-model') || should('img-settings-processing') || should('img-settings-reading')) {
        await page.locator('.topbar button[aria-label="Settings"]').click();
        const modal = page.locator('.modal');
        await modal.waitFor({ state: 'visible' });
        await sleep(500);
        const shotModal = async (name) =>
          page.screenshot({ path: path.join(OUT, name), scale: 'css', clip: await modalClip(modal) });
        if (should('img-settings-model')) {
          await shotModal('img-settings-model.png');
          console.log('  ✓ img-settings-model.png');
        }
        await page.locator('.modal-body').evaluate((node) => node.scrollBy(0, 520));
        await sleep(400);
        if (should('img-settings-processing')) {
          await shotModal('img-settings-processing.png');
          console.log('  ✓ img-settings-processing.png');
        }
        await page.locator('.modal-body').evaluate((node) => node.scrollBy(0, 2000));
        await sleep(400);
        if (should('img-settings-reading')) {
          await shotModal('img-settings-reading.png');
          console.log('  ✓ img-settings-reading.png');
        }
        await page.keyboard.press('Escape');
        await sleep(400);
      }

      // Drive dialog.
      if (should('img-drive')) {
        await page.locator('.topbar button[aria-label="Google Drive"]').click();
        await page.locator('.modal').waitFor({ state: 'visible' });
        await sleep(500);
        await page.screenshot({ path: path.join(OUT, 'img-drive.png'), scale: 'css' });
        await page.keyboard.press('Escape');
        await sleep(300);
        console.log('  ✓ img-drive.png');
      }

      /* GIF: language switch in Settings. */
      if (should('gif-language')) {
        await page.locator('.topbar button[aria-label="Settings"]').click();
        await sleep(500);
        await page.locator('.modal-body').evaluate((node) => node.scrollBy(0, 40000));
        await sleep(500);
        await captureGif(page, {
          out: path.join(OUT, 'gif-language.gif'),
          fps: 4,
          actions: async (p) => {
            await p.getByRole('radio', { name: 'Español' }).click();
            await sleep(900);
            await p.locator('.modal-body').evaluate((node) => node.scrollTo({ top: 0 }));
            await sleep(700);
            await p.getByRole('radio', { name: 'English' }).click();
            await sleep(600);
          },
        });
        await page.keyboard.press('Escape');
        await sleep(300);
      }
      await page.close();
    }

    /* Second pass: record → real transcription → transcript, edit, player, export. */
    {
      const page = await context.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.evaluate(() => localStorage.setItem('coso.uiLang', 'en'));
      await page.reload({ waitUntil: 'networkidle' });
      await sleep(800);

      // GIF: start recording, watch the live waveform, stop & transcribe.
      // The real transcription of the speech fixture runs right after; we take
      // the progress screenshot from it and the finished transcript too.
      if (should('gif-record') || should('img-progress') || should('img-transcript')) {
        const record = page.getByRole('button', { name: /Start recording/ });
        await record.waitFor({ state: 'visible' });

        if (should('gif-record')) {
          await captureGif(page, {
            out: path.join(OUT, 'gif-record.gif'),
            fps: 5,
            actions: async (p) => {
              await p.getByRole('button', { name: /Start recording/ }).click();
              await sleep(2600);
              const stop = p.getByRole('button', { name: /Stop & transcribe/ });
              await stop.click();
              await sleep(1200);
            },
          });
        } else {
          await page.getByRole('button', { name: /Start recording/ }).click();
          await sleep(2500);
          await page.getByRole('button', { name: /Stop & transcribe/ }).click();
        }

        // Real transcription with fake-mic audio. If the fake stream produces
        // too little speech, fall back to importing the speech fixture so the
        // progress card is authentic anyway.
        const progressVisible = await page
          .locator('.progress-card')
          .waitFor({ state: 'visible', timeout: 20_000 })
          .then(() => true)
          .catch(() => false);

        if (!progressVisible || should('img-progress') === false) {
          // fallthrough: import fixture below
        }
        if (progressVisible && should('img-progress')) {
          await sleep(2500);
          await page.screenshot({ path: path.join(OUT, 'img-progress.png'), scale: 'css' });
          console.log('  ✓ img-progress.png');
        }

        // Wait for the transcript to appear (model may download on first run).
        // If the fake-mic tone yields "no speech", the failure card shows;
        // dismiss it and import the speech fixture to guarantee real segments.
        const outcome = await Promise.race([
          page.locator('.transcript-card').waitFor({ state: 'visible', timeout: 15 * 60_000 }).then(() => 'transcript'),
          page.locator('.progress-failed').waitFor({ state: 'visible', timeout: 15 * 60_000 }).then(() => 'failed'),
        ]).catch(() => 'timeout');

        if (outcome !== 'transcript') {
          if (outcome === 'failed') {
            await page.getByRole('button', { name: 'Back' }).click().catch(() => undefined);
            await sleep(600);
          }
          await page.locator('.import-button').click();
          await page.setInputFiles('input[type=file]', path.join(ROOT, 'tests', 'fixtures', 'speech.wav'));
          await page.locator('.transcript-card').waitFor({ state: 'visible', timeout: 15 * 60_000 });
        }

        if (should('img-transcript')) {
          await sleep(1200);
          await page.screenshot({ path: path.join(OUT, 'img-transcript.png'), scale: 'css' });
          console.log('  ✓ img-transcript.png');
        }
      }

      // GIF: edit a passage.
      if (should('gif-edit')) {
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await sleep(400);
        await captureGif(page, {
          out: path.join(OUT, 'gif-edit.gif'),
          fps: 5,
          actions: async (p) => {
            const first = p.locator('.segment .segment-text').first();
            await first.click();
            await sleep(500);
            await p.keyboard.press('Control+a');
            await p.keyboard.type('Good morning, everyone. Today we will study the water cycle.');
            await sleep(400);
            await p.keyboard.press('Enter');
            await sleep(600);
            await p.getByRole('button', { name: 'Done', exact: true }).click();
            await sleep(500);
          },
        });
      }

      // Player bar crop.
      if (should('img-player')) {
        const player = page.locator('.player');
        await player.waitFor({ state: 'visible' });
        await sleep(400);
        const box = await player.boundingBox();
        await page.screenshot({
          path: path.join(OUT, 'img-player.png'),
          scale: 'css',
          clip: { x: 0, y: Math.max(0, box.y - 8), width: 1280, height: Math.ceil(box.height + 16) },
        });
        console.log('  ✓ img-player.png');
      }

      // GIF: export menu.
      if (should('gif-export')) {
        await captureGif(page, {
          out: path.join(OUT, 'gif-export.gif'),
          fps: 5,
          actions: async (p) => {
            await p.locator('.export-trigger').click();
            await sleep(700);
            const items = p.locator('.export-item');
            await items.nth(2).hover();
            await sleep(500);
            await items.nth(4).hover();
            await sleep(600);
            await p.keyboard.press('Escape');
            await sleep(400);
          },
        });
      }

      await page.close();
    }

    await context.close();
    console.log(`\nManual media written to ${OUT}`);
  } finally {
    server.kill('SIGTERM');
    server.kill();
  }
}

async function modalClip(modal) {
  const box = await modal.boundingBox();
  if (!box) throw new Error('Modal is not visible');
  const page = modal.page();
  const viewport = page.viewportSize();
  return {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.min(box.width, viewport.width - Math.max(0, box.x)),
    height: Math.min(box.height + 4, viewport.height - Math.max(0, box.y)),
  };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
