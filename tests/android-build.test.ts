import { describe, expect, it } from 'vitest';
import {
  apkOutputPath,
  buildEnv,
  classifyTauriFailure,
  gradleExclusions,
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

describe('apkOutputPath', () => {
  it('returns null when the profile has not been built yet', () => {
    expect(apkOutputPath('release')).toBeNull();
  });

  it('points at the newest debug APK that exists', () => {
    const apk = apkOutputPath('debug');
    expect(apk).toBeTruthy();
    expect(apk).toContain('universal');
    expect(apk).toMatch(/\.apk$/);
  });
});
