/**
 * OTLP/HTTP JSON: the single wire format Coso telemetry speaks.
 *
 * Why hand-rolled instead of `@opentelemetry/exporter-trace-otlp-json`: this
 * module is imported by the browser chunk *and* by both Functions, so it has to
 * stay dependency-free (no DOM, no `node:` imports) and tiny. The OpenTelemetry
 * SDK still produces, samples, batches and limits the spans; only the last hop
 * is ours, and the tests pin it against the OTLP JSON spec.
 *
 * Everything that arrives from a network client passes through `decodeTraces`
 * / `decodeMetrics`, which is where the privacy contract is enforced: the
 * payload is capped, ids and timestamps are validated, and attributes are
 * filtered so no URL query string, token, email or transcript can be stored.
 */

export type Surface = 'site' | 'app' | 'server';
export type AttributeValue = string | number | boolean;
export type Attributes = Record<string, AttributeValue>;
export type SpanKind = 'unset' | 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type SpanStatusName = 'unset' | 'ok' | 'error';

/** A span on the wire, already normalised to what we are willing to store. */
export interface ExportableSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startNanos: string;
  endNanos: string;
  status: SpanStatusName;
  statusMessage?: string;
  attributes?: Attributes;
  events?: Array<{ name: string; timeNanos: string; attributes?: Attributes }>;
}

export interface ExportableMetric {
  name: string;
  unit?: string;
  kind: 'gauge' | 'sum';
  value: number;
  timeNanos: string;
  attributes?: Attributes;
}

/** What the database keeps for one span. */
export interface SpanRow {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: SpanKind;
  startMs: number;
  durationMs: number;
  status: SpanStatusName;
  statusMessage: string;
  surface: Surface;
  attributes: Attributes;
  resource: Attributes;
  scope: string;
}

/** What the database keeps for one metric point. */
export interface MetricRow {
  name: string;
  unit: string;
  kind: 'gauge' | 'sum';
  value: number;
  startMs: number;
  surface: Surface;
  attributes: Attributes;
  resource: Attributes;
  scope: string;
}

/** Hard caps, applied before anything touches Postgres. */
export const MAX_SPANS = 100;
export const MAX_METRICS = 200;
export const MAX_ATTRIBUTES = 24;
export const MAX_RESOURCE_ATTRIBUTES = 12;
export const MAX_ATTRIBUTE_LENGTH = 160;
export const MAX_STATUS_LENGTH = 200;
/** Strings longer than this are dropped outright, never truncated: they are
 *  transcripts, stack traces or payloads, not telemetry. */
export const MAX_STRING_LENGTH = 500;

const ATTRIBUTE_KEY = /^[a-zA-Z][a-zA-Z0-9_.-]{0,39}$/;
const METRIC_NAME = /^[a-zA-Z][a-zA-Z0-9._-]{0,60}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

/** Keys that name a credential, whatever the value looks like. */
const SENSITIVE_KEY = /(auth|cookie|passw|secret|token|session|e-?mail|credit|ssn|api[-_]?key|private|bearer)/i;

const KIND_NUMBER: Record<SpanKind, number> = {
  unset: 0,
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

const KIND_NAME: SpanKind[] = ['unset', 'internal', 'server', 'client', 'producer', 'consumer'];

/** `@opentelemetry/api` numbers kinds differently: INTERNAL is 0 there. */
const API_KIND: SpanKind[] = ['internal', 'server', 'client', 'producer', 'consumer'];

export function apiKindName(kind: number): SpanKind {
  return API_KIND[kind] ?? 'internal';
}

const STATUS_NUMBER: Record<SpanStatusName, number> = { unset: 0, ok: 1, error: 2 };
const STATUS_NAME: SpanStatusName[] = ['unset', 'ok', 'error'];

const SURFACES: Surface[] = ['site', 'app', 'server'];

/** `https://x.example/a.js?token=1` -> `https://x.example/a.js`. */
export function scrubUrls(value: string): string {
  return value.replace(/((?:https?:\/\/|\/)[^\s?#]*)[?#][^\s]*/g, '$1');
}

/**
 * One attribute value, or `null` when it must not be stored.
 *
 * Numbers and booleans pass. Strings lose their query strings, are trimmed, and
 * are dropped when empty or long enough to be content rather than a label.
 */
export function cleanAttributeValue(value: unknown): AttributeValue | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 1000) / 1000;
  }
  if (typeof value !== 'string') return null;
  const cleaned = scrubUrls(value).trim();
  if (cleaned.length === 0 || cleaned.length > MAX_STRING_LENGTH) return null;
  return cleaned.slice(0, MAX_ATTRIBUTE_LENGTH);
}

export function cleanAttributes(value: unknown, limit = MAX_ATTRIBUTES): Attributes {
  const out: Attributes = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (Object.keys(out).length >= limit) break;
    if (!ATTRIBUTE_KEY.test(key) || SENSITIVE_KEY.test(key)) continue;
    const cleaned = cleanAttributeValue(raw);
    if (cleaned !== null) out[key] = cleaned;
  }
  return out;
}

