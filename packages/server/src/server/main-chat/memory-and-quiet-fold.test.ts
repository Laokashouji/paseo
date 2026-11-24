import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAIN_CHAT_ABOUT_ME_MAX_CHARS,
  MAIN_CHAT_CONVERSATION_ID_LABEL,
  MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS,
  MAIN_CHAT_MEMORY_FILE_MAX_BYTES,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_ID_LABEL,
  MAIN_CHAT_TASK_QUIET_LABEL,
  createDefaultMainChatSettings,
  getMainChatBackgroundTurnMetadata,
  isMainChatBackgroundFolded,
  isMainChatTaskQuietLabels,
  isMainChatTasksQuiet,
  mergeMainChatSettings,
} from "@getpaseo/protocol/main-chat";
import {
  formatAgentMessage,
  formatSystemNotificationPrompt,
  projectAgentMessages,
} from "../agent/agent-messages/envelope.js";
import type { AgentManager } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import type { SessionOutboundMessage } from "../messages.js";
import type { WorkspaceRegistry } from "../workspace-registry.js";
import { buildLeaderSystemPrompt } from "./conversations.js";
import {
  MainChatMemoryError,
  assembleMainChatMemoryContext,
  createMainChatMemoryStore,
  normalizeAndValidateMemoryRelativePath,
  truncateUtf8ToBytes,
} from "./memory.js";
import { appendMainChatSystemPrompt, buildMainChatSystemPrompt } from "./prompts.js";
import { createMainChatService } from "./service.js";
import { handleMainChatSessionMessage } from "./session.js";
import { registerMainChatTools } from "./tools.js";

const logger = pino({ level: "silent" });
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3 })),
  );
});

interface FakeAgent {
  id: string;
  provider: string;
  cwd: string;
  workspaceId: string | null;
  lifecycle: string;
  background: boolean;
  internal: boolean;
  labels: Record<string, string>;
  config: {
    provider: string;
    cwd: string;
    title?: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
    systemPrompt?: string;
  };
  pendingPermissions: Map<string, unknown>;
  updatedAt: Date;
  createdAt: Date;
  initialPrompt?: string;
}

