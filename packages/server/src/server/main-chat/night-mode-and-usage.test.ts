import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_CHAT_CONVERSATION_ID_LABEL,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
} from "@getpaseo/protocol/main-chat";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import type { SessionOutboundMessage } from "../messages.js";
import {
  computeNextWindowTransitionMs,
  evaluateMainChatNightMode,
  isWithinNightWindow,
} from "./night-mode.js";
import { createMainChatService } from "./service.js";
import { handleMainChatSessionMessage } from "./session.js";
import { createMainChatStore } from "./store.js";

function localTimeMs(year: number, month: number, day: number, hour: number, minute = 0): number {
  return new Date(year, month - 1, day, hour, minute, 0, 0).getTime();
}

describe("night-mode pure evaluation", () => {
  it("evaluates midnight-crossing and same-day night windows accurately", () => {
    expect(isWithinNightWindow(localTimeMs(2026, 11, 23, 22, 59), 23, 8)).toBe(false);
    expect(isWithinNightWindow(localTimeMs(2026, 11, 23, 23, 0), 23, 8)).toBe(true);
    expect(isWithinNightWindow(localTimeMs(2026, 11, 24, 3, 30), 23, 8)).toBe(true);
    expect(isWithinNightWindow(localTimeMs(2026, 11, 24, 7, 59), 23, 8)).toBe(true);
    expect(isWithinNightWindow(localTimeMs(2026, 11, 24, 8, 0), 23, 8)).toBe(false);

    expect(isWithinNightWindow(localTimeMs(2026, 11, 24, 0, 30), 1, 6)).toBe(false);
    expect(isWithinNightWindow(localTimeMs(2026, 11, 24, 1, 0), 1, 6)).toBe(true);
    expect(isWithinNightWindow(localTimeMs(2026, 11, 24, 5, 59), 1, 6)).toBe(true);
    expect(isWithinNightWindow(localTimeMs(2026, 11, 24, 6, 0), 1, 6)).toBe(false);

    // Same start/end hour represents 24h window.
    expect(isWithinNightWindow(localTimeMs(2026, 11, 24, 14, 0), 2, 2)).toBe(true);
    expect(computeNextWindowTransitionMs(localTimeMs(2026, 11, 24, 14, 0), 2, 2, true)).toBeNull();
  });

  it("transitions from throttled to auto-hibernating after idle threshold in night window", () => {
    const settings = createDefaultMainChatSettings("conservative");
    settings.nightMode = {
      enabled: true,
      startHour: 23,
      endHour: 8,
      behavior: "throttle",
      patrolIntervalSec: 600,
      autoHibernateAfterIdleMin: 30,
      disableSemanticTriage: true,
      deferProactiveWakeups: true,
      allowUrgentWakeups: false,
    };

    const nightActive = evaluateMainChatNightMode({
      settings,
      nowMs: localTimeMs(2026, 11, 23, 23, 15),
      hasActiveFleetWork: true,
      lastActivityAtMs: localTimeMs(2026, 11, 23, 23, 10),
      lastUserForegroundAtMs: null,
    });
    expect(nightActive.status.state).toBe("throttled");
    expect(nightActive.status.effectivePatrolIntervalSec).toBe(600);
    expect(nightActive.allowPatrol).toBe(true);
    expect(nightActive.allowSemanticTriage).toBe(false);
    expect(nightActive.allowProactiveWakeup).toBe(false);
    expect(nightActive.allowUrgentWakeup).toBe(false);

    const nightIdleAutoHibernate = evaluateMainChatNightMode({
      settings,
      nowMs: localTimeMs(2026, 11, 23, 23, 45),
      hasActiveFleetWork: false,
      lastActivityAtMs: localTimeMs(2026, 11, 23, 23, 10),
      lastUserForegroundAtMs: null,
    });
    expect(nightIdleAutoHibernate.status.state).toBe("hibernating");
    expect(nightIdleAutoHibernate.allowPatrol).toBe(false);
    expect(nightIdleAutoHibernate.allowIdlePrecompaction).toBe(false);

    const morning = evaluateMainChatNightMode({
      settings,
      nowMs: localTimeMs(2026, 11, 24, 8, 5),
      hasActiveFleetWork: false,
      lastActivityAtMs: localTimeMs(2026, 11, 23, 23, 10),
      lastUserForegroundAtMs: null,
    });
    expect(morning.status.state).toBe("active");
    expect(morning.allowPatrol).toBe(true);
    expect(morning.allowSemanticTriage).toBe(true);
    expect(morning.allowProactiveWakeup).toBe(true);
  });

  it("reports disabled power state when Main Chat is globally turned off", () => {
    const settings = createDefaultMainChatSettings("proactive");
    settings.enabled = false;
    const evaluated = evaluateMainChatNightMode({
      settings,
      nowMs: localTimeMs(2026, 11, 23, 14, 0),
      hasActiveFleetWork: true,
      lastActivityAtMs: localTimeMs(2026, 11, 23, 14, 0),
      lastUserForegroundAtMs: null,
    });
    expect(evaluated.status.state).toBe("disabled");
    expect(evaluated.allowPatrol).toBe(false);
    expect(evaluated.nextTimerDelayMs).toBeNull();
  });
});

