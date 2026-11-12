import { resample } from './dsp';

/** Decodes any browser-supported audio file into mono float samples. */
export async function decodeToMono16k(source: Blob | ArrayBuffer): Promise<{
  samples: Float32Array;
  sampleRate: number;
  duration: number;
}> {
  const buffer = source instanceof Blob ? await source.arrayBuffer() : source;
  if (!buffer.byteLength) throw new Error('The audio file is empty.');

  const AudioContextCtor: typeof AudioContext =
    window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
  if (!AudioContextCtor) throw new Error('This browser cannot decode audio.');

  let context: AudioContext;
  try {
    context = new AudioContextCtor({ sampleRate: 16000 });
  } catch {
    context = new AudioContextCtor();
  }

  try {
    const decoded = await context.decodeAudioData(buffer.slice(0));
    const channels: Float32Array[] = [];
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      channels.push(decoded.getChannelData(channel));
    }
    const mono = downmix(channels);
    const samples = decoded.sampleRate === 16000 ? mono : resample(mono, decoded.sampleRate, 16000);
    return { samples, sampleRate: 16000, duration: samples.length / 16000 };
  } catch {
    throw new Error(
      'This audio could not be decoded. Try a WAV, MP3, M4A, OGG, FLAC, or WebM file that plays in your browser.',
    );
  } finally {
    void context.close();
  }
}

export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0].slice();

  const length = Math.min(...channels.map((channel) => channel.length));
  const output = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[index];
    output[index] = sum / channels.length;
  }
  return output;
}

/** Evenly-spaced peak values in 0..1, used for compact waveform previews. */
export function computePeaks(samples: Float32Array, buckets = 160): number[] {
  if (samples.length === 0) return [];
  const size = Math.max(1, Math.floor(samples.length / buckets));
  const peaks: number[] = [];
  for (let bucket = 0; bucket < buckets; bucket += 1) {
    const start = bucket * size;
    const end = bucket === buckets - 1 ? samples.length : Math.min(samples.length, start + size);
    let max = 0;
    for (let index = start; index < end; index += 1) {
      const value = Math.abs(samples[index]);
      if (value > max) max = value;
    }
    peaks.push(max);
  }
  const loudest = Math.max(...peaks, 0.0001);
  return peaks.map((value) => Math.min(1, value / loudest));
}
