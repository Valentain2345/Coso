import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tracer } from '@opentelemetry/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RETENTION_DAYS, TELEMETRY_RETENTION_DAYS, createAnalytics, type Query } from '../analytics/function/handler';
import {
  acceptLanguage,
  channelOf,
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
  utcDay,
  visitorId,
} from '../analytics/function/lib';

type Row = Record<string, unknown>;
type Canned = { match: RegExp; rows: Row[] };

/** In-memory Postgres double: records every statement and returns canned rows. */
function makeQuery(canned: Canned[] = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query: Query = async (sql, params = []) => {
    calls.push({ sql, params });
    return (canned.find((entry) => entry.match.test(sql))?.rows ?? []) as never;
  };
  return { query, calls };
}

const NOW = Date.parse('2026-11-15T12:00:00Z');
const UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36';
const DAY_MS = 86_400_000;

/**
 * Records what the handler does to a span without starting the SDK. The real
 * provider is covered by `otel.test.ts`; here the question is whether the
 * handler names, attributes and closes its server span correctly.
 */
function tracerSpy() {
  const spans: Array<{
    name: string;
    kind: number | undefined;
    attributes: Row;
    status: Row;
    ended: boolean;
  }> = [];

  const tracer = {
    startActiveSpan(
      name: string,
      optionsOrCallback: unknown,
      maybeCallback?: (span: unknown) => unknown,
    ) {
      const options =
        typeof optionsOrCallback === 'function'
          ? undefined
          : (optionsOrCallback as { kind?: number } | undefined);
      const callback = (
        typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
      ) as (span: unknown) => unknown;

      const record = { name, kind: options?.kind, attributes: {} as Row, status: {} as Row, ended: false };
      spans.push(record);

      const span = {
        setAttributes(values: Row) {
          Object.assign(record.attributes, values);
          return span;
        },
        setAttribute(key: string, value: unknown) {
          record.attributes[key] = value;
          return span;
        },
        setStatus(status: Row) {
          record.status = status;
          return span;
        },
        end() {
          record.ended = true;
        },
      };

      return callback(span);
    },
  } as unknown as Tracer;

  return { tracer, spans };
}

const env = {
  hashSecret: 'test-secret',
  githubClientId: 'Ov23li-test',
  allowedLogins: 'valentain2345, OtherUser',
  allowedOrigins: 'https://valentain2345.github.io,http://localhost:5173',
};

const app = (query: Query, githubFetch?: typeof fetch) =>
  createAnalytics({ query, env, now: () => NOW, githubFetch });

