import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES,
  MAIN_CHAT_CONVERSATION_ID_LABEL,
  MAIN_CHAT_CONVERSATION_KIND_LABEL,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_ID_LABEL,
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
  MAIN_CHAT_TASK_RECORD_ID_LABEL,
  expandMainChatPromptTemplate,
  resolvePromptTemplateSlashInvocation,
} from "@getpaseo/protocol/main-chat";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, PersistedAgentRecord } from "../agent/agent-storage.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import type { SessionOutboundMessage } from "../messages.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import { evaluateIdleSubagentArchiveEligibility } from "./idle-archive.js";
import {
  sampleLocalHostOsResources,
  type HostResourceSampler,
  type LocalHostResourceSample,
} from "./resource-admission.js";
import { createMainChatService } from "./service.js";
import { handleMainChatSessionMessage, type MainChatSessionMessage } from "./session.js";
import { buildSettingsProposal } from "./settings-proposal.js";
import type { StatelessSupervisionRunner } from "./stateless-supervision.js";
import { measureToolManifestBytes } from "./tool-loading.js";
import { registerMainChatTools } from "./tools.js";

const logger = pino({ level: "silent" });

interface Wave5HarnessOptions {
  nowMs?: () => number;
  hostResourceSampler?: HostResourceSampler;
  statelessSupervisionRunner?: StatelessSupervisionRunner;
  initialChildLifecycle?: ManagedAgent["lifecycle"];
}

