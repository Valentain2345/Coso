import { describe, expect, it } from 'vitest';
import { en } from '../src/i18n/en';
import { es } from '../src/i18n/es';
import { currentLang, getLang, setLang, t, translate } from '../src/i18n';
import { localizeError, localizeProgress } from '../src/i18n/progress';
import { manualEn } from '../src/i18n/manual';
import { manualEs } from '../src/i18n/manual.es';

describe('dictionaries', () => {
  it('has exactly the same keys in Spanish and English', () => {
    const enKeys = Object.keys(en).sort();
    const esKeys = Object.keys(es).sort();
    expect(esKeys).toEqual(enKeys);
  });

  it('leaves no placeholder unfilled in either language', () => {
    for (const [key, value] of Object.entries(en)) {
      const placeholders = value.match(/\{(\w+)\}/g) ?? [];
      // Plural keys repeat {count}; every other key must carry at most the
      // placeholders its callers pass — here we only check well-formedness.
      for (const placeholder of placeholders) {
        expect(placeholder, key).toMatch(/^\{\w+\}$/);
      }
    }
    for (const [key, value] of Object.entries(es)) {
      const placeholdersEn = (en[key as keyof typeof en] ?? '').match(/\{(\w+)\}/g) ?? [];
      const placeholdersEs = value.match(/\{(\w+)\}/g) ?? [];
      expect(placeholdersEs.sort(), key).toEqual(placeholdersEn.slice().sort());
    }
  });

  it('keeps plural pairs (.one/.other) together', () => {
    const pluralBases = new Set(
      Object.keys(en)
        .filter((key) => key.endsWith('.one'))
        .map((key) => key.replace(/\.one$/, '')),
    );
    for (const base of pluralBases) {
      expect(Object.keys(en), base).toContain(`${base}.other`);
      expect(Object.keys(es), base).toContain(`${base}.other`);
    }
  });
});

describe('runtime', () => {
  it('translates with parameters', () => {
    expect(translate('es', 'count.speakerWord', { n: 2 })).toBe('Voz 2');
    expect(translate('en', 'count.speakerWord', { n: 1 })).toBe('Speaker 1');
  });

  it('resolves plural keys by count with Intl.PluralRules', () => {
    expect(translate('en', 'count.words', { count: 1 })).toBe('1 word');
    expect(translate('en', 'count.words', { count: 3 })).toBe('3 words');
    expect(translate('es', 'count.words', { count: 1 })).toBe('1 palabra');
    expect(translate('es', 'count.words', { count: 3 })).toBe('3 palabras');
  });

  it('formats numbers with the locale of the language', () => {
    // 12345 is "12,345" in English and "12.345" in Spanish.
    expect(translate('en', 'count.words', { count: 12345 })).toContain('12,345');
    expect(translate('es', 'count.words', { count: 12345 })).toContain('12.345');
  });

  it('persists the language choice and notifies subscribers', () => {
    const previous = getLang();
    setLang('es');
    expect(getLang()).toBe('es');
    expect(currentLang()).toBe('es');
    expect(t('common.close')).toBe('Cerrar');
    setLang(previous);
  });

  it('never renders empty text: an unknown or parameterless key resolves to itself', () => {
    // `count.words` only has .one/.other variants; without a count neither
    // language can resolve it, so the English lookup fails and the key itself
    // is returned instead of an empty string.
    expect(translate('es', 'count.words')).toBe('count.words');
    expect(translate('en', 'count.words')).toBe('count.words');
  });
});

describe('progress message localization', () => {
  it('maps known worker messages to Spanish', () => {
    expect(localizeProgress('Loading Whisper Base…', 'es')).toBe('Cargando Whisper Base…');
    expect(localizeProgress('Transcribing with Whisper Base on CPU…', 'es')).toBe(
      'Transcribiendo con Whisper Base en CPU…',
    );
    expect(localizeProgress('Reading the audio…', 'es')).toBe('Leyendo el audio…');
    expect(localizeProgress('Transcript ready', 'es')).toBe('Transcripción lista');
    expect(localizeProgress('Transcribing 50% — 2 of 4 min', 'es')).toBe(
      'Transcribiendo 50% — 2 de 4 min',
    );
  });

  it('passes unknown messages through untouched', () => {
    expect(localizeProgress('Custom message', 'es')).toBe('Custom message');
    expect(localizeProgress('', 'en')).toBe('');
  });

  it('keeps English messages identical to the source', () => {
    expect(localizeProgress('Loading Whisper Base…', 'en')).toBe('Loading Whisper Base…');
  });
});

describe('error message localization', () => {
  it('maps pipeline errors to Spanish', () => {
    expect(localizeError('That recording is too short to transcribe.', 'es')).toBe(
      'Esa grabación es demasiado corta para transcribir.',
    );
    expect(
      localizeError('This file (95 min) uses a format that cannot be streamed. Convert it to MP3, M4A or WAV and try again.', 'es'),
    ).toContain('95 min');
    expect(localizeError('No speech was found in this audio.', 'es')).toContain('No se encontró voz');
  });

  it('passes unknown errors through', () => {
    expect(localizeError('Something weird', 'es')).toBe('Something weird');
  });
});

describe('manual content', () => {
  it('has the same section ids in both languages', () => {
    expect(manualEs.map((section) => section.id)).toEqual(manualEn.map((section) => section.id));
  });

  it('uses the same figure files in both languages', () => {
    const figures = (sections: typeof manualEn) =>
      sections.flatMap((section) => section.entries.filter((entry) => 'src' in entry).map((entry) => entry.src));
    expect(figures(manualEs)).toEqual(figures(manualEn));
  });

  it('never points at a missing media file', () => {
    for (const section of manualEn) {
      for (const entry of section.entries) {
        if ('src' in entry) {
          const file = entry.src.replace(/^\/manual\//, '');
          expect(fsExists(path.join('public', 'manual', file)), file).toBe(true);
        }
      }
    }
  });
});

import fs from 'node:fs';
import path from 'node:path';

function fsExists(target: string): boolean {
  try {
    return fs.existsSync(path.resolve(import.meta.dirname, '..', target));
  } catch {
    return false;
  }
}
