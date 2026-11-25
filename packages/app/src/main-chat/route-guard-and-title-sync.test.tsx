// @vitest-environment jsdom

import {
  MAIN_CHAT_FORMER_ROLE_VALUE,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_ID_LABEL,
} from "@getpaseo/protocol/main-chat";
import { cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import {
  useSessionStore,
  type Agent,
  type SessionState,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { selectIsMainChatWorkspaceRedirectTarget } from "./selectors";

const mockRouterReplace = vi.hoisted(() => vi.fn());
const mockRouterNavigate = vi.hoisted(() => vi.fn());
const mockHistoryAgents = vi.hoisted<{ value: AggregatedAgent[] }>(() => ({ value: [] }));

vi.mock("expo-router", () => ({
  router: {
    replace: mockRouterReplace,
    navigate: mockRouterNavigate,
    push: vi.fn(),
  },
  useRouter: () => ({
    replace: mockRouterReplace,
    navigate: mockRouterNavigate,
    push: vi.fn(),
    canGoBack: () => false,
    back: vi.fn(),
  }),
  usePathname: () => "/h/srv_1/workspace/ws_main",
  useLocalSearchParams: () => ({}),
}));

vi.mock("expo-router/react-navigation", () => ({
  useIsFocused: () => true,
  useNavigation: () => ({ setParams: vi.fn() }),
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
      i18n: { language: "zh-CN" },
    }),
  };
});

vi.mock("@/panels/register-panels", () => ({
  ensurePanelsRegistered: () => undefined,
}));

