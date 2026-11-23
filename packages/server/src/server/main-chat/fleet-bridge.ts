import path from "node:path";
import {
  PARENT_AGENT_ID_LABEL,
  PARENT_SERVER_ID_LABEL,
  getParentAgentIdFromLabels,
} from "@getpaseo/protocol/agent-labels";
import type { AgentPermissionResponse, AgentProvider } from "@getpaseo/protocol/agent-types";
import {
  MAIN_CHAT_TASK_GOAL_LABEL,
  MAIN_CHAT_TASK_ID_LABEL,
  MAIN_CHAT_TASK_MODE_LABEL,
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
  MAIN_CHAT_TASK_QUIET_LABEL,
  MAIN_CHAT_TASK_RECORD_ID_LABEL,
  getMainChatTaskMetaFromLabels,
  isFormerMainChatLabels,
  isMainChatLabels,
  type MainChatFleetHostStatus,
  type MainChatSessionTriage,
  type MainChatTaskMode,
} from "@getpaseo/protocol/main-chat";
import type { FleetSessionSnapshotItem, FleetSnapshotSummary } from "./context-snapshot.js";
import { isMainChatConversationLabels } from "./conversations.js";
import {
  FleetHostError,
  type AggregatedFleetSnapshot,
  type AggregatedHostAgent,
  type AggregatedHostPendingPermission,
  type AggregatedHostSummary,
  type CollectFleetOptions as AggregatorCollectFleetOptions,
  type CrossHostAgentControlAction,
  type CrossHostAgentTailMessage,
  type CrossHostDispatchInput,
  type CrossHostDispatchResult,
  type FleetAgentsChangedReason,
  type FleetAggregatorEvent,
  type FleetHostErrorCode,
  type ReadHostAgentTailOptions,
  type SendHostPromptOptions,
} from "./fleet-aggregator.js";

export class MainChatFleetBridgeError extends FleetHostError {
  constructor(
    code: FleetHostErrorCode,
    message: string,
    serverId: string,
    options?: { cause?: unknown; operation?: string },
  ) {
    super(code, message, serverId, options);
    this.name = "MainChatFleetBridgeError";
  }
}

