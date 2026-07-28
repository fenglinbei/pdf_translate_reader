export const KATEX_DISPLAY_ENVIRONMENTS = [
  "align",
  "align*",
  "alignat",
  "alignat*",
  "aligned",
  "alignedat",
  "array",
  "bmatrix",
  "bmatrix*",
  "Bmatrix",
  "Bmatrix*",
  "cases",
  "CD",
  "darray",
  "dcases",
  "drcases",
  "equation",
  "equation*",
  "gather",
  "gather*",
  "gathered",
  "matrix",
  "matrix*",
  "pmatrix",
  "pmatrix*",
  "rcases",
  "smallmatrix",
  "split",
  "subarray",
  "vmatrix",
  "vmatrix*",
  "Vmatrix",
  "Vmatrix*",
] as const;

const KATEX_DISPLAY_ENVIRONMENT_SOURCE = [...KATEX_DISPLAY_ENVIRONMENTS]
  .sort((left, right) => right.length - left.length)
  .map(escapeRegularExpression)
  .join("|");

export const KATEX_BEGIN_END_RULE = new RegExp(
  `(\\\\(?:begin)\\{(${KATEX_DISPLAY_ENVIRONMENT_SOURCE})\\}[\\s\\S]+?\\\\(?:end)\\{\\2\\})`,
  "gmy",
);

const KATEX_DISPLAY_ENVIRONMENT_START = new RegExp(
  `^\\\\begin\\{(?:${KATEX_DISPLAY_ENVIRONMENT_SOURCE})\\}`,
);

export function startsWithKatexDisplayEnvironment(input: string) {
  return KATEX_DISPLAY_ENVIRONMENT_START.test(input);
}

function escapeRegularExpression(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
