import type { TKey } from './en';
import type { Lang } from './en';
import { translate } from './index';

/**
 * The transcription pipeline runs inside Web Workers and reports progress in
 * English. Rather than shipping the language into every worker, known message
 * templates are localized at display time. Anything that does not match a
 * pattern is shown as-is, so new messages stay visible even without a rule.
 */
interface Rule {
  pattern: RegExp;
  build: (lang: Lang, match: RegExpMatchArray) => string;
}

const rules: Rule[] = [
  { pattern: /^Reading the audio…$/, build: (l) => translate(l, 'progress.readingAudio') },
  { pattern: /^Preparing the on-device models…$/, build: (l) => translate(l, 'progress.preparingModels') },
  { pattern: /^Loading (.+?) on the GPU…$/, build: (l, m) => translate(l, 'progress.loadingGpu', { model: m[1] }) },
  { pattern: /^Loading (.+?)…$/, build: (l, m) => translate(l, 'progress.loading', { model: m[1] }) },
  { pattern: /^Transcribing with (.+?) on GPU…$/, build: (l, m) => translate(l, 'progress.runningGpu', { model: m[1] }) },
  { pattern: /^Transcribing with (.+?) on CPU…$/, build: (l, m) => translate(l, 'progress.runningCpu', { model: m[1] }) },
  {
    pattern: /^WebGPU is unavailable here — switching to the CPU engine…$/,
    build: (l) => translate(l, 'progress.webgpuFallback'),
  },
  { pattern: /^Engine ready$/, build: (l) => translate(l, 'progress.engineReady') },
  {
    pattern: /^Downloading (\d+)% of the speech model$/,
    build: (l, m) => translate(l, 'progress.downloadingModel', { percent: m[1] }),
  },
  { pattern: /^Preparing the speech model…$/, build: (l) => translate(l, 'progress.preparingSpeechModel') },
  { pattern: /^Speech model ready$/, build: (l) => translate(l, 'progress.speechModelReady') },
  {
    pattern: /^Transcribing (\d+)% — (\d+) of (\d+) min$/,
    build: (l, m) => translate(l, 'progress.transcribingPercent', { percent: m[1], done: m[2], total: m[3] }),
  },
  {
    pattern: /^Transcribed (\d+) of (\d+) min — saving progress$/,
    build: (l, m) => translate(l, 'progress.transcribedOf', { done: m[1], total: m[2] }),
  },
  { pattern: /^Loading Whisper — the model is downloaded once…$/, build: (l) => translate(l, 'progress.loadingWhisper') },
  { pattern: /^Separating the voices…$/, build: (l) => translate(l, 'progress.separatingVoices') },
  { pattern: /^Tidying the transcript…$/, build: (l) => translate(l, 'progress.tidying') },
  { pattern: /^Saving your transcript…$/, build: (l) => translate(l, 'progress.saving') },
  { pattern: /^Transcript ready$/, build: (l) => translate(l, 'toast.transcriptReady.title') },
  { pattern: /^Transcribed in ([\d.]+) s$/, build: (l, m) => translate(l, 'progress.transcribedIn', { seconds: m[1] }) },
  {
    pattern: /^Found (\d+) speakers? in your audio$/,
    build: (l, m) => translate(l, 'progress.foundSpeakers', { count: m[1] }),
  },
];

/** Localize a pipeline message; unmatched text passes through untouched. */
export function localizeProgress(message: string, lang: Lang): string {
  if (!message) return message;
  for (const rule of rules) {
    const match = message.match(rule.pattern);
    if (match) return rule.build(lang, match);
  }
  return message;
}

const errorRules: Array<{ pattern: RegExp; build: (lang: Lang, match: RegExpMatchArray) => string }> = [
  {
    pattern: /^This audio could not be decoded\./,
    build: (l) => translate(l, 'error.decode'),
  },
  {
    pattern: /^This file \((\d+) min\) uses a format that cannot be streamed\./,
    build: (l, m) => translate(l, 'error.cannotStream', { minutes: m[1] }),
  },
  {
    pattern: /^This format cannot resume from a checkpoint\./,
    build: (l) => translate(l, 'error.noResume'),
  },
  {
    pattern: /^That recording is too short to transcribe\./,
    build: (l) => translate(l, 'error.tooShort'),
  },
  {
    pattern: /^Speech was detected, but no words could be recognized\./,
    build: (l) => translate(l, 'error.noWords'),
  },
  {
    pattern: /^No speech was found in this audio\./,
    build: (l) => translate(l, 'error.noSpeech'),
  },
];

/** Localize a known pipeline error message; unknown text passes through. */
export function localizeError(message: string, lang: Lang): string {
  if (!message) return message;
  for (const rule of errorRules) {
    const match = message.match(rule.pattern);
    if (match) return rule.build(lang, match);
  }
  return message;
}

export type { TKey };
