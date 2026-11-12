import React, { useEffect, useMemo, useRef } from 'react';
import { Download, Gauge, Pause, Play, RotateCcw, RotateCw } from 'lucide-react';
import type { Session } from '../types';
import type { usePlayer } from '../hooks/usePlayer';
import { useI18n } from '../i18n';
import { timestamp } from './ui/primitives';

interface Props {
  session: Session;
  player: ReturnType<typeof usePlayer>;
  onDownload?: () => void;
}

const RATES = [1, 1.25, 1.5, 2, 0.75] as const;

function resamplePeaks(peaks: number[] | undefined, count = 128): number[] {
  if (!peaks || peaks.length === 0) return new Array(count).fill(0.08);
  if (peaks.length <= count) {
    const ratio = count / peaks.length;
    return Array.from({ length: count }, (_, index) => peaks[Math.min(peaks.length - 1, Math.floor(index / ratio))]);
  }
  const buckets = Math.floor(peaks.length / count);
  return Array.from({ length: count }, (_, index) => {
    const start = index * buckets;
    let max = 0;
    for (let cursor = start; cursor < start + buckets && cursor < peaks.length; cursor += 1) {
      if (peaks[cursor] > max) max = peaks[cursor];
    }
    return max;
  });
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export const PlayerBar: React.FC<Props> = ({ session, player, onDownload }) => {
  const { t } = useI18n();
  const waveRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const bars = useMemo(() => resamplePeaks(session.peaks), [session.peaks]);
  const duration = player.duration || session.duration || 1;
  const played = Math.min(1, Math.max(0, player.currentTime / duration));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.code === 'Space') {
        event.preventDefault();
        player.toggle();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        player.skip(-5);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        player.skip(5);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [player]);

  const seekFromPointer = (clientX: number) => {
    const element = waveRef.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    player.seek(ratio * duration);
  };

  const nextRate = () => {
    const index = RATES.indexOf(player.rate as (typeof RATES)[number]);
    player.setRate(RATES[(index + 1) % RATES.length]);
  };

  return (
    <div className="player" role="region" aria-label={t('player.region')}>
      <div className="player-controls">
        <button className="icon-btn player-skip" onClick={() => player.skip(-10)} aria-label={t('player.back10')} title={t('player.back10')}>
          <RotateCcw size={17} />
        </button>
        <button
          className="player-play"
          onClick={player.toggle}
          aria-label={player.playing ? t('player.pause') : t('player.play')}
        >
          {player.playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
        </button>
        <button className="icon-btn player-skip" onClick={() => player.skip(10)} aria-label={t('player.forward10')} title={t('player.forward10')}>
          <RotateCw size={17} />
        </button>
      </div>

      <div className="player-time">
        <span>{timestamp(player.currentTime)}</span>
        <span className="player-time-sep">/</span>
        <span>{timestamp(duration)}</span>
      </div>

      <div
        ref={waveRef}
        className="player-wave"
        role="slider"
        tabIndex={0}
        aria-label={t('player.seek')}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(player.currentTime)}
        aria-valuetext={`${timestamp(player.currentTime)} / ${timestamp(duration)}`}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            player.skip(-5);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            player.skip(5);
          } else if (event.key === 'Home') {
            event.preventDefault();
            player.seek(0);
          } else if (event.key === 'End') {
            event.preventDefault();
            player.seek(duration);
          }
        }}
        onPointerDown={(event) => {
          draggingRef.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
          seekFromPointer(event.clientX);
        }}
        onPointerMove={(event) => {
          if (draggingRef.current) seekFromPointer(event.clientX);
        }}
        onPointerUp={(event) => {
          draggingRef.current = false;
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      >
        <div className="wave-bars" aria-hidden="true">
          {bars.map((value, index) => (
            <span
              key={index}
              className={index / bars.length <= played ? 'played' : ''}
              style={{ height: `${Math.max(4, Math.round(Math.pow(value, 0.72) * 100))}%` }}
            />
          ))}
        </div>
      </div>

      <button className="rate-btn" onClick={nextRate} aria-label={t('player.speed.aria', { rate: player.rate })}>
        <Gauge size={15} />
        {player.rate === 1 ? '1×' : `${player.rate}×`}
      </button>

      {onDownload && (
        <button
          className="icon-btn player-download"
          onClick={onDownload}
          aria-label={t('player.download')}
          title={t('player.download.title')}
        >
          <Download size={17} />
        </button>
      )}
    </div>
  );
};
