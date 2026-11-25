import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS,
  MAIN_CHAT_REPLACED_BY_LABEL,
  MAIN_CHAT_TASK_RECORD_ID_LABEL,
  resolveMainChatModelConfig,
  resolveMainChatModelSlot,
  type MainChatNotificationReceipt,
} from "@getpaseo/protocol/main-chat";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, PersistedAgentRecord } from "../agent/agent-storage.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { SessionOutboundMessage } from "../messages.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import { ModelProfileValidationError, computeAtomicModelProfileSwitch } from "./model-profiles.js";
import { evaluateNotificationDispatch } from "./notification-policy.js";
import { createMainChatService } from "./service.js";
import { handleMainChatSessionMessage } from "./session.js";
import { createMainChatStore } from "./store.js";
import {
  createZeroTokenRuleWindowManager,
  detectMissingWrapUp,
  detectReadWithoutReply,
  detectToolLoopFromCalls,
} from "./zero-token-rules.js";

const logger = pino({ level: "silent" });

interface Wave4HarnessOptions {
  nowMs?: () => number;
  providers?: Array<{ provider: string; enabled: boolean }>;
  triageSettleMs?: number;
  superviseGatherMs?: number;
  semanticTriageCalls?: Array<{ agentTitle: string }>;
}

function makeWave4Harness(paseoHome: string, repoDir: string, options: Wave4HarnessOptions = {}) {
  let agentSeq = 0;
  const agents = new Map<string, ManagedAgent>();
  const storedRecords = new Map<string, PersistedAgentRecord>();
  const timelines = new Map<string, AgentTimelineItem[]>();
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  const sentPrompts: Array<{ agentId: string; prompt: unknown }> = [];
  const createdAgentConfigs: Array<{
    id: string;
    provider: string;
    model?: string;
    thinkingOptionId?: string;
    title?: string;
    labels?: Record<string, string>;
  }> = [];
  const modelSwitches: Array<{ agentId: string; modelId: string | null }> = [];
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
    thinkingOptionId?: string;
  }): ManagedAgent {
    const nowDate = new Date(nowMs());
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
        thinkingOptionId: params.thinkingOptionId,
        labels: params.labels ?? {},
      },
      runtimeInfo: {
        provider: (params.provider ?? "claude") as ManagedAgent["provider"],
        sessionId: `sess_${params.id}`,
        model: params.model ?? "claude-opus-4-6",
      },
      labels: { ...params.labels },
      pendingPermissions: new Map(),
      background: false,
      internal: false,
      createdAt: nowDate,
      updatedAt: nowDate,
      lastError: params.lifecycle === "error" ? "quota reached (429)" : null,
      lastUsage: null,
    } as unknown as ManagedAgent;
    agents.set(live.id, live);
    storedRecords.set(live.id, {
      id: live.id,
      provider: live.provider,
      cwd: live.cwd,
      workspaceId: live.workspaceId,
      createdAt: nowDate.toISOString(),
      updatedAt: nowDate.toISOString(),
      title: params.title ?? params.id,
      labels: { ...live.labels },
      metadata: {},
      lastStatus: params.lifecycle === "error" ? "error" : "idle",
      config: {
        model: params.model ?? "claude-opus-4-6",
        thinkingOptionId: params.thinkingOptionId ?? null,
      },
      runtimeInfo: {
        provider: live.provider,
        sessionId: `sess_${live.id}`,
        model: params.model ?? "claude-opus-4-6",
      },
      lastError: live.lastError ?? null,
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
        thinkingOptionId?: string;
        cwd: string;
        workspaceId?: string;
        title?: string;
        labels?: Record<string, string>;
        initialPrompt?: unknown;
      },
      agentId?: string,
      createOptions?: {
        workspaceId?: string;
        labels?: Record<string, string>;
      },
    ) => {
      agentSeq += 1;
      const id = agentId ?? `agent_w4_${agentSeq}`;
      const mergedLabels = { ...config.labels, ...createOptions?.labels };
      const resolvedWorkspaceId = createOptions?.workspaceId ?? config.workspaceId ?? "ws_repo";
      const live = makeLiveAgent({
        id,
        provider: config.provider ?? "claude",
        model: config.model,
        thinkingOptionId: config.thinkingOptionId,
        cwd: config.cwd,
        workspaceId: resolvedWorkspaceId,
        title: config.title ?? id,
        labels: mergedLabels,
        lifecycle: "idle",
      });
      createdAgentConfigs.push({
        id,
        provider: config.provider ?? "claude",
        model: config.model,
        thinkingOptionId: config.thinkingOptionId,
        title: config.title,
        labels: mergedLabels,
      });
      if (config.initialPrompt !== undefined) {
        sentPrompts.push({ agentId: id, prompt: config.initialPrompt });
      }
      return live;
    },
    getRegisteredProviderIds: () =>
      configuredProviders.filter((p) => p.enabled).map((p) => p.provider),
    getLastAssistantMessage: async (agentId: string) => {
      const items = timelines.get(agentId) ?? [];
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i] as { type?: string; text?: string };
        if (item.type === "assistant_message" && item.text) return item.text;
      }
      return null;
    },
    sendPrompt: async (agentId: string, prompt: unknown) => {
      sentPrompts.push({ agentId, prompt });
      const live = agents.get(agentId);
      if (live) {
        live.lifecycle = "idle";
      }
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
    setAgentModel: async (agentId: string, modelId: string | null) => {
      modelSwitches.push({ agentId, modelId });
      const live = agents.get(agentId);
      if (live) {
        live.config.model = modelId ?? undefined;
        if (live.runtimeInfo) {
          live.runtimeInfo.model = modelId ?? undefined;
        }
      }
    },
    cancelAgent: async (agentId: string) => {
      const live = agents.get(agentId);
      if (live) {
        live.lifecycle = "idle";
      }
    },
    closeAgent: async (agentId: string) => {
      const live = agents.get(agentId);
      if (live) {
        live.lifecycle = "closed";
      }
    },
    archiveAgent: async (agentId: string) => {
      agents.delete(agentId);
      const rec = storedRecords.get(agentId);
      if (rec) rec.archivedAt = new Date(nowMs()).toISOString();
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
    createAgentFromRecord: async (record: PersistedAgentRecord) => {
      const existing = agents.get(record.id);
      if (existing) return existing;
      return makeLiveAgent({
        id: record.id,
        provider: record.provider,
        model: record.config?.model ?? undefined,
        cwd: record.cwd,
        workspaceId: record.workspaceId ?? undefined,
        title: record.title ?? undefined,
        labels: record.labels,
      });
    },
    hydrateTimelineFromProvider: async () => undefined,
    resumeAgentFromPersistence: async () => undefined,
    waitForAgentClose: async () => undefined,
    setDaemonBackgroundWork: () => undefined,
    removeDaemonBackgroundWork: () => undefined,
    reloadAgentSession: async () => undefined,
    reloadStalePluginSession: async () => undefined,
    tryRunOutOfBand: async () => false,
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
    setArchived: async () => undefined,
  } as unknown as AgentStorage;

  const workspaceRegistry = {
    get: async (id: string) => workspaces.get(id) ?? null,
    list: async () => Array.from(workspaces.values()),
    listActive: async () => Array.from(workspaces.values()),
    upsert: async (record: PersistedWorkspaceRecord) => {
      workspaces.set(record.id, record);
      return record;
    },
    update: async (
      id: string,
      updater: (r: PersistedWorkspaceRecord) => PersistedWorkspaceRecord,
    ) => {
      const existing = workspaces.get(id);
      if (!existing) return null;
      const next = updater(existing);
      workspaces.set(id, next);
      return next;
    },
  } as unknown as WorkspaceRegistry;

  const createDirectoryWorkspace = async (cwd: string, title?: string | null) => {
    const existing = Array.from(workspaces.values()).find((ws) => ws.cwd === cwd);
    if (existing) return existing;
    const record: PersistedWorkspaceRecord = {
      workspaceId: `ws_${workspaces.size + 1}`,
      id: `ws_${workspaces.size + 1}`,
      cwd,
      title: title ?? path.basename(cwd),
      createdAt: new Date(nowMs()).toISOString(),
      updatedAt: new Date(nowMs()).toISOString(),
    } as unknown as PersistedWorkspaceRecord;
    workspaces.set(record.workspaceId, record);
    return record;
  };

  const configuredProviders = options.providers ?? [
    { provider: "claude", enabled: true },
    { provider: "codex", enabled: true },
  ];

  const providerSnapshotManager = {
    getSnapshot: () => ({
      records: configuredProviders.map((entry) => ({
        entry: {
          provider: entry.provider,
          enabled: entry.enabled,
          status: "ready",
          models: [],
        },
      })),
    }),
    listProviders: async () =>
      configuredProviders.map((entry) => ({
        provider: entry.provider,
        enabled: entry.enabled,
        status: "ready",
        models: [],
        modes: [{ id: "default", label: "Default" }],
        defaultModeId: "default",
      })),
    resolveCreateConfig: async (input: { provider: string; requestedMode?: string }) => ({
      provider: input.provider,
      modeId: input.requestedMode ?? "default",
    }),
  } as unknown as ProviderSnapshotManager;

  const service = createMainChatService({
    paseoHome,
    worktreesRoot: path.join(paseoHome, "worktrees"),
    serverId: "srv_local",
    agentManager,
    agentStorage,
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
    providerSnapshotManager,
    logger,
    now: nowMs,
    triageSettleMs: options.triageSettleMs ?? 15,
    superviseGatherMs: options.superviseGatherMs ?? 15,
    semanticTriageRunner: options.semanticTriageCalls
      ? async (input) => {
          options.semanticTriageCalls!.push({ agentTitle: input.sessionTitle });
          return {
            phase: "done",
            summary: input.lastAssistantReply.slice(0, 60),
            waitReason: null,
            needsUserDecision: false,
            isLowRiskTechnicalQuestion: false,
            riskyAction: false,
            suggestedReply: null,
          };
        }
      : undefined,
  });

  return {
    service,
    agents,
    storedRecords,
    timelines,
    sentPrompts,
    createdAgentConfigs,
    modelSwitches,
    makeLiveAgent,
    emitAgentEvent,
  };
}

