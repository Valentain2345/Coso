/**
 * Pure helpers for the Coso analytics Function.
 *
 * Same rules as the old Worker: deterministic, side-effect free, and the place
 * where the privacy contract is pinned by tests — what is stored, what is
 * dropped, and how a visitor is counted without ever keeping an IP address.
 */

import { createHmac } from 'node:crypto';

/** Bots and automated browsers never reach the database. */
const BOT =
  /bot\b|crawler|spider|crawling|facebookexternalhit|slurp|bingpreview|headlesschrome|phantomjs|lighthouse|pagespeed|gtmetrix|pingdom|uptime|curl\/|wget\//i;

/** Search engines, social networks and our own pages, for acquisition channels. */
const SEARCH =
  /(^|\.)(google|bing|duckduckgo|yahoo|yandex|baidu|ecosia|startpage|qwant|brave|kagi)\.[a-z.]+$/i;
const SOCIAL =
  /(^|\.)(twitter|x|facebook|instagram|linkedin|reddit|tiktok|youtube|mastodon|threads|bluesky|news\.ycombinator|ycombinator|pinterest|whatsapp|telegram|discord)\.[a-z.]+$/i;

export function isBot(userAgent: string | null | undefined): boolean {
  return typeof userAgent !== 'string' || userAgent.trim().length === 0 || BOT.test(userAgent);
}

/** UTC day, the unit that also rotates the visitor salt. */
export function utcDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Visitor id: HMAC(secret, day | ip | user agent), truncated to 8 bytes.
 *
 * The IP is only an input to the hash and is never stored; the daily salt means
 * yesterday's id cannot be linked to today's, so there is no long-lived
 * identifier to put in a cookie or to leak.
 */
export function visitorId(secret: string, day: string, ip: string, userAgent: string): string {
  return createHmac('sha256', secret).update(`${day}|${ip}|${userAgent}`).digest('hex').slice(0, 16);
}

/**
 * Best effort client address, used only as an HMAC input and never persisted.
 *
 * Neon Functions sit behind a proxy that forwards the usual headers; if none is
 * present the visitor is still counted, just less precisely.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') ?? request.headers.get('cf-connecting-ip') ?? '';
}

/** Page path without query or hash, capped so a crafted URL cannot bloat a row. */
export function cleanPath(value: unknown): string {
  if (typeof value !== 'string') return '/';
  const path = value.split(/[?#]/)[0].slice(0, 200);
  if (path.length === 0) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

/** Only the referrer host is kept: never the full URL, never the query string. */
export function cleanReferrer(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  try {
    const host = new URL(value.includes('://') ? value : `https://${value}`).host.toLowerCase();
    return host.slice(0, 120);
  } catch {
    return '';
  }
}

/** Two surfaces only: the download page and the web app. */
export function cleanSurface(value: unknown): 'site' | 'app' {
  return value === 'app' ? 'app' : 'site';
}

/** `utm_source`, reduced to a slug: no URLs, no free text, no personal data. */
export function cleanSource(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

/** Event names are slugs; anything unreadable falls back to `pageview`. */
export function cleanEvent(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'pageview';
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug.length > 0 ? slug : 'pageview';
}

const PROP_KEY = /^[a-z][a-z0-9_]{0,23}$/;

/**
 * Custom event props: at most three flat values per event, 40 characters each.
 * Nested values, URLs and long strings are dropped, so a caller cannot smuggle
 * a transcript or an email into the database.
 */
export function cleanProps(value: unknown, limit = 3): Record<string, string | number | boolean> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= limit) break;
    if (!PROP_KEY.test(key)) continue;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      out[key] = Math.round(raw * 100) / 100;
    } else if (typeof raw === 'boolean') {
      out[key] = raw;
    } else if (typeof raw === 'string' && raw.length > 0 && raw.length <= 40 && !/[/\\]/.test(raw)) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Seconds on page: a whole number between 0 and one hour. */
export function cleanDuration(value: unknown): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.min(3600, Math.round(seconds));
}

/** Primary language tag from Accept-Language: `es-ES,es;q=0.9` -> `es`. */
export function acceptLanguage(header: string | null | undefined): string {
  if (typeof header !== 'string' || header.length === 0) return '';
  const first = (header.split(',')[0] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  const tag = first.split('-')[0] ?? '';
  return /^[a-z]{2,3}$/.test(tag) ? tag : '';
}

export function classifyDevice(userAgent: string): 'mobile' | 'tablet' | 'desktop' {
  if (/iPad|Tablet|PlayBook|Silk|Android(?![\s\S]*Mobi)/i.test(userAgent)) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(userAgent)) return 'mobile';
  return 'desktop';
}

export function classifyBrowser(userAgent: string): string {
  if (/Edg[A-Z]?\/|EdgiOS|EdgA\//.test(userAgent)) return 'Edge';
  if (/OPR\/|Opera/.test(userAgent)) return 'Opera';
  if (/SamsungBrowser/.test(userAgent)) return 'Samsung';
  if (/Firefox\/|FxiOS/.test(userAgent)) return 'Firefox';
  if (/Chrome\/|CriOS/.test(userAgent)) return 'Chrome';
  if (/Safari\//.test(userAgent)) return 'Safari';
  return 'Other';
}

export function classifyOs(userAgent: string): string {
  if (/Windows NT/.test(userAgent)) return 'Windows';
  if (/Android/.test(userAgent)) return 'Android';
  if (/iPhone|iPad|iPod/.test(userAgent)) return 'iOS';
  if (/Mac OS X/.test(userAgent)) return 'macOS';
  if (/Linux/.test(userAgent)) return 'Linux';
  return 'Other';
}

/**
 * Acquisition channel, the same buckets every analytics tool reports.
 * `source` (utm_source) wins because a tagged campaign is explicit.
 */
export function channelOf(referrer: string, source: string): string {
  if (typeof source === 'string' && source.length > 0) return 'Campaign';
  if (typeof referrer !== 'string' || referrer.length === 0) return 'Direct';
  if (/github\.io$|^localhost$|^127\.0\.0\.1$/i.test(referrer)) return 'Internal';
  if (SEARCH.test(referrer)) return 'Search';
  if (SOCIAL.test(referrer)) return 'Social';
  return 'Referral';
}

/** Aggregate a referrer list into channels; the shape comes from the SQL. */
export function channelsOf(
  referrers: Array<{ referrer?: string | null; source?: string | null; views?: number | string }> | null | undefined,
): Array<{ channel: string; views: number }> {
  const totals = new Map<string, number>();
  for (const row of referrers ?? []) {
    const channel = channelOf(row.referrer ?? '', row.source ?? '');
    const views = Number(row.views) || 0;
    totals.set(channel, (totals.get(channel) ?? 0) + views);
  }
  return [...totals.entries()]
    .map(([channel, views]) => ({ channel, views }))
    .sort((a, b) => b.views - a.views);
}

/** The dashboard is only for the accounts named in ALLOWED_LOGINS. */
export function isAllowedLogin(login: string, allowlist: string | null | undefined): boolean {
  if (typeof login !== 'string' || login.length === 0) return false;
  return String(allowlist ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .includes(login.toLowerCase());
}

/** Reflect only origins we own; anything else gets no CORS approval. */
export function corsHeaders(origin: string, allowedOrigins: string | null | undefined): Record<string, string> {
  const allowed = String(allowedOrigins ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const headers: Record<string, string> = {
    Vary: 'Origin',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}
