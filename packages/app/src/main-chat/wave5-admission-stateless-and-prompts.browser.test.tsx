import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  type MainChatIdleArchiveAuditRecord,
  type MainChatOverview,
  type MainChatPromptTemplate,
  type MainChatResourceAdmissionSnapshot,
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
import { Autocomplete, type AutocompleteOption } from "@/components/ui/autocomplete";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatIdleArchiveAndPromptsPanel } from "@/screens/settings/main-chat/idle-archive-and-prompts-panel";
import { MainChatResourceAdmissionPanel } from "@/screens/settings/main-chat/resource-admission-panel";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import {
  MainChatActionBar,
  MainChatActionBarDrawerOverlay,
  useMainChatActionBarDrawerStore,
} from "./action-bar";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { useMainChatPromptLibraryStore } from "./prompt-library-store";
import { buildPromptSlashCommandEntries } from "./prompt-slash-commands";
import { useMainChatSettingsStore } from "./settings-store";
import { TaskDrawerGovernanceStrip } from "./task-drawer-governance-strip";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const browserToastApi = { show: vi.fn(), copied: vi.fn(), error: vi.fn(), dismiss: vi.fn() };

const SCREENSHOT_DIR =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_MAIN_CHAT_SCREENSHOT_DIR || "/tmp/main-chat-017529-screenshots";

const CUSTOM_TEMPLATES: readonly MainChatPromptTemplate[] = [
  {
    id: "tpl_release_check",
    slug: "release-check",
    title: "发版前回归检查",
    description: "按清单核对构建、类型检查与关键回归用例",
    content: "请针对 {{arg}} 执行发版前回归检查，并输出验证结果与阻塞项。",
    argumentHint: "<版本号或模块>",
    builtin: false,
    category: "custom",
    createdAt: "2026-11-25T07:00:00.000Z",
    updatedAt: "2026-11-25T07:00:00.000Z",
  },
  ...BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES,
];

function makeWave5Settings(): MainChatSettings {
  const base = createDefaultMainChatSettings();
  return {
    ...base,
    enabled: true,
    resourceAdmission: {
      enabled: true,
      maxConcurrentPerHost: 4,
      maxCpuPercent: 80,
      minFreeMemoryMb: 1024,
      queueWhenPressured: true,
    },
    statelessBackgroundSupervision: true,
    onDemandToolLoading: true,
    idleArchivePolicy: {
      enabled: true,
      idleThresholdMinutes: 60,
      sweepIntervalMinutes: 15,
      maxArchivePerSweep: 10,
    },
  };
}

function makeWave5AdmissionSnapshot(): MainChatResourceAdmissionSnapshot {
  const now = "2026-11-25T07:10:00.000Z";
  return {
    policy: {
      enabled: true,
      maxConcurrentPerHost: 4,
      maxCpuPercent: 80,
      minFreeMemoryMb: 1024,
      queueWhenPressured: true,
    },
    hosts: [
      {
        serverId: "srv_1",
        hostLabel: "DevBox-Main",
        isLocal: true,
        status: "pressured",
        cpuPercent: 91,
        loadAvg1m: 7.2,
        cpuCores: 8,
        freeMemoryMb: 1840,
        totalMemoryMb: 16384,
        activeManagedAgents: 4,
        maxConcurrent: 4,
        pressureReasons: ["concurrency_limit", "cpu_high"],
        pressureSummary: "活跃受管并发已达上限 (4/4)，CPU 91% 超过阈值 80%",
        sampledAt: now,
      },
      {
        serverId: "srv_2",
        hostLabel: "Build-Worker-02",
        isLocal: false,
        status: "healthy",
        cpuPercent: 26,
        loadAvg1m: 1.4,
        cpuCores: 16,
        freeMemoryMb: 12800,
        totalMemoryMb: 32768,
        activeManagedAgents: 1,
        maxConcurrent: 4,
        pressureReasons: [],
        pressureSummary: null,
        sampledAt: now,
      },
    ],
    queue: [
      {
        id: "admq_w5_1",
        taskId: "task_w5_queued",
        planId: "plan_w5",
        plannedTaskId: "pt_w5_1",
        mainAgentId: "agent_main",
        conversationId: "conv_main",
        title: "执行跨主机资源准入压力测试",
        targetServerId: "srv_1",
        hostLabel: "DevBox-Main",
        reasonCode: "cpu_high",
        reason: "DevBox-Main CPU 91% 超过阈值 80%，已自动排队等待资源释放",
        suggestion: "等待受管任务完成自动出队，或改派至健康主机 Build-Worker-02",
        position: 1,
        enqueuedAt: now,
        attempts: 1,
        lastEvaluatedAt: now,
      },
    ],
    summary: {
      enabled: true,
      totalHosts: 2,
      healthyHosts: 1,
      pressuredHosts: 1,
      offlineHosts: 0,
      queuedCount: 1,
      totalActiveManagedAgents: 5,
    },
    updatedAt: now,
  };
}

