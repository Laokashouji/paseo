// @vitest-environment jsdom
import type { MainChatOverview } from "@getpaseo/protocol/main-chat";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import { ToastApiProvider } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { useMainChatCameFromStore } from "./came-from-store";
import { useMainChatDrawerStore } from "./drawer-store";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { MainChatShellProvider } from "./shell-context";
import {
  buildMainChatSessionWebHref,
  collectSessionLinkResolutionContext,
  formatSessionLinkTooltip,
  isMainChatSessionLink,
  parseMainChatSessionLink,
  resolveMainChatSessionLink,
  useMainChatSessionLinkOpener,
  type SessionLinkCandidate,
  type SessionLinkTaskCandidate,
} from "./session-link";

const { navigateToAgentMock, useIsCompactLayoutMock } = vi.hoisted(() => ({
  navigateToAgentMock: vi.fn(),
  useIsCompactLayoutMock: vi.fn(() => false),
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: navigateToAgentMock,
}));

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => useIsCompactLayoutMock(),
  };
});

vi.mock("react-native-unistyles", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-native-unistyles")>();
  return {
    ...actual,
    useUnistyles: () => ({
      ...actual.useUnistyles(),
      rt: { breakpoint: useIsCompactLayoutMock() ? "xs" : "xl" },
    }),
  };
});

const TEST_SHELL_VALUE = {
  inMainChatShell: true,
  originRoute: "/main",
  originTitle: "管家",
};
const toastShow = vi.fn(() => () => {});
const toastError = vi.fn();
const TEST_TOAST_API: ToastApi = {
  show: toastShow,
  copied: vi.fn(),
  error: toastError,
};

function makeCandidate(overrides: Partial<SessionLinkCandidate> = {}): SessionLinkCandidate {
  return {
    serverId: "srv_local",
    agentId: "ag_12345678_alpha",
    workspaceId: "ws_repo",
    title: "Refactor Auth Flow",
    taskId: null,
    hostLabel: "DevBox",
    status: "running",
    workspaceLabel: "paseo-fork",
    cwd: "/repo/paseo-fork",
    ...overrides,
  };
}

function makeTaskCandidate(
  overrides: Partial<SessionLinkTaskCandidate> = {},
): SessionLinkTaskCandidate {
  return {
    taskId: "task_abcdef12_main",
    serverId: "srv_local",
    agentId: "ag_12345678_alpha",
    workspaceId: "ws_repo",
    title: "Refactor Auth Flow",
    hostLabel: "DevBox",
    status: "in_progress",
    workspaceLabel: "paseo-fork",
    cwd: "/repo/paseo-fork",
    ...overrides,
  };
}

describe("parseMainChatSessionLink", () => {
  it("parses explicit paseo://agent/<serverId>/<agentId>, paseo://agent/<agentId>, and paseo://task/<taskId>", () => {
    expect(parseMainChatSessionLink("paseo://agent/srv_1/ag_12345678")).toEqual({
      kind: "agent",
      serverId: "srv_1",
      agentId: "ag_12345678",
      rawUrl: "paseo://agent/srv_1/ag_12345678",
    });

    expect(parseMainChatSessionLink("paseo://agent/ag_12345678")).toEqual({
      kind: "agent",
      serverId: null,
      agentId: "ag_12345678",
      rawUrl: "paseo://agent/ag_12345678",
    });

    expect(parseMainChatSessionLink("paseo://task/task_abcdef12")).toEqual({
      kind: "task",
      taskId: "task_abcdef12",
      rawUrl: "paseo://task/task_abcdef12",
    });

    expect(parseMainChatSessionLink("  PASEO://AGENT/srv%20one/ag%2F1/?foo=1#bar  ")).toEqual({
      kind: "agent",
      serverId: "srv one",
      agentId: "ag/1",
      rawUrl: "PASEO://AGENT/srv%20one/ag%2F1/?foo=1#bar",
    });
  });

  it("rejects plain text, book titles, web URLs, and malformed paseo:// URLs", () => {
    expect(parseMainChatSessionLink("《重构主对话》")).toBeNull();
    expect(parseMainChatSessionLink("「发布任务」")).toBeNull();
    expect(parseMainChatSessionLink("https://paseo.sh/agent/srv_1/ag_1")).toBeNull();
    expect(parseMainChatSessionLink("paseo://agent/")).toBeNull();
    expect(parseMainChatSessionLink("paseo://agent/srv_1/ag_1/extra")).toBeNull();
    expect(parseMainChatSessionLink("paseo://task/srv_1/task_1")).toBeNull();
    expect(parseMainChatSessionLink("paseo://unknown/abc")).toBeNull();
    expect(isMainChatSessionLink("paseo://agent/srv_1/ag_1")).toBe(true);
    expect(isMainChatSessionLink("src/index.ts")).toBe(false);
  });
});

