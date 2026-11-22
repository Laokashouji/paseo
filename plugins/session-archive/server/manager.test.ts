import type { PluginServerContext } from "@getpaseo/plugin/server";
import { describe, expect, test, vi } from "vitest";
import contribute from "../index.server.js";
import {
  getSessionArchiveStateRpc,
  sessionArchiveCompletedSubscription,
  triggerSessionArchiveRpc,
  watchSessionArchiveStateSubscription,
} from "../shared/contracts.js";
import { SessionArchiveManager, type PaseoApi } from "./manager.js";

function createMockAgentContext(agentId: string, workspaceId: string | null = "wks-1") {
  return {
    agent: {
      id: agentId,
      workspaceId,
      parentAgentId: null,
      provider: "claude",
      cwd: "/repo",
      title: "测试对话",
      background: false,
      metadata: {},
    },
    paseo: {} as PaseoApi,
    signal: new AbortController().signal,
  };
}

describe("SessionArchiveManager", () => {
  test("sends command when idle and auto-archives on turn completion after session_finish_archive", async () => {
    const manager = new SessionArchiveManager();
    const sent: string[] = [];
    const archivedIds: string[] = [];
    const stateHistory: string[] = [];
    const completed: Array<{
      agentId: string;
      workspaceId: string | null;
      summary: string | null;
    }> = [];

    manager.subscribeState("agent-1", (state) => stateHistory.push(state));
    manager.subscribeCompleted((event) =>
      completed.push({
        agentId: event.agentId,
        workspaceId: event.workspaceId,
        summary: event.summary,
      }),
    );

    const mockPaseo = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => ({
            agent: {
              id,
              workspaceId: "wks-1",
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
            return { archivedAt: "2026-11-22T21:00:00.000Z" };
          },
        }),
      },
    } as unknown as PaseoApi;

    const triggered = await manager.trigger(
      {
        agentId: "agent-1",
        workspaceId: "wks-1",
        command: "/archive-session",
        autoArchiveAfterCleanup: true,
      },
      mockPaseo,
    );
    expect(triggered).toEqual({ state: "running", status: "sent" });
    expect(sent).toEqual(["/archive-session"]);

    const finishTool = manager.createFinishArchiveTool();
    const toolResult = await finishTool.execute(
      { summary: "已清理 worktree 与临时文件" },
      createMockAgentContext("agent-1", "wks-1"),
    );
    expect(toolResult.text).toContain("自动归档");
    expect(manager.getState("agent-1")).toBe("pending_archive");
    expect(archivedIds).toEqual([]);

    const turnResult = await manager.onTurnAfter(
      { agentId: "agent-1", workspaceId: "wks-1", outcomeKind: "completed" },
      mockPaseo,
    );
    expect(turnResult).toEqual({ archived: true });
    expect(archivedIds).toEqual(["agent-1"]);
    expect(manager.getState("agent-1")).toBe("idle");
    expect(stateHistory).toEqual(["running", "pending_archive", "idle"]);
    expect(completed).toEqual([
      {
        agentId: "agent-1",
        workspaceId: "wks-1",
        summary: "已清理 worktree 与临时文件",
      },
    ]);
    manager.dispose();
  });

  test("queues command while agent is running, allows cancellation, and dispatches on turn completion", async () => {
    const manager = new SessionArchiveManager();
    let status: "running" | "idle" = "running";
    const sent: string[] = [];

    const mockPaseo = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => ({
            agent: {
              id,
              workspaceId: "wks-1",
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

    const queued = await manager.trigger(
      { agentId: "agent-busy", workspaceId: "wks-1", command: "清理残留" },
      mockPaseo,
    );
    expect(queued).toEqual({ state: "queued", status: "queued" });
    expect(sent).toEqual([]);

    const canceled = await manager.trigger({ agentId: "agent-busy", cancelQueue: true }, mockPaseo);
    expect(canceled).toEqual({ state: "idle", status: "canceled" });

    await manager.trigger(
      { agentId: "agent-busy", workspaceId: "wks-1", command: "清理残留" },
      mockPaseo,
    );
    status = "idle";
    const turnResult = await manager.onTurnAfter(
      { agentId: "agent-busy", workspaceId: "wks-1", outcomeKind: "completed" },
      mockPaseo,
    );
    expect(turnResult).toEqual({ archived: false });
    expect(sent).toEqual(["清理残留"]);
    expect(manager.getState("agent-busy")).toBe("running");
    manager.dispose();
  });

  test("keeps session open if AI stops without calling session_finish_archive or auto-archive is disabled", async () => {
    const manager = new SessionArchiveManager();
    const archiveFn = vi.fn(async () => ({ archivedAt: "2026-11-22T21:00:00.000Z" }));
    const mockPaseo = {
      agents: {
        ref: (id: string) => ({
          refresh: async () => ({
            agent: {
              id,
              workspaceId: "wks-1",
              status: "idle",
              pendingPermissions: [],
              lastError: null,
              archivedAt: null,
            },
          }),
          send: async () => {},
          archive: archiveFn,
        }),
      },
    } as unknown as PaseoApi;

    await manager.trigger(
      { agentId: "agent-risk", command: "清理残留", autoArchiveAfterCleanup: true },
      mockPaseo,
    );
    const res1 = await manager.onTurnAfter(
      { agentId: "agent-risk", workspaceId: "wks-1", outcomeKind: "completed" },
      mockPaseo,
    );
    expect(res1).toEqual({ archived: false });
    expect(manager.getState("agent-risk")).toBe("idle");
    expect(archiveFn).not.toHaveBeenCalled();

    await manager.trigger(
      { agentId: "agent-manual", command: "清理残留", autoArchiveAfterCleanup: false },
      mockPaseo,
    );
    const finishTool = manager.createFinishArchiveTool();
    const toolRes = await finishTool.execute(
      { summary: "完成清理" },
      createMockAgentContext("agent-manual", "wks-1"),
    );
    expect(toolRes.text).toContain("未开启自动归档");
    expect(manager.getState("agent-manual")).toBe("idle");
    expect(archiveFn).not.toHaveBeenCalled();
    manager.dispose();
  });

  test("server contribute registers RPCs, synchronous subscriptions, and lifecycle hooks", async () => {
    const handlers = new Map<string, (input: unknown, ctx: unknown) => unknown>();
    const hooks = new Map<string, (payload: unknown, ctx: unknown) => Promise<unknown>>();
    const mockServer = {
      handle: (contract: { name: string }, handler: (input: unknown, ctx: unknown) => unknown) => {
        handlers.set(contract.name, handler);
      },
      addHook: (name: string, handler: (payload: unknown, ctx: unknown) => Promise<unknown>) => {
        hooks.set(name, handler);
        return () => {};
      },
      registerSettings: () => {},
      registerProvider: () => {},
      registerUsageSource: () => {},
    } as unknown as PluginServerContext;

    const cleanup = contribute(mockServer);
    const mockPaseo = {
      agents: {
        ref: () => ({
          refresh: async () => null,
          send: async () => {},
          archive: async () => ({ archivedAt: "2026-11-22T21:00:00.000Z" }),
        }),
      },
    } as unknown as PaseoApi;

    await expect(
      handlers.get(triggerSessionArchiveRpc.name)!(
        { agentId: "a1", command: "  " },
        { paseo: mockPaseo },
      ),
    ).rejects.toThrow("归档命令为空");

    expect(
      handlers.get(getSessionArchiveStateRpc.name)!({ agentId: "a1" }, { paseo: mockPaseo }),
    ).toEqual({
      state: "idle",
    });

    const pushed: unknown[] = [];
    const abort = new AbortController();
    const stateRet = handlers.get(watchSessionArchiveStateSubscription.name)!(
      { agentId: "a1" },
      {
        paseo: mockPaseo,
        signal: abort.signal,
        push: async (event: unknown) => {
          pushed.push(event);
        },
      },
    );
    const completedRet = handlers.get(sessionArchiveCompletedSubscription.name)!(
      {},
      {
        paseo: mockPaseo,
        signal: abort.signal,
        push: async () => {},
      },
    );
    expect(stateRet).toBeUndefined();
    expect(completedRet).toBeUndefined();
    expect(pushed).toEqual([{ agentId: "a1", state: "idle" }]);
    expect(hooks.has("agent.open.before")).toBe(true);
    expect(hooks.has("agent.turn.after")).toBe(true);
    expect(hooks.has("agent.archive.after")).toBe(true);

    abort.abort();
    await cleanup?.();
  });
});
