import React from 'react';
import { ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import type { ProgressUpdate } from '../types';
import { useI18n } from '../i18n';
import { localizeProgress } from '../i18n/progress';

interface Props {
  progress: ProgressUpdate;
  sourceName: string | null;
  /** 1-based position in a multi-file run, when there is one. */
  batchIndex?: number;
  batchTotal?: number;
  /** Recordings appended while this one runs. */
  queued: number;
  expanded: boolean;
  onToggle: () => void;
  onCancel: () => void;
}

/**
 * Compact, non-blocking status for a run that continues while the user records,
 * imports or reads another transcript. The workspace below stays fully usable;
 * "details" swaps in the full progress card when the pipeline steps matter.
 */
export const BackgroundJobBar: React.FC<Props> = ({
  progress,
  sourceName,
  batchIndex,
  batchTotal,
  queued,
  expanded,
  onToggle,
  onCancel,
}) => {
  const { lang, t } = useI18n();
  const running = progress.stage !== 'error' && progress.stage !== 'idle';
  const percent = Math.round(Math.max(0, Math.min(1, progress.progress)) * 100);
  const label =
    batchTotal && batchTotal > 1 && batchIndex
      ? t('progress.batch', { index: batchIndex, total: batchTotal })
      : localizeProgress(progress.message, lang) || t('progress.gettingStarted');

  return (
    <div className="background-job" role="status">
      {running ? (
        <Loader2 size={15} className="spin" aria-hidden="true" />
      ) : (
        <X size={15} aria-hidden="true" />
      )}
      <span className="background-job-text">{label}</span>
      {sourceName && (
        <span className="background-job-name" title={sourceName}>
          {sourceName}
        </span>
      )}
      {queued > 0 && (
        <span className="background-job-queue">{t('batch.queued', { count: queued })}</span>
      )}
      {running && progress.progress > 0 && (
        <span className="background-job-percent">{percent}%</span>
      )}
      <button
        className="btn btn-ghost btn-small background-job-toggle"
        onClick={onToggle}
        aria-label={expanded ? t('batch.collapse') : t('batch.expand')}
        title={expanded ? t('batch.collapse') : t('batch.expand')}
      >
        {expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
        <span className="background-job-toggle-text">
          {expanded ? t('batch.collapseShort') : t('batch.expandShort')}
        </span>
      </button>
      <button className="btn btn-ghost btn-small" onClick={onCancel}>
        {t('common.cancel')}
      </button>
    </div>
  );
};
