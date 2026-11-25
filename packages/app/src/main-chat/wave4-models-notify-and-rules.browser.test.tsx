import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  type MainChatNotificationReceipt,
  type MainChatNotificationSummary,
  type MainChatOverview,
  type MainChatSettings,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { CHAT_COLUMN_RAIL_DATASET, ChatColumnRailSurface } from "@/chat-rail";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatModelProfilesPanel } from "@/screens/settings/main-chat/model-profiles-panel";
import { MainChatNotificationPolicyPanel } from "@/screens/settings/main-chat/notification-policy-panel";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import {
  MainChatActionBar,
  MainChatActionBarDrawerOverlay,
  useMainChatActionBarDrawerStore,
} from "./action-bar";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { useMainChatSettingsStore } from "./settings-store";
import { TaskDrawerGovernanceStrip } from "./task-drawer-governance-strip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const browserToastApi = { show: vi.fn(), copied: vi.fn(), error: vi.fn(), dismiss: vi.fn() };

const SCREENSHOT_DIR =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_MAIN_CHAT_SCREENSHOT_DIR || "/tmp/main-chat-017528-screenshots";

function makeWave4Settings(): MainChatSettings {
  const base = createDefaultMainChatSettings();
  return {
    ...base,
    enabled: true,
    modelConfig: {
      activeProfileId: "balanced",
      slots: {
        main: { provider: "claude", model: "claude-opus-4-6", thinkingOptionId: "high" },
        directionLead: null,
        subagentDefault: {
          provider: "claude",
          model: "claude-sonnet-4-6",
          thinkingOptionId: "medium",
        },
        subagentReadonly: null,
        backgroundTriage: { provider: "claude", model: "claude-haiku-4-5" },
      },
      customProfiles: [
        {
          id: "custom_late_night",
          name: "深夜经济档",
          slots: {
            main: { provider: "codex", model: "gpt-5.3-codex", thinkingOptionId: "medium" },
            subagentDefault: { provider: "claude", model: "claude-sonnet-4-6" },
            subagentReadonly: { provider: "claude", model: "claude-haiku-4-5" },
          },
          builtin: false,
          updatedAt: "2026-11-25T05:30:00.000Z",
        },
      ],
      rollbackSnapshot: {
        profileId: "performance",
        slots: {
          main: { provider: "claude", model: "claude-opus-4-6", thinkingOptionId: "high" },
          subagentDefault: {
            provider: "claude",
            model: "claude-opus-4-6",
            thinkingOptionId: "high",
          },
        },
        savedAt: "2026-11-25T05:40:00.000Z",
      },
      switchHistory: [
        {
          id: "sw_hist_1",
          action: "switch",
          fromProfileId: "performance",
          toProfileId: "balanced",
          actor: "user",
          changedSlots: ["subagentDefault", "subagentReadonly", "backgroundTriage"],
          createdAt: "2026-11-25T05:40:00.000Z",
        },
      ],
    },
    notificationPolicy: {
      lowDistractionEnabled: true,
      mode: "low_distraction",
      foldLowPriorityToDigest: true,
      categoryOverrides: {
        task_review: "actionable",
        task_progress: "digest",
        patrol_summary: "silent",
        rule_diagnostic: "actionable",
      },
    },
  };
}

