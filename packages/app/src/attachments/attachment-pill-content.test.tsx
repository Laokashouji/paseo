import { describe, expect, it } from "vitest";
import { i18n } from "@/i18n/i18next";
import {
  createSideQuestionQuoteAttachment,
  sideQuestionQuoteAttachmentToAgentAttachment,
} from "./side-question-quote";
import { getAgentAttachmentPillContent } from "./attachment-pill-content";

describe("agent attachment pill content", () => {
  it("presents external resources with their provider identity", () => {
    const content = getAgentAttachmentPillContent(
      {
        type: "text",
        mimeType: "text/plain",
        title: "ENG-123 Plugin attachments",
        text: "Linear issue ENG-123: Plugin attachments",
        externalResource: {
          provider: "linear",
          providerLabel: "Linear issue",
          resourceType: "issue",
          id: "issue-uuid",
          identifier: "ENG-123",
          title: "Plugin attachments",
          url: "https://linear.app/acme/issue/ENG-123/plugin-attachments",
        },
      },
      i18n.t,
    );

    expect(content.title).toBe("Plugin attachments");
    expect(content.subtitle).toBe("Linear issue ENG-123");
  });

  it("presents sent BTW quote text attachments with their question summary and quote subtitle", () => {
    const quote = createSideQuestionQuoteAttachment({
      turnId: "btw-1",
      question: "How should docs metadata work?",
      response: "Use lightweight frontmatter only when scripts read it.",
    })!;
    const content = getAgentAttachmentPillContent(
      sideQuestionQuoteAttachmentToAgentAttachment(quote),
      i18n.t,
    );

    expect(content.title).toBe("How should docs metadata work?");
    expect(content.subtitle).toBe(i18n.t("sideQuestion.quoteSubtitle"));
  });
});
