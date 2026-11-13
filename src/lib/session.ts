import type { Session } from '../types';

/**
 * Merge a freshly transcribed session into an existing one, keeping the
 * user's identity for the session (id, title, creation date, audio and any
 * custom speaker names) while replacing everything the new run produces.
 *
 * Used by "re-transcribe": the result replaces the transcript without the
 * user having to delete and recreate the session.
 */
export function applyReprocess(existing: Session, created: Session): Session {
  return {
    ...existing,
    updatedAt: Math.max(existing.updatedAt, created.updatedAt),
    duration: created.duration,
    language: created.language,
    model: created.model,
    speakerCount: created.speakerCount,
    wordCount: created.wordCount,
    segments: created.segments,
    peaks: created.peaks ?? existing.peaks,
    // Same audio by definition (it was re-read from the session), but prefer
    // the fresh record's values in case the mime was normalised.
    audioBlob: created.audioBlob ?? existing.audioBlob,
    audioMime: created.audioMime ?? existing.audioMime,
  };
}
