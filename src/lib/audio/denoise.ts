import { DeepFilter } from '@lofcz/deepfilternet-web';
import wasmUrl from '@lofcz/deepfilternet-web/df_bg.wasm?url';

/**
 * Streaming wrapper around DeepFilterNet3 (48 kHz neural speech enhancement).
 *
 * The model runs one 10 ms frame at a time and keeps its own recurrent state,
 * so audio can be denoised chunk by chunk for hours without loading the whole
 * recording into memory.
 */
export class NeuralDenoiser {
  private filter: DeepFilter | null = null;
  private pending = new Float32Array(0);
  private attenuationLimit = 100;

  get ready(): boolean {
    return this.filter !== null;
  }

  get frameLength(): number {
    return this.filter?.frameLength ?? 480;
  }

  async load(): Promise<void> {
    if (this.filter) return;
    this.filter = await DeepFilter.create({ wasmUrl, attenuationLimit: this.attenuationLimit });
    this.pending = new Float32Array(0);
  }

  setAttenuationLimit(db: number): void {
    this.attenuationLimit = Math.max(0, Math.min(100, db));
    this.filter?.setAttenuationLimit(this.attenuationLimit);
  }

  /** Feed any number of 48 kHz samples; returns complete denoised frames. */
  process(samples: Float32Array): Float32Array {
    const filter = this.filter;
    if (!filter) return samples;

    const frameLength = filter.frameLength;
    let input = samples;
    if (this.pending.length > 0) {
      input = new Float32Array(this.pending.length + samples.length);
      input.set(this.pending, 0);
      input.set(samples, this.pending.length);
    }

    const frames = Math.floor(input.length / frameLength);
    if (frames === 0) {
      this.pending = input.slice();
      return new Float32Array(0);
    }

    const output = new Float32Array(frames * frameLength);
    for (let frame = 0; frame < frames; frame += 1) {
      const start = frame * frameLength;
      output.set(filter.process(input.subarray(start, start + frameLength)), start);
    }

    this.pending = input.slice(frames * frameLength);
    return output;
  }

  /** Emit the final partial frame (zero padded internally). */
  flush(): Float32Array {
    const filter = this.filter;
    if (!filter || this.pending.length === 0) return new Float32Array(0);

    const frameLength = filter.frameLength;
    const length = this.pending.length;
    const padded = new Float32Array(frameLength);
    padded.set(this.pending.subarray(0, Math.min(length, frameLength)));
    this.pending = new Float32Array(0);
    return filter.process(padded).slice(0, length);
  }

  reset(): void {
    this.pending = new Float32Array(0);
  }

  destroy(): void {
    this.filter?.destroy();
    this.filter = null;
    this.pending = new Float32Array(0);
  }
}
