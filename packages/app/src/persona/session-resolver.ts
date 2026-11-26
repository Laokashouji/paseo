import type { Agent, SessionState, WorkspaceDescriptor } from "@/stores/session-store";
import {
  normalizeWorkspacePath,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";

export interface PersonaSessionOpenRequest {
  machineId: string;
  sessionId: string;
  workspaceIdHint?: string | null;
  cwdHint?: string | null;
  panel?: "diff" | null;
  source: "link-click" | "header-button" | "changes-panel-button" | "window-open";
  rawHref?: string | null;
}

export type PersonaSessionMatchLevel =
  | "label_persona_session" // Level 1: labels['persona.session']
  | "paseo_prefix_agent_id" // Level 2: paseo-<agentId> 或直传 agentId
  | "provider_thread_id" // Level 3: Claude sessionId / Codex threadId
  | "workspace_fallback"; // Level 4: workspaceId / cwd 回退

export type PersonaSessionResolution =
  | {
      kind: "agent";
      level: Exclude<PersonaSessionMatchLevel, "workspace_fallback">;
      serverId: string;
      agentId: string;
      workspaceId: string | null;
      archived: boolean;
      panel: "diff" | null;
    }
  | {
      kind: "agent_remote_lookup";
      level: "paseo_prefix_agent_id";
      serverId: string;
      agentId: string;
      panel: "diff" | null;
    }
  | {
      kind: "workspace";
      level: "workspace_fallback";
      serverId: string;
      workspaceId: string;
      panel: "diff" | null;
    }
  | {
      kind: "pending_hydration";
      serverId: string;
      reason: "agents_not_hydrated" | "host_connecting";
    }
  | {
      kind: "unresolved";
      reason: "unmapped_machine" | "host_offline" | "not_found";
      machineId: string;
      sessionId: string;
      resolvedServerId: string | null;
    };

export interface PersonaSessionResolverHost {
  serverId: string;
  label: string;
}

export interface PersonaSessionResolverInput {
  request: PersonaSessionOpenRequest;
  machineServerMap: Readonly<Record<string, string>>;
  hosts: readonly PersonaSessionResolverHost[];
  sessions: Readonly<Record<string, SessionState | undefined>>;
  connectionStatusByServerId: Readonly<Record<string, string | undefined>>;
}

export type MachineResolutionSource = "explicit_map" | "hostname" | "label" | "server_id" | "none";

const PERSONA_SESSION_LABEL = "persona.session";
const PASEO_SESSION_PREFIX = "paseo-";
const CLAUDE_ID_PATTERN = /^[0-9a-fA-F-]{8,64}$/;
const CODEX_THREAD_PATTERN = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const WORKSPACE_ID_PATTERN = /^wks_[0-9a-f]{16}$/;

function isKnownServerId(
  serverId: string,
  hosts: readonly PersonaSessionResolverHost[],
  sessions: Readonly<Record<string, SessionState | undefined>>,
): boolean {
  return hosts.some((host) => host.serverId === serverId) || Boolean(sessions[serverId]);
}

export function resolveMachineToServerId(input: {
  machineId: string;
  machineServerMap: Readonly<Record<string, string>>;
  hosts: readonly PersonaSessionResolverHost[];
  sessions: Readonly<Record<string, SessionState | undefined>>;
}): { serverId: string | null; source: MachineResolutionSource } {
  const normalizedMachineId = input.machineId.trim();
  if (!normalizedMachineId) {
    return { serverId: null, source: "none" };
  }

  // 1. Explicit configuration mapping takes highest priority.
  const mappedServerId =
    input.machineServerMap[input.machineId]?.trim() ??
    input.machineServerMap[normalizedMachineId]?.trim() ??
    "";
  if (mappedServerId && isKnownServerId(mappedServerId, input.hosts, input.sessions)) {
    return { serverId: mappedServerId, source: "explicit_map" };
  }

  const lowerMachine = normalizedMachineId.toLowerCase();

  // 2. Hostname match (case-insensitive) via serverInfo.hostname.
  const orderedServerIds: string[] = [];
  const seenServerIds = new Set<string>();
  for (const host of input.hosts) {
    if (!seenServerIds.has(host.serverId)) {
      seenServerIds.add(host.serverId);
      orderedServerIds.push(host.serverId);
    }
  }
  for (const serverId of Object.keys(input.sessions)) {
    if (!seenServerIds.has(serverId)) {
      seenServerIds.add(serverId);
      orderedServerIds.push(serverId);
    }
  }

  for (const serverId of orderedServerIds) {
    const hostname = input.sessions[serverId]?.serverInfo?.hostname?.trim();
    if (hostname && hostname.toLowerCase() === lowerMachine) {
      return { serverId, source: "hostname" };
    }
  }

  // 3. Host label match (case-insensitive).
  const labelMatch = input.hosts.find((host) => host.label.trim().toLowerCase() === lowerMachine);
  if (labelMatch) {
    return { serverId: labelMatch.serverId, source: "label" };
  }

  // 4. Direct serverId match.
  if (isKnownServerId(normalizedMachineId, input.hosts, input.sessions)) {
    return { serverId: normalizedMachineId, source: "server_id" };
  }

  return { serverId: null, source: "none" };
}

function getAgentUpdatedTimestamp(agent: Agent): number {
  const updated = agent.updatedAt instanceof Date ? agent.updatedAt.getTime() : 0;
  if (Number.isFinite(updated) && updated > 0) {
    return updated;
  }
  const active = agent.lastActivityAt instanceof Date ? agent.lastActivityAt.getTime() : 0;
  if (Number.isFinite(active) && active > 0) {
    return active;
  }
  const created = agent.createdAt instanceof Date ? agent.createdAt.getTime() : 0;
  return Number.isFinite(created) ? created : 0;
}

function collectSessionAgents(session: SessionState | undefined): Agent[] {
  if (!session) {
    return [];
  }
  const byId = new Map<string, Agent>();
  const add = (agent: Agent): void => {
    const existing = byId.get(agent.id);
    if (!existing) {
      byId.set(agent.id, agent);
      return;
    }
    // Merge to preserve persistence/runtimeInfo/labels if one map has hydrated detail.
    const existingHasPersistence = existing.persistence !== null;
    const incomingHasPersistence = agent.persistence !== null;
    if (!existingHasPersistence && incomingHasPersistence) {
      byId.set(agent.id, agent);
      return;
    }
    if (existingHasPersistence && !incomingHasPersistence) {
      return;
    }
    if (getAgentUpdatedTimestamp(agent) > getAgentUpdatedTimestamp(existing)) {
      byId.set(agent.id, agent);
    }
  };

  if (session.agents) {
    for (const agent of session.agents.values()) {
      add(agent);
    }
  }
  if (session.agentDetails) {
    for (const agent of session.agentDetails.values()) {
      add(agent);
    }
  }
  return Array.from(byId.values());
}

function pickBestAgent(candidates: readonly Agent[]): Agent | null {
  if (candidates.length === 0) {
    return null;
  }
  const sorted = [...candidates].sort((a, b) => {
    const aArchived = Boolean(a.archivedAt);
    const bArchived = Boolean(b.archivedAt);
    if (aArchived !== bArchived) {
      return aArchived ? 1 : -1;
    }
    return getAgentUpdatedTimestamp(b) - getAgentUpdatedTimestamp(a);
  });
  return sorted[0] ?? null;
}

function readCodexThreadId(agent: Agent): string | null {
  const metadata = agent.persistence?.metadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const threadId = (metadata as { threadId?: unknown }).threadId;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId.trim() : null;
}

function matchLevel1(agents: readonly Agent[], sessionId: string): Agent | null {
  const matches = agents.filter((agent) => agent.labels?.[PERSONA_SESSION_LABEL] === sessionId);
  return pickBestAgent(matches);
}

function matchLevel2(agents: readonly Agent[], sessionId: string): Agent | null {
  const candidateId = sessionId.startsWith(PASEO_SESSION_PREFIX)
    ? sessionId.slice(PASEO_SESSION_PREFIX.length)
    : sessionId;
  if (!candidateId) {
    return null;
  }
  const matches = agents.filter((agent) => agent.id === candidateId);
  return pickBestAgent(matches);
}

function matchLevel3(agents: readonly Agent[], sessionId: string): Agent | null {
  const isClaudeId = CLAUDE_ID_PATTERN.test(sessionId);
  const isCodexThread = CODEX_THREAD_PATTERN.test(sessionId);
  if (!isClaudeId && !isCodexThread) {
    return null;
  }

  const matches = agents.filter((agent) => {
    if (isClaudeId) {
      if (
        agent.persistence?.sessionId === sessionId ||
        agent.runtimeInfo?.sessionId === sessionId
      ) {
        return true;
      }
    }
    if (isCodexThread) {
      if (readCodexThreadId(agent) === sessionId) {
        return true;
      }
    }
    return false;
  });
  return pickBestAgent(matches);
}

function matchLevel4Workspace(
  workspaces: Map<string, WorkspaceDescriptor> | undefined,
  workspaceIdHint: string | null | undefined,
  cwdHint: string | null | undefined,
): WorkspaceDescriptor | null {
  if (!workspaces || workspaces.size === 0) {
    return null;
  }

  const trimmedWorkspaceId = workspaceIdHint?.trim() ?? "";
  if (trimmedWorkspaceId && WORKSPACE_ID_PATTERN.test(trimmedWorkspaceId)) {
    const key = resolveWorkspaceMapKeyByIdentity({
      workspaces,
      workspaceId: trimmedWorkspaceId,
    });
    if (key) {
      const ws = workspaces.get(key);
      if (ws) return ws;
    }
  }

  const normalizedCwd = normalizeWorkspacePath(cwdHint);
  if (normalizedCwd) {
    for (const workspace of workspaces.values()) {
      const wsDir = normalizeWorkspacePath(workspace.workspaceDirectory);
      if (wsDir && wsDir === normalizedCwd) {
        return workspace;
      }
    }
  }

  return null;
}

function toAgentResolution(
  agent: Agent,
  serverId: string,
  level: Exclude<PersonaSessionMatchLevel, "workspace_fallback">,
  panel: "diff" | null,
): Extract<PersonaSessionResolution, { kind: "agent" }> {
  return {
    kind: "agent",
    level,
    serverId,
    agentId: agent.id,
    workspaceId: agent.workspaceId?.trim() || null,
    archived: Boolean(agent.archivedAt),
    panel,
  };
}

function scanSingleHostForAgentOrWorkspace(input: {
  serverId: string;
  session: SessionState | undefined;
  sessionId: string;
  workspaceIdHint?: string | null;
  cwdHint?: string | null;
  panel: "diff" | null;
}): Extract<PersonaSessionResolution, { kind: "agent" | "workspace" }> | null {
  const agents = collectSessionAgents(input.session);

  const l1 = matchLevel1(agents, input.sessionId);
  if (l1) {
    return toAgentResolution(l1, input.serverId, "label_persona_session", input.panel);
  }

  const l2 = matchLevel2(agents, input.sessionId);
  if (l2) {
    return toAgentResolution(l2, input.serverId, "paseo_prefix_agent_id", input.panel);
  }

  const l3 = matchLevel3(agents, input.sessionId);
  if (l3) {
    return toAgentResolution(l3, input.serverId, "provider_thread_id", input.panel);
  }

  const ws = matchLevel4Workspace(input.session?.workspaces, input.workspaceIdHint, input.cwdHint);
  if (ws) {
    return {
      kind: "workspace",
      level: "workspace_fallback",
      serverId: input.serverId,
      workspaceId: ws.id,
      panel: input.panel,
    };
  }

  return null;
}

export function resolvePersonaSession(
  input: PersonaSessionResolverInput,
): PersonaSessionResolution {
  const machineId = input.request.machineId.trim();
  const sessionId = input.request.sessionId.trim();
  const panel = input.request.panel === "diff" ? "diff" : null;

  const machineMatch = resolveMachineToServerId({
    machineId,
    machineServerMap: input.machineServerMap,
    hosts: input.hosts,
    sessions: input.sessions,
  });

  if (!machineMatch.serverId) {
    // Fallback read-only scan across all known hosts for globally unique session/agent IDs.
    const candidateServerIds = Object.keys(input.sessions);
    for (const serverId of candidateServerIds) {
      const hit = scanSingleHostForAgentOrWorkspace({
        serverId,
        session: input.sessions[serverId],
        sessionId,
        workspaceIdHint: input.request.workspaceIdHint,
        cwdHint: input.request.cwdHint,
        panel,
      });
      if (hit) {
        return hit;
      }
    }
    return {
      kind: "unresolved",
      reason: "unmapped_machine",
      machineId,
      sessionId,
      resolvedServerId: null,
    };
  }

  const serverId = machineMatch.serverId;
  const session = input.sessions[serverId];
  const connectionStatus = input.connectionStatusByServerId[serverId];
  const agents = collectSessionAgents(session);

  // Level 1: labels['persona.session']
  const level1Match = matchLevel1(agents, sessionId);
  if (level1Match) {
    return toAgentResolution(level1Match, serverId, "label_persona_session", panel);
  }

  // Level 2: paseo-<agentId> or direct agentId
  const level2Match = matchLevel2(agents, sessionId);
  if (level2Match) {
    return toAgentResolution(level2Match, serverId, "paseo_prefix_agent_id", panel);
  }

  const hasPaseoPrefix = sessionId.startsWith(PASEO_SESSION_PREFIX);
  const paseoCandidateId = hasPaseoPrefix ? sessionId.slice(PASEO_SESSION_PREFIX.length) : "";
  if (hasPaseoPrefix && paseoCandidateId.length > 0) {
    return {
      kind: "agent_remote_lookup",
      level: "paseo_prefix_agent_id",
      serverId,
      agentId: paseoCandidateId,
      panel,
    };
  }

  if (connectionStatus === "offline" || connectionStatus === "error") {
    return {
      kind: "unresolved",
      reason: "host_offline",
      machineId,
      sessionId,
      resolvedServerId: serverId,
    };
  }

  // Level 3: Claude sessionId / Codex threadId
  const level3Match = matchLevel3(agents, sessionId);
  if (level3Match) {
    return toAgentResolution(level3Match, serverId, "provider_thread_id", panel);
  }

  // Cold-start Replica Cache guard: agent.persistence is null until live snapshot hydrates.
  if (connectionStatus === "connecting") {
    return {
      kind: "pending_hydration",
      serverId,
      reason: "host_connecting",
    };
  }

  if (!session?.hasHydratedAgents) {
    return {
      kind: "pending_hydration",
      serverId,
      reason: "agents_not_hydrated",
    };
  }

  // Level 4: Workspace fallback via workspaceIdHint or cwdHint
  const workspaceMatch = matchLevel4Workspace(
    session.workspaces,
    input.request.workspaceIdHint,
    input.request.cwdHint,
  );
  if (workspaceMatch) {
    return {
      kind: "workspace",
      level: "workspace_fallback",
      serverId,
      workspaceId: workspaceMatch.id,
      panel,
    };
  }

  return {
    kind: "unresolved",
    reason: "not_found",
    machineId,
    sessionId,
    resolvedServerId: serverId,
  };
}
