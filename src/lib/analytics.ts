import { isTauri } from './tauri';

/** Collector endpoint of the Coso analytics Function (see `analytics/README.md`). */
export const ANALYTICS_ENDPOINT =
  'https://br-broad-mode-bd85rkq4-analytics.compute.c-8.us-east-2.aws.neon.tech/api/collect';

/** Where the consent bar's "Details" link points. */
export const ANALYTICS_DETAILS = 'https://valentain2345.github.io/Coso/#privacy';

/**
 * URL of the shared client, published next to the web app by
 * `tools/publish-web.ps1`: `/Coso/app/` + `/Coso/analytics/client.js`.
 *
 * `base` is the Vite base of the current build (`/` in development and in the
 * native bundle, `/Coso/app/` on GitHub Pages). The result is always absolute
 * so it resolves the same from any page inside the app.
 */
export function analyticsClientUrl(base: string): string {
  const parent = base.trim().replace(/\/+$/, '').replace(/\/[^/]*$/, '');
  const root = parent === '' ? '' : parent.startsWith('/') ? parent : `/${parent}`;
  return `${root}/analytics/client.js`;
}

/**
 * Loads `analytics/client.js` in the browser build only.
 *
 * The native shells (Windows, Android) must never load the analytics client,
 * which is why this is guarded by `isTauri()` and not by a `<script>` tag: the
 * promise "the apps send nothing" then holds even if the bundle is served from
 * a domain that also hosts the client. The client itself is inert until the
 * visitor accepts.
 */
export function mountAnalytics(options?: {
  doc?: Document;
  base?: string;
  native?: boolean;
}): HTMLScriptElement | null {
  const doc = options?.doc ?? document;
  const native = options?.native ?? isTauri();
  if (native) return null;
  if (doc.querySelector('script[data-analytics-client]')) return null;

  const script = doc.createElement('script');
  script.src = analyticsClientUrl(options?.base ?? import.meta.env.BASE_URL);
  script.async = true;
  script.setAttribute('data-endpoint', ANALYTICS_ENDPOINT);
  script.setAttribute('data-surface', 'app');
  script.setAttribute('data-details', ANALYTICS_DETAILS);
  script.setAttribute('data-analytics-client', '');
  doc.head.appendChild(script);
  return script;
}
