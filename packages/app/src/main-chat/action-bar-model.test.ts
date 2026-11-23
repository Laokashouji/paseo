import type {
  MainChatDecisionRecord,
  MainChatOverview,
  MainChatPlanRecord,
  MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { describe, expect, it } from "vitest";
import { collapseTurns } from "@/agent-stream/turn-collapse/model";
import type { PendingPermission } from "@/types/shared";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import {
  COMPLETED_WINDOW_MS,
  STALE_IN_PROGRESS_THRESHOLD_MS,
  buildMainChatActionBarModel,
  type ActionBarLiveAgentSnapshot,
  type ActionBarPendingPermissionInput,
} from "./action-bar-model";

const NOW_MS = Date.parse("2026-11-23T12:00:00.000Z");

function isoAgo(ms: number): string {
  return new Date(NOW_MS - ms).toISOString();
}

function makeTask(
  overrides: Partial<MainChatTaskRecord> & {
    id: string;
    title: string;
    status: MainChatTaskRecord["status"];
  },
): MainChatTaskRecord {
  const { id, title, status, ...rest } = overrides;
  return {
    id,
    mainAgentId: "agent_main",
    conversationId: null,
    planId: null,
    title,
    mode: "write",
    isolation: "worktree",
    serverId: "srv_1",
    hostLabel: "DevBox",
    cwd: "/repo/app",
    workspaceId: "ws_repo",
    workspaceLabel: "app",
    status,
    brief: {
      goal: `Goal for ${title}`,
      doneWhen: ["Tests pass"],
      outOfBounds: ["Do not push"],
      scopeRevision: 1,
      updatedAt: isoAgo(60_000),
    },
    agentIds: [],
    activeAgentId: null,
    lastActivityAt: isoAgo(60_000),
    createdAt: isoAgo(120_000),
    updatedAt: isoAgo(60_000),
    ...rest,
  };
}

function makeLiveAgent(
  overrides: Partial<ActionBarLiveAgentSnapshot> & { agentId: string },
): ActionBarLiveAgentSnapshot {
  const { agentId, ...rest } = overrides;
  return {
    serverId: "srv_1",
    agentId,
    workspaceId: "ws_repo",
    title: agentId,
    cwd: "/repo/app",
    status: "idle",
    turnPhase: "idle",
    hasBackgroundWork: false,
    requiresAttention: false,
    attentionReason: null,
    archived: false,
    background: false,
    isMainChat: false,
    managedByMainChat: true,
    mode: "write",
    taskRecordId: null,
    planId: null,
    updatedAtMs: NOW_MS - 30_000,
    lastActivityAtMs: NOW_MS - 30_000,
    ...rest,
  };
}

function makePermission(
  agentId: string,
  requestId: string,
  serverId = "srv_1",
): ActionBarPendingPermissionInput {
  const permission: PendingPermission = {
    key: `${agentId}:${requestId}`,
    agentId,
    request: {
      id: requestId,
      provider: "claude",
      name: "Bash",
      kind: "tool",
      title: `Run command (${requestId})`,
      description: "Execute command",
      input: { command: "npm test" },
    },
  };
  return {
    serverId,
    permission,
    sourceAgentTitle: `Agent ${agentId}`,
    sourceAgentCwd: "/repo/app",
  };
}

function makeOverview(partial: Partial<MainChatOverview> = {}): MainChatOverview {
  return {
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
    tasks: [],
    triages: [],
    ...partial,
  };
}

describe("buildMainChatActionBarModel — five-state bucketing & strict deduplication", () => {
  it("classifies items into all 5 buckets and strictly excludes awaiting_review from needsYou", () => {
    const decision: MainChatDecisionRecord = {
      id: "dec_1",
      mainAgentId: "agent_main",
      title: "发布策略选择",
      question: "是否启用灰度发布？",
      agentId: "child_dec",
      planId: null,
      taskId: "task_dec",
      options: [
        { id: "opt_a", label: "先灰度", leadsTo: "10% 流量" },
        { id: "opt_b", label: "全量", leadsTo: "100% 流量" },
      ],
      recommendedOptionId: "opt_a",
      reason: "需要业务拍板",
      answer: null,
      answeredOptionId: null,
      answeredAt: null,
      createdAt: isoAgo(10_000),
    };

    const openPlan: MainChatPlanRecord = {
      id: "plan_open",
      mainAgentId: "agent_main",
      status: "open",
      autoStarted: false,
      summary: "修复构建脚本",
      createdAt: isoAgo(20_000),
      startedAt: null,
      cancelledAt: null,
      tasks: [
        {
          id: "pt_1",
          title: "更新 CI 配置",
          goal: "修复 lint",
          mode: "write",
          isolation: "worktree",
          cwd: "/repo/app",
          workspaceId: "ws_repo",
          workspaceLabel: "app",
          reason: "CI 失败",
          doneWhen: ["CI 通过"],
          outOfBounds: [],
          provider: "claude",
          modeId: null,
          thinkingOptionId: null,
          branchName: null,
          baseBranch: null,
          agentId: null,
          startedAt: null,
          startError: null,
        },
      ],
    };

    const overview = makeOverview({
      plans: [openPlan],
      decisions: [decision],
      tasks: [
        makeTask({
          id: "task_perm",
          title: "待审批子任务",
          status: "running",
          activeAgentId: "child_perm",
          agentIds: ["child_perm"],
        }),
        makeTask({
          id: "task_dec",
          title: "待拍板子任务",
          status: "needs_you",
          activeAgentId: "child_dec",
          agentIds: ["child_dec"],
        }),
        makeTask({
          id: "task_review",
          title: "等主对话验收任务",
          status: "awaiting_review",
          activeAgentId: "child_review",
          agentIds: ["child_review"],
        }),
        makeTask({
          id: "task_active",
          title: "正常推进任务",
          status: "running",
          activeAgentId: "child_active",
          agentIds: ["child_active"],
          lastActivityAt: isoAgo(60 * 60 * 1000), // 1h ago
        }),
        makeTask({
          id: "task_stale",
          title: "超 48 小时搁置任务",
          status: "running",
          activeAgentId: "child_stale",
          agentIds: ["child_stale"],
          lastActivityAt: isoAgo(STALE_IN_PROGRESS_THRESHOLD_MS + 60_000), // 48h + 1m ago
        }),
        makeTask({
          id: "task_parked",
          title: "等待外部 PR 合入",
          status: "parked",
          activeAgentId: "child_parked",
          agentIds: ["child_parked"],
          parkedAt: isoAgo(2 * 60 * 60 * 1000),
          parkedReason: "等待后端合入接口 PR",
        }),
        makeTask({
          id: "task_done_recent",
          title: "24 小时内完工任务",
          status: "completed",
          activeAgentId: "child_done_recent",
          agentIds: ["child_done_recent"],
          completedAt: isoAgo(3 * 60 * 60 * 1000),
        }),
        makeTask({
          id: "task_done_expired",
          title: "超过 24 小时历史任务",
          status: "completed",
          activeAgentId: "child_done_expired",
          agentIds: ["child_done_expired"],
          completedAt: isoAgo(COMPLETED_WINDOW_MS + 60_000),
        }),
      ],
    });

    const model = buildMainChatActionBarModel({
      serverId: "srv_1",
      mainAgentId: "agent_main",
      overview,
      liveAgents: [
        makeLiveAgent({ agentId: "child_perm", status: "running", turnPhase: "open" }),
        makeLiveAgent({
          agentId: "child_review",
          status: "idle",
          requiresAttention: true,
          attentionReason: "permission",
        }),
        makeLiveAgent({
          agentId: "child_active",
          status: "running",
          turnPhase: "open",
          lastActivityAtMs: NOW_MS - 10_000,
        }),
        makeLiveAgent({
          agentId: "child_stale",
          status: "idle",
          lastActivityAtMs: NOW_MS - STALE_IN_PROGRESS_THRESHOLD_MS - 60_000,
        }),
        makeLiveAgent({
          agentId: "child_done_expired",
          status: "idle",
          updatedAtMs: NOW_MS - 1_000, // Even if live agent updated recently, expired task must not leak!
        }),
      ],
      pendingPermissions: [
        makePermission("child_perm", "req_1"),
        // Even if a stale permission points to an awaiting_review task, awaiting_review stays out of needsYou!
        makePermission("child_review", "req_stale"),
      ],
      hostLabelsByServerId: { srv_1: "DevBox" },
      nowMs: NOW_MS,
    });

    // Bucket 1: needsYou has permission(child_perm), decision(dec_1), open plan(plan_open) — NO awaiting_review!
    expect(model.needsYou.map((item) => item.id)).toEqual([
      "perm:srv_1:child_perm",
      "decision:dec_1",
      "plan:plan_open",
    ]);
    expect(model.needsYou.some((item) => item.taskId === "task_review")).toBe(false);
    expect(model.needsYou.some((item) => item.agentId === "child_review")).toBe(false);

    // Bucket 2: inProgress splits cleanly into normal active vs stale48h
    expect(model.inProgress.active.map((item) => item.taskId)).toEqual(["task_active"]);
    expect(model.inProgress.active[0]?.stale48h).toBe(false);
    expect(model.inProgress.stale.map((item) => item.taskId)).toEqual(["task_stale"]);
    expect(model.inProgress.stale[0]?.stale48h).toBe(true);
    expect(model.inProgress.all).toHaveLength(2);

    // Bucket 3: awaitingReview owns task_review exclusively
    expect(model.awaitingReview.map((item) => item.taskId)).toEqual(["task_review"]);

    // Bucket 4: parked owns task_parked
    expect(model.parked.map((item) => item.taskId)).toEqual(["task_parked"]);
    expect(model.parked[0]?.parkedReason).toBe("等待后端合入接口 PR");

    // Bucket 5: completed24h only includes recent completion; >24h task does NOT leak via liveAgents
    expect(model.completed24h.map((item) => item.taskId)).toEqual(["task_done_recent"]);

    expect(model.counts).toEqual({
      needsYou: 3,
      inProgress: 2,
      inProgressActive: 1,
      inProgressStale: 1,
      awaitingReview: 1,
      parked: 1,
      completed24h: 1,
      total: 8,
    });
  });

  it("strictly deduplicates duplicate permissions and prevents the same agentId/taskId from appearing twice", () => {
    const overview = makeOverview({
      decisions: [
        {
          id: "dec_dup",
          mainAgentId: "agent_main",
          title: "重复关联决策",
          question: "同一 Agent 的决策",
          agentId: "child_1",
          planId: null,
          taskId: "task_1",
          options: [{ id: "o1", label: "继续", leadsTo: "继续执行" }],
          recommendedOptionId: "o1",
          reason: null,
          answer: null,
          answeredOptionId: null,
          answeredAt: null,
          createdAt: isoAgo(5_000),
        },
      ],
      tasks: [
        makeTask({
          id: "task_1",
          title: "同一任务",
          status: "needs_you",
          activeAgentId: "child_1",
          agentIds: ["child_0", "child_1"],
        }),
      ],
    });

    const permA = makePermission("child_1", "req_same");
    const permADup = makePermission("child_1", "req_same");
    const permB = makePermission("child_1", "req_second");

    const model = buildMainChatActionBarModel({
      serverId: "srv_1",
      mainAgentId: "agent_main",
      overview,
      liveAgents: [
        makeLiveAgent({ agentId: "child_1", status: "running", turnPhase: "open" }),
        makeLiveAgent({ agentId: "child_0", status: "idle" }),
      ],
      pendingPermissions: [permA, permADup, permB],
      nowMs: NOW_MS,
    });

    // child_1 appears ONCE in needsYou, carrying 2 deduplicated permissions (req_same + req_second).
    expect(model.needsYou).toHaveLength(1);
    const first = model.needsYou[0];
    expect(first?.kind).toBe("permission");
    if (first?.kind === "permission") {
      expect(first.permissions.map((p) => p.request.id)).toEqual(["req_same", "req_second"]);
    }

    // Neither child_1 nor its historical lineage agent child_0 nor task_1 appears in any other bucket!
    expect(model.inProgress.all).toHaveLength(0);
    expect(model.awaitingReview).toHaveLength(0);
    expect(model.parked).toHaveLength(0);
    expect(model.completed24h).toHaveLength(0);
  });

  it("applies exact 48h stale boundary and exact 24h completion window boundary", () => {
    const overview = makeOverview({
      tasks: [
        makeTask({
          id: "just_under_48h",
          title: "48h 内",
          status: "running",
          lastActivityAt: isoAgo(STALE_IN_PROGRESS_THRESHOLD_MS - 1),
        }),
        makeTask({
          id: "at_48h",
          title: "正好 48h",
          status: "running",
          lastActivityAt: isoAgo(STALE_IN_PROGRESS_THRESHOLD_MS),
        }),
        makeTask({
          id: "at_24h",
          title: "正好 24h 完工",
          status: "completed",
          completedAt: isoAgo(COMPLETED_WINDOW_MS),
        }),
        makeTask({
          id: "over_24h",
          title: "超过 24h 完工",
          status: "completed",
          completedAt: isoAgo(COMPLETED_WINDOW_MS + 1),
        }),
      ],
    });

    const model = buildMainChatActionBarModel({
      serverId: "srv_1",
      mainAgentId: "agent_main",
      overview,
      liveAgents: [],
      pendingPermissions: [],
      nowMs: NOW_MS,
    });

    expect(model.inProgress.active.map((item) => item.taskId)).toEqual(["just_under_48h"]);
    expect(model.inProgress.stale.map((item) => item.taskId)).toEqual(["at_48h"]);
    expect(model.completed24h.map((item) => item.taskId)).toEqual(["at_24h"]);
  });
});

describe("M2 background turn collapse & silent turn suppression", () => {
  it("folds system background turns into a single line and suppresses completed silent rounds", () => {
    const at = new Date("2026-11-23T10:00:00.000Z");
    const makeHeartbeat = (id: string, text: string, turnId: string): ToolCallItem => ({
      kind: "tool_call",
      id,
      turnId,
      timestamp: at,
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: `paseo-system:${id}`,
          name: "heartbeat",
          status: "completed",
          error: null,
          detail: { type: "plain_text", text, icon: "sparkles" },
        },
      },
    });
    const makeShell = (id: string, turnId: string): ToolCallItem => ({
      kind: "tool_call",
      id,
      turnId,
      timestamp: at,
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: id,
          name: "Bash",
          status: "completed",
          error: null,
          detail: { type: "shell", command: "git status" },
        },
      },
    });

    const tail: StreamItem[] = [
      // Turn 1: Silent patrol turn -> completely suppressed
      makeHeartbeat("bg_silent", "【后台巡检唤醒】扫描 3 个会话", "turn_1"),
      makeShell("tool_1", "turn_1"),
      {
        kind: "assistant_message",
        id: "msg_silent",
        turnId: "turn_1",
        text: "[SILENT]",
        timestamp: at,
      },
      // Turn 2: Non-silent background wakeup -> collapsed to a single compact row
      makeHeartbeat("bg_report", "【后台巡检唤醒】发现 1 个异常会话", "turn_2"),
      makeShell("tool_2", "turn_2"),
      {
        kind: "assistant_message",
        id: "msg_report",
        turnId: "turn_2",
        text: "发现会话 A 报错，已尝试自动续跑。",
        timestamp: at,
      },
      // Turn 3: Missing reply recovery -> hides internal prompt, keeps assistant reply visible
      makeHeartbeat("bg_recover", "【系统自动补答提醒】请输出可见回复", "turn_3"),
      {
        kind: "assistant_message",
        id: "msg_recovered",
        turnId: "turn_3",
        text: "结论：所有测试均已通过。",
        timestamp: at,
      },
    ];

    const folded = collapseTurns({
      tail,
      isLatestTurnOpen: false,
      expandedHostIds: new Set(),
      getGroupedCalls: () => undefined,
      previousSummaryRowsByHostId: new Map(),
      collapseNormalTurns: true,
      collapseBackgroundTurns: true,
    });

    expect(folded.tail.map((item) => item.id)).toEqual(["turn-summary:bg_report", "msg_recovered"]);
    const bgSummary = folded.summaryRowsByHostId.get("bg_report");
    expect(bgSummary?.variant).toBe("background");
    expect(bgSummary?.backgroundMeta).toEqual({
      label: "后台巡检唤醒】发现 1 个异常会话",
      running: false,
    });

    // Expanding bg_report reveals prompt, tools, and reply inside the indent rail.
    const expanded = collapseTurns({
      tail,
      isLatestTurnOpen: false,
      expandedHostIds: new Set(["bg_report"]),
      getGroupedCalls: () => undefined,
      previousSummaryRowsByHostId: folded.summaryRowsByHostId,
      collapseNormalTurns: true,
      collapseBackgroundTurns: true,
    });
    expect(expanded.tail.map((item) => item.id)).toEqual([
      "turn-summary:bg_report",
      "bg_report",
      "tool_2",
      "msg_report",
      "msg_recovered",
    ]);
    expect([...expanded.nestedItemIds]).toEqual(["bg_report", "tool_2", "msg_report"]);
  });
});
