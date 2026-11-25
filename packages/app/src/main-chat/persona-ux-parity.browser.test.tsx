import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  type MainChatOverview,
} from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArrowUp, Plus } from "lucide-react-native";
import React, { act, useCallback, useMemo, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime, withUnistyles } from "react-native-unistyles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { collapseTurns } from "@/agent-stream/turn-collapse/model";
import { TurnSummaryLine } from "@/agent-stream/turn-collapse/summary-line";
import { CHAT_COLUMN_RAIL_DATASET, ChatColumnRailSurface } from "@/chat-rail";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ComposerEditingScope,
  ComposerEditingSessionsProvider,
  WorkspaceComposerEditingSessionsProvider,
} from "@/composer/editing-session";
import { ToastProvider } from "@/contexts/toast-context";
import { i18n } from "@/i18n/i18next";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { StreamItem } from "@/types/stream";
import {
  MainChatActionBar,
  MainChatActionBarDrawerOverlay,
  useMainChatActionBarDrawerStore,
} from "./action-bar";
import { useMainChatComposerToolbar } from "./composer-enhancements";
import { useMainChatDrawerStore } from "./drawer-store";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { MainChatShellProvider } from "./shell-context";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SHELL_CTX_VALUE = {
  inMainChatShell: true,
  originRoute: "/main",
  originTitle: "主对话",
};

const SCREENSHOT_DIR = "/tmp/main-chat-persona-ux-screenshots";
const TEST_TAB_IDS = ["tab_persona_parity"];

