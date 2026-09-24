import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import { DocumentToolError, requireCondition } from './errors.mjs';
import { normalizeText, normalizeWithMap } from './view.mjs';
import { resolveCitationSelections } from './citations.mjs';

const string = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const sourceIds = { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^C[1-9][0-9]*$', maxLength: 16 } };
const cursor = string(100);
const stableJson = (value) => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const selection = { oneOf: [object({ kind: { const: 'quote', type: 'string' }, sourceEvidenceIds: sourceIds,
  quote: string(2000), contextBefore: string(500), contextAfter: string(500) }, ['kind', 'sourceEvidenceIds', 'quote']),
object({ kind: { const: 'source', type: 'string' }, sourceEvidenceIds: sourceIds })] };
const definitions = [
  { name: 'get_document_outline', description: '查看当前文档的软件生成目录、物理页范围和全文大小。目录不是已读正文。没有可靠标题时按页浏览。',
    parameters: object({ cursor }, []) },
  { name: 'search_document_text', description: '按原文字面搜索当前文档，可自行提出英文术语和同义词。没有命中不代表文中没有答案。返回的 C 编号预览可引用，句子截断需补读。',
    parameters: object({ queries: { type: 'array', minItems: 1, maxItems: 4, items: string(200) },
      matchMode: { type: 'string', enum: ['literal', 'all_terms', 'any_terms'] }, pageStart: integer(1, 10000), pageEnd: integer(1, 10000), limit: integer(1, 20), cursor }, ['queries', 'matchMode']) },
  { name: 'read_document', description: '阅读原文，返回来源 C 编号。可选目录给出的 sectionId、页范围或全文；通过 cursor 续读时保持原参数。全文超预算时改读章节或页。',
    parameters: { type: 'object', oneOf: [
      object({ mode: { const: 'pages', type: 'string' }, pageStart: integer(1, 10000), pageEnd: integer(1, 10000), cursor }, ['mode', 'pageStart', 'pageEnd']),
      object({ mode: { const: 'section', type: 'string' }, sectionId: string(100), cursor }, ['mode', 'sectionId']),
      object({ mode: { const: 'full', type: 'string' } }),
    ] } },
  { name: 'finish_reading', description: '结束查阅。只选择已读来源 C 编号和重要原文 quote（可用紧邻上下文消歧），或 source 表示整体已读资料。位置由软件映射，不填写页行坐标。工具结果会返回最终允许引用的 C 编号；本工具必须单独调用。',
    parameters: object({ mode: { type: 'string', enum: ['grounded', 'direct', 'insufficient'] },
      citationSelections: { type: 'array', maxItems: 12, items: selection }, answerOutline: { type: 'string', maxLength: 2000 } }) },
];
const ajv = new Ajv({ strict: true, allErrors: true, coerceTypes: false, useDefaults: false, removeAdditional: false });
export const DOCUMENT_TOOLS = Object.freeze(definitions.map((definition) => ({ type: 'function', function: definition })));
const validators = new Map(definitions.map((d) => [d.name, ajv.compile(d.parameters)]));

export function validateDocumentTool(name, input) {
  const validate = validators.get(name);
  if (!validate) throw new DocumentToolError('UNKNOWN_TOOL', '只能使用当前注册的文档工具。');
  requireCondition(validate(input), 'INVALID_TOOL_ARGUMENTS', '工具参数不符合结构要求。', {
    details: validate.errors?.slice(0, 8).map((e) => ({ path: e.instancePath, reason: e.message })) });
  if (name === 'finish_reading') {
    requireCondition(input.mode !== 'grounded' || input.citationSelections.length > 0, 'INVALID_TOOL_ARGUMENTS', '有依据回答至少选择一项来源。');
    requireCondition(input.mode !== 'direct' || input.citationSelections.length === 0, 'INVALID_TOOL_ARGUMENTS', '直接交流不选择论文证据。');
  }
  return input;
}

export function createDocumentTools({ source, store, maxReadChars = 16000, maxFullChars = 64000, maxTotalChars = 96000 }) {
  const view = source.view, cursors = new Map(), cache = new Map();
  let totalChars = 0, cacheHits = 0, scanChars = 0;
  function bounds(args) {
    const start = args.pageStart ?? 1, end = args.pageEnd ?? view.pageCount;
    requireCondition(start <= end && end <= view.pageCount, 'INVALID_PAGE_RANGE', `页范围须在 1-${view.pageCount} 内。`);
    return [view.pages[start - 1].start, view.pages[end - 1].end];
  }
  function continuation(name, args, position) {
    const token = randomUUID();
    const { cursor: _cursor, ...parameters } = args;
    cursors.set(token, { name, parameters: stableJson(parameters), position });
    return token;
  }
  function resume(name, args, fallback) {
    if (!args.cursor) return fallback;
    const saved = cursors.get(args.cursor);
    const { cursor: _cursor, ...parameters } = args;
    requireCondition(saved?.name === name && saved.parameters === stableJson(parameters), 'INVALID_CURSOR', '续读游标只适用于本次文档版本和相同工具参数。');
    return saved.position;
  }
  function addEvidenceRanges(ranges, maxResponseChars) {
    const textChars = ranges.reduce((sum, range) => sum + range.end - range.start, 0);
    requireCondition(totalChars + textChars <= maxTotalChars, 'DOCUMENT_BUDGET_EXHAUSTED', '本次资料预算已用尽，请依据已读资料结束。');
    // Reserve every preview's canonical text before allocating formatted copies.
    // LaTeX counts against both the response and run budgets, including its quote.
    let available = Math.max(0, Math.min(maxResponseChars - textChars, maxTotalChars - totalChars - textChars));
    totalChars += textChars;
    return ranges.map(({ start, end }) => {
      const item = store.publicItem(store.add(start, end), available);
      const used = (item.latexLines ?? []).reduce((sum, line) => sum + line.text.length + line.latex.length, 0);
      available -= used; totalChars += used;
      return item;
    });
  }
  function outline(args) {
    const offset = resume('get_document_outline', args, 0);
    const selected = view.sections.slice(offset, offset + 40);
    return { title: view.title, pageCount: view.pageCount, fullTextChars: view.text.length,
      fullTextReadable: view.text.length <= Math.min(maxFullChars, maxTotalChars - totalChars),
      sections: selected.map(({ sectionId, title, sectionPath, inferred, pageStart, pageEnd }) => ({ sectionId, title, sectionPath, inferred, pageStart, pageEnd })),
      missingTextPages: view.pages.filter((p) => p.missingText).map((p) => p.pageNumber),
      hasMore: offset + selected.length < view.sections.length,
      cursor: offset + selected.length < view.sections.length ? continuation('get_document_outline', args, offset + selected.length) : undefined };
  }
  function read(args) {
    let start, end;
    if (args.mode === 'full') {
      requireCondition(view.text.length <= maxFullChars && view.text.length <= maxTotalChars - totalChars, 'FULL_TEXT_TOO_LARGE', '全文超出剩余预算，请按目录章节或最多四页逐步阅读。');
      start = 0; end = view.text.length;
    } else if (args.mode === 'pages') {
      requireCondition(args.pageEnd - args.pageStart < 4, 'INVALID_PAGE_RANGE', '一次最多请求四页。');
      [start, end] = bounds(args);
    } else {
      const section = view.sections.find((s) => s.sectionId === args.sectionId);
      requireCondition(section, 'UNKNOWN_SECTION', '请使用本版本目录提供的 sectionId。');
      start = section.start; end = section.end;
    }
    const position = resume('read_document', args, start);
    let until = args.mode === 'full' ? end : Math.min(end, position + maxReadChars);
    if (until < end) {
      const boundary = view.text.lastIndexOf('\n', until);
      if (boundary > position) until = boundary + 1;
    }
    requireCondition(until > position, 'DOCUMENT_UNREADABLE', '当前范围没有可读正文。');
    const slice = view.text.slice(position, until);
    const evidence = slice.trim() ? addEvidenceRanges([{ start: position, end: until }], args.mode === 'full' ? maxFullChars : maxReadChars) : [];
    return { evidence, coverageStatus: until === end && position === start ? 'complete' : 'partial',
      hasMore: until < end, cursor: until < end ? continuation('read_document', args, until) : undefined,
      truncated: until < end, remainingChars: Math.max(0, maxTotalChars - totalChars) };
  }
  function search(args) {
    const [scopeStart, scopeEnd] = bounds(args);
    const position = resume('search_document_text', args, scopeStart);
    const limit = args.limit ?? 10;
    requireCondition(args.queries.every((q) => normalizeText(q)), 'INVALID_TOOL_ARGUMENTS', '搜索词不能为空。');
    // Scan bounded page windows. The cursor reports what was actually scanned;
    // no-match in this batch is never reported as absence from the whole paper.
    const end = Math.min(scopeEnd, position + 120000);
    const indexed = normalizeWithMap(view.text.slice(position, end), { caseFold: true });
    scanChars += end - position;
    const matches = [];
    for (const query of args.queries) {
      const words = normalizeText(query, { caseFold: true }).split(' ');
      const needles = args.matchMode === 'literal' ? [words.join(' ')] : words;
      for (const needle of needles) {
        let from = 0;
        const found = new Set();
        // Each needle contributes its earliest limit+1 distinct previews. That
        // is enough to merge the first page across queries without skipping a
        // later query or claiming an unscanned suffix is empty.
        while (from < indexed.text.length && found.size <= limit) {
          const hit = indexed.text.indexOf(needle, from);
          if (hit < 0) break;
          from = hit + 1;
          const start = position + indexed.starts[hit];
          const hitEnd = position + indexed.ends[hit + needle.length - 1];
          const line = view.lines.find((line) => line.start <= start && line.end >= start);
          const previewStart = Math.max(position, line?.start ?? start, start - 120);
          const previewEnd = Math.min(end, Math.max(previewStart + 400, hitEnd));
          if (args.matchMode === 'all_terms' && !needles.every((word) => normalizeText(view.text.slice(previewStart, previewEnd), { caseFold: true }).includes(word))) continue;
          if (!found.has(previewStart)) matches.push({ start: previewStart, end: previewEnd, query, hit: start, next: position + indexed.ends[hit] });
          found.add(previewStart);
        }
      }
    }
    const unique = [...new Map(matches.sort((a, b) => b.hit - a.hit).map((m) => [m.start, m])).values()].sort((a, b) => a.hit - b.hit);
    const selected = unique.slice(0, limit);
    requireCondition(totalChars + selected.reduce((sum, m) => sum + m.end - m.start, 0) <= maxTotalChars,
      'DOCUMENT_BUDGET_EXHAUSTED', '本次资料预算不足以返回这些预览，请缩小 limit 或结束。');
    const next = unique.length > limit ? selected.at(-1).next : end < scopeEnd ? Math.max(position + 1, end - 400) : end;
    return { evidence: addEvidenceRanges(selected, maxReadChars).map((item, index) => ({ ...item, matchedQuery: selected[index].query })),
      hasMore: next < scopeEnd, cursor: next < scopeEnd ? continuation('search_document_text', args, next) : undefined,
      scannedChars: end - position, scannedEntireScope: position === scopeStart && next === scopeEnd,
      note: '只有预览文字属于已读原文；必要时继续阅读正文。' };
  }
  return {
    get metrics() { return { returnedChars: totalChars, cacheHits, scanChars }; },
    async execute(name, args) {
      validateDocumentTool(name, args);
      await source.assertCurrent();
      if (name === 'finish_reading') {
        const prepared = resolveCitationSelections(store, args.citationSelections);
        return { ...prepared, mode: args.mode, answerOutline: args.answerOutline };
      }
      const key = stableJson([name, args]);
      if (cache.has(key)) { cacheHits++; return { ...cache.get(key), cacheHit: true }; }
      const data = name === 'get_document_outline' ? outline(args) : name === 'read_document' ? read(args) : search(args);
      cache.set(key, data);
      return { ...data, cacheHit: false };
    },
  };
}
