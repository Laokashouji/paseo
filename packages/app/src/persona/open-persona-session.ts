import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";
import { BUILTIN_PROVIDER_IDS } from "@getpaseo/protocol/provider-manifest";
import { router, type Href } from "expo-router";
import { createElement } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type { ToastApi } from "@/components/toast-host";
import { Button } from "@/components/ui/button";
import { daemonConfigQueryKey } from "@/data/daemon-config";
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
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
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
  collectSessionAgents,
  resolveMachineToServerId,
  resolvePersonaSession,
  type PersonaSessionOpenRequest,
  type PersonaSessionResolution,
  type PersonaSessionResolverHost,
} from "./session-resolver";
import { getActivePersonaHub, getPersonaHubById } from "./settings";
import { readPersonaEmbedSettingsSnapshot } from "./use-persona-settings";

const HYDRATION_WAIT_TIMEOUT_MS = 3_000;
const DAEMON_CONFIG_FETCH_TIMEOUT_MS = 1_500;
const BUILTIN_PROVIDER_ID_SET = new Set<string>(BUILTIN_PROVIDER_IDS);

export interface OpenPersonaSessionDeps {
  getMachineServerMap: () => Readonly<Record<string, string>>;
  getHosts: () => readonly PersonaSessionResolverHost[];
  getSessions: () => Readonly<Record<string, SessionState | undefined>>;
  getConnectionStatusByServerId: () => Readonly<Record<string, string | undefined>>;
  getProviderRootsByServerId?: () => Readonly<
    Record<string, Readonly<Record<string, string>> | undefined>
  >;
  hasDaemonConfigCache?: (serverId: string) => boolean;
  ensureProviderRoots?: (serverIds: readonly string[]) => Promise<boolean>;
  getOpenInSidePanePreferences: () => OpenInSidePanePreferences;
  getIsCompact: () => boolean;
  waitForHostHydration: (serverId: string, timeoutMs: number) => Promise<void>;
  lookupSessionMetadataHint?: (input: {
    machineId: string;
    sessionId: string;
    serverId: string;
  }) => Promise<{ workspaceIdHint?: string | null; cwdHint?: string | null } | null>;
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
  showAmbiguousMachineToast?: (input: {
    machineId: string;
    candidateServerIds: readonly string[];
    onConfigure: () => void;
  }) => void;
  showHostOfflineToast: (hostLabel: string) => void;
  showHostSyncTimeoutToast?: (hostLabel: string) => void;
  showWorkspaceFallbackToast: () => void;
  showNotManagedByPaseoToast: () => void;
}

export interface OpenPersonaSessionResult {
  resolution: PersonaSessionResolution;
  handled: boolean;
  navigatedRoute?: string;
}

