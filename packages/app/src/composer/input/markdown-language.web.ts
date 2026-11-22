import { syntaxHighlighting, syntaxTree } from "@codemirror/language";
import type { Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import {
  createCodeMirrorHighlightStyle,
  getLanguageForFile,
  type HighlightStyle,
} from "@getpaseo/highlight";

export interface ComposerMarkdownTheme {
  colorScheme: "light" | "dark";
  foreground: string;
  foregroundMuted: string;
  foregroundExtraMuted: string;
  accentBright: string;
  border: string;
  codeBackground: string;
  selection: string;
  cursor: string;
  uiFont: string;
  monoFont: string;
  contentFontSize: number;
  codeFontSize: number;
  syntax: Record<HighlightStyle, string>;
}

const HEADING_LINE_CLASSES: Record<string, string> = {
  ATXHeading1: "cm-md-h1",
  ATXHeading2: "cm-md-h2",
  ATXHeading3: "cm-md-h3",
  ATXHeading4: "cm-md-h4",
  ATXHeading5: "cm-md-h5",
  ATXHeading6: "cm-md-h6",
  SetextHeading1: "cm-md-h1",
  SetextHeading2: "cm-md-h2",
};

const MARK_DECORATION = Decoration.mark({ class: "cm-md-mark" });
const CODE_MARK_DECORATION = Decoration.mark({ class: "cm-md-code-mark" });
const CODE_INFO_DECORATION = Decoration.mark({ class: "cm-md-code-info" });
const STRONG_DECORATION = Decoration.mark({ class: "cm-md-strong" });
const EMPHASIS_DECORATION = Decoration.mark({ class: "cm-md-em" });
const STRIKE_DECORATION = Decoration.mark({ class: "cm-md-strike" });
const INLINE_CODE_DECORATION = Decoration.mark({ class: "cm-md-inline-code" });
const LIST_MARK_DECORATION = Decoration.mark({ class: "cm-md-list-mark" });
const TASK_MARK_DECORATION = Decoration.mark({ class: "cm-md-task-mark" });
const LINK_DECORATION = Decoration.mark({ class: "cm-md-link" });
const URL_DECORATION = Decoration.mark({ class: "cm-md-url" });

const BLOCKQUOTE_LINE_DECORATION = Decoration.line({ class: "cm-md-blockquote-line" });
const HR_LINE_DECORATION = Decoration.line({ class: "cm-md-hr-line" });
const TABLE_LINE_DECORATION = Decoration.line({ class: "cm-md-table-line" });
const TABLE_HEADER_LINE_DECORATION = Decoration.line({ class: "cm-md-table-header" });
const CODEBLOCK_LINE_DECORATION = Decoration.line({ class: "cm-md-codeblock-line" });
const CODEBLOCK_FIRST_DECORATION = Decoration.line({ class: "cm-md-codeblock-first" });
const CODEBLOCK_LAST_DECORATION = Decoration.line({ class: "cm-md-codeblock-last" });

const HEADING_DECORATIONS = Object.fromEntries(
  Object.entries(HEADING_LINE_CLASSES).map(([nodeName, className]) => [
    nodeName,
    Decoration.line({ class: className }),
  ]),
);

const BLOCK_LINE_DECORATIONS: Record<string, Decoration> = {
  Blockquote: BLOCKQUOTE_LINE_DECORATION,
  Table: TABLE_LINE_DECORATION,
  TableHeader: TABLE_HEADER_LINE_DECORATION,
};

const INLINE_DECORATIONS: Record<string, Decoration> = {
  HeaderMark: MARK_DECORATION,
  EmphasisMark: MARK_DECORATION,
  QuoteMark: MARK_DECORATION,
  LinkMark: MARK_DECORATION,
  StrikethroughMark: MARK_DECORATION,
  TableDelimiter: MARK_DECORATION,
  CodeMark: CODE_MARK_DECORATION,
  CodeInfo: CODE_INFO_DECORATION,
  StrongEmphasis: STRONG_DECORATION,
  Emphasis: EMPHASIS_DECORATION,
  Strikethrough: STRIKE_DECORATION,
  InlineCode: INLINE_CODE_DECORATION,
  ListMark: LIST_MARK_DECORATION,
  TaskMarker: TASK_MARK_DECORATION,
  Link: LINK_DECORATION,
  Autolink: LINK_DECORATION,
  URL: URL_DECORATION,
};

function forEachBlockLine(
  view: EditorView,
  blockFrom: number,
  blockTo: number,
  visibleFrom: number,
  visibleTo: number,
  decorateLine: (lineFrom: number, isFirst: boolean, isLast: boolean) => void,
): void {
  const doc = view.state.doc;
  const firstBlockLine = doc.lineAt(blockFrom);
  const clampedEnd = Math.max(blockFrom, blockTo > blockFrom ? blockTo - 1 : blockTo);
  const lastBlockLine = doc.lineAt(clampedEnd);

  const startPos = Math.max(firstBlockLine.from, visibleFrom);
  const endPos = Math.min(lastBlockLine.to, visibleTo);
  if (startPos > endPos) return;

  let line = doc.lineAt(startPos);
  while (true) {
    decorateLine(
      line.from,
      line.number === firstBlockLine.number,
      line.number === lastBlockLine.number,
    );
    if (line.to >= endPos || line.number >= doc.lines) break;
    line = doc.line(line.number + 1);
  }
}

export function buildMarkdownDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter(node) {
        const name = node.name;

        const headingDecoration = HEADING_DECORATIONS[name];
        if (headingDecoration) {
          const isSetext = name.startsWith("Setext");
          const blockEnd = isSetext
            ? Math.max(node.from, (node.node.getChild("HeaderMark")?.from ?? node.to) - 1)
            : node.to;
          forEachBlockLine(view, node.from, blockEnd, from, to, (lineFrom) => {
            ranges.push(headingDecoration.range(lineFrom));
          });
          return;
        }

        if (name === "FencedCode") {
          forEachBlockLine(view, node.from, node.to, from, to, (lineFrom, isFirst, isLast) => {
            ranges.push(CODEBLOCK_LINE_DECORATION.range(lineFrom));
            if (isFirst) ranges.push(CODEBLOCK_FIRST_DECORATION.range(lineFrom));
            if (isLast) ranges.push(CODEBLOCK_LAST_DECORATION.range(lineFrom));
          });
          return;
        }

        const blockDecoration = BLOCK_LINE_DECORATIONS[name];
        if (blockDecoration) {
          forEachBlockLine(view, node.from, node.to, from, to, (lineFrom) => {
            ranges.push(blockDecoration.range(lineFrom));
          });
          return;
        }

        if (name === "HorizontalRule") {
          const line = view.state.doc.lineAt(node.from);
          ranges.push(HR_LINE_DECORATION.range(line.from));
          if (node.from < node.to) {
            ranges.push(MARK_DECORATION.range(node.from, node.to));
          }
          return;
        }

        if (node.from >= node.to) return;

        const inlineDecoration = INLINE_DECORATIONS[name];
        if (inlineDecoration) {
          ranges.push(inlineDecoration.range(node.from, node.to));
        }
      },
    });
  }

  return Decoration.set(ranges, true);
}

