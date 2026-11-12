/**
 * Pure TypeScript digital signal processing helpers used by the audio pipeline.
 *
 * This module deliberately has no dependency on the Web Audio API or the DOM.
 * `encodeWav` is the only DOM-adjacent helper and only relies on the standard
 * `Blob` global.
 */

export interface SpeechSegment {
  start: number;
  end: number;
}

export interface DenoiseOptions {
  strength?: number;
  floor?: number;
}

export interface VadOptions {
  minSpeech?: number;
  minSilence?: number;
  pad?: number;
  maxSegment?: number;
  thresholdFactor?: number;
}

const EPSILON = 1e-12;

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value);
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Mix an array of channels down to a single mono channel (arithmetic mean). */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) {
    return new Float32Array(0);
  }
  if (channels.length === 1) {
    return new Float32Array(channels[0]);
  }

  let length = 0;
  for (const channel of channels) {
    length = Math.max(length, channel.length);
  }

  const out = new Float32Array(length);
  const scale = 1 / channels.length;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (let c = 0; c < channels.length; c++) {
      const sample = channels[c][i];
      if (Number.isFinite(sample)) {
        sum += sample;
      }
    }
    out[i] = sum * scale;
  }
  return out;
}

/** Centred Blackman window over d in [-1, 1]. */
function blackman(d: number): number {
  return 0.42 + 0.5 * Math.cos(Math.PI * d) + 0.08 * Math.cos(2 * Math.PI * d);
}

function sinc(x: number): number {
  if (Math.abs(x) < 1e-9) {
    return 1;
  }
  const arg = Math.PI * x;
  return Math.sin(arg) / arg;
}

/**
 * Resample with a windowed-sinc interpolator (16 taps when upsampling, widened
 * for downsampling so the anti-aliasing low-pass tracks the new Nyquist rate).
 */
export function resample(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (
    !isFiniteNumber(fromRate) ||
    !isFiniteNumber(toRate) ||
    fromRate <= 0 ||
    toRate <= 0 ||
    input.length === 0
  ) {
    return new Float32Array(input);
  }

  const targetLength = Math.round((input.length * toRate) / fromRate);
  if (targetLength <= 0) {
    return new Float32Array(0);
  }
  if (fromRate === toRate) {
    return new Float32Array(input);
  }

  const ratio = toRate / fromRate;
  const downsample = Math.min(1, ratio);
  // Slightly below Nyquist to leave room for the finite-length kernel roll-off.
  const cutoff = downsample * 0.97;
  // 8 zero crossings on each side -> 16 taps when upsampling. When
  // downsampling the kernel is stretched by 1 / ratio to lower the cutoff.
  const radius = 8 / downsample;

  const out = new Float32Array(targetLength);
  const lastIndex = input.length - 1;
  const edgeTolerance = 1e-9;

  for (let i = 0; i < targetLength; i++) {
    const position = i / ratio;

    let weighted = 0;
    let weightSum = 0;

    // Include out-of-range kernel taps in `weightSum` so the output fades
    // naturally instead of being amplified at the signal boundaries.
    const kernelFirst = Math.ceil(position - radius - edgeTolerance);
    const kernelLast = Math.floor(position + radius + edgeTolerance);
    for (let tap = kernelFirst; tap <= kernelLast; tap++) {
      const distance = position - tap;
      const normalised = distance / radius;
      const window = blackman(normalised);
      const weight = sinc(distance * cutoff) * window;
      weightSum += weight;

      if (tap >= 0 && tap <= lastIndex) {
        const sample = input[tap];
        if (Number.isFinite(sample)) {
          weighted += sample * weight;
        }
      }
    }

    out[i] = Math.abs(weightSum) > EPSILON ? weighted / weightSum : 0;
  }

  return out;
}

/**
 * Resamples a continuous stream split across many chunks without introducing
 * discontinuities at chunk boundaries.
 *
 * Upsampling uses linear interpolation (the images it creates sit far above
 * speech and cost almost nothing); downsampling uses a short windowed-sinc
 * low-pass to avoid aliasing. Keeping this stateful is what allows a 4-hour
 * file to be processed chunk by chunk.
 */
export class StreamingResampler {
  readonly fromRate: number;
  readonly toRate: number;

