import {
  AlignmentType,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
} from 'docx';
import { jsPDF } from 'jspdf';
import type { Session, TranscriptSegment } from '../../types';
import { translate, type Lang } from '../../i18n';

const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MERGE_GAP_SECONDS = 2;

function finiteSeconds(seconds: number): number {
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

type SpeakerNames = Record<string, string>;

/** Resolve a speaker's display name: custom name first, default label otherwise. */
export function speakerName(
  speaker: number,
  lang: Lang,
  names?: SpeakerNames | null,
): string {
  const index = Number.isFinite(speaker) ? Math.max(0, Math.floor(speaker)) : 0;
  const custom = names?.[String(index)]?.replace(/\s+/g, ' ').trim();
  return custom || translate(lang, 'export.speaker', { n: index + 1 });
}

function speakerLabel(speaker: number, lang: Lang, names?: SpeakerNames): string {
  return speakerName(speaker, lang, names);
}

/**
 * Parse an editable clock ("1:02", "1:02:03", "75:30") into seconds.
 * Returns null when the text is not a valid clock. Seconds stay under 60;
 * minutes may exceed 59 only in the two-part "m:ss" form (75:30 = 75.5 min).
 */
export function parseClock(text: string): number | null {
  const clean = text.trim().replace(/^[[(]/, '').replace(/[\])]/, '');
  if (!/^\d{1,3}(:\d{1,2}){1,2}([.,]\d{1,3})?$/.test(clean)) return null;
  const parts = clean.replace(',', '.').split(':').map(Number);
  if (parts.some((part) => Number.isNaN(part))) return null;
  const seconds = parts.pop() as number;
  if (seconds > 59) return null;
  if (parts.length >= 2) {
    const [hours, minutes] = parts;
    if (minutes > 59) return null;
    return (hours * 60 + minutes) * 60 + seconds;
  }
  return (parts[0] ?? 0) * 60 + seconds;
}

function formatDate(timestamp: number): string {
  const date = new Date(Number.isFinite(timestamp) ? timestamp : 0);
  if (Number.isNaN(date.getTime())) return '1970-01-01';
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )}`;
}

function effectiveSpeakerCount(session: Session): number {
  const fromSegments = session.segments.reduce(
    (max, segment) =>
      Number.isFinite(segment.speaker)
        ? Math.max(max, Math.floor(segment.speaker) + 1)
        : max,
    0,
  );
  return Math.max(
    Number.isFinite(session.speakerCount) ? Math.max(0, session.speakerCount) : 0,
    fromSegments,
  );
}

function displayTitle(session: Session, lang: Lang): string {
  const title = normalizeText(session.title ?? '');
  return title.length > 0 ? title : translate(lang, 'export.untitled');
}

function metadataPairs(session: Session, lang: Lang): Array<[string, string]> {
  return [
    [translate(lang, 'export.meta.date'), formatDate(session.createdAt)],
    [translate(lang, 'export.meta.duration'), formatDuration(session.duration)],
    [translate(lang, 'export.meta.language'), session.language || translate(lang, 'export.language.unknown')],
    [translate(lang, 'export.meta.model'), session.model || translate(lang, 'export.language.unknown')],
    [translate(lang, 'export.meta.speakers'), String(effectiveSpeakerCount(session))],
  ];
}

function metadataLine(session: Session, lang: Lang, separator = ' · '): string {
  return metadataPairs(session, lang)
    .map(([label, value]) => `${label}: ${value}`)
    .join(separator);
}

/**
 * Format a duration as a clock: 0:00, 12:34 or 1:02:03.
 * Negative and non-finite values are treated as zero.
 */
export function formatClock(seconds: number): string {
  const total = Math.floor(finiteSeconds(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(secs)}`;
  return `${minutes}:${pad(secs)}`;
}

/**
 * Compact human-readable duration: "45 s", "12 min 34 s", "1 h 2 min".
 */
