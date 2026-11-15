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
import { REPAIR_PRESETS } from '../src/lib/audio/enhance';

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
    const [blob, options, preset] = onApply.mock.calls[0];
    expect(preset).toBe('far');
    expect(options).toEqual(REPAIR_PRESETS.far);
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

  it('keeps fine tuning collapsed until asked', async () => {
    render(
      <AudioRepairDialog open source={source()} sourceName={null} onApply={() => {}} onClose={() => {}} />,
    );

    await screen.findByRole('radio', { name: /Clear/ });
    expect(screen.queryByLabelText('Mains hum')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Fine-tune/ }));
    expect(screen.getByRole('combobox', { name: 'Mains hum' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Noise reduction' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Sibilance' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Clarity' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Warmth' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Quiet the gaps' })).toBeTruthy();
    expect(screen.getByRole('switch', { name: 'Even out levels' })).toBeTruthy();
  });

  it('applies a fine-tuned custom profile with the inherited preset values', async () => {
    const onApply = vi.fn();
    render(
      <AudioRepairDialog open source={source()} sourceName={null} onApply={onApply} onClose={() => {}} />,
    );

    await screen.findByRole('radio', { name: /Clear/ });
    fireEvent.click(screen.getByRole('radio', { name: /Clean/ }));
    fireEvent.click(screen.getByRole('button', { name: /Fine-tune/ }));
    fireEvent.change(screen.getByRole('slider', { name: 'Clarity' }), { target: { value: '6' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Mains hum' }), {
      target: { value: '60' },
    });
    fireEvent.click(screen.getByRole('switch', { name: 'Quiet the gaps' }));

    // The preset grid no longer claims a built-in profile.
    expect(screen.getByText('Custom')).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Clean/ }).getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: /Apply and use/i }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const [, options, preset] = onApply.mock.calls[0];
    expect(preset).toBe('custom');
    expect(options.presenceDb).toBe(6);
    expect(options.hum).toBe('60');
    expect(options.gate).toBe(true);
    // Everything the user did not touch still comes from the Clean preset.
    expect(options.denoiseStrength).toBe(REPAIR_PRESETS.clean.denoiseStrength);
    expect(options.targetRmsDb).toBe(REPAIR_PRESETS.clean.targetRmsDb);
  });

  it('resets the fine tuning back to the preset it started from', async () => {
    render(
      <AudioRepairDialog open source={source()} sourceName={null} onApply={() => {}} onClose={() => {}} />,
    );

    await screen.findByRole('radio', { name: /Clear/ });
    fireEvent.click(screen.getByRole('button', { name: /Fine-tune/ }));
    fireEvent.change(screen.getByRole('slider', { name: 'Clarity' }), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /Back to Clear/ }));

    expect(screen.getByRole('radio', { name: /Clear/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByText('Custom')).toBeNull();
  });

  it('will not apply a custom profile that changes nothing', async () => {
    render(
      <AudioRepairDialog open source={source()} sourceName={null} onApply={() => {}} onClose={() => {}} />,
    );

    fireEvent.click(await screen.findByRole('radio', { name: /Original/ }));
    fireEvent.click(screen.getByRole('button', { name: /Fine-tune/ }));
    const gate = screen.getByRole('switch', { name: 'Quiet the gaps' });
    fireEvent.click(gate);
    fireEvent.click(gate);

    expect(screen.getByText(/Nothing is being changed yet/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: /Apply and use/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows the measured noise floor, average and peak for both versions', async () => {
    render(
      <AudioRepairDialog open source={source()} sourceName={null} onApply={() => {}} onClose={() => {}} />,
    );

    await screen.findByRole('radio', { name: /Clear/ });
    const meter = await screen.findByRole('group', { name: 'Before and after measurements' });
    expect(meter.textContent).toContain('Noise floor');
    expect(meter.textContent).toContain('Average');
    expect(meter.textContent).toContain('Peak');
    expect(meter.textContent).toContain('Repaired');
    // Values are rendered in dBFS; the original test tone peaks near -14 dB.
    expect(meter.textContent).toContain('-14 dB');
    expect(meter.textContent).toMatch(/-?\d+ dB/);
  });
});
