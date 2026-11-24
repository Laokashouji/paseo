import { syntaxHighlighting, syntaxTree } from "@codemirror/language";
import type { ChangeDesc, Range, SelectionRange, Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { SyntaxNode, SyntaxNodeRef } from "@lezer/common";
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
  accent: string;
  accentBright: string;
  accentForeground: string;
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

const MAX_LIST_DEPTH = 6;
const MAX_QUOTE_DEPTH = 4;

const MARK_DECORATION = Decoration.mark({ class: "cm-md-mark" });
const CODE_MARK_DECORATION = Decoration.mark({ class: "cm-md-code-mark" });
const CODE_INFO_DECORATION = Decoration.mark({ class: "cm-md-code-info" });
const CODE_LANG_BADGE_DECORATION = Decoration.mark({ class: "cm-md-code-lang-badge" });
const STRONG_DECORATION = Decoration.mark({ class: "cm-md-strong" });
const EMPHASIS_DECORATION = Decoration.mark({ class: "cm-md-em" });
const STRIKE_DECORATION = Decoration.mark({ class: "cm-md-strike" });
const INLINE_CODE_DECORATION = Decoration.mark({ class: "cm-md-inline-code" });
const LIST_MARK_DECORATION = Decoration.mark({ class: "cm-md-list-mark" });
const TASK_MARK_DECORATION = Decoration.mark({ class: "cm-md-task-mark" });
const LINK_DECORATION = Decoration.mark({ class: "cm-md-link" });
const LINK_LIVE_DECORATION = Decoration.mark({ class: "cm-md-link cm-md-link-live" });
const URL_DECORATION = Decoration.mark({ class: "cm-md-url" });
const HIDDEN_DECORATION = Decoration.replace({});
const ATOMIC_RANGE_DECORATION = Decoration.mark({});

const HR_LINE_DECORATION = Decoration.line({ class: "cm-md-hr-line" });
const TABLE_LINE_DECORATION = Decoration.line({ class: "cm-md-table-line" });
const TABLE_HEADER_LINE_DECORATION = Decoration.line({ class: "cm-md-table-header" });
const CODEBLOCK_LINE_DECORATION = Decoration.line({ class: "cm-md-codeblock-line" });
const CODEBLOCK_FIRST_DECORATION = Decoration.line({ class: "cm-md-codeblock-first" });
const CODEBLOCK_LAST_DECORATION = Decoration.line({ class: "cm-md-codeblock-last" });
const CODEBLOCK_FENCE_COLLAPSED_DECORATION = Decoration.line({
  class: "cm-md-codeblock-fence-collapsed",
});

const HEADING_DECORATIONS = Object.fromEntries(
  Object.entries(HEADING_LINE_CLASSES).map(([nodeName, className]) => [
    nodeName,
    Decoration.line({ class: className }),
  ]),
);

const CJK_PUNCT_BOUNDARY_RE = /[　-〿＀-￯“”‘’—…]/;
const CJK_FALLBACK_STRONG_RE = /\*\*([^*\n]+?)\*\*/g;
const LEADING_WHITESPACE_ONLY_RE = /^[ \t]*$/;
const BLOCKQUOTE_PREFIX_RE = /^([ \t]*(?:>[ \t]?)+)/;
const PENDING_PARAGRAPH_LIST_PREFIX_RE = /^( *)(1[.)]|[-*+])([ \t]+)$/;

const BULLET_GLYPHS = ["•", "◦", "▪"] as const;
const PAIRED_INLINE_STYLE: Record<string, Decoration> = {
  StrongEmphasis: STRONG_DECORATION,
  Emphasis: EMPHASIS_DECORATION,
  Strikethrough: STRIKE_DECORATION,
};

class BulletWidget extends WidgetType {
  readonly depth: number;

  constructor(depth: number) {
    super();
    this.depth = depth;
  }

  override eq(other: WidgetType): boolean {
    return other instanceof BulletWidget && other.depth === this.depth;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    const visualDepth = Math.min(this.depth, BULLET_GLYPHS.length - 1);
    span.className = `cm-md-bullet-widget cm-md-bullet-depth-${visualDepth}`;
    span.setAttribute("aria-hidden", "true");
    span.textContent = BULLET_GLYPHS[visualDepth];
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class OrderedListMarkerWidget extends WidgetType {
  readonly markerText: string;

  constructor(markerText: string) {
    super();
    this.markerText = markerText;
  }

  override eq(other: WidgetType): boolean {
    return other instanceof OrderedListMarkerWidget && other.markerText === this.markerText;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-md-ordered-widget";
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.markerText;
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

class TaskCheckboxWidget extends WidgetType {
  readonly checked: boolean;
  readonly markerFrom: number;
  readonly markerTo: number;

  constructor(checked: boolean, markerFrom: number, markerTo: number) {
    super();
    this.checked = checked;
    this.markerFrom = markerFrom;
    this.markerTo = markerTo;
  }

  override eq(other: WidgetType): boolean {
    return (
      other instanceof TaskCheckboxWidget &&
      other.checked === this.checked &&
      other.markerFrom === this.markerFrom &&
      other.markerTo === this.markerTo
    );
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-task-widget";

    const box = document.createElement("span");
    box.className = this.checked
      ? "cm-md-task-checkbox cm-md-task-checkbox-checked"
      : "cm-md-task-checkbox";
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", this.checked ? "true" : "false");
    box.setAttribute("aria-label", this.checked ? "Completed task" : "Incomplete task");

    if (this.checked) {
      const svgNS = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNS, "svg");
      svg.setAttribute("viewBox", "0 0 12 12");
      svg.setAttribute("width", "10");
      svg.setAttribute("height", "10");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", "M2.5 6.2L5 8.7L9.5 3.3");
      path.setAttribute("fill", "none");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.8");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      svg.appendChild(path);
      box.appendChild(svg);
    }

    wrapper.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (view.state.readOnly) return;
      if (this.markerTo > view.state.doc.length) return;
      const current = view.state.doc.sliceString(this.markerFrom, this.markerTo);
      if (!/^\[[ xX]\]$/.test(current)) return;
      view.dispatch({
        changes: {
          from: this.markerFrom,
          to: this.markerTo,
          insert: this.checked ? "[ ]" : "[x]",
        },
        userEvent: "input",
      });
      view.focus();
    });

    wrapper.appendChild(box);
    return wrapper;
  }

  override ignoreEvent(event: Event): boolean {
    return event.type === "mousedown" || event.type === "click";
  }
}

class HorizontalRuleWidget extends WidgetType {
  override eq(other: WidgetType): boolean {
    return other instanceof HorizontalRuleWidget;
  }

  override toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "cm-md-hr-widget";
    wrapper.setAttribute("aria-hidden", "true");
    const bar = document.createElement("span");
    bar.className = "cm-md-hr-bar";
    wrapper.appendChild(bar);
    return wrapper;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const HORIZONTAL_RULE_WIDGET = new HorizontalRuleWidget();
const HORIZONTAL_RULE_REPLACE = Decoration.replace({ widget: HORIZONTAL_RULE_WIDGET });

interface ReplaceEntry {
  from: number;
  to: number;
  decoration: Decoration;
  atomic: boolean;
}

export interface MarkdownLivePreviewState {
  decorations: DecorationSet;
  atomicRanges: DecorationSet;
  inlineHiddenMarks: Array<{ from: number; to: number }>;
  appliedReplaces: Array<{ from: number; to: number }>;
  deferredForComposition: boolean;
}

function measureVisualIndent(whitespace: string): number {
  let width = 0;
  for (let i = 0; i < whitespace.length; i += 1) {
    width += whitespace[i] === "\t" ? 2 : 1;
  }
  return width;
}

function forEachBlockLine(
  view: EditorView,
  blockFrom: number,
  blockTo: number,
  visibleFrom: number,
  visibleTo: number,
  decorateLine: (
    lineFrom: number,
    lineTo: number,
    lineNumber: number,
    isFirst: boolean,
    isLast: boolean,
  ) => void,
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
      line.to,
      line.number,
      line.number === firstBlockLine.number,
      line.number === lastBlockLine.number,
    );
    if (line.to >= endPos || line.number >= doc.lines) break;
    line = doc.line(line.number + 1);
  }
}

