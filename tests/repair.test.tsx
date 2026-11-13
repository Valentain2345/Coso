// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { setLang } from '../src/i18n';

const decode = vi.hoisted(() => ({ decodeToMono16k: vi.fn() }));

vi.mock('../src/lib/audio/decode', () => ({
  decodeToMono16k: decode.decodeToMono16k,
}));

import {
  AudioRepairDialog,
  REPAIR_PREVIEW_SECONDS,
} from '../src/components/AudioRepairDialog';

const SAMPLE_RATE = 16000;

function makeSamples(seconds: number): Float32Array {
  const samples = new Float32Array(Math.round(SAMPLE_RATE * seconds));
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
  }
  return samples;
}

const source = () => new Blob(['fake audio'], { type: 'audio/webm' });

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  decode.decodeToMono16k.mockReset();
  decode.decodeToMono16k.mockResolvedValue({
    samples: makeSamples(10),
    sampleRate: SAMPLE_RATE,
    duration: 10,
  });
  Object.defineProperty(window.URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:mock'),
    configurable: true,
  });
  Object.defineProperty(window.URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'play', {
    value: vi.fn(() => Promise.resolve()),
    configurable: true,
  });
  Object.defineProperty(window.HTMLMediaElement.prototype, 'pause', {
    value: vi.fn(),
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  setLang('en');
  vi.restoreAllMocks();
});

describe('AudioRepairDialog', () => {
  it('decodes the source and offers presets with Clear selected', async () => {
    render(
      <AudioRepairDialog
        open
        source={source()}
        sourceName="lecture-03.m4a"
        onApply={() => {}}
        onClose={() => {}}
      />,
    );

    expect(await screen.findByRole('radio', { name: /Clear/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Clear/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/lecture-03\.m4a/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`first ${REPAIR_PREVIEW_SECONDS} seconds`))).toBeTruthy();
    expect(screen.getByText(/keeps the original recording/i)).toBeTruthy();
  });

  it('applies the chosen preset as a 16 kHz WAV blob', async () => {
    const onApply = vi.fn();
    render(
      <AudioRepairDialog open source={source()} sourceName={null} onApply={onApply} onClose={() => {}} />,
    );

    const far = await screen.findByRole('radio', { name: /Far/ });
    fireEvent.click(far);
    expect(far.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: /Apply and use/i }));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const [blob, preset] = onApply.mock.calls[0];
    expect(preset).toBe('far');
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('audio/wav');

    // 10 s at 16 kHz, 16-bit mono, plus the 44-byte RIFF header.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes.length).toBe(44 + 10 * SAMPLE_RATE * 2);
    expect(String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3])).toBe('RIFF');
  });

  it('cannot apply the untouched original', async () => {
    const onApply = vi.fn();
    render(
      <AudioRepairDialog open source={source()} sourceName={null} onApply={onApply} onClose={() => {}} />,
    );

    fireEvent.click(await screen.findByRole('radio', { name: /Original/ }));
    const apply = screen.getByRole('button', { name: /Apply and use/i }) as HTMLButtonElement;
    expect(apply.disabled).toBe(true);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('surfaces a decode failure instead of hanging', async () => {
    decode.decodeToMono16k.mockRejectedValue(new Error('bad container'));
    const onApply = vi.fn();
    render(
      <AudioRepairDialog open source={source()} sourceName={null} onApply={onApply} onClose={() => {}} />,
    );

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('bad container');
    expect(screen.queryByRole('radio')).toBeNull();
    expect((screen.getByRole('button', { name: /Apply and use/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('stops playback when the preset changes', async () => {
    render(
      <AudioRepairDialog open source={source()} sourceName={null} onApply={() => {}} onClose={() => {}} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: /^Repaired$/ }));
    await waitFor(() => expect(window.HTMLMediaElement.prototype.play).toHaveBeenCalled());

    (window.HTMLMediaElement.prototype.pause as ReturnType<typeof vi.fn>).mockClear();
    fireEvent.click(screen.getByRole('radio', { name: /Clean/ }));
    expect(window.HTMLMediaElement.prototype.pause).toHaveBeenCalled();
  });
});