export function formatDuration(seconds: number): string {
  const total = Math.floor(finiteSeconds(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    const parts = [`${hours} h`];
    if (minutes > 0) parts.push(`${minutes} min`);
    if (secs > 0) parts.push(`${secs} s`);
    return parts.join(' ');
  }
  if (minutes > 0) {
    const parts = [`${minutes} min`];
    if (secs > 0) parts.push(`${secs} s`);
    return parts.join(' ');
  }
  return `${secs} s`;
}

export function plainText(session: Session, lang: Lang = 'en'): string {
  const lines: Array<string> = [displayTitle(session, lang), metadataLine(session, lang)];
  const names = session.speakerNames;

  type Group = { speaker: number; start: number; end: number; parts: string[] };
  const groups: Group[] = [];

  for (const segment of session.segments) {
    const text = normalizeText(segment.text);
    if (text.length === 0) continue;
    const start = finiteSeconds(segment.start);
    const end = Math.max(start, finiteSeconds(segment.end));
    const speaker = Number.isFinite(segment.speaker)
      ? Math.max(0, Math.floor(segment.speaker))
      : 0;

    const previous = groups[groups.length - 1];
    if (
      previous &&
      previous.speaker === speaker &&
      start - previous.end <= MERGE_GAP_SECONDS
    ) {
      previous.parts.push(text);
      previous.end = Math.max(previous.end, end);
    } else {
      groups.push({ speaker, start, end, parts: [text] });
    }
  }

  if (groups.length > 0) {
    lines.push('');
    for (const group of groups) {
      lines.push(
        `[${formatClock(group.start)}] ${speakerLabel(group.speaker, lang, names)}: ${group.parts.join(
          ' ',
        )}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]<>#|~])/g, '\\$1');
}

export function markdown(session: Session, lang: Lang = 'en'): string {
  const names = session.speakerNames;
  const segments = session.segments
    .map((segment) => {
      const text = normalizeText(segment.text);
      return `**${speakerLabel(segment.speaker, lang, names)}** [${formatClock(
        segment.start,
      )}] ${escapeMarkdown(text)}`.trimEnd();
    })
    .join('\n\n');

  return [
    `# ${escapeMarkdown(displayTitle(session, lang))}`,
    '',
    metadataPairs(session, lang)
      .map(([label, value]) => `**${label}:** ${escapeMarkdown(value)}`)
      .join(' · '),
    '',
    '---',
    '',
    ...(segments.length > 0 ? [segments] : [`_${translate(lang, 'export.noSegments')}_`]),
    '',
  ].join('\n');
}

function clockParts(seconds: number): {
  hours: number;
  minutes: number;
  seconds: number;
  millis: number;
} {
  // Guard against binary floating point such as 65.999 * 1000 = 65998.999...
  const totalMillis = Math.round(finiteSeconds(seconds) * 1000 + 1e-6);
  const hours = Math.floor(totalMillis / 3_600_000);
  const minutes = Math.floor((totalMillis % 3_600_000) / 60_000);
  const secs = Math.floor((totalMillis % 60_000) / 1000);
  const millis = totalMillis % 1000;
  return { hours, minutes, seconds: secs, millis };
}

function srtTimestamp(seconds: number): string {
  const part = clockParts(seconds);
  return `${pad(part.hours)}:${pad(part.minutes)}:${pad(part.seconds)},${String(
    part.millis,
  ).padStart(3, '0')}`;
}

function vttTimestamp(seconds: number): string {
  const part = clockParts(seconds);
  return `${pad(part.hours)}:${pad(part.minutes)}:${pad(part.seconds)}.${String(
    part.millis,
  ).padStart(3, '0')}`;
}

function cueText(segment: TranscriptSegment, lang: Lang, names?: SpeakerNames): string {
  const text = normalizeText(segment.text);
  return text.length > 0
    ? `${speakerLabel(segment.speaker, lang, names)}: ${text}`
    : speakerLabel(segment.speaker, lang, names);
}

export function srt(session: Session, lang: Lang = 'en'): string {
  const names = session.speakerNames;
  return session.segments
    .map((segment, index) => {
      const start = finiteSeconds(segment.start);
      const end = Math.max(start, finiteSeconds(segment.end));
      return [
        String(index + 1),
        `${srtTimestamp(start)} --> ${srtTimestamp(end)}`,
        cueText(segment, lang, names),
      ].join('\n');
    })
    .map((block) => `${block}\n`)
    .join('\n');
}

export function vtt(session: Session, lang: Lang = 'en'): string {
  const names = session.speakerNames;
  const cues = session.segments
    .map((segment) => {
      const start = finiteSeconds(segment.start);
      const end = Math.max(start, finiteSeconds(segment.end));
      return [
        `${vttTimestamp(start)} --> ${vttTimestamp(end)}`,
        cueText(segment, lang, names),
      ].join('\n');
    })
    .join('\n\n');

  return cues.length > 0 ? `WEBVTT\n\n${cues}\n` : 'WEBVTT\n';
}

export function jsonTranscript(session: Session): string {
  const payload = {
    format: 'coso-transcript',
    version: 1,
    metadata: {
      id: session.id,
      title: session.title ?? '',
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      duration: session.duration,
      language: session.language,
      model: session.model,
      speakerCount: session.speakerCount,
      wordCount: session.wordCount,
      sourceName: session.sourceName,
    },
    segments: session.segments.map((segment) => ({
      id: segment.id,
      start: finiteSeconds(segment.start),
      end: Math.max(finiteSeconds(segment.start), finiteSeconds(segment.end)),
      text: segment.text,
      speaker: Number.isFinite(segment.speaker)
        ? Math.max(0, Math.floor(segment.speaker))
        : 0,
      speakerLabel: speakerLabel(segment.speaker, 'en', session.speakerNames),
      confidence: segment.confidence,
    })),
  };

  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Convenience text document; callers that need DOCX/PDF use those helpers. */
export function transcriptDocument(session: Session, lang: Lang = 'en'): Blob | null {
  return new Blob([plainText(session, lang)], { type: 'text/plain;charset=utf-8' });
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

export function exportFilename(session: Session, extension: string): string {
  const slug = slugify(displayTitle(session, 'en')) || 'untitled-transcript';
  const date = formatDate(session.createdAt);
  const cleanExtension = extension.replace(/^\.+/, '').toLowerCase();
  return cleanExtension.length > 0
    ? `${slug}-${date}.${cleanExtension}`
    : `${slug}-${date}`;
}

const AUDIO_EXTENSIONS: Array<[RegExp, string]> = [
  [/wav/i, 'wav'],
  [/mpeg|mp3/i, 'mp3'],
  [/mp4|m4a|aac/i, 'm4a'],
  [/webm/i, 'webm'],
  [/ogg/i, 'ogg'],
  [/flac/i, 'flac'],
];

/** File extension for a session's saved recording, inferred from its name or MIME type. */
export function audioExtension(session: Session): string {
  const fromName = /\.([a-z0-9]{2,5})$/i.exec(session.sourceName ?? '')?.[1];
  if (fromName) return fromName.toLowerCase();

  const mime = session.audioMime ?? '';
  for (const [pattern, extension] of AUDIO_EXTENSIONS) {
    if (pattern.test(mime)) return extension;
  }
  return 'webm';
}

export function downloadBlob(blob: Blob, filename: string): void {
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return;
  }

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function docxBlob(session: Session, lang: Lang = 'en'): Promise<Blob> {
  const title = displayTitle(session, lang);
  const metadata = metadataPairs(session, lang)
    .map(([label, value]) => `${label}: ${value}`)
    .join('   ·   ');

  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { after: 120 },
      children: [new TextRun({ text: title, bold: true })],
    }),
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({ text: metadata, size: 18, color: '666666' }),
      ],
    }),
  ];

  if (session.segments.length === 0) {
    children.push(
      new Paragraph({
        spacing: { before: 240 },
        children: [
          new TextRun({
            text: translate(lang, 'export.noSegments'),
            italics: true,
            color: '777777',
          }),
        ],
      }),
    );
  } else {
    for (const segment of session.segments) {
      const text = normalizeText(segment.text);
      const runs: TextRun[] = [
        new TextRun({
          text: speakerLabel(segment.speaker, lang, session.speakerNames),
          bold: true,
          size: 20,
          color: '1F2937',
        }),
        new TextRun({
          text: `  [${formatClock(segment.start)}]  `,
          size: 18,
          color: '6B7280',
        }),
      ];
      if (text.length > 0) {
        runs.push(new TextRun({ text, size: 22, color: '111827' }));
      }
      children.push(
        new Paragraph({
          spacing: { after: 180 },
          children: runs,
        }),
      );
    }
  }

  const doc = new Document({
    creator: 'Coso Audio',
    title,
    description: `Transcript exported from Coso Audio on ${formatDate(
      Date.now(),
    )}`,
    sections: [
      {
        properties: {
          page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: 'Page ', size: 16, color: '888888' }),
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    size: 16,
                    color: '888888',
                  }),
                  new TextRun({ text: ' of ', size: 16, color: '888888' }),
                  new TextRun({
                    children: [PageNumber.TOTAL_PAGES],
                    size: 16,
                    color: '888888',
                  }),
                ],
              }),
            ],
          }),
        },
        children,
      },
    ],
  });

  const blob = await Packer.toBlob(doc);
  return new Blob([blob], { type: DOCX_MIME });
}

