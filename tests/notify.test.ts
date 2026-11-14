// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appInForeground,
  grantPermission,
  notifyReady,
  type NativeNotifications,
  type WebNotifications,
} from '../src/lib/notify';

function web(over: Partial<WebNotifications> = {}): WebNotifications {
  return {
    permission: 'granted',
    requestPermission: vi.fn().mockResolvedValue('granted'),
    show: vi.fn(),
    ...over,
  };
}

function native(over: Partial<NativeNotifications> = {}): NativeNotifications {
  return {
    isPermissionGranted: vi.fn().mockResolvedValue(true),
    requestPermission: vi.fn().mockResolvedValue('granted'),
    send: vi.fn(),
    ...over,
  };
}

describe('grantPermission', () => {
  it('does not ask again when the browser already granted permission', async () => {
    const api = web();
    await expect(grantPermission({ foreground: false, web: api })).resolves.toBe(true);
    expect(api.requestPermission).not.toHaveBeenCalled();
  });

  it('respects a denied browser permission', async () => {
    const api = web({ permission: 'denied' });
    await expect(grantPermission({ foreground: false, web: api })).resolves.toBe(false);
    expect(api.requestPermission).not.toHaveBeenCalled();
  });

  it('asks the browser when the permission is still undecided', async () => {
    const api = web({ permission: 'default' });
    await expect(grantPermission({ foreground: false, web: api })).resolves.toBe(true);
    expect(api.requestPermission).toHaveBeenCalledTimes(1);
  });

  it('reports a refused or broken browser prompt as no permission', async () => {
    const refused = web({ permission: 'default', requestPermission: vi.fn().mockResolvedValue('denied') });
    await expect(grantPermission({ foreground: false, web: refused })).resolves.toBe(false);

    const broken = web({
      permission: 'default',
      requestPermission: vi.fn().mockRejectedValue(new Error('Requires a user gesture')),
    });
    await expect(grantPermission({ foreground: false, web: broken })).resolves.toBe(false);
  });

  it('uses the native plugin inside the app shell', async () => {
    const granted = native();
    await expect(grantPermission({ foreground: false, native: granted })).resolves.toBe(true);
    expect(granted.requestPermission).not.toHaveBeenCalled();

    const pending = native({ isPermissionGranted: vi.fn().mockResolvedValue(false) });
    await expect(grantPermission({ foreground: false, native: pending })).resolves.toBe(true);
    expect(pending.requestPermission).toHaveBeenCalledTimes(1);

    const failing = native({ isPermissionGranted: vi.fn().mockRejectedValue(new Error('no plugin')) });
    await expect(grantPermission({ foreground: false, native: failing })).resolves.toBe(false);
  });

  it('reports no permission when neither platform is available', async () => {
    await expect(grantPermission({ foreground: true, web: null, native: null })).resolves.toBe(false);
  });
});

describe('notifyReady', () => {
  const copy = { title: 'Coso — transcript ready', body: '"Lecture 4" is ready to read.', tag: 'coso' };

  it('stays silent while the app is in front of the user', async () => {
    const api = web();
    await expect(notifyReady(copy, { foreground: true, web: api })).resolves.toBe('foreground');
    expect(api.show).not.toHaveBeenCalled();
  });

  it('shows a browser notification with the transcript copy', async () => {
    const api = web();
    await expect(notifyReady(copy, { foreground: false, web: api })).resolves.toBe('shown');
    expect(api.show).toHaveBeenCalledWith(copy.title, { body: copy.body, tag: 'coso' });
  });

  it('does not show a notification without browser permission', async () => {
    const api = web({ permission: 'default' });
    await expect(notifyReady(copy, { foreground: false, web: api })).resolves.toBe('denied');
    expect(api.show).not.toHaveBeenCalled();
  });

  it('prefers the native plugin and checks its permission silently', async () => {
    const api = native();
    await expect(
      notifyReady(copy, { foreground: false, native: api, web: web() }),
    ).resolves.toBe('shown');
    expect(api.send).toHaveBeenCalledWith({ title: copy.title, body: copy.body });

    const blocked = native({ isPermissionGranted: vi.fn().mockResolvedValue(false) });
    await expect(
      notifyReady(copy, { foreground: false, native: blocked, web: web() }),
    ).resolves.toBe('denied');
    expect(blocked.send).not.toHaveBeenCalled();
  });

  it('reports unsupported when the platform throws or is absent', async () => {
    const brokenNative = native({ send: vi.fn().mockRejectedValue(new Error('toast failed')) });
    await expect(
      notifyReady(copy, { foreground: false, native: brokenNative }),
    ).resolves.toBe('unsupported');

    const brokenWeb = web({
      show: vi.fn(() => {
        throw new Error('Illegal constructor');
      }),
    });
    await expect(notifyReady(copy, { foreground: false, web: brokenWeb })).resolves.toBe('unsupported');

    await expect(notifyReady(copy, { foreground: false, web: null })).resolves.toBe('unsupported');
  });
});

describe('appInForeground', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('is true when the window is visible and focused', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    expect(appInForeground()).toBe(true);
  });

  it('is false when the window is hidden', () => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    expect(appInForeground()).toBe(false);
  });

  it('is false when another window has focus', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    expect(appInForeground()).toBe(false);
  });
});
