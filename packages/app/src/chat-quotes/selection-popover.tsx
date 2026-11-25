import type { ReactNode } from "react";
import type { QuoteAuthorRole } from "./types";

export interface SelectionQuotePayload {
  text: string;
  role?: QuoteAuthorRole;
  ts?: number;
  sourceItemId?: string;
}

export interface MessageSelectionPopoverSurfaceProps {
  enabled: boolean;
  onCommentSelection: (payload: SelectionQuotePayload) => void;
  onQuoteSelection: (payload: SelectionQuotePayload) => void;
  children: ReactNode;
}

/**
 * Native no-op wrapper — desktop text-selection comment/quote popover only runs on Web/Electron.
 */
export function MessageSelectionPopoverSurface({ children }: MessageSelectionPopoverSurfaceProps) {
  return children;
}
