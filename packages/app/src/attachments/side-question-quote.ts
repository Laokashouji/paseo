import type { AgentAttachment } from "@getpaseo/protocol/messages";
import type { SideQuestionQuoteComposerAttachment, UserComposerAttachment } from "./types";

export const SIDE_QUESTION_QUOTE_TITLE_PREFIX = "BTW · ";
const MAX_QUOTE_TITLE_LENGTH = 48;

interface CreateSideQuestionQuoteAttachmentInput {
  turnId: string;
  question: string;
  response: string;
}

function summarizeSingleLine(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "";
  }
  return collapsed.length > MAX_QUOTE_TITLE_LENGTH
    ? `${collapsed.slice(0, MAX_QUOTE_TITLE_LENGTH - 1).trimEnd()}…`
    : collapsed;
}

export function createSideQuestionQuoteAttachment(
  input: CreateSideQuestionQuoteAttachmentInput,
): SideQuestionQuoteComposerAttachment | null {
  const turnId = input.turnId.trim();
  const question = input.question.trim();
  const response = input.response.trim();
  if (!turnId || !response) {
    return null;
  }
  return {
    kind: "side_question_quote",
    turnId,
    question,
    response,
  };
}

export function getSideQuestionQuoteAttachmentKey(
  attachment: Pick<SideQuestionQuoteComposerAttachment, "turnId">,
): string {
  return attachment.turnId.trim();
}

export function appendSideQuestionQuoteAttachment(
  current: UserComposerAttachment[],
  attachment: SideQuestionQuoteComposerAttachment,
): UserComposerAttachment[] {
  const attachmentKey = getSideQuestionQuoteAttachmentKey(attachment);
  const alreadyAttached = current.some(
    (candidate) =>
      candidate.kind === "side_question_quote" &&
      getSideQuestionQuoteAttachmentKey(candidate) === attachmentKey,
  );
  return alreadyAttached ? current : [...current, attachment];
}

export function getSideQuestionQuoteTitle(
  attachment: Pick<SideQuestionQuoteComposerAttachment, "question" | "response">,
): string {
  return (
    summarizeSingleLine(attachment.question) || summarizeSingleLine(attachment.response) || "BTW"
  );
}

export function sideQuestionQuoteAttachmentToAgentAttachment(
  attachment: SideQuestionQuoteComposerAttachment,
): Extract<AgentAttachment, { type: "text" }> {
  const question = attachment.question.trim();
  const response = attachment.response.trim();
  const titleSummary = getSideQuestionQuoteTitle(attachment);
  const sections = [
    "Referenced result from an earlier /btw side question (not previously in the main conversation history):",
  ];
  if (question) {
    sections.push("", `Question: ${question}`);
  }
  sections.push("", "Answer:", response);
  return {
    type: "text",
    mimeType: "text/plain",
    title: `${SIDE_QUESTION_QUOTE_TITLE_PREFIX}${titleSummary}`,
    text: sections.join("\n"),
  };
}

export function parseSideQuestionQuoteTextAttachmentTitle(
  title: string | null | undefined,
): string | null {
  if (!title || !title.startsWith(SIDE_QUESTION_QUOTE_TITLE_PREFIX)) {
    return null;
  }
  const stripped = title.slice(SIDE_QUESTION_QUOTE_TITLE_PREFIX.length).trim();
  return stripped || null;
}
