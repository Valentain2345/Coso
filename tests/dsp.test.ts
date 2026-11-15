import { describe, expect, test } from 'vitest';
import {
  concatFloat32,
  deEsser,
  detectSpeechSegments,
  encodeWav,
  encodeWavBytes,
  goertzelPower,
  highPass,
  noiseGate,
  normalizePeak,
  peak,
  resample,
  rms,
  sliceSamples,
  spectralDenoise,
  toMono,
} from '../src/lib/audio/dsp';

const SAMPLE_RATE = 16000;

function makeSine(
  frequency: number,
  sampleRate: number,
  seconds: number,
  amplitude = 0.5,
): Float32Array {
  const length = Math.round(sampleRate * seconds);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    out[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate);
  }
  return out;
}

function countPositiveZeroCrossings(signal: Float32Array): number {
  let count = 0;
  for (let i = 1; i < signal.length; i++) {
    if (signal[i - 1] <= 0 && signal[i] > 0) {
      count++;
    }
  }
  return count;
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let text = '';
  for (let i = 0; i < length; i++) {
    text += String.fromCharCode(bytes[offset + i]);
  }
  return text;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('toMono', () => {
  test('averages equal-length stereo channels', () => {
    const left = new Float32Array([1, 2, 3, -4]);
    const right = new Float32Array([3, 4, 5, 8]);
    expect(Array.from(toMono([left, right]))).toEqual([2, 3, 4, 2]);
  });

  test('handles empty and single-channel input', () => {
    expect(toMono([]).length).toBe(0);
    const solo = new Float32Array([0.25, -0.5]);
    const mono = toMono([solo]);
    expect(Array.from(mono)).toEqual([0.25, -0.5]);
    expect(mono).not.toBe(solo);
  });

  test('treats missing samples in shorter channels as silence', () => {
    const long = new Float32Array([2, 2, 2, 2]);
    const short = new Float32Array([0, 0]);
    expect(Array.from(toMono([long, short]))).toEqual([1, 1, 1, 1]);
  });
});

describe('resample', () => {
  test('returns the exact requested output length', () => {
    const input = makeSine(1000, 48000, 0.25);
    const output = resample(input, 48000, 16000);
    expect(output.length).toBe(Math.round((input.length * 16000) / 48000));
    expect(output.length).toBe(4000);
  });

  test('preserves a 1 kHz sine frequency', () => {
    const input = makeSine(1000, 48000, 0.25);
    const output = resample(input, 48000, 16000);
    const crossings = countPositiveZeroCrossings(output);
    // 1 kHz over 0.25 s -> roughly 250 cycles.
    expect(Math.abs(crossings - 250)).toBeLessThanOrEqual(2);
  });

  test('preserves a 1 kHz sine frequency when upsampling', () => {
    const input = makeSine(1000, 16000, 0.25);
    const output = resample(input, 16000, 48000);
    expect(output.length).toBe(12000);
    const crossings = countPositiveZeroCrossings(output);
    expect(Math.abs(crossings - 250)).toBeLessThanOrEqual(2);
  });

  test('copies when rates are equal and guards invalid input', () => {
    const input = makeSine(440, 16000, 0.05);
    const copy = resample(input, 16000, 16000);
    expect(Array.from(copy)).toEqual(Array.from(input));
    expect(copy).not.toBe(input);

    expect(resample(new Float32Array(0), 16000, 8000).length).toBe(0);
    expect(Array.from(resample(input, 0, 8000))).toEqual(Array.from(input));
    expect(Array.from(resample(input, 16000, Number.NaN))).toEqual(
      Array.from(input),
    );
  });
});

describe('highPass', () => {
  test('removes DC while preserving length', () => {
    const input = new Float32Array(48000);
    input.fill(1);
    const output = highPass(input, 48000, 80);

    expect(output.length).toBe(input.length);
    expect(Math.abs(rms(output, 24000, 48000))).toBeLessThan(1e-4);
  });

  test('leaves audio above the cutoff mostly intact', () => {
    const input = makeSine(1000, 48000, 0.5, 0.5);
    const output = highPass(input, 48000, 80);
    // Compare the steady-state region to avoid the filter start-up transient.
    const before = rms(input, 4800, 24000);
    const after = rms(output, 4800, 24000);
    expect(after).toBeGreaterThan(before * 0.95);
  });

  test('guards empty input and invalid rates', () => {
    expect(highPass(new Float32Array(0), 16000).length).toBe(0);
    const input = new Float32Array([0.5, -0.5]);
    expect(Array.from(highPass(input, 0))).toEqual([0.5, -0.5]);
  });
});

describe('normalizePeak', () => {
  test('normalises to the requested peak', () => {
    const input = new Float32Array([0.25, -0.5, 0.125]);
    const output = normalizePeak(input, 1);
    expect(peak(output)).toBeCloseTo(1, 6);
  });

  test('clamps amplification to maxGainDb', () => {
    const input = new Float32Array(100);
    input[42] = 0.001;
    const output = normalizePeak(input, 1, 24);
    const maxGain = Math.pow(10, 24 / 20);
    expect(peak(output)).toBeCloseTo(0.001 * maxGain, 6);
    expect(peak(output)).toBeLessThan(1);
  });

  test('never amplifies silence and keeps input immutable', () => {
    const silent = new Float32Array(64);
    const output = normalizePeak(silent);
    expect(peak(output)).toBe(0);
    expect(output).not.toBe(silent);

    const input = new Float32Array([0.1, -0.2]);
    normalizePeak(input, 1);
    expect(input[0]).toBeCloseTo(0.1, 7);
    expect(input[1]).toBeCloseTo(-0.2, 7);
  });
});

describe('spectralDenoise', () => {
  test('preserves length, finiteness and reduces the noise floor', () => {
    const seconds = 1.6;
    const length = Math.round(SAMPLE_RATE * seconds);
    const input = new Float32Array(length);
    const random = createSeededRandom(0x12345678);

    // Broadband noise everywhere.
    for (let i = 0; i < length; i++) {
      input[i] = (random() * 2 - 1) * 0.08;
    }
    // A prominent tone burst in the middle.
    const burstStart = Math.floor(SAMPLE_RATE * 0.5);
    const burstEnd = Math.floor(SAMPLE_RATE * 1.0);
    for (let i = burstStart; i < burstEnd; i++) {
      input[i] += 0.4 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
    }

    const output = spectralDenoise(input, SAMPLE_RATE);

    expect(output.length).toBe(input.length);
    expect(output.every((value) => Number.isFinite(value))).toBe(true);

    // Compare a noise-only window away from the tone burst and edge effects.
    const from = Math.floor(SAMPLE_RATE * 0.08);
    const to = Math.floor(SAMPLE_RATE * 0.42);
    const before = rms(input, from, to);
    const after = rms(output, from, to);
    expect(after).toBeLessThan(before * 0.9);
  });

  test('returns a finite normalised copy for input shorter than a window', () => {
    const input = new Float32Array([0.1, -0.2, 0.05]);
    const output = spectralDenoise(input, SAMPLE_RATE);
    expect(output.length).toBe(input.length);
    expect(peak(output)).toBeCloseTo(1, 6);
    expect(output.every((value) => Number.isFinite(value))).toBe(true);
  });

  test('handles empty and digital-silence input', () => {
    expect(spectralDenoise(new Float32Array(0), SAMPLE_RATE).length).toBe(0);
    const silent = new Float32Array(4096);
    const output = spectralDenoise(silent, SAMPLE_RATE);
    expect(output.length).toBe(silent.length);
    expect(peak(output)).toBe(0);
  });
});

describe('detectSpeechSegments', () => {
  test('detects two tone bursts and ignores silence', () => {
    const seconds = 3;
    const input = new Float32Array(Math.round(SAMPLE_RATE * seconds));

    const tone = (start: number, end: number, frequency: number) => {
      const first = Math.floor(start * SAMPLE_RATE);
      const last = Math.floor(end * SAMPLE_RATE);
      for (let i = first; i < last; i++) {
        input[i] = 0.4 * Math.sin((2 * Math.PI * frequency * i) / SAMPLE_RATE);
      }
    };
    tone(0.5, 1.0, 440);
    tone(1.8, 2.3, 660);

    const segments = detectSpeechSegments(input, SAMPLE_RATE, { pad: 0 });

    expect(segments).toHaveLength(2);
    expect(Math.abs(segments[0].start - 0.5)).toBeLessThan(0.15);
    expect(Math.abs(segments[0].end - 1.0)).toBeLessThan(0.15);
    expect(Math.abs(segments[1].start - 1.8)).toBeLessThan(0.15);
    expect(Math.abs(segments[1].end - 2.3)).toBeLessThan(0.15);

    // No segment should cover the silent gap between the bursts.
    const gap = segments[0].end;
    expect(segments[1].start).toBeGreaterThan(gap);
  });

  test('applies padding and merges gaps shorter than minSilence', () => {
    const seconds = 2;
    const input = new Float32Array(Math.round(SAMPLE_RATE * seconds));
    const tone = (start: number, end: number) => {
      for (let i = Math.floor(start * SAMPLE_RATE); i < end * SAMPLE_RATE; i++) {
        input[i] = 0.4 * Math.sin((2 * Math.PI * 500 * i) / SAMPLE_RATE);
      }
    };
    // Gap of 0.1 s is shorter than minSilence (0.35 s).
    tone(0.5, 0.9);
    tone(1.0, 1.4);

    const merged = detectSpeechSegments(input, SAMPLE_RATE, {
      pad: 0,
      minSilence: 0.35,
    });
    expect(merged).toHaveLength(1);
    expect(Math.abs(merged[0].start - 0.5)).toBeLessThan(0.1);
    expect(Math.abs(merged[0].end - 1.4)).toBeLessThan(0.1);

    const padded = detectSpeechSegments(input, SAMPLE_RATE, {
      pad: 0.2,
      minSilence: 0.35,
    });
    expect(padded).toHaveLength(1);
    expect(padded[0].start).toBeLessThanOrEqual(0.31);
    expect(padded[0].end).toBeGreaterThanOrEqual(1.59);
  });

  test('discards segments shorter than minSpeech', () => {
    const input = new Float32Array(Math.round(SAMPLE_RATE * 1.5));
    const first = Math.floor(0.4 * SAMPLE_RATE);
    const last = Math.floor(0.5 * SAMPLE_RATE);
    for (let i = first; i < last; i++) {
      input[i] = 0.4 * Math.sin((2 * Math.PI * 500 * i) / SAMPLE_RATE);
    }

    expect(detectSpeechSegments(input, SAMPLE_RATE, { pad: 0 })).toHaveLength(0);
  });

  test('splits long segments at a low-energy boundary', () => {
    const seconds = 6;
    const input = new Float32Array(Math.round(SAMPLE_RATE * seconds));
    // Long tone with silent lead-in/lead-out and an intentional quiet notch
    // around 2.5 s. The silence also gives the VAD a noise-floor estimate.
    for (let i = 0; i < input.length; i++) {
      const time = i / SAMPLE_RATE;
      const silent = time < 0.5 || time > 5.5;
      const quiet = time > 2.45 && time < 2.55;
      input[i] =
        silent || quiet
          ? 0
          : 0.4 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
    }

    const segments = detectSpeechSegments(input, SAMPLE_RATE, {
      pad: 0,
      minSpeech: 0.1,
      maxSegment: 2.5,
    });

    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const segment of segments) {
      expect(segment.end - segment.start).toBeLessThanOrEqual(2.5 + 1e-6);
    }
    expect(segments.some((s) => Math.abs(s.start - 2.5) < 0.2)).toBe(true);
  });

  test('returns an empty list for empty or silent input', () => {
    expect(detectSpeechSegments(new Float32Array(0), SAMPLE_RATE)).toEqual([]);
    expect(
      detectSpeechSegments(new Float32Array(SAMPLE_RATE), SAMPLE_RATE),
    ).toEqual([]);
    expect(detectSpeechSegments(new Float32Array(10), 0)).toEqual([]);
  });
});

