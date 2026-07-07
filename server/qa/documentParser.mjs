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
  const rawLines = Array.isArray(pageObject.lines) ? pageObject.lines : [];
  const lines = [];
  const latexByLine = [];
  const lineRegions = [];

  for (const entry of rawLines) {
    const line = normalizeLine(entry);

    if (line) {
      lines.push(line.text);
      latexByLine.push(line.latex);
      lineRegions.push(line.region);
    }
  }

  return {
    latexByLine,
    lineRegions,
    lines,
    pageHeight: getOptionalNumber(pageObject.pageHeight ?? pageObject.height),
    pageMmd: typeof pageObject.pageMmd === "string" ? pageObject.pageMmd : "",
    pageNumber: normalizePageNumber(pageObject.pageIndex, fallbackPageIndex),
    pageText: typeof pageObject.pageText === "string" ? pageObject.pageText : lines.join(" "),
    pageWidth: getOptionalNumber(pageObject.pageWidth ?? pageObject.width),
  };
}

function normalizeLine(value) {
  if (typeof value === "string") {
    const text = cleanText(value);
    return text ? { latex: undefined, region: undefined, text } : undefined;
  }

  if (!isRecord(value) || typeof value.text !== "string") {
    return undefined;
  }

  const text = cleanText(value.text);
  if (!text) {
    return undefined;
  }

  const latexRaw = cleanText(typeof value.latex === "string" ? value.latex : "");
  return {
    latex: latexRaw && latexRaw !== text ? latexRaw : undefined,
    region: normalizeLineRegion(value.region, value.cnt),
    text,
  };
}

// Replicates src/mathpix/mathpixNormalizer.ts normalizeRegion: prefer the
// explicit region bbox, otherwise derive one from the cnt contour points.
function normalizeLineRegion(rawRegion, rawCnt) {
  const region = isRecord(rawRegion) ? rawRegion : {};
  const x = getOptionalNumber(region.x ?? region.left);
  const y = getOptionalNumber(region.y ?? region.top);
  const width = getOptionalNumber(region.width ?? region.w);
  const height = getOptionalNumber(region.height ?? region.h);

  if ([x, y, width, height].every((value) => typeof value === "number")) {
    return { height, width, x, y };
  }

  const cnt = normalizeCnt(rawCnt);

  if (!cnt || cnt.length === 0) {
    return undefined;
  }

  const xs = cnt.map((point) => point[0]);
  const ys = cnt.map((point) => point[1]);
  const left = Math.min(...xs);
  const top = Math.min(...ys);

  return {
    height: Math.max(...ys) - top,
    width: Math.max(...xs) - left,
    x: left,
    y: top,
  };
}

function normalizeCnt(value) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const points = [];

  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length < 2) {
      continue;
    }

    const x = getOptionalNumber(entry[0]);
    const y = getOptionalNumber(entry[1]);

    if (typeof x === "number" && typeof y === "number") {
      points.push([x, y]);
    }
  }

  return points.length > 0 ? points : undefined;
}

function getOptionalNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
    const endIndex = referenceHeadingIndex >= 0 ? referenceHeadingIndex : page.lines.length;
    const pageLatexByLine = Array.isArray(page.latexByLine) ? page.latexByLine : [];

    if (referenceHeadingIndex >= 0) {
      reachedReferences = true;
    }

    const bodyLines = [];
    const bodyLatexLines = [];
    const bodyLineRegions = [];
    const sectionsByLine = [];
    const pageLineRegions = Array.isArray(page.lineRegions) ? page.lineRegions : [];

    for (let index = 0; index < endIndex; index += 1) {
      const line = page.lines[index];

      if (line === undefined) {
        continue;
      }

      const sectionTitle = parseSectionHeading(line);

      if (sectionTitle) {
        currentSectionPath = [sectionTitle];
      }

      bodyLines.push(line);
      bodyLatexLines.push(pageLatexByLine[index]);
      bodyLineRegions.push(pageLineRegions[index]);
      sectionsByLine.push(currentSectionPath);
    }

    if (bodyLines.some((line) => line.trim())) {
      bodyPages.push({
        latexByLine: bodyLatexLines,
        lineRegions: bodyLineRegions,
        lines: bodyLines,
        pageHeight: page.pageHeight,
        pageMmd: page.pageMmd,
        pageNumber: page.pageNumber,
        pageText: bodyLines.join(" "),
        pageWidth: page.pageWidth,
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
