import { getAppDb } from "../cache";
import {
  deleteCloudDocumentState,
  syncPaperContextToCloud,
  syncPinToCloud,
  syncPinnedTranslationCardToCloud,
  syncTranslationCacheToCloud,
} from "../cloud/documentStateRepository";
import { runCloudSync } from "../cloud/syncStatus";
import { createTranslationPinId } from "../pins/pinRepository";
import { createTranslationCacheKey } from "../translation/cacheKey";
import type { StoredPinnedTranslationCard } from "../translation/floatingCardTypes";
import type {
  PaperContextRecord,
  PdfLibraryEntry,
  SentenceSelection,
  TranslationCacheEntry,
  TranslationPin,
} from "../types/domain";
import {
  DOCUMENT_ARCHIVE_FORMAT,
  DOCUMENT_ARCHIVE_MANIFEST_NAME,
  DOCUMENT_ARCHIVE_PDF_NAME,
  DOCUMENT_ARCHIVE_VERSION,
  type DocumentArchiveManifestV1,
  type DocumentArchiveState,
  type ParsedDocumentArchive,
} from "./archiveTypes";
import { createStoredZip, decodeUtf8, readStoredZip } from "./zipArchive";

export type DocumentArchiveImportMode = "merge" | "replace";

type ImportDocumentArchiveStateInput = {
  entry: PdfLibraryEntry;
  mode?: DocumentArchiveImportMode;
  state: DocumentArchiveState;
};

export async function createDocumentArchive(entry: PdfLibraryEntry) {
  const state = stripCloudFieldsFromState(await readLocalDocumentArchiveState(entry.fingerprint));
  const manifest: DocumentArchiveManifestV1 = {
    document: {
      contentSha256: entry.contentSha256,
      fileName: entry.fileName,
      fileSize: entry.fileSize,
      fingerprint: entry.fingerprint,
      lastPageIndex: entry.lastPageIndex,
      lastScrollTop: entry.lastScrollTop,
      lastZoom: entry.lastZoom,
      mimeType: entry.mimeType,
      pdfMetadata: entry.pdfMetadata,
    },
    exportedAt: new Date().toISOString(),
    format: DOCUMENT_ARCHIVE_FORMAT,
    formatVersion: DOCUMENT_ARCHIVE_VERSION,
    state,
  };

  return createStoredZip([
    {
      data: JSON.stringify(manifest, null, 2),
      name: DOCUMENT_ARCHIVE_MANIFEST_NAME,
    },
    {
      data: entry.blob,
      name: DOCUMENT_ARCHIVE_PDF_NAME,
    },
  ]);
}

function stripCloudFieldsFromState(state: DocumentArchiveState): DocumentArchiveState {
  return {
    paperContext: state.paperContext
      ? {
          ...state.paperContext,
          cloudDocumentId: undefined,
        }
      : undefined,
    pinnedTranslationCards: state.pinnedTranslationCards.map((card) => ({
      ...card,
      cloudDocumentId: undefined,
      selection: stripCloudFieldsFromSelection(card.selection),
    })),
    pins: state.pins.map((pin) => ({
      ...pin,
      cloudDocumentId: undefined,
    })),
    translationCache: state.translationCache.map((cacheEntry) => ({
      ...cacheEntry,
      cloudDocumentId: undefined,
    })),
  };
}

function stripCloudFieldsFromSelection(selection: SentenceSelection): SentenceSelection {
  return {
    ...selection,
    cloudDocumentId: undefined,
  };
}

export async function parseDocumentArchive(file: File): Promise<ParsedDocumentArchive> {
  const entries = await readStoredZip(file);
  const manifestBytes = entries.get(DOCUMENT_ARCHIVE_MANIFEST_NAME);
  const pdfBytes = entries.get(DOCUMENT_ARCHIVE_PDF_NAME);

  if (!manifestBytes || !pdfBytes) {
    throw new Error("This reading package is missing its manifest or PDF.");
  }

  const manifest = normalizeManifest(JSON.parse(decodeUtf8(manifestBytes)));
  const pdfFile = new File([pdfBytes], manifest.document.fileName || "document.pdf", {
    lastModified: Number.isFinite(Date.parse(manifest.exportedAt))
      ? Date.parse(manifest.exportedAt)
      : Date.now(),
    type: "application/pdf",
  });

  if (manifest.document.fileSize > 0 && manifest.document.fileSize !== pdfFile.size) {
    throw new Error("The reading package PDF does not match its manifest.");
  }

  return { manifest, pdfFile };
}

