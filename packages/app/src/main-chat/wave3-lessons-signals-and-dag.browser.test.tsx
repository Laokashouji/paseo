import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  type MainChatOverview,
  type MainChatProjectLesson,
  type MainChatProjectLessonGroup,
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
import { MainChatProjectLessonsPanel } from "@/screens/settings/main-chat/project-lessons-panel";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import {
  MainChatActionBar,
  MainChatActionBarDrawerOverlay,
  useMainChatActionBarDrawerStore,
} from "./action-bar";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { TaskDrawerGovernanceStrip } from "./task-drawer-governance-strip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const browserToastApi = { show: vi.fn(), copied: vi.fn(), error: vi.fn(), dismiss: vi.fn() };

const SCREENSHOT_DIR =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_MAIN_CHAT_SCREENSHOT_DIR || "/tmp/main-chat-017527-screenshots";

function makeFixtureLessons(): MainChatProjectLesson[] {
  const now = "2026-11-25T03:00:00.000Z";
  return [
    {
      id: "les_1",
      projectKey: "/data00/repo/paseo-fork",
      projectLabel: "paseo-fork",
      kind: "repeated_mistake",
      text: "修改 packages/protocol 后必须先执行 npm run build --workspace @getpaseo/protocol，再跑 server 与 app typecheck。",
      origin: "auto_rework",
      seenCount: 3,
      sourceTaskIds: ["task_p0", "task_p1"],
      firstSeenAt: "2026-11-20T03:00:00.000Z",
      lastSeenAt: now,
      createdAt: "2026-11-20T03:00:00.000Z",
      updatedAt: now,
      retiredAt: null,
    },
    {
      id: "les_2",
      projectKey: "/data00/repo/paseo-fork",
      projectLabel: "paseo-fork",
      kind: "improvement",
      text: "Zustand selector 严禁返回新对象或数组字面量，始终返回原始值或直接 Store 引用并通过 zustand-selector-guard 检查。",
      origin: "auto_review",
      seenCount: 2,
      sourceTaskIds: ["task_p2"],
      firstSeenAt: "2026-11-22T03:00:00.000Z",
      lastSeenAt: now,
      createdAt: "2026-11-22T03:00:00.000Z",
      updatedAt: now,
      retiredAt: null,
    },
    {
      id: "les_3",
      projectKey: "repo:paseo-org/relay-gateway",
      projectLabel: "relay-gateway",
      kind: "missing_context",
      text: "端到端联调前先检查 .env.local 中的 RELAY_PUBLIC_KEY 与自签证书路径，避免握手静默超时。",
      origin: "manual",
      seenCount: 1,
      sourceTaskIds: [],
      firstSeenAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
      retiredAt: null,
    },
  ];
}

