import { Parser } from "htmlparser2";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { decodeString } from "micromark-util-decode-string";
import type { Nodes } from "mdast";

/** Line break marker emitted inside GFM table cells so md4c keeps the row intact. */
export const TABLE_CELL_LINE_BREAK = "\u2028";
const TABLE_LINE_BREAK = ` ${TABLE_CELL_LINE_BREAK} `;
const GFM_TABLE_OPTIONS = {
  extensions: [gfmTable()],
  mdastExtensions: [gfmTableFromMarkdown()],
};
const GFM_TABLE_NO_HTML_OPTIONS = {
  extensions: [gfmTable(), { disable: { null: ["htmlFlow", "htmlText"] } }],
  mdastExtensions: [gfmTableFromMarkdown()],
};

interface TextRange {
  start: number;
  end: number;
}

interface TableCellRange extends TextRange {
  contentStart: number;
  contentEnd: number;
}

const ATTRIBUTE = String.raw`\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>\x60]+|'[^']*'|"[^"]*"))?`;
const TAG = String.raw`<(?:[A-Za-z][A-Za-z0-9-]*(?:${ATTRIBUTE})*\s*\/?|\/[A-Za-z][A-Za-z0-9-]*\s*)>`;
const HTML = new RegExp(
  String.raw`(?<!\\)(?:<!--[\s\S]*?-->|<code\b[^>]*>[\s\S]*?<\/code\s*>|<summary\b[^>]*>[\s\S]*?<\/summary\s*>|${TAG})`,
  "gi",
);
const BLOCK_TAGS = new Set([
  "div",
  "p",
  "table",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "section",
  "article",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
]);
const EMPHASIS: Readonly<Record<string, string>> = { b: "**", strong: "**", i: "*", em: "*" };

/** Convert comment HTML to Markdown while preserving the original spelling of code. */
export function normalizeMarkdownHtml(source: string): string {
  if (!source.includes("<")) return source;
  const htmlRanges: TextRange[] = [];
  function findHtml(node: Nodes) {
    if (node.type === "html" && node.position) {
      htmlRanges.push({ start: node.position.start.offset!, end: node.position.end.offset! });
    } else if ("children" in node) node.children.forEach(findHtml);
  }
  findHtml(fromMarkdown(source, GFM_TABLE_OPTIONS));
  const codeRanges: TextRange[] = [];
  const tableCellRanges: TableCellRange[] = [];
  // Disable HTML parsing so code and GFM tables inside <details> remain visible to the Markdown parser.
  const tree = fromMarkdown(source, GFM_TABLE_NO_HTML_OPTIONS);
  function collectProtectedAndTableRanges(node: Nodes) {
    if (node.type === "code" || node.type === "inlineCode") {
      const range = nodeRange(node);
      if (range) codeRanges.push(range);
      return;
    }
    if (isStandaloneDetailsRow(node, source)) return;
    const cellRange = tableCellRange(node);
    if (cellRange) tableCellRanges.push(cellRange);
    if ("children" in node) node.children.forEach(collectProtectedAndTableRanges);
  }
  collectProtectedAndTableRanges(tree);
  const links: (string | undefined)[] = [];
  let previousTag: { name: string; end: number } | null = null;
  const convert = (raw: string, offset: number): string => {
    if (findRange(codeRanges, offset)) return raw;
    if (raw.startsWith("<!--")) return "";
    const cell = findRange(tableCellRanges, offset);
    const summary = /^<summary\b[^>]*>([\s\S]*?)<\/summary\s*>$/i.exec(raw);
    if (summary) return markdownSummary(summary[1], source, raw, offset, cell);
    const code = /^<code\b[^>]*>([\s\S]*?)<\/code\s*>$/i.exec(raw);
    if (code) return markdownCode(code[1], cell !== null);
    const closing = raw.startsWith("</");
    const name = /^<\/?([\w-]+)/.exec(raw)?.[1].toLowerCase() ?? "";
    const startsAfterBoundary = isAfterBlockBoundary(source, previousTag, offset, cell);
    previousTag = { name, end: offset + raw.length };
    if (EMPHASIS[name]) return EMPHASIS[name];
    const boundary = layoutBoundary(name, source, raw, offset, closing, startsAfterBoundary, cell);
    if (boundary !== null) return boundary;
    if (name === "a") return markdownAnchor(raw, closing, links);
    if (name === "img" && !closing) return markdownImage(raw, cell !== null);
    return "";
  };
  let result = "";
  let cursor = 0;
  for (const range of htmlRanges) {
    if (range.start < cursor) continue;
    result += source.slice(cursor, range.start);
    const cell = findRange(tableCellRanges, range.start);
    const sliceEnd = cell ? cell.contentEnd : source.length;
    // Inline HTML code has separate opening/closing AST nodes. Convert the pair
    // together so its contents keep backslashes and get a safe backtick delimiter.
    const paired = /^<(code|summary)\b[^>]*>[\s\S]*?<\/\1\s*>/i.exec(
      source.slice(range.start, sliceEnd),
    );
    const end = paired ? Math.max(range.end, range.start + paired[0].length) : range.end;
    result += source
      .slice(range.start, end)
      .replace(HTML, (raw, offset) => convert(raw, range.start + offset));
    cursor = end;
  }
  return result + source.slice(cursor);
}