export function isDocumentArchiveFile(file: File) {
  const name = file.name.toLocaleLowerCase();

  return (
    name.endsWith(".ptrx") ||
    name.endsWith(".pdftr.zip") ||
    (name.endsWith(".zip") && file.type === "application/zip")
  );
}

export async function readLocalDocumentArchiveState(pdfFingerprint: string) {
  const db = await getAppDb();
  const [
    pins,
    pinnedTranslationCards,
    translationCache,
    paperContext,
  ] = await Promise.all([
    db.getAllFromIndex("pins", "by-pdf", pdfFingerprint),
    db.getAllFromIndex("pinnedTranslationCards", "by-pdf", pdfFingerprint),
    db.getAllFromIndex("translationCache", "by-pdf", pdfFingerprint),
    db.get("paperContexts", pdfFingerprint),
  ]);

  return {
    paperContext,
    pinnedTranslationCards,
    pins,
    translationCache,
  };
}

export async function importDocumentArchiveState({
  entry,
  mode = "merge",
  state,
}: ImportDocumentArchiveStateInput) {
  const normalizedState = normalizeStateForEntry(state, entry);
  const nextState = mode === "replace"
    ? normalizedState
    : mergeDocumentStates(await readLocalDocumentArchiveState(entry.fingerprint), normalizedState);

  await writeLocalDocumentArchiveState(entry.fingerprint, nextState, mode);
  await syncImportedStateToCloud(entry.cloudDocumentId, nextState, mode);

  return nextState;
}

function normalizeManifest(value: unknown): DocumentArchiveManifestV1 {
  if (!isRecord(value)) {
    throw new Error("This reading package has an invalid manifest.");
  }

  if (value.format !== DOCUMENT_ARCHIVE_FORMAT || value.formatVersion !== DOCUMENT_ARCHIVE_VERSION) {
    throw new Error("This reading package format is not supported.");
  }

  if (!isRecord(value.document) || !isRecord(value.state)) {
    throw new Error("This reading package has an invalid manifest.");
  }

  const document = value.document;
  const state = value.state;
  const fileName = cleanFileName(document.fileName);

  if (!fileName) {
    throw new Error("This reading package does not name its PDF.");
  }

  return {
    document: {
      contentSha256: cleanOptionalText(document.contentSha256),
      fileName,
      fileSize: cleanNumber(document.fileSize, 0),
      fingerprint: cleanOptionalText(document.fingerprint) ?? "",
      lastPageIndex: cleanOptionalNumber(document.lastPageIndex),
      lastScrollTop: cleanOptionalNumber(document.lastScrollTop),
      lastZoom: cleanOptionalNumber(document.lastZoom),
      mimeType: "application/pdf",
      pdfMetadata: isRecord(document.pdfMetadata) ? {
        author: cleanOptionalText(document.pdfMetadata.author),
        title: cleanOptionalText(document.pdfMetadata.title),
      } : undefined,
    },
    exportedAt: cleanOptionalText(value.exportedAt) ?? new Date().toISOString(),
    format: DOCUMENT_ARCHIVE_FORMAT,
    formatVersion: DOCUMENT_ARCHIVE_VERSION,
    state: {
      paperContext: isRecord(state.paperContext)
        ? state.paperContext as PaperContextRecord
        : undefined,
      pinnedTranslationCards: Array.isArray(state.pinnedTranslationCards)
        ? state.pinnedTranslationCards as StoredPinnedTranslationCard[]
        : [],
      pins: Array.isArray(state.pins) ? state.pins as TranslationPin[] : [],
      translationCache: Array.isArray(state.translationCache)
        ? state.translationCache as TranslationCacheEntry[]
        : [],
    },
  };
}