describe('WAV encoding', () => {
  test('writes a valid 16-bit PCM mono RIFF/WAVE header and data', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1, 1.5, -1.5]);
    const bytes = encodeWavBytes(samples, SAMPLE_RATE);
    const expectedDataSize = samples.length * 2;

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(44 + expectedDataSize);
    expect(ascii(bytes, 0, 4)).toBe('RIFF');
    expect(ascii(bytes, 8, 4)).toBe('WAVE');
    expect(ascii(bytes, 12, 4)).toBe('fmt ');
    expect(ascii(bytes, 36, 4)).toBe('data');

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(4, true)).toBe(36 + expectedDataSize);
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(SAMPLE_RATE);
    expect(view.getUint32(28, true)).toBe(SAMPLE_RATE * 2);
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(expectedDataSize);

    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(16384);
    expect(view.getInt16(48, true)).toBe(-16384);
    expect(view.getInt16(50, true)).toBe(32767);
    expect(view.getInt16(52, true)).toBe(-32768);
    expect(view.getInt16(54, true)).toBe(32767);
    expect(view.getInt16(56, true)).toBe(-32768);
  });

  test('encodeWav wraps the bytes in an audio/wav Blob', () => {
    const samples = new Float32Array(10);
    const bytes = encodeWavBytes(samples, SAMPLE_RATE);
    const blob = encodeWav(samples, SAMPLE_RATE);
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBe(bytes.length);
  });
});

