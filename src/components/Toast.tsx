import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { t } from '../i18n';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  tone: ToastTone;
}

export function useToasts() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((title: string, tone: ToastTone = 'info', description?: string) => {
    const id = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current.slice(-3), { id, title, description, tone }]);
    return id;
  }, []);

  return { toasts, push, dismiss };
}

const ICONS: Record<ToastTone, React.ReactNode> = {
  success: <CheckCircle2 size={18} />,
  error: <XCircle size={18} />,
  info: <Info size={18} />,
};

const ToastRow: React.FC<{ toast: ToastItem; onDismiss: (id: string) => void }> = ({ toast, onDismiss }) => {
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.id), toast.tone === 'error' ? 9000 : 4500);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.tone, onDismiss]);

  return (
    <div className={`toast toast-${toast.tone}`} role="status">
      <span className="toast-icon">{ICONS[toast.tone]}</span>
      <div className="toast-text">
        <strong>{toast.title}</strong>
        {toast.description && <span>{toast.description}</span>}
      </div>
      <button className="icon-btn toast-close" onClick={() => onDismiss(toast.id)} aria-label={t('toast.dismiss.aria')}>
        <X size={15} />
      </button>
    </div>
  );
};

export const ToastStack: React.FC<{ toasts: ToastItem[]; onDismiss: (id: string) => void }> = ({
  toasts,
  onDismiss,
}) => (
  <div className="toast-stack" aria-live="polite" aria-atomic="false">
    {toasts.map((toast) => (
      <ToastRow key={toast.id} toast={toast} onDismiss={onDismiss} />
    ))}
  </div>
);
