import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_CHAT_BACKGROUND_COMPACTION_MSG_PREFIX,
  MAIN_CHAT_CONVERSATION_ID_LABEL,
  MAIN_CHAT_CONVERSATION_KIND_LABEL,
  MAIN_CHAT_FORMER_ROLE_VALUE,
  MAIN_CHAT_REPLACED_BY_LABEL,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
  getMainChatBackgroundTurnMetadata,
  parseSettingsProposePatchToolPayload,
} from "@getpaseo/protocol/main-chat";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import { projectAgentMessages } from "../agent/agent-messages/envelope.js";
import type { AgentStorage, PersistedAgentRecord } from "../agent/agent-storage.js";
import type { AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import type { SessionOutboundMessage } from "../messages.js";
import { ScheduleService } from "../schedule/service.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import { evaluateLimitFallbackEligibility } from "./limit-fallback.js";
import { buildMainChatSystemPrompt } from "./prompts.js";
import { createMainChatService } from "./service.js";
import { handleMainChatSessionMessage } from "./session.js";
import { registerMainChatTools } from "./tools.js";
import { isLimitFallbackError } from "./triage.js";

const logger = pino({ level: "silent" });

interface HarnessOptions {
  nowMs?: () => number;
  supportsNativeCompact?: boolean;
  outOfBandCompact?: boolean;
  withScheduleService?: boolean;
  keepalivePings?: Array<{ agentId: string; role: "main" | "leader" }>;
  emitStreamLifecycle?: boolean;
  onStreamStarted?: (agentId: string, release: () => void) => void;
}

function makeWave2Harness(paseoHome: string, repoDir: string, options: HarnessOptions = {}) {
  let agentSeq = 0;
  const agents = new Map<string, ManagedAgent>();
  const storedRecords = new Map<string, PersistedAgentRecord>();
  const timelines = new Map<string, AgentTimelineItem[]>();
  const workspaces = new Map<string, PersistedWorkspaceRecord>();
  const subscribers = new Set<(event: AgentManagerEvent) => void>();
  const inFlightRuns = new Set<string>();
  const eventWaitersByAgent = new Map<string, Array<() => void>>();
  const sentPrompts: Array<{
    agentId: string;
    prompt: unknown;
    clientMessageId?: string;
  }> = [];
  const modelSwitches: Array<{ agentId: string; modelId: string | null }> = [];

  const nowMs = options.nowMs ?? (() => Date.now());
  const emit = (event: AgentManagerEvent) => {
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
      cwd: params.cwd ?? path.join(paseoHome, "main-chat"),
      workspaceId: params.workspaceId ?? "ws_main",
      lifecycle: "idle",
      background: false,
      internal: false,
      labels: { ...params.labels },
      config: {
        provider: (params.provider ?? "claude") as ManagedAgent["provider"],
        cwd: params.cwd ?? path.join(paseoHome, "main-chat"),
        model: params.model ?? "claude-sonnet-4-5",
        title: params.title ?? "对话管理",
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
        listCommands: async () => (options.supportsNativeCompact ? [{ name: "compact" }] : []),
        tryHandleOutOfBand: (prompt: string) =>
          options.outOfBandCompact && prompt.trim().startsWith("/compact")
            ? { run: async () => undefined }
            : null,
      },
    } as unknown as ManagedAgent;
    agents.set(params.id, live);
    timelines.set(params.id, []);
    storedRecords.set(params.id, {
      id: params.id,
      provider: live.provider,
      cwd: live.cwd,
      workspaceId: live.workspaceId,
      title: live.config.title,
      labels: { ...live.labels },
      config: { ...live.config },
      createdAt: nowDate.toISOString(),
      updatedAt: nowDate.toISOString(),
      archivedAt: null,
    } as unknown as PersistedAgentRecord);
    return live;
  }

  const agentManager = {
    listAgents: () => Array.from(agents.values()),
    getAgent: (id: string) => agents.get(id) ?? null,
    getTimeline: (id: string) => timelines.get(id) ?? [],
    hasInFlightRun: (id: string) => inFlightRuns.has(id),
    subscribe: (listener: (event: AgentManagerEvent) => void) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
    createAgent: async (
      config: {
        provider: string;
        cwd: string;
        model?: string;
        title?: string;
      },
      agentId?: string,
      createOptions?: {
        workspaceId?: string;
        labels?: Record<string, string>;
      },
    ) => {
      agentSeq += 1;
      const id = agentId ?? `00000000-0000-4000-8000-${String(agentSeq).padStart(12, "0")}`;
      return makeLiveAgent({
        id,
        provider: config.provider,
        model: config.model,
        cwd: config.cwd,
        workspaceId: createOptions?.workspaceId,
        title: config.title,
        labels: createOptions?.labels,
      });
    },
    getLastAssistantMessage: async () => null,
    updateAgentMetadata: async (
      id: string,
      patch: { labels?: Record<string, string>; title?: string },
    ) => {
      const target = agents.get(id);
      if (!target) return null;
      if (patch.labels) target.labels = { ...target.labels, ...patch.labels };
      if (patch.title) target.config.title = patch.title;
      const rec = storedRecords.get(id);
      if (rec) {
        if (patch.labels) rec.labels = { ...target.labels };
        if (patch.title) rec.title = patch.title;
      }
      return target;
    },
    createAgentFromRecord: async (record: PersistedAgentRecord) => {
      const existing = agents.get(record.id);
      if (existing) return existing;
      return makeLiveAgent({
        id: record.id,
        provider: record.provider,
        model: record.config?.model,
        cwd: record.cwd,
        workspaceId: record.workspaceId ?? undefined,
        title: record.title ?? undefined,
        labels: record.labels,
      });
    },
    getRegisteredProviderIds: () => ["claude", "codex", "opencode"],
    hydrateTimelineFromProvider: async () => undefined,
    resumeAgentFromPersistence: async () => undefined,
    waitForAgentClose: async () => undefined,
    setDaemonBackgroundWork: () => undefined,
    removeDaemonBackgroundWork: () => undefined,
    reloadAgentSession: async () => undefined,
    reloadStalePluginSession: async () => undefined,
    tryRunOutOfBand: async (
      agentId: string,
      prompt: unknown,
      runOptions?: { clientMessageId?: string },
    ) => {
      if (options.outOfBandCompact && typeof prompt === "string" && prompt.startsWith("/compact")) {
        sentPrompts.push({ agentId, prompt, clientMessageId: runOptions?.clientMessageId });
        return true;
      }
      return false;
    },
    streamAgent: (
      agentId: string,
      prompt: unknown,
      runOptions?: { clientMessageId?: string },
      promptStart?: { bind?: (run: unknown) => void },
    ) => {
      sentPrompts.push({ agentId, prompt, clientMessageId: runOptions?.clientMessageId });
      promptStart?.bind?.({
        start: { status: "started" },
        turnStartedPromise: Promise.resolve(),
        settledPromise: new Promise(() => undefined),
      });
      const text = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
      const projected = projectAgentMessages({
        type: "user_message",
        text,
        ...(runOptions?.clientMessageId ? { clientMessageId: runOptions.clientMessageId } : {}),
      });
      const list = timelines.get(agentId) ?? [];
      list.push(...projected);
      timelines.set(agentId, list);
      if (!options.emitStreamLifecycle) {
        return (async function* () {
          yield { type: "turn_started", provider: "claude" } as never;
          yield { type: "turn_completed", provider: "claude" } as never;
        })();
      }
      const live = agents.get(agentId);
      const provider = live?.provider ?? "claude";
      inFlightRuns.add(agentId);
      if (live) live.lifecycle = "running";
      return (async function* () {
        emit({
          type: "agent_stream",
          agentId,
          event: { type: "turn_started", provider },
        } as AgentManagerEvent);
        yield { type: "turn_started", provider } as never;
        await new Promise<void>((resolve) => {
          if (options.onStreamStarted) {
            options.onStreamStarted(agentId, resolve);
          } else {
            setTimeout(resolve, 0);
          }
        });
        if (live) {
          live.lifecycle = "idle";
          live.updatedAt = new Date(nowMs());
        }
        inFlightRuns.delete(agentId);
        emit({
          type: "agent_stream",
          agentId,
          event: {
            type: "turn_completed",
            provider,
            usage: { inputTokens: 1_200, cachedInputTokens: 1_000 },
          },
        } as AgentManagerEvent);
        const waiters = eventWaitersByAgent.get(agentId);
        if (waiters) {
          eventWaitersByAgent.delete(agentId);
          for (const done of waiters) done();
        }
        yield { type: "turn_completed", provider } as never;
      })();
    },
    runAgent: async (agentId: string, prompt: string) => {
      sentPrompts.push({ agentId, prompt });
      return { canceled: false, timeline: [], finalText: "done" };
    },
    replaceAgentRun: async (
      agentId: string,
      prompt: unknown,
      runOptions?: { clientMessageId?: string },
    ) => agentManager.streamAgent(agentId, prompt, runOptions),
    steerOrReplaceActiveTurn: async () => ({ status: "none" as const }),
    waitForAgentEvent: async (agentId: string) => {
      if (inFlightRuns.has(agentId)) {
        await new Promise<void>((resolve) => {
          const list = eventWaitersByAgent.get(agentId) ?? [];
          list.push(resolve);
          eventWaitersByAgent.set(agentId, list);
        });
      }
      return { status: "idle", lastMessage: "[SILENT]", permission: null };
    },
    appendTimelineItem: async (agentId: string, item: AgentTimelineItem) => {
      const list = timelines.get(agentId) ?? [];
      list.push(item);
      timelines.set(agentId, list);
      return { seq: list.length, epoch: "e1" };
    },
    setAgentModel: async (agentId: string, modelId: string | null) => {
      modelSwitches.push({ agentId, modelId });
      const live = agents.get(agentId);
      if (live) {
        live.config.model = modelId ?? undefined;
        if (live.runtimeInfo) {
          live.runtimeInfo = { ...live.runtimeInfo, model: modelId };
        }
      }
    },
    setAgentLabels: async (agentId: string, patch: Record<string, string | null>) => {
      const live = agents.get(agentId);
      if (live) {
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) delete live.labels[k];
          else live.labels[k] = v;
        }
      }
      const rec = storedRecords.get(agentId);
      if (rec) {
        rec.labels = { ...(live?.labels ?? rec.labels) };
      }
    },
    archiveAgent: async (agentId: string) => {
      const rec = storedRecords.get(agentId);
      if (rec) rec.archivedAt = new Date(nowMs()).toISOString();
      agents.delete(agentId);
    },
    closeAgent: async (agentId: string) => {
      agents.delete(agentId);
    },
    cancelAgentRun: async () => undefined,
    notifyAgentState: () => undefined,
    unarchiveSnapshot: async () => false,
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
        {
          entry: {
            provider: "codex",
            enabled: true,
            models: [{ id: "gpt-5.2-codex", isDefault: true, contextWindowMaxTokens: 400_000 }],
          },
        },
        {
          entry: {
            provider: "opencode",
            enabled: true,
            models: [{ id: "gemini-2.5-pro", isDefault: true, contextWindowMaxTokens: 1_000_000 }],
          },
        },
      ],
    }),
    listProviders: () => [],
    resolveCreateConfig: async (input: {
      provider: string;
      requestedMode?: string;
      providerOptions?: Record<string, unknown>;
    }) => ({
      provider: input.provider,
      modeId: input.requestedMode ?? "default",
      providerOptions: input.providerOptions,
    }),
  } as unknown as ProviderSnapshotManager;

  const workspaceRegistry: Pick<WorkspaceRegistry, "get" | "listActive"> = {
    get: (id: string) => workspaces.get(id) ?? null,
    listActive: () => Array.from(workspaces.values()),
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

  const scheduleService = options.withScheduleService
    ? new ScheduleService({
        paseoHome,
        logger,
        agentManager: agentManager as never,
        agentStorage,
        createAgent: (async () => {
          throw new Error("not used in agent-target routines test");
        }) as never,
        createDirectoryWorkspace: async (input) => createDirectoryWorkspace(input.cwd),
        createPaseoWorktreeWorkspace: async () => {
          throw new Error("not used");
        },
        archiveWorkspace: async () => undefined,
        now: () => new Date(nowMs()),
      })
    : null;

  const service = createMainChatService({
    paseoHome,
    serverId: "srv_local",
    hostLabel: "DevBox",
    agentManager,
    agentStorage,
    providerSnapshotManager,
    workspaceRegistry,
    createDirectoryWorkspace,
    scheduleService,
    logger,
    now: nowMs,
    idlePrecompactCheckIntervalMs: 0,
    cacheKeepaliveCheckIntervalMs: 0,
    cacheKeepaliveRunner: options.keepalivePings
      ? async (target) => {
          options.keepalivePings!.push({ agentId: target.agentId, role: target.role });
          return { sent: true, detail: `kept warm ${target.agentId}` };
        }
      : undefined,
  });

  if (scheduleService) {
    scheduleService.setAgentScheduleExecutor((schedule, runId) =>
      service.executeScheduledAgentRoutine(schedule, runId),
    );
  }

  return {
    service,
    scheduleService,
    agentManager,
    agents,
    storedRecords,
    timelines,
    sentPrompts,
    modelSwitches,
    emit,
    makeLiveAgent,
    repoDir,
  };
}

