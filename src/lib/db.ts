import type { JobRecord, JobState, Session, SessionMeta, Settings } from '../types';

export const DB_NAME = 'coso-audio';
export const DB_VERSION = 3;

const SESSION_STORE = 'sessions';
// Lightweight mirror of every session: startup lists this store so opening the
// app never deserialises audio blobs or transcript segments.
const SESSION_META_STORE = 'sessionMeta';
const SETTINGS_STORE = 'settings';
const JOB_STORE = 'jobs';
const JOB_AUDIO_STORE = 'jobAudio';
const SETTINGS_KEY = 'app';

interface SettingsRecord {
  key: typeof SETTINGS_KEY;
  value: Settings;
}

/** Cached connection promise. Exported so callers can share the same connection. */
export let dbPromise: Promise<IDBDatabase> | null = null;

/** Resolved connection, kept so `closeDatabase()` can close it synchronously. */
let resolvedDb: IDBDatabase | null = null;

/**
 * Open (or reuse) the application database.
 *
 * The promise is cached until `closeDatabase()` is called. Opening errors,
 * blocked upgrades and unexpected version changes are surfaced as rejections
 * instead of hanging forever.
 */
export function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  if (typeof indexedDB === 'undefined') {
    const unavailable = Promise.reject<IDBDatabase>(
      new Error('IndexedDB is not available in this environment'),
    );
    // Do not cache this failure: the environment may gain IndexedDB later
    // (for example during client-side hydration).
    unavailable.catch(() => undefined);
    return unavailable;
  }

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;

    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = (event) => {
      try {
        const db = request.result;
        const previousVersion = event.oldVersion ?? 0;
        const tx = request.transaction;

        let sessions: IDBObjectStore;
        if (!db.objectStoreNames.contains(SESSION_STORE)) {
          sessions = db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
        } else if (tx) {
          sessions = tx.objectStore(SESSION_STORE);
        } else {
          throw new Error('Missing transaction while upgrading sessions store');
        }

        if (!sessions.indexNames.contains('createdAt')) {
          sessions.createIndex('createdAt', 'createdAt', { unique: false });
        }

        let metas: IDBObjectStore;
        if (!db.objectStoreNames.contains(SESSION_META_STORE)) {
          metas = db.createObjectStore(SESSION_META_STORE, { keyPath: 'id' });
        } else if (tx) {
          metas = tx.objectStore(SESSION_META_STORE);
        } else {
          throw new Error('Missing transaction while upgrading sessionMeta store');
        }

        // v2 stored everything in one record. Backfill the lightweight mirror
        // while the upgrade transaction is still open.
        if (previousVersion < 3) {
          sessions.openCursor().onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) return;
            metas.put(toSessionMeta(cursor.value as Session));
            cursor.continue();
          };
        }

        if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
          db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
        }

        if (!db.objectStoreNames.contains(JOB_STORE)) {
          db.createObjectStore(JOB_STORE, { keyPath: 'id' });
        }

        if (!db.objectStoreNames.contains(JOB_AUDIO_STORE)) {
          db.createObjectStore(JOB_AUDIO_STORE, { keyPath: 'id' });
        }
      } catch (error) {
        // Abort the version-change transaction so the open request fails
        // cleanly instead of leaving the database half upgraded.
        try {
          request.transaction?.abort();
        } catch {
          // Ignore: the transaction may already have finished.
        }
        reject(error);
      }
    };

    request.onsuccess = () => {
      const db = request.result;

      // The caller closed the database while this open was in flight.
      if (dbPromise !== promise) {
        try {
          db.close();
        } catch {
          // Ignore close failures during cleanup.
        }
        reject(new Error('Database connection was closed before it opened'));
        return;
      }

      resolvedDb = db;

      db.onversionchange = () => {
        // Another context wants to upgrade the schema. Release our hold so it
        // is not blocked, and forget the stale connection.
        try {
          db.close();
        } catch {
          // Ignore close failures.
        }
        if (resolvedDb === db) resolvedDb = null;
        if (dbPromise === promise) dbPromise = null;
      };

      db.onclose = () => {
        if (resolvedDb === db) resolvedDb = null;
        if (dbPromise === promise) dbPromise = null;
      };

      resolve(db);
    };

    request.onerror = () => {
      if (dbPromise === promise) dbPromise = null;
      reject(request.error ?? new Error(`Failed to open IndexedDB "${DB_NAME}"`));
    };

    request.onblocked = () => {
      // This tab's own connection may be the one holding the old version
      // open. Close it so the pending upgrade can proceed.
      if (resolvedDb) {
        try {
          resolvedDb.close();
        } catch {
          // Ignore close failures.
        }
        resolvedDb = null;
      }
    };
  });

  dbPromise = promise;

  // Ensure a failed open does not poison the cache for later attempts.
  promise.catch(() => {
    if (dbPromise === promise) dbPromise = null;
  });

  return promise;
}

