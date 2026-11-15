import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { JobStrip } from './components/JobStrip';
import { CapturePanel } from './components/CapturePanel';
import { AudioRepairDialog } from './components/AudioRepairDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DriveDialog } from './components/DriveDialog';
import { ManualDialog } from './components/ManualDialog';
import { PlayerBar } from './components/PlayerBar';
import { PreviewCard } from './components/PreviewCard';
import { QuickSettingsDialog } from './components/QuickSettingsDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { ToastStack, useToasts } from './components/Toast';
import { TopBar, type ExportFormat } from './components/TopBar';
import { TranscriptView } from './components/TranscriptView';
import { usePlayer } from './hooks/usePlayer';
import { useRecorder } from './hooks/useRecorder';
import { useSessions } from './hooks/useSessions';
import { useSettings } from './hooks/useSettings';
import { useTranscription, type TranscribeSource } from './hooks/useTranscription';
import { useI18n } from './i18n';
import { localizeError } from './i18n/progress';
import { computePeaks, decodeToMono16k } from './lib/audio/decode';
import { modelCopy, modelInfo } from './lib/models';
import { estimateStorage, clearJobs, clearSessions, deleteJob, getJob, listJobs } from './lib/db';
import {
  audioExtension,
  docxBlob,
  exportFilename,
  jsonTranscript,
  markdown,
  pdfBlob,
  plainText,
  srt,
  vtt,
} from './lib/export/formats';
import { saveBlob } from './lib/export/save';
import { applyReprocess } from './lib/session';
import { JobQueue, type QueueSummary } from './lib/jobQueue';
import { notifyTranscriptionReady, prepareNotifications } from './lib/notify';
import { describeQueueCompletion } from './lib/queueNotice';
import { repairAudio, type RepairPresetId } from './lib/audio/enhance';
import type { JobState, SessionMeta, TranscriptSegment } from './types';

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * One unit of background work: a file to transcribe, plus the options that turn
 * it into a new transcript, a resume from a checkpoint or a re-run that replaces
 * an existing session.
 */
interface QueueItem {
  source: TranscribeSource;
  /** Continue an interrupted run from its checkpoint. */
  resume?: JobState | null;
  /** Replace this session instead of creating a new transcript. */
  replaceSessionId?: string;
}

function countWords(segments: TranscriptSegment[]): number {
  return segments.reduce((total, segment) => total + segment.text.split(/\s+/).filter(Boolean).length, 0);
}

