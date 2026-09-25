import { artifactAssert, ARTIFACT_LIMITS } from './qaDocumentArtifact.mjs';

export const ALIGNMENT_LIMITS = Object.freeze({ maxTokens: 600000, maxProbes: 4000000, anchorTokens: 5 });
export function textTokens(text) {
  return [...text.matchAll(/[\p{L}\p{M}\p{N}]+|[^\s]/gu)].map(match => ({ value: match[0].normalize('NFC'), start: match.index, end: match.index + match[0].length }));
}
const signature = tokens => JSON.stringify(tokens.map(token => token.value));
const word = value => /^[\p{L}\p{M}]+$/u.test(value);
const blockText = text => /\\begin\{(?:tabular|table|array|align|equation)|\n.*\n/.test(text);
function rectangle(region, page) {
  const { pageWidth: w, pageHeight: h } = page;
  const { x, y, width, height } = region ?? {};
  if (![x, y, width, height, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || x < 0 || y < 0
    || width <= 0 || height <= 0 || x + width > w + 1 || y + height > h + 1) return undefined;
  return { x: x / w, y: y / h, width: Math.min(width / w, 1 - x / w), height: Math.min(height / h, 1 - y / h) };
}
function contains(outer, inner) {
  const a = outer.rect, b = inner.rect;
  return a && b && a.x <= b.x + .001 && a.y <= b.y + .001
    && a.x + a.width >= b.x + b.width - .001 && a.y + a.height >= b.y + b.height - .001;
}

// Only content-bearing fields participate in the source digest. Device IDs,
// fingerprints and local/cloud cache timestamps are not a document revision.
export function canonicalizeLayout(pages, declaredPageCount) {
  artifactAssert(Array.isArray(pages) && pages.length > 0 && pages.length <= ARTIFACT_LIMITS.maxPages,
    'LAYOUT_LIMIT', 'Invalid parsed pages.');
  const seenPages = new Set(), regions = [], canonicalPages = [];
  let totalChars = 0, totalLines = 0;
  for (const page of [...pages].sort((a, b) => a.pageIndex - b.pageIndex)) {
    artifactAssert(Number.isSafeInteger(page.pageIndex) && page.pageIndex >= 0 && page.pageIndex < ARTIFACT_LIMITS.maxPages
      && !seenPages.has(page.pageIndex) && Array.isArray(page.lines), 'INVALID_LAYOUT', 'Invalid or duplicate parsed page.');
    seenPages.add(page.pageIndex);
    totalLines += page.lines.length;
    artifactAssert(totalLines <= ARTIFACT_LIMITS.maxRegions, 'LAYOUT_LIMIT', 'Too many parsed lines.');
    const canonicalLines = [], seenLines = new Set();
    for (const line of [...page.lines].sort((a, b) => a.lineIndex - b.lineIndex)) {
      artifactAssert(Number.isSafeInteger(line.lineIndex) && line.lineIndex >= 0 && !seenLines.has(line.lineIndex)
        && typeof line.text === 'string', 'INVALID_LAYOUT', 'Invalid or duplicate parsed line.');
      seenLines.add(line.lineIndex);
      totalChars += line.text.length;
      artifactAssert(totalChars <= ARTIFACT_LIMITS.maxTextChars / 2 && regions.length < ARTIFACT_LIMITS.maxRegions,
        'LAYOUT_LIMIT', 'Layout text exceeds the preparation limit.');
      if (!line.text.trim()) continue;
      const rect = rectangle(line.region, page);
      const region = { id: `p${page.pageIndex + 1}_l${line.lineIndex + 1}`, pageNumber: page.pageIndex + 1,
        lineNumber: line.lineIndex + 1, text: line.text, kind: blockText(line.text) ? 'block' : 'line', ...(rect ? { rect } : {}) };
      regions.push(region); canonicalLines.push(region);
    }
    canonicalPages.push({ pageNumber: page.pageIndex + 1, regions: canonicalLines });
  }
  const minPageCount = Math.max(...seenPages) + 1;
  const pageCount = declaredPageCount ?? minPageCount;
  artifactAssert(Number.isSafeInteger(pageCount) && pageCount >= minPageCount && pageCount <= ARTIFACT_LIMITS.maxPages,
    'INVALID_LAYOUT', 'Invalid document page count.');
  return { regions, pageCount, canonicalPages };
}

export function createAlignmentIndex(regions) {
  const tapes = [], index = new Map(), pageRegions = new Map();
  let tokenCount = 0, suppressedAliases = 0, probes = 0;
  function probe() { artifactAssert(++probes <= ALIGNMENT_LIMITS.maxProbes, 'ALIGNMENT_LIMIT', 'Alignment work budget exceeded.'); }
  const tokenized = new Map();
  for (const region of regions) {
    const tokens = textTokens(region.text);
    tokenCount += tokens.length;
    artifactAssert(tokenCount <= ALIGNMENT_LIMITS.maxTokens, 'ALIGNMENT_LIMIT', 'Too many layout tokens.');
    tokenized.set(region.id, { tokens, signature: signature(tokens) });
    if (!pageRegions.has(region.pageNumber)) pageRegions.set(region.pageNumber, []);
    pageRegions.get(region.pageNumber).push(region);
  }
  for (const [pageNumber, items] of pageRegions) {
    const blocks = items.filter(region => region.kind === 'block');
    const selected = [];
    const duplicateRegions = new Map();
    for (const region of items) {
      // Same geometry + contained textual representation is an OCR alias. Do
      // not deduplicate equal text printed elsewhere or merely nearby boxes.
      const duplicateKey = region.rect ? JSON.stringify([region.rect, region.text]) : undefined;
      const duplicate = duplicateKey && duplicateRegions.has(duplicateKey);
      if (duplicateKey) duplicateRegions.set(duplicateKey, region);
      const alias = duplicate || blocks.some(other => {
        probe();
        return other !== region && contains(other, region)
          && (other.text.length > region.text.length || other.text === region.text && other.lineNumber < region.lineNumber)
          && tokenized.get(other.id).signature.includes(tokenized.get(region.id).signature.slice(1, -1));
      });
      if (alias) { suppressedAliases++; continue; }
      selected.push(region);
    }
    // A full table/equation is a separate tape, not an interruption woven into
    // the prose tape. Its children were retained in regions for provenance.
    const groups = [selected.filter(region => !blocks.includes(region)), ...selected.filter(region => blocks.includes(region)).map(region => [region])];
    for (const group of groups) {
      if (!group.length) continue;
      const tokens = [];
      for (let r = 0; r < group.length; r++) {
        const region = group[r], parts = tokenized.get(region.id).tokens;
        for (let k = 0; k < parts.length; k++) tokens.push({ ...parts[k], region, regionIndex: r, first: k === 0, last: k === parts.length - 1 });
      }
      const tape = { pageNumber, tokens, group }; tapes.push(tape);
      for (let i = 0; i + ALIGNMENT_LIMITS.anchorTokens <= tokens.length; i++) {
        const key = signature(tokens.slice(i, i + ALIGNMENT_LIMITS.anchorTokens));
        const hits = index.get(key) ?? [];
        // Bound repeated boilerplate storage. More than 16 occurrences cannot
        // provide a unique anchor; record the ambiguity without growing memory.
        if (hits.length < 17) hits.push({ tape, offset: i });
        index.set(key, hits);
      }
    }
  }
  return { index, tapes, probe, tokenized, get stats() { return { tokenCount, suppressedAliases, probes }; } };
}

function adjacent(left, right) {
  if (!left.last || !right.first || right.regionIndex !== left.regionIndex + 1) return false;
  const a = left.region.rect, b = right.region.rect;
  // A lost hyphen may be repaired only at a proven physical line transition
  // in the same column. Missing coordinates degrade instead of inventing it.
  return a && b && Math.abs(a.x - b.x) < Math.max(.035, a.width * .15)
    && b.y >= a.y && b.y - a.y <= Math.max(a.height, b.height) * 2.5;
}
function matchForward(logical, physical, p) {
  if (logical.value === physical[p]?.value) return 1;
  const left = physical[p], right = physical[p + 1];
  if (!left || !right || !word(logical.value)) return 0;
  if (word(left.value) && word(right.value) && adjacent(left, right) && logical.value === left.value + right.value) return 2;
  const afterHyphen = physical[p + 2];
  if (right.value === '-' && word(left.value) && afterHyphen && word(afterHyphen.value)
    && adjacent(right, afterHyphen) && logical.value === left.value + afterHyphen.value) return 3;
  return 0;
}
function sourceFor(tokens) {
  const sources = [];
  for (const token of tokens) {
    const previous = sources.at(-1);
    if (previous?.regionId === token.region.id) previous.range[1] = token.end;
    else sources.push({ regionId: token.region.id, range: [token.start, token.end] });
  }
  return sources;
}

export function alignDocumentNode(node, hint, alignment) {
  const logical = textTokens(node.text), matches = new Map();
  artifactAssert(logical.length <= ALIGNMENT_LIMITS.maxTokens, 'ALIGNMENT_LIMIT', 'Logical node is too large.');
  const eligible = hit => !hint.startPage || hit.tape.pageNumber >= hint.startPage && hit.tape.pageNumber <= hint.endPage;
  let minimumPhysical = new Map();
  for (let i = 0; i + ALIGNMENT_LIMITS.anchorTokens <= logical.length; i++) {
    if (matches.has(i)) continue;
    alignment.probe();
    const window = logical.slice(i, i + ALIGNMENT_LIMITS.anchorTokens);
    if (window.reduce((sum, token) => sum + token.value.length, 0) < 14) continue;
    const rawHits = alignment.index.get(signature(window)) ?? [];
    if (rawHits.length > 16) continue;
    const hits = rawHits.filter(eligible);
    if (hits.length !== 1) continue;
    const { tape, offset } = hits[0];
    if (offset < (minimumPhysical.get(tape) ?? 0)) continue;
    const add = (l, p, count) => matches.set(l, { tokens: tape.tokens.slice(p, p + count), joined: count > 1 });
    let l = i, p = offset;
    while (l < logical.length && p < tape.tokens.length && !matches.has(l)) {
      alignment.probe(); const count = matchForward(logical[l], tape.tokens, p);
      if (!count) break;
      add(l, p, count); l++; p += count;
    }
    minimumPhysical.set(tape, p);
    l = i - 1; p = offset - 1;
    while (l >= 0 && p >= 0 && !matches.has(l)) {
      alignment.probe();
      let count = 0;
      for (const size of [1, 2, 3]) {
        if (p - size + 1 >= 0 && matchForward(logical[l], tape.tokens, p - size + 1) === size) { count = size; break; }
      }
      if (!count) break;
      add(l, p - count + 1, count); l--; p -= count;
    }
  }
  // Short headings/paragraphs may be aligned only by a unique entire region,
  // not by a lone common token. Headings remain navigation-only regardless.
  if (!matches.size && logical.length) {
    const full = [];
    for (const tape of alignment.tapes) {
      if (!eligible({ tape })) continue;
      for (const region of tape.group) {
        alignment.probe();
        if (alignment.tokenized.get(region.id).signature === signature(logical)) full.push(region);
      }
    }
    if (full.length === 1) {
      const region = full[0];
      return { nodeId: node.id, pageAnchor: region.pageNumber, segments: [{ range: [0, node.text.length],
        sources: [{ regionId: region.id, range: [0, region.text.length] }], transform: node.text === region.text ? 'identity' : 'reflow' }] };
    }
  }
  const segments = [];
  for (const [i, match] of [...matches].sort((a, b) => a[0] - b[0])) {
    const token = logical[i], sources = sourceFor(match.tokens);
    const transform = match.joined ? 'line-wrap' : node.text.slice(token.start, token.end)
      === match.tokens[0].region.text.slice(...sources[0].range) ? 'identity' : 'reflow';
    const segment = { range: [token.start, token.end], sources, transform };
    const prev = segments.at(-1);
    // Merge contiguous exact text on one line, preserving small intervals for
    // sentence selection and the explicit two-line interval of a repaired word.
    if (prev?.transform === 'identity' && transform === 'identity' && prev.sources[0].regionId === sources[0].regionId
      && node.text.slice(prev.range[1], token.start) === match.tokens[0].region.text.slice(prev.sources[0].range[1], sources[0].range[0])) {
      prev.range[1] = token.end; prev.sources[0].range[1] = sources[0].range[1];
    } else segments.push(segment);
  }
  const anchor = segments.length ? matches.values().next().value.tokens[0].region.pageNumber : hint.startPage;
  return { nodeId: node.id, ...(anchor ? { pageAnchor: anchor } : {}), segments };
}