export const composerMarkdownDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildMarkdownDecorations(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        this.decorations = buildMarkdownDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

export function createComposerMarkdownLanguageExtension() {
  return getLanguageForFile("composer.md")?.extension ?? [];
}

export function createComposerMarkdownTheme(theme: ComposerMarkdownTheme) {
  const composerSyntaxColors: Record<HighlightStyle, string> = {
    ...theme.syntax,
    heading: theme.foreground,
    link: theme.accentBright,
    meta: theme.foregroundExtraMuted,
  };
  return [
    EditorView.theme(
      {
        "&": {
          width: "100%",
          backgroundColor: "transparent",
          color: theme.foreground,
          fontFamily: theme.uiFont,
          fontSize: `${theme.contentFontSize}px`,
          fontWeight: "400",
        },
        "&.cm-focused": {
          outline: "none",
        },
        ".cm-scroller": {
          overflowX: "hidden",
          overflowY: "auto",
          scrollbarGutter: "stable",
          fontFamily: theme.uiFont,
          lineHeight: "1.4",
        },
        ".cm-content": {
          padding: "0",
          minHeight: "100%",
          caretColor: theme.cursor,
        },
        ".cm-line": {
          padding: "0",
          overflowWrap: "anywhere",
          wordBreak: "break-word",
        },
        ".cm-placeholder": {
          color: theme.foregroundExtraMuted,
          pointerEvents: "none",
        },
        ".cm-cursor, .cm-dropCursor": {
          borderLeftColor: theme.cursor,
        },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
          backgroundColor: theme.selection,
        },
        ".cm-selectionBackground, ::selection": {
          backgroundColor: theme.selection,
        },
        // Headings — restrained hierarchy matching MarkdownRenderer's foreground heading tone
        ".cm-line.cm-md-h1": {
          fontSize: "1.32em",
          lineHeight: "1.32",
          fontWeight: "700",
        },
        ".cm-line.cm-md-h2": {
          fontSize: "1.18em",
          lineHeight: "1.34",
          fontWeight: "700",
        },
        ".cm-line.cm-md-h3": {
          fontSize: "1.08em",
          lineHeight: "1.36",
          fontWeight: "600",
        },
        ".cm-line.cm-md-h4": {
          fontSize: "1.02em",
          lineHeight: "1.38",
          fontWeight: "600",
        },
        ".cm-line.cm-md-h5": {
          fontSize: "1em",
          lineHeight: "1.4",
          fontWeight: "600",
        },
        ".cm-line.cm-md-h6": {
          fontSize: "1em",
          lineHeight: "1.4",
          fontWeight: "600",
          color: theme.foregroundMuted,
        },
        // Inline emphasis & links
        ".cm-md-strong": {
          fontWeight: "700",
        },
        ".cm-md-em": {
          fontStyle: "italic",
        },
        ".cm-md-strike": {
          textDecoration: "line-through",
          color: theme.foregroundMuted,
        },
        ".cm-md-inline-code": {
          fontFamily: theme.monoFont,
          fontSize: `${Math.max(11, theme.codeFontSize)}px`,
          backgroundColor: theme.codeBackground,
          borderRadius: "4px",
          padding: "1px 4px",
        },
        ".cm-md-link": {
          color: theme.accentBright,
        },
        ".cm-md-url, .cm-md-url span": {
          color: theme.foregroundMuted,
          textDecoration: "underline",
          textDecorationStyle: "dotted",
          textUnderlineOffset: "2px",
        },
        // Lists & tasks
        ".cm-md-list-mark, .cm-md-list-mark span": {
          color: theme.accentBright,
          fontWeight: "600",
        },
        ".cm-md-task-mark, .cm-md-task-mark span": {
          fontFamily: theme.monoFont,
          color: theme.accentBright,
          fontWeight: "600",
        },
        // Muted syntax delimiters (visible for editing, visually stepped back)
        ".cm-md-mark, .cm-md-mark span": {
          color: theme.foregroundExtraMuted,
          fontWeight: "400",
          fontStyle: "normal",
          textDecoration: "none",
        },
        ".cm-md-code-mark, .cm-md-code-mark span": {
          fontFamily: theme.monoFont,
          color: theme.foregroundExtraMuted,
          fontWeight: "400",
        },
        ".cm-md-code-info, .cm-md-code-info span": {
          fontFamily: theme.monoFont,
          color: theme.foregroundMuted,
          fontStyle: "italic",
        },
        // Block-level surfaces
        ".cm-line.cm-md-codeblock-line": {
          backgroundColor: theme.codeBackground,
          fontFamily: theme.monoFont,
          fontSize: `${theme.codeFontSize}px`,
          lineHeight: `${Math.round(theme.codeFontSize * 1.55)}px`,
          paddingLeft: "10px",
          paddingRight: "10px",
          boxShadow: `0 0.5px 0 0 ${theme.codeBackground}`,
        },
        ".cm-line.cm-md-codeblock-first": {
          borderTopLeftRadius: "6px",
          borderTopRightRadius: "6px",
          paddingTop: "4px",
          marginTop: "3px",
        },
        ".cm-line.cm-md-codeblock-last": {
          borderBottomLeftRadius: "6px",
          borderBottomRightRadius: "6px",
          paddingBottom: "4px",
          marginBottom: "3px",
          boxShadow: "none",
        },
        ".cm-line.cm-md-blockquote-line": {
          borderLeft: `3px solid ${theme.foregroundExtraMuted}`,
          paddingLeft: "10px",
          color: theme.foregroundMuted,
        },
        ".cm-line.cm-md-table-line": {
          fontFamily: theme.monoFont,
          fontSize: `${theme.codeFontSize}px`,
        },
        ".cm-line.cm-md-table-header": {
          fontWeight: "600",
        },
        ".cm-line.cm-md-hr-line": {
          color: theme.foregroundExtraMuted,
        },
      },
      { dark: theme.colorScheme === "dark" },
    ),
    syntaxHighlighting(createCodeMirrorHighlightStyle(composerSyntaxColors)),
  ];
}

