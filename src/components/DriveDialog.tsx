import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Cloud,
  Download,
  FolderOpen,
  Loader2,
  Lock,
  LogOut,
  RefreshCw,
  UploadCloud,
} from 'lucide-react';
import type { Session } from '../types';
import {
  connectGoogleDrive,
  disconnectGoogleDrive,
  downloadDriveAudio,
  driveConnected,
  driveFileName,
  DriveAuthError,
  googleClientConfigured,
  listDriveAudio,
  saveGoogleClientId,
  storedGoogleClientId,
  uploadSessionAudio,
  type DriveFile,
} from '../lib/drive/client';
import { useI18n, type TKey } from '../i18n';
import { formatDate } from './ui/primitives';
import { Modal } from './ui/Modal';

interface Props {
  open: boolean;
  onClose: () => void;
  session: Session | null;
  onImportFile: (file: File) => Promise<void>;
  onToast: (title: string, tone: 'success' | 'error' | 'info', detail?: string) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * The Drive client throws English technical messages. Map the known ones to
 * localized keys; anything unknown (a raw Google API message, for example)
 * passes through so the user still sees a reason.
 */
function driveErrorKey(error: unknown): TKey | null {
  if (error instanceof DriveAuthError) return 'drive.error.auth';
  if (!(error instanceof Error)) return null;
  const message = error.message;
  const table: Array<[RegExp, TKey]> = [
    [/sign-in is not configured/i, 'drive.error.notConfigured'],
    [/not available in this browser|needs a browser/i, 'drive.error.noGis'],
    [/Could not load Google sign-in/i, 'drive.error.noGis'],
    [/no access token|did not return an access token/i, 'drive.error.noToken'],
    [/cancelled/i, 'drive.error.cancelled'],
    [/did not provide an upload session/i, 'drive.error.noUploadSession'],
    [/unreadable upload response/i, 'drive.error.unreadableUpload'],
    [/upload was interrupted|upload failed/i, 'drive.error.uploadInterrupted'],
    [/download was interrupted|download failed/i, 'drive.error.downloadInterrupted'],
    [/no saved recording/i, 'drive.error.noRecording'],
    [/Failed to fetch|NetworkError|network/i, 'drive.error.network'],
  ];
  for (const [pattern, key] of table) {
    if (pattern.test(message)) return key;
  }
  return null;
}

const GoogleMark: React.FC = () => (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path
      fill="#EA4335"
      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
    />
    <path
      fill="#4285F4"
      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
    />
    <path
      fill="#FBBC05"
      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
    />
    <path
      fill="#34A853"
      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
    />
  </svg>
);

export const DriveDialog: React.FC<Props> = ({ open, onClose, session, onImportFile, onToast }) => {
  const { t } = useI18n();
  const [configured, setConfigured] = useState(false);
  const [setupId, setSetupId] = useState('');
  const [connected, setConnected] = useState(false);
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'connect' | 'list' | 'upload' | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);

  const showError = useCallback(
    (caught: unknown) => {
      const key = driveErrorKey(caught);
      setError(key ? t(key) : caught instanceof Error ? caught.message : String(caught));
    },
    [t],
  );

  const loadFiles = useCallback(async () => {
    setBusy('list');
    setError(null);
    try {
      setFiles(await listDriveAudio(true));
    } catch (caught) {
      if (caught instanceof DriveAuthError) setConnected(false);
      showError(caught);
    } finally {
      setBusy(null);
    }
  }, [showError]);

  useEffect(() => {
    if (!open) return;
    const isConnected = driveConnected();
    setConfigured(googleClientConfigured());
    setSetupId(storedGoogleClientId());
    setConnected(isConnected);
    setError(null);
    setQuery('');
    if (isConnected) void loadFiles();
    else setFiles([]);
  }, [open, loadFiles]);

  const connect = async () => {
    setBusy('connect');
    setError(null);
    try {
      await connectGoogleDrive(setupId || undefined);
      setConfigured(true);
      setConnected(true);
      onToast(t('drive.toast.signedIn'), 'success');
      await loadFiles();
    } catch (caught) {
      showError(caught);
    } finally {
      setBusy(null);
    }
  };

  const saveSetup = () => {
    const trimmed = setupId.trim();
    if (!trimmed) return;
    saveGoogleClientId(trimmed);
    setConfigured(true);
    setError(null);
  };

  const disconnect = () => {
    disconnectGoogleDrive();
    setConnected(false);
    setFiles([]);
    setError(null);
  };

