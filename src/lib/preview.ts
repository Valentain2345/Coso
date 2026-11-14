/**
 * Preview length rules.
 *
 * Five seconds is enough to confirm that a short note is audible, but a long
 * lecture starts with room noise and a greeting: judging the repair preset
 * there needs a longer window. Long sources therefore get a 20 second preview.
 */

export const PREVIEW_SECONDS = 5;
export const LONG_PREVIEW_SECONDS = 20;
/** Sources at least this long are treated as lectures, not notes. */
export const LONG_AUDIO_SECONDS = 120;

export function previewSecondsFor(duration: number | null | undefined): number {
  if (duration === null || duration === undefined) return PREVIEW_SECONDS;
  if (!Number.isFinite(duration) || duration < LONG_AUDIO_SECONDS) return PREVIEW_SECONDS;
  return LONG_PREVIEW_SECONDS;
}
