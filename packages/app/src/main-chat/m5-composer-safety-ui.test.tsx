// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  type MainChatApprovalClarification,
  type MainChatNextStepSuggestion,
  type MainChatOverview,
  type MainChatRuleSuggestion,
  type MainChatStandingAuthorization,
} from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { TFunction } from "i18next";
import React, { type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ComposerEditingScope,
  ComposerEditingSessionsProvider,
  WorkspaceComposerEditingSessionsProvider,
  useComposerEditingSession,
} from "@/composer/editing-session";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import {
  useSessionStore,
  type Agent,
  type ProjectDescriptor,
  type SessionState,
  type WorkspaceDescriptor,
} from "@/stores/session-store";
import type { PendingPermission } from "@/types/shared";
import {
  ApprovalClarifySection,
  RuleSuggestionBanner,
  findMatchingRuleSuggestion,
} from "./approval-clarify";
import {
  applyMainChatContextMentionSelection,
  buildMainChatContextMentionOptions,
  extractSkillMentionSources,
} from "./autocomplete-tasks";
import { ChildPermissionWrapper } from "./child-permission-wrapper";
import { MainChatComposerEnhancements, useMainChatComposerToolbar } from "./composer-enhancements";
import {
  appendMentionTokenToText,
  buildMainChatMentionItems,
  replaceMentionRangeWithToken,
} from "./mention-sources";
import { MainChatNextStepsBar, resolveMainChatNextStepSuggestions } from "./next-steps-bar";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { MainChatQueuePanel } from "./queue-panel";
import { useMainChatQueueStore } from "./queue-store";
import { StandingAuthModal, StandingAuthPanel } from "./standing-auth-panel";

const mockHosts = vi.hoisted(() => [
  { serverId: "srv_1", label: "DevBox 主机" },
  { serverId: "srv_2", label: "MacBook Pro" },
]);

const stableTranslation = vi.hoisted(() => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
  i18n: { language: "zh-CN" },
}));

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => stableTranslation,
  };
});

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => false,
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHosts,
  useHostRuntimeClient: (serverId: string) =>
    useSessionStore.getState().sessions[serverId]?.client ?? null,
}));

vi.mock("@/agent-commands", () => ({
  useAutocompleteCommands: () => ({
    commands: [
      {
        name: "code-review",
        description: "Review current diff for defects",
        argumentHint: "[target]",
        kind: "skill",
      },
      {
        name: "release-beta",
        description: "Cut a beta release",
        argumentHint: "",
        kind: "skill",
      },
    ],
    isLoading: false,
    isError: false,
    error: null,
    retry: vi.fn(),
  }),
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: vi.fn(),
}));

vi.mock("@/attachments/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/attachments/service")>();
  return {
    ...actual,
    garbageCollectAttachments: vi.fn(async () => undefined),
  };
});

const toastShowSpy = vi.fn(() => () => undefined);
const toastErrorSpy = vi.fn(() => () => undefined);
const toastApi: ComponentProps<typeof ToastApiProvider>["api"] = {
  show: toastShowSpy,
  error: toastErrorSpy,
  copied: () => () => undefined,
};

const fakeT = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key) as unknown as TFunction;

function renderWithToast(node: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  function TestProviders({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <ToastApiProvider api={toastApi}>{children}</ToastApiProvider>
      </QueryClientProvider>
    );
  }
  return render(node, { wrapper: TestProviders });
}

function makeAgent(partial: Partial<Agent> & { id: string; serverId: string }): Agent {
  return {
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: new Date("2026-11-23T08:00:00.000Z"),
    updatedAt: new Date("2026-11-23T08:05:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-11-23T08:05:00.000Z"),
    capabilities: {} as Agent["capabilities"],
    currentModeId: "default",
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: partial.id,
    cwd: "/repo/paseo-fork",
    workspaceId: "ws_repo",
    model: "claude-sonnet-5-5",
    parentAgentId: null,
    labels: {},
    ...partial,
  };
}

function makeOverview(partial: Partial<MainChatOverview> = {}): MainChatOverview {
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
    standingAuthorizations: [],
    ruleSuggestions: [],
    pendingClarifications: [],
    nextStepSuggestions: [],
    ...partial,
  };
}

function seedSession(
  serverId: string,
  agent: Agent,
  client: DaemonClient | null = null,
  extras?: {
    workspaces?: WorkspaceDescriptor[];
    projects?: ProjectDescriptor[];
    hostname?: string;
  },
) {
  useSessionStore.getState().initializeSession(serverId, client, 1);
  useSessionStore.setState((prev) => {
    const existing = prev.sessions[serverId] as SessionState;
    const workspaces = new Map(existing.workspaces);
    for (const ws of extras?.workspaces ?? []) {
      workspaces.set(ws.id, ws);
    }
    const projects = new Map(existing.projects);
    for (const proj of extras?.projects ?? []) {
      projects.set(proj.projectId, proj);
    }
    return {
      ...prev,
      sessions: {
        ...prev.sessions,
        [serverId]: {
          ...existing,
          serverInfo: {
            serverId,
            hostname: extras?.hostname ?? `${serverId}.local`,
            version: "0.17.512",
            features: { mainChat: true },
          },
          agents: new Map([[agent.id, agent]]),
          workspaces,
          projects,
        },
      },
    };
  });
}

