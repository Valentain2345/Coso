/**
 * Decide how much of the workspace the transcription status may take.
 *
 * The queue is meant to be invisible: recording, importing and reading another
 * transcript must keep working while Whisper runs. The full step-by-step card
 * is therefore an exception - the user asked for it, or a failure needs the
 * retry/resume actions - and never something that covers a live recording or a
 * run that still has work waiting.
 */

export interface ProgressViewState {
  /** A transcription is in flight, or the last attempt failed. */
  active: boolean;
  /** An attempt is running right now. */
  running: boolean;
  /** The last attempt ended in an error. */
  failed: boolean;
  /** The user expanded the step-by-step card. */
  expanded: boolean;
  /** Recordings waiting behind the one in flight. */
  queued: number;
  /** The microphone is recording, paused or asking for permission. */
  recording: boolean;
}

/** True when the full progress card should replace the workspace. */
export function showFullProgressCard(state: ProgressViewState): boolean {
  if (!state.active) return false;
  // An explicit expand always wins; the recorder keeps running underneath.
  if (state.expanded) return true;
  // A failure deserves the card, but only when it is the last thing to report:
  // a failure with more work queued is announced by a toast, and one that
  // happens while the user is recording must not hide the recorder.
  return state.failed && !state.running && state.queued === 0 && !state.recording;
}
