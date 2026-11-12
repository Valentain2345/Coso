import type { DiarWindow, Stage } from '../../types';
import type { SpeechSegment } from './dsp';
import type { AudioChunk } from './stream';

export interface ChunkResult {
  start: number;
  end: number;
  samples: Float32Array;
  speech: SpeechSegment[];
  peaks: number[];
  windows: DiarWindow[];
}

export interface PipelineOptions {
  denoise: boolean;
  /** Basic spectral filtering, neural DeepFilterNet3, or maximum suppression. */
  denoiseQuality?: 'basic' | 'neural' | 'maximum';
  diarize: boolean;
  /** Denser speaker windows and automatic cluster count for hard recordings. */
  thorough?: boolean;
  /** Pyannote finds speaker turns; WeSpeaker supplies the embeddings in both modes. */
  engine?: 'wespeaker' | 'pyannote';
  maxSpeakers: number;
  onStage?: (stage: Stage, progress: number, message: string) => void;
  signal?: AbortSignal;
}

type Response =
  | { type: 'stage'; id: string; stage: Stage; progress: number; message: string }
  | { type: 'configured'; id: string; denoise: boolean; diarize: boolean }
  | ({ type: 'chunk'; id: string } & ChunkResult)
  | { type: 'error'; id: string; message: string };

interface Task {
  id: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `ap-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * Owns the analysis worker: streaming resampling, DeepFilterNet3, VAD, peaks
 * and speaker embeddings. One chunk in, one chunk out.
 */
export class AudioPipelineClient {
  private worker: Worker | null = null;
  private tasks = new Map<string, Task>();
  private stages = new Map<string, PipelineOptions['onStage']>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(new URL('./worker.ts', import.meta.url), {
      type: 'module',
      name: 'coso-audio-pipeline',
    });

    worker.addEventListener('message', (event: MessageEvent<Response>) => {
      const message = event.data;
      if (message.type === 'stage') {
        this.stages.get(message.id)?.(message.stage, message.progress, message.message);
        return;
      }

      const task = this.tasks.get(message.id);
      if (!task) return;
      this.tasks.delete(message.id);
      this.stages.delete(message.id);

      if (message.type === 'error') {
        task.reject(new Error(message.message));
        return;
      }
      if (message.type === 'configured') {
        task.resolve({ denoise: message.denoise, diarize: message.diarize });
        return;
      }
      const { type: _type, id: _id, ...chunk } = message;
      task.resolve(chunk as ChunkResult);
    });

    worker.addEventListener('error', (event) => {
      const error = new Error(event.message || 'The audio pipeline worker crashed.');
      for (const task of this.tasks.values()) task.reject(error);
      this.tasks.clear();
      this.stages.clear();
      worker.terminate();
      this.worker = null;
    });

    this.worker = worker;
    return worker;
  }

  private run<T>(
    request: Record<string, unknown>,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
    onStage?: PipelineOptions['onStage'],
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(new DOMException('Cancelled', 'AbortError'));

    const worker = this.ensureWorker();
    const id = newId();

    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.terminate();
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });

      this.tasks.set(id, {
        id,
        resolve: (value) => {
          signal?.removeEventListener('abort', abort);
          resolve(value as T);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', abort);
          reject(error);
        },
      });
      if (onStage) this.stages.set(id, onStage);
      worker.postMessage({ ...request, id }, transfer);
    });
  }

  configure(options: PipelineOptions): Promise<{ denoise: boolean; diarize: boolean }> {
    return this.run(
      {
        type: 'configure',
        denoise: options.denoise,
        denoiseQuality: options.denoiseQuality ?? 'neural',
        diarize: options.diarize,
        thorough: options.thorough ?? false,
        engine: options.engine ?? 'wespeaker',
        maxSpeakers: options.maxSpeakers,
      },
      [],
      options.signal,
      options.onStage,
    );
  }

  process(chunk: AudioChunk, signal?: AbortSignal): Promise<ChunkResult> {
    const samples = chunk.samples.slice();
    return this.run<ChunkResult>(
      {
        type: 'process',
        samples,
        sampleRate: chunk.sampleRate,
        start: chunk.start,
      },
      [samples.buffer as ArrayBuffer],
      signal,
    );
  }

  terminate(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const task of this.tasks.values()) task.reject(new DOMException('Cancelled', 'AbortError'));
    this.tasks.clear();
    this.stages.clear();
  }
}
