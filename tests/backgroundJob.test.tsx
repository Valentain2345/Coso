// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { BackgroundJobBar } from '../src/components/BackgroundJobBar';
import { setLang } from '../src/i18n';
import type { ProgressUpdate } from '../src/types';

const progress = (over: Partial<ProgressUpdate> = {}): ProgressUpdate => ({
  stage: 'transcribe',
  progress: 0.42,
  message: 'Transcribing 42% - 2 of 5 min',
  ...over,
});

function renderBar(over: Partial<React.ComponentProps<typeof BackgroundJobBar>> = {}) {
  const props: React.ComponentProps<typeof BackgroundJobBar> = {
    progress: progress(),
    sourceName: 'lecture-02.mp3',
    batchIndex: 2,
    batchTotal: 4,
    queued: 2,
    expanded: false,
    onToggle: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  const view = render(<BackgroundJobBar {...props} />);
  return { view, props };
}

beforeEach(() => {
  cleanup();
  setLang('en');
});

describe('BackgroundJobBar', () => {
  it('shows the position in the run, the queued work and the percentage', () => {
    renderBar();
    expect(screen.getByText('Recording 2 of 4')).toBeTruthy();
    expect(screen.getByText('2 queued')).toBeTruthy();
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByText('lecture-02.mp3')).toBeTruthy();
  });

  it('falls back to the pipeline message for a single recording', () => {
    renderBar({ batchIndex: 1, batchTotal: 1, queued: 0 });
    expect(screen.getByText(/Transcribing 42%/)).toBeTruthy();
    expect(screen.queryByText(/Recording 1 of 1/)).toBeNull();
    expect(screen.queryByText(/queued/)).toBeNull();
  });

  it('opens the full progress card from the details button', () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Show transcription details' }));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it('offers to collapse when the card is expanded', () => {
    renderBar({ expanded: true });
    const button = screen.getByRole('button', { name: 'Hide transcription details' });
    expect(button.textContent).toContain('Hide');
  });

  it('cancels the whole queue', () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('does not show a percentage or a spinner after a failure', () => {
    const { view } = renderBar({
      progress: progress({ stage: 'error', progress: 0, message: 'Whisper crashed' }),
    });
    expect(screen.queryByText(/%/)).toBeNull();
    expect(view.container.querySelector('.spin')).toBeNull();
  });

  it('localizes the compact bar in Spanish', () => {
    setLang('es');
    renderBar();
    expect(screen.getByText('Grabación 2 de 4')).toBeTruthy();
    expect(screen.getByText('2 en cola')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mostrar el detalle de la transcripción' })).toBeTruthy();
  });
});
