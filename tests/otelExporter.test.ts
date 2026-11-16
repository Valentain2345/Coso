// @vitest-environment jsdom
import type { ReadableSpan } from '@opentelemetry/sdk-trace-web';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { OtlpHttpExporter } from '../src/lib/otel';

const TRACE = 'a'.repeat(32);
const SPAN = 'b'.repeat(16);

const RESOURCE = { 'service.name': 'coso-web', 'coso.surface': 'app' };

/** Minimal finished span: exactly the fields `exportableFromReadable` reads. */
function makeSpan(overrides: Record<string, unknown> = {}): ReadableSpan {
  return {
    name: 'documentLoad',
    kind: 1, // SpanKind.SERVER in @opentelemetry/api numbering
    startTime: [1_700_000_000, 0],
    endTime: [1_700_000_000, 250_000_000],
    status: { code: 1 },
    attributes: { 'page.path': '/Coso/app/', authorization: 'Bearer gho_secret' },
    events: [],
    spanContext: () => ({ traceId: TRACE, spanId: SPAN }),
    resource: { attributes: { 'service.name': 'coso-web' } },
    ...overrides,
  } as unknown as ReadableSpan;
}

const exporter = () => new OtlpHttpExporter('https://collector.example', RESOURCE);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('otel: browser exporter', () => {
  it('posts OTLP/JSON to /v1/traces without credentials', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetchMock);

    const done = vi.fn();
    exporter().export([makeSpan()], done);
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ code: 0 }));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://collector.example/v1/traces');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(init.keepalive).toBe(true);
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');

    const body = JSON.parse(String(init.body)) as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
        scopeSpans: Array<{
          scope: { name: string };
          spans: Array<{ name: string; kind: number; attributes: Array<{ key: string }> }>;
        }>;
      }>;
    };

    const resource = body.resourceSpans[0];
    expect(resource.resource.attributes).toContainEqual({
      key: 'coso.surface',
      value: { stringValue: 'app' },
    });
    expect(resource.scopeSpans[0].scope.name).toBe('coso-web');

    const span = resource.scopeSpans[0].spans[0];
    expect(span.name).toBe('documentLoad');
    expect(span.kind).toBe(2); // OTLP SPAN_KIND_SERVER
    // A credential-looking key is dropped before it can reach the wire.
    expect(span.attributes.map((attribute) => attribute.key)).toEqual(['page.path']);
  });

  it('reports a transport failure as a failed export', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new Error('offline'))));

    const done = vi.fn();
    exporter().export([makeSpan()], done);
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ code: 1 }));
  });

  it('treats a non-2xx response as a failed export', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 }) as Response));

    const done = vi.fn();
    exporter().export([makeSpan()], done);
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ code: 1 }));
  });

  it('skips the request when there is nothing to send', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const done = vi.fn();
    exporter().export([], done);
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith({ code: 0 }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
