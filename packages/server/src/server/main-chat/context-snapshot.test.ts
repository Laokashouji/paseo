import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import {
  MAX_INLINE_RUNNING_ITEMS,
  MAX_SNAPSHOT_CHARS,
  SNAPSHOT_CACHE_TTL_MS,
  SNAPSHOT_FOREGROUND_TIMEOUT_MS,
  createMainChatContextSnapshotBuilder,
} from "./context-snapshot.js";
import { createMainChatStore } from "./store.js";

function makeLiveAgent(input: {
  id: string;
  title: string;
  lifecycle?: string;
  pendingPermissionTitle?: string;
  lastError?: string | null;
  requiresAttention?: boolean;
  updatedAtMs?: number;
}): ManagedAgent {
  const pendingPermissions = new Map<string, { id: string; title: string; name: string }>();
  if (input.pendingPermissionTitle) {
    pendingPermissions.set("perm_1", {
      id: "perm_1",
      title: input.pendingPermissionTitle,
      name: "Bash",
    });
  }
  return {
    id: input.id,
    provider: "claude",
    cwd: `/tmp/projects/${input.id}`,
    workspaceId: `ws_${input.id}`,
    config: { provider: "claude", cwd: `/tmp/projects/${input.id}`, title: input.title },
    labels: {},
    metadata: {},
    lifecycle: input.lifecycle ?? "idle",
    attention: {
      requiresAttention: input.requiresAttention === true,
      attentionReason: input.requiresAttention ? "finished" : null,
    },
    pendingPermissions,
    lastError: input.lastError ?? null,
    internal: false,
    background: false,
    updatedAt: new Date(input.updatedAtMs ?? 1_700_000_000_000),
  } as unknown as ManagedAgent;
}

