import { describe, expect, it } from 'vitest';

import {
  MAX_ATTRIBUTES,
  cleanAttributes,
  cleanAttributeValue,
  decodeMetrics,
  decodeTraces,
  encodeMetrics,
  encodeTraces,
  exportableFromReadable,
  exportableToRow,
  hrTimeToNanos,
  nanosToMs,
  scrubUrls,
} from '../telemetry/otlp';

const TRACE = 'a'.repeat(32);
const SPAN = 'b'.repeat(16);

const span = (overrides: Record<string, unknown> = {}) => ({
  traceId: TRACE,
  spanId: SPAN,
  name: 'documentLoad',
  kind: 1,
  startTimeUnixNano: '1700000000000000000',
  endTimeUnixNano: '1700000000500000000',
  attributes: [],
  status: { code: 1 },
  ...overrides,
});

describe('otlp: privacy rules', () => {
  it('cuts the query string out of a URL but leaves prose alone', () => {
    expect(scrubUrls('https://x.example/a.js?token=1#top')).toBe('https://x.example/a.js');
    expect(scrubUrls('failed at /Coso/app/?q=secret')).toBe('failed at /Coso/app/');
    expect(scrubUrls('not json')).toBe('not json');
    expect(scrubUrls('')).toBe('');
  });

  it('keeps scalars, rounds numbers and drops anything content-sized', () => {
    expect(cleanAttributeValue(true)).toBe(true);
    expect(cleanAttributeValue(1.23456)).toBe(1.235);
    expect(cleanAttributeValue('chrome')).toBe('chrome');
    expect(cleanAttributeValue('x'.repeat(600))).toBeNull();
    expect(cleanAttributeValue({ nested: 1 })).toBeNull();
    expect(cleanAttributeValue([1, 2])).toBeNull();
    expect(cleanAttributeValue(Number.NaN)).toBeNull();
    expect(cleanAttributeValue('   ')).toBeNull();
    expect(cleanAttributeValue('y'.repeat(300))).toHaveLength(160);
  });

  it('drops credentials by key and limits how many attributes survive', () => {
    const attributes = cleanAttributes({
      'page.path': '/Coso/app/',
      authorization: 'Bearer gho_secret',
      'session.id': 'abc',
      'user.email': 'someone@example.com',
      'api_key': 'k',
      'http.request.method': 'GET',
    });
    expect(attributes).toEqual({ 'page.path': '/Coso/app/', 'http.request.method': 'GET' });

    const many = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key_${index}`, index]));
    expect(Object.keys(cleanAttributes(many))).toHaveLength(MAX_ATTRIBUTES);
  });
});

describe('otlp: encoding', () => {
  it('produces the OTLP/JSON shape a collector expects', () => {
    const payload = encodeTraces({
      resource: { 'service.name': 'coso-web', 'service.version': '2.3.0' },
      scope: { name: 'coso-web', version: '2.3.0' },
      spans: [
        {
          traceId: TRACE,
          spanId: SPAN,
          parentSpanId: 'c'.repeat(16),
          name: 'documentLoad',
          kind: 'server',
          startNanos: '1700000000000000000',
          endNanos: '1700000000500000000',
          status: 'ok',
          attributes: { 'page.path': '/Coso/app/', 'navigation.ttfb_ms': 120 },
        },
      ],
    }) as { resourceSpans: Array<Record<string, unknown>> };

    const resource = payload.resourceSpans[0] as {
      resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
      scopeSpans: Array<{ scope: { name: string }; spans: Array<Record<string, unknown>> }>;
    };

    expect(resource.resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'coso-web' } });
    expect(resource.scopeSpans[0].scope.name).toBe('coso-web');

    const encoded = resource.scopeSpans[0].spans[0];
    expect(encoded).toMatchObject({
      traceId: TRACE,
      spanId: SPAN,
      parentSpanId: 'c'.repeat(16),
      name: 'documentLoad',
      kind: 2,
      startTimeUnixNano: '1700000000000000000',
      status: { code: 1 },
    });
    // int64 must be a string and integers must use intValue, per proto3 JSON.
    expect(encoded.attributes).toContainEqual({ key: 'navigation.ttfb_ms', value: { intValue: '120' } });
  });

  it('encodes gauges and sums for /v1/metrics', () => {
    const payload = encodeMetrics({
      resource: { 'service.name': 'coso-web' },
      scope: { name: 'coso-web' },
      metrics: [
        { name: 'webvital.lcp', unit: 'ms', kind: 'gauge', value: 1234.5, timeNanos: '1700000000000000000' },
        { name: 'webvital.cls', unit: '1', kind: 'sum', value: 0.02, timeNanos: '1700000000000000000' },
      ],
    }) as { resourceMetrics: Array<{ scopeMetrics: Array<{ metrics: Array<Record<string, unknown>> }> }> };

    const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics[0]).toMatchObject({ name: 'webvital.lcp', unit: 'ms' });
    expect(metrics[0].gauge).toEqual({
      dataPoints: [{ attributes: [], timeUnixNano: '1700000000000000000', asDouble: 1234.5 }],
    });
    expect(metrics[1].sum).toMatchObject({ isMonotonic: false, aggregationTemporality: 2 });
  });
});

describe('otlp: decoding traces', () => {
  const payload = (spans: unknown[], resourceAttributes: unknown[] = []) => ({
    resourceSpans: [
      {
        resource: { attributes: resourceAttributes },
        scopeSpans: [{ scope: { name: 'coso-web' }, spans }],
      },
    ],
  });

  it('round-trips an encoded span', () => {
    const encoded = encodeTraces({
      resource: { 'service.name': 'coso-web', 'coso.surface': 'app' },
      scope: { name: 'coso-web' },
      spans: [
        {
          traceId: TRACE,
          spanId: SPAN,
          name: 'documentLoad',
          kind: 'server',
          startNanos: '1700000000000000000',
          endNanos: '1700000000500000000',
          status: 'ok',
          attributes: { 'page.path': '/Coso/app/' },
        },
      ],
    });

    const { spans, rejected } = decodeTraces(encoded);
    expect(rejected).toBe(0);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({
      traceId: TRACE,
      spanId: SPAN,
      name: 'documentLoad',
      kind: 'server',
      status: 'ok',
      surface: 'app',
      durationMs: 500,
      scope: 'coso-web',
    });
    expect(spans[0].resource['service.name']).toBe('coso-web');
    // `coso.surface` is a routing hint, not a stored attribute.
    expect(spans[0].resource).not.toHaveProperty('coso.surface');
  });

  it('rejects invalid ids, inverted times and absurd durations', () => {
    const { spans, rejected } = decodeTraces(
      payload([
        span({ traceId: 'not-hex', spanId: SPAN }),
        span({ traceId: TRACE, spanId: 'short' }),
        span({ startTimeUnixNano: '2000', endTimeUnixNano: '1000' }),
        span({ startTimeUnixNano: '1000000000', endTimeUnixNano: '9000000000000' }),
        span({ startTimeUnixNano: 'nope' }),
      ]),
    );
    expect(spans).toHaveLength(0);
    expect(rejected).toBe(5);
  });

  it('caps a payload and reports the rest as rejected', () => {
    const many = Array.from({ length: 130 }, (_, index) => span({ spanId: index.toString(16).padStart(16, '0') }));
    const { spans, rejected } = decodeTraces(payload(many), { limit: 100 });
    expect(spans).toHaveLength(100);
    expect(rejected).toBe(30);
  });

  it('never stores credentials or long strings from an attribute list', () => {
    const { spans } = decodeTraces(
      payload(
        [
          span({
            attributes: [
              { key: 'http.request.method', value: { stringValue: 'POST' } },
              { key: 'authorization', value: { stringValue: 'Bearer gho_x' } },
              { key: 'error.message', value: { stringValue: 'x'.repeat(900) } },
              { key: 'url.full', value: { stringValue: 'https://x.example/a?token=leak' } },
              { key: 'list', value: { arrayValue: { values: [] } } },
            ],
          }),
        ],
        [{ key: 'service.name', value: { stringValue: 'coso-web' } }],
      ),
    );

    expect(spans[0].attributes).toEqual({
      'http.request.method': 'POST',
      // The query string is gone before the value reaches the database.
      'url.full': 'https://x.example/a',
    });
  });

  it('rejects a status message big enough to be a payload', () => {
    const { spans } = decodeTraces(payload([span({ status: { code: 2, message: 'z'.repeat(900) } })]));
    expect(spans[0].status).toBe('error');
    expect(spans[0].statusMessage).toBe('');
  });
});

describe('otlp: decoding metrics', () => {
  const payload = (metrics: unknown[]) => ({
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'service.name', value: { stringValue: 'coso-web' } }] },
        scopeMetrics: [{ scope: { name: 'coso-web' }, metrics }],
      },
    ],
  });

  it('reads gauges and sums', () => {
    const { metrics, rejected } = decodeMetrics(
      payload([
        {
          name: 'webvital.lcp',
          unit: 'ms',
          gauge: { dataPoints: [{ timeUnixNano: '1700000000000000000', asDouble: 1234.5 }] },
        },
        {
          name: 'webvital.cls',
          unit: '1',
          sum: { dataPoints: [{ timeUnixNano: '1700000000000000000', asInt: '3' }] },
        },
      ]),
    );

    expect(rejected).toBe(0);
    expect(metrics).toHaveLength(2);
    expect(metrics[0]).toMatchObject({ name: 'webvital.lcp', kind: 'gauge', value: 1234.5, surface: 'app' });
    expect(metrics[1]).toMatchObject({ name: 'webvital.cls', kind: 'sum', value: 3 });
  });

  it('drops bad names, NaN points and histograms', () => {
    const { metrics, rejected } = decodeMetrics(
      payload([
        { name: '../etc/passwd', gauge: { dataPoints: [{ timeUnixNano: '1700000000000000000', asDouble: 1 }] } },
        { name: 'webvital.inp', gauge: { dataPoints: [{ timeUnixNano: '1700000000000000000', asDouble: Number.NaN }] } },
        { name: 'webvital.ttfb', histogram: { dataPoints: [] } },
      ]),
    );
    expect(metrics).toHaveLength(0);
    expect(rejected).toBe(2);
  });
});

describe('otlp: SDK bridge', () => {
  const readable = {
    name: 'POST /api/collect',
    kind: 1,
    startTime: [1700000000, 0] as [number, number],
    endTime: [1700000000, 250_000_000] as [number, number],
    status: { code: 2, message: 'server error' },
    attributes: { 'http.response.status_code': 500, authorization: 'Bearer x' },
    events: [{ name: 'exception', time: [1700000000, 0] as [number, number], attributes: {} }],
    spanContext: () => ({ traceId: TRACE, spanId: SPAN }),
    parentSpanContext: { spanId: 'd'.repeat(16) },
    resource: { attributes: { 'service.name': 'coso-analytics' } },
  };

  it('maps a finished SDK span to the wire shape', () => {
    const exportable = exportableFromReadable(readable);
    expect(exportable).toMatchObject({
      traceId: TRACE,
      spanId: SPAN,
      parentSpanId: 'd'.repeat(16),
      kind: 'server',
      status: 'error',
      statusMessage: 'server error',
      startNanos: '1700000000000000000',
      endNanos: '1700000000250000000',
    });
    expect(exportable.attributes).toEqual({ 'http.response.status_code': 500 });
    expect(exportable.events?.[0].name).toBe('exception');
  });

  it('turns an SDK span into a row through the same validator', () => {
    const row = exportableToRow(exportableFromReadable(readable), {
      surface: 'server',
      resource: { 'service.name': 'coso-analytics' },
      scope: 'coso-analytics',
    });
    expect(row).toMatchObject({
      name: 'POST /api/collect',
      kind: 'server',
      status: 'error',
      surface: 'server',
      durationMs: 250,
      parentSpanId: 'd'.repeat(16),
      scope: 'coso-analytics',
    });
    expect(row?.attributes).not.toHaveProperty('authorization');
  });
});

describe('otlp: time helpers', () => {
  it('keeps nanosecond precision without floats', () => {
    expect(hrTimeToNanos([1700000000, 250_000_000])).toBe('1700000000250000000');
    expect(hrTimeToNanos([1700000000, 0])).toBe('1700000000000000000');
    expect(nanosToMs('1700000000250000000')).toBe(1700000000250);
    expect(nanosToMs('250000000')).toBe(250);
  });
});
