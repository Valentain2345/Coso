import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny';

/** A contiguous slice of mono audio, positioned on the original timeline. */
export interface AudioChunk {
  samples: Float32Array;
  sampleRate: number;
  start: number;
  duration: number;
}

export interface StreamedAudio {
  duration: number;
  sampleRate: number;
  channels: number;
  chunks(chunkSeconds?: number, from?: number, signal?: AbortSignal): AsyncGenerator<AudioChunk>;
  dispose(): void;
}

function downmix(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  if (channels <= 1) return buffer.getChannelData(0);

  const length = buffer.length;
  const out = new Float32Array(length);
  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) out[index] += data[index];
  }
  const scale = 1 / channels;
  for (let index = 0; index < length; index += 1) out[index] *= scale;
  return out;
}

/**
 * Opens an audio file for sequential, memory-bounded decoding.
 *
 * Mediabunny reads only the bytes it needs, so a four-hour file never has to
 * live in memory as one giant Float32Array. Callers pull fixed-duration chunks
 * and can persist their progress between chunks.
 */
export async function openStreamedAudio(blob: Blob): Promise<StreamedAudio> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob, { maxCacheSize: 24 * 1024 * 1024 }),
  });

  try {
    if (!(await input.canRead())) {
      throw new Error('This file format could not be recognised.');
    }

    const track = await input.getPrimaryAudioTrack();
    if (!track) throw new Error('This file has no audio track.');
    if (!(await track.canDecode())) {
      throw new Error('This browser cannot decode the audio codec in this file.');
    }

    const [duration, sampleRate, channels] = await Promise.all([
      input.computeDuration(),
      track.getSampleRate(),
      track.getNumberOfChannels(),
    ]);

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error('The audio duration could not be determined.');
    }

    const sink = new AudioBufferSink(track);

    async function* chunks(
      chunkSeconds = 60,
      from = 0,
      signal?: AbortSignal,
    ): AsyncGenerator<AudioChunk> {
      const chunkLength = Math.max(1, Math.round(chunkSeconds * sampleRate));
      const totalSamples = Math.round(duration * sampleRate);
      let chunkStart = Math.max(0, Math.min(totalSamples, Math.round(from * sampleRate)));
      let chunk = new Float32Array(chunkLength);

      for await (const frame of sink.buffers(from, duration)) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');

        const mono = downmix(frame.buffer);
        let position = Math.round(frame.timestamp * sampleRate);
        let remaining = mono;

        if (position + remaining.length <= chunkStart) continue;
        if (position < chunkStart) {
          remaining = remaining.subarray(chunkStart - position);
          position = chunkStart;
        }

        while (remaining.length > 0) {
          const offset = position - chunkStart;
          const take = Math.min(remaining.length, chunkLength - offset);
          chunk.set(remaining.subarray(0, take), offset);
          position += take;
          remaining = remaining.subarray(take);

          if (position - chunkStart >= chunkLength) {
            yield {
              samples: chunk,
              sampleRate,
              start: chunkStart / sampleRate,
              duration: chunkLength / sampleRate,
            };
            chunk = new Float32Array(chunkLength);
            chunkStart += chunkLength;
          }
        }
      }

      const tailLength = Math.min(chunkLength, totalSamples - chunkStart);
      if (tailLength > 0) {
        yield {
          samples: chunk.subarray(0, tailLength),
          sampleRate,
          start: chunkStart / sampleRate,
          duration: tailLength / sampleRate,
        };
      }
    }

    return {
      duration,
      sampleRate,
      channels,
      chunks,
      dispose: () => input.dispose(),
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}
