import { Upload } from "lucide-react";
import { useCallback, useId, useState } from "react";

type PdfImportDropzoneProps = {
  isImporting: boolean;
  onImport: (file: File) => void;
  variant?: "full" | "compact";
};

export function PdfImportDropzone({
  isImporting,
  onImport,
  variant = "full",
}: PdfImportDropzoneProps) {
  const inputId = useId();
  const [isDragging, setIsDragging] = useState(false);
  const importLabel = variant === "compact" ? "Import" : "Import PDF or Package";
  const importTitle = "Import PDF or reading package";

  const importFirstSupportedFile = useCallback(
    (files: FileList | File[]) => {
      const pdfFile = Array.from(files).find(isSupportedImportFile);

      if (pdfFile) {
        onImport(pdfFile);
      }
    },
    [onImport],
  );

  return (
    <div
      className={`pdf-dropzone pdf-dropzone--${variant} ${
        isDragging ? "pdf-dropzone--dragging" : ""
      }`}
      onDragEnter={(event) => {
        event.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (event.currentTarget === event.target) {
          setIsDragging(false);
        }
      }}
      onDragOver={(event) => {
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        setIsDragging(false);
        importFirstSupportedFile(event.dataTransfer.files);
      }}
    >
      <input
        id={inputId}
        type="file"
        accept="application/pdf,.pdf,.ptrx,.pdftr.zip,application/zip"
        disabled={isImporting}
        onChange={(event) => {
          if (event.target.files) {
            importFirstSupportedFile(event.target.files);
          }
          event.currentTarget.value = "";
        }}
      />
      <label
        aria-label={importTitle}
        className="pdf-dropzone-trigger"
        htmlFor={inputId}
        title={importTitle}
      >
        <Upload aria-hidden="true" size={18} strokeWidth={2} />
        <span>{isImporting ? "Importing..." : importLabel}</span>
      </label>
      {variant === "full" ? <p>Choose a PDF or reading package, or drop it here.</p> : null}
    </div>
  );
}

function isSupportedImportFile(file: File) {
  const name = file.name.toLowerCase();

  return (
    file.type === "application/pdf" ||
    file.type === "application/zip" ||
    name.endsWith(".pdf") ||
    name.endsWith(".ptrx") ||
    name.endsWith(".pdftr.zip")
  );
}