describe("Wave 4 P1-4: multi-purpose model slots, atomic profile switching & failed task retry with fallback", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "paseo-w4-models-"));
    repoDir = path.join(tmpDir, "repo");
    await mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("resolves slot inheritance chains, switches & rolls back profiles atomically, and rejects partial invalid writes", async () => {
    const harness = makeWave4Harness(tmpDir, repoDir, {
      providers: [
        { provider: "claude", enabled: true },
        { provider: "codex", enabled: true },
        { provider: "disabled_vendor", enabled: false },
      ],
    });
    await harness.service.start();
    await harness.service.updateSettings({ enabled: true });
    await harness.service.ensureMainChat({ provider: "claude", model: "claude-opus-4-6" });

    // Custom profile with an invalid disabled provider must fail atomically without modifying active settings.
    const currentBefore = await harness.service.getSettings();
    const withBrokenCustom = {
      ...currentBefore,
      modelConfig: {
        ...resolveMainChatModelConfig(currentBefore),
        customProfiles: [
          {
            id: "broken_custom",
            name: "失效配置组",
            slots: {
              main: { provider: "claude", model: "claude-opus-4-6" },
              subagentDefault: { provider: "disabled_vendor", model: "x-1" },
            },
          },
        ],
      },
    };
    expect(() =>
      computeAtomicModelProfileSwitch({
        currentSettings: withBrokenCustom,
        profileId: "broken_custom",
        actor: "user",
        availableProviders: [
          { provider: "claude", enabled: true },
          { provider: "disabled_vendor", enabled: false },
        ],
        nowIso: "2026-11-25T05:00:00.000Z",
      }),
    ).toThrow(ModelProfileValidationError);

    // Valid atomic switch to economy profile via session RPC + persistence + rollback
    const outbound: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.switch_model_profile.request",
        requestId: "req_sw_1",
        profileId: "economy",
      },
      (msg) => outbound.push(msg),
    );
    const swResp = outbound[0] as Extract<
      SessionOutboundMessage,
      { type: "main_chat.switch_model_profile.response" }
    >;
    expect(swResp.payload.error).toBeNull();
    expect(swResp.payload.activeProfileId).toBe("economy");
    expect(swResp.payload.changedSlots.length).toBeGreaterThan(0);
    expect(
      resolveMainChatModelConfig(swResp.payload.settings!).slots?.subagentReadonly?.model,
    ).toBe("claude-haiku-4-5");

    // Subagent spawn picks subagentReadonly / subagentDefault slots automatically
    const plan = await harness.service.createPlan(harness.createdAgentConfigs[0]!.id, {
      summary: "验证槽位派发",
      tasks: [
        {
          title: "只读排查",
          goal: "检查槽位继承",
          mode: "readonly",
          cwd: repoDir,
          isolation: "local",
        },
      ],
    });
    expect(plan.autoStarted).toBe(true);
    const spawnedReadonly = harness.createdAgentConfigs.at(-1)!;
    expect(spawnedReadonly.provider).toBe("claude");
    expect(spawnedReadonly.model).toBe("claude-haiku-4-5");

    // Atomic rollback restores previous profile & slots
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.switch_model_profile.request",
        requestId: "req_rb_1",
        rollback: true,
      },
      (msg) => outbound.push(msg),
    );
    const rbResp = outbound[1] as Extract<
      SessionOutboundMessage,
      { type: "main_chat.switch_model_profile.response" }
    >;
    expect(rbResp.payload.error).toBeNull();
    expect(rbResp.payload.event?.action).toBe("rollback");

    // settings_propose_patch allowlist supports modelConfig.activeProfileId & notificationPolicy.lowDistractionEnabled
    const proposalRes = await harness.service.proposeSettingsPatch({
      title: "切换经济档并开启低打扰",
      reason: "夜间省额",
      changes: {
        "modelConfig.activeProfileId": "economy",
        "notificationPolicy.lowDistractionEnabled": true,
      },
    });
    expect(proposalRes.proposal).not.toBeNull();
    expect(proposalRes.proposal!.changes).toHaveLength(2);
    const approved = await harness.service.resolveSettingsProposal({
      proposalId: proposalRes.proposal!.id,
      decision: "approve",
    });
    expect(resolveMainChatModelConfig(approved.settings).activeProfileId).toBe("economy");
    expect(approved.settings.notificationPolicy?.lowDistractionEnabled).toBe(true);

    // Explicit slot clearing inherits along chain: subagentReadonly -> subagentDefault -> main
    const cleared = await harness.service.updateSettings({
      modelConfig: {
        slots: {
          main: { provider: "codex", model: "gpt-5.3-codex", thinkingOptionId: "high" },
          subagentDefault: null,
          subagentReadonly: null,
        },
      },
    });
    const resolvedReadonly = resolveMainChatModelSlot({
      purpose: "subagentReadonly",
      settings: cleared,
    });
    expect(resolvedReadonly.source).toBe("inherited");
    expect(resolvedReadonly.inheritedFrom).toBe("main");
    expect(resolvedReadonly.binding?.provider).toBe("codex");
  });

  it("retries ONLY managed failed tasks on the same task card and strictly rejects manual or handoff sessions", async () => {
    const harness = makeWave4Harness(tmpDir, repoDir);
    await harness.service.start();
    await harness.service.updateSettings({
      enabled: true,
      limitFallbacks: [
        { provider: "claude", model: "claude-sonnet-4-6" },
        { provider: "codex", model: "gpt-5.3-codex" },
      ],
    });
    const { agentId: mainId } = await harness.service.ensureMainChat({
      provider: "claude",
      model: "claude-opus-4-6",
    });

    // 1. Create a user manual session (not in managed task ledger) -> must be REJECTED
    harness.makeLiveAgent({
      id: "manual_failed_1",
      title: "用户手动会话",
      lifecycle: "error",
      labels: {},
    });
    await expect(
      harness.service.retryTaskWithFallback({ taskId: "manual_failed_1" }),
    ).rejects.toThrow(/找不到受管任务|严禁操作用户手动会话/);

    // 2. Create a managed task and simulate failure
    const plan = await harness.service.createPlan(mainId, {
      summary: "测试失败重试",
      tasks: [
        {
          title: "受管写入任务",
          goal: "完成单测修复",
          mode: "write",
          doneWhen: ["单测通过"],
          cwd: repoDir,
          isolation: "local",
          provider: "claude/claude-opus-4-6",
        },
      ],
    });
    const startedPlan = await harness.service.startPlan(plan.id);
    expect(startedPlan.tasks[0]?.startError).toBeNull();
    const tasksBefore = await harness.service.listTaskRecords({ includeCompleted: true });
    expect(tasksBefore).toHaveLength(1);
    const managedTask = tasksBefore[0]!;
    const firstAgentId = managedTask.activeAgentId!;

    // Healthy running task must be rejected
    await expect(harness.service.retryTaskWithFallback({ taskId: managedTask.id })).rejects.toThrow(
      /仅支持对失败\/错误状态的主对话受管任务/,
    );

    // Simulate handoff-interrupted label on the agent -> MUST be strictly rejected even if errored
    const firstAgent = harness.agents.get(firstAgentId)!;
    firstAgent.lifecycle = "error";
    firstAgent.labels["paseo.handoff.interrupted"] = "true";
    await expect(harness.service.retryTaskWithFallback({ taskId: managedTask.id })).rejects.toThrow(
      /handoff/,
    );

    // Also verify replaced-by label is rejected
    delete firstAgent.labels["paseo.handoff.interrupted"];
    firstAgent.labels[MAIN_CHAT_REPLACED_BY_LABEL] = "agent_replacement";
    await expect(harness.service.retryTaskWithFallback({ taskId: managedTask.id })).rejects.toThrow(
      /handoff/,
    );

    // Remove handoff labels -> legitimate managed failed task retries with next limitFallback on SAME card!
    delete firstAgent.labels[MAIN_CHAT_REPLACED_BY_LABEL];
    const outbound: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.retry_task_with_fallback.request",
        requestId: "req_retry_ok",
        taskId: managedTask.id,
      },
      (msg) => outbound.push(msg),
    );
    const retryResp = outbound[0] as Extract<
      SessionOutboundMessage,
      { type: "main_chat.retry_task_with_fallback.response" }
    >;
    expect(retryResp.payload.error).toBeNull();
    expect(retryResp.payload.previousAgentId).toBe(firstAgentId);
    expect(retryResp.payload.newAgentId).toBeTruthy();
    expect(retryResp.payload.newAgentId).not.toBe(firstAgentId);
    expect(retryResp.payload.toModelSpec).toBe("claude/claude-sonnet-4-6");
    // Same task card — still only 1 task record, containing both agents in lineage!
    const tasksAfter = await harness.service.listTaskRecords({ includeCompleted: true });
    expect(tasksAfter).toHaveLength(1);
    expect(tasksAfter[0]!.id).toBe(managedTask.id);
    expect(tasksAfter[0]!.activeAgentId).toBe(retryResp.payload.newAgentId);
    expect(tasksAfter[0]!.agentIds).toContain(firstAgentId);
    expect(tasksAfter[0]!.agentIds).toContain(retryResp.payload.newAgentId);
    expect(tasksAfter[0]!.lastModel).toBe("claude-sonnet-4-6");

    // Second failure walks forward to codex/gpt-5.3-codex without looping back to claude-sonnet-4-6
    const secondAgent = harness.agents.get(retryResp.payload.newAgentId!)!;
    secondAgent.lifecycle = "error";
    const secondRetry = await harness.service.retryTaskWithFallback({ taskId: managedTask.id });
    expect(secondRetry.toModelSpec).toBe("codex/gpt-5.3-codex");
    expect(secondRetry.task.id).toBe(managedTask.id);
    expect(secondRetry.task.agentIds).toHaveLength(3);
  });
});

