// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  MAIN_CHAT_DEFAULT_TITLE,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  type MainChatSettings,
  type MainChatTokenUsageSummary,
} from "@getpaseo/protocol/main-chat";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { PaneProvider, type PaneContextValue } from "@/panels/pane-context";
import { MainChatSettingsSection } from "@/screens/settings/main-chat/main-chat-section";
import {
  useSessionStore,
  type Agent,
  type SessionState,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { SubagentsTrack } from "@/subagents/track";
import type { SubagentRow } from "@/subagents/select";
import { MainChatHeroRow } from "./hero-row";
import { MainChatScreen } from "./main-chat-screen";
import { useMainChatSettingsStore } from "./settings-store";
import { SidebarDirectionsSection } from "./sidebar-directions-section";

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockPathname = vi.hoisted(() => ({ value: "/h/srv_1/workspace/ws_repo" }));
const mockActiveWorkspace = vi.hoisted<{ value: { serverId: string; workspaceId: string } | null }>(
  () => ({
    value: { serverId: "srv_1", workspaceId: "ws_repo" },
  }),
);
const mockHosts = vi.hoisted(() => [{ serverId: "srv_1", label: "iMac Local" }]);

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

vi.mock("@/hooks/use-directory-demand", () => ({
  useDirectoryDemand: () => undefined,
}));

const mockProviderSnapshotEntries = vi.hoisted<{
  value: ProviderSnapshotEntry[];
}>(() => ({ value: [] }));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: mockProviderSnapshotEntries.value,
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    refresh: vi.fn(async () => undefined),
    refetchIfStale: vi.fn(),
  }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHosts,
  useHostRuntimeConnectionStatus: () => "connected",
  getHostRuntimeStore: () => ({
    prepareAgentTimeline: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => mockActiveWorkspace.value,
  useLastWorkspaceSelection: () => mockActiveWorkspace.value,
  navigateToWorkspace: vi.fn(),
}));

vi.mock("@/components/provider-icons", () => ({
  useProviderIcon: () => () => null,
}));

vi.mock("@/attachments/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/attachments/service")>();
  return {
    ...actual,
    garbageCollectAttachments: vi.fn(async () => undefined),
  };
});

vi.mock("./agent-host", () => ({
  MainChatAgentHost: () => <div data-testid="mock-main-chat-agent-host" />,
}));

vi.mock("./task-panel-drawer", () => ({
  TaskPanelDrawer: () => <div data-testid="mock-task-panel-drawer" />,
}));

vi.mock("@/panels/agent-facts-line", () => ({
  useAgentFactsLine: () => null,
}));

vi.mock("@/composer/tracks", () => ({
  ComposerTrackPill: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-track-pill">{children}</div>
  ),
  ComposerTrackActions: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ComposerTrackRow: ({
    onPress,
    testID,
    accessibilityLabel,
  }: {
    onPress?: () => void;
    testID?: string;
    accessibilityLabel?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onPress}>
      {accessibilityLabel}
    </button>
  ),
}));

const noopToastApi = {
  show: vi.fn(),
  copied: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
};

const EMPTY_SUBAGENT_ROWS: SubagentRow[] = [];
const returnNullSheetTab = () => null;
const TEST_PANE_CONTEXT: PaneContextValue = {
  serverId: "srv_1",
  workspaceId: "ws_main",
  host: "main",
  tabId: "main-chat-pane:main",
  target: { kind: "agent", agentId: "agent_main" },
  openTab: vi.fn(),
  openPreferredTarget: vi.fn(),
  closeCurrentTab: vi.fn(),
  retargetCurrentTab: vi.fn(),
  setCurrentTabState: vi.fn(),
  openFileInWorkspace: vi.fn(),
  openImportSheet: vi.fn(),
};

