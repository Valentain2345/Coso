# Coso analytics and telemetry

Privacy-first, consent-based analytics for **the download page and the web app
only**. The Windows and Android builds never load this code and never send a
request: `mountAnalytics()` and `startTelemetry()` both return immediately in
the native shells.

Everything lives on one Neon branch (`production`) in three pieces:

| Piece | What it is | URL |
| --- | --- | --- |
| `analytics` Function | Pageview collector, GitHub login, dashboard API, retention sweep, server tracing | `https://br-broad-mode-bd85rkq4-analytics.compute.c-8.us-east-2.aws.neon.tech` |
| `telemetry` Function | OTLP/HTTP JSON receiver: `/v1/traces`, `/v1/metrics` | `https://br-broad-mode-bd85rkq4-telemetry.compute.c-8.us-east-2.aws.neon.tech` |
| `analytics/client.js` + `analytics/dashboard/` | Shared browser client and the dashboard, published on GitHub Pages | `https://valentain2345.github.io/Coso/analytics/` |

There is no Worker, no third-party analytics account and no CDN: the Functions,
Postgres, Auth and object storage all come from Lakebase Postgres on Neon.

## What is stored

Pageviews (`hits`):

- `ts`, `day`, `surface` (`site` or `app`), `path` (no query string), `referrer`
  host only, `source` (a `utm_source` slug), `event`, `props`, `value`,
  `language` (the primary `Accept-Language` tag), coarse `device`, `browser` and
  `os`, and `visitor`.
- `visitor` is `HMAC-SHA256(HASH_SECRET, day | ip | user-agent)`, truncated to
  16 hex characters. The IP itself is never written and the salt changes every
  day, so two days cannot be joined.
- Bots, `DNT: 1` and `Sec-GPC: 1` are dropped before the database, on the
  client and again on the server.

Telemetry (`otel_spans`, `otel_metrics`):

- Spans from consenting browsers (`documentLoad`, `exception`) and from the
  analytics Function itself (one SERVER span per request, written in-process).
- Web vitals (LCP, CLS, INP, TTFB) as OTLP gauges.
- Same sanitisation as pageviews: no cookie, no address, no query string, no
  stack trace, no payload-sized string, and credential-looking attribute keys
  are dropped. `telemetry/otlp.ts` is the single validator used by the receiver,
  the server exporter and the tests.
- `visitor` is the same daily HMAC, so a trace can be correlated with a
  pageview without either table holding an address.

## Consent

`analytics/client.js` owns the choice in `localStorage['coso.consent']` and shows
the bar. On accept/reject it dispatches `coso:consent` on `window`; the web
app's `src/lib/telemetry.ts` reads the same key and waits for that event when the
bar is still open. The OpenTelemetry SDK is a **dynamic import** (`otel-*.js`,
~56 kB / 18 kB gzip): a visitor who rejects, ignores the bar, sends DNT or GPC,
or runs a native shell never downloads or executes it.

## Routes

`analytics` Function:

- `POST /api/collect` — one pageview, engagement ping or custom event (204).
- `POST /api/auth/device` — start the GitHub device flow (public client id, no
  client secret).
- `POST /api/auth/token` — exchange an approved device code for a token.
- `GET /api/stats?days=30&surface=app` — aggregate pageview numbers; requires a
  token whose login is in `ALLOWED_LOGINS`.
- `GET /api/telemetry?days=30&surface=app` — vitals, errors, slow spans and
  server requests; same allowlist.
- `GET /api/health` — `{"ok":true}`.
- `POST /cron` — daily retention sweep, only when called by a Neon Function
  Trigger (verified with `parseTriggerDelivery`).

`telemetry` Function:

- `POST /v1/traces` — OTLP/HTTP JSON, max 100 spans per request, 64 kB body
  (gzip accepted), `partialSuccess` for anything refused.
- `POST /v1/metrics` — OTLP/HTTP JSON, max 200 points, gauges and sums only.
- `GET /api/health` — `{"ok":true}`.

Both Functions answer CORS only for `ALLOWED_ORIGINS`.

## Retention

The `retention` Function Trigger runs daily at `04:17 UTC`
(`neon.ts` → `triggers.retention`) and deletes:

- `hits` older than **180 days** (`RETENTION_DAYS`),
- `otel_spans` and `otel_metrics` older than **30 days**
  (`TELEMETRY_RETENTION_DAYS`).

## Deployment

```powershell
# from "Coso audio app"
neon deploy --env .env.local
```

`neon.ts` is the source of truth: two Functions, their environment variables
and the retention trigger. `.env.local` holds the secrets and is never
committed:

- `HASH_SECRET` — salt for the daily HMAC (both Functions).
- `GITHUB_CLIENT_ID` — public OAuth app client id for the device flow.
- `ALLOWED_LOGINS` — comma-separated GitHub logins allowed on the dashboard.
- `ALLOWED_ORIGINS` — comma-separated origins allowed to POST.

Apply the schemas once per branch:

```sql
-- psql "$DATABASE_URL" -f analytics/function/schema.sql
-- psql "$DATABASE_URL" -f telemetry/schema.sql
```

The dashboard is built from `analytics/dashboard/` and published with
`tools/publish-web.ps1` in the page repository. It loads no external scripts;
the GitHub token stays in `sessionStorage` and is only sent to the analytics
Function.

## Tests

```powershell
npx tsc --noEmit
npx vitest run
```

Relevant suites: `tests/analyticsFunction.test.ts` (collector, stats, telemetry
API, tracing, retention), `tests/analyticsClient.test.ts` (consent bar in a real
DOM), `tests/telemetryFunction.test.ts` (OTLP receiver), `tests/otel.test.ts`
(codec and sanitiser), `tests/telemetryBrowser.test.ts` (consent gate),
`tests/otelExporter.test.ts` (browser exporter) and
`tests/analyticsDashboard.test.ts` (dashboard rendering).
