import { createHash } from 'node:crypto';
import { requireCondition } from './errors.mjs';

export const DOCUMENT_VIEW_VERSION = 'document-view-v1';
export const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const segmenter = new Intl.Segmenter('und', { granularity: 'grapheme' });

// Every normalized UTF-16 unit keeps its original extent. NFC may contract or
// expand a grapheme; whitespace collapsing must not destroy source positions.
export function normalizeWithMap(text, { caseFold = false } = {}) {
  let normalized = '';
  const starts = [], ends = [];
  for (const { segment, index } of segmenter.segment(text)) {
    const value = segment.normalize('NFC');
    for (const character of value) {
      if (/\s/u.test(character)) {
        if (normalized.endsWith(' ')) { ends[ends.length - 1] = index + segment.length; continue; }
        normalized += ' '; starts.push(index); ends.push(index + segment.length);
      } else {
        const output = caseFold ? character.toLowerCase() : character;
        normalized += output;
        for (let i = 0; i < output.length; i++) { starts.push(index); ends.push(index + segment.length); }
      }
    }
  }
  return { text: normalized, starts, ends };
}
export const normalizeText = (text, options) => normalizeWithMap(text, options).text.trim();

export function createDocumentView({ pages: rawPages, documentId, documentVersion, title = 'Current document', sourceRecordId, pdfFingerprint = '', pageCount }) {
  requireCondition(Array.isArray(rawPages), 'DOCUMENT_UNREADABLE', '文档页数据不可读。', { retryable: false, statusCode: 409 });
  const byPage = new Map();
  for (const [index, raw] of rawPages.entries()) {
    const pageNumber = Number.isInteger(raw?.pageIndex) ? raw.pageIndex + 1 : index + 1;
    requireCondition(pageNumber >= 1 && !byPage.has(pageNumber), 'DOCUMENT_UNREADABLE', '文档页号无效或重复。', { retryable: false, statusCode: 409 });
    byPage.set(pageNumber, raw ?? {});
  }
  const totalPages = Math.max(Number.isInteger(pageCount) ? pageCount : 0, ...byPage.keys(), 0);
  requireCondition(totalPages > 0 && totalPages <= 10000, 'DOCUMENT_UNREADABLE', '文档页数无效。', { retryable: false });
  let text = '';
  const pages = [], lines = [], sections = [];
  for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
    const raw = byPage.get(pageNumber) ?? {};
    const entries = Array.isArray(raw.lines) ? raw.lines : [];
    const page = { pageNumber, lines: [], start: text.length, missingText: true };
    for (const [index, entry] of entries.entries()) {
      const value = typeof entry === 'string' ? entry : typeof entry?.text === 'string' ? entry.text : '';
      const line = { pageNumber, lineNumber: index + 1, text: value, start: text.length, end: text.length + value.length,
        region: normalizeRegion(entry, raw), latex: typeof entry?.latex === 'string' ? entry.latex : undefined };
      text += value + '\n';
      page.lines.push(line); lines.push(line);
      if (value.trim()) page.missingText = false;
      const heading = inferHeading(value, entry);
      if (heading) sections.push({ sectionId: `section-${pageNumber}-${index + 1}`, title: heading.title, level: heading.level,
        inferred: heading.inferred, start: line.start, headingEnd: line.end, pageStart: pageNumber });
    }
    page.end = text.length;
    pages.push(page);
  }
  requireCondition(text.trim(), 'DOCUMENT_UNREADABLE', '解析产物没有可读取的文本。', { retryable: false, statusCode: 409 });
  for (const [index, section] of sections.entries()) {
    const next = sections.slice(index + 1).find((candidate) => candidate.level <= section.level);
    section.end = next?.start ?? text.length;
    section.pageEnd = lines.findLast((line) => line.start < section.end && line.end > section.start)?.pageNumber ?? section.pageStart;
    section.sectionPath = sections.filter((parent) => parent.start < section.start && parent.end > section.start && parent.level < section.level)
      .map((parent) => parent.title).concat(section.title);
  }
  return { documentId, documentVersion, viewVersion: DOCUMENT_VIEW_VERSION, title, sourceRecordId, pdfFingerprint,
    text, pages, lines, sections, pageCount: totalPages, textHash: hash(text) };
}