export function cleanSurface(value: unknown): Surface {
  return typeof value === 'string' && (SURFACES as string[]).includes(value) ? (value as Surface) : 'app';
}

/** OTLP span names are free text; ours are labels, so keep them short and flat. */
export function cleanSpanName(value: unknown): string {
  if (typeof value !== 'string') return 'span';
  const name = scrubUrls(value).replace(/\s+/g, ' ').trim().slice(0, 120);
  return name.length > 0 ? name : 'span';
}

export function nanosToMs(nanos: string): number {
  const digits = String(nanos).replace(/\D/g, '');
  if (digits.length === 0) return Number.NaN;
  if (digits.length <= 9) return Number(digits) / 1e6;
  const seconds = Number(digits.slice(0, -9));
  const fraction = Number(digits.slice(-9)) / 1e6;
  return seconds * 1000 + fraction;
}

/** Exact `seconds.nanos` concatenation: no float rounding, no BigInt required. */
export function hrTimeToNanos(time: [number, number]): string {
  const seconds = Math.max(0, Math.trunc(time[0]));
  const nanos = Math.max(0, Math.trunc(time[1] ?? 0));
  return `${seconds}${String(nanos).padStart(9, '0')}`;
}

export function dateToNanos(date: number): string {
  const ms = Math.max(0, date);
  const seconds = Math.floor(ms / 1000);
  const nanos = Math.round((ms - seconds * 1000) * 1e6);
  return `${seconds}${String(nanos).padStart(9, '0')}`;
}

// Wire types ----------------------------------------------------------------

interface WireValue {
  stringValue?: unknown;
  boolValue?: unknown;
  intValue?: unknown;
  doubleValue?: unknown;
}

interface WireAttribute {
  key?: unknown;
  value?: WireValue;
}

interface WireSpan {
  traceId?: unknown;
  spanId?: unknown;
  parentSpanId?: unknown;
  name?: unknown;
  kind?: unknown;
  startTimeUnixNano?: unknown;
  endTimeUnixNano?: unknown;
  attributes?: unknown;
  status?: { code?: unknown; message?: unknown };
}

interface WireTraces {
  resourceSpans?: unknown;
}