function nodeRange(node: Nodes): TextRange | null {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  return start !== undefined && end !== undefined ? { start, end } : null;
}

function isStandaloneDetailsRow(node: Nodes, source: string): boolean {
  if (node.type !== "tableRow") return false;
  const range = nodeRange(node);
  if (!range) return false;
  const rowText = source.slice(range.start, range.end);
  // A pipe-less standalone <details> / </details> line directly after a GFM table is
  // a block wrapper, not a table row.
  return !rowText.includes("|") && /^\s*<\/?details\b[^>]*>\s*$/i.test(rowText);
}

function tableCellRange(node: Nodes): TableCellRange | null {
  if (node.type !== "tableCell") return null;
  const range = nodeRange(node);
  const contentStart = node.children[0]?.position?.start.offset;
  const contentEnd = node.children.at(-1)?.position?.end.offset;
  if (!range || contentStart === undefined || contentEnd === undefined) return null;
  return { ...range, contentStart, contentEnd };
}

function isAfterBlockBoundary(
  source: string,
  previousTag: { name: string; end: number } | null,
  offset: number,
  cell: TableCellRange | null,
): boolean {
  // Each gap is inspected once, rather than searching the complete prefix
  // for a preceding tag on every table row or nested block.
  const scopeStart = cell ? cell.contentStart : 0;
  const sameScopePrev = previousTag && previousTag.end >= scopeStart ? previousTag : null;
  if (sameScopePrev) {
    return (
      BLOCK_TAGS.has(sameScopePrev.name) && /^\s*$/.test(source.slice(sameScopePrev.end, offset))
    );
  }
  return /^\s*$/.test(source.slice(scopeStart, offset));
}

function markdownSummary(
  inner: string,
  source: string,
  raw: string,
  offset: number,
  cell: TableCellRange | null,
): string {
  const title = normalizeMarkdownHtml(inner).trim();
  // A summary is one bold paragraph, even when its HTML title uses headings
  // or several block wrappers. Slice AST blocks so inline code stays literal.
  const inline = fromMarkdown(title)
    .children.map(({ position }) => title.slice(position!.start.offset!, position!.end.offset!))
    .join(" ");
  if (!cell) return `**${inline}**\n\n`;
  const singleLine = inline.replace(/\s*(?:\r\n?|\n)\s*/g, TABLE_LINE_BREAK);
  const trailing = blockBoundary(
    source,
    raw,
    offset,
    true,
    false,
    cell.contentEnd,
    TABLE_LINE_BREAK,
    true,
  );
  return `**${singleLine}**${trailing}`;
}

