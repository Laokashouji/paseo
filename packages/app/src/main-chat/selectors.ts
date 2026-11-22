import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
import {
  MAIN_CHAT_DEFAULT_TITLE,
  MAIN_CHAT_WORKSPACE_DIR_NAME,
  getMainChatTaskMetaFromLabels,
  isMainChatAgent,
  isMainChatWorkspaceDirectory,
  type MainChatTaskMode,
} from "@getpaseo/protocol/main-chat";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import type { PendingPermission } from "@/types/shared";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";

type SessionStoreState = ReturnType<
  typeof import("@/stores/session-store").useSessionStore.getState
>;

export interface MainChatAgentRef {
  serverId: string;
  workspaceId: string;
  agentId: string;
}

export interface MainChatSidebarSummary {
  existing: MainChatAgentRef | null;
  targetServerId: string | null;
  supportsMainChat: boolean;
  displayTitle: string;
  hostLabel: string | null;
  isMainRunning: boolean;
  needsYouCount: number;
  runningCount: number;
  attentionCount: number;
  totalActiveCount: number;
}

export interface MainChatPendingPermissionItem {
  permission: PendingPermission;
  isChild: boolean;
  sourceAgentId: string;
  sourceAgentTitle: string;
}

export interface MainChatDockTaskItem {
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  title: string;
  mode: MainChatTaskMode | null;
  managedByMainChat: boolean;
  bucket: SidebarStateBucket;
  pendingPermissionCount: number;
  updatedAtMs: number;
}

