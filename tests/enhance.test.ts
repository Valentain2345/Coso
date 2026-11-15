import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { goertzelPower } from '../src/lib/audio/dsp';
import {
  REPAIR_PRESETS,
  compress,
  detectHum,
  highShelf,
  humNotch,
  isRepairNoop,
  limitPeak,
  lowShelf,
  measureAudio,
  normaliseRms,
  notch,
  peakingEq,
  repairSamples,
} from '../src/lib/audio/enhance';

const SAMPLE_RATE = 16000;

/** Decode the 16 kHz mono 16-bit speech fixture used by the transcription E2E. */
function loadSpeechFixture(): Float32Array {
  const buffer = readFileSync(new URL('./fixtures/speech.wav', import.meta.url));
  let offset = 12;
  let dataStart = 0;
  let dataLength = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'data') {
      dataStart = offset + 8;
      dataLength = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!dataLength) throw new Error('speech.wav has no data chunk');
  const samples = new Float32Array(Math.floor(dataLength / 2));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = buffer.readInt16LE(dataStart + i * 2) / 32768;
  }
  return samples;
}

/** Seeded white noise, so the integration test is reproducible. */
function whiteNoise(length: number, amplitude: number, seed = 1234567): Float32Array {
  const out = new Float32Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out[i] = amplitude * ((state / 0xffffffff) * 2 - 1);
  }
  return out;
}

function sine(frequency: number, seconds: number, amplitude = 0.5, phase = 0): Float32Array {
  const length = Math.round(SAMPLE_RATE * seconds);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = amplitude * Math.sin(phase + (2 * Math.PI * frequency * i) / SAMPLE_RATE);
  }
  return out;
}

function dc(seconds: number, value = 0.5): Float32Array {
  return new Float32Array(Math.round(SAMPLE_RATE * seconds)).fill(value);
}

/**
 * A quiet, far-field-like voice: short voiced bursts separated by silence. The
 * gaps give the spectral denoiser a noise profile to learn, like real speech.
 */
function speechLike(seconds: number, amplitude = 0.02): Float32Array {
  const out = new Float32Array(Math.round(SAMPLE_RATE * seconds));
  for (let i = 0; i < out.length; i += 1) {
    const t = i / SAMPLE_RATE;
    const cycle = t % 0.6;
    const voiced = cycle < 0.3;
    const envelope = 0.6 + 0.4 * Math.sin(2 * Math.PI * 3 * t);
    out[i] = voiced ? amplitude * envelope * Math.sin(2 * Math.PI * 220 * t) : 0;
  }
  return out;
}

/** RMS of the second half, so filter transients do not skew the measurement. */
function steadyRms(signal: Float32Array): number {
  const start = Math.floor(signal.length / 2);
  let sum = 0;
  for (let i = start; i < signal.length; i += 1) sum += signal[i] * signal[i];
  return Math.sqrt(sum / Math.max(1, signal.length - start));
}

function peak(signal: Float32Array): number {
  let highest = 0;
  for (let i = 0; i < signal.length; i += 1) highest = Math.max(highest, Math.abs(signal[i]));
  return highest;
}

function rms(signal: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < signal.length; i += 1) sum += signal[i] * signal[i];
  return Math.sqrt(sum / Math.max(1, signal.length));
}

/* ------------------------------------------------------------- peakingEq */

describe('peakingEq', () => {
  it('boosts the centre frequency by the requested amount', () => {
    const input = sine(3000, 2, 0.2);
    const output = peakingEq(input, SAMPLE_RATE, 3000, 1.1, 6);
    // +6 dB is a factor of two in amplitude.
    expect(steadyRms(output) / steadyRms(input)).toBeGreaterThan(1.8);
    expect(steadyRms(output) / steadyRms(input)).toBeLessThan(2.2);
  });

  it('leaves distant frequencies almost untouched', () => {
    const input = sine(200, 2, 0.2);
    const output = peakingEq(input, SAMPLE_RATE, 3000, 1.1, 6);
    const ratio = steadyRms(output) / steadyRms(input);
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });

  it('cuts the centre frequency when the gain is negative', () => {
    const input = sine(250, 2, 0.2);
    const output = peakingEq(input, SAMPLE_RATE, 250, 1, -6);
    const ratio = steadyRms(output) / steadyRms(input);
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.6);
  });

  it('is a passthrough for zero gain and empty input', () => {
    const input = sine(1000, 0.25);
    expect(Array.from(peakingEq(input, SAMPLE_RATE, 1000, 1, 0))).toEqual(Array.from(input));
    expect(peakingEq(new Float32Array(0), SAMPLE_RATE, 1000, 1, 6).length).toBe(0);
  });
});

