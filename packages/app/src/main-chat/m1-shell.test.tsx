// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_DEFAULT_TITLE,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
} from "@getpaseo/protocol/main-chat";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import React, { type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { resolveKeyboardShortcut } from "@/keyboard/keyboard-shortcuts";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import {
  useSessionStore,
  type Agent,
  type ProjectDescriptor,
  type SessionState,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import { selectWorkspaceStructureProjects } from "@/stores/session-store-hooks/selectors";
import {
  buildMainChatConversationRoute,
  buildMainChatHistoryRoute,
  buildMainChatRoute,
  isMainChatPathname,
  parseMainChatConversationIdFromPathname,
} from "@/utils/host-routes";
import { MainChatCameFromBar } from "./came-from-bar";
import { matchesCameFromTarget, useMainChatCameFromStore } from "./came-from-store";
import { useMainChatDrawerStore } from "./drawer-store";
import { MainChatHeroRow } from "./hero-row";
import { openMainChatTaskTarget } from "./open-task-target";
import { useMainChatSettingsStore } from "./settings-store";
import {
  SidebarDirectionsSection,
  useMainChatDirectionsSectionStore,
} from "./sidebar-directions-section";

const mockRouterPush = vi.hoisted(() => vi.fn());
const mockPathname = vi.hoisted(() => ({ value: "/h/srv_1/workspace/ws_repo" }));
const mockNavigateToWorkspace = vi.hoisted(() => vi.fn());
const mockNavigateToAgent = vi.hoisted(() => vi.fn());
const mockActiveWorkspace = vi.hoisted<{ value: { serverId: string; workspaceId: string } | null }>(
  () => ({
    value: { serverId: "srv_1", workspaceId: "ws_repo" },
  }),
);

vi.mock("expo-router", () => ({
  router: {
    push: mockRouterPush,
    replace: vi.fn(),
    navigate: vi.fn(),
  },
  usePathname: () => mockPathname.value,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
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

vi.mock("@/keyboard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/keyboard")>();
  return {
    ...actual,
    usesDesktopBindings: true,
    useHardwareKeyboardPresent: () => true,
  };
});

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: (actionId: string) => (actionId === "open-main-chat" ? [["mod", "0"]] : null),
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => mockActiveWorkspace.value,
  useLastWorkspaceSelection: () => mockActiveWorkspace.value,
  navigateToWorkspace: mockNavigateToWorkspace,
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: mockNavigateToAgent,
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

vi.mock("lucide-react-native", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const StubIcon = () => null;
  return {
    ...actual,
    ArrowLeft: actual.ArrowLeft ?? StubIcon,
    ChevronDown: actual.ChevronDown ?? StubIcon,
    ChevronRight: actual.ChevronRight ?? StubIcon,
    Compass: actual.Compass ?? StubIcon,
    Ellipsis: actual.Ellipsis ?? StubIcon,
    History: actual.History ?? StubIcon,
    Pencil: actual.Pencil ?? StubIcon,
    Plus: actual.Plus ?? StubIcon,
    Radar: actual.Radar ?? StubIcon,
    Settings: actual.Settings ?? StubIcon,
    Shield: actual.Shield ?? StubIcon,
    Sparkles: actual.Sparkles ?? StubIcon,
    X: actual.X ?? StubIcon,
    Zap: actual.Zap ?? StubIcon,
  };
});

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
    workspaceId: "ws_repo",
    model: "claude-sonnet-5-5",
    parentAgentId: null,
    labels: {},
    ...partial,
  };
}

function makeFakeClient(): DaemonClient {
  const defaults = createDefaultMainChatSettings("conservative");
  return {
    getMainChatSettings: vi.fn(async () => ({ settings: defaults })),
    updateMainChatSettings: vi.fn(async (patch) => ({ settings: { ...defaults, ...patch } })),
    triggerMainChatPatrol: vi.fn(async () => ({
      result: {
        scannedSessions: 2,
        signalsFound: 0,
        wokeMainChat: false,
        summary: "ok",
        patrolledAt: "2026-11-23T08:00:00.000Z",
      },
    })),
    ensureMainChat: vi.fn(async () => ({
      agentId: "agent_main",
      workspaceId: "ws_main",
      created: false,
    })),
  } as unknown as DaemonClient;
}

