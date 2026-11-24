import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { resolveLinkedClipboardMarkdown } from "@/composer/pasted-text.web";
import { ComposerMarkdownInput, type ComposerMarkdownInputProps } from "./markdown-editor.web";

interface MountedEditor {
  root: Root;
  container: HTMLDivElement;
  inputRef: React.MutableRefObject<EditingTextInputHandle | null>;
  content: HTMLElement;
}

const mountedEditors: MountedEditor[] = [];
const COMPOSER_DATASET = { composerInput: "" };

beforeEach(() => vi.stubGlobal("React", React));

afterEach(() => {
  for (const mounted of mountedEditors.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
});

function mountEditor(
  props: Partial<ComposerMarkdownInputProps> = {},
  inputRef: React.MutableRefObject<EditingTextInputHandle | null> = React.createRef(),
): MountedEditor {
  const container = document.createElement("div");
  container.style.width = "520px";
  document.body.appendChild(container);
  const root = createRoot(container);

  act(() => {
    root.render(
      <ComposerMarkdownInput
        ref={inputRef}
        initialValue=""
        dataSet={COMPOSER_DATASET}
        accessibilityLabel="Message input"
        testID="composer-markdown-input"
        minHeight={40}
        maxHeight={220}
        {...props}
      />,
    );
  });

  const content = inputRef.current?.getNativeRef();
  if (!(content instanceof HTMLElement)) {
    throw new Error("ComposerMarkdownInput did not expose its contentDOM synchronously on mount");
  }

  const mounted = { root, container, inputRef, content };
  mountedEditors.push(mounted);
  return mounted;
}

describe("ComposerMarkdownInput (web Live Preview)", () => {
  it("renders Live Preview formatting and hides raw markers while preserving raw Markdown text", () => {
    const sample = [
      "# Main Heading",
      "## Sub Heading",
      "**bold** *italic* ~~strike~~ `inline()` [docs](https://example.com)",
      "> quoted thought",
      "- bullet item",
      "  - nested bullet",
      "1. ordered item",
      "- [x] completed task",
      "---",
      "```ts",
      "const count = 42;",
      "```",
    ].join("\n");

    const mounted = mountEditor({ initialValue: sample, maxHeight: 480 });
    const { container, content, inputRef } = mounted;

    expect(inputRef.current?.getText()).toBe(sample);
    expect(content.getAttribute("data-composer-input")).toBe("");
    expect(content.getAttribute("role")).toBe("textbox");
    expect(content.getAttribute("aria-multiline")).toBe("true");
    expect(content.getAttribute("aria-label")).toBe("Message input");

    const h1 = container.querySelector(".cm-line.cm-md-h1") as HTMLElement | null;
    const h2 = container.querySelector(".cm-line.cm-md-h2") as HTMLElement | null;
    const strong = container.querySelector(".cm-md-strong") as HTMLElement | null;
    const em = container.querySelector(".cm-md-em") as HTMLElement | null;
    const strike = container.querySelector(".cm-md-strike") as HTMLElement | null;
    const inlineCode = container.querySelector(".cm-md-inline-code") as HTMLElement | null;
    const blockquote = container.querySelector(
      ".cm-line.cm-md-blockquote-line",
    ) as HTMLElement | null;
    const bulletWidgets = container.querySelectorAll(".cm-md-bullet-widget");
    const orderedWidget = container.querySelector(".cm-md-ordered-widget") as HTMLElement | null;
    const taskCheckbox = container.querySelector(".cm-md-task-checkbox") as HTMLElement | null;
    const hrBar = container.querySelector(".cm-md-hr-bar") as HTMLElement | null;
    const link = container.querySelector(".cm-md-link-live") as HTMLElement | null;
    const langBadge = container.querySelector(".cm-md-code-lang-badge") as HTMLElement | null;
    const codeLines = container.querySelectorAll(".cm-line.cm-md-codeblock-line");
    const firstCodeLine = container.querySelector(".cm-line.cm-md-codeblock-first");
    const lastCodeLine = container.querySelector(".cm-line.cm-md-codeblock-last");

    expect(h1?.textContent).toBe("Main Heading");
    expect(h2?.textContent).toBe("Sub Heading");
    expect(strong?.textContent).toBe("bold");
    expect(em?.textContent).toBe("italic");
    expect(strike?.textContent).toBe("strike");
    expect(inlineCode?.textContent).toBe("inline()");
    expect(blockquote?.textContent).toBe("quoted thought");
    expect(bulletWidgets.length).toBe(2);
    expect(bulletWidgets[0]?.textContent).toBe("•");
    expect(bulletWidgets[1]?.textContent).toBe("◦");
    expect(orderedWidget?.textContent).toBe("1.");
    expect(taskCheckbox?.getAttribute("aria-checked")).toBe("true");
    expect(hrBar).not.toBeNull();
    expect(link?.textContent).toBe("docs");
    expect(container.querySelector(".cm-md-url")).toBeNull();
    expect(langBadge?.textContent).toBe("ts");
    expect(codeLines.length).toBe(3);
    expect(firstCodeLine).not.toBeNull();
    expect(lastCodeLine).not.toBeNull();

    const baseFontSize = Number.parseFloat(getComputedStyle(content).fontSize);
    const h1FontSize = Number.parseFloat(getComputedStyle(h1!).fontSize);
    expect(h1FontSize).toBeGreaterThan(baseFontSize);
    expect(Number.parseInt(getComputedStyle(strong!).fontWeight, 10)).toBeGreaterThanOrEqual(700);
    expect(getComputedStyle(em!).fontStyle).toBe("italic");
    expect(getComputedStyle(inlineCode!).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });

  it("transforms block prefixes and inline syntax immediately upon completing the trigger delimiter", () => {
    const mounted = mountEditor();
    const { container, inputRef } = mounted;
    const handle = inputRef.current!;

    act(() => {
      handle.focus();
      handle.insertText?.("-");
    });
    // Lone "-" without space stays literal.
    expect(container.querySelector(".cm-md-bullet-widget")).toBeNull();

    act(() => {
      handle.insertText?.(" ");
    });
    // As soon as space is typed, "- " immediately renders as a bullet list item.
    expect(container.querySelector(".cm-md-bullet-widget")?.textContent).toBe("•");
    expect(container.querySelector(".cm-line.cm-md-bullet-line")).not.toBeNull();
    expect(handle.getText()).toBe("- ");

    // Mid-typing "**bold*" should not prematurely hide single-asterisk italic delimiters.
    act(() => {
      handle.insertText?.("**bold*");
    });
    expect(container.querySelector(".cm-md-em")?.textContent).toBe("*bold*");

    // Completing the second closing asterisk immediately transforms into clean bold text.
    act(() => {
      handle.insertText?.("*");
    });
    expect(container.querySelector(".cm-md-strong")?.textContent).toBe("bold");
    expect(handle.getText()).toBe("- **bold**");

    // Completing inline code immediately hides backticks.
    act(() => {
      handle.insertText?.(" `code()`");
    });
    expect(container.querySelector(".cm-md-inline-code")?.textContent).toBe("code()");

    // Typing "### " immediately turns the line into a heading with hashes hidden.
    act(() => {
      handle.replaceText("###", { start: 3, end: 3 });
    });
    expect(container.querySelector(".cm-line.cm-md-h3")?.textContent).toBe("###");
    act(() => {
      handle.insertText?.(" ");
    });
    expect(container.querySelector(".cm-line.cm-md-h3")?.textContent).toBe("");

    // Typing "> " immediately turns the line into a blockquote with ">" hidden.
    act(() => {
      handle.replaceText(">", { start: 1, end: 1 });
    });
    expect(container.querySelector(".cm-line.cm-md-blockquote-line")).toBeNull();
    act(() => {
      handle.insertText?.(" ");
    });
    expect(container.querySelector(".cm-line.cm-md-blockquote-line")?.textContent).toBe("");

    // Quoted bullet list renders both blockquote and bullet without overlapping decorations.
    act(() => {
      handle.replaceText("> - nested bullet", { start: 17, end: 17 });
    });
    expect(
      container.querySelector(".cm-line.cm-md-blockquote-line.cm-md-bullet-line"),
    ).not.toBeNull();
    expect(container.querySelector(".cm-md-bullet-widget")?.textContent).toBe("•");
  });

  it("reveals raw inline markers when arrow-keying into hidden syntax via atomic ranges", () => {
    const sample = "See **bold**";
    const mounted = mountEditor({ initialValue: sample });
    const { container, content, inputRef } = mounted;
    const handle = inputRef.current!;

    act(() => {
      handle.focus();
      handle.setSelection({ start: sample.length, end: sample.length });
    });
    expect(container.querySelector(".cm-md-strong")?.textContent).toBe("bold");

    // Pressing ArrowLeft once at the end jumps atomically over closing "**" and reveals raw marks.
    act(() => {
      content.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true, cancelable: true }),
      );
    });
    expect(handle.getSelection?.()).toEqual({ start: 10, end: 10 });
    expect(container.querySelector(".cm-md-strong")?.textContent).toBe("**bold**");
  });

  it("reveals raw inline markers when the caret enters an inline node and re-hides when leaving", () => {
    const sample = "See **bold** and [docs](https://example.com) now";
    const mounted = mountEditor({ initialValue: sample });
    const { container, inputRef } = mounted;
    const handle = inputRef.current!;

    act(() => {
      handle.focus();
      handle.setSelection({ start: sample.length, end: sample.length });
    });
    expect(container.querySelector(".cm-md-strong")?.textContent).toBe("bold");
    expect(container.querySelector(".cm-md-link-live")?.textContent).toBe("docs");
    expect(container.querySelector(".cm-md-url")).toBeNull();

    // Place caret inside **bold** -> reveals raw ** delimiters.
    act(() => {
      handle.setSelection({ start: 8, end: 8 });
    });
    expect(container.querySelector(".cm-md-strong")?.textContent).toBe("**bold**");
    expect(container.querySelector(".cm-md-link-live")?.textContent).toBe("docs");

    // Place caret inside link -> bold re-hides, link reveals [docs](https://example.com).
    const linkInsidePos = sample.indexOf("docs") + 2;
    act(() => {
      handle.setSelection({ start: linkInsidePos, end: linkInsidePos });
    });
    expect(container.querySelector(".cm-md-strong")?.textContent).toBe("bold");
    expect(container.querySelector(".cm-md-url")?.textContent).toBe("https://example.com");
  });

  it("supports clicking task checkboxes to toggle raw Markdown between [ ] and [x]", () => {
    const changes: string[] = [];
    const mounted = mountEditor({
      initialValue: "- [ ] ship live preview",
      onChangeText: (text) => changes.push(text),
    });
    const { container, inputRef } = mounted;

    const checkboxWidget = container.querySelector(".cm-md-task-widget") as HTMLElement | null;
    expect(checkboxWidget).not.toBeNull();
    expect(container.querySelector(".cm-md-task-checkbox")?.getAttribute("aria-checked")).toBe(
      "false",
    );

    act(() => {
      checkboxWidget!.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });

    expect(inputRef.current?.getText()).toBe("- [x] ship live preview");
    expect(changes.at(-1)).toBe("- [x] ship live preview");
    expect(container.querySelector(".cm-md-task-checkbox")?.getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(container.querySelector(".cm-line.cm-md-task-checked")).not.toBeNull();
  });

  it("renders CJK punctuation-bounded bold spans without leaking raw asterisks", () => {
    const sample = "- 作用退化成了**“提醒已打开文档的 AI”**——偏软约束";
    const mounted = mountEditor({ initialValue: sample });
    const { container, inputRef } = mounted;

    expect(inputRef.current?.getText()).toBe(sample);
    expect(container.querySelector(".cm-md-bullet-widget")?.textContent).toBe("•");
    expect(container.querySelector(".cm-md-strong")?.textContent).toBe("“提醒已打开文档的 AI”");
  });

  it("supports Tab list indentation and Backspace prefix/outdent/safe inline deletion", () => {
    const mounted = mountEditor({ initialValue: "- item" });
    const { content, inputRef } = mounted;
    const handle = inputRef.current!;

    act(() => {
      handle.focus();
      handle.setSelection({ start: 2, end: 2 });
      content.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      );
    });
    expect(handle.getText()).toBe("  - item");

    // First Backspace at marker boundary outdents from 2 spaces back to top-level.
    act(() => {
      content.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
      );
    });
    expect(handle.getText()).toBe("- item");

    // Second Backspace at top-level marker boundary converts list item back to plain text.
    act(() => {
      content.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
      );
    });
    expect(handle.getText()).toBe("item");

    // Backspace immediately after a hidden inline link deletes only ")" so the URL is not lost.
    act(() => {
      handle.replaceText("[docs](https://example.com)", { start: 27, end: 27 });
      content.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
      );
    });
    expect(handle.getText()).toBe("[docs](https://example.com");
  });

  it("supports handle focus, selection, replaceText, insertText, and reset while keeping focus", () => {
    const changes: string[] = [];
    const mounted = mountEditor({ onChangeText: (text) => changes.push(text) });
    const handle = mounted.inputRef.current!;

    act(() => {
      handle.focus();
      handle.replaceText("hello world", { start: 6, end: 11 });
    });

    expect(handle.isFocused()).toBe(true);
    expect(document.activeElement).toBe(mounted.content);
    expect(handle.getText()).toBe("hello world");
    expect(handle.getSelection?.()).toEqual({ start: 6, end: 11 });
    // Remote replaceText does not echo back through onChangeText.
    expect(changes).toEqual([]);

    act(() => {
      expect(handle.insertText?.("[Paseo](https://paseo.sh)")).toBe(true);
    });

    expect(handle.getText()).toBe("hello [Paseo](https://paseo.sh)");
    expect(changes).toEqual(["hello [Paseo](https://paseo.sh)"]);

    act(() => {
      handle.setSelection({ start: 0, end: 5 });
    });
    expect(handle.getSelection?.()).toEqual({ start: 0, end: 5 });

    act(() => {
      handle.reset();
    });
    expect(handle.getText()).toBe("");
    expect(handle.isFocused()).toBe(true);
  });

  it("lets composer onKeyPress intercept Enter while continuing lists on Shift+Enter", () => {
    const interceptedKeys: string[] = [];
    const changes: string[] = [];
    const mounted = mountEditor({
      initialValue: "- first item",
      onChangeText: (text) => changes.push(text),
      onKeyPress: (event) => {
        const native = event.nativeEvent as { key: string; shiftKey?: boolean };
        interceptedKeys.push(native.key);
        if (native.key === "Enter" && !native.shiftKey) {
          event.preventDefault();
        }
      },
    });
    const handle = mounted.inputRef.current!;

    act(() => {
      handle.focus();
      handle.setSelection({ start: 12, end: 12 });
      mounted.content.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(interceptedKeys).toEqual(["Enter"]);
    expect(handle.getText()).toBe("- first item");

    act(() => {
      mounted.content.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(handle.getText()).toBe("- first item\n- ");
    expect(changes.at(-1)).toBe("- first item\n- ");

    // Pressing Shift+Enter on an empty bullet item clears the prefix.
    act(() => {
      mounted.content.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(handle.getText()).toBe("- first item\n");
  });

  it("defers onChangeText during IME composition and flushes on compositionend", async () => {
    const changes: string[] = [];
    const mounted = mountEditor({ onChangeText: (text) => changes.push(text) });
    const handle = mounted.inputRef.current!;

    act(() => {
      handle.focus();
      mounted.content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      handle.insertText?.("你好");
    });

    expect(changes).toEqual([]);

    await act(async () => {
      mounted.content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      await Promise.resolve();
    });

    expect(changes).toEqual(["你好"]);
    expect(handle.getText()).toBe("你好");
  });

  it("respects minHeight and maxHeight bounds while scrolling long drafts", () => {
    const longDraft = Array.from({ length: 30 }, (_, index) => `- Line ${index + 1}`).join("\n");
    const mounted = mountEditor({ initialValue: longDraft, minHeight: 40, maxHeight: 140 });
    const editorEl = mounted.container.querySelector(".cm-editor") as HTMLElement;
    const scrollerEl = mounted.container.querySelector(".cm-scroller") as HTMLElement;

    expect(editorEl.getBoundingClientRect().height).toBeLessThanOrEqual(141);
    expect(scrollerEl.scrollHeight).toBeGreaterThan(scrollerEl.clientHeight);
  });

  it("does not intercept Shift+Tab so global composer mode switching stays intact", () => {
    const mounted = mountEditor({ initialValue: "- list item" });
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      mounted.inputRef.current?.focus();
      mounted.inputRef.current?.setSelection({ start: 2, end: 2 });
      mounted.content.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(mounted.inputRef.current?.getText()).toBe("- list item");
  });

  it("inserts converted linked HTML paste exactly once via capture listener without double paste", () => {
    const changes: string[] = [];
    const mounted = mountEditor({ onChangeText: (text) => changes.push(text) });
    const handle = mounted.inputRef.current!;

    const onCapturePaste = (event: ClipboardEvent) => {
      const markdown = resolveLinkedClipboardMarkdown(event.clipboardData);
      if (markdown !== null && handle.insertText?.(markdown)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    mounted.content.addEventListener("paste", onCapturePaste, true);

    try {
      const clipboard = new DataTransfer();
      clipboard.setData("text/html", 'Check <a href="https://paseo.sh">Paseo</a>');
      clipboard.setData("text/plain", "Check Paseo");
      const pasteEvent = new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      });

      act(() => {
        handle.focus();
        mounted.content.dispatchEvent(pasteEvent);
      });

      expect(pasteEvent.defaultPrevented).toBe(true);
      expect(handle.getText()).toBe("Check [Paseo](https://paseo.sh)");
      expect(changes).toEqual(["Check [Paseo](https://paseo.sh)"]);
    } finally {
      mounted.content.removeEventListener("paste", onCapturePaste, true);
    }
  });

  it("formats empty list prefixes immediately after a paragraph and avoids duplicate markers during IME composition", async () => {
    const client = cdp();
    const mounted = mountEditor({ initialValue: "帮我做几件事" });
    const { container, inputRef } = mounted;
    const handle = inputRef.current!;

    act(() => {
      handle.focus();
      handle.setSelection({ start: 6, end: 6 });
    });

    await userEvent.keyboard("{Shift>}{Enter}{/Shift}1. ");

    await vi.waitFor(() => {
      const lines = container.querySelectorAll(".cm-line");
      expect(lines.length).toBe(2);
      expect(lines[1]?.classList.contains("cm-md-ordered-line")).toBe(true);
      expect(lines[1]?.querySelector(".cm-md-ordered-widget")?.textContent).toBe("1.");
      expect(lines[1]?.textContent).toBe("1.");
    });
    expect(handle.getText()).toBe("帮我做几件事\n1. ");

    // Start Chinese IME composition immediately after `1. ` without committing yet.
    await client.send("Input.imeSetComposition", {
      text: "ceshi",
      selectionStart: 5,
      selectionEnd: 5,
    });

    await vi.waitFor(() => {
      const line2 = container.querySelectorAll(".cm-line")[1];
      expect(handle.getText()).toBe("帮我做几件事\n1. ceshi");
      expect(line2?.classList.contains("cm-md-ordered-line")).toBe(true);
      expect(line2?.querySelectorAll(".cm-md-ordered-widget").length).toBe(1);
      expect(line2?.textContent).toBe("1.ceshi");
    });

    // Commit Chinese text via IME.
    await client.send("Input.insertText", { text: "测试" });

    await vi.waitFor(() => {
      const line2 = container.querySelectorAll(".cm-line")[1];
      expect(handle.getText()).toBe("帮我做几件事\n1. 测试");
      expect(line2?.querySelectorAll(".cm-md-ordered-widget").length).toBe(1);
      expect(line2?.textContent).toBe("1.测试");
    });

    // Also verify `- ` after a paragraph with IME composition never flashes H2 or duplicates text.
    act(() => {
      handle.replaceText("帮我做几件事", { start: 6, end: 6 });
    });
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}- ");

    await vi.waitFor(() => {
      const lines = container.querySelectorAll(".cm-line");
      expect(lines[0]?.classList.contains("cm-md-h2")).toBe(false);
      expect(lines[1]?.classList.contains("cm-md-bullet-line")).toBe(true);
      expect(lines[1]?.querySelector(".cm-md-bullet-widget")?.textContent).toBe("•");
    });

    await client.send("Input.imeSetComposition", {
      text: "ceshi",
      selectionStart: 5,
      selectionEnd: 5,
    });
    await vi.waitFor(() => {
      const line2 = container.querySelectorAll(".cm-line")[1];
      expect(handle.getText()).toBe("帮我做几件事\n- ceshi");
      expect(line2?.querySelectorAll(".cm-md-bullet-widget").length).toBe(1);
      expect(line2?.textContent).toBe("•ceshi");
    });

    await client.send("Input.insertText", { text: "测试" });
    await vi.waitFor(() => {
      const line2 = container.querySelectorAll(".cm-line")[1];
      expect(handle.getText()).toBe("帮我做几件事\n- 测试");
      expect(line2?.querySelectorAll(".cm-md-bullet-widget").length).toBe(1);
      expect(line2?.textContent).toBe("•测试");
    });
  });

  it("formats empty bullet and nested list prefixes after paragraphs without flashing Setext H2", () => {
    const mounted = mountEditor({ initialValue: "说明如下" });
    const { container, inputRef } = mounted;
    const handle = inputRef.current!;

    act(() => {
      handle.focus();
      handle.setSelection({ start: 4, end: 4 });
      handle.insertText?.("\n-");
    });
    // Bare `-` on the active line below a paragraph should not flash the paragraph into H2.
    expect(container.querySelector(".cm-line.cm-md-h2")).toBeNull();

    // Typing a second `-` turns it into an intentional Setext H2 heading.
    act(() => {
      handle.insertText?.("-");
    });
    expect(container.querySelector(".cm-line.cm-md-h2")?.textContent).toBe("说明如下");

    // Replacing with `- ` renders a clean bullet list item without turning line 1 into H2.
    act(() => {
      handle.replaceText("说明如下\n- ", { start: 7, end: 7 });
    });
    expect(container.querySelector(".cm-line.cm-md-h2")).toBeNull();
    expect(container.querySelector(".cm-line.cm-md-bullet-line")).not.toBeNull();
    expect(container.querySelector(".cm-md-bullet-widget")?.textContent).toBe("•");

    // `* `, `+ `, `1) `, nested lists, and quoted lists after paragraphs all preview immediately.
    for (const [sample, expectedGlyph] of [
      ["说明如下\n* ", "•"],
      ["说明如下\n+ ", "•"],
      ["1. first\n  - ", "◦"],
      ["> 引用说明\n> - ", "•"],
    ] as const) {
      act(() => {
        handle.replaceText(sample, { start: sample.length, end: sample.length });
      });
      expect(container.querySelector(".cm-md-bullet-widget")?.textContent).toBe(expectedGlyph);
    }

    for (const [sample, expectedMarker] of [
      ["说明如下\n1) ", "1)"],
      ["- item\n  1. ", "1."],
      ["> 引用说明\n> 1. ", "1."],
    ] as const) {
      act(() => {
        handle.replaceText(sample, { start: sample.length, end: sample.length });
      });
      expect(container.querySelector(".cm-md-ordered-widget")?.textContent).toBe(expectedMarker);
    }

    // Non-interrupting patterns (non-1 ordered after paragraph, 4-space indent, fenced code) stay plain.
    for (const nonList of ["说明如下\n2. ", "说明如下\n    1. ", "```\n说明如下\n1. \n```"]) {
      act(() => {
        handle.replaceText(nonList, { start: nonList.length, end: nonList.length });
      });
      expect(container.querySelector(".cm-md-ordered-widget")).toBeNull();
    }
  });

  it("defers brand-new replace widgets during IME composition until compositionend so prefixes never duplicate", async () => {
    const client = cdp();
    const mounted = mountEditor();
    const { container, inputRef } = mounted;
    const handle = inputRef.current!;

    act(() => {
      handle.focus();
    });

    // Type `1.` without space so no replace widget exists before composition begins.
    await userEvent.keyboard("1.");
    await vi.waitFor(() => {
      expect(handle.getText()).toBe("1.");
      expect(container.querySelector(".cm-md-ordered-widget")).toBeNull();
    });

    // IME composition introduces the space and pinyin in the same text node.
    await client.send("Input.imeSetComposition", {
      text: " ni",
      selectionStart: 3,
      selectionEnd: 3,
    });

    await vi.waitFor(() => {
      const line = container.querySelector(".cm-line");
      expect(handle.getText()).toBe("1. ni");
      expect(line?.querySelector(".cm-md-ordered-widget")).toBeNull();
      expect(line?.textContent).toBe("1. ni");
    });

    // Committing text ends composition and immediately applies the ordered list widget.
    await client.send("Input.insertText", { text: " 你" });

    await vi.waitFor(() => {
      const line = container.querySelector(".cm-line");
      expect(handle.getText()).toBe("1. 你");
      expect(line?.querySelectorAll(".cm-md-ordered-widget").length).toBe(1);
      expect(line?.textContent).toBe("1.你");
    });

    // Also verify committing identical text (no final DOM diff on compositionend) still refreshes.
    act(() => {
      handle.replaceText("1.", { start: 2, end: 2 });
    });
    await client.send("Input.imeSetComposition", {
      text: " ok",
      selectionStart: 3,
      selectionEnd: 3,
    });
    await vi.waitFor(() => {
      expect(handle.getText()).toBe("1. ok");
      expect(container.querySelector(".cm-md-ordered-widget")).toBeNull();
    });

    await client.send("Input.insertText", { text: " ok" });
    await vi.waitFor(() => {
      const line = container.querySelector(".cm-line");
      expect(handle.getText()).toBe("1. ok");
      expect(line?.querySelectorAll(".cm-md-ordered-widget").length).toBe(1);
      expect(line?.textContent).toBe("1.ok");
    });
  });
});
