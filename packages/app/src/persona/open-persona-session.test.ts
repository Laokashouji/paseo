import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  GetProvidersSnapshotResponseMessage,
  MutableDaemonConfig,
} from "@getpaseo/protocol/messages";
import { router } from "expo-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daemonConfigQueryKey } from "@/data/daemon-config";
import { providersSnapshotQueryKey } from "@/data/providers-snapshot";
import { queryClient as appQueryClient } from "@/data/query-client";
import {
  APP_SETTINGS_QUERY_KEY,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES,
} from "@/hooks/use-settings/storage";
import { normalizePersonaEmbedSettings } from "./settings";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import {
  useSessionStore,
  type Agent,
  type SessionState,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import {
  createAppOpenPersonaSessionDeps,
  deriveProviderRootsFromDaemonConfig,
  openPersonaSession,
  waitForHostDirectoryHydration,
  type OpenPersonaSessionDeps,
} from "./open-persona-session";

function makeAgent(overrides: Partial<Agent> & { id: string; serverId: string }): Agent {
  return {
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-24T00:00:00.000Z"),
    updatedAt: new Date("2026-11-24T00:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-24T00:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: null,
    cwd: "/repo/app",
    model: null,
    parentAgentId: null,
    labels: {},
    ...overrides,
  };
}

function makeSession(serverId: string, partial: Partial<SessionState> = {}): SessionState {
  return {
    serverId,
    client: null,
    clientGeneration: 1,
    viewedTimelineSync: null,
    serverInfo: { serverId, hostname: "n37-217-003", version: "0.17.532" },
    hasHydratedAgents: true,
    hasHydratedWorkspaces: true,
    hasWorkspaceDirectorySnapshot: true,
    isPlayingAudio: false,
    focusedAgentId: null,
    focusedTerminalId: null,
    agentStreamTail: new Map(),
    agentStreamHead: new Map(),
    agentTasks: new Map(),
    messageSubmissions: new Map(),
    agentTimelineCursor: new Map(),
    agentTimelineUnsettledTurn: new Map(),
    agentTimelineHasOlder: new Map(),
    agentTimelineHasNewer: new Map(),
    agentTimelineOlderFetchInFlight: new Map(),
    historySyncGeneration: 0,
    agentHistorySyncGeneration: new Map(),
    agentAuthoritativeHistoryApplied: new Map(),
    agents: new Map(),
    agentDetails: new Map(),
    workspaces: new Map(),
    projects: new Map(),
    ...partial,
  } as unknown as SessionState;
}

function createDeps(overrides: Partial<OpenPersonaSessionDeps> = {}) {
  const navigateToAgent = vi.fn(() => "/h/srv_devbox/workspace/wks_0123456789abcdef");
  const navigateToWorkspace = vi.fn(() => "/h/srv_devbox/workspace/wks_0123456789abcdef");
  const navigateToRoute = vi.fn();
  const openWorkspaceChanges = vi.fn();
  const allowPersonaFallbackNavigation = vi.fn();
  const showUnmappedMachineToast = vi.fn();
  const showHostOfflineToast = vi.fn();
  const showWorkspaceFallbackToast = vi.fn();
  const showNotManagedByPaseoToast = vi.fn();
  const waitForHostHydration = vi.fn(async () => undefined);

  const deps: OpenPersonaSessionDeps = {
    getMachineServerMap: () => ({}),
    getHosts: () => [{ serverId: "srv_devbox", label: "DevBox" }],
    getSessions: () => ({ srv_devbox: makeSession("srv_devbox") }),
    getConnectionStatusByServerId: () => ({ srv_devbox: "online" }),
    getOpenInSidePanePreferences: () => DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES,
    getIsCompact: () => false,
    waitForHostHydration,
    navigateToAgent,
    navigateToWorkspace,
    navigateToRoute,
    openWorkspaceChanges,
    allowPersonaFallbackNavigation,
    showUnmappedMachineToast,
    showHostOfflineToast,
    showWorkspaceFallbackToast,
    showNotManagedByPaseoToast,
    ...overrides,
  };

  return {
    deps,
    navigateToAgent,
    navigateToWorkspace,
    navigateToRoute,
    openWorkspaceChanges,
    allowPersonaFallbackNavigation,
    showUnmappedMachineToast,
    showHostOfflineToast,
    showWorkspaceFallbackToast,
    showNotManagedByPaseoToast,
    waitForHostHydration,
  };
}

describe("openPersonaSession executor", () => {
  it("opens matched agent and invokes openWorkspaceChanges when panel=diff", async () => {
    const agent = makeAgent({
      id: "ag_1",
      serverId: "srv_devbox",
      workspaceId: "wks_0123456789abcdef",
      labels: { "persona.session": "sess_1" },
    });
    const session = makeSession("srv_devbox", {
      agents: new Map([[agent.id, agent]]),
    });
    const harness = createDeps({
      getSessions: () => ({ srv_devbox: session }),
    });

    const result = await openPersonaSession(
      {
        machineId: "n37-217-003",
        sessionId: "sess_1",
        panel: "diff",
        source: "header-button",
      },
      harness.deps,
    );

    expect(result.handled).toBe(true);
    expect(harness.navigateToAgent).toHaveBeenCalledWith({
      serverId: "srv_devbox",
      agentId: "ag_1",
      workspaceId: "wks_0123456789abcdef",
      pin: true,
      panel: null,
    });
    expect(harness.openWorkspaceChanges).toHaveBeenCalledWith({
      isCompact: false,
      workspaceKey: "srv_devbox:wks_0123456789abcdef",
      preferences: DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES,
    });
  });

  it("performs remote lookup for missing paseo-<agentId> and falls back to /h/.../agent/...?panel=diff", async () => {
    const fetchRemoteAgent = vi.fn(async () => ({
      workspaceId: "wks_0123456789abcdef",
      labels: {},
    }));
    const harnessOnline = createDeps({ fetchRemoteAgent });

    const onlineResult = await openPersonaSession(
      {
        machineId: "n37-217-003",
        sessionId: "paseo-ag_remote",
        panel: "diff",
        source: "link-click",
      },
      harnessOnline.deps,
    );

    expect(onlineResult.handled).toBe(true);
    expect(fetchRemoteAgent).toHaveBeenCalledWith("srv_devbox", "ag_remote");
    expect(harnessOnline.navigateToAgent).toHaveBeenCalledWith({
      serverId: "srv_devbox",
      agentId: "ag_remote",
      workspaceId: "wks_0123456789abcdef",
      labels: {},
      pin: true,
      panel: null,
    });
    expect(harnessOnline.openWorkspaceChanges).toHaveBeenCalledTimes(1);

    // When fetchRemoteAgent fails or host is offline -> navigates to HostAgentReadyRoute with ?panel=diff
    const harnessOffline = createDeps({
      getConnectionStatusByServerId: () => ({ srv_devbox: "offline" }),
    });
    const offlineResult = await openPersonaSession(
      {
        machineId: "n37-217-003",
        sessionId: "paseo-ag_remote",
        panel: "diff",
        source: "link-click",
      },
      harnessOffline.deps,
    );
    expect(offlineResult.handled).toBe(true);
    expect(harnessOffline.navigateToRoute).toHaveBeenCalledWith(
      "/h/srv_devbox/agent/ag_remote?panel=diff",
    );
  });

  it("waits for host hydration once when pending_hydration and resolves after snapshot arrives", async () => {
    const claudeSid = "12345678-1234-4123-8123-123456789abc";
    let hydrated = false;
    const coldSession = makeSession("srv_devbox", { hasHydratedAgents: false });
    const hydratedSession = makeSession("srv_devbox", {
      hasHydratedAgents: true,
      agents: new Map([
        [
          "ag_hydrated",
          makeAgent({
            id: "ag_hydrated",
            serverId: "srv_devbox",
            workspaceId: "wks_0123456789abcdef",
            persistence: { provider: "claude", sessionId: claudeSid },
          }),
        ],
      ]),
    });

    const harness = createDeps({
      getSessions: () => ({ srv_devbox: hydrated ? hydratedSession : coldSession }),
      waitForHostHydration: vi.fn(async () => {
        hydrated = true;
      }),
    });

    const result = await openPersonaSession(
      {
        machineId: "n37-217-003",
        sessionId: claudeSid,
        source: "link-click",
      },
      harness.deps,
    );

    expect(harness.deps.waitForHostHydration).toHaveBeenCalledWith("srv_devbox", 3000);
    expect(result.handled).toBe(true);
    expect(harness.navigateToAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "ag_hydrated" }),
    );
  });

  it("handles workspace fallback, unmapped_machine, host_offline, and non-Paseo link fallback", async () => {
    const ws = {
      id: "wks_0123456789abcdef",
      workspaceDirectory: "/repo/paseo-fork",
    } as WorkspaceDescriptor;
    const wsHarness = createDeps({
      getSessions: () => ({
        srv_devbox: makeSession("srv_devbox", { workspaces: new Map([[ws.id, ws]]) }),
      }),
    });
    const wsResult = await openPersonaSession(
      {
        machineId: "n37-217-003",
        sessionId: "unknown-1",
        workspaceIdHint: ws.id,
        panel: "diff",
        source: "link-click",
      },
      wsHarness.deps,
    );
    expect(wsResult.handled).toBe(true);
    expect(wsHarness.navigateToWorkspace).toHaveBeenCalledWith({
      serverId: "srv_devbox",
      workspaceId: ws.id,
      target: { kind: "working_diff" },
    });
    expect(wsHarness.showWorkspaceFallbackToast).toHaveBeenCalledTimes(1);

    // Unmapped machine -> toast with configure action routing to /settings/persona
    const unmappedHarness = createDeps();
    await openPersonaSession(
      { machineId: "mystery-host", sessionId: "sess-x", source: "link-click" },
      unmappedHarness.deps,
    );
    expect(unmappedHarness.showUnmappedMachineToast).toHaveBeenCalledTimes(1);
    const toastArg = unmappedHarness.showUnmappedMachineToast.mock.calls[0]?.[0];
    toastArg?.onConfigure();
    expect(unmappedHarness.navigateToRoute).toHaveBeenCalledWith("/settings/persona");

    // Host offline -> warning toast
    const offlineHarness = createDeps({
      getConnectionStatusByServerId: () => ({ srv_devbox: "offline" }),
    });
    await openPersonaSession(
      { machineId: "n37-217-003", sessionId: "herdr-1", source: "link-click" },
      offlineHarness.deps,
    );
    expect(offlineHarness.showHostOfflineToast).toHaveBeenCalledWith("DevBox");

    // Non-Paseo session clicked as link -> allows in-Persona navigation + info toast
    const notFoundLinkHarness = createDeps();
    await openPersonaSession(
      {
        machineId: "n37-217-003",
        sessionId: "herdr-1",
        source: "link-click",
        rawHref: "http://10.37.217.3:18660/s/n37-217-003/herdr-1",
      },
      notFoundLinkHarness.deps,
    );
    expect(notFoundLinkHarness.allowPersonaFallbackNavigation).toHaveBeenCalledWith(
      "http://10.37.217.3:18660/s/n37-217-003/herdr-1",
    );
    expect(notFoundLinkHarness.showNotManagedByPaseoToast).toHaveBeenCalledTimes(1);

    // Non-Paseo session clicked from header button -> info toast only, no fallback navigation
    const notFoundHeaderHarness = createDeps();
    await openPersonaSession(
      {
        machineId: "n37-217-003",
        sessionId: "herdr-1",
        source: "header-button",
        rawHref: "http://10.37.217.3:18660/s/n37-217-003/herdr-1",
      },
      notFoundHeaderHarness.deps,
    );
    expect(notFoundHeaderHarness.allowPersonaFallbackNavigation).not.toHaveBeenCalled();
    expect(notFoundHeaderHarness.showNotManagedByPaseoToast).toHaveBeenCalledTimes(1);
  });

  it("enriches Level-4 workspace hints via lookupSessionMetadataHint after host resolution", async () => {
    const ws = {
      id: "wks_fedcba9876543210",
      workspaceDirectory: "/data00/repo/demo",
    } as WorkspaceDescriptor;
    const lookupSessionMetadataHint = vi.fn(async () => ({
      workspaceIdHint: ws.id,
      cwdHint: ws.workspaceDirectory,
    }));
    const harness = createDeps({
      getSessions: () => ({
        srv_devbox: makeSession("srv_devbox", { workspaces: new Map([[ws.id, ws]]) }),
      }),
      lookupSessionMetadataHint,
    });

    const result = await openPersonaSession(
      {
        machineId: "n37-217-003",
        sessionId: "unmanaged-sid",
        panel: "diff",
        source: "window-open",
      },
      harness.deps,
    );

    expect(lookupSessionMetadataHint).toHaveBeenCalledWith({
      machineId: "n37-217-003",
      sessionId: "unmanaged-sid",
      serverId: "srv_devbox",
    });
    expect(result.handled).toBe(true);
    expect(result.resolution).toEqual({
      kind: "workspace",
      level: "workspace_fallback",
      serverId: "srv_devbox",
      workspaceId: ws.id,
      panel: "diff",
    });
    expect(harness.navigateToWorkspace).toHaveBeenCalledWith({
      serverId: "srv_devbox",
      workspaceId: ws.id,
      target: { kind: "working_diff" },
    });
  });

  it("shows ambiguous-machine toast prompting mapping when multiple hosts match the same session", async () => {
    const showAmbiguousMachineToast = vi.fn();
    const sharedSid = "shared_sess_1";
    const harness = createDeps({
      getHosts: () => [
        { serverId: "srv_a", label: "Host A" },
        { serverId: "srv_b", label: "Host B" },
      ],
      getSessions: () => ({
        srv_a: makeSession("srv_a", {
          serverInfo: { serverId: "srv_a", hostname: "host-a", version: "0.17.533" },
          agents: new Map([
            [
              "ag_a",
              makeAgent({
                id: "ag_a",
                serverId: "srv_a",
                labels: { "persona.session": sharedSid },
              }),
            ],
          ]),
        }),
        srv_b: makeSession("srv_b", {
          serverInfo: { serverId: "srv_b", hostname: "host-b", version: "0.17.533" },
          agents: new Map([
            [
              "ag_b",
              makeAgent({
                id: "ag_b",
                serverId: "srv_b",
                labels: { "persona.session": sharedSid },
              }),
            ],
          ]),
        }),
      }),
      getConnectionStatusByServerId: () => ({ srv_a: "online", srv_b: "online" }),
      showAmbiguousMachineToast,
    });

    const result = await openPersonaSession(
      { machineId: "unmapped-machine", sessionId: sharedSid, source: "link-click" },
      harness.deps,
    );

    expect(result.handled).toBe(false);
    expect(showAmbiguousMachineToast).toHaveBeenCalledTimes(1);
    const arg = showAmbiguousMachineToast.mock.calls[0]?.[0];
    expect(arg?.machineId).toBe("unmapped-machine");
    expect(arg?.candidateServerIds).toEqual(["srv_a", "srv_b"]);
    arg?.onConfigure();
    expect(harness.navigateToRoute).toHaveBeenCalledWith("/settings/persona");
  });

  it("acquires and releases host directory demand during cold-start wait and distinguishes sync timeout from offline", async () => {
    const release = vi.fn();
    const acquireDirectoryDemand = vi.fn(() => release);
    const runProbeCycleNow = vi.fn(async () => undefined);
    let hydrated = false;
    const listeners = new Set<() => void>();

    const waitPromise = waitForHostDirectoryHydration("srv_devbox", 500, {
      isAgentsHydrated: () => hydrated,
      subscribeAgentsHydrated: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      acquireDirectoryDemand,
      runProbeCycleNow,
    });

    expect(acquireDirectoryDemand).toHaveBeenCalledWith("srv_devbox");
    expect(release).not.toHaveBeenCalled();

    hydrated = true;
    for (const listener of listeners) {
      listener();
    }
    await waitPromise;
    expect(release).toHaveBeenCalledTimes(1);

    // Timeout also releases directory demand
    const releaseTimeout = vi.fn();
    await waitForHostDirectoryHydration("srv_devbox", 10, {
      isAgentsHydrated: () => false,
      subscribeAgentsHydrated: () => () => undefined,
      acquireDirectoryDemand: () => releaseTimeout,
    });
    expect(releaseTimeout).toHaveBeenCalledTimes(1);

    // Online host timing out on directory sync MUST show sync-timeout toast, NOT offline toast
    const showHostSyncTimeoutToast = vi.fn();
    const onlineTimeoutHarness = createDeps({
      getSessions: () => ({
        srv_devbox: makeSession("srv_devbox", { hasHydratedAgents: false }),
      }),
      getConnectionStatusByServerId: () => ({ srv_devbox: "online" }),
      waitForHostHydration: vi.fn(async () => undefined),
      showHostSyncTimeoutToast,
    });

    await openPersonaSession(
      { machineId: "n37-217-003", sessionId: "herdr-1", source: "link-click" },
      onlineTimeoutHarness.deps,
    );
    expect(showHostSyncTimeoutToast).toHaveBeenCalledWith("DevBox");
    expect(onlineTimeoutHarness.showHostOfflineToast).not.toHaveBeenCalled();

    // Host that went offline during hydration wait shows host-offline toast
    let status = "connecting";
    const offlineTimeoutHarness = createDeps({
      getSessions: () => ({
        srv_devbox: makeSession("srv_devbox", { hasHydratedAgents: false }),
      }),
      getConnectionStatusByServerId: () => ({ srv_devbox: status }),
      waitForHostHydration: vi.fn(async () => {
        status = "offline";
      }),
      showHostSyncTimeoutToast: vi.fn(),
    });
    await openPersonaSession(
      { machineId: "n37-217-003", sessionId: "herdr-1", source: "link-click" },
      offlineTimeoutHarness.deps,
    );
    expect(offlineTimeoutHarness.showHostOfflineToast).toHaveBeenCalledWith("DevBox");
  });
});

