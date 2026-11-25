import {
  MAX_COMMENT_CHARS,
  type DraftQuote,
  type ParsedMessageQuote,
  type QuoteAuthorRole,
} from "./types";

const QUOTE_HEADER_RE = /^Quote(?:\s*·\s*(.+))?$/;
const COMMENT_HEADER_RE = /^Comment\s+(\d+)(?:\s*·\s*(.+))?$/;
const CLOCK_TOKEN_RE = /^\d{1,2}:\d{2}$/;

/**
 * Clamps a comment body without splitting a UTF-16 surrogate pair.
 */
export function clampCommentBody(value: string): string {
  if (value.length <= MAX_COMMENT_CHARS) {
    return value;
  }
  const code = value.charCodeAt(MAX_COMMENT_CHARS - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? MAX_COMMENT_CHARS - 1 : MAX_COMMENT_CHARS;
  return value.slice(0, end);
}

/**
 * Formats an epoch timestamp as local 24-hour HH:MM for compact quote metadata.
 */
export function formatQuoteClock(ts?: number): string {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) {
    return "";
  }
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Strips common markdown syntax so multi-line quotes collapse into clean summary previews.
 */
export function stripMarkdownForQuotePreview(text: string): string {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, (_match, inner: string) => inner)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || text.replace(/\s+/g, " ").trim();
}

function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function prefixBlockquoteLines(text: string): string {
  return normalizeLineEndings(text)
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
}

function buildSourceHeaderSuffix(quote: DraftQuote): string {
  const parts: string[] = [];
  const trimmedFrom = quote.from?.trim();
  if (trimmedFrom) {
    parts.push(trimmedFrom);
  } else if (quote.role === "assistant") {
    parts.push("Assistant");
  } else if (quote.role === "user") {
    parts.push("User");
  }
  const clock = formatQuoteClock(quote.ts);
  if (clock) {
    parts.push(clock);
  }
  return parts.length > 0 ? ` · ${parts.join(" · ")}` : "";
}

function parseSourceMetadata(rawMeta: string | undefined): {
  role?: QuoteAuthorRole;
  from?: string;
  timeLabel?: string;
} {
  if (!rawMeta) {
    return {};
  }
  const tokens = rawMeta
    .split(/\s*·\s*/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return {};
  }
  let timeLabel: string | undefined;
  const last = tokens[tokens.length - 1];
  if (last && CLOCK_TOKEN_RE.test(last)) {
    timeLabel = tokens.pop();
  }
  const author = tokens.join(" · ").trim();
  if (!author) {
    return timeLabel ? { timeLabel } : {};
  }
  const lowered = author.toLowerCase();
  if (lowered === "assistant") {
    return { role: "assistant", ...(timeLabel ? { timeLabel } : {}) };
  }
  if (lowered === "user") {
    return { role: "user", ...(timeLabel ? { timeLabel } : {}) };
  }
  return { from: author, ...(timeLabel ? { timeLabel } : {}) };
}

/**
 * Formats a single quote or selection comment as a structured Markdown blockquote block
 * so LLMs receive unambiguous context and message bubbles can re-parse it losslessly.
 */
export function formatQuoteBlock(quote: DraftQuote, commentNumber?: number): string {
  const cleanText = normalizeLineEndings(quote.text).trim();
  const suffix = buildSourceHeaderSuffix(quote);
  if (quote.comment) {
    const number = commentNumber ?? 1;
    const note = clampCommentBody(normalizeLineEndings(quote.comment.body).trim());
    const innerLines: string[] = [
      `Comment ${number}${suffix}`,
      "Selected text:",
      ...cleanText.split("\n").map((line) => (line.length > 0 ? `> ${line}` : ">")),
    ];
    if (note.length > 0) {
      innerLines.push("", note);
    }
    return prefixBlockquoteLines(innerLines.join("\n"));
  }

  const innerLines: string[] = [`Quote${suffix}`, ...cleanText.split("\n")];
  return prefixBlockquoteLines(innerLines.join("\n"));
}

/**
 * Combines queued quote/comment entries with the user's composed message body.
 */
