import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
import {
  MAIN_CHAT_WORKSPACE_DIR_NAME,
  getMainChatTaskMetaFromLabels,
  isMainChatAgent,
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
  needsYouCount: number;
  runningCount: number;
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
 * Identifies the dedicated workspace that backs the pinned Main Chat sidebar item so it does not
 * appear a second time under the regular project list.
 */
export function isMainChatDedicatedWorkspace(
  workspace: Pick<WorkspaceDescriptor, "id" | "workspaceDirectory" | "projectRootPath">,
  agents: ReadonlyMap<string, Agent> | undefined,
): boolean {
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
  const base = directoryBasename(workspace.workspaceDirectory || workspace.projectRootPath);
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

function countMainChatFamilyActivity(
  state: SessionStoreState,
  mainRef: MainChatAgentRef,
): { needsYouCount: number; runningCount: number } {
  const familyAgentIds = new Set<string>([mainRef.agentId]);
  let runningCount = 0;

  for (const [serverId, session] of Object.entries(state.sessions)) {
    for (const agent of session.agents.values()) {
      if (agent.archivedAt || agent.background) continue;
      const parent = getParentAddressFromLabels(agent.labels, serverId);
      if (parent?.serverId !== mainRef.serverId || parent.agentId !== mainRef.agentId) continue;
      familyAgentIds.add(agent.id);
      const running =
        agent.turn.phase === "open" ||
        isAgentRunning({ status: agent.status, backgroundWork: agent.backgroundWork });
      if (running) runningCount += 1;
    }
  }

  let needsYouCount = 0;
  for (const session of Object.values(state.sessions)) {
    for (const perm of session.pendingPermissions.values()) {
      if (familyAgentIds.has(perm.agentId)) needsYouCount += 1;
    }
  }

  return { needsYouCount, runningCount };
}

export function selectMainChatSidebarSummary(
  state: SessionStoreState,
  preferredServerId: string | null,
): MainChatSidebarSummary {
  const orderedIds = resolveOrderedServerIds(state, preferredServerId);
  const { existing, targetServerId } = resolveTargetMainChatHost(state, orderedIds);
  const targetSession = targetServerId ? state.sessions[targetServerId] : undefined;
  const supportsMainChat =
    existing !== null || targetSession?.serverInfo?.features?.mainChat === true;

  if (!existing) {
    return {
      existing: null,
      targetServerId,
      supportsMainChat,
      needsYouCount: 0,
      runningCount: 0,
    };
  }

  const activity = countMainChatFamilyActivity(state, existing);
  return {
    existing,
    targetServerId,
    supportsMainChat,
    needsYouCount: activity.needsYouCount,
    runningCount: activity.runningCount,
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
): MainChatDockTaskItem {
  const meta = getMainChatTaskMetaFromLabels(agent.labels);
  const bucket = derivePlanTaskLiveBucket(agent, pendingPermissionCount) ?? "done";
  return {
    serverId: hostId,
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? null,
    title: agent.title?.trim() || meta?.goal || agent.id,
    mode: meta?.mode ?? null,
    bucket,
    pendingPermissionCount,
    updatedAtMs: agent.updatedAt.getTime(),
  };
}

export function selectMainChatDockTasks(
  state: SessionStoreState,
  serverId: string,
  mainAgentId: string,
): MainChatDockTaskItem[] {
  const session = state.sessions[serverId];
  if (!session) return [];
  const currentAgent = session.agents.get(mainAgentId) ?? session.agentDetails.get(mainAgentId);
  if (!isMainChatAgent(currentAgent)) return [];

  const pendingCounts = new Map<string, number>();
  for (const perm of session.pendingPermissions.values()) {
    pendingCounts.set(perm.agentId, (pendingCounts.get(perm.agentId) ?? 0) + 1);
  }

  const tasks: MainChatDockTaskItem[] = [];
  for (const [hostId, hostSession] of Object.entries(state.sessions)) {
    for (const agent of hostSession.agents.values()) {
      if (agent.archivedAt || agent.background) continue;
      const parent = getParentAddressFromLabels(agent.labels, hostId);
      if (parent?.serverId !== serverId || parent.agentId !== mainAgentId) continue;
      const pendingCount =
        hostId === serverId
          ? (pendingCounts.get(agent.id) ?? agent.pendingPermissions.length)
          : agent.pendingPermissions.length;
      tasks.push(toDockTaskItem(hostId, agent, pendingCount));
    }
  }

  tasks.sort((left, right) => {
    const priorityDiff = BUCKET_PRIORITY[left.bucket] - BUCKET_PRIORITY[right.bucket];
    if (priorityDiff !== 0) return priorityDiff;
    return right.updatedAtMs - left.updatedAtMs;
  });
  return tasks;
}
