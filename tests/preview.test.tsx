// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { PreviewCard, PREVIEW_SECONDS } from '../src/components/PreviewCard';
import { QuickSettingsDialog } from '../src/components/QuickSettingsDialog';
import { LONG_PREVIEW_SECONDS, previewSecondsFor } from '../src/lib/preview';
import { setLang } from '../src/i18n';
import type { Settings } from '../src/types';
import type { TranscribeSource } from '../src/hooks/useTranscription';

const settings = (over: Partial<Settings> = {}): Settings => ({
  model: 'whisper-base',
  language: 'auto',
  device: 'auto',
  denoise: true,
  denoiseQuality: 'basic',
  diarize: true,
  diarizeQuality: 'standard',
  diarizeEngine: 'wespeaker',
  maxSpeakers: 4,
  theme: 'system',
  textSize: 'md',
  ...over,
});

const source = (): TranscribeSource => ({
  blob: new Blob(['fake audio'], { type: 'audio/webm' }),
  name: 'lecture-03.m4a',
});

beforeEach(() => {
  localStorage.clear();
  setLang('en');
  Object.defineProperty(window.URL, 'createObjectURL', { value: vi.fn(() => 'blob:mock'), configurable: true });
  Object.defineProperty(window.URL, 'revokeObjectURL', { value: vi.fn(), configurable: true });
});

