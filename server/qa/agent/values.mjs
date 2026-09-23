export function truncateForController(value, maxCharacters) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();

  if (text.length <= maxCharacters) {
    return text;
  }

  return `${text.slice(0, maxCharacters - 3).trim()}...`;
}

export function uniqueStrings(values) {
  return Array.from(new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean)));
}

export function getEnvInteger(name, fallback) {
  return normalizePositiveInteger(process.env[name], fallback);
}

export function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
