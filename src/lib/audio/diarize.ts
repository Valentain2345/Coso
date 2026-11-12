/**
 * Lightweight speaker diarization based on MFCC statistics and k-means++.
 *
 * The implementation is intentionally self-contained (no DSP dependencies) so it
 * can be used in browsers, Node, and inside workers. Every stage is deterministic:
 * the PRNG used by k-means++ is seeded with a fixed constant.
 */

export interface TimeWindow {
  start: number;
  end: number;
}

export interface DiarizationResult {
  /** One 0-based speaker label per input window, contiguous 0..k-1. */
  labels: number[];
  speakerCount: number;
  /** 0..1 quality estimate derived from cluster separation. */
  confidence: number;
  /** Optional cluster centroids in the normalized feature space. */
  centroids?: number[][];
}

export interface DiarizeOptions {
  /** Maximum number of speakers to consider. Defaults to 4. */
  maxSpeakers?: number;
  /**
   * Minimum duration (seconds) a window needs before it participates in the
   * clustering. Shorter windows are labelled by nearest centroid afterwards.
   * Defaults to 0 (all non-empty windows participate).
   */
  minWindow?: number;
}

interface MfccOptions {
  frameLength?: number;
  hopLength?: number;
  melBands?: number;
  coefficients?: number;
}

interface AnalyzedFrame {
  mfcc: Float32Array;
  /** Frame boundaries in samples. */
  startSample: number;
  endSample: number;
  /** Zero-crossing rate, normalized to 0..1. */
  zcr: number;
  /** Spectral centroid divided by Nyquist, normalized to 0..1. */
  centroid: number;
  rms: number;
}

const EPS = 1e-12;
const KMEANS_SEED = 0x9e3779b9;
const RESTARTS = 8;
const MAX_ITERATIONS = 100;

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function nextPowerOfTwo(value: number): number {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
}

function hzToMel(hz: number): number {
  return 2595 * Math.log10(1 + hz / 700);
}

