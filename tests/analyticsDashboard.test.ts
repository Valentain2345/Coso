// @vitest-environment node
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const HTML = readFileSync(new URL('../analytics/dashboard/index.html', import.meta.url), 'utf8');
const SCRIPT = readFileSync(new URL('../analytics/dashboard/dashboard.js', import.meta.url), 'utf8');

type Result = { status?: number; body?: unknown };
type Handler = (url: URL, init: RequestInit) => Result;

const STATS = {
  login: 'valentain2345',
  days: 30,
  since: '2026-10-17',
  surface: 'all',
  totals: { views: 120, visitors: 42, bouncers: 30, engagementSamples: 20, engagementSeconds: 63 },
  daily: [
    { day: '2026-10-17', views: 4, visitors: 3 },
    { day: '2026-11-15', views: 6, visitors: 5 },
  ],
  pages: [
    { path: '/Coso/app/', views: 80, visitors: 30 },
    { path: '/Coso/', views: 40, visitors: 20 },
  ],
  referrers: [{ referrer: 'www.google.com', source: '', views: 50 }],
  channels: [
    { channel: 'Direct', views: 70 },
    { channel: 'Search', views: 50 },
  ],
  languages: [
    { language: 'es', views: 90 },
    { language: '', views: 30 },
  ],
  devices: [{ device: 'mobile', views: 70 }],
  browsers: [{ browser: 'Chrome', views: 100 }],
  oses: [{ os: 'Android', views: 70 }],
  surfaces: [
    { surface: 'app', views: 80 },
    { surface: 'site', views: 40 },
  ],
  events: [{ event: 'download', views: 12, visitors: 10, seconds: 0, props: '' }],
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (times = 6) => {
  for (let index = 0; index < times; index += 1) await tick();
};

function boot(handler: Handler, options: { token?: string } = {}) {
  const dom = new JSDOM(HTML, {
    runScripts: 'outside-only',
    url: 'https://valentain2345.github.io/Coso/analytics/',
  });
  const { window } = dom;

  if (options.token) {
    window.sessionStorage.setItem('coso.analytics.token', options.token);
    window.sessionStorage.setItem('coso.analytics.login', 'valentain2345');
  }

  const requests: Array<{ url: URL; init: RequestInit }> = [];
  window.fetch = ((input: string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push({ url, init });
    const result = handler(url, init);
    const status = result.status ?? 200;
    return Promise.resolve({
      ok: status < 400,
      status,
      json: async () => result.body ?? {},
    });
  }) as unknown as typeof window.fetch;

  window.eval(SCRIPT);

  const $ = (id: string) => window.document.getElementById(id) as HTMLElement;
  const dashboard = (window as unknown as { cosoDashboard: Record<string, any> }).cosoDashboard;
  return { window, requests, $, dashboard };
}

const statsHandler = (overrides: Record<string, unknown> = {}): Handler => (url) => {
  if (url.pathname === '/api/stats') return { body: { ...STATS, ...overrides } };
  return { status: 404, body: { error: 'not found' } };
};

describe('dashboard: signed out', () => {
  it('shows the login card and hides the numbers', () => {
    const { $, window } = boot(statsHandler());
    expect($('login').hidden).toBe(false);
    expect($('app').hidden).toBe(true);
    expect(window.sessionStorage.getItem('coso.analytics.token')).toBeNull();
  });

  it('starts the GitHub device flow and shows the code', async () => {
    const { $, requests } = boot((url) => {
      if (url.pathname === '/api/auth/device') {
        return { body: { device_code: 'dev', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 } };
      }
      return { status: 404 };
    });

    $('start-login').click();
    await settle();

    const request = requests.find((entry) => entry.url.pathname === '/api/auth/device');
    expect(request?.init.method).toBe('POST');
    expect(request?.url.origin).toBe('https://br-broad-mode-bd85rkq4-analytics.compute.c-8.us-east-2.aws.neon.tech');
    expect($('user-code').textContent).toBe('ABCD-1234');
    expect($('verify-link').getAttribute('href')).toBe('https://github.com/login/device');
    expect($('device').hidden).toBe(false);
  });
});

describe('dashboard: signed in', () => {
  it('renders every section from the stats payload', async () => {
    const { $, window } = boot(statsHandler(), { token: 'gho_test' });
    await settle();

    expect($('app').hidden).toBe(false);
    expect($('kpi-visitors').textContent).toBe('42');
    expect($('kpi-views').textContent).toBe('120');
    expect($('kpi-depth').textContent).toBe('2.86');
    expect($('kpi-bounce').textContent).toBe('71.4%');
    expect($('kpi-time').textContent).toBe('1m 03s');

    const document = window.document;
    expect(document.querySelector('#chart svg')).not.toBeNull();
    expect(document.querySelectorAll('#chart-table tbody tr')).toHaveLength(30);
    expect(document.querySelector('table[data-table="pages"] tbody')?.textContent).toContain('/Coso/app/');
    expect(document.querySelector('table[data-table="channels"] tbody')?.textContent).toContain('Search');
    expect(document.querySelector('table[data-table="languages"] tbody')?.textContent).toContain('Spanish');
    expect(document.querySelector('table[data-table="languages"] tbody')?.textContent).toContain('Unknown');
    expect(document.querySelector('table[data-table="devices"] tbody')?.textContent).toContain('Mobile');
    expect(document.querySelector('table[data-table="events"] tbody')?.textContent).toContain('download');
    expect(document.querySelector('table[data-table="surfaces"] tbody')?.textContent).toContain('Web app');
  });

  it('sends the range and surface filters to the API', async () => {
    const { window, $, requests } = boot(statsHandler(), { token: 'gho_test' });
    await settle();

    $('refresh').click();
    await settle();
    expect(requests.at(-1)?.url.searchParams.get('days')).toBe('30');
    expect(requests.at(-1)?.url.searchParams.has('surface')).toBe(false);

    (window.document.querySelector('[data-days="7"]') as HTMLElement).click();
    await settle();
    expect(requests.at(-1)?.url.searchParams.get('days')).toBe('7');

    (window.document.querySelector('[data-surface="app"]') as HTMLElement).click();
    await settle();
    expect(requests.at(-1)?.url.searchParams.get('surface')).toBe('app');
  });

  it('signs out when the account is not allowlisted', async () => {
    const { $ } = boot(() => ({ status: 403, body: { error: 'forbidden' } }), { token: 'gho_test' });
    await settle();

    expect($('login').hidden).toBe(false);
    expect($('app').hidden).toBe(true);
    expect($('login-error').hidden).toBe(false);
  });

  it('shows an empty state instead of fake rows', async () => {
    const { window } = boot(statsHandler({ pages: [], languages: [], events: [] }), { token: 'gho_test' });
    await settle();
    expect(window.document.querySelector('table[data-table="pages"] tbody')?.textContent).toContain('No data yet');
  });
});

describe('dashboard: helpers', () => {
  it('fills the days without data', async () => {
    const { dashboard } = boot(statsHandler(), { token: 'gho_test' });
    await settle();

    const series = dashboard.fillDays([{ day: '2026-10-18', views: 2, visitors: 1 }], '2026-10-17', 3);
    expect(series).toEqual([
      { day: '2026-10-17', views: 0, visitors: 0 },
      { day: '2026-10-18', views: 2, visitors: 1 },
      { day: '2026-10-19', views: 0, visitors: 0 },
    ]);
  });

  it('formats engagement seconds', async () => {
    const { dashboard } = boot(statsHandler(), { token: 'gho_test' });
    await settle();

    expect(dashboard.formatDuration(null)).toBe('—');
    expect(dashboard.formatDuration(0)).toBe('0s');
    expect(dashboard.formatDuration(45)).toBe('45s');
    expect(dashboard.formatDuration(63)).toBe('1m 03s');
    expect(dashboard.formatDuration(3725)).toBe('62m 05s');
  });
});

describe('dashboard: static page', () => {
  it('loads nothing from third parties', () => {
    expect(HTML).not.toMatch(/<script[^>]+src="https?:/i);
    expect(HTML).not.toMatch(/fonts\.googleapis|cdn\./i);
    expect(HTML).toMatch(/name="robots" content="noindex/);
  });
});