const ThemedPlus = withUnistyles(Plus);
const ThemedSend = withUnistyles(ArrowUp);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function makeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  const now = new Date("2026-11-25T10:00:00.000Z");
  return {
    serverId: "srv_1",
    workspaceId: "ws_main",
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

function makeFixtureOverview(): MainChatOverview {
  return {
    plans: [],
    decisions: [
      {
        id: "dec_pr42",
        mainAgentId: "agent_main",
        title: "检查 PR #42",
        question: "PR #42 改了公开接口，旧接口如何处理？",
        agentId: "child_pr42",
        planId: null,
        taskId: "task_pr42",
        options: [
          {
            id: "compat",
            label: "保留兼容层并标记 deprecated",
            leadsTo: "对下游调用方零破坏，下个小版本再清理",
          },
          {
            id: "replace",
            label: "直接切换到新接口",
            leadsTo: "实现最干净，但需同步升级两个消费方",
          },
        ],
        recommendedOptionId: "compat",
        reason: null,
        answer: null,
        answeredOptionId: null,
        answeredAt: null,
        createdAt: "2026-11-25T09:50:00.000Z",
      },
    ],
    tasks: [
      {
        id: "task_running_1",
        mainAgentId: "agent_main",
        planId: null,
        title: "重构消息虚拟列表渲染性能",
        status: "running",
        mode: "write",
        isolation: "local",
        activeAgentId: "child_run_1",
        agentIds: ["child_run_1"],
        workspaceId: "ws_main",
        workspaceLabel: "paseo",
        cwd: "/repo/paseo",
        serverId: "srv_1",
        hostLabel: "DevBox",
        brief: {
          goal: "优化长对话流滚动掉帧问题",
          doneWhen: ["60fps 滚动"],
          outOfBounds: [],
          scopeRevision: 1,
          updatedAt: "2026-11-25T09:00:00.000Z",
        },
        createdAt: "2026-11-25T09:00:00.000Z",
        updatedAt: "2026-11-25T09:58:00.000Z",
        lastActivityAt: "2026-11-25T09:58:00.000Z",
      },
      {
        id: "task_running_2",
        mainAgentId: "agent_main",
        planId: null,
        title: "补齐协议层出站校验单测",
        status: "running",
        mode: "write",
        isolation: "local",
        activeAgentId: "child_run_2",
        agentIds: ["child_run_2"],
        workspaceId: "ws_main",
        workspaceLabel: "paseo",
        cwd: "/repo/paseo",
        serverId: "srv_1",
        hostLabel: "DevBox",
        brief: {
          goal: "补全 AOT 分片校验单测",
          doneWhen: ["vitest 全绿"],
          outOfBounds: [],
          scopeRevision: 1,
          updatedAt: "2026-11-25T09:10:00.000Z",
        },
        createdAt: "2026-11-25T09:10:00.000Z",
        updatedAt: "2026-11-25T09:59:00.000Z",
        lastActivityAt: "2026-11-25T09:59:00.000Z",
      },
    ],
    triages: [
      {
        agentId: "child_framework",
        workspaceId: "ws_main",
        title: "补齐网络层的单元测试",
        managedByMainChat: false,
        phase: "blocked_user",
        summary: "",
        waitReason:
          "网络层的测试用哪个框架？\n1. Swift Testing（推荐）— 新代码统一用 @Test，参数化测试写起来更短\n2. XCTest — 和现有的 UI 测试保持一致",
        suggestedAction: null,
        triageSource: "model",
        updatedAt: "2026-11-25T09:55:00.000Z",
      },
      {
        agentId: "child_build_err",
        workspaceId: "ws_main",
        title: "设置页按钮对齐",
        managedByMainChat: false,
        phase: "blocked_user",
        summary: "rpc: connection closed",
        waitReason: "无法连接远端编译节点，构建已中断",
        suggestedAction: null,
        triageSource: "rule",
        updatedAt: "2026-11-25T09:56:00.000Z",
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
}

function makeFixtureStreamItems(): StreamItem[] {
  const ts = new Date("2026-11-25T09:45:00.000Z");
  return [
    {
      kind: "user_message",
      id: "user_ask_1",
      timestamp: ts,
      text: "帮我同步一下今天所有任务的推进状态，有需要拍板的告诉我。",
    },
    {
      kind: "assistant_message",
      id: "assistant_reply_1",
      timestamp: ts,
      text: "目前 2 个后台任务正常推进中，另有 3 项需要你确认（网络层测试框架、PR #42 接口兼容策略，以及 1 项构建节点连接异常），都在下方「需要你」托盘里可以直接作答。",
    },
    {
      kind: "tool_call",
      id: "bg_patrol_1",
      timestamp: ts,
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "paseo-system:patrol-1",
          name: "heartbeat",
          status: "completed",
          error: null,
          detail: { type: "plain_text", text: "📋 督办 · 主动巡检唤醒：巡检 4 个会话" },
          metadata: {
            mainChatBackground: {
              foldable: true,
              kind: "patrol",
              trigger: "patrol_wakeup",
              label: "巡检 4 个会话状态",
            },
          },
        },
      },
    },
    {
      kind: "tool_call",
      id: "bg_patrol_tool_1",
      timestamp: ts,
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "call_patrol_inspect",
          name: "list_agents",
          status: "completed",
          error: null,
          detail: { type: "plain_text", text: "checked 4 sessions" },
        },
      },
    },
    {
      kind: "assistant_message",
      id: "bg_patrol_reply_1",
      timestamp: ts,
      text: "巡检详情：child_run_1 正在运行 vitest，child_run_2 刚完成分片代码生成，无需打扰用户。",
    },
    {
      kind: "tool_call",
      id: "bg_routine_1",
      timestamp: ts,
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "paseo-system:routine-1",
          name: "heartbeat",
          status: "completed",
          error: null,
          detail: { type: "plain_text", text: "⏰ 定时例行巡检：夜间 CI 汇总" },
          metadata: {
            mainChatBackground: {
              foldable: true,
              kind: "routine",
              trigger: "routine_tick",
              label: "夜间 CI 汇总",
            },
          },
        },
      },
    },
    {
      kind: "assistant_message",
      id: "bg_routine_reply_1",
      timestamp: ts,
      text: "夜间 CI 全部绿色，0 项回归。",
    },
  ];
}

