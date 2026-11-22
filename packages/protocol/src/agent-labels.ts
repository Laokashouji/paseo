import type { AgentAddress } from "./addresses.js";
export const PARENT_SERVER_ID_LABEL = "paseo.parent-server-id";
export const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
const OPEN_AGENT_TAB_LABEL_PREFIX = "paseo.open-agent-tab.";

export function getOpenAgentTabLabel(clientId: string): string {
  return `${OPEN_AGENT_TAB_LABEL_PREFIX}${clientId}`;
}

export function isOpenAgentTabLabel(label: string): boolean {
  return label.startsWith(OPEN_AGENT_TAB_LABEL_PREFIX);
}

export interface AgentLabelSource {
  labels?: Record<string, unknown> | null;
}

export function getParentAgentIdFromLabels(labels: Record<string, unknown> | null | undefined) {
  const parentAgentId = labels?.[PARENT_AGENT_ID_LABEL];
  return typeof parentAgentId === "string" && parentAgentId.trim().length > 0
    ? parentAgentId.trim()
    : null;
}

export function isDelegatedAgent(agent: AgentLabelSource): boolean {
  return getParentAgentIdFromLabels(agent.labels) !== null;
}

export function hasOpenAgentTab(labels: Record<string, unknown> | null | undefined): boolean {
  return Object.entries(labels ?? {}).some(
    ([label, value]) => isOpenAgentTabLabel(label) && value === "true",
  );
}

// Absent parent server label means the same host.
export function getParentAddressFromLabels(
  labels: Record<string, unknown> | null | undefined,
  serverId: string,
): AgentAddress | null {
  const agentId = getParentAgentIdFromLabels(labels);
  if (!agentId) return null;
  const parentServerId = labels?.[PARENT_SERVER_ID_LABEL];
  return {
    serverId:
      typeof parentServerId === "string" && parentServerId.trim()
        ? parentServerId.trim()
        : serverId,
    agentId,
  };
}
export function parentAddressLabels(parent: AgentAddress): Record<string, string> {
  return { [PARENT_AGENT_ID_LABEL]: parent.agentId, [PARENT_SERVER_ID_LABEL]: parent.serverId };
}

export const FORKED_FROM_AGENT_ID_LABEL = "paseo.forked-from-agent-id";
export const FORKED_FROM_SERVER_ID_LABEL = "paseo.forked-from-server-id";
export const FORK_ROOT_AGENT_ID_LABEL = "paseo.fork-root-agent-id";
export const FORK_MODE_LABEL = "paseo.fork-mode";

export type AgentForkMode = "native" | "summary";

export function getForkedFromAgentIdFromLabels(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  const sourceId = labels?.[FORKED_FROM_AGENT_ID_LABEL];
  return typeof sourceId === "string" && sourceId.trim().length > 0 ? sourceId.trim() : null;
}

export function getForkedFromAddressFromLabels(
  labels: Record<string, unknown> | null | undefined,
  serverId: string,
): AgentAddress | null {
  const agentId = getForkedFromAgentIdFromLabels(labels);
  if (!agentId) return null;
  const sourceServerId = labels?.[FORKED_FROM_SERVER_ID_LABEL];
  return {
    serverId:
      typeof sourceServerId === "string" && sourceServerId.trim()
        ? sourceServerId.trim()
        : serverId,
    agentId,
  };
}

export function getForkRootAgentIdFromLabels(
  labels: Record<string, unknown> | null | undefined,
): string | null {
  const rootId = labels?.[FORK_ROOT_AGENT_ID_LABEL];
  return typeof rootId === "string" && rootId.trim().length > 0 ? rootId.trim() : null;
}

export function getForkModeFromLabels(
  labels: Record<string, unknown> | null | undefined,
): AgentForkMode | null {
  const mode = labels?.[FORK_MODE_LABEL];
  return mode === "native" || mode === "summary" ? mode : null;
}

export function forkLineageLabels(input: {
  sourceAgentId: string;
  sourceServerId?: string;
  rootAgentId: string;
  mode: AgentForkMode;
}): Record<string, string> {
  return {
    [FORKED_FROM_AGENT_ID_LABEL]: input.sourceAgentId,
    ...(input.sourceServerId?.trim()
      ? { [FORKED_FROM_SERVER_ID_LABEL]: input.sourceServerId.trim() }
      : {}),
    [FORK_ROOT_AGENT_ID_LABEL]: input.rootAgentId,
    [FORK_MODE_LABEL]: input.mode,
  };
}