function selectionTouchesRange(
  ranges: readonly SelectionRange[],
  from: number,
  to: number,
): boolean {
  for (const range of ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function selectionStrictlyInside(
  ranges: readonly SelectionRange[],
  from: number,
  to: number,
): boolean {
  for (const range of ranges) {
    if (range.empty) {
      if (range.head > from && range.head < to) return true;
    } else if (range.from > from && range.to < to) {
      return true;
    }
  }
  return false;
}

function rangesOverlapAny(
  from: number,
  to: number,
  excluded: ReadonlyArray<readonly [number, number]>,
): boolean {
  for (const [exFrom, exTo] of excluded) {
    if (from < exTo && to > exFrom) return true;
  }
  return false;
}

interface LivePreviewContext {
  view: EditorView;
  doc: Text;
  selectionRanges: readonly SelectionRange[];
  isFocused: boolean;
  isComposing: boolean;
  markRanges: Range<Decoration>[];
  replaceEntries: ReplaceEntry[];
  inlineHiddenMarks: Array<{ from: number; to: number }>;
  excludedFromCjkBold: Array<[number, number]>;
  decoratedListLines: Set<number>;
  decoratedQuoteLines: Set<number>;
  decoratedHeadingLines: Set<number>;
  hasActiveLine: (lineFrom: number, lineTo: number) => boolean;
  shouldRevealBlockPrefix: (prefixFrom: number, prefixTo: number) => boolean;
  shouldRevealInlineNode: (from: number, to: number) => boolean;
  queueReplace: (
    from: number,
    to: number,
    decoration: Decoration,
    atomic: boolean,
    isInlineClosingMark?: boolean,
  ) => void;
}

function isHorizontalSpace(ch: string): boolean {
  return ch === " " || ch === "\t";
}

function decorateFencedCodeNode(
  ctx: LivePreviewContext,
  node: SyntaxNodeRef,
  visibleFrom: number,
  visibleTo: number,
): void {
  const { doc, markRanges } = ctx;
  ctx.excludedFromCjkBold.push([node.from, node.to]);
  const codeMarks = node.node.getChildren("CodeMark");
  const codeInfo = node.node.getChild("CodeInfo");
  const openMark = codeMarks[0];
  const closeMark = codeMarks.length >= 2 ? codeMarks[codeMarks.length - 1] : null;
  const openLineNumber = openMark ? doc.lineAt(openMark.from).number : -1;
  const closeLineNumber =
    closeMark && doc.lineAt(closeMark.from).number !== openLineNumber
      ? doc.lineAt(closeMark.from).number
      : -1;

  forEachBlockLine(
    ctx.view,
    node.from,
    node.to,
    visibleFrom,
    visibleTo,
    (lineFrom, lineTo, lineNumber, isFirst, isLast) => {
      markRanges.push(CODEBLOCK_LINE_DECORATION.range(lineFrom));
      if (isFirst) markRanges.push(CODEBLOCK_FIRST_DECORATION.range(lineFrom));
      if (isLast) markRanges.push(CODEBLOCK_LAST_DECORATION.range(lineFrom));

      if (lineNumber === openLineNumber && openMark) {
        decorateOpenFenceLine(ctx, openMark, codeInfo, openLineNumber, lineFrom, lineTo);
      } else if (lineNumber === closeLineNumber && closeMark) {
        decorateCloseFenceLine(ctx, closeMark, lineFrom, lineTo);
      }
    },
  );
}

function decorateOpenFenceLine(
  ctx: LivePreviewContext,
  openMark: SyntaxNode,
  codeInfo: SyntaxNode | null,
  openLineNumber: number,
  lineFrom: number,
  lineTo: number,
): void {
  const infoOnOpenLine =
    codeInfo && ctx.doc.lineAt(codeInfo.from).number === openLineNumber ? codeInfo : null;
  if (ctx.hasActiveLine(lineFrom, lineTo)) {
    ctx.markRanges.push(CODE_MARK_DECORATION.range(openMark.from, openMark.to));
    if (infoOnOpenLine) {
      ctx.markRanges.push(CODE_INFO_DECORATION.range(infoOnOpenLine.from, infoOnOpenLine.to));
    }
    return;
  }
  if (infoOnOpenLine) {
    ctx.queueReplace(openMark.from, openMark.to, HIDDEN_DECORATION, true);
    ctx.markRanges.push(CODE_LANG_BADGE_DECORATION.range(infoOnOpenLine.from, infoOnOpenLine.to));
  } else if (lineFrom < lineTo) {
    ctx.queueReplace(lineFrom, lineTo, HIDDEN_DECORATION, false);
    ctx.markRanges.push(CODEBLOCK_FENCE_COLLAPSED_DECORATION.range(lineFrom));
  }
}

function decorateCloseFenceLine(
  ctx: LivePreviewContext,
  closeMark: SyntaxNode,
  lineFrom: number,
  lineTo: number,
): void {
  if (!ctx.hasActiveLine(lineFrom, lineTo) && lineFrom < lineTo) {
    ctx.queueReplace(lineFrom, lineTo, HIDDEN_DECORATION, false);
    ctx.markRanges.push(CODEBLOCK_FENCE_COLLAPSED_DECORATION.range(lineFrom));
  } else {
    ctx.markRanges.push(CODE_MARK_DECORATION.range(closeMark.from, closeMark.to));
  }
}

function decoratePendingSetextBullet(ctx: LivePreviewContext, setextMark: SyntaxNode): boolean {
  const { doc, markRanges } = ctx;
  if (doc.sliceString(setextMark.from, setextMark.to) !== "-") return false;

  const markLine = doc.lineAt(setextMark.from);
  const trailingText = doc.sliceString(setextMark.to, markLine.to);
  const hasTrailingSpace = trailingText.length > 0 && isHorizontalSpace(trailingText[0]);
  if (hasTrailingSpace && LEADING_WHITESPACE_ONLY_RE.test(trailingText)) {
    // CommonMark parses `paragraph\n- ` as a Setext H2 underline until content follows.
    // Preview a lone `-` followed by horizontal space as an empty bullet item so the
    // preceding paragraph does not flash into H2 and IME input never duplicates the marker.
    const leadingText = markLine.text.slice(0, setextMark.from - markLine.from);
    const leadingIsWhitespace = LEADING_WHITESPACE_ONLY_RE.test(leadingText);
    const indentDepth = leadingIsWhitespace ? Math.floor(measureVisualIndent(leadingText) / 2) : 0;
    const depth = Math.min(MAX_LIST_DEPTH, indentDepth);
    const replaceFrom = leadingIsWhitespace ? markLine.from : setextMark.from;
    if (!ctx.decoratedListLines.has(markLine.number)) {
      decorateListPrefixLine(ctx, {
        lineFrom: markLine.from,
        lineNumber: markLine.number,
        markFrom: setextMark.from,
        markTo: setextMark.to,
        replaceFrom,
        prefixTo: setextMark.to + 1,
        depth,
        leadingIsWhitespace,
        isOrdered: false,
      });
    }
    return true;
  }

  if (!hasTrailingSpace && ctx.hasActiveLine(markLine.from, markLine.to)) {
    // Hold off turning the preceding paragraph into H2 while actively typing a lone `-`
    // (user may be about to press Space for a bullet list or a second `-` for Setext H2).
    markRanges.push(LIST_MARK_DECORATION.range(setextMark.from, setextMark.to));
    return true;
  }

  return false;
}

function decorateSetextHeadingNode(
  ctx: LivePreviewContext,
  node: SyntaxNodeRef,
  headingDecoration: Decoration,
  visibleFrom: number,
  visibleTo: number,
): void {
  const { markRanges, decoratedHeadingLines } = ctx;
  const setextMark = node.node.getChild("HeaderMark");
  if (
    node.name === "SetextHeading2" &&
    setextMark &&
    decoratePendingSetextBullet(ctx, setextMark)
  ) {
    return;
  }

  const blockEnd = Math.max(node.from, (setextMark?.from ?? node.to) - 1);
  forEachBlockLine(
    ctx.view,
    node.from,
    blockEnd,
    visibleFrom,
    visibleTo,
    (lineFrom, _lineTo, lineNumber) => {
      if (decoratedHeadingLines.has(lineNumber)) return;
      decoratedHeadingLines.add(lineNumber);
      markRanges.push(headingDecoration.range(lineFrom));
    },
  );
  if (setextMark && setextMark.from < setextMark.to) {
    markRanges.push(MARK_DECORATION.range(setextMark.from, setextMark.to));
  }
}

function decorateHeadingNode(
  ctx: LivePreviewContext,
  node: SyntaxNodeRef,
  headingDecoration: Decoration,
  visibleFrom: number,
  visibleTo: number,
): void {
  const { doc, markRanges, decoratedHeadingLines } = ctx;
  if (node.name.startsWith("Setext")) {
    decorateSetextHeadingNode(ctx, node, headingDecoration, visibleFrom, visibleTo);
    return;
  }

  const line = doc.lineAt(node.from);
  if (!decoratedHeadingLines.has(line.number)) {
    decoratedHeadingLines.add(line.number);
    markRanges.push(headingDecoration.range(line.from));
  }

  const headerMarks = node.node.getChildren("HeaderMark");
  const openMark = headerMarks[0];
  const closeMark = headerMarks.length >= 2 ? headerMarks[headerMarks.length - 1] : null;
  if (openMark) {
    const hasSpaceAfter =
      openMark.to < line.to && isHorizontalSpace(doc.sliceString(openMark.to, openMark.to + 1));
    const leadingText = line.text.slice(0, openMark.from - line.from);
    const prefixFrom = LEADING_WHITESPACE_ONLY_RE.test(leadingText) ? line.from : openMark.from;
    if (hasSpaceAfter && !ctx.shouldRevealBlockPrefix(prefixFrom, openMark.to + 1)) {
      ctx.queueReplace(prefixFrom, openMark.to + 1, HIDDEN_DECORATION, true);
    } else {
      markRanges.push(MARK_DECORATION.range(openMark.from, openMark.to));
    }
  }

  if (closeMark && closeMark.from < closeMark.to) {
    const beforeClose =
      closeMark.from > line.from ? doc.sliceString(closeMark.from - 1, closeMark.from) : "";
    const closeFrom = isHorizontalSpace(beforeClose) ? closeMark.from - 1 : closeMark.from;
    if (!ctx.shouldRevealBlockPrefix(closeFrom, closeMark.to)) {
      ctx.queueReplace(closeFrom, closeMark.to, HIDDEN_DECORATION, true);
    } else {
      markRanges.push(MARK_DECORATION.range(closeMark.from, closeMark.to));
    }
  }
}

function countListAncestors(node: SyntaxNode): number {
  let count = 0;
  let cursor = node.parent;
  while (cursor) {
    if (cursor.name === "BulletList" || cursor.name === "OrderedList") count += 1;
    cursor = cursor.parent;
  }
  return count;
}

function findAncestorNode(node: SyntaxNode, name: string): SyntaxNode | null {
  let cursor = node.parent;
  while (cursor) {
    if (cursor.name === name) return cursor;
    cursor = cursor.parent;
  }
  return null;
}

function decorateListPrefixLine(
  ctx: LivePreviewContext,
  options: {
    lineFrom: number;
    lineNumber: number;
    markFrom: number;
    markTo: number;
    replaceFrom: number;
    prefixTo: number;
    depth: number;
    leadingIsWhitespace: boolean;
    isOrdered: boolean;
  },
): void {
  const {
    lineFrom,
    lineNumber,
    markFrom,
    markTo,
    replaceFrom,
    prefixTo,
    depth,
    leadingIsWhitespace,
    isOrdered,
  } = options;
  ctx.decoratedListLines.add(lineNumber);

  if (isOrdered) {
    const markerText = ctx.doc.sliceString(markFrom, markTo);
    const olWidth = `${Math.max(1.75, markerText.length * 0.62 + 0.55).toFixed(2)}em`;
    ctx.markRanges.push(
      Decoration.line({
        class: "cm-md-list-line cm-md-ordered-line",
        attributes: leadingIsWhitespace
          ? { style: `--cm-list-depth: ${depth}; --cm-ol-width: ${olWidth};` }
          : { style: `--cm-ol-width: ${olWidth};` },
      }).range(lineFrom),
    );
    if (!ctx.shouldRevealBlockPrefix(replaceFrom, prefixTo)) {
      ctx.queueReplace(
        replaceFrom,
        prefixTo,
        Decoration.replace({ widget: new OrderedListMarkerWidget(markerText) }),
        true,
      );
    } else {
      ctx.markRanges.push(LIST_MARK_DECORATION.range(markFrom, markTo));
    }
    return;
  }

  ctx.markRanges.push(
    Decoration.line({
      class: "cm-md-list-line cm-md-bullet-line",
      attributes: leadingIsWhitespace ? { style: `--cm-list-depth: ${depth};` } : undefined,
    }).range(lineFrom),
  );
  if (!ctx.shouldRevealBlockPrefix(replaceFrom, prefixTo)) {
    ctx.queueReplace(
      replaceFrom,
      prefixTo,
      Decoration.replace({ widget: new BulletWidget(depth) }),
      true,
    );
  } else {
    ctx.markRanges.push(LIST_MARK_DECORATION.range(markFrom, markTo));
  }
}

/**
 * CommonMark forbids empty list items from interrupting a preceding paragraph, so lines like
 * `paragraph\n1. ` or `paragraph\n* ` stay inside the Paragraph node until content is typed.
 * Preview those pending list prefixes immediately so formatting matches what CommonMark will
 * produce as soon as the user starts typing the item body.
 */
function decoratePendingParagraphListLines(
  ctx: LivePreviewContext,
  node: SyntaxNodeRef,
  visibleFrom: number,
  visibleTo: number,
): void {
  const firstLineNumber = ctx.doc.lineAt(node.from).number;
  const clampedEnd = Math.max(node.from, node.to > node.from ? node.to - 1 : node.to);
  if (firstLineNumber === ctx.doc.lineAt(clampedEnd).number) return;

  const isInsideBlockquote = findAncestorNode(node.node, "Blockquote") !== null;
  const parentListItem = findAncestorNode(node.node, "ListItem");
  let parentContentColumn = 0;
  if (parentListItem) {
    const parentMark = parentListItem.getChild("ListMark");
    if (parentMark) {
      const parentLine = ctx.doc.lineAt(parentMark.from);
      const parentQuoteMatch = isInsideBlockquote
        ? BLOCKQUOTE_PREFIX_RE.exec(parentLine.text)
        : null;
      const parentQuoteLen = parentQuoteMatch ? parentQuoteMatch[1].length : 0;
      parentContentColumn = Math.max(0, parentMark.to - parentLine.from - parentQuoteLen + 1);
    }
  }
  const maxIndent = parentContentColumn + 3;
  const ancestorListCount = parentListItem ? countListAncestors(node.node) : 0;

  forEachBlockLine(
    ctx.view,
    node.from,
    node.to,
    visibleFrom,
    visibleTo,
    (lineFrom, lineTo, lineNumber, isFirst) => {
      if (isFirst || ctx.decoratedListLines.has(lineNumber)) return;
      const lineText = ctx.doc.sliceString(lineFrom, lineTo);
      const quoteMatch = isInsideBlockquote ? BLOCKQUOTE_PREFIX_RE.exec(lineText) : null;
      const quotePrefixLen = quoteMatch ? quoteMatch[1].length : 0;
      const rest = lineText.slice(quotePrefixLen);
      const match = PENDING_PARAGRAPH_LIST_PREFIX_RE.exec(rest);
      if (!match) return;

      const [, indentSpaces, marker] = match;
      if (indentSpaces.length > maxIndent) return;

      const markFrom = lineFrom + quotePrefixLen + indentSpaces.length;
      const markTo = markFrom + marker.length;
      const prefixTo = markTo + 1;
      const leadingText = lineText.slice(0, markFrom - lineFrom);
      const leadingIsWhitespace = LEADING_WHITESPACE_ONLY_RE.test(leadingText);
      const indentDepth = leadingIsWhitespace
        ? Math.floor(measureVisualIndent(leadingText) / 2)
        : 0;
      const nestedDepth =
        parentListItem && indentSpaces.length >= parentContentColumn ? ancestorListCount : 0;
      const depth = Math.min(MAX_LIST_DEPTH, Math.max(nestedDepth, indentDepth));
      const replaceFrom = leadingIsWhitespace ? lineFrom : markFrom;

      decorateListPrefixLine(ctx, {
        lineFrom,
        lineNumber,
        markFrom,
        markTo,
        replaceFrom,
        prefixTo,
        depth,
        leadingIsWhitespace,
        isOrdered: marker[0] === "1",
      });
    },
  );
}

function decorateTaskListItem(
  ctx: LivePreviewContext,
  listMark: SyntaxNode,
  taskMarker: SyntaxNode,
  lineFrom: number,
  lineTo: number,
  lineNumber: number,
  replaceFrom: number,
  depth: number,
  leadingIsWhitespace: boolean,
): boolean {
  const hasSpaceAfterTask =
    taskMarker.to < lineTo &&
    isHorizontalSpace(ctx.doc.sliceString(taskMarker.to, taskMarker.to + 1));
  if (!hasSpaceAfterTask && ctx.hasActiveLine(lineFrom, lineTo)) return false;

  ctx.decoratedListLines.add(lineNumber);
  const prefixTo = hasSpaceAfterTask ? taskMarker.to + 1 : taskMarker.to;
  const markerText = ctx.doc.sliceString(taskMarker.from, taskMarker.to);
  const checked = markerText.length === 3 && (markerText[1] === "x" || markerText[1] === "X");
  const lineClass = checked
    ? "cm-md-list-line cm-md-task-line cm-md-task-checked"
    : "cm-md-list-line cm-md-task-line";
  ctx.markRanges.push(
    Decoration.line({
      class: lineClass,
      attributes: leadingIsWhitespace ? { style: `--cm-list-depth: ${depth};` } : undefined,
    }).range(lineFrom),
  );
  if (!ctx.shouldRevealBlockPrefix(replaceFrom, prefixTo)) {
    ctx.queueReplace(
      replaceFrom,
      prefixTo,
      Decoration.replace({
        widget: new TaskCheckboxWidget(checked, taskMarker.from, taskMarker.to),
      }),
      true,
    );
  } else {
    ctx.markRanges.push(LIST_MARK_DECORATION.range(listMark.from, listMark.to));
    ctx.markRanges.push(TASK_MARK_DECORATION.range(taskMarker.from, taskMarker.to));
  }
  return true;
}

function decorateListItemNode(ctx: LivePreviewContext, node: SyntaxNodeRef): void {
  const listMark = node.node.getChild("ListMark");
  if (!listMark) return;
  const line = ctx.doc.lineAt(listMark.from);
  if (ctx.decoratedListLines.has(line.number)) return;

  const leadingText = line.text.slice(0, listMark.from - line.from);
  const leadingIsWhitespace = LEADING_WHITESPACE_ONLY_RE.test(leadingText);
  const indentDepth = leadingIsWhitespace ? Math.floor(measureVisualIndent(leadingText) / 2) : 0;
  const depth = Math.min(MAX_LIST_DEPTH, Math.max(countListAncestors(node.node) - 1, indentDepth));
  const replaceFrom = leadingIsWhitespace ? line.from : listMark.from;

  const taskMarker = node.node.getChild("Task")?.getChild("TaskMarker") ?? null;
  if (
    taskMarker &&
    ctx.doc.lineAt(taskMarker.from).number === line.number &&
    decorateTaskListItem(
      ctx,
      listMark,
      taskMarker,
      line.from,
      line.to,
      line.number,
      replaceFrom,
      depth,
      leadingIsWhitespace,
    )
  ) {
    return;
  }

  const hasSpaceAfterMark =
    listMark.to < line.to && isHorizontalSpace(ctx.doc.sliceString(listMark.to, listMark.to + 1));
  if (!hasSpaceAfterMark) {
    ctx.markRanges.push(LIST_MARK_DECORATION.range(listMark.from, listMark.to));
    return;
  }

  decorateListPrefixLine(ctx, {
    lineFrom: line.from,
    lineNumber: line.number,
    markFrom: listMark.from,
    markTo: listMark.to,
    replaceFrom,
    prefixTo: listMark.to + 1,
    depth,
    leadingIsWhitespace,
    isOrdered: node.node.parent?.name === "OrderedList",
  });
}

function decorateBlockquoteNode(
  ctx: LivePreviewContext,
  node: SyntaxNodeRef,
  visibleFrom: number,
  visibleTo: number,
): void {
  forEachBlockLine(
    ctx.view,
    node.from,
    node.to,
    visibleFrom,
    visibleTo,
    (lineFrom, lineTo, lineNumber) => {
      if (ctx.decoratedQuoteLines.has(lineNumber)) return;
      const match = BLOCKQUOTE_PREFIX_RE.exec(ctx.doc.sliceString(lineFrom, lineTo));
      if (!match) return;
      const prefix = match[1];
      const endsWithSpace = isHorizontalSpace(prefix[prefix.length - 1] ?? "");
      if (!endsWithSpace && ctx.hasActiveLine(lineFrom, lineTo)) {
        // Keep bare `>` visible while typing until user presses Space or leaves the line.
        ctx.markRanges.push(MARK_DECORATION.range(lineFrom, lineFrom + prefix.length));
        return;
      }
      ctx.decoratedQuoteLines.add(lineNumber);
      const depth = Math.min(MAX_QUOTE_DEPTH, prefix.match(/>/g)?.length ?? 1);
      ctx.markRanges.push(
        Decoration.line({
          class: "cm-md-blockquote-line",
          attributes: { style: `--cm-quote-depth: ${depth};` },
        }).range(lineFrom),
      );
      const prefixTo = lineFrom + prefix.length;
      if (!ctx.shouldRevealBlockPrefix(lineFrom, prefixTo)) {
        ctx.queueReplace(lineFrom, prefixTo, HIDDEN_DECORATION, true);
      } else {
        ctx.markRanges.push(MARK_DECORATION.range(lineFrom, prefixTo));
      }
    },
  );
}

function decoratePairedInlineNode(
  ctx: LivePreviewContext,
  node: SyntaxNodeRef,
  styleDecoration: Decoration,
): void {
  ctx.excludedFromCjkBold.push([node.from, node.to]);
  const markChildName = node.name === "Strikethrough" ? "StrikethroughMark" : "EmphasisMark";
  const marks = node.node.getChildren(markChildName);
  const openMark = marks[0];
  const closeMark = marks.length >= 2 ? marks[marks.length - 1] : null;

  // Avoid flashing single-asterisk italic while the user is halfway through typing `**bold**`.
  const isMidDoubledEmphasis =
    node.name === "Emphasis" &&
    openMark !== undefined &&
    node.from > 0 &&
    ctx.doc.sliceString(node.from - 1, node.from) ===
      ctx.doc.sliceString(openMark.from, openMark.to) &&
    ctx.isFocused &&
    ctx.selectionRanges.some((range) => range.empty && range.head === node.to);

  const reveal = isMidDoubledEmphasis || ctx.shouldRevealInlineNode(node.from, node.to);
  if (!reveal && openMark && closeMark && openMark.to < closeMark.from) {
    ctx.markRanges.push(styleDecoration.range(openMark.to, closeMark.from));
    ctx.queueReplace(openMark.from, openMark.to, HIDDEN_DECORATION, true);
    ctx.queueReplace(closeMark.from, closeMark.to, HIDDEN_DECORATION, true, true);
  } else {
    ctx.markRanges.push(styleDecoration.range(node.from, node.to));
    if (openMark) ctx.markRanges.push(MARK_DECORATION.range(openMark.from, openMark.to));
    if (closeMark) ctx.markRanges.push(MARK_DECORATION.range(closeMark.from, closeMark.to));
  }
}

function decorateInlineCodeNode(ctx: LivePreviewContext, node: SyntaxNodeRef): void {
  ctx.excludedFromCjkBold.push([node.from, node.to]);
  const marks = node.node.getChildren("CodeMark");
  const openMark = marks[0];
  const closeMark = marks.length >= 2 ? marks[marks.length - 1] : null;
  if (
    !ctx.shouldRevealInlineNode(node.from, node.to) &&
    openMark &&
    closeMark &&
    openMark.to < closeMark.from
  ) {
    ctx.markRanges.push(INLINE_CODE_DECORATION.range(openMark.to, closeMark.from));
    ctx.queueReplace(openMark.from, openMark.to, HIDDEN_DECORATION, true);
    ctx.queueReplace(closeMark.from, closeMark.to, HIDDEN_DECORATION, true, true);
  } else {
    ctx.markRanges.push(INLINE_CODE_DECORATION.range(node.from, node.to));
    if (openMark) ctx.markRanges.push(CODE_MARK_DECORATION.range(openMark.from, openMark.to));
    if (closeMark) ctx.markRanges.push(CODE_MARK_DECORATION.range(closeMark.from, closeMark.to));
  }
}

function decorateLinkNode(ctx: LivePreviewContext, node: SyntaxNodeRef): void {
  ctx.excludedFromCjkBold.push([node.from, node.to]);
  const linkMarks = node.node.getChildren("LinkMark");
  const openBracket = linkMarks.find((mark) => ctx.doc.sliceString(mark.from, mark.to) === "[");
  const closeBracket = openBracket
    ? linkMarks.find(
        (mark) => mark.from > openBracket.to && ctx.doc.sliceString(mark.from, mark.to) === "]",
      )
    : undefined;
  const canHideLinkSyntax =
    !ctx.shouldRevealInlineNode(node.from, node.to) &&
    openBracket !== undefined &&
    closeBracket !== undefined &&
    closeBracket.from > openBracket.to &&
    closeBracket.to < node.to;

  if (canHideLinkSyntax) {
    ctx.markRanges.push(LINK_LIVE_DECORATION.range(openBracket.to, closeBracket.from));
    ctx.queueReplace(openBracket.from, openBracket.to, HIDDEN_DECORATION, true);
    ctx.queueReplace(closeBracket.from, node.to, HIDDEN_DECORATION, true, true);
    return;
  }

  ctx.markRanges.push(LINK_DECORATION.range(node.from, node.to));
  for (const mark of linkMarks) {
    ctx.markRanges.push(MARK_DECORATION.range(mark.from, mark.to));
  }
  const urlNode = node.node.getChild("URL");
  if (urlNode && urlNode.from < urlNode.to) {
    ctx.markRanges.push(URL_DECORATION.range(urlNode.from, urlNode.to));
  }
}

function decorateHorizontalRuleNode(ctx: LivePreviewContext, node: SyntaxNodeRef): void {
  ctx.excludedFromCjkBold.push([node.from, node.to]);
  const line = ctx.doc.lineAt(node.from);
  ctx.markRanges.push(HR_LINE_DECORATION.range(line.from));
  if (!ctx.hasActiveLine(line.from, line.to) && line.from < line.to) {
    ctx.queueReplace(line.from, line.to, HORIZONTAL_RULE_REPLACE, false);
  } else if (node.from < node.to) {
    ctx.markRanges.push(MARK_DECORATION.range(node.from, node.to));
  }
}

function decorateInlineSyntaxNode(ctx: LivePreviewContext, node: SyntaxNodeRef): void {
  if (node.from >= node.to) return;
  const name = node.name;
  const pairedInlineStyle = PAIRED_INLINE_STYLE[name];
  if (pairedInlineStyle) {
    decoratePairedInlineNode(ctx, node, pairedInlineStyle);
    return;
  }
  if (name === "InlineCode") {
    decorateInlineCodeNode(ctx, node);
    return;
  }
  if (name === "Link") {
    decorateLinkNode(ctx, node);
    return;
  }
  if (name === "Autolink") {
    ctx.excludedFromCjkBold.push([node.from, node.to]);
    ctx.markRanges.push(LINK_DECORATION.range(node.from, node.to));
    return;
  }
  if (name === "URL") {
    ctx.excludedFromCjkBold.push([node.from, node.to]);
    if (node.node.parent?.name !== "Link") {
      ctx.markRanges.push(URL_DECORATION.range(node.from, node.to));
    }
  }
}

function decorateSyntaxNode(
  ctx: LivePreviewContext,
  node: SyntaxNodeRef,
  visibleFrom: number,
  visibleTo: number,
): boolean | void {
  const name = node.name;
  if (name === "FencedCode") {
    decorateFencedCodeNode(ctx, node, visibleFrom, visibleTo);
    return false;
  }

  const headingDecoration = HEADING_DECORATIONS[name];
  if (headingDecoration) {
    decorateHeadingNode(ctx, node, headingDecoration, visibleFrom, visibleTo);
    return;
  }

  if (name === "ListItem") {
    decorateListItemNode(ctx, node);
    return;
  }

  if (name === "Blockquote") {
    decorateBlockquoteNode(ctx, node, visibleFrom, visibleTo);
    return;
  }

  if (name === "Paragraph") {
    decoratePendingParagraphListLines(ctx, node, visibleFrom, visibleTo);
    return;
  }

  if (name === "Table" || name === "TableHeader") {
    const tableDecoration =
      name === "TableHeader" ? TABLE_HEADER_LINE_DECORATION : TABLE_LINE_DECORATION;
    forEachBlockLine(ctx.view, node.from, node.to, visibleFrom, visibleTo, (lineFrom) => {
      ctx.markRanges.push(tableDecoration.range(lineFrom));
    });
    return;
  }

  if (name === "TableDelimiter") {
    if (node.from < node.to) ctx.markRanges.push(MARK_DECORATION.range(node.from, node.to));
    return;
  }

  if (name === "HorizontalRule") {
    decorateHorizontalRuleNode(ctx, node);
    return;
  }

  decorateInlineSyntaxNode(ctx, node);
}

function decorateCjkBoldFallbacks(
  ctx: LivePreviewContext,
  visibleFrom: number,
  visibleTo: number,
): void {
  const { doc, markRanges, excludedFromCjkBold } = ctx;
  const startLine = doc.lineAt(visibleFrom).number;
  const endLine = doc.lineAt(visibleTo).number;
  for (let lineNum = startLine; lineNum <= endLine; lineNum += 1) {
    const line = doc.line(lineNum);
    if (!line.text.includes("**")) continue;
    CJK_FALLBACK_STRONG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CJK_FALLBACK_STRONG_RE.exec(line.text)) !== null) {
      const inner = match[1];
      if (!inner || /^\s|\s$/.test(inner)) continue;
      if (
        !CJK_PUNCT_BOUNDARY_RE.test(inner[0]) &&
        !CJK_PUNCT_BOUNDARY_RE.test(inner[inner.length - 1])
      ) {
        continue;
      }
      const matchStart = line.from + match.index;
      const matchEnd = matchStart + match[0].length;
      if (matchStart > line.from && doc.sliceString(matchStart - 1, matchStart) === "*") continue;
      if (matchEnd < line.to && doc.sliceString(matchEnd, matchEnd + 1) === "*") continue;
      if (rangesOverlapAny(matchStart, matchEnd, excludedFromCjkBold)) continue;

      excludedFromCjkBold.push([matchStart, matchEnd]);
      if (!ctx.shouldRevealInlineNode(matchStart, matchEnd)) {
        markRanges.push(STRONG_DECORATION.range(matchStart + 2, matchEnd - 2));
        ctx.queueReplace(matchStart, matchStart + 2, HIDDEN_DECORATION, true);
        ctx.queueReplace(matchEnd - 2, matchEnd, HIDDEN_DECORATION, true, true);
      } else {
        markRanges.push(STRONG_DECORATION.range(matchStart, matchEnd));
        markRanges.push(MARK_DECORATION.range(matchStart, matchStart + 2));
        markRanges.push(MARK_DECORATION.range(matchEnd - 2, matchEnd));
      }
    }
  }
}

