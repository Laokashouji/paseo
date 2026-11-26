import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES } from "@/hooks/use-settings/storage";
import type { Agent, SessionState, WorkspaceDescriptor } from "@/stores/session-store";
import {
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
