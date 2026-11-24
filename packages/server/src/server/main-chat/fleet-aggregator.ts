import path from "node:path";
import type {
  CreateAgentRequestOptions,
  CreateWorkspaceRequestOptions,
  DaemonEvent,
  DaemonEventHandler,
  FetchAgentsOptions,
  FetchAgentTimelineOptions,
  SendMessageOptions,
} from "@getpaseo/client/internal/daemon-client";
import type { OwnedSubscription } from "@getpaseo/client";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentProvider,
  AgentSessionConfig,
  AgentTimelineItem,
} from "@getpaseo/protocol/agent-types";
import type {
  ActiveTurnBehavior,
  AgentSnapshotPayload,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";
import pino, { type Logger } from "pino";
import {
  AgentManager,
  type AgentManagerEvent,
  type AgentSubscriber,
  type CreateAgentOptions,
  type ManagedAgent,
  type SubscribeOptions,
} from "../agent/agent-manager.js";
import {
  sendPromptToAgent,
  startAgentRun,
  type AgentRunController,
} from "../agent/agent-prompt.js";
import { AgentStorage, type StoredAgentRecord } from "../agent/agent-storage.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../agent/agent-timeline-store-types.js";
import type { ConnectedHostSummary, ConnectedSelfHost } from "../connected-hosts/index.js";

const DEFAULT_REMOTE_TIMEOUT_MS = 4_000;
const DEFAULT_REMOTE_POLL_INTERVAL_MS = 30_000;
const DEFAULT_TAIL_LIMIT = 20;

export type FleetHostErrorCode =
  | "host_unknown"
  | "host_offline"
  | "host_out_of_scope"
  | "dispatch_failed"
  | "timeout";

export class FleetHostError extends Error {
  readonly code: FleetHostErrorCode;
  readonly serverId: string;
  readonly operation?: string;

  constructor(
    code: FleetHostErrorCode,
    message: string,
    serverId: string,
    options?: { cause?: unknown; operation?: string },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "FleetHostError";
    this.code = code;
    this.serverId = serverId;
    this.operation = options?.operation;
  }
}

export type AggregatedHostStatus = "online" | "connecting" | "offline" | "error" | "degraded";

export interface AggregatedHostPendingPermission {
  requestId: string;
  name: string;
  title: string | null;
  description: string | null;
  kind?: AgentPermissionRequest["kind"];
}

export interface AggregatedHostSummary {
  serverId: string;
  label: string;
  isLocal: boolean;
  status: AggregatedHostStatus;
  agentCount: number;
  needsAttentionCount: number;
  lastSyncedAt: string | null;
  error: string | null;
  registrationId?: string;
  expectedServerId?: string;
  targetDescription?: string;
}

export interface AggregatedHostAgent {
  serverId: string;
  hostLabel: string;
  isLocal: boolean;
  agentId: string;
  workspaceId: string | null;
  title: string;
  cwd: string;
  lifecycle: string;
  requiresAttention: boolean;
  attentionReason: string | null;
  pendingPermissions: AggregatedHostPendingPermission[];
  labels: Record<string, string>;
  lastError: string | null;
  updatedAtIso: string;
  stale: boolean;
}

export interface AggregatedFleetSnapshot {
  collectedAt: string;
  localServerId: string;
  hosts: AggregatedHostSummary[];
  agents: AggregatedHostAgent[];
}

export interface CollectFleetOptions {
  forceRefresh?: boolean;
  excludeAgentIds?: ReadonlySet<string>;
}

export type FleetAgentsChangedReason =
  | "local_update"
  | "remote_sync"
  | "remote_update"
  | "remote_removed"
  | "host_status";

export type FleetAggregatorEvent =
  | {
      type: "hosts_changed";
      hosts: AggregatedHostSummary[];
    }
  | {
      type: "agents_changed";
      serverId: string;
      agentIds?: string[];
      reason: FleetAgentsChangedReason;
    }
  | {
      type: "permission_requested";
      serverId: string;
      hostLabel: string;
      isLocal: boolean;
      agentId: string;
      permission: AggregatedHostPendingPermission;
    }
  | {
      type: "permission_resolved";
      serverId: string;
      agentId: string;
      requestId: string;
    };

export interface CrossHostDispatchInput {
  serverId: string;
  cwd: string;
  title: string;
  provider: AgentProvider;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  initialPrompt?: string;
  labels?: Record<string, string>;
  workspaceId?: string;
  isolation?: "local" | "worktree";
  baseBranch?: string;
  branchName?: string;
  worktreeSlug?: string;
  idempotencyKey?: string;
  background?: boolean;
  timeoutMs?: number;
}

export interface CrossHostDispatchResult {
  serverId: string;
  hostLabel: string;
  isLocal: boolean;
  agentId: string;
  workspaceId: string | null;
  cwd: string;
  title: string;
  provider: AgentProvider;
  lifecycle: string;
}

export interface CrossHostPromptImage {
  data: string;
  mimeType: string;
}

export interface SendHostPromptOptions {
  images?: CrossHostPromptImage[];
  activeTurnBehavior?: ActiveTurnBehavior;
  sessionMode?: string;
  messageId?: string;
  timeoutMs?: number;
}

export type CrossHostAgentTailRole =
  | "user"
  | "assistant"
  | "tool"
  | "error"
  | "notification"
  | "reasoning";

export interface CrossHostAgentTailMessage {
  role: CrossHostAgentTailRole;
  text: string;
  timestamp: string | null;
  toolName?: string;
  toolStatus?: string;
  seq?: number;
}

export interface ReadHostAgentTailOptions {
  limit?: number;
  timeoutMs?: number;
}

export type CrossHostAgentControlAction = "cancel" | "archive";

export interface FleetLocalAgentManager {
  listAgents(options?: { includeInternal?: boolean }): ManagedAgent[];
  getAgent(id: string): ManagedAgent | null;
  subscribe(callback: AgentSubscriber, options?: SubscribeOptions): () => void;
  createAgent(
    config: AgentSessionConfig,
    agentId: string | undefined,
    options: CreateAgentOptions,
  ): Promise<ManagedAgent>;
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<unknown>;
  cancelAgentRun(agentId: string): Promise<unknown>;
  archiveAgent(agentId: string, archivedAt?: string): Promise<{ archivedAt: string }>;
  getTimeline(id: string): AgentTimelineItem[];
  fetchTimeline?: (id: string, options?: AgentTimelineFetchOptions) => AgentTimelineFetchResult;
  getTimelineRows?: (id: string) => Promise<AgentTimelineRow[]>;
  tryRunOutOfBand?: AgentRunController["tryRunOutOfBand"];
  hasInFlightRun?: AgentRunController["hasInFlightRun"];
  reloadStalePluginSession?: AgentRunController["reloadStalePluginSession"];
  replaceAgentRun?: AgentRunController["replaceAgentRun"];
  steerOrReplaceActiveTurn?: AgentRunController["steerOrReplaceActiveTurn"];
  streamAgent?: AgentRunController["streamAgent"];
  reloadAgentSession?: AgentRunController["reloadAgentSession"];
}

export interface FleetLocalAgentStorage {
  listActive(): Promise<StoredAgentRecord[]>;
  get(agentId: string): Promise<StoredAgentRecord | null>;
}

export interface FleetRemoteAgentListResult {
  entries: ReadonlyArray<{ agent: AgentSnapshotPayload }>;
}

export interface FleetRemoteTimelineEntry {
  item: AgentTimelineItem;
  timestamp?: string;
  seqEnd?: number;
}

export interface FleetRemoteTimelineResult {
  entries: ReadonlyArray<FleetRemoteTimelineEntry>;
}

export interface FleetRemoteWorkspaceCreateResult {
  workspace: { id: string; workspaceDirectory: string } | null;
  error: string | null;
}

export interface FleetRemoteDaemonClient {
  readonly isConnected: boolean;
  fetchAgents(options?: FetchAgentsOptions): Promise<FleetRemoteAgentListResult>;
  observeAgents?: (
    options?: Omit<FetchAgentsOptions, "subscribe">,
  ) => OwnedSubscription<FleetRemoteAgentListResult>;
  subscribe(handler: DaemonEventHandler): () => void;
  createAgent(options: CreateAgentRequestOptions): Promise<AgentSnapshotPayload>;
  createWorkspace?: (
    input: CreateWorkspaceRequestOptions,
    requestId?: string,
  ) => Promise<FleetRemoteWorkspaceCreateResult>;
  sendAgentMessage(
    agentId: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<{ deliveryStatus?: "queued" }>;
  respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void>;
  fetchAgentTimeline(
    agentId: string,
    options?: FetchAgentTimelineOptions,
  ): Promise<FleetRemoteTimelineResult>;
  cancelAgent(agentId: string): Promise<void>;
  archiveAgent(agentId: string): Promise<{ archivedAt: string }>;
}

export interface FleetAcceptedHostHandle {
  registrationId: string;
  serverId: string;
  label: string;
  client: FleetRemoteDaemonClient;
  lastOnlineAt: string | null;
}

export interface FleetConnectedHosts {
  getSelfHost(): ConnectedSelfHost;
  listAcceptedHosts(): FleetAcceptedHostHandle[];
  getAcceptedClient(serverId: string): FleetRemoteDaemonClient | null;
  listKnownHosts(): ConnectedHostSummary[];
  subscribeHostChanges(listener: () => void): () => void;
}

export interface MainChatFleetAggregatorOptions {
  localServerId: string;
  localLabel: string;
  agentManager: FleetLocalAgentManager;
  agentStorage: FleetLocalAgentStorage;
  connectedHosts?: FleetConnectedHosts;
  /** Optional steward host-scope predicate; when provided, remote hosts returning false are excluded. */
  isHostAllowed?: (serverId: string) => boolean;
  remotePollIntervalMs?: number;
  remoteTimeoutMs?: number;
  logger?: Logger;
  sendLocalPrompt?: (input: {
    agentId: string;
    prompt: AgentPromptInput;
    options?: SendHostPromptOptions;
  }) => Promise<void>;
}

interface RemoteHostState {
  serverId: string;
  registrationId: string;
  label: string;
  agents: Map<string, AggregatedHostAgent>;
  hasSynced: boolean;
  lastSyncedAt: string | null;
  lastSyncedAtMs: number | null;
  lastSyncError: string | null;
  inFlightSync: Promise<void> | null;
  generation: number;
  attachedClient: FleetRemoteDaemonClient | null;
  cleanupAttachment: (() => void) | null;
}

interface NormalizedKnownHost {
  key: string;
  serverId: string;
  registrationId: string;
  expectedServerId: string | null;
  targetDescription: string | null;
  label: string;
  summary: ConnectedHostSummary | null;
  acceptedHandle: FleetAcceptedHostHandle | null;
}

const MAIN_CHAT_SYNC_SOURCE_KEY_PREFIX = "main-chat-sync:";

function extractRelayTargetServerId(targetDesc: string | undefined): string | null {
  const trimmed = targetDesc?.trim();
  if (!trimmed || !trimmed.startsWith("relay://")) return null;
  const rest = trimmed.slice("relay://".length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex < 0) return null;
  const rawId = rest.slice(slashIndex + 1).trim();
  if (!rawId) return null;
  try {
    return decodeURIComponent(rawId).trim() || rawId;
  } catch {
    return rawId;
  }
}

export function extractExpectedServerIdFromHostSummary(
  summary: ConnectedHostSummary | null,
): string | null {
  if (!summary) return null;
  const pinned = summary.serverId?.trim();
  if (pinned) return pinned;

  const metaServerId = summary.metadata?.mainChatSyncServerId?.trim();
  if (metaServerId) return metaServerId;

  const sourceKey = summary.source?.key?.trim();
  if (sourceKey && sourceKey.startsWith(MAIN_CHAT_SYNC_SOURCE_KEY_PREFIX)) {
    const extracted = sourceKey.slice(MAIN_CHAT_SYNC_SOURCE_KEY_PREFIX.length).trim();
    if (extracted) return extracted;
  }

  return extractRelayTargetServerId(summary.targetDescription);
}

function buildNormalizedHostDedupKey(entry: NormalizedKnownHost): string {
  if (entry.expectedServerId) return `srv:${entry.expectedServerId}`;
  if (entry.targetDescription) return `target:${entry.targetDescription}`;
  return `reg:${entry.serverId}`;
}

function deduplicateNormalizedHosts(candidates: NormalizedKnownHost[]): NormalizedKnownHost[] {
  const dedupedByTarget = new Map<string, NormalizedKnownHost>();
  for (const entry of candidates) {
    const dedupKey = buildNormalizedHostDedupKey(entry);
    const existing = dedupedByTarget.get(dedupKey);
    if (!existing || normalizedHostPriority(entry) > normalizedHostPriority(existing)) {
      dedupedByTarget.set(dedupKey, entry);
    }
  }
  return Array.from(dedupedByTarget.values());
}

function normalizedHostPriority(entry: NormalizedKnownHost): number {
  if (entry.acceptedHandle) return 5;
  if (entry.summary?.serverId) return 4;
  switch (entry.summary?.status) {
    case "connecting":
      return 3;
    case "offline":
      return 2;
    case "error":
      return 1;
    case "disabled":
      return 0;
    default:
      return 2;
  }
}

function basenameOf(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return path.basename(trimmed) || trimmed;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function isConnectionLostError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "DaemonConnectionError") return true;
  if ("code" in error) {
    const code = error.code;
    if (code === "DAEMON_CONNECTION_LOST" || code === "host_offline" || code === "host_disabled") {
      return true;
    }
  }
  return false;
}

function mapPermissionRequest(request: AgentPermissionRequest): AggregatedHostPendingPermission {
  return {
    requestId: request.id,
    name: request.name,
    title: request.title?.trim() || null,
    description: request.description?.trim() || null,
    kind: request.kind,
  };
}

function permissionKey(serverId: string, agentId: string, requestId: string): string {
  return `${serverId}\u0000${agentId}\u0000${requestId}`;
}

function agentNeedsAttention(agent: AggregatedHostAgent): boolean {
  return agent.requiresAttention || agent.pendingPermissions.length > 0;
}

function toLocalLiveAgent(
  agent: ManagedAgent,
  serverId: string,
  hostLabel: string,
): AggregatedHostAgent {
  const pendingPermissions = Array.from(agent.pendingPermissions.values()).map(
    mapPermissionRequest,
  );
  const title = agent.config.title?.trim() || basenameOf(agent.cwd);
  const attentionReason = agent.attention.requiresAttention
    ? agent.attention.attentionReason
    : null;

  return {
    serverId,
    hostLabel,
    isLocal: true,
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? null,
    title,
    cwd: agent.cwd,
    lifecycle: agent.lifecycle,
    requiresAttention: agent.attention.requiresAttention || pendingPermissions.length > 0,
    attentionReason,
    pendingPermissions,
    labels: { ...agent.labels },
    lastError: agent.lastError ?? null,
    updatedAtIso: agent.updatedAt.toISOString(),
    stale: false,
  };
}

function toLocalStoredAgent(
  record: StoredAgentRecord,
  serverId: string,
  hostLabel: string,
): AggregatedHostAgent {
  const title = record.title?.trim() || basenameOf(record.cwd);
  return {
    serverId,
    hostLabel,
    isLocal: true,
    agentId: record.id,
    workspaceId: record.workspaceId ?? null,
    title,
    cwd: record.cwd,
    lifecycle: record.lastStatus ?? "closed",
    requiresAttention: record.requiresAttention === true,
    attentionReason: record.attentionReason ?? null,
    pendingPermissions: [],
    labels: { ...record.labels },
    lastError: record.lastError ?? null,
    updatedAtIso: record.updatedAt,
    stale: false,
  };
}

function toRemoteAgent(
  snapshot: AgentSnapshotPayload,
  serverId: string,
  hostLabel: string,
  stale: boolean,
): AggregatedHostAgent {
  const pendingPermissions = snapshot.pendingPermissions.map(mapPermissionRequest);
  const title = snapshot.title?.trim() || basenameOf(snapshot.cwd);
  return {
    serverId,
    hostLabel,
    isLocal: false,
    agentId: snapshot.id,
    workspaceId: snapshot.workspaceId ?? null,
    title,
    cwd: snapshot.cwd,
    lifecycle: snapshot.status,
    requiresAttention: snapshot.requiresAttention === true || pendingPermissions.length > 0,
    attentionReason: snapshot.attentionReason ?? null,
    pendingPermissions,
    labels: { ...snapshot.labels },
    lastError: snapshot.lastError ?? null,
    updatedAtIso: snapshot.updatedAt,
    stale,
  };
}

function cloneAgentWithStale(
  agent: AggregatedHostAgent,
  hostLabel: string,
  stale: boolean,
): AggregatedHostAgent {
  return {
    ...agent,
    hostLabel,
    pendingPermissions: agent.pendingPermissions.map((permission) => ({ ...permission })),
    labels: { ...agent.labels },
    stale,
  };
}

function isFilteredRemoteSnapshot(snapshot: AgentSnapshotPayload): boolean {
  return Boolean(snapshot.archivedAt) || snapshot.internal === true;
}

function summarizeToolCallItem(item: Extract<AgentTimelineItem, { type: "tool_call" }>): string {
  const detail = item.detail;
  switch (detail.type) {
    case "shell":
      return `${item.name}: ${detail.command}`;
    case "read":
    case "edit":
    case "write":
      return `${item.name}: ${detail.filePath}`;
    case "search":
      return `${item.name}: ${detail.query}`;
    case "fetch":
      return `${item.name}: ${detail.url}`;
    case "worktree_setup":
      return `${item.name}: ${detail.branchName} (${detail.worktreePath})`;
    case "sub_agent":
      return detail.description ? `${item.name}: ${detail.description}` : item.name;
    case "plain_text":
      return detail.text ? `${item.name}: ${detail.text}` : item.name;
    case "plan":
      return `${item.name}: ${detail.text}`;
    case "unknown":
      return item.name;
  }
}

function projectTimelineItemToTailMessage(
  item: AgentTimelineItem,
  timestamp: string | null,
  seq?: number,
): CrossHostAgentTailMessage | null {
  switch (item.type) {
    case "user_message":
      return { role: "user", text: item.text, timestamp, ...(seq !== undefined ? { seq } : {}) };
    case "assistant_message":
      return {
        role: "assistant",
        text: item.text,
        timestamp,
        ...(seq !== undefined ? { seq } : {}),
      };
    case "reasoning":
      return {
        role: "reasoning",
        text: item.text,
        timestamp,
        ...(seq !== undefined ? { seq } : {}),
      };
    case "tool_call":
      return {
        role: "tool",
        text: summarizeToolCallItem(item),
        timestamp,
        toolName: item.name,
        toolStatus: item.status,
        ...(seq !== undefined ? { seq } : {}),
      };
    case "error":
      return {
        role: "error",
        text: item.message,
        timestamp,
        ...(seq !== undefined ? { seq } : {}),
      };
    case "notification":
      return {
        role: "notification",
        text: item.message,
        timestamp,
        ...(seq !== undefined ? { seq } : {}),
      };
    case "todo":
    case "compaction":
    case "plugin":
      return null;
  }
}

function buildDispatchSessionConfig(
  input: CrossHostDispatchInput,
  cwd: string,
): AgentSessionConfig {
  return {
    provider: input.provider,
    cwd,
    title: input.title,
    ...(input.model ? { model: input.model } : {}),
    ...(input.modeId ? { modeId: input.modeId } : {}),
    ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
  };
}

function buildLocalPromptInput(prompt: string, images?: CrossHostPromptImage[]): AgentPromptInput {
  if (!images || images.length === 0) {
    return prompt;
  }
  const blocks: AgentPromptContentBlock[] = [
    { type: "text", text: prompt },
    ...images.map((image) => ({
      type: "image" as const,
      data: image.data,
      mimeType: image.mimeType,
    })),
  ];
  return blocks;
}

function isRunController(
  manager: FleetLocalAgentManager,
): manager is FleetLocalAgentManager & AgentRunController {
  return (
    typeof manager.tryRunOutOfBand === "function" &&
    typeof manager.hasInFlightRun === "function" &&
    typeof manager.reloadStalePluginSession === "function" &&
    typeof manager.replaceAgentRun === "function" &&
    typeof manager.steerOrReplaceActiveTurn === "function" &&
    typeof manager.streamAgent === "function" &&
    typeof manager.reloadAgentSession === "function"
  );
}

/**
 * Aggregates live and persisted agent state across the local daemon and all connected remote
 * hosts, while providing timeout-bounded cross-host dispatch and control operations.
 *
 * Remote cache policy:
 * - Online healthy hosts serve fresh snapshots (`stale: false`), updated by real-time
 *   `observeAgents` / `DaemonClient` events and periodic fallback polling.
 * - Online hosts whose latest sync fails or times out keep their last good cache marked
 *   `stale: true` and report host status `"degraded"` (or `"error"` if never synced).
 * - Disconnected / reconnecting / errored hosts retain their last good cache marked `stale: true`
 *   so main-chat does not lose track of in-flight remote work across transient drops.
 * - Disabled or removed hosts have their cached entries cleared immediately.
 */
export class MainChatFleetAggregator {
  private readonly localServerId: string;
  private readonly localLabel: string;
  private readonly agentManager: FleetLocalAgentManager;
  private readonly agentStorage: FleetLocalAgentStorage;
  private readonly connectedHosts?: FleetConnectedHosts;
  private readonly isHostAllowed?: (serverId: string) => boolean;
  private readonly remotePollIntervalMs: number;
  private readonly remoteTimeoutMs: number;
  private readonly logger: Logger;
  private readonly sendLocalPromptOverride?: MainChatFleetAggregatorOptions["sendLocalPrompt"];

  private readonly remoteStates = new Map<string, RemoteHostState>();
  private readonly listeners = new Set<(event: FleetAggregatorEvent) => void>();
  private readonly emittedPermissionKeys = new Set<string>();
  private readonly activeTimeoutCleanups = new Set<() => void>();

  private started = false;
  private unsubscribeLocal: (() => void) | null = null;
  private unsubscribeHosts: (() => void) | null = null;

  constructor(options: MainChatFleetAggregatorOptions) {
    this.localServerId = options.localServerId;
    this.localLabel = options.localLabel;
    this.agentManager = options.agentManager;
    this.agentStorage = options.agentStorage;
    this.connectedHosts = options.connectedHosts;
    this.isHostAllowed = options.isHostAllowed;
    this.remotePollIntervalMs = options.remotePollIntervalMs ?? DEFAULT_REMOTE_POLL_INTERVAL_MS;
    this.remoteTimeoutMs = options.remoteTimeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
    this.logger = options.logger ?? pino({ level: "silent" });
    this.sendLocalPromptOverride = options.sendLocalPrompt;
  }

  reconcileScope(): void {
    this.reconcileHosts(true);
  }

  listAvailableRemoteHosts(): AggregatedHostSummary[] {
    const normalized = this.normalizeConnectedHosts({ ignoreScope: true });
    const summaries: AggregatedHostSummary[] = [];
    for (const entry of normalized) {
      const state = this.remoteStates.get(entry.serverId);
      const { status, error } = this.resolveRemoteHostStatus(entry, state);
      const cachedAgents =
        state && entry.summary?.status !== "disabled" ? Array.from(state.agents.values()) : [];
      const item: AggregatedHostSummary = {
        serverId: entry.serverId,
        label: entry.label,
        isLocal: false,
        status,
        agentCount: cachedAgents.length,
        needsAttentionCount: cachedAgents.filter(agentNeedsAttention).length,
        lastSyncedAt: state?.lastSyncedAt ?? entry.summary?.lastOnlineAt ?? null,
        error,
        registrationId: entry.registrationId,
      };
      if (entry.expectedServerId) item.expectedServerId = entry.expectedServerId;
      if (entry.targetDescription) item.targetDescription = entry.targetDescription;
      summaries.push(item);
    }
    return summaries;
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubscribeLocal = this.agentManager.subscribe((event) => {
      this.handleLocalManagerEvent(event);
    });

    if (this.connectedHosts) {
      this.unsubscribeHosts = this.connectedHosts.subscribeHostChanges(() => {
        this.reconcileHosts(true);
      });
    }

    this.reconcileHosts(false);
  }

  stop(): void {
    this.started = false;

    this.unsubscribeLocal?.();
    this.unsubscribeLocal = null;

    this.unsubscribeHosts?.();
    this.unsubscribeHosts = null;

    for (const state of this.remoteStates.values()) {
      this.detachRemoteHost(state);
    }

    for (const cleanup of Array.from(this.activeTimeoutCleanups)) {
      cleanup();
    }
    this.activeTimeoutCleanups.clear();
    this.emittedPermissionKeys.clear();
  }

  subscribe(listener: (event: FleetAggregatorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async collectFleet(options?: CollectFleetOptions): Promise<AggregatedFleetSnapshot> {
    const excludeAgentIds = options?.excludeAgentIds;
    const forceRefresh = options?.forceRefresh === true;

    const normalizedHosts = this.reconcileHosts(false);
    const nowMs = Date.now();

    const syncTasks: Promise<void>[] = [];
    for (const entry of normalizedHosts) {
      if (!entry.acceptedHandle) continue;
      const state = this.getOrCreateRemoteState(entry.serverId, entry.registrationId, entry.label);
      if (this.shouldSyncRemoteHost(state, forceRefresh, nowMs)) {
        syncTasks.push(this.syncRemoteHost(entry.acceptedHandle, state));
      }
    }

    const [localAgents] = await Promise.all([
      this.collectLocalAgents(excludeAgentIds),
      Promise.all(syncTasks),
    ]);

    const collectedAt = new Date().toISOString();
    const agents: AggregatedHostAgent[] = [...localAgents];
    const hosts: AggregatedHostSummary[] = [
      {
        serverId: this.localServerId,
        label: this.localLabel,
        isLocal: true,
        status: "online",
        agentCount: localAgents.length,
        needsAttentionCount: localAgents.filter(agentNeedsAttention).length,
        lastSyncedAt: collectedAt,
        error: null,
      },
    ];

    const sortedRemotes = [...normalizedHosts].sort((left, right) => {
      const labelCompare = left.label.localeCompare(right.label);
      if (labelCompare !== 0) return labelCompare;
      return left.serverId.localeCompare(right.serverId);
    });

    for (const entry of sortedRemotes) {
      const state = this.remoteStates.get(entry.serverId);
      const { status, error, stale } = this.resolveRemoteHostStatus(entry, state);
      const remoteAgents: AggregatedHostAgent[] = [];

      if (state && entry.summary?.status !== "disabled") {
        for (const cached of state.agents.values()) {
          if (excludeAgentIds?.has(cached.agentId)) continue;
          remoteAgents.push(cloneAgentWithStale(cached, entry.label, stale));
        }
      }

      agents.push(...remoteAgents);
      hosts.push({
        serverId: entry.serverId,
        label: entry.label,
        isLocal: false,
        status,
        agentCount: remoteAgents.length,
        needsAttentionCount: remoteAgents.filter(agentNeedsAttention).length,
        lastSyncedAt: state?.lastSyncedAt ?? entry.summary?.lastOnlineAt ?? null,
        error,
        registrationId: entry.registrationId,
        ...(entry.expectedServerId ? { expectedServerId: entry.expectedServerId } : {}),
        ...(entry.targetDescription ? { targetDescription: entry.targetDescription } : {}),
      });
    }

    agents.sort((left, right) => {
      const updatedCompare = right.updatedAtIso.localeCompare(left.updatedAtIso);
      if (updatedCompare !== 0) return updatedCompare;
      const hostCompare = left.serverId.localeCompare(right.serverId);
      if (hostCompare !== 0) return hostCompare;
      return left.agentId.localeCompare(right.agentId);
    });

    return {
      collectedAt,
      localServerId: this.localServerId,
      hosts,
      agents,
    };
  }

  async dispatchAgentOnHost(input: CrossHostDispatchInput): Promise<CrossHostDispatchResult> {
    const timeoutMs = input.timeoutMs ?? this.remoteTimeoutMs;
    const target = this.resolveTargetHost(input.serverId, "dispatchAgentOnHost");

    if (target.kind === "local") {
      return this.dispatchLocalAgent(input, timeoutMs);
    }

    return this.dispatchRemoteAgent(input, target.client, target.label, timeoutMs);
  }

  private async dispatchLocalAgent(
    input: CrossHostDispatchInput,
    timeoutMs: number,
  ): Promise<CrossHostDispatchResult> {
    try {
      const config = buildDispatchSessionConfig(input, input.cwd);
      const created = await this.runWithTimeout(
        this.agentManager.createAgent(config, undefined, {
          workspaceId: input.workspaceId,
          labels: input.labels,
          initialTitle: input.title,
          initialPrompt: input.initialPrompt,
          background: input.background,
        }),
        timeoutMs,
        this.localServerId,
        "dispatchAgentOnHost",
      );

      if (input.initialPrompt && input.initialPrompt.trim().length > 0) {
        await this.dispatchLocalPrompt(created.id, input.initialPrompt, { timeoutMs });
      }

      return {
        serverId: this.localServerId,
        hostLabel: this.localLabel,
        isLocal: true,
        agentId: created.id,
        workspaceId: created.workspaceId ?? input.workspaceId ?? null,
        cwd: created.cwd,
        title: created.config.title?.trim() || input.title,
        provider: created.provider,
        lifecycle: created.lifecycle,
      };
    } catch (error) {
      throw this.wrapHostError(error, this.localServerId, "dispatchAgentOnHost");
    }
  }

  private async resolveRemoteDispatchWorkspace(
    input: CrossHostDispatchInput,
    client: FleetRemoteDaemonClient,
    timeoutMs: number,
  ): Promise<{ workspaceId?: string; cwd: string }> {
    if (input.workspaceId || !input.isolation || !client.createWorkspace) {
      return { workspaceId: input.workspaceId, cwd: input.cwd };
    }

    const source: CreateWorkspaceRequestOptions["source"] =
      input.isolation === "worktree"
        ? {
            kind: "worktree",
            cwd: input.cwd,
            action: "branch-off",
            ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
            ...(input.branchName ? { branchName: input.branchName } : {}),
            ...(input.worktreeSlug ? { worktreeSlug: input.worktreeSlug } : {}),
          }
        : { kind: "directory", path: input.cwd };

    const workspaceResult = await this.runWithTimeout(
      client.createWorkspace({
        source,
        title: input.title,
        ...(input.background !== undefined ? { background: input.background } : {}),
      }),
      timeoutMs,
      input.serverId,
      "dispatchAgentOnHost",
    );
    if (workspaceResult.error || !workspaceResult.workspace) {
      throw new FleetHostError(
        "dispatch_failed",
        workspaceResult.error ?? `Failed to create workspace on host ${input.serverId}`,
        input.serverId,
        { operation: "dispatchAgentOnHost" },
      );
    }

    return {
      workspaceId: workspaceResult.workspace.id,
      cwd: workspaceResult.workspace.workspaceDirectory,
    };
  }

  private async dispatchRemoteAgent(
    input: CrossHostDispatchInput,
    client: FleetRemoteDaemonClient,
    label: string,
    timeoutMs: number,
  ): Promise<CrossHostDispatchResult> {
    try {
      const { workspaceId, cwd: resolvedCwd } = await this.resolveRemoteDispatchWorkspace(
        input,
        client,
        timeoutMs,
      );

      const snapshot = await this.runWithTimeout(
        client.createAgent({
          config: buildDispatchSessionConfig(input, resolvedCwd),
          ...(workspaceId ? { workspaceId } : {}),
          ...(input.initialPrompt ? { initialPrompt: input.initialPrompt } : {}),
          ...(input.labels ? { labels: input.labels } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(input.background !== undefined ? { background: input.background } : {}),
        }),
        timeoutMs,
        input.serverId,
        "dispatchAgentOnHost",
      );

      const state = this.remoteStates.get(input.serverId);
      if (state && !isFilteredRemoteSnapshot(snapshot)) {
        this.applyRemoteAgentUpsert(state, snapshot, "remote_update");
      }

      return {
        serverId: input.serverId,
        hostLabel: label,
        isLocal: false,
        agentId: snapshot.id,
        workspaceId: snapshot.workspaceId ?? workspaceId ?? null,
        cwd: snapshot.cwd,
        title: snapshot.title?.trim() || input.title,
        provider: snapshot.provider,
        lifecycle: snapshot.status,
      };
    } catch (error) {
      throw this.wrapHostError(error, input.serverId, "dispatchAgentOnHost", client);
    }
  }

  async sendPromptToHostAgent(
    serverId: string,
    agentId: string,
    prompt: string,
    options?: SendHostPromptOptions,
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? this.remoteTimeoutMs;
    const target = this.resolveTargetHost(serverId, "sendPromptToHostAgent");

    if (target.kind === "local") {
      try {
        await this.dispatchLocalPrompt(agentId, prompt, options);
      } catch (error) {
        throw this.wrapHostError(error, this.localServerId, "sendPromptToHostAgent");
      }
      return;
    }

    const { client } = target;
    try {
      await this.runWithTimeout(
        client.sendAgentMessage(agentId, prompt, {
          ...(options?.images && options.images.length > 0 ? { images: options.images } : {}),
          ...(options?.activeTurnBehavior
            ? { activeTurnBehavior: options.activeTurnBehavior }
            : {}),
          ...(options?.sessionMode ? { sessionMode: options.sessionMode } : {}),
          ...(options?.messageId ? { messageId: options.messageId } : {}),
        }),
        timeoutMs,
        serverId,
        "sendPromptToHostAgent",
      );
    } catch (error) {
      throw this.wrapHostError(error, serverId, "sendPromptToHostAgent", client);
    }
  }

  async respondPermissionOnHost(
    serverId: string,
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void> {
    const target = this.resolveTargetHost(serverId, "respondPermissionOnHost");

    if (target.kind === "local") {
      try {
        await this.runWithTimeout(
          this.agentManager.respondToPermission(agentId, requestId, response),
          this.remoteTimeoutMs,
          this.localServerId,
          "respondPermissionOnHost",
        );
        this.emittedPermissionKeys.delete(permissionKey(this.localServerId, agentId, requestId));
      } catch (error) {
        throw this.wrapHostError(error, this.localServerId, "respondPermissionOnHost");
      }
      return;
    }

    const { client } = target;
    try {
      await this.runWithTimeout(
        client.respondToPermission(agentId, requestId, response),
        this.remoteTimeoutMs,
        serverId,
        "respondPermissionOnHost",
      );
      const state = this.remoteStates.get(serverId);
      if (state) {
        this.applyRemotePermissionResolved(state, agentId, requestId, false);
      }
    } catch (error) {
      throw this.wrapHostError(error, serverId, "respondPermissionOnHost", client);
    }
  }

  async readHostAgentTail(
    serverId: string,
    agentId: string,
    options?: ReadHostAgentTailOptions,
  ): Promise<CrossHostAgentTailMessage[]> {
    const limit = options?.limit ?? DEFAULT_TAIL_LIMIT;
    if (limit <= 0) return [];
    const timeoutMs = options?.timeoutMs ?? this.remoteTimeoutMs;
    const target = this.resolveTargetHost(serverId, "readHostAgentTail");

    if (target.kind === "local") {
      try {
        return await this.runWithTimeout(
          this.readLocalAgentTail(agentId, limit),
          timeoutMs,
          this.localServerId,
          "readHostAgentTail",
        );
      } catch (error) {
        throw this.wrapHostError(error, this.localServerId, "readHostAgentTail");
      }
    }

    const { client } = target;
    try {
      // Request extra items so non-message timeline items (compaction/todo/plugin) do not starve the tail.
      const fetchLimit = Math.max(limit * 3, limit);
      const timeline = await this.runWithTimeout(
        client.fetchAgentTimeline(agentId, {
          direction: "tail",
          limit: fetchLimit,
          timeout: timeoutMs,
        }),
        timeoutMs,
        serverId,
        "readHostAgentTail",
      );
      const messages: CrossHostAgentTailMessage[] = [];
      for (const entry of timeline.entries) {
        const projected = projectTimelineItemToTailMessage(
          entry.item,
          entry.timestamp ?? null,
          entry.seqEnd,
        );
        if (projected) messages.push(projected);
      }
      return messages.slice(-limit);
    } catch (error) {
      throw this.wrapHostError(error, serverId, "readHostAgentTail", client);
    }
  }

  async controlHostAgent(
    serverId: string,
    agentId: string,
    action: CrossHostAgentControlAction,
  ): Promise<void> {
    const target = this.resolveTargetHost(serverId, "controlHostAgent");

    if (target.kind === "local") {
      try {
        if (action === "cancel") {
          await this.runWithTimeout(
            this.agentManager.cancelAgentRun(agentId),
            this.remoteTimeoutMs,
            this.localServerId,
            "controlHostAgent",
          );
        } else {
          await this.runWithTimeout(
            this.agentManager.archiveAgent(agentId),
            this.remoteTimeoutMs,
            this.localServerId,
            "controlHostAgent",
          );
          this.clearEmittedPermissionsForAgent(this.localServerId, agentId);
        }
      } catch (error) {
        throw this.wrapHostError(error, this.localServerId, "controlHostAgent");
      }
      return;
    }

    const { client } = target;
    try {
      if (action === "cancel") {
        await this.runWithTimeout(
          client.cancelAgent(agentId),
          this.remoteTimeoutMs,
          serverId,
          "controlHostAgent",
        );
      } else {
        await this.runWithTimeout(
          client.archiveAgent(agentId),
          this.remoteTimeoutMs,
          serverId,
          "controlHostAgent",
        );
        const state = this.remoteStates.get(serverId);
        if (state) {
          this.applyRemoteAgentRemoved(state, agentId);
        }
      }
    } catch (error) {
      throw this.wrapHostError(error, serverId, "controlHostAgent", client);
    }
  }

  private async dispatchLocalPrompt(
    agentId: string,
    prompt: string,
    options?: SendHostPromptOptions,
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? this.remoteTimeoutMs;
    const promptInput = buildLocalPromptInput(prompt, options?.images);

    if (this.sendLocalPromptOverride) {
      await this.runWithTimeout(
        this.sendLocalPromptOverride({ agentId, prompt: promptInput, options }),
        timeoutMs,
        this.localServerId,
        "sendPromptToHostAgent",
      );
      return;
    }

    if (this.agentManager instanceof AgentManager && this.agentStorage instanceof AgentStorage) {
      await this.runWithTimeout(
        sendPromptToAgent({
          agentManager: this.agentManager,
          agentStorage: this.agentStorage,
          agentId,
          prompt: promptInput,
          activeTurnBehavior: options?.activeTurnBehavior,
          sessionMode: options?.sessionMode,
          messageId: options?.messageId,
          logger: this.logger,
        }),
        timeoutMs,
        this.localServerId,
        "sendPromptToHostAgent",
      );
      return;
    }

    if (isRunController(this.agentManager)) {
      const existing =
        this.agentManager.getAgent(agentId) ?? (await this.agentStorage.get(agentId));
      if (!existing) {
        throw new FleetHostError(
          "dispatch_failed",
          `Local agent not found: ${agentId}`,
          this.localServerId,
          { operation: "sendPromptToHostAgent" },
        );
      }
      await this.runWithTimeout(
        startAgentRun(this.agentManager, agentId, promptInput, this.logger, {
          activeTurnBehavior: options?.activeTurnBehavior,
          replaceRunning: true,
        }),
        timeoutMs,
        this.localServerId,
        "sendPromptToHostAgent",
      );
      return;
    }

    throw new FleetHostError(
      "dispatch_failed",
      "Local agentManager does not support prompt dispatch",
      this.localServerId,
      { operation: "sendPromptToHostAgent" },
    );
  }

  private async readLocalAgentTail(
    agentId: string,
    limit: number,
  ): Promise<CrossHostAgentTailMessage[]> {
    const fetchLimit = Math.max(limit * 3, limit);
    if (this.agentManager.fetchTimeline) {
      const result = this.agentManager.fetchTimeline(agentId, {
        direction: "tail",
        limit: fetchLimit,
      });
      const messages: CrossHostAgentTailMessage[] = [];
      for (const row of result.rows) {
        const projected = projectTimelineItemToTailMessage(row.item, row.timestamp, row.seqEnd);
        if (projected) messages.push(projected);
      }
      return messages.slice(-limit);
    }

    if (this.agentManager.getTimelineRows) {
      const rows = await this.agentManager.getTimelineRows(agentId);
      const messages: CrossHostAgentTailMessage[] = [];
      for (const row of rows) {
        const projected = projectTimelineItemToTailMessage(row.item, row.timestamp, row.seq);
        if (projected) messages.push(projected);
      }
      return messages.slice(-limit);
    }

    const items = this.agentManager.getTimeline(agentId);
    const messages: CrossHostAgentTailMessage[] = [];
    for (const item of items) {
      const projected = projectTimelineItemToTailMessage(item, null);
      if (projected) messages.push(projected);
    }
    return messages.slice(-limit);
  }

  private async collectLocalAgents(
    excludeAgentIds?: ReadonlySet<string>,
  ): Promise<AggregatedHostAgent[]> {
    const byId = new Map<string, AggregatedHostAgent>();

    for (const agent of this.agentManager.listAgents()) {
      if (agent.internal === true) continue;
      if (excludeAgentIds?.has(agent.id)) continue;
      byId.set(agent.id, toLocalLiveAgent(agent, this.localServerId, this.localLabel));
    }

    const stored = await this.agentStorage.listActive();
    for (const record of stored) {
      if (record.archivedAt || record.internal === true) continue;
      if (excludeAgentIds?.has(record.id) || byId.has(record.id)) continue;
      byId.set(record.id, toLocalStoredAgent(record, this.localServerId, this.localLabel));
    }

    return Array.from(byId.values());
  }

  private shouldIncludeHost(serverId: string, ignoreScope: boolean): boolean {
    return ignoreScope || !this.isHostAllowed || this.isHostAllowed(serverId);
  }

  private normalizeKnownHostSummary(
    summary: ConnectedHostSummary,
    acceptedByServerId: ReadonlyMap<string, FleetAcceptedHostHandle>,
    ignoreScope: boolean,
  ): NormalizedKnownHost | null {
    const remoteServerId =
      summary.serverId !== null && summary.serverId !== this.localServerId
        ? summary.serverId
        : null;
    const expectedServerId = extractExpectedServerIdFromHostSummary(summary);
    if (expectedServerId === this.localServerId) return null;
    const serverId = remoteServerId ?? summary.registrationId;
    if (!this.shouldIncludeHost(expectedServerId ?? serverId, ignoreScope)) return null;
    const acceptedHandle = remoteServerId ? (acceptedByServerId.get(remoteServerId) ?? null) : null;
    const targetDescription = summary.targetDescription?.trim() || null;
    const label = acceptedHandle?.label || summary.label?.trim() || targetDescription || serverId;
    return {
      key: serverId,
      serverId,
      registrationId: summary.registrationId,
      expectedServerId,
      targetDescription,
      label,
      summary,
      acceptedHandle,
    };
  }

  private normalizeConnectedHosts(options?: { ignoreScope?: boolean }): NormalizedKnownHost[] {
    if (!this.connectedHosts) return [];
    const ignoreScope = Boolean(options?.ignoreScope);

    const acceptedHandles = this.connectedHosts.listAcceptedHosts();
    const acceptedByServerId = new Map<string, FleetAcceptedHostHandle>();
    for (const handle of acceptedHandles) {
      acceptedByServerId.set(handle.serverId, handle);
    }

    const candidates: NormalizedKnownHost[] = [];
    const seenServerIds = new Set<string>();

    for (const summary of this.connectedHosts.listKnownHosts()) {
      const normalized = this.normalizeKnownHostSummary(summary, acceptedByServerId, ignoreScope);
      if (!normalized) continue;
      seenServerIds.add(normalized.serverId);
      candidates.push(normalized);
    }

    for (const handle of acceptedHandles) {
      if (handle.serverId === this.localServerId || seenServerIds.has(handle.serverId)) continue;
      if (!this.shouldIncludeHost(handle.serverId, ignoreScope)) continue;
      candidates.push({
        key: handle.serverId,
        serverId: handle.serverId,
        registrationId: handle.registrationId,
        expectedServerId: handle.serverId,
        targetDescription: null,
        label: handle.label,
        summary: null,
        acceptedHandle: handle,
      });
    }

    return deduplicateNormalizedHosts(candidates);
  }

  private getOrCreateRemoteState(
    serverId: string,
    registrationId: string,
    label: string,
  ): RemoteHostState {
    let state = this.remoteStates.get(serverId);
    if (!state) {
      state = {
        serverId,
        registrationId,
        label,
        agents: new Map(),
        hasSynced: false,
        lastSyncedAt: null,
        lastSyncedAtMs: null,
        lastSyncError: null,
        inFlightSync: null,
        generation: 0,
        attachedClient: null,
        cleanupAttachment: null,
      };
      this.remoteStates.set(serverId, state);
    } else {
      state.registrationId = registrationId;
      state.label = label;
    }
    return state;
  }

  private reconcileHosts(emitHostChangeEvent: boolean): NormalizedKnownHost[] {
    const normalized = this.normalizeConnectedHosts();
    const presentServerIds = new Set<string>();
    const changedAgentHosts: string[] = [];

    for (const entry of normalized) {
      presentServerIds.add(entry.serverId);
      const existingState = this.remoteStates.get(entry.serverId);

      if (entry.summary?.status === "disabled") {
        if (existingState) {
          const hadCachedAgents = existingState.agents.size > 0;
          this.detachRemoteHost(existingState);
          this.clearRemoteHostCache(existingState);
          if (hadCachedAgents) changedAgentHosts.push(entry.serverId);
        }
        continue;
      }

      if (entry.acceptedHandle) {
        const state = this.getOrCreateRemoteState(
          entry.serverId,
          entry.registrationId,
          entry.label,
        );
        if (this.started && state.attachedClient !== entry.acceptedHandle.client) {
          this.attachRemoteHost(entry.acceptedHandle, state);
        }
      } else if (existingState && existingState.attachedClient !== null) {
        this.detachRemoteHost(existingState);
        if (existingState.agents.size > 0) {
          changedAgentHosts.push(entry.serverId);
        }
      }
    }

    // Remove hosts that no longer exist in ConnectedHosts.
    for (const [serverId, state] of Array.from(this.remoteStates.entries())) {
      if (presentServerIds.has(serverId)) continue;
      const hadAgents = state.agents.size > 0;
      this.detachRemoteHost(state);
      this.clearRemoteHostCache(state);
      this.remoteStates.delete(serverId);
      if (hadAgents) changedAgentHosts.push(serverId);
    }

    if (emitHostChangeEvent) {
      this.emit({
        type: "hosts_changed",
        hosts: this.buildCurrentHostSummaries(normalized),
      });
      for (const serverId of changedAgentHosts) {
        this.emit({
          type: "agents_changed",
          serverId,
          reason: "host_status",
        });
      }
    }

    return normalized;
  }

  private attachRemoteHost(handle: FleetAcceptedHostHandle, state: RemoteHostState): void {
    this.detachRemoteHost(state);

    const generation = state.generation;
    const client = handle.client;
    state.attachedClient = client;

    let observeActive = false;
    let releaseObserve: (() => void) | null = null;

    if (typeof client.observeAgents === "function") {
      try {
        const subscription = client.observeAgents({ filter: { includeArchived: false } });
        observeActive = true;
        const unsubscribeObserver = subscription.subscribe({
          snapshot: (payload) => {
            if (!this.started || state.generation !== generation) return;
            this.applyRemoteFullSnapshot(state, payload.entries, "remote_sync");
          },
          update: (message) => {
            if (!this.started || state.generation !== generation) return;
            this.handleRemoteOutboundMessage(state, message);
          },
          error: (error) => {
            if (!this.started || state.generation !== generation) return;
            observeActive = false;
            this.logger.warn(
              { err: error, serverId: state.serverId },
              "Remote observeAgents stream failed; falling back to polling",
            );
          },
        });
        void subscription.ready.catch((error: unknown) => {
          if (!this.started || state.generation !== generation) return;
          observeActive = false;
          this.logger.warn(
            { err: error, serverId: state.serverId },
            "Remote observeAgents bootstrap failed",
          );
        });
        releaseObserve = () => {
          unsubscribeObserver();
          void subscription.release().catch(() => {});
        };
      } catch (error) {
        observeActive = false;
        this.logger.warn(
          { err: error, serverId: state.serverId },
          "Unable to start remote observeAgents; falling back to event subscription + polling",
        );
      }
    }

    const unsubscribeClient = client.subscribe((event) => {
      if (!this.started || state.generation !== generation) return;
      this.handleRemoteDaemonEvent(state, event, observeActive);
    });

    let pollTimer: ReturnType<typeof setInterval> | null = null;
    if (this.remotePollIntervalMs > 0) {
      pollTimer = setInterval(() => {
        if (!this.started || state.generation !== generation) return;
        if (!client.isConnected) return;
        void this.syncRemoteHost(handle, state);
      }, this.remotePollIntervalMs);
      pollTimer.unref?.();
    }

    state.cleanupAttachment = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      unsubscribeClient();
      releaseObserve?.();
      releaseObserve = null;
    };

    // Kick off an immediate non-blocking sync when observeAgents is unavailable.
    if (!observeActive) {
      void this.syncRemoteHost(handle, state);
    }
  }

  private detachRemoteHost(state: RemoteHostState): void {
    state.generation += 1;
    state.inFlightSync = null;
    state.attachedClient = null;
    const cleanup = state.cleanupAttachment;
    state.cleanupAttachment = null;
    cleanup?.();
  }

  private clearRemoteHostCache(state: RemoteHostState): void {
    for (const agentId of state.agents.keys()) {
      this.clearEmittedPermissionsForAgent(state.serverId, agentId);
    }
    state.agents.clear();
    state.hasSynced = false;
    state.lastSyncedAt = null;
    state.lastSyncedAtMs = null;
    state.lastSyncError = null;
  }

  private shouldSyncRemoteHost(
    state: RemoteHostState,
    forceRefresh: boolean,
    nowMs: number,
  ): boolean {
    if (forceRefresh) return true;
    if (state.inFlightSync !== null) return true;
    if (!state.hasSynced || state.lastSyncError !== null) return true;
    if (state.lastSyncedAtMs === null) return true;
    if (
      this.remotePollIntervalMs > 0 &&
      nowMs - state.lastSyncedAtMs >= this.remotePollIntervalMs
    ) {
      return true;
    }
    return false;
  }

  private syncRemoteHost(handle: FleetAcceptedHostHandle, state: RemoteHostState): Promise<void> {
    if (state.inFlightSync) {
      return state.inFlightSync;
    }

    const generation = state.generation;
    let syncPromise: Promise<void> | null = null;
    syncPromise = (async () => {
      try {
        const result = await this.runWithTimeout(
          handle.client.fetchAgents({
            filter: { includeArchived: false },
            timeout: this.remoteTimeoutMs,
          }),
          this.remoteTimeoutMs,
          handle.serverId,
          "syncRemoteHost",
        );
        if (state.generation !== generation) return;
        this.applyRemoteFullSnapshot(state, result.entries, "remote_sync");
      } catch (error) {
        if (state.generation !== generation) return;
        state.lastSyncError = toErrorMessage(error);
        this.logger.warn(
          { err: error, serverId: handle.serverId },
          "Remote fleet sync failed; preserving isolated failure state",
        );
      } finally {
        if (state.inFlightSync === syncPromise) {
          state.inFlightSync = null;
        }
      }
    })();

    state.inFlightSync = syncPromise;
    return syncPromise;
  }

  private applyRemoteFullSnapshot(
    state: RemoteHostState,
    entries: ReadonlyArray<{ agent: AgentSnapshotPayload }>,
    reason: FleetAgentsChangedReason,
  ): void {
    const nextAgents = new Map<string, AggregatedHostAgent>();
    const activePermissionKeys = new Set<string>();
    const newPermissions: Array<{ agentId: string; permission: AggregatedHostPendingPermission }> =
      [];

    for (const entry of entries) {
      const snapshot = entry.agent;
      if (isFilteredRemoteSnapshot(snapshot)) continue;
      const projected = toRemoteAgent(snapshot, state.serverId, state.label, false);
      nextAgents.set(projected.agentId, projected);

      for (const permission of projected.pendingPermissions) {
        const key = permissionKey(state.serverId, projected.agentId, permission.requestId);
        activePermissionKeys.add(key);
        if (!this.emittedPermissionKeys.has(key)) {
          this.emittedPermissionKeys.add(key);
          newPermissions.push({ agentId: projected.agentId, permission });
        }
      }
    }

    // Prune permission tracking keys that are no longer active on this host.
    const hostPrefix = `${state.serverId}\u0000`;
    for (const key of Array.from(this.emittedPermissionKeys)) {
      if (key.startsWith(hostPrefix) && !activePermissionKeys.has(key)) {
        this.emittedPermissionKeys.delete(key);
      }
    }

    state.agents = nextAgents;
    state.hasSynced = true;
    state.lastSyncedAt = new Date().toISOString();
    state.lastSyncedAtMs = Date.now();
    state.lastSyncError = null;

    if (this.started) {
      for (const item of newPermissions) {
        this.emit({
          type: "permission_requested",
          serverId: state.serverId,
          hostLabel: state.label,
          isLocal: false,
          agentId: item.agentId,
          permission: item.permission,
        });
      }
      this.emit({
        type: "agents_changed",
        serverId: state.serverId,
        reason,
      });
    }
  }

  private applyRemoteAgentUpsert(
    state: RemoteHostState,
    snapshot: AgentSnapshotPayload,
    reason: FleetAgentsChangedReason,
  ): void {
    if (isFilteredRemoteSnapshot(snapshot)) {
      this.applyRemoteAgentRemoved(state, snapshot.id);
      return;
    }

    const projected = toRemoteAgent(snapshot, state.serverId, state.label, false);
    state.agents.set(projected.agentId, projected);
    state.hasSynced = true;
    state.lastSyncedAt = new Date().toISOString();
    state.lastSyncedAtMs = Date.now();
    state.lastSyncError = null;

    const currentPermissionIds = new Set<string>();
    const newPermissions: AggregatedHostPendingPermission[] = [];
    for (const permission of projected.pendingPermissions) {
      currentPermissionIds.add(permission.requestId);
      const key = permissionKey(state.serverId, projected.agentId, permission.requestId);
      if (!this.emittedPermissionKeys.has(key)) {
        this.emittedPermissionKeys.add(key);
        newPermissions.push(permission);
      }
    }

    const agentPrefix = `${state.serverId}\u0000${projected.agentId}\u0000`;
    for (const key of Array.from(this.emittedPermissionKeys)) {
      if (!key.startsWith(agentPrefix)) continue;
      const reqId = key.slice(agentPrefix.length);
      if (!currentPermissionIds.has(reqId)) {
        this.emittedPermissionKeys.delete(key);
      }
    }

    if (this.started) {
      for (const permission of newPermissions) {
        this.emit({
          type: "permission_requested",
          serverId: state.serverId,
          hostLabel: state.label,
          isLocal: false,
          agentId: projected.agentId,
          permission,
        });
      }
      this.emit({
        type: "agents_changed",
        serverId: state.serverId,
        agentIds: [projected.agentId],
        reason,
      });
    }
  }

  private applyRemoteAgentRemoved(state: RemoteHostState, agentId: string): void {
    const existed = state.agents.delete(agentId);
    this.clearEmittedPermissionsForAgent(state.serverId, agentId);
    if (existed && this.started) {
      this.emit({
        type: "agents_changed",
        serverId: state.serverId,
        agentIds: [agentId],
        reason: "remote_removed",
      });
    }
  }

  private applyRemotePermissionRequested(
    state: RemoteHostState,
    agentId: string,
    request: AgentPermissionRequest,
  ): void {
    const permission = mapPermissionRequest(request);
    const cached = state.agents.get(agentId);
    if (cached) {
      const withoutDup = cached.pendingPermissions.filter(
        (existing) => existing.requestId !== permission.requestId,
      );
      cached.pendingPermissions = [...withoutDup, permission];
      cached.requiresAttention = true;
      cached.attentionReason = "permission";
      cached.updatedAtIso = new Date().toISOString();
    }

    const key = permissionKey(state.serverId, agentId, permission.requestId);
    const isNew = !this.emittedPermissionKeys.has(key);
    this.emittedPermissionKeys.add(key);

    if (this.started) {
      if (isNew) {
        this.emit({
          type: "permission_requested",
          serverId: state.serverId,
          hostLabel: state.label,
          isLocal: false,
          agentId,
          permission,
        });
      }
      this.emit({
        type: "agents_changed",
        serverId: state.serverId,
        agentIds: [agentId],
        reason: "remote_update",
      });
    }
  }

  private applyRemotePermissionResolved(
    state: RemoteHostState,
    agentId: string,
    requestId: string,
    emitEvents: boolean,
  ): void {
    this.emittedPermissionKeys.delete(permissionKey(state.serverId, agentId, requestId));
    const cached = state.agents.get(agentId);
    if (cached) {
      cached.pendingPermissions = cached.pendingPermissions.filter(
        (existing) => existing.requestId !== requestId,
      );
      if (cached.pendingPermissions.length === 0 && cached.attentionReason === "permission") {
        cached.attentionReason = null;
        cached.requiresAttention = false;
      }
    }

    if (emitEvents && this.started) {
      this.emit({
        type: "permission_resolved",
        serverId: state.serverId,
        agentId,
        requestId,
      });
      this.emit({
        type: "agents_changed",
        serverId: state.serverId,
        agentIds: [agentId],
        reason: "remote_update",
      });
    }
  }

  private handleRemoteOutboundMessage(
    state: RemoteHostState,
    message: SessionOutboundMessage,
  ): void {
    if (message.type === "agent_update") {
      if (message.payload.kind === "upsert") {
        this.applyRemoteAgentUpsert(state, message.payload.agent, "remote_update");
      } else {
        this.applyRemoteAgentRemoved(state, message.payload.agentId);
      }
    }
  }

  private handleRemoteDaemonEvent(
    state: RemoteHostState,
    event: DaemonEvent,
    observeActive: boolean,
  ): void {
    switch (event.type) {
      case "agent_update":
        if (observeActive) return;
        if (event.payload.kind === "upsert") {
          this.applyRemoteAgentUpsert(state, event.payload.agent, "remote_update");
        } else {
          this.applyRemoteAgentRemoved(state, event.payload.agentId);
        }
        return;
      case "agent_deleted":
        this.applyRemoteAgentRemoved(state, event.agentId);
        return;
      case "agent_permission_request":
        this.applyRemotePermissionRequested(state, event.agentId, event.request);
        return;
      case "agent_permission_resolved":
        this.applyRemotePermissionResolved(state, event.agentId, event.requestId, true);
        return;
      default:
        return;
    }
  }

  private handleLocalManagerEvent(event: AgentManagerEvent): void {
    if (!this.started) return;

    if (event.type === "agent_state") {
      if (event.agent.internal === true) return;
      const agent = event.agent;
      const currentIds = new Set<string>();
      for (const request of agent.pendingPermissions.values()) {
        currentIds.add(request.id);
        const key = permissionKey(this.localServerId, agent.id, request.id);
        if (!this.emittedPermissionKeys.has(key)) {
          this.emittedPermissionKeys.add(key);
          this.emit({
            type: "permission_requested",
            serverId: this.localServerId,
            hostLabel: this.localLabel,
            isLocal: true,
            agentId: agent.id,
            permission: mapPermissionRequest(request),
          });
        }
      }
      const prefix = `${this.localServerId}\u0000${agent.id}\u0000`;
      for (const key of Array.from(this.emittedPermissionKeys)) {
        if (!key.startsWith(prefix)) continue;
        const reqId = key.slice(prefix.length);
        if (!currentIds.has(reqId)) {
          this.emittedPermissionKeys.delete(key);
        }
      }
      this.emit({
        type: "agents_changed",
        serverId: this.localServerId,
        agentIds: [agent.id],
        reason: "local_update",
      });
      return;
    }

    if (event.type === "agent_removed") {
      if (event.internal) return;
      this.clearEmittedPermissionsForAgent(this.localServerId, event.agentId);
      this.emit({
        type: "agents_changed",
        serverId: this.localServerId,
        agentIds: [event.agentId],
        reason: "local_update",
      });
      return;
    }

    if (event.type === "agent_stream") {
      const liveAgent = this.agentManager.getAgent(event.agentId);
      if (liveAgent?.internal === true) return;

      if (event.event.type === "permission_requested") {
        const permission = mapPermissionRequest(event.event.request);
        const key = permissionKey(this.localServerId, event.agentId, permission.requestId);
        if (!this.emittedPermissionKeys.has(key)) {
          this.emittedPermissionKeys.add(key);
          this.emit({
            type: "permission_requested",
            serverId: this.localServerId,
            hostLabel: this.localLabel,
            isLocal: true,
            agentId: event.agentId,
            permission,
          });
        }
      } else if (event.event.type === "permission_resolved") {
        this.emittedPermissionKeys.delete(
          permissionKey(this.localServerId, event.agentId, event.event.requestId),
        );
        this.emit({
          type: "permission_resolved",
          serverId: this.localServerId,
          agentId: event.agentId,
          requestId: event.event.requestId,
        });
      }
    }
  }

  private resolveRemoteHostStatus(
    entry: NormalizedKnownHost,
    state: RemoteHostState | undefined,
  ): { status: AggregatedHostStatus; error: string | null; stale: boolean } {
    if (entry.summary?.status === "disabled") {
      return {
        status: "offline",
        error: entry.summary.error?.message ?? "Host is disabled",
        stale: true,
      };
    }

    if (entry.acceptedHandle) {
      if (state?.lastSyncError) {
        return {
          status: state.hasSynced ? "degraded" : "error",
          error: state.lastSyncError,
          stale: true,
        };
      }
      return {
        status: "online",
        error: null,
        stale: false,
      };
    }

    const summaryStatus = entry.summary?.status ?? "offline";
    const summaryError = entry.summary?.error?.message ?? null;
    if (summaryStatus === "connecting") {
      return { status: "connecting", error: summaryError, stale: true };
    }
    if (summaryStatus === "error") {
      return { status: "error", error: summaryError, stale: true };
    }
    return { status: "offline", error: summaryError, stale: true };
  }

  private buildCurrentHostSummaries(normalized: NormalizedKnownHost[]): AggregatedHostSummary[] {
    const localLive = this.agentManager.listAgents().filter((agent) => agent.internal !== true);
    const localNeedsAttention = localLive.filter(
      (agent) => agent.attention.requiresAttention || agent.pendingPermissions.size > 0,
    ).length;

    const hosts: AggregatedHostSummary[] = [
      {
        serverId: this.localServerId,
        label: this.localLabel,
        isLocal: true,
        status: "online",
        agentCount: localLive.length,
        needsAttentionCount: localNeedsAttention,
        lastSyncedAt: new Date().toISOString(),
        error: null,
      },
    ];

    for (const entry of normalized) {
      const state = this.remoteStates.get(entry.serverId);
      const { status, error } = this.resolveRemoteHostStatus(entry, state);
      const cachedAgents =
        state && entry.summary?.status !== "disabled" ? Array.from(state.agents.values()) : [];
      hosts.push({
        serverId: entry.serverId,
        label: entry.label,
        isLocal: false,
        status,
        agentCount: cachedAgents.length,
        needsAttentionCount: cachedAgents.filter(agentNeedsAttention).length,
        lastSyncedAt: state?.lastSyncedAt ?? entry.summary?.lastOnlineAt ?? null,
        error,
        registrationId: entry.registrationId,
        ...(entry.expectedServerId ? { expectedServerId: entry.expectedServerId } : {}),
        ...(entry.targetDescription ? { targetDescription: entry.targetDescription } : {}),
      });
    }

    return hosts;
  }

  private resolveTargetHost(
    serverId: string,
    operation: string,
  ): { kind: "local" } | { kind: "remote"; client: FleetRemoteDaemonClient; label: string } {
    if (serverId === this.localServerId) {
      return { kind: "local" };
    }

    if (this.isHostAllowed && !this.isHostAllowed(serverId)) {
      throw new FleetHostError(
        "host_out_of_scope",
        `Host ${serverId} is outside this steward's configured host scope`,
        serverId,
        { operation },
      );
    }

    if (!this.connectedHosts) {
      throw new FleetHostError("host_unknown", `Unknown host: ${serverId}`, serverId, {
        operation,
      });
    }

    const acceptedClient = this.connectedHosts.getAcceptedClient(serverId);
    if (acceptedClient && acceptedClient.isConnected) {
      const acceptedHandle = this.connectedHosts
        .listAcceptedHosts()
        .find((handle) => handle.serverId === serverId);
      return {
        kind: "remote",
        client: acceptedClient,
        label: acceptedHandle?.label ?? serverId,
      };
    }

    const known = this.connectedHosts
      .listKnownHosts()
      .find((host) => host.serverId === serverId || host.registrationId === serverId);
    if (!known) {
      throw new FleetHostError("host_unknown", `Unknown host: ${serverId}`, serverId, {
        operation,
      });
    }

    throw new FleetHostError(
      "host_offline",
      known.error?.message ?? `Host ${serverId} is offline (${known.status})`,
      serverId,
      { operation },
    );
  }

  private runWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    serverId: string,
    operation: string,
  ): Promise<T> {
    if (timeoutMs <= 0) {
      return promise;
    }

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeTimeoutCleanups.delete(abortOnStop);
      };

      const abortOnStop = () => {
        if (settled) return;
        cleanup();
        reject(
          new FleetHostError(
            "host_offline",
            `${operation} aborted because fleet aggregator stopped`,
            serverId,
            { operation },
          ),
        );
      };

      const timer = setTimeout(() => {
        if (settled) return;
        cleanup();
        reject(
          new FleetHostError(
            "timeout",
            `${operation} on host ${serverId} timed out after ${timeoutMs}ms`,
            serverId,
            { operation },
          ),
        );
      }, timeoutMs);
      timer.unref?.();

      this.activeTimeoutCleanups.add(abortOnStop);

      void (async () => {
        try {
          const value = await promise;
          if (settled) return;
          cleanup();
          resolve(value);
        } catch (error: unknown) {
          if (settled) return;
          cleanup();
          reject(error);
        }
      })();
    });
  }

  private wrapHostError(
    error: unknown,
    serverId: string,
    operation: string,
    client?: FleetRemoteDaemonClient,
  ): FleetHostError {
    if (error instanceof FleetHostError) {
      return error;
    }
    if (isConnectionLostError(error) || (client !== undefined && !client.isConnected)) {
      return new FleetHostError("host_offline", toErrorMessage(error), serverId, {
        cause: error,
        operation,
      });
    }
    return new FleetHostError("dispatch_failed", toErrorMessage(error), serverId, {
      cause: error,
      operation,
    });
  }

  private clearEmittedPermissionsForAgent(serverId: string, agentId: string): void {
    const prefix = `${serverId}\u0000${agentId}\u0000`;
    for (const key of Array.from(this.emittedPermissionKeys)) {
      if (key.startsWith(prefix)) {
        this.emittedPermissionKeys.delete(key);
      }
    }
  }

  private emit(event: FleetAggregatorEvent): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn({ err: error, eventType: event.type }, "Fleet aggregator listener failed");
      }
    }
  }
}

export function createMainChatFleetAggregator(
  options: MainChatFleetAggregatorOptions,
): MainChatFleetAggregator {
  return new MainChatFleetAggregator(options);
}
