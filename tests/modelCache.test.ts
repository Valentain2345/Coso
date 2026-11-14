import { describe, expect, it, vi } from 'vitest';
import { createOpfsModelCache, modelCacheKey } from '../src/lib/audio/modelCache';

/** Minimal in-memory OPFS used to exercise the cache without a browser. */
function fakeStorage() {
  const files = new Map<string, Blob>();

  const dir = {
    async getDirectoryHandle(name: string) {
      expect(name).toBe('coso-models');
      return dir;
    },
    async getFileHandle(name: string, options?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!options?.create) throw new DOMException('not found', 'NotFoundError');
        files.set(name, new Blob([]));
      }
      return {
        async getFile() {
          return files.get(name)!;
        },
        async createWritable() {
          const chunks: BlobPart[] = [];
          return {
            async write(chunk: BlobPart) {
              chunks.push(chunk);
            },
            async close() {
              files.set(name, new Blob(chunks));
            },
          };
        },
      };
    },
    async removeEntry(name: string) {
      if (!files.delete(name)) throw new DOMException('not found', 'NotFoundError');
    },
  };

  return {
    files,
    storage: { getDirectory: async () => dir as unknown as FileSystemDirectoryHandle },
  };
}

const MODEL_URL = 'https://huggingface.co/onnx-community/whisper-base/resolve/main/onnx/encoder_model.onnx';

describe('modelCacheKey', () => {
  it('hashes URLs into short filesystem-safe names', async () => {
    const key = await modelCacheKey(MODEL_URL);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain('/');
    expect(key).not.toContain(':');
    expect(await modelCacheKey(MODEL_URL)).toBe(key);
    expect(await modelCacheKey(`${MODEL_URL}.other`)).not.toBe(key);
  });
});

describe('createOpfsModelCache', () => {
  it('is unavailable without OPFS so the browser cache is used', () => {
    expect(createOpfsModelCache({ storage: null })).toBeNull();
  });

  it('stores and serves model bytes from files', async () => {
    const { files, storage } = fakeStorage();
    const cache = createOpfsModelCache({ storage })!;

    const payload = new Uint8Array([1, 2, 3, 4, 250]);
    await cache.put(MODEL_URL, new Response(payload));

    expect(files.size).toBe(1);
    const [name] = [...files.keys()];
    expect(name).toBe(await modelCacheKey(MODEL_URL));

    const hit = await cache.match(MODEL_URL);
    expect(hit).toBeInstanceOf(Response);
    expect(new Uint8Array(await hit!.arrayBuffer())).toEqual(payload);
  });

  it('returns undefined for a model that was never downloaded', async () => {
    const { storage } = fakeStorage();
    const cache = createOpfsModelCache({ storage })!;
    expect(await cache.match(MODEL_URL)).toBeUndefined();
  });

  it('deletes a model and reports whether it existed', async () => {
    const { storage } = fakeStorage();
    const cache = createOpfsModelCache({ storage })!;
    await cache.put(MODEL_URL, new Response(new Uint8Array([9])));

    await expect(cache.delete!(MODEL_URL)).resolves.toBe(true);
    expect(await cache.match(MODEL_URL)).toBeUndefined();
    await expect(cache.delete!(MODEL_URL)).resolves.toBe(false);
  });

  it('streams large downloads and reports progress', async () => {
    const { storage } = fakeStorage();
    const cache = createOpfsModelCache({ storage })!;
    const progress = vi.fn();

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
        controller.enqueue(new Uint8Array(6));
        controller.close();
      },
    });
    await cache.put(
      MODEL_URL,
      new Response(body, { headers: { 'content-length': '10' } }),
      progress,
    );

    expect(progress).toHaveBeenCalled();
    const last = progress.mock.calls.at(-1)![0];
    expect(last.loaded).toBe(10);
    expect(last.total).toBe(10);
    expect(last.progress).toBe(100);

    const hit = await cache.match(MODEL_URL);
    expect((await hit!.arrayBuffer()).byteLength).toBe(10);
  });
});
