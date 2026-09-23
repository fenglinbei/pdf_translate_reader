import { useEffect, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";
import type { MessageKey } from "../i18n/messages";
import type { LibraryDocument, LibraryMetadataField, LibraryMetadataSource, LibraryMetadataState } from "../types/domain";

const labels: Record<LibraryMetadataField, MessageKey> = {
  title: "library.metadata.title", authors: "library.metadata.authors", publication_year: "library.metadata.year",
  publication_venue: "library.metadata.venue", doi: "library.metadata.doi", arxiv_id: "library.metadata.arxiv", abstract: "library.metadata.abstract",
};
const sources: Record<LibraryMetadataSource, MessageKey> = {
  pdf: "library.recognition.source.pdf", pdf_text: "library.recognition.source.text", filename: "library.recognition.source.filename",
  crossref: "library.recognition.source.crossref", arxiv: "library.recognition.source.arxiv", ai: "library.recognition.source.ai", user: "library.recognition.source.user",
};
const statuses: Record<NonNullable<LibraryMetadataState["status"]>, MessageKey> = {
  queued: "library.recognition.queued", running: "library.recognition.running", completed: "library.recognition.completed",
  needs_review: "library.recognition.review", needs_ocr: "library.recognition.ocr", not_found: "library.recognition.notFound",
  partial: "library.recognition.partial", failed: "library.recognition.failed",
};
export function metadataIsPending(state?: LibraryMetadataState) { return state?.status === "queued" || state?.status === "running"; }

export function MetadataStatus({ state }: { state?: LibraryMetadataState }) {
  const { t } = useI18n();
  return <span className={`library-metadata-status ${metadataIsPending(state) ? "library-metadata-status--pending" : ""}`}>
    {t(state?.status && statuses[state.status] ? statuses[state.status] : "library.recognition.unprocessed")}
  </span>;
}

export function MetadataRecognition({ document, disabled, onRecognize, onApply }: {
  document: LibraryDocument;
  disabled: boolean;
  onRecognize: () => void;
  onApply: (fields: LibraryMetadataField[]) => void;
}) {
  const { t } = useI18n();
  const [selected, setSelected] = useState<LibraryMetadataField[]>([]);
  const state = document.metadataState;
  useEffect(() => { setSelected([]); }, [document.cloudDocumentId, state?.jobId, document.metadataRevision]);
  const suggestions = Object.entries(state?.suggestions ?? {}) as Array<[LibraryMetadataField, NonNullable<NonNullable<LibraryMetadataState["suggestions"]>[LibraryMetadataField]>]>;
  const current = {
    title: document.bibliographicMetadata.title, authors: document.bibliographicMetadata.authors,
    publication_year: document.bibliographicMetadata.publicationYear, publication_venue: document.bibliographicMetadata.publicationVenue,
    doi: document.bibliographicMetadata.doi, arxiv_id: document.bibliographicMetadata.arxivId, abstract: document.bibliographicMetadata.abstract,
  };
  const display = (value: unknown) => (Array.isArray(value) ? value.join("; ") : String(value ?? "")) || t("library.notSet");
  return <section className="library-metadata-recognition" aria-label={t("library.recognition.title")}>
    <div className="library-metadata-recognition__heading">
      <strong>{t("library.recognition.title")}</strong>
      <MetadataStatus state={state} />
    </div>
    <p>{t("library.recognition.hint")}</p>
    {state?.status === "needs_ocr" ? <p>{t("library.recognition.ocrHint")}</p> : null}
    {state?.status === "failed" ? <p role="status">{t(state.error === "file_too_large" ? "library.recognition.tooLarge" : "library.recognition.failureHint")}</p> : null}
    {state?.warnings?.length ? <p role="status">{t("library.recognition.warning")}</p> : null}
    <button disabled={disabled || metadataIsPending(state)} onClick={onRecognize} type="button">
      <RefreshCw size={14} aria-hidden="true" />{t("library.recognition.retry")}
    </button>
    <dl className="library-metadata-recognition__sources">
      {(Object.entries(document.metadataSources ?? {}) as Array<[LibraryMetadataField, { source: LibraryMetadataSource; locked: boolean }]>).map(([field, source]) =>
        labels[field] ? <div key={field}><dt>{t(labels[field])}</dt><dd>{t(sources[source.source] ?? "library.recognition.source.unknown")}{source.locked ? ` · ${t("library.recognition.protected")}` : ""}</dd></div> : null)}
    </dl>
    {suggestions.length && state?.status === "needs_review" ? <fieldset disabled={disabled} className="library-metadata-recognition__suggestions">
      <legend>{t("library.recognition.review")}</legend>
      {suggestions.map(([field, candidate]) => labels[field] ? <label key={field}>
        <span><input type="checkbox" checked={selected.includes(field)} onChange={event => setSelected(values =>
          event.target.checked ? [...values, field] : values.filter(value => value !== field))} />{t(labels[field])}</span>
        <small>{t("library.recognition.current")}: {display(current[field])}</small>
        <span>{t("library.recognition.suggested")}: {display(candidate.value)}</span>
        <small>{t(sources[candidate.source] ?? "library.recognition.source.unknown")}</small>
      </label> : null)}
      <button type="button" disabled={!selected.length || disabled} onClick={() => onApply(selected)}>
        <Sparkles size={14} aria-hidden="true" />{t("library.recognition.apply")}
      </button>
    </fieldset> : null}
  </section>;
}
