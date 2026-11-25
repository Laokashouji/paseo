import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { Theme } from "@/styles/theme";
import type { QuoteAuthorRole } from "./types";
import type {
  MessageSelectionPopoverSurfaceProps,
  SelectionQuotePayload,
} from "./selection-popover";

interface ActiveSelectionPopover {
  left: number;
  top: number;
  placement: "above" | "below";
  payload: SelectionQuotePayload;
}

const DISPLAY_CONTENTS: CSSProperties = { display: "contents" };
const POPOVER_HALF_WIDTH_ESTIMATE = 78;
const POPOVER_HEIGHT_ESTIMATE = 36;
const VIEWPORT_EDGE_MARGIN = 12;
const SELECTION_VERTICAL_GAP = 8;

function resolveElement(node: Node | null): HTMLElement | null {
  if (!node) return null;
  if (node instanceof HTMLElement) return node;
  return node.parentElement;
}

function isEditableElement(el: HTMLElement | null): boolean {
  if (!el) return false;
  if (el.closest("input, textarea, [contenteditable='true'], [contenteditable='']")) {
    return true;
  }
  return false;
}

function findMessageTextAncestor(node: Node | null, boundary: HTMLElement): HTMLElement | null {
  const el = resolveElement(node);
  if (!el || !boundary.contains(el)) return null;
  const messageEl = el.closest<HTMLElement>('[data-message-text="true"]');
  if (!messageEl || !boundary.contains(messageEl)) return null;
  return messageEl;
}

function readSelectionMetadata(el: HTMLElement): Omit<SelectionQuotePayload, "text"> {
  const roleAttr = el.getAttribute("data-quote-role");
  const role: QuoteAuthorRole | undefined =
    roleAttr === "user" || roleAttr === "assistant" ? roleAttr : undefined;
  const sourceItemId = el.getAttribute("data-quote-item-id") || undefined;
  const rawTs = el.getAttribute("data-quote-ts");
  const parsedTs = rawTs ? Number(rawTs) : Number.NaN;
  const ts = Number.isFinite(parsedTs) && parsedTs > 0 ? parsedTs : undefined;
  return {
    ...(role ? { role } : {}),
    ...(sourceItemId ? { sourceItemId } : {}),
    ...(ts !== undefined ? { ts } : {}),
  };
}

function computePopoverState(boundary: HTMLElement): ActiveSelectionPopover | null {
  if (typeof window === "undefined") return null;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }

  const rawText = selection.toString();
  const trimmedText = rawText.trim();
  if (!trimmedText) {
    return null;
  }

  const anchorEl = resolveElement(selection.anchorNode);
  const focusEl = resolveElement(selection.focusNode);
  if (isEditableElement(anchorEl) || isEditableElement(focusEl)) {
    return null;
  }

  const anchorMessage = findMessageTextAncestor(selection.anchorNode, boundary);
  const focusMessage = findMessageTextAncestor(selection.focusNode, boundary);
  if (!anchorMessage || !focusMessage) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (typeof range.getBoundingClientRect !== "function") {
    return null;
  }
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    return null;
  }
  // Hide when scrolled completely outside the visible viewport.
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    return null;
  }

  const centerX = rect.left + rect.width / 2;
  const minLeft = VIEWPORT_EDGE_MARGIN + POPOVER_HALF_WIDTH_ESTIMATE;
  const maxLeft = Math.max(
    minLeft,
    window.innerWidth - VIEWPORT_EDGE_MARGIN - POPOVER_HALF_WIDTH_ESTIMATE,
  );
  const clampedCenterX = Math.min(Math.max(centerX, minLeft), maxLeft);

  const showBelow = rect.top < POPOVER_HEIGHT_ESTIMATE + VIEWPORT_EDGE_MARGIN + 8;
  const top = showBelow
    ? Math.min(
        window.innerHeight - POPOVER_HEIGHT_ESTIMATE - VIEWPORT_EDGE_MARGIN,
        rect.bottom + SELECTION_VERTICAL_GAP,
      )
    : Math.max(VIEWPORT_EDGE_MARGIN, rect.top - POPOVER_HEIGHT_ESTIMATE - SELECTION_VERTICAL_GAP);

  const metadata = readSelectionMetadata(anchorMessage);
  return {
    left: clampedCenterX,
    top,
    placement: showBelow ? "below" : "above",
    payload: {
      text: trimmedText,
      ...metadata,
    },
  };
}

