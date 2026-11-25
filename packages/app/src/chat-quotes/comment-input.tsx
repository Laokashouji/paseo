import { memo, useEffect, useRef } from "react";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import type { Theme } from "@/styles/theme";
import { MAX_COMMENT_CHARS } from "./types";

const ThemedEditingTextInput = withUnistyles(EditingTextInput);
const placeholderColorMapping = (theme: Theme) => ({
  placeholderTextColor: theme.colors.foregroundMuted,
});

export interface QuoteCommentInputProps {
  value: string;
  placeholder: string;
  accessibilityLabel: string;
  testID?: string;
  onChangeText: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export const QuoteCommentInput = memo(function QuoteCommentInput({
  value,
  placeholder,
  accessibilityLabel,
  testID,
  onChangeText,
  onCommit,
}: QuoteCommentInputProps) {
  const inputRef = useRef<EditingTextInputHandle>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <ThemedEditingTextInput
      ref={inputRef}
      initialValue={value}
      onChangeText={onChangeText}
      onBlur={onCommit}
      onSubmitEditing={onCommit}
      placeholder={placeholder}
      uniProps={placeholderColorMapping}
      accessibilityLabel={accessibilityLabel}
      maxLength={MAX_COMMENT_CHARS}
      multiline
      style={styles.input}
      testID={testID}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  input: {
    width: "100%",
    minHeight: 32,
    maxHeight: 96,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    lineHeight: 18,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
}));
