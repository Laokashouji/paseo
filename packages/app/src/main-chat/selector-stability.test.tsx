// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
} from "@getpaseo/protocol/main-chat";
import { act, cleanup, render } from "@testing-library/react";
import React, { type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommandCenterProvider, useCommandCenterContributions } from "@/command-center/provider";
import type { CommandCenterContribution } from "@/command-center/contributions";
import { CommandCenterRootActions } from "@/command-center/root-registration";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatSettingsSection } from "@/screens/settings/main-chat/main-chat-section";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import { useMainChatSettingsStore } from "./settings-store";

const mockHosts = [
  { serverId: "srv_1", label: "DevBox" },
  { serverId: "srv_2", label: "Legacy Host" },
];

const mockActiveWorkspace = {
  serverId: "srv_1",
  workspaceId: "ws_other",
};

const mockProviderSnapshotResult = {
  entries: [],
  isLoading: false,
  isFetching: false,
  isRefreshing: false,
  error: null,
  supportsSnapshot: true,
  refresh: vi.fn(async () => undefined),
  refetchIfStale: vi.fn(),
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "zh-CN" },
  }),
}));

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => false,
  };
});

vi.mock("lucide-react-native", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const StubIcon = () => null;
  const fallbackIcons: Record<string, unknown> = { ...actual };
  const requiredNames = [
    "Activity",
    "CalendarClock",
    "ChevronDown",
    "ChevronUp",
    "CircleDashed",
    "Copy",
    "Ellipsis",
    "Folder",
    "FolderPlus",
    "History",
    "Home",
    "Import",
    "Keyboard",
    "Moon",
    "PanelLeft",
    "Pencil",
    "Plus",
    "Power",
    "Radar",
    "RefreshCw",
    "RotateCcw",
    "Save",
    "Settings",
    "Shield",
    "SlidersHorizontal",
    "Sparkles",
    "Trash2",
    "Zap",
  ];
  for (const name of requiredNames) {
    fallbackIcons[name] = actual[name] ?? StubIcon;
  }
  return fallbackIcons;
});

vi.mock("@/hooks/use-keyboard-shortcut-overrides", () => ({
  useKeyboardShortcutOverrides: () => ({
    overrides: {},
    isLoading: false,
    setOverride: vi.fn(async () => undefined),
    clearOverride: vi.fn(async () => undefined),
    removeOverride: vi.fn(async () => undefined),
    resetAll: vi.fn(async () => undefined),
    hasOverrides: false,
  }),
}));

vi.mock("@/keyboard", () => ({
  usesDesktopBindings: true,
  useHardwareKeyboardPresent: () => true,
  useOverlayRegistration: () => () => undefined,
}));

vi.mock("@/hooks/use-open-add-project", () => ({
  useOpenAddProject: () => vi.fn(),
}));

