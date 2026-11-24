import { afterEach, describe, expect, it, vi } from "vitest";
import type { OwnedSubscription, SubscriptionObserver } from "@getpaseo/client";
import type {
  CreateAgentRequestOptions,
  CreateWorkspaceRequestOptions,
  DaemonEvent,
  DaemonEventHandler,
  FetchAgentsOptions,
  FetchAgentTimelineOptions,
  SendMessageOptions,
} from "@getpaseo/client/internal/daemon-client";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPromptInput,
  AgentSessionConfig,
  AgentTimelineItem,
} from "@getpaseo/protocol/agent-types";
import type { AgentSnapshotPayload, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type {
  AgentManager,
  AgentManagerEvent,
  AgentSubscriber,
  CreateAgentOptions,
  ManagedAgent,
} from "../agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../agent/agent-storage.js";
import type { ConnectedHosts, ConnectedHostSummary } from "../connected-hosts/index.js";
import {
  createMainChatFleetAggregator,
  FleetHostError,
  type AggregatedFleetSnapshot,
  type FleetAcceptedHostHandle,
  type FleetAggregatorEvent,
  type FleetConnectedHosts,
  type FleetLocalAgentManager,
  type FleetLocalAgentStorage,
  type FleetRemoteAgentListResult,
  type FleetRemoteDaemonClient,
  type FleetRemoteTimelineResult,
  type FleetRemoteWorkspaceCreateResult,
  type MainChatFleetAggregatorOptions,
} from "./fleet-aggregator.js";

// Compile-time assignability guard: real production singletons must satisfy the narrow interfaces directly.
function _verifyProductionTypeCompatibility(
  agentManager: AgentManager,
  agentStorage: AgentStorage,
  connectedHosts: ConnectedHosts,
): MainChatFleetAggregatorOptions {
  return {
    localServerId: "srv_local",
    localLabel: "DevBox",
    agentManager,
    agentStorage,
    connectedHosts,
  };
}
void _verifyProductionTypeCompatibility;

function createPermission(overrides: Partial<AgentPermissionRequest> = {}): AgentPermissionRequest {
  return {
    id: overrides.id ?? "perm_1",
    provider: overrides.provider ?? "claude",
    name: overrides.name ?? "Bash",
    kind: overrides.kind ?? "tool",
    title: overrides.title ?? "Run tests",
    description: overrides.description ?? "npm test",
  };
}

function createManagedAgentStub(overrides: {
  id: string;
  title?: string;
  cwd?: string;
  workspaceId?: string;
  lifecycle?: ManagedAgent["lifecycle"];
  provider?: string;
  internal?: boolean;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission";
  pendingPermissions?: AgentPermissionRequest[];
  labels?: Record<string, string>;
  lastError?: string;
  updatedAt?: Date;
}): ManagedAgent {
  const pendingMap = new Map<string, AgentPermissionRequest>();
  for (const perm of overrides.pendingPermissions ?? []) {
    pendingMap.set(perm.id, perm);
  }
  const attention = overrides.requiresAttention
    ? {
        requiresAttention: true as const,
        attentionReason: overrides.attentionReason ?? ("finished" as const),
        attentionTimestamp: overrides.updatedAt ?? new Date("2026-11-23T10:00:00.000Z"),
        lastUserInteractionAt: null,
      }
    : {
        requiresAttention: false as const,
        attentionReason: null,
        attentionTimestamp: null,
        lastUserInteractionAt: null,
      };
  const lifecycle = overrides.lifecycle ?? "idle";
  return {
    id: overrides.id,
    provider: overrides.provider ?? "claude",
    cwd: overrides.cwd ?? "/repo/app",
    workspaceId: overrides.workspaceId,
    config: {
      provider: overrides.provider ?? "claude",
      cwd: overrides.cwd ?? "/repo/app",
      title: overrides.title ?? overrides.id,
    },
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    createdAt: new Date("2026-11-23T09:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-11-23T10:00:00.000Z"),
    availableModes: [],
    currentModeId: null,
    pendingPermissions: pendingMap,
    bufferedPermissionResolutions: new Map(),
    inFlightPermissionResponses: new Set(),
    pendingReplacement: false,
    persistence: null,
    historyPrimed: true,
    lastUserMessageAt: null,
    activeTurnId: null,
    activeTurnStartedAt: null,
    lastError: overrides.lastError,
    attention,
    foregroundTurnWaiters: new Set(),
    finalizedForegroundTurnIds: new Set(),
    unsubscribeSession: null,
    internal: overrides.internal,
    labels: overrides.labels ?? {},
    metadata: {},
    lifecycle,
    session: null,
    activeForegroundTurnId: null,
  } as unknown as ManagedAgent;
}

function createStoredRecordStub(overrides: {
  id: string;
  title?: string | null;
  cwd?: string;
  workspaceId?: string;
  lastStatus?: StoredAgentRecord["lastStatus"];
  internal?: boolean;
  archivedAt?: string | null;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  labels?: Record<string, string>;
  lastError?: string | null;
  updatedAt?: string;
}): StoredAgentRecord {
  return {
    id: overrides.id,
    provider: "claude",
    cwd: overrides.cwd ?? "/repo/stored",
    workspaceId: overrides.workspaceId,
    createdAt: "2026-11-23T08:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-11-23T09:30:00.000Z",
    title: overrides.title ?? overrides.id,
    labels: overrides.labels ?? {},
    metadata: {},
    lastStatus: overrides.lastStatus ?? "idle",
    internal: overrides.internal,
    archivedAt: overrides.archivedAt ?? null,
    requiresAttention: overrides.requiresAttention,
    attentionReason: overrides.attentionReason ?? null,
    lastError: overrides.lastError ?? null,
  };
}

function createRemoteSnapshot(overrides: {
  id: string;
  title?: string | null;
  cwd?: string;
  workspaceId?: string;
  status?: AgentSnapshotPayload["status"];
  provider?: string;
  internal?: boolean;
  archivedAt?: string | null;
  requiresAttention?: boolean;
  attentionReason?: "finished" | "error" | "permission" | null;
  pendingPermissions?: AgentPermissionRequest[];
  labels?: Record<string, string>;
  lastError?: string;
  updatedAt?: string;
}): AgentSnapshotPayload {
  return {
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    cwd: overrides.cwd ?? "/Users/dev/project",
    workspaceId: overrides.workspaceId,
    model: "gpt-5.4",
    createdAt: "2026-11-23T09:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-11-23T10:05:00.000Z",
    lastUserMessageAt: null,
    status: overrides.status ?? "running",
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: overrides.pendingPermissions ?? [],
    persistence: null,
    lastError: overrides.lastError,
    title: overrides.title ?? overrides.id,
    labels: overrides.labels ?? {},
    requiresAttention: overrides.requiresAttention,
    attentionReason: overrides.attentionReason ?? null,
    archivedAt: overrides.archivedAt ?? null,
    internal: overrides.internal,
  };
}

function createKnownHostSummary(overrides: {
  registrationId: string;
  serverId: string | null;
  label?: string | null;
  source?: { id: string; key: string };
  metadata?: Record<string, string>;
  targetDescription?: string;
  enabled?: boolean;
  status: ConnectedHostSummary["status"];
  lastOnlineAt?: string | null;
  error?: { code: string; message: string } | null;
}): ConnectedHostSummary {
  return {
    registrationId: overrides.registrationId,
    serverId: overrides.serverId,
    label: overrides.label ?? null,
    source: overrides.source ?? { id: "user", key: overrides.registrationId },
    metadata: overrides.metadata ?? {},
    enabled: overrides.enabled ?? overrides.status !== "disabled",
    status: overrides.status,
    targetDescription:
      overrides.targetDescription ?? `${overrides.serverId ?? overrides.registrationId}.local`,
    lastOnlineAt: overrides.lastOnlineAt ?? null,
    nextRetryAt: null,
    error: overrides.error ?? null,
  };
}

interface FakeLocalEnv {
  liveAgents: Map<string, ManagedAgent>;
  storedRecords: Map<string, StoredAgentRecord>;
  timelines: Map<string, AgentTimelineItem[]>;
  sentPrompts: Array<{ agentId: string; prompt: AgentPromptInput }>;
  permissionResponses: Array<{
    agentId: string;
    requestId: string;
    response: AgentPermissionResponse;
  }>;
  canceledIds: string[];
  archivedIds: string[];
  subscribers: Set<AgentSubscriber>;
  emitEvent(event: AgentManagerEvent): void;
  agentManager: FleetLocalAgentManager;
  agentStorage: FleetLocalAgentStorage;
  sendLocalPrompt: (input: { agentId: string; prompt: AgentPromptInput }) => Promise<void>;
}

function createFakeLocalEnv(): FakeLocalEnv {
  const liveAgents = new Map<string, ManagedAgent>();
  const storedRecords = new Map<string, StoredAgentRecord>();
  const timelines = new Map<string, AgentTimelineItem[]>();
  const sentPrompts: Array<{ agentId: string; prompt: AgentPromptInput }> = [];
  const permissionResponses: Array<{
    agentId: string;
    requestId: string;
    response: AgentPermissionResponse;
  }> = [];
  const canceledIds: string[] = [];
  const archivedIds: string[] = [];
  const subscribers = new Set<AgentSubscriber>();
  let seq = 1;

  const agentManager: FleetLocalAgentManager = {
    listAgents: () => Array.from(liveAgents.values()),
    getAgent: (id) => liveAgents.get(id) ?? null,
    subscribe: (callback) => {
      subscribers.add(callback);
      return () => {
        subscribers.delete(callback);
      };
    },
    createAgent: vi.fn(
      async (
        config: AgentSessionConfig,
        requestedId: string | undefined,
        opts: CreateAgentOptions,
      ) => {
        const id = requestedId ?? `local_created_${seq++}`;
        const created = createManagedAgentStub({
          id,
          provider: config.provider,
          cwd: config.cwd,
          title: config.title ?? opts.initialTitle ?? id,
          workspaceId: opts.workspaceId,
          labels: opts.labels,
          lifecycle: "running",
        });
        liveAgents.set(id, created);
        return created;
      },
    ),
    respondToPermission: vi.fn(async (agentId, requestId, response) => {
      permissionResponses.push({ agentId, requestId, response });
      liveAgents.get(agentId)?.pendingPermissions.delete(requestId);
    }),
    cancelAgentRun: vi.fn(async (agentId) => {
      canceledIds.push(agentId);
    }),
    archiveAgent: vi.fn(async (agentId) => {
      archivedIds.push(agentId);
      liveAgents.delete(agentId);
      return { archivedAt: "2026-11-23T11:00:00.000Z" };
    }),
    getTimeline: vi.fn((id) => timelines.get(id) ?? []),
  };

  const agentStorage: FleetLocalAgentStorage = {
    listActive: vi.fn(async () => Array.from(storedRecords.values())),
    get: vi.fn(async (agentId) => storedRecords.get(agentId) ?? null),
  };

  const sendLocalPrompt = vi.fn(async (input: { agentId: string; prompt: AgentPromptInput }) => {
    sentPrompts.push({ agentId: input.agentId, prompt: input.prompt });
  });

  return {
    liveAgents,
    storedRecords,
    timelines,
    sentPrompts,
    permissionResponses,
    canceledIds,
    archivedIds,
    subscribers,
    emitEvent(event) {
      for (const subscriber of Array.from(subscribers)) subscriber(event);
    },
    agentManager,
    agentStorage,
    sendLocalPrompt,
  };
}

interface FakeRemoteClientController {
  client: FleetRemoteDaemonClient;
  setConnected(connected: boolean): void;
  emitDaemonEvent(event: DaemonEvent): void;
  emitObserveSnapshot(entries: Array<{ agent: AgentSnapshotPayload }>): void;
  emitObserveUpdate(message: SessionOutboundMessage): void;
  subscriberCount(): number;
  observeReleaseCount(): number;
  fetchAgentsMock: ReturnType<typeof vi.fn>;
  createAgentMock: ReturnType<typeof vi.fn>;
  createWorkspaceMock: ReturnType<typeof vi.fn>;
  sendAgentMessageMock: ReturnType<typeof vi.fn>;
  respondToPermissionMock: ReturnType<typeof vi.fn>;
  fetchAgentTimelineMock: ReturnType<typeof vi.fn>;
  cancelAgentMock: ReturnType<typeof vi.fn>;
  archiveAgentMock: ReturnType<typeof vi.fn>;
}

function createFakeRemoteClient(options?: {
  initialAgents?: AgentSnapshotPayload[];
  supportObserveAgents?: boolean;
  fetchAgentsImpl?: (opts?: FetchAgentsOptions) => Promise<FleetRemoteAgentListResult>;
  timelineEntries?: FleetRemoteTimelineResult["entries"];
}): FakeRemoteClientController {
  let connected = true;
  const eventHandlers = new Set<DaemonEventHandler>();
  const observeObservers = new Set<
    SubscriptionObserver<FleetRemoteAgentListResult & { subscriptionId: string }>
  >();
  let releaseCount = 0;

  const fetchAgentsMock = vi.fn(
    options?.fetchAgentsImpl ??
      (async (): Promise<FleetRemoteAgentListResult> => ({
        entries: (options?.initialAgents ?? []).map((agent) => ({ agent })),
      })),
  );

  const createAgentMock = vi.fn(
    async (req: CreateAgentRequestOptions): Promise<AgentSnapshotPayload> =>
      createRemoteSnapshot({
        id: `remote_created_${req.config?.title ?? "agent"}`,
        provider: req.config?.provider ?? req.provider ?? "codex",
        cwd: req.config?.cwd ?? req.cwd ?? "/remote/repo",
        title: req.config?.title ?? req.title ?? "Remote Task",
        workspaceId: req.workspaceId,
        labels: req.labels,
        status: "running",
      }),
  );

  const createWorkspaceMock = vi.fn(
    async (req: CreateWorkspaceRequestOptions): Promise<FleetRemoteWorkspaceCreateResult> => ({
      workspace: {
        id: "ws_remote_new",
        workspaceDirectory:
          req.source.kind === "worktree" ? `${req.source.cwd}/.wt` : req.source.path,
      },
      error: null,
    }),
  );

  const sendAgentMessageMock = vi.fn(
    async (_agentId: string, _text: string, _opts?: SendMessageOptions) => ({}),
  );
  const respondToPermissionMock = vi.fn(async () => undefined);
  const fetchAgentTimelineMock = vi.fn(
    async (
      _agentId: string,
      _opts?: FetchAgentTimelineOptions,
    ): Promise<FleetRemoteTimelineResult> => ({
      entries: options?.timelineEntries ?? [],
    }),
  );
  const cancelAgentMock = vi.fn(async () => undefined);
  const archiveAgentMock = vi.fn(async () => ({ archivedAt: "2026-11-23T11:00:00.000Z" }));

  const observeAgents = options?.supportObserveAgents
    ? (): OwnedSubscription<FleetRemoteAgentListResult> => {
        const snapshotPayload = {
          subscriptionId: "sub_1",
          entries: (options?.initialAgents ?? []).map((agent) => ({ agent })),
        };
        return {
          subscriptionId: "sub_1",
          ready: Promise.resolve(snapshotPayload),
          subscribe: (observer) => {
            observeObservers.add(observer);
            observer.snapshot(snapshotPayload);
            return () => {
              observeObservers.delete(observer);
            };
          },
          release: async () => {
            releaseCount += 1;
            observeObservers.clear();
          },
        };
      }
    : undefined;

  const client: FleetRemoteDaemonClient = {
    get isConnected() {
      return connected;
    },
    fetchAgents: fetchAgentsMock,
    ...(observeAgents ? { observeAgents } : {}),
    subscribe: (handler) => {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },
    createAgent: createAgentMock,
    createWorkspace: createWorkspaceMock,
    sendAgentMessage: sendAgentMessageMock,
    respondToPermission: respondToPermissionMock,
    fetchAgentTimeline: fetchAgentTimelineMock,
    cancelAgent: cancelAgentMock,
    archiveAgent: archiveAgentMock,
  };

  return {
    client,
    setConnected(value) {
      connected = value;
    },
    emitDaemonEvent(event) {
      for (const handler of Array.from(eventHandlers)) handler(event);
    },
    emitObserveSnapshot(entries) {
      for (const observer of Array.from(observeObservers)) {
        observer.snapshot({ subscriptionId: "sub_1", entries });
      }
    },
    emitObserveUpdate(message) {
      for (const observer of Array.from(observeObservers)) {
        observer.update(message);
      }
    },
    subscriberCount: () => eventHandlers.size,
    observeReleaseCount: () => releaseCount,
    fetchAgentsMock,
    createAgentMock,
    createWorkspaceMock,
    sendAgentMessageMock,
    respondToPermissionMock,
    fetchAgentTimelineMock,
    cancelAgentMock,
    archiveAgentMock,
  };
}

class FakeConnectedHosts implements FleetConnectedHosts {
  private readonly listeners = new Set<() => void>();
  private known: ConnectedHostSummary[] = [];
  private accepted = new Map<string, FleetAcceptedHostHandle>();

  constructor(private readonly self = { serverId: "srv_local", label: "DevBox" }) {}

  setState(known: ConnectedHostSummary[], accepted: FleetAcceptedHostHandle[]): void {
    this.known = known;
    this.accepted = new Map(accepted.map((handle) => [handle.serverId, handle]));
  }

  notifyChanged(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  getSelfHost() {
    return { ...this.self };
  }

  listAcceptedHosts(): FleetAcceptedHostHandle[] {
    return Array.from(this.accepted.values()).filter((handle) => handle.client.isConnected);
  }

  getAcceptedClient(serverId: string): FleetRemoteDaemonClient | null {
    const handle = this.accepted.get(serverId);
    if (!handle || !handle.client.isConnected) return null;
    return handle.client;
  }

  listKnownHosts(): ConnectedHostSummary[] {
    return this.known.map((item) => structuredClone(item));
  }

  subscribeHostChanges(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MainChatFleetAggregator", () => {
  it("aggregates local and multiple remote hosts while filtering archived, internal, and excluded agents", async () => {
    const local = createFakeLocalEnv();
    local.liveAgents.set(
      "local_live_1",
      createManagedAgentStub({
        id: "local_live_1",
        title: "Local Permission Task",
        cwd: "/repo/frontend",
        workspaceId: "ws_local_1",
        lifecycle: "running",
        requiresAttention: true,
        attentionReason: "permission",
        pendingPermissions: [createPermission({ id: "perm_local", title: "Write file" })],
        labels: { team: "web" },
        updatedAt: new Date("2026-11-23T10:20:00.000Z"),
      }),
    );
    local.liveAgents.set(
      "local_internal",
      createManagedAgentStub({
        id: "local_internal",
        title: "Hidden Internal Helper",
        internal: true,
        updatedAt: new Date("2026-11-23T10:25:00.000Z"),
      }),
    );
    local.liveAgents.set(
      "main_chat_self",
      createManagedAgentStub({
        id: "main_chat_self",
        title: "Main Chat",
        updatedAt: new Date("2026-11-23T10:30:00.000Z"),
      }),
    );
    // Stored duplicate of local_live_1 should not overwrite live state.
    local.storedRecords.set(
      "local_live_1",
      createStoredRecordStub({
        id: "local_live_1",
        title: "Stale Stored Copy",
        lastStatus: "closed",
      }),
    );
    local.storedRecords.set(
      "local_stored_1",
      createStoredRecordStub({
        id: "local_stored_1",
        title: "Persisted Idle Task",
        cwd: "/repo/backend",
        workspaceId: "ws_local_2",
        lastStatus: "idle",
        updatedAt: "2026-11-23T09:50:00.000Z",
      }),
    );
    local.storedRecords.set(
      "local_archived",
      createStoredRecordStub({
        id: "local_archived",
        title: "Archived Local",
        archivedAt: "2026-11-23T09:00:00.000Z",
      }),
    );
    local.storedRecords.set(
      "local_stored_internal",
      createStoredRecordStub({
        id: "local_stored_internal",
        title: "Stored Internal",
        internal: true,
      }),
    );

    const mac = createFakeRemoteClient({
      initialAgents: [
        createRemoteSnapshot({
          id: "mac_run_1",
          title: "iOS Build",
          cwd: "/Users/dev/ios",
          workspaceId: "ws_mac_1",
          status: "running",
          labels: { platform: "ios" },
          updatedAt: "2026-11-23T10:15:00.000Z",
        }),
        createRemoteSnapshot({
          id: "mac_archived",
          title: "Old Mac Task",
          archivedAt: "2026-11-23T08:00:00.000Z",
        }),
        createRemoteSnapshot({
          id: "mac_internal",
          title: "Mac Internal Triage",
          internal: true,
        }),
      ],
    });
    const imac = createFakeRemoteClient({
      initialAgents: [
        createRemoteSnapshot({
          id: "imac_err_1",
          title: "Model Train",
          cwd: "/Users/home/ml",
          status: "error",
          requiresAttention: true,
          attentionReason: "error",
          lastError: "CUDA out of memory",
          updatedAt: "2026-11-23T10:10:00.000Z",
        }),
      ],
    });

    const hosts = new FakeConnectedHosts();
    hosts.setState(
      [
        createKnownHostSummary({
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          status: "online",
          lastOnlineAt: "2026-11-23T10:00:00.000Z",
        }),
        createKnownHostSummary({
          registrationId: "reg_imac",
          serverId: "srv_imac",
          label: "iMac",
          status: "online",
          lastOnlineAt: "2026-11-23T10:00:00.000Z",
        }),
      ],
      [
        {
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          client: mac.client,
          lastOnlineAt: "2026-11-23T10:00:00.000Z",
        },
        {
          registrationId: "reg_imac",
          serverId: "srv_imac",
          label: "iMac",
          client: imac.client,
          lastOnlineAt: "2026-11-23T10:00:00.000Z",
        },
      ],
    );

    const aggregator = createMainChatFleetAggregator({
      localServerId: "srv_local",
      localLabel: "DevBox",
      agentManager: local.agentManager,
      agentStorage: local.agentStorage,
      connectedHosts: hosts,
      sendLocalPrompt: local.sendLocalPrompt,
    });

    const snapshot = await aggregator.collectFleet({
      excludeAgentIds: new Set(["main_chat_self"]),
    });

    expect(snapshot.localServerId).toBe("srv_local");
    expect(snapshot.agents.map((agent) => agent.agentId)).toEqual([
      "local_live_1",
      "mac_run_1",
      "imac_err_1",
      "local_stored_1",
    ]);

    const localLive = snapshot.agents.find((agent) => agent.agentId === "local_live_1");
    expect(localLive).toMatchObject({
      serverId: "srv_local",
      hostLabel: "DevBox",
      isLocal: true,
      workspaceId: "ws_local_1",
      lifecycle: "running",
      requiresAttention: true,
      attentionReason: "permission",
      labels: { team: "web" },
      stale: false,
    });
    expect(localLive?.pendingPermissions).toEqual([
      {
        requestId: "perm_local",
        name: "Bash",
        title: "Write file",
        description: "npm test",
        kind: "tool",
      },
    ]);

    const imacErr = snapshot.agents.find((agent) => agent.agentId === "imac_err_1");
    expect(imacErr).toMatchObject({
      serverId: "srv_imac",
      hostLabel: "iMac",
      isLocal: false,
      lifecycle: "error",
      lastError: "CUDA out of memory",
      stale: false,
    });

    expect(snapshot.hosts).toEqual([
      expect.objectContaining({
        serverId: "srv_local",
        label: "DevBox",
        isLocal: true,
        status: "online",
        agentCount: 2,
        needsAttentionCount: 1,
        error: null,
      }),
      expect.objectContaining({
        serverId: "srv_imac",
        label: "iMac",
        isLocal: false,
        status: "online",
        agentCount: 1,
        needsAttentionCount: 1,
        error: null,
      }),
      expect.objectContaining({
        serverId: "srv_mac",
        label: "MacBook",
        isLocal: false,
        status: "online",
        agentCount: 1,
        needsAttentionCount: 0,
        error: null,
      }),
    ]);

    aggregator.stop();
  });

  it("isolates remote timeouts, RPC errors, offline/connecting/disabled hosts, and preserves stale cache when degraded", async () => {
    vi.useFakeTimers();

    const local = createFakeLocalEnv();
    local.liveAgents.set(
      "local_ok",
      createManagedAgentStub({ id: "local_ok", title: "Local Healthy" }),
    );

    let flakyShouldFail = false;
    const flaky = createFakeRemoteClient({
      fetchAgentsImpl: async () => {
        if (flakyShouldFail) {
          throw new Error("RPC auth expired");
        }
        return {
          entries: [
            {
              agent: createRemoteSnapshot({
                id: "flaky_agent_1",
                title: "Cached Remote Task",
                updatedAt: "2026-11-23T10:05:00.000Z",
              }),
            },
          ],
        };
      },
    });

    const slow = createFakeRemoteClient({
      fetchAgentsImpl: () => new Promise<FleetRemoteAgentListResult>(() => {}),
    });

    const hosts = new FakeConnectedHosts();
    hosts.setState(
      [
        createKnownHostSummary({
          registrationId: "reg_flaky",
          serverId: "srv_flaky",
          label: "FlakyMac",
          status: "online",
        }),
        createKnownHostSummary({
          registrationId: "reg_slow",
          serverId: "srv_slow",
          label: "SlowBox",
          status: "online",
        }),
        createKnownHostSummary({
          registrationId: "reg_off",
          serverId: "srv_off",
          label: "OfflineMini",
          status: "offline",
          lastOnlineAt: "2026-11-23T09:00:00.000Z",
          error: { code: "host_offline", message: "Cannot reach host" },
        }),
        createKnownHostSummary({
          registrationId: "reg_conn",
          serverId: "srv_conn",
          label: "ConnectingHost",
          status: "connecting",
        }),
        createKnownHostSummary({
          registrationId: "reg_dis",
          serverId: "srv_dis",
          label: "DisabledHost",
          status: "disabled",
        }),
      ],
      [
        {
          registrationId: "reg_flaky",
          serverId: "srv_flaky",
          label: "FlakyMac",
          client: flaky.client,
          lastOnlineAt: "2026-11-23T10:00:00.000Z",
        },
        {
          registrationId: "reg_slow",
          serverId: "srv_slow",
          label: "SlowBox",
          client: slow.client,
          lastOnlineAt: "2026-11-23T10:00:00.000Z",
        },
      ],
    );

    const aggregator = createMainChatFleetAggregator({
      localServerId: "srv_local",
      localLabel: "DevBox",
      agentManager: local.agentManager,
      agentStorage: local.agentStorage,
      connectedHosts: hosts,
      remoteTimeoutMs: 500,
    });

    // First sync: FlakyMac succeeds, SlowBox times out after 500ms.
    const firstPromise = aggregator.collectFleet();
    await vi.advanceTimersByTimeAsync(500);
    const first = await firstPromise;

    expect(first.agents.map((a) => ({ id: a.agentId, stale: a.stale }))).toEqual([
      { id: "flaky_agent_1", stale: false },
      { id: "local_ok", stale: false },
    ]);
    expect(first.hosts.find((h) => h.serverId === "srv_flaky")).toMatchObject({
      status: "online",
      agentCount: 1,
      error: null,
    });
    expect(first.hosts.find((h) => h.serverId === "srv_slow")).toMatchObject({
      status: "error",
      agentCount: 0,
      error: expect.stringContaining("timed out"),
    });
    expect(first.hosts.find((h) => h.serverId === "srv_off")).toMatchObject({
      status: "offline",
      error: "Cannot reach host",
      lastSyncedAt: "2026-11-23T09:00:00.000Z",
    });
    expect(first.hosts.find((h) => h.serverId === "srv_conn")?.status).toBe("connecting");
    expect(first.hosts.find((h) => h.serverId === "srv_dis")).toMatchObject({
      status: "offline",
      agentCount: 0,
    });

    // Second forced refresh: FlakyMac fails after having a prior cache -> degraded + stale: true.
    flakyShouldFail = true;
    const secondPromise = aggregator.collectFleet({ forceRefresh: true });
    await vi.advanceTimersByTimeAsync(500);
    const second = await secondPromise;

    expect(second.hosts.find((h) => h.serverId === "srv_flaky")).toMatchObject({
      status: "degraded",
      agentCount: 1,
      error: "RPC auth expired",
    });
    expect(second.agents.find((a) => a.agentId === "flaky_agent_1")?.stale).toBe(true);
    expect(second.agents.find((a) => a.agentId === "local_ok")?.stale).toBe(false);

    // Disabling FlakyMac clears its cached entries completely.
    hosts.setState(
      [
        createKnownHostSummary({
          registrationId: "reg_flaky",
          serverId: "srv_flaky",
          label: "FlakyMac",
          status: "disabled",
        }),
      ],
      [],
    );
    const third = await aggregator.collectFleet();
    expect(third.agents.map((a) => a.agentId)).toEqual(["local_ok"]);
    expect(third.hosts.find((h) => h.serverId === "srv_flaky")).toMatchObject({
      status: "offline",
      agentCount: 0,
    });

    aggregator.stop();
  });

  it("deduplicates concurrent collectFleet calls via in-flight sync coalescing", async () => {
    const local = createFakeLocalEnv();
    let resolveFetch!: (result: FleetRemoteAgentListResult) => void;
    const mac = createFakeRemoteClient({
      fetchAgentsImpl: () =>
        new Promise<FleetRemoteAgentListResult>((resolve) => {
          resolveFetch = resolve;
        }),
    });

    const hosts = new FakeConnectedHosts();
    hosts.setState(
      [
        createKnownHostSummary({
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          status: "online",
        }),
      ],
      [
        {
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          client: mac.client,
          lastOnlineAt: "2026-11-23T10:00:00.000Z",
        },
      ],
    );

    const aggregator = createMainChatFleetAggregator({
      localServerId: "srv_local",
      localLabel: "DevBox",
      agentManager: local.agentManager,
      agentStorage: local.agentStorage,
      connectedHosts: hosts,
      remotePollIntervalMs: 60_000,
    });

    // Launch 5 concurrent calls while the first RPC is in flight.
    const pending: Promise<AggregatedFleetSnapshot>[] = [
      aggregator.collectFleet(),
      aggregator.collectFleet(),
      aggregator.collectFleet({ forceRefresh: true }),
      aggregator.collectFleet(),
      aggregator.collectFleet({ forceRefresh: true }),
    ];

    expect(mac.fetchAgentsMock).toHaveBeenCalledTimes(1);

    resolveFetch({
      entries: [{ agent: createRemoteSnapshot({ id: "mac_a", title: "Coalesced Task" }) }],
    });

    const snapshots = await Promise.all(pending);
    expect(mac.fetchAgentsMock).toHaveBeenCalledTimes(1);
    for (const snap of snapshots) {
      expect(snap.agents.map((a) => a.agentId)).toEqual(["mac_a"]);
    }

    // Within poll interval, non-forced collectFleet reuses cache without issuing another RPC.
    const cached = await aggregator.collectFleet();
    expect(cached.agents.map((a) => a.agentId)).toEqual(["mac_a"]);
    expect(mac.fetchAgentsMock).toHaveBeenCalledTimes(1);

    // Forced refresh after settling starts a new RPC.
    const forcedPromise = aggregator.collectFleet({ forceRefresh: true });
    expect(mac.fetchAgentsMock).toHaveBeenCalledTimes(2);
    resolveFetch({
      entries: [{ agent: createRemoteSnapshot({ id: "mac_b", title: "Refreshed Task" }) }],
    });
    const refreshed = await forcedPromise;
    expect(refreshed.agents.map((a) => a.agentId)).toEqual(["mac_b"]);

    aggregator.stop();
  });

  it("handles dynamic host online/offline/reconnect transitions and emits deduplicated events", async () => {
    const local = createFakeLocalEnv();
    const hosts = new FakeConnectedHosts();

    const aggregator = createMainChatFleetAggregator({
      localServerId: "srv_local",
      localLabel: "DevBox",
      agentManager: local.agentManager,
      agentStorage: local.agentStorage,
      connectedHosts: hosts,
      remotePollIntervalMs: 0,
    });

    const events: FleetAggregatorEvent[] = [];
    // Broken subscriber must not stop healthy subscribers from receiving events.
    const unsubscribeBroken = aggregator.subscribe(() => {
      throw new Error("listener boom");
    });
    const unsubscribeEvents = aggregator.subscribe((event) => {
      events.push(event);
    });

    aggregator.start();

    // Local permission request & local internal agent filtering.
    const localPerm = createPermission({ id: "perm_l1", title: "Edit config" });
    const localAgent = createManagedAgentStub({
      id: "local_1",
      pendingPermissions: [localPerm],
    });
    local.liveAgents.set("local_1", localAgent);
    local.emitEvent({ type: "agent_state", agent: localAgent });
    // Re-emitting agent_state with the same permission should not duplicate permission_requested.
    local.emitEvent({ type: "agent_state", agent: localAgent });
    local.emitEvent({
      type: "agent_state",
      agent: createManagedAgentStub({ id: "internal_1", internal: true }),
    });

    expect(
      events.filter((e) => e.type === "permission_requested" && e.agentId === "local_1"),
    ).toHaveLength(1);
    expect(
      events.some((e) => e.type === "agents_changed" && e.agentIds?.includes("internal_1")),
    ).toBe(false);

    // Remote host comes online with observeAgents support.
    const mac1 = createFakeRemoteClient({
      supportObserveAgents: true,
      initialAgents: [createRemoteSnapshot({ id: "mac_1", title: "Initial Remote" })],
    });
    hosts.setState(
      [
        createKnownHostSummary({
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          status: "online",
        }),
      ],
      [
        {
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          client: mac1.client,
          lastOnlineAt: "2026-11-23T10:00:00.000Z",
        },
      ],
    );
    hosts.notifyChanged();

    expect(mac1.subscriberCount()).toBe(1);
    expect(events.some((e) => e.type === "hosts_changed")).toBe(true);

    // Remote observeAgents incremental upsert (active + filtered internal/archived) and remove.
    mac1.emitObserveUpdate({
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: createRemoteSnapshot({
          id: "mac_2",
          title: "Streamed Upsert Task",
          status: "running",
        }),
      },
    });
    mac1.emitObserveUpdate({
      type: "agent_update",
      payload: {
        kind: "upsert",
        agent: createRemoteSnapshot({
          id: "mac_internal_stream",
          title: "Hidden",
          internal: true,
        }),
      },
    });
    const afterUpsertSnap = await aggregator.collectFleet();
    expect(afterUpsertSnap.agents.map((a) => a.agentId)).toEqual(
      expect.arrayContaining(["mac_1", "mac_2"]),
    );
    expect(afterUpsertSnap.agents.some((a) => a.agentId === "mac_internal_stream")).toBe(false);

    mac1.emitObserveUpdate({
      type: "agent_update",
      payload: { kind: "remove", agentId: "mac_2" },
    });
    const afterRemoveSnap = await aggregator.collectFleet();
    expect(afterRemoveSnap.agents.some((a) => a.agentId === "mac_2")).toBe(false);

    // Remote permission request & resolution via DaemonEvent.
    const remotePerm = createPermission({ id: "perm_r1", name: "Write", title: "Write main.ts" });
    mac1.emitDaemonEvent({
      type: "agent_permission_request",
      agentId: "mac_1",
      request: remotePerm,
    });
    expect(events).toContainEqual({
      type: "permission_requested",
      serverId: "srv_mac",
      hostLabel: "MacBook",
      isLocal: false,
      agentId: "mac_1",
      permission: {
        requestId: "perm_r1",
        name: "Write",
        title: "Write main.ts",
        description: "npm test",
        kind: "tool",
      },
    });

    mac1.emitDaemonEvent({
      type: "agent_permission_resolved",
      agentId: "mac_1",
      requestId: "perm_r1",
      resolution: { behavior: "allow" },
    });
    expect(events).toContainEqual({
      type: "permission_resolved",
      serverId: "srv_mac",
      agentId: "mac_1",
      requestId: "perm_r1",
    });

    // Remote host goes offline -> subscriptions cleaned, stale cache retained.
    mac1.setConnected(false);
    hosts.setState(
      [
        createKnownHostSummary({
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          status: "offline",
          error: { code: "host_offline", message: "Connection dropped" },
        }),
      ],
      [],
    );
    hosts.notifyChanged();

    expect(mac1.subscriberCount()).toBe(0);
    expect(mac1.observeReleaseCount()).toBe(1);

    const offlineSnap = await aggregator.collectFleet();
    expect(offlineSnap.hosts.find((h) => h.serverId === "srv_mac")?.status).toBe("offline");
    expect(offlineSnap.agents.find((a) => a.agentId === "mac_1")?.stale).toBe(true);

    // Remote host reconnects with a fresh DaemonClient instance.
    const mac2 = createFakeRemoteClient({
      supportObserveAgents: true,
      initialAgents: [createRemoteSnapshot({ id: "mac_1", title: "Reconnected Remote" })],
    });
    hosts.setState(
      [
        createKnownHostSummary({
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          status: "online",
        }),
      ],
      [
        {
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          client: mac2.client,
          lastOnlineAt: "2026-11-23T10:30:00.000Z",
        },
      ],
    );
    hosts.notifyChanged();

    expect(mac2.subscriberCount()).toBe(1);
    const recoveredSnap = await aggregator.collectFleet();
    expect(recoveredSnap.hosts.find((h) => h.serverId === "srv_mac")?.status).toBe("online");
    expect(recoveredSnap.agents.find((a) => a.agentId === "mac_1")).toMatchObject({
      title: "Reconnected Remote",
      stale: false,
    });

    unsubscribeBroken();
    unsubscribeEvents();
    aggregator.stop();
  });

  it("executes cross-host dispatch, prompt, permission, tail read, and cancel/archive on local and remote hosts with typed errors", async () => {
    const local = createFakeLocalEnv();
    local.liveAgents.set(
      "local_worker",
      createManagedAgentStub({
        id: "local_worker",
        title: "Local Worker",
        pendingPermissions: [createPermission({ id: "perm_local_1" })],
      }),
    );
    local.timelines.set("local_worker", [
      { type: "user_message", text: "Fix the bug" },
      { type: "compaction", status: "completed" },
      {
        type: "tool_call",
        callId: "call_1",
        name: "Bash",
        status: "completed",
        error: null,
        detail: { type: "shell", command: "npm test" },
      },
      { type: "assistant_message", text: "All tests pass now." },
    ]);

    const mac = createFakeRemoteClient({
      initialAgents: [
        createRemoteSnapshot({
          id: "remote_worker",
          title: "Mac Worker",
          pendingPermissions: [createPermission({ id: "perm_remote_1" })],
        }),
      ],
      timelineEntries: [
        {
          item: { type: "user_message", text: "Build iOS" },
          timestamp: "2026-11-23T10:00:00.000Z",
          seqEnd: 1,
        },
        { item: { type: "todo", items: [] }, timestamp: "2026-11-23T10:00:05.000Z", seqEnd: 2 },
        {
          item: { type: "reasoning", text: "Checking Xcode..." },
          timestamp: "2026-11-23T10:00:10.000Z",
          seqEnd: 3,
        },
        {
          item: { type: "assistant_message", text: "Build succeeded." },
          timestamp: "2026-11-23T10:01:00.000Z",
          seqEnd: 4,
        },
      ],
    });

    const hosts = new FakeConnectedHosts();
    hosts.setState(
      [
        createKnownHostSummary({
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          status: "online",
        }),
        createKnownHostSummary({
          registrationId: "reg_offline",
          serverId: "srv_offline",
          label: "OfflineMini",
          status: "offline",
          error: { code: "host_offline", message: "Host sleeping" },
        }),
      ],
      [
        {
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          client: mac.client,
          lastOnlineAt: "2026-11-23T10:00:00.000Z",
        },
      ],
    );

    const aggregator = createMainChatFleetAggregator({
      localServerId: "srv_local",
      localLabel: "DevBox",
      agentManager: local.agentManager,
      agentStorage: local.agentStorage,
      connectedHosts: hosts,
      sendLocalPrompt: local.sendLocalPrompt,
    });

    // Prime remote cache.
    await aggregator.collectFleet();

    // 1. dispatchAgentOnHost (local + remote with worktree isolation)
    const localDispatched = await aggregator.dispatchAgentOnHost({
      serverId: "srv_local",
      cwd: "/repo/app",
      title: "Local Subtask",
      provider: "claude",
      model: "claude-opus-4-6",
      modeId: "default",
      thinkingOptionId: "high",
      initialPrompt: "Implement feature X",
      labels: { origin: "main" },
      workspaceId: "ws_1",
    });
    expect(localDispatched).toMatchObject({
      serverId: "srv_local",
      hostLabel: "DevBox",
      isLocal: true,
      workspaceId: "ws_1",
      title: "Local Subtask",
      provider: "claude",
    });
    expect(local.sentPrompts).toContainEqual({
      agentId: localDispatched.agentId,
      prompt: "Implement feature X",
    });

    const remoteDispatched = await aggregator.dispatchAgentOnHost({
      serverId: "srv_mac",
      cwd: "/Users/dev/ios",
      title: "Mac Subtask",
      provider: "codex",
      model: "gpt-5.4",
      initialPrompt: "Run simulator tests",
      isolation: "worktree",
      branchName: "feat/ios-check",
      labels: { origin: "main" },
    });
    expect(mac.createWorkspaceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({
          kind: "worktree",
          cwd: "/Users/dev/ios",
          branchName: "feat/ios-check",
        }),
      }),
    );
    expect(remoteDispatched).toMatchObject({
      serverId: "srv_mac",
      hostLabel: "MacBook",
      isLocal: false,
      workspaceId: "ws_remote_new",
      cwd: "/Users/dev/ios/.wt",
      title: "Mac Subtask",
    });

    // 2. sendPromptToHostAgent (local with images + remote with images)
    await aggregator.sendPromptToHostAgent("srv_local", "local_worker", "Look at this", {
      images: [{ data: "base64img", mimeType: "image/png" }],
    });
    expect(local.sentPrompts.at(-1)).toEqual({
      agentId: "local_worker",
      prompt: [
        { type: "text", text: "Look at this" },
        { type: "image", data: "base64img", mimeType: "image/png" },
      ],
    });

    await aggregator.sendPromptToHostAgent("srv_mac", "remote_worker", "Continue please", {
      images: [{ data: "abc", mimeType: "image/jpeg" }],
      activeTurnBehavior: "steer",
    });
    expect(mac.sendAgentMessageMock).toHaveBeenCalledWith("remote_worker", "Continue please", {
      images: [{ data: "abc", mimeType: "image/jpeg" }],
      activeTurnBehavior: "steer",
    });

    // 3. respondPermissionOnHost (local + remote optimistic cache cleanup)
    await aggregator.respondPermissionOnHost("srv_local", "local_worker", "perm_local_1", {
      behavior: "allow",
    });
    expect(local.permissionResponses).toEqual([
      { agentId: "local_worker", requestId: "perm_local_1", response: { behavior: "allow" } },
    ]);

    await aggregator.respondPermissionOnHost("srv_mac", "remote_worker", "perm_remote_1", {
      behavior: "deny",
      message: "Do not push yet",
    });
    expect(mac.respondToPermissionMock).toHaveBeenCalledWith("remote_worker", "perm_remote_1", {
      behavior: "deny",
      message: "Do not push yet",
    });
    const afterPermSnap = await aggregator.collectFleet();
    expect(
      afterPermSnap.agents.find((a) => a.agentId === "remote_worker")?.pendingPermissions,
    ).toEqual([]);

    // 4. readHostAgentTail (local + remote, skips non-message items and respects limit)
    const localTail = await aggregator.readHostAgentTail("srv_local", "local_worker", { limit: 2 });
    expect(localTail).toEqual([
      {
        role: "tool",
        text: "Bash: npm test",
        timestamp: null,
        toolName: "Bash",
        toolStatus: "completed",
      },
      {
        role: "assistant",
        text: "All tests pass now.",
        timestamp: null,
      },
    ]);

    const remoteTail = await aggregator.readHostAgentTail("srv_mac", "remote_worker", { limit: 2 });
    expect(remoteTail).toEqual([
      {
        role: "reasoning",
        text: "Checking Xcode...",
        timestamp: "2026-11-23T10:00:10.000Z",
        seq: 3,
      },
      {
        role: "assistant",
        text: "Build succeeded.",
        timestamp: "2026-11-23T10:01:00.000Z",
        seq: 4,
      },
    ]);

    // 5. controlHostAgent (cancel + archive on both local and remote)
    await aggregator.controlHostAgent("srv_local", "local_worker", "cancel");
    await aggregator.controlHostAgent("srv_local", "local_worker", "archive");
    expect(local.canceledIds).toEqual(["local_worker"]);
    expect(local.archivedIds).toEqual(["local_worker"]);

    await aggregator.controlHostAgent("srv_mac", "remote_worker", "cancel");
    await aggregator.controlHostAgent("srv_mac", "remote_worker", "archive");
    expect(mac.cancelAgentMock).toHaveBeenCalledWith("remote_worker");
    expect(mac.archiveAgentMock).toHaveBeenCalledWith("remote_worker");
    const afterArchiveSnap = await aggregator.collectFleet();
    expect(afterArchiveSnap.agents.some((a) => a.agentId === "remote_worker")).toBe(false);

    // 6. Structured error codes: host_unknown and host_offline across APIs
    await expect(
      aggregator.dispatchAgentOnHost({
        serverId: "srv_does_not_exist",
        cwd: "/tmp",
        title: "Nope",
        provider: "claude",
      }),
    ).rejects.toMatchObject({
      name: "FleetHostError",
      code: "host_unknown",
      serverId: "srv_does_not_exist",
    });

    await expect(
      aggregator.dispatchAgentOnHost({
        serverId: "srv_offline",
        cwd: "/tmp",
        title: "Sleeping",
        provider: "claude",
      }),
    ).rejects.toMatchObject({
      name: "FleetHostError",
      code: "host_offline",
      serverId: "srv_offline",
    });

    await expect(
      aggregator.sendPromptToHostAgent("srv_does_not_exist", "a1", "hi"),
    ).rejects.toBeInstanceOf(FleetHostError);
    await expect(aggregator.sendPromptToHostAgent("srv_offline", "a1", "hi")).rejects.toMatchObject(
      { code: "host_offline" },
    );
    await expect(
      aggregator.respondPermissionOnHost("srv_does_not_exist", "a1", "p1", { behavior: "allow" }),
    ).rejects.toMatchObject({ code: "host_unknown" });
    await expect(aggregator.readHostAgentTail("srv_offline", "a1")).rejects.toMatchObject({
      code: "host_offline",
    });
    await expect(
      aggregator.controlHostAgent("srv_does_not_exist", "a1", "cancel"),
    ).rejects.toMatchObject({ code: "host_unknown" });

    // Remote timeout error on dispatch
    vi.useFakeTimers();
    mac.createAgentMock.mockImplementationOnce(() => new Promise(() => {}));
    const timedOutDispatch = aggregator.dispatchAgentOnHost({
      serverId: "srv_mac",
      cwd: "/Users/dev/ios",
      title: "Hang",
      provider: "codex",
      workspaceId: "ws_1",
      timeoutMs: 300,
    });
    const assertion = expect(timedOutDispatch).rejects.toMatchObject({
      name: "FleetHostError",
      code: "timeout",
      serverId: "srv_mac",
    });
    await vi.advanceTimersByTimeAsync(300);
    await assertion;

    aggregator.stop();
  });

  it("stop() releases all host/agent subscriptions, intervals, and in-flight timeout timers without leaks", async () => {
    vi.useFakeTimers();

    const local = createFakeLocalEnv();
    const mac = createFakeRemoteClient({
      supportObserveAgents: true,
      fetchAgentsImpl: () => new Promise<FleetRemoteAgentListResult>(() => {}),
    });

    const hosts = new FakeConnectedHosts();
    hosts.setState(
      [
        createKnownHostSummary({
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          status: "online",
        }),
      ],
      [
        {
          registrationId: "reg_mac",
          serverId: "srv_mac",
          label: "MacBook",
          client: mac.client,
          lastOnlineAt: "2026-11-23T10:00:00.000Z",
        },
      ],
    );

    const aggregator = createMainChatFleetAggregator({
      localServerId: "srv_local",
      localLabel: "DevBox",
      agentManager: local.agentManager,
      agentStorage: local.agentStorage,
      connectedHosts: hosts,
      remotePollIntervalMs: 1_000,
      remoteTimeoutMs: 5_000,
    });

    const eventsAfterStop: FleetAggregatorEvent[] = [];
    aggregator.start();

    expect(local.subscribers.size).toBe(1);
    expect(hosts.listenerCount()).toBe(1);
    expect(mac.subscriberCount()).toBe(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // Start an in-flight forced sync so a timeout timer is also active.
    const inFlightCollect = aggregator.collectFleet({ forceRefresh: true });
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);

    aggregator.subscribe((event) => {
      eventsAfterStop.push(event);
    });

    aggregator.stop();
    await inFlightCollect;

    expect(local.subscribers.size).toBe(0);
    expect(hosts.listenerCount()).toBe(0);
    expect(mac.subscriberCount()).toBe(0);
    expect(mac.observeReleaseCount()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);

    // Advancing timers and firing stale sources produces zero further polls or events.
    const fetchesBeforeAdvance = mac.fetchAgentsMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    hosts.notifyChanged();
    local.emitEvent({
      type: "agent_state",
      agent: createManagedAgentStub({ id: "post_stop" }),
    });
    mac.emitDaemonEvent({
      type: "agent_permission_request",
      agentId: "mac_1",
      request: createPermission({ id: "perm_post_stop" }),
    });

    expect(mac.fetchAgentsMock.mock.calls.length).toBe(fetchesBeforeAdvance);
    expect(eventsAfterStop).toEqual([]);
  });

  it("supports default AgentRunController local prompt dispatch and fetchTimeline tail reading", async () => {
    const local = createFakeLocalEnv();
    const streamed: Array<{ agentId: string; prompt: AgentPromptInput }> = [];
    local.liveAgents.set(
      "local_ctrl",
      createManagedAgentStub({ id: "local_ctrl", title: "Controller Target" }),
    );

    const enhancedManager: FleetLocalAgentManager = {
      ...local.agentManager,
      tryRunOutOfBand: async () => false,
      hasInFlightRun: () => false,
      reloadStalePluginSession: async () => false,
      replaceAgentRun: async () => {
        throw new Error("unexpected replace");
      },
      steerOrReplaceActiveTurn: async () => ({ status: "inactive" }),
      reloadAgentSession: async () => undefined,
      streamAgent: async function* (agentId, prompt) {
        streamed.push({ agentId, prompt });
        yield { type: "turn_started", provider: "claude" };
        yield { type: "turn_completed", provider: "claude" };
      },
      fetchTimeline: (_id, _options) => ({
        epoch: "ep_1",
        direction: "tail",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 1, maxSeq: 2, nextSeq: 3 },
        hasOlder: false,
        hasNewer: false,
        startSeq: 1,
        endSeq: 2,
        rows: [
          {
            provider: "claude",
            item: { type: "user_message", text: "Run check" },
            timestamp: "2026-11-23T11:00:00.000Z",
            seqStart: 1,
            seqEnd: 1,
            sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
            collapsed: [],
          },
          {
            provider: "claude",
            item: { type: "error", message: "Lint failed" },
            timestamp: "2026-11-23T11:00:05.000Z",
            seqStart: 2,
            seqEnd: 2,
            sourceSeqRanges: [{ startSeq: 2, endSeq: 2 }],
            collapsed: [],
          },
        ],
      }),
    };

    const aggregator = createMainChatFleetAggregator({
      localServerId: "srv_local",
      localLabel: "DevBox",
      agentManager: enhancedManager,
      agentStorage: local.agentStorage,
    });

    await aggregator.sendPromptToHostAgent("srv_local", "local_ctrl", "Verify default run path");
    expect(streamed).toEqual([{ agentId: "local_ctrl", prompt: "Verify default run path" }]);

    const tail = await aggregator.readHostAgentTail("srv_local", "local_ctrl", { limit: 5 });
    expect(tail).toEqual([
      {
        role: "user",
        text: "Run check",
        timestamp: "2026-11-23T11:00:00.000Z",
        seq: 1,
      },
      {
        role: "error",
        text: "Lint failed",
        timestamp: "2026-11-23T11:00:05.000Z",
        seq: 2,
      },
    ]);

    aggregator.stop();
  });

  it("extracts expectedServerId for connecting hosts, deduplicates duplicate target registrations, and honors allowlist by expectedServerId", async () => {
    const local = createFakeLocalEnv();
    const devboxClient = createFakeRemoteClient({ initialAgents: [] });
    const hosts = new FakeConnectedHosts();
    hosts.setState(
      [
        // Connecting host registered via relay URI (serverId still null before handshake)
        createKnownHostSummary({
          registrationId: "hst_imac_connecting",
          serverId: null,
          label: "iMac",
          status: "connecting",
          targetDescription: "relay://relay.paseo.sh:443/srv_imac",
          metadata: { mainChatSyncServerId: "srv_imac" },
          source: { id: "client", key: "main-chat-sync:srv_imac" },
        }),
        // Duplicate stale connecting registration pointing at the same target host
        createKnownHostSummary({
          registrationId: "hst_imac_dup_error",
          serverId: null,
          label: "iMac",
          status: "error",
          targetDescription: "relay://relay.paseo.sh:443/srv_imac",
          error: { code: "duplicate_host", message: "Duplicate host" },
        }),
        // Online pinned host + stale duplicate error registration for DevBox
        createKnownHostSummary({
          registrationId: "hst_devbox_online",
          serverId: "srv_devbox",
          label: "DevBox",
          status: "online",
          targetDescription: "relay://relay.paseo.sh:443/srv_devbox",
        }),
        createKnownHostSummary({
          registrationId: "hst_devbox_dup",
          serverId: null,
          label: "DevBox",
          status: "connecting",
          targetDescription: "relay://relay.paseo.sh:443/srv_devbox",
        }),
        // Out-of-scope connecting host
        createKnownHostSummary({
          registrationId: "hst_other_connecting",
          serverId: null,
          label: "OtherMac",
          status: "connecting",
          targetDescription: "relay://relay.paseo.sh:443/srv_other",
        }),
      ],
      [
        {
          registrationId: "hst_devbox_online",
          serverId: "srv_devbox",
          label: "DevBox",
          client: devboxClient.client,
          lastOnlineAt: "2026-11-24T10:00:00.000Z",
        },
      ],
    );

    const allowed = new Set(["srv_devbox", "srv_imac"]);
    const aggregator = createMainChatFleetAggregator({
      localServerId: "srv_local",
      localLabel: "ML9YK34K66",
      agentManager: local.agentManager,
      agentStorage: local.agentStorage,
      connectedHosts: hosts,
      isHostAllowed: (serverId) => allowed.has(serverId),
    });

    const snap = await aggregator.collectFleet();
    // 1 local + 1 deduped DevBox (online wins over duplicate connecting) + 1 deduped iMac (connecting wins over error)
    expect(snap.hosts).toHaveLength(3);
    const devboxHost = snap.hosts.find((h) => h.expectedServerId === "srv_devbox");
    const imacHost = snap.hosts.find((h) => h.expectedServerId === "srv_imac");
    expect(devboxHost).toMatchObject({
      serverId: "srv_devbox",
      status: "online",
      registrationId: "hst_devbox_online",
      expectedServerId: "srv_devbox",
    });
    expect(imacHost).toMatchObject({
      serverId: "hst_imac_connecting",
      status: "connecting",
      registrationId: "hst_imac_connecting",
      expectedServerId: "srv_imac",
      targetDescription: "relay://relay.paseo.sh:443/srv_imac",
    });
    expect(snap.hosts.some((h) => h.expectedServerId === "srv_other")).toBe(false);

    aggregator.stop();
  });
});
