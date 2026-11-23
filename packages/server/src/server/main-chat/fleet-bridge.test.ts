import { describe, expect, it, vi } from "vitest";
import { PARENT_AGENT_ID_LABEL, PARENT_SERVER_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";
import {
  MAIN_CHAT_CONVERSATION_ID_LABEL,
  MAIN_CHAT_CONVERSATION_KIND_LABEL,
  MAIN_CHAT_FORMER_ROLE_VALUE,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_GOAL_LABEL,
  MAIN_CHAT_TASK_ID_LABEL,
  MAIN_CHAT_TASK_MODE_LABEL,
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
  MAIN_CHAT_TASK_QUIET_LABEL,
  MAIN_CHAT_TASK_RECORD_ID_LABEL,
  type MainChatSessionTriage,
} from "@getpaseo/protocol/main-chat";
import {
  FleetHostError,
  createMainChatFleetAggregator,
  type AggregatedFleetSnapshot,
  type AggregatedHostAgent,
  type CrossHostAgentTailMessage,
  type CrossHostDispatchInput,
  type CrossHostDispatchResult,
  type FleetAggregatorEvent,
  type FleetLocalAgentManager,
  type FleetLocalAgentStorage,
  type MainChatFleetAggregator,
} from "./fleet-aggregator.js";
import {
  MainChatFleetBridgeError,
  buildTaskDispatchLabels,
  createMainChatFleetBridge,
  type FleetAggregatorLike,
  type LocalTaskDispatchInput,
  type MainChatFleetBridge,
} from "./fleet-bridge.js";
import type { MainChatService } from "./service.js";

// Compile-time assignability guards: production aggregator and service contracts must match directly.
function _verifyProductionTypeCompatibility(
  aggregator: MainChatFleetAggregator,
  bridge: MainChatFleetBridge,
): {
  like: FleetAggregatorLike;
  getFleetHosts: NonNullable<MainChatService["getFleetHosts"]>;
} {
  return {
    like: aggregator,
    getFleetHosts: bridge.getFleetHosts,
  };
}
void _verifyProductionTypeCompatibility;

function makeAggregatedAgent(
  overrides: Partial<AggregatedHostAgent> & { agentId: string },
): AggregatedHostAgent {
  const isLocal = overrides.isLocal ?? true;
  return {
    serverId: overrides.serverId ?? (isLocal ? "srv_devbox" : "srv_macbook"),
    hostLabel: overrides.hostLabel ?? (isLocal ? "DevBox" : "MacBook"),
    isLocal,
    agentId: overrides.agentId,
    workspaceId: overrides.workspaceId ?? `ws_${overrides.agentId}`,
    title: overrides.title ?? overrides.agentId,
    cwd: overrides.cwd ?? "/workspace/paseo-fork",
    lifecycle: overrides.lifecycle ?? "idle",
    requiresAttention: overrides.requiresAttention ?? false,
    attentionReason: overrides.attentionReason ?? null,
    pendingPermissions: overrides.pendingPermissions ?? [],
    labels: overrides.labels ?? {},
    lastError: overrides.lastError ?? null,
    updatedAtIso: overrides.updatedAtIso ?? "2026-11-23T12:00:00.000Z",
    stale: overrides.stale ?? false,
  };
}

function createStubAggregator(initialSnapshot: AggregatedFleetSnapshot) {
  let snapshot = initialSnapshot;
  const listeners = new Set<(event: FleetAggregatorEvent) => void>();

  const collectFleet = vi.fn(async () => snapshot);
  const dispatchAgentOnHost = vi.fn(
    async (input: CrossHostDispatchInput): Promise<CrossHostDispatchResult> => ({
      serverId: input.serverId,
      hostLabel: input.serverId === "srv_devbox" ? "DevBox" : "MacBook",
      isLocal: input.serverId === "srv_devbox",
      agentId: `ag_dispatched_${input.serverId}`,
      workspaceId: input.workspaceId ?? `ws_${input.serverId}`,
      cwd: input.cwd,
      title: input.title,
      provider: input.provider,
      lifecycle: "running",
    }),
  );
  const sendPromptToHostAgent = vi.fn(async () => undefined);
  const respondPermissionOnHost = vi.fn(async () => undefined);
  const readHostAgentTail = vi.fn(
    async (): Promise<CrossHostAgentTailMessage[]> => [
      { role: "assistant", text: "远端执行中", timestamp: "2026-11-23T12:00:00.000Z" },
    ],
  );
  const controlHostAgent = vi.fn(async () => undefined);

  const aggregator: FleetAggregatorLike = {
    collectFleet,
    dispatchAgentOnHost,
    sendPromptToHostAgent,
    respondPermissionOnHost,
    readHostAgentTail,
    controlHostAgent,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  return {
    aggregator,
    setSnapshot(next: AggregatedFleetSnapshot) {
      snapshot = next;
    },
    emit(event: FleetAggregatorEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    },
    spies: {
      collectFleet,
      dispatchAgentOnHost,
      sendPromptToHostAgent,
      respondPermissionOnHost,
      readHostAgentTail,
      controlHostAgent,
    },
  };
}

describe("MainChatFleetBridge", () => {
  it("merges local and remote hosts, excludes main/leader/side conversations, classifies 5 buckets, and preserves offline host status", async () => {
    const stub = createStubAggregator({
      collectedAt: "2026-11-23T12:00:00.000Z",
      localServerId: "srv_devbox",
      hosts: [
        {
          serverId: "srv_devbox",
          label: "DevBox",
          isLocal: true,
          status: "online",
          agentCount: 6,
          needsAttentionCount: 1,
          lastSyncedAt: "2026-11-23T12:00:00.000Z",
          error: null,
        },
        {
          serverId: "srv_macbook",
          label: "MacBook",
          isLocal: false,
          status: "online",
          agentCount: 3,
          needsAttentionCount: 2,
          lastSyncedAt: "2026-11-23T12:00:00.000Z",
          error: null,
        },
        {
          serverId: "srv_macmini",
          label: "Mac mini",
          isLocal: false,
          status: "offline",
          agentCount: 1,
          needsAttentionCount: 0,
          lastSyncedAt: "2026-11-23T11:30:00.000Z",
          error: "Connection reset by peer",
        },
      ],
      agents: [
        // Should all be excluded from worker fleet:
        makeAggregatedAgent({
          agentId: "ag_main",
          labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
        }),
        makeAggregatedAgent({
          agentId: "ag_former_main",
          labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_FORMER_ROLE_VALUE },
        }),
        makeAggregatedAgent({
          agentId: "ag_leader_1",
          labels: {
            [MAIN_CHAT_CONVERSATION_ID_LABEL]: "conv_leader_1",
            [MAIN_CHAT_CONVERSATION_KIND_LABEL]: "leader",
          },
        }),
        makeAggregatedAgent({
          agentId: "ag_side_1",
          labels: { [MAIN_CHAT_CONVERSATION_KIND_LABEL]: "side" },
        }),
        // Visible worker sessions:
        makeAggregatedAgent({
          agentId: "ag_local_running",
          title: "重构快照缓存",
          cwd: "/data/paseo-fork",
          lifecycle: "running",
          labels: {
            [PARENT_AGENT_ID_LABEL]: "ag_main",
            [MAIN_CHAT_TASK_PLAN_ID_LABEL]: "plan_1",
          },
          updatedAtIso: "2026-11-23T12:00:05.000Z",
        }),
        makeAggregatedAgent({
          agentId: "ag_local_idle",
          title: "本地空闲窗口",
          cwd: "/data/notes",
          lifecycle: "idle",
          updatedAtIso: "2026-11-23T11:00:00.000Z",
        }),
        makeAggregatedAgent({
          agentId: "ag_mb_perm",
          serverId: "srv_macbook",
          hostLabel: "MacBook",
          isLocal: false,
          title: "iOS 打包脚本",
          cwd: "/Users/dev/ios-app",
          lifecycle: "idle",
          requiresAttention: true,
          attentionReason: "permission",
          pendingPermissions: [
            {
              requestId: "req_1",
              name: "Bash",
              title: "执行 xcodebuild",
              description: "xcodebuild archive",
              kind: "tool",
            },
          ],
          labels: { [MAIN_CHAT_TASK_ID_LABEL]: "task_ios_1" },
          updatedAtIso: "2026-11-23T12:00:10.000Z",
        }),
        makeAggregatedAgent({
          agentId: "ag_mb_error",
          serverId: "srv_macbook",
          hostLabel: "MacBook",
          isLocal: false,
          title: "修复 Swift 单测",
          cwd: "/Users/dev/ios-app",
          lifecycle: "error",
          lastError: "xcodebuild exited with code 65",
          updatedAtIso: "2026-11-23T12:00:08.000Z",
        }),
        makeAggregatedAgent({
          agentId: "ag_mb_done",
          serverId: "srv_macbook",
          hostLabel: "MacBook",
          isLocal: false,
          title: "整理设计文档",
          cwd: "/Users/dev/design-docs",
          lifecycle: "idle",
          requiresAttention: true,
          attentionReason: "finished",
          updatedAtIso: "2026-11-23T11:50:00.000Z",
        }),
        makeAggregatedAgent({
          agentId: "ag_mini_cached",
          serverId: "srv_macmini",
          hostLabel: "Mac mini",
          isLocal: false,
          title: "夜间回归任务",
          cwd: "/Users/ci/backend-api",
          lifecycle: "running",
          stale: true,
          updatedAtIso: "2026-11-23T11:30:00.000Z",
        }),
      ],
    });

    const bridge = createMainChatFleetBridge({
      localServerId: "srv_devbox",
      fleetAggregator: stub.aggregator,
      listExcludedAgentIds: () => ["ag_extra_excluded"],
    });

    const triageByAgentId = new Map<string, MainChatSessionTriage>([
      [
        "ag_local_idle",
        {
          agentId: "ag_local_idle",
          workspaceId: "ws_ag_local_idle",
          title: "本地空闲窗口",
          managedByMainChat: false,
          phase: "stalled",
          summary: "已停滞超过 20 分钟",
          waitReason: "等待依赖编译",
          suggestedAction: "提醒继续",
          triageSource: "rule",
          updatedAt: "2026-11-23T12:00:00.000Z",
        },
      ],
    ]);

    const result = await bridge.collectMultiHostFleet({
      mainAgentId: "ag_main",
      forceRefresh: true,
      triageByAgentId,
    });

    expect(result.localServerId).toBe("srv_devbox");
    expect(result.summary.totalActive).toBe(6);

    // Bucket classification across local & remote + triage override:
    expect(result.summary.needsYou.map((item) => item.agentId)).toEqual(["ag_mb_perm"]);
    expect(result.summary.needsYou[0].projectName).toBe("[MacBook] ios-app");
    expect(result.summary.needsYou[0].managedByMainChat).toBe(true);
    expect(result.summary.needsYou[0].pendingPermissionLabels).toEqual([
      "执行 xcodebuild（xcodebuild archive）",
    ]);

    expect(result.summary.problematic.map((item) => item.agentId)).toEqual([
      "ag_mb_error",
      "ag_local_idle",
    ]);
    expect(result.summary.running.map((item) => item.agentId)).toEqual([
      "ag_local_running",
      "ag_mini_cached",
    ]);
    expect(result.summary.running[0].projectName).toBe("paseo-fork");
    expect(result.summary.running[1].projectName).toBe("[Mac mini] backend-api");
    expect(result.summary.attentionDone.map((item) => item.agentId)).toEqual(["ag_mb_done"]);
    expect(result.summary.idleOther).toEqual([]);

    // itemServerMap tracks exact host location for every visible worker.
    expect(result.itemServerMap.get("ag_local_running")).toEqual({
      serverId: "srv_devbox",
      hostLabel: "DevBox",
      isLocal: true,
    });
    expect(result.itemServerMap.get("ag_mb_perm")).toEqual({
      serverId: "srv_macbook",
      hostLabel: "MacBook",
      isLocal: false,
    });
    expect(result.itemServerMap.has("ag_leader_1")).toBe(false);

    // Offline host is preserved with status + error, and counts exclude conversation agents.
    expect(result.hosts).toEqual([
      expect.objectContaining({
        serverId: "srv_devbox",
        status: "online",
        agentCount: 2,
        needsAttentionCount: 1,
      }),
      expect.objectContaining({
        serverId: "srv_macbook",
        status: "online",
        agentCount: 3,
        needsAttentionCount: 3,
      }),
      expect.objectContaining({
        serverId: "srv_macmini",
        status: "offline",
        agentCount: 1,
        error: "Connection reset by peer",
      }),
    ]);

    // getFleetHosts forwards forceRefresh and aligns with MainChatService.getFleetHosts.
    const hostResult = await bridge.getFleetHosts({ forceRefresh: true });
    expect(hostResult.localServerId).toBe("srv_devbox");
    expect(hostResult.hosts).toHaveLength(3);
    expect(stub.spies.collectFleet).toHaveBeenLastCalledWith(
      expect.objectContaining({ forceRefresh: true }),
    );
  });

  it("dispatches local vs remote tasks with MAIN_CHAT_TASK_* labels and translates remote offline errors to Chinese", async () => {
    const stub = createStubAggregator({
      collectedAt: "2026-11-23T12:00:00.000Z",
      localServerId: "srv_devbox",
      hosts: [],
      agents: [],
    });

    const localDispatches: LocalTaskDispatchInput[] = [];
    const bridge = createMainChatFleetBridge({
      localServerId: "srv_devbox",
      fleetAggregator: stub.aggregator,
      dispatchLocalTask: async (input) => {
        localDispatches.push(input);
        return {
          serverId: "srv_devbox",
          hostLabel: "DevBox",
          isLocal: true,
          agentId: "ag_local_new",
          workspaceId: "ws_local_new",
          cwd: input.cwd,
          title: input.title,
          provider: input.provider,
          lifecycle: "running",
        };
      },
    });

    // Empty serverId routes to local dispatch callback with stamped task labels.
    const localResult = await bridge.dispatchTaskToTargetHost({
      cwd: "/repo/paseo-fork",
      title: "本地排查",
      provider: "claude",
      mainAgentId: "ag_main",
      planId: "plan_42",
      taskId: "task_1",
      taskRecordId: "trec_1",
      mode: "readonly",
      goal: "定位超时根因",
      quiet: true,
    });
    expect(localResult.agentId).toBe("ag_local_new");
    expect(localDispatches).toHaveLength(1);
    expect(localDispatches[0].labels).toEqual({
      [PARENT_AGENT_ID_LABEL]: "ag_main",
      [PARENT_SERVER_ID_LABEL]: "srv_devbox",
      [MAIN_CHAT_TASK_PLAN_ID_LABEL]: "plan_42",
      [MAIN_CHAT_TASK_ID_LABEL]: "task_1",
      [MAIN_CHAT_TASK_RECORD_ID_LABEL]: "trec_1",
      [MAIN_CHAT_TASK_MODE_LABEL]: "readonly",
      [MAIN_CHAT_TASK_GOAL_LABEL]: "定位超时根因",
      [MAIN_CHAT_TASK_QUIET_LABEL]: "true",
    });

    // Remote serverId routes through fleetAggregator.dispatchAgentOnHost with stamped labels.
    const remoteResult = await bridge.dispatchTaskToTargetHost({
      serverId: "srv_macbook",
      cwd: "/Users/dev/ios-app",
      title: "远端构建",
      provider: "codex",
      isolation: "worktree",
      mainAgentId: "ag_main",
      planId: "plan_42",
      taskId: "task_2",
      mode: "write",
      goal: "修复 iOS 闪退",
    });
    expect(remoteResult.serverId).toBe("srv_macbook");
    expect(stub.spies.dispatchAgentOnHost).toHaveBeenCalledTimes(1);
    expect(stub.spies.dispatchAgentOnHost.mock.calls[0][0].labels).toEqual(
      buildTaskDispatchLabels(
        {
          mainAgentId: "ag_main",
          planId: "plan_42",
          taskId: "task_2",
          mode: "write",
          goal: "修复 iOS 闪退",
        },
        "srv_devbox",
      ),
    );

    // Offline remote host returns typed MainChatFleetBridgeError with Chinese guidance.
    stub.spies.dispatchAgentOnHost.mockRejectedValueOnce(
      new FleetHostError("host_offline", "Host offline", "srv_macmini", {
        operation: "dispatchAgentOnHost",
      }),
    );
    await expect(
      bridge.dispatchTaskToTargetHost({
        serverId: "srv_macmini",
        cwd: "/Users/ci/api",
        title: "离线机测试",
        provider: "claude",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof MainChatFleetBridgeError &&
        error instanceof FleetHostError &&
        error.code === "host_offline" &&
        error.serverId === "srv_macmini" &&
        error.message.includes("离线") &&
        error.message.includes("派发任务")
      );
    });
  });

  it("routes send, permission response, tail read, and cancel to local callbacks or remote aggregator", async () => {
    const stub = createStubAggregator({
      collectedAt: "2026-11-23T12:00:00.000Z",
      localServerId: "srv_devbox",
      hosts: [],
      agents: [],
    });

    const sendLocalPrompt = vi.fn(async () => undefined);
    const respondLocalPermission = vi.fn(async () => undefined);
    const readLocalAgentTail = vi.fn(
      async (): Promise<CrossHostAgentTailMessage[]> => [
        { role: "assistant", text: "本地结果", timestamp: "2026-11-23T12:00:00.000Z" },
      ],
    );
    const cancelLocalAgent = vi.fn(async () => undefined);

    const bridge = createMainChatFleetBridge({
      localServerId: "srv_devbox",
      fleetAggregator: stub.aggregator,
      sendLocalPrompt,
      respondLocalPermission,
      readLocalAgentTail,
      cancelLocalAgent,
    });

    const allowResponse: AgentPermissionResponse = { behavior: "allow" };

    // Local operations use local callbacks.
    await bridge.sendPromptToTargetAgent("srv_devbox", "ag_1", "继续");
    await bridge.respondPermissionOnTargetHost(null, "ag_1", "perm_1", allowResponse);
    const localTail = await bridge.readTargetAgentTail(undefined, "ag_1", { limit: 5 });
    await bridge.cancelTargetAgent("srv_devbox", "ag_1");

    expect(sendLocalPrompt).toHaveBeenCalledWith("ag_1", "继续", undefined);
    expect(respondLocalPermission).toHaveBeenCalledWith("ag_1", "perm_1", allowResponse);
    expect(localTail).toHaveLength(1);
    expect(localTail[0].text).toBe("本地结果");
    expect(cancelLocalAgent).toHaveBeenCalledWith("ag_1");

    // Remote operations use fleetAggregator.
    await bridge.sendPromptToTargetAgent("srv_macbook", "ag_r1", "跑一下单测");
    await bridge.respondPermissionOnTargetHost("srv_macbook", "ag_r1", "perm_r1", allowResponse);
    const remoteTail = await bridge.readTargetAgentTail("srv_macbook", "ag_r1", { limit: 10 });
    await bridge.cancelTargetAgent("srv_macbook", "ag_r1");

    expect(stub.spies.sendPromptToHostAgent).toHaveBeenCalledWith(
      "srv_macbook",
      "ag_r1",
      "跑一下单测",
      undefined,
    );
    expect(stub.spies.respondPermissionOnHost).toHaveBeenCalledWith(
      "srv_macbook",
      "ag_r1",
      "perm_r1",
      allowResponse,
    );
    expect(remoteTail[0].text).toBe("远端执行中");
    expect(stub.spies.controlHostAgent).toHaveBeenCalledWith("srv_macbook", "ag_r1", "cancel");

    // Remote timeout translates cleanly into Chinese error.
    stub.spies.readHostAgentTail.mockRejectedValueOnce(
      new FleetHostError("timeout", "Timed out", "srv_macbook", {
        operation: "readHostAgentTail",
      }),
    );
    await expect(bridge.readTargetAgentTail("srv_macbook", "ag_r1")).rejects.toSatisfy(
      (error: unknown) => {
        return (
          error instanceof MainChatFleetBridgeError &&
          error.code === "timeout" &&
          error.message.includes("超时")
        );
      },
    );
  });

  it("bridges aggregator events to snapshot invalidation, permission hooks, and host changes until unsubscribed", () => {
    const stub = createStubAggregator({
      collectedAt: "2026-11-23T12:00:00.000Z",
      localServerId: "srv_devbox",
      hosts: [],
      agents: [],
    });
    const bridge = createMainChatFleetBridge({
      localServerId: "srv_devbox",
      fleetAggregator: stub.aggregator,
    });

    const onInvalidateSnapshot = vi.fn();
    const onPermissionRequested = vi.fn();
    const onPermissionResolved = vi.fn();
    const onHostsChanged = vi.fn();
    const onAgentsChanged = vi.fn();

    const unsubscribe = bridge.subscribeFleetEvents({
      onInvalidateSnapshot,
      onPermissionRequested,
      onPermissionResolved,
      onHostsChanged,
      onAgentsChanged,
    });

    stub.emit({
      type: "hosts_changed",
      hosts: [
        {
          serverId: "srv_macbook",
          label: "MacBook",
          isLocal: false,
          status: "online",
          agentCount: 1,
          needsAttentionCount: 0,
          lastSyncedAt: "2026-11-23T12:00:00.000Z",
          error: null,
        },
      ],
    });
    stub.emit({
      type: "agents_changed",
      serverId: "srv_macbook",
      agentIds: ["ag_r1"],
      reason: "remote_update",
    });
    stub.emit({
      type: "permission_requested",
      serverId: "srv_macbook",
      hostLabel: "MacBook",
      isLocal: false,
      agentId: "ag_r1",
      permission: {
        requestId: "req_1",
        name: "Bash",
        title: "运行构建",
        description: "npm run build",
        kind: "tool",
      },
    });
    stub.emit({
      type: "permission_resolved",
      serverId: "srv_macbook",
      agentId: "ag_r1",
      requestId: "req_1",
    });

    expect(onInvalidateSnapshot).toHaveBeenCalledTimes(4);
    expect(onHostsChanged).toHaveBeenCalledTimes(1);
    expect(onAgentsChanged).toHaveBeenCalledWith({
      serverId: "srv_macbook",
      agentIds: ["ag_r1"],
      reason: "remote_update",
    });
    expect(onPermissionRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "srv_macbook",
        agentId: "ag_r1",
        permission: expect.objectContaining({ requestId: "req_1" }),
      }),
    );
    expect(onPermissionResolved).toHaveBeenCalledWith({
      serverId: "srv_macbook",
      agentId: "ag_r1",
      requestId: "req_1",
    });

    unsubscribe();
    stub.emit({
      type: "agents_changed",
      serverId: "srv_macbook",
      reason: "remote_sync",
    });
    expect(onInvalidateSnapshot).toHaveBeenCalledTimes(4);
  });

  it("integrates directly with a real MainChatFleetAggregator instance", async () => {
    const localAgentManager: FleetLocalAgentManager = {
      listAgents: () => [],
      getAgent: () => null,
      subscribe: () => () => undefined,
      createAgent: vi.fn(),
      respondToPermission: vi.fn(),
      cancelAgentRun: vi.fn(),
      archiveAgent: vi.fn(),
      getTimeline: () => [],
    };
    const localAgentStorage: FleetLocalAgentStorage = {
      listActive: async () => [],
      get: async () => null,
    };

    const realAggregator = createMainChatFleetAggregator({
      localServerId: "srv_real_local",
      localLabel: "DevBox-Real",
      agentManager: localAgentManager,
      agentStorage: localAgentStorage,
    });

    const bridge = createMainChatFleetBridge({
      localServerId: "srv_real_local",
      fleetAggregator: realAggregator,
    });

    const hosts = await bridge.getFleetHosts();
    expect(hosts.localServerId).toBe("srv_real_local");
    expect(hosts.hosts).toEqual([
      expect.objectContaining({
        serverId: "srv_real_local",
        label: "DevBox-Real",
        isLocal: true,
        status: "online",
        agentCount: 0,
      }),
    ]);

    // Dispatching to an unknown remote host surfaces a Chinese host_unknown error end-to-end.
    await expect(
      bridge.dispatchTaskToTargetHost({
        serverId: "srv_unpaired",
        cwd: "/tmp/repo",
        title: "测试未配对主机",
        provider: "claude",
      }),
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof MainChatFleetBridgeError &&
        error.code === "host_unknown" &&
        error.message.includes("未找到已接入的远端主机")
      );
    });
  });
});
