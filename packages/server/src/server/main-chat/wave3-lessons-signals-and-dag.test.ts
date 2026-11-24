import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAIN_CHAT_LESSONS_INJECT_BUDGET_BYTES,
  MAIN_CHAT_TASK_RECORD_ID_LABEL,
  type MainChatSupervisionSignalKind,
} from "@getpaseo/protocol/main-chat";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, PersistedAgentRecord } from "../agent/agent-storage.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import type { SessionOutboundMessage } from "../messages.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
  WorkspaceGitSnapshotUpdatedListener,
} from "../workspace-git-service.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import {
  DeliveryGateBlockedError,
  buildDeliveryGateFromGitSnapshot,
  evaluateTaskDeliveryGateForAcceptance,
} from "./delivery-gate.js";
import {
  MainChatProjectLessonsStore,
  formatProjectLessonsForDispatch,
  resolveProjectLessonIdentity,
} from "./lessons.js";
import { createMainChatService } from "./service.js";
import { handleMainChatSessionMessage } from "./session.js";
import { TaskDagValidationError, validateTaskDagBatch } from "./task-dag.js";
import { registerMainChatTools } from "./tools.js";

const logger = pino({ level: "silent" });

interface Wave3HarnessOptions {
  nowMs?: () => number;
  remoteHostStatus?: "online" | "offline";
  allStoppedThresholdMs?: number;
  timedOutMultiplier?: number;
  periodicCheckIntervalMs?: number;
  leaderStuckThresholdMs?: number;
  stalledThresholdMs?: number;
  triageSettleMs?: number;
  superviseGatherMs?: number;
  semanticTriageRunner?: Parameters<typeof createMainChatService>[0]["semanticTriageRunner"];
}

function makeGitSnapshot(input: {
  cwd: string;
  repoRoot?: string;
  mainRepoRoot?: string;
  remoteUrl?: string | null;
  branch?: string | null;
  pr?: WorkspaceGitRuntimeSnapshot["forge"]["pullRequest"];
}): WorkspaceGitRuntimeSnapshot {
  return {
    cwd: input.cwd,
    git: {
      isGit: true,
      repoRoot: input.repoRoot ?? input.cwd,
      mainRepoRoot: input.mainRepoRoot ?? input.repoRoot ?? input.cwd,
      currentBranch: input.branch ?? "feat/wave3-pr",
      remoteUrl: input.remoteUrl ?? "git@github.com:paseo-org/demo-repo.git",
      isPaseoOwnedWorktree: false,
      isDirty: false,
      baseRef: "main",
      aheadBehind: { ahead: 1, behind: 0 },
      upstreamRef: "origin/feat/wave3-pr",
      aheadOfOrigin: 0,
      behindOfOrigin: 0,
      hasRemote: true,
      diffStat: { additions: 20, deletions: 4 },
    },
    forge: {
      featuresEnabled: true,
      authState: "authenticated",
      forge: "github",
      pullRequest: input.pr ?? null,
      error: null,
    },
  };
}

