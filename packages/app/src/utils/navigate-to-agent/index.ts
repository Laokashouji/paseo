import { isMainChatAgent } from "@getpaseo/protocol/main-chat";
import { router, type Href } from "expo-router";
import { queryClient as appQueryClient } from "@/data/query-client";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES,
  type AppSettings,
} from "@/hooks/use-settings/storage";
import { isMainChatDedicatedWorkspace } from "@/main-chat/selectors";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { openWorkspaceChanges } from "@/workspace-tabs/open-supporting-view";
import { resolveNavigateToAgent, type NavigateToAgentInput } from "./resolve";

export type { NavigateToAgentInput } from "./resolve";

export function navigateToAgent(input: NavigateToAgentInput): string {
  return resolveNavigateToAgent(input, {
    readAgentNavTarget: ({ serverId, agentId }) => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      const workspaceCandidateId = agent?.workspaceId ?? input.workspaceId ?? null;
      const workspaceKey = workspaceCandidateId
        ? resolveWorkspaceMapKeyByIdentity({
            workspaces: session?.workspaces,
            workspaceId: workspaceCandidateId,
          })
        : null;
      const workspace = workspaceKey ? session?.workspaces.get(workspaceKey) : undefined;
      return {
        labels: agent?.labels,
        agentWorkspaceId: agent?.workspaceId,
        isMainChatAgent: isMainChatAgent(agent),
        isMainChatWorkspace: workspace
          ? isMainChatDedicatedWorkspace(workspace, session?.agents)
          : false,
      };
    },
    navigateToHostAgent: (route) => {
      router.navigate(route as Href);
    },
    navigateToMainChat: (route) => {
      router.navigate(route as Href);
    },
    navigateToWorkspace,
    openWorkspacePanel: ({ serverId, workspaceId, panel }) => {
      if (panel !== "diff") {
        return;
      }
      const session = useSessionStore.getState().sessions[serverId];
      const resolvedWorkspaceId =
        resolveWorkspaceMapKeyByIdentity({
          workspaces: session?.workspaces,
          workspaceId,
        }) ?? workspaceId;
      const cachedSettings = appQueryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY);
      const preferences =
        input.openInSidePane ??
        cachedSettings?.openInSidePane ??
        DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES;
      const isCompact =
        input.isCompact ?? useWorkspaceLayoutStore.getState().layoutMode !== "split-panes";
      openWorkspaceChanges({
        isCompact,
        workspaceKey: `${serverId}:${resolvedWorkspaceId}`,
        preferences,
      });
    },
  });
}
