import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import type {
  NativeSyntheticEvent,
  TextInputKeyPressEventData,
  TextInputSelectionChangeEventData,
} from "react-native";
import { withUnistyles } from "react-native-unistyles";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { Annotation, Compartment, EditorState, Prec, Transaction } from "@codemirror/state";
import { EditorView, drawSelection, keymap, placeholder as cmPlaceholder } from "@codemirror/view";
import type { EditingTextInputHandle, EditingTextInputProps } from "@/components/ui/text-input";
import type { Theme } from "@/styles/theme";
import {
  composerMarkdownDecorations,
  createComposerMarkdownLanguageExtension,
  createComposerMarkdownTheme,
  handleMarkdownBackspace,
  indentMarkdownListItem,
  insertMarkdownNewline,
  type ComposerMarkdownTheme,
} from "./markdown-language.web";

type WebKeyPressEvent = NativeSyntheticEvent<
  TextInputKeyPressEventData & {
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    isComposing?: boolean;
    keyCode?: number;
  }
>;

export interface ComposerMarkdownInputProps extends EditingTextInputProps {
  fullscreen?: boolean;
  compact?: boolean;
  minHeight?: number;
  maxHeight?: number;
  onRenderedLinesChange?: (lines: number) => void;
}

interface InternalProps extends ComposerMarkdownInputProps {
  editorTheme: ComposerMarkdownTheme;
}

const remoteUpdate = Annotation.define<boolean>();
const DEFAULT_MIN_HEIGHT = 40;
const DEFAULT_MAX_HEIGHT = 120;

function hasRemoteAnnotation(transactions: readonly Transaction[]): boolean {
  for (const tr of transactions) {
    if (tr.annotation(remoteUpdate)) return true;
  }
  return false;
}

function createLayoutTheme(options: {
  fullscreen: boolean;
  compact: boolean;
  minHeight: number;
  maxHeight: number;
}) {
  const { fullscreen, compact, minHeight, maxHeight } = options;
  return EditorView.theme({
    "&": fullscreen
      ? {
          height: "100%",
          flex: "1 1 auto",
          minHeight: "0",
          display: "flex",
          flexDirection: "column",
        }
      : {
          minHeight: `${minHeight}px`,
          maxHeight: `${maxHeight}px`,
          display: "flex",
          flexDirection: "column",
        },
    ".cm-scroller": {
      flex: "1 1 auto",
      minHeight: "0",
    },
    ".cm-content": compact && !fullscreen ? { paddingRight: "36px" } : { paddingRight: "0" },
  });
}

function buildContentAttributes(options: {
  accessibilityLabel?: string;
  testID?: string;
  dataSet?: Record<string, string>;
}): Record<string, string> {
  const attrs: Record<string, string> = {
    role: "textbox",
    "aria-multiline": "true",
    spellcheck: "true",
  };
  if (options.accessibilityLabel) {
    attrs["aria-label"] = options.accessibilityLabel;
  }
  if (options.testID) {
    attrs["data-testid"] = options.testID;
  }
  if (options.dataSet) {
    for (const [key, value] of Object.entries(options.dataSet)) {
      const kebab = key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
      attrs[`data-${kebab}`] = value;
    }
  }
  return attrs;
}

function clampSelection(
  selection: { start: number; end: number },
  length: number,
): { anchor: number; head: number } {
  const start = Math.max(0, Math.min(length, selection.start));
  const end = Math.max(0, Math.min(length, selection.end));
  return { anchor: start, head: end };
}

