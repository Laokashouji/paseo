import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
        maxHeight={160}
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

describe("ComposerMarkdownInput (web B1 Markdown styling)", () => {
  it("renders B1 syntax classes and computed typography while keeping raw Markdown text", () => {
    const sample = [
      "# Main Heading",
      "## Sub Heading",
      "**bold** *italic* ~~strike~~ `inline()` [docs](https://example.com)",
      "> quoted thought",
      "- [x] completed task",
      "```ts",
      "const count = 42;",
      "```",
    ].join("\n");

    const mounted = mountEditor({ initialValue: sample });
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
    const taskMark = container.querySelector(".cm-md-task-mark") as HTMLElement | null;
    const link = container.querySelector(".cm-md-link") as HTMLElement | null;
    const url = container.querySelector(".cm-md-url") as HTMLElement | null;
    const codeLines = container.querySelectorAll(".cm-line.cm-md-codeblock-line");
    const firstCodeLine = container.querySelector(".cm-line.cm-md-codeblock-first");
    const lastCodeLine = container.querySelector(".cm-line.cm-md-codeblock-last");
    const mutedMarks = container.querySelectorAll(".cm-md-mark");

    expect(h1).not.toBeNull();
    expect(h2).not.toBeNull();
    expect(strong?.textContent).toBe("**bold**");
    expect(em?.textContent).toBe("*italic*");
    expect(strike?.textContent).toBe("~~strike~~");
    expect(inlineCode?.textContent).toBe("`inline()`");
    expect(blockquote).not.toBeNull();
    expect(taskMark?.textContent).toBe("[x]");
    expect(link).not.toBeNull();
    expect(url?.textContent).toBe("https://example.com");
    expect(codeLines.length).toBe(3);
    expect(firstCodeLine).not.toBeNull();
    expect(lastCodeLine).not.toBeNull();
    expect(mutedMarks.length).toBeGreaterThan(0);

    const baseFontSize = Number.parseFloat(getComputedStyle(content).fontSize);
    const h1FontSize = Number.parseFloat(getComputedStyle(h1!).fontSize);
    expect(h1FontSize).toBeGreaterThan(baseFontSize);
    expect(Number.parseInt(getComputedStyle(strong!).fontWeight, 10)).toBeGreaterThanOrEqual(700);
    expect(getComputedStyle(em!).fontStyle).toBe("italic");
    expect(getComputedStyle(inlineCode!).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
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
    expect(document.activeElement).toBe(mounted.content);
  });

  it("bridges keydown to onKeyPress and respects preventDefault vs Shift+Enter list continuation", () => {
    const changes: string[] = [];
    const interceptedKeys: string[] = [];
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
    const mounted = mountEditor({ initialValue: "hello" });
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      mounted.inputRef.current?.focus();
      mounted.content.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(mounted.inputRef.current?.getText()).toBe("hello");
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
});
