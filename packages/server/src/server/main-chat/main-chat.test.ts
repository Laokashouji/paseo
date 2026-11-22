import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_CHAT_DEFAULT_TITLE,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_GOAL_LABEL,
  MAIN_CHAT_TASK_ID_LABEL,
  MAIN_CHAT_TASK_MODE_LABEL,
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
  extractMainChatPermissionRuleCandidate,
  parseTaskAskUserToolPayload,
  parseTaskCompleteToolPayload,
  parseTaskPlanToolOutput,
  parseTaskReworkToolPayload,
} from "@getpaseo/protocol/main-chat";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import { projectAgentMessages } from "../agent/agent-messages/index.js";
import { archiveAgentCommand } from "../agent/lifecycle-command.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { FinishSubscriptions } from "../agent/finish-subscriptions/index.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import type { SessionOutboundMessage } from "../messages.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import { createMainChatService } from "./service.js";
import { handleMainChatSessionMessage } from "./session.js";
import { createMainChatStore } from "./store.js";
import { registerMainChatTools } from "./tools.js";
import {
  classifyMainChatTurnError,
  isNoProgressToolCall,
  isSimilarDelegatedQuestion,
  parseUsageLimitResetDelayMs,
  type RunSemanticTriageInput,
  type SemanticTriageOutput,
} from "./triage.js";

function createTestLogger() {
  return pino({ level: "silent" });
}

interface FakeCreateOptions {
  workspaceId?: string;
  labels?: Record<string, string>;
  initialTitle?: string | null;
  background?: boolean;
}

describe("main-chat triage", () => {
  it("classifies auth/client errors as user, quota as usage_limit, and infra failures as transient", () => {
    expect(classifyMainChatTurnError("401 Unauthorized: invalid api key")).toBe("user");
    expect(classifyMainChatTurnError("prompt is too long (context window exceeded)")).toBe("user");
    expect(classifyMainChatTurnError("Individual quota reached; usage limit will reset soon")).toBe(
      "usage_limit",
    );
    expect(classifyMainChatTurnError("HTTP 503 Service Unavailable: upstream overloaded")).toBe(
      "transient",
    );
    expect(classifyMainChatTurnError("fetch failed: ECONNRESET")).toBe("transient");
    expect(classifyMainChatTurnError("Unknown custom error")).toBe("user");
  });

  it("parses usage-limit reset countdowns and extracts safe permission rule keys", () => {
    expect(parseUsageLimitResetDelayMs("Usage limit reached. Resets in 1h 30m")).toBe(
      (3600 + 30 * 60) * 1000,
    );
    expect(parseUsageLimitResetDelayMs("额度将在 45 分钟后重置")).toBe(45 * 60 * 1000);
    expect(parseUsageLimitResetDelayMs("Resets in 5s")).toBe(30_000);

    expect(
      extractMainChatPermissionRuleCandidate({
        kind: "tool",
        name: "Bash",
        input: { command: "npm test -- --watch=false" },
      }),
    ).toEqual({ toolName: "Bash", commandPrefix: "npm test" });
    expect(
      extractMainChatPermissionRuleCandidate({
        kind: "tool",
        name: "Bash",
        input: { command: "npm test && rm -rf /" },
      }),
    ).toBeNull();
    expect(
      extractMainChatPermissionRuleCandidate({
        kind: "tool",
        name: "Bash",
        input: { command: "git push origin main" },
      }),
    ).toBeNull();
    expect(
      extractMainChatPermissionRuleCandidate({
        kind: "question",
        name: "AskUserQuestion",
      }),
    ).toBeNull();
  });
});

describe("main-chat store", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-main-chat-store-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists plans, trust rules, and metrics across reloads", async () => {
    const store = createMainChatStore(tempDir);
    await store.load();

    await store.putPlan({
      id: "plan_1",
      mainAgentId: "agent_main",
      status: "open",
      autoStarted: false,
      summary: "修复侧栏",
      createdAt: "2026-11-22T10:00:00.000Z",
      startedAt: null,
      cancelledAt: null,
      tasks: [],
    });
    await store.addTrustRule("/tmp/repo-a", "write");
    await store.incrementMetric("plansCreated");

    const reloaded = createMainChatStore(tempDir);
    await reloaded.load();
    expect(reloaded.getPlan("plan_1")?.summary).toBe("修复侧栏");
    expect(reloaded.hasTrustRule("/tmp/repo-a/", "write")).toBe(true);
    expect(reloaded.hasTrustRule("/tmp/repo-a", "readonly")).toBe(false);
    expect(reloaded.getMetrics().plansCreated).toBe(1);
  });
});

