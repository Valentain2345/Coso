/**
 * Decide what a finished queue tells the user.
 *
 * A run can grow while it works, so the count that matters is the final one,
 * not the size of the first click. The rules keep the end of a run to a single
 * message: no notice at all when nothing succeeded (the cancel or failure card
 * already explained it), the familiar "transcript ready" toast for one file,
 * and a "3 of 4 saved" summary for a queue.
 */
import type { QueueSummary } from './jobQueue';

export interface SavedTranscript {
  words: number;
  speakers: number;
}

export type QueueNotice =
  | { kind: 'none' }
  | { kind: 'single'; words: number; speakers: number }
  | { kind: 'batch'; done: number; total: number; failed: boolean };

/** Pick the completion notice for a drained queue. */
export function describeQueueCompletion(
  summary: QueueSummary | null,
  saved: SavedTranscript | null,
): QueueNotice {
  if (!summary || summary.cancelled || summary.total === 0 || summary.done === 0) {
    return { kind: 'none' };
  }
  if (summary.total === 1) {
    return saved ? { kind: 'single', words: saved.words, speakers: saved.speakers } : { kind: 'none' };
  }
  return {
    kind: 'batch',
    done: summary.done,
    total: summary.total,
    failed: summary.failed > 0,
  };
}