describe("Wave 2 (P0-3 / P0-4 / P0-5): compaction cap, cache keepalive, routines, settings proposals & limitFallbacks", () => {
  let tmpDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "paseo-wave2-test-"));
    repoDir = path.join(tmpDir, "repo");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("[P0-3] applies default 400k compaction cap, custom cap, smaller model window, null uncapped mode, and configurable idle minutes", async () => {
    let currentMs = 1_760_000_000_000;
    const harness = makeWave2Harness(tmpDir, repoDir, {
      nowMs: () => currentMs,
      supportsNativeCompact: true,
    });
    await harness.service.start();
    await harness.service.updateSettings({ enabled: true });
    const { agentId: mainId } = await harness.service.ensureMainChat();
    const mainAgent = harness.agents.get(mainId)!;

    // 1M model + default 400k cap => effective 400k, threshold 320k
    mainAgent.lastUsage = {
      contextWindowUsedTokens: 330_000,
      contextWindowMaxTokens: 1_000_000,
    };
    const defaultState = await harness.service.getCompactionState(mainId);
    expect(defaultState.windowCapTokens).toBe(400_000);
    expect(defaultState.effectiveWindowTokens).toBe(400_000);
    expect(defaultState.thresholdTokens).toBe(320_000);
    expect(defaultState.idlePrecompactMinIdleMin).toBe(10);

    // Update idle wait threshold to 20 min and cap to 500k (threshold 400k)
    await harness.service.updateSettings({
      compaction: { windowCapTokens: 500_000, idlePrecompactMinIdleMin: 20 },
    });
    const updatedState = await harness.service.getCompactionState(mainId);
    expect(updatedState.windowCapTokens).toBe(500_000);
    expect(updatedState.effectiveWindowTokens).toBe(500_000);
    expect(updatedState.thresholdTokens).toBe(400_000);
    expect(updatedState.idlePrecompactMinIdleMin).toBe(20);

    // Model with 200k window (< 500k cap) => effective 200k, threshold 160k
    mainAgent.lastUsage = {
      contextWindowUsedTokens: 170_000,
      contextWindowMaxTokens: 200_000,
    };
    const smallModelState = await harness.service.getCompactionState(mainId);
    expect(smallModelState.effectiveWindowTokens).toBe(200_000);
    expect(smallModelState.thresholdTokens).toBe(160_000);

    // Idle only 15 min (< 20 min threshold) => MUST NOT trigger
    currentMs += 15 * 60_000;
    expect(await harness.service.checkIdlePrecompaction(mainId)).toBe(false);

    // Idle 21 min (>= 20 min threshold) => triggers native /compact with background compaction metadata
    currentMs += 6 * 60_000;
    expect(await harness.service.checkIdlePrecompaction(mainId)).toBe(true);

    const compactDispatch = harness.sentPrompts.find((entry) => entry.prompt === "/compact");
    expect(compactDispatch).toBeDefined();
    expect(
      compactDispatch?.clientMessageId?.startsWith(MAIN_CHAT_BACKGROUND_COMPACTION_MSG_PREFIX),
    ).toBe(true);

    // Timeline MUST NOT contain a bare hanging foreground `user_message` "/compact" — it must
    // project cleanly into a structured `kind: "compaction"` background turn tool_call.
    const timeline = harness.timelines.get(mainId) ?? [];
    expect(timeline.some((item) => item.type === "user_message" && item.text === "/compact")).toBe(
      false,
    );
    const projectedCompaction = timeline.find(
      (item) =>
        item.type === "tool_call" &&
        getMainChatBackgroundTurnMetadata(item.metadata)?.kind === "compaction",
    );
    expect(projectedCompaction).toBeDefined();
    if (projectedCompaction?.type === "tool_call") {
      expect(getMainChatBackgroundTurnMetadata(projectedCompaction.metadata)).toMatchObject({
        foldable: true,
        kind: "compaction",
        trigger: "idle_precompact",
        quiet: true,
      });
    }

    // Disabling cap (`windowCapTokens: null`) restores full 1M model window => threshold 800k
    await harness.service.updateSettings({ compaction: { windowCapTokens: null } });
    mainAgent.lastUsage = {
      contextWindowUsedTokens: 600_000,
      contextWindowMaxTokens: 1_000_000,
    };
    const uncappedState = await harness.service.getCompactionState(mainId);
    expect(uncappedState.windowCapTokens).toBeNull();
    expect(uncappedState.effectiveWindowTokens).toBe(1_000_000);
    expect(uncappedState.thresholdTokens).toBe(800_000);

    harness.service.stop();
  });

  it("appends structured kind='compaction' timeline row when native /compact runs out-of-band", async () => {
    const harness = makeWave2Harness(tmpDir, repoDir, {
      supportsNativeCompact: true,
      outOfBandCompact: true,
    });
    await harness.service.start();
    await harness.service.updateSettings({ enabled: true });
    const { agentId: mainId } = await harness.service.ensureMainChat();

    const result = await harness.service.compactMainChat(mainId, { reason: "idle_precompact" });
    expect(result.compaction.status).toBe("succeeded");
    expect(result.compaction.strategy).toBe("native");

    const timeline = harness.timelines.get(mainId) ?? [];
    const row = timeline.find(
      (item) =>
        item.type === "tool_call" &&
        getMainChatBackgroundTurnMetadata(item.metadata)?.kind === "compaction",
    );
    expect(row).toBeDefined();

    harness.service.stop();
  });

  it("schedules Prompt Cache keepalive only for main + resident leaders, enforces interval/maxRequests, and yields on night hibernation & active user", async () => {
    let currentMs = new Date(2026, 10, 24, 14, 0, 0, 0).getTime(); // 14:00 local daytime
    const pings: Array<{ agentId: string; role: "main" | "leader" }> = [];
    const harness = makeWave2Harness(tmpDir, repoDir, {
      nowMs: () => currentMs,
      keepalivePings: pings,
    });
    await harness.service.start();
    await harness.service.updateSettings({
      enabled: true,
      cacheKeepalive: { enabled: true, intervalMinutes: 50, maxRequests: 2 },
      nightMode: { enabled: true, startHour: 23, endHour: 8, behavior: "hibernate" },
    });
    const { agentId: mainId } = await harness.service.ensureMainChat();

    // Create one resident leader and one side conversation + one manual user session
    const leaderConv = await harness.service.createConversation({
      kind: "leader",
      title: "核心架构方向",
    });
    const sideConv = await harness.service.createConversation({
      kind: "side",
      title: "临时讨论",
    });
    const manualAgent = harness.makeLiveAgent({
      id: "manual_session_1",
      title: "用户手动会话",
      labels: {},
    });

    // Mark warm context on all four agents
    for (const id of [mainId, leaderConv.agentId, sideConv.agentId, manualAgent.id]) {
      const agent = harness.agents.get(id)!;
      agent.lastUsage = { inputTokens: 12_000, cachedInputTokens: 8_000 };
    }

    // 30 min idle (< 50 min interval) -> 0 pings
    currentMs += 30 * 60_000;
    expect(await harness.service.checkCacheKeepalive()).toBe(0);
    expect(pings).toHaveLength(0);

    // 51 min idle -> pings ONLY main + leader (NEVER side or manual)
    currentMs += 21 * 60_000;
    expect(await harness.service.checkCacheKeepalive()).toBe(2);
    expect(pings.map((p) => `${p.role}:${p.agentId}`).sort()).toEqual(
      [`leader:${leaderConv.agentId}`, `main:${mainId}`].sort(),
    );

    // Foreground user active on main -> main yields while leader still eligible after next 50m
    const releaseForeground = harness.service.beginForegroundUserSend(mainId);
    currentMs += 51 * 60_000;
    const secondRound = await harness.service.checkCacheKeepalive();
    expect(secondRound).toBe(1);
    expect(pings.at(-1)).toEqual({ agentId: leaderConv.agentId, role: "leader" });
    releaseForeground?.();

    // Leader has now hit maxRequests=2 -> next interval skips leader; main was reset by foreground activity
    currentMs += 51 * 60_000;
    const thirdRound = await harness.service.checkCacheKeepalive();
    expect(thirdRound).toBe(1);
    expect(pings.at(-1)).toEqual({ agentId: mainId, role: "main" });

    // Night hibernation (23:30 local) -> yields completely with night_hibernating
    currentMs = new Date(2026, 10, 24, 23, 30, 0, 0).getTime();
    expect(await harness.service.checkCacheKeepalive()).toBe(0);
    expect(harness.service.getCacheKeepaliveStatus().lastYieldReason).toBe("night_hibernating");

    // Turning keepalive off disables pings
    currentMs = new Date(2026, 10, 25, 10, 0, 0, 0).getTime();
    await harness.service.updateSettings({ cacheKeepalive: { enabled: false } });
    expect(await harness.service.checkCacheKeepalive()).toBe(0);
    expect(harness.service.getCacheKeepaliveStatus().enabled).toBe(false);

    harness.service.stop();
  });

  it("[P0-3] enforces maxRequests strictly through real sendPreparedPromptToAgent + turn_completed path (main & leader) without self-resetting, and resumes only after a real non-keepalive turn", async () => {
    let currentMs = new Date(2026, 10, 24, 14, 0, 0, 0).getTime();
    let releaseFirstMainPing: (() => void) | null = null;
    let firstMainPingDeferred = true;
    const harness = makeWave2Harness(tmpDir, repoDir, {
      nowMs: () => currentMs,
      emitStreamLifecycle: true,
      onStreamStarted: (agentId, release) => {
        if (firstMainPingDeferred && agentId === mainIdRef) {
          firstMainPingDeferred = false;
          releaseFirstMainPing = release;
          return;
        }
        setTimeout(release, 0);
      },
    });
    let mainIdRef = "";
    await harness.service.start();
    await harness.service.updateSettings({
      enabled: true,
      cacheKeepalive: { enabled: true, intervalMinutes: 10, maxRequests: 2 },
      nightMode: { enabled: false },
    });
    const { agentId: mainId } = await harness.service.ensureMainChat();
    mainIdRef = mainId;
    const leaderConv = await harness.service.createConversation({
      kind: "leader",
      title: "保活上限回归方向",
    });

    for (const id of [mainId, leaderConv.agentId]) {
      const agent = harness.agents.get(id)!;
      agent.lastUsage = { inputTokens: 10_000, cachedInputTokens: 8_000 };
    }

    // Ping #1: hold main ping in-flight and fire a concurrent tick() to verify in-flight state
    // NEVER resets pingsSinceLastRealTurn, then release so real turn_completed fires on main & leader.
    currentMs += 11 * 60_000;
    const ping1Promise = harness.service.checkCacheKeepalive();
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    expect(harness.agentManager.hasInFlightRun(mainId)).toBe(true);
    expect(await harness.service.checkCacheKeepalive()).toBe(0);
    releaseFirstMainPing?.();
    expect(await ping1Promise).toBe(2);
    expect(harness.sentPrompts).toHaveLength(2);

    // Ping #2: hits maxRequests=2 for both main and leader (real turn_completed emitted for both)
    currentMs += 11 * 60_000;
    expect(await harness.service.checkCacheKeepalive()).toBe(2);
    expect(harness.sentPrompts).toHaveLength(4);

    // Ping #3 & #4 attempts: MUST strictly stop at maxRequests=2 (turn_completed from keepalive
    // itself MUST NOT have cleared pingsSinceLastRealTurn!)
    currentMs += 11 * 60_000;
    expect(await harness.service.checkCacheKeepalive()).toBe(0);
    expect(harness.service.getCacheKeepaliveStatus().lastYieldReason).toBe("max_requests_reached");
    expect(harness.sentPrompts).toHaveLength(4);

    currentMs += 11 * 60_000;
    expect(await harness.service.checkCacheKeepalive()).toBe(0);
    expect(harness.sentPrompts).toHaveLength(4);

    // A genuine non-keepalive turn_completed on main and leader resets the stretch and resumes keepalive
    harness.emit({
      type: "agent_stream",
      agentId: mainId,
      event: {
        type: "turn_completed",
        provider: "claude",
        usage: { inputTokens: 2_000, cachedInputTokens: 1_500 },
      },
    } as AgentManagerEvent);
    harness.emit({
      type: "agent_stream",
      agentId: leaderConv.agentId,
      event: {
        type: "turn_completed",
        provider: "claude",
        usage: { inputTokens: 1_500, cachedInputTokens: 1_000 },
      },
    } as AgentManagerEvent);

    currentMs += 11 * 60_000;
    expect(await harness.service.checkCacheKeepalive()).toBe(2);
    expect(harness.sentPrompts).toHaveLength(6);

    harness.service.stop();
  });

  it("[P0-4] supports recurring & one-shot routines for main + leaders, writes background collapsed stream, migrates across /clear, and exposes RPCs & MCP tools", async () => {
    const currentMs = new Date("2026-11-25T09:00:00.000Z").getTime();
    const harness = makeWave2Harness(tmpDir, repoDir, {
      nowMs: () => currentMs,
      withScheduleService: true,
    });
    await harness.service.start();
    await harness.service.updateSettings({ enabled: true });
    const { agentId: mainId } = await harness.service.ensureMainChat();
    const leaderConv = await harness.service.createConversation({
      kind: "leader",
      title: "CI 质量方向",
    });
    const sideConv = await harness.service.createConversation({
      kind: "side",
      title: "侧边闲聊",
    });

    // Side conversations cannot own routines
    await expect(
      harness.service.createRoutine({
        name: "非法侧边任务",
        prompt: "检查",
        kind: "recurring",
        cadence: { type: "every", everyMs: 30 * 60_000 },
        conversationId: sideConv.id,
      }),
    ).rejects.toThrow("仅支持绑定到主对话或常驻方向主管对话");

    // Create recurring routine via RPC
    const responses: SessionOutboundMessage[] = [];
    const send = (msg: SessionOutboundMessage) => responses.push(msg);

    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.routines_create.request",
        requestId: "req_rc_1",
        name: "每日早报巡检",
        prompt: "汇总所有活跃任务与昨晚异常日志",
        kind: "recurring",
        cadence: { type: "cron", expression: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
      },
      send,
    );
    const createResp = responses.find((m) => m.type === "main_chat.routines_create.response");
    expect(
      createResp?.type === "main_chat.routines_create.response" && createResp.payload.error,
    ).toBeNull();
    const recurringId =
      createResp?.type === "main_chat.routines_create.response"
        ? createResp.payload.routine!.id
        : "";
    expect(recurringId).toBeTruthy();

    // Create one-shot reminder via MCP tool on main chat
    const tools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager: harness.agentManager,
      mainChatService: harness.service,
      callerAgentId: mainId,
      scope: "agent",
      tools,
      builtinNames: new Set(),
    });
    expect(tools.has("routine_list")).toBe(true);
    expect(tools.has("routine_create")).toBe(true);
    expect(tools.has("routine_manage")).toBe(true);

    const oneShotRes = (await tools.get("routine_create")!.handler(
      {
        name: "30 分钟后复查构建",
        prompt: "提醒用户检查 CI 流水线构建结果",
        kind: "one_shot",
        delayMinutes: 30,
      },
      { signal: new AbortController().signal },
    )) as { structuredContent: { routine: { id: string; kind: string; maxRuns: number } } };
    expect(oneShotRes.structuredContent.routine.kind).toBe("one_shot");
    expect(oneShotRes.structuredContent.routine.maxRuns).toBe(1);

    // Leader creates routine targeting itself automatically
    const leaderTools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager: harness.agentManager,
      mainChatService: harness.service,
      callerAgentId: leaderConv.agentId,
      scope: "agent",
      tools: leaderTools,
      builtinNames: new Set(),
    });
    expect(leaderTools.has("routine_create")).toBe(true);
    expect(leaderTools.has("settings_propose_patch")).toBe(false);
    const leaderRoutineRes = (await leaderTools.get("routine_create")!.handler(
      {
        name: "CI 波动巡查",
        prompt: "检查最近失败用例",
        everyMinutes: 60,
      },
      { signal: new AbortController().signal },
    )) as {
      structuredContent: { routine: { id: string; ownerKind: string; conversationId: string } };
    };
    expect(leaderRoutineRes.structuredContent.routine.ownerKind).toBe("leader");
    expect(leaderRoutineRes.structuredContent.routine.conversationId).toBe(leaderConv.id);

    // Pause -> Resume -> Run Once -> verify structured kind='routine' background turn in timeline
    await handleMainChatSessionMessage(
      harness.service,
      { type: "main_chat.routines_pause.request", requestId: "req_p", routineId: recurringId },
      send,
    );
    const pauseResp = responses.find((m) => m.type === "main_chat.routines_pause.response");
    expect(
      pauseResp?.type === "main_chat.routines_pause.response" && pauseResp.payload.routine?.status,
    ).toBe("paused");

    await handleMainChatSessionMessage(
      harness.service,
      { type: "main_chat.routines_resume.request", requestId: "req_r", routineId: recurringId },
      send,
    );
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.routines_run_once.request",
        requestId: "req_run",
        routineId: recurringId,
      },
      send,
    );

    const timeline = harness.timelines.get(mainId) ?? [];
    const routineItem = timeline.find(
      (item) =>
        item.type === "tool_call" &&
        getMainChatBackgroundTurnMetadata(item.metadata)?.kind === "routine",
    );
    expect(routineItem).toBeDefined();
    if (routineItem?.type === "tool_call") {
      expect(getMainChatBackgroundTurnMetadata(routineItem.metadata)).toMatchObject({
        foldable: true,
        kind: "routine",
        trigger: `routine:${recurringId}`,
        label: "每日早报巡检",
        quiet: true,
      });
    }

    // Main Chat /clear migrates routines seamlessly to the replacement main agent!
    const cleared = await harness.service.clearMainChatContext(mainId);
    expect(cleared.agentId).not.toBe(mainId);
    const afterClearRoutines = await harness.service.listRoutines();
    const migratedRecurring = afterClearRoutines.find((r) => r.id === recurringId);
    expect(migratedRecurring).toBeDefined();
    expect(migratedRecurring?.targetAgentId).toBe(cleared.agentId);

    // Delete via RPC
    await handleMainChatSessionMessage(
      harness.service,
      { type: "main_chat.routines_delete.request", requestId: "req_del", routineId: recurringId },
      send,
    );
    const delResp = responses.find((m) => m.type === "main_chat.routines_delete.response");
    expect(delResp?.type === "main_chat.routines_delete.response" && delResp.payload.deleted).toBe(
      true,
    );

    // System prompt documents both Routines and settings_propose_patch
    const prompt = buildMainChatSystemPrompt(await harness.service.getSettings());
    expect(prompt).toContain("routine_create");
    expect(prompt).toContain("settings_propose_patch");

    harness.service.stop();
  });

  it("[P0-5] enforces settings_propose_patch allowlist, never persists before user approval, respects reject, and applies atomically on approve", async () => {
    const harness = makeWave2Harness(tmpDir, repoDir);
    await harness.service.start();
    await harness.service.updateSettings({ enabled: true });
    const { agentId: mainId } = await harness.service.ensureMainChat();

    const tools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager: harness.agentManager,
      mainChatService: harness.service,
      callerAgentId: mainId,
      scope: "agent",
      tools,
      builtinNames: new Set(),
    });
    const proposeTool = tools.get("settings_propose_patch")!;
    expect(proposeTool).toBeDefined();

    // Reject non-allowlisted key (e.g. enabled / auth)
    await expect(
      proposeTool.handler(
        {
          reason: "尝试越权修改开关",
          changes: { enabled: false },
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow("不在允许自助提案的白名单内");

    // Valid allowlisted proposal -> persisted as pending, settings NOT modified on disk!
    const rawOutput = await proposeTool.handler(
      {
        title: "降低上下文压缩封顶并开启缓存保活",
        reason: "长会话成本较高，建议将压缩上限调至 300k 并设置 45 分钟保活",
        changes: {
          "compaction.windowCapTokens": 300_000,
          "cacheKeepalive.intervalMinutes": 45,
          limitFallbacks: [{ provider: "claude", model: "claude-haiku-4-5" }],
        },
      },
      { signal: new AbortController().signal },
    );
    const proposal = parseSettingsProposePatchToolPayload(rawOutput);
    expect(proposal).not.toBeNull();
    expect(proposal!.status).toBe("pending");
    expect(proposal!.changes).toHaveLength(3);

    // Verify settings were NOT silently persisted before approval!
    const beforeApprove = await harness.service.getSettings();
    expect(beforeApprove.compaction?.windowCapTokens).toBe(400_000);
    expect(beforeApprove.cacheKeepalive?.intervalMinutes).toBe(55);
    expect(beforeApprove.limitFallbacks).toEqual([]);

    // Rejecting a second proposal leaves settings completely untouched
    const rejectOutput = await proposeTool.handler(
      {
        reason: "改个名称测试拒绝",
        changes: { title: "不该生效的名字" },
      },
      { signal: new AbortController().signal },
    );
    const rejectProposal = parseSettingsProposePatchToolPayload(rejectOutput)!;

    const responses: SessionOutboundMessage[] = [];
    const send = (msg: SessionOutboundMessage) => responses.push(msg);
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.resolve_settings_proposal.request",
        requestId: "req_reject",
        proposalId: rejectProposal.id,
        decision: "reject",
        note: "保持原名称",
      },
      send,
    );
    const afterReject = await harness.service.getSettings();
    expect(afterReject.title).not.toBe("不该生效的名字");

    // Approving the first proposal applies and persists all 3 changes!
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.resolve_settings_proposal.request",
        requestId: "req_approve",
        proposalId: proposal!.id,
        decision: "approve",
      },
      send,
    );
    const approveResp = responses.find(
      (m) =>
        m.type === "main_chat.resolve_settings_proposal.response" &&
        m.payload.requestId === "req_approve",
    );
    expect(
      approveResp?.type === "main_chat.resolve_settings_proposal.response" &&
        approveResp.payload.proposal?.status,
    ).toBe("approved");

    const afterApprove = await harness.service.getSettings();
    expect(afterApprove.compaction?.windowCapTokens).toBe(300_000);
    expect(afterApprove.cacheKeepalive?.intervalMinutes).toBe(45);
    expect(afterApprove.limitFallbacks).toEqual([
      { provider: "claude", model: "claude-haiku-4-5" },
    ]);

    harness.service.stop();
  });

  it("detects rate limit/quota/429/usage limit, auto-switches main & managed subtasks sequentially without looping, and strictly forbids manual or handoff sessions", async () => {
    // Classifier checks
    expect(isLimitFallbackError("HTTP 429 Too Many Requests")).toBe(true);
    expect(isLimitFallbackError("Rate limit reached for model")).toBe(true);
    expect(isLimitFallbackError("Usage limit exceeded; resets in 2h")).toBe(true);
    expect(isLimitFallbackError("insufficient_quota on account")).toBe(true);
    expect(isLimitFallbackError("401 Unauthorized: invalid api key")).toBe(false);
    expect(isLimitFallbackError("Request was aborted")).toBe(false);

    const harness = makeWave2Harness(tmpDir, repoDir);
    await harness.service.start();
    await harness.service.updateSettings({
      enabled: true,
      limitFallbacks: [
        { provider: "claude", model: "claude-haiku-4-5" },
        { provider: "codex", model: "gpt-5.2-codex" },
      ],
    });
    const { agentId: mainId } = await harness.service.ensureMainChat();

    // 1. User manual session -> STRICTLY FORBIDDEN!
    const manualAgent = harness.makeLiveAgent({
      id: "manual_user_agent",
      provider: "claude",
      model: "claude-sonnet-4-5",
      title: "用户手开会话",
      labels: {},
    });
    expect(evaluateLimitFallbackEligibility(manualAgent, "HTTP 429 rate limit")).toEqual({
      eligible: false,
      reason: "manual_user_session_forbidden",
    });
    const manualOutcome = await harness.service.tryLimitFallbackForAgent(
      manualAgent.id,
      "HTTP 429 rate limit",
    );
    expect(manualOutcome.switched).toBe(false);
    expect(manualOutcome.reason).toBe("manual_user_session_forbidden");
    expect(harness.modelSwitches).toHaveLength(0);

    // 2. Handoff / former session -> STRICTLY FORBIDDEN!
    const handoffAgent = harness.makeLiveAgent({
      id: "handoff_interrupted_agent",
      provider: "claude",
      model: "claude-sonnet-4-5",
      labels: {
        [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE,
        [MAIN_CHAT_REPLACED_BY_LABEL]: "newer_agent",
      },
    });
    expect(evaluateLimitFallbackEligibility(handoffAgent, "quota exceeded")).toEqual({
      eligible: false,
      reason: "handoff_or_replaced_session",
    });
    const formerAgent = harness.makeLiveAgent({
      id: "former_main_agent",
      provider: "claude",
      model: "claude-sonnet-4-5",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_FORMER_ROLE_VALUE },
    });
    expect(evaluateLimitFallbackEligibility(formerAgent, "HTTP 429")).toEqual({
      eligible: false,
      reason: "handoff_or_replaced_session",
    });

    // 3. Managed subtask -> switches in-place to same-provider fallback without looping
    const managedChild = harness.makeLiveAgent({
      id: "managed_child_1",
      provider: "claude",
      model: "claude-sonnet-4-5",
      title: "受管子任务",
      labels: {
        [PARENT_AGENT_ID_LABEL]: mainId,
        [MAIN_CHAT_TASK_PLAN_ID_LABEL]: "plan_1",
        [MAIN_CHAT_CONVERSATION_ID_LABEL]: "conv_main",
        [MAIN_CHAT_CONVERSATION_KIND_LABEL]: "main",
      },
    });
    const childSwitch1 = await harness.service.tryLimitFallbackForAgent(
      managedChild.id,
      "HTTP 429 Too Many Requests",
    );
    expect(childSwitch1.switched).toBe(true);
    expect(childSwitch1.event?.toModel).toBe("claude-haiku-4-5");
    expect(harness.modelSwitches.at(-1)).toEqual({
      agentId: managedChild.id,
      modelId: "claude-haiku-4-5",
    });
    // Second failure on same subtask without intervening success -> anti-loop stops!
    const childSwitch2 = await harness.service.tryLimitFallbackForAgent(
      managedChild.id,
      "HTTP 429 Too Many Requests",
    );
    expect(childSwitch2.switched).toBe(false);

    // 4. Main Chat sequential fallback: claude-sonnet -> claude-haiku (same-provider) -> codex/gpt-5.2-codex (cross-provider) -> exhausted (no loop!)
    const mainSwitch1 = await harness.service.tryLimitFallbackForAgent(
      mainId,
      "Usage limit reached for claude-sonnet-4-5",
    );
    expect(mainSwitch1.switched).toBe(true);
    expect(mainSwitch1.event?.toProvider).toBe("claude");
    expect(mainSwitch1.event?.toModel).toBe("claude-haiku-4-5");

    const mainSwitch2 = await harness.service.tryLimitFallbackForAgent(
      mainId,
      "Quota exceeded on claude-haiku-4-5",
    );
    expect(mainSwitch2.reason).toBe("switched");
    expect(mainSwitch2.switched).toBe(true);
    expect(mainSwitch2.event?.toProvider).toBe("codex");
    expect(mainSwitch2.event?.toModel).toBe("gpt-5.2-codex");
    const newMainId = mainSwitch2.newAgentId!;
    expect(newMainId).not.toBe(mainId);

    // Third failure immediately after -> all 2 fallbacks tried -> MUST NOT loop back to claude!
    const mainSwitch3 = await harness.service.tryLimitFallbackForAgent(
      newMainId,
      "Rate limit exceeded on gpt-5.2-codex",
    );
    expect(mainSwitch3.switched).toBe(false);
    expect(mainSwitch3.reason).toBe("limit_fallbacks_exhausted");

    const recentEvents = await harness.service.listRecentLimitFallbacks();
    expect(recentEvents.length).toBe(3);

    // Verify vi is used cleanly without unused import warnings
    expect(vi.isFakeTimers()).toBe(false);
    harness.service.stop();
  });
});
