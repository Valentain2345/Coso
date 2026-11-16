/**
 * Browser OpenTelemetry, loaded only after the visitor accepts analytics.
 *
 * This module is imported with a dynamic `import()` from `telemetry.ts`, so it
 * lands in its own chunk: a visitor who rejects, or who never answers, never
 * downloads the SDK and never runs a performance observer. That is what keeps
 * the "no render-blocking work, no CLS" rule true while still shipping real
 * OTLP data.
 *
 * What is recorded:
 * - one `documentLoad` span with the navigation timings,
 * - one `exception` span per `error` / `unhandledrejection`,
 * - LCP, CLS, INP and TTFB as OTLP gauges on `/v1/metrics`.
 *
 * What is not: cookies, the address, full URLs with query strings, DOM
 * snapshots, network bodies, or anything the native shells could reach — this
 * file is never imported when `isTauri()` is true.
 */

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  WebTracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-web';
import { onCLS, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

import { version } from '../../package.json';
import {
  encodeMetrics,
  encodeTraces,
  dateToNanos,
  exportableFromReadable,
  type Attributes,
  type ExportableMetric,
} from '../../telemetry/otlp';

/** Same value the analytics client uses; `/v1/traces` is appended here. */
export type TelemetrySurface = 'app' | 'site';

const SCOPE = { name: 'coso-web', version };

/** Posts OTLP/JSON and never throws into the page. Exported for the tests. */
export class OtlpHttpExporter implements SpanExporter {
  constructor(
    private readonly endpoint: string,
    private readonly resource: Attributes,
  ) {}

  export(spans: ReadableSpan[], done: (result: { code: number; error?: Error }) => void): void {
    if (spans.length === 0) return done({ code: 0 });
    const body = JSON.stringify(
      encodeTraces({ resource: this.resource, scope: SCOPE, spans: spans.map(exportableFromReadable) }),
    );

    fetch(`${this.endpoint}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }).then(
      (response) => done({ code: response.ok ? 0 : 1 }),
      () => done({ code: 1 }),
    );
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Web vitals leave as OTLP gauges, not spans: they are measurements, and the
 * receiver stores them in `otel_metrics` where the dashboard can percentile
 * them. Points are queued so a page reporting four vitals costs two requests.
 */
function createVitalsReporter(endpoint: string, resource: Attributes) {
  let queue: ExportableMetric[] = [];
  let timer: number | undefined;

  const flush = (sync = false) => {
    if (queue.length === 0) return;
    const metrics = queue;
    queue = [];
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const body = JSON.stringify(encodeMetrics({ resource, scope: SCOPE, metrics }));
    try {
      const request = fetch(`${endpoint}/v1/metrics`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        keepalive: sync,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
      });
      // A pending page unload must not surface as an unhandled rejection.
      void request.catch(() => undefined);
    } catch {
      // A blocked or aborted fetch is not an application error.
    }
  };

  const report = (metric: Metric) => {
    queue.push({
      name: `webvital.${metric.name.toLowerCase()}`,
      unit: metric.name === 'CLS' ? '1' : 'ms',
      kind: 'gauge',
      value: metric.value,
      timeNanos: dateToNanos(Date.now()),
      attributes: { rating: metric.rating, navigation: metric.navigationType },
    });
    if (timer === undefined) timer = window.setTimeout(() => flush(), 1500);
  };

  return { report, flush };
}

/** Absolute URL without its query string: a page path, not a payload. */
function pathOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  try {
    const url = new URL(value, location.href);
    return url.origin === location.origin ? url.pathname : url.host;
  } catch {
    return '';
  }
}

/** `[seconds, nanos]` from a millisecond offset, for explicit span times. */
const toHrTime = (ms: number): [number, number] => [
  Math.max(0, Math.floor(ms / 1000)),
  Math.max(0, Math.round((ms % 1000) * 1e6)),
];

/**
 * Wall-clock start and end of the page load.
 *
 * Navigation Timing reports `startTime`, `loadEventEnd` and `duration` as
 * offsets in milliseconds, while `performance.timeOrigin` is an epoch value.
 * Adding the origin is what keeps `documentLoad` out of 1970.
 */
export function documentLoadWindow(
  navigation: Pick<PerformanceNavigationTiming, 'startTime' | 'loadEventEnd' | 'duration'>,
  timeOrigin: number,
): { startMs: number; endMs: number } {
  return {
    startMs: timeOrigin + (navigation.startTime || 0),
    endMs: timeOrigin + (navigation.loadEventEnd || navigation.duration),
  };
}

let started = false;

/**
 * Starts the SDK, registers it globally (so app code can use the
 * `@opentelemetry/api` tracer) and installs the passive instrumentation.
 */
export function startBrowserTelemetry(options: { endpoint: string; surface: TelemetrySurface }): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  const resourceAttributes: Attributes = {
    'service.name': 'coso-web',
    'service.version': version,
    'deployment.environment': import.meta.env.PROD ? 'production' : 'development',
    'coso.surface': options.surface,
  };
  const resource = resourceFromAttributes(resourceAttributes);

  const provider = new WebTracerProvider({
    resource,
    spanLimits: { attributeCountLimit: 24, attributeValueLengthLimit: 160 },
    spanProcessors: [
      new BatchSpanProcessor(new OtlpHttpExporter(options.endpoint, resourceAttributes), {
        scheduledDelayMillis: 3000,
        maxExportBatchSize: 32,
      }),
    ],
  });
  // Registers the tracer provider, the context manager and the W3C propagator.
  // Nothing auto-instruments `fetch`, so `traceparent` is never attached to a
  // request that leaves for another origin.
  provider.register();

  const tracer = provider.getTracer(SCOPE.name, version);

  // Navigation timings, as one span from time origin to load. The browser
  // reports these as offsets from `timeOrigin`, not from 1970: add it back so
  // the stored span carries the real wall-clock time.
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  if (navigation) {
    const timeOrigin = performance.timeOrigin || Date.now() - performance.now();
    const { startMs, endMs } = documentLoadWindow(navigation, timeOrigin);
    const span = tracer.startSpan('documentLoad', {
      kind: SpanKind.SERVER,
      startTime: toHrTime(startMs),
      attributes: {
        'page.path': location.pathname,
        'navigation.type': navigation.type,
        'navigation.ttfb_ms': Math.round(navigation.responseStart),
        'navigation.dcl_ms': Math.round(navigation.domContentLoadedEventEnd),
        'navigation.transfer_bytes': navigation.transferSize,
      },
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end(toHrTime(endMs));
  }

  // Errors. The message is filtered by the exporter (no query strings, 160
  // characters, no stack), so a thrown object can never dump content.
  const record = (name: string, message: unknown, source: unknown) => {
    const span = tracer.startSpan('exception', { kind: SpanKind.INTERNAL });
    span.setAttribute('error.type', name.slice(0, 60));
    if (typeof message === 'string') span.setAttribute('error.message', message);
    const path = pathOf(source);
    if (path) span.setAttribute('page.path', path);
    span.setStatus({ code: SpanStatusCode.ERROR, message: name.slice(0, 60) });
    span.end();
  };

  window.addEventListener('error', (event) => {
    record(event.error?.name ?? 'Error', event.error?.message ?? event.message, event.filename);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    const name = reason instanceof Error ? reason.name : 'UnhandledRejection';
    const message = reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : '';
    record(name, message, '');
  });

  const vitals = createVitalsReporter(options.endpoint, resourceAttributes);
  onTTFB(vitals.report);
  onLCP(vitals.report);
  onCLS(vitals.report);
  onINP(vitals.report);

  // The last vitals arrive while the page is being hidden: send them then.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    vitals.flush(true);
    void provider.forceFlush().catch(() => undefined);
  });
  window.addEventListener('pagehide', () => vitals.flush(true));
}