afterEach(() => {
  cleanup();
  setLang('en');
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------ preview length */

describe('previewSecondsFor', () => {
  it('uses 5 seconds until the duration is known', () => {
    expect(previewSecondsFor(null)).toBe(PREVIEW_SECONDS);
    expect(previewSecondsFor(undefined)).toBe(PREVIEW_SECONDS);
    expect(previewSecondsFor(Number.NaN)).toBe(PREVIEW_SECONDS);
  });

  it('uses 5 seconds for short recordings', () => {
    expect(previewSecondsFor(0)).toBe(PREVIEW_SECONDS);
    expect(previewSecondsFor(30)).toBe(PREVIEW_SECONDS);
    expect(previewSecondsFor(119.9)).toBe(PREVIEW_SECONDS);
  });

  it('uses 20 seconds for long recordings', () => {
    expect(previewSecondsFor(120)).toBe(LONG_PREVIEW_SECONDS);
    expect(previewSecondsFor(45 * 60)).toBe(LONG_PREVIEW_SECONDS);
  });
});

/* --------------------------------------------------------------- PreviewCard */

describe('PreviewCard', () => {
  it('shows the source name, size and the 5-second promise', () => {
    render(<PreviewCard source={source()} onStart={() => {}} onOpenSettings={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/lecture-03\.m4a/)).toBeTruthy();
    expect(screen.getByText(/first 5 seconds/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Transcribe all/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Quick settings/i })).toBeTruthy();
  });

  it('reports the microphone as the source when the recording has no name', () => {
    render(
      <PreviewCard source={{ blob: new Blob(['x']), name: null }} onStart={() => {}} onOpenSettings={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByText(/Microphone recording/)).toBeTruthy();
  });

  it('announces the recordings queued behind this one', () => {
    render(
      <PreviewCard
        source={source()}
        queued={3}
        onStart={() => {}}
        onOpenSettings={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('3 more queued after this one.')).toBeTruthy();
  });

  it('shows no queue note for a single recording', () => {
    const view = render(
      <PreviewCard source={source()} onStart={() => {}} onOpenSettings={() => {}} onCancel={() => {}} />,
    );
    expect(view.container.querySelector('.preview-queue')).toBeNull();
  });

  it('replays from the very beginning', () => {
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
    render(<PreviewCard source={source()} onStart={() => {}} onOpenSettings={() => {}} onCancel={() => {}} />);
    const audio = document.querySelector('audio') as HTMLAudioElement;
    audio.currentTime = 4.2;
    fireEvent.click(screen.getByRole('button', { name: /Replay/i }));
    expect(play).toHaveBeenCalled();
    expect(audio.currentTime).toBe(0);
  });

  it('cuts playback off at the preview mark', () => {
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
    render(<PreviewCard source={source()} onStart={() => {}} onOpenSettings={() => {}} onCancel={() => {}} />);
    const audio = document.querySelector('audio') as HTMLAudioElement;
    audio.currentTime = 6.3;
    fireEvent(audio, new Event('timeupdate'));
    expect(pause).toHaveBeenCalled();
    expect(audio.currentTime).toBe(PREVIEW_SECONDS);
    const fill = document.querySelector('.preview-meter-fill') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('lets playback run under the mark without pausing', () => {
    const pause = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
    render(<PreviewCard source={source()} onStart={() => {}} onOpenSettings={() => {}} onCancel={() => {}} />);
    const audio = document.querySelector('audio') as HTMLAudioElement;
    audio.currentTime = 3;
    fireEvent(audio, new Event('timeupdate'));
    expect(pause).not.toHaveBeenCalled();
    const fill = document.querySelector('.preview-meter-fill') as HTMLElement;
    expect(fill.style.width).toBe('60%');
  });

  it('gives long recordings a 20 second window', () => {
    const pause = vi.fn();
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(pause);
    render(<PreviewCard source={source()} onStart={() => {}} onOpenSettings={() => {}} onCancel={() => {}} />);
    const audio = document.querySelector('audio') as HTMLAudioElement;
    Object.defineProperty(audio, 'duration', { value: 60 * 45, configurable: true });
    fireEvent(audio, new Event('loadedmetadata'));

    expect(screen.getByText(/first 20 seconds/i)).toBeTruthy();

    audio.currentTime = 25;
    fireEvent(audio, new Event('timeupdate'));
    expect(pause).toHaveBeenCalled();
    expect(audio.currentTime).toBe(LONG_PREVIEW_SECONDS);
  });

  it('starts the transcription and discards on cancel', () => {
    const onStart = vi.fn();
    const onCancel = vi.fn();
    render(<PreviewCard source={source()} onStart={onStart} onOpenSettings={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /Transcribe all/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Discard recording/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables every action while a run is busy', () => {
    render(<PreviewCard source={source()} busy onStart={() => {}} onOpenSettings={() => {}} onCancel={() => {}} />);
    for (const label of [/Replay/i, /Quick settings/i, /Transcribe all/i, /Discard recording/i]) {
      expect((screen.getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it('opens the audio repair tool and marks a repaired source', () => {
    const onRepair = vi.fn();
    const { rerender } = render(
      <PreviewCard
        source={source()}
        onStart={() => {}}
        onOpenSettings={() => {}}
        onRepair={onRepair}
        onCancel={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Repair audio/i }));
    expect(onRepair).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Repaired')).toBeNull();

    rerender(
      <PreviewCard
        source={{ ...source(), storeBlob: source().blob }}
        enhanced
        onStart={() => {}}
        onOpenSettings={() => {}}
        onRepair={onRepair}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText('Repaired')).toBeTruthy();
  });

  it('does not offer repair without a handler', () => {
    render(<PreviewCard source={source()} onStart={() => {}} onOpenSettings={() => {}} onCancel={() => {}} />);
    expect(screen.queryByRole('button', { name: /Repair audio/i })).toBeNull();
  });
});

/* -------------------------------------------------------- QuickSettingsDialog */

describe('QuickSettingsDialog', () => {
  it('shows the preview-mode title and start label', () => {
    render(
      <QuickSettingsDialog open mode="preview" settings={settings()} onChange={() => {}} onStart={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByText('Quick settings')).toBeTruthy();
    expect(screen.getByText('Start transcribing')).toBeTruthy();
  });

  it('shows the reprocess-mode title and label', () => {
    render(
      <QuickSettingsDialog open mode="reprocess" settings={settings()} onChange={() => {}} onStart={() => {}} onClose={() => {}} />,
    );
    expect(screen.getByText('Re-transcribe')).toBeTruthy();
    expect(screen.getByText('Re-transcribe now')).toBeTruthy();
  });

  it('changes the model and spoken language upward', () => {
    const onChange = vi.fn();
    render(
      <QuickSettingsDialog open mode="preview" settings={settings()} onChange={onChange} onStart={() => {}} onClose={() => {}} />,
    );
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'whisper-small' } });
    expect(onChange).toHaveBeenCalledWith({ model: 'whisper-small' });
    fireEvent.change(screen.getByLabelText('Spoken language'), { target: { value: 'es' } });
    expect(onChange).toHaveBeenCalledWith({ language: 'es' });
  });

  it('picks the noise level from the segmented control', () => {
    const onChange = vi.fn();
    render(
      <QuickSettingsDialog open mode="preview" settings={settings()} onChange={onChange} onStart={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Neural/i }));
    expect(onChange).toHaveBeenCalledWith({ denoise: true, denoiseQuality: 'neural' });
  });

  it('picks speaker precision from the segmented control', () => {
    const onChange = vi.fn();
    render(
      <QuickSettingsDialog open mode="reprocess" settings={settings()} onChange={onChange} onStart={() => {}} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Thorough/i }));
    expect(onChange).toHaveBeenCalledWith({ diarize: true, diarizeQuality: 'thorough' });
  });

  it('starts and closes through its footer buttons', () => {
    const onStart = vi.fn();
    const onClose = vi.fn();
    render(
      <QuickSettingsDialog open mode="preview" settings={settings()} onChange={() => {}} onStart={onStart} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Start transcribing/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('offers the repair preset only when re-transcribing', () => {
    const { rerender } = render(
      <QuickSettingsDialog open mode="preview" settings={settings()} onChange={() => {}} onStart={() => {}} onClose={() => {}} />,
    );
    expect(screen.queryByLabelText('Audio repair')).toBeNull();

    rerender(
      <QuickSettingsDialog
        open
        mode="reprocess"
        settings={settings()}
        repair="off"
        onChange={() => {}}
        onRepairChange={() => {}}
        onStart={() => {}}
        onClose={() => {}}
      />,
    );
    expect((screen.getByLabelText('Audio repair') as HTMLSelectElement).value).toBe('off');
  });

  it('reports the chosen repair preset upward', () => {
    const onRepairChange = vi.fn();
    render(
      <QuickSettingsDialog
        open
        mode="reprocess"
        settings={settings()}
        repair="off"
        onChange={() => {}}
        onRepairChange={onRepairChange}
        onStart={() => {}}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText('Audio repair'), { target: { value: 'far' } });
    expect(onRepairChange).toHaveBeenCalledWith('far');
    expect((screen.getByLabelText('Audio repair') as HTMLSelectElement).options.length).toBe(4);
  });
});