describe("main-chat context-snapshot v2", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "paseo-main-chat-snap-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exports expected v2 budget and cache constants", () => {
    expect(MAX_SNAPSHOT_CHARS).toBe(6_000);
    expect(SNAPSHOT_CACHE_TTL_MS).toBe(45_000);
    expect(SNAPSHOT_FOREGROUND_TIMEOUT_MS).toBe(1_500);
    expect(MAX_INLINE_RUNNING_ITEMS).toBe(3);
  });

  it("computes section and line-level diffs (+ added/updated, - removed) and resets on forceFull", async () => {
    const store = createMainChatStore(tempDir);
    await store.load();
    let nowMs = 1_700_000_000_000;

    const liveAgents = new Map<string, ManagedAgent>([
      [
        "a1",
        makeLiveAgent({
          id: "a1",
          title: "审批任务A",
          pendingPermissionTitle: "运行迁移脚本",
          updatedAtMs: nowMs,
        }),
      ],
      [
        "a2",
        makeLiveAgent({
          id: "a2",
          title: "审批任务B",
          pendingPermissionTitle: "写入配置",
          updatedAtMs: nowMs - 1_000,
        }),
      ],
    ]);

    const builder = createMainChatContextSnapshotBuilder({
      agentManager: {
        listAgents: () => Array.from(liveAgents.values()),
      } as unknown as AgentManager,
      agentStorage: { listActive: async () => [] } as unknown as AgentStorage,
      store,
      now: () => nowMs,
    });

    // Turn 1: full baseline
    const turn1 = await builder.buildTurnContext("agent_main");
    expect(turn1).toContain("全机实时快照");
    expect(turn1).toContain("审批任务A");
    expect(turn1).toContain("审批任务B");

    // Turn 2: unchanged -> needs_you section omitted completely
    const turn2 = await builder.buildTurnContext("agent_main");
    expect(turn2).toContain("相对上一轮快照有变化");
    expect(turn2).not.toContain("审批任务A");
    expect(turn2).not.toContain("审批任务B");

    // Turn 3: a1 stays unchanged, a2 removed, a3 added -> line-level diff emits only + a3 and - a2
    liveAgents.delete("a2");
    liveAgents.set(
      "a3",
      makeLiveAgent({
        id: "a3",
        title: "审批任务C",
        pendingPermissionTitle: "执行部署前检查",
        updatedAtMs: nowMs + 5_000,
      }),
    );
    builder.invalidateCache();

    const turn3 = await builder.buildTurnContext("agent_main");
    expect(turn3).toContain("### 等你拍板 / 待审批（增量变更）");
    expect(turn3).toContain("+ 「审批任务C」");
    expect(turn3).toContain("- 已移出：「审批任务B」");
    expect(turn3).not.toContain("审批任务A");

    // Turn 4: forceFull resets baseline and outputs all active items again
    const turn4 = await builder.buildTurnContext("agent_main", { forceFull: true });
    expect(turn4).toContain("全机实时快照");
    expect(turn4).toContain("审批任务A");
    expect(turn4).toContain("审批任务C");
    expect(turn4).not.toContain("审批任务B");
  });

  it("enforces the 6,000-character tiered hard budget preserving high-priority items first", async () => {
    const store = createMainChatStore(tempDir);
    await store.load();
    const nowMs = 1_700_000_000_000;
    const liveAgents: ManagedAgent[] = [];

    for (let i = 1; i <= 5; i += 1) {
      liveAgents.push(
        makeLiveAgent({
          id: `urgent_${i}`,
          title: `高优审批_${i}`,
          pendingPermissionTitle: `需要立即拍板的权限请求_${i}`,
          updatedAtMs: nowMs - i * 100,
        }),
      );
    }
    for (let i = 1; i <= 40; i += 1) {
      liveAgents.push(
        makeLiveAgent({
          id: `err_${i}`,
          title: `异常任务_${i}_${"很长的标题说明".repeat(5)}`,
          lifecycle: "error",
          lastError: `严重错误堆栈信息_${i}_${"Error details ".repeat(10)}`,
          updatedAtMs: nowMs - 10_000 - i * 100,
        }),
      );
    }
    for (let i = 1; i <= 30; i += 1) {
      liveAgents.push(
        makeLiveAgent({
          id: `done_${i}`,
          title: `已完工低优任务_${i}_${"补充验收信息".repeat(6)}`,
          lifecycle: "idle",
          requiresAttention: true,
          updatedAtMs: nowMs - 50_000 - i * 100,
        }),
      );
    }

    const builder = createMainChatContextSnapshotBuilder({
      agentManager: { listAgents: () => liveAgents } as unknown as AgentManager,
      agentStorage: { listActive: async () => [] } as unknown as AgentStorage,
      store,
      now: () => nowMs,
    });

    const snapshot = await builder.buildTurnContext("agent_main", { forceFull: true });
    expect(snapshot.length).toBeLessThanOrEqual(MAX_SNAPSHOT_CHARS);
    // High-priority needs_you items are preserved intact.
    for (let i = 1; i <= 5; i += 1) {
      expect(snapshot).toContain(`高优审批_${i}`);
    }
    // Lower-priority entries were trimmed with an omission notice.
    expect(snapshot).toContain("已省略");
  });

  it("compresses healthy running sessions and idle sessions to save snapshot budget", async () => {
    const store = createMainChatStore(tempDir);
    await store.load();
    const nowMs = 1_700_000_000_000;
    const liveAgents: ManagedAgent[] = [];

    for (let i = 1; i <= 10; i += 1) {
      liveAgents.push(
        makeLiveAgent({
          id: `run_${i}`,
          title: `健康运行任务_${i}`,
          lifecycle: "running",
          updatedAtMs: nowMs - i * 1_000,
        }),
      );
    }
    for (let i = 1; i <= 4; i += 1) {
      liveAgents.push(
        makeLiveAgent({
          id: `idle_${i}`,
          title: `空闲历史任务_${i}`,
          lifecycle: "idle",
          updatedAtMs: nowMs - 100_000 - i * 1_000,
        }),
      );
    }

    const builder = createMainChatContextSnapshotBuilder({
      agentManager: { listAgents: () => liveAgents } as unknown as AgentManager,
      agentStorage: { listActive: async () => [] } as unknown as AgentStorage,
      store,
      now: () => nowMs,
    });

    const snapshot = await builder.buildTurnContext("agent_main", { forceFull: true });
    expect(snapshot).toContain("健康运行任务_1");
    expect(snapshot).toContain("健康运行任务_3");
    expect(snapshot).not.toContain("健康运行任务_4");
    expect(snapshot).toContain("另有 7 个任务正常运行中");
    expect(snapshot).toContain("另有 4 个空闲会话");
    expect(snapshot).not.toContain("空闲历史任务_1");
  });

  it("caches collectFleet for 45s and refreshes immediately on invalidateCache or TTL expiry", async () => {
    const store = createMainChatStore(tempDir);
    await store.load();
    let nowMs = 1_700_000_000_000;

    let storedList: StoredAgentRecord[] = [
      {
        id: "stored_1",
        provider: "claude",
        cwd: "/tmp/repo-a",
        createdAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
        title: "持久化任务1",
        labels: {},
        lastStatus: "idle",
        requiresAttention: true,
        attentionReason: "finished",
      } as unknown as StoredAgentRecord,
    ];
    const listActiveSpy = vi.fn(async () => storedList);

    const builder = createMainChatContextSnapshotBuilder({
      agentManager: { listAgents: () => [] } as unknown as AgentManager,
      agentStorage: { listActive: listActiveSpy } as unknown as AgentStorage,
      store,
      now: () => nowMs,
      cacheTtlMs: SNAPSHOT_CACHE_TTL_MS,
    });

    await builder.collectFleet("agent_main");
    expect(listActiveSpy).toHaveBeenCalledTimes(1);

    // Within 45s TTL -> cache hit, no extra scan.
    nowMs += 30_000;
    await builder.collectFleet("agent_main");
    expect(listActiveSpy).toHaveBeenCalledTimes(1);

    // Explicit invalidateCache() forces immediate refresh even inside TTL.
    storedList = [
      ...storedList,
      {
        id: "stored_2",
        provider: "claude",
        cwd: "/tmp/repo-b",
        createdAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
        title: "持久化任务2",
        labels: {},
        lastStatus: "error",
        lastError: "编译失败",
      } as unknown as StoredAgentRecord,
    ];
    builder.invalidateCache();
    const afterInvalidate = await builder.collectFleet("agent_main");
    expect(listActiveSpy).toHaveBeenCalledTimes(2);
    expect(afterInvalidate.totalActive).toBe(2);

    // Advancing past 45s TTL triggers refresh automatically.
    nowMs += SNAPSHOT_CACHE_TTL_MS + 1;
    await builder.collectFleet("agent_main");
    expect(listActiveSpy).toHaveBeenCalledTimes(3);
  });

  it("falls back non-blockingly to cached snapshot after foreground timeout and warms cache in background", async () => {
    const store = createMainChatStore(tempDir);
    await store.load();
    let nowMs = 1_700_000_000_000;

    let releaseSlowScan: (() => void) | null = null;
    let callCount = 0;

    const storedV1 = [
      {
        id: "s1",
        provider: "claude",
        cwd: "/tmp/repo-a",
        createdAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
        title: "旧缓存任务",
        labels: {},
        lastStatus: "error",
        lastError: "旧报错",
      } as unknown as StoredAgentRecord,
    ];
    const storedV2 = [
      {
        id: "s2",
        provider: "claude",
        cwd: "/tmp/repo-b",
        createdAt: new Date(nowMs).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
        title: "后台刷新后的新任务",
        labels: {},
        lastStatus: "error",
        lastError: "新报错",
      } as unknown as StoredAgentRecord,
    ];

    const listActive = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) return storedV1;
      await new Promise<void>((resolve) => {
        releaseSlowScan = resolve;
      });
      return storedV2;
    });

    const builder = createMainChatContextSnapshotBuilder({
      agentManager: { listAgents: () => [] } as unknown as AgentManager,
      agentStorage: { listActive } as unknown as AgentStorage,
      store,
      now: () => nowMs,
      cacheTtlMs: 45_000,
      foregroundTimeoutMs: 35,
    });

    // Prime cache with V1.
    const initial = await builder.buildTurnContext("agent_main", { foreground: true });
    expect(initial).toContain("旧缓存任务");
    expect(initial).not.toContain("缓存略旧");

    // Expire cache and trigger a slow refresh: foreground turn must NOT block past timeout!
    nowMs += 60_000;
    const startedAt = Date.now();
    const staleContext = await builder.buildTurnContext("agent_main", {
      foreground: true,
      forceFull: true,
    });
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(250);
    expect(staleContext).toContain("缓存略旧，后台刷新中");
    expect(staleContext).toContain("旧缓存任务");

    // Finish background refresh -> next foreground turn immediately sees V2 from warm cache!
    releaseSlowScan?.();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const refreshedContext = await builder.buildTurnContext("agent_main", {
      foreground: true,
      forceFull: true,
    });
    expect(refreshedContext).not.toContain("缓存略旧");
    expect(refreshedContext).toContain("后台刷新后的新任务");
    expect(refreshedContext).not.toContain("旧缓存任务");
  });
});