describe('array helpers', () => {
  test('concatFloat32 concatenates chunks into a new array', () => {
    const first = new Float32Array([1, 2]);
    const second = new Float32Array([3, -4, 5]);
    const result = concatFloat32([first, new Float32Array(0), second]);
    expect(Array.from(result)).toEqual([1, 2, 3, -4, 5]);
    expect(result.length).toBe(5);
    expect(concatFloat32([]).length).toBe(0);
  });

  test('sliceSamples clamps to bounds and copies', () => {
    const input = new Float32Array([10, 20, 30, 40, 50]);
    expect(Array.from(sliceSamples(input, 1, 4))).toEqual([20, 30, 40]);
    expect(Array.from(sliceSamples(input, -10, 2))).toEqual([10, 20]);
    expect(Array.from(sliceSamples(input, 3, 99))).toEqual([40, 50]);
    expect(sliceSamples(input, 4, 2).length).toBe(0);

    const sliced = sliceSamples(input, 1, 3);
    sliced[0] = 999;
    expect(input[1]).toBe(20);
  });

  test('rms and peak calculate expected values', () => {
    const input = new Float32Array([3, 4, -1, 2]);
    expect(rms(input)).toBeCloseTo(Math.sqrt((9 + 16 + 1 + 4) / 4), 10);
    expect(rms(input, 0, 2)).toBeCloseTo(Math.sqrt(25 / 2), 10);
    expect(rms(input, 3, 3)).toBe(0);
    expect(rms(new Float32Array(0))).toBe(0);
    expect(peak(input)).toBe(4);
    expect(peak(new Float32Array(0))).toBe(0);
  });
});

