export declare function classifyTauriFailure(
  code: number | null,
  output: string,
): 'symlink' | 'cargo' | null;
export declare function gradleExclusions(profile: string): string[];
export declare function apkOutputPath(profile: string): string | null;
export declare function buildEnv(): NodeJS.ProcessEnv;
