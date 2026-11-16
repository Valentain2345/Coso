/**
 * Server-side OpenTelemetry for the analytics Function.
 *
 * The SDK does the hard part (ids, sampling, batching, limits); the exporter is
 * ours so spans land in the same Postgres database as everything else instead
 * of crossing to a third-party processor. That keeps one retention rule, one
 * privacy story and no new account or API key.
 *
 * Spans go through `toSpanRow`, the same validator the public OTLP receiver
 * uses, so a server span can never contain something a browser payload could
 * not. `forceFlush()` is awaited after every response through `waitUntil`, so a
 * short-lived isolate still ships what it recorded.
 */

import type { Tracer } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';

import { insertSpans, type Query } from '../../telemetry/function/store';
import { exportableFromReadable, exportableToRow, resourceAttributesOf, type SpanRow } from '../../telemetry/otlp';
import { utcDay } from './lib';

export interface ServerTelemetry {
  tracer: Tracer;
  /** Ships whatever is still buffered; safe to call after the response. */
  forceFlush: () => Promise<void>;
}

/** Writes spans straight into `otel_spans`, grouped by UTC day. */
class PostgresSpanExporter implements SpanExporter {
  constructor(private readonly query: Query) {}

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    const byDay = new Map<string, SpanRow[]>();

    for (const span of spans) {
      const row = toRow(span);
      if (!row) continue;
      const day = utcDay(new Date(row.startMs));
      const bucket = byDay.get(day);
      if (bucket) bucket.push(row);
      else byDay.set(day, [row]);
    }

    const writes = [...byDay.entries()].map(([day, rows]) =>
      // The server has no visitor identity: these are operational spans.
      insertSpans(this.query, rows, { day, visitor: '' }),
    );

    Promise.all(writes).then(
      () => done({ code: ExportResultCode.SUCCESS }),
      (error: unknown) => done({ code: ExportResultCode.FAILED, error: error as Error }),
    );
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }
}

function toRow(span: ReadableSpan): SpanRow | null {
  return exportableToRow(exportableFromReadable(span), {
    surface: 'server',
    resource: resourceAttributesOf(span),
    scope: span.instrumentationScope.name,
  });
}

export function createServerTelemetry(options: {
  query: Query;
  service: string;
  version?: string;
  environment?: string;
}): ServerTelemetry {
  const version = options.version ?? '0.0.0';
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({
      'service.name': options.service,
      'service.version': version,
      'deployment.environment': options.environment ?? 'production',
      'coso.surface': 'server',
    }),
    // Small delay: a Neon invocation can finish long before the 5s default, and
    // `waitUntil(forceFlush())` then does the real work anyway.
    spanProcessors: [
      new BatchSpanProcessor(new PostgresSpanExporter(options.query), {
        scheduledDelayMillis: 250,
        maxExportBatchSize: 64,
      }),
    ],
  });

  return {
    tracer: provider.getTracer(options.service, version),
    forceFlush: () => provider.forceFlush(),
  };
}
