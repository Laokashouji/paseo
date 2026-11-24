// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_CONVERSATION_ID_LABEL,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  type MainChatOverview,
} from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { AgentTracks } from "@/panels/agent-tracks";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import { MainChatSettingsSection } from "@/screens/settings/main-chat/main-chat-section";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { useMainChatSettingsStore } from "./settings-store";
import { MainChatShellProvider } from "./shell-context";

const mockHosts = vi.hoisted(() => [{ serverId: "srv_1", label: "DevBox" }]);
const mockSubagentRows = vi.hoisted(() => [
  {
    id: "sub_1",
    kind: "agent" as const,
    agentId: "sub_1",
    serverId: "srv_1",
    title: "Child Worker",
    bucket: "running" as const,
  },
]);

vi.mock("expo-router", () => ({
  router: { push: vi.fn(), replace: vi.fn(), navigate: vi.fn() },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), navigate: vi.fn() }),
  usePathname: () => "/main",
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

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({ entries: [], isLoading: false }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: () => false,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHosts,
  useHostRuntimeConnectionStatus: () => "connected",
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => ({ serverId: "srv_1", workspaceId: "ws_repo" }),
  useLastWorkspaceSelection: () => ({ serverId: "srv_1", workspaceId: "ws_repo" }),
  navigateToWorkspace: vi.fn(),
}));

vi.mock("@/background-work", () => ({
  BackgroundWorkTrack: () => null,
  createHostBackgroundWorkModel: () => ({}),
}));

vi.mock("@/composer/diff-stat-pill", () => ({
  WorkspaceDiffStatPill: () => null,
}));

vi.mock("@/composer/task-list", () => ({
  AgentTaskList: () => null,
}));

vi.mock("@/composer/tracks", () => ({
  ComposerTrackBar: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-composer-track-bar">{children}</div>
  ),
}));

vi.mock("@/plugins", () => ({
  PluginComposerPills: () => null,
}));

vi.mock("@/subagents", () => ({
  useSubagentsForParent: () => mockSubagentRows,
  useArchiveFinishedSubagents: () => ({ archiveFinished: vi.fn(), status: "idle" }),
  useArchiveSubagent: () => vi.fn(),
  useDetachSubagent: () => vi.fn(),
  useSubagentSheetTab: () => () => null,
}));

vi.mock("@/subagents/parent", () => ({
  ParentAgentPill: () => null,
}));

vi.mock("@/subagents/track", () => ({
  SubagentsTrack: ({ rows }: { rows: unknown[] }) => (
    <div data-testid="mock-subagents-track">{rows.length} subagents</div>
  ),
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: vi.fn(),
}));

vi.mock("@/workspace-tabs/open-beside", () => ({
  openPreferredWorkspaceTarget: vi.fn(),
}));

vi.mock("@/workspace-tabs/open-supporting-view", () => ({
  openComposerChanges: vi.fn(),
}));

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  const now = new Date();
  return {
    serverId: "srv_1",
    workspaceId: "ws_main",
    provider: "claude",
    status: "idle",
    lifecycle: "idle",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    cwd: "/repo/app",
    model: "claude-opus-4-6",
    thinkingOptionId: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    labels: {},
    background: false,
    title: overrides.id,
    pendingPermissions: [],
    turn: { phase: "idle", turnId: null, startedAt: null, cancellationRequestId: null },
    ...overrides,
  } as unknown as Agent;
}

function makeOverview(metricsOverrides?: Partial<MainChatOverview["metrics"]>): MainChatOverview {
  return {
    plans: [],
    decisions: [],
    tasks: [],
    triages: [],
    autoStartRules: [],
    permissionRules: [],
    metrics: {
      autoContinued: 3,
      plansCreated: 2,
      plansAutoStarted: 1,
      plansStarted: 1,
      plansCancelled: 0,
      receiptsRecorded: 1,
      interrupts: 1,
      supervisorHeld: 5,
      reworkCount: 2,
      stalledNudges: 0,
      usageLimitRetries: 0,
      ...metricsOverrides,
    },
    settings: createDefaultMainChatSettings(),
  };
}

function makePaneContext(agentId: string): PaneContextValue {
  return {
    serverId: "srv_1",
    workspaceId: "ws_main",
    host: "main",
    tabId: `tab:${agentId}`,
    target: { kind: "agent", agentId },
    openTab: vi.fn(),
    openPreferredTarget: vi.fn(),
    closeCurrentTab: vi.fn(),
    retargetCurrentTab: vi.fn(),
    setCurrentTabState: vi.fn(),
    openFileInWorkspace: vi.fn(),
    openImportSheet: vi.fn(),
  };
}