function mapIntactRanges(
  ranges: ReadonlyArray<{ from: number; to: number }>,
  changes: ChangeDesc,
): Array<{ from: number; to: number }> {
  if (ranges.length === 0 || changes.empty) {
    return ranges.map((range) => ({ from: range.from, to: range.to }));
  }
  const mapped: Array<{ from: number; to: number }> = [];
  for (const range of ranges) {
    let corrupted = false;
    changes.iterChangedRanges((fromA, toA) => {
      if (corrupted) return;
      // Any edit overlapping the range or inserting strictly inside it invalidates the
      // pre-existing DOM widget; pure insertions right before/after the range keep it intact.
      if (
        (fromA < range.to && toA > range.from) ||
        (fromA === toA && fromA > range.from && fromA < range.to)
      ) {
        corrupted = true;
      }
    });
    if (corrupted) continue;
    const from = changes.mapPos(range.from, 1);
    const to = changes.mapPos(range.to, -1);
    if (from < to) {
      mapped.push({ from, to });
    }
  }
  return mapped;
}

export function buildMarkdownLivePreview(
  view: EditorView,
  preCompositionReplaces?: ReadonlyArray<{ from: number; to: number }>,
): MarkdownLivePreviewState {
  const { state } = view;
  const { doc, selection } = state;
  const isFocused = view.hasFocus;
  const isComposing = view.composing || view.compositionStarted;
  const tree = syntaxTree(state);

  let deferredForComposition = false;
  const isNewReplaceOnComposingLine = (from: number, to: number): boolean => {
    if (!isComposing) return false;
    if (preCompositionReplaces?.some((range) => range.from === from && range.to === to)) {
      return false;
    }
    const line = doc.lineAt(from);
    if (!selectionTouchesRange(selection.ranges, line.from, line.to)) return false;
    deferredForComposition = true;
    return true;
  };

  const ctx: LivePreviewContext = {
    view,
    doc,
    selectionRanges: selection.ranges,
    isFocused,
    isComposing,
    markRanges: [],
    replaceEntries: [],
    inlineHiddenMarks: [],
    excludedFromCjkBold: [],
    decoratedListLines: new Set<number>(),
    decoratedQuoteLines: new Set<number>(),
    decoratedHeadingLines: new Set<number>(),
    hasActiveLine: (lineFrom, lineTo) =>
      isFocused && selectionTouchesRange(selection.ranges, lineFrom, lineTo),
    shouldRevealBlockPrefix: (prefixFrom, prefixTo) => {
      // Do not introduce a brand-new replace decoration on an actively composing line:
      // CodeMirror preserves the composing DOM TextNode verbatim, which would render both
      // the new widget and the raw prefix text side by side (e.g. "1. 1. pinyin").
      if (isNewReplaceOnComposingLine(prefixFrom, prefixTo)) return true;
      return (
        isFocused &&
        selection.ranges.some(
          (range) => range.empty && range.head > prefixFrom && range.head < prefixTo,
        )
      );
    },
    shouldRevealInlineNode: (from, to) => {
      if (!isFocused) return false;
      if (isComposing && selectionTouchesRange(selection.ranges, from, to)) return true;
      return selectionStrictlyInside(selection.ranges, from, to);
    },
    queueReplace: (from, to, decoration, atomic, isInlineClosingMark = false) => {
      if (from >= to || from < 0 || to > doc.length) return;
      // ViewPlugin replace decorations cannot cross line breaks.
      if (doc.lineAt(from).number !== doc.lineAt(to).number) return;
      if (isNewReplaceOnComposingLine(from, to)) return;
      ctx.replaceEntries.push({ from, to, decoration, atomic });
      if (isInlineClosingMark) ctx.inlineHiddenMarks.push({ from, to });
    },
  };

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => decorateSyntaxNode(ctx, node, from, to),
    });
    decorateCjkBoldFallbacks(ctx, from, to);
  }

  // Ensure replace decorations are strictly non-overlapping so CodeMirror never throws.
  ctx.replaceEntries.sort((a, b) => a.from - b.from || b.to - a.to);
  const atomicRanges: Range<Decoration>[] = [];
  const appliedReplaces: Array<{ from: number; to: number }> = [];
  let lastReplaceTo = -1;
  for (const entry of ctx.replaceEntries) {
    if (entry.from < lastReplaceTo) continue;
    lastReplaceTo = entry.to;
    appliedReplaces.push({ from: entry.from, to: entry.to });
    ctx.markRanges.push(entry.decoration.range(entry.from, entry.to));
    if (entry.atomic) {
      atomicRanges.push(ATOMIC_RANGE_DECORATION.range(entry.from, entry.to));
    }
  }

  return {
    decorations: Decoration.set(ctx.markRanges, true),
    atomicRanges: Decoration.set(atomicRanges, true),
    inlineHiddenMarks: ctx.inlineHiddenMarks,
    appliedReplaces,
    deferredForComposition,
  };
}

