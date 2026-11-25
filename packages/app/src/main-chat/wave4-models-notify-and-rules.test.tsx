// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_CRITICAL_PASSTHROUGH_CATEGORIES,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  type MainChatNotificationReceipt,
  type MainChatNotificationSummary,
  type MainChatOverview,
  type MainChatSettings,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatModelProfilesPanel } from "@/screens/settings/main-chat/model-profiles-panel";
import { MainChatNotificationPolicyPanel } from "@/screens/settings/main-chat/notification-policy-panel";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { MainChatActionBar, useMainChatActionBarDrawerStore } from "./action-bar";
import { buildMainChatActionBarModel } from "./action-bar-model";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { useMainChatSettingsStore } from "./settings-store";
import { TaskDrawerGovernanceStrip } from "./task-drawer-governance-strip";
import { TaskPanelDrawer } from "./task-panel-drawer";
import {
  canRetryManagedFailedTask,
  deriveZeroTokenDiagnosticBadge,
} from "./zero-token-diagnostic-ui";

const routerPushMock = vi.fn();

vi.mock("expo-router", () => ({
  router: {
    push: (...args: unknown[]) => routerPushMock(...args),
  },
  usePathname: () => "/host/srv_1/main-chat",
}));

const stableTranslate = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;
const stableI18n = { language: "zh-CN" };

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: stableTranslate,
      i18n: stableI18n,
    }),
  };
});

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => false,
  };
});

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: () => null,
}));

vi.mock("@/components/status-ring", () => ({
  StatusRing: () => React.createElement("div", { "data-testid": "mock-status-ring" }),
}));

vi.mock("./agent-host", () => ({
  MainChatAgentHost: ({ agentId }: { agentId: string }) =>
    React.createElement("div", { "data-testid": `mock-agent-host-${agentId}` }, agentId),
}));

vi.mock("@/git/diff-pane", () => ({
  ChangesSurface: () => React.createElement("div", { "data-testid": "mock-diff-surface" }),
}));

vi.mock("@/components/terminal-pane", () => ({
  TerminalPane: () => React.createElement("div", { "data-testid": "mock-terminal-pane" }),
}));

vi.mock("@/runtime/host-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/runtime/host-runtime")>();
  return {
    ...actual,
    useHosts: () => [{ serverId: "srv_1", label: "DevBox", isLocal: true }],
  };
});

const toastApi = {
  show: vi.fn(),
  copied: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
};

function wrap(node: React.ReactElement) {
  return (
    <KeyboardActionDispatcherProvider>
      <ToastApiProvider api={toastApi}>{node}</ToastApiProvider>
    </KeyboardActionDispatcherProvider>
  );
}

function makeTask(
  overrides: Partial<MainChatTaskRecord> & { id: string; title: string },
): MainChatTaskRecord {
  const now = "2026-11-25T06:00:00.000Z";
  return {
    mainAgentId: "agent_main",
    conversationId: "conv_main",
    planId: "plan_w4",
    mode: "write",
    isolation: "worktree",
    serverId: "srv_1",
    hostLabel: "DevBox",
    cwd: "/repo/paseo-fork",
    workspaceId: "ws_paseo",
    workspaceLabel: "paseo-fork",
    status: "running",
    brief: {
      goal: overrides.title,
      doneWhen: ["单测与 typecheck 通过"],
      outOfBounds: [],
      scopeRevision: 1,
      updatedAt: now,
    },
    activeAgentId: null,
    agentIds: [],
    decisions: [],
    latestReceipt: null,
    expectedMinutes: 15,
    actualMinutes: null,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    completedAt: null,
    parkedAt: null,
    parkedReason: null,
    continuesTaskId: null,
    continuesWhy: null,
    supersededByTaskId: null,
    quiet: true,
    partOf: null,
    after: [],
    dependencyState: "none",
    autoStartOnReady: false,
    deliveryGate: null,
    ...overrides,
  };
}

