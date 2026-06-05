export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = sanitizeDownloadFileName(fileName);
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function replaceFileExtension(fileName: string, extension: string) {
  const cleanExtension = extension.startsWith(".") ? extension : `.${extension}`;
  const baseName = fileName.replace(/\.[^./\\]+$/, "");

  return `${baseName || "document"}${cleanExtension}`;
}

function sanitizeDownloadFileName(fileName: string) {
  return fileName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "download";
}