function markdownCode(inner: string, inTableCell: boolean): string {
  const decoded = inner.replace(/&(?:#(?:[xX][\da-fA-F]+|\d+)|[a-zA-Z][a-zA-Z\d]+);/g, (entity) =>
    decodeString(entity),
  );
  return inlineCode(inTableCell ? decoded.replace(/\r\n?|\n/g, " ") : decoded);
}

function markdownImage(raw: string, inTableCell: boolean): string {
  const { src, alt = "" } = attributes(raw);
  const safeAlt = inTableCell ? alt.replace(/\r\n?|\n/g, " ") : alt;
  return src ? `![${safeAlt.replace(/[[\]\\]/g, "\\$&")}](<${markdownUrl(src)}>)` : safeAlt;
}

function findRange<T extends TextRange>(ranges: readonly T[], offset: number): T | null {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const range = ranges[mid]!;
    if (offset < range.start) high = mid - 1;
    else if (offset >= range.end) low = mid + 1;
    else return range;
  }
  return null;
}

function attributes(tag: string): Record<string, string> {
  let result: Record<string, string> = {};
  const parser = new Parser({
    onopentag: (_name, value) => {
      result = value;
    },
  });
  parser.end(tag);
  return result;
}

function markdownUrl(url: string): string {
  return url.replace(/[<>\r\n]/g, (character) => encodeURIComponent(character));
}

function inlineCode(content: string): string {
  const runs = content.match(/`+/g) ?? [];
  const marker = "`".repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const padding = content.startsWith("`") || content.endsWith("`") ? " " : "";
  return `${marker}${padding}${content}${padding}${marker}`;
}

function markdownAnchor(raw: string, closing: boolean, links: (string | undefined)[]): string {
  if (closing) {
    const href = links.pop();
    return href === undefined ? "" : `](<${markdownUrl(href)}>)`;
  }
  const { href } = attributes(raw);
  links.push(href);
  return href === undefined ? "" : "[";
}

function blockBoundary(
  source: string,
  raw: string,
  offset: number,
  closing: boolean,
  startsAfterBoundary: boolean,
  scopeEnd: number,
  separator: string,
  inTableCell: boolean,
): string {
  if (closing) {
    const following = source.slice(offset + raw.length, scopeEnd);
    if (/^\s*$/.test(following) || following.startsWith("\n\n")) return "";
    const nextClosingTag = /^\s*<\/([\w-]+)/.exec(following);
    if (nextClosingTag) {
      const nextName = nextClosingTag[1].toLowerCase();
      if (BLOCK_TAGS.has(nextName) || (inTableCell && nextName === "details")) return "";
    }
  } else if (startsAfterBoundary) {
    return "";
  }
  return separator;
}

function layoutBoundary(
  name: string,
  source: string,
  raw: string,
  offset: number,
  closing: boolean,
  startsAfterBoundary: boolean,
  cell: TableCellRange | null,
): string | null {
  const scopeStart = cell ? cell.contentStart : 0;
  const scopeEnd = cell ? cell.contentEnd : source.length;
  const blockSeparator = cell ? TABLE_LINE_BREAK : "\n\n";
  if (name === "br") {
    if (closing) return "";
    return cell ? TABLE_LINE_BREAK : "  \n";
  }
  if (name === "summary") {
    if (!closing) return "**";
    if (!cell) return "**\n\n";
    const trailing = blockBoundary(
      source,
      raw,
      offset,
      true,
      false,
      scopeEnd,
      TABLE_LINE_BREAK,
      true,
    );
    return `**${trailing}`;
  }
  if (name === "details") {
    if (closing) {
      return offset + raw.length >= scopeEnd ? "" : blockSeparator;
    }
    return offset <= scopeStart ? "" : blockSeparator;
  }
  if (BLOCK_TAGS.has(name)) {
    return blockBoundary(
      source,
      raw,
      offset,
      closing,
      startsAfterBoundary,
      scopeEnd,
      blockSeparator,
      cell !== null,
    );
  }
  if ((name === "td" || name === "th") && closing)
    return /^<t[dh]\b/i.test(source.slice(offset + raw.length, scopeEnd)) ? " " : "";
  return null;
}