const HOST_LABELS_MAP = { srv_1: "DevBox 主机", srv_2: "MacBook Pro" };
const TEST_TAB_IDS = ["tab_1"];

function createClarifyTestFixture() {
  const clarificationResponse: MainChatApprovalClarification = {
    id: "clarify_1",
    agentId: "agent_child",
    serverId: "srv_1",
    permissionRequestId: "perm_1",
    question: "这条命令是否会修改数据库？",
    answer: "仅在本地沙箱运行只读 pytest，不触碰任何外部数据库。",
    proofToken: "proof_abc",
    pausedDeadlineAt: "2026-11-23T12:30:00.000Z",
    answeredAt: "2026-11-23T08:10:00.000Z",
    createdAt: "2026-11-23T08:09:50.000Z",
  };

  const ruleSuggestion: MainChatRuleSuggestion = {
    id: "sugg_1",
    scope: "permission",
    label: "允许执行 pytest 单元测试",
    reason: "连续 3 次手动批准同类只读测试命令",
    serverId: "srv_1",
    cwd: "/repo/paseo-fork",
    toolName: "Bash",
    commandPrefix: "pytest",
    mode: null,
    observedCount: 3,
    dismissedAt: null,
    createdAt: "2026-11-23T08:00:00.000Z",
  };

  const grantedAuth: MainChatStandingAuthorization = {
    id: "auth_new_1",
    scope: "permission",
    serverId: "srv_1",
    cwd: "/repo/paseo-fork",
    allowSubdirectories: true,
    toolName: "Bash",
    commandPrefix: "pytest",
    mode: null,
    label: ruleSuggestion.label,
    reason: ruleSuggestion.reason,
    createdAt: "2026-11-23T08:12:00.000Z",
    lastMatchedAt: null,
    matchCount: 0,
    expiresAt: null,
    revokedAt: null,
  };

  let currentSuggestions: MainChatRuleSuggestion[] = [ruleSuggestion];
  const clarifyMock = vi.fn(async () => ({
    requestId: "req_1",
    clarification: clarificationResponse,
    error: null,
  }));
  const grantMock = vi.fn(async () => {
    currentSuggestions = [];
    return {
      requestId: "req_2",
      authorization: grantedAuth,
      error: null,
    };
  });
  const dismissMock = vi.fn(async () => {
    currentSuggestions = [];
    return {
      requestId: "req_3",
      dismissed: true,
      error: null,
    };
  });
  const getOverviewMock = vi.fn(async () => ({
    requestId: "req_ov",
    overview: makeOverview({
      pendingClarifications: [clarificationResponse],
      ruleSuggestions: currentSuggestions,
    }),
    error: null,
  }));

  const fakeClient = {
    clarifyMainChatPermission: clarifyMock,
    grantMainChatStandingAuthorization: grantMock,
    dismissMainChatRuleSuggestion: dismissMock,
    getMainChatOverview: getOverviewMock,
  } as unknown as DaemonClient;

  const permission: PendingPermission = {
    key: "agent_child:perm_1",
    agentId: "agent_child",
    request: {
      id: "perm_1",
      provider: "claude",
      name: "Bash",
      kind: "tool",
      title: "Run pytest",
      input: { command: "pytest tests/unit" },
    },
  };

  return {
    clarificationResponse,
    persistedClarifications: [clarificationResponse],
    ruleSuggestion,
    clarifyMock,
    grantMock,
    dismissMock,
    fakeClient,
    permission,
  };
}

