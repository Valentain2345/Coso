// Guards the Android release against the two ways it can ship broken.
//
// 1. A library compiled without the `tauri/custom-protocol` feature embeds
//    http://localhost:3000 instead of the interface: the phone shows
//    "localhost/3000 unreachable".
// 2. A `dist/` built for the web sub-path (`COSO_BASE=/Coso/app/`) makes the
//    interface request /Coso/app/assets/..., which the APK does not serve.
//
// Checking URLs is not enough: `devUrl` lives in tauri.conf.json and reaches
// every binary, so the string is present even in correct builds. What only
// production builds contain is the asset map. Rust keeps its keys as plain
// strings, so the library must contain `/index.html` and the hashed entry files
// that `dist/index.html` references.
//
//   node tools/check-apk.mjs [lib.so] [apk] [dist]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appRoot = fileURLToPath(new URL('..', import.meta.url));

/** Where Gradle packs the arm64 library inside the APK. */
export const LIB_ENTRY = 'lib/arm64-v8a/libcoso_lib.so';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

function endOfCentralDirectory(bytes) {
  const oldest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let offset = bytes.length - 22; offset >= oldest; offset -= 1) {
    if (bytes.readUInt32LE(offset) === EOCD_SIGNATURE) return offset;
  }
  return -1;
}

/**
 * Reads one entry out of a ZIP file (stored or deflated) without a dependency.
 * Returns null when the archive does not contain it.
 */
export function readZipEntry(archive, entryName) {
  const bytes = Buffer.isBuffer(archive) ? archive : fs.readFileSync(archive);
  const eocd = endOfCentralDirectory(bytes);
  if (eocd < 0) throw new Error('not a ZIP archive: no end-of-central-directory record');

  const count = bytes.readUInt16LE(eocd + 10);
  let offset = bytes.readUInt32LE(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(offset) !== CENTRAL_SIGNATURE) {
      throw new Error(`corrupt central directory at byte ${offset}`);
    }
    const method = bytes.readUInt16LE(offset + 10);
    const compressedSize = bytes.readUInt32LE(offset + 20);
    const uncompressedSize = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const localOffset = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (name === entryName) {
      const localNameLength = bytes.readUInt16LE(localOffset + 26);
      const localExtraLength = bytes.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const raw = bytes.subarray(start, start + compressedSize);
      let data;
      if (method === 0) data = Buffer.from(raw);
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else throw new Error(`${entryName} uses unsupported compression method ${method}`);
      if (data.length !== uncompressedSize) {
        throw new Error(`${entryName} is truncated (${data.length} of ${uncompressedSize} bytes)`);
      }
      return data;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

/** Script and stylesheet file names referenced by a built index.html, plus their roots. */
export function entryAssets(indexHtml) {
  const names = new Set();
  const roots = new Set();
  for (const match of indexHtml.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = match[1];
    const marker = url.lastIndexOf('assets/');
    if (marker < 0) continue;
    names.add(url.slice(url.lastIndexOf('/') + 1));
    roots.add(url.slice(0, marker));
  }
  return { names: [...names], roots: [...roots] };
}

/** Cross-checks the library, the APK and the frontend build. Pure: returns the findings. */
export function checkRelease({ lib, apk, dist }) {
  const problems = [];
  const notes = [];

  let assets = { names: [], roots: [] };
  const indexPath = path.join(dist, 'index.html');
  if (!fs.existsSync(indexPath)) {
    problems.push(`missing ${indexPath} - run npm run build first`);
  } else {
    assets = entryAssets(fs.readFileSync(indexPath, 'utf8'));
    if (assets.names.length === 0) {
      problems.push(`${indexPath} references no bundled script or stylesheet`);
    }
    const subPath = assets.roots.filter((root) => root !== '' && root !== '/');
    if (subPath.length > 0) {
      problems.push(
        `dist was built for a sub-path (${subPath.join(', ')}): run npm run build so the APK serves assets from the root`,
      );
    }
  }

  let libBytes = null;
  if (!fs.existsSync(lib)) {
    problems.push(`missing ${lib} - compile the Android library first`);
  } else {
    libBytes = fs.readFileSync(lib);
    // latin1 maps bytes 1:1, so this substring search is a byte search.
    const text = libBytes.toString('latin1');
    if (!text.includes('/index.html')) {
      problems.push(
        'the library embeds no frontend: rebuild it with --features tauri/custom-protocol',
      );
    }
    for (const name of assets.names) {
      if (!text.includes(name)) {
        problems.push(`the library does not embed this frontend build: ${name} is missing`);
      }
    }
    notes.push(`library: ${lib} (${libBytes.length} bytes)`);
  }

  if (!fs.existsSync(apk)) {
    problems.push(`missing ${apk} - run gradlew assembleUniversalRelease first`);
  } else {
    const apkBytes = fs.readFileSync(apk);
    notes.push(`apk: ${apk} (${apkBytes.length} bytes)`);
    if (!apkBytes.includes(Buffer.from('AndroidManifest.xml'))) {
      problems.push(`${path.basename(apk)} has no AndroidManifest.xml`);
    }
    let packaged = null;
    try {
      packaged = readZipEntry(apkBytes, LIB_ENTRY);
    } catch (error) {
      problems.push(`could not read ${LIB_ENTRY}: ${error.message}`);
    }
    if (!packaged) {
      problems.push(`${path.basename(apk)} does not contain ${LIB_ENTRY}`);
    } else if (libBytes) {
      if (packaged.length !== libBytes.length) {
        problems.push(
          `${LIB_ENTRY} is stale (${packaged.length} bytes, built ${libBytes.length}): rebuild the APK`,
        );
      }
      const text = packaged.toString('latin1');
      if (assets.names.some((name) => !text.includes(name))) {
        problems.push(`${LIB_ENTRY} inside the APK does not embed the current frontend`);
      }
    }
  }

  return { ok: problems.length === 0, problems, notes };
}

function main() {
  const lib = path.resolve(
    process.argv[2] ?? path.join(appRoot, 'src-tauri', 'target', 'aarch64-linux-android', 'release', 'libcoso_lib.so'),
  );
  const apk = path.resolve(
    process.argv[3] ??
      path.join(
        appRoot,
        'src-tauri',
        'gen',
        'android',
        'app',
        'build',
        'outputs',
        'apk',
        'universal',
        'release',
        'app-universal-release.apk',
      ),
  );
  const dist = path.resolve(process.argv[4] ?? path.join(appRoot, 'dist'));

  const { ok, problems, notes } = checkRelease({ lib, apk, dist });
  for (const note of notes) console.log(note);
  if (!ok) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('OK: the APK serves the bundled, correctly rooted interface');
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invoked) main();
