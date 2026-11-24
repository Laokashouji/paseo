// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  mergeMainChatSettings,
  type MainChatFleetHostStatus,
  type MainChatSettings,
  type MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React, { type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatSettingsSection } from "@/screens/settings/main-chat/main-chat-section";
import {
  useSessionStore,
  type Agent,
  type ProjectDescriptor,
  type SessionState,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import type { HostProfile } from "@/types/host-connection";
import { useMainChatConversationsStore } from "./conversations-store";
import { useMainChatDrawerStore } from "./drawer-store";
import { MainChatHeroRow } from "./hero-row";
import { computeUnlinkedClientHosts } from "./host-sync-banner";
import { collectMainChatMentionSources } from "./mention-sources";
import { selectMainChatDockTasks, selectMainChatSidebarSummary } from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";
import {
  buildStewardRoster,
  detectStewardHostConflicts,
  resolveActiveStewardServerId,
  resolveStewardAccentTone,
  resolveStewardAllowedServerIds,
  useMainChatStewardStore,
} from "./steward-store";

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockPathname = vi.hoisted(() => ({ value: "/main" }));
const mockActiveWorkspace = vi.hoisted<{ value: { serverId: string; workspaceId: string } | null }>(
  () => ({
    value: { serverId: "srv_devbox", workspaceId: "ws_dev" },
  }),
);
const mockHosts = vi.hoisted<{ value: HostProfile[] }>(() => ({
  value: [],
}));

vi.mock("expo-router", () => ({
  router: {
    push: mockRouterPush,
    replace: vi.fn(),
    navigate: vi.fn(),
  },
  usePathname: () => mockPathname.value,
}));

vi.mock("expo-router/react-navigation", () => ({
  useIsFocused: () => true,
  NavigationContext: React.createContext(undefined),
  NavigationRouteContext: React.createContext(undefined),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, params?: Record<string, unknown>) =>
        params ? `${key}:${JSON.stringify(params)}` : key,
      i18n: { language: "zh-CN" },
    }),
  };
});

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => false,
  };
});

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: (actionId: string) => (actionId === "open-main-chat" ? [["mod", "0"]] : null),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: [], isLoading: false }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHosts.value,
  useHostRuntimeConnectionStatus: () => "online",
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => mockActiveWorkspace.value,
  useLastWorkspaceSelection: () => mockActiveWorkspace.value,
  navigateToWorkspace: vi.fn(),
}));

vi.mock("@/attachments/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/attachments/service")>();
  return {
    ...actual,
    garbageCollectAttachments: vi.fn(async () => undefined),
  };
});

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => {
  const DropdownMenu = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mock-dropdown-menu">{children}</div>
  );
  const DropdownMenuTrigger = ({
    children,
    testID,
  }: {
    children?: React.ReactNode;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID}>
      {children}
    </button>
  );
  const DropdownMenuContent = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mock-dropdown-content">{children}</div>
  );
  const DropdownMenuItem = ({
    children,
    description,
    onSelect,
    testID,
    disabled,
  }: {
    children?: React.ReactNode;
    description?: string;
    onSelect?: () => void;
    testID?: string;
    disabled?: boolean;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onSelect}>
      <span>{children}</span>
      {description ? <span>{description}</span> : null}
    </button>
  );
  const DropdownMenuLabel = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const DropdownMenuSeparator = () => <hr />;
  const DropdownMenuSubTrigger = ({
    children,
    testID,
  }: {
    children?: React.ReactNode;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID}>
      {children}
    </button>
  );
  return {
    DropdownMenu,
    DropdownMenuTrigger,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSubTrigger,
  };
});

const noopToastApi: ComponentProps<typeof ToastApiProvider>["api"] = {
  show: () => () => undefined,
  error: () => () => undefined,
  copied: () => () => undefined,
};

function makeHostProfile(
  serverId: string,
  label: string,
  connections: HostProfile["connections"] = [],
): HostProfile {
  return {
    serverId,
    label,
    connections,
    preferredConnectionId: connections[0]?.id ?? null,
    createdAt: "2026-11-23T08:00:00.000Z",
    updatedAt: "2026-11-23T08:00:00.000Z",
    appearance: { badgeDisplay: "icon", color: "blue", icon: "server" },
  } as unknown as HostProfile;
}

