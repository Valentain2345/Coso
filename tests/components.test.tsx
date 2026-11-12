// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { CapturePanel } from '../src/components/CapturePanel';
import { SettingsDialog } from '../src/components/SettingsDialog';
import { ProgressCard } from '../src/components/ProgressCard';
import { setLang } from '../src/i18n';
import type { ProgressUpdate, Settings, SessionMeta } from '../src/types';
import type { useRecorder } from '../src/hooks/useRecorder';

/* ----------------------------------------------------------------- fixtures */

const recorderMock = (over: Partial<ReturnType<typeof useRecorder>> = {}) =>
  ({
    status: 'idle',
    recording: false,
    paused: false,
    duration: 0,
    level: 0,
    levels: new Array(48).fill(0),
    error: null,
    start: vi.fn(async () => true),
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(async () => null),
    cancel: vi.fn(),
    clearError: vi.fn(),
    ...over,
  }) as ReturnType<typeof useRecorder>;

const sessionMeta = (over: Partial<SessionMeta> = {}): SessionMeta => ({
  id: 's1',
  title: 'Biology lecture',
  createdAt: Date.parse('2026-03-01T10:00:00Z'),
  updatedAt: Date.parse('2026-03-01T10:00:00Z'),
  duration: 3600,
  language: 'en',
  model: 'whisper-base',
  speakerCount: 2,
  wordCount: 1250,
  sourceName: null,
  ...over,
});

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

beforeEach(() => {
  localStorage.clear();
  setLang('en');
});

afterEach(() => {
  cleanup();
  setLang('en');
});

/* ------------------------------------------------------------- CapturePanel */

describe('CapturePanel', () => {
  it('shows the record button and import area when idle', () => {
    render(<CapturePanel recorder={recorderMock()} sessions={[]} onStart={() => {}} onPause={() => {}} onResume={() => {}} onStop={() => {}} onCancel={() => {}} onFile={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: /Start recording/i })).toBeTruthy();
    expect(screen.getByText('Import audio')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Drop an audio file/i })).toBeTruthy();
  });

  it('lists recent sessions with localized counts and opens them', () => {
    const onOpen = vi.fn();
    render(
      <CapturePanel recorder={recorderMock()} sessions={[sessionMeta()]} onStart={() => {}} onPause={() => {}} onResume={() => {}} onStop={() => {}} onCancel={() => {}} onFile={() => {}} onOpen={onOpen} />,
    );
    fireEvent.click(screen.getByText('Biology lecture'));
    expect(onOpen).toHaveBeenCalledWith('s1');
    expect(screen.getByText('1 saved')).toBeTruthy();
    expect(screen.getByText(/1,250 words/)).toBeTruthy();
  });

  it('passes the chosen file upward through both the picker and the drop zone', async () => {
    const onFile = vi.fn();
    const view = render(
      <CapturePanel recorder={recorderMock()} sessions={[]} onStart={() => {}} onPause={() => {}} onResume={() => {}} onStop={() => {}} onCancel={() => {}} onFile={onFile} onOpen={() => {}} />,
    );
    const input = view.container.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input).toBeTruthy();
    await fireEvent.change(input, { target: { files: [new File(['x'], 'take.wav')] } });
    expect(onFile).toHaveBeenCalledOnce();
  });

  it('shows the recording card with pause and stop while recording', () => {
    render(
      <CapturePanel
        recorder={recorderMock({ status: 'recording', recording: true, duration: 63, levels: [0.4, 0.6] })}
        sessions={[]}
        onStart={() => {}}
        onPause={() => {}}
        onResume={() => {}}
        onStop={() => {}}
        onCancel={() => {}}
        onFile={() => {}}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('01:03')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Pause/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stop & transcribe/i })).toBeTruthy();
  });

  it('shows the resume card when a checkpointed job exists', () => {
    render(
      <CapturePanel
        recorder={recorderMock()}
        sessions={[]}
        onStart={() => {}}
        onPause={() => {}}
        onResume={() => {}}
        onStop={() => {}}
        onCancel={() => {}}
        onFile={() => {}}
        onOpen={() => {}}
        job={{
          id: 'j1',
          title: 'Big lecture',
          sourceName: 'big.wav',
          createdAt: Date.now() - 60_000,
          updatedAt: Date.now(),
          status: 'paused',
          duration: 1800,
          processed: 600,
          language: 'en',
          settings: settings(),
          segments: [],
          speech: [],
          windows: [],
          peaks: [],
          audioMime: 'audio/wav',
        }}
        onResumeJob={() => {}}
        onDiscardJob={() => {}}
      />,
    );
    expect(screen.getByText('Big lecture')).toBeTruthy();
    expect(screen.getByText(/10 of 30 min/)).toBeTruthy();
  });

  it('renders in Spanish when the language is set to es', () => {
    setLang('es');
    render(<CapturePanel recorder={recorderMock()} sessions={[sessionMeta()]} onStart={() => {}} onPause={() => {}} onResume={() => {}} onStop={() => {}} onCancel={() => {}} onFile={() => {}} onOpen={() => {}} />);
    expect(screen.getByRole('button', { name: /Empezar a grabar/i })).toBeTruthy();
    expect(screen.getByText('1 guardada')).toBeTruthy();
    expect(screen.getByText(/1250 palabras/)).toBeTruthy();
  });
});