function ParityStreamRow({
  item,
  isNested,
  onExpandedChange,
}: {
  item: StreamItem;
  isNested: boolean;
  onExpandedChange: (hostId: string, expanded: boolean) => void;
}): ReactElement {
  if (item.kind === "turn_summary") {
    return <TurnSummaryLine item={item} onExpandedChange={onExpandedChange} />;
  }
  if (item.kind === "user_message") {
    return (
      <View style={sceneStyles.userBubbleWrap} testID={`stream-item-${item.id}`}>
        <View style={sceneStyles.userBubble}>
          <Text style={sceneStyles.userBubbleText}>{item.text}</Text>
        </View>
      </View>
    );
  }
  if (item.kind === "assistant_message") {
    return (
      <View
        style={isNested ? sceneStyles.nestedDetailRow : sceneStyles.assistantRow}
        testID={`stream-item-${item.id}`}
      >
        <Text style={isNested ? sceneStyles.nestedText : sceneStyles.assistantText}>
          {item.text}
        </Text>
      </View>
    );
  }
  const detailText =
    item.kind === "tool_call" && item.payload.source === "agent"
      ? `${item.payload.data.name}: ${
          item.payload.data.detail.type === "plain_text"
            ? (item.payload.data.detail.text ?? "")
            : ""
        }`
      : item.id;
  return (
    <View style={sceneStyles.nestedDetailRow} testID={`stream-item-${item.id}`}>
      <Text style={sceneStyles.nestedText}>{detailText}</Text>
    </View>
  );
}