const call = (path: string, init: RequestInit & { ip?: string; ua?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', init.ip ?? '203.0.113.7');
  headers.set('user-agent', init.ua ?? UA);
  return new Request(`https://collector.example${path}`, { ...init, headers });
};

const trigger = (id = 'inv-1', body?: object) =>
  new Request('https://collector.example/cron', {
    method: 'POST',
    headers: { 'x-neon-trigger-invocation-id': id, 'content-type': 'application/json' },
    body: JSON.stringify(
      body ?? {
        version: 1,
        invocation_id: id,
        trigger: { type: 'schedule', id: 'trigger-1', name: 'retention' },
        data: { scheduled_at: '2026-11-15T04:17:00Z' },
      },
    ),
  });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('lib: privacy rules', () => {
  it('keeps only the host of a referrer', () => {
    expect(cleanReferrer('https://news.ycombinator.com/item?id=1')).toBe('news.ycombinator.com');
    expect(cleanReferrer('NEWS.ycombinator.com')).toBe('news.ycombinator.com');
    expect(cleanReferrer('not a url')).toBe('');
    expect(cleanReferrer(undefined)).toBe('');
  });

  it('strips query, hash and control characters from paths', () => {
    expect(cleanPath('/Coso/app/?a=1#top')).toBe('/Coso/app/');
    expect(cleanPath('app')).toBe('/app');
    expect(cleanPath('')).toBe('/');
    expect(cleanPath(`/${'a'.repeat(400)}`)).toHaveLength(200);
  });

  it('reduces utm_source and event names to slugs', () => {
    expect(cleanSource('Hacker News!')).toBe('hacker-news');
    expect(cleanSource('https://spam.example/')).toBe('https-spam.example');
    expect(cleanEvent('Download')).toBe('download');
    expect(cleanEvent('')).toBe('pageview');
    expect(cleanEvent('  ')).toBe('pageview');
    expect(cleanEvent('a'.repeat(80))).toHaveLength(40);
  });

  it('drops URLs, long strings and nested props', () => {
    const props = cleanProps({
      file: 'Coso.apk',
      url: 'https://x.example/y',
      note: 'x'.repeat(80),
      nested: { a: 1 },
      list: [1, 2],
      ratio: 1.2345,
      ok: true,
      extra: 'one too many',
    });
    expect(props).toEqual({ file: 'Coso.apk', ratio: 1.23, ok: true });
    expect(cleanProps(null)).toBeNull();
    expect(cleanProps({})).toBeNull();
    expect(cleanProps('text')).toBeNull();
  });

  it('clamps engagement to one hour', () => {
    expect(cleanDuration(7.6)).toBe(8);
    expect(cleanDuration(-4)).toBe(0);
    expect(cleanDuration(99_999)).toBe(3600);
    expect(cleanDuration('nope')).toBe(0);
  });

  it('classifies devices, browsers and systems', () => {
    expect(classifyDevice('Mozilla/5.0 (iPhone) Mobile')).toBe('mobile');
    expect(classifyDevice('Mozilla/5.0 (iPad)')).toBe('tablet');
    expect(classifyDevice('Mozilla/5.0 (X11; Linux x86_64)')).toBe('desktop');
    expect(classifyBrowser('Mozilla/5.0 Edg/141.0')).toBe('Edge');
    expect(classifyBrowser('Mozilla/5.0 OPR/9.0')).toBe('Opera');
    expect(classifyBrowser('Mozilla/5.0 SamsungBrowser/2.0')).toBe('Samsung');
    expect(classifyBrowser('Mozilla/5.0 FxiOS/141.0')).toBe('Firefox');
    expect(classifyBrowser('Mozilla/5.0 Chrome/141.0')).toBe('Chrome');
    expect(classifyOs('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)')).toBe('macOS');
  });

  it('reads only the primary Accept-Language tag', () => {
    expect(acceptLanguage('es-ES,es;q=0.9,en;q=0.8')).toBe('es');
    expect(acceptLanguage('EN-US')).toBe('en');
    expect(acceptLanguage('')).toBe('');
    expect(acceptLanguage('*')).toBe('');
    expect(acceptLanguage(null)).toBe('');
  });

  it('drops known bots and empty agents', () => {
    expect(isBot('Googlebot/2.1')).toBe(true);
    expect(isBot('curl/8.0')).toBe(true);
    expect(isBot('')).toBe(true);
    expect(isBot('Mozilla/5.0 Chrome/141.0')).toBe(false);
  });

  it('only accepts the two surfaces', () => {
    expect(cleanSurface('app')).toBe('app');
    expect(cleanSurface('admin')).toBe('site');
  });

  it('derives the visitor id from secret, day, ip and user agent', () => {
    const first = visitorId('s', '2026-11-15', '203.0.113.7', 'UA');
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(visitorId('s', '2026-11-15', '203.0.113.7', 'UA')).toBe(first);
    expect(visitorId('s', '2026-11-15', '203.0.113.8', 'UA')).not.toBe(first);
    expect(visitorId('s', '2026-11-16', '203.0.113.7', 'UA')).not.toBe(first);
    expect(visitorId('t', '2026-11-15', '203.0.113.7', 'UA')).not.toBe(first);
  });
});

describe('lib: channels and access', () => {
  it('buckets acquisition like every other analytics tool', () => {
    expect(channelOf('', '')).toBe('Direct');
    expect(channelOf('any.example', 'newsletter')).toBe('Campaign');
    expect(channelOf('valentain2345.github.io', '')).toBe('Internal');
    expect(channelOf('www.google.es', '')).toBe('Search');
    expect(channelOf('duckduckgo.com', '')).toBe('Search');
    expect(channelOf('old.reddit.com', '')).toBe('Social');
    expect(channelOf('blog.example.org', '')).toBe('Referral');
  });

  it('aggregates referrers into sorted channels', () => {
    expect(
      channelsOf([
        { referrer: 'www.google.com', source: '', views: 5 },
        { referrer: 'news.ycombinator.com', source: '', views: 3 },
        { referrer: '', source: '', views: 4 },
        { referrer: '', source: 'newsletter', views: 2 },
      ]),
    ).toEqual([
      { channel: 'Search', views: 5 },
      { channel: 'Direct', views: 4 },
      { channel: 'Social', views: 3 },
      { channel: 'Campaign', views: 2 },
    ]);
  });

  it('matches the allowlist case-insensitively', () => {
    expect(isAllowedLogin('Valentain2345', 'valentain2345,other')).toBe(true);
    expect(isAllowedLogin('other', 'valentain2345, OTHER ')).toBe(true);
    expect(isAllowedLogin('intruder', 'valentain2345')).toBe(false);
    expect(isAllowedLogin('', 'valentain2345')).toBe(false);
    expect(isAllowedLogin('anyone', '')).toBe(false);
  });

  it('reflects only owned origins in CORS', () => {
    const allowed = corsHeaders('https://valentain2345.github.io', 'https://valentain2345.github.io');
    expect(allowed['Access-Control-Allow-Origin']).toBe('https://valentain2345.github.io');
    expect(corsHeaders('https://evil.example', 'https://valentain2345.github.io')).not.toHaveProperty(
      'Access-Control-Allow-Origin',
    );
    expect(corsHeaders('', '')).not.toHaveProperty('Access-Control-Allow-Origin');
  });
});

describe('function: collection', () => {
  it('stores a pageview without the IP address', async () => {
    const { query, calls } = makeQuery();
    const day = utcDay(new Date(NOW));
    const response = await app(query).fetch(
      call('/api/collect', {
        method: 'POST',
        headers: { 'accept-language': 'es-ES,es;q=0.9' },
        body: JSON.stringify({ s: 'app', p: '/Coso/app/?q=1', r: 'https://news.ycombinator.com/x', m: 'Launch' }),
      }),
    );

    expect(response.status).toBe(204);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('INSERT INTO hits');
    const args = calls[0].params;
    expect(args).toHaveLength(14);
    expect(args).not.toContain('203.0.113.7');
    expect(args.slice(0, 8)).toEqual([
      Math.floor(NOW / 1000),
      day,
      'app',
      '/Coso/app/',
      'news.ycombinator.com',
      'launch',
      'pageview',
      '{}',
    ]);
    expect(args[8]).toBe(0);
    expect(args.slice(9)).toEqual([
      'es',
      'desktop',
      'Chrome',
      'Windows',
      visitorId('test-secret', day, '203.0.113.7', UA),
    ]);
  });

  it('honours DNT, GPC and bots before touching the database', async () => {
    const dnt = makeQuery();
    const gpc = makeQuery();
    const bot = makeQuery();

    const run = async (ctx: ReturnType<typeof makeQuery>, init: RequestInit & { ua?: string }) =>
      app(ctx.query).fetch(call('/api/collect', { method: 'POST', body: '{}', ...init }));

    expect((await run(dnt, { headers: { dnt: '1' } })).status).toBe(204);
    expect((await run(gpc, { headers: { 'sec-gpc': '1' } })).status).toBe(204);
    expect((await run(bot, { ua: 'Googlebot/2.1' })).status).toBe(204);

    expect(dnt.calls).toHaveLength(0);
    expect(gpc.calls).toHaveLength(0);
    expect(bot.calls).toHaveLength(0);
  });

  it('rejects malformed and oversized payloads', async () => {
    const { query } = makeQuery();
    const send = (body: string) => app(query).fetch(call('/api/collect', { method: 'POST', body }));

    expect((await send('not json')).status).toBe(400);
    expect((await send('[]')).status).toBe(400);
    expect((await send('x'.repeat(3000))).status).toBe(413);
  });

  it('records custom events and clamps engagement', async () => {
    const { query, calls } = makeQuery();
    const send = (body: object) =>
      app(query).fetch(call('/api/collect', { method: 'POST', body: JSON.stringify(body) }));

    await send({ e: 'Download', x: { file: 'Coso.apk' }, d: 99_999 });
    await send({ e: 'engagement', d: 12.4 });

    expect(calls[0].params[6]).toBe('download');
    expect(calls[0].params[7]).toBe('{"file":"Coso.apk"}');
    expect(calls[0].params[8]).toBe(0);
    expect(calls[1].params[6]).toBe('engagement');
    expect(calls[1].params[8]).toBe(12);
  });
});

describe('function: health, CORS and routes', () => {
  it('answers the health check and rejects unknown routes', async () => {
    const { query } = makeQuery();
    const health = await app(query).fetch(call('/api/health'));
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect((await app(query).fetch(call('/nope'))).status).toBe(404);
  });

  it('answers preflight for owned origins only', async () => {
    const { query } = makeQuery();
    const allowed = await app(query).fetch(
      call('/api/collect', { method: 'OPTIONS', headers: { origin: 'https://valentain2345.github.io' } }),
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://valentain2345.github.io');

    const denied = await app(query).fetch(
      call('/api/collect', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }),
    );
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('never leaks a stack trace from an internal failure', async () => {
    const query: Query = async () => {
      throw new Error('connection terminated');
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await app(query).fetch(
      call('/api/collect', { method: 'POST', body: JSON.stringify({ p: '/' }) }),
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal error' });
  });
});

describe('function: GitHub device flow', () => {
  it('starts a login without sending a client secret', async () => {
    const { query } = makeQuery();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      expect(body.client_id).toBe('Ov23li-test');
      expect(body).not.toHaveProperty('client_secret');
      return Response.json({
        device_code: 'dev',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      });
    }) as unknown as typeof fetch;

    const response = await app(query, fetchMock).fetch(
      call('/api/auth/device', { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ device_code: 'dev', user_code: 'ABCD-1234' });
  });

  it('maps a pending device code to a retryable error', async () => {
    const { query } = makeQuery();
    const fetchMock = vi.fn(async () => Response.json({ error: 'authorization_pending' })) as unknown as typeof fetch;

    const response = await app(query, fetchMock).fetch(
      call('/api/auth/token', { method: 'POST', body: JSON.stringify({ device_code: 'dev' }) }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'authorization_pending' });
  });

  it('returns the token once approved', async () => {
    const { query } = makeQuery();
    const fetchMock = vi.fn(async () => Response.json({ access_token: 'gho_test' })) as unknown as typeof fetch;
    const response = await app(query, fetchMock).fetch(
      call('/api/auth/token', { method: 'POST', body: JSON.stringify({ device_code: 'dev' }) }),
    );
    expect(await response.json()).toEqual({ token: 'gho_test' });
  });

  it('rejects a token request without a device code', async () => {
    const { query } = makeQuery();
    const response = await app(query).fetch(call('/api/auth/token', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(400);
  });

  it('refuses to start a login when the client id is missing', async () => {
    const { query } = makeQuery();
    const without = createAnalytics({ query, env: { ...env, githubClientId: '' }, now: () => NOW });
    const response = await without.fetch(call('/api/auth/device', { method: 'POST', body: '{}' }));
    expect(response.status).toBe(503);
  });
});

describe('function: stats', () => {
  const canned: Canned[] = [
    {
      match: /SELECT COUNT\(\*\)::int AS views, COUNT\(DISTINCT visitor\)::int AS visitors FROM hits/,
      rows: [{ views: 4, visitors: 3 }],
    },
    { match: /AS bouncers/, rows: [{ bouncers: 2 }] },
    { match: /AS samples, AVG\(value\)::float AS seconds/, rows: [{ samples: 4, seconds: 12.6 }] },
    { match: /to_char\(day/, rows: [{ day: '2026-11-14', views: 3, visitors: 2 }] },
    { match: /GROUP BY path/, rows: [{ path: '/Coso/app/', views: 3, visitors: 2 }] },
    {
      match: /GROUP BY referrer, source/,
      rows: [
        { referrer: 'www.google.com', source: '', views: 3 },
        { referrer: '', source: 'newsletter', views: 1 },
      ],
    },
    { match: /GROUP BY language/, rows: [{ language: 'es', views: 4 }] },
    { match: /GROUP BY device/, rows: [{ device: 'mobile', views: 4 }] },
    { match: /GROUP BY browser/, rows: [{ browser: 'Chrome', views: 4 }] },
    { match: /GROUP BY os/, rows: [{ os: 'Android', views: 4 }] },
    { match: /GROUP BY surface/, rows: [{ surface: 'app', views: 4 }] },
    {
      match: /event NOT IN/,
      rows: [{ event: 'download', views: 2, visitors: 2, seconds: 0 }],
    },
  ];

  const statsRequest = (headers: Record<string, string> = {}, query = '') =>
    call(`/api/stats${query}`, { headers });

  it('refuses requests without a valid GitHub token', async () => {
    const { query } = makeQuery(canned);
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const response = await app(query, fetchMock).fetch(statsRequest({ authorization: 'Bearer bad' }));
    expect(response.status).toBe(403);
  });

  it('refuses GitHub accounts outside the allowlist', async () => {
    const { query } = makeQuery(canned);
    const fetchMock = vi.fn(async () => Response.json({ login: 'intruder' })) as unknown as typeof fetch;
    const response = await app(query, fetchMock).fetch(statsRequest({ authorization: 'Bearer ok' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
  });

  it('returns the full breakdown for an allowlisted login', async () => {
    const { query, calls } = makeQuery(canned);
    const fetchMock = vi.fn(async () => Response.json({ login: 'Valentain2345' })) as unknown as typeof fetch;

    const response = await app(query, fetchMock).fetch(
      statsRequest({ authorization: 'Bearer good-7d' }, '?days=7&surface=app'),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Row & { totals: Row; channels: Row[]; events: Row[] };

    expect(body).toMatchObject({ login: 'Valentain2345', days: 7, surface: 'app' });
    expect(body.totals).toEqual({
      views: 4,
      visitors: 3,
      bouncers: 2,
      engagementSamples: 4,
      engagementSeconds: 13,
    });
    expect(body.channels).toEqual([
      { channel: 'Search', views: 3 },
      { channel: 'Campaign', views: 1 },
    ]);
    expect(body.events[0].event).toBe('download');

    // The surface filter has to reach every pageview query.
    const pageviewQueries = calls.filter((entry) => entry.sql.includes("event = 'pageview'"));
    expect(pageviewQueries.length).toBeGreaterThan(5);
    for (const statement of pageviewQueries) {
      expect(statement.sql).toContain('AND surface = $2');
      expect(statement.params).toHaveLength(2);
      expect(statement.params[1]).toBe('app');
    }
  });

  it('caps the range and defaults the surface to everything', async () => {
    const { query, calls } = makeQuery(canned);
    const fetchMock = vi.fn(async () => Response.json({ login: 'valentain2345' })) as unknown as typeof fetch;
    const body = (await (
      await app(query, fetchMock).fetch(statsRequest({ authorization: 'Bearer good-cap' }, '?days=9999'))
    ).json()) as { days: number; surface: string };

    expect(body.days).toBe(365);
    expect(body.surface).toBe('all');
    const pageviewQueries = calls.filter((entry) => entry.sql.includes("event = 'pageview'"));
    for (const statement of pageviewQueries) {
      expect(statement.sql).not.toContain('surface = $2');
      expect(statement.params).toHaveLength(1);
    }
  });

  it('defaults to thirty days when the range is nonsense', async () => {
    const { query } = makeQuery(canned);
    const fetchMock = vi.fn(async () => Response.json({ login: 'valentain2345' })) as unknown as typeof fetch;
    const body = (await (
      await app(query, fetchMock).fetch(statsRequest({ authorization: 'Bearer good-nan' }, '?days=abc'))
    ).json()) as { days: number };
    expect(body.days).toBe(30);
  });
});

describe('function: telemetry', () => {
  const canned: Canned[] = [
    {
      match: /FROM otel_metrics\s+WHERE day >= \$1::date AND name LIKE 'webvital\.%'/,
      rows: [
        { name: 'webvital.cls', p50: 0.012, p75: 0.0234, p95: 0.08, samples: 4, good: 3 },
        { name: 'webvital.lcp', p50: 1200, p75: 2100, p95: 2600, samples: 4, good: 3 },
      ],
    },
    {
      match: /FROM otel_spans\s+WHERE day >= \$1::date AND status = 'error'/,
      rows: [{ name: 'exception', message: 'boom', count: 2, last_seen: '2026-11-15T10:00:00Z' }],
    },
    { match: /kind = 'server'/, rows: [{ name: 'GET /api/stats', status: 'ok', count: 5, p75: 120.44 }] },
    { match: /ORDER BY duration_ms/, rows: [{ name: 'GET /api/stats', count: 5, p75: 120.44, worst: 300 }] },
    { match: /SELECT \(SELECT COUNT\(\*\)::int FROM otel_spans/, rows: [{ spans: 9, metrics: 4 }] },
  ];

  const telemetryRequest = (query = '', headers: Record<string, string> = {}) =>
    call(`/api/telemetry${query}`, { headers });

  it('refuses the endpoint without a token, before touching the database', async () => {
    const { query, calls } = makeQuery(canned);
    const response = await app(query).fetch(telemetryRequest());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a token GitHub rejects', async () => {
    const { query } = makeQuery(canned);
    const fetchMock = vi.fn(async () => new Response('nope', { status: 401 })) as unknown as typeof fetch;
    const response = await app(query, fetchMock).fetch(
      telemetryRequest('', { authorization: 'Bearer revoked-telemetry' }),
    );
    expect(response.status).toBe(403);
  });

  it('returns vitals, errors, slow spans and requests for an allowlisted login', async () => {
    const { query, calls } = makeQuery(canned);
    const fetchMock = vi.fn(async () => Response.json({ login: 'valentain2345' })) as unknown as typeof fetch;

    const response = await app(query, fetchMock).fetch(
      telemetryRequest('?days=7&surface=app', { authorization: 'Bearer good-telemetry' }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Row & {
      vitals: Row[];
      errors: Row[];
      slowest: Row[];
      requests: Row[];
      volume: Row;
    };

    expect(body).toMatchObject({ login: 'valentain2345', days: 7, surface: 'app' });
    expect(body.vitals).toEqual([
      { name: 'webvital.cls', p50: 0.01, p75: 0.02, p95: 0.08, samples: 4, good: 3 },
      { name: 'webvital.lcp', p50: 1200, p75: 2100, p95: 2600, samples: 4, good: 3 },
    ]);
    expect(body.errors[0]).toMatchObject({ name: 'exception', message: 'boom', count: 2 });
    expect(body.slowest[0]).toMatchObject({ name: 'GET /api/stats', count: 5, p75: 120.44, worst: 300 });
    expect(body.requests[0]).toMatchObject({ name: 'GET /api/stats', status: 'ok', count: 5, p75: 120.44 });
    expect(body.volume).toEqual({ spans: 9, metrics: 4 });

    // The surface filter has to reach all five telemetry queries.
    const telemetryQueries = calls.filter((entry) => /otel_(spans|metrics)/.test(entry.sql));
    expect(telemetryQueries).toHaveLength(5);
    for (const statement of telemetryQueries) {
      expect(statement.sql).toContain('surface = $2');
      expect(statement.params).toEqual([utcDay(new Date(NOW - 6 * DAY_MS)), 'app']);
    }
  });

  it('defaults to thirty days and every surface', async () => {
    const { query, calls } = makeQuery(canned);
    const fetchMock = vi.fn(async () => Response.json({ login: 'valentain2345' })) as unknown as typeof fetch;

    const body = (await (
      await app(query, fetchMock).fetch(
        telemetryRequest('?days=abc', { authorization: 'Bearer good-telemetry-default' }),
      )
    ).json()) as { days: number; surface: string };

    expect(body.days).toBe(30);
    expect(body.surface).toBe('all');

    const telemetryQueries = calls.filter((entry) => /otel_(spans|metrics)/.test(entry.sql));
    for (const statement of telemetryQueries) {
      expect(statement.sql).not.toContain('surface = $2');
      expect(statement.params).toHaveLength(1);
    }
  });
});

describe('function: tracing', () => {
  it('wraps a request in one named server span', async () => {
    const { query } = makeQuery();
    const { tracer, spans } = tracerSpy();

    const response = await createAnalytics({ query, env, now: () => NOW, tracer }).fetch(
      call('/api/health'),
    );

    expect(response.status).toBe(200);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      name: 'GET /api/health',
      kind: 1, // SpanKind.SERVER
      ended: true,
      attributes: {
        'http.request.method': 'GET',
        'url.path': '/api/health',
        'coso.surface': 'server',
        'http.response.status_code': 200,
      },
    });
    // 2xx is not an error, so no status is set at all.
    expect(spans[0].status).toEqual({});
  });

  it('marks a 500 as an error span and keeps the handler response', async () => {
    const query: Query = async () => {
      throw new Error('connection terminated');
    };
    const { tracer, spans } = tracerSpy();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = await createAnalytics({ query, env, now: () => NOW, tracer }).fetch(
      call('/api/collect', { method: 'POST', body: JSON.stringify({ p: '/' }) }),
    );

    expect(response.status).toBe(500);
    expect(spans[0].attributes['http.response.status_code']).toBe(500);
    expect(spans[0].status).toEqual({ code: 2, message: 'server error' }); // SpanStatusCode.ERROR
    expect(spans[0].ended).toBe(true);
  });

  it('gives unknown paths a fixed label, never the raw URL', async () => {
    const { query } = makeQuery();
    const { tracer, spans } = tracerSpy();

    await createAnalytics({ query, env, now: () => NOW, tracer }).fetch(call('/admin/secret?x=1'));

    expect(spans[0].name).toBe('http.request');
    expect(spans[0].attributes['url.path']).toBe('/admin/secret');
  });

  it('does not trace preflight', async () => {
    const { query } = makeQuery();
    const { tracer, spans } = tracerSpy();

    await createAnalytics({ query, env, now: () => NOW, tracer }).fetch(
      call('/api/collect', { method: 'OPTIONS' }),
    );

    expect(spans).toHaveLength(0);
  });
});

describe('function: retention', () => {
  it('deletes rows past the retention window for a real trigger delivery', async () => {
    const { query, calls } = makeQuery([{ match: /WITH deleted/, rows: [{ deleted: 7 }] }]);
    const response = await app(query).fetch(trigger());

    expect(response.status).toBe(200);
    expect(calls[0].sql).toContain('DELETE FROM hits WHERE day < $1::date');
    expect(calls[0].params[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await response.json()).toMatchObject({ ok: true, deleted: 7 });
  });

  it('sweeps pageviews and telemetry on their own windows', async () => {
    const { query, calls } = makeQuery([
      { match: /DELETE FROM hits/, rows: [{ deleted: 3 }] },
      { match: /DELETE FROM otel_spans/, rows: [{ deleted: 5 }] },
      { match: /DELETE FROM otel_metrics/, rows: [{ deleted: 8 }] },
    ]);

    const response = await app(query).fetch(trigger());
    expect(response.status).toBe(200);

    const body = (await response.json()) as Row;
    expect(body).toMatchObject({
      ok: true,
      deleted: 3,
      deletedSpans: 5,
      deletedMetrics: 8,
    });
    expect(body.cutoff).toBe(utcDay(new Date(NOW - RETENTION_DAYS * DAY_MS)));
    expect(body.telemetryCutoff).toBe(utcDay(new Date(NOW - TELEMETRY_RETENTION_DAYS * DAY_MS)));

    const tables = calls.map((entry) => entry.sql);
    expect(tables.some((sql) => sql.includes('DELETE FROM hits'))).toBe(true);
    expect(tables.some((sql) => sql.includes('DELETE FROM otel_spans WHERE day < $1::date'))).toBe(true);
    expect(tables.some((sql) => sql.includes('DELETE FROM otel_metrics WHERE day < $1::date'))).toBe(true);

    const telemetry = calls.filter((entry) => /otel_(spans|metrics)/.test(entry.sql));
    for (const statement of telemetry) {
      expect(statement.params).toEqual([utcDay(new Date(NOW - TELEMETRY_RETENTION_DAYS * DAY_MS))]);
    }
  });

  it('rejects a plain POST with no trigger header', async () => {
    const { query, calls } = makeQuery();
    const response = await app(query).fetch(
      new Request('https://collector.example/cron', { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('rejects a delivery whose ids disagree', async () => {
    const { query, calls } = makeQuery();
    const response = await app(query).fetch(
      trigger('header-id', {
        version: 1,
        invocation_id: 'body-id',
        trigger: { type: 'schedule', id: 'trigger-1', name: 'retention' },
        data: { scheduled_at: '2026-11-15T04:17:00Z' },
      }),
    );
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });
});

describe('function: schema', () => {
  it('ships the columns the handler writes', () => {
    const sql = readFileSync(resolve('analytics/function/schema.sql'), 'utf8');
    for (const column of [
      'ts',
      'day',
      'surface',
      'path',
      'referrer',
      'source',
      'event',
      'props',
      'value',
      'language',
      'device',
      'browser',
      'os',
      'visitor',
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(sql).not.toMatch(/\bcountry\b/i);
    // No address column: an IP is only ever an HMAC input, never a stored value.
    expect(sql).not.toMatch(/^\s*(ip|ip_address|remote_addr)\s/im);
  });
});
