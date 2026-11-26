import { router, type Href } from "expo-router";
import { createElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ToastApi } from "@/components/toast-host";
import { Button } from "@/components/ui/button";
import { queryClient as appQueryClient } from "@/data/query-client";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES,
  type AppSettings,
  type OpenInSidePanePreferences,
} from "@/hooks/use-settings/storage";
import { i18n } from "@/i18n/i18next";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  buildHostAgentDetailRoute,
  buildSettingsSectionRoute,
  type WorkspacePanelIntent,
} from "@/utils/host-routes";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import { openWorkspaceChanges } from "@/workspace-tabs/open-supporting-view";
import {
  resolvePersonaSession,
  type PersonaSessionOpenRequest,
  type PersonaSessionResolution,
  type PersonaSessionResolverHost,
} from "./session-resolver";
import { readPersonaEmbedSettingsSnapshot } from "./use-persona-settings";

const HYDRATION_WAIT_TIMEOUT_MS = 3_000;

export interface OpenPersonaSessionDeps {
  getMachineServerMap: () => Readonly<Record<string, string>>;
  getHosts: () => readonly PersonaSessionResolverHost[];
  getSessions: () => Readonly<Record<string, SessionState | undefined>>;
  getConnectionStatusByServerId: () => Readonly<Record<string, string | undefined>>;
  getOpenInSidePanePreferences: () => OpenInSidePanePreferences;
  getIsCompact: () => boolean;
  waitForHostHydration: (serverId: string, timeoutMs: number) => Promise<void>;
  fetchRemoteAgent?: (
    serverId: string,
    agentId: string,
  ) => Promise<{ workspaceId?: string | null; labels?: Record<string, unknown> } | null>;
  navigateToAgent: (input: {
    serverId: string;
    agentId: string;
    workspaceId?: string | null;
    labels?: Record<string, unknown>;
    pin?: boolean;
    panel?: WorkspacePanelIntent | null;
    isCompact?: boolean;
    openInSidePane?: OpenInSidePanePreferences;
  }) => string;
  navigateToWorkspace: (input: {
    serverId: string;
    workspaceId: string;
    target?: { kind: "working_diff" };
  }) => string;
  navigateToRoute: (route: string) => void;
  openWorkspaceChanges: (input: {
    isCompact: boolean;
    workspaceKey: string;
    preferences: OpenInSidePanePreferences;
  }) => void;
  allowPersonaFallbackNavigation?: (rawHref: string) => void;
  showUnmappedMachineToast: (input: { machineId: string; onConfigure: () => void }) => void;
  showHostOfflineToast: (hostLabel: string) => void;
  showWorkspaceFallbackToast: () => void;
  showNotManagedByPaseoToast: () => void;
}

export interface OpenPersonaSessionResult {
  resolution: PersonaSessionResolution;
  handled: boolean;
  navigatedRoute?: string;
}

function buildUnmappedMachineToastContent(input: {
  message: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return createElement(
    View,
    { style: toastStyles.row },
    createElement(Text, { style: toastStyles.message }, input.message),
    createElement(
      Button,
      {
        size: "sm",
        variant: "outline",
        onPress: input.onAction,
        testID: "persona-configure-mapping-toast-action",
      },
      input.actionLabel,
    ),
  );
}

const toastStyles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  message: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
}));

function resolveCurrentResolution(
  request: PersonaSessionOpenRequest,
  deps: OpenPersonaSessionDeps,
): PersonaSessionResolution {
  return resolvePersonaSession({
    request,
    machineServerMap: deps.getMachineServerMap(),
    hosts: deps.getHosts(),
    sessions: deps.getSessions(),
    connectionStatusByServerId: deps.getConnectionStatusByServerId(),
  });
}

function openResolvedWorkspaceDiff(
  serverId: string,
  workspaceId: string,
  deps: OpenPersonaSessionDeps,
): void {
  const session = deps.getSessions()[serverId];
  const canonicalWorkspaceId =
    resolveWorkspaceMapKeyByIdentity({
      workspaces: session?.workspaces,
      workspaceId,
    }) ?? workspaceId;
  deps.openWorkspaceChanges({
    isCompact: deps.getIsCompact(),
    workspaceKey: `${serverId}:${canonicalWorkspaceId}`,
    preferences: deps.getOpenInSidePanePreferences(),
  });
}

function openAgentDetailRoute(
  serverId: string,
  agentId: string,
  panel: WorkspacePanelIntent | null | undefined,
  deps: OpenPersonaSessionDeps,
): string {
  const detailRoute = buildHostAgentDetailRoute(
    serverId,
    agentId,
    undefined,
    panel ? { panel } : undefined,
  );
  deps.navigateToRoute(detailRoute);
  return detailRoute;
}