function makeAgent(partial: Partial<Agent> & { id: string; serverId: string }): Agent {
  return {
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-23T08:00:00.000Z"),
    updatedAt: new Date("2026-11-23T08:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-23T08:00:00.000Z"),
    capabilities: {} as Agent["capabilities"],
    currentModeId: "default",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: partial.id,
    cwd: "/repo/app",
    workspaceId: "ws_default",
    model: "claude-sonnet-5-5",
    parentAgentId: null,
    labels: {},
    ...partial,
  };
}

function makeWorkspace(id: string, name: string, directory: string): WorkspaceDescriptor {
  return {
    id,
    name,
    title: name,
    workspaceDirectory: directory,
    projectId: `proj_${id}`,
    projectDisplayName: name,
    projectRootPath: directory,
    background: false,
    archivingAt: null,
  } as unknown as WorkspaceDescriptor;
}

function makeProject(projectId: string, name: string, rootPath: string): ProjectDescriptor {
  return {
    projectId,
    projectDisplayName: name,
    projectRootPath: rootPath,
  } as unknown as ProjectDescriptor;
}

function makeFleetHost(
  serverId: string,
  label: string,
  overrides: Partial<MainChatFleetHostStatus> = {},
): MainChatFleetHostStatus {
  return {
    serverId,
    label,
    isLocal: false,
    status: "online",
    agentCount: 0,
    needsAttentionCount: 0,
    lastSyncedAt: "2026-11-24T00:00:00.000Z",
    error: null,
    ...overrides,
  };
}

function makeFakeClient(
  initialSettings: MainChatSettings,
  initialRemotes: MainChatFleetHostStatus[] = [],
) {
  let currentSettings = initialSettings;
  let remotes = [...initialRemotes];
  const updateMainChatSettings = vi.fn(async (patch: MainChatSettingsPatch) => {
    currentSettings = mergeMainChatSettings(currentSettings, patch);
    return { settings: currentSettings };
  });
  const getMainChatSettings = vi.fn(async () => ({ settings: currentSettings }));
  const getMainChatFleetHosts = vi.fn(async () => ({
    hosts: remotes,
    availableRemoteHosts: remotes,
    fleetScope: currentSettings.fleetScope,
    refreshedAt: "2026-11-24T00:00:00.000Z",
  }));
  const addHost = vi.fn(async (input: { connection: string; label?: string }) => {
    const addedId = input.label === "iMac" ? "srv_imac" : "srv_mac";
    remotes = [...remotes, makeFleetHost(addedId, input.label ?? addedId, { status: "online" })];
    return { ok: true };
  });
  return {
    client: {
      getMainChatSettings,
      updateMainChatSettings,
      getMainChatFleetHosts,
      getMainChatTokenUsage: vi.fn(async () => ({
        summary: {
          today: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, costUsd: null },
          last7Days: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, costUsd: null },
          breakdown: {
            chat: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, costUsd: null },
            patrol: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, costUsd: null },
            triage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, costUsd: null },
            compaction: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              turns: 0,
              costUsd: null,
            },
          },
          daily: [],
          updatedAt: "2026-11-24T00:00:00.000Z",
        },
      })),
      getMainChatNightModeStatus: vi.fn(async () => ({
        status: {
          state: "active",
          inQuietWindow: false,
          hibernating: false,
          effectivePatrolIntervalSec: 300,
          effectiveBackgroundModelMode: "auto",
          nextTransitionAt: null,
        },
      })),
      listStandingAuthRules: vi.fn(async () => ({ rules: [] })),
      addHost,
      ensureMainChat: vi.fn(async () => ({
        agentId: "agent_main",
        workspaceId: "ws_main",
        created: false,
      })),
    } as unknown as DaemonClient,
    spies: {
      getMainChatSettings,
      updateMainChatSettings,
      getMainChatFleetHosts,
      addHost,
    },
  };
}

