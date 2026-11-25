export type QuoteAuthorRole = "user" | "assistant";

export interface DraftQuoteComment {
  /** Reader's annotation attached to the selected passage. */
  body: string;
}

export interface DraftQuote {
  /** Stable local identifier used for removal and active-editor tracking. */
  id: string;
  /** Quoted message text or highlighted excerpt. */
  text: string;
  /** Role of the source message when known. */
  role?: QuoteAuthorRole;
  /** Optional display name of the author (e.g. external sender). */
  from?: string;
  /** Source message timestamp in epoch milliseconds when known. */
  ts?: number;
  /** Source timeline item id when quoted from a specific message. */
  sourceItemId?: string;
  /** Present when this entry was created as a selection comment. */
  comment?: DraftQuoteComment;
}

export interface ParsedMessageQuote {
  kind: "quote" | "comment";
  /** 1-based comment number for comment blocks. */
  commentNumber?: number;
  role?: QuoteAuthorRole;
  from?: string;
  timeLabel?: string;
  /** Quoted text or highlighted selection excerpt. */
  text: string;
  /** Reader's annotation body for comment blocks. */
  commentBody?: string;
}

export const MAX_QUOTE_STACK_ITEMS = 20;
export const MAX_COMMENT_CHARS = 4000;
