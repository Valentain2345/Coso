import { describe, expect, it, vi } from 'vitest';
import { JobQueue } from '../src/lib/jobQueue';

describe('JobQueue', () => {
  it('drains in order and reports positions and totals', async () => {
    const queue = new JobQueue<string>();
    queue.enqueue(['a.wav', 'b.mp3', 'c.m4a']);
    const seen: Array<[string, number, number]> = [];

    const summary = await queue.drain(
      async (item, position) => {
        seen.push([item, position.index, position.total]);
        return 'done';
      },
    );

    expect(seen).toEqual([
      ['a.wav', 1, 3],
      ['b.mp3', 2, 3],
      ['c.m4a', 3, 3],
    ]);
    expect(summary).toEqual({ done: 3, failed: 0, total: 3, cancelled: false });
    expect(queue.size).toBe(0);
  });

  it('picks up recordings appended while an item runs', async () => {
    const queue = new JobQueue<string>();
    queue.enqueue(['first']);
    const order: string[] = [];

    const summary = await queue.drain(async (item, position) => {
      order.push(item);
      if (item === 'first') {
        // The user stopped another recording and pressed "Add to queue".
        queue.enqueue(['second', 'third']);
        expect(position.total).toBe(1);
      }
      return 'done';
    });

    expect(order).toEqual(['first', 'second', 'third']);
    expect(summary.done).toBe(3);
    expect(summary.total).toBe(3);
  });

  it('reports the growing total when work arrives mid-run', async () => {
    const queue = new JobQueue<string>();
    queue.enqueue(['a']);
    const positions: Array<{ index: number; total: number }> = [];

    await queue.drain(async (item, position) => {
      positions.push({ ...position });
      if (item === 'a') queue.enqueue(['b', 'c']);
      return 'done';
    });

    expect(positions).toEqual([
      { index: 1, total: 1 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ]);
  });

  it('keeps going after a failure and counts it', async () => {
    const queue = new JobQueue<string>();
    queue.enqueue(['a', 'b', 'c']);
    const run = vi
      .fn()
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('done')
      .mockResolvedValueOnce('failed');

    const summary = await queue.drain(run);

    expect(run).toHaveBeenCalledTimes(3);
    expect(summary).toEqual({ done: 1, failed: 2, total: 3, cancelled: false });
  });

  it('stops on a cancelled item and drops everything waiting', async () => {
    const queue = new JobQueue<string>();
    queue.enqueue(['a', 'b', 'c']);
    const run = vi.fn().mockResolvedValueOnce('done').mockResolvedValueOnce('cancelled');

    const summary = await queue.drain(run);

    expect(run).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ done: 1, failed: 0, total: 1, cancelled: true });
    expect(queue.size).toBe(0);
  });

  it('cancels between items without starting the rest', async () => {
    const queue = new JobQueue<string>();
    queue.enqueue(['a', 'b', 'c']);
    const run = vi.fn().mockResolvedValue('done');

    const summary = await queue.drain(async (item, position) => {
      const outcome = await run(item, position);
      // The user pressed Cancel while the first item was still saving.
      if (item === 'a') queue.cancel();
      return outcome;
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(summary.cancelled).toBe(true);
    expect(summary.done).toBe(1);
  });

  it('can be reused after a cancel once reset', async () => {
    const queue = new JobQueue<string>();
    queue.enqueue(['a']);
    queue.cancel();
    expect(queue.isStopped).toBe(true);
    await expect(queue.drain(vi.fn())).resolves.toEqual({
      done: 0,
      failed: 0,
      total: 0,
      cancelled: true,
    });

    queue.reset();
    queue.enqueue(['b']);
    const run = vi.fn().mockResolvedValue('done');
    await expect(queue.drain(run)).resolves.toEqual({
      done: 1,
      failed: 0,
      total: 1,
      cancelled: false,
    });
    expect(run).toHaveBeenCalledWith('b', { index: 1, total: 1 });
  });

  it('handles an empty queue without running anything', async () => {
    const queue = new JobQueue<string>();
    const run = vi.fn();

    const summary = await queue.drain(run);

    expect(run).not.toHaveBeenCalled();
    expect(summary).toEqual({ done: 0, failed: 0, total: 0, cancelled: false });
  });
});