function makeSessionState(input: {
  serverId: string;
  hostname: string;
  client: DaemonClient | null;
  agents?: Agent[];
  workspaces?: WorkspaceDescriptor[];
  projects?: ProjectDescriptor[];
  supportsMainChat?: boolean;
}): SessionState {
  const agents = new Map<string, Agent>();
  for (const agent of input.agents ?? []) {
    agents.set(agent.id, agent);
  }
  const workspaces = new Map<string, WorkspaceDescriptor>();
  for (const ws of input.workspaces ?? []) {
    workspaces.set(ws.id, ws);
  }
  const projects = new Map<string, ProjectDescriptor>();
  for (const proj of input.projects ?? []) {
    projects.set(proj.projectId, proj);
  }
  return {
    client: input.client,
    serverInfo: {
      serverId: input.serverId,
      hostname: input.hostname,
      version: "0.17.0-beta.1",
      features: { mainChat: input.supportsMainChat ?? true },
    },
    agents,
    workspaces,
    projects,
    pendingPermissions: new Map(),
  } as unknown as SessionState;
}

function renderWithProviders(element: React.ReactElement) {
  return render(
    <KeyboardActionDispatcherProvider>
      <ToastApiProvider api={noopToastApi}>{element}</ToastApiProvider>
    </KeyboardActionDispatcherProvider>,
  );
}

beforeEach(() => {
  mockRouterPush.mockReset();
  mockPathname.value = "/main";
  mockHosts.value = [];
  mockActiveWorkspace.value = { serverId: "srv_devbox", workspaceId: "ws_dev" };

  useSessionStore.setState({ sessions: {} });
  useMainChatSettingsStore.setState({
    settingsByServerId: {},
    loadingByServerId: {},
    lastPatrolByServerId: {},
    nightModeStatusByServerId: {},
    usageByServerId: {},
  });
  useMainChatConversationsStore.setState({
    conversationsByServerId: {},
    fleetHostsByServerId: {},
    availableRemoteHostsByServerId: {},
    fleetScopeByServerId: {},
    loadingFleetHostsByServerId: {},
    dismissedFleetSyncNoticeByServerId: {},
  });
  useMainChatDrawerStore.setState({
    activeStewardServerId: null,
    activeTarget: null,
    lastTarget: null,
    lastTargetByStewardServerId: {},
  });
  useMainChatStewardStore.setState({
    activeStewardServerId: null,
    defaultStewardServerId: null,
    filterWorkspacesByActiveSteward: false,
    cachedStewardsByServerId: {},
  });
});

afterEach(() => {
  cleanup();
});