function openAgentInWorkspace(
  input: {
    serverId: string;
    agentId: string;
    workspaceId: string;
    labels?: Record<string, unknown>;
    panel?: WorkspacePanelIntent | null;
  },
  deps: OpenPersonaSessionDeps,
): string {
  const route = deps.navigateToAgent({
    serverId: input.serverId,
    agentId: input.agentId,
    workspaceId: input.workspaceId,
    labels: input.labels,
    pin: true,
    panel: null,
  });
  if (input.panel === "diff") {
    openResolvedWorkspaceDiff(input.serverId, input.workspaceId, deps);
  }
  return route;
}

async function openRemoteLookupResolution(
  resolution: Extract<PersonaSessionResolution, { kind: "agent_remote_lookup" }>,
  deps: OpenPersonaSessionDeps,
): Promise<OpenPersonaSessionResult> {
  const status = deps.getConnectionStatusByServerId()[resolution.serverId];
  if (status === "online" && deps.fetchRemoteAgent) {
    try {
      const remote = await deps.fetchRemoteAgent(resolution.serverId, resolution.agentId);
      const remoteWorkspaceId = remote?.workspaceId?.trim() || null;
      if (remote && remoteWorkspaceId) {
        const route = openAgentInWorkspace(
          {
            serverId: resolution.serverId,
            agentId: resolution.agentId,
            workspaceId: remoteWorkspaceId,
            labels: remote.labels,
            panel: resolution.panel,
          },
          deps,
        );
        return { resolution, handled: true, navigatedRoute: route };
      }
    } catch {
      // Fall through to native HostAgentReadyRoute lookup/reconnect flow.
    }
  }

  const fallbackRoute = openAgentDetailRoute(
    resolution.serverId,
    resolution.agentId,
    resolution.panel,
    deps,
  );
  return { resolution, handled: true, navigatedRoute: fallbackRoute };
}

function lookupHostLabel(
  deps: OpenPersonaSessionDeps,
  serverId: string | null | undefined,
  fallback: string,
): string {
  if (serverId) {
    const matched = deps.getHosts().find((host) => host.serverId === serverId);
    if (matched?.label) {
      return matched.label;
    }
    return serverId;
  }
  return fallback;
}

function handleUnresolvedResolution(
  request: PersonaSessionOpenRequest,
  resolution: Extract<PersonaSessionResolution, { kind: "unresolved" }>,
  deps: OpenPersonaSessionDeps,
): OpenPersonaSessionResult {
  if (resolution.reason === "unmapped_machine") {
    deps.showUnmappedMachineToast({
      machineId: resolution.machineId,
      onConfigure: () => {
        deps.navigateToRoute(buildSettingsSectionRoute("persona"));
      },
    });
    return { resolution, handled: false };
  }

  if (resolution.reason === "host_offline") {
    const hostLabel = lookupHostLabel(deps, resolution.resolvedServerId, resolution.machineId);
    deps.showHostOfflineToast(hostLabel);
    return { resolution, handled: false };
  }

  if (request.source === "link-click" && request.rawHref && deps.allowPersonaFallbackNavigation) {
    deps.allowPersonaFallbackNavigation(request.rawHref);
  }
  deps.showNotManagedByPaseoToast();
  return { resolution, handled: false };
}

export async function openPersonaSession(
  request: PersonaSessionOpenRequest,
  deps: OpenPersonaSessionDeps,
): Promise<OpenPersonaSessionResult> {
  let resolution = resolveCurrentResolution(request, deps);

  if (resolution.kind === "pending_hydration") {
    await deps.waitForHostHydration(resolution.serverId, HYDRATION_WAIT_TIMEOUT_MS);
    resolution = resolveCurrentResolution(request, deps);
  }

  if (resolution.kind === "agent") {
    const route = resolution.workspaceId
      ? openAgentInWorkspace(
          {
            serverId: resolution.serverId,
            agentId: resolution.agentId,
            workspaceId: resolution.workspaceId,
            panel: resolution.panel,
          },
          deps,
        )
      : openAgentDetailRoute(resolution.serverId, resolution.agentId, resolution.panel, deps);
    return { resolution, handled: true, navigatedRoute: route };
  }

  if (resolution.kind === "agent_remote_lookup") {
    return openRemoteLookupResolution(resolution, deps);
  }

  if (resolution.kind === "workspace") {
    const route = deps.navigateToWorkspace({
      serverId: resolution.serverId,
      workspaceId: resolution.workspaceId,
      target: resolution.panel === "diff" ? { kind: "working_diff" } : undefined,
    });
    deps.showWorkspaceFallbackToast();
    return { resolution, handled: true, navigatedRoute: route };
  }

  if (resolution.kind === "pending_hydration") {
    const hostLabel = lookupHostLabel(deps, resolution.serverId, resolution.serverId);
    deps.showHostOfflineToast(hostLabel);
    return { resolution, handled: false };
  }

  return handleUnresolvedResolution(request, resolution, deps);
}

