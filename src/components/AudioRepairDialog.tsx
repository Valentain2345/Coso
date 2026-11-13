import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Pause, Play, Wand2 } from 'lucide-react';
import { useI18n } from '../i18n';
import { decodeToMono16k } from '../lib/audio/decode';
import { encodeWav } from '../lib/audio/dsp';
import { REPAIR_PRESETS, repairSamples, type RepairPresetId } from '../lib/audio/enhance';
import { Modal } from './ui/Modal';

/** How many seconds of audio the A/B comparison plays. */
export const REPAIR_PREVIEW_SECONDS = 8;

interface Props {
  open: boolean;
  source: Blob | null;
  sourceName: string | null;
  onApply: (blob: Blob, preset: RepairPresetId) => void;
  onClose: () => void;
}

const PRESETS: RepairPresetId[] = ['off', 'clean', 'clear', 'far'];

/**
 * Repair rough audio before transcribing: compare original vs repaired, pick a
 * preset, then hand the cleaned 16 kHz WAV back. The session keeps the
 * original recording, so the repair is always reversible.
 */
export const AudioRepairDialog: React.FC<Props> = ({ open, source, sourceName, onApply, onClose }) => {
  const { t } = useI18n();
  const [preset, setPreset] = useState<RepairPresetId>('clear');
  const [decoded, setDecoded] = useState<{ samples: Float32Array; sampleRate: number } | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [playing, setPlaying] = useState<'original' | 'repaired' | null>(null);
  const originalRef = useRef<HTMLAudioElement | null>(null);
  const repairedRef = useRef<HTMLAudioElement | null>(null);

  // Decode once per source; the dialog stays open while the user experiments.
  useEffect(() => {
    if (!open || !source) {
      return;
    }
    let cancelled = false;
    setDecoded(null);
    setDecodeError(null);
    setDecoding(true);
    decodeToMono16k(source)
      .then((result) => {
        if (cancelled) return;
        setDecoded({ samples: result.samples, sampleRate: result.sampleRate });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDecodeError(error instanceof Error ? error.message : t('repair.decodeFailed'));
      })
      .finally(() => {
        if (!cancelled) setDecoding(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, source, t]);

  const preview = useMemo(() => {
    if (!decoded) return null;
    const limit = Math.min(decoded.samples.length, Math.round(REPAIR_PREVIEW_SECONDS * decoded.sampleRate));
    const original = decoded.samples.slice(0, limit);
    const repaired = repairSamples(original, decoded.sampleRate, REPAIR_PRESETS[preset]);
    return {
      original: URL.createObjectURL(encodeWav(original, decoded.sampleRate)),
      repaired: URL.createObjectURL(encodeWav(repaired, decoded.sampleRate)),
    };
  }, [decoded, preset]);

  useEffect(() => {
    return () => {
      if (preview) {
        URL.revokeObjectURL(preview.original);
        URL.revokeObjectURL(preview.repaired);
      }
    };
  }, [preview]);

  const stopPlayback = useCallback(() => {
    originalRef.current?.pause();
    repairedRef.current?.pause();
    setPlaying(null);
  }, []);

  const toggle = useCallback(
    (which: 'original' | 'repaired') => {
      const original = originalRef.current;
      const repaired = repairedRef.current;
      if (!original || !repaired) return;
      if (playing === which) {
        stopPlayback();
        return;
      }
      original.pause();
      repaired.pause();
      const element = which === 'original' ? original : repaired;
      element.currentTime = 0;
      void Promise.resolve(element.play()).catch(() => undefined);
      setPlaying(which);
    },
    [playing, stopPlayback],
  );

  const apply = useCallback(() => {
    if (!decoded || applying) return;
    stopPlayback();
    setApplying(true);
    // Let the spinner paint before the synchronous DSP pass on a long file.
    window.setTimeout(() => {
      try {
        const repaired = repairSamples(decoded.samples, decoded.sampleRate, REPAIR_PRESETS[preset]);
        onApply(encodeWav(repaired, decoded.sampleRate), preset);
      } finally {
        setApplying(false);
      }
    }, 30);
  }, [applying, decoded, onApply, preset, stopPlayback]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('repair.title')}
      description={t('repair.description')}
      size="md"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={applying}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={apply}
            disabled={!decoded || applying || preset === 'off'}
          >
            {applying ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
            {applying ? t('repair.processing') : t('repair.apply')}
          </button>
        </>
      }
    >
      <div className="repair-body">
        <p className="repair-source" title={sourceName ?? undefined}>
          {sourceName ?? t('preview.micSource')}
        </p>

        {decoding && (
          <p className="repair-status" role="status">
            <Loader2 size={15} className="spin" />
            {t('repair.decoding')}
          </p>
        )}

        {decodeError && (
          <p className="repair-status repair-error" role="alert">
            {decodeError}
          </p>
        )}

        {decoded && (
          <>
            <div className="repair-presets" role="radiogroup" aria-label={t('repair.preset.aria')}>
              {PRESETS.map((id) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={preset === id}
                  className={`repair-preset ${preset === id ? 'selected' : ''}`}
                  onClick={() => {
                    stopPlayback();
                    setPreset(id);
                  }}
                >
                  <span className="repair-preset-name">{t(`repair.preset.${id}`)}</span>
                  <span className="repair-preset-note">{t(`repair.preset.${id}.note`)}</span>
                </button>
              ))}
            </div>

            <p className="repair-hint">{t('repair.hint', { seconds: REPAIR_PREVIEW_SECONDS })}</p>

            <div className="repair-ab">
              <button
                className={`btn btn-ghost ${playing === 'original' ? 'active' : ''}`}
                onClick={() => toggle('original')}
                disabled={preset === 'off'}
              >
                {playing === 'original' ? <Pause size={15} /> : <Play size={15} />}
                {t('repair.original')}
              </button>
              <button
                className={`btn btn-primary ${playing === 'repaired' ? 'active' : ''}`}
                onClick={() => toggle('repaired')}
                disabled={preset === 'off'}
              >
                {playing === 'repaired' ? <Pause size={15} /> : <Play size={15} />}
                {t('repair.repaired')}
              </button>
            </div>

            {preview && (
              <>
                <audio
                  ref={originalRef}
                  src={preview.original}
                  preload="auto"
                  onEnded={() => setPlaying(null)}
                />
                <audio
                  ref={repairedRef}
                  src={preview.repaired}
                  preload="auto"
                  onEnded={() => setPlaying(null)}
                />
              </>
            )}

            <p className="repair-note">{t('repair.keepsOriginal')}</p>
          </>
        )}
      </div>
    </Modal>
  );
};
