import { decodeToMono16k } from './decode';
import { encodeWav, highPass, rms, spectralDenoise } from './dsp';

/**
 * Audio repair chain for rough lecture recordings.
 *
 * The goal is to make a distant, noisy or boomy recording sound closer and
 * clearer before Whisper sees it: denoise the grain, cut the room boom, lift
 * speech presence, then even out the level so a quiet far-field capture is as
 * loud and intelligible as a phone held to the mouth.
 *
 * Everything here is plain float DSP on mono samples, so it is deterministic,
 * works on desktop and Android alike, and is unit-testable.
 */

export type RepairPresetId = 'off' | 'clean' | 'clear' | 'far';

export interface RepairOptions {
  /** Rumble/handling-noise cutoff in Hz; 0 disables. */
  highPassHz: number;
  /** Spectral-denoise strength; 0 disables. */
  denoiseStrength: number;
  /** Low-mid cut at 250 Hz in dB (<= 0) to remove room boom. */
  boomCutDb: number;
  /** Presence lift at 3 kHz in dB. */
  presenceDb: number;
  /** Air shelf at 6 kHz in dB. */
  airDb: number;
  /** Whether to even out the level (makes far audio sound present). */
  compress: boolean;
  /** Compressor threshold in dBFS. */
  thresholdDb: number;
  /** Compressor ratio above the threshold. */
  ratio: number;
  /** Whether to normalise the overall loudness. */
  normalise: boolean;
  /** Target RMS loudness in dBFS. */
  targetRmsDb: number;
}

export const REPAIR_PRESETS: Record<RepairPresetId, RepairOptions> = {
  off: {
    highPassHz: 0,
    denoiseStrength: 0,
    boomCutDb: 0,
    presenceDb: 0,
    airDb: 0,
    compress: false,
    thresholdDb: -24,
    ratio: 3,
    normalise: false,
    targetRmsDb: -20,
  },
  clean: {
    highPassHz: 80,
    denoiseStrength: 1.2,
    boomCutDb: -3,
    presenceDb: 2,
    airDb: 1,
    compress: false,
    thresholdDb: -24,
    ratio: 3,
    normalise: true,
    targetRmsDb: -22,
  },
  clear: {
    highPassHz: 90,
    denoiseStrength: 2,
    boomCutDb: -5,
    presenceDb: 4,
    airDb: 2,
    compress: true,
    thresholdDb: -26,
    ratio: 3,
    normalise: true,
    targetRmsDb: -20,
  },
  far: {
    highPassHz: 100,
    denoiseStrength: 2.4,
    boomCutDb: -6,
    presenceDb: 5,
    airDb: 2.5,
    compress: true,
    thresholdDb: -30,
    ratio: 4,
    normalise: true,
    targetRmsDb: -18,
  },
};

const MAX_GAIN_DB = 30;
const PEAK_CEILING = 0.98;

/** RBJ peaking EQ (boost or cut around a centre frequency). */
export function peakingEq(
  input: Float32Array,
  sampleRate: number,
  frequencyHz: number,
  q: number,
  gainDb: number,
): Float32Array {
  if (input.length === 0 || gainDb === 0 || frequencyHz <= 0 || sampleRate <= 0) {
    return new Float32Array(input);
  }
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * frequencyHz) / sampleRate;
  const alpha = Math.sin(w0) / (2 * Math.max(0.0001, q));
  const cos = Math.cos(w0);

  const b0 = 1 + alpha * A;
  const b1 = -2 * cos;
  const b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A;
  const a1 = -2 * cos;
  const a2 = 1 - alpha / A;

  return biquad(input, b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
}

/** RBJ high-shelf EQ (treble lift or cut). */
export function highShelf(
  input: Float32Array,
  sampleRate: number,
  frequencyHz: number,
  gainDb: number,
): Float32Array {
  if (input.length === 0 || gainDb === 0 || frequencyHz <= 0 || sampleRate <= 0) {
    return new Float32Array(input);
  }
  const A = Math.pow(10, gainDb / 40);
  const w0 = (2 * Math.PI * frequencyHz) / sampleRate;
  const cos = Math.cos(w0);
  const alpha = (Math.sin(w0) / 2) * Math.SQRT2;
  const beta = 2 * Math.sqrt(A) * alpha;

  const b0 = A * (A + 1 + (A - 1) * cos + beta);
  const b1 = -2 * A * (A - 1 + (A + 1) * cos);
  const b2 = A * (A + 1 + (A - 1) * cos - beta);
  const a0 = A + 1 - (A - 1) * cos + beta;
  const a1 = 2 * (A - 1 - (A + 1) * cos);
  const a2 = A + 1 - (A - 1) * cos - beta;

  return biquad(input, b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0);
}

