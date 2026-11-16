import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_BODY_BYTES, createTelemetry } from '../telemetry/function/handler';
import type { Query } from '../telemetry/function/store';
import { encodeMetrics } from '../telemetry/otlp';

type Row = Record<string, unknown>;
type Call = { sql: string; params: unknown[] };

function makeQuery(canned: Array<{ match: RegExp; rows: Row[] }> = []) {
  const calls: Call[] = [];
  const query: Query = async (sql, params = []) => {
    calls.push({ sql, params });
    return (canned.find((entry) => entry.match.test(sql))?.rows ?? []) as never;
  };
  return { query, calls };
}

const NOW = Date.parse('2026-11-15T12:00:00Z');
const UA = 'Mozilla/5.0 (Windows NT 10.0) Chrome/141.0.0.0 Safari/537.36';

const env = {
  hashSecret: 'test-secret',
  allowedOrigins: 'https://valentain2345.github.io,http://localhost:5173',
};

const app = (query: Query) => createTelemetry({ query, env, now: () => NOW });

const request = (path: string, init: RequestInit & { ip?: string; ua?: string } = {}) => {
  const headers = new Headers(init.headers);
  headers.set('x-forwarded-for', init.ip ?? '203.0.113.7');
  headers.set('user-agent', init.ua ?? UA);
  if (!headers.has('origin')) headers.set('origin', 'https://valentain2345.github.io');
  return new Request(`https://telemetry.example${path}`, { ...init, headers });
};

const json = (path: string, body: unknown, extra: Record<string, string> = {}) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });

const tracesPayload = (count = 1) => ({
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'coso.surface', value: { stringValue: 'app' } }] },
      scopeSpans: [
        {
          scope: { name: 'coso-web' },
          spans: Array.from({ length: count }, (_, index) => ({
            traceId: 'a'.repeat(32),
            spanId: index.toString(16).padStart(16, '0'),
            name: 'documentLoad',
            kind: 1,
            startTimeUnixNano: '1700000000000000000',
            endTimeUnixNano: '1700000000500000000',
            attributes: [{ key: 'page.path', value: { stringValue: '/Coso/app/' } }],
            status: { code: 1 },
          })),
        },
      ],
    },
  ],
});

const metricsPayload = (value = 1234) =>
  encodeMetrics({
    resource: { 'service.name': 'coso-web', 'coso.surface': 'app' },
    scope: { name: 'coso-web' },
    metrics: [{ name: 'webvital.lcp', unit: 'ms', kind: 'gauge', value, timeNanos: '1700000000000000000' }],
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('telemetry: collection rules', () => {
  it('stores a span and returns an empty OTLP response', async () => {
    const { query, calls } = makeQuery();
    const response = await app(query).fetch(json('/v1/traces', tracesPayload()));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('INSERT INTO otel_spans');

    const params = calls[0].params;
    expect(params).toHaveLength(15);
    expect(params).not.toContain('203.0.113.7');
    expect(params[1]).toBe('2026-11-15');
    expect(params[2]).toBe('a'.repeat(32));
    expect(params[6]).toBe('internal');
    expect(params[7]).toBe('app');
    expect(params[8]).toBe(500);
    expect(params[9]).toBe('ok');
    expect(params[11]).toBe('{"page.path":"/Coso/app/"}');
    expect(String(params[14])).toMatch(/^[0-9a-f]{16}$/);
  });

  it('stores a metric point', async () => {
    const { query, calls } = makeQuery();
    const response = await app(query).fetch(json('/v1/metrics', metricsPayload()));

    expect(response.status).toBe(200);
    expect(calls[0].sql).toContain('INSERT INTO otel_metrics');
    const params = calls[0].params;
    expect(params).toHaveLength(11);
    expect(params[2]).toBe('webvital.lcp');
    expect(params[3]).toBe('ms');
    expect(params[5]).toBe('app');
    expect(params[6]).toBe(1234);
  });

  it('reports what it refused instead of failing the batch', async () => {
    const { query, calls } = makeQuery();
    const response = await app(query).fetch(json('/v1/traces', tracesPayload(150)));

    expect(response.status).toBe(200);
    expect(calls[0].params).toHaveLength(15 * 100);
    expect(await response.json()).toEqual({
      partialSuccess: { rejectedSpans: 50, errorMessage: 'invalid or over the limit' },
    });
  });

  it('honours DNT, GPC and bots before parsing', async () => {
    const dnt = makeQuery();
    const gpc = makeQuery();
    const bot = makeQuery();

    expect((await app(dnt.query).fetch(json('/v1/traces', tracesPayload(), { dnt: '1' }))).status).toBe(204);
    expect((await app(gpc.query).fetch(json('/v1/traces', tracesPayload(), { 'sec-gpc': '1' }))).status).toBe(204);
    expect(
      (await app(bot.query).fetch(request('/v1/traces', { method: 'POST', body: '{}', ua: 'Googlebot/2.1' })))
        .status,
    ).toBe(204);

    expect(dnt.calls).toHaveLength(0);
    expect(gpc.calls).toHaveLength(0);
    expect(bot.calls).toHaveLength(0);
  });

  it('rejects the wrong content type, oversized bodies and malformed JSON', async () => {
    const { query, calls } = makeQuery();
    const fetcher = app(query);

    const wrong = await fetcher.fetch(
      request('/v1/traces', { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body: 'x' }),
    );
    expect(wrong.status).toBe(415);

    const huge = await fetcher.fetch(json('/v1/traces', { padding: 'x'.repeat(MAX_BODY_BYTES) }));
    expect(huge.status).toBe(413);

    const broken = await fetcher.fetch(
      request('/v1/traces', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' }),
    );
    expect(broken.status).toBe(400);

    expect(calls).toHaveLength(0);
  });

  it('accepts gzip bodies from a standard OTLP exporter', async () => {
    const { query, calls } = makeQuery();
    const response = await app(query).fetch(
      request('/v1/traces', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
        body: gzipSync(JSON.stringify(tracesPayload())),
      }),
    );

    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].params[2]).toBe('a'.repeat(32));
  });

  it('lets the query string pick the surface', async () => {
    const { query, calls } = makeQuery();
    await app(query).fetch(json('/v1/traces?surface=site', tracesPayload()));
    expect(calls[0].params[7]).toBe('site');
  });
});

describe('telemetry: routes', () => {
  it('answers preflight for owned origins only', async () => {
    const { query } = makeQuery();
    const fetcher = app(query);

    const allowed = await fetcher.fetch(
      request('/v1/traces', { method: 'OPTIONS', headers: { origin: 'https://valentain2345.github.io' } }),
    );
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://valentain2345.github.io');

    const denied = await fetcher.fetch(
      request('/v1/traces', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }),
    );
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers health and refuses unknown routes', async () => {
    const { query } = makeQuery();
    expect(await (await app(query).fetch(request('/api/health'))).json()).toEqual({ ok: true });
    expect((await app(query).fetch(request('/v1/logs'))).status).toBe(404);
  });

  it('never leaks a stack trace', async () => {
    const query = async () => {
      throw new Error('connection terminated');
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await app(query as never).fetch(json('/v1/traces', tracesPayload()));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal error' });
  });
});

describe('telemetry: schema', () => {
  it('ships both tables with no address column', () => {
    const sql = readFileSync('telemetry/schema.sql', 'utf8');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS otel_spans');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS otel_metrics');
    expect(sql).not.toMatch(/^\s*(ip|ip_address|remote_addr)\s/im);
  });
});
