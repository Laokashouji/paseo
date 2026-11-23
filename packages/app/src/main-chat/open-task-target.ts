import { MAIN_CHAT_DEFAULT_TITLE } from "@getpaseo/protocol/main-chat";
import { usePathname } from "expo-router";
import { useCallback } from "react";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useSessionStore } from "@/stores/session-store";
import { buildMainChatRoute, isMainChatPathname } from "@/utils/host-routes";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { useMainChatCameFromStore } from "./came-from-store";
import { useMainChatDrawerStore } from "./drawer-store";
import { useMainChatShellContext } from "./shell-context";

export interface OpenMainChatTaskTargetInput {
  serverId: string;
  agentId: string;
  workspaceId?: string | null;
  title?: string | null;
  isCompact: boolean;
  forceFullPage?: boolean;
  inMainChatRoute?: boolean;
  originRoute?: string;
  originTitle?: string;
}

export type OpenMainChatTaskResult = "drawer" | "full-page";

function resolveAgentSummary(
  serverId: string,
  agentId: string,
): {
  workspaceId: string | null;
  title: string | null;
} {
  const session = useSessionStore.getState().sessions[serverId];
  const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
  return {
    workspaceId: agent?.workspaceId?.trim() || null,
    title: agent?.title?.trim() || null,
  };
}

/**
 * Unified task/sub-agent opener for Main Chat surfaces:
 * - On non-compact wide screens inside `/main`, opens the side-by-side right `TaskPanelDrawer`.
 * - On compact screens or when `forceFullPage` is set, navigates full-page to the target
 *   workspace/agent and records `Came from` state so the user can return losslessly.
 */
export function openMainChatTaskTarget(input: OpenMainChatTaskTargetInput): OpenMainChatTaskResult {
  const serverId = input.serverId.trim();
  const agentId = input.agentId.trim();
  const resolved = resolveAgentSummary(serverId, agentId);
  const workspaceId = input.workspaceId?.trim() || resolved.workspaceId;
  const title = input.title?.trim() || resolved.title;
  const inMainChatRoute = input.inMainChatRoute ?? true;

  if (!input.isCompact && !input.forceFullPage && inMainChatRoute) {
    useMainChatDrawerStore.getState().openTask({
      serverId,
      agentId,
      workspaceId,
      title,
    });
    return "drawer";
  }

  if (inMainChatRoute) {
    useMainChatCameFromStore.getState().setCameFrom({
      originRoute: input.originRoute?.trim() || buildMainChatRoute(),
      originTitle: input.originTitle?.trim() || MAIN_CHAT_DEFAULT_TITLE,
      targetServerId: serverId,
      targetWorkspaceId: workspaceId,
      targetAgentId: agentId,
    });
  }

  if (input.forceFullPage) {
    useMainChatDrawerStore.getState().closeDrawer();
  }

  navigateToAgent({
    serverId,
    agentId,
    workspaceId: workspaceId ?? undefined,
  });
  return "full-page";
}

export function useOpenMainChatTaskTarget() {
  const isCompact = useIsCompactFormFactor();
  const pathname = usePathname();
  const shellContext = useMainChatShellContext();

  return useCallback(
    (input: {
      serverId: string;
      agentId: string;
      workspaceId?: string | null;
      title?: string | null;
      forceFullPage?: boolean;
    }): OpenMainChatTaskResult => {
      const inMainChatRoute = shellContext.inMainChatShell || isMainChatPathname(pathname);
      return openMainChatTaskTarget({
        serverId: input.serverId,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        title: input.title,
        isCompact,
        forceFullPage: input.forceFullPage,
        inMainChatRoute,
        originRoute: shellContext.originRoute || buildMainChatRoute(),
        originTitle: shellContext.originTitle || MAIN_CHAT_DEFAULT_TITLE,
      });
    },
    [
      isCompact,
      pathname,
      shellContext.inMainChatShell,
      shellContext.originRoute,
      shellContext.originTitle,
    ],
  );
}
