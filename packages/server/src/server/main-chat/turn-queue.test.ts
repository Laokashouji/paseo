import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIN_CHAT_ROLE_LABEL, MAIN_CHAT_ROLE_VALUE } from "@getpaseo/protocol/main-chat";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import { createMainChatStore } from "./store.js";
import { createMainChatTurnQueue } from "./turn-queue.js";

function createSilentLogger() {
  return pino({ level: "silent" });
}

async function flushMicrotasks(delayMs = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

describe("main-chat turn-queue: preemption, priority merge, silent audit & missing-reply recovery", () => {
  let tempDir: string;
  let nowMs: number;
  let subscribers: Set<(event: AgentManagerEvent) => void>;
  let mainAgent: ManagedAgent;
  let storedMain: StoredAgentRecord;
  let running: boolean;
  let sentPrompts: Array<{ agentId: string; prompt: unknown }>;
  let cancelCalls: string[];
  let clearAttentionCalls: string[];
  let agentManager: AgentManager;
  let agentStorage: AgentStorage;

  function emit(event: AgentManagerEvent) {
    for (const cb of subscribers) {
      cb(event);
    }
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-main-chat-tq-"));
    nowMs = 1_700_000_000_000;
    subscribers = new Set();
    running = false;
    sentPrompts = [];
    cancelCalls = [];
    clearAttentionCalls = [];

    mainAgent = {
      id: "agent_main",
      provider: "claude",
      cwd: tempDir,
      workspaceId: "ws_main",
      config: { provider: "claude", cwd: tempDir, title: "对话管理" },
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      metadata: {},
      lifecycle: "idle",
      attention: { requiresAttention: false },
      currentModeId: "default",
      availableModes: [],
      pendingPermissions: new Map(),
      internal: false,
      background: false,
      updatedAt: new Date(nowMs),
    } as unknown as ManagedAgent;

    storedMain = {
      id: "agent_main",
      provider: "claude",
      cwd: tempDir,
      workspaceId: "ws_main",
      createdAt: new Date(nowMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      title: "对话管理",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      lastStatus: "idle",
      background: false,
    } as unknown as StoredAgentRecord;

    agentManager = {
      getAgent: (id: string) => (id === mainAgent.id ? mainAgent : null),
      listAgents: () => [mainAgent],
      subscribe: (cb: (event: AgentManagerEvent) => void) => {
        subscribers.add(cb);
        return () => subscribers.delete(cb);
      },
      tryRunOutOfBand: vi.fn(async () => false),
      hasInFlightRun: vi.fn(() => running),
      reloadStalePluginSession: vi.fn(async () => false),
      replaceAgentRun: vi.fn(async function* (
        agentId: string,
        prompt: unknown,
        _runOptions?: unknown,
        promptStart?: { bind?: (run: unknown) => void },
      ) {
        sentPrompts.push({ agentId, prompt });
        running = true;
        (mainAgent as unknown as { lifecycle: string }).lifecycle = "running";
        promptStart?.bind?.({
          start: { status: "started" },
          turnStartedPromise: Promise.resolve(),
          settledPromise: new Promise(() => undefined),
        });
        emit({
          type: "agent_stream",
          agentId,
          event: { type: "turn_started", provider: "claude" },
        });
        yield { type: "turn_started", provider: "claude" };
      }),
      steerOrReplaceActiveTurn: vi.fn(),
      streamAgent: vi.fn(async function* (
        agentId: string,
        prompt: unknown,
        _runOptions?: unknown,
        promptStart?: { bind?: (run: unknown) => void },
      ) {
        sentPrompts.push({ agentId, prompt });
        running = true;
        (mainAgent as unknown as { lifecycle: string }).lifecycle = "running";
        promptStart?.bind?.({
          start: { status: "started" },
          turnStartedPromise: Promise.resolve(),
          settledPromise: new Promise(() => undefined),
        });
        emit({
          type: "agent_stream",
          agentId,
          event: { type: "turn_started", provider: "claude" },
        });
        yield { type: "turn_started", provider: "claude" };
      }),
      cancelAgentRun: vi.fn(async (agentId: string) => {
        cancelCalls.push(agentId);
        running = false;
        (mainAgent as unknown as { lifecycle: string }).lifecycle = "idle";
        emit({
          type: "agent_stream",
          agentId,
          event: { type: "turn_canceled", provider: "claude" },
        });
        return { status: "settled" as const };
      }),
      clearAgentAttention: vi.fn(async (agentId: string) => {
        clearAttentionCalls.push(agentId);
      }),
      notifyAgentState: vi.fn(),
      unarchiveSnapshot: vi.fn(),
      reloadAgentSession: vi.fn(),
      getTimeline: vi.fn(() => []),
    } as unknown as AgentManager;

    agentStorage = {
      get: async (id: string) => (id === storedMain.id ? storedMain : null),
      listActive: async () => (storedMain.archivedAt ? [] : [storedMain]),
    } as unknown as AgentStorage;
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("queues background wakeups behind foreground turns, merges by dedupeKey, and drains in priority order", async () => {
    const store = createMainChatStore(tempDir);
    await store.load();
    const queue = createMainChatTurnQueue({
      agentManager,
      agentStorage,
      store,
      logger: createSilentLogger(),
      now: () => nowMs,
      drainDelayMs: 5,
    });
    queue.start();

    // Foreground user turn is active.
    const release = queue.beginForegroundDispatch("agent_main");
    running = true;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "running";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_started", provider: "claude" },
    });
    release();

    // Enqueue low-priority patrol twice with the same dedupeKey, plus a higher-priority urgent item.
    const first = await queue.enqueueBackground({
      mainAgentId: "agent_main",
      dedupeKey: "patrol:wakeup",
      trigger: "patrol_wakeup",
      priority: 10,
      summary: "第一次巡检",
      buildPrompt: () => "巡检内容 v1",
    });
    const merged = await queue.enqueueBackground({
      mainAgentId: "agent_main",
      dedupeKey: "patrol:wakeup",
      trigger: "patrol_wakeup",
      priority: 10,
      summary: "合并后的巡检",
      buildPrompt: () => "巡检内容 v2（已合并）",
    });
    const urgent = await queue.enqueueBackground({
      mainAgentId: "agent_main",
      dedupeKey: "urgent:decision",
      trigger: "urgent_patrol",
      priority: 25,
      summary: "紧急阻塞唤醒",
      buildPrompt: () => "紧急阻塞通知",
    });

    expect(first.status).toBe("queued");
    expect(merged.status).toBe("queued");
    expect(merged.activityId).toBe(first.activityId);
    expect(urgent.status).toBe("queued");
    expect(queue.getQueuedCount("agent_main")).toBe(2);
    expect(sentPrompts).toHaveLength(0);

    // Foreground turn finishes with a normal visible reply.
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "好的，已帮你查好。" },
      },
    });
    running = false;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "idle";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_completed", provider: "claude" },
    });

    await flushMicrotasks(30);
    // Higher-priority urgent item drains FIRST.
    expect(sentPrompts).toHaveLength(1);
    expect(String(sentPrompts[0]?.prompt)).toContain("紧急阻塞通知");

    // Finish the urgent background turn -> merged v2 patrol drains next (v1 never sent!).
    running = false;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "idle";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "已处理紧急通知。" },
      },
    });
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_completed", provider: "claude" },
    });

    await flushMicrotasks(30);
    expect(sentPrompts).toHaveLength(2);
    expect(String(sentPrompts[1]?.prompt)).toContain("巡检内容 v2（已合并）");

    queue.stop();
  });

  it("preempts active background turn on foreground user input, cancels run, and re-queues for idle redelivery", async () => {
    const store = createMainChatStore(tempDir);
    await store.load();
    const queue = createMainChatTurnQueue({
      agentManager,
      agentStorage,
      store,
      logger: createSilentLogger(),
      now: () => nowMs,
      drainDelayMs: 5,
    });
    queue.start();

    let buildCount = 0;
    const dispatched = await queue.enqueueBackground({
      mainAgentId: "agent_main",
      dedupeKey: "patrol:wakeup",
      trigger: "patrol_wakeup",
      summary: "后台巡检汇总",
      buildPrompt: () => {
        buildCount += 1;
        return `巡检批次 #${buildCount}`;
      },
    });
    expect(dispatched.status).toBe("dispatched");
    expect(queue.isBackgroundBusy("agent_main")).toBe(true);
    expect(sentPrompts).toHaveLength(1);

    // User sends foreground message while background turn is still running.
    const release = queue.beginForegroundDispatch("agent_main");
    const preemption = await queue.preemptForForegroundUser("agent_main");
    expect(preemption.preempted).toBe(true);
    expect(cancelCalls).toEqual(["agent_main"]);
    expect(queue.isBackgroundBusy("agent_main")).toBe(false);
    expect(queue.getQueuedCount("agent_main")).toBe(1);

    const preemptedEntries = store.listActivities({
      mainAgentId: "agent_main",
      kind: "preempted",
    });
    expect(preemptedEntries.total).toBe(1);
    expect(preemptedEntries.activities[0]?.preemptedByUser).toBe(true);
    expect(preemptedEntries.activities[0]?.status).toBe("preempted");
    expect(store.getMetrics().preemptedTurns).toBe(1);

    // Foreground turn executes and completes.
    running = true;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "running";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_started", provider: "claude" },
    });
    release();
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "直接响应用户问题。" },
      },
    });
    running = false;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "idle";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_completed", provider: "claude" },
    });

    // Re-queued background turn re-validates buildPrompt() and dispatches cleanly once idle.
    await flushMicrotasks(35);
    expect(buildCount).toBe(2);
    expect(sentPrompts).toHaveLength(2);
    expect(String(sentPrompts[1]?.prompt)).toContain("巡检批次 #2");

    queue.stop();
  });

  it("marks silent background turns as silent_turn and clears foreground attention", async () => {
    const store = createMainChatStore(tempDir);
    await store.load();
    const queue = createMainChatTurnQueue({
      agentManager,
      agentStorage,
      store,
      logger: createSilentLogger(),
      now: () => nowMs,
      drainDelayMs: 5,
    });
    queue.start();

    let completedOutcome: { silent: boolean; assistantText: string } | null = null;
    await queue.enqueueBackground({
      mainAgentId: "agent_main",
      dedupeKey: "patrol:silent",
      trigger: "patrol_wakeup",
      summary: "静默巡检测试",
      buildPrompt: () => "检查状态",
      onCompleted: (outcome) => {
        completedOutcome = outcome;
      },
    });

    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "[SILENT]" },
      },
    });
    running = false;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "idle";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_completed", provider: "claude" },
    });

    await flushMicrotasks(25);
    expect(completedOutcome).toEqual({ silent: true, assistantText: "[SILENT]" });
    expect(clearAttentionCalls).toEqual(["agent_main"]);
    expect(store.getMetrics().silentTurns).toBe(1);

    const silentList = store.listActivities({
      mainAgentId: "agent_main",
      kind: "silent_turn",
      includeSilent: true,
    });
    expect(silentList.total).toBe(1);
    expect(silentList.activities[0]?.silent).toBe(true);
    expect(silentList.activities[0]?.status).toBe("completed");

    const visibleOnly = store.listActivities({
      mainAgentId: "agent_main",
      includeSilent: false,
    });
    expect(visibleOnly.total).toBe(0);

    queue.stop();
  });

  it("triggers missing-reply recovery at most once per foreground user turn and skips canceled or silent turns", async () => {
    const store = createMainChatStore(tempDir);
    await store.load();
    const queue = createMainChatTurnQueue({
      agentManager,
      agentStorage,
      store,
      logger: createSilentLogger(),
      now: () => nowMs,
      drainDelayMs: 5,
    });
    queue.start();

    // Turn 1: foreground calls a tool but ends with NO visible assistant text -> triggers recovery ONCE.
    running = true;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "running";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_started", provider: "claude" },
    });
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          callId: "call_1",
          name: "task_list",
          status: "completed",
          error: null,
        },
      },
    });
    running = false;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "idle";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_completed", provider: "claude" },
    });

    await flushMicrotasks(35);
    expect(sentPrompts).toHaveLength(1);
    expect(String(sentPrompts[0]?.prompt)).toContain("系统自动补答提醒");
    expect(store.getMetrics().missingReplyRecoveries).toBe(1);

    // Even if the recovery turn itself runs a tool and produces empty text, MUST NOT loop!
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          callId: "call_2",
          name: "task_list",
          status: "completed",
          error: null,
        },
      },
    });
    running = false;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "idle";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_completed", provider: "claude" },
    });
    await flushMicrotasks(35);
    expect(sentPrompts).toHaveLength(1);
    expect(store.getMetrics().missingReplyRecoveries).toBe(1);

    const recoveries = store.listActivities({
      mainAgentId: "agent_main",
      kind: "missing_reply_recovery",
    });
    expect(recoveries.total).toBe(1);
    expect(recoveries.activities[0]?.status).toBe("completed");

    // Turn 2: canceled foreground tool turn -> MUST NOT trigger recovery.
    running = true;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "running";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_started", provider: "claude" },
    });
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          callId: "call_3",
          name: "task_list",
          status: "completed",
          error: null,
        },
      },
    });
    running = false;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "idle";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_canceled", provider: "claude" },
    });
    await flushMicrotasks(30);
    expect(sentPrompts).toHaveLength(1);

    // Turn 3: foreground tool turn returning [SILENT] -> MUST NOT trigger recovery.
    running = true;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "running";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_started", provider: "claude" },
    });
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "tool_call",
          callId: "call_4",
          name: "task_list",
          status: "completed",
          error: null,
        },
      },
    });
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: {
        type: "timeline",
        provider: "claude",
        item: { type: "assistant_message", text: "[SILENT]" },
      },
    });
    running = false;
    (mainAgent as unknown as { lifecycle: string }).lifecycle = "idle";
    emit({
      type: "agent_stream",
      agentId: "agent_main",
      event: { type: "turn_completed", provider: "claude" },
    });
    await flushMicrotasks(30);
    expect(sentPrompts).toHaveLength(1);

    queue.stop();
  });
});
