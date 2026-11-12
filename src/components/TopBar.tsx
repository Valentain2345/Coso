import React, { useEffect, useRef, useState } from 'react';
import {
  AudioLines,
  ChevronDown,
  CircleHelp,
  Cloud,
  Download,
  FileJson,
  FileText,
  FileType2,
  Menu,
  Moon,
  Settings,
  Subtitles,
  Sun,
  Type,
  Loader2,
} from 'lucide-react';
import type { Session, Settings as AppSettings } from '../types';
import { useI18n } from '../i18n';
import { formatDate, formatDurationLong, languageLabel } from './ui/primitives';
import { audioExtension } from '../lib/export/formats';

export type ExportFormat = 'txt' | 'md' | 'srt' | 'vtt' | 'json' | 'docx' | 'pdf' | 'audio';

interface Props {
  session: Session | null;
  settings: AppSettings;
  menuOpen: boolean;
  onMenu: () => void;
  onSettings: () => void;
  onDrive: () => void;
  onManual: () => void;
  onExport: (format: ExportFormat) => Promise<void>;
  onRename: (title: string) => void;
  onToggleTheme: () => void;
}

interface FormatOption {
  id: ExportFormat;
  label: string;
  note: string;
  icon: React.ReactNode;
}

function TitleInput({ value, onCommit, ariaLabel }: { value: string; onCommit: (next: string) => void; ariaLabel: string }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (next && next !== value) onCommit(next);
    else setDraft(value);
  };

  return (
    <input
      className="title-input"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        }
        if (event.key === 'Escape') {
          setDraft(value);
          event.currentTarget.blur();
        }
      }}
      aria-label={ariaLabel}
      spellCheck={false}
      maxLength={120}
    />
  );
}

export const TopBar: React.FC<Props> = ({
  session,
  settings,
  menuOpen,
  onMenu,
  onSettings,
  onDrive,
  onManual,
  onExport,
  onRename,
  onToggleTheme,
}) => {
  const { lang, t } = useI18n();
  const [exportOpen, setExportOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const formats: FormatOption[] = [
    { id: 'audio', label: t('topbar.export.audio'), note: '', icon: <AudioLines size={16} /> },
    { id: 'docx', label: t('topbar.export.docx'), note: t('topbar.export.docxNote'), icon: <FileText size={16} /> },
    { id: 'pdf', label: t('topbar.export.pdf'), note: t('topbar.export.pdfNote'), icon: <FileType2 size={16} /> },
    { id: 'txt', label: t('topbar.export.txt'), note: t('topbar.export.txtNote'), icon: <Type size={16} /> },
    { id: 'md', label: t('topbar.export.md'), note: t('topbar.export.mdNote'), icon: <FileText size={16} /> },
    { id: 'srt', label: t('topbar.export.srt'), note: t('topbar.export.srtNote'), icon: <Subtitles size={16} /> },
    { id: 'vtt', label: t('topbar.export.vtt'), note: t('topbar.export.vttNote'), icon: <Subtitles size={16} /> },
    { id: 'json', label: t('topbar.export.json'), note: t('topbar.export.jsonNote'), icon: <FileJson size={16} /> },
  ];

  useEffect(() => {
    if (!exportOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setExportOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExportOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', escape);
    };
  }, [exportOpen]);

  const runExport = async (format: ExportFormat) => {
    setBusy(format);
    try {
      await onExport(format);
      setExportOpen(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <header className="topbar">
      <button
        className="icon-btn topbar-menu"
        onClick={onMenu}
        aria-label={t('topbar.aria.openLibrary')}
        aria-controls="session-library"
        aria-expanded={menuOpen}
      >
        <Menu size={19} />
      </button>

      <div className="topbar-title">
        {session ? (
          <>
            <TitleInput value={session.title} onCommit={onRename} ariaLabel={t('topbar.aria.sessionTitle')} />
            <div className="topbar-meta">
              <span>{formatDate(session.createdAt, lang)}</span>
              <span className="dot-sep" aria-hidden="true" />
              <span>{formatDurationLong(session.duration, lang)}</span>
              <span className="dot-sep" aria-hidden="true" />
              <span>{languageLabel(session.language)}</span>
              {session.speakerCount > 1 && (
                <>
                  <span className="dot-sep" aria-hidden="true" />
                  <span>{t('count.speakers', { count: session.speakerCount })}</span>
                </>
              )}
              <span className="dot-sep" aria-hidden="true" />
              <span>{t('count.words', { count: session.wordCount })}</span>
            </div>
          </>
        ) : (
          <>
            <span className="topbar-kicker">{t('app.kicker')}</span>
            <h1 className="topbar-heading">{t('app.newTranscript')}</h1>
          </>
        )}
      </div>

      <div className="topbar-actions">
        <button
          className="icon-btn"
          onClick={onToggleTheme}
          aria-label={t('topbar.theme.aria', { mode: settings.theme === 'dark' ? t('common.theme.light') : t('common.theme.dark') })}
          title={t('topbar.theme.title')}
        >
          {settings.theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        {session && (
          <div className="export-wrap" ref={menuRef}>
            <button
              className="btn btn-secondary export-trigger"
              onClick={() => setExportOpen((value) => !value)}
              aria-expanded={exportOpen}
              aria-haspopup="menu"
            >
              <Download size={16} />
              <span>{t('topbar.export')}</span>
              <ChevronDown size={14} className={exportOpen ? 'rotated' : ''} />
            </button>
            {exportOpen && (
              <div className="export-menu" role="menu">
                {formats.map((format) => (
                  <button
                    key={format.id}
                    className={`export-item ${format.id === 'audio' ? 'export-audio' : ''}`}
                    role="menuitem"
                    onClick={() => void runExport(format.id)}
                    disabled={busy !== null}
                  >
                    <span className="export-icon">{busy === format.id ? <Loader2 size={16} className="spin" /> : format.icon}</span>
                    <span className="export-text">
                      <strong>{format.label}</strong>
                      <span>
                        {format.id === 'audio'
                          ? t('topbar.export.audioNote', { ext: `.${audioExtension(session)}` })
                          : format.note}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button className="icon-btn" onClick={onManual} aria-label={t('topbar.aria.manual')} title={t('common.manual')}>
          <CircleHelp size={18} />
        </button>

        <button className="icon-btn" onClick={onDrive} aria-label={t('topbar.aria.drive')} title={t('topbar.aria.drive')}>
          <Cloud size={18} />
        </button>

        <button className="icon-btn" onClick={onSettings} aria-label={t('topbar.aria.settings')} title={t('topbar.aria.settings')}>
          <Settings size={18} />
        </button>
      </div>
    </header>
  );
};
