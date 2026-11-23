import { afterEach, describe, expect, test, vi } from "vitest";
import { DaemonClient, type DaemonTransport } from "./daemon-client.js";

function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createConnectedClient() {
  const sent: Array<Record<string, unknown>> = [];
  let onMessage: (data: unknown) => void = () => {};
  let onOpen: () => void = () => {};

  const transport: DaemonTransport = {
    send: (data) => {
      if (typeof data !== "string") return;
      const parsed = JSON.parse(data) as Record<string, unknown>;
      if (parsed.type === "ping") {
        onMessage(JSON.stringify({ type: "pong" }));
        return;
      }
      sent.push(parsed);
    },
    close: () => {},
    onMessage: (handler) => {
      onMessage = (data) => handler(data, typeof data !== "string");
      return () => {};
    },
    onOpen: (handler) => {
      onOpen = handler;
      return () => {};
    },
    onClose: () => () => {},
    onError: () => () => {},
  };

  const client = new DaemonClient({
    url: "ws://127.0.0.1:6767",
    clientId: "cl_main_chat_test",
    logger: createMockLogger(),
    transportFactory: () => transport,
    reconnect: { enabled: false },
  });

  const connectPromise = client.connect();
  onOpen();
  sent.length = 0;
  onMessage(
    JSON.stringify({
      type: "session",
      message: {
        type: "status",
        payload: {
          status: "server_info",
          serverId: "srv_main_chat_test",
          hostname: null,
          version: null,
          features: { mainChat: true, ownedSubscriptions: true },
        },
      },
    }),
  );

  const emitSessionMessage = (message: Record<string, unknown>) => {
    onMessage(JSON.stringify({ type: "session", message }));
  };

  return { client, connectPromise, sent, emitSessionMessage };
}

describe("DaemonClient M2 main-chat methods", () => {
  const clients: DaemonClient[] = [];

  afterEach(async () => {
    while (clients.length > 0) {
      await clients.pop()?.close();
    }
  });

  test("sends compactMainChat, clearMainChat, startNewMainChatSession, and listMainChatActivity RPCs", async () => {
    const { client, connectPromise, sent, emitSessionMessage } = createConnectedClient();
    clients.push(client);
    await connectPromise;

    const compactPromise = client.compactMainChat(
      { mainAgentId: "agent_main", reason: "manual", instructions: "只保留当前任务结论" },
      "req_compact",
    );
    expect(sent.at(-1)).toEqual({
      type: "session",
      message: {
        type: "main_chat.compact.request",
        requestId: "req_compact",
        mainAgentId: "agent_main",
        reason: "manual",
        instructions: "只保留当前任务结论",
      },
    });
    emitSessionMessage({
      type: "main_chat.compact.response",
      payload: {
        requestId: "req_compact",
        mainAgentId: "agent_main",
        compaction: {
          status: "succeeded",
          estimatedTokens: 80_000,
          thresholdTokens: 400_000,
          lastCompactedAt: "2026-11-23T10:00:00.000Z",
          lastError: null,
          summary: "已压缩",
          reason: "manual",
          strategy: "native",
        },
        error: null,
      },
    });
    const compactRes = await compactPromise;
    expect(compactRes.compaction?.status).toBe("succeeded");
    expect(compactRes.compaction?.strategy).toBe("native");

    const clearPromise = client.clearMainChat({ mainAgentId: "agent_main" }, "req_clear");
    expect(sent.at(-1)).toEqual({
      type: "session",
      message: {
        type: "main_chat.clear.request",
        requestId: "req_clear",
        mainAgentId: "agent_main",
      },
    });
    emitSessionMessage({
      type: "main_chat.clear.response",
      payload: {
        requestId: "req_clear",
        previousAgentId: "agent_main",
        agentId: "agent_main_2",
        workspaceId: "ws_main",
        migratedPlans: 3,
        migratedDecisions: 1,
        migratedChildAgents: 2,
        error: null,
      },
    });
    const clearRes = await clearPromise;
    expect(clearRes.agentId).toBe("agent_main_2");
    expect(clearRes.migratedChildAgents).toBe(2);

    const newSessionPromise = client.startNewMainChatSession(
      { mainAgentId: "agent_main_2", carryHandoffSummary: true, title: "新总控" },
      "req_new",
    );
    expect(sent.at(-1)).toEqual({
      type: "session",
      message: {
        type: "main_chat.new_session.request",
        requestId: "req_new",
        mainAgentId: "agent_main_2",
        carryHandoffSummary: true,
        title: "新总控",
      },
    });
    emitSessionMessage({
      type: "main_chat.new_session.response",
      payload: {
        requestId: "req_new",
        previousAgentId: "agent_main_2",
        agentId: "agent_main_3",
        workspaceId: "ws_main",
        handoffSummary: "已交接 2 个进行中任务",
        migratedPlans: 3,
        migratedDecisions: 1,
        migratedChildAgents: 2,
        error: null,
      },
    });
    const newSessionRes = await newSessionPromise;
    expect(newSessionRes.agentId).toBe("agent_main_3");
    expect(newSessionRes.handoffSummary).toContain("交接");

    const activityPromise = client.listMainChatActivity(
      { mainAgentId: "agent_main_3", limit: 20, includeSilent: true, kind: "handoff" },
      "req_act",
    );
    expect(sent.at(-1)).toEqual({
      type: "session",
      message: {
        type: "main_chat.list_activity.request",
        requestId: "req_act",
        mainAgentId: "agent_main_3",
        limit: 20,
        includeSilent: true,
        kind: "handoff",
      },
    });
    emitSessionMessage({
      type: "main_chat.list_activity.response",
      payload: {
        requestId: "req_act",
        activities: [
          {
            id: "act_1",
            mainAgentId: "agent_main_3",
            kind: "handoff",
            trigger: "new_session_with_handoff",
            summary: "已开启新主对话",
            silent: false,
            status: "completed",
            createdAt: "2026-11-23T10:01:00.000Z",
            completedAt: "2026-11-23T10:01:00.000Z",
          },
        ],
        total: 1,
        error: null,
      },
    });
    const activityRes = await activityPromise;
    expect(activityRes.total).toBe(1);
    expect(activityRes.activities[0]?.kind).toBe("handoff");
  });
});
