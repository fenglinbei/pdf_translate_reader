import type { SentenceRange } from "./sentenceBoundary";

export const DEFAULT_CONTEXT_WINDOW_SIZE = 2;

export type ContextWindow = {
  after: string[];
  before: string[];
};

export function getContextWindow(
  sentences: SentenceRange[],
  targetIndex: number,
  windowSize = DEFAULT_CONTEXT_WINDOW_SIZE,
): ContextWindow {
  const before = sentences
    .slice(Math.max(0, targetIndex - windowSize), targetIndex)
    .map((sentence) => sentence.normalized);
  const after = sentences
    .slice(targetIndex + 1, targetIndex + 1 + windowSize)
    .map((sentence) => sentence.normalized);

  return { after, before };
}