describe("Multi-Steward store & pure domain helpers", () => {
  it("resolves allowed serverIds accurately across local_only, allowlist, and all_connected", () => {
    expect(
      Array.from(
        resolveStewardAllowedServerIds({
          stewardServerId: "srv_imac",
          settings: { fleetScope: { mode: "local_only", hostServerIds: ["srv_devbox"] } },
          fleetHosts: [makeFleetHost("srv_devbox", "DevBox")],
        }),
      ),
    ).toEqual(["srv_imac"]);

    const allowlist = resolveStewardAllowedServerIds({
      stewardServerId: "srv_devbox",
      settings: { fleetScope: { mode: "allowlist", hostServerIds: ["srv_mac"] } },
      fleetHosts: [makeFleetHost("srv_mac", "MacBook"), makeFleetHost("srv_imac", "iMac")],
    });
    expect(Array.from(allowlist).sort()).toEqual(["srv_devbox", "srv_mac"]);

    const allConnectedFromFleet = resolveStewardAllowedServerIds({
      stewardServerId: "srv_devbox",
      settings: { fleetScope: { mode: "all_connected", hostServerIds: [] } },
      fleetHosts: [
        makeFleetHost("srv_devbox", "DevBox", { isLocal: true }),
        makeFleetHost("srv_mac", "MacBook"),
      ],
    });
    expect(Array.from(allConnectedFromFleet).sort()).toEqual(["srv_devbox", "srv_mac"]);

    const offlineFallback = resolveStewardAllowedServerIds({
      stewardServerId: "srv_devbox",
      settings: { fleetScope: { mode: "all_connected", hostServerIds: [] } },
      fleetHosts: [],
      cachedManagedHostIds: ["srv_devbox", "srv_mac"],
    });
    expect(Array.from(offlineFallback).sort()).toEqual(["srv_devbox", "srv_mac"]);
  });

  it("builds roster with default ordering, disabled exclusion, offline cache retention, and stable accent tones", () => {
    const devSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      title: "工作管家",
      fleetScope: { mode: "allowlist", hostServerIds: ["srv_mac"] },
    });
    const macDisabled = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      enabled: false,
    });
    const imacSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      title: "家里管家",
      fleetScope: { mode: "local_only", hostServerIds: [] },
    });

    const roster = buildStewardRoster({
      hosts: [
        {
          serverId: "srv_devbox",
          label: "DevBox",
          hostname: "devbox",
          online: true,
          supportsMainChat: true,
          hasExistingMainChat: true,
        },
        {
          serverId: "srv_mac",
          label: "MacBook",
          hostname: "macbook",
          online: true,
          supportsMainChat: true,
          hasExistingMainChat: false,
        },
        {
          serverId: "srv_imac",
          label: "iMac",
          hostname: "imac",
          online: false,
          supportsMainChat: false,
          hasExistingMainChat: false,
        },
      ],
      settingsByServerId: {
        srv_devbox: devSettings,
        srv_mac: macDisabled,
      },
      fleetHostsByServerId: {
        srv_devbox: [
          makeFleetHost("srv_devbox", "DevBox", { isLocal: true }),
          makeFleetHost("srv_mac", "MacBook"),
        ],
      },
      cachedStewardsByServerId: {
        srv_imac: {
          title: imacSettings.title,
          hostname: "imac",
          fleetScope: imacSettings.fleetScope,
          managedHostIds: ["srv_imac"],
          lastSeenAt: "2026-11-24T00:00:00.000Z",
        },
      },
      defaultStewardServerId: "srv_imac",
    });

    // MacBook disabled -> excluded; iMac is explicit default -> sorted first despite offline
    expect(roster.map((item) => item.serverId)).toEqual(["srv_imac", "srv_devbox"]);
    expect(roster[0]).toMatchObject({
      serverId: "srv_imac",
      title: "家里管家",
      online: false,
      isDefault: true,
      accentTone: "accent",
      managedHostIds: ["srv_imac"],
    });
    expect(roster[1]).toMatchObject({
      serverId: "srv_devbox",
      title: "工作管家",
      online: true,
      isDefault: false,
      managedHostIds: ["srv_devbox", "srv_mac"],
      managedHostLabels: ["DevBox", "MacBook"],
    });
    expect(roster[1]?.accentTone).toBe(resolveStewardAccentTone("srv_devbox", false));
    expect(roster[1]?.accentTone).not.toBe("accent");

    expect(
      resolveActiveStewardServerId({
        routeServerId: "srv_devbox",
        activeStewardServerId: "srv_imac",
        defaultStewardServerId: "srv_imac",
        roster,
      }),
    ).toBe("srv_devbox");
    expect(
      resolveActiveStewardServerId({
        activeStewardServerId: "srv_deleted",
        defaultStewardServerId: "srv_imac",
        roster,
      }),
    ).toBe("srv_imac");
  });

  it("detects both local_and_remote_steward and duplicate_managed host conflicts", () => {
    const hosts = [
      makeHostProfile("srv_devbox", "DevBox"),
      makeHostProfile("srv_mac", "MacBook"),
      makeHostProfile("srv_imac", "iMac"),
      makeHostProfile("srv_mini", "Mac mini"),
    ];
    const capableServerIds = new Set(["srv_devbox", "srv_mac", "srv_imac"]);
    const devSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      title: "工作管家",
      fleetScope: { mode: "allowlist", hostServerIds: ["srv_mac", "srv_mini"] },
    });
    const macSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      title: "MacBook 管家",
      fleetScope: { mode: "local_only", hostServerIds: [] },
    });
    const imacSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      title: "家里管家",
      fleetScope: { mode: "allowlist", hostServerIds: ["srv_mini"] },
    });

    const conflicts = detectStewardHostConflicts({
      hosts,
      capableServerIds,
      settingsByServerId: {
        srv_devbox: devSettings,
        srv_mac: macSettings,
        srv_imac: imacSettings,
      },
      fleetHostsByServerId: {},
    });

    const byTarget = Object.fromEntries(conflicts.map((item) => [item.targetServerId, item]));
    expect(byTarget.srv_mac?.kind).toBe("local_and_remote_steward");
    expect(byTarget.srv_mac?.owners.map((owner) => owner.stewardServerId).sort()).toEqual([
      "srv_devbox",
      "srv_mac",
    ]);
    expect(byTarget.srv_mini?.kind).toBe("duplicate_managed");
    expect(byTarget.srv_mini?.owners.map((owner) => owner.stewardServerId).sort()).toEqual([
      "srv_devbox",
      "srv_imac",
    ]);

    // Cleanly partitioned topology yields zero conflicts
    const cleanConflicts = detectStewardHostConflicts({
      hosts,
      capableServerIds,
      settingsByServerId: {
        srv_devbox: mergeMainChatSettings(devSettings, {
          fleetScope: { mode: "allowlist", hostServerIds: ["srv_mac"] },
        }),
        srv_mac: mergeMainChatSettings(macSettings, { enabled: false }),
        srv_imac: mergeMainChatSettings(imacSettings, {
          fleetScope: { mode: "local_only", hostServerIds: [] },
        }),
      },
      fleetHostsByServerId: {},
    });
    expect(cleanConflicts).toEqual([]);
  });
});

