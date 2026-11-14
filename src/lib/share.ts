import type { Session } from '../types';
import type { Lang } from '../i18n';
import { displayTitle, exportFilename, plainText } from './export/formats';

/**
 * What actually happened when the user pressed "Share".
 *
 * `shared`   - the system share sheet took the transcript (or its text file).
 * `copied`   - sharing is unavailable (desktop WebView, old browser), so the
 *              transcript went to the clipboard instead.
 * `cancelled`- the user dismissed the share sheet. Not an error.
 * `failed`   - neither sharing nor the clipboard worked.
 */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'failed';

/** Injected for tests; production reads the real navigator. */
export interface ShareEnvironment {
  share?: ((data: ShareData) => Promise<void>) | null;
  canShare?: ((data?: ShareData) => boolean) | null;
  writeText?: ((text: string) => Promise<void>) | null;
}

function currentEnvironment(): ShareEnvironment {
  if (typeof navigator === 'undefined') return {};

  const nav = navigator as Navigator & {
    share?: (data: ShareData) => Promise<void>;
    canShare?: (data?: ShareData) => boolean;
  };

  return {
    // Bind the methods: Web Share throws "Illegal invocation" when detached.
    share: nav.share ? (data) => nav.share!(data) : null,
    canShare: nav.canShare ? (data) => nav.canShare!(data) : null,
    writeText: navigator.clipboard?.writeText
      ? (text) => navigator.clipboard.writeText(text)
      : null,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function transcriptFile(session: Session, text: string): File | null {
  if (typeof File === 'undefined') return null;
  try {
    return new File([text], exportFilename(session, 'txt'), {
      type: 'text/plain;charset=utf-8',
    });
  } catch {
    return null;
  }
}

/**
 * Share a transcript with another app.
 *
 * Order of preference:
 * 1. Web Share with the transcript as a `.txt` file (WhatsApp, Drive, mail).
 * 2. Web Share with the transcript as text (some browsers reject files).
 * 3. Clipboard, so the user can paste it anywhere.
 *
 * Dismissing the share sheet is reported as `cancelled` and never falls back to
 * the clipboard: copying behind the user's back is surprising.
 */
export async function shareTranscript(
  session: Session,
  lang: Lang = 'en',
  environment: ShareEnvironment = currentEnvironment(),
): Promise<ShareOutcome> {
  const text = plainText(session, lang);
  const title = displayTitle(session, lang);
  const share = environment.share ?? null;

  if (share) {
    const file = transcriptFile(session, text);
    // Only offer files when the platform explicitly says it can take them:
    // passing `files` to a browser without file support throws a TypeError.
    const withFile: ShareData | null =
      file && environment.canShare?.({ files: [file] }) ? { files: [file], title } : null;

    try {
      await share(withFile ?? { title, text });
      return 'shared';
    } catch (error) {
      if (isAbortError(error)) return 'cancelled';
      // Some platforms expose `share` but reject every payload (for example a
      // WebView that only forwards URLs). Fall through to the clipboard.
    }
  }

  if (!environment.writeText) return 'failed';
  try {
    await environment.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}