function biquad(
  input: Float32Array,
  b0: number,
  b1: number,
  b2: number,
  a1: number,
  a2: number,
): Float32Array {
  const output = new Float32Array(input.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x0 = input[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    output[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return output;
}

/**
 * Gentle compressor: quiet syllables come up, loud ones stop dominating. This
 * is what makes a far-field recording feel "near" instead of distant.
 */
export function compress(
  input: Float32Array,
  sampleRate: number,
  thresholdDb: number,
  ratio: number,
  attackMs = 5,
  releaseMs = 120,
): Float32Array {
  if (input.length === 0 || ratio <= 1 || sampleRate <= 0) {
    return new Float32Array(input);
  }
  const threshold = Math.pow(10, thresholdDb / 20);
  const attack = Math.exp(-1 / ((attackMs / 1000) * sampleRate));
  const release = Math.exp(-1 / ((releaseMs / 1000) * sampleRate));
  const slope = 1 - 1 / ratio;

  const output = new Float32Array(input.length);
  let envelope = 0;
  for (let i = 0; i < input.length; i += 1) {
    const sample = input[i];
    const magnitude = Math.abs(sample);
    envelope = magnitude > envelope ? attack * envelope + (1 - attack) * magnitude : release * envelope + (1 - release) * magnitude;

    let gain = 1;
    if (envelope > threshold && envelope > 0) {
      const overDb = 20 * Math.log10(envelope / threshold);
      gain = Math.pow(10, (-overDb * slope) / 20);
    }
    output[i] = sample * gain;
  }
  return output;
}

/** Raise (or lower) the overall level to a target RMS, then guard the peaks. */
export function normaliseRms(
  input: Float32Array,
  targetDb: number,
  maxGainDb = MAX_GAIN_DB,
): Float32Array {
  const output = new Float32Array(input);
  if (input.length === 0) return output;

  const current = rms(input);
  if (current <= 1e-7) return output;

  const gainDb = Math.min(maxGainDb, targetDb - 20 * Math.log10(current));
  const gain = Math.pow(10, gainDb / 20);
  let highest = 0;
  for (let i = 0; i < output.length; i += 1) {
    const value = output[i] * gain;
    output[i] = value;
    const magnitude = Math.abs(value);
    if (magnitude > highest) highest = magnitude;
  }
  if (highest > PEAK_CEILING) {
    const scale = PEAK_CEILING / highest;
    for (let i = 0; i < output.length; i += 1) output[i] *= scale;
  }
  return output;
}

/**
 * Run the repair chain. The order matters: clean first, then shape the tone,
 * then even out and level the result.
 */
export function repairSamples(
  input: Float32Array,
  sampleRate: number,
  options: RepairOptions,
): Float32Array {
  if (input.length === 0) return new Float32Array(0);

  let samples: Float32Array = new Float32Array(input);

  if (options.highPassHz > 0) {
    samples = highPass(samples, sampleRate, options.highPassHz);
  }
  if (options.denoiseStrength > 0) {
    samples = spectralDenoise(samples, sampleRate, { strength: options.denoiseStrength });
  }
  if (options.boomCutDb < 0) {
    samples = peakingEq(samples, sampleRate, 250, 1, options.boomCutDb);
  }
  if (options.presenceDb > 0) {
    samples = peakingEq(samples, sampleRate, 3000, 1.1, options.presenceDb);
  }
  if (options.airDb > 0) {
    samples = highShelf(samples, sampleRate, 6000, options.airDb);
  }
  if (options.compress) {
    samples = compress(samples, sampleRate, options.thresholdDb, options.ratio);
  }
  if (options.normalise) {
    samples = normaliseRms(samples, options.targetRmsDb);
  } else {
    samples = limitPeak(samples);
  }
  return samples;
}

/** Peak-limit without touching the level unless it clips. */
export function limitPeak(input: Float32Array, ceiling = PEAK_CEILING): Float32Array {
  let highest = 0;
  for (let i = 0; i < input.length; i += 1) {
    const magnitude = Math.abs(input[i]);
    if (magnitude > highest) highest = magnitude;
  }
  if (highest <= ceiling || highest === 0) return new Float32Array(input);
  const scale = ceiling / highest;
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i += 1) output[i] = input[i] * scale;
  return output;
}

/**
 * Decode a file, repair it, and return a 16 kHz WAV ready for Whisper. The
 * sample rate matches what transcription uses, so nothing is resampled twice.
 */
export async function repairAudio(
  source: Blob,
  preset: RepairPresetId,
): Promise<{ blob: Blob; duration: number }> {
  const { samples, sampleRate } = await decodeToMono16k(source);
  const repaired = repairSamples(samples, sampleRate, REPAIR_PRESETS[preset]);
  return { blob: encodeWav(repaired, sampleRate), duration: repaired.length / sampleRate };
}
