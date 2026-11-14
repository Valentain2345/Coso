import React from 'react';
import { AlertCircle, Check, Loader2, Minimize2, RotateCcw, X } from 'lucide-react';
import type { ProgressUpdate } from '../types';
import { useI18n, type TKey } from '../i18n';
import { localizeProgress } from '../i18n/progress';

interface Props {
  progress: ProgressUpdate;
  elapsed: number;
  error: string | null;
  sourceName: string | null;
  /** 1-based position in a multi-file batch, when there is one. */
  batchIndex?: number;
  batchTotal?: number;
  onCancel: () => void;
  /** Collapse to the compact bar and keep working while the run continues. */
  onMinimize?: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

const STEPS: Array<{ id: string; labelKey: TKey; noteKey: TKey }> = [
  { id: 'decode', labelKey: 'progress.step.decode.label', noteKey: 'progress.step.decode.note' },
  { id: 'load', labelKey: 'progress.step.load.label', noteKey: 'progress.step.load.note' },
  { id: 'transcribe', labelKey: 'progress.step.transcribe.label', noteKey: 'progress.step.transcribe.note' },
  { id: 'diarize', labelKey: 'progress.step.diarize.label', noteKey: 'progress.step.diarize.note' },
  { id: 'save', labelKey: 'progress.step.save.label', noteKey: 'progress.step.save.note' },
];

function formatElapsed(seconds: number, label: string, unit: string): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(total / 60);
  return `${minutes > 0 ? `${minutes} ${label} ` : ''}${total % 60} ${unit}`;
}

function formatRemaining(seconds: number, lang: string): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${minutes % 60} min`;
}

export const ProgressCard: React.FC<Props> = ({
  progress,
  elapsed,
  error,
  sourceName,
  batchIndex,
  batchTotal,
  onCancel,
  onMinimize,
  onRetry,
  onDismiss,
}) => {
  const { lang, t } = useI18n();
  const failed = progress.stage === 'error' || Boolean(error);
  const processed = progress.processed ?? 0;
  const duration = progress.duration ?? 0;
  const eta =
    duration > processed && processed > 2 && elapsed > 3
      ? (elapsed / processed) * (duration - processed)
      : null;
  const currentIndex = STEPS.findIndex((step) => step.id === progress.stage);
  const reached = currentIndex === -1 ? (progress.stage === 'done' ? STEPS.length : 0) : currentIndex;
  const overall = failed
    ? Math.max(4, (reached / STEPS.length) * 100)
    : progress.stage === 'done'
      ? 100
      : Math.min(98, ((reached + Math.max(0, Math.min(1, progress.progress))) / STEPS.length) * 100);

  if (failed) {
    return (
      <section className="progress-card progress-failed" aria-live="polite">
        <div className="progress-fail-head">
          <span className="fail-icon">
            <AlertCircle size={22} />
          </span>
          <div>
            <h2>{t('progress.fail.heading')}</h2>
            <p>{error ?? t('progress.fail.default')}</p>
          </div>
        </div>
        <div className="progress-fail-actions">
          <button className="btn btn-ghost" onClick={onDismiss}>
            <X size={16} />
            {t('common.back')}
          </button>
          <button className="btn btn-primary" onClick={onRetry}>
            <RotateCcw size={16} />
            {t('common.tryAgain')}
          </button>
        </div>
        <p className="progress-foot">{t('progress.fail.hint')}</p>
      </section>
    );
  }

  return (
    <section className="progress-card" aria-live="polite" aria-busy="true">
      <div className="progress-top">
        <span className="progress-pulse" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <div>
          <h2>{localizeProgress(progress.message || '', lang) || t('progress.gettingStarted')}</h2>
          <p>
            {batchTotal && batchTotal > 1 && batchIndex ? (
              <span className="progress-batch">
                {t('progress.batch', { index: batchIndex, total: batchTotal })}
              </span>
            ) : null}
            {sourceName ? <span className="progress-source">{sourceName}</span> : null}
            <span>{t('time.elapsed', { time: formatElapsed(elapsed, t('time.minutes'), t('time.seconds')) })}</span>
            {eta ? <span>{t('time.aboutLeft', { time: formatRemaining(eta, '') })}</span> : null}
            {duration > 0 ? (
              <span>
                {t('time.processedOf', { processed: formatRemaining(processed, ''), total: formatRemaining(duration, '') })}
              </span>
            ) : null}
          </p>
        </div>
        <span className="progress-percent">{Math.round(overall)}%</span>
        {onMinimize && (
          <button
            className="icon-btn progress-minimize"
            onClick={onMinimize}
            aria-label={t('progress.minimize')}
            title={t('progress.minimize')}
          >
            <Minimize2 size={15} />
          </button>
        )}
      </div>

      <div className="progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(overall)}>
        <span style={{ width: `${overall}%` }} />
      </div>

      <ol className="stage-list">
        {STEPS.map((step, index) => {
          const state = index < reached ? 'done' : index === reached ? 'active' : 'pending';
          return (
            <li key={step.id} className={`stage stage-${state}`}>
              <span className="stage-marker">
                {state === 'done' ? <Check size={12} /> : state === 'active' ? <Loader2 size={12} className="spin" /> : null}
              </span>
              <span className="stage-text">
                <strong>{t(step.labelKey)}</strong>
                <span>{t(step.noteKey)}</span>
              </span>
            </li>
          );
        })}
      </ol>

      <div className="progress-actions">
        <button className="btn btn-ghost" onClick={onCancel}>
          <X size={16} />
          {t('common.cancel')}
        </button>
        <span className="progress-tip">{t('progress.tip')}</span>
      </div>
    </section>
  );
};
