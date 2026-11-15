import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const appRoot = new URL('..', import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, appRoot), 'utf8');

/** Sibling checkout of the download page; skipped when only the app is cloned. */
const pageRoot = new URL('../../Coso audio page/', import.meta.url);
const hasPage = existsSync(new URL('index.html', pageRoot));
const readPage = (relative: string) => readFileSync(new URL(relative, pageRoot), 'utf8');

/** Width and height straight from the PNG IHDR chunk. */
function pngSize(buffer: Buffer): { width: number; height: number } {
  expect(buffer.toString('ascii', 1, 4)).toBe('PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Every meta/link tag in the document, keyed by property|name or rel. */
function metaOf(html: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/g) ?? []) {
    const key = tag.match(/(?:property|name)="([^"]+)"/)?.[1];
    const content = tag.match(/content="([^"]*)"/)?.[1];
    if (key && content !== undefined) map.set(key, content);
  }
  for (const tag of html.match(/<link\b[^>]*>/g) ?? []) {
    const rel = tag.match(/rel="([^"]+)"/)?.[1];
    const href = tag.match(/href="([^"]+)"/)?.[1];
    if (rel && href) map.set(rel, href);
  }
  return map;
}

function jsonLd(html: string): Array<Record<string, unknown>> {
  const blocks = html.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g,
  ) ?? [];
  return blocks.map((block) => {
    const payload = block.replace(/<script[^>]*>/, '').replace('</script>', '');
    const parsed = JSON.parse(payload) as { '@graph'?: Array<Record<string, unknown>> };
    return parsed['@graph'] ?? [parsed as Record<string, unknown>];
  }).flat();
}

describe('web app document', () => {
  const html = read('index.html');
  const meta = metaOf(html);

  it('is indexable and canonical', () => {
    expect(meta.get('robots')).toContain('index');
    expect(meta.get('canonical')).toBe('https://valentain2345.github.io/Coso/app/');
    expect(meta.get('og:url')).toBe('https://valentain2345.github.io/Coso/app/');
    expect(meta.get('og:type')).toBe('website');
    expect(meta.get('twitter:card')).toBe('summary_large_image');
  });

  it('shares a 1200x630 card from the download page', () => {
    expect(meta.get('og:image')).toBe('https://valentain2345.github.io/Coso/assets/og.png');
    expect(meta.get('og:image:width')).toBe('1200');
    expect(meta.get('og:image:height')).toBe('630');
    expect(meta.get('twitter:image')).toBe(meta.get('og:image'));
  });

  it('keeps a real, descriptive title and description', () => {
    expect(html).toContain('<title>');
    const description = meta.get('description') ?? '';
    expect(description.length).toBeGreaterThan(80);
    expect(description.length).toBeLessThan(200);
  });
});