function createServiceHarness(paseoHome: string) {
  const agents = new Map<string, FakeAgent>();
  let nextAgentNum = 1;

  const agentManager = {
    listAgents: () => Array.from(agents.values()),
    getAgent: (id: string) => agents.get(id) ?? null,
    subscribe: () => () => {},
    getTimeline: () => [],
    getLastAssistantMessage: async () => null,
    hasInFlightRun: () => false,
    updateAgentMetadata: async (
      id: string,
      patch: { labels?: Record<string, string>; title?: string },
    ) => {
      const target = agents.get(id);
      if (!target) return null;
      if (patch.labels) target.labels = { ...target.labels, ...patch.labels };
      if (patch.title) target.config.title = patch.title;
      return target;
    },
    createAgent: async (
      config: FakeAgent["config"],
      agentId?: string,
      options?: {
        workspaceId?: string;
        background?: boolean;
        labels?: Record<string, string>;
      },
    ) => {
      const id = agentId ?? `agent_${nextAgentNum++}`;
      const now = new Date();
      const created: FakeAgent = {
        id,
        provider: config.provider,
        cwd: config.cwd,
        workspaceId: options?.workspaceId ?? null,
        lifecycle: "idle",
        background: options?.background === true,
        internal: false,
        labels: { ...options?.labels },
        config: { ...config },
        pendingPermissions: new Map(),
        updatedAt: now,
        createdAt: now,
      };
      Object.assign(created, {
        metadata: {},
        attention: { requiresAttention: false },
        currentModeId: config.modeId ?? null,
        availableModes: [],
        runtimeInfo: {
          provider: config.provider,
          sessionId: `sess_${id}`,
          model: config.model,
        },
      });
      agents.set(id, created);
      return created;
    },
    tryRunOutOfBand: () => false,
    reloadStalePluginSession: async () => false,
    streamAgent: async function* (
      agentId: string,
      prompt: unknown,
      _runOptions?: unknown,
      promptStart?: { bind?: (run: unknown) => void },
    ) {
      const target = agents.get(agentId);
      if (target) {
        target.initialPrompt = typeof prompt === "string" ? prompt : JSON.stringify(prompt);
      }
      promptStart?.bind?.({
        start: { status: "started" },
        turnStartedPromise: Promise.resolve(),
        settledPromise: new Promise(() => undefined),
      });
      yield { type: "turn_started", provider: "claude" };
      yield { type: "turn_completed", provider: "claude" };
    },
  } as unknown as AgentManager;

  const agentStorage = {
    listActive: async () => [],
    get: async (id: string) => {
      const a = agents.get(id);
      if (!a) return null;
      return {
        id: a.id,
        provider: a.provider,
        cwd: a.cwd,
        workspaceId: a.workspaceId,
        createdAt: a.createdAt.toISOString(),
        updatedAt: a.updatedAt.toISOString(),
        title: a.config.title ?? null,
        labels: { ...a.labels },
        lastStatus: a.lifecycle,
        lastModeId: a.config.modeId ?? null,
        config: {
          model: a.config.model ?? null,
          modeId: a.config.modeId ?? null,
          thinkingOptionId: a.config.thinkingOptionId ?? null,
        },
        background: a.background,
      };
    },
    upsert: async () => {},
  } as unknown as AgentStorage;

  const workspaces = new Map<string, { workspaceId: string; cwd: string; background: boolean }>();
  const workspaceRegistry = {
    listActive: async () => Array.from(workspaces.values()),
    get: async (id: string) => workspaces.get(id) ?? null,
  } as unknown as WorkspaceRegistry;

  const providerSnapshotManager = {
    getSnapshot: () => ({
      records: [
        {
          entry: {
            provider: "claude",
            enabled: true,
            status: "ready",
            models: [{ id: "claude-sonnet-4-5", label: "Sonnet" }],
          },
        },
      ],
    }),
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

  const service = createMainChatService({
    paseoHome,
    worktreesRoot: path.join(paseoHome, "worktrees"),
    serverId: "srv_local",
    hostLabel: "DevBox",
    agentManager,
    agentStorage,
    providerSnapshotManager,
    workspaceRegistry,
    createDirectoryWorkspace: async (cwd) => {
      const ws = { workspaceId: `ws_${workspaces.size + 1}`, cwd, background: false };
      workspaces.set(ws.workspaceId, ws);
      return ws;
    },
    finishSubscriptions: () =>
      ({
        register: async () => ({ accept: () => {}, cancel: () => {} }),
      }) as unknown as ReturnType<
        NonNullable<Parameters<typeof createMainChatService>[0]["finishSubscriptions"]>
      >,
    logger,
  });

  return { service, agents, agentManager };
}

describe("P0-1 memory store, path traversal guard, and prompt budget assembly", () => {
  it("supports full CRUD in <paseoHome>/main-chat/memory/ with deterministic sorting", async () => {
    const home = await makeTempDir("paseo-mem-crud-");
    const store = createMainChatMemoryStore({ paseoHome: home });

    expect(await store.listFiles()).toEqual([]);

    await store.writeFile("notes/zebra.md", "zebra content");
    await store.writeFile("alpha.md", "alpha content");
    await store.writeFile("MEMORY.md", "# Core Preferences\nAlways reply in Chinese.");

    const listed = await store.listFiles();
    expect(listed.map((file) => file.path)).toEqual(["MEMORY.md", "alpha.md", "notes/zebra.md"]);

    const read = await store.readFile("MEMORY.md");
    expect(read.content).toContain("Always reply in Chinese");
    expect(read.bytes).toBeGreaterThan(0);

    const deleted = await store.deleteFile("notes/zebra.md");
    expect(deleted.deleted).toBe(true);
    expect((await store.listFiles()).map((file) => file.path)).toEqual(["MEMORY.md", "alpha.md"]);
    expect((await store.deleteFile("notes/zebra.md")).deleted).toBe(false);
  });

  it("rejects path traversal, absolute paths, dotfiles, bad extensions, oversized writes, and symlinks", async () => {
    const home = await makeTempDir("paseo-mem-sec-");
    const outsideDir = await makeTempDir("paseo-mem-outside-");
    const outsideFile = path.join(outsideDir, "secret.md");
    await writeFile(outsideFile, "TOP_SECRET", "utf8");

    const store = createMainChatMemoryStore({ paseoHome: home });
    await store.writeFile("safe.md", "hello");

    const badPaths = [
      "",
      "   ",
      "../secret.md",
      "a/../../secret.md",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "nested\\file.md",
      ".env",
      ".git/config.md",
      "sub/.hidden.md",
      "notes/./a.md",
      "notes//a.md",
      "notes/a.md/",
      "a/b/c/d/e/f.md",
      "script.sh",
      "file\u0000.md",
    ];

    for (const badPath of badPaths) {
      expect(() => normalizeAndValidateMemoryRelativePath(badPath)).toThrow(MainChatMemoryError);
      await expect(store.readFile(badPath)).rejects.toThrow(MainChatMemoryError);
      await expect(store.writeFile(badPath, "x")).rejects.toThrow(MainChatMemoryError);
      await expect(store.deleteFile(badPath)).rejects.toThrow(MainChatMemoryError);
    }

    // Oversized file write
    const oversized = "a".repeat(MAIN_CHAT_MEMORY_FILE_MAX_BYTES + 16);
    await expect(store.writeFile("huge.md", oversized)).rejects.toThrow(/超过上限/);

    // Symlink escape inside memory directory
    const symlinkPath = path.join(store.memoryRoot, "escape.md");
    await symlink(outsideFile, symlinkPath);
    // Symlink must not appear in listing and must be rejected on read/write/delete
    expect((await store.listFiles()).map((file) => file.path)).toEqual(["safe.md"]);
    await expect(store.readFile("escape.md")).rejects.toThrow(MainChatMemoryError);
    await expect(store.writeFile("escape.md", "overwrite")).rejects.toThrow(MainChatMemoryError);
    await expect(store.deleteFile("escape.md")).rejects.toThrow(MainChatMemoryError);
  });

  it("enforces deterministic UTF-8 byte budgets without splitting multi-byte characters or breaking main-chat rules", () => {
    const truncatedCjk = truncateUtf8ToBytes("中文测试内容".repeat(200), 120);
    expect(truncatedCjk.truncated).toBe(true);
    expect(truncatedCjk.bytes).toBeLessThanOrEqual(120);
    expect(truncatedCjk.text).not.toContain("\uFFFD");

    const assembled = assembleMainChatMemoryContext({
      profile: {
        aboutMe: "我是一名系统架构师。".repeat(300),
        ownerAliases: ["老卡", "Shaw", "老卡"],
      },
      directionTitle: "主对话演进",
      directionNotes: "该方向重点约束：严格保持轨道对齐。".repeat(200),
      memoryFiles: [
        { path: "z-late.md", content: "Z".repeat(2500) },
        { path: "MEMORY.md", content: "核心规则：先跑测试再下结论。".repeat(50) },
        { path: "a-extra.md", content: "A".repeat(2500) },
      ],
      budget: {
        totalMaxBytes: 2400,
        profileMaxBytes: 700,
        directionNotesMaxBytes: 700,
        memoryFilesMaxBytes: 900,
      },
    });

    expect(assembled.totalBytes).toBeLessThanOrEqual(2400);
    expect(assembled.truncated).toBe(true);
    expect(assembled.includedSections.profile).toBe(true);
    expect(assembled.includedSections.directionNotes).toBe(true);
    expect(assembled.includedSections.memoryFiles[0]).toBe("MEMORY.md");
    expect(assembled.text).toContain("老卡、Shaw");
    expect(assembled.text).toContain("## 方向笔记（主对话演进）");
    expect(assembled.text).toContain("### MEMORY.md");

    // Verify injecting into main chat prompt preserves existing rules
    const systemPrompt = buildMainChatSystemPrompt(createDefaultMainChatSettings(), assembled.text);
    expect(systemPrompt).toContain("task_plan");
    expect(systemPrompt).toContain("memory_list");
    expect(systemPrompt).toContain("老卡、Shaw");
    expect(systemPrompt).toContain("### MEMORY.md");

    const appended = appendMainChatSystemPrompt(
      { purpose: "interactive", labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE } },
      ["extra-plugin-rule"],
      createDefaultMainChatSettings(),
      assembled.text,
    );
    expect(appended?.[0]).toContain("### MEMORY.md");
    expect(appended?.[1]).toBe("extra-plugin-rule");
  });
});

