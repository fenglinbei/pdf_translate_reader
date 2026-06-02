import { getAppDb } from "../cache";
import type {
  SentenceSelection,
  TranslationModel,
  TranslationPin,
} from "../types/domain";

export type PinWriteInput = {
  cacheKey?: string;
  contextWindowN: number;
  longContextEnabled: boolean;
  model: TranslationModel;
  pageHeight?: number;
  pageWidth?: number;
  promptVersion: string;
  selection: SentenceSelection;
  sourceLang: "en";
  targetLang: "zh";
  translation: string;
};

export type PinTranslationUpdateInput = {
  cacheKey?: string;
  model: TranslationModel;
  translation: string;
};

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
  const pin: TranslationPin = {
    cacheKey: input.cacheKey,
    contextWindowN: input.contextWindowN,
    createdAt: existing?.createdAt ?? now,
    id,
    localContextAfter: input.selection.localContextAfter,
    localContextBefore: input.selection.localContextBefore,
    longContextEnabled: input.longContextEnabled,
    model: input.model,
    normalizedSentence: input.selection.normalizedSentence,
    pageHeight: input.pageHeight,
    pageIndex: input.selection.pageIndex,
    pageWidth: input.pageWidth,
    pdfFingerprint: input.selection.pdfFingerprint,
    promptVersion: input.promptVersion,
    rectsOnPage: input.selection.rectsOnPage,
    selectedText: input.selection.selectedText,
    sourceLang: input.sourceLang,
    targetLang: input.targetLang,
    targetSentence: input.selection.targetSentence,
    translation: input.translation,
    updatedAt: now,
  };

  await db.put("pins", pin);
  await Promise.all(
    existingPins
      .filter((existingPin) => existingPin.id !== id)
      .map((existingPin) => db.delete("pins", existingPin.id)),
  );

  return pin;
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
        updatedAt: updatedPin.updatedAt,
      }),
    ),
  );

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
}

export async function deletePinsByPdf(pdfFingerprint: string) {
  const db = await getAppDb();
  const pins = await db.getAllFromIndex("pins", "by-pdf", pdfFingerprint);

  await Promise.all(pins.map((pin) => db.delete("pins", pin.id)));
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