  private readonly ratio: number;
  private readonly linear: boolean;
  private readonly radius: number;
  private readonly cutoff: number;
  private buffer = new Float32Array(0);
  private base = 0;
  private outIndex = 0;

  constructor(fromRate: number, toRate: number) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.ratio = toRate / fromRate;
    this.linear = this.ratio >= 1;
    const downsample = Math.min(1, this.ratio);
    this.cutoff = downsample * 0.94;
    this.radius = this.linear ? 2 : 12;
  }

  /** True when no work is needed (same input and output rate). */
  get passthrough(): boolean {
    return this.ratio === 1;
  }

  private sampleAt(position: number): number {
    const last = this.base + this.buffer.length - 1;
    if (this.linear) {
      const left = Math.floor(position);
      const fraction = position - left;
      const a = left >= this.base && left <= last ? this.buffer[left - this.base] : 0;
      const b = left + 1 >= this.base && left + 1 <= last ? this.buffer[left + 1 - this.base] : a;
      return a + (b - a) * fraction;
    }

    let weighted = 0;
    let weightSum = 0;
    const first = Math.ceil(position - this.radius);
    const final = Math.floor(position + this.radius);
    for (let tap = first; tap <= final; tap += 1) {
      const distance = position - tap;
      const window = blackman(distance / this.radius);
      const weight = sinc(distance * this.cutoff) * window;
      weightSum += weight;
      if (tap >= this.base && tap <= last) {
        weighted += this.buffer[tap - this.base] * weight;
      }
    }
    return Math.abs(weightSum) > EPSILON ? weighted / weightSum : 0;
  }

  process(input: Float32Array): Float32Array {
    if (this.passthrough) return input;
    if (input.length === 0) return new Float32Array(0);

    const merged = new Float32Array(this.buffer.length + input.length);
    merged.set(this.buffer, 0);
    merged.set(input, this.buffer.length);
    this.buffer = merged;

    const out: number[] = [];
    const last = this.base + this.buffer.length - 1;

    for (;;) {
      const position = this.outIndex / this.ratio;
      // Wait until enough future samples exist to evaluate the kernel.
      if (position + this.radius > last) break;
      out.push(this.sampleAt(position));
      this.outIndex += 1;
    }

    // Discard input that can no longer influence a future output sample.
    const nextPosition = this.outIndex / this.ratio;
    const keepFrom = Math.floor(nextPosition - this.radius) - this.base;
    if (keepFrom > 0) {
      const keep = Math.min(keepFrom, this.buffer.length);
      this.buffer = this.buffer.slice(keep);
      this.base += keep;
    }

    return Float32Array.from(out);
  }

  /** Emit the final samples, fading naturally at the stream edge. */
  flush(): Float32Array {
    if (this.passthrough) return new Float32Array(0);
    const last = this.base + this.buffer.length - 1;
    const out: number[] = [];
    for (;;) {
      const position = this.outIndex / this.ratio;
      if (position > last) break;
      out.push(this.sampleAt(position));
      this.outIndex += 1;
    }
    this.buffer = new Float32Array(0);
    return Float32Array.from(out);
  }

  reset(): void {
    this.buffer = new Float32Array(0);
    this.base = 0;
    this.outIndex = 0;
  }
}

/**
 * Second-order Butterworth high-pass filter (RBJ biquad cookbook), applied in
 * transposed direct form II. Removes DC and very low-frequency rumble.
 */
export function highPass(
  input: Float32Array,
  sampleRate: number,
  cutoffHz: number = 80,
): Float32Array {
  if (
    input.length === 0 ||
    !isFiniteNumber(sampleRate) ||
    sampleRate <= 0 ||
    !isFiniteNumber(cutoffHz) ||
    cutoffHz <= 0
  ) {
    return new Float32Array(input);
  }

  const nyquist = sampleRate * 0.5;
  const cutoff = Math.min(Math.max(cutoffHz, 1e-4), nyquist * 0.999);

  const omega = (2 * Math.PI * cutoff) / sampleRate;
  const cosOmega = Math.cos(omega);
  const sinOmega = Math.sin(omega);
  const q = Math.SQRT1_2;
  const alpha = sinOmega / (2 * q);

  const a0 = 1 + alpha;
  const b0 = ((1 + cosOmega) / 2) / a0;
  const b1 = (-(1 + cosOmega)) / a0;
  const b2 = ((1 + cosOmega) / 2) / a0;
  const a1 = (-2 * cosOmega) / a0;
  const a2 = (1 - alpha) / a0;

  const out = new Float32Array(input.length);
  let z1 = 0;
  let z2 = 0;

  for (let i = 0; i < input.length; i++) {
    const x = Number.isFinite(input[i]) ? input[i] : 0;
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    out[i] = finiteOrZero(y);
  }

  return out;
}