/** Close the cached connection (used by tests and HMR). */
export function closeDatabase(): void {
  const db = resolvedDb;
  resolvedDb = null;
  dbPromise = null;

  if (db) {
    try {
      db.close();
    } catch {
      // Ignore close failures.
    }
  }
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/**
 * Run a single operation inside a transaction.
 *
 * The returned promise resolves only once the transaction has completed, and
 * rejects if the transaction errors or aborts.
 */
function runTransaction<T>(
  storeName: string | string[],
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, tx: IDBTransaction) => T | Promise<T>,
): Promise<T> {
  return openDatabase().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        let tx: IDBTransaction;

        try {
          tx = db.transaction(storeName, mode);
        } catch (error) {
          reject(error);
          return;
        }

        let outcome: T | Promise<T>;

        try {
          const primary = Array.isArray(storeName) ? storeName[0] : storeName;
          outcome = run(tx.objectStore(primary), tx);
        } catch (error) {
          try {
            tx.abort();
          } catch {
            // Ignore abort failures (the transaction may already be done).
          }
          reject(error);
          return;
        }

        const result = Promise.resolve(outcome);
        // Prevent an unhandled rejection if the transaction fails before the
        // completion handler attaches.
        result.catch(() => undefined);

        tx.oncomplete = () => {
          result.then(resolve, reject);
        };
        tx.onerror = () => {
          reject(tx.error ?? new Error('IndexedDB transaction failed'));
        };
        tx.onabort = () => {
          reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        };
      }),
  );
}

/** Only the lightweight metadata fields, never audio or transcript segments. */
function toSessionMeta(session: Session): SessionMeta {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    duration: session.duration,
    language: session.language,
    model: session.model,
    speakerCount: session.speakerCount,
    wordCount: session.wordCount,
    sourceName: session.sourceName,
  };
}

/** List session metadata, newest first. Heavy fields are stripped. */
export async function listSessions(): Promise<SessionMeta[]> {
  const metas = await runTransaction<SessionMeta[]>(
    SESSION_META_STORE,
    'readonly',
    (store) => requestToPromise(store.getAll() as IDBRequest<SessionMeta[]>),
  );

  // Safety net for a database whose meta mirror is missing (for example an
  // upgrade interrupted before the backfill): rebuild it from the full store.
  if (metas.length === 0) {
    return rebuildSessionMeta();
  }

  return metas.slice().sort((a, b) => b.createdAt - a.createdAt);
}

async function rebuildSessionMeta(): Promise<SessionMeta[]> {
  const sessions = await runTransaction<Session[]>(
    SESSION_STORE,
    'readonly',
    (store) => requestToPromise(store.getAll() as IDBRequest<Session[]>),
  );
  const metas = sessions.map(toSessionMeta);
  if (metas.length > 0) {
    await runTransaction(SESSION_META_STORE, 'readwrite', (store) => {
      for (const meta of metas) store.put(meta);
      return undefined;
    });
  }
  return metas.sort((a, b) => b.createdAt - a.createdAt);
}

/** Fetch a complete session, including audio and segments. */
export async function getSession(id: string): Promise<Session | null> {
  const session = await runTransaction<Session | undefined>(
    SESSION_STORE,
    'readonly',
    (store) => requestToPromise(store.get(id) as IDBRequest<Session | undefined>),
  );

  return session ?? null;
}

/** Insert or replace a session and its lightweight metadata mirror. */
export async function saveSession(session: Session): Promise<void> {
  await runTransaction([SESSION_STORE, SESSION_META_STORE], 'readwrite', (store, tx) => {
    const result = store.put(session);
    tx.objectStore(SESSION_META_STORE).put(toSessionMeta(session));
    return requestToPromise(result);
  });
}

/** Delete one session by id. Missing ids are ignored. */
export async function deleteSession(id: string): Promise<void> {
  await runTransaction([SESSION_STORE, SESSION_META_STORE], 'readwrite', (store, tx) => {
    const result = store.delete(id);
    tx.objectStore(SESSION_META_STORE).delete(id);
    return requestToPromise(result);
  });
}

