import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  computeInlineCardKey,
  extractFallbackFromRawCardJson,
  extractFencedCardBlocks,
  INTERACTIVE_CARD_MAX_BYTES,
  isAllowedCardUrl,
  isInteractiveCardToolName,
  sha256HexSync,
  validateInteractiveCardView,
} from "./interactive-cards.js";
import {
  SessionEventSubscriptionSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

describe("interactive-cards protocol", () => {
  it("computes FIPS 180-4 SHA-256 identically to node:crypto", () => {
    for (const sample of [
      "",
      "hello world",
      "你好，世界！🚀\n```paseo-view\n{}\n```",
      "a".repeat(200),
    ]) {
      const expected = createHash("sha256").update(sample, "utf8").digest("hex");
      expect(sha256HexSync(sample)).toBe(expected);
    }
    expect(computeInlineCardKey("foo\r\nbar  ", 0)).toBe(computeInlineCardKey("foo\nbar", 0));
  });

  it("extracts complete and streaming fenced paseo-view blocks", () => {
    const md = [
      "Intro text",
      "```paseo-view",
      '{"fallback":"A","sections":[{"items":[{"type":"text","text":"Hi"}]}]}',
      "```",
      "Middle",
      "```ts",
      "const x = 1;",
      "```",
      "~~~paseo-view",
      '{"fallback":"Streaming fallback"',
    ].join("\n");

    const blocks = extractFencedCardBlocks(md);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.complete).toBe(true);
    expect(blocks[0]?.blockIndex).toBe(0);
    expect(blocks[1]?.complete).toBe(false);
    expect(blocks[1]?.blockIndex).toBe(1);
    expect(extractFallbackFromRawCardJson(blocks[1]!.raw)).toBe("Streaming fallback");
  });

  it("validates single-component shorthand, steps alias, and rich multi-page cards", () => {
    const shorthand = validateInteractiveCardView({
      type: "steps",
      title: "Release flow",
      fallback: "Step 1 done, step 2 running",
      steps: [
        { label: "Build", status: "done" },
        { label: "Verify", status: "in_progress" },
      ],
    });
    expect(shorthand.ok).toBe(true);
    if (shorthand.ok) {
      expect(shorthand.view.sections[0]?.items[0]?.type).toBe("checklist");
    }

    const rich = validateInteractiveCardView({
      title: "Automation Settings",
      fallback: "Configure toggles and directory",
      sections: [
        {
          items: [
            {
              type: "field",
              name: "autoSupervise",
              label: "Auto supervise",
              kind: "toggle",
              value: true,
            },
            {
              type: "field",
              name: "dir",
              label: "Allowed dir",
              kind: "choice",
              choices: ["none", "repo-a", "repo-b", "repo-c", "repo-d"],
              value: "none",
            },
            {
              type: "button",
              label: "Details",
              action: { kind: "push_page", id: "open-details", page: "detail" },
            },
            {
              type: "button",
              label: "Submit",
              variant: "primary",
              action: { kind: "reply", id: "submit-form", reply: "Apply settings", submit: true },
            },
          ],
        },
      ],
      pages: {
        detail: {
          title: "Metrics",
          sections: [
            {
              items: [
                {
                  type: "chart",
                  chartType: "bar",
                  categories: ["Mon", "Tue"],
                  series: [{ name: "Tasks", values: [3, 5] }],
                },
                {
                  type: "button",
                  label: "Back",
                  action: { kind: "pop_page", id: "go-back" },
                },
              ],
            },
          ],
        },
      },
    });
    expect(rich.ok).toBe(true);
  });

  it("rejects forbidden secret fields, html components, unsafe URLs, nested pages, and oversized views", () => {
    expect(
      validateInteractiveCardView({
        fallback: "Enter token",
        sections: [{ items: [{ type: "field", name: "tok", label: "Token", kind: "secret" }] }],
      }).ok,
    ).toBe(false);

    expect(
      validateInteractiveCardView({
        fallback: "Unsafe",
        sections: [{ items: [{ type: "html", html: "<script>alert(1)</script>" }] }],
      }).ok,
    ).toBe(false);

    expect(
      validateInteractiveCardView({
        fallback: "Bad link",
        sections: [{ items: [{ type: "link", label: "Click", url: "javascript:alert(1)" }] }],
      }).ok,
    ).toBe(false);

    expect(
      validateInteractiveCardView({
        fallback: "Nested",
        sections: [{ items: [{ type: "text", text: "Root" }] }],
        pages: {
          p1: {
            sections: [{ items: [{ type: "text", text: "Child" }] }],
            pages: { p2: { sections: [{ items: [{ type: "text", text: "Grandchild" }] }] } },
          },
        },
      }).ok,
    ).toBe(false);

    expect(
      validateInteractiveCardView({
        fallback: "Huge",
        sections: [{ items: [{ type: "text", text: "x".repeat(INTERACTIVE_CARD_MAX_BYTES) }] }],
      }).ok,
    ).toBe(false);

    expect(isAllowedCardUrl("https://example.com/path")).toBe(true);
    expect(isAllowedCardUrl("paseo://agent/srv1/ag1")).toBe(true);
    expect(isAllowedCardUrl("paseo://task/task_abcdef12")).toBe(true);
    expect(isAllowedCardUrl("paseo://file/src/index.ts")).toBe(true);
    expect(isAllowedCardUrl("paseo://workspace/ws_1")).toBe(true);
    expect(isAllowedCardUrl("http://example.com")).toBe(false);
    expect(isAllowedCardUrl("paseo://exec/rm")).toBe(false);

    expect(
      validateInteractiveCardView({
        fallback: "Open session or task",
        sections: [
          {
            items: [
              { type: "link", label: "Task", url: "paseo://task/task_abcdef12" },
              {
                type: "button",
                label: "Inspect",
                action: { kind: "open", id: "open-task", url: "paseo://task/task_abcdef12" },
              },
            ],
          },
        ],
      }).ok,
    ).toBe(true);
  });

  it("recognizes bare and MCP-prefixed interactive card tool names", () => {
    expect(isInteractiveCardToolName("view_show")).toBe("view_show");
    expect(isInteractiveCardToolName("mcp__paseo__view_update")).toBe("view_update");
    expect(isInteractiveCardToolName("paseo:view_get")).toBe("view_get");
    expect(isInteractiveCardToolName("other_tool")).toBeNull();
  });

  it("parses interactive card RPCs and events in root session message unions", () => {
    expect(SessionEventSubscriptionSchema.parse("agent.cards.update")).toBe("agent.cards.update");
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.cards.list.request",
        requestId: "req-1",
        agentId: "agent-1",
      }).type,
    ).toBe("agent.cards.list.request");
    expect(
      SessionInboundMessageSchema.parse({
        type: "agent.cards.submit.request",
        requestId: "req-2",
        agentId: "agent-1",
        cardKey: "view_0123456789ab",
        actionId: "confirm",
        expectedVersion: 1,
        clientMessageId: "cmsg-1",
      }).type,
    ).toBe("agent.cards.submit.request");
    expect(
      SessionOutboundMessageSchema.parse({
        type: "agent.cards.update",
        payload: {
          agentId: "agent-1",
          kind: "inline_registered",
          inlineBlockKey: "inline:0123456789abcdef/0",
        },
      }).type,
    ).toBe("agent.cards.update");
  });
});
