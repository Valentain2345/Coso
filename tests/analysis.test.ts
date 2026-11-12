import { describe, expect, it } from 'vitest';
import { cleanChunkText, collapseRepeats } from '../src/lib/audio/analysis';

describe('collapseRepeats', () => {
  it('collapses a long single-word loop', () => {
    const text = `Intro ${Array.from({ length: 40 }, () => 'que').join(' ')} end`;
    const cleaned = collapseRepeats(text);
    expect(cleaned).toBe('Intro que que end');
  });

  it('collapses a repeated phrase and keeps the rest', () => {
    const text = `Y si no, ${Array.from({ length: 30 }, () => 'no es que').join(' ')} termina.`;
    const cleaned = collapseRepeats(text);
    expect(cleaned).toBe('Y si no, no es que no es que termina.');
  });

  it('collapses loops produced by cleanChunkText', () => {
    const text = `Bienvenidos. ${Array.from({ length: 25 }, () => 'bla bla').join(' ')}`;
    expect(cleanChunkText(text)).toBe('Bienvenidos. bla bla');
  });

  it('leaves ordinary repeated words alone', () => {
    expect(collapseRepeats('no no, eso no es correcto')).toBe('no no, eso no es correcto');
    expect(collapseRepeats('')).toBe('');
  });
});