describe("main-chat service, tools, and session", () => {
  let tempDir: string;
  let repoDir: string;
  let subscriber: ((event: AgentManagerEvent) => void) | null;
  let agents: Map<string, ManagedAgent>;
  let storedAgents: Map<string, StoredAgentRecord>;
  let workspaces: Map<string, PersistedWorkspaceRecord>;
  let sentPrompts: Array<{ agentId: string; prompt: unknown }>;
  let permissionResponses: Array<{ agentId: string; requestId: string; behavior: string }>;
  let finishRegistered: Array<{ callerAgentId: string; childAgentId: string }>;
  let nextId: number;

  function makeHarness(
    harnessOptions: {
      transientRetryDelayMs?: number;
      usageLimitRetryDelayMs?: number;
      stalledThresholdMs?: number;
      stalledCheckIntervalMs?: number;
      triageSettleMs?: number;
      noProgressThresholdMs?: number;
      needsYouEscalateMs?: number;
      wakeupCooldownMs?: number;
      semanticTriageRunner?: (
        input: RunSemanticTriageInput,
      ) => Promise<SemanticTriageOutput | null>;
    } = {},
  ) {
    subscriber = null;
    agents = new Map();
    storedAgents = new Map();
    workspaces = new Map();
    sentPrompts = [];
    permissionResponses = [];
    finishRegistered = [];
    nextId = 1;

    const createWorkspaceRecord = (
      cwd: string,
      title?: string | null,
      background = false,
    ): PersistedWorkspaceRecord => {
      const id = `ws_${nextId++}`;
      const record: PersistedWorkspaceRecord = {
        workspaceId: id,
        projectId: `proj_${id}`,
        projectRootPath: cwd,
        cwd,
        name: path.basename(cwd) || id,
        workspaceKind: "directory",
        title: title ?? undefined,
        background,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      workspaces.set(id, record);
      return record;
    };

    const agentManager = {
      listAgents: () => Array.from(agents.values()),
      getAgent: (id: string) => agents.get(id) ?? null,
      subscribe: (cb: (event: AgentManagerEvent) => void) => {
        subscriber = cb;
        return () => {
          if (subscriber === cb) subscriber = null;
        };
      },
      createAgent: vi.fn(
        async (config: AgentSessionConfig, requestedId?: string, options?: FakeCreateOptions) => {
          const id = requestedId ?? `agent_${nextId++}`;
          const labels = options?.labels ? { ...options.labels } : {};
          const managed = {
            id,
            provider: config.provider,
            cwd: config.cwd,
            workspaceId: options?.workspaceId,
            config: { ...config },
            labels,
            metadata: {},
            lifecycle: "idle",
            attention: { requiresAttention: false },
            currentModeId: config.modeId ?? null,
            availableModes: [],
            pendingPermissions: new Map(),
            background: options?.background === true,
            updatedAt: new Date(),
            runtimeInfo: {
              provider: config.provider,
              sessionId: `sess_${id}`,
              model: config.model,
            },
          } as unknown as ManagedAgent;
          agents.set(id, managed);
          storedAgents.set(id, {
            id,
            provider: config.provider,
            cwd: config.cwd,
            workspaceId: options?.workspaceId,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            title: options?.initialTitle ?? config.title ?? null,
            labels: { ...labels },
            lastStatus: "idle",
            lastModeId: config.modeId ?? null,
            config: {
              model: config.model ?? null,
              modeId: config.modeId ?? null,
              thinkingOptionId: config.thinkingOptionId ?? null,
            },
            background: options?.background === true,
          } as unknown as StoredAgentRecord);
          return managed;
        },
      ),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      reloadStalePluginSession: vi.fn(async () => false),
      replaceAgentRun: vi.fn(),
      steerOrReplaceActiveTurn: vi.fn(),
      streamAgent: vi.fn(async function* (
        agentId: string,
        prompt: unknown,
        _runOptions?: unknown,
        promptStart?: { bind?: (run: unknown) => void },
      ) {
        sentPrompts.push({ agentId, prompt });
        promptStart?.bind?.({
          start: { status: "started" },
          turnStartedPromise: Promise.resolve(),
          settledPromise: new Promise(() => undefined),
        });
        yield { type: "turn_started", provider: "claude" };
        yield { type: "turn_completed", provider: "claude" };
      }),
      respondToPermission: vi.fn(
        async (agentId: string, requestId: string, response: { behavior: string }) => {
          permissionResponses.push({ agentId, requestId, behavior: response.behavior });
        },
      ),
      getTimeline: vi.fn(() => []),
      updateAgentMetadata: vi.fn(
        async (agentId: string, update: { title?: string; labels?: Record<string, string> }) => {
          const live = agents.get(agentId) as
            | (ManagedAgent & { config: { title?: string } })
            | undefined;
          if (live && update.title) {
            live.config.title = update.title;
          }
          const stored = storedAgents.get(agentId) as
            | (StoredAgentRecord & { title?: string | null })
            | undefined;
          if (stored && update.title) {
            stored.title = update.title;
          }
        },
      ),
      notifyAgentState: vi.fn(),
      unarchiveSnapshot: vi.fn(),
      reloadAgentSession: vi.fn(),
    } as unknown as AgentManager;

    const agentStorage = {
      listActive: async () => Array.from(storedAgents.values()).filter((r) => !r.archivedAt),
      get: async (id: string) => storedAgents.get(id) ?? null,
    } as unknown as AgentStorage;

    const providerSnapshotManager = {
      getSnapshot: () => ({
        cwd: tempDir,
        records: [
          {
            contentHash: "h1",
            entry: {
              provider: "claude",
              status: "ready",
              enabled: true,
              models: [{ id: "claude-sonnet-5-5", label: "Sonnet", isDefault: true }],
              modes: [{ id: "default", label: "Default" }],
              defaultModeId: "default",
            },
          },
        ],
      }),
      listProviders: vi.fn(async () => [
        {
          provider: "claude",
          status: "ready",
          enabled: true,
          models: [{ id: "claude-sonnet-5-5", label: "Sonnet", isDefault: true }],
          modes: [{ id: "default", label: "Default" }],
          defaultModeId: "default",
        },
      ]),
      resolveCreateConfig: vi.fn(
        async (input: {
          provider: string;
          requestedMode?: string;
          providerOptions?: Record<string, unknown>;
        }) => ({
          provider: input.provider,
          modeId: input.requestedMode ?? "default",
          providerOptions: input.providerOptions,
        }),
      ),
    } as unknown as ProviderSnapshotManager;

    const workspaceRegistry = {
      get: async (id: string) => workspaces.get(id) ?? null,
      listActive: async () => Array.from(workspaces.values()),
      update: async (
        id: string,
        updater: (record: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
      ) => {
        const current = workspaces.get(id);
        if (!current) return null;
        const next = updater(current);
        workspaces.set(id, next);
        return next;
      },
    };

    const finishSubscriptions = {
      register: vi.fn(async (input: { callerAgentId: string; childAgentId: string }) => {
        finishRegistered.push({
          callerAgentId: input.callerAgentId,
          childAgentId: input.childAgentId,
        });
        return {
          accept: vi.fn(),
          reject: vi.fn(async () => undefined),
        };
      }),
    } as unknown as FinishSubscriptions;

    const service = createMainChatService({
      paseoHome: tempDir,
      serverId: "srv_test",
      agentManager,
      agentStorage,
      providerSnapshotManager,
      workspaceRegistry,
      createDirectoryWorkspace: async (cwd, title, _projectId, context) =>
        createWorkspaceRecord(cwd, title, context?.background === true),
      finishSubscriptions: () => finishSubscriptions,
      logger: createTestLogger(),
      transientRetryDelayMs: harnessOptions.transientRetryDelayMs ?? 20,
      usageLimitRetryDelayMs: harnessOptions.usageLimitRetryDelayMs,
      stalledThresholdMs: harnessOptions.stalledThresholdMs,
      stalledCheckIntervalMs: harnessOptions.stalledCheckIntervalMs,
      triageSettleMs: harnessOptions.triageSettleMs ?? 20,
      noProgressThresholdMs: harnessOptions.noProgressThresholdMs,
      needsYouEscalateMs: harnessOptions.needsYouEscalateMs,
      wakeupCooldownMs: harnessOptions.wakeupCooldownMs ?? 5,
      semanticTriageRunner: harnessOptions.semanticTriageRunner,
    });

    return { service, agentManager, createWorkspaceRecord };
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-main-chat-svc-"));
    repoDir = path.join(tempDir, "sample-repo");
    await mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("ensures a single main chat idempotently with paseo.role=main", async () => {
    const { service } = makeHarness();
    await service.start();

    const first = await service.ensureMainChat();
    expect(first.created).toBe(true);
    expect(agents.get(first.agentId)?.labels[MAIN_CHAT_ROLE_LABEL]).toBe(MAIN_CHAT_ROLE_VALUE);

    const second = await service.ensureMainChat();
    expect(second.created).toBe(false);
    expect(second.agentId).toBe(first.agentId);
    expect(second.workspaceId).toBe(first.workspaceId);

    service.stop();
  });

  it("auto-starts readonly plans, pauses write plans until approved, and honors trust rules", async () => {
    const { service } = makeHarness();
    await service.start();
    const { agentId: mainAgentId } = await service.ensureMainChat();

    const readonlyPlan = await service.createPlan(mainAgentId, {
      summary: "调研日志逻辑",
      tasks: [
        {
          title: "排查日志模块",
          goal: "找出日志落盘路径",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["给出具体文件路径与行号"],
        },
      ],
    });
    expect(readonlyPlan.status).toBe("started");
    expect(readonlyPlan.autoStarted).toBe(true);
    expect(readonlyPlan.tasks[0]!.startError).toBeNull();
    const readonlyChildId = readonlyPlan.tasks[0]!.agentId!;
    expect(readonlyChildId).toBeTruthy();
    const child = agents.get(readonlyChildId)!;
    expect(child.labels[PARENT_AGENT_ID_LABEL]).toBe(mainAgentId);
    expect(child.labels[MAIN_CHAT_TASK_PLAN_ID_LABEL]).toBe(readonlyPlan.id);
    expect(child.labels[MAIN_CHAT_TASK_ID_LABEL]).toBe(readonlyPlan.tasks[0]!.id);
    expect(child.labels[MAIN_CHAT_TASK_MODE_LABEL]).toBe("readonly");
    expect(child.labels[MAIN_CHAT_TASK_GOAL_LABEL]).toBe("找出日志落盘路径");
    expect(child.background).toBe(false);
    expect(finishRegistered.some((entry) => entry.childAgentId === readonlyChildId)).toBe(true);

    await expect(
      service.createPlan(mainAgentId, {
        tasks: [{ title: "改代码", goal: "修复 bug", mode: "write", cwd: repoDir }],
      }),
    ).rejects.toThrow(/doneWhen/);

    const writePlan = await service.createPlan(mainAgentId, {
      summary: "修复侧栏问题",
      tasks: [
        {
          title: "修复侧栏闪烁",
          goal: "修复切换工作区时的闪烁",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["单测通过"],
        },
      ],
    });
    expect(writePlan.status).toBe("open");
    expect(writePlan.tasks[0]!.agentId).toBeNull();

    const startedWritePlan = await service.startPlan(writePlan.id, { rememberAutoStart: true });
    expect(startedWritePlan.status).toBe("started");
    expect(startedWritePlan.tasks[0]!.agentId).toBeTruthy();

    const trustedWritePlan = await service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "补充样式",
          goal: "微调边距",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["typecheck 通过"],
        },
      ],
    });
    expect(trustedWritePlan.status).toBe("started");
    expect(trustedWritePlan.autoStarted).toBe(true);

    service.stop();
  });

  it("cancels open plans and rejects cancelling started plans", async () => {
    const { service } = makeHarness();
    await service.start();
    const { agentId: mainAgentId } = await service.ensureMainChat();

    const plan = await service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "更新配置",
          goal: "修改默认端口",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["配置校验通过"],
        },
      ],
    });
    const cancelled = await service.cancelPlan(plan.id);
    expect(cancelled.status).toBe("cancelled");
    await expect(service.startPlan(plan.id)).rejects.toThrow(/已取消/);

    service.stop();
  });

  it("automatically retries child agents on transient turn_failed up to limit", async () => {
    const { service } = makeHarness({ transientRetryDelayMs: 15 });
    await service.start();
    const { agentId: mainAgentId } = await service.ensureMainChat();

    const plan = await service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "只读调研",
          goal: "检查依赖",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["输出依赖清单"],
        },
      ],
    });
    const childId = plan.tasks[0]!.agentId!;
    const initialPromptsCount = sentPrompts.length;

    subscriber?.({
      type: "agent_stream",
      agentId: childId,
      event: { type: "turn_failed", provider: "claude", error: "401 Unauthorized" },
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sentPrompts.length).toBe(initialPromptsCount);
    expect(service.getMetrics().interrupts).toBe(1);

    subscriber?.({
      type: "agent_stream",
      agentId: childId,
      event: { type: "turn_failed", provider: "claude", error: "503 upstream overloaded" },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(sentPrompts.length).toBe(initialPromptsCount + 1);
    expect(service.getMetrics().autoContinued).toBe(1);

    service.stop();
  });

  it("auto-approves matching child permissions, retries usage limits, and nudges stalled children", async () => {
    const { service } = makeHarness({
      transientRetryDelayMs: 15,
      usageLimitRetryDelayMs: 20,
      stalledThresholdMs: 30,
      stalledCheckIntervalMs: 15,
    });
    await service.start();
    const { agentId: mainAgentId } = await service.ensureMainChat();

    const plan = await service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "运行测试",
          goal: "验证测试套件",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["测试通过"],
        },
      ],
    });
    const childId = plan.tasks[0]!.agentId!;
    const rule = await service.addPermissionRule({
      toolName: "Bash",
      commandPrefix: "npm test",
      cwd: repoDir,
    });

    subscriber?.({
      type: "agent_stream",
      agentId: childId,
      event: {
        type: "permission_requested",
        provider: "claude",
        request: {
          id: "perm_safe",
          kind: "tool",
          name: "Bash",
          input: { command: "npm test -- --run" },
        } as unknown as AgentPermissionRequest,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(permissionResponses).toEqual([
      { agentId: childId, requestId: "perm_safe", behavior: "allow" },
    ]);
    expect(service.getMetrics().supervisorHeld).toBe(1);

    subscriber?.({
      type: "agent_stream",
      agentId: childId,
      event: {
        type: "permission_requested",
        provider: "claude",
        request: {
          id: "perm_chained",
          kind: "tool",
          name: "Bash",
          input: { command: "npm test && rm -rf /tmp/foo" },
        } as unknown as AgentPermissionRequest,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(permissionResponses).toHaveLength(1);
    expect(service.getMetrics().interrupts).toBe(1);

    const promptsBeforeUsageLimit = sentPrompts.length;
    subscriber?.({
      type: "agent_stream",
      agentId: childId,
      event: {
        type: "turn_failed",
        provider: "claude",
        error: "Usage limit reached. Resets in 2h",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sentPrompts.length).toBe(promptsBeforeUsageLimit + 1);
    expect(service.getMetrics().usageLimitRetries).toBe(1);

    const liveChild = agents.get(childId)!;
    liveChild.lifecycle = "running";
    const promptsBeforeStall = sentPrompts.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sentPrompts.length).toBe(promptsBeforeStall + 1);
    expect(service.getMetrics().stalledNudges).toBe(1);

    const removed = await service.removeRule("permission", rule.id);
    expect(removed).toBe(true);
    const overview = await service.getOverview(mainAgentId);
    expect(overview.permissionRules).toHaveLength(0);

    service.stop();
  });

  it("enforces rework round cap and routes answered decisions straight to child agent", async () => {
    const { service, agentManager } = makeHarness();
    await service.start();
    const { agentId: mainAgentId } = await service.ensureMainChat();

    const plan = await service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "补齐单测",
          goal: "覆盖边界条件",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["全部通过"],
        },
      ],
    });
    const childId = plan.tasks[0]!.agentId!;

    const mainTools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager,
      mainChatService: service,
      callerAgentId: mainAgentId,
      scope: "agent",
      tools: mainTools,
      builtinNames: new Set(),
    });

    const rework1Result = await mainTools
      .get("task_rework")!
      .handler(
        { agentId: childId, gaps: ["缺少空输入单测"] },
        { signal: new AbortController().signal },
      );
    const rework1 = parseTaskReworkToolPayload(null, rework1Result);
    expect(rework1?.round).toBe(1);
    expect(rework1?.maxRounds).toBe(2);

    const rework2Result = await mainTools
      .get("task_rework")!
      .handler(
        { agentId: childId, gaps: ["缺少错误分支覆盖"] },
        { signal: new AbortController().signal },
      );
    const rework2 = parseTaskReworkToolPayload(null, rework2Result);
    expect(rework2?.round).toBe(2);

    await expect(
      mainTools
        .get("task_rework")!
        .handler({ agentId: childId, gaps: ["第 3 轮"] }, { signal: new AbortController().signal }),
    ).rejects.toThrow(/返工上限/);

    const askResult = await mainTools.get("task_ask_user")!.handler(
      {
        title: "缓存策略选择",
        question: "是否启用跨重启磁盘缓存？",
        agentId: childId,
        options: [
          { id: "disk", label: "启用磁盘缓存", leadsTo: "重启后秒开" },
          { id: "mem", label: "仅内存缓存", leadsTo: "零磁盘写入" },
        ],
        recommendedOptionId: "disk",
        reason: "涉及持久化取舍",
      },
      { signal: new AbortController().signal },
    );
    const decision = parseTaskAskUserToolPayload(askResult);
    expect(decision?.id).toBeTruthy();
    expect(decision?.answeredAt).toBeNull();

    const promptsBeforeAnswer = sentPrompts.length;
    const answered = await service.answerDecision({
      decisionId: decision!.id,
      optionId: "disk",
      answer: "启用磁盘缓存",
    });
    expect(answered.answeredAt).toBeTruthy();
    expect(answered.answeredOptionId).toBe("disk");
    expect(sentPrompts.length).toBe(promptsBeforeAnswer + 1);
    expect(sentPrompts[sentPrompts.length - 1]?.agentId).toBe(childId);

    const overview = await service.getOverview(mainAgentId);
    expect(overview.decisions).toHaveLength(1);
    expect(overview.decisions[0]?.answer).toBe("启用磁盘缓存");
    expect(overview.metrics.reworkCount).toBe(2);

    service.stop();
  });

  it("registers main-chat MCP tools only for main-role agents and handles session RPCs", async () => {
    const { service, agentManager } = makeHarness();
    await service.start();
    const { agentId: mainAgentId } = await service.ensureMainChat();

    const mainTools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager,
      mainChatService: service,
      callerAgentId: mainAgentId,
      scope: "agent",
      tools: mainTools,
      builtinNames: new Set(),
    });
    expect(Array.from(mainTools.keys()).sort()).toEqual([
      "task_ask_user",
      "task_complete",
      "task_list",
      "task_plan",
      "task_rework",
      "task_start",
    ]);

    const planToolResult = await mainTools.get("task_plan")!.handler(
      {
        summary: "测试计划",
        tasks: [
          {
            title: "改测试",
            goal: "补齐单测",
            mode: "write",
            cwd: repoDir,
            doneWhen: ["vitest 通过"],
          },
        ],
      },
      { signal: new AbortController().signal },
    );
    const parsedPlan = parseTaskPlanToolOutput(planToolResult);
    expect(parsedPlan?.status).toBe("open");
    expect(parsedPlan?.tasks[0]?.title).toBe("改测试");

    const completeToolResult = await mainTools.get("task_complete")!.handler(
      {
        title: "改测试",
        summary: "已补齐单测并全部通过",
        checks: [{ criterion: "vitest 通过", met: true, evidence: "6/6 passed" }],
        nextSteps: ["可以准备合并"],
      },
      { signal: new AbortController().signal },
    );
    const parsedReceipt = parseTaskCompleteToolPayload(null, completeToolResult);
    expect(parsedReceipt?.title).toBe("改测试");
    expect(parsedReceipt?.checks[0]?.met).toBe(true);

    const responses: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      service,
      { type: "main_chat.list_plans.request", requestId: "req_1", mainAgentId },
      (msg) => responses.push(msg),
    );
    const listResponse = responses[0];
    expect(listResponse?.type).toBe("main_chat.list_plans.response");
    if (listResponse?.type === "main_chat.list_plans.response") {
      expect(listResponse.payload.plans).toHaveLength(1);
    }

    await handleMainChatSessionMessage(
      service,
      { type: "main_chat.start_plan.request", requestId: "req_2", planId: parsedPlan!.id },
      (msg) => responses.push(msg),
    );
    const startResponse = responses[1];
    expect(startResponse?.type).toBe("main_chat.start_plan.response");
    const childId =
      startResponse?.type === "main_chat.start_plan.response"
        ? startResponse.payload.plan?.tasks[0]?.agentId
        : null;
    expect(childId).toBeTruthy();

    const childTools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager,
      mainChatService: service,
      callerAgentId: childId!,
      scope: "agent",
      tools: childTools,
      builtinNames: new Set(),
    });
    expect(childTools.size).toBe(0);

    service.stop();
  });

  it("supports conservative/proactive presets, background model & interval config, and renames agent + workspace", async () => {
    const { service, agentManager } = makeHarness();
    await service.start();
    const ensured = await service.ensureMainChat();

    const initial = await service.getSettings();
    expect(initial.title).toBe(MAIN_CHAT_DEFAULT_TITLE);
    expect(initial.style).toBe("conservative");
    expect(initial.capabilities.autoDelegateManualQuestions).toBe(false);
    expect(initial.capabilities.autoNudgeManualStalled).toBe(false);
    expect(initial.intervals.patrolIntervalSec).toBe(60);

    const switched = await service.updateSettings({
      applyPreset: "proactive",
      title: "少卿大管家",
      backgroundModel: {
        mode: "custom",
        provider: "claude",
        model: "claude-haiku-5-5",
        thinkingOptionId: "low",
      },
      intervals: { patrolIntervalSec: 45 },
    });

    expect(switched.style).toBe("proactive");
    expect(switched.title).toBe("少卿大管家");
    expect(switched.capabilities.autoDelegateManualQuestions).toBe(true);
    expect(switched.capabilities.autoNudgeManualStalled).toBe(true);
    expect(switched.intervals.patrolIntervalSec).toBe(45);
    expect(switched.intervals.wakeupCooldownMin).toBe(3);
    expect(switched.backgroundModel).toEqual({
      mode: "custom",
      provider: "claude",
      model: "claude-haiku-5-5",
      thinkingOptionId: "low",
    });

    expect(agentManager.getAgent(ensured.agentId)?.config.title).toBe("少卿大管家");
    expect(workspaces.get(ensured.workspaceId)?.title).toBe("少卿大管家");

    const responses: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      service,
      { type: "main_chat.get_settings.request", requestId: "req_get_cfg" },
      (msg) => responses.push(msg),
    );
    const cfgRes = responses[0];
    expect(cfgRes?.type).toBe("main_chat.get_settings.response");
    if (cfgRes?.type === "main_chat.get_settings.response") {
      expect(cfgRes.payload.settings?.title).toBe("少卿大管家");
      expect(cfgRes.payload.settings?.style).toBe("proactive");
    }

    // Verify archive guard rejects archiving the main-chat agent
    await expect(
      archiveAgentCommand(
        {
          agentManager: agentManager as never,
          agentStorage: {
            get: async (id: string) => storedAgents.get(id) ?? null,
          } as never,
          logger: createTestLogger(),
        },
        ensured.agentId,
      ),
    ).rejects.toThrow("不支持归档");

    service.stop();
  });

  it("injects incremental live global context before user prompts and strips it from projected user bubbles", async () => {
    const { service, agentManager } = makeHarness();
    await service.start();
    const ensured = await service.ensureMainChat();

    // Create an ordinary manual session
    const manual = await agentManager.createAgent(
      { provider: "claude", cwd: repoDir, title: "手动排查日志" },
      "manual_1",
      { workspaceId: "ws_manual" },
    );
    (manual as unknown as { lifecycle: string }).lifecycle = "running";

    const firstPrompt = await service.prepareUserPromptForMainChat(ensured.agentId, "你好");
    expect(typeof firstPrompt).toBe("string");
    expect(String(firstPrompt)).toContain("<paseo-main-context>");
    expect(String(firstPrompt)).toContain("手动排查日志");
    expect(String(firstPrompt)).toContain("你好");

    // Projecting the enriched prompt strips <paseo-main-context> so the chat bubble stays clean
    const projected = projectAgentMessages({
      type: "user_message",
      text: String(firstPrompt),
    });
    expect(projected).toEqual([{ type: "user_message", text: "你好" }]);

    // Second turn with no fleet changes uses delta mode (omits unchanged sections)
    const secondPrompt = await service.prepareUserPromptForMainChat(ensured.agentId, "继续");
    expect(String(secondPrompt)).toContain("相对上一轮快照有变化");
    expect(String(secondPrompt)).not.toContain("手动排查日志");

    service.stop();
  });

  it("enforces conservative vs proactive styles for manual sessions (delegation, redline guard, no-progress patrol)", async () => {
    const triageResponses: SemanticTriageOutput[] = [
      // Turn 1 (conservative): low-risk tech question -> should NOT auto-delegate, should wake steward
      {
        phase: "blocked_user",
        summary: "询问默认超时时间选 30s 还是 60s",
        waitReason: "请问默认超时选 30s 还是 60s？",
        needsUserDecision: true,
        isLowRiskTechnicalQuestion: true,
        riskyAction: false,
        suggestedReply: "采用 30s 默认超时并继续完成单测。",
      },
      // Turn 2 (proactive): low-risk tech question -> SHOULD auto-delegate once
      {
        phase: "blocked_user",
        summary: "询问是否重跑单测",
        waitReason: "是否需要顺手重跑一下本地 vitest？",
        needsUserDecision: true,
        isLowRiskTechnicalQuestion: true,
        riskyAction: false,
        suggestedReply: "需要，请立刻重跑 vitest 验证。",
      },
      // Turn 3 (proactive): risky action (git push) -> MUST NOT auto-delegate even in proactive mode
      {
        phase: "blocked_user",
        summary: "准备执行 git push 推送到远端",
        waitReason: "要不要我现在 git push 到 main 分支？",
        needsUserDecision: true,
        isLowRiskTechnicalQuestion: false,
        riskyAction: true,
        suggestedReply: null,
      },
    ];

    const { service, agentManager } = makeHarness({
      triageSettleMs: 15,
      noProgressThresholdMs: 25,
      wakeupCooldownMs: 10,
      stalledCheckIntervalMs: 60_000,
      semanticTriageRunner: async () => triageResponses.shift() ?? null,
    });
    await service.start();
    const ensured = await service.ensureMainChat();

    const manual = await agentManager.createAgent(
      { provider: "claude", cwd: repoDir, title: "手动修 Bug" },
      "manual_2",
      { workspaceId: "ws_manual_2" },
    );

    // Verify no-progress classifier & duplicate question matcher
    expect(isNoProgressToolCall("Bash", "sleep 30 && gh run view 123")).toBe(true);
    expect(
      isSimilarDelegatedQuestion("是否需要顺手重跑一下本地 vitest？", [
        "是否需要顺手重跑一下本地vitest",
      ]),
    ).toBe(true);

    // 1. Conservative style (default): low-risk tech question is NOT sent to manual agent, wakes steward instead
    subscriber?.({
      type: "agent_stream",
      agentId: manual.id,
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "请问默认超时选 30s 还是 60s？" },
      },
    });
    subscriber?.({
      type: "agent_stream",
      agentId: manual.id,
      event: { type: "turn_completed", provider: "claude" },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sentPrompts.filter((entry) => entry.agentId === manual.id)).toHaveLength(0);
    expect(
      sentPrompts.some(
        (entry) =>
          entry.agentId === ensured.agentId && String(entry.prompt).includes("主动巡检唤醒"),
      ),
    ).toBe(true);

    // 2. Switch to proactive style: low-risk tech question IS auto-delegated to manual agent
    await service.updateSettings({ applyPreset: "proactive" });
    sentPrompts.length = 0;

    subscriber?.({
      type: "agent_stream",
      agentId: manual.id,
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "是否需要顺手重跑一下本地 vitest？" },
      },
    });
    subscriber?.({
      type: "agent_stream",
      agentId: manual.id,
      event: { type: "turn_completed", provider: "claude" },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const delegated = sentPrompts.filter((entry) => entry.agentId === manual.id);
    expect(delegated).toHaveLength(1);
    expect(String(delegated[0]?.prompt)).toContain("代为确认");

    // 3. Proactive style still blocks redline riskyAction (git push)
    sentPrompts.length = 0;
    subscriber?.({
      type: "agent_stream",
      agentId: manual.id,
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "要不要我现在 git push 到 main 分支？" },
      },
    });
    subscriber?.({
      type: "agent_stream",
      agentId: manual.id,
      event: { type: "turn_completed", provider: "claude" },
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sentPrompts.filter((entry) => entry.agentId === manual.id)).toHaveLength(0);
    expect(sentPrompts.some((entry) => entry.agentId === ensured.agentId)).toBe(true);

    // 4. Proactive style auto-nudges no-progress polling loops on manual patrol
    sentPrompts.length = 0;
    (manual as unknown as { lifecycle: string }).lifecycle = "running";
    for (let i = 0; i < 3; i += 1) {
      subscriber?.({
        type: "agent_stream",
        agentId: manual.id,
        event: {
          type: "timeline",
          provider: "claude",
          item: {
            type: "tool_call",
            callId: `c_${i}`,
            name: "Bash",
            status: "completed",
            error: null,
            detail: { type: "shell", command: "sleep 10 && git status" },
          } as never,
        },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
    const patrolResult = await service.triggerPatrol({ mainAgentId: ensured.agentId });
    expect(patrolResult.scannedSessions).toBeGreaterThanOrEqual(1);
    expect(patrolResult.wokeMainChat).toBe(true);
    expect(sentPrompts.some((entry) => entry.agentId === manual.id)).toBe(true);

    service.stop();
  });
});
