import { isMainChatAgent } from "@getpaseo/protocol/main-chat";
import { router, type Href } from "expo-router";
import { isMainChatDedicatedWorkspace } from "@/main-chat/selectors";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
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
  });
}
