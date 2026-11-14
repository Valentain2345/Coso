import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Pencil, Play, RotateCcw, Search, Share2, X } from 'lucide-react';
import type { Session, TranscriptSegment } from '../types';
import type { usePlayer } from '../hooks/usePlayer';
import { useI18n } from '../i18n';
import { speakerColor, timestamp } from './ui/primitives';
import { parseClock } from '../lib/export/formats';
import { shareTranscript } from '../lib/share';
import type { ToastTone } from './Toast';

interface Props {
  session: Session;
  player: ReturnType<typeof usePlayer>;
  onEditSegment: (id: string, text: string) => void;
  onEditSegmentStart: (id: string, start: number) => void;
  onRenameSpeaker: (speaker: number, name: string) => void;
  onReprocess?: () => void;
  onToast: (title: string, tone?: ToastTone, description?: string) => void;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;
  const parts = text.split(new RegExp(`(${escapeRegExp(query.trim())})`, 'ig'));
  return (
    <>
      {parts.map((part, index) =>
        part.toLowerCase() === query.trim().toLowerCase() ? <mark key={index}>{part}</mark> : <React.Fragment key={index}>{part}</React.Fragment>,
      )}
    </>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

function segmentLine(speakerLabel: string, segment: TranscriptSegment): string {
  return `${speakerLabel} [${timestamp(segment.start)}] ${segment.text}`;
}

export const TranscriptView: React.FC<Props> = ({ session, player, onEditSegment, onEditSegmentStart, onRenameSpeaker, onReprocess, onToast }) => {
  const { lang, t } = useI18n();
  const [query, setQuery] = useState('');
  const [speaker, setSpeaker] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const speakerLabel = (index: number) =>
    session.speakerNames?.[String(index)]?.trim() || t('count.speakerWord', { n: index + 1 });

  const speakers = useMemo(() => {
    const set = new Set<number>();
    for (const segment of session.segments) set.add(segment.speaker);
    return Array.from(set).sort((a, b) => a - b);
  }, [session.segments]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return session.segments.filter((segment) => {
      if (speaker !== null && segment.speaker !== speaker) return false;
      if (!needle) return true;
      return (
        segment.text.toLowerCase().includes(needle) ||
        speakerLabel(segment.speaker).toLowerCase().includes(needle)
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.segments, session.speakerNames, query, speaker, t]);

  const activeId = useMemo(() => {
    if (!player.playing && player.currentTime === 0) return null;
    const active = session.segments.find(
      (segment) => player.currentTime >= segment.start && player.currentTime < Math.max(segment.end, segment.start + 0.4),
    );
    return active?.id ?? null;
  }, [session.segments, player.currentTime, player.playing]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
      if (event.key === 'Escape' && document.activeElement === searchRef.current) {
        setQuery('');
        searchRef.current?.blur();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!player.playing || !activeId) return;
    const node = rowRefs.current.get(activeId);
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const margin = 120;
    if (rect.top < margin || rect.bottom > window.innerHeight - 120) {
      node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [activeId, player.playing]);

  const copy = async () => {
    const text = [
      session.title,
      '',
      ...filtered.map((segment) => segmentLine(speakerLabel(segment.speaker), segment)),
    ].join('\n');
    const ok = await copyText(text);
    if (!ok) {
      onToast(t('transcript.copyFail.title'), 'error', t('transcript.copyFail.desc'));
      return;
    }
    setCopied(true);
    onToast(t('transcript.copyOk.title'), 'success', t('count.passages', { count: filtered.length }));
    window.setTimeout(() => setCopied(false), 2000);
  };

  const share = async () => {
    const outcome = await shareTranscript(session, lang);
    if (outcome === 'shared') {
      onToast(t('transcript.share.ok.title'), 'success', t('transcript.share.ok.desc'));
      return;
    }
    if (outcome === 'copied') {
      setCopied(true);
      onToast(t('transcript.share.copied.title'), 'success', t('transcript.share.copied.desc'));
      window.setTimeout(() => setCopied(false), 2000);
      return;
    }
    if (outcome === 'failed') {
      onToast(t('transcript.share.fail.title'), 'error', t('transcript.share.fail.desc'));
    }
    // 'cancelled' is the user dismissing the share sheet: stay silent.
  };

  const commitEdit = (segment: TranscriptSegment, element: HTMLElement) => {
    const next = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!next) {
      element.textContent = segment.text;
      return;
    }
    if (next !== segment.text) onEditSegment(segment.id, next);
  };

  const commitSpeaker = (index: number, element: HTMLElement) => {
    const next = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    onRenameSpeaker(index, next);
  };

  const commitTime = (segment: TranscriptSegment, element: HTMLElement) => {
    const seconds = parseClock(element.textContent ?? '');
    if (seconds === null) {
      element.textContent = timestamp(segment.start);
      onToast(t('transcript.time.invalid'), 'error');
      return;
    }
    if (Math.abs(seconds - segment.start) > 0.05) onEditSegmentStart(segment.id, seconds);
  };

  const editKeyDown = (
    event: React.KeyboardEvent<HTMLElement>,
    restore: () => void,
  ) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      restore();
      event.currentTarget.blur();
    }
  };

  return (
    <section className="transcript-card" aria-label={t('transcript.heading')}>
      <header className="transcript-head">
        <div className="transcript-heading">
          <h2>{t('transcript.heading')}</h2>
          <p>
            {t('count.passages', { count: session.segments.length })}
            {speakers.length > 1 ? ` · ${t('count.speakers', { count: speakers.length })}` : ''}
            <span className="save-note">{t('transcript.autosave')}</span>
          </p>
        </div>

        <div className="transcript-tools">
          <label className="transcript-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('transcript.search.placeholder')}
              aria-label={t('transcript.search.aria')}
              spellCheck={false}
            />
            {query && (
              <button className="icon-btn search-clear" onClick={() => setQuery('')} aria-label={t('transcript.search.clear')}>
                <X size={14} />
              </button>
            )}
            <kbd>⌘F</kbd>
          </label>

          <button className="btn btn-ghost btn-small" onClick={() => void copy()}>
            {copied ? <Check size={15} /> : <Copy size={15} />}
            {copied ? t('common.copied') : t('common.copy')}
          </button>

          <button
            className="btn btn-ghost btn-small"
            onClick={() => void share()}
            title={t('transcript.share.label')}
          >
            <Share2 size={15} />
            {t('transcript.share.label')}
          </button>

          <button
            className={`btn btn-ghost btn-small ${editing ? 'active' : ''}`}
            onClick={() => setEditing((value) => !value)}
            aria-pressed={editing}
            title={t('transcript.edit.title')}
          >
            {editing ? <Check size={15} /> : <Pencil size={15} />}
            {editing ? t('common.done') : t('common.edit')}
          </button>

          {session.audioBlob && onReprocess && (
            <button
              className="btn btn-ghost btn-small"
              onClick={onReprocess}
              title={t('transcript.reprocess.title')}
            >
              <RotateCcw size={15} />
              {t('transcript.reprocess.label')}
            </button>
          )}
        </div>
      </header>

      {speakers.length > 1 && (
        <div className="speaker-filter" aria-label={t('transcript.filter.aria')}>
          <button className={`speaker-chip ${speaker === null ? 'active' : ''}`} onClick={() => setSpeaker(null)}>
            {t('transcript.filter.everyone')}
          </button>
          {speakers.map((index) => (
            <button
              key={index}
              className={`speaker-chip ${speaker === index ? 'active' : ''}`}
              onClick={() => setSpeaker(speaker === index ? null : index)}
            >
              <span className="speaker-dot" style={{ background: speakerColor(index) }} />
              {speakerLabel(index)}
            </button>
          ))}
        </div>
      )}

      {editing && (
        <div className="edit-banner" role="status">
          {t('transcript.edit.banner')}
        </div>
      )}

      <div className="transcript-body">
        {filtered.length === 0 && (
          <div className="transcript-empty">
            <Search size={20} aria-hidden="true" />
            <p>{query ? t('transcript.empty.query', { query }) : t('transcript.empty.speaker')}</p>
            <button
              className="btn btn-ghost btn-small"
              onClick={() => {
                setQuery('');
                setSpeaker(null);
              }}
            >
              {t('transcript.empty.clear')}
            </button>
          </div>
        )}

        {filtered.map((segment) => (
          <div
            key={segment.id}
            ref={(node) => {
              if (node) rowRefs.current.set(segment.id, node);
              else rowRefs.current.delete(segment.id);
            }}
            className={`segment ${activeId === segment.id ? 'segment-active' : ''}`}
            data-speaker={segment.speaker % 6}
          >
            <div className="segment-rail">
              <span className="segment-dot" style={{ background: speakerColor(segment.speaker) }} aria-hidden="true" />
              {editing ? (
                <span
                  className="segment-time segment-time-edit"
                  contentEditable
                  suppressContentEditableWarning
                  spellCheck={false}
                  role="textbox"
                  inputMode="numeric"
                  aria-label={t('transcript.time.aria', { time: timestamp(segment.start) })}
                  onBlur={(event) => commitTime(segment, event.currentTarget)}
                  onKeyDown={(event) => editKeyDown(event, () => { event.currentTarget.textContent = timestamp(segment.start); })}
                >
                  {timestamp(segment.start)}
                </span>
              ) : (
                <button
                  className="segment-time"
                  onClick={() => player.playAt(segment.start)}
                  title={t('transcript.play.title')}
                  aria-label={t('transcript.play.aria', { time: timestamp(segment.start) })}
                >
                  <Play size={10} fill="currentColor" aria-hidden="true" />
                  {timestamp(segment.start)}
                </button>
              )}
            </div>

            <div className="segment-main">
              {editing ? (
                <span
                  className="segment-speaker segment-speaker-edit"
                  style={{ color: speakerColor(segment.speaker) }}
                  contentEditable
                  suppressContentEditableWarning
                  spellCheck={false}
                  role="textbox"
                  aria-label={t('transcript.speaker.rename.aria', { n: segment.speaker + 1 })}
                  onBlur={(event) => commitSpeaker(segment.speaker, event.currentTarget)}
                  onKeyDown={(event) => editKeyDown(event, () => { event.currentTarget.textContent = speakerLabel(segment.speaker); })}
                >
                  {speakerLabel(segment.speaker)}
                </span>
              ) : (
                <span className="segment-speaker" style={{ color: speakerColor(segment.speaker) }}>
                  {speakerLabel(segment.speaker)}
                </span>
              )}
              <p
                className="segment-text"
                contentEditable={editing}
                suppressContentEditableWarning
                spellCheck={editing}
                role={editing ? 'textbox' : undefined}
                aria-multiline={editing ? 'true' : undefined}
                aria-label={editing ? t('transcript.edit.aria', { n: segment.speaker + 1 }) : undefined}
                onBlur={(event) => commitEdit(segment, event.currentTarget)}
                onKeyDown={(event) => {
                  if (!editing) return;
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.blur();
                  }
                  if (event.key === 'Escape') {
                    event.currentTarget.textContent = segment.text;
                    event.currentTarget.blur();
                  }
                }}
              >
                <Highlighted text={segment.text} query={query} />
              </p>
            </div>

            <span className="segment-end">{timestamp(segment.end)}</span>
          </div>
        ))}
      </div>
    </section>
  );
};