describe("main-chat store token usage persistence", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-mc-usage-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("aggregates today, 7-day, all-time, source, and model token stats across reloads", async () => {
    let nowMs = localTimeMs(2026, 11, 15, 10, 0);
    const store = createMainChatStore(tempDir, { now: () => nowMs });
    await store.load();

    // 8 days before Nov 23 -> should be in allTime, NOT in last7Days on Nov 23.
    await store.recordTokenUsage({
      source: "foreground",
      provider: "claude",
      model: "claude-opus-4-6",
      inputTokens: 1000,
      cachedInputTokens: 2000,
      outputTokens: 500,
      costUsd: 0.12,
      atMs: nowMs,
    });

    nowMs = localTimeMs(2026, 11, 21, 14, 0);
    await store.recordTokenUsage({
      source: "background",
      provider: "claude",
      model: "claude-opus-4-6",
      inputTokens: 400,
      cachedInputTokens: 600,
      outputTokens: 200,
      costUsd: 0.04,
      atMs: nowMs,
    });

    nowMs = localTimeMs(2026, 11, 23, 16, 0);
    await store.recordTokenUsage({
      source: "triage",
      provider: "codex",
      model: "gpt-5-mini",
      inputTokens: 300,
      cachedInputTokens: 0,
      outputTokens: 100,
      costUsd: 0.01,
      atMs: nowMs,
    });

    // Reload from disk to verify persistence.
    const reloaded = createMainChatStore(tempDir, { now: () => nowMs });
    await reloaded.load();
    const summary = reloaded.getTokenUsageSummary(nowMs);

    expect(summary.today.turns).toBe(1);
    expect(summary.today.totalTokens).toBe(400);
    expect(summary.last7Days.turns).toBe(2);
    expect(summary.last7Days.totalTokens).toBe(1600);
    expect(summary.allTime.turns).toBe(3);
    expect(summary.allTime.totalTokens).toBe(5100);
    expect(summary.bySource.foreground.totalTokens).toBe(3500);
    expect(summary.bySource.background.totalTokens).toBe(1200);
    expect(summary.bySource.triage.totalTokens).toBe(400);
    expect(summary.byModel).toHaveLength(2);
    expect(summary.byModel[0]?.provider).toBe("claude");
    expect(summary.byModel[0]?.totalTokens).toBe(4700);

    const cleared = await reloaded.resetTokenUsage();
    expect(cleared.allTime.totalTokens).toBe(0);
    expect(cleared.daily).toHaveLength(0);
  });
});

