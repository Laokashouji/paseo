import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_CHAT_TASK_QUIET_LABEL,
  MAIN_CHAT_TASK_RECORD_ID_LABEL,
  type MainChatAutoStartRule,
  type MainChatDurationSample,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentSessionConfig } from "../agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { FinishSubscriptions } from "../agent/finish-subscriptions/index.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import type { SessionOutboundMessage } from "../messages.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";
import { buildMainChatSystemPrompt } from "./prompts.js";
import { createMainChatService } from "./service.js";
import { handleMainChatSessionMessage } from "./session.js";
import { createMainChatStore } from "./store.js";
import {
  DURATION_SAMPLE_WINDOW_DAYS,
  MAX_RETAINED_DURATION_SAMPLES,
  MAX_RETAINED_RECEIPTS,
  TaskBriefValidationError,
  applyTaskScopeUpdate,
  computeMedian,
  estimateExpectedMinutes,
  isCwdCoveredByTrustRule,
  matchesTrustRule,
  pruneDurationSamples,
  validateTaskBriefInput,
} from "./task-ledger.js";
import { registerMainChatTools } from "./tools.js";

function createTestLogger() {
  return pino({ level: "silent" });
}

interface FakeCreateOptions {
  workspaceId?: string;
  labels?: Record<string, string>;
  initialTitle?: string | null;
  background?: boolean;
}