function makeWave5AuditRecords(): MainChatIdleArchiveAuditRecord[] {
  return [
    {
      id: "aud_w5_archived",
      agentId: "agent_done_old",
      serverId: "srv_1",
      title: "已验收子任务：同步 Wave 4 通知回执文档",
      taskId: "task_old_1",
      idleMinutes: 98,
      outcome: "archived",
      refusalCode: null,
      reason: "已结项且闲置 98 分钟（>= 60 分钟阈值），已安全归档",
      sweptAt: "2026-11-25T07:05:00.000Z",
      trigger: "scheduled",
    },
    {
      id: "aud_w5_refused_manual",
      agentId: "agent_manual_1",
      serverId: "srv_1",
      title: "用户手动调试会话：分析构建缓存",
      taskId: null,
      idleMinutes: 210,
      outcome: "refused",
      refusalCode: "is_manual_session",
      reason: "保守模式 A 安全红线：用户手动创建的会话绝不自动归档",
      sweptAt: "2026-11-25T07:05:00.000Z",
      trigger: "scheduled",
    },
    {
      id: "aud_w5_refused_pr",
      agentId: "agent_pr_followup",
      serverId: "srv_1",
      title: "持续跟进 PR #412 Review 意见",
      taskId: "task_pr_412",
      idleMinutes: 75,
      outcome: "refused",
      refusalCode: "has_active_pr_followup",
      reason: "保守模式 A 安全红线：关联任务仍处于活跃 PR 跟进状态，拒绝归档",
      sweptAt: "2026-11-25T07:05:00.000Z",
      trigger: "scheduled",
    },
  ];
}

function makeWave5Tasks(): MainChatTaskRecord[] {
  const now = "2026-11-25T07:10:00.000Z";
  const base = {
    mainAgentId: "agent_main",
    conversationId: "conv_main",
    planId: "plan_w5",
    mode: "write" as const,
    isolation: "worktree" as const,
    serverId: "srv_1",
    hostLabel: "DevBox-Main",
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
      id: "task_w5_queued",
      title: "执行跨主机资源准入压力测试",
      status: "open",
      brief: {
        goal: "验证 CPU / 内存 / 并发阈值超限时自动排队与资源释放后出队放行",
        doneWhen: ["排队状态徽章清晰展示", "支持自动与手动放行"],
        outOfBounds: ["不触碰线上 6767 进程"],
        scopeRevision: 1,
        updatedAt: now,
      },
      activeAgentId: null,
      agentIds: [],
      admissionState: {
        status: "queued",
        queueId: "admq_w5_1",
        position: 1,
        targetServerId: "srv_1",
        hostLabel: "DevBox-Main",
        reasonCode: "cpu_high",
        reason: "DevBox-Main CPU 91% 超过阈值 80%，已自动排队等待资源释放",
        suggestion: "等待受管任务完成自动出队，或改派至健康主机 Build-Worker-02",
        updatedAt: now,
      },
    },
    {
      ...base,
      id: "task_w5_running",
      title: "按需加载 MCP 延迟工具分组验证",
      status: "running",
      brief: {
        goal: "核验 core 常驻组与 tool_catalog / tool_load 动态激活链路",
        doneWhen: ["6 个延迟分组均可动态装载"],
        outOfBounds: [],
        scopeRevision: 1,
        updatedAt: now,
      },
      activeAgentId: "agent_w5_running",
      agentIds: ["agent_w5_running"],
    },
  ];
}

function buildSlashPromptAutocompleteOptions(): AutocompleteOption[] {
  return buildPromptSlashCommandEntries(CUSTOM_TEMPLATES).map((entry) => ({
    id: entry.name,
    label: `/${entry.name}`,
    icon: "skill",
    argumentHint: entry.argumentHint || undefined,
    description: entry.description,
    tag: "提示词",
  }));
}

const noopFn = () => undefined;

