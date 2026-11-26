import { describe, expect, it, vi } from "vitest";
import { DEFAULT_OPEN_IN_SIDE_PANE_PREFERENCES } from "@/hooks/use-settings/storage";
import type { Agent, SessionState, WorkspaceDescriptor } from "@/stores/session-store";
import { openPersonaSession, type OpenPersonaSessionDeps } from "./open-persona-session";

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
});
