import { getAppDb } from "../cache";
import {
  deleteCloudPin,
  deleteCloudPinsByDocument,
  syncPinToCloud,
} from "../cloud/documentStateRepository";
import { runCloudSync } from "../cloud/syncStatus";
import type {
  AnnotationColor,
  SentenceSelection,
  SourceLanguage,
  TargetLanguage,
  TranslationModel,
  TranslationPin,
} from "../types/domain";

export type PinAnnotationInput = {
  color: AnnotationColor;
  note?: string;
};

export type PinWriteInput = {
  annotation?: PinAnnotationInput;
  cacheKey?: string;
  cloudDocumentId?: string;
  contextWindowN: number;
  longContextEnabled: boolean;
  model: TranslationModel;
  pageHeight?: number;
  pageWidth?: number;
  promptVersion: string;
  selection: SentenceSelection;
  sourceLang: SourceLanguage;
  targetLang: TargetLanguage;
  translation: string;
  translationVisible?: boolean;
};

export type PinTranslationUpdateInput = {
  cacheKey?: string;
  model: TranslationModel;
  translation: string;
  translationVisible?: boolean;
};

export type PinAnnotationUpdateInput = PinAnnotationInput;

export async function listPinsByPdf(pdfFingerprint: string) {
  const db = await getAppDb();
  const pins = await db.getAllFromIndex("pins", "by-pdf", pdfFingerprint);

  return collapseDuplicatePins(pins).sort(comparePins);
}

export async function putPin(input: PinWriteInput) {
  const db = await getAppDb();
  const id = createTranslationPinId({
    normalizedSentence: input.selection.normalizedSentence,
    pageIndex: input.selection.pageIndex,
    pdfFingerprint: input.selection.pdfFingerprint,
  });
  const existingPins = (await db.getAllFromIndex("pins", "by-pdf", input.selection.pdfFingerprint))
    .filter((pin) => isSamePinTarget(pin, {
      normalizedSentence: input.selection.normalizedSentence,
      pageIndex: input.selection.pageIndex,
      pdfFingerprint: input.selection.pdfFingerprint,
    }));
  const existing = existingPins.find((pin) => pin.id === id) ?? existingPins[0];
  const now = Date.now();
  const nextNote =
    input.annotation ? normalizeOptionalText(input.annotation.note) : existing?.note;
  const hasTranslationInput = input.translation.trim().length > 0;
  const pin: TranslationPin = {
    anchorRegionIndex: input.selection.anchorRegionIndex,
    cacheKey: hasTranslationInput ? input.cacheKey : existing?.cacheKey ?? input.cacheKey,
    cloudDocumentId:
      input.cloudDocumentId ??
      input.selection.cloudDocumentId ??
      existing?.cloudDocumentId,
    color: input.annotation?.color ?? existing?.color,
    contextWindowN: input.contextWindowN,
    createdAt: existing?.createdAt ?? now,
    highlighted: existing?.highlighted,
    id,
    localContextAfter: input.selection.localContextAfter,
    localContextBefore: input.selection.localContextBefore,
    longContextEnabled: input.longContextEnabled,
    model: hasTranslationInput ? input.model : existing?.model ?? input.model,
    note: nextNote,
    normalizedSentence: input.selection.normalizedSentence,
    pageHeight: input.pageHeight,
    pageIndex: input.selection.pageIndex,
    pageWidth: input.pageWidth,
    pdfFingerprint: input.selection.pdfFingerprint,
    promptVersion: input.promptVersion,
    rectsOnPage: input.selection.rectsOnPage,
    regions: input.selection.regions,
    selectedText: input.selection.selectedText,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    targetSentence: input.selection.targetSentence,
    textSource: input.selection.textSource,
    mathpixOptionsHash: input.selection.mathpixOptionsHash,
    mathpixConfidence: input.selection.mathpixConfidence,
    translation: hasTranslationInput ? input.translation : existing?.translation ?? input.translation,
    translationVisible:
      input.translationVisible ??
      (hasTranslationInput ? true : existing?.translationVisible ?? false),
    updatedAt: now,
  };

  await db.put("pins", pin);
  await Promise.all(
    existingPins
      .filter((existingPin) => existingPin.id !== id)
      .map((existingPin) => db.delete("pins", existingPin.id)),
  );
  await runCloudSync(
    () => Promise.all([
      syncPinToCloud(pin),
      ...existingPins
        .filter((existingPin) => existingPin.id !== id)
        .map((existingPin) => deleteCloudPin(existingPin.cloudDocumentId, existingPin.id)),
    ]),
    {
      error: "Saved annotation locally, but cloud sync failed.",
      started: "Syncing annotation.",
      success: "Annotation synced.",
    },
  ).catch(() => undefined);

  return pin;
}

