import { execSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';

/**
 * Android (Tauri) E2E driver.
 *
 * Boots an Android emulator (or uses a connected device), installs the debug
 * APK, forwards the WebView debugging socket over ADB, and attaches Playwright
 * to the app's WebView over CDP. Everything is skipped gracefully when no
 * emulator/device and no APK exist, so CI and fresh clones still run web tests.
 */

const SDK = process.env.ANDROID_HOME ?? path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
const ADB = path.join(SDK, 'platform-tools', 'adb.exe');
const APP_ID = 'app.coso.audio.debug';
const LOCAL_PORT = 9224;

/** Newest debug APK produced by `tauri android build`. */
export function findDebugApk(): string | null {
  const outputs = path.resolve('src-tauri/gen/android/app/build/outputs/apk');
  if (!fs.existsSync(outputs)) return null;
  const candidates = fs
    .readdirSync(outputs, { recursive: true, encoding: 'utf8' })
    .filter((file) => /debug.*\.apk$/i.test(file) && !/unaligned/.test(file))
    .map((file) => path.join(outputs, file));
  if (candidates.length === 0) return null;
  return candidates
    .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].file;
}

let emulator: ChildProcess | null = null;
let browser: Browser | null = null;

function adb(args: string, timeoutMs = 30_000): string {
  return execSync(`"${ADB}" ${args}`, { timeout: timeoutMs, encoding: 'utf8' });
}

export function androidAvailable(): boolean {
  try {
    adb('devices');
  } catch {
    return false;
  }
  const devices = adb('devices');
  if (devices.split('\n').some((line) => /\temulator|\tdevice/.test(line))) return true;
  // No device attached: an AVD we can boot is still enough.
  try {
    const emu = path.join(SDK, 'emulator', 'emulator.exe');
    return execSync(`"${emu}" -list-avds`, { timeout: 10_000, encoding: 'utf8' }).split('\n').some((l) => l.trim());
  } catch {
    return false;
  }
}

/** Boots (or reuses) an AVD and waits for it to finish booting. */
async function ensureDevice(): Promise<void> {
  const devices = adb('devices');
  if (devices.split('\n').some((line) => line.includes('\temulator') || line.includes('\tdevice'))) return;

  const avdName = adb('list avds').split('\n').map((line) => line.trim()).filter(Boolean)[0];
  if (!avdName) throw new Error('No Android emulator AVD found. Create one with the AVD manager.');
  emulator = spawn(path.join(SDK, 'emulator', 'emulator.exe'), ['-avd', avdName, '-no-window', '-no-audio', '-gpu', 'swiftshader_indirect'], {
    stdio: 'ignore',
  });
  const deadline = Date.now() + 180_000;
  for (;;) {
    const state = adb('shell getprop sys.boot_completed', 10_000).trim();
    if (state === '1') return;
    if (Date.now() > deadline) throw new Error('Emulator did not finish booting');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/**
 * Connects to the app's WebView. Assumes the debug APK is installed and the
 * app is running (WebView inspection requires it to be foreground).
 */
export async function launchAndroid(): Promise<Page> {
  await ensureDevice();
  if (!adb('devices').includes('emulator') && !adb('devices').includes('\tdevice')) {
    throw new Error('No Android device available');
  }
  if (process.env.COSO_INSTALL_APK === '1') {
    const apk = findDebugApk();
    if (!apk) throw new Error('No debug APK found — run "npx tauri android build --apk" first.');
    adb(`install -r "${apk}"`, 120_000);
  }
  // Bring the app to the foreground so its WebView registers for inspection.
  // Grant the mic permission so the recording flow is deterministic in tests.
  adb(`shell pm grant ${APP_ID} android.permission.RECORD_AUDIO`, 30_000);
  adb(`shell am start -n ${APP_ID}/app.coso.audio.MainActivity`, 30_000);
  // Wait until the app's WebView debug socket appears (its name contains the pid).
  const deadline = Date.now() + 30_000;
  let socketName = '';
  for (;;) {
    const match = adb('shell cat /proc/net/unix', 10_000)
      .split('\n')
      .map((line) => line.trim().split(/\s+/).pop() ?? '')
      .find((name) => name.startsWith('webview_devtools_remote_'));
    if (match) {
      socketName = match;
      break;
    }
    if (Date.now() > deadline) throw new Error("The app's WebView did not expose a debugging socket");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  execSync(`"${ADB}" forward tcp:${LOCAL_PORT} localabstract:${socketName}`, {
    timeout: 30_000,
    encoding: 'utf8',
  });

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${LOCAL_PORT}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0] ?? (await context.newPage());
  return page;
}

export async function closeAndroid(): Promise<void> {
  try {
    await browser?.close();
  } catch {
    /* already gone */
  }
  browser = null;
  if (emulator) {
    try {
      adb('emu kill');
    } catch {
      /* emulator already gone */
    }
    emulator.kill();
    emulator = null;
  }
}
