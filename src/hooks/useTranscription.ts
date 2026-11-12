import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DiarWindow,
  JobState,
  ProgressUpdate,
  Session,
  Settings,
  TranscriptSegment,
} from '../types';
import { decodeToMono16k } from '../lib/audio/decode';
import { AudioPipelineClient, type ChunkResult } from '../lib/audio/analysisClient';
import { asrClient } from '../lib/asr/client';
import { isUsableChunk, mergeChunks, mergeSpeechSegments, speakerForRange } from '../lib/audio/analysis';
import { openStreamedAudio, type AudioChunk } from '../lib/audio/stream';
import { clusterEmbeddings } from '../lib/audio/speaker';
import { modelInfo } from '../lib/models';
import { createJob, deleteJob, newId, updateJob } from '../lib/db';

export interface TranscribeSource {
  blob: Blob;
  name: string | null;
}

const CHUNK_SECONDS = 90;
const MAX_STREAM_FALLBACK_SECONDS = 60 * 60;

function titleFromSource(source: TranscribeSource): string {
  if (source.name) {
    const base = source.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').trim();
    if (base) return base.charAt(0).toUpperCase() + base.slice(1);
  }
  const now = new Date();
  const date = now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const time = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `Lecture ${date}, ${time}`;
}

function wordCount(segments: TranscriptSegment[]): number {
  return segments.reduce((total, segment) => total + segment.text.split(/\s+/).filter(Boolean).length, 0);
}

function compactPeaks(peaks: number[], target = 1200): number[] {
  if (peaks.length <= target) return peaks.map((value) => Math.min(1, value));
  const size = peaks.length / target;
  return Array.from({ length: target }, (_, index) => {
    const start = Math.floor(index * size);
    const end = Math.max(start + 1, Math.floor((index + 1) * size));
    let maximum = 0;
    for (let position = start; position < end && position < peaks.length; position += 1) {
      if (peaks[position] > maximum) maximum = peaks[position];
    }
    return Math.min(1, maximum);
  });
}

interface OpenedAudio {
  duration: number;
  sampleRate: number;
  chunks(chunkSeconds: number, from: number, signal?: AbortSignal): AsyncGenerator<AudioChunk>;
  dispose(): void;
}

/**
 * Opens the best available decoder. Mediabunny streams any container it (and
 * WebCodecs) can decode; rarer formats fall back to a one-shot browser decode.
 */
async function openAudio(blob: Blob): Promise<OpenedAudio> {
  try {
    return await openStreamedAudio(blob);
  } catch (streamError) {
    let decoded: Awaited<ReturnType<typeof decodeToMono16k>>;
    try {
      decoded = await decodeToMono16k(blob);
    } catch {
      throw new Error(
        'This audio could not be decoded. Try WAV, MP3, M4A, WebM or MP4. For long recordings, prefer MP3, WAV or M4A.',
      );
    }

    if (decoded.duration > MAX_STREAM_FALLBACK_SECONDS) {
      throw new Error(
        `This file (${Math.round(decoded.duration / 60)} min) uses a format that cannot be streamed. Convert it to MP3, M4A or WAV and try again.`,
      );
    }

    return {
      duration: decoded.duration,
      sampleRate: decoded.sampleRate,
      chunks: async function* chunks(_chunkSeconds, from) {
        if (from > 0) throw new Error('This format cannot resume from a checkpoint. Start the file again.');
        void streamError;
        yield {
          samples: decoded.samples,
          sampleRate: decoded.sampleRate,
          start: 0,
          duration: decoded.duration,
        };
      },
      dispose: () => undefined,
    };
  }
}