function melToHz(mel: number): number {
  return 700 * (Math.pow(10, mel / 2595) - 1);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Mulberry32: tiny deterministic 32-bit PRNG. */
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

// ---------------------------------------------------------------------------
// FFT (iterative radix-2, in place)
// ---------------------------------------------------------------------------

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) {
    throw new Error('FFT size must be a power of two');
  }

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  // Butterflies.
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    const half = len >> 1;
    for (let start = 0; start < n; start += len) {
      let curRe = 1;
      let curIm = 0;
      for (let j = 0; j < half; j++) {
        const even = start + j;
        const odd = even + half;
        const oddRe = re[odd] * curRe - im[odd] * curIm;
        const oddIm = re[odd] * curIm + im[odd] * curRe;
        re[odd] = re[even] - oddRe;
        im[odd] = im[even] - oddIm;
        re[even] += oddRe;
        im[even] += oddIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Mel filterbank + DCT
// ---------------------------------------------------------------------------

interface MelFilter {
  bins: Int32Array;
  weights: Float64Array;
}

function buildMelFilters(
  sampleRate: number,
  fftSize: number,
  melBands: number,
): { filters: MelFilter[]; maxFrequency: number } {
  const nyquist = sampleRate / 2;
  const minFrequency = 20;
  const maxFrequency = Math.min(8000, nyquist);
  const melMin = hzToMel(minFrequency);
  const melMax = hzToMel(maxFrequency);
  const binCount = fftSize / 2 + 1;
  const hzPerBin = sampleRate / fftSize;

  const points: number[] = [];
  for (let i = 0; i < melBands + 2; i++) {
    const mel = melMin + ((melMax - melMin) * i) / (melBands + 1);
    points.push(melToHz(mel));
  }

  const filters: MelFilter[] = [];
  for (let m = 0; m < melBands; m++) {
    const left = points[m];
    const center = points[m + 1];
    const right = points[m + 2];
    const bins: number[] = [];
    const weights: number[] = [];

    for (let b = 0; b < binCount; b++) {
      const freq = b * hzPerBin;
      let weight = 0;
      if (freq > left && freq <= center) {
        weight = (freq - left) / Math.max(EPS, center - left);
      } else if (freq > center && freq < right) {
        weight = (right - freq) / Math.max(EPS, right - center);
      }
      if (weight > 0) {
        bins.push(b);
        weights.push(weight);
      }
    }

    if (bins.length === 0) {
      // Extremely small FFT or sample rate: assign nearest bin so the filter
      // remains usable rather than producing an all-zero band.
      const nearest = Math.max(0, Math.min(binCount - 1, Math.round(center / hzPerBin)));
      bins.push(nearest);
      weights.push(1);
    }

    const sum = weights.reduce((acc, w) => acc + w, 0);
    const normalized = Float64Array.from(weights, (w) => w / Math.max(EPS, sum));
    filters.push({ bins: Int32Array.from(bins), weights: normalized });
  }

  return { filters, maxFrequency };
}

/** Orthonormal DCT-II of `input`, keeping the first `count` coefficients. */
function dctII(input: Float64Array, count: number): Float32Array {
  const n = input.length;
  const out = new Float32Array(count);
  const scale0 = Math.sqrt(1 / n);
  const scale = Math.sqrt(2 / n);
  for (let k = 0; k < count; k++) {
    let sum = 0;
    for (let m = 0; m < n; m++) {
      sum += input[m] * Math.cos((Math.PI * k * (m + 0.5)) / n);
    }
    out[k] = sum * (k === 0 ? scale0 : scale);
  }
  return out;
}

// ---------------------------------------------------------------------------
// MFCC extraction
// ---------------------------------------------------------------------------

function analyzeFrames(
  samples: Float32Array,
  sampleRate: number,
  opts: Required<MfccOptions>,
): AnalyzedFrame[] {
  const { frameLength, hopLength, melBands, coefficients } = opts;
  if (samples.length === 0) return [];
  if (!(sampleRate > 0) || !(frameLength > 0) || !(hopLength > 0)) return [];

  const totalFrames =
    samples.length <= frameLength
      ? 1
      : 1 + Math.floor((samples.length - frameLength) / hopLength);

  // Pre-emphasis once over the complete signal.
  const emphasized = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    emphasized[i] = samples[i] - (i > 0 ? 0.97 * samples[i - 1] : 0);
  }

  const hamming = new Float64Array(frameLength);
  const denom = Math.max(1, frameLength - 1);
  for (let i = 0; i < frameLength; i++) {
    hamming[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / denom);
  }

  // First pass: energies, used for relative silence rejection.
  const rmsValues = new Float64Array(totalFrames);
  let maxRms = 0;
  for (let f = 0; f < totalFrames; f++) {
    const start = f * hopLength;
    let energy = 0;
    for (let i = 0; i < frameLength; i++) {
      const idx = start + i;
      const v = idx < samples.length ? samples[idx] : 0;
      energy += v * v;
    }
    const rms = Math.sqrt(energy / frameLength);
    rmsValues[f] = rms;
    if (rms > maxRms) maxRms = rms;
  }

  if (!(maxRms > 0)) return [];
  const silenceThreshold = Math.max(1e-7, maxRms * 0.02);

  const fftSize = nextPowerOfTwo(frameLength);
  const { filters } = buildMelFilters(sampleRate, fftSize, melBands);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const logEnergies = new Float64Array(melBands);
  const binCount = fftSize / 2 + 1;
  const power = new Float64Array(binCount);
  const hzPerBin = sampleRate / fftSize;

  const result: AnalyzedFrame[] = [];

  for (let f = 0; f < totalFrames; f++) {
    if (rmsValues[f] < silenceThreshold) continue;

    const start = f * hopLength;

    // Time-domain statistics use the original (not pre-emphasized) frame.
    let mean = 0;
    for (let i = 0; i < frameLength; i++) {
      const idx = start + i;
      mean += idx < samples.length ? samples[idx] : 0;
    }
    mean /= frameLength;

    let crossings = 0;
    let previous = 0;
    for (let i = 0; i < frameLength; i++) {
      const idx = start + i;
      const v = (idx < samples.length ? samples[idx] : 0) - mean;
      if (i > 0) {
        if ((v >= 0 && previous < 0) || (v < 0 && previous >= 0)) crossings++;
      }
      previous = v;
    }
    const zcr = crossings / Math.max(1, frameLength - 1);

    // Windowed pre-emphasized frame -> FFT.
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < frameLength; i++) {
      const idx = start + i;
      const v = idx < samples.length ? emphasized[idx] : 0;
      re[i] = v * hamming[i];
    }
    fft(re, im);

    for (let b = 0; b < binCount; b++) {
      power[b] = re[b] * re[b] + im[b] * im[b];
    }

    let weightedFrequency = 0;
    let totalPower = 0;
    for (let b = 0; b < binCount; b++) {
      const p = power[b];
      weightedFrequency += b * hzPerBin * p;
      totalPower += p;
    }
    const nyquist = Math.max(EPS, sampleRate / 2);
    const spectralCentroid =
      totalPower > EPS ? weightedFrequency / totalPower / nyquist : 0;

    for (let m = 0; m < melBands; m++) {
      const filter = filters[m];
      let energy = 0;
      for (let k = 0; k < filter.bins.length; k++) {
        energy += power[filter.bins[k]] * filter.weights[k];
      }
      logEnergies[m] = Math.log(Math.max(1e-10, energy));
    }

    result.push({
      mfcc: dctII(logEnergies, coefficients),
      startSample: start,
      endSample: start + frameLength,
      zcr: clamp01(zcr),
      centroid: clamp01(spectralCentroid),
      rms: rmsValues[f],
    });
  }

  if (result.length === 0) return [];

  // Cepstral mean normalization (CMN) across retained frames.
  const means = new Float64Array(coefficients);
  for (const frame of result) {
    for (let c = 0; c < coefficients; c++) means[c] += frame.mfcc[c];
  }
  for (let c = 0; c < coefficients; c++) means[c] /= result.length;

  for (const frame of result) {
    for (let c = 0; c < coefficients; c++) {
      frame.mfcc[c] = frame.mfcc[c] - means[c];
    }
  }

  return result;
}