const ComposerMarkdownEditorBase = forwardRef<EditingTextInputHandle, InternalProps>(
  function ComposerMarkdownEditorBase(props, ref) {
    const {
      initialValue = "",
      onChangeText,
      placeholder = "",
      accessibilityLabel,
      onFocus,
      onBlur,
      editable = true,
      onKeyPress,
      onSelectionChange,
      fullscreen = false,
      compact = false,
      minHeight = DEFAULT_MIN_HEIGHT,
      maxHeight = DEFAULT_MAX_HEIGHT,
      onRenderedLinesChange,
      testID,
      dataSet,
      autoFocus = false,
      editorTheme,
    } = props;

    const viewRef = useRef<EditorView | null>(null);
    const initialTextRef = useRef(initialValue);
    const textRef = useRef(initialTextRef.current);
    const lastReportedTextRef = useRef(initialTextRef.current);
    const isComposingRef = useRef(false);
    const lastReportedLinesRef = useRef<number | null>(null);

    const onChangeTextRef = useRef(onChangeText);
    onChangeTextRef.current = onChangeText;
    const onFocusRef = useRef(onFocus);
    onFocusRef.current = onFocus;
    const onBlurRef = useRef(onBlur);
    onBlurRef.current = onBlur;
    const onKeyPressRef = useRef(onKeyPress);
    onKeyPressRef.current = onKeyPress;
    const onSelectionChangeRef = useRef(onSelectionChange);
    onSelectionChangeRef.current = onSelectionChange;
    const onRenderedLinesChangeRef = useRef(onRenderedLinesChange);
    onRenderedLinesChangeRef.current = onRenderedLinesChange;
    const contentFontSizeRef = useRef(editorTheme.contentFontSize);
    contentFontSizeRef.current = editorTheme.contentFontSize;

    const compartmentsRef = useRef<{
      history: Compartment;
      theme: Compartment;
      layout: Compartment;
      placeholder: Compartment;
      editable: Compartment;
      contentAttrs: Compartment;
    } | null>(null);
    if (!compartmentsRef.current) {
      compartmentsRef.current = {
        history: new Compartment(),
        theme: new Compartment(),
        layout: new Compartment(),
        placeholder: new Compartment(),
        editable: new Compartment(),
        contentAttrs: new Compartment(),
      };
    }

    const latestConfigRef = useRef({
      editorTheme,
      fullscreen,
      compact,
      minHeight,
      maxHeight,
      placeholder,
      editable,
      accessibilityLabel,
      testID,
      dataSet: dataSet as Record<string, string> | undefined,
      autoFocus,
    });
    latestConfigRef.current = {
      editorTheme,
      fullscreen,
      compact,
      minHeight,
      maxHeight,
      placeholder,
      editable,
      accessibilityLabel,
      testID,
      dataSet: dataSet as Record<string, string> | undefined,
      autoFocus,
    };

    const reportRenderedLines = useCallback((view: EditorView) => {
      const callback = onRenderedLinesChangeRef.current;
      if (!callback) return;
      const baseLineHeight = Math.max(1, contentFontSizeRef.current * 1.4);
      const nextLines = Math.max(1, Math.round(view.contentHeight / baseLineHeight));
      if (lastReportedLinesRef.current === nextLines) return;
      lastReportedLinesRef.current = nextLines;
      callback(nextLines);
    }, []);

    const flushCommittedText = useCallback((view: EditorView) => {
      const nextText = view.state.doc.toString();
      textRef.current = nextText;
      if (nextText === lastReportedTextRef.current) return;
      lastReportedTextRef.current = nextText;
      onChangeTextRef.current?.(nextText);
    }, []);

    // Initialize synchronously in the host ref callback so parent ref callbacks (such as
    // usePasteEffect and focusWithRetries) observe the live contentDOM immediately on mount.
    const assignHost = useCallback(
      (host: HTMLDivElement | null) => {
        const previous = viewRef.current;
        if (!host) {
          if (previous) {
            previous.destroy();
            viewRef.current = null;
          }
          return;
        }
        if (previous) {
          if (previous.dom.parentElement === host) return;
          previous.destroy();
          viewRef.current = null;
        }

        const config = latestConfigRef.current;
        const compartments = compartmentsRef.current!;

        const keydownBridge = Prec.highest(
          EditorView.domEventHandlers({
            keydown(event, view) {
              if (event.isComposing || view.composing || event.keyCode === 229) {
                return false;
              }
              const handler = onKeyPressRef.current;
              if (!handler) return false;
              let prevented = false;
              const syntheticEvent = {
                nativeEvent: {
                  key: event.key,
                  metaKey: event.metaKey,
                  ctrlKey: event.ctrlKey,
                  shiftKey: event.shiftKey,
                  altKey: event.altKey,
                  isComposing: event.isComposing,
                  keyCode: event.keyCode,
                },
                preventDefault: () => {
                  prevented = true;
                  event.preventDefault();
                },
                stopPropagation: () => {
                  event.stopPropagation();
                },
              } as unknown as WebKeyPressEvent;
              handler(syntheticEvent);
              return prevented;
            },
            compositionstart() {
              isComposingRef.current = true;
              return false;
            },
            compositionend(_event, view) {
              isComposingRef.current = false;
              queueMicrotask(() => {
                if (viewRef.current === view && !isComposingRef.current && !view.composing) {
                  flushCommittedText(view);
                }
              });
              return false;
            },
            focus() {
              onFocusRef.current?.({} as never);
              return false;
            },
            blur() {
              onBlurRef.current?.({} as never);
              return false;
            },
          }),
        );

        const state = EditorState.create({
          doc: textRef.current,
          extensions: [
            EditorView.lineWrapping,
            compartments.history.of(history()),
            drawSelection(),
            createComposerMarkdownLanguageExtension(),
            composerMarkdownDecorations,
            compartments.theme.of(createComposerMarkdownTheme(config.editorTheme)),
            compartments.layout.of(
              createLayoutTheme({
                fullscreen: config.fullscreen,
                compact: config.compact,
                minHeight: config.minHeight,
                maxHeight: config.maxHeight,
              }),
            ),
            compartments.placeholder.of(
              config.placeholder ? cmPlaceholder(config.placeholder) : [],
            ),
            compartments.editable.of([
              EditorView.editable.of(config.editable),
              EditorState.readOnly.of(!config.editable),
            ]),
            compartments.contentAttrs.of(
              EditorView.contentAttributes.of(
                buildContentAttributes({
                  accessibilityLabel: config.accessibilityLabel,
                  testID: config.testID,
                  dataSet: config.dataSet,
                }),
              ),
            ),
            keydownBridge,
            keymap.of([
              { key: "Enter", run: insertMarkdownNewline },
              { key: "Shift-Enter", run: insertMarkdownNewline },
              { key: "Backspace", run: handleMarkdownBackspace },
              { key: "Tab", run: indentMarkdownListItem },
              ...defaultKeymap,
              ...historyKeymap,
            ]),
            EditorView.updateListener.of((update) => {
              const isRemote = hasRemoteAnnotation(update.transactions);
              if (update.docChanged) {
                const nextText = update.state.doc.toString();
                textRef.current = nextText;
                if (!isRemote && !isComposingRef.current && !update.view.composing) {
                  if (nextText !== lastReportedTextRef.current) {
                    lastReportedTextRef.current = nextText;
                    onChangeTextRef.current?.(nextText);
                  }
                }
              }
              if ((update.selectionSet || update.docChanged) && !isRemote) {
                const main = update.state.selection.main;
                const start = Math.min(main.anchor, main.head);
                const end = Math.max(main.anchor, main.head);
                onSelectionChangeRef.current?.({
                  nativeEvent: { selection: { start, end } },
                } as NativeSyntheticEvent<TextInputSelectionChangeEventData>);
              }
              if (update.docChanged || update.geometryChanged) {
                reportRenderedLines(update.view);
              }
            }),
          ],
        });

        const view = new EditorView({ parent: host, state });
        viewRef.current = view;
        reportRenderedLines(view);
        if (config.autoFocus) {
          view.focus();
        }
      },
      [flushCommittedText, reportRenderedLines],
    );

    useEffect(() => {
      const view = viewRef.current;
      if (!view) return;
      view.dispatch({
        effects: compartmentsRef.current!.theme.reconfigure(
          createComposerMarkdownTheme(editorTheme),
        ),
      });
      reportRenderedLines(view);
    }, [editorTheme, reportRenderedLines]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartmentsRef.current!.layout.reconfigure(
          createLayoutTheme({ fullscreen, compact, minHeight, maxHeight }),
        ),
      });
    }, [fullscreen, compact, minHeight, maxHeight]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartmentsRef.current!.placeholder.reconfigure(
          placeholder ? cmPlaceholder(placeholder) : [],
        ),
      });
    }, [placeholder]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartmentsRef.current!.editable.reconfigure([
          EditorView.editable.of(editable),
          EditorState.readOnly.of(!editable),
        ]),
      });
    }, [editable]);

    useEffect(() => {
      viewRef.current?.dispatch({
        effects: compartmentsRef.current!.contentAttrs.reconfigure(
          EditorView.contentAttributes.of(
            buildContentAttributes({
              accessibilityLabel,
              testID,
              dataSet: dataSet as Record<string, string> | undefined,
            }),
          ),
        ),
      });
    }, [accessibilityLabel, testID, dataSet]);

    useImperativeHandle(
      ref,
      () => ({
        focus: () => viewRef.current?.focus(),
        blur: () => viewRef.current?.contentDOM.blur(),
        isFocused: () => {
          const view = viewRef.current;
          if (!view) return false;
          return view.hasFocus || document.activeElement === view.contentDOM;
        },
        getText: () => {
          const view = viewRef.current;
          if (!view) return textRef.current;
          const nextText = view.state.doc.toString();
          textRef.current = nextText;
          return nextText;
        },
        getSelection: () => {
          const view = viewRef.current;
          if (!view) {
            const length = textRef.current.length;
            return { start: length, end: length };
          }
          const main = view.state.selection.main;
          return {
            start: Math.min(main.anchor, main.head),
            end: Math.max(main.anchor, main.head),
          };
        },
        insertText: (text: string) => {
          const view = viewRef.current;
          if (!view) return false;
          view.focus();
          const transaction = view.state.replaceSelection(text);
          view.dispatch(transaction, {
            scrollIntoView: true,
            userEvent: "input.paste",
          });
          return true;
        },
        replaceText: (nextText, selection) => {
          textRef.current = nextText;
          lastReportedTextRef.current = nextText;
          const view = viewRef.current;
          if (!view) return;
          const docLength = view.state.doc.length;
          const nextSelection = selection
            ? clampSelection(selection, nextText.length)
            : { anchor: nextText.length, head: nextText.length };
          view.dispatch({
            changes: { from: 0, to: docLength, insert: nextText },
            selection: nextSelection,
            annotations: [remoteUpdate.of(true)],
            scrollIntoView: true,
          });
        },
        setSelection: (selection) => {
          const view = viewRef.current;
          if (!view) return;
          const nextSelection = clampSelection(selection, view.state.doc.length);
          view.dispatch({
            selection: nextSelection,
            annotations: [remoteUpdate.of(true)],
            scrollIntoView: true,
          });
        },
        reset: () => {
          textRef.current = "";
          lastReportedTextRef.current = "";
          const view = viewRef.current;
          if (!view) return;
          const wasFocused = view.hasFocus || document.activeElement === view.contentDOM;
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: "" },
            selection: { anchor: 0, head: 0 },
            effects: compartmentsRef.current!.history.reconfigure(history()),
            annotations: [remoteUpdate.of(true), Transaction.addToHistory.of(false)],
          });
          if (wasFocused) view.focus();
        },
        getNativeRef: () => viewRef.current?.contentDOM ?? null,
      }),
      [],
    );

    const handleHostMouseDown = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        if (!editable) return;
        const view = viewRef.current;
        if (!view) return;
        // Clicking empty space below the last line focuses the editor just like a native textarea.
        if (event.target === event.currentTarget || event.target === view.scrollDOM) {
          event.preventDefault();
          const end = view.state.doc.length;
          view.dispatch({ selection: { anchor: end, head: end } });
          view.focus();
        }
      },
      [editable],
    );

    const hostStyle = useMemo<React.CSSProperties>(
      () =>
        fullscreen
          ? {
              width: "100%",
              flex: 1,
              height: "100%",
              minHeight: 0,
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              cursor: editable ? "text" : "default",
            }
          : {
              width: "100%",
              minHeight: `${minHeight}px`,
              maxHeight: `${maxHeight}px`,
              minWidth: 0,
              flexShrink: 1,
              display: "flex",
              flexDirection: "column",
              cursor: editable ? "text" : "default",
            },
      [editable, fullscreen, maxHeight, minHeight],
    );

    return <div ref={assignHost} style={hostStyle} onMouseDown={handleHostMouseDown} />;
  },
);

const composerMarkdownAppearance = (theme: Theme) => ({
  editorTheme: {
    colorScheme: theme.colorScheme,
    foreground: theme.colors.foreground,
    foregroundMuted: theme.colors.foregroundMuted,
    foregroundExtraMuted: theme.colors.foregroundExtraMuted,
    accent: theme.colors.accent,
    accentBright: theme.colors.accentBright,
    accentForeground: theme.colors.accentForeground,
    border: theme.colors.border,
    codeBackground: theme.colors.surface2,
    selection: theme.colors.terminal.selectionBackground,
    cursor: theme.colors.terminal.cursor,
    uiFont: theme.fontFamily.ui,
    monoFont: theme.fontFamily.mono,
    contentFontSize: theme.fontSize.content,
    codeFontSize: theme.fontSize.code,
    syntax: theme.colors.syntax,
  },
});

export const ComposerMarkdownInput = withUnistyles(
  ComposerMarkdownEditorBase,
  composerMarkdownAppearance,
);
