import { DocumentToolError, requireCondition } from './errors.mjs';
import { describeRange, mergeCoverage, normalizeText, normalizeWithMap } from './view.mjs';

export function resolveCitationSelections(store, selections, { selectionOrigin } = {}) {
  const view = store.view;
  // Stage all matches before assigning identifiers: failed finish calls are atomic.
  const failures = [];
  const resolved = selections.map((selection, selectionIndex) => {
    try {
      const sources = selection.sourceEvidenceIds.map((id) => {
        const source = store.byId.get(id);
        requireCondition(source, 'UNKNOWN_EVIDENCE', `来源 ${id} 不属于本次已读资料。`);
        return source;
      });
      const coverage = mergeCoverage(sources);
      let start, end;
      let kind = selection.kind === 'source' ? 'range' : 'lines';
      if (selection.kind === 'source') {
        requireCondition(coverage.length === 1, 'CITATION_OUTSIDE_READ_SCOPE', '资料存在未读缺口，请分别引用或补读。');
        ({ start, end } = coverage[0]);
        const fullSection = view.sections.filter((s) => s.start === start && s.end === end).sort((a, b) => b.level - a.level)[0];
        if (fullSection) kind = 'section';
      } else {
        const needle = normalizeText(selection.quote);
        const before = selection.contextBefore === undefined ? undefined : normalizeText(selection.contextBefore);
        const after = selection.contextAfter === undefined ? undefined : normalizeText(selection.contextAfter);
        requireCondition(needle && before !== '' && after !== '', 'INVALID_TOOL_ARGUMENTS', '摘录及已提供的上下文不能为空。');
        const candidates = new Map();
        let textMatches = 0;
        for (const interval of coverage) {
          const indexed = normalizeWithMap(view.text.slice(interval.start, interval.end));
          let from = 0;
          while (from < indexed.text.length) {
            const index = indexed.text.indexOf(needle, from);
            if (index < 0) break;
            textMatches++;
            from = index + 1;
            const prefix = indexed.text.slice(0, index).trimEnd();
            const suffix = indexed.text.slice(index + needle.length).trimStart();
            if ((before && !prefix.endsWith(before)) || (after && !suffix.startsWith(after))) continue;
            const matchStart = interval.start + indexed.starts[index];
            const matchEnd = interval.start + indexed.ends[index + needle.length - 1];
            const contextStart = before ? interval.start + indexed.starts[index - (indexed.text.slice(0, index).length - prefix.length) - before.length] : matchStart;
            const contextEnd = after ? interval.start + indexed.ends[index + needle.length + (indexed.text.slice(index + needle.length).length - suffix.length) + after.length - 1] : matchEnd;
            candidates.set(`${matchStart}:${matchEnd}`, { start: matchStart, end: matchEnd, contextStart, contextEnd });
          }
        }
        requireCondition(candidates.size, 'QUOTE_NOT_FOUND', textMatches
          ? '摘录存在，但提供的紧邻上下文不匹配；请复制实际紧邻原文，或在摘录唯一时省略上下文。'
          : '摘录不在指定的已读来源 text 中；请检查来源编号，并逐字复制连续原文或补读。',
        { details: { reason: textMatches ? 'context_mismatch' : 'quote_text_not_found', textMatches } });
        if (candidates.size !== 1) {
          throw new DocumentToolError('AMBIGUOUS_QUOTE', '原文出现多次，请缩小来源或补充紧邻的已读上下文。', {
            details: { candidates: [...candidates.values()].slice(0, 3).map((match) => {
              const interval = coverage.find((r) => r.start <= match.start && r.end >= match.end);
              return { sourceEvidenceIds: sources.filter((s) => s.start < match.end && s.end > match.start).map((s) => s.evidenceId),
                contextBefore: view.text.slice(Math.max(interval.start, match.start - 100), match.start),
                contextAfter: view.text.slice(match.end, Math.min(interval.end, match.end + 100)) };
            }) },
          });
        }
        const match = [...candidates.values()][0];
        ({ start, end } = match);
        requireCondition(sources.every((s) => s.start < match.contextEnd && s.end > match.contextStart), 'CITATION_OUTSIDE_READ_SCOPE', '来源集合包含与摘录及上下文无关的资料。');
      }
      const location = describeRange(view, start, end, kind);
      return { start, end, kind, location, sourceEvidenceKeys: [...new Set(sources.map((s) => s.evidenceKey))],
        selectionOrigin: selectionOrigin ?? (selection.kind === 'quote' ? 'model_quote' : 'model_source') };
    } catch (error) {
      if (!(error instanceof DocumentToolError)) throw error;
      failures.push({ selectionIndex, sourceEvidenceIds: selection.sourceEvidenceIds, code: error.code,
        message: error.message, ...error.details });
      return undefined;
    }
  });
  if (failures.length) {
    throw new DocumentToolError(failures[0].code,
      `第 ${failures.map((f) => f.selectionIndex + 1).join('、')} 项引用未通过。保留已通过项，仅修改失败项后重新完整提交。`,
      { details: { failedSelections: failures,
        matchedSelectionIndexes: resolved.flatMap((match, index) => match ? [index] : []), totalSelections: selections.length } });
  }
  const byKey = new Map();
  const selectionMap = [];
  for (const [selectionIndex, match] of resolved.entries()) {
    const evidence = store.add(match.start, match.end);
    let citation = byKey.get(evidence.evidenceKey);
    if (!citation) {
      const quote = view.text.slice(match.start, match.end);
      const fullSection = match.kind === 'section' ? view.sections.filter((s) => s.start === match.start && s.end === match.end).sort((a, b) => b.level - a.level)[0] : undefined;
      citation = { ...evidence, ...match.location, kind: match.kind,
        sectionPath: fullSection?.sectionPath ?? match.location.sectionPath,
        sourceEvidenceKeys: match.sourceEvidenceKeys, quotedText: quote.slice(0, 700), quoteTruncated: quote.length > 700,
        selectionOrigin: match.selectionOrigin, confidence: 'verified',
        sourceLocator: { version: 'citation-locator-v1', kind: match.kind, sourceSpans: match.location.sourceSpans,
          sectionId: fullSection?.sectionId, viewVersion: view.viewVersion, anchor: match.location.anchor,
          locationPrecision: match.location.locationPrecision, missingRegionRanges: match.location.missingRegionRanges,
          selectionOrigin: match.selectionOrigin, sourceEvidenceKeys: match.sourceEvidenceKeys, quoteTruncated: quote.length > 700 } };
      citation.sourceLocator.sourceUpdatedAt = view.sourceUpdatedAt;
      byKey.set(evidence.evidenceKey, citation);
    } else {
      citation.sourceEvidenceKeys = [...new Set([...citation.sourceEvidenceKeys, ...match.sourceEvidenceKeys])];
      citation.sourceLocator.sourceEvidenceKeys = citation.sourceEvidenceKeys;
    }
    selectionMap.push({ selectionIndex, evidenceId: evidence.evidenceId });
  }
  const citations = [...byKey.values()];
  return { citations, allowedCitationIds: citations.map((c) => c.evidenceId), selectionMap,
    resolvedCitations: citations.map((c) => ({ evidenceId: c.evidenceId, quotedText: c.quotedText,
      quoteTruncated: c.quoteTruncated, kind: c.kind, scopeLabel: c.sectionPath.join(' / ') || '已读原文', locationPrecision: c.locationPrecision })) };
}

export function verifyDocumentAnswer(answer, prepared) {
  const mentioned = [...new Set([...answer.matchAll(/\[C(\d+)\]/g)].map((m) => `C${Number(m[1])}`))];
  const allowed = new Set(prepared.allowedCitationIds);
  const rejected = mentioned.filter((id) => !allowed.has(id)).map((evidenceId) => ({ confidence: 'rejected', evidenceId, reason: 'citation_not_selected' }));
  const citations = prepared.citations.filter((c) => mentioned.includes(c.evidenceId));
  const warnings = [];
  if (rejected.length) warnings.push('回答包含未通过本次引用选择的编号，相关编号不能定位。');
  if (prepared.mode === 'grounded' && !citations.length) warnings.push('回答未引用已选择的原文。');
  if (prepared.mode === 'direct' && mentioned.length) warnings.push('直接交流不应包含论文引用。');
  return { citations, rejected, warnings, valid: warnings.length === 0 };
}