function makeWave4Receipts(): {
  receipts: MainChatNotificationReceipt[];
  summary: MainChatNotificationSummary;
} {
  const receipts: MainChatNotificationReceipt[] = [
    {
      id: "nrec_w4_1",
      category: "permission_approval",
      signalKind: "ask",
      tier: "critical",
      status: "delivered",
      channel: "push",
      title: "权限审批：执行数据库 Schema 变更",
      summary: "关键事件强制穿透低打扰模式，已立即推送提醒",
      reason: "permission_approval 强制穿透",
      passthrough: true,
      createdAt: "2026-11-25T05:58:00.000Z",
      updatedAt: "2026-11-25T05:58:00.000Z",
      deliveredAt: "2026-11-25T05:58:00.000Z",
      acknowledgedAt: null,
      readAt: null,
    },
    {
      id: "nrec_w4_2",
      category: "task_progress",
      signalKind: "report",
      tier: "digest",
      status: "suppressed_quiet",
      channel: "digest",
      title: "子任务进度汇报：协议层单测已通过",
      summary: "低打扰模式已折叠至摘要箱，不打断当前对话",
      reason: "低打扰折叠",
      passthrough: false,
      createdAt: "2026-11-25T05:52:00.000Z",
      updatedAt: "2026-11-25T05:52:00.000Z",
      deliveredAt: null,
      acknowledgedAt: null,
      readAt: null,
    },
    {
      id: "nrec_w4_3",
      category: "patrol_summary",
      signalKind: "check",
      tier: "silent",
      status: "suppressed_night",
      channel: "badge",
      title: "夜间例行巡检摘要",
      summary: "夜间静默窗口内自动抑制非紧急巡检提醒",
      reason: "夜间静默",
      passthrough: false,
      createdAt: "2026-11-25T02:15:00.000Z",
      updatedAt: "2026-11-25T02:15:00.000Z",
      deliveredAt: null,
      acknowledgedAt: null,
      readAt: "2026-11-25T05:10:00.000Z",
    },
  ];
  const summary: MainChatNotificationSummary = {
    lowDistractionEnabled: true,
    mode: "low_distraction",
    unreadCount: 2,
    deliveredCount: 1,
    suppressedQuietCount: 1,
    suppressedNightCount: 1,
    foldedDigestCount: 1,
    criticalPassthroughCount: 1,
    latestReceiptAt: "2026-11-25T05:58:00.000Z",
  };
  return { receipts, summary };
}

function makeWave4Tasks(): MainChatTaskRecord[] {
  const now = "2026-11-25T05:55:00.000Z";
  const base = {
    mainAgentId: "agent_main",
    conversationId: "conv_main",
    planId: "plan_w4",
    mode: "write" as const,
    isolation: "worktree" as const,
    serverId: "srv_1",
    hostLabel: "DevBox",
    cwd: "/data00/repo/paseo-fork",
    workspaceId: "ws_paseo",
    workspaceLabel: "paseo-fork",
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
    dependencyState: "none" as const,
    autoStartOnReady: false,
    deliveryGate: null,
  };

  return [
    {
      ...base,
      id: "task_w4_failed",
      title: "修复服务端鉴权回归单测",
      status: "failed",
      brief: {
        goal: "修复鉴权中间件回归并跑通 protocol / server 全量单测",
        doneWhen: ["server typecheck 0 errors", "回归单测全绿"],
        outOfBounds: ["不触碰 6767 线上进程"],
        scopeRevision: 1,
        updatedAt: now,
      },
      activeAgentId: "agent_w4_failed",
      agentIds: ["agent_w4_failed"],
      lastProvider: "claude",
      lastModel: "claude-opus-4-6",
      lastRuleDiagnostic: {
        kind: "tool_loop",
        severity: "critical",
        summary: "工具循环：Bash 连续 3 次返回相同报错",
        detail: "检测到连续 3 次相同错误签名，已零 Token 触发 no_progress 信号",
        detectedAt: now,
        toolName: "Bash",
        repeatCount: 3,
        pattern: "repeated_error",
        errorExcerpt: "ERR_MODULE_NOT_FOUND: Cannot find package '@getpaseo/protocol'",
      },
    },
    {
      ...base,
      id: "task_w4_rwr",
      title: "调研远程主机构建配置",
      mode: "readonly",
      status: "needs_you",
      brief: {
        goal: "核对多主机模型槽位与低打扰通知默认行为",
        doneWhen: ["输出排查结论"],
        outOfBounds: [],
        scopeRevision: 1,
        updatedAt: now,
      },
      activeAgentId: "agent_w4_rwr",
      agentIds: ["agent_w4_rwr"],
      lastRuleDiagnostic: {
        kind: "read_without_reply",
        severity: "warning",
        summary: "已读未回：仅回复「好的，我先看一下。」",
        detail: "执行只读工具后仅输出简短寒暄便结束本轮",
        detectedAt: now,
      },
    },
    {
      ...base,
      id: "task_w4_wrap",
      title: "补齐通知回执持久化测试",
      status: "awaiting_review",
      brief: {
        goal: "完成 notificationReceipts 环形缓冲持久化并补单测",
        doneWhen: ["重启回读一致", "单测全绿"],
        outOfBounds: [],
        scopeRevision: 1,
        updatedAt: now,
      },
      activeAgentId: "agent_w4_wrap",
      agentIds: ["agent_w4_wrap"],
      lastRuleDiagnostic: {
        kind: "missing_wrap_up",
        severity: "warning",
        summary: "漏收尾：写入改动后缺少验证证据与验收对照",
        detail: "检测到 Edit 工具写入但最终回复过于简略",
        detectedAt: now,
        missingItems: ["验证/测试结果证据", "doneWhen 逐条确认"],
      },
    },
  ];
}

