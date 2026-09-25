import { PdfViewer, type PinLocateRequest } from '../pdf/PdfViewer';
import { useI18n } from '../i18n/I18nProvider';
import type { AppSettings, PdfLibraryEntry } from '../types/domain';
const noop = () => {};
const asyncNoop = async () => {};
// A separate temporary reader never rewrites the current library entry,
// annotations, reading position or MathPix cache with an older PDF revision.
export function QaArchivedReader({entry,locateRequest,settings,onClose}:{
 entry:PdfLibraryEntry;locateRequest?:PinLocateRequest;settings:AppSettings;onClose:()=>void;
}){
 const {t}=useI18n();
 return <PdfViewer entry={entry} settings={settings} readOnly fitToPane locateRequest={locateRequest}
  headerLeading={<small>{t('ask.retainedSource')}</small>}
  headerControls={<button className="ask-sources-toggle" type="button" onClick={onClose}>{t('ask.closeRetainedSource')}</button>}
  activeTranslationCardZIndex={1} onActivateTranslationCard={noop} onCloseTranslationCard={noop} onCreateAnnotation={asyncNoop}
  onOpenFreeTranslation={noop} onPinTranslationCard={noop} onPinnedTranslationRefresh={noop} onPinTranslation={asyncNoop}
  onPageTextReadyForPaperContext={noop} onReadingPositionChange={noop} onRevealPinCard={noop} onSentenceSelectionChange={noop}
  onTranslationCardViewChange={noop} mobileInteractionMode="pan" pinnedTranslationCards={[]} pins={[]} selectionMode="continuous" />;
}