interface WireMetrics {
  resourceMetrics?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** OTLP JSON encodes every scalar as a tagged object. */
function decodeAttributeValue(value: unknown): AttributeValue | null {
  if (!isRecord(value)) return null;
  if (typeof value.stringValue === 'string') return value.stringValue;
  if (typeof value.boolValue === 'boolean') return value.boolValue;
  if (typeof value.doubleValue === 'number') return value.doubleValue;
  if (typeof value.intValue === 'number') return value.intValue;
  if (typeof value.intValue === 'string' && /^-?\d+$/.test(value.intValue)) return Number(value.intValue);
  return null;
}

function decodeAttributes(value: unknown, limit = MAX_ATTRIBUTES): Attributes {
  if (!Array.isArray(value)) return {};
  const raw: Record<string, unknown> = {};
  for (const entry of value as WireAttribute[]) {
    if (!isRecord(entry) || typeof entry.key !== 'string') continue;
    const decoded = decodeAttributeValue(entry.value);
    if (decoded !== null) raw[entry.key] = decoded;
  }
  return cleanAttributes(raw, limit);
}

function decodeResource(value: unknown): Attributes & { surface: Surface } {
  const resource = isRecord(value) ? decodeAttributes(value.attributes, MAX_RESOURCE_ATTRIBUTES) : {};
  const surface = cleanSurface(resource['coso.surface']);
  // The surface has its own column; keeping the hint would duplicate it.
  delete resource['coso.surface'];
  return { ...resource, surface };
}

/** Instrumentation scope names are labels: letters, digits and separators only. */
function cleanScope(value: string): string {
  return String(value).replace(/[^a-zA-Z0-9._@/-]/g, '').slice(0, 80);
}

function decodeScope(value: unknown): string {
  if (!isRecord(value) || typeof value.name !== 'string') return '';
  return cleanScope(value.name);
}

function encodeAttributeValue(value: AttributeValue): WireValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

function encodeAttributes(attributes: Attributes | undefined): WireAttribute[] {
  return Object.entries(attributes ?? {}).map(([key, value]) => ({ key, value: encodeAttributeValue(value) }));
}

/** Builds the exact body a collector expects at `POST /v1/traces`. */
export function encodeTraces(input: {
  resource: Attributes;
  scope: { name: string; version?: string };
  spans: ExportableSpan[];
}): WireTraces {
  return {
    resourceSpans: [
      {
        resource: { attributes: encodeAttributes(input.resource) },
        scopeSpans: [
          {
            scope: { name: input.scope.name, version: input.scope.version ?? '' },
            spans: input.spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: KIND_NUMBER[span.kind],
              startTimeUnixNano: span.startNanos,
              endTimeUnixNano: span.endNanos,
              attributes: encodeAttributes(span.attributes),
              ...(span.events && span.events.length > 0
                ? {
                    events: span.events.map((event) => ({
                      name: event.name,
                      timeUnixNano: event.timeNanos,
                      attributes: encodeAttributes(event.attributes),
                    })),
                  }
                : {}),
              status: {
                code: STATUS_NUMBER[span.status],
                ...(span.statusMessage ? { message: span.statusMessage } : {}),
              },
            })),
          },
        ],
      },
    ],
  };
}

/** Builds the exact body a collector expects at `POST /v1/metrics`. */
export function encodeMetrics(input: {
  resource: Attributes;
  scope: { name: string; version?: string };
  metrics: ExportableMetric[];
}): WireMetrics {
  return {
    resourceMetrics: [
      {
        resource: { attributes: encodeAttributes(input.resource) },
        scopeMetrics: [
          {
            scope: { name: input.scope.name, version: input.scope.version ?? '' },
            metrics: input.metrics.map((metric) => ({
              name: metric.name,
              unit: metric.unit ?? '',
              ...(metric.kind === 'sum'
                ? {
                    sum: {
                      aggregationTemporality: 2,
                      isMonotonic: false,
                      dataPoints: [
                        {
                          attributes: encodeAttributes(metric.attributes),
                          timeUnixNano: metric.timeNanos,
                          asDouble: metric.value,
                        },
                      ],
                    },
                  }
                : {
                    gauge: {
                      dataPoints: [
                        {
                          attributes: encodeAttributes(metric.attributes),
                          timeUnixNano: metric.timeNanos,
                          asDouble: metric.value,
                        },
                      ],
                    },
                  }),
            })),
          },
        ],
      },
    ],
  };
}

/**
 * Validates an OTLP traces payload.
 *
 * Returns the spans we are willing to store plus a count of the ones we threw
 * away, which the receiver reports back as `partialSuccess.rejectedSpans`.
 */
export function decodeTraces(
  payload: unknown,
  options: { surface?: Surface; limit?: number } = {},
): { spans: SpanRow[]; rejected: number } {
  const spans: SpanRow[] = [];
  let rejected = 0;
  const limit = options.limit ?? MAX_SPANS;
  if (!isRecord(payload)) return { spans, rejected };

  const resourceSpans = (payload as WireTraces).resourceSpans;
  if (!Array.isArray(resourceSpans)) return { spans, rejected };

  for (const entry of resourceSpans) {
    if (!isRecord(entry)) {
      rejected += 1;
      continue;
    }
    const resource = decodeResource(entry.resource);
    const { surface: declared, ...resourceAttributes } = resource;
    const surface = options.surface ?? declared;

    if (!Array.isArray(entry.scopeSpans)) continue;
    for (const scopeEntry of entry.scopeSpans) {
      if (!isRecord(scopeEntry) || !Array.isArray(scopeEntry.spans)) continue;
      const scope = decodeScope(scopeEntry.scope);

      for (const wire of scopeEntry.spans as WireSpan[]) {
        if (spans.length >= limit) {
          rejected += 1;
          continue;
        }
        const row = toSpanRow(wire, { surface, resource: resourceAttributes, scope });
        if (row) spans.push(row);
        else rejected += 1;
      }
    }
  }

  return { spans, rejected };
}