describe.skipIf(!hasPage)('download page', () => {
  const html = readPage('index.html');
  const meta = metaOf(html);
  const appJs = readPage('app.js');

  it('declares canonical, social and indexing metadata', () => {
    expect(meta.get('canonical')).toBe('https://valentain2345.github.io/Coso/');
    expect(meta.get('robots')).toContain('index');
    expect(meta.get('og:type')).toBe('website');
    expect(meta.get('og:site_name')).toBe('Coso');
    expect(meta.get('og:url')).toBe(meta.get('canonical'));
    expect(meta.get('twitter:card')).toBe('summary_large_image');
    expect(meta.get('og:locale:alternate')).toBe('es');
  });

  it('points social cards at a real 1200x630 PNG', () => {
    expect(meta.get('og:image')).toBe('https://valentain2345.github.io/Coso/assets/og.png');
    const size = pngSize(readFileSync(new URL('assets/og.png', pageRoot)));
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(pngSize(readFileSync(new URL('assets/apple-touch-icon.png', pageRoot)))).toEqual({
      width: 180,
      height: 180,
    });
  });

  it('publishes SoftwareApplication structured data with the current version', () => {
    const nodes = jsonLd(html);
    const app = nodes.find((node) => node['@type'] === 'SoftwareApplication');
    expect(app).toBeDefined();
    expect(app?.name).toBe('Coso');
    expect(String(app?.operatingSystem)).toContain('Windows');
    expect(String(app?.operatingSystem)).toContain('Android');
    expect(app?.isAccessibleForFree).toBe(true);
    expect((app?.offers as { price?: string }).price).toBe('0');
    expect(String(app?.softwareVersion)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(nodes.some((node) => node['@type'] === 'WebSite')).toBe(true);
  });

  it('has one h1 and a description that fits a search snippet', () => {
    expect(html.match(/<h1\b/g)?.length).toBe(1);
    const description = meta.get('description') ?? '';
    expect(description.length).toBeGreaterThan(80);
    expect(description.length).toBeLessThan(200);
  });

  it('downloads work without JavaScript', () => {
    expect(html).not.toContain('href="#"');
    expect(html).toContain('releases/latest/download/Coso-setup.exe');
    expect(html).toContain('releases/latest/download/Coso.apk');
  });

  it('wires robots.txt to the sitemap and lists absolute URLs', () => {
    const robots = readPage('robots.txt');
    expect(robots).toContain('Sitemap: https://valentain2345.github.io/Coso/sitemap.xml');

    const sitemap = readPage('sitemap.xml');
    const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
    expect(urls).toEqual([
      'https://valentain2345.github.io/Coso/',
      'https://valentain2345.github.io/Coso/app/',
    ]);
    expect(sitemap).toContain('<lastmod>');
  });

  it('keeps every translated string in both dictionaries', () => {
    const keys = new Set(
      [...html.matchAll(/data-i18n="([^"]+)"/g)].map((match) => match[1]),
    );
    for (const language of ['en', 'es']) {
      const start = appJs.indexOf(`  ${language}: {`);
      const end = appJs.indexOf('\n  },', start);
      const block = appJs.slice(start, end);
      const defined = new Set(
        [...block.matchAll(/'([a-z0-9.]+)':/g)].map((match) => match[1]),
      );
      for (const key of keys) {
        expect(defined, `${key} missing from ${language}`).toContain(key);
      }
    }
  });

  it('sizes touch targets and clears notches on phones', () => {
    const css = readPage('styles.css');
    expect(css).toContain('env(safe-area-inset-top');
    expect(css).toContain('min-height: 44px');
    expect(css).toContain('@media (pointer: coarse)');
    expect(css).toContain('text-wrap: balance');
    // Standalone header/footer links keep the full target on touch.
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*?\.footer-links a \{[\s\S]*?min-height: 44px;/);
    expect(css).toMatch(/@media \(pointer: coarse\)[\s\S]*?\.brand \{ min-height: 44px; \}/);
  });

  it('ships a self-contained 404 page that is not indexed', () => {
    const notFound = readPage('404.html');
    expect(metaOf(notFound).get('robots')).toBe('noindex');
    expect(notFound).toContain('href="/Coso/"');
    // GitHub Pages serves it for any unknown path, so it cannot rely on a
    // stylesheet that may resolve elsewhere in the tree.
    expect(notFound).not.toContain('<link rel="stylesheet"');
    expect(notFound).toContain('env(safe-area-inset-top');
  });

  it('keeps the Search Console proof at both site roots', () => {
    const token = 'googleea32ad5a5a8fb4e3.html';
    const proof = `google-site-verification: ${token}`;
    expect(readPage(token)).toBe(proof);
    // The app is a separate URL prefix, so the same proof ships under /app/.
    expect(read('public/' + token)).toBe(proof);
    expect(metaOf(html).get('google-site-verification')).toBe(
      '9Bsem_NqfG2J19sAOtuDovHC2aY-Q-ryWSHPEzGT7VU',
    );
  });

  it('never publishes local notes', () => {
    expect(readPage('.gitignore')).toContain('otras cosas.txt');
  });
});

describe('mobile status strip', () => {
  // Git checks the file out with CRLF on Windows; normalise before matching.
  const css = read('src/styles.css').replace(/\r\n/g, '\n');
  const phoneBlock = css.slice(
    css.indexOf('@media (max-width: 860px)'),
    css.indexOf('@media (max-width: 620px)'),
  );
  const narrowBlock = css.slice(css.indexOf('@media (max-width: 620px)'));

  it('owns the notch inset and drops it from the title bar underneath', () => {
    expect(phoneBlock).toContain('.job-strip {\n    padding-top: env(safe-area-inset-top);');
    expect(phoneBlock).toContain('.job-strip + .topbar');
  });

  it('keeps every strip action at the 44 px touch minimum', () => {
    expect(phoneBlock).toMatch(/\.job-strip-toggle,\s*\.job-strip-cancel \{[\s\S]*?min-height: 44px;/);
    expect(narrowBlock).toMatch(/width: 44px;/);
  });

  it('collapses the cancel label to an icon on narrow phones', () => {
    expect(narrowBlock).toContain('.job-strip-cancel-text {\n    display: none;');
    expect(narrowBlock).toContain('.job-strip-cancel-icon {\n    display: block;');
  });

  it('scrolls the details panel instead of covering the workspace', () => {
    expect(phoneBlock).toMatch(/\.job-strip-panel \{[\s\S]*?max-height: min\(62dvh, 520px\);[\s\S]*?overflow-y: auto;/);
  });
});
