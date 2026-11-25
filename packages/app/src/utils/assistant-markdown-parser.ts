import type MarkdownIt from "markdown-it";
import type Token from "markdown-it/lib/token.mjs";
import { createMarkdownParser } from "@/utils/markdown-parser";

export function createAssistantMarkdownParser(): MarkdownIt {
  const parser = createMarkdownParser({ linkify: true });
  const defaultValidateLink = parser.validateLink.bind(parser);

  // Rich clipboard HTML preserves workspace file links.
  parser.validateLink = (url: string) =>
    url.trim().toLowerCase().startsWith("file://") || defaultValidateLink(url);

  return parser;
}

const previewParser = createAssistantMarkdownParser();

function previewTokenText(token: Token): string {
  if (token.type === "softbreak" || token.type === "hardbreak") return " ";
  if (token.children) return token.children.map(previewTokenText).join("");
  return token.content;
}

/** Keep inline text contiguous while separating paragraphs, list items and other blocks. */
export function markdownPreviewText(source: string): string {
  const nextOrdinal: number[] = [];
  return previewParser
    .parse(source, {})
    .map((token) => {
      if (token.type === "ordered_list_open") {
        nextOrdinal[token.level + 1] = Number(token.attrGet("start") ?? 1);
      }
      if (token.type === "list_item_open" && (token.markup === "." || token.markup === ")")) {
        return `${nextOrdinal[token.level]++}${token.markup}`;
      }
      return previewTokenText(token);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
