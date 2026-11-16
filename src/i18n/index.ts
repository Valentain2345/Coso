import { useCallback, useSyncExternalStore } from 'react';
import { en, type Dict, type Lang, type TKey } from './en';
import { es } from './es';

export type { Lang, TKey };
export type Params = Record<string, string | number>;

const STORAGE_KEY = 'coso.uiLang';
const listeners = new Set<() => void>();

/**
 * Plural keys are written as `key.one` / `key.other`; components call them by
 * the shared base (`count.words`), so the public key type includes both.
 */
type DistributePlural<K> = K extends `${infer Base}.one` ? Base : never;
type PluralBase = DistributePlural<TKey>;
export type TParam = TKey | PluralBase;

function fromNavigator(): Lang {
  if (typeof navigator === 'undefined') return 'en';
  const candidates = [navigator.language, ...(navigator.languages ?? [])];
  for (const candidate of candidates) {
    const code = candidate?.split('-')[0]?.toLowerCase();
    if (code === 'es') return 'es';
    if (code === 'en') return 'en';
  }
  return 'en';
}

let current: Lang =
  typeof localStorage !== 'undefined' && (localStorage.getItem(STORAGE_KEY) === 'es' || localStorage.getItem(STORAGE_KEY) === 'en')
    ? (localStorage.getItem(STORAGE_KEY) as Lang)
    : fromNavigator();

const DICTIONARIES: Record<Lang, Dict> = { en, es };

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getLang(): Lang {
  return current;
}

/** Currently installed languages, for settings UIs. */
export function languages(): Array<{ id: Lang; label: string }> {
  return [
    { id: 'en', label: en['settings.language.en'] },
    { id: 'es', label: es['settings.language.es'] },
  ];
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* private mode: the choice lives for this page load only */
  }
  // Keep the document language truthful (screen readers, spell check) and let
  // the analytics consent strip follow the UI language without an import.
  if (typeof document !== 'undefined') {
    document.documentElement.lang = lang;
    document.dispatchEvent(new CustomEvent('coso:lang', { detail: lang }));
  }
  listeners.forEach((listener) => listener());
}

function interpolate(template: string, params: Params | undefined, lang: Lang): string {
  if (!params) return template;
  const locale = lang === 'es' ? 'es' : 'en';
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) return match;
    const value = params[name];
    return typeof value === 'number' ? new Intl.NumberFormat(locale).format(value) : String(value);
  });
}

/** Resolve `key`, `key.other` or `key.one` for a count, then interpolate. */
export function translate(lang: Lang, key: TParam, params?: Params): string {
  const dict = DICTIONARIES[lang];
  let template: string | undefined = dict[key as TKey];
  if (template === undefined && params && typeof params.count === 'number') {
    const form = new Intl.PluralRules(lang === 'es' ? 'es' : 'en').select(params.count);
    template = dict[`${key}.${form}` as TKey] ?? dict[`${key}.other` as TKey];
  }
  if (template === undefined) {
    // Fall back to English, then to the key itself so a missing translation is
    // visible during development instead of rendering empty text.
    template = (en as Dict)[key as TKey] ?? key;
  }
  return interpolate(template, params, lang);
}

export interface I18n {
  lang: Lang;
  t: (key: TParam, params?: Params) => string;
  setLang: (lang: Lang) => void;
}

/** React binding. Re-renders the whole tree when the language changes. */
export function useI18n(): I18n {
  const lang = useSyncExternalStore(subscribe, getLang, getLang);
  const t = useCallback((key: TParam, params?: Params) => translate(lang, key, params), [lang]);
  return { lang, t, setLang };
}

/**
 * For code outside React (hooks and libraries). Safe to call during render of
 * components that also subscribe via `useI18n`, which triggers the re-render.
 */
export function t(key: TParam, params?: Params): string {
  return translate(current, key, params);
}

export function currentLang(): Lang {
  return current;
}
