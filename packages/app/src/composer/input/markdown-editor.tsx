import { forwardRef } from "react";
import { withUnistyles } from "react-native-unistyles";
import {
  EditingTextInput,
  type EditingTextInputHandle,
  type EditingTextInputProps,
} from "@/components/ui/text-input";

const ThemedEditingTextInput = withUnistyles(EditingTextInput, (theme) => ({
  placeholderTextColor: theme.colors.foregroundExtraMuted,
}));

export interface ComposerMarkdownInputProps extends EditingTextInputProps {
  fullscreen?: boolean;
  compact?: boolean;
  minHeight?: number;
  maxHeight?: number;
  onRenderedLinesChange?: (lines: number) => void;
}

/**
 * Native platforms stay on the platform EditingTextInput (PasteInput / TextInput) so
 * image pasting, hardware keyboard hooks, and Fabric measurement remain untouched.
 */
export const ComposerMarkdownInput = forwardRef<EditingTextInputHandle, ComposerMarkdownInputProps>(
  function ComposerMarkdownInputNative(
    {
      fullscreen: _fullscreen,
      compact: _compact,
      minHeight: _minHeight,
      maxHeight: _maxHeight,
      onRenderedLinesChange: _onRenderedLinesChange,
      ...props
    },
    ref,
  ) {
    return <ThemedEditingTextInput {...props} ref={ref} />;
  },
);