describe("resolveMainChatSessionLink (Persona 5-state 8-char prefix matching)", () => {
  const hydratedAll = new Set(["srv_local", "srv_remote"]);
  const knownAll = new Set(["srv_local", "srv_remote"]);

  it("resolves exact matches across explicit host and cross-host agent links", () => {
    const local = makeCandidate();
    const remote = makeCandidate({
      serverId: "srv_remote",
      agentId: "ag_99998888_beta",
      hostLabel: "GPU-Node",
      title: "Train Eval",
    });

    const parsedExplicit = parseMainChatSessionLink("paseo://agent/srv_remote/ag_99998888_beta")!;
    expect(
      resolveMainChatSessionLink(parsedExplicit, {
        candidates: [local, remote],
        hydratedServerIds: hydratedAll,
        knownServerIds: knownAll,
      }),
    ).toEqual({ status: "exact", target: remote });

    const parsedCrossHost = parseMainChatSessionLink("paseo://agent/ag_99998888_beta")!;
    expect(
      resolveMainChatSessionLink(parsedCrossHost, {
        candidates: [local, remote],
        hydratedServerIds: hydratedAll,
        knownServerIds: knownAll,
      }),
    ).toEqual({ status: "exact", target: remote });
  });

  it("resolves unique >=8-char short-ID prefixes and refuses <8-char prefixes", () => {
    const target = makeCandidate({ agentId: "abcdef1234567890" });

    const valid8 = parseMainChatSessionLink("paseo://agent/srv_local/ABCDEF12")!;
    expect(
      resolveMainChatSessionLink(valid8, {
        candidates: [target],
        hydratedServerIds: hydratedAll,
        knownServerIds: knownAll,
      }),
    ).toEqual({ status: "prefix", target });

    const tooShort7 = parseMainChatSessionLink("paseo://agent/srv_local/abcdef1")!;
    expect(
      resolveMainChatSessionLink(tooShort7, {
        candidates: [target],
        hydratedServerIds: hydratedAll,
        knownServerIds: knownAll,
      }),
    ).toEqual({ status: "not_found" });
  });

  it("returns ambiguous when an 8-char prefix matches multiple sessions", () => {
    const first = makeCandidate({ agentId: "shared12_aaa", title: "Session A" });
    const second = makeCandidate({ agentId: "shared12_bbb", title: "Session B" });

    const parsed = parseMainChatSessionLink("paseo://agent/shared12")!;
    const result = resolveMainChatSessionLink(parsed, {
      candidates: [first, second],
      hydratedServerIds: hydratedAll,
      knownServerIds: knownAll,
    });
    expect(result).toEqual({ status: "ambiguous", matches: [first, second] });
  });

  it("returns pending while hosts are still hydrating or when a task has not started an agent yet", () => {
    const parsedAgent = parseMainChatSessionLink("paseo://agent/srv_remote/ag_missing123")!;
    expect(
      resolveMainChatSessionLink(parsedAgent, {
        candidates: [makeCandidate()],
        hydratedServerIds: new Set(["srv_local"]),
        knownServerIds: new Set(["srv_local", "srv_remote"]),
      }),
    ).toEqual({ status: "pending", serverId: "srv_remote", reason: "hydrating" });

    const unstartedTask = makeTaskCandidate({
      taskId: "task_unstarted_99",
      agentId: null,
    });
    const parsedTask = parseMainChatSessionLink("paseo://task/task_unstarted_99")!;
    expect(
      resolveMainChatSessionLink(parsedTask, {
        candidates: [],
        tasks: [unstartedTask],
        hydratedServerIds: hydratedAll,
        knownServerIds: knownAll,
      }),
    ).toEqual({
      status: "pending",
      serverId: "srv_local",
      taskId: "task_unstarted_99",
      reason: "task_unstarted",
    });
  });

  it("resolves paseo://task/<taskId> exact and 8-char prefix to its backing agent", () => {
    const candidate = makeCandidate({ agentId: "ag_task_backed", title: "Live Title" });
    const task = makeTaskCandidate({
      taskId: "task_12345678_full",
      agentId: "ag_task_backed",
    });

    const parsedExact = parseMainChatSessionLink("paseo://task/task_12345678_full")!;
    const exactRes = resolveMainChatSessionLink(parsedExact, {
      candidates: [candidate],
      tasks: [task],
      hydratedServerIds: hydratedAll,
      knownServerIds: knownAll,
    });
    expect(exactRes.status).toBe("exact");
    if (exactRes.status === "exact") {
      expect(exactRes.target.agentId).toBe("ag_task_backed");
      expect(exactRes.target.taskId).toBe("task_12345678_full");
    }

    const parsedPrefix = parseMainChatSessionLink("paseo://task/task_123")!;
    const prefixRes = resolveMainChatSessionLink(parsedPrefix, {
      candidates: [candidate],
      tasks: [task],
      hydratedServerIds: hydratedAll,
      knownServerIds: knownAll,
    });
    expect(prefixRes.status).toBe("prefix");
  });

  it("returns not_found when all hosts are hydrated and no candidate matches", () => {
    const parsed = parseMainChatSessionLink("paseo://agent/srv_local/ag_nonexistent_000")!;
    expect(
      resolveMainChatSessionLink(parsed, {
        candidates: [makeCandidate()],
        hydratedServerIds: hydratedAll,
        knownServerIds: knownAll,
      }),
    ).toEqual({ status: "not_found" });
  });
});

