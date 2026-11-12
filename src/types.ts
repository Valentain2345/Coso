export type ModelId =
  | 'whisper-tiny'
  | 'whisper-tiny.en'
  | 'whisper-base'
  | 'whisper-base.en'
  | 'whisper-small'
  | 'whisper-small.en'
  | 'whisper-medium'
  | 'whisper-large-v3-turbo';

export type DevicePreference = 'auto' | 'webgpu' | 'wasm';
export type ThemePreference = 'light' | 'dark' | 'system';
export type TextSize = 'sm' | 'md' | 'lg';
export type DiarizationQuality = 'standard' | 'thorough';
export type DiarizationEngine = 'wespeaker' | 'pyannote';
/** How hard the pipeline works to remove room noise before transcribing. */
export type DenoiseQuality = 'basic' | 'neural' | 'maximum';

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  /** 0-based speaker index. Use 0 when diarization is disabled. */
  speaker: number;
  /** Average word probability, when the model exposes it. */
  confidence: number | null;
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  duration: number;
  language: string;
  model: string;
  speakerCount: number;
  wordCount: number;
  sourceName: string | null;
}

export interface Session extends SessionMeta {
  segments: TranscriptSegment[];
  audioBlob: Blob | null;
  audioMime: string | null;
  /** Downsampled waveform heights in 0..1 for the player. */
  peaks?: number[];
  /** Custom per-speaker display names, keyed by 0-based speaker index. */
  speakerNames?: Record<string, string>;
}

export interface Settings {
  model: ModelId;
  language: string;
  device: DevicePreference;
  denoise: boolean;
  denoiseQuality: DenoiseQuality;
  diarize: boolean;
  diarizeQuality: DiarizationQuality;
  diarizeEngine: DiarizationEngine;
  maxSpeakers: number;
  theme: ThemePreference;
  textSize: TextSize;
}

export type Stage =
  | 'idle'
  | 'load'
  | 'decode'
  | 'denoise'
  | 'vad'
  | 'transcribe'
  | 'diarize'
  | 'save'
  | 'done'
  | 'error';

export interface ProgressUpdate {
  stage: Stage;
  /** 0..1 for the current stage. */
  progress: number;
  message: string;
  detail?: string;
  /** Seconds of source audio fully processed, when known. */
  processed?: number;
  /** Total source duration in seconds, when known. */
  duration?: number;
}

/** One speaker-embedding sample used to cluster voices after transcription. */
export interface DiarWindow {
  start: number;
  end: number;
  embedding: Float32Array;
}

/**
 * A transcription checkpoint. Written after every audio chunk so a multi-hour
 * job can survive a tab reload or a crash.
 */
export interface JobState {
  id: string;
  title: string;
  sourceName: string | null;
  createdAt: number;
  updatedAt: number;
  status: 'running' | 'paused' | 'error';
  duration: number;
  /** Seconds of audio already transcribed. */
  processed: number;
  language: string;
  settings: Settings;
  segments: TranscriptSegment[];
  speech: Array<{ start: number; end: number }>;
  windows: DiarWindow[];
  peaks: number[];
  audioMime: string | null;
  error?: string;
}

export interface JobRecord extends JobState {
  audioBlob: Blob | null;
}

export interface WorkerModelProgress {
  status: 'initiate' | 'download' | 'progress' | 'done' | 'ready';
  file?: string;
  name?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

export interface RawAsrChunk {
  text: string;
  start: number;
  end: number;
  confidence: number | null;
}

export interface TranscribeRequest {
  type: 'transcribe';
  id: string;
  audio: Float32Array;
  sampleRate: number;
  language: string;
  model: ModelId;
  device: DevicePreference;
  timestamps: boolean;
}

export interface LoadRequest {
  type: 'load';
  id: string;
  model: ModelId;
  device: DevicePreference;
}

export type WorkerRequest = TranscribeRequest | LoadRequest;

export type WorkerResponse =
  | { type: 'model-progress'; id: string; progress: WorkerModelProgress }
  | { type: 'stage'; id: string; stage: 'load' | 'transcribe'; progress: number; message: string }
  | { type: 'result'; id: string; chunks: RawAsrChunk[]; text: string; language: string; duration: number }
  | { type: 'ready'; id: string; model: string; device: string }
  | { type: 'error'; id: string; message: string; code?: string };
