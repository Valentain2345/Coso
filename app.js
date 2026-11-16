// Coso download page — bilingual (EN/ES), static, no dependencies.
// ---------------------------------------------------------------------------
// >>> EDIT THESE when you create the GitHub repository and its first release. <<<
// Attach the release assets with these exact file names so "latest" links work:
//   Windows: Coso-setup.exe      (the NSIS installer)
//   Android: Coso.apk            (the release APK)
const CONFIG = {
  repo: 'Valentain2345/Coso', // e.g. 'valen/coso'
  windowsAsset: 'Coso-setup.exe',
  androidAsset: 'Coso.apk',
};
// Analytics lives in analytics/client.js (loaded from index.html): consent,
// pageviews, outbound links and the shared storage with /Coso/app/.
// ---------------------------------------------------------------------------

const TRANSLATIONS = {
  en: {
    'hero.title': 'Record the lecture.<br />Keep the transcript.',
    'hero.lead':
      'Coso records your lectures and transcribes them <strong>on your own device</strong> with Whisper — nothing is ever uploaded. Edit speakers and timings, search, and export to TXT, Word, PDF or subtitles.',
    'hero.note': 'The web app runs the same on-device engine — no install, no account.',
    'dl.windows.os': 'Windows',
    'dl.windows.sub': 'Installer · 22 MB',
    'dl.android.os': 'Android',
    'dl.android.sub': 'APK · arm64',
    'dl.web.os': 'Web app',
    'dl.web.sub': 'Open in your browser',
    'features.title': 'Everything a lecture needs',
    'f1.title': '100% on-device',
    'f1.body': 'Whisper runs on your machine. No uploads, no accounts, works offline once models are cached.',
    'f2.title': 'Speakers separated',
    'f2.body': 'Diarization tells voices apart, and you can rename “Speaker 2” to “Prof. Rivera” with one click.',
    'f3.title': 'Editable everything',
    'f3.body': 'Fix a word, a timestamp or a speaker name right in the transcript — exports follow your edits.',
    'f4.title': 'Exports that fit',
    'f4.body': 'TXT, Markdown, Word, PDF, SRT/VTT subtitles, JSON — or just the audio back.',
    'f5.title': 'Noise removal',
    'f5.body': 'Neural denoising (DeepFilterNet) cleans up big-hall recordings before transcription.',
    'f6.title': 'English & Spanish',
    'f6.body': 'The interface and the installer speak your language, and Whisper transcribes dozens more.',
    'g1.title': 'Install on Windows',
    'g1.s1': 'Download the installer above.',
    'g1.s2': 'Run it — the installer opens in your language.',
    'g1.s3': 'Launch <strong>Coso</strong> from the desktop or Start menu.',
    'g1.s4': 'Pick a Whisper model in Settings (small ones download in seconds).',
    'g2.title': 'Install on Android',
    'g2.s1': 'Download the APK above on your phone.',
    'g2.s2': 'Allow “install unknown apps” for your browser, once.',
    'g2.s3': 'Open the APK and confirm the install.',
    'g2.s4': 'When exporting, the system file picker saves wherever you allow it.',
    'g3.title': 'Use it in the browser',
    'g3.s1': 'Open the web app above — it works on desktop and mobile.',
    'g3.s2': 'Choose a model the first time; it downloads once and stays cached on your device.',
    'g3.s3': 'On a phone, use “Add to home screen” to launch it like an app.',
    'privacy.quote':
      'Your recordings never leave your device. The Windows and Android apps send <strong>no telemetry at all</strong>; the website and web app count anonymous visits — only if you accept. No cloud, no account, and the code is open.',
    'privacy.note':
      '* “No telemetry” describes the native apps. The site and web app measure page, referrer, language and device type to know what to fix: no audio, no cookies, no IP stored, and nothing is sent unless you accept.',
    'consent.title': 'Anonymous analytics',
    'consent.body':
      'The apps send nothing. This site and the web app would like to count anonymous visits (page, referrer, language, device) to improve them — no cookies, no IP stored, no audio. You can change this later under “Analytics”.',
    'consent.accept': 'Accept',
    'consent.reject': 'Reject',
    'consent.more': 'Details',
    'footer.line': 'Coso — free, open-source lecture transcription.',
    'footer.source': 'Source code',
    'footer.issues': 'Report a problem',
    'footer.webapp': 'Web app',
    'footer.privacy': 'Privacy',
    'footer.analytics': 'Analytics',
  },
  es: {
    'hero.title': 'Graba la clase.<br />Quédate la transcripción.',
    'hero.lead':
      'Coso graba tus clases y las transcribe <strong>en tu propio dispositivo</strong> con Whisper — nunca se sube nada. Edita voces y tiempos, busca y exporta a TXT, Word, PDF o subtítulos.',
    'hero.note': 'La app web usa el mismo motor en tu dispositivo — sin instalar y sin cuenta.',
    'dl.windows.os': 'Windows',
    'dl.windows.sub': 'Instalador · 22 MB',
    'dl.android.os': 'Android',
    'dl.android.sub': 'APK · arm64',
    'dl.web.os': 'App web',
    'dl.web.sub': 'Ábrela en tu navegador',
    'features.title': 'Todo lo que necesita una clase',
    'f1.title': '100% en tu dispositivo',
    'f1.body': 'Whisper corre en tu equipo. Sin subidas, sin cuentas, y funciona sin conexión una vez descargados los modelos.',
    'f2.title': 'Voces separadas',
    'f2.body': 'La diarización distingue las voces, y puedes renombrar «Voz 2» a «Prof. Rivera» con un clic.',
    'f3.title': 'Todo es editable',
    'f3.body': 'Corrige una palabra, un tiempo o el nombre de una voz dentro de la transcripción — las exportaciones siguen tus cambios.',
    'f4.title': 'Exportaciones para todo',
    'f4.body': 'TXT, Markdown, Word, PDF, subtítulos SRT/VTT, JSON — o solo el audio.',
    'f5.title': 'Limpieza de ruido',
    'f5.body': 'La eliminación neuronal de ruido (DeepFilterNet) limpia las grabaciones de salones grandes antes de transcribir.',
    'f6.title': 'Español e inglés',
    'f6.body': 'La interfaz y el instalador hablan tu idioma, y Whisper transcribe decenas más.',
    'g1.title': 'Instalar en Windows',
    'g1.s1': 'Descarga el instalador de arriba.',
    'g1.s2': 'Ejecútalo — el instalador se abre en tu idioma.',
    'g1.s3': 'Abre <strong>Coso</strong> desde el escritorio o el menú Inicio.',
    'g1.s4': 'Elige un modelo Whisper en Ajustes (los pequeños se descargan en segundos).',
    'g2.title': 'Instalar en Android',
    'g2.s1': 'Descarga el APK de arriba en tu teléfono.',
    'g2.s2': 'Permite «instalar apps desconocidas» para tu navegador, una sola vez.',
    'g2.s3': 'Abre el APK y confirma la instalación.',
    'g2.s4': 'Al exportar, el selector de archivos del sistema guarda donde tú le permitas.',
    'g3.title': 'Úsala en el navegador',
    'g3.s1': 'Abre la app web de arriba — funciona en escritorio y móvil.',
    'g3.s2': 'Elige un modelo la primera vez; se descarga una vez y queda guardado en tu dispositivo.',
    'g3.s3': 'En el teléfono, usa «Añadir a la pantalla de inicio» para abrirla como una app.',
    'privacy.quote':
      'Tus grabaciones nunca salen de tu dispositivo. Las apps de Windows y Android no envían <strong>ninguna telemetría</strong>; el sitio y la app web cuentan visitas anónimas — solo si aceptas. Sin nube, sin cuenta y con el código abierto.',
    'privacy.note':
      '* «Sin telemetría» se refiere a las apps nativas. El sitio y la app web miden página, procedencia, idioma y tipo de dispositivo para saber qué mejorar: sin audio, sin cookies, sin guardar tu IP, y no se envía nada si no aceptas.',
    'consent.title': 'Analítica anónima',
    'consent.body':
      'Las apps no envían nada. Al sitio y a la app web les gustaría contar visitas anónimas (página, procedencia, idioma, dispositivo) para mejorarlos — sin cookies, sin guardar tu IP, sin audio. Puedes cambiarlo después en «Analítica».',
    'consent.accept': 'Aceptar',
    'consent.reject': 'Rechazar',
    'consent.more': 'Detalles',
    'footer.line': 'Coso — transcripción de clases libre y de código abierto.',
    'footer.source': 'Código fuente',
    'footer.issues': 'Reportar un problema',
    'footer.webapp': 'App web',
    'footer.privacy': 'Privacidad',
    'footer.analytics': 'Analítica',
  },
};

