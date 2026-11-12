import { describe, expect, it } from 'vitest';
import { diarize, extractMfcc, type TimeWindow } from '../src/lib/audio/diarize';

const SAMPLE_RATE = 16000;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface VoiceOptions {
  formant?: number;
  noiseSeed?: number;
  duration?: number;
}

/**
 * Synthesize a deterministic harmonic "voice" with a formant emphasis and a
 * smooth amplitude envelope. Harmonics are phase-locked at the segment start.
 */
function synthesizeVoice(fundamental: number, options: VoiceOptions = {}): Float32Array {
  const formant = options.formant ?? 800;
  const duration = options.duration ?? 0.8;
  const noiseSeed = options.noiseSeed ?? 1;
  const length = Math.round(duration * SAMPLE_RATE);
  const out = new Float32Array(length);
  const rng = mulberry32(noiseSeed);

  const harmonicPhases: number[] = [];
  for (let h = 1; h <= 24; h++) harmonicPhases.push(rng() * Math.PI * 2);

  let peak = 0;
  for (let i = 0; i < length; i++) {
    const t = i / SAMPLE_RATE;
    // Smooth, speech-like envelope that tapers to zero at both ends.
    const envelope = Math.sin((Math.PI * t) / duration) ** 2;

    let value = 0;
    for (let h = 1; h <= 24; h++) {
      const frequency = fundamental * h;
      if (frequency >= SAMPLE_RATE / 2) break;
      const resonance = 1 + 2.5 * Math.exp(-((frequency - formant) ** 2) / (2 * 220 ** 2));
      value += (resonance / h) * Math.sin(2 * Math.PI * frequency * t + harmonicPhases[h - 1]);
    }

    value *= 0.22 * envelope;
    value += 0.004 * (rng() * 2 - 1);
    out[i] = value;
    const magnitude = Math.abs(value);
    if (magnitude > peak) peak = magnitude;
  }

  // Keep all voices in a comparable, clip-free amplitude range.
  if (peak > 0) {
    const scale = 0.55 / peak;
    for (let i = 0; i < length; i++) out[i] *= scale;
  }

  return out;
}

function concatenate(segments: Float32Array[]): Float32Array {
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const segment of segments) {
    out.set(segment, offset);
    offset += segment.length;
  }
  return out;
}

function sequentialWindows(count: number, duration: number): TimeWindow[] {
  return Array.from({ length: count }, (_, i) => ({
    start: i * duration,
    end: (i + 1) * duration,
  }));
}

describe('extractMfcc', () => {
  it('returns one 13-coefficient row per active frame with finite values', () => {
    const length = SAMPLE_RATE; // 1 s
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      samples[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
    }

    const mfcc = extractMfcc(samples, SAMPLE_RATE);

    // 25 ms frames, 10 ms hop => 1 + floor((16000 - 400) / 160) = 98 frames.
    expect(mfcc).toHaveLength(98);
    for (const frame of mfcc) {
      expect(frame).toBeInstanceOf(Float32Array);
      expect(frame).toHaveLength(13);
      for (const value of frame) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('ignores near-silent frames', () => {
    const silence = new Float32Array(SAMPLE_RATE / 2);
    expect(extractMfcc(silence, SAMPLE_RATE)).toHaveLength(0);

    const samples = new Float32Array(SAMPLE_RATE);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
    }
    // Half the signal is silent.
    for (let i = 0; i < samples.length / 2; i++) samples[i] = 0;
    const frames = extractMfcc(samples, SAMPLE_RATE);
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.length).toBeLessThan(98);
  });
});

describe('diarize', () => {
  it('separates two alternating harmonic voices', () => {
    const duration = 0.8;
    const voiceA = synthesizeVoice(120, { formant: 700, noiseSeed: 11, duration });
    const voiceB = synthesizeVoice(240, { formant: 1500, noiseSeed: 29, duration });

    const segments = [voiceA, voiceB, voiceA, voiceB, voiceA, voiceB];
    const samples = concatenate(segments);
    const windows = sequentialWindows(segments.length, duration);

    const result = diarize(samples, SAMPLE_RATE, windows);

    expect(result.labels).toHaveLength(6);
    expect(result.speakerCount).toBe(2);
    expect(result.labels[0]).not.toBe(result.labels[1]);
    for (let i = 0; i < result.labels.length; i++) {
      expect(result.labels[i]).toBe(result.labels[i % 2]);
    }
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('returns a single speaker for repeated windows of one voice', () => {
    const duration = 0.8;
    const segments = Array.from({ length: 5 }, (_, i) =>
      synthesizeVoice(120, { formant: 700, noiseSeed: 100 + i, duration }),
    );
    const samples = concatenate(segments);
    const windows = sequentialWindows(segments.length, duration);

    const result = diarize(samples, SAMPLE_RATE, windows);

    expect(result.speakerCount).toBe(1);
    expect(result.labels).toEqual(new Array(segments.length).fill(0));
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('handles empty input and single-window input', () => {
    const empty = diarize(new Float32Array(0), SAMPLE_RATE, []);
    expect(empty.labels).toEqual([]);
    expect(empty.speakerCount).toBe(0);
    expect(empty.confidence).toBe(0);

    const voice = synthesizeVoice(150, { formant: 900, duration: 0.8 });
    const single = diarize(voice, SAMPLE_RATE, [{ start: 0, end: 0.8 }]);
    expect(single.speakerCount).toBe(1);
    expect(single.labels).toEqual([0]);
  });
});
