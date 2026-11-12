import type { RawAsrChunk } from '../../types';
import type { SpeechSegment } from './dsp';

export interface MergedBlock {
  start: number;
  end: number;
}

/**
 * Groups short VAD segments into ~25 s blocks so Whisper gets enough context
 * while staying below its 30 s receptive field.
 */
export function mergeSpeechSegments(segments: SpeechSegment[], maxBlock = 26, maxGap = 1.4): MergedBlock[] {
  const blocks: MergedBlock[] = [];
  for (const segment of segments) {
    if (segment.end <= segment.start) continue;
    const current = blocks[blocks.length - 1];
    if (
      current &&
      segment.start - current.end <= maxGap &&
      Math.max(current.end, segment.end) - current.start <= maxBlock
    ) {
      current.end = Math.max(current.end, segment.end);
    } else {
      blocks.push({ start: segment.start, end: segment.end });
    }
  }
  return blocks;
}

/** Picks the speaker whose speech windows overlap a transcript chunk the most. */
export function speakerForRange(
  start: number,
  end: number,
  windows: SpeechSegment[],
  labels: number[],
): number {
  if (windows.length === 0 || labels.length === 0) return 0;
  const votes = new Map<number, number>();

  for (let index = 0; index < windows.length; index += 1) {
    const overlap = Math.min(end, windows[index].end) - Math.max(start, windows[index].start);
    if (overlap <= 0) continue;
    const label = labels[index] ?? 0;
    votes.set(label, (votes.get(label) ?? 0) + overlap);
  }

  if (votes.size > 0) {
    let bestLabel = 0;
    let bestWeight = -1;
    for (const [label, weight] of votes) {
      if (weight > bestWeight) {
        bestWeight = weight;
        bestLabel = label;
      }
    }
    return bestLabel;
  }

  // No overlap (rare): fall back to the closest speech window.
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 0; index < windows.length; index += 1) {
    const window = windows[index];
    const distance = start > window.end ? start - window.end : window.start - end;
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return labels[bestIndex] ?? 0;
}

const NON_SPEECH = /^(\[|\().{0,40}(music|inaudible|applause|laughter|silence|blank.?audio).{0,20}(\]|\))$/i;

/**
 * Whisper occasionally falls into a decoding loop ("no es que no es que…")
 * on noisy or music-heavy passages. Collapse runs of the same phrase so a
 * single bad block cannot produce hundreds of repeated words.
 */
export function collapseRepeats(text: string, maxRepeats = 2, maxPattern = 6): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 4) return text;

  const out: string[] = [];
  let index = 0;
  while (index < words.length) {
    let collapsed = false;
    for (let size = 1; size <= maxPattern && !collapsed; size += 1) {
      if (index + size * (maxRepeats + 1) > words.length) continue;
      const pattern = words.slice(index, index + size).join(' ').toLowerCase();
      let repeats = 1;
      while (
        index + size * (repeats + 1) <= words.length &&
        words.slice(index + size * repeats, index + size * (repeats + 1)).join(' ').toLowerCase() === pattern
      ) {
        repeats += 1;
      }
      if (repeats > maxRepeats) {
        out.push(...words.slice(index, index + size * maxRepeats));
        index += size * repeats;
        collapsed = true;
      }
    }
    if (!collapsed) {
      out.push(words[index]);
      index += 1;
    }
  }
  return out.join(' ');
}

export function cleanChunkText(text: string): string {
  const cleaned = text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/(^|\s)\[BLANK_AUDIO\]/gi, '')
    .trim();
  return collapseRepeats(cleaned);
}

export function isUsableChunk(text: string): boolean {
  const cleaned = cleanChunkText(text);
  if (cleaned.length < 2) return false;
  if (NON_SPEECH.test(cleaned)) return false;
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return false;
  return true;
}

/** Merges whisper chunks into readable paragraphs, preserving speaker turns. */
export function mergeChunks(
  chunks: Array<RawAsrChunk & { speaker: number }>,
  gapThreshold = 0.55,
): Array<RawAsrChunk & { speaker: number }> {
  const merged: Array<RawAsrChunk & { speaker: number }> = [];
  for (const chunk of chunks) {
    const text = cleanChunkText(chunk.text);
    if (!isUsableChunk(text)) continue;
    const previous = merged[merged.length - 1];
    if (
      previous &&
      previous.speaker === chunk.speaker &&
      chunk.start - previous.end <= gapThreshold &&
      !/[.!?]$/.test(previous.text)
    ) {
      previous.text = `${previous.text} ${text}`.replace(/\s+/g, ' ').trim();
      previous.end = Math.max(previous.end, chunk.end);
      continue;
    }
    merged.push({ ...chunk, text });
  }
  return merged;
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function speakerName(index: number): string {
  return `Speaker ${index + 1}`;
}
