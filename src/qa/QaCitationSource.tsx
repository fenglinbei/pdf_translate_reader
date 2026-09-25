import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUpRight, Check, ChevronDown, FileText } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { QaCitation } from '../types/domain';
import './qaCitationSource.css';

// Presentation only: opening the picker uses the saved locator and makes no request.
export function QaCitationSource({ citation, evidenceId, canOpen, onSelect }: {
  citation: QaCitation; evidenceId?: string; canOpen: boolean; onSelect: (pageNumber?: number) => void;
}) {
  const { t } = useI18n();
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const artifact = citation.sourceKind === 'document_artifact';
  const anchor = citation.sourceKind === 'document_text' ? citation.sourceLocator.anchor.pageNumber : citation.pageStart ?? undefined;
  const [selectedPage, setSelectedPage] = useState(anchor);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 280 });
  const pages = citation.sourceKind === 'document_text'
    ? [...new Set(citation.sourceLocator.sourceSpans.map(span => span.pageNumber))].sort((a, b) => a - b)
    : artifact ? citation.sourceLocator.pages : [];
  const availablePages = pages.length ? pages : citation.pageStart && citation.pageEnd ? Array.from({ length: citation.pageEnd - citation.pageStart + 1 }, (_, index) => citation.pageStart! + index) : [];
  const hasPicker = availablePages.length > 1;
  const excerpt = citation.quotedText.replace(/\s+/g, ' ').trim();
  const pageLabel = selectedPage ? t('ask.sourcePage', { page: selectedPage }) : t('ask.sourceUnlocated');
  const sourceLabel = evidenceId || citation.documentTitle;
  const precision = citation.sourceKind !== 'document_text' ? ''
    : citation.sourceLocator.locationPrecision === 'page' ? t('ask.pageLocationOnly')
      : citation.sourceLocator.locationPrecision === 'partial-line' ? t('ask.partialLineLocation') : '';

  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const bounds = trigger.current.getBoundingClientRect();
    const width = Math.min(310, window.innerWidth - 24);
    const height = menu.current.offsetHeight;
    const below = window.innerHeight - bounds.bottom - 12;
    setPosition({
      width,
      left: Math.max(12, Math.min(bounds.right - width, window.innerWidth - width - 12)),
      top: below >= height ? bounds.bottom + 6 : Math.max(12, bounds.top - height - 6),
    });
    menu.current.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnMove = (event: Event) => {
      if (!(event.target instanceof Node) || !menu.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', closeOnMove);
    document.addEventListener('scroll', closeOnMove, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', closeOnMove);
      document.removeEventListener('scroll', closeOnMove, true);
    };
  }, [open]);

  return <div className="ask-source-row">
    <button className="ask-source-main" type="button" disabled={!canOpen || !selectedPage} onClick={() => onSelect(selectedPage)}
      title={`${citation.documentTitle}\n${citation.quotedText}`} aria-label={`${sourceLabel} · ${citation.documentTitle} · ${pageLabel}`}>
      <span className="ask-source-number">{evidenceId ? evidenceId.replace(/^C/, '') : <FileText size={13} aria-hidden="true" />}</span>
      <span className="ask-source-copy">
        <strong>{citation.documentTitle}</strong>
        <span>{excerpt || (citation.pageStart && citation.pageEnd ? t('ask.sourceRange', { start: citation.pageStart, end: citation.pageEnd }) : t('ask.sourceUnlocated'))}</span>
      </span>
    </button>
    <button className="ask-source-page" type="button" ref={trigger} disabled={!canOpen || !selectedPage}
      aria-label={hasPicker ? `${t('ask.citationJumpPage')} · ${sourceLabel}` : `${pageLabel} · ${sourceLabel}`}
      aria-expanded={hasPicker ? open : undefined} aria-controls={hasPicker && open ? menuId : undefined}
      aria-haspopup={hasPicker ? 'menu' : undefined}
      onClick={() => hasPicker ? setOpen(value => !value) : onSelect(selectedPage)}
      onKeyDown={event => {
        if (hasPicker && event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); }
      }}>
      {pageLabel}{hasPicker ? <ChevronDown size={13} aria-hidden="true" /> : <ArrowUpRight size={13} aria-hidden="true" />}
    </button>
    {precision ? <small className="ask-source-precision">{precision}</small> : null}
    {open && createPortal(<div className="ask-source-popover" ref={menu} style={position}>
      <div className="ask-source-popover-heading">{t('ask.citationJumpPage')}</div>
      {excerpt ? <div className="ask-source-popover-excerpt">{excerpt}</div> : null}
      <div className="ask-source-page-options" role="menu" id={menuId} aria-label={t('ask.citationJumpPage')}
        onKeyDown={event => {
          if (event.key === 'Escape' || event.key === 'Tab') {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); }
            setOpen(false); trigger.current?.focus(); return;
          }
          const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? []);
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length
            : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length
              : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
          if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
        }}>
        {availablePages.map(page => <button type="button" role="menuitemradio" key={page} aria-checked={page === selectedPage}
          onClick={() => { setSelectedPage(page); setOpen(false); trigger.current?.focus(); onSelect(page); }}>
          <span>{t('ask.sourcePage', { page })}{page === anchor ? <small>{t('ask.sourceAnchor')}</small> : null}</span>
          {page === selectedPage ? <Check size={14} aria-hidden="true" /> : null}
        </button>)}
      </div>
    </div>, document.body)}
  </div>;
}
