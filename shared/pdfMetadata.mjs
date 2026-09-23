export function cleanMetadataText(value) {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

export function usablePdfTitle(value) {
  const title = cleanMetadataText(value);
  return title && !/^(untitled|document\d*|microsoft (word|powerpoint).*|.*\.(docx?|tex))$/i.test(title)
    ? title : undefined;
}

export function parseMetadataAuthors(value) {
  const entries = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[;\n]+/u) : [];
  return entries.map(cleanMetadataText).filter(Boolean);
}

// XMP dc:creator is an ordered array. Commas are part of names (Doe, Jane),
// so only explicit list separators are split in the legacy Info.Author field.
export function readEmbeddedMetadata(info = {}, metadata) {
  const get = (key) => metadata?.get?.(key);
  const title = [get("dc:title"), get("title"), info.Title].map(usablePdfTitle).find(Boolean);
  const rawAuthors = [get("dc:creator"), get("author"), info.Author];
  let authors = [];
  for (const raw of rawAuthors) {
    authors = parseMetadataAuthors(raw);
    if (authors.length) break;
  }
  return { title, authors };
}
