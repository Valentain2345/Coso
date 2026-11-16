import { defineConfig } from '@neon/config/v1';

/**
 * Coso infrastructure as code.
 *
 * `analytics` is the only Function: the collector plus the dashboard API plus
 * the retention sweep. It runs on the same branch as Postgres, so
 * `DATABASE_URL` is injected and never leaves Neon. The secrets below are read
 * from `.env.local` at deploy time (`neon deploy --env .env.local`); a missing
 * one fails the deploy before anything changes.
 */
export default defineConfig({
  // Managed Better Auth is enabled on the project, unused by analytics today.
  auth: true,
  functions: {
    analytics: {
      name: 'Coso analytics',
      source: './analytics/function/index.ts',
      env: {
        // Salt for the daily visitor HMAC.
        HASH_SECRET: { value: process.env.HASH_SECRET, required: true },
        // Public GitHub OAuth app client id (device flow, no client secret).
        GITHUB_CLIENT_ID: { value: process.env.GITHUB_CLIENT_ID, required: true },
        // Who may read the dashboard.
        ALLOWED_LOGINS: { value: process.env.ALLOWED_LOGINS, required: true },
        // Origins allowed to POST events (the site and the web app).
        ALLOWED_ORIGINS: { value: process.env.ALLOWED_ORIGINS, required: true },
      },
    },
  },
  buckets: {
    // "private" is the default; use "public_read" for anonymous reads.
    assets: { access: 'private' },
  },
  triggers: {
    // One sweep a day: anything older than RETENTION_DAYS is deleted.
    retention: {
      type: 'schedule',
      function: 'analytics',
      cron: '17 4 * * *',
      functionPath: '/cron',
    },
  },
  // Branch policy: per-branch tuning.
  branch: (branch) => {
    if (branch.isDefault) {
      // Default branch: no overrides, uses project defaults.
      return {};
    }
    if (!branch.exists) {
      // New non-default branches: auto-expire.
      // Run `neon checkout <name>` to create a new branch with these settings.
      return { ttl: '7d' };
    }
    // Existing branch: no changes.
    return {};
  },
});
