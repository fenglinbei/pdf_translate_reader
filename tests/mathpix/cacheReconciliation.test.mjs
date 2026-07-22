import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

let cacheReconciliation;
let options;
let vite;

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  [cacheReconciliation, options] = await Promise.all([
    vite.ssrLoadModule("/src/mathpix/mathpixCacheReconciliation.ts"),
    vite.ssrLoadModule("/src/mathpix/options.ts"),
  ]);
});

after(async () => {
  await vite?.close();
});

test("a completed local cache is uploaded without running MathPix again", async () => {
  const entry = createEntry();
  const pages = [createPage()];
  let localRecord = createCompletedRecord();
  let uploadCalls = 0;
  let downloadCalls = 0;
  const reconcile = cacheReconciliation.createMathpixCacheReconciler({
    backfillCloudProcessingRecord: async () => undefined,
    downloadCompletedCloudCache: async () => {
      downloadCalls += 1;
      return undefined;
    },
    getCloudRecord: async () => undefined,
    getLocalRecord: async () => localRecord,
    listLocalPages: async () => pages,
    putLocalRecord: async (record) => {
      localRecord = record;
      return record;
    },
    replaceLocalPages: async () => undefined,
    uploadCompletedCloudCache: async ({ record }) => {
      uploadCalls += 1;
      return {
        ...record,
        cloudDocumentId: entry.cloudDocumentId,
        cloudMathpixSyncedAt: 200,
        contentSha256: entry.contentSha256,
        fullMmdStoragePath: "user/hash/options/full.mmd",
        pagesStoragePath: "user/hash/options/pages.json",
        updatedAt: 200,
      };
    },
  });

  const result = await reconcile(entry);

  assert.equal(uploadCalls, 1);
  assert.equal(downloadCalls, 0);
  assert.equal(result.cloudSynced, true);
  assert.equal(result.source, "local");
  assert.equal(result.record.pagesStoragePath, "user/hash/options/pages.json");
  assert.equal(result.record.fullMmdStoragePath, "user/hash/options/full.mmd");
  assert.deepEqual(result.pages, pages);
});

test("a completed empty result is still uploaded as a valid cache", async () => {
  const entry = createEntry();
  const localRecord = createCompletedRecord();
  let uploadCalls = 0;
  const reconcile = cacheReconciliation.createMathpixCacheReconciler({
    backfillCloudProcessingRecord: async () => undefined,
    downloadCompletedCloudCache: async () => undefined,
    getCloudRecord: async () => undefined,
    getLocalRecord: async () => localRecord,
    listLocalPages: async () => [],
    putLocalRecord: async (record) => record,
    replaceLocalPages: async () => undefined,
    uploadCompletedCloudCache: async ({ pages, record }) => {
      uploadCalls += 1;
      assert.deepEqual(pages, []);
      return {
        ...record,
        cloudDocumentId: entry.cloudDocumentId,
        contentSha256: entry.contentSha256,
        fullMmdStoragePath: "user/hash/options/full.mmd",
        pagesStoragePath: "user/hash/options/pages.json",
        updatedAt: 210,
      };
    },
  });

  const result = await reconcile(entry);

  assert.equal(uploadCalls, 1);
  assert.equal(result.cloudSynced, true);
  assert.deepEqual(result.pages, []);
});

test("a completed cloud cache is restored into an empty local cache", async () => {
  const entry = createEntry();
  const pages = [createPage()];
  const cloudRecord = {
    ...createCompletedRecord(),
    cloudDocumentId: entry.cloudDocumentId,
    contentSha256: entry.contentSha256,
    fullMmdStoragePath: "user/hash/options/full.mmd",
    pagesStoragePath: "user/hash/options/pages.json",
    updatedAt: 300,
  };
  let restoredPages;
  let restoredRecord;
  let uploadCalls = 0;
  const reconcile = cacheReconciliation.createMathpixCacheReconciler({
    backfillCloudProcessingRecord: async () => undefined,
    downloadCompletedCloudCache: async () => ({
      pages,
      record: { ...cloudRecord, fullMmd: "# Restored" },
    }),
    getCloudRecord: async () => cloudRecord,
    getLocalRecord: async () => undefined,
    listLocalPages: async () => [],
    putLocalRecord: async (record) => {
      restoredRecord = record;
      return record;
    },
    replaceLocalPages: async (_fingerprint, nextPages) => {
      restoredPages = nextPages;
    },
    uploadCompletedCloudCache: async () => {
      uploadCalls += 1;
      return undefined;
    },
  });

  const result = await reconcile(entry);

  assert.equal(uploadCalls, 0);
  assert.equal(result.cloudSynced, true);
  assert.equal(result.source, "cloud");
  assert.deepEqual(restoredPages, pages);
  assert.equal(restoredRecord.fullMmd, "# Restored");
  assert.equal(restoredRecord.cloudMathpixSyncedAt, 300);
});