export function useTranscription() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressUpdate>({ stage: 'idle', progress: 0, message: '' });
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const controllerRef = useRef<AbortController | null>(null);
  const pipelineRef = useRef<AudioPipelineClient | null>(null);
  const startedRef = useRef(0);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => {
      setElapsed((performance.now() - startedRef.current) / 1000);
    }, 500);
    return () => window.clearInterval(timer);
  }, [running]);

  const report = useCallback((update: ProgressUpdate) => setProgress(update), []);

  const cancel = useCallback(() => {
    controllerRef.current?.abort();
    pipelineRef.current?.terminate();
    asrClient.terminate();
    setRunning(false);
    setProgress({ stage: 'idle', progress: 0, message: '' });
  }, []);

  const run = useCallback(
    async (source: TranscribeSource, settings: Settings, resume?: JobState | null): Promise<Session> => {
      const controller = new AbortController();
      controllerRef.current = controller;
      const pipeline = new AudioPipelineClient();
      pipelineRef.current = pipeline;
      setRunning(true);
      setError(null);
      setElapsed(0);
      startedRef.current = performance.now();

      let job: JobState | null = null;

      try {
        report({ stage: 'decode', progress: 0.05, message: 'Reading the audio…', processed: 0 });
        const audio = await openAudio(source.blob);
        if (audio.duration < 0.5) throw new Error('That recording is too short to transcribe.');
        if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');

        const jobSettings: Settings = resume
          ? {
              ...resume.settings,
              diarizeQuality: resume.settings.diarizeQuality ?? 'standard',
              diarizeEngine: resume.settings.diarizeEngine ?? 'wespeaker',
              denoiseQuality: resume.settings.denoiseQuality ?? 'neural',
            }
          : settings;
        const now = Date.now();
        job =
          resume ?? {
            id: newId(),
            title: titleFromSource(source),
            sourceName: source.name,
            createdAt: now,
            updatedAt: now,
            status: 'running',
            duration: audio.duration,
            processed: 0,
            language: jobSettings.language,
            settings: jobSettings,
            segments: [],
            speech: [],
            windows: [],
            peaks: [],
            audioMime: source.blob.type || 'audio/webm',
          };

        if (!resume) await createJob(job, source.blob);
        const jobId = job.id;

        report({
          stage: 'decode',
          progress: 0.1,
          message: 'Preparing the on-device models…',
          processed: job.processed,
          duration: audio.duration,
        });

        const active = await pipeline.configure({
          denoise: jobSettings.denoise,
          denoiseQuality: jobSettings.denoiseQuality,
          diarize: jobSettings.diarize,
          thorough: jobSettings.diarizeQuality === 'thorough',
          engine: jobSettings.diarizeEngine,
          maxSpeakers: jobSettings.maxSpeakers,
          signal: controller.signal,
          onStage: (_stage, value, message) => {
            report({
              stage: 'load',
              progress: value,
              message,
              processed: job?.processed ?? 0,
              duration: audio.duration,
            });
          },
        });

        const useDiarization = active.diarize && jobSettings.diarize;
        const from = Math.max(0, Math.min(audio.duration, job.processed));
        const segments = [...job.segments];
        const speech = [...job.speech];
        const windows: DiarWindow[] = [...job.windows];
        const peaks = [...job.peaks];
        let detectedLanguage = job.language || jobSettings.language;
        let modelReady = false;
        let processedAudio = from;

        for await (const chunk of audio.chunks(CHUNK_SECONDS, from, controller.signal)) {
          if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');

          const result: ChunkResult = await pipeline.process(chunk, controller.signal);
          if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');

          const chunkDuration = result.samples.length / 16000;
          const localSpeech = result.speech
            .map((segment) => ({
              start: Math.max(0, segment.start - result.start),
              end: Math.min(chunkDuration, segment.end - result.start),
            }))
            .filter((segment) => segment.end > segment.start);

          const blocks = mergeSpeechSegments(localSpeech, 26, 1.4);

          for (let index = 0; index < blocks.length; index += 1) {
            if (controller.signal.aborted) throw new DOMException('Cancelled', 'AbortError');

            const block = blocks[index];
            const pad = 0.1;
            const start = Math.max(0, block.start - pad);
            const end = Math.min(chunkDuration, block.end + pad);
            if (end - start < 0.2) continue;

            const audioSlice = result.samples.slice(
              Math.floor(start * 16000),
              Math.ceil(end * 16000),
            );

            report({
              stage: modelReady ? 'transcribe' : 'load',
              progress: processedAudio / audio.duration,
              message: modelReady
                ? `Transcribing ${Math.round((processedAudio / audio.duration) * 100)}% — ${Math.round(
                    processedAudio / 60,
                  )} of ${Math.round(audio.duration / 60)} min`
                : 'Loading Whisper — the model is downloaded once…',
              processed: processedAudio,
              duration: audio.duration,
            });

            const asr = await asrClient.transcribe({
              audio: audioSlice,
              model: jobSettings.model,
              device: jobSettings.device,
              language: jobSettings.language,
              signal: controller.signal,
              onStage: (stage, value, message) => {
                if (stage === 'load' && !modelReady) {
                  report({
                    stage: 'load',
                    progress: value,
                    message,
                    processed: processedAudio,
                    duration: audio.duration,
                  });
                }
              },
            });
            modelReady = true;
            detectedLanguage = asr.language || detectedLanguage;

            const blockStart = result.start + start;
            for (const part of asr.chunks) {
              if (!isUsableChunk(part.text)) continue;
              const startTime = Math.min(audio.duration, Math.max(0, blockStart + part.start));
              const endTime = Math.min(
                audio.duration,
                Math.max(startTime + 0.08, blockStart + part.end),
              );
              if (endTime <= from + 0.15) continue;
              segments.push({
                id: `${jobId}-${segments.length}`,
                start: startTime,
                end: endTime,
                text: part.text.trim(),
                speaker: -1,
                confidence: part.confidence,
              });
            }

            report({
              stage: 'transcribe',
              progress: Math.min(1, (processedAudio + block.end) / audio.duration),
              message: `Transcribing ${Math.round((processedAudio / audio.duration) * 100)}% — ${Math.round(
                processedAudio / 60,
              )} of ${Math.round(audio.duration / 60)} min`,
              processed: processedAudio,
              duration: audio.duration,
            });
          }

          for (const segment of result.speech) {
            if (segment.end > from + 0.15) speech.push(segment);
          }
          for (const window of result.windows) {
            if (window.end > from + 0.15) windows.push(window);
          }
          peaks.push(...result.peaks);

          processedAudio = Math.min(audio.duration, Math.max(processedAudio, result.end));
          job = {
            ...job,
            processed: processedAudio,
            language: detectedLanguage,
            segments,
            speech,
            windows,
            peaks,
            updatedAt: Date.now(),
          };
          await updateJob(job);

          report({
            stage: 'transcribe',
            progress: Math.min(1, processedAudio / audio.duration),
            message: `Transcribed ${Math.round(processedAudio / 60)} of ${Math.round(
              audio.duration / 60,
            )} min — saving progress`,
            processed: processedAudio,
            duration: audio.duration,
          });
        }

        audio.dispose();

        if (segments.length === 0) {
          throw new Error(
            'No speech was found in this audio. Check that the recording has voices and that the microphone was not muted.',
          );
        }

        report({
          stage: 'diarize',
          progress: 0.2,
          message: useDiarization ? 'Separating the voices…' : 'Tidying the transcript…',
          processed: processedAudio,
          duration: audio.duration,
        });

        let labels: number[] = [];
        if (useDiarization && windows.length >= 2) {
          const clustered = clusterEmbeddings(
            windows.map((window) => window.embedding),
            {
              maxSpeakers: jobSettings.maxSpeakers,
              threshold: 0.62,
              autoTune: jobSettings.diarizeQuality === 'thorough',
            },
          );
          labels = clustered.labels;
        }

        const diarWindows = windows.map((window) => ({ start: window.start, end: window.end }));
        const labelled = segments.map((segment) => ({
          ...segment,
          speaker:
            labels.length > 0
              ? speakerForRange(segment.start, segment.end, diarWindows, labels)
              : 0,
        }));

        const merged = mergeChunks(
          labelled
            .slice()
            .sort((a, b) => a.start - b.start)
            .map((segment) => ({
              text: segment.text,
              start: segment.start,
              end: segment.end,
              confidence: segment.confidence,
              speaker: segment.speaker,
            })),
        );

        if (merged.length === 0) throw new Error('Speech was detected, but no words could be recognized.');

        const finalSegments: TranscriptSegment[] = merged.map((chunk, index) => ({
          id: `${jobId}-${index}`,
          start: Math.min(chunk.start, audio.duration),
          end: Math.min(chunk.end, audio.duration),
          text: chunk.text,
          speaker: chunk.speaker,
          confidence: chunk.confidence,
        }));

        const loudest = Math.max(...peaks, 0.0001);
        const normalizedPeaks = compactPeaks(peaks.map((value) => value / loudest));
        const usedSpeakers = new Set(finalSegments.map((segment) => segment.speaker));

        const session: Session = {
          id: job.id,
          title: job.title,
          createdAt: job.createdAt,
          updatedAt: Date.now(),
          duration: audio.duration,
          language: detectedLanguage,
          model: modelInfo(jobSettings.model).label,
          speakerCount: Math.max(1, usedSpeakers.size),
          wordCount: wordCount(finalSegments),
          sourceName: source.name ?? job.sourceName,
          segments: finalSegments,
          audioBlob: source.blob,
          audioMime: source.blob.type || job.audioMime || 'audio/webm',
          peaks: normalizedPeaks,
        };

        report({ stage: 'save', progress: 0.6, message: 'Saving your transcript…' });
        await deleteJob(job.id);
        setProgress({ stage: 'done', progress: 1, message: 'Transcript ready' });
        setRunning(false);
        return session;
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') {
          if (job) {
            await updateJob({ ...job, status: 'paused', updatedAt: Date.now() }).catch(() => undefined);
          }
          setProgress({ stage: 'idle', progress: 0, message: '' });
          setRunning(false);
          throw caught;
        }

        const message = caught instanceof Error ? caught.message : 'Transcription failed.';
        if (job) {
          await updateJob({ ...job, status: 'error', error: message, updatedAt: Date.now() }).catch(
            () => undefined,
          );
        }
        setError(message);
        setProgress({ stage: 'error', progress: 0, message });
        setRunning(false);
        throw caught;
      } finally {
        pipeline.terminate();
        pipelineRef.current = null;
        controllerRef.current = null;
      }
    },
    [report],
  );

  const clear = useCallback(() => {
    setError(null);
    setProgress({ stage: 'idle', progress: 0, message: '' });
    setElapsed(0);
  }, []);

  return { running, progress, error, elapsed, run, cancel, clear };
}