function setHibernatingNightModeForServer(serverId: string): void {
  useMainChatSettingsStore.setState((state) => ({
    nightModeStatusByServerId: {
      ...state.nightModeStatusByServerId,
      [serverId]: {
        state: "hibernating",
        inNightWindow: true,
        effectivePatrolIntervalSec: 0,
        nextTransitionAt: "2026-11-24T00:00:00.000Z",
        reason: "夜间休眠中",
      },
    },
  }));
}

function clearAgentsForServer(serverId: string): void {
  useSessionStore.setState((state) => ({
    sessions: {
      ...state.sessions,
      [serverId]: {
        ...state.sessions[serverId]!,
        agents: new Map(),
      },
    },
  }));
}

function makeUsageFixture(): MainChatTokenUsageSummary {
  return {
    today: {
      turns: 4,
      inputTokens: 8000,
      cachedInputTokens: 20000,
      outputTokens: 2000,
      totalTokens: 30000,
      costUsd: 0.25,
    },
    last7Days: {
      turns: 12,
      inputTokens: 25000,
      cachedInputTokens: 60000,
      outputTokens: 5000,
      totalTokens: 90000,
      costUsd: 0.72,
    },
    allTime: {
      turns: 20,
      inputTokens: 40000,
      cachedInputTokens: 90000,
      outputTokens: 10000,
      totalTokens: 140000,
      costUsd: 1.15,
    },
    bySource: {
      foreground: {
        turns: 10,
        inputTokens: 25000,
        cachedInputTokens: 55000,
        outputTokens: 6000,
        totalTokens: 86000,
        costUsd: 0.7,
      },
      background: {
        turns: 6,
        inputTokens: 10000,
        cachedInputTokens: 25000,
        outputTokens: 2500,
        totalTokens: 37500,
        costUsd: 0.3,
      },
      direction: {
        turns: 2,
        inputTokens: 3000,
        cachedInputTokens: 10000,
        outputTokens: 1000,
        totalTokens: 14000,
        costUsd: 0.12,
      },
      triage: {
        turns: 2,
        inputTokens: 2000,
        cachedInputTokens: 0,
        outputTokens: 500,
        totalTokens: 2500,
        costUsd: 0.03,
      },
    },
    byModel: [
      {
        provider: "claude",
        model: "claude-opus-4-6",
        turns: 18,
        inputTokens: 38000,
        cachedInputTokens: 90000,
        outputTokens: 9500,
        totalTokens: 137500,
        costUsd: 1.12,
      },
    ],
    daily: [
      {
        date: "2026-11-23",
        turns: 4,
        inputTokens: 8000,
        cachedInputTokens: 20000,
        outputTokens: 2000,
        totalTokens: 30000,
        costUsd: 0.25,
        bySource: {
          foreground: {
            turns: 2,
            inputTokens: 4000,
            cachedInputTokens: 12000,
            outputTokens: 1000,
            totalTokens: 17000,
            costUsd: 0.15,
          },
          background: {
            turns: 2,
            inputTokens: 4000,
            cachedInputTokens: 8000,
            outputTokens: 1000,
            totalTokens: 13000,
            costUsd: 0.1,
          },
          direction: {
            turns: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
          triage: {
            turns: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            costUsd: 0,
          },
        },
      },
    ],
    updatedAt: "2026-11-23T15:00:00.000Z",
  };
}

function seedHost(overrides?: {
  settings?: MainChatSettings;
  usage?: MainChatTokenUsageSummary;
  ensureMainChat?: ReturnType<typeof vi.fn>;
  updateMainChatSettings?: ReturnType<typeof vi.fn>;
  resetMainChatUsage?: ReturnType<typeof vi.fn>;
}) {
  let currentSettings = overrides?.settings ?? {
    ...createDefaultMainChatSettings("conservative"),
    enabled: true,
  };
  const usage = overrides?.usage ?? makeUsageFixture();
  const ensureMainChat =
    overrides?.ensureMainChat ??
    vi.fn(async () => ({
      requestId: "r1",
      agentId: "agent_main",
      workspaceId: "ws_main",
      created: false,
      error: null,
    }));
  const updateMainChatSettings =
    overrides?.updateMainChatSettings ??
    vi.fn(async (patch) => {
      currentSettings = {
        ...currentSettings,
        ...patch,
        nightMode: {
          ...(currentSettings.nightMode ?? createDefaultMainChatSettings().nightMode!),
          ...patch.nightMode,
        },
      };
      return {
        requestId: "r2",
        settings: currentSettings,
        nightModeStatus: {
          state: currentSettings.enabled === false ? "disabled" : "active",
          inNightWindow: false,
          effectivePatrolIntervalSec: currentSettings.enabled === false ? 0 : 60,
          nextTransitionAt: null,
          reason: null,
        },
        error: null,
      };
    });
  const resetMainChatUsage =
    overrides?.resetMainChatUsage ??
    vi.fn(async () => ({
      requestId: "r3",
      usage: {
        ...makeUsageFixture(),
        today: {
          turns: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
        last7Days: {
          turns: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
        allTime: {
          turns: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
        daily: [],
        byModel: [],
      },
      error: null,
    }));

  const client = {
    getMainChatSettings: vi.fn(async () => ({
      requestId: "r_get",
      settings: currentSettings,
      nightModeStatus: {
        state: currentSettings.enabled === false ? "disabled" : "active",
        inNightWindow: false,
        effectivePatrolIntervalSec: currentSettings.enabled === false ? 0 : 60,
        nextTransitionAt: null,
        reason: null,
      },
      error: null,
    })),
    updateMainChatSettings,
    ensureMainChat,
    getMainChatOverview: vi.fn(async () => ({
      requestId: "r_ov",
      overview: null,
      error: null,
    })),
    getMainChatUsage: vi.fn(async () => ({
      requestId: "r_usage",
      usage,
      nightModeStatus: {
        state: currentSettings.enabled === false ? "disabled" : "active",
        inNightWindow: false,
        effectivePatrolIntervalSec: currentSettings.enabled === false ? 0 : 60,
        nextTransitionAt: null,
        reason: null,
      },
      error: null,
    })),
    resetMainChatUsage,
    listMainChatStandingAuthorizations: vi.fn(async () => ({
      requestId: "r_auth",
      authorizations: [],
      suggestions: [],
      error: null,
    })),
  } as unknown as DaemonClient;

  const workspaces = new Map<string, WorkspaceDescriptor>([
    [
      "ws_main",
      {
        id: "ws_main",
        serverId: "srv_1",
        projectId: "proj_main",
        projectName: MAIN_CHAT_DEFAULT_TITLE,
        projectRootPath: "/home/dev/.paseo/main-chat",
        workspaceDirectory: "/home/dev/.paseo/main-chat",
        title: MAIN_CHAT_DEFAULT_TITLE,
        createdAt: new Date(),
        updatedAt: new Date(),
      } as unknown as WorkspaceDescriptor,
    ],
  ]);
  const agents = new Map<string, Agent>([
    [
      "agent_main",
      {
        id: "agent_main",
        serverId: "srv_1",
        workspaceId: "ws_main",
        provider: "claude",
        title: MAIN_CHAT_DEFAULT_TITLE,
        status: "idle",
        turn: { phase: "idle" },
        pendingPermissions: [],
        cwd: "/home/dev/.paseo/main-chat",
        labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
        updatedAt: new Date(),
        createdAt: new Date(),
      } as unknown as Agent,
    ],
  ]);

  useSessionStore.setState({
    sessions: {
      srv_1: {
        client,
        serverInfo: {
          hostname: "imac-local",
          features: { mainChat: true },
        },
        agents,
        agentDetails: new Map(),
        workspaces,
        pendingPermissions: new Map(),
        hasHydratedAgents: true,
        hasHydratedWorkspaces: true,
        hasWorkspaceDirectorySnapshot: true,
      } as unknown as SessionState,
    },
  });

  useMainChatSettingsStore.setState({
    settingsByServerId: { srv_1: currentSettings },
    nightModeStatusByServerId: {
      srv_1: {
        state: currentSettings.enabled === false ? "disabled" : "active",
        inNightWindow: false,
        effectivePatrolIntervalSec: currentSettings.enabled === false ? 0 : 60,
        nextTransitionAt: null,
        reason: null,
      },
    },
    usageByServerId: { srv_1: usage },
    usageLoadingByServerId: {},
    loadingByServerId: {},
    lastPatrolByServerId: {},
  });

  return { client, ensureMainChat, updateMainChatSettings, resetMainChatUsage };
}

describe("Main Chat crash fix, global disable, night mode, and token usage UI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname.value = "/h/srv_1/workspace/ws_repo";
  });

  afterEach(() => {
    cleanup();
    useSessionStore.setState({ sessions: {} });
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      nightModeStatusByServerId: {},
      usageByServerId: {},
      usageLoadingByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
  });

  it("renders SubagentsTrack outside SheetPaneHostProvider without throwing Invariant failed", () => {
    const onOpenSubagent = vi.fn();

    // 1) Empty subagents (the exact crash trigger when opening /main on iMac!)
    const onOpenProviderSubagent = vi.fn();
    const onArchiveSubagent = vi.fn();
    const emptyView = render(
      <PaneProvider value={TEST_PANE_CONTEXT}>
        <SubagentsTrack
          serverId="srv_1"
          rows={EMPTY_SUBAGENT_ROWS}
          onOpenSubagent={onOpenSubagent}
          onOpenProviderSubagent={onOpenProviderSubagent}
          sheetTabFor={returnNullSheetTab}
          onArchiveSubagent={onArchiveSubagent}
        />
      </PaneProvider>,
    );
    expect(emptyView.container.firstChild).toBeNull();
    emptyView.unmount();

    // 2) Active subagent row falls through cleanly to onOpenSubagent without needing SheetPaneHostProvider
    const row: SubagentRow = {
      kind: "paseo",
      id: "sub_1",
      address: { serverId: "srv_1", agentId: "sub_1" },
      provider: "claude",
      title: "Fix build",
      titleState: "ready",
      status: "running",
      turn: { phase: "open" },
      requiresAttention: false,
      updatedAtMs: Date.now(),
    } as unknown as SubagentRow;
    const singleRowList = [row];

    const nonEmptyView = render(
      <PaneProvider value={TEST_PANE_CONTEXT}>
        <SubagentsTrack
          serverId="srv_1"
          rows={singleRowList}
          onOpenSubagent={onOpenSubagent}
          onOpenProviderSubagent={onOpenProviderSubagent}
          sheetTabFor={returnNullSheetTab}
          onArchiveSubagent={onArchiveSubagent}
        />
      </PaneProvider>,
    );
    fireEvent.click(nonEmptyView.getByTestId("subagents-track-row-sub_1"));
    expect(onOpenSubagent).toHaveBeenCalledWith({ serverId: "srv_1", agentId: "sub_1" });
  });

  it("hides MainChatHeroRow and SidebarDirectionsSection when globally disabled, and renders night badge when active", () => {
    const disabledSettings = createDefaultMainChatSettings("conservative");
    disabledSettings.enabled = false;
    seedHost({ settings: disabledSettings });

    const heroDisabled = render(
      <ToastApiProvider api={noopToastApi}>
        <KeyboardActionDispatcherProvider>
          <MainChatHeroRow />
        </KeyboardActionDispatcherProvider>
      </ToastApiProvider>,
    );
    expect(heroDisabled.queryByTestId("sidebar-main-chat-hero")).toBeNull();
    heroDisabled.unmount();

    const dirDisabled = render(<SidebarDirectionsSection />);
    expect(dirDisabled.queryByTestId("sidebar-directions-section")).toBeNull();
    dirDisabled.unmount();

    // Re-enable and set night mode status to hibernating -> hero renders with night badge!
    const enabledSettings = createDefaultMainChatSettings("conservative");
    enabledSettings.enabled = true;
    seedHost({ settings: enabledSettings });
    act(() => {
      setHibernatingNightModeForServer("srv_1");
    });

    const heroNight = render(
      <ToastApiProvider api={noopToastApi}>
        <KeyboardActionDispatcherProvider>
          <MainChatHeroRow />
        </KeyboardActionDispatcherProvider>
      </ToastApiProvider>,
    );
    expect(heroNight.getByTestId("sidebar-main-chat-hero")).toBeTruthy();
    expect(heroNight.getByTestId("sidebar-main-chat-hero-night-badge")).toBeTruthy();
  });

  it("shows disabled screen on /main without calling ensureMainChat and allows one-click re-enable", async () => {
    const disabledSettings = createDefaultMainChatSettings("conservative");
    disabledSettings.enabled = false;
    const { ensureMainChat, updateMainChatSettings } = seedHost({ settings: disabledSettings });

    // Remove existing agent from session so ensureMainChat would have fired if not guarded.
    act(() => {
      clearAgentsForServer("srv_1");
    });

    const view = render(
      <ToastApiProvider api={noopToastApi}>
        <KeyboardActionDispatcherProvider>
          <MainChatScreen />
        </KeyboardActionDispatcherProvider>
      </ToastApiProvider>,
    );

    expect(view.getByTestId("main-chat-disabled-state")).toBeTruthy();
    expect(ensureMainChat).not.toHaveBeenCalled();

    fireEvent.click(view.getByTestId("main-chat-re-enable-button"));
    await waitFor(() => {
      expect(updateMainChatSettings).toHaveBeenCalledWith({ enabled: true });
    });
  });

  it("renders grouped host controls, collapsible advanced settings with token usage & night mode, and leave-group disable", async () => {
    const { updateMainChatSettings, resetMainChatUsage } = seedHost();

    const view = render(
      <ToastApiProvider api={noopToastApi}>
        <KeyboardActionDispatcherProvider>
          <MainChatSettingsSection />
        </KeyboardActionDispatcherProvider>
      </ToastApiProvider>,
    );

    // Advanced settings collapsed by default to keep Settings focused
    expect(view.queryByTestId("settings-main-chat-usage-today")).toBeNull();
    expect(view.queryByTestId("settings-main-chat-night-mode")).toBeNull();

    // Expanding Advanced Settings reveals token usage dashboard & night mode controls
    fireEvent.click(view.getByTestId("settings-main-chat-advanced-toggle"));
    expect(view.getByTestId("settings-main-chat-usage-today").textContent).toContain("30.0K");
    expect(view.getByTestId("settings-main-chat-usage-all").textContent).toContain("140K");
    expect(view.getByTestId("settings-main-chat-usage-source-foreground")).toBeTruthy();
    expect(view.getByTestId("settings-main-chat-usage-source-background")).toBeTruthy();
    expect(view.getByTestId("settings-main-chat-usage-source-triage")).toBeTruthy();

    // Two-step reset usage flow
    fireEvent.click(view.getByTestId("settings-main-chat-usage-reset"));
    fireEvent.click(view.getByTestId("settings-main-chat-usage-reset-confirm"));
    await waitFor(() => {
      expect(resetMainChatUsage).toHaveBeenCalledTimes(1);
    });

    // Night mode panel present inside Advanced Settings
    expect(view.getByTestId("settings-main-chat-night-enabled")).toBeTruthy();

    // Leaving management on owner host turns off Main Chat and hides operational settings
    fireEvent.click(view.getByTestId("main-chat-host-leave-srv_1"));
    await waitFor(() => {
      expect(updateMainChatSettings).toHaveBeenCalledWith({
        enabled: false,
        fleetScope: { mode: "local_only", hostServerIds: [] },
      });
    });
    expect(view.queryByTestId("settings-main-chat-night-mode")).toBeNull();
    expect(view.getByTestId("main-chat-unmanaged-host-srv_1")).toBeTruthy();
  });

  it("does not auto-create Main Chat with a default model on first entry and waits for manual model selection", async () => {
    mockProviderSnapshotEntries.value = [
      {
        provider: "codex",
        label: "Codex",
        enabled: true,
        status: "ready",
        models: [
          { provider: "codex", id: "gpt-5.6-terra", label: "GPT-5.6-Terra", isDefault: true },
        ],
      },
      {
        provider: "claude",
        label: "Claude Code",
        enabled: true,
        status: "ready",
        models: [
          { provider: "claude", id: "claude-opus-4-6", label: "Claude Opus 4.6", isDefault: true },
        ],
      },
    ];
    try {
      const enabledSettings = createDefaultMainChatSettings("conservative");
      enabledSettings.enabled = true;
      const { ensureMainChat } = seedHost({ settings: enabledSettings });

      // Clear existing Main Chat agent to simulate first-time entry after directory hydration
      act(() => {
        clearAgentsForServer("srv_1");
      });

      const view = render(
        <ToastApiProvider api={noopToastApi}>
          <KeyboardActionDispatcherProvider>
            <MainChatScreen />
          </KeyboardActionDispatcherProvider>
        </ToastApiProvider>,
      );

      // Must show first-time setup UI and NEVER auto-call ensureMainChat()
      expect(view.getByTestId("main-chat-first-setup")).toBeTruthy();
      expect(ensureMainChat).not.toHaveBeenCalled();
      // Thinking & safety mode fields stay hidden until user chooses a provider/model
      expect(view.queryByTestId("main-chat-first-setup-thinking-field")).toBeNull();
      expect(view.queryByTestId("main-chat-first-setup-mode-field")).toBeNull();
      // Host group orchestration capsule remains accessible on /main during first setup
      expect(view.getByTestId("main-chat-host-sync-banner")).toBeTruthy();
      // Start button stays disabled until the user explicitly chooses a model
      const startButton = view.getByTestId("main-chat-first-setup-start");
      expect(startButton.getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(startButton);
      expect(ensureMainChat).not.toHaveBeenCalled();
    } finally {
      mockProviderSnapshotEntries.value = [];
    }
  });

  it("dynamically links thinking intensity and safety mode to selected provider/model and forwards both to ensureMainChat", async () => {
    mockProviderSnapshotEntries.value = [
      {
        provider: "claude",
        label: "Claude Code",
        enabled: true,
        status: "ready",
        defaultModeId: "acceptEdits",
        modes: [
          { id: "default", label: "Ask before editing", description: "Ask before running tools" },
          { id: "acceptEdits", label: "Edit automatically", description: "Auto-approve edits" },
          { id: "bypassPermissions", label: "Full access", description: "Run without prompts" },
        ],
        models: [
          {
            provider: "claude",
            id: "claude-opus-5-5",
            label: "Claude Opus 5.5",
            isDefault: true,
            defaultThinkingOptionId: "high",
            thinkingOptions: [
              { id: "low", label: "Low" },
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
          },
          {
            provider: "claude",
            id: "claude-haiku-legacy",
            label: "Claude Haiku Legacy",
            thinkingOptions: [],
          },
        ],
      },
      {
        provider: "minimal",
        label: "Minimal Provider",
        enabled: true,
        status: "ready",
        modes: [],
        models: [
          {
            provider: "minimal",
            id: "minimal-fast",
            label: "Minimal Fast",
            isDefault: true,
          },
        ],
      },
    ];
    try {
      const enabledSettings = createDefaultMainChatSettings("conservative");
      enabledSettings.enabled = true;
      const { ensureMainChat } = seedHost({ settings: enabledSettings });

      act(() => {
        clearAgentsForServer("srv_1");
      });

      const view = render(
        <ToastApiProvider api={noopToastApi}>
          <KeyboardActionDispatcherProvider>
            <MainChatScreen />
          </KeyboardActionDispatcherProvider>
        </ToastApiProvider>,
      );

      // Helper to pick a model through CombinedModelSelector (supports provider drill-down)
      async function selectProviderAndModel(providerLabel: string | null, modelLabel: string) {
        fireEvent.click(view.getByTestId("combined-model-selector"));
        if (providerLabel) {
          const backButton = view.queryByLabelText(/back|modelSelector\.back/i);
          if (backButton && !view.queryByText(providerLabel)) {
            fireEvent.click(backButton);
          }
          const providerEl = await view.findByText(providerLabel);
          fireEvent.click(providerEl);
        }
        const modelEl = await view.findByText(modelLabel);
        fireEvent.click(modelEl);
      }

      // Select Claude Opus 5.5 from CombinedModelSelector
      await selectProviderAndModel("Claude Code", "Claude Opus 5.5");

      // Thinking & safety mode selectors appear with model/provider defaults
      const thinkingTrigger = await view.findByTestId("main-chat-first-setup-thinking");
      const modeTrigger = await view.findByTestId("main-chat-first-setup-mode");
      expect(thinkingTrigger.textContent).toContain("High");
      expect(modeTrigger.textContent).toContain("Edit automatically");

      // Switch thinking to Max and safety mode to Full access
      fireEvent.click(thinkingTrigger);
      fireEvent.click(await view.findByTestId("main-chat-first-setup-thinking-option-max"));
      expect(view.getByTestId("main-chat-first-setup-thinking").textContent).toContain("Max");

      fireEvent.click(view.getByTestId("main-chat-first-setup-mode"));
      fireEvent.click(
        await view.findByTestId("main-chat-first-setup-mode-option-bypassPermissions"),
      );
      expect(view.getByTestId("main-chat-first-setup-mode").textContent).toContain("Full access");

      // Switching to a model without thinkingOptions hides thinking selector while keeping mode
      await selectProviderAndModel(null, "Claude Haiku Legacy");
      await waitFor(() => {
        expect(view.queryByTestId("main-chat-first-setup-thinking-field")).toBeNull();
      });
      expect(view.getByTestId("main-chat-first-setup-mode-field")).toBeTruthy();

      // Switching to a provider without modes hides both thinking & mode selectors
      await selectProviderAndModel("Minimal Provider", "Minimal Fast");
      await waitFor(() => {
        expect(view.queryByTestId("main-chat-first-setup-thinking-field")).toBeNull();
        expect(view.queryByTestId("main-chat-first-setup-mode-field")).toBeNull();
      });

      // Switch back to Claude Opus 5.5, set Max + bypassPermissions, and submit
      await selectProviderAndModel("Claude Code", "Claude Opus 5.5");
      await view.findByTestId("main-chat-first-setup-thinking");
      fireEvent.click(view.getByTestId("main-chat-first-setup-thinking"));
      fireEvent.click(await view.findByTestId("main-chat-first-setup-thinking-option-max"));
      fireEvent.click(view.getByTestId("main-chat-first-setup-mode"));
      fireEvent.click(
        await view.findByTestId("main-chat-first-setup-mode-option-bypassPermissions"),
      );

      fireEvent.click(view.getByTestId("main-chat-first-setup-start"));
      await waitFor(() => {
        expect(ensureMainChat).toHaveBeenCalledWith({
          provider: "claude",
          model: "claude-opus-5-5",
          modeId: "bypassPermissions",
          thinkingOptionId: "max",
        });
      });
    } finally {
      mockProviderSnapshotEntries.value = [];
    }
  });
});