export function buildMarkdownDecorations(view: EditorView): DecorationSet {
  return buildMarkdownLivePreview(view).decorations;
}

const composerMarkdownLivePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    atomicRanges: DecorationSet;
    inlineHiddenMarks: Array<{ from: number; to: number }>;
    private preCompositionReplaces: Array<{ from: number; to: number }>;
    private wasComposing: boolean;
    private deferredForComposition: boolean;
    private destroyed = false;

    constructor(view: EditorView) {
      this.wasComposing = view.composing || view.compositionStarted;
      const preview = buildMarkdownLivePreview(view);
      this.decorations = preview.decorations;
      this.atomicRanges = preview.atomicRanges;
      this.inlineHiddenMarks = preview.inlineHiddenMarks;
      this.preCompositionReplaces = preview.appliedReplaces;
      this.deferredForComposition = preview.deferredForComposition;
    }

    update(update: ViewUpdate) {
      const isComposing = update.view.composing || update.view.compositionStarted;
      const composingChanged = this.wasComposing !== isComposing;
      this.wasComposing = isComposing;

      if (isComposing && update.docChanged) {
        this.preCompositionReplaces = mapIntactRanges(this.preCompositionReplaces, update.changes);
      }

      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.focusChanged ||
        composingChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)
      ) {
        const preview = buildMarkdownLivePreview(
          update.view,
          isComposing ? this.preCompositionReplaces : undefined,
        );
        this.decorations = preview.decorations;
        this.atomicRanges = preview.atomicRanges;
        this.inlineHiddenMarks = preview.inlineHiddenMarks;
        this.deferredForComposition = preview.deferredForComposition;
        if (!isComposing) {
          this.preCompositionReplaces = preview.appliedReplaces;
        }
      }
    }

    schedulePostCompositionRefresh(view: EditorView) {
      if (!this.deferredForComposition) return;
      // Wait two microtasks so CodeMirror's own compositionend observer and its
      // pending-mutation flush run first; only dispatch a refresh if still deferred.
      queueMicrotask(() => {
        queueMicrotask(() => {
          if (
            this.destroyed ||
            !this.deferredForComposition ||
            view.composing ||
            view.compositionStarted
          ) {
            return;
          }
          view.dispatch({});
        });
      });
    }

    destroy() {
      this.destroyed = true;
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventObservers: {
      compositionend(_event, view) {
        this.schedulePostCompositionRefresh(view);
      },
    },
  },
);

