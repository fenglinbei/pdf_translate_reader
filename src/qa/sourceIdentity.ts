import type { QaCitation, QaRetrievedEvidence } from '../types/domain';
type Source = QaCitation | QaRetrievedEvidence;
export function qaSourceKey(value: Source): string | undefined {
  if ((value.sourceKind === 'document_text' || value.sourceKind === 'document_artifact')) return value.evidenceKey && value.sourceVersion
    ? `${value.cloudDocumentId}:${value.sourceVersion}:${value.evidenceKey}` : undefined;
  return value.chunkId ? `${value.cloudDocumentId}:${value.chunkId}` : undefined;
}
export function sameQaSource(left: Source, right: Source): boolean {
  const key = qaSourceKey(left);
  return Boolean(key && key === qaSourceKey(right));
}