/**
 * Peak-normalise to `targetPeak`. Amplification is limited to `maxGainDb`
 * (24 dB by default) and digital silence is never amplified.
 */
export function normalizePeak(
  input: Float32Array,
  targetPeak: number = 1,
  maxGainDb: number = 24,
): Float32Array {
  const out = new Float32Array(input);
  if (input.length === 0) {
    return out;
  }

  let maximum = 0;
  for (let i = 0; i < input.length; i++) {
    const value = input[i];
    if (Number.isFinite(value)) {
      const magnitude = Math.abs(value);
      if (magnitude > maximum) {
        maximum = magnitude;
      }
    }
  }

  const target = isFiniteNumber(targetPeak) ? targetPeak : 1;
  if (maximum === 0 || target === 0) {
    if (target === 0) {
      out.fill(0);
    }
    return out;
  }
  if (target < 0) {
    return out;
  }

  const limitDb = isFiniteNumber(maxGainDb) ? Math.max(0, maxGainDb) : 0;
  const maxGain = Math.pow(10, limitDb / 20);
  const gain = Math.min(target / maximum, maxGain);

  for (let i = 0; i < out.length; i++) {
    out[i] = finiteOrZero(out[i] * gain);
  }

  return out;
}

/** In-place radix-2 Cooley-Tukey FFT over Float64 arrays. */
function fft(real: Float64Array, imag: Float64Array, inverse: boolean): void {
  const n = real.length;

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; (j & bit) !== 0; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = real[i];
      real[i] = real[j];
      real[j] = tr;
      const ti = imag[i];
      imag[i] = imag[j];
      imag[j] = ti;
    }
  }

  // Butterfly stages.
  const direction = inverse ? 1 : -1;
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (direction * 2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImag = Math.sin(angle);
    const half = length >> 1;

    for (let start = 0; start < n; start += length) {
      let twiddleReal = 1;
      let twiddleImag = 0;
      for (let k = 0; k < half; k++) {
        const evenIndex = start + k;
        const oddIndex = evenIndex + half;

        const oddReal =
          real[oddIndex] * twiddleReal - imag[oddIndex] * twiddleImag;
        const oddImag =
          real[oddIndex] * twiddleImag + imag[oddIndex] * twiddleReal;

        const evenReal = real[evenIndex];
        const evenImag = imag[evenIndex];

        real[evenIndex] = evenReal + oddReal;
        imag[evenIndex] = evenImag + oddImag;
        real[oddIndex] = evenReal - oddReal;
        imag[oddIndex] = evenImag - oddImag;

        const nextReal = twiddleReal * stepReal - twiddleImag * stepImag;
        twiddleImag = twiddleReal * stepImag + twiddleImag * stepReal;
        twiddleReal = nextReal;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      real[i] /= n;
      imag[i] /= n;
    }
  }
}

function hannWindow(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return window;
}

/**
 * Real STFT spectral subtraction.
 *
 * Frames are 1024 samples (75 % overlap), the noise magnitude spectrum is
 * averaged from the quietest ~12 % of frames, and each bin is reduced by
 * `strength * noise`, but never below `floor * originalMagnitude`.
 */