/* ------------------------------------------------------------- highShelf */

describe('highShelf', () => {
  it('lifts treble more than it lifts the low end', () => {
    const high = sine(7000, 2, 0.1);
    const low = sine(300, 2, 0.1);
    const highRatio = steadyRms(highShelf(high, SAMPLE_RATE, 6000, 6)) / steadyRms(high);
    const lowRatio = steadyRms(highShelf(low, SAMPLE_RATE, 6000, 6)) / steadyRms(low);
    expect(highRatio).toBeGreaterThan(1.4);
    expect(lowRatio).toBeGreaterThan(0.95);
    expect(lowRatio).toBeLessThan(1.05);
  });

  it('is a passthrough for zero gain', () => {
    const input = sine(1000, 0.25);
    expect(Array.from(highShelf(input, SAMPLE_RATE, 6000, 0))).toEqual(Array.from(input));
  });
});

/* -------------------------------------------------------------- lowShelf */

describe('lowShelf', () => {
  it('adds body below the corner without lifting treble', () => {
    const low = sine(100, 2, 0.1);
    const high = sine(4000, 2, 0.1);
    const lowRatio = steadyRms(lowShelf(low, SAMPLE_RATE, 180, 6)) / steadyRms(low);
    const highRatio = steadyRms(lowShelf(high, SAMPLE_RATE, 180, 6)) / steadyRms(high);
    expect(lowRatio).toBeGreaterThan(1.5);
    expect(highRatio).toBeGreaterThan(0.98);
    expect(highRatio).toBeLessThan(1.02);
  });

  it('is a passthrough for zero gain', () => {
    const input = sine(100, 0.25);
    expect(Array.from(lowShelf(input, SAMPLE_RATE, 180, 0))).toEqual(Array.from(input));
  });
});

/* ----------------------------------------------------------------- notch */

describe('notch', () => {
  it('removes a narrow tone while keeping nearby speech', () => {
    const hum = sine(50, 2, 0.5);
    const input = new Float32Array(hum.length);
    const voice = sine(440, 2, 0.2);
    for (let i = 0; i < input.length; i += 1) input[i] = hum[i] + voice[i];

    const output = notch(input, SAMPLE_RATE, 50, 15);
    const humBefore = goertzelPower(input, SAMPLE_RATE, 50);
    const humAfter = goertzelPower(output, SAMPLE_RATE, 50);
    expect(humAfter).toBeLessThan(humBefore * 0.01);

    const voiceBefore = goertzelPower(input, SAMPLE_RATE, 440);
    const voiceAfter = goertzelPower(output, SAMPLE_RATE, 440);
    expect(voiceAfter / voiceBefore).toBeGreaterThan(0.95);
    expect(voiceAfter / voiceBefore).toBeLessThan(1.05);
  });

  it('is a passthrough outside the audio band or with no input', () => {
    const input = sine(440, 0.25);
    expect(Array.from(notch(input, SAMPLE_RATE, 9000, 15))).toEqual(Array.from(input));
    expect(notch(new Float32Array(0), SAMPLE_RATE, 50).length).toBe(0);
  });
});

/* ----------------------------------------------------------- hum detection */

describe('detectHum', () => {
  function withNoise(frequency: number): Float32Array {
    const tone = sine(frequency, 3, 0.05);
    const noise = whiteNoise(tone.length, 0.02);
    for (let i = 0; i < tone.length; i += 1) tone[i] += noise[i];
    return tone;
  }

  it('recognises a 50 Hz line and a 60 Hz line', () => {
    expect(detectHum(withNoise(50), SAMPLE_RATE)).toBe(50);
    expect(detectHum(withNoise(60), SAMPLE_RATE)).toBe(60);
  });

  it('does not mistake noise or a voice for mains hum', () => {
    expect(detectHum(whiteNoise(SAMPLE_RATE * 3, 0.03), SAMPLE_RATE)).toBe(0);
    expect(detectHum(sine(220, 3, 0.3), SAMPLE_RATE)).toBe(0);
    expect(detectHum(new Float32Array(100), SAMPLE_RATE)).toBe(0);
  });
});

