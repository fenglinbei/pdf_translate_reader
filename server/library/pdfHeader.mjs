import { readEmbeddedMetadata } from "../../shared/pdfMetadata.mjs";

async function downloadBounded(client, bucket, path, limit, signal) {
  const { data, error } = await client.storage.from(bucket).createSignedUrl(path, 180);
  if (error || !data?.signedUrl) throw new Error("storage_unavailable");
  const response = await fetch(data.signedUrl, { signal });
  if (!response.ok || Number(response.headers.get("content-length")) > limit) throw new Error("file_unavailable");
  const reader = response.body.getReader(); const parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("file_too_large");
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  } finally { await reader.cancel().catch(() => {}); }
}

export function extractHeaderLines(items) {
  const lines = []; let current;
  for (const item of items) {
    if (typeof item.str !== "string" || !item.str.trim()) continue;
    const y = item.transform?.[5] ?? 0;
    const size = Math.abs(item.height ?? item.transform?.[3] ?? 0);
    if (!current || Math.abs(current.y - y) > Math.max(3, size * 0.5)) {
      current = { text: item.str, size, y }; lines.push(current);
    } else { current.text += ` ${item.str}`; current.size = Math.max(current.size, size); }
    if (item.hasEOL) current = undefined;
  }
  return lines;
}

export async function extractPdfHeader(bytes, signal) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  signal.throwIfAborted();
  const task = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const cancel = () => { void task.destroy().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const pdf = await task.promise;
    const { info, metadata } = await pdf.getMetadata();
    const embedded = readEmbeddedMetadata(info, metadata);
    const pages = []; let layoutTitle;
    for (let index = 1; index <= Math.min(3, pdf.numPages); index++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(index);
      const lines = extractHeaderLines((await page.getTextContent()).items);
      pages.push(lines.map(line => line.text).join("\n").slice(0, 12000));
      if (index === 1) {
        const upper = lines.filter(line => line.y > page.view[3] * 0.5 && line.text.length > 8 &&
          !/^(arxiv|https?:|doi:|©|copyright|preprint|accepted|published)/i.test(line.text.trim()));
        const largest = Math.max(...upper.map(line => line.size), 0);
        const titleLines = upper.filter(line => line.size >= largest - 0.5).slice(0, 4);
        const title = titleLines.map(line => line.text).join(" ");
        if (largest >= 13 && title.length >= 12 && title.length <= 500) layoutTitle = title;
      }
      page.cleanup();
    }
    return { ...embedded, pages, layoutTitle };
  } finally {
    signal.removeEventListener("abort", cancel);
    await task.destroy().catch(() => {});
  }
}

export async function loadDocumentHeader(document, client, signal) {
  let header; let pdfError;
  try {
    if (document.file_size > 100 * 1024 * 1024) throw new Error("file_too_large");
    const bytes = await downloadBounded(client, "user-pdfs", document.storage_path, 100 * 1024 * 1024, signal);
    header = await extractPdfHeader(bytes, signal);
  } catch (error) { pdfError = error; }
  if ((header?.pages.join(" ").trim().length ?? 0) >= 60) return header;
  // Reading cached OCR never creates a paid parsing or QA indexing request.
  try {
    const { data, error } = await client.from("user_mathpix_documents")
      .select("pages_storage_path").eq("user_id", document.user_id).eq("user_document_id", document.id)
      .eq("content_sha256", document.content_sha256).eq("status", "completed").is("deleted_at", null)
      .order("updated_at", { ascending: false }).limit(1).maybeSingle();
    if (!error && data?.pages_storage_path) {
      const bytes = await downloadBounded(client, "user-mathpix", data.pages_storage_path, 8 * 1024 * 1024, signal);
      const payload = JSON.parse(bytes.toString("utf8"));
      if (Array.isArray(payload)) {
        const pages = payload.filter(page => Number.isInteger(page.pageIndex) && page.pageIndex < 3 && page.pageIndex >= 0)
          .sort((a, b) => a.pageIndex - b.pageIndex).map(page => String(page.pageText || page.pageMmd || "").slice(0, 12000));
        if (pages.join(" ").trim()) return { ...header, pages, authors: header?.authors ?? [] };
      }
    }
  } catch { /* Preserve PDF text when a cached OCR result cannot be loaded. */ }
  if (pdfError) throw pdfError;
  return header;
}