export function spectralDenoise(
  input: Float32Array,
  sampleRate: number,
  options: DenoiseOptions = {},
): Float32Array {
  const inputLength = input.length;
  if (inputLength === 0) {
    return new Float32Array(0);
  }

  const strengthOption = options.strength;
  const strength =
    strengthOption !== undefined && isFiniteNumber(strengthOption)
      ? Math.max(0, strengthOption)
      : 1.5;
  const floorOption = options.floor;
  const floor =
    floorOption !== undefined && isFiniteNumber(floorOption)
      ? Math.min(1, Math.max(0, floorOption))
      : 0.05;

  const windowSize = 1024;
  const hop = windowSize / 4;

  // Too short to build a meaningful STFT: return a normalised copy.
  if (inputLength < windowSize || !isFiniteNumber(sampleRate) || sampleRate <= 0) {
    return normalizePeak(input);
  }

  const window = hannWindow(windowSize);
  const paddedLength = inputLength + 2 * windowSize;
  const padded = new Float32Array(paddedLength);
  for (let i = 0; i < inputLength; i++) {
    padded[windowSize + i] = finiteOrZero(input[i]);
  }

  const frameCount = Math.floor((paddedLength - windowSize) / hop) + 1;
  const lastCandidateStart = inputLength - windowSize;

  // Pass 1: locate the quietest frames (energy can be measured in the time
  // domain, no FFT needed yet).
  const candidateFrames: number[] = [];
  const candidateEnergies: number[] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const originalStart = frame * hop - windowSize;
    if (originalStart < 0 || originalStart > lastCandidateStart) {
      continue;
    }
    let energy = 0;
    for (let i = 0; i < windowSize; i++) {
      const sample = padded[frame * hop + i];
      energy += sample * sample;
    }
    if (energy > 1e-12) {
      candidateFrames.push(frame);
      candidateEnergies.push(energy);
    }
  }

  if (candidateFrames.length === 0) {
    return normalizePeak(input);
  }

  const order = candidateEnergies
    .map((energy, index) => ({ energy, index }))
    .sort((a, b) => a.energy - b.energy);
  const noiseFrameCount = Math.max(
    1,
    Math.floor(candidateFrames.length * 0.12),
  );

  const real = new Float64Array(windowSize);
  const imag = new Float64Array(windowSize);
  const noiseMagnitude = new Float64Array(windowSize);

  for (let i = 0; i < noiseFrameCount; i++) {
    const frame = candidateFrames[order[i].index];
    const start = frame * hop;
    for (let n = 0; n < windowSize; n++) {
      real[n] = padded[start + n] * window[n];
      imag[n] = 0;
    }
    fft(real, imag, false);
    for (let bin = 0; bin < windowSize; bin++) {
      noiseMagnitude[bin] += Math.hypot(real[bin], imag[bin]);
    }
  }
  for (let bin = 0; bin < windowSize; bin++) {
    noiseMagnitude[bin] /= noiseFrameCount;
  }

  // Pass 2: subtract the noise estimate frame by frame and overlap-add.
  const accumulated = new Float64Array(paddedLength);
  const windowEnergy = new Float64Array(paddedLength);

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hop;
    for (let n = 0; n < windowSize; n++) {
      real[n] = padded[start + n] * window[n];
      imag[n] = 0;
    }
    fft(real, imag, false);

    for (let bin = 0; bin < windowSize; bin++) {
      const magnitude = Math.hypot(real[bin], imag[bin]);
      const cleaned = Math.max(
        magnitude - strength * noiseMagnitude[bin],
        floor * magnitude,
      );
      if (magnitude > 1e-12) {
        const scale = cleaned / magnitude;
        real[bin] *= scale;
        imag[bin] *= scale;
      } else {
        real[bin] = 0;
        imag[bin] = 0;
      }
    }

    fft(real, imag, true);

    for (let n = 0; n < windowSize; n++) {
      const index = start + n;
      const windowValue = window[n];
      accumulated[index] += real[n] * windowValue;
      windowEnergy[index] += windowValue * windowValue;
    }
  }

  const out = new Float32Array(inputLength);
  for (let i = 0; i < inputLength; i++) {
    const paddedIndex = windowSize + i;
    const denominator = windowEnergy[paddedIndex];
    const value =
      denominator > 1e-12
        ? accumulated[paddedIndex] / denominator
        : padded[paddedIndex];
    out[i] = finiteOrZero(value);
  }

  return out;
}

function percentile(sortedValues: number[], fraction: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.floor(fraction * (sortedValues.length - 1))),
  );
  return sortedValues[index];
}

/**
 * Energy based voice-activity detection with hysteresis, gap merging,
 * minimum-duration filtering, padding and long-segment splitting.
 */
