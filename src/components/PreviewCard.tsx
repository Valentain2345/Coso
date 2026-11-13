import React, { useCallback, useEffect, useRef } from 'react';
import { Loader2, Play, SlidersHorizontal, X } from 'lucide-react';
import type { TranscribeSource } from '../hooks/useTranscription';
import { useI18n } from '../i18n';

export const PREVIEW_SECONDS = 5;

interface Props {
  source: TranscribeSource;
  busy?: boolean;
  onStart: () => void;
  onOpenSettings: () => void;
  onCancel: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function formatClock(seconds: number): string {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Plays the first PREVIEW_SECONDS seconds of a source so the user can judge
 * the recording before committing to a (potentially long) transcription run.
 */
export const PreviewCard: React.FC<Props> = ({ source, busy = false, onStart, onOpenSettings, onCancel }) => {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [position, setPosition] = React.useState(0);
  const [duration, setDuration] = React.useState<number | null>(null);
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(source.blob);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [source.blob]);

  const playPreview = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = 0;
    // jsdom's play() returns undefined; real browsers return a promise.
    void Promise.resolve(audio.play()).catch(() => undefined);
  }, []);

  // Cut playback off at the preview mark.
  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.currentTime >= PREVIEW_SECONDS) {
      audio.pause();
      audio.currentTime = PREVIEW_SECONDS;
    }
    setPosition(audio.currentTime);
  }, []);

  return (
    <section className="preview-card" aria-label={t('preview.aria')}>
      <div className="preview-head">
        <span className="preview-wave" aria-hidden="true">
          <span className="wave-bars">
            <span style={{ height: '40%' }} /><span style={{ height: '75%' }} />
            <span style={{ height: '55%' }} /><span style={{ height: '90%' }} />
            <span style={{ height: '35%' }} /><span style={{ height: '65%' }} />
          </span>
        </span>
        <div className="preview-titles">
          <h2>{t('preview.title')}</h2>
          <p className="preview-source" title={source.name ?? undefined}>
            {source.name ?? t('preview.micSource')} · {formatBytes(source.blob.size)}
            {duration !== null ? ` · ${formatClock(duration)}` : ''}
          </p>
        </div>
        <button className="preview-close" onClick={onCancel} aria-label={t('common.cancel')}>
          <X size={18} />
        </button>
      </div>

      {objectUrl && (
        <audio
          ref={audioRef}
          src={objectUrl}
          preload="metadata"
          onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
          onTimeUpdate={handleTimeUpdate}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
        />
      )}

      <div className="preview-meter" aria-hidden="true">
        <span
          className="preview-meter-fill"
          style={{ width: `${Math.min(100, (position / PREVIEW_SECONDS) * 100)}%` }}
        />
      </div>

      <p className="preview-hint">{t('preview.hint', { seconds: PREVIEW_SECONDS })}</p>

      <div className="preview-actions">
        <button className="btn btn-ghost" onClick={playPreview} disabled={busy}>
          {playing ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
          {t('preview.replay')}
        </button>
        <button className="btn btn-ghost" onClick={onOpenSettings} disabled={busy}>
          <SlidersHorizontal size={16} />
          {t('preview.settings')}
        </button>
        <button className="btn btn-primary" onClick={onStart} disabled={busy}>
          {busy ? <Loader2 size={16} className="spin" /> : null}
          {t('preview.start')}
        </button>
      </div>
      <button className="preview-cancel-link" onClick={onCancel} disabled={busy}>
        {t('preview.discard')}
      </button>
    </section>
  );
};
