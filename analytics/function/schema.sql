-- Coso analytics schema (Postgres, Neon).
--
-- One row per event: a pageview, an engagement ping (seconds on the page) or a
-- custom event such as "download". No cookies, no IP address, no full referrer
-- URL: `visitor` is an HMAC that rotates every UTC day, so two days cannot be
-- linked. `language` comes from Accept-Language because Neon Functions expose no
-- geo headers, and shipping IPs to a GeoIP service would defeat the point.
--
-- Apply with `neon deploy` (the function creates nothing) or by pasting this
-- file into the branch's SQL editor. Idempotent, so it is safe to re-run.

CREATE TABLE IF NOT EXISTS hits (
  id        bigserial PRIMARY KEY,
  ts        timestamptz NOT NULL DEFAULT now(),
  day       date        NOT NULL,                  -- UTC day, also the visitor salt
  surface   text        NOT NULL,                  -- 'site' | 'app'
  path      text        NOT NULL,
  referrer  text        NOT NULL DEFAULT '',       -- host only
  source    text        NOT NULL DEFAULT '',       -- utm_source, sanitised
  event     text        NOT NULL DEFAULT 'pageview', -- pageview | engagement | custom slug
  props     jsonb       NOT NULL DEFAULT '{}'::jsonb, -- at most 3 scalar props
  value     integer     NOT NULL DEFAULT 0,        -- engagement seconds
  language  text        NOT NULL DEFAULT '',       -- primary Accept-Language tag
  device    text        NOT NULL DEFAULT 'desktop',
  browser   text        NOT NULL DEFAULT 'Other',
  os        text        NOT NULL DEFAULT 'Other',
  visitor   text        NOT NULL                   -- HMAC(secret, day|ip|ua), 16 hex chars
);

-- Pageviews are the hot path: every dashboard query filters event = 'pageview'.
CREATE INDEX IF NOT EXISTS hits_pageview_day ON hits (day) WHERE event = 'pageview';
CREATE INDEX IF NOT EXISTS hits_pageview_surface_day ON hits (surface, day) WHERE event = 'pageview';
CREATE INDEX IF NOT EXISTS hits_event_day ON hits (event, day);
-- Bounce rate needs distinct visitors per day; index-only scan on the pair.
CREATE INDEX IF NOT EXISTS hits_pageview_visitor_day ON hits (visitor, day) WHERE event = 'pageview';
