import { normalizeMetadataValue } from "./metadata.mjs";

const cache = new Map();
let lastArxivRequest = 0;
const decodeXml = text => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n) => {
    const value = n[0].toLowerCase() === "x" ? parseInt(n.slice(1), 16) : Number(n);
    return value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
  }).replace(/&(amp|lt|gt|quot|apos);/g, (_, key) => ({amp:"&",lt:"<",gt:">",quot:'"',apos:"'"})[key]);
function tags(xml, name) {
  return [...xml.matchAll(new RegExp(`<(?:(?:[\\w-]+):)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:(?:[\\w-]+):)?${name}\\s*>`, "g"))].map(match => match[1]);
}

export function parseArxivMetadata(xml, requestedId) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("Invalid Atom response.");
  const entries = tags(xml, "entry");
  if (entries.length !== 1) return null;
  const entry = entries[0];
  const text = name => decodeXml(tags(entry, name)[0] ?? "").replace(/\s+/g, " ").trim();
  const id = text("id").replace(/^https?:\/\/(?:export\.)?arxiv\.org\/abs\//, "");
  if (id.replace(/v\d+$/, "") !== requestedId.replace(/v\d+$/, "") ||
    (/v\d+$/.test(requestedId) && id !== requestedId)) return null;
  return {
    title: text("title"), authors: tags(entry, "author").map(author => decodeXml(tags(author, "name")[0] ?? "")),
    publication_year: Number(text("published").slice(0, 4)),
    publication_venue: text("journal_ref") || "arXiv", doi: text("doi"), arxiv_id: id, abstract: text("summary"),
  };
}

export function parseCrossrefMetadata(payload, requestedDoi) {
  const item = payload?.message;
  if (item?.DOI?.toLowerCase() !== requestedDoi.toLowerCase()) return null;
  return {
    title: item.title?.[0],
    authors: item.author?.map(author => author.name || [author.given, author.family].filter(Boolean).join(" ")),
    publication_year: (item.published ?? item["published-print"] ?? item["published-online"])?.["date-parts"]?.[0]?.[0],
    publication_venue: item["container-title"]?.[0], doi: item.DOI,
    abstract: item.abstract ? decodeXml(item.abstract.replace(/<[^>]+>/g, " ")) : undefined,
  };
}

async function request(url, signal) {
  const response = await fetch(url, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    headers: { "User-Agent": "PDF-Translate-Reader/metadata (bibliographic lookup)", Accept: "application/json, application/atom+xml" },
    redirect: "error",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("Bibliographic lookup unavailable.");
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) throw new Error("Bibliographic response too large.");
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { await reader.cancel().catch(() => {}); }
}

async function cached(key, operation) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await operation();
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(key, { value, until: Date.now() + 6 * 60 * 60 * 1000 });
  return value;
}

export function lookupDoi(doi, signal) {
  const id = normalizeMetadataValue("doi", doi);
  if (!id) return Promise.resolve(null);
  return cached(`doi:${id}`, async () => {
    const body = await request(`https://api.crossref.org/works/${encodeURIComponent(id)}`, signal);
    return body ? parseCrossrefMetadata(JSON.parse(body), id) : null;
  });
}

export function lookupArxiv(arxivId, signal) {
  const id = normalizeMetadataValue("arxiv_id", arxivId);
  if (!id) return Promise.resolve(null);
  return cached(`arxiv:${id}`, async () => {
    const delay = Math.max(0, lastArxivRequest + 3100 - Date.now());
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    signal.throwIfAborted();
    lastArxivRequest = Date.now();
    const body = await request(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`, signal);
    return body ? parseArxivMetadata(body, id) : null;
  });
}
