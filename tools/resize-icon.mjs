#!/usr/bin/env node
/**
 * One-off helper: upscale the 512px app icon to the 1024px PNG that
 * `capacitor-assets` requires for Android adaptive icons, using plain nearest
 * neighbour so no native image toolchain is needed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = PNG.sync.read(fs.readFileSync(path.join(root, 'public', 'icon-512.png')));
const target = new PNG({ width: 1024, height: 1024 });

for (let y = 0; y < 1024; y += 1) {
  for (let x = 0; x < 1024; x += 1) {
    const sx = Math.min(511, Math.floor((x * 512) / 1024));
    const sy = Math.min(511, Math.floor((y * 512) / 1024));
    const from = (sy * 512 + sx) * 4;
    const to = (y * 1024 + x) * 4;
    for (let channel = 0; channel < 4; channel += 1) {
      target.data[to + channel] = source.data[from + channel];
    }
  }
}

fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
fs.writeFileSync(path.join(root, 'assets', 'icon.png'), PNG.sync.write(target));
console.log('assets/icon.png written (1024x1024)');