/* ------------------------------------------------------------ goertzelPower */

describe('goertzelPower', () => {
  test('measures a pure tone and ignores a distant frequency', () => {
    const tone = makeSine(440, SAMPLE_RATE, 2, 0.5);
    const onTone = goertzelPower(tone, SAMPLE_RATE, 440);
    const offTone = goertzelPower(tone, SAMPLE_RATE, 600);

    // A sine of amplitude A has A² / 4 of power in its own bin.
    expect(onTone).toBeCloseTo(0.0625, 2);
    expect(offTone).toBeLessThan(onTone * 1e-3);
  });

  test('rejects invalid frequencies and empty input', () => {
    const tone = makeSine(440, SAMPLE_RATE, 0.5);
    expect(goertzelPower(tone, SAMPLE_RATE, 0)).toBe(0);
    expect(goertzelPower(tone, SAMPLE_RATE, SAMPLE_RATE / 2)).toBe(0);
    expect(goertzelPower(tone, 0, 440)).toBe(0);
    expect(goertzelPower(new Float32Array(0), SAMPLE_RATE, 440)).toBe(0);
  });
});

/* ------------------------------------------------------------------ deEsser */

describe('deEsser', () => {
  test('turns down a loud sibilant band and keeps the vowel body', () => {
    const length = SAMPLE_RATE * 2;
    const input = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const t = i / SAMPLE_RATE;
      input[i] = 0.3 * Math.sin(2 * Math.PI * 200 * t) + 0.3 * Math.sin(2 * Math.PI * 6500 * t);
    }

    const output = deEsser(input, SAMPLE_RATE, { maxReductionDb: 6 });
    const highBefore = rms(highPass(input, SAMPLE_RATE, 4500), SAMPLE_RATE / 2, length);
    const highAfter = rms(highPass(output, SAMPLE_RATE, 4500), SAMPLE_RATE / 2, length);
    expect(highAfter).toBeLessThan(highBefore * 0.8);

    // The 200 Hz body is untouched within 2 %.
    const bodyBefore = goertzelPower(input.subarray(SAMPLE_RATE), SAMPLE_RATE, 200);
    const bodyAfter = goertzelPower(output.subarray(SAMPLE_RATE), SAMPLE_RATE, 200);
    expect(bodyAfter / bodyBefore).toBeGreaterThan(0.98);
    expect(bodyAfter / bodyBefore).toBeLessThan(1.02);
  });

  test('passes audio through when the high band is quiet', () => {
    const length = SAMPLE_RATE;
    const input = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const t = i / SAMPLE_RATE;
      input[i] = 0.4 * Math.sin(2 * Math.PI * 200 * t) + 0.005 * Math.sin(2 * Math.PI * 6500 * t);
    }
    const output = deEsser(input, SAMPLE_RATE, { maxReductionDb: 6 });
    let largestDifference = 0;
    for (let i = 0; i < length; i += 1) {
      largestDifference = Math.max(largestDifference, Math.abs(output[i] - input[i]));
    }
    expect(largestDifference).toBeLessThan(1e-6);
  });

  test('is a passthrough for zero reduction and empty input', () => {
    const input = makeSine(6500, SAMPLE_RATE, 0.25, 0.2);
    expect(Array.from(deEsser(input, SAMPLE_RATE, { maxReductionDb: 0 }))).toEqual(
      Array.from(input),
    );
    expect(deEsser(new Float32Array(0), SAMPLE_RATE).length).toBe(0);
  });
});