describe("main-chat global disable, night hibernation, and turn token accounting", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-mc-svc-night-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeServiceHarness(initialNowMs: number) {
    let currentNowMs = initialNowMs;
    const agents = new Map<string, ManagedAgent>();
    const workspaces = new Map<string, PersistedWorkspaceRecord>();
    let subscriber: ((event: AgentManagerEvent) => void) | null = null;
    let idSeq = 1;

    const agentManager = {
      listAgents: vi.fn(() => Array.from(agents.values())),
      getAgent: vi.fn((id: string) => agents.get(id) ?? null),
      getTimeline: vi.fn(() => []),
      hasInFlightRun: vi.fn(() => false),
      createAgent: vi.fn(async (config, requestedId, options) => {
        const id = requestedId ?? `ag_${idSeq++}`;
        const agent = {
          id,
          provider: config.provider,
          cwd: config.cwd,
          workspaceId: options?.workspaceId ?? null,
          config,
          labels: options?.labels ?? {},
          lifecycle: "idle",
          pendingPermissions: new Map(),
          background: options?.background === true,
          internal: config.internal === true,
          createdAt: new Date(currentNowMs),
          updatedAt: new Date(currentNowMs),
        } as unknown as ManagedAgent;
        agents.set(id, agent);
        return agent;
      }),
      subscribe: vi.fn((fn: (event: AgentManagerEvent) => void) => {
        subscriber = fn;
        return () => {
          if (subscriber === fn) subscriber = null;
        };
      }),
      streamAgent: vi.fn(async function* () {
        yield* [];
      }),
      updateAgentMetadata: vi.fn(async () => undefined),
      cancelAgent: vi.fn(async () => undefined),
    } as unknown as AgentManager;

    const agentStorage = {
      get: vi.fn(async () => null),
      listActive: vi.fn(async () => []),
      upsert: vi.fn(async () => undefined),
    } as unknown as AgentStorage;

    const workspaceRegistry = {
      listActive: vi.fn(async () => Array.from(workspaces.values())),
      get: vi.fn(async (id: string) => workspaces.get(id) ?? null),
      update: vi.fn(async () => null),
    } as unknown as WorkspaceRegistry;

    const providerSnapshotManager = {
      getSnapshot: vi.fn(() => ({
        records: [
          {
            entry: {
              provider: "claude",
              enabled: true,
              status: "available",
              models: [{ id: "claude-opus-4-6", isDefault: true }],
              defaultModeId: "default",
              modes: [{ id: "default", label: "Default" }],
            },
          },
        ],
      })),
      listProviders: vi.fn(async () => []),
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

    const service = createMainChatService({
      paseoHome: tempDir,
      serverId: "srv_local",
      agentManager,
      agentStorage,
      providerSnapshotManager,
      workspaceRegistry,
      createDirectoryWorkspace: async (cwd, title) => {
        const workspaceId = `ws_${idSeq++}`;
        const record: PersistedWorkspaceRecord = {
          workspaceId,
          projectId: "proj_main",
          cwd,
          title,
          createdAt: new Date(currentNowMs).toISOString(),
          updatedAt: new Date(currentNowMs).toISOString(),
          archivedAt: null,
          background: false,
        } as unknown as PersistedWorkspaceRecord;
        workspaces.set(workspaceId, record);
        return record;
      },
      logger: pino({ level: "silent" }),
      now: () => currentNowMs,
      stalledCheckIntervalMs: 60_000,
    });

    return {
      service,
      agents,
      emit: (event: AgentManagerEvent) => subscriber?.(event),
      setNowMs: (ms: number) => {
        currentNowMs = ms;
      },
    };
  }

  it("blocks ensureMainChat and pauses runtime when disabled, then resumes cleanly when re-enabled", async () => {
    const harness = makeServiceHarness(localTimeMs(2026, 11, 23, 14, 0));
    await harness.service.start();

    await harness.service.updateSettings({ enabled: false });
    expect(harness.service.getNightModeStatus().state).toBe("disabled");
    await expect(harness.service.ensureMainChat()).rejects.toThrow("已在设置中关闭");

    const skippedPatrol = await harness.service.triggerPatrol({ forceWakeup: true });
    expect(skippedPatrol.wokeMainChat).toBe(false);
    expect(skippedPatrol.summary).toContain("已关闭");

    await harness.service.updateSettings({ enabled: true });
    expect(harness.service.getNightModeStatus().state).toBe("active");
    const ensured = await harness.service.ensureMainChat();
    expect(ensured.created).toBe(true);

    harness.service.stop();
  });

  it("records foreground, direction, and OpenCode cumulative-cost delta usage via RPC", async () => {
    const harness = makeServiceHarness(localTimeMs(2026, 11, 23, 15, 0));
    await harness.service.start();

    const main = await harness.service.ensureMainChat();
    const mainAgent = harness.agents.get(main.agentId)!;
    mainAgent.labels[MAIN_CHAT_ROLE_LABEL] = MAIN_CHAT_ROLE_VALUE;

    // Foreground Claude turn on Main Chat
    harness.emit({
      type: "agent_stream",
      agentId: main.agentId,
      event: { type: "turn_started", provider: "claude" },
    });
    harness.emit({
      type: "agent_stream",
      agentId: main.agentId,
      event: {
        type: "turn_completed",
        provider: "claude",
        usage: {
          inputTokens: 1500,
          cachedInputTokens: 4500,
          outputTokens: 600,
          totalCostUsd: 0.08,
        },
      },
    });

    // Direction conversation using OpenCode (cumulative totalCostUsd across 2 turns)
    const dirAgentId = "ag_dir_1";
    harness.agents.set(dirAgentId, {
      id: dirAgentId,
      provider: "opencode",
      cwd: tempDir,
      workspaceId: main.workspaceId,
      config: { provider: "opencode", cwd: tempDir, model: "gpt-5" },
      labels: { [MAIN_CHAT_CONVERSATION_ID_LABEL]: "conv_dir_1" },
      lifecycle: "idle",
      pendingPermissions: new Map(),
      background: false,
      internal: false,
      createdAt: new Date(localTimeMs(2026, 11, 23, 15, 0)),
      updatedAt: new Date(localTimeMs(2026, 11, 23, 15, 0)),
    } as unknown as ManagedAgent);

    harness.emit({
      type: "agent_stream",
      agentId: dirAgentId,
      event: {
        type: "turn_completed",
        provider: "opencode",
        usage: { inputTokens: 800, outputTokens: 200, totalCostUsd: 0.05 },
      },
    });
    harness.emit({
      type: "agent_stream",
      agentId: dirAgentId,
      event: {
        type: "turn_completed",
        provider: "opencode",
        usage: { inputTokens: 900, outputTokens: 300, totalCostUsd: 0.11 },
      },
    });

    // Allow async store persistence queue to flush.
    await new Promise((resolve) => setTimeout(resolve, 40));

    const sent: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      harness.service,
      { type: "main_chat.get_usage.request", requestId: "req_u1" },
      (msg) => sent.push(msg),
    );
    const usageResp = sent[0];
    expect(usageResp?.type).toBe("main_chat.get_usage.response");
    if (usageResp?.type === "main_chat.get_usage.response") {
      expect(usageResp.payload.usage?.today.turns).toBe(3);
      expect(usageResp.payload.usage?.bySource.foreground.totalTokens).toBe(6600);
      expect(usageResp.payload.usage?.bySource.direction.totalTokens).toBe(2200);
      // 0.08 (claude) + 0.05 (opencode turn 1) + 0.06 (opencode turn 2 delta) = 0.19
      expect(usageResp.payload.usage?.today.costUsd).toBeCloseTo(0.19, 5);
    }

    await handleMainChatSessionMessage(
      harness.service,
      { type: "main_chat.reset_usage.request", requestId: "req_u2" },
      (msg) => sent.push(msg),
    );
    const resetResp = sent[1];
    expect(resetResp?.type).toBe("main_chat.reset_usage.response");
    if (resetResp?.type === "main_chat.reset_usage.response") {
      expect(resetResp.payload.usage?.allTime.totalTokens).toBe(0);
    }

    harness.service.stop();
  });

  it("hibernates during configured night window and returns live nightModeStatus via settings RPC", async () => {
    const harness = makeServiceHarness(localTimeMs(2026, 11, 24, 2, 0));
    await harness.service.start();

    const sent: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      harness.service,
      {
        type: "main_chat.update_settings.request",
        requestId: "req_s1",
        patch: {
          nightMode: {
            enabled: true,
            startHour: 23,
            endHour: 8,
            behavior: "hibernate",
          },
        },
      },
      (msg) => sent.push(msg),
    );
    const settingsResp = sent[0];
    expect(settingsResp?.type).toBe("main_chat.update_settings.response");
    if (settingsResp?.type === "main_chat.update_settings.response") {
      expect(settingsResp.payload.nightModeStatus?.state).toBe("hibernating");
      expect(settingsResp.payload.nightModeStatus?.inNightWindow).toBe(true);
    }

    // Advance clock to morning 08:15 -> automatically reports active again.
    harness.setNowMs(localTimeMs(2026, 11, 24, 8, 15));
    expect(harness.service.getNightModeStatus().state).toBe("active");

    harness.service.stop();
  });
});