function seedSession(agentsList: Agent[], clientOverrides?: Partial<DaemonClient>): DaemonClient {
  const settings = createDefaultMainChatSettings();
  const overview = makeOverview();
  const client = {
    getMainChatSettings: vi.fn(async () => ({ settings, nightModeStatus: null, error: null })),
    updateMainChatSettings: vi.fn(async () => ({ settings, nightModeStatus: null, error: null })),
    getMainChatUsage: vi.fn(async () => ({ summary: null, error: null })),
    getMainChatOverview: vi.fn(async () => ({ overview, error: null })),
    listMainChatStandingAuthorizations: vi.fn(async () => ({
      authorizations: [],
      suggestions: [],
      error: null,
    })),
    ensureMainChat: vi.fn(async () => ({
      agentId: "agent_main",
      workspaceId: "ws_main",
      created: false,
      error: null,
    })),
    ...clientOverrides,
  } as unknown as DaemonClient;

  const agents = new Map<string, Agent>();
  for (const agent of agentsList) {
    agents.set(agent.id, agent);
  }

  useSessionStore.setState({
    sessions: {
      srv_1: {
        client,
        agents,
        agentDetails: new Map(),
        workspaces: new Map(),
        pendingPermissions: new Map(),
        agentTasks: new Map(),
        serverInfo: {
          serverId: "srv_1",
          features: { mainChat: true, agentDetach: true },
        },
      } as unknown as SessionState,
    },
  });
  return client;
}

const TEST_QUERY_CLIENT = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

const TEST_SHELL_VALUE = {
  inMainChatShell: true,
  originRoute: "/main",
  originTitle: "对话管理",
};

const TEST_TOAST_API = {
  show: vi.fn(),
  copied: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
};

describe("Single-row Main Chat tray consolidation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({ sessions: {} });
    useMainChatOverviewStore.setState({
      overviewsByKey: {},
      decisionsByKey: {},
    });
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      nightModeStatusByServerId: {},
      usageByServerId: {},
      usageLoadingByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("hides SubagentsTrack and removes legacy Task Board pill for Main Chat & Direction Conversations while preserving it for child coding agents", () => {
    const mainAgent = makeAgent({
      id: "agent_main",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    const directionAgent = makeAgent({
      id: "agent_direction",
      labels: { [MAIN_CHAT_CONVERSATION_ID_LABEL]: "conv_dir_1" },
    });
    const childCodingAgent = makeAgent({
      id: "agent_worker",
      workspaceId: "ws_repo",
      labels: {},
    });
    seedSession([mainAgent, directionAgent, childCodingAgent]);

    // 1. Main Chat agent: no legacy board pill and no duplicate SubagentsTrack
    const mainView = render(
      <QueryClientProvider client={TEST_QUERY_CLIENT}>
        <MainChatShellProvider value={TEST_SHELL_VALUE}>
          <PaneProvider value={makePaneContext("agent_main")}>
            <AgentTracks
              serverId="srv_1"
              workspaceId="ws_main"
              agentId="agent_main"
              parentAgentId={null}
            />
          </PaneProvider>
        </MainChatShellProvider>
      </QueryClientProvider>,
    );
    expect(mainView.queryByTestId("main-chat-board-pill")).toBeNull();
    expect(mainView.queryByTestId("mock-subagents-track")).toBeNull();
    mainView.unmount();

    // 2. Direction conversation agent: also suppresses duplicate SubagentsTrack
    const dirView = render(
      <QueryClientProvider client={TEST_QUERY_CLIENT}>
        <MainChatShellProvider value={TEST_SHELL_VALUE}>
          <PaneProvider value={makePaneContext("agent_direction")}>
            <AgentTracks
              serverId="srv_1"
              workspaceId="ws_main"
              agentId="agent_direction"
              parentAgentId={null}
            />
          </PaneProvider>
        </MainChatShellProvider>
      </QueryClientProvider>,
    );
    expect(dirView.queryByTestId("mock-subagents-track")).toBeNull();
    dirView.unmount();

    // 3. Regular child coding agent opened inside MainChatShell's TaskPanelDrawer keeps its own SubagentsTrack
    const workerView = render(
      <QueryClientProvider client={TEST_QUERY_CLIENT}>
        <MainChatShellProvider value={TEST_SHELL_VALUE}>
          <PaneProvider value={makePaneContext("agent_worker")}>
            <AgentTracks
              serverId="srv_1"
              workspaceId="ws_repo"
              agentId="agent_worker"
              parentAgentId="agent_main"
            />
          </PaneProvider>
        </MainChatShellProvider>
      </QueryClientProvider>,
    );
    expect(workerView.getByTestId("mock-subagents-track")).toBeTruthy();
  });

  it("displays supervisor brief metrics inside MainChatSettingsSection", async () => {
    const mainAgent = makeAgent({
      id: "agent_main",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    const expectedOverview = makeOverview({
      supervisorHeld: 7,
      autoContinued: 4,
      reworkCount: 2,
      interrupts: 1,
    });
    const client = seedSession([mainAgent], {
      getMainChatOverview: vi.fn(async () => ({
        requestId: "req_ov",
        overview: expectedOverview,
        error: null,
      })),
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_1", "agent_main")]: expectedOverview,
      },
    });

    const view = render(
      <ToastApiProvider api={TEST_TOAST_API}>
        <KeyboardActionDispatcherProvider>
          <MainChatSettingsSection />
        </KeyboardActionDispatcherProvider>
      </ToastApiProvider>,
    );

    await waitFor(() => {
      expect(client.getMainChatSettings).toHaveBeenCalled();
    });

    const metricsRow = await view.findByTestId("settings-main-chat-supervisor-metrics");
    expect(metricsRow.textContent).toContain('"held":7');
    expect(metricsRow.textContent).toContain('"autoContinued":4');
    expect(metricsRow.textContent).toContain('"rework":2');
    expect(metricsRow.textContent).toContain('"interrupts":1');
  });
});
