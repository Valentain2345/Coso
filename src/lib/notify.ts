/**
 * Completion notifications.
 *
 * A transcription can run for minutes while the user records the next lecture
 * or works in another window, so the end of a run must be announced outside the
 * app. Inside Tauri the native plugin is used (Windows toast, Android
 * notification); in a browser the Web Notifications API is used.
 *
 * The in-app toast stays the primary signal. A system notification is only sent
 * when the app is not in the foreground, so nobody gets the same message twice.
 */
import { isTauri } from './tauri';

export interface NotificationCopy {
  title: string;
  body: string;
  /** Web only: replaces an earlier notification with the same tag. */
  tag?: string;
}

export type NotifyOutcome = 'shown' | 'foreground' | 'denied' | 'unsupported';

/** Minimal Web Notifications surface, injectable for tests. */
export interface WebNotifications {
  readonly permission: string;
  requestPermission(): Promise<string>;
  show(title: string, options?: { body?: string; tag?: string }): void;
}

/** Minimal surface of `@tauri-apps/plugin-notification`. */
export interface NativeNotifications {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  send(options: { title: string; body: string }): unknown;
}

export interface NotifyEnv {
  /** True when an in-app toast is enough (window visible and focused). */
  foreground: boolean;
  web?: WebNotifications | null;
  native?: NativeNotifications | null;
}

function webApi(): WebNotifications | null {
  if (typeof Notification === 'undefined') return null;
  return {
    get permission() {
      return Notification.permission;
    },
    requestPermission: () => Notification.requestPermission(),
    show: (title, options) => {
      new Notification(title, options);
    },
  };
}

async function nativeApi(): Promise<NativeNotifications | null> {
  if (!isTauri()) return null;
  try {
    const plugin = await import('@tauri-apps/plugin-notification');
    return {
      isPermissionGranted: () => plugin.isPermissionGranted(),
      requestPermission: () => plugin.requestPermission(),
      send: (options) => plugin.sendNotification(options),
    };
  } catch {
    // The plugin is absent (for example an old install) - stay silent.
    return null;
  }
}

/** The window is visible and focused, so the user already sees the result. */
export function appInForeground(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.visibilityState !== 'visible') return false;
  return typeof document.hasFocus === 'function' ? document.hasFocus() : true;
}

/**
 * Ask for notification permission. Call this from a user gesture (pressing
 * "Transcribe all"), because browsers reject the request otherwise.
 */
export async function grantPermission(env: NotifyEnv): Promise<boolean> {
  if (env.native) {
    try {
      if (await env.native.isPermissionGranted()) return true;
      return (await env.native.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  if (env.web) {
    try {
      if (env.web.permission === 'granted') return true;
      if (env.web.permission === 'denied') return false;
      return (await env.web.requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  return false;
}

/** Send one notification, unless the app is already in front of the user. */
export async function notifyReady(copy: NotificationCopy, env: NotifyEnv): Promise<NotifyOutcome> {
  if (env.foreground) return 'foreground';

  if (env.native) {
    try {
      if (!(await env.native.isPermissionGranted())) return 'denied';
      await env.native.send({ title: copy.title, body: copy.body });
      return 'shown';
    } catch {
      return 'unsupported';
    }
  }

  if (!env.web) return 'unsupported';
  if (env.web.permission !== 'granted') return 'denied';

  try {
    env.web.show(copy.title, { body: copy.body, tag: copy.tag });
    return 'shown';
  } catch {
    return 'unsupported';
  }
}

let permissionRequest: Promise<boolean> | null = null;

/** Production entry point: ask once per session, then remember the answer. */
export function prepareNotifications(): Promise<boolean> {
  permissionRequest ??= isTauri()
    ? nativeApi().then((native) => grantPermission({ foreground: true, native, web: null }))
    : // Keep the browser path synchronous up to requestPermission(): the call
      // must stay inside the user gesture that started the transcription.
      grantPermission({ foreground: true, web: webApi() });
  return permissionRequest;
}

/** Production entry point used when a queue finishes. */
export async function notifyTranscriptionReady(copy: NotificationCopy): Promise<NotifyOutcome> {
  return notifyReady(copy, {
    foreground: appInForeground(),
    web: webApi(),
    native: await nativeApi(),
  });
}