function makeModelProfileTestFixture(): {
  settings: MainChatSettings;
  client: DaemonClient;
  switchMainChatModelProfile: ReturnType<typeof vi.fn>;
} {
  const base = createDefaultMainChatSettings();
  const settings: MainChatSettings = {
    ...base,
    modelConfig: {
      activeProfileId: "balanced",
      slots: {
        main: { provider: "claude", model: "claude-opus-4-6", thinkingOptionId: "high" },
        directionLead: null,
        subagentDefault: { provider: "claude", model: "claude-sonnet-4-6" },
        subagentReadonly: null,
        backgroundTriage: { provider: "claude", model: "claude-haiku-4-5" },
      },
      customProfiles: [
        {
          id: "custom_night",
          name: "深夜省额档",
          slots: { main: { provider: "codex", model: "gpt-5.3-codex" } },
          builtin: false,
          updatedAt: "2026-11-25T05:00:00.000Z",
        },
      ],
      rollbackSnapshot: {
        profileId: "performance",
        slots: { main: { provider: "claude", model: "claude-opus-4-6" } },
        savedAt: "2026-11-25T05:10:00.000Z",
      },
      switchHistory: [
        {
          id: "sw_1",
          action: "switch",
          fromProfileId: "performance",
          toProfileId: "balanced",
          actor: "user",
          changedSlots: ["subagentDefault", "backgroundTriage"],
          createdAt: "2026-11-25T05:10:00.000Z",
        },
      ],
    },
  };
  const switchMainChatModelProfile = vi.fn(
    async (input: { profileId?: string; rollback?: boolean }) => ({
      requestId: "req_sw",
      settings: {
        ...settings,
        modelConfig: {
          ...settings.modelConfig!,
          activeProfileId: input.rollback ? "performance" : (input.profileId ?? "economy"),
        },
      },
      activeProfileId: input.rollback ? "performance" : (input.profileId ?? "economy"),
      changedSlots: ["subagentDefault" as const],
      event: null,
      error: null,
    }),
  );
  return {
    settings,
    client: { switchMainChatModelProfile } as unknown as DaemonClient,
    switchMainChatModelProfile,
  };
}

function makeNotifyPolicyTestFixture(): {
  settings: MainChatSettings;
  client: DaemonClient;
  ackMainChatNotificationReceipt: ReturnType<typeof vi.fn>;
} {
  const base = createDefaultMainChatSettings();
  const settings: MainChatSettings = {
    ...base,
    notificationPolicy: {
      lowDistractionEnabled: true,
      mode: "low_distraction",
      foldLowPriorityToDigest: true,
      categoryOverrides: {
        task_progress: "digest",
      },
    },
  };
  const receipts: MainChatNotificationReceipt[] = [
    {
      id: "nrec_1",
      category: "permission_approval",
      signalKind: "ask",
      tier: "critical",
      status: "delivered",
      channel: "push",
      title: "权限审批：执行数据库迁移",
      summary: "需要人工放行写入权限",
      reason: "关键事件穿透低打扰",
      passthrough: true,
      createdAt: "2026-11-25T05:50:00.000Z",
      updatedAt: "2026-11-25T05:50:00.000Z",
      deliveredAt: "2026-11-25T05:50:00.000Z",
      acknowledgedAt: null,
      readAt: null,
    },
    {
      id: "nrec_2",
      category: "task_progress",
      signalKind: "report",
      tier: "digest",
      status: "suppressed_quiet",
      channel: "digest",
      title: "子任务阶段汇报",
      summary: "已完成协议层单测",
      reason: "低打扰模式已折叠至摘要箱",
      passthrough: false,
      createdAt: "2026-11-25T05:45:00.000Z",
      updatedAt: "2026-11-25T05:45:00.000Z",
      deliveredAt: null,
      acknowledgedAt: null,
      readAt: null,
    },
  ];
  const summary: MainChatNotificationSummary = {
    lowDistractionEnabled: true,
    mode: "low_distraction",
    unreadCount: 2,
    deliveredCount: 1,
    suppressedQuietCount: 1,
    suppressedNightCount: 0,
    foldedDigestCount: 1,
    criticalPassthroughCount: 1,
    latestReceiptAt: "2026-11-25T05:50:00.000Z",
  };
  const listMainChatNotificationReceipts = vi.fn(async () => ({
    requestId: "req_list",
    receipts,
    summary,
    error: null,
  }));
  const ackMainChatNotificationReceipt = vi.fn(
    async (input: { receiptId?: string; markAll?: boolean }) => ({
      requestId: "req_ack",
      updatedCount: 1,
      summary: {
        ...summary,
        unreadCount: input.markAll ? 0 : 1,
      },
      error: null,
    }),
  );
  return {
    settings,
    client: {
      listMainChatNotificationReceipts,
      ackMainChatNotificationReceipt,
    } as unknown as DaemonClient,
    ackMainChatNotificationReceipt,
  };
}

