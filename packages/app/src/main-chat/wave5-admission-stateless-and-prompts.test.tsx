// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES,
  createDefaultMainChatSettings,
  type MainChatIdleArchiveAuditRecord,
  type MainChatIdleArchiveSweepResult,
  type MainChatOverview,
  type MainChatPromptTemplate,
  type MainChatResourceAdmissionSnapshot,
  type MainChatSettings,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatIdleArchiveAndPromptsPanel } from "@/screens/settings/main-chat/idle-archive-and-prompts-panel";
import { MainChatResourceAdmissionPanel } from "@/screens/settings/main-chat/resource-admission-panel";
import { filterAndRankCommandAutocompleteEntries } from "@/utils/agent-command-autocomplete";
import { buildMainChatActionBarModel } from "./action-bar-model";
import { deriveTaskAdmissionBadge, isTaskAdmissionQueued } from "./admission-ui";
import { useMainChatPromptLibraryStore } from "./prompt-library-store";
import {
  applyPromptTemplateAutocompleteReplacement,
  buildPromptSlashCommandEntries,
  expandPromptTemplateSubmissionText,
} from "./prompt-slash-commands";
import { TaskDrawerGovernanceStrip } from "./task-drawer-governance-strip";

const routerPushMock = vi.fn();

vi.mock("expo-router", () => ({
  router: {
    push: (...args: unknown[]) => routerPushMock(...args),
  },
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
      enabled: false,
      idleThresholdMinutes: 60,
      sweepIntervalMinutes: 15,
      maxArchivePerSweep: 10,
    },
  };
}

