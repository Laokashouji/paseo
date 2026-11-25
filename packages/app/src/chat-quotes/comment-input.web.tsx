import {
  memo,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { MAX_COMMENT_CHARS } from "./types";
import type { QuoteCommentInputProps } from "./comment-input";

const MAX_TEXTAREA_HEIGHT_PX = 96;

interface ThemedCommentTextareaProps extends QuoteCommentInputProps {
  accentColor: string;
  surfaceColor: string;
  foregroundColor: string;
  fontFamily: string;
}

const CommentTextareaInner = memo(function CommentTextareaInner({
  value,
  placeholder,
  accessibilityLabel,
  testID,
  onChangeText,
  onCommit,
  onCancel,
  accentColor,
  surfaceColor,
  foregroundColor,
  fontFamily,
}: ThemedCommentTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const settledRef = useRef(false);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_HEIGHT_PX)}px`;
  }, [value]);

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      onChangeText(event.target.value);
    },
    [onChangeText],
  );

  const handleCompositionStart = useCallback(() => {
    composingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    composingRef.current = false;
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      const native = event.nativeEvent;
      if (composingRef.current || native.isComposing || native.keyCode === 229) {
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        settledRef.current = true;
        onCommit();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        settledRef.current = true;
        onCancel();
      }
    },
    [onCancel, onCommit],
  );

  const handleBlur = useCallback(() => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    onCommit();
  }, [onCommit]);

  const textareaStyle = useMemo<CSSProperties>(
    () => ({
      width: "100%",
      boxSizing: "border-box",
      resize: "none",
      overflowY: "auto",
      minHeight: 30,
      maxHeight: MAX_TEXTAREA_HEIGHT_PX,
      borderRadius: 8,
      border: `1.5px solid ${accentColor}`,
      backgroundColor: surfaceColor,
      color: foregroundColor,
      fontFamily,
      fontSize: 13,
      lineHeight: "19px",
      padding: "5px 8px",
      outline: "none",
      display: "block",
    }),
    [accentColor, fontFamily, foregroundColor, surfaceColor],
  );

  return (
    <textarea
      ref={textareaRef}
      value={value}
      rows={1}
      maxLength={MAX_COMMENT_CHARS}
      aria-label={accessibilityLabel}
      placeholder={placeholder}
      data-testid={testID}
      onChange={handleChange}
      onCompositionStart={handleCompositionStart}
      onCompositionEnd={handleCompositionEnd}
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      style={textareaStyle}
    />
  );
});

const ThemedCommentTextarea = withUnistyles(CommentTextareaInner, (theme: Theme) => ({
  accentColor: theme.colors.accent,
  surfaceColor: theme.colors.surface0,
  foregroundColor: theme.colors.foreground,
  fontFamily: theme.fontFamily.ui,
}));

/**
 * Web/Electron inline annotation textarea with full CJK IME composition safety.
 * Never commits or cancels while `isComposing` is true or `keyCode === 229`.
 */
export const QuoteCommentInput = memo(function QuoteCommentInput(props: QuoteCommentInputProps) {
  return <ThemedCommentTextarea {...props} />;
});