test("a failed cloud upload keeps local data and can be retried", async () => {
  const entry = createEntry();
  const pages = [createPage()];
  let localRecord = createCompletedRecord();
  let uploadCalls = 0;
  const reconcile = cacheReconciliation.createMathpixCacheReconciler({
    backfillCloudProcessingRecord: async () => undefined,
    downloadCompletedCloudCache: async () => undefined,
    getCloudRecord: async () => undefined,
    getLocalRecord: async () => localRecord,
    listLocalPages: async () => pages,
    putLocalRecord: async (record) => {
      localRecord = record;
      return record;
    },
    replaceLocalPages: async () => undefined,
    uploadCompletedCloudCache: async ({ record }) => {
      uploadCalls += 1;

      if (uploadCalls === 1) {
        throw new Error("temporary storage failure");
      }

      return {
        ...record,
        cloudDocumentId: entry.cloudDocumentId,
        contentSha256: entry.contentSha256,
        fullMmdStoragePath: "user/hash/options/full.mmd",
        pagesStoragePath: "user/hash/options/pages.json",
        updatedAt: 400,
      };
    },
  });

  await assert.rejects(reconcile(entry), /temporary storage failure/);
  assert.equal(localRecord.status, "completed");
  assert.deepEqual(pages, [createPage()]);

  const retried = await reconcile(entry);

  assert.equal(uploadCalls, 2);
  assert.equal(retried.cloudSynced, true);
  assert.equal(localRecord.pagesStoragePath, "user/hash/options/pages.json");
});

test("processing backfill waits for a MathPix id and then syncs the active job", async () => {
  const entry = createEntry();
  let localRecord = {
    ...createCompletedRecord(),
    completedAt: undefined,
    mathpixPdfId: undefined,
    status: "submitted",
  };
  let backfillCalls = 0;
  const reconcile = cacheReconciliation.createMathpixCacheReconciler({
    backfillCloudProcessingRecord: async () => {
      backfillCalls += 1;
      return undefined;
    },
    downloadCompletedCloudCache: async () => undefined,
    getCloudRecord: async () => undefined,
    getLocalRecord: async () => localRecord,
    listLocalPages: async () => [],
    putLocalRecord: async (record) => record,
    replaceLocalPages: async () => undefined,
    uploadCompletedCloudCache: async () => undefined,
  });

  assert.equal(await reconcile(entry), undefined);
  assert.equal(backfillCalls, 0);

  localRecord = {
    ...localRecord,
    mathpixPdfId: "mathpix-late-id",
    status: "processing",
    updatedAt: 200,
  };

  assert.equal(await reconcile(entry), undefined);
  assert.equal(backfillCalls, 1);
});