const App: React.FC = () => {
  const { settings, setSettings, resetSettings } = useSettings();
  const store = useSessions();
  const recorder = useRecorder();
  const transcription = useTranscription();
  const player = usePlayer(store.current);
  const { toasts, push, dismiss } = useToasts();
  const { lang, t } = useI18n();

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [driveOpen, setDriveOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<SessionMeta | null>(null);
  const [pendingSource, setPendingSource] = useState<TranscribeSource | null>(null);
  const [pendingReplaceId, setPendingReplaceId] = useState<string | null>(null);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickMode, setQuickMode] = useState<'preview' | 'reprocess'>('preview');
  const [quickRepair, setQuickRepair] = useState<RepairPresetId>('off');
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairBusy, setRepairBusy] = useState(false);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [lastSource, setLastSource] = useState<TranscribeSource | null>(null);
  const [starting, setStarting] = useState(false);
  const [resumable, setResumable] = useState<JobState | null>(null);
  /** Extra recordings imported together, waiting behind the previewed one. */
  const [previewQueue, setPreviewQueue] = useState<TranscribeSource[]>([]);
  /** Recordings waiting for their turn in the running queue. */
  const [queue, setQueue] = useState<QueueItem[]>([]);
  /** 1-based position in the current run, used by the progress and background UI. */
  const [batch, setBatch] = useState<{ index: number; total: number } | null>(null);
  /** True when the status strip shows the step-by-step details panel. */
  const [jobExpanded, setJobExpanded] = useState(false);
  const transcribingRef = useRef(false);
  const queueRef = useRef(new JobQueue<QueueItem>());
  /** True once the user records or opens something while a run continues. */
  const movedOnRef = useRef(false);
  /** Title of the last transcript saved by the queue, for the completion notice. */
  const lastSavedRef = useRef<{ title: string; words: number; speakers: number } | null>(null);

  const refreshJob = useCallback(async () => {
    try {
      const jobs = await listJobs();
      setResumable(jobs[0] ?? null);
    } catch {
      /* a checkpoint is optional */
    }
  }, []);

  useEffect(() => {
    void refreshJob();
  }, [refreshJob]);

  const refreshStorage = useCallback(async () => {
    setStorage(await estimateStorage());
  }, []);

  useEffect(() => {
    void refreshStorage();
  }, [refreshStorage, store.sessions.length, store.current?.id]);

  useEffect(() => {
    if (!store.error) return;
    push(t('toast.storageIssue.title'), 'error', store.error);
    store.clearError();
  }, [store.error, store.clearError, push, t]);

  useEffect(() => {
    const hide = () => {
      if (document.visibilityState === 'hidden') void store.flush();
    };
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('pagehide', hide);
    return () => {
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('pagehide', hide);
    };
  }, [store.flush]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ',') {
        event.preventDefault();
        setSettingsOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSidebarOpen(true);
        window.setTimeout(() => {
          const input = document.querySelector<HTMLInputElement>('.sidebar-search input');
          input?.focus();
          input?.select();
        }, 60);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Older sessions predate stored waveform peaks; derive them from the audio once.
  const legacyId = store.current?.id;
  const legacyBlob = store.current?.audioBlob;
  const hasPeaks = Boolean(store.current?.peaks?.length);
  useEffect(() => {
    if (!legacyId || !legacyBlob || hasPeaks) return;
    let cancelled = false;
    decodeToMono16k(legacyBlob)
      .then(({ samples }) => {
        if (cancelled) return;
        const peaks = computePeaks(samples, 180);
        store.update((session) => ({ ...session, peaks }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [legacyId, legacyBlob, hasPeaks, store.update]);

  /**
   * Run one recording to completion. Returns what happened so a batch can
   * decide whether to keep going. Callers own the `transcribingRef` guard.
   */
  const runSource = useCallback(
    async (
      source: TranscribeSource,
      resume: JobState | null = null,
      options?: { replaceSessionId?: string; activate?: boolean; notify?: boolean },
    ): Promise<'done' | 'failed' | 'cancelled'> => {
      setLastSource(source);
      setPendingReplaceId(options?.replaceSessionId ?? null);
      setResumable(null);
      try {
        await store.flush();
        const created = await transcription.run(source, settings, resume);
        if (options?.replaceSessionId) {
          // Re-run on an existing session: keep its identity and audio,
          // replace only what the new run produced.
          store.update((existing) =>
            existing.id === options.replaceSessionId ? applyReprocess(existing, created) : existing,
          );
        } else {
          await store.add(created, { activate: options?.activate ?? true });
        }
        await refreshStorage();
        lastSavedRef.current = {
          title: created.title,
          words: created.wordCount,
          speakers: created.speakerCount,
        };
        if (options?.notify !== false) {
          push(
            t('toast.transcriptReady.title'),
            'success',
            t('toast.transcriptReady.desc', {
              words: t('count.words', { count: created.wordCount }),
              speakers: t('count.speakers', { count: created.speakerCount }),
            }),
          );
        }
        setSidebarOpen(false);
        return 'done';
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          push(t('toast.paused.title'), 'info', t('toast.paused.desc'));
          return 'cancelled';
        }
        push(
          t('toast.failed.title'),
          'error',
          caught instanceof Error ? localizeError(caught.message, lang) : t('toast.failed.desc'),
        );
        return 'failed';
      } finally {
        await refreshJob();
      }
    },
    [lang, push, refreshJob, refreshStorage, settings, store.add, store.update, store.flush, transcription.run, t],
  );

  /**
   * Start or extend the background queue.
   *
   * If a run is already in flight the work is appended instead of being
   * refused, so the user can record the next lecture - or re-run a transcript
   * with other settings - right away. Otherwise the queue drains one item at a
   * time: Whisper shares a single model and WASM/WebGPU context, so parallel
   * items would double memory without finishing sooner.
   */
  const startJobs = useCallback(
    (items: QueueItem[]) => {
      if (items.length === 0) return;
      // The browser only honours this inside the button press that started the run.
      void prepareNotifications();

      if (transcribingRef.current) {
        queueRef.current.enqueue(items);
        setQueue([...queueRef.current.pending]);
        push(t('toast.queued.title'), 'info', t('toast.queued.desc', { count: items.length }));
        return;
      }

      transcribingRef.current = true;
      movedOnRef.current = false;
      lastSavedRef.current = null;
      setJobExpanded(false);
      queueRef.current.reset();
      queueRef.current.enqueue(items);
      setQueue([...queueRef.current.pending]);

      void (async () => {
        let summary: QueueSummary | null = null;
        try {
          summary = await queueRef.current.drain(
            async (item, position) => {
              setQueue([...queueRef.current.pending]);
              const outcome = await runSource(item.source, item.resume ?? null, {
                replaceSessionId: item.replaceSessionId,
                // Opening the finished transcript is only helpful when the user
                // is still on the start screen and nothing else is queued.
                activate: position.total === 1 && !movedOnRef.current,
                // One notice per run: the solo toast or the queue summary is
                // pushed below, once the real total (including work appended
                // mid-run) is known.
                notify: false,
              });
              // A failure with nothing left to start is exactly what the
              // details panel is for: retry, resume, or dismiss.
              if (outcome === 'failed' && position.total === 1 && queueRef.current.pending.length === 0) {
                setJobExpanded(true);
              }
              return outcome;
            },
            {
              onStart: (_item, position) =>
                setBatch({ index: position.index, total: position.total }),
            },
          );
        } finally {
          transcribingRef.current = false;
          setBatch(null);
          setQueue([]);
        }

        const saved = lastSavedRef.current;
        const notice = describeQueueCompletion(summary, saved);
        if (notice.kind === 'none') return;

        await notifyTranscriptionReady({
          title: t('notify.title'),
          body:
            notice.kind === 'batch'
              ? t('notify.batch', { done: notice.done, total: notice.total })
              : t('notify.single', { title: saved?.title ?? t('app.newTranscript') }),
          tag: 'coso-transcript',
        });

        if (notice.kind === 'single') {
          push(
            t('toast.transcriptReady.title'),
            'success',
            t('toast.transcriptReady.desc', {
              words: t('count.words', { count: notice.words }),
              speakers: t('count.speakers', { count: notice.speakers }),
            }),
          );
          return;
        }
        push(
          t(notice.failed ? 'toast.batchDone.titleSome' : 'toast.batchDone.title'),
          notice.failed ? 'error' : 'success',
          t(notice.failed ? 'toast.batchDone.descSome' : 'toast.batchDone.desc', {
            done: notice.done,
            total: notice.total,
          }),
        );
      })();
    },
    [push, runSource, t],
  );

  const startQueue = useCallback(
    (sources: TranscribeSource[]) => startJobs(sources.map((source) => ({ source }))),
    [startJobs],
  );

  const beginTranscription = useCallback(
    async (
      source: TranscribeSource,
      resume: JobState | null = null,
      options?: { replaceSessionId?: string },
    ) => {
      // A re-run or resume must not refuse to start while another transcript is
      // being processed; it simply waits its turn.
      if (transcribingRef.current) {
        startJobs([{ source, resume, replaceSessionId: options?.replaceSessionId }]);
        return;
      }
      void prepareNotifications();
      transcribingRef.current = true;
      // An explicit re-run or resume has nothing new to read afterwards, so the
      // step-by-step panel is the useful view.
      setJobExpanded(true);
      setPendingSource(null);
      try {
        await runSource(source, resume, options);
      } finally {
        transcribingRef.current = false;
      }
    },
    [runSource, startJobs],
  );

  const cancelQueue = useCallback(() => {
    queueRef.current.cancel();
    setQueue([]);
    transcription.cancel();
  }, [transcription.cancel]);

  const handleResumeJob = useCallback(
    async (job: JobState) => {
      if (transcribingRef.current) return;
      const record = await getJob(job.id).catch(() => null);
      if (!record?.audioBlob) {
        await deleteJob(job.id).catch(() => undefined);
        setResumable(null);
        push(t('toast.checkpointUnavailable.title'), 'error', t('toast.checkpointUnavailable.desc'));
        return;
      }
      const source: TranscribeSource = { blob: record.audioBlob, name: record.sourceName };
      await beginTranscription(source, record);
    },
    [beginTranscription, push, t],
  );

  const handleDiscardJob = useCallback(
    async (job: JobState) => {
      await deleteJob(job.id).catch(() => undefined);
      setResumable(null);
      push(t('toast.checkpointDiscarded.title'), 'info', job.title);
    },
    [push, t],
  );

  const handleStart = async () => {
    // Recording is allowed while the queue runs; mark that the user is busy so
    // a finished transcript does not replace the recording screen.
    if (transcribingRef.current) movedOnRef.current = true;
    setStarting(true);
    const ok = await recorder.start();
    setStarting(false);
    if (!ok && recorder.error) push(t('toast.micUnavailable.title'), 'error', recorder.error);
  };

  const handleStop = async () => {
    const result = await recorder.stop();
    if (!result) {
      push(t('toast.nothingCaptured.title'), 'error', t('toast.nothingCaptured.desc'));
      return;
    }
    if (result.duration < 0.4) {
      push(t('toast.tooShort.title'), 'info', t('toast.tooShort.desc'));
      return;
    }
    setPendingSource({ blob: result.blob, name: null });
  };

  const handleFiles = (files: File[]) => {
    const valid: File[] = [];
    for (const file of files) {
      const supportedExtension = /\.(wav|mp3|m4a|aac|ogg|oga|flac|webm|mp4|mov)$/i.test(file.name);
      if (!file.type.startsWith('audio/') && !supportedExtension) {
        push(t('toast.unsupportedFile.title'), 'error', file.name);
        continue;
      }
      if (file.size === 0) {
        push(t('toast.emptyFile.title'), 'error', file.name);
        continue;
      }
      if (file.size > MAX_FILE_BYTES) {
        push(t('toast.fileTooLarge.title'), 'error', file.name);
        continue;
      }
      valid.push(file);
    }

    if (valid.length === 0) return;
    if (transcribingRef.current) movedOnRef.current = true;
    setPendingSource({ blob: valid[0], name: valid[0].name });
    // Everything after the first file waits for "Transcribe all".
    setPreviewQueue(valid.slice(1).map((file) => ({ blob: file, name: file.name })));
  };

  const handleFile = async (file: File) => {
    handleFiles([file]);
  };

  const handleSelect = async (id: string) => {
    if (recorder.status === 'recording' || recorder.status === 'paused') recorder.cancel();
    await store.flush();
    if (transcribingRef.current) {
      // Keep the run alive: browsing must not cancel it, and the finished
      // transcript should not replace the one the user just opened.
      movedOnRef.current = true;
    } else {
      transcription.clear();
      setLastSource(null);
      setPendingSource(null);
      setPreviewQueue([]);
    }
    await store.open(id);
    setSidebarOpen(false);
  };

  const handleNew = async () => {
    if (recorder.status === 'recording' || recorder.status === 'paused') recorder.cancel();
    await store.flush();
    if (transcribingRef.current) {
      movedOnRef.current = true;
    } else {
      transcription.clear();
      setLastSource(null);
      setPendingSource(null);
      setPreviewQueue([]);
    }
    store.clearCurrent();
    setSidebarOpen(false);
  };

  const handleDelete = async () => {
    if (!pendingDelete) return;
    const wasCurrent = store.current?.id === pendingDelete.id;
    const title = pendingDelete.title;
    setPendingDelete(null);
    await store.remove(pendingDelete.id);
    if (wasCurrent) {
      transcription.clear();
      setLastSource(null);
    setPendingSource(null);
    }
    await refreshStorage();
    push(t('toast.sessionDeleted.title'), 'success', title);
  };

  const handleRename = (title: string) => {
    store.update((session) => ({ ...session, title }));
  };

  const handleEditSegment = (id: string, text: string) => {
    store.update((session) => {
      const segments = session.segments.map((segment) => (segment.id === id ? { ...segment, text } : segment));
      return { ...session, segments, wordCount: countWords(segments) };
    });
  };

  const handleEditSegmentStart = (id: string, start: number) => {
    store.update((session) => {
      const segments = session.segments.map((segment) =>
        segment.id === id ? { ...segment, start: Math.min(Math.max(0, start), segment.end) } : segment,
      );
      return { ...session, segments };
    });
  };

  const handleRenameSpeaker = (speaker: number, name: string) => {
    store.update((session) => {
      const names = { ...(session.speakerNames ?? {}) };
      const clean = name.replace(/\s+/g, ' ').trim();
      if (clean) names[String(speaker)] = clean;
      else delete names[String(speaker)];
      return { ...session, speakerNames: names };
    });
  };

  const handleExport = async (format: ExportFormat) => {
    const session = store.current;
    if (!session) return;

    let blob: Blob;
    let extension: string = format;
    switch (format) {
      case 'txt':
        blob = new Blob([plainText(session, lang)], { type: 'text/plain;charset=utf-8' });
        break;
      case 'md':
        blob = new Blob([markdown(session, lang)], { type: 'text/markdown;charset=utf-8' });
        break;
      case 'srt':
        blob = new Blob([srt(session, lang)], { type: 'application/x-subrip;charset=utf-8' });
        break;
      case 'vtt':
        blob = new Blob([vtt(session, lang)], { type: 'text/vtt;charset=utf-8' });
        break;
      case 'json':
        blob = new Blob([jsonTranscript(session)], { type: 'application/json;charset=utf-8' });
        break;
      case 'audio':
        if (!session.audioBlob) {
          push(t('toast.noAudio.title'), 'error', t('toast.noAudio.desc'));
          return;
        }
        blob = session.audioBlob;
        extension = audioExtension(session);
        break;
      case 'docx':
        blob = await docxBlob(session, lang);
        extension = 'docx';
        break;
      case 'pdf':
        blob = pdfBlob(session, lang);
        extension = 'pdf';
        break;
    }

    const filename = exportFilename(session, extension);
    const result = await saveBlob(blob, filename);
    if (result !== 'cancelled') {
      push(t('toast.exportReady.title'), 'success', result === 'saved' ? filename : `${filename} · ${t('common.downloads')}`);
    }
  };

  const retryLast = useCallback(async () => {
    transcription.clear();
    if (!lastSource) return;
    const job = resumable && resumable.processed < resumable.duration - 1 ? resumable : null;
    await beginTranscription(
      lastSource,
      job,
      pendingReplaceId ? { replaceSessionId: pendingReplaceId } : undefined,
    );
  }, [beginTranscription, lastSource, pendingReplaceId, resumable, transcription]);

  const handlePreviewStart = () => {
    if (!pendingSource) return;
    const sources = [pendingSource, ...previewQueue];
    setPendingSource(null);
    setPreviewQueue([]);
    startQueue(sources);
  };

  const handlePreviewSettings = () => {
    setQuickMode('preview');
    setQuickOpen(true);
  };

  const handleReprocess = useCallback(() => {
    if (!store.current?.audioBlob) return;
    setQuickMode('reprocess');
    setQuickOpen(true);
  }, [store.current]);

  const handleQuickStart = () => {
    if (quickMode === 'preview') {
      setQuickOpen(false);
      handlePreviewStart();
      return;
    }
    const session = store.current;
    if (!session?.audioBlob || repairBusy) return;
    const original = session.audioBlob;
    if (quickRepair === 'off') {
      setQuickOpen(false);
      void beginTranscription(
        { blob: original, name: session.sourceName },
        null,
        { replaceSessionId: session.id },
      );
      return;
    }
    // Repair first, then replace the transcript; the original audio is kept.
    // The dialog stays open (with a spinner) so a long DSP pass does not look
    // like a frozen app, and it closes as soon as the repair is handed over.
    setRepairBusy(true);
    void repairAudio(original, quickRepair)
      .then(({ blob }) => {
        setRepairBusy(false);
        setQuickOpen(false);
        return beginTranscription(
          {
            blob,
            name: session.sourceName,
            storeBlob: original,
            storeMime: session.audioMime ?? undefined,
          },
          null,
          { replaceSessionId: session.id },
        );
      })
      .catch((caught) => {
        setRepairBusy(false);
        push(
          t('toast.failed.title'),
          'error',
          caught instanceof Error ? caught.message : t('toast.failed.desc'),
        );
      });
  };

  const handleRepairApply = (blob: Blob, preset: RepairPresetId) => {
    setPendingSource((current) =>
      current
        ? {
            ...current,
            // Keep the untouched recording for the saved session.
            storeBlob: current.storeBlob ?? current.blob,
            storeMime: current.storeMime ?? current.blob.type,
            blob,
          }
        : current,
    );
    setRepairOpen(false);
    setQuickRepair(preset);
    push(t('toast.repaired.title'), 'success', t('toast.repaired.desc'));
  };

  const handleClearAll = async () => {
    await clearSessions();
    await clearJobs();
    setResumable(null);
    store.clearCurrent();
    await store.refresh();
    transcription.clear();
    setLastSource(null);
    setPendingSource(null);
    await refreshStorage();
    push(t('toast.clearedAll.title'), 'success', t('toast.clearedAll.desc'));
  };

  const toggleTheme = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    setSettings({ theme: dark ? 'light' : 'dark' });
  };

  const recording = recorder.status === 'recording' || recorder.status === 'paused' || recorder.status === 'requesting';
  const showProgress = transcription.running || transcription.progress.stage === 'error';
  const current = store.current;
  const model = modelInfo(settings.model);
  const startWarning =
    [
      model.warning
        ? `${model.label}: ${modelCopy(model, lang).warning}`
        : null,
      settings.diarize && settings.diarizeQuality === 'thorough' ? t('warning.thorough') : null,
      settings.diarize && settings.diarizeEngine === 'pyannote' ? t('warning.pyannote') : null,
      settings.denoise && settings.denoiseQuality === 'maximum' ? t('warning.maximum') : null,
    ]
      .filter(Boolean)
      .join(' ') || null;

  const capturePanelProps = {
    recorder,
    sessions: store.sessions,
    onStart: () => void handleStart(),
    onPause: recorder.pause,
    onResume: recorder.resume,
    onStop: () => void handleStop(),
    onCancel: recorder.cancel,
    onFiles: (files: File[]) => void handleFiles(files),
    onOpen: (id: string) => void handleSelect(id),
    job: resumable,
    onResumeJob: (job: JobState) => void handleResumeJob(job),
    onDiscardJob: (job: JobState) => void handleDiscardJob(job),
    warning: startWarning,
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#workspace">
        {t('app.skipToContent')}
      </a>

      <Sidebar
        sessions={store.sessions}
        currentId={current?.id ?? null}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelect={(id) => void handleSelect(id)}
        onNew={() => void handleNew()}
        onDelete={setPendingDelete}
        onSettings={() => {
          setSidebarOpen(false);
          setSettingsOpen(true);
        }}
        onManual={() => {
          setSidebarOpen(false);
          setManualOpen(true);
        }}
        storage={storage}
      />

      <div className="main-shell">
        {showProgress && (
          <JobStrip
            progress={transcription.progress}
            elapsed={transcription.elapsed}
            error={transcription.error}
            sourceName={lastSource?.name ?? (lastSource ? t('app.micSource') : null)}
            batchIndex={batch?.index}
            batchTotal={batch?.total}
            queued={queue.length}
            expanded={jobExpanded}
            onToggle={() => setJobExpanded((open) => !open)}
            onCancel={cancelQueue}
            onRetry={() => void retryLast()}
            onDismiss={() => {
              transcription.clear();
              setJobExpanded(false);
              setLastSource(null);
              setPendingSource(null);
              setPreviewQueue([]);
            }}
          />
        )}

        <TopBar
          session={current}
          settings={settings}
          menuOpen={sidebarOpen}
          onMenu={() => setSidebarOpen(true)}
          onSettings={() => setSettingsOpen(true)}
          onDrive={() => setDriveOpen(true)}
          onManual={() => setManualOpen(true)}
          onExport={handleExport}
          onRename={handleRename}
          onToggleTheme={toggleTheme}
        />

        <main id="workspace" className="main-scroll">
          <div className={`content ${current ? 'content-session' : 'content-capture'}`}>
            {pendingSource ? (
              <PreviewCard
                source={pendingSource}
                busy={repairBusy}
                queueing={transcription.running}
                enhanced={Boolean(pendingSource.storeBlob)}
                queued={previewQueue.length}
                onStart={handlePreviewStart}
                onOpenSettings={handlePreviewSettings}
                onRepair={() => setRepairOpen(true)}
                onCancel={() => {
                  setPendingSource(null);
                  setPreviewQueue([]);
                }}
              />
            ) : recording ? (
              <CapturePanel {...capturePanelProps} />
            ) : current ? (
              <TranscriptView
                session={current}
                player={player}
                onEditSegment={handleEditSegment}
                onEditSegmentStart={handleEditSegmentStart}
                onRenameSpeaker={handleRenameSpeaker}
                onReprocess={handleReprocess}
                onToast={push}
              />
            ) : (
              <CapturePanel {...capturePanelProps} />
            )}
          </div>
        </main>

        {current?.audioBlob && !recording && (
          <PlayerBar
            session={current}
            player={player}
            onDownload={() => void handleExport('audio')}
          />
        )}
      </div>

      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={settings}
        onChange={setSettings}
        onReset={resetSettings}
        storage={storage}
        sessionCount={store.sessions.length}
        onClearAll={handleClearAll}
        busy={transcription.running || starting}
      />

      <DriveDialog
        open={driveOpen}
        onClose={() => setDriveOpen(false)}
        session={current}
        onImportFile={handleFile}
        onToast={push}
      />

      <ManualDialog open={manualOpen} onClose={() => setManualOpen(false)} />

      <QuickSettingsDialog
        open={quickOpen}
        mode={quickMode}
        settings={settings}
        repair={quickRepair}
        busy={transcription.running || repairBusy}
        onChange={setSettings}
        onRepairChange={setQuickRepair}
        onStart={handleQuickStart}
        onClose={() => setQuickOpen(false)}
      />

      <AudioRepairDialog
        open={repairOpen}
        source={pendingSource ? pendingSource.storeBlob ?? pendingSource.blob : null}
        sourceName={pendingSource?.name ?? null}
        onApply={handleRepairApply}
        onClose={() => setRepairOpen(false)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('confirm.delete.title')}
        message={pendingDelete ? t('confirm.delete.message', { title: pendingDelete.title }) : ''}
        confirmLabel={t('confirm.delete.confirm')}
        cancelLabel={t('common.cancel')}
        destructive
        onConfirm={() => void handleDelete()}
        onClose={() => setPendingDelete(null)}
      />

      <ToastStack toasts={toasts} onDismiss={dismiss} />

      {store.loading && !current && (
        <div className="boot-note" role="status">
          {t('app.openingLibrary')}
        </div>
      )}

      {!navigator.onLine && (
        <div className="offline-note" role="status">
          <AlertTriangle size={14} />
          {t('app.offlineNote')}
        </div>
      )}
    </div>
  );
};

export default App;
