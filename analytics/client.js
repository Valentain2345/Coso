/**
 * Coso analytics client — one script for the download page and the web app.
 *
 * <script defer src="analytics/client.js"
 *         data-endpoint="https://<branch>-analytics.<host>/api/collect"
 *         data-surface="site|app"
 *         data-details="https://valentain2345.github.io/Coso/#privacy"></script>
 *
 * Rules it enforces before anything leaves the browser:
 * - No endpoint, no banner, no request: the script stays completely inert.
 * - No request before an explicit "Accept". The choice lives in
 *   localStorage['coso.consent'] for the whole origin, shared by /Coso/ and
 *   /Coso/app/, and can be withdrawn from the footer ("Analytics").
 * - Do Not Track, Global Privacy Control and automated browsers are honoured.
 * - The payload is a path, a referrer host, a utm_source slug and an event name.
 *   Never a cookie, never an IP, never a full URL, never audio.
 *
 * API (window.cosoAnalytics): track(name, props), pageview(), open(),
 * setLanguage(lang), consent.
 */
(() => {
  'use strict';

  const CONFIG_SCRIPT =
    document.querySelector('script[data-endpoint]') ||
    document.currentScript;
  const ENDPOINT = (CONFIG_SCRIPT && CONFIG_SCRIPT.getAttribute('data-endpoint'))?.trim() || '';

  // Crashing the page over analytics is never acceptable, and an inert API lets
  // the rest of the site call it without checks.
  const inert = () => {
    document.getElementById('link-analytics')?.setAttribute('hidden', '');
    window.cosoAnalytics = { track() {}, pageview() {}, open() {}, setLanguage() {}, consent: null };
  };

  // Analytics off: no DOM, no listener, no network. Nothing below runs.
  if (!ENDPOINT) {
    inert();
    return;
  }

  const SURFACE = CONFIG_SCRIPT.getAttribute('data-surface') === 'app' ? 'app' : 'site';
  const DETAILS =
    CONFIG_SCRIPT.getAttribute('data-details') || 'https://valentain2345.github.io/Coso/#privacy';
  const STORAGE_KEY = 'coso.consent';
  const DOWNLOAD = /\.(exe|msi|apk|dmg|zip|pdf|docx?|xlsx?|csv|txt|srt|vtt|mp3|wav|m4a|json)$/i;

  const STRINGS = {
    en: {
      title: 'Anonymous analytics',
      body: 'The apps send nothing. This site and the web app would like to count anonymous visits (page, referrer, language, device) to improve them — no cookies, no IP stored, no audio. You can change this later under “Analytics”.',
      accept: 'Accept',
      reject: 'Reject',
      details: 'Details',
    },
    es: {
      title: 'Analítica anónima',
      body: 'Las apps no envían nada. Al sitio y a la app web les gustaría contar visitas anónimas (página, procedencia, idioma, dispositivo) para mejorarlos — sin cookies, sin guardar tu IP, sin audio. Puedes cambiarlo después en «Analítica».',
      accept: 'Aceptar',
      reject: 'Rechazar',
      details: 'Detalles',
    },
  };

  const blocked = () =>
    navigator.doNotTrack === '1' ||
    navigator.globalPrivacyControl === true ||
    navigator.webdriver === true;

  if (blocked()) {
    inert();
    return;
  }

  function readConsent() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === 'granted' || value === 'denied' ? value : null;
    } catch {
      return null; // private mode: ask, never assume a yes
    }
  }

  function writeConsent(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      /* the choice lasts for this page load only */
    }
  }

  const granted = () => readConsent() === 'granted';

  function language() {
    const lang = (document.documentElement.getAttribute('lang') || 'en').toLowerCase();
    return lang.startsWith('es') ? 'es' : 'en';
  }

  /** Only the host of an external referrer; internal navigation is not a referrer. */
  function referrerHost() {
    try {
      if (!document.referrer) return '';
      const url = new URL(document.referrer);
      return url.host === location.host ? '' : url.host;
    } catch {
      return '';
    }
  }

  /** utm_source only: a marketing tag, reduced to a slug, never the query string. */
  function campaignSource() {
    try {
      return (new URLSearchParams(location.search).get('utm_source') || '').slice(0, 60);
    } catch {
      return '';
    }
  }

  function send(payload) {
    if (!granted()) return;
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ s: SURFACE, p: location.pathname, ...payload }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    }).catch(() => undefined);
  }

  // Pageviews ---------------------------------------------------------------
  let lastPath = null;
  let viewStart = performance.now();
  let engagementFlushed = false;

  function pageview() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    viewStart = performance.now();
    engagementFlushed = false;
    if (!granted()) return;
    const payload = { p: location.pathname, r: referrerHost(), m: campaignSource() };
    const fire = () => send(payload);
    if ('requestIdleCallback' in window) requestIdleCallback(fire, { timeout: 2000 });
    else setTimeout(fire, 1200);
  }

  /** Seconds on the page, once, so the dashboard can report average engagement. */
  function flushEngagement() {
    if (!granted() || engagementFlushed) return;
    const seconds = Math.round((performance.now() - viewStart) / 1000);
    if (seconds < 1) return;
    engagementFlushed = true;
    send({ e: 'engagement', d: seconds, p: lastPath || location.pathname });
  }

  // Custom events ------------------------------------------------------------
  function track(name, props) {
    if (!granted()) return;
    send({ e: String(name || 'event'), x: props, p: location.pathname });
  }

  // Automatic events: outbound links, downloads, single-page-app navigation ---
  document.addEventListener(
    'click',
    (event) => {
      if (!granted()) return;
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link) return;
      let url;
      try {
        url = new URL(link.href, location.href);
      } catch {
        return;
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
      if (url.host !== location.host) return track('outbound', { host: url.host });
      const file = url.pathname.split('/').filter(Boolean).pop() || '';
      if (DOWNLOAD.test(file)) track('download', { file: file.slice(-40) });
    },
    true,
  );

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushEngagement();
    else {
      viewStart = performance.now();
      engagementFlushed = false;
    }
  });
  window.addEventListener('pagehide', flushEngagement);

  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      pageview();
      return result;
    };
  }
  window.addEventListener('popstate', pageview);

  // Consent bar --------------------------------------------------------------
  let bar = null;

  function buildBar() {
    const strings = STRINGS[language()];
    const aside = document.createElement('aside');
    aside.className = 'consent';
    aside.id = 'coso-consent';
    aside.setAttribute('role', 'region');
    aside.setAttribute('aria-labelledby', 'coso-consent-title');
    aside.hidden = true;
    aside.innerHTML =
      `<div class="consent-text">` +
      `<h2 id="coso-consent-title">${strings.title}</h2>` +
      `<p>${strings.body}</p>` +
      `</div>` +
      `<div class="consent-actions">` +
      `<button type="button" class="consent-btn primary" data-consent="granted">${strings.accept}</button>` +
      `<button type="button" class="consent-btn" data-consent="denied">${strings.reject}</button>` +
      `<a class="consent-more" href="${DETAILS}">${strings.details}</a>` +
      `</div>`;
    aside.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-consent]') : null;
      if (!button) return;
      decide(button.getAttribute('data-consent') === 'granted' ? 'granted' : 'denied');
    });
    document.body.appendChild(aside);
    return aside;
  }

  function paintBar() {
    if (!bar) return;
    const strings = STRINGS[language()];
    const title = bar.querySelector('h2');
    const body = bar.querySelector('.consent-text p');
    const [accept, reject] = bar.querySelectorAll('[data-consent]');
    const details = bar.querySelector('.consent-more');
    if (title) title.textContent = strings.title;
    if (body) body.textContent = strings.body;
    if (accept) accept.textContent = strings.accept;
    if (reject) reject.textContent = strings.reject;
    if (details) details.textContent = strings.details;
  }

  function open() {
    if (!bar) bar = buildBar();
    paintBar();
    bar.hidden = false;
    bar.querySelector('[data-consent="granted"]')?.focus({ preventScroll: true });
  }

  function close() {
    if (bar) bar.hidden = true;
  }

  function decide(value) {
    writeConsent(value);
    close();
    // The web app's OpenTelemetry gate listens for this; the analytics client
    // stays the single owner of the stored choice.
    try {
      window.dispatchEvent(new CustomEvent('coso:consent', { detail: value }));
    } catch {
      // No CustomEvent: the bar still works, telemetry just stays off.
    }
    if (value === 'granted') pageview();
  }

  function setLanguage() {
    if (bar && !bar.hidden) paintBar();
  }

  document.addEventListener('coso:lang', setLanguage);

  window.cosoAnalytics = {
    track,
    pageview,
    open,
    setLanguage,
    get consent() {
      return readConsent();
    },
  };

  if (readConsent() === null) open();
  else pageview();
})();
