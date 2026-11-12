import React, { useMemo, useRef } from 'react';
import { BookOpen, Plus, Search, Settings, Trash2, HardDrive, X } from 'lucide-react';
import type { SessionMeta } from '../types';
import { useI18n, translate, type Lang, type TKey } from '../i18n';
import { formatDate, formatDurationLong, WaveMark } from './ui/primitives';

interface Props {
  sessions: SessionMeta[];
  currentId: string | null;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (session: SessionMeta) => void;
  onSettings: () => void;
  onManual: () => void;
  storage: { usage: number; quota: number } | null;
}

function groupLabel(ms: number, lang: Lang): string {
  const date = new Date(ms);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) return translate(lang, 'time.today');
  if (date.getTime() >= startOfToday - 86400000) return translate(lang, 'time.yesterday');
  if (date.getTime() >= startOfToday - 7 * 86400000) return translate(lang, 'time.earlierThisWeek');
  return date.toLocaleDateString(lang === 'es' ? 'es' : undefined, { month: 'long', year: 'numeric' });
}

export const Sidebar: React.FC<Props> = ({
  sessions,
  currentId,
  open,
  onClose,
  onSelect,
  onNew,
  onDelete,
  onSettings,
  onManual,
  storage,
}) => {
  const { lang, t } = useI18n();
  const [query, setQuery] = React.useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const [isMobile, setIsMobile] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 860px)').matches,
  );
  // Keep the latest close callback without re-running the drawer effects on
  // every parent render (the app re-renders while recording).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // The drawer only exists below the layout breakpoint. Track the breakpoint so
  // the off-screen panel can be made inert and so a desktop resize never leaves
  // the mobile drawer open behind the permanent column.
  React.useEffect(() => {
    const query = window.matchMedia('(max-width: 860px)');
    const update = () => setIsMobile(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  React.useEffect(() => {
    if (!isMobile && open) closeRef.current();
  }, [isMobile, open]);

  // Escape closes the drawer, the page behind it stops scrolling, and the main
  // column becomes inert while the drawer covers the screen — the behaviour
  // people expect from a mobile navigation sheet.
  React.useEffect(() => {
    if (!open || !isMobile) return;
    const main = document.querySelector<HTMLElement>('.main-shell');
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeRef.current();
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    main?.setAttribute('inert', '');
    panelRef.current?.focus();
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      main?.removeAttribute('inert');
      previouslyFocused?.focus?.();
    };
  }, [open, isMobile]);

  const onTouchStart = (event: React.TouchEvent) => {
    if (!isMobile || !open) return;
    const touch = event.touches[0];
    touchStart.current = { x: touch.clientX, y: touch.clientY };
  };

  const onTouchEnd = (event: React.TouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || !isMobile || !open) return;
    const touch = event.changedTouches[0];
    const dx = touch.clientX - start.x;
    const dy = Math.abs(touch.clientY - start.y);
    // A mostly-horizontal swipe to the left dismisses the drawer.
    if (dx < -56 && dy < 48) onClose();
  };

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return sessions;
    return sessions.filter(
      (session) =>
        session.title.toLowerCase().includes(needle) ||
        formatDate(session.createdAt, lang).toLowerCase().includes(needle),
    );
  }, [sessions, query, lang]);

  const groups = useMemo(() => {
    const map = new Map<string, SessionMeta[]>();
    for (const session of filtered) {
      const label = groupLabel(session.createdAt, lang);
      const list = map.get(label) ?? [];
      list.push(session);
      map.set(label, list);
    }
    return Array.from(map.entries());
  }, [filtered, lang]);

  const usagePercent = storage && storage.quota > 0 ? Math.min(100, (storage.usage / storage.quota) * 100) : 0;

  return (
    <>
      <div className={`sidebar-scrim ${open ? 'visible' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside
        id="session-library"
        ref={panelRef}
        tabIndex={-1}
        className={`sidebar ${open ? 'open' : ''}`}
        aria-label={t('sidebar.aria.library')}
        inert={isMobile && !open}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div className="sidebar-brand">
          <span className="brand-mark">
            <WaveMark size={20} />
          </span>
          <div className="brand-text">
            <span className="brand-name">Coso</span>
            <span className="brand-tag">{t('sidebar.tagline')}</span>
          </div>
          <button className="icon-btn sidebar-close" onClick={onClose} aria-label={t('sidebar.aria.close')}>
            <X size={18} />
          </button>
        </div>

        <button className="btn btn-primary new-session" onClick={onNew}>
          <Plus size={17} strokeWidth={2.4} />
          {t('sidebar.new')}
        </button>

        <div className="sidebar-search">
          <Search size={15} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('sidebar.search')}
            aria-label={t('sidebar.search')}
            spellCheck={false}
          />
          <kbd>⌘K</kbd>
        </div>

        <div className="session-list" role="list">
          {groups.length === 0 && (
            <div className="sidebar-empty">
              <p>{sessions.length === 0 ? t('sidebar.emptyNone.title') : t('sidebar.emptySearch.title')}</p>
              <span>{sessions.length === 0 ? t('sidebar.emptyNone.hint') : t('sidebar.emptySearch.hint')}</span>
            </div>
          )}

          {groups.map(([label, items]) => (
            <div className="session-group" key={label}>
              <div className="session-group-label">{label}</div>
              {items.map((session) => (
                <div
                  key={session.id}
                  className={`session-row ${currentId === session.id ? 'active' : ''}`}
                  role="listitem"
                >
                  <button className="session-open" onClick={() => onSelect(session.id)}>
                    <span className="session-title">{session.title}</span>
                    <span className="session-meta">
                      {formatDurationLong(session.duration, lang)}
                      <span aria-hidden="true"> · </span>
                      {t('count.words', { count: session.wordCount })}
                    </span>
                    <span className="session-date">{formatDate(session.createdAt, lang)}</span>
                  </button>
                  <button
                    className="icon-btn session-delete"
                    onClick={() => onDelete(session)}
                    aria-label={t('sidebar.aria.delete', { title: session.title })}
                    title={t('sidebar.title.delete')}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          {storage && (
            <div className="storage">
              <div className="storage-head">
                <HardDrive size={13} aria-hidden="true" />
                <span>{t('sidebar.storage')}</span>
                <span className="storage-amount">{usagePercent.toFixed(0)}%</span>
              </div>
              <div className="storage-bar" aria-hidden="true">
                <span style={{ width: `${Math.max(2, usagePercent)}%` }} />
              </div>
            </div>
          )}
          <button className="sidebar-link" onClick={onManual}>
            <BookOpen size={16} aria-hidden="true" />
            {t('common.manual')}
          </button>
          <button className="sidebar-link" onClick={onSettings}>
            <Settings size={16} aria-hidden="true" />
            {t('common.settings')}
          </button>
          <p className="privacy-note">{t('sidebar.privacy')}</p>
        </div>
      </aside>
    </>
  );
};

export type { TKey as SidebarTKey };
