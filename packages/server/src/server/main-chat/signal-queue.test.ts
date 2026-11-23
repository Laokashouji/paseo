import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MainChatSupervisionSignalSchema,
  type MainChatSupervisionSignal,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import {
  ALL_STOPPED_THRESHOLD_MS,
  ALL_SUPERVISION_SIGNAL_KINDS,
  SUPERVISE_GATHER_MS,
  SUPERVISE_NORMAL_COOLDOWN_MS,
  SUPERVISE_URGENT_COOLDOWN_MS,
  createSupervisionSignalQueue,
  detectAllStoppedTasks,
  formatSupervisionDigest,
  getSupervisionSignalMeta,
  isSignalQuietSuppressible,
  type DeliverSupervisionBatchPayload,
} from "./signal-queue.js";
import { parseUsageLimitWakeAt } from "./triage.js";

function makeTaskRecord(overrides: Partial<MainChatTaskRecord> = {}): MainChatTaskRecord {
  const nowIso = "2026-11-23T10:00:00.000Z";
  return {
    id: overrides.id ?? "task_1",
    mainAgentId: "agent_main",
    conversationId: overrides.conversationId ?? null,
    planId: "plan_1",
    title: overrides.title ?? "重构督办器",
    mode: "write",
    isolation: "worktree",
    serverId: "srv_local",
    hostLabel: "DevBox",
    cwd: "/repo/app",
    workspaceId: "ws_1",
    workspaceLabel: "app",
    status: overrides.status ?? "running",
    brief: {
      goal: "落地 M5 督办闭环",
      doneWhen: ["单测通过"],
      outOfBounds: [],
      scopeRevision: 1,
      updatedAt: nowIso,
    },
    agentIds: overrides.agentIds ?? ["agent_child_1"],
    activeAgentId: overrides.activeAgentId ?? "agent_child_1",
    quiet: overrides.quiet ?? true,
    lastActivityAt: overrides.lastActivityAt ?? nowIso,
    createdAt: nowIso,
    updatedAt: overrides.updatedAt ?? nowIso,
  };
}