function directoryBasename(dirPath: string): string {
  const trimmed = dirPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

/**
 * Identifies the dedicated workspace that backs the pinned Main Chat steward so it never
 * appears a second time under the regular Workspaces / Projects lists (even before agents hydrate).
 */
export function isMainChatDedicatedWorkspace(
  workspace: Pick<WorkspaceDescriptor, "id" | "workspaceDirectory" | "projectRootPath">,
  agents: ReadonlyMap<string, Agent> | undefined,
): boolean {
  const candidatePath = workspace.workspaceDirectory || workspace.projectRootPath;
  if (isMainChatWorkspaceDirectory(candidatePath)) {
    return true;
  }
  let hasMainChatAgent = false;
  let hasNonMainAgent = false;
  if (agents) {
    for (const agent of agents.values()) {
      if (agent.archivedAt || agent.background || agent.workspaceId !== workspace.id) continue;
      if (isMainChatAgent(agent)) hasMainChatAgent = true;
      else hasNonMainAgent = true;
    }
  }
  if (hasMainChatAgent && !hasNonMainAgent) return true;
  const base = directoryBasename(candidatePath);
  return base === MAIN_CHAT_WORKSPACE_DIR_NAME && hasMainChatAgent;
}

export function findMainChatAgentOnHost(
  session: SessionStoreState["sessions"][string] | undefined,
  serverId: string,
): MainChatAgentRef | null {
  if (!session) return null;
  let best: Agent | null = null;
  for (const agent of session.agents.values()) {
    if (agent.archivedAt || agent.background || !isMainChatAgent(agent)) continue;
    if (!best || agent.updatedAt.getTime() > best.updatedAt.getTime()) {
      best = agent;
    }
  }
  if (!best?.workspaceId) return null;
  return { serverId, workspaceId: best.workspaceId, agentId: best.id };
}

function resolveOrderedServerIds(
  state: SessionStoreState,
  preferredServerId: string | null,
): string[] {
  const serverIds = Object.keys(state.sessions);
  if (!preferredServerId || !state.sessions[preferredServerId]) return serverIds;
  return [preferredServerId, ...serverIds.filter((id) => id !== preferredServerId)];
}

function resolveTargetMainChatHost(
  state: SessionStoreState,
  orderedIds: readonly string[],
): { existing: MainChatAgentRef | null; targetServerId: string | null } {
  let existing: MainChatAgentRef | null = null;
  let capableServerId: string | null = null;
  let firstConnectedServerId: string | null = null;

  for (const serverId of orderedIds) {
    const session = state.sessions[serverId];
    if (!session) continue;
    if (!existing) existing = findMainChatAgentOnHost(session, serverId);
    if (!session.client) continue;
    if (!firstConnectedServerId) firstConnectedServerId = serverId;
    if (!capableServerId && session.serverInfo?.features?.mainChat === true) {
      capableServerId = serverId;
    }
  }

  return {
    existing,
    targetServerId: existing?.serverId ?? capableServerId ?? firstConnectedServerId,
  };
}

function summarizeFleetActivity(
  state: SessionStoreState,
  mainRef: MainChatAgentRef | null,
): {
  isMainRunning: boolean;
  needsYouCount: number;
  runningCount: number;
  attentionCount: number;
  totalActiveCount: number;
} {
  let isMainRunning = false;
  let runningCount = 0;
  let attentionCount = 0;
  let totalActiveCount = 0;
  const activeAgentIds = new Set<string>();
  const needsYouAgentIds = new Set<string>();

  for (const [serverId, session] of Object.entries(state.sessions)) {
    for (const agent of session.agents.values()) {
      if (agent.archivedAt || agent.background) continue;
      const running =
        agent.turn.phase === "open" ||
        isAgentRunning({ status: agent.status, backgroundWork: agent.backgroundWork });

      if (isMainChatAgent(agent)) {
        if (mainRef && serverId === mainRef.serverId && agent.id === mainRef.agentId) {
          isMainRunning = running;
        }
        activeAgentIds.add(agent.id);
        continue;
      }

      totalActiveCount += 1;
      activeAgentIds.add(agent.id);
      if (agent.pendingPermissions.length > 0 || agent.attentionReason === "permission") {
        needsYouAgentIds.add(agent.id);
      } else if (running) {
        runningCount += 1;
      } else if (agent.requiresAttention || agent.status === "error") {
        attentionCount += 1;
      }
    }

    for (const perm of session.pendingPermissions.values()) {
      if (activeAgentIds.has(perm.agentId)) {
        needsYouAgentIds.add(perm.agentId);
      }
    }
  }

  return {
    isMainRunning,
    needsYouCount: needsYouAgentIds.size,
    runningCount,
    attentionCount,
    totalActiveCount,
  };
}

export function selectMainChatSidebarSummary(
  state: SessionStoreState,
  preferredServerId: string | null,
  configuredTitle?: string | null,
): MainChatSidebarSummary {
  const orderedIds = resolveOrderedServerIds(state, preferredServerId);
  const { existing, targetServerId } = resolveTargetMainChatHost(state, orderedIds);
  const targetSession = targetServerId ? state.sessions[targetServerId] : undefined;
  const supportsMainChat =
    existing !== null || targetSession?.serverInfo?.features?.mainChat === true;

  const existingAgent = existing
    ? (state.sessions[existing.serverId]?.agents.get(existing.agentId) ??
      state.sessions[existing.serverId]?.agentDetails.get(existing.agentId))
    : undefined;
  const displayTitle =
    configuredTitle?.trim() || existingAgent?.title?.trim() || MAIN_CHAT_DEFAULT_TITLE;
  const hostLabel = targetSession?.serverInfo?.hostname?.trim() || null;

  const activity = summarizeFleetActivity(state, existing);

  return {
    existing,
    targetServerId,
    supportsMainChat,
    displayTitle,
    hostLabel,
    isMainRunning: activity.isMainRunning,
    needsYouCount: activity.needsYouCount,
    runningCount: activity.runningCount,
    attentionCount: activity.attentionCount,
    totalActiveCount: activity.totalActiveCount,
  };
}

export function selectMainChatPendingPermissions(
  state: SessionStoreState,
  serverId: string,
  agentId: string,
): MainChatPendingPermissionItem[] {
  const session = state.sessions[serverId];
  if (!session) return [];
  const currentAgent = session.agents.get(agentId) ?? session.agentDetails.get(agentId);
  const isMain = isMainChatAgent(currentAgent);

  const items: MainChatPendingPermissionItem[] = [];
  for (const perm of session.pendingPermissions.values()) {
    if (perm.agentId === agentId) {
      items.push({
        permission: perm,
        isChild: false,
        sourceAgentId: agentId,
        sourceAgentTitle: currentAgent?.title?.trim() || agentId,
      });
      continue;
    }
    if (!isMain) continue;
    const child = session.agents.get(perm.agentId) ?? session.agentDetails.get(perm.agentId);
    if (!child || child.archivedAt || child.background) continue;
    const parent = getParentAddressFromLabels(child.labels, serverId);
    if (parent?.serverId === serverId && parent.agentId === agentId) {
      items.push({
        permission: perm,
        isChild: true,
        sourceAgentId: child.id,
        sourceAgentTitle: child.title?.trim() || child.id,
      });
    }
  }
  return items;
}

const BUCKET_PRIORITY: Record<SidebarStateBucket, number> = {
  needs_input: 0,
  failed: 1,
  running: 2,
  attention: 3,
  done: 4,
};

export function derivePlanTaskLiveBucket(
  agent: Agent | undefined,
  pendingPermissionCount: number,
): SidebarStateBucket | null {
  if (!agent) return null;
  if (pendingPermissionCount > 0 || agent.attentionReason === "permission") return "needs_input";
  if (agent.status === "error") return "failed";
  if (
    agent.turn.phase === "open" ||
    isAgentRunning({ status: agent.status, backgroundWork: agent.backgroundWork })
  ) {
    return "running";
  }
  if (agent.requiresAttention) return "attention";
  return "done";
}

function toDockTaskItem(
  hostId: string,
  agent: Agent,
  pendingPermissionCount: number,
  managedByMainChat: boolean,
): MainChatDockTaskItem {
  const meta = getMainChatTaskMetaFromLabels(agent.labels);
  const bucket = derivePlanTaskLiveBucket(agent, pendingPermissionCount) ?? "done";
  return {
    serverId: hostId,
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? null,
    title: agent.title?.trim() || meta?.goal || directoryBasename(agent.cwd) || agent.id,
    mode: meta?.mode ?? null,
    managedByMainChat,
    bucket,
    pendingPermissionCount,
    updatedAtMs: agent.updatedAt.getTime(),
  };
}

/**
 * Returns tasks dispatched from this main chat FIRST, followed by manually started working,
 * waiting, failed, or unread-attention sessions across connected hosts (mirroring Persona's
 * unified dock).
 */
export function selectMainChatDockTasks(
  state: SessionStoreState,
  serverId: string,
  mainAgentId: string,
): MainChatDockTaskItem[] {
  const session = state.sessions[serverId];
  if (!session) return [];
  const currentAgent = session.agents.get(mainAgentId) ?? session.agentDetails.get(mainAgentId);
  if (!isMainChatAgent(currentAgent)) return [];

  const pendingByHostAndAgent = new Map<string, number>();
  for (const [hostId, hostSession] of Object.entries(state.sessions)) {
    for (const perm of hostSession.pendingPermissions.values()) {
      const key = `${hostId}:${perm.agentId}`;
      pendingByHostAndAgent.set(key, (pendingByHostAndAgent.get(key) ?? 0) + 1);
    }
  }

  const managedTasks: MainChatDockTaskItem[] = [];
  const manualTasks: MainChatDockTaskItem[] = [];

  for (const [hostId, hostSession] of Object.entries(state.sessions)) {
    for (const agent of hostSession.agents.values()) {
      if (agent.archivedAt || agent.background || isMainChatAgent(agent)) continue;
      const parent = getParentAddressFromLabels(agent.labels, hostId);
      const isManaged = parent?.serverId === serverId && parent.agentId === mainAgentId;
      const pendingCount =
        pendingByHostAndAgent.get(`${hostId}:${agent.id}`) ?? agent.pendingPermissions.length;
      const item = toDockTaskItem(hostId, agent, pendingCount, isManaged);
      if (isManaged) {
        managedTasks.push(item);
      } else if (item.bucket !== "done") {
        manualTasks.push(item);
      }
    }
  }

  const sortByBucketThenRecency = (left: MainChatDockTaskItem, right: MainChatDockTaskItem) => {
    const priorityDiff = BUCKET_PRIORITY[left.bucket] - BUCKET_PRIORITY[right.bucket];
    if (priorityDiff !== 0) return priorityDiff;
    return right.updatedAtMs - left.updatedAtMs;
  };

  managedTasks.sort(sortByBucketThenRecency);
  manualTasks.sort(sortByBucketThenRecency);
  return [...managedTasks, ...manualTasks];
}