function normalizeStateForEntry(
  state: DocumentArchiveState,
  entry: PdfLibraryEntry,
): DocumentArchiveState {
  const cacheKeyMap = new Map<string, string>();
  const translationCache = dedupeByKey(
    state.translationCache.map((cacheEntry) => {
      const nextCacheKey = createTranslationCacheKey({
        contextWindowN: cacheEntry.contextWindowN,
        longContextEnabled: cacheEntry.longContextEnabled,
        model: cacheEntry.model,
        normalizedSentence: cacheEntry.normalizedSentence,
        paperContextHash: cacheEntry.paperContextHash,
        pdfFingerprint: entry.fingerprint,
        promptVersion: cacheEntry.promptVersion,
        sourceLang: cacheEntry.sourceLang,
        targetLang: cacheEntry.targetLang,
      });

      cacheKeyMap.set(cacheEntry.cacheKey, nextCacheKey);

      return {
        ...cacheEntry,
        cacheKey: nextCacheKey,
        cloudDocumentId: entry.cloudDocumentId,
        createdAt: cleanNumber(cacheEntry.createdAt, Date.now()),
        pdfFingerprint: entry.fingerprint,
        updatedAt: cleanNumber(cacheEntry.updatedAt, Date.now()),
      };
    }),
    (cacheEntry) => cacheEntry.cacheKey,
    (cacheEntry) => cacheEntry.updatedAt,
  );
  const pins = dedupeByKey(
    state.pins.map((pin) => {
      const id = createTranslationPinId({
        normalizedSentence: pin.normalizedSentence,
        pageIndex: pin.pageIndex,
        pdfFingerprint: entry.fingerprint,
      });

      return {
        ...pin,
        cacheKey: pin.cacheKey ? cacheKeyMap.get(pin.cacheKey) ?? pin.cacheKey : undefined,
        cloudDocumentId: entry.cloudDocumentId,
        createdAt: cleanNumber(pin.createdAt, Date.now()),
        id,
        pdfFingerprint: entry.fingerprint,
        regions: pin.regions,
        updatedAt: cleanNumber(pin.updatedAt, Date.now()),
      };
    }),
    (pin) => pin.id,
    (pin) => pin.updatedAt,
  );
  const pinnedTranslationCards = dedupeByKey(
    state.pinnedTranslationCards.map((card) => {
      const selection = normalizeSelectionForEntry(card.selection, entry);
      const key = createPinTargetKey(selection);

      return {
        ...card,
        cloudDocumentId: entry.cloudDocumentId,
        createdAt: cleanNumber(card.createdAt, Date.now()),
        key,
        pdfFingerprint: entry.fingerprint,
        selection,
        updatedAt: cleanNumber(card.updatedAt, Date.now()),
      };
    }),
    (card) => card.key,
    (card) => card.updatedAt,
  );

  return {
    paperContext: state.paperContext
      ? {
          ...state.paperContext,
          cloudDocumentId: entry.cloudDocumentId,
          pdfFingerprint: entry.fingerprint,
          updatedAt: cleanNumber(state.paperContext.updatedAt, Date.now()),
        }
      : undefined,
    pinnedTranslationCards,
    pins,
    translationCache,
  };
}

function normalizeSelectionForEntry(
  selection: SentenceSelection,
  entry: PdfLibraryEntry,
): SentenceSelection {
  return {
    ...selection,
    cloudDocumentId: entry.cloudDocumentId,
    pdfFingerprint: entry.fingerprint,
  };
}

async function writeLocalDocumentArchiveState(
  pdfFingerprint: string,
  state: DocumentArchiveState,
  mode: DocumentArchiveImportMode,
) {
  const db = await getAppDb();
  const transaction = db.transaction([
    "pins",
    "translationCache",
    "paperContexts",
    "pinnedTranslationCards",
  ], "readwrite");
  const pinsStore = transaction.objectStore("pins");
  const translationCacheStore = transaction.objectStore("translationCache");
  const paperContextsStore = transaction.objectStore("paperContexts");
  const pinnedCardsStore = transaction.objectStore("pinnedTranslationCards");

  if (mode === "replace") {
    const [
      pinKeys,
      translationCacheKeys,
      pinnedCardKeys,
    ] = await Promise.all([
      pinsStore.index("by-pdf").getAllKeys(pdfFingerprint),
      translationCacheStore.index("by-pdf").getAllKeys(pdfFingerprint),
      pinnedCardsStore.index("by-pdf").getAllKeys(pdfFingerprint),
    ]);

    await Promise.all([
      ...pinKeys.map((key) => pinsStore.delete(key)),
      ...translationCacheKeys.map((key) => translationCacheStore.delete(key)),
      paperContextsStore.delete(pdfFingerprint),
      ...pinnedCardKeys.map((key) => pinnedCardsStore.delete(key)),
    ]);
  }

  await Promise.all([
    ...state.pins.map((pin) => pinsStore.put(pin)),
    ...state.translationCache.map((cacheEntry) => translationCacheStore.put(cacheEntry)),
    state.paperContext ? paperContextsStore.put(state.paperContext) : undefined,
    ...state.pinnedTranslationCards.map((card) => pinnedCardsStore.put(card)),
  ].filter(Boolean));

  await transaction.done;
}

