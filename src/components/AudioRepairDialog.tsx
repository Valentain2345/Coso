import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Wand2,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { decodeToMono16k } from '../lib/audio/decode';
import { encodeWav } from '../lib/audio/dsp';
import {
  REPAIR_PRESETS,
  REPAIR_PROFILE_IDS,
  isRepairNoop,
  measureAudio,
  repairSamples,
  type AudioLevel,
  type HumMode,
  type RepairOptions,
  type RepairPresetId,
  type RepairProfileId,
} from '../lib/audio/enhance';
import { Modal } from './ui/Modal';

/** How many seconds of audio the A/B comparison plays. */
export const REPAIR_PREVIEW_SECONDS = 8;

interface Props {
  open: boolean;
  source: Blob | null;
  sourceName: string | null;
  onApply: (blob: Blob, options: RepairOptions, preset: RepairProfileId) => void;
  onClose: () => void;
}

const HUM_MODES: HumMode[] = ['off', 'auto', '50', '60'];
const DEFAULT_PRESET: RepairPresetId = 'clear';

function cloneOptions(preset: RepairPresetId): RepairOptions {
  return { ...REPAIR_PRESETS[preset] };
}

function formatDb(value: number): string {
  if (!Number.isFinite(value) || value <= -99) return '—';
  return `${Math.round(value)} dB`;
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}

/** One fine-tune control: label, live value, and a keyboard-friendly range. */
const RepairSlider: React.FC<SliderProps> = ({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}) => (
  <label className="repair-slider">
    <span className="repair-slider-head">
      <span>{label}</span>
      <output>{format(value)}</output>
    </span>
    <input
      type="range"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  </label>
);

/**
 * Repair rough audio before transcribing.
 *
 * Three layers, from simple to precise: a preset, an optional fine-tune panel,
 * and an A/B preview with before/after measurements. The chain never changes
 * the duration, so transcript timestamps keep matching the saved recording, and
 * the session always keeps the untouched original.
 */
