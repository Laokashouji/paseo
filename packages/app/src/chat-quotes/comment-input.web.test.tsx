// @vitest-environment jsdom

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QuoteCommentInput } from "./comment-input.web";

vi.mock("react-native-unistyles", () => ({
  withUnistyles: (
    Component: React.ComponentType<Record<string, unknown>>,
    mapTheme?: (theme: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const theme = {
      colors: {
        accent: "#20744A",
        surface0: "#ffffff",
        foreground: "#1a1a1e",
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

describe("QuoteCommentInput (web IME safety)", () => {
  it("does not commit on Enter while Chinese IME composition is active", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const onChangeText = vi.fn();

    const { getByTestId } = render(
      <QuoteCommentInput
        value="nihao"
        placeholder="Add note"
        accessibilityLabel="Comment #1"
        testID="ime-comment-input"
        onChangeText={onChangeText}
        onCommit={onCommit}
        onCancel={onCancel}
      />,
    );

    const textarea = getByTestId("ime-comment-input");
    fireEvent.compositionStart(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", isComposing: true });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter", keyCode: 229 });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea);
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onCommit).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: false });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("cancels on Escape and stops event propagation", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    const parentKeyDown = vi.fn();

    const { getByTestId } = render(
      <div onKeyDown={parentKeyDown}>
        <QuoteCommentInput
          value=""
          placeholder="Add note"
          accessibilityLabel="Comment #1"
          testID="esc-comment-input"
          onChangeText={vi.fn()}
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </div>,
    );

    const textarea = getByTestId("esc-comment-input");
    fireEvent.keyDown(textarea, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
    expect(parentKeyDown).not.toHaveBeenCalled();
  });
});
