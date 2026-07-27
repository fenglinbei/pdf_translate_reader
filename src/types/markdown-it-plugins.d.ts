declare module "markdown-it-task-lists" {
  import type MarkdownIt from "markdown-it";

  export type MarkdownItTaskListOptions = {
    enabled?: boolean;
    label?: boolean;
    labelAfter?: boolean;
  };

  const taskLists: MarkdownIt.PluginWithOptions<MarkdownItTaskListOptions>;

  export default taskLists;
}

declare module "markdown-it-footnote" {
  import type MarkdownIt from "markdown-it";

  const footnote: MarkdownIt.PluginSimple;

  export default footnote;
}

declare module "markdown-it-texmath" {
  import type { KatexOptions } from "katex";
  import type MarkdownIt from "markdown-it";

  export type MarkdownItTexMathOptions = {
    delimiters?: string | string[];
    engine?: typeof import("katex");
    katexOptions?: KatexOptions;
    macros?: KatexOptions["macros"];
    outerSpace?: boolean;
  };

  type MarkdownItTexMathRule = {
    rex: RegExp;
  };

  const texmath: MarkdownIt.PluginWithOptions<MarkdownItTexMathOptions> & {
    rules: {
      beg_end: {
        block: MarkdownItTexMathRule[];
      };
    };
  };

  export default texmath;
}