export function detectSpeechSegments(
  input: Float32Array,
  sampleRate: number,
  options: VadOptions = {},
): SpeechSegment[] {
  if (
    input.length === 0 ||
    !isFiniteNumber(sampleRate) ||
    sampleRate <= 0
  ) {
    return [];
  }

  const minSpeech = Math.max(0, options.minSpeech ?? 0.25);
  const minSilence = Math.max(0, options.minSilence ?? 0.35);
  const pad = Math.max(0, options.pad ?? 0.2);
  const maxSegment = Math.max(0.01, options.maxSegment ?? 25);
  const thresholdFactor = Math.max(1, options.thresholdFactor ?? 3.2);

  const frameLength = Math.max(1, Math.round(sampleRate * 0.02));
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const duration = input.length / sampleRate;
  const frameCount = Math.max(1, Math.ceil(input.length / hop));

  const frameRms = new Float64Array(frameCount);
  let hasSignal = false;

  for (let frame = 0; frame < frameCount; frame++) {
    const start = frame * hop;
    const end = Math.min(input.length, start + frameLength);
    let sum = 0;
    for (let i = start; i < end; i++) {
      const sample = input[i];
      if (Number.isFinite(sample)) {
        sum += sample * sample;
      }
    }
    const value = Math.sqrt(sum / Math.max(1, end - start));
    frameRms[frame] = value;
    if (value > 1e-7) {
      hasSignal = true;
    }
  }

  if (!hasSignal) {
    return [];
  }

  // Pure digital silence is represented by a tiny value rather than -Inf so it
  // does not dominate the percentile in a way that hides quiet speech.
  const sortedRms = Array.from(frameRms, (value) =>
    value > 1e-7 ? value : 1e-9,
  ).sort((a, b) => a - b);
  let noiseFloor = percentile(sortedRms, 0.1);
  if (!Number.isFinite(noiseFloor) || noiseFloor < 1e-7) {
    noiseFloor = 0;
  }

  const onThreshold = Math.max(noiseFloor * thresholdFactor, 0.0035);
  const offThreshold = Math.max(onThreshold * 0.5, 0.00175);

  // Hysteresis state machine.
  const rawSegments: SpeechSegment[] = [];
  let active = false;
  let segmentStartFrame = 0;

  for (let frame = 0; frame < frameCount; frame++) {
    const value = frameRms[frame];
    if (!active) {
      if (value >= onThreshold) {
        active = true;
        segmentStartFrame = frame;
      }
    } else if (value < offThreshold) {
      active = false;
      rawSegments.push({
        start: (segmentStartFrame * hop) / sampleRate,
        end: ((frame - 1) * hop + frameLength) / sampleRate,
      });
    }
  }

  if (active) {
    rawSegments.push({
      start: (segmentStartFrame * hop) / sampleRate,
      end: ((frameCount - 1) * hop + frameLength) / sampleRate,
    });
  }

  // Convert to valid times and merge gaps shorter than minSilence.
  let merged: SpeechSegment[] = [];
  for (const segment of rawSegments) {
    const start = Math.max(0, Math.min(duration, segment.start));
    const end = Math.max(start, Math.min(duration, segment.end));
    if (end <= start) {
      continue;
    }
    const previous = merged[merged.length - 1];
    if (previous && start - previous.end < minSilence) {
      previous.end = Math.max(previous.end, end);
    } else {
      merged.push({ start, end });
    }
  }

  // Discard segments that are too short.
  merged = merged.filter((segment) => segment.end - segment.start >= minSpeech);
  if (merged.length === 0) {
    return [];
  }

  // Pad each side, clamped to the signal bounds.
  for (const segment of merged) {
    segment.start = Math.max(0, segment.start - pad);
    segment.end = Math.min(duration, segment.end + pad);
  }

  // Padding may have made neighbours overlap. Keep the output non-overlapping.
  const nonOverlapping: SpeechSegment[] = [];
  for (const segment of merged) {
    const previous = nonOverlapping[nonOverlapping.length - 1];
    if (previous && segment.start <= previous.end) {
      previous.end = Math.max(previous.end, segment.end);
    } else {
      nonOverlapping.push({ ...segment });
    }
  }

  // Split over-long segments near the boundary, choosing the quietest frame.
  const frameStart = (frame: number): number => (frame * hop) / sampleRate;
  const result: SpeechSegment[] = [];

  for (const segment of nonOverlapping) {
    let start = segment.start;
    const end = segment.end;

    while (end - start > maxSegment) {
      const boundary = start + maxSegment;
      const searchStart = Math.max(start + maxSegment * 0.5, boundary - 2);
      const searchEnd = boundary;

      let split = boundary;
      let lowestEnergy = Number.POSITIVE_INFINITY;

      const firstFrame = Math.max(
        0,
        Math.ceil((searchStart * sampleRate) / hop),
      );
      const lastFrame = Math.min(
        frameCount - 1,
        Math.floor((searchEnd * sampleRate) / hop),
      );

      for (let frame = firstFrame; frame <= lastFrame; frame++) {
        const time = frameStart(frame);
        if (time <= start + 1e-6 || time >= end - 1e-6) {
          continue;
        }
        if (frameRms[frame] < lowestEnergy) {
          lowestEnergy = frameRms[frame];
          split = time;
        }
      }

      if (!(split > start + 1e-6) || !(split < end - 1e-6)) {
        split = boundary;
      }

      result.push({ start, end: split });
      start = split;
    }

    if (end > start) {
      result.push({ start, end });
    }
  }

  result.sort((a, b) => a.start - b.start);

  // Ensure the final list is non-overlapping even after splitting. Adjacent
  // segments that merely touch at a split boundary must stay separate.
  const cleaned: SpeechSegment[] = [];
  for (const segment of result) {
    const previous = cleaned[cleaned.length - 1];
    if (previous && segment.start < previous.end - 1e-9) {
      previous.end = Math.max(previous.end, segment.end);
    } else if (segment.end > segment.start) {
      cleaned.push(segment);
    }
  }

  return cleaned;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Encode mono float samples as a 16-bit PCM RIFF/WAVE byte stream.
 * Samples outside [-1, 1] are clamped.
 */
export function encodeWavBytes(
  samples: Float32Array,
  sampleRate: number,
): Uint8Array<ArrayBuffer> {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const rate =
    isFiniteNumber(sampleRate) && sampleRate > 0
      ? Math.round(sampleRate)
      : 44100;

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const value = finiteOrZero(samples[i]);
    const clamped = Math.max(-1, Math.min(1, value));
    const integer =
      clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(offset, integer, true);
    offset += 2;
  }

  return bytes;
}