describe("buildMainChatSessionWebHref and formatSessionLinkTooltip", () => {
  it("generates in-app routes and never exposes paseo:// as href", () => {
    const withWorkspace = buildMainChatSessionWebHref(makeCandidate());
    expect(withWorkspace).not.toContain("paseo://");
    expect(withWorkspace).toContain("/h/srv_local/workspace/ws_repo");
    expect(withWorkspace).toContain("ag_12345678_alpha");

    const withoutWorkspace = buildMainChatSessionWebHref(makeCandidate({ workspaceId: null }));
    expect(withoutWorkspace).not.toContain("paseo://");
    expect(withoutWorkspace).toContain("srv_local");
    expect(withoutWorkspace).toContain("ag_12345678_alpha");
  });

  it("formats host · status · workspace tooltip string cleanly", () => {
    const t = (key: string) => {
      if (key === "mainChat.sessionLink.statusRunning") return "Running";
      if (key === "mainChat.sessionLink.notFound") return "Session not found";
      return key;
    };
    const exactTip = formatSessionLinkTooltip({ status: "exact", target: makeCandidate() }, t);
    expect(exactTip).toBe("DevBox · Running · paseo-fork");

    const notFoundTip = formatSessionLinkTooltip({ status: "not_found" }, t);
    expect(notFoundTip).toBe("Session not found");
  });
});