function makeWave3Harness(paseoHome: string, repoDir: string, options: Wave3HarnessOptions = {}) {
  let agentSeq = 0;
  const agents = new Map<string, ManagedAgent>();
  const storedRecords = new Map<string, PersistedAgentRecord>();
  const timelines = new Map<string, AgentTimelineItem[]>();
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  const gitSnapshotListeners = new Set<WorkspaceGitSnapshotUpdatedListener>();
  const gitSnapshotsByCwd = new Map<string, WorkspaceGitRuntimeSnapshot>();
  const sentPrompts: Array<{ agentId: string; prompt: unknown }> = [];

  const nowMs = options.nowMs ?? (() => Date.now());

  const emitAgentEvent = (event: AgentManagerEvent) => {
    for (const sub of subscribers) {
      sub(event);
    }
  };

  function makeLiveAgent(params: {
    id: string;
    provider?: string;
    model?: string;
    cwd?: string;
    workspaceId?: string;
    title?: string;
    labels?: Record<string, string>;
  }): ManagedAgent {
    const nowDate = new Date(nowMs());
    const live = {
      id: params.id,
      provider: (params.provider ?? "claude") as ManagedAgent["provider"],
      cwd: params.cwd ?? repoDir,
      workspaceId: params.workspaceId ?? "ws_repo",
      lifecycle: "idle",
      background: false,
      internal: false,
      labels: { ...params.labels },
      config: {
        provider: (params.provider ?? "claude") as ManagedAgent["provider"],
        cwd: params.cwd ?? repoDir,
        model: params.model ?? "claude-sonnet-4-5",
        title: params.title ?? "Agent",
      },
      runtimeInfo: {
        provider: (params.provider ?? "claude") as ManagedAgent["provider"],
        model: params.model ?? "claude-sonnet-4-5",
      },
      pendingPermissions: new Map(),
      attention: { requiresAttention: false },
      createdAt: nowDate,
      updatedAt: nowDate,
      lastUsage: undefined,
      session: {
        listCommands: async () => [],
        tryHandleOutOfBand: () => null,
      },
    } as unknown as ManagedAgent;
    return live;
  }

  const agentManager = {
    subscribe: (listener: (event: AgentManagerEvent) => void) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    getAgent: (id: string) => agents.get(id),
    listAgents: () => Array.from(agents.values()),
    getTimeline: (id: string) => timelines.get(id) ?? [],
    createAgent: async (
      config: {
        provider: string;
        cwd: string;
        model?: string;
        title?: string;
        labels?: Record<string, string>;
        workspaceId?: string;
        initialPrompt?: unknown;
      },
      agentId?: string,
      createOptions?: {
        workspaceId?: string;
        labels?: Record<string, string>;
      },
    ) => {
      agentSeq += 1;
      const id = agentId ?? `agent_${agentSeq}`;
      const mergedLabels = { ...config.labels, ...createOptions?.labels };
      const resolvedWorkspaceId = createOptions?.workspaceId ?? config.workspaceId ?? "ws_repo";
      const live = makeLiveAgent({
        id,
        provider: config.provider,
        model: config.model,
        cwd: config.cwd,
        workspaceId: resolvedWorkspaceId,
        title: config.title ?? `Agent ${agentSeq}`,
        labels: mergedLabels,
      });
      agents.set(id, live);
      storedRecords.set(id, {
        id,
        provider: live.provider,
        cwd: live.cwd,
        workspaceId: live.workspaceId,
        title: live.config.title,
        labels: { ...live.labels },
        createdAt: new Date(nowMs()).toISOString(),
        updatedAt: new Date(nowMs()).toISOString(),
      } as PersistedAgentRecord);
      timelines.set(id, []);
      if (config.initialPrompt !== undefined) {
        sentPrompts.push({ agentId: id, prompt: config.initialPrompt });
      }
      emitAgentEvent({ type: "agent_created", agent: live } as AgentManagerEvent);
      return live;
    },
    getRegisteredProviderIds: () => ["claude"],
    getLastAssistantMessage: async (agentId: string) => {
      const items = timelines.get(agentId) ?? [];
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i] as { type?: string; text?: string };
        if (item.type === "assistant_message" && item.text) return item.text;
      }
      return null;
    },
    updateAgentMetadata: async (
      agentId: string,
      patch: { labels?: Record<string, string>; title?: string },
    ) => {
      const live = agents.get(agentId);
      if (live) {
        if (patch.labels) live.labels = { ...live.labels, ...patch.labels };
        if (patch.title) live.config.title = patch.title;
      }
      const rec = storedRecords.get(agentId);
      if (rec) {
        if (patch.labels) rec.labels = { ...rec.labels, ...patch.labels };
        if (patch.title) rec.title = patch.title;
      }
      return live ?? null;
    },
    createAgentFromRecord: async (record: PersistedAgentRecord) => {
      const existing = agents.get(record.id);
      if (existing) return existing;
      const live = makeLiveAgent({
        id: record.id,
        provider: record.provider,
        model: record.config?.model,
        cwd: record.cwd,
        workspaceId: record.workspaceId ?? undefined,
        title: record.title ?? undefined,
        labels: record.labels,
      });
      agents.set(record.id, live);
      return live;
    },
    hydrateTimelineFromProvider: async () => undefined,
    resumeAgentFromPersistence: async () => undefined,
    waitForAgentClose: async () => undefined,
    setDaemonBackgroundWork: () => undefined,
    removeDaemonBackgroundWork: () => undefined,
    reloadAgentSession: async () => undefined,
    reloadStalePluginSession: async () => undefined,
    tryRunOutOfBand: async () => false,
    sendPrompt: async (agentId: string, prompt: unknown) => {
      sentPrompts.push({ agentId, prompt });
      const live = agents.get(agentId);
      if (live) {
        live.updatedAt = new Date(nowMs());
      }
    },
    hasInFlightRun: () => false,
    notifyAgentState: () => undefined,
    unarchiveSnapshot: () => undefined,
    replaceAgentRun: () => undefined,
    steerOrReplaceActiveTurn: () => undefined,
    streamAgent: async function* (
      agentId: string,
      prompt: unknown,
      _runOptions?: unknown,
      promptStart?: { bind?: (run: unknown) => void },
    ) {
      sentPrompts.push({ agentId, prompt });
      const live = agents.get(agentId);
      if (live) {
        live.updatedAt = new Date(nowMs());
      }
      promptStart?.bind?.({
        start: { status: "started" },
        turnStartedPromise: Promise.resolve(),
        settledPromise: new Promise(() => undefined),
      });
      yield { type: "turn_started", provider: "claude" } as never;
      yield { type: "turn_completed", provider: "claude" } as never;
    },
    updateAgentLabels: async (agentId: string, labels: Record<string, string>) => {
      const live = agents.get(agentId);
      if (live) {
        live.labels = { ...live.labels, ...labels };
      }
      const rec = storedRecords.get(agentId);
      if (rec) {
        rec.labels = { ...rec.labels, ...labels };
      }
    },
    setTitle: async (agentId: string, title: string) => {
      const live = agents.get(agentId);
      if (live) live.config.title = title;
      const rec = storedRecords.get(agentId);
      if (rec) rec.title = title;
    },
    archiveAgent: async (agentId: string) => {
      agents.delete(agentId);
      const rec = storedRecords.get(agentId);
      if (rec) rec.archivedAt = new Date(nowMs()).toISOString();
    },
    closeAgent: async (agentId: string) => {
      agents.delete(agentId);
    },
    respondToPermission: async () => undefined,
  } as unknown as AgentManager;

  const agentStorage = {
    get: async (id: string) => storedRecords.get(id) ?? null,
    list: async () => Array.from(storedRecords.values()),
    listActive: async () => Array.from(storedRecords.values()).filter((rec) => !rec.archivedAt),
    upsert: async (rec: PersistedAgentRecord) => {
      storedRecords.set(rec.id, rec);
    },
    save: async (rec: PersistedAgentRecord) => {
      storedRecords.set(rec.id, rec);
    },
    update: async (id: string, patch: Partial<PersistedAgentRecord>) => {
      const existing = storedRecords.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      storedRecords.set(id, updated);
      return updated;
    },
    patch: async (id: string, patch: Partial<PersistedAgentRecord>) => {
      const existing = storedRecords.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch };
      storedRecords.set(id, updated);
      return updated;
    },
  } as unknown as AgentStorage;

  const providerSnapshotManager = {
    getSnapshot: () => ({
      records: [
        {
          entry: {
            provider: "claude",
            enabled: true,
            models: [
              { id: "claude-sonnet-4-5", isDefault: true, contextWindowMaxTokens: 1_000_000 },
              { id: "claude-haiku-4-5", contextWindowMaxTokens: 200_000 },
            ],
          },
        },
      ],
    }),
    listProviders: async () => [
      {
        provider: "claude",
        status: "ready",
        enabled: true,
        models: [
          { id: "claude-sonnet-4-5", label: "Sonnet", isDefault: true },
          { id: "claude-haiku-4-5", label: "Haiku" },
        ],
        modes: [{ id: "default", label: "Default" }],
        defaultModeId: "default",
      },
    ],
    resolveCreateConfig: async (input: { provider: string; requestedMode?: string }) => ({
      provider: input.provider,
      modeId: input.requestedMode ?? "default",
    }),
  } as unknown as ProviderSnapshotManager;

  const workspaceRegistry: Pick<WorkspaceRegistry, "get" | "listActive"> = {
    get: async (id: string) => workspaces.get(id) ?? null,
    listActive: async () => Array.from(workspaces.values()),
  };

  const createDirectoryWorkspace = async (cwd: string, title?: string | null) => {
    const existing = Array.from(workspaces.values()).find((ws) => ws.cwd === cwd);
    if (existing) return existing;
    const record: PersistedWorkspaceRecord = {
      workspaceId: `ws_${workspaces.size + 1}`,
      cwd,
      title: title ?? path.basename(cwd),
      createdAt: new Date(nowMs()).toISOString(),
      updatedAt: new Date(nowMs()).toISOString(),
    } as PersistedWorkspaceRecord;
    workspaces.set(record.workspaceId, record);
    return record;
  };

  const workspaceGitService: Pick<WorkspaceGitService, "onSnapshotUpdated" | "getSnapshot"> = {
    onSnapshotUpdated: (listener) => {
      gitSnapshotListeners.add(listener);
      return {
        unsubscribe: () => {
          gitSnapshotListeners.delete(listener);
        },
      };
    },
    getSnapshot: async (cwd: string) => {
      const snap = gitSnapshotsByCwd.get(cwd);
      if (snap) return snap;
      return makeGitSnapshot({ cwd });
    },
  };

  const emitGitSnapshot = (snapshot: WorkspaceGitRuntimeSnapshot) => {
    gitSnapshotsByCwd.set(snapshot.cwd, snapshot);
    for (const listener of gitSnapshotListeners) {
      listener(snapshot);
    }
  };

  const connectedHosts = () => {
    if (!options.remoteHostStatus) return null;
    const remoteEntry = {
      registrationId: "reg_remote",
      serverId: "srv_remote",
      expectedServerId: "srv_remote",
      label: "Remote GPU Box",
      status: options.remoteHostStatus === "offline" ? "offline" : "connected",
      lastOnlineAt: new Date(nowMs() - 60_000).toISOString(),
    };
    return {
      listKnownHosts: () => [remoteEntry],
      listAcceptedHosts: () => (options.remoteHostStatus === "online" ? [remoteEntry] : []),
      getAcceptedClient: () => null,
      subscribeHostChanges: () => () => {},
    } as unknown as NonNullable<
      ReturnType<NonNullable<Parameters<typeof createMainChatService>[0]["connectedHosts"]>>
    >;
  };

  const service = createMainChatService({
    paseoHome,
    serverId: "srv_local",
    hostLabel: "DevBox",
    connectedHosts,
    agentManager,
    agentStorage,
    providerSnapshotManager,
    workspaceRegistry,
    createDirectoryWorkspace,
    finishSubscriptions: () =>
      ({
        register: async () => ({
          accept: () => undefined,
          reject: async () => undefined,
        }),
      }) as unknown as NonNullable<
        ReturnType<NonNullable<Parameters<typeof createMainChatService>[0]["finishSubscriptions"]>>
      >,
    workspaceGitService,
    semanticTriageRunner: options.semanticTriageRunner,
    logger,
    now: nowMs,
    idlePrecompactCheckIntervalMs: 0,
    cacheKeepaliveCheckIntervalMs: 0,
    stalledCheckIntervalMs: 0,
    superviseGatherMs: options.superviseGatherMs ?? 600_000,
    allStoppedThresholdMs: options.allStoppedThresholdMs ?? 30 * 60_000,
    timedOutMultiplier: options.timedOutMultiplier ?? 2,
    periodicCheckIntervalMs: options.periodicCheckIntervalMs ?? 10 * 60_000,
    leaderStuckThresholdMs: options.leaderStuckThresholdMs ?? 15 * 60_000,
    stalledThresholdMs: options.stalledThresholdMs ?? 15 * 60_000,
    triageSettleMs: options.triageSettleMs ?? 10,
  });

  return {
    service,
    agentManager,
    agents,
    storedRecords,
    timelines,
    workspaces,
    sentPrompts,
    gitSnapshotsByCwd,
    emitAgentEvent,
    emitGitSnapshot,
  };
}