test("a completion that arrives during reconciliation queues a fresh cache pass", async () => {
  const entry = createEntry();
  const pages = [createPage()];
  let localRecord = {
    ...createCompletedRecord(),
    completedAt: undefined,
    status: "processing",
  };
  let localPages = [];
  let releaseFirstCloudRead;
  let cloudReadCalls = 0;
  let uploadCalls = 0;
  const firstCloudRead = new Promise((resolve) => {
    releaseFirstCloudRead = resolve;
  });
  const reconcile = cacheReconciliation.createMathpixCacheReconciler({
    backfillCloudProcessingRecord: async () => undefined,
    downloadCompletedCloudCache: async () => undefined,
    getCloudRecord: async () => {
      cloudReadCalls += 1;

      if (cloudReadCalls === 1) {
        await firstCloudRead;
      }

      return undefined;
    },
    getLocalRecord: async () => localRecord,
    listLocalPages: async () => localPages,
    putLocalRecord: async (record) => {
      localRecord = record;
      return record;
    },
    replaceLocalPages: async () => undefined,
    uploadCompletedCloudCache: async ({ record }) => {
      uploadCalls += 1;
      return {
        ...record,
        cloudDocumentId: entry.cloudDocumentId,
        contentSha256: entry.contentSha256,
        fullMmdStoragePath: "user/hash/options/full.mmd",
        pagesStoragePath: "user/hash/options/pages.json",
        updatedAt: 500,
      };
    },
  });

  const firstPass = reconcile(entry);
  await Promise.resolve();
  localRecord = createCompletedRecord();
  localPages = pages;
  const completionPass = reconcile(entry);
  releaseFirstCloudRead();

  assert.equal(await firstPass, undefined);
  const result = await completionPass;

  assert.equal(uploadCalls, 1);
  assert.equal(result.cloudSynced, true);
  assert.equal(result.record.pagesStoragePath, "user/hash/options/pages.json");
});

test("an aborted reconciliation can be drained before deleting the document", async () => {
  const entry = createEntry();
  const pages = [createPage()];
  let localRecord = createCompletedRecord();
  let releaseUpload;
  let markUploadStarted;
  const uploadStarted = new Promise((resolve) => {
    markUploadStarted = resolve;
  });
  const uploadGate = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const reconcile = cacheReconciliation.createMathpixCacheReconciler({
    backfillCloudProcessingRecord: async () => undefined,
    downloadCompletedCloudCache: async () => undefined,
    getCloudRecord: async () => undefined,
    getLocalRecord: async () => localRecord,
    listLocalPages: async () => pages,
    putLocalRecord: async (record) => {
      localRecord = record;
      return record;
    },
    replaceLocalPages: async () => undefined,
    uploadCompletedCloudCache: async ({ record }) => {
      markUploadStarted();
      await uploadGate;
      return {
        ...record,
        cloudDocumentId: entry.cloudDocumentId,
        contentSha256: entry.contentSha256,
        fullMmdStoragePath: "user/hash/options/full.mmd",
        pagesStoragePath: "user/hash/options/pages.json",
        updatedAt: 600,
      };
    },
  });
  const abortController = new AbortController();
  const request = reconcile(entry, { signal: abortController.signal });

  await uploadStarted;
  abortController.abort();
  const drained = reconcile.waitForIdle(entry);
  releaseUpload();

  await assert.rejects(request, (error) => error?.name === "AbortError");
  await drained;
  assert.equal(localRecord.pagesStoragePath, undefined);
});

function createEntry() {
  return {
    blob: new Blob(["pdf"], { type: "application/pdf" }),
    cloudDocumentId: "cloud-document-1",
    contentSha256: `sha256-${"a".repeat(64)}`,
    fileName: "paper.pdf",
    fileSize: 3,
    fingerprint: "pdf-1",
    importedAt: 1,
    lastOpenedAt: 1,
    mimeType: "application/pdf",
    openCount: 1,
  };
}

function createCompletedRecord() {
  return {
    completedAt: 100,
    fileName: "paper.pdf",
    fileSize: 3,
    fullMmd: "# Local",
    mathpixOptionsHash: options.MATHPIX_OPTIONS_HASH,
    mathpixPdfId: "mathpix-1",
    pdfFingerprint: "pdf-1",
    status: "completed",
    updatedAt: 100,
  };
}

function createPage() {
  return {
    lineCount: 1,
    lines: [{ lineIndex: 0, text: "Equation x" }],
    mathpixOptionsHash: options.MATHPIX_OPTIONS_HASH,
    pageIndex: 0,
    pageMmd: "Equation $x$",
    pageText: "Equation x",
    pdfFingerprint: "pdf-1",
    source: "mathpix-v3-pdf",
    updatedAt: 100,
  };
}
