import type { DocumentArtifact, NodeMapping } from './qaDocumentArtifact.mjs';
export type DocumentBuildInput = { pdfSha256: string; mmd: string; pageCount?: number; pages: Array<{
  pageIndex: number; pageWidth?: number; pageHeight?: number;
  lines: Array<{ lineIndex: number; text: string; region?: { x: number; y: number; width: number; height: number } }>;
}> };
export type PreparationCheckpoint = { version: 'document-preparation-v1'; revision: string; nextNode: number; mappings: NodeMapping[] };
export type PreparationProgress = { phase: 'structure' | 'mapping'; completed: number; total: number; revision: string };
export type DocumentBuildResult = { artifact: DocumentArtifact; stats: { tokenCount: number; suppressedAliases: number; probes: number; resumedNodes: number; nodes: number; regions: number; mappedChars: number; logicalChars: number; hasPageHints: boolean } };
export const DOCUMENT_BUILDER_VERSION: string;
export const DOCUMENT_MAPPING_VERSION: string;
export const PREPARATION_CHECKPOINT_VERSION: 'document-preparation-v1';
export function sha256Text(text: string): Promise<string>;
export function inspectDocumentInputs(input: DocumentBuildInput): Promise<{ revision: string }>;
export function buildDocumentArtifact(input: DocumentBuildInput, options?: { signal?: AbortSignal; checkpoint?: PreparationCheckpoint;
  loadCheckpoint?: (revision: string) => Promise<PreparationCheckpoint | undefined>;
  yieldControl?: () => Promise<unknown>; onProgress?: (progress: PreparationProgress) => void;
  onCheckpoint?: (checkpoint: PreparationCheckpoint) => Promise<unknown> }): Promise<DocumentBuildResult>;