function Wave5MessageBubble(): ReactElement {
  return (
    <View style={sceneStyles.streamTranscriptOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
      <View style={sceneStyles.streamTranscript}>
        <View style={sceneStyles.messageBubble} testID="wave5-message-column">
          <Text style={sceneStyles.messageHeading}>
            总控主对话 · Wave 5 资源准入、无状态督办与 / 提示词库
          </Text>
          <Text style={sceneStyles.messageBody}>
            无状态单轮后台督办已静默处理 7 轮例行检查且未干扰主对话 Prompt Cache；DevBox-Main
            当前受压，新派发任务已自动进入资源准入队列 #1；输入 /
            可直接检索内置与自定义快捷提示词模板并支持 {"{{arg}}"} 展开。
          </Text>
        </View>
      </View>
    </View>
  );
}

function Wave5MainChatSplitScene({
  tasks,
  showDrawer = true,
  compact = false,
}: {
  tasks: readonly MainChatTaskRecord[];
  showDrawer?: boolean;
  compact?: boolean;
}): ReactElement {
  const queuedTask = tasks[0]!;
  const promptOptions = buildSlashPromptAutocompleteOptions();

  return (
    <View
      style={compact ? sceneStyles.narrowMainScene : sceneStyles.wideMainScene}
      testID="wave5-main-scene"
    >
      <View style={sceneStyles.mainChatColumn} testID="wave5-main-column">
        <ChatColumnRailSurface serverId="srv_1">
          <View style={sceneStyles.streamSurface} testID="wave5-stream-surface">
            <Wave5MessageBubble />
            <MainChatActionBarDrawerOverlay serverId="srv_1" agentId="agent_main" />
          </View>

          <View style={sceneStyles.bottomStack}>
            <MainChatActionBar serverId="srv_1" agentId="agent_main" drawerMode="external" />

            <View style={sceneStyles.autocompleteOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
              <View style={sceneStyles.autocompleteInner} testID="wave5-slash-prompt-popup">
                <Autocomplete
                  options={promptOptions}
                  selectedIndex={0}
                  onSelect={noopFn}
                  maxHeight={compact ? 172 : 264}
                />
              </View>
            </View>

            <View style={sceneStyles.composerOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
              <View style={sceneStyles.composerInner} testID="wave5-composer-baseline">
                <Text style={sceneStyles.composerActiveSlash}>/release-check Wave 5</Text>
              </View>
            </View>
          </View>
        </ChatColumnRailSurface>
      </View>

      {showDrawer ? (
        <View style={sceneStyles.drawerPanel} testID="main-chat-task-drawer">
          <View style={sceneStyles.drawerHeader}>
            <Text style={sceneStyles.drawerTitle} numberOfLines={1}>
              {queuedTask.title}
            </Text>
            <Text style={sceneStyles.drawerSubtitle} numberOfLines={1}>
              DevBox-Main · paseo-fork · 资源排队 #1
            </Text>
          </View>
          <TaskDrawerGovernanceStrip
            task={queuedTask}
            allTasks={tasks}
            projectLessons={[]}
            isMutatingTask={false}
            onStartReadyTask={noopFn}
            onReleaseQueuedTask={noopFn}
            onSelectRelatedTask={noopFn}
          />
          <View style={sceneStyles.drawerAgentPreview}>
            <Text style={sceneStyles.drawerPreviewHeading}>跨主机资源准入说明</Text>
            <Text style={sceneStyles.drawerPreviewBody}>
              当前主机 DevBox-Main 活跃受管并发 4/4 且 CPU 达 91%。系统已将该任务安全排入等待队列
              #1，待任一受管子任务完成或负载回落后自动出队派发；也可点击上方「手动放行」立即执行。
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

describe("Wave 5 (P2-2 / P2-3 / P2-4) real Chromium visual & layout verification", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fixtureSettings: MainChatSettings;
  let fixtureClient: DaemonClient;
  let fixtureOverview: MainChatOverview;
  let fixtureAdmissionSnapshot: MainChatResourceAdmissionSnapshot;
  let fixtureAuditRecords: MainChatIdleArchiveAuditRecord[];

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

    fixtureSettings = makeWave5Settings();
    fixtureAdmissionSnapshot = makeWave5AdmissionSnapshot();
    fixtureAuditRecords = makeWave5AuditRecords();
    const tasks = makeWave5Tasks();

    fixtureOverview = {
      plans: [],
      decisions: [],
      autoStartRules: [],
      permissionRules: [],
      metrics: {
        autoContinued: 2,
        plansCreated: 4,
        plansAutoStarted: 1,
        plansStarted: 3,
        plansCancelled: 0,
        receiptsRecorded: 3,
        interrupts: 0,
        supervisorHeld: 5,
        reworkCount: 0,
        stalledNudges: 0,
        usageLimitRetries: 0,
        statelessSupervisionRounds: 7,
        statelessSupervisionEscalations: 1,
        admissionQueued: 2,
        admissionRejected: 0,
        idleSubagentsArchived: 1,
      },
      tasks,
      triages: [],
      settings: fixtureSettings,
      resourceAdmission: fixtureAdmissionSnapshot,
      idleArchiveAudit: fixtureAuditRecords,
      promptLibraryCount: CUSTOM_TEMPLATES.length,
    };

    fixtureClient = {
      getMainChatOverview: vi.fn(async () => ({
        requestId: "req_ov",
        overview: fixtureOverview,
        error: null,
      })),
      getMainChatResourceAdmission: vi.fn(async () => ({
        requestId: "req_adm",
        snapshot: fixtureAdmissionSnapshot,
        error: null,
      })),
      drainMainChatAdmissionQueue: vi.fn(async () => ({
        requestId: "req_drain",
        action: "drain" as const,
        dispatchedCount: 0,
        removedCount: 0,
        remainingCount: 1,
        snapshot: fixtureAdmissionSnapshot,
        error: null,
      })),
      sweepMainChatIdleSubagents: vi.fn(async () => ({
        requestId: "req_sweep",
        result: {
          dryRun: true,
          evaluatedCount: 3,
          eligibleCount: 1,
          archivedCount: 1,
          refusedCount: 2,
          failedCount: 0,
          archived: [fixtureAuditRecords[0]!],
          eligible: [],
          refused: fixtureAuditRecords.slice(1),
          auditLog: fixtureAuditRecords,
          sweptAt: "2026-11-25T07:05:00.000Z",
        },
        error: null,
      })),
      listMainChatPromptLibrary: vi.fn(async () => ({
        requestId: "req_tpl_list",
        templates: [...CUSTOM_TEMPLATES],
        error: null,
      })),
    } as unknown as DaemonClient;

    const now = new Date("2026-11-25T07:10:00.000Z");
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
        requiresAttention: false,
        attentionReason: null,
        labels,
        pendingPermissions: [],
        turn: { phase: status === "running" ? ("open" as const) : ("idle" as const) },
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
            ["agent_w5_running", makeAgent("agent_w5_running", tasks[1]!.title, "running", {})],
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
      notificationSummaryByServerId: {},
      usageByServerId: {},
      usageLoadingByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
    useMainChatPromptLibraryStore.setState({
      templatesByServerId: { srv_1: CUSTOM_TEMPLATES },
      loadingByServerId: {},
      loadedByServerId: { srv_1: true },
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
    queryClient.clear();
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

  it("01: renders wide 1440x900 light Settings -> Resource Admission, Runtime Switches, Idle Archive & / Prompt Library cleanly", async () => {
    await page.viewport(1440, 900);

    renderInBrowser(
      <View style={sceneStyles.settingsDualGrid} testID="wave5-settings-shell">
        <View style={sceneStyles.settingsCol}>
          <SettingsSection
            title="跨主机资源准入与运行减负"
            info="派发子任务前校验主机负载，支持受压自动排队、无状态单轮督办与 MCP 工具按需加载。"
            testID="settings-main-chat-resource-admission"
          >
            <MainChatResourceAdmissionPanel
              serverId="srv_1"
              client={fixtureClient}
              settings={fixtureSettings}
              metrics={fixtureOverview.metrics}
              initialSnapshot={fixtureAdmissionSnapshot}
              onApplyPatch={noopFn}
            />
          </SettingsSection>
        </View>
        <View style={sceneStyles.settingsCol}>
          <SettingsSection
            title="闲置清理与快捷提示词库"
            info="定时安全归档已结项闲置子会话（严格遵守保守模式 A 红线），管理 / 快捷提示词模板。"
            testID="settings-main-chat-idle-archive-prompts"
          >
            <MainChatIdleArchiveAndPromptsPanel
              serverId="srv_1"
              client={fixtureClient}
              settings={fixtureSettings}
              initialAuditLog={fixtureAuditRecords}
              initialTemplates={CUSTOM_TEMPLATES}
              onApplyPatch={noopFn}
            />
          </SettingsSection>
        </View>
      </View>,
    );
    await waitForLayoutFrame();

    expect(host.querySelector('[data-testid="main-chat-resource-admission-panel"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="admission-host-row-srv_1"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="admission-queue-row-admq_w5_1"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="runtime-tool-groups-badges"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="main-chat-idle-archive-prompts-panel"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="idle-archive-redline-callout"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="prompt-template-row-release-check"]')).toBeTruthy();

    const shell = host.querySelector<HTMLElement>('[data-testid="wave5-settings-shell"]')!;
    expect(shell.textContent).not.toContain("mainChat.");
    assertNoHorizontalOverflow(
      shell,
      "Wide 1440x900 Settings Resource Admission & Idle Archive + Prompts",
    );

    await page.viewport(1440, Math.max(900, Math.ceil(shell.scrollHeight)));
    await waitForLayoutFrame();
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-wide-settings-admission-and-runtime.png`,
    });
  });

  it("02: renders wide 1440x900 light / Slash Prompt Popup, Queued Admission Badge, Task Drawer & <= 1px aligned rail", async () => {
    await page.viewport(1440, 900);
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "inProgress" },
      expandedByKey: {},
      focusedNeedsIdByKey: {},
      compactDockCollapsedByKey: {},
    });

    renderInBrowser(<Wave5MainChatSplitScene tasks={fixtureOverview.tasks!} showDrawer />);
    await waitForLayoutFrame();

    const scene = host.querySelector<HTMLElement>('[data-testid="wave5-main-scene"]')!;
    const composer = host.querySelector<HTMLElement>('[data-testid="wave5-composer-baseline"]')!;
    const composerRect = composer.getBoundingClientRect();

    assertEdgeAligned(
      "Main Chat message column",
      host.querySelector<HTMLElement>('[data-testid="wave5-message-column"]'),
      composerRect,
    );
    assertEdgeAligned(
      "Action Bar inner rail",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-inner"]'),
      composerRect,
    );
    assertEdgeAligned(
      "Action Bar drawer frame",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-drawer-frame"]'),
      composerRect,
    );
    assertEdgeAligned(
      "Slash prompt autocomplete popup",
      host.querySelector<HTMLElement>('[data-testid="wave5-slash-prompt-popup"]'),
      composerRect,
    );

    expect(
      host.querySelector(
        '[data-testid="main-chat-action-task-admission-badge-task:task_w5_queued"]',
      ),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="main-chat-task-drawer-admission-badge"]'),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="main-chat-task-drawer-admission-release"]'),
    ).toBeTruthy();
    expect(scene.textContent).toContain("/release-check");
    expect(scene.textContent).toContain("资源排队 #1");
    expect(scene.textContent).not.toContain("mainChat.");

    assertNoHorizontalOverflow(scene, "Wide 1440x900 Slash Prompts & Queued Task Scene");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-wide-slash-prompts-and-queue.png`,
      element: scene,
    });
  });

  it("03: renders narrow 390x844 light Wave 5 mobile layout with zero horizontal overflow and <= 1px rail alignment", async () => {
    await page.viewport(390, 844);

    renderInBrowser(
      <View style={sceneStyles.narrowComposite} testID="wave5-narrow-shell">
        <Wave5MainChatSplitScene tasks={fixtureOverview.tasks!} showDrawer={false} compact />

        <View style={sceneStyles.narrowSettingsWrap}>
          <SettingsSection title="跨主机资源准入与运行减负" testID="settings-narrow-admission">
            <MainChatResourceAdmissionPanel
              serverId="srv_1"
              client={fixtureClient}
              settings={fixtureSettings}
              metrics={fixtureOverview.metrics}
              initialSnapshot={fixtureAdmissionSnapshot}
              onApplyPatch={noopFn}
            />
          </SettingsSection>
          <SettingsSection title="闲置清理与快捷提示词库" testID="settings-narrow-idle-prompts">
            <MainChatIdleArchiveAndPromptsPanel
              serverId="srv_1"
              client={fixtureClient}
              settings={fixtureSettings}
              initialAuditLog={fixtureAuditRecords}
              initialTemplates={CUSTOM_TEMPLATES}
              onApplyPatch={noopFn}
            />
          </SettingsSection>
        </View>
      </View>,
    );
    await waitForLayoutFrame();

    const shell = host.querySelector<HTMLElement>('[data-testid="wave5-narrow-shell"]')!;
    const composer = host.querySelector<HTMLElement>('[data-testid="wave5-composer-baseline"]')!;
    const composerRect = composer.getBoundingClientRect();

    assertEdgeAligned(
      "Narrow 390px message column",
      host.querySelector<HTMLElement>('[data-testid="wave5-message-column"]'),
      composerRect,
    );
    assertEdgeAligned(
      "Narrow 390px Action Bar inner rail",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-inner"]'),
      composerRect,
    );
    assertEdgeAligned(
      "Narrow 390px slash prompt popup",
      host.querySelector<HTMLElement>('[data-testid="wave5-slash-prompt-popup"]'),
      composerRect,
    );

    expect(shell.textContent).toContain("资源排队 #1");
    expect(shell.textContent).toContain("/release-check");
    expect(shell.textContent).not.toContain("mainChat.");
    assertNoHorizontalOverflow(shell, "Narrow 390x844 Wave 5 Composite");

    await page.viewport(390, Math.max(844, Math.ceil(shell.scrollHeight)));
    await waitForLayoutFrame();
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-narrow-390-wave5.png`,
    });
  });

  it("04: renders wide 1440x900 dark theme Wave 5 scene cleanly with zero overflow and <= 1px rail alignment", async () => {
    await page.viewport(1440, 900);
    UnistylesRuntime.setTheme("dark");
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "inProgress" },
      expandedByKey: {},
      focusedNeedsIdByKey: {},
      compactDockCollapsedByKey: {},
    });

    renderInBrowser(
      <View style={sceneStyles.darkRootShell} testID="wave5-dark-shell">
        <Wave5MainChatSplitScene tasks={fixtureOverview.tasks!} showDrawer />
      </View>,
    );
    await waitForLayoutFrame();

    const shell = host.querySelector<HTMLElement>('[data-testid="wave5-dark-shell"]')!;
    const composer = host.querySelector<HTMLElement>('[data-testid="wave5-composer-baseline"]')!;
    const composerRect = composer.getBoundingClientRect();

    assertEdgeAligned(
      "Dark wide message column",
      host.querySelector<HTMLElement>('[data-testid="wave5-message-column"]'),
      composerRect,
    );
    assertEdgeAligned(
      "Dark wide Action Bar inner rail",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-inner"]'),
      composerRect,
    );
    assertEdgeAligned(
      "Dark wide Action Bar drawer frame",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-drawer-frame"]'),
      composerRect,
    );
    assertEdgeAligned(
      "Dark wide slash prompt popup",
      host.querySelector<HTMLElement>('[data-testid="wave5-slash-prompt-popup"]'),
      composerRect,
    );

    expect(shell.textContent).toContain("/release-check");
    expect(shell.textContent).toContain("资源排队 #1");
    expect(shell.textContent).not.toContain("mainChat.");
    assertNoHorizontalOverflow(shell, "Wide 1440x900 Dark Wave 5 Scene");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-wide-dark-wave5.png`,
      element: shell,
    });
  });
});

const sceneStyles = StyleSheet.create((theme) => ({
  settingsDualGrid: {
    width: "100%",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 20,
    padding: 20,
    backgroundColor: theme.colors.surface0,
  },
  settingsCol: {
    flex: 1,
    minWidth: 0,
  },
  wideMainScene: {
    width: "100%",
    height: 860,
    flexDirection: "row",
    backgroundColor: theme.colors.surface0,
  },
  narrowMainScene: {
    width: "100%",
    height: 440,
    flexDirection: "column",
    backgroundColor: theme.colors.surface0,
  },
  darkRootShell: {
    width: "100%",
    backgroundColor: theme.colors.surface0,
  },
  narrowComposite: {
    width: "100%",
    backgroundColor: theme.colors.surface0,
  },
  narrowSettingsWrap: {
    padding: 12,
    gap: 16,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  mainChatColumn: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
  },
  streamSurface: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
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
    width: "100%",
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[1.5],
  },
  messageHeading: {
    fontSize: 13,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  messageBody: {
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  bottomStack: {
    width: "100%",
    alignItems: "stretch",
    backgroundColor: theme.colors.surface0,
  },
  autocompleteOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[1.5],
  },
  autocompleteInner: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
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
    minHeight: 46,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  composerActiveSlash: {
    fontSize: 13,
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
  },
  drawerPanel: {
    width: 480,
    height: "100%",
    backgroundColor: theme.colors.surface0,
  },
  drawerHeader: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    gap: 2,
  },
  drawerTitle: {
    fontSize: 15,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  drawerSubtitle: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  drawerAgentPreview: {
    margin: theme.spacing[4],
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[1.5],
  },
  drawerPreviewHeading: {
    fontSize: 13,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  drawerPreviewBody: {
    fontSize: 12,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
  },
}));