describe("Multi-Steward frontend host isolation", () => {
  it("scopes computeUnlinkedClientHosts according to fleetScope mode", () => {
    const clientHosts = [
      makeHostProfile("srv_devbox", "DevBox"),
      makeHostProfile("srv_mac", "MacBook", [
        { id: "direct-mac", type: "directTcp", endpoint: "10.0.0.2:6767", useTls: false },
      ] as HostProfile["connections"]),
      makeHostProfile("srv_imac", "iMac", [
        { id: "direct-imac", type: "directTcp", endpoint: "10.0.0.3:6767", useTls: false },
      ] as HostProfile["connections"]),
    ];
    const daemonFleet = [makeFleetHost("srv_devbox", "DevBox", { isLocal: true })];

    // local_only never nags about other client hosts
    expect(
      computeUnlinkedClientHosts(clientHosts, daemonFleet, "srv_devbox", {
        mode: "local_only",
        hostServerIds: [],
      }),
    ).toEqual([]);

    // allowlist only flags hosts inside hostServerIds that are missing on daemon
    const allowlistUnlinked = computeUnlinkedClientHosts(clientHosts, daemonFleet, "srv_devbox", {
      mode: "allowlist",
      hostServerIds: ["srv_mac"],
    });
    expect(allowlistUnlinked.map((item) => item.serverId)).toEqual(["srv_mac"]);

    // all_connected flags both remote hosts
    const allUnlinked = computeUnlinkedClientHosts(clientHosts, daemonFleet, "srv_devbox", {
      mode: "all_connected",
      hostServerIds: [],
    });
    expect(allUnlinked.map((item) => item.serverId).sort()).toEqual(["srv_imac", "srv_mac"]);
  });

  it("isolates mention sources, sidebar summaries, dock tasks, and drawer state across stewards", () => {
    const devMain = makeAgent({
      id: "agent_dev_main",
      serverId: "srv_devbox",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      title: "工作管家",
      workspaceId: "ws_dev_main",
    });
    const macWorker = makeAgent({
      id: "agent_mac_worker",
      serverId: "srv_mac",
      title: "MacBook 编译任务",
      status: "running",
      workspaceId: "ws_mac_app",
    });
    const imacMain = makeAgent({
      id: "agent_imac_main",
      serverId: "srv_imac",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      title: "家里管家",
      workspaceId: "ws_imac_main",
    });
    const imacWorker = makeAgent({
      id: "agent_imac_worker",
      serverId: "srv_imac",
      title: "iMac 个人项目",
      status: "idle",
      pendingPermissions: [{ id: "perm_imac_1" } as unknown as Agent["pendingPermissions"][number]],
      workspaceId: "ws_imac_home",
    });

    const sessions: Record<string, SessionState> = {
      srv_devbox: makeSessionState({
        serverId: "srv_devbox",
        hostname: "devbox",
        client: makeFakeClient(createDefaultMainChatSettings("conservative")).client,
        agents: [devMain],
        workspaces: [makeWorkspace("ws_dev_repo", "DevRepo", "/work/dev")],
        projects: [makeProject("proj_dev", "DevRepo", "/work/dev")],
      }),
      srv_mac: makeSessionState({
        serverId: "srv_mac",
        hostname: "macbook",
        client: makeFakeClient(createDefaultMainChatSettings("conservative")).client,
        agents: [macWorker],
        workspaces: [makeWorkspace("ws_mac_app", "MacApp", "/work/mac")],
        projects: [makeProject("proj_mac", "MacApp", "/work/mac")],
      }),
      srv_imac: makeSessionState({
        serverId: "srv_imac",
        hostname: "imac",
        client: makeFakeClient(createDefaultMainChatSettings("conservative")).client,
        agents: [imacMain, imacWorker],
        workspaces: [makeWorkspace("ws_imac_home", "HomeProject", "/home/proj")],
        projects: [makeProject("proj_imac", "HomeProject", "/home/proj")],
      }),
    };
    useSessionStore.setState({ sessions });
    const sessionState = useSessionStore.getState();

    const devAllowed = new Set(["srv_devbox", "srv_mac"]);
    const imacAllowed = new Set(["srv_imac"]);

    const devMentions = collectMainChatMentionSources({
      sessions,
      allowedServerIds: devAllowed,
    });
    expect(devMentions.hosts.map((h) => h.serverId).sort()).toEqual(["srv_devbox", "srv_mac"]);
    expect(devMentions.sessions.map((s) => s.agentId)).toEqual(["agent_mac_worker"]);
    expect(devMentions.workspaces.map((w) => w.workspaceId)).toEqual(["ws_dev_repo", "ws_mac_app"]);

    const imacMentions = collectMainChatMentionSources({
      sessions,
      allowedServerIds: imacAllowed,
    });
    expect(imacMentions.hosts.map((h) => h.serverId)).toEqual(["srv_imac"]);
    expect(imacMentions.sessions.map((s) => s.agentId)).toEqual(["agent_imac_worker"]);
    expect(imacMentions.workspaces.map((w) => w.workspaceId)).toEqual(["ws_imac_home"]);

    const devSummary = selectMainChatSidebarSummary(sessionState, "srv_devbox", null, {
      allowedServerIds: devAllowed,
      strictServerId: true,
    });
    expect(devSummary.runningCount).toBe(1);
    expect(devSummary.needsYouCount).toBe(0);

    const imacSummary = selectMainChatSidebarSummary(sessionState, "srv_imac", null, {
      allowedServerIds: imacAllowed,
      strictServerId: true,
    });
    expect(imacSummary.runningCount).toBe(0);
    expect(imacSummary.needsYouCount).toBe(1);

    const devDock = selectMainChatDockTasks(
      sessionState,
      "srv_devbox",
      "agent_dev_main",
      devAllowed,
    );
    expect(devDock.map((t) => t.agentId)).toEqual(["agent_mac_worker"]);

    const imacDock = selectMainChatDockTasks(
      sessionState,
      "srv_imac",
      "agent_imac_main",
      imacAllowed,
    );
    expect(imacDock.map((t) => t.agentId)).toEqual(["agent_imac_worker"]);

    // Drawer auto-closes when switching steward to one that doesn't allow the open task's host
    useMainChatDrawerStore.getState().setActiveStewardContext("srv_devbox", devAllowed);
    useMainChatDrawerStore.getState().openTask({
      serverId: "srv_mac",
      agentId: "agent_mac_worker",
      workspaceId: "ws_mac_app",
      title: "MacBook 编译任务",
    });
    expect(useMainChatDrawerStore.getState().activeTarget?.agentId).toBe("agent_mac_worker");

    useMainChatDrawerStore.getState().setActiveStewardContext("srv_imac", imacAllowed);
    expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();
    expect(useMainChatDrawerStore.getState().lastTargetByStewardServerId.srv_devbox?.agentId).toBe(
      "agent_mac_worker",
    );
  });
});

