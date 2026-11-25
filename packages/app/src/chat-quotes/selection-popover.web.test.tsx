// @vitest-environment jsdom

import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageSelectionPopoverSurface } from "./selection-popover.web";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("react-native-unistyles", () => ({
  withUnistyles: (
    Component: React.ComponentType<Record<string, unknown>>,
    mapTheme?: (theme: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const theme = {
      colors: {
        surface1: "#fafafa",
        border: "#e4e4e7",
        foreground: "#1a1a1e",
        accent: "#20744A",
      },
      fontFamily: {
        ui: "system-ui",
      },
    };
    return function MockedWithUnistyles(props: Record<string, unknown>) {
      const mapped = mapTheme ? mapTheme(theme) : {};
      return <Component {...mapped} {...props} />;
    };
  },
}));

function mockRangeRect(rect: Partial<DOMRect>) {
  const fullRect: DOMRect = {
    x: rect.left ?? 120,
    y: rect.top ?? 120,
    width: rect.width ?? 160,
    height: rect.height ?? 20,
    top: rect.top ?? 120,
    left: rect.left ?? 120,
    bottom: (rect.top ?? 120) + (rect.height ?? 20),
    right: (rect.left ?? 120) + (rect.width ?? 160),
    toJSON: () => ({}),
  };
  const proto = Range.prototype as unknown as {
    getBoundingClientRect?: () => DOMRect;
  };
  const original = proto.getBoundingClientRect;
  proto.getBoundingClientRect = () => fullRect;
  return {
    mockRestore: () => {
      if (original) {
        proto.getBoundingClientRect = original;
      } else {
        delete proto.getBoundingClientRect;
      }
    },
  };
}

describe("MessageSelectionPopoverSurface (web)", () => {
  afterEach(() => {
    window.getSelection()?.removeAllRanges();
    vi.restoreAllMocks();
  });

  it("shows floating Comment/Quote toolbar on message selection without clearing selection for copy", async () => {
    const rectSpy = mockRangeRect({ left: 200, top: 180, width: 120, height: 20 });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const onComment = vi.fn();
    const onQuote = vi.fn();

    const { getByTestId, queryByTestId } = render(
      <MessageSelectionPopoverSurface
        enabled
        onCommentSelection={onComment}
        onQuoteSelection={onQuote}
      >
        <div
          data-message-text="true"
          data-quote-role="assistant"
          data-quote-item-id="msg-assistant-1"
          data-quote-ts="1700000000000"
        >
          <p data-testid="assistant-para">Hello structured quote selection world</p>
        </div>
      </MessageSelectionPopoverSurface>,
    );

    const textNode = getByTestId("assistant-para").firstChild!;
    const range = document.createRange();
    range.setStart(textNode, 6);
    range.setEnd(textNode, 22);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    const popover = getByTestId("chat-selection-popover");
    expect(popover).toBeTruthy();
    // Native selection must remain intact so Cmd/Ctrl+C (assistant-selection-copy) keeps working.
    expect(window.getSelection()?.toString()).toBe("structured quote");

    fireEvent.mouseDown(getByTestId("selection-popover-comment"));
    fireEvent.click(getByTestId("selection-popover-comment"));

    expect(onComment).toHaveBeenCalledWith({
      text: "structured quote",
      role: "assistant",
      sourceItemId: "msg-assistant-1",
      ts: 1700000000000,
    });
    expect(queryByTestId("chat-selection-popover")).toBeNull();
    rectSpy.mockRestore();
  });

  it("supports Quote button action and ignores selections outside message text", async () => {
    mockRangeRect({ left: 40, top: 20, width: 100, height: 18 });
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      cb(0);
      return 1;
    });
    const onComment = vi.fn();
    const onQuote = vi.fn();

    const { getByTestId, queryByTestId } = render(
      <MessageSelectionPopoverSurface
        enabled
        onCommentSelection={onComment}
        onQuoteSelection={onQuote}
      >
        <div data-testid="non-message">Outside text</div>
        <div data-message-text="true" data-quote-role="user">
          <span data-testid="user-span">Important user snippet</span>
        </div>
      </MessageSelectionPopoverSurface>,
    );

    // Selecting outside data-message-text should not show the toolbar.
    const outsideNode = getByTestId("non-message").firstChild!;
    const outsideRange = document.createRange();
    outsideRange.selectNodeContents(outsideNode);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(outsideRange);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });
    expect(queryByTestId("chat-selection-popover")).toBeNull();

    // Selecting inside message text near the top flips placement to "below".
    const userNode = getByTestId("user-span").firstChild!;
    const userRange = document.createRange();
    userRange.selectNodeContents(userNode);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(userRange);
    await act(async () => {
      document.dispatchEvent(new Event("selectionchange"));
    });

    const popover = getByTestId("chat-selection-popover");
    expect(popover.getAttribute("data-placement")).toBe("below");

    fireEvent.click(getByTestId("selection-popover-quote"));
    expect(onQuote).toHaveBeenCalledWith({
      text: "Important user snippet",
      role: "user",
    });
  });
});