const META = {
  "en": {
    "description": "Coso records lectures and meetings and transcribes them on your own device with Whisper. Free and open source for Windows, Android and the browser - no uploads, no accounts.",
    "title": "Coso - lecture transcription, on your device"
  },
  "es": {
    "description": "Coso graba clases y reuniones y las transcribe en tu propio dispositivo con Whisper. Gratis y de código abierto para Windows, Android y el navegador, sin subir nada.",
    "title": "Coso - transcripción de clases, en tu dispositivo"
  }
};

function setLang(lang) {
  document.documentElement.lang = lang;
  // The analytics consent bar follows the page language without coupling.
  document.dispatchEvent(new CustomEvent('coso:lang', { detail: lang }));
  try {
    localStorage.setItem('coso.pageLang', lang);
  } catch {
    /* private mode */
  }
  for (const el of document.querySelectorAll('[data-i18n]')) {
    const value = TRANSLATIONS[lang][el.dataset.i18n];
    if (value !== undefined) el.innerHTML = value;
  }
  const meta = META[lang];
  document.title = meta.title;
  const setMeta = (selector, value) => {
    const tag = document.querySelector(selector);
    if (tag) tag.setAttribute('content', value);
  };
  setMeta('meta[name="description"]', meta.description);
  setMeta('meta[property="og:title"]', meta.title);
  setMeta('meta[property="og:description"]', meta.description);
  setMeta('meta[property="og:locale"]', lang);
  setMeta('meta[name="twitter:title"]', meta.title);
  setMeta('meta[name="twitter:description"]', meta.description);
}

