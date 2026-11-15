import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../tools/check-apk.mjs', import.meta.url));

/**
 * Minimal ZIP writer for the fixtures. The guard only reads entry names and
 * payloads, so the checksums stay zero.
 */
function zip(entries: Array<{ name: string; data: Buffer; deflate?: boolean }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const payload = entry.deflate ? zlib.deflateRawSync(entry.data) : entry.data;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(entry.deflate ? 8 : 0, 10);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    locals.push(local, name, payload);
    centrals.push(central, name);
    offset += local.length + name.length + payload.length;
  }

  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, eocd]);
}

interface Fixture {
  lib: string;
  apk: string;
  dist: string;
}

function fixture(options: { lib: string; apkLib?: string | null; root?: string }): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coso-apk-'));
  const dist = path.join(dir, 'dist');
  const root = options.root ?? '/';
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, 'index.html'),
    `<script type="module" crossorigin src="${root}assets/index-AAAA1111.js"></script>` +
      `<link rel="stylesheet" crossorigin href="${root}assets/index-BBBB2222.css">`,
  );

  const lib = path.join(dir, 'libcoso_lib.so');
  fs.writeFileSync(lib, options.lib, 'latin1');

  const apk = path.join(dir, 'app-universal-release.apk');
  const packaged = options.apkLib === undefined ? options.lib : options.apkLib;
  const entries: Array<{ name: string; data: Buffer; deflate?: boolean }> = [
    { name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') },
  ];
  if (packaged !== null) {
    entries.push({
      name: 'lib/arm64-v8a/libcoso_lib.so',
      data: Buffer.from(packaged, 'latin1'),
      deflate: true,
    });
  }
  fs.writeFileSync(apk, zip(entries));
  return { lib, apk, dist };
}

function run(target: Fixture): { status: number; output: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [script, target.lib, target.apk, target.dist],
      { encoding: 'utf8' },
    );
    return { status: 0, output: stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
}

// What a production library contains: the asset map keys Rust keeps as strings.
const PROD = '/index.html\u0000/assets/index-AAAA1111.js\u0000index-AAAA1111.js\u0000index-BBBB2222.css';
const DEV = 'tauri.localhost\u0000http://localhost:3000\u0000/plugin/notification';

describe('check-apk', () => {
  it('accepts a production library packaged in the APK', () => {
    const result = run(fixture({ lib: PROD }));
    expect(result.status).toBe(0);
    expect(result.output).toContain('correctly rooted interface');
  });

  it('rejects a dev-mode library without embedded assets', () => {
    const result = run(fixture({ lib: DEV }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('custom-protocol');
  });

  it('rejects a frontend built for the web sub-path', () => {
    const result = run(fixture({ lib: PROD, root: '/Coso/app/' }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('sub-path');
  });

  it('rejects an APK without the arm64 library', () => {
    const result = run(fixture({ lib: PROD, apkLib: null }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('lib/arm64-v8a/libcoso_lib.so');
  });

  it('rejects an APK that packages an older library', () => {
    const result = run(fixture({ lib: PROD, apkLib: DEV }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('stale');
  });

  it('rejects a library that embeds a different frontend build', () => {
    const stale = PROD.replace(/AAAA1111/g, 'ZZZZ9999');
    const result = run(fixture({ lib: stale }));
    expect(result.status).toBe(1);
    expect(result.output).toContain('index-AAAA1111.js');
  });
});
