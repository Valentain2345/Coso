import React from 'react';
import { Loader2 } from 'lucide-react';
import type {
  DenoiseQuality,
  DiarizationEngine,
  DiarizationQuality,
  ModelId,
  Settings,
} from '../types';
import { LANGUAGES, MODELS, spokenLanguageLabel } from '../lib/models';
import { REPAIR_PROFILE_IDS, type RepairProfileId, type RepairPresetId } from '../lib/audio/enhance';
import { useI18n } from '../i18n';
import { Modal } from './ui/Modal';

export type QuickSettingsMode = 'preview' | 'reprocess';

interface Props {
  open: boolean;
  mode: QuickSettingsMode;
  settings: Settings;
  /** Audio repair profile applied before re-transcribing an existing session. */
  repair?: RepairProfileId;
  busy?: boolean;
  onChange: (patch: Partial<Settings>) => void;
  onRepairChange?: (preset: RepairPresetId) => void;
  onStart: () => void;
  onClose: () => void;
}

/**
 * Compact settings menu shown right before a transcription run — from the
 * preview card ("adjust a setting and start again") and from "re-transcribe"
 * on an existing session. Only the settings that shape the result appear.
 */
export const QuickSettingsDialog: React.FC<Props> = ({
  open,
  mode,
  settings,
  repair = 'off',
  busy = false,
  onChange,
  onRepairChange,
  onStart,
  onClose,
}) => {
  const { t, lang } = useI18n();
  const languageOptions = LANGUAGES.filter((language) => language.code !== 'auto');

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={mode === 'preview' ? t('quick.titlePreview') : t('quick.titleReprocess')}
      description={t('quick.description')}
      size="sm"
      footer={
        <>
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={onStart} disabled={busy}>
            {busy ? <Loader2 size={16} className="spin" /> : null}
            {mode === 'preview' ? t('quick.start') : t('quick.startReprocess')}
          </button>
        </>
      }
    >
      <div className="settings-section quick-settings">
        <label className="field">
          <span>{t('settings.model.field')}</span>
          <select
            aria-label={t('settings.model.field')}
            value={settings.model}
            onChange={(event) => onChange({ model: event.target.value as ModelId })}
          >
            {(['quick', 'balanced', 'precision'] as const).map((tier) => (
              <optgroup key={tier} label={t(`settings.tier.${tier}`)}>
                {Object.values(MODELS)
                  .filter((model) => model.tier === tier)
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.label} · {model.size}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>

        <label className="field">
          <span>{t('settings.model.spokenLanguage')}</span>
          <select
            aria-label={t('settings.model.spokenLanguage')}
            value={settings.language}
            onChange={(event) => onChange({ language: event.target.value })}
          >
            {languageOptions.map((language) => (
              <option key={language.code} value={language.code}>
                {spokenLanguageLabel(language.code, lang)}
              </option>
            ))}
          </select>
        </label>

        <div className="settings-grid two">
          <div className="field">
            <span>{t('settings.field.noise')}</span>
            <div className="segmented">
              {(['basic', 'neural', 'maximum'] as const).map((level) => (
                <button
                  key={level}
                  className={settings.denoise && settings.denoiseQuality === level ? 'selected' : ''}
                  onClick={() => onChange({ denoise: true, denoiseQuality: level as DenoiseQuality })}
                >
                  {level === 'basic' ? t('settings.option.noise.basic') : level === 'neural' ? t('settings.option.noise.neural') : t('settings.option.noise.maximum')}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>{t('settings.field.speakerPrecision')}</span>
            <div className="segmented">
              {(['standard', 'thorough'] as const).map((quality) => (
                <button
                  key={quality}
                  className={settings.diarize && settings.diarizeQuality === quality ? 'selected' : ''}
                  onClick={() => onChange({ diarize: true, diarizeQuality: quality as DiarizationQuality })}
                >
                  {t(`settings.option.quality.${quality}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
        {mode === 'reprocess' && onRepairChange && (
          <label className="field">
            <span>{t('quick.repair.field')}</span>
            <select
              aria-label={t('quick.repair.field')}
              value={repair}
              onChange={(event) => onRepairChange(event.target.value as RepairPresetId)}
            >
              {repair === 'custom' && (
                <option value="custom">
                  {t('repair.preset.custom')} — {t('repair.preset.custom.note')}
                </option>
              )}
              {REPAIR_PROFILE_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`repair.preset.${id}`)} — {t(`repair.preset.${id}.note`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="settings-hint">{t('quick.hint')}</p>
      </div>
    </Modal>
  );
};