describe("Wave 3 — P1-1 Project Lessons, P1-2 Reserved Signals & Delivery Gate, P1-3 Task DAG", () => {
  let tempRoot: string;
  let paseoHome: string;
  let repoDir: string;
  let otherRepoDir: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-wave3-"));
    paseoHome = path.join(tempRoot, "paseo-home");
    repoDir = path.join(tempRoot, "demo-repo");
    otherRepoDir = path.join(tempRoot, "other-repo");
    await mkdir(paseoHome, { recursive: true });
    await mkdir(repoDir, { recursive: true });
    await mkdir(otherRepoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it("P1-1: normalizes project keys, auto-distills & deduplicates lessons on rework/accept, respects retirement, injects budgeted context on dispatch, and handles MCP tools & RPCs", async () => {
    const keySsh = resolveProjectLessonIdentity({
      remoteUrl: "git@github.com:Paseo-Org/Demo-Repo.git",
    });
    const keyHttps = resolveProjectLessonIdentity({
      remoteUrl: "https://github.com/paseo-org/demo-repo.git",
    });
    expect(keySsh?.projectKey).toBe(keyHttps?.projectKey);
    expect(keySsh?.projectKey).toBe("repo:paseo-org/demo-repo");

    let clock = Date.parse("2026-11-25T02:00:00.000Z");
    const harness = makeWave3Harness(paseoHome, repoDir, { nowMs: () => clock });
    await harness.service.start();
    await harness.service.updateSettings({ enabled: true });
    const ensured = await harness.service.ensureMainChat();
    const mainAgentId = ensured.agentId;

    // Seed git snapshot so repoDir resolves to canonical github.com/paseo-org/demo-repo
    harness.gitSnapshotsByCwd.set(repoDir, makeGitSnapshot({ cwd: repoDir }));

    // 1) Create & start task A on demo-repo
    const planA = await harness.service.createPlan(mainAgentId, {
      summary: "修复协议与服务端校验",
      tasks: [
        {
          title: "补齐协议校验",
          goal: "新增 Wave 3 schema",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["protocol build 通过"],
        },
      ],
    });
    const startedA = await harness.service.startPlan(planA.id);
    const taskRecordIdA = startedA.tasks[0]!.taskRecordId!;

    // 2) Rework task A -> auto-distills 1–3 lessons into demo-repo
    await harness.service.reviewTask({
      taskId: taskRecordIdA,
      verdict: "rework",
      gaps: [
        "修改 packages/protocol 后必须先执行 npm run build 再跑 server typecheck",
        "忘记更新 operation-permissions.ts 导致新增 RPC 被拒",
      ],
      note: "下次提交前先核对 protocol/client/server 同步更新",
    });

    const listedAfterRework = await harness.service.listLessons();
    expect(listedAfterRework.groups).toHaveLength(1);
    expect(listedAfterRework.groups[0]!.projectKey).toBe(repoDir.replace(/\\/g, "/"));
    expect(listedAfterRework.lessons.length).toBeGreaterThanOrEqual(2);
    expect(listedAfterRework.lessons.length).toBeLessThanOrEqual(3);
    const firstLesson = listedAfterRework.lessons.find((item) =>
      item.text.includes("修改 packages/protocol"),
    )!;
    expect(firstLesson).toBeTruthy();
    expect(firstLesson.origin).toBe("auto_rework");

    // 3) Re-trigger rework with duplicate gap on same task -> deduplicates without inflating;
    //    then recording same lesson from another task increments seenCount >= 2!
    const countBeforeDup = listedAfterRework.lessons.length;
    await harness.service.reviewTask({
      taskId: taskRecordIdA,
      verdict: "rework",
      gaps: ["修改 packages/protocol 后必须先执行 npm run build 再跑 server typecheck"],
    });
    expect((await harness.service.listLessons()).lessons.length).toBe(countBeforeDup);

    const dupAdd = await harness.service.addLesson({
      projectKey: repoDir,
      kind: "repeated_mistake",
      text: firstLesson.text,
      taskId: "task_other_rework",
      origin: "auto_rework",
    });
    expect(dupAdd.deduplicated).toBe(true);
    expect(dupAdd.lesson?.id).toBe(firstLesson.id);
    expect(dupAdd.lesson?.seenCount).toBeGreaterThanOrEqual(2);

    // 4) Accept with corrective note/checks -> auto-distills improvement lesson too
    await harness.service.reviewTask({
      taskId: taskRecordIdA,
      verdict: "accept",
      summary: "已完成全部协议与权限补齐",
      checks: [{ label: "protocol build", passed: true, evidence: "tsc clean" }],
      note: "改进建议：把新增 RPC 同步写入 session.ts 避免遗漏处理分支",
    });
    const listedAfterAccept = await harness.service.listLessons();
    expect(listedAfterAccept.lessons.some((item) => item.origin === "auto_review")).toBe(true);

    // 5) Dispatch a NEW task to the same demo-repo -> automatically injects 「项目历史教训」
    const promptCountBefore = harness.sentPrompts.length;
    const planB = await harness.service.createPlan(mainAgentId, {
      summary: "同仓库后续任务",
      tasks: [
        {
          title: "补齐客户端方法",
          goal: "添加客户端 RPC 封装",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["client build 通过"],
        },
      ],
    });
    await harness.service.startPlan(planB.id);
    const dispatchPrompt = String(harness.sentPrompts[promptCountBefore]?.prompt ?? "");
    expect(dispatchPrompt).toContain("## 项目历史教训");
    expect(dispatchPrompt).toContain("修改 packages/protocol");

    // Dispatch to a DIFFERENT repo -> does NOT inject demo-repo lessons
    harness.gitSnapshotsByCwd.set(
      otherRepoDir,
      makeGitSnapshot({
        cwd: otherRepoDir,
        remoteUrl: "https://github.com/paseo-org/unrelated-repo.git",
      }),
    );
    const promptCountOther = harness.sentPrompts.length;
    const planOther = await harness.service.createPlan(mainAgentId, {
      summary: "其他仓库任务",
      tasks: [
        {
          title: "其他仓库修改",
          goal: "无关联仓库任务",
          mode: "readonly",
          cwd: otherRepoDir,
        },
      ],
    });
    await harness.service.startPlan(planOther.id);
    const otherPrompt = String(harness.sentPrompts[promptCountOther]?.prompt ?? "");
    expect(otherPrompt).not.toContain("修改 packages/protocol");

    // 6) Deterministic byte budget enforcement on direct lessons store
    const lessonsStore = new MainChatProjectLessonsStore(paseoHome, { now: () => clock });
    await lessonsStore.load();
    for (let i = 0; i < 12; i += 1) {
      await lessonsStore.addLesson({
        projectKey: "repo:paseo-org/budget-repo",
        kind: "repeated_mistake",
        text: `第 ${i + 1} 条超长避坑规则：` + "请务必遵循构建与验证门禁标准".repeat(8),
        origin: "manual",
      });
    }
    const budgetLessons = lessonsStore.listLessons({ projectKey: "repo:paseo-org/budget-repo" });
    const injectedBlock = formatProjectLessonsForDispatch({
      lessons: budgetLessons,
      projectLabel: "budget-repo",
      budgetBytes: MAIN_CHAT_LESSONS_INJECT_BUDGET_BYTES,
      nowMs: clock,
    });
    expect(injectedBlock).toBeTruthy();
    expect(Buffer.byteLength(injectedBlock.text, "utf8")).toBeLessThanOrEqual(
      MAIN_CHAT_LESSONS_INJECT_BUDGET_BYTES,
    );

    // 7) MCP tools (lesson_list / lesson_add / lesson_delete) + retirement guard
    const tools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager: harness.agentManager,
      mainChatService: harness.service,
      callerAgentId: mainAgentId,
      scope: "agent",
      tools,
      builtinNames: new Set(),
    });
    const abort = { signal: new AbortController().signal };

    const addRes = (await tools.get("lesson_add")!.handler(
      {
        projectKey: repoDir,
        projectLabel: "demo-repo",
        kind: "missing_context",
        text: "测试前需先运行 vitest setup 检查环境",
      },
      abort,
    )) as { structuredContent: { lesson: { id: string } } };
    const createdLessonId = addRes.structuredContent.lesson.id;
    expect(createdLessonId).toBeTruthy();

    // WebSocket RPC list/delete round-trip
    const outbound: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      harness.service,
      { type: "main_chat.lessons_list.request", requestId: "req_l1" },
      (msg) => outbound.push(msg),
    );
    const listRpcResp = outbound.find((m) => m.type === "main_chat.lessons_list.response");
    expect(listRpcResp && listRpcResp.type === "main_chat.lessons_list.response").toBe(true);

    await handleMainChatSessionMessage(
      harness.service,
      { type: "main_chat.lessons_delete.request", requestId: "req_l2", lessonId: firstLesson.id },
      (msg) => outbound.push(msg),
    );
    const delRpcResp = outbound.find((m) => m.type === "main_chat.lessons_delete.response");
    expect(
      delRpcResp?.type === "main_chat.lessons_delete.response" && delRpcResp.payload.deleted,
    ).toBe(true);

    // Retired lesson is NOT re-added on subsequent auto-distillation
    await harness.service.reviewTask({
      taskId: taskRecordIdA,
      verdict: "accept",
      summary: "复测确认",
      note: firstLesson.text,
    });
    const afterRetireList = await harness.service.listLessons();
    expect(afterRetireList.lessons.some((item) => item.id === firstLesson.id)).toBe(false);

    // Tool delete cleans up the tool-added lesson
    const toolDelRes = (await tools
      .get("lesson_delete")!
      .handler({ lessonId: createdLessonId }, abort)) as {
      structuredContent: { deleted: boolean };
    };
    expect(toolDelRes.structuredContent.deleted).toBe(true);

    harness.service.stop();
  });

  it("P1-2: enforces deliveryGate blockers on accept (draft/conflict/ci_failed), supports explicit bypass, tracks post-accept PR follow-up until pr_merged, and triggers all 13+ reserved supervision signals", async () => {
    let clock = Date.parse("2026-11-25T03:00:00.000Z");
    const harness = makeWave3Harness(paseoHome, repoDir, {
      nowMs: () => clock,
      remoteHostStatus: "offline",
      allStoppedThresholdMs: 30 * 60_000,
      timedOutMultiplier: 2,
      periodicCheckIntervalMs: 10 * 60_000,
      leaderStuckThresholdMs: 15 * 60_000,
      stalledThresholdMs: 15 * 60_000,
      triageSettleMs: 10,
      superviseGatherMs: 600_000,
      semanticTriageRunner: async () => ({
        phase: "unsure",
        confidence: 0.35,
        summary: "回复结果不够明确，待主对话判别",
        waitReason: null,
        suggestedAction: "inspect",
        riskLevel: "low",
      }),
    });
    await harness.service.start();
    await harness.service.updateSettings({ enabled: true });
    const ensured = await harness.service.ensureMainChat();
    const mainAgentId = ensured.agentId;

    // Start a task linked to PR #101 (initially Draft + Conflicting + Failing CI)
    const draftPrSnapshot = makeGitSnapshot({
      cwd: repoDir,
      branch: "feat/wave3-pr",
      pr: {
        number: 101,
        url: "https://github.com/paseo-org/demo-repo/pull/101",
        title: "Wave 3 Delivery Gate",
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feat/wave3-pr",
        headSha: "sha_1",
        isMerged: false,
        isDraft: true,
        mergeable: "CONFLICTING",
        checksStatus: "failure",
        checks: [{ name: "unit-tests", status: "failure" }],
        reviewDecision: "changes_requested",
      },
    });
    harness.gitSnapshotsByCwd.set(repoDir, draftPrSnapshot);

    const plan = await harness.service.createPlan(mainAgentId, {
      summary: "验证 PR 交付门禁与督办信号",
      tasks: [
        {
          title: "实现交付门禁",
          goal: "补齐 PR 跟进与阻断保护",
          mode: "write",
          cwd: repoDir,
          branchName: "feat/wave3-pr",
          doneWhen: ["PR 通过检查并合并"],
        },
      ],
    });
    const started = await harness.service.startPlan(plan.id);
    const taskId = started.tasks[0]!.taskRecordId!;

    const observedSignalKinds = new Set<MainChatSupervisionSignalKind>();
    const captureSignals = () => {
      for (const sig of harness.service.listPendingSignals?.() ?? []) {
        observedSignalKinds.add(sig.kind);
      }
      // Also extract signals already flushed into supervision wakeup prompts sent to main chat / leaders
      const labelToKind: Record<string, MainChatSupervisionSignalKind> = {
        "[PR 已合并]": "pr_merged",
        "[PR 合并冲突]": "pr_conflict",
        "[草稿 PR]": "draft_pr",
        "[PR 动态]": "pr_event",
        "[子任务全部完工]": "parent_closeout",
        "[下游任务就绪]": "todo_ready",
        "[用户已回复拍板]": "decision_reply",
        "[全员停滞超30分钟]": "all_stopped",
        "[执行超时]": "timed_out",
        "[孤儿任务]": "orphaned",
        "[结果待判别]": "unjudged",
        "[周期检查]": "check",
        "[待拍板]": "decide",
        "[进度上报]": "report",
        "[升级事项]": "escalated",
        "[方向主管停滞]": "leader_stuck",
        "[启动失败]": "failed",
      };
      for (const sent of harness.sentPrompts) {
        const text = typeof sent.prompt === "string" ? sent.prompt : JSON.stringify(sent.prompt);
        for (const [tag, kind] of Object.entries(labelToKind)) {
          if (text.includes(tag)) {
            observedSignalKinds.add(kind);
          }
        }
      }
    };

    // Trigger live git snapshot -> emits draft_pr, pr_conflict, pr_event (CI failure + changes_requested)
    const updatedCount = await harness.service.handleWorkspaceGitSnapshot(draftPrSnapshot);
    expect(updatedCount).toBe(1);
    captureSignals();
    expect(observedSignalKinds.has("draft_pr")).toBe(true);
    expect(observedSignalKinds.has("pr_conflict")).toBe(true);
    expect(observedSignalKinds.has("pr_event")).toBe(true);

    // Pure gate evaluation & service.reviewTask MUST block acceptance while draft/conflict/ci_failed
    const builtGate = buildDeliveryGateFromGitSnapshot({
      snapshot: draftPrSnapshot,
      existing: null,
      nowIso: new Date(clock).toISOString(),
    });
    expect(builtGate?.isDraft).toBe(true);
    expect(builtGate?.hasConflict).toBe(true);
    expect(builtGate?.ciStatus).toBe("failing");
    const evalBlocked = evaluateTaskDeliveryGateForAcceptance({
      gate: builtGate,
      policy: "merged",
      bypassDeliveryGate: false,
    });
    expect(evalBlocked.blocksAcceptance).toBe(true);

    await expect(
      harness.service.reviewTask({
        taskId,
        verdict: "accept",
        summary: "尝试绕过未确认的草稿 PR",
      }),
    ).rejects.toThrow(DeliveryGateBlockedError);

    // Clean PR (ready, non-draft, no conflicts, CI passing, still OPEN) -> accept succeeds with followUpActive=true & warning
    const openCleanSnapshot = makeGitSnapshot({
      cwd: repoDir,
      branch: "feat/wave3-pr",
      pr: {
        number: 101,
        url: "https://github.com/paseo-org/demo-repo/pull/101",
        title: "Wave 3 Delivery Gate",
        state: "OPEN",
        baseRefName: "main",
        headRefName: "feat/wave3-pr",
        headSha: "sha_2",
        isMerged: false,
        isDraft: false,
        mergeable: "MERGEABLE",
        checksStatus: "success",
        checks: [{ name: "unit-tests", status: "success" }],
        reviewDecision: "approved",
      },
    });
    harness.gitSnapshotsByCwd.set(repoDir, openCleanSnapshot);
    await harness.service.handleWorkspaceGitSnapshot(openCleanSnapshot);

    const accepted = await harness.service.reviewTask({
      taskId,
      verdict: "accept",
      summary: "PR 已就绪待人工合入",
      checks: [{ label: "CI", passed: true, evidence: "unit-tests passed" }],
    });
    expect(accepted.task.status).toBe("completed");
    expect(accepted.task.deliveryGate?.followUpActive).toBe(true);
    expect(accepted.deliveryGateWarning).toBeTruthy();

    // Post-accept PR merge -> emits pr_merged signal and turns off followUpActive (never auto-merges!)
    const mergedSnapshot = makeGitSnapshot({
      cwd: repoDir,
      branch: "feat/wave3-pr",
      pr: {
        number: 101,
        url: "https://github.com/paseo-org/demo-repo/pull/101",
        title: "Wave 3 Delivery Gate",
        state: "MERGED",
        baseRefName: "main",
        headRefName: "feat/wave3-pr",
        headSha: "sha_2",
        isMerged: true,
        isDraft: false,
        mergeable: "MERGEABLE",
        checksStatus: "success",
      },
    });
    await harness.service.handleWorkspaceGitSnapshot(mergedSnapshot);
    captureSignals();
    expect(observedSignalKinds.has("pr_merged")).toBe(true);
    const tasksAfterMerge = await harness.service.listTaskRecords({ includeCompleted: true });
    const mergedTask = tasksAfterMerge.find((t) => t.id === taskId)!;
    expect(mergedTask.deliveryGate?.prState).toBe("merged");
    expect(mergedTask.deliveryGate?.followUpActive).toBe(false);

    // Explicit bypass works when PR is blocked and user gives explicit reason
    const planBypass = await harness.service.createPlan(mainAgentId, {
      summary: "绕过测试",
      tasks: [
        {
          title: "允许人工绕过的任务",
          goal: "验证人工确认绕过门禁",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["人工确认"],
        },
      ],
    });
    const startedBypass = await harness.service.startPlan(planBypass.id);
    const bypassTaskId = startedBypass.tasks[0]!.taskRecordId!;
    await harness.service.syncTaskDeliveryGate(bypassTaskId, {
      prUrl: "https://github.com/paseo-org/demo-repo/pull/102",
      prNumber: 102,
      prState: "open",
      isDraft: true,
      hasConflict: false,
      ciStatus: "pending",
    });
    const bypassed = await harness.service.reviewTask({
      taskId: bypassTaskId,
      verdict: "accept",
      summary: "人工确认先以草稿合入前收口",
      bypassDeliveryGate: true,
      bypassReason: "用户确认仅需产出草稿 PR",
    });
    expect(bypassed.task.status).toBe("completed");
    expect(bypassed.deliveryGateWarning).toContain("已人工豁免");

    // --- Trigger ALL remaining reserved supervision signals ---
    // 1) decision_reply + escalated (from leader ask_user escalation) + decide (stale pending decision)
    const leaderConv = await harness.service.createConversation({
      kind: "leader",
      title: "架构演进方向",
      directionSummary: "负责长期架构拆分",
    });
    const decision = await harness.service.askUserDecision(mainAgentId, {
      title: "是否拆分新包",
      question: "请选择拆分方案",
      escalatedFromTitle: leaderConv.title,
      options: [
        { id: "opt_a", label: "保持当前包", leadsTo: "继续在现有包内迭代" },
        { id: "opt_b", label: "拆新包", leadsTo: "创建独立 workspace 子包" },
      ],
    });
    // Also create a second unanswered decision so `decide` signal fires on patrol
    await harness.service.askUserDecision(mainAgentId, {
      title: "是否启用新索引",
      question: "待拍板决定",
      options: [
        { id: "yes", label: "启用", leadsTo: "开启增量索引" },
        { id: "no", label: "暂缓", leadsTo: "维持现有全量扫描" },
      ],
    });
    await harness.service.answerDecision({
      decisionId: decision.id,
      optionId: "opt_a",
      answer: "保持当前包",
    });
    captureSignals();
    expect(observedSignalKinds.has("escalated")).toBe(true);
    expect(observedSignalKinds.has("decision_reply")).toBe(true);

    // 2) report (leader progress report) + parked task (check) + timed_out + orphaned + unjudged
    await harness.service.reportLeaderProgress({
      conversationId: leaderConv.id,
      conversationTitle: leaderConv.title,
      leaderAgentId: leaderConv.agentId,
      summary: "架构拆分第 1 阶段进展顺利，已完成接口对齐",
      completedItems: ["接口对齐"],
      activeCount: 1,
      blockedItems: [],
      reportedAt: new Date(clock).toISOString(),
    });
    captureSignals();

    const planSignals = await harness.service.createPlan(mainAgentId, {
      summary: "督办信号巡检批次",
      tasks: [
        {
          title: "超时任务",
          goal: "验证 timed_out",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["完成"],
        },
        {
          title: "孤儿任务",
          goal: "验证 orphaned",
          mode: "readonly",
          cwd: repoDir,
        },
        {
          title: "未判别收尾任务",
          goal: "验证 unjudged",
          mode: "readonly",
          cwd: repoDir,
        },
        {
          title: "挂起周期检查任务",
          goal: "验证 check",
          mode: "readonly",
          cwd: repoDir,
        },
      ],
    });
    const startedSignals = await harness.service.startPlan(planSignals.id);
    const timedOutAgentId = startedSignals.tasks[0]!.agentId!;
    const orphanedAgentId = startedSignals.tasks[1]!.agentId!;
    const unjudgedAgentId = startedSignals.tasks[2]!.agentId!;
    const parkedTaskId = startedSignals.tasks[3]!.taskRecordId!;
    await harness.service.parkTask({
      taskId: parkedTaskId,
      parked: true,
      reason: "等待外部审批窗口",
    });

    // Simulate active work on timedOutAgent -> then advance clock past minTimeoutMs
    const timedOutAgent = harness.agents.get(timedOutAgentId)!;
    timedOutAgent.lifecycle = "running";
    timedOutAgent.updatedAt = new Date(clock);
    harness.timelines.set(timedOutAgentId, [
      {
        type: "tool_call",
        name: "Edit",
        status: "completed",
        input: { file_path: "a.ts" },
      } as AgentTimelineItem,
    ]);

    // Simulate orphaned task: remove live agent from agentManager & storage
    harness.agents.delete(orphanedAgentId);
    harness.storedRecords.delete(orphanedAgentId);

    // Simulate unjudged stopped task (ambiguous reply, semantic triage returns null)
    const unjudgedAgent = harness.agents.get(unjudgedAgentId)!;
    unjudgedAgent.lifecycle = "idle";
    harness.timelines.set(unjudgedAgentId, [
      {
        type: "assistant_message",
        text: "这里先列一下观察到的现象。",
      } as AgentTimelineItem,
    ]);
    harness.emitAgentEvent({
      type: "agent_stream",
      agentId: unjudgedAgentId,
      event: { type: "turn_completed", provider: "claude" },
    } as AgentManagerEvent);
    await new Promise((resolve) => setTimeout(resolve, 40));
    captureSignals();

    // Advance clock by 45 minutes so timed_out, check, leader_stuck, decide all trigger!
    clock += 45 * 60_000;
    timedOutAgent.updatedAt = new Date(clock - 1_000);
    // Create an open task under leaderConv and keep leader idle for 45 min so `leader_stuck` fires
    const leaderPlan = await harness.service.createPlan(mainAgentId, {
      summary: "方向主管名下任务",
      conversationId: leaderConv.id,
      tasks: [
        {
          title: "方向子任务",
          goal: "挂载在方向主管名下",
          mode: "readonly",
          cwd: repoDir,
        },
      ],
    });
    await harness.service.startPlan(leaderPlan.id);
    const leaderLive = harness.agents.get(leaderConv.agentId);
    if (leaderLive) {
      leaderLive.updatedAt = new Date(clock - 45 * 60_000);
    }

    await harness.service.triggerPatrol({ mainAgentId });
    captureSignals();

    // Now stop ALL remaining agents for 35+ minutes so `all_stopped` fires on next patrol!
    timedOutAgent.lifecycle = "idle";
    timedOutAgent.updatedAt = new Date(clock);
    clock += 35 * 60_000;
    await harness.service.triggerPatrol({ mainAgentId });
    captureSignals();

    // Verify all core Wave 3 reserved signals were genuinely queued/delivered via real paths!
    for (const expectedKind of [
      "draft_pr",
      "pr_conflict",
      "pr_event",
      "pr_merged",
      "decision_reply",
      "escalated",
      "decide",
      "report",
      "timed_out",
      "orphaned",
      "check",
      "leader_stuck",
      "all_stopped",
      "unjudged",
    ] as const) {
      expect(
        observedSignalKinds.has(expectedKind),
        `Expected signal kind '${expectedKind}' to be queued (observed: ${Array.from(observedSignalKinds).join(", ")})`,
      ).toBe(true);
    }

    // Verify deduplication: running patrol again immediately does NOT duplicate identical fingerprints
    const countBeforeRepeat = (harness.service.listPendingSignals?.() ?? []).length;
    await harness.service.triggerPatrol({ mainAgentId });
    const countAfterRepeat = (harness.service.listPendingSignals?.() ?? []).length;
    expect(countAfterRepeat).toBeLessThanOrEqual(countBeforeRepeat);

    harness.service.stop();
  });

  it("P1-3: validates DAG (cycle / self-dep / 2-level partOf), gates blocked tasks, unlocks todo_ready on accept & PR merge (manual + autoStartOnReady), and emits parent_closeout when all slices complete", async () => {
    const clock = Date.parse("2026-11-25T04:00:00.000Z");
    const harness = makeWave3Harness(paseoHome, repoDir, {
      nowMs: () => clock,
      superviseGatherMs: 600_000,
    });
    await harness.service.start();
    await harness.service.updateSettings({ enabled: true });
    const ensured = await harness.service.ensureMainChat();
    const mainAgentId = ensured.agentId;

    // 1) Pure DAG cycle detection: self-dep, 2-node cycle, 3-node cycle, 2-level partOf nesting
    expect(() =>
      validateTaskDagBatch([], [{ id: "t1", title: "自依赖", partOf: null, after: ["t1"] }]),
    ).toThrow(TaskDagValidationError);

    expect(() =>
      validateTaskDagBatch(
        [],
        [
          { id: "a", title: "A", partOf: null, after: ["c"] },
          { id: "b", title: "B", partOf: null, after: ["a"] },
          { id: "c", title: "C", partOf: null, after: ["b"] },
        ],
      ),
    ).toThrow(TaskDagValidationError);

    expect(() =>
      validateTaskDagBatch(
        [],
        [
          { id: "parent", title: "父", partOf: null, after: [] },
          { id: "child", title: "子", partOf: "parent", after: [] },
          { id: "grandchild", title: "孙", partOf: "child", after: [] },
        ],
      ),
    ).toThrow(TaskDagValidationError);

    // createPlan rejects cyclic batch directly
    await expect(
      harness.service.createPlan(mainAgentId, {
        summary: "非法环依赖计划",
        tasks: [
          { refId: "x", title: "X", goal: "X", mode: "readonly", cwd: repoDir, after: ["y"] },
          { refId: "y", title: "Y", goal: "Y", mode: "readonly", cwd: repoDir, after: ["x"] },
        ],
      }),
    ).rejects.toThrow(/循环依赖|cycle/i);

    // 2) Valid parent + 3 child slices DAG:
    //    - parent (root task)
    //    - slice-1 (partOf: parent, no after -> starts immediately)
    //    - slice-2 (partOf: parent, after: [slice-1], autoStartOnReady: false -> blocked, waits for manual startReadyTask)
    //    - slice-3 (partOf: parent, after: [slice-2], autoStartOnReady: true -> blocked, auto-starts when slice-2 accepted!)
    const plan = await harness.service.createPlan(mainAgentId, {
      summary: "Wave 3 父子拆片 DAG",
      tasks: [
        {
          refId: "parent",
          title: "Wave 3 总控父任务",
          goal: "统筹协议、服务端与前端拆片",
          mode: "readonly",
          cwd: repoDir,
        },
        {
          refId: "slice-1",
          title: "拆片 1：协议与存储",
          goal: "补齐协议 schema 与持久化",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["协议构建通过"],
          partOf: "parent",
        },
        {
          refId: "slice-2",
          title: "拆片 2：服务端接线",
          goal: "在协议就绪后接线服务端",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["服务端单测通过"],
          partOf: "parent",
          after: ["slice-1"],
          autoStartOnReady: false,
        },
        {
          refId: "slice-3",
          title: "拆片 3：前端面板展示",
          goal: "在服务端就绪后自动拉起前端开发",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["前端单测通过"],
          partOf: "parent",
          after: ["slice-2"],
          autoStartOnReady: true,
        },
      ],
    });

    const started = await harness.service.startPlan(plan.id);
    const parentPlanned = started.tasks[0]!;
    const slice1Planned = started.tasks[1]!;
    const slice2Planned = started.tasks[2]!;
    const slice3Planned = started.tasks[3]!;

    // parent stays a container task (no wasted worker), slice-1 starts immediately, slice-2 & slice-3 MUST NOT start prematurely!
    expect(parentPlanned.taskRecordId).toBeTruthy();
    expect(parentPlanned.agentId).toBeNull();
    expect(slice1Planned.agentId).toBeTruthy();
    expect(slice2Planned.agentId).toBeNull();
    expect(slice3Planned.agentId).toBeNull();

    const tasksAfterStart = await harness.service.listTaskRecords({ includeCompleted: true });
    const slice2Record = tasksAfterStart.find((t) => t.id === slice2Planned.taskRecordId)!;
    const slice3Record = tasksAfterStart.find((t) => t.id === slice3Planned.taskRecordId)!;
    expect(slice2Record.dependencyState).toBe("blocked");
    expect(slice3Record.dependencyState).toBe("blocked");
    expect(slice2Record.partOf).toBe(parentPlanned.taskRecordId);

    // Attempting to start a still-blocked task MUST be rejected
    await expect(harness.service.startReadyTask(slice2Record.id)).rejects.toThrow(/前置依赖/);

    // 3) Accept slice-1 -> slice-2 unlocks to `ready` and emits `todo_ready` (NOT auto-started since autoStartOnReady=false)
    await harness.service.reviewTask({
      taskId: slice1Planned.taskRecordId!,
      verdict: "accept",
      summary: "协议与存储已完成",
      checks: [{ label: "build", passed: true, evidence: "ok" }],
    });

    const tasksAfterSlice1 = await harness.service.listTaskRecords({ includeCompleted: true });
    const slice2Ready = tasksAfterSlice1.find((t) => t.id === slice2Record.id)!;
    expect(slice2Ready.dependencyState).toBe("ready");
    expect(slice2Ready.activeAgentId).toBeNull();
    expect(
      (harness.service.listPendingSignals?.() ?? []).some(
        (s) => s.kind === "todo_ready" && s.taskId === slice2Record.id,
      ),
    ).toBe(true);

    // Start slice-2 via WebSocket Session RPC `main_chat.start_ready_task.request`
    const outbound: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.start_ready_task.request",
        requestId: "req_start_2",
        taskId: slice2Record.id,
      },
      (msg) => outbound.push(msg),
    );
    const startRpcResp = outbound.find((m) => m.type === "main_chat.start_ready_task.response");
    expect(
      startRpcResp?.type === "main_chat.start_ready_task.response" &&
        startRpcResp.payload.error === null &&
        Boolean(startRpcResp.payload.task?.activeAgentId),
    ).toBe(true);

    // 4) Accept slice-2 -> slice-3 unlocks AND auto-spawns because autoStartOnReady=true!
    await harness.service.reviewTask({
      taskId: slice2Record.id,
      verdict: "accept",
      summary: "服务端接线已完成",
      checks: [{ label: "server tests", passed: true, evidence: "ok" }],
    });

    const tasksAfterSlice2 = await harness.service.listTaskRecords({ includeCompleted: true });
    const slice3Started = tasksAfterSlice2.find((t) => t.id === slice3Record.id)!;
    expect(slice3Started.status).toBe("running");
    expect(slice3Started.activeAgentId).toBeTruthy();
    expect(
      harness.agents.get(slice3Started.activeAgentId!)?.labels[MAIN_CHAT_TASK_RECORD_ID_LABEL],
    ).toBe(slice3Record.id);

    // Parent closeout MUST NOT fire yet while slice-3 is still running
    expect(
      (harness.service.listPendingSignals?.() ?? []).some(
        (s) => s.kind === "parent_closeout" && s.taskId === parentPlanned.taskRecordId,
      ),
    ).toBe(false);

    // 5) Accept final slice-3 -> ALL child slices under parent are completed -> emits `parent_closeout`!
    await harness.service.reviewTask({
      taskId: slice3Record.id,
      verdict: "accept",
      summary: "前端面板展示已完成",
      checks: [{ label: "ui tests", passed: true, evidence: "ok" }],
    });

    const signalsAfterAllSlices = harness.service.listPendingSignals?.() ?? [];
    expect(
      signalsAfterAllSlices.some(
        (s) => s.kind === "parent_closeout" && s.taskId === parentPlanned.taskRecordId,
      ),
    ).toBe(true);

    // 6) Reject cyclic mutation via updateTaskDependencies RPC as well
    await expect(
      harness.service.updateTaskDependencies({
        taskId: parentPlanned.taskRecordId!,
        after: [parentPlanned.taskRecordId!],
      }),
    ).rejects.toThrow(/自依赖|循环依赖|cycle/i);

    harness.service.stop();
  });
});