function resolveMfccOptions(sampleRate: number, opts?: MfccOptions): Required<MfccOptions> {
  const frameLength =
    opts?.frameLength !== undefined
      ? Math.max(2, Math.floor(opts.frameLength))
      : Math.max(2, Math.round(0.025 * sampleRate));
  const hopLength =
    opts?.hopLength !== undefined
      ? Math.max(1, Math.floor(opts.hopLength))
      : Math.max(1, Math.round(0.01 * sampleRate));
  const melBands = Math.max(1, Math.floor(opts?.melBands ?? 26));
  const coefficients = Math.max(1, Math.floor(opts?.coefficients ?? 13));
  return { frameLength, hopLength, melBands, coefficients };
}

/**
 * Extract MFCCs from audio.
 *
 * Defaults: pre-emphasis 0.97, 25 ms Hamming frames, 10 ms hop, 26 mel bands,
 * and 13 cepstral coefficients. Near-silent frames are discarded. Cepstral
 * mean normalization is applied across the returned frames.
 */
export function extractMfcc(
  samples: Float32Array,
  sampleRate: number,
  opts?: MfccOptions,
): Float32Array[] {
  const options = resolveMfccOptions(sampleRate, opts);
  return analyzeFrames(samples, sampleRate, options).map((frame) => frame.mfcc);
}

// ---------------------------------------------------------------------------
// Per-window features
// ---------------------------------------------------------------------------

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function stddev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  let sum = 0;
  for (const value of values) {
    const d = value - avg;
    sum += d * d;
  }
  return Math.sqrt(sum / values.length);
}

interface WindowFeature {
  values: number[] | null;
  active: boolean;
}