interface FloatingToolbarProps {
  popoverRef: RefObject<HTMLDivElement | null>;
  left: number;
  top: number;
  placement: "above" | "below";
  toolbarLabel: string;
  commentLabel: string;
  quoteLabel: string;
  onMouseDownButton: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onCommentClick: () => void;
  onQuoteClick: () => void;
  surfaceColor: string;
  borderColor: string;
  foregroundColor: string;
  accentColor: string;
  fontFamily: string;
}

const FloatingToolbarInner = memo(function FloatingToolbarInner({
  popoverRef,
  left,
  top,
  placement,
  toolbarLabel,
  commentLabel,
  quoteLabel,
  onMouseDownButton,
  onCommentClick,
  onQuoteClick,
  surfaceColor,
  borderColor,
  foregroundColor,
  accentColor,
  fontFamily,
}: FloatingToolbarProps) {
  const containerStyle = useMemo<CSSProperties>(
    () => ({
      position: "fixed",
      left,
      top,
      transform: "translateX(-50%)",
      zIndex: 9999,
      display: "inline-flex",
      alignItems: "center",
      gap: 2,
      padding: 3,
      borderRadius: 999,
      backgroundColor: surfaceColor,
      border: `1px solid ${borderColor}`,
      boxShadow: "0 6px 20px rgba(0, 0, 0, 0.16)",
      userSelect: "none",
      WebkitUserSelect: "none",
      whiteSpace: "nowrap",
    }),
    [borderColor, left, surfaceColor, top],
  );

  const buttonStyle = useMemo<CSSProperties>(
    () => ({
      appearance: "none",
      border: "none",
      background: "transparent",
      color: foregroundColor,
      fontFamily,
      fontSize: 12,
      fontWeight: 500,
      lineHeight: "16px",
      padding: "5px 10px",
      borderRadius: 999,
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      gap: 5,
    }),
    [fontFamily, foregroundColor],
  );

  const accentDotStyle = useMemo<CSSProperties>(
    () => ({
      width: 6,
      height: 6,
      borderRadius: 999,
      backgroundColor: accentColor,
      display: "inline-block",
    }),
    [accentColor],
  );

  const dividerStyle = useMemo<CSSProperties>(
    () => ({
      width: 1,
      height: 14,
      backgroundColor: borderColor,
      display: "inline-block",
    }),
    [borderColor],
  );

  return (
    <div
      ref={popoverRef}
      role="toolbar"
      aria-label={toolbarLabel}
      data-chat-selection-popover="true"
      data-testid="chat-selection-popover"
      data-placement={placement}
      style={containerStyle}
    >
      <button
        type="button"
        data-testid="selection-popover-comment"
        onMouseDown={onMouseDownButton}
        onClick={onCommentClick}
        style={buttonStyle}
      >
        <span aria-hidden style={accentDotStyle} />
        {commentLabel}
      </button>
      <span aria-hidden style={dividerStyle} />
      <button
        type="button"
        data-testid="selection-popover-quote"
        onMouseDown={onMouseDownButton}
        onClick={onQuoteClick}
        style={buttonStyle}
      >
        {quoteLabel}
      </button>
    </div>
  );
});

const ThemedFloatingToolbar = withUnistyles(FloatingToolbarInner, (theme: Theme) => ({
  surfaceColor: theme.colors.surface1,
  borderColor: theme.colors.border,
  foregroundColor: theme.colors.foreground,
  accentColor: theme.colors.accent,
  fontFamily: theme.fontFamily.ui,
}));

