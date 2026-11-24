import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_CHAT_FORMER_ROLE_VALUE,
  MAIN_CHAT_REPLACED_BY_LABEL,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
} from "@getpaseo/protocol/main-chat";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentSessionConfig, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { FinishSubscriptions } from "../agent/finish-subscriptions/index.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { SessionOutboundMessage } from "../messages.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import { createMainChatService } from "./service.js";
import { handleMainChatSessionMessage } from "./session.js";
import { MAX_RETAINED_ACTIVITIES, createMainChatStore } from "./store.js";

function createTestLogger() {
  return pino({ level: "silent" });
}

describe("main-chat M2 lifecycle: compact, idle precompact, /clear, new_session handoff & activity RPCs", () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-main-chat-life-"));
    repoDir = path.join(tempDir, "repo");
    await mkdir(repoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeLifecycleHarness(options?: {
    supportsNativeCompact?: boolean;
    failCompactPrompt?: boolean;
    compactThresholdTokens?: number;
    idlePrecompactMinIdleMs?: number;
    getNowMs?: () => number;
  }) {
    const subscribers = new Set<(event: AgentManagerEvent) => void>();
    const agents = new Map<string, ManagedAgent>();
    const storedAgents = new Map<string, StoredAgentRecord>();
    const workspaces = new Map<string, PersistedWorkspaceRecord>();
    const timelines = new Map<string, AgentTimelineItem[]>();
    const sentPrompts: Array<{ agentId: string; prompt: unknown }> = [];
    const archivedIds: string[] = [];
    const finishRegistered: Array<{ callerAgentId: string; childAgentId: string }> = [];
    let nextId = 1;

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
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      createAgent: vi.fn(
        async (
          config: AgentSessionConfig,
          requestedId?: string,
          createOptions?: {
            workspaceId?: string;
            labels?: Record<string, string>;
            initialTitle?: string | null;
            background?: boolean;
          },
        ) => {
          const id = requestedId ?? `agent_${nextId++}`;
          const labels = { ...createOptions?.labels };
          const nowDate = new Date(options?.getNowMs ? options.getNowMs() : Date.now());
          const nowIso = nowDate.toISOString();
          const listCommands = async () =>
            options?.supportsNativeCompact
              ? [{ name: "compact", description: "Compact context" }]
              : [];
          const managed = {
            id,
            provider: config.provider,
            cwd: config.cwd,
            workspaceId: createOptions?.workspaceId,
            config: { ...config },
            labels,
            metadata: {},
            lifecycle: "idle",
            attention: { requiresAttention: false },
            currentModeId: config.modeId ?? null,
            availableModes: [],
            pendingPermissions: new Map(),
            internal: config.internal === true,
            background: createOptions?.background === true,
            updatedAt: nowDate,
            runtimeInfo: {
              provider: config.provider,
              sessionId: `sess_${id}`,
              model: config.model,
            },
            session: { listCommands },
          } as unknown as ManagedAgent;
          agents.set(id, managed);
          storedAgents.set(id, {
            id,
            provider: config.provider,
            cwd: config.cwd,
            workspaceId: createOptions?.workspaceId,
            createdAt: nowIso,
            updatedAt: nowIso,
            title: createOptions?.initialTitle ?? config.title ?? null,
            labels: { ...labels },
            lastStatus: "idle",
            lastModeId: config.modeId ?? null,
            config: {
              model: config.model ?? null,
              modeId: config.modeId ?? null,
              thinkingOptionId: config.thinkingOptionId ?? null,
            },
            background: createOptions?.background === true,
          } as unknown as StoredAgentRecord);
          return managed;
        },
      ),
      tryRunOutOfBand: vi.fn(async () => false),
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
        if (options?.failCompactPrompt) {
          throw new Error("provider compaction unavailable");
        }
        sentPrompts.push({ agentId, prompt });
        promptStart?.bind?.({
          start: { status: "started" },
          turnStartedPromise: Promise.resolve(),
          settledPromise: Promise.resolve(),
        });
        yield { type: "turn_started", provider: "claude" };
        yield { type: "turn_completed", provider: "claude" };
      }),
      cancelAgentRun: vi.fn(async () => ({ status: "not_running" as const })),
      clearAgentAttention: vi.fn(async () => undefined),
      archiveAgent: vi.fn(async (agentId: string) => {
        const archivedAt = new Date().toISOString();
        archivedIds.push(agentId);
        const stored = storedAgents.get(agentId);
        if (stored) {
          storedAgents.set(agentId, { ...stored, archivedAt });
        }
        agents.delete(agentId);
        // Simulate real cascade archive on any child STILL pointing to agentId!
        for (const child of Array.from(agents.values())) {
          if (child.labels[PARENT_AGENT_ID_LABEL] === agentId) {
            archivedIds.push(child.id);
            agents.delete(child.id);
          }
        }
        return { archivedAt };
      }),
      archiveSnapshot: vi.fn(async (agentId: string, archivedAt: string) => {
        archivedIds.push(agentId);
        const stored = storedAgents.get(agentId)!;
        const updated = { ...stored, archivedAt };
        storedAgents.set(agentId, updated);
        return updated;
      }),
      getTimeline: vi.fn((agentId: string) => timelines.get(agentId) ?? []),
      updateAgentMetadata: vi.fn(
        async (agentId: string, update: { title?: string; labels?: Record<string, string> }) => {
          const live = agents.get(agentId) as
            | (ManagedAgent & { config: { title?: string } })
            | undefined;
          if (live) {
            if (update.title) live.config.title = update.title;
            if (update.labels) live.labels = { ...live.labels, ...update.labels };
          }
          const stored = storedAgents.get(agentId);
          if (stored) {
            storedAgents.set(agentId, {
              ...stored,
              ...(update.title ? { title: update.title } : {}),
              ...(update.labels ? { labels: { ...stored.labels, ...update.labels } } : {}),
            });
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
      listProviders: vi.fn(async () => []),
      resolveCreateConfig: vi.fn(async (input: { provider: string; requestedMode?: string }) => ({
        provider: input.provider,
        modeId: input.requestedMode ?? "default",
      })),
    } as unknown as ProviderSnapshotManager;

    const workspaceRegistry = {
      get: async (id: string) => workspaces.get(id) ?? null,
      listActive: async () => Array.from(workspaces.values()),
    };

    const finishSubscriptions = {
      register: vi.fn(async (input: { callerAgentId: string; childAgentId: string }) => {
        finishRegistered.push({
          callerAgentId: input.callerAgentId,
          childAgentId: input.childAgentId,
        });
        return { accept: vi.fn(), reject: vi.fn(async () => undefined) };
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
      now: options?.getNowMs,
      compactThresholdTokens: options?.compactThresholdTokens,
      idlePrecompactMinIdleMs: options?.idlePrecompactMinIdleMs,
      idlePrecompactCheckIntervalMs: 0,
      stalledCheckIntervalMs: 60_000,
    });

    const rawStart = service.start.bind(service);
    service.start = async () => {
      await rawStart();
      await service.updateSettings({ enabled: true });
    };

    return {
      service,
      agents,
      storedAgents,
      timelines,
      sentPrompts,
      archivedIds,
      finishRegistered,
      emit: (event: AgentManagerEvent) => {
        for (const cb of subscribers) cb(event);
      },
    };
  }

  it("compacts via native /compact when supported and falls back to structured handoff summary otherwise", async () => {
    const nativeHarness = makeLifecycleHarness({ supportsNativeCompact: true });
    await nativeHarness.service.start();
    const { agentId: nativeMainId } = await nativeHarness.service.ensureMainChat();

    const nativeResult = await nativeHarness.service.compactMainChat(nativeMainId, {
      reason: "manual",
      instructions: "保留发布清单",
    });
    expect(nativeResult.compaction.status).toBe("succeeded");
    expect(nativeResult.compaction.strategy).toBe("native");
    expect(nativeResult.compaction.lastCompactedAt).toBeTruthy();
    expect(nativeResult.compaction.lastError).toBeNull();
    expect(nativeHarness.sentPrompts.at(-1)?.prompt).toBe("/compact 保留发布清单");
    nativeHarness.service.stop();

    // Separate home directory for fallback provider without native compact command.
    const fallbackDir = await mkdtemp(path.join(os.tmpdir(), "paseo-main-chat-fallback-"));
    try {
      tempDir = fallbackDir;
      const fallbackHarness = makeLifecycleHarness({ supportsNativeCompact: false });
      await fallbackHarness.service.start();
      const { agentId: fallbackMainId } = await fallbackHarness.service.ensureMainChat();
      fallbackHarness.timelines.set(fallbackMainId, [
        { type: "user_message", text: "帮我盯紧 M2 内核重构" },
        { type: "assistant_message", text: "收到，已拆分为协议与服务端两部分。" },
      ]);

      const fallbackResult = await fallbackHarness.service.compactMainChat(fallbackMainId, {
        reason: "manual",
      });
      expect(fallbackResult.compaction.status).toBe("succeeded");
      expect(fallbackResult.compaction.strategy).toBe("handoff_summary");
      expect(fallbackResult.compaction.summary).toContain("帮我盯紧 M2 内核重构");
      expect(String(fallbackHarness.sentPrompts.at(-1)?.prompt)).toContain("上下文压缩检查点");
      fallbackHarness.service.stop();
    } finally {
      await rm(fallbackDir, { recursive: true, force: true });
    }
  });

  it("triggers silent idle pre-compaction at >=75% token threshold after continuous idle and yields to active user", async () => {
    let nowMs = 1_700_000_000_000;
    const harness = makeLifecycleHarness({
      supportsNativeCompact: true,
      compactThresholdTokens: 100_000,
      idlePrecompactMinIdleMs: 60_000,
      getNowMs: () => nowMs,
    });
    await harness.service.start();
    const { agentId: mainId } = await harness.service.ensureMainChat();

    const mainAgent = harness.agents.get(mainId)!;
    // Below 75% threshold -> should NOT trigger even after long idle.
    mainAgent.lastUsage = { contextWindowUsedTokens: 60_000 };
    nowMs += 120_000;
    expect(await harness.service.checkIdlePrecompaction(mainId)).toBe(false);

    // Above 75% threshold (80k / 100k), but user is currently active -> MUST yield & not run!
    mainAgent.lastUsage = { contextWindowUsedTokens: 80_000 };
    const releaseForeground = harness.service.beginForegroundUserSend(mainId);
    expect(await harness.service.checkIdlePrecompaction(mainId)).toBe(false);
    releaseForeground?.();

    // User becomes idle for >= 60s -> triggers silent idle pre-compaction ONCE.
    nowMs += 65_000;
    expect(await harness.service.checkIdlePrecompaction(mainId)).toBe(true);
    expect(harness.sentPrompts.some((entry) => entry.prompt === "/compact")).toBe(true);

    const stateAfter = await harness.service.getCompactionState(mainId);
    expect(stateAfter.status).toBe("succeeded");
    expect(stateAfter.reason).toBe("idle_precompact");

    // Repeated idle check without new activity MUST NOT loop pre-compaction!
    nowMs += 120_000;
    expect(await harness.service.checkIdlePrecompaction(mainId)).toBe(false);

    harness.service.stop();
  });

  it("executes /clear in place: archives old main chat, creates clean replacement, atomically migrates tasks/decisions/children, and resets snapshot", async () => {
    const harness = makeLifecycleHarness();
    await harness.service.start();
    const { agentId: oldMainId, workspaceId } = await harness.service.ensureMainChat();

    // Create an auto-started plan (spawns child agent), an open write plan, a decision, and a receipt.
    const readonlyPlan = await harness.service.createPlan(oldMainId, {
      summary: "只读分析",
      tasks: [
        {
          title: "查日志",
          goal: "排查超时日志",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["定位超时函数"],
        },
      ],
    });
    const childId = readonlyPlan.tasks[0]!.agentId!;
    const writePlan = await harness.service.createPlan(oldMainId, {
      summary: "待审批改造",
      tasks: [
        {
          title: "改配置",
          goal: "调整重试上限",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["单测通过"],
        },
      ],
    });
    const decision = await harness.service.askUserDecision(oldMainId, {
      title: "部署策略",
      question: "先灰度还是全量？",
      agentId: childId,
      options: [
        { id: "canary", label: "灰度", leadsTo: "10% 流量" },
        { id: "full", label: "全量", leadsTo: "100% 流量" },
      ],
    });
    await harness.service.recordReceipt(
      {
        title: "前置检查",
        summary: "已通过",
        agentId: childId,
        planId: readonlyPlan.id,
        taskId: readonlyPlan.tasks[0]!.id,
        checks: [{ label: "typecheck", passed: true, evidence: "0 errors" }],
        nextSteps: [],
      },
      oldMainId,
    );

    // Prime snapshot delta on old main chat.
    await harness.service.prepareUserPromptForMainChat(oldMainId, "现状如何？");

    const cleared = await harness.service.clearMainChatContext(oldMainId);
    expect(cleared.previousAgentId).toBe(oldMainId);
    expect(cleared.agentId).not.toBe(oldMainId);
    expect(cleared.workspaceId).toBe(workspaceId);
    expect(cleared.migratedPlans).toBe(2);
    expect(cleared.migratedDecisions).toBe(1);
    expect(cleared.migratedChildAgents).toBe(1);

    // Old main chat is archived with former role label, and child agent was NOT cascade-archived!
    expect(harness.archivedIds).toContain(oldMainId);
    expect(harness.archivedIds).not.toContain(childId);
    expect(harness.storedAgents.get(oldMainId)?.archivedAt).toBeTruthy();
    expect(harness.storedAgents.get(oldMainId)?.labels[MAIN_CHAT_ROLE_LABEL]).toBe(
      MAIN_CHAT_FORMER_ROLE_VALUE,
    );
    expect(harness.storedAgents.get(oldMainId)?.labels[MAIN_CHAT_REPLACED_BY_LABEL]).toBe(
      cleared.agentId,
    );

    // New main chat carries active role label and owns migrated child, plans, decisions & finish sub!
    expect(harness.agents.get(cleared.agentId)?.labels[MAIN_CHAT_ROLE_LABEL]).toBe(
      MAIN_CHAT_ROLE_VALUE,
    );
    expect(harness.agents.get(childId)?.labels[PARENT_AGENT_ID_LABEL]).toBe(cleared.agentId);
    expect(
      harness.finishRegistered.some(
        (entry) => entry.callerAgentId === cleared.agentId && entry.childAgentId === childId,
      ),
    ).toBe(true);

    const overview = await harness.service.getOverview(cleared.agentId);
    expect(overview.plans.map((p) => p.id)).toEqual(
      expect.arrayContaining([readonlyPlan.id, writePlan.id]),
    );
    expect(overview.decisions.map((d) => d.id)).toEqual([decision.id]);
    expect(overview.compaction?.status).toBe("idle");

    // Next user turn on the cleared main chat automatically receives a FULL fresh snapshot!
    const nextPrompt = await harness.service.prepareUserPromptForMainChat(cleared.agentId, "继续");
    expect(String(nextPrompt)).toContain("全机实时快照");
    expect(String(nextPrompt)).toContain("部署策略");

    // Clear audit record exists.
    const clearEvents = await harness.service.listActivity({
      mainAgentId: cleared.agentId,
      kind: "clear",
    });
    expect(clearEvents.total).toBe(1);
    expect(clearEvents.activities[0]?.relatedAgentId).toBe(oldMainId);

    harness.service.stop();
  });

  it("starts a new main chat with handoff summary, injects it once on first turn, and serves all 4 M2 RPCs", async () => {
    const harness = makeLifecycleHarness({ supportsNativeCompact: true });
    await harness.service.start();
    const { agentId: firstMainId } = await harness.service.ensureMainChat();

    const plan = await harness.service.createPlan(firstMainId, {
      summary: "并行改造",
      tasks: [
        {
          title: "实现队列",
          goal: "完成优先级队列",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["单测通过"],
        },
      ],
    });
    const childId = plan.tasks[0]!.agentId!;
    await harness.service.askUserDecision(firstMainId, {
      title: "缓存窗口",
      question: "采用 45 秒还是 60 秒？",
      agentId: childId,
      options: [
        { id: "45s", label: "45 秒", leadsTo: "平衡新鲜度" },
        { id: "60s", label: "60 秒", leadsTo: "更低扫描频率" },
      ],
    });
    harness.timelines.set(firstMainId, [
      { type: "user_message", text: "今天重点推进 M2 底座" },
      { type: "assistant_message", text: "好的，正在同步队列和快照升级。" },
    ]);

    // Invoke via session RPC handler: main_chat.new_session.request
    const responses: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.new_session.request",
        requestId: "req_new_1",
        mainAgentId: firstMainId,
        carryHandoffSummary: true,
        title: "M2 总控台",
      },
      (msg) => responses.push(msg),
    );
    const newRes = responses[0];
    expect(newRes?.type).toBe("main_chat.new_session.response");
    if (newRes?.type !== "main_chat.new_session.response") throw new Error("unexpected response");
    expect(newRes.payload.error).toBeNull();
    expect(newRes.payload.previousAgentId).toBe(firstMainId);
    expect(newRes.payload.agentId).toBeTruthy();
    expect(newRes.payload.handoffSummary).toContain("缓存窗口");
    expect(newRes.payload.handoffSummary).toContain("今天重点推进 M2 底座");
    expect(newRes.payload.migratedChildAgents).toBe(1);

    const secondMainId = newRes.payload.agentId!;
    expect(harness.agents.get(secondMainId)?.config.title).toBe("M2 总控台");
    expect(harness.agents.get(childId)?.labels[PARENT_AGENT_ID_LABEL]).toBe(secondMainId);

    // First foreground prompt consumes and injects the handoff summary into <paseo-main-context>.
    const firstTurnPrompt = await harness.service.prepareUserPromptForMainChat(
      secondMainId,
      "我回来了",
    );
    expect(String(firstTurnPrompt)).toContain("上一任主对话交接摘要");
    expect(String(firstTurnPrompt)).toContain("今天重点推进 M2 底座");

    // Second turn does NOT repeat the consumed handoff summary.
    const secondTurnPrompt = await harness.service.prepareUserPromptForMainChat(
      secondMainId,
      "下一步呢",
    );
    expect(String(secondTurnPrompt)).not.toContain("上一任主对话交接摘要");

    // Exercise main_chat.compact.request, main_chat.list_activity.request, and main_chat.clear.request via session RPC.
    responses.length = 0;
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.compact.request",
        requestId: "req_cmp_1",
        mainAgentId: secondMainId,
        reason: "manual",
      },
      (msg) => responses.push(msg),
    );
    expect(responses[0]?.type).toBe("main_chat.compact.response");
    if (responses[0]?.type === "main_chat.compact.response") {
      expect(responses[0].payload.error).toBeNull();
      expect(responses[0].payload.compaction?.status).toBe("succeeded");
    }

    responses.length = 0;
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.list_activity.request",
        requestId: "req_list_1",
        mainAgentId: secondMainId,
        limit: 10,
      },
      (msg) => responses.push(msg),
    );
    expect(responses[0]?.type).toBe("main_chat.list_activity.response");
    if (responses[0]?.type === "main_chat.list_activity.response") {
      expect(responses[0].payload.error).toBeNull();
      expect(responses[0].payload.activities.map((a) => a.kind)).toEqual(
        expect.arrayContaining(["handoff", "compaction"]),
      );
    }

    responses.length = 0;
    await handleMainChatSessionMessage(
      harness.service,
      { type: "main_chat.clear.request", requestId: "req_clr_1", mainAgentId: secondMainId },
      (msg) => responses.push(msg),
    );
    expect(responses[0]?.type).toBe("main_chat.clear.response");
    if (responses[0]?.type === "main_chat.clear.response") {
      expect(responses[0].payload.error).toBeNull();
      expect(responses[0].payload.previousAgentId).toBe(secondMainId);
    }

    harness.service.stop();
  });

  it("caps persisted activity entries at 200 and returns clean errors when service is unconfigured", async () => {
    const store = createMainChatStore(tempDir);
    await store.load();
    for (let i = 1; i <= 215; i += 1) {
      await store.appendActivity({
        id: `act_${i}`,
        mainAgentId: "agent_main",
        kind: i % 2 === 0 ? "silent_turn" : "background_turn",
        trigger: "patrol_wakeup",
        summary: `活动 #${i}`,
        silent: i % 2 === 0,
        status: "completed",
        createdAt: new Date(1_700_000_000_000 + i * 1_000).toISOString(),
        completedAt: new Date(1_700_000_000_000 + i * 1_000).toISOString(),
      });
    }

    const reloaded = createMainChatStore(tempDir);
    await reloaded.load();
    const listed = reloaded.listActivities({ mainAgentId: "agent_main", limit: 200 });
    expect(listed.total).toBe(MAX_RETAINED_ACTIVITIES);
    expect(listed.activities[0]?.id).toBe("act_215");
    expect(listed.activities.at(-1)?.id).toBe("act_16");

    const unconfiguredResponses: SessionOutboundMessage[] = [];
    for (const msg of [
      { type: "main_chat.compact.request" as const, requestId: "u1" },
      { type: "main_chat.clear.request" as const, requestId: "u2" },
      { type: "main_chat.new_session.request" as const, requestId: "u3" },
      { type: "main_chat.list_activity.request" as const, requestId: "u4" },
    ]) {
      await handleMainChatSessionMessage(null, msg, (res) => unconfiguredResponses.push(res));
    }
    expect(unconfiguredResponses).toHaveLength(4);
    for (const res of unconfiguredResponses) {
      expect("payload" in res && res.payload.error).toContain("not configured");
    }
  });

  it("switches main chat provider and model cleanly on new_session and clear without leaking incompatible mode/thinking options", async () => {
    const harness = makeLifecycleHarness({ supportsNativeCompact: true });
    await harness.service.start();
    const { agentId: codexMainId } = await harness.service.ensureMainChat({
      provider: "codex",
      model: "gpt-5.6-terra",
      modeId: "full-access",
      thinkingOptionId: "max",
    });

    expect(harness.agents.get(codexMainId)?.config).toMatchObject({
      provider: "codex",
      model: "gpt-5.6-terra",
      modeId: "full-access",
      thinkingOptionId: "max",
    });

    const plan = await harness.service.createPlan(codexMainId, {
      summary: "跨 Provider 切换验证",
      tasks: [
        {
          title: "保持任务不断链",
          goal: "切换 Provider 后子任务仍挂载到新主对话",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["父子关系迁移成功"],
        },
      ],
    });
    const childId = plan.tasks[0]!.agentId!;

    // Switch provider from codex -> claude via main_chat.new_session.request
    const switchResponses: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.new_session.request",
        requestId: "req_switch_provider",
        mainAgentId: codexMainId,
        carryHandoffSummary: true,
        provider: "claude",
        model: "claude-opus-4-6",
      },
      (msg) => switchResponses.push(msg),
    );
    const switchRes = switchResponses[0];
    expect(switchRes?.type).toBe("main_chat.new_session.response");
    if (switchRes?.type !== "main_chat.new_session.response") {
      throw new Error("unexpected response");
    }
    expect(switchRes.payload.error).toBeNull();
    expect(switchRes.payload.previousAgentId).toBe(codexMainId);
    expect(switchRes.payload.migratedChildAgents).toBe(1);

    const claudeMainId = switchRes.payload.agentId!;
    const claudeAgent = harness.agents.get(claudeMainId);
    expect(claudeAgent?.config.provider).toBe("claude");
    expect(claudeAgent?.config.model).toBe("claude-opus-4-6");
    // Incompatible codex modeId ("full-access") and thinkingOptionId ("max") must not carry over to claude.
    expect(claudeAgent?.config.modeId).not.toBe("full-access");
    expect(claudeAgent?.config.thinkingOptionId).toBeUndefined();
    expect(harness.agents.get(childId)?.labels[PARENT_AGENT_ID_LABEL]).toBe(claudeMainId);

    // Switch again via main_chat.clear.request with explicit provider/model
    const clearResponses: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.clear.request",
        requestId: "req_clear_switch",
        mainAgentId: claudeMainId,
        provider: "gemini",
        model: "gemini-4-neon",
      },
      (msg) => clearResponses.push(msg),
    );
    const clearRes = clearResponses[0];
    expect(clearRes?.type).toBe("main_chat.clear.response");
    if (clearRes?.type !== "main_chat.clear.response") {
      throw new Error("unexpected response");
    }
    expect(clearRes.payload.error).toBeNull();
    const geminiAgent = harness.agents.get(clearRes.payload.agentId!);
    expect(geminiAgent?.config.provider).toBe("gemini");
    expect(geminiAgent?.config.model).toBe("gemini-4-neon");
    expect(harness.agents.get(childId)?.labels[PARENT_AGENT_ID_LABEL]).toBe(
      clearRes.payload.agentId,
    );

    harness.service.stop();
  });
});