function buildMappingActionToastContent(input: {
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
    providerRootsByServerId: deps.getProviderRootsByServerId?.(),
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
  if (resolution.reason === "ambiguous_machine") {
    const onConfigure = () => {
      deps.navigateToRoute(buildSettingsSectionRoute("persona"));
    };
    if (deps.showAmbiguousMachineToast) {
      deps.showAmbiguousMachineToast({
        machineId: resolution.machineId,
        candidateServerIds: resolution.candidateServerIds ?? [],
        onConfigure,
      });
    } else {
      deps.showUnmappedMachineToast({
        machineId: resolution.machineId,
        onConfigure,
      });
    }
    return { resolution, handled: false };
  }

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

function hasWorkspaceHint(request: PersonaSessionOpenRequest): boolean {
  return Boolean(request.workspaceIdHint?.trim() || request.cwdHint?.trim());
}

async function enrichWorkspaceHintsIfNeeded(
  request: PersonaSessionOpenRequest,
  resolution: PersonaSessionResolution,
  deps: OpenPersonaSessionDeps,
): Promise<{ request: PersonaSessionOpenRequest; resolution: PersonaSessionResolution }> {
  if (
    resolution.kind !== "unresolved" ||
    resolution.reason !== "not_found" ||
    resolution.resolvedServerId === null ||
    hasWorkspaceHint(request) ||
    !deps.lookupSessionMetadataHint
  ) {
    return { request, resolution };
  }
  try {
    const metadata = await deps.lookupSessionMetadataHint({
      machineId: request.machineId,
      sessionId: request.sessionId,
      serverId: resolution.resolvedServerId,
    });
    const workspaceIdHint = metadata?.workspaceIdHint?.trim() || null;
    const cwdHint = metadata?.cwdHint?.trim() || null;
    if (!workspaceIdHint && !cwdHint) {
      return { request, resolution };
    }
    const nextRequest: PersonaSessionOpenRequest = {
      ...request,
      ...(workspaceIdHint ? { workspaceIdHint } : {}),
      ...(cwdHint ? { cwdHint } : {}),
    };
    return {
      request: nextRequest,
      resolution: resolveCurrentResolution(nextRequest, deps),
    };
  } catch {
    return { request, resolution };
  }
}

function handleHydrationTimeout(
  resolution: Extract<PersonaSessionResolution, { kind: "pending_hydration" }>,
  deps: OpenPersonaSessionDeps,
): OpenPersonaSessionResult {
  const hostLabel = lookupHostLabel(deps, resolution.serverId, resolution.serverId);
  const liveStatus = deps.getConnectionStatusByServerId()[resolution.serverId];
  if (liveStatus === "offline" || liveStatus === "error") {
    deps.showHostOfflineToast(hostLabel);
  } else if (deps.showHostSyncTimeoutToast) {
    deps.showHostSyncTimeoutToast(hostLabel);
  } else {
    deps.showHostOfflineToast(hostLabel);
  }
  return { resolution, handled: false };
}

/**
 * Mirrors Persona `providerRoots(config)` (`integrations/paseo/lib/map.js:115-128`):
 * resolves each configured provider through its `extends` chain with cycle protection.
 */
export function deriveProviderRootsFromDaemonConfig(
  providers: MutableDaemonConfig["providers"] | undefined,
): Record<string, string> {
  const roots: Record<string, string> = {};
  if (!providers || typeof providers !== "object") {
    return roots;
  }
  for (const providerId of Object.keys(providers)) {
    let current = providerId;
    const seen = new Set<string>();
    let followedExtends = false;
    while (!seen.has(current)) {
      const entry = providers[current] as { extends?: unknown } | undefined;
      const parent = typeof entry?.extends === "string" ? entry.extends.trim() : "";
      if (!parent) {
        break;
      }
      seen.add(current);
      current = parent;
      followedExtends = true;
    }
    if (current && (followedExtends || BUILTIN_PROVIDER_ID_SET.has(current))) {
      roots[providerId] = current;
    }
  }
  return roots;
}

function readAgentPersistedProviderRoot(agent: Agent): string | null {
  const metadata = agent.persistence?.metadata;
  const persistedRoot =
    metadata && typeof metadata === "object"
      ? (metadata as { provider?: unknown }).provider
      : undefined;
  if (typeof persistedRoot === "string" && persistedRoot.trim().length > 0) {
    return persistedRoot.trim();
  }
  return null;
}

function readCustomProviderId(
  rawProvider: unknown,
  roots: Readonly<Record<string, string>>,
): string | null {
  if (typeof rawProvider !== "string") {
    return null;
  }
  const providerId = rawProvider.trim();
  if (!providerId || BUILTIN_PROVIDER_ID_SET.has(providerId) || providerId in roots) {
    return null;
  }
  return providerId;
}

function recordPersistedAgentProviderRoots(
  agents: readonly Agent[],
  roots: Record<string, string>,
): void {
  for (const agent of agents) {
    const providerId = readCustomProviderId(agent.provider, roots);
    if (!providerId) {
      continue;
    }
    const persistedRoot = readAgentPersistedProviderRoot(agent);
    if (persistedRoot !== null) {
      roots[providerId] = persistedRoot;
    }
  }
}

/**
 * Derives a per-host `providerId -> built-in root` map strictly from authoritative host data:
 * 1. Daemon config `providers[id].extends` chains (highest precedence, matches Persona `providerRoots`)
 * 2. Persisted `persistence.metadata.provider` recorded on sibling agents on the same host
 *
 * Unknown custom providers without a confirmed authoritative root are intentionally omitted so
 * mode-name heuristics never misclassify non-Claude/Codex providers (e.g. `extends: "acp"`) in L3.
 */
export function deriveProviderRootsForServer(input: {
  daemonConfig?: MutableDaemonConfig | null;
  session?: SessionState | undefined;
}): Record<string, string> {
  const roots = deriveProviderRootsFromDaemonConfig(input.daemonConfig?.providers);
  const agents = collectSessionAgents(input.session);
  recordPersistedAgentProviderRoots(agents, roots);
  return roots;
}

export function collectAppProviderRootsByServerId(input: {
  hosts: readonly PersonaSessionResolverHost[];
  sessions: Readonly<Record<string, SessionState | undefined>>;
}): Record<string, Record<string, string>> {
  const serverIds = new Set<string>();
  for (const host of input.hosts) {
    if (host.serverId) {
      serverIds.add(host.serverId);
    }
  }
  for (const serverId of Object.keys(input.sessions)) {
    if (serverId) {
      serverIds.add(serverId);
    }
  }

  const byServerId: Record<string, Record<string, string>> = {};
  for (const serverId of serverIds) {
    const daemonConfig = appQueryClient.getQueryData<MutableDaemonConfig>(
      daemonConfigQueryKey(serverId),
    );
    const roots = deriveProviderRootsForServer({
      daemonConfig,
      session: input.sessions[serverId],
    });
    if (Object.keys(roots).length > 0) {
      byServerId[serverId] = roots;
    }
  }
  return byServerId;
}

function hasCustomProviderAgentMissingPersistedRoot(session: SessionState | undefined): boolean {
  for (const agent of collectSessionAgents(session)) {
    const providerId = typeof agent.provider === "string" ? agent.provider.trim() : "";
    if (!providerId || BUILTIN_PROVIDER_ID_SET.has(providerId)) {
      continue;
    }
    if (readAgentPersistedProviderRoot(agent) === null) {
      return true;
    }
  }
  return false;
}

function hasUnresolvedCustomProviderAgent(
  session: SessionState | undefined,
  providerRoots: Readonly<Record<string, string>> | undefined,
): boolean {
  for (const agent of collectSessionAgents(session)) {
    const providerId = typeof agent.provider === "string" ? agent.provider.trim() : "";
    if (!providerId || BUILTIN_PROVIDER_ID_SET.has(providerId)) {
      continue;
    }
    if (readAgentPersistedProviderRoot(agent) !== null) {
      continue;
    }
    if (!providerRoots || !(providerId in providerRoots)) {
      return true;
    }
  }
  return false;
}

function agentMatchesCandidateThreadId(agent: Agent, sessionId: string): boolean {
  const metadata = agent.persistence?.metadata;
  const threadId =
    metadata && typeof metadata === "object"
      ? (metadata as { threadId?: unknown }).threadId
      : undefined;
  for (const candidate of [threadId, agent.persistence?.sessionId, agent.runtimeInfo?.sessionId]) {
    if (typeof candidate === "string" && candidate === sessionId) {
      return true;
    }
  }
  return false;
}

function hasUnconfirmedCustomProviderAgentForThread(input: {
  session: SessionState | undefined;
  sessionId: string;
  hasAuthoritativeConfig: boolean | null;
  providerRoots?: Readonly<Record<string, string>>;
}): boolean {
  if (input.hasAuthoritativeConfig === true) {
    return false;
  }
  for (const agent of collectSessionAgents(input.session)) {
    const providerId = typeof agent.provider === "string" ? agent.provider.trim() : "";
    if (!providerId || BUILTIN_PROVIDER_ID_SET.has(providerId)) {
      continue;
    }
    if (readAgentPersistedProviderRoot(agent) !== null) {
      continue;
    }
    if (
      input.hasAuthoritativeConfig === null &&
      input.providerRoots &&
      providerId in input.providerRoots
    ) {
      continue;
    }
    if (agentMatchesCandidateThreadId(agent, input.sessionId)) {
      return true;
    }
  }
  return false;
}

function applyUnconfirmedCrossHostThreadGuard(input: {
  request: PersonaSessionOpenRequest;
  resolution: PersonaSessionResolution;
  serverIdsNeedingConfig: readonly string[];
  deps: OpenPersonaSessionDeps;
}): PersonaSessionResolution {
  if (input.resolution.kind !== "agent" || input.resolution.level !== "provider_thread_id") {
    return input.resolution;
  }

  const hosts = input.deps.getHosts();
  const sessions = input.deps.getSessions();
  const machineMatch = resolveMachineToServerId({
    machineId: input.request.machineId,
    machineServerMap: input.deps.getMachineServerMap(),
    hosts,
    sessions,
  });
  if (machineMatch.serverId !== null) {
    return input.resolution;
  }

  const normalizedSessionId = input.request.sessionId.trim();
  if (!normalizedSessionId) {
    return input.resolution;
  }

  const statuses = input.deps.getConnectionStatusByServerId();
  const providerRootsByServer = input.deps.hasDaemonConfigCache
    ? undefined
    : input.deps.getProviderRootsByServerId?.();
  const unconfirmedConflictServerIds: string[] = [];

  for (const otherServerId of input.serverIdsNeedingConfig) {
    if (otherServerId === input.resolution.serverId) {
      continue;
    }
    if (statuses[otherServerId] !== "online") {
      continue;
    }
    const hasAuthoritativeConfig = input.deps.hasDaemonConfigCache
      ? input.deps.hasDaemonConfigCache(otherServerId)
      : null;
    if (
      hasUnconfirmedCustomProviderAgentForThread({
        session: sessions[otherServerId],
        sessionId: normalizedSessionId,
        hasAuthoritativeConfig,
        providerRoots: providerRootsByServer?.[otherServerId],
      })
    ) {
      unconfirmedConflictServerIds.push(otherServerId);
    }
  }

  if (unconfirmedConflictServerIds.length === 0) {
    return input.resolution;
  }

  return {
    kind: "unresolved",
    reason: "ambiguous_machine",
    machineId: input.request.machineId.trim(),
    sessionId: normalizedSessionId,
    resolvedServerId: null,
    candidateServerIds: [input.resolution.serverId, ...unconfirmedConflictServerIds],
  };
}

function shouldRefreshProviderRootsForResolution(resolution: PersonaSessionResolution): boolean {
  if (resolution.kind === "agent") {
    return resolution.level === "provider_thread_id";
  }
  if (resolution.kind === "workspace") {
    return true;
  }
  return resolution.kind === "unresolved" && resolution.reason !== "host_offline";
}

function collectCandidateServerIdsForProviderRoots(
  request: PersonaSessionOpenRequest,
  hosts: readonly PersonaSessionResolverHost[],
  sessions: Readonly<Record<string, SessionState | undefined>>,
  machineServerMap: Readonly<Record<string, string>>,
): Set<string> {
  const machineMatch = resolveMachineToServerId({
    machineId: request.machineId,
    machineServerMap,
    hosts,
    sessions,
  });

  const candidateServerIds = new Set<string>();
  if (machineMatch.serverId) {
    candidateServerIds.add(machineMatch.serverId);
    return candidateServerIds;
  }

  for (const host of hosts) {
    if (host.serverId) {
      candidateServerIds.add(host.serverId);
    }
  }
  for (const serverId of Object.keys(sessions)) {
    if (serverId) {
      candidateServerIds.add(serverId);
    }
  }
  return candidateServerIds;
}

async function refreshProviderRootsIfNeeded(
  request: PersonaSessionOpenRequest,
  resolution: PersonaSessionResolution,
  deps: OpenPersonaSessionDeps,
): Promise<PersonaSessionResolution> {
  if (!deps.ensureProviderRoots || !shouldRefreshProviderRootsForResolution(resolution)) {
    return resolution;
  }

  const hosts = deps.getHosts();
  const sessions = deps.getSessions();
  const candidateServerIds = collectCandidateServerIdsForProviderRoots(
    request,
    hosts,
    sessions,
    deps.getMachineServerMap(),
  );

  if (candidateServerIds.size === 0) {
    return resolution;
  }

  const statuses = deps.getConnectionStatusByServerId();
  const currentRootsByServer = deps.hasDaemonConfigCache
    ? undefined
    : deps.getProviderRootsByServerId?.();
  const serverIdsNeedingConfig: string[] = [];

  for (const serverId of candidateServerIds) {
    if (statuses[serverId] !== "online") {
      continue;
    }
    const needsConfig = deps.hasDaemonConfigCache
      ? hasCustomProviderAgentMissingPersistedRoot(sessions[serverId]) &&
        !deps.hasDaemonConfigCache(serverId)
      : hasUnresolvedCustomProviderAgent(sessions[serverId], currentRootsByServer?.[serverId]);
    if (needsConfig) {
      serverIdsNeedingConfig.push(serverId);
    }
  }

  if (serverIdsNeedingConfig.length === 0) {
    return resolution;
  }

  try {
    await deps.ensureProviderRoots(serverIdsNeedingConfig);
  } catch {
    // Re-resolve with whatever authoritative config is available and fail closed below.
  }

  // 当未映射机器按 L3 单主机命中时，若其他在线候选主机仍缺少权威配置且持有相同线程，暂停自动跳转避免误跳
  const nextResolution = resolveCurrentResolution(request, deps);
  return applyUnconfirmedCrossHostThreadGuard({
    request,
    resolution: nextResolution,
    serverIdsNeedingConfig,
    deps,
  });
}

export async function openPersonaSession(
  request: PersonaSessionOpenRequest,
  deps: OpenPersonaSessionDeps,
): Promise<OpenPersonaSessionResult> {
  let effectiveRequest = request;
  let resolution = resolveCurrentResolution(effectiveRequest, deps);

  if (resolution.kind === "pending_hydration") {
    await deps.waitForHostHydration(resolution.serverId, HYDRATION_WAIT_TIMEOUT_MS);
    resolution = resolveCurrentResolution(effectiveRequest, deps);
  }

  resolution = await refreshProviderRootsIfNeeded(effectiveRequest, resolution, deps);

  const enriched = await enrichWorkspaceHintsIfNeeded(effectiveRequest, resolution, deps);
  effectiveRequest = enriched.request;
  resolution = enriched.resolution;

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
    return handleHydrationTimeout(resolution, deps);
  }

  return handleUnresolvedResolution(effectiveRequest, resolution, deps);
}

export interface HostDirectoryHydrationWaitDeps {
  isAgentsHydrated: (serverId: string) => boolean;
  subscribeAgentsHydrated: (listener: () => void) => () => void;
  acquireDirectoryDemand?: (serverId: string) => () => void;
  runProbeCycleNow?: (serverId: string) => Promise<unknown>;
}

/**
 * Waits for a host's directory (agents + workspaces) to hydrate while explicitly holding
 * directory demand for the wait window and releasing it on completion or timeout.
 */
export function waitForHostDirectoryHydration(
  serverId: string,
  timeoutMs: number,
  deps: HostDirectoryHydrationWaitDeps,
): Promise<void> {
  if (deps.isAgentsHydrated(serverId)) {
    return Promise.resolve();
  }

  let releaseDirectoryDemand: (() => void) | null = null;
  try {
    releaseDirectoryDemand = deps.acquireDirectoryDemand?.(serverId) ?? null;
  } catch {
    releaseDirectoryDemand = null;
  }

  try {
    void deps.runProbeCycleNow?.(serverId).catch(() => undefined);
  } catch {
    // Ignore when host runtime store is not initialized in tests.
  }

  if (deps.isAgentsHydrated(serverId)) {
    releaseDirectoryDemand?.();
    return Promise.resolve();
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
    releaseDirectoryDemand?.();
    releaseDirectoryDemand = null;
    notifyDone?.();
  };

  unsubscribe = deps.subscribeAgentsHydrated(() => {
    if (deps.isAgentsHydrated(serverId)) {
      finish();
    }
  });

  // Re-check once after subscribing in case hydration landed synchronously during demand acquisition.
  if (deps.isAgentsHydrated(serverId)) {
    finish();
    return pending;
  }

  timer = setTimeout(finish, timeoutMs);
  return pending;
}

function waitForSessionAgentsHydration(serverId: string, timeoutMs: number): Promise<void> {
  let runtime: ReturnType<typeof getHostRuntimeStore> | null = null;
  try {
    runtime = getHostRuntimeStore();
  } catch {
    runtime = null;
  }
  return waitForHostDirectoryHydration(serverId, timeoutMs, {
    isAgentsHydrated: (id) => Boolean(useSessionStore.getState().sessions[id]?.hasHydratedAgents),
    subscribeAgentsHydrated: (listener) => useSessionStore.subscribe(listener),
    acquireDirectoryDemand: runtime ? (id) => runtime.acquireDirectoryDemand(id) : undefined,
    runProbeCycleNow: runtime ? (id) => runtime.runProbeCycleNow(id) : undefined,
  });
}

async function fetchDaemonConfigWithTimeout(
  client: { getDaemonConfig: () => Promise<{ config: MutableDaemonConfig }> },
  timeoutMs: number,
): Promise<MutableDaemonConfig | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const configPromise = client.getDaemonConfig().catch(() => null);
    const response = await Promise.race([
      configPromise,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
    return response?.config ?? null;
  } catch {
    return null;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

function hasCachedDaemonConfig(serverId: string): boolean {
  const key = daemonConfigQueryKey(serverId);
  const config = appQueryClient.getQueryData<MutableDaemonConfig>(key);
  if (config === undefined) {
    return false;
  }
  return appQueryClient.getQueryState(key)?.isInvalidated !== true;
}

async function fetchMissingDaemonConfigsForProviderRoots(
  serverIds: readonly string[],
): Promise<boolean> {
  let runtime: ReturnType<typeof getHostRuntimeStore> | null = null;
  try {
    runtime = getHostRuntimeStore();
  } catch {
    runtime = null;
  }

  let updatedAny = false;
  await Promise.all(
    serverIds.map(async (serverId) => {
      if (hasCachedDaemonConfig(serverId)) {
        return;
      }
      const client =
        useSessionStore.getState().sessions[serverId]?.client ??
        runtime?.getSnapshot(serverId)?.client ??
        null;
      if (!client || typeof client.getDaemonConfig !== "function") {
        return;
      }
      const config = await fetchDaemonConfigWithTimeout(client, DAEMON_CONFIG_FETCH_TIMEOUT_MS);
      if (!config) {
        return;
      }
      appQueryClient.setQueryData(daemonConfigQueryKey(serverId), config);
      updatedAny = true;
    }),
  );
  return updatedAny;
}

export function createAppOpenPersonaSessionDeps(options: {
  toast: ToastApi;
  isCompact: boolean;
  hubId?: string | null;
  machineServerMapOverride?: Readonly<Record<string, string>>;
  allowPersonaFallbackNavigation?: (rawHref: string) => void;
  lookupSessionMetadataHint?: OpenPersonaSessionDeps["lookupSessionMetadataHint"];
}): OpenPersonaSessionDeps {
  const getHosts = (): PersonaSessionResolverHost[] =>
    getHostRuntimeStore()
      .getHosts()
      .map((host) => ({ serverId: host.serverId, label: host.label }));

  return {
    getMachineServerMap: () => {
      if (options.machineServerMapOverride) {
        return options.machineServerMapOverride;
      }
      const settings = readPersonaEmbedSettingsSnapshot();
      if (options.hubId) {
        return getPersonaHubById(settings, options.hubId)?.machineServerMap ?? {};
      }
      return getActivePersonaHub(settings)?.machineServerMap ?? {};
    },
    getHosts,
    getSessions: () => useSessionStore.getState().sessions,
    getConnectionStatusByServerId: () => {
      const store = getHostRuntimeStore();
      const map: Record<string, string | undefined> = {};
      for (const host of store.getHosts()) {
        map[host.serverId] = store.getSnapshot(host.serverId)?.connectionStatus;
      }
      return map;
    },
    getProviderRootsByServerId: () =>
      collectAppProviderRootsByServerId({
        hosts: getHosts(),
        sessions: useSessionStore.getState().sessions,
      }),
    hasDaemonConfigCache: hasCachedDaemonConfig,
    ensureProviderRoots: fetchMissingDaemonConfigsForProviderRoots,
    getOpenInSidePanePreferences: () => {
      const cached = appQueryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY);
      return cached?.openInSidePane ?? DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES;
    },
    getIsCompact: () =>
      options.isCompact || useWorkspaceLayoutStore.getState().layoutMode !== "split-panes",
    waitForHostHydration: waitForSessionAgentsHydration,
    lookupSessionMetadataHint: options.lookupSessionMetadataHint,
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
        buildMappingActionToastContent({
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
    showAmbiguousMachineToast: ({ machineId, onConfigure }) => {
      let dismissToast: (() => void) | null = null;
      dismissToast = options.toast.show(
        buildMappingActionToastContent({
          message: i18n.t("personaEmbed.jump.ambiguousMachine", { machine: machineId }),
          actionLabel: i18n.t("personaEmbed.jump.configureMapping"),
          onAction: () => {
            dismissToast?.();
            onConfigure();
          },
        }),
        { variant: "warning", durationMs: 6_000, testID: "persona-ambiguous-machine-toast" },
      );
    },
    showHostOfflineToast: (hostLabel) => {
      options.toast.show(i18n.t("personaEmbed.jump.hostOffline", { host: hostLabel }), {
        variant: "warning",
        durationMs: 4_500,
      });
    },
    showHostSyncTimeoutToast: (hostLabel) => {
      options.toast.show(i18n.t("personaEmbed.jump.hostSyncTimeout", { host: hostLabel }), {
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
