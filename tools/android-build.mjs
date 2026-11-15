// Builds the Android APK without a live `tauri android build` process.
//
// Two Windows quirks force this dance (see README "Windows build notes"):
// 1. Tauri links the compiled Rust library into jniLibs with a symlink, which
//    needs Windows Developer Mode. Without it the CLI dies AFTER compiling —
//    so we let it fail, copy the library manually and drive Gradle directly.
// 2. Gradle's Rust task can only run under a live CLI (options server), so the
//    direct Gradle run must exclude it — the library is already built.
//
// Usage: node tools/android-build.mjs [debug|release]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRelease } from './check-apk.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const GEN = path.join(ROOT, 'src-tauri', 'gen', 'android');

/** Classify why the Tauri CLI failed: 'symlink' (expected), 'cargo' (fatal), or null (no failure). */
export function classifyTauriFailure(code, output) {
  if (code === 0) return null;
  if (/SeCreateSymbolicLinkPrivilege|symbolic link/i.test(output)) return 'symlink';
  return 'cargo';
}

/** Gradle per-arch Rust tasks to exclude, for the given profile. */
export function gradleExclusions(profile) {
  const cap = profile === 'release' ? 'Release' : 'Debug';
  return ['Arm64', 'Arm', 'X86', 'X86_64'].map((arch) => `rustBuild${arch}${cap}`);
}

/** Variables Gradle reads to sign a release build (see build.gradle.kts). */
export const SIGNING_VARS = [
  'COSO_RELEASE_KEYSTORE',
  'COSO_RELEASE_STORE_PASSWORD',
  'COSO_RELEASE_KEY_ALIAS',
  'COSO_RELEASE_KEY_PASSWORD',
];

/** Signing variables that are absent. Empty means Gradle will sign the APK. */
export function missingSigningVars(env = process.env) {
  return SIGNING_VARS.filter((name) => !env[name]);
}

/** Windows needs a shell to run the Gradle wrapper, which is a .bat file. */
export function needsShell(command, platform = process.platform) {
  return platform === 'win32' && /\.(bat|cmd)$/i.test(command);
}

/** Where Gradle puts the universal APK for the profile. */
export function apkOutputPath(profile, baseDir = GEN) {
  const dir = path.join(baseDir, 'app', 'build', 'outputs', 'apk', 'universal', profile);
  if (!fs.existsSync(dir)) return null;
  const apk = fs
    .readdirSync(dir)
    // An unsigned APK is a failed release, never the deliverable.
    .filter((f) => f.endsWith('.apk') && !f.endsWith('-unsigned.apk'))
    .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0];
  return apk ? path.join(dir, apk.f) : null;
}

/** Build toolchain env, falling back to this project's known install locations. */
export function buildEnv() {
  const env = { ...process.env };
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
  env.JAVA_HOME ??= path.join(local, 'jdk21', 'jdk-21.0.13.0.2+1');
  env.ANDROID_HOME ??= path.join(local, 'Android', 'Sdk');
  env.NDK_HOME ??= path.join(env.ANDROID_HOME, 'ndk', '27.0.12077973');
  return env;
}

function run(label, command, args, env, cwd = ROOT) {
  console.log(`\n> ${label}`);
  // Windows cannot CreateProcess a .bat/.cmd file: Gradle needs cmd.exe.
  const result = needsShell(command)
    ? spawnSync(`"${command}" ${args.join(' ')}`, {
        stdio: 'inherit',
        cwd,
        env,
        shell: true,
      })
    : spawnSync(command, args, { stdio: 'inherit', cwd, env });
  return result.status ?? 1;
}

async function main() {
  const profile = process.argv[2] === 'release' ? 'release' : 'debug';
  const env = buildEnv();
  const cap = profile === 'release' ? 'Release' : 'Debug';

  // Without these Gradle silently emits app-universal-release-unsigned.apk,
  // which Android refuses to install.
  if (profile === 'release') {
    const missing = missingSigningVars(env);
    if (missing.length > 0) {
      throw new Error(
        `Release signing is not configured: set ${missing.join(', ')} (otherwise Gradle produces an unsigned APK).`,
      );
    }
  }

  // 1. Compile the Rust core. The CLI also tries to symlink it into jniLibs,
  //    which fails without Developer Mode — that specific failure is expected.
  const cliArgs = ['tauri', 'android', 'build', '--apk', '--target', 'aarch64'];
  if (profile === 'debug') cliArgs.push('--debug');
  const cli = spawnSync('npx', cliArgs, {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    shell: true,
  });
  const failure = classifyTauriFailure(cli.status, String(cli.stdout) + String(cli.stderr));
  if (failure === 'cargo') {
    process.stderr.write(String(cli.stderr));
    throw new Error('Rust compilation for Android failed.');
  }
  if (failure === 'symlink') {
    console.log('(skipped the expected symlink failure — copying the library manually)');
  }

  // 2. Copy the compiled library where Gradle packages it from.
  const so = path.join(ROOT, 'src-tauri', 'target', 'aarch64-linux-android', profile, 'libcoso_lib.so');
  const jni = path.join(GEN, 'app', 'src', 'main', 'jniLibs', 'arm64-v8a', 'libcoso_lib.so');
  if (!fs.existsSync(so)) throw new Error(`Compiled library missing: ${so}`);
  fs.mkdirSync(path.dirname(jni), { recursive: true });
  fs.copyFileSync(so, jni);
  console.log(`\n> copied ${so} → ${jni}`);

  // 3. Package the APK with the Rust tasks excluded (they need a live CLI).
  const gradle = path.join(GEN, 'gradlew.bat');
  if (!fs.existsSync(gradle)) throw new Error(`Gradle wrapper missing: ${gradle}`);
  const gradleArgs = [`assembleUniversal${cap}`];
  for (const task of gradleExclusions(profile)) gradleArgs.push('-x', task);
  const status = run(`gradlew assembleUniversal${cap}`, gradle, gradleArgs, env, GEN);
  if (status !== 0) throw new Error(`Gradle build failed (exit ${status}).`);

  const apk = apkOutputPath(profile);
  if (!apk) throw new Error('Gradle succeeded but no APK was found in its output folder.');

  // Never hand out an APK that would open localhost:3000 on a phone.
  if (profile === 'release') {
    const guard = checkRelease({ lib: so, apk, dist: path.join(ROOT, 'dist') });
    for (const note of guard.notes) console.log(note);
    if (!guard.ok) {
      for (const problem of guard.problems) console.error(`FAIL ${problem}`);
      throw new Error('The APK would not serve the bundled interface (see tools/check-apk.mjs).');
    }
    console.log('✔ the APK serves the bundled, correctly rooted interface');
  }

  console.log(`\n✔ ${profile} APK ready: ${apk}`);
}

// Only run main when executed directly, so tests can import the helpers.
const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (import.meta.url === invoked) {
  main().catch((error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  });
}
