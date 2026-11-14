import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session, SessionMeta } from '../types';
import {
  deleteSession as removeFromDb,
  listSessions,
  getSession,
  saveSession,
  newId,
} from '../lib/db';
import { t } from '../i18n';

export function useSessions() {
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [current, setCurrentState] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const currentRef = useRef<Session | null>(null);
  const saveTimer = useRef<number | null>(null);

  const setCurrent = useCallback((session: Session | null) => {
    currentRef.current = session;
    setCurrentState(session);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await listSessions();
      setSessions(list);
      setError(null);
      return list;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error.readSessions'));
      return [];
    }
  }, []);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const cancelPendingSave = useCallback(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
  }, []);

  const scheduleSave = useCallback(
    (session: Session) => {
      cancelPendingSave();
      saveTimer.current = window.setTimeout(() => {
        void saveSession(session)
          .then(refresh)
          .catch((caught) => setError(caught instanceof Error ? caught.message : t('error.saveChanges')));
      }, 700);
    },
    [cancelPendingSave, refresh],
  );

  const flush = useCallback(async () => {
    cancelPendingSave();
    const session = currentRef.current;
    if (!session) return;
    try {
      await saveSession(session);
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('error.saveChanges'));
    }
  }, [cancelPendingSave, refresh]);

  const open = useCallback(
    async (id: string) => {
      cancelPendingSave();
      try {
        const session = await getSession(id);
        setCurrent(session);
        return session;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That session could not be opened.');
        return null;
      }
    },
    [cancelPendingSave, setCurrent],
  );

  const add = useCallback(
    async (session: Session, options?: { activate?: boolean }) => {
      const activate = options?.activate ?? true;
      if (activate) {
        cancelPendingSave();
        setCurrent(session);
      }
      try {
        await saveSession(session);
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'The transcript could not be saved.');
      }
    },
    [cancelPendingSave, refresh, setCurrent],
  );

  const update = useCallback(
    (mutator: (session: Session) => Session, options?: { persist?: boolean }) => {
      const existing = currentRef.current;
      if (!existing) return;
      const next = { ...mutator(existing), updatedAt: Date.now() };
      currentRef.current = next;
      setCurrentState(next);
      if (options?.persist !== false) scheduleSave(next);
    },
    [scheduleSave],
  );

  const remove = useCallback(
    async (id: string) => {
      try {
        await removeFromDb(id);
        if (currentRef.current?.id === id) setCurrent(null);
        await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'That session could not be deleted.');
      }
    },
    [refresh, setCurrent],
  );

  const clearError = useCallback(() => setError(null), []);

  const clearCurrent = useCallback(() => setCurrent(null), [setCurrent]);

  useEffect(() => () => cancelPendingSave(), [cancelPendingSave]);

  return {
    sessions,
    current,
    loading,
    error,
    newId,
    refresh,
    open,
    add,
    update,
    remove,
    flush,
    clearCurrent,
    clearError,
  };
}