describe("Wave 4 P1-5: notification tiering, low-distraction passthrough & receipt ring-buffer ledger", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "paseo-w4-notify-"));
    repoDir = path.join(tmpDir, "repo");
    await mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("enforces low-distraction folding while guaranteeing critical passthrough for approval, decision, failure, and PR gate blocks", async () => {
    const harness = makeWave4Harness(tmpDir, repoDir);
    await harness.service.start();
    const settings = await harness.service.updateSettings({
      enabled: true,
      notificationPolicy: {
        mode: "low_distraction",
        lowDistractionEnabled: true,
        foldLowPriorityToDigest: true,
      },
    });

    // Low-priority progress & review signals fold to suppressed_quiet under low-distraction
    const progressDecision = evaluateNotificationDispatch({
      signalKind: "report",
      settings,
    });
    expect(progressDecision.deliverNow).toBe(false);
    expect(progressDecision.status).toBe("suppressed_quiet");
    expect(progressDecision.channel).toBe("digest");

    // All 4 critical categories MUST ALWAYS penetrate low-distraction mode!
    for (const signalKind of ["ask", "decide", "failed", "pr_conflict"] as const) {
      const decision = evaluateNotificationDispatch({
        signalKind,
        settings,
      });
      expect(decision.deliverNow).toBe(true);
      expect(decision.tier).toBe("critical");
      expect(decision.passthrough).toBe(true);
      expect(decision.status).toBe("queued");
    }

    // Night-mode suppression produces suppressed_night for non-critical signals
    const nightDecision = evaluateNotificationDispatch({
      signalKind: "report",
      settings,
      nightModeEval: {
        status: {
          state: "hibernating",
          inNightWindow: true,
          effectivePatrolIntervalSec: 0,
          nextTransitionAt: null,
          reason: "夜间休眠中",
        },
        allowPatrol: false,
        allowSemanticTriage: false,
        allowProactiveWakeup: false,
        allowUrgentWakeup: false,
        allowIdlePrecompaction: false,
        nextTimerDelayMs: 60_000,
      },
    });
    expect(nightDecision.deliverNow).toBe(false);
    expect(nightDecision.status).toBe("suppressed_night");
  });

  it("persists notification receipts with ring-buffer cap and supports list & ack RPCs across reloads", async () => {
    const store = createMainChatStore(tmpDir);
    await store.load();
    await store.updateSettings({
      enabled: true,
      notificationPolicy: {
        mode: "low_distraction",
        lowDistractionEnabled: true,
        foldLowPriorityToDigest: true,
      },
    });

    // Write > cap entries to verify FIFO ring-buffer eviction
    const totalToWrite = MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS + 15;
    for (let i = 0; i < totalToWrite; i += 1) {
      const ts = new Date(Date.UTC(2026, 10, 25, 0, 0, i)).toISOString();
      const rec: MainChatNotificationReceipt = {
        id: `nrec_${String(i).padStart(3, "0")}`,
        category: i % 3 === 0 ? "permission_approval" : "task_progress",
        signalKind: i % 3 === 0 ? "ask" : "report",
        tier: i % 3 === 0 ? "critical" : "digest",
        status: i % 3 === 0 ? "delivered" : "suppressed_quiet",
        channel: i % 3 === 0 ? "push" : "digest",
        title: `通知 #${i}`,
        summary: `内容 ${i}`,
        reason: i % 3 === 0 ? "关键穿透" : "低打扰折叠",
        passthrough: i % 3 === 0,
        createdAt: ts,
        updatedAt: ts,
        deliveredAt: i % 3 === 0 ? ts : null,
        acknowledgedAt: null,
        readAt: null,
      };
      await store.recordNotificationReceipt(rec);
    }

    // Reload fresh store from disk to verify durable persistence & exact ring cap
    const reloaded = createMainChatStore(tmpDir);
    await reloaded.load();
    const allPersisted = reloaded.listNotificationReceipts();
    expect(allPersisted).toHaveLength(MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS);
    // Oldest 15 evicted; newest entry is first
    expect(allPersisted[0]!.id).toBe(`nrec_${String(totalToWrite - 1).padStart(3, "0")}`);
    expect(allPersisted.some((item) => item.id === "nrec_000")).toBe(false);

    // Exercise list & ack RPCs via MainChatService + session handler
    const harness = makeWave4Harness(tmpDir, repoDir);
    await harness.service.start();
    const outbound: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.list_notification_receipts.request",
        requestId: "req_list_rec",
        unreadOnly: true,
        limit: 10,
      },
      (msg) => outbound.push(msg),
    );
    const listResp = outbound[0] as Extract<
      SessionOutboundMessage,
      { type: "main_chat.list_notification_receipts.response" }
    >;
    expect(listResp.payload.error).toBeNull();
    expect(listResp.payload.receipts).toHaveLength(10);
    expect(listResp.payload.summary.unreadCount).toBe(MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS);

    const firstId = listResp.payload.receipts[0]!.id;
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.ack_notification_receipt.request",
        requestId: "req_ack_one",
        receiptId: firstId,
        status: "read",
      },
      (msg) => outbound.push(msg),
    );
    const ackOneResp = outbound[1] as Extract<
      SessionOutboundMessage,
      { type: "main_chat.ack_notification_receipt.response" }
    >;
    expect(ackOneResp.payload.updatedCount).toBe(1);
    expect(ackOneResp.payload.receipts[0]!.status).toBe("read");
    expect(ackOneResp.payload.summary.unreadCount).toBe(MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS - 1);

    // Mark all read
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.ack_notification_receipt.request",
        requestId: "req_ack_all",
        markAll: true,
        status: "read",
      },
      (msg) => outbound.push(msg),
    );
    const ackAllResp = outbound[2] as Extract<
      SessionOutboundMessage,
      { type: "main_chat.ack_notification_receipt.response" }
    >;
    expect(ackAllResp.payload.summary.unreadCount).toBe(0);
  });
});

