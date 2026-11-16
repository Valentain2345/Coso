// @vitest-environment jsdom
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { ANALYTICS_ENDPOINT, analyticsClientUrl, mountAnalytics } from '../src/lib/analytics';
import { setLang } from '../src/i18n';

/**
 * Files are read from the project root (`process.cwd()`), not `import.meta.url`:
 * under jsdom the module URL is not necessarily a `file:` URL, so `readFileSync`
 * would reject it.
 */
const pagePath = resolve('../Coso audio page/index.html');
const hasPage = existsSync(pagePath);
const page = hasPage ? readFileSync(pagePath, 'utf8') : '';
const dashboardHtml = readFileSync(resolve('analytics/dashboard/index.html'), 'utf8');

describe('analytics: client URL', () => {
  it('sits next to the app on GitHub Pages', () => {
    expect(analyticsClientUrl('/Coso/app/')).toBe('/Coso/analytics/client.js');
  });

  it('works from the site root and from a plain build', () => {
    expect(analyticsClientUrl('/')).toBe('/analytics/client.js');
    expect(analyticsClientUrl('')).toBe('/analytics/client.js');
  });

  it('never doubles slashes', () => {
    expect(analyticsClientUrl('/Coso/app')).toBe('/Coso/analytics/client.js');
    expect(analyticsClientUrl('Coso/app/')).toBe('/Coso/analytics/client.js');
  });
});

describe('analytics: mounting', () => {
  it('does not load the client inside the native shells', () => {
    const before = document.head.querySelectorAll('script').length;
    expect(mountAnalytics({ native: true })).toBeNull();
    expect(document.head.querySelectorAll('script')).toHaveLength(before);
  });

  it('adds one deferred script with the endpoint and surface', () => {
    const script = mountAnalytics({ base: '/Coso/app/', native: false });
    expect(script).not.toBeNull();
    expect(script?.getAttribute('data-endpoint')).toBe(ANALYTICS_ENDPOINT);
    expect(script?.getAttribute('data-surface')).toBe('app');
    expect(script?.getAttribute('src')).toBe('/Coso/analytics/client.js');
    expect(script?.getAttribute('data-analytics-client')).toBe('');

    // A second call must not double-count pageviews.
    expect(mountAnalytics({ base: '/Coso/app/', native: false })).toBeNull();
    expect(document.head.querySelectorAll('script[data-analytics-client]')).toHaveLength(1);
  });
});

describe.skipIf(!hasPage)('analytics: published pages', () => {
  // One source of truth: `ANALYTICS_ENDPOINT`. The published HTML must match it.
  const origin = new URL(ANALYTICS_ENDPOINT).origin;

  it('loads the shared client on the download page', () => {
    expect(page).toContain('src="analytics/client.js"');
    expect(page).toContain('data-surface="site"');
    expect(page).toContain(`data-endpoint="${ANALYTICS_ENDPOINT}"`);
  });

  it('keeps the dashboard endpoint in sync with the app', () => {
    expect(dashboardHtml).toContain(`data-endpoint="${origin}"`);
    expect(ANALYTICS_ENDPOINT.endsWith('/api/collect')).toBe(true);
  });

  it('explains that "no telemetry" belongs to the native apps', () => {
    expect(page).toMatch(/no telemetry at all/i);
    expect(page).toContain('privacy.note');
    expect(page).toMatch(/native apps/i);
  });
});

describe('analytics: language changes', () => {
  it('updates <html lang> and notifies listeners', () => {
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent<string>).detail);
    document.addEventListener('coso:lang', listener);

    setLang('es');
    expect(document.documentElement.lang).toBe('es');
    expect(events).toContain('es');

    setLang('en');
    expect(document.documentElement.lang).toBe('en');
    document.removeEventListener('coso:lang', listener);
    // Leave the singleton as the other tests expect it.
    setLang('en');
  });
});
