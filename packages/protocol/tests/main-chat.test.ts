import { describe, expect, it } from "vitest";
import {
  MAIN_CHAT_COMPACT_WINDOW_RATIO,
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
  MainChatSettingsSchema,
  createDefaultMainChatSettings,
  isFormerMainChatLabels,
  isHostAllowedInFleetScope,
  isMainChatEnabled,
  isMainChatAutoCompactEnabled,
  isMainChatLabels,
  mergeMainChatSettings,
  normalizeMainChatFleetScope,
  parseTaskAskUserToolPayload,
  parseTaskCompleteToolPayload,
  parseTaskPlanToolOutput,
  parseTaskReworkToolPayload,
  resolveMainChatFleetScope,
  unwrapToolPayloadObject,
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

  it("supports backward-compatible fleetScope settings, opt-in defaults, normalization, and host scope checks", () => {
    const defaults = createDefaultMainChatSettings();
    expect(defaults.enabled).toBe(false);
    expect(isMainChatEnabled(undefined)).toBe(false);
    expect(isMainChatEnabled(null)).toBe(false);
    expect(isMainChatEnabled(defaults)).toBe(false);
    expect(isMainChatEnabled({ enabled: true })).toBe(true);
    expect(isMainChatEnabled({})).toBe(true);

    expect(resolveMainChatFleetScope(defaults)).toEqual({
      mode: "local_only",
      hostServerIds: [],
    });

    // Legacy settings without fleetScope remain valid and normalize safely to local_only
    const { fleetScope: _omitted, ...legacySettings } = defaults;
    const parsedLegacy = MainChatSettingsSchema.parse(legacySettings);
    expect(resolveMainChatFleetScope(parsedLegacy)).toEqual({
      mode: "local_only",
      hostServerIds: [],
    });

    // Normalize deduplicates, trims, and strips local serverId
    expect(
      normalizeMainChatFleetScope(
        { mode: "allowlist", hostServerIds: [" srv_macbook ", "srv_devbox", "srv_macbook", ""] },
        "srv_devbox",
      ),
    ).toEqual({
      mode: "allowlist",
      hostServerIds: ["srv_macbook"],
    });

    // Host scope checks: local host is always allowed
    const allowlistScope = { mode: "allowlist" as const, hostServerIds: ["srv_macbook"] };
    expect(isHostAllowedInFleetScope(allowlistScope, "srv_devbox", "srv_devbox")).toBe(true);
    expect(isHostAllowedInFleetScope(allowlistScope, "srv_devbox", "srv_macbook")).toBe(true);
    expect(isHostAllowedInFleetScope(allowlistScope, "srv_devbox", "srv_imac")).toBe(false);

    const localOnlyScope = { mode: "local_only" as const, hostServerIds: ["srv_macbook"] };
    expect(isHostAllowedInFleetScope(localOnlyScope, "srv_imac", "srv_imac")).toBe(true);
    expect(isHostAllowedInFleetScope(localOnlyScope, "srv_imac", "srv_macbook")).toBe(false);

    // Explicit all_connected remains valid and allows remote hosts
    const allConnectedScope = { mode: "all_connected" as const, hostServerIds: [] };
    expect(isHostAllowedInFleetScope(allConnectedScope, "srv_devbox", "srv_any")).toBe(true);
    expect(isHostAllowedInFleetScope(undefined, "srv_devbox", "srv_devbox")).toBe(true);
    expect(isHostAllowedInFleetScope(undefined, "srv_devbox", "srv_any")).toBe(false);

    // mergeMainChatSettings preserves fleetScope across style/title patches and merges partial updates
    const scoped = mergeMainChatSettings(defaults, {
      title: "工作管家",
      fleetScope: { mode: "allowlist", hostServerIds: ["srv_macbook"] },
    });
    expect(scoped.fleetScope).toEqual({ mode: "allowlist", hostServerIds: ["srv_macbook"] });

    const afterStyleSwitch = mergeMainChatSettings(scoped, { applyPreset: "proactive" });
    expect(afterStyleSwitch.fleetScope).toEqual({
      mode: "allowlist",
      hostServerIds: ["srv_macbook"],
    });

    const switchedToLocalOnly = mergeMainChatSettings(afterStyleSwitch, {
      fleetScope: { mode: "local_only" },
    });
    expect(switchedToLocalOnly.fleetScope).toEqual({
      mode: "local_only",
      hostServerIds: ["srv_macbook"],
    });
  });

  it("validates get_fleet_hosts outbound payloads with optional fleetScope and availableRemoteHosts", () => {
    const hostRow = {
      serverId: "srv_macbook",
      label: "MacBook",
      isLocal: false,
      status: "online" as const,
      agentCount: 2,
      needsAttentionCount: 1,
      lastSyncedAt: "2026-11-24T05:00:00.000Z",
      error: null,
    };

    const withScope = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "main_chat.get_fleet_hosts.response",
        payload: {
          requestId: "req_hosts_1",
          localServerId: "srv_devbox",
          hosts: [hostRow],
          fleetScope: { mode: "allowlist", hostServerIds: ["srv_macbook"] },
          availableRemoteHosts: [
            hostRow,
            {
              serverId: "srv_imac",
              label: "iMac",
              isLocal: false,
              status: "online",
              agentCount: 0,
              needsAttentionCount: 0,
              lastSyncedAt: null,
              error: null,
            },
          ],
          error: null,
        },
      },
    });
    expect(withScope.success).toBe(true);

    // Legacy response without new optional fields still validates
    const legacy = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "main_chat.get_fleet_hosts.response",
        payload: {
          requestId: "req_hosts_2",
          localServerId: "srv_devbox",
          hosts: [hostRow],
          error: null,
        },
      },
    });
    expect(legacy.success).toBe(true);
  });

  it("supports configurable autoCompactEnabled and model contextWindowMaxTokens on compaction state", () => {
    expect(MAIN_CHAT_COMPACT_WINDOW_RATIO).toBe(0.8);
    const defaults = createDefaultMainChatSettings();
    expect(isMainChatAutoCompactEnabled(defaults)).toBe(true);

    const disabled = mergeMainChatSettings(defaults, { autoCompactEnabled: false });
    expect(isMainChatAutoCompactEnabled(disabled)).toBe(false);

    // Preset changes preserve explicit autoCompactEnabled preference.
    const afterPreset = mergeMainChatSettings(disabled, { applyPreset: "proactive" });
    expect(isMainChatAutoCompactEnabled(afterPreset)).toBe(false);

    const state = MainChatCompactionStateSchema.parse({
      status: "idle",
      estimatedTokens: 820_000,
      thresholdTokens: 800_000,
      contextWindowMaxTokens: 1_000_000,
      autoCompactEnabled: false,
      lastCompactedAt: null,
      lastError: null,
      summary: null,
    });
    expect(state.contextWindowMaxTokens).toBe(1_000_000);
    expect(state.autoCompactEnabled).toBe(false);

    const outbound = validateWSOutboundMessage({
      type: "session",
      message: {
        type: "main_chat.compact.response",
        payload: {
          requestId: "req_compact_1m",
          mainAgentId: "agent_main",
          compaction: state,
          error: null,
        },
      },
    });
    expect(outbound.success).toBe(true);
  });

  it("recursively unwraps Claude { output: ... } MCP envelopes for all 4 main-chat inline card parsers", () => {
    const samplePlan = {
      id: "plan_claude_1",
      mainAgentId: "agent_main",
      status: "open",
      autoStarted: false,
      summary: "修复主对话 7 项问题",
      createdAt: "2026-11-24T08:00:00.000Z",
      startedAt: null,
      cancelledAt: null,
      tasks: [
        {
          id: "t1",
          title: "补齐协议层解包",
          goal: "修复 Claude MCP 外包 output 壳",
          mode: "write",
          isolation: "worktree",
          workspaceId: "ws_1",
          cwd: "/repo/paseo-fork",
          workspaceLabel: "paseo-fork",
          reason: "恢复内联卡片渲染",
          doneWhen: ["4 类卡片均能解析"],
          outOfBounds: ["不触碰线上 daemon"],
          provider: "claude",
          modeId: null,
          thinkingOptionId: null,
          branchName: "feat/fix",
          baseBranch: "main",
          agentId: null,
          startedAt: null,
          startError: null,
        },
      ],
    };

    const sampleDecision = {
      id: "dec_claude_1",
      mainAgentId: "agent_main",
      title: "是否合并改动",
      question: "请选择执行策略",
      agentId: "agent_child_1",
      planId: "plan_claude_1",
      taskId: "t1",
      options: [
        { id: "opt_a", label: "方案 A", leadsTo: "一并交付" },
        { id: "opt_b", label: "方案 B", leadsTo: "分批交付" },
      ],
      recommendedOptionId: "opt_a",
      reason: "统一验证更稳妥",
      answer: null,
      answeredOptionId: null,
      answeredAt: null,
      createdAt: "2026-11-24T08:05:00.000Z",
    };

    const sampleReceipt = {
      title: "修复主对话卡片",
      summary: "4 类内联卡片全部恢复正常渲染",
      agentId: "agent_child_1",
      planId: "plan_claude_1",
      taskId: "t1",
      checks: [{ criterion: "单测通过", met: true, evidence: "vitest 全部通过" }],
      nextSteps: ["打开浏览器复核 UI"],
    };

    const sampleRework = {
      title: "补齐边界单测",
      agentId: "agent_child_1",
      planId: "plan_claude_1",
      taskId: "t1",
      round: 1,
      maxRounds: 2,
      gaps: ["补充 Claude output 嵌套数组用例"],
      note: "请再核对一次",
    };

    // 1. task_plan wrapped in Claude `{ output: [{ type: "text", text: JSON }] }`
    const claudePlanEnvelope = {
      output: [{ type: "text", text: JSON.stringify({ plan: samplePlan }) }],
    };
    const parsedPlan = parseTaskPlanToolOutput(claudePlanEnvelope);
    expect(parsedPlan?.id).toBe("plan_claude_1");
    expect(parsedPlan?.tasks).toHaveLength(1);
    expect(parsedPlan?.tasks[0]?.title).toBe("补齐协议层解包");

    // 2. task_ask_user wrapped in `{ output: { content: [{ type: "text", text: JSON }] } }`
    const claudeDecisionEnvelope = {
      output: {
        content: [{ type: "text", text: JSON.stringify({ decision: sampleDecision }) }],
      },
    };
    const parsedDecision = parseTaskAskUserToolPayload(claudeDecisionEnvelope);
    expect(parsedDecision?.id).toBe("dec_claude_1");
    expect(parsedDecision?.options).toHaveLength(2);

    // 3. task_complete wrapped in `{ output: { structuredContent: { receipt } } }`
    const claudeReceiptEnvelope = {
      output: {
        structuredContent: { receipt: sampleReceipt },
      },
    };
    const parsedReceipt = parseTaskCompleteToolPayload(null, claudeReceiptEnvelope);
    expect(parsedReceipt?.title).toBe("修复主对话卡片");
    expect(parsedReceipt?.checks).toHaveLength(1);

    // 4. task_rework wrapped in `{ output: JSONString }`
    const claudeReworkEnvelope = {
      output: JSON.stringify({ rework: sampleRework }),
    };
    const parsedRework = parseTaskReworkToolPayload(null, claudeReworkEnvelope);
    expect(parsedRework?.round).toBe(1);
    expect(parsedRework?.gaps).toEqual(["补充 Claude output 嵌套数组用例"]);

    // Plain non-JSON string `output` must NOT clobber the outer object.
    const plainOuter = { title: "保留外层字段", output: "plain log line" };
    expect(unwrapToolPayloadObject(plainOuter)).toEqual(plainOuter);
  });
});
