export const MATHPIX_TEXT_SOURCE = "mathpix-v3-pdf" as const;

export const MATHPIX_PARSE_OPTIONS = {
  enable_tables_fallback: true,
  idiomatic_eqn_arrays: true,
  include_equation_tags: true,
  include_page_breaks: true,
  include_page_info: false,
  math_display_delimiters: ["\\[", "\\]"],
  math_inline_delimiters: ["\\(", "\\)"],
  rm_fonts: false,
  rm_spaces: true,
  streaming: false,
} as const;

export const MATHPIX_OPTIONS_HASH = `mathpix-v3-pdf-${hashStableJson(MATHPIX_PARSE_OPTIONS)}`;

export function getMathpixParseOptions() {
  return MATHPIX_PARSE_OPTIONS;
}

function hashStableJson(value: unknown) {
  const text = JSON.stringify(sortJson(value));
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, childValue]) => [key, sortJson(childValue)]),
  );
}