export async function updatePinAnnotation(pinId: string, input: PinAnnotationUpdateInput) {
  const db = await getAppDb();
  const existing = await db.get("pins", pinId);

  if (!existing) {
    return undefined;
  }

  const duplicatePins = (await db.getAllFromIndex("pins", "by-pdf", existing.pdfFingerprint))
    .filter((pin) => isSamePinTarget(pin, existing));
  const now = Date.now();
  const note = normalizeOptionalText(input.note);
  const updatedPin: TranslationPin = {
    ...existing,
    color: input.color,
    note,
    updatedAt: now,
  };

  await Promise.all(
    duplicatePins.map((pin) =>
      db.put("pins", {
        ...pin,
        color: input.color,
        note,
        updatedAt: now,
      }),
    ),
  );
  await runCloudSync(() => syncPinToCloud(updatedPin), {
    error: "Saved annotation locally, but cloud sync failed.",
    started: "Syncing annotation.",
    success: "Annotation synced.",
  }).catch(() => undefined);

  return updatedPin;
}

export async function updatePinTranslation(pinId: string, input: PinTranslationUpdateInput) {
  const db = await getAppDb();
  const existing = await db.get("pins", pinId);

  if (!existing) {
    return undefined;
  }

  const updatedPin: TranslationPin = {
    ...existing,
    cacheKey: input.cacheKey,
    model: input.model,
    translation: input.translation,
    translationVisible: input.translationVisible ?? true,
    updatedAt: Date.now(),
  };

  const duplicatePins = (await db.getAllFromIndex("pins", "by-pdf", existing.pdfFingerprint))
    .filter((pin) => isSamePinTarget(pin, existing));

  await Promise.all(
    duplicatePins.map((pin) =>
      db.put("pins", {
        ...pin,
        cacheKey: input.cacheKey,
        model: input.model,
        translation: input.translation,
        translationVisible: input.translationVisible ?? true,
        updatedAt: updatedPin.updatedAt,
      }),
    ),
  );
  await runCloudSync(() => syncPinToCloud(updatedPin), {
    error: "Saved annotation locally, but cloud sync failed.",
    started: "Syncing annotation.",
    success: "Annotation synced.",
  }).catch(() => undefined);

  return updatedPin;
}

export async function updatePinTranslationVisibility(pinId: string, translationVisible: boolean) {
  const db = await getAppDb();
  const existing = await db.get("pins", pinId);

  if (!existing) {
    return undefined;
  }

  const duplicatePins = (await db.getAllFromIndex("pins", "by-pdf", existing.pdfFingerprint))
    .filter((pin) => isSamePinTarget(pin, existing));
  const now = Date.now();
  const updatedPin: TranslationPin = {
    ...existing,
    translationVisible,
    updatedAt: now,
  };

  await Promise.all(
    duplicatePins.map((pin) =>
      db.put("pins", {
        ...pin,
        translationVisible,
        updatedAt: now,
      }),
    ),
  );
  await runCloudSync(() => syncPinToCloud(updatedPin), {
    error: "Saved annotation locally, but cloud sync failed.",
    started: "Syncing annotation.",
    success: "Annotation synced.",
  }).catch(() => undefined);

  return updatedPin;
}

