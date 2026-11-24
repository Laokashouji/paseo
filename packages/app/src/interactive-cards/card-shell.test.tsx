// @vitest-environment jsdom
import type { InteractiveCardView } from "@getpaseo/protocol/interactive-cards";
import type { MainChatOverview } from "@getpaseo/protocol/main-chat";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import { ToastApiProvider } from "@/contexts/toast-context";
import { useMainChatCameFromStore } from "@/main-chat/came-from-store";
import { useMainChatDrawerStore } from "@/main-chat/drawer-store";
import { overviewStoreKey, useMainChatOverviewStore } from "@/main-chat/overview-store";
import { MainChatShellProvider } from "@/main-chat/shell-context";
import { useSessionStore } from "@/stores/session-store";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { InteractiveCardShell } from "./card-shell";
import { InteractiveCardContext, type InteractiveCardHostContextValue } from "./context";
import { resetInteractiveCardsStore } from "./store";

const { mockRouterPush, mockNavigateToAgent, mockOpenExternalUrl, mockIsCompactLayout } =
  vi.hoisted(() => ({
    mockRouterPush: vi.fn(),
    mockNavigateToAgent: vi.fn(),
    mockOpenExternalUrl: vi.fn(),
    mockIsCompactLayout: vi.fn(() => false),
  }));

vi.mock("expo-router", () => ({
  router: {
    push: mockRouterPush,
    replace: vi.fn(),
    navigate: vi.fn(),
  },
  usePathname: () => "/main",
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: mockNavigateToAgent,
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: mockOpenExternalUrl,
}));

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => mockIsCompactLayout(),
  };
});

vi.mock("react-native-unistyles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native-unistyles")>();
  return {
    ...actual,
    useUnistyles: () => ({
      ...actual.useUnistyles(),
      rt: { breakpoint: mockIsCompactLayout() ? "xs" : "xl" },
    }),
  };
});

const toastShow = vi.fn(() => () => {});
const toastError = vi.fn();
const TEST_TOAST_API: ToastApi = {
  show: toastShow,
  copied: vi.fn(),
  error: toastError,
};

const TEST_SHELL_VALUE = {
  inMainChatShell: true,
  originRoute: "/main",
  originTitle: "管家",
};

function seedStores() {
  useSessionStore.setState({
    sessions: {
      srv_1: {
        hasHydratedAgents: true,
        serverInfo: { hostname: "DevBox-01" },
        agents: new Map([
          [
            "ag_12345678_alpha",
            {
              id: "ag_12345678_alpha",
              workspaceId: "ws_1",
              title: "Refactor Auth Flow",
              status: "running",
              cwd: "/repo/paseo-fork",
            },
          ],
          [
            "ag_ambig999_one",
            {
              id: "ag_ambig999_one",
              workspaceId: "ws_1",
              title: "Ambiguous One",
              status: "idle",
              cwd: "/repo/paseo-fork",
            },
          ],
          [
            "ag_ambig999_two",
            {
              id: "ag_ambig999_two",
              workspaceId: "ws_1",
              title: "Ambiguous Two",
              status: "idle",
              cwd: "/repo/paseo-fork",
            },
          ],
        ]),
        agentDetails: new Map(),
        workspaces: new Map([
          [
            "ws_1",
            {
              id: "ws_1",
              projectDisplayName: "paseo-fork",
              workspaceDirectory: "/repo/paseo-fork",
            },
          ],
        ]),
      },
      srv_2: {
        hasHydratedAgents: true,
        serverInfo: { hostname: "MacBook" },
        agents: new Map([
          [
            "ag_remote88_beta",
            {
              id: "ag_remote88_beta",
              workspaceId: "ws_2",
              title: "Remote Worker",
              status: "idle",
              cwd: "/repo/mobile",
            },
          ],
        ]),
        agentDetails: new Map(),
        workspaces: new Map([
          [
            "ws_2",
            {
              id: "ws_2",
              projectDisplayName: "mobile",
              workspaceDirectory: "/repo/mobile",
            },
          ],
        ]),
      },
    } as unknown as ReturnType<typeof useSessionStore.getState>["sessions"],
  });

  const overview: MainChatOverview = {
    plans: [],
    tasks: [
      {
        id: "task_abcdef12_main",
        serverId: "srv_1",
        activeAgentId: "ag_12345678_alpha",
        agentIds: ["ag_12345678_alpha"],
        workspaceId: "ws_1",
        title: "Auth Task",
        status: "in_progress",
        cwd: "/repo/paseo-fork",
      },
      {
        id: "task_unstarted_99",
        serverId: "srv_1",
        activeAgentId: null,
        agentIds: [],
        workspaceId: "ws_1",
        title: "Pending Task",
        status: "queued",
        cwd: "/repo/paseo-fork",
      },
    ],
    decisions: [],
    triages: [],
    receipts: [],
    reworks: [],
    nextStepSuggestions: [],
    settings: {
      title: "管家",
      style: "conservative",
      capabilities: {
        autoContinueManualErrors: true,
        autoDelegateManualQuestions: false,
        autoNudgeManualStalled: false,
      },
      stylePresets: [],
      activeStylePresetId: "builtin_conservative",
    },
    patrol: {
      enabled: true,
      intervalMs: 60_000,
      lastRunAt: null,
      lastSignalCount: 0,
    },
    compaction: null,
  } as unknown as MainChatOverview;

  useMainChatOverviewStore.setState({
    overviewsByKey: {
      [overviewStoreKey("srv_1", "agent_main")]: overview,
    },
  });
}