function buildWindowFeatures(
  frames: AnalyzedFrame[],
  sampleRate: number,
  frameLength: number,
  windows: TimeWindow[],
  coefficientCount: number,
  minWindow: number,
): WindowFeature[] {
  const frameDuration = frameLength / sampleRate;
  const features: WindowFeature[] = [];

  for (const window of windows) {
    const start = Math.min(window.start, window.end);
    const end = Math.max(window.start, window.end);
    const duration = end - start;
    const selected: AnalyzedFrame[] = [];

    for (const frame of frames) {
      const frameStart = frame.startSample / sampleRate;
      const frameEnd = frame.endSample / sampleRate;
      const overlap = Math.min(frameEnd, end) - Math.max(frameStart, start);
      if (overlap >= 0.5 * frameDuration) selected.push(frame);
    }

    // Very short windows can sit between hop positions. Fall back to the frame
    // whose centre is closest to the window centre.
    if (selected.length === 0 && frames.length > 0) {
      const centre = (start + end) / 2;
      let best = frames[0];
      let bestDistance = Infinity;
      for (const frame of frames) {
        const frameCentre = (frame.startSample + frame.endSample) / (2 * sampleRate);
        const distance = Math.abs(frameCentre - centre);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = frame;
        }
      }
      selected.push(best);
    }

    if (selected.length === 0) {
      features.push({ values: null, active: false });
      continue;
    }

    const values: number[] = [];
    for (let c = 0; c < coefficientCount; c++) {
      const column = selected.map((frame) => frame.mfcc[c]);
      const avg = mean(column);
      values.push(avg);
    }
    for (let c = 0; c < coefficientCount; c++) {
      const column = selected.map((frame) => frame.mfcc[c]);
      const avg = mean(column);
      values.push(stddev(column, avg));
    }
    values.push(mean(selected.map((frame) => frame.zcr)));
    values.push(mean(selected.map((frame) => frame.centroid)));

    features.push({ values, active: duration >= minWindow });
  }

  return features;
}

/**
 * Standardize each dimension (removes the MFCC baseline that otherwise
 * dominates Euclidean distances) and then L2-normalize each dimension across
 * windows as required by the feature pipeline.
 */
