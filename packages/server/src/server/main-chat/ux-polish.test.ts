import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSystemInjectedEnvelope, parseAgentMessage } from "../agent/agent-messages/index.js";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentSessionConfig, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type {
  PersistedWorkspaceRecord,
  WorkspaceRegistry,
} from "../workspace/workspace-registry.js";
import { createMainChatService } from "./service.js";
import { heuristicTriageAssistantReply } from "./triage.js";

function createSilentLogger(): Logger {
  const noop = () => undefined;
  const logger = {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger as unknown as Logger;
}

async function flushAsync(ms = 40): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("main-chat UX polish: streaming triage accumulation, live needs-you clearing & system prompt envelope", () => {
  let tempDir: string;
  let repoDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), "paseo-main-chat-ux-polish-"));
    repoDir = path.join(tempDir, "repo-app");
    mkdirSync(repoDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeHarness() {
    const subscribers = new Set<(event: AgentManagerEvent) => void>();
    const agents = new Map<string, ManagedAgent>();
    const storedAgents = new Map<string, StoredAgentRecord>();
    const workspaces = new Map<string, PersistedWorkspaceRecord>();
    const timelines = new Map<string, AgentTimelineItem[]>();
    const sentPrompts: Array<{ agentId: string; prompt: unknown }> = [];
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
          const now = new Date();
          const managed = {
            id,
            provider: config.provider,
            cwd: config.cwd,
            workspaceId: createOptions?.workspaceId ?? "ws_default",
            owner: null,
            session: {
              listCommands: async () => [],
            },
            capabilities: {},
            config: {
              ...config,
              title: createOptions?.initialTitle ?? config.title ?? id,
            },
            runtimeInfo: {
              provider: config.provider,
              sessionId: `sess_${id}`,
              model: config.model ?? "claude-sonnet-5-5",
              modeId: config.modeId ?? "default",
            },
            lifecycle: "idle",
            createdAt: now,
            updatedAt: now,
            availableModes: [],
            controls: {},
            effectiveOptions: {},
            currentModeId: config.modeId ?? "default",
            pendingPermissions: new Map(),
            bufferedPermissionResolutions: new Map(),
            inFlightPermissionResponses: new Set(),
            pendingReplacement: false,
            activeForegroundTurnId: null,
            activeTurnId: null,
            activeTurnStartedAt: null,
            foregroundTurnWaiters: new Set(),
            finalizedForegroundTurnIds: new Set(),
            unsubscribeSession: null,
            persistence: null,
            historyPrimed: true,
            lastUserMessageAt: null,
            lastUsage: undefined,
            lastError: undefined,
            attention: { requiresAttention: false },
            internal: false,
            background: createOptions?.background ?? false,
            labels,
          } as unknown as ManagedAgent;
          agents.set(id, managed);
          storedAgents.set(id, {
            id,
            provider: config.provider,
            cwd: config.cwd,
            workspaceId: managed.workspaceId,
            title: managed.config.title ?? null,
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
            archivedAt: null,
            internal: false,
            background: managed.background,
            labels,
          } as StoredAgentRecord);
          timelines.set(id, []);
          return managed;
        },
      ),
      getTimeline: (id: string) => timelines.get(id) ?? [],
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      reloadStalePluginSession: vi.fn(async () => false),
      replaceAgentRun: vi.fn(),
      steerOrReplaceActiveTurn: vi.fn(),
      streamAgent: vi.fn(async function* (
        id: string,
        prompt: unknown,
        _runOptions?: unknown,
        promptStart?: { bind?: (run: unknown) => void },
      ) {
        sentPrompts.push({ agentId: id, prompt });
        promptStart?.bind?.({
          start: { status: "started" },
          turnStartedPromise: Promise.resolve(),
          settledPromise: new Promise(() => undefined),
        });
        yield { type: "turn_started", provider: "claude" };
        yield { type: "turn_completed", provider: "claude" };
      }),
      notifyAgentState: vi.fn(),
      unarchiveSnapshot: vi.fn(),
      reloadAgentSession: vi.fn(),
      updateAgentMetadata: vi.fn(async () => undefined),
      archiveAgent: vi.fn(async (id: string) => {
        const archivedAt = new Date().toISOString();
        const stored = storedAgents.get(id);
        if (stored) {
          storedAgents.set(id, { ...stored, archivedAt });
        }
        return { archivedAt };
      }),
      respondToPermission: vi.fn(async () => undefined),
    } as unknown as AgentManager;

    const agentStorage = {
      get: async (id: string) => storedAgents.get(id) ?? null,
      listActive: async () => Array.from(storedAgents.values()).filter((item) => !item.archivedAt),
      listAll: async () => Array.from(storedAgents.values()),
    } as unknown as AgentStorage;

    const providerSnapshotManager = {
      getSnapshot: () => ({
        cwd: tempDir,
        records: [
          {
            contentHash: "h1",
            entry: {
              provider: "claude",
              enabled: true,
              status: "ready",
              models: [
                {
                  id: "claude-sonnet-5-5",
                  label: "Sonnet",
                  isDefault: true,
                  contextWindowMaxTokens: 1_000_000,
                },
              ],
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
      updateTitle: async () => undefined,
    } as unknown as WorkspaceRegistry;

    const service = createMainChatService({
      paseoHome: tempDir,
      worktreesRoot: path.join(tempDir, "worktrees"),
      serverId: "srv_local",
      hostLabel: "DevBox",
      agentManager,
      agentStorage,
      providerSnapshotManager,
      workspaceRegistry,
      createDirectoryWorkspace: async (cwd, title, _projectId, ctx) =>
        createWorkspaceRecord(cwd, title, ctx?.background),
      emitWorkspaceUpdates: async () => undefined,
      finishSubscriptions: () =>
        ({
          register: vi.fn(async () => ({
            accept: vi.fn(),
            reject: vi.fn(async () => undefined),
          })),
        }) as unknown as import("../agent/finish-subscriptions.js").FinishSubscriptions,
      logger: createSilentLogger(),
      triageSettleMs: 10,
      superviseGatherMs: 10,
      normalCooldownMs: 10,
      urgentCooldownMs: 10,
      semanticTriageRunner: async () => null,
    });

    const emit = (event: AgentManagerEvent) => {
      for (const cb of subscribers) {
        cb(event);
      }
    };

    return { service, agents, storedAgents, timelines, sentPrompts, emit };
  }

  it("accumulates streaming assistant_message chunks per turn instead of overwriting with the last fragment", async () => {
    const h = makeHarness();
    await h.service.start();
    await h.service.updateSettings({ enabled: true });
    const { agentId: mainId } = await h.service.ensureMainChat();

    const plan = await h.service.createPlan(mainId, {
      autoStart: true,
      tasks: [
        {
          title: "整理交付文档",
          goal: "核对改动并同步更新文档",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["文档同步完成"],
        },
      ],
    });
    expect(plan.tasks[0]?.startError).toBeNull();
    const childId = plan.tasks[0]!.agentId!;
    expect(childId).toBeTruthy();

    // Simulate Claude streaming delta chunks with the same messageId where the last chunk is a tiny fragment.
    h.emit({
      type: "agent_stream",
      agentId: childId,
      event: { type: "turn_started", provider: "claude" },
    });
    const chunks = [
      "我已经完成了全部 4 个模块的代码修改并通过了类型检查。\n\n",
      "在最终提交之前，请确认是否需要一并更新",
      "《发布说明与变更文",
      "档清单》？",
    ];
    for (const chunk of chunks) {
      h.emit({
        type: "agent_stream",
        agentId: childId,
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "assistant_message", messageId: "msg_stream_1", text: chunk },
        },
      });
    }
    h.emit({
      type: "agent_stream",
      agentId: childId,
      event: { type: "turn_completed", provider: "claude" },
    });

    await flushAsync(60);

    const overview = await h.service.getOverview(mainId);
    const triage = overview.triages?.find((entry) => entry.agentId === childId);
    expect(triage?.phase).toBe("blocked_user");
    // Must contain the full trailing question, NOT a truncated fragment like "档清单》？".
    expect(triage?.waitReason).toContain(
      "在最终提交之前，请确认是否需要一并更新《发布说明与变更文档清单》？",
    );
    expect(triage?.summary).toContain("我已经完成了全部 4 个模块的代码修改");

    h.service.stop();
  });

  it("extracts complete trailing questions and options without mid-sentence truncation in heuristic triage", () => {
    const longReply = [
      "已完成后端接口分析与性能压测，以下是详细排查记录：" + "背景说明内容。".repeat(40),
      "接下来有两种实现路径：",
      "1. 方案 A：保留旧接口并追加兼容字段",
      "2. 方案 B：直接升级新协议并迁移全部调用方",
      "请确认选择方案 A 还是方案 B？",
    ].join("\n");

    const result = heuristicTriageAssistantReply(longReply);
    expect(result.phase).toBe("blocked_user");
    expect(result.waitReason).toContain("方案 A");
    expect(result.waitReason).toContain("方案 B");
    expect(result.waitReason).toContain("请确认选择方案 A 还是方案 B？");
    expect(result.summary.length).toBeGreaterThan(10);
  });

  it("clears stale triage but retains an explicit decision when another turn starts", async () => {
    const h = makeHarness();
    await h.service.start();
    await h.service.updateSettings({ enabled: true });
    const { agentId: mainId } = await h.service.ensureMainChat();

    const plan = await h.service.createPlan(mainId, {
      autoStart: true,
      tasks: [
        {
          title: "排查线上接口",
          goal: "定位超时根因",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["产出排查报告"],
        },
      ],
    });
    const childId = plan.tasks[0]!.agentId!;
    const taskId = plan.tasks[0]!.taskRecordId!;

    // 1. Child ends turn asking a question -> produces blocked_user triage.
    h.emit({
      type: "agent_stream",
      agentId: childId,
      event: { type: "turn_started", provider: "claude" },
    });
    h.emit({
      type: "agent_stream",
      agentId: childId,
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "assistant_message",
          messageId: "msg_q",
          text: "排查需要线上日志权限，请确认是否开启只读查询？",
        },
      },
    });
    h.emit({
      type: "agent_stream",
      agentId: childId,
      event: { type: "turn_completed", provider: "claude" },
    });
    await flushAsync(50);

    // 2. Steward also opened an ask-user decision linked to this child agent.
    const decision = await h.service.askUserDecision(mainId, {
      title: "是否开启只读查询",
      question: "子会话需要线上只读日志权限，请确认",
      agentId: childId,
      planId: plan.id,
      taskId,
      options: [
        { id: "allow", label: "允许", leadsTo: "继续排查" },
        { id: "deny", label: "拒绝", leadsTo: "改看本地日志" },
      ],
    });

    const beforeOverview = await h.service.getOverview(mainId);
    expect(
      beforeOverview.triages?.some((t) => t.agentId === childId && t.phase === "blocked_user"),
    ).toBe(true);
    expect(beforeOverview.decisions.find((d) => d.id === decision.id)?.answeredAt).toBeNull();

    // 3. User replies directly inside the original child session -> turn_started fires.
    const childAgent = h.agents.get(childId)!;
    (childAgent as unknown as { lifecycle: string }).lifecycle = "running";
    h.emit({
      type: "agent_stream",
      agentId: childId,
      event: { type: "turn_started", provider: "claude" },
    });
    await flushAsync(40);

    const afterOverview = await h.service.getOverview(mainId);
    expect(afterOverview.triages?.find((t) => t.agentId === childId)).toBeUndefined();
    const resolvedDecision = afterOverview.decisions.find((d) => d.id === decision.id);
    expect(resolvedDecision?.answeredAt).toBeNull();
    expect(resolvedDecision?.answer).toBeNull();
    const refreshedTask = afterOverview.tasks?.find((t) => t.id === taskId);
    expect(refreshedTask?.status).toBe("needs_you");

    h.service.stop();
  });

  it("clears stale blocked_user triage and auto-resolves open decisions immediately when child agent is archived", async () => {
    const h = makeHarness();
    await h.service.start();
    await h.service.updateSettings({ enabled: true });
    const { agentId: mainId } = await h.service.ensureMainChat();

    const plan = await h.service.createPlan(mainId, {
      autoStart: true,
      tasks: [
        {
          title: "归档测试任务",
          goal: "验证归档清理",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["完成验证"],
        },
      ],
    });
    const childId = plan.tasks[0]!.agentId!;
    const taskId = plan.tasks[0]!.taskRecordId!;

    // Seed blocked_user triage and open decision on child agent.
    h.emit({
      type: "agent_stream",
      agentId: childId,
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "assistant_message",
          messageId: "msg_arch",
          text: "请确认是否继续执行归档测试？",
        },
      },
    });
    h.emit({
      type: "agent_stream",
      agentId: childId,
      event: { type: "turn_completed", provider: "claude" },
    });
    await flushAsync(50);

    const decision = await h.service.askUserDecision(mainId, {
      title: "归档前待拍板",
      question: "确认是否继续",
      agentId: childId,
      planId: plan.id,
      taskId,
      options: [
        { id: "go", label: "继续", leadsTo: "执行" },
        { id: "stop", label: "取消", leadsTo: "结束任务" },
      ],
    });

    // Archive the child session and invoke the archived lifecycle hook.
    const stored = h.storedAgents.get(childId)!;
    h.storedAgents.set(childId, { ...stored, archivedAt: new Date().toISOString() });
    await h.service.handleAgentArchived(childId);

    const overview = await h.service.getOverview(mainId);
    expect(overview.triages?.find((t) => t.agentId === childId)).toBeUndefined();
    const closedDecision = overview.decisions.find((d) => d.id === decision.id);
    expect(closedDecision?.answeredAt).not.toBeNull();
    expect(closedDecision?.answer).toContain("归档");

    h.service.stop();
  });

  it("dispatches background patrol wakeup via sendPreparedPromptToAgent without double-wrapping as user-message", async () => {
    const h = makeHarness();
    await h.service.start();
    await h.service.updateSettings({ enabled: true });
    const { agentId: mainId } = await h.service.ensureMainChat();

    await h.service.triggerPatrol({ mainAgentId: mainId, forceWakeup: true });
    await flushAsync(60);

    const patrolPrompt = h.sentPrompts.find(
      (entry) => entry.agentId === mainId && typeof entry.prompt === "string",
    )?.prompt as string | undefined;
    expect(patrolPrompt).toBeTruthy();
    expect(isSystemInjectedEnvelope(patrolPrompt!)).toBe(true);
    // Must NOT be wrapped in `<paseo-system version="1" kind="user-message" ...>`.
    expect(parseAgentMessage(patrolPrompt!)).toBeNull();

    h.service.stop();
  });

  it("also clears stale triage and open decisions when agent_state transitions after storage archive", async () => {
    const h = makeHarness();
    await h.service.start();
    await h.service.updateSettings({ enabled: true });
    const { agentId: mainId } = await h.service.ensureMainChat();

    const plan = await h.service.createPlan(mainId, {
      autoStart: true,
      tasks: [
        {
          title: "状态归档联动",
          goal: "验证 agent_state 触发归档清理",
          mode: "readonly",
          cwd: repoDir,
          doneWhen: ["清理完成"],
        },
      ],
    });
    const childId = plan.tasks[0]!.agentId!;
    const taskId = plan.tasks[0]!.taskRecordId!;

    h.emit({
      type: "agent_stream",
      agentId: childId,
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "assistant_message",
          messageId: "msg_state_arch",
          text: "请确认是否需要清理历史缓存？",
        },
      },
    });
    h.emit({
      type: "agent_stream",
      agentId: childId,
      event: { type: "turn_completed", provider: "claude" },
    });
    await flushAsync(50);

    const decision = await h.service.askUserDecision(mainId, {
      title: "清理缓存确认",
      question: "是否清理历史缓存？",
      agentId: childId,
      planId: plan.id,
      taskId,
      options: [
        { id: "yes", label: "清理", leadsTo: "继续" },
        { id: "no", label: "保留", leadsTo: "维持现状" },
      ],
    });

    const stored = h.storedAgents.get(childId)!;
    h.storedAgents.set(childId, { ...stored, archivedAt: new Date().toISOString() });
    const childAgent = h.agents.get(childId)!;
    (childAgent as unknown as { lifecycle: string }).lifecycle = "closed";
    h.emit({ type: "agent_state", agent: childAgent });
    await flushAsync(50);

    const overview = await h.service.getOverview(mainId);
    expect(overview.triages?.find((t) => t.agentId === childId)).toBeUndefined();
    expect(overview.decisions.find((d) => d.id === decision.id)?.answeredAt).not.toBeNull();

    h.service.stop();
  });
});