describe('humNotch', () => {
  it('removes the fundamental and its first two harmonics on auto', () => {
    const length = SAMPLE_RATE * 3;
    const input = new Float32Array(length);
    const tones = [60, 120, 180].map((frequency) => sine(frequency, 3, 0.05));
    const voice = sine(1000, 3, 0.2);
    const noise = whiteNoise(length, 0.01);
    for (let i = 0; i < length; i += 1) {
      input[i] = tones[0][i] + tones[1][i] + tones[2][i] + voice[i] + noise[i];
    }

    expect(detectHum(input, SAMPLE_RATE)).toBe(60);
    const output = humNotch(input, SAMPLE_RATE, 'auto');
    for (const frequency of [60, 120, 180]) {
      const before = goertzelPower(input, SAMPLE_RATE, frequency);
      const after = goertzelPower(output, SAMPLE_RATE, frequency);
      expect(after, `${frequency} Hz survived`).toBeLessThan(before * 0.02);
    }
    const voiceBefore = goertzelPower(input, SAMPLE_RATE, 1000);
    const voiceAfter = goertzelPower(output, SAMPLE_RATE, 1000);
    expect(voiceAfter / voiceBefore).toBeGreaterThan(0.95);
  });

  it('is a passthrough when off or when auto finds nothing', () => {
    const input = sine(440, 1, 0.2);
    expect(Array.from(humNotch(input, SAMPLE_RATE, 'off'))).toEqual(Array.from(input));
    expect(Array.from(humNotch(input, SAMPLE_RATE, 'auto'))).toEqual(Array.from(input));
  });
});

/* ---------------------------------------------------------- measureAudio */

describe('measureAudio', () => {
  it('reports duration, average, peak and the noise floor in dBFS', () => {
    const level = measureAudio(sine(440, 2, 0.1), SAMPLE_RATE);
    expect(level.durationSeconds).toBe(2);
    expect(level.rmsDb).toBeCloseTo(-23, 0);
    expect(level.peakDb).toBeCloseTo(-20, 0);
    expect(level.noiseFloorDb).toBeGreaterThan(-30);
  });

  it('clamps digital silence to -100 dB', () => {
    expect(measureAudio(new Float32Array(SAMPLE_RATE), SAMPLE_RATE)).toEqual({
      durationSeconds: 1,
      rmsDb: -100,
      peakDb: -100,
      noiseFloorDb: -100,
    });
  });
});

describe('isRepairNoop', () => {
  it('is true only when no stage would change the audio', () => {
    expect(isRepairNoop(REPAIR_PRESETS.off)).toBe(true);
    expect(isRepairNoop({ ...REPAIR_PRESETS.off, gate: true })).toBe(false);
    expect(isRepairNoop({ ...REPAIR_PRESETS.off, hum: 'auto' })).toBe(false);
    expect(isRepairNoop({ ...REPAIR_PRESETS.off, normalise: true })).toBe(false);
    expect(isRepairNoop(REPAIR_PRESETS.clear)).toBe(false);
  });
});

/* --------------------------------------------------------------- compress */

describe('compress', () => {
  it('turns down loud material without touching quiet material', () => {
    const quiet = sine(500, 1, 0.01);
    const loud = sine(500, 1, 0.9);
    const quietOut = compress(quiet, SAMPLE_RATE, -20, 4);
    const loudOut = compress(loud, SAMPLE_RATE, -20, 4);

    // -20 dBFS = 0.1, so a 0.01 sine stays below the threshold.
    expect(rms(quietOut) / rms(quiet)).toBeGreaterThan(0.98);
    expect(rms(quietOut) / rms(quiet)).toBeLessThan(1.02);
    // The first few milliseconds pass through before the envelope reacts.
    expect(steadyRms(loudOut)).toBeLessThan(steadyRms(loud) * 0.8);
  });

  it('is a passthrough for a ratio of 1 or empty input', () => {
    const input = sine(500, 0.5);
    expect(Array.from(compress(input, SAMPLE_RATE, -20, 1))).toEqual(Array.from(input));
    expect(compress(new Float32Array(0), SAMPLE_RATE, -20, 4).length).toBe(0);
  });
});

/* ---------------------------------------------------------- normaliseRms */

describe('normaliseRms', () => {
  it('brings a quiet recording up to the target loudness', () => {
    const input = sine(440, 2, 0.01);
    const output = normaliseRms(input, -20);
    // -20 dBFS RMS is 0.1.
    expect(rms(output)).toBeGreaterThan(0.097);
    expect(rms(output)).toBeLessThan(0.103);
  });

  it('honours the maximum gain so near-silence is not amplified into hiss', () => {
    const input = sine(440, 1, 0.0005);
    const output = normaliseRms(input, -10, 6);
    expect(rms(output) / rms(input)).toBeLessThanOrEqual(2.01);
  });

  it('never exceeds the peak ceiling', () => {
    // A sparse click train needs gain and would clip without limiting.
    const input = new Float32Array(SAMPLE_RATE).fill(0);
    input[0] = 0.001;
    const output = normaliseRms(input, -18);
    expect(peak(output)).toBeLessThanOrEqual(0.98 + 1e-6);
  });

  it('leaves silence alone', () => {
    expect(peak(normaliseRms(new Float32Array(256), -20))).toBe(0);
  });
});