function normalizeFeatureRows(rows: number[][]): number[][] {
  if (rows.length === 0) return [];
  const n = rows.length;
  const dim = rows[0].length;
  const out = rows.map((row) => row.slice());

  for (let d = 0; d < dim; d++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += out[i][d];
    const avg = sum / n;

    let variance = 0;
    for (let i = 0; i < n; i++) {
      const delta = out[i][d] - avg;
      variance += delta * delta;
    }
    const sd = Math.sqrt(variance / n);
    const divisor = sd > 1e-9 ? sd : 1;

    for (let i = 0; i < n; i++) out[i][d] = (out[i][d] - avg) / divisor;
  }

  for (let d = 0; d < dim; d++) {
    let norm = 0;
    for (let i = 0; i < n; i++) norm += out[i][d] * out[i][d];
    norm = Math.sqrt(norm);
    if (norm > 1e-9) {
      for (let i = 0; i < n; i++) out[i][d] /= norm;
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// k-means++ clustering
// ---------------------------------------------------------------------------

interface KMeansResult {
  assignment: number[];
  centroids: number[][];
  k: number;
  inertia: number;
}

function squaredDistance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return sum;
}

function computeCentroids(points: number[][], assignment: number[], k: number): number[][] {
  const dim = points.length > 0 ? points[0].length : 0;
  const centroids = Array.from({ length: k }, () => new Array<number>(dim).fill(0));
  const counts = new Array<number>(k).fill(0);
  for (let i = 0; i < points.length; i++) {
    const cluster = assignment[i];
    if (cluster < 0 || cluster >= k) continue;
    counts[cluster]++;
    for (let d = 0; d < dim; d++) centroids[cluster][d] += points[i][d];
  }
  for (let c = 0; c < k; c++) {
    if (counts[c] > 0) {
      for (let d = 0; d < dim; d++) centroids[c][d] /= counts[c];
    }
  }
  return centroids;
}

function kmeansPlusPlus(points: number[][], k: number, rng: () => number): KMeansResult {
  const n = points.length;
  const dim = points[0].length;
  const centroids: number[][] = [];
  const chosen = new Set<number>();

  const first = Math.min(n - 1, Math.floor(rng() * n));
  centroids.push(points[first].slice());
  chosen.add(first);

  while (centroids.length < k) {
    const distances = new Array<number>(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (const centre of centroids) {
        const d = squaredDistance(points[i], centre);
        if (d < best) best = d;
      }
      distances[i] = best;
      total += best;
    }

    let index = -1;
    if (total > 1e-12) {
      const target = rng() * total;
      let cumulative = 0;
      for (let i = 0; i < n; i++) {
        cumulative += distances[i];
        if (cumulative >= target) {
          index = i;
          break;
        }
      }
      if (index < 0) index = n - 1;
    }

    if (index < 0 || chosen.has(index)) {
      // Degenerate case: all remaining points coincide with existing centres.
      index = -1;
      for (let i = 0; i < n; i++) {
        if (!chosen.has(i)) {
          index = i;
          break;
        }
      }
    }

    if (index < 0) {
      // k exceeds the number of distinct points; duplicate the last centre.
      centroids.push(centroids[centroids.length - 1].slice());
    } else {
      centroids.push(points[index].slice());
      chosen.add(index);
    }
  }

  const assignment = new Array<number>(n).fill(0);

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    let changed = false;

    for (let i = 0; i < n; i++) {
      let bestCluster = 0;
      let bestDistance = Infinity;
      for (let c = 0; c < k; c++) {
        let distance = 0;
        for (let d = 0; d < dim; d++) {
          const delta = points[i][d] - centroids[c][d];
          distance += delta * delta;
          if (distance >= bestDistance) break;
        }
        if (distance < bestDistance) {
          bestDistance = distance;
          bestCluster = c;
        }
      }
      if (assignment[i] !== bestCluster) {
        assignment[i] = bestCluster;
        changed = true;
      }
    }

    // Recover empty clusters by moving the point that is currently worst
    // represented (and whose cluster has more than one member).
    const sizes = new Array<number>(k).fill(0);
    for (const cluster of assignment) sizes[cluster]++;
    for (let c = 0; c < k; c++) {
      if (sizes[c] > 0) continue;

      let candidate = -1;
      let candidateDistance = -1;
      for (let i = 0; i < n; i++) {
        const owner = assignment[i];
        if (sizes[owner] <= 1) continue;
        const distance = squaredDistance(points[i], centroids[owner]);
        if (distance > candidateDistance) {
          candidateDistance = distance;
          candidate = i;
        }
      }
      if (candidate >= 0) {
        sizes[assignment[candidate]]--;
        assignment[candidate] = c;
        sizes[c]++;
        changed = true;
      }
    }

    const nextCentroids = computeCentroids(points, assignment, k);
    let shift = 0;
    for (let c = 0; c < k; c++) {
      if (sizes[c] === 0) nextCentroids[c] = centroids[c].slice();
      shift += squaredDistance(nextCentroids[c], centroids[c]);
    }
    for (let c = 0; c < k; c++) centroids[c] = nextCentroids[c];

    if (!changed || shift < 1e-10) break;
  }

  let inertia = 0;
  for (let i = 0; i < n; i++) {
    inertia += squaredDistance(points[i], centroids[assignment[i]]);
  }

  return { assignment, centroids, k, inertia };
}

/** Compact cluster ids and merge clusters smaller than `minSize`. */
function repairClusters(
  points: number[][],
  assignment: number[],
  k: number,
  minSize: number,
): KMeansResult {
  let labels = assignment.slice();
  let currentK = k;

  const compact = (): void => {
    const mapping = new Map<number, number>();
    let next = 0;
    for (let i = 0; i < labels.length; i++) {
      const old = labels[i];
      if (!mapping.has(old)) mapping.set(old, next++);
      labels[i] = mapping.get(old)!;
    }
    currentK = next;
  };

  compact();

  while (currentK > 1) {
    const sizes = new Array<number>(currentK).fill(0);
    for (const cluster of labels) sizes[cluster]++;

    let small = -1;
    let smallSize = Infinity;
    for (let c = 0; c < currentK; c++) {
      if (sizes[c] < minSize && sizes[c] < smallSize) {
        smallSize = sizes[c];
        small = c;
      }
    }
    if (small < 0) break;

    const centroids = computeCentroids(points, labels, currentK);
    let target = -1;
    let targetDistance = Infinity;
    for (let c = 0; c < currentK; c++) {
      if (c === small || sizes[c] === 0) continue;
      const distance = squaredDistance(centroids[small], centroids[c]);
      if (distance < targetDistance) {
        targetDistance = distance;
        target = c;
      }
    }

    if (target < 0) break;

    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === small) labels[i] = target;
    }
    compact();
  }

  const centroids = computeCentroids(points, labels, currentK);
  let inertia = 0;
  for (let i = 0; i < points.length; i++) {
    inertia += squaredDistance(points[i], centroids[labels[i]]);
  }

  return { assignment: labels, centroids, k: currentK, inertia };
}

