/**
 * Filesystem-backed model cache (Origin Private File System).
 *
 * Whisper weights are large (hundreds of MB). Keeping them as files instead of
 * Cache API entries means the app shell never pays for them at startup, and the
 * data survives cache eviction pressure from ordinary web storage. WebView2 on
 * Windows and the Android WebView both expose OPFS.
 *
 * The interface matches the subset of the Web Cache API that transformers.js
 * uses (`match`/`put`/`delete`).
 */

export interface ModelCache {
  match(request: string): Promise<Response | undefined>;
  put(
    request: string,
    response: Response,
    progress?: (data: { progress: number; loaded: number; total: number }) => void,
  ): Promise<void>;
  delete?(request: string): Promise<boolean>;
}

interface StorageManagerLike {
  getDirectory(): Promise<FileSystemDirectoryHandle>;
}

export interface ModelCacheOptions {
  /** Injectable storage manager, used by tests. Defaults to navigator.storage. */
  storage?: StorageManagerLike | null;
  /** Directory name inside the origin's private filesystem. */
  directory?: string;
}

const CACHE_DIRECTORY = 'coso-models';

/** Deterministic, filesystem-safe key: the URL itself is far too long/invalid. */
export async function modelCacheKey(request: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', new TextEncoder().encode(request));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  // Non-secure contexts have no SubtleCrypto; FNV-1a is enough to avoid
  // collisions between the handful of model files.
  let hash = 0x811c9dc5;
  for (let i = 0; i < request.length; i += 1) {
    hash ^= request.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv${hash.toString(16).padStart(8, '0')}`;
}

function storageManagerFor(options: ModelCacheOptions): StorageManagerLike | null {
  if (options.storage !== undefined) return options.storage;
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return null;
  return navigator.storage;
}

/**
 * Build the cache, or return null when the environment has no OPFS so the
 * caller can keep using the browser Cache API.
 */
export function createOpfsModelCache(options: ModelCacheOptions = {}): ModelCache | null {
  const storage = storageManagerFor(options);
  if (!storage) return null;

  const directoryName = options.directory ?? CACHE_DIRECTORY;
  let directoryPromise: Promise<FileSystemDirectoryHandle> | null = null;

  const directory = (): Promise<FileSystemDirectoryHandle> => {
    directoryPromise ??= storage
      .getDirectory()
      .then((root) => root.getDirectoryHandle(directoryName, { create: true }));
    // A failed open must be retried next time instead of caching the rejection.
    directoryPromise.catch(() => {
      directoryPromise = null;
    });
    return directoryPromise;
  };

  const file = async (request: string, create: boolean): Promise<FileSystemFileHandle> => {
    const dir = await directory();
    return dir.getFileHandle(await modelCacheKey(request), { create });
  };

  return {
    async match(request) {
      try {
        const handle = await file(request, false);
        const stored = await handle.getFile();
        return new Response(stored);
      } catch {
        return undefined;
      }
    },

    async put(request, response, progress) {
      const handle = await file(request, true);
      const writable = await handle.createWritable();
      const total = Number(response.headers.get('content-length') ?? 0) || 0;

      if (!response.body) {
        const buffer = await response.arrayBuffer();
        await writable.write(buffer);
        progress?.({ progress: 100, loaded: buffer.byteLength, total: buffer.byteLength });
        await writable.close();
        return;
      }

      const reader = response.body.getReader();
      let loaded = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
          loaded += value.byteLength;
          if (progress && total > 0) {
            progress({ progress: Math.min(100, (loaded / total) * 100), loaded, total });
          }
        }
      } finally {
        reader.releaseLock();
      }
      await writable.close();
    },

    async delete(request) {
      try {
        const dir = await directory();
        await dir.removeEntry(await modelCacheKey(request));
        return true;
      } catch {
        return false;
      }
    },
  };
}
