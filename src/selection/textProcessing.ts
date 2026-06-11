const DOCUMENT_ENVIRONMENTS = new Set(["abstract", "document"]);
const UNWRAP_COMMANDS = new Set(["title"]);

export function cleanExtractedText(value: string | undefined) {
  return normalizeExtractedWhitespace(removeDocumentMarkup(value ?? ""));
}

export function cleanOptionalExtractedText(value: string | undefined) {
  const cleaned = cleanExtractedText(value);

  return cleaned.length > 0 ? cleaned : undefined;
}

type ExtractTextOptions = {
  fallbackToInput?: boolean;
};

export function extractTitleText(
  value: string | undefined,
  options: ExtractTextOptions = {},
) {
  const input = value ?? "";
  const titleArgument = extractLatexCommandArgument(input, "title");

  return cleanOptionalExtractedText(
    titleArgument ?? (options.fallbackToInput === false ? undefined : input),
  );
}

export function extractAbstractText(
  value: string | undefined,
  options: ExtractTextOptions = {},
) {
  const input = value ?? "";
  const abstractBody =
    extractLatexEnvironmentBody(input, "abstract") ??
    extractLooseEnvironmentBody(input, "abstract");

  return cleanOptionalExtractedText(
    abstractBody ?? (options.fallbackToInput === false ? undefined : input),
  );
}

function removeDocumentMarkup(value: string) {
  let output = value.replace(/\r\n?/g, "\n");

  output = replaceCommandArguments(output, UNWRAP_COMMANDS, (argument) => ` ${argument} `);
  output = replaceDocumentEnvironments(output);
  output = output.replace(
    /\\(?:documentclass|usepackage|date|author)(?:\[[^\]]*])?\s*\{[^{}]*}/gi,
    " ",
  );
  output = output.replace(/\\(?:begin|end)\s*\{\s*(abstract|document)\s*}/gi, " ");
  output = output.replace(/(?:^|[\s/])(?:begin|end)\s*\{\s*(abstract|document)\s*}/gi, " ");
  output = output.replace(/\\(?:title)\s*\{?/gi, " ");
  output = output.replace(/\\maketitle\b/gi, " ");

  return output;
}

function replaceDocumentEnvironments(value: string) {
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    const match = /\\(begin|end)\s*\{\s*([A-Za-z*]+)\s*}/gi.exec(value.slice(cursor));

    if (!match || match.index < 0) {
      output += value.slice(cursor);
      break;
    }

    const markerStart = cursor + match.index;
    const markerEnd = markerStart + match[0].length;
    const kind = match[1].toLowerCase();
    const environmentName = match[2].replace(/\*$/, "").toLowerCase();

    output += value.slice(cursor, markerStart);

    if (!DOCUMENT_ENVIRONMENTS.has(environmentName)) {
      output += match[0];
      cursor = markerEnd;
      continue;
    }

    if (kind === "end") {
      output += " ";
      cursor = markerEnd;
      continue;
    }

    const environmentEnd = findEnvironmentEnd(value, environmentName, markerEnd);

    if (!environmentEnd) {
      output += " ";
      cursor = markerEnd;
      continue;
    }

    const body = value.slice(markerEnd, environmentEnd.start);
    output += ` ${body} `;
    cursor = environmentEnd.end;
  }

  return output;
}

function replaceCommandArguments(
  value: string,
  commands: Set<string>,
  replace: (argument: string, commandName: string) => string,
) {
  let output = "";
  let cursor = 0;

  while (cursor < value.length) {
    const match = /\\([A-Za-z]+)\s*\{/g.exec(value.slice(cursor));

    if (!match || match.index < 0) {
      output += value.slice(cursor);
      break;
    }

    const commandStart = cursor + match.index;
    const commandName = match[1].toLowerCase();
    const argumentStart = commandStart + match[0].length - 1;

    output += value.slice(cursor, commandStart);

    if (!commands.has(commandName)) {
      output += match[0];
      cursor = argumentStart + 1;
      continue;
    }

    const argument = readBraceArgument(value, argumentStart);

    if (!argument) {
      output += " ";
      cursor = argumentStart + 1;
      continue;
    }

    output += replace(argument.body, commandName);
    cursor = argument.end;
  }

  return output;
}

function extractLatexCommandArgument(value: string, commandName: string) {
  const pattern = new RegExp(`\\\\${escapeRegExp(commandName)}\\s*\\{`, "i");
  const match = pattern.exec(value);

  if (!match) {
    return undefined;
  }

  const argument = readBraceArgument(value, match.index + match[0].length - 1);

  return argument?.body;
}

function extractLatexEnvironmentBody(value: string, environmentName: string) {
  const beginPattern = new RegExp(
    `\\\\begin\\s*\\{\\s*${escapeRegExp(environmentName)}\\s*\\}`,
    "i",
  );
  const beginMatch = beginPattern.exec(value);

  if (!beginMatch) {
    return undefined;
  }

  const bodyStart = beginMatch.index + beginMatch[0].length;
  const end = findEnvironmentEnd(value, environmentName, bodyStart);

  return value.slice(bodyStart, end?.start ?? value.length);
}

function extractLooseEnvironmentBody(value: string, environmentName: string) {
  const beginPattern = new RegExp(
    `(?:^|[\\s/])begin\\s*\\{\\s*${escapeRegExp(environmentName)}\\s*\\}`,
    "i",
  );
  const beginMatch = beginPattern.exec(value);

  if (!beginMatch) {
    return undefined;
  }

  const bodyStart = beginMatch.index + beginMatch[0].length;
  const endPattern = new RegExp(
    `(?:^|[\\s/])end\\s*\\{\\s*${escapeRegExp(environmentName)}\\s*\\}`,
    "i",
  );
  const endMatch = endPattern.exec(value.slice(bodyStart));

  return value.slice(bodyStart, endMatch ? bodyStart + endMatch.index : value.length);
}

function readBraceArgument(value: string, openingBraceIndex: number) {
  if (value[openingBraceIndex] !== "{") {
    return undefined;
  }

  let depth = 0;

  for (let index = openingBraceIndex; index < value.length; index += 1) {
    const character = value[index];
    const escaped = index > 0 && value[index - 1] === "\\";

    if (character === "{" && !escaped) {
      depth += 1;
    } else if (character === "}" && !escaped) {
      depth -= 1;

      if (depth === 0) {
        return {
          body: value.slice(openingBraceIndex + 1, index),
          end: index + 1,
        };
      }
    }
  }

  return {
    body: value.slice(openingBraceIndex + 1),
    end: value.length,
  };
}

function findEnvironmentEnd(value: string, environmentName: string, startIndex: number) {
  const pattern = new RegExp(
    `\\\\end\\s*\\{\\s*${escapeRegExp(environmentName)}\\s*\\}`,
    "i",
  );
  const match = pattern.exec(value.slice(startIndex));

  return match
    ? {
        end: startIndex + match.index + match[0].length,
        start: startIndex + match.index,
      }
    : undefined;
}

function normalizeExtractedWhitespace(value: string) {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
