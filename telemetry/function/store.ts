/**
 * Persistence for telemetry. Shared by both Functions so there is exactly one
 * INSERT shape to review: the receiver writes what a browser sent, and the
 * analytics Function writes its own spans and metrics the same way.
 *
 * Every statement is parameterised and batched, so a 100-span payload is one
 * round trip and no value ever reaches Postgres as interpolated text.
 */

import type { MetricRow, SpanRow } from '../otlp';

/** Minimal slice of `pg`'s client, so tests can fake it. */
export type Query = <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

export interface IngestContext {
  /** UTC day, also the salt of `visitor`. */
  day: string;
  /** HMAC(secret, day | ip | ua): correlates a trace with a pageview, never the IP. */
  visitor: string;
}

const SPAN_COLUMNS = 15;

/** One INSERT for the whole batch; `ts` is derived from the span start. */
export async function insertSpans(query: Query, rows: SpanRow[], context: IngestContext): Promise<number> {
  if (rows.length === 0) return 0;

  const tuples: string[] = [];
  const params: unknown[] = [];

  rows.forEach((row, index) => {
    const base = index * SPAN_COLUMNS;
    tuples.push(
      `(to_timestamp($${base + 1} / 1000.0), $${base + 2}::date, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}, ` +
        `$${base + 12}::jsonb, $${base + 13}::jsonb, $${base + 14}, $${base + 15})`,
    );
    params.push(
      row.startMs,
      context.day,
      row.traceId,
      row.spanId,
      row.parentSpanId,
      row.name,
      row.kind,
      row.surface,
      row.durationMs,
      row.status,
      row.statusMessage,
      JSON.stringify(row.attributes),
      JSON.stringify(row.resource),
      row.scope,
      context.visitor,
    );
  });

  await query(
    `INSERT INTO otel_spans
       (ts, day, trace_id, span_id, parent_span_id, name, kind, surface, duration_ms,
        status, status_message, attributes, resource, scope, visitor)
     VALUES ${tuples.join(', ')}`,
    params,
  );

  return rows.length;
}

const METRIC_COLUMNS = 11;

export async function insertMetrics(query: Query, rows: MetricRow[], context: IngestContext): Promise<number> {
  if (rows.length === 0) return 0;

  const tuples: string[] = [];
  const params: unknown[] = [];

  rows.forEach((row, index) => {
    const base = index * METRIC_COLUMNS;
    tuples.push(
      `(to_timestamp($${base + 1} / 1000.0), $${base + 2}::date, $${base + 3}, $${base + 4}, $${base + 5}, ` +
        `$${base + 6}, $${base + 7}, $${base + 8}::jsonb, $${base + 9}::jsonb, $${base + 10}, $${base + 11})`,
    );
    params.push(
      row.startMs,
      context.day,
      row.name,
      row.unit,
      row.kind,
      row.surface,
      row.value,
      JSON.stringify(row.attributes),
      JSON.stringify(row.resource),
      row.scope,
      context.visitor,
    );
  });

  await query(
    `INSERT INTO otel_metrics
       (ts, day, name, unit, kind, surface, value, attributes, resource, scope, visitor)
     VALUES ${tuples.join(', ')}`,
    params,
  );

  return rows.length;
}

/**
 * Deletes telemetry past its window. Kept next to the inserts so a new table is
 * one forgotten line away from being reviewed here too.
 */
export async function deleteOlderThan(query: Query, table: 'otel_spans' | 'otel_metrics', day: string): Promise<number> {
  const rows = await query<{ deleted: number }>(
    `WITH deleted AS (DELETE FROM ${table} WHERE day < $1::date RETURNING 1)
     SELECT COUNT(*)::int AS deleted FROM deleted`,
    [day],
  );
  return Number(rows[0]?.deleted) || 0;
}