describe("Wave 4 P1-6: zero-token deterministic detectors (read_without_reply, missing_wrap_up, tool_loop) & persistence", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "paseo-w4-rules-"));
    repoDir = path.join(tmpDir, "repo");
    await mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("detects read_without_reply and missing_wrap_up accurately with positive and negative cases", () => {
    const nowIso = "2026-11-25T05:10:00.000Z";

    // Positive read_without_reply: empty reply & pleasantry-only reply
    expect(
      detectReadWithoutReply({ replyText: "", hadReadOrInspectTool: true, nowIso })?.kind,
    ).toBe("read_without_reply");
    expect(
      detectReadWithoutReply({
        replyText: "好的，我先看一下。",
        hadReadOrInspectTool: true,
        nowIso,
      })?.kind,
    ).toBe("read_without_reply");
    expect(detectReadWithoutReply({ replyText: "Got it, checking now.", nowIso })?.kind).toBe(
      "read_without_reply",
    );

    // Negative read_without_reply: substantive reply or explicit question
    expect(
      detectReadWithoutReply({
        replyText: "已完成排查：问题在 packages/server/src/server/main-chat/store.ts，单测已通过。",
        nowIso,
      }),
    ).toBeNull();
    expect(
      detectReadWithoutReply({
        replyText: "请问你要保留默认端口还是改成 6768？",
        nowIso,
      }),
    ).toBeNull();

    // Positive missing_wrap_up: write happened, no verification evidence, stub summary
    const missingWrap = detectMissingWrapUp({
      replyText: "改好了。",
      hadWriteInTurn: true,
      hadVerifyAfterWrite: false,
      phase: "done",
      task: {
        mode: "write",
        brief: {
          goal: "修复模型槽位继承",
          doneWhen: ["protocol 与 server typecheck 通过", "新增单测全绿"],
          outOfBounds: [],
          scopeRevision: 1,
          updatedAt: nowIso,
        },
      },
      nowIso,
    });
    expect(missingWrap?.kind).toBe("missing_wrap_up");
    expect(missingWrap?.missingItems?.length).toBeGreaterThanOrEqual(2);

    // Negative missing_wrap_up: readonly turn (no write) OR write followed by verification & summary
    expect(
      detectMissingWrapUp({
        replyText: "改好了。",
        hadWriteInTurn: false,
        hadVerifyAfterWrite: false,
        phase: "done",
        nowIso,
      }),
    ).toBeNull();
    expect(
      detectMissingWrapUp({
        replyText:
          "已更新 model-profiles.ts 实现槽位继承，运行 vitest 与 typecheck 全部通过（0 errors）。",
        hadWriteInTurn: true,
        hadVerifyAfterWrite: true,
        phase: "done",
        nowIso,
      }),
    ).toBeNull();
  });

  it("distinguishes deep code and long paths with identical prefixes and suffixes", () => {
    const manager = createZeroTokenRuleWindowManager();
    const prefix = "a".repeat(2200);
    const suffix = "b".repeat(900);
    for (const toolName of ["Read", "Edit", "execute"]) {
      for (let i = 0; i < 6; i++) {
        const value = prefix + i + suffix;
        const detail =
          toolName === "execute"
            ? { type: "unknown", input: { call: { code: value } } }
            : { type: toolName.toLowerCase(), filePath: value };
        const result = manager.recordToolEvent(toolName, {
          toolName,
          detail,
          callId: String(i),
          status: "completed",
          nowMs: i * 1000,
        });
        expect(result.diagnostic).toBeNull();
      }
    }
  });

  it("detects exact_repeat, alternating_ab, and repeated_error tool loops while exempting slow polling, and persists window across restarts", () => {
    const nowIso = "2026-11-25T05:15:00.000Z";
    const baseMs = Date.parse(nowIso);

    // 1. Exact repeat (>= 4)
    const mgr = createZeroTokenRuleWindowManager();
    for (let i = 0; i < 4; i += 1) {
      const res = mgr.recordToolEvent("agent_exact", {
        callId: `c_${i}`,
        toolName: "Read",
        detail: { file_path: "/repo/a.ts" },
        status: "completed",
        nowMs: baseMs + i * 2000,
      });
      if (i < 3) expect(res.diagnostic).toBeNull();
      else {
        expect(res.diagnostic?.kind).toBe("tool_loop");
        expect(res.diagnostic?.pattern).toBe("exact_repeat");
        expect(res.diagnostic?.toolName).toBe("Read");
        expect(res.diagnostic?.repeatCount).toBe(4);
        expect(res.isNewTrigger).toBe(true);
      }
    }

    // 2. Alternating A-B-A-B-A-B loop (period 2 x 3 cycles = 6 calls), surviving serialization mid-window!
    const mgrAlt1 = createZeroTokenRuleWindowManager();
    for (let i = 0; i < 4; i += 1) {
      const isA = i % 2 === 0;
      mgrAlt1.recordToolEvent("agent_alt", {
        callId: `alt_${i}`,
        toolName: isA ? "Read" : "Edit",
        detail: { path: isA ? "/repo/x.ts" : "/repo/y.ts" },
        status: "completed",
        nowMs: baseMs + i * 1500,
      });
    }
    // Simulate daemon restart by exporting and re-hydrating window state!
    const persisted = mgrAlt1.exportState();
    const mgrAlt2 = createZeroTokenRuleWindowManager(persisted);
    mgrAlt2.recordToolEvent("agent_alt", {
      callId: "alt_4",
      toolName: "Read",
      detail: { path: "/repo/x.ts" },
      status: "completed",
      nowMs: baseMs + 4 * 1500,
    });
    const finalAlt = mgrAlt2.recordToolEvent("agent_alt", {
      callId: "alt_5",
      toolName: "Edit",
      detail: { path: "/repo/y.ts" },
      status: "completed",
      nowMs: baseMs + 5 * 1500,
    });
    expect(finalAlt.diagnostic?.kind).toBe("tool_loop");
    expect(finalAlt.diagnostic?.pattern).toBe("alternating_ab");
    expect(finalAlt.diagnostic?.toolName).toBe("Read ↔ Edit");
    expect(finalAlt.diagnostic?.repeatCount).toBe(6);
  });

  it("detects repeated_error loops with normalized signatures while exempting slow polling", () => {
    const nowIso = "2026-11-25T05:15:00.000Z";
    const baseMs = Date.parse(nowIso);

    // 3. Consecutive identical error signature (>= 3) with volatile timestamps stripped
    const mgrErr = createZeroTokenRuleWindowManager();
    for (let i = 0; i < 3; i += 1) {
      const res = mgrErr.recordToolEvent("agent_err", {
        callId: `err_${i}`,
        toolName: "Bash",
        detail: { command: `npm test -- --seed=${i}` },
        status: "failed",
        error: `ENOENT: no such file '/repo/dist/index.js' at 2026-11-25T05:15:0${i}Z`,
        nowMs: baseMs + i * 1000,
      });
      if (i < 2) expect(res.diagnostic).toBeNull();
      else {
        expect(res.diagnostic?.kind).toBe("tool_loop");
        expect(res.diagnostic?.pattern).toBe("repeated_error");
        expect(res.diagnostic?.toolName).toBe("Bash");
        expect(res.diagnostic?.repeatCount).toBe(3);
        expect(res.diagnostic?.errorExcerpt).toContain("ENOENT");
      }
    }

    // 4. Slow polling commands (>= 30s gap) must NOT false-trigger tool_loop
    const pollingCalls = Array.from({ length: 5 }, (_, i) => ({
      callId: `poll_${i}`,
      tool: "Bash",
      inputHash: "samehash",
      errorSig: null,
      errorExcerpt: null,
      isError: false,
      isWrite: false,
      isVerify: false,
      isRead: false,
      isPolling: true,
      atMs: baseMs + i * 35_000,
    }));
    expect(detectToolLoopFromCalls(pollingCalls, nowIso)).toBeNull();
  });

  it("never false-triggers tool_loop on Read of different files, Bash with different commands, Grep with different patterns, or running->completed detail hydration", () => {
    const baseMs = Date.parse("2026-11-25T05:20:00.000Z");
    const mgr = createZeroTokenRuleWindowManager();

    // 1. Reading 6 different files with large shared content header (> 800 chars) and running->completed hydration
    const sharedHeader = "// Copyright 2026 Paseo\n".repeat(50); // > 1100 chars before filePath if content weren't stripped
    const files = [
      "/repo/src/a.ts",
      "/repo/src/b.ts",
      "/repo/src/c.ts",
      "/repo/src/d.ts",
      "/repo/src/e.ts",
      "/repo/src/f.ts",
    ];
    for (let i = 0; i < files.length; i += 1) {
      const running = mgr.recordToolEvent("agent_diff_reads", {
        callId: `read_${i}`,
        toolName: "Read",
        detail: { type: "unknown", input: null, output: null },
        status: "running",
        nowMs: baseMs + i * 1000,
      });
      expect(running.diagnostic).toBeNull();

      const completed = mgr.recordToolEvent("agent_diff_reads", {
        callId: `read_${i}`,
        toolName: "Read",
        detail: {
          type: "read",
          filePath: files[i]!,
          offset: 1,
          limit: 120,
          content: `${sharedHeader}export const file${i} = ${i};`,
        },
        status: "completed",
        nowMs: baseMs + i * 1000 + 200,
      });
      expect(completed.diagnostic).toBeNull();
    }

    // 2. Reading different line ranges of the SAME file must NOT trigger tool_loop
    for (let i = 0; i < 5; i += 1) {
      const res = mgr.recordToolEvent("agent_diff_offsets", {
        callId: `slice_${i}`,
        toolName: "Read",
        detail: { type: "read", filePath: "/repo/src/large.ts", offset: i * 100 + 1, limit: 100 },
        status: "completed",
        nowMs: baseMs + i * 1000,
      });
      expect(res.diagnostic).toBeNull();
    }

    // 3. Running 5 different Bash commands (with running->completed lifecycle) must NOT trigger tool_loop
    const commands = [
      "git status",
      "git diff --stat",
      "npm run typecheck",
      "npx vitest run a.test.ts",
      "npx vitest run b.test.ts",
    ];
    for (let i = 0; i < commands.length; i += 1) {
      const running = mgr.recordToolEvent("agent_diff_bash", {
        callId: `bash_${i}`,
        toolName: "Bash",
        detail: { type: "shell", command: "" },
        status: "running",
        nowMs: baseMs + i * 1000,
      });
      expect(running.diagnostic).toBeNull();

      const completed = mgr.recordToolEvent("agent_diff_bash", {
        callId: `bash_${i}`,
        toolName: "Bash",
        detail: { type: "shell", command: commands[i]!, output: "ok", exitCode: 0 },
        status: "completed",
        nowMs: baseMs + i * 1000 + 300,
      });
      expect(completed.diagnostic).toBeNull();
    }

    // 4. Searching 5 different patterns must NOT trigger tool_loop
    for (let i = 0; i < 5; i += 1) {
      const res = mgr.recordToolEvent("agent_diff_grep", {
        callId: `grep_${i}`,
        toolName: "Grep",
        detail: {
          type: "unknown",
          input: { pattern: `symbol_${i}`, path: "packages/app" },
          output: null,
        },
        status: "completed",
        nowMs: baseMs + i * 1000,
      });
      expect(res.diagnostic).toBeNull();
    }

    // 5. Missing/unpopulated detail on consecutive calls must NOT match as identical-arg repeats
    for (let i = 0; i < 5; i += 1) {
      const res = mgr.recordToolEvent("agent_empty_detail", {
        callId: `empty_${i}`,
        toolName: "Read",
        detail: { type: "unknown", input: null, output: null },
        status: "running",
        nowMs: baseMs + i * 500,
      });
      expect(res.diagnostic).toBeNull();
    }

    // 6. Genuine repeated Read of the EXACT same file + offset still triggers exact_repeat after hydration!
    for (let i = 0; i < 4; i += 1) {
      mgr.recordToolEvent("agent_real_repeat", {
        callId: `real_rep_${i}`,
        toolName: "Read",
        detail: { type: "unknown", input: null, output: null },
        status: "running",
        nowMs: baseMs + i * 1000,
      });
      const completed = mgr.recordToolEvent("agent_real_repeat", {
        callId: `real_rep_${i}`,
        toolName: "Read",
        detail: { type: "read", filePath: "/repo/src/stuck.ts", offset: 1, limit: 80 },
        status: "completed",
        nowMs: baseMs + i * 1000 + 200,
      });
      if (i < 3) expect(completed.diagnostic).toBeNull();
      else {
        expect(completed.diagnostic?.kind).toBe("tool_loop");
        expect(completed.diagnostic?.pattern).toBe("exact_repeat");
        expect(completed.diagnostic?.repeatCount).toBe(4);
      }
    }
  });

  it("wires zero-token tool_loop and read_without_reply into supervisor with 0 model calls and strictly obeys Conservative Mode A", async () => {
    const semanticCalls: Array<{ agentTitle: string }> = [];
    const harness = makeWave4Harness(tmpDir, repoDir, {
      triageSettleMs: 10,
      superviseGatherMs: 10,
      semanticTriageCalls: semanticCalls,
    });
    await harness.service.start();
    await harness.service.updateSettings({
      enabled: true,
      style: "conservative",
    });
    const { agentId: mainId } = await harness.service.ensureMainChat();

    // User manual session enters a Bash repeated error loop -> supervisor MUST report diagnostic
    // in triage & overview, and MUST NOT send any prompt to the manual user session!
    const manualAgent = harness.makeLiveAgent({
      id: "manual_loop_1",
      title: "手动调试会话",
      labels: {},
    });
    const now = Date.now();
    harness.emitAgentEvent({
      type: "agent_stream",
      agentId: manualAgent.id,
      event: { type: "turn_started", provider: "claude" },
    });
    for (let i = 0; i < 3; i += 1) {
      harness.emitAgentEvent({
        type: "agent_stream",
        agentId: manualAgent.id,
        event: {
          type: "timeline",
          provider: "claude",
          item: {
            type: "tool_call",
            callId: `loop_call_${i}`,
            name: "Bash",
            detail: { type: "shell", command: "npm run build" },
            status: "failed",
            error: "Cannot find module '@getpaseo/protocol'",
          },
        },
      });
    }

    await new Promise((resolve) => setTimeout(resolve, 40));

    // Zero business prompts sent to manual user session (Conservative Mode A redline!)
    const promptsToManual = harness.sentPrompts.filter((p) => p.agentId === manualAgent.id);
    expect(promptsToManual).toHaveLength(0);

    // Overview triages carries structured tool_loop diagnostic
    const overviewAfterLoop = await harness.service.getOverview(mainId);
    const manualTriage = overviewAfterLoop.triages?.find((t) => t.agentId === manualAgent.id);
    expect(manualTriage?.phase).toBe("no_progress");
    expect(manualTriage?.ruleDiagnostic?.kind).toBe("tool_loop");
    expect(manualTriage?.ruleDiagnostic?.pattern).toBe("repeated_error");
    expect(manualTriage?.ruleDiagnostic?.toolName).toBe("Bash");
    expect(manualTriage?.ruleDiagnostic?.repeatCount).toBe(3);

    // Managed task finishing with pleasantry-only triggers read_without_reply with ZERO model calls!
    const plan = await harness.service.createPlan(mainId, {
      summary: "测试已读未回",
      tasks: [
        {
          title: "调研任务",
          goal: "检查配置文件",
          mode: "readonly",
          cwd: repoDir,
          isolation: "local",
        },
      ],
    });
    const taskAgentId = plan.tasks[0]!.agentId!;
    const taskRecordId = plan.tasks[0]!.taskRecordId!;
    expect(harness.agents.get(taskAgentId)?.labels[MAIN_CHAT_TASK_RECORD_ID_LABEL]).toBe(
      taskRecordId,
    );

    harness.emitAgentEvent({
      type: "agent_stream",
      agentId: taskAgentId,
      event: { type: "turn_started", provider: "claude" },
    });
    harness.emitAgentEvent({
      type: "agent_stream",
      agentId: taskAgentId,
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          callId: "read_1",
          name: "Read",
          detail: { type: "read", path: "/repo/package.json" },
          status: "completed",
          error: null,
        },
      },
    });
    harness.emitAgentEvent({
      type: "agent_stream",
      agentId: taskAgentId,
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "好的，我看一下。", messageId: "m_1" },
      },
    });
    harness.emitAgentEvent({
      type: "agent_stream",
      agentId: taskAgentId,
      event: { type: "turn_completed", provider: "claude" },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    // Strictly zero semantic model calls for read_without_reply!
    expect(semanticCalls).toHaveLength(0);

    const overviewAfterTurn = await harness.service.getOverview(mainId);
    const taskTriage = overviewAfterTurn.triages?.find((t) => t.agentId === taskAgentId);
    expect(taskTriage?.ruleDiagnostic?.kind).toBe("read_without_reply");
    expect(taskTriage?.triageSource).toBe("rule");
    const refreshedTask = overviewAfterTurn.tasks?.find((t) => t.id === taskRecordId);
    expect(refreshedTask?.lastRuleDiagnostic?.kind).toBe("read_without_reply");
    expect(now).toBeGreaterThan(0);
  });

  it("wires zero-token missing_wrap_up into supervisor and overview for managed write tasks", async () => {
    const harness = makeWave4Harness(tmpDir, repoDir, {
      triageSettleMs: 10,
      superviseGatherMs: 10,
    });
    await harness.service.start();
    await harness.service.updateSettings({ enabled: true, style: "conservative" });
    const { agentId: mainId } = await harness.service.ensureMainChat();

    // Managed write task finishing with Edit + stub summary ("改好了。") triggers missing_wrap_up!
    const writePlan = await harness.service.createPlan(mainId, {
      summary: "测试漏收尾",
      tasks: [
        {
          title: "受管改动任务",
          goal: "修复通知回执排序",
          mode: "write",
          doneWhen: ["单测与 typecheck 通过"],
          cwd: repoDir,
          isolation: "local",
        },
      ],
    });
    const startedWritePlan = await harness.service.startPlan(writePlan.id);
    const writeAgentId = startedWritePlan.tasks[0]!.agentId!;
    const writeTaskRecordId = startedWritePlan.tasks[0]!.taskRecordId!;

    harness.emitAgentEvent({
      type: "agent_stream",
      agentId: writeAgentId,
      event: { type: "turn_started", provider: "claude" },
    });
    harness.emitAgentEvent({
      type: "agent_stream",
      agentId: writeAgentId,
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          callId: "edit_1",
          name: "Edit",
          detail: { type: "edit", file_path: "/repo/store.ts" },
          status: "completed",
          error: null,
        },
      },
    });
    harness.emitAgentEvent({
      type: "agent_stream",
      agentId: writeAgentId,
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "改好了。", messageId: "m_2" },
      },
    });
    harness.emitAgentEvent({
      type: "agent_stream",
      agentId: writeAgentId,
      event: { type: "turn_completed", provider: "claude" },
    });

    await new Promise((resolve) => setTimeout(resolve, 60));

    const overviewAfterWrite = await harness.service.getOverview(mainId);
    const writeTriage = overviewAfterWrite.triages?.find((t) => t.agentId === writeAgentId);
    expect(writeTriage?.ruleDiagnostic?.kind).toBe("missing_wrap_up");
    const refreshedWriteTask = overviewAfterWrite.tasks?.find((t) => t.id === writeTaskRecordId);
    expect(refreshedWriteTask?.lastRuleDiagnostic?.kind).toBe("missing_wrap_up");
  });
});
