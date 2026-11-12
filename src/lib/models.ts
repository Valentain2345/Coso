import type { ModelId } from '../types';
import { translate, type Lang } from '../i18n';

export interface ModelInfo {
  id: ModelId;
  repo: string;
  label: string;
  size: string;
  englishOnly: boolean;
  note: string;
  /** Rough speed/accuracy tier, used to flag heavy models in the UI. */
  tier: 'quick' | 'balanced' | 'precision';
  /** Extra warning shown for models that need a lot of memory or a GPU. */
  warning?: string;
}

export const MODELS: Record<ModelId, ModelInfo> = {
  'whisper-tiny': {
    id: 'whisper-tiny',
    repo: 'onnx-community/whisper-tiny',
    label: 'Whisper Tiny',
    size: '~42 MB',
    englishOnly: false,
    note: 'Fastest. Best for short notes and slower laptops.',
    tier: 'quick',
  },
  'whisper-tiny.en': {
    id: 'whisper-tiny.en',
    repo: 'onnx-community/whisper-tiny.en',
    label: 'Whisper Tiny (English)',
    size: '~42 MB',
    englishOnly: true,
    note: 'Fastest English-only model.',
    tier: 'quick',
  },
  'whisper-base': {
    id: 'whisper-base',
    repo: 'onnx-community/whisper-base',
    label: 'Whisper Base',
    size: '~80 MB',
    englishOnly: false,
    note: 'Recommended balance of speed and accuracy.',
    tier: 'balanced',
  },
  'whisper-base.en': {
    id: 'whisper-base.en',
    repo: 'onnx-community/whisper-base.en',
    label: 'Whisper Base (English)',
    size: '~80 MB',
    englishOnly: true,
    note: 'A little more accurate for English lectures.',
    tier: 'balanced',
  },
  'whisper-small': {
    id: 'whisper-small',
    repo: 'onnx-community/whisper-small',
    label: 'Whisper Small',
    size: '~250 MB',
    englishOnly: false,
    note: 'Accurate multilingual model. Slower to download and run.',
    tier: 'balanced',
  },
  'whisper-small.en': {
    id: 'whisper-small.en',
    repo: 'onnx-community/whisper-small.en',
    label: 'Whisper Small (English)',
    size: '~250 MB',
    englishOnly: true,
    note: 'Accurate English-only model.',
    tier: 'balanced',
  },
  'whisper-medium': {
    id: 'whisper-medium',
    repo: 'Xenova/whisper-medium',
    label: 'Whisper Medium',
    size: '~740 MB–1.5 GB',
    englishOnly: false,
    note: 'High accuracy for accented speech and noisy rooms.',
    tier: 'precision',
    warning:
      'Heavy: 0.7–1.5 GB download and several times slower than Small. Use GPU · WebGPU for reasonable speed; CPU-only laptops may take a long time per lecture.',
  },
  'whisper-large-v3-turbo': {
    id: 'whisper-large-v3-turbo',
    repo: 'onnx-community/whisper-large-v3-turbo',
    label: 'Whisper Large v3 Turbo',
    size: '~1.0–1.5 GB',
    englishOnly: false,
    note: 'The most accurate option here, with the same Whisper weights used by faster-whisper and WhisperX.',
    tier: 'precision',
    warning:
      'Very heavy: 1–1.5 GB download, 8 GB+ RAM recommended, and several times slower than Small. WebGPU is strongly recommended. On CPU this can take many minutes per hour of audio.',
  },
};

export const LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'auto', label: 'Detect automatically' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'ru', label: 'Russian' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ar', label: 'Arabic' },
  { code: 'hi', label: 'Hindi' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'zh', label: 'Chinese' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'sv', label: 'Swedish' },
  { code: 'da', label: 'Danish' },
  { code: 'fi', label: 'Finnish' },
  { code: 'no', label: 'Norwegian' },
  { code: 'el', label: 'Greek' },
  { code: 'he', label: 'Hebrew' },
  { code: 'id', label: 'Indonesian' },
  { code: 'vi', label: 'Vietnamese' },
];

export function modelInfo(id: ModelId): ModelInfo {
  return MODELS[id] ?? MODELS['whisper-base'];
}

/**
 * Localized description and warning for a model. The English strings stay in
 * `ModelInfo` (workers read them); the UI shows these instead.
 */
export function modelCopy(model: ModelInfo, lang: Lang): { note: string; warning: string | null } {
  const id = String(model.id).replace(/\./g, '-') as
    | 'whisper-tiny'
    | 'whisper-tiny-en'
    | 'whisper-base'
    | 'whisper-base-en'
    | 'whisper-small'
    | 'whisper-small-en'
    | 'whisper-medium'
    | 'whisper-large-v3-turbo';
  return {
    note: translate(lang, `models.${id}.note`),
    warning: model.warning ? translate(lang, `models.${id}.warning`) : null,
  };
}

/** Localized names of the spoken-language options shown in Settings. */
const LANGUAGE_NAMES: Record<string, { en: string; es: string }> = {
  en: { en: 'English', es: 'Inglés' },
  es: { en: 'Spanish', es: 'Español' },
  fr: { en: 'French', es: 'Francés' },
  de: { en: 'German', es: 'Alemán' },
  it: { en: 'Italian', es: 'Italiano' },
  pt: { en: 'Portuguese', es: 'Portugués' },
  nl: { en: 'Dutch', es: 'Neerlandés' },
  pl: { en: 'Polish', es: 'Polaco' },
  ru: { en: 'Russian', es: 'Ruso' },
  tr: { en: 'Turkish', es: 'Turco' },
  ar: { en: 'Arabic', es: 'Árabe' },
  hi: { en: 'Hindi', es: 'Hindi' },
  ja: { en: 'Japanese', es: 'Japonés' },
  ko: { en: 'Korean', es: 'Coreano' },
  zh: { en: 'Chinese', es: 'Chino' },
  uk: { en: 'Ukrainian', es: 'Ucraniano' },
  sv: { en: 'Swedish', es: 'Sueco' },
  da: { en: 'Danish', es: 'Danés' },
  fi: { en: 'Finnish', es: 'Finés' },
  no: { en: 'Norwegian', es: 'Noruego' },
  el: { en: 'Greek', es: 'Griego' },
  he: { en: 'Hebrew', es: 'Hebreo' },
  id: { en: 'Indonesian', es: 'Indonesio' },
  vi: { en: 'Vietnamese', es: 'Vietnamita' },
};

export function spokenLanguageLabel(code: string, lang: Lang): string {
  if (code === 'auto') return translate(lang, 'settings.spoken.auto');
  return LANGUAGE_NAMES[code]?.[lang] ?? code;
}