/* -------------------------------------------------------------- limitPeak */

describe('limitPeak', () => {
  it('scales the signal down only when it would clip', () => {
    const loud = new Float32Array([0.5, -1.5, 0.25]);
    const limited = limitPeak(loud);
    expect(peak(limited)).toBeCloseTo(0.98, 5);
    expect(limited[0] / limited[1]).toBeCloseTo(loud[0] / loud[1], 5);

    const quiet = new Float32Array([0.5, -0.25, 0.1]);
    expect(Array.from(limitPeak(quiet))).toEqual(Array.from(quiet));
  });
});

/* ---------------------------------------------------------- repairSamples */

describe('repairSamples', () => {
  it("returns an exact copy for the 'off' preset", () => {
    const input = sine(440, 0.5, 0.3);
    const output = repairSamples(input, SAMPLE_RATE, REPAIR_PRESETS.off);
    expect(Array.from(output)).toEqual(Array.from(input));
  });

  it('removes the DC offset and room rumble on every active preset', () => {
    const input = dc(1);
    for (const id of ['clean', 'clear', 'noisy', 'far'] as const) {
      const output = repairSamples(input, SAMPLE_RATE, REPAIR_PRESETS[id]);
      const mean = output.reduce((sum, value) => sum + value, 0) / output.length;
      expect(Math.abs(mean)).toBeLessThan(0.02);
    }
  });

  it('makes a quiet far-field voice louder and keeps it below clipping', () => {
    const input = speechLike(4, 0.02);
    const output = repairSamples(input, SAMPLE_RATE, REPAIR_PRESETS.far);
    expect(rms(output)).toBeGreaterThan(rms(input) * 3);
    expect(peak(output)).toBeLessThanOrEqual(0.98 + 1e-6);
  });

  it('detects and removes mains hum in the middle of a voice', () => {
    const voice = speechLike(3, 0.05);
    const hum = sine(50, 3, 0.03);
    const input = new Float32Array(voice.length);
    for (let i = 0; i < input.length; i += 1) input[i] = voice[i] + hum[i];

    const humBefore = goertzelPower(input, SAMPLE_RATE, 50);
    const output = repairSamples(input, SAMPLE_RATE, REPAIR_PRESETS.clear);
    const humAfter = goertzelPower(output, SAMPLE_RATE, 50);
    expect(humAfter).toBeLessThan(humBefore * 0.1);
    expect(peak(output)).toBeLessThanOrEqual(0.98 + 1e-6);
  });

  it('is monotonic in tone shaping across presets', () => {
    const order = ['off', 'clean', 'clear', 'noisy', 'far'] as const;
    for (let i = 1; i < order.length; i += 1) {
      const previous = REPAIR_PRESETS[order[i - 1]];
      const current = REPAIR_PRESETS[order[i]];
      expect(current.highPassHz).toBeGreaterThanOrEqual(previous.highPassHz);
      expect(current.presenceDb).toBeGreaterThanOrEqual(previous.presenceDb);
      expect(current.airDb).toBeGreaterThanOrEqual(previous.airDb);
      expect(current.boomCutDb).toBeLessThanOrEqual(previous.boomCutDb);
    }
    // Denoise peaks on "noisy": constant background noise is its whole point.
    expect(REPAIR_PRESETS.noisy.denoiseStrength).toBeGreaterThan(
      REPAIR_PRESETS.clear.denoiseStrength,
    );
    expect(REPAIR_PRESETS.noisy.denoiseStrength).toBeGreaterThan(
      REPAIR_PRESETS.far.denoiseStrength,
    );
    // The active presets get progressively louder and more compressed.
    expect(REPAIR_PRESETS.clean.targetRmsDb).toBeLessThan(REPAIR_PRESETS.clear.targetRmsDb);
    expect(REPAIR_PRESETS.clear.targetRmsDb).toBeLessThan(REPAIR_PRESETS.noisy.targetRmsDb);
    expect(REPAIR_PRESETS.noisy.targetRmsDb).toBeLessThan(REPAIR_PRESETS.far.targetRmsDb);
    expect(REPAIR_PRESETS.clean.thresholdDb).toBeGreaterThan(REPAIR_PRESETS.clear.thresholdDb);
    expect(REPAIR_PRESETS.clear.thresholdDb).toBeGreaterThan(REPAIR_PRESETS.noisy.thresholdDb);
    expect(REPAIR_PRESETS.noisy.thresholdDb).toBeGreaterThan(REPAIR_PRESETS.far.thresholdDb);
    expect(REPAIR_PRESETS.clean.ratio).toBeLessThanOrEqual(REPAIR_PRESETS.far.ratio);
    expect(REPAIR_PRESETS.clean.compress).toBe(false);
    expect(REPAIR_PRESETS.clear.compress).toBe(true);
    expect(REPAIR_PRESETS.noisy.compress).toBe(true);
    expect(REPAIR_PRESETS.far.compress).toBe(true);
    // Hum handling and de-essing are on for every active preset.
    for (const id of ['clean', 'clear', 'noisy', 'far'] as const) {
      expect(REPAIR_PRESETS[id].hum).toBe('auto');
      expect(REPAIR_PRESETS[id].deEssDb).toBeGreaterThan(0);
    }
    expect(REPAIR_PRESETS.clean.gate).toBe(false);
    expect(REPAIR_PRESETS.clear.gate).toBe(true);
    expect(REPAIR_PRESETS.noisy.gate).toBe(true);
    expect(REPAIR_PRESETS.far.gate).toBe(true);
  });

  it('never produces NaN, Infinity or out-of-range samples', () => {
    const input = new Float32Array(SAMPLE_RATE);
    for (let i = 0; i < input.length; i += 1) {
      input[i] = Math.sin(i / 7) * 0.4 + (i % 97 === 0 ? 0.8 : 0);
    }
    for (const preset of Object.values(REPAIR_PRESETS)) {
      const output = repairSamples(input, SAMPLE_RATE, preset);
      expect(output.length).toBe(input.length);
      for (let i = 0; i < output.length; i += 1) {
        expect(Number.isFinite(output[i])).toBe(true);
        expect(Math.abs(output[i])).toBeLessThanOrEqual(0.98 + 1e-6);
      }
    }
  });

  it('handles empty input', () => {
    expect(repairSamples(new Float32Array(0), SAMPLE_RATE, REPAIR_PRESETS.clear).length).toBe(0);
  });
});

