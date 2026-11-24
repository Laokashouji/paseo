import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { HostDirectory } from "@getpaseo/protocol/hosts";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  isHostAllowedInFleetScope,
  type MainChatFleetScope,
} from "@getpaseo/protocol/main-chat";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ToolHosts } from "../agent/host-operations/index.js";
import { createPaseoToolCatalog } from "../agent/tools/paseo-tools.js";
import type { ConnectedHostSummary } from "../connected-hosts/index.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import {
  FleetHostError,
  createMainChatFleetAggregator,
  type FleetAcceptedHostHandle,
  type FleetConnectedHosts,
  type FleetLocalAgentManager,
  type FleetLocalAgentStorage,
  type FleetRemoteDaemonClient,
} from "./fleet-aggregator.js";
import { createMainChatFleetBridge, MainChatFleetBridgeError } from "./fleet-bridge.js";
import { createMainChatService, type MainChatService } from "./service.js";

const logger = pino({ level: "silent" });

function createRemoteSnapshot(agentId: string, title: string, cwd: string): AgentSnapshotPayload {
  return {
    id: agentId,
    provider: "claude",
    cwd,
    workspaceId: `wks_${agentId}`,
    model: "claude-sonnet-4-5",
    createdAt: "2026-11-24T01:00:00.000Z",
    updatedAt: "2026-11-24T02:00:00.000Z",
    lastUserMessageAt: null,
    status: "running",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsSessionListing: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: "default",
    availableModes: [],
    features: [],
    options: {},
    controls: [],
    pendingPermissions: [],
    persistence: null,
    title,
    labels: {},
    metadata: {},
    archivedAt: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
  };
}

function createFakeRemoteClient(
  agents: AgentSnapshotPayload[],
): FleetRemoteDaemonClient & { subscribeCount: number; unsubscribeCount: number } {
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  const client = {
    get subscribeCount() {
      return subscribeCount;
    },
    get unsubscribeCount() {
      return unsubscribeCount;
    },
    isConnected: true,
    fetchAgents: vi.fn(async () => ({
      entries: agents.map((agent) => ({ agent })),
    })),
    fetchAgentTimeline: vi.fn(async () => ({ entries: [] })),
    createAgent: vi.fn(async () => createRemoteSnapshot("new_remote", "Remote Task", "/repo")),
    createWorkspace: vi.fn(async () => ({ workspaceId: "wks_new" })),
    sendMessage: vi.fn(async () => {}),
    respondToPermission: vi.fn(async () => {}),
    cancelAgent: vi.fn(async () => {}),
    subscribe: vi.fn(() => {
      subscribeCount += 1;
      return () => {
        unsubscribeCount += 1;
      };
    }),
  };
  return client;
}

function createStubConnectedHosts(input: {
  selfId: string;
  selfLabel: string;
  remotes: Array<{
    serverId: string;
    label: string;
    client: FleetRemoteDaemonClient;
  }>;
}): FleetConnectedHosts {
  const summaries: ConnectedHostSummary[] = input.remotes.map((remote, index) => ({
    registrationId: `hst_${index + 1}`,
    serverId: remote.serverId,
    label: remote.label,
    source: { id: "owner", key: `key_${index + 1}` },
    metadata: {},
    enabled: true,
    status: "online",
    targetDescription: `relay://relay.paseo.sh/${remote.serverId}`,
    lastOnlineAt: "2026-11-24T02:00:00.000Z",
    nextRetryAt: null,
    error: null,
  }));

  const accepted: FleetAcceptedHostHandle[] = input.remotes.map((remote, index) => ({
    registrationId: `hst_${index + 1}`,
    serverId: remote.serverId,
    label: remote.label,
    client: remote.client,
    lastOnlineAt: "2026-11-24T02:00:00.000Z",
  }));

  return {
    getSelfHost: () => ({ serverId: input.selfId, label: input.selfLabel }),
    listKnownHosts: () => summaries,
    listAcceptedHosts: () => accepted,
    getAcceptedClient: (serverId) =>
      accepted.find((entry) => entry.serverId === serverId)?.client ?? null,
    subscribeHostChanges: () => () => {},
  };
}

