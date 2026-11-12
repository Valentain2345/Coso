// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useRecorder, type RecordingResult } from '../src/hooks/useRecorder';

/* -------------------------------------------------------------------- fakes */

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn(() => true);
  state: 'inactive' | 'recording' | 'paused' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stream: MediaStream;

  constructor(stream: MediaStream) {
    this.stream = stream;
    FakeMediaRecorder.instances.push(this);
  }

  start() {
    this.state = 'recording';
    this.ondataavailable?.({ data: new Blob(['chunk-1'], { type: 'audio/webm' }) });
  }

  pause() {
    this.state = 'paused';
  }

  resume() {
    this.state = 'recording';
  }

  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['chunk-2'], { type: 'audio/webm' }) });
    this.onstop?.();
  }
}

class FakeAudioContext {
  state = 'running';
  resume = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createAnalyser = vi.fn(() => ({
    fftSize: 1024,
    smoothingTimeConstant: 0,
    getFloatTimeDomainData: (data: Float32Array) => data.fill(0.25),
  }));
}

function mediaDevices(getUserMedia: ReturnType<typeof vi.fn>) {
  return { getUserMedia, getTracks: () => [] } as unknown as MediaDevices;
}

function fakeStream() {
  return {
    getTracks: () => [{ stop: vi.fn() }],
  } as unknown as MediaStream;
}

/* -------------------------------------------------------------------- tests */

function setMediaDevices(getUserMedia: ReturnType<typeof vi.fn>) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: mediaDevices(getUserMedia),
  });
}

describe('useRecorder', () => {
  beforeEach(() => {
    FakeMediaRecorder.instances = [];
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder);
    vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
    setMediaDevices(vi.fn(async () => fakeStream()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reports unsupported when the browser has no recording APIs', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    const { result } = renderHook(() => useRecorder());
    expect(result.current.status).toBe('unsupported');
    expect(await result.current.start()).toBe(false);
  });

  it('starts recording, tracks the clock and stops with a blob', async () => {
    const { result } = renderHook(() => useRecorder());
    let started = false;
    await act(async () => {
      started = await result.current.start();
    });
    expect(started).toBe(true);
    expect(result.current.status).toBe('recording');

    // The 90 ms meter tick advances the clock and the level bars.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(result.current.duration).toBeGreaterThan(0);
    expect(result.current.levels.some((level) => level > 0)).toBe(true);

    const finished = (await act(async () => result.current.stop())) as RecordingResult | null;
    expect(result.current.status).toBe('idle');
    expect(finished?.mimeType).toBe('audio/webm;codecs=opus');
    expect(finished?.blob.size).toBeGreaterThan(0);
    expect(FakeMediaRecorder.instances).toHaveLength(1);
  });

  it('pauses and resumes without counting the pause in the duration', async () => {
    const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const { result } = renderHook(() => useRecorder());
    await act(async () => {
      await result.current.start();
    });
    await wait(150);
    await act(async () => {
      result.current.pause();
    });
    expect(result.current.paused).toBe(true);
    // Paused time must not accumulate.
    await wait(150);
    const pausedDuration = result.current.duration;
    expect(pausedDuration).toBeGreaterThan(0);
    expect(pausedDuration).toBeLessThan(1);
    await wait(150);
    expect(result.current.duration).toBe(pausedDuration);
    await act(async () => {
      result.current.resume();
    });
    expect(result.current.recording).toBe(true);
    await wait(150);
    expect(result.current.duration).toBeGreaterThan(pausedDuration);
  });

  it('cancel discards the take and returns to idle', async () => {
    const { result } = renderHook(() => useRecorder());
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      result.current.cancel();
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.duration).toBe(0);
    // After cancel, stop finds an inactive recorder and resolves null.
    const finished = (await act(async () => result.current.stop())) as RecordingResult | null;
    expect(finished).toBeNull();
  });

  it('maps a permission denial to a localized error and denied status', async () => {
    setMediaDevices(
      vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    );
    const { result } = renderHook(() => useRecorder());
    await act(async () => {
      expect(await result.current.start()).toBe(false);
    });
    expect(result.current.status).toBe('denied');
    expect(result.current.error).toBe(
      'Microphone access was blocked. Allow it in your browser settings and try again.',
    );
    act(() => {
      result.current.clearError();
    });
    expect(result.current.error).toBeNull();
  });

  it('surfaces unexpected getUserMedia failures with a generic error', async () => {
    setMediaDevices(
      vi.fn(async () => {
        throw new Error('No audio hardware');
      }),
    );
    const { result } = renderHook(() => useRecorder());
    await act(async () => {
      expect(await result.current.start()).toBe(false);
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBe('No audio hardware');
  });

  it('localizes the denial error in the current interface language', async () => {
    const { setLang } = await import('../src/i18n');
    setMediaDevices(
      vi.fn(async () => {
        throw new DOMException('denied', 'NotAllowedError');
      }),
    );
    // The hook localizes at error-creation time, so switch first.
    act(() => {
      setLang('es');
    });
    const { result } = renderHook(() => useRecorder());
    await act(async () => {
      expect(await result.current.start()).toBe(false);
    });
    expect(result.current.status).toBe('denied');
    expect(result.current.error).toContain('bloqueado');
    act(() => {
      result.current.clearError();
    });
    expect(result.current.error).toBeNull();
    act(() => {
      setLang('en');
    });
  });
});
