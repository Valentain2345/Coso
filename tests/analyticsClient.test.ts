// @vitest-environment node
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

const CLIENT = readFileSync(new URL('../analytics/client.js', import.meta.url), 'utf8');

type Payload = Record<string, unknown>;

type BootOptions = {
  /** `null` leaves the script out entirely (analytics not configured). */
  endpoint?: string | null;
  surface?: 'site' | 'app';
  consent?: 'granted' | 'denied';
  lang?: string;
  dnt?: string;
  gpc?: boolean;
  now?: () => number;
};

/** Runs the real client in a fresh document and records every request. */
function boot(options: BootOptions = {}) {
  const dom = new JSDOM(
    '<!doctype html><html lang="en"><body><button type="button" id="link-analytics">Analytics</button></body></html>',
    { runScripts: 'outside-only', url: 'https://valentain2345.github.io/Coso/app/' },
  );
  const { window } = dom;

  if (options.lang) window.document.documentElement.setAttribute('lang', options.lang);
  if (options.consent) window.localStorage.setItem('coso.consent', options.consent);
  if (options.dnt) Object.defineProperty(window.navigator, 'doNotTrack', { value: options.dnt, configurable: true });
  if (options.gpc) {
    Object.defineProperty(window.navigator, 'globalPrivacyControl', { value: true, configurable: true });
  }
  if (options.now) window.performance.now = options.now;

  const sent: Payload[] = [];
  window.fetch = ((_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)) as Payload);
    return Promise.resolve({ ok: true });
  }) as unknown as typeof window.fetch;

  // jsdom has no requestIdleCallback: run the callback immediately.
  (window as unknown as { requestIdleCallback: (callback: () => void) => number }).requestIdleCallback = (
    callback,
  ) => {
    callback();
    return 0;
  };

  if (options.endpoint !== null) {
    const script = window.document.createElement('script');
    script.setAttribute('data-endpoint', options.endpoint ?? 'https://worker.example/api/collect');
    script.setAttribute('data-surface', options.surface ?? 'site');
    window.document.body.appendChild(script);
  }

  window.eval(CLIENT);

  const bar = () => window.document.getElementById('coso-consent');
  const accept = () => (window.document.querySelector('[data-consent="granted"]') as HTMLElement).click();
  const reject = () => (window.document.querySelector('[data-consent="denied"]') as HTMLElement).click();

  return { window, sent, bar, accept, reject };
}

const api = (window: JSDOM['window']) => (window as unknown as { cosoAnalytics: Record<string, any> }).cosoAnalytics;

describe('analytics client: inert by default', () => {
  it('does nothing at all without an endpoint', () => {
    const { window, sent, bar } = boot({ endpoint: null });
    expect(sent).toHaveLength(0);
    expect(bar()).toBeNull();
    expect(api(window).consent).toBeNull();
    expect(window.document.getElementById('link-analytics')?.hasAttribute('hidden')).toBe(true);
  });

  it('honours Do Not Track and Global Privacy Control', () => {
    const dnt = boot({ dnt: '1' });
    const gpc = boot({ gpc: true });
    for (const ctx of [dnt, gpc]) {
      expect(ctx.sent).toHaveLength(0);
      expect(ctx.bar()).toBeNull();
      expect(api(ctx.window).consent).toBeNull();
    }
  });
});

describe('analytics client: consent', () => {
  it('asks before sending anything', () => {
    const { sent, bar } = boot();
    expect(sent).toHaveLength(0);
    expect(bar()?.hidden).toBe(false);
  });

  it('sends a single pageview after Accept and remembers it', () => {
    const { window, sent, bar, accept } = boot();
    accept();

    expect(window.localStorage.getItem('coso.consent')).toBe('granted');
    expect(bar()?.hidden).toBe(true);
    expect(sent).toEqual([{ s: 'site', p: '/Coso/app/', r: '', m: '' }]);
  });

  it('sends nothing after Reject', () => {
    const { window, sent, bar, reject } = boot();
    reject();

    expect(window.localStorage.getItem('coso.consent')).toBe('denied');
    expect(bar()?.hidden).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('resumes a granted choice without asking again', () => {
    const { sent, bar } = boot({ consent: 'granted', surface: 'app' });
    expect(bar()).toBeNull();
    expect(sent).toEqual([{ s: 'app', p: '/Coso/app/', r: '', m: '' }]);
  });

  it('lets the visitor withdraw from the footer', () => {
    const { window, bar } = boot({ consent: 'denied' });
    expect(bar()).toBeNull();
    api(window).open();
    expect(bar()?.hidden).toBe(false);
  });

  it('follows the page language', () => {
    const { window, bar } = boot({ lang: 'es' });
    expect(bar()?.querySelector('h2')?.textContent).toBe('Analítica anónima');

    window.document.documentElement.setAttribute('lang', 'en');
    window.document.dispatchEvent(new window.CustomEvent('coso:lang', { detail: 'en' }));
    expect(bar()?.querySelector('h2')?.textContent).toBe('Anonymous analytics');
  });
});

describe('analytics client: events', () => {
  it('reports outbound links and file downloads', () => {
    const { window, sent } = boot({ consent: 'granted' });

    const outbound = window.document.createElement('a');
    outbound.href = 'https://github.com/Valentain2345/Coso';
    outbound.textContent = 'source';
    window.document.body.appendChild(outbound);
    outbound.click();

    const download = window.document.createElement('a');
    download.href = '/Coso/Coso.apk';
    download.textContent = 'apk';
    window.document.body.appendChild(download);
    download.click();

    expect(sent.at(-2)).toMatchObject({ e: 'outbound', x: { host: 'github.com' } });
    expect(sent.at(-1)).toMatchObject({ e: 'download', x: { file: 'Coso.apk' } });
  });

  it('accepts custom events only after consent', () => {
    const pending = boot();
    api(pending.window).track('copy', { format: 'txt' });
    expect(pending.sent).toHaveLength(0);

    const granted = boot({ consent: 'granted' });
    api(granted.window).track('copy', { format: 'txt' });
    expect(granted.sent.at(-1)).toMatchObject({ e: 'copy', x: { format: 'txt' } });
  });

  it('sends one engagement ping with the seconds spent on the page', () => {
    const { window, sent } = boot({ consent: 'granted', now: () => 0 });
    window.performance.now = () => 8000;

    Object.defineProperty(window.document, 'visibilityState', { value: 'hidden', configurable: true });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    window.document.dispatchEvent(new window.Event('visibilitychange'));

    const pings = sent.filter((payload) => payload.e === 'engagement');
    expect(pings).toHaveLength(1);
    expect(pings[0]).toMatchObject({ e: 'engagement', d: 8, p: '/Coso/app/' });
  });

  it('does not count the same path twice', () => {
    const { window, sent } = boot({ consent: 'granted' });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    api(window).pageview();
    expect(sent.filter((payload) => payload.e === undefined)).toHaveLength(1);
  });
});
