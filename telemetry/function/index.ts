/**
 * Coso telemetry Function: the OTLP endpoint the browser and both Functions
 * talk to.
 *
 * One pool per isolate, reused across requests, with `attachDatabasePool` so an
 * idle connection drop does not surface as an uncaught exception.
 */

import { parseEnv } from '@neon/env';
import { attachDatabasePool } from '@neon/functions';
import { Pool } from 'pg';

import config from '../../neon';
import { createTelemetry } from './handler';

const env = parseEnv(config, 'telemetry');

const pool = new Pool({ connectionString: env.postgres.databaseUrl, max: 5 });
attachDatabasePool(pool);

const telemetry = createTelemetry({
  env: {
    hashSecret: env.function.HASH_SECRET,
    allowedOrigins: env.function.ALLOWED_ORIGINS,
  },
  query: async (sql, params) => {
    const result = await pool.query(sql, params as unknown[] | undefined);
    return result.rows as never;
  },
});

export default telemetry;