interface RowInput {
  traceId: unknown;
  spanId: unknown;
  parentSpanId: unknown;
  name: unknown;
  kind: SpanKind;
  startMs: number;
  endMs: number;
  status: SpanStatusName;
  statusMessage: string;
  attributes: Attributes;
  resource: Attributes;
  scope: string;
  surface: Surface;
}

/** The one place a span becomes a row, for both the receiver and the server. */
function buildRow(input: RowInput): SpanRow | null {
  const traceId = typeof input.traceId === 'string' ? input.traceId.toLowerCase() : '';
  const spanId = typeof input.spanId === 'string' ? input.spanId.toLowerCase() : '';
  if (!TRACE_ID.test(traceId) || !SPAN_ID.test(spanId)) return null;

  if (!Number.isFinite(input.startMs) || !Number.isFinite(input.endMs) || input.endMs < input.startMs) return null;
  // A clock skew of more than an hour is a bug or an attack, not a slow page.
  if (input.endMs - input.startMs > 3_600_000) return null;

  const parentSpanId =
    typeof input.parentSpanId === 'string' && SPAN_ID.test(input.parentSpanId.toLowerCase())
      ? input.parentSpanId.toLowerCase()
      : '';

  return {
    traceId,
    spanId,
    parentSpanId,
    name: cleanSpanName(input.name),
    kind: input.kind,
    startMs: Math.round(input.startMs),
    durationMs: Math.max(0, Math.round(input.endMs - input.startMs)),
    status: input.status,
    statusMessage: input.statusMessage,
    surface: input.surface,
    attributes: input.attributes,
    resource: input.resource,
    scope: cleanScope(input.scope),
  };
}

/** One span from an OTLP payload. */
export function toSpanRow(
  wire: WireSpan,
  context: { surface: Surface; resource: Attributes; scope: string },
): SpanRow | null {
  if (!isRecord(wire)) return null;
  const statusNumber = isRecord(wire.status) && typeof wire.status.code === 'number' ? wire.status.code : 0;
  const rawMessage = isRecord(wire.status) && typeof wire.status.message === 'string' ? wire.status.message : '';

  return buildRow({
    traceId: wire.traceId,
    spanId: wire.spanId,
    parentSpanId: wire.parentSpanId,
    name: wire.name,
    kind: KIND_NAME[typeof wire.kind === 'number' ? wire.kind : 0] ?? 'unset',
    startMs: nanosToMs(String(wire.startTimeUnixNano ?? '')),
    endMs: nanosToMs(String(wire.endTimeUnixNano ?? '')),
    status: STATUS_NAME[statusNumber] ?? 'unset',
    statusMessage: rawMessage.length > MAX_STRING_LENGTH ? '' : scrubUrls(rawMessage).trim().slice(0, MAX_STATUS_LENGTH),
    attributes: decodeAttributes(wire.attributes),
    resource: context.resource,
    scope: context.scope,
    surface: context.surface,
  });
}

/**
 * One span from the local SDK. Same validator as the wire path, so a server
 * span cannot contain anything a remote payload could not.
 */
export function exportableToRow(
  span: ExportableSpan,
  context: { surface: Surface; resource: Attributes; scope: string },
): SpanRow | null {
  return buildRow({
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId ?? '',
    name: span.name,
    kind: span.kind,
    startMs: nanosToMs(span.startNanos),
    endMs: nanosToMs(span.endNanos),
    status: span.status,
    statusMessage: (span.statusMessage ?? '').slice(0, MAX_STATUS_LENGTH),
    attributes: cleanAttributes(span.attributes),
    resource: cleanAttributes(context.resource, MAX_RESOURCE_ATTRIBUTES),
    scope: context.scope,
    surface: context.surface,
  });
}