export const AudioRepairDialog: React.FC<Props> = ({
  open,
  source,
  sourceName,
  onApply,
  onClose,
}) => {
  const { t } = useI18n();
  const [preset, setPreset] = useState<RepairProfileId>(DEFAULT_PRESET);
  const [options, setOptions] = useState<RepairOptions>(() => cloneOptions(DEFAULT_PRESET));
  /** Preset the fine-tuning started from, for the reset action. */
  const [basePreset, setBasePreset] = useState<RepairPresetId>(DEFAULT_PRESET);
  const [tuningOpen, setTuningOpen] = useState(false);
  const [decoded, setDecoded] = useState<{ samples: Float32Array; sampleRate: number } | null>(null);
  const [decoding, setDecoding] = useState(false);
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [playing, setPlaying] = useState<'original' | 'repaired' | null>(null);
  const originalRef = useRef<HTMLAudioElement | null>(null);
  const repairedRef = useRef<HTMLAudioElement | null>(null);

  // Every open starts from the simple default, not from a previous experiment.
  useEffect(() => {
    if (!open) return;
    setPreset(DEFAULT_PRESET);
    setOptions(cloneOptions(DEFAULT_PRESET));
    setBasePreset(DEFAULT_PRESET);
    setTuningOpen(false);
    setPlaying(null);
    setApplying(false);
  }, [open]);

  // Decode once per source; the dialog stays open while the user experiments.
  useEffect(() => {
    if (!open || !source) return;
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

  const stopPlayback = useCallback(() => {
    originalRef.current?.pause();
    repairedRef.current?.pause();
    setPlaying(null);
  }, []);

  // Slider drags repaint immediately while the DSP pass follows a frame later.
  const deferredOptions = useDeferredValue(options);
  const noop = isRepairNoop(options);

  const preview = useMemo(() => {
    if (!decoded) return null;
    const limit = Math.min(
      decoded.samples.length,
      Math.round(REPAIR_PREVIEW_SECONDS * decoded.sampleRate),
    );
    const original = decoded.samples.slice(0, limit);
    const repaired = repairSamples(original, decoded.sampleRate, deferredOptions);
    return {
      originalUrl: URL.createObjectURL(encodeWav(original, decoded.sampleRate)),
      repairedUrl: URL.createObjectURL(encodeWav(repaired, decoded.sampleRate)),
      originalLevel: measureAudio(original, decoded.sampleRate),
      repairedLevel: measureAudio(repaired, decoded.sampleRate),
      changed: !isRepairNoop(deferredOptions),
    };
  }, [decoded, deferredOptions]);

  useEffect(() => {
    return () => {
      if (preview) {
        URL.revokeObjectURL(preview.originalUrl);
        URL.revokeObjectURL(preview.repairedUrl);
      }
    };
  }, [preview]);

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

  const choosePreset = (id: RepairPresetId) => {
    stopPlayback();
    setPreset(id);
    setOptions(cloneOptions(id));
    setBasePreset(id);
  };

  const update = (patch: Partial<RepairOptions>) => {
    stopPlayback();
    setOptions((previous) => ({ ...previous, ...patch }));
    setPreset('custom');
  };

  const reset = () => {
    stopPlayback();
    setOptions(cloneOptions(basePreset));
    setPreset(basePreset);
  };

  const apply = useCallback(() => {
    if (!decoded || applying || noop) return;
    stopPlayback();
    setApplying(true);
    // Let the spinner paint before the synchronous DSP pass on a long file.
    window.setTimeout(() => {
      try {
        const repaired = repairSamples(decoded.samples, decoded.sampleRate, options);
        onApply(encodeWav(repaired, decoded.sampleRate), { ...options }, preset);
      } finally {
        setApplying(false);
      }
    }, 30);
  }, [applying, decoded, noop, onApply, options, preset, stopPlayback]);

  const levelRows: Array<[string, AudioLevel]> = preview
    ? [
        [t('repair.original'), preview.originalLevel],
        [t('repair.repaired'), preview.repairedLevel],
      ]
    : [];

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
            disabled={!decoded || applying || noop}
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
              {REPAIR_PROFILE_IDS.map((id) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={preset === id}
                  className={`repair-preset ${preset === id ? 'selected' : ''}`}
                  onClick={() => choosePreset(id)}
                >
                  <span className="repair-preset-name">{t(`repair.preset.${id}`)}</span>
                  <span className="repair-preset-note">{t(`repair.preset.${id}.note`)}</span>
                </button>
              ))}
            </div>

            <button
              className="repair-tune-toggle"
              aria-expanded={tuningOpen}
              onClick={() => setTuningOpen((value) => !value)}
            >
              <SlidersHorizontal size={15} />
              <span>{t('repair.tune')}</span>
              {preset === 'custom' && (
                <span className="repair-tune-badge">{t('repair.preset.custom')}</span>
              )}
              <span className="repair-tune-chevron" aria-hidden="true">
                {tuningOpen ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
              </span>
            </button>

            {tuningOpen && (
              <div className="repair-tune">
                <div className="repair-tune-grid">
                  <label className="field repair-hum">
                    <span>{t('repair.hum')}</span>
                    <select
                      aria-label={t('repair.hum')}
                      value={options.hum}
                      onChange={(event) => update({ hum: event.target.value as HumMode })}
                    >
                      {HUM_MODES.map((mode) => (
                        <option key={mode} value={mode}>
                          {t(`repair.hum.${mode}`)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <RepairSlider
                    label={t('repair.denoise')}
                    value={options.denoiseStrength}
                    min={0}
                    max={3}
                    step={0.1}
                    format={(value) => `${value.toFixed(1)}×`}
                    onChange={(value) => update({ denoiseStrength: value })}
                  />
                  <RepairSlider
                    label={t('repair.deEss')}
                    value={options.deEssDb}
                    min={0}
                    max={8}
                    step={1}
                    format={(value) => `${value.toFixed(0)} dB`}
                    onChange={(value) => update({ deEssDb: value })}
                  />
                  <RepairSlider
                    label={t('repair.presence')}
                    value={options.presenceDb}
                    min={0}
                    max={8}
                    step={0.5}
                    format={(value) => `+${value.toFixed(1)} dB`}
                    onChange={(value) => update({ presenceDb: value })}
                  />
                  <RepairSlider
                    label={t('repair.warmth')}
                    value={options.warmthDb}
                    min={0}
                    max={6}
                    step={0.5}
                    format={(value) => `+${value.toFixed(1)} dB`}
                    onChange={(value) => update({ warmthDb: value })}
                  />
                  <RepairSlider
                    label={t('repair.air')}
                    value={options.airDb}
                    min={0}
                    max={4}
                    step={0.5}
                    format={(value) => `+${value.toFixed(1)} dB`}
                    onChange={(value) => update({ airDb: value })}
                  />
                </div>

                <div className="repair-toggles">
                  <div className="toggle-row">
                    <div>
                      <strong>{t('repair.gate')}</strong>
                      <span>{t('repair.gate.note')}</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={options.gate}
                      aria-label={t('repair.gate')}
                      className={`switch ${options.gate ? 'on' : ''}`}
                      onClick={() => update({ gate: !options.gate })}
                    >
                      <span className="switch-thumb" />
                    </button>
                  </div>
                  <div className="toggle-row">
                    <div>
                      <strong>{t('repair.level')}</strong>
                      <span>{t('repair.level.note')}</span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={options.compress}
                      aria-label={t('repair.level')}
                      className={`switch ${options.compress ? 'on' : ''}`}
                      onClick={() => update({ compress: !options.compress })}
                    >
                      <span className="switch-thumb" />
                    </button>
                  </div>
                </div>

                <div className="repair-tune-foot">
                  <p>{t('repair.tune.hint')}</p>
                  {preset === 'custom' && (
                    <button className="btn btn-ghost btn-small" onClick={reset}>
                      <RotateCcw size={14} />
                      {t('repair.reset', { name: t(`repair.preset.${basePreset}`) })}
                    </button>
                  )}
                </div>
              </div>
            )}

            {noop ? (
              <p className="repair-hint">{t('repair.noChange')}</p>
            ) : (
              <p className="repair-hint">{t('repair.hint', { seconds: REPAIR_PREVIEW_SECONDS })}</p>
            )}

            <div className="repair-ab">
              <button
                className={`btn btn-ghost ${playing === 'original' ? 'active' : ''}`}
                onClick={() => toggle('original')}
                disabled={noop}
              >
                {playing === 'original' ? <Pause size={15} /> : <Play size={15} />}
                {t('repair.original')}
              </button>
              <button
                className={`btn btn-primary ${playing === 'repaired' ? 'active' : ''}`}
                onClick={() => toggle('repaired')}
                disabled={noop}
              >
                {playing === 'repaired' ? <Pause size={15} /> : <Play size={15} />}
                {t('repair.repaired')}
              </button>
            </div>

            {!noop && levelRows.length > 0 && (
              <div className="repair-levels" role="group" aria-label={t('repair.meter.aria')}>
                <div className="repair-level-row repair-level-head" aria-hidden="true">
                  <span />
                  <span>{t('repair.meter.floor')}</span>
                  <span>{t('repair.meter.average')}</span>
                  <span>{t('repair.meter.peak')}</span>
                </div>
                {levelRows.map(([label, level]) => (
                  <div className="repair-level-row" key={label}>
                    <span className="repair-level-name">{label}</span>
                    <span>{formatDb(level.noiseFloorDb)}</span>
                    <span>{formatDb(level.rmsDb)}</span>
                    <span>{formatDb(level.peakDb)}</span>
                  </div>
                ))}
              </div>
            )}

            {preview && (
              <>
                <audio
                  ref={originalRef}
                  src={preview.originalUrl}
                  preload="auto"
                  onEnded={() => setPlaying(null)}
                />
                <audio
                  ref={repairedRef}
                  src={preview.repairedUrl}
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
