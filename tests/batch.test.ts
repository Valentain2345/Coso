import { describe, expect, it, vi } from 'vitest';
import { runSequentialBatch } from '../src/lib/batch';

describe('runSequentialBatch', () => {
  it('processes every item in order and reports the totals', async () => {
    const order: string[] = [];
    const onStart = vi.fn();

    const summary = await runSequentialBatch(
      ['a.wav', 'b.mp3', 'c.m4a'],
      async (name) => {
        order.push(name);
        return 'done';
      },
      { onStart },
    );

    expect(order).toEqual(['a.wav', 'b.mp3', 'c.m4a']);
    expect(onStart.mock.calls).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
    expect(summary).toEqual({ total: 3, done: 3, failed: 0, cancelled: false });
  });

  it('keeps going after a failure', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('done')
      .mockResolvedValueOnce('failed');

    const summary = await runSequentialBatch(['a', 'b', 'c'], run);

    expect(run).toHaveBeenCalledTimes(3);
    expect(summary.done).toBe(1);
    expect(summary.failed).toBe(2);
    expect(summary.cancelled).toBe(false);
  });

  it('stops on the first cancelled item and does not start the rest', async () => {
    const run = vi.fn().mockResolvedValueOnce('done').mockResolvedValueOnce('cancelled');

    const summary = await runSequentialBatch(['a', 'b', 'c'], run);

    expect(run).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ total: 3, done: 1, failed: 0, cancelled: true });
  });

  it('stops before starting an item when the queue was cancelled while idle', async () => {
    const run = vi.fn().mockResolvedValue('done');
    let stop = false;

    const summary = await runSequentialBatch(['a', 'b'], run, {
      shouldStop: () => stop,
      onStart: () => {
        // The user cancels from the progress card between files.
        stop = true;
      },
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(summary.cancelled).toBe(true);
    expect(summary.done).toBe(1);
  });

  it('handles an empty queue without running anything', async () => {
    const run = vi.fn();

    const summary = await runSequentialBatch<string>([], run);

    expect(run).not.toHaveBeenCalled();
    expect(summary).toEqual({ total: 0, done: 0, failed: 0, cancelled: false });
  });
});
