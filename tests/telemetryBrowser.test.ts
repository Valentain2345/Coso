// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `startTelemetry` is the consent gate in front of the OpenTelemetry chunk.
 * The SDK is mocked on purpose: what matters here is *whether* it is imported
 * and with which arguments, not what the SDK does once it runs (that is
 * `otelExporter.test.ts` and the Function tests).
 */
const mocks = vi.hoisted(() => ({
  startBrowserTelemetry: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock('../src/lib/otel', () => ({ startBrowserTelemetry: mocks.startBrowserTelemetry }));
vi.mock('../src/lib/tauri', () => ({ isTauri: mocks.isTauri }));

import { ANALYTICS_ENDPOINT } from '../src/lib/analytics';
import {
  CONSENT_KEY,
  TELEMETRY_ENDPOINT,
  optedOut,
  readConsent,
  startTelemetry,
} from '../src/lib/telemetry';

const setConsent = (value: string) => window.localStorage.setItem(CONSENT_KEY, value);

const setNavigator = (key: string, value: unknown) =>
  Object.defineProperty(window.navigator, key, { value, configurable: true });

beforeEach(() => {
  window.localStorage.clear();
  mocks.startBrowserTelemetry.mockClear();
  mocks.isTauri.mockReturnValue(false);
  setNavigator('doNotTrack', undefined);
  setNavigator('globalPrivacyControl', undefined);
});

afterEach(() => {
  window.localStorage.clear();
  setNavigator('doNotTrack', undefined);
  setNavigator('globalPrivacyControl', undefined);
});

describe('telemetry: consent gate', () => {
  it('does nothing in the native shells, even with consent', async () => {
    mocks.isTauri.mockReturnValue(true);
    setConsent('granted');

    await expect(startTelemetry()).resolves.toBe(false);
    expect(mocks.startBrowserTelemetry).not.toHaveBeenCalled();
  });

  it('honours Do Not Track and Global Privacy Control', async () => {
    setConsent('granted');
    setNavigator('doNotTrack', '1');
    expect(optedOut()).toBe(true);
    await expect(startTelemetry()).resolves.toBe(false);

    setNavigator('doNotTrack', undefined);
    setNavigator('globalPrivacyControl', true);
    expect(optedOut()).toBe(true);
    await expect(startTelemetry()).resolves.toBe(false);

    expect(mocks.startBrowserTelemetry).not.toHaveBeenCalled();
  });

  it('stays off when the stored choice is a rejection', async () => {
    setConsent('denied');
    await expect(startTelemetry()).resolves.toBe(false);
    expect(mocks.startBrowserTelemetry).not.toHaveBeenCalled();
  });

  it('starts once the stored choice is acceptance', async () => {
    setConsent('granted');
    await expect(startTelemetry()).resolves.toBe(true);
    expect(mocks.startBrowserTelemetry).toHaveBeenCalledTimes(1);
    expect(mocks.startBrowserTelemetry).toHaveBeenCalledWith({
      endpoint: TELEMETRY_ENDPOINT,
      surface: 'app',
    });
  });

  it('passes an explicit endpoint and surface through', async () => {
    setConsent('granted');
    await startTelemetry({ endpoint: 'https://collector.example', surface: 'site' });
    expect(mocks.startBrowserTelemetry).toHaveBeenCalledWith({
      endpoint: 'https://collector.example',
      surface: 'site',
    });
  });
});

describe('telemetry: waiting for the bar', () => {
  it('waits for an acceptance event and then starts', async () => {
    const pending = startTelemetry();
    expect(mocks.startBrowserTelemetry).not.toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent('coso:consent', { detail: 'granted' }));

    await expect(pending).resolves.toBe(true);
    expect(mocks.startBrowserTelemetry).toHaveBeenCalledTimes(1);
  });

  it('never starts after a rejection event', async () => {
    const pending = startTelemetry();
    window.dispatchEvent(new CustomEvent('coso:consent', { detail: 'denied' }));

    await expect(pending).resolves.toBe(false);
    expect(mocks.startBrowserTelemetry).not.toHaveBeenCalled();
  });
});

describe('telemetry: stored consent', () => {
  it('reads only the two known values', () => {
    expect(readConsent()).toBeNull();
    setConsent('granted');
    expect(readConsent()).toBe('granted');
    setConsent('denied');
    expect(readConsent()).toBe('denied');
    setConsent('maybe');
    expect(readConsent()).toBeNull();
  });

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    expect(readConsent(broken)).toBeNull();
  });

  it('shares the key with the analytics client', () => {
    expect(CONSENT_KEY).toBe('coso.consent');
  });
});

describe('telemetry: endpoint', () => {
  it('is the telemetry Function of the same Neon branch as the collector', () => {
    const branch = 'br-broad-mode-bd85rkq4';
    expect(new URL(TELEMETRY_ENDPOINT).protocol).toBe('https:');
    expect(new URL(TELEMETRY_ENDPOINT).host).toBe(
      `${branch}-telemetry.compute.c-8.us-east-2.aws.neon.tech`,
    );
    expect(new URL(ANALYTICS_ENDPOINT).host).toBe(
      `${branch}-analytics.compute.c-8.us-east-2.aws.neon.tech`,
    );
    expect(ANALYTICS_ENDPOINT.endsWith('/api/collect')).toBe(true);
  });
});
