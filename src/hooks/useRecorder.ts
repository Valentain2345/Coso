import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'paused' | 'denied' | 'unsupported';

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  duration: number;
}

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
];

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

export function useRecorder() {
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [duration, setDuration] = useState(0);
  const [level, setLevel] = useState(0);
  const [levels, setLevels] = useState<number[]>(() => new Array(48).fill(0));
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const startRef = useRef(0);
  const pausedTotalRef = useRef(0);
  const pauseStartRef = useRef<number | null>(null);
  const statusRef = useRef<RecorderStatus>('idle');
  const stopResolveRef = useRef<((result: RecordingResult | null) => void) | null>(null);

  statusRef.current = status;

  const elapsed = useCallback(() => {
    if (!startRef.current) return 0;
    const now = performance.now();
    const paused = pausedTotalRef.current + (pauseStartRef.current ? now - pauseStartRef.current : 0);
    return Math.max(0, (now - startRef.current - paused) / 1000);
  }, []);

  const teardown = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    analyserRef.current = null;
    dataRef.current = null;
    void audioContextRef.current?.close();
    audioContextRef.current = null;
    recorderRef.current = null;
    startRef.current = 0;
    pausedTotalRef.current = 0;
    pauseStartRef.current = null;
    setLevel(0);
  }, []);

  useEffect(() => {
    const supported =
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices?.getUserMedia &&
      typeof MediaRecorder !== 'undefined';
    if (!supported) setStatus('unsupported');
    return () => {
      stopResolveRef.current?.(null);
      teardown();
    };
  }, [teardown]);

  const start = useCallback(async (): Promise<boolean> => {
    if (statusRef.current === 'recording' || statusRef.current === 'requesting') return false;
    setError(null);
    setStatus('requesting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      streamRef.current = stream;

      const context = new AudioContext();
      audioContextRef.current = context;
      if (context.state === 'suspended') await context.resume();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.75;
      source.connect(analyser);
      analyserRef.current = analyser;
      dataRef.current = new Float32Array(analyser.fftSize);

      const mimeType = pickMime();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined);
      recorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const type = recorder.mimeType || chunksRef.current[0]?.type || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        const result: RecordingResult | null = blob.size > 0 ? { blob, mimeType: type, duration: elapsed() } : null;
        stopResolveRef.current?.(result);
        stopResolveRef.current = null;
        teardown();
      };

      recorder.start(250);
      startRef.current = performance.now();
      pausedTotalRef.current = 0;
      pauseStartRef.current = null;
      setDuration(0);
      setLevels(new Array(48).fill(0));
      setStatus('recording');

      timerRef.current = window.setInterval(() => {
        setDuration(elapsed());
        const analyserNode = analyserRef.current;
        const data = dataRef.current;
        if (analyserNode && data) {
          analyserNode.getFloatTimeDomainData(data);
          let sum = 0;
          for (let index = 0; index < data.length; index += 1) sum += data[index] * data[index];
          const rms = Math.sqrt(sum / data.length);
          const normalized = Math.min(1, rms * 7);
          setLevel(normalized);
          setLevels((previous) => [...previous.slice(1), normalized]);
        }
      }, 90);

      return true;
    } catch (caught) {
      teardown();
      setStatus('idle');
      const message =
        caught instanceof DOMException && (caught.name === 'NotAllowedError' || caught.name === 'SecurityError')
          ? t('recorder.denied')
          : caught instanceof Error
            ? caught.message
            : t('recorder.generic');
      setError(message);
      if (caught instanceof DOMException && caught.name === 'NotAllowedError') setStatus('denied');
      return false;
    }
  }, [elapsed, teardown]);

  const pause = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'recording') return;
    recorder.pause();
    pauseStartRef.current = performance.now();
    setStatus('paused');
    setLevel(0);
  }, []);

  const resume = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== 'paused') return;
    recorder.resume();
    if (pauseStartRef.current) {
      pausedTotalRef.current += performance.now() - pauseStartRef.current;
      pauseStartRef.current = null;
    }
    setStatus('recording');
  }, []);

  const stop = useCallback(async (): Promise<RecordingResult | null> => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return null;
    setStatus('idle');
    return new Promise<RecordingResult | null>((resolve) => {
      stopResolveRef.current = resolve;
      try {
        recorder.stop();
      } catch {
        stopResolveRef.current = null;
        teardown();
        resolve(null);
      }
    });
  }, [teardown]);

  const cancel = useCallback(() => {
    const recorder = recorderRef.current;
    chunksRef.current = [];
    stopResolveRef.current = null;
    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = null;
      try {
        recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    teardown();
    setStatus('idle');
    setDuration(0);
  }, [teardown]);

  const clearError = useCallback(() => setError(null), []);

  return {
    status,
    recording: status === 'recording',
    paused: status === 'paused',
    duration,
    level,
    levels,
    error,
    start,
    pause,
    resume,
    stop,
    cancel,
    clearError,
  };
}
