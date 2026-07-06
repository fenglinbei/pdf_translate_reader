import { requireSupabaseServiceClient } from "../supabase/service.mjs";

const MATHPIX_BUCKET = "user-mathpix";

export async function loadMathpixStructuredDocument({ job }) {
  const record = await getCompletedMathpixRecord(job);
  const pagesPayload = await downloadStorageJson(record.pages_storage_path);
  const pages = normalizeStoredPages(pagesPayload);
  const bodyPages = createBodyPages(pages);

  if (bodyPages.length === 0) {
    throw new Error("MathPix cache did not contain usable body text.");
  }

  return {
    fullMmd: record.full_mmd_storage_path
      ? await downloadStorageText(record.full_mmd_storage_path).catch(() => "")
      : "",
    pageCount: pages.length,
    pages: bodyPages,
    referencesStartPage: getReferencesStartPage(pages),
    title: inferTitle(bodyPages),
  };
}

async function getCompletedMathpixRecord(job) {
  const { data, error } = await requireSupabaseServiceClient()
    .from("user_mathpix_documents")
    .select([
      "full_mmd_storage_path",
      "pages_storage_path",
      "status",
      "updated_at",
    ].join(","))
    .eq("user_id", job.user_id)
    .eq("user_document_id", job.user_document_id)
    .eq("content_sha256", job.content_sha256)
    .eq("status", "completed")
    .is("deleted_at", null)
    .not("pages_storage_path", "is", null)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Could not read MathPix cache metadata.");
  }

  if (!data?.pages_storage_path) {
    throw new Error("MathPix parsing must be completed before building the QA index.");
  }

  return data;
}

async function downloadStorageJson(path) {
  const { data, error } = await requireSupabaseServiceClient().storage
    .from(MATHPIX_BUCKET)
    .download(path);

  if (error) {
    throw new Error(error.message || "Could not download MathPix pages cache.");
  }

  return JSON.parse(await data.text());
}

async function downloadStorageText(path) {
  const { data, error } = await requireSupabaseServiceClient().storage
    .from(MATHPIX_BUCKET)
    .download(path);

  if (error) {
    throw new Error(error.message || "Could not download MathPix MMD cache.");
  }

  return data.text();
}

function normalizeStoredPages(value) {
  if (!Array.isArray(value)) {
    throw new Error("MathPix pages cache is not an array.");
  }

  return value
    .map((page, fallbackPageIndex) => normalizeStoredPage(page, fallbackPageIndex))
    .filter((page) => page.lines.length > 0)
    .sort((left, right) => left.pageNumber - right.pageNumber);
}

function normalizeStoredPage(value, fallbackPageIndex) {
  const pageObject = isRecord(value) ? value : {};
  const lines = Array.isArray(pageObject.lines)
    ? pageObject.lines
      .map((line) => normalizeLine(line))
      .filter(Boolean)
    : [];

  return {
    lines,
    pageMmd: typeof pageObject.pageMmd === "string" ? pageObject.pageMmd : "",
    pageNumber: normalizePageNumber(pageObject.pageIndex, fallbackPageIndex),
    pageText: typeof pageObject.pageText === "string" ? pageObject.pageText : lines.join(" "),
  };
}

function normalizeLine(value) {
  if (typeof value === "string") {
    return cleanText(value);
  }

  if (!isRecord(value) || typeof value.text !== "string") {
    return undefined;
  }

  return cleanText(value.text);
}

function normalizePageNumber(value, fallbackPageIndex) {
  const pageIndex = typeof value === "number" && Number.isFinite(value)
    ? value
    : fallbackPageIndex;

  return Math.max(1, Math.trunc(pageIndex) + 1);
}

function createBodyPages(pages) {
  const bodyPages = [];
  let currentSectionPath = [];
  let reachedReferences = false;

  for (const page of pages) {
    if (reachedReferences) {
      continue;
    }

    const referenceHeadingIndex = findReferencesHeadingIndex(page.lines);
    const lines = referenceHeadingIndex >= 0
      ? page.lines.slice(0, referenceHeadingIndex)
      : page.lines;

    if (referenceHeadingIndex >= 0) {
      reachedReferences = true;
    }

    const bodyLines = [];
    const sectionsByLine = [];

    for (const line of lines) {
      const sectionTitle = parseSectionHeading(line);

      if (sectionTitle) {
        currentSectionPath = [sectionTitle];
      }

      bodyLines.push(line);
      sectionsByLine.push(currentSectionPath);
    }

    if (bodyLines.some((line) => line.trim())) {
      bodyPages.push({
        lines: bodyLines,
        pageMmd: page.pageMmd,
        pageNumber: page.pageNumber,
        pageText: bodyLines.join(" "),
        sectionsByLine,
      });
    }
  }

  return bodyPages;
}

function getReferencesStartPage(pages) {
  const page = pages.find((candidate) => findReferencesHeadingIndex(candidate.lines) >= 0);

  return page?.pageNumber;
}

function findReferencesHeadingIndex(lines) {
  return lines.findIndex((line) => isReferencesHeading(line));
}

function isReferencesHeading(value) {
  const normalized = value.trim().replace(/[:.]+$/, "");

  return /^(?:\d+(?:\.\d+)*\s+)?(?:references|bibliography|literature cited|works cited)$/i.test(normalized);
}

function parseSectionHeading(value) {
  const normalized = value.trim().replace(/\s+/g, " ");

  if (normalized.length < 3 || normalized.length > 120) {
    return undefined;
  }

  const numberedMatch = /^(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.?)\s+(.+)$/.exec(normalized);
  const candidate = (numberedMatch?.[1] ?? normalized).replace(/[:.]+$/, "");

  if (isReferencesHeading(candidate)) {
    return undefined;
  }

  if (
    /^(abstract|introduction|background|related work|method|methods|methodology|approach|experiments?|evaluation|results?|discussion|limitations?|conclusion|appendix)\b/i
      .test(candidate)
  ) {
    return toTitleCase(candidate);
  }

  if (/^[A-Z][A-Z0-9,;:()\- /]{4,80}$/.test(candidate) && candidate.split(/\s+/).length <= 8) {
    return toTitleCase(candidate);
  }

  return undefined;
}

function inferTitle(pages) {
  const firstPageLines = pages[0]?.lines ?? [];
  const titleLines = [];

  for (const line of firstPageLines.slice(0, 12)) {
    if (/^abstract\b/i.test(line)) {
      break;
    }

    if (parseSectionHeading(line) || line.length < 8 || line.length > 180) {
      continue;
    }

    titleLines.push(line);

    if (titleLines.join(" ").length > 60) {
      break;
    }
  }

  return titleLines.join(" ").trim() || undefined;
}

function cleanText(value) {
  return value.replace(/\s+/g, " ").trim();
}

function toTitleCase(value) {
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase());
}

function isRecord(value) {
  return Boolean(value && typeof value === "object");
}