vi.mock("@/hooks/use-import-session", () => ({
  useImportSession: () => ({ open: vi.fn(), sheet: null }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHosts,
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => mockActiveWorkspace,
  navigateToWorkspace: vi.fn(),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => mockProviderSnapshotResult,
}));

const noopToastApi: ComponentProps<typeof ToastApiProvider>["api"] = {
  show: () => () => undefined,
  error: () => () => undefined,
  copied: () => () => undefined,
};

function makeAgent(partial: Partial<Agent> & { id: string; serverId: string }): Agent {
  return {
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-23T06:00:00.000Z"),
    updatedAt: new Date("2026-11-23T06:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-23T06:00:00.000Z"),
    capabilities: {} as Agent["capabilities"],
    currentModeId: "default",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: partial.id,
    cwd: "/tmp/repo",
    workspaceId: "ws_1",
    model: "claude-sonnet-5-5",
    parentAgentId: null,
    labels: {},
    ...partial,
  };
}

function makeFakeClient(settings = createDefaultMainChatSettings("conservative")): DaemonClient {
  return {
    getMainChatSettings: vi.fn(async () => ({ settings, error: null })),
    updateMainChatSettings: vi.fn(async () => ({ settings, error: null })),
    triggerMainChatPatrol: vi.fn(async () => ({ ok: true, error: null })),
    ensureMainChat: vi.fn(async () => ({
      agentId: "agent_main",
      workspaceId: "ws_main",
      error: null,
    })),
  } as unknown as DaemonClient;
}

function seedSessionStore(fakeClient: DaemonClient) {
  useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  useSessionStore.getState().initializeSession("srv_1", fakeClient, 1);
  useSessionStore.getState().initializeSession("srv_2", fakeClient, 1);

  const mainAgent = makeAgent({
    id: "agent_main",
    serverId: "srv_1",
    workspaceId: "ws_main",
    title: "对话管理",
    labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
  });
  const workerAgent = makeAgent({
    id: "agent_worker",
    serverId: "srv_1",
    workspaceId: "ws_repo",
    title: "Worker",
    status: "running",
  });

  useSessionStore.setState((prev) => {
    const s1 = prev.sessions.srv_1 as SessionState;
    const s2 = prev.sessions.srv_2 as SessionState;
    return {
      ...prev,
      sessions: {
        ...prev.sessions,
        srv_1: {
          ...s1,
          serverInfo: {
            serverId: "srv_1",
            hostname: "devbox-host",
            features: { mainChat: true },
          } as SessionState["serverInfo"],
          agents: new Map([
            [mainAgent.id, mainAgent],
            [workerAgent.id, workerAgent],
          ]),
        },
        srv_2: {
          ...s2,
          serverInfo: {
            serverId: "srv_2",
            hostname: "legacy-host",
            features: { mainChat: false },
          } as SessionState["serverInfo"],
          agents: new Map(),
        },
      },
    };
  });
}

function getActionTitle(contribution: CommandCenterContribution | undefined): string | undefined {
  return contribution?.presentation.kind === "action" ? contribution.presentation.title : undefined;
}

function hasSnapshotLoopError(calls: readonly unknown[][]): boolean {
  return calls
    .map((args) => args.map(String).join(" "))
    .some(
      (msg) =>
        msg.includes("getSnapshot") || msg.includes("Maximum update depth") || msg.includes("#185"),
    );
}

function pushUnrelatedAgents(prefix: string, status: Agent["status"], count: number): void {
  for (let i = 0; i < count; i += 1) {
    useSessionStore.setState((prev) => {
      const s1 = prev.sessions.srv_1 as SessionState;
      const nextAgents = new Map(s1.agents);
      nextAgents.set(
        `${prefix}_${i}`,
        makeAgent({
          id: `${prefix}_${i}`,
          serverId: "srv_1",
          workspaceId: "ws_repo",
          status,
        }),
      );
      return {
        ...prev,
        sessions: {
          ...prev.sessions,
          srv_1: { ...s1, agents: nextAgents },
        },
      };
    });
  }
}

describe("Main Chat React rendering selector stability regressions (React #185)", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
  });

  afterEach(() => {
    cleanup();
    useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("renders CommandCenterRootActions without React #185 infinite loops across unrelated store updates", () => {
    const fakeClient = makeFakeClient();
    seedSessionStore(fakeClient);

    let capturedContributions: readonly CommandCenterContribution[] = [];
    let renderCount = 0;

    function Observer() {
      capturedContributions = useCommandCenterContributions().contributions;
      return null;
    }

    function TrackedRootActions() {
      renderCount += 1;
      return <CommandCenterRootActions />;
    }

    render(
      <ToastApiProvider api={noopToastApi}>
        <KeyboardActionDispatcherProvider>
          <CommandCenterProvider>
            <TrackedRootActions />
            <Observer />
          </CommandCenterProvider>
        </KeyboardActionDispatcherProvider>
      </ToastApiProvider>,
    );

    const openMainChat = capturedContributions.find((item) => item.id === "root:open-main-chat");
    expect(openMainChat).toBeDefined();
    expect(getActionTitle(openMainChat)).toBe("对话管理");
    const rendersAfterMount = renderCount;
    expect(rendersAfterMount).toBeLessThan(10);

    // Unrelated fleet activity updates must not trigger infinite re-render or getSnapshot errors.
    act(() => {
      pushUnrelatedAgents("agent_unrelated", "running", 5);
    });

    expect(renderCount).toBe(rendersAfterMount);

    // Updating the configured main-chat title should cleanly update the action title.
    act(() => {
      useMainChatSettingsStore.setState({
        settingsByServerId: {
          srv_1: {
            ...createDefaultMainChatSettings("conservative"),
            title: "我的管家",
          },
        },
      });
    });

    const updatedAction = capturedContributions.find((item) => item.id === "root:open-main-chat");
    expect(getActionTitle(updatedAction)).toBe("我的管家");

    expect(hasSnapshotLoopError(consoleErrorSpy.mock.calls)).toBe(false);
  });

  it("renders MainChatSettingsSection without React #185 infinite loops across unrelated store updates", async () => {
    const defaultSettings = createDefaultMainChatSettings("conservative");
    const fakeClient = makeFakeClient(defaultSettings);
    seedSessionStore(fakeClient);
    useMainChatSettingsStore.setState({
      settingsByServerId: { srv_1: defaultSettings },
      loadingByServerId: { srv_1: false },
    });

    let renderCount = 0;
    function TrackedSettingsSection() {
      renderCount += 1;
      return <MainChatSettingsSection />;
    }

    const view = render(
      <ToastApiProvider api={noopToastApi}>
        <TrackedSettingsSection />
      </ToastApiProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain("mainChat.settings.identity.title");
    expect(view.container.textContent).toContain("mainChat.settings.backgroundModel.title");
    const rendersAfterMount = renderCount;
    expect(rendersAfterMount).toBeLessThan(10);

    // Unrelated session store updates must not re-render or crash MainChatSettingsSection.
    act(() => {
      pushUnrelatedAgents("agent_bg", "idle", 5);
    });

    expect(renderCount).toBe(rendersAfterMount);

    expect(hasSnapshotLoopError(consoleErrorSpy.mock.calls)).toBe(false);
  });
});
