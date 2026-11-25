// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  type MainChatOverview,
} from "@getpaseo/protocol/main-chat";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { TFunction } from "i18next";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collapseTurns } from "@/agent-stream/turn-collapse/model";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import {
  NeedsYouInlineBody,
  MainChatActionBar,
  useMainChatActionBarDrawerStore,
} from "./action-bar";
import type { ActionBarDecisionNeedsYouItem, ActionBarTaskNeedsYouItem } from "./action-bar-model";
import { buildDecisionAskCardModel, buildTaskAskCardModel } from "./needs-you-ask-model";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";

vi.mock("@/runtime/host-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/runtime/host-runtime")>();
  return {
    ...actual,
    useHosts: () => [{ serverId: "srv_1", label: "DevBox" }],
    useHostRuntimeClient: () => null,
  };
});

vi.mock("./use-steward-roster", () => ({
  useStewardAllowedServerIds: () => ["srv_1"],
}));

const openTaskTargetMock = vi.fn();
vi.mock("./open-task-target", () => ({
  useIsCompactMainChatLayout: () => false,
  useOpenMainChatTaskTarget: () => openTaskTargetMock,
}));

const fakeT = ((key: string, opts?: Record<string, unknown>) =>
  opts ? `${key}:${JSON.stringify(opts)}` : key) as unknown as TFunction;

function makeTaskNeedsItem(
  overrides: Partial<ActionBarTaskNeedsYouItem> = {},
): ActionBarTaskNeedsYouItem {
  return {
    kind: "task",
    id: "agent:srv_1:child_1",
    serverId: "srv_1",
    agentId: "child_1",
    workspaceId: "ws_1",
    taskId: null,
    title: "测试框架选择",
    hostLabel: "DevBox",
    workspaceLabel: "paseo",
    cwd: "/repo/paseo",
    mode: null,
    reason: "网络层的测试用哪个框架？",
    summary: null,
    suggestedAction: null,
    goal: null,
    isFailed: false,
    canRetryWithFallback: false,
    ruleDiagnostic: null,
    taskRecord: null,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

function makeFakeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  const now = new Date("2026-11-25T10:00:00.000Z");
  return {
    serverId: "srv_1",
    workspaceId: "ws_1",
    provider: "claude",
    status: "idle",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    cwd: "/repo/paseo",
    model: "claude-opus-4-5",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    title: overrides.id,
    labels: {},
    background: false,
    turn: { phase: "idle", turnId: null, startedAt: null, cancellationRequestId: null },
    backgroundWork: null,
    ...overrides,
  } as Agent;
}

const toast = { show: vi.fn(), copied: vi.fn(), error: vi.fn(), dismiss: vi.fn() };

function renderWithToast(node: ReactNode) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ToastApiProvider api={toast}>{node}</ToastApiProvider>
    </QueryClientProvider>,
  );
}

