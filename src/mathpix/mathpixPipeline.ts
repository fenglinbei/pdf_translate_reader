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
import {
  claimCloudMathpixSubmission,
  downloadCompletedCloudMathpixCache,
  getCloudMathpixDocumentRecord,
  isCloudMathpixRecordStale,
  markCloudMathpixDocumentError,
  syncCloudMathpixDocumentRecord,
  uploadCompletedCloudMathpixCache,
} from "./mathpixCloudRepository";
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

type CloudMathpixPipelineStart =
  | {
      kind: "cache";
      pages: MathpixParsedPage[];
      record: MathpixDocumentRecord;
    }
  | {
      kind: "record";
      record: MathpixDocumentRecord;
    };

const POLL_INTERVAL_MS = 5000;
const CLOUD_RECORD_POLL_INTERVAL_MS = 2000;

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

  const reusableLocalRecord = shouldReuseRecord(record, entry) ? record : undefined;
  const cloudStart = await getCloudMathpixPipelineStart(entry, reusableLocalRecord, signal);

  if (cloudStart?.kind === "cache") {
    await replaceMathpixParsedPages(entry.fingerprint, cloudStart.pages);
    record = await putMathpixDocumentRecord(cloudStart.record);
    onRecord?.(record);
    onPages?.(cloudStart.pages);
    return { pages: cloudStart.pages, record };
  }

  if (cloudStart?.kind === "record") {
    record = await putMathpixDocumentRecord(cloudStart.record);
  } else if (!reusableLocalRecord) {
    record = await createPendingMathpixDocumentRecord(entry);
  } else {
    record = reusableLocalRecord;
  }

  if (!record) {
    throw new Error("Could not create Mathpix parse record.");
  }

  onRecord?.(record);

  if (!record.mathpixPdfId) {
    assertNotAborted(signal);
    const submitted = await submitMathpixDocument(entry, signal);
    const now = Date.now();

    record = await putMathpixDocumentRecord({
      ...record,
      deleteRemoteAfterCache: submitted.deleteRemoteAfterCache,
      mathpixPdfId: submitted.mathpixPdfId,
      status: "submitted",
      submittedAt: record.submittedAt ?? now,
      updatedAt: now,
    });
    await syncCloudMathpixDocumentRecord(entry, record).catch(() => undefined);
    onRecord?.(record);
  }

  const mathpixPdfId = record.mathpixPdfId;

  if (!mathpixPdfId) {
    throw new Error("Mathpix PDF id is missing.");
  }

  while (true) {
    assertNotAborted(signal);
    const status = await getMathpixDocumentStatus(mathpixPdfId, signal);
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
    await syncCloudMathpixDocumentRecord(entry, record).catch(() => undefined);
    onRecord?.(record);

    if (nextStatus === "completed") {
      const [linesJson, fullMmd] = await Promise.all([
        getMathpixDocumentResult(mathpixPdfId, "lines.json", signal),
        getMathpixDocumentResult(mathpixPdfId, "mmd", signal).catch(() => ""),
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

      const cloudCacheSynced = await syncCompletedMathpixCacheToCloud({
        entry,
        fullMmd,
        pages,
        record,
      }).then((syncedRecord) => {
        if (!syncedRecord) {
          return false;
        }

        record = syncedRecord;
        onRecord?.(record);
        return true;
      });

      if (record.deleteRemoteAfterCache && (!requiresCloudCacheBeforeRemoteDelete(entry) || cloudCacheSynced)) {
        record = await deleteRemoteAfterCache(entry, record, onRecord).catch(() => record);
      }

      return { pages, record };
    }

    if (nextStatus === "error") {
      return { pages: [], record };
    }

    await waitForPoll(signal);
  }
}

async function getCloudMathpixPipelineStart(
  entry: PdfLibraryEntry,
  localRecord: MathpixDocumentRecord | undefined,
  signal: AbortSignal | undefined,
): Promise<CloudMathpixPipelineStart | undefined> {
  try {
    let cloudRecord = await getCloudMathpixDocumentRecord(entry);

    if (cloudRecord?.status === "completed") {
      const cache = await tryDownloadCompletedCloudMathpixCache(entry, cloudRecord);

      if (cache) {
        return cache;
      }

      cloudRecord = {
        ...cloudRecord,
        status: "error",
        updatedAt: Date.now(),
      };
    }

    if (cloudRecord && shouldReuseCloudProcessingRecord(cloudRecord)) {
      if (cloudRecord.mathpixPdfId) {
        return { kind: "record", record: cloudRecord };
      }

      const waitedStart = await waitForCloudMathpixProcessingRecord(entry, signal);

      if (waitedStart) {
        return waitedStart;
      }

      cloudRecord = await getCloudMathpixDocumentRecord(entry);
    }

    if (!cloudRecord && localRecord?.mathpixPdfId) {
      if (localRecord.status !== "completed") {
        await syncCloudMathpixDocumentRecord(entry, localRecord).catch(() => undefined);
      }

      return { kind: "record", record: localRecord };
    }

    const claim = await claimCloudMathpixSubmission(entry);

    if (!claim.record) {
      return undefined;
    }

    if (claim.record.status === "completed") {
      const cache = await tryDownloadCompletedCloudMathpixCache(entry, claim.record);

      if (cache) {
        return cache;
      }
    }

    if (!claim.claimed && shouldReuseCloudProcessingRecord(claim.record)) {
      if (claim.record.mathpixPdfId) {
        return { kind: "record", record: claim.record };
      }

      return waitForCloudMathpixProcessingRecord(entry, signal);
    }

    return {
      kind: "record",
      record: claim.record,
    };
  } catch {
    return undefined;
  }
}

async function tryDownloadCompletedCloudMathpixCache(
  entry: PdfLibraryEntry,
  record: MathpixDocumentRecord,
): Promise<CloudMathpixPipelineStart | undefined> {
  try {
    const cache = await downloadCompletedCloudMathpixCache(entry, record);

    return cache ? { kind: "cache", ...cache } : undefined;
  } catch (error) {
    await markCloudMathpixDocumentError(entry, getErrorMessage(error)).catch(() => undefined);
    return undefined;
  }
}

async function waitForCloudMathpixProcessingRecord(
  entry: PdfLibraryEntry,
  signal: AbortSignal | undefined,
): Promise<CloudMathpixPipelineStart | undefined> {
  while (true) {
    assertNotAborted(signal);
    const record = await getCloudMathpixDocumentRecord(entry);

    if (!record || record.status === "error" || record.status === "deleted" || isCloudMathpixRecordStale(record)) {
      return undefined;
    }

    if (record.status === "completed") {
      return tryDownloadCompletedCloudMathpixCache(entry, record);
    }

    if (record.mathpixPdfId) {
      return { kind: "record", record };
    }

    await waitForCloudRecord(signal);
  }
}

function shouldReuseCloudProcessingRecord(record: MathpixDocumentRecord) {
  return (
    (record.status === "submitted" || record.status === "processing") &&
    !isCloudMathpixRecordStale(record)
  );
}

async function syncCompletedMathpixCacheToCloud({
  entry,
  fullMmd,
  pages,
  record,
}: {
  entry: PdfLibraryEntry;
  fullMmd?: string;
  pages: MathpixParsedPage[];
  record: MathpixDocumentRecord;
}) {
  try {
    const syncedRecord = await uploadCompletedCloudMathpixCache({
      entry,
      fullMmd,
      pages,
      record,
    });

    if (!syncedRecord) {
      return undefined;
    }

    return putMathpixDocumentRecord({
      ...record,
      cloudMathpixSyncedAt: syncedRecord.cloudMathpixSyncedAt ?? Date.now(),
      fullMmd: record.fullMmd ?? syncedRecord.fullMmd,
      fullMmdStoragePath: syncedRecord.fullMmdStoragePath,
      pagesStoragePath: syncedRecord.pagesStoragePath,
      updatedAt: Date.now(),
    });
  } catch (error) {
    await markCloudMathpixDocumentError(entry, getErrorMessage(error)).catch(() => undefined);
    return undefined;
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
  entry: PdfLibraryEntry,
  record: MathpixDocumentRecord,
  onRecord?: (record: MathpixDocumentRecord) => void,
) {
  if (!record.mathpixPdfId) {
    return record;
  }

  await deleteMathpixRemoteDocument(record.mathpixPdfId);
  const updatedRecord = await putMathpixDocumentRecord({
    ...record,
    remoteDeletedAt: Date.now(),
    updatedAt: Date.now(),
  });
  await syncCloudMathpixDocumentRecord(entry, updatedRecord).catch(() => undefined);

  onRecord?.(updatedRecord);

  return updatedRecord;
}

function requiresCloudCacheBeforeRemoteDelete(entry: PdfLibraryEntry) {
  return Boolean(entry.cloudDocumentId && entry.contentSha256);
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

function waitForCloudRecord(signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, CLOUD_RECORD_POLL_INTERVAL_MS);

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

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "MathPix cloud cache sync failed.";
}