vi.mock("@/hooks/use-agent-history", () => ({
  useAgentHistory: () => ({
    agents: mockHistoryAgents.value,
    isLoading: false,
    isInitialLoad: false,
    isRevalidating: false,
    isError: false,
    hasMore: false,
    isLoadingMore: false,
    isSearchSupported: true,
    isSearchTruncated: false,
    isPreviousResults: false,
    hostErrors: [],
    refreshAll: vi.fn(async () => undefined),
    loadMore: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-import-session", () => ({
  useImportSession: () => ({
    open: vi.fn(),
    sheet: null,
  }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "srv_1", label: "DevBox" }],
  useHostRuntimeClient: () => null,
  useHostRuntimeIsConnected: () => true,
  getHostRuntimeStore: () => ({
    prepareWorkspaceRoute: vi.fn(async () => undefined),
    acquireScriptStatusDemand: vi.fn(() => () => undefined),
  }),
}));

vi.mock("@/components/headers/menu-header", () => ({
  MenuHeader: ({ title }: { title: string }) =>
    React.createElement("div", { "data-testid": "menu-header" }, title),
}));

vi.mock("@/components/agent-list", () => ({
  AgentList: ({ agents }: { agents: AggregatedAgent[] }) =>
    React.createElement(
      "div",
      { "data-testid": "sessions-agent-list" },
      agents.map((agent) =>
        React.createElement(
          "div",
          { key: `${agent.serverId}:${agent.id}`, "data-testid": `session-row-${agent.id}` },
          agent.title ?? agent.id,
        ),
      ),
    ),
}));

vi.mock("@/components/ui/search-field", () => ({
  SearchField: () => React.createElement("div", { "data-testid": "search-field" }),
}));

vi.mock("@/components/hosts/host-filter", () => ({
  HostFilter: () => React.createElement("div", { "data-testid": "host-filter" }),
}));

const { WorkspaceScreen } = await import("@/screens/workspace/workspace-screen");
const { SessionsScreen } = await import("@/screens/sessions-screen");

function makeWorkspace(
  overrides: Partial<WorkspaceDescriptor> & { id: string },
): WorkspaceDescriptor {
  return {
    workspaceDirectory: "/repo/app",
    projectRootPath: "/repo/app",
    title: "App",
    branchName: null,
    isGit: true,
    scripts: [],
    setupStatus: null,
    archivedAt: null,
    ...overrides,
  } as unknown as WorkspaceDescriptor;
}

function makeAgent(overrides: Partial<Agent> & { id: string; workspaceId: string }): Agent {
  const now = new Date("2026-11-25T10:00:00.000Z");
  return {
    serverId: "srv_1",
    provider: "claude",
    status: "idle",
    turn: { phase: "closed" },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    lastUserMessageAt: null,
    cwd: "/repo/app",
    title: "Session",
    pendingPermissions: [],
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    background: false,
    backgroundWork: false,
    labels: {},
    ...overrides,
  } as unknown as Agent;
}

function makeAggregatedAgent(
  overrides: Partial<AggregatedAgent> & { id: string; title: string },
): AggregatedAgent {
  const now = new Date("2026-11-25T10:00:00.000Z");
  return {
    serverId: "srv_1",
    serverLabel: "DevBox",
    status: "closed",
    turn: { phase: "closed" },
    lastActivityAt: now,
    cwd: "/repo/app",
    workspaceId: "ws_regular",
    provider: "claude",
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    createdAt: now,
    labels: {},
    projectPlacement: null,
    ...overrides,
  } as unknown as AggregatedAgent;
}

function seedSession(input: { workspaces?: WorkspaceDescriptor[]; agents?: Agent[] }) {
  const workspaces = new Map((input.workspaces ?? []).map((ws) => [ws.id, ws]));
  const agents = new Map((input.agents ?? []).map((agent) => [agent.id, agent]));
  useSessionStore.setState({
    sessions: {
      srv_1: {
        client: null,
        agents,
        agentDetails: new Map(),
        workspaces,
        pendingPermissions: new Map(),
        hasHydratedWorkspaces: true,
        hasHydratedAgents: true,
        serverInfo: {
          serverId: "srv_1",
          hostname: "DevBox",
          features: { mainChat: true },
        },
      } as unknown as SessionState,
    },
  });
}

describe("Main Chat route guard and Sessions filtering", () => {
  beforeEach(() => {
    mockRouterReplace.mockReset();
    mockRouterNavigate.mockReset();
    mockHistoryAgents.value = [];
    useSessionStore.setState({ sessions: {} });
    useWorkspaceLayoutStore.setState({
      pendingOpenByWorkspace: {},
      layoutByWorkspace: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("selectIsMainChatWorkspaceRedirectTarget matches dedicated main-chat workspaces and main-chat agents only", () => {
    const wsMain = makeWorkspace({
      id: "ws_main",
      workspaceDirectory: "/home/dev/.paseo/main-chat",
      projectRootPath: "/home/dev/.paseo/main-chat",
      title: "主对话",
    });
    const wsRegular = makeWorkspace({
      id: "ws_regular",
      workspaceDirectory: "/home/dev/repo",
      projectRootPath: "/home/dev/repo",
      title: "Repo",
    });
    const mainAgent = makeAgent({
      id: "agent_main",
      workspaceId: "ws_main",
      title: "主对话",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    const regularAgent = makeAgent({
      id: "agent_regular",
      workspaceId: "ws_regular",
      title: "开发任务",
    });
    seedSession({
      workspaces: [wsMain, wsRegular],
      agents: [mainAgent, regularAgent],
    });

    const state = useSessionStore.getState();
    expect(selectIsMainChatWorkspaceRedirectTarget(state, "srv_1", "ws_main", null)).toBe(true);
    expect(
      selectIsMainChatWorkspaceRedirectTarget(state, "srv_1", "ws_regular", "agent_main"),
    ).toBe(true);
    expect(
      selectIsMainChatWorkspaceRedirectTarget(state, "srv_1", "ws_regular", "agent_regular"),
    ).toBe(false);
    expect(selectIsMainChatWorkspaceRedirectTarget(state, "srv_1", "ws_regular", null)).toBe(false);
  });

  it("redirects WorkspaceScreen to /main when opening the dedicated main-chat workspace without mounting regular workspace chrome", async () => {
    seedSession({
      workspaces: [
        makeWorkspace({
          id: "ws_main",
          workspaceDirectory: "/home/dev/.paseo/main-chat",
          projectRootPath: "/home/dev/.paseo/main-chat",
          title: "主对话",
        }),
      ],
      agents: [
        makeAgent({
          id: "agent_main",
          workspaceId: "ws_main",
          title: "主对话",
          labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
        }),
      ],
    });

    const view = render(<WorkspaceScreen serverId="srv_1" workspaceId="ws_main" isRouteFocused />);

    expect(view.getByTestId("workspace-main-chat-redirect")).toBeTruthy();
    expect(view.container.textContent).not.toContain("主对话");
    await waitFor(() => {
      expect(mockRouterReplace).toHaveBeenCalledWith("/main?serverId=srv_1");
    });
  });

  it("redirects WorkspaceScreen to /main when active tab targets a main-chat agent even in a non-standard workspace", async () => {
    seedSession({
      workspaces: [
        makeWorkspace({
          id: "ws_other",
          workspaceDirectory: "/tmp/other-workspace",
          projectRootPath: "/tmp/other-workspace",
          title: "Other",
        }),
      ],
      agents: [
        makeAgent({
          id: "agent_main",
          workspaceId: "ws_other",
          title: "主对话",
          labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
        }),
        makeAgent({
          id: "agent_regular",
          workspaceId: "ws_other",
          title: "Regular",
        }),
      ],
    });
    useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: "srv_1:ws_other",
      target: { kind: "agent", agentId: "agent_main" },
      intent: "reveal",
    });

    const view = render(<WorkspaceScreen serverId="srv_1" workspaceId="ws_other" isRouteFocused />);

    expect(view.getByTestId("workspace-main-chat-redirect")).toBeTruthy();
    await waitFor(() => {
      expect(mockRouterReplace).toHaveBeenCalledWith("/main?serverId=srv_1");
    });
  });

  it("filters paseo.role=main and former_main agents out of SessionsScreen while showing regular and child sessions", () => {
    mockHistoryAgents.value = [
      makeAggregatedAgent({
        id: "leader-1",
        title: "方向管家",
        workspaceId: "ws_main",
        labels: {
          "paseo.main-chat.conversation-kind": "leader",
          "paseo.main-chat.conversation-id": "direction-1",
        },
      }),
      makeAggregatedAgent({
        id: "agent_main",
        title: "主对话",
        workspaceId: "ws_main",
        labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      }),
      makeAggregatedAgent({
        id: "agent_former_main",
        title: "昨日主对话",
        workspaceId: "ws_main",
        labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_FORMER_ROLE_VALUE },
      }),
      makeAggregatedAgent({
        id: "agent_child",
        title: "子任务：修复接口",
        workspaceId: "ws_regular",
        labels: { [MAIN_CHAT_TASK_ID_LABEL]: "task_1" },
      }),
      makeAggregatedAgent({
        id: "agent_normal",
        title: "常规开发会话",
        workspaceId: "ws_regular",
      }),
    ];

    const view = render(<SessionsScreen />);

    expect(view.queryByText("方向管家")).toBeNull();
    expect(view.queryByTestId("session-row-agent_main")).toBeNull();
    expect(view.queryByTestId("session-row-agent_former_main")).toBeNull();
    expect(view.getByTestId("session-row-agent_child")).toBeTruthy();
    expect(view.getByTestId("session-row-agent_normal")).toBeTruthy();
  });
});
