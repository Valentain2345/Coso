export interface SpeakerRegion {
  start: number;
  end: number;
  confidence: number;
}

/** Pyannote segmentation classes: silence, three local speakers, and their overlaps. */
const POWERSET: ReadonlyArray<ReadonlyArray<number>> = [
  [],
  [0],
  [1],
  [2],
  [0, 1],
  [0, 2],
  [1, 2],
];

export interface DecodeOptions {
  /** Probability above which a local speaker is considered active. */
  threshold?: number;
  /** Ignore blips shorter than this many seconds. */
  minDuration?: number;
}

/**
 * Converts Pyannote segmentation logits into single-speaker regions.
 *
 * Each frame is a 7-way powerset distribution, so overlapping classes such as
 * SPEAKERS_1_AND_2 contribute to both local speakers. The result is relative to
 * the start of the window and still contains local (not global) speaker ids.
 */
export function decodePyannoteFrames(
  data: ArrayLike<number>,
  frames: number,
  classes: number,
  windowStart: number,
  windowDuration: number,
  options: DecodeOptions = {},
): SpeakerRegion[] {
  const threshold = options.threshold ?? 0.5;
  const minDuration = options.minDuration ?? 0.35;

  if (frames <= 0 || classes < POWERSET.length || data.length < frames * classes) return [];

  const frameDuration = windowDuration / frames;
  const probabilities = new Float32Array(classes);
  const activity = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];

  for (let frame = 0; frame < frames; frame += 1) {
    const offset = frame * classes;
    let maximum = Number.NEGATIVE_INFINITY;
    for (let classIndex = 0; classIndex < classes; classIndex += 1) {
      const value = data[offset + classIndex];
      if (value > maximum) maximum = value;
    }

    let total = 0;
    for (let classIndex = 0; classIndex < classes; classIndex += 1) {
      const value = Math.exp(data[offset + classIndex] - maximum);
      probabilities[classIndex] = value;
      total += value;
    }

    for (let classIndex = 0; classIndex < classes; classIndex += 1) {
      probabilities[classIndex] /= Math.max(1e-9, total);
    }

    for (let speaker = 0; speaker < 3; speaker += 1) {
      let probability = 0;
      for (let classIndex = 1; classIndex < POWERSET.length; classIndex += 1) {
        if (POWERSET[classIndex].includes(speaker)) probability += probabilities[classIndex];
      }
      activity[speaker][frame] = probability;
    }
  }

  const regions: SpeakerRegion[] = [];
  for (const speakerActivity of activity) {
    let start = -1;
    let score = 0;

    for (let frame = 0; frame <= frames; frame += 1) {
      const active = frame < frames && speakerActivity[frame] >= threshold;

      if (active) {
        if (start < 0) {
          start = frame;
          score = 0;
        }
        score += speakerActivity[frame];
      } else if (start >= 0) {
        const end = frame;
        const duration = (end - start) * frameDuration;
        if (duration >= minDuration) {
          regions.push({
            start: windowStart + start * frameDuration,
            end: windowStart + end * frameDuration,
            confidence: score / Math.max(1, end - start),
          });
        }
        start = -1;
      }
    }
  }

  // When two people overlap, prefer the more confident region first.
  return regions.sort((a, b) => a.start - b.start || b.confidence - a.confidence);
}