function groupLessons(lessons: MainChatProjectLesson[]): MainChatProjectLessonGroup[] {
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

function makeFixtureTasks(): MainChatTaskRecord[] {
  const now = "2026-11-25T03:10:00.000Z";
  const base = {
    mainAgentId: "agent_main",
    conversationId: "conv_main",
    planId: "plan_w3",
    mode: "write" as const,
    isolation: "worktree" as const,
    serverId: "srv_1",
    hostLabel: "DevBox",
    cwd: "/data00/repo/paseo-fork",
    workspaceId: "ws_paseo",
    workspaceLabel: "paseo-fork",
    decisions: [],
    latestReceipt: null,
    expectedMinutes: 20,
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
  };

  return [
    {
      ...base,
      id: "task_parent_w3",
      title: "Wave 3：教训沉淀、信号门禁与 DAG",
      mode: "readonly",
      status: "awaiting_review",
      brief: {
        goal: "统筹完成 P1-1 项目经验库、P1-2 交付门禁与督办信号、P1-3 父子拆片 DAG 并通过视觉验收",
        doneWhen: ["四包构建全绿", "Playwright Chromium 四图视觉验收通过"],
        outOfBounds: ["严禁自动合并 PR", "严禁重启 6767 Daemon"],
        scopeRevision: 2,
        updatedAt: now,
      },
      activeAgentId: "agent_parent_w3",
      agentIds: ["agent_parent_w3"],
      partOf: null,
      after: [],
      dependencyState: "none",
      autoStartOnReady: false,
      deliveryGate: {
        prUrl: "https://github.com/paseo-org/paseo-fork/pull/527",
        prNumber: 527,
        branch: "feat/main-chat-lessons-signals-and-dag",
        prState: "open",
        isDraft: false,
        hasConflict: true,
        ciStatus: "failing",
        ciSummary: "失败项：server-unit-tests",
        reviewDecision: "changes_requested",
        gateStatus: "conflict",
        blockingReasons: [
          "PR #527 存在合并冲突（CONFLICTING）",
          "PR #527 CI 检查失败（失败项：server-unit-tests）",
        ],
        followUpActive: true,
        lastCheckedAt: now,
      },
    },
    {
      ...base,
      id: "task_slice_1",
      title: "拆片 1：协议层与项目经验库",
      status: "completed",
      brief: {
        goal: "完成 protocol schema 与 lessons 持久化及去重提炼",
        doneWhen: ["protocol build 通过"],
        outOfBounds: [],
        scopeRevision: 1,
        updatedAt: now,
      },
      activeAgentId: null,
      agentIds: ["agent_slice_1"],
      completedAt: "2026-11-25T03:02:00.000Z",
      partOf: "task_parent_w3",
      after: [],
      dependencyState: "none",
      autoStartOnReady: false,
      deliveryGate: {
        prUrl: "https://github.com/paseo-org/paseo-fork/pull/525",
        prNumber: 525,
        branch: "feat/w3-slice-1",
        prState: "merged",
        isDraft: false,
        hasConflict: false,
        ciStatus: "passing",
        gateStatus: "merged",
        blockingReasons: [],
        followUpActive: false,
        lastCheckedAt: now,
        mergedAt: "2026-11-25T03:02:00.000Z",
      },
    },
    {
      ...base,
      id: "task_slice_2",
      title: "拆片 2：13 种督办信号与 PR 交付门禁",
      status: "open",
      brief: {
        goal: "补齐预留信号真实触发链路与 deliveryGate 门禁保护",
        doneWhen: ["13 种信号全部单测通过"],
        outOfBounds: [],
        scopeRevision: 1,
        updatedAt: now,
      },
      activeAgentId: null,
      agentIds: [],
      partOf: "task_parent_w3",
      after: ["task_slice_1"],
      dependencyState: "ready",
      autoStartOnReady: false,
      deliveryGate: null,
    },
    {
      ...base,
      id: "task_slice_3",
      title: "拆片 3：前端 DAG 与设置页经验库面板",
      status: "open",
      brief: {
        goal: "实现任务抽屉父子缩进、门禁徽章与设置页项目经验库",
        doneWhen: ["1440px / 390px 零溢出"],
        outOfBounds: [],
        scopeRevision: 1,
        updatedAt: now,
      },
      activeAgentId: null,
      agentIds: [],
      partOf: "task_parent_w3",
      after: ["task_slice_2"],
      dependencyState: "blocked",
      autoStartOnReady: true,
      deliveryGate: null,
    },
  ];
}

function makeFixtureOverview(
  tasks: MainChatTaskRecord[],
  lessons: MainChatProjectLesson[],
): MainChatOverview {
  return {
    plans: [],
    decisions: [],
    autoStartRules: [],
    permissionRules: [],
    metrics: {
      autoContinued: 1,
      plansCreated: 2,
      plansAutoStarted: 0,
      plansStarted: 2,
      plansCancelled: 0,
      receiptsRecorded: 1,
      interrupts: 0,
      supervisorHeld: 3,
      reworkCount: 1,
      stalledNudges: 0,
      usageLimitRetries: 0,
    },
    tasks,
    projectLessons: lessons,
  };
}

function makeFixtureClient(overview: MainChatOverview, initialLessons: MainChatProjectLesson[]) {
  let lessons = [...initialLessons];
  return {
    getMainChatOverview: vi.fn(async () => ({ requestId: "req_ov", overview, error: null })),
    listMainChatLessons: vi.fn(async () => ({
      requestId: "req_ls",
      groups: groupLessons(lessons),
      lessons,
      error: null,
    })),
    addMainChatLesson: vi.fn(
      async (input: {
        projectKey: string;
        projectLabel?: string;
        kind: MainChatProjectLesson["kind"];
        text: string;
      }) => {
        const created: MainChatProjectLesson = {
          id: `les_new_${lessons.length + 1}`,
          projectKey: input.projectKey,
          projectLabel: input.projectLabel ?? "custom-project",
          kind: input.kind,
          text: input.text,
          origin: "manual",
          seenCount: 1,
          sourceTaskIds: [],
          firstSeenAt: "2026-11-25T03:20:00.000Z",
          lastSeenAt: "2026-11-25T03:20:00.000Z",
          createdAt: "2026-11-25T03:20:00.000Z",
          updatedAt: "2026-11-25T03:20:00.000Z",
          retiredAt: null,
        };
        lessons = [created, ...lessons];
        return { requestId: "req_add", lesson: created, deduplicated: false, error: null };
      },
    ),
    deleteMainChatLesson: vi.fn(async (lessonId: string) => {
      lessons = lessons.filter((l) => l.id !== lessonId);
      return { requestId: "req_del", lessonId, deleted: true, error: null };
    }),
    startMainChatReadyTask: vi.fn(async (taskId: string) => ({
      requestId: "req_ready",
      task: overview.tasks?.find((t) => t.id === taskId) ?? null,
      plan: null,
      error: null,
    })),
    reviewMainChatTask: vi.fn(async () => ({
      requestId: "req_rev",
      task: null,
      receipt: null,
      rework: null,
      error: null,
    })),
    parkMainChatTask: vi.fn(async () => ({ requestId: "req_park", task: null, error: null })),
  } as unknown as DaemonClient;
}

const noopTaskAction = () => undefined;

function Wave3MessageBubble(): ReactElement {
  return (
    <View style={sceneStyles.streamTranscriptOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
      <View style={sceneStyles.streamTranscript}>
        <View style={sceneStyles.messageBubble} testID="wave3-message-column">
          <Text style={sceneStyles.messageHeading}>总控主对话 · Wave 3 督办进展</Text>
          <Text style={sceneStyles.messageBody}>
            拆片 1（PR #525）已合并并自动解锁下游拆片 2（todo_ready）；父任务关联的 PR #527
            当前存在合并冲突与 CI 失败，已由交付门禁自动保护拦截常规验收。
          </Text>
        </View>
      </View>
    </View>
  );
}

function Wave3MainChatSplitScene({
  tasks,
  lessons,
  showDrawer = true,
  compact = false,
}: {
  tasks: readonly MainChatTaskRecord[];
  lessons: readonly MainChatProjectLesson[];
  showDrawer?: boolean;
  compact?: boolean;
}): ReactElement {
  const parentTask = tasks[0]!;
  return (
    <View
      style={compact ? sceneStyles.narrowMainScene : sceneStyles.wideMainScene}
      testID="wave3-main-scene"
    >
      <View style={sceneStyles.mainChatColumn} testID="wave3-main-column">
        <ChatColumnRailSurface serverId="srv_1">
          <View style={sceneStyles.streamSurface} testID="wave3-stream-surface">
            <Wave3MessageBubble />
            <MainChatActionBarDrawerOverlay serverId="srv_1" agentId="agent_main" />
          </View>

          <View style={sceneStyles.bottomStack}>
            <MainChatActionBar serverId="srv_1" agentId="agent_main" drawerMode="external" />

            <View style={sceneStyles.composerOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
              <View style={sceneStyles.composerInner} testID="wave3-composer-baseline">
                <Text style={sceneStyles.composerPlaceholder}>
                  向总控主对话下达任务、查看 DAG 进度或复盘项目经验…
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
              {parentTask.title}
            </Text>
            <Text style={sceneStyles.drawerSubtitle} numberOfLines={1}>
              DevBox · paseo-fork · PR #527
            </Text>
          </View>
          <View
            style={sceneStyles.reviewBlockedStrip}
            testID="main-chat-task-drawer-delivery-gate-blocked"
          >
            <Text style={sceneStyles.reviewBlockedText}>
              交付门禁阻断：当前 PR 存在未消除的阻塞项，不能直接静默验收。
            </Text>
          </View>
          <TaskDrawerGovernanceStrip
            task={parentTask}
            allTasks={tasks}
            projectLessons={lessons}
            isMutatingTask={false}
            onStartReadyTask={noopTaskAction}
            onSelectRelatedTask={noopTaskAction}
          />
          <View style={sceneStyles.drawerAgentPreview}>
            <Text style={sceneStyles.drawerPreviewHeading}>子 Agent 执行流摘要</Text>
            <Text style={sceneStyles.drawerPreviewBody}>
              已提交 PR #527（分支 feat/main-chat-lessons-signals-and-dag），检测到合并冲突与
              server-unit-tests 失败，等待消除阻塞项后继续结项跟进（严禁自动合入）。
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

describe("Wave 3 (P1-1 / P1-2 / P1-3) real Chromium visual & layout verification", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fixtureClient: DaemonClient;
  let fixtureOverview: MainChatOverview;

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

    const lessons = makeFixtureLessons();
    const tasks = makeFixtureTasks();
    fixtureOverview = makeFixtureOverview(tasks, lessons);
    fixtureClient = makeFixtureClient(fixtureOverview, lessons);

    const now = new Date("2026-11-25T03:10:00.000Z");
    const mainAgent = {
      id: "agent_main",
      serverId: "srv_1",
      workspaceId: "ws_main",
      provider: "claude",
      status: "idle",
      cwd: "/data00/repo/paseo-fork",
      title: "总控主对话",
      createdAt: now,
      updatedAt: now,
      requiresAttention: false,
      attentionReason: null,
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      pendingPermissions: [],
      turn: { phase: "idle" as const },
    } as unknown as Agent;

    const parentAgent = {
      id: "agent_parent_w3",
      serverId: "srv_1",
      workspaceId: "ws_paseo",
      provider: "claude",
      status: "idle",
      cwd: "/data00/repo/paseo-fork",
      title: "Wave 3：教训沉淀、信号门禁与 DAG",
      createdAt: now,
      updatedAt: now,
      requiresAttention: false,
      attentionReason: null,
      labels: {},
      pendingPermissions: [],
      turn: { phase: "idle" as const },
    } as unknown as Agent;

    useSessionStore.setState({
      sessions: {
        srv_1: {
          client: fixtureClient,
          agents: new Map([
            ["agent_main", mainAgent],
            ["agent_parent_w3", parentAgent],
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
      await new Promise((resolve) => setTimeout(resolve, 60));
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

  it("01: renders wide 1440x900 light Settings -> Project Lessons Library cleanly with zero overflow", async () => {
    await page.viewport(1440, 900);

    renderInBrowser(
      <View style={sceneStyles.settingsShell} testID="wave3-settings-shell">
        <SettingsSection
          title="项目经验库"
          info="按项目/仓库规范化路径自动沉淀复盘避坑教训，向同一仓库派活时按确定性字节预算自动注入「项目历史教训」。"
          testID="settings-main-chat-project-lessons"
        >
          <MainChatProjectLessonsPanel serverId="srv_1" client={fixtureClient} />
        </SettingsSection>
      </View>,
    );
    await waitForLayoutFrame();

    expect(host.querySelector('[data-testid="main-chat-project-lessons-panel"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="project-lessons-group-0"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="project-lessons-group-1"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="project-lessons-item-les_1"]')).toBeTruthy();

    // Open Add Form so screenshot shows BOTH the manual creation UI and grouped project lessons
    act(() => {
      host.querySelector<HTMLElement>('[data-testid="project-lessons-add-toggle"]')?.click();
    });
    await waitForLayoutFrame();
    expect(host.querySelector('[data-testid="project-lessons-add-form"]')).toBeTruthy();

    const shell = host.querySelector<HTMLElement>('[data-testid="wave3-settings-shell"]')!;
    assertNoHorizontalOverflow(shell, "Wide 1440x900 Project Lessons Settings");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-wide-settings-lessons.png`,
    });
  });

  it("02: renders wide 1440x900 light Task DAG hierarchy, Delivery Gate guard, and <= 1px aligned Main Chat rail", async () => {
    await page.viewport(1440, 900);
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "inProgress" },
    });

    renderInBrowser(
      <Wave3MainChatSplitScene
        tasks={fixtureOverview.tasks ?? []}
        lessons={fixtureOverview.projectLessons ?? []}
        showDrawer
      />,
    );
    await waitForLayoutFrame();

    expect(host.querySelector('[data-testid="main-chat-task-drawer"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="main-chat-task-drawer-governance"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="main-chat-task-drawer-delivery-gate-blocked"]'),
    ).toBeTruthy();
    expect(host.querySelector('[data-testid="main-chat-task-drawer-children-list"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="main-chat-task-drawer-lessons-entry"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="main-chat-action-panel-inProgress"]')).toBeTruthy();
    expect(
      host.querySelector('[data-testid="main-chat-action-start-ready-task_slice_2"]'),
    ).toBeTruthy();

    // Assert Main Chat stream / tray / composer rail alignment <= 1px
    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="wave3-composer-baseline"]')!
      .getBoundingClientRect();
    const messageEl = host.querySelector<HTMLElement>('[data-testid="wave3-message-column"]');
    const actionInner = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-inner"]',
    );
    const drawerFrame = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-drawer-frame"]',
    );

    assertEdgeAligned("Wide Message column vs Composer", messageEl, composerBaseline);
    assertEdgeAligned("Wide ActionBar inner vs Composer", actionInner, composerBaseline);
    assertEdgeAligned("Wide ActionBar tray overlay vs Composer", drawerFrame, composerBaseline);

    const scene = host.querySelector<HTMLElement>('[data-testid="wave3-main-scene"]')!;
    assertNoHorizontalOverflow(scene, "Wide 1440x900 Task DAG & Delivery Gate");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-wide-task-dag-and-delivery-gate.png`,
    });
  });

  it("03: renders narrow 390x844 light layout with DAG/PR tray, compact dock, and Project Lessons panel with zero overflow", async () => {
    await page.viewport(390, 844);
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "inProgress" },
    });

    renderInBrowser(
      <View style={sceneStyles.narrowCompositeShell} testID="wave3-narrow-shell">
        <View style={sceneStyles.narrowTopChat}>
          <Wave3MainChatSplitScene
            tasks={fixtureOverview.tasks ?? []}
            lessons={fixtureOverview.projectLessons ?? []}
            showDrawer={false}
            compact
          />
        </View>
        <View style={sceneStyles.narrowLessonsWrap}>
          <SettingsSection title="项目经验库" testID="settings-main-chat-project-lessons-narrow">
            <MainChatProjectLessonsPanel serverId="srv_1" client={fixtureClient} />
          </SettingsSection>
        </View>
      </View>,
    );
    await waitForLayoutFrame();

    const narrowShell = host.querySelector<HTMLElement>('[data-testid="wave3-narrow-shell"]')!;
    assertNoHorizontalOverflow(narrowShell, "Narrow 390x844 Wave 3 Composite");

    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="wave3-composer-baseline"]')!
      .getBoundingClientRect();
    const actionInner = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-inner"]',
    );
    const drawerFrame = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-drawer-frame"]',
    );
    assertEdgeAligned("Narrow 390 ActionBar inner vs Composer", actionInner, composerBaseline);
    assertEdgeAligned("Narrow 390 ActionBar tray vs Composer", drawerFrame, composerBaseline);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-narrow-390-wave3.png`,
    });
  });

  it("04: renders wide 1440x900 dark theme with Task DAG, Delivery Gate guard, and <= 1px rail alignment", async () => {
    await page.viewport(1440, 900);
    UnistylesRuntime.setTheme("dark");
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "inProgress" },
    });

    renderInBrowser(
      <Wave3MainChatSplitScene
        tasks={fixtureOverview.tasks ?? []}
        lessons={fixtureOverview.projectLessons ?? []}
        showDrawer
      />,
    );
    await waitForLayoutFrame();

    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="wave3-composer-baseline"]')!
      .getBoundingClientRect();
    const messageEl = host.querySelector<HTMLElement>('[data-testid="wave3-message-column"]');
    const actionInner = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-inner"]',
    );
    const drawerFrame = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-drawer-frame"]',
    );

    assertEdgeAligned("Dark Wide Message vs Composer", messageEl, composerBaseline);
    assertEdgeAligned("Dark Wide ActionBar vs Composer", actionInner, composerBaseline);
    assertEdgeAligned("Dark Wide Tray vs Composer", drawerFrame, composerBaseline);

    const scene = host.querySelector<HTMLElement>('[data-testid="wave3-main-scene"]')!;
    assertNoHorizontalOverflow(scene, "Dark Wide 1440x900 Wave 3");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-wide-dark-wave3.png`,
    });
  });
});