describe("Multi-Steward UI — Sidebar Hero switcher & Settings management", () => {
  it("hides switcher for a single steward and shows switcher + cross-steward alert dot for >=2 stewards", () => {
    const devSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      title: "工作管家",
      fleetScope: { mode: "allowlist", hostServerIds: ["srv_mac"] },
    });
    const devClient = makeFakeClient(devSettings).client;
    const devMain = makeAgent({
      id: "agent_dev_main",
      serverId: "srv_devbox",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      title: "工作管家",
    });

    mockHosts.value = [makeHostProfile("srv_devbox", "DevBox")];
    useSessionStore.setState({
      sessions: {
        srv_devbox: makeSessionState({
          serverId: "srv_devbox",
          hostname: "devbox",
          client: devClient,
          agents: [devMain],
        }),
      },
    });
    useMainChatSettingsStore.setState({
      settingsByServerId: { srv_devbox: devSettings },
    });

    const singleView = renderWithProviders(<MainChatHeroRow />);
    expect(singleView.getByTestId("sidebar-main-chat-hero")).toBeTruthy();
    expect(singleView.queryByTestId("sidebar-main-chat-steward-switcher")).toBeNull();
    expect(singleView.queryByTestId("sidebar-main-chat-other-steward-dot")).toBeNull();
    singleView.unmount();

    // Add second enabled steward (iMac) with a pending permission
    const imacSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      title: "家里管家",
      fleetScope: { mode: "local_only", hostServerIds: [] },
    });
    const imacClient = makeFakeClient(imacSettings).client;
    const imacMain = makeAgent({
      id: "agent_imac_main",
      serverId: "srv_imac",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      title: "家里管家",
    });
    const imacNeedsYouWorker = makeAgent({
      id: "agent_imac_perm",
      serverId: "srv_imac",
      title: "需要审批",
      pendingPermissions: [{ id: "perm_1" } as unknown as Agent["pendingPermissions"][number]],
    });

    mockHosts.value = [
      makeHostProfile("srv_devbox", "DevBox"),
      makeHostProfile("srv_imac", "iMac"),
    ];
    useSessionStore.setState({
      sessions: {
        srv_devbox: makeSessionState({
          serverId: "srv_devbox",
          hostname: "devbox",
          client: devClient,
          agents: [devMain],
        }),
        srv_imac: makeSessionState({
          serverId: "srv_imac",
          hostname: "imac",
          client: imacClient,
          agents: [imacMain, imacNeedsYouWorker],
        }),
      },
    });
    useMainChatSettingsStore.setState({
      settingsByServerId: {
        srv_devbox: devSettings,
        srv_imac: imacSettings,
      },
    });
    useMainChatStewardStore.setState({
      activeStewardServerId: "srv_devbox",
      defaultStewardServerId: "srv_devbox",
    });

    const multiView = renderWithProviders(<MainChatHeroRow />);
    expect(multiView.getByTestId("sidebar-main-chat-steward-switcher")).toBeTruthy();
    expect(multiView.getByTestId("sidebar-main-chat-other-steward-dot")).toBeTruthy();
    expect(multiView.getByTestId("sidebar-main-chat-switcher-other-count").textContent).toBe("+1");

    // Switching to iMac updates active steward and navigates to /main?serverId=srv_imac
    fireEvent.click(multiView.getByTestId("steward-switcher-item-srv_imac"));
    expect(useMainChatStewardStore.getState().activeStewardServerId).toBe("srv_imac");
    expect(mockRouterPush).toHaveBeenCalledWith("/main?serverId=srv_imac");
  });

  it("renders conflicts banner, one-click disable, fleet scope mode/host toggling with auto-sync, and workspace filter switch", async () => {
    const devSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      title: "工作管家",
      fleetScope: { mode: "allowlist", hostServerIds: ["srv_mac"] },
    });
    const macSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      title: "MacBook 管家",
      fleetScope: { mode: "local_only", hostServerIds: [] },
    });
    const imacSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      title: "家里管家",
      fleetScope: { mode: "local_only", hostServerIds: [] },
    });

    // DevBox has NOT yet linked srv_mac in daemon ConnectedHosts (client-only host with directTcp)
    const devMock = makeFakeClient(devSettings, []);
    const macMock = makeFakeClient(macSettings, []);
    const imacMock = makeFakeClient(imacSettings, []);

    mockHosts.value = [
      makeHostProfile("srv_devbox", "DevBox"),
      makeHostProfile("srv_mac", "MacBook", [
        { id: "tcp-mac", type: "directTcp", endpoint: "10.0.0.2:6767", useTls: false },
      ] as HostProfile["connections"]),
      makeHostProfile("srv_imac", "iMac", [
        { id: "tcp-imac", type: "directTcp", endpoint: "10.0.0.3:6767", useTls: false },
      ] as HostProfile["connections"]),
    ];

    useSessionStore.setState({
      sessions: {
        srv_devbox: makeSessionState({
          serverId: "srv_devbox",
          hostname: "devbox",
          client: devMock.client,
        }),
        srv_mac: makeSessionState({
          serverId: "srv_mac",
          hostname: "macbook",
          client: macMock.client,
        }),
        srv_imac: makeSessionState({
          serverId: "srv_imac",
          hostname: "imac",
          client: imacMock.client,
        }),
      },
    });
    useMainChatSettingsStore.setState({
      settingsByServerId: {
        srv_devbox: devSettings,
        srv_mac: macSettings,
        srv_imac: imacSettings,
      },
    });
    useMainChatConversationsStore.setState({
      fleetHostsByServerId: {
        srv_devbox: [makeFleetHost("srv_devbox", "DevBox", { isLocal: true })],
        srv_mac: [makeFleetHost("srv_mac", "MacBook", { isLocal: true })],
        srv_imac: [makeFleetHost("srv_imac", "iMac", { isLocal: true })],
      },
      availableRemoteHostsByServerId: {
        srv_devbox: [],
        srv_mac: [],
        srv_imac: [],
      },
    });

    const view = renderWithProviders(<MainChatSettingsSection />);

    // Conflict banner detects MacBook running local steward while managed by DevBox
    expect(view.getByTestId("settings-steward-conflicts-banner")).toBeTruthy();
    expect(view.getByTestId("settings-steward-conflict-srv_mac")).toBeTruthy();

    // One-click disable local steward on MacBook
    fireEvent.click(view.getByTestId("settings-steward-conflict-disable-srv_mac"));
    await waitFor(() => {
      expect(macMock.spies.updateMainChatSettings).toHaveBeenCalledWith({ enabled: false });
    });

    // Toggle sidebar workspace filter preference
    expect(useMainChatStewardStore.getState().filterWorkspacesByActiveSteward).toBe(false);
    fireEvent.click(view.getByTestId("settings-steward-filter-workspaces"));
    expect(useMainChatStewardStore.getState().filterWorkspacesByActiveSteward).toBe(true);

    // Switch DevBox fleet scope mode to local_only (preserves prior allowlist ids non-destructively)
    fireEvent.click(view.getByTestId("settings-fleet-scope-mode-local_only"));
    await waitFor(() => {
      expect(devMock.spies.updateMainChatSettings).toHaveBeenCalledWith({
        fleetScope: { mode: "local_only", hostServerIds: ["srv_mac"] },
      });
      expect(view.queryByTestId("settings-fleet-scope-host-srv_imac")).toBeNull();
      expect(devMock.spies.getMainChatFleetHosts).toHaveBeenCalled();
    });
    // Wait for scopeBusy to release after refreshFleetHosts resolves
    await waitFor(() => {
      expect(
        view.getByTestId("settings-fleet-scope-mode-allowlist").getAttribute("aria-disabled"),
      ).not.toBe("true");
    });

    // Switch back to allowlist and check an unlinked client-only host (srv_imac) -> auto-calls addHost + updates fleetScope
    fireEvent.click(view.getByTestId("settings-fleet-scope-mode-allowlist"));
    await waitFor(() => {
      expect(view.getByTestId("settings-fleet-scope-host-srv_imac")).toBeTruthy();
      expect(
        view.getByTestId("settings-fleet-scope-host-srv_imac").getAttribute("aria-disabled"),
      ).not.toBe("true");
    });

    fireEvent.click(view.getByTestId("settings-fleet-scope-host-srv_imac"));
    await waitFor(() => {
      expect(devMock.spies.addHost).toHaveBeenCalledWith(
        expect.objectContaining({ label: "iMac" }),
      );
      expect(devMock.spies.updateMainChatSettings).toHaveBeenCalledWith({
        fleetScope: { mode: "allowlist", hostServerIds: ["srv_mac", "srv_imac"] },
      });
    });
  });
});