describe("Persona UX parity — background reports and actionable requests", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    openTaskTargetMock.mockReset();
    useMainChatActionBarDrawerStore.getState().reset();
    useMainChatOverviewStore.setState({ overviewsByKey: {}, decisionsByKey: {} });
    useSessionStore.setState({ sessions: {} });
  });

  it("folds background work and preserves reports, user exchanges, and interactive cards", () => {
    const ts = new Date("2026-11-25T10:00:00.000Z");
    const tail: StreamItem[] = [
      // 1. User active question & reply -> NEVER folded into background row
      {
        kind: "user_message",
        id: "user_q1",
        timestamp: ts,
        text: "帮我看一下今天发布准备情况",
      },
      {
        kind: "assistant_message",
        id: "assistant_a1",
        timestamp: ts,
        text: "目前 2 个主线分支均通过检查。",
      },
      // 2. Background supervision with tools and a visible final report.
      {
        kind: "tool_call",
        id: "bg_sup_1",
        timestamp: ts,
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "paseo-system:sup1",
            name: "heartbeat",
            status: "completed",
            error: null,
            detail: { type: "plain_text", text: "📋 督办 · 主动巡检唤醒" },
            metadata: {
              mainChatBackground: {
                foldable: true,
                kind: "supervision",
                trigger: "patrol_wakeup",
                label: "巡检检查 3 个活跃会话",
              },
            },
          },
        },
      },
      {
        kind: "tool_call",
        id: "bg_sup_tool_1",
        timestamp: ts,
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "call_sup_1",
            name: "list_agents",
            status: "completed",
            error: null,
            detail: { type: "plain_text", text: "listed" },
          },
        },
      },
      {
        kind: "assistant_message",
        id: "bg_sup_reply_1",
        timestamp: ts,
        text: "巡检完毕：一切正常，未发现阻塞。",
      },
      // The background turn delivers interactive cards and a report.
      {
        kind: "tool_call",
        id: "bg_sup_2",
        timestamp: ts,
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "paseo-system:sup2",
            name: "heartbeat",
            status: "completed",
            error: null,
            detail: { type: "plain_text", text: "📋 督办 · 发现待拍板" },
            metadata: {
              mainChatBackground: {
                foldable: true,
                kind: "patrol",
                trigger: "patrol_wakeup",
              },
            },
          },
        },
      },
      {
        kind: "tool_call",
        id: "card_decision_1",
        timestamp: ts,
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "call_ask_user_1",
            name: "task_ask_user",
            status: "completed",
            error: null,
            detail: { type: "unknown", input: {}, output: {} },
          },
        },
      },
      {
        kind: "tool_call",
        id: "card_receipt_1",
        timestamp: ts,
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "call_complete_1",
            name: "task_complete",
            status: "completed",
            error: null,
            detail: { type: "unknown", input: {}, output: {} },
          },
        },
      },
      {
        kind: "assistant_message",
        id: "bg_sup_reply_2",
        timestamp: ts,
        text: "已整理完待拍板与回执。",
      },
    ];

    const collapsed = collapseTurns({
      tail,
      isLatestTurnOpen: false,
      expandedHostIds: new Set(),
      getGroupedCalls: () => undefined,
      previousSummaryRowsByHostId: new Map(),
      collapseNormalTurns: true,
      collapseBackgroundTurns: true,
    });

    // Both reports and their interactive cards remain visible with background work folded.
    expect(collapsed.tail.map((item) => item.id)).toEqual([
      "user_q1",
      "assistant_a1",
      "turn-summary:bg_sup_1",
      "bg_sup_reply_1",
      "turn-summary:bg_sup_2",
      "card_decision_1",
      "card_receipt_1",
      "bg_sup_reply_2",
    ]);

    // Clicking to expand bg_sup_1 reveals its full turn details in place
    const expanded = collapseTurns({
      tail,
      isLatestTurnOpen: false,
      expandedHostIds: new Set(["bg_sup_1"]),
      getGroupedCalls: () => undefined,
      previousSummaryRowsByHostId: collapsed.summaryRowsByHostId,
      collapseNormalTurns: true,
      collapseBackgroundTurns: true,
    });
    expect(expanded.tail.map((item) => item.id)).toEqual([
      "user_q1",
      "assistant_a1",
      "turn-summary:bg_sup_1",
      "bg_sup_1",
      "bg_sup_tool_1",
      "bg_sup_reply_1",
      "turn-summary:bg_sup_2",
      "card_decision_1",
      "card_receipt_1",
      "bg_sup_reply_2",
    ]);
  });

  it("preserves free text and exposes only choices from a structured decision", () => {
    for (const reason of ["1. First finding\n2. Second finding", "**Blocked**", "Do you agree?"]) {
      for (const isFailed of [true, false]) {
        const model = buildTaskAskCardModel(makeTaskNeedsItem({ reason, isFailed }), fakeT);
        expect(model.question).toBe(reason);
        expect(model.options).toEqual([]);
      }
    }
    const decItem: ActionBarDecisionNeedsYouItem = {
      kind: "decision",
      id: "decision:dec_1",
      serverId: "srv_1",
      agentId: "child_1",
      workspaceId: "ws_1",
      taskId: "task_1",
      title: "接口兼容策略",
      hostLabel: "DevBox",
      reason: "是否保留旧接口？",
      decision: {
        id: "dec_1",
        mainAgentId: "agent_main",
        title: "接口兼容策略",
        question: "PR #42 改了公开接口，旧接口如何处理？",
        agentId: "child_1",
        planId: null,
        taskId: "task_1",
        options: [
          { id: "compat", label: "保留兼容层", leadsTo: "对下游零破坏" },
          { id: "break", label: "直接升级", leadsTo: "代码最简洁" },
        ],
        recommendedOptionId: "compat",
        reason: null,
        answer: null,
        answeredOptionId: null,
        answeredAt: null,
        createdAt: "2026-11-25T10:00:00.000Z",
      },
      taskRecord: null,
      updatedAtMs: 1_700_000_000_000,
    };
    const decModel = buildDecisionAskCardModel(decItem, fakeT);
    expect(decModel.options.map((opt) => opt.id)).toEqual([
      "decision-opt:compat",
      "decision-opt:break",
    ]);
    expect(decModel.options[0]?.recommended).toBe(true);
  });

  it("submits selected radio option to target session, supports custom text, and silently dismisses on 先不管 without sending any command", async () => {
    const sendAgentMessage = vi.fn(async () => undefined);
    const getMainChatOverview = vi.fn(async () => ({
      requestId: "req_ov",
      overview,
      error: null,
    }));
    const client = {
      sendAgentMessage,
      getMainChatOverview,
    } as unknown as DaemonClient;

    const mainAgent = makeFakeAgent({
      id: "agent_main",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    const manualAskChild = makeFakeAgent({
      id: "child_ask",
      title: "网络层单测",
    });
    const errorChild = makeFakeAgent({
      id: "child_err",
      title: "发布脚本",
      status: "error",
    });

    const overview: MainChatOverview = {
      plans: [],
      decisions: [],
      tasks: [],
      triages: [
        {
          agentId: "child_ask",
          workspaceId: "ws_1",
          title: "网络层单测",
          managedByMainChat: false,
          phase: "blocked_user",
          summary: "",
          waitReason:
            "## **网络层**\n用 *哪个* `test_id` 检查 [PR #42](https://example.com/pr/42)？",
          suggestedAction: null,
          triageSource: "model",
          updatedAt: "2026-11-25T10:01:00.000Z",
        },
        {
          agentId: "child_err",
          workspaceId: "ws_1",
          title: "发布脚本",
          managedByMainChat: false,
          phase: "blocked_user",
          summary: "rpc: connection closed",
          waitReason: "无法连接构建主机",
          suggestedAction: null,
          triageSource: "rule",
          updatedAt: "2026-11-25T10:02:00.000Z",
        },
      ],
      recentReceipts: [],
      standingAuthorizations: [],
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
        noProgressNudges: 0,
        usageLimitRetries: 0,
      },
    };

    const agentsMap = new Map<string, Agent>([
      [mainAgent.id, mainAgent],
      [manualAskChild.id, manualAskChild],
      [errorChild.id, errorChild],
    ]);

    useSessionStore.getState().initializeSession("srv_1", client);
    const baseSession = useSessionStore.getState().sessions.srv_1!;
    useSessionStore.setState({
      sessions: {
        srv_1: {
          ...baseSession,
          client,
          agents: agentsMap,
          agentDetails: new Map(),
          pendingPermissions: new Map(),
          serverInfo: { features: { forgeSearch: false } },
        } as unknown as SessionState,
      },
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: { [overviewStoreKey("srv_1", "agent_main")]: overview },
    });

    const view = renderWithToast(<MainChatActionBar serverId="srv_1" agentId="agent_main" />);

    // CompactStatusDock is completely removed — only status capsule pills render!
    expect(view.queryByTestId("main-chat-compact-dock")).toBeNull();
    expect(view.getByTestId("main-chat-action-capsule-needsYou")).toBeTruthy();

    // Open Needs You drawer
    fireEvent.click(view.getByTestId("main-chat-action-capsule-needsYou"));

    expect(view.getByText("DevBox · 网络层 用 哪个 test_id 检查 PR #42？")).toBeTruthy();

    // 1. Expand error card, choose "先不管", click Submit -> silently dismisses, ZERO messages sent!
    fireEvent.click(view.getByTestId("main-chat-action-needs-toggle-agent:srv_1:child_err"));
    fireEvent.click(view.getByTestId("main-chat-needs-ask-dismiss-agent:srv_1:child_err"));
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(view.queryByTestId("main-chat-action-needs-item-agent:srv_1:child_err")).toBeNull();

    // 2. Open the remaining task, then respond in free text.
    fireEvent.click(view.getByTestId("main-chat-needs-ask-open-agent:srv_1:child_ask"));
    expect(openTaskTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: "srv_1",
        agentId: "child_ask",
        title: "网络层单测",
      }),
    );

    expect(view.queryByRole("radio")).toBeNull();
    fireEvent.change(view.getByTestId("main-chat-needs-ask-input-agent:srv_1:child_ask"), {
      target: { value: "Swift Testing" },
    });
    fireEvent.click(view.getByTestId("main-chat-needs-ask-submit-agent:srv_1:child_ask"));

    await waitFor(() => {
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    });
    expect(sendAgentMessage).toHaveBeenCalledWith("child_ask", "Swift Testing", expect.any(Object));
  });

  it("retries a direction task through the root ledger when the tray has no retry handler", async () => {
    const client = {} as DaemonClient;
    useSessionStore.getState().initializeSession("srv_1", client);
    const retry = vi
      .spyOn(useMainChatOverviewStore.getState(), "retryTaskWithFallback")
      .mockResolvedValue({} as never);
    const item = makeTaskNeedsItem({
      taskId: "task-17",
      isFailed: true,
      canRetryWithFallback: true,
    });
    const onSubmitted = vi.fn();
    try {
      const view = renderWithToast(
        <NeedsYouInlineBody
          item={item}
          mainServerId="srv_1"
          mainAgentId="root"
          isRetrying={false}
          onOpenTarget={vi.fn()}
          onDismiss={vi.fn()}
          onSubmitted={onSubmitted}
        />,
      );
      fireEvent.click(view.getByRole("radio"));
      fireEvent.click(view.getByTestId("main-chat-needs-ask-submit-" + item.id));
      await waitFor(() =>
        expect(retry).toHaveBeenCalledWith("srv_1", "root", { taskId: "task-17" }, client),
      );
      expect(onSubmitted).toHaveBeenCalledWith(item.id);
    } finally {
      retry.mockRestore();
    }
  });

  it("submits custom free-text typed in the inline input directly to the target session", async () => {
    const sendAgentMessage = vi.fn(async () => undefined);
    const getMainChatOverview = vi.fn(async () => ({
      requestId: "req_ov_custom",
      overview,
      error: null,
    }));
    const client = {
      sendAgentMessage,
      getMainChatOverview,
    } as unknown as DaemonClient;

    const mainAgent = makeFakeAgent({
      id: "agent_main",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    const manualAskChild = makeFakeAgent({
      id: "child_custom",
      title: "缓存策略",
    });

    const overview: MainChatOverview = {
      plans: [],
      decisions: [],
      tasks: [],
      triages: [
        {
          agentId: "child_custom",
          workspaceId: "ws_1",
          title: "缓存策略",
          managedByMainChat: false,
          phase: "blocked_user",
          summary: "",
          waitReason: "缓存过期时间设成多少合适？",
          suggestedAction: null,
          triageSource: "model",
          updatedAt: "2026-11-25T10:05:00.000Z",
        },
      ],
      recentReceipts: [],
      standingAuthorizations: [],
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
        noProgressNudges: 0,
        usageLimitRetries: 0,
      },
    };

    useSessionStore.getState().initializeSession("srv_1", client);
    const baseSession2 = useSessionStore.getState().sessions.srv_1!;
    useSessionStore.setState({
      sessions: {
        srv_1: {
          ...baseSession2,
          client,
          agents: new Map<string, Agent>([
            [mainAgent.id, mainAgent],
            [manualAskChild.id, manualAskChild],
          ]),
          agentDetails: new Map(),
          pendingPermissions: new Map(),
          serverInfo: { features: { forgeSearch: false } },
        } as unknown as SessionState,
      },
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: { [overviewStoreKey("srv_1", "agent_main")]: overview },
    });

    const view = renderWithToast(<MainChatActionBar serverId="srv_1" agentId="agent_main" />);
    fireEvent.click(view.getByTestId("main-chat-action-capsule-needsYou"));

    const inputEl = view.getByTestId("main-chat-needs-ask-input-agent:srv_1:child_custom");
    fireEvent.change(inputEl, { target: { value: "统一设为 15 分钟并支持手动失效" } });
    fireEvent.click(view.getByTestId("main-chat-needs-ask-submit-agent:srv_1:child_custom"));

    await waitFor(() => {
      expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    });
    expect(sendAgentMessage).toHaveBeenCalledWith(
      "child_custom",
      "统一设为 15 分钟并支持手动失效",
      expect.any(Object),
    );
  });
});
