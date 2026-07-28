import type MarkdownIt from "markdown-it";
import {
  findLatexListEnvironment,
  splitLatexListSegments,
  type LatexListMatch,
} from "./latexListParser";

export function markdownItLatexLists(md: MarkdownIt) {
  md.block.ruler.before(
    "paragraph",
    "latex_list_block",
    (state, startLine, endLine, silent) => {
      if (state.sCount[startLine] - state.blkIndent >= 4) {
        return false;
      }

      const start = state.bMarks[startLine] + state.tShift[startLine];
      const location = findLatexListEnvironment(
        state.src,
        start,
        state.eMarks[startLine],
      );

      if (!location) {
        return false;
      }

      const { list } = location;
      let closingLine = startLine;

      while (
        closingLine < endLine
        && state.eMarks[closingLine] < list.end
      ) {
        closingLine += 1;
      }

      if (closingLine >= endLine) {
        return false;
      }

      if (silent) {
        return true;
      }

      const leadingContent = state.src.slice(start, location.start).trim();

      if (leadingContent) {
        const paragraphOpen = state.push("paragraph_open", "p", 1);
        paragraphOpen.map = [startLine, startLine + 1];

        const inline = state.push("inline", "", 0);
        inline.content = leadingContent;
        inline.map = [startLine, startLine + 1];
        inline.children = [];

        state.push("paragraph_close", "p", -1);
      }

      const token = state.push("latex_list", "", 0);
      token.block = true;
      token.map = [startLine, closingLine + 1];
      token.meta = state.parentType === "blockquote"
        ? stripOneBlockquotePrefix(list)
        : list;

      const trailingContent = state.src
        .slice(list.end, state.eMarks[closingLine])
        .trim();

      if (trailingContent) {
        const paragraphOpen = state.push("paragraph_open", "p", 1);
        paragraphOpen.map = [closingLine, closingLine + 1];

        const inline = state.push("inline", "", 0);
        inline.content = trailingContent;
        inline.map = [closingLine, closingLine + 1];
        inline.children = [];

        state.push("paragraph_close", "p", -1);
      }

      state.line = closingLine + 1;
      return true;
    },
    { alt: ["paragraph"] },
  );

  md.core.ruler.before("inline", "latex_list_inline_blocks", (state) => {
    const createToken = (
      type: string,
      tag: string,
      nesting: -1 | 0 | 1,
      block = true,
    ) => {
      const token = new state.Token(type, tag, nesting);
      token.block = block;
      return token;
    };
    const createInlineToken = (content: string) => {
      const token = createToken("inline", "", 0, false);
      token.children = [];
      token.content = content;
      return token;
    };
    const expandList = (list: LatexListMatch) => {
      const expanded: typeof state.tokens = [];
      const className =
        `free-translation-latex-list free-translation-latex-list--${list.environment}`;

      if (list.environment === "description") {
        const listOpen = createToken("latex_description_open", "dl", 1);
        listOpen.attrSet("class", className);
        expanded.push(listOpen);

        for (const item of list.items) {
          const itemOpen = createToken(
            "latex_description_item_open",
            "div",
            1,
          );
          itemOpen.attrSet(
            "class",
            "free-translation-latex-description-item",
          );
          expanded.push(itemOpen);

          const markerOpen = createToken(
            "latex_description_term_open",
            "dt",
            1,
          );
          markerOpen.attrSet(
            "class",
            [
              "free-translation-latex-description-term",
              item.customMarker && item.marker
                ? ""
                : "free-translation-latex-description-term--empty",
            ].filter(Boolean).join(" "),
          );
          if (!item.customMarker || !item.marker) {
            markerOpen.attrSet("aria-hidden", "true");
          }
          expanded.push(markerOpen);
          if (item.customMarker && item.marker) {
            expanded.push(createInlineToken(item.marker));
          }
          expanded.push(
            createToken("latex_description_term_close", "dt", -1),
          );

          const contentOpen = createToken(
            "latex_description_content_open",
            "dd",
            1,
          );
          contentOpen.attrSet("class", "free-translation-latex-list-content");
          expanded.push(contentOpen);
          md.block.parse(item.content, md, state.env, expanded);
          expanded.push(
            createToken("latex_description_content_close", "dd", -1),
            createToken("latex_description_item_close", "div", -1),
          );
        }

        expanded.push(
          createToken("latex_description_close", "dl", -1),
        );
        return expanded;
      }

      const tag = list.environment === "enumerate" ? "ol" : "ul";
      const listOpen = createToken("latex_list_open", tag, 1);
      listOpen.attrSet("class", className);
      expanded.push(listOpen);

      for (const item of list.items) {
        const itemOpen = createToken("latex_list_item_open", "li", 1);
        itemOpen.attrSet(
          "class",
          [
            "free-translation-latex-list-item",
            item.customMarker
              ? "free-translation-latex-list-item--custom-marker"
              : "",
          ].filter(Boolean).join(" "),
        );
        expanded.push(itemOpen);

        if (item.customMarker) {
          const markerOpen = createToken(
            "latex_list_marker_open",
            "span",
            1,
            false,
          );
          markerOpen.attrSet(
            "class",
            "free-translation-latex-list-marker",
          );
          expanded.push(markerOpen);
          if (item.marker) {
            expanded.push(createInlineToken(item.marker));
          }
          expanded.push(
            createToken("latex_list_marker_close", "span", -1, false),
          );
        }

        const contentOpen = createToken(
          "latex_list_content_open",
          "div",
          1,
        );
        contentOpen.attrSet("class", "free-translation-latex-list-content");
        expanded.push(contentOpen);
        md.block.parse(item.content, md, state.env, expanded);
        expanded.push(
          createToken("latex_list_content_close", "div", -1),
          createToken("latex_list_item_close", "li", -1),
        );
      }

      expanded.push(createToken("latex_list_close", tag, -1));
      return expanded;
    };
    let index = 0;

    while (index < state.tokens.length) {
      const currentToken = state.tokens[index];

      if (currentToken.type === "latex_list") {
        state.tokens.splice(
          index,
          1,
          ...expandList(currentToken.meta as LatexListMatch),
        );
        continue;
      }

      if (index < 1 || index >= state.tokens.length - 1) {
        index += 1;
        continue;
      }

      const paragraphOpen = state.tokens[index - 1];
      const inline = currentToken;
      const paragraphClose = state.tokens[index + 1];

      if (
        paragraphOpen.type !== "paragraph_open"
        || inline.type !== "inline"
        || paragraphClose.type !== "paragraph_close"
      ) {
        index += 1;
        continue;
      }

      const segments = splitLatexListSegments(inline.content);

      if (!segments.some((segment) => segment.kind === "list")) {
        index += 1;
        continue;
      }

      const replacements = segments.flatMap((segment) => {
        if (segment.kind === "list") {
          const listToken = new state.Token("latex_list", "", 0);
          listToken.block = true;
          listToken.level = inline.level;
          listToken.map = inline.map;
          listToken.meta = segment.list;
          return [listToken];
        }

        const content = segment.text.trim();

        if (!content) {
          return [];
        }

        const openToken = new state.Token(
          paragraphOpen.type,
          paragraphOpen.tag,
          paragraphOpen.nesting,
        );
        Object.assign(openToken, paragraphOpen);
        openToken.attrs = paragraphOpen.attrs?.map((attribute) => [...attribute])
          ?? null;

        const inlineToken = new state.Token(
          inline.type,
          inline.tag,
          inline.nesting,
        );
        Object.assign(inlineToken, inline);
        inlineToken.attrs = inline.attrs?.map((attribute) => [...attribute])
          ?? null;
        inlineToken.children = [];
        inlineToken.content = content;

        const closeToken = new state.Token(
          paragraphClose.type,
          paragraphClose.tag,
          paragraphClose.nesting,
        );
        Object.assign(closeToken, paragraphClose);
        closeToken.attrs = paragraphClose.attrs?.map((attribute) => [
          ...attribute,
        ]) ?? null;

        return [openToken, inlineToken, closeToken];
      });

      state.tokens.splice(index - 1, 3, ...replacements);
      index = Math.max(0, index - 1);
    }
  });
}

function stripOneBlockquotePrefix(list: LatexListMatch): LatexListMatch {
  const stripPrefix = (input: string) => input
    .replace(/^[ \t]*>[ \t]?/, "")
    .replace(/\n[ \t]*>[ \t]?/g, "\n");

  return {
    ...list,
    items: list.items.map((item) => ({
      ...item,
      content: stripPrefix(item.content),
      marker: stripPrefix(item.marker),
    })),
  };
}