describe("useMainChatSessionLinkOpener", () => {
  function seedStores() {
    useSessionStore.setState({
      sessions: {
        srv_1: {
          serverId: "srv_1",
          hasHydratedAgents: true,
          serverInfo: { hostname: "DevBox" },
          agents: new Map([
            [
              "ag_12345678_worker",
              {
                id: "ag_12345678_worker",
                serverId: "srv_1",
                workspaceId: "ws_1",
                title: "Build Session Links",
                cwd: "/repo/paseo-fork",
                status: "running",
                requiresAttention: false,
                attentionReason: null,
                labels: {},
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
      } as unknown as ReturnType<typeof useSessionStore.getState>["sessions"],
    });
    const emptyOverview: MainChatOverview = {
      plans: [],
      tasks: [],
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
        [overviewStoreKey("srv_1", "agent_main")]: emptyOverview,
      },
    });
  }

  function makeWrapper() {
    return function Wrapper({ children }: { children: ReactNode }) {
      return (
        <ToastApiProvider api={TEST_TOAST_API}>
          <MainChatShellProvider value={TEST_SHELL_VALUE}>{children}</MainChatShellProvider>
        </ToastApiProvider>
      );
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useIsCompactLayoutMock.mockReturnValue(false);
    useMainChatDrawerStore.getState().closeDrawer();
    useMainChatCameFromStore.getState().clearCameFrom();
    seedStores();
  });

  afterEach(() => {
    useMainChatDrawerStore.getState().closeDrawer();
    useMainChatCameFromStore.getState().clearCameFrom();
  });

  it("opens the right-hand TaskPanelDrawer on wide screens without full-page navigation", () => {
    const { result } = renderHook(() => useMainChatSessionLinkOpener("srv_1"), {
      wrapper: makeWrapper(),
    });

    let outcome: ReturnType<typeof result.current> | undefined;
    act(() => {
      outcome = result.current("paseo://agent/srv_1/ag_12345678");
    });

    expect(outcome?.opened).toBe(true);
    if (outcome?.opened) {
      expect(outcome.mode).toBe("drawer");
      expect(outcome.resolution.status).toBe("prefix");
    }
    expect(useMainChatDrawerStore.getState().activeTarget?.agentId).toBe("ag_12345678_worker");
    expect(navigateToAgentMock).not.toHaveBeenCalled();
  });

  it("navigates full-page and records CameFrom on compact screens", () => {
    useIsCompactLayoutMock.mockReturnValue(true);
    const { result } = renderHook(() => useMainChatSessionLinkOpener("srv_1"), {
      wrapper: makeWrapper(),
    });

    let outcome: ReturnType<typeof result.current> | undefined;
    act(() => {
      outcome = result.current("paseo://agent/srv_1/ag_12345678_worker");
    });

    expect(outcome?.opened).toBe(true);
    if (outcome?.opened) {
      expect(outcome.mode).toBe("full-page");
    }
    expect(navigateToAgentMock).toHaveBeenCalledWith({
      serverId: "srv_1",
      agentId: "ag_12345678_worker",
      workspaceId: "ws_1",
    });
    expect(useMainChatCameFromStore.getState().entry?.targetAgentId).toBe("ag_12345678_worker");
  });

  it("shows a non-blocking error toast on not_found without navigating", () => {
    const { result } = renderHook(() => useMainChatSessionLinkOpener("srv_1"), {
      wrapper: makeWrapper(),
    });

    let outcome: ReturnType<typeof result.current> | undefined;
    act(() => {
      outcome = result.current("paseo://agent/srv_1/ag_missing_999999");
    });

    expect(outcome).toEqual({ opened: false, resolution: { status: "not_found" } });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(navigateToAgentMock).not.toHaveBeenCalled();
    expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();
  });

  it("collectSessionLinkResolutionContext maps workspace display name and hostname", () => {
    const ctx = collectSessionLinkResolutionContext({
      sessions: useSessionStore.getState().sessions,
      overviewsByKey: useMainChatOverviewStore.getState().overviewsByKey,
      hosts: [{ serverId: "srv_1", label: "DevBox-01" }],
    });
    expect(ctx.candidates[0]?.hostLabel).toBe("DevBox-01");
    expect(ctx.candidates[0]?.workspaceLabel).toBe("paseo-fork");
  });
});
