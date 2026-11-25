import type { AgentAddress } from "@getpaseo/protocol/addresses";
import {
  getForkedFromAddressFromLabels,
  getForkModeFromLabels,
  getForkRootAgentIdFromLabels,
  type AgentForkMode,
} from "@getpaseo/protocol/agent-labels";
import equal from "fast-deep-equal";
import { useMemo } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { usePendingArchiveAgentKeys } from "@/hooks/use-archive-agent";
import { useSessionStore, type Agent } from "@/stores/session-store";

export interface BranchRow {
  address: AgentAddress;
  id: Agent["id"];
  provider: Agent["provider"];
  title: Agent["title"];
  workspaceId: Agent["workspaceId"];
  status: Agent["status"];
  backgroundWork?: Agent["backgroundWork"];
  turn: Agent["turn"];
  requiresAttention: Agent["requiresAttention"];
  createdAt: Agent["createdAt"];
  forkedFromAgentId: string | null;
  forkMode: AgentForkMode | null;
  depth: number;
  isRoot: boolean;
  isCurrent: boolean;
}

type SessionStoreSnapshot = ReturnType<typeof useSessionStore.getState>;

interface SelectBranchesParams {
  serverId: string;
  agentId: string;
}

const EMPTY_BRANCH_ROWS: BranchRow[] = [];
const MAX_VISUAL_DEPTH = 3;

function resolveAgentByKey(
  agentsByKey: ReadonlyMap<string, Agent>,
  serverId: string,
  agentId: string,
): Agent | null {
  return agentsByKey.get(`${serverId}:${agentId}`) ?? null;
}

function resolveBranchRootKey(agent: Agent, agentsByKey: ReadonlyMap<string, Agent>): string {
  const explicitRoot = getForkRootAgentIdFromLabels(agent.labels);
  if (explicitRoot) {
    const source = getForkedFromAddressFromLabels(agent.labels, agent.serverId);
    const rootServerId = source?.serverId ?? agent.serverId;
    return `${rootServerId}:${explicitRoot}`;
  }

  let currentServerId = agent.serverId;
  let currentAgentId = agent.id;
  const visited = new Set<string>([`${currentServerId}:${currentAgentId}`]);

  while (true) {
    const current = resolveAgentByKey(agentsByKey, currentServerId, currentAgentId);
    const forkedFrom = current
      ? getForkedFromAddressFromLabels(current.labels, current.serverId)
      : null;
    if (!forkedFrom) {
      return `${currentServerId}:${currentAgentId}`;
    }
    const nextKey = `${forkedFrom.serverId}:${forkedFrom.agentId}`;
    if (visited.has(nextKey)) {
      return `${currentServerId}:${currentAgentId}`;
    }
    visited.add(nextKey);
    currentServerId = forkedFrom.serverId;
    currentAgentId = forkedFrom.agentId;
  }
}

function collectBranchAgents(state: SessionStoreSnapshot, pendingArchiveIds: ReadonlySet<string>) {
  const allAgentsByKey = new Map<string, Agent>();
  const activeAgents: Agent[] = [];

  for (const [serverId, session] of Object.entries(state.sessions)) {
    for (const agent of session.agents.values()) {
      const key = `${serverId}:${agent.id}`;
      allAgentsByKey.set(key, agent);
      if (agent.archivedAt || agent.background || pendingArchiveIds.has(key)) {
        continue;
      }
      activeAgents.push(agent);
    }
    for (const detail of session.agentDetails.values()) {
      const key = `${serverId}:${detail.id}`;
      if (!allAgentsByKey.has(key)) {
        allAgentsByKey.set(key, detail);
      }
    }
  }

  return { allAgentsByKey, activeAgents };
}

