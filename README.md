# Coso

On-device lecture transcription. Record or import audio, remove noise, separate
speakers, edit the transcript, and export it — without sending the recording to
a server. Optional Google Drive upload/download is the only network feature.

## Run the web app

```powershell
npm install
npm run dev        # http://localhost:3000
npm test           # unit tests
npm run test:e2e   # Playwright end-to-end tests
npm run build      # production build in dist/
```

## Google Drive: one-time setup

Google does **not** allow an app to collect a Google email and password
directly. That is an anti-phishing rule, not a Coso limitation. The safe
equivalent is one button that opens Google's own sign-in page, where the person
types their email and password. Coso never sees them.

For that button to work, the person who installs this copy does this once:

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials).
2. Create or select a project, then enable **Google Drive API** under *APIs & Services → Library*.
3. Configure the **OAuth consent screen** (External is fine for personal use). Add the
   account that will use Coso as a test user while the app is unverified.
4. Create credentials → **OAuth client ID** → **Web application**.
5. Add the Authorized JavaScript origins you will use:

   | Where Coso runs | Origin to add |
   | --- | --- |
   | `npm run dev` | `http://localhost:3000` |
   | `npm run preview` / E2E | `http://localhost:4173` |
   | Windows app (Tauri) | `http://tauri.localhost` |
   | Web deployment | `https://your-domain.example` |

6. Copy `.env.example` to `.env`, paste the client ID, and rebuild:

   ```powershell
   Copy-Item .env.example .env
   # edit .env, then:
   npm run build
   ```

After the build, the Google Drive dialog shows only **Continue with Google**.
The setup field is not shown to everyday users. Scopes requested: `drive.file`
(Coso's own folder) and `drive.readonly` (so existing audio in Drive can be
imported). Tokens live in `sessionStorage` and are discarded when the tab closes.

While the OAuth app is unverified, Google only lets accounts listed as test
users sign in. Add your wife's Google address as a test user, or publish the
consent screen.

## Languages

The whole interface is available in **English** and **Spanish**. Switch it in
**Settings → App language**; the change is instant, applies to every dialog and
menu, and is remembered in the browser. Pipeline messages that arrive from the
workers in English are translated at display time, so progress cards and error
messages switch language too.

## Beginner guide

**Settings → How to use Coso** (or the book icon in the library) opens an
in-app illustrated guide: recording, reading, editing, the player, exports,
Drive, and the phone layout. The pictures and GIFs in the guide are generated
from the real running app by `tools/manual-media.mjs`:

```powershell
node tools/manual-media.mjs   # writes public/manual/*.png and *.gif
```

## Windows app (Tauri)

Prerequisites, all free:

- [Rust](https://rustup.rs/) 1.90 or newer
- Visual Studio Build Tools with the **Desktop development with C++** workload
- WebView2 (already included in Windows 11)

```powershell
npm run desktop        # development window
npm run desktop:build  # installers in src-tauri/target/release/bundle
```

The build writes `bundle/nsis/Coso_2.0.0_x64-setup.exe` and
`bundle/msi/Coso_2.0.0_x64_en-US.msi`; either installs the app. On launch the
window shrinks to fit small laptop screens and centres itself. The NSIS
installer creates a **Coso** shortcut on the desktop in addition to the
Start-menu entry (see `src-tauri/nsis-hooks.nsh`), shows in the user's language
(English or Spanish) with the branded panels in `src-tauri/icons/`, and can be
driven from inside the app: Settings → Uninstall erases every recording and
transcript, then opens the silent uninstaller.

Editing in the transcript is not limited to text: in edit mode you can also
rename speakers (click a speaker name, type "Bob") and correct a passage's
start time (click the timestamp, type `1:24`). Renamed speakers are used by
every export format. Files always save through the platform's own dialog:
a download in the browser, the native save dialog on the desktop, and the
system file picker (SAF) on Android — where the picker grants write permission
to the selected folder.

Recording, denoising, transcription, speaker separation, editing and export all
work in the Windows shell. The shell sends COOP `same-origin` + COEP
`require-corp`, so WASM inference uses multiple threads there.

Google's policy disallows OAuth inside embedded WebViews, and it may reject the
desktop window's user agent. For guaranteed Drive access on Windows, install the
web build as an app from Edge (**Apps → Install this site as an app**) — that
uses a full browser and supports Google sign-in today. A system-browser OAuth
flow for the native shell needs an additional desktop OAuth client and is not
enabled yet.

Note on speed: the browser build keeps COOP at `same-origin-allow-popups` so
Google's sign-in pop-up can return the token. Chromium does not treat that as
cross-origin isolated, so browser inference runs single-threaded. The Tauri
build trades the (unusable) embedded sign-in for multi-threaded inference.

## Phone app (Tauri for Android)

The phone app is the same Tauri project as the desktop: `npx tauri android init`
generated `src-tauri/gen/android`. The web code runs unmodified in the Android
WebView, and the export flow uses the native save dialog (system file picker,
which grants write permission to the chosen folder).

One-time toolchain (no Android Studio required — command-line tools only):

```powershell
$env:JAVA_HOME = "$env:LOCALAPPDATA\jdk21\jdk-21.0.13.0.2+1"   # portable JDK
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
& "$env:ANDROID_HOME\cmdline-tools\latest\bin\sdkmanager.bat" "ndk;27.0.12077973"
npx tauri android init   # only if src-tauri/gen/android is missing
```

Build the debug APK (downloads Gradle on first run):

```powershell
$env:JAVA_HOME = "$env:LOCALAPPDATA\jdk21\jdk-21.0.13.0.2+1"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME = "$env:LOCALAPPDATA\Android\Sdk\ndk\27.0.12077973"
npx tauri android build --apk --target aarch64
# → src-tauri/gen/android/app/build/outputs/apk/universal/debug/…
```

### Signing the Android release

The release APK must be signed with a keystore you never lose — Android uses it
to prove updates come from you. The project already has one: `coso-release
keystore at the repo root (alias `coso`). Tauri reads the signing config from
`src-tauri/gen/android/app/build.gradle.kts`; keep the keystore and its password
outside any repository (`*.keystore` is in `.gitignore`). Losing the keystore
means the app can never be updated, only replaced.

### Windows build notes

Two Windows quirks the build already handles — worth knowing if it breaks:

- **Node/.cmd launch**: Gradle's Rust task can't start `.cmd`/`.bat` wrappers
  (Java's `ProcessBuilder` rejects them), so `BuildTask.kt` in
  `buildSrc` invokes `node.exe` with `node_modules/@tauri-apps/cli/tauri.js`
  directly. Requires `npm install` in the project root before Gradle runs.
- **Symlink privilege**: Tauri links the compiled `libcoso_lib.so` into
  `jniLibs/` with a symlink, which needs Windows Developer Mode. Without it,
  run `npx tauri android build` once (it compiles the Rust core), then copy
  the library and drive Gradle directly:

  ```powershell
  Copy-Item src-tauri\target\aarch64-linux-android\release\libcoso_lib.so `
    src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a\
  .\gradlew.bat assembleUniversalDebug -x rustBuildArm64Debug   # from src-tauri\gen\android
  ```

  (`-x rustBuildArm64Debug` skips Gradle's Rust task, which can only run
  under a live `tauri android build` process — the library is already built.)

Android E2E (`e2e/android.spec.ts`) drives the real app on an emulator or
device over the WebView debugging socket. It skips automatically when none is
available. To run it:

```powershell
# Create an AVD once (or plug in a phone with USB debugging)
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
& "$env:ANDROID_HOME\emulator\emulator.exe" -avd <name> &
npx playwright test -g "android"
# Add COSO_INSTALL_APK=1 to (re)install the debug APK first
```

Mobile behaviour:

- Below 860 px the library becomes a drawer. The menu button opens it; swipe
  left, tap the dimmed page, or press Escape to dismiss it. On wide screens the
  library is permanent, so the menu and close buttons disappear entirely.
- Buttons use at least 44 px touch targets, session delete is always visible on
  touch screens, and form fields are 16 px so iOS never zooms the page.
- Dialogs become bottom sheets with a grab handle, and the player, top bar and
  sheets all respect safe-area insets for notches and the home indicator.

For Drive on a phone, the same Google embedded-WebView restriction applies.
The web build added to the home screen uses the phone's full browser and works
with Google sign-in today. Adding Drive to the native shells needs the
system-browser OAuth flow mentioned above.

## Models and quality options

- Whisper Tiny → Large v3 Turbo, selectable in Settings. Larger models download
  once and stay cached; very large models are slow without WebGPU.
- Noise removal: **Basic** spectral filter, **Neural** DeepFilterNet3, or
  **Maximum** (DeepFilterNet3 plus an extra spectral pass).
- Speaker precision: **Standard** or **Thorough** (denser windows, automatic
  voice count).
- Speaker model: **WeSpeaker** (fast) or **Pyannote 3.0** segmentation with
  WeSpeaker fingerprints for global identities.

## Tests

```powershell
npm test            # unit + component tests (Vitest)
npm run test:e2e    # web E2E (Playwright, builds and serves on :4173)
```

Coverage:

- `tests/i18n.test.ts` — dictionary parity (en/es), plurals, number formatting,
  progress/error localization, manual content parity and media existence.
- `tests/export-lang.test.ts` — localized exports (txt/md/srt/vtt/docx/pdf),
  model copy, spoken-language labels.
- `tests/drive.test.ts` — Drive client against fake fetch/XHR/GIS: connect,
  list, resumable upload, download, auth errors.
- `tests/asr-client.test.ts` — worker protocol: stages, model-download
  aggregation, errors, preload, abort/terminate.
- `tests/useRecorder.test.tsx` — recorder lifecycle: start/stop, pause not
  counted, cancel, localized permission error, unsupported browser.
- `tests/components.test.tsx` — CapturePanel, SettingsDialog (including the
  language switch and in-place warning reveals), ProgressCard.
- `e2e/start-screen.spec.ts`, `e2e/transcription.spec.ts` — real UI flows,
  including a full on-device transcription of `tests/fixtures/speech.wav`.
- `e2e/language.spec.ts` — English↔Spanish switch persists and keeps the
  settings panel stable.
- `e2e/desktop.spec.ts` — packaged Windows app over CDP (skipped until
  `npx tauri build` has produced `src-tauri/target/release/coso.exe`).
- `e2e/android.spec.ts` — real app on an Android emulator/device via the
  WebView debugging socket: start screen, on-device-only check, and a short
  recording (skipped unless a device/AVD and the debug APK exist).

## Privacy

Audio and transcripts stay in this browser/app (IndexedDB). Nothing is uploaded
unless the user presses Upload in the Google Drive dialog. Model weights are
downloaded from Hugging Face the first time and then cached.
