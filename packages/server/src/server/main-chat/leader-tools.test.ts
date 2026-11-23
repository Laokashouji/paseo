import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  type MainChatDecisionRecord,
} from "@getpaseo/protocol/main-chat";
import type { AgentManager } from "../agent/agent-manager.js";
import { PaseoToolInputError, type PaseoToolDefinition } from "../agent/tools/types.js";
import {
  MAIN_CONVERSATION_ID,
  createMainChatConversationManager,
  type ConversationTailMessage,
  type SendConversationPromptInput,
} from "./conversations.js";
import {
  LEADER_CONVERSATION_TOOL_NAMES,
  createConversationRelayGuard,
  formatEscalatedDecisionReason,
  formatLeaderProgressMessage,
  registerLeaderConversationTools,
  type EscalateDecisionToMainInput,
  type LeaderProgressReportInput,
  type LeaderToolsAgentLookup,
} from "./leader-tools.js";

// Compile-time assignability guard: production AgentManager satisfies LeaderToolsAgentLookup directly.
function _verifyAgentManagerCompatibility(agentManager: AgentManager): LeaderToolsAgentLookup {
  return agentManager;
}
void _verifyAgentManagerCompatibility;

describe("registerLeaderConversationTools", () => {
  let homeDir: string;
  let nowMs: number;
  let agentSeq: number;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "paseo-main-chat-leader-tools-"));
    nowMs = Date.parse("2026-11-23T12:00:00.000Z");
    agentSeq = 0;
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  async function setupEnvironment(options?: {
    tailMessagesByConvId?: Map<string, ConversationTailMessage[]>;
    tailLifecycleByConvId?: Map<string, string>;
  }) {
    const agents = new Map<string, { id: string; labels: Record<string, string> }>();
    agents.set("ag_main", {
      id: "ag_main",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    agents.set("ag_worker", {
      id: "ag_worker",
      labels: {},
    });

    const sentPrompts: SendConversationPromptInput[] = [];
    const manager = createMainChatConversationManager({
      homeDir,
      defaultServerId: "srv_local",
      now: () => {
        nowMs += 1_000;
        return nowMs;
      },
      createConversationAgent: async (input) => {
        agentSeq += 1;
        const agentId = `ag_sub_${agentSeq}`;
        agents.set(agentId, { id: agentId, labels: { ...input.labels } });
        return { agentId, workspaceId: "ws_main_chat", serverId: "srv_local" };
      },
      sendPromptToAgent: async (input) => {
        sentPrompts.push(input);
      },
      readAgentTail: async ({ conversation }) => ({
        lifecycle: options?.tailLifecycleByConvId?.get(conversation.id) ?? "idle",
        messages: options?.tailMessagesByConvId?.get(conversation.id) ?? [],
      }),
    });

    await manager.ensureMainConversationRecord({
      agentId: "ag_main",
      workspaceId: "ws_main_chat",
      title: "总控主对话",
    });

    const leader = await manager.createConversation({
      kind: "leader",
      title: "移动端方向",
      directionSummary: "负责 iOS/Android 稳定性",
    });

    const side = await manager.createConversation({
      kind: "side",
      title: "架构草稿讨论",
    });

    const agentManager: LeaderToolsAgentLookup = {
      getAgent: (id) => agents.get(id) ?? null,
    };

    return { manager, agentManager, leader, side, sentPrompts };
  }

  function buildToolsForCaller(params: {
    agentManager: LeaderToolsAgentLookup;
    manager: ReturnType<typeof createMainChatConversationManager>;
    callerAgentId: string;
    scope?: "agent" | "top-level";
    progressCooldownMs?: number;
    relayGuard?: ReturnType<typeof createConversationRelayGuard>;
    reportLeaderProgress?: (input: LeaderProgressReportInput) => Promise<{
      delivered: boolean;
      throttled?: boolean;
      notice?: string;
    } | void>;
    escalateDecisionToMain?: (
      input: EscalateDecisionToMainInput,
    ) => Promise<MainChatDecisionRecord>;
    policy?: Parameters<typeof registerLeaderConversationTools>[0]["policy"];
  }) {
    const tools = new Map<string, PaseoToolDefinition>();
    const builtinNames = new Set<string>();
    registerLeaderConversationTools({
      agentManager: params.agentManager,
      conversationManager: params.manager,
      callerAgentId: params.callerAgentId,
      scope: params.scope ?? "agent",
      tools,
      builtinNames,
      policy: params.policy,
      relayGuard: params.relayGuard,
      progressCooldownMs: params.progressCooldownMs,
      reportLeaderProgress: params.reportLeaderProgress,
      escalateDecisionToMain: params.escalateDecisionToMain,
      now: () => nowMs,
    });
    return { tools, builtinNames };
  }

  it("registers tools by conversation role and excludes regular worker agents and top-level scope", async () => {
    const { manager, agentManager, leader, side } = await setupEnvironment();

    const workerResult = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: "ag_worker",
    });
    expect(Array.from(workerResult.tools.keys())).toEqual([]);

    const topLevelResult = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: leader.agentId,
      scope: "top-level",
    });
    expect(Array.from(topLevelResult.tools.keys())).toEqual([]);

    const mainResult = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: "ag_main",
    });
    expect(Array.from(mainResult.tools.keys())).toEqual([
      "conversation_new",
      "conversation_send",
      "conversation_read",
    ]);

    const sideResult = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: side.agentId,
    });
    expect(Array.from(sideResult.tools.keys())).toEqual([
      "conversation_new",
      "conversation_send",
      "conversation_read",
    ]);

    const leaderResult = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: leader.agentId,
    });
    expect(Array.from(leaderResult.tools.keys())).toEqual([...LEADER_CONVERSATION_TOOL_NAMES]);
    expect(Array.from(leaderResult.builtinNames)).toEqual([...LEADER_CONVERSATION_TOOL_NAMES]);

    // Policy exclusion omits disabled tool while still recording builtin name.
    const policyFiltered = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: leader.agentId,
      policy: { disabledTools: ["leader_progress"] },
    });
    expect(policyFiltered.tools.has("leader_progress")).toBe(false);
    expect(policyFiltered.builtinNames.has("leader_progress")).toBe(true);
  });

  it("executes conversation_new to create side and leader conversations with initialPrompt", async () => {
    const { manager, agentManager, sentPrompts } = await setupEnvironment();
    const { tools } = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: "ag_main",
    });

    const tool = tools.get("conversation_new");
    expect(tool).toBeDefined();

    const result = await tool!.handler(
      {
        kind: "leader",
        title: "安全审计方向",
        directionSummary: "持续跟踪权限与依赖漏洞",
        initialPrompt: "请先检查最近的权限变更记录。",
      },
      {},
    );

    const payload = result.structuredContent as {
      conversation: { id: string; kind: string; title: string; parentConversationId: string };
      guidance: string;
    };
    expect(payload.conversation.kind).toBe("leader");
    expect(payload.conversation.title).toBe("安全审计方向");
    expect(payload.conversation.parentConversationId).toBe(MAIN_CONVERSATION_ID);
    expect(result.content).toHaveLength(1);
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0].prompt).toBe("请先检查最近的权限变更记录。");
  });

  it("executes conversation_send, blocks self-send loops, and enforces pairwise ping-pong circuit breaker", async () => {
    const { manager, agentManager, leader, side, sentPrompts } = await setupEnvironment();
    const sharedGuard = createConversationRelayGuard({
      now: () => nowMs,
      maxPingPongRoundsPerWindow: 2,
    });

    const mainTools = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: "ag_main",
      relayGuard: sharedGuard,
    }).tools;
    const leaderTools = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: leader.agentId,
      relayGuard: sharedGuard,
    }).tools;

    // Self-send must be rejected immediately.
    await expect(
      leaderTools
        .get("conversation_send")!
        .handler({ conversationId: leader.id, message: "给自己发消息" }, {}),
    ).rejects.toSatisfy((error: unknown) => {
      return error instanceof PaseoToolInputError && error.message.includes("防止自发死循环");
    });

    // Main -> Leader succeeds.
    const sendResult = await mainTools
      .get("conversation_send")!
      .handler({ conversationId: leader.id, message: "请同步今日进度" }, {});
    expect(sendResult.structuredContent).toMatchObject({
      conversation: expect.objectContaining({ id: leader.id }),
    });
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0].fromConversationId).toBe(MAIN_CONVERSATION_ID);

    // Alternating ping-pong rounds: Leader -> Main (round 1), Main -> Leader (round 2), Leader -> Main (blocked!).
    await leaderTools
      .get("conversation_send")!
      .handler({ conversationId: MAIN_CONVERSATION_ID, message: "回复 1" }, {});
    await mainTools
      .get("conversation_send")!
      .handler({ conversationId: leader.id, message: "追问 2" }, {});
    await expect(
      leaderTools
        .get("conversation_send")!
        .handler({ conversationId: MAIN_CONVERSATION_ID, message: "无限接力 3" }, {}),
    ).rejects.toSatisfy((error: unknown) => {
      return error instanceof PaseoToolInputError && error.message.includes("往返轮次");
    });

    // Unrelated pair (Leader -> Side) is unaffected, and resetting unlocks the pair.
    await leaderTools
      .get("conversation_send")!
      .handler({ conversationId: side.id, message: "同步给侧对话" }, {});
    sharedGuard.resetForConversation(leader.id);
    await leaderTools
      .get("conversation_send")!
      .handler({ conversationId: MAIN_CONVERSATION_ID, message: "用户介入后恢复发送" }, {});
  });

  it("executes conversation_read with default limit 8 and controlled truncation", async () => {
    const tailMap = new Map<string, ConversationTailMessage[]>();
    const lifecycleMap = new Map<string, string>();
    const { manager, agentManager, leader } = await setupEnvironment({
      tailMessagesByConvId: tailMap,
      tailLifecycleByConvId: lifecycleMap,
    });

    tailMap.set(
      leader.id,
      Array.from({ length: 12 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        text: `第 ${index + 1} 轮记录：${"进展内容".repeat(30)}`,
        timestamp: "2026-11-23T12:00:00.000Z",
      })),
    );
    lifecycleMap.set(leader.id, "running");

    const { tools } = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: "ag_main",
    });

    const result = await tools.get("conversation_read")!.handler({ conversationId: leader.id }, {});
    const payload = result.structuredContent as {
      conversation: { id: string };
      lifecycle: string;
      messages: ConversationTailMessage[];
      truncated: boolean;
      summary: string;
    };

    expect(payload.conversation.id).toBe(leader.id);
    expect(payload.lifecycle).toBe("running");
    expect(payload.messages.length).toBeLessThanOrEqual(8);
    expect(payload.truncated).toBe(true);
    expect(payload.summary).toContain("移动端方向");
    expect(payload.summary).toContain("running");
  });

  it("executes leader_progress with controlled reporting, anti-spam throttling, fallback delivery, and demotion guard", async () => {
    const { manager, agentManager, leader, sentPrompts } = await setupEnvironment();
    const reports: LeaderProgressReportInput[] = [];

    const { tools } = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: leader.agentId,
      progressCooldownMs: 60_000,
      reportLeaderProgress: async (input) => {
        reports.push(input);
        return { delivered: true, throttled: false };
      },
    });

    const first = await tools.get("leader_progress")!.handler(
      {
        summary: "已完成冷启动火焰图采集并锁定 2 个耗时瓶颈。",
        completedItems: ["采集 iOS 真机冷启动 trace", "对比 Android 冷启动基线"],
        activeCount: 2,
        blockedItems: [],
      },
      {},
    );
    expect(first.structuredContent).toMatchObject({
      delivered: true,
      throttled: false,
      conversationId: leader.id,
    });
    expect(reports).toHaveLength(1);
    expect(reports[0].activeCount).toBe(2);

    // Immediate non-urgent duplicate report is throttled to prevent spam.
    const throttled = await tools
      .get("leader_progress")!
      .handler({ summary: "还在继续跑测试" }, {});
    expect(throttled.structuredContent).toMatchObject({
      delivered: false,
      throttled: true,
    });
    expect(reports).toHaveLength(1);

    // Report carrying blockedItems bypasses routine cooldown.
    const urgent = await tools.get("leader_progress")!.handler(
      {
        summary: "发现 CI 签名证书过期导致打包阻塞。",
        blockedItems: ["iOS 签名证书过期"],
      },
      {},
    );
    expect(urgent.structuredContent).toMatchObject({
      delivered: true,
      throttled: false,
    });
    expect(reports).toHaveLength(2);

    // Without custom reportLeaderProgress callback, falls back cleanly to sending to main conversation.
    const fallbackTools = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: leader.agentId,
    }).tools;
    await fallbackTools.get("leader_progress")!.handler(
      {
        summary: "全部基准测试已通过。",
        completedItems: ["iOS 帧率稳定 60fps"],
        activeCount: 0,
      },
      {},
    );
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0].conversation.id).toBe(MAIN_CONVERSATION_ID);
    expect(sentPrompts[0].prompt).toContain("方向主管进度汇报");
    expect(sentPrompts[0].prompt).toContain("iOS 帧率稳定 60fps");

    // Demoting leader -> side revokes leader_progress dynamically.
    await manager.updateConversation({ conversationId: leader.id, kind: "side" });
    await expect(
      tools.get("leader_progress")!.handler({ summary: "降级后尝试上报" }, {}),
    ).rejects.toThrow(PaseoToolInputError);
  });

  it("executes ask_escalate to create a structured MainChatDecisionRecord and validates options", async () => {
    const { manager, agentManager, leader } = await setupEnvironment();
    const escalateSpy = vi.fn(async (input: EscalateDecisionToMainInput) => {
      const decision: MainChatDecisionRecord = {
        id: "dec_escalated_1",
        mainAgentId: "ag_main",
        title: input.title,
        question: input.question,
        agentId: input.agentId ?? null,
        planId: null,
        taskId: input.taskId ?? null,
        options: input.options,
        recommendedOptionId: input.recommendedOptionId ?? null,
        reason: formatEscalatedDecisionReason({
          fromConversationTitle: input.fromConversationTitle,
          background: input.background,
          whyUserMustDecide: input.whyUserMustDecide,
        }),
        answer: null,
        answeredOptionId: null,
        answeredAt: null,
        createdAt: "2026-11-23T12:05:00.000Z",
      };
      return decision;
    });

    const { tools } = buildToolsForCaller({
      agentManager,
      manager,
      callerAgentId: leader.agentId,
      escalateDecisionToMain: escalateSpy,
    });

    const tool = tools.get("ask_escalate")!;
    const result = await tool.handler(
      {
        title: "是否移除旧版离线缓存协议",
        question: "下个版本是否直接下线 v1 缓存格式？",
        background: "目前仅剩 0.3% 旧客户端还在读 v1，但移除后可删掉 1,400 行兼容代码。",
        options: [
          { id: "drop_v1", label: "直接下线 v1", leadsTo: "清理旧兼容层，旧版升级时重建缓存" },
          { id: "keep_one_release", label: "保留一个版本", leadsTo: "延后清理，本版仅加弃用埋点" },
        ],
        recommendedOptionId: "drop_v1",
        whyUserMustDecide: "涉及破坏性兼容取舍，超出方向主管默认授权范围。",
        taskId: "task_cache_1",
        agentId: "ag_worker_9",
      },
      {},
    );

    expect(escalateSpy).toHaveBeenCalledTimes(1);
    expect(escalateSpy.mock.calls[0][0]).toMatchObject({
      fromConversationId: leader.id,
      fromConversationTitle: "移动端方向",
      fromAgentId: leader.agentId,
      recommendedOptionId: "drop_v1",
      taskId: "task_cache_1",
      agentId: "ag_worker_9",
    });

    const payload = result.structuredContent as {
      decision: MainChatDecisionRecord;
      escalatedFromConversationId: string;
      guidance: string;
    };
    expect(payload.decision.id).toBe("dec_escalated_1");
    expect(payload.decision.recommendedOptionId).toBe("drop_v1");
    expect(payload.decision.reason).toContain("来自方向主管「移动端方向」升级");
    expect(payload.decision.reason).toContain("破坏性兼容取舍");
    expect(payload.escalatedFromConversationId).toBe(leader.id);

    // Invalid recommendedOptionId must fail cleanly.
    await expect(
      tool.handler(
        {
          title: "坏推荐项",
          question: "选哪个？",
          background: "背景",
          options: [
            { id: "a", label: "A", leadsTo: "做 A" },
            { id: "b", label: "B", leadsTo: "做 B" },
          ],
          recommendedOptionId: "nonexistent",
          whyUserMustDecide: "需拍板",
        },
        {},
      ),
    ).rejects.toThrow(PaseoToolInputError);

    // Duplicate option IDs must fail cleanly.
    await expect(
      tool.handler(
        {
          title: "重复选项",
          question: "选哪个？",
          background: "背景",
          options: [
            { id: "dup", label: "A", leadsTo: "做 A" },
            { id: "dup", label: "B", leadsTo: "做 B" },
          ],
          whyUserMustDecide: "需拍板",
        },
        {},
      ),
    ).rejects.toThrow(PaseoToolInputError);

    // Formatting helpers produce readable Chinese summaries.
    expect(
      formatLeaderProgressMessage({
        conversationId: leader.id,
        conversationTitle: "移动端方向",
        leaderAgentId: leader.agentId,
        summary: "阶段一完成",
        completedItems: ["项 1"],
        activeCount: 1,
        blockedItems: ["卡点 1"],
        reportedAt: "2026-11-23T12:00:00.000Z",
      }),
    ).toContain("当前阻塞/关注点");
  });
});
