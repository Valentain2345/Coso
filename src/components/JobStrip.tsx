import React from 'react';
import { AlertCircle, ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import type { ProgressUpdate } from '../types';
import { useI18n } from '../i18n';
import { localizeProgress } from '../i18n/progress';
import { ProgressCard } from './ProgressCard';

interface Props {
  progress: ProgressUpdate;
  elapsed: number;
  error: string | null;
  sourceName: string | null;
  /** 1-based position in a multi-file run, when there is one. */
  batchIndex?: number;
  batchTotal?: number;
  /** Recordings appended while the current one runs. */
  queued: number;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}

/**
 * Window-wide status strip for the background queue.
 *
 * It sits above the app title bar, so a run never cuts the workspace in half:
 * the user keeps recording, importing and reading below it. The row is the
 * whole story (what is running, how far along, how much is queued); the details
 * panel opens the step-by-step card underneath for anyone who wants it.
 */
export const JobStrip: React.FC<Props> = ({
  progress,
  elapsed,
  error,
  sourceName,
  batchIndex,
  batchTotal,
  queued,
  expanded,
  onToggle,
  onCancel,
  onRetry,
  onDismiss,
}) => {
  const { lang, t } = useI18n();
  const failed = progress.stage === 'error';
  const running = !failed && progress.stage !== 'idle';
  const percent = Math.round(Math.max(0, Math.min(1, progress.progress)) * 100);
  const label = failed
    ? error ?? t('progress.fail.heading')
    : batchTotal && batchTotal > 1 && batchIndex
      ? t('progress.batch', { index: batchIndex, total: batchTotal })
      : localizeProgress(progress.message, lang) || t('progress.gettingStarted');

  return (
    <section
      className={`job-strip${expanded ? ' job-strip-open' : ''}${failed ? ' job-strip-failed' : ''}`}
      aria-label={t('batch.stripAria')}
    >
      <div className="job-strip-row">
        <span className="job-strip-icon" aria-hidden="true">
          {failed ? (
            <AlertCircle size={15} />
          ) : running ? (
            <Loader2 size={15} className="spin" />
          ) : (
            <AlertCircle size={15} />
          )}
        </span>
        <span className="job-strip-text" aria-live="polite">{label}</span>
        {sourceName && (
          <span className="job-strip-name" title={sourceName}>
            {sourceName}
          </span>
        )}
        {queued > 0 && (
          <span className="job-strip-queued">{t('batch.queued', { count: queued })}</span>
        )}
        <span className="job-strip-grow" />
        {running && percent > 0 && !expanded && <span className="job-strip-percent">{percent}%</span>}
        <button
          className="btn btn-ghost btn-small job-strip-toggle"
          onClick={onToggle}
          aria-label={expanded ? t('batch.collapse') : t('batch.expand')}
          aria-expanded={expanded}
          title={expanded ? t('batch.collapse') : t('batch.expand')}
        >
          {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          <span className="job-strip-toggle-text">
            {expanded ? t('batch.collapseShort') : t('batch.expandShort')}
          </span>
        </button>
        {/* The expanded card carries its own cancel action. On phones the label
            collapses to an icon so the strip stays a single row. */}
        {!expanded && (
          <button
            className="btn btn-ghost btn-small job-strip-cancel"
            onClick={onCancel}
            aria-label={queued > 0 ? t('common.cancelAll') : t('common.cancel')}
            title={queued > 0 ? t('common.cancelAll') : t('common.cancel')}
          >
            <X size={16} className="job-strip-cancel-icon" aria-hidden="true" />
            <span className="job-strip-cancel-text">
              {queued > 0 ? t('common.cancelAll') : t('common.cancel')}
            </span>
          </button>
        )}
      </div>

      <div className="job-strip-track" aria-hidden="true">
        <span style={{ width: `${failed ? 100 : percent}%` }} />
      </div>

      {expanded && (
        <div className="job-strip-panel">
          <ProgressCard
            progress={progress}
            elapsed={elapsed}
            error={error}
            sourceName={sourceName}
            batchIndex={batchIndex}
            batchTotal={batchTotal}
            onCancel={onCancel}
            onMinimize={running ? onToggle : undefined}
            onRetry={onRetry}
            onDismiss={onDismiss}
          />
        </div>
      )}
    </section>
  );
};
