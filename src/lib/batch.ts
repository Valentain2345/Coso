/**
 * Sequential batch runner for multi-file transcription.
 *
 * Speech recognition shares one model and one WASM/WebGPU context, so running
 * files in parallel would double memory without finishing sooner. Processing
 * them one at a time still lets the user queue an entire folder: each result is
 * saved before the next file starts, and a single failure does not abort the
 * rest of the batch.
 */

export type BatchItemOutcome = 'done' | 'failed' | 'cancelled';

export interface BatchSummary {
  total: number;
  done: number;
  failed: number;
  cancelled: boolean;
}

export interface BatchHooks {
  /** Called before each item, with a 0-based index. */
  onStart?: (index: number, total: number) => void;
  /** Polled before each item; return true to stop without starting it. */
  shouldStop?: () => boolean;
}

export async function runSequentialBatch<T>(
  items: readonly T[],
  run: (item: T, index: number) => Promise<BatchItemOutcome>,
  hooks: BatchHooks = {},
): Promise<BatchSummary> {
  const total = items.length;
  let done = 0;
  let failed = 0;
  let cancelled = false;

  for (let index = 0; index < total; index += 1) {
    if (hooks.shouldStop?.()) {
      cancelled = true;
      break;
    }

    hooks.onStart?.(index, total);
    const outcome = await run(items[index], index);

    if (outcome === 'done') done += 1;
    else if (outcome === 'failed') failed += 1;
    else {
      cancelled = true;
      break;
    }
  }

  return { total, done, failed, cancelled };
}
