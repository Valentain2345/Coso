# Coso download page

Static landing page for downloading the Coso apps. Hosted on **GitHub Pages** —
no build step, no framework: plain `index.html` + `styles.css` + `app.js`.

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
   `styles.css`, `app.js` and `assets/`).
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
