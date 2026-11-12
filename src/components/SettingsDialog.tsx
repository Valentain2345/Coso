import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Download, HardDrive, Loader2, Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type {
  DenoiseQuality,
  DevicePreference,
  DiarizationEngine,
  DiarizationQuality,
  ModelId,
  Settings,
  TextSize,
  ThemePreference,
} from '../types';
import { LANGUAGES, MODELS, modelCopy, modelInfo, spokenLanguageLabel } from '../lib/models';
import { asrClient } from '../lib/asr/client';
import { languages, useI18n } from '../i18n';
import { localizeProgress } from '../i18n/progress';
import { Modal } from './ui/Modal';
import { Reveal } from './ui/Reveal';
import { isTauri, invokeCommand } from '../lib/tauri';

interface Props {
  open: boolean;
  onClose: () => void;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onReset: () => void;
  storage: { usage: number; quota: number } | null;
  sessionCount: number;
  onClearAll: () => Promise<void>;
  busy: boolean;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(bytes > 1024 * 1024 * 1024 ? 1 : 0)} MB`;
}

const Toggle: React.FC<{ checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }> = ({
  checked,
  onChange,
  label,
  disabled,
}) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    className={`switch ${checked ? 'on' : ''}`}
    onClick={() => onChange(!checked)}
  >
    <span className="switch-thumb" />
  </button>
);

export const SettingsDialog: React.FC<Props> = ({
  open,
  onClose,
  settings,
  onChange,
  onReset,
  storage,
  sessionCount,
  onClearAll,
  busy,
}) => {
  const { lang, t, setLang } = useI18n();
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const [uninstalling, setUninstalling] = useState(false);
  const [download, setDownload] = useState<{
    state: 'idle' | 'busy' | 'done' | 'error';
    percent: number;
    message: string;
  }>({ state: 'idle', percent: 0, message: '' });

  useEffect(() => {
    setDownload({ state: 'idle', percent: 0, message: '' });
    setConfirmClear(false);
  }, [settings.model, settings.device, open]);

  const selected = modelInfo(settings.model);
  const copy = modelCopy(selected, lang);
  const languageOptions = LANGUAGES.filter((language) => language.code !== 'auto');
  const uiLanguages = languages();
  const usagePercent = storage && storage.quota > 0 ? Math.min(100, (storage.usage / storage.quota) * 100) : 0;

  const preload = async () => {
    setDownload({ state: 'busy', percent: 0, message: t('settings.download.starting') });
    try {
      await asrClient.preload(settings.model, settings.device, (stage, progress, message) => {
        if (stage === 'load') {
          setDownload({
            state: 'busy',
            percent: Math.round(progress * 100),
            message: localizeProgress(message, lang),
          });
        }
      });
      setDownload({ state: 'done', percent: 100, message: t('settings.download.doneNote') });
    } catch (caught) {
      setDownload({
        state: 'error',
        percent: 0,
        message: caught instanceof Error ? caught.message : t('settings.download.failed'),
      });
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('settings.title')}
      description={t('settings.description')}
      size="lg"
      labelledBy="settings-title"
      footer={
        <>
          <button
            className="btn btn-ghost"
            onClick={() => {
              onReset();
              setDownload({ state: 'idle', percent: 0, message: '' });
            }}
          >
            <RotateCcw size={15} />
            {t('settings.reset')}
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            {t('common.done')}
          </button>
        </>
      }
    >
      <section className="settings-section">
        <h3>{t('settings.section.model')}</h3>
        <p className="settings-hint">{t('settings.model.hint')}</p>

        <div className="settings-grid two">
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
        </div>

        <div className="model-note">
          <strong>{selected.label}</strong>
          <span>{copy.note}</span>
          {selected.warning && (
            <span className="model-warning">
              <AlertTriangle size={14} aria-hidden="true" />
              {copy.warning}
            </span>
          )}
          {selected.englishOnly && settings.language !== 'en' && (
            <span className="model-warning">
              <AlertTriangle size={14} aria-hidden="true" />
              {t('settings.model.englishOnly', { lang: settings.language.toUpperCase() })}
            </span>
          )}
        </div>

        <div className="download-row">
          <button
            className="btn btn-secondary btn-small"
            onClick={() => void preload()}
            disabled={busy || download.state === 'busy'}
            data-autofocus
          >
            {download.state === 'busy' ? <Loader2 size={15} className="spin" /> : download.state === 'done' ? <Check size={15} /> : <Download size={15} />}
            {download.state === 'busy'
              ? t('settings.download.busy', { percent: download.percent })
              : download.state === 'done'
                ? t('settings.download.done')
                : t('settings.download.idle')}
          </button>
          <span className="download-note">
            {busy
              ? t('settings.download.busyNote')
              : download.message || t('settings.download.idleNote')}
          </span>
        </div>
        {download.state === 'busy' && (
          <div className="download-track" aria-hidden="true">
            <span style={{ width: `${Math.max(2, download.percent)}%` }} />
          </div>
        )}
        {download.state === 'error' && <p className="field-error">{download.message}</p>}
      </section>

      <section className="settings-section">
        <h3>{t('settings.section.processing')}</h3>
        <div className="settings-grid two">
          <label className="field">
            <span>{t('settings.field.engine')}</span>
            <select
              aria-label={t('settings.field.engine')}
              value={settings.device}
              onChange={(event) => onChange({ device: event.target.value as DevicePreference })}
            >
              {(['auto', 'webgpu', 'wasm'] as const).map((device) => (
                <option key={device} value={device}>
                  {t(`settings.option.device.${device}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>{t('settings.field.speakerPrecision')}</span>
            <select
              aria-label={t('settings.field.speakerPrecision')}
              value={settings.diarizeQuality}
              onChange={(event) =>
                onChange({ diarizeQuality: event.target.value as DiarizationQuality })
              }
              disabled={!settings.diarize}
            >
              {(['standard', 'thorough'] as const).map((quality) => (
                <option key={quality} value={quality}>
                  {t(`settings.option.quality.${quality}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Reveal keeps the dialog height stable: warnings grow in place with a
            grid-rows animation instead of pushing the content below. */}
        <Reveal show={settings.diarizeQuality === 'thorough' && settings.diarize}>
          <p className="model-warning">
            <AlertTriangle size={14} aria-hidden="true" />
            {t('settings.warn.thorough')}
          </p>
        </Reveal>

        <div className="settings-grid two">
          <label className="field">
            <span>{t('settings.field.speakerModel')}</span>
            <select
              aria-label={t('settings.field.speakerModel')}
              value={settings.diarizeEngine}
              onChange={(event) =>
                onChange({ diarizeEngine: event.target.value as DiarizationEngine })
              }
              disabled={!settings.diarize}
            >
              {(['wespeaker', 'pyannote'] as const).map((engine) => (
                <option key={engine} value={engine}>
                  {t(`settings.option.engine.${engine}`)}
                </option>
              ))}
            </select>
          </label>

          <div className="field">
            <span>{t('settings.field.maxSpeakers')}</span>
            <div className={`stepper ${settings.diarize ? '' : 'disabled'}`}>
              <button
                onClick={() => onChange({ maxSpeakers: Math.max(2, settings.maxSpeakers - 1) })}
                disabled={!settings.diarize || settings.maxSpeakers <= 2}
                aria-label={t('settings.stepper.decrease')}
              >
                <Minus size={14} />
              </button>
              <span>{settings.maxSpeakers}</span>
              <button
                onClick={() => onChange({ maxSpeakers: Math.min(8, settings.maxSpeakers + 1) })}
                disabled={!settings.diarize || settings.maxSpeakers >= 8}
                aria-label={t('settings.stepper.increase')}
              >
                <Plus size={14} />
              </button>
            </div>
          </div>
        </div>

        <Reveal show={settings.diarizeEngine === 'pyannote' && settings.diarize}>
          <p className="model-warning">
            <AlertTriangle size={14} aria-hidden="true" />
            {t('settings.warn.pyannote')}
          </p>
        </Reveal>

        <div className="settings-grid two">
          <label className="field">
            <span>{t('settings.field.noise')}</span>
            <select
              aria-label={t('settings.field.noise')}
              value={settings.denoiseQuality}
              onChange={(event) =>
                onChange({ denoiseQuality: event.target.value as DenoiseQuality })
              }
              disabled={!settings.denoise}
            >
              {(['basic', 'neural', 'maximum'] as const).map((level) => (
                <option key={level} value={level}>
                  {t(`settings.option.noise.${level}`)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <Reveal show={settings.denoise && settings.denoiseQuality === 'maximum'}>
          <p className="model-warning">
            <AlertTriangle size={14} aria-hidden="true" />
            {t('settings.warn.maximum')}
          </p>
        </Reveal>

        <div className="toggle-rows">
          <div className="toggle-row">
            <div>
              <strong>{t('settings.toggle.diarize.title')}</strong>
              <span>{t('settings.toggle.diarize.desc')}</span>
            </div>
            <Toggle
              checked={settings.diarize}
              onChange={(diarize) => onChange({ diarize })}
              label={t('settings.toggle.diarize.title')}
            />
          </div>
          <div className="toggle-row">
            <div>
              <strong>{t('settings.toggle.denoise.title')}</strong>
              <span>{t('settings.toggle.denoise.desc')}</span>
            </div>
            <Toggle
              checked={settings.denoise}
              onChange={(denoise) => onChange({ denoise })}
              label={t('settings.toggle.denoise.title')}
            />
          </div>
        </div>
        <p className="settings-hint">{t('settings.chunks.hint')}</p>
      </section>

      <section className="settings-section">
        <h3>{t('settings.section.reading')}</h3>
        <div className="settings-grid two">
          <div className="field">
            <span>{t('settings.field.theme')}</span>
            <div className="segmented">
              {(['light', 'dark', 'system'] as const).map((theme) => (
                <button
                  key={theme}
                  className={settings.theme === theme ? 'selected' : ''}
                  onClick={() => onChange({ theme })}
                >
                  {theme === 'system' ? t('settings.option.theme.system') : t(`common.theme.${theme}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <span>{t('settings.field.textSize')}</span>
            <div className="segmented">
              {(['sm', 'md', 'lg'] as const).map((size) => (
                <button
                  key={size}
                  className={settings.textSize === size ? 'selected' : ''}
                  onClick={() => onChange({ textSize: size })}
                >
                  {t(`settings.option.size.${size}`)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h3>{t('settings.section.language')}</h3>
        <div className="field">
          <span>{t('settings.language.field')}</span>
          <div className="segmented" role="radiogroup" aria-label={t('settings.language.field')}>
            {uiLanguages.map((language) => (
              <button
                key={language.id}
                role="radio"
                aria-checked={lang === language.id}
                className={lang === language.id ? 'selected' : ''}
                onClick={() => setLang(language.id)}
              >
                {language.label}
              </button>
            ))}
          </div>
          <p className="settings-hint">{t('settings.language.hint')}</p>
        </div>
      </section>

      <section className="settings-section">
        <h3>{t('settings.section.storage')}</h3>
        <div className="storage-panel">
          <div className="storage-panel-head">
            <span className="storage-icon">
              <HardDrive size={16} />
            </span>
            <div>
              <strong>{t('count.transcripts', { count: sessionCount })}</strong>
              <span>
                {storage
                  ? t('settings.storage.usedOf', { used: megabytes(storage.usage), quota: megabytes(storage.quota) })
                  : t('settings.storage.unavailable')}
              </span>
            </div>
          </div>
          {storage && (
            <div className="storage-track" aria-hidden="true">
              <span style={{ width: `${Math.max(1, usagePercent)}%` }} />
            </div>
          )}
        </div>

        <Reveal show={confirmClear}>
          <div className="danger-confirm">
            <p>{t('settings.danger.prompt')}</p>
            <div>
              <button className="btn btn-ghost btn-small" onClick={() => setConfirmClear(false)}>
                {t('settings.danger.keep')}
              </button>
              <button
                className="btn btn-danger btn-small"
                disabled={clearing}
                onClick={async () => {
                  setClearing(true);
                  try {
                    await onClearAll();
                    setConfirmClear(false);
                  } finally {
                    setClearing(false);
                  }
                }}
              >
                {clearing ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                {t('settings.danger.delete')}
              </button>
            </div>
          </div>
        </Reveal>
        {!confirmClear && (
          <button className="btn btn-ghost btn-small danger-text" onClick={() => setConfirmClear(true)}>
            <Trash2 size={15} />
            {t('settings.danger.idle')}
          </button>
        )}
      </section>

      {isTauri() && (
        <section className="settings-section">
          <h3>{t('settings.uninstall.title')}</h3>
          <p className="settings-hint">{t('settings.uninstall.desc')}</p>
          <Reveal show={confirmUninstall}>
            <div className="danger-confirm">
              <p>{t('settings.uninstall.prompt')}</p>
              <div>
                <button className="btn btn-ghost btn-small" onClick={() => setConfirmUninstall(false)}>
                  {t('settings.danger.keep')}
                </button>
                <button
                  className="btn btn-danger btn-small"
                  disabled={uninstalling}
                  onClick={async () => {
                    setUninstalling(true);
                    try {
                      await invokeCommand('uninstall_app');
                    } catch {
                      setUninstalling(false);
                      setConfirmUninstall(false);
                    }
                  }}
                >
                  {uninstalling ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />}
                  {t('settings.uninstall.confirm')}
                </button>
              </div>
            </div>
          </Reveal>
          {!confirmUninstall && (
            <button className="btn btn-ghost btn-small danger-text" onClick={() => setConfirmUninstall(true)}>
              <Trash2 size={15} />
              {t('settings.uninstall.idle')}
            </button>
          )}
        </section>
      )}
    </Modal>
  );
};
