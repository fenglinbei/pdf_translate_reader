import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type {
  ApiCallLog,
  PaperContextRecord,
  PdfLibraryEntry,
  TranslationCacheEntry,
  TranslationPin,
} from "../types/domain";
import type { StoredPinnedTranslationCard } from "../translation/floatingCardTypes";

const DB_NAME = "pdf-translate-reader";
const DB_VERSION = 6;

export interface PdfTranslateReaderDatabase extends DBSchema {
  pdfLibrary: {
    key: string;
    value: PdfLibraryEntry;
    indexes: {
      "by-last-opened": number;
      "by-deleted-at": number;
    };
  };
  translationCache: {
    key: string;
    value: TranslationCacheEntry;
    indexes: {
      "by-pdf": string;
      "by-updated-at": number;
    };
  };
  pins: {
    key: string;
    value: TranslationPin;
    indexes: {
      "by-pdf": string;
      "by-page": [string, number];
    };
  };
  apiLogs: {
    key: string;
    value: ApiCallLog;
    indexes: {
      "by-pdf": string;
      "by-started-at": number;
      "by-status": ApiCallLog["status"];
    };
  };
  paperContexts: {
    key: string;
    value: PaperContextRecord;
    indexes: {
      "by-updated-at": number;
    };
  };
  pinnedTranslationCards: {
    key: string;
    value: StoredPinnedTranslationCard;
    indexes: {
      "by-pdf": string;
      "by-updated-at": number;
    };
  };
  settings: {
    key: string;
    value: unknown;
  };
}

let dbPromise: Promise<IDBPDatabase<PdfTranslateReaderDatabase>> | undefined;

export function getAppDb() {
  dbPromise ??= openDB<PdfTranslateReaderDatabase>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("pdfLibrary")) {
        const store = db.createObjectStore("pdfLibrary", { keyPath: "fingerprint" });
        store.createIndex("by-last-opened", "lastOpenedAt");
        store.createIndex("by-deleted-at", "deletedAt");
      }

      if (!db.objectStoreNames.contains("translationCache")) {
        const store = db.createObjectStore("translationCache", { keyPath: "cacheKey" });
        store.createIndex("by-pdf", "pdfFingerprint");
        store.createIndex("by-updated-at", "updatedAt");
      }

      if (!db.objectStoreNames.contains("pins")) {
        const store = db.createObjectStore("pins", { keyPath: "id" });
        store.createIndex("by-pdf", "pdfFingerprint");
        store.createIndex("by-page", ["pdfFingerprint", "pageIndex"]);
      }

      if (!db.objectStoreNames.contains("apiLogs")) {
        const store = db.createObjectStore("apiLogs", { keyPath: "id" });
        store.createIndex("by-pdf", "pdfFingerprint");
        store.createIndex("by-started-at", "requestStartedAt");
        store.createIndex("by-status", "status");
      }

      if (!db.objectStoreNames.contains("paperContexts")) {
        const store = db.createObjectStore("paperContexts", { keyPath: "pdfFingerprint" });
        store.createIndex("by-updated-at", "updatedAt");
      }

      if (!db.objectStoreNames.contains("pinnedTranslationCards")) {
        const store = db.createObjectStore("pinnedTranslationCards", { keyPath: "key" });
        store.createIndex("by-pdf", "pdfFingerprint");
        store.createIndex("by-updated-at", "updatedAt");
      }

      if (!db.objectStoreNames.contains("settings")) {
        db.createObjectStore("settings");
      }
    },
  });

  return dbPromise;
}

export async function resetAppDb() {
  const db = await getAppDb();
  const stores = [
    "pdfLibrary",
    "translationCache",
    "pins",
    "apiLogs",
    "paperContexts",
    "pinnedTranslationCards",
    "settings",
  ] as const;
  const transaction = db.transaction(stores, "readwrite");

  await Promise.all(stores.map((store) => transaction.objectStore(store).clear()));
  await transaction.done;
}
