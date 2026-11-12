import React, { useEffect, useMemo, useState } from 'react';
import { Lightbulb, X, CircleAlert } from 'lucide-react';
import { useI18n } from '../i18n';
import { manualEn, type ManualEntry, type ManualSection } from '../i18n/manual';
import { manualEs } from '../i18n/manual.es';
import { Modal } from './ui/Modal';

interface Props {
  open: boolean;
  onClose: () => void;
}

function content(lang: 'en' | 'es'): ManualSection[] {
  return lang === 'es' ? manualEs : manualEn;
}

const ManualFigure: React.FC<{ entry: Extract<ManualEntry, { kind: 'img' | 'gif' }> }> = ({ entry }) => (
  <figure className={`manual-figure ${entry.kind === 'gif' ? 'manual-gif' : ''}`}>
    <img src={entry.src} alt={entry.alt} loading="lazy" />
  </figure>
);

const ManualBody: React.FC<{ sections: ManualSection[]; activeId: string }> = ({ sections, activeId }) => (
  <>
    {sections.map((section) => (
      <section key={section.id} id={`manual-${section.id}`} className="manual-section" aria-labelledby={`manual-${section.id}-h`}>
        <h3 id={`manual-${section.id}-h`}>{section.title}</h3>
        {section.entries.map((entry, index) => {
          if ('src' in entry) {
            return <ManualFigure key={index} entry={entry} />;
          }
          if ('items' in entry) {
            return (
              <ol key={index} className="manual-steps">
                {entry.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{item}</li>
                ))}
              </ol>
            );
          }
          const Callout = entry.kind === 'tip' ? Lightbulb : CircleAlert;
          return (
            <p key={index} className={`manual-callout manual-${entry.kind}`}>
              <Callout size={15} aria-hidden="true" />
              <span>{entry.text}</span>
            </p>
          );
        })}
      </section>
    ))}
    <span data-manual-active={activeId} hidden />
  </>
);

export const ManualDialog: React.FC<Props> = ({ open, onClose }) => {
  const { lang, t } = useI18n();
  const sections = useMemo(() => content(lang), [lang]);
  const [activeId, setActiveId] = useState(sections[0]?.id ?? 'welcome');

  // Track which section the reader is looking at so the side index can
  // highlight it; a scroll listener keeps this cheap.
  useEffect(() => {
    if (!open) return;
    const body = document.querySelector('.modal-body');
    if (!body) return;
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) {
          if (record.isIntersecting) {
            const id = (record.target as HTMLElement).id.replace(/^manual-/, '');
            setActiveId(id);
            break;
          }
        }
      },
      { root: body, rootMargin: '-10% 0px -70% 0px' },
    );
    for (const section of body.querySelectorAll('.manual-section')) observer.observe(section);
    return () => observer.disconnect();
  }, [open, lang]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('manual.title')}
      description={t('manual.description')}
      size="lg"
      labelledBy="manual-title"
      footer={
        <button className="btn btn-primary" onClick={onClose}>
          {t('common.done')}
        </button>
      }
    >
      <div className="manual-layout">
        <nav className="manual-index" aria-label={t('manual.index.aria')}>
          {sections.map((section) => (
            <a
              key={section.id}
              href={`#manual-${section.id}`}
              className={activeId === section.id ? 'active' : ''}
              onClick={() => setActiveId(section.id)}
            >
              {section.title}
            </a>
          ))}
        </nav>
        <div className="manual-scroll" tabIndex={-1}>
          <ManualBody sections={sections} activeId={activeId} />
        </div>
      </div>
    </Modal>
  );
};
