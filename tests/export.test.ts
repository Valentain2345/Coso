import { describe, expect, test } from 'vitest';
import type { Session } from '../src/types';
import {
  audioExtension,
  docxBlob,
  downloadBlob,
  exportFilename,
  formatClock,
  formatDuration,
  jsonTranscript,
  markdown,
  pdfBlob,
  plainText,
  srt,
  transcriptDocument,
  vtt,
} from '../src/lib/export/formats';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    title: 'Team Sync — Q4 Planning!',
    createdAt: Date.UTC(2026, 10, 5, 9, 30),
    updatedAt: Date.UTC(2026, 10, 5, 9, 45),
    duration: 754,
    language: 'en',
    model: 'whisper-base',
    speakerCount: 2,
    wordCount: 9,
    sourceName: 'meeting.wav',
    segments: [
      {
        id: 'seg-1',
        start: 0,
        end: 5.2,
        text: 'Hello <world> & *friends*',
        speaker: 0,
        confidence: 0.91,
      },
      {
        id: 'seg-2',
        start: 5.5,
        end: 12.04,
        text: 'We should ship [beta] now.',
        speaker: 1,
        confidence: 0.82,
      },
      {
        id: 'seg-3',
        start: 12.5,
        end: 65.999,
        text: "Agreed — let's go.",
        speaker: 0,
        confidence: null,
      },
    ],
    audioBlob: new Blob(['fake-audio-bytes'], { type: 'audio/wav' }),
    audioMime: 'audio/wav',
    ...overrides,
  };
}

const emptySession = makeSession({
  id: 'session-empty',
  title: 'Empty Session',
  duration: 0,
  speakerCount: 0,
  wordCount: 0,
  sourceName: null,
  segments: [],
  audioBlob: null,
  audioMime: null,
});

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('formatClock', () => {
  test('formats short, minute and hour ranges', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(59.9)).toBe('0:59');
    expect(formatClock(754)).toBe('12:34');
    expect(formatClock(3600)).toBe('1:00:00');
    expect(formatClock(3661)).toBe('1:01:01');
    expect(formatClock(3599)).toBe('59:59');
  });

  test('clamps negative and non-finite values', () => {
    expect(formatClock(-10)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
    expect(formatClock(Number.POSITIVE_INFINITY)).toBe('0:00');
  });
});

describe('formatDuration', () => {
  test('is compact and omits zero trailing parts', () => {
    expect(formatDuration(0)).toBe('0 s');
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(754)).toBe('12 min 34 s');
    expect(formatDuration(720)).toBe('12 min');
    expect(formatDuration(3600)).toBe('1 h');
    expect(formatDuration(3661)).toBe('1 h 1 min 1 s');
    expect(formatDuration(-4)).toBe('0 s');
  });
});