const MANUAL_DRAWER_TARGET = {
  serverId: "srv_1",
  agentId: "agent_manual_err",
  workspaceId: "ws_paseo",
  title: "用户手动调试会话",
  taskId: null,
};

const EMPTY_LESSONS: never[] = [];

describe("Wave 4 (P1-4 / P1-5 / P1-6) frontend panels, fallback retry, and zero-token diagnostic UI", () => {
  beforeEach(() => {
    toastApi.show.mockReset();
    toastApi.error.mockReset();
    routerPushMock.mockReset();
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      nightModeStatusByServerId: {},
      cacheKeepaliveStatusByServerId: {},
      notificationSummaryByServerId: {},
      usageByServerId: {},
      usageLoadingByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: {},
      decisionsByKey: {},
      settingsProposalsByKey: {},
      activeAgentOverrideByServerId: {},
    });
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: {},
      expandedByKey: {},
      focusedNeedsIdByKey: {},
      compactDockCollapsedByKey: {},
    });
    useSessionStore.setState({ sessions: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders ModelProfilesPanel with slot inheritance, switches & rolls back profiles atomically, and saves custom profiles", async () => {
    const { settings, client, switchMainChatModelProfile } = makeModelProfileTestFixture();
    const onApplyPatch = vi.fn();

    const view = render(
      wrap(
        <MainChatModelProfilesPanel
          serverId="srv_1"
          client={client}
          settings={settings}
          onApplyPatch={onApplyPatch}
        />,
      ),
    );

    // Slot inheritance is displayed cleanly: directionLead inherits main, subagentReadonly inherits subagentDefault
    expect(view.getByTestId("model-profiles-slot-spec-main").textContent).toContain(
      "claude/claude-opus-4-6",
    );
    expect(view.getByTestId("model-profiles-slot-directionLead").textContent).toContain(
      "slotSourceInherited",
    );
    expect(view.getByTestId("model-profiles-slot-subagentReadonly").textContent).toContain(
      "slotSourceInherited",
    );

    // Clicking rollback invokes switchMainChatModelProfile({ rollback: true })
    await act(async () => {
      fireEvent.click(view.getByTestId("model-profiles-rollback-btn"));
    });
    await waitFor(() => {
      expect(switchMainChatModelProfile).toHaveBeenCalledWith({ rollback: true });
    });

    // Clicking apply on a custom profile invokes switchMainChatModelProfile({ profileId: "custom_night" })
    await act(async () => {
      fireEvent.click(view.getByTestId("model-profiles-apply-custom-custom_night"));
    });
    await waitFor(() => {
      expect(switchMainChatModelProfile).toHaveBeenCalledWith({ profileId: "custom_night" });
    });

    // Resetting an explicit slot calls onApplyPatch with null
    await act(async () => {
      fireEvent.click(view.getByTestId("model-profiles-slot-reset-subagentDefault"));
    });
    expect(onApplyPatch).toHaveBeenCalledWith(
      { modelConfig: { slots: { subagentDefault: null } } },
      expect.any(String),
    );
  });

  it("renders NotificationPolicyPanel with mandatory passthrough locks, tier toggles, and receipt ack actions", async () => {
    const { settings, client, ackMainChatNotificationReceipt } = makeNotifyPolicyTestFixture();
    const onApplyPatch = vi.fn();

    const view = render(
      wrap(
        <MainChatNotificationPolicyPanel
          serverId="srv_1"
          client={client}
          settings={settings}
          onApplyPatch={onApplyPatch}
        />,
      ),
    );

    await waitFor(() => {
      expect(view.getByTestId("notify-receipt-row-nrec_1")).toBeTruthy();
      expect(view.getByTestId("notify-receipt-row-nrec_2")).toBeTruthy();
    });

    // All 4 mandatory passthrough categories must render locked critical badge
    for (const cat of MAIN_CHAT_CRITICAL_PASSTHROUGH_CATEGORIES) {
      expect(view.getByTestId(`notify-category-passthrough-${cat}`)).toBeTruthy();
    }

    // Configurable category can switch tier
    await act(async () => {
      fireEvent.click(view.getByTestId("notify-category-task_progress-tier-silent"));
    });
    expect(onApplyPatch).toHaveBeenCalledWith(
      { notificationPolicy: { categoryOverrides: { task_progress: "silent" } } },
      expect.any(String),
    );

    // Single receipt ack & mark all read
    await act(async () => {
      fireEvent.click(view.getByTestId("notify-receipt-ack-nrec_1"));
    });
    await waitFor(() => {
      expect(ackMainChatNotificationReceipt).toHaveBeenCalledWith({
        receiptId: "nrec_1",
        status: "read",
      });
    });

    await act(async () => {
      fireEvent.click(view.getByTestId("notify-receipts-mark-all-read"));
    });
    await waitFor(() => {
      expect(ackMainChatNotificationReceipt).toHaveBeenCalledWith({
        markAll: true,
        status: "read",
      });
    });
  });

  it("shows 1-click fallback retry ONLY on managed failed tasks and renders all 3 zero-token diagnostic badges", async () => {
    const now = "2026-11-25T06:00:00.000Z";
    const managedFailedTask = makeTask({
      id: "task_failed_1",
      title: "修复鉴权回归单测",
      status: "failed",
      activeAgentId: "agent_failed_1",
      agentIds: ["agent_failed_1"],
      lastRuleDiagnostic: {
        kind: "tool_loop",
        severity: "critical",
        summary: "工具循环：Bash 连续 3 次返回相同报错",
        detail: "检测到连续相同报错签名",
        detectedAt: now,
        toolName: "Bash",
        repeatCount: 3,
        pattern: "repeated_error",
        errorExcerpt: "ERR_MODULE_NOT_FOUND: @getpaseo/protocol",
      },
    });
    const readWithoutReplyTask = makeTask({
      id: "task_rwr_1",
      title: "调研配置加载顺序",
      mode: "readonly",
      status: "needs_you",
      activeAgentId: "agent_rwr_1",
      agentIds: ["agent_rwr_1"],
      lastRuleDiagnostic: {
        kind: "read_without_reply",
        severity: "warning",
        summary: "已读未回：仅回复「好的，我看一下。」",
        detectedAt: now,
      },
    });
    const missingWrapUpTask = makeTask({
      id: "task_wrap_1",
      title: "重构通知回执持久化",
      status: "awaiting_review",
      activeAgentId: "agent_wrap_1",
      agentIds: ["agent_wrap_1"],
      lastRuleDiagnostic: {
        kind: "missing_wrap_up",
        severity: "warning",
        summary: "漏收尾：写入改动后缺少验证证据与验收对照",
        detectedAt: now,
        missingItems: ["验证/测试结果证据", "doneWhen 逐条确认"],
      },
    });

    expect(canRetryManagedFailedTask(managedFailedTask, true)).toBe(true);
    expect(canRetryManagedFailedTask(null, true)).toBe(false);
    expect(deriveZeroTokenDiagnosticBadge(managedFailedTask.lastRuleDiagnostic)?.labelKey).toBe(
      "mainChat.zeroTokenRules.badges.tool_loop",
    );
    expect(deriveZeroTokenDiagnosticBadge(readWithoutReplyTask.lastRuleDiagnostic)?.labelKey).toBe(
      "mainChat.zeroTokenRules.badges.read_without_reply",
    );
    expect(deriveZeroTokenDiagnosticBadge(missingWrapUpTask.lastRuleDiagnostic)?.labelKey).toBe(
      "mainChat.zeroTokenRules.badges.missing_wrap_up",
    );

    const overview: MainChatOverview = {
      plans: [],
      decisions: [],
      autoStartRules: [],
      permissionRules: [],
      metrics: {
        autoContinued: 0,
        plansCreated: 1,
        plansAutoStarted: 0,
        plansStarted: 1,
        plansCancelled: 0,
        receiptsRecorded: 0,
        interrupts: 0,
        supervisorHeld: 0,
        reworkCount: 0,
        stalledNudges: 0,
        usageLimitRetries: 0,
      },
      tasks: [managedFailedTask, readWithoutReplyTask, missingWrapUpTask],
      triages: [
        {
          agentId: "agent_failed_1",
          workspaceId: "ws_paseo",
          title: managedFailedTask.title,
          managedByMainChat: true,
          phase: "blocked_user",
          summary: "等待用户选择重试方式",
          waitReason: "需要选择替代模型",
          suggestedAction: null,
          triageSource: "rule",
          updatedAt: now,
        },
        {
          agentId: "agent_manual_err",
          workspaceId: "ws_paseo",
          title: "用户手动调试会话",
          managedByMainChat: false,
          phase: "blocked_user",
          summary: "手动会话报错退出",
          waitReason: "进程异常退出",
          suggestedAction: null,
          triageSource: "rule",
          ruleDiagnostic: {
            kind: "tool_loop",
            severity: "critical",
            summary: "工具循环：手动会话重复报错",
            detectedAt: now,
            toolName: "Bash",
            repeatCount: 3,
            pattern: "repeated_error",
          },
          updatedAt: now,
        },
      ],
    };

    const retryMainChatTaskWithFallback = vi.fn(async (_input: { taskId: string }) => ({
      requestId: "req_retry",
      task: { ...managedFailedTask, status: "running" as const, activeAgentId: "agent_retry_2" },
      previousAgentId: "agent_failed_1",
      newAgentId: "agent_retry_2",
      fromModelSpec: "claude/claude-opus-4-6",
      toModelSpec: "codex/gpt-5.3-codex",
      fallbackEvent: null,
      error: null,
    }));
    const client = {
      getMainChatOverview: vi.fn(async () => ({ requestId: "req_ov", overview, error: null })),
      retryMainChatTaskWithFallback,
    } as unknown as DaemonClient;

    const nowDate = new Date(now);
    const makeAgent = (id: string, status: string, labels: Record<string, string>) => ({
      id,
      serverId: "srv_1",
      workspaceId: "ws_paseo",
      provider: "claude",
      status,
      cwd: "/repo/paseo-fork",
      title: id,
      createdAt: nowDate,
      updatedAt: nowDate,
      requiresAttention: status === "error",
      attentionReason: null,
      labels,
      pendingPermissions: [],
      turn: { phase: "idle" as const },
    });

    useSessionStore.setState({
      sessions: {
        srv_1: {
          client,
          agents: new Map([
            [
              "agent_main",
              makeAgent("agent_main", "idle", { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE }),
            ],
            ["agent_failed_1", makeAgent("agent_failed_1", "error", {})],
            ["agent_rwr_1", makeAgent("agent_rwr_1", "idle", {})],
            ["agent_wrap_1", makeAgent("agent_wrap_1", "idle", {})],
            ["agent_manual_err", makeAgent("agent_manual_err", "error", {})],
          ]),
          agentDetails: new Map(),
          workspaces: new Map(),
          pendingPermissions: new Map(),
        } as unknown as SessionState,
      },
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: { [overviewStoreKey("srv_1", "agent_main")]: overview },
      decisionsByKey: {},
      settingsProposalsByKey: {},
      activeAgentOverrideByServerId: {},
    });

    // Verify ActionBarModel: managed failed task has canRetryWithFallback=true, manual failed session has false!
    const model = buildMainChatActionBarModel({
      serverId: "srv_1",
      mainAgentId: "agent_main",
      overview,
      liveAgents: [
        {
          serverId: "srv_1",
          agentId: "agent_failed_1",
          workspaceId: "ws_paseo",
          title: managedFailedTask.title,
          cwd: "/repo/paseo-fork",
          status: "error",
          turnPhase: "idle",
          hasBackgroundWork: false,
          requiresAttention: true,
          attentionReason: null,
          archived: false,
          background: false,
          isMainChat: false,
          managedByMainChat: true,
          mode: "write",
          taskRecordId: managedFailedTask.id,
          planId: "plan_w4",
          updatedAtMs: nowDate.getTime(),
          lastActivityAtMs: nowDate.getTime(),
        },
        {
          serverId: "srv_1",
          agentId: "agent_manual_err",
          workspaceId: "ws_paseo",
          title: "用户手动调试会话",
          cwd: "/repo/paseo-fork",
          status: "error",
          turnPhase: "idle",
          hasBackgroundWork: false,
          requiresAttention: true,
          attentionReason: null,
          archived: false,
          background: false,
          isMainChat: false,
          managedByMainChat: false,
          mode: null,
          taskRecordId: null,
          planId: null,
          updatedAtMs: nowDate.getTime(),
          lastActivityAtMs: nowDate.getTime(),
        },
      ],
      pendingPermissions: [],
      nowMs: nowDate.getTime(),
    });

    const managedNeeds = model.needsYou.find(
      (n) => n.kind === "task" && n.taskId === "task_failed_1",
    );
    const manualNeeds = model.needsYou.find(
      (n) => n.kind === "task" && n.agentId === "agent_manual_err",
    );
    expect(managedNeeds?.kind === "task" && managedNeeds.canRetryWithFallback).toBe(true);
    expect(manualNeeds?.kind === "task" && manualNeeds.canRetryWithFallback).toBe(false);

    // Open NeedsYou drawer in ActionBar and click 1-click retry on managed failed task
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "needsYou" },
    });
    const barView = render(
      wrap(<MainChatActionBar serverId="srv_1" agentId="agent_main" drawerMode="floating" />),
    );
    expect(barView.getByTestId("main-chat-action-retry-fallback-task_failed_1")).toBeTruthy();
    expect(
      barView.getByTestId("main-chat-action-needs-rule-badge-task:task_failed_1"),
    ).toBeTruthy();
    expect(barView.getByTestId("main-chat-action-needs-rule-badge-task:task_rwr_1")).toBeTruthy();

    await act(async () => {
      fireEvent.click(barView.getByTestId("main-chat-action-retry-fallback-task_failed_1"));
    });
    await waitFor(() => {
      expect(retryMainChatTaskWithFallback).toHaveBeenCalledWith({ taskId: "task_failed_1" });
    });
    barView.unmount();

    // Verify TaskDrawerGovernanceStrip shows diagnostic detail & retry button for managed failed task
    const onRetry = vi.fn();
    const managedTasksList = [managedFailedTask];
    const onStartReady = vi.fn();
    const onSelectRelated = vi.fn();
    const stripView = render(
      wrap(
        <TaskDrawerGovernanceStrip
          task={managedFailedTask}
          allTasks={managedTasksList}
          projectLessons={EMPTY_LESSONS}
          isFailed
          isMutatingTask={false}
          onStartReadyTask={onStartReady}
          onRetryWithFallback={onRetry}
          onSelectRelatedTask={onSelectRelated}
        />,
      ),
    );
    expect(stripView.getByTestId("main-chat-task-drawer-rule-badge-tool_loop")).toBeTruthy();
    expect(stripView.getByTestId("main-chat-task-drawer-rule-diagnostic-detail")).toBeTruthy();
    fireEvent.click(stripView.getByTestId("main-chat-task-drawer-retry-fallback"));
    expect(onRetry).toHaveBeenCalledWith("task_failed_1");
    stripView.unmount();

    // Verify TaskPanelDrawer on a manual failed session shows read-only diagnostic strip and NO retry button!
    const onFocusDrawer = vi.fn();
    const manualDrawer = render(
      wrap(
        <TaskPanelDrawer
          target={MANUAL_DRAWER_TARGET}
          mainServerId="srv_1"
          mainAgentId="agent_main"
          isFocused
          onFocus={onFocusDrawer}
        />,
      ),
    );
    expect(manualDrawer.getByTestId("main-chat-task-drawer-manual-rule-diagnostic")).toBeTruthy();
    expect(manualDrawer.queryByTestId("main-chat-task-drawer-retry-fallback")).toBeNull();
  });
});
