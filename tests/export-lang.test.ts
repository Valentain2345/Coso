import { describe, expect, it } from 'vitest';
import { modelCopy, modelInfo, spokenLanguageLabel } from '../src/lib/models';
import type { Session } from '../src/types';
import { docxBlob, exportFilename, jsonTranscript, markdown, pdfBlob, plainText, srt, vtt } from '../src/lib/export/formats';

const session: Session = {
  id: 's1',
  title: 'Water cycle',
  createdAt: Date.parse('2026-02-03T10:20:00Z'),
  updatedAt: Date.parse('2026-02-03T10:20:00Z'),
  duration: 125,
  language: 'es',
  model: 'whisper-base',
  speakerCount: 2,
  wordCount: 11,
  sourceName: 'class.webm',
  segments: [
    { id: 'a', start: 0, end: 5, text: 'Hola a todos.', speaker: 0, confidence: 0.9 },
    { id: 'b', start: 5.4, end: 9, text: '¿Alguien tiene una pregunta?', speaker: 1, confidence: 0.8 },
  ],
  audioBlob: null,
  audioMime: 'audio/webm',
};

const namedSession: Session = {
  ...session,
  speakerNames: { '0': 'Prof. Rivera', '1': 'Bob' },
};

describe('models', () => {
  it('localizes the model note and warning', () => {
    const large = modelInfo('whisper-large-v3-turbo');
    expect(modelCopy(large, 'en').note).toMatch(/most accurate/i);
    expect(modelCopy(large, 'es').note).toContain('más precisa');
    expect(modelCopy(large, 'es').warning).toMatch(/Muy pesado/);
  });

  it('returns no localized warning for small models', () => {
    expect(modelCopy(modelInfo('whisper-base'), 'en').warning).toBeNull();
    expect(modelInfo('whisper-base.en').englishOnly).toBe(true);
    expect(modelInfo('whisper-base').englishOnly).toBe(false);
  });

  it('labels spoken languages in the interface language', () => {
    expect(spokenLanguageLabel('de', 'es')).toBe('Alemán');
    expect(spokenLanguageLabel('de', 'en')).toBe('German');
    expect(spokenLanguageLabel('auto', 'es')).toBe('Detectar automáticamente');
    expect(spokenLanguageLabel('xx', 'en')).toBe('xx');
  });
});

describe('localized exports', () => {
  it('plainText uses Spanish labels and speaker names', () => {
    const text = plainText(session, 'es');
    expect(text).toContain('Fecha: 2026-02-03');
    expect(text).toContain('Duración: 2 min 5 s');
    expect(text).toContain('Idioma: es');
    expect(text).toContain('Voz 1:');
    expect(text).not.toContain('Speaker 1:');
  });

  it('markdown uses Spanish labels', () => {
    const text = markdown(session, 'es');
    expect(text).toContain('**Voz 2** [0:05]');
    expect(text).toContain('**Fecha:** 2026-02-03');
  });

  it('srt and vtt use Spanish speaker labels', () => {
    expect(srt(session, 'es')).toContain('Voz 1: Hola a todos.');
    expect(vtt(session, 'es')).toContain('Voz 2: ¿Alguien tiene una pregunta?');
    expect(srt(session, 'en')).toContain('Speaker 1: Hola a todos.');
  });

  it('defaults to English so existing callers keep their output', () => {
    expect(plainText(session)).toContain('Speaker 1:');
    expect(markdown(session)).toContain('**Speaker 2**');
  });

  it('docx and pdf accept a language without throwing', async () => {
    const docx = await docxBlob(session, 'es');
    expect(docx.size).toBeGreaterThan(3000);
    const pdf = pdfBlob(session, 'es');
    expect(pdf.size).toBeGreaterThan(1000);
    expect(await new Response(docx.slice(0, 2).stream()).text()).toBe('PK');
  });

  it('builds a safe filename from the title', () => {
    expect(exportFilename(session, 'txt')).toBe('water-cycle-2026-02-03.txt');
  });
});

describe('custom speaker names in exports', () => {
  it('replaces default labels in plain text and markdown', () => {
    expect(plainText(namedSession, 'en')).toContain('Prof. Rivera: Hola a todos.');
    expect(markdown(namedSession, 'en')).toContain('**Bob** [0:05]');
    expect(plainText(namedSession, 'en')).not.toContain('Speaker 1:');
  });

  it('replaces default labels in subtitles', () => {
    expect(srt(namedSession, 'en')).toContain('Bob: ¿Alguien tiene una pregunta?');
    expect(vtt(namedSession, 'en')).toContain('Prof. Rivera: Hola a todos.');
  });

  it('keeps the default label when a name is blank', () => {
    const blank = { ...namedSession, speakerNames: { '0': '   ' } };
    expect(plainText(blank, 'en')).toContain('Speaker 1: Hola a todos.');
  });

  it('exposes the resolved name in the JSON export', () => {
    const parsed = JSON.parse(jsonTranscript(namedSession)) as {
      segments: Array<{ speakerLabel: string }>;
    };
    expect(parsed.segments[0].speakerLabel).toBe('Prof. Rivera');
    expect(parsed.segments[1].speakerLabel).toBe('Bob');
  });
});
