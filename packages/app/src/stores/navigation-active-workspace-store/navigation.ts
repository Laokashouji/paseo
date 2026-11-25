import { isMainChatAgent } from "@getpaseo/protocol/main-chat";
import { isMainChatDedicatedWorkspace } from "@/main-chat/selectors";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import {
  buildHostWorkspaceRoute,
  buildMainChatRoute,
  decodeWorkspaceIdFromPathSegment,
  parseHostWorkspaceRouteFromPathname,
} from "@/utils/host-routes";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";
import { prepareWorkspaceTab, type PrepareWorkspaceTabDeps } from "@/utils/prepare-workspace-tab";
import type { OpenWorkspaceTabInput } from "@/stores/workspace-layout-store";
import type { WorkspaceTabPlacement } from "@/stores/workspace-layout-actions";

export interface RouteSelectionInput {
  pathname: string;
  params: {
    serverId?: string | string[];
    workspaceId?: string | string[];
  };
}

export interface NavigateToWorkspaceInput {
  serverId: string;
  workspaceId: string;
  target?: WorkspaceTabTarget;
  surface?: "sidebar";
  pin?: boolean;
  placement?: WorkspaceTabPlacement;
  asTab?: boolean;
}

export interface NavigateToWorkspaceDeps extends PrepareWorkspaceTabDeps {
  getSessionWorkspaces: (serverId: string) => Map<string, WorkspaceDescriptor> | null | undefined;
  getSessionAgents?: (serverId: string) => ReadonlyMap<string, Agent> | null | undefined;
  getSessionAgent?: (serverId: string, agentId: string) => Agent | null | undefined;
  isWorkspaceLayoutHydrated: () => boolean;
  deferOpenTab: (input: OpenWorkspaceTabInput) => null;
  rememberLastWorkspace: (selection: ActiveWorkspaceSelection) => void;
  navigateToRoute: (route: string) => void;
  navigateToMainChat?: (route: string) => void;
  revealTab: (workspaceKey: string, tabId: string | null) => void;
  revealWorkspace: (workspaceKey: string, surface?: "sidebar") => void;
}

export interface NavigateToLastWorkspaceDeps extends NavigateToWorkspaceDeps {
  getLastWorkspaceSelection: () => ActiveWorkspaceSelection | null;
}

function getParamValue(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const firstValue = value[0];
    return typeof firstValue === "string" ? firstValue.trim() : "";
  }
  return "";
}

function parseWorkspaceSelectionFromRouteParams(params: {
  serverId?: string | string[];
  workspaceId?: string | string[];
}): ActiveWorkspaceSelection | null {
  const serverId = getParamValue(params.serverId);
  const workspaceValue = getParamValue(params.workspaceId);
  const workspaceId = workspaceValue ? decodeWorkspaceIdFromPathSegment(workspaceValue) : null;
  if (!serverId || !workspaceId) {
    return null;
  }
  return { serverId, workspaceId };
}

export function parseActiveWorkspaceSelection(
  input: RouteSelectionInput,
): ActiveWorkspaceSelection | null {
  const routeSelection = parseHostWorkspaceRouteFromPathname(input.pathname);
  if (routeSelection) {
    return routeSelection;
  }

  if (input.pathname !== "/" && input.pathname !== "") {
    return null;
  }

  return parseWorkspaceSelectionFromRouteParams(input.params);
}

export function navigateToWorkspace(
  input: NavigateToWorkspaceInput,
  deps: NavigateToWorkspaceDeps,
): string {
  const workspaces = deps.getSessionWorkspaces(input.serverId);
  const resolvedWorkspaceId = resolveWorkspaceMapKeyByIdentity({
    workspaces,
    workspaceId: input.workspaceId,
  });
  const agents = deps.getSessionAgents?.(input.serverId) ?? undefined;
  const workspace = resolvedWorkspaceId ? workspaces?.get(resolvedWorkspaceId) : undefined;
  const targetAgent =
    input.target?.kind === "agent"
      ? (deps.getSessionAgent?.(input.serverId, input.target.agentId) ??
        agents?.get(input.target.agentId))
      : undefined;
  if (
    isMainChatAgent(targetAgent) ||
    (workspace !== undefined && isMainChatDedicatedWorkspace(workspace, agents))
  ) {
    const mainRoute = buildMainChatRoute(input.serverId);
    (deps.navigateToMainChat ?? deps.navigateToRoute)(mainRoute);
    return mainRoute;
  }

  const shouldDeferOpen = !resolvedWorkspaceId || !deps.isWorkspaceLayoutHydrated();
  const openTab: NavigateToWorkspaceDeps["openTab"] = (request) => {
    if (shouldDeferOpen) return deps.deferOpenTab(request);
    const tabId = deps.openTab(request);
    deps.revealTab(request.workspaceKey, tabId);
    return tabId;
  };
  if (input.target) {
    prepareWorkspaceTab({ ...input, target: input.target }, { openTab });
  } else {
    deps.revealWorkspace(
      `${input.serverId}:${resolvedWorkspaceId ?? input.workspaceId}`,
      input.surface,
    );
  }

  const route = buildHostWorkspaceRoute(input.serverId, input.workspaceId);
  deps.rememberLastWorkspace({ serverId: input.serverId, workspaceId: input.workspaceId });
  deps.navigateToRoute(route);
  return route;
}

export function navigateToLastWorkspace(deps: NavigateToLastWorkspaceDeps): boolean {
  const selection = deps.getLastWorkspaceSelection();
  if (!selection) {
    return false;
  }
  navigateToWorkspace(selection, deps);
  return true;
}