function makeWave5Harness(paseoHome: string, repoDir: string, options: Wave5HarnessOptions = {}) {
  let agentSeq = 0;
  const agents = new Map<string, ManagedAgent>();
  const storedRecords = new Map<string, PersistedAgentRecord>();
  const timelines = new Map<string, AgentTimelineItem[]>();
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  const sentPrompts: Array<{ agentId: string; prompt: unknown }> = [];
  const archivedAgentIds: string[] = [];
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
    lifecycle?: ManagedAgent["lifecycle"];
    updatedAtMs?: number;
    requiresAttention?: boolean;
    pendingPermissionIds?: string[];
    activeTurnId?: string | null;
  }): ManagedAgent {
    const stamp = new Date(params.updatedAtMs ?? nowMs());
    const pendingPermissions = new Map<string, { id: string; name: string }>();
    for (const pid of params.pendingPermissionIds ?? []) {
      pendingPermissions.set(pid, { id: pid, name: "Bash" });
    }
    const live = {
      id: params.id,
      provider: (params.provider ?? "claude") as ManagedAgent["provider"],
      cwd: params.cwd ?? repoDir,
      workspaceId: params.workspaceId ?? "ws_repo",
      lifecycle: params.lifecycle ?? ("idle" as ManagedAgent["lifecycle"]),
      config: {
        provider: (params.provider ?? "claude") as ManagedAgent["provider"],
        cwd: params.cwd ?? repoDir,
        title: params.title ?? params.id,
        model: params.model ?? "claude-opus-4-6",
        labels: params.labels ?? {},
      },
      runtimeInfo: {
        provider: (params.provider ?? "claude") as ManagedAgent["provider"],
        sessionId: `sess_${params.id}`,
        model: params.model ?? "claude-opus-4-6",
      },
      labels: { ...params.labels },
      pendingPermissions,
      attention: params.requiresAttention
        ? { requiresAttention: true, reason: "needs_input" }
        : { requiresAttention: false },
      activeTurnId: params.activeTurnId ?? null,
      background: false,
      internal: false,
      createdAt: stamp,
      updatedAt: stamp,
      lastError: null,
      lastUsage: null,
    } as unknown as ManagedAgent;
    agents.set(live.id, live);
    storedRecords.set(live.id, {
      id: live.id,
      provider: live.provider,
      cwd: live.cwd,
      workspaceId: live.workspaceId,
      createdAt: stamp.toISOString(),
      updatedAt: stamp.toISOString(),
      archivedAt: null,
      title: params.title ?? params.id,
      labels: { ...live.labels },
      metadata: {},
      lastStatus: live.lifecycle,
      config: { model: params.model ?? "claude-opus-4-6" },
      runtimeInfo: live.runtimeInfo,
      lastError: null,
    } as unknown as PersistedAgentRecord);
    return live;
  }

  const agentManager = {
    getAgent: (id: string) => agents.get(id),
    listAgents: () => Array.from(agents.values()),
    subscribe: (listener: (event: AgentManagerEvent) => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    getTimeline: (id: string) => timelines.get(id) ?? [],
    createAgent: async (
      config: {
        provider?: string;
        model?: string;
        cwd: string;
        workspaceId?: string;
        title?: string;
        labels?: Record<string, string>;
      },
      agentId?: string,
      createOptions?: {
        workspaceId?: string;
        labels?: Record<string, string>;
      },
    ) => {
      agentSeq += 1;
      const mergedLabels = { ...config.labels, ...createOptions?.labels };
      const isMain = mergedLabels[MAIN_CHAT_ROLE_LABEL] === MAIN_CHAT_ROLE_VALUE;
      const id = agentId ?? (isMain ? `agent_main_${agentSeq}` : `agent_child_${agentSeq}`);
      const lifecycle = isMain
        ? "idle"
        : (options.initialChildLifecycle ?? ("running" as ManagedAgent["lifecycle"]));
      return makeLiveAgent({
        id,
        provider: config.provider,
        model: config.model,
        cwd: config.cwd,
        workspaceId: createOptions?.workspaceId ?? config.workspaceId,
        title: config.title,
        labels: mergedLabels,
        lifecycle,
      });
    },
    getRegisteredProviderIds: () => ["claude"],
    getLastAssistantMessage: async () => null,
    sendPrompt: async (agentId: string, prompt: unknown) => {
      sentPrompts.push({ agentId, prompt });
    },
    streamAgent: async function* (
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
      yield { type: "turn_started", provider: "claude" } as never;
      yield { type: "turn_completed", provider: "claude" } as never;
    },
    hasInFlightRun: () => false,
    notifyAgentState: () => undefined,
    unarchiveSnapshot: () => undefined,
    replaceAgentRun: () => undefined,
    steerOrReplaceActiveTurn: () => undefined,
    hydrateTimelineFromProvider: async () => undefined,
    resumeAgentFromPersistence: async () => undefined,
    waitForAgentClose: async () => undefined,
    setDaemonBackgroundWork: () => undefined,
    removeDaemonBackgroundWork: () => undefined,
    reloadAgentSession: async () => undefined,
    reloadStalePluginSession: async () => undefined,
    tryRunOutOfBand: async () => false,
    archiveAgent: async (agentId: string) => {
      const archivedAt = new Date(nowMs()).toISOString();
      archivedAgentIds.push(agentId);
      agents.delete(agentId);
      const stored = storedRecords.get(agentId);
      if (stored) {
        storedRecords.set(agentId, { ...stored, archivedAt } as PersistedAgentRecord);
      }
      emitAgentEvent({ type: "agent_removed", agentId });
      return { archivedAt };
    },
    cancelAgent: async () => undefined,
    closeAgent: async (agentId: string) => {
      const agent = agents.get(agentId);
      if (agent) {
        (agent as { lifecycle: string }).lifecycle = "closed";
      }
    },
    updateAgentMetadata: async (
      agentId: string,
      patch: { title?: string; labels?: Record<string, string> },
    ) => {
      const live = agents.get(agentId);
      if (live) {
        if (patch.title) live.config.title = patch.title;
        if (patch.labels) live.labels = { ...live.labels, ...patch.labels };
      }
      const rec = storedRecords.get(agentId);
      if (rec) {
        if (patch.title) rec.title = patch.title;
        if (patch.labels) rec.labels = { ...rec.labels, ...patch.labels };
      }
      return live ?? null;
    },
    updateAgentLabels: async (agentId: string, labels: Record<string, string>) => {
      const live = agents.get(agentId);
      if (live) live.labels = { ...live.labels, ...labels };
      const rec = storedRecords.get(agentId);
      if (rec) rec.labels = { ...rec.labels, ...labels };
    },
    respondToPermission: async () => undefined,
    setModel: async () => undefined,
    setAgentModel: async () => undefined,
  } as unknown as AgentManager;

  const agentStorage = {
    get: async (id: string) => storedRecords.get(id) ?? null,
    list: async () => Array.from(storedRecords.values()),
    listActive: async () => Array.from(storedRecords.values()).filter((r) => !r.archivedAt),
    listAll: async () => Array.from(storedRecords.values()),
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
    setArchived: async () => undefined,
  } as unknown as AgentStorage;

  const providerSnapshotManager = {
    getSnapshot: () => ({
      records: [
        {
          entry: {
            provider: "claude",
            enabled: true,
            status: "ready",
            availability: { state: "available" },
            models: [
              { id: "claude-opus-4-6", label: "Claude Opus 4.6", isDefault: true },
              { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
            ],
          },
        },
      ],
    }),
    listProviders: async () => [
      {
        provider: "claude",
        enabled: true,
        status: "ready",
        models: [
          { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
          { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
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

  const workspaceRegistry = {
    get: (id: string) => workspaces.get(id) ?? undefined,
    list: () => Array.from(workspaces.values()),
    listActive: () => Array.from(workspaces.values()),
    update: async (id: string, fn: (r: PersistedWorkspaceRecord) => PersistedWorkspaceRecord) => {
      const existing = workspaces.get(id);
      if (!existing) return null;
      const updated = fn(existing);
      workspaces.set(id, updated);
      return updated;
    },
  } as unknown as Pick<WorkspaceRegistry, "get" | "listActive"> &
    Partial<Pick<WorkspaceRegistry, "update">>;

  const service = createMainChatService({
    paseoHome,
    worktreesRoot: path.join(paseoHome, "worktrees"),
    serverId: "srv_local",
    hostLabel: "DevBox-Local",
    agentManager,
    agentStorage,
    providerSnapshotManager,
    workspaceRegistry,
    finishSubscriptions: () =>
      ({
        register: async () => ({
          accept: () => undefined,
          reject: async () => undefined,
        }),
      }) as unknown as NonNullable<
        ReturnType<NonNullable<Parameters<typeof createMainChatService>[0]["finishSubscriptions"]>>
      >,
    createDirectoryWorkspace: async (cwd, title) => {
      const existing = Array.from(workspaces.values()).find((ws) => ws.cwd === cwd);
      if (existing) return existing;
      const id = `ws_${workspaces.size + 1}`;
      const record = {
        workspaceId: id,
        id,
        cwd,
        workspaceDirectory: cwd,
        title: title ?? path.basename(cwd),
        createdAt: new Date(nowMs()).toISOString(),
        updatedAt: new Date(nowMs()).toISOString(),
      } as unknown as PersistedWorkspaceRecord;
      workspaces.set(id, record);
      return record;
    },
    hostResourceSampler: options.hostResourceSampler,
    statelessSupervisionRunner: options.statelessSupervisionRunner,
    now: nowMs,
    superviseGatherMs: 1,
    normalCooldownMs: 0,
    urgentCooldownMs: 0,
    turnQueueDrainDelayMs: 1,
    logger,
  });

  async function callRpc<T extends SessionOutboundMessage>(
    msg: MainChatSessionMessage,
  ): Promise<T> {
    const replies: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(service, msg, (out) => replies.push(out));
    expect(replies).toHaveLength(1);
    return replies[0] as T;
  }

  return {
    service,
    agentManager,
    agents,
    storedRecords,
    sentPrompts,
    archivedAgentIds,
    makeLiveAgent,
    emitAgentEvent,
    callRpc,
  };
}

describe("Wave 5: Resource Admission, Stateless Supervision + On-Demand Tools, Idle Archive & Prompt Library", () => {
  let tmpRoot = "";
  let paseoHome = "";
  let repoDir = "";

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-wave5-"));
    paseoHome = path.join(tmpRoot, "paseo-home");
    repoDir = path.join(tmpRoot, "repo");
    await mkdir(paseoHome, { recursive: true });
    await mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    if (tmpRoot) {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  // ==========================================================================
  // P2-2: Cross-Host Resource Admission Gate
  // ==========================================================================

  it("P2-2: allows healthy dispatch, queues on concurrency/CPU/memory pressure, auto-dequeues on release, and rejects when queueWhenPressured=false", async () => {
    let currentSample: LocalHostResourceSample = {
      cpuPercent: 32,
      loadAvg1m: 2.5,
      cpuCores: 8,
      freeMemoryMb: 8192,
      totalMemoryMb: 16384,
    };
    const harness = makeWave5Harness(paseoHome, repoDir, {
      hostResourceSampler: () => currentSample,
      initialChildLifecycle: "running",
    });

    await harness.service.start();
    await harness.service.updateSettings({
      enabled: true,
      resourceAdmission: {
        enabled: true,
        maxConcurrentPerHost: 1,
        maxCpuPercent: 80,
        minFreeMemoryMb: 2048,
        queueWhenPressured: true,
      },
    });
    const main = await harness.service.ensureMainChat();

    // Local OS sampler sanity check
    const realOsSample = sampleLocalHostOsResources();
    expect(realOsSample.totalMemoryMb).toBeGreaterThan(0);

    // 1. First task fits within maxConcurrentPerHost=1 -> allowed immediately
    const plan1 = await harness.service.createPlan(main.agentId, {
      autoStart: true,
      tasks: [{ title: "任务一", goal: "占用第 1 个槽位", mode: "readonly", cwd: repoDir }],
    });
    const firstAgentId = plan1.tasks[0]!.agentId;
    expect(plan1.tasks[0]!.startError).toBeNull();
    expect(firstAgentId).toBeTruthy();

    // 2. Second task hits concurrency limit (1/1) -> queued with position=1
    const plan2 = await harness.service.createPlan(main.agentId, {
      autoStart: true,
      tasks: [{ title: "任务二", goal: "排队等待槽位释放", mode: "readonly", cwd: repoDir }],
    });
    expect(plan2.tasks[0]!.agentId).toBeNull();
    expect(plan2.tasks[0]!.startError).toBeNull();

    const snap1 = await harness.service.getResourceAdmission();
    expect(snap1.summary.queuedCount).toBe(1);
    expect(snap1.summary.pressuredHosts).toBe(1);
    expect(snap1.queue[0]!.position).toBe(1);
    expect(snap1.queue[0]!.reasonCode).toBe("concurrency_limit");
    expect(snap1.queue[0]!.title).toBe("任务二");

    const tasksAfterQueue = await harness.service.listTaskRecords({ includeCompleted: true });
    const queuedTaskRec = tasksAfterQueue.find((t) => t.title === "任务二");
    expect(queuedTaskRec?.admissionState?.status).toBe("queued");
    expect(queuedTaskRec?.admissionState?.position).toBe(1);

    // 3. First child completes -> slot frees up -> automatic dequeue dispatches 任务二
    const firstLive = harness.agents.get(firstAgentId!)!;
    (firstLive as { lifecycle: string }).lifecycle = "idle";
    harness.emitAgentEvent({
      type: "agent_state",
      agent: firstLive,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const snapAfterAutoDequeue = await harness.service.getResourceAdmission();
    expect(snapAfterAutoDequeue.summary.queuedCount).toBe(0);
    const updatedTasks = await harness.service.listTaskRecords({ includeCompleted: true });
    const dequeuedRec = updatedTasks.find((t) => t.title === "任务二");
    expect(dequeuedRec?.activeAgentId).toBeTruthy();
    expect(dequeuedRec?.admissionState).toBeNull();
    expect(harness.service.getMetrics().admissionDequeued).toBeGreaterThanOrEqual(1);

    // Mark second child idle so concurrency is 0/1
    const secondLive = harness.agents.get(dequeuedRec!.activeAgentId!)!;
    (secondLive as { lifecycle: string }).lifecycle = "idle";

    // 4. CPU pressure + queueWhenPressured=true -> queued; then RPC force_dispatch overrides and launches
    currentSample = {
      cpuPercent: 94,
      loadAvg1m: 7.5,
      cpuCores: 8,
      freeMemoryMb: 6000,
      totalMemoryMb: 16384,
    };
    const plan3 = await harness.service.createPlan(main.agentId, {
      autoStart: true,
      tasks: [{ title: "高负载排队任务", goal: "等待或手动放行", mode: "readonly", cwd: repoDir }],
    });
    expect(plan3.tasks[0]!.agentId).toBeNull();

    const rpcSnap = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.get_resource_admission.response" }>
    >({
      type: "main_chat.get_resource_admission.request",
      requestId: "req_adm_get",
    });
    expect(rpcSnap.payload.error).toBeNull();
    expect(rpcSnap.payload.snapshot?.queue).toHaveLength(1);
    expect(rpcSnap.payload.snapshot?.queue[0]!.reasonCode).toBe("cpu_high");

    const queueId = rpcSnap.payload.snapshot!.queue[0]!.id;
    const rpcForce = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.drain_admission_queue.response" }>
    >({
      type: "main_chat.drain_admission_queue.request",
      requestId: "req_adm_force",
      action: "force_dispatch",
      queueId,
    });
    expect(rpcForce.payload.error).toBeNull();
    expect(rpcForce.payload.dispatchedCount).toBe(1);
    expect(rpcForce.payload.remainingCount).toBe(0);

    // 5. Low memory + queueWhenPressured=false -> explicit refusal with actionable suggestion
    await harness.service.updateSettings({
      resourceAdmission: { queueWhenPressured: false },
    });
    currentSample = {
      cpuPercent: 25,
      loadAvg1m: 2.0,
      cpuCores: 8,
      freeMemoryMb: 512,
      totalMemoryMb: 16384,
    };
    // Clear active running child first
    for (const a of harness.agents.values()) {
      (a as { lifecycle: string }).lifecycle = "idle";
    }
    const plan4 = await harness.service.createPlan(main.agentId, {
      autoStart: true,
      tasks: [{ title: "内存不足被拒任务", goal: "验证显式拒绝", mode: "readonly", cwd: repoDir }],
    });
    expect(plan4.tasks[0]!.agentId).toBeNull();
    expect(plan4.tasks[0]!.startError).toContain("可用内存不足");
    expect(plan4.tasks[0]!.startError).toContain("建议");
    expect(harness.service.getMetrics().admissionRejected).toBeGreaterThanOrEqual(1);

    const rejectedTask = (await harness.service.listTaskRecords({ includeCompleted: true })).find(
      (t) => t.title === "内存不足被拒任务",
    );
    expect(rejectedTask?.admissionState?.status).toBe("rejected");
    expect(rejectedTask?.admissionState?.reasonCode).toBe("memory_low");

    // 6. RPC clear queue works cleanly
    await harness.service.updateSettings({
      resourceAdmission: { queueWhenPressured: true },
    });
    await harness.service.createPlan(main.agentId, {
      autoStart: true,
      tasks: [{ title: "待清空任务", goal: "测试清空排队", mode: "readonly", cwd: repoDir }],
    });
    const rpcClear = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.drain_admission_queue.response" }>
    >({
      type: "main_chat.drain_admission_queue.request",
      requestId: "req_adm_clear",
      action: "clear",
    });
    expect(rpcClear.payload.removedCount).toBe(1);
    expect(rpcClear.payload.remainingCount).toBe(0);

    harness.service.stop();
  });

  // ==========================================================================
  // P2-3: Stateless Single-Round Supervision & On-Demand Tool Loading
  // ==========================================================================

  it("P2-3A: runs compact stateless single-round supervision without waking main chat, and escalates only when needed", async () => {
    const capturedPackets: string[] = [];
    let nextDecision: "silent" | "log_only" | "escalate_main" = "log_only";

    const harness = makeWave5Harness(paseoHome, repoDir, {
      statelessSupervisionRunner: async (input) => {
        capturedPackets.push(input.packet);
        return {
          outcome: {
            decision: nextDecision,
            summary:
              nextDecision === "escalate_main"
                ? "检测到需要主对话编排处理的风险动态"
                : "低风险例行汇报已结构化记入后台台账",
            escalationReason: nextDecision === "escalate_main" ? "需要主对话复核决策" : null,
            recommendedAction: nextDecision === "escalate_main" ? "请主对话介入确认" : null,
          },
        };
      },
    });

    await harness.service.start();
    await harness.service.updateSettings({
      enabled: true,
      statelessBackgroundSupervision: true,
      capabilities: {
        proactiveWakeupEnabled: true,
        initialBriefingEnabled: false,
      },
    });
    const main = await harness.service.ensureMainChat();
    const promptsBefore = harness.sentPrompts.filter((p) => p.agentId === main.agentId).length;

    // Trigger a routine low-risk PR merged / report supervision signal through supervisor
    // Simulate a completed task receiving a PR merge delivery gate update -> emits pr_merged signal
    const childAgent = harness.makeLiveAgent({
      id: "agent_pr_child",
      title: "PR 合并测试任务",
      lifecycle: "idle",
      labels: {
        [MAIN_CHAT_TASK_PLAN_ID_LABEL]: "plan_pr",
        [MAIN_CHAT_TASK_ID_LABEL]: "pt_pr",
        [MAIN_CHAT_TASK_RECORD_ID_LABEL]: "task_pr_1",
      },
    });

    // Directly enqueue low-risk progress by simulating a quiet child stalled/report through plan+review or patrol
    // Let's create a plan with a task and sync delivery gate PR open -> merged to trigger `pr_merged` signal!
    const plan = await harness.service.createPlan(main.agentId, {
      autoStart: true,
      tasks: [{ title: "同步 PR 状态", goal: "验证无状态督办", mode: "readonly", cwd: repoDir }],
    });
    const taskId = plan.tasks[0]!.taskRecordId!;
    await harness.service.syncTaskDeliveryGate(taskId, {
      prUrl: "https://github.com/org/repo/pull/42",
      prNumber: 42,
      prState: "open",
      isDraft: false,
      hasConflict: false,
      followUpActive: true,
    });
    await harness.service.syncTaskDeliveryGate(taskId, {
      prUrl: "https://github.com/org/repo/pull/42",
      prNumber: 42,
      prState: "merged",
      isDraft: false,
      hasConflict: false,
      followUpActive: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Stateless runner ran once with compact packet, and main chat was NOT woken!
    expect(capturedPackets.length).toBeGreaterThanOrEqual(1);
    expect(capturedPackets[0]).toContain("无状态单轮后台督办评估器");
    const promptsAfterLowRisk = harness.sentPrompts.filter(
      (p) => p.agentId === main.agentId,
    ).length;
    expect(promptsAfterLowRisk).toBe(promptsBefore);

    const activities = await harness.service.listActivity({
      mainAgentId: main.agentId,
      includeSilent: true,
    });
    const statelessEntry = activities.activities.find((a) => a.trigger === "stateless_supervision");
    expect(statelessEntry).toBeTruthy();
    expect(statelessEntry?.summary).toContain("[无状态督办·log_only]");
    expect(harness.service.getMetrics().statelessSupervisionRounds).toBeGreaterThanOrEqual(1);

    // Now test escalation: runner returns escalate_main -> wakes main chat with compact preface
    nextDecision = "escalate_main";
    const plan2 = await harness.service.createPlan(main.agentId, {
      autoStart: true,
      tasks: [{ title: "需升级 PR 任务", goal: "验证升级主对话", mode: "readonly", cwd: repoDir }],
    });
    const task2Id = plan2.tasks[0]!.taskRecordId!;
    await harness.service.syncTaskDeliveryGate(task2Id, {
      prUrl: "https://github.com/org/repo/pull/99",
      prNumber: 99,
      prState: "open",
      isDraft: false,
      hasConflict: false,
      followUpActive: true,
    });
    await harness.service.syncTaskDeliveryGate(task2Id, {
      prUrl: "https://github.com/org/repo/pull/99",
      prNumber: 99,
      prState: "merged",
      isDraft: false,
      hasConflict: false,
      followUpActive: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));

    const promptsAfterEscalation = harness.sentPrompts.filter((p) => p.agentId === main.agentId);
    expect(promptsAfterEscalation.length).toBeGreaterThan(promptsBefore);
    expect(String(promptsAfterEscalation.at(-1)?.prompt)).toContain("【无状态单轮后台督办升级】");
    expect(harness.service.getMetrics().statelessSupervisionEscalations).toBeGreaterThanOrEqual(1);

    void childAgent;
    harness.service.stop();
  });

  it("P2-3B: shrinks initial tool manifest under onDemandToolLoading and dynamically activates domain groups with schemas", async () => {
    const harness = makeWave5Harness(paseoHome, repoDir);
    await harness.service.start();
    await harness.service.updateSettings({ enabled: true, onDemandToolLoading: false });
    const main = await harness.service.ensureMainChat();

    // 1. Disabled mode: all main-chat tools immediately visible
    const fullTools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager: harness.agentManager,
      mainChatService: harness.service,
      callerAgentId: main.agentId,
      scope: "agent",
      tools: fullTools,
      builtinNames: new Set(),
    });
    expect(fullTools.has("task_list")).toBe(true);
    expect(fullTools.has("memory_write")).toBe(true);
    expect(fullTools.has("lesson_add")).toBe(true);
    expect(fullTools.has("routine_create")).toBe(true);
    expect(fullTools.has("settings_propose_patch")).toBe(true);
    expect(fullTools.has("conversation_new")).toBe(true);
    const fullBytes = measureToolManifestBytes(fullTools);

    // 2. Enabled mode: only lightweight core tools + tool_catalog / tool_load initially visible
    await harness.service.updateSettings({ onDemandToolLoading: true });
    harness.service.getToolLoaderRegistry().resetAll();
    const activatedCallbacks: string[][] = [];
    const onDemandTools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager: harness.agentManager,
      mainChatService: harness.service,
      callerAgentId: main.agentId,
      scope: "agent",
      tools: onDemandTools,
      builtinNames: new Set(),
      onToolsActivated: (defs) => activatedCallbacks.push(defs.map((d) => d.name)),
    });

    expect(onDemandTools.has("task_list")).toBe(true);
    expect(onDemandTools.has("task_plan")).toBe(true);
    expect(onDemandTools.has("task_start")).toBe(true);
    expect(onDemandTools.has("task_review")).toBe(true);
    expect(onDemandTools.has("task_ask_user")).toBe(true);
    expect(onDemandTools.has("tool_catalog")).toBe(true);
    expect(onDemandTools.has("tool_load")).toBe(true);
    // Deferred tools are NOT in initial manifest
    expect(onDemandTools.has("memory_write")).toBe(false);
    expect(onDemandTools.has("lesson_add")).toBe(false);
    expect(onDemandTools.has("routine_create")).toBe(false);
    expect(onDemandTools.has("settings_propose_patch")).toBe(false);
    expect(onDemandTools.has("conversation_new")).toBe(false);

    const onDemandInitialBytes = measureToolManifestBytes(onDemandTools);
    // Significant initial manifest reduction (>45% smaller)
    expect(onDemandInitialBytes).toBeLessThan(fullBytes * 0.55);

    // 3. Call tool_catalog -> shows unloaded groups
    const catalogRes = await onDemandTools.get("tool_catalog")!.handler({}, {});
    const catalogData = catalogRes.structuredContent as {
      onDemandToolLoading: boolean;
      groups: Array<{ id: string; loaded: boolean; totalCount: number }>;
    };
    expect(catalogData.onDemandToolLoading).toBe(true);
    expect(catalogData.groups.map((g) => g.id)).toEqual(
      expect.arrayContaining(["memory", "lessons", "routines", "dag", "settings", "conversations"]),
    );
    expect(catalogData.groups.find((g) => g.id === "memory")?.loaded).toBe(false);

    // 4. Dynamically activate "memory" & "settings" via tool_load -> tools become callable + return JSON schemas
    const loadRes = await onDemandTools
      .get("tool_load")!
      .handler({ groups: ["memory", "settings"] }, {});
    const loadData = loadRes.structuredContent as {
      newlyActivatedToolNames: string[];
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
    };
    expect(loadData.newlyActivatedToolNames).toEqual(
      expect.arrayContaining([
        "memory_list",
        "memory_read",
        "memory_write",
        "memory_delete",
        "settings_propose_patch",
      ]),
    );
    expect(activatedCallbacks.flat()).toContain("memory_write");
    const memWriteSchema = loadData.tools.find((t) => t.name === "memory_write")?.inputSchema;
    expect(memWriteSchema).toBeTruthy();
    expect(memWriteSchema?.type).toBe("object");

    // 5. Invoke dynamically loaded memory_write + memory_read -> behaves identically to full mode
    expect(onDemandTools.has("memory_write")).toBe(true);
    await onDemandTools
      .get("memory_write")!
      .handler({ path: "notes/wave5.md", content: "# Wave 5\n工具按需加载验证通过" }, {});
    const readRes = await onDemandTools.get("memory_read")!.handler({ path: "notes/wave5.md" }, {});
    expect(JSON.stringify(readRes.structuredContent)).toContain("工具按需加载验证通过");

    harness.service.stop();
  });

  // ==========================================================================
  // P2-4A: Idle Subagent Auto-Archive with Strict Refusal Red Lines
  // ==========================================================================

  it("P2-4A: enforces all idle auto-archive safety red lines and safely archives only eligible closed subagents", async () => {
    let fakeNow = Date.parse("2026-11-25T10:00:00.000Z");
    const twoHoursAgo = fakeNow - 120 * 60_000;
    const twentyMinAgo = fakeNow - 20 * 60_000;

    const harness = makeWave5Harness(paseoHome, repoDir, {
      nowMs: () => fakeNow,
      initialChildLifecycle: "idle",
    });

    await harness.service.start();
    await harness.service.updateSettings({
      enabled: true,
      idleArchivePolicy: { enabled: true, idleThresholdMinutes: 60 },
    });
    const main = await harness.service.ensureMainChat();

    // Create direction leader (must NEVER archive)
    const leaderConv = await harness.service.createConversation({
      kind: "leader",
      title: "后端方向主管",
      directionSummary: "负责后端架构",
    });
    const leaderLive = harness.agents.get(leaderConv.agentId)!;
    leaderLive.updatedAt = new Date(twoHoursAgo);

    // Create manual user session (must NEVER archive)
    harness.makeLiveAgent({
      id: "agent_manual_1",
      title: "用户手动调试会话",
      lifecycle: "idle",
      updatedAtMs: twoHoursAgo,
    });

    // Helper to create a managed task + child agent with custom status/flags
    async function spawnManaged(
      title: string,
      opts: {
        completeTask?: boolean;
        lifecycle?: ManagedAgent["lifecycle"];
        updatedAtMs?: number;
        pendingPermission?: boolean;
        openDecision?: boolean;
        activePrFollowUp?: boolean;
        requiresAttention?: boolean;
      },
    ) {
      const plan = await harness.service.createPlan(main.agentId, {
        autoStart: true,
        tasks: [{ title, goal: `测试 ${title}`, mode: "readonly", cwd: repoDir }],
      });
      const agentId = plan.tasks[0]!.agentId!;
      const taskId = plan.tasks[0]!.taskRecordId!;
      if (opts.completeTask) {
        await harness.service.reviewTask({
          taskId,
          verdict: "accept",
          summary: "已验证通过",
          checks: [{ criterion: "done", met: true, evidence: "ok" }],
        });
      }
      if (opts.activePrFollowUp) {
        await harness.service.syncTaskDeliveryGate(taskId, {
          prUrl: "https://github.com/org/repo/pull/77",
          prNumber: 77,
          prState: "open",
          isDraft: false,
          hasConflict: false,
          followUpActive: true,
        });
      }
      if (opts.openDecision) {
        await harness.service.askUserDecision(main.agentId, {
          title,
          question: "选方案 A 还是 B？",
          agentId,
          taskId,
          options: [
            { id: "a", label: "A", leadsTo: "执行 A" },
            { id: "b", label: "B", leadsTo: "执行 B" },
          ],
        });
      }
      const live = harness.agents.get(agentId)!;
      (live as { lifecycle: string }).lifecycle = opts.lifecycle ?? "idle";
      live.updatedAt = new Date(opts.updatedAtMs ?? twoHoursAgo);
      if (opts.pendingPermission) {
        live.pendingPermissions.set("perm_1", {
          id: "perm_1",
          name: "Bash",
        } as unknown as ManagedAgent["pendingPermissions"] extends Map<string, infer V>
          ? V
          : never);
      }
      if (opts.requiresAttention) {
        live.attention = {
          requiresAttention: true,
          reason: "finished",
        } as ManagedAgent["attention"];
      }
      return { agentId, taskId };
    }

    const runningChild = await spawnManaged("运行中子会话", {
      completeTask: false,
      lifecycle: "running",
      updatedAtMs: twoHoursAgo,
    });
    const permChild = await spawnManaged("待审批权限子会话", {
      completeTask: true,
      pendingPermission: true,
      updatedAtMs: twoHoursAgo,
    });
    const decisionChild = await spawnManaged("待拍板决策子会话", {
      completeTask: true,
      openDecision: true,
      updatedAtMs: twoHoursAgo,
    });
    const unclosedChild = await spawnManaged("未结项任务子会话", {
      completeTask: false,
      lifecycle: "idle",
      updatedAtMs: twoHoursAgo,
    });
    const prChild = await spawnManaged("活跃PR跟进子会话", {
      completeTask: true,
      activePrFollowUp: true,
      updatedAtMs: twoHoursAgo,
    });
    const recentChild = await spawnManaged("刚结项未超阈值子会话", {
      completeTask: true,
      updatedAtMs: twentyMinAgo,
    });
    const eligibleChild = await spawnManaged("已结项闲置超阈值子会话", {
      completeTask: true,
      updatedAtMs: twoHoursAgo,
    });

    // Advance fakeNow by 90 minutes so completedAt of eligibleChild is >= 60 minutes old,
    // while keeping recentChild's updatedAt only 20 minutes old!
    fakeNow += 90 * 60_000;
    harness.agents.get(recentChild.agentId)!.updatedAt = new Date(fakeNow - 20 * 60_000);

    // 1. Dry-run RPC previews eligible & every single refusal code WITHOUT archiving anything
    const dryRunRes = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.sweep_idle_subagents.response" }>
    >({
      type: "main_chat.sweep_idle_subagents.request",
      requestId: "req_idle_dry",
      dryRun: true,
    });
    expect(dryRunRes.payload.error).toBeNull();
    const dryResult = dryRunRes.payload.result!;
    expect(dryResult.dryRun).toBe(true);
    expect(dryResult.archivedCount).toBe(0);
    expect(dryResult.eligible.map((e) => e.agentId)).toEqual([eligibleChild.agentId]);
    expect(harness.archivedAgentIds).toHaveLength(0);

    const refusalByAgent = new Map(dryResult.refused.map((r) => [r.agentId, r.refusalCode]));
    expect(refusalByAgent.get(main.agentId)).toBe("is_main_chat");
    expect(refusalByAgent.get(leaderConv.agentId)).toBe("is_direction_leader");
    expect(refusalByAgent.get("agent_manual_1")).toBe("is_manual_session");
    expect(refusalByAgent.get(runningChild.agentId)).toBe("is_running");
    expect(refusalByAgent.get(permChild.agentId)).toBe("has_pending_permission");
    expect(refusalByAgent.get(decisionChild.agentId)).toBe("has_open_decision");
    expect(refusalByAgent.get(unclosedChild.agentId)).toBe("has_unclosed_task");
    expect(refusalByAgent.get(prChild.agentId)).toBe("has_active_pr_followup");
    expect(refusalByAgent.get(recentChild.agentId)).toBe("below_idle_threshold");

    // 2. Live sweep archives ONLY eligibleChild and preserves audit trail
    const liveRes = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.sweep_idle_subagents.response" }>
    >({
      type: "main_chat.sweep_idle_subagents.request",
      requestId: "req_idle_live",
      dryRun: false,
    });
    expect(liveRes.payload.error).toBeNull();
    expect(liveRes.payload.result!.archivedCount).toBe(1);
    expect(liveRes.payload.result!.archived[0]!.agentId).toBe(eligibleChild.agentId);
    expect(harness.archivedAgentIds).toEqual([eligibleChild.agentId]);
    expect(harness.service.getMetrics().idleSubagentsArchived).toBe(1);
    expect(liveRes.payload.result!.auditLog.length).toBeGreaterThanOrEqual(1);

    // Direct unit check on awaits_reply refusal
    const awaitsDecision = evaluateIdleSubagentArchiveEligibility(
      {
        id: "agent_attn",
        serverId: "srv_local",
        title: "待回复子会话",
        lifecycle: "idle",
        archivedAt: null,
        requiresAttention: true,
        hasBackgroundWork: false,
        pendingPermissionCount: 0,
        updatedAtMs: fakeNow - 200 * 60_000,
        labels: { [MAIN_CHAT_CONVERSATION_KIND_LABEL]: "" },
      },
      {
        nowMs: fakeNow,
        idleThresholdMinutes: 60,
        mainAgentId: main.agentId,
        conversationAgentIds: new Set(),
        tasksByAgentId: new Map([
          [
            "agent_attn",
            {
              id: "t_attn",
              status: "completed",
              title: "已结项",
              completedAt: new Date(fakeNow - 200 * 60_000).toISOString(),
              updatedAt: new Date(fakeNow - 200 * 60_000).toISOString(),
              deliveryGate: null,
            } as unknown as Parameters<
              typeof evaluateIdleSubagentArchiveEligibility
            >[1]["tasksByAgentId"] extends ReadonlyMap<string, infer T>
              ? T
              : never,
          ],
        ]),
        openPlans: [],
        openDecisions: [],
        queuedTaskIds: new Set(),
      },
    );
    expect(awaitsDecision.eligible).toBe(false);
    expect(awaitsDecision.refusalCode).toBe("awaits_reply");

    void MAIN_CHAT_CONVERSATION_ID_LABEL;
    harness.service.stop();
  });

  // ==========================================================================
  // P2-4B: Prompt Library CRUD RPCs, Placeholder Expansion & Settings Proposal
  // ==========================================================================

  it("P2-4B: supports / prompt library CRUD RPCs, validation guards, {{arg}} expansion, and Wave 5 settings_propose_patch allowlist", async () => {
    const harness = makeWave5Harness(paseoHome, repoDir);
    await harness.service.start();

    // 1. List returns built-in templates out of the box
    const list1 = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.list_prompt_library.response" }>
    >({
      type: "main_chat.list_prompt_library.request",
      requestId: "req_pl_list_1",
    });
    expect(list1.payload.error).toBeNull();
    expect(list1.payload.builtinCount).toBe(BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES.length);
    expect(list1.payload.customCount).toBe(0);

    // 2. Save custom template
    const save1 = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.save_prompt_template.response" }>
    >({
      type: "main_chat.save_prompt_template.request",
      requestId: "req_pl_save_1",
      template: {
        slug: "release-check",
        title: "发版前回归检查",
        description: "检查变更范围、回滚预案与灰度指标",
        argumentHint: "<版本号>",
        content: "请为 {{arg}} 生成上线前核查表，包含变更风险、回滚步骤与监控指标。",
      },
    });
    expect(save1.payload.error).toBeNull();
    expect(save1.payload.template?.slug).toBe("release-check");
    expect(save1.payload.template?.builtin).toBe(false);
    expect(save1.payload.templates.some((t) => t.slug === "release-check")).toBe(true);

    // 3. Placeholder expansion & slash invocation
    const invoked = resolvePromptTemplateSlashInvocation({
      text: "/release-check v0.17.529",
      templates: save1.payload.templates,
    });
    expect(invoked?.template.slug).toBe("release-check");
    expect(invoked?.expandedText).toBe(
      "请为 v0.17.529 生成上线前核查表，包含变更风险、回滚步骤与监控指标。",
    );
    expect(expandMainChatPromptTemplate(save1.payload.template!.content, "Wave 5")).toContain(
      "Wave 5",
    );

    // 4. Rejects reserved client command slug (/exit) and built-in slug (/review)
    const badReserved = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.save_prompt_template.response" }>
    >({
      type: "main_chat.save_prompt_template.request",
      requestId: "req_pl_bad_1",
      template: { slug: "exit", title: "冲突", content: "test" },
    });
    expect(badReserved.payload.error).toContain("内置客户端命令");

    const badBuiltin = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.save_prompt_template.response" }>
    >({
      type: "main_chat.save_prompt_template.request",
      requestId: "req_pl_bad_2",
      template: { slug: "review", title: "覆盖内置", content: "test" },
    });
    expect(badBuiltin.payload.error).toContain("内置提示词模板冲突");

    // 5. Rejects deleting built-in template, succeeds deleting custom template
    const badDelete = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.delete_prompt_template.response" }>
    >({
      type: "main_chat.delete_prompt_template.request",
      requestId: "req_pl_del_bad",
      slug: "review",
    });
    expect(badDelete.payload.deleted).toBe(false);
    expect(badDelete.payload.error).toContain("不可删除");

    const okDelete = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.delete_prompt_template.response" }>
    >({
      type: "main_chat.delete_prompt_template.request",
      requestId: "req_pl_del_ok",
      id: save1.payload.template!.id,
    });
    expect(okDelete.payload.error).toBeNull();
    expect(okDelete.payload.deleted).toBe(true);
    expect(okDelete.payload.templates.some((t) => t.slug === "release-check")).toBe(false);

    // 5b. Persistence across reload: save a template and reload via a new service instance
    const savePersist = await harness.callRpc<
      Extract<SessionOutboundMessage, { type: "main_chat.save_prompt_template.response" }>
    >({
      type: "main_chat.save_prompt_template.request",
      requestId: "req_pl_save_persist",
      template: {
        slug: "audit-sql",
        title: "SQL 变更审阅",
        description: "检查索引、锁表和回滚脚本",
        argumentHint: "<迁移文件>",
        content: "请核查 {{arg}} 是否存在锁表风险并给出回滚 SQL。",
      },
    });
    expect(savePersist.payload.error).toBeNull();
    harness.service.stop();

    const reloadedHarness = makeWave5Harness(paseoHome, repoDir);
    await reloadedHarness.service.start();
    const reloadedList = await reloadedHarness.service.listPromptLibrary();
    expect(reloadedList.customCount).toBe(1);
    expect(reloadedList.templates.find((t) => t.slug === "audit-sql")?.title).toBe("SQL 变更审阅");

    // 6. settings_propose_patch supports all Wave 5 allowlisted keys cleanly
    const current = await reloadedHarness.service.getSettings();
    const built = buildSettingsProposal(
      {
        mainAgentId: "agent_main_1",
        reason: "开启 Wave 5 资源准入、无状态督办、按需工具加载与闲置归档",
        changes: {
          "resourceAdmission.enabled": true,
          "resourceAdmission.maxConcurrentPerHost": 4,
          "resourceAdmission.maxCpuPercent": 80,
          "resourceAdmission.minFreeMemoryMb": 1536,
          "resourceAdmission.queueWhenPressured": true,
          statelessBackgroundSupervision: true,
          onDemandToolLoading: true,
          "idleArchivePolicy.enabled": true,
          "idleArchivePolicy.idleThresholdMinutes": 90,
        },
      },
      current,
      "2026-11-25T07:00:00.000Z",
    );
    expect(built.proposal).toBeTruthy();
    expect(built.proposal!.changes.length).toBe(8); // queueWhenPressured was already true (no-op)
    expect(built.proposal!.patch.resourceAdmission).toEqual({
      enabled: true,
      maxConcurrentPerHost: 4,
      maxCpuPercent: 80,
      minFreeMemoryMb: 1536,
    });
    expect(built.proposal!.patch.statelessBackgroundSupervision).toBe(true);
    expect(built.proposal!.patch.onDemandToolLoading).toBe(true);
    expect(built.proposal!.patch.idleArchivePolicy).toEqual({
      enabled: true,
      idleThresholdMinutes: 90,
    });

    reloadedHarness.service.stop();
  });
});