function makeAdmissionSnapshot(): MainChatResourceAdmissionSnapshot {
  const now = "2026-11-25T07:00:00.000Z";
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
        serverId: "srv_local",
        hostLabel: "DevBox-Local",
        isLocal: true,
        status: "pressured",
        cpuPercent: 92,
        loadAvg1m: 7.4,
        cpuCores: 8,
        freeMemoryMb: 2048,
        totalMemoryMb: 16384,
        activeManagedAgents: 4,
        maxConcurrent: 4,
        pressureReasons: ["concurrency_limit", "cpu_high"],
        pressureSummary: "活跃受管并发已达上限 (4/4)，CPU 92% > 80%",
        sampledAt: now,
      },
      {
        serverId: "srv_remote",
        hostLabel: "GPU-Worker-02",
        isLocal: false,
        status: "healthy",
        cpuPercent: 28,
        loadAvg1m: 1.2,
        cpuCores: 16,
        freeMemoryMb: 14336,
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
        id: "admq_1",
        taskId: "task_q1",
        planId: "plan_w5",
        plannedTaskId: "pt_1",
        mainAgentId: "agent_main",
        conversationId: "conv_main",
        title: "补齐跨主机资源准入回归测试",
        targetServerId: "srv_local",
        hostLabel: "DevBox-Local",
        reasonCode: "cpu_high",
        reason: "DevBox-Local CPU 92% 超过上限 80%，已自动排队等待资源释放",
        suggestion: "可等待当前子任务完成，或改派至健康主机 GPU-Worker-02",
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

function makeQueuedTask(): MainChatTaskRecord {
  const now = "2026-11-25T07:00:00.000Z";
  return {
    id: "task_q1",
    mainAgentId: "agent_main",
    conversationId: "conv_main",
    planId: "plan_w5",
    title: "补齐跨主机资源准入回归测试",
    mode: "write",
    isolation: "worktree",
    serverId: "srv_local",
    hostLabel: "DevBox-Local",
    cwd: "/repo/paseo-fork",
    workspaceId: "ws_paseo",
    workspaceLabel: "paseo-fork",
    status: "open",
    brief: {
      goal: "验证资源准入队列、自动放行与 UI 状态徽章",
      doneWhen: ["单测与浏览器回归全绿"],
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
    admissionState: {
      status: "queued",
      queueId: "admq_1",
      position: 1,
      targetServerId: "srv_local",
      hostLabel: "DevBox-Local",
      reasonCode: "cpu_high",
      reason: "DevBox-Local CPU 92% 超过上限 80%",
      suggestion: "可改派至 GPU-Worker-02 或点击手动放行",
      updatedAt: now,
    },
  };
}

const SAMPLE_WAVE5_METRICS = {
  autoContinued: 0,
  plansCreated: 2,
  plansAutoStarted: 0,
  plansStarted: 2,
  plansCancelled: 0,
  receiptsRecorded: 1,
  interrupts: 0,
  supervisorHeld: 3,
  reworkCount: 0,
  stalledNudges: 0,
  usageLimitRetries: 0,
  statelessSupervisionRounds: 7,
  statelessSupervisionEscalations: 1,
};

function makeMockDaemonClient(overrides: Record<string, unknown>): DaemonClient {
  return overrides as unknown as DaemonClient;
}

const CUSTOM_RELEASE_TEMPLATE: MainChatPromptTemplate = {
  id: "tpl_release_check",
  slug: "release-check",
  title: "发版前回归检查",
  description: "逐项核对构建、类型检查与关键回归测试",
  content: "请针对 {{arg}} 执行完整发版前回归检查，并输出验证清单与阻塞项。",
  argumentHint: "<模块或版本号>",
  builtin: false,
  category: "custom",
  createdAt: "2026-11-25T07:00:00.000Z",
  updatedAt: "2026-11-25T07:00:00.000Z",
};

describe("Wave 5 App unit tests: Resource Admission, Stateless Runtime, Idle Archive & / Prompt Library", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMainChatPromptLibraryStore.setState({
      templatesByServerId: {},
      loadingByServerId: {},
      loadedByServerId: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders MainChatResourceAdmissionPanel, saves thresholds, toggles runtime switches, and drains/forces queue", async () => {
    const onApplyPatch = vi.fn();
    const snapshot = makeAdmissionSnapshot();
    const drainedSnapshot: MainChatResourceAdmissionSnapshot = {
      ...snapshot,
      queue: [],
      summary: { ...snapshot.summary, queuedCount: 0 },
    };
    const drainMock = vi.fn(async () => ({
      requestId: "req_drain",
      action: "force_dispatch" as const,
      dispatchedCount: 1,
      removedCount: 0,
      remainingCount: 0,
      snapshot: drainedSnapshot,
      error: null,
    }));
    const client = makeMockDaemonClient({
      getMainChatResourceAdmission: vi.fn(async () => ({
        requestId: "req_get",
        snapshot,
        error: null,
      })),
      drainMainChatAdmissionQueue: drainMock,
    });

    const { getByTestId, queryByTestId } = render(
      wrap(
        <MainChatResourceAdmissionPanel
          serverId="srv_local"
          client={client}
          settings={makeWave5Settings()}
          metrics={SAMPLE_WAVE5_METRICS}
          initialSnapshot={snapshot}
          onApplyPatch={onApplyPatch}
        />,
      ),
    );

    expect(getByTestId("admission-host-row-srv_local")).toBeTruthy();
    expect(getByTestId("admission-host-row-srv_remote")).toBeTruthy();
    expect(getByTestId("admission-queue-row-admq_1")).toBeTruthy();
    expect(getByTestId("runtime-stateless-metrics").textContent).toContain('"rounds":7');
    expect(getByTestId("runtime-tool-groups-badges").textContent).toContain("memory");

    // Change threshold inputs and save
    fireEvent.change(getByTestId("admission-threshold-concurrent"), { target: { value: "6" } });
    fireEvent.change(getByTestId("admission-threshold-cpu"), { target: { value: "90" } });
    fireEvent.change(getByTestId("admission-threshold-memory"), { target: { value: "2048" } });
    fireEvent.click(getByTestId("admission-thresholds-save"));

    expect(onApplyPatch).toHaveBeenCalledWith(
      {
        resourceAdmission: {
          maxConcurrentPerHost: 6,
          maxCpuPercent: 90,
          minFreeMemoryMb: 2048,
        },
      },
      "mainChat.resourceAdmission.thresholdsSavedToast",
    );

    // Toggle stateless supervision & on-demand tool loading
    fireEvent.click(getByTestId("settings-main-chat-stateless-supervision"));
    expect(onApplyPatch).toHaveBeenCalledWith(
      { statelessBackgroundSupervision: false },
      "mainChat.runtimeOptimization.statelessDisabledToast",
    );
    fireEvent.click(getByTestId("settings-main-chat-on-demand-tools"));
    expect(onApplyPatch).toHaveBeenCalledWith(
      { onDemandToolLoading: false },
      "mainChat.runtimeOptimization.onDemandToolsDisabledToast",
    );

    // Force-dispatch queued entry
    fireEvent.click(getByTestId("admission-queue-force-admq_1"));
    await waitFor(() => {
      expect(drainMock).toHaveBeenCalledWith({ action: "force_dispatch", queueId: "admq_1" });
    });
    await waitFor(() => {
      expect(queryByTestId("admission-queue-row-admq_1")).toBeNull();
    });
  });

  it("renders MainChatIdleArchiveAndPromptsPanel, runs dry-run sweep, and creates/deletes custom / prompt templates", async () => {
    const onApplyPatch = vi.fn();
    const auditRefused: MainChatIdleArchiveAuditRecord = {
      id: "aud_ref_1",
      agentId: "agent_manual_1",
      serverId: "srv_local",
      title: "用户手动调试会话",
      taskId: null,
      idleMinutes: 185,
      outcome: "refused",
      refusalCode: "is_manual_session",
      reason: "保守模式 A 红线：用户手动创建的会话绝不自动归档",
      sweptAt: "2026-11-25T07:05:00.000Z",
      trigger: "manual",
    };
    const auditEligible: MainChatIdleArchiveAuditRecord = {
      id: "aud_elig_1",
      agentId: "agent_done_1",
      serverId: "srv_local",
      title: "已验收子任务：修复构建脚本",
      taskId: "task_done_1",
      idleMinutes: 94,
      outcome: "eligible",
      refusalCode: null,
      reason: "已结项且闲置 94 分钟（>= 60 分钟阈值），可安全归档",
      sweptAt: "2026-11-25T07:05:00.000Z",
      trigger: "manual",
    };
    const sweepResult: MainChatIdleArchiveSweepResult = {
      dryRun: true,
      evaluatedCount: 2,
      eligibleCount: 1,
      archivedCount: 0,
      refusedCount: 1,
      failedCount: 0,
      archived: [],
      eligible: [auditEligible],
      refused: [auditRefused],
      auditLog: [auditEligible, auditRefused],
      sweptAt: "2026-11-25T07:05:00.000Z",
    };
    const allTemplates = [...BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES, CUSTOM_RELEASE_TEMPLATE];
    const sweepMock = vi.fn(async () => ({
      requestId: "req_sweep",
      result: sweepResult,
      error: null,
    }));
    const savePromptMock = vi.fn(
      async (input: { slug: string; title: string; content: string }) => {
        const created: MainChatPromptTemplate = {
          id: "tpl_new_1",
          slug: input.slug,
          title: input.title,
          description: "desc",
          content: input.content,
          argumentHint: "<scope>",
          builtin: false,
          category: "custom",
          createdAt: "2026-11-25T07:10:00.000Z",
          updatedAt: "2026-11-25T07:10:00.000Z",
        };
        return {
          requestId: "req_save_tpl",
          template: created,
          templates: [...allTemplates, created],
          error: null,
        };
      },
    );
    const deletePromptMock = vi.fn(async () => ({
      requestId: "req_del_tpl",
      deleted: true,
      templates: [...BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES],
      error: null,
    }));
    const client = makeMockDaemonClient({
      sweepMainChatIdleSubagents: sweepMock,
      listMainChatPromptLibrary: vi.fn(async () => ({
        requestId: "req_list_tpl",
        templates: allTemplates,
        error: null,
      })),
      saveMainChatPromptTemplate: savePromptMock,
      deleteMainChatPromptTemplate: deletePromptMock,
    });

    const { getByTestId, queryByTestId } = render(
      wrap(
        <MainChatIdleArchiveAndPromptsPanel
          serverId="srv_local"
          client={client}
          settings={makeWave5Settings()}
          initialTemplates={allTemplates}
          onApplyPatch={onApplyPatch}
        />,
      ),
    );

    expect(getByTestId("idle-archive-redline-callout")).toBeTruthy();
    expect(getByTestId("prompt-template-row-review")).toBeTruthy();
    expect(getByTestId("prompt-template-row-release-check")).toBeTruthy();

    // Update threshold and save
    fireEvent.change(getByTestId("idle-archive-threshold-input"), { target: { value: "90" } });
    fireEvent.click(getByTestId("idle-archive-save-policy"));
    expect(onApplyPatch).toHaveBeenCalledWith(
      { idleArchivePolicy: { idleThresholdMinutes: 90 } },
      "mainChat.idleArchive.policySavedToast",
    );

    // Dry-run sweep renders eligible + refused red-line records
    fireEvent.click(getByTestId("idle-archive-dry-run"));
    await waitFor(() => {
      expect(sweepMock).toHaveBeenCalledWith({ dryRun: true });
      expect(getByTestId("idle-archive-audit-row-aud_elig_1")).toBeTruthy();
      expect(getByTestId("idle-archive-audit-row-aud_ref_1")).toBeTruthy();
    });

    // Create a custom prompt template with {{arg}} live preview
    fireEvent.click(getByTestId("prompt-library-new"));
    fireEvent.change(getByTestId("prompt-editor-slug"), { target: { value: "smoke-test" } });
    fireEvent.change(getByTestId("prompt-editor-title"), { target: { value: "冒烟回归" } });
    fireEvent.change(getByTestId("prompt-editor-content"), {
      target: { value: "请对 {{arg}} 执行快速冒烟校验" },
    });
    expect(getByTestId("prompt-editor-preview").textContent).toContain(
      "请对 Wave 5 执行快速冒烟校验",
    );

    fireEvent.click(getByTestId("prompt-editor-save"));
    await waitFor(() => {
      expect(savePromptMock).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: "smoke-test",
          title: "冒烟回归",
          content: "请对 {{arg}} 执行快速冒烟校验",
        }),
      );
      expect(queryByTestId("prompt-template-editor")).toBeNull();
    });

    // Delete custom template
    fireEvent.click(getByTestId("prompt-template-delete-release-check"));
    await waitFor(() => {
      expect(deletePromptMock).toHaveBeenCalledWith({
        id: "tpl_release_check",
        slug: "release-check",
      });
    });
    await waitFor(() => {
      expect(queryByTestId("prompt-template-row-release-check")).toBeNull();
    });
  });

  it("classifies queued tasks into Action Bar inProgress.active and renders TaskDrawerGovernanceStrip release control", () => {
    const queuedTask = makeQueuedTask();
    expect(isTaskAdmissionQueued(queuedTask)).toBe(true);
    const badge = deriveTaskAdmissionBadge(queuedTask.admissionState);
    expect(badge?.status).toBe("queued");
    expect(badge?.position).toBe(1);

    const overview: MainChatOverview = {
      plans: [],
      decisions: [],
      autoStartRules: [],
      permissionRules: [],
      metrics: {
        autoContinued: 0,
        plansCreated: 1,
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
      tasks: [queuedTask],
      triages: [],
      settings: makeWave5Settings(),
    };

    const model = buildMainChatActionBarModel({
      serverId: "srv_local",
      mainAgentId: "agent_main",
      overview,
      liveAgents: [],
      pendingPermissions: [],
    });
    expect(model.inProgress.active).toHaveLength(1);
    expect(model.inProgress.active[0]?.admissionState?.status).toBe("queued");
    expect(model.inProgress.active[0]?.isLiveRunning).toBe(false);

    const onRelease = vi.fn();
    const { getByTestId } = render(
      wrap(
        <TaskDrawerGovernanceStrip
          task={queuedTask}
          allTasks={[queuedTask]}
          projectLessons={[]}
          isMutatingTask={false}
          onStartReadyTask={vi.fn()}
          onReleaseQueuedTask={onRelease}
          onSelectRelatedTask={vi.fn()}
        />,
      ),
    );

    expect(getByTestId("main-chat-task-drawer-admission-badge")).toBeTruthy();
    expect(getByTestId("main-chat-task-drawer-admission-detail").textContent).toContain(
      "DevBox-Local",
    );
    fireEvent.click(getByTestId("main-chat-task-drawer-admission-release"));
    expect(onRelease).toHaveBeenCalledWith("admq_1");
  });

  it("integrates / prompt library templates into slash autocomplete ranking, replacement, and {{arg}} submit expansion", () => {
    const templates = [...BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES, CUSTOM_RELEASE_TEMPLATE];
    const promptEntries = buildPromptSlashCommandEntries(templates).map((command) => ({
      source: "prompt" as const,
      command,
    }));
    const entries = [
      { source: "client" as const, command: { name: "exit" } },
      ...promptEntries,
      { source: "provider" as const, command: { name: "compact" } },
    ];

    // Empty query ranks provider -> prompt -> client (and does not drop prompt templates)
    const allOrdered = filterAndRankCommandAutocompleteEntries(entries, "");
    expect(allOrdered[0]?.source).toBe("provider");
    expect(
      allOrdered.some((e) => e.source === "prompt" && e.command.name === "release-check"),
    ).toBe(true);
    expect(allOrdered.at(-1)?.source).toBe("client");

    // Prefix search matches custom slug and Chinese title alias
    const bySlug = filterAndRankCommandAutocompleteEntries(entries, "release");
    expect(bySlug[0]?.command.name).toBe("release-check");

    const byTitle = filterAndRankCommandAutocompleteEntries(entries, "发版");
    expect(byTitle[0]?.command.name).toBe("release-check");

    // Selecting a template with trailing text expands {{arg}} inline
    const expandedInline = applyPromptTemplateAutocompleteReplacement({
      text: "/rel Wave 5 主对话",
      command: { start: 0, end: 4, query: "rel", position: "start" },
      template: CUSTOM_RELEASE_TEMPLATE,
    });
    expect(expandedInline).toBe(
      "请针对 Wave 5 主对话 执行完整发版前回归检查，并输出验证清单与阻塞项。",
    );

    // Direct composer submission `/<slug> <args>` expands {{arg}} cleanly
    const submitted = expandPromptTemplateSubmissionText({
      text: "/release-check packages/server",
      templates,
    });
    expect(submitted.matchedTemplate?.slug).toBe("release-check");
    expect(submitted.text).toBe(
      "请针对 packages/server 执行完整发版前回归检查，并输出验证清单与阻塞项。",
    );

    // Non-matching slash command passes through unchanged
    const passthrough = expandPromptTemplateSubmissionText({
      text: "/unknown-cmd foo",
      templates,
    });
    expect(passthrough.matchedTemplate).toBeNull();
    expect(passthrough.text).toBe("/unknown-cmd foo");

    // Store hydrate updates templates cleanly
    act(() => {
      useMainChatPromptLibraryStore.getState().hydratePromptLibrary("srv_local", templates);
    });
    expect(useMainChatPromptLibraryStore.getState().templatesByServerId.srv_local).toHaveLength(
      templates.length,
    );
  });
});
