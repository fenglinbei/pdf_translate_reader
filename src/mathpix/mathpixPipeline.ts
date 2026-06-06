import type {
  MathpixDocumentRecord,
  MathpixParsedPage,
  MathpixParseStatus,
  PdfLibraryEntry,
} from "../types/domain";
import {
  deleteMathpixRemoteDocument,
  getMathpixDocumentResult,
  getMathpixDocumentStatus,
  submitMathpixDocument,
} from "./mathpixClient";
import { normalizeMathpixLinesJson } from "./mathpixNormalizer";
import {
  createPendingMathpixDocumentRecord,
  getMathpixDocumentRecord,
  isCompletedCurrentMathpixRecord,
  listMathpixParsedPages,
  putMathpixDocumentRecord,
  replaceMathpixParsedPages,
} from "./mathpixRepository";
import { MATHPIX_OPTIONS_HASH } from "./options";

type RunMathpixParsePipelineInput = {
  entry: PdfLibraryEntry;
  onPages?: (pages: MathpixParsedPage[]) => void;
  onRecord?: (record: MathpixDocumentRecord) => void;
  signal?: AbortSignal;
};

const POLL_INTERVAL_MS = 5000;

export async function runMathpixParsePipeline({
  entry,
  onPages,
  onRecord,
  signal,
}: RunMathpixParsePipelineInput) {
  let record = await getMathpixDocumentRecord(entry.fingerprint);

  if (isCompletedCurrentMathpixRecord(record, entry)) {
    const pages = await listMathpixParsedPages(entry.fingerprint);

    if (pages.length > 0) {
      onRecord?.(record!);
      onPages?.(pages);
      return { pages, record: record! };
    }
  }

  if (!shouldReuseRecord(record, entry)) {
    record = await createPendingMathpixDocumentRecord(entry);
  }

  if (!record) {
    throw new Error("Could not create Mathpix parse record.");
  }

  onRecord?.(record);

  if (!record.mathpixPdfId) {
    assertNotAborted(signal);
    const submitted = await submitMathpixDocument(entry);
    const now = Date.now();

    record = await putMathpixDocumentRecord({
      ...record,
      deleteRemoteAfterCache: submitted.deleteRemoteAfterCache,
      mathpixPdfId: submitted.mathpixPdfId,
      status: "submitted",
      submittedAt: record.submittedAt ?? now,
      updatedAt: now,
    });
    onRecord?.(record);
  }

  const mathpixPdfId = record.mathpixPdfId;

  if (!mathpixPdfId) {
    throw new Error("Mathpix PDF id is missing.");
  }

  while (true) {
    assertNotAborted(signal);
    const status = await getMathpixDocumentStatus(mathpixPdfId);
    const nextStatus = normalizeMathpixStatus(status.status);
    const now = Date.now();

    record = await putMathpixDocumentRecord({
      ...record,
      errorMessage: status.error,
      numPages: status.numPages,
      numPagesCompleted: status.numPagesCompleted,
      percentDone: status.percentDone,
      status: nextStatus,
      updatedAt: now,
    });
    onRecord?.(record);

    if (nextStatus === "completed") {
      const [linesJson, fullMmd] = await Promise.all([
        getMathpixDocumentResult(mathpixPdfId, "lines.json"),
        getMathpixDocumentResult(mathpixPdfId, "mmd").catch(() => ""),
      ]);
      const pages = normalizeMathpixLinesJson({ entry, linesJson });

      await replaceMathpixParsedPages(entry.fingerprint, pages);
      record = await putMathpixDocumentRecord({
        ...record,
        completedAt: now,
        fullMmd: fullMmd || record.fullMmd,
        status: "completed",
        updatedAt: Date.now(),
      });
      onRecord?.(record);
      onPages?.(pages);

      if (record.deleteRemoteAfterCache) {
        await deleteRemoteAfterCache(record, onRecord).catch(() => undefined);
      }

      return { pages, record };
    }

    if (nextStatus === "error") {
      return { pages: [], record };
    }

    await waitForPoll(signal);
  }
}

function shouldReuseRecord(
  record: MathpixDocumentRecord | undefined,
  entry: PdfLibraryEntry,
) {
  return Boolean(
    record &&
      record.mathpixOptionsHash === MATHPIX_OPTIONS_HASH &&
      (!entry.contentSha256 || !record.contentSha256 || entry.contentSha256 === record.contentSha256) &&
      record.status !== "deleted" &&
      record.status !== "error",
  );
}

function normalizeMathpixStatus(status: string): MathpixParseStatus {
  if (status === "completed") {
    return "completed";
  }

  if (status === "error") {
    return "error";
  }

  return "processing";
}

async function deleteRemoteAfterCache(
  record: MathpixDocumentRecord,
  onRecord?: (record: MathpixDocumentRecord) => void,
) {
  if (!record.mathpixPdfId) {
    return;
  }

  await deleteMathpixRemoteDocument(record.mathpixPdfId);
  const updatedRecord = await putMathpixDocumentRecord({
    ...record,
    remoteDeletedAt: Date.now(),
    updatedAt: Date.now(),
  });

  onRecord?.(updatedRecord);
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new DOMException("Mathpix parsing was aborted.", "AbortError");
  }
}

function waitForPoll(signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, POLL_INTERVAL_MS);

    function handleAbort() {
      window.clearTimeout(timer);
      signal?.removeEventListener("abort", handleAbort);
      reject(new DOMException("Mathpix parsing was aborted.", "AbortError"));
    }

    if (signal?.aborted) {
      handleAbort();
      return;
    }

    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}
