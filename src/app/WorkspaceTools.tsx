import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Ellipsis } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';

/** Keep secondary tools and service status out of the main reading toolbar. */
export function WorkspaceTools({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  if (!enabled) return <>{children}</>;
  return <div className="workspace-tools" ref={root}>
    <button type="button" className="icon-button workspace-tools-trigger" ref={trigger} aria-label={t('ask.moreTools')}
      title={t('ask.moreTools')} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><Ellipsis size={18} aria-hidden="true" /></button>
    <div id={id} className="workspace-tools-popover" role="region" aria-label={t('ask.moreTools')} hidden={!open}
      onClick={event => { if ((event.target as HTMLElement).closest('button')) setOpen(false); }}>
      {children}
    </div>
  </div>;
}