function silhouetteScore(points: number[][], assignment: number[], k: number): number {
  const n = points.length;
  if (k < 2 || n < 2) return 0;

  const sizes = new Array<number>(k).fill(0);
  for (const cluster of assignment) sizes[cluster]++;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const own = assignment[i];
    if (sizes[own] <= 1) continue;

    let ownDistance = 0;
    const otherDistance = new Array<number>(k).fill(0);
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const distance = Math.sqrt(squaredDistance(points[i], points[j]));
      if (assignment[j] === own) {
        ownDistance += distance;
      } else {
        otherDistance[assignment[j]] += distance;
      }
    }

    const a = ownDistance / (sizes[own] - 1);
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === own || sizes[c] === 0) continue;
      const avg = otherDistance[c] / sizes[c];
      if (avg < b) b = avg;
    }
    if (!Number.isFinite(b)) continue;
    const denominator = Math.max(a, b, 1e-12);
    sum += (b - a) / denominator;
  }

  return sum / n;
}

function singleClusterScore(points: number[][]): number {
  if (points.length === 0) return 0;
  const dim = points[0].length;
  const centroid = meanVector(points);
  let sum = 0;
  for (const point of points) sum += Math.sqrt(squaredDistance(point, centroid));
  const radius = sum / points.length;
  return clamp01(1 - radius / Math.sqrt(Math.max(1, dim)));
}

function meanVector(points: number[][]): number[] {
  if (points.length === 0) return [];
  const dim = points[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const point of points) {
    for (let d = 0; d < dim; d++) out[d] += point[d];
  }
  for (let d = 0; d < dim; d++) out[d] /= points.length;
  return out;
}