/** Wrap {@link encodeWavBytes} in a Blob with the standard WAV MIME type. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  return new Blob([encodeWavBytes(samples, sampleRate)], { type: 'audio/wav' });
}

/** Concatenate float chunks into a single newly allocated array. */
export function concatFloat32(chunks: Float32Array[]): Float32Array {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.length;
  }

  const out = new Float32Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Copy samples in the half-open index range [start, end), clamped to bounds. */
export function sliceSamples(
  input: Float32Array,
  start: number,
  end: number,
): Float32Array {
  const from = Number.isFinite(start) ? Math.floor(start) : 0;
  const to = Number.isFinite(end) ? Math.floor(end) : input.length;
  const safeStart = Math.max(0, Math.min(input.length, from));
  const safeEnd = Math.max(safeStart, Math.min(input.length, to));
  return input.slice(safeStart, safeEnd);
}

/** Root-mean-square over the half-open sample range [start, end). */
export function rms(
  input: Float32Array,
  start: number = 0,
  end: number = input.length,
): number {
  const from = Math.max(0, Math.min(input.length, Math.floor(start)));
  const to = Math.max(from, Math.min(input.length, Math.floor(end)));
  if (to <= from) {
    return 0;
  }

  let sum = 0;
  for (let i = from; i < to; i++) {
    const sample = input[i];
    if (Number.isFinite(sample)) {
      sum += sample * sample;
    }
  }
  return Math.sqrt(sum / (to - from));
}

/** Largest absolute sample value, or 0 for an empty/silent array. */
export function peak(input: Float32Array): number {
  let maximum = 0;
  for (let i = 0; i < input.length; i++) {
    const sample = input[i];
    if (Number.isFinite(sample)) {
      const magnitude = Math.abs(sample);
      if (magnitude > maximum) {
        maximum = magnitude;
      }
    }
  }
  return maximum;
}