/** Validates an OTLP metrics payload. Histograms and summaries are rejected. */
export function decodeMetrics(
  payload: unknown,
  options: { surface?: Surface; limit?: number } = {},
): { metrics: MetricRow[]; rejected: number } {
  const metrics: MetricRow[] = [];
  let rejected = 0;
  const limit = options.limit ?? MAX_METRICS;
  if (!isRecord(payload)) return { metrics, rejected };

  const resourceMetrics = (payload as WireMetrics).resourceMetrics;
  if (!Array.isArray(resourceMetrics)) return { metrics, rejected };

  for (const entry of resourceMetrics) {
    if (!isRecord(entry)) {
      rejected += 1;
      continue;
    }
    const resource = decodeResource(entry.resource);
    const { surface: declared, ...resourceAttributes } = resource;
    const surface = options.surface ?? declared;

    if (!Array.isArray(entry.scopeMetrics)) continue;
    for (const scopeEntry of entry.scopeMetrics) {
      if (!isRecord(scopeEntry) || !Array.isArray(scopeEntry.metrics)) continue;
      const scope = decodeScope(scopeEntry.scope);

      for (const wire of scopeEntry.metrics as Array<Record<string, unknown>>) {
        if (!isRecord(wire)) continue;
        const name = typeof wire.name === 'string' ? wire.name : '';
        const unit = typeof wire.unit === 'string' ? wire.unit.slice(0, 20) : '';
        if (!METRIC_NAME.test(name)) {
          rejected += 1;
          continue;
        }
        for (const [kind, points] of [
          ['gauge', isRecord(wire.gauge) ? wire.gauge.dataPoints : undefined],
          ['sum', isRecord(wire.sum) ? wire.sum.dataPoints : undefined],
        ] as const) {
          if (!Array.isArray(points)) continue;
          for (const point of points as Array<Record<string, unknown>>) {
            if (metrics.length >= limit) {
              rejected += 1;
              continue;
            }
            const value =
              typeof point.asDouble === 'number'
                ? point.asDouble
                : typeof point.asInt === 'string'
                  ? Number(point.asInt)
                  : typeof point.asInt === 'number'
                    ? point.asInt
                    : Number.NaN;
            const at = nanosToMs(String(point.timeUnixNano ?? ''));
            if (!Number.isFinite(value) || !Number.isFinite(at)) {
              rejected += 1;
              continue;
            }
            metrics.push({
              name,
              unit,
              kind,
              value: Math.round(value * 1000) / 1000,
              startMs: Math.round(at),
              surface,
              attributes: decodeAttributes(point.attributes),
              resource: resourceAttributes,
              scope,
            });
          }
        }
      }
    }
  }

  return { metrics, rejected };
}

// SDK bridge ----------------------------------------------------------------

/** `@opentelemetry/api` status codes: 0 unset, 1 ok, 2 error. */
const STATUS_OK = 1;
const STATUS_ERROR = 2;

function stringAttributes(value: unknown, limit = MAX_ATTRIBUTES): Attributes {
  if (!isRecord(value)) return {};
  const raw: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') raw[key] = entry;
  }
  return cleanAttributes(raw, limit);
}

/** Resource attributes of a finished span, already filtered. */
export function resourceAttributesOf(span: { resource: { attributes: unknown } }): Attributes {
  return stringAttributes(span.resource.attributes, MAX_RESOURCE_ATTRIBUTES);
}

/**
 * Turns a finished SDK span into the wire shape both exporters send.
 *
 * It takes a structural type instead of `ReadableSpan` so this module never
 * imports the SDK: the browser chunk, the Functions and the tests all share it
 * without pulling Node or DOM code, and the receiver and the server exporter
 * cannot drift apart because they use the same mapping.
 */
export function exportableFromReadable(span: {
  name: string;
  kind: number;
  startTime: [number, number];
  endTime: [number, number];
  status: { code: number; message?: string };
  attributes: unknown;
  events: Array<{ name: string; time: [number, number]; attributes?: unknown }>;
  spanContext(): { traceId: string; spanId: string };
  parentSpanContext?: { spanId: string };
}): ExportableSpan {
  const context = span.spanContext();
  const status: SpanStatusName =
    span.status.code === STATUS_ERROR ? 'error' : span.status.code === STATUS_OK ? 'ok' : 'unset';

  return {
    traceId: context.traceId,
    spanId: context.spanId,
    ...(span.parentSpanContext?.spanId ? { parentSpanId: span.parentSpanContext.spanId } : {}),
    name: span.name,
    kind: apiKindName(span.kind),
    startNanos: hrTimeToNanos(span.startTime),
    endNanos: hrTimeToNanos(span.endTime),
    status,
    ...(status === 'error' && typeof span.status.message === 'string'
      ? { statusMessage: span.status.message }
      : {}),
    attributes: stringAttributes(span.attributes),
    events: span.events.slice(0, 5).map((event) => ({
      name: cleanSpanName(event.name),
      timeNanos: hrTimeToNanos(event.time),
      attributes: stringAttributes(event.attributes, 8),
    })),
  };
}
