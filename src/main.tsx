import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/literata/400.css';
import '@fontsource/literata/400-italic.css';
import '@fontsource/literata/600.css';
import './styles.css';
import App from './App';
import { mountAnalytics } from './lib/analytics';
import { startTelemetry } from './lib/telemetry';
import { isTauri } from './lib/tauri';

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html.');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// React has mounted: dismiss the boot splash and clear the reload guard.
try {
  sessionStorage.removeItem('coso.bootReload');
} catch {
  // Storage can be unavailable in private modes; the guard is best-effort.
}
requestAnimationFrame(() => {
  const boot = document.getElementById('boot');
  if (!boot) return;
  boot.style.opacity = '0';
  window.setTimeout(() => boot.remove(), 300);
});

// Anonymous analytics: browser builds only, opt-in, and after mount so it can
// never delay the first paint. Telemetry (OpenTelemetry) goes through the same
// consent gate and only downloads its chunk once the visitor accepts.
requestAnimationFrame(() => {
  if (isTauri()) return;
  mountAnalytics();
  void startTelemetry();
});

// The app-shell service worker is a web/offline optimisation only. In WebView2
// it can intercept the module bundle and leave the window stuck on the splash,
// so the Tauri shell never registers it and removes any stale registration.
if ('serviceWorker' in navigator) {
  if (isTauri()) {
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) =>
        Promise.all(registrations.map((registration) => registration.unregister())),
      )
      .catch(() => undefined);
  } else if (import.meta.env.PROD) {
    window.addEventListener('load', () => {
      void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
    });
  }
}
