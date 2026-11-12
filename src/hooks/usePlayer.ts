import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '../types';

export type PlaybackRate = 0.75 | 1 | 1.25 | 1.5 | 2;

export function usePlayer(session: Session | null) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRateState] = useState<PlaybackRate>(1);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!session?.audioBlob) {
      setReady(false);
      setDuration(session?.duration ?? 0);
      return;
    }

    const url = URL.createObjectURL(session.audioBlob);
    urlRef.current = url;
    const audio = new Audio();
    audio.preload = 'metadata';
    audio.src = url;
    audio.playbackRate = rate;
    audioRef.current = audio;
    setPlaying(false);
    setCurrentTime(0);
    setDuration(session.duration || 0);
    setReady(true);

    const onTime = () => setCurrentTime(audio.currentTime);
    const onMeta = () => setDuration(Number.isFinite(audio.duration) ? audio.duration : session.duration);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setCurrentTime(audio.duration || session.duration);
    };

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('play', onPlay);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('ended', onEnded);

    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('ended', onEnded);
      audio.pause();
      audio.src = '';
      audioRef.current = null;
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
    // Recreate only when the audio payload changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, session?.audioBlob]);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      await audio.play();
    } catch {
      /* autoplay may be blocked until a direct gesture */
    }
  }, []);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void play();
    else audio.pause();
  }, [play]);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const bounded = Math.max(0, Math.min(Number.isFinite(audio.duration) ? audio.duration : time, time));
    audio.currentTime = bounded;
    setCurrentTime(bounded);
  }, []);

  const playAt = useCallback(
    (time: number) => {
      seek(time);
      void play();
    },
    [play, seek],
  );

  const skip = useCallback(
    (delta: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      seek(audio.currentTime + delta);
    },
    [seek],
  );

  const setRate = useCallback((next: PlaybackRate) => {
    setRateState(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
  }, []);

  return {
    available: Boolean(session?.audioBlob),
    ready,
    playing,
    currentTime,
    duration: duration || session?.duration || 0,
    rate,
    play,
    pause,
    toggle,
    seek,
    playAt,
    skip,
    setRate,
  };
}