export const composerMarkdownDecorations = [
  composerMarkdownLivePreviewPlugin,
  EditorView.atomicRanges.of(
    (view) => view.plugin(composerMarkdownLivePreviewPlugin)?.atomicRanges ?? Decoration.none,
  ),
];

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
          lineHeight: "1.45",
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
        // Headings — clear visual hierarchy aligned with MarkdownRenderer
        ".cm-line.cm-md-h1": {
          fontSize: "1.45em",
          lineHeight: "1.3",
          fontWeight: "700",
          paddingTop: "2px",
          paddingBottom: "2px",
        },
        ".cm-line.cm-md-h2": {
          fontSize: "1.3em",
          lineHeight: "1.32",
          fontWeight: "700",
          paddingTop: "2px",
          paddingBottom: "1px",
        },
        ".cm-line.cm-md-h3": {
          fontSize: "1.18em",
          lineHeight: "1.35",
          fontWeight: "700",
          paddingTop: "1px",
        },
        ".cm-line.cm-md-h4": {
          fontSize: "1.08em",
          lineHeight: "1.38",
          fontWeight: "600",
        },
        ".cm-line.cm-md-h5": {
          fontSize: "1.02em",
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
          padding: "1px 5px",
        },
        ".cm-md-link": {
          color: theme.accentBright,
        },
        ".cm-md-link-live": {
          textDecoration: "underline",
          textDecorationColor: `${theme.accentBright}66`,
          textUnderlineOffset: "2px",
        },
        ".cm-md-url, .cm-md-url span": {
          color: theme.foregroundMuted,
          textDecoration: "underline",
          textDecorationStyle: "dotted",
          textUnderlineOffset: "2px",
        },
        // Live Preview lists with hanging indents
        ".cm-line.cm-md-list-line": {
          paddingLeft: "calc(1.5em + var(--cm-list-depth, 0) * 1.4em)",
          textIndent: "-1.5em",
        },
        ".cm-line.cm-md-ordered-line": {
          paddingLeft: "calc(var(--cm-ol-width, 1.75em) + var(--cm-list-depth, 0) * 1.4em)",
          textIndent: "calc(-1 * var(--cm-ol-width, 1.75em))",
        },
        ".cm-line.cm-md-task-line": {
          paddingLeft: "calc(1.75em + var(--cm-list-depth, 0) * 1.4em)",
          textIndent: "-1.75em",
        },
        ".cm-line.cm-md-task-checked": {
          color: theme.foregroundMuted,
          textDecoration: "line-through",
        },
        ".cm-md-bullet-widget": {
          display: "inline-block",
          width: "1.5em",
          textAlign: "center",
          textIndent: "0",
          color: theme.accentBright,
          fontWeight: "700",
          userSelect: "none",
          verticalAlign: "baseline",
        },
        ".cm-md-bullet-depth-1": {
          color: theme.foregroundMuted,
          fontWeight: "600",
        },
        ".cm-md-bullet-depth-2": {
          color: theme.foregroundMuted,
          fontSize: "0.82em",
        },
        ".cm-md-ordered-widget": {
          display: "inline-block",
          width: "var(--cm-ol-width, 1.75em)",
          paddingRight: "0.4em",
          boxSizing: "border-box",
          textAlign: "right",
          textIndent: "0",
          color: theme.foregroundMuted,
          fontVariantNumeric: "tabular-nums",
          fontWeight: "600",
          userSelect: "none",
        },
        ".cm-md-task-widget": {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "1.75em",
          textIndent: "0",
          verticalAlign: "middle",
          cursor: "pointer",
          userSelect: "none",
        },
        ".cm-md-task-checkbox": {
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: "14px",
          height: "14px",
          borderRadius: "4px",
          border: `1.5px solid ${theme.foregroundMuted}`,
          backgroundColor: "transparent",
          color: theme.accentForeground,
          boxSizing: "border-box",
          transform: "translateY(-1px)",
          transition: "background-color 120ms ease, border-color 120ms ease",
        },
        ".cm-md-task-checkbox-checked": {
          backgroundColor: theme.accent,
          borderColor: theme.accent,
        },
        // Fallback raw list/task markers when revealed
        ".cm-md-list-mark, .cm-md-list-mark span": {
          color: theme.accentBright,
          fontWeight: "600",
        },
        ".cm-md-task-mark, .cm-md-task-mark span": {
          fontFamily: theme.monoFont,
          color: theme.accentBright,
          fontWeight: "600",
        },
        // Muted syntax delimiters (shown when cursor enters node to edit)
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
        ".cm-md-code-lang-badge, .cm-md-code-lang-badge span": {
          fontFamily: theme.monoFont,
          fontSize: `${Math.max(10, theme.codeFontSize - 2)}px`,
          color: theme.foregroundExtraMuted,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
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
        ".cm-line.cm-md-codeblock-fence-collapsed": {
          lineHeight: "4px",
          minHeight: "4px",
          fontSize: "4px",
        },
        ".cm-line.cm-md-blockquote-line": {
          borderLeft: `3px solid ${theme.foregroundExtraMuted}`,
          paddingLeft: "calc(10px + (var(--cm-quote-depth, 1) - 1) * 10px)",
          color: theme.foregroundMuted,
        },
        ".cm-line.cm-md-blockquote-line.cm-md-list-line": {
          paddingLeft:
            "calc(10px + (var(--cm-quote-depth, 1) - 1) * 10px + 1.5em + var(--cm-list-depth, 0) * 1.4em)",
        },
        ".cm-line.cm-md-blockquote-line.cm-md-ordered-line": {
          paddingLeft:
            "calc(10px + (var(--cm-quote-depth, 1) - 1) * 10px + var(--cm-ol-width, 1.75em) + var(--cm-list-depth, 0) * 1.4em)",
        },
        ".cm-line.cm-md-blockquote-line.cm-md-task-line": {
          paddingLeft:
            "calc(10px + (var(--cm-quote-depth, 1) - 1) * 10px + 1.75em + var(--cm-list-depth, 0) * 1.4em)",
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
        ".cm-md-hr-widget": {
          display: "inline-flex",
          alignItems: "center",
          width: "100%",
          height: "1em",
          verticalAlign: "middle",
          userSelect: "none",
        },
        ".cm-md-hr-bar": {
          display: "block",
          width: "100%",
          height: "1px",
          backgroundColor: theme.border,
        },
      },
      { dark: theme.colorScheme === "dark" },
    ),
    syntaxHighlighting(createCodeMirrorHighlightStyle(composerSyntaxColors)),
  ];
}

