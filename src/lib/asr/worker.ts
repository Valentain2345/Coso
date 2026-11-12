import { env, pipeline } from '@huggingface/transformers';
import { modelInfo } from '../models';
import type { WorkerModelProgress, WorkerRequest, WorkerResponse, RawAsrChunk, DevicePreference, ModelId } from '../../types';

const scope = self as unknown as DedicatedWorkerGlobalScope;

env.allowLocalModels = false;
env.useBrowserCache = true;

const wasmBackend = env.backends?.onnx?.wasm;
if (wasmBackend) {
  // Let the bundler emit ORT's own loader and wasm files. Pointing `wasmPaths`
  // at /public breaks because Vite then tries to transform a public .mjs.
  // SharedArrayBuffer is only available in a cross-origin isolated context.
  wasmBackend.numThreads = scope.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1;
  wasmBackend.proxy = false;
}

type Asr = Awaited<ReturnType<typeof pipeline<'automatic-speech-recognition'>>>;

let loaded: { key: string; asr: Asr; device: string } | null = null;

function post(message: WorkerResponse) {
  scope.postMessage(message);
}

async function getPipeline(id: string, model: ModelId, preference: DevicePreference) {
  const info = modelInfo(model);
  const key = `${model}:${preference}`;
  if (loaded?.key === key) {
    post({ type: 'ready', id, model: info.repo, device: loaded.device });
    return loaded;
  }

  const attempts: Array<'webgpu' | 'wasm'> = preference === 'webgpu' ? ['webgpu', 'wasm'] : ['wasm'];
  let lastError: unknown = null;

  for (const device of attempts) {
    try {
      post({
        type: 'stage',
        id,
        stage: 'load',
        progress: 0,
        message: `Loading ${info.label}${device === 'webgpu' ? ' on the GPU' : ''}…`,
      });

      const asr = await pipeline('automatic-speech-recognition', info.repo, {
        device,
        dtype: device === 'webgpu' ? 'fp16' : 'q8',
        progress_callback: (event: unknown) => {
          post({ type: 'model-progress', id, progress: event as WorkerModelProgress });
        },
      });

      loaded = { key, asr: asr as Asr, device };
      post({ type: 'ready', id, model: info.repo, device });
      return loaded;
    } catch (error) {
      lastError = error;
      if (device === 'webgpu') {
        post({
          type: 'stage',
          id,
          stage: 'load',
          progress: 0,
          message: 'WebGPU is unavailable here — switching to the CPU engine…',
        });
      }
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Could not load ${info.label}. Check your connection for the first download. (${detail})`);
}

async function handleTranscribe(request: Extract<WorkerRequest, { type: 'transcribe' }>) {
  const { id, audio, language, model, device } = request;
  const info = modelInfo(model);
  const { asr, device: activeDevice } = await getPipeline(id, model, device);

  post({
    type: 'stage',
    id,
    stage: 'transcribe',
    progress: 0,
    message: `Transcribing with ${info.label} on ${activeDevice === 'webgpu' ? 'GPU' : 'CPU'}…`,
  });

  const languageArg = info.englishOnly || language === 'en' ? 'en' : language;
  const start = performance.now();

  const output = (await asr(audio, {
    language: languageArg,
    task: 'transcribe',
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    // Guard against Whisper's repetition loops on noisy classroom audio.
    no_repeat_ngram_size: 3,
    repetition_penalty: 1.05,
  })) as { text?: string; chunks?: Array<{ text: string; timestamp: [number, number | null] }> };

  const rawChunks = output.chunks ?? [];
  const chunks: RawAsrChunk[] = rawChunks
    .map((chunk) => ({
      text: String(chunk.text ?? '').trim(),
      start: Math.max(0, Number(chunk.timestamp?.[0] ?? 0)),
      end: Math.max(Number(chunk.timestamp?.[0] ?? 0) + 0.2, Number(chunk.timestamp?.[1] ?? audio.length / 16000)),
      confidence: null,
    }))
    .filter((chunk) => chunk.text.length > 0);

  if (chunks.length === 0 && output.text?.trim()) {
    chunks.push({
      text: output.text.trim(),
      start: 0,
      end: audio.length / 16000,
      confidence: null,
    });
  }

  post({
    type: 'result',
    id,
    chunks,
    text: String(output.text ?? '').trim(),
    language: info.englishOnly ? 'en' : languageArg,
    duration: audio.length / 16000,
  });

  post({
    type: 'stage',
    id,
    stage: 'transcribe',
    progress: 1,
    message: `Transcribed in ${((performance.now() - start) / 1000).toFixed(1)} s`,
  });
}

scope.addEventListener('message', async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'load') {
      await getPipeline(request.id, request.model, request.device);
      return;
    }
    if (request.type === 'transcribe') {
      await handleTranscribe(request);
      return;
    }
  } catch (error) {
    post({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

post({ type: 'stage', id: 'boot', stage: 'load', progress: 0, message: 'Engine ready' });
