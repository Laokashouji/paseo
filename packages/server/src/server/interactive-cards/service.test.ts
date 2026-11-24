import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeInlineCardKey,
  INTERACTIVE_CARD_TOOL_NAMES,
  type AgentCardsUpdateEventPayload,
} from "@getpaseo/protocol/interactive-cards";
import {
  SessionOutboundMessageSchema,
  type SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import { registerInteractiveCardTools } from "./mcp-tools.js";
import { InteractiveCardsService } from "./service.js";
import { handleInteractiveCardsSessionMessage } from "./session.js";

const logger = pino({ level: "silent" });

describe("InteractiveCardsService & MCP tools", () => {
  const tempDirs: string[] = [];

  async function createTempHome(): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-cards-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles live card show, update, version conflict, ownership isolation, and persistence across restart", async () => {
    const home = await createTempHome();
    const delivered: Array<{ agentId: string; text: string; clientMessageId: string }> = [];
    const events: AgentCardsUpdateEventPayload[] = [];
    const service = new InteractiveCardsService({
      paseoHome: home,
      logger,
      updateBroadcastCoalesceMs: 0,
      deliverUserReply: async (input) => {
        delivered.push(input);
      },
    });
    service.subscribe((evt) => events.push(evt));

    const created = await service.showLiveCard({
      agentId: "agent-a",
      view: {
        title: "Automation Settings",
        fallback: "Configure toggles",
        sections: [
          {
            items: [
              {
                type: "field",
                name: "supervise",
                label: "Auto supervise",
                kind: "toggle",
                value: "true",
              },
              {
                type: "field",
                name: "dir",
                label: "Work dir",
                kind: "choice",
                options: [
                  { value: "none", label: "None" },
                  { value: "repo", label: "Repo" },
                ],
                value: "none",
              },
              {
                type: "button",
                label: "Save",
                variant: "primary",
                action: {
                  kind: "reply",
                  id: "save",
                  reply: "Apply automation settings",
                  submit: true,
                },
              },
            ],
          },
        ],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.card.version).toBe(1);

    // Other agent cannot read or update agent-a's card
    const crossGet = await service.getLiveCard({ agentId: "agent-b", id: created.card.id });
    expect(crossGet.ok).toBe(false);

    // Update succeeds and increments version
    const updated = await service.updateLiveCard({
      agentId: "agent-a",
      id: created.card.id,
      expectedVersion: 1,
      view: {
        ...created.card.view,
        title: "Automation Settings v2",
      },
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.card.version).toBe(2);

    // Stale expectedVersion fails with version_conflict
    const conflict = await service.updateLiveCard({
      agentId: "agent-a",
      id: created.card.id,
      expectedVersion: 1,
      view: created.card.view,
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) {
      expect(conflict.code).toBe("version_conflict");
      expect(conflict.currentVersion).toBe(2);
    }

    // Submitting with stale expectedVersion returns view_changed + latest view
    const staleSubmit = await service.submitCardAction({
      agentId: "agent-a",
      cardKey: created.card.id,
      actionId: "save",
      values: { supervise: "true", dir: "repo" },
      expectedVersion: 1,
      clientMessageId: "cmsg-stale",
    });
    expect(staleSubmit.ok).toBe(false);
    expect(staleSubmit.code).toBe("view_changed");
    expect(staleSubmit.view?.version).toBe(2);

    // Submitting with current version validates, formats reply on server, and delivers once
    const submitOk = await service.submitCardAction({
      agentId: "agent-a",
      cardKey: created.card.id,
      actionId: "save",
      values: { supervise: "false", dir: "repo" },
      expectedVersion: 2,
      clientMessageId: "cmsg-1",
    });
    expect(submitOk.ok).toBe(true);
    expect(submitOk.action?.status).toBe("sent");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain("Apply automation settings");
    expect(delivered[0]?.text).toContain("Auto supervise: 关闭 (false)");
    expect(delivered[0]?.text).toContain("Work dir: Repo (repo)");

    // Another client submitting the same card gets already_answered
    const secondClient = await service.submitCardAction({
      agentId: "agent-a",
      cardKey: created.card.id,
      actionId: "save",
      values: { supervise: "true", dir: "none" },
      expectedVersion: 2,
      clientMessageId: "cmsg-2",
    });
    expect(secondClient.ok).toBe(false);
    expect(secondClient.code).toBe("already_answered");
    expect(secondClient.action?.clientMessageId).toBe("cmsg-1");
    expect(delivered).toHaveLength(1);

    // Same clientMessageId is idempotent
    const replay = await service.submitCardAction({
      agentId: "agent-a",
      cardKey: created.card.id,
      actionId: "save",
      values: { supervise: "false", dir: "repo" },
      expectedVersion: 2,
      clientMessageId: "cmsg-1",
    });
    expect(replay.ok).toBe(true);
    expect(delivered).toHaveLength(1);

    // Simulating daemon restart preserves card and submitted answer
    service.clearMemoryCache();
    const afterRestart = await service.listAgentCards("agent-a");
    expect(afterRestart.views).toHaveLength(1);
    expect(afterRestart.views[0]?.version).toBe(2);
    expect(afterRestart.actions).toHaveLength(1);
    expect(afterRestart.actions[0]?.status).toBe("sent");
    expect(events.some((e) => e.kind === "action_updated")).toBe(true);
    service.dispose();
  });

  it("scans trusted assistant inline blocks, rejects unregistered blocks, and retries failed outbox deliveries", async () => {
    const home = await createTempHome();
    let failFirst = true;
    const delivered: string[] = [];
    const service = new InteractiveCardsService({
      paseoHome: home,
      logger,
      deliverUserReply: async ({ text }) => {
        if (failFirst) {
          failFirst = false;
          throw new Error("provider temporarily busy");
        }
        delivered.push(text);
      },
    });

    const assistantReply = [
      "Where should we start?",
      "```paseo-view",
      JSON.stringify({
        title: "Choose a step",
        fallback: "Reply with option 1 or 2",
        sections: [
          {
            items: [
              {
                type: "row",
                title: "Step 1",
                subtitle: "Profile setup",
                action: { kind: "reply", id: "opt-1", reply: "Start with step 1" },
              },
            ],
          },
        ],
      }),
      "```",
      "```paseo-view",
      JSON.stringify({
        fallback: "Broken card",
        sections: [{ items: [{ type: "field", name: "pw", label: "Password", kind: "secret" }] }],
      }),
      "```",
    ].join("\n");

    await service.scanAssistantMessages("agent-inline", [assistantReply]);

    const validKey = computeInlineCardKey(assistantReply, 0);
    const brokenKey = computeInlineCardKey(assistantReply, 1);

    const snapshot = await service.listAgentCards("agent-inline");
    expect(snapshot.inlineBlockKeys).toEqual([validKey]);

    // Broken card was rejected and produced validation feedback
    const brokenSubmit = await service.submitCardAction({
      agentId: "agent-inline",
      cardKey: brokenKey,
      actionId: "any",
      expectedVersion: 1,
      clientMessageId: "cmsg-broken",
    });
    expect(brokenSubmit.ok).toBe(false);
    expect(brokenSubmit.code).toBe("unregistered_card");

    const feedback = await service.consumePendingValidationFeedback("agent-inline");
    expect(feedback).toContain("secret/password fields are forbidden");
    // Consumed once
    expect(await service.consumePendingValidationFeedback("agent-inline")).toBeNull();

    // First submit fails delivery -> status = "failed"
    const failed = await service.submitCardAction({
      agentId: "agent-inline",
      cardKey: validKey,
      actionId: "opt-1",
      expectedVersion: 1,
      clientMessageId: "cmsg-retry",
    });
    expect(failed.ok).toBe(false);
    expect(failed.code).toBe("delivery_failed");
    expect(failed.action?.status).toBe("failed");

    // Retrying with the exact same clientMessageId succeeds without duplicating
    const retried = await service.submitCardAction({
      agentId: "agent-inline",
      cardKey: validKey,
      actionId: "opt-1",
      expectedVersion: 1,
      clientMessageId: "cmsg-retry",
    });
    expect(retried.ok).toBe(true);
    expect(retried.action?.status).toBe("sent");
    expect(delivered).toEqual(["Start with step 1"]);
    service.dispose();
  });

  it("blocks archived agents and filters MCP card tools away from background agents", async () => {
    const home = await createTempHome();
    const service = new InteractiveCardsService({
      paseoHome: home,
      logger,
      isAgentArchived: (id) => id === "archived-agent",
      deliverUserReply: async () => undefined,
    });

    const archivedRes = await service.submitCardAction({
      agentId: "archived-agent",
      cardKey: "view_0123456789ab",
      actionId: "ok",
      expectedVersion: 1,
      clientMessageId: "cmsg-arch",
    });
    expect(archivedRes.ok).toBe(false);
    expect(archivedRes.code).toBe("agent_archived");

    // MCP registration for interactive agent vs background agent
    const interactiveTools = new Map<string, PaseoToolDefinition>();
    registerInteractiveCardTools({
      registerTool: (name, config, handler) => {
        interactiveTools.set(name, {
          name,
          description: config.description ?? "",
          ...config,
          handler,
        });
      },
      agentManager: {
        getAgent: vi.fn(() => ({ id: "normal-agent", background: false, labels: {} }) as never),
      },
      interactiveCardsService: service,
      callerAgentId: "normal-agent",
      scope: "agent",
    });
    expect(interactiveTools.has(INTERACTIVE_CARD_TOOL_NAMES.show)).toBe(true);
    expect(interactiveTools.has(INTERACTIVE_CARD_TOOL_NAMES.update)).toBe(true);
    expect(interactiveTools.has(INTERACTIVE_CARD_TOOL_NAMES.get)).toBe(true);

    // Invalid view returns isError: true with field-level details
    const showTool = interactiveTools.get(INTERACTIVE_CARD_TOOL_NAMES.show)!;
    const errRes = await showTool.handler({ view: { sections: [] } }, {});
    expect(errRes.isError).toBe(true);

    const bgTools = new Map<string, PaseoToolDefinition>();
    registerInteractiveCardTools({
      registerTool: (name, config, handler) => {
        bgTools.set(name, { name, description: config.description ?? "", ...config, handler });
      },
      agentManager: {
        getAgent: vi.fn(() => ({ id: "bg-agent", background: true, labels: {} }) as never),
      },
      interactiveCardsService: service,
      callerAgentId: "bg-agent",
      scope: "agent",
    });
    expect(bgTools.size).toBe(0);
    service.dispose();
  });

  it("handles session RPC list/submit round-trips with wire-valid responses and cross-agent isolation", async () => {
    const home = await createTempHome();
    const delivered: Array<{ agentId: string; text: string; clientMessageId: string }> = [];
    const service = new InteractiveCardsService({
      paseoHome: home,
      logger,
      updateBroadcastCoalesceMs: 0,
      deliverUserReply: async (input) => {
        delivered.push(input);
      },
    });

    const created = await service.showLiveCard({
      agentId: "agent-a",
      view: {
        title: "Release Checklist",
        fallback: "Confirm release readiness",
        sections: [
          {
            items: [
              { type: "field", name: "tag", label: "Tag", kind: "text", value: "v1.0.0" },
              {
                type: "button",
                label: "Ship",
                variant: "primary",
                action: { kind: "reply", id: "ship", reply: "Proceed with ship", submit: true },
              },
            ],
          },
        ],
      },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Cross-agent ownership isolation
    const foreignGet = await service.getLiveCard({ agentId: "agent-b", id: created.card.id });
    expect(foreignGet.ok).toBe(false);
    const foreignUpdate = await service.updateLiveCard({
      agentId: "agent-b",
      id: created.card.id,
      view: {
        title: "Hijack",
        fallback: "Hijack",
        sections: [{ items: [{ type: "text", text: "nope" }] }],
      },
    });
    expect(foreignUpdate.ok).toBe(false);

    // Session RPC list + submit produce wire-valid SessionOutboundMessages
    const outbound: SessionOutboundMessage[] = [];
    const send = (msg: SessionOutboundMessage) => {
      // Validate against compiled Zod wire schema
      SessionOutboundMessageSchema.parse(msg);
      outbound.push(msg);
    };

    await handleInteractiveCardsSessionMessage(
      service,
      { type: "agent.cards.list.request", requestId: "req-list", agentId: "agent-a" },
      send,
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.type).toBe("agent.cards.list.response");
    if (outbound[0]?.type === "agent.cards.list.response") {
      expect(outbound[0].payload.views).toHaveLength(1);
      expect(outbound[0].payload.views[0]?.id).toBe(created.card.id);
    }

    await handleInteractiveCardsSessionMessage(
      service,
      {
        type: "agent.cards.submit.request",
        requestId: "req-sub",
        agentId: "agent-a",
        cardKey: created.card.id,
        actionId: "ship",
        values: { tag: "fork-v0.17.522" },
        expectedVersion: 1,
        clientMessageId: "cmsg-rpc-1",
      },
      send,
    );
    expect(outbound).toHaveLength(2);
    expect(outbound[1]?.type).toBe("agent.cards.submit.response");
    if (outbound[1]?.type === "agent.cards.submit.response") {
      expect(outbound[1].payload.ok).toBe(true);
      expect(outbound[1].payload.action?.status).toBe("sent");
    }
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.text).toContain("Proceed with ship");
    expect(delivered[0]?.text).toContain("- Tag: fork-v0.17.522");

    service.dispose();
  });
});