const noopFn = () => undefined;

function Wave4MessageBubble(): ReactElement {
  return (
    <View style={sceneStyles.streamTranscriptOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
      <View style={sceneStyles.streamTranscript}>
        <View style={sceneStyles.messageBubble} testID="wave4-message-column">
          <Text style={sceneStyles.messageHeading}>
            总控主对话 · Wave 4 零 Token 规则与备选重试
          </Text>
          <Text style={sceneStyles.messageBody}>
            零 Token
            确定性规则已检出「工具循环」「已读未回」与「漏收尾」三条异常，未触发任何模型调用；受管失败任务支持在同一任务卡上一键切换备选模型重试，用户手动会话保持严格只读。
          </Text>
        </View>
      </View>
    </View>
  );
}

function Wave4MainChatSplitScene({
  tasks,
  showDrawer = true,
  compact = false,
}: {
  tasks: readonly MainChatTaskRecord[];
  showDrawer?: boolean;
  compact?: boolean;
}): ReactElement {
  const failedTask = tasks[0]!;
  return (
    <View
      style={compact ? sceneStyles.narrowMainScene : sceneStyles.wideMainScene}
      testID="wave4-main-scene"
    >
      <View style={sceneStyles.mainChatColumn} testID="wave4-main-column">
        <ChatColumnRailSurface serverId="srv_1">
          <View style={sceneStyles.streamSurface} testID="wave4-stream-surface">
            <Wave4MessageBubble />
            <MainChatActionBarDrawerOverlay serverId="srv_1" agentId="agent_main" />
          </View>

          <View style={sceneStyles.bottomStack}>
            <MainChatActionBar serverId="srv_1" agentId="agent_main" drawerMode="external" />

            <View style={sceneStyles.composerOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
              <View style={sceneStyles.composerInner} testID="wave4-composer-baseline">
                <Text style={sceneStyles.composerPlaceholder}>
                  向总控主对话下达任务、切换模型档位或排查规则告警…
                </Text>
              </View>
            </View>
          </View>
        </ChatColumnRailSurface>
      </View>

      {showDrawer ? (
        <View style={sceneStyles.drawerPanel} testID="main-chat-task-drawer">
          <View style={sceneStyles.drawerHeader}>
            <Text style={sceneStyles.drawerTitle} numberOfLines={1}>
              {failedTask.title}
            </Text>
            <Text style={sceneStyles.drawerSubtitle} numberOfLines={1}>
              DevBox · paseo-fork · claude/claude-opus-4-6
            </Text>
          </View>
          <TaskDrawerGovernanceStrip
            task={failedTask}
            allTasks={tasks}
            projectLessons={[]}
            ruleDiagnostic={failedTask.lastRuleDiagnostic}
            isFailed
            isMutatingTask={false}
            onStartReadyTask={noopFn}
            onRetryWithFallback={noopFn}
            onSelectRelatedTask={noopFn}
          />
          <View style={sceneStyles.drawerAgentPreview}>
            <Text style={sceneStyles.drawerPreviewHeading}>零 Token 规则诊断详情</Text>
            <Text style={sceneStyles.drawerPreviewBody}>
              连续 3 次 Bash 报错签名相同，已自动标记为「工具循环」并上报 no_progress
              信号；点击上方「换模型重试」即可在同一任务卡上按 limitFallbacks
              顺位拉起备选模型继续执行。
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

describe("Wave 4 (P1-4 / P1-5 / P1-6) real Chromium visual & layout verification", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fixtureSettings: MainChatSettings;
  let fixtureClient: DaemonClient;
  let fixtureOverview: MainChatOverview;
  let fixtureReceipts: MainChatNotificationReceipt[];
  let fixtureSummary: MainChatNotificationSummary;

  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    UnistylesRuntime.setTheme("light");
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    document.body.style.margin = "0";
    document.body.style.padding = "0";
    host = document.createElement("div");
    host.style.width = "100%";
    host.style.boxSizing = "border-box";
    document.body.appendChild(host);
    root = createRoot(host);

    fixtureSettings = makeWave4Settings();
    const tasks = makeWave4Tasks();
    const recData = makeWave4Receipts();
    fixtureReceipts = recData.receipts;
    fixtureSummary = recData.summary;

    fixtureOverview = {
      plans: [],
      decisions: [],
      autoStartRules: [],
      permissionRules: [],
      metrics: {
        autoContinued: 2,
        plansCreated: 3,
        plansAutoStarted: 1,
        plansStarted: 2,
        plansCancelled: 0,
        receiptsRecorded: 2,
        interrupts: 0,
        supervisorHeld: 4,
        reworkCount: 0,
        stalledNudges: 1,
        usageLimitRetries: 1,
      },
      tasks,
      triages: [
        {
          agentId: "agent_w4_failed",
          workspaceId: "ws_paseo",
          title: tasks[0]!.title,
          managedByMainChat: true,
          phase: "blocked_user",
          summary: "构建失败，等待用户决定是否切换模型",
          waitReason: "工具循环：连续报错",
          suggestedAction: "尝试切换备选模型或补跑 protocol build",
          triageSource: "rule",
          ruleDiagnostic: tasks[0]!.lastRuleDiagnostic,
          updatedAt: "2026-11-25T05:55:00.000Z",
        },
        {
          agentId: "agent_w4_rwr",
          workspaceId: "ws_paseo",
          title: tasks[1]!.title,
          managedByMainChat: true,
          phase: "blocked_user",
          summary: "仅回复「好的，我先看一下。」便结束本轮",
          waitReason: "已读未回",
          suggestedAction: "追问实质排查结论",
          triageSource: "rule",
          ruleDiagnostic: tasks[1]!.lastRuleDiagnostic,
          updatedAt: "2026-11-25T05:54:00.000Z",
        },
      ],
      settings: fixtureSettings,
      notificationSummary: fixtureSummary,
      recentNotificationReceipts: fixtureReceipts,
    };

    fixtureClient = {
      getMainChatOverview: vi.fn(async () => ({
        requestId: "req_ov",
        overview: fixtureOverview,
        error: null,
      })),
      switchMainChatModelProfile: vi.fn(async () => ({
        requestId: "req_sw",
        settings: fixtureSettings,
        activeProfileId: "balanced",
        changedSlots: [],
        event: null,
        error: null,
      })),
      retryMainChatTaskWithFallback: vi.fn(async () => ({
        requestId: "req_retry",
        task: tasks[0]!,
        previousAgentId: "agent_w4_failed",
        newAgentId: "agent_w4_retry_2",
        fromModelSpec: "claude/claude-opus-4-6",
        toModelSpec: "codex/gpt-5.3-codex",
        fallbackEvent: null,
        error: null,
      })),
      listMainChatNotificationReceipts: vi.fn(async () => ({
        requestId: "req_list_rec",
        receipts: fixtureReceipts,
        summary: fixtureSummary,
        error: null,
      })),
      ackMainChatNotificationReceipt: vi.fn(async () => ({
        requestId: "req_ack_rec",
        updatedCount: 1,
        summary: { ...fixtureSummary, unreadCount: 1 },
        error: null,
      })),
    } as unknown as DaemonClient;

    const now = new Date("2026-11-25T05:55:00.000Z");
    const makeAgent = (id: string, title: string, status: string, labels: Record<string, string>) =>
      ({
        id,
        serverId: "srv_1",
        workspaceId: "ws_paseo",
        provider: "claude",
        status,
        cwd: "/data00/repo/paseo-fork",
        title,
        createdAt: now,
        updatedAt: now,
        requiresAttention: status === "error",
        attentionReason: null,
        labels,
        pendingPermissions: [],
        turn: { phase: "idle" as const },
      }) as unknown as Agent;

    useSessionStore.setState({
      sessions: {
        srv_1: {
          client: fixtureClient,
          agents: new Map([
            [
              "agent_main",
              makeAgent("agent_main", "总控主对话", "idle", {
                [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE,
              }),
            ],
            ["agent_w4_failed", makeAgent("agent_w4_failed", tasks[0]!.title, "error", {})],
            ["agent_w4_rwr", makeAgent("agent_w4_rwr", tasks[1]!.title, "idle", {})],
            ["agent_w4_wrap", makeAgent("agent_w4_wrap", tasks[2]!.title, "idle", {})],
          ]),
          agentDetails: new Map(),
          workspaces: new Map(),
          pendingPermissions: new Map(),
        } as unknown as SessionState,
      },
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_1", "agent_main")]: fixtureOverview,
      },
      decisionsByKey: {},
      settingsProposalsByKey: {},
      activeAgentOverrideByServerId: {},
    });
    useMainChatSettingsStore.setState({
      settingsByServerId: { srv_1: fixtureSettings },
      nightModeStatusByServerId: {},
      cacheKeepaliveStatusByServerId: {},
      notificationSummaryByServerId: { srv_1: fixtureSummary },
      usageByServerId: {},
      usageLoadingByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: {},
      expandedByKey: {},
      focusedNeedsIdByKey: {},
      compactDockCollapsedByKey: {},
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    UnistylesRuntime.setTheme("light");
  });

  function renderInBrowser(node: ReactElement): void {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <KeyboardActionDispatcherProvider>
            <ToastApiProvider api={browserToastApi}>{node}</ToastApiProvider>
          </KeyboardActionDispatcherProvider>
        </QueryClientProvider>,
      );
    });
  }

  async function waitForLayoutFrame(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    });
  }

  function assertNoHorizontalOverflow(container: HTMLElement, label: string): void {
    expect(
      container.scrollWidth,
      `${label} must not horizontally overflow (scrollWidth=${container.scrollWidth}, clientWidth=${container.clientWidth})`,
    ).toBeLessThanOrEqual(container.clientWidth + 1);
    const containerRect = container.getBoundingClientRect();
    const interactive = container.querySelectorAll<HTMLElement>(
      "input, textarea, button, [role='button'], [role='switch']",
    );
    for (const el of interactive) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      expect(
        rect.right,
        `${label} child ${el.getAttribute("data-testid") ?? el.tagName} right (${rect.right}) exceeds container right (${containerRect.right})`,
      ).toBeLessThanOrEqual(containerRect.right + 1);
    }
  }

  function assertEdgeAligned(label: string, target: HTMLElement | null, baseline: DOMRect): void {
    expect(target, `${label} must exist`).toBeTruthy();
    const rect = target!.getBoundingClientRect();
    expect(
      Math.abs(rect.left - baseline.left),
      `${label} left (${rect.left}) must align with baseline (${baseline.left}) within 1px`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(rect.right - baseline.right),
      `${label} right (${rect.right}) must align with baseline (${baseline.right}) within 1px`,
    ).toBeLessThanOrEqual(1);
    expect(rect.width).toBeGreaterThan(200);
  }

  it("01: renders wide 1440x900 light Settings -> Model Profiles & Notification Policy cleanly with zero overflow", async () => {
    await page.viewport(1440, 900);

    renderInBrowser(
      <View style={sceneStyles.settingsDualGrid} testID="wave4-settings-shell">
        <View style={sceneStyles.settingsCol}>
          <SettingsSection
            title="模型槽位与性能档位"
            info="按用途分层绑定模型，支持性能/平衡/经济档位一键原子切换与回滚。"
            testID="settings-main-chat-model-profiles"
          >
            <MainChatModelProfilesPanel
              serverId="srv_1"
              client={fixtureClient}
              settings={fixtureSettings}
              onApplyPatch={noopFn}
            />
          </SettingsSection>
        </View>
        <View style={sceneStyles.settingsCol}>
          <SettingsSection
            title="通知分级与低打扰"
            info="关键事件始终强制穿透低打扰模式；所有投递与折叠均落盘回执账本。"
            testID="settings-main-chat-notification-policy"
          >
            <MainChatNotificationPolicyPanel
              serverId="srv_1"
              client={fixtureClient}
              settings={fixtureSettings}
              initialReceipts={fixtureReceipts}
              initialSummary={fixtureSummary}
              onApplyPatch={noopFn}
            />
          </SettingsSection>
        </View>
      </View>,
    );
    await waitForLayoutFrame();

    expect(
      host.querySelector('[data-testid="settings-main-chat-model-profiles-panel"]'),
    ).toBeTruthy();
    expect(host.querySelector('[data-testid="model-profiles-rollback-btn"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="settings-main-chat-notification-policy-panel"]'),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="notify-category-passthrough-permission_approval"]'),
    ).toBeTruthy();
    expect(host.querySelector('[data-testid="notify-receipt-row-nrec_w4_1"]')).toBeTruthy();

    const shell = host.querySelector<HTMLElement>('[data-testid="wave4-settings-shell"]')!;
    expect(shell.textContent).not.toContain("mainChat.");
    assertNoHorizontalOverflow(
      shell,
      "Wide 1440x900 Settings Model Profiles & Notification Policy",
    );

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-wide-settings-profiles-and-notify.png`,
      element: shell,
    });
  });

  it("02: renders wide 1440x900 light Failed-Task 1-Click Retry, Zero-Token Diagnostic Badges, and <= 1px aligned Main Chat rail", async () => {
    await page.viewport(1440, 900);
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "needsYou" },
    });

    renderInBrowser(<Wave4MainChatSplitScene tasks={fixtureOverview.tasks ?? []} showDrawer />);
    await waitForLayoutFrame();

    expect(host.querySelector('[data-testid="main-chat-action-panel-needsYou"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="main-chat-action-retry-fallback-task_w4_failed"]'),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="main-chat-action-needs-rule-badge-task:task_w4_failed"]'),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="main-chat-action-needs-rule-badge-task:task_w4_rwr"]'),
    ).toBeTruthy();
    expect(host.querySelector('[data-testid="main-chat-task-drawer-retry-fallback"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="main-chat-task-drawer-rule-badge-tool_loop"]'),
    ).toBeTruthy();

    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="wave4-composer-baseline"]')!
      .getBoundingClientRect();
    const messageEl = host.querySelector<HTMLElement>('[data-testid="wave4-message-column"]');
    const actionInner = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-inner"]',
    );
    const drawerFrame = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-drawer-frame"]',
    );

    assertEdgeAligned("Wide Message column vs Composer", messageEl, composerBaseline);
    assertEdgeAligned("Wide ActionBar inner vs Composer", actionInner, composerBaseline);
    assertEdgeAligned("Wide ActionBar drawer frame vs Composer", drawerFrame, composerBaseline);

    const scene = host.querySelector<HTMLElement>('[data-testid="wave4-main-scene"]')!;
    assertNoHorizontalOverflow(scene, "Wide 1440x900 Task Retry & Zero-Token Rules");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-wide-task-retry-and-rules.png`,
    });
  });

  it("03: renders narrow 390x844 light Wave 4 composite with zero overflow and <= 1px rail alignment", async () => {
    await page.viewport(390, 844);

    renderInBrowser(
      <View style={sceneStyles.narrowComposite} testID="wave4-narrow-composite">
        <Wave4MainChatSplitScene tasks={fixtureOverview.tasks ?? []} showDrawer={false} compact />
        <View style={sceneStyles.narrowPanelWrap}>
          <SettingsSection title="模型槽位与性能档位" testID="narrow-model-profiles">
            <MainChatModelProfilesPanel
              serverId="srv_1"
              client={fixtureClient}
              settings={fixtureSettings}
              onApplyPatch={noopFn}
            />
          </SettingsSection>
        </View>
      </View>,
    );
    await waitForLayoutFrame();

    // CompactStatusDock is intentionally removed; only clean status capsules remain above the composer
    expect(host.querySelector('[data-testid="main-chat-compact-dock"]')).toBeNull();
    expect(host.querySelector('[data-testid="main-chat-action-capsule-needsYou"]')).toBeTruthy();

    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="wave4-composer-baseline"]')!
      .getBoundingClientRect();
    const messageEl = host.querySelector<HTMLElement>('[data-testid="wave4-message-column"]');
    const actionInner = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-inner"]',
    );

    assertEdgeAligned("Narrow 390 Message column vs Composer", messageEl, composerBaseline);
    assertEdgeAligned("Narrow 390 ActionBar inner vs Composer", actionInner, composerBaseline);

    const composite = host.querySelector<HTMLElement>('[data-testid="wave4-narrow-composite"]')!;
    assertNoHorizontalOverflow(composite, "Narrow 390x844 Wave 4 Composite");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-narrow-390-wave4.png`,
      element: composite,
    });
  });

  it("04: renders wide 1440x900 dark Wave 4 view cleanly with zero overflow and <= 1px rail alignment", async () => {
    await page.viewport(1440, 900);
    UnistylesRuntime.setTheme("dark");
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "awaitingReview" },
    });

    renderInBrowser(
      <View style={sceneStyles.darkRoot} testID="wave4-dark-root">
        <Wave4MainChatSplitScene tasks={fixtureOverview.tasks ?? []} showDrawer />
      </View>,
    );
    await waitForLayoutFrame();

    expect(
      host.querySelector('[data-testid="main-chat-action-panel-awaitingReview"]'),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="main-chat-action-task-rule-badge-task:task_w4_wrap"]'),
    ).toBeTruthy();
    expect(host.querySelector('[data-testid="main-chat-task-drawer-retry-fallback"]')).toBeTruthy();

    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="wave4-composer-baseline"]')!
      .getBoundingClientRect();
    const messageEl = host.querySelector<HTMLElement>('[data-testid="wave4-message-column"]');
    const actionInner = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-inner"]',
    );
    const drawerFrame = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-drawer-frame"]',
    );

    assertEdgeAligned("Dark Message column vs Composer", messageEl, composerBaseline);
    assertEdgeAligned("Dark ActionBar inner vs Composer", actionInner, composerBaseline);
    assertEdgeAligned("Dark ActionBar drawer frame vs Composer", drawerFrame, composerBaseline);

    const darkRoot = host.querySelector<HTMLElement>('[data-testid="wave4-dark-root"]')!;
    assertNoHorizontalOverflow(darkRoot, "Wide 1440x900 Dark Wave 4");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-wide-dark-wave4.png`,
    });
  });
});