function ParityComposerBox({
  extraAttachmentMenuItems,
}: {
  extraAttachmentMenuItems: ReturnType<
    typeof useMainChatComposerToolbar
  >["extraAttachmentMenuItems"];
}): ReactElement {
  return (
    <View style={sceneStyles.composerOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
      <View style={sceneStyles.composerBox} testID="parity-composer-baseline">
        <Text style={sceneStyles.composerPlaceholder}>今天想让 Paseo 帮你推进什么？</Text>
        <View style={sceneStyles.composerToolbar}>
          <DropdownMenu compactMode="sheet">
            <DropdownMenuTrigger
              style={sceneStyles.composerPlusBtn}
              accessibilityRole="button"
              accessibilityLabel="添加附件与上下文"
              testID="parity-composer-plus-trigger"
            >
              <ThemedPlus size={16} uniProps={mutedIconMapping} />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" align="start" minWidth={220}>
              {extraAttachmentMenuItems.map((menuItem) => (
                <React.Fragment key={menuItem.id}>
                  {menuItem.dividerBefore ? <DropdownMenuSeparator /> : null}
                  {menuItem.sectionLabel ? (
                    <DropdownMenuLabel>{menuItem.sectionLabel}</DropdownMenuLabel>
                  ) : null}
                  <DropdownMenuItem
                    testID={menuItem.testID}
                    leading={menuItem.icon ?? null}
                    onSelect={menuItem.onSelect}
                  >
                    {menuItem.label}
                  </DropdownMenuItem>
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <View style={sceneStyles.composerSendDisc}>
            <ThemedSend size={14} uniProps={mutedIconMapping} />
          </View>
        </View>
      </View>
    </View>
  );
}

function ParityMainChatScene({
  serverId,
  agentId,
  compact = false,
}: {
  serverId: string;
  agentId: string;
  compact?: boolean;
}): ReactElement {
  const [expandedHostIds, setExpandedHostIds] = useState<ReadonlySet<string>>(() => new Set());
  const rawItems = useMemo(() => makeFixtureStreamItems(), []);
  const collapsed = useMemo(
    () =>
      collapseTurns({
        tail: rawItems,
        isLatestTurnOpen: false,
        expandedHostIds,
        getGroupedCalls: () => undefined,
        previousSummaryRowsByHostId: new Map(),
        collapseNormalTurns: true,
        collapseBackgroundTurns: true,
      }),
    [expandedHostIds, rawItems],
  );

  const handleExpandedChange = useCallback((hostId: string, expanded: boolean) => {
    setExpandedHostIds((prev) => {
      const next = new Set(prev);
      if (expanded) next.add(hostId);
      else next.delete(hostId);
      return next;
    });
  }, []);

  const toolbar = useMainChatComposerToolbar({
    serverId,
    agentId,
    enabled: true,
  });

  return (
    <View style={[sceneStyles.shell, compact && sceneStyles.shellCompact]} testID="parity-root">
      <ChatColumnRailSurface serverId={serverId}>
        <View style={sceneStyles.railSurface}>
          <View style={sceneStyles.transcriptArea}>
            <View style={sceneStyles.transcriptRail} dataSet={CHAT_COLUMN_RAIL_DATASET}>
              <View style={sceneStyles.messageColumn} testID="parity-message-column">
                {collapsed.tail.map((item) => (
                  <ParityStreamRow
                    key={item.id}
                    item={item}
                    isNested={collapsed.nestedItemIds.has(item.id)}
                    onExpandedChange={handleExpandedChange}
                  />
                ))}
              </View>
            </View>

            <MainChatActionBarDrawerOverlay serverId={serverId} agentId={agentId} />
          </View>

          <View style={sceneStyles.bottomDock}>
            <MainChatActionBar serverId={serverId} agentId={agentId} drawerMode="external" />
            {toolbar.overlay}
            <ParityComposerBox extraAttachmentMenuItems={toolbar.extraAttachmentMenuItems} />
          </View>
        </View>
      </ChatColumnRailSurface>
    </View>
  );
}

async function waitForFrames(count = 3): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
  }
}

function assertEdgeAligned(label: string, el: HTMLElement | null, baseline: DOMRect): void {
  expect(el, `${label} must exist`).toBeTruthy();
  const rect = el!.getBoundingClientRect();
  expect(Math.abs(rect.left - baseline.left), `${label} left edge diff`).toBeLessThanOrEqual(1);
  expect(Math.abs(rect.right - baseline.right), `${label} right edge diff`).toBeLessThanOrEqual(1);
}

function assertNoHorizontalOverflow(rootEl: HTMLElement, label: string): void {
  expect(
    rootEl.scrollWidth,
    `${label} horizontal overflow (scrollWidth=${rootEl.scrollWidth}, clientWidth=${rootEl.clientWidth})`,
  ).toBeLessThanOrEqual(rootEl.clientWidth + 1);
}

describe("Persona UX Parity — Real Playwright Chromium E2E & Visual Verification", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let sendAgentMessageMock: ReturnType<typeof vi.fn>;
  let answerDecisionMock: ReturnType<typeof vi.fn>;

  function renderScene(element: ReactElement): void {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastProvider>
            <MainChatShellProvider value={SHELL_CTX_VALUE}>
              <ComposerEditingSessionsProvider>
                <WorkspaceComposerEditingSessionsProvider
                  workspaceKey="ws_parity"
                  tabIds={TEST_TAB_IDS}
                >
                  <ComposerEditingScope
                    tabId="tab_persona_parity"
                    targetKey="agent:srv_1:agent_main"
                  >
                    {element}
                  </ComposerEditingScope>
                </WorkspaceComposerEditingSessionsProvider>
              </ComposerEditingSessionsProvider>
            </MainChatShellProvider>
          </ToastProvider>
        </QueryClientProvider>,
      );
    });
  }

  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    UnistylesRuntime.setTheme("light");
    document.body.style.margin = "0";
    document.body.style.backgroundColor = "#f9f9fa";

    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    useMainChatDrawerStore.getState().closeDrawer();
    useMainChatActionBarDrawerStore.getState().reset();
    useMainChatOverviewStore.setState({ overviewsByKey: {}, decisionsByKey: {} });
    useSessionStore.setState({ sessions: {} });

    const overview = makeFixtureOverview();
    sendAgentMessageMock = vi.fn(async () => undefined);
    answerDecisionMock = vi.fn(async ({ decisionId, optionId, answer }) => ({
      requestId: "req_ans",
      decision: {
        ...overview.decisions[0]!,
        id: decisionId,
        answeredOptionId: optionId ?? null,
        answer,
        answeredAt: "2026-11-25T10:05:00.000Z",
      },
      error: null,
    }));
    const client = {
      sendAgentMessage: sendAgentMessageMock,
      answerMainChatDecision: answerDecisionMock,
      getMainChatOverview: vi.fn(async () => ({
        requestId: "req_ov",
        overview,
        error: null,
      })),
    } as unknown as DaemonClient;

    useSessionStore.getState().initializeSession("srv_1", client);
    const baseSession = useSessionStore.getState().sessions.srv_1!;
    const agents = new Map<string, Agent>([
      [
        "agent_main",
        makeAgent({
          id: "agent_main",
          title: "主对话",
          labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
        }),
      ],
      ["child_framework", makeAgent({ id: "child_framework", title: "补齐网络层的单元测试" })],
      ["child_pr42", makeAgent({ id: "child_pr42", title: "检查 PR #42" })],
      [
        "child_build_err",
        makeAgent({ id: "child_build_err", title: "设置页按钮对齐", status: "error" }),
      ],
      [
        "child_run_1",
        makeAgent({
          id: "child_run_1",
          title: "重构消息虚拟列表渲染性能",
          status: "running",
          turn: { phase: "open", turnId: "t1", startedAt: new Date(), cancellationRequestId: null },
        }),
      ],
      [
        "child_run_2",
        makeAgent({
          id: "child_run_2",
          title: "补齐协议层出站校验单测",
          status: "running",
          turn: { phase: "open", turnId: "t2", startedAt: new Date(), cancellationRequestId: null },
        }),
      ],
    ]);
    useSessionStore.setState({
      sessions: {
        srv_1: {
          ...baseSession,
          client,
          agents,
          agentDetails: new Map(),
          pendingPermissions: new Map(),
          serverInfo: { features: { forgeSearch: false } },
        } as unknown as SessionState,
      },
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: { [overviewStoreKey("srv_1", "agent_main")]: overview },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  it("01: wide 1440x900 light — single-line @督办巡检 fold/expand, zero redundant dock bars, <=1px alignment, and composer + menu", async () => {
    await page.viewport(1440, 900);
    renderScene(<ParityMainChatScene serverId="srv_1" agentId="agent_main" />);
    await waitForFrames();

    // 1. User Q&A visible; patrol & routine entire turns collapsed to single inline row
    expect(host.querySelector('[data-testid="stream-item-user_ask_1"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="stream-item-assistant_reply_1"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="stream-item-bg_patrol_reply_1"]')).toBeNull();
    expect(host.querySelector('[data-testid="stream-item-bg_routine_reply_1"]')).toBeNull();

    const patrolRow = host.querySelector<HTMLElement>(
      '[data-testid="background-turn-summary-bg_patrol_1"]',
    );
    expect(patrolRow).toBeTruthy();
    expect(patrolRow!.textContent).toContain("@督办巡检");
    expect(patrolRow!.textContent).toContain("已在后台处理");

    // 2. Redundant bars above dock pills are COMPLETELY GONE!
    expect(host.querySelector('[data-testid="main-chat-compact-dock"]')).toBeNull();
    expect(host.querySelector('[data-testid="main-chat-next-steps-bar"]')).toBeNull();
    expect(host.querySelector('[data-testid="main-chat-composer-enhancements"]')).toBeNull();

    // 3. <= 1px alignment against Composer baseline
    const composerRect = host
      .querySelector<HTMLElement>('[data-testid="parity-composer-baseline"]')!
      .getBoundingClientRect();
    assertEdgeAligned("Wide patrol fold row", patrolRow, composerRect);
    assertEdgeAligned(
      "Wide ActionBar inner",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-inner"]'),
      composerRect,
    );
    assertNoHorizontalOverflow(
      host.querySelector<HTMLElement>('[data-testid="parity-root"]')!,
      "Wide light clean dock",
    );

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-wide-light-supervision-fold-and-clean-dock.png`,
    });

    // 4. Click @督办巡检 row to expand in place, then click again to collapse
    act(() => {
      patrolRow!.click();
    });
    await waitForFrames();
    expect(patrolRow!.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[data-testid="stream-item-bg_patrol_reply_1"]')).toBeTruthy();

    act(() => {
      patrolRow!.click();
    });
    await waitForFrames();
    expect(patrolRow!.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[data-testid="stream-item-bg_patrol_reply_1"]')).toBeNull();
  });

  it("02: wide 1440x900 light — Needs You structured Ask Card with radio options, inline custom input, submit, and silent dismiss", async () => {
    await page.viewport(1440, 900);
    renderScene(<ParityMainChatScene serverId="srv_1" agentId="agent_main" />);
    await waitForFrames();

    // Open Needs You tray
    const needsCapsule = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-capsule-needsYou"]',
    )!;
    act(() => {
      needsCapsule.click();
    });
    await waitForFrames();

    // Expand manual session question row ("补齐网络层的单元测试") -> structured Ask Card with parsed 1/2 options
    const toggleFramework = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-needs-toggle-agent:srv_1:child_framework"]',
    )!;
    act(() => {
      toggleFramework.click();
    });
    await waitForFrames();

    const askCard = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-needs-ask-card-agent:srv_1:child_framework"]',
    );
    expect(askCard).toBeTruthy();
    const opt1 = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-needs-ask-option-agent:srv_1:child_framework-parsed-1"]',
    )!;
    expect(opt1.textContent).toContain("Swift Testing");
    expect(opt1.textContent).toContain("推荐");
    expect(
      host.querySelector('[data-testid="main-chat-needs-ask-input-agent:srv_1:child_framework"]'),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-testid="main-chat-needs-ask-open-agent:srv_1:child_framework"]'),
    ).toBeTruthy();

    // Select option 1 visually before screenshot
    act(() => {
      opt1.click();
    });
    await waitForFrames();

    const composerRect = host
      .querySelector<HTMLElement>('[data-testid="parity-composer-baseline"]')!
      .getBoundingClientRect();
    assertEdgeAligned(
      "Wide Needs You drawer frame",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-drawer-frame"]'),
      composerRect,
    );
    assertNoHorizontalOverflow(
      host.querySelector<HTMLElement>('[data-testid="parity-root"]')!,
      "Wide light Needs You Ask Card",
    );

    // Verify the full Ask Card footer (custom input + submit + Open) is completely visible inside the drawer!
    const drawerPanelRect = host
      .querySelector<HTMLElement>('[data-testid="main-chat-action-panel-needsYou"]')!
      .getBoundingClientRect();
    const openBtnRect = host
      .querySelector<HTMLElement>(
        '[data-testid="main-chat-needs-ask-open-agent:srv_1:child_framework"]',
      )!
      .getBoundingClientRect();
    expect(openBtnRect.bottom).toBeLessThanOrEqual(drawerPanelRect.bottom + 1);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-wide-light-needs-you-ask-card.png`,
    });

    // Submit selected option -> dispatches directly to target session!
    const submitBtn = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-needs-ask-submit-agent:srv_1:child_framework"]',
    )!;
    await act(async () => {
      submitBtn.click();
      await Promise.resolve();
    });
    await waitForFrames();
    expect(sendAgentMessageMock).toHaveBeenCalledWith(
      "child_framework",
      "Swift Testing",
      expect.any(Object),
    );

    // Expand error row ("设置页按钮对齐") -> pick "先不管" -> silently collapses & dismisses with 0 commands sent!
    const toggleErr = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-needs-toggle-agent:srv_1:child_build_err"]',
    )!;
    act(() => {
      toggleErr.click();
    });
    await waitForFrames();

    const ignoreOpt = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-needs-ask-option-agent:srv_1:child_build_err-dismiss"]',
    )!;
    act(() => {
      ignoreOpt.click();
    });
    await waitForFrames();

    const submitErrBtn = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-needs-ask-submit-agent:srv_1:child_build_err"]',
    )!;
    act(() => {
      submitErrBtn.click();
    });
    await waitForFrames();

    expect(sendAgentMessageMock).toHaveBeenCalledTimes(1); // NO extra message sent!
    expect(
      host.querySelector('[data-testid="main-chat-action-needs-item-agent:srv_1:child_build_err"]'),
    ).toBeNull();
  });

  it("03: wide 1440x900 dark — Needs You list & expanded decision Ask Card with crisp contrast and zero overflow", async () => {
    await page.viewport(1440, 900);
    UnistylesRuntime.setTheme("dark");
    document.body.style.backgroundColor = "#111113";
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "needsYou" },
    });

    renderScene(<ParityMainChatScene serverId="srv_1" agentId="agent_main" />);
    await waitForFrames();

    const composerRect = host
      .querySelector<HTMLElement>('[data-testid="parity-composer-baseline"]')!
      .getBoundingClientRect();
    assertEdgeAligned(
      "Wide dark ActionBar inner",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-inner"]'),
      composerRect,
    );
    assertEdgeAligned(
      "Wide dark drawer frame",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-drawer-frame"]'),
      composerRect,
    );
    assertNoHorizontalOverflow(
      host.querySelector<HTMLElement>('[data-testid="parity-root"]')!,
      "Wide dark Needs You tray",
    );

    // Screenshot 3 matches Persona web-after-tray-needs-dark.png (clean dark Needs You list!)
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-wide-dark-needs-you-tray.png`,
    });

    // Also verify expanding & answering decision Ask Card works in dark mode
    const toggleDecision = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-needs-toggle-decision:dec_pr42"]',
    )!;
    act(() => {
      toggleDecision.click();
    });
    await waitForFrames();
    const optCompat = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-needs-ask-option-decision:dec_pr42-decision-opt:compat"]',
    )!;
    act(() => {
      optCompat.click();
    });
    await waitForFrames();
    const submitDec = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-needs-ask-submit-decision:dec_pr42"]',
    )!;
    await act(async () => {
      submitDec.click();
      await Promise.resolve();
    });
    expect(answerDecisionMock).toHaveBeenCalledWith({
      decisionId: "dec_pr42",
      optionId: "compat",
      answer: "保留兼容层并标记 deprecated",
    });
  });

  it("04: narrow 390x844 light — mobile parity with @督办巡检 fold, expanded Ask Card, <=1px alignment, and zero horizontal overflow", async () => {
    await page.viewport(390, 844);
    UnistylesRuntime.setTheme("light");
    document.body.style.backgroundColor = "#f9f9fa";
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "needsYou" },
    });

    renderScene(<ParityMainChatScene serverId="srv_1" agentId="agent_main" compact />);
    await waitForFrames();

    const toggleFramework = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-needs-toggle-agent:srv_1:child_framework"]',
    )!;
    act(() => {
      toggleFramework.click();
    });
    await waitForFrames();

    const composerRect = host
      .querySelector<HTMLElement>('[data-testid="parity-composer-baseline"]')!
      .getBoundingClientRect();
    assertEdgeAligned(
      "Narrow 390 ActionBar inner",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-inner"]'),
      composerRect,
    );
    assertEdgeAligned(
      "Narrow 390 drawer frame",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-drawer-frame"]'),
      composerRect,
    );
    assertEdgeAligned(
      "Narrow 390 patrol fold row",
      host.querySelector<HTMLElement>('[data-testid="background-turn-summary-bg_patrol_1"]'),
      composerRect,
    );
    assertNoHorizontalOverflow(
      host.querySelector<HTMLElement>('[data-testid="parity-root"]')!,
      "Narrow 390 light parity",
    );

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-narrow-390-light-parity.png`,
    });
  });
});

