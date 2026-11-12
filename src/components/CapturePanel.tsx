import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  Cpu,
  FileAudio,
  Mic,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { JobState, SessionMeta } from '../types';
import type { useRecorder } from '../hooks/useRecorder';
import { useI18n } from '../i18n';
import { formatDate, formatDurationLong, WaveMark } from './ui/primitives';

interface Props {
  recorder: ReturnType<typeof useRecorder>;
  sessions: SessionMeta[];
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
  onCancel: () => void;
  onFile: (file: File) => void;
  onOpen: (id: string) => void;
  job?: JobState | null;
  onResumeJob?: (job: JobState) => void;
  onDiscardJob?: (job: JobState) => void;
  warning?: string | null;
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

export const CapturePanel: React.FC<Props> = ({
  recorder,
  sessions,
  onStart,
  onPause,
  onResume,
  onStop,
  onCancel,
  onFile,
  onOpen,
  job,
  onResumeJob,
  onDiscardJob,
  warning,
}) => {
  const { lang, t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const isRecording = recorder.status === 'recording' || recorder.status === 'paused';
  const recent = sessions.slice(0, 3);

  const chooseFile = () => inputRef.current?.click();

  const pick = (file: File | undefined | null) => {
    if (!file) return;
    onFile(file);
    if (inputRef.current) inputRef.current.value = '';
  };

  const savedLabel = (processed: number, duration: number): string => {
    const round = (value: number) => Math.max(0, Math.round(value));
    if (duration < 90) return t('resume.savedS', { done: round(processed), total: round(duration) });
    const minutes = (value: number) => Math.round(value / 60);
    return t('resume.savedMin', { done: minutes(processed), total: minutes(duration) });
  };

  return (
    <section className="capture" aria-label={t('app.newTranscript')}>
      <div className="capture-head">
        <span className="eyebrow">
          <WaveMark size={15} />
          {t('capture.eyebrow')}
        </span>
        <h1 className="capture-title">
          {t('capture.title1')}
          <br />
          {t('capture.title2')}
          <em>{t('capture.titleEm')}</em>
          {t('capture.title3')}
        </h1>
        <p className="capture-sub">{t('capture.sub')}</p>
      </div>

      {recorder.error && (
        <div className="inline-alert" role="alert">
          <X size={16} />
          <span>{recorder.error}</span>
          <button className="icon-btn" onClick={recorder.clearError} aria-label={t('capture.micError.aria')}>
            <X size={14} />
          </button>
        </div>
      )}

      {job && !isRecording && (
        <div className="resume-card" role="status">
          <div className="resume-copy">
            <span className="eyebrow">
              <RotateCcw size={14} /> {t('resume.eyebrow')}
            </span>
            <strong>{job.title}</strong>
            <span>
              {savedLabel(job.processed, job.duration)}
              {job.status === 'error' ? t('resume.errorSuffix') : ''}
              {t('resume.stored')}
            </span>
            <div className="resume-track" aria-hidden="true">
              <span style={{ width: `${Math.min(100, (job.processed / Math.max(1, job.duration)) * 100)}%` }} />
            </div>
          </div>
          <div className="resume-actions">
            <button className="btn btn-primary btn-small" onClick={() => onResumeJob?.(job)}>
              <Play size={15} /> {t('common.resume')}
            </button>
            <button className="btn btn-ghost btn-small" onClick={() => onDiscardJob?.(job)} title={t('resume.discard.title')}>
              <Trash2 size={15} /> {t('common.discard')}
            </button>
          </div>
        </div>
      )}

      {isRecording ? (
        <div className="recording-card">
          <div className="recording-status">
            <span className={`live-dot ${recorder.paused ? 'paused' : ''}`} aria-hidden="true" />
            <span>{recorder.paused ? t('recording.paused') : t('recording.recording')}</span>
            <span className="recording-hint">{t('recording.hint')}</span>
          </div>

          <div className="recording-clock" aria-live="off">
            {clock(recorder.duration)}
          </div>

          <div className="live-wave" aria-hidden="true">
            {recorder.levels.map((level, index) => (
              <span
                key={index}
                style={{ height: `${Math.max(3, Math.round(level * 58))}px` }}
                className={recorder.paused ? 'muted' : ''}
              />
            ))}
          </div>

          <div className="recording-controls">
            <button className="btn btn-ghost" onClick={onCancel} title={t('resume.discard.title')}>
              <X size={16} />
              {t('common.discard')}
            </button>
            {recorder.paused ? (
              <button className="btn btn-secondary" onClick={onResume}>
                <Play size={16} />
                {t('common.resume')}
              </button>
            ) : (
              <button className="btn btn-secondary" onClick={onPause}>
                <Pause size={16} />
                {t('common.pause')}
              </button>
            )}
            <button className="btn btn-primary btn-stop" onClick={onStop}>
              <Square size={14} fill="currentColor" />
              {t('recording.stop')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="capture-actions">
            <button
              className="record-button"
              onClick={onStart}
              disabled={recorder.status === 'requesting' || recorder.status === 'unsupported'}
            >
              <span className="record-ring" aria-hidden="true">
                <Mic size={26} />
              </span>
              <span className="record-copy">
                <strong>{recorder.status === 'requesting' ? t('capture.record.opening') : t('capture.record.strong')}</strong>
                <span>{recorder.status === 'unsupported' ? t('capture.record.unavailable') : t('capture.record.sub')}</span>
              </span>
              <ArrowRight size={18} className="record-arrow" aria-hidden="true" />
            </button>

            <button className="import-button" onClick={chooseFile}>
              <Upload size={20} />
              <span>
                <strong>{t('capture.import.strong')}</strong>
                <span>{t('capture.import.sub')}</span>
              </span>
            </button>

            <input
              ref={inputRef}
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac,.webm,.aac"
              hidden
              onChange={(event) => pick(event.target.files?.[0])}
            />
          </div>

          <div
            className={`drop-zone ${dragging ? 'dragging' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              pick(event.dataTransfer.files?.[0]);
            }}
            onClick={chooseFile}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                chooseFile();
              }
            }}
            role="button"
            tabIndex={0}
            aria-label={t('capture.drop.aria')}
          >
            <FileAudio size={18} aria-hidden="true" />
            <span>{t('capture.drop.text')}</span>
            <small>{t('capture.drop.hint')}</small>
          </div>

          {warning && (
            <div className="model-warning capture-warning" role="status">
              <AlertTriangle size={15} aria-hidden="true" />
              <span>{warning} {t('warning.changeInSettings')}</span>
            </div>
          )}

          <div className="capture-notes">
            <div>
              <ShieldCheck size={16} aria-hidden="true" />
              <span>{t('capture.notes.privacy')}</span>
            </div>
            <div>
              <Cpu size={16} aria-hidden="true" />
              <span>{t('capture.notes.local')}</span>
            </div>
            <div>
              <Clock size={16} aria-hidden="true" />
              <span>{t('capture.notes.chunks')}</span>
            </div>
          </div>

          {recent.length > 0 && (
            <div className="recent-block">
              <div className="recent-head">
                <h2>{t('capture.recent.heading')}</h2>
                <span>{t('count.saved', { count: sessions.length })}</span>
              </div>
              <div className="recent-list">
                {recent.map((session) => (
                  <button key={session.id} className="recent-card" onClick={() => onOpen(session.id)}>
                    <span className="recent-title">{session.title}</span>
                    <span className="recent-meta">
                      {formatDate(session.createdAt, lang)} · {formatDurationLong(session.duration, lang)}
                    </span>
                    <span className="recent-stats">
                      {t('count.words', { count: session.wordCount })}
                      {session.speakerCount > 1 ? ` · ${t('count.speakers', { count: session.speakerCount })}` : ''}
                    </span>
                    <ArrowRight size={16} className="recent-arrow" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
};