function seedSessionStore(options?: {
  supportsMainChat?: boolean;
  needsYou?: boolean;
  runningChild?: boolean;
}) {
  const supportsMainChat = options?.supportsMainChat ?? true;
  const agents = new Map<string, Agent>();

  if (supportsMainChat) {
    agents.set(
      "agent_main",
      makeAgent({
        id: "agent_main",
        serverId: "srv_1",
        workspaceId: "ws_main",
        cwd: "/home/user/.paseo/main-chat",
        title: MAIN_CHAT_DEFAULT_TITLE,
        labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      }),
    );
  }

  if (options?.runningChild) {
    agents.set(
      "child_run",
      makeAgent({
        id: "child_run",
        serverId: "srv_1",
        workspaceId: "ws_repo",
        title: "重构侧栏",
        status: "running",
        turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
      }),
    );
  }

  if (options?.needsYou) {
    agents.set(
      "child_perm",
      makeAgent({
        id: "child_perm",
        serverId: "srv_1",
        workspaceId: "ws_repo",
        title: "审批发布",
        attentionReason: "permission",
        pendingPermissions: [
          {
            key: "perm_1",
            agentId: "child_perm",
            requestId: "req_1",
            name: "bash",
            title: "Run deploy",
            kind: "execute",
          },
        ] as unknown as Agent["pendingPermissions"],
      }),
    );
  }

  const session: SessionState = {
    client: makeFakeClient(),
    serverInfo: {
      serverId: "srv_1",
      hostname: "devbox",
      version: "0.17.0",
      capabilities: {},
      features: { mainChat: supportsMainChat },
    },
    agents,
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
  } as unknown as SessionState;

  useSessionStore.setState({
    sessions: { srv_1: session },
    agentLastActivity: new Map(),
  });
}