/**
 * Web/Electron floating "Comment / Quote" toolbar triggered by text selection inside chat
 * messages. It observes `window.getSelection()` passively so native / `AssistantSelectionCopySurface`
 * copy (`Cmd/Ctrl+C`) stays untouched.
 */
export function MessageSelectionPopoverSurface({
  enabled,
  onCommentSelection,
  onQuoteSelection,
  children,
}: MessageSelectionPopoverSurfaceProps) {
  const { t } = useTranslation();
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const [popover, setPopover] = useState<ActiveSelectionPopover | null>(null);

  const stableOnComment = useStableEvent(onCommentSelection);
  const stableOnQuote = useStableEvent(onQuoteSelection);

  const syncFromSelection = useCallback(() => {
    if (!enabled) {
      setPopover(null);
      return;
    }
    const boundary = wrapperRef.current;
    if (!boundary) {
      setPopover(null);
      return;
    }
    setPopover(computePopoverState(boundary));
  }, [enabled]);

  const scheduleSync = useCallback(() => {
    if (typeof window === "undefined") return;
    if (rafRef.current !== null) {
      window.cancelAnimationFrame(rafRef.current);
    }
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null;
      syncFromSelection();
    });
  }, [syncFromSelection]);

  useEffect(() => {
    if (!enabled) {
      setPopover(null);
      return;
    }
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    const handleSelectionChange = () => {
      scheduleSync();
    };
    const handleMouseUp = (event: MouseEvent) => {
      if (popoverRef.current?.contains(event.target as Node | null)) {
        return;
      }
      scheduleSync();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPopover(null);
        return;
      }
      if (event.shiftKey || event.key === "a" || event.key === "A") {
        scheduleSync();
      }
    };
    const handleMouseDown = (event: MouseEvent) => {
      if (popoverRef.current?.contains(event.target as Node | null)) {
        return;
      }
      setPopover(null);
    };
    const handleViewportMove = () => {
      scheduleSync();
    };

    document.addEventListener("selectionchange", handleSelectionChange);
    document.addEventListener("mouseup", handleMouseUp);
    document.addEventListener("keyup", handleKeyUp);
    document.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("resize", handleViewportMove);
    window.addEventListener("scroll", handleViewportMove, true);

    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      document.removeEventListener("selectionchange", handleSelectionChange);
      document.removeEventListener("mouseup", handleMouseUp);
      document.removeEventListener("keyup", handleKeyUp);
      document.removeEventListener("mousedown", handleMouseDown);
      window.removeEventListener("resize", handleViewportMove);
      window.removeEventListener("scroll", handleViewportMove, true);
    };
  }, [enabled, scheduleSync]);

  const preserveSelectionOnMouseDown = useCallback((event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const clearSelectionAndClose = useCallback(() => {
    setPopover(null);
    if (typeof window !== "undefined") {
      window.getSelection()?.removeAllRanges();
    }
  }, []);

  const handleCommentClick = useCallback(() => {
    if (!popover) return;
    const payload = popover.payload;
    clearSelectionAndClose();
    stableOnComment(payload);
  }, [clearSelectionAndClose, popover, stableOnComment]);

  const handleQuoteClick = useCallback(() => {
    if (!popover) return;
    const payload = popover.payload;
    clearSelectionAndClose();
    stableOnQuote(payload);
  }, [clearSelectionAndClose, popover, stableOnQuote]);

  const portalNode =
    popover && typeof document !== "undefined"
      ? createPortal(
          <ThemedFloatingToolbar
            popoverRef={popoverRef}
            left={popover.left}
            top={popover.top}
            placement={popover.placement}
            toolbarLabel={t("chatQuotes.selectionToolbarLabel")}
            commentLabel={t("chatQuotes.commentAction")}
            quoteLabel={t("chatQuotes.quoteAction")}
            onMouseDownButton={preserveSelectionOnMouseDown}
            onCommentClick={handleCommentClick}
            onQuoteClick={handleQuoteClick}
          />,
          document.body,
        )
      : null;

  return (
    <div ref={wrapperRef} style={DISPLAY_CONTENTS}>
      {children}
      {portalNode}
    </div>
  );
}
