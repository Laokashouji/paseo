// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  type MainChatConversationRecord,
  type MainChatFleetHostStatus,
  type MainChatOverview,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React, { type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { defaultHostAppearance } from "@/hosts/appearance";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import type { HostProfile } from "@/types/host-connection";
import { useMainChatCameFromStore } from "./came-from-store";
import {
  MainChatConversationScreen,
  buildConversationActionBarModel,
  filterOverviewForConversation,
} from "./conversation-screen";
import {
  MAIN_CHAT_DIRECTIONS_PERSIST_KEY,
  useMainChatConversationsStore,
} from "./conversations-store";
import { useMainChatDrawerStore } from "./drawer-store";
import { MainChatHistoryScreen } from "./history-screen";
import { HostSyncBanner, computeUnlinkedClientHosts } from "./host-sync-banner";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { useMainChatSettingsStore } from "./settings-store";
import { SidebarDirectionsSection } from "./sidebar-directions-section";

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockPathname = vi.hoisted(() => ({ value: "/h/srv_main/workspace/ws_repo" }));
const mockIsCompact = vi.hoisted(() => ({ value: false }));
const mockNavigateToAgent = vi.hoisted(() => vi.fn());
const mockNavigateToWorkspace = vi.hoisted(() => vi.fn());
const mockHostsState = vi.hoisted<{ value: HostProfile[] }>(() => ({ value: [] }));
const mockStorageMap = vi.hoisted(() => new Map<string, string>());

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => mockStorageMap.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      mockStorageMap.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      mockStorageMap.delete(key);
    }),
  },
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
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    i18n: { language: "zh-CN" },
  }),
  initReactI18next: { type: "3rdParty", init: () => undefined },
}));

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => mockIsCompact.value,
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHostsState.value,
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => ({ serverId: "srv_main", workspaceId: "ws_repo" }),
  useLastWorkspaceSelection: () => ({ serverId: "srv_main", workspaceId: "ws_repo" }),
  navigateToWorkspace: mockNavigateToWorkspace,
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: mockNavigateToAgent,
}));

vi.mock("@/components/desktop/titlebar-drag-region", () => ({
  TitlebarDragRegion: () => null,
}));

vi.mock("@/components/headers/sidebar-menu-toggle", () => ({
  SidebarMenuToggle: () => null,
}));