export interface MarkdownLineEdit {
  /** Replace from `lineFrom + replaceFrom` to `lineFrom + replaceTo` with `insert`. */
  replaceFrom: number;
  replaceTo: number;
  insert: string;
}

export type MarkdownNewlineContinuation = MarkdownLineEdit;

const TASK_LIST_LINE_RE = /^([ \t]*)([-*+][ \t]+)\[[ xX]\]([ \t]+)(.*)$/;
const BULLET_LIST_LINE_RE = /^([ \t]*)([-*+][ \t]+)(.*)$/;
const ORDERED_LIST_LINE_RE = /^([ \t]*)(\d+)([.)][ \t]+)(.*)$/;
const BLOCKQUOTE_LINE_RE = /^([ \t]*(?:>[ \t]?)+)(.*)$/;
const HEADING_PREFIX_RE = /^([ \t]{0,3}#{1,6}[ \t]+)(.*)$/;
const LAST_BLOCKQUOTE_LEVEL_RE = /^([ \t]*(?:>[ \t]?)*)(>[ \t]+)$/;

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

/**
 * Computes a Backspace edit when the collapsed caret sits immediately after a Live Preview
 * block prefix (list marker, task checkbox, heading hash prefix, or blockquote marker).
 * Indented list items outdent one level first; top-level prefixes convert back to plain text.
 */
export function computeMarkdownBackspaceEdit(
  lineText: string,
  column: number,
): MarkdownLineEdit | null {
  if (column <= 0) return null;
  const beforeCaret = lineText.slice(0, column);

  const listMatch =
    TASK_LIST_LINE_RE.exec(beforeCaret) ??
    BULLET_LIST_LINE_RE.exec(beforeCaret) ??
    ORDERED_LIST_LINE_RE.exec(beforeCaret);
  if (listMatch) {
    const indent = listMatch[1];
    const body = listMatch[listMatch.length - 1];
    if (body.length === 0) {
      if (indent.length > 0) {
        const removeCount = indent.endsWith("\t") ? 1 : Math.min(2, indent.length);
        return { replaceFrom: indent.length - removeCount, replaceTo: indent.length, insert: "" };
      }
      return { replaceFrom: 0, replaceTo: column, insert: "" };
    }
  }

  const headingMatch = HEADING_PREFIX_RE.exec(beforeCaret);
  if (headingMatch && headingMatch[2].length === 0) {
    return { replaceFrom: 0, replaceTo: column, insert: "" };
  }

  const quoteMatch = LAST_BLOCKQUOTE_LEVEL_RE.exec(beforeCaret);
  if (quoteMatch) {
    const keepLen = quoteMatch[1].length;
    return { replaceFrom: keepLen, replaceTo: column, insert: "" };
  }

  return null;
}

/**
 * Indents a Markdown list item by two spaces when pressing Tab on a list line.
 * Returns null for non-list lines or once max visual nesting depth is reached.
 */
export function computeMarkdownListIndentEdit(lineText: string): MarkdownLineEdit | null {
  const listMatch =
    TASK_LIST_LINE_RE.exec(lineText) ??
    BULLET_LIST_LINE_RE.exec(lineText) ??
    ORDERED_LIST_LINE_RE.exec(lineText);
  if (!listMatch) return null;
  const indent = listMatch[1];
  if (measureVisualIndent(indent) >= MAX_LIST_DEPTH * 2) return null;
  return { replaceFrom: 0, replaceTo: 0, insert: "  " };
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

export function handleMarkdownBackspace(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const { selection, doc } = view.state;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const pos = selection.main.head;
  if (pos <= 0 || isPositionInsideFencedCode(view, pos)) return false;

  const line = doc.lineAt(pos);
  const blockEdit = computeMarkdownBackspaceEdit(line.text, pos - line.from);
  if (blockEdit) {
    const from = line.from + blockEdit.replaceFrom;
    const to = line.from + blockEdit.replaceTo;
    const removed = to - from;
    const nextCursor = pos - removed + blockEdit.insert.length;
    view.dispatch({
      changes: { from, to, insert: blockEdit.insert },
      selection: { anchor: Math.max(line.from, nextCursor) },
      scrollIntoView: true,
      userEvent: "delete.backward",
    });
    return true;
  }

  // When backspacing immediately after a hidden multi-char inline closing delimiter
  // (e.g. `**bold**|` or `[docs](https://...)|`), delete only the final character so
  // atomicRanges does not wipe the entire closing URL/syntax at once.
  const plugin = view.plugin(composerMarkdownLivePreviewPlugin);
  if (plugin) {
    for (const hidden of plugin.inlineHiddenMarks) {
      if (hidden.to === pos && hidden.to - hidden.from > 1) {
        view.dispatch({
          changes: { from: pos - 1, to: pos, insert: "" },
          selection: { anchor: pos - 1 },
          scrollIntoView: true,
          userEvent: "delete.backward",
        });
        return true;
      }
    }
  }

  return false;
}

export function indentMarkdownListItem(view: EditorView): boolean {
  if (view.composing || view.state.readOnly) return false;
  const { selection, doc } = view.state;
  if (selection.ranges.length !== 1 || !selection.main.empty) return false;
  const pos = selection.main.head;
  if (isPositionInsideFencedCode(view, pos)) return false;

  const line = doc.lineAt(pos);
  const edit = computeMarkdownListIndentEdit(line.text);
  if (!edit) return false;

  view.dispatch({
    changes: {
      from: line.from + edit.replaceFrom,
      to: line.from + edit.replaceTo,
      insert: edit.insert,
    },
    selection: { anchor: pos + edit.insert.length },
    scrollIntoView: true,
    userEvent: "input.indent",
  });
  return true;
}
