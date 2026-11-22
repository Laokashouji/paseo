import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PluginServerContext, PluginSettings } from "@getpaseo/plugin/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import contribute from "../index.server.js";
import type { PaseoApi } from "./paseo-types.js";
import {
  archiveCompletedSubscription,
  cardSubscription,
  triggerArchiveRpc,
  updateCardMetaRpc,
} from "../shared/rpc.js";
import { HELPER_LABEL_KEY, HELPER_LABEL_VALUE } from "../shared/schema.js";
import {
  DEFAULT_ARCHIVE_COMMAND,
  DEFAULT_WORKBENCH_SETTINGS,
  type workbenchSettingsSchema,
} from "../shared/settings.js";
import {
  evaluateAgentSettledConditions,
  forkTodoAction,
  handleTurnCompletedQueueAndTodos,
  runTodoAction,
  triggerArchiveAction,
} from "./actions.js";
import { isHelperAgent, WorkbenchStore } from "./store.js";
import {
  applySummaryToCard,
  formatSummaryError,
  parseSummaryOutput,
  resolveSummaryTarget,
  selectLightweightModelFromCatalog,
} from "./summarizer.js";
import { buildCardContextPrompt, createWorkbenchAgentTools } from "./tools.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "paseo-workbench-test-"));
  tempDirs.push(dir);
  return dir;
}

function createMockSettings(
  overrides: Partial<typeof DEFAULT_WORKBENCH_SETTINGS> = {},
): PluginSettings<typeof workbenchSettingsSchema> {
  const values = { ...DEFAULT_WORKBENCH_SETTINGS, ...overrides };
  return {
    read: async () => ({ status: "ready", revision: "1", values }),
    subscribe: () => () => {},
  };
}

describe("WorkbenchStore persistence and todos", () => {
  test("persists cards, todos, and overview counts across reload", async () => {
    const dir = await createTempDir();
    const store = new WorkbenchStore({ dataDir: dir });
    await store.ensureLoaded();

    store.updateCard("agent-1", {
      workspaceId: "wks-1",
      topic: "重构登录流程",
      topicLocked: true,
      currentWork: "梳理鉴权拦截器",
      workflowStatus: "waiting_external",
      statusNote: "等后端确认 OAuth 回调地址",
    });
    const { todo } = store.addTodo({
      agentId: "agent-1",
      workspaceId: "wks-1",
      title: "补齐异常重试单测",
      author: "user",
    });
    await store.flush();

    const reloaded = new WorkbenchStore({ dataDir: dir });
    await reloaded.ensureLoaded();
    const card = reloaded.getCardIfPresent("agent-1");
    expect(card?.topic).toBe("重构登录流程");
    expect(card?.topicLocked).toBe(true);
    expect(card?.workflowStatus).toBe("waiting_external");
    expect(card?.todos).toHaveLength(1);
    expect(card?.todos[0]?.id).toBe(todo.id);

    const overview = reloaded.getOverview();
    expect(overview.counts.waitingExternal).toBe(1);
    expect(overview.counts.openTodos).toBe(1);
    store.dispose();
    reloaded.dispose();
  });

  test("excludes background or labeled helper agents from tracking", () => {
    expect(isHelperAgent({ background: true })).toBe(true);
    expect(isHelperAgent({ labels: { [HELPER_LABEL_KEY]: HELPER_LABEL_VALUE } })).toBe(true);
    expect(isHelperAgent({ background: false, labels: {} })).toBe(false);
  });
});

