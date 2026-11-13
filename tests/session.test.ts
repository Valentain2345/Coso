import { describe, expect, it } from 'vitest';
import { applyReprocess } from '../src/lib/session';
import type { Session, TranscriptSegment } from '../src/types';

const segment = (id: string, text: string, speaker = 0): TranscriptSegment => ({
  id,
  text,
  start: 0,
  end: 2,
  speaker,
  confidence: null,
});

const original = (): Session => ({
  id: 's1',
  title: 'Biology lecture',
  createdAt: 1700000000000,
  updatedAt: 1700000050000,
  duration: 3600,
  language: 'es',
  model: 'whisper-base',
  speakerCount: 3,
  wordCount: 1250,
  sourceName: 'lecture.m4a',
  segments: [segment('a', 'old text', 0), segment('b', 'more old text', 1)],
  audioBlob: new Blob(['audio-bytes']),
  audioMime: 'audio/mp4',
  peaks: [0.1, 0.5, 0.9],
  speakerNames: { '0': 'Prof. Ruiz', '1': 'Student' },
});

const rerun = (over: Partial<Session> = {}): Session => ({
  id: 'generated-2',
  title: 'Lecture m4a',
  createdAt: 1700000090000,
  updatedAt: 1700000090000,
  duration: 3599.5,
  language: 'en',
  model: 'whisper-small',
  speakerCount: 2,
  wordCount: 1310,
  sourceName: null,
  segments: [segment('c', 'new text', 1)],
  audioBlob: new Blob(['audio-bytes']),
  audioMime: 'audio/mp4',
  peaks: [0.4, 0.4, 0.4],
  ...over,
});

describe('applyReprocess', () => {
  it('keeps the session identity: id, title, creation date and source name', () => {
    const merged = applyReprocess(original(), rerun());
    expect(merged.id).toBe('s1');
    expect(merged.title).toBe('Biology lecture');
    expect(merged.createdAt).toBe(1700000000000);
    expect(merged.sourceName).toBe('lecture.m4a');
  });

  it('keeps the custom speaker names the user typed', () => {
    const merged = applyReprocess(original(), rerun());
    expect(merged.speakerNames).toEqual({ '0': 'Prof. Ruiz', '1': 'Student' });
  });

  it('replaces everything the new run produced', () => {
    const merged = applyReprocess(original(), rerun());
    expect(merged.segments).toEqual(rerun().segments);
    expect(merged.duration).toBe(3599.5);
    expect(merged.language).toBe('en');
    expect(merged.model).toBe('whisper-small');
    expect(merged.speakerCount).toBe(2);
    expect(merged.wordCount).toBe(1310);
    expect(merged.peaks).toEqual([0.4, 0.4, 0.4]);
  });

  it('bumps updatedAt so the session re-sorts as recently touched', () => {
    const merged = applyReprocess(original(), rerun());
    expect(merged.updatedAt).toBe(1700000090000);
  });

  it('falls back to the stored audio when the new record has none', () => {
    const merged = applyReprocess(original(), rerun({ audioBlob: null, audioMime: null }));
    expect(merged.audioBlob).toEqual(original().audioBlob);
    expect(merged.audioMime).toBe('audio/mp4');
  });

  it('keeps previous peaks when the fresh record has none', () => {
    const merged = applyReprocess(original(), rerun({ peaks: undefined }));
    expect(merged.peaks).toEqual([0.1, 0.5, 0.9]);
  });

  it('does not mutate either input', () => {
    const before = original();
    const after = rerun();
    applyReprocess(before, after);
    expect(before.wordCount).toBe(1250);
    expect(before.segments).toHaveLength(2);
    expect(after.id).toBe('generated-2');
    expect(after.title).toBe('Lecture m4a');
  });
});