const WIN_ANSI_REPLACEMENTS: Record<string, string> = {
  '\u00a0': ' ',
  '\u00ad': '',
  '\u2018': "'",
  '\u2019': "'",
  '\u201a': "'",
  '\u201b': "'",
  '\u201c': '"',
  '\u201d': '"',
  '\u201e': '"',
  '\u201f': '"',
  '\u2013': '-',
  '\u2014': '-',
  '\u2212': '-',
  '\u2026': '...',
  '\u2022': '-',
  '\u00b7': '-',
  '\u2039': '<',
  '\u203a': '>',
  '\u20ac': 'EUR',
  '\u2122': '(TM)',
};

function winAnsiSafe(value: string): string {
  let result = '';
  for (const char of value) {
    const replacement = WIN_ANSI_REPLACEMENTS[char];
    if (replacement !== undefined) {
      result += replacement;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      result += char;
    } else if (code === 0x09 || code === 0x0a || code === 0x0d) {
      result += ' ';
    } else {
      result += '?';
    }
  }
  return result;
}

export function pdfBlob(session: Session, lang: Lang = 'en'): Blob {
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  const pageWidth = 210;
  const pageHeight = 297;
  const margin = 18;
  const footerY = pageHeight - 10;
  const contentWidth = pageWidth - margin * 2;
  const bottomLimit = pageHeight - 24;
  let y = margin;

  doc.setProperties({
    title: displayTitle(session, lang),
    subject: 'Transcript',
    creator: 'Coso Audio',
  });

  const ensureSpace = (needed: number) => {
    if (y + needed > bottomLimit) {
      doc.addPage();
      y = margin;
    }
  };

  const title = winAnsiSafe(displayTitle(session, lang));
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(17, 24, 39);
  const titleLines = doc.splitTextToSize(title, contentWidth) as string[];
  for (const line of titleLines) {
    ensureSpace(9);
    doc.text(line, margin, y);
    y += 9;
  }

  y += 2;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(90, 90, 90);
  const metadata = winAnsiSafe(metadataLine(session, lang, '   ·   '));
  for (const line of doc.splitTextToSize(metadata, contentWidth) as string[]) {
    ensureSpace(5);
    doc.text(line, margin, y);
    y += 5;
  }

  y += 3;
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.line(margin, y, pageWidth - margin, y);
  y += 8;

  if (session.segments.length === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10.5);
    doc.setTextColor(110, 110, 110);
    doc.text(translate(lang, 'export.noSegments'), margin, y);
  } else {
    for (const segment of session.segments) {
      const text = winAnsiSafe(normalizeText(segment.text));
      const speaker = winAnsiSafe(
        `${speakerLabel(segment.speaker, lang, session.speakerNames)}  [${formatClock(segment.start)}]`,
      );

      ensureSpace(6 + 5.2);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(31, 41, 55);
      doc.text(speaker, margin, y);
      y += 5.2;

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(10.5);
      doc.setTextColor(17, 24, 39);
      const lines =
        text.length > 0
          ? (doc.splitTextToSize(text, contentWidth) as string[])
          : [''];
      for (const line of lines) {
        ensureSpace(5.2);
        if (line.length > 0) doc.text(line, margin, y);
        y += 5.2;
      }
      y += 3;
    }
  }

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page += 1) {
    doc.setPage(page);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(130, 130, 130);
    doc.text(`${translate(lang, 'export.pdf.page')} ${page} ${translate(lang, 'export.pdf.pageOf')} ${pageCount}`, pageWidth / 2, footerY, {
      align: 'center',
    });
  }

  return doc.output('blob');
}
