import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { CapturePanel } from './components/CapturePanel';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DriveDialog } from './components/DriveDialog';
import { ManualDialog } from './components/ManualDialog';
import { PlayerBar } from './components/PlayerBar';
import { ProgressCard } from './components/ProgressCard';
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
import type { JobState, SessionMeta, TranscriptSegment } from './types';

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

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
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [lastSource, setLastSource] = useState<TranscribeSource | null>(null);
  const [starting, setStarting] = useState(false);
  const [resumable, setResumable] = useState<JobState | null>(null);
  const transcribingRef = useRef(false);

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

  const beginTranscription = useCallback(
    async (source: TranscribeSource, resume: JobState | null = null) => {
      if (transcribingRef.current) return;
      transcribingRef.current = true;
      setLastSource(source);
      setResumable(null);
      try {
        await store.flush();
        const created = await transcription.run(source, settings, resume);
        await store.add(created);
        await refreshStorage();
        push(
          t('toast.transcriptReady.title'),
          'success',
          t('toast.transcriptReady.desc', {
            words: t('count.words', { count: created.wordCount }),
            speakers: t('count.speakers', { count: created.speakerCount }),
          }),
        );
        setSidebarOpen(false);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          push(t('toast.paused.title'), 'info', t('toast.paused.desc'));
        } else {
          push(
            t('toast.failed.title'),
            'error',
            caught instanceof Error ? localizeError(caught.message, lang) : t('toast.failed.desc'),
          );
        }
      } finally {
        transcribingRef.current = false;
        await refreshJob();
      }
    },
    [push, refreshJob, refreshStorage, settings, store.add, store.flush, transcription.run, t],
  );

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
    await beginTranscription({ blob: result.blob, name: null });
  };

  const handleFile = async (file: File) => {
    const supportedExtension = /\.(wav|mp3|m4a|aac|ogg|oga|flac|webm|mp4|mov)$/i.test(file.name);
    if (!file.type.startsWith('audio/') && !supportedExtension) {
      push(t('toast.unsupportedFile.title'), 'error', t('toast.unsupportedFile.desc'));
      return;
    }
    if (file.size === 0) {
      push(t('toast.emptyFile.title'), 'error', t('toast.emptyFile.desc'));
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      push(t('toast.fileTooLarge.title'), 'error', t('toast.fileTooLarge.desc'));
      return;
    }
    await beginTranscription({ blob: file, name: file.name });
  };

  const handleSelect = async (id: string) => {
    if (transcribingRef.current) transcription.cancel();
    if (recorder.status === 'recording' || recorder.status === 'paused') recorder.cancel();
    await store.flush();
    await store.open(id);
    transcription.clear();
    setLastSource(null);
    setSidebarOpen(false);
  };

  const handleNew = async () => {
    if (transcribingRef.current) transcription.cancel();
    if (recorder.status === 'recording' || recorder.status === 'paused') recorder.cancel();
    await store.flush();
    store.clearCurrent();
    transcription.clear();
    setLastSource(null);
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
    await beginTranscription(lastSource, job);
  }, [beginTranscription, lastSource, resumable, transcription]);

  const handleClearAll = async () => {
    await clearSessions();
    await clearJobs();
    setResumable(null);
    store.clearCurrent();
    await store.refresh();
    transcription.clear();
    setLastSource(null);
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
    onFile: (file: File) => void handleFile(file),
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
            {showProgress ? (
              <ProgressCard
                progress={transcription.progress}
                elapsed={transcription.elapsed}
                error={transcription.error}
                sourceName={lastSource?.name ?? (lastSource ? t('app.micSource') : null)}
                onCancel={() => transcription.cancel()}
                onRetry={() => void retryLast()}
                onDismiss={() => {
                  transcription.clear();
                  setLastSource(null);
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
                onToast={push}
              />
            ) : (
              <CapturePanel {...capturePanelProps} />
            )}
          </div>
        </main>

        {current?.audioBlob && !showProgress && !recording && (
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
