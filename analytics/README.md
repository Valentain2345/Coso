# Analytics

Aggregate, cookie-free analytics for the download page and the web app. The
native apps (Windows, Android) never load any of this.

- **Collector and API**: one Neon Function (`function/handler.ts` +
  `function/index.ts`) on the `production` branch, next to Postgres
  (`function/schema.sql`). `neon.ts` is the source of truth for the deployment.
- **Dashboard**: static page published under `/Coso/analytics/`, gated by GitHub
  device-flow login and an allowlist of GitHub logins.
- **Client**: `analytics/client.js`, loaded by the landing page and by the web
  app (`src/lib/analytics.ts`). Both stay inert until the endpoint is configured
  and the visitor accepts.

Nothing is hosted on a personal server: GitHub Pages serves the static files and
Neon runs the function and the database.

## What is stored

| Field | Example | Notes |
| --- | --- | --- |
| `day` | `2026-11-15` | UTC, used for the daily salt and retention |
| `surface` | `site`, `app` | download page or web app |
| `path` | `/Coso/app/` | no query string, no hash, capped at 200 chars |
| `referrer` | `news.ycombinator.com` | host only |
| `source` | `newsletter` | `utm_source`, reduced to a slug |
| `event` | `pageview`, `download` | `pageview`, `engagement` or a custom slug |
| `props` | `{"file":"Coso.apk"}` | at most 3 flat props, 40 chars each |
| `value` | `12` | seconds on the page, for `engagement` |
| `language` | `es` | primary `Accept-Language` tag |
| `device` | `mobile` | coarse class from the user agent |
| `browser`, `os` | `Chrome`, `Android` | coarse class |
| `visitor` | `6f1c…` | HMAC(secret, day \| ip \| ua), 16 hex chars, rotates daily |

No cookies, no IP, no full URLs, no audio, no cross-day identifier. Rows older
than 180 days are deleted by the daily Function Trigger. `DNT` and `Sec-GPC: 1`
requests are dropped before the database, and so are bots.

Languages replace countries on purpose: Neon Functions expose no geo headers,
and sending visitor IPs to a GeoIP service would defeat the point of not storing
them.

## Consent

The visitor chooses in the bar on the landing page (or the strip in the web
app). The choice lives in `localStorage['coso.consent']` for the whole origin,
so `/Coso/` and `/Coso/app/` share it. Nothing is sent before an explicit
accept, and "Analytics" in the footer reopens the choice.

## Deploy

Prerequisites: the Neon CLI (`npm i -g neon@latest`), a signed-in session
(`neon login`) and a linked project (`neon init`/`neon link`). `.env.local` is
gitignored and holds both the Neon-managed variables and the function secrets:

| Variable | Meaning |
| --- | --- |
| `HASH_SECRET` | salt for the daily visitor HMAC; rotating it de-links earlier days |
| `GITHUB_CLIENT_ID` | public GitHub OAuth app client id (device flow, no secret) |
| `ALLOWED_LOGINS` | comma-separated GitHub logins allowed to read the dashboard |
| `ALLOWED_ORIGINS` | comma-separated origins allowed to POST events |

```bash
neon deploy --env .env.local      # bundles the function, uploads env, applies neon.ts
neon functions get analytics      # prints the invocation_url
neon logs query --branch production --source function --since 1h
```

`neon.ts` declares the function, its env, the `retention` schedule trigger
(`17 4 * * *` → `POST /cron`) and the branch policy. A missing required secret
fails the deploy before anything changes.

After the first deploy, put the URL in three places (the tests assert they agree
with `ANALYTICS_ENDPOINT`):

- `src/lib/analytics.ts` → `ANALYTICS_ENDPOINT` (`…/api/collect`)
- `Coso audio page/index.html` → `data-endpoint`
- `analytics/dashboard/index.html` → `data-endpoint` (the origin, no `/api/collect`)

Apply `function/schema.sql` to the branch once (SQL editor or any Postgres
client); it is idempotent.

The GitHub OAuth App needs **Device Flow enabled** (Settings → Developer
settings → OAuth Apps → your app → Enable Device Flow).

## Routes

| Route | Purpose |
| --- | --- |
| `POST /api/collect` | one pageview, engagement ping or custom event |
| `POST /api/auth/device` | start the GitHub device flow (no client secret) |
| `POST /api/auth/token` | exchange an approved device code for a token |
| `GET /api/stats` | aggregates for allowlisted GitHub logins (`days`, `surface`) |
| `GET /api/health` | liveness, no database work |
| `POST /cron` | retention sweep; only a real Function Trigger delivery is accepted |

## Tests

`tests/analyticsFunction.test.ts` runs the handler against an in-memory Postgres
stub: privacy rules (no IP, daily salt, DNT/GPC, bots), payload validation, CORS,
the device flow, the stats queries with their allowlist and surface filter, and
the signed retention trigger. `tests/analyticsClient.test.ts` and
`tests/analyticsDashboard.test.ts` run the real browser scripts in jsdom.