function inferHeading(value, raw) {
  const text = value.trim();
  if (!text || text.length > 140) return;
  const markdown = /^(#{1,6})\s+(.+)$/.exec(text);
  if (markdown) return { title: markdown[2], level: markdown[1].length, inferred: false };
  if (raw?.type === 'heading' || raw?.isHeading === true) return { title: text, level: Math.max(1, Math.min(6, Number(raw.level) || 1)), inferred: false };
  const numbered = /^(\d+(?:\.\d+)*|[IVXLC]+|[A-Z])\.?\s+([^.!?。！？]{2,100})$/.exec(text);
  if (numbered && text.split(/\s+/).length <= 14) return { title: text, level: numbered[1].split('.').length, inferred: true };
  if (/^(abstract|introduction|background|related work|methods?|methodology|approach|experiments?|evaluation|results?|discussion|limitations?|conclusions?|references|bibliography|appendix(?:\s+[A-Z])?|摘要|引言|方法|实验|结果|讨论|结论|参考文献|附录)\s*[:：]?$/i.test(text)) {
    return { title: text, level: 1, inferred: true };
  }
}
function normalizeRegion(entry, page) {
  if (!entry || typeof entry !== 'object') return;
  let raw = entry.region;
  if (!raw && Array.isArray(entry.cnt) && entry.cnt.length) {
    const points = entry.cnt.filter((p) => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite));
    if (points.length) {
      const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
      raw = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }
  }
  const width = page.pageWidth ?? page.width, height = page.pageHeight ?? page.height;
  if (!raw || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const region = { x: (raw.x ?? raw.left) / width, y: (raw.y ?? raw.top) / height,
    width: (raw.width ?? raw.w) / width, height: (raw.height ?? raw.h) / height };
  if (Object.values(region).some((v) => !Number.isFinite(v) || v < 0) || region.width <= 0 || region.height <= 0
    || region.x + region.width > 1.001 || region.y + region.height > 1.001) return;
  return region;
}

export function sourceSpans(view, start, end) {
  return view.lines.filter((line) => line.end > start && line.start < end && line.text.trim()).map((line) => ({
    pageNumber: line.pageNumber, lineNumber: line.lineNumber,
    startOffset: Math.max(0, start - line.start), endOffset: Math.min(line.text.length, end - line.start),
  })).filter((span) => span.endOffset > span.startOffset);
}
export function describeRange(view, start, end, kind = 'lines') {
  const spans = sourceSpans(view, start, end);
  requireCondition(spans.length, 'SOURCE_MAPPING_UNAVAILABLE', '所选原文没有可靠来源。');
  const selectedLines = spans.map((span) => view.pages[span.pageNumber - 1].lines[span.lineNumber - 1]);
  const lineRegions = selectedLines.filter((line) => line.region).map((line) => ({ pageNumber: line.pageNumber, lineNumber: line.lineNumber, region: line.region }));
  const missingRegionRanges = selectedLines.filter((line) => !line.region).map((line) => ({ pageNumber: line.pageNumber, lineNumber: line.lineNumber }));
  const first = selectedLines[0];
  const paths = view.sections.filter((section) => section.start < end && section.end > start)
    .filter((section) => !view.sections.some((child) => child.level > section.level && child.start <= start && child.end >= end));
  return { sourceSpans: spans, pageStart: first.pageNumber, pageEnd: selectedLines.at(-1).pageNumber,
    sectionPath: [...new Set(paths.flatMap((section) => section.sectionPath))],
    anchor: { pageNumber: first.pageNumber, lineNumber: first.lineNumber }, lineRegions, missingRegionRanges,
    locationPrecision: kind === 'section' ? (first.region ? 'section' : 'page')
      : missingRegionRanges.length === 0 ? 'line' : lineRegions.length ? 'partial-line' : 'page' };
}

export function createEvidenceStore(view) {
  const evidence = [], byId = new Map(), byKey = new Map();
  function add(start, end, extra = {}) {
    const location = describeRange(view, start, end, extra.kind);
    const key = hash([view.documentId, view.documentVersion, view.viewVersion, location.sourceSpans]);
    let item = byKey.get(key);
    if (!item) {
      item = { evidenceId: `C${evidence.length + 1}`, evidenceKey: key, sourceKind: 'document_text',
        sourceVersion: view.documentVersion, viewVersion: view.viewVersion, sourceRecordId: view.sourceRecordId,
        cloudDocumentId: view.documentId, documentTitle: view.title, pdfFingerprint: view.pdfFingerprint,
        start, end, text: view.text.slice(start, end), ...location };
      evidence.push(item); byKey.set(key, item); byId.set(item.evidenceId, item);
    }
    return { ...item, ...extra };
  }
  function publicItem(item) {
    return { evidenceId: item.evidenceId, text: item.text, scopeLabel: item.sectionPath.join(' / ') || `PDF pages ${item.pageStart}-${item.pageEnd}` };
  }
  return { view, evidence, byId, add, publicItem };
}

export function mergeCoverage(intervals) {
  const result = [];
  for (const item of [...intervals].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = result.at(-1);
    if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
    else result.push({ start: item.start, end: item.end });
  }
  return result;
}
