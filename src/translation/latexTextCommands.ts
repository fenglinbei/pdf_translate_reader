export const LATEX_TEXT_COMMAND_NAMES = [
  "em",
  "emph",
  "mbox",
  "sout",
  "text",
  "textbf",
  "textit",
  "textmd",
  "textnormal",
  "textrm",
  "textsc",
  "textsf",
  "textsl",
  "textsubscript",
  "textsuperscript",
  "texttt",
  "textup",
  "underline",
] as const;

export type LatexTextCommand = typeof LATEX_TEXT_COMMAND_NAMES[number];