function waitForSessionAgentsHydration(serverId: string, timeoutMs: number): Promise<void> {
  const initialSession = useSessionStore.getState().sessions[serverId];
  if (initialSession?.hasHydratedAgents) {
    return Promise.resolve();
  }

  // Trigger a probe/refresh in case the host is still warming up.
  try {
    void getHostRuntimeStore()
      .runProbeCycleNow(serverId)
      .catch(() => undefined);
  } catch {
    // Ignore when host runtime store is not initialized in tests.
  }

  let notifyDone: (() => void) | null = null;
  const pending = new Promise<void>((resolve) => {
    notifyDone = resolve;
  });

  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;

  const finish = (): void => {
    if (settled) {
      return;
    }
    settled = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    unsubscribe?.();
    unsubscribe = null;
    notifyDone?.();
  };

  unsubscribe = useSessionStore.subscribe((state) => {
    if (state.sessions[serverId]?.hasHydratedAgents) {
      finish();
    }
  });
  timer = setTimeout(finish, timeoutMs);

  return pending;
}

export function createAppOpenPersonaSessionDeps(options: {
  toast: ToastApi;
  isCompact: boolean;
  allowPersonaFallbackNavigation?: (rawHref: string) => void;
}): OpenPersonaSessionDeps {
  return {
    getMachineServerMap: () => readPersonaEmbedSettingsSnapshot().machineServerMap,
    getHosts: () =>
      getHostRuntimeStore()
        .getHosts()
        .map((host) => ({ serverId: host.serverId, label: host.label })),
    getSessions: () => useSessionStore.getState().sessions,
    getConnectionStatusByServerId: () => {
      const store = getHostRuntimeStore();
      const map: Record<string, string | undefined> = {};
      for (const host of store.getHosts()) {
        map[host.serverId] = store.getSnapshot(host.serverId)?.connectionStatus;
      }
      return map;
    },
    getOpenInSidePanePreferences: () => {
      const cached = appQueryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY);
      return cached?.openInSidePane ?? DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES;
    },
    getIsCompact: () =>
      options.isCompact || useWorkspaceLayoutStore.getState().layoutMode !== "split-panes",
    waitForHostHydration: waitForSessionAgentsHydration,
    fetchRemoteAgent: async (serverId, agentId) => {
      const client =
        useSessionStore.getState().sessions[serverId]?.client ??
        getHostRuntimeStore().getSnapshot(serverId)?.client ??
        null;
      if (!client || typeof client.fetchAgent !== "function") {
        return null;
      }
      const response = await client.fetchAgent({ agentId });
      if (!response?.agent) {
        return null;
      }
      return {
        workspaceId: response.agent.workspaceId ?? null,
        labels: response.agent.labels,
      };
    },
    navigateToAgent,
    navigateToWorkspace,
    navigateToRoute: (route) => {
      router.push(route as Href);
    },
    openWorkspaceChanges,
    allowPersonaFallbackNavigation: options.allowPersonaFallbackNavigation,
    showUnmappedMachineToast: ({ machineId, onConfigure }) => {
      let dismissToast: (() => void) | null = null;
      dismissToast = options.toast.show(
        buildUnmappedMachineToastContent({
          message: i18n.t("personaEmbed.jump.unmappedMachine", { machine: machineId }),
          actionLabel: i18n.t("personaEmbed.jump.configureMapping"),
          onAction: () => {
            dismissToast?.();
            onConfigure();
          },
        }),
        { variant: "warning", durationMs: 6_000, testID: "persona-unmapped-machine-toast" },
      );
    },
    showHostOfflineToast: (hostLabel) => {
      options.toast.show(i18n.t("personaEmbed.jump.hostOffline", { host: hostLabel }), {
        variant: "warning",
        durationMs: 4_500,
      });
    },
    showWorkspaceFallbackToast: () => {
      options.toast.show(i18n.t("personaEmbed.jump.workspaceFallback"), {
        variant: "info",
        durationMs: 3_500,
      });
    },
    showNotManagedByPaseoToast: () => {
      options.toast.show(i18n.t("personaEmbed.jump.notManagedByPaseo"), {
        variant: "info",
        durationMs: 3_500,
      });
    },
  };
}