function createStandingAuthTestFixture() {
  const permAuth: MainChatStandingAuthorization = {
    id: "auth_perm_1",
    scope: "permission",
    serverId: "srv_1",
    cwd: "/repo/paseo-fork",
    allowSubdirectories: true,
    toolName: "Bash",
    commandPrefix: "npm test",
    mode: null,
    label: "放行 paseo-fork 单元测试",
    reason: "只读测试安全命令",
    createdAt: "2026-11-20T10:00:00.000Z",
    lastMatchedAt: "2026-11-23T07:45:00.000Z",
    matchCount: 14,
    expiresAt: "2026-12-31T23:59:00.000Z",
    revokedAt: null,
  };

  const autoStartAuth: MainChatStandingAuthorization = {
    id: "auth_auto_1",
    scope: "auto_start",
    serverId: "srv_2",
    cwd: "/repo/docs",
    allowSubdirectories: false,
    toolName: null,
    commandPrefix: null,
    mode: "readonly",
    label: "只读调研自动开工",
    reason: null,
    createdAt: "2026-11-21T09:00:00.000Z",
    lastMatchedAt: null,
    matchCount: 3,
    expiresAt: null,
    revokedAt: null,
  };

  const pendingSuggestion: MainChatRuleSuggestion = {
    id: "sugg_promote_1",
    scope: "auto_start",
    label: "自动启动只读代码排查任务",
    reason: "连续 4 次手动同意只读排查计划",
    serverId: "srv_1",
    cwd: "/repo/paseo-fork",
    toolName: null,
    commandPrefix: null,
    mode: "readonly",
    observedCount: 4,
    dismissedAt: null,
    createdAt: "2026-11-22T12:00:00.000Z",
  };

  let currentAuthorizations: MainChatStandingAuthorization[] = [permAuth, autoStartAuth];
  let currentSuggestions: MainChatRuleSuggestion[] = [pendingSuggestion];

  const listMock = vi.fn(async () => ({
    requestId: "req_list",
    authorizations: currentAuthorizations,
    suggestions: currentSuggestions,
    error: null,
  }));

  const revokeMock = vi.fn(async (authorizationId: string) => {
    currentAuthorizations = currentAuthorizations.filter((item) => item.id !== authorizationId);
    return {
      requestId: "req_revoke",
      revoked: true,
      authorization: { ...permAuth, revokedAt: "2026-11-23T08:20:00.000Z" },
      error: null,
    };
  });

  const grantMock = vi.fn(async (input: { suggestionId?: string; label?: string }) => {
    const promoted: MainChatStandingAuthorization = {
      id: "auth_promoted_1",
      scope: "auto_start",
      serverId: "srv_1",
      cwd: "/repo/paseo-fork",
      allowSubdirectories: true,
      toolName: null,
      commandPrefix: null,
      mode: "readonly",
      label: input.label ?? pendingSuggestion.label,
      reason: pendingSuggestion.reason,
      createdAt: "2026-11-23T08:21:00.000Z",
      lastMatchedAt: null,
      matchCount: 0,
      expiresAt: null,
      revokedAt: null,
    };
    currentAuthorizations = [...currentAuthorizations, promoted];
    currentSuggestions = currentSuggestions.filter((item) => item.id !== input.suggestionId);
    return {
      requestId: "req_grant",
      authorization: promoted,
      error: null,
    };
  });

  const dismissMock = vi.fn(async () => ({
    requestId: "req_dismiss",
    dismissed: true,
    error: null,
  }));

  const fakeClient = {
    listMainChatStandingAuthorizations: listMock,
    revokeMainChatStandingAuthorization: revokeMock,
    grantMainChatStandingAuthorization: grantMock,
    dismissMainChatRuleSuggestion: dismissMock,
  } as unknown as DaemonClient;

  return {
    listMock,
    revokeMock,
    grantMock,
    dismissMock,
    fakeClient,
  };
}