describe("Main Chat M1 — routes, stores, hero row, directions section, came-from, and Pinned stripping", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    if (typeof HTMLElement !== "undefined" && typeof HTMLElement.prototype.animate !== "function") {
      HTMLElement.prototype.animate = vi.fn(
        () => ({ cancel: vi.fn(), startTime: 0 }) as unknown as Animation,
      );
    }
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockRouterPush.mockReset();
    mockNavigateToWorkspace.mockReset();
    mockNavigateToAgent.mockReset();
    mockPathname.value = "/h/srv_1/workspace/ws_repo";
    mockActiveWorkspace.value = { serverId: "srv_1", workspaceId: "ws_repo" };
    useMainChatDrawerStore.getState().reset();
    useMainChatCameFromStore.getState().clearCameFrom();
    useMainChatDirectionsSectionStore.getState().setCollapsed(false);
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
    useDraftStore.setState({ drafts: {}, createModalDraft: null });
  });

  afterEach(() => {
    cleanup();
    useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
    useMainChatDrawerStore.getState().reset();
    useMainChatCameFromStore.getState().clearCameFrom();
    useDraftStore.setState({ drafts: {}, createModalDraft: null });
    consoleErrorSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("builds and recognizes /main route helpers and matches Cmd+0 / Ctrl+0 / Alt+0 shortcuts", () => {
    expect(buildMainChatRoute()).toBe("/main");
    expect(buildMainChatHistoryRoute()).toBe("/main/history");
    expect(buildMainChatConversationRoute("dir_auth")).toBe("/main/c/dir_auth");
    expect(isMainChatPathname("/main")).toBe(true);
    expect(isMainChatPathname("/main/c/dir_auth")).toBe(true);
    expect(isMainChatPathname("/main/history")).toBe(true);
    expect(isMainChatPathname("/h/srv_1/workspace/ws_1")).toBe(false);
    expect(parseMainChatConversationIdFromPathname("/main/c/dir_auth")).toBe("dir_auth");

    const macMatch = resolveKeyboardShortcut({
      event: {
        key: "0",
        code: "Digit0",
        metaKey: true,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        repeat: false,
      },
      context: {
        isMac: true,
        usesDesktopBindings: true,
        focusScope: "other",
        commandCenterOpen: false,
      },
      chordState: { candidateIndices: [], step: 0, timeoutId: null },
      onChordReset: () => undefined,
    });
    expect(macMatch.match?.action).toBe("main-chat.open");

    const webMatch = resolveKeyboardShortcut({
      event: {
        key: "0",
        code: "Digit0",
        metaKey: false,
        ctrlKey: false,
        altKey: true,
        shiftKey: false,
        repeat: false,
      },
      context: {
        isMac: true,
        usesDesktopBindings: false,
        focusScope: "other",
        commandCenterOpen: false,
      },
      chordState: { candidateIndices: [], step: 0, timeoutId: null },
      onChordReset: () => undefined,
    });
    expect(webMatch.match?.action).toBe("main-chat.open");
  });

  it("manages TaskPanelDrawer store open, close, toggle, and last-target restoration", () => {
    const store = useMainChatDrawerStore.getState();
    expect(store.activeTarget).toBeNull();
    expect(store.lastTarget).toBeNull();

    store.openTask({
      serverId: "srv_1",
      agentId: "child_1",
      workspaceId: "ws_repo",
      title: "修复导航",
    });
    expect(useMainChatDrawerStore.getState().activeTarget).toEqual({
      serverId: "srv_1",
      agentId: "child_1",
      workspaceId: "ws_repo",
      title: "修复导航",
    });

    store.closeDrawer();
    expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();
    expect(useMainChatDrawerStore.getState().lastTarget?.agentId).toBe("child_1");

    // Toggling while closed reopens the last inspected target.
    store.toggleDrawer();
    expect(useMainChatDrawerStore.getState().activeTarget?.agentId).toBe("child_1");

    // Toggling while open closes again.
    store.toggleDrawer();
    expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();

    // After reset, toggleDrawer falls back to the supplied fallback target.
    store.reset();
    store.toggleDrawer({ serverId: "srv_1", agentId: "child_2", title: "备用任务" });
    expect(useMainChatDrawerStore.getState().activeTarget?.agentId).toBe("child_2");
  });

  it("manages Came From store matching and clear lifecycle", () => {
    const store = useMainChatCameFromStore.getState();
    store.setCameFrom({
      originRoute: "/main",
      originTitle: "主对话",
      targetServerId: "srv_1",
      targetWorkspaceId: "ws_repo",
      targetAgentId: "child_1",
      createdAtMs: 1234,
    });

    const entry = useMainChatCameFromStore.getState().entry;
    expect(entry?.originRoute).toBe("/main");
    expect(matchesCameFromTarget(entry, { serverId: "srv_1", workspaceId: "ws_repo" })).toBe(true);
    expect(matchesCameFromTarget(entry, { serverId: "srv_1", workspaceId: "ws_other" })).toBe(
      false,
    );
    expect(matchesCameFromTarget(entry, { serverId: "srv_2", workspaceId: "ws_repo" })).toBe(false);
    expect(matchesCameFromTarget(entry, { serverId: "srv_1", agentId: "child_1" })).toBe(true);

    store.clearCameFrom();
    expect(useMainChatCameFromStore.getState().entry).toBeNull();
  });

  it("routes openMainChatTaskTarget to right drawer on desktop and full-page + Came From on compact or forceFullPage", () => {
    seedSessionStore({ supportsMainChat: true, runningChild: true });

    const desktopMode = openMainChatTaskTarget({
      serverId: "srv_1",
      agentId: "child_run",
      isCompact: false,
      inMainChatRoute: true,
      originRoute: "/main",
      originTitle: "对话管理",
    });
    expect(desktopMode).toBe("drawer");
    expect(useMainChatDrawerStore.getState().activeTarget).toEqual({
      serverId: "srv_1",
      agentId: "child_run",
      workspaceId: "ws_repo",
      title: "重构侧栏",
    });
    expect(mockNavigateToAgent).not.toHaveBeenCalled();
    expect(useMainChatCameFromStore.getState().entry).toBeNull();

    // Promoting from drawer to full page closes drawer, writes Came From, and navigates.
    const promotedMode = openMainChatTaskTarget({
      serverId: "srv_1",
      agentId: "child_run",
      isCompact: false,
      forceFullPage: true,
      inMainChatRoute: true,
      originRoute: "/main",
      originTitle: "对话管理",
    });
    expect(promotedMode).toBe("full-page");
    expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();
    expect(useMainChatCameFromStore.getState().entry?.originRoute).toBe("/main");
    expect(useMainChatCameFromStore.getState().entry?.targetWorkspaceId).toBe("ws_repo");
    expect(mockNavigateToAgent).toHaveBeenCalledWith({
      serverId: "srv_1",
      agentId: "child_run",
      workspaceId: "ws_repo",
    });

    // Compact layout skips drawer and jumps straight to full-page + Came From.
    mockNavigateToAgent.mockReset();
    useMainChatCameFromStore.getState().clearCameFrom();
    const compactMode = openMainChatTaskTarget({
      serverId: "srv_1",
      agentId: "child_run",
      isCompact: true,
      inMainChatRoute: true,
      originRoute: "/main/c/dir_1",
      originTitle: "方向 A",
    });
    expect(compactMode).toBe("full-page");
    expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();
    expect(useMainChatCameFromStore.getState().entry?.originRoute).toBe("/main/c/dir_1");
    expect(useMainChatCameFromStore.getState().entry?.originTitle).toBe("方向 A");
    expect(mockNavigateToAgent).toHaveBeenCalledTimes(1);
  });

  it("renders MainChatHeroRow with Needs You badge, unsent draft preview, and navigates to /main (not navigateToWorkspace)", () => {
    seedSessionStore({ supportsMainChat: true, needsYou: true, runningChild: true });
    const draftKey = buildDraftStoreKey({ serverId: "srv_1", agentId: "agent_main" });
    useDraftStore.getState().editDraftText({ draftKey, text: "帮我检查昨天的构建失败原因" });

    const onBeforeNavigate = vi.fn();
    const view = render(
      <ToastApiProvider api={noopToastApi}>
        <KeyboardActionDispatcherProvider>
          <MainChatHeroRow onBeforeNavigate={onBeforeNavigate} />
        </KeyboardActionDispatcherProvider>
      </ToastApiProvider>,
    );

    expect(view.getByTestId("sidebar-main-chat-hero")).toBeTruthy();
    expect(view.getByTestId("sidebar-main-chat-hero-title").textContent).toBe(
      MAIN_CHAT_DEFAULT_TITLE,
    );
    expect(view.getByTestId("sidebar-main-chat-hero-needs-you")).toBeTruthy();
    expect(view.getByTestId("sidebar-main-chat-hero-draft").textContent).toContain(
      "帮我检查昨天的构建失败原因",
    );
    expect(view.getByTestId("sidebar-main-chat-hero-separator")).toBeTruthy();

    fireEvent.click(view.getByTestId("sidebar-main-chat-hero"));
    expect(onBeforeNavigate).toHaveBeenCalledTimes(1);
    expect(mockRouterPush).toHaveBeenCalledWith("/main");
    expect(mockNavigateToWorkspace).not.toHaveBeenCalled();

    // Clearing the draft restores the live status subtitle cleanly.
    act(() => {
      useDraftStore.getState().clearDraftInput({ draftKey, lifecycle: "abandoned" });
    });
    expect(view.getByTestId("sidebar-main-chat-hero-subtitle")).toBeTruthy();
  });

  it("renders SidebarDirectionsSection with collapse summary counts and + entry to /main/history", () => {
    seedSessionStore({ supportsMainChat: true, needsYou: true, runningChild: true });

    const view = render(
      <SidebarDirectionsSection
        directions={[
          {
            conversationId: "dir_release",
            title: "发版方向",
            runningCount: 2,
            needsYouCount: 1,
          },
        ]}
      />,
    );

    expect(view.getByTestId("sidebar-directions-section")).toBeTruthy();
    expect(view.getByTestId("sidebar-direction-row-dir_release")).toBeTruthy();

    fireEvent.click(view.getByTestId("sidebar-direction-row-dir_release"));
    expect(mockRouterPush).toHaveBeenCalledWith("/main/c/dir_release");

    fireEvent.click(view.getByTestId("sidebar-directions-add"));
    expect(mockRouterPush).toHaveBeenCalledWith("/main/history");

    // Collapsing hides the direction list and surfaces running/needs-you summary counts on the header.
    fireEvent.click(view.getByTestId("sidebar-directions-section-header"));
    expect(view.queryByTestId("sidebar-directions-list")).toBeNull();
    expect(view.getByTestId("sidebar-directions-collapsed-summary")).toBeTruthy();
  });

  it("renders MainChatCameFromBar only on matching target workspace and clears on return or dismiss", () => {
    useMainChatCameFromStore.getState().setCameFrom({
      originRoute: "/main",
      originTitle: "主对话",
      targetServerId: "srv_1",
      targetWorkspaceId: "ws_repo",
      targetAgentId: "child_1",
    });

    const otherView = render(<MainChatCameFromBar serverId="srv_1" workspaceId="ws_other" />);
    expect(otherView.queryByTestId("main-chat-came-from-bar")).toBeNull();
    otherView.unmount();

    const targetView = render(<MainChatCameFromBar serverId="srv_1" workspaceId="ws_repo" />);
    expect(targetView.getByTestId("main-chat-came-from-bar")).toBeTruthy();

    fireEvent.click(targetView.getByTestId("main-chat-came-from-return"));
    expect(mockRouterPush).toHaveBeenCalledWith("/main");
    expect(useMainChatCameFromStore.getState().entry).toBeNull();
    expect(targetView.queryByTestId("main-chat-came-from-bar")).toBeNull();

    // Re-seed and verify dismiss clears without navigation.
    mockRouterPush.mockReset();
    act(() => {
      useMainChatCameFromStore.getState().setCameFrom({
        originRoute: "/main",
        originTitle: "主对话",
        targetServerId: "srv_1",
        targetWorkspaceId: "ws_repo",
        targetAgentId: "child_1",
      });
    });
    fireEvent.click(targetView.getByTestId("main-chat-came-from-dismiss"));
    expect(mockRouterPush).not.toHaveBeenCalled();
    expect(useMainChatCameFromStore.getState().entry).toBeNull();
  });

  it("completely strips Main Chat from Pinned and regular Workspaces lists", () => {
    const workspaceListSource = readFileSync(
      path.resolve(__dirname, "../components/sidebar-workspace-list.tsx"),
      "utf8",
    );
    const statusListSource = readFileSync(
      path.resolve(__dirname, "../components/sidebar/sidebar-status-list.tsx"),
      "utf8",
    );
    expect(workspaceListSource).not.toContain("SidebarPinnedMainChatRow");
    expect(workspaceListSource).not.toContain("pinned-row");
    expect(statusListSource).not.toContain("SidebarPinnedMainChatRow");
    expect(statusListSource).not.toContain("pinned-row");

    // Dedicated main-chat pseudo-project & workspace never leak into regular Workspaces even when
    // the project has no hydrated workspaces yet.
    const projects = new Map<string, ProjectDescriptor>([
      [
        "proj_main",
        {
          projectId: "proj_main",
          projectKey: "dir:/home/u/.paseo/main-chat",
          projectKind: "directory",
          projectDisplayName: "main-chat",
          projectCustomName: null,
          projectRootPath: "/home/u/.paseo/main-chat",
        } as unknown as ProjectDescriptor,
      ],
      [
        "proj_repo",
        {
          projectId: "proj_repo",
          projectKey: "git:/home/u/repo",
          projectKind: "git",
          projectDisplayName: "repo",
          projectCustomName: null,
          projectRootPath: "/home/u/repo",
        } as unknown as ProjectDescriptor,
      ],
    ]);
    const workspaces = new Map<string, WorkspaceDescriptor>([
      [
        "ws_repo",
        {
          id: "ws_repo",
          projectId: "proj_repo",
          projectDisplayName: "repo",
          projectRootPath: "/home/u/repo",
          workspaceDirectory: "/home/u/repo",
          projectKind: "git",
          workspaceKind: "local_checkout",
          name: "main",
          status: "done",
          statusEnteredAt: null,
          createdAt: null,
          lastUserMessageAt: null,
          archivingAt: null,
          diffStat: null,
          scripts: [],
        } as WorkspaceDescriptor,
      ],
    ]);

    const structure = selectWorkspaceStructureProjects(
      {
        sessions: {
          srv_1: {
            projects,
            workspaces,
            agents: new Map(),
          },
        },
      },
      ["srv_1"],
    );
    expect(structure.map((project) => project.projectName)).toEqual(["repo"]);
  });
});
