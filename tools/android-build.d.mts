export declare function classifyTauriFailure(
  code: number | null,
  output: string,
): 'symlink' | 'cargo' | null;
export declare function gradleExclusions(profile: string): string[];
export declare const SIGNING_VARS: string[];
export declare function missingSigningVars(env?: NodeJS.ProcessEnv): string[];
export declare function needsShell(command: string, platform?: string): boolean;
export declare function apkOutputPath(profile: string, baseDir?: string): string | null;
export declare function buildEnv(): NodeJS.ProcessEnv;
