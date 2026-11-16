/**
 * Coso telemetry receiver: an OTLP/HTTP JSON endpoint that stores what it can
 * and reports what it refused.
 *
 * Routes
 *   POST /v1/traces    OTLP traces  (browser page loads, errors, request spans)
 *   POST /v1/metrics   OTLP metrics (web vitals as gauges)
 *   GET  /api/health
 *
 * It is a collector, not an open endpoint: `ALLOWED_ORIGINS` decides which
 * sites may POST, `DNT`/`Sec-GPC` and bots are dropped before parsing, the body
 * is capped, and every field is validated by `telemetry/otlp.ts`. Nothing is
 * ever written from a payload that has not been through that decoder, and no
 * address is stored: the same daily HMAC the collector uses ties a span to a
 * pageview.
 */

import { clientIp, corsHeaders, isBot, json, utcDay, visitorId } from '../../analytics/function/lib';
import { MAX_METRICS, MAX_SPANS, decodeMetrics, decodeTraces, type Surface } from '../otlp';
import { insertMetrics, insertSpans, type Query } from './store';

export const MAX_BODY_BYTES = 64 * 1024;

export interface TelemetryEnv {
  /** Salt for the daily visitor HMAC; the same one the collector uses. */
  hashSecret: string;
  /** Comma-separated origins allowed to POST spans. */
  allowedOrigins: string;
}

export interface TelemetryDeps {
  query: Query;
  env: TelemetryEnv;
  now?: () => number;
}

interface Row {
  [key: string]: unknown;
}

const noContent = (headers: Record<string, string>) => new Response(null, { status: 204, headers });

const surfaceOf = (url: URL): Surface | undefined => {
  const value = url.searchParams.get('surface');
  return value === 'site' || value === 'app' || value === 'server' ? value : undefined;
};

export function createTelemetry(deps: TelemetryDeps) {
  const { env, query } = deps;
  const now = deps.now ?? Date.now;

  /** The body, decompressed if needed, or a response explaining why not. */
  async function readBody(request: Request, headers: Record<string, string>): Promise<string | Response> {
    const encoding = (request.headers.get('content-encoding') ?? 'identity').toLowerCase();
    if (encoding !== 'identity' && encoding !== '') {
      if (encoding !== 'gzip') return json({ error: 'unsupported content-encoding' }, 415, headers);
      if (!request.body) return json({ error: 'invalid body' }, 400, headers);
      try {
        const decompressed = new Response(request.body.pipeThrough(new DecompressionStream('gzip')));
        const text = await decompressed.text();
        return text.length > MAX_BODY_BYTES
          ? json({ error: 'payload too large' }, 413, headers)
          : text;
      } catch {
        return json({ error: 'invalid gzip body' }, 400, headers);
      }
    }

    const text = await request.text();
    return text.length > MAX_BODY_BYTES ? json({ error: 'payload too large' }, 413, headers) : text;
  }

  async function ingest(request: Request, url: URL, headers: Record<string, string>, signal: 'traces' | 'metrics') {
    // Honour the opt-outs on the server too: a proxy or a curious caller can
    // forge a request that the client would never have sent.
    if (request.headers.get('sec-gpc') === '1' || request.headers.get('dnt') === '1') {
      return noContent(headers);
    }

    const userAgent = request.headers.get('user-agent') ?? '';
    if (isBot(userAgent)) return noContent(headers);

    const contentType = (request.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('application/json')) {
      return json({ error: 'content-type must be application/json' }, 415, headers);
    }

    const body = await readBody(request, headers);
    if (body instanceof Response) return body;

    let payload: Row;
    try {
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return json({ error: 'invalid json' }, 400, headers);
      }
      payload = parsed as Row;
    } catch {
      return json({ error: 'invalid json' }, 400, headers);
    }

    const at = now();
    const day = utcDay(new Date(at));
    const context = {
      day,
      visitor: visitorId(env.hashSecret, day, clientIp(request), userAgent),
    };
    const surface = surfaceOf(url);

    if (signal === 'traces') {
      const { spans, rejected } = decodeTraces(payload, { surface, limit: MAX_SPANS });
      const stored = await insertSpans(query, spans, context);
      return json(
        rejected > 0 ? { partialSuccess: { rejectedSpans: rejected, errorMessage: 'invalid or over the limit' } } : {},
        200,
        { ...headers, 'x-coso-stored': String(stored) },
      );
    }

    const { metrics, rejected } = decodeMetrics(payload, { surface, limit: MAX_METRICS });
    const stored = await insertMetrics(query, metrics, context);
    return json(
      rejected > 0 ? { partialSuccess: { rejectedDataPoints: rejected, errorMessage: 'invalid or over the limit' } } : {},
      200,
      { ...headers, 'x-coso-stored': String(stored) },
    );
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const headers = corsHeaders(request.headers.get('origin') ?? '', env.allowedOrigins);

    if (request.method === 'OPTIONS') return noContent(headers);

    try {
      if (request.method === 'POST' && url.pathname === '/v1/traces') {
        return await ingest(request, url, headers, 'traces');
      }
      if (request.method === 'POST' && url.pathname === '/v1/metrics') {
        return await ingest(request, url, headers, 'metrics');
      }
      if (request.method === 'GET' && url.pathname === '/api/health') return json({ ok: true }, 200, headers);
      return json({ error: 'not found' }, 404, headers);
    } catch (error) {
      console.error('telemetry ingest failed', error);
      return json({ error: 'internal error' }, 500, headers);
    }
  }

  return { fetch: handle };
}

export type Telemetry = ReturnType<typeof createTelemetry>;