  const uploadCurrent = async () => {
    if (!session?.audioBlob) return;
    setBusy('upload');
    setError(null);
    setProgress({ loaded: 0, total: session.audioBlob.size });
    try {
      const uploaded = await uploadSessionAudio(session, (loaded, total) =>
        setProgress({ loaded, total }),
      );
      onToast(t('drive.toast.uploaded'), 'success', uploaded.name);
      await loadFiles();
    } catch (caught) {
      if (caught instanceof DriveAuthError) setConnected(false);
      showError(caught);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const importFile = async (file: DriveFile) => {
    setOpeningId(file.id);
    setError(null);
    setProgress({ loaded: 0, total: Number(file.size ?? 0) });
    try {
      const downloaded = await downloadDriveAudio(file, (loaded, total) =>
        setProgress({ loaded, total }),
      );
      onToast(t('drive.toast.downloaded'), 'success', file.name);
      await onImportFile(downloaded);
      onClose();
    } catch (caught) {
      if (caught instanceof DriveAuthError) setConnected(false);
      showError(caught);
    } finally {
      setOpeningId(null);
      setProgress(null);
    }
  };

  const visible = files.filter((file) => file.name.toLowerCase().includes(query.trim().toLowerCase()));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('drive.title')}
      description={t('drive.description')}
      size="md"
      labelledBy="drive-title"
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          {t('common.done')}
        </button>
      }
    >
      {!connected ? (
        <div className="drive-connect">
          {configured ? (
            <>
              <button className="drive-google-btn" onClick={() => void connect()} disabled={busy !== null}>
                {busy === 'connect' ? <Loader2 size={18} className="spin" /> : <GoogleMark />}
                {t('drive.google.button')}
              </button>
              <p className="drive-note">
                <Lock size={13} aria-hidden="true" />
                {t('drive.google.note')}
              </p>
            </>
          ) : (
            <div className="drive-setup">
              <strong>{t('drive.setup.title')}</strong>
              <p>{t('drive.setup.body')}</p>
              <label className="field">
                <span>{t('drive.setup.clientId')}</span>
                <input
                  value={setupId}
                  onChange={(event) => setSetupId(event.target.value)}
                  placeholder="1234567890-abc.apps.googleusercontent.com"
                  spellCheck={false}
                  autoComplete="off"
                />
              </label>
              <div className="drive-connect-actions">
                <button className="btn btn-primary" onClick={saveSetup} disabled={!setupId.trim()}>
                  {t('drive.setup.save')}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => window.open('https://console.cloud.google.com/apis/credentials', '_blank')}
                >
                  {t('drive.setup.console')}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="drive-status-row">
            <span className="drive-badge connected">
              <Cloud size={14} />
              {t('drive.badge.signedIn')}
            </span>
            <button className="btn btn-ghost btn-small" onClick={disconnect} disabled={busy !== null}>
              <LogOut size={14} />
              {t('common.signOut')}
            </button>
          </div>

          <div className="drive-upload-card">
            <div className="drive-upload-copy">
              <UploadCloud size={18} aria-hidden="true" />
              <div>
                <strong>{session?.audioBlob ? driveFileName(session) : t('drive.upload.noSession')}</strong>
                <span>
                  {session?.audioBlob
                    ? t('drive.upload.ready', { size: formatBytes(session.audioBlob.size) })
                    : t('drive.upload.noSessionHint')}
                </span>
              </div>
            </div>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => void uploadCurrent()}
              disabled={!session?.audioBlob || busy !== null}
            >
              {busy === 'upload' ? <Loader2 size={14} className="spin" /> : <UploadCloud size={14} />}
              {t('common.upload')}
            </button>
          </div>

          {progress && (
            <div className="drive-progress" role="status">
              <div className="drive-progress-track">
                <span
                  style={{
                    width: `${progress.total > 0 ? Math.min(100, (progress.loaded / progress.total) * 100) : 0}%`,
                  }}
                />
              </div>
              <small>
                {progress.total > 0
                  ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
                  : t('drive.progress.working')}
              </small>
            </div>
          )}

          <div className="drive-list-head">
            <div>
              <strong>{t('drive.list.title')}</strong>
              <span>{t('count.files', { count: visible.length })}</span>
            </div>
            <button
              className="icon-btn"
              onClick={() => void loadFiles()}
              disabled={busy !== null}
              aria-label={t('drive.list.refresh.aria')}
              title={t('common.refresh')}
            >
              <RefreshCw size={15} className={busy === 'list' ? 'spin' : ''} />
            </button>
          </div>

          <input
            className="drive-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('drive.search.placeholder')}
            aria-label={t('drive.search.aria')}
          />

          {busy === 'list' && files.length === 0 ? (
            <div className="drive-empty">
              <Loader2 size={18} className="spin" />
              <span>{t('drive.list.reading')}</span>
            </div>
          ) : visible.length === 0 ? (
            <div className="drive-empty">
              <FolderOpen size={20} />
              <span>{query ? t('drive.list.emptySearch') : t('drive.list.emptyNone')}</span>
            </div>
          ) : (
            <div className="drive-list">
              {visible.map((file) => (
                <div className="drive-file" key={file.id}>
                  <span className="drive-file-icon">
                    <Cloud size={16} />
                  </span>
                  <div className="drive-file-copy">
                    <strong>{file.name}</strong>
                    <span>
                      {file.modifiedTime ? formatDate(Date.parse(file.modifiedTime)) : t('drive.file.source')}
                      {file.size ? ` · ${formatBytes(Number(file.size))}` : ''}
                    </span>
                  </div>
                  <button
                    className="btn btn-secondary btn-small"
                    onClick={() => void importFile(file)}
                    disabled={busy !== null || openingId !== null}
                  >
                    {openingId === file.id ? (
                      <Loader2 size={14} className="spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    {t('common.import')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {error && (
        <p className="drive-error" role="alert">
          <AlertTriangle size={14} />
          {error}
        </p>
      )}
    </Modal>
  );
};
