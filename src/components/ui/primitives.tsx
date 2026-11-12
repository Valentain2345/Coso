import React from 'react';
import { currentLang, translate, type Lang, type TKey } from '../../i18n';

export const WaveMark: React.FC<{ size?: number; className?: string }> = ({ size = 22, className }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    className={className}
    focusable="false"
  >
    <rect x="1.5" y="10" width="2.4" height="4" rx="1.2" fill="currentColor" />
    <rect x="6" y="7" width="2.4" height="10" rx="1.2" fill="currentColor" />
    <rect x="10.5" y="4" width="2.4" height="16" rx="1.2" fill="currentColor" />
    <rect x="15" y="7.5" width="2.4" height="9" rx="1.2" fill="currentColor" />
    <rect x="19.5" y="10" width="2.4" height="4" rx="1.2" fill="currentColor" />
  </svg>
);

export function speakerColor(index: number): string {
  return `var(--sp-${((index % 6) + 6) % 6})`;
}

export function timestamp(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function unit(lang: Lang, key: TKey, seconds: number, unitSeconds: number): string {
  const value = Math.round(seconds / unitSeconds);
  return `${value} ${translate(lang, key)}`;
}

export function formatDurationLong(seconds: number, language?: Lang): string {
  const lang = language ?? currentLang();
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return `0 ${translate(lang, 'time.minutes')}`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return unit(lang, 'time.seconds', Math.max(1, Math.round(seconds)), 1);
  if (minutes < 60) return unit(lang, 'time.minutes', seconds, 60);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest
    ? `${hours} ${translate(lang, 'time.hours')} ${unit(lang, 'time.minutes', rest * 60, 60)}`
    : `${hours} ${translate(lang, 'time.hours')}`;
}

export function formatDate(ms: number, language?: Lang): string {
  const lang = language ?? currentLang();
  const date = new Date(ms);
  const now = new Date();
  const time = date.toLocaleTimeString(lang === 'es' ? 'es' : undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return translate(lang, 'time.todayAt', { time });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) {
    return translate(lang, 'time.yesterdayAt', { time });
  }
  return date.toLocaleDateString(lang === 'es' ? 'es' : undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  });
}

export function languageLabel(code: string): string {
  if (!code) return 'Unknown';
  try {
    const names = new Intl.DisplayNames([navigator.language ?? 'en'], { type: 'language' });
    return names.of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}
