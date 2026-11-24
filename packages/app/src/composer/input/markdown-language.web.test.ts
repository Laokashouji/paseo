import { describe, expect, it } from "vitest";
import {
  computeMarkdownBackspaceEdit,
  computeMarkdownListIndentEdit,
  computeMarkdownNewlineContinuation,
} from "./markdown-language.web";

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

describe("computeMarkdownBackspaceEdit", () => {
  it("strips top-level list, task, ordered, heading, and blockquote prefixes right after the marker", () => {
    expect(computeMarkdownBackspaceEdit("- item", 2)).toEqual({
      replaceFrom: 0,
      replaceTo: 2,
      insert: "",
    });
    expect(computeMarkdownBackspaceEdit("- ", 2)).toEqual({
      replaceFrom: 0,
      replaceTo: 2,
      insert: "",
    });
    expect(computeMarkdownBackspaceEdit("- [ ] todo", 6)).toEqual({
      replaceFrom: 0,
      replaceTo: 6,
      insert: "",
    });
    expect(computeMarkdownBackspaceEdit("1. first", 3)).toEqual({
      replaceFrom: 0,
      replaceTo: 3,
      insert: "",
    });
    expect(computeMarkdownBackspaceEdit("### Title", 4)).toEqual({
      replaceFrom: 0,
      replaceTo: 4,
      insert: "",
    });
    expect(computeMarkdownBackspaceEdit("> quoted", 2)).toEqual({
      replaceFrom: 0,
      replaceTo: 2,
      insert: "",
    });
  });

  it("outdents indented list items by one level before removing the marker", () => {
    expect(computeMarkdownBackspaceEdit("  - nested", 4)).toEqual({
      replaceFrom: 0,
      replaceTo: 2,
      insert: "",
    });
    expect(computeMarkdownBackspaceEdit("    - [x] deep", 10)).toEqual({
      replaceFrom: 2,
      replaceTo: 4,
      insert: "",
    });
    expect(computeMarkdownBackspaceEdit("\t1. tabbed", 4)).toEqual({
      replaceFrom: 0,
      replaceTo: 1,
      insert: "",
    });
  });

  it("removes only the innermost level of nested blockquotes", () => {
    expect(computeMarkdownBackspaceEdit("> > nested", 4)).toEqual({
      replaceFrom: 2,
      replaceTo: 4,
      insert: "",
    });
  });

  it("returns null when caret is inside body text or on an ordinary line", () => {
    expect(computeMarkdownBackspaceEdit("- item", 3)).toBeNull();
    expect(computeMarkdownBackspaceEdit("### Title", 5)).toBeNull();
    expect(computeMarkdownBackspaceEdit("plain text", 5)).toBeNull();
    expect(computeMarkdownBackspaceEdit("- item", 0)).toBeNull();
  });
});

describe("computeMarkdownListIndentEdit", () => {
  it("indents bullet, ordered, and task list items by two spaces", () => {
    expect(computeMarkdownListIndentEdit("- item")).toEqual({
      replaceFrom: 0,
      replaceTo: 0,
      insert: "  ",
    });
    expect(computeMarkdownListIndentEdit("1. first")).toEqual({
      replaceFrom: 0,
      replaceTo: 0,
      insert: "  ",
    });
    expect(computeMarkdownListIndentEdit("  - [ ] todo")).toEqual({
      replaceFrom: 0,
      replaceTo: 0,
      insert: "  ",
    });
  });

  it("returns null for non-list lines and respects max nesting depth", () => {
    expect(computeMarkdownListIndentEdit("plain text")).toBeNull();
    expect(computeMarkdownListIndentEdit("### heading")).toBeNull();
    expect(computeMarkdownListIndentEdit("            - too deep")).toBeNull();
  });
});
