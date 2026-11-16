/**
 * Coso analytics dashboard (GitHub device-flow login, no dependencies).
 *
 * Everything it reads comes from the analytics Function: totals, timeseries,
 * pages, channels, referrers, languages, devices, browsers, systems, surfaces,
 * custom events, and the OpenTelemetry section (web vitals, errors, slow spans,
 * server requests). The token lives in sessionStorage and is only ever sent to
 * that Function, never to a third party; the page loads no external scripts.
 */
(() => {
  'use strict';

  const script = document.querySelector('script[data-endpoint]');
  const ENDPOINT = (script?.getAttribute('data-endpoint') ?? '').trim().replace(/\/+$/, '');
  if (!ENDPOINT || !document.body.hasAttribute('data-dashboard')) return;

  const TOKEN_KEY = 'coso.analytics.token';
  const LOGIN_KEY = 'coso.analytics.login';

  const state = {
    token: sessionStorage.getItem(TOKEN_KEY) || '',
    login: sessionStorage.getItem(LOGIN_KEY) || '',
    days: 30,
    surface: 'all',
    data: null,
    telemetry: null,
  };

  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const num = (value) => Number(value || 0).toLocaleString('en-US');

  const loginSection = $('login');
  const appSection = $('app');
  const errorBox = $('error');
  const loginError = $('login-error');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = !message;
  }

  function showLoginError(message) {
    loginError.textContent = message;
    loginError.hidden = !message;
  }

  // API -----------------------------------------------------------------------
  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (state.token) headers.authorization = `Bearer ${state.token}`;
    const response = await fetch(`${ENDPOINT}${path}`, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function signIn(login, token) {
    state.login = login;
    state.token = token;
    sessionStorage.setItem(TOKEN_KEY, token);
    sessionStorage.setItem(LOGIN_KEY, login);
    $('who').textContent = `@${login}`;
    document.querySelector('.account').hidden = false;
    loginSection.hidden = true;
    appSection.hidden = false;
  }

  function signOut() {
    state.token = '';
    state.login = '';
    state.data = null;
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(LOGIN_KEY);
    document.querySelector('.account').hidden = true;
    loginSection.hidden = false;
    appSection.hidden = true;
    $('device').hidden = true;
    $('start-login').hidden = false;
    showLoginError('');
  }

  // Login: GitHub device flow ------------------------------------------------
  let pollTimer = null;
  let pollToken = 0;

  async function startLogin() {
    showLoginError('');
    $('start-login').disabled = true;
    try {
      const device = await api('/api/auth/device', { method: 'POST', body: '{}' });
      $('device').hidden = false;
      $('start-login').hidden = true;
      $('user-code').textContent = device.user_code;
      $('verify-link').href = device.verification_uri || 'https://github.com/login/device';
      $('login-status').textContent = 'Waiting for approval…';
      poll(device, Math.max(5, Number(device.interval) || 5) * 1000, Date.now() + (Number(device.expires_in) || 900) * 1000);
    } catch (error) {
      showLoginError(`Could not start the GitHub login: ${error.message}`);
      $('start-login').disabled = false;
    }
  }

  function poll(device, interval, deadline) {
    const current = ++pollToken;
    clearTimeout(pollTimer);
    const tick = async () => {
      if (current !== pollToken) return;
      if (Date.now() > deadline) {
        $('login-status').textContent = 'The code expired.';
        $('start-login').hidden = false;
        $('start-login').disabled = false;
        $('device').hidden = true;
        return;
      }
      try {
        const result = await api('/api/auth/token', {
          method: 'POST',
          body: JSON.stringify({ device_code: device.device_code }),
        });
        const me = await api('/api/stats?days=1', { headers: { authorization: `Bearer ${result.token}` } });
        signIn(me.login, result.token);
        await load();
        return;
      } catch (error) {
        if (error.status === 403) {
          showLoginError(`@${state.login || 'this account'} is not on the allowlist.`);
          $('start-login').hidden = false;
          $('start-login').disabled = false;
          $('device').hidden = true;
          return;
        }
        const message = error.message || '';
        if (message === 'authorization_pending') {
          $('login-status').textContent = 'Waiting for approval…';
        } else if (message === 'slow_down') {
          interval += 5000;
          $('login-status').textContent = 'Waiting for approval…';
        } else if (message === 'expired_token' || message === 'access_denied' || message === 'device_code required') {
          $('login-status').textContent = 'The code expired.';
          $('start-login').hidden = false;
          $('start-login').disabled = false;
          $('device').hidden = true;
          return;
        } else if (error.status >= 500) {
          showLoginError(`GitHub or the Worker failed: ${message}`);
        }
      }
      pollTimer = setTimeout(tick, interval);
    };
    pollTimer = setTimeout(tick, interval);
  }

  // Data ----------------------------------------------------------------------
  async function load() {
    showError('');
    const params = new URLSearchParams({ days: String(state.days) });
    if (state.surface !== 'all') params.set('surface', state.surface);
    try {
      // Telemetry is a separate signal and may legitimately be empty (nobody
      // has accepted yet): it must never take the traffic numbers down with it.
      const [data, telemetry] = await Promise.all([
        api(`/api/stats?${params}`),
        api(`/api/telemetry?${params}`).catch(() => null),
      ]);
      state.data = data;
      state.telemetry = telemetry;
      state.login = data.login;
      if (!sessionStorage.getItem(LOGIN_KEY)) sessionStorage.setItem(LOGIN_KEY, data.login);
      $('who').textContent = `@${data.login}`;
      document.querySelector('.account').hidden = false;
      render(data);
      renderTelemetry(telemetry);
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        signOut();
        showLoginError('Your session expired or this account is not allowed. Sign in again.');
        return;
      }
      showError(`Could not load the numbers: ${error.message}`);
    }
  }

  /** One row per day between `since` and today, so gaps stay visible. */
  function fillDays(daily, since, days) {
    const byDay = new Map((daily || []).map((row) => [row.day, row]));
    const out = [];
    const start = new Date(`${since}T00:00:00Z`).getTime();
    for (let index = 0; index < days; index += 1) {
      const day = new Date(start + index * 86_400_000).toISOString().slice(0, 10);
      const row = byDay.get(day);
      out.push({ day, views: Number(row?.views) || 0, visitors: Number(row?.visitors) || 0 });
    }
    return out;
  }

  const percent = (part, total) => (total > 0 ? `${((part / total) * 100).toFixed(1)}%` : '—');

  function formatDuration(seconds) {
    if (seconds === null || seconds === undefined) return '—';
    const value = Math.max(0, Math.round(Number(seconds) || 0));
    if (value < 60) return `${value}s`;
    const minutes = Math.floor(value / 60);
    const rest = value % 60;
    return `${minutes}m ${String(rest).padStart(2, '0')}s`;
  }

  function render(data) {
    const totals = data.totals || { views: 0, visitors: 0, bouncers: 0 };
    $('kpi-visitors').textContent = num(totals.visitors);
    $('kpi-views').textContent = num(totals.views);
    $('kpi-depth').textContent = totals.visitors > 0 ? (totals.views / totals.visitors).toFixed(2) : '—';
    $('kpi-bounce').textContent = percent(totals.bouncers, totals.visitors);
    $('kpi-time').textContent = formatDuration(totals.engagementSeconds);
    $('hint-visitors').textContent = data.surface === 'all' ? 'across site and app' : `on the ${data.surface === 'app' ? 'web app' : 'site'}`;
    $('hint-views').textContent = `last ${data.days} days`;
    $('hint-time').textContent =
      totals.engagementSamples > 0 ? `${num(totals.engagementSamples)} samples` : 'no samples yet';

    const series = fillDays(data.daily, data.since, data.days);
    drawChart(series);
    renderTable('pages', data.pages, (row) => row.path, 'views');
    renderTable('channels', data.channels, (row) => row.channel, 'views');
    renderTable('referrers', data.referrers, (row) => row.source || row.referrer || 'direct', 'views');
    renderTable('languages', data.languages, (row) => languageName(row.language), 'views');
    renderTable('devices', data.devices, (row) => titleCase(row.device), 'views');
    renderTable('browsers', data.browsers, (row) => row.browser, 'views');
    renderTable('oses', data.oses, (row) => row.os, 'views');
    renderTable('surfaces', data.surfaces, (row) => (row.surface === 'app' ? 'Web app' : 'Site'), 'views');
    renderTable('events', data.events, (row) => row.event, 'views');
  }

  const titleCase = (value) => String(value || '').replace(/^./, (char) => char.toUpperCase());

  function languageName(code) {
    if (!code) return 'Unknown';
    try {
      return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
    } catch {
      return code;
    }
  }

  function renderTable(name, rows, label, valueKey) {
    const body = document.querySelector(`table[data-table="${name}"] tbody`);
    if (!body) return;
    const list = rows || [];
    if (list.length === 0) {
      body.innerHTML = '<tr><td colspan="2"><span class="empty">No data yet</span></td></tr>';
      return;
    }
    const max = Math.max(...list.map((row) => Number(row[valueKey]) || 0), 1);
    body.innerHTML = list
      .map((row) => {
        const value = Number(row[valueKey]) || 0;
        const width = Math.max(2, Math.round((value / max) * 100));
        return (
          `<tr><td><span class="bar" style="width:${width}%"></span><span class="label">${esc(label(row))}</span></td>` +
          `<td>${num(value)}</td></tr>`
        );
      })
      .join('');
  }

  // Telemetry (OpenTelemetry) -------------------------------------------------
  /** LCP/INP/TTFB are milliseconds, CLS is a unitless score. */
  function formatVital(name, value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return '—';
    const number = Number(value);
    if (name === 'webvital.cls') return number.toFixed(3);
    return `${Math.round(number)} ms`;
  }

  const vitalLabel = (name) => String(name || '').replace(/^webvital\./, '').toUpperCase() || '—';

  /** Plain rows: the telemetry tables have more than the two columns of `renderTable`. */
  function renderRows(name, rows, columns) {
    const body = document.querySelector(`table[data-table="${name}"] tbody`);
    if (!body) return;
    const list = rows || [];
    if (list.length === 0) {
      body.innerHTML = `<tr><td colspan="${columns.length}"><span class="empty">No data yet</span></td></tr>`;
      return;
    }
    body.innerHTML = list
      .map((row) => `<tr>${columns.map((column) => `<td>${esc(column(row))}</td>`).join('')}</tr>`)
      .join('');
  }

  function renderTelemetry(data) {
    const vitals = (data && data.vitals) || [];
    const byName = new Map(vitals.map((row) => [row.name, row]));
    const errors = (data && data.errors) || [];
    const slowest = (data && data.slowest) || [];
    const requests = (data && data.requests) || [];

    const kpi = (suffix, name, format) => {
      const row = byName.get(name);
      $(`kpi-${suffix}`).textContent = row ? format(row.p75) : '—';
      $(`hint-${suffix}`).textContent = row
        ? `${num(row.good)}/${num(row.samples)} good`
        : 'no samples yet';
    };

    kpi('lcp', 'webvital.lcp', (value) => formatVital('webvital.lcp', value));
    kpi('cls', 'webvital.cls', (value) => formatVital('webvital.cls', value));
    kpi('inp', 'webvital.inp', (value) => formatVital('webvital.inp', value));

    const errorCount = errors.reduce((sum, row) => sum + (Number(row.count) || 0), 0);
    $('kpi-errors').textContent = data ? num(errorCount) : '—';
    $('hint-errors').textContent = data
      ? `${num(requests.reduce((sum, row) => sum + (Number(row.count) || 0), 0))} server spans`
      : 'telemetry unavailable';

    renderRows('vitals', vitals, [
      (row) => vitalLabel(row.name),
      (row) => formatVital(row.name, row.p75),
      (row) => num(row.samples),
      (row) => percent(Number(row.good) || 0, Number(row.samples) || 0),
    ]);
    renderRows('exceptions', errors, [
      (row) => row.name || 'exception',
      (row) => row.message || '—',
      (row) => num(row.count),
    ]);
    renderRows('slowest', slowest, [
      (row) => row.name,
      (row) => `${num(row.p75)} ms`,
      (row) => `${num(row.worst)} ms`,
      (row) => num(row.count),
    ]);
    renderRows('requests', requests, [
      (row) => row.name,
      (row) => row.status,
      (row) => num(row.count),
      (row) => `${num(row.p75)} ms`,
    ]);
  }

  // Chart ---------------------------------------------------------------------
  function drawChart(series) {
    const host = $('chart');
    const width = 720;
    const height = 220;
    const padding = { top: 10, right: 10, bottom: 22, left: 38 };
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const max = Math.max(...series.map((point) => point.views), 1);
    const stepX = series.length > 1 ? innerWidth / (series.length - 1) : innerWidth;
    const x = (index) => padding.left + index * stepX;
    const y = (value) => padding.top + innerHeight - (value / max) * innerHeight;
    const line = (key) =>
      series.map((point, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`).join(' ');
    const area = `${line('views')} L${x(series.length - 1).toFixed(1)},${padding.top + innerHeight} L${padding.left},${
      padding.top + innerHeight
    } Z`;

    const grid = [0, 0.5, 1].map((fraction) => {
      const value = Math.round(max * fraction);
      const position = y(value).toFixed(1);
      return (
        `<line class="grid-line" x1="${padding.left}" x2="${width - padding.right}" y1="${position}" y2="${position}" />` +
        `<text class="axis" x="${padding.left - 8}" y="${(Number(position) + 3).toFixed(1)}" text-anchor="end">${num(value)}</text>`
      );
    });

    const labelEvery = Math.max(1, Math.ceil(series.length / 6));
    const labels = series
      .map((point, index) =>
        index % labelEvery === 0 || index === series.length - 1
          ? `<text class="axis" x="${x(index).toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(
              point.day.slice(5),
            )}</text>`
          : '',
      )
      .join('');

    host.innerHTML =
      `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Pageviews and visitors per day">` +
      grid +
      `<path d="${area}" fill="var(--bar)" stroke="none" />` +
      `<path d="${line('views')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" />` +
      `<path d="${line('visitors')}" fill="none" stroke="var(--ink-2)" stroke-width="1.5" stroke-dasharray="4 4" />` +
      labels +
      `</svg>`;

    const table = $('chart-table');
    table.innerHTML =
      '<table><caption>Traffic per day</caption><thead><tr><th>Day</th><th>Pageviews</th><th>Visitors</th></tr></thead><tbody>' +
      series
        .map((point) => `<tr><td>${esc(point.day)}</td><td>${num(point.views)}</td><td>${num(point.visitors)}</td></tr>`)
        .join('') +
      '</tbody></table>';
  }

  // Export --------------------------------------------------------------------
  function exportCsv() {
    const data = state.data;
    if (!data) return;
    const rows = [['section', 'label', 'views']];
    const add = (section, list, label, key = 'views') => {
      for (const row of list || []) rows.push([section, label(row), String(Number(row[key]) || 0)]);
    };
    rows.push(['total', 'visitors', String(data.totals.visitors)]);
    rows.push(['total', 'pageviews', String(data.totals.views)]);
    rows.push(['total', 'bouncers', String(data.totals.bouncers)]);
    if (data.totals.engagementSeconds !== null) rows.push(['total', 'engagement seconds', String(data.totals.engagementSeconds)]);
    add('day', fillDays(data.daily, data.since, data.days).map((d) => ({ ...d, label: d.day })), (row) => row.label);
    add('page', data.pages, (row) => row.path);
    add('channel', data.channels, (row) => row.channel);
    add('referrer', data.referrers, (row) => row.source || row.referrer || 'direct');
    add('language', data.languages, (row) => row.language || 'unknown');
    add('device', data.devices, (row) => row.device);
    add('browser', data.browsers, (row) => row.browser);
    add('os', data.oses, (row) => row.os);
    add('surface', data.surfaces, (row) => row.surface);
    add('event', data.events, (row) => row.event);
    const telemetry = state.telemetry;
    if (telemetry) {
      for (const row of telemetry.vitals || []) {
        rows.push(['vital', row.name, String(row.p75 ?? '')]);
      }
      for (const row of telemetry.errors || []) {
        rows.push(['error', `${row.name}: ${row.message}`, String(Number(row.count) || 0)]);
      }
      for (const row of telemetry.requests || []) {
        rows.push(['request', `${row.name} (${row.status})`, String(Number(row.count) || 0)]);
      }
    }

    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `coso-analytics-${data.surface}-${data.days}d.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Wiring --------------------------------------------------------------------
  $('start-login').addEventListener('click', startLogin);
  $('signout').addEventListener('click', () => {
    pollToken += 1;
    clearTimeout(pollTimer);
    signOut();
  });
  $('refresh').addEventListener('click', load);
  $('export').addEventListener('click', exportCsv);
  $('copy-code')?.addEventListener('click', async () => {
    const code = $('user-code').textContent || '';
    try {
      await navigator.clipboard.writeText(code);
      $('login-status').textContent = 'Code copied. Paste it on GitHub to finish.';
    } catch {
      $('login-status').textContent = 'Copy the code manually.';
    }
  });

  document.querySelectorAll('[data-days]').forEach((button) => {
    button.addEventListener('click', () => {
      state.days = Number(button.getAttribute('data-days')) || 30;
      document.querySelectorAll('[data-days]').forEach((other) => other.classList.toggle('active', other === button));
      load();
    });
  });

  document.querySelectorAll('[data-surface]').forEach((button) => {
    button.addEventListener('click', () => {
      state.surface = button.getAttribute('data-surface') || 'all';
      document.querySelectorAll('[data-surface]').forEach((other) => other.classList.toggle('active', other === button));
      load();
    });
  });

  // Session restore: a stored token either works or sends us back to login.
  if (state.token) {
    document.querySelector('.account').hidden = false;
    $('who').textContent = state.login ? `@${state.login}` : '';
    loginSection.hidden = true;
    appSection.hidden = false;
    load();
  } else {
    signOut();
  }

  window.cosoDashboard = { load, state, fillDays, formatDuration, renderTelemetry, exportCsv, signOut };
})();
