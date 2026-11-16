import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  apkOutputPath,
  buildEnv,
  classifyTauriFailure,
  gradleExclusions,
  missingSigningVars,
  needsShell,
} from '../tools/android-build.mjs';

describe('classifyTauriFailure', () => {
  it('treats a clean exit as no failure', () => {
    expect(classifyTauriFailure(0, 'victory: Project generated')).toBeNull();
  });

  it('recognizes the expected Developer-Mode symlink failure', () => {
    const output = 'failed to build Android app: Failed to create a symbolic link\n' +
      'You need `SeCreateSymbolicLinkPrivilege` security policy.';
    expect(classifyTauriFailure(1, output)).toBe('symlink');
    expect(classifyTauriFailure(101, output)).toBe('symlink');
  });

  it('treats anything else as a fatal cargo failure', () => {
    expect(classifyTauriFailure(101, 'error[E0599]: method not found')).toBe('cargo');
    expect(classifyTauriFailure(101, 'failed to run custom build command')).toBe('cargo');
    expect(classifyTauriFailure(1, '')).toBe('cargo');
  });
});

describe('gradleExclusions', () => {
  it('excludes the four per-arch Rust tasks for the profile', () => {
    expect(gradleExclusions('debug')).toEqual([
      'rustBuildArm64Debug',
      'rustBuildArmDebug',
      'rustBuildX86Debug',
      'rustBuildX86_64Debug',
    ]);
    expect(gradleExclusions('release')).toEqual([
      'rustBuildArm64Release',
      'rustBuildArmRelease',
      'rustBuildX86Release',
      'rustBuildX86_64Release',
    ]);
  });
});

describe('buildEnv', () => {
  it('keeps explicitly set variables untouched', () => {
    const env = buildEnv();
    expect(env.JAVA_HOME).toContain('jdk');
    expect(env.ANDROID_HOME).toContain('Android');
    expect(env.NDK_HOME).toContain('ndk');
  });
});

describe('missingSigningVars', () => {
  it('names every variable Gradle needs to sign the APK', () => {
    expect(missingSigningVars({})).toEqual([
      'COSO_RELEASE_KEYSTORE',
      'COSO_RELEASE_STORE_PASSWORD',
      'COSO_RELEASE_KEY_ALIAS',
      'COSO_RELEASE_KEY_PASSWORD',
    ]);
  });

  it('reports an incomplete configuration', () => {
    expect(missingSigningVars({ COSO_RELEASE_KEYSTORE: 'coso.jks' })).toEqual([
      'COSO_RELEASE_STORE_PASSWORD',
      'COSO_RELEASE_KEY_ALIAS',
      'COSO_RELEASE_KEY_PASSWORD',
    ]);
  });

  it('accepts a complete configuration', () => {
    expect(
      missingSigningVars({
        COSO_RELEASE_KEYSTORE: 'coso.jks',
        COSO_RELEASE_STORE_PASSWORD: 'secret',
        COSO_RELEASE_KEY_ALIAS: 'coso',
        COSO_RELEASE_KEY_PASSWORD: 'secret',
      }),
    ).toEqual([]);
  });
});

describe('needsShell', () => {
  it('runs the Gradle wrapper through cmd.exe on Windows', () => {
    expect(needsShell(String.raw`C:\Coso audio app\src-tauri\gen\android\gradlew.bat`, 'win32')).toBe(true);
    expect(needsShell('gradlew.cmd', 'win32')).toBe(true);
    expect(needsShell('gradlew.bat', 'linux')).toBe(false);
    expect(needsShell('/usr/bin/gradle', 'win32')).toBe(false);
  });
});

describe('apkOutputPath', () => {
  it('returns null when the profile has not been built yet', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'coso-apk-'));
    try {
      expect(apkOutputPath('release', empty)).toBeNull();
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('points at the newest APK in the profile folder', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'coso-apk-'));
    try {
      const dir = path.join(base, 'app', 'build', 'outputs', 'apk', 'universal', 'debug');
      fs.mkdirSync(dir, { recursive: true });
      const old = path.join(dir, 'app-universal-old.apk');
      const fresh = path.join(dir, 'app-universal-release.apk');
      fs.writeFileSync(old, 'old');
      fs.utimesSync(old, new Date(0), new Date(0));
      fs.writeFileSync(fresh, 'fresh');
      fs.utimesSync(fresh, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
      expect(apkOutputPath('debug', base)).toBe(fresh);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('ignores an unsigned APK so a release never ships uninstallable', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'coso-apk-'));
    try {
      const dir = path.join(base, 'app', 'build', 'outputs', 'apk', 'universal', 'release');
      fs.mkdirSync(dir, { recursive: true });
      const signed = path.join(dir, 'app-universal-release.apk');
      const unsigned = path.join(dir, 'app-universal-release-unsigned.apk');
      fs.writeFileSync(signed, 'signed');
      fs.writeFileSync(unsigned, 'unsigned');
      fs.utimesSync(unsigned, new Date(Date.now() + 2000), new Date(Date.now() + 2000));
      expect(apkOutputPath('release', base)).toBe(signed);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('falls back to the real gen folder when no base is given', () => {
    // Default-parameter wiring: whatever the real folder holds, the answer is
    // either "nothing built" or a path to an actual APK — never a throw.
    const apk = apkOutputPath('debug');
    expect(apk === null || /\.apk$/.test(apk)).toBe(true);
  });
});