export interface FleetAggregatorLike {
  collectFleet(options?: AggregatorCollectFleetOptions): Promise<AggregatedFleetSnapshot>;
  dispatchAgentOnHost(input: CrossHostDispatchInput): Promise<CrossHostDispatchResult>;
  sendPromptToHostAgent(
    serverId: string,
    agentId: string,
    prompt: string,
    options?: SendHostPromptOptions,
  ): Promise<void>;
  respondPermissionOnHost(
    serverId: string,
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void>;
  readHostAgentTail(
    serverId: string,
    agentId: string,
    options?: ReadHostAgentTailOptions,
  ): Promise<CrossHostAgentTailMessage[]>;
  controlHostAgent(
    serverId: string,
    agentId: string,
    action: CrossHostAgentControlAction,
  ): Promise<void>;
  subscribe(listener: (event: FleetAggregatorEvent) => void): () => void;
}

export interface CollectMultiHostFleetOptions {
  mainAgentId?: string | null;
  forceRefresh?: boolean;
  triageByAgentId?: ReadonlyMap<string, MainChatSessionTriage>;
  excludeAgentIds?: ReadonlySet<string>;
}

export interface FleetItemServerLocation {
  serverId: string;
  hostLabel: string;
  isLocal: boolean;
}

export interface MultiHostFleetCollection {
  summary: FleetSnapshotSummary;
  hosts: MainChatFleetHostStatus[];
  localServerId: string;
  itemServerMap: Map<string, FleetItemServerLocation>;
}

export interface GetFleetHostsOptions {
  forceRefresh?: boolean;
}

export interface GetFleetHostsResult {
  localServerId: string;
  hosts: MainChatFleetHostStatus[];
}

export interface DispatchTaskToTargetHostInput {
  serverId?: string | null;
  cwd: string;
  title: string;
  provider: AgentProvider;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  initialPrompt?: string;
  workspaceId?: string;
  isolation?: "local" | "worktree";
  baseBranch?: string;
  branchName?: string;
  worktreeSlug?: string;
  idempotencyKey?: string;
  background?: boolean;
  timeoutMs?: number;
  mainAgentId?: string | null;
  planId?: string | null;
  taskId?: string | null;
  taskRecordId?: string | null;
  mode?: MainChatTaskMode | null;
  goal?: string | null;
  quiet?: boolean;
  labels?: Record<string, string>;
}

export interface LocalTaskDispatchInput extends DispatchTaskToTargetHostInput {
  serverId: string;
  labels: Record<string, string>;
}

export interface FleetBridgePermissionRequestedEvent {
  serverId: string;
  hostLabel: string;
  isLocal: boolean;
  agentId: string;
  permission: AggregatedHostPendingPermission;
}

export interface FleetBridgePermissionResolvedEvent {
  serverId: string;
  agentId: string;
  requestId: string;
}

export interface FleetBridgeAgentsChangedEvent {
  serverId: string;
  agentIds?: string[];
  reason: FleetAgentsChangedReason;
}

export interface FleetBridgeEventHandlers {
  onInvalidateSnapshot: () => void;
  onPermissionRequested?: (event: FleetBridgePermissionRequestedEvent) => void;
  onPermissionResolved?: (event: FleetBridgePermissionResolvedEvent) => void;
  onHostsChanged?: (hosts: MainChatFleetHostStatus[]) => void;
  onAgentsChanged?: (event: FleetBridgeAgentsChangedEvent) => void;
}

export interface MainChatFleetBridgeDeps {
  localServerId: string;
  fleetAggregator: FleetAggregatorLike;
  listExcludedAgentIds?: () => Iterable<string>;
  getTriage?: (agentId: string) => MainChatSessionTriage | null;
  dispatchLocalTask?: (input: LocalTaskDispatchInput) => Promise<CrossHostDispatchResult>;
  sendLocalPrompt?: (
    agentId: string,
    prompt: string,
    options?: SendHostPromptOptions,
  ) => Promise<void>;
  respondLocalPermission?: (
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ) => Promise<void>;
  readLocalAgentTail?: (
    agentId: string,
    options?: ReadHostAgentTailOptions,
  ) => Promise<CrossHostAgentTailMessage[]>;
  cancelLocalAgent?: (agentId: string) => Promise<void>;
}

export interface MainChatFleetBridge {
  collectMultiHostFleet(options?: CollectMultiHostFleetOptions): Promise<MultiHostFleetCollection>;
  getFleetHosts(options?: GetFleetHostsOptions): Promise<GetFleetHostsResult>;
  dispatchTaskToTargetHost(input: DispatchTaskToTargetHostInput): Promise<CrossHostDispatchResult>;
  sendPromptToTargetAgent(
    serverId: string | null | undefined,
    agentId: string,
    prompt: string,
    options?: SendHostPromptOptions,
  ): Promise<void>;
  respondPermissionOnTargetHost(
    serverId: string | null | undefined,
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<void>;
  readTargetAgentTail(
    serverId: string | null | undefined,
    agentId: string,
    options?: ReadHostAgentTailOptions,
  ): Promise<CrossHostAgentTailMessage[]>;
  cancelTargetAgent(serverId: string | null | undefined, agentId: string): Promise<void>;
  subscribeFleetEvents(handlers: FleetBridgeEventHandlers): () => void;
}

function emptyFleetSummary(): FleetSnapshotSummary {
  return {
    totalActive: 0,
    needsYou: [],
    problematic: [],
    running: [],
    attentionDone: [],
    idleOther: [],
  };
}

function basenameOf(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return path.basename(trimmed) || trimmed;
}

function truncateText(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

function summarizePermission(permission: AggregatedHostPendingPermission): string {
  const label = permission.title?.trim() || permission.name.trim() || "待审批请求";
  const desc = permission.description?.trim();
  if (desc && desc !== label) {
    return `${label}（${truncateText(desc, 60)}）`;
  }
  return label;
}

function formatProjectName(agent: AggregatedHostAgent): string {
  const base = basenameOf(agent.cwd);
  if (agent.isLocal) {
    return base;
  }
  const hostTag = agent.hostLabel.trim() || agent.serverId;
  return `[${hostTag}] ${base}`;
}

function isExcludedConversationAgent(
  agent: AggregatedHostAgent,
  excludedIds: ReadonlySet<string>,
): boolean {
  if (excludedIds.has(agent.agentId)) return true;
  if (isMainChatLabels(agent.labels)) return true;
  if (isFormerMainChatLabels(agent.labels)) return true;
  if (isMainChatConversationLabels(agent.labels)) return true;
  return false;
}

function toSnapshotItem(
  agent: AggregatedHostAgent,
  mainAgentId: string | null | undefined,
  triage: MainChatSessionTriage | null,
): FleetSessionSnapshotItem {
  const parentId = getParentAgentIdFromLabels(agent.labels);
  const taskMeta = getMainChatTaskMetaFromLabels(agent.labels);
  const managedByMainChat = Boolean(
    (mainAgentId && parentId === mainAgentId) ||
    (parentId && taskMeta?.planId) ||
    taskMeta?.planId ||
    taskMeta?.taskId,
  );
  const pendingPermissionLabels = agent.pendingPermissions.map(summarizePermission);
  const title = agent.title.trim() || basenameOf(agent.cwd);

  return {
    agentId: agent.agentId,
    workspaceId: agent.workspaceId,
    title,
    cwd: agent.cwd,
    projectName: formatProjectName(agent),
    managedByMainChat,
    lifecycle: agent.lifecycle,
    requiresAttention: agent.requiresAttention,
    attentionReason: agent.attentionReason,
    pendingPermissionLabels,
    lastError: agent.lastError,
    updatedAtIso: agent.updatedAtIso,
    triage,
  };
}

function classifyFleetItem(
  item: FleetSessionSnapshotItem,
): keyof Omit<FleetSnapshotSummary, "totalActive"> {
  const phase = item.triage?.phase ?? null;
  if (
    item.pendingPermissionLabels.length > 0 ||
    phase === "blocked_user" ||
    item.attentionReason === "permission"
  ) {
    return "needsYou";
  }
  if (
    item.lifecycle === "error" ||
    Boolean(item.lastError) ||
    phase === "interrupted" ||
    phase === "stalled" ||
    phase === "no_progress"
  ) {
    return "problematic";
  }
  if (item.lifecycle === "running" || item.lifecycle === "initializing") {
    return "running";
  }
  if (item.requiresAttention || phase === "done" || phase === "blocked_external") {
    return "attentionDone";
  }
  return "idleOther";
}

function agentNeedsAttention(
  agent: AggregatedHostAgent,
  triage: MainChatSessionTriage | null,
): boolean {
  if (
    agent.requiresAttention ||
    agent.pendingPermissions.length > 0 ||
    agent.lifecycle === "error" ||
    Boolean(agent.lastError)
  ) {
    return true;
  }
  const phase = triage?.phase;
  return phase === "blocked_user" || phase === "interrupted" || phase === "stalled";
}

function toFleetHostStatus(host: AggregatedHostSummary): MainChatFleetHostStatus {
  return {
    serverId: host.serverId,
    label: host.label,
    isLocal: host.isLocal,
    status: host.status,
    agentCount: host.agentCount,
    needsAttentionCount: host.needsAttentionCount,
    lastSyncedAt: host.lastSyncedAt,
    error: host.error,
  };
}

export function buildTaskDispatchLabels(
  input: Pick<
    DispatchTaskToTargetHostInput,
    "mainAgentId" | "planId" | "taskId" | "taskRecordId" | "mode" | "goal" | "quiet" | "labels"
  >,
  localServerId: string,
): Record<string, string> {
  const labels: Record<string, string> = { ...input.labels };
  if (input.mainAgentId?.trim()) {
    labels[PARENT_AGENT_ID_LABEL] = input.mainAgentId.trim();
    labels[PARENT_SERVER_ID_LABEL] = localServerId;
  }
  if (input.planId?.trim()) {
    labels[MAIN_CHAT_TASK_PLAN_ID_LABEL] = input.planId.trim();
  }
  if (input.taskId?.trim()) {
    labels[MAIN_CHAT_TASK_ID_LABEL] = input.taskId.trim();
  }
  if (input.taskRecordId?.trim()) {
    labels[MAIN_CHAT_TASK_RECORD_ID_LABEL] = input.taskRecordId.trim();
  }
  if (input.mode) {
    labels[MAIN_CHAT_TASK_MODE_LABEL] = input.mode;
  }
  if (input.goal?.trim()) {
    labels[MAIN_CHAT_TASK_GOAL_LABEL] = input.goal.trim();
  }
  if (input.quiet !== undefined) {
    labels[MAIN_CHAT_TASK_QUIET_LABEL] = input.quiet ? "true" : "false";
  }
  return labels;
}

function formatOperationLabel(operation: string): string {
  switch (operation) {
    case "dispatchTaskToTargetHost":
      return "派发任务";
    case "sendPromptToTargetAgent":
      return "发送消息";
    case "respondPermissionOnTargetHost":
      return "响应权限审批";
    case "readTargetAgentTail":
      return "读取会话记录";
    case "cancelTargetAgent":
      return "中止任务";
    default:
      return operation;
  }
}

function translateHostError(error: unknown, serverId: string, operation: string): Error {
  if (error instanceof MainChatFleetBridgeError) {
    return error;
  }
  if (error instanceof FleetHostError) {
    const opLabel = formatOperationLabel(operation);
    const targetId = error.serverId || serverId;
    let message: string;
    switch (error.code) {
      case "host_offline":
        message = `远端主机 ${targetId} 当前离线或未建立连接，无法${opLabel}。请检查目标主机在线状态后重试。`;
        break;
      case "host_unknown":
        message = `未找到已接入的远端主机 ${targetId}，无法${opLabel}。请先在主对话设置中将该主机接入 ConnectedHosts。`;
        break;
      case "timeout":
        message = `向主机 ${targetId} ${opLabel}超时，请先核对目标主机状态，避免重复触发。`;
        break;
      case "dispatch_failed":
        message = `在主机 ${targetId} 上${opLabel}失败：${error.message}`;
        break;
    }
    return new MainChatFleetBridgeError(error.code, message, targetId, {
      cause: error,
      operation,
    });
  }
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export function createMainChatFleetBridge(deps: MainChatFleetBridgeDeps): MainChatFleetBridge {
  const localServerId = deps.localServerId;

  function resolveTargetServerId(serverId: string | null | undefined): {
    serverId: string;
    isLocal: boolean;
  } {
    const trimmed = serverId?.trim();
    if (!trimmed || trimmed === localServerId) {
      return { serverId: localServerId, isLocal: true };
    }
    return { serverId: trimmed, isLocal: false };
  }

  function buildExclusionSet(options?: CollectMultiHostFleetOptions): Set<string> {
    const excluded = new Set<string>();
    if (options?.mainAgentId?.trim()) {
      excluded.add(options.mainAgentId.trim());
    }
    if (options?.excludeAgentIds) {
      for (const id of options.excludeAgentIds) {
        if (id.trim()) excluded.add(id.trim());
      }
    }
    if (deps.listExcludedAgentIds) {
      for (const id of deps.listExcludedAgentIds()) {
        if (id.trim()) excluded.add(id.trim());
      }
    }
    return excluded;
  }

  async function collectMultiHostFleet(
    options?: CollectMultiHostFleetOptions,
  ): Promise<MultiHostFleetCollection> {
    const excludedIds = buildExclusionSet(options);
    const snapshot = await deps.fleetAggregator.collectFleet({
      forceRefresh: options?.forceRefresh,
      excludeAgentIds: excludedIds,
    });

    const summary = emptyFleetSummary();
    const itemServerMap = new Map<string, FleetItemServerLocation>();
    const countsByHost = new Map<string, { agentCount: number; needsAttentionCount: number }>();

    const visibleAgents = snapshot.agents
      .filter((agent) => !isExcludedConversationAgent(agent, excludedIds))
      .sort((left, right) => {
        const updatedCompare = right.updatedAtIso.localeCompare(left.updatedAtIso);
        if (updatedCompare !== 0) return updatedCompare;
        const hostCompare = left.serverId.localeCompare(right.serverId);
        if (hostCompare !== 0) return hostCompare;
        return left.agentId.localeCompare(right.agentId);
      });

    for (const agent of visibleAgents) {
      const triage =
        options?.triageByAgentId?.get(agent.agentId) ?? deps.getTriage?.(agent.agentId) ?? null;
      const item = toSnapshotItem(agent, options?.mainAgentId, triage);
      summary[classifyFleetItem(item)].push(item);
      summary.totalActive += 1;

      itemServerMap.set(agent.agentId, {
        serverId: agent.serverId,
        hostLabel: agent.hostLabel,
        isLocal: agent.isLocal,
      });

      const hostCounts = countsByHost.get(agent.serverId) ?? {
        agentCount: 0,
        needsAttentionCount: 0,
      };
      hostCounts.agentCount += 1;
      if (agentNeedsAttention(agent, triage)) {
        hostCounts.needsAttentionCount += 1;
      }
      countsByHost.set(agent.serverId, hostCounts);
    }

    const hosts: MainChatFleetHostStatus[] = snapshot.hosts.map((host) => {
      const counts = countsByHost.get(host.serverId);
      return {
        ...toFleetHostStatus(host),
        agentCount: counts?.agentCount ?? 0,
        needsAttentionCount: counts?.needsAttentionCount ?? 0,
      };
    });

    return {
      summary,
      hosts,
      localServerId: snapshot.localServerId || localServerId,
      itemServerMap,
    };
  }

  return {
    collectMultiHostFleet,

    async getFleetHosts(options) {
      const collected = await collectMultiHostFleet({ forceRefresh: options?.forceRefresh });
      return {
        localServerId: collected.localServerId,
        hosts: collected.hosts,
      };
    },

    async dispatchTaskToTargetHost(input) {
      const target = resolveTargetServerId(input.serverId);
      const labels = buildTaskDispatchLabels(input, localServerId);

      if (target.isLocal && deps.dispatchLocalTask) {
        try {
          return await deps.dispatchLocalTask({
            ...input,
            serverId: localServerId,
            labels,
          });
        } catch (error) {
          throw translateHostError(error, localServerId, "dispatchTaskToTargetHost");
        }
      }

      const dispatchInput: CrossHostDispatchInput = {
        serverId: target.serverId,
        cwd: input.cwd,
        title: input.title,
        provider: input.provider,
        model: input.model,
        modeId: input.modeId,
        thinkingOptionId: input.thinkingOptionId,
        initialPrompt: input.initialPrompt,
        labels,
        workspaceId: input.workspaceId,
        isolation: input.isolation,
        baseBranch: input.baseBranch,
        branchName: input.branchName,
        worktreeSlug: input.worktreeSlug,
        idempotencyKey: input.idempotencyKey,
        background: input.background,
        timeoutMs: input.timeoutMs,
      };

      try {
        return await deps.fleetAggregator.dispatchAgentOnHost(dispatchInput);
      } catch (error) {
        throw translateHostError(error, target.serverId, "dispatchTaskToTargetHost");
      }
    },

    async sendPromptToTargetAgent(serverId, agentId, prompt, options) {
      const target = resolveTargetServerId(serverId);
      try {
        if (target.isLocal && deps.sendLocalPrompt) {
          await deps.sendLocalPrompt(agentId, prompt, options);
          return;
        }
        await deps.fleetAggregator.sendPromptToHostAgent(target.serverId, agentId, prompt, options);
      } catch (error) {
        throw translateHostError(error, target.serverId, "sendPromptToTargetAgent");
      }
    },

    async respondPermissionOnTargetHost(serverId, agentId, requestId, response) {
      const target = resolveTargetServerId(serverId);
      try {
        if (target.isLocal && deps.respondLocalPermission) {
          await deps.respondLocalPermission(agentId, requestId, response);
          return;
        }
        await deps.fleetAggregator.respondPermissionOnHost(
          target.serverId,
          agentId,
          requestId,
          response,
        );
      } catch (error) {
        throw translateHostError(error, target.serverId, "respondPermissionOnTargetHost");
      }
    },

    async readTargetAgentTail(serverId, agentId, options) {
      const target = resolveTargetServerId(serverId);
      try {
        if (target.isLocal && deps.readLocalAgentTail) {
          return await deps.readLocalAgentTail(agentId, options);
        }
        return await deps.fleetAggregator.readHostAgentTail(target.serverId, agentId, options);
      } catch (error) {
        throw translateHostError(error, target.serverId, "readTargetAgentTail");
      }
    },

    async cancelTargetAgent(serverId, agentId) {
      const target = resolveTargetServerId(serverId);
      try {
        if (target.isLocal && deps.cancelLocalAgent) {
          await deps.cancelLocalAgent(agentId);
          return;
        }
        await deps.fleetAggregator.controlHostAgent(target.serverId, agentId, "cancel");
      } catch (error) {
        throw translateHostError(error, target.serverId, "cancelTargetAgent");
      }
    },

    subscribeFleetEvents(handlers) {
      return deps.fleetAggregator.subscribe((event) => {
        handlers.onInvalidateSnapshot();

        switch (event.type) {
          case "hosts_changed":
            handlers.onHostsChanged?.(event.hosts.map(toFleetHostStatus));
            break;
          case "agents_changed":
            handlers.onAgentsChanged?.({
              serverId: event.serverId,
              agentIds: event.agentIds,
              reason: event.reason,
            });
            break;
          case "permission_requested":
            handlers.onPermissionRequested?.({
              serverId: event.serverId,
              hostLabel: event.hostLabel,
              isLocal: event.isLocal,
              agentId: event.agentId,
              permission: { ...event.permission },
            });
            break;
          case "permission_resolved":
            handlers.onPermissionResolved?.({
              serverId: event.serverId,
              agentId: event.agentId,
              requestId: event.requestId,
            });
            break;
        }
      });
    },
  };
}
