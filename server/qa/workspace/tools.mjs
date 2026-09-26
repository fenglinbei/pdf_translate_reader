import Ajv from 'ajv';
import { randomUUID } from 'node:crypto';
import { createDeferredDocumentSource } from '../documents/source.mjs';
import { createDocumentTools } from '../documents/tools.mjs';
import { createEvidenceStore } from '../documents/view.mjs';
import { resolveCitationSelections } from '../documents/citations.mjs';
import { requireCondition, DocumentToolError } from '../documents/errors.mjs';
import { discoverWorkspaceDocuments } from './repository.mjs';

const str = (maxLength = 100) => ({ type: 'string', minLength: 1, maxLength });
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const page = { type: 'integer', minimum: 1, maximum: 10000 };
const definitions = [
  { name: 'discover_documents', description: '按需查找工作区文档。空查询列出最近打开的文档；query 按标题、文件名、摘要包含的文字筛选。返回已有摘要、可读状态及当前文章标记。当前文章单独返回，可能不匹配查询。摘要和目录不能作为正文引用。普通交流无需调用。',
    parameters: object({ query: { type: 'string', maxLength: 200 }, archived: { type: 'string', enum: ['all', 'only', 'exclude'] }, cursor: str() }) },
  { name: 'document_outline', description: '查看所选文章的章节和页范围。document 使用发现结果的文档编号，current 表示提问时打开的文章。续页只需传 cursor。',
    parameters: object({ document: str(), cursor: str() }) },
  { name: 'search_document', description: '在选定的一至四篇文章中按原文词语查找，返回可继续阅读的来源。支持提出同义词；未命中不证明全文不存在。续页只需 cursor。',
    parameters: object({ documents: { type: 'array', minItems: 1, maxItems: 4, uniqueItems: true, items: str() }, queries: { type: 'array', minItems: 1, maxItems: 4, items: str(200) }, cursor: str() }) },
  { name: 'read_document', description: '阅读文章全文、某个 section 或包含起止页的范围（最多四页）。只传 document 尝试全文，太长时按目录分段。也可只传 source 补读某个搜索来源所在页，或只传 cursor 续读。结果中的来源编号表示实际读到的文字；hasMore 为 true 时尚未读完。',
    parameters: object({ document: str(), section: str(), pageStart: page, pageEnd: page, source: str(), cursor: str() }) },
  { name: 'cite_sources', description: '标记已读资料中重要的原文，返回回答可用的 [C编号]。sources 使用阅读结果的来源编号；quote 可逐字复制连续原文，省略则引用这些来源的整体范围。重复句可用紧邻的 contextBefore/After 消歧。位置自动映射，不填写章节或行坐标。成功后仍可继续阅读和追加引用。',
    parameters: object({ selections: { type: 'array', minItems: 1, maxItems: 12, items: object({ sources: { type: 'array', minItems: 1, maxItems: 16, uniqueItems: true, items: { type: 'string', pattern: '^R[1-9][0-9]*$' } }, quote: str(2000), contextBefore: str(500), contextAfter: str(500) }, ['sources']) } }, ['selections']) },
];
export const WORKSPACE_TOOLS = Object.freeze(definitions.map(fn => ({ type: 'function', function: fn })));
const ajv = new Ajv({ strict: true, allErrors: true });
const validators = new Map(definitions.map(fn => [fn.name, ajv.compile(fn.parameters)]));
export function validateWorkspaceTool(name, input) {
  const validate = validators.get(name);
  requireCondition(validate, 'UNKNOWN_TOOL', '请使用提供的问答工具。');
  requireCondition(validate(input), 'INVALID_TOOL_ARGUMENTS', '请检查工具参数。', { details: validate.errors?.map(e => ({ path: e.instancePath, reason: e.message })).slice(0, 8) });
  if (input.cursor) requireCondition(Object.keys(input).length === 1, 'INVALID_TOOL_ARGUMENTS', '续读只需传 cursor，不再重复其他参数。');
  return input;
}

