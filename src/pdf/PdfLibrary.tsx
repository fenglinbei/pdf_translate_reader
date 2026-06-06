import { ArrowDownAZ, Check, Clock3, FileText, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { CloudPdfLibraryEntry } from "../types/domain";

type PdfLibraryProps = {
  activeFingerprint?: string;
  entries: CloudPdfLibraryEntry[];
  onDelete?: (entry: CloudPdfLibraryEntry) => Promise<void> | void;
  onOpen: (entry: CloudPdfLibraryEntry) => void;
  showControls?: boolean;
};
type PdfLibrarySortMode = "name" | "opened";

const fileNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

export function PdfLibrary({
  activeFingerprint,
  entries,
  onDelete,
  onOpen,
  showControls = false,
}: PdfLibraryProps) {
  const { formatDate, t } = useI18n();
  const [confirmingDeleteFingerprint, setConfirmingDeleteFingerprint] = useState<string>();
  const [deletingFingerprint, setDeletingFingerprint] = useState<string>();
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<PdfLibrarySortMode>("name");
  const visibleEntries = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filteredEntries = normalizedQuery
      ? entries.filter((entry) => getSearchText(entry).includes(normalizedQuery))
      : entries;

    return filteredEntries
      .slice()
      .sort((left, right) => compareLibraryEntries(left, right, sortMode));
  }, [entries, query, sortMode]);

  if (entries.length === 0) {
    return <div className="library-empty">{t("library.empty")}</div>;
  }

  const handleConfirmDelete = async (entry: CloudPdfLibraryEntry) => {
    if (!onDelete) {
      return;
    }

    setDeletingFingerprint(entry.fingerprint);
    try {
      await onDelete(entry);
      setConfirmingDeleteFingerprint(undefined);
    } finally {
      setDeletingFingerprint(undefined);
    }
  };

  const nextSortMode = sortMode === "name" ? "opened" : "name";
  const sortButtonLabel =
    sortMode === "name" ? t("library.sortedByName") : t("library.sortedByLastOpened");

  return (
    <div className="library-block">
      {showControls ? (
        <div className="library-controls">
          <label className="library-search">
            <Search aria-hidden="true" size={15} strokeWidth={2} />
            <span className="sr-only">{t("library.search")}</span>
            <input
              className="library-search-input"
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("library.searchPlaceholder")}
              type="search"
              value={query}
            />
          </label>
          <button
            aria-label={
              nextSortMode === "name"
                ? t("library.switchToNameSorting")
                : t("library.switchToLastOpenedSorting")
            }
            className="icon-button library-sort-button"
            onClick={() => setSortMode(nextSortMode)}
            title={sortButtonLabel}
            type="button"
          >
            {sortMode === "name" ? (
              <ArrowDownAZ aria-hidden="true" size={16} strokeWidth={2} />
            ) : (
              <Clock3 aria-hidden="true" size={16} strokeWidth={2} />
            )}
          </button>
        </div>
      ) : null}

      {visibleEntries.length === 0 ? (
        <div className="library-empty">{t("library.noMatches")}</div>
      ) : (
        <div className="library-list">
          {visibleEntries.map((entry) => {
            const title = entry.pdfMetadata?.title || entry.fileName;
            const isActive = entry.fingerprint === activeFingerprint;
            const isConfirmingDelete = confirmingDeleteFingerprint === entry.fingerprint;
            const isDeleting = deletingFingerprint === entry.fingerprint;

            return (
              <article
                className={`library-item ${isActive ? "library-item--active" : ""}`}
                key={entry.fingerprint}
              >
                <button
                  className="library-item-open-button"
                  disabled={isDeleting}
                  onClick={() => onOpen(entry)}
                  type="button"
                >
                  <FileText aria-hidden="true" size={16} strokeWidth={2} />
                  <span className="library-item-main">
                    <span className="library-item-title">{title}</span>
                    <span className="library-item-meta">
                      {formatFileSize(entry.fileSize)} · {formatDate(entry.lastOpenedAt, {
                        month: "short",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </span>
                </button>
                {onDelete ? (
                  <div className="library-item-actions">
                    {isConfirmingDelete ? (
                      <>
                        <button
                          aria-label={`Confirm delete ${entry.fileName}`}
                          className="icon-button icon-button--small icon-button--success"
                          disabled={isDeleting}
                          onClick={() => void handleConfirmDelete(entry)}
                          title={t("common.confirm")}
                          type="button"
                        >
                          <Check aria-hidden="true" size={15} strokeWidth={2} />
                        </button>
                        <button
                          aria-label={`Cancel delete ${entry.fileName}`}
                          className="icon-button icon-button--small icon-button--danger"
                          disabled={isDeleting}
                          onClick={() => setConfirmingDeleteFingerprint(undefined)}
                          title={t("common.cancel")}
                          type="button"
                        >
                          <X aria-hidden="true" size={15} strokeWidth={2} />
                        </button>
                      </>
                    ) : (
                      <button
                        aria-label={`Delete ${entry.fileName} from library`}
                        className="icon-button icon-button--small"
                        disabled={isDeleting}
                        onClick={() => setConfirmingDeleteFingerprint(entry.fingerprint)}
                        title={t("library.deleteHistory")}
                        type="button"
                      >
                        <Trash2 aria-hidden="true" size={15} strokeWidth={2} />
                      </button>
                    )}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function compareLibraryEntries(
  left: CloudPdfLibraryEntry,
  right: CloudPdfLibraryEntry,
  sortMode: PdfLibrarySortMode,
) {
  if (sortMode === "opened" && left.lastOpenedAt !== right.lastOpenedAt) {
    return right.lastOpenedAt - left.lastOpenedAt;
  }

  const nameResult = fileNameCollator.compare(left.fileName, right.fileName);

  if (nameResult !== 0) {
    return nameResult;
  }

  return left.fingerprint.localeCompare(right.fingerprint);
}

function getEntryDisplayName(entry: CloudPdfLibraryEntry) {
  return entry.pdfMetadata?.title || entry.fileName;
}

function getSearchText(entry: CloudPdfLibraryEntry) {
  return [
    entry.fileName,
    entry.pdfMetadata?.title,
    entry.pdfMetadata?.author,
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