describe("Todo execution queue and Fork actions", () => {
  test("queues todo when agent is running and auto-dispatches on turn completion", async () => {
    const dir = await createTempDir();
    const store = new WorkbenchStore({ dataDir: dir });
    await store.ensureLoaded();

    const { todo } = store.addTodo({
      agentId: "agent-1",
      workspaceId: "wks-1",
      title: "补充 E2E 用例",
      author: "user",
    });

    const send = vi.fn(async () => {});
    let status: "running" | "idle" = "running";
    const mockPaseo = {
      agents: {
        ref: () => ({
          refresh: async () => ({
            agent: {
              id: "agent-1",
              workspaceId: "wks-1",
              title: "主对话",
              status,
              archivedAt: null,
              background: false,
              labels: {},
              pendingPermissions: [],
              lastError: null,
            },
            project: null,
          }),
          send,
        }),
      },
    } as unknown as PaseoApi;

    const firstResult = await runTodoAction({
      store,
      paseo: mockPaseo,
      agentId: "agent-1",
      todoId: todo.id,
      mode: "send_now",
    });
    expect(firstResult.dispatched).toBe("queued");
    expect(send).not.toHaveBeenCalled();
    expect(firstResult.card.todos[0]?.status).toBe("queued");

    status = "idle";
    await handleTurnCompletedQueueAndTodos({
      store,
      paseo: mockPaseo,
      agentId: "agent-1",
      turnId: "turn-1",
      outcomeKind: "completed",
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("补充 E2E 用例");
    expect(store.getCardIfPresent("agent-1")?.todos[0]?.status).toBe("running");
    await store.flush();
    store.dispose();
  });

  test("forks a todo in same workspace or new worktree with summary or full history context", async () => {
    const dir = await createTempDir();
    const store = new WorkbenchStore({ dataDir: dir });
    await store.ensureLoaded();

    store.updateCard("agent-src", {
      workspaceId: "wks-1",
      topic: "插件重构",
      currentWork: "已完成数据层",
    });
    const { todo: todoSame } = store.addTodo({
      agentId: "agent-src",
      workspaceId: "wks-1",
      title: "设计右上角卡片样式",
    });
    const { todo: todoTree } = store.addTodo({
      agentId: "agent-src",
      workspaceId: "wks-1",
      title: "拆出独立 Worktree 改协议",
    });

    const createWorkspaceAgent = vi.fn(async (opts: unknown) => ({
      id: "agent-fork-same",
      workspaceId: "wks-1",
      opts,
    }));
    const createRootAgent = vi.fn(async (opts: unknown) => ({
      id: "agent-fork-tree",
      workspaceId: "wks-new",
      opts,
    }));
    const buildForkContext = vi.fn(async () => ({
      agentId: "agent-src",
      boundaryMessageId: null,
      itemCount: 4,
      error: null,
      attachment: {
        type: "text" as const,
        mimeType: "text/plain" as const,
        contextKind: "chat_history" as const,
        title: "Full history",
        text: "full transcript excerpt",
      },
    }));

    const mockPaseo = {
      agents: {
        ref: () => ({
          refresh: async () => ({
            agent: {
              id: "agent-src",
              workspaceId: "wks-1",
              provider: "claude",
              model: "claude-sonnet-4-6",
              cwd: "/repo/main",
              currentModeId: "default",
              thinkingOptionId: "medium",
              options: {},
            },
            project: {
              checkout: { cwd: "/repo/main" },
            },
          }),
          timeline: {
            refetch: async () => ({ entries: [] }),
          },
          buildForkContext,
        }),
        create: createRootAgent,
      },
      workspaces: {
        ref: () => ({
          agents: {
            create: createWorkspaceAgent,
          },
        }),
      },
    } as unknown as PaseoApi;

    const sameResult = await forkTodoAction({
      store,
      settings: createMockSettings({ defaultForkContextMode: "full_history" }),
      paseo: mockPaseo,
      agentId: "agent-src",
      todoId: todoSame.id,
      forkMode: "same_workspace",
    });
    expect(sameResult.newAgentId).toBe("agent-fork-same");
    expect(buildForkContext).toHaveBeenCalledTimes(1);
    expect(createWorkspaceAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "设计右上角卡片样式",
        attachments: [
          expect.objectContaining({
            contextKind: "chat_history",
            text: "full transcript excerpt",
          }),
        ],
      }),
    );
    expect(store.getCardIfPresent("agent-fork-same")?.forkedFromAgentId).toBe("agent-src");

    const treeResult = await forkTodoAction({
      store,
      settings: createMockSettings({ defaultForkContextMode: "summary" }),
      paseo: mockPaseo,
      agentId: "agent-src",
      todoId: todoTree.id,
      forkMode: "new_worktree",
      branchName: "feat/protocol-split",
    });
    expect(treeResult.newAgentId).toBe("agent-fork-tree");
    expect(createRootAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo/main",
        worktree: { mode: "branch-off", newBranch: "feat/protocol-split" },
      }),
    );
    await store.flush();
    store.dispose();
  });
});

