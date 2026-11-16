/**
 * Coso analytics Function: the only deployed entry point for pageviews.
 *
 * One Postgres pool per isolate (`max` small: connections are `max` × isolates),
 * reused across every request. `attachDatabasePool` turns expected idle drops
 * into silence instead of an `uncaughtException` that would kill the isolate.
 *
 * OpenTelemetry is created here, before the handler, so the tracer the handler
 * receives is a real one. Spans are flushed through `waitUntil` after the
 * response, which is also why a short-lived isolate loses nothing.
 */

import { parseEnv } from '@neon/env';
import { attachDatabasePool, waitUntil } from '@neon/functions';
import { Pool } from 'pg';

import pkg from '../../package.json';
import config from '../../neon';
import { createAnalytics } from './handler';
import { createServerTelemetry } from './otel';

const env = parseEnv(config, 'analytics');

const pool = new Pool({ connectionString: env.postgres.databaseUrl, max: 5 });
attachDatabasePool(pool);

const query = async <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => {
  const result = await pool.query(sql, params);
  return result.rows as T[];
};

const telemetry = createServerTelemetry({
  query,
  service: 'coso-analytics',
  version: pkg.version,
  environment: env.branch?.name ?? 'production',
});

const analytics = createAnalytics({
  env: {
    hashSecret: env.function.HASH_SECRET,
    githubClientId: env.function.GITHUB_CLIENT_ID,
    allowedLogins: env.function.ALLOWED_LOGINS,
    allowedOrigins: env.function.ALLOWED_ORIGINS,
  },
  query,
  tracer: telemetry.tracer,
});

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await analytics.fetch(request);
    } finally {
      // Deferred, not awaited: the response goes out first.
      waitUntil(telemetry.forceFlush().catch(() => undefined));
    }
  },
};
