import { getAppDb } from "../cache";
import {
  deleteCloudPaperContext,
  syncPaperContextToCloud,
} from "../cloud/documentStateRepository";
import { runCloudSync } from "../cloud/syncStatus";
import { PROJECT_CONFIG } from "../config/projectConfig";
import type {
  PaperContext,
  PaperContextRecord,
  PaperContextTerm,
  PdfLibraryEntry,
  TranslationStyleSettings,
} from "../types/domain";
import {
  cleanExtractedText,
  cleanOptionalExtractedText,
  extractAbstractText,
  extractTitleText,
} from "../selection/textProcessing";
import {
  DEFAULT_TRANSLATION_STYLE,
  getEffectiveTranslationStyle,
  normalizeTranslationStyle,
} from "./translationStyle";

export type PaperContextDraft = {
  abstract?: string;
  terminology: PaperContextTerm[];
  title?: string;
  translationStyle?: TranslationStyleSettings;
};

type InferPaperContextInput = {
  fileName?: string;
  metadataTitle?: string;
  pageTexts: string[];
};

export async function getPaperContextRecord(pdfFingerprint: string) {
  const db = await getAppDb();
  const record = await db.get("paperContexts", pdfFingerprint);

  return record ? normalizePaperContextRecord(record) : undefined;
}

export async function ensurePaperContextForEntry(entry: PdfLibraryEntry) {
  const existing = await getPaperContextRecord(entry.fingerprint);

  if (existing) {
    return existing;
  }

  return putPaperContextRecord(entry.fingerprint, {
    abstract: undefined,
    terminology: [],
    title: cleanOptionalText(entry.pdfMetadata?.title),
    translationStyle: DEFAULT_TRANSLATION_STYLE,
  }, {
    cloudDocumentId: entry.cloudDocumentId,
  });
}

export async function updatePaperContextFromPageTexts({
  cloudDocumentId,
  fileName,
  metadataTitle,
  pageTexts,
  pdfFingerprint,
}: InferPaperContextInput & {
  cloudDocumentId?: string;
  pdfFingerprint: string;
}) {
  const existing = await getPaperContextRecord(pdfFingerprint);

  if (existing?.userEditedAt) {
    return existing;
  }

  const inferredContext = inferPaperContext({
    fileName,
    metadataTitle,
    pageTexts: pageTexts.slice(0, PROJECT_CONFIG.paperContext.maxScanPages),
  });
  const draft: PaperContextDraft = {
    abstract: existing?.abstract || inferredContext.abstract,
    terminology: existing?.terminology ?? [],
    title: existing?.title || inferredContext.title,
    translationStyle: existing?.translationStyle ?? DEFAULT_TRANSLATION_STYLE,
  };
  const nextContext = normalizePaperContext(draft);

  if (existing && existing.contextHash === nextContext.contextHash) {
    return existing;
  }

  return putPaperContextRecord(pdfFingerprint, draft, {
    cloudDocumentId,
    previousRecord: existing,
  });
}

export async function saveUserPaperContext(
  pdfFingerprint: string,
  draft: PaperContextDraft,
  cloudDocumentId?: string,
) {
  const existing = await getPaperContextRecord(pdfFingerprint);

  return putPaperContextRecord(pdfFingerprint, draft, {
    cloudDocumentId: cloudDocumentId ?? existing?.cloudDocumentId,
    previousRecord: existing,
    userEdited: true,
  });
}

export async function deletePaperContextByPdf(pdfFingerprint: string) {
  const db = await getAppDb();
  const existing = await db.get("paperContexts", pdfFingerprint);

  await db.delete("paperContexts", pdfFingerprint);
  await runCloudSync(() => deleteCloudPaperContext(existing?.cloudDocumentId), {
    error: "Deleted paper context locally, but cloud sync failed.",
    started: "Syncing paper context deletion.",
    success: "Paper context deletion synced.",
  }).catch(() => undefined);
}

export function normalizePaperContext(draft: PaperContextDraft): PaperContext {
  const terminology = normalizeTerminology(draft.terminology);
  const translationStyle = normalizeTranslationStyle(draft.translationStyle);
  const translationStyleHash = getEffectiveTranslationStyle(translationStyle).translationStyleHash;
  const contextBody = {
    abstract: cleanOptionalText(draft.abstract) ?? "",
    terminology: terminology.map((term) => ({
      confidence: term.confidence,
      source: term.source,
      target: term.target,
    })),
    title: cleanOptionalText(draft.title) ?? "",
  };

  return {
    abstract: contextBody.abstract || undefined,
    contextHash: `ctx-${hashString(JSON.stringify(contextBody))}`,
    terminology,
    title: contextBody.title || undefined,
    translationStyle,
    translationStyleHash,
  };
}

function inferPaperContext({
  fileName,
  metadataTitle,
  pageTexts,
}: InferPaperContextInput): PaperContext {
  const firstPagesRawText = pageTexts.join(" ");
  const firstPagesText = normalizeText(firstPagesRawText);
  const metadataTitleCandidate = cleanOptionalText(metadataTitle);
  const inferredTitle =
    metadataTitleCandidate ??
    extractTitleText(firstPagesRawText, { fallbackToInput: false }) ??
    inferTitleFromText(firstPagesText) ??
    cleanFileNameTitle(fileName);
  const inferredAbstract = extractAbstract(firstPagesRawText, firstPagesText);

  return normalizePaperContext({
    abstract: inferredAbstract,
    terminology: [],
    title: inferredTitle,
    translationStyle: DEFAULT_TRANSLATION_STYLE,
  });
}

