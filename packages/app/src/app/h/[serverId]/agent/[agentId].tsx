import { isMainChatAgent } from "@getpaseo/protocol/main-chat";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useLocalSearchParams, useRouter, type Href } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { useFetchQuery } from "@/data/query";
import { resolveAgentRoute, type AgentRouteLookup } from "@/navigation/agent-route-resolution";
import { AgentRouteResolutionView } from "@/navigation/agent-route-resolution-view";
import { useHasHydratedWorkspaces } from "@/stores/session-store-hooks";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { useWorkspaceLayoutStoreHydrated } from "@/stores/workspace-layout-store";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore, useHostRuntimeSnapshot, useHosts } from "@/runtime/host-runtime";
import {
  buildHostRootRoute,
  buildMainChatRoute,
  buildSettingsHostRoute,
} from "@/utils/host-routes";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export default function HostAgentReadyRoute() {
  return (
    <HostRouteBootstrapBoundary>
      <HostAgentReadyRouteContent />
    </HostRouteBootstrapBoundary>
  );
}

function resolveHostAgentNavigationKey(
  resolvedIsMainChat: boolean,
  serverId: string,
  resolution: ReturnType<typeof resolveAgentRoute>,
): string | null {
  if (resolvedIsMainChat) {
    return `main-chat:${serverId}`;
  }
  if (resolution.kind === "invalid") {
    return "invalid";
  }
  if (resolution.kind === "resolved") {
    return `workspace:${resolution.workspaceId}`;
  }
  if (resolution.kind === "notFound") {
    return "not-found";
  }
  return null;
}

function useHostAgentRouteLookup(input: {
  serverId: string;
  agentId: string;
  client: ReturnType<typeof useHostRuntimeSnapshot> extends infer T
    ? T extends { client: infer C }
      ? C | null
      : null
    : null;
  clientGeneration: number;
  connectionStatus: string;
  agentWorkspaceId: string | null;
  cachedAgentIsMainChat: boolean;
}) {
  const {
    serverId,
    agentId,
    client,
    clientGeneration,
    connectionStatus,
    agentWorkspaceId,
    cachedAgentIsMainChat,
  } = input;

  useEffect(() => {
    if (!serverId || !agentId || agentWorkspaceId || cachedAgentIsMainChat) return;
    void getHostRuntimeStore()
      .prepareAgentRoute(serverId, agentId)
      .catch(() => undefined);
  }, [agentId, agentWorkspaceId, cachedAgentIsMainChat, serverId]);

  const shouldLookupAgent = Boolean(
    serverId &&
    agentId &&
    client &&
    connectionStatus === "online" &&
    !agentWorkspaceId &&
    !cachedAgentIsMainChat,
  );
  const lookupQuery = useFetchQuery({
    queryKey: ["agentRouteResolution", serverId, agentId, clientGeneration],
    queryFn: async () => {
      if (!client) {
        throw new Error("Target host client is unavailable");
      }
      const result = await client.fetchAgent({ agentId });
      return {
        workspaceId: result?.agent?.workspaceId ?? null,
        isMainChat: isMainChatAgent(result?.agent),
      };
    },
    enabled: shouldLookupAgent,
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
  });

  const lookup = useMemo<AgentRouteLookup>(() => {
    if (!shouldLookupAgent) {
      return { kind: "idle" };
    }
    if (lookupQuery.isFetching) {
      return { kind: "fetching" };
    }
    if (lookupQuery.isError) {
      return { kind: "failed", error: toErrorMessage(lookupQuery.error) };
    }
    if (lookupQuery.isSuccess) {
      return { kind: "found", workspaceId: lookupQuery.data?.workspaceId ?? null };
    }
    return { kind: "fetching" };
  }, [
    lookupQuery.data,
    lookupQuery.error,
    lookupQuery.isError,
    lookupQuery.isFetching,
    lookupQuery.isSuccess,
    shouldLookupAgent,
  ]);

  return {
    lookup,
    resolvedIsMainChat: cachedAgentIsMainChat || lookupQuery.data?.isMainChat === true,
    refetch: lookupQuery.refetch,
  };
}