describe("main-chat signal-queue (M5)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("supports all 26 protocol supervision signal kinds with structured schemas and digest output", () => {
    expect(ALL_SUPERVISION_SIGNAL_KINDS).toHaveLength(26);

    const delivered: DeliverSupervisionBatchPayload[] = [];
    const queue = createSupervisionSignalQueue({
      revalidateSignal: () => true,
      onDeliver: (batch) => {
        delivered.push(batch);
        return true;
      },
      autoScheduleTimers: false,
    });

    for (const kind of ALL_SUPERVISION_SIGNAL_KINDS) {
      const meta = getSupervisionSignalMeta(kind);
      expect(meta.label.length).toBeGreaterThan(0);

      const enqueued = queue.enqueue({
        kind,
        // Keep `failed` non-immediate here so all 26 sit in one structured batch check.
        urgency: kind === "failed" ? "urgent" : meta.defaultUrgency,
        taskId: `task_${kind}`,
        agentId: `agent_${kind}`,
        serverId: "srv_local",
        title: `任务-${kind}`,
        summary: `信号 ${kind} 摘要`,
      });
      expect(enqueued.queued).toBe(true);
      expect(MainChatSupervisionSignalSchema.safeParse(enqueued.signal).success).toBe(true);
    }

    const pending = queue.listPending();
    expect(pending).toHaveLength(26);
    const digest = formatSupervisionDigest(pending);
    expect(digest).toContain("📋 督办");
    expect(digest).toContain("汇总 26 条最新有效动态");
    for (const kind of ALL_SUPERVISION_SIGNAL_KINDS) {
      expect(digest).toContain(`[${kind}·`);
    }

    queue.stop();
  });

  it("coalesces signals within the 15s gather window per conversation and isolates leader buckets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T10:00:00.000Z"));

    const delivered: DeliverSupervisionBatchPayload[] = [];
    const queue = createSupervisionSignalQueue({
      revalidateSignal: () => true,
      onDeliver: (batch) => {
        delivered.push(batch);
        return true;
      },
    });

    queue.enqueue({
      kind: "review",
      taskId: "task_a",
      agentId: "agent_a",
      conversationId: null,
      title: "任务 A",
      summary: "任务 A 完工待验收",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    queue.enqueue({
      kind: "stalled",
      taskId: "task_b",
      agentId: "agent_b",
      conversationId: null,
      title: "任务 B",
      summary: "任务 B 静默停滞",
    });
    queue.enqueue({
      kind: "review",
      taskId: "task_leader_1",
      agentId: "agent_l1",
      conversationId: "conv_leader_pay",
      title: "支付方向任务",
      summary: "支付任务待验收",
    });

    // At t=14s (1s before main gather closes), nothing delivered yet.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(delivered).toHaveLength(0);

    // At t=15s, main bucket delivers both task_a and task_b in ONE coalesced digest.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.conversationId).toBeNull();
    expect(delivered[0]?.signals.map((s) => s.taskId).sort()).toEqual(["task_a", "task_b"]);
    expect(delivered[0]?.digest).toContain("📋 督办");

    // At t=20s (15s after conv_leader_pay opened at t=5s), leader bucket delivers separately.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.conversationId).toBe("conv_leader_pay");
    expect(delivered[1]?.signals).toHaveLength(1);

    queue.stop();
  });

  it("enforces 10m normal cooldown, 2m urgent cooldown, and immediate bypass", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T10:00:00.000Z"));

    const delivered: DeliverSupervisionBatchPayload[] = [];
    const queue = createSupervisionSignalQueue({
      revalidateSignal: () => true,
      onDeliver: (batch) => {
        delivered.push(batch);
        return true;
      },
    });

    // 1. Initial normal delivery after 15s gather
    queue.enqueue({
      kind: "review",
      agentId: "a1",
      title: "初始任务",
      summary: "首次验收",
    });
    await vi.advanceTimersByTimeAsync(SUPERVISE_GATHER_MS);
    expect(delivered).toHaveLength(1);

    // 2. Normal signal during 10m cooldown is held for full 10m
    queue.enqueue({
      kind: "idle",
      agentId: "a2",
      title: "普通任务",
      summary: "停止未完工",
    });
    await vi.advanceTimersByTimeAsync(SUPERVISE_NORMAL_COOLDOWN_MS - 1_000);
    expect(delivered).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]?.signals[0]?.kind).toBe("idle");

    // 3. Urgent signal during cooldown shortens wait from 10m to 2m
    queue.enqueue({
      kind: "check",
      agentId: "a3",
      title: "普通检查",
      summary: "例行检查",
    });
    await vi.advanceTimersByTimeAsync(30_000);
    queue.enqueue({
      kind: "needs_you",
      urgency: "urgent",
      agentId: "a4",
      title: "阻塞拍板",
      summary: "等待确认方案",
    });
    await vi.advanceTimersByTimeAsync(SUPERVISE_URGENT_COOLDOWN_MS - 30_000 - 1_000);
    expect(delivered).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toHaveLength(3);
    expect(delivered[2]?.hasUrgent).toBe(true);
    expect(delivered[2]?.signals).toHaveLength(2);

    // 4. Immediate signal (e.g. first launch failure) bypasses BOTH 15s gather and 2m cooldown
    const immediateRes = queue.enqueue({
      kind: "failed",
      urgency: "immediate",
      agentId: "a5",
      title: "首次启动失败",
      summary: "worktree 创建失败",
    });
    await immediateRes.immediateFlushPromise;
    expect(delivered).toHaveLength(4);
    expect(delivered[3]?.hasImmediate).toBe(true);
    expect(delivered[3]?.signals[0]?.kind).toBe("failed");

    queue.stop();
  });

  it("revalidates signals right before dequeue, drops stale items, and skips wakeup completely when all stale", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-23T10:00:00.000Z"));

    const liveValid = new Set<string>(["task_stale_1", "task_stale_2"]);
    const onDeliver = vi.fn(() => true);
    const queue = createSupervisionSignalQueue({
      revalidateSignal: (signal: MainChatSupervisionSignal) =>
        signal.taskId ? liveValid.has(signal.taskId) : true,
      onDeliver,
    });

    queue.enqueue({
      kind: "review",
      taskId: "task_stale_1",
      agentId: "agent_1",
      title: "已验收任务",
      summary: "完工待验收",
    });
    queue.enqueue({
      kind: "stalled",
      taskId: "task_stale_2",
      agentId: "agent_2",
      title: "已恢复任务",
      summary: "静默停滞",
    });

    // Both tasks resolve during the 15s gather window -> 0 tokens consumed!
    liveValid.clear();
    await vi.advanceTimersByTimeAsync(SUPERVISE_GATHER_MS);

    expect(onDeliver).not.toHaveBeenCalled();
    expect(queue.getPendingCount()).toBe(0);
    expect(queue.getBucketLastDeliveredAtMs(null)).toBe(0);

    // Next batch with 1 stale + 1 fresh -> drops stale, delivers ONLY fresh!
    liveValid.add("task_fresh");
    queue.enqueue({
      kind: "review",
      taskId: "task_expired",
      agentId: "agent_old",
      title: "过时任务",
      summary: "已经完成",
    });
    queue.enqueue({
      kind: "needs_you",
      taskId: "task_fresh",
      agentId: "agent_live",
      title: "仍需拍板",
      summary: "等待确认",
    });

    const flushResult = await queue.flushBucket(null, { force: true });
    expect(flushResult.delivered).toBe(true);
    expect(flushResult.skippedAllStale).toBe(false);
    expect(flushResult.droppedSignals).toHaveLength(1);
    expect(flushResult.droppedSignals[0]?.signal.taskId).toBe("task_expired");
    expect(flushResult.deliveredSignals).toHaveLength(1);
    expect(flushResult.deliveredSignals[0]?.taskId).toBe("task_fresh");
    expect(onDeliver).toHaveBeenCalledTimes(1);

    queue.stop();
  });

  it("detects 30-minute all_stopped tasks while skipping running, scheduled-retry, parked, or completed tasks", () => {
    const baseMs = Date.parse("2026-11-23T12:00:00.000Z");
    const fortyMinAgoIso = new Date(baseMs - 40 * 60_000).toISOString();
    const tenMinAgoIso = new Date(baseMs - 10 * 60_000).toISOString();

    const stoppedTask = makeTaskRecord({
      id: "task_all_stopped",
      status: "running",
      agentIds: ["a_stop_1", "a_stop_2"],
      activeAgentId: "a_stop_2",
      lastActivityAt: fortyMinAgoIso,
    });
    const stillRunningTask = makeTaskRecord({
      id: "task_still_running",
      status: "running",
      agentIds: ["a_stop_3", "a_run_1"],
      activeAgentId: "a_run_1",
      lastActivityAt: fortyMinAgoIso,
    });
    const retryingTask = makeTaskRecord({
      id: "task_has_retry",
      status: "running",
      agentIds: ["a_retry_1"],
      activeAgentId: "a_retry_1",
      lastActivityAt: fortyMinAgoIso,
    });
    const recentStoppedTask = makeTaskRecord({
      id: "task_recent",
      status: "running",
      agentIds: ["a_recent"],
      activeAgentId: "a_recent",
      lastActivityAt: tenMinAgoIso,
    });
    const parkedTask = makeTaskRecord({
      id: "task_parked",
      status: "parked",
      agentIds: ["a_parked"],
      activeAgentId: "a_parked",
      lastActivityAt: fortyMinAgoIso,
    });

    const liveStates: Record<string, { lifecycle: string; updatedAtMs: number }> = {
      a_stop_1: { lifecycle: "idle", updatedAtMs: baseMs - 35 * 60_000 },
      a_stop_2: { lifecycle: "idle", updatedAtMs: baseMs - 32 * 60_000 },
      a_stop_3: { lifecycle: "idle", updatedAtMs: baseMs - 35 * 60_000 },
      a_run_1: { lifecycle: "running", updatedAtMs: baseMs - 35 * 60_000 },
      a_retry_1: { lifecycle: "idle", updatedAtMs: baseMs - 40 * 60_000 },
      a_recent: { lifecycle: "idle", updatedAtMs: baseMs - 10 * 60_000 },
      a_parked: { lifecycle: "idle", updatedAtMs: baseMs - 40 * 60_000 },
    };

    const detected = detectAllStoppedTasks({
      tasks: [stoppedTask, stillRunningTask, retryingTask, recentStoppedTask, parkedTask],
      getLiveAgentState: (id) => liveStates[id] ?? null,
      hasPendingRetry: (id) => id === "a_retry_1",
      nowMs: baseMs,
      thresholdMs: ALL_STOPPED_THRESHOLD_MS,
    });

    expect(detected).toHaveLength(1);
    expect(detected[0]?.task.id).toBe("task_all_stopped");
    expect(detected[0]?.stoppedMinutes).toBe(32);
  });

  it("classifies quiet-task badge suppression and parses usage-limit wake_at timestamps", () => {
    expect(isSignalQuietSuppressible("review")).toBe(true);
    expect(isSignalQuietSuppressible("transient_retry")).toBe(true);
    expect(isSignalQuietSuppressible("ask")).toBe(true);
    expect(isSignalQuietSuppressible("needs_you")).toBe(false);
    expect(isSignalQuietSuppressible("failed")).toBe(false);
    expect(isSignalQuietSuppressible("ask", { isRedLine: true })).toBe(false);
    expect(isSignalQuietSuppressible("review", { escalatedToUser: true })).toBe(false);

    const nowMs = Date.parse("2026-11-23T10:00:00.000Z");
    const isoParsed = parseUsageLimitWakeAt(
      "Usage limit hit. wake_at=2026-11-23T11:30:00.000Z",
      nowMs,
    );
    expect(isoParsed.parsedExplicitly).toBe(true);
    expect(isoParsed.delayMs).toBe(90 * 60_000);
    expect(isoParsed.wakeAtIso).toBe("2026-11-23T11:30:00.000Z");

    const relParsed = parseUsageLimitWakeAt("额度达到上限，将在 25 分钟后重置", nowMs);
    expect(relParsed.parsedExplicitly).toBe(true);
    expect(relParsed.delayMs).toBe(25 * 60_000);
  });
});