const sceneStyles = StyleSheet.create((theme) => ({
  settingsShell: {
    width: "100%",
    minHeight: 900,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[8],
    paddingVertical: theme.spacing[6],
    alignSelf: "center",
    maxWidth: 960,
  },
  wideMainScene: {
    width: "100%",
    height: 900,
    flexDirection: "row",
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  narrowMainScene: {
    width: "100%",
    height: 410,
    flexDirection: "column",
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  narrowCompositeShell: {
    width: "100%",
    minHeight: 844,
    backgroundColor: theme.colors.surface0,
    gap: theme.spacing[2],
  },
  narrowTopChat: {
    width: "100%",
    height: 410,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  narrowLessonsWrap: {
    width: "100%",
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[3],
  },
  mainChatColumn: {
    flex: 1,
    minWidth: 0,
    minHeight: 0,
    flexDirection: "column",
    backgroundColor: theme.colors.surface0,
  },
  streamSurface: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    width: "100%",
    paddingTop: theme.spacing[4],
  },
  bottomStack: {
    width: "100%",
    flexShrink: 0,
  },
  streamTranscriptOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  streamTranscript: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    gap: theme.spacing[3],
  },
  messageBubble: {
    width: "100%",
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[1.5],
  },
  messageHeading: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  messageBody: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  composerOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[4],
    paddingTop: theme.spacing[1],
  },
  composerInner: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  composerPlaceholder: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  drawerPanel: {
    width: "42%",
    minWidth: 360,
    maxWidth: 560,
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexDirection: "column",
  },
  drawerHeader: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    gap: 2,
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
  reviewBlockedStrip: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.statusDangerTint,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  reviewBlockedText: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusDanger,
  },
  drawerAgentPreview: {
    padding: theme.spacing[4],
    gap: theme.spacing[2],
  },
  drawerPreviewHeading: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  drawerPreviewBody: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
}));
