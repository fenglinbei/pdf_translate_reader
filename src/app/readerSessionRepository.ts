import type { ReaderMode, SelectionMode } from "../types/domain";

const READER_SESSION_STORAGE_KEY = "pdf-translate-reader-session-v1";

export type ReaderSession = {
  activeCloudDocumentId?: string;
  activeFingerprint?: string;
  isLibraryPaneOpen?: boolean;
  isPinsPaneOpen?: boolean;
  libraryPaneWidth?: number;
  pinsPaneWidth?: number;
  readerMode?: ReaderMode;
  selectionMode?: SelectionMode;
  updatedAt: number;
  userId: string;
};

export type ReaderSessionPatch = Partial<Omit<ReaderSession, "updatedAt" | "userId">>;

export function getReaderSession(userId: string) {
  const storage = getBrowserLocalStorage();

  if (!storage) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(storage.getItem(READER_SESSION_STORAGE_KEY) ?? "null");
    const session = normalizeReaderSession(parsed);

    return session?.userId === userId ? session : undefined;
  } catch {
    return undefined;
  }
}

export function updateReaderSession(userId: string, patch: ReaderSessionPatch) {
  const storage = getBrowserLocalStorage();

  if (!storage) {
    return undefined;
  }

  const nextSession = normalizeReaderSession({
    ...getReaderSession(userId),
    ...patch,
    updatedAt: Date.now(),
    userId,
  });

  if (!nextSession) {
    return undefined;
  }

  try {
    storage.setItem(READER_SESSION_STORAGE_KEY, JSON.stringify(nextSession));
  } catch {
    return undefined;
  }

  return nextSession;
}

export function clearReaderSessionDocument(
  userId: string,
  target: {
    cloudDocumentId?: string;
    fingerprint?: string;
  } = {},
) {
  const currentSession = getReaderSession(userId);

  if (!currentSession) {
    return;
  }

  const matchesCloudDocument =
    Boolean(target.cloudDocumentId) &&
    currentSession.activeCloudDocumentId === target.cloudDocumentId;
  const matchesFingerprint =
    Boolean(target.fingerprint) &&
    currentSession.activeFingerprint === target.fingerprint;

  if (target.cloudDocumentId || target.fingerprint) {
    if (!matchesCloudDocument && !matchesFingerprint) {
      return;
    }
  }

  updateReaderSession(userId, {
    activeCloudDocumentId: undefined,
    activeFingerprint: undefined,
  });
}

function getBrowserLocalStorage() {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function normalizeReaderSession(input: unknown): ReaderSession | undefined {
  if (!isRecord(input) || typeof input.userId !== "string" || !input.userId) {
    return undefined;
  }

  return {
    activeCloudDocumentId: getOptionalString(input.activeCloudDocumentId),
    activeFingerprint: getOptionalString(input.activeFingerprint),
    isLibraryPaneOpen: getOptionalBoolean(input.isLibraryPaneOpen),
    isPinsPaneOpen: getOptionalBoolean(input.isPinsPaneOpen),
    libraryPaneWidth: getOptionalNumber(input.libraryPaneWidth),
    pinsPaneWidth: getOptionalNumber(input.pinsPaneWidth),
    readerMode:
      input.readerMode === "select"
        ? "select"
        : input.readerMode === "translate"
          ? "translate"
          : undefined,
    selectionMode:
      input.selectionMode === "cross"
        ? "cross"
        : input.selectionMode === "continuous"
          ? "continuous"
          : undefined,
    updatedAt: getOptionalNumber(input.updatedAt) ?? Date.now(),
    userId: input.userId,
  };
}

function getOptionalString(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}

function getOptionalBoolean(value: unknown) {
  return typeof value === "boolean" ? value : undefined;
}

function getOptionalNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}