function TestCardHarness({
  host,
  children,
}: {
  host: InteractiveCardHostContextValue;
  children: ReactNode;
}) {
  return (
    <ToastApiProvider api={TEST_TOAST_API}>
      <MainChatShellProvider value={TEST_SHELL_VALUE}>
        <InteractiveCardContext.Provider value={host}>{children}</InteractiveCardContext.Provider>
      </MainChatShellProvider>
    </ToastApiProvider>
  );
}

function createHostValue(
  hostOverrides?: Partial<InteractiveCardHostContextValue>,
): InteractiveCardHostContextValue {
  return {
    serverId: "srv_1",
    agentId: "agent_main",
    client: null,
    interactive: false,
    ...hostOverrides,
  };
}

function renderCard(
  view: InteractiveCardView,
  hostOverrides?: Partial<InteractiveCardHostContextValue>,
) {
  const hostValue = createHostValue(hostOverrides);
  return render(
    <TestCardHarness host={hostValue}>
      <InteractiveCardShell
        cardKey="inline:0123456789abcdef/0"
        view={view}
        version={1}
        live={false}
      />
    </TestCardHarness>,
  );
}

describe("InteractiveCardShell session & external URL routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsCompactLayout.mockReturnValue(false);
    resetInteractiveCardsStore();
    useMainChatDrawerStore.getState().closeDrawer();
    useMainChatCameFromStore.getState().clearCameFrom();
    seedStores();
  });

  afterEach(() => {
    cleanup();
    useMainChatDrawerStore.getState().closeDrawer();
    useMainChatCameFromStore.getState().clearCameFrom();
  });

  it("opens right-hand drawer on wide screens for paseo://agent/... (exact + 8-char prefix) and paseo://task/...", () => {
    const view: InteractiveCardView = {
      title: "Session Links",
      fallback: "Session links fallback",
      sections: [
        {
          items: [
            {
              type: "link",
              label: "Agent Short Prefix",
              url: "paseo://agent/srv_1/ag_12345",
            },
            {
              type: "link",
              label: "Cross Host Agent",
              url: "paseo://agent/ag_remote88",
            },
            {
              type: "button",
              label: "Open Task Short",
              action: { kind: "open", id: "open-task-short", url: "paseo://task/task_abc" },
            },
          ],
        },
      ],
    };

    const { getByText, getByTestId } = renderCard(view);

    act(() => {
      fireEvent.click(getByText("Agent Short Prefix"));
    });
    expect(useMainChatDrawerStore.getState().activeTarget).toMatchObject({
      serverId: "srv_1",
      agentId: "ag_12345678_alpha",
      workspaceId: "ws_1",
    });
    expect(mockNavigateToAgent).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();

    act(() => {
      fireEvent.click(getByText("Cross Host Agent"));
    });
    expect(useMainChatDrawerStore.getState().activeTarget).toMatchObject({
      serverId: "srv_2",
      agentId: "ag_remote88_beta",
      workspaceId: "ws_2",
    });

    act(() => {
      useMainChatDrawerStore.getState().closeDrawer();
    });

    act(() => {
      fireEvent.click(getByTestId("interactive-card-button-open-task-short"));
    });
    expect(useMainChatDrawerStore.getState().activeTarget).toMatchObject({
      serverId: "srv_1",
      agentId: "ag_12345678_alpha",
      taskId: "task_abcdef12_main",
    });
    expect(mockNavigateToAgent).not.toHaveBeenCalled();
  });

  it("navigates full-page and records CameFrom on compact screens for paseo://agent/... and paseo://task/...", () => {
    mockIsCompactLayout.mockReturnValue(true);

    const view: InteractiveCardView = {
      title: "Compact Links",
      fallback: "Compact fallback",
      sections: [
        {
          items: [
            {
              type: "row",
              title: "Open Agent Compact",
              action: {
                kind: "open",
                id: "open-agent-compact",
                url: "paseo://agent/srv_1/ag_12345678",
              },
            },
            {
              type: "link",
              label: "Open Task Compact",
              url: "paseo://task/task_abcdef12_main",
            },
          ],
        },
      ],
    };

    const { getByTestId, getByText } = renderCard(view);

    act(() => {
      fireEvent.click(getByTestId("interactive-card-row-open-agent-compact"));
    });
    expect(mockNavigateToAgent).toHaveBeenCalledWith({
      serverId: "srv_1",
      agentId: "ag_12345678_alpha",
      workspaceId: "ws_1",
    });
    expect(useMainChatCameFromStore.getState().entry).toMatchObject({
      originRoute: "/main",
      targetServerId: "srv_1",
      targetAgentId: "ag_12345678_alpha",
    });
    expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();

    vi.clearAllMocks();
    useMainChatCameFromStore.getState().clearCameFrom();

    act(() => {
      fireEvent.click(getByText("Open Task Compact"));
    });
    expect(mockNavigateToAgent).toHaveBeenCalledWith({
      serverId: "srv_1",
      agentId: "ag_12345678_alpha",
      workspaceId: "ws_1",
    });
    expect(useMainChatCameFromStore.getState().entry?.targetAgentId).toBe("ag_12345678_alpha");
  });

  it("shows non-blocking toast on not_found, ambiguous prefix, and unstarted task without navigating", () => {
    const view: InteractiveCardView = {
      title: "Edge Cases",
      fallback: "Edge cases fallback",
      sections: [
        {
          items: [
            { type: "link", label: "Missing Agent", url: "paseo://agent/srv_1/ag_missing_999" },
            { type: "link", label: "Ambiguous Agent", url: "paseo://agent/srv_1/ag_ambig999" },
            { type: "link", label: "Unstarted Task", url: "paseo://task/task_unstarted_99" },
          ],
        },
      ],
    };

    const { getByText } = renderCard(view);

    act(() => {
      fireEvent.click(getByText("Missing Agent"));
    });
    expect(toastError).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(getByText("Ambiguous Agent"));
    });
    expect(toastShow).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(getByText("Unstarted Task"));
    });
    expect(toastShow).toHaveBeenCalledTimes(2);

    expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();
    expect(mockNavigateToAgent).not.toHaveBeenCalled();
    expect(mockRouterPush).not.toHaveBeenCalled();
  });

  it("preserves paseo://file/..., paseo://workspace/..., and https://... link behaviors", () => {
    const onOpenFilePath = vi.fn();
    const view: InteractiveCardView = {
      title: "Preserved Links",
      fallback: "Preserved links fallback",
      sections: [
        {
          items: [
            { type: "link", label: "Open File", url: "paseo://file/src/main-chat/session-link.ts" },
            { type: "link", label: "Open Workspace", url: "paseo://workspace/ws_42" },
            { type: "link", label: "External Docs", url: "https://example.com/docs" },
          ],
        },
      ],
    };

    const { getByText } = renderCard(view, { onOpenFilePath });

    act(() => {
      fireEvent.click(getByText("Open File"));
    });
    expect(onOpenFilePath).toHaveBeenCalledWith("src/main-chat/session-link.ts");

    act(() => {
      fireEvent.click(getByText("Open Workspace"));
    });
    expect(mockRouterPush).toHaveBeenCalledWith(buildHostWorkspaceRoute("srv_1", "ws_42"));

    act(() => {
      fireEvent.click(getByText("External Docs"));
    });
    expect(mockOpenExternalUrl).toHaveBeenCalledWith("https://example.com/docs");
    expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();
  });
});
