import { describe, expect, it } from "vitest";
import {
  MAIN_CHAT_FORMER_ROLE_VALUE,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MainChatActivityEntrySchema,
  MainChatClearRequestSchema,
  MainChatCompactRequestSchema,
  MainChatCompactionStateSchema,
  MainChatListActivityRequestSchema,
  MainChatNewSessionRequestSchema,
  MainChatOverviewSchema,
  isFormerMainChatLabels,
  isMainChatLabels,
} from "../src/main-chat.js";
import { SessionInboundMessageSchema } from "../src/messages.js";
import { validateWSOutboundMessage } from "../src/validation/ws-outbound.js";

describe("main-chat M2 protocol schemas & zod-aot outbound validation", () => {
  it("distinguishes active main-chat role from archived former main-chat role", () => {
    expect(isMainChatLabels({ [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE })).toBe(true);
    expect(isMainChatLabels({ [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_FORMER_ROLE_VALUE })).toBe(false);
    expect(isFormerMainChatLabels({ [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_FORMER_ROLE_VALUE })).toBe(
      true,
    );
    expect(isFormerMainChatLabels({ [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE })).toBe(false);
  });

  it("validates M2 inbound request schemas inside SessionInboundMessageSchema", () => {
    const requests = [
      {
        type: "main_chat.compact.request",
        requestId: "req_compact_1",
        mainAgentId: "agent_main",
        reason: "manual",
        instructions: "保留正在进行的 PR 上下文",
      },
      {
        type: "main_chat.clear.request",
        requestId: "req_clear_1",
        mainAgentId: "agent_main",
      },
      {
        type: "main_chat.new_session.request",
        requestId: "req_new_1",
        mainAgentId: "agent_main",
        carryHandoffSummary: true,
        title: "研发总控",
      },
      {
        type: "main_chat.list_activity.request",
        requestId: "req_act_1",
        mainAgentId: "agent_main",
        limit: 50,
        includeSilent: false,
        kind: "preempted",
      },
    ] as const;

    expect(MainChatCompactRequestSchema.safeParse(requests[0]).success).toBe(true);
    expect(MainChatClearRequestSchema.safeParse(requests[1]).success).toBe(true);
    expect(MainChatNewSessionRequestSchema.safeParse(requests[2]).success).toBe(true);
    expect(MainChatListActivityRequestSchema.safeParse(requests[3]).success).toBe(true);

    for (const request of requests) {
      const parsed = SessionInboundMessageSchema.safeParse(request);
      expect(parsed.success).toBe(true);
    }
  });

  it("validates M2 outbound responses through the generated zod-aot WS validator", () => {
    const compactionState = MainChatCompactionStateSchema.parse({
      status: "succeeded",
      estimatedTokens: 320_000,
      thresholdTokens: 400_000,
      lastCompactedAt: "2026-11-23T10:00:00.000Z",
      lastError: null,
      summary: "已完成压缩",
      reason: "manual",
      strategy: "native",
    });

    const activity = MainChatActivityEntrySchema.parse({
      id: "act_1",
      mainAgentId: "agent_main",
      kind: "silent_turn",
      trigger: "patrol_wakeup",
      summary: "后台巡检静默完成",
      silent: true,
      status: "completed",
      createdAt: "2026-11-23T10:00:00.000Z",
      completedAt: "2026-11-23T10:00:05.000Z",
      preemptedByUser: false,
    });

    const outboundMessages = [
      {
        type: "main_chat.compact.response",
        payload: {
          requestId: "req_compact_1",
          mainAgentId: "agent_main",
          compaction: compactionState,
          error: null,
        },
      },
      {
        type: "main_chat.clear.response",
        payload: {
          requestId: "req_clear_1",
          previousAgentId: "agent_old",
          agentId: "agent_new",
          workspaceId: "ws_main",
          migratedPlans: 2,
          migratedDecisions: 1,
          migratedChildAgents: 3,
          error: null,
        },
      },
      {
        type: "main_chat.new_session.response",
        payload: {
          requestId: "req_new_1",
          previousAgentId: "agent_old",
          agentId: "agent_new",
          workspaceId: "ws_main",
          handoffSummary: "当前有 2 个进行中任务",
          migratedPlans: 2,
          migratedDecisions: 1,
          migratedChildAgents: 3,
          error: null,
        },
      },
      {
        type: "main_chat.list_activity.response",
        payload: {
          requestId: "req_act_1",
          activities: [activity],
          total: 1,
          error: null,
        },
      },
    ];

    for (const message of outboundMessages) {
      const validated = validateWSOutboundMessage({ type: "session", message });
      expect(validated.success).toBe(true);
    }
  });

  it("keeps MainChatOverviewSchema backward-compatible with legacy payloads and M2 fields", () => {
    const legacyOverview = {
      plans: [],
      decisions: [],
      autoStartRules: [],
      permissionRules: [],
      metrics: {
        autoContinued: 0,
        plansCreated: 0,
        plansAutoStarted: 0,
        plansStarted: 0,
        plansCancelled: 0,
        receiptsRecorded: 0,
        interrupts: 0,
        supervisorHeld: 0,
        reworkCount: 0,
        stalledNudges: 0,
        usageLimitRetries: 0,
      },
    };
    expect(MainChatOverviewSchema.safeParse(legacyOverview).success).toBe(true);

    const m2Overview = {
      ...legacyOverview,
      compaction: {
        status: "idle",
        estimatedTokens: 12_000,
        thresholdTokens: 400_000,
        lastCompactedAt: null,
        lastError: null,
        summary: null,
      },
      recentActivityCount: 5,
      backgroundBusy: true,
      queuedBackgroundCount: 2,
    };
    expect(MainChatOverviewSchema.safeParse(m2Overview).success).toBe(true);
  });
});