const sceneStyles = StyleSheet.create((theme) => ({
  settingsDualGrid: {
    width: "100%",
    minHeight: 900,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  settingsCol: {
    flex: 1,
    minWidth: 0,
  },
  darkRoot: {
    width: "100%",
    minHeight: 900,
    backgroundColor: theme.colors.surface0,
  },
  wideMainScene: {
    width: "100%",
    height: 900,
    flexDirection: "row",
    backgroundColor: theme.colors.surface0,
  },
  narrowComposite: {
    width: "100%",
    backgroundColor: theme.colors.surface0,
  },
  narrowMainScene: {
    width: "100%",
    height: 320,
    flexDirection: "column",
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  narrowPanelWrap: {
    padding: theme.spacing[3],
    gap: theme.spacing[3],
  },
  mainChatColumn: {
    flex: 1,
    minWidth: 0,
    height: "100%",
  },
  streamSurface: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    backgroundColor: theme.colors.surface0,
  },
  streamTranscriptOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
  },
  streamTranscript: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  messageBubble: {
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[1.5],
  },
  messageHeading: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  messageBody: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  bottomStack: {
    width: "100%",
    backgroundColor: theme.colors.surface0,
  },
  composerOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    paddingTop: theme.spacing[1],
  },
  composerInner: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  composerPlaceholder: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  drawerPanel: {
    width: 440,
    height: "100%",
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  drawerHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    gap: theme.spacing[0.5],
  },
  drawerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  drawerSubtitle: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  drawerAgentPreview: {
    padding: theme.spacing[3],
    gap: theme.spacing[1.5],
  },
  drawerPreviewHeading: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  drawerPreviewBody: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
}));
