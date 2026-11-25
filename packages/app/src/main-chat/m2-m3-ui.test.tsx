// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_FORMER_ROLE_VALUE,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  type MainChatActivityEntry,
  type MainChatCompactionState,
  type MainChatDecisionRecord,
  type MainChatOverview,
  type MainChatPlanRecord,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React, { type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import {
  MainChatActionBar,
  MainChatActionBarDrawerOverlay,
  useMainChatActionBarDrawerStore,
} from "./action-bar";
import { STALE_IN_PROGRESS_THRESHOLD_MS } from "./action-bar-model";
import {
  MainChatCompactionBanner,
  computeCompactionUsageRatio,
  shouldShowCompactionBanner,
} from "./compaction-banner";
import { useMainChatDrawerStore } from "./drawer-store";
import { MainChatHandoffCard } from "./handoff-card";
import { MainChatHistoryScreen, filterMainChatActivityEntries } from "./history-screen";
import { MainChatLifecycleConfirmModal, useMainChatLifecycleActions } from "./lifecycle-actions";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { MainChatPlanCard } from "./plan-card";
import { useMainChatPlanStore } from "./plan-store";
import { routeStoreKey, useMainChatRouteStore } from "./route-store";
import { useMainChatSettingsStore } from "./settings-store";
import { MainChatShellProvider } from "./shell-context";
import { renderMainChatInlineToolCard } from "./stream-card";
import {
  TaskPanelDrawer,
  buildTaskDrawerAgentTabs,
  resolveTaskRecordForDrawer,
} from "./task-panel-drawer";

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockPathname = vi.hoisted(() => ({ value: "/main" }));
const mockNavigateToAgent = vi.hoisted(() => vi.fn());
const mockNavigateToWorkspace = vi.hoisted(() => vi.fn());
const mockHosts = vi.hoisted(() => [{ serverId: "srv_1", label: "DevBox" }]);

vi.mock("expo-router", () => ({
  router: {
    push: mockRouterPush,
    replace: vi.fn(),
    navigate: vi.fn(),
  },
  usePathname: () => mockPathname.value,
}));

vi.mock("expo-router/react-navigation", () => ({
  useIsFocused: () => true,
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key,
      i18n: { language: "zh-CN" },
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

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHosts,
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useLastWorkspaceSelection: () => ({ serverId: "srv_1", workspaceId: "ws_repo" }),
  navigateToWorkspace: mockNavigateToWorkspace,
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: mockNavigateToAgent,
}));

vi.mock("@/components/desktop/titlebar-drag-region", () => ({
  TitlebarDragRegion: () => null,
}));

vi.mock("@/components/headers/sidebar-menu-toggle", () => ({
  SidebarMenuToggle: () => null,
}));

vi.mock("@/utils/desktop-window", () => ({
  WindowChromeSafeArea: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("@/components/retained-panel", () => ({
  RetainedPanelActivity: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("./agent-host", () => ({
  MainChatAgentHost: ({ serverId, agentId }: { serverId: string; agentId: string }) =>
    React.createElement(
      "div",
      { "data-testid": `mock-agent-host-${serverId}:${agentId}` },
      `AgentHost:${agentId}`,
    ),
}));

vi.mock("@/git/diff-pane", () => ({
  ChangesSurface: ({ workspaceId, cwd }: { workspaceId: string; cwd: string }) =>
    React.createElement(
      "div",
      { "data-testid": "mock-changes-surface" },
      `Diff:${workspaceId}:${cwd}`,
    ),
}));

vi.mock("@/components/terminal-pane", () => ({
  TerminalPane: ({ terminalId, cwd }: { terminalId: string; cwd: string }) =>
    React.createElement(
      "div",
      { "data-testid": `mock-terminal-pane-${terminalId}` },
      `Terminal:${terminalId}:${cwd}`,
    ),
}));

vi.mock("@/agent-stream/view", () => ({
  PermissionRequestCard: ({
    permission,
  }: {
    permission: { request: { id: string; title?: string } };
  }) =>
    React.createElement(
      "div",
      { "data-testid": `mock-permission-card-${permission.request.id}` },
      permission.request.title ?? permission.request.id,
    ),
}));

vi.mock("lucide-react-native", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const StubIcon = () => null;
  const iconNames = [
    "AlertTriangle",
    "ArrowLeft",
    "ArrowUpRight",
    "CheckCircle2",
    "CheckSquare",
    "ChevronDown",
    "ChevronRight",
    "CircleAlert",
    "Clock",
    "Compass",
    "CornerDownRight",
    "Ellipsis",
    "Eraser",
    "FileDiff",
    "FolderGit2",
    "HelpCircle",
    "History",
    "Layers",
    "Maximize2",
    "MessageSquare",
    "MessageSquarePlus",
    "Minimize2",
    "PanelRight",
    "Pause",
    "Pencil",
    "Play",
    "Plus",
    "Radar",
    "RefreshCw",
    "RotateCcw",
    "Settings",
    "Shield",
    "ShieldCheck",
    "Sparkles",
    "Square",
    "Terminal",
    "X",
    "Zap",
  ];
  const mocked: Record<string, unknown> = { ...actual };
  for (const name of iconNames) {
    mocked[name] = actual[name] ?? StubIcon;
  }
  return mocked;
});

const toastShowSpy = vi.fn(() => () => undefined);
const toastErrorSpy = vi.fn(() => () => undefined);
const toastApi: ComponentProps<typeof ToastApiProvider>["api"] = {
  show: toastShowSpy,
  error: toastErrorSpy,
  copied: () => () => undefined,
};

function makeAgent(partial: Partial<Agent> & { id: string; serverId: string }): Agent {
  return {
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-23T08:00:00.000Z"),
    updatedAt: new Date("2026-11-23T08:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-23T08:00:00.000Z"),
    capabilities: {} as Agent["capabilities"],
    currentModeId: "default",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: partial.id,
    cwd: "/repo/app",
    workspaceId: "ws_repo",
    model: "claude-sonnet-5-5",
    parentAgentId: null,
    labels: {},
    ...partial,
  };
}

function makeTask(
  overrides: Partial<MainChatTaskRecord> & {
    id: string;
    title: string;
    status: MainChatTaskRecord["status"];
  },
): MainChatTaskRecord {
  const { id, title, status, ...rest } = overrides;
  const nowIso = new Date().toISOString();
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
      goal: `Goal: ${title}`,
      doneWhen: ["All unit tests green", "Lint passes"],
      outOfBounds: ["Do not push"],
      scopeRevision: 2,
      updatedAt: nowIso,
    },
    agentIds: ["child_1"],
    activeAgentId: "child_1",
    expectedMinutes: 15,
    lastActivityAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    ...rest,
  };
}

function makeOpenPlan(overrides: Partial<MainChatPlanRecord> = {}): MainChatPlanRecord {
  return {
    id: "plan_1",
    mainAgentId: "agent_main",
    status: "open",
    autoStarted: false,
    summary: "拆分前后端验证任务",
    createdAt: new Date().toISOString(),
    startedAt: null,
    cancelledAt: null,
    tasks: [
      {
        id: "pt_1",
        title: "修复状态托盘",
        goal: "实现五态去重视图",
        mode: "write",
        isolation: "worktree",
        serverId: "srv_1",
        hostLabel: "DevBox",
        cwd: "/repo/app",
        workspaceId: "ws_repo",
        workspaceLabel: "app",
        reason: "M3 需求",
        doneWhen: ["单测全过"],
        outOfBounds: ["不改协议层"],
        provider: "claude",
        modeId: null,
        thinkingOptionId: null,
        branchName: "feat/action-bar",
        baseBranch: "main",
        agentId: null,
        startedAt: null,
        startError: null,
        continuesTaskId: "task_prev_1",
        continuesWhy: "延续上一轮重构",
        expectedMinutes: 20,
        scopeRevision: 2,
      },
    ],
    ...overrides,
  };
}

function makeOverview(partial: Partial<MainChatOverview> = {}): MainChatOverview {
  return {
    plans: [],
    decisions: [],
    autoStartRules: [],
    permissionRules: [],
    metrics: {
      autoContinued: 1,
      plansCreated: 2,
      plansAutoStarted: 0,
      plansStarted: 1,
      plansCancelled: 0,
      receiptsRecorded: 1,
      interrupts: 0,
      supervisorHeld: 2,
      reworkCount: 0,
      stalledNudges: 0,
      usageLimitRetries: 0,
    },
    tasks: [],
    triages: [],
    ...partial,
  };
}

function makeFakeClient(
  overrides: Partial<Record<keyof DaemonClient, unknown>> = {},
): DaemonClient {
  const defaults = createDefaultMainChatSettings("conservative");
  return {
    ensureMainChat: vi.fn(async () => ({
      requestId: "r1",
      agentId: "agent_main",
      workspaceId: "ws_main",
      created: false,
      error: null,
    })),
    getMainChatSettings: vi.fn(async () => ({ settings: defaults, error: null })),
    updateMainChatSettings: vi.fn(async (patch) => ({
      settings: { ...defaults, ...patch },
      error: null,
    })),
    getMainChatOverview: vi.fn(async () => ({
      requestId: "r2",
      overview: makeOverview(),
      error: null,
    })),
    listMainChatPlans: vi.fn(async () => ({ requestId: "r3", plans: [], error: null })),
    startMainChatPlan: vi.fn(async (planId: string) => ({
      requestId: "r4",
      plan: makeOpenPlan({ id: planId, status: "started" }),
      error: null,
    })),
    updateMainChatPlanTask: vi.fn(async (planId: string, taskId: string, patch) => {
      const base = makeOpenPlan({ id: planId });
      const tasks = [];
      for (const item of base.tasks) {
        tasks.push(item.id === taskId ? { ...item, ...patch } : item);
      }
      return {
        requestId: "r5",
        plan: {
          ...base,
          tasks,
        },
        error: null,
      };
    }),
    cancelMainChatPlan: vi.fn(async (planId: string) => ({
      requestId: "r6",
      plan: makeOpenPlan({ id: planId, status: "cancelled" }),
      error: null,
    })),
    answerMainChatDecision: vi.fn(
      async (input: { decisionId: string; optionId?: string; answer: string }) => ({
        requestId: "r7",
        decision: {
          id: input.decisionId,
          mainAgentId: "agent_main",
          title: "架构选型",
          question: "使用哪种方案？",
          agentId: "child_dec",
          planId: null,
          taskId: null,
          options: [{ id: "opt_1", label: input.answer, leadsTo: "继续推进" }],
          recommendedOptionId: "opt_1",
          reason: null,
          answer: input.answer,
          answeredOptionId: input.optionId ?? null,
          answeredAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
        },
        error: null,
      }),
    ),
    compactMainChat: vi.fn(async () => ({
      requestId: "r8",
      mainAgentId: "agent_main",
      compaction: {
        status: "succeeded",
        estimatedTokens: 24_000,
        thresholdTokens: 100_000,
        lastCompactedAt: new Date().toISOString(),
        lastError: null,
        summary: "已压缩上下文至 24k tokens",
      },
      error: null,
    })),
    clearMainChat: vi.fn(async () => ({
      requestId: "r9",
      previousAgentId: "agent_main",
      agentId: "agent_main_v2",
      workspaceId: "ws_main",
      migratedPlans: 1,
      migratedDecisions: 0,
      migratedChildAgents: 2,
      error: null,
    })),
    startNewMainChatSession: vi.fn(async () => ({
      requestId: "r10",
      previousAgentId: "agent_main",
      agentId: "agent_main_v3",
      workspaceId: "ws_main",
      handoffSummary: "交接摘要：2 个进行中任务",
      migratedPlans: 1,
      migratedDecisions: 0,
      migratedChildAgents: 2,
      error: null,
    })),
    listMainChatActivity: vi.fn(async () => ({
      requestId: "r11",
      activities: [],
      total: 0,
      error: null,
    })),
    parkMainChatTask: vi.fn(async (input: { taskId: string; parked: boolean }) => ({
      requestId: "r12",
      task: makeTask({
        id: input.taskId,
        title: "测试任务",
        status: input.parked ? "parked" : "running",
      }),
      error: null,
    })),
    reviewMainChatTask: vi.fn(async (input: { taskId: string; verdict: "accept" | "rework" }) => ({
      requestId: "r13",
      task: makeTask({
        id: input.taskId,
        title: "待验收任务",
        status: input.verdict === "accept" ? "completed" : "running",
      }),
      receipt: null,
      rework: null,
      error: null,
    })),
    listTerminals: vi.fn(async () => ({
      terminals: [{ id: "term_1", name: "zsh", title: "Dev shell", cwd: "/repo/app" }],
    })),
    createTerminal: vi.fn(async () => ({
      terminal: { id: "term_new", name: "zsh", title: "New shell", cwd: "/repo/app" },
      error: null,
    })),
    ...overrides,
  } as unknown as DaemonClient;
}

function seedSession(client: DaemonClient, agents: Agent[] = []) {
  const mainAgent = makeAgent({
    id: "agent_main",
    serverId: "srv_1",
    workspaceId: "ws_main",
    title: "对话管理",
    labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
  });
  const allAgents = [mainAgent, ...agents];
  const session: SessionState = {
    client,
    serverInfo: {
      serverId: "srv_1",
      hostname: "devbox",
      version: "0.17.512",
      features: { mainChat: true },
    } as unknown as SessionState["serverInfo"],
    agents: new Map(allAgents.map((a) => [a.id, a])),
    agentDetails: new Map(),
    workspaces: new Map(),
    projects: new Map(),
    pendingPermissions: new Map(),
    agentTasks: new Map(),
    agentTimelineTail: new Map(),
    agentTimelineHead: new Map(),
    agentTimelineSync: new Map(),
    viewedTimelineSync: {
      replaceVisibleAgentIds: vi.fn(),
    } as unknown as SessionState["viewedTimelineSync"],
    focusedAgentId: null,
  } as unknown as SessionState;

  useSessionStore.setState({
    sessions: { srv_1: session },
    agentLastActivity: new Map(),
  });
}

const SHELL_CONTEXT_VALUE = {
  inMainChatShell: true,
  originRoute: "/main",
  originTitle: "对话管理",
} as const;

const BELOW_80_WINDOW_COMPACTION: MainChatCompactionState = {
  status: "idle",
  estimatedTokens: 750_000,
  thresholdTokens: 800_000,
  contextWindowMaxTokens: 1_000_000,
  autoCompactEnabled: true,
  lastCompactedAt: null,
  lastError: null,
  summary: null,
};

const DRAWER_MULTI_AGENT_TARGET = {
  serverId: "srv_1",
  agentId: "child_v2",
  workspaceId: "ws_repo",
  title: "多 Agent 续接任务",
  taskId: "task_drawer",
} as const;

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <ToastApiProvider api={toastApi}>
      <MainChatShellProvider value={SHELL_CONTEXT_VALUE}>{ui}</MainChatShellProvider>
    </ToastApiProvider>,
  );
}

describe("Main Chat M2 & M3 UI components", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    if (!HTMLElement.prototype.animate) {
      HTMLElement.prototype.animate = vi.fn(
        () =>
          ({
            startTime: 0,
            cancel: vi.fn(),
          }) as unknown as Animation,
      );
    }
    toastShowSpy.mockClear();
    toastErrorSpy.mockClear();
    mockRouterPush.mockClear();
    mockNavigateToAgent.mockClear();
    useMainChatDrawerStore.getState().reset();
    useMainChatPlanStore.setState({ plansByKey: {}, loadedAgents: {} });
    useMainChatOverviewStore.setState({
      overviewsByKey: {},
      decisionsByKey: {},
      activeAgentOverrideByServerId: {},
    });
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
  });

  afterEach(() => {
    cleanup();
    useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
    vi.unstubAllGlobals();
  });

  it("renders MainChatCompactionBanner at >=80% real model window, exposes auto-compact toggle, and invokes compactMainChat", async () => {
    const client = makeFakeClient();
    seedSession(client);

    // 750k / 1M (75% < 80%) MUST remain hidden even though it exceeds the legacy 400k cap.
    expect(computeCompactionUsageRatio(BELOW_80_WINDOW_COMPACTION)).toBeCloseTo(0.75, 2);
    expect(shouldShowCompactionBanner(BELOW_80_WINDOW_COMPACTION)).toBe(false);

    const hiddenView = renderWithProviders(
      <MainChatCompactionBanner
        serverId="srv_1"
        mainAgentId="agent_main"
        compactionOverride={BELOW_80_WINDOW_COMPACTION}
      />,
    );
    expect(hiddenView.queryByTestId("main-chat-compaction-banner")).toBeNull();
    hiddenView.unmount();

    // 820k / 1M (82% >= 80%) renders banner with real window limit, percentage, auto toggle, and compact button.
    const highUsage: MainChatCompactionState = {
      status: "idle",
      estimatedTokens: 820_000,
      thresholdTokens: 800_000,
      contextWindowMaxTokens: 1_000_000,
      autoCompactEnabled: true,
      lastCompactedAt: "2026-11-23T11:30:00.000Z",
      lastError: null,
      summary: null,
    };
    const highUsageClient = makeFakeClient({
      getMainChatOverview: vi.fn(async () => ({
        requestId: "r_high",
        overview: makeOverview({ compaction: highUsage }),
        error: null,
      })),
    });
    seedSession(highUsageClient);
    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_1", "agent_main")]: makeOverview({ compaction: highUsage }),
      },
    });

    const view = renderWithProviders(
      <MainChatCompactionBanner serverId="srv_1" mainAgentId="agent_main" />,
    );
    expect(view.getByTestId("main-chat-compaction-banner")).toBeTruthy();
    expect(view.getByTestId("main-chat-compaction-headline").textContent).toContain("82");
    expect(view.getByTestId("main-chat-compaction-meta").textContent).toContain("1M");

    // Toggle auto-compaction switch on the right side of the banner.
    fireEvent.click(view.getByTestId("main-chat-compaction-auto-toggle"));
    await waitFor(() => {
      expect(highUsageClient.updateMainChatSettings).toHaveBeenCalledWith({
        autoCompactEnabled: false,
      });
    });

    // Manual compaction button remains available side by side.
    fireEvent.click(view.getByTestId("main-chat-compaction-action"));
    await waitFor(() => {
      expect(highUsageClient.compactMainChat).toHaveBeenCalledWith({
        mainAgentId: "agent_main",
        reason: "manual",
      });
    });
    expect(toastShowSpy).toHaveBeenCalled();
  });

  it("executes M2 lifecycle /clear and startNewMainChatSession with confirmation and updates active override", async () => {
    const client = makeFakeClient();
    seedSession(client);

    function LifecycleHarness() {
      const lifecycle = useMainChatLifecycleActions({
        serverId: "srv_1",
        client,
        mainAgentId: "agent_main",
      });
      return (
        <div>
          <button type="button" data-testid="btn-clear" onClick={lifecycle.requestClear}>
            clear
          </button>
          <button type="button" data-testid="btn-new" onClick={lifecycle.requestNewSession}>
            new
          </button>
          <MainChatLifecycleConfirmModal
            confirmKind={lifecycle.confirmKind}
            busy={lifecycle.busyAction !== null}
            onCancel={lifecycle.cancelConfirm}
            onConfirm={lifecycle.confirmPendingAction}
          />
        </div>
      );
    }

    const view = renderWithProviders(<LifecycleHarness />);

    // 1. Trigger /clear -> confirmation modal -> confirm
    fireEvent.click(view.getByTestId("btn-clear"));
    expect(view.getByTestId("main-chat-lifecycle-modal-clear")).toBeTruthy();
    fireEvent.click(view.getByTestId("main-chat-lifecycle-confirm"));

    await waitFor(() => {
      expect(client.clearMainChat).toHaveBeenCalledWith({ mainAgentId: "agent_main" });
    });
    expect(useMainChatOverviewStore.getState().activeAgentOverrideByServerId.srv_1?.agentId).toBe(
      "agent_main_v2",
    );

    // 2. Trigger New main chat (with handoff) -> confirmation modal -> confirm
    fireEvent.click(view.getByTestId("btn-new"));
    expect(view.getByTestId("main-chat-lifecycle-modal-new_session")).toBeTruthy();
    fireEvent.click(view.getByTestId("main-chat-lifecycle-confirm"));

    await waitFor(() => {
      expect(client.startNewMainChatSession).toHaveBeenCalledWith({
        mainAgentId: "agent_main",
        carryHandoffSummary: true,
      });
    });
    expect(useMainChatOverviewStore.getState().activeAgentOverrideByServerId.srv_1?.agentId).toBe(
      "agent_main_v3",
    );
  });

  it("renders /main/history dual tabs with former archived main chat and filterable activity audit log", async () => {
    const activities: MainChatActivityEntry[] = [
      {
        id: "act_silent",
        mainAgentId: "agent_main",
        kind: "silent_turn",
        trigger: "patrol_timer",
        summary: "定时静默巡检完成",
        silent: true,
        status: "completed",
        createdAt: "2026-11-23T11:00:00.000Z",
        completedAt: "2026-11-23T11:00:02.000Z",
        detail: "扫描 4 个活跃会话，均正常推进。",
      },
      {
        id: "act_preempt",
        mainAgentId: "agent_main",
        kind: "preempted",
        trigger: "supervisor_wakeup",
        summary: "后台督办被用户消息抢占",
        silent: false,
        status: "preempted",
        preemptedByUser: true,
        createdAt: "2026-11-23T11:05:00.000Z",
        completedAt: "2026-11-23T11:05:01.000Z",
        detail: "前台消息优先响应。",
      },
    ];
    const client = makeFakeClient({
      listMainChatActivity: vi.fn(async () => ({
        requestId: "r_act",
        activities,
        total: activities.length,
        error: null,
      })),
    });

    const archivedFormerMain = makeAgent({
      id: "agent_main_old",
      serverId: "srv_1",
      workspaceId: "ws_main",
      title: "昨日主对话",
      archivedAt: new Date("2026-11-22T23:00:00.000Z"),
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_FORMER_ROLE_VALUE },
    });
    seedSession(client, [archivedFormerMain]);

    const view = renderWithProviders(<MainChatHistoryScreen />);

    // Conversations tab includes both active main chat and archived former main chat
    expect(view.getByTestId("main-chat-history-conv-agent_main")).toBeTruthy();
    expect(view.getByTestId("main-chat-history-conv-agent_main_old")).toBeTruthy();

    // Switch to Background Activity Audit tab
    fireEvent.click(view.getByTestId("main-chat-history-tab-activity"));
    await waitFor(() => {
      expect(client.listMainChatActivity).toHaveBeenCalledWith({
        mainAgentId: "agent_main",
        includeSilent: true,
        limit: 100,
      });
    });

    expect(view.getByTestId("main-chat-activity-entry-act_silent")).toBeTruthy();
    expect(view.getByTestId("main-chat-activity-entry-act_preempt")).toBeTruthy();

    // Expand details on act_silent
    fireEvent.click(view.getByTestId("main-chat-activity-toggle-act_silent"));
    expect(view.getByTestId("main-chat-activity-detail-act_silent").textContent).toContain(
      "扫描 4 个活跃会话",
    );

    // Filter to Preempted only
    fireEvent.click(view.getByTestId("main-chat-activity-filter-preempted"));
    expect(view.queryByTestId("main-chat-activity-entry-act_silent")).toBeNull();
    expect(view.getByTestId("main-chat-activity-entry-act_preempt")).toBeTruthy();

    // Manual refresh triggers listMainChatActivity again
    fireEvent.click(view.getByTestId("main-chat-activity-refresh"));
    await waitFor(() => {
      expect(client.listMainChatActivity).toHaveBeenCalledTimes(2);
    });
  });

  it("prioritizes settings.title over stale underlying main agent.title in /main/history", async () => {
    const client = makeFakeClient({
      getMainChatSettings: vi.fn(async () => ({
        requestId: "r_settings",
        settings: {
          ...createDefaultMainChatSettings("conservative"),
          enabled: true,
          title: "对话管理",
        },
        error: null,
      })),
    });

    const staleMainAgent = makeAgent({
      id: "agent_main",
      serverId: "srv_1",
      workspaceId: "ws_main",
      title: "主对话",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    const archivedFormerMain = makeAgent({
      id: "agent_main_old",
      serverId: "srv_1",
      workspaceId: "ws_main",
      title: "昨日主对话",
      archivedAt: new Date("2026-11-22T23:00:00.000Z"),
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_FORMER_ROLE_VALUE },
    });

    seedSession(client, [staleMainAgent, archivedFormerMain]);
    useMainChatSettingsStore.setState({ settingsByServerId: {} });

    const view = renderWithProviders(<MainChatHistoryScreen />);

    await waitFor(() => {
      expect(client.getMainChatSettings).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(view.getByTestId("main-chat-history-conv-agent_main").textContent).toContain(
        "对话管理",
      );
    });
    expect(view.getByTestId("main-chat-history-conv-agent_main").textContent).not.toContain(
      "主对话",
    );
    // Archived former main chat preserves its own historical title
    expect(view.getByTestId("main-chat-history-conv-agent_main_old").textContent).toContain(
      "昨日主对话",
    );
  });

  it("supports inline PlanCard editing, rememberAutoStart checkbox, withdrawn state, and started HandoffCard convergence", async () => {
    const client = makeFakeClient();
    seedSession(client);

    const openPlan = makeOpenPlan();
    const view = renderWithProviders(
      <MainChatPlanCard serverId="srv_1" agentId="agent_main" plan={openPlan} />,
    );

    // Displays Brief metadata, continues info, expected minutes
    expect(view.getByTestId("main-chat-plan-continues-pt_1")).toBeTruthy();
    expect(view.container.textContent).toContain("briefRevisionBadge");
    expect(view.container.textContent).toContain("expectedMinutesShort");
    expect(view.container.textContent).toContain("不改协议层");

    // Inline edit task
    fireEvent.click(view.getByTestId("main-chat-plan-edit-open-pt_1"));
    expect(view.getByTestId("main-chat-plan-editor-pt_1")).toBeTruthy();
    fireEvent.change(view.getByTestId("main-chat-plan-edit-title-pt_1"), {
      target: { value: "修复五态去重托盘" },
    });
    fireEvent.change(view.getByTestId("main-chat-plan-edit-branch-pt_1"), {
      target: { value: "feat/m3-tray" },
    });
    fireEvent.click(view.getByTestId("main-chat-plan-edit-mode-readonly-pt_1"));
    fireEvent.click(view.getByTestId("main-chat-plan-edit-save-pt_1"));

    await waitFor(() => {
      expect(client.updateMainChatPlanTask).toHaveBeenCalledWith(
        "plan_1",
        "pt_1",
        expect.objectContaining({
          title: "修复五态去重托盘",
          mode: "readonly",
          branchName: "feat/m3-tray",
        }),
      );
    });

    // Toggle "remember similar auto-start" checkbox and click Start
    fireEvent.click(view.getByTestId("main-chat-plan-remember-checkbox-plan_1"));
    fireEvent.click(view.getByTestId("main-chat-plan-start-plan_1"));

    await waitFor(() => {
      expect(client.startMainChatPlan).toHaveBeenCalledWith("plan_1", {
        taskIds: undefined,
        rememberAutoStart: true,
      });
    });
    view.unmount();

    // Withdrawn plan renders compact collapsed reason
    const withdrawnPlan = makeOpenPlan({
      id: "plan_withdrawn",
      status: "withdrawn",
      withdrawReason: "需求已合并到现有任务",
    });
    const withdrawnView = renderWithProviders(
      <MainChatPlanCard serverId="srv_1" agentId="agent_main" plan={withdrawnPlan} />,
    );
    expect(withdrawnView.getByTestId("main-chat-plan-card-plan_withdrawn").textContent).toContain(
      "需求已合并到现有任务",
    );
    withdrawnView.unmount();

    // Started plan converges to compact deduplicated HandoffCard
    const startedPlan = makeOpenPlan({
      id: "plan_started",
      status: "started",
      tasks: [
        { ...openPlan.tasks[0]!, id: "pt_a", agentId: "child_handoff" },
        { ...openPlan.tasks[0]!, id: "pt_b", agentId: "child_handoff" },
      ],
    });
    const startedView = renderWithProviders(
      <MainChatPlanCard serverId="srv_1" agentId="agent_main" plan={startedPlan} />,
    );
    expect(startedView.getAllByTestId("main-chat-handoff-card-child_handoff")).toHaveLength(1);
  });

  it("opens TaskPanelDrawer on clicking MainChatHandoffCard", () => {
    const client = makeFakeClient();
    const child = makeAgent({
      id: "child_live",
      serverId: "srv_1",
      workspaceId: "ws_repo",
      title: "重构侧栏",
      status: "running",
      turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
    });
    seedSession(client, [child]);

    const view = renderWithProviders(
      <MainChatHandoffCard
        serverId="srv_1"
        agentId="child_live"
        title="重构侧栏"
        workspaceId="ws_repo"
        workspaceLabel="paseo-fork"
        mode="write"
        taskId="task_42"
        sourceKind="continuation"
      />,
    );

    fireEvent.click(view.getByTestId("main-chat-handoff-card-child_live"));
    expect(useMainChatDrawerStore.getState().activeTarget).toEqual({
      serverId: "srv_1",
      agentId: "child_live",
      workspaceId: "ws_repo",
      title: "重构侧栏",
      taskId: "task_42",
    });
  });

  it("renders MainChatActionBar five-state tray, expands Needs you inline without leaving, and supports park/resume/review", async () => {
    const decision: MainChatDecisionRecord = {
      id: "dec_inline",
      mainAgentId: "agent_main",
      title: "发布渠道确认",
      question: "先发 Beta 还是直接发 Stable？",
      agentId: "child_dec",
      planId: null,
      taskId: null,
      options: [{ id: "opt_beta", label: "先发 Beta", leadsTo: "执行 beta 流程" }],
      recommendedOptionId: "opt_beta",
      reason: "等待最终拍板",
      answer: null,
      answeredOptionId: null,
      answeredAt: null,
      createdAt: new Date().toISOString(),
    };

    const overview = makeOverview({
      decisions: [decision],
      tasks: [
        makeTask({
          id: "task_running",
          title: "活跃开发任务",
          status: "running",
          activeAgentId: "child_run",
          agentIds: ["child_run"],
        }),
        makeTask({
          id: "task_stale",
          title: "超 48h 搁置任务",
          status: "running",
          activeAgentId: "child_stale",
          agentIds: ["child_stale"],
          lastActivityAt: new Date(
            Date.now() - STALE_IN_PROGRESS_THRESHOLD_MS - 60_000,
          ).toISOString(),
        }),
        makeTask({
          id: "task_review",
          title: "待主对话验收任务",
          status: "awaiting_review",
          activeAgentId: "child_review",
          agentIds: ["child_review"],
        }),
        makeTask({
          id: "task_parked",
          title: "已暂停等待外部任务",
          status: "parked",
          activeAgentId: "child_parked",
          agentIds: ["child_parked"],
          parkedReason: "等外部接口",
        }),
        makeTask({
          id: "task_done",
          title: "刚刚完成的任务",
          status: "completed",
          activeAgentId: "child_done",
          agentIds: ["child_done"],
          completedAt: new Date().toISOString(),
        }),
      ],
    });

    const client = makeFakeClient({
      getMainChatOverview: vi.fn(async () => ({
        requestId: "r2",
        overview,
        error: null,
      })),
    });
    seedSession(client);

    useMainChatOverviewStore.setState({
      overviewsByKey: { [overviewStoreKey("srv_1", "agent_main")]: overview },
      decisionsByKey: { "srv_1:dec_inline": decision },
    });

    const view = renderWithProviders(<MainChatActionBar serverId="srv_1" agentId="agent_main" />);

    // All 5 capsules present; needsYou has count 1 (awaiting_review is strictly separate!)
    expect(view.getByTestId("main-chat-action-capsule-needsYou").textContent).toContain(
      '"count":1',
    );
    expect(view.getByTestId("main-chat-action-capsule-inProgress").textContent).toContain(
      '"count":2',
    );
    expect(view.getByTestId("main-chat-action-capsule-awaitingReview").textContent).toContain(
      '"count":1',
    );
    expect(view.getByTestId("main-chat-action-capsule-parked").textContent).toContain('"count":1');
    expect(view.getByTestId("main-chat-action-capsule-completed24h").textContent).toContain(
      '"count":1',
    );

    // Expand Needs you inline -> @ direct route sets target and closes drawer, then reopen & answer DecisionCard!
    useMainChatRouteStore.setState({ targetsByKey: {} });
    fireEvent.click(view.getByTestId("main-chat-action-capsule-needsYou"));
    fireEvent.click(view.getByTestId("main-chat-action-direct-decision:dec_inline"));
    expect(
      useMainChatRouteStore.getState().targetsByKey[routeStoreKey("srv_1", "agent_main")],
    ).toEqual({
      targetServerId: "srv_1",
      targetAgentId: "child_dec",
      targetTitle: "发布渠道确认",
    });
    expect(view.queryByTestId("main-chat-action-panel-needsYou")).toBeNull();

    fireEvent.click(view.getByTestId("main-chat-action-capsule-needsYou"));
    expect(view.getByTestId("main-chat-decision-card-dec_inline")).toBeTruthy();
    fireEvent.click(view.getByTestId("main-chat-decision-option-opt_beta"));
    await waitFor(() => {
      expect(client.answerMainChatDecision).toHaveBeenCalledWith({
        decisionId: "dec_inline",
        optionId: "opt_beta",
        answer: "先发 Beta",
      });
    });

    // Switch to In progress -> shows stale 48h sub-section and Pause button
    fireEvent.click(view.getByTestId("main-chat-action-capsule-inProgress"));
    expect(view.getByTestId("main-chat-action-stale-section")).toBeTruthy();
    fireEvent.click(view.getByTestId("main-chat-action-park-task_running"));
    await waitFor(() => {
      expect(client.parkMainChatTask).toHaveBeenCalledWith({
        taskId: "task_running",
        parked: true,
      });
    });

    // Switch to Awaiting review -> Accept review directly
    fireEvent.click(view.getByTestId("main-chat-action-capsule-awaitingReview"));
    fireEvent.click(view.getByTestId("main-chat-action-accept-task_review"));
    await waitFor(() => {
      expect(client.reviewMainChatTask).toHaveBeenCalledWith({
        taskId: "task_review",
        verdict: "accept",
      });
    });

    // Switch to Parked -> Resume directly
    fireEvent.click(view.getByTestId("main-chat-action-capsule-parked"));
    fireEvent.click(view.getByTestId("main-chat-action-resume-task_parked"));
    await waitFor(() => {
      expect(client.parkMainChatTask).toHaveBeenCalledWith({
        taskId: "task_parked",
        parked: false,
      });
    });

    // Drawer expand/collapse toggle works cleanly
    fireEvent.click(view.getByTestId("main-chat-action-capsule-inProgress"));
    const expandBtn = view.getByTestId("main-chat-action-panel-expand");
    fireEvent.click(expandBtn);
    expect(view.getByTestId("main-chat-action-panel-inProgress")).toBeTruthy();
    fireEvent.click(expandBtn);

    // Direct @ route from TaskBucketRow sets route target and closes the drawer
    useMainChatRouteStore.setState({ targetsByKey: {} });
    fireEvent.click(view.getByTestId("main-chat-action-stale-toggle"));
    fireEvent.click(view.getByTestId("main-chat-action-direct-task:task_stale"));
    expect(
      useMainChatRouteStore.getState().targetsByKey[routeStoreKey("srv_1", "agent_main")],
    ).toEqual({
      targetServerId: "srv_1",
      targetAgentId: "child_stale",
      targetTitle: "超 48h 搁置任务",
    });
    expect(view.queryByTestId("main-chat-action-panel-inProgress")).toBeNull();
    useMainChatActionBarDrawerStore.getState().reset();
  });

  it("renders MainChatActionBar in external drawerMode without injecting the drawer into the composer strip and closes overlay on Escape", () => {
    useMainChatActionBarDrawerStore.getState().reset();
    const client = makeFakeClient();
    seedSession(client);

    const overview = makeOverview({
      tasks: [
        makeTask({
          id: "task_ext_run",
          title: "外部浮层验证任务",
          status: "running",
          activeAgentId: "child_ext",
          agentIds: ["child_ext"],
        }),
      ],
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: { [overviewStoreKey("srv_1", "agent_main")]: overview },
    });

    const view = renderWithProviders(
      <>
        <div data-testid="mock-stream-viewport">
          <MainChatActionBarDrawerOverlay serverId="srv_1" agentId="agent_main" />
        </div>
        <div data-testid="mock-composer-strip">
          <MainChatActionBar serverId="srv_1" agentId="agent_main" drawerMode="external" />
        </div>
      </>,
    );

    expect(view.queryByTestId("main-chat-action-bar-drawer-overlay")).toBeNull();

    // Clicking capsule opens drawer inside stream viewport overlay, leaving composer strip untouched
    fireEvent.click(view.getByTestId("main-chat-action-capsule-inProgress"));
    const streamViewport = view.getByTestId("mock-stream-viewport");
    const composerStrip = view.getByTestId("mock-composer-strip");
    expect(
      streamViewport.querySelector('[data-testid="main-chat-action-bar-drawer-overlay"]'),
    ).toBeTruthy();
    expect(
      streamViewport.querySelector('[data-testid="main-chat-action-panel-inProgress"]'),
    ).toBeTruthy();
    expect(
      composerStrip.querySelector('[data-testid="main-chat-action-panel-inProgress"]'),
    ).toBeNull();

    // Pressing Escape dismisses the floating overlay
    fireEvent.keyDown(window, { key: "Escape" });
    expect(view.queryByTestId("main-chat-action-bar-drawer-overlay")).toBeNull();
    useMainChatActionBarDrawerStore.getState().reset();
  });

  it("renders TaskPanelDrawer with Brief strip, multi-agent switcher, status controls, and Chat/Diff/Terminal segments", async () => {
    const client = makeFakeClient();
    const agentV1 = makeAgent({
      id: "child_v1",
      serverId: "srv_1",
      workspaceId: "ws_repo",
      cwd: "/repo/app",
      title: "第一轮尝试",
    });
    const agentV2 = makeAgent({
      id: "child_v2",
      serverId: "srv_1",
      workspaceId: "ws_repo",
      cwd: "/repo/app",
      title: "续接实现",
      status: "running",
      turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
    });
    seedSession(client, [agentV1, agentV2]);

    const task = makeTask({
      id: "task_drawer",
      title: "多 Agent 续接任务",
      status: "awaiting_review",
      agentIds: ["child_v1", "child_v2"],
      activeAgentId: "child_v2",
      expectedMinutes: 25,
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_1", "agent_main")]: makeOverview({ tasks: [task] }),
      },
    });

    const view = renderWithProviders(
      <TaskPanelDrawer
        target={DRAWER_MULTI_AGENT_TARGET}
        mainServerId="srv_1"
        mainAgentId="agent_main"
        isFocused
        onFocus={vi.fn()}
      />,
    );

    // 1. Brief collapsible strip expands goal + doneWhen + outOfBounds
    expect(view.getByTestId("main-chat-task-drawer-brief")).toBeTruthy();
    fireEvent.click(view.getByTestId("main-chat-task-drawer-brief-toggle"));
    expect(view.getByTestId("main-chat-task-drawer-brief-details").textContent).toContain(
      "All unit tests green",
    );

    // 2. Multi-agent switcher shows both child_v2 (active) and child_v1 (historical)
    expect(view.getByTestId("main-chat-task-drawer-agent-switcher")).toBeTruthy();
    fireEvent.click(view.getByTestId("main-chat-task-drawer-agent-tab-child_v1"));
    expect(useMainChatDrawerStore.getState().activeTarget?.agentId).toBe("child_v1");

    // 3. Default Chat segment mounts MainChatAgentHost
    expect(view.getByTestId("mock-agent-host-srv_1:child_v2")).toBeTruthy();

    // 4. Switch to Diff segment mounts inline ChangesSurface
    fireEvent.click(view.getByTestId("main-chat-task-drawer-tab-diff"));
    expect(view.getByTestId("mock-changes-surface")).toBeTruthy();

    // 5. Switch to Terminal segment lists workspace terminals and mounts TerminalPane
    fireEvent.click(view.getByTestId("main-chat-task-drawer-tab-terminal"));
    await waitFor(() => {
      expect(client.listTerminals).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(view.getByTestId("mock-terminal-pane-term_1")).toBeTruthy();
    });

    // 6. Drawer header Accept button calls reviewMainChatTask
    fireEvent.click(view.getByTestId("main-chat-task-drawer-accept"));
    await waitFor(() => {
      expect(client.reviewMainChatTask).toHaveBeenCalledWith({
        taskId: "task_drawer",
        verdict: "accept",
      });
    });

    await act(async () => {
      await Promise.resolve();
    });
  });

  it("verifies compaction thresholds, activity filters, and drawer task/tab resolvers", () => {
    expect(shouldShowCompactionBanner(null)).toBe(false);
    expect(
      computeCompactionUsageRatio({ estimatedTokens: 70_000, thresholdTokens: 100_000 }),
    ).toBeCloseTo(0.7);
    expect(
      shouldShowCompactionBanner({
        status: "failed",
        estimatedTokens: 10_000,
        thresholdTokens: 100_000,
        lastCompactedAt: null,
        lastError: "timeout",
        summary: null,
      }),
    ).toBe(true);

    const now = new Date().toISOString();
    const entries: MainChatActivityEntry[] = [
      {
        id: "a1",
        mainAgentId: "agent_main",
        kind: "silent_turn",
        trigger: "patrol",
        summary: "silent",
        silent: true,
        status: "completed",
        createdAt: now,
        completedAt: now,
      },
      {
        id: "a2",
        mainAgentId: "agent_main",
        kind: "compaction",
        trigger: "manual",
        summary: "compact",
        silent: false,
        status: "completed",
        createdAt: now,
        completedAt: now,
      },
      {
        id: "a3",
        mainAgentId: "agent_main",
        kind: "missing_reply_recovery",
        trigger: "empty",
        summary: "recover",
        silent: false,
        status: "completed",
        createdAt: now,
        completedAt: now,
      },
    ];
    expect(filterMainChatActivityEntries(entries, "silent").map((e) => e.id)).toEqual(["a1"]);
    expect(filterMainChatActivityEntries(entries, "compaction_handoff").map((e) => e.id)).toEqual([
      "a2",
    ]);
    expect(
      filterMainChatActivityEntries(entries, "missing_reply_recovery").map((e) => e.id),
    ).toEqual(["a3"]);

    const multiTask = makeTask({
      id: "task_m",
      title: "多轮续接",
      status: "running",
      agentIds: ["a_old", "a_new"],
      activeAgentId: "a_new",
    });
    expect(resolveTaskRecordForDrawer([multiTask], { agentId: "a_old" })?.id).toBe("task_m");
    expect(buildTaskDrawerAgentTabs(multiTask, "a_old")).toEqual([
      { agentId: "a_new", isActive: true, isSelected: false },
      { agentId: "a_old", isActive: false, isSelected: true },
    ]);
  });

  it("renders all 4 Main Chat inline cards from Claude { output: ... } MCP tool payloads", () => {
    const client = makeFakeClient();
    seedSession(client);

    const openPlan = makeOpenPlan({ id: "plan_claude_ui" });
    const planCard = renderMainChatInlineToolCard({
      serverId: "srv_1",
      agentId: "agent_main",
      toolName: "mcp__paseo__task_plan",
      toolStatus: "completed",
      toolInput: {},
      toolOutput: {
        output: [{ type: "text", text: JSON.stringify({ plan: openPlan }) }],
      },
    });
    expect(planCard).toBeTruthy();
    const planView = renderWithProviders(planCard!);
    expect(planView.getByTestId("main-chat-plan-card-plan_claude_ui")).toBeTruthy();
    expect(planView.container.textContent).toContain("修复状态托盘");
    expect(planView.getByTestId("main-chat-plan-start-plan_claude_ui")).toBeTruthy();
    planView.unmount();

    const decisionRecord: MainChatDecisionRecord = {
      id: "dec_claude_ui",
      mainAgentId: "agent_main",
      title: "是否切换新协议",
      question: "请确认是否同步切到新协议？",
      agentId: "child_1",
      planId: "plan_claude_ui",
      taskId: "pt_1",
      options: [
        { id: "opt_yes", label: "切换", leadsTo: "应用新协议" },
        { id: "opt_no", label: "保持旧版", leadsTo: "保留兼容层" },
      ],
      recommendedOptionId: "opt_yes",
      reason: "需要确认接口兼容性",
      answer: null,
      answeredOptionId: null,
      answeredAt: null,
      createdAt: new Date().toISOString(),
    };
    const decisionCard = renderMainChatInlineToolCard({
      serverId: "srv_1",
      agentId: "agent_main",
      toolName: "mcp__paseo__task_ask_user",
      toolStatus: "completed",
      toolInput: {},
      toolOutput: {
        output: {
          content: [{ type: "text", text: JSON.stringify({ decision: decisionRecord }) }],
        },
      },
    });
    expect(decisionCard).toBeTruthy();
    const decisionView = renderWithProviders(decisionCard!);
    expect(decisionView.getByTestId("main-chat-decision-card-dec_claude_ui")).toBeTruthy();
    expect(decisionView.container.textContent).toContain("是否切换新协议");
    decisionView.unmount();

    const receiptCard = renderMainChatInlineToolCard({
      serverId: "srv_1",
      agentId: "agent_main",
      toolName: "mcp__paseo__task_complete",
      toolStatus: "completed",
      toolInput: {},
      toolOutput: {
        output: {
          structuredContent: {
            receipt: {
              title: "内联卡片修复验收",
              summary: "4 类卡片均可正常渲染",
              agentId: "child_1",
              planId: "plan_claude_ui",
              taskId: "task_rcpt_1",
              checks: [{ criterion: "协议解包", met: true, evidence: "vitest green" }],
              nextSteps: [],
            },
          },
        },
      },
    });
    expect(receiptCard).toBeTruthy();
    const receiptView = renderWithProviders(receiptCard!);
    expect(receiptView.getByTestId("main-chat-receipt-card-task_rcpt_1")).toBeTruthy();
    expect(receiptView.container.textContent).toContain("内联卡片修复验收");
    receiptView.unmount();

    const reworkCard = renderMainChatInlineToolCard({
      serverId: "srv_1",
      agentId: "agent_main",
      toolName: "mcp__paseo__task_rework",
      toolStatus: "completed",
      toolInput: {},
      toolOutput: {
        output: JSON.stringify({
          rework: {
            title: "补齐边界校验",
            agentId: "child_rework_1",
            planId: "plan_claude_ui",
            taskId: "task_rw_1",
            round: 1,
            maxRounds: 2,
            gaps: ["补充 Claude output 嵌套数组单测"],
            note: "请复核",
          },
        }),
      },
    });
    expect(reworkCard).toBeTruthy();
    const reworkView = renderWithProviders(reworkCard!);
    expect(reworkView.getByTestId("main-chat-rework-card-child_rework_1-1")).toBeTruthy();
    expect(reworkView.container.textContent).toContain("补齐边界校验");
    reworkView.unmount();
  });

  it("renders deduplicated rich context in NeedsYou expanded drawer, refreshes overview on drawer open & live state changes, and immediately filters stale running/archived agents", async () => {
    const blockedChild = makeAgent({
      id: "child_blocked_ui",
      serverId: "srv_1",
      workspaceId: "ws_repo",
      cwd: "/repo/paseo-fork",
      title: "修复主对话交互",
      status: "idle",
      turn: { phase: "idle", cancellationRequestId: null },
    });

    const initialOverview = makeOverview({
      triages: [
        {
          agentId: "child_blocked_ui",
          workspaceId: "ws_repo",
          title: "修复主对话交互",
          managedByMainChat: true,
          phase: "blocked_user",
          summary: "已完成 4 个模块修改并通过类型检查",
          waitReason: "请确认是否同步更新《发布说明与变更文档清单》？",
          suggestedAction: "查看会话并确认下一步",
          triageSource: "rule",
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const getOverviewMock = vi.fn(async () => ({
      requestId: "req_refresh",
      overview: initialOverview,
      error: null,
    }));
    const client = makeFakeClient({ getMainChatOverview: getOverviewMock });
    seedSession(client, [blockedChild]);
    useMainChatOverviewStore.setState({
      overviewsByKey: { [overviewStoreKey("srv_1", "agent_main")]: initialOverview },
    });

    const view = renderWithProviders(<MainChatActionBar serverId="srv_1" agentId="agent_main" />);
    expect(view.getByTestId("main-chat-action-capsule-needsYou").textContent).toContain(
      '"count":1',
    );

    // 1. Opening drawer refreshes overview silently even though overview is already cached!
    fireEvent.click(view.getByTestId("main-chat-action-capsule-needsYou"));
    await waitFor(() => {
      expect(getOverviewMock).toHaveBeenCalledTimes(1);
    });

    // Expanded body renders full question, non-duplicate summary, suggestion, and both open/direct actions.
    expect(
      view.getByTestId("main-chat-action-needs-question-agent:srv_1:child_blocked_ui").textContent,
    ).toContain("请确认是否同步更新《发布说明与变更文档清单》？");
    expect(
      view.getByTestId("main-chat-action-needs-summary-agent:srv_1:child_blocked_ui").textContent,
    ).toContain("已完成 4 个模块修改并通过类型检查");
    expect(
      view.getByTestId("main-chat-action-needs-suggestion-agent:srv_1:child_blocked_ui")
        .textContent,
    ).toContain("查看会话并确认下一步");
    expect(
      view.getByTestId("main-chat-action-needs-task-direct-agent:srv_1:child_blocked_ui"),
    ).toBeTruthy();

    // Close and reopen drawer -> MUST silently refresh overview again (no one-shot gate).
    fireEvent.click(view.getByTestId("main-chat-action-panel-close"));
    fireEvent.click(view.getByTestId("main-chat-action-capsule-needsYou"));
    await waitFor(() => {
      expect(getOverviewMock).toHaveBeenCalledTimes(2);
    });

    // 2. Child session starts running in its original tab -> triggers silent refresh AND immediately
    //    removes stale blocked_user from needsYou even before overview updates!
    await act(async () => {
      const current = useSessionStore.getState();
      const session = current.sessions.srv_1!;
      const nextAgents = new Map(session.agents);
      nextAgents.set("child_blocked_ui", {
        ...blockedChild,
        status: "running",
        turn: {
          phase: "open",
          turnId: "t_live",
          startedAt: new Date(),
          cancellationRequestId: null,
        },
      });
      useSessionStore.setState({
        sessions: {
          ...current.sessions,
          srv_1: { ...session, agents: nextAgents },
        },
      });
    });

    await waitFor(() => {
      expect(getOverviewMock).toHaveBeenCalledTimes(3);
    });
    expect(view.queryByTestId("main-chat-action-capsule-needsYou")).toBeNull();
    expect(view.getByTestId("main-chat-action-capsule-inProgress").textContent).toContain(
      '"count":1',
    );
  });
});