describe("task-ledger pure kernel", () => {
  it("validates write/readonly Brief rules and bumps scopeRevision strictly", () => {
    expect(() =>
      validateTaskBriefInput({
        title: "改代码",
        goal: "修复路由 Bug",
        mode: "write",
        doneWhen: [],
      }),
    ).toThrow(TaskBriefValidationError);

    expect(() =>
      validateTaskBriefInput({
        title: "改代码",
        goal: "修复路由 Bug",
        mode: "write",
        doneWhen: ["   ", ""],
      }),
    ).toThrow(/doneWhen/);

    expect(() =>
      validateTaskBriefInput({
        title: "调研模块",
        goal: "   ",
        mode: "readonly",
      }),
    ).toThrow(/goal/);

    const readonlyBrief = validateTaskBriefInput({
      title: "调研模块",
      goal: "理清主对话启动链路",
      mode: "readonly",
    });
    expect(readonlyBrief).toEqual({
      goal: "理清主对话启动链路",
      doneWhen: [],
      outOfBounds: [],
    });

    const baseTask: MainChatTaskRecord = {
      id: "task_1",
      mainAgentId: "agent_main",
      planId: "plan_1",
      title: "重构账本",
      mode: "write",
      isolation: "local",
      cwd: "/tmp/repo",
      workspaceId: "ws_1",
      workspaceLabel: "repo",
      status: "running",
      brief: {
        goal: "实现初版台账",
        doneWhen: ["单测通过"],
        outOfBounds: ["不改协议"],
        scopeRevision: 1,
        updatedAt: "2026-11-01T00:00:00.000Z",
      },
      agentIds: ["agent_1"],
      activeAgentId: "agent_1",
      lastActivityAt: "2026-11-01T00:00:00.000Z",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };

    expect(() =>
      applyTaskScopeUpdate(baseTask, { doneWhen: [] }, "2026-11-01T01:00:00.000Z"),
    ).toThrow(/doneWhen/);

    expect(() => applyTaskScopeUpdate(baseTask, {}, "2026-11-01T01:00:00.000Z")).toThrow(
      TaskBriefValidationError,
    );

    const updated = applyTaskScopeUpdate(
      baseTask,
      {
        goal: "实现完整 M3 任务台账",
        doneWhen: ["单测通过", "typecheck 通过"],
        outOfBounds: ["不改协议", "不重启线上 daemon"],
      },
      "2026-11-01T02:00:00.000Z",
    );
    expect(updated.task.brief.scopeRevision).toBe(2);
    expect(updated.task.brief.updatedAt).toBe("2026-11-01T02:00:00.000Z");
    expect(updated.task.brief.doneWhen).toEqual(["单测通过", "typecheck 通过"]);
    expect(updated.changedFields).toEqual(["goal", "doneWhen", "outOfBounds"]);
  });

  it("enforces host × cwd × mode trust matching with safe directory prefix boundaries", () => {
    expect(isCwdCoveredByTrustRule("/repo", "/repo", true)).toBe(true);
    expect(isCwdCoveredByTrustRule("/repo/", "/repo", true)).toBe(true);
    expect(isCwdCoveredByTrustRule("/repo", "/repo/packages/app", true)).toBe(true);
    expect(isCwdCoveredByTrustRule("/repo", "/repo/..foo", true)).toBe(true);
    expect(isCwdCoveredByTrustRule("/repo", "/repo-other", true)).toBe(false);
    expect(isCwdCoveredByTrustRule("/repo", "/repo-other/packages/app", true)).toBe(false);
    expect(isCwdCoveredByTrustRule("/repo", "/repo/packages/app", false)).toBe(false);

    const hostARule: MainChatAutoStartRule = {
      id: "trust_a",
      cwd: "/repo",
      mode: "write",
      serverId: "srv_host_a",
      allowSubdirectories: true,
      createdAt: "2026-11-01T00:00:00.000Z",
    };
    const legacyLocalRule: MainChatAutoStartRule = {
      id: "trust_legacy",
      cwd: "/repo",
      mode: "write",
      createdAt: "2026-11-01T00:00:00.000Z",
    };
    const exactOnlyRule: MainChatAutoStartRule = {
      id: "trust_exact",
      cwd: "/repo",
      mode: "write",
      serverId: "srv_host_a",
      allowSubdirectories: false,
      createdAt: "2026-11-01T00:00:00.000Z",
    };

    expect(
      matchesTrustRule(hostARule, {
        cwd: "/repo/packages/app",
        mode: "write",
        serverId: "srv_host_a",
        localServerId: "srv_local",
      }),
    ).toBe(true);
    expect(
      matchesTrustRule(hostARule, {
        cwd: "/repo-other",
        mode: "write",
        serverId: "srv_host_a",
        localServerId: "srv_local",
      }),
    ).toBe(false);
    expect(
      matchesTrustRule(hostARule, {
        cwd: "/repo/packages/app",
        mode: "write",
        serverId: "srv_host_b",
        localServerId: "srv_local",
      }),
    ).toBe(false);
    expect(
      matchesTrustRule(hostARule, {
        cwd: "/repo/packages/app",
        mode: "readonly",
        serverId: "srv_host_a",
        localServerId: "srv_local",
      }),
    ).toBe(false);

    // Legacy rule (serverId == null) matches local host ONLY, never a remote host.
    expect(
      matchesTrustRule(legacyLocalRule, {
        cwd: "/repo/sub",
        mode: "write",
        serverId: "srv_local",
        localServerId: "srv_local",
      }),
    ).toBe(true);
    expect(
      matchesTrustRule(legacyLocalRule, {
        cwd: "/repo/sub",
        mode: "write",
        serverId: null,
        localServerId: "srv_local",
      }),
    ).toBe(true);
    expect(
      matchesTrustRule(legacyLocalRule, {
        cwd: "/repo/sub",
        mode: "write",
        serverId: "srv_remote",
        localServerId: "srv_local",
      }),
    ).toBe(false);

    // allowSubdirectories === false disables prefix matching.
    expect(
      matchesTrustRule(exactOnlyRule, {
        cwd: "/repo",
        mode: "write",
        serverId: "srv_host_a",
        localServerId: "srv_local",
      }),
    ).toBe(true);
    expect(
      matchesTrustRule(exactOnlyRule, {
        cwd: "/repo/sub",
        mode: "write",
        serverId: "srv_host_a",
        localServerId: "srv_local",
      }),
    ).toBe(false);
  });

  it("estimates expectedMinutes with 90-day window, 5-sample minimum, 3-tier fallback, recent-32 median, and 256 cap", () => {
    const baseMs = Date.parse("2026-11-23T12:00:00.000Z");
    const makeSample = (
      id: string,
      overrides: Partial<MainChatDurationSample>,
    ): MainChatDurationSample => ({
      id,
      serverId: "srv_a",
      cwd: "/repo/app",
      mode: "write",
      role: "worker",
      provider: "claude",
      durationMinutes: 10,
      completedAt: new Date(baseMs - 60_000).toISOString(),
      ...overrides,
    });

    // < 5 samples returns null
    const fourSamples = Array.from({ length: 4 }, (_, i) =>
      makeSample(`s_${i}`, { durationMinutes: 10 + i }),
    );
    expect(
      estimateExpectedMinutes(
        fourSamples,
        { serverId: "srv_a", cwd: "/repo/app", mode: "write", provider: "claude" },
        baseMs,
      ),
    ).toBeNull();

    // Expired samples (> 90 days) are ignored
    const expiredSamples = Array.from({ length: 6 }, (_, i) =>
      makeSample(`exp_${i}`, {
        durationMinutes: 25,
        completedAt: new Date(
          baseMs - (DURATION_SAMPLE_WINDOW_DAYS + 2) * 24 * 60 * 60 * 1000 - i * 1000,
        ).toISOString(),
      }),
    );
    expect(
      estimateExpectedMinutes(
        expiredSamples,
        { serverId: "srv_a", cwd: "/repo/app", mode: "write", provider: "claude" },
        baseMs,
      ),
    ).toBeNull();

    // 3-tier fallback priority:
    // Tier 1 (srv_a + /repo/app + write): 5 samples median = 8
    // Tier 2 (srv_a + /repo/other + write): 5 samples median = 20
    // Tier 3 (srv_b + /repo/x + write + claude): 5 samples median = 40
    const tierSamples: MainChatDurationSample[] = [
      ...[6, 7, 8, 9, 50].map((m, i) =>
        makeSample(`t1_${i}`, { serverId: "srv_a", cwd: "/repo/app", durationMinutes: m }),
      ),
      ...[18, 19, 20, 21, 90].map((m, i) =>
        makeSample(`t2_${i}`, { serverId: "srv_a", cwd: "/repo/other", durationMinutes: m }),
      ),
      ...[38, 39, 40, 41, 120].map((m, i) =>
        makeSample(`t3_${i}`, {
          serverId: "srv_b",
          cwd: "/repo/x",
          provider: "claude/claude-sonnet-5-5",
          durationMinutes: m,
        }),
      ),
    ];

    // Hits Tier 1
    expect(
      estimateExpectedMinutes(
        tierSamples,
        { serverId: "srv_a", cwd: "/repo/app", mode: "write", provider: "claude" },
        baseMs,
      ),
    ).toBe(8);

    // Misses Tier 1 (/repo/new has 0), hits Tier 2 (srv_a has 10 total: 6,7,8,9,18,19,20,21,50,90 -> median (18+19)/2 = 18.5 -> 19)
    expect(
      estimateExpectedMinutes(
        tierSamples,
        { serverId: "srv_a", cwd: "/repo/new", mode: "write", provider: "claude" },
        baseMs,
      ),
    ).toBe(19);

    // Misses Tier 1 & Tier 2 (srv_c has 0), hits Tier 3 (all 15 write+claude samples:
    // [6,7,8,9,18,19,20,21,38,39,40,41,50,90,120] -> 8th item = 21)
    expect(
      estimateExpectedMinutes(
        tierSamples,
        { serverId: "srv_c", cwd: "/repo/new", mode: "write", provider: "claude" },
        baseMs,
      ),
    ).toBe(21);

    // Different provider on srv_c misses Tier 3 -> null
    expect(
      estimateExpectedMinutes(
        tierSamples,
        { serverId: "srv_c", cwd: "/repo/new", mode: "write", provider: "codex" },
        baseMs,
      ),
    ).toBeNull();

    // Recent-32 window: 10 older outliers (200 min) + 32 recent samples (12 min) -> median must be 12
    const recent32Samples: MainChatDurationSample[] = [
      ...Array.from({ length: 10 }, (_, i) =>
        makeSample(`old_${i}`, {
          durationMinutes: 200,
          completedAt: new Date(baseMs - (50 - i) * 60_000).toISOString(),
        }),
      ),
      ...Array.from({ length: 32 }, (_, i) =>
        makeSample(`new_${i}`, {
          durationMinutes: 12,
          completedAt: new Date(baseMs - (32 - i) * 60_000).toISOString(),
        }),
      ),
    ];
    expect(
      estimateExpectedMinutes(
        recent32Samples,
        { serverId: "srv_a", cwd: "/repo/app", mode: "write", provider: "claude" },
        baseMs,
      ),
    ).toBe(12);

    // 256 cap pruning keeps the newest 256 samples
    const overflow = Array.from({ length: 280 }, (_, i) =>
      makeSample(`cap_${i}`, {
        durationMinutes: i + 1,
        completedAt: new Date(baseMs - (280 - i) * 1_000).toISOString(),
      }),
    );
    const pruned = pruneDurationSamples(overflow, baseMs);
    expect(pruned).toHaveLength(MAX_RETAINED_DURATION_SAMPLES);
    expect(pruned[0]?.id).toBe("cap_24");
    expect(pruned.at(-1)?.id).toBe("cap_279");

    // Median helper checks
    expect(computeMedian([5, 1, 9])).toBe(5);
    expect(computeMedian([2, 4, 6, 8])).toBe(5);
  });
});

