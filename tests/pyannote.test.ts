import { describe, expect, it } from 'vitest';
import { decodePyannoteFrames } from '../src/lib/audio/pyannote';

const CLASSES = 7;

function makeLogits(frames: number, classAt: (frame: number) => number): Float32Array {
  const data = new Float32Array(frames * CLASSES).fill(-8);
  for (let frame = 0; frame < frames; frame += 1) {
    data[frame * CLASSES + classAt(frame)] = 8;
  }
  return data;
}

describe('decodePyannoteFrames', () => {
  it('turns a powerset window into accurate speaker regions', () => {
    const frames = 100;
    const data = makeLogits(frames, (frame) => (frame >= 30 && frame < 70 ? 0 : 1));
    const regions = decodePyannoteFrames(data, frames, CLASSES, 0, 10);

    expect(regions).toHaveLength(2);
    expect(regions[0].start).toBeCloseTo(0, 1);
    expect(regions[0].end).toBeCloseTo(3, 1);
    expect(regions[1].start).toBeCloseTo(7, 1);
    expect(regions[1].end).toBeCloseTo(10, 1);
    expect(regions[0].confidence).toBeGreaterThan(0.9);
  });

  it('splits overlapping speakers into two active regions', () => {
    const frames = 100;
    // SPEAKERS_1_AND_2 is powerset class 4.
    const data = makeLogits(frames, (frame) => {
      if (frame < 40) return 1;
      if (frame < 70) return 4;
      return 0;
    });
    const regions = decodePyannoteFrames(data, frames, CLASSES, 0, 10);

    expect(regions).toHaveLength(2);
    expect(regions[0].start).toBeCloseTo(0, 1);
    expect(regions[0].end).toBeCloseTo(7, 1);
    expect(regions[1].start).toBeCloseTo(4, 1);
    expect(regions[1].end).toBeCloseTo(7, 1);
  });

  it('offsets regions by the window start', () => {
    const frames = 50;
    const data = makeLogits(frames, () => 2);
    const regions = decodePyannoteFrames(data, frames, CLASSES, 90, 5);

    expect(regions).toHaveLength(1);
    expect(regions[0].start).toBeCloseTo(90, 1);
    expect(regions[0].end).toBeCloseTo(95, 1);
  });

  it('ignores blips shorter than the minimum duration', () => {
    const frames = 100;
    const data = makeLogits(frames, (frame) => (frame >= 10 && frame < 12 ? 1 : 0));
    expect(decodePyannoteFrames(data, frames, CLASSES, 0, 10)).toEqual([]);
  });

  it('rejects malformed logits', () => {
    expect(decodePyannoteFrames(new Float32Array(4), 10, CLASSES, 0, 10)).toEqual([]);
    expect(decodePyannoteFrames(new Float32Array(70), 10, 3, 0, 10)).toEqual([]);
  });
});
