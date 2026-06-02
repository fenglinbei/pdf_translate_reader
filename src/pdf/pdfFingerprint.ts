import { pdfjsLib } from "./pdfjs";
import type { PdfFingerprint, PdfMetadata } from "../types/domain";

type PdfInfoDictionary = {
  Title?: unknown;
  Author?: unknown;
};

export async function createPdfFingerprint(file: File): Promise<PdfFingerprint> {
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(arrayBuffer.slice(0)),
  });
  let pdfDocument: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]> | undefined;

  try {
    pdfDocument = await loadingTask.promise;
    const metadata = await readPdfMetadata(pdfDocument);
    const pdfFingerprint = pdfDocument.fingerprints.find((fingerprint) => fingerprint?.trim());
    const fallbackFingerprint = pdfFingerprint ? undefined : await hashArrayBuffer(arrayBuffer);

    return {
      fingerprint: pdfFingerprint ?? fallbackFingerprint ?? createMetadataFallbackFingerprint(file),
      fileName: file.name,
      fileSize: file.size,
      modifiedAt: file.lastModified || undefined,
      pdfMetadata: metadata,
    };
  } finally {
    if (pdfDocument) {
      await pdfDocument.destroy().catch(() => undefined);
    } else {
      await loadingTask.destroy().catch(() => undefined);
    }
  }
}

async function readPdfMetadata(
  pdfDocument: Awaited<ReturnType<typeof pdfjsLib.getDocument>["promise"]>,
): Promise<PdfMetadata | undefined> {
  try {
    const { info, metadata } = await pdfDocument.getMetadata();
    const infoDictionary = info as PdfInfoDictionary;
    const title = firstTextValue(
      metadata?.get("dc:title"),
      metadata?.get("title"),
      infoDictionary.Title,
    );
    const author = firstTextValue(
      metadata?.get("dc:creator"),
      metadata?.get("author"),
      infoDictionary.Author,
    );

    if (!title && !author) {
      return undefined;
    }

    return { title, author };
  } catch {
    return undefined;
  }
}

function firstTextValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string") {
      const normalized = value.trim();

      if (normalized) {
        return normalized;
      }
    }
  }

  return undefined;
}

async function hashArrayBuffer(arrayBuffer: ArrayBuffer) {
  const digest = await globalThis.crypto?.subtle?.digest("SHA-256", arrayBuffer.slice(0));

  if (!digest) {
    return fallbackHashArrayBuffer(arrayBuffer);
  }

  const bytes = Array.from(new Uint8Array(digest));

  return `sha256-${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function fallbackHashArrayBuffer(arrayBuffer: ArrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  let hash = 0x811c9dc5;

  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }

  return `fnv1a32-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function createMetadataFallbackFingerprint(file: File) {
  return `file-${file.name}-${file.size}-${file.lastModified || 0}`;
}
