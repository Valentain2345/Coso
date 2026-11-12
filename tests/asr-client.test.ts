// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsrClient } from '../src/lib/asr/client';
import type { WorkerResponse } from '../src/types';

/**
 * Fake Worker: records postMessage calls and lets tests drive replies through
 * `reply()`, exercising the client's message handling without loading the real
 * transcription pipeline.
 */
class FakeWorker {
  static instances: FakeWorker[] = [];
  postMessage = vi.fn();
  terminate = vi.fn();
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null;
  onerror: ((event: { message?: string }) => void) | null = null;
  addEventListener = vi.fn((type: string, listener: (event: never) => void) => {
    if (type === 'message') this.onmessage = listener as never;
    if (type === 'error') this.onerror = listener as never;
  });

  constructor() {
    FakeWorker.instances.push(this);
  }

  reply(message: WorkerResponse) {
    this.onmessage?.({ data: message });
  }
}

describe('AsrClient', () => {
  let client: AsrClient;

  beforeEach(() => {
    FakeWorker.instances = [];
    vi.stubGlobal('Worker', FakeWorker as unknown as typeof Worker);
    client = new AsrClient();
    return () => vi.unstubAllGlobals();
  });

  afterEach(() => {
    client.dispose();
  });

  const run = () =>
    client.transcribe({
      audio: new Float32Array([0.1, 0.2, 0.3]),
      model: 'whisper-base',
      device: 'wasm',
      language: 'en',
    });

  it('posts a transcribe message with a copied buffer and resolves on result', async () => {
    const pending = run();
    await vi.waitFor(() => expect(FakeWorker.instances[0].postMessage).toHaveBeenCalled());
    const worker = FakeWorker.instances[0];
    const request = worker.postMessage.mock.calls[0][0] as { type: string; audio: Float32Array };
    expect(request.type).toBe('transcribe');
    expect(Array.from(request.audio).map((value) => Math.round(value * 10))).toEqual([1, 2, 3]);

    worker.reply({
      type: 'result',
      id: (worker.postMessage.mock.calls[0][0] as { id: string }).id,
      chunks: [],
      text: 'hello',
      language: 'en',
      duration: 0.3,
    });
    await expect(pending).resolves.toMatchObject({ text: 'hello', duration: 0.3 });
  });

  it('forwards stage messages to onStage', async () => {
    const onStage = vi.fn();
    const pending = client.transcribe({
      audio: new Float32Array(4),
      model: 'whisper-base',
      device: 'wasm',
      language: 'en',
      onStage,
    });
    await vi.waitFor(() => expect(FakeWorker.instances[0].postMessage).toHaveBeenCalled());
    const worker = FakeWorker.instances[0];
    const id = (worker.postMessage.mock.calls[0][0] as { id: string }).id;
    worker.reply({ type: 'stage', id, stage: 'transcribe', progress: 0.4, message: 'Reading the audio…' });
    expect(onStage).toHaveBeenCalledWith('transcribe', 0.4, 'Reading the audio…');
    worker.reply({ type: 'result', id, chunks: [], text: '', language: 'en', duration: 0 });
    await pending;
  });

  it('aggregates model-progress events into a single download state', async () => {
    const onModelProgress = vi.fn();
    const stages: Array<[string, number, string]> = [];
    const pending = client.transcribe({
      audio: new Float32Array(4),
      model: 'whisper-base',
      device: 'wasm',
      language: 'en',
      onModelProgress,
      onStage: (stage, progress, message) => stages.push([stage, progress, message]),
    });
    await vi.waitFor(() => expect(FakeWorker.instances[0].postMessage).toHaveBeenCalled());
    const worker = FakeWorker.instances[0];
    const id = (worker.postMessage.mock.calls[0][0] as { id: string }).id;
    worker.reply({
      type: 'model-progress',
      id,
      progress: { file: 'encoder.onnx', status: 'progress', loaded: 30, total: 60 },
    });
    worker.reply({
      type: 'model-progress',
      id,
      progress: { file: 'decoder.onnx', status: 'progress', loaded: 40, total: 60 },
    });
    expect(onModelProgress).toHaveBeenLastCalledWith({ loaded: 70, total: 120, percent: 70 / 120, file: 'decoder.onnx' });
    expect(stages.at(-1)?.[0]).toBe('load');
    expect(stages.at(-1)?.[2]).toContain('58%');
    worker.reply({ type: 'result', id, chunks: [], text: '', language: 'en', duration: 0 });
    await pending;
  });

  it('rejects on worker error messages and on engine crashes', async () => {
    const pending = run();
    await vi.waitFor(() => expect(FakeWorker.instances[0].postMessage).toHaveBeenCalled());
    const worker = FakeWorker.instances[0];
    worker.reply({ type: 'error', id: (worker.postMessage.mock.calls[0][0] as { id: string }).id, message: 'OOM' });
    await expect(pending).rejects.toThrow('OOM');

    // A hard engine crash (the Worker `error` event) rejects everything and
    // recycles the worker so the next transcription starts fresh.
    const second = run();
    await vi.waitFor(() => expect(worker.postMessage.mock.calls).toHaveLength(2));
    worker.onerror?.({ message: 'engine crashed' });
    await expect(second).rejects.toThrow(/crashed/);
    expect(client['worker']).toBeNull();
  });

  it('preload resolves on ready and reports the model as loaded', async () => {
    const onStage = vi.fn();
    const pending = client.preload('whisper-base', 'wasm', onStage);
    await vi.waitFor(() => expect(FakeWorker.instances[0].postMessage).toHaveBeenCalled());
    const worker = FakeWorker.instances[0];
    const id = (worker.postMessage.mock.calls[0][0] as { id: string }).id;
    expect((worker.postMessage.mock.calls[0][0] as { type: string }).type).toBe('load');
    worker.reply({ type: 'ready', id, model: 'whisper-base', device: 'wasm' });
    await expect(pending).resolves.toBeUndefined();
    expect(onStage).toHaveBeenCalledWith('load', 1, 'Speech model ready');
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      client.transcribe({
        audio: new Float32Array(4),
        model: 'whisper-base',
        device: 'wasm',
        language: 'en',
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it('terminate kills the worker and rejects in-flight tasks', async () => {
    const pending = run();
    await vi.waitFor(() => expect(FakeWorker.instances[0].postMessage).toHaveBeenCalled());
    client.terminate();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(FakeWorker.instances[0].terminate).toHaveBeenCalled();
    expect(client['worker']).toBeNull();
  });
});