describe("task-ledger store persistence & legacy JSON backward compatibility", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-task-ledger-store-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads legacy v1 JSON cleanly without tasks/durationSamples and enforces receipt/sample caps", async () => {
    const mainChatDir = path.join(tempDir, "main-chat");
    await mkdir(mainChatDir, { recursive: true });
    await writeFile(
      path.join(mainChatDir, "state.json"),
      JSON.stringify(
        {
          version: 1,
          plans: {},
          decisions: {},
          trustRules: [
            {
              id: "legacy_trust",
              cwd: "/tmp/legacy-repo",
              mode: "write",
              createdAt: "2026-10-01T00:00:00.000Z",
            },
          ],
          metrics: { plansCreated: 3 },
        },
        null,
        2,
      ),
      "utf8",
    );

    const fixedNow = Date.parse("2026-11-23T12:00:00.000Z");
    const store = createMainChatStore(tempDir, { now: () => fixedNow });
    await store.load();

    expect(store.listTasks()).toEqual([]);
    expect(store.listDurationSamples()).toEqual([]);
    expect(store.getMetrics().plansCreated).toBe(3);
    expect(
      store.hasTrustRule("/tmp/legacy-repo/packages/app", "write", {
        serverId: "srv_local",
        localServerId: "srv_local",
      }),
    ).toBe(true);
    expect(
      store.hasTrustRule("/tmp/legacy-repo/packages/app", "write", {
        serverId: "srv_remote",
        localServerId: "srv_local",
      }),
    ).toBe(false);

    for (let i = 1; i <= 115; i += 1) {
      await store.addReceipt(
        {
          title: `回执 #${i}`,
          summary: `完成 #${i}`,
          agentId: `a_${i}`,
          planId: null,
          taskId: `t_${i}`,
          checks: [],
          nextSteps: [],
        },
        "agent_main",
      );
    }

    const reloaded = createMainChatStore(tempDir, { now: () => fixedNow });
    await reloaded.load();
    const receipts = reloaded.listReceipts("agent_main");
    expect(receipts).toHaveLength(MAX_RETAINED_RECEIPTS);
    expect(receipts[0]?.title).toBe("回执 #115");
    expect(receipts.at(-1)?.title).toBe("回执 #16");

    // Verify 256 duration sample cap persists cleanly across reloads
    for (let i = 1; i <= 270; i += 1) {
      await reloaded.addDurationSample({
        id: `dur_${i}`,
        serverId: "srv_local",
        cwd: "/tmp/legacy-repo",
        mode: "write",
        role: "worker",
        provider: "claude",
        durationMinutes: i,
        completedAt: new Date(fixedNow - (270 - i) * 1_000).toISOString(),
      });
    }
    const reloadedAgain = createMainChatStore(tempDir, { now: () => fixedNow });
    await reloadedAgain.load();
    const samples = reloadedAgain.listDurationSamples();
    expect(samples).toHaveLength(MAX_RETAINED_DURATION_SAMPLES);
    expect(samples[0]?.id).toBe("dur_15");
    expect(samples.at(-1)?.id).toBe("dur_270");
  });
});

