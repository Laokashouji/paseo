import { getManagedConversationId, isMainChatLabels } from "@getpaseo/protocol/main-chat";
import {
  buildHostAgentDetailRoute,
  buildMainChatConversationRoute,
  buildMainChatRoute,
  type WorkspacePanelIntent,
} from "@/utils/host-routes";
import type { OpenInSidePanePreferences } from "@/hooks/use-settings/storage";
import { normalizeWorkspaceOpaqueId } from "@/utils/workspace-identity";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

export interface NavigateToAgentInput {
  serverId: string;
  agentId: string;
  // Used as the workspace target when the agent is not yet in the session store
  // (cold deep-links). Otherwise the workspace is read from the store.
  workspaceId?: string | null;
  labels?: Record<string, unknown>;
  pin?: boolean;
  /** Opens the agent with its composer, where a compact layout would show a sheet without one. */
  asTab?: boolean;
  /** Optional supporting workspace panel to open alongside the agent (e.g. "diff"). */
  panel?: WorkspacePanelIntent | null;
  isCompact?: boolean;
  openInSidePane?: OpenInSidePanePreferences;
}

export interface AgentNavTarget {
  labels?: Record<string, unknown> | null;
  agentWorkspaceId: string | null | undefined;
  isMainChatAgent?: boolean;
  isMainChatWorkspace?: boolean;
}

export interface NavigateToAgentDeps {
  readAgentNavTarget: (input: { serverId: string; agentId: string }) => AgentNavTarget;
  navigateToHostAgent: (route: string) => void;
  navigateToWorkspace: (input: NavigateToWorkspaceInput) => string;
  navigateToMainChat?: (route: string) => void;
  openWorkspacePanel?: (input: {
    serverId: string;
    workspaceId: string;
    panel: WorkspacePanelIntent;
  }) => void;
}

export function resolveNavigateToAgent(
  input: NavigateToAgentInput,
  deps: NavigateToAgentDeps,
): string {
  const navTarget = deps.readAgentNavTarget({ serverId: input.serverId, agentId: input.agentId });
  const conversationId = getManagedConversationId(navTarget.labels ?? input.labels);
  if (
    conversationId ||
    isMainChatLabels(input.labels) ||
    navTarget.isMainChatAgent ||
    navTarget.isMainChatWorkspace
  ) {
    const route = conversationId
      ? buildMainChatConversationRoute(conversationId, input.serverId)
      : buildMainChatRoute(input.serverId);
    if (deps.navigateToMainChat) {
      deps.navigateToMainChat(route);
    } else {
      deps.navigateToHostAgent(route);
    }
    return route;
  }

  const agentWorkspaceId = navTarget.agentWorkspaceId ?? input.workspaceId;
  const workspaceId = normalizeWorkspaceOpaqueId(agentWorkspaceId);

  if (!workspaceId) {
    const route = buildHostAgentDetailRoute(
      input.serverId,
      input.agentId,
      undefined,
      input.panel ? { panel: input.panel } : undefined,
    );
    deps.navigateToHostAgent(route);
    return route;
  }

  const route = deps.navigateToWorkspace({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "agent", agentId: input.agentId },
    pin: input.pin,
    asTab: input.asTab,
  });
  if (input.panel) {
    deps.openWorkspacePanel?.({
      serverId: input.serverId,
      workspaceId,
      panel: input.panel,
    });
  }
  return route;
}
