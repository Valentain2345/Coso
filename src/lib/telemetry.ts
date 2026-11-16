/**
 * Consent gate for browser telemetry.
 *
 * The heavy part (`./otel`, the OpenTelemetry SDK plus the vitals observers)
 * is a dynamic import that only happens after the visitor accepts. Rejecting,
 * ignoring the bar, Do Not Track or Global Privacy Control all end here: no
 * chunk, no observer, no request. The native shells never reach this file at
 * all, because `startTelemetry` returns before the import when `isTauri()`.
 */

import { isTauri } from './tauri';

/** Base URL of the telemetry Function; `/v1/traces` and `/v1/metrics` follow. */
export const TELEMETRY_ENDPOINT =
  'https://br-broad-mode-bd85rkq4-telemetry.compute.c-8.us-east-2.aws.neon.tech';

/** Shared with `analytics/client.js`: one choice for the whole origin. */
export const CONSENT_KEY = 'coso.consent';

export type Consent = 'granted' | 'denied' | null;

/** The stored choice, or `null` while the bar is still waiting. */
export function readConsent(storage?: Storage): Consent {
  try {
    const value = (storage ?? window.localStorage).getItem(CONSENT_KEY);
    return value === 'granted' || value === 'denied' ? value : null;
  } catch {
    return null;
  }
}

/** `DNT: 1` or `Sec-GPC`: honour it before anything is loaded. */
export function optedOut(nav: Navigator = window.navigator): boolean {
  const gpc = (nav as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl;
  return nav.doNotTrack === '1' || gpc === true;
}

/** Resolves once the consent bar is answered. */
function waitForConsent(): Promise<boolean> {
  return new Promise((resolve) => {
    const listener = (event: Event) => {
      window.removeEventListener('coso:consent', listener);
      resolve((event as CustomEvent<string>).detail === 'granted');
    };
    window.addEventListener('coso:consent', listener);
  });
}

/**
 * Starts OpenTelemetry if, and only if, the visitor said yes.
 *
 * Safe to call on every boot: it is idempotent, and it does nothing in the
 * native shells or for a visitor who opted out.
 */
export async function startTelemetry(options?: {
  endpoint?: string;
  surface?: 'app' | 'site';
}): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (isTauri()) return false;
  if (optedOut()) return false;

  let consent = readConsent();
  if (consent === null) consent = (await waitForConsent()) ? 'granted' : 'denied';
  if (consent !== 'granted') return false;

  const { startBrowserTelemetry } = await import('./otel');
  startBrowserTelemetry({
    endpoint: options?.endpoint ?? TELEMETRY_ENDPOINT,
    surface: options?.surface ?? 'app',
  });
  return true;
}