const sceneStyles = StyleSheet.create((theme) => ({
  shell: {
    width: "100%",
    height: 900,
    backgroundColor: theme.colors.background,
    overflow: "hidden",
  },
  shellCompact: {
    height: 844,
  },
  railSurface: {
    flex: 1,
    width: "100%",
    height: "100%",
  },
  transcriptArea: {
    flex: 1,
    minHeight: 0,
    position: "relative",
    justifyContent: "flex-start",
    paddingTop: theme.spacing[6],
  },
  transcriptRail: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  messageColumn: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    gap: theme.spacing[3],
  },
  userBubbleWrap: {
    width: "100%",
    alignItems: "flex-end",
  },
  userBubble: {
    maxWidth: "82%",
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: 10,
  },
  userBubbleText: {
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    color: theme.colors.foreground,
  },
  assistantRow: {
    width: "100%",
    paddingHorizontal: theme.spacing[1],
  },
  assistantText: {
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    color: theme.colors.foreground,
  },
  nestedDetailRow: {
    marginLeft: theme.spacing[3],
    paddingLeft: theme.spacing[3],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    paddingVertical: 4,
  },
  nestedText: {
    fontSize: 12.5,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
  },
  bottomDock: {
    width: "100%",
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[1.5],
  },
  composerOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  composerBox: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[3],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[3],
  },
  composerPlaceholder: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundExtraMuted,
  },
  composerToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  composerPlusBtn: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  composerSendDisc: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
}));
