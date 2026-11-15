// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { JobStrip } from '../src/components/JobStrip';
import { setLang } from '../src/i18n';
import type { ProgressUpdate } from '../src/types';

const progress = (over: Partial<ProgressUpdate> = {}): ProgressUpdate => ({
  stage: 'transcribe',
  progress: 0.42,
  message: 'Transcribing 42% - 2 of 5 min',
  ...over,
});

function renderStrip(over: Partial<React.ComponentProps<typeof JobStrip>> = {}) {
  const props: React.ComponentProps<typeof JobStrip> = {
    progress: progress(),
    elapsed: 75,
    error: null,
    sourceName: 'lecture-02.mp3',
    batchIndex: 2,
    batchTotal: 4,
    queued: 2,
    expanded: false,
    onToggle: vi.fn(),
    onCancel: vi.fn(),
    onRetry: vi.fn(),
    onDismiss: vi.fn(),
    ...over,
  };
  const view = render(<JobStrip {...props} />);
  return { view, props };
}

beforeEach(() => {
  cleanup();
  setLang('en');
});

describe('JobStrip', () => {
  it('shows position, source, queued work, percentage and the meter', () => {
    const { view } = renderStrip();
    expect(screen.getByText('Recording 2 of 4')).toBeTruthy();
    expect(screen.getByText('2 queued')).toBeTruthy();
    expect(screen.getByText('42%')).toBeTruthy();
    expect(screen.getByText('lecture-02.mp3')).toBeTruthy();
    const fill = view.container.querySelector('.job-strip-track span') as HTMLElement;
    expect(fill.style.width).toBe('42%');
  });

  it('falls back to the pipeline message for a single recording', () => {
    renderStrip({ batchIndex: 1, batchTotal: 1, queued: 0 });
    expect(screen.getByText(/Transcribing 42%/)).toBeTruthy();
    expect(screen.queryByText(/Recording 1 of 1/)).toBeNull();
    expect(screen.queryByText(/queued/)).toBeNull();
  });

  it('opens the details panel from the toggle', () => {
    const { props } = renderStrip();
    const toggle = screen.getByRole('button', { name: 'Show transcription details' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it('renders the step-by-step card inside the panel and can collapse it', () => {
    const { props, view } = renderStrip({ expanded: true });
    expect(view.container.querySelector('.job-strip-panel .progress-card')).not.toBeNull();
    // Metrics and the cancel action belong to the expanded card, once.
    expect(view.container.querySelector('.job-strip-percent')).toBeNull();
    expect(view.container.querySelector('.job-strip-cancel')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Hide transcription details' });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Continue in the background' }));
    expect(props.onToggle).toHaveBeenCalledTimes(1);
  });

  it('reports a failure with the error and the retry action', () => {
    const { view } = renderStrip({
      expanded: true,
      progress: progress({ stage: 'error', progress: 0, message: 'Whisper crashed' }),
      error: 'Whisper crashed',
    });
    expect(screen.getAllByText('Whisper crashed').length).toBeGreaterThan(0);
    expect(view.container.querySelector('.job-strip-failed')).not.toBeNull();
    expect(view.container.querySelector('.spin')).toBeNull();
    expect(screen.queryByText(/%/)).toBeNull();
    expect(screen.getByRole('button', { name: /Try again/ })).toBeTruthy();
  });

  it('cancels the whole queue', () => {
    const { props } = renderStrip();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel all' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('says plain cancel when this is the only item', () => {
    renderStrip({ queued: 0, batchIndex: 1, batchTotal: 1 });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel all' })).toBeNull();
  });

  it('localizes the strip in Spanish', () => {
    setLang('es');
    renderStrip();
    expect(screen.getByText('Grabación 2 de 4')).toBeTruthy();
    expect(screen.getByText('2 en cola')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Mostrar el detalle de la transcripción' })).toBeTruthy();
  });
});