export function createWorkspaceTools({ userId, activeDocumentId, signal, loadSource = createDeferredDocumentSource, discover = discoverWorkspaceDocuments }) {
  const documents = new Map(), ids = new Map(), readers = new Map(), sources = new Map(), sourceKeys = new Map(), cursors = new Map(), selected = new Map();
  let discoveryCalls = 0;
  function documentRef(id) {
    if (!ids.has(id)) { const ref = `D${ids.size + 1}`; ids.set(id, ref); documents.set(ref, id); }
    return ids.get(id);
  }
  if (activeDocumentId) documents.set('current', activeDocumentId);
  function documentId(ref) {
    const id = documents.get(ref);
    requireCondition(id, 'UNKNOWN_DOCUMENT', '请使用发现结果的文档编号；只有打开云端文章时 current 才可用。');
    return id;
  }
  async function reader(ref) {
    const id = documentId(ref);
    if (!readers.has(id)) {
      const source = await loadSource({ userId, userDocumentId: id }, { signal });
      const store = createEvidenceStore(source.view);
      readers.set(id, { source, store, tools: createDocumentTools({ source, store }), document: documentRef(id), id });
    }
    return readers.get(id);
  }
  function continuation(name, args) {
    const cursor = randomUUID(); cursors.set(cursor, { name, args }); return cursor;
  }
  function projectEvidence(r, item) {
    const key = `${r.id}:${item.evidenceId}`;
    if (!sourceKeys.has(key)) {
      const ref = `R${sources.size + 1}`;
      sources.set(ref, { reader: r, id: item.evidenceId }); sourceKeys.set(key, ref);
    }
    const { evidenceId, ...rest } = item;
    return { source: sourceKeys.get(key), document: r.document, ...rest };
  }
  async function executeReading(name, args) {
    const r = await reader(args.document);
    const data = await r.tools.execute(name, args.parameters);
    requireCondition(metrics().returnedChars <= 96000, 'DOCUMENT_BUDGET_EXHAUSTED', '本次已读资料达到上限，请依据现有资料回答。');
    const { cursor, evidence, remainingChars: _remaining, ...rest } = data;
    const tool = name === 'get_document_outline' ? 'document_outline' : name === 'search_document_text' ? 'search_document' : 'read_document';
    return { ...rest, document: r.document, ...(evidence ? { evidence: evidence.map(item => projectEvidence(r, item)) } : {}),
      ...(cursor ? { cursor: continuation(tool, { document: args.document, parameters: { ...args.parameters, cursor }, internal: true }) } : {}) };
  }
  function metrics() {
    const totals = { returnedChars: 0, scanChars: 0, cacheHits: 0, documentsRead: readers.size, discoveryCalls };
    for (const r of readers.values()) for (const key of ['returnedChars', 'scanChars', 'cacheHits']) totals[key] += r.tools.metrics[key];
    return totals;
  }
  async function execute(name, input) {
    signal?.throwIfAborted(); validateWorkspaceTool(name, input);
    let args = input;
    if (input.cursor) {
      const saved = cursors.get(input.cursor);
      requireCondition(saved?.name === name, 'INVALID_CURSOR', '请使用这个工具在本次问答中返回的 cursor。');
      args = saved.args;
    }
    if (name === 'discover_documents') {
      discoveryCalls++;
      const result = await discover({ userId, currentDocumentId: activeDocumentId, query: args.query, archived: args.archived, offset: args.offset ?? 0, limit: 10 });
      const project = ({ id, ...card }) => ({ document: documentRef(id), ...card });
      return { documents: result.documents.map(project), currentDocument: result.currentDocument ? project(result.currentDocument) : null,
        hasMore: result.hasMore, ...(result.hasMore ? { cursor: continuation(name, { ...args, offset: result.nextOffset }) } : {}) };
    }
    if (name === 'cite_sources') {
      // Stage every selection across documents before publishing any new citation.
      const staged = [];
      for (const [index, selection] of args.selections.entries()) {
        const items = selection.sources.map(ref => sources.get(ref));
        requireCondition(items.every(Boolean), 'UNKNOWN_EVIDENCE', `第 ${index + 1} 项包含尚未读过的来源。`);
        const r = items[0].reader;
        requireCondition(items.every(item => item.reader === r), 'CROSS_DOCUMENT_QUOTE', '单项引用必须来自同一篇文章；请分为多个 selections。');
        await r.source.assertCurrent();
        try {
          const result = resolveCitationSelections(r.store, [{ kind: selection.quote ? 'quote' : 'source', sourceEvidenceIds: items.map(item => item.id),
            ...(selection.quote ? { quote: selection.quote, contextBefore: selection.contextBefore, contextAfter: selection.contextAfter } : {}) }]);
          staged.push({ index, citation: result.citations[0], document: r.document });
        } catch (error) {
          // Local C identifiers are private to a document store; only R identifiers are model-visible.
          throw new DocumentToolError(error.code ?? 'INVALID_CITATION', `第 ${index + 1} 项：${error.details?.failedSelections?.[0]?.message ?? error.message}`, {
            details: { selectionIndex: index, sources: selection.sources, reason: error.details?.failedSelections?.[0]?.reason } });
        }
      }
      const citations = staged.map(({ index, citation, document }) => {
        const key = `${citation.cloudDocumentId}:${citation.evidenceKey}`;
        if (!selected.has(key)) selected.set(key, { ...citation, evidenceId: `C${selected.size + 1}` });
        const saved = selected.get(key);
        return { selectionIndex: index, citation: saved.evidenceId, document, quote: saved.quotedText, scope: saved.sectionPath.join(' / ') };
      });
      return { citations };
    }
    const legacyName = name === 'document_outline' ? 'get_document_outline' : name === 'search_document' ? 'search_document_text' : 'read_document';
    if (args.internal) return executeReading(legacyName, args);
    if (name === 'search_document') {
      requireCondition(args.documents?.length && args.queries?.length, 'INVALID_TOOL_ARGUMENTS', '请提供 documents 和 queries，或只传 cursor。');
      const results = [];
      for (const document of args.documents) results.push(await executeReading(legacyName, { document, parameters: { queries: args.queries, matchMode: 'literal', limit: 6 } }));
      return { results };
    }
    if (name === 'document_outline') {
      requireCondition(args.document, 'INVALID_TOOL_ARGUMENTS', '请提供 document，或只传 cursor。');
      return executeReading(legacyName, { document: args.document, parameters: {} });
    }
    if (args.source) {
      requireCondition(Object.keys(args).length === 1, 'INVALID_TOOL_ARGUMENTS', '补读来源时只需 source。');
      const item = sources.get(args.source);
      requireCondition(item, 'UNKNOWN_EVIDENCE', '请使用本次已读来源编号。');
      const range = item.reader.store.byId.get(item.id);
      return executeReading(legacyName, { document: item.reader.document, parameters: { mode: 'pages', pageStart: range.pageStart, pageEnd: Math.min(range.pageEnd, range.pageStart + 3) } });
    }
    requireCondition(args.document && !(args.section && (args.pageStart || args.pageEnd)) && Boolean(args.pageStart) === Boolean(args.pageEnd),
      'INVALID_TOOL_ARGUMENTS', '请提供 document，可选 section 或同时提供 pageStart、pageEnd。');
    return executeReading(legacyName, { document: args.document, parameters: args.section ? { mode: 'section', sectionId: args.section }
      : args.pageStart ? { mode: 'pages', pageStart: args.pageStart, pageEnd: args.pageEnd } : { mode: 'full' } });
  }
  // UI provenance is projected from harness-owned locations, never requested
  // from the model and never added to the tool messages in its context.
  function describeActivity(name, input = {}, result) {
    const args = input?.cursor ? cursors.get(input.cursor)?.args ?? {} : input ?? {};
    const data = result?.ok ? result.data : undefined;
    const locations = [];
    const add = (r, item = {}) => {
      if (!r) return;
      locations.push({ documentId: r.id, title: r.source.view.title.slice(0, 240),
        ...(item.pageStart ? { pageStart: item.pageStart, pageEnd: item.pageEnd } : {}),
        ...(item.sectionPath?.length ? { sectionPath: item.sectionPath.slice(0, 8) } : {}) });
    };
    for (const group of data?.results ?? (data ? [data] : [])) {
      for (const item of group.evidence ?? []) {
        const ref = sources.get(item.source);
        if (ref) add(ref.reader, ref.reader.store.byId.get(ref.id));
      }
      if (!group.evidence?.length && group.document) add(readers.get(documents.get(group.document)));
    }
    for (const item of data?.citations ?? []) {
      const citation = [...selected.values()].find(c => c.evidenceId === item.citation);
      if (citation) add(readers.get(citation.cloudDocumentId), citation);
    }
    const found = [data?.currentDocument, ...(data?.documents ?? [])].filter(Boolean);
    for (const card of found) locations.push({ documentId: documents.get(card.document), title: String(card.title || card.fileName || card.document).slice(0, 240), current: Boolean(card.isCurrent) });
    // Before completion these are requested ranges, not a claim of having read them.
    if (!locations.length && !result) for (const ref of Array.isArray(args.documents) ? args.documents : [args.document]) {
      const r = readers.get(documents.get(ref));
      const params = args.parameters ?? args;
      if (r) add(r, params.section || params.sectionId ? r.source.view.sections.find(s => s.sectionId === (params.section || params.sectionId)) : params);
    }
    const unique = [...new Map(locations.map(item => [JSON.stringify(item), item])).values()];
    return { version: 1, operation: name, locations: unique.slice(0, 12), totalLocations: unique.length,
      query: typeof args.query === 'string' ? args.query.slice(0, 200) : [args.queries, args.parameters?.queries].filter(Array.isArray).flat().filter(item => typeof item === 'string').join(' / ').slice(0, 800) || undefined,
      hasMore: Boolean(data?.hasMore || data?.results?.some(r => r.hasMore)),
      ...(data?.documents ? { resultCount: data.documents.length } : {}),
      ...(data?.citations ? { citationCount: data.citations.length } : {}) };
  }
  return { execute, describeActivity, get metrics() { return metrics(); }, get citations() { return [...selected.values()]; },
    async assertCurrent() { for (const r of readers.values()) await r.source.assertCurrent(); } };
}
