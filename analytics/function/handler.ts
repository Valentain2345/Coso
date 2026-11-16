/**
 * Coso analytics: collector, dashboard API and retention sweep.
 *
 * Routes
 *   POST /api/collect      one pageview, engagement ping or custom event
 *   POST /api/auth/device  start GitHub device-flow login (no client secret)
 *   POST /api/auth/token   exchange an approved device code for a token
 *   GET  /api/stats        aggregate numbers, for allowlisted GitHub users
 *   GET  /api/health
 *   POST /cron             daily retention sweep (Function Trigger)
 *
 * Design rules that keep the site honest and the data small:
 * - A visitor is an HMAC of (day, IP, user agent). The IP is never stored and
 *   the salt rotates daily, so two days cannot be linked.
 * - Bots, DNT and Global Privacy Control are dropped before touching the DB.
 * - Only the referrer host, the path, a utm_source slug, the primary language
 *   and coarse device classes are kept. Rows expire after RETENTION_DAYS.
 *
 * Everything is injected (`query`, `env`, `now`, `githubFetch`) so the whole
 * surface is tested against a fake Postgres, with no network and no database.
 */

import { parseTriggerDelivery } from '@neon/functions/triggers';

import {
  channelsOf,
  classifyBrowser,
  classifyDevice,
  classifyOs,
  cleanDuration,
  cleanEvent,
  cleanPath,
  cleanProps,
  cleanReferrer,
  cleanSource,
  cleanSurface,
  corsHeaders,
  isAllowedLogin,
  isBot,
  json,
  utcDay,
  visitorId,
  acceptLanguage,
} from './lib';

export const RETENTION_DAYS = 180;
export const MAX_DAYS = 365;
export const DEFAULT_DAYS = 30;
const DAY_MS = 86_400_000;

export interface AnalyticsEnv {
  /** Salt for the daily visitor HMAC. Rotating it de-links every earlier day. */
  hashSecret: string;
  /** Public GitHub OAuth app client id; the device flow needs no secret. */
  githubClientId: string;
  /** Comma-separated GitHub logins allowed to read the dashboard. */
  allowedLogins: string;
  /** Comma-separated origins allowed to POST events. */
  allowedOrigins: string;
}

/** Minimal slice of `pg`'s client the handler needs, so tests can fake it. */
export type Query = <T extends Record<string, unknown>>(
  sql: string,
  params?: unknown[],
) => Promise<T[]>;

export interface AnalyticsDeps {
  query: Query;
  env: AnalyticsEnv;
  now?: () => number;
  /** Only replaced in tests; production uses the global fetch. */
  githubFetch?: typeof fetch;
}

interface Row {
  [key: string]: unknown;
}

const noContent = (headers: Record<string, string>) => new Response(null, { status: 204, headers });

const originOf = (request: Request) => request.headers.get('origin') ?? '';

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

/**
 * Verifies a GitHub token and returns its login. Cached per isolate for five
 * minutes so a dashboard reload does not hit GitHub every time.
 */
const loginCache = new Map<string, { login: string; expires: number }>();

