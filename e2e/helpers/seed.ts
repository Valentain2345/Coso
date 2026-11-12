import type { Page } from '@playwright/test';

/**
 * Seeds the app's IndexedDB ('coso-audio' v2) with ready-made sessions so E2E
 * tests can exercise library flows without running a real transcription first.
 *
 * Must be called AFTER `page.goto` — Chromium denies IndexedDB on about:blank.
 * Reload afterwards for the app to pick up the data.
 */

export interface SeedSession {
  id: string;
  title: string;
  ageDays?: number;
  duration?: number;
  words?: number;
  speakers?: number;
}

function segmentsFor(speakers: number) {
  const lines = [
    ['Good morning everyone, today we are going to talk about the water cycle.', 0, 6.2],
    ['Evaporation moves water from the ocean into the atmosphere.', 6.4, 12.1],
    ['Then condensation forms the clouds we see every day.', 12.3, 17.5],
    ['Professor, does wind change how fast clouds move?', 18.0, 23.4],
    ['Great question. Yes, wind can move clouds thousands of kilometers.', 23.8, 30.2],
    ['Finally, precipitation returns the water to the ground as rain or snow.', 30.6, 37.0],
  ];
  return lines.map(([text, start, end], index) => ({
    id: `seed-${index}`,
    start,
    end,
    text,
    speaker: index === 3 && speakers > 1 ? 1 : 0,
    confidence: 0.93,
  }));
}

export async function seedSessions(page: Page, sessions: SeedSession[]): Promise<void> {
  await page.evaluate((list) => {
    const DAY = 86_400_000;
    const now = Date.now();
    return new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('coso-audio', 2);
      open.onupgradeneeded = () => {
        const db = open.result;
        for (const store of ['sessions', 'settings', 'jobs', 'jobAudio']) {
          if (!db.objectStoreNames.contains(store)) db.createObjectStore(store, { keyPath: 'id' });
        }
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('sessions', 'readwrite');
        const store = tx.objectStore('sessions');
        for (const seed of list) {
          store.put({
            id: seed.id,
            title: seed.title,
            createdAt: now - (seed.ageDays ?? 1) * DAY,
            updatedAt: now - (seed.ageDays ?? 1) * DAY,
            duration: seed.duration ?? 38,
            language: 'en',
            model: 'whisper-base',
            speakerCount: seed.speakers ?? 2,
            wordCount: seed.words ?? 46,
            sourceName: null,
            segments: segmentsFor(seed.speakers ?? 2),
            audioBlob: null,
            audioMime: 'audio/wav',
            peaks: Array.from({ length: 140 }, (_, i) =>
              Math.max(0.08, Math.abs(Math.sin(i * 0.23) * 0.5 + Math.sin(i * 0.07) * 0.4) * 0.8 + 0.1),
            ),
          });
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, sessions);
}

/** Standard three-session library used by library/side tests. */
export const DEFAULT_LIBRARY: SeedSession[] = [
  { id: 'seeded-0', title: 'Biology — The water cycle', ageDays: 0, words: 46 },
  { id: 'seeded-1', title: 'Biology — The water cycle (part 2)', ageDays: 1, words: 39 },
  { id: 'seeded-2', title: 'History — Trade routes', ageDays: 9, words: 52 },
];
