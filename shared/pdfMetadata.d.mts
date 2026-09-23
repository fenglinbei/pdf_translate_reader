export function cleanMetadataText(value: unknown): string;
export function parseMetadataAuthors(value: unknown): string[];
export function usablePdfTitle(value: unknown): string | undefined;
export function readEmbeddedMetadata(info?: { Title?: unknown; Author?: unknown }, metadata?: { get: (key: string) => unknown } | null): { title?: string; authors: string[] };