describe("M5 Composer, Approval Clarification & Standing Authorizations UI", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    toastShowSpy.mockClear();
    toastErrorSpy.mockClear();
    useMainChatQueueStore.setState({ queuesByAgentId: {} });
    useMainChatOverviewStore.setState({
      overviewsByKey: {},
      decisionsByKey: {},
      activeAgentOverrideByServerId: {},
    });
    useDraftStore.setState({
      drafts: {},
      attachmentFocusRequestByDraftKey: {},
      textReplacementRequestByDraftKey: {},
      metadataByDraftKey: {},
    });
    useSessionStore.setState({ sessions: {}, agentLastActivity: new Map() });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // 1. queue-store & QueuePanel
  // =========================================================================

  it("manages per-agent queues cleanly in queue-store (enqueue, edit, moveToFront, remove, shiftNext, clear)", () => {
    const store = useMainChatQueueStore.getState();
    const first = store.enqueue("agent_main", "First normal message");
    const second = store.enqueue("agent_main", "Second normal message");
    const urgent = store.enqueue("agent_main", "Urgent high priority", { priority: "high" });
    expect(store.enqueue("agent_main", "   ")).toBeNull();

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(urgent).not.toBeNull();

    // High priority item is inserted ahead of normal items.
    expect(
      useMainChatQueueStore.getState().queuesByAgentId.agent_main?.map((item) => item.id),
    ).toEqual([urgent!.id, first!.id, second!.id]);

    // Edit item text.
    expect(store.editItem("agent_main", first!.id, "First edited message")).toBe(true);
    expect(store.editItem("agent_main", first!.id, "   ")).toBe(false);
    expect(useMainChatQueueStore.getState().queuesByAgentId.agent_main?.[1]?.text).toBe(
      "First edited message",
    );

    // Move third item to front and elevate priority to high.
    expect(store.moveToFront("agent_main", second!.id)).toBe(true);
    const afterPin = useMainChatQueueStore.getState().queuesByAgentId.agent_main!;
    expect(afterPin[0]?.id).toBe(second!.id);
    expect(afterPin[0]?.priority).toBe("high");

    // shiftNext pops head atomically.
    const shifted = store.shiftNext("agent_main");
    expect(shifted?.id).toBe(second!.id);
    expect(useMainChatQueueStore.getState().queuesByAgentId.agent_main?.length).toBe(2);

    // removeItem removes specific entry.
    expect(store.removeItem("agent_main", urgent!.id)).toBe(true);
    expect(
      useMainChatQueueStore.getState().queuesByAgentId.agent_main?.map((item) => item.id),
    ).toEqual([first!.id]);

    // clearQueue empties and deletes the agent key.
    store.clearQueue("agent_main");
    expect(useMainChatQueueStore.getState().queuesByAgentId.agent_main).toBeUndefined();
  });

  it("renders QueuePanel with inline edit, pin to front, cancel, and auto-dispatches head once when agent becomes idle", async () => {
    const runningMain = makeAgent({
      id: "agent_main",
      serverId: "srv_1",
      status: "running",
      turn: {
        phase: "open",
        turnId: "turn_1",
        startedAt: new Date("2026-11-23T08:05:00.000Z"),
        cancellationRequestId: null,
      },
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    seedSession("srv_1", runningMain);

    const item1 = useMainChatQueueStore.getState().enqueue("agent_main", "Check test results")!;
    const item2 = useMainChatQueueStore.getState().enqueue("agent_main", "Summarize blockers")!;
    const item3 = useMainChatQueueStore.getState().enqueue("agent_main", "Drop me later")!;

    let resolveDispatch: (() => void) | null = null;
    const onSendMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveDispatch = resolve;
        }),
    );

    const view = renderWithToast(
      <MainChatQueuePanel serverId="srv_1" agentId="agent_main" onSendMessage={onSendMessage} />,
    );

    expect(view.getByTestId("main-chat-queue-panel")).toBeTruthy();
    expect(view.getByTestId("main-chat-queue-count").textContent).toContain('"count":3');

    // Remove item3
    fireEvent.click(view.getByTestId(`main-chat-queue-remove-${item3.id}`));
    expect(view.queryByTestId(`main-chat-queue-item-${item3.id}`)).toBeNull();

    // Inline edit item1
    fireEvent.click(view.getByTestId(`main-chat-queue-edit-${item1.id}`));
    const editInput = view.getByTestId(`main-chat-queue-edit-input-${item1.id}`);
    fireEvent.change(editInput, { target: { value: "Check CI test results" } });
    fireEvent.click(view.getByTestId(`main-chat-queue-save-${item1.id}`));
    expect(view.getByTestId(`main-chat-queue-text-${item1.id}`).textContent).toBe(
      "Check CI test results",
    );

    // Pin item2 to front (high priority)
    fireEvent.click(view.getByTestId(`main-chat-queue-pin-${item2.id}`));
    expect(useMainChatQueueStore.getState().queuesByAgentId.agent_main?.[0]?.id).toBe(item2.id);
    expect(useMainChatQueueStore.getState().queuesByAgentId.agent_main?.[0]?.priority).toBe("high");

    // Still busy -> should NOT auto-dispatch yet
    expect(onSendMessage).not.toHaveBeenCalled();

    // Transition agent from running -> idle: auto-consumes pinned head (item2) exactly once
    act(() => {
      const idleMain = makeAgent({
        ...runningMain,
        status: "idle",
        turn: { phase: "idle", cancellationRequestId: null },
      });
      seedSession("srv_1", idleMain);
    });

    await waitFor(() => {
      expect(onSendMessage).toHaveBeenCalledTimes(1);
    });
    expect(onSendMessage).toHaveBeenCalledWith("Summarize blockers");

    // Re-rendering while dispatch is still in-flight must not trigger duplicate send
    view.rerender(
      <MainChatQueuePanel serverId="srv_1" agentId="agent_main" onSendMessage={onSendMessage} />,
    );
    expect(onSendMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveDispatch?.();
      await Promise.resolve();
    });

    // Only item1 remains in the queue after item2 finished dispatching
    expect(
      useMainChatQueueStore.getState().queuesByAgentId.agent_main?.map((item) => item.id),
    ).toEqual([item1.id]);
  });

  // =========================================================================
  // 2. buildMainChatMentionItems (5-source aggregation, filtering & injection)
  // =========================================================================

  it("aggregates and filters all 5 mention sources (host, workspace, repo, session, skill) with pinyin/fuzzy support and token injection", () => {
    const sources = {
      hosts: [
        { serverId: "srv_1", label: "DevBox 研发机", hostname: "devbox-a", online: true },
        { serverId: "srv_2", label: "MacBook Pro", hostname: "mbp-local", online: true },
      ],
      workspaces: [
        {
          serverId: "srv_1",
          hostLabel: "DevBox 研发机",
          workspaceId: "ws_1",
          name: "paseo-fork",
          directory: "/repo/paseo-fork",
          branch: "work/main-chat-w3-m5-ui",
        },
        {
          serverId: "srv_1",
          hostLabel: "DevBox 研发机",
          workspaceId: "ws_2",
          name: "支付重构工作区",
          directory: "/repo/payments",
          branch: "feat/pay",
        },
      ],
      repos: [
        {
          serverId: "srv_1",
          hostLabel: "DevBox 研发机",
          projectId: "proj_1",
          name: "paseo-fork",
          rootPath: "/repo/paseo-fork",
        },
      ],
      sessions: [
        {
          serverId: "srv_1",
          hostLabel: "DevBox 研发机",
          agentId: "agent_pay_1",
          title: "排查支付超时",
          cwd: "/repo/payments",
          status: "running",
        },
      ],
      skills: extractSkillMentionSources([
        { name: "code-review", description: "代码审查", argumentHint: "[branch]", kind: "skill" },
        { name: "release-beta", description: "发布 Beta", argumentHint: "", kind: "skill" },
        { name: "clear", description: "Not a skill", argumentHint: "", kind: "command" },
      ]),
    };

    // Empty query aggregates all 5 categories
    const allItems = buildMainChatMentionItems({ query: "", ...sources });
    const kinds = new Set(allItems.map((item) => item.kind));
    expect(kinds).toEqual(new Set(["host", "workspace", "repo", "session", "skill"]));
    expect(allItems.some((item) => item.kind === "skill" && item.title === "clear")).toBe(false);

    // Pinyin query matches Chinese titles ("zhifu" -> 支付重构工作区 & 排查支付超时)
    const pinyinMatches = buildMainChatMentionItems({ query: "zhifu", ...sources });
    expect(pinyinMatches.map((item) => item.title)).toEqual(
      expect.arrayContaining(["支付重构工作区", "排查支付超时"]),
    );

    // Category-scoped prefix query ("skill:cr" acronym -> code-review)
    const skillAcronymMatches = buildMainChatMentionItems({ query: "skill:cr", ...sources });
    expect(skillAcronymMatches).toHaveLength(1);
    expect(skillAcronymMatches[0]?.kind).toBe("skill");
    expect(skillAcronymMatches[0]?.title).toBe("code-review");
    expect(skillAcronymMatches[0]?.injectionToken).toBe("[@skill:/code-review]");

    // Per-category & maxTotal cap enforcement
    const capped = buildMainChatMentionItems({
      query: "",
      ...sources,
      limitPerCategory: 1,
      maxTotal: 3,
    });
    expect(capped).toHaveLength(3);

    // Autocomplete option building & token injection into composer text
    const mentionRange = { start: 3, end: 9, query: "zhifu" };
    const options = buildMainChatContextMentionOptions({
      isMainChatContext: true,
      sources,
      skills: sources.skills,
      mention: mentionRange,
      t: fakeT,
    });
    const sessionOption = options.find((opt) => opt.mentionItem.kind === "session")!;
    expect(sessionOption.tag).toBe("mainChat.composer.mentions.tagSession");

    let updatedText = "";
    const onApplied = vi.fn();
    applyMainChatContextMentionSelection({
      option: sessionOption,
      text: "请看 @zhifu进展",
      mention: mentionRange,
      setUserInput: (next) => {
        updatedText = next;
      },
      onAutocompleteApplied: onApplied,
    });
    expect(updatedText).toBe("请看 [@session:排查支付超时 (agent_pay_1)] 进展");
    expect(onApplied).toHaveBeenCalledTimes(1);

    // Token append & replace helpers avoid duplicate injection
    const appendedOnce = appendMentionTokenToText("查看状态", "[@host:DevBox (srv_1)]");
    expect(appendedOnce).toBe("查看状态 [@host:DevBox (srv_1)] ");
    expect(appendMentionTokenToText(appendedOnce, "[@host:DevBox (srv_1)]")).toBe(appendedOnce);
    expect(
      replaceMentionRangeWithToken({
        text: "hello @dev",
        mention: { start: 6, end: 10, query: "dev" },
        token: "[@host:DevBox (srv_1)]",
      }),
    ).toBe("hello [@host:DevBox (srv_1)] ");
  });

  // =========================================================================
  // 3. NextStepsBar (safe direct send vs risky prefill-only HARD RULE)
  // =========================================================================

  it("sends safe (risky: false) next steps directly, while risky (risky: true) items NEVER send and ONLY prefill + warn", async () => {
    const mainAgent = makeAgent({
      id: "agent_main",
      serverId: "srv_1",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    seedSession("srv_1", mainAgent);

    const suggestions: MainChatNextStepSuggestion[] = [
      {
        id: "safe_check",
        label: "汇总各任务进展",
        prompt: "请汇总所有进行中任务的最新状态。",
        risky: false,
      },
      {
        id: "risky_merge",
        label: "合并分支并推送",
        prompt: "请将当前分支合并到 main 并推送远端。",
        risky: true,
        reason: "涉及远端仓库写入",
      },
      {
        id: "s3",
        label: "检查测试日志",
        prompt: "检查最新测试日志",
        risky: false,
      },
      {
        id: "s4",
        label: "删除过期 worktree",
        prompt: "删除过期 worktree",
        risky: true,
      },
      {
        id: "s5_overflow",
        label: "第五条超出上限",
        prompt: "不应当展示第五条",
        risky: false,
      },
    ];

    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_1", "agent_main")]: makeOverview({
          nextStepSuggestions: suggestions,
        }),
      },
    });

    const onSendSafePrompt = vi.fn(async () => undefined);
    const onPrefillRiskyPrompt = vi.fn();

    const view = renderWithToast(
      <MainChatNextStepsBar
        serverId="srv_1"
        agentId="agent_main"
        onSendSafePrompt={onSendSafePrompt}
        onPrefillRiskyPrompt={onPrefillRiskyPrompt}
      />,
    );

    // At most 4 chips rendered
    expect(view.getByTestId("main-chat-next-step-safe_check")).toBeTruthy();
    expect(view.getByTestId("main-chat-next-step-risky_merge")).toBeTruthy();
    const riskyBadgeEl = view.getByTestId("main-chat-next-step-risky-badge-risky_merge");
    expect(riskyBadgeEl).toBeTruthy();
    // Verify riskyBadge keeps single-line nowrap & non-shrinking style so long labels never wrap it vertically.
    const computedStyle = window.getComputedStyle(riskyBadgeEl);
    expect(computedStyle.flexShrink).toBe("0");
    expect(computedStyle.whiteSpace).toBe("nowrap");
    expect(view.queryByTestId("main-chat-next-step-s5_overflow")).toBeNull();

    // Clicking risky suggestion MUST NOT send; MUST only prefill + show caution toast
    fireEvent.click(view.getByTestId("main-chat-next-step-risky_merge"));
    expect(onSendSafePrompt).not.toHaveBeenCalled();
    expect(onPrefillRiskyPrompt).toHaveBeenCalledTimes(1);
    expect(onPrefillRiskyPrompt).toHaveBeenCalledWith(
      "请将当前分支合并到 main 并推送远端。",
      suggestions[1],
    );
    expect(toastShowSpy).toHaveBeenCalledWith("mainChat.composer.nextSteps.riskyPrefilledToast", {
      variant: "info",
    });

    // Clicking safe suggestion directly sends
    fireEvent.click(view.getByTestId("main-chat-next-step-safe_check"));
    await waitFor(() => {
      expect(onSendSafePrompt).toHaveBeenCalledTimes(1);
    });
    expect(onSendSafePrompt).toHaveBeenCalledWith(
      "请汇总所有进行中任务的最新状态。",
      suggestions[0],
    );
  });

  it("prefills composer draft store and focuses editing session when risky next step is clicked inside ComposerEnhancements", () => {
    const mainAgent = makeAgent({
      id: "agent_main",
      serverId: "srv_1",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    seedSession("srv_1", mainAgent);
    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_1", "agent_main")]: makeOverview({
          nextStepSuggestions: [
            {
              id: "risky_deploy",
              label: "执行发布脚本",
              prompt: "请执行 release 脚本发布版本",
              risky: true,
            },
          ],
        }),
      },
    });

    const focusSpy = vi.fn();
    const onSendMessage = vi.fn(async () => undefined);

    function EditorAttacher() {
      const session = useComposerEditingSession("chat");
      React.useEffect(
        () =>
          session.attachEditor({
            getText: () => "",
            replaceText: vi.fn(),
            focus: focusSpy,
          }),
        [session],
      );
      return null;
    }

    function ToolbarHarness() {
      const { extraAttachmentMenuItems, overlay } = useMainChatComposerToolbar({
        serverId: "srv_1",
        agentId: "agent_main",
        onSendMessage,
      });
      return (
        <>
          {overlay}
          {extraAttachmentMenuItems.map((item) => (
            <button
              key={item.id}
              type="button"
              data-testid={item.testID ?? item.id}
              onClick={item.onSelect}
            >
              {item.label}
            </button>
          ))}
        </>
      );
    }

    const view = renderWithToast(
      <ComposerEditingSessionsProvider>
        <WorkspaceComposerEditingSessionsProvider workspaceKey="ws_k" tabIds={TEST_TAB_IDS}>
          <ComposerEditingScope tabId="tab_1" targetKey="agent:srv_1:agent_main">
            <EditorAttacher />
            <MainChatComposerEnhancements
              serverId="srv_1"
              agentId="agent_main"
              onSendMessage={onSendMessage}
            />
            <ToolbarHarness />
          </ComposerEditingScope>
        </WorkspaceComposerEditingSessionsProvider>
      </ComposerEditingSessionsProvider>,
    );

    // At rest, no legacy next-step chips or floating strip render above the dock
    expect(view.queryByTestId("main-chat-next-step-risky_deploy")).toBeNull();
    expect(view.queryByTestId("main-chat-composer-enhancements")).toBeNull();

    // Consolidated (+) composer toolbar items: enqueue current draft & inject host mention token
    const draftKey = buildDraftStoreKey({ serverId: "srv_1", agentId: "agent_main" });
    useDraftStore.getState().replaceDraftText({
      draftKey,
      text: "请执行 release 脚本发布版本",
    });
    fireEvent.click(view.getByTestId("main-chat-attach-queue-message"));
    expect(useMainChatQueueStore.getState().queuesByAgentId.agent_main?.[0]?.text).toBe(
      "请执行 release 脚本发布版本",
    );
    expect(useDraftStore.getState().getDraftInput(draftKey)?.text ?? "").toBe("");

    fireEvent.click(view.getByTestId("main-chat-attach-ref-host"));
    expect(view.getByTestId("main-chat-mention-picker-host")).toBeTruthy();
    fireEvent.click(view.getByTestId("main-chat-mention-pick-host:srv_1"));
    expect(useDraftStore.getState().getDraftInput(draftKey)?.text).toContain("[@host:");
    expect(focusSpy).toHaveBeenCalledTimes(1);

    // Client fallback suggestions generate safe + risky suggestions when server returns none
    const fallbackItems = resolveMainChatNextStepSuggestions({
      overview: makeOverview({
        plans: [
          {
            id: "plan_1",
            mainAgentId: "agent_main",
            status: "open",
            autoStarted: false,
            summary: "Plan",
            createdAt: "2026-11-23T08:00:00.000Z",
            startedAt: null,
            cancelledAt: null,
            tasks: [],
          },
        ],
      }),
      t: fakeT,
    });
    expect(fallbackItems.some((item) => item.id === "fallback:start-open-plan" && item.risky)).toBe(
      true,
    );
  });

  // =========================================================================
  // 4. ApprovalClarify ("Have a question") & Progressive Rule Suggestions
  // =========================================================================

  it("submits approval clarification, shows paused countdown & answer, and adopts/dismisses progressive rule suggestions", async () => {
    const fixture = createClarifyTestFixture();

    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_1", "agent_main")]: makeOverview({
          ruleSuggestions: [fixture.ruleSuggestion],
          pendingClarifications: [],
        }),
      },
    });

    const view = renderWithToast(
      <ChildPermissionWrapper
        serverId="srv_1"
        mainAgentId="agent_main"
        permission={fixture.permission}
        client={fixture.fakeClient}
        sourceAgentId="agent_child"
        sourceAgentTitle="支付单测子任务"
        sourceAgentCwd="/repo/paseo-fork"
      >
        <div data-testid="mock-perm-body">Permission body</div>
      </ChildPermissionWrapper>,
    );

    // 1. Expand "Have a question" and submit a clarification question
    fireEvent.click(view.getByTestId("approval-clarify-toggle-perm_1"));
    const input = view.getByTestId("approval-clarify-input-perm_1");
    fireEvent.change(input, { target: { value: "这条命令是否会修改数据库？" } });
    fireEvent.click(view.getByTestId("approval-clarify-submit-perm_1"));

    await waitFor(() => {
      expect(fixture.clarifyMock).toHaveBeenCalledWith({
        agentId: "agent_child",
        serverId: "srv_1",
        permissionRequestId: "perm_1",
        question: "这条命令是否会修改数据库？",
      });
    });

    // Verify paused countdown badge & clarification answer are displayed
    await waitFor(() => {
      expect(view.getByTestId("approval-clarify-paused-clarify_1")).toBeTruthy();
      expect(view.getByTestId("approval-clarify-answer-clarify_1").textContent).toContain(
        "仅在本地沙箱运行只读 pytest",
      );
    });

    // 2. Adopt progressive rule suggestion below the permission card
    expect(view.getByTestId("rule-suggestion-banner-sugg_1").textContent).toContain('"count":3');
    fireEvent.click(view.getByTestId("rule-suggestion-adopt-sugg_1"));

    await waitFor(() => {
      expect(fixture.grantMock).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "permission",
          toolName: "Bash",
          commandPrefix: "pytest",
          suggestionId: "sugg_1",
        }),
      );
    });

    // 3. Test dismiss path on RuleSuggestionBanner directly & matching helper
    expect(
      findMatchingRuleSuggestion({
        suggestions: [fixture.ruleSuggestion],
        serverId: "srv_1",
        permissionToolName: "Bash",
        ruleCandidate: { toolName: "Bash", commandPrefix: "pytest" },
      })?.id,
    ).toBe("sugg_1");

    view.unmount();

    const onResolved = vi.fn();
    const bannerView = renderWithToast(
      <RuleSuggestionBanner
        serverId="srv_1"
        mainAgentId="agent_main"
        suggestion={fixture.ruleSuggestion}
        client={fixture.fakeClient}
        onResolved={onResolved}
      />,
    );
    fireEvent.click(bannerView.getByTestId("rule-suggestion-dismiss-sugg_1"));
    await waitFor(() => {
      expect(fixture.dismissMock).toHaveBeenCalledWith("sugg_1");
      expect(onResolved).toHaveBeenCalledWith("dismissed", "sugg_1");
    });
    bannerView.unmount();

    // 4. Persisted clarifications auto-expand ApprovalClarifySection
    const persistedView = renderWithToast(
      <ApprovalClarifySection
        serverId="srv_1"
        mainAgentId="agent_main"
        agentId="agent_child"
        permissionRequestId="perm_1"
        client={fixture.fakeClient}
        persistedClarifications={fixture.persistedClarifications}
      />,
    );
    expect(persistedView.getByTestId("approval-clarify-body-perm_1")).toBeTruthy();
    expect(persistedView.getByTestId("approval-clarify-paused-clarify_1")).toBeTruthy();
  });

  // =========================================================================
  // 5. StandingAuthPanel & StandingAuthModal
  // =========================================================================

  it("lists standing authorizations with scope/match metadata, revokes rules, and promotes pending rule suggestions", async () => {
    const fixture = createStandingAuthTestFixture();

    const view = renderWithToast(
      <StandingAuthPanel
        serverId="srv_1"
        client={fixture.fakeClient}
        hostLabelsByServerId={HOST_LABELS_MAP}
      />,
    );

    // Wait for list load
    await waitFor(() => {
      expect(fixture.listMock).toHaveBeenCalledWith({ includeRevoked: false });
      expect(view.getByTestId("standing-auth-item-auth_perm_1")).toBeTruthy();
      expect(view.getByTestId("standing-auth-item-auth_auto_1")).toBeTruthy();
    });

    // Verify scope groups, subdirectory labels, and matchCount display
    expect(view.getByTestId("standing-auth-group-permission")).toBeTruthy();
    expect(view.getByTestId("standing-auth-group-auto-start")).toBeTruthy();
    expect(view.getByTestId("standing-auth-item-auth_perm_1").textContent).toContain("DevBox 主机");
    expect(view.getByTestId("standing-auth-item-auth_perm_1").textContent).toContain("npm test");
    expect(view.getByTestId("standing-auth-item-auth_perm_1").textContent).toContain(
      "mainChat.standingAuth.subdirIncluded",
    );
    expect(view.getByTestId("standing-auth-item-auth_auto_1").textContent).toContain(
      "mainChat.standingAuth.subdirExact",
    );
    expect(view.getByTestId("standing-auth-stats-auth_perm_1").textContent).toContain('"count":14');

    // Revoke permission authorization
    fireEvent.click(view.getByTestId("standing-auth-revoke-auth_perm_1"));
    await waitFor(() => {
      expect(fixture.revokeMock).toHaveBeenCalledWith("auth_perm_1");
      expect(view.queryByTestId("standing-auth-item-auth_perm_1")).toBeNull();
    });

    // Promote rule suggestion into an active standing authorization
    expect(view.getByTestId("standing-auth-suggestion-sugg_promote_1")).toBeTruthy();
    fireEvent.click(view.getByTestId("standing-auth-adopt-sugg_promote_1"));
    await waitFor(() => {
      expect(fixture.grantMock).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "auto_start",
          mode: "readonly",
          suggestionId: "sugg_promote_1",
        }),
      );
      expect(view.getByTestId("standing-auth-item-auth_promoted_1")).toBeTruthy();
      expect(view.queryByTestId("standing-auth-suggestion-sugg_promote_1")).toBeNull();
    });

    // StandingAuthModal renders and closes cleanly
    const onClose = vi.fn();
    const modalView = renderWithToast(
      <StandingAuthModal visible serverId="srv_1" client={fixture.fakeClient} onClose={onClose} />,
    );
    expect(modalView.getByTestId("main-chat-standing-auth-modal")).toBeTruthy();
    fireEvent.click(modalView.getByTestId("main-chat-standing-auth-modal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
