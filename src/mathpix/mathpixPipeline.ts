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
  backfillCloudMathpixProcessingRecord,
  claimCloudMathpixSubmission,
  downloadCompletedCloudMathpixCache,
  getCloudMathpixDocumentRecord,
  isCloudMathpixRecordStale,
  syncCloudMathpixDocumentRecord,
} from "./mathpixCloudRepository";
import {
  isMathpixCloudCacheSyncedForEntry,
  reconcileMathpixCache,
} from "./mathpixCacheReconciliation";
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
  expectedUserId?: string;
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

class CloudMathpixCacheDownloadError extends Error {
  constructor(error: unknown) {
    super(getErrorMessage(error));
    this.name = "CloudMathpixCacheDownloadError";
  }
}

export async function runMathpixParsePipeline({
  entry,
  expectedUserId,
  onPages,
  onRecord,
  signal,
}: RunMathpixParsePipelineInput) {
  let record = await getMathpixDocumentRecord(entry.fingerprint);

  if (isCompletedCurrentMathpixRecord(record, entry)) {
    const pages = await listMathpixParsedPages(entry.fingerprint);

    if (pages.length > 0 || record?.completedAt) {
      onRecord?.(record!);
      onPages?.(pages);

      const reconciledCache = await reconcileMathpixCache(entry, {
        expectedUserId,
        signal,
      }).catch(ignoreNonAbortError);

      if (reconciledCache) {
        onRecord?.(reconciledCache.record);
        onPages?.(reconciledCache.pages);
        return {
          pages: reconciledCache.pages,
          record: reconciledCache.record,
        };
      }

      return { pages, record: record! };
    }
  }

  const reconciledCache = await reconcileMathpixCache(entry, {
    expectedUserId,
    signal,
  }).catch(ignoreNonAbortError);

  if (reconciledCache) {
    onRecord?.(reconciledCache.record);
    onPages?.(reconciledCache.pages);
    return {
      pages: reconciledCache.pages,
      record: reconciledCache.record,
    };
  }

  const reusableLocalRecord = shouldReuseRecord(record, entry) ? record : undefined;
  const cloudStart = await getCloudMathpixPipelineStart(
    entry,
    reusableLocalRecord,
    signal,
    expectedUserId,
  );

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
    const latestCloudRecord = await getCloudMathpixDocumentRecord(entry, expectedUserId)
      .catch(ignoreNonAbortError);

    if (
      latestCloudRecord?.mathpixPdfId &&
      shouldReuseCloudProcessingRecord(latestCloudRecord)
    ) {
      record = await putMathpixDocumentRecord(latestCloudRecord);
      onRecord?.(record);
    }
  }

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
    await backfillCloudMathpixProcessingRecord(entry, record, expectedUserId)
      .catch(ignoreNonAbortError);
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
    if (nextStatus !== "completed") {
      await backfillCloudMathpixProcessingRecord(entry, record, expectedUserId)
        .catch(ignoreNonAbortError);
    }
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

      const reconciledCache = await reconcileMathpixCache(entry, {
        expectedUserId,
        signal,
      }).catch(ignoreNonAbortError);

      if (reconciledCache) {
        record = reconciledCache.record;
        onRecord?.(record);
      }

      const cloudCacheSynced = isMathpixCloudCacheSyncedForEntry(record, entry);

      if (record.deleteRemoteAfterCache && (!requiresCloudCacheBeforeRemoteDelete(entry) || cloudCacheSynced)) {
        record = await deleteRemoteAfterCache(
          entry,
          record,
          onRecord,
          expectedUserId,
        ).catch(() => record);
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
  expectedUserId?: string,
): Promise<CloudMathpixPipelineStart | undefined> {
  try {
    let cloudRecord = await getCloudMathpixDocumentRecord(entry, expectedUserId);

    if (cloudRecord?.status === "completed") {
      const cache = await tryDownloadCompletedCloudMathpixCache(
        entry,
        cloudRecord,
      );

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

      const waitedStart = await waitForCloudMathpixProcessingRecord(
        entry,
        signal,
        expectedUserId,
      );

      if (waitedStart) {
        return waitedStart;
      }

      cloudRecord = await getCloudMathpixDocumentRecord(entry, expectedUserId);
    }

    if (!cloudRecord && localRecord?.mathpixPdfId) {
      if (localRecord.status !== "completed") {
        await backfillCloudMathpixProcessingRecord(entry, localRecord, expectedUserId)
          .catch(ignoreNonAbortError);
      }

      return { kind: "record", record: localRecord };
    }

    const claim = await claimCloudMathpixSubmission(entry, expectedUserId);

    if (!claim.record) {
      return undefined;
    }

    if (claim.record.status === "completed") {
      const cache = await tryDownloadCompletedCloudMathpixCache(
        entry,
        claim.record,
      );

      if (cache) {
        return cache;
      }
    }

    if (!claim.claimed && shouldReuseCloudProcessingRecord(claim.record)) {
      if (claim.record.mathpixPdfId) {
        return { kind: "record", record: claim.record };
      }

      return waitForCloudMathpixProcessingRecord(entry, signal, expectedUserId);
    }

    return {
      kind: "record",
      record: claim.record,
    };
  } catch (error) {
    if (isAbortError(error) || error instanceof CloudMathpixCacheDownloadError) {
      throw error;
    }

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
    throw new CloudMathpixCacheDownloadError(error);
  }
}

async function waitForCloudMathpixProcessingRecord(
  entry: PdfLibraryEntry,
  signal: AbortSignal | undefined,
  expectedUserId?: string,
): Promise<CloudMathpixPipelineStart | undefined> {
  while (true) {
    assertNotAborted(signal);
    const record = await getCloudMathpixDocumentRecord(entry, expectedUserId);

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
  expectedUserId?: string,
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
  await syncCloudMathpixDocumentRecord(entry, updatedRecord, expectedUserId)
    .catch(() => undefined);

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

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function ignoreNonAbortError(error: unknown): undefined {
  if (isAbortError(error)) {
    throw error;
  }

  return undefined;
}