async function putPaperContextRecord(
  pdfFingerprint: string,
  draft: PaperContextDraft,
  options: {
    cloudDocumentId?: string;
    previousRecord?: PaperContextRecord;
    userEdited?: boolean;
  } = {},
) {
  const db = await getAppDb();
  const now = Date.now();
  const context = normalizePaperContext({
    ...draft,
    translationStyle: draft.translationStyle ?? options.previousRecord?.translationStyle,
  });
  const record: PaperContextRecord = {
    ...context,
    cloudDocumentId: options.cloudDocumentId ?? options.previousRecord?.cloudDocumentId,
    pdfFingerprint,
    updatedAt: now,
    userEditedAt: options.userEdited
      ? now
      : options.previousRecord?.userEditedAt,
  };

  await db.put("paperContexts", record);
  await runCloudSync(() => syncPaperContextToCloud(record), {
    error: "Saved paper context locally, but cloud sync failed.",
    started: "Syncing paper context.",
    success: "Paper context synced.",
  }).catch(() => undefined);

  return record;
}

function normalizePaperContextRecord(record: PaperContextRecord): PaperContextRecord {
  const context = normalizePaperContext({
    abstract: record.abstract,
    terminology: record.terminology ?? [],
    title: record.title,
    translationStyle: record.translationStyle,
  });

  return {
    ...record,
    ...context,
  };
}

function normalizeTerminology(terminology: PaperContextTerm[]) {
  const now = Date.now();
  const termsBySource = new Map<string, PaperContextTerm>();

  for (const term of terminology) {
    const source = cleanOptionalText(term.source);
    const target = cleanOptionalText(term.target);

    if (!source || !target) {
      continue;
    }

    const key = source.toLocaleLowerCase();
    const normalizedTerm: PaperContextTerm = {
      confidence: term.confidence === "auto" ? "auto" : "user",
      source,
      target,
      updatedAt: Number.isFinite(term.updatedAt) ? term.updatedAt : now,
    };
    const existingTerm = termsBySource.get(key);

    if (!existingTerm || normalizedTerm.updatedAt >= existingTerm.updatedAt) {
      termsBySource.set(key, normalizedTerm);
    }
  }

  return Array.from(termsBySource.values()).sort((left, right) => {
    const sourceComparison = left.source.localeCompare(right.source);

    return sourceComparison === 0
      ? left.target.localeCompare(right.target)
      : sourceComparison;
  });
}

function inferTitleFromText(text: string) {
  const abstractIndex = text.search(/\babstract\b/i);
  const titleRegion = cleanOptionalText(
    text.slice(0, abstractIndex >= 0 ? abstractIndex : Math.min(text.length, 240)),
  );

  if (!titleRegion) {
    return undefined;
  }

  const withoutLeadingNoise = titleRegion
    .replace(/^\d+\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = withoutLeadingNoise.split(/\s+/).slice(0, 24).join(" ");

  return cleanOptionalText(trimTrailingPunctuation(words));
}

function extractAbstract(rawText: string, cleanedText = normalizeText(rawText)) {
  const explicitAbstract = extractAbstractText(rawText, { fallbackToInput: false });

  if (explicitAbstract) {
    return cleanOptionalText(
      trimToSentenceBoundary(
        explicitAbstract.slice(0, PROJECT_CONFIG.paperContext.maxAbstractCharacters),
      ),
    );
  }

  const text = cleanedText;
  const match = /\babstract\b\s*[:.-]?\s*/i.exec(text);

  if (!match) {
    return undefined;
  }

  const start = match.index + match[0].length;
  const remainder = text.slice(start);
  const end = findAbstractEnd(remainder);
  const rawAbstract = remainder
    .slice(0, end)
    .slice(0, PROJECT_CONFIG.paperContext.maxAbstractCharacters);

  return cleanOptionalText(trimToSentenceBoundary(rawAbstract));
}

function findAbstractEnd(text: string) {
  const headingPattern =
    /\b(?:keywords?|key words|1\s+introduction|introduction|related work|background|methods?|methodology|materials and methods)\b/i;
  const match = headingPattern.exec(text);

  if (match && match.index >= 80) {
    return match.index;
  }

  return Math.min(text.length, PROJECT_CONFIG.paperContext.maxAbstractCharacters);
}

function trimToSentenceBoundary(text: string) {
  const normalized = normalizeText(text);
  const lastBoundary = Math.max(
    normalized.lastIndexOf("."),
    normalized.lastIndexOf("?"),
    normalized.lastIndexOf("!"),
  );

  if (lastBoundary >= 120) {
    return normalized.slice(0, lastBoundary + 1);
  }

  return normalized;
}

function cleanFileNameTitle(fileName?: string) {
  return cleanOptionalText(fileName?.replace(/\.pdf$/i, "").replace(/[_-]+/g, " "));
}

function cleanOptionalText(value?: string) {
  return cleanOptionalExtractedText(value);
}

function normalizeText(value: string) {
  return cleanExtractedText(value);
}

function trimTrailingPunctuation(value: string) {
  return value.replace(/[,:;.\s]+$/, "");
}

function hashString(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}