function nearestCentroid(point: number[], centroids: number[][]): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let c = 0; c < centroids.length; c++) {
    const distance = squaredDistance(point, centroids[c]);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = c;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Public diarization API
// ---------------------------------------------------------------------------

/**
 * Assign a speaker label to each supplied time window.
 *
 * Each window is described by MFCC mean/std statistics plus zero-crossing rate
 * and spectral centroid. Features are clustered with deterministic k-means++
 * and the number of speakers is selected using silhouette score with a margin
 * over the single-speaker baseline.
 */
export function diarize(
  samples: Float32Array,
  sampleRate: number,
  windows: TimeWindow[],
  options?: DiarizeOptions,
): DiarizationResult {
  if (!windows || windows.length === 0) {
    return { labels: [], speakerCount: 0, confidence: 0 };
  }

  const maxSpeakers = Math.max(1, Math.floor(options?.maxSpeakers ?? 4));
  const minWindow = Math.max(0, options?.minWindow ?? 0);
  const mfccOptions = resolveMfccOptions(sampleRate);
  const frames = analyzeFrames(samples, sampleRate, mfccOptions);
  const coefficientCount = mfccOptions.coefficients;

  const windowFeatures = buildWindowFeatures(
    frames,
    sampleRate,
    mfccOptions.frameLength,
    windows,
    coefficientCount,
    minWindow,
  );

  // Windows with usable acoustic frames.
  const usableIndices: number[] = [];
  for (let i = 0; i < windowFeatures.length; i++) {
    if (windowFeatures[i].values !== null) usableIndices.push(i);
  }

  if (usableIndices.length === 0) {
    return {
      labels: new Array<number>(windows.length).fill(0),
      speakerCount: 1,
      confidence: 0,
    };
  }

  const rawRows = usableIndices.map((i) => windowFeatures[i].values as number[]);
  const normalized = normalizeFeatureRows(rawRows);

  // Map normalized rows back to window indices.
  const normalizedByWindow = new Map<number, number[]>();
  for (let i = 0; i < usableIndices.length; i++) {
    normalizedByWindow.set(usableIndices[i], normalized[i]);
  }

  // Windows that are long enough to participate in clustering.
  const activeIndices = usableIndices.filter(
    (i) => windowFeatures[i].active,
  );
  const clusteringIndices = activeIndices.length > 0 ? activeIndices : usableIndices;
  const points = clusteringIndices.map(
    (i) => normalizedByWindow.get(i) as number[],
  );
  const n = points.length;

  // Selected clustering.
  let finalAssignment: number[] = new Array<number>(n).fill(0);
  let finalCentroids: number[][] = [meanVector(points)];
  let finalK = 1;
  let finalConfidence = singleClusterScore(points);

  if (n >= 3 && maxSpeakers >= 2) {
    const baseline = singleClusterScore(points);
    const kMax = Math.min(maxSpeakers, n);
    let bestK = 1;
    let bestScore = -Infinity;
    let bestAssignment: number[] | null = null;
    let bestCentroids: number[][] | null = null;

    for (let k = 2; k <= kMax; k++) {
      let bestRun: KMeansResult | null = null;
      for (let restart = 0; restart < RESTARTS; restart++) {
        const seed = (KMEANS_SEED ^
          Math.imul(k, 0x85ebca6b) ^
          Math.imul(restart + 1, 0x27d4eb2d)) >>> 0;
        const run = kmeansPlusPlus(points, k, mulberry32(seed));
        if (!bestRun || run.inertia < bestRun.inertia - 1e-12) {
          bestRun = run;
        }
      }
      if (!bestRun) continue;

      const minSize = Math.max(1, Math.floor(n * 0.08));
      const repaired = repairClusters(points, bestRun.assignment, k, minSize);
      if (repaired.k < 2) continue;

      const score = silhouetteScore(points, repaired.assignment, repaired.k);
      if (score > bestScore + 1e-12) {
        bestScore = score;
        bestK = repaired.k;
        bestAssignment = repaired.assignment.slice();
        bestCentroids = repaired.centroids.map((centroid) => centroid.slice());
      }
    }

    const improvement = bestScore - baseline;
    if (
      bestAssignment &&
      bestCentroids &&
      bestK >= 2 &&
      bestScore > 0.18 &&
      improvement > 0.06
    ) {
      finalAssignment = bestAssignment;
      finalCentroids = bestCentroids;
      finalK = bestK;
      finalConfidence = clamp01(bestScore);
    }
  }

  // Label windows. Inactive windows are assigned to the nearest final centroid
  // (or speaker 0 when only one speaker was retained).
  const labelsByWindow = new Array<number>(windows.length).fill(0);
  for (let i = 0; i < clusteringIndices.length; i++) {
    labelsByWindow[clusteringIndices[i]] = finalAssignment[i];
  }
  for (const index of usableIndices) {
    if (clusteringIndices.includes(index)) continue;
    if (finalK <= 1) {
      labelsByWindow[index] = 0;
    } else {
      const point = normalizedByWindow.get(index) as number[];
      labelsByWindow[index] = nearestCentroid(point, finalCentroids);
    }
  }

  // Normalize cluster ids by first appearance so labels[0] is usually 0 and
  // ids are contiguous.
  const remap = new Map<number, number>();
  let nextLabel = 0;
  for (let i = 0; i < labelsByWindow.length; i++) {
    const old = labelsByWindow[i];
    if (!remap.has(old)) remap.set(old, nextLabel++);
    labelsByWindow[i] = remap.get(old)!;
  }

  const orderedCentroids: number[][] = new Array(nextLabel);
  for (let old = 0; old < finalCentroids.length; old++) {
    const mapped = remap.get(old);
    if (mapped !== undefined) orderedCentroids[mapped] = finalCentroids[old];
  }
  for (let i = 0; i < orderedCentroids.length; i++) {
    if (!orderedCentroids[i]) orderedCentroids[i] = finalCentroids[0]?.slice() ?? [];
  }

  return {
    labels: labelsByWindow,
    speakerCount: nextLabel,
    confidence: clamp01(finalConfidence),
    centroids: orderedCentroids,
  };
}
