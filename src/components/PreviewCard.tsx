import React, { useCallback, useEffect, useRef } from 'react';
import { Loader2, Play, SlidersHorizontal, Wand2, X } from 'lucide-react';
import type { TranscribeSource } from '../hooks/useTranscription';
import { useI18n } from '../i18n';
import { PREVIEW_SECONDS, previewSecondsFor } from '../lib/preview';

export { PREVIEW_SECONDS };

interface Props {
  source: TranscribeSource;
  busy?: boolean;
  /** True when the source has already been repaired and the original is kept. */
  enhanced?: boolean;
  /** Extra recordings waiting behind this one. */
  queued?: number;
  onStart: () => void;
  onOpenSettings: () => void;
  onRepair?: () => void;
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
 * Plays the first few seconds of a source so the user can judge the recording
 * before committing to a (potentially long) transcription run. Long sources get
 * a longer window; see `previewSecondsFor`.
 */
export const PreviewCard: React.FC<Props> = ({
  source,
  busy = false,
  enhanced = false,
  queued = 0,
  onStart,
  onOpenSettings,
  onRepair,
  onCancel,
}) => {
  const { t } = useI18n();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [playing, setPlaying] = React.useState(false);
  const [position, setPosition] = React.useState(0);
  const [duration, setDuration] = React.useState<number | null>(null);
  const [objectUrl, setObjectUrl] = React.useState<string | null>(null);

  // The real duration is only known after metadata loads; before that the
  // short preview applies.
  const previewSeconds = previewSecondsFor(duration);

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
    if (audio.currentTime >= previewSeconds) {
      audio.pause();
      audio.currentTime = previewSeconds;
    }
    setPosition(audio.currentTime);
  }, [previewSeconds]);

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
          <h2>
            {t('preview.title')}
            {enhanced && <span className="preview-badge">{t('preview.enhanced')}</span>}
          </h2>
          <p className="preview-source" title={source.name ?? undefined}>
            {source.name ?? t('preview.micSource')} · {formatBytes(source.blob.size)}
            {duration !== null ? ` · ${formatClock(duration)}` : ''}
          </p>
          {queued > 0 && (
            <p className="preview-queue">{t('preview.queued', { count: queued })}</p>
          )}
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
          style={{ width: `${Math.min(100, (position / previewSeconds) * 100)}%` }}
        />
      </div>

      <p className="preview-hint">{t('preview.hint', { seconds: previewSeconds })}</p>

      <div className="preview-actions">
        <button className="btn btn-ghost" onClick={playPreview} disabled={busy}>
          {playing ? <Loader2 size={16} className="spin" /> : <Play size={16} />}
          {t('preview.replay')}
        </button>
        <button className="btn btn-ghost" onClick={onOpenSettings} disabled={busy}>
          <SlidersHorizontal size={16} />
          {t('preview.settings')}
        </button>
        {onRepair && (
          <button className="btn btn-ghost" onClick={onRepair} disabled={busy}>
            <Wand2 size={16} />
            {t('preview.repair')}
          </button>
        )}
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