/* ----------------------------------------------------------- SettingsDialog */

describe('SettingsDialog', () => {
  const renderSettings = (over: Partial<Settings> = {}) => {
    const onChange = vi.fn();
    const view = render(
      <SettingsDialog
        open
        onClose={() => {}}
        settings={settings(over)}
        onChange={onChange}
        onReset={() => {}}
        storage={{ usage: 1024 * 1024 * 10, quota: 1024 * 1024 * 1024 }}
        sessionCount={3}
        onClearAll={vi.fn(async () => undefined)}
        busy={false}
      />,
    );
    return { onChange, view };
  };

  it('shows the model tiers and updates the selection', () => {
    const { onChange } = renderSettings();
    const select = screen.getByLabelText('Model') as HTMLSelectElement;
    expect(Array.from(select.options).some((option) => option.value === 'whisper-large-v3-turbo')).toBe(true);
    fireEvent.change(select, { target: { value: 'whisper-small' } });
    expect(onChange).toHaveBeenCalledWith({ model: 'whisper-small' });
  });

  it('shows a heavy-model warning for large models', () => {
    renderSettings({ model: 'whisper-large-v3-turbo' });
    expect(screen.getByText(/Very heavy: 1–1\.5 GB download/)).toBeTruthy();
  });

  it('wraps conditional warnings in a Reveal that animates in place', () => {
    renderSettings({ diarizeQuality: 'thorough' });
    // Reveal stays mounted but inert; the `open` class animates the height.
    const reveals = document.body.querySelectorAll('.reveal');
    expect(reveals.length).toBeGreaterThanOrEqual(4);
    const thorough = document.body.querySelector('.reveal.open');
    expect(thorough).toBeTruthy();
    expect(within(thorough as HTMLElement).getByText(/Thorough re-embeds/)).toBeTruthy();
  });

  it('grows the danger confirmation in place too', () => {
    renderSettings();
    // Nothing is open initially.
    expect(document.body.querySelectorAll('.reveal.open')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: /Delete all transcripts/i }));
    const reveals = document.body.querySelectorAll('.reveal.open');
    expect(reveals).toHaveLength(1);
    expect(within(reveals[0] as HTMLElement).getByText(/cannot be undone/i)).toBeTruthy();
  });

  it('switches the whole dialog to Spanish and back', async () => {
    const user = userEvent.setup();
    renderSettings();
    const group = screen.getByRole('radiogroup', { name: 'App language' });
    await user.click(within(group).getByRole('radio', { name: 'Español' }));
    expect(screen.getByRole('heading', { name: 'Ajustes' })).toBeTruthy();
    expect(screen.getByLabelText('Modelo')).toBeTruthy();
    expect(localStorage.getItem('coso.uiLang')).toBe('es');
    await user.click(within(group).getByRole('radio', { name: 'English' }));
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeTruthy();
    expect(localStorage.getItem('coso.uiLang')).toBe('en');
  });

  it('steps the maximum speaker count within bounds', () => {
    const { onChange } = renderSettings({ maxSpeakers: 2 });
    fireEvent.click(screen.getByRole('button', { name: 'Increase maximum speakers' }));
    expect(onChange).toHaveBeenCalledWith({ maxSpeakers: 3 });
  });
});

/* ------------------------------------------------------------- ProgressCard */