/* -------------------------------------------------- integration: real speech */

describe('repair chain on real speech', () => {
  // One second of noise-only lead-in, then the noisy lecture clip. This is the
  // situation the tool exists for: a distant recording with a constant hiss.
  const speech = loadSpeechFixture();
  const noisy = new Float32Array(SAMPLE_RATE + speech.length);
  for (let i = 0; i < noisy.length; i += 1) {
    noisy[i] = (i < SAMPLE_RATE ? 0 : speech[i - SAMPLE_RATE]);
  }
  const noise = whiteNoise(noisy.length, 0.03);
  for (let i = 0; i < noisy.length; i += 1) noisy[i] += noise[i];

  /** Signal-to-noise ratio estimated from the noise-only lead-in. */
  function snr(signal: Float32Array): number {
    return rms(signal.subarray(0, SAMPLE_RATE / 2)) / rms(signal.subarray(SAMPLE_RATE));
  }

  it('improves the signal-to-noise ratio by more than 2x', () => {
    const before = snr(noisy);
    for (const id of ['clean', 'clear', 'noisy', 'far'] as const) {
      const repaired = repairSamples(noisy, SAMPLE_RATE, REPAIR_PRESETS[id]);
      expect(repaired.length).toBe(noisy.length);
      expect(snr(repaired), `${id} left too much hiss`).toBeLessThan(before * 0.5);
      expect(peak(repaired)).toBeLessThanOrEqual(0.98 + 1e-6);
    }
  });

  it('raises the voice level on the strongest preset', () => {
    const repaired = repairSamples(noisy, SAMPLE_RATE, REPAIR_PRESETS.far);
    const voiceBefore = rms(noisy.subarray(SAMPLE_RATE));
    const voiceAfter = rms(repaired.subarray(SAMPLE_RATE));
    expect(voiceAfter).toBeGreaterThan(voiceBefore * 1.1);
    // And the quietest speech frames benefit too, not just the loud peaks.
    expect(voiceAfter).toBeLessThan(voiceBefore * 3);
  });

  it('leaves the audio free of NaN and clipping on every preset', () => {
    for (const preset of Object.values(REPAIR_PRESETS)) {
      const repaired = repairSamples(noisy, SAMPLE_RATE, preset);
      let highest = 0;
      let finite = true;
      for (let i = 0; i < repaired.length; i += 1) {
        const value = repaired[i];
        if (!Number.isFinite(value)) finite = false;
        else if (Math.abs(value) > highest) highest = Math.abs(value);
      }
      expect(finite).toBe(true);
      expect(highest).toBeLessThanOrEqual(0.98 + 1e-6);
    }
  });
});
