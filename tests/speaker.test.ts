import { describe, expect, it } from 'vitest';
import { clusterEmbeddings } from '../src/lib/audio/speaker';

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

function randomVector(seed: number, dimensions = 64): Float32Array {
  const random = mulberry32(seed);
  const out = new Float32Array(dimensions);
  for (let index = 0; index < dimensions; index += 1) out[index] = random() * 2 - 1;
  return out;
}

function mixture(base: Float32Array, seed: number, weight = 0.08): Float32Array {
  const noise = randomVector(seed, base.length);
  const out = new Float32Array(base.length);
  for (let index = 0; index < base.length; index += 1) {
    out[index] = base[index] * (1 - weight) + noise[index] * weight;
  }
  return out;
}

describe('clusterEmbeddings', () => {
  it('groups noisy samples of three voices and keeps them apart', () => {
    const voices = [randomVector(1), randomVector(2), randomVector(3)];
    const vectors: Float32Array[] = [];
    for (let sample = 0; sample < 9; sample += 1) {
      vectors.push(mixture(voices[sample % 3], 100 + sample));
    }

    const result = clusterEmbeddings(vectors, { maxSpeakers: 6, threshold: 0.62 });
    expect(result.centroids).toHaveLength(3);
    expect(result.labels).toHaveLength(9);
    for (let index = 0; index < 9; index += 1) {
      expect(result.labels[index]).toBe(result.labels[index % 3]);
    }
  });

  it('respects the maxSpeakers ceiling', () => {
    const vectors = Array.from({ length: 8 }, (_, index) => randomVector(50 + index));
    const result = clusterEmbeddings(vectors, { maxSpeakers: 2, threshold: 0.99 });
    expect(result.centroids.length).toBeLessThanOrEqual(2);
    expect(new Set(result.labels).size).toBeLessThanOrEqual(2);
  });

  it('collapses a single voice into one speaker', () => {
    const base = randomVector(7);
    const vectors = Array.from({ length: 10 }, (_, index) => mixture(base, 200 + index, 0.05));
    const result = clusterEmbeddings(vectors, { maxSpeakers: 4, threshold: 0.62 });
    expect(result.centroids).toHaveLength(1);
    expect(result.labels.every((label) => label === 0)).toBe(true);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it('automatically picks the number of voices in thorough mode', () => {
    const voices = [randomVector(11), randomVector(12), randomVector(13), randomVector(14)];
    const vectors: Float32Array[] = [];
    for (let sample = 0; sample < 16; sample += 1) {
      vectors.push(mixture(voices[sample % 4], 300 + sample, 0.06));
    }

    const result = clusterEmbeddings(vectors, { maxSpeakers: 6, threshold: 0.62, autoTune: true });
    expect(result.centroids).toHaveLength(4);
    for (let index = 0; index < 16; index += 1) {
      expect(result.labels[index]).toBe(result.labels[index % 4]);
    }
  });

  it('handles empty input', () => {
    expect(clusterEmbeddings([]).labels).toEqual([]);
  });
});
