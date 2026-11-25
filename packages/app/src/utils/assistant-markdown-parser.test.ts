import { describe, expect, it } from "vitest";
import { createAssistantMarkdownParser, markdownPreviewText } from "./assistant-markdown-parser";

describe("createAssistantMarkdownParser", () => {
  it("keeps ordinary parsing for completed messages", () => {
    const parser = createAssistantMarkdownParser();
    expect(parser.renderInline("**unfinished")).toBe("**unfinished");
    expect(parser.renderInline("[unfinished")).toBe("[unfinished");
  });

  it("renders agent text verbatim", () => {
    const parser = createAssistantMarkdownParser();

    // The reported bug, plus the substitutions that share its cause.
    expect(parser.renderInline("(c) (C) (r) (tm) (p)")).toBe("(c) (C) (r) (tm) (p)");
    expect(parser.renderInline("wait for it...")).toBe("wait for it...");
    expect(parser.renderInline("a -- b")).toBe("a -- b");
    // Smart quotes are off too: a curled quote is not pasteable into a shell.
    expect(parser.renderInline(`run --name="my repo"`)).toBe("run --name=&quot;my repo&quot;");
    expect(parser.renderInline("it's fine")).toBe("it's fine");
  });

  it("allows file:// links, unlike every other parser", () => {
    const parser = createAssistantMarkdownParser();

    expect(parser.render("[open](file:///tmp/a.ts)")).toContain('href="file:///tmp/a.ts"');
  });

  it("still rejects javascript: links", () => {
    const parser = createAssistantMarkdownParser();

    expect(parser.render("[x](javascript:alert(1))")).not.toContain("href");
  });
});

describe("markdownPreviewText", () => {
  it("keeps option numbers when a nested list is flattened to one line", () => {
    expect(markdownPreviewText("3. First\n   - detail\n   1. nested\n4. Next")).toBe(
      "3. First detail 1. nested 4. Next",
    );
  });

  it("flattens block and inline markup while preserving literal punctuation and code", () => {
    expect(
      markdownPreviewText(
        "## **Review**\n- _See_ [`test_api`](file:///repo/test_api) and ![diagram](diagram.png)\n" +
          "- `a ** b` or a * b in run_tests (#42)",
      ),
    ).toBe("Review See test_api and diagram a ** b or a * b in run_tests (#42)");
  });
});
