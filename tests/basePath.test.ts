import { describe, expect, it } from 'vitest';
import { applyBase, baseManifest, normalizeBase } from '../src/lib/basePath';

const MANIFEST = JSON.stringify({
  name: 'Coso',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
  ],
});

describe('normalizeBase', () => {
  it('keeps root deployments at the root', () => {
    expect(normalizeBase('/')).toBe('/');
    expect(normalizeBase('')).toBe('/');
    expect(normalizeBase(null)).toBe('/');
    expect(normalizeBase(undefined)).toBe('/');
  });

  it('adds the missing leading and trailing slashes', () => {
    expect(normalizeBase('/Coso/app/')).toBe('/Coso/app/');
    expect(normalizeBase('/Coso/app')).toBe('/Coso/app/');
    expect(normalizeBase('Coso/app')).toBe('/Coso/app/');
  });
});

describe('applyBase', () => {
  it('joins site-relative paths without doubling slashes', () => {
    expect(applyBase('/Coso/app/', 'sw.js')).toBe('/Coso/app/sw.js');
    expect(applyBase('/Coso/app/', '/sw.js')).toBe('/Coso/app/sw.js');
    expect(applyBase('/', 'icon.svg')).toBe('/icon.svg');
  });
});

describe('baseManifest', () => {
  it('scopes an installed app to the deployment sub-path', () => {
    const manifest = JSON.parse(baseManifest(MANIFEST, '/Coso/app/'));

    expect(manifest.name).toBe('Coso');
    expect(manifest.start_url).toBe('/Coso/app/');
    expect(manifest.scope).toBe('/Coso/app/');
    expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual([
      '/Coso/app/icon.svg',
      '/Coso/app/icon-192.png',
    ]);
    expect(manifest.icons[0].sizes).toBe('any');
  });

  it('leaves a root deployment untouched apart from normalising the paths', () => {
    const manifest = JSON.parse(baseManifest(MANIFEST, '/'));

    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.icons[0].src).toBe('/icon.svg');
  });

  it('formats the output as readable JSON with a trailing newline', () => {
    const output = baseManifest(MANIFEST, '/Coso/app/');
    expect(output.endsWith('\n')).toBe(true);
    expect(output).toContain('\n  "name": "Coso"');
  });
});