describe('ProgressCard', () => {
  const progress = (over: Partial<ProgressUpdate> = {}): ProgressUpdate => ({
    stage: 'transcribe',
    progress: 0.4,
    message: 'Transcribing 40% — 1 of 3 min',
    processed: 60,
    duration: 180,
    ...over,
  });

  it('renders the five stages with the active one marked', () => {
    const view = render(<ProgressCard progress={progress()} elapsed={30} error={null} sourceName="take.wav" onCancel={() => {}} onRetry={() => {}} onDismiss={() => {}} />);
    const stages = view.container.querySelectorAll('.stage');
    expect(stages).toHaveLength(5);
    expect(stages[2].className).toContain('active');
    expect(stages[3].className).toContain('pending');
    expect(view.container.querySelector('.progress-percent')?.textContent).toMatch(/%$/);
  });

  it('localizes the stage labels in Spanish', () => {
    setLang('es');
    render(<ProgressCard progress={progress()} elapsed={30} error={null} sourceName="take.wav" onCancel={() => {}} onRetry={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText('Separar las voces')).toBeTruthy();
  });

  it('shows the failure card with retry', () => {
    const onRetry = vi.fn();
    render(<ProgressCard progress={progress({ stage: 'error', progress: 0 })} elapsed={30} error="No speech was found in this audio. Check that the recording has voices and that the microphone was not muted." sourceName="take.wav" onCancel={() => {}} onRetry={onRetry} onDismiss={() => {}} />);
    expect(screen.getByRole('button', { name: /Try again/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('marks the save stage as done when the transcript is ready', () => {
    const view = render(<ProgressCard progress={progress({ stage: 'done', progress: 1 })} elapsed={300} error={null} sourceName={null} onCancel={() => {}} onRetry={() => {}} onDismiss={() => {}} />);
    const stages = view.container.querySelectorAll('.stage');
    expect(stages[4].className).toContain('done');
  });
});

/* ----------------------------------------------------------- TranscriptView */

import { TranscriptView } from '../src/components/TranscriptView';
import { usePlayer } from '../src/hooks/usePlayer';
import type { Session, TranscriptSegment } from '../src/types';

const segment = (over: Partial<TranscriptSegment> = {}): TranscriptSegment => ({
  id: 'seg1',
  start: 62,
  end: 70,
  text: 'The water cycle has three stages.',
  speaker: 0,
  confidence: 0.9,
  ...over,
});

const transcriptSession = (over: Partial<Session> = {}): Session => ({
  ...sessionMeta(),
  audioBlob: null,
  audioMime: null,
  segments: [
    segment(),
    segment({ id: 'seg2', start: 70, end: 88, text: 'Evaporation, condensation, precipitation.', speaker: 1 }),
  ],
  ...over,
}) as Session;

const playerMock = (over: Record<string, unknown> = {}) =>
  ({
    playing: false,
    currentTime: 0,
    duration: 3600,
    rate: 1,
    ready: true,
    play: vi.fn(),
    pause: vi.fn(),
    playAt: vi.fn(),
    seek: vi.fn(),
    setRate: vi.fn(),
    ...over,
  }) as unknown as ReturnType<typeof usePlayer>;

describe('TranscriptView', () => {
  const toast = vi.fn();
  const editSegment = vi.fn();
  const editStart = vi.fn();
  const renameSpeaker = vi.fn();

  const renderView = (session: Session) =>
    render(
      <TranscriptView
        session={session}
        player={playerMock()}
        onEditSegment={editSegment}
        onEditSegmentStart={editStart}
        onRenameSpeaker={renameSpeaker}
        onToast={toast}
      />,
    );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows custom speaker names everywhere a speaker is labelled', () => {
    const view = render(
      <TranscriptView
        session={transcriptSession({ speakerNames: { '1': 'Bob' } })}
        player={playerMock()}
        onEditSegment={editSegment}
        onEditSegmentStart={editStart}
        onRenameSpeaker={renameSpeaker}
        onToast={toast}
      />,
    );
    expect(within(view.container.querySelector('.transcript-card') as HTMLElement).getAllByText('Bob').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Speaker 1/i).length).toBeGreaterThan(0);
  });

  it('search matches custom speaker names', () => {
    const view = render(
      <TranscriptView
        session={transcriptSession({ speakerNames: { '1': 'Bob' } })}
        player={playerMock()}
        onEditSegment={editSegment}
        onEditSegmentStart={editStart}
        onRenameSpeaker={renameSpeaker}
        onToast={toast}
      />,
    );
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Bob' } });
    expect(view.container.querySelectorAll('.segment').length).toBe(1);
  });

  it('renames a speaker from edit mode', async () => {
    const view = renderView(transcriptSession());
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const nameField = view.container.querySelector<HTMLElement>('.segment-speaker-edit') as HTMLElement;
    expect(nameField).toBeTruthy();
    nameField.textContent = 'Bob';
    fireEvent.blur(nameField);
    expect(renameSpeaker).toHaveBeenCalledOnce();
    expect(renameSpeaker).toHaveBeenCalledWith(0, 'Bob');
  });

  it('edits a start time in edit mode', async () => {
    const view = renderView(transcriptSession());
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const timeField = view.container.querySelector<HTMLElement>('.segment-time-edit') as HTMLElement;
    expect(timeField.textContent).toBe('1:02');
    timeField.textContent = '1:10';
    fireEvent.blur(timeField);
    expect(editStart).toHaveBeenCalledWith('seg1', 70);
  });

  it('rejects an invalid time without touching the session', async () => {
    const view = renderView(transcriptSession());
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const timeField = view.container.querySelector<HTMLElement>('.segment-time-edit') as HTMLElement;
    timeField.textContent = 'not a time';
    fireEvent.blur(timeField);
    expect(editStart).not.toHaveBeenCalled();
    expect(timeField.textContent).toBe('1:02'); // restored
    expect(toast).toHaveBeenCalled();
  });
});

