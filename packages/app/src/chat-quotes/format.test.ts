import { describe, expect, it } from "vitest";
import {
  clampCommentBody,
  composeMessageWithQuotes,
  extractQuoteableUserBody,
  formatQuoteBlock,
  splitMessageQuotes,
  stripMarkdownForQuotePreview,
} from "./format";
import { MAX_COMMENT_CHARS, type DraftQuote } from "./types";

describe("chat-quotes format", () => {
  it("round-trips a mixed stack of whole-message quotes and selection comments", () => {
    const ts1 = new Date(2026, 10, 25, 14, 35).getTime();
    const ts2 = new Date(2026, 10, 25, 14, 36).getTime();
    const quotes: DraftQuote[] = [
      {
        id: "q1",
        text: "First assistant reply\nwith two lines",
        role: "assistant",
        ts: ts1,
        sourceItemId: "item-1",
      },
      {
        id: "q2",
        text: "Earlier user question",
        role: "user",
        ts: ts2,
        sourceItemId: "item-2",
      },
      {
        id: "c1",
        text: "selected phrase in markdown",
        role: "assistant",
        ts: ts1,
        comment: { body: "Please clarify this assumption." },
      },
      {
        id: "c2",
        text: "second highlighted span",
        role: "assistant",
        comment: { body: "Add a regression test here." },
      },
    ];

    const composed = composeMessageWithQuotes("Overall looks good, see notes above.", quotes);
    const parsed = splitMessageQuotes(composed);

    expect(parsed.body).toBe("Overall looks good, see notes above.");
    expect(parsed.quotes).toEqual([
      {
        kind: "quote",
        role: "assistant",
        timeLabel: "14:35",
        text: "First assistant reply\nwith two lines",
      },
      {
        kind: "quote",
        role: "user",
        timeLabel: "14:36",
        text: "Earlier user question",
      },
      {
        kind: "comment",
        commentNumber: 1,
        role: "assistant",
        timeLabel: "14:35",
        text: "selected phrase in markdown",
        commentBody: "Please clarify this assumption.",
      },
      {
        kind: "comment",
        commentNumber: 2,
        role: "assistant",
        text: "second highlighted span",
        commentBody: "Add a regression test here.",
      },
    ]);
  });

  it("supports sending quotes or comments without additional body text", () => {
    const composed = composeMessageWithQuotes("   ", [
      {
        id: "c1",
        text: "highlighted line",
        role: "assistant",
        comment: { body: "Fix this typo" },
      },
    ]);

    const parsed = splitMessageQuotes(composed);
    expect(parsed.body).toBe("");
    expect(parsed.quotes).toHaveLength(1);
    expect(parsed.quotes[0]).toMatchObject({
      kind: "comment",
      commentNumber: 1,
      text: "highlighted line",
      commentBody: "Fix this typo",
    });
  });

  it("leaves ordinary user-authored markdown blockquotes untouched", () => {
    const plain = "> A regular markdown quote\n> written by the user\n\nFollow-up paragraph.";
    const parsed = splitMessageQuotes(plain);

    expect(parsed.quotes).toEqual([]);
    expect(parsed.body).toBe(plain);
  });

  it("extracts only the human body when re-quoting a message that already carries quotes", () => {
    const composed = composeMessageWithQuotes("My actual follow-up", [
      { id: "q1", text: "Original message", role: "assistant" },
    ]);

    expect(extractQuoteableUserBody(composed)).toBe("My actual follow-up");

    const quoteOnly = composeMessageWithQuotes("", [
      { id: "c1", text: "Highlighted", comment: { body: "Inline note" } },
    ]);
    expect(extractQuoteableUserBody(quoteOnly)).toBe("Inline note");
  });

  it("strips markdown syntax cleanly for compact previews", () => {
    expect(
      stripMarkdownForQuotePreview("## Heading\n- **Bold** [link](https://example.com) `code`"),
    ).toBe("Heading Bold link code");
  });

  it("clamps long comments without splitting UTF-16 surrogate pairs", () => {
    const prefix = "a".repeat(MAX_COMMENT_CHARS - 1);
    const clamped = clampCommentBody(`${prefix}😀tail`);
    expect(clamped.length).toBe(MAX_COMMENT_CHARS - 1);
    expect(clamped).toBe(prefix);
  });

  it("formats single quote block cleanly with custom author label", () => {
    const block = formatQuoteBlock({
      id: "q-custom",
      text: "Hello world",
      from: "Feishu Bot",
    });
    expect(block).toBe("> Quote · Feishu Bot\n> Hello world");
  });
});