export function selectBranchesForAgent(
  state: SessionStoreSnapshot,
  params: SelectBranchesParams,
  pendingArchiveIds: ReadonlySet<string>,
): BranchRow[] {
  const { allAgentsByKey, activeAgents } = collectBranchAgents(state, pendingArchiveIds);

  const currentKey = `${params.serverId}:${params.agentId}`;
  const currentAgent = allAgentsByKey.get(currentKey);
  if (!currentAgent) {
    return EMPTY_BRANCH_ROWS;
  }

  const familyRootKey = resolveBranchRootKey(currentAgent, allAgentsByKey);
  const family: Agent[] = [];
  const familyByKey = new Map<string, Agent>();

  for (const candidate of activeAgents) {
    const candidateRootKey = resolveBranchRootKey(candidate, allAgentsByKey);
    if (candidateRootKey !== familyRootKey) {
      continue;
    }
    const key = `${candidate.serverId}:${candidate.id}`;
    family.push(candidate);
    familyByKey.set(key, candidate);
  }

  if (family.length <= 1) {
    return EMPTY_BRANCH_ROWS;
  }

  family.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

  const childrenByParentKey = new Map<string, Agent[]>();
  const topLevel: Agent[] = [];
  const rootPresent = familyByKey.has(familyRootKey);

  for (const member of family) {
    const key = `${member.serverId}:${member.id}`;
    if (key === familyRootKey) {
      topLevel.unshift(member);
      continue;
    }
    const source = getForkedFromAddressFromLabels(member.labels, member.serverId);
    const parentKey = source ? `${source.serverId}:${source.agentId}` : null;
    if (parentKey && parentKey !== key && familyByKey.has(parentKey)) {
      const siblings = childrenByParentKey.get(parentKey) ?? [];
      siblings.push(member);
      childrenByParentKey.set(parentKey, siblings);
    } else if (rootPresent) {
      const siblings = childrenByParentKey.get(familyRootKey) ?? [];
      siblings.push(member);
      childrenByParentKey.set(familyRootKey, siblings);
    } else {
      topLevel.push(member);
    }
  }

  const ordered: BranchRow[] = [];
  const visited = new Set<string>();

  const visit = (agent: Agent, depth: number) => {
    const key = `${agent.serverId}:${agent.id}`;
    if (visited.has(key)) return;
    visited.add(key);

    const source = getForkedFromAddressFromLabels(agent.labels, agent.serverId);
    ordered.push({
      address: { serverId: agent.serverId, agentId: agent.id },
      id: agent.id,
      provider: agent.provider,
      title: agent.title,
      workspaceId: agent.workspaceId,
      status: agent.status,
      backgroundWork: agent.backgroundWork,
      turn: agent.turn,
      requiresAttention: agent.requiresAttention,
      createdAt: agent.createdAt,
      forkedFromAgentId: source?.agentId ?? null,
      forkMode: getForkModeFromLabels(agent.labels),
      depth: Math.min(depth, MAX_VISUAL_DEPTH),
      isRoot: key === familyRootKey,
      isCurrent: key === currentKey,
    });

    const children = childrenByParentKey.get(key) ?? [];
    children.sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
    for (const child of children) {
      visit(child, depth + 1);
    }
  };

  for (const root of topLevel) {
    visit(root, 0);
  }
  for (const member of family) {
    visit(member, rootPresent ? 1 : 0);
  }

  return ordered;
}

// Reuse previous rows across stream ticks when no session's agent map changed.
export function createBranchesForAgentSelector(
  params: SelectBranchesParams,
  pendingArchiveIds: ReadonlySet<string>,
): (state: SessionStoreSnapshot) => BranchRow[] {
  let previousAgents: Array<[string, Map<string, Agent>]> = [];
  let previousRows: BranchRow[] | null = null;

  return (state) => {
    const agents = Object.entries(state.sessions).map(
      ([serverId, session]) => [serverId, session.agents] as [string, Map<string, Agent>],
    );
    if (
      previousRows &&
      agents.length === previousAgents.length &&
      agents.every(
        ([serverId, map], index) =>
          previousAgents[index]?.[0] === serverId && previousAgents[index]?.[1] === map,
      )
    ) {
      return previousRows;
    }

    const rows = selectBranchesForAgent(state, params, pendingArchiveIds);
    previousAgents = agents;
    if (!previousRows || !equal(previousRows, rows)) {
      previousRows = rows;
    }
    return previousRows;
  };
}

export function useBranchesForAgent(params: SelectBranchesParams): BranchRow[] {
  const { serverId, agentId } = params;
  const pendingArchiveIds = usePendingArchiveAgentKeys();
  const selector = useMemo(
    () => createBranchesForAgentSelector({ serverId, agentId }, pendingArchiveIds),
    [serverId, agentId, pendingArchiveIds],
  );
  return useStoreWithEqualityFn(useSessionStore, selector, Object.is);
}
