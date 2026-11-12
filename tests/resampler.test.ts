import { describe, expect, it } from 'vitest';
import { StreamingResampler } from '../src/lib/audio/dsp';

function sine(rate: number, seconds: number, frequency: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let index = 0; index < out.length; index += 1) {
    out[index] = 0.5 * Math.sin((2 * Math.PI * frequency * index) / rate);
  }
  return out;
}

function runChunked(
  input: Float32Array,
  from: number,
  to: number,
  chunkSizes: number[],
): Float32Array {
  const resampler = new StreamingResampler(from, to);
  const pieces: Float32Array[] = [];
  let offset = 0;
  let index = 0;
  while (offset < input.length) {
    const size = chunkSizes[index % chunkSizes.length];
    pieces.push(resampler.process(input.subarray(offset, offset + size)));
    offset += size;
    index += 1;
  }
  pieces.push(resampler.flush());

  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  const out = new Float32Array(total);
  let write = 0;
  for (const piece of pieces) {
    out.set(piece, write);
    write += piece.length;
  }
  return out;
}

describe('StreamingResampler', () => {
  it('preserves a tone when downsampling 48 kHz to 16 kHz across odd chunks', () => {
    const input = sine(48000, 1, 440);
    const output = runChunked(input, 48000, 16000, [1234, 777, 4096, 33]);

    expect(Math.abs(output.length - 16000)).toBeLessThanOrEqual(2);

    let best = 0;
    for (let phase = 0; phase < 48; phase += 1) {
      let dot = 0;
      for (let index = 100; index < 15000; index += 1) {
        dot += output[index] * Math.sin((2 * Math.PI * 440 * (index + phase / 48)) / 16000);
      }
      best = Math.max(best, Math.abs(dot) / (15000 - 100));
    }
    // Correlating a 0.5-amplitude sine against a unit sine gives ~0.25 on average.
    expect(best).toBeGreaterThan(0.2);
  });

  it('upsamples 44.1 kHz without gaps at chunk boundaries', () => {
    const input = sine(44100, 0.5, 300);
    const output = runChunked(input, 44100, 48000, [999, 2000, 17, 5000]);

    expect(Math.abs(output.length - 24000)).toBeLessThanOrEqual(3);
    let peak = 0;
    for (const value of output) peak = Math.max(peak, Math.abs(value));
    expect(peak).toBeGreaterThan(0.35);
    expect(peak).toBeLessThan(0.7);
  });
});
