import type { DevicePreference, ModelId, RawAsrChunk, Stage, WorkerResponse } from '../../types';

export interface ModelDownloadState {
  loaded: number;
  total: number;
  percent: number;
  file: string | null;
}

export interface AsrOptions {
  audio: Float32Array;
  model: ModelId;
  device: DevicePreference;
  language: string;
  onStage?: (stage: Stage, progress: number, message: string) => void;
  onModelProgress?: (state: ModelDownloadState) => void;
  signal?: AbortSignal;
}

export interface AsrResult {
  chunks: RawAsrChunk[];
  text: string;
  language: string;
  duration: number;
}

interface PendingTask {
  resolve: (result: AsrResult) => void;
  reject: (error: Error) => void;
  onStage?: AsrOptions['onStage'];
  onModelProgress?: AsrOptions['onModelProgress'];
  files: Map<string, { loaded: number; total: number }>;
  signal?: AbortSignal;
  abortListener?: () => void;
  /** Set for preload-only tasks; resolves as soon as the worker signals ready. */
  onReady?: () => void;
}

function newId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `asr-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class AsrClient {
  private worker: Worker | null = null;
  private tasks = new Map<string, PendingTask>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'coso-asr',
    });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => this.handle(event.data));
    this.worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'The transcription engine crashed.');
      for (const task of this.tasks.values()) task.reject(error);
      this.tasks.clear();
      this.worker?.terminate();
      this.worker = null;
    });
    return this.worker;
  }

  private handle(message: WorkerResponse) {
    const task = this.tasks.get(message.id);
    if (!task) return;

    switch (message.type) {
      case 'stage':
        task.onStage?.(message.stage, message.progress, message.message);
        return;
      case 'model-progress': {
        const event = message.progress;
        const file = event.file ?? event.name ?? 'model';
        if (event.status === 'progress' && typeof event.loaded === 'number' && typeof event.total === 'number') {
          task.files.set(file, { loaded: event.loaded, total: event.total });
        }
        let loaded = 0;
        let total = 0;
        for (const entry of task.files.values()) {
          loaded += entry.loaded;
          total += entry.total;
        }
        const percent = total > 0 ? Math.min(1, loaded / total) : 0;
        task.onModelProgress?.({
          loaded,
          total,
          percent,
          file: total > 0 ? file : null,
        });
        task.onStage?.(
          'load',
          percent,
          total > 0
            ? `Downloading ${Math.round((loaded / total) * 100)}% of the speech model`
            : 'Preparing the speech model…',
        );
        return;
      }
      case 'ready':
        task.onStage?.('load', 1, 'Speech model ready');
        if (task.onReady) {
          this.tasks.delete(message.id);
          task.onReady();
        }
        return;
      case 'result':
        this.finish(message.id, {
          chunks: message.chunks,
          text: message.text,
          language: message.language,
          duration: message.duration,
        });
        return;
      case 'error':
        this.fail(message.id, new Error(message.message));
        return;
    }
  }

  private finish(id: string, result: AsrResult) {
    const task = this.tasks.get(id);
    if (!task) return;
    task.signal?.removeEventListener('abort', task.abortListener!);
    this.tasks.delete(id);
    task.resolve(result);
  }

  private fail(id: string, error: Error) {
    const task = this.tasks.get(id);
    if (!task) return;
    task.signal?.removeEventListener('abort', task.abortListener!);
    this.tasks.delete(id);
    task.reject(error);
  }

  transcribe(options: AsrOptions): Promise<AsrResult> {
    if (options.signal?.aborted) {
      return Promise.reject(new DOMException('Transcription cancelled.', 'AbortError'));
    }

    const worker = this.ensureWorker();
    const id = newId();
    // Copy so the caller keeps ownership of its buffer.
    const audio = options.audio.slice();
    const transfer = audio.buffer as ArrayBuffer;

    return new Promise<AsrResult>((resolve, reject) => {
      const task: PendingTask = {
        resolve,
        reject,
        onStage: options.onStage,
        onModelProgress: options.onModelProgress,
        files: new Map(),
        signal: options.signal,
      };

      task.abortListener = () => {
        // Inference cannot be interrupted mid-graph; recycle the worker instead.
        this.terminate();
      };
      options.signal?.addEventListener('abort', task.abortListener, { once: true });
      this.tasks.set(id, task);

      worker.postMessage(
        {
          type: 'transcribe',
          id,
          audio,
          sampleRate: 16000,
          language: options.language,
          model: options.model,
          device: options.device,
          timestamps: true,
        },
        [transfer],
      );
    });
  }

  preload(model: ModelId, device: DevicePreference, onStage?: AsrOptions['onStage']): Promise<void> {
    const worker = this.ensureWorker();
    const id = newId();
    return new Promise((resolve, reject) => {
      const task: PendingTask = {
        resolve: () => resolve(),
        reject,
        onStage,
        files: new Map(),
        onReady: () => resolve(),
      };
      this.tasks.set(id, task);
      worker.postMessage({ type: 'load', id, model, device });
    });
  }

  cancel(id?: string) {
    if (id) {
      const task = this.tasks.get(id);
      if (task) {
        this.tasks.delete(id);
        task.reject(new DOMException('Transcription cancelled.', 'AbortError'));
      }
      return;
    }
    this.terminate();
  }

  /** Hard reset: kills inference currently running inside the worker. */
  terminate() {
    this.worker?.terminate();
    this.worker = null;
    for (const task of this.tasks.values()) {
      task.reject(new DOMException('Transcription cancelled.', 'AbortError'));
    }
    this.tasks.clear();
  }

  dispose() {
    this.terminate();
  }
}

export const asrClient = new AsrClient();