function HostAgentReadyRouteContent() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    serverId?: string;
    agentId?: string;
  }>();
  const handledNavigationRef = useRef<string | null>(null);
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const agentId = typeof params.agentId === "string" ? params.agentId : "";
  const hosts = useHosts();
  const runtimeSnapshot = useHostRuntimeSnapshot(serverId);
  const client = runtimeSnapshot?.client ?? null;
  const connectionStatus = runtimeSnapshot?.connectionStatus ?? "connecting";
  const hostName = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const cachedAgentIsMainChat = useSessionStore((state) => {
    if (!serverId || !agentId) {
      return false;
    }
    const session = state.sessions[serverId];
    const agent = session?.agents?.get(agentId) ?? session?.agentDetails?.get(agentId);
    return isMainChatAgent(agent);
  });
  const agentWorkspaceId = useSessionStore((state) => {
    if (!serverId || !agentId) {
      return null;
    }
    return state.sessions[serverId]?.agents?.get(agentId)?.workspaceId ?? null;
  });
  const { lookup, resolvedIsMainChat, refetch } = useHostAgentRouteLookup({
    serverId,
    agentId,
    client,
    clientGeneration: runtimeSnapshot?.clientGeneration ?? 0,
    connectionStatus,
    agentWorkspaceId,
    cachedAgentIsMainChat,
  });
  const hasHydratedWorkspaces = useHasHydratedWorkspaces(serverId);
  const hasHydratedLayout = useWorkspaceLayoutStoreHydrated();
  useDirectoryDemand(serverId);
  const resolution = resolveAgentRoute({
    hasHydratedWorkspaces,
    hasHydratedLayout,
    serverId,
    agentId,
    cachedWorkspaceId: agentWorkspaceId,
    connectionStatus,
    lookup,
  });

  useEffect(() => {
    const navigationKey = resolveHostAgentNavigationKey(resolvedIsMainChat, serverId, resolution);
    if (!navigationKey || handledNavigationRef.current === navigationKey) {
      return;
    }
    handledNavigationRef.current = navigationKey;

    if (resolvedIsMainChat) {
      router.replace(buildMainChatRoute(serverId) as Href);
      return;
    }
    if (resolution.kind === "resolved") {
      navigateToAgent({ serverId, agentId, workspaceId: resolution.workspaceId, pin: true });
      return;
    }
    router.replace(resolution.kind === "invalid" ? ("/" as Href) : buildHostRootRoute(serverId));
  }, [agentId, resolution, resolvedIsMainChat, router, serverId]);

  const handleRetry = useCallback(() => {
    if (resolution.kind === "lookupError") {
      void refetch();
      return;
    }
    if (serverId) {
      void getHostRuntimeStore().runProbeCycleNow(serverId);
    }
  }, [refetch, resolution.kind, serverId]);
  const handleManageHost = useCallback(() => {
    if (serverId) {
      router.push(buildSettingsHostRoute(serverId));
    }
  }, [router, serverId]);
  const handleBack = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    router.replace(serverId ? buildHostRootRoute(serverId) : ("/" as Href));
  }, [router, serverId]);

  if (
    resolution.kind === "waitingForHost" ||
    resolution.kind === "fetchingAgent" ||
    resolution.kind === "lookupError"
  ) {
    // Agent URLs intentionally omit workspaceId. Keep this route mounted while the target host
    // reconnects, then resolve the workspace from the authoritative agent record.
    return (
      <AgentRouteResolutionView
        resolution={resolution}
        hostName={hostName}
        lastHostError={runtimeSnapshot?.lastError ?? null}
        onRetry={handleRetry}
        onManageHost={handleManageHost}
        onBack={handleBack}
      />
    );
  }

  return null;
}