async function syncImportedStateToCloud(
  cloudDocumentId: string | undefined,
  state: DocumentArchiveState,
  mode: DocumentArchiveImportMode,
) {
  if (!cloudDocumentId) {
    return;
  }

  await runCloudSync(async () => {
    if (mode === "replace") {
      await deleteCloudDocumentState(cloudDocumentId);
    }

    await Promise.all([
      ...state.pins.map((pin) => syncPinToCloud(pin)),
      ...state.translationCache.map((cacheEntry) => syncTranslationCacheToCloud(cacheEntry)),
      state.paperContext ? syncPaperContextToCloud(state.paperContext) : undefined,
      ...state.pinnedTranslationCards.map((card) => syncPinnedTranslationCardToCloud(card)),
    ].filter(Boolean));
  }, {
    error: "Imported reading package locally, but cloud state sync failed.",
    started: "Syncing imported reading package.",
    success: "Reading package synced.",
  }).catch(() => undefined);
}

function mergeDocumentStates(
  currentState: DocumentArchiveState,
  importedState: DocumentArchiveState,
): DocumentArchiveState {
  return {
    paperContext: pickLatestOptionalRecord(currentState.paperContext, importedState.paperContext),
    pinnedTranslationCards: mergeByKey(
      currentState.pinnedTranslationCards,
      importedState.pinnedTranslationCards,
      (card) => card.key,
      (card) => card.updatedAt,
    ),
    pins: mergeByKey(
      currentState.pins,
      importedState.pins,
      (pin) => pin.id,
      (pin) => pin.updatedAt,
    ),
    translationCache: mergeByKey(
      currentState.translationCache,
      importedState.translationCache,
      (cacheEntry) => cacheEntry.cacheKey,
      (cacheEntry) => cacheEntry.updatedAt,
    ),
  };
}

function mergeByKey<T>(
  currentItems: T[],
  importedItems: T[],
  getKey: (item: T) => string,
  getUpdatedAt: (item: T) => number,
) {
  return dedupeByKey([...currentItems, ...importedItems], getKey, getUpdatedAt);
}

function dedupeByKey<T>(
  items: T[],
  getKey: (item: T) => string,
  getUpdatedAt: (item: T) => number,
) {
  const itemsByKey = new Map<string, T>();

  for (const item of items) {
    const key = getKey(item);
    const currentItem = itemsByKey.get(key);

    if (!currentItem || getUpdatedAt(item) >= getUpdatedAt(currentItem)) {
      itemsByKey.set(key, item);
    }
  }

  return Array.from(itemsByKey.values());
}

function pickLatestOptionalRecord<T extends { updatedAt: number }>(
  currentRecord: T | undefined,
  importedRecord: T | undefined,
) {
  if (!currentRecord) {
    return importedRecord;
  }

  if (!importedRecord) {
    return currentRecord;
  }

  return importedRecord.updatedAt >= currentRecord.updatedAt ? importedRecord : currentRecord;
}

function createPinTargetKey(input: {
  normalizedSentence: string;
  pageIndex: number;
  pdfFingerprint: string;
}) {
  return JSON.stringify({
    normalizedSentence: input.normalizedSentence,
    pageIndex: input.pageIndex,
    pdfFingerprint: input.pdfFingerprint,
  });
}

function cleanFileName(value: unknown) {
  return typeof value === "string"
    ? value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim()
    : undefined;
}

function cleanOptionalText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cleanOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
