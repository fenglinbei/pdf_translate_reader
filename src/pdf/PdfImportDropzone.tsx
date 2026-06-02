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

  const importFirstPdf = useCallback(
    (files: FileList | File[]) => {
      const pdfFile = Array.from(files).find(isPdfFile);

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
        importFirstPdf(event.dataTransfer.files);
      }}
    >
      <input
        id={inputId}
        type="file"
        accept="application/pdf,.pdf"
        disabled={isImporting}
        onChange={(event) => {
          if (event.target.files) {
            importFirstPdf(event.target.files);
          }
          event.currentTarget.value = "";
        }}
      />
      <label className="pdf-dropzone-trigger" htmlFor={inputId}>
        <Upload aria-hidden="true" size={18} strokeWidth={2} />
        <span>{isImporting ? "Importing..." : "Import PDF"}</span>
      </label>
      {variant === "full" ? <p>Choose a PDF or drop it here.</p> : null}
    </div>
  );
}

function isPdfFile(file: File) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}
