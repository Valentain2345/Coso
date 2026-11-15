import { describe, expect, it } from 'vitest';
import { describeQueueCompletion } from '../src/lib/queueNotice';
import type { QueueSummary } from '../src/lib/jobQueue';

const summary = (over: Partial<QueueSummary> = {}): QueueSummary => ({
  done: 1,
  failed: 0,
  total: 1,
  cancelled: false,
  ...over,
});

const saved = { words: 412, speakers: 2 };

describe('describeQueueCompletion', () => {
  it('stays quiet when the queue was cancelled', () => {
    expect(describeQueueCompletion(summary({ done: 2, total: 3, cancelled: true }), saved)).toEqual({
      kind: 'none',
    });
  });

  it('stays quiet when nothing ran', () => {
    expect(describeQueueCompletion(null, null)).toEqual({ kind: 'none' });
    expect(describeQueueCompletion(summary({ done: 0, total: 0 }), null)).toEqual({ kind: 'none' });
  });

  it('leaves a failed solo run to the failure card and its toast', () => {
    expect(describeQueueCompletion(summary({ done: 0, failed: 1 }), null)).toEqual({ kind: 'none' });
  });

  it('keeps the familiar transcript-ready notice for one file', () => {
    expect(describeQueueCompletion(summary(), saved)).toEqual({
      kind: 'single',
      words: 412,
      speakers: 2,
    });
  });

  it('summarizes a queue with the final count, including work added mid-run', () => {
    expect(describeQueueCompletion(summary({ done: 3, total: 4, failed: 1 }), saved)).toEqual({
      kind: 'batch',
      done: 3,
      total: 4,
      failed: true,
    });
    expect(describeQueueCompletion(summary({ done: 2, total: 2 }), saved)).toEqual({
      kind: 'batch',
      done: 2,
      total: 2,
      failed: false,
    });
  });
});
