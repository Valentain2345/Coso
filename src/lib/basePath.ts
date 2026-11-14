/**
 * URL helpers for deploying the web build under a sub-path
 * (for example GitHub Pages' `/Coso/app/`).
 *
 * Vite applies `base` to the bundle itself; these helpers cover the files it
 * does not rewrite: the web app manifest (a plain public file).
 */

/** `Coso/app` → `/Coso/app/`, `/` stays `/`. */
export function normalizeBase(base: string | null | undefined): string {
  const value = (base ?? '').trim();
  if (value.length === 0 || value === '/') return '/';
  const rooted = value.startsWith('/') ? value : `/${value}`;
  return rooted.endsWith('/') ? rooted : `${rooted}/`;
}

/** Join the deployment base with a site-relative path. */
export function applyBase(base: string | null | undefined, path: string): string {
  return `${normalizeBase(base)}${path.replace(/^\/+/, '')}`;
}

/**
 * Rewrite start_url, scope and icon sources so an installed web app opens the
 * deployed sub-path instead of the domain root (which is the landing page).
 */
export function baseManifest(source: string, base: string | null | undefined): string {
  const manifest = JSON.parse(source) as {
    start_url?: string;
    scope?: string;
    icons?: Array<{ src: string; [key: string]: unknown }>;
  };
  const root = normalizeBase(base);
  manifest.start_url = root;
  manifest.scope = root;
  if (Array.isArray(manifest.icons)) {
    manifest.icons = manifest.icons.map((icon) => ({ ...icon, src: applyBase(root, icon.src) }));
  }
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
