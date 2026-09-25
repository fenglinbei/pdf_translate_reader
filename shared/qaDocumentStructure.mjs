import { artifactAssert, ARTIFACT_LIMITS, createNodeId } from './qaDocumentArtifact.mjs';

// Only explicit Markdown/LaTeX structure is authoritative. A year, table cell,
// bold phrase or numbered prose line never becomes a guessed chapter.
const headingCommands = { part: 1, chapter: 1, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
export function readBraced(text, start) {
  if (text[start] !== '{') return undefined;
  let depth = 1;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return { value: text.slice(start + 1, i), end: i + 1 };
  }
}

function heading(line) {
  const md = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
  if (md) return { level: md[1].length, text: md[2] };
  const latex = /^\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*/.exec(line);
  const title = latex && readBraced(line, latex[0].length);
  return title ? { level: headingCommands[latex[1]], text: title.value } : undefined;
}
function environment(line) {
  const match = /^(?:\\\[\s*)?\\begin\{(table\*?|tabular\*?|longtable|equation\*?|align\*?|gather\*?|figure\*?|itemize|enumerate|verbatim|abstract)\}/.exec(line);
  if (!match) return undefined;
  const name = match[1];
  return { name, kind: /table|tabular/.test(name) ? 'table' : /equation|align|gather/.test(name) ? 'equation'
    : /itemize|enumerate/.test(name) ? 'list' : name === 'verbatim' ? 'code' : 'paragraph' };
}
const normalizeProse = text => text.replace(/\\pagebreak\b(?:\[[^\]\n]*\])?/g, ' ').replace(/\s+/gu, ' ').trim().normalize('NFC');

export function parseMmdStructure(mmd, pageCount) {
  artifactAssert(typeof mmd === 'string' && mmd.trim() && mmd.length <= ARTIFACT_LIMITS.maxTextChars / 2,
    'MMD_LIMIT', 'Readable MMD is missing or exceeds the preparation limit.');
  const lines = [];
  let offset = 0;
  for (const raw of mmd.split('\n')) { lines.push({ raw, start: offset, end: offset + raw.length }); offset += raw.length + 1; }
  const breaks = lines.filter(line => /^\s*\\pagebreak\b/.test(line.raw)).map(line => line.start);
  // A final pagebreak closes the final page; it does not create another page.
  const lastContentEnd = lines.findLast(line => line.raw.trim() && !/^\s*\\pagebreak\b/.test(line.raw))?.end ?? 0;
  const nonFinalBreaks = breaks.filter(start => start < lastContentEnd);
  const hasPageHints = nonFinalBreaks.length > 0 && nonFinalBreaks.length + 1 === pageCount;
  const pageAt = position => {
    if (!hasPageHints) return pageCount === 1 ? 1 : undefined;
    let low = 0, high = nonFinalBreaks.length;
    while (low < high) { const mid = (low + high) >>> 1; if (nonFinalBreaks[mid] < position) low = mid + 1; else high = mid; }
    return low + 1;
  };
  const nodes = [], hints = [], stack = [];
  function append(kind, text, start, end, level) {
    if (!text.trim()) return;
    artifactAssert(nodes.length < ARTIFACT_LIMITS.maxNodes, 'ARTIFACT_LIMIT', 'Too many logical nodes.');
    const node = { id: createNodeId(kind, [start, end]), kind, text: text.normalize('NFC'), sourceRange: [start, end] };
    if (kind === 'section') {
      node.level = level;
      while (stack.length && stack.at(-1).level >= level) stack.pop();
    }
    if (stack.length) node.parentId = stack.at(-1).id;
    nodes.push(node); hints.push({ startPage: pageAt(start), endPage: pageAt(Math.max(start, end - 1)) });
    if (kind === 'section') stack.push(node);
  }
  for (let i = 0; i < lines.length;) {
    const line = lines[i], trimmed = line.raw.trim();
    if (!trimmed || /^\\pagebreak\b/.test(trimmed)) { i++; continue; }
    const title = heading(trimmed);
    if (title) { append('section', normalizeProse(title.text), line.start, line.end, title.level); i++; continue; }
    // Markdown setext headings are explicit two-line syntax.
    if (/^(?:=+|-+)\s*$/.test(lines[i + 1]?.raw ?? '') && trimmed && !/^[-*+]\s/.test(trimmed)) {
      append('section', normalizeProse(trimmed), line.start, lines[i + 1].end, lines[i + 1].raw[0] === '=' ? 1 : 2); i += 2; continue;
    }
    const env = environment(trimmed);
    const fence = /^(?:`{3,}|~{3,})/.exec(trimmed)?.[0];
    const math = trimmed.startsWith('$$') ? '$$' : trimmed.startsWith('\\[') ? '\\]' : undefined;
    if (env || fence || math) {
      let j = i;
      const closing = env ? `\\end{${env.name}}` : fence ?? math;
      const sameLineClosed = env ? trimmed.includes(closing) : math && trimmed.indexOf(closing, 2) >= 0;
      if (!sameLineClosed) {
        for (j = i + 1; j < lines.length && !lines[j].raw.includes(closing); j++);
        j = Math.min(j, lines.length - 1);
      }
      let text = mmd.slice(line.start, lines[j].end).replace(/\\pagebreak\b/g, '').trim();
      let kind = env?.kind ?? (fence ? 'code' : 'equation');
      if (env?.name === 'abstract') {
        append('section', 'Abstract', line.start, line.start + trimmed.length, 1);
        text = text.replace(/^\\begin\{abstract\}/, '').replace(/\\end\{abstract\}$/, '');
      }
      if (env?.name.startsWith('figure')) {
        // Do not send remote image URLs or figure layout commands as prose.
        // Captions remain readable; this does not claim visual understanding.
        const caption = /\\caption\s*/.exec(text);
        text = caption ? readBraced(text, caption.index + caption[0].length)?.value ?? '' : '';
      }
      if (kind === 'paragraph') text = normalizeProse(text);
      append(kind, text, line.start, lines[j].end); i = j + 1; continue;
    }
    const isTable = /\|/.test(trimmed) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1]?.raw ?? '');
    const isList = /^(?:[-*+]\s+|\d+[.)]\s+)/.test(trimmed);
    let j = i + 1;
    for (; j < lines.length; j++) {
      const next = lines[j].raw.trim();
      if (!next || heading(next) || environment(next) || /^(?:`{3}|~{3}|\$\$|\\\[)/.test(next)) break;
      if (isTable && !next.includes('|')) break;
      if (/^\\pagebreak\b/.test(next)) continue;
      if (!isList && /^(?:[-*+]\s+|\d+[.)]\s+)/.test(next)) break;
    }
    const raw = mmd.slice(line.start, lines[j - 1].end);
    append(isTable ? 'table' : isList ? 'list' : 'paragraph', isTable || isList ? raw.replace(/\\pagebreak\b/g, '').trim() : normalizeProse(raw), line.start, lines[j - 1].end);
    i = j;
  }
  return { nodes, hints, hasPageHints };
}
