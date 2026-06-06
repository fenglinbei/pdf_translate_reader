import { Upload } from "lucide-react";
import { useCallback, useId, useState } from "react";
import { useI18n } from "../i18n/I18nProvider";

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
  const { t } = useI18n();
  const inputId = useId();
  const [isDragging, setIsDragging] = useState(false);
  const importLabel = variant === "compact" ? t("import.compactLabel") : t("import.fullLabel");
  const importTitle = t("import.title");

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
        <span>{isImporting ? t("import.importing") : importLabel}</span>
      </label>
      {variant === "full" ? <p>{t("import.chooseFile")}</p> : null}
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
