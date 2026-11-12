import { useCallback, useEffect, useRef, useState } from 'react';
import type { DevicePreference, ModelId, Settings, TextSize, ThemePreference } from '../types';
import { loadSettings, saveSettings } from '../lib/db';

const LANGUAGE_CODES = [
  'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'ru', 'tr', 'ar', 'hi', 'ja', 'ko', 'zh',
  'uk', 'sv', 'da', 'fi', 'no', 'el', 'he', 'id', 'vi',
];

function preferredLanguage(): string {
  if (typeof navigator === 'undefined') return 'en';
  const candidates = [navigator.language, ...(navigator.languages ?? [])];
  for (const candidate of candidates) {
    const code = candidate?.split('-')[0]?.toLowerCase();
    if (code && LANGUAGE_CODES.includes(code)) return code;
  }
  return 'en';
}

export function defaultSettings(): Settings {
  return {
    model: 'whisper-base',
    language: preferredLanguage(),
    device: 'wasm',
    denoise: true,
    denoiseQuality: 'neural',
    diarize: true,
    diarizeQuality: 'standard',
    diarizeEngine: 'wespeaker',
    maxSpeakers: 4,
    theme: 'system',
    textSize: 'md',
  };
}

interface StoredSettings extends Partial<Settings> {
  model?: ModelId;
  device?: DevicePreference;
  theme?: ThemePreference;
  textSize?: TextSize;
}

export function useSettings() {
  const [settings, setSettingsState] = useState<Settings>(defaultSettings);
  const [ready, setReady] = useState(false);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadSettings()
      .then((stored) => {
        if (cancelled || !stored) return;
        setSettingsState((current) => ({ ...current, ...(stored as StoredSettings) }));
      })
      .catch(() => {
        /* defaults are usable */
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveSettings(settings).catch(() => undefined);
    }, 300);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [settings, ready]);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = settings.theme === 'dark' || (settings.theme === 'system' && media.matches);
      root.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [settings.theme]);

  useEffect(() => {
    document.documentElement.dataset.textSize = settings.textSize;
  }, [settings.textSize]);

  const setSettings = useCallback((patch: Partial<Settings>) => {
    setSettingsState((current) => ({ ...current, ...patch }));
  }, []);

  const resetSettings = useCallback(() => setSettingsState(defaultSettings()), []);

  return { settings, setSettings, resetSettings, ready };
}