export function composeMessageWithQuotes(text: string, quotes: readonly DraftQuote[]): string {
  const validQuotes = quotes.filter((quote) => {
    const hasExcerpt = quote.text.trim().length > 0;
    const hasCommentBody = (quote.comment?.body.trim().length ?? 0) > 0;
    return hasExcerpt || hasCommentBody;
  });
  const trimmedBody = text.trim();
  if (validQuotes.length === 0) {
    return text;
  }

  let commentNumber = 0;
  const blocks = validQuotes.map((quote) =>
    quote.comment ? formatQuoteBlock(quote, ++commentNumber) : formatQuoteBlock(quote),
  );
  if (trimmedBody.length === 0) {
    return blocks.join("\n\n");
  }
  return `${blocks.join("\n\n")}\n\n${trimmedBody}`;
}

function unquoteBlockLines(lines: readonly string[]): string[] | null {
  if (lines.length === 0) {
    return null;
  }
  const result: string[] = [];
  for (const line of lines) {
    if (!/^ {0,3}>/.test(line)) {
      return null;
    }
    result.push(line.replace(/^ {0,3}> ?/, ""));
  }
  return result;
}

function parseSingleStructuredQuoteBlock(blockText: string): ParsedMessageQuote | null {
  const lines = blockText.split("\n");
  const unquoted = unquoteBlockLines(lines);
  if (!unquoted || unquoted.length === 0) {
    return null;
  }
  const firstLine = (unquoted[0] ?? "").trim();

  const commentMatch = COMMENT_HEADER_RE.exec(firstLine);
  if (commentMatch) {
    const commentNumber = Number(commentMatch[1]);
    const meta = parseSourceMetadata(commentMatch[2]);
    let index = 1;
    if ((unquoted[index] ?? "").trim() === "Selected text:") {
      index += 1;
    }
    const excerptLines: string[] = [];
    while (index < unquoted.length && /^ {0,3}>/.test(unquoted[index] ?? "")) {
      excerptLines.push((unquoted[index] ?? "").replace(/^ {0,3}> ?/, ""));
      index += 1;
    }
    const excerpt = excerptLines.join("\n").trim();
    const commentBody = unquoted.slice(index).join("\n").trim();
    if (!excerpt && !commentBody) {
      return null;
    }
    return {
      kind: "comment",
      commentNumber: Number.isFinite(commentNumber) && commentNumber > 0 ? commentNumber : 1,
      ...meta,
      text: excerpt,
      ...(commentBody ? { commentBody } : {}),
    };
  }

  const quoteMatch = QUOTE_HEADER_RE.exec(firstLine);
  if (quoteMatch) {
    const meta = parseSourceMetadata(quoteMatch[1]);
    const content = unquoted.slice(1).join("\n").trim();
    if (!content) {
      return null;
    }
    return {
      kind: "quote",
      ...meta,
      text: content,
    };
  }

  return null;
}

/**
 * Extracts structured leading quote/comment blocks from a sent message while leaving
 * ordinary user-authored markdown blockquotes untouched.
 */
export function splitMessageQuotes(message: string): {
  quotes: ParsedMessageQuote[];
  body: string;
} {
  const normalized = normalizeLineEndings(message);
  if (!normalized.trimStart().startsWith(">")) {
    return { quotes: [], body: message };
  }

  const lines = normalized.split("\n");
  const quotes: ParsedMessageQuote[] = [];
  let cursor = 0;

  while (cursor < lines.length && (lines[cursor] ?? "").trim().length === 0) {
    cursor += 1;
  }

  while (cursor < lines.length) {
    const blockStart = cursor;
    while (cursor < lines.length && (lines[cursor] ?? "").trim().length > 0) {
      cursor += 1;
    }
    const blockLines = lines.slice(blockStart, cursor);
    const parsed = parseSingleStructuredQuoteBlock(blockLines.join("\n"));
    if (!parsed) {
      cursor = blockStart;
      break;
    }
    quotes.push(parsed);
    while (cursor < lines.length && (lines[cursor] ?? "").trim().length === 0) {
      cursor += 1;
    }
  }

  if (quotes.length === 0) {
    return { quotes: [], body: message };
  }

  return {
    quotes,
    body: lines.slice(cursor).join("\n").trim(),
  };
}

/**
 * Extracts the human-written body of a user message when quoting it again,
 * avoiding nested quote-of-quote duplication when a body is present.
 */
export function extractQuoteableUserBody(message: string): string {
  const parsed = splitMessageQuotes(message);
  if (parsed.body.length > 0) {
    return parsed.body;
  }
  const fallback = parsed.quotes
    .map((entry) => entry.commentBody || entry.text)
    .filter((part) => part.length > 0)
    .join("\n");
  return fallback || message.trim();
}