export interface MarkdownNewlineContinuation {
  /** Replace from `lineFrom + replaceFrom` to `lineFrom + replaceTo` with `insert`. */
  replaceFrom: number;
  replaceTo: number;
  insert: string;
}

const TASK_LIST_LINE_RE = /^(\s*)([-*+]\s+)\[[ xX]\](\s+)(.*)$/;
const BULLET_LIST_LINE_RE = /^(\s*)([-*+]\s+)(.*)$/;
const ORDERED_LIST_LINE_RE = /^(\s*)(\d+)([.)]\s+)(.*)$/;
const BLOCKQUOTE_LINE_RE = /^(\s*(?:>\s?)+)(.*)$/;

/**
 * Computes a Markdown list/blockquote continuation for a collapsed caret newline.
 * Returns null for ordinary lines so CodeMirror falls back to standard newline insertion.
 */
export function computeMarkdownNewlineContinuation(
  lineText: string,
  column: number,
): MarkdownNewlineContinuation | null {
  const beforeCaret = lineText.slice(0, column);
  const afterCaret = lineText.slice(column);

  const taskMatch = TASK_LIST_LINE_RE.exec(beforeCaret);
  if (taskMatch) {
    const [, indent, bullet, space, body] = taskMatch;
    if (body.length === 0 && afterCaret.length === 0) {
      return { replaceFrom: 0, replaceTo: column, insert: "" };
    }
    return { replaceFrom: column, replaceTo: column, insert: `\n${indent}${bullet}[ ]${space}` };
  }

  const bulletMatch = BULLET_LIST_LINE_RE.exec(beforeCaret);
  if (bulletMatch) {
    const [, indent, marker, body] = bulletMatch;
    if (body.length === 0 && afterCaret.length === 0) {
      return { replaceFrom: 0, replaceTo: column, insert: "" };
    }
    return { replaceFrom: column, replaceTo: column, insert: `\n${indent}${marker}` };
  }

  const orderedMatch = ORDERED_LIST_LINE_RE.exec(beforeCaret);
  if (orderedMatch) {
    const [, indent, num, delim, body] = orderedMatch;
    if (body.length === 0 && afterCaret.length === 0) {
      return { replaceFrom: 0, replaceTo: column, insert: "" };
    }
    const nextNumber = Number.parseInt(num, 10) + 1;
    return { replaceFrom: column, replaceTo: column, insert: `\n${indent}${nextNumber}${delim}` };
  }

  const quoteMatch = BLOCKQUOTE_LINE_RE.exec(beforeCaret);
  if (quoteMatch) {
    const [, prefix, body] = quoteMatch;
    if (body.trim().length === 0 && afterCaret.length === 0) {
      return { replaceFrom: 0, replaceTo: column, insert: "" };
    }
    const normalizedPrefix = prefix.endsWith(" ") ? prefix : `${prefix} `;
    return { replaceFrom: column, replaceTo: column, insert: `\n${normalizedPrefix}` };
  }

  return null;
}

export function isPositionInsideFencedCode(view: EditorView, pos: number): boolean {
  let node = syntaxTree(view.state).resolveInner(pos, -1);
  while (node) {
    if (node.name === "FencedCode") return true;
    if (!node.parent) break;
    node = node.parent;
  }
  return false;
}

export function insertMarkdownNewline(view: EditorView): boolean {
  const { selection, doc } = view.state;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const pos = selection.main.head;
  if (isPositionInsideFencedCode(view, pos)) return false;

  const line = doc.lineAt(pos);
  const continuation = computeMarkdownNewlineContinuation(line.text, pos - line.from);
  if (!continuation) return false;

  const from = line.from + continuation.replaceFrom;
  const to = line.from + continuation.replaceTo;
  view.dispatch({
    changes: { from, to, insert: continuation.insert },
    selection: { anchor: from + continuation.insert.length },
    scrollIntoView: true,
    userEvent: "input",
  });
  return true;
}
