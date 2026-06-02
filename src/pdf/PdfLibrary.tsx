import { FileText } from "lucide-react";
import type { PdfLibraryEntry } from "../types/domain";

type PdfLibraryProps = {
  activeFingerprint?: string;
  entries: PdfLibraryEntry[];
  onOpen: (fingerprint: string) => void;
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function PdfLibrary({ activeFingerprint, entries, onOpen }: PdfLibraryProps) {
  if (entries.length === 0) {
    return <div className="library-empty">No PDFs imported yet.</div>;
  }

  return (
    <div className="library-list">
      {entries.map((entry) => {
        const title = entry.pdfMetadata?.title || entry.fileName;
        const isActive = entry.fingerprint === activeFingerprint;

        return (
          <button
            className={`library-item ${isActive ? "library-item--active" : ""}`}
            key={entry.fingerprint}
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
        );
      })}
    </div>
  );
}

function formatFileSize(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