function createEmptyLocalDeps(): {
  agentManager: FleetLocalAgentManager;
  agentStorage: FleetLocalAgentStorage;
} {
  return {
    agentManager: {
      listAgents: () => [],
      getAgent: () => undefined,
      subscribe: () => () => {},
      createAgent: vi.fn(async () => {
        throw new Error("not used");
      }),
      respondToPermission: vi.fn(async () => {}),
      cancelAgent: vi.fn(async () => {}),
      getTimelineStore: () => ({
        list: async () => ({ rows: [], totalCount: 0, hasMoreBefore: false }),
      }),
    },
    agentStorage: {
      listActive: async () => [],
      get: async () => null,
    },
  };
}

describe("MainChat steward host-scope isolation (Slice 1)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()!;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("filters remote hosts by fleetScope, rejects out-of-scope operations, and reconciles dynamically", async () => {
    const macbookClient = createFakeRemoteClient([
      createRemoteSnapshot("agent_mb_1", "MacBook iOS build", "/Users/bytedance/app"),
    ]);
    const imacClient = createFakeRemoteClient([
      createRemoteSnapshot("agent_imac_1", "iMac personal app", "/Users/laokashouji/sideproject"),
    ]);

    const connectedHosts = createStubConnectedHosts({
      selfId: "srv_devbox",
      selfLabel: "DevBox",
      remotes: [
        { serverId: "srv_macbook", label: "MacBook", client: macbookClient },
        { serverId: "srv_imac", label: "iMac", client: imacClient },
      ],
    });

    let currentScope: MainChatFleetScope = {
      mode: "allowlist",
      hostServerIds: ["srv_macbook"],
    };

    const { agentManager, agentStorage } = createEmptyLocalDeps();
    const aggregator = createMainChatFleetAggregator({
      localServerId: "srv_devbox",
      localLabel: "DevBox",
      agentManager,
      agentStorage,
      connectedHosts,
      isHostAllowed: (targetServerId) =>
        isHostAllowedInFleetScope(currentScope, "srv_devbox", targetServerId),
      logger,
    });
    const bridge = createMainChatFleetBridge({
      localServerId: "srv_devbox",
      fleetAggregator: aggregator,
    });

    aggregator.start();

    try {
      // Only DevBox (local) + MacBook should be aggregated; iMac is excluded
      const snapshot = await aggregator.collectFleet({ forceRefresh: true });
      expect(snapshot.hosts.map((h) => h.serverId)).toEqual(["srv_devbox", "srv_macbook"]);
      expect(snapshot.agents.map((a) => a.agentId)).toEqual(["agent_mb_1"]);
      expect(imacClient.subscribeCount).toBe(0);

      // Available remote hosts still reports both MacBook and iMac for Settings UI
      const fleetHosts = await bridge.getFleetHosts();
      expect(fleetHosts.hosts.map((h) => h.serverId)).toEqual(["srv_devbox", "srv_macbook"]);
      expect(fleetHosts.availableRemoteHosts?.map((h) => h.serverId)).toEqual([
        "srv_macbook",
        "srv_imac",
      ]);

      // Out-of-scope dispatch fails explicitly with host_out_of_scope
      await expect(
        aggregator.dispatchAgentOnHost({
          serverId: "srv_imac",
          cwd: "/Users/laokashouji/sideproject",
          title: "Should fail",
          provider: "claude",
        }),
      ).rejects.toMatchObject({
        name: "FleetHostError",
        code: "host_out_of_scope",
        serverId: "srv_imac",
      } satisfies Partial<FleetHostError>);

      await expect(
        bridge.dispatchTaskToTargetHost({
          serverId: "srv_imac",
          cwd: "/Users/laokashouji/sideproject",
          title: "Should fail via bridge",
          provider: "claude",
        }),
      ).rejects.toSatisfy((error: unknown) => {
        return (
          error instanceof MainChatFleetBridgeError &&
          error.code === "host_out_of_scope" &&
          error.message.includes("管辖主机范围")
        );
      });

      // Dynamically switching scope to local_only detaches MacBook immediately
      const unsubscribeBefore = macbookClient.unsubscribeCount;
      currentScope = { mode: "local_only", hostServerIds: [] };
      aggregator.reconcileScope();

      expect(macbookClient.unsubscribeCount).toBeGreaterThan(unsubscribeBefore);
      const localOnlySnapshot = await aggregator.collectFleet({ forceRefresh: true });
      expect(localOnlySnapshot.hosts.map((h) => h.serverId)).toEqual(["srv_devbox"]);
      expect(localOnlySnapshot.agents).toEqual([]);
    } finally {
      aggregator.stop();
    }
  });

  it("persists fleetScope in MainChatService and enforces MCP tool isolation only for steward conversations", async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), "paseo-fleet-scope-"));
    tempDirs.push(homeDir);

    const macbookClient = createFakeRemoteClient([
      createRemoteSnapshot("agent_mb_2", "MacBook task", "/Users/bytedance/work"),
    ]);
    const imacClient = createFakeRemoteClient([
      createRemoteSnapshot("agent_imac_2", "iMac task", "/Users/laokashouji/home"),
    ]);

    const connectedHosts = createStubConnectedHosts({
      selfId: "srv_devbox",
      selfLabel: "DevBox",
      remotes: [
        { serverId: "srv_macbook", label: "MacBook", client: macbookClient },
        { serverId: "srv_imac", label: "iMac", client: imacClient },
      ],
    });

    const mainAgent = {
      id: "agent_steward_main",
      provider: "claude",
      cwd: path.join(homeDir, "main-chat"),
      workspaceId: "wks_main",
      config: { provider: "claude", cwd: path.join(homeDir, "main-chat"), title: "工作管家" },
      lifecycle: "idle",
      attention: {
        requiresAttention: false,
        attentionReason: null,
        attentionTimestamp: null,
        lastUserInteractionAt: null,
      },
      pendingPermissions: new Map(),
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      updatedAt: new Date("2026-11-24T02:00:00.000Z"),
      createdAt: new Date("2026-11-24T01:00:00.000Z"),
      internal: false,
      background: false,
    } as unknown as ManagedAgent;

    const regularAgent = {
      ...mainAgent,
      id: "agent_regular_1",
      cwd: "/repo/regular",
      workspaceId: "wks_regular",
      labels: {},
    } as unknown as ManagedAgent;

    const agentMap = new Map<string, ManagedAgent>([
      [mainAgent.id, mainAgent],
      [regularAgent.id, regularAgent],
    ]);

    const agentManager = {
      listAgents: () => Array.from(agentMap.values()),
      getAgent: (id: string) => agentMap.get(id),
      getPluginTools: () => [],
      subscribe: () => () => {},
      updateAgentMetadata: vi.fn(async () => {}),
      getTimelineStore: () => ({
        list: async () => ({ rows: [], totalCount: 0, hasMoreBefore: false }),
      }),
    } as unknown as AgentManager;

    const agentStorage = {
      listActive: async () => [],
      get: async () => null,
    } as unknown as AgentStorage;

    const providerSnapshotManager = {
      getSnapshot: () => ({ providers: [] }),
    } as unknown as ProviderSnapshotManager;

    const service: MainChatService = createMainChatService({
      paseoHome: homeDir,
      serverId: "srv_devbox",
      hostLabel: "DevBox",
      connectedHosts: () => connectedHosts,
      agentManager,
      agentStorage,
      providerSnapshotManager,
      workspaceRegistry: {
        get: () => undefined,
        listActive: () => [],
      },
      createDirectoryWorkspace: vi.fn(async () => {
        throw new Error("not used");
      }),
      logger,
    });

    await service.start();

    try {
      const updated = await service.updateSettings({
        title: "工作管家",
        fleetScope: {
          mode: "allowlist",
          hostServerIds: ["srv_macbook", "srv_devbox"],
        },
      });
      // Local serverId stripped from remote hostServerIds
      expect(updated.fleetScope).toEqual({
        mode: "allowlist",
        hostServerIds: ["srv_macbook"],
      });

      const fleet = await service.getFleetHosts({ forceRefresh: true });
      expect(fleet.fleetScope).toEqual({
        mode: "allowlist",
        hostServerIds: ["srv_macbook"],
      });
      expect(fleet.hosts.map((h) => h.serverId)).toEqual(["srv_devbox", "srv_macbook"]);
      expect(fleet.availableRemoteHosts?.map((h) => h.serverId)).toEqual([
        "srv_macbook",
        "srv_imac",
      ]);

      expect(service.isManagedConversationAgent?.(mainAgent.id)).toBe(true);
      expect(service.isManagedConversationAgent?.(regularAgent.id)).toBe(false);
      expect(service.isHostAllowedForSteward?.("srv_devbox")).toBe(true);
      expect(service.isHostAllowedForSteward?.("srv_macbook")).toBe(true);
      expect(service.isHostAllowedForSteward?.("srv_imac")).toBe(false);

      // Verify MCP paseo-tools double-layer isolation:
      const remoteUseSpy = vi.fn(async () => ({
        content: [],
        structuredContent: { ok: true },
      }));
      const rawToolHosts: ToolHosts = {
        directory: async (): Promise<HostDirectory> => ({
          self: { serverId: "srv_devbox", label: "DevBox" },
          hosts: connectedHosts.listKnownHosts(),
        }),
        use: async (serverId, action) => {
          remoteUseSpy(serverId);
          return action({
            fetchAgents: async () => ({ entries: [] }),
          } as never);
        },
      };

      const stewardCatalog = createPaseoToolCatalog({
        agentManager,
        agentStorage,
        providerSnapshotManager,
        serverId: "srv_devbox",
        hosts: () => rawToolHosts,
        mainChatService: service,
        callerAgentId: mainAgent.id,
        logger,
      });

      const stewardListHosts = stewardCatalog.getTool("list_hosts")!;
      const stewardDirResult = await stewardListHosts.handler(
        {},
        { signal: new AbortController().signal },
      );
      const stewardDir = stewardDirResult.structuredContent as HostDirectory;
      expect(stewardDir.self.serverId).toBe("srv_devbox");
      expect(stewardDir.hosts.map((h) => h.serverId)).toEqual(["srv_macbook"]);

      // Out-of-scope remote tool call is blocked for steward
      const stewardListAgents = stewardCatalog.getTool("list_agents")!;
      const blockedResult = await stewardListAgents.handler(
        { serverId: "srv_imac" },
        { signal: new AbortController().signal },
      );
      expect(blockedResult.isError).toBe(true);
      expect(JSON.stringify(blockedResult.structuredContent)).toContain("outside this steward");
      expect(remoteUseSpy).not.toHaveBeenCalled();

      // Regular user agent retains full visibility to all connected hosts
      const regularCatalog = createPaseoToolCatalog({
        agentManager,
        agentStorage,
        providerSnapshotManager,
        serverId: "srv_devbox",
        hosts: () => rawToolHosts,
        mainChatService: service,
        callerAgentId: regularAgent.id,
        logger,
      });
      const regularListHosts = regularCatalog.getTool("list_hosts")!;
      const regularDirResult = await regularListHosts.handler(
        {},
        { signal: new AbortController().signal },
      );
      const regularDir = regularDirResult.structuredContent as HostDirectory;
      expect(regularDir.hosts.map((h) => h.serverId)).toEqual(["srv_macbook", "srv_imac"]);
    } finally {
      service.stop();
    }
  });
});
