// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  type MainChatOverview,
  type MainChatProjectLesson,
  type MainChatProjectLessonGroup,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatProjectLessonsPanel } from "@/screens/settings/main-chat/project-lessons-panel";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { MainChatActionBar, useMainChatActionBarDrawerStore } from "./action-bar";
import { buildMainChatActionBarModel } from "./action-bar-model";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { deriveDeliveryGateBadge, deriveTaskDagSummary } from "./task-dag-ui";
import { TaskDrawerGovernanceStrip } from "./task-drawer-governance-strip";
import { TaskPanelDrawer } from "./task-panel-drawer";

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
  const now = "2026-11-25T03:00:00.000Z";
  return {
    mainAgentId: "agent_main",
    conversationId: "conv_main",
    planId: "plan_wave3",
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
      doneWhen: ["单测通过"],
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

function makeFixtureLessons(): MainChatProjectLesson[] {
  const now = "2026-11-25T02:30:00.000Z";
  return [
    {
      id: "les_protocol_build",
      projectKey: "/repo/paseo-fork",
      projectLabel: "paseo-fork",
      kind: "repeated_mistake",
      text: "修改 packages/protocol 后必须先执行 protocol build 再跑 server typecheck。",
      origin: "auto_rework",
      seenCount: 3,
      sourceTaskIds: ["task_1", "task_2"],
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
    },
    {
      id: "les_selector_guard",
      projectKey: "/repo/paseo-fork",
      projectLabel: "paseo-fork",
      kind: "improvement",
      text: "Zustand selector 禁止返回新建对象或数组字面量，避免 React #185 无限重渲染。",
      origin: "auto_review",
      seenCount: 1,
      sourceTaskIds: ["task_3"],
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
    },
  ];
}

function makeGroups(lessons: MainChatProjectLesson[]): MainChatProjectLessonGroup[] {
  const byKey = new Map<string, MainChatProjectLessonGroup>();
  for (const lesson of lessons) {
    const existing = byKey.get(lesson.projectKey);
    if (existing) {
      existing.lessons.push(lesson);
      existing.lessonCount += 1;
    } else {
      byKey.set(lesson.projectKey, {
        projectKey: lesson.projectKey,
        projectLabel: lesson.projectLabel,
        lessonCount: 1,
        lessons: [lesson],
      });
    }
  }
  return Array.from(byKey.values());
}

function createMockLessonsClient(handlers: {
  listMainChatLessons: DaemonClient["listMainChatLessons"];
  addMainChatLesson: DaemonClient["addMainChatLesson"];
  deleteMainChatLesson: DaemonClient["deleteMainChatLesson"];
}): DaemonClient {
  return handlers as unknown as DaemonClient;
}

const PARENT_CLOSEOUT_DRAWER_TARGET = {
  serverId: "srv_1",
  agentId: "agent_parent",
  workspaceId: "ws_paseo",
  title: "可收尾父任务",
  taskId: "task_parent_close",
};

function removeLessonById(
  lessons: readonly MainChatProjectLesson[],
  lessonId: string,
): MainChatProjectLesson[] {
  return lessons.filter((item) => item.id !== lessonId);
}

describe("Wave 3 App Unit Tests — Project Lessons, Delivery Gate, and Task DAG UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  afterEach(() => {
    cleanup();
  });

  it("P1-1: MainChatProjectLessonsPanel renders grouped lessons, supports manual add, and confirms delete", async () => {
    let lessonsState = makeFixtureLessons();

    const listMock = vi.fn(async () => ({
      requestId: "req_1",
      groups: makeGroups(lessonsState),
      lessons: lessonsState,
      error: null,
    }));
    const addMock = vi.fn(
      async (input: {
        projectKey: string;
        projectLabel?: string;
        kind: MainChatProjectLesson["kind"];
        text: string;
      }) => {
        const created: MainChatProjectLesson = {
          id: "les_manual_1",
          projectKey: input.projectKey,
          projectLabel: input.projectLabel ?? "mobile-app",
          kind: input.kind,
          text: input.text,
          origin: "manual",
          seenCount: 1,
          sourceTaskIds: [],
          firstSeenAt: "2026-11-25T03:00:00.000Z",
          lastSeenAt: "2026-11-25T03:00:00.000Z",
          createdAt: "2026-11-25T03:00:00.000Z",
          updatedAt: "2026-11-25T03:00:00.000Z",
          retiredAt: null,
        };
        lessonsState = [created, ...lessonsState];
        return {
          requestId: "req_2",
          lesson: created,
          deduplicated: false,
          error: null,
        };
      },
    );
    const deleteMock = vi.fn(async (lessonId: string) => {
      lessonsState = removeLessonById(lessonsState, lessonId);
      return {
        requestId: "req_3",
        lessonId,
        deleted: true,
        error: null,
      };
    });

    const client = createMockLessonsClient({
      listMainChatLessons: listMock as unknown as DaemonClient["listMainChatLessons"],
      addMainChatLesson: addMock as unknown as DaemonClient["addMainChatLesson"],
      deleteMainChatLesson: deleteMock as unknown as DaemonClient["deleteMainChatLesson"],
    });

    const view = render(wrap(<MainChatProjectLessonsPanel serverId="srv_1" client={client} />));

    await waitFor(() => {
      expect(view.getByTestId("project-lessons-group-0")).toBeTruthy();
      expect(view.getByTestId("project-lessons-item-les_protocol_build")).toBeTruthy();
    });

    // Open Add form, pick kind, fill fields, submit
    fireEvent.click(view.getByTestId("project-lessons-add-toggle"));
    await waitFor(() => {
      expect(view.getByTestId("project-lessons-add-form")).toBeTruthy();
    });

    fireEvent.change(view.getByTestId("project-lessons-input-project"), {
      target: { value: "/repo/mobile-app" },
    });
    fireEvent.change(view.getByTestId("project-lessons-input-label"), {
      target: { value: "mobile-app" },
    });
    fireEvent.click(view.getByTestId("project-lessons-kind-missing_context"));
    fireEvent.change(view.getByTestId("project-lessons-input-text"), {
      target: { value: "打包前需同步更新 i18n 中英文双语词条。" },
    });
    fireEvent.click(view.getByTestId("project-lessons-submit"));

    await waitFor(() => {
      expect(addMock).toHaveBeenCalledWith({
        projectKey: "/repo/mobile-app",
        projectLabel: "mobile-app",
        kind: "missing_context",
        text: "打包前需同步更新 i18n 中英文双语词条。",
      });
      expect(view.getByTestId("project-lessons-item-les_manual_1")).toBeTruthy();
    });

    // Confirm delete on a lesson
    fireEvent.click(view.getByTestId("project-lessons-delete-les_protocol_build"));
    fireEvent.click(view.getByTestId("project-lessons-delete-confirm-les_protocol_build"));

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith("les_protocol_build");
      expect(view.queryByTestId("project-lessons-item-les_protocol_build")).toBeNull();
    });
  });

  it("P1-2 & P1-3: ActionBar orders parent-child hierarchy, shows blocked/ready/deliveryGate badges, triggers one-click Start Ready and opens Lessons", async () => {
    const parentTask = makeTask({
      id: "task_parent",
      title: "Wave 3 主功能总控",
      status: "open",
      activeAgentId: null,
    });
    const childReady = makeTask({
      id: "task_child_ready",
      title: "拆片 2：服务端接入",
      status: "open",
      partOf: "task_parent",
      after: ["task_child_done"],
      dependencyState: "ready",
      activeAgentId: null,
    });
    const childBlocked = makeTask({
      id: "task_child_blocked",
      title: "拆片 3：前端面板",
      status: "open",
      partOf: "task_parent",
      after: ["task_child_ready"],
      dependencyState: "blocked",
      activeAgentId: null,
    });
    const childDone = makeTask({
      id: "task_child_done",
      title: "拆片 1：协议层",
      status: "completed",
      partOf: "task_parent",
      completedAt: "2026-11-25T02:55:00.000Z",
      deliveryGate: {
        prUrl: "https://github.com/paseo/demo/pull/41",
        prNumber: 41,
        branch: "feat/slice-1",
        prState: "merged",
        isDraft: false,
        hasConflict: false,
        ciStatus: "passing",
        gateStatus: "merged",
        blockingReasons: [],
        followUpActive: false,
        lastCheckedAt: "2026-11-25T02:55:00.000Z",
        mergedAt: "2026-11-25T02:55:00.000Z",
      },
    });
    const reviewBlockedPrTask = makeTask({
      id: "task_review_conflict",
      title: "修复冲突 PR",
      status: "awaiting_review",
      activeAgentId: "agent_pr_1",
      agentIds: ["agent_pr_1"],
      deliveryGate: {
        prUrl: "https://github.com/paseo/demo/pull/42",
        prNumber: 42,
        branch: "feat/pr-42",
        prState: "open",
        isDraft: false,
        hasConflict: true,
        ciStatus: "failing",
        ciSummary: "unit-tests 失败",
        gateStatus: "conflict",
        blockingReasons: ["PR #42 存在合并冲突", "CI 检查失败"],
        followUpActive: true,
        lastCheckedAt: "2026-11-25T03:00:00.000Z",
      },
    });

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
        receiptsRecorded: 1,
        interrupts: 0,
        supervisorHeld: 0,
        reworkCount: 0,
        stalledNudges: 0,
        usageLimitRetries: 0,
      },
      tasks: [parentTask, childBlocked, childReady, childDone, reviewBlockedPrTask],
      projectLessons: makeFixtureLessons(),
    };

    // Pure model verification: hierarchy ordering + DAG summaries + delivery gate badges
    const model = buildMainChatActionBarModel({
      serverId: "srv_1",
      mainAgentId: "agent_main",
      overview,
      liveAgents: [],
      pendingPermissions: [],
      nowMs: Date.parse("2026-11-25T03:05:00.000Z"),
    });
    expect(model.projectLessonsCount).toBe(2);
    const inProgressIds = model.inProgress.active.map((item) => item.taskId);
    // Parent appears BEFORE its indented children!
    expect(inProgressIds[0]).toBe("task_parent");
    expect(inProgressIds.slice(1)).toContain("task_child_ready");
    expect(inProgressIds.slice(1)).toContain("task_child_blocked");

    const readyItem = model.inProgress.active.find((item) => item.taskId === "task_child_ready")!;
    expect(readyItem.hierarchyDepth).toBe(1);
    expect(readyItem.canStartReady).toBe(true);

    const blockedItem = model.inProgress.active.find(
      (item) => item.taskId === "task_child_blocked",
    )!;
    expect(blockedItem.dependencyState).toBe("blocked");
    expect(blockedItem.blockedByTitles).toEqual(["拆片 2：服务端接入"]);

    const gateDesc = deriveDeliveryGateBadge(reviewBlockedPrTask.deliveryGate);
    expect(gateDesc?.isBlocked).toBe(true);
    expect(gateDesc?.statusKey).toBe("mainChat.deliveryGate.statusConflict");

    // Mount MainChatActionBar with mocked client & store
    const startReadyMock = vi.fn(async (_taskId: string) => ({
      requestId: "req_ready",
      task: {
        ...childReady,
        status: "running" as const,
        activeAgentId: "agent_slice_2",
        dependencyState: "none" as const,
      },
      plan: null,
      error: null,
    }));
    const client = {
      getMainChatOverview: vi.fn(async () => ({ requestId: "req_ov", overview, error: null })),
      startMainChatReadyTask: startReadyMock,
      parkMainChatTask: vi.fn(),
      reviewMainChatTask: vi.fn(),
    } as unknown as DaemonClient;

    const now = new Date("2026-11-25T03:00:00.000Z");
    const mainAgent = {
      id: "agent_main",
      serverId: "srv_1",
      workspaceId: "ws_main",
      provider: "claude",
      status: "idle",
      cwd: "/repo/paseo-fork",
      title: "总控主对话",
      createdAt: now,
      updatedAt: now,
      requiresAttention: false,
      attentionReason: null,
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      pendingPermissions: [],
      turn: { phase: "idle" as const },
    };

    useSessionStore.setState({
      sessions: {
        srv_1: {
          client,
          agents: new Map([["agent_main", mainAgent]]),
          agentDetails: new Map(),
          workspaces: new Map(),
          pendingPermissions: new Map(),
        } as unknown as SessionState,
      },
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_1", "agent_main")]: overview,
      },
    });

    const view = render(wrap(<MainChatActionBar serverId="srv_1" agentId="agent_main" />));

    // Open inProgress drawer
    fireEvent.click(view.getByTestId("main-chat-action-capsule-inProgress"));
    await waitFor(() => {
      expect(view.getByTestId("main-chat-action-panel-inProgress")).toBeTruthy();
      expect(view.getByTestId("main-chat-action-child-task:task_child_ready")).toBeTruthy();
      expect(view.getByTestId("main-chat-action-start-ready-task_child_ready")).toBeTruthy();
    });

    // Click one-click Start Ready button
    fireEvent.click(view.getByTestId("main-chat-action-start-ready-task_child_ready"));
    await waitFor(() => {
      expect(startReadyMock).toHaveBeenCalledWith("task_child_ready");
    });

    // Click Project Lessons entry button -> navigates to settings main-chat
    fireEvent.click(view.getByTestId("main-chat-action-open-lessons"));
    expect(routerPushMock).toHaveBeenCalled();
  });

  it("P1-2 & P1-3: TaskPanelDrawer shows delivery gate blocked guard + explicit bypass flow, parent closeout banner, and Project Lessons link", async () => {
    const parentWithAllDone = makeTask({
      id: "task_parent_close",
      title: "可收尾父任务",
      status: "awaiting_review",
      activeAgentId: "agent_parent",
      agentIds: ["agent_parent"],
      deliveryGate: {
        prUrl: "https://github.com/paseo/demo/pull/88",
        prNumber: 88,
        branch: "feat/parent",
        prState: "open",
        isDraft: true,
        hasConflict: false,
        ciStatus: "pending",
        gateStatus: "draft",
        blockingReasons: ["PR #88 仍处于草稿状态"],
        followUpActive: true,
        lastCheckedAt: "2026-11-25T03:00:00.000Z",
      },
    });
    const completedChild = makeTask({
      id: "task_slice_done",
      title: "子片 A（已验收）",
      status: "completed",
      partOf: "task_parent_close",
      completedAt: "2026-11-25T02:58:00.000Z",
    });

    const dag = deriveTaskDagSummary(parentWithAllDone, [parentWithAllDone, completedChild]);
    expect(dag.allChildrenDone).toBe(true);
    expect(dag.childrenTotal).toBe(1);

    const reviewMock = vi.fn(async () => ({
      requestId: "req_rev",
      task: { ...parentWithAllDone, status: "completed" as const },
      receipt: null,
      rework: null,
      deliveryGateWarning: "已人工豁免",
      error: null,
    }));
    const client = {
      reviewMainChatTask: reviewMock,
      parkMainChatTask: vi.fn(),
      startMainChatReadyTask: vi.fn(),
    } as unknown as DaemonClient;

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
        receiptsRecorded: 1,
        interrupts: 0,
        supervisorHeld: 0,
        reworkCount: 0,
        stalledNudges: 0,
        usageLimitRetries: 0,
      },
      tasks: [parentWithAllDone, completedChild],
      projectLessons: makeFixtureLessons(),
    };

    const now = new Date("2026-11-25T03:00:00.000Z");
    useSessionStore.setState({
      sessions: {
        srv_1: {
          client,
          agents: new Map([
            [
              "agent_parent",
              {
                id: "agent_parent",
                serverId: "srv_1",
                workspaceId: "ws_paseo",
                provider: "claude",
                status: "idle",
                cwd: "/repo/paseo-fork",
                title: "可收尾父任务",
                createdAt: now,
                updatedAt: now,
                requiresAttention: false,
                attentionReason: null,
                labels: {},
                pendingPermissions: [],
                turn: { phase: "idle" as const },
              },
            ],
          ]),
          agentDetails: new Map(),
          workspaces: new Map(),
          pendingPermissions: new Map(),
        } as unknown as SessionState,
      },
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_1", "agent_main")]: overview,
      },
    });

    const onFocusMock = vi.fn();
    const view = render(
      wrap(
        <TaskPanelDrawer
          target={PARENT_CLOSEOUT_DRAWER_TARGET}
          mainServerId="srv_1"
          mainAgentId="agent_main"
          isFocused
          onFocus={onFocusMock}
        />,
      ),
    );

    // Governance strip shows parent closeout banner, indented child slice, PR gate badge, and lessons entry
    expect(view.getByTestId("main-chat-task-drawer-governance")).toBeTruthy();
    expect(view.getByTestId("main-chat-task-drawer-parent-closeout")).toBeTruthy();
    expect(view.getByTestId("main-chat-task-drawer-child-task_slice_done")).toBeTruthy();
    expect(view.getByTestId("main-chat-task-drawer-delivery-gate-badge")).toBeTruthy();
    expect(view.getByTestId("main-chat-task-drawer-delivery-gate-blocked")).toBeTruthy();

    // Plain Accept is protected (hidden while blocked); explicit bypass requires reason
    expect(view.queryByTestId("main-chat-task-drawer-accept")).toBeNull();
    fireEvent.click(view.getByTestId("main-chat-task-drawer-bypass-toggle"));
    fireEvent.change(view.getByTestId("main-chat-task-drawer-bypass-input"), {
      target: { value: "人工复核确认先按草稿合入前收口" },
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("main-chat-task-drawer-bypass-submit"));
    });

    await waitFor(() => {
      expect(reviewMock).toHaveBeenCalledWith({
        taskId: "task_parent_close",
        verdict: "accept",
        bypassDeliveryGate: true,
        bypassReason: "人工复核确认先按草稿合入前收口",
      });
    });

    // Governance strip lessons entry opens settings
    fireEvent.click(view.getByTestId("main-chat-task-drawer-lessons-entry"));
    expect(routerPushMock).toHaveBeenCalled();

    // Direct smoke render of TaskDrawerGovernanceStrip with ready task
    const readyOnly = makeTask({
      id: "task_ready_direct",
      title: "就绪下游任务",
      status: "open",
      after: ["task_slice_done"],
      dependencyState: "ready",
    });
    const onStart = vi.fn();
    const stripView = render(
      wrap(
        <TaskDrawerGovernanceStrip
          task={readyOnly}
          allTasks={[completedChild, readyOnly]}
          projectLessons={makeFixtureLessons()}
          isMutatingTask={false}
          onStartReadyTask={onStart}
          onSelectRelatedTask={vi.fn()}
        />,
      ),
    );
    fireEvent.click(stripView.getByTestId("main-chat-task-drawer-start-ready"));
    expect(onStart).toHaveBeenCalledWith("task_ready_direct");
  });
});
