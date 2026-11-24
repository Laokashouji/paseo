import { describe, expect, it, vi } from "vitest";
import type { UserComposerAttachment } from "@/attachments/types";
import { openComposerAttachment } from "@/composer/actions";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";
import { isUserComposerAttachment, normalizeComposerAttachment } from "@/stores/draft-store/state";
import {
  appendSideQuestionQuoteAttachment,
  createSideQuestionQuoteAttachment,
  getSideQuestionQuoteTitle,
  parseSideQuestionQuoteTextAttachmentTitle,
  sideQuestionQuoteAttachmentToAgentAttachment,
} from "./side-question-quote";

describe("side question quote attachments", () => {
  it("creates normalized quote attachments and rejects blank responses", () => {
    expect(
      createSideQuestionQuoteAttachment({
        turnId: "btw-1",
        question: "Why did it fail?",
        response: "   ",
      }),
    ).toBeNull();

    const quote = createSideQuestionQuoteAttachment({
      turnId: " btw-1 ",
      question: "  Why did   it fail? \n",
      response: "  Missing timeout guard.  ",
    });

    expect(quote).toEqual({
      kind: "side_question_quote",
      turnId: "btw-1",
      question: "Why did   it fail?",
      response: "Missing timeout guard.",
    });
    expect(isUserComposerAttachment(quote)).toBe(true);
    expect(
      normalizeComposerAttachment({
        kind: "side_question_quote",
        turnId: " btw-1 ",
        question: " Q ",
        response: " A ",
      }),
    ).toEqual({
      kind: "side_question_quote",
      turnId: "btw-1",
      question: "Q",
      response: "A",
    });
  });

  it("deduplicates quotes by turnId while keeping distinct turns", () => {
    const first = createSideQuestionQuoteAttachment({
      turnId: "btw-1",
      question: "First question",
      response: "First answer",
    })!;
    const duplicate = createSideQuestionQuoteAttachment({
      turnId: "btw-1",
      question: "First question",
      response: "First answer",
    })!;
    const second = createSideQuestionQuoteAttachment({
      turnId: "btw-2",
      question: "Second question",
      response: "Second answer",
    })!;
    const current: UserComposerAttachment[] = [first];

    expect(appendSideQuestionQuoteAttachment(current, duplicate)).toBe(current);
    expect(appendSideQuestionQuoteAttachment(current, second)).toEqual([first, second]);
  });

  it("summarizes long questions and converts into a text attachment containing Q&A", () => {
    const quote = createSideQuestionQuoteAttachment({
      turnId: "btw-3",
      question:
        "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常非常长的旁路提问标题用于验证超过四十八字符时的截断效果",
      response: "- 方案一：推荐\n- 方案二：备选",
    })!;

    const title = getSideQuestionQuoteTitle(quote);
    expect(title.length).toBeLessThanOrEqual(48);
    expect(title.endsWith("…")).toBe(true);

    const submitted = sideQuestionQuoteAttachmentToAgentAttachment(quote);
    expect(submitted).toEqual({
      type: "text",
      mimeType: "text/plain",
      title: `BTW · ${title}`,
      text: [
        "Referenced result from an earlier /btw side question (not previously in the main conversation history):",
        "",
        `Question: ${quote.question}`,
        "",
        "Answer:",
        quote.response,
      ].join("\n"),
    });
    expect(parseSideQuestionQuoteTextAttachmentTitle(submitted.title)).toBe(title);
    expect(splitComposerAttachmentsForSubmit([quote])).toEqual({
      images: [],
      attachments: [submitted],
    });
  });

  it("treats opening a quote pill as a no-op", () => {
    const quote = createSideQuestionQuoteAttachment({
      turnId: "btw-4",
      question: "Question",
      response: "Answer",
    })!;
    const setLightboxMetadata = vi.fn();
    const openWorkspaceAttachment = vi.fn(() => false);
    const openExternalUrl = vi.fn();

    openComposerAttachment({
      attachment: quote,
      setLightboxMetadata,
      openWorkspaceAttachment,
      openExternalUrl,
    });

    expect(setLightboxMetadata).not.toHaveBeenCalled();
    expect(openWorkspaceAttachment).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});