vi.mock("@/utils/desktop-window", () => ({
  WindowChromeSafeArea: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("@/components/retained-panel", () => ({
  RetainedPanelActivity: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("@/git/diff-pane", () => ({
  ChangesSurface: ({ workspaceId, cwd }: { workspaceId: string; cwd: string }) =>
    React.createElement(
      "div",
      { "data-testid": "mock-changes-surface" },
      `Diff:${workspaceId}:${cwd}`,
    ),
}));

vi.mock("@/components/terminal-pane", () => ({
  TerminalPane: ({ terminalId, cwd }: { terminalId: string; cwd: string }) =>
    React.createElement(
      "div",
      { "data-testid": `mock-terminal-pane-${terminalId}` },
      `Terminal:${terminalId}:${cwd}`,
    ),
}));

vi.mock("./agent-host", () => ({
  MainChatAgentHost: ({ serverId, agentId }: { serverId: string; agentId: string }) =>
    React.createElement(
      "div",
      { "data-testid": `mock-agent-host-${serverId}:${agentId}` },
      `AgentHost:${agentId}`,
    ),
}));

vi.mock("@/agent-stream/view", () => ({
  PermissionRequestCard: ({
    permission,
  }: {
    permission: { request: { id: string; title?: string } };
  }) =>
    React.createElement(
      "div",
      { "data-testid": `mock-permission-card-${permission.request.id}` },
      permission.request.title ?? permission.request.id,
    ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuTrigger: ({ children, testID }: { children: React.ReactNode; testID?: string }) =>
    React.createElement("button", { type: "button", "data-testid": testID }, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    testID,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        disabled,
        "data-testid": testID,
        onClick: () => {
          if (!disabled) onSelect?.();
        },
      },
      children,
    ),
  DropdownMenuSeparator: () => null,
}));

vi.mock("lucide-react-native", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const StubIcon = () => null;
  const names = [
    "Archive",
    "AlertTriangle",
    "ArrowLeft",
    "ArrowUpRight",
    "CheckCircle2",
    "CheckSquare",
    "ChevronDown",
    "ChevronRight",
    "CircleAlert",
    "Clock",
    "Compass",
    "CornerDownRight",
    "Ellipsis",
    "Eraser",
    "FileDiff",
    "FolderGit2",
    "HelpCircle",
    "History",
    "Layers",
    "Link2",
    "Maximize2",
    "MessageSquare",
    "MessageSquarePlus",
    "Minimize2",
    "PanelRight",
    "Pause",
    "Pencil",
    "Pin",
    "PinOff",
    "Play",
    "Plus",
    "Radar",
    "RefreshCcw",
    "RefreshCw",
    "RotateCcw",
    "Server",
    "Settings",
    "Shield",
    "ShieldCheck",
    "Sparkles",
    "Square",
    "Terminal",
    "Unlink",
    "X",
    "Zap",
  ];
  const mocked: Record<string, unknown> = { ...actual };
  for (const name of names) {
    mocked[name] = actual[name] ?? StubIcon;
  }
  return mocked;
});

const toastShowSpy = vi.fn(() => () => undefined);
const toastErrorSpy = vi.fn(() => () => undefined);
const toastApi: ComponentProps<typeof ToastApiProvider>["api"] = {
  show: toastShowSpy,
  error: toastErrorSpy,
  copied: () => () => undefined,
};

function renderWithProviders(ui: React.ReactElement) {
  return render(<ToastApiProvider api={toastApi}>{ui}</ToastApiProvider>);
}

function makeHostProfile(
  partial: Partial<HostProfile> & { serverId: string; label: string },
): HostProfile {
  return {
    appearance: defaultHostAppearance(),
    lifecycle: {},
    connections: [],
    preferredConnectionId: null,
    createdAt: "2026-11-23T08:00:00.000Z",
    updatedAt: "2026-11-23T08:00:00.000Z",
    ...partial,
  };
}

function makeConversation(
  partial: Partial<MainChatConversationRecord> & {
    id: string;
    kind: MainChatConversationRecord["kind"];
    agentId: string;
    title: string;
  },
): MainChatConversationRecord {
  return {
    workspaceId: "ws_main",
    directionSummary: null,
    parentConversationId: "conv_main",
    serverId: "srv_main",
    archivedAt: null,
    pinnedAsLeaderAt: partial.kind === "leader" ? "2026-11-23T09:00:00.000Z" : null,
    createdAt: "2026-11-23T09:00:00.000Z",
    updatedAt: "2026-11-23T10:00:00.000Z",
    lastMessageAt: "2026-11-23T10:00:00.000Z",
    ...partial,
  };
}

function makeTask(
  partial: Partial<MainChatTaskRecord> & { id: string; title: string },
): MainChatTaskRecord {
  return {
    mainAgentId: "agent_main",
    conversationId: null,
    planId: null,
    mode: "write",
    isolation: "worktree",
    serverId: "srv_main",
    hostLabel: "DevBox",
    cwd: "/repo/app",
    workspaceId: "ws_repo",
    workspaceLabel: "app",
    status: "running",
    brief: {
      goal: partial.title,
      doneWhen: ["All tests pass"],
      outOfBounds: [],
      scopeRevision: 1,
      updatedAt: "2026-11-23T10:00:00.000Z",
    },
    agentIds: [],
    activeAgentId: null,
    lastActivityAt: "2026-11-23T10:00:00.000Z",
    createdAt: "2026-11-23T09:00:00.000Z",
    updatedAt: "2026-11-23T10:00:00.000Z",
    ...partial,
  };
}

function makeOverview(partial?: Partial<MainChatOverview>): MainChatOverview {
  return {
    plans: [],
    decisions: [],
    autoStartRules: [],
    permissionRules: [],
    metrics: {
      autoContinued: 0,
      plansCreated: 0,
      plansAutoStarted: 0,
      plansStarted: 0,
      plansCancelled: 0,
      receiptsRecorded: 0,
      interrupts: 0,
      supervisorHeld: 0,
      reworkCount: 0,
      stalledNudges: 0,
      usageLimitRetries: 0,
    },
    tasks: [],
    conversations: [],
    fleetHosts: [],
    ...partial,
  };
}

function makeAgent(partial: Partial<Agent> & { id: string; serverId: string }): Agent {
  return {
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-23T08:00:00.000Z"),
    updatedAt: new Date("2026-11-23T10:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-23T10:00:00.000Z"),
    capabilities: {} as Agent["capabilities"],
    currentModeId: "default",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: partial.id,
    cwd: "/repo/app",
    workspaceId: "ws_repo",
    model: "claude-sonnet-5-5",
    parentAgentId: null,
    labels: {},
    ...partial,
  };
}

function makeFakeClient(overrides?: Partial<Record<string, unknown>>): DaemonClient {
  const defaults = createDefaultMainChatSettings("conservative");
  return {
    getMainChatSettings: vi.fn(async () => ({ settings: defaults })),
    updateMainChatSettings: vi.fn(async (patch) => ({ settings: { ...defaults, ...patch } })),
    getMainChatOverview: vi.fn(async () => ({ overview: makeOverview(), error: null })),
    listMainChatConversations: vi.fn(async () => ({
      requestId: "r_list",
      conversations: [],
      error: null,
    })),
    createMainChatConversation: vi.fn(async (input) => ({
      requestId: "r_create",
      conversation: makeConversation({
        id: "conv_created",
        kind: input.kind,
        agentId: "agent_created",
        title: input.title,
        directionSummary: input.directionSummary ?? null,
      }),
      error: null,
    })),
    updateMainChatConversation: vi.fn(async (input) => ({
      requestId: "r_update",
      conversation: makeConversation({
        id: input.conversationId,
        kind: input.kind ?? "side",
        agentId: `agent_${input.conversationId}`,
        title: input.title ?? "Updated Title",
        directionSummary: input.directionSummary ?? null,
        archivedAt: input.archived ? "2026-11-23T12:00:00.000Z" : null,
      }),
      error: null,
    })),
    getMainChatFleetHosts: vi.fn(async () => ({
      requestId: "r_fleet",
      localServerId: "srv_main",
      hosts: [],
      error: null,
    })),
    addHost: vi.fn(async (input) => ({
      registrationId: "hst_1",
      serverId: null,
      label: input.label ?? null,
      source: { id: "user", key: "k" },
      metadata: {},
      enabled: true,
      status: "connecting",
      targetDescription: input.connection,
      lastOnlineAt: null,
      nextRetryAt: null,
      error: null,
    })),
    ...overrides,
  } as unknown as DaemonClient;
}

function seedSessions(input: {
  mainClient: DaemonClient;
  mainAgents?: Agent[];
  remoteSessions?: Record<string, { hostname: string; agents: Agent[] }>;
  connectedHostsFeature?: boolean;
}) {
  const mainAgents = new Map<string, Agent>();
  mainAgents.set(
    "agent_main",
    makeAgent({
      id: "agent_main",
      serverId: "srv_main",
      workspaceId: "ws_main",
      title: "主对话",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    }),
  );
  for (const agent of input.mainAgents ?? []) {
    mainAgents.set(agent.id, agent);
  }

  const sessions: Record<string, SessionState> = {
    srv_main: {
      client: input.mainClient,
      serverInfo: {
        serverId: "srv_main",
        hostname: "DevBox",
        version: "0.17.512",
        capabilities: {},
        features: {
          mainChat: true,
          connectedHosts: input.connectedHostsFeature ?? true,
        },
      },
      agents: mainAgents,
      agentDetails: new Map(),
      projects: new Map(),
      workspaces: new Map(),
      pendingPermissions: new Map(),
      agentTimeline: new Map(),
      agentStreamTail: new Map(),
      agentStreamHead: new Map(),
      queuedMessages: new Map(),
      agentTasks: new Map(),
      messageSubmissions: new Map(),
      initializingAgents: new Map(),
      agentHistorySyncGeneration: new Map(),
      historySyncGeneration: 0,
      viewedTimelineSync: null,
      focusedAgentId: null,
      focusedTerminalId: null,
      hasHydratedWorkspaces: true,
      hasWorkspaceDirectorySnapshot: true,
    } as unknown as SessionState,
  };

  for (const [hostId, remote] of Object.entries(input.remoteSessions ?? {})) {
    const remoteAgents = new Map<string, Agent>();
    for (const agent of remote.agents) {
      remoteAgents.set(agent.id, agent);
    }
    sessions[hostId] = {
      ...sessions.srv_main,
      client: null,
      serverInfo: {
        serverId: hostId,
        hostname: remote.hostname,
        version: "0.17.512",
        capabilities: {},
        features: {},
      },
      agents: remoteAgents,
      pendingPermissions: new Map(),
    } as unknown as SessionState;
  }

  useSessionStore.setState({ sessions, agentLastActivity: new Map() });
}

describe("Main Chat M4 UI — directions store, 3-level tree, conversation screen, history & cross-host sync", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    if (typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.animate !== "function") {
      HTMLElement.prototype.animate = vi.fn(
        () => ({ cancel: vi.fn(), startTime: 0 }) as unknown as Animation,
      );
    }
    mockRouterPush.mockReset();
    mockNavigateToAgent.mockReset();
    mockNavigateToWorkspace.mockReset();
    toastShowSpy.mockReset();
    toastErrorSpy.mockReset();
    mockPathname.value = "/h/srv_main/workspace/ws_repo";
    mockIsCompact.value = false;
    mockHostsState.value = [
      makeHostProfile({ serverId: "srv_main", label: "DevBox" }),
      makeHostProfile({ serverId: "srv_mac", label: "MacBook" }),
    ];
    mockStorageMap.clear();
    useMainChatConversationsStore.getState().reset();
    useMainChatOverviewStore.setState({
      overviewsByKey: {},
      decisionsByKey: {},
      activeAgentOverrideByServerId: {},
    });
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
    useMainChatDrawerStore.getState().reset();
    useMainChatCameFromStore.getState().clearCameFrom();
  });

  afterEach(() => {
    cleanup();
    useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
    useMainChatConversationsStore.getState().reset();
    vi.unstubAllGlobals();
  });

  it("manages create, promote/demote, rename, archive, fleet refresh, and device-local collapse persistence in conversations-store", async () => {
    const sideConv = makeConversation({
      id: "conv_side_1",
      kind: "side",
      agentId: "agent_side_1",
      title: "讨论缓存策略",
    });
    const promotedConv = {
      ...sideConv,
      kind: "leader" as const,
      directionSummary: "全链路缓存优化",
      pinnedAsLeaderAt: "2026-11-23T11:00:00.000Z",
    };
    const demotedConv = { ...promotedConv, kind: "side" as const, pinnedAsLeaderAt: null };
    const archivedConv = { ...demotedConv, archivedAt: "2026-11-23T12:00:00.000Z" };

    const fleetHosts: MainChatFleetHostStatus[] = [
      {
        serverId: "srv_main",
        label: "DevBox",
        isLocal: true,
        status: "online",
        agentCount: 3,
        needsAttentionCount: 1,
        lastSyncedAt: "2026-11-23T10:00:00.000Z",
        error: null,
      },
    ];

    const client = makeFakeClient({
      createMainChatConversation: vi.fn(async () => ({
        requestId: "r1",
        conversation: sideConv,
        error: null,
      })),
      updateMainChatConversation: vi
        .fn()
        .mockResolvedValueOnce({ requestId: "r2", conversation: promotedConv, error: null })
        .mockResolvedValueOnce({ requestId: "r3", conversation: demotedConv, error: null })
        .mockResolvedValueOnce({ requestId: "r4", conversation: archivedConv, error: null }),
      getMainChatFleetHosts: vi.fn(async () => ({
        requestId: "r5",
        localServerId: "srv_main",
        hosts: fleetHosts,
        error: null,
      })),
    });

    const store = useMainChatConversationsStore.getState();
    const created = await store.createConversation(
      "srv_main",
      { kind: "side", title: "讨论缓存策略" },
      client,
    );
    expect(created.id).toBe("conv_side_1");

    const promoted = await store.promoteToLeader("srv_main", "conv_side_1", client, {
      directionSummary: "全链路缓存优化",
    });
    expect(promoted.kind).toBe("leader");
    expect(
      useMainChatConversationsStore.getState().conversationsByServerId.srv_main?.[0]?.kind,
    ).toBe("leader");

    const demoted = await store.demoteToSide("srv_main", "conv_side_1", client);
    expect(demoted.kind).toBe("side");

    const archived = await store.archiveConversation("srv_main", "conv_side_1", client, true);
    expect(archived.archivedAt).not.toBeNull();

    const fleetResult = await store.refreshFleetHosts("srv_main", client, { forceRefresh: true });
    expect(fleetResult.localServerId).toBe("srv_main");
    expect(fleetResult.hosts).toHaveLength(1);

    // Device-local collapse persistence round-trip via AsyncStorage
    act(() => {
      const s = useMainChatConversationsStore.getState();
      s.setDirectionExpanded("conv_payments", true);
      s.setSectionCollapsed(true);
      s.setRecentSideCollapsed(true);
      s.setDismissedFleetSyncNotice(true);
    });

    await waitFor(() => {
      expect(mockStorageMap.has(MAIN_CHAT_DIRECTIONS_PERSIST_KEY)).toBe(true);
    });
    const persistedRaw = mockStorageMap.get(MAIN_CHAT_DIRECTIONS_PERSIST_KEY);
    expect(persistedRaw).toBeTruthy();

    // Simulate cold app restart: clear in-memory store, restore persisted AsyncStorage snapshot, then rehydrate
    useMainChatConversationsStore.setState({
      expandedDirectionIds: {},
      sectionCollapsed: false,
      recentSideCollapsed: false,
      dismissedFleetSyncNotice: false,
    });
    mockStorageMap.set(MAIN_CHAT_DIRECTIONS_PERSIST_KEY, persistedRaw!);
    await useMainChatConversationsStore.persist.rehydrate();

    const restored = useMainChatConversationsStore.getState();
    expect(restored.expandedDirectionIds.conv_payments).toBe(true);
    expect(restored.sectionCollapsed).toBe(true);
    expect(restored.recentSideCollapsed).toBe(true);
    expect(restored.dismissedFleetSyncNotice).toBe(true);
  });

  it("renders 3-level direction tree (Direction -> Task -> Cross-Host Agent), supports create modal and wide/compact agent opening", async () => {
    const leaderConv = makeConversation({
      id: "conv_pay",
      kind: "leader",
      agentId: "agent_leader_pay",
      title: "支付重构方向",
      directionSummary: "统一支付网关与对账幂等",
    });
    const sideConversations = Array.from({ length: 6 }, (_, index) =>
      makeConversation({
        id: `conv_side_${index + 1}`,
        kind: "side",
        agentId: `agent_side_${index + 1}`,
        title: `专题讨论 ${index + 1}`,
        lastMessageAt: `2026-11-23T10:0${6 - index}:00.000Z`,
      }),
    );

    const taskRunning = makeTask({
      id: "task_pay_1",
      title: "改造支付重试状态机",
      conversationId: "conv_pay",
      mainAgentId: "agent_leader_pay",
      serverId: "srv_mac",
      hostLabel: "MacBook",
      status: "running",
      agentIds: ["agent_mac_worker"],
      activeAgentId: "agent_mac_worker",
    });
    const taskNeedsYou = makeTask({
      id: "task_pay_2",
      title: "灰度切流审批",
      conversationId: "conv_pay",
      mainAgentId: "agent_leader_pay",
      serverId: "srv_main",
      hostLabel: "DevBox",
      status: "needs_you",
      agentIds: ["agent_dev_worker"],
      activeAgentId: "agent_dev_worker",
    });

    const client = makeFakeClient({
      listMainChatConversations: vi.fn(async () => ({
        requestId: "r_l",
        conversations: [leaderConv, ...sideConversations],
        error: null,
      })),
      createMainChatConversation: vi.fn(async (input) => ({
        requestId: "r_c",
        conversation: makeConversation({
          id: "conv_perf",
          kind: input.kind,
          agentId: "agent_perf",
          title: input.title,
          directionSummary: input.directionSummary ?? null,
        }),
        error: null,
      })),
    });

    seedSessions({
      mainClient: client,
      mainAgents: [
        makeAgent({
          id: "agent_dev_worker",
          serverId: "srv_main",
          workspaceId: "ws_pay",
          title: "切流核对 Agent",
          attentionReason: "permission",
        }),
      ],
      remoteSessions: {
        srv_mac: {
          hostname: "MacBook",
          agents: [
            makeAgent({
              id: "agent_mac_worker",
              serverId: "srv_mac",
              workspaceId: "ws_mac_pay",
              title: "状态机单测 Worker",
              status: "running",
              turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
            }),
          ],
        },
      },
    });

    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_main", "agent_main")]: makeOverview({
          tasks: [taskRunning, taskNeedsYou],
          conversations: [leaderConv, ...sideConversations],
        }),
      },
    });

    const view = render(<SidebarDirectionsSection />);

    // Leader group shows running 1 + needsYou 1 counts
    expect(view.getByTestId("sidebar-directions-leaders-group")).toBeTruthy();
    expect(view.getByTestId("sidebar-direction-row-conv_pay")).toBeTruthy();
    expect(view.getByTestId("sidebar-direction-counts-conv_pay").textContent).toContain(
      '"running":1,"needsYou":1',
    );

    // Recent sides caps at 5 initially and expands to 6 on Show all
    expect(view.getByTestId("sidebar-side-row-conv_side_1")).toBeTruthy();
    expect(view.queryByTestId("sidebar-side-row-conv_side_6")).toBeNull();
    fireEvent.click(view.getByTestId("sidebar-directions-sides-show-all"));
    expect(view.getByTestId("sidebar-side-row-conv_side_6")).toBeTruthy();

    // Expand 3-level tree: Direction -> Task -> Cross-Host Agent with [MacBook] badge
    fireEvent.click(view.getByTestId("sidebar-direction-toggle-conv_pay"));
    expect(view.getByTestId("sidebar-direction-tree-conv_pay")).toBeTruthy();
    expect(view.getByTestId("sidebar-direction-task-task_pay_1")).toBeTruthy();
    expect(view.getByTestId("sidebar-direction-agent-agent_mac_worker")).toBeTruthy();
    expect(view.getByTestId("sidebar-direction-agent-host-agent_mac_worker").textContent).toBe(
      "[MacBook]",
    );

    // Clicking cross-host agent on wide screen opens TaskPanelDrawer + navigates to direction route
    fireEvent.click(view.getByTestId("sidebar-direction-agent-agent_mac_worker"));
    expect(useMainChatDrawerStore.getState().activeTarget).toMatchObject({
      serverId: "srv_mac",
      agentId: "agent_mac_worker",
      taskId: "task_pay_1",
    });
    expect(mockRouterPush).toHaveBeenCalledWith("/main/c/conv_pay");

    // Clicking cross-host agent on compact screen navigates full-page and writes Came from
    mockIsCompact.value = true;
    view.unmount();
    const compactView = render(<SidebarDirectionsSection />);
    fireEvent.click(compactView.getByTestId("sidebar-direction-agent-agent_mac_worker"));
    expect(mockNavigateToAgent).toHaveBeenCalledWith({
      serverId: "srv_mac",
      agentId: "agent_mac_worker",
      workspaceId: "ws_mac_pay",
    });
    expect(useMainChatCameFromStore.getState().entry).toMatchObject({
      originRoute: "/main/c/conv_pay",
      originTitle: "支付重构方向",
      targetServerId: "srv_mac",
      targetAgentId: "agent_mac_worker",
    });

    // Clicking + opens CreateConversationModal, submits leader conversation, and navigates to /main/c/[id]
    mockRouterPush.mockReset();
    fireEvent.click(compactView.getByTestId("sidebar-directions-add"));
    expect(compactView.getByTestId("main-chat-create-conversation-modal")).toBeTruthy();

    fireEvent.click(compactView.getByTestId("main-chat-create-conv-kind-leader"));
    fireEvent.change(compactView.getByTestId("main-chat-create-conv-title"), {
      target: { value: "客户端性能优化" },
    });
    fireEvent.change(compactView.getByTestId("main-chat-create-conv-summary"), {
      target: { value: "聚焦冷启动与首屏渲染" },
    });
    fireEvent.change(compactView.getByTestId("main-chat-create-conv-prompt"), {
      target: { value: "先盘点最近一周冷启动回归" },
    });
    fireEvent.click(compactView.getByTestId("main-chat-create-conv-submit"));

    await waitFor(() => {
      expect(client.createMainChatConversation).toHaveBeenCalledWith({
        kind: "leader",
        title: "客户端性能优化",
        directionSummary: "聚焦冷启动与首屏渲染",
        initialPrompt: "先盘点最近一周冷启动回归",
      });
    });
    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith("/main/c/conv_perf");
    });

    // Kebab menu: promote side to leader & demote leader to side
    fireEvent.click(compactView.getByTestId("sidebar-side-menu-promote-conv_side_1"));
    await waitFor(() => {
      expect(client.updateMainChatConversation).toHaveBeenCalledWith({
        conversationId: "conv_side_1",
        kind: "leader",
      });
    });
    fireEvent.click(compactView.getByTestId("sidebar-direction-menu-demote-conv_pay"));
    await waitFor(() => {
      expect(client.updateMainChatConversation).toHaveBeenCalledWith({
        conversationId: "conv_pay",
        kind: "side",
      });
    });
  });

  it("renders MainChatConversationScreen with role badge, collapsible summary, menu actions, and conversation-scoped action bar", async () => {
    const leaderConv = makeConversation({
      id: "conv_pay",
      kind: "leader",
      agentId: "agent_leader_pay",
      title: "支付重构方向",
      directionSummary: "仅负责支付网关重试、对账幂等与灰度发布",
    });
    const payTask = makeTask({
      id: "task_pay_only",
      title: "支付对账脚本",
      conversationId: "conv_pay",
      mainAgentId: "agent_leader_pay",
      status: "needs_you",
      agentIds: ["agent_pay_child"],
      activeAgentId: "agent_pay_child",
    });
    const unrelatedMainTask = makeTask({
      id: "task_root_main",
      title: "根主对话其他任务",
      conversationId: null,
      mainAgentId: "agent_main",
      status: "running",
      agentIds: ["agent_root_child"],
      activeAgentId: "agent_root_child",
    });

    const overview = makeOverview({
      conversations: [leaderConv],
      tasks: [payTask, unrelatedMainTask],
    });

    // Pure filter sanity: excludes unrelated main-chat tasks
    const filtered = filterOverviewForConversation(overview, "conv_pay", "agent_leader_pay");
    expect(filtered.overview?.tasks?.map((task) => task.id)).toEqual(["task_pay_only"]);

    const scopedModel = buildConversationActionBarModel({
      serverId: "srv_main",
      conversationId: "conv_pay",
      conversationAgentId: "agent_leader_pay",
      overview,
      liveAgents: [],
      pendingPermissions: [],
    });
    expect(scopedModel.counts.needsYou).toBe(1);
    expect(scopedModel.counts.inProgress).toBe(0);

    const client = makeFakeClient({
      getMainChatOverview: vi.fn(async () => ({ overview, error: null })),
      updateMainChatConversation: vi.fn(async (input) => ({
        requestId: "r_upd",
        conversation: {
          ...leaderConv,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.title ? { title: input.title } : {}),
          ...(input.directionSummary !== undefined
            ? { directionSummary: input.directionSummary }
            : {}),
          ...(input.archived !== undefined
            ? { archivedAt: input.archived ? "2026-11-23T12:00:00.000Z" : null }
            : {}),
        },
        error: null,
      })),
    });

    seedSessions({ mainClient: client });
    useMainChatConversationsStore.setState({
      conversationsByServerId: { srv_main: [leaderConv] },
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: { [overviewStoreKey("srv_main", "agent_main")]: overview },
    });

    const view = renderWithProviders(<MainChatConversationScreen conversationId="conv_pay" />);

    expect(view.getByTestId("conversation-role-badge-leader")).toBeTruthy();
    expect(view.getByTestId("conversation-direction-summary-bar")).toBeTruthy();
    expect(view.getByTestId("conversation-direction-summary-text").textContent).toContain(
      "仅负责支付网关重试",
    );
    expect(view.getByTestId("mock-agent-host-srv_main:agent_leader_pay")).toBeTruthy();

    // Direction-scoped action bar shows ONLY payTask (needsYou = 1), NOT unrelatedMainTask
    expect(view.getByTestId("conversation-action-bar")).toBeTruthy();
    expect(view.getByTestId("conversation-action-capsule-needsYou")).toBeTruthy();
    expect(view.queryByTestId("conversation-action-capsule-inProgress")).toBeNull();

    // Collapsible summary toggle works
    fireEvent.click(view.getByTestId("conversation-direction-summary-toggle"));
    expect(view.getByTestId("conversation-direction-summary-text")).toBeTruthy();

    // Menu action 1: Demote leader to side
    fireEvent.click(view.getByTestId("conversation-menu-toggle-leader"));
    await waitFor(() => {
      expect(client.updateMainChatConversation).toHaveBeenCalledWith({
        conversationId: "conv_pay",
        kind: "side",
      });
    });

    // Menu action 2: Edit title & direction summary via modal
    fireEvent.click(view.getByTestId("conversation-menu-edit"));
    expect(view.getByTestId("main-chat-edit-conversation-modal")).toBeTruthy();
    fireEvent.change(view.getByTestId("main-chat-edit-conv-title"), {
      target: { value: "支付重构 V2" },
    });
    fireEvent.click(view.getByTestId("main-chat-edit-conv-submit"));
    await waitFor(() => {
      expect(client.updateMainChatConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: "conv_pay",
          title: "支付重构 V2",
        }),
      );
    });

    // Menu action 3: Archive conversation and return to /main
    fireEvent.click(view.getByTestId("conversation-menu-archive"));
    await waitFor(() => {
      expect(client.updateMainChatConversation).toHaveBeenCalledWith({
        conversationId: "conv_pay",
        archived: true,
      });
      expect(mockRouterPush).toHaveBeenCalledWith("/main");
    });
  });

  it("computes unlinked client hosts accurately and supports one-click sync, settings fallback, and dismiss in HostSyncBanner", async () => {
    const clientHosts: HostProfile[] = [
      makeHostProfile({
        serverId: "srv_main",
        label: "DevBox",
        connections: [{ id: "local", type: "directTcp", endpoint: "127.0.0.1:6767" }],
      }),
      makeHostProfile({
        serverId: "srv_linked",
        label: "BuildBox",
        connections: [{ id: "tcp1", type: "directTcp", endpoint: "10.0.0.10:6767" }],
      }),
      makeHostProfile({
        serverId: "srv_routed",
        label: "RoutedBox",
        connections: [{ id: "via:srv_main", type: "routed", originServerId: "srv_main" }],
      }),
      makeHostProfile({
        serverId: "srv_mac_relay",
        label: "MacBook Pro",
        password: "secret",
        connections: [
          {
            id: "rel1",
            type: "relay",
            relayEndpoint: "relay.paseo.sh:443",
            useTls: true,
            daemonPublicKeyB64: "pk_mac_123",
          },
        ],
      }),
      makeHostProfile({
        serverId: "srv_local_only",
        label: "LocalSocketHost",
        connections: [{ id: "sock1", type: "directSocket", path: "/tmp/paseo.sock" }],
      }),
    ];

    const fleetHosts: MainChatFleetHostStatus[] = [
      {
        serverId: "srv_main",
        label: "DevBox",
        isLocal: true,
        status: "online",
        agentCount: 2,
        needsAttentionCount: 0,
        lastSyncedAt: "2026-11-23T10:00:00.000Z",
        error: null,
      },
      {
        serverId: "srv_linked",
        label: "BuildBox",
        isLocal: false,
        status: "degraded",
        agentCount: 1,
        needsAttentionCount: 1,
        lastSyncedAt: "2026-11-23T09:59:00.000Z",
        error: "heartbeat slow",
      },
    ];

    const unlinked = computeUnlinkedClientHosts(clientHosts, fleetHosts, "srv_main");
    expect(unlinked.map((entry) => entry.serverId)).toEqual(["srv_mac_relay", "srv_local_only"]);
    expect(unlinked[0]?.canAutoSync).toBe(true);
    expect(unlinked[0]?.syncConnection).toContain("relay://relay.paseo.sh:443/srv_mac_relay");
    expect(unlinked[0]?.syncConnection).toContain("key=pk_mac_123");
    expect(unlinked[1]?.canAutoSync).toBe(false);
    expect(unlinked[1]?.syncConnection).toBeNull();

    // Render HostSyncBanner with both auto-syncable and manual-only hosts
    mockHostsState.value = clientHosts;
    const client = makeFakeClient({
      getMainChatFleetHosts: vi.fn(async () => ({
        requestId: "r_f",
        localServerId: "srv_main",
        hosts: fleetHosts,
        error: null,
      })),
    });
    seedSessions({ mainClient: client });
    useMainChatConversationsStore.setState({
      fleetHostsByServerId: { srv_main: fleetHosts },
      localServerIdByServerId: { srv_main: "srv_main" },
    });

    const view = renderWithProviders(
      <HostSyncBanner serverId="srv_main" mainAgentId="agent_main" />,
    );

    expect(view.getByTestId("main-chat-fleet-capsule-bar")).toBeTruthy();
    expect(view.getByTestId("main-chat-unlinked-hosts-banner")).toBeTruthy();

    // Expand host status list
    fireEvent.click(view.getByTestId("main-chat-fleet-capsule-toggle"));
    expect(view.getByTestId("main-chat-fleet-host-srv_main")).toBeTruthy();
    expect(view.getByTestId("main-chat-fleet-host-srv_linked")).toBeTruthy();
    expect(view.getByTestId("main-chat-fleet-unlinked-row-srv_mac_relay")).toBeTruthy();

    // Click one-click sync -> calls client.addHost for relay host and refreshes fleet hosts
    fireEvent.click(view.getByTestId("main-chat-fleet-sync-now"));
    await waitFor(() => {
      expect(client.addHost).toHaveBeenCalledWith({
        connection: expect.stringContaining("relay://relay.paseo.sh:443/srv_mac_relay"),
        label: "MacBook Pro",
      });
      expect(client.getMainChatFleetHosts).toHaveBeenCalledWith({ forceRefresh: true });
      expect(toastShowSpy).toHaveBeenCalled();
    });

    // Dismiss hides banner and exposes reopen chip on capsule bar
    fireEvent.click(view.getByTestId("main-chat-fleet-dismiss"));
    expect(view.queryByTestId("main-chat-unlinked-hosts-banner")).toBeNull();
    expect(view.getByTestId("main-chat-fleet-reopen-unlinked")).toBeTruthy();

    // Reopen restores banner; when only manual-only host exists, Sync button routes to host settings
    fireEvent.click(view.getByTestId("main-chat-fleet-reopen-unlinked"));
    mockHostsState.value = [clientHosts[0]!, clientHosts[4]!];
    view.unmount();
    const manualOnlyView = renderWithProviders(
      <HostSyncBanner serverId="srv_main" mainAgentId="agent_main" />,
    );
    fireEvent.click(manualOnlyView.getByTestId("main-chat-fleet-sync-now"));
    expect(mockRouterPush).toHaveBeenCalledWith("/settings/hosts/srv_main");
  });

  it("displays directions & side threads with quick create and archive controls in MainChatHistoryScreen", async () => {
    const leaderConv = makeConversation({
      id: "conv_hist_leader",
      kind: "leader",
      agentId: "agent_hist_leader",
      title: "搜索重构方向",
      directionSummary: "搜索召回与排序优化",
    });

    const client = makeFakeClient({
      listMainChatConversations: vi.fn(async () => ({
        requestId: "r_h",
        conversations: [leaderConv],
        error: null,
      })),
    });
    seedSessions({ mainClient: client });
    useMainChatConversationsStore.setState({
      conversationsByServerId: { srv_main: [leaderConv] },
    });

    const view = renderWithProviders(<MainChatHistoryScreen />);

    expect(view.getByTestId("main-chat-history-managed-conversations")).toBeTruthy();
    expect(view.getByTestId("main-chat-history-managed-conv_hist_leader")).toBeTruthy();
    expect(view.getByTestId("main-chat-history-create-conversation")).toBeTruthy();

    // Archive from history tab
    fireEvent.click(view.getByTestId("main-chat-history-archive-conv_hist_leader"));
    await waitFor(() => {
      expect(client.updateMainChatConversation).toHaveBeenCalledWith({
        conversationId: "conv_hist_leader",
        archived: true,
      });
    });
  });

  it("auto-fetches uncached conversation on /main/c/[conversationId] and renders Not Found fallback when missing", async () => {
    const fetchedSide = makeConversation({
      id: "conv_remote_fetched",
      kind: "side",
      agentId: "agent_remote_fetched",
      title: "远程拉取的侧对话",
    });

    const client = makeFakeClient({
      listMainChatConversations: vi.fn(async () => ({
        requestId: "r_fetch",
        conversations: [fetchedSide],
        error: null,
      })),
    });
    seedSessions({ mainClient: client });

    const view = renderWithProviders(
      <MainChatConversationScreen conversationId="conv_remote_fetched" />,
    );

    await waitFor(() => {
      expect(client.listMainChatConversations).toHaveBeenCalledWith({ includeArchived: true });
      expect(view.getByTestId("conversation-role-badge-side")).toBeTruthy();
      expect(view.getByTestId("mock-agent-host-srv_main:agent_remote_fetched")).toBeTruthy();
    });
    view.unmount();

    const missingView = renderWithProviders(
      <MainChatConversationScreen conversationId="conv_does_not_exist" />,
    );
    await waitFor(() => {
      expect(missingView.getByTestId("main-chat-conversation-not-found")).toBeTruthy();
    });
  });

  it("never introduces useUnistyles() across any M4 frontend file", () => {
    const m4Files = [
      "conversations-store.ts",
      "directions-tree.tsx",
      "host-sync-banner.tsx",
      "sidebar-directions-section.tsx",
      "conversation-screen.tsx",
      "main-chat-screen.tsx",
      "history-screen.tsx",
    ];
    for (const file of m4Files) {
      const content = readFileSync(path.resolve(__dirname, file), "utf8");
      expect(content).not.toContain("useUnistyles(");
    }
  });
});
