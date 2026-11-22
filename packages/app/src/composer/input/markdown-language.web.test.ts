import { describe, expect, it } from "vitest";
import { computeMarkdownNewlineContinuation } from "./markdown-language.web";

describe("computeMarkdownNewlineContinuation", () => {
  it("continues bullet lists and preserves indentation", () => {
    expect(computeMarkdownNewlineContinuation("- first item", 12)).toEqual({
      replaceFrom: 12,
      replaceTo: 12,
      insert: "\n- ",
    });
    expect(computeMarkdownNewlineContinuation("  * nested", 10)).toEqual({
      replaceFrom: 10,
      replaceTo: 10,
      insert: "\n  * ",
    });
  });

  it("exits an empty bullet list item", () => {
    expect(computeMarkdownNewlineContinuation("- ", 2)).toEqual({
      replaceFrom: 0,
      replaceTo: 2,
      insert: "",
    });
  });

  it("increments ordered list numbers and exits empty items", () => {
    expect(computeMarkdownNewlineContinuation("1. step one", 11)).toEqual({
      replaceFrom: 11,
      replaceTo: 11,
      insert: "\n2. ",
    });
    expect(computeMarkdownNewlineContinuation("  9) item", 9)).toEqual({
      replaceFrom: 9,
      replaceTo: 9,
      insert: "\n  10) ",
    });
    expect(computeMarkdownNewlineContinuation("2. ", 3)).toEqual({
      replaceFrom: 0,
      replaceTo: 3,
      insert: "",
    });
  });

  it("continues checked and unchecked task lists as unchecked", () => {
    expect(computeMarkdownNewlineContinuation("- [x] done", 10)).toEqual({
      replaceFrom: 10,
      replaceTo: 10,
      insert: "\n- [ ] ",
    });
    expect(computeMarkdownNewlineContinuation("- [ ] ", 6)).toEqual({
      replaceFrom: 0,
      replaceTo: 6,
      insert: "",
    });
  });

  it("continues and exits blockquotes", () => {
    expect(computeMarkdownNewlineContinuation("> quoted", 8)).toEqual({
      replaceFrom: 8,
      replaceTo: 8,
      insert: "\n> ",
    });
    expect(computeMarkdownNewlineContinuation("> ", 2)).toEqual({
      replaceFrom: 0,
      replaceTo: 2,
      insert: "",
    });
  });

  it("returns null for ordinary lines", () => {
    expect(computeMarkdownNewlineContinuation("plain text", 10)).toBeNull();
    expect(computeMarkdownNewlineContinuation("# heading", 9)).toBeNull();
  });
});
