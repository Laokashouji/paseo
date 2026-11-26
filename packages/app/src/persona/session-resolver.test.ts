import { describe, expect, it } from "vitest";
import type { Agent, SessionState, WorkspaceDescriptor } from "@/stores/session-store";
import { resolveMachineToServerId, resolvePersonaSession } from "./session-resolver";

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

function makeWorkspace(
  overrides: Partial<WorkspaceDescriptor> & { id: string },
): WorkspaceDescriptor {
  return {
    createdAt: new Date("2026-11-24T00:00:00.000Z"),
    lastUserMessageAt: null,
    projectId: "proj_1",
    projectDisplayName: "paseo-fork",
    projectRootPath: "/data00/repo/paseo-fork",
    workspaceDirectory: "/data00/repo/paseo-fork",
    projectKind: "git",
    workspaceKind: "checkout",
    name: "main",
    status: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
    ...overrides,
  };
}

function makeSession(serverId: string, partial: Partial<SessionState> = {}): SessionState {
  return {
    serverId,
    client: null,
    clientGeneration: 1,
    viewedTimelineSync: null,
    serverInfo: { serverId, hostname: null, version: "0.17.532" },
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

describe("resolveMachineToServerId", () => {
  const hosts = [
    { serverId: "srv_devbox", label: "DevBox Label" },
    { serverId: "srv_mac", label: "MacBook" },
  ];

  const sessions = {
    srv_devbox: makeSession("srv_devbox", {
      serverInfo: { serverId: "srv_devbox", hostname: "n37-217-003", version: "0.17.532" },
    }),
    srv_mac: makeSession("srv_mac", {
      serverInfo: { serverId: "srv_mac", hostname: "ML9YK34K66", version: "0.17.532" },
    }),
  };

  it("prioritizes explicit map > hostname > label > serverId", () => {
    // Explicit map overrides hostname & label
    expect(
      resolveMachineToServerId({
        machineId: "n37-217-003",
        machineServerMap: { "n37-217-003": "srv_mac" },
        hosts,
        sessions,
      }),
    ).toEqual({ serverId: "srv_mac", source: "explicit_map" });

    // Hostname match (case-insensitive)
    expect(
      resolveMachineToServerId({
        machineId: "N37-217-003",
        machineServerMap: {},
        hosts,
        sessions,
      }),
    ).toEqual({ serverId: "srv_devbox", source: "hostname" });

    // Label match (case-insensitive)
    expect(
      resolveMachineToServerId({
        machineId: "macbook",
        machineServerMap: {},
        hosts,
        sessions,
      }),
    ).toEqual({ serverId: "srv_mac", source: "label" });

    // Direct serverId match
    expect(
      resolveMachineToServerId({
        machineId: "srv_devbox",
        machineServerMap: {},
        hosts,
        sessions,
      }),
    ).toEqual({ serverId: "srv_devbox", source: "server_id" });

    // Unknown machine
    expect(
      resolveMachineToServerId({
        machineId: "unknown-box",
        machineServerMap: { "unknown-box": "srv_nonexistent" },
        hosts,
        sessions,
      }),
    ).toEqual({ serverId: null, source: "none" });
  });
});

describe("resolvePersonaSession (4-level resolver)", () => {
  const hosts = [{ serverId: "srv_devbox", label: "n37-217-003" }];
  const onlineStatus = { srv_devbox: "online" };

  it("Level 1: matches labels['persona.session'] including persona.kept='1' fork records and beats Level 2/3", () => {
    const claudeUuid = "11111111-2222-3333-4444-555555555555";
    const archivedMatch = makeAgent({
      id: "ag_old",
      serverId: "srv_devbox",
      workspaceId: "wks_0123456789abcdef",
      archivedAt: new Date("2026-11-24T01:00:00.000Z"),
      updatedAt: new Date("2026-11-26T12:00:00.000Z"),
      labels: { "persona.session": claudeUuid },
    });
    const forkedActiveMatch = makeAgent({
      id: "ag_forked",
      serverId: "srv_devbox",
      workspaceId: "wks_0123456789abcdef",
      updatedAt: new Date("2026-11-25T12:00:00.000Z"),
      labels: { "persona.session": claudeUuid, "persona.kept": "1" },
      persistence: { provider: "claude", sessionId: "99999999-aaaa-bbbb-cccc-dddddddddddd" },
    });
    const level3Match = makeAgent({
      id: "ag_l3",
      serverId: "srv_devbox",
      workspaceId: "wks_0123456789abcdef",
      updatedAt: new Date("2026-11-26T15:00:00.000Z"),
      persistence: { provider: "claude", sessionId: claudeUuid },
    });

    const session = makeSession("srv_devbox", {
      agents: new Map([
        [archivedMatch.id, archivedMatch],
        [forkedActiveMatch.id, forkedActiveMatch],
        [level3Match.id, level3Match],
      ]),
    });

    const res = resolvePersonaSession({
      request: {
        machineId: "n37-217-003",
        sessionId: claudeUuid,
        panel: "diff",
        source: "header-button",
      },
      machineServerMap: {},
      hosts,
      sessions: { srv_devbox: session },
      connectionStatusByServerId: onlineStatus,
    });

    expect(res).toEqual({
      kind: "agent",
      level: "label_persona_session",
      serverId: "srv_devbox",
      agentId: "ag_forked",
      workspaceId: "wks_0123456789abcdef",
      archived: false,
      panel: "diff",
    });
  });

  it("Level 2: matches paseo-<agentId> in memory or triggers agent_remote_lookup when absent", () => {
    const codexAgent = makeAgent({
      id: "ag_codex_42",
      serverId: "srv_devbox",
      provider: "codex",
      workspaceId: "wks_abcdef0123456789",
    });
    const session = makeSession("srv_devbox", {
      agents: new Map([[codexAgent.id, codexAgent]]),
    });

    expect(
      resolvePersonaSession({
        request: {
          machineId: "n37-217-003",
          sessionId: "paseo-ag_codex_42",
          source: "link-click",
        },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: session },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toEqual({
      kind: "agent",
      level: "paseo_prefix_agent_id",
      serverId: "srv_devbox",
      agentId: "ag_codex_42",
      workspaceId: "wks_abcdef0123456789",
      archived: false,
      panel: null,
    });

    // Missing from memory (even if host is offline) -> agent_remote_lookup so HostAgentReadyRoute can wait/fetch
    expect(
      resolvePersonaSession({
        request: {
          machineId: "n37-217-003",
          sessionId: "paseo-ag_missing_99",
          panel: "diff",
          source: "link-click",
        },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: session },
        connectionStatusByServerId: { srv_devbox: "offline" },
      }),
    ).toEqual({
      kind: "agent_remote_lookup",
      level: "paseo_prefix_agent_id",
      serverId: "srv_devbox",
      agentId: "ag_missing_99",
      panel: "diff",
    });
  });

  it("Level 3: matches Claude persistence/runtimeInfo sessionId and Codex metadata.threadId", () => {
    const claudeSid = "a1b2c3d4-e5f6-4789-9abc-def012345678";
    const codexTid = "f0e1d2c3-b4a5-4678-89ab-0123456789ab";

    const claudeAgent = makeAgent({
      id: "ag_claude",
      serverId: "srv_devbox",
      workspaceId: "wks_1111111111111111",
      runtimeInfo: { provider: "claude", sessionId: claudeSid },
    });
    const codexAgent = makeAgent({
      id: "ag_codex",
      serverId: "srv_devbox",
      provider: "codex",
      workspaceId: "wks_2222222222222222",
      persistence: {
        provider: "codex",
        sessionId: "other-id",
        metadata: { threadId: codexTid },
      },
    });
    const session = makeSession("srv_devbox", {
      agents: new Map([
        [claudeAgent.id, claudeAgent],
        [codexAgent.id, codexAgent],
      ]),
    });

    expect(
      resolvePersonaSession({
        request: { machineId: "n37-217-003", sessionId: claudeSid, source: "link-click" },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: session },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toMatchObject({
      kind: "agent",
      level: "provider_thread_id",
      agentId: "ag_claude",
    });

    expect(
      resolvePersonaSession({
        request: { machineId: "n37-217-003", sessionId: codexTid, source: "link-click" },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: session },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toMatchObject({
      kind: "agent",
      level: "provider_thread_id",
      agentId: "ag_codex",
    });
  });

  it("guards against cold-start Replica Cache with persistence === null by returning pending_hydration", () => {
    const claudeSid = "a1b2c3d4-e5f6-4789-9abc-def012345678";
    const coldCachedAgent = makeAgent({
      id: "ag_cold",
      serverId: "srv_devbox",
      persistence: null,
    });
    const unhydratedSession = makeSession("srv_devbox", {
      hasHydratedAgents: false,
      agents: new Map([[coldCachedAgent.id, coldCachedAgent]]),
    });

    expect(
      resolvePersonaSession({
        request: { machineId: "n37-217-003", sessionId: claudeSid, source: "link-click" },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: unhydratedSession },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toEqual({
      kind: "pending_hydration",
      serverId: "srv_devbox",
      reason: "agents_not_hydrated",
    });
  });

  it("Level 4: falls back to workspace by workspaceIdHint or normalized cwdHint", () => {
    const ws = makeWorkspace({
      id: "wks_0123456789abcdef",
      workspaceDirectory: "/data00/repo/paseo-fork",
    });
    const session = makeSession("srv_devbox", {
      workspaces: new Map([[ws.id, ws]]),
    });

    expect(
      resolvePersonaSession({
        request: {
          machineId: "n37-217-003",
          sessionId: "unknown-session-1",
          workspaceIdHint: "wks_0123456789abcdef",
          panel: "diff",
          source: "link-click",
        },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: session },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toEqual({
      kind: "workspace",
      level: "workspace_fallback",
      serverId: "srv_devbox",
      workspaceId: "wks_0123456789abcdef",
      panel: "diff",
    });

    expect(
      resolvePersonaSession({
        request: {
          machineId: "n37-217-003",
          sessionId: "unknown-session-2",
          cwdHint: "/data00/repo/paseo-fork/",
          source: "link-click",
        },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: session },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toEqual({
      kind: "workspace",
      level: "workspace_fallback",
      serverId: "srv_devbox",
      workspaceId: "wks_0123456789abcdef",
      panel: null,
    });
  });

  it("returns unresolved reasons accurately (unmapped_machine, host_offline, not_found)", () => {
    const emptySession = makeSession("srv_devbox");

    expect(
      resolvePersonaSession({
        request: { machineId: "other-machine", sessionId: "non-existent", source: "link-click" },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: emptySession },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toEqual({
      kind: "unresolved",
      reason: "unmapped_machine",
      machineId: "other-machine",
      sessionId: "non-existent",
      resolvedServerId: null,
    });

    expect(
      resolvePersonaSession({
        request: { machineId: "n37-217-003", sessionId: "herdr-session-1", source: "link-click" },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: emptySession },
        connectionStatusByServerId: { srv_devbox: "offline" },
      }),
    ).toEqual({
      kind: "unresolved",
      reason: "host_offline",
      machineId: "n37-217-003",
      sessionId: "herdr-session-1",
      resolvedServerId: "srv_devbox",
    });

    expect(
      resolvePersonaSession({
        request: { machineId: "n37-217-003", sessionId: "herdr-session-1", source: "link-click" },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: emptySession },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toEqual({
      kind: "unresolved",
      reason: "not_found",
      machineId: "n37-217-003",
      sessionId: "herdr-session-1",
      resolvedServerId: "srv_devbox",
    });
  });

  it("Level 1 & Level 3: enforces Persona SESSION_ID rules and canonical provider-specific IDs without accepting discarded IDs", () => {
    const uuidA = "11111111-2222-4333-8444-555555555555";
    const uuidB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const uuidC = "99999999-8888-4777-8666-555555555555";

    const codexAgent = makeAgent({
      id: "ag_codex",
      serverId: "srv_devbox",
      provider: "codex-sub2api",
      workspaceId: "wks_0123456789abcdef",
      persistence: {
        provider: "codex-sub2api",
        sessionId: uuidB,
        metadata: { provider: "codex", threadId: uuidA },
      },
      runtimeInfo: { provider: "codex-sub2api", sessionId: uuidC },
    });

    const claudeAgent = makeAgent({
      id: "ag_claude",
      serverId: "srv_devbox",
      provider: "claude",
      workspaceId: "wks_0123456789abcdef",
      persistence: {
        provider: "claude",
        sessionId: uuidB,
        metadata: { threadId: uuidC },
      },
      runtimeInfo: { provider: "claude", sessionId: uuidC },
    });

    const opencodeAgent = makeAgent({
      id: "ag_opencode",
      serverId: "srv_devbox",
      provider: "opencode",
      workspaceId: "wks_0123456789abcdef",
      persistence: { provider: "opencode", sessionId: uuidC },
    });

    const invalidLabelAgent = makeAgent({
      id: "ag_invalid_label",
      serverId: "srv_devbox",
      labels: { "persona.session": "-leading-dash-invalid" },
    });

    const session = makeSession("srv_devbox", {
      agents: new Map([
        [codexAgent.id, codexAgent],
        [claudeAgent.id, claudeAgent],
        [opencodeAgent.id, opencodeAgent],
        [invalidLabelAgent.id, invalidLabelAgent],
      ]),
    });

    // Codex canonical ID is metadata.threadId (uuidA); discarded persistence.sessionId (uuidB) MUST NOT match codexAgent
    expect(
      resolvePersonaSession({
        request: { machineId: "n37-217-003", sessionId: uuidA, source: "link-click" },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: session },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toMatchObject({ kind: "agent", level: "provider_thread_id", agentId: "ag_codex" });

    // uuidB matches claudeAgent (its canonical persistence.sessionId), NEVER codexAgent
    expect(
      resolvePersonaSession({
        request: { machineId: "n37-217-003", sessionId: uuidB, source: "link-click" },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: session },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toMatchObject({ kind: "agent", level: "provider_thread_id", agentId: "ag_claude" });

    // uuidC is discarded by both claudeAgent (runtimeInfo after valid persistence) and codexAgent,
    // and opencode is neither Claude nor Codex -> MUST NOT match any agent
    expect(
      resolvePersonaSession({
        request: { machineId: "n37-217-003", sessionId: uuidC, source: "link-click" },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: session },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toEqual({
      kind: "unresolved",
      reason: "not_found",
      machineId: "n37-217-003",
      sessionId: uuidC,
      resolvedServerId: "srv_devbox",
    });

    // Custom codex provider resolved via providerRootsByServerId falls back to persistence.sessionId when threadId absent
    const customCodexNoThread = makeAgent({
      id: "ag_codex_custom",
      serverId: "srv_devbox",
      provider: "my-codex",
      persistence: { provider: "my-codex", sessionId: uuidC },
    });
    const customSession = makeSession("srv_devbox", {
      agents: new Map([[customCodexNoThread.id, customCodexNoThread]]),
    });
    expect(
      resolvePersonaSession({
        request: { machineId: "n37-217-003", sessionId: uuidC, source: "link-click" },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: customSession },
        connectionStatusByServerId: onlineStatus,
        providerRootsByServerId: { srv_devbox: { "my-codex": "codex" } },
      }),
    ).toMatchObject({ kind: "agent", level: "provider_thread_id", agentId: "ag_codex_custom" });

    // Invalid Level-1 persona.session label value (fails Persona SESSION_ID regex) is rejected
    expect(
      resolvePersonaSession({
        request: {
          machineId: "n37-217-003",
          sessionId: "-leading-dash-invalid",
          source: "link-click",
        },
        machineServerMap: {},
        hosts,
        sessions: { srv_devbox: session },
        connectionStatusByServerId: onlineStatus,
      }),
    ).toEqual({
      kind: "unresolved",
      reason: "not_found",
      machineId: "n37-217-003",
      sessionId: "-leading-dash-invalid",
      resolvedServerId: "srv_devbox",
    });
  });

  it("unmapped machine: compares tiers globally across hosts, rejects ambiguous ties, and disables Level-4 workspace fallback", () => {
    const sharedUuid = "12345678-1234-4123-8123-1234567890ab";
    const multiHosts = [
      { serverId: "srv_a", label: "Host A" },
      { serverId: "srv_b", label: "Host B" },
    ];

    // Host A has Level-3 match, Host B has exact Level-1 match -> Host B MUST win regardless of order
    const sessionAL3 = makeSession("srv_a", {
      serverInfo: { serverId: "srv_a", hostname: "host-a", version: "0.17.533" },
      agents: new Map([
        [
          "ag_a",
          makeAgent({
            id: "ag_a",
            serverId: "srv_a",
            provider: "claude",
            persistence: { provider: "claude", sessionId: sharedUuid },
          }),
        ],
      ]),
    });
    const sessionBL1 = makeSession("srv_b", {
      serverInfo: { serverId: "srv_b", hostname: "host-b", version: "0.17.533" },
      agents: new Map([
        [
          "ag_b",
          makeAgent({
            id: "ag_b",
            serverId: "srv_b",
            labels: { "persona.session": sharedUuid },
          }),
        ],
      ]),
    });

    expect(
      resolvePersonaSession({
        request: { machineId: "unmapped-box", sessionId: sharedUuid, source: "link-click" },
        machineServerMap: {},
        hosts: multiHosts,
        sessions: { srv_a: sessionAL3, srv_b: sessionBL1 },
        connectionStatusByServerId: { srv_a: "online", srv_b: "online" },
      }),
    ).toMatchObject({
      kind: "agent",
      level: "label_persona_session",
      serverId: "srv_b",
      agentId: "ag_b",
    });

    // Both Host A and Host B have the same Level-1 label -> ambiguous_machine (prompts mapping)
    const sessionAL1 = makeSession("srv_a", {
      serverInfo: { serverId: "srv_a", hostname: "host-a", version: "0.17.533" },
      agents: new Map([
        [
          "ag_a",
          makeAgent({
            id: "ag_a",
            serverId: "srv_a",
            labels: { "persona.session": sharedUuid },
          }),
        ],
      ]),
    });

    expect(
      resolvePersonaSession({
        request: { machineId: "unmapped-box", sessionId: sharedUuid, source: "link-click" },
        machineServerMap: {},
        hosts: multiHosts,
        sessions: { srv_a: sessionAL1, srv_b: sessionBL1 },
        connectionStatusByServerId: { srv_a: "online", srv_b: "online" },
      }),
    ).toEqual({
      kind: "unresolved",
      reason: "ambiguous_machine",
      machineId: "unmapped-box",
      sessionId: sharedUuid,
      resolvedServerId: null,
      candidateServerIds: ["srv_a", "srv_b"],
    });

    // Unmapped machine MUST NOT perform Level-4 workspace/cwd fallback even when hints match Host A
    const ws = makeWorkspace({
      id: "wks_0123456789abcdef",
      workspaceDirectory: "/data00/repo/paseo-fork",
    });
    const sessionWithWs = makeSession("srv_a", {
      serverInfo: { serverId: "srv_a", hostname: "host-a", version: "0.17.533" },
      workspaces: new Map([[ws.id, ws]]),
    });
    expect(
      resolvePersonaSession({
        request: {
          machineId: "unmapped-box",
          sessionId: "unknown-session",
          workspaceIdHint: ws.id,
          cwdHint: "/data00/repo/paseo-fork",
          source: "link-click",
        },
        machineServerMap: {},
        hosts: multiHosts,
        sessions: { srv_a: sessionWithWs },
        connectionStatusByServerId: { srv_a: "online" },
      }),
    ).toEqual({
      kind: "unresolved",
      reason: "unmapped_machine",
      machineId: "unmapped-box",
      sessionId: "unknown-session",
      resolvedServerId: null,
    });
  });
});
