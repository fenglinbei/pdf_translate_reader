import type {
  MathpixDocumentRecord,
  MathpixParsedPage,
  PdfLibraryEntry,
} from "../types/domain";
import {
  backfillCloudMathpixProcessingRecord,
  canUseCloudMathpixCache,
  downloadCompletedCloudMathpixCache,
  getCloudMathpixDocumentRecord,
  uploadCompletedCloudMathpixCache,
} from "./mathpixCloudRepository";
import {
  getMathpixDocumentRecord,
  isCompletedCurrentMathpixRecord,
  listMathpixParsedPages,
  putMathpixDocumentRecord,
  replaceMathpixParsedPages,
} from "./mathpixRepository";
import { MATHPIX_OPTIONS_HASH } from "./options";

export type MathpixCacheReconciliationResult = {
  cloudSynced: boolean;
  pages: MathpixParsedPage[];
  record: MathpixDocumentRecord;
  source: "cloud" | "local";
};

export type MathpixCacheReconciliationOptions = {
  expectedUserId?: string;
  signal?: AbortSignal;
};

export type MathpixCacheIdentity = Pick<
  PdfLibraryEntry,
  "cloudDocumentId" | "contentSha256" | "fingerprint"
>;

export type MathpixCacheReconciler = {
  (
    entry: PdfLibraryEntry,
    options?: MathpixCacheReconciliationOptions,
  ): Promise<MathpixCacheReconciliationResult | undefined>;
  waitForIdle: (
    entry: MathpixCacheIdentity,
    options?: Pick<MathpixCacheReconciliationOptions, "expectedUserId">,
  ) => Promise<void>;
};

export type MathpixCacheReconciliationDependencies = {
  backfillCloudProcessingRecord: typeof backfillCloudMathpixProcessingRecord;
  downloadCompletedCloudCache: typeof downloadCompletedCloudMathpixCache;
  getCloudRecord: typeof getCloudMathpixDocumentRecord;
  getLocalRecord: typeof getMathpixDocumentRecord;
  listLocalPages: typeof listMathpixParsedPages;
  putLocalRecord: typeof putMathpixDocumentRecord;
  replaceLocalPages: typeof replaceMathpixParsedPages;
  uploadCompletedCloudCache: typeof uploadCompletedCloudMathpixCache;
};

const DEFAULT_DEPENDENCIES: MathpixCacheReconciliationDependencies = {
  backfillCloudProcessingRecord: backfillCloudMathpixProcessingRecord,
  downloadCompletedCloudCache: downloadCompletedCloudMathpixCache,
  getCloudRecord: getCloudMathpixDocumentRecord,
  getLocalRecord: getMathpixDocumentRecord,
  listLocalPages: listMathpixParsedPages,
  putLocalRecord: putMathpixDocumentRecord,
  replaceLocalPages: replaceMathpixParsedPages,
  uploadCompletedCloudCache: uploadCompletedCloudMathpixCache,
};

export function createMathpixCacheReconciler(
  dependencies: MathpixCacheReconciliationDependencies,
): MathpixCacheReconciler {
  const queues = new Map<string, Promise<MathpixCacheReconciliationResult | undefined>>();

  const reconcile = ((
    entry: PdfLibraryEntry,
    options: MathpixCacheReconciliationOptions = {},
  ) => {
    assertNotAborted(options.signal);

    if (!canUseCloudMathpixCache(entry)) {
      return Promise.resolve(undefined);
    }

    const key = getReconciliationKey(entry, options.expectedUserId);
    const previousRequest = queues.get(key);
    const request = (previousRequest
      ? previousRequest.catch(() => undefined)
      : Promise.resolve(undefined)
    ).then(() => reconcileMathpixCacheInner(entry, dependencies, options));

    queues.set(key, request);
    void request.then(
      () => {
        if (queues.get(key) === request) {
          queues.delete(key);
        }
      },
      () => {
        if (queues.get(key) === request) {
          queues.delete(key);
        }
      },
    );
    return request;
  }) as MathpixCacheReconciler;

  reconcile.waitForIdle = async (
    entry: MathpixCacheIdentity,
    options: Pick<MathpixCacheReconciliationOptions, "expectedUserId"> = {},
  ) => {
    if (!entry.cloudDocumentId || !entry.contentSha256) {
      return;
    }

    const key = getReconciliationKey(entry, options.expectedUserId);

    while (true) {
      const pendingRequest = queues.get(key);

      if (!pendingRequest) {
        return;
      }

      await pendingRequest.catch(() => undefined);
      await Promise.resolve();
    }
  };

  return reconcile;
}

export const reconcileMathpixCache = createMathpixCacheReconciler(DEFAULT_DEPENDENCIES);

export function isMathpixCloudCacheSyncedForEntry(
  record: MathpixDocumentRecord | undefined,
  entry: PdfLibraryEntry,
) {
  return Boolean(
    record?.status === "completed" &&
      record.cloudDocumentId === entry.cloudDocumentId &&
      record.contentSha256 === entry.contentSha256 &&
      record.pagesStoragePath &&
      record.fullMmdStoragePath,
  );
}

