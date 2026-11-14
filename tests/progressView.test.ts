import { describe, expect, it } from 'vitest';
import { showFullProgressCard, type ProgressViewState } from '../src/lib/progressView';

function state(over: Partial<ProgressViewState> = {}): ProgressViewState {
  return {
    active: true,
    running: true,
    failed: false,
    expanded: false,
    queued: 0,
    recording: false,
    ...over,
  };
}

describe('showFullProgressCard', () => {
  it('stays out of the way while a run is in flight', () => {
    expect(showFullProgressCard(state())).toBe(false);
    expect(showFullProgressCard(state({ queued: 2 }))).toBe(false);
  });

  it('shows nothing when there is no run and no failure', () => {
    expect(showFullProgressCard(state({ active: false, running: false }))).toBe(false);
  });

  it('opens the card for a failure that is the last thing to report', () => {
    expect(showFullProgressCard(state({ running: false, failed: true }))).toBe(true);
  });

  it('announces a failure with a toast when more work is queued', () => {
    expect(showFullProgressCard(state({ running: false, failed: true, queued: 1 }))).toBe(false);
  });

  it('never covers a live recording on its own', () => {
    expect(showFullProgressCard(state({ running: false, failed: true, recording: true }))).toBe(false);
  });

  it('honours an explicit expand, even while recording', () => {
    expect(showFullProgressCard(state({ expanded: true }))).toBe(true);
    expect(
      showFullProgressCard(state({ expanded: true, running: false, failed: true, recording: true })),
    ).toBe(true);
  });
});
