import { ArrowDownAZ, Check, Clock3, FileText, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { PdfLibraryEntry } from "../types/domain";

type PdfLibraryProps = {
  activeFingerprint?: string;
  entries: PdfLibraryEntry[];
  onDelete?: (fingerprint: string) => Promise<void> | void;
  onOpen: (fingerprint: string) => void;
  showControls?: boolean;
};
type PdfLibrarySortMode = "name" | "opened";

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});
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
    return <div className="library-empty">No PDFs imported yet.</div>;
  }

  const handleConfirmDelete = async (fingerprint: string) => {
    if (!onDelete) {
      return;
    }

    setDeletingFingerprint(fingerprint);
    try {
      await onDelete(fingerprint);
      setConfirmingDeleteFingerprint(undefined);
    } finally {
      setDeletingFingerprint(undefined);
    }
  };

  const nextSortMode = sortMode === "name" ? "opened" : "name";
  const sortButtonLabel =
    sortMode === "name" ? "Sorted by file name" : "Sorted by last opened";

  return (
    <div className="library-block">
      {showControls ? (
        <div className="library-controls">
          <label className="library-search">
            <Search aria-hidden="true" size={15} strokeWidth={2} />
            <span className="sr-only">Search library</span>
            <input
              className="library-search-input"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search PDFs"
              type="search"
              value={query}
            />
          </label>
          <button
            aria-label={`Switch to ${nextSortMode === "name" ? "file name" : "last opened"} sorting`}
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
        <div className="library-empty">No matching PDFs.</div>
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
                  onClick={() => onOpen(entry.fingerprint)}
                  type="button"
                >
                  <FileText aria-hidden="true" size={16} strokeWidth={2} />
                  <span className="library-item-main">
                    <span className="library-item-title">{title}</span>
                    <span className="library-item-meta">
                      {formatFileSize(entry.fileSize)} · {dateFormatter.format(entry.lastOpenedAt)}
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
                          onClick={() => void handleConfirmDelete(entry.fingerprint)}
                          title="Confirm delete"
                          type="button"
                        >
                          <Check aria-hidden="true" size={15} strokeWidth={2} />
                        </button>
                        <button
                          aria-label={`Cancel delete ${entry.fileName}`}
                          className="icon-button icon-button--small icon-button--danger"
                          disabled={isDeleting}
                          onClick={() => setConfirmingDeleteFingerprint(undefined)}
                          title="Cancel"
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
                        title="Delete PDF history"
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
  left: PdfLibraryEntry,
  right: PdfLibraryEntry,
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

function getEntryDisplayName(entry: PdfLibraryEntry) {
  return entry.pdfMetadata?.title || entry.fileName;
}

function getSearchText(entry: PdfLibraryEntry) {
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
