// Renders the static social card and the iOS touch icon for the download page.
//
//   node tools/make-site-assets.mjs
//
// The card is plain HTML/CSS drawn in Chromium, so it stays in sync with the
// page typography instead of being a hand-exported bitmap.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const pageDir = path.resolve(appRoot, '..', 'Coso audio page');
// Inline the icon: about:blank pages cannot load file:// images.
const icon = `data:image/png;base64,${fs
  .readFileSync(path.join(pageDir, 'assets', 'icon-512.png'))
  .toString('base64')}`;

const CARD = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=Literata:opsz,wght@7..72,500&display=swap" rel="stylesheet" />
    <style>
      * { box-sizing: border-box; margin: 0; }
      html, body { width: 1200px; height: 630px; }
      body {
        position: relative;
        display: grid;
        grid-template-columns: 1.35fr 0.65fr;
        gap: 40px;
        align-items: center;
        padding: 64px 72px;
        background: #12161a;
        color: #edf0eb;
        font-family: 'IBM Plex Sans', system-ui, sans-serif;
        overflow: hidden;
      }
      .glow {
        position: absolute;
        width: 900px; height: 900px;
        right: -280px; top: -320px;
        background: radial-gradient(circle, rgba(217,80,43,0.28) 0%, rgba(217,80,43,0) 62%);
      }
      .grid {
        position: absolute; inset: 0;
        background-image: linear-gradient(rgba(237,240,235,0.05) 1px, transparent 1px),
                          linear-gradient(90deg, rgba(237,240,235,0.05) 1px, transparent 1px);
        background-size: 48px 48px;
        mask-image: radial-gradient(circle at 70% 20%, #000 0%, transparent 72%);
      }
      .brand { display: flex; align-items: center; gap: 14px; font-weight: 700; font-size: 26px; letter-spacing: 0.02em; }
      .wave { display: inline-flex; align-items: flex-end; gap: 5px; height: 30px; }
      .wave i { width: 6px; border-radius: 4px; background: #d9502b; }
      .wave i:nth-child(1) { height: 12px; }
      .wave i:nth-child(2) { height: 24px; }
      .wave i:nth-child(3) { height: 30px; }
      .wave i:nth-child(4) { height: 18px; }
      .wave i:nth-child(5) { height: 9px; }
      h1 {
        margin-top: 34px;
        font-family: 'Literata', Georgia, serif;
        font-weight: 500;
        font-size: 62px;
        line-height: 1.08;
        letter-spacing: -0.02em;
        text-wrap: balance;
      }
      h1 em { color: #d9502b; font-style: normal; }
      p.lead {
        margin-top: 22px;
        max-width: 620px;
        font-size: 22px;
        line-height: 1.45;
        color: #c2cac6;
        text-wrap: pretty;
      }
      .chips { display: flex; gap: 10px; margin-top: 30px; flex-wrap: wrap; }
      .chip {
        padding: 9px 16px;
        border: 1px solid rgba(237,240,235,0.16);
        border-radius: 999px;
        font-size: 16px;
        font-weight: 500;
        color: #edf0eb;
      }
      .chip.accent { background: rgba(217,80,43,0.16); border-color: rgba(217,80,43,0.45); color: #ffb59f; }
      .art { position: relative; display: grid; place-items: center; }
      .art img { width: 320px; height: 320px; border-radius: 26%; box-shadow: 0 40px 90px rgba(0,0,0,0.55); }
    </style>
  </head>
  <body>
    <div class="glow"></div>
    <div class="grid"></div>
    <div class="copy">
      <div class="brand"><span class="wave"><i></i><i></i><i></i><i></i><i></i></span> Coso</div>
      <h1>Record the lecture.<br /><em>Keep the transcript.</em></h1>
      <p class="lead">On-device transcription with Whisper. Speakers separated, transcript editable, exports in one click.</p>
      <div class="chips">
        <span class="chip">Windows</span>
        <span class="chip">Android</span>
        <span class="chip">Web</span>
        <span class="chip accent">Free &amp; open source</span>
      </div>
    </div>
    <div class="art"><img src="${icon}" alt="" /></div>
  </body>
</html>`;

const TOUCH = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      * { margin: 0; }
      html, body { width: 180px; height: 180px; }
      body {
        display: grid;
        place-items: center;
        background: radial-gradient(circle at 30% 25%, #232a2e 0%, #12161a 70%);
      }
      img { width: 128px; height: 128px; border-radius: 26%; }
    </style>
  </head>
  <body><img src="${icon}" alt="" /></body>
</html>`;

const browser = await chromium.launch();

async function render(html, width, height, file) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(pageDir, file), clip: { x: 0, y: 0, width, height } });
  await page.close();
  console.log(`wrote ${file} (${width}x${height})`);
}

await render(CARD, 1200, 630, 'assets/og.png');
await render(TOUCH, 180, 180, 'assets/apple-touch-icon.png');
await browser.close();