describe("task-ledger service, MCP tools, and session RPC end-to-end", () => {
  let tempDir: string;
  let repoDir: string;
  let subRepoDir: string;
  let siblingRepoDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-task-ledger-svc-"));
    repoDir = path.join(tempDir, "repo");
    subRepoDir = path.join(repoDir, "packages", "app");
    siblingRepoDir = path.join(tempDir, "repo-other");
    await mkdir(subRepoDir, { recursive: true });
    await mkdir(siblingRepoDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function makeLedgerHarness(options?: { initialNowMs?: number }) {
    let nowMs = options?.initialNowMs ?? Date.parse("2026-11-23T10:00:00.000Z");
    const agents = new Map<string, ManagedAgent>();
    const storedAgents = new Map<string, StoredAgentRecord>();
    const workspaces = new Map<string, PersistedWorkspaceRecord>();
    const sentPrompts: Array<{ agentId: string; prompt: string }> = [];
    const cancelledAgentIds: string[] = [];
    const callOrder: string[] = [];
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
        createdAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      };
      workspaces.set(id, record);
      return record;
    };

    const agentManager = {
      listAgents: () => Array.from(agents.values()),
      getAgent: (id: string) => agents.get(id) ?? null,
      subscribe: () => () => undefined,
      createAgent: vi.fn(
        async (config: AgentSessionConfig, requestedId?: string, opts?: FakeCreateOptions) => {
          const id = requestedId ?? `agent_${nextId++}`;
          callOrder.push(`create:${id}`);
          const labels = opts?.labels ? { ...opts.labels } : {};
          const managed = {
            id,
            provider: config.provider,
            cwd: config.cwd,
            workspaceId: opts?.workspaceId,
            config: { ...config },
            labels,
            metadata: {},
            lifecycle: "running",
            attention: { requiresAttention: false },
            currentModeId: config.modeId ?? null,
            availableModes: [],
            pendingPermissions: new Map(),
            internal: config.internal === true,
            background: opts?.background === true,
            updatedAt: new Date(nowMs),
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
            workspaceId: opts?.workspaceId,
            createdAt: new Date(nowMs).toISOString(),
            updatedAt: new Date(nowMs).toISOString(),
            title: opts?.initialTitle ?? config.title ?? null,
            labels: { ...labels },
            lastStatus: "running",
            lastModeId: config.modeId ?? null,
            config: {
              model: config.model ?? null,
              modeId: config.modeId ?? null,
              thinkingOptionId: config.thinkingOptionId ?? null,
            },
            background: opts?.background === true,
          } as unknown as StoredAgentRecord);
          return managed;
        },
      ),
      cancelAgentRun: vi.fn(async (agentId: string) => {
        callOrder.push(`cancel:${agentId}`);
        cancelledAgentIds.push(agentId);
        const live = agents.get(agentId) as (ManagedAgent & { lifecycle: string }) | undefined;
        if (live) {
          live.lifecycle = "idle";
        }
        return { status: "canceled" as const };
      }),
      archiveAgent: vi.fn(async (agentId: string) => {
        const archivedAt = new Date(nowMs).toISOString();
        agents.delete(agentId);
        const stored = storedAgents.get(agentId) as
          | (StoredAgentRecord & { archivedAt?: string })
          | undefined;
        if (stored) stored.archivedAt = archivedAt;
        return { archivedAt };
      }),
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
        sentPrompts.push({ agentId, prompt: String(prompt) });
        promptStart?.bind?.({
          start: { status: "started" },
          turnStartedPromise: Promise.resolve(),
          settledPromise: Promise.resolve(),
        });
        yield { type: "turn_started", provider: "claude" };
        yield { type: "turn_completed", provider: "claude" };
      }),
      respondToPermission: vi.fn(),
      getTimeline: vi.fn(() => []),
      updateAgentMetadata: vi.fn(
        async (agentId: string, update: { title?: string; labels?: Record<string, string> }) => {
          const live = agents.get(agentId) as
            | (ManagedAgent & { config: { title?: string }; labels: Record<string, string> })
            | undefined;
          if (live) {
            if (update.title) live.config.title = update.title;
            if (update.labels) live.labels = { ...update.labels };
          }
          const stored = storedAgents.get(agentId) as
            | (StoredAgentRecord & { title?: string | null; labels?: Record<string, string> })
            | undefined;
          if (stored) {
            if (update.title) stored.title = update.title;
            if (update.labels) stored.labels = { ...update.labels };
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
      register: vi.fn(async () => ({
        accept: vi.fn(),
        reject: vi.fn(async () => undefined),
      })),
    } as unknown as FinishSubscriptions;

    const service = createMainChatService({
      paseoHome: tempDir,
      serverId: "srv_local",
      agentManager,
      agentStorage,
      providerSnapshotManager,
      workspaceRegistry,
      createDirectoryWorkspace: async (cwd, title, _projectId, context) =>
        createWorkspaceRecord(cwd, title, context?.background === true),
      finishSubscriptions: () => finishSubscriptions,
      logger: createTestLogger(),
      now: () => nowMs,
      stalledCheckIntervalMs: 60_000,
    });

    return {
      service,
      agentManager,
      agents,
      storedAgents,
      sentPrompts,
      cancelledAgentIds,
      callOrder,
      advanceMs(deltaMs: number) {
        nowMs += deltaMs;
      },
    };
  }

  it("supports updatePlanTask, withdrawPlan, Brief validation, and scope revision notice to running agent", async () => {
    const h = makeLedgerHarness();
    await h.service.start();
    const { agentId: mainAgentId } = await h.service.ensureMainChat();

    // Readonly without goal rejected; write without doneWhen rejected
    await expect(
      h.service.createPlan(mainAgentId, {
        tasks: [{ title: "排查", goal: "   ", mode: "readonly", cwd: repoDir }],
      }),
    ).rejects.toThrow(/goal/);
    await expect(
      h.service.createPlan(mainAgentId, {
        tasks: [{ title: "改代码", goal: "修复崩溃", mode: "write", cwd: repoDir }],
      }),
    ).rejects.toThrow(/doneWhen/);

    // Create open write plan and inline-edit it via updatePlanTask
    const openPlan = await h.service.createPlan(mainAgentId, {
      summary: "修复任务台账",
      tasks: [
        {
          title: "初版标题",
          goal: "初版目标",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["单测通过"],
        },
      ],
    });
    expect(openPlan.status).toBe("open");
    expect(openPlan.tasks[0]?.quiet).toBe(true);
    const plannedTaskId = openPlan.tasks[0]!.id;

    // Cannot wipe doneWhen on a write task
    await expect(
      h.service.updatePlanTask(openPlan.id, plannedTaskId, { doneWhen: [] }),
    ).rejects.toThrow(/doneWhen/);

    const edited = await h.service.updatePlanTask(openPlan.id, plannedTaskId, {
      title: "更新后标题",
      goal: "更新后目标",
      cwd: subRepoDir,
      doneWhen: ["单测通过", "lint 通过"],
      outOfBounds: ["不改 packages/app"],
      quiet: false,
    });
    expect(edited.tasks[0]?.title).toBe("更新后标题");
    expect(edited.tasks[0]?.goal).toBe("更新后目标");
    expect(edited.tasks[0]?.cwd).toBe(path.resolve(subRepoDir));
    expect(edited.tasks[0]?.doneWhen).toEqual(["单测通过", "lint 通过"]);
    expect(edited.tasks[0]?.quiet).toBe(false);

    // Withdraw a second open plan cleanly and confirm it cannot be started or edited
    const obsoletePlan = await h.service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "旧计划",
          goal: "已过时的重构",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["构建通过"],
        },
      ],
    });
    const withdrawn = await h.service.withdrawPlan(obsoletePlan.id, "需求已在另一分支完成");
    expect(withdrawn.status).toBe("withdrawn");
    expect(withdrawn.withdrawnAt).toBeTruthy();
    expect(withdrawn.withdrawReason).toBe("需求已在另一分支完成");
    await expect(h.service.startPlan(obsoletePlan.id)).rejects.toThrow(/撤回/);
    await expect(
      h.service.updatePlanTask(obsoletePlan.id, obsoletePlan.tasks[0]!.id, { title: "再改" }),
    ).rejects.toThrow(/open/);

    // Start the edited plan -> creates task record & sets quiet/record labels
    const started = await h.service.startPlan(openPlan.id);
    const firstAgentId = started.tasks[0]!.agentId!;
    const taskId = started.tasks[0]!.taskRecordId!;
    expect(h.agents.get(firstAgentId)?.labels[MAIN_CHAT_TASK_RECORD_ID_LABEL]).toBe(taskId);
    expect(h.agents.get(firstAgentId)?.labels[MAIN_CHAT_TASK_QUIET_LABEL]).toBe("false");

    // Started plan rejects updatePlanTask and withdrawPlan
    await expect(
      h.service.updatePlanTask(openPlan.id, plannedTaskId, { title: "不能改" }),
    ).rejects.toThrow(/open/);
    await expect(h.service.withdrawPlan(openPlan.id, "太晚了")).rejects.toThrow(/open/);

    // updateTaskScope increments scopeRevision and pushes notice to running agent
    h.sentPrompts.length = 0;
    const scoped = await h.service.updateTaskScope({
      taskId,
      goal: "新增跨机隔离验证",
      doneWhen: ["单测通过", "lint 通过", "跨机隔离通过"],
      reason: "产品评审补充要求",
    });
    expect(scoped.brief.scopeRevision).toBe(2);
    expect(scoped.brief.goal).toBe("新增跨机隔离验证");
    const notice = h.sentPrompts.find((entry) => entry.agentId === firstAgentId);
    expect(notice?.prompt).toContain("Scope Revision #2");
    expect(notice?.prompt).toContain("新增跨机隔离验证");
    expect(notice?.prompt).toContain("产品评审补充要求");

    h.service.stop();
  });

  it("continues an existing task on the same card: stops old agent, appends agentIds, preserves Brief & injects settled decisions", async () => {
    const h = makeLedgerHarness();
    await h.service.start();
    const { agentId: mainAgentId } = await h.service.ensureMainChat();

    const firstPlan = await h.service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "实现缓存层",
          goal: "构建本地持久化缓存",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["输出完整方案"],
        },
      ],
    });
    const taskId = firstPlan.tasks[0]!.taskRecordId!;
    const firstAgentId = firstPlan.tasks[0]!.agentId!;

    // Ask and answer a decision linked to this task
    const decision = await h.service.askUserDecision(mainAgentId, {
      title: "缓存介质",
      question: "采用 JSON 文件还是 SQLite？",
      agentId: firstAgentId,
      taskId,
      options: [
        { id: "json", label: "原子 JSON", leadsTo: "遵循 Paseo 无数据库架构" },
        { id: "sqlite", label: "SQLite", leadsTo: "引入新依赖" },
      ],
      recommendedOptionId: "json",
    });

    // While unanswered, live task status is needs_you
    const duringAsk = await h.service.listTaskRecords({ mainAgentId });
    expect(duringAsk).toHaveLength(1);
    expect(duringAsk[0]?.status).toBe("needs_you");

    await h.service.answerDecision({
      decisionId: decision.id,
      optionId: "json",
      answer: "原子 JSON",
    });

    // Update scope to revision #2 before continuing
    await h.service.updateTaskScope({
      taskId,
      goal: "构建原子 JSON 持久化缓存",
      doneWhen: ["输出完整方案", "覆盖旧版 JSON 兼容"],
    });

    const originalCreatedAt = (await h.service.listTaskRecords({ mainAgentId }))[0]!.createdAt;
    h.callOrder.length = 0;
    h.sentPrompts.length = 0;

    // Continue on the SAME task card with a replacement agent
    const continuePlan = await h.service.createPlan(mainAgentId, {
      autoStart: true,
      tasks: [
        {
          title: "实现缓存层",
          goal: "继续完成缓存层落地",
          mode: "write",
          cwd: repoDir,
          continuesTaskId: taskId,
          continuesWhy: "切换到可写执行并更换新会话",
        },
      ],
    });
    const secondAgentId = continuePlan.tasks[0]!.agentId!;
    expect(secondAgentId).toBeTruthy();
    expect(secondAgentId).not.toBe(firstAgentId);
    expect(continuePlan.tasks[0]?.taskRecordId).toBe(taskId);

    // Must cancel old running agent BEFORE creating replacement agent
    const cancelIdx = h.callOrder.indexOf(`cancel:${firstAgentId}`);
    const createIdx = h.callOrder.indexOf(`create:${secondAgentId}`);
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(createIdx).toBeGreaterThan(cancelIdx);

    // Must NOT create duplicate task cards
    const recordsAfterContinue = await h.service.listTaskRecords({ mainAgentId });
    expect(recordsAfterContinue).toHaveLength(1);
    const continuedRecord = recordsAfterContinue[0]!;
    expect(continuedRecord.id).toBe(taskId);
    expect(continuedRecord.createdAt).toBe(originalCreatedAt);
    expect(continuedRecord.brief.scopeRevision).toBe(2);
    expect(continuedRecord.brief.goal).toBe("构建原子 JSON 持久化缓存");
    expect(continuedRecord.agentIds).toEqual([firstAgentId, secondAgentId]);
    expect(continuedRecord.activeAgentId).toBe(secondAgentId);
    expect(continuedRecord.decisions).toHaveLength(1);
    expect(continuedRecord.decisions?.[0]?.answer).toBe("原子 JSON");

    // Replacement agent initial prompt must contain original Brief + settled decisions + continuation context
    const replacementPrompt = h.sentPrompts.find(
      (entry) => entry.agentId === secondAgentId,
    )?.prompt;
    expect(replacementPrompt).toContain("Scope Revision #2");
    expect(replacementPrompt).toContain("构建原子 JSON 持久化缓存");
    expect(replacementPrompt).toContain("已拍板决策清单");
    expect(replacementPrompt).toContain("采用 JSON 文件还是 SQLite？");
    expect(replacementPrompt).toContain("原子 JSON");
    expect(replacementPrompt).toContain("切换到可写执行并更换新会话");

    // Gracefully tolerates continuing when the previous active agent has already exited / disappeared
    h.agents.delete(secondAgentId);
    const thirdPlan = await h.service.createPlan(mainAgentId, {
      autoStart: true,
      tasks: [
        {
          title: "实现缓存层",
          goal: "兜底续接",
          mode: "readonly",
          cwd: repoDir,
          continuesTaskId: taskId,
          continuesWhy: "旧进程已退出",
        },
      ],
    });
    const thirdAgentId = thirdPlan.tasks[0]!.agentId!;
    // Rejects continuing an unknown task ID
    await expect(
      h.service.createPlan(mainAgentId, {
        tasks: [
          {
            title: "无效续接",
            goal: "不存在的任务",
            mode: "readonly",
            cwd: repoDir,
            continuesTaskId: "task_does_not_exist",
          },
        ],
      }),
    ).rejects.toThrow(/找不到要续接的原任务/);

    // Supports open continuation plan followed by explicit startPlan
    const openContinuePlan = await h.service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "实现缓存层",
          goal: "显式确认后续接",
          mode: "write",
          cwd: repoDir,
          continuesTaskId: taskId,
          continuesWhy: "等待确认后切换执行",
        },
      ],
    });
    expect(openContinuePlan.status).toBe("open");
    expect(openContinuePlan.tasks[0]?.continuesTaskId).toBe(taskId);
    const startedContinue = await h.service.startPlan(openContinuePlan.id);
    const fourthAgentId = startedContinue.tasks[0]!.agentId!;
    const afterFourth = await h.service.listTaskRecords({ mainAgentId });
    expect(afterFourth).toHaveLength(1);
    expect(afterFourth[0]?.agentIds).toEqual([
      firstAgentId,
      secondAgentId,
      thirdAgentId,
      fourthAgentId,
    ]);
    expect(afterFourth[0]?.activeAgentId).toBe(fourthAgentId);

    h.service.stop();
  });

  it("enforces host × cwd × mode trust prefix auto-start and cross-host isolation in service", async () => {
    const h = makeLedgerHarness();
    await h.service.start();
    const { agentId: mainAgentId } = await h.service.ensureMainChat();

    const initialWrite = await h.service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "根仓库改动",
          goal: "新增脚本",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["脚本可执行"],
        },
      ],
    });
    expect(initialWrite.status).toBe("open");
    await h.service.startPlan(initialWrite.id, { rememberAutoStart: true });

    // Subdirectory under /repo automatically matches prefix trust rule -> auto-starts!
    const subDirPlan = await h.service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "子包改动",
          goal: "调整 app 入口",
          mode: "write",
          cwd: subRepoDir,
          doneWhen: ["单测通过"],
        },
      ],
    });
    expect(subDirPlan.status).toBe("started");
    expect(subDirPlan.autoStarted).toBe(true);

    // Sibling /repo-other MUST NOT match /repo prefix -> stays open!
    const siblingPlan = await h.service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "兄弟仓库改动",
          goal: "更新 README",
          mode: "write",
          cwd: siblingRepoDir,
          doneWhen: ["文档检查通过"],
        },
      ],
    });
    expect(siblingPlan.status).toBe("open");
    expect(siblingPlan.autoStarted).toBe(false);

    // Different host (srv_remote) on same path MUST NOT match local host rule -> stays open!
    const remoteHostPlan = await h.service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "远端主机改动",
          goal: "远端执行修复",
          mode: "write",
          serverId: "srv_remote",
          cwd: subRepoDir,
          doneWhen: ["远端单测通过"],
        },
      ],
    });
    expect(remoteHostPlan.status).toBe("open");
    expect(remoteHostPlan.autoStarted).toBe(false);

    h.service.stop();
  });

  it("handles parkTask, live status reflection, reviewTask accept+rework, duration learning, /clear migration, MCP tools & RPCs", async () => {
    const h = makeLedgerHarness();
    await h.service.start();
    const { agentId: mainAgentId } = await h.service.ensureMainChat();

    // Complete 5 tasks with known durations [10, 12, 14, 20, 40] -> median 14 min
    const durations = [10, 12, 14, 20, 40];
    for (let i = 0; i < durations.length; i += 1) {
      const plan = await h.service.createPlan(mainAgentId, {
        autoStart: true,
        tasks: [
          {
            title: `样本任务 ${i + 1}`,
            goal: "验证耗时学习",
            mode: "write",
            cwd: repoDir,
            doneWhen: ["单测通过"],
          },
        ],
      });
      const tid = plan.tasks[0]!.taskRecordId!;
      h.advanceMs(durations[i]! * 60_000);
      const accepted = await h.service.reviewTask({
        taskId: tid,
        verdict: "accept",
        summary: `样本 ${i + 1} 已完成`,
        checks: [{ criterion: "单测通过", met: true, evidence: "vitest ok" }],
        nextSteps: ["合并"],
      });
      expect(accepted.task.status).toBe("completed");
      expect(accepted.task.actualMinutes).toBe(durations[i]);
      expect(accepted.receipt?.summary).toBe(`样本 ${i + 1} 已完成`);
      expect(accepted.task.latestReceipt?.summary).toBe(`样本 ${i + 1} 已完成`);
      expect(accepted.rework).toBeNull();
    }

    // 6th task in same host + cwd + mode automatically learns expectedMinutes = 14!
    const learnedPlan = await h.service.createPlan(mainAgentId, {
      autoStart: true,
      tasks: [
        {
          title: "享受自学习估算的新任务",
          goal: "落地验收流程",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["全部测试通过"],
        },
      ],
    });
    expect(learnedPlan.tasks[0]?.expectedMinutes).toBe(14);
    const activeTaskId = learnedPlan.tasks[0]!.taskRecordId!;
    const activeChildId = learnedPlan.tasks[0]!.agentId!;

    // includeCompleted: false hides the 5 completed tasks
    const activeOnly = await h.service.listTaskRecords({
      mainAgentId,
      includeCompleted: false,
    });
    expect(activeOnly.map((t) => t.id)).toEqual([activeTaskId]);

    // Live pending permission dynamically turns status into needs_you
    h.agents.get(activeChildId)!.pendingPermissions.set("perm_1", {
      id: "perm_1",
      kind: "tool",
      name: "Bash",
    } as unknown as AgentPermissionRequest);
    const needsYouList = await h.service.listTaskRecords({
      mainAgentId,
      includeCompleted: false,
    });
    expect(needsYouList[0]?.status).toBe("needs_you");
    h.agents.get(activeChildId)!.pendingPermissions.clear();

    // Park and resume task
    const parked = await h.service.parkTask({
      taskId: activeTaskId,
      parked: true,
      reason: "等待外部评审结论",
    });
    expect(parked.status).toBe("parked");
    expect(parked.parkedAt).toBeTruthy();
    expect(parked.parkedReason).toBe("等待外部评审结论");

    const resumed = await h.service.parkTask({ taskId: activeTaskId, parked: false });
    expect(resumed.status).toBe("running");
    expect(resumed.parkedAt).toBeNull();
    expect(resumed.parkedReason).toBeNull();

    // Record a settled decision, then trigger rework via task_review MCP tool -> prompt injects decision!
    const dec = await h.service.askUserDecision(mainAgentId, {
      title: "接口命名",
      question: "采用 task_review 还是 task_verdict？",
      agentId: activeChildId,
      taskId: activeTaskId,
      options: [
        { id: "review", label: "task_review", leadsTo: "与协议保持一致" },
        { id: "verdict", label: "task_verdict", leadsTo: "需新增别名" },
      ],
    });
    await h.service.answerDecision({
      decisionId: dec.id,
      optionId: "review",
      answer: "task_review",
    });

    const tools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager: h.agentManager,
      mainChatService: h.service,
      callerAgentId: mainAgentId,
      scope: "agent",
      tools,
      builtinNames: new Set(),
    });
    expect(tools.has("task_plan_withdraw")).toBe(true);
    expect(tools.has("task_scope")).toBe(true);
    expect(tools.has("task_review")).toBe(true);

    h.sentPrompts.length = 0;
    const reworkResult = await tools.get("task_review")!.handler(
      {
        taskId: activeTaskId,
        verdict: "rework",
        gaps: ["缺少 boundary 测试"],
        note: "补齐后再提交",
      },
      { signal: new AbortController().signal },
    );
    expect(reworkResult).toBeTruthy();
    const reworkPrompt = h.sentPrompts.find((entry) => entry.agentId === activeChildId)?.prompt;
    expect(reworkPrompt).toContain("第 1/2 轮返工");
    expect(reworkPrompt).toContain("缺少 boundary 测试");
    expect(reworkPrompt).toContain("已拍板决策清单");
    expect(reworkPrompt).toContain("task_review");

    // Round 2 rework succeeds; round 3 exceeds cap and throws
    const rework2 = await h.service.reviewTask({
      taskId: activeTaskId,
      verdict: "rework",
      gaps: ["补充第二轮缺口"],
    });
    expect(rework2.rework?.round).toBe(2);
    expect(rework2.task.reworkCount).toBe(2);
    await expect(
      h.service.reviewTask({
        taskId: activeTaskId,
        verdict: "rework",
        gaps: ["第三轮超限"],
      }),
    ).rejects.toThrow(/返工上限/);

    // Verify conversationId filtering in listTaskRecords
    const convPlan = await h.service.createPlan(mainAgentId, {
      conversationId: "conv_leader_1",
      autoStart: true,
      tasks: [
        {
          title: "方向主管子任务",
          goal: "按 conversationId 过滤验证",
          mode: "readonly",
          cwd: repoDir,
        },
      ],
    });
    const convOnly = await h.service.listTaskRecords({
      mainAgentId,
      conversationId: "conv_leader_1",
    });
    expect(convOnly.map((t) => t.id)).toEqual([convPlan.tasks[0]!.taskRecordId]);

    // Verify task_scope & task_plan_withdraw MCP tools and M3 WebSocket RPCs
    await tools
      .get("task_scope")!
      .handler(
        { taskId: activeTaskId, goal: "最终落地验收流程", reason: "通过 MCP 更新" },
        { signal: new AbortController().signal },
      );
    const openForWithdraw = await h.service.createPlan(mainAgentId, {
      tasks: [
        {
          title: "MCP 撤回测试",
          goal: "待撤回",
          mode: "write",
          cwd: repoDir,
          doneWhen: ["ok"],
        },
      ],
    });
    await tools
      .get("task_plan_withdraw")!
      .handler(
        { planId: openForWithdraw.id, reason: "MCP 主动撤回" },
        { signal: new AbortController().signal },
      );
    expect(h.service.getPlan(openForWithdraw.id)?.status).toBe("withdrawn");

    // Verify getOverview exposes tasks and recentReceipts
    const overview = await h.service.getOverview(mainAgentId);
    expect(overview.tasks?.length).toBe(7);
    expect(overview.recentReceipts?.length).toBe(5);
    expect(overview.recentReceipts?.[0]?.summary).toBe("样本 5 已完成");

    // Verify session RPC handlers for M3
    const responses: SessionOutboundMessage[] = [];
    await handleMainChatSessionMessage(
      h.service,
      {
        type: "main_chat.list_tasks.request",
        requestId: "r_list",
        mainAgentId,
        includeCompleted: false,
      },
      (msg) => responses.push(msg),
    );
    expect(responses[0]?.type).toBe("main_chat.list_tasks.response");
    if (responses[0]?.type === "main_chat.list_tasks.response") {
      expect(responses[0].payload.error).toBeNull();
      expect(responses[0].payload.tasks).toHaveLength(2);
      const activeEntry = responses[0].payload.tasks.find((t) => t.id === activeTaskId);
      expect(activeEntry?.brief.scopeRevision).toBe(2);
      expect(activeEntry?.reworkCount).toBe(2);
    }

    // Verify /clear migrates task ledger records to the replacement main chat without loss!
    const cleared = await h.service.clearMainChatContext(mainAgentId);
    const migratedTasks = await h.service.listTaskRecords({
      mainAgentId: cleared.agentId,
      includeCompleted: true,
    });
    expect(migratedTasks).toHaveLength(7);
    expect(migratedTasks.every((t) => t.mainAgentId === cleared.agentId)).toBe(true);
    expect(
      migratedTasks.some((t) => t.id === activeTaskId && t.activeAgentId === activeChildId),
    ).toBe(true);

    // Verify new_session also migrates task ledger records without loss!
    const handedOff = await h.service.startNewMainChatSession(cleared.agentId, {
      carryHandoffSummary: true,
    });
    const handedOffTasks = await h.service.listTaskRecords({
      mainAgentId: handedOff.agentId,
      includeCompleted: true,
    });
    expect(handedOffTasks).toHaveLength(7);
    expect(handedOffTasks.every((t) => t.mainAgentId === handedOff.agentId)).toBe(true);

    // Static system prompt covers all M3 tools without injecting dynamic task IDs
    const staticPrompt = buildMainChatSystemPrompt();
    expect(staticPrompt).toContain("continuesTaskId");
    expect(staticPrompt).toContain("task_plan_withdraw");
    expect(staticPrompt).toContain("task_scope");
    expect(staticPrompt).toContain("task_review");
    expect(staticPrompt).not.toContain(activeTaskId);

    h.service.stop();
  });
});
