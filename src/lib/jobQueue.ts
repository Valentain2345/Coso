/**
 * Appendable queue for on-device transcription.
 *
 * Recording and transcription are independent: the user can stop a recording,
 * hear a preview, start the run — then immediately go back and record the next
 * lecture while the first one is still being transcribed. New work is appended
 * to the queue instead of being refused, and the queue drains strictly one item
 * at a time because Whisper shares a single model and WASM/WebGPU context.
 *
 * A failed item is counted and the queue keeps going; an explicit cancel stops
 * the item in flight and drops everything waiting.
 */

export type QueueOutcome = 'done' | 'failed' | 'cancelled';

export interface QueuePosition {
  /** 1-based position of the item that is about to start. */
  index: number;
  /** Completed + running + waiting. Grows when work is appended mid-run. */
  total: number;
}

export interface QueueSummary {
  /** Items that finished successfully. */
  done: number;
  /** Items that threw an error (the rest of the queue still ran). */
  failed: number;
  /** Items attempted: `done + failed`. */
  total: number;
  /** True when the user cancelled, so the queue stopped early. */
  cancelled: boolean;
}

export interface QueueHooks<T> {
  /** Called right before an item starts, with its place in the queue. */
  onStart?: (item: T, position: QueuePosition) => void;
}

export class JobQueue<T> {
  private waiting: T[] = [];
  private stopped = false;

  /** Items waiting behind the one in flight (read-only snapshot). */
  get pending(): readonly T[] {
    return this.waiting;
  }

  get size(): number {
    return this.waiting.length;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Append work; returns the number of recordings now waiting. */
  enqueue(items: readonly T[]): number {
    this.waiting.push(...items);
    return this.waiting.length;
  }

  /** Prepare for a new drain after a cancel. */
  reset(): void {
    this.stopped = false;
    this.waiting = [];
  }

  /** Stop the queue: the item in flight is aborted by the caller, the rest is dropped. */
  cancel(): void {
    this.stopped = true;
    this.waiting = [];
  }

  /**
   * Process the queue until it is empty or cancelled. Items appended while a
   * run is in flight are picked up without restarting.
   */
  async drain(
    run: (item: T, position: QueuePosition) => Promise<QueueOutcome>,
    hooks: QueueHooks<T> = {},
  ): Promise<QueueSummary> {
    let done = 0;
    let failed = 0;
    let cancelled = false;

    for (;;) {
      if (this.stopped) {
        cancelled = true;
        break;
      }
      if (this.waiting.length === 0) break;

      const item = this.waiting.shift()!;
      const position: QueuePosition = {
        index: done + failed + 1,
        total: done + failed + 1 + this.waiting.length,
      };
      hooks.onStart?.(item, position);

      const outcome = await run(item, position);
      if (outcome === 'done') {
        done += 1;
      } else if (outcome === 'failed') {
        failed += 1;
      } else {
        cancelled = true;
        break;
      }
    }

    if (cancelled) this.waiting = [];
    this.stopped = false;

    return { done, failed, total: done + failed, cancelled };
  }
}