async function reconcileMathpixCacheInner(
  entry: PdfLibraryEntry & { cloudDocumentId: string; contentSha256: string },
  dependencies: MathpixCacheReconciliationDependencies,
  options: MathpixCacheReconciliationOptions,
): Promise<MathpixCacheReconciliationResult | undefined> {
  assertNotAborted(options.signal);
  const localRecord = await dependencies.getLocalRecord(entry.fingerprint);
  const localPages = isCompletedCurrentMathpixRecord(localRecord, entry)
    ? await dependencies.listLocalPages(entry.fingerprint)
    : [];

  assertNotAborted(options.signal);
  const hasLocalCompletedCache = Boolean(
    isCompletedCurrentMathpixRecord(localRecord, entry) &&
    (localPages.length > 0 || localRecord?.completedAt),
  );

  if (localRecord && shouldBackfillProcessingRecord(localRecord, entry)) {
    await dependencies.backfillCloudProcessingRecord(
      entry,
      localRecord,
      options.expectedUserId,
    );
    assertNotAborted(options.signal);
  }

  if (localRecord && hasLocalCompletedCache) {
    const cloudRecord = await dependencies.getCloudRecord(entry, options.expectedUserId);

    assertNotAborted(options.signal);

    if (cloudRecord && hasCompleteCloudCache(cloudRecord)) {
      const mergedRecord = await dependencies.putLocalRecord(
        mergeCloudCacheMetadata(localRecord, cloudRecord, entry),
      );

      return {
        cloudSynced: true,
        pages: localPages,
        record: mergedRecord,
        source: "local",
      };
    }

    const uploadedRecord = await dependencies.uploadCompletedCloudCache({
      entry,
      expectedUserId: options.expectedUserId,
      fullMmd: localRecord.fullMmd,
      pages: localPages,
      record: localRecord,
    });

    assertNotAborted(options.signal);

    if (!uploadedRecord) {
      return {
        cloudSynced: false,
        pages: localPages,
        record: localRecord,
        source: "local",
      };
    }

    const syncedRecord = await dependencies.putLocalRecord(
      mergeCloudCacheMetadata(localRecord, uploadedRecord, entry),
    );

    return {
      cloudSynced: true,
      pages: localPages,
      record: syncedRecord,
      source: "local",
    };
  }

  const cloudRecord = await dependencies.getCloudRecord(entry, options.expectedUserId);

  assertNotAborted(options.signal);

  if (cloudRecord?.status !== "completed" || !cloudRecord.pagesStoragePath) {
    return undefined;
  }

  const cloudCache = await dependencies.downloadCompletedCloudCache(entry, cloudRecord);

  assertNotAborted(options.signal);

  if (!cloudCache) {
    return undefined;
  }

  let restoredRecord: MathpixDocumentRecord = {
    ...cloudCache.record,
    cloudMathpixSyncedAt: cloudRecord.updatedAt,
  };

  if (!cloudRecord.fullMmdStoragePath) {
    const uploadedRecord = await dependencies.uploadCompletedCloudCache({
      entry,
      expectedUserId: options.expectedUserId,
      fullMmd: restoredRecord.fullMmd,
      pages: cloudCache.pages,
      record: restoredRecord,
    });

    assertNotAborted(options.signal);

    if (uploadedRecord) {
      restoredRecord = mergeCloudCacheMetadata(restoredRecord, uploadedRecord, entry);
    }
  }

  await dependencies.replaceLocalPages(entry.fingerprint, cloudCache.pages);
  restoredRecord = await dependencies.putLocalRecord(restoredRecord);

  return {
    cloudSynced: hasCompleteCloudCache(restoredRecord),
    pages: cloudCache.pages,
    record: restoredRecord,
    source: "cloud",
  };
}

function getReconciliationKey(
  entry: MathpixCacheIdentity,
  expectedUserId?: string,
) {
  return [expectedUserId, entry.cloudDocumentId, entry.contentSha256, entry.fingerprint].join(":");
}

function assertNotAborted(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw new DOMException("MathPix cache reconciliation was aborted.", "AbortError");
  }
}

function shouldBackfillProcessingRecord(
  record: MathpixDocumentRecord,
  entry: PdfLibraryEntry & { contentSha256: string },
) {
  return Boolean(
    record.mathpixPdfId &&
      (record.status === "submitted" || record.status === "processing") &&
      record.mathpixOptionsHash === MATHPIX_OPTIONS_HASH &&
      (!record.contentSha256 || record.contentSha256 === entry.contentSha256),
  );
}

function hasCompleteCloudCache(record: MathpixDocumentRecord | undefined) {
  return Boolean(
    record?.status === "completed" &&
      record.pagesStoragePath &&
      record.fullMmdStoragePath,
  );
}

function mergeCloudCacheMetadata(
  localRecord: MathpixDocumentRecord,
  cloudRecord: MathpixDocumentRecord,
  entry: PdfLibraryEntry & { cloudDocumentId: string; contentSha256: string },
): MathpixDocumentRecord {
  return {
    ...localRecord,
    cloudDocumentId: entry.cloudDocumentId,
    cloudMathpixSyncedAt: cloudRecord.cloudMathpixSyncedAt ?? cloudRecord.updatedAt,
    contentSha256: entry.contentSha256,
    fullMmdStoragePath: cloudRecord.fullMmdStoragePath,
    pagesStoragePath: cloudRecord.pagesStoragePath,
    updatedAt: Math.max(localRecord.updatedAt, cloudRecord.updatedAt),
  };
}
