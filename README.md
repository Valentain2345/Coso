# Coso download page

Static landing page for downloading the Coso apps. Hosted on **GitHub Pages** -
no build step, no framework: plain `index.html` + `styles.css` + `app.js`.

The **web app** lives in `app/` and is generated, not edited by hand. Rebuild it
from the app repository with `pwsh -File tools/publish-web.ps1 -Commit`; that
builds with base `/Coso/app/`, copies `dist/` here and pushes `gh-pages`. The
hero links to it as "Web app" → `app/`.

## Before publishing (one edit)

Open `app.js` and set the repository at the top:

```js
const CONFIG = {
  repo: 'TU-USUARIO/coso',      // <user>/<repo> — REQUIRED for the download links
  windowsAsset: 'Coso-setup.exe',
  androidAsset: 'Coso.apk',
};
```

Then create the first GitHub release in that repo and attach the two assets
**with those exact names** (the page links to `…/releases/latest/download/<name>`,
which always points at the newest release that contains the asset):

| Asset | File | Where it comes from |
|---|---|---|
| Windows installer | `Coso-setup.exe` | `Coso audio app/src-tauri/target/release/bundle/nsis/Coso_2.0.0_x64-setup.exe` |
| Android APK | `Coso.apk` | `npm run android:release` output (see the app README) |

With the GitHub CLI this is one command from the app folder:

```powershell
gh release create v2.0.0 `
  src-tauri\target\release\bundle\nsis\Coso_2.0.0_x64-setup.exe#Coso-setup.exe `
  <path-to-apk>#Coso.apk `
  --title "Coso 2.0.0" --notes "First public release."
```

(`file#Name` renames the uploaded asset.)

## Publish to GitHub Pages

1. Create a repository (e.g. `<user>/coso` or `<user>.github.io`) and push
   **this folder's contents** to it (not the app — just `index.html`,
   `styles.css`, `app.js`, `robots.txt`, `sitemap.xml`, `404.html` and
   `assets/`).
2. GitHub Pages only serves from a branch: either push the site to `main`
   and set **Settings → Pages → Source: Deploy from a branch → main / (root)**,
   or add a workflow at `.github/workflows/pages.yml` that uploads the folder.
3. The page is live at `https://<user>.github.io/<repo>/`.

Everything is relative paths, so it works both at a repo subpath
(`/coso/`) and at a user site root (`<user>.github.io`).

## Languages

The page opens in the visitor's language (Spanish if their browser is Spanish,
English otherwise) and can be switched with the button in the header; the
choice is remembered in `localStorage`. It follows the same behaviour as the
app and its installer.

The switch also rewrites `<title>`, the description and the Open Graph/Twitter
titles, so a shared link and a search result read in the visitor's language.

## Search engines and social cards

The page is plain HTML on purpose: no framework bundle, no hydration, so it
stays inside the Core Web Vitals budget on a phone.

| File | Why |
|---|---|
| `robots.txt` | allows everything and points at the sitemap |
| `sitemap.xml` | `/` and `/app/` with `lastmod` |
| `404.html` | GitHub Pages serves it for unknown paths; keeps the brand and two working links |
| `assets/og.png` | 1200x630 card for Open Graph, Twitter and `SoftwareApplication.image` |
| `assets/apple-touch-icon.png` | 180x180 home-screen icon for iOS |
| `googleea32ad5a5a8fb4e3.html` | Search Console proof for the site root (see below) |

`index.html` carries `canonical`, `robots`, `color-scheme`, dual
`theme-color`, `og:*`, `twitter:*`, `viewport-fit=cover` and a JSON-LD graph
with `WebSite` and `SoftwareApplication` (version, platforms, price 0, licence,
feature list). The download buttons and the footer links are real `href`s, so
they work before `app.js` runs or when it fails.

Regenerate the two generated images after changing the icon or the copy:

```powershell
cd "..\Coso audio app"
node tools/make-site-assets.mjs     # writes ../Coso audio page/assets/{og.png,apple-touch-icon.png}
```

`tests/site.test.ts` in the app repository verifies all of the above, including
the real pixel size of both PNGs.

To request indexing, submit the sitemap in **Google Search Console** (the only
way Google accepts a new site) and POST the URLs to IndexNow for Bing and
Yandex:

```powershell
# after publishing, with <key> also saved as Coso/<key>.txt
Invoke-RestMethod -Method Post https://api.indexnow.org/indexnow -ContentType 'application/json' -Body (@{
  host = 'valentain2345.github.io'
  key  = '<key>'
  keyLocation = "https://valentain2345.github.io/Coso/<key>.txt"
  urlList = @('https://valentain2345.github.io/Coso/', 'https://valentain2345.github.io/Coso/app/')
} | ConvertTo-Json)
```

### Verifying the property

Search Console offers a file, a meta tag and a DNS record. A GitHub Pages
project site owns neither the host root nor its DNS, so the DNS record cannot
be used; keep both other proofs in place:

- `googleea32ad5a5a8fb4e3.html` at the site root (and its copy in
  `../Coso audio app/public/`, which `publish-web.ps1` also places under
  `app/` so the `/Coso/app/` prefix can be verified);
- the `google-site-verification` meta tag in `index.html` and in the app
  document head.

The HTML proof must stay byte-identical to what Search Console gave you (no
BOM, no added newline). `tests/site.test.ts` checks exactly that, so an edit
that would break verification fails the suite instead of silently unverifying
the site. After the first successful verification, submit the sitemap.