/** Remove every stored session. Settings are left untouched. */
export async function clearSessions(): Promise<void> {
  await runTransaction([SESSION_STORE, SESSION_META_STORE], 'readwrite', (store, tx) => {
    const result = store.clear();
    tx.objectStore(SESSION_META_STORE).clear();
    return requestToPromise(result);
  });
}

/** Load the persisted settings, or null when nothing has been saved yet. */
export async function loadSettings(): Promise<Partial<Settings> | null> {
  const record = await runTransaction<SettingsRecord | undefined>(
    SETTINGS_STORE,
    'readonly',
    (store) =>
      requestToPromise(
        store.get(SETTINGS_KEY) as IDBRequest<SettingsRecord | undefined>,
      ),
  );

  return record?.value ?? null;
}

/** Persist the full settings object under the single 'app' key. */
export async function saveSettings(settings: Settings): Promise<void> {
  const record: SettingsRecord = { key: SETTINGS_KEY, value: settings };

  await runTransaction(SETTINGS_STORE, 'readwrite', (store) =>
    requestToPromise(store.put(record)),
  );
}

/**
 * Best-effort storage estimate. Returns null when the Storage API is not
 * available (for example in Node) or the estimate fails.
 */
export async function estimateStorage(): Promise<{
  usage: number;
  quota: number;
} | null> {
  if (
    typeof navigator === 'undefined' ||
    !navigator.storage ||
    typeof navigator.storage.estimate !== 'function'
  ) {
    return null;
  }

  try {
    const estimate = await navigator.storage.estimate();
    return {
      usage: typeof estimate.usage === 'number' ? estimate.usage : 0,
      quota: typeof estimate.quota === 'number' ? estimate.quota : 0,
    };
  } catch {
    return null;
  }
}

interface JobAudioRecord {
  id: string;
  blob: Blob | null;
  mime: string | null;
}

/** Persist a new checkpoint together with its source audio. */
export async function createJob(job: JobState, audioBlob: Blob | null): Promise<void> {
  await runTransaction(JOB_STORE, 'readwrite', (store) =>
    requestToPromise(store.put(job)),
  );
  const audio: JobAudioRecord = { id: job.id, blob: audioBlob, mime: job.audioMime };
  await runTransaction(JOB_AUDIO_STORE, 'readwrite', (store) =>
    requestToPromise(store.put(audio)),
  );
}

/** Update the lightweight checkpoint only; the audio blob is left untouched. */
export async function updateJob(job: JobState): Promise<void> {
  await runTransaction(JOB_STORE, 'readwrite', (store) =>
    requestToPromise(store.put(job)),
  );
}

/** Newest first. States only, without audio bytes. */
export async function listJobs(): Promise<JobState[]> {
  const jobs = await runTransaction<JobState[]>(
    JOB_STORE,
    'readonly',
    (store) => requestToPromise(store.getAll() as IDBRequest<JobState[]>),
  );
  return jobs.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Fetch a checkpoint with its source audio. */
export async function getJob(id: string): Promise<JobRecord | null> {
  const job = await runTransaction<JobState | undefined>(
    JOB_STORE,
    'readonly',
    (store) => requestToPromise(store.get(id) as IDBRequest<JobState | undefined>),
  );
  if (!job) return null;

  const audio = await runTransaction<JobAudioRecord | undefined>(
    JOB_AUDIO_STORE,
    'readonly',
    (store) => requestToPromise(store.get(id) as IDBRequest<JobAudioRecord | undefined>),
  );

  return { ...job, audioBlob: audio?.blob ?? null };
}

/** Remove a checkpoint and its audio. Missing ids are ignored. */
export async function deleteJob(id: string): Promise<void> {
  await runTransaction(JOB_STORE, 'readwrite', (store) =>
    requestToPromise(store.delete(id)),
  );
  await runTransaction(JOB_AUDIO_STORE, 'readwrite', (store) =>
    requestToPromise(store.delete(id)),
  );
}

/** Remove every unfinished checkpoint. Saved sessions are left untouched. */
export async function clearJobs(): Promise<void> {
  await runTransaction(JOB_STORE, 'readwrite', (store) =>
    requestToPromise(store.clear()),
  );
  await runTransaction(JOB_AUDIO_STORE, 'readwrite', (store) =>
    requestToPromise(store.clear()),
  );
}

/** Generate a unique id, preferring the platform UUID implementation. */
export function newId(): string {
  const cryptoObject =
    typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;

  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }

  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    const bytes = cryptoObject.getRandomValues(new Uint8Array(16));
    // Set the version (4) and variant bits, matching RFC 4122.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');

    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  }

  return `${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
}