describe('plainText', () => {
  test('starts with the title and keeps segments in transcript order', () => {
    const output = plainText(makeSession());
    const lines = output.split('\n');

    expect(lines[0]).toBe('Team Sync — Q4 Planning!');
    expect(output).toContain('Duration: 12 min 34 s');
    expect(output).toContain('[0:00] Speaker 1: Hello <world> & *friends*');
    expect(output).toContain('[0:05] Speaker 2: We should ship [beta] now.');
    expect(output).toContain("[0:12] Speaker 1: Agreed — let's go.");

    const first = output.indexOf('Hello <world>');
    const second = output.indexOf('We should ship');
    const third = output.indexOf('Agreed');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  test('merges consecutive segments from the same speaker when close', () => {
    const session = makeSession({
      segments: [
        {
          id: 'a',
          start: 0,
          end: 2,
          text: 'First part.',
          speaker: 0,
          confidence: null,
        },
        {
          id: 'b',
          start: 2.5,
          end: 4,
          text: 'Second part.',
          speaker: 0,
          confidence: null,
        },
      ],
    });

    const output = plainText(session);
    expect(output).toContain('[0:00] Speaker 1: First part. Second part.');
    expect(output.match(/\[0:00\]/g)).toHaveLength(1);
  });
});

describe('transcriptDocument', () => {
  test('returns a real plain-text Blob', async () => {
    const blob = transcriptDocument(makeSession());
    expect(blob).toBeInstanceOf(Blob);
    if (blob === null) throw new Error('Expected a transcript document');
    expect(blob.type).toContain('text/plain');
    expect(await blob.text()).toContain('Speaker 1');
  });
});

describe('markdown', () => {
  test('contains heading, metadata, speakers, timestamps and escaped text', () => {
    const output = markdown(makeSession());

    expect(output.startsWith('# Team Sync — Q4 Planning!')).toBe(true);
    expect(output).toContain('**Date:** 2026-11-05');
    expect(output).toContain('**Duration:** 12 min 34 s');
    expect(output).toContain('**Language:** en');
    expect(output).toContain('**Model:** whisper-base');
    expect(output).toContain('**Speakers:** 2');
    expect(output).toContain('**Speaker 1** [0:00]');
    expect(output).toContain('**Speaker 2** [0:05]');
    expect(output).toContain('Hello \\<world\\> & \\*friends\\*');
    expect(output).toContain('We should ship \\[beta\\] now.');
    expect(output).not.toContain('*friends*');
  });
});

describe('srt', () => {
  test('numbers cues and uses comma-decimal, zero-padded timestamps', () => {
    const expected = [
      '1',
      '00:00:00,000 --> 00:00:05,200',
      'Speaker 1: Hello <world> & *friends*',
      '',
      '2',
      '00:00:05,500 --> 00:00:12,040',
      'Speaker 2: We should ship [beta] now.',
      '',
      '3',
      '00:00:12,500 --> 00:01:05,999',
      "Speaker 1: Agreed — let's go.",
      '',
    ].join('\n');

    expect(srt(makeSession())).toBe(expected);
    expect(srt(emptySession)).toBe('');
  });

  test('clamps invalid timings to zero', () => {
    const session = makeSession({
      segments: [
        {
          id: 'bad',
          start: -4,
          end: Number.NaN,
          text: 'Invalid timing',
          speaker: 0,
          confidence: null,
        },
      ],
    });

    expect(srt(session)).toContain('00:00:00,000 --> 00:00:00,000');
  });
});

describe('vtt', () => {
  test('starts with WEBVTT and uses dot-decimal timestamps', () => {
    const expected = [
      'WEBVTT',
      '',
      '00:00:00.000 --> 00:00:05.200',
      'Speaker 1: Hello <world> & *friends*',
      '',
      '00:00:05.500 --> 00:00:12.040',
      'Speaker 2: We should ship [beta] now.',
      '',
      '00:00:12.500 --> 00:01:05.999',
      "Speaker 1: Agreed — let's go.",
      '',
    ].join('\n');

    expect(vtt(makeSession())).toBe(expected);
    expect(vtt(emptySession)).toBe('WEBVTT\n');
  });
});

describe('jsonTranscript', () => {
  test('round-trips metadata and segments without audio data', () => {
    const json = jsonTranscript(makeSession());
    const parsed = JSON.parse(json) as {
      format: string;
      version: number;
      metadata: Record<string, unknown>;
      segments: Array<Record<string, unknown>>;
    };

    expect(parsed.format).toBe('coso-transcript');
    expect(parsed.version).toBe(1);
    expect(parsed.metadata.title).toBe('Team Sync — Q4 Planning!');
    expect(parsed.metadata.createdAt).toBe(Date.UTC(2026, 10, 5, 9, 30));
    expect(parsed.metadata.duration).toBe(754);
    expect(parsed.metadata.language).toBe('en');
    expect(parsed.metadata.model).toBe('whisper-base');
    expect(parsed.metadata.speakerCount).toBe(2);
    expect(parsed.metadata.sourceName).toBe('meeting.wav');
    expect(parsed.segments).toHaveLength(3);
    expect(parsed.segments[0]).toMatchObject({
      id: 'seg-1',
      start: 0,
      end: 5.2,
      text: 'Hello <world> & *friends*',
      speaker: 0,
      confidence: 0.91,
    });
    expect(parsed.segments[2].confidence).toBeNull();
    expect(json).not.toContain('audioBlob');
    expect(json).not.toContain('audioMime');
    expect(json).not.toContain('fake-audio-bytes');
  });

  test('handles an empty session', () => {
    const parsed = JSON.parse(jsonTranscript(emptySession)) as {
      metadata: Record<string, unknown>;
      segments: unknown[];
    };
    expect(parsed.metadata.title).toBe('Empty Session');
    expect(parsed.segments).toEqual([]);
  });
});

describe('exportFilename', () => {
  test('slugifies the title and appends the UTC date and extension', () => {
    expect(exportFilename(makeSession(), 'srt')).toBe(
      'team-sync-q4-planning-2026-11-05.srt',
    );
    expect(exportFilename(makeSession(), '.md')).toBe(
      'team-sync-q4-planning-2026-11-05.md',
    );
    expect(exportFilename(makeSession(), 'DOCX')).toBe(
      'team-sync-q4-planning-2026-11-05.docx',
    );
  });

  test('falls back for empty titles and handles empty extensions', () => {
    expect(exportFilename(makeSession({ title: '   ' }), 'txt')).toBe(
      'untitled-transcript-2026-11-05.txt',
    );
    expect(exportFilename(makeSession({ title: '///' }), '')).toBe(
      'untitled-transcript-2026-11-05',
    );
  });
});

describe('docxBlob', () => {
  test('produces a real DOCX ZIP archive', async () => {
    const blob = await docxBlob(makeSession());
    expect(blob.size).toBeGreaterThan(1000);
    const bytes = await bytesOf(blob);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('PK');
  });

  test('produces a document for an empty session', async () => {
    const blob = await docxBlob(emptySession);
    const bytes = await bytesOf(blob);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe('PK');
  });
});

describe('pdfBlob', () => {
  test('produces a real, non-empty PDF synchronously', async () => {
    const blob = pdfBlob(makeSession());
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(1000);
    const bytes = await bytesOf(blob);
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe(
      '%PDF',
    );
  });

  test('handles an empty session', () => {
    const blob = pdfBlob(emptySession);
    expect(blob.size).toBeGreaterThan(500);
    expect(blob.type).toContain('pdf');
  });
});

describe('downloadBlob', () => {
  test('is a safe no-op outside the browser', () => {
    expect(() =>
      downloadBlob(new Blob(['x'], { type: 'text/plain' }), 'x.txt'),
    ).not.toThrow();
  });
});

describe('audioExtension', () => {
  test('uses the source file name when available', () => {
    expect(audioExtension(makeSession({ sourceName: 'Lecture 3.M4A' }))).toBe('m4a');
  });

  test('falls back to the stored MIME type', () => {
    expect(audioExtension(makeSession({ sourceName: null, audioMime: 'audio/mpeg' }))).toBe('mp3');
    expect(audioExtension(makeSession({ sourceName: null, audioMime: 'audio/wav' }))).toBe('wav');
  });

  test('defaults to webm for browser recordings without a name', () => {
    expect(audioExtension(makeSession({ sourceName: null, audioMime: 'audio/webm;codecs=opus' }))).toBe('webm');
    expect(audioExtension(makeSession({ sourceName: null, audioMime: null }))).toBe('webm');
  });
});