export function createAnalytics(deps: AnalyticsDeps) {
  const { env } = deps;
  const now = deps.now ?? Date.now;
  const githubFetch = deps.githubFetch ?? fetch;
  const query = deps.query;

  async function githubLogin(token: string): Promise<string | null> {
    if (typeof token !== 'string' || token.length === 0) return null;
    const cached = loginCache.get(token);
    if (cached && cached.expires > now()) return cached.login;

    const response = await githubFetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'coso-analytics',
      },
    });
    if (!response.ok) {
      loginCache.delete(token);
      return null;
    }
    const data = (await response.json()) as { login?: unknown };
    if (typeof data.login !== 'string') return null;
    loginCache.set(token, { login: data.login, expires: now() + 300_000 });
    return data.login;
  }

  async function collect(request: Request, headers: Record<string, string>): Promise<Response> {
    // The client already refuses to send, but a proxy or a curious user can
    // forge requests: honour the opt-outs here too.
    if (request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1') {
      return noContent(headers);
    }

    const userAgent = request.headers.get('user-agent') ?? '';
    if (isBot(userAgent)) return noContent(headers);

    const raw = await request.text();
    if (raw.length > 2048) return json({ error: 'payload too large' }, 413, headers);

    let body: Row;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return json({ error: 'invalid json' }, 400, headers);
      }
      body = parsed as Row;
    } catch {
      return json({ error: 'invalid json' }, 400, headers);
    }

    const at = now();
    const day = utcDay(new Date(at));
    const event = cleanEvent(body.e);
    const props = cleanProps(body.x);

    await query(
      `INSERT INTO hits
         (ts, day, surface, path, referrer, source, event, props, value, language, device, browser, os, visitor)
       VALUES (to_timestamp($1), $2::date, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)`,
      [
        Math.floor(at / 1000),
        day,
        cleanSurface(body.s),
        cleanPath(body.p),
        cleanReferrer(body.r),
        cleanSource(body.m),
        event,
        JSON.stringify(props ?? {}),
        event === 'engagement' ? cleanDuration(body.d) : 0,
        acceptLanguage(request.headers.get('accept-language')),
        classifyDevice(userAgent),
        classifyBrowser(userAgent),
        classifyOs(userAgent),
        await visitorId(env.hashSecret, day, clientIp(request), userAgent),
      ],
    );

    return noContent(headers);
  }

  async function deviceCode(headers: Record<string, string>): Promise<Response> {
    if (!env.githubClientId) return json({ error: 'login is not configured' }, 503, headers);

    const response = await githubFetch('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: env.githubClientId, scope: 'read:user' }),
    });
    const data = (await response.json().catch(() => ({}))) as Row;
    if (!response.ok || typeof data.device_code !== 'string') {
      return json({ error: data.error ?? 'device flow unavailable' }, 502, headers);
    }
    return json(
      {
        device_code: data.device_code,
        user_code: data.user_code,
        verification_uri: data.verification_uri,
        expires_in: data.expires_in,
        interval: data.interval,
      },
      200,
      headers,
    );
  }

  async function deviceToken(request: Request, headers: Record<string, string>): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as Row;
    if (typeof body.device_code !== 'string' || body.device_code.length === 0) {
      return json({ error: 'device_code required' }, 400, headers);
    }

    const response = await githubFetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: env.githubClientId,
        device_code: body.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });
    const data = (await response.json().catch(() => ({}))) as Row;

    if (typeof data.access_token === 'string') return json({ token: data.access_token }, 200, headers);
    // authorization_pending / slow_down / expired_token / access_denied
    return json({ error: data.error ?? 'authorization failed', interval: data.interval }, 400, headers);
  }

  async function stats(request: Request, url: URL, headers: Record<string, string>): Promise<Response> {
    const token = (request.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const login = await githubLogin(token);
    if (!login || !isAllowedLogin(login, env.allowedLogins)) {
      return json({ error: 'forbidden' }, 403, headers);
    }

    const days = Math.min(MAX_DAYS, Math.max(1, Number(url.searchParams.get('days')) || DEFAULT_DAYS));
    const since = utcDay(new Date(now() - (days - 1) * DAY_MS));
    const requested = url.searchParams.get('surface');
    const surface = requested === 'site' || requested === 'app' ? requested : null;
    // Every query is pageview-scoped unless it is about events or time on page,
    // so the numbers mean the same thing they do in Umami or Plausible.
    const filter = surface ? 'AND surface = $2' : '';
    const params = surface ? [since, surface] : [since];
    const run = <T extends Record<string, unknown>>(sql: string) => query<T>(sql, params);
    const where = `FROM hits WHERE day >= $1::date AND event = 'pageview' ${filter}`;

    const [totals, bounce, engagement, daily, pages, referrers, languages, devices, browsers, oses, surfaces, events] =
      await Promise.all([
        run<{ views: number; visitors: number }>(
          `SELECT COUNT(*)::int AS views, COUNT(DISTINCT visitor)::int AS visitors ${where}`,
        ),
        run<{ bouncers: number }>(
          `SELECT COUNT(*)::int AS bouncers FROM (
             SELECT visitor ${where} GROUP BY visitor HAVING COUNT(*) = 1
           ) single`,
        ),
        run<{ samples: number; seconds: number | null }>(
          `SELECT COUNT(*)::int AS samples, AVG(value)::float AS seconds
           FROM hits WHERE day >= $1::date AND event = 'engagement' ${filter}`,
        ),
        run<{ day: string; views: number; visitors: number }>(
          `SELECT to_char(day, 'YYYY-MM-DD') AS day,
                  COUNT(*)::int AS views, COUNT(DISTINCT visitor)::int AS visitors
           ${where} GROUP BY day ORDER BY day`,
        ),
        run<{ path: string; views: number; visitors: number }>(
          `SELECT path, COUNT(*)::int AS views, COUNT(DISTINCT visitor)::int AS visitors
           ${where} GROUP BY path ORDER BY views DESC, path LIMIT 20`,
        ),
        run<{ referrer: string; source: string; views: number }>(
          `SELECT referrer, source, COUNT(*)::int AS views
           ${where} AND (referrer <> '' OR source <> '')
           GROUP BY referrer, source ORDER BY views DESC LIMIT 50`,
        ),
        run<{ language: string; views: number }>(
          `SELECT language, COUNT(*)::int AS views ${where}
           GROUP BY language ORDER BY views DESC LIMIT 20`,
        ),
        run<{ device: string; views: number }>(
          `SELECT device, COUNT(*)::int AS views ${where} GROUP BY device ORDER BY views DESC`,
        ),
        run<{ browser: string; views: number }>(
          `SELECT browser, COUNT(*)::int AS views ${where} GROUP BY browser ORDER BY views DESC LIMIT 10`,
        ),
        run<{ os: string; views: number }>(
          `SELECT os, COUNT(*)::int AS views ${where} GROUP BY os ORDER BY views DESC LIMIT 10`,
        ),
        run<{ surface: string; views: number }>(
          `SELECT surface, COUNT(*)::int AS views ${where} GROUP BY surface ORDER BY views DESC`,
        ),
        run<{ event: string; views: number; visitors: number; seconds: number | null }>(
          `SELECT event, COUNT(*)::int AS views, COUNT(DISTINCT visitor)::int AS visitors,
                  AVG(value)::float AS seconds
           FROM hits WHERE day >= $1::date AND event NOT IN ('pageview', 'engagement') ${filter}
           GROUP BY event ORDER BY views DESC LIMIT 20`,
        ),
      ]);

    const total = totals[0] ?? { views: 0, visitors: 0 };
    const bouncers = bounce[0]?.bouncers ?? 0;
    const engaged = engagement[0] ?? { samples: 0, seconds: null };
    const referrerRows = referrers;

    return json(
      {
        login,
        days,
        since,
        surface: surface ?? 'all',
        totals: {
          views: Number(total.views) || 0,
          visitors: Number(total.visitors) || 0,
          bouncers: Number(bouncers) || 0,
          engagementSamples: Number(engaged.samples) || 0,
          engagementSeconds: engaged.seconds === null ? null : Math.round(Number(engaged.seconds)),
        },
        daily,
        pages,
        referrers: referrerRows.slice(0, 12),
        channels: channelsOf(referrerRows),
        languages,
        devices,
        browsers,
        oses,
        surfaces,
        events,
      },
      200,
      headers,
    );
  }

  /** Daily sweep. Only a real Function Trigger delivery gets past the check. */
  async function retention(request: Request): Promise<Response> {
    const parsed = await parseTriggerDelivery(request);
    if (!parsed.ok) {
      const status = parsed.error === 'invalid_body' ? 400 : 401;
      return json({ error: parsed.error }, status);
    }

    const cutoff = utcDay(new Date(now() - RETENTION_DAYS * DAY_MS));
    const rows = await query<{ deleted: number }>(
      `WITH deleted AS (DELETE FROM hits WHERE day < $1::date RETURNING 1)
       SELECT COUNT(*)::int AS deleted FROM deleted`,
      [cutoff],
    );
    return json({ ok: true, cutoff, deleted: rows[0]?.deleted ?? 0 });
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = corsHeaders(originOf(request), env.allowedOrigins);

    if (request.method === 'OPTIONS') return noContent(headers);

    try {
      if (url.pathname === '/cron') return await retention(request);
      if (request.method === 'POST' && url.pathname === '/api/collect') return await collect(request, headers);
      if (request.method === 'POST' && url.pathname === '/api/auth/device') return await deviceCode(headers);
      if (request.method === 'POST' && url.pathname === '/api/auth/token') return await deviceToken(request, headers);
      if (request.method === 'GET' && url.pathname === '/api/stats') return await stats(request, url, headers);
      if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true }, 200, headers);
      return json({ error: 'not found' }, 404, headers);
    } catch (error) {
      console.error('analytics failed', error);
      return json({ error: 'internal error' }, 500, headers);
    }
  }

  return { fetch: handle };
}

export type Analytics = ReturnType<typeof createAnalytics>;