describe("P0-1 & P0-2 service, MCP tools, RPC session, direction notes, and mainTasksQuiet", () => {
  it("defaults mainBackgroundFolded and mainTasksQuiet to true and persists profile & toggles", () => {
    const defaults = createDefaultMainChatSettings();
    expect(isMainChatBackgroundFolded(defaults)).toBe(true);
    expect(isMainChatTasksQuiet(defaults)).toBe(true);

    const updated = mergeMainChatSettings(defaults, {
      mainBackgroundFolded: false,
      mainTasksQuiet: false,
      profile: {
        aboutMe: "A".repeat(MAIN_CHAT_ABOUT_ME_MAX_CHARS),
        ownerAliases: ["  Alice  ", "alice", "Boss"],
      },
    });
    expect(isMainChatBackgroundFolded(updated)).toBe(false);
    expect(isMainChatTasksQuiet(updated)).toBe(false);
    expect(updated.profile?.aboutMe.length).toBe(MAIN_CHAT_ABOUT_ME_MAX_CHARS);
    expect(updated.profile?.ownerAliases).toEqual(["Alice", "Boss"]);

    // Switching presets must preserve profile and P0-2 toggles
    const afterPreset = mergeMainChatSettings(updated, { applyPreset: "proactive" });
    expect(afterPreset.mainBackgroundFolded).toBe(false);
    expect(afterPreset.mainTasksQuiet).toBe(false);
    expect(afterPreset.profile?.ownerAliases).toEqual(["Alice", "Boss"]);
  });

  it("injects direction notes into leader system prompt, direction child prompts, and agent launch context", async () => {
    const home = await makeTempDir("paseo-dir-notes-");
    const repoDir = await makeTempDir("paseo-dir-repo-");
    const { service, agents } = createServiceHarness(home);

    await service.updateSettings({
      enabled: true,
      profile: {
        aboutMe: "偏好 TypeScript 严格类型与小步验证。",
        ownerAliases: ["胡同学"],
      },
    });
    await service.writeMemoryFile("MEMORY.md", "全局约定：提交前跑 oxlint 与 typecheck。");

    const ensured = await service.ensureMainChat();
    const mainContext = await service.assembleMemoryContextForAgent({
      purpose: "interactive",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    expect(mainContext).toContain("胡同学");
    expect(mainContext).toContain("偏好 TypeScript 严格类型");
    expect(mainContext).toContain("提交前跑 oxlint");

    const leader = await service.createConversation({
      kind: "leader",
      title: "客户端稳定性",
      directionSummary: "负责前端渲染与状态管理稳定性",
      notes: "方向铁律：Zustand selector 严禁返回新对象引用。",
    });
    expect(leader.notes).toBe("方向铁律：Zustand selector 严禁返回新对象引用。");

    const leaderPrompt = buildLeaderSystemPrompt(leader);
    expect(leaderPrompt).toContain("方向铁律：Zustand selector 严禁返回新对象引用");

    // Leader agent's created config.systemPrompt has direction notes
    const leaderAgent = agents.get(leader.agentId);
    expect(leaderAgent?.config.systemPrompt).toContain("Zustand selector 严禁返回新对象引用");

    // Direction child task spawned under this leader receives direction notes in initialPrompt AND launch appendix
    const plan = await service.createPlan(ensured.agentId, {
      conversationId: leader.id,
      tasks: [
        {
          title: "排查前端选择器",
          goal: "检查 store selector 引用稳定性",
          mode: "readonly",
          cwd: repoDir,
        },
      ],
    });
    expect(plan.tasks[0]?.startError).toBeNull();
    const childAgentId = plan.tasks[0]?.agentId;
    expect(childAgentId).toBeTruthy();
    const childAgent = agents.get(childAgentId!);
    expect(childAgent?.initialPrompt).toContain("方向铁律：Zustand selector 严禁返回新对象引用");

    const childAppendix = await service.assembleMemoryContextForAgent({
      purpose: "interactive",
      labels: {
        [MAIN_CHAT_CONVERSATION_ID_LABEL]: leader.id,
        [MAIN_CHAT_TASK_ID_LABEL]: plan.tasks[0]!.id,
      },
    });
    expect(childAppendix).toContain("方向铁律：Zustand selector 严禁返回新对象引用");

    // Reject direction notes exceeding 4000 characters
    await expect(
      service.updateConversation({
        conversationId: leader.id,
        notes: "超".repeat(MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS + 1),
      }),
    ).rejects.toThrow(/4000/);
  });

  it("inherits mainTasksQuiet in task_plan when quiet is omitted and honors explicit overrides", async () => {
    const home = await makeTempDir("paseo-quiet-inherit-");
    const repoDir = await makeTempDir("paseo-quiet-repo-");
    const { service, agents, agentManager } = createServiceHarness(home);

    await service.updateSettings({ enabled: true, mainTasksQuiet: true });
    const ensured = await service.ensureMainChat();

    // Register real MCP tools and invoke task_plan WITHOUT quiet field
    const tools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager,
      mainChatService: service,
      callerAgentId: ensured.agentId,
      scope: "agent",
      tools,
      builtinNames: new Set(),
    });
    const taskPlanTool = tools.get("task_plan")!;
    expect(taskPlanTool).toBeTruthy();

    // 1) mainTasksQuiet=true, omit quiet -> task.quiet=true & quiet label="true"
    const res1 = await taskPlanTool.handler({
      tasks: [
        {
          title: "静默默认任务",
          goal: "检查日志",
          mode: "readonly",
          cwd: repoDir,
        },
      ],
    });
    const plan1 = (
      res1.structuredContent as { plan: { tasks: Array<{ quiet?: boolean; agentId?: string }> } }
    ).plan;
    expect(plan1.tasks[0]?.quiet).toBe(true);
    expect(isMainChatTaskQuietLabels(agents.get(plan1.tasks[0]!.agentId!)?.labels)).toBe(true);

    // 2) mainTasksQuiet=false, omit quiet -> task.quiet=false & quiet label="false"
    await service.updateSettings({ mainTasksQuiet: false });
    const res2 = await taskPlanTool.handler({
      tasks: [
        {
          title: "非静默继承任务",
          goal: "检查构建",
          mode: "readonly",
          cwd: repoDir,
        },
      ],
    });
    const plan2 = (
      res2.structuredContent as { plan: { tasks: Array<{ quiet?: boolean; agentId?: string }> } }
    ).plan;
    expect(plan2.tasks[0]?.quiet).toBe(false);
    expect(agents.get(plan2.tasks[0]!.agentId!)?.labels[MAIN_CHAT_TASK_QUIET_LABEL]).toBe("false");
    expect(isMainChatTaskQuietLabels(agents.get(plan2.tasks[0]!.agentId!)?.labels)).toBe(false);

    // 3) mainTasksQuiet=false, explicit quiet=true -> task.quiet=true overrides global setting
    const res3 = await taskPlanTool.handler({
      tasks: [
        {
          title: "显式静默覆盖",
          goal: "后台扫描",
          mode: "readonly",
          cwd: repoDir,
          quiet: true,
        },
      ],
    });
    const plan3 = (
      res3.structuredContent as { plan: { tasks: Array<{ quiet?: boolean; agentId?: string }> } }
    ).plan;
    expect(plan3.tasks[0]?.quiet).toBe(true);
    expect(isMainChatTaskQuietLabels(agents.get(plan3.tasks[0]!.agentId!)?.labels)).toBe(true);
  });

  it("handles memory CRUD over both MCP tools and WebSocket session RPCs with traversal rejection", async () => {
    const home = await makeTempDir("paseo-mem-rpc-");
    const { service, agentManager } = createServiceHarness(home);
    await service.updateSettings({ enabled: true });
    const ensured = await service.ensureMainChat();

    const tools = new Map<string, PaseoToolDefinition>();
    registerMainChatTools({
      agentManager,
      mainChatService: service,
      callerAgentId: ensured.agentId,
      scope: "agent",
      tools,
      builtinNames: new Set(),
    });

    // MCP write + list + read + delete
    await tools.get("memory_write")!.handler({
      path: "prefs/style.md",
      content: "Prefer concise Chinese output.",
    });
    const mcpList = (await tools.get("memory_list")!.handler({})).structuredContent as {
      files: Array<{ path: string }>;
    };
    expect(mcpList.files.map((f) => f.path)).toEqual(["prefs/style.md"]);

    const mcpRead = (await tools.get("memory_read")!.handler({ path: "prefs/style.md" }))
      .structuredContent as { file: { content: string } };
    expect(mcpRead.file.content).toBe("Prefer concise Chinese output.");

    // Session RPC CRUD + traversal rejection
    const sent: SessionOutboundMessage[] = [];
    const send = (msg: SessionOutboundMessage) => sent.push(msg);

    await handleMainChatSessionMessage(
      service,
      {
        type: "main_chat.memory_write.request",
        requestId: "req_w1",
        path: "MEMORY.md",
        content: "# 常驻记忆\n- 禁止重启线上 6767 Daemon",
      },
      send,
    );
    await handleMainChatSessionMessage(
      service,
      { type: "main_chat.memory_list.request", requestId: "req_l1" },
      send,
    );
    await handleMainChatSessionMessage(
      service,
      { type: "main_chat.memory_read.request", requestId: "req_r_bad", path: "../../etc/passwd" },
      send,
    );
    await handleMainChatSessionMessage(
      service,
      { type: "main_chat.memory_delete.request", requestId: "req_d1", path: "prefs/style.md" },
      send,
    );

    const writeResp = sent.find((m) => m.type === "main_chat.memory_write.response");
    expect(
      writeResp?.type === "main_chat.memory_write.response" && writeResp.payload.error,
    ).toBeNull();

    const listResp = sent.find((m) => m.type === "main_chat.memory_list.response");
    expect(
      listResp?.type === "main_chat.memory_list.response"
        ? listResp.payload.files.map((f) => f.path)
        : [],
    ).toEqual(["MEMORY.md", "prefs/style.md"]);

    const badReadResp = sent.find((m) => m.type === "main_chat.memory_read.response");
    expect(
      badReadResp?.type === "main_chat.memory_read.response" && badReadResp.payload.error,
    ).toBeTruthy();

    const delResp = sent.find((m) => m.type === "main_chat.memory_delete.response");
    expect(delResp?.type === "main_chat.memory_delete.response" && delResp.payload.deleted).toBe(
      true,
    );
  });

  it("emits structured background folding metadata for patrol/supervision/relay envelopes", () => {
    const patrolPrompt = formatSystemNotificationPrompt("📋 督办 · 主动巡检唤醒：发现 2 条动态", {
      kind: "patrol",
      trigger: "patrol_wakeup",
      label: "巡检发现 2 条动态",
      activityId: "act_123",
      quiet: true,
    });
    const [projectedPatrol] = projectAgentMessages({
      type: "user_message",
      text: patrolPrompt,
    });
    expect(projectedPatrol?.type).toBe("tool_call");
    if (projectedPatrol?.type === "tool_call") {
      const meta = getMainChatBackgroundTurnMetadata(projectedPatrol.metadata);
      expect(meta).toEqual({
        foldable: true,
        kind: "patrol",
        trigger: "patrol_wakeup",
        label: "巡检发现 2 条动态",
        activityId: "act_123",
        quiet: true,
      });
    }

    const relayEnvelope = formatAgentMessage({
      id: "msg_relay_1",
      source: {
        kind: "agent-notification",
        agentId: "child_1",
        title: "修复单测任务",
        event: "finished",
      },
      text: "任务已完成并提交验证证据。",
    });
    const [projectedRelay] = projectAgentMessages({
      type: "user_message",
      text: relayEnvelope,
    });
    expect(projectedRelay?.type).toBe("tool_call");
    if (projectedRelay?.type === "tool_call") {
      const meta = getMainChatBackgroundTurnMetadata(projectedRelay.metadata);
      expect(meta?.foldable).toBe(true);
      expect(meta?.kind).toBe("relay");
      expect(meta?.trigger).toBe("agent_notification:finished");
    }
  });
});