/* ----------------------------------------------------------------- noiseGate */

describe('noiseGate', () => {
  /** Alternating loud and quiet seconds, so the gate has something to close on. */
  function alternating(seconds = 4): Float32Array {
    const out = new Float32Array(SAMPLE_RATE * seconds);
    for (let i = 0; i < out.length; i += 1) {
      const phase = (i / SAMPLE_RATE) % 1;
      const amplitude = phase < 0.5 ? 0.3 : 0.002;
      out[i] = amplitude * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
    }
    return out;
  }

  test('attenuates gaps and leaves speech-level passages alone', () => {
    const input = alternating();
    const output = noiseGate(input, SAMPLE_RATE, { rangeDb: -30, depthDb: 12 });

    const quietBefore = rms(input, Math.round(SAMPLE_RATE * 0.6), Math.round(SAMPLE_RATE * 0.9));
    const quietAfter = rms(output, Math.round(SAMPLE_RATE * 0.6), Math.round(SAMPLE_RATE * 0.9));
    expect(quietAfter).toBeLessThan(quietBefore * 0.4);

    // 1.15 s leaves the release enough time to open after the burst starts.
    const loudBefore = rms(input, Math.round(SAMPLE_RATE * 1.15), Math.round(SAMPLE_RATE * 1.45));
    const loudAfter = rms(output, Math.round(SAMPLE_RATE * 1.15), Math.round(SAMPLE_RATE * 1.45));
    expect(loudAfter / loudBefore).toBeGreaterThan(0.9);
  });

  test('never amplifies and never fully mutes', () => {
    const input = alternating();
    const output = noiseGate(input, SAMPLE_RATE, { rangeDb: -24, depthDb: 40 });
    let highest = 0;
    for (let i = 0; i < output.length; i += 1) {
      highest = Math.max(highest, Math.abs(output[i] / (input[i] || 1)));
    }
    expect(highest).toBeLessThanOrEqual(1 + 1e-6);

    const quietAfter = rms(output, Math.round(SAMPLE_RATE * 0.6), Math.round(SAMPLE_RATE * 0.9));
    expect(quietAfter).toBeGreaterThan(0); // depth is capped in practice, not a hard mute
  });

  test('leaves silence and empty input untouched', () => {
    const silence = new Float32Array(SAMPLE_RATE);
    expect(peak(noiseGate(silence, SAMPLE_RATE))).toBe(0);
    expect(noiseGate(new Float32Array(0), SAMPLE_RATE).length).toBe(0);
  });
});