function initialLang() {
  try {
    const saved = localStorage.getItem('coso.pageLang');
    if (saved === 'en' || saved === 'es') return saved;
  } catch {
    /* private mode */
  }
  return /^es\b/i.test(navigator.language || '') ? 'es' : 'en';
}

/** GitHub "latest release" asset URL. */
function releaseUrl(asset) {
  return `https://github.com/${CONFIG.repo}/releases/latest/download/${asset}`;
}

function wireLinks() {
  const windows = document.getElementById('dl-windows');
  const android = document.getElementById('dl-android');
  const repo = document.getElementById('link-repo');
  const issues = document.getElementById('link-issues');

  if (CONFIG.repo === 'USERNAME/REPO') {
    console.warn('Set CONFIG.repo in app.js to "<user>/<repo>" so download links work.');
  }
  windows.href = releaseUrl(CONFIG.windowsAsset);
  android.href = releaseUrl(CONFIG.androidAsset);
  repo.href = `https://github.com/${CONFIG.repo}`;
  issues.href = `https://github.com/${CONFIG.repo}/issues`;

  // Highlight the download for the visitor's platform (desktop-first).
  if (/Android/i.test(navigator.userAgent)) {
    android.classList.add('primary');
    windows.classList.remove('primary');
  }
}

document.getElementById('lang').addEventListener('click', () => {
  setLang(document.documentElement.lang === 'es' ? 'en' : 'es');
});

wireLinks();
setLang(initialLang());
// Analytics ----------------------------------------------------------------
// analytics/client.js owns the consent bar, the pageview and the events; this
// button only reopens the choice. Withdrawing consent has to be as easy as
// granting it.
document.getElementById('link-analytics')?.addEventListener('click', (event) => {
  event.preventDefault();
  window.cosoAnalytics?.open();
});