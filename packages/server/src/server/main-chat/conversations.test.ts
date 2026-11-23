import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIN_CHAT_CONVERSATION_ID_LABEL,
  MAIN_CHAT_CONVERSATION_KIND_LABEL,
  MAIN_CHAT_ROLE_LABEL,
} from "@getpaseo/protocol/main-chat";
import {
  CONVERSATIONS_FILE_NAME,
  MAIN_CONVERSATION_ID,
  MAX_LEADER_CONVERSATIONS,
  MainChatConversationError,
  buildLeaderSystemPrompt,
  buildSideConversationSystemPrompt,
  createMainChatConversationManager,
  getMainChatConversationMetaFromLabels,
  isMainChatConversationLabels,
  type CreateConversationAgentInput,
  type SendConversationPromptInput,
} from "./conversations.js";

describe("MainChatConversationManager", () => {
  let homeDir: string;
  let nowMs: number;
  let agentSeq: number;

  beforeEach(async () => {
    homeDir = await mkdtemp(path.join(os.tmpdir(), "paseo-main-chat-conv-"));
    nowMs = Date.parse("2026-11-23T10:00:00.000Z");
    agentSeq = 0;
  });

  afterEach(async () => {
    await rm(homeDir, { recursive: true, force: true });
  });

  function advanceMs(ms = 1_000): number {
    nowMs += ms;
    return nowMs;
  }

  function createHarness(overrides?: {
    maxLeaderConversations?: number;
    withoutSender?: boolean;
    withoutTailReader?: boolean;
    onCreateAgent?: (input: CreateConversationAgentInput) => void;
    onSendPrompt?: (input: SendConversationPromptInput) => void;
    onSyncAgent?: ReturnType<typeof vi.fn>;
    onArchiveAgent?: ReturnType<typeof vi.fn>;
    tailMessages?: Array<{
      role: "user" | "assistant" | "tool" | "error" | "notification" | "reasoning";
      text: string;
      timestamp: string | null;
    }>;
    tailLifecycle?: string;
  }) {
    const createdAgents: CreateConversationAgentInput[] = [];
    const sentPrompts: SendConversationPromptInput[] = [];
    const syncSpy = overrides?.onSyncAgent ?? vi.fn(async () => undefined);
    const archiveSpy = overrides?.onArchiveAgent ?? vi.fn(async () => undefined);

    const manager = createMainChatConversationManager({
      homeDir,
      defaultServerId: "srv_local",
      now: () => advanceMs(1_000),
      maxLeaderConversations: overrides?.maxLeaderConversations,
      createConversationAgent: async (input) => {
        createdAgents.push(input);
        overrides?.onCreateAgent?.(input);
        agentSeq += 1;
        return {
          agentId: `ag_conv_${agentSeq}`,
          workspaceId: "ws_main_chat",
          serverId: "srv_local",
        };
      },
      sendPromptToAgent: overrides?.withoutSender
        ? undefined
        : async (input) => {
            sentPrompts.push(input);
            overrides?.onSendPrompt?.(input);
          },
      readAgentTail: overrides?.withoutTailReader
        ? undefined
        : async () => ({
            lifecycle: overrides?.tailLifecycle ?? "idle",
            messages: overrides?.tailMessages ?? [],
          }),
      syncConversationAgent: syncSpy,
      archiveConversationAgent: archiveSpy,
    });

    return { manager, createdAgents, sentPrompts, syncSpy, archiveSpy };
  }

  it("ensures and rebinds the root main conversation atomically across restarts", async () => {
    const { manager } = createHarness();

    const main = await manager.ensureMainConversationRecord({
      agentId: "ag_main_1",
      workspaceId: "ws_main_1",
      title: "总控管家",
    });

    expect(main.id).toBe(MAIN_CONVERSATION_ID);
    expect(main.kind).toBe("main");
    expect(main.agentId).toBe("ag_main_1");
    expect(main.workspaceId).toBe("ws_main_1");
    expect(main.title).toBe("总控管家");
    expect(main.archivedAt).toBeNull();
    expect(main.pinnedAsLeaderAt).toBeNull();

    // Rebind on /clear or new_session keeps conversation ID stable while switching agentId.
    const rebound = await manager.rebindMainConversationAgent("ag_main_2", "ws_main_2");
    expect(rebound.id).toBe(MAIN_CONVERSATION_ID);
    expect(rebound.agentId).toBe("ag_main_2");
    expect(rebound.workspaceId).toBe("ws_main_2");
    expect(rebound.createdAt).toBe(main.createdAt);

    // Persisted file exists cleanly with no leftover temp files.
    const files = await readdir(homeDir);
    expect(files).toEqual([CONVERSATIONS_FILE_NAME]);
    const raw = JSON.parse(await readFile(path.join(homeDir, CONVERSATIONS_FILE_NAME), "utf8"));
    expect(raw.version).toBe(1);
    expect(raw.conversations[MAIN_CONVERSATION_ID].agentId).toBe("ag_main_2");

    // Reloading into a new manager instance restores exact state.
    const { manager: reloaded } = createHarness();
    await reloaded.load();
    expect(reloaded.getConversation(MAIN_CONVERSATION_ID)?.agentId).toBe("ag_main_2");
    expect(reloaded.getConversationByAgentId("ag_main_2")?.id).toBe(MAIN_CONVERSATION_ID);
  });

  it("recovers cleanly when main-chat-conversations.json is malformed", async () => {
    await writeFile(path.join(homeDir, CONVERSATIONS_FILE_NAME), "{not-valid-json", "utf8");
    const { manager } = createHarness();
    await manager.load();
    expect(await manager.listConversations()).toEqual([]);
  });

  it("creates isolated side and leader conversations with conversation labels, static prompts, and initialPrompt delivery", async () => {
    const { manager, createdAgents, sentPrompts } = createHarness();
    await manager.ensureMainConversationRecord({
      agentId: "ag_main",
      workspaceId: "ws_main_chat",
    });

    const side = await manager.createConversation({
      kind: "side",
      title: "缓存策略讨论",
      directionSummary: "讨论快照缓存失效边界",
    });

    const leader = await manager.createConversation({
      kind: "leader",
      title: "移动端性能方向",
      directionSummary: "长期优化 iOS/Android 启动与帧率",
      initialPrompt: "请先盘点当前移动端最慢的 3 个页面并起草计划。",
      provider: "claude",
      model: "claude-opus-4-6",
    });

    expect(createdAgents).toHaveLength(2);
    expect(createdAgents[0].labels).toEqual({
      [MAIN_CHAT_CONVERSATION_ID_LABEL]: side.id,
      [MAIN_CHAT_CONVERSATION_KIND_LABEL]: "side",
    });
    // Side/leader agents must never carry `paseo.role=main` so root main-chat discovery stays unambiguous.
    expect(createdAgents[0].labels[MAIN_CHAT_ROLE_LABEL]).toBeUndefined();
    expect(createdAgents[0].systemPrompt).toContain("侧对话「缓存策略讨论」");
    expect(createdAgents[0].systemPrompt).toContain("讨论快照缓存失效边界");

    expect(createdAgents[1].labels).toEqual({
      [MAIN_CHAT_CONVERSATION_ID_LABEL]: leader.id,
      [MAIN_CHAT_CONVERSATION_KIND_LABEL]: "leader",
    });
    expect(createdAgents[1].systemPrompt).toContain("常驻方向主管对话「移动端性能方向」");
    expect(createdAgents[1].systemPrompt).toContain("leader_progress");
    expect(createdAgents[1].systemPrompt).toContain("ask_escalate");

    expect(isMainChatConversationLabels(createdAgents[1].labels)).toBe(true);
    expect(getMainChatConversationMetaFromLabels(createdAgents[1].labels)).toEqual({
      conversationId: leader.id,
      kind: "leader",
    });

    expect(leader.pinnedAsLeaderAt).not.toBeNull();
    expect(leader.parentConversationId).toBe(MAIN_CONVERSATION_ID);
    expect(leader.lastMessageAt).not.toBeNull();
    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toMatchObject({
      conversation: expect.objectContaining({ id: leader.id }),
      prompt: "请先盘点当前移动端最慢的 3 个页面并起草计划。",
      fromConversationId: MAIN_CONVERSATION_ID,
    });
  });

  it("rejects creating a conversation with initialPrompt when sender is not configured without creating an orphan agent", async () => {
    const { manager, createdAgents } = createHarness({ withoutSender: true });

    await expect(
      manager.createConversation({
        kind: "side",
        title: "无投递通道测试",
        initialPrompt: "hello",
      }),
    ).rejects.toMatchObject({
      name: "MainChatConversationError",
      code: "missing_sender",
    });

    expect(createdAgents).toHaveLength(0);
    expect(await manager.listConversations()).toEqual([]);
  });

  it("enforces the 20-leader cap across create, promote, and unarchive while freeing slots on demote/archive", async () => {
    const { manager } = createHarness();
    expect(MAX_LEADER_CONVERSATIONS).toBe(20);

    const leaders = [];
    for (let index = 1; index <= MAX_LEADER_CONVERSATIONS; index += 1) {
      leaders.push(
        await manager.createConversation({
          kind: "leader",
          title: `方向 ${index}`,
        }),
      );
    }

    // 21st leader must fail with clear leader_limit_reached error.
    await expect(
      manager.createConversation({
        kind: "leader",
        title: "方向 21",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof MainChatConversationError &&
        error.code === "leader_limit_reached" &&
        error.message.includes("20")
      );
    });

    // Side conversation creation still succeeds at leader cap.
    const side = await manager.createConversation({
      kind: "side",
      title: "临时侧对话",
    });

    // Promoting side -> leader is blocked while at 20 active leaders.
    await expect(
      manager.updateConversation({
        conversationId: side.id,
        kind: "leader",
      }),
    ).rejects.toMatchObject({ code: "leader_limit_reached" });

    // Demoting one leader frees a slot and clears pinnedAsLeaderAt.
    const demoted = await manager.updateConversation({
      conversationId: leaders[0].id,
      kind: "side",
    });
    expect(demoted.kind).toBe("side");
    expect(demoted.pinnedAsLeaderAt).toBeNull();

    // Now promoting side -> leader succeeds and stamps pinnedAsLeaderAt.
    const promoted = await manager.updateConversation({
      conversationId: side.id,
      kind: "leader",
    });
    expect(promoted.kind).toBe("leader");
    expect(promoted.pinnedAsLeaderAt).not.toBeNull();

    // Archiving a leader frees a slot, then filling it prevents unarchiving the archived leader.
    const archivedLeader = await manager.updateConversation({
      conversationId: leaders[1].id,
      archived: true,
    });
    expect(archivedLeader.archivedAt).not.toBeNull();

    await manager.createConversation({ kind: "leader", title: "补位方向" });
    await expect(
      manager.updateConversation({
        conversationId: archivedLeader.id,
        archived: false,
      }),
    ).rejects.toMatchObject({ code: "leader_limit_reached" });
  });

  it("forbids archiving or changing kind of the main conversation", async () => {
    const { manager } = createHarness();
    await manager.ensureMainConversationRecord({
      agentId: "ag_main",
      workspaceId: "ws_main_chat",
    });

    await expect(
      manager.updateConversation({
        conversationId: MAIN_CONVERSATION_ID,
        archived: true,
      }),
    ).rejects.toMatchObject({ code: "cannot_archive_main" });

    await expect(
      manager.updateConversation({
        conversationId: MAIN_CONVERSATION_ID,
        kind: "leader",
      }),
    ).rejects.toMatchObject({ code: "cannot_change_main_kind" });

    // Renaming main conversation is allowed.
    const renamed = await manager.updateConversation({
      conversationId: MAIN_CONVERSATION_ID,
      title: "新管家名",
    });
    expect(renamed.title).toBe("新管家名");
    expect(renamed.kind).toBe("main");
  });

  it("orders listConversations as main first, leaders by pinnedAsLeaderAt asc, sides by updatedAt desc", async () => {
    const { manager } = createHarness();
    await manager.ensureMainConversationRecord({
      agentId: "ag_main",
      workspaceId: "ws_main_chat",
    });

    const leaderA = await manager.createConversation({ kind: "leader", title: "方向 A" });
    const sideOld = await manager.createConversation({ kind: "side", title: "旧侧对话" });
    const leaderB = await manager.createConversation({ kind: "leader", title: "方向 B" });
    const sideNew = await manager.createConversation({ kind: "side", title: "新侧对话" });
    const archivedSide = await manager.createConversation({ kind: "side", title: "已归档侧对话" });
    await manager.updateConversation({ conversationId: archivedSide.id, archived: true });

    // Touch sideOld so its updatedAt becomes newer than sideNew.
    await manager.updateConversation({ conversationId: sideOld.id, title: "刚更新的侧对话" });

    const activeList = await manager.listConversations();
    expect(activeList.map((entry) => entry.id)).toEqual([
      MAIN_CONVERSATION_ID,
      leaderA.id,
      leaderB.id,
      sideOld.id,
      sideNew.id,
    ]);

    const allList = await manager.listConversations({ includeArchived: true });
    expect(allList.map((entry) => entry.id)).toEqual([
      MAIN_CONVERSATION_ID,
      leaderA.id,
      leaderB.id,
      sideOld.id,
      sideNew.id,
      archivedSide.id,
    ]);
  });

  it("resolves supervising conversation to active leaders and falls back to main for archived, demoted, or unspecified", async () => {
    const { manager } = createHarness();
    await manager.ensureMainConversationRecord({
      agentId: "ag_main_live",
      workspaceId: "ws_main_chat",
      title: "主对话",
    });

    const activeLeader = await manager.createConversation({
      kind: "leader",
      title: "前端架构方向",
    });
    const demotedLeader = await manager.createConversation({
      kind: "leader",
      title: "已降级方向",
    });
    await manager.updateConversation({ conversationId: demotedLeader.id, kind: "side" });

    const archivedLeader = await manager.createConversation({
      kind: "leader",
      title: "已归档方向",
    });
    await manager.updateConversation({ conversationId: archivedLeader.id, archived: true });

    expect(
      manager.resolveSupervisingConversation({
        conversationId: activeLeader.id,
        mainAgentId: "ag_main_live",
      }),
    ).toEqual({
      conversationId: activeLeader.id,
      kind: "leader",
      agentId: activeLeader.agentId,
      title: "前端架构方向",
      fallbackReason: null,
    });

    expect(
      manager.resolveSupervisingConversation({
        conversationId: demotedLeader.id,
        mainAgentId: "ag_main_live",
      }),
    ).toEqual({
      conversationId: MAIN_CONVERSATION_ID,
      kind: "main",
      agentId: "ag_main_live",
      title: "主对话",
      fallbackReason: "not_leader",
    });

    expect(
      manager.resolveSupervisingConversation({
        conversationId: archivedLeader.id,
        mainAgentId: "ag_main_live",
      }),
    ).toEqual({
      conversationId: MAIN_CONVERSATION_ID,
      kind: "main",
      agentId: "ag_main_live",
      title: "主对话",
      fallbackReason: "archived",
    });

    expect(
      manager.resolveSupervisingConversation({
        conversationId: null,
        mainAgentId: "ag_main_live",
      }),
    ).toEqual({
      conversationId: MAIN_CONVERSATION_ID,
      kind: "main",
      agentId: "ag_main_live",
      title: "主对话",
      fallbackReason: "unspecified",
    });

    expect(
      manager.resolveSupervisingConversation({
        conversationId: "conv_missing",
        mainAgentId: "ag_main_live",
      }),
    ).toEqual({
      conversationId: MAIN_CONVERSATION_ID,
      kind: "main",
      agentId: "ag_main_live",
      title: "主对话",
      fallbackReason: "not_found",
    });
  });

  it("sends messages, rejects archived targets, and truncates readConversationTail within context budgets", async () => {
    const longMessages = Array.from({ length: 12 }, (_, index) => ({
      role: (index % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `msg-${index + 1}: ${"x".repeat(120)}`,
      timestamp: `2026-11-23T10:0${index % 9}:00.000Z`,
    }));

    const { manager, sentPrompts, syncSpy, archiveSpy } = createHarness({
      tailMessages: longMessages,
      tailLifecycle: "running",
    });

    const leader = await manager.createConversation({
      kind: "leader",
      title: "数据链路方向",
    });

    const sent = await manager.sendToConversation(leader.id, "请核对今日延迟指标", {
      fromConversationId: MAIN_CONVERSATION_ID,
      fromTitle: "对话管理",
    });
    expect(sent.conversation.lastMessageAt).toBe(sent.deliveredAt);
    expect(sentPrompts).toHaveLength(1);

    const tail = await manager.readConversationTail(leader.id, {
      limit: 5,
      maxCharsPerMessage: 60,
      maxTotalChars: 150,
    });
    expect(tail.lifecycle).toBe("running");
    expect(tail.truncated).toBe(true);
    expect(tail.messages.length).toBeGreaterThan(0);
    // Newest message must be retained at the end.
    expect(tail.messages[tail.messages.length - 1].text).toContain("msg-12:");
    expect(tail.messages.every((item) => item.text.length <= 60)).toBe(true);

    // Sync & archive hooks fire on metadata change and archival.
    await manager.updateConversation({
      conversationId: leader.id,
      directionSummary: "更新方向说明",
    });
    expect(syncSpy).toHaveBeenCalledTimes(1);

    await manager.updateConversation({ conversationId: leader.id, archived: true });
    expect(archiveSpy).toHaveBeenCalledTimes(1);

    await expect(manager.sendToConversation(leader.id, "归档后再发")).rejects.toMatchObject({
      code: "conversation_archived",
    });
  });

  it("builds purely static system prompts without dynamic fleet snapshots or timestamps", () => {
    const leaderPrompt = buildLeaderSystemPrompt({
      id: "conv_leader_1",
      title: "核心引擎",
      directionSummary: "负责同步与协议演进",
    });
    const sidePrompt = buildSideConversationSystemPrompt({
      id: "conv_side_1",
      title: "RFC 评审",
      directionSummary: null,
    });

    expect(leaderPrompt).toContain("核心引擎");
    expect(leaderPrompt).toContain("负责同步与协议演进");
    expect(leaderPrompt).toContain("leader_progress");
    expect(leaderPrompt).toContain("ask_escalate");
    expect(leaderPrompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);

    expect(sidePrompt).toContain("RFC 评审");
    expect(sidePrompt).toContain("conversation_send");
    expect(sidePrompt).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