describe("createAppOpenPersonaSessionDeps production providerRoots L3 lookup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    noopToast.show.mockClear();
    noopToast.error.mockClear();
    noopToast.copied.mockClear();
    appQueryClient.removeQueries({ queryKey: daemonConfigQueryKey("srv_devbox") });
    appQueryClient.removeQueries({ queryKey: daemonConfigQueryKey("srv_mac") });
    appQueryClient.removeQueries({ queryKey: daemonConfigQueryKey("srv_other") });
    appQueryClient.removeQueries({ queryKey: ["providersSnapshot", "srv_devbox"] });
    appQueryClient.removeQueries({ queryKey: ["providersSnapshot", "srv_mac"] });
    appQueryClient.removeQueries({ queryKey: ["providersSnapshot", "srv_other"] });
    useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  });

  function setupRuntimeHosts(hosts: Array<{ serverId: string; label: string; status: string }>) {
    const store = getHostRuntimeStore();
    vi.spyOn(store, "getHosts").mockReturnValue(
      hosts.map((host) => ({ serverId: host.serverId, label: host.label })) as ReturnType<
        typeof store.getHosts
      >,
    );
    vi.spyOn(store, "getSnapshot").mockImplementation((serverId) => {
      const matched = hosts.find((host) => host.serverId === serverId);
      if (!matched) {
        return null;
      }
      return {
        connectionStatus: matched.status,
        client: useSessionStore.getState().sessions[serverId]?.client ?? null,
      } as ReturnType<typeof store.getSnapshot>;
    });
    vi.spyOn(router, "push").mockImplementation(() => undefined);
    vi.spyOn(router, "navigate").mockImplementation(() => undefined);
  }

  const noopToast = {
    show: vi.fn(() => () => undefined),
    error: vi.fn(() => () => undefined),
    copied: vi.fn(() => () => undefined),
  };

  function delayDaemonConfig(
    config: MutableDaemonConfig,
    delayMs: number,
  ): Promise<{ config: MutableDaemonConfig }> {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve({ config });
      }, delayMs);
    });
  }

  it("derives chained extends roots with cycle protection and resolves custom providers missing metadata.provider via daemonConfig cache", async () => {
    expect(
      deriveProviderRootsFromDaemonConfig({
        "codex-sub2api": { extends: "codex" },
        "my-codex": { extends: "codex-sub2api" },
        "claude-magpie": { extends: "claude" },
        "custom-acp": { extends: "acp" },
        loopA: { extends: "loopB" },
        loopB: { extends: "loopA" },
      } as MutableDaemonConfig["providers"]),
    ).toEqual({
      "codex-sub2api": "codex",
      "my-codex": "codex",
      "claude-magpie": "claude",
      "custom-acp": "acp",
      loopA: "loopA",
      loopB: "loopB",
    });

    const codexThreadA = "11111111-2222-4333-8444-555555555555";
    const codexThreadB = "22222222-3333-4444-8555-666666666666";
    const claudeSessionId = "abcdef12-3456-4789-8abc-def012345678";
    const acpSessionId = "99999999-aaaa-4bbb-8ccc-dddddddddddd";

    const codexSub2ApiAgent = makeAgent({
      id: "ag_codex_sub2api",
      serverId: "srv_mac",
      provider: "codex-sub2api",
      workspaceId: "wks_1111111111111111",
      persistence: { provider: "codex-sub2api", sessionId: codexThreadA },
    });
    const chainedCodexAgent = makeAgent({
      id: "ag_my_codex",
      serverId: "srv_mac",
      provider: "my-codex",
      workspaceId: "wks_1111111111111111",
      persistence: null,
      runtimeInfo: { provider: "my-codex", sessionId: codexThreadB },
    });
    const claudeMagpieAgent = makeAgent({
      id: "ag_claude_magpie",
      serverId: "srv_devbox",
      provider: "claude-magpie",
      workspaceId: "wks_2222222222222222",
      persistence: null,
      runtimeInfo: { provider: "claude-magpie", sessionId: claudeSessionId },
    });
    const customAcpAgent = makeAgent({
      id: "ag_custom_acp",
      serverId: "srv_devbox",
      provider: "custom-acp",
      workspaceId: "wks_2222222222222222",
      persistence: null,
      runtimeInfo: { provider: "custom-acp", sessionId: acpSessionId },
    });

    useSessionStore.setState({
      sessions: {
        srv_mac: makeSession("srv_mac", {
          serverInfo: { serverId: "srv_mac", hostname: "ML9YK34K66", version: "0.17.533" },
          agents: new Map([
            [codexSub2ApiAgent.id, codexSub2ApiAgent],
            [chainedCodexAgent.id, chainedCodexAgent],
          ]),
        }),
        srv_devbox: makeSession("srv_devbox", {
          serverInfo: { serverId: "srv_devbox", hostname: "n37-217-003", version: "0.17.533" },
          agents: new Map([
            [claudeMagpieAgent.id, claudeMagpieAgent],
            [customAcpAgent.id, customAcpAgent],
          ]),
        }),
      },
      agentLastActivity: new Map(),
    });
    setupRuntimeHosts([
      { serverId: "srv_mac", label: "MacBook", status: "online" },
      { serverId: "srv_devbox", label: "DevBox", status: "online" },
    ]);

    appQueryClient.setQueryData(daemonConfigQueryKey("srv_mac"), {
      providers: {
        "codex-sub2api": { extends: "codex" },
        "my-codex": { extends: "codex-sub2api" },
      },
    } as unknown as MutableDaemonConfig);
    appQueryClient.setQueryData(daemonConfigQueryKey("srv_devbox"), {
      providers: {
        "claude-magpie": { extends: "claude" },
        "custom-acp": { extends: "acp" },
      },
    } as unknown as MutableDaemonConfig);

    const deps = createAppOpenPersonaSessionDeps({
      toast: noopToast,
      isCompact: false,
    });

    expect(deps.getProviderRootsByServerId?.()).toEqual({
      srv_mac: { "codex-sub2api": "codex", "my-codex": "codex" },
      srv_devbox: { "claude-magpie": "claude", "custom-acp": "acp" },
    });

    const macSub2ApiResult = await openPersonaSession(
      { machineId: "ML9YK34K66", sessionId: codexThreadA, source: "link-click" },
      deps,
    );
    expect(macSub2ApiResult.handled).toBe(true);
    expect(macSub2ApiResult.resolution).toEqual({
      kind: "agent",
      level: "provider_thread_id",
      serverId: "srv_mac",
      agentId: "ag_codex_sub2api",
      workspaceId: "wks_1111111111111111",
      archived: false,
      panel: null,
    });

    const macChainedResult = await openPersonaSession(
      { machineId: "ML9YK34K66", sessionId: codexThreadB, source: "link-click" },
      deps,
    );
    expect(macChainedResult.handled).toBe(true);
    expect(macChainedResult.resolution).toEqual({
      kind: "agent",
      level: "provider_thread_id",
      serverId: "srv_mac",
      agentId: "ag_my_codex",
      workspaceId: "wks_1111111111111111",
      archived: false,
      panel: null,
    });

    const devboxClaudeResult = await openPersonaSession(
      { machineId: "n37-217-003", sessionId: claudeSessionId, source: "header-button" },
      deps,
    );
    expect(devboxClaudeResult.handled).toBe(true);
    expect(devboxClaudeResult.resolution).toEqual({
      kind: "agent",
      level: "provider_thread_id",
      serverId: "srv_devbox",
      agentId: "ag_claude_magpie",
      workspaceId: "wks_2222222222222222",
      archived: false,
      panel: null,
    });

    // Non-claude/codex custom provider (`extends: "acp"`) MUST NOT falsely match L3.
    const acpResult = await openPersonaSession(
      { machineId: "n37-217-003", sessionId: acpSessionId, source: "header-button" },
      deps,
    );
    expect(acpResult.handled).toBe(false);
    expect(acpResult.resolution).toEqual({
      kind: "unresolved",
      reason: "not_found",
      machineId: "n37-217-003",
      sessionId: acpSessionId,
      resolvedServerId: "srv_devbox",
    });
  });

  it("does not short-circuit on L3 hit under cold cache and returns ambiguous_machine when unmapped dual online hosts share the same thread", async () => {
    const sharedThread = "33333333-4444-4555-8666-777777777777";
    const macCodexAgent = makeAgent({
      id: "ag_mac_builtin_codex",
      serverId: "srv_mac",
      provider: "codex",
      workspaceId: "wks_1111111111111111",
      persistence: { provider: "codex", sessionId: sharedThread },
    });
    const otherCustomCodexAgent = makeAgent({
      id: "ag_other_my_codex",
      serverId: "srv_other",
      provider: "my-codex",
      workspaceId: "wks_2222222222222222",
      persistence: null,
      runtimeInfo: { provider: "my-codex", sessionId: sharedThread },
    });

    const macGetDaemonConfig = vi.fn(async () => ({
      config: { providers: {} } as unknown as MutableDaemonConfig,
    }));
    const otherGetDaemonConfig = vi.fn(async () => ({
      config: {
        providers: {
          "my-codex": { extends: "codex" },
        },
      } as unknown as MutableDaemonConfig,
    }));

    useSessionStore.setState({
      sessions: {
        srv_mac: makeSession("srv_mac", {
          client: { getDaemonConfig: macGetDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_mac", hostname: "ML9YK34K66", version: "0.17.533" },
          agents: new Map([[macCodexAgent.id, macCodexAgent]]),
        }),
        srv_other: makeSession("srv_other", {
          client: { getDaemonConfig: otherGetDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_other", hostname: "other-workstation", version: "0.17.533" },
          agents: new Map([[otherCustomCodexAgent.id, otherCustomCodexAgent]]),
        }),
      },
      agentLastActivity: new Map(),
    });
    setupRuntimeHosts([
      { serverId: "srv_mac", label: "MacBook", status: "online" },
      { serverId: "srv_other", label: "Other Host", status: "online" },
    ]);

    const deps = createAppOpenPersonaSessionDeps({
      toast: noopToast,
      isCompact: false,
    });

    const result = await openPersonaSession(
      {
        machineId: "unmapped-workstation",
        sessionId: sharedThread,
        source: "link-click",
      },
      deps,
    );

    expect(otherGetDaemonConfig).toHaveBeenCalledTimes(1);
    expect(macGetDaemonConfig).not.toHaveBeenCalled();
    expect(result.handled).toBe(false);
    expect(result.resolution).toEqual({
      kind: "unresolved",
      reason: "ambiguous_machine",
      machineId: "unmapped-workstation",
      sessionId: sharedThread,
      resolvedServerId: null,
      candidateServerIds: ["srv_mac", "srv_other"],
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(noopToast.show).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ testID: "persona-ambiguous-machine-toast" }),
    );
    expect(appQueryClient.getQueryData(daemonConfigQueryKey("srv_other"))).toBeDefined();
  });

  it("never misclassifies an acp custom provider declaring auto-review/full-access modes as codex under cold cache", async () => {
    const acpThread = "44444444-5555-4666-8777-888888888888";
    const claudeLikeAcpSid = "fedcba98-7654-4321-8fed-cba987654321";

    const acpCodexModesAgent = makeAgent({
      id: "ag_acp_codex_modes",
      serverId: "srv_devbox",
      provider: "custom-acp",
      workspaceId: "wks_3333333333333333",
      persistence: null,
      runtimeInfo: { provider: "custom-acp", sessionId: acpThread },
      availableModes: [
        { id: "auto", label: "Default" },
        { id: "auto-review", label: "Auto-review" },
        { id: "full-access", label: "Full Access" },
      ],
    });
    const acpClaudeModesAgent = makeAgent({
      id: "ag_acp_claude_modes",
      serverId: "srv_devbox",
      provider: "custom-acp-claude-modes",
      workspaceId: "wks_3333333333333333",
      persistence: null,
      runtimeInfo: { provider: "custom-acp-claude-modes", sessionId: claudeLikeAcpSid },
      availableModes: [
        { id: "default", label: "Always Ask" },
        { id: "acceptEdits", label: "Accept File Edits" },
        { id: "bypassPermissions", label: "Bypass" },
      ],
    });

    const getDaemonConfig = vi.fn(async () => ({
      config: {
        providers: {
          "custom-acp": { extends: "acp" },
          "custom-acp-claude-modes": { extends: "acp" },
        },
      } as unknown as MutableDaemonConfig,
    }));

    useSessionStore.setState({
      sessions: {
        srv_devbox: makeSession("srv_devbox", {
          client: { getDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_devbox", hostname: "n37-217-003", version: "0.17.533" },
          agents: new Map([
            [acpCodexModesAgent.id, acpCodexModesAgent],
            [acpClaudeModesAgent.id, acpClaudeModesAgent],
          ]),
        }),
      },
      agentLastActivity: new Map(),
    });
    setupRuntimeHosts([{ serverId: "srv_devbox", label: "DevBox", status: "online" }]);

    // Even when providersSnapshot advertises Codex/Claude-like mode names, cold cache MUST fetch
    // authoritative daemonConfig and refuse heuristic L3 matching.
    appQueryClient.setQueryData(providersSnapshotQueryKey("srv_devbox", null), {
      entries: [
        {
          provider: "custom-acp",
          status: "ready",
          enabled: true,
          source: "custom",
          modes: [
            { id: "auto", label: "Default" },
            { id: "auto-review", label: "Auto-review" },
            { id: "full-access", label: "Full Access" },
          ],
        },
        {
          provider: "custom-acp-claude-modes",
          status: "ready",
          enabled: true,
          source: "custom",
          modes: [
            { id: "default", label: "Always Ask" },
            { id: "acceptEdits", label: "Accept File Edits" },
            { id: "bypassPermissions", label: "Bypass" },
          ],
        },
      ],
    } as unknown as GetProvidersSnapshotResponseMessage["payload"]);

    const deps = createAppOpenPersonaSessionDeps({
      toast: noopToast,
      isCompact: false,
    });

    const acpRes = await openPersonaSession(
      { machineId: "n37-217-003", sessionId: acpThread, source: "header-button" },
      deps,
    );
    expect(getDaemonConfig).toHaveBeenCalledTimes(1);
    expect(acpRes.handled).toBe(false);
    expect(acpRes.resolution).toEqual({
      kind: "unresolved",
      reason: "not_found",
      machineId: "n37-217-003",
      sessionId: acpThread,
      resolvedServerId: "srv_devbox",
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();

    // Warm cache reuses cached authoritative daemonConfig without re-fetching.
    const acpWarmRes = await openPersonaSession(
      { machineId: "n37-217-003", sessionId: claudeLikeAcpSid, source: "header-button" },
      deps,
    );
    expect(getDaemonConfig).toHaveBeenCalledTimes(1);
    expect(acpWarmRes.handled).toBe(false);
    expect(acpWarmRes.resolution).toEqual({
      kind: "unresolved",
      reason: "not_found",
      machineId: "n37-217-003",
      sessionId: claudeLikeAcpSid,
      resolvedServerId: "srv_devbox",
    });

    // When authoritative daemonConfig cannot be loaded at all, unknown custom providers MUST NOT
    // participate in L3 guesswork matching via availableModes or providersSnapshot.
    appQueryClient.removeQueries({ queryKey: daemonConfigQueryKey("srv_devbox") });
    useSessionStore.setState({
      sessions: {
        srv_devbox: makeSession("srv_devbox", {
          client: null,
          serverInfo: { serverId: "srv_devbox", hostname: "n37-217-003", version: "0.17.533" },
          agents: new Map([
            [acpCodexModesAgent.id, acpCodexModesAgent],
            [acpClaudeModesAgent.id, acpClaudeModesAgent],
          ]),
        }),
      },
      agentLastActivity: new Map(),
    });

    const unconfirmedCodexModeRes = await openPersonaSession(
      { machineId: "n37-217-003", sessionId: acpThread, source: "header-button" },
      deps,
    );
    expect(unconfirmedCodexModeRes.handled).toBe(false);
    expect(unconfirmedCodexModeRes.resolution).toEqual({
      kind: "unresolved",
      reason: "not_found",
      machineId: "n37-217-003",
      sessionId: acpThread,
      resolvedServerId: "srv_devbox",
    });

    const unconfirmedClaudeModeRes = await openPersonaSession(
      { machineId: "n37-217-003", sessionId: claudeLikeAcpSid, source: "header-button" },
      deps,
    );
    expect(unconfirmedClaudeModeRes.handled).toBe(false);
    expect(unconfirmedClaudeModeRes.resolution).toEqual({
      kind: "unresolved",
      reason: "not_found",
      machineId: "n37-217-003",
      sessionId: claudeLikeAcpSid,
      resolvedServerId: "srv_devbox",
    });
  });

  it("refreshes only the mapped target host daemonConfig on an initial L3 hit without probing unrelated online hosts", async () => {
    const sharedThread = "66666666-7777-4888-8999-aaaaaaaaaaaa";
    const archivedBuiltinCodex = makeAgent({
      id: "ag_mac_archived_codex",
      serverId: "srv_mac",
      provider: "codex",
      workspaceId: "wks_1111111111111111",
      archivedAt: new Date("2026-11-24T00:00:00.000Z"),
      persistence: { provider: "codex", sessionId: sharedThread },
    });
    const activeCustomCodex = makeAgent({
      id: "ag_mac_active_my_codex",
      serverId: "srv_mac",
      provider: "my-codex",
      workspaceId: "wks_1111111111111111",
      persistence: null,
      runtimeInfo: { provider: "my-codex", sessionId: sharedThread },
    });
    const unrelatedOtherCustom = makeAgent({
      id: "ag_other_custom",
      serverId: "srv_other",
      provider: "other-codex",
      workspaceId: "wks_2222222222222222",
      persistence: null,
      runtimeInfo: { provider: "other-codex", sessionId: sharedThread },
    });

    const macGetDaemonConfig = vi.fn(async () => ({
      config: {
        providers: {
          "my-codex": { extends: "codex" },
        },
      } as unknown as MutableDaemonConfig,
    }));
    const otherGetDaemonConfig = vi.fn(async () => ({
      config: {
        providers: {
          "other-codex": { extends: "codex" },
        },
      } as unknown as MutableDaemonConfig,
    }));

    useSessionStore.setState({
      sessions: {
        srv_mac: makeSession("srv_mac", {
          client: { getDaemonConfig: macGetDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_mac", hostname: "ML9YK34K66", version: "0.17.533" },
          agents: new Map([
            [archivedBuiltinCodex.id, archivedBuiltinCodex],
            [activeCustomCodex.id, activeCustomCodex],
          ]),
        }),
        srv_other: makeSession("srv_other", {
          client: { getDaemonConfig: otherGetDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_other", hostname: "other-host", version: "0.17.533" },
          agents: new Map([[unrelatedOtherCustom.id, unrelatedOtherCustom]]),
        }),
      },
      agentLastActivity: new Map(),
    });
    setupRuntimeHosts([
      { serverId: "srv_mac", label: "MacBook", status: "online" },
      { serverId: "srv_other", label: "Other Host", status: "online" },
    ]);

    const deps = createAppOpenPersonaSessionDeps({
      toast: noopToast,
      isCompact: false,
    });

    const result = await openPersonaSession(
      { machineId: "ML9YK34K66", sessionId: sharedThread, source: "link-click" },
      deps,
    );

    expect(macGetDaemonConfig).toHaveBeenCalledTimes(1);
    expect(otherGetDaemonConfig).not.toHaveBeenCalled();
    expect(result.handled).toBe(true);
    expect(result.resolution).toEqual({
      kind: "agent",
      level: "provider_thread_id",
      serverId: "srv_mac",
      agentId: "ag_mac_active_my_codex",
      workspaceId: "wks_1111111111111111",
      archived: false,
      panel: null,
    });
  });

  it("fetches missing daemonConfig on demand during cold start before falling back to L4 workspace", async () => {
    const codexThread = "55555555-6666-4777-8888-999999999999";
    const ws = {
      id: "wks_4444444444444444",
      workspaceDirectory: "/data00/repo/paseo-fork",
    } as WorkspaceDescriptor;
    const coldAgent = makeAgent({
      id: "ag_cold_my_codex",
      serverId: "srv_devbox",
      provider: "my-codex",
      workspaceId: ws.id,
      persistence: null,
      runtimeInfo: { provider: "my-codex", sessionId: codexThread },
    });
    const getDaemonConfig = vi.fn(async () => ({
      config: {
        providers: {
          "my-codex": { extends: "codex" },
        },
      } as unknown as MutableDaemonConfig,
    }));

    useSessionStore.setState({
      sessions: {
        srv_devbox: makeSession("srv_devbox", {
          client: { getDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_devbox", hostname: "n37-217-003", version: "0.17.533" },
          agents: new Map([[coldAgent.id, coldAgent]]),
          workspaces: new Map([[ws.id, ws]]),
        }),
      },
      agentLastActivity: new Map(),
    });
    setupRuntimeHosts([{ serverId: "srv_devbox", label: "DevBox", status: "online" }]);

    const deps = createAppOpenPersonaSessionDeps({
      toast: noopToast,
      isCompact: false,
    });

    // Even when workspaceIdHint would satisfy L4, on-demand daemonConfig fetch resolves L3 first.
    const result = await openPersonaSession(
      {
        machineId: "n37-217-003",
        sessionId: codexThread,
        workspaceIdHint: ws.id,
        source: "link-click",
      },
      deps,
    );

    expect(getDaemonConfig).toHaveBeenCalledTimes(1);
    expect(result.handled).toBe(true);
    expect(result.resolution).toEqual({
      kind: "agent",
      level: "provider_thread_id",
      serverId: "srv_devbox",
      agentId: "ag_cold_my_codex",
      workspaceId: ws.id,
      archived: false,
      panel: null,
    });
    expect(appQueryClient.getQueryData(daemonConfigQueryKey("srv_devbox"))).toBeDefined();
  });

  it("fails closed with ambiguous_machine when a second unmapped online host holding the same thread times out on daemonConfig, and stays ambiguous on prompt retry", async () => {
    vi.useFakeTimers();
    const sharedThread = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
    const macCodexAgent = makeAgent({
      id: "ag_mac_builtin_codex",
      serverId: "srv_mac",
      provider: "codex",
      workspaceId: "wks_1111111111111111",
      persistence: { provider: "codex", sessionId: sharedThread },
    });
    const otherCustomCodexAgent = makeAgent({
      id: "ag_other_my_codex",
      serverId: "srv_other",
      provider: "my-codex",
      workspaceId: "wks_2222222222222222",
      persistence: null,
      runtimeInfo: { provider: "my-codex", sessionId: sharedThread },
    });

    const macGetDaemonConfig = vi.fn(async () => ({
      config: { providers: {} } as unknown as MutableDaemonConfig,
    }));
    const otherDaemonConfig = {
      providers: {
        "my-codex": { extends: "codex" },
      },
    } as unknown as MutableDaemonConfig;
    const otherGetDaemonConfig = vi
      .fn<() => Promise<{ config: MutableDaemonConfig }>>()
      .mockImplementationOnce(() => delayDaemonConfig(otherDaemonConfig, 1_700))
      .mockImplementationOnce(async () => ({
        config: otherDaemonConfig,
      }));

    useSessionStore.setState({
      sessions: {
        srv_mac: makeSession("srv_mac", {
          client: { getDaemonConfig: macGetDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_mac", hostname: "ML9YK34K66", version: "0.17.533" },
          agents: new Map([[macCodexAgent.id, macCodexAgent]]),
        }),
        srv_other: makeSession("srv_other", {
          client: { getDaemonConfig: otherGetDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_other", hostname: "other-workstation", version: "0.17.533" },
          agents: new Map([[otherCustomCodexAgent.id, otherCustomCodexAgent]]),
        }),
      },
      agentLastActivity: new Map(),
    });
    setupRuntimeHosts([
      { serverId: "srv_mac", label: "MacBook", status: "online" },
      { serverId: "srv_other", label: "Other Host", status: "online" },
    ]);

    const deps = createAppOpenPersonaSessionDeps({
      toast: noopToast,
      isCompact: false,
    });

    const firstClickPromise = openPersonaSession(
      {
        machineId: "unmapped-workstation",
        sessionId: sharedThread,
        source: "link-click",
      },
      deps,
    );
    await vi.advanceTimersByTimeAsync(1_500);
    const firstResult = await firstClickPromise;

    expect(otherGetDaemonConfig).toHaveBeenCalledTimes(1);
    expect(macGetDaemonConfig).not.toHaveBeenCalled();
    expect(firstResult.handled).toBe(false);
    expect(firstResult.navigatedRoute).toBeUndefined();
    expect(firstResult.resolution).toEqual({
      kind: "unresolved",
      reason: "ambiguous_machine",
      machineId: "unmapped-workstation",
      sessionId: sharedThread,
      resolvedServerId: null,
      candidateServerIds: ["srv_mac", "srv_other"],
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(noopToast.show).toHaveBeenCalledTimes(1);
    expect(noopToast.show).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ testID: "persona-ambiguous-machine-toast" }),
    );
    expect(appQueryClient.getQueryData(daemonConfigQueryKey("srv_other"))).toBeUndefined();

    // Let the timed-out 1.7s response settle and confirm it does not leak into cache.
    await vi.advanceTimersByTimeAsync(250);
    expect(appQueryClient.getQueryData(daemonConfigQueryKey("srv_other"))).toBeUndefined();

    const secondResult = await openPersonaSession(
      {
        machineId: "unmapped-workstation",
        sessionId: sharedThread,
        source: "link-click",
      },
      deps,
    );

    expect(otherGetDaemonConfig).toHaveBeenCalledTimes(2);
    expect(secondResult.handled).toBe(false);
    expect(secondResult.navigatedRoute).toBeUndefined();
    expect(secondResult.resolution).toEqual({
      kind: "unresolved",
      reason: "ambiguous_machine",
      machineId: "unmapped-workstation",
      sessionId: sharedThread,
      resolvedServerId: null,
      candidateServerIds: ["srv_mac", "srv_other"],
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(noopToast.show).toHaveBeenCalledTimes(2);
    expect(appQueryClient.getQueryData(daemonConfigQueryKey("srv_other"))).toEqual(
      otherDaemonConfig,
    );
  });

  it("fails closed with ambiguous_machine on 1.7s daemonConfig timeout when the shared thread only exists on a newer agentDetails record with null persistence", async () => {
    vi.useFakeTimers();
    const sharedThread = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
    const macCodexAgent = makeAgent({
      id: "ag_mac_builtin_codex",
      serverId: "srv_mac",
      provider: "codex",
      workspaceId: "wks_1111111111111111",
      persistence: { provider: "codex", sessionId: sharedThread },
    });
    const staleOtherDirectoryAgent = makeAgent({
      id: "ag_other_my_codex",
      serverId: "srv_other",
      provider: "my-codex",
      workspaceId: "wks_2222222222222222",
      updatedAt: new Date("2026-11-24T00:00:00.000Z"),
      lastActivityAt: new Date("2026-11-24T00:00:00.000Z"),
      persistence: null,
      runtimeInfo: undefined,
    });
    const newerOtherDetailAgent = makeAgent({
      id: "ag_other_my_codex",
      serverId: "srv_other",
      provider: "my-codex",
      workspaceId: "wks_2222222222222222",
      updatedAt: new Date("2026-11-24T00:05:00.000Z"),
      lastActivityAt: new Date("2026-11-24T00:05:00.000Z"),
      persistence: null,
      runtimeInfo: { provider: "my-codex", sessionId: sharedThread },
    });

    const macGetDaemonConfig = vi.fn(async () => ({
      config: { providers: {} } as unknown as MutableDaemonConfig,
    }));
    const otherDaemonConfig = {
      providers: {
        "my-codex": { extends: "codex" },
      },
    } as unknown as MutableDaemonConfig;
    const otherGetDaemonConfig = vi
      .fn<() => Promise<{ config: MutableDaemonConfig }>>()
      .mockImplementationOnce(() => delayDaemonConfig(otherDaemonConfig, 1_700))
      .mockImplementationOnce(async () => ({
        config: otherDaemonConfig,
      }));

    useSessionStore.setState({
      sessions: {
        srv_mac: makeSession("srv_mac", {
          client: { getDaemonConfig: macGetDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_mac", hostname: "ML9YK34K66", version: "0.17.533" },
          agents: new Map([[macCodexAgent.id, macCodexAgent]]),
        }),
        srv_other: makeSession("srv_other", {
          client: { getDaemonConfig: otherGetDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_other", hostname: "other-workstation", version: "0.17.533" },
          agents: new Map([[staleOtherDirectoryAgent.id, staleOtherDirectoryAgent]]),
          agentDetails: new Map([[newerOtherDetailAgent.id, newerOtherDetailAgent]]),
        }),
      },
      agentLastActivity: new Map(),
    });
    setupRuntimeHosts([
      { serverId: "srv_mac", label: "MacBook", status: "online" },
      { serverId: "srv_other", label: "Other Host", status: "online" },
    ]);

    const deps = createAppOpenPersonaSessionDeps({
      toast: noopToast,
      isCompact: false,
    });

    const firstClickPromise = openPersonaSession(
      {
        machineId: "unmapped-workstation",
        sessionId: sharedThread,
        source: "link-click",
      },
      deps,
    );
    await vi.advanceTimersByTimeAsync(1_500);
    const firstResult = await firstClickPromise;

    expect(otherGetDaemonConfig).toHaveBeenCalledTimes(1);
    expect(macGetDaemonConfig).not.toHaveBeenCalled();
    expect(firstResult.handled).toBe(false);
    expect(firstResult.navigatedRoute).toBeUndefined();
    expect(firstResult.resolution).toEqual({
      kind: "unresolved",
      reason: "ambiguous_machine",
      machineId: "unmapped-workstation",
      sessionId: sharedThread,
      resolvedServerId: null,
      candidateServerIds: ["srv_mac", "srv_other"],
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(noopToast.show).toHaveBeenCalledTimes(1);
    expect(noopToast.show).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ testID: "persona-ambiguous-machine-toast" }),
    );
    expect(appQueryClient.getQueryData(daemonConfigQueryKey("srv_other"))).toBeUndefined();

    // Let the timed-out 1.7s response settle and confirm it does not leak into cache.
    await vi.advanceTimersByTimeAsync(250);
    expect(appQueryClient.getQueryData(daemonConfigQueryKey("srv_other"))).toBeUndefined();

    const secondResult = await openPersonaSession(
      {
        machineId: "unmapped-workstation",
        sessionId: sharedThread,
        source: "link-click",
      },
      deps,
    );

    expect(otherGetDaemonConfig).toHaveBeenCalledTimes(2);
    expect(secondResult.handled).toBe(false);
    expect(secondResult.navigatedRoute).toBeUndefined();
    expect(secondResult.resolution).toEqual({
      kind: "unresolved",
      reason: "ambiguous_machine",
      machineId: "unmapped-workstation",
      sessionId: sharedThread,
      resolvedServerId: null,
      candidateServerIds: ["srv_mac", "srv_other"],
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(router.navigate).not.toHaveBeenCalled();
    expect(noopToast.show).toHaveBeenCalledTimes(2);
    expect(appQueryClient.getQueryData(daemonConfigQueryKey("srv_other"))).toEqual(
      otherDaemonConfig,
    );
  });

  it("still opens the first host after timeout when a second slow unmapped online host does not hold the target thread ID", async () => {
    vi.useFakeTimers();
    const targetThread = "88888888-9999-4aaa-8bbb-cccccccccccc";
    const unrelatedThread = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
    const macCodexAgent = makeAgent({
      id: "ag_mac_builtin_codex",
      serverId: "srv_mac",
      provider: "codex",
      workspaceId: "wks_1111111111111111",
      persistence: { provider: "codex", sessionId: targetThread },
    });
    const otherUnrelatedCustomAgent = makeAgent({
      id: "ag_other_unrelated_custom",
      serverId: "srv_other",
      provider: "my-codex",
      workspaceId: "wks_2222222222222222",
      persistence: null,
      runtimeInfo: { provider: "my-codex", sessionId: unrelatedThread },
    });

    const macGetDaemonConfig = vi.fn(async () => ({
      config: { providers: {} } as unknown as MutableDaemonConfig,
    }));
    const otherDaemonConfig = {
      providers: {
        "my-codex": { extends: "codex" },
      },
    } as unknown as MutableDaemonConfig;
    const otherGetDaemonConfig = vi.fn(() => delayDaemonConfig(otherDaemonConfig, 1_700));

    useSessionStore.setState({
      sessions: {
        srv_mac: makeSession("srv_mac", {
          client: { getDaemonConfig: macGetDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_mac", hostname: "ML9YK34K66", version: "0.17.533" },
          agents: new Map([[macCodexAgent.id, macCodexAgent]]),
        }),
        srv_other: makeSession("srv_other", {
          client: { getDaemonConfig: otherGetDaemonConfig } as unknown as DaemonClient,
          serverInfo: { serverId: "srv_other", hostname: "other-workstation", version: "0.17.533" },
          agents: new Map([[otherUnrelatedCustomAgent.id, otherUnrelatedCustomAgent]]),
        }),
      },
      agentLastActivity: new Map(),
    });
    setupRuntimeHosts([
      { serverId: "srv_mac", label: "MacBook", status: "online" },
      { serverId: "srv_other", label: "Other Host", status: "online" },
    ]);

    const deps = createAppOpenPersonaSessionDeps({
      toast: noopToast,
      isCompact: false,
    });

    const openPromise = openPersonaSession(
      {
        machineId: "unmapped-workstation",
        sessionId: targetThread,
        source: "link-click",
      },
      deps,
    );
    await vi.advanceTimersByTimeAsync(1_500);
    const result = await openPromise;

    expect(otherGetDaemonConfig).toHaveBeenCalledTimes(1);
    expect(macGetDaemonConfig).not.toHaveBeenCalled();
    expect(result.handled).toBe(true);
    expect(result.navigatedRoute).toBe("/h/srv_mac/workspace/wks_1111111111111111");
    expect(result.resolution).toEqual({
      kind: "agent",
      level: "provider_thread_id",
      serverId: "srv_mac",
      agentId: "ag_mac_builtin_codex",
      workspaceId: "wks_1111111111111111",
      archived: false,
      panel: null,
    });
    expect(noopToast.show).not.toHaveBeenCalled();
    expect(appQueryClient.getQueryData(daemonConfigQueryKey("srv_other"))).toBeUndefined();

    await vi.advanceTimersByTimeAsync(250);
  });

  it("fails closed when ensureProviderRoots throws and another unmapped host matches via persistence.metadata.threadId, without blocking explicitly mapped machines", async () => {
    const sharedThread = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const hostACodex = makeAgent({
      id: "ag_a_codex",
      serverId: "srv_a",
      provider: "codex",
      workspaceId: "wks_1111111111111111",
      persistence: { provider: "codex", sessionId: sharedThread },
    });
    const hostBCustomThread = makeAgent({
      id: "ag_b_custom_thread",
      serverId: "srv_b",
      provider: "custom-codex-b",
      workspaceId: "wks_2222222222222222",
      persistence: {
        provider: "custom-codex-b",
        sessionId: "other-session-id",
        metadata: { threadId: sharedThread },
      },
    });
    const hostCCustomSession = makeAgent({
      id: "ag_c_custom_session",
      serverId: "srv_c",
      provider: "custom-codex-c",
      workspaceId: "wks_3333333333333333",
      persistence: {
        provider: "custom-codex-c",
        sessionId: sharedThread,
      },
    });

    const sessions = {
      srv_a: makeSession("srv_a", {
        serverInfo: { serverId: "srv_a", hostname: "host-a", version: "0.17.533" },
        agents: new Map([[hostACodex.id, hostACodex]]),
      }),
      srv_b: makeSession("srv_b", {
        serverInfo: { serverId: "srv_b", hostname: "host-b", version: "0.17.533" },
        agents: new Map([[hostBCustomThread.id, hostBCustomThread]]),
      }),
      srv_c: makeSession("srv_c", {
        serverInfo: { serverId: "srv_c", hostname: "host-c", version: "0.17.533" },
        agents: new Map([[hostCCustomSession.id, hostCCustomSession]]),
      }),
    };
    const hosts = [
      { serverId: "srv_a", label: "Host A" },
      { serverId: "srv_b", label: "Host B" },
      { serverId: "srv_c", label: "Host C" },
    ];
    const showAmbiguousMachineToast = vi.fn();
    const throwingEnsure = vi.fn(async () => {
      throw new Error("rpc failed");
    });

    const unmappedHarness = createDeps({
      getHosts: () => hosts,
      getSessions: () => sessions,
      getConnectionStatusByServerId: () => ({ srv_a: "online", srv_b: "online", srv_c: "online" }),
      hasDaemonConfigCache: () => false,
      ensureProviderRoots: throwingEnsure,
      showAmbiguousMachineToast,
    });

    const unmappedResult = await openPersonaSession(
      { machineId: "unmapped-machine", sessionId: sharedThread, source: "link-click" },
      unmappedHarness.deps,
    );

    expect(throwingEnsure).toHaveBeenCalledWith(["srv_b", "srv_c"]);
    expect(unmappedResult.handled).toBe(false);
    expect(unmappedResult.resolution).toEqual({
      kind: "unresolved",
      reason: "ambiguous_machine",
      machineId: "unmapped-machine",
      sessionId: sharedThread,
      resolvedServerId: null,
      candidateServerIds: ["srv_a", "srv_b", "srv_c"],
    });
    expect(unmappedHarness.navigateToAgent).not.toHaveBeenCalled();
    expect(showAmbiguousMachineToast).toHaveBeenCalledWith(
      expect.objectContaining({
        machineId: "unmapped-machine",
        candidateServerIds: ["srv_a", "srv_b", "srv_c"],
      }),
    );

    // Explicitly mapped machine MUST NOT be blocked by another slow/failing host with the same thread.
    const mappedEnsure = vi.fn(async () => false);
    const mappedHarness = createDeps({
      getMachineServerMap: () => ({ "mapped-alias": "srv_a" }),
      getHosts: () => hosts,
      getSessions: () => sessions,
      getConnectionStatusByServerId: () => ({ srv_a: "online", srv_b: "online", srv_c: "online" }),
      hasDaemonConfigCache: () => false,
      ensureProviderRoots: mappedEnsure,
      showAmbiguousMachineToast: vi.fn(),
    });

    const mappedResult = await openPersonaSession(
      { machineId: "mapped-alias", sessionId: sharedThread, source: "link-click" },
      mappedHarness.deps,
    );

    expect(mappedEnsure).not.toHaveBeenCalled();
    expect(mappedResult.handled).toBe(true);
    expect(mappedResult.resolution).toEqual({
      kind: "agent",
      level: "provider_thread_id",
      serverId: "srv_a",
      agentId: "ag_a_codex",
      workspaceId: "wks_1111111111111111",
      archived: false,
      panel: null,
    });
    expect(mappedHarness.navigateToAgent).toHaveBeenCalledTimes(1);
  });

  it("isolates machineServerMap lookup strictly by hubId when multiple Persona Hubs share a machine_id", async () => {
    const sharedClaudeSessionId = "11111111-2222-4333-8444-555555555555";
    const wsA = {
      id: "wks_1111111111111111",
      workspaceDirectory: "/repo/hub-a",
    } as WorkspaceDescriptor;
    const wsB = {
      id: "wks_2222222222222222",
      workspaceDirectory: "/repo/hub-b",
    } as WorkspaceDescriptor;
    const agentA = makeAgent({
      id: "ag_hub_a",
      serverId: "srv_a",
      workspaceId: wsA.id,
      persistence: { provider: "claude", sessionId: sharedClaudeSessionId },
    });
    const agentB = makeAgent({
      id: "ag_hub_b",
      serverId: "srv_b",
      workspaceId: wsB.id,
      persistence: { provider: "claude", sessionId: sharedClaudeSessionId },
    });

    appQueryClient.setQueryData(APP_SETTINGS_QUERY_KEY, {
      ...DEFAULT_CLIENT_SETTINGS,
      persona: normalizePersonaEmbedSettings({
        enabled: true,
        hubs: [
          {
            id: "hub-a",
            name: "Work Hub",
            hubUrl: "http://10.0.0.1:18660",
            machineServerMap: { "shared-machine": "srv_a" },
          },
          {
            id: "hub-b",
            name: "Home Hub",
            hubUrl: "http://127.0.0.1:18661",
            machineServerMap: { "shared-machine": "srv_b" },
          },
        ],
        activeHubId: "hub-a",
      }),
    });

    useSessionStore.setState({
      sessions: {
        srv_a: makeSession("srv_a", {
          serverInfo: { serverId: "srv_a", hostname: "work-box", version: "0.17.535" },
          workspaces: new Map([[wsA.id, wsA]]),
          agents: new Map([[agentA.id, agentA]]),
        }),
        srv_b: makeSession("srv_b", {
          serverInfo: { serverId: "srv_b", hostname: "home-box", version: "0.17.535" },
          workspaces: new Map([[wsB.id, wsB]]),
          agents: new Map([[agentB.id, agentB]]),
        }),
      },
    });
    setupRuntimeHosts([
      { serverId: "srv_a", label: "Work DevBox", status: "online" },
      { serverId: "srv_b", label: "Home Mac", status: "online" },
    ]);

    const depsHubA = createAppOpenPersonaSessionDeps({
      toast: noopToast,
      isCompact: false,
      hubId: "hub-a",
    });
    const depsHubB = createAppOpenPersonaSessionDeps({
      toast: noopToast,
      isCompact: false,
      hubId: "hub-b",
    });

    const resA = await openPersonaSession(
      { machineId: "shared-machine", sessionId: sharedClaudeSessionId, source: "link-click" },
      depsHubA,
    );
    const resB = await openPersonaSession(
      { machineId: "shared-machine", sessionId: sharedClaudeSessionId, source: "link-click" },
      depsHubB,
    );

    expect(resA.handled).toBe(true);
    expect(resA.resolution).toMatchObject({
      kind: "agent",
      serverId: "srv_a",
      agentId: "ag_hub_a",
    });
    expect(resB.handled).toBe(true);
    expect(resB.resolution).toMatchObject({
      kind: "agent",
      serverId: "srv_b",
      agentId: "ag_hub_b",
    });
    appQueryClient.removeQueries({ queryKey: APP_SETTINGS_QUERY_KEY });
  });
});