describe("WaitCondition auto-advance and summary protection", () => {
  test("triggers auto_run_next_todo when dependency agent settles", async () => {
    const dir = await createTempDir();
    const store = new WorkbenchStore({ dataDir: dir });
    await store.ensureLoaded();

    store.updateCard("agent-dep", {
      topic: "后端接口联调",
      currentWork: "已完成接口字段变更",
    });
    const { todo } = store.addTodo({
      agentId: "agent-main",
      title: "按新字段更新前端解析",
    });
    store.updateCard("agent-main", {
      workflowStatus: "waiting_dependency",
      waitCondition: {
        kind: "agent_settled",
        targetAgentId: "agent-dep",
        targetLabel: "后端接口联调",
        expect: "idle",
      },
      advancePolicy: { mode: "auto_run_next_todo" },
    });

    const send = vi.fn(async () => {});
    const mockPaseo = {
      agents: {
        ref: () => ({
          refresh: async () => ({
            agent: { status: "idle", pendingPermissions: [] },
          }),
          send,
        }),
      },
    } as unknown as PaseoApi;

    const triggered = await evaluateAgentSettledConditions({
      store,
      paseo: mockPaseo,
      settledAgentId: "agent-dep",
      trigger: "turn_completed",
    });

    expect(triggered).toEqual(["agent-main"]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toContain("按新字段更新前端解析");
    expect(
      store.getCardIfPresent("agent-main")?.todos.find((item) => item.id === todo.id)?.status,
    ).toBe("running");
    await store.flush();
    store.dispose();
  });

  test("parses fenced JSON summary and preserves locked topic and pinned external wait status", async () => {
    const dir = await createTempDir();
    const store = new WorkbenchStore({ dataDir: dir });
    await store.ensureLoaded();

    store.updateCard("agent-1", {
      topic: "用户锁定主题",
      topicLocked: true,
      workflowStatus: "waiting_external",
      statusNote: "等产品评审",
    });

    const parsed = parseSummaryOutput(
      '```json\n{"topic":"AI新主题","currentWork":"整理接口文档","suggestedStatus":"active","suggestedTodos":[{"title":"补一份回归 checklist"}]}\n```',
    );
    const updated = applySummaryToCard(store, "agent-1", parsed, "turn-2");

    expect(updated.topic).toBe("用户锁定主题");
    expect(updated.currentWork).toBe("整理接口文档");
    expect(updated.workflowStatus).toBe("waiting_external");
    expect(updated.suggestedTodos).toHaveLength(1);
    expect(updated.suggestedTodos[0]?.title).toBe("补一份回归 checklist");
    await store.flush();
    store.dispose();
  });

  test("AI agent tools add/update todos and build concise context prompt", async () => {
    const dir = await createTempDir();
    const store = new WorkbenchStore({ dataDir: dir });
    await store.ensureLoaded();

    const tools = createWorkbenchAgentTools(store);
    const addTool = tools.find((item) => item.name === "workbench_add_todo")!;
    const statusTool = tools.find((item) => item.name === "workbench_set_status")!;
    const ctx = {
      agent: {
        id: "agent-ai",
        workspaceId: "wks-1",
        parentAgentId: null,
        provider: "claude",
        cwd: "/repo",
        title: "AI 协作",
        background: false,
        metadata: {},
      },
      paseo: {} as PaseoApi,
      signal: new AbortController().signal,
    };

    await addTool.execute({ title: "检查暗色模式对比度" }, ctx);
    await statusTool.execute(
      { topic: "插件开发", currentWork: "编写服务端逻辑", workflowStatus: "active" },
      ctx,
    );

    const card = store.getCardIfPresent("agent-ai");
    expect(card?.todos[0]?.author).toBe("agent");
    const prompt = buildCardContextPrompt(card);
    expect(prompt).toContain("插件开发");
    expect(prompt).toContain("检查暗色模式对比度");
    await store.flush();
    store.dispose();
  });

  test("tolerates null optional fields in summary JSON and formats Zod errors cleanly", () => {
    const parsed = parseSummaryOutput(
      JSON.stringify({
        topic: "fork 能力优化",
        currentWork: "已完成根因排查与方案设计",
        suggestedStatus: null,
        waitingReason: null,
        suggestedTodos: [
          { title: "补齐轻量模型测试", prompt: null },
          { title: "   ", prompt: "ignored" },
        ],
      }),
    );
    expect(parsed.topic).toBe("fork 能力优化");
    expect(parsed.waitingReason).toBeUndefined();
    expect(parsed.suggestedStatus).toBeUndefined();
    expect(parsed.suggestedTodos).toEqual([{ title: "补齐轻量模型测试", prompt: undefined }]);

    const nullTodos = parseSummaryOutput(
      JSON.stringify({
        topic: "清理状态",
        currentWork: "核验中",
        waitingReason: null,
        suggestedTodos: null,
      }),
    );
    expect(nullTodos.suggestedTodos).toBeUndefined();

    let caught: unknown;
    try {
      parseSummaryOutput(JSON.stringify({ topic: "", currentWork: "" }));
    } catch (error) {
      caught = error;
    }
    const formatted = formatSummaryError(caught);
    expect(formatted).toContain("摘要格式校验失败");
    expect(formatted).not.toContain("\n");
  });

  test("auto-selects lightweight model from same provider first, skips image models, and falls back across providers", async () => {
    const pickedFromCpa = selectLightweightModelFromCatalog([
      { id: "gemini-3.1-flash-image" },
      { id: "claude-opus-5-5-high" },
      { id: "gemini-3.5-flash-lite" },
      { id: "gemini-3-flash" },
    ]);
    expect(pickedFromCpa?.id).toBe("gemini-3.5-flash-lite");

    const sameProviderPaseo = {
      providers: {
        listModels: vi.fn(async () => ({
          models: [
            { id: "agy-cli/gemini-4-neon[1m]", thinkingOptions: [{ id: "low" }, { id: "xhigh" }] },
            {
              id: "agy-cli/gemini-3.8-flash[1m]",
              thinkingOptions: [{ id: "off" }, { id: "high" }],
            },
            { id: "agy-cli/claude-opus-5-5" },
          ],
        })),
        snapshot: vi.fn(async () => ({ entries: [] })),
      },
    } as unknown as PaseoApi;

    const targetSame = await resolveSummaryTarget({
      paseo: sameProviderPaseo,
      config: DEFAULT_WORKBENCH_SETTINGS,
      sourceProvider: "claude-magpie",
      sourceModel: "agy-cli/gemini-4-neon[1m]",
    });
    expect(targetSame).toEqual({
      provider: "claude-magpie",
      model: "agy-cli/gemini-3.8-flash[1m]",
      thinkingOptionId: "off",
      displayLabel: "gemini-3.8-flash",
    });

    const crossProviderPaseo = {
      providers: {
        listModels: vi.fn(async () => ({
          models: [{ id: "claude-opus-5-5" }],
        })),
        snapshot: vi.fn(async () => ({
          entries: [
            {
              provider: "claude-cpa",
              enabled: true,
              status: "ready",
              models: [
                { id: "gemini-3.1-flash-image" },
                { id: "gemini-3.5-flash-lite", thinkingOptions: [{ id: "low" }] },
              ],
            },
          ],
        })),
      },
    } as unknown as PaseoApi;

    const targetCross = await resolveSummaryTarget({
      paseo: crossProviderPaseo,
      config: DEFAULT_WORKBENCH_SETTINGS,
      sourceProvider: "claude-sub2api",
      sourceModel: "claude-opus-5-5",
    });
    expect(targetCross).toEqual({
      provider: "claude-cpa",
      model: "gemini-3.5-flash-lite",
      thinkingOptionId: "low",
      displayLabel: "gemini-3.5-flash-lite",
    });

    const targetCustom = await resolveSummaryTarget({
      paseo: sameProviderPaseo,
      config: {
        ...DEFAULT_WORKBENCH_SETTINGS,
        summaryCustomProviderModel: "claude-magpie/agy-cli/gemini-3.8-flash[1m]",
      },
      sourceProvider: "claude-sub2api",
      sourceModel: "claude-opus-5-5",
    });
    expect(targetCustom.provider).toBe("claude-magpie");
    expect(targetCustom.model).toBe("agy-cli/gemini-3.8-flash[1m]");
    expect(targetCustom.thinkingOptionId).toBe("off");
  });

  test("cardSubscription stays open synchronously and pushes live updates to multiple subscribers", async () => {
    const prevHome = process.env.PASEO_HOME;
    const dir = await createTempDir();
    process.env.PASEO_HOME = dir;
    try {
      const handlers = new Map<string, (input: unknown, ctx: unknown) => unknown>();
      const mockServer = {
        registerSettings: () => createMockSettings(),
        handle: (
          contract: { name: string },
          handler: (input: unknown, ctx: unknown) => unknown,
        ) => {
          handlers.set(contract.name, handler);
        },
        addHook: () => () => {},
        registerProvider: () => {},
        registerUsageSource: () => {},
      } as unknown as PluginServerContext;

      const cleanup = contribute(mockServer);
      const mockPaseo = {
        agents: {
          list: async () => ({ entries: [] }),
          ref: () => ({
            refresh: async () => null,
          }),
        },
      } as unknown as PaseoApi;

      const cornerEvents: Array<{ card: { topic: string; currentWork: string } }> = [];
      const panelEvents: Array<{ card: { topic: string; currentWork: string } }> = [];
      const cornerAbort = new AbortController();
      const panelAbort = new AbortController();

      const cardSubHandler = handlers.get(cardSubscription.name)!;
      const ret1 = cardSubHandler(
        { agentId: "agent-sync", workspaceId: "wks-1" },
        {
          paseo: mockPaseo,
          signal: cornerAbort.signal,
          push: async (event: { card: { topic: string; currentWork: string } }) => {
            cornerEvents.push(event);
          },
        },
      );
      const ret2 = cardSubHandler(
        { agentId: "agent-sync", workspaceId: "wks-1" },
        {
          paseo: mockPaseo,
          signal: panelAbort.signal,
          push: async (event: { card: { topic: string; currentWork: string } }) => {
            panelEvents.push(event);
          },
        },
      );

      // Must return undefined (not a settling Promise that would immediately close the stream).
      expect(ret1).toBeUndefined();
      expect(ret2).toBeUndefined();

      await vi.waitFor(() => {
        expect(cornerEvents.length).toBeGreaterThanOrEqual(1);
        expect(panelEvents.length).toBeGreaterThanOrEqual(1);
      });

      const updateHandler = handlers.get(updateCardMetaRpc.name)!;
      await updateHandler(
        {
          agentId: "agent-sync",
          workspaceId: "wks-1",
          topic: "同步测试主题",
          currentWork: "实时推送到卡片与侧边栏",
        },
        { paseo: mockPaseo },
      );

      await vi.waitFor(() => {
        expect(cornerEvents.at(-1)?.card.topic).toBe("同步测试主题");
        expect(panelEvents.at(-1)?.card.topic).toBe("同步测试主题");
        expect(cornerEvents.at(-1)?.card.currentWork).toBe("实时推送到卡片与侧边栏");
      });

      cornerAbort.abort();
      panelAbort.abort();
      await cleanup?.();
    } finally {
      if (prevHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = prevHome;
    }
  });
});

describe("Session archive command & auto-archive lifecycle", () => {
  test("sends configured archive command when idle and auto-archives after workbench_finish_archive", async () => {
    const dir = await createTempDir();
    const store = new WorkbenchStore({ dataDir: dir });
    await store.ensureLoaded();
    store.updateCard("agent-arc", { workspaceId: "wks-arc", topic: "清理测试" });

    const sent: string[] = [];
    const archivedIds: string[] = [];
    const completedEvents: Array<{
      agentId: string;
      workspaceId: string | null;
      summary: string | null;
    }> = [];
    store.subscribeArchiveCompleted((event) => {
      completedEvents.push({
        agentId: event.agentId,
        workspaceId: event.workspaceId,
        summary: event.summary,
      });
    });

    const mockPaseo = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => ({
            agent: {
              id,
              workspaceId: "wks-arc",
              title: "清理测试",
              status: "idle",
              pendingPermissions: [],
              lastError: null,
              archivedAt: null,
            },
          }),
          send: async (text: string) => {
            sent.push(text);
          },
          archive: async () => {
            archivedIds.push(id);
            return { archivedAt: "2026-11-22T12:00:00.000Z" };
          },
        }),
      },
    } as unknown as PaseoApi;

    const settings = createMockSettings({ archiveCommand: "/archive-session" });
    const triggered = await triggerArchiveAction({
      store,
      settings,
      paseo: mockPaseo,
      agentId: "agent-arc",
      workspaceId: "wks-arc",
    });
    expect(triggered.status).toBe("sent");
    expect(sent).toEqual(["/archive-session"]);
    expect(store.getCardIfPresent("agent-arc")?.archiveState).toBe("running");

    // AI finishes cleanup and invokes workbench_finish_archive.
    const tools = createWorkbenchAgentTools(store, {
      isAutoArchiveEnabled: async () => true,
    });
    const finishTool = tools.find((tool) => tool.name === "workbench_finish_archive")!;
    const toolResult = await finishTool.execute(
      { summary: "已合并并删除 .worktrees/demo，清理 2 个临时日志" },
      {
        agent: {
          id: "agent-arc",
          workspaceId: "wks-arc",
          parentAgentId: null,
          provider: "claude",
          cwd: "/repo",
          title: "清理测试",
          background: false,
          metadata: {},
        },
        paseo: mockPaseo,
        signal: new AbortController().signal,
      },
    );
    expect(toolResult.text).toContain("自动归档");
    expect(store.getCardIfPresent("agent-arc")?.archiveState).toBe("pending_archive");
    // Must not archive mid-turn before turn completes.
    expect(archivedIds).toEqual([]);

    // Once the turn finishes cleanly, the daemon archives the agent and notifies clients to close the tab.
    const turnResult = await handleTurnCompletedQueueAndTodos({
      store,
      settings,
      paseo: mockPaseo,
      agentId: "agent-arc",
      turnId: "turn-arc-1",
      outcomeKind: "completed",
    });
    expect(turnResult).toEqual({ archived: true, skipSummary: true });
    expect(archivedIds).toEqual(["agent-arc"]);
    expect(store.getCardIfPresent("agent-arc")?.archived).toBe(true);
    expect(store.getCardIfPresent("agent-arc")?.archiveState).toBe("idle");
    expect(completedEvents).toEqual([
      {
        agentId: "agent-arc",
        workspaceId: "wks-arc",
        summary: "已合并并删除 .worktrees/demo，清理 2 个临时日志",
      },
    ]);
    store.dispose();
  });

  test("queues archive command while agent is running, allows cancel, and dispatches on turn completion", async () => {
    const dir = await createTempDir();
    const store = new WorkbenchStore({ dataDir: dir });
    await store.ensureLoaded();
    store.updateCard("agent-busy", { workspaceId: "wks-1", runtimeStatus: "running" });

    let status: "running" | "idle" = "running";
    const sent: string[] = [];
    const mockPaseo = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => ({
            agent: {
              id,
              workspaceId: "wks-1",
              title: "繁忙对话",
              status,
              pendingPermissions: [],
              lastError: null,
              archivedAt: null,
            },
          }),
          send: async (text: string) => {
            sent.push(text);
          },
        }),
      },
    } as unknown as PaseoApi;

    const settings = createMockSettings();
    const queued = await triggerArchiveAction({
      store,
      settings,
      paseo: mockPaseo,
      agentId: "agent-busy",
      workspaceId: "wks-1",
    });
    expect(queued.status).toBe("queued");
    expect(sent).toEqual([]);
    expect(store.getCardIfPresent("agent-busy")?.archiveState).toBe("queued");

    const canceled = await triggerArchiveAction({
      store,
      settings,
      paseo: mockPaseo,
      agentId: "agent-busy",
      workspaceId: "wks-1",
      cancelQueue: true,
    });
    expect(canceled.status).toBe("canceled");
    expect(store.getCardIfPresent("agent-busy")?.archiveState).toBe("idle");

    // Queue again and finish the running turn -> archive command auto-dispatches.
    await triggerArchiveAction({
      store,
      settings,
      paseo: mockPaseo,
      agentId: "agent-busy",
      workspaceId: "wks-1",
    });
    status = "idle";
    const turnResult = await handleTurnCompletedQueueAndTodos({
      store,
      settings,
      paseo: mockPaseo,
      agentId: "agent-busy",
      turnId: "turn-busy-1",
      outcomeKind: "completed",
    });
    expect(turnResult).toEqual({ archived: false, skipSummary: true });
    expect(sent).toEqual([DEFAULT_ARCHIVE_COMMAND]);
    expect(store.getCardIfPresent("agent-busy")?.archiveState).toBe("running");
    store.dispose();
  });

  test("keeps conversation open and marks waiting_me if AI stops without calling workbench_finish_archive", async () => {
    const dir = await createTempDir();
    const store = new WorkbenchStore({ dataDir: dir });
    await store.ensureLoaded();
    store.updateCard("agent-risk", { workspaceId: "wks-1", archiveState: "running" });

    const archiveFn = vi.fn(async () => ({ archivedAt: "2026-11-22T12:00:00.000Z" }));
    const mockPaseo = {
      agents: {
        ref: () => ({ archive: archiveFn }),
      },
    } as unknown as PaseoApi;

    const turnResult = await handleTurnCompletedQueueAndTodos({
      store,
      settings: createMockSettings(),
      paseo: mockPaseo,
      agentId: "agent-risk",
      turnId: "turn-risk-1",
      outcomeKind: "completed",
    });
    expect(turnResult).toEqual({ archived: false, skipSummary: false });
    expect(archiveFn).not.toHaveBeenCalled();
    expect(store.getCardIfPresent("agent-risk")?.archiveState).toBe("idle");
    expect(store.getCardIfPresent("agent-risk")?.workflowStatus).toBe("waiting_me");
    store.dispose();
  });

  test("does not auto-archive when autoArchiveAfterCleanup setting is disabled", async () => {
    const dir = await createTempDir();
    const store = new WorkbenchStore({ dataDir: dir });
    await store.ensureLoaded();
    store.updateCard("agent-manual", { workspaceId: "wks-1", archiveState: "running" });

    const archiveFn = vi.fn(async () => ({ archivedAt: "2026-11-22T12:00:00.000Z" }));
    const mockPaseo = {
      agents: { ref: () => ({ archive: archiveFn }) },
    } as unknown as PaseoApi;

    const tools = createWorkbenchAgentTools(store, {
      isAutoArchiveEnabled: async () => false,
    });
    const finishTool = tools.find((tool) => tool.name === "workbench_finish_archive")!;
    const res = await finishTool.execute(
      { summary: "已清理临时文件" },
      {
        agent: {
          id: "agent-manual",
          workspaceId: "wks-1",
          parentAgentId: null,
          provider: "claude",
          cwd: "/repo",
          title: "手动确认",
          background: false,
          metadata: {},
        },
        paseo: mockPaseo,
        signal: new AbortController().signal,
      },
    );
    expect(res.text).toContain("未开启自动归档");
    expect(store.getCardIfPresent("agent-manual")?.archiveState).toBe("idle");
    expect(store.getCardIfPresent("agent-manual")?.workflowStatus).toBe("done");
    expect(archiveFn).not.toHaveBeenCalled();
    store.dispose();
  });

  test("rejects empty archive command and streams archiveCompletedSubscription through server contribute", async () => {
    const prevHome = process.env.PASEO_HOME;
    const dir = await createTempDir();
    process.env.PASEO_HOME = dir;
    try {
      const handlers = new Map<string, (input: unknown, ctx: unknown) => unknown>();
      const hooks = new Map<string, (payload: unknown, ctx: unknown) => Promise<unknown>>();
      const mockServer = {
        registerSettings: () => createMockSettings({ archiveCommand: "   " }),
        handle: (
          contract: { name: string },
          handler: (input: unknown, ctx: unknown) => unknown,
        ) => {
          handlers.set(contract.name, handler);
        },
        addHook: (name: string, handler: (payload: unknown, ctx: unknown) => Promise<unknown>) => {
          hooks.set(name, handler);
          return () => {};
        },
        registerProvider: () => {},
        registerUsageSource: () => {},
      } as unknown as PluginServerContext;

      const cleanup = contribute(mockServer);
      const mockPaseo = {
        agents: {
          list: async () => ({ entries: [] }),
          ref: () => ({
            refresh: async () => null,
            send: async () => {},
            archive: async () => ({ archivedAt: "2026-11-22T12:00:00.000Z" }),
          }),
        },
      } as unknown as PaseoApi;

      const archiveHandler = handlers.get(triggerArchiveRpc.name)!;
      await expect(
        archiveHandler({ agentId: "agent-empty", workspaceId: "wks-1" }, { paseo: mockPaseo }),
      ).rejects.toThrow("归档命令为空");

      const subAbort = new AbortController();
      const subHandler = handlers.get(archiveCompletedSubscription.name)!;
      const ret = subHandler(
        {},
        {
          paseo: mockPaseo,
          signal: subAbort.signal,
          push: async () => {},
        },
      );
      expect(ret).toBeUndefined();
      expect(hooks.has("agent.turn.after")).toBe(true);

      subAbort.abort();
      await cleanup?.();
    } finally {
      if (prevHome === undefined) delete process.env.PASEO_HOME;
      else process.env.PASEO_HOME = prevHome;
    }
  });
});
