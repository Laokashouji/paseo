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
  | "workspace_fallback"; // Level 4: workspaceId / cwd 回退（仅限已确定主机）

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
      reason: "unmapped_machine" | "ambiguous_machine" | "host_offline" | "not_found";
      machineId: string;
      sessionId: string;
      resolvedServerId: string | null;
      candidateServerIds?: readonly string[];
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
  /** Optional custom-provider -> built-in root map per host, matching Persona `providerRoots`. */
  providerRootsByServerId?: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;
}

export type MachineResolutionSource =
  | "explicit_map"
  | "explicit_map_missing"
  | "hostname"
  | "label"
  | "server_id"
  | "none";

const PERSONA_SESSION_LABEL = "persona.session";
const PASEO_SESSION_PREFIX = "paseo-";
// Patterns aligned with Persona `integrations/paseo/lib/map.js` (SESSION_ID, CLAUDE_ID, CODEX_THREAD).
const PERSONA_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
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

function collectOrderedServerIds(
  hosts: readonly PersonaSessionResolverHost[],
  sessions: Readonly<Record<string, SessionState | undefined>>,
): string[] {
  const orderedServerIds: string[] = [];
  const seenServerIds = new Set<string>();
  for (const host of hosts) {
    if (!seenServerIds.has(host.serverId)) {
      seenServerIds.add(host.serverId);
      orderedServerIds.push(host.serverId);
    }
  }
  for (const serverId of Object.keys(sessions)) {
    if (!seenServerIds.has(serverId)) {
      seenServerIds.add(serverId);
      orderedServerIds.push(serverId);
    }
  }
  return orderedServerIds;
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
  // When an explicit mapping exists for this machineId but its target serverId is missing from
  // hosts/sessions, NEVER downgrade to hostname/label/serverId or cross-host heuristics.
  const mappedServerId =
    input.machineServerMap[input.machineId]?.trim() ??
    input.machineServerMap[normalizedMachineId]?.trim() ??
    "";
  if (mappedServerId) {
    if (isKnownServerId(mappedServerId, input.hosts, input.sessions)) {
      return { serverId: mappedServerId, source: "explicit_map" };
    }
    return { serverId: null, source: "explicit_map_missing" };
  }

  const lowerMachine = normalizedMachineId.toLowerCase();
  const orderedServerIds = collectOrderedServerIds(input.hosts, input.sessions);

  // 2. Hostname match (case-insensitive) via serverInfo.hostname — require uniqueness.
  const hostnameMatches = orderedServerIds.filter((serverId) => {
    const hostname = input.sessions[serverId]?.serverInfo?.hostname?.trim();
    return Boolean(hostname && hostname.toLowerCase() === lowerMachine);
  });
  if (hostnameMatches.length === 1) {
    return { serverId: hostnameMatches[0], source: "hostname" };
  }

  // 3. Host label match (case-insensitive) — require uniqueness.
  const labelMatches = input.hosts.filter(
    (host) => host.label.trim().toLowerCase() === lowerMachine,
  );
  if (labelMatches.length === 1) {
    return { serverId: labelMatches[0].serverId, source: "label" };
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

export function collectSessionAgents(session: SessionState | undefined): Agent[] {
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

/**
 * Mirrors Persona `agentRoot(agent, roots)` (`integrations/paseo/lib/map.js:131`):
 * prefers `persistence.metadata.provider`, then `providerRoots[agent.provider]`, then `agent.provider`.
 */
export function resolveAgentProviderRoot(
  agent: Agent,
  providerRoots?: Readonly<Record<string, string>>,
): string {
  const metadata = agent.persistence?.metadata;
  if (metadata && typeof metadata === "object") {
    const persistedRoot = (metadata as { provider?: unknown }).provider;
    if (typeof persistedRoot === "string" && persistedRoot.length > 0) {
      return persistedRoot;
    }
  }
  const mappedRoot = providerRoots?.[agent.provider];
  if (typeof mappedRoot === "string" && mappedRoot.length > 0) {
    return mappedRoot;
  }
  return typeof agent.provider === "string" ? agent.provider : "";
}

/**
 * Mirrors Persona `claudeId(agent)` + `sessionIdOf` (`integrations/paseo/lib/map.js:228-241`):
 * returns the single canonical Claude session ID (first valid of persistence.sessionId, runtimeInfo.sessionId).
 */
export function resolveCanonicalClaudeSessionId(agent: Agent): string | null {
  for (const candidate of [agent.persistence?.sessionId, agent.runtimeInfo?.sessionId]) {
    if (typeof candidate === "string" && CLAUDE_ID_PATTERN.test(candidate)) {
      return PERSONA_SESSION_ID_PATTERN.test(candidate) ? candidate : null;
    }
  }
  return null;
}

/**
 * Mirrors Persona `codexThreadOf(agent, roots)` (`integrations/paseo/lib/map.js:258-265`):
 * returns the single canonical Codex thread ID (first valid of persistence.metadata.threadId,
 * persistence.sessionId, runtimeInfo.sessionId).
 */
export function resolveCanonicalCodexThreadId(agent: Agent): string | null {
  const metadata = agent.persistence?.metadata;
  const threadId =
    metadata && typeof metadata === "object"
      ? (metadata as { threadId?: unknown }).threadId
      : undefined;
  for (const candidate of [threadId, agent.persistence?.sessionId, agent.runtimeInfo?.sessionId]) {
    if (typeof candidate === "string" && CODEX_THREAD_PATTERN.test(candidate)) {
      return candidate;
    }
  }
  return null;
}

function matchLevel1(agents: readonly Agent[], sessionId: string): Agent | null {
  if (!PERSONA_SESSION_ID_PATTERN.test(sessionId)) {
    return null;
  }
  const matches = agents.filter((agent) => {
    const label = agent.labels?.[PERSONA_SESSION_LABEL];
    return (
      typeof label === "string" && PERSONA_SESSION_ID_PATTERN.test(label) && label === sessionId
    );
  });
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

function matchLevel3(
  agents: readonly Agent[],
  sessionId: string,
  providerRoots?: Readonly<Record<string, string>>,
): Agent | null {
  const matches = agents.filter((agent) => {
    const root = resolveAgentProviderRoot(agent, providerRoots);
    if (root === "claude") {
      return resolveCanonicalClaudeSessionId(agent) === sessionId;
    }
    if (root === "codex") {
      return resolveCanonicalCodexThreadId(agent) === sessionId;
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

interface CrossHostAgentCandidate {
  serverId: string;
  agent: Agent;
}

/**
 * Unmapped machine resolution: compare match levels globally across all hosts (L1 -> L2 -> L3)
 * and require a unique host at the winning level. Level-4 workspace fallback is NEVER used when
 * the target host is unknown.
 */
function resolveAcrossUnmappedHosts(input: {
  machineId: string;
  sessionId: string;
  panel: "diff" | null;
  hosts: readonly PersonaSessionResolverHost[];
  sessions: Readonly<Record<string, SessionState | undefined>>;
  providerRootsByServerId?: Readonly<Record<string, Readonly<Record<string, string>> | undefined>>;
}): PersonaSessionResolution {
  const candidateServerIds = collectOrderedServerIds(input.hosts, input.sessions);
  const agentsByServerId = new Map<string, Agent[]>();
  for (const serverId of candidateServerIds) {
    agentsByServerId.set(serverId, collectSessionAgents(input.sessions[serverId]));
  }

  const tiers: Array<{
    level: Exclude<PersonaSessionMatchLevel, "workspace_fallback">;
    match: (agents: readonly Agent[], serverId: string) => Agent | null;
  }> = [
    {
      level: "label_persona_session",
      match: (agents) => matchLevel1(agents, input.sessionId),
    },
    {
      level: "paseo_prefix_agent_id",
      match: (agents) => matchLevel2(agents, input.sessionId),
    },
    {
      level: "provider_thread_id",
      match: (agents, serverId) =>
        matchLevel3(agents, input.sessionId, input.providerRootsByServerId?.[serverId]),
    },
  ];

  for (const tier of tiers) {
    const hits: CrossHostAgentCandidate[] = [];
    for (const serverId of candidateServerIds) {
      const matched = tier.match(agentsByServerId.get(serverId) ?? [], serverId);
      if (matched) {
        hits.push({ serverId, agent: matched });
      }
    }
    if (hits.length === 1) {
      return toAgentResolution(hits[0].agent, hits[0].serverId, tier.level, input.panel);
    }
    if (hits.length > 1) {
      return {
        kind: "unresolved",
        reason: "ambiguous_machine",
        machineId: input.machineId,
        sessionId: input.sessionId,
        resolvedServerId: null,
        candidateServerIds: hits.map((hit) => hit.serverId),
      };
    }
  }

  return {
    kind: "unresolved",
    reason: "unmapped_machine",
    machineId: input.machineId,
    sessionId: input.sessionId,
    resolvedServerId: null,
  };
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

  if (machineMatch.source === "explicit_map_missing") {
    return {
      kind: "unresolved",
      reason: "unmapped_machine",
      machineId,
      sessionId,
      resolvedServerId: null,
    };
  }

  if (!machineMatch.serverId) {
    return resolveAcrossUnmappedHosts({
      machineId,
      sessionId,
      panel,
      hosts: input.hosts,
      sessions: input.sessions,
      providerRootsByServerId: input.providerRootsByServerId,
    });
  }

  const serverId = machineMatch.serverId;
  const session = input.sessions[serverId];
  const connectionStatus = input.connectionStatusByServerId[serverId];
  const agents = collectSessionAgents(session);
  const providerRoots = input.providerRootsByServerId?.[serverId];

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

  // Level 3: Canonical Claude sessionId / Codex threadId by actual provider root
  const level3Match = matchLevel3(agents, sessionId, providerRoots);
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

  // Level 4: Workspace fallback via workspaceIdHint or cwdHint (only on a resolved host)
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
