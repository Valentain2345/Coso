-- Coso telemetry schema (Postgres, Neon).
--
-- OpenTelemetry data, kept apart from the consent-gated pageviews in `hits`:
-- a span is a request, a page load or an error, and a metric point is a web
-- vital. Same rules: no IP address, no cookie, no query string. `visitor` is
-- the same daily HMAC the collector uses, so a trace can be joined to a
-- pageview without either table ever holding an address.
--
-- Idempotent, so it is safe to re-run. Telemetry expires after
-- TELEMETRY_RETENTION_DAYS (30) through the same daily sweep as `hits`.

CREATE TABLE IF NOT EXISTS otel_spans (
  id             bigserial   PRIMARY KEY,
  ts             timestamptz NOT NULL,
  day            date        NOT NULL,
  trace_id       text        NOT NULL,             -- 32 hex chars
  span_id        text        NOT NULL,             -- 16 hex chars
  parent_span_id text        NOT NULL DEFAULT '',
  name           text        NOT NULL,
  kind           text        NOT NULL DEFAULT 'unset'
                 CHECK (kind IN ('unset', 'internal', 'server', 'client', 'producer', 'consumer')),
  surface        text        NOT NULL DEFAULT 'app' CHECK (surface IN ('site', 'app', 'server')),
  duration_ms    integer     NOT NULL DEFAULT 0,
  status         text        NOT NULL DEFAULT 'unset' CHECK (status IN ('unset', 'ok', 'error')),
  status_message text        NOT NULL DEFAULT '',
  attributes     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  resource       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  scope          text        NOT NULL DEFAULT '',
  visitor        text        NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS otel_spans_day ON otel_spans (day);
CREATE INDEX IF NOT EXISTS otel_spans_name_day ON otel_spans (name, day);
CREATE INDEX IF NOT EXISTS otel_spans_error_day ON otel_spans (day) WHERE status = 'error';
CREATE INDEX IF NOT EXISTS otel_spans_trace ON otel_spans (trace_id);

CREATE TABLE IF NOT EXISTS otel_metrics (
  id         bigserial        PRIMARY KEY,
  ts         timestamptz      NOT NULL,
  day        date             NOT NULL,
  name       text             NOT NULL,             -- webvital.lcp, webvital.cls, …
  unit       text             NOT NULL DEFAULT '',
  kind       text             NOT NULL DEFAULT 'gauge' CHECK (kind IN ('gauge', 'sum')),
  surface    text             NOT NULL DEFAULT 'app' CHECK (surface IN ('site', 'app', 'server')),
  value      double precision NOT NULL,
  attributes jsonb            NOT NULL DEFAULT '{}'::jsonb,
  resource   jsonb            NOT NULL DEFAULT '{}'::jsonb,
  scope      text             NOT NULL DEFAULT '',
  visitor    text             NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS otel_metrics_name_day ON otel_metrics (name, day);
CREATE INDEX IF NOT EXISTS otel_metrics_surface_day ON otel_metrics (surface, day);
