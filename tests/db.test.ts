import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Session, Settings } from '../src/types';
import {
  DB_NAME,
  clearSessions,
  closeDatabase,
  deleteSession,
  estimateStorage,
  getSession,
  listSessions,
  loadSettings,
  newId,
  openDatabase,
  saveSession,
  saveSettings,
} from '../src/lib/db';

const META_FIELDS = [
  'id',
  'title',
  'createdAt',
  'updatedAt',
  'duration',
  'language',
  'model',
  'speakerCount',
  'wordCount',
  'sourceName',
].sort();

let sessionCounter = 0;

function makeSession(overrides: Partial<Session> = {}): Session {
  sessionCounter += 1;
  const timestamp = 1_700_000_000_000 + sessionCounter;

  return {
    id: newId(),
    title: `Session ${sessionCounter}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    duration: 42.5,
    language: 'en',
    model: 'whisper-base',
    speakerCount: 2,
    wordCount: 7,
    sourceName: null,
    segments: [
      {
        id: `segment-${sessionCounter}`,
        start: 0,
        end: 1.25,
        text: 'Hello world',
        speaker: 0,
        confidence: 0.92,
      },
    ],
    audioBlob: new Blob(['fake audio bytes'], { type: 'audio/wav' }),
    audioMime: 'audio/wav',
    ...overrides,
  };
}

function deleteDatabase(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () =>
      reject(request.error ?? new Error('Failed to delete test database'));
    request.onblocked = () =>
      reject(new Error('Deleting the test database was blocked'));
  });
}

beforeEach(async () => {
  closeDatabase();
  await deleteDatabase();
});

afterEach(() => {
  closeDatabase();
});

describe('sessions', () => {
  it('lists saved sessions newest first without heavy fields', async () => {
    const older = makeSession({
      title: 'Older',
      createdAt: 1_000,
      updatedAt: 1_500,
    });
    const newer = makeSession({
      title: 'Newer',
      createdAt: 2_000,
      updatedAt: 2_500,
    });

    await saveSession(older);
    await saveSession(newer);

    const sessions = await listSessions();

    expect(sessions.map((session) => session.id)).toEqual([
      newer.id,
      older.id,
    ]);
    expect(sessions[0]).toMatchObject({
      id: newer.id,
      title: 'Newer',
      createdAt: 2_000,
      updatedAt: 2_500,
    });
    expect(sessions[1]).toMatchObject({
      id: older.id,
      title: 'Older',
      createdAt: 1_000,
      updatedAt: 1_500,
    });
  });

  it('strips audioBlob, segments and audioMime from listed sessions', async () => {
    const session = makeSession();
    await saveSession(session);

    const [meta] = await listSessions();

    expect(meta).not.toHaveProperty('audioBlob');
    expect(meta).not.toHaveProperty('segments');
    expect(meta).not.toHaveProperty('audioMime');
    expect(Object.keys(meta).sort()).toEqual(META_FIELDS);
  });

  it('gets a full session including its audio blob', async () => {
    const session = makeSession();
    await saveSession(session);

    const loaded = await getSession(session.id);

    expect(loaded).not.toBeNull();
    expect(loaded).toMatchObject({
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
      audioMime: 'audio/wav',
    });
    expect(loaded?.segments).toEqual(session.segments);
    expect(loaded?.audioBlob).toBeInstanceOf(Blob);
    expect(loaded?.audioBlob?.size).toBe(session.audioBlob?.size);
    expect(loaded?.audioBlob?.type).toBe(session.audioBlob?.type);
  });

  it('returns null for a missing session', async () => {
    expect(await getSession('does-not-exist')).toBeNull();
  });

  it('deletes a session and leaves the others intact', async () => {
    const first = makeSession();
    const second = makeSession();

    await saveSession(first);
    await saveSession(second);

    await deleteSession(first.id);

    expect(await getSession(first.id)).toBeNull();
    expect((await listSessions()).map((session) => session.id)).toEqual([
      second.id,
    ]);

    // Deleting a missing id is a no-op rather than an error.
    await expect(deleteSession('missing-id')).resolves.toBeUndefined();
  });

  it('clears every session without touching settings', async () => {
    const settings: Settings = {
      model: 'whisper-tiny',
      language: 'en',
      device: 'auto',
      denoise: true,
      denoiseQuality: 'neural',
      diarize: false,
      diarizeQuality: 'standard',
      diarizeEngine: 'wespeaker',
      maxSpeakers: 2,
      theme: 'dark',
      textSize: 'md',
    };

    await saveSession(makeSession());
    await saveSession(makeSession());
    await saveSettings(settings);

    await clearSessions();

    expect(await listSessions()).toEqual([]);
    expect(await getSession('anything')).toBeNull();
    expect(await loadSettings()).toEqual(settings);
  });
});

describe('settings', () => {
  it('returns null before anything has been saved', async () => {
    expect(await loadSettings()).toBeNull();
  });

  it('round-trips the full settings object', async () => {
    const settings: Settings = {
      model: 'whisper-small.en',
      language: 'es',
      device: 'webgpu',
      denoise: false,
      denoiseQuality: 'maximum',
      diarize: true,
      diarizeQuality: 'thorough',
      diarizeEngine: 'pyannote',
      maxSpeakers: 6,
      theme: 'system',
      textSize: 'lg',
    };

    await saveSettings(settings);

    expect(await loadSettings()).toEqual(settings);
  });

  it('loads a partial settings record as-is so callers can apply defaults', async () => {
    const db = await openDatabase();

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ key: 'app', value: { theme: 'dark' } });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });

    expect(await loadSettings()).toEqual({ theme: 'dark' });
  });
});

describe('utilities', () => {
  it('returns null from estimateStorage when navigator.storage is unavailable', async () => {
    await expect(estimateStorage()).resolves.toBeNull();
  });

  it('generates unique non-empty ids', () => {
    const ids = Array.from({ length: 200 }, () => newId());

    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
      expect(id).not.toBe(newId());
    }
  });

  it('rejects openDatabase when indexedDB.open throws', async () => {
    const originalOpen = indexedDB.open;

    indexedDB.open = (() => {
      throw new Error('open failed');
    }) as typeof indexedDB.open;

    try {
      await expect(openDatabase()).rejects.toThrow('open failed');
    } finally {
      indexedDB.open = originalOpen;
      closeDatabase();
    }
  });
});