export async function updatePinHighlight(pinId: string, highlighted: boolean) {
  const db = await getAppDb();
  const existing = await db.get("pins", pinId);

  if (!existing) {
    return undefined;
  }

  const duplicatePins = (await db.getAllFromIndex("pins", "by-pdf", existing.pdfFingerprint))
    .filter((pin) => isSamePinTarget(pin, existing));
  const now = Date.now();
  const updatedPin: TranslationPin = {
    ...existing,
    highlighted,
    updatedAt: now,
  };

  await Promise.all(
    duplicatePins.map((pin) =>
      db.put("pins", {
        ...pin,
        highlighted,
        updatedAt: now,
      }),
    ),
  );
  await runCloudSync(() => syncPinToCloud(updatedPin), {
    error: "Saved annotation locally, but cloud sync failed.",
    started: "Syncing annotation.",
    success: "Annotation synced.",
  }).catch(() => undefined);

  return updatedPin;
}

export async function deletePin(pinId: string) {
  const db = await getAppDb();
  const existing = await db.get("pins", pinId);

  if (!existing) {
    await db.delete("pins", pinId);
    return;
  }

  const duplicatePins = (await db.getAllFromIndex("pins", "by-pdf", existing.pdfFingerprint))
    .filter((pin) => isSamePinTarget(pin, existing));

  await Promise.all(duplicatePins.map((pin) => db.delete("pins", pin.id)));
  await runCloudSync(
    () => Promise.all(
      duplicatePins.map((pin) => deleteCloudPin(pin.cloudDocumentId, pin.id)),
    ),
    {
      error: "Removed annotation locally, but cloud sync failed.",
      started: "Syncing annotation removal.",
      success: "Annotation removal synced.",
    },
  ).catch(() => undefined);
}

export async function deletePinsByPdf(pdfFingerprint: string) {
  const db = await getAppDb();
  const pins = await db.getAllFromIndex("pins", "by-pdf", pdfFingerprint);
  const cloudDocumentIds = Array.from(
    new Set(pins.map((pin) => pin.cloudDocumentId).filter(Boolean)),
  );

  await Promise.all(pins.map((pin) => db.delete("pins", pin.id)));
  await runCloudSync(
    () => Promise.all(
      cloudDocumentIds.map((cloudDocumentId) => deleteCloudPinsByDocument(cloudDocumentId)),
    ),
    {
      error: "Cleared annotations locally, but cloud sync failed.",
      started: "Syncing annotation clear.",
      success: "Annotation clear synced.",
    },
  ).catch(() => undefined);
}

export function createTranslationPinId(input: {
  cacheKey?: string;
  model?: TranslationModel;
  normalizedSentence: string;
  pageIndex: number;
  pdfFingerprint: string;
}) {
  const stablePayload = JSON.stringify({
    normalizedSentence: input.normalizedSentence,
    pageIndex: input.pageIndex,
    pdfFingerprint: input.pdfFingerprint,
  });

  return `pin-${hashString(stablePayload)}`;
}

function collapseDuplicatePins(pins: TranslationPin[]) {
  const pinsByTarget = new Map<string, TranslationPin>();

  for (const pin of pins) {
    const targetKey = createPinTargetKey(pin);
    const currentPin = pinsByTarget.get(targetKey);

    if (!currentPin || pin.updatedAt >= currentPin.updatedAt) {
      pinsByTarget.set(targetKey, pin);
    }
  }

  return Array.from(pinsByTarget.values());
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

function isSamePinTarget(
  left: {
    normalizedSentence: string;
    pageIndex: number;
    pdfFingerprint: string;
  },
  right: {
    normalizedSentence: string;
    pageIndex: number;
    pdfFingerprint: string;
  },
) {
  return createPinTargetKey(left) === createPinTargetKey(right);
}

function comparePins(left: TranslationPin, right: TranslationPin) {
  if (left.pageIndex !== right.pageIndex) {
    return left.pageIndex - right.pageIndex;
  }

  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }

  return left.id.localeCompare(right.id);
}

function hashString(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function normalizeOptionalText(value: string | undefined) {
  const text = value?.trim();

  return text && text.length > 0 ? text : undefined;
}
