import { AutoModel, AutoModelForAudioFrameClassification, AutoProcessor, env } from '@huggingface/transformers';
import type { DenoiseQuality, DiarWindow, Stage } from '../../types';
import { highPass, detectSpeechSegments, StreamingResampler, spectralDenoise, type SpeechSegment } from './dsp';
import { NeuralDenoiser } from './denoise';
import { createOpfsModelCache } from './modelCache';
import { decodePyannoteFrames } from './pyannote';

interface ConfigureRequest {
  type: 'configure';
  id: string;
  denoise: boolean;
  denoiseQuality?: DenoiseQuality;
  diarize: boolean;
  thorough?: boolean;
  engine?: 'wespeaker' | 'pyannote';
  maxSpeakers: number;
}

interface ProcessRequest {
  type: 'process';
  id: string;
  samples: Float32Array;
  sampleRate: number;
  start: number;
}

interface ResetRequest {
  type: 'reset';
  id: string;
}

type Request = ConfigureRequest | ProcessRequest | ResetRequest;

type Response =
  | { type: 'stage'; id: string; stage: Stage; progress: number; message: string }
  | { type: 'configured'; id: string; denoise: boolean; diarize: boolean }
  | {
      type: 'chunk';
      id: string;
      start: number;
      end: number;
      samples: Float32Array;
      speech: SpeechSegment[];
      peaks: number[];
      windows: DiarWindow[];
    }
  | { type: 'error'; id: string; message: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const SPEAKER_MODEL = 'onnx-community/wespeaker-voxceleb-resnet34-LM';
const PYANNOTE_MODEL = 'onnx-community/pyannote-segmentation-3.0';

env.allowLocalModels = false;
// Keep model weights as files in the origin's private filesystem instead of
// Cache API entries: startup never touches them, and a large model cannot
// bloat the storage the interface reads when it opens.
const modelCache = createOpfsModelCache();
if (modelCache) {
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = modelCache;
} else {
  env.useBrowserCache = true;
}
const wasmBackend = env.backends?.onnx?.wasm;
if (wasmBackend) {
  wasmBackend.numThreads = scope.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
  wasmBackend.proxy = false;
}

let denoise = false;
let denoiseQuality: DenoiseQuality = 'neural';
let speaker = false;
let thorough = false;
let pyannote = false;
let maxSpeakers = 4;

let denoiser: NeuralDenoiser | null = null;
let upsampler: StreamingResampler | null = null;
let downsampler: StreamingResampler | null = null;
let directSampler: StreamingResampler | null = null;

let speakerProcessor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;
let speakerModel: Awaited<ReturnType<typeof AutoModel.from_pretrained>> | null = null;
let pyannoteProcessor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> | null = null;
let pyannoteModel: Awaited<
  ReturnType<typeof AutoModelForAudioFrameClassification.from_pretrained>
> | null = null;

let outputCursor = 0;
let inputCursor = 0;

function post(message: Response) {
  scope.postMessage(message);
}

function postStage(id: string, stage: Stage, progress: number, message: string) {
  post({ type: 'stage', id, stage, progress, message });
}

async function configure(request: ConfigureRequest) {
  denoise = request.denoise;
  denoiseQuality = request.denoiseQuality ?? 'neural';
  speaker = request.diarize;
  thorough = Boolean(request.thorough);
  maxSpeakers = Math.max(1, Math.min(8, request.maxSpeakers || 4));

  resetStreams();
  outputCursor = 0;
  inputCursor = 0;

  if (denoise && denoiseQuality !== 'basic') {
    postStage(
      request.id,
      'denoise',
      0.02,
      denoiseQuality === 'maximum' ? 'Loading maximum noise removal…' : 'Loading DeepFilterNet3…',
    );
    try {
      denoiser = new NeuralDenoiser();
      denoiser.setAttenuationLimit(denoiseQuality === 'maximum' ? 100 : 30);
      await denoiser.load();
      postStage(
        request.id,
        'denoise',
        0.5,
        denoiseQuality === 'maximum' ? 'Maximum noise removal ready' : 'DeepFilterNet3 ready',
      );
    } catch (error) {
      // Keep `denoise` on: processing falls back to the spectral filter below.
      denoiser?.destroy();
      denoiser = null;
      upsampler = null;
      postStage(
        request.id,
        'denoise',
        0.5,
        `Neural noise removal is unavailable in this browser — using the standard filter. (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  pyannote = false;

  if (speaker) {
    postStage(request.id, 'diarize', 0, 'Loading the speaker model…');
    try {
      speakerProcessor = await AutoProcessor.from_pretrained(SPEAKER_MODEL);
      speakerModel = await AutoModel.from_pretrained(SPEAKER_MODEL, {
        dtype: 'fp32',
        progress_callback: (event: unknown) => {
          const info = event as { status?: string; progress?: number; file?: string };
          if (info?.status === 'progress' && typeof info.progress === 'number') {
            postStage(request.id, 'diarize', Math.max(0, Math.min(1, info.progress / 100)), 'Downloading the speaker model…');
          }
        },
      });

      if (request.engine === 'pyannote') {
        postStage(request.id, 'diarize', 0.7, 'Loading Pyannote 3.0 segmentation…');
        try {
          pyannoteProcessor = await AutoProcessor.from_pretrained(PYANNOTE_MODEL);
          pyannoteModel = await AutoModelForAudioFrameClassification.from_pretrained(PYANNOTE_MODEL, {
            dtype: 'q8',
            progress_callback: (event: unknown) => {
              const info = event as { status?: string; progress?: number };
              if (info?.status === 'progress' && typeof info.progress === 'number') {
                postStage(
                  request.id,
                  'diarize',
                  0.7 + Math.max(0, Math.min(0.3, info.progress / 100 * 0.3)),
                  'Downloading Pyannote 3.0…',
                );
              }
            },
          });
          pyannote = true;
          postStage(request.id, 'diarize', 1, 'Pyannote 3.0 and WeSpeaker ready');
        } catch (error) {
          pyannoteProcessor = null;
          pyannoteModel = null;
          postStage(
            request.id,
            'diarize',
            1,
            `Pyannote 3.0 is unavailable — using WeSpeaker windows. (${
              error instanceof Error ? error.message : String(error)
            })`,
          );
        }
      } else {
        postStage(request.id, 'diarize', 1, 'Speaker model ready');
      }
    } catch (error) {
      speaker = false;
      speakerProcessor = null;
      speakerModel = null;
      postStage(
        request.id,
        'diarize',
        1,
        `Speaker separation is unavailable — transcribing without labels. (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }

  post({ type: 'configured', id: request.id, denoise, diarize: speaker });
}

function resetStreams() {
  denoiser?.reset();
  upsampler?.reset();
  downsampler?.reset();
  directSampler?.reset();
  upsampler = null;
  downsampler = null;
  directSampler = null;
}

function bucketPeaks(samples: Float32Array, sampleRate: number): number[] {
  const bucketSize = Math.max(1, Math.round(sampleRate / 3));
  const buckets = Math.ceil(samples.length / bucketSize);
  const peaks = new Array<number>(buckets).fill(0);
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = bucket * bucketSize;
    const end = Math.min(samples.length, start + bucketSize);
    let maximum = 0;
    for (let index = start; index < end; index += 1) {
      const magnitude = Math.abs(samples[index]);
      if (magnitude > maximum) maximum = magnitude;
    }
    peaks[bucket] = maximum;
  }
  return peaks;
}

function windowsFor(speech: SpeechSegment[], precise = false): SpeechSegment[] {
  const max = precise ? 60 : 14;
  const candidates: SpeechSegment[] = [];

  for (const segment of speech) {
    const length = segment.end - segment.start;
    if (length < 0.8) continue;

    if (length <= 5.5) {
      const count = precise && length >= 3.6 ? 2 : 1;
      for (let index = 0; index < count; index += 1) {
        const center = segment.start + ((index + 0.5) * length) / count;
        const width = Math.min(precise ? 2.8 : 2.4, length / count);
        candidates.push({ start: center - width / 2, end: center + width / 2 });
      }
      continue;
    }

    const count = precise
      ? Math.min(10, Math.max(3, Math.round(length / 2)))
      : Math.min(4, Math.max(2, Math.round(length / 4)));
    for (let index = 0; index < count; index += 1) {
      const center = segment.start + ((index + 0.5) * length) / count;
      const width = Math.min(precise ? 2.8 : 2.4, (length / count) * (precise ? 0.9 : 0.78));
      candidates.push({ start: center - width / 2, end: center + width / 2 });
    }
  }

  if (candidates.length <= max) return candidates;
  return Array.from({ length: max }, (_, index) => {
    const position = Math.round((index * (candidates.length - 1)) / Math.max(1, max - 1));
    return candidates[position];
  });
}

async function embed(audio: Float32Array): Promise<Float32Array | null> {
  if (!speakerModel || !speakerProcessor) return null;
  try {
    const inputs = await speakerProcessor(audio);
    const output = (await speakerModel(inputs)) as { last_hidden_state?: { data: Float32Array } };
    const data = output.last_hidden_state?.data;
    if (!data) return null;

    let sum = 0;
    for (const value of data) sum += value * value;
    const length = Math.sqrt(sum);
    if (length < 1e-9) return null;

    const normalized = new Float32Array(data.length);
    for (let index = 0; index < data.length; index += 1) normalized[index] = data[index] / length;
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Runs Pyannote segmentation over 10-second windows and returns single-speaker
 * regions. Pyannote's local speaker ids restart in every window, so they are
 * deliberately discarded; WeSpeaker embeddings link the regions globally.
 */
async function pyannoteRegions(audio: Float32Array): Promise<SpeechSegment[]> {
  if (!pyannoteModel || !pyannoteProcessor) return [];

  const regions: SpeechSegment[] = [];
  const seconds = audio.length / 16000;
  const windowSize = 10;

  for (let offset = 0; offset < seconds - 0.25; offset += windowSize) {
    const from = Math.floor(offset * 16000);
    const to = Math.min(audio.length, from + windowSize * 16000);
    const duration = (to - from) / 16000;
    if (duration < 0.5) break;

    try {
      const inputs = await pyannoteProcessor(audio.subarray(from, to));
      const output = (await pyannoteModel(inputs)) as {
        logits?: { data: Float32Array; dims: number[] };
      };
      const logits = output.logits;
      if (!logits) continue;

      const frames = logits.dims[logits.dims.length - 2] ?? 0;
      const classes = logits.dims[logits.dims.length - 1] ?? 0;
      regions.push(...decodePyannoteFrames(logits.data, frames, classes, offset, duration));
    } catch {
      // One damaged window should not discard the rest of the chunk.
    }
  }

  return regions;
}

async function processChunk(request: ProcessRequest) {
  const sourceRate = request.sampleRate;
  const startSample = Math.round(request.start * sourceRate);

  // A jump means a resume or a new file: restart filters instead of feeding
  // them audio that does not connect to the previous chunk.
  if (startSample !== inputCursor) {
    resetStreams();
    outputCursor = request.start;
  }

  const highPassed = highPass(request.samples, sourceRate, 75);

  let clean16: Float32Array;
  if (denoise && denoiser && denoiseQuality !== 'basic') {
    if (!upsampler) upsampler = new StreamingResampler(sourceRate, 48000);
    if (!downsampler) downsampler = new StreamingResampler(48000, 16000);
    const resampled48 = upsampler.process(highPassed);
    const enhanced48 = denoiser.process(resampled48);
    clean16 = downsampler.process(enhanced48);
    if (denoiseQuality === 'maximum') {
      clean16 = spectralDenoise(clean16, 16000, { strength: 1.7, floor: 0.05 });
    }
  } else {
    if (!directSampler) directSampler = new StreamingResampler(sourceRate, 16000);
    let mono = highPassed;
    if (sourceRate !== 16000) mono = directSampler.process(highPassed);
    if (denoise) {
      mono = spectralDenoise(mono, 16000, {
        strength: denoiseQuality === 'basic' || denoiser ? 1.35 : 1.5,
        floor: 0.06,
      });
    }
    clean16 = mono;
  }

  inputCursor = startSample + request.samples.length;
  const chunkStart = outputCursor;
  const chunkEnd = chunkStart + clean16.length / 16000;
  outputCursor = chunkEnd;

  const filtered = highPass(clean16, 16000, 70);
  const speech = detectSpeechSegments(filtered, 16000, {
    minSpeech: 0.35,
    minSilence: 0.45,
    pad: 0.12,
    maxSegment: 28,
    thresholdFactor: 3.0,
  }).map((segment) => ({
    start: chunkStart + segment.start,
    end: chunkStart + segment.end,
  }));

  const windows: DiarWindow[] = [];
  if (speaker && filtered.length > 0) {
    let regions: SpeechSegment[] = [];
    if (pyannote) {
      regions = await pyannoteRegions(filtered);
    }

    // If Pyannote loaded but found nothing (or failed on every window), fall
    // back to the energy VAD instead of losing speaker labels for this chunk.
    if (regions.length === 0) {
      regions = speech.map((segment) => ({
        start: segment.start - chunkStart,
        end: segment.end - chunkStart,
      }));
    }

    const selected = windowsFor(regions, thorough);
    for (const window of selected) {
      const from = Math.max(0, Math.floor(window.start * 16000));
      const to = Math.min(filtered.length, Math.ceil(window.end * 16000));
      if (to - from < 16000 * 0.4) continue;
      const embedding = await embed(filtered.slice(from, to));
      if (!embedding) continue;
      windows.push({
        start: chunkStart + from / 16000,
        end: chunkStart + to / 16000,
        embedding,
      });
    }
  }

  const response: Response = {
    type: 'chunk',
    id: request.id,
    start: chunkStart,
    end: chunkEnd,
    samples: filtered,
    speech,
    peaks: bucketPeaks(filtered, 16000),
    windows,
  };
  scope.postMessage(response, [filtered.buffer as ArrayBuffer]);
}

scope.addEventListener('message', async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    if (request.type === 'configure') {
      await configure(request);
      return;
    }
    if (request.type === 'reset') {
      resetStreams();
      outputCursor = 0;
      inputCursor = 0;
      post({ type: 'configured', id: request.id, denoise, diarize: speaker });
      return;
    }
    await processChunk(request);
  } catch (error) {
    post({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

export {};
