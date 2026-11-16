/**
 * Coso analytics Function: the only deployed entry point.
 *
 * One Postgres pool per isolate (`max` small: connections are `max` × isolates),
 * reused across every request. `attachDatabasePool` turns expected idle drops
 * into silence instead of an `uncaughtException` that would kill the isolate.
 */

import { parseEnv } from '@neon/env';
import { attachDatabasePool } from '@neon/functions';
import { Pool } from 'pg';

import config from '../../neon';
import { createAnalytics } from './handler';

const env = parseEnv(config, 'analytics');

const pool = new Pool({ connectionString: env.postgres.databaseUrl, max: 5 });
attachDatabasePool(pool);

const analytics = createAnalytics({
  env: {
    hashSecret: env.function.HASH_SECRET,
    githubClientId: env.function.GITHUB_CLIENT_ID,
    allowedLogins: env.function.ALLOWED_LOGINS,
    allowedOrigins: env.function.ALLOWED_ORIGINS,
  },
  query: async (sql, params) => {
    const result = await pool.query(sql, params as unknown[] | undefined);
    return result.rows as never;
  },
});

export default analytics;
