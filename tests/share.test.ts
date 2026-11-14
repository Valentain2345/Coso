import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types';
import { shareTranscript } from '../src/lib/share';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'sess-1',
    title: 'Lecture 4 — Optics',
    createdAt: Date.UTC(2026, 2, 9, 10, 0, 0),
    updatedAt: Date.UTC(2026, 2, 9, 10, 5, 0),
    duration: 90,
    language: 'en',
    model: 'whisper-base',
    speakerCount: 1,
    wordCount: 3,
    sourceName: 'lecture.mp3',
    segments: [
      { id: 'a', start: 0, end: 4, text: 'Light bends at the boundary.', speaker: 0, confidence: 0.9 },
      { id: 'b', start: 4, end: 9, text: 'That is refraction.', speaker: 0, confidence: 0.9 },
    ],
    ...overrides,
  } as Session;
}

function abort(): Error {
  const error = new Error('Share cancelled');
  error.name = 'AbortError';
  return error;
}

describe('shareTranscript', () => {
  it('shares a .txt file when the platform accepts files', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(true);
    const writeText = vi.fn().mockResolvedValue(undefined);

    const outcome = await shareTranscript(makeSession(), 'en', { share, canShare, writeText });

    expect(outcome).toBe('shared');
    const payload = share.mock.calls[0][0] as ShareData;
    expect(payload.title).toBe('Lecture 4 — Optics');
    expect(payload.files).toHaveLength(1);
    expect(payload.files![0].name).toMatch(/\.txt$/);
    expect(payload.files![0].type).toContain('text/plain');
    expect(await payload.files![0].text()).toContain('Light bends at the boundary.');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to sharing plain text when files are not shareable', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const canShare = vi.fn().mockReturnValue(false);
    const writeText = vi.fn().mockResolvedValue(undefined);

    const outcome = await shareTranscript(makeSession(), 'es', { share, canShare, writeText });

    expect(outcome).toBe('shared');
    const payload = share.mock.calls[0][0] as ShareData;
    expect(payload.files).toBeUndefined();
    expect(payload.text).toContain('Light bends at the boundary.');
    expect(payload.text).toContain('Duración: 1 min 30 s');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('shares text without asking canShare when the browser has no canShare', async () => {
    const share = vi.fn().mockResolvedValue(undefined);

    await shareTranscript(makeSession(), 'en', { share, canShare: null, writeText: null });

    const payload = share.mock.calls[0][0] as ShareData;
    expect(payload.files).toBeUndefined();
    expect(payload.text).toBeTruthy();
  });

  it('copies to the clipboard when the platform has no share sheet', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);

    const outcome = await shareTranscript(makeSession(), 'en', { share: null, writeText });

    expect(outcome).toBe('copied');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toContain('That is refraction.');
  });

  it('treats a dismissed share sheet as cancelled and does not copy', async () => {
    const share = vi.fn().mockRejectedValue(abort());
    const writeText = vi.fn().mockResolvedValue(undefined);

    const outcome = await shareTranscript(makeSession(), 'en', { share, writeText });

    expect(outcome).toBe('cancelled');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('copies when the share sheet rejects the payload', async () => {
    const share = vi.fn().mockRejectedValue(new Error('NotSupportedError'));
    const writeText = vi.fn().mockResolvedValue(undefined);

    const outcome = await shareTranscript(makeSession(), 'en', { share, writeText });

    expect(outcome).toBe('copied');
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it('reports failure when neither sharing nor the clipboard works', async () => {
    const share = vi.fn().mockRejectedValue(new Error('no share targets'));
    const writeText = vi.fn().mockRejectedValue(new Error('clipboard blocked'));

    await expect(shareTranscript(makeSession(), 'en', { share, writeText })).resolves.toBe('failed');
    await expect(shareTranscript(makeSession(), 'en', { share: null })).resolves.toBe('failed');
  });

  it('uses a localised title for an untitled recording', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);

    await shareTranscript(makeSession({ title: '   ' }), 'es', { share, writeText });

    expect((share.mock.calls[0][0] as ShareData).title).toBe('Transcripción sin título');
  });

  it('keeps a usable fallback when File construction is unavailable', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('File', undefined);

    try {
      const outcome = await shareTranscript(makeSession(), 'en', { share, writeText: null });
      expect(outcome).toBe('shared');
      expect((share.mock.calls[0][0] as ShareData).files).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
