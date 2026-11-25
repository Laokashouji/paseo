import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  type MainChatDecisionRecord,
  type MainChatNextStepSuggestion,
  type MainChatOverview,
  type MainChatPlanRecord,
} from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { CHAT_COLUMN_RAIL_DATASET, ChatColumnRailSurface } from "@/chat-rail";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { providersSnapshotQueryKey } from "@/hooks/use-providers-snapshot";
import { i18n } from "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import {
  MainChatActionBar,
  MainChatActionBarDrawerOverlay,
  useMainChatActionBarDrawerStore,
} from "./action-bar";
import { useMainChatCameFromStore } from "./came-from-store";
import { MainChatCompactionBanner } from "./compaction-banner";
import { MainChatComposerEnhancements } from "./composer-enhancements";
import { MainChatDecisionCard } from "./decision-card";
import { useMainChatDrawerStore } from "./drawer-store";
import { MainChatFirstSetupView } from "./first-setup-view";
import { MainChatHandoffCard } from "./handoff-card";
import { MainChatNextStepsBar } from "./next-steps-bar";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { MainChatPlanCard } from "./plan-card";
import { useMainChatQueueStore } from "./queue-store";
import { MainChatReceiptCard } from "./receipt-card";
import { MainChatReworkCard } from "./rework-card";
import { MainChatRouteBanner } from "./route-banner";
import { useMainChatSettingsStore } from "./settings-store";
import { MainChatShellProvider } from "./shell-context";
import { renderMainChatInlineToolCard } from "./stream-card";

const { navigateToAgentMock } = vi.hoisted(() => ({
  navigateToAgentMock: vi.fn(),
}));

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: navigateToAgentMock,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BROWSER_SHELL_STYLE = { height: 520, flexDirection: "column" as const };
const BROWSER_STREAM_VIEWPORT_STYLE = { flex: 1, position: "relative" as const };
const RAIL_ALIGNMENT_ROUTE_TARGET = {
  targetServerId: "srv_1",
  targetAgentId: "child_browser_1",
  targetTitle: "修复底部 Rail 对齐与设置项",
};
const SESSION_LINK_SHELL_CONTEXT_VALUE = {
  inMainChatShell: true,
  originRoute: "/main",
  originTitle: "主对话",
};
const noopClearRoute = () => undefined;
const SCREENSHOT_DIR = (import.meta as ImportMeta & { env?: Record<string, string | undefined> })
  .env?.VITE_MAIN_CHAT_SCREENSHOT_DIR;

const WIDE_STREAM_PLAN: MainChatPlanRecord = {
  id: "plan_wide_860",
  mainAgentId: "agent_main",
  status: "open",
  autoStarted: false,
  summary: "统一修复主对话 5 类内联卡片在 800px+ 宽屏对话流中的宽度撑满与字号行高规范",
  createdAt: "2026-11-24T10:00:00.000Z",
  startedAt: null,
  cancelledAt: null,
  tasks: [
    {
      id: "task_cards_layout",
      title: "移除 5 类内联卡片 maxWidth: 640 并提升主正文与次要元信息字号行高",
      goal: "让计划卡、交接卡、决策卡、验收卡与返工卡 100% 撑满对话列宽，消除右侧大块留白并对齐正文阅读层级。",
      mode: "write",
      isolation: "worktree",
      workspaceId: "ws_repo",
      cwd: "/repo/paseo-fork",
      workspaceLabel: "paseo-fork",
      hostLabel: "DevBox",
      reason: "涉及 5 个前端内联卡片组件样式改造，建议确认后执行",
      doneWhen: [
        "5 类卡片在 860px 宽屏对话列下均 100% 撑满列宽，误差 <= 1px",
        "卡片标题、任务标题与正文目标提升至 14px，次要元信息补足行高",
      ],
      outOfBounds: ["不触碰右侧任务抽屉 TaskPanelDrawer 的 640px 抽屉上限"],
      provider: "claude/claude-opus-5-5",
      modeId: "acceptEdits",
      thinkingOptionId: "high",
      branchName: "fix/main-chat-inline-cards",
      baseBranch: "feat/main-chat",
      agentId: null,
      startedAt: null,
      startError: null,
    },
    {
      id: "task_cards_browser_verify",
      title: "补充 800px+ 对话流内联卡片 Chromium 几何断言与展开态截图",
      goal: "在真实 Chromium 中验证展开态计划卡与交接卡宽度、字号与视觉排版表现。",
      mode: "readonly",
      isolation: "local",
      workspaceId: "ws_repo",
      cwd: "/repo/paseo-fork",
      workspaceLabel: "paseo-fork",
      hostLabel: "DevBox",
      reason: "只读测试验证任务",
      doneWhen: ["Playwright 几何断言与 oxlint / typecheck 全部通过"],
      outOfBounds: [],
      provider: "claude",
      modeId: null,
      thinkingOptionId: null,
      branchName: null,
      baseBranch: null,
      agentId: null,
      startedAt: null,
      startError: null,
    },
  ],
};

const WIDE_STREAM_DECISION: MainChatDecisionRecord = {
  id: "dec_wide_860",
  mainAgentId: "agent_main",
  title: "确认内联卡片次要元信息字号方案",
  question: "主标题与正文目标已统一提升至 14px，次要路径与验收项是否采用 13px / 19-20px 行高？",
  agentId: "child_running_1",
  planId: "plan_wide_860",
  taskId: "task_cards_layout",
  reason: "兼顾长路径信息密度与宽屏桌面端清晰可读性。",
  recommendedOptionId: "opt_13px",
  answer: null,
  answeredOptionId: null,
  answeredAt: null,
  createdAt: "2026-11-24T10:02:00.000Z",
  options: [
    {
      id: "opt_13px",
      label: "采用 13px 搭配 19-20px 行高",
      leadsTo: "与 14px 主正文形成清晰主次层级，长路径不易折行拥挤",
    },
    {
      id: "opt_14px",
      label: "次要信息也统一到 14px",
      leadsTo: "整体更醒目，但多条验收标准会占用更多垂直高度",
    },
  ],
};

const WIDE_STREAM_RECEIPT_INPUT = {
  taskId: "task_receipt_860",
  planId: "plan_wide_860",
  agentId: "child_running_1",
  title: "底部 Rail 像素级对齐改造",
  summary:
    "已完成 composer-enhancements、action-bar 与 route-banner 外层 Rail 对齐，Playwright 实测误差 <= 1px。",
  checks: [
    {
      criterion: "宽屏与窄屏底部 4 个栏位左右边缘与 Composer 对齐",
      passed: true,
      evidence: "ux-polish.browser.test.tsx 7/7 通过",
    },
  ],
  nextSteps: ["继续完成 5 类内联卡片宽度与字号改造"],
};

const WIDE_STREAM_RECEIPT_OUTPUT = {
  receipt: {
    ...WIDE_STREAM_RECEIPT_INPUT,
  },
};

const WIDE_STREAM_REWORK_INPUT = {
  agentId: "child_running_1",
  planId: "plan_wide_860",
  taskId: "task_cards_layout",
  title: "补齐 5 类内联卡片宽度与字号",
  round: 1,
  gaps: [
    "移除 plan/handoff/decision/receipt/rework 5 类卡片硬编码 maxWidth: 640",
    "在 800px+ 对话列中补齐 Playwright 几何断言并生成展开态截图",
  ],
  note: "保留已验收的底部 Rail 对齐与新增主对话三项选择器改动。",
};

const WIDE_STREAM_REWORK_OUTPUT = {
  rework: {
    ...WIDE_STREAM_REWORK_INPUT,
  },
};

const toastShowMock = vi.fn(() => () => undefined);
const toastErrorMock = vi.fn();
const toastApi: ComponentProps<typeof ToastApiProvider>["api"] = {
  show: toastShowMock,
  error: toastErrorMock,
  copied: vi.fn(),
};

function countPaintedLines(element: HTMLElement): number {
  const tops = new Set<number>();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const text = walker.currentNode.textContent ?? "";
    if (!text.trim()) continue;
    const range = document.createRange();
    range.selectNodeContents(walker.currentNode);
    for (const rect of Array.from(range.getClientRects())) {
      if (rect.width > 0 && rect.height > 0) {
        tops.add(Math.round(rect.top));
      }
    }
  }
  return tops.size;
}

function makeAgent(partial: Partial<Agent> & { id: string; serverId: string }): Agent {
  const now = new Date("2026-11-24T10:00:00.000Z");
  return {
    provider: "claude",
    status: "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: null,
    lastActivityAt: now,
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
    archivedAt: null,
    background: false,
    labels: {},
    ...partial,
  };
}

function makeOverview(partial: Partial<MainChatOverview> = {}): MainChatOverview {
  return {
    plans: [],
    decisions: [],
    tasks: [],
    triages: [],
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
    settings: createDefaultMainChatSettings(),
    ...partial,
  };
}

function seedMainChatSession(
  overview: MainChatOverview,
  extraAgents: Agent[] = [],
  options?: { enableChatOutlineRail?: boolean; enableProvidersSnapshot?: boolean },
): void {
  const mainAgent = makeAgent({
    id: "agent_main",
    serverId: "srv_1",
    workspaceId: "ws_main",
    title: "对话管家",
    labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
  });
  const agents = new Map<string, Agent>([[mainAgent.id, mainAgent]]);
  for (const agent of extraAgents) {
    agents.set(agent.id, agent);
  }
  const client = {
    getMainChatOverview: vi.fn(async () => ({ requestId: "r_ov", overview, error: null })),
    updateMainChatSettings: vi.fn(async (patch) => ({
      settings: { ...createDefaultMainChatSettings(), ...patch },
      error: null,
    })),
    compactMainChat: vi.fn(async () => ({
      requestId: "r_cmp",
      mainAgentId: "agent_main",
      compaction: overview.compaction ?? null,
      error: null,
    })),
  } as unknown as DaemonClient;

  useSessionStore.setState({
    sessions: {
      srv_1: {
        agents,
        agentDetails: new Map(),
        pendingPermissions: new Map(),
        client,
        workspaces: new Map(),
        projects: [],
        serverInfo:
          options?.enableChatOutlineRail || options?.enableProvidersSnapshot
            ? {
                features: {
                  agentTimelinePromptIndex: options?.enableChatOutlineRail === true,
                  providersSnapshot: options?.enableProvidersSnapshot === true,
                },
              }
            : null,
      } as unknown as SessionState,
    },
  });
  useMainChatOverviewStore.setState({
    overviewsByKey: {
      [overviewStoreKey("srv_1", "agent_main")]: overview,
    },
    decisionsByKey: {},
  });
  useMainChatSettingsStore.setState({
    settingsByServerId: { srv_1: createDefaultMainChatSettings() },
  });
}

describe("Main Chat UX polish browser layout & style verification", () => {
  let root: Root;
  let host: HTMLDivElement;
  let queryClient: QueryClient;

  beforeEach(async () => {
    vi.stubGlobal("React", React);
    await i18n.changeLanguage("zh-CN");
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    host = document.createElement("div");
    host.style.width = "760px";
    host.style.padding = "12px";
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    act(() => root.unmount());
    host.remove();
    document.body.style.backgroundColor = "";
    UnistylesRuntime.setTheme("light");
    useSessionStore.setState({ sessions: {} });
    useMainChatOverviewStore.setState({ overviewsByKey: {}, decisionsByKey: {} });
    useMainChatSettingsStore.setState({ settingsByServerId: {} });
    useMainChatActionBarDrawerStore.getState().reset();
    useMainChatDrawerStore.getState().closeDrawer();
    useMainChatCameFromStore.getState().clearCameFrom();
    useMainChatQueueStore.setState({ queuesByAgentId: {} });
    vi.clearAllMocks();
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  function renderInBrowser(node: React.ReactElement): void {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastApiProvider api={toastApi}>
            <KeyboardActionDispatcherProvider>{node}</KeyboardActionDispatcherProvider>
          </ToastApiProvider>
        </QueryClientProvider>,
      );
    });
  }

  it("never wraps the riskyBadge ('需确认') vertically under long suggestion titles while truncating the label cleanly", () => {
    const longSuggestions: MainChatNextStepSuggestion[] = [
      {
        id: "risky_long_title",
        label: "将当前所有隔离分支统一合并到主分支并立即推送到远端仓库并打发版标签",
        prompt: "合并并推送",
        risky: true,
        reason: "涉及远端写入",
      },
      {
        id: "safe_short",
        label: "汇总当前进度",
        prompt: "汇总当前进度",
        risky: false,
      },
    ];
    seedMainChatSession(makeOverview({ nextStepSuggestions: longSuggestions }));

    renderInBrowser(
      <MainChatNextStepsBar
        serverId="srv_1"
        agentId="agent_main"
        suggestions={longSuggestions}
        onSendSafePrompt={vi.fn(async () => undefined)}
        onPrefillRiskyPrompt={vi.fn()}
      />,
    );

    const chip = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-next-step-risky_long_title"]',
    );
    const badge = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-next-step-risky-badge-risky_long_title"]',
    );
    expect(chip).toBeTruthy();
    expect(badge).toBeTruthy();
    expect(badge!.textContent?.trim()).toBe("需确认");

    // Real Chromium painted line count MUST be strictly 1 (no vertical char-by-char wrapping!).
    expect(countPaintedLines(badge!)).toBe(1);
    const badgeRect = badge!.getBoundingClientRect();
    expect(badgeRect.width).toBeGreaterThan(badgeRect.height);
    expect(badgeRect.height).toBeLessThanOrEqual(22);

    const badgeStyle = window.getComputedStyle(badge!);
    expect(badgeStyle.whiteSpace).toBe("nowrap");
    expect(badgeStyle.flexShrink).toBe("0");

    // Chip container stays within its 240px cap and single-line height.
    const chipRect = chip!.getBoundingClientRect();
    expect(chipRect.width).toBeLessThanOrEqual(241);
    expect(chipRect.height).toBeLessThanOrEqual(36);
  });

  it("positions MainChatComposerEnhancements directly above MainChatActionBar without overlapping its expanded drawer and renders full NeedsYou context", async () => {
    const blockedChild = makeAgent({
      id: "child_browser_1",
      serverId: "srv_1",
      title: "重构主对话压缩与托盘",
      cwd: "/repo/paseo-fork",
    });
    const overview = makeOverview({
      nextStepSuggestions: [
        {
          id: "safe_1",
          label: "汇总各任务最新进展",
          prompt: "请汇总进展",
          risky: false,
        },
      ],
      triages: [
        {
          agentId: "child_browser_1",
          workspaceId: "ws_repo",
          title: "重构主对话压缩与托盘",
          managedByMainChat: true,
          phase: "blocked_user",
          summary: "已完成前后端 4 处模块改造与单测",
          waitReason: "请确认是否同步更新《发布说明与变更文档清单》？",
          suggestedAction: "查看会话并确认下一步",
          triageSource: "rule",
          updatedAt: "2026-11-24T10:05:00.000Z",
        },
      ],
    });
    seedMainChatSession(overview, [blockedChild]);

    useMainChatActionBarDrawerStore.getState().reset();
    renderInBrowser(
      <View style={BROWSER_SHELL_STYLE}>
        <View style={BROWSER_STREAM_VIEWPORT_STYLE}>
          <MainChatActionBarDrawerOverlay serverId="srv_1" agentId="agent_main" />
        </View>
        <View>
          <MainChatComposerEnhancements serverId="srv_1" agentId="agent_main" />
          <MainChatActionBar serverId="srv_1" agentId="agent_main" drawerMode="external" />
          <View style={railTestStyles.simulatedComposerInner} testID="composer-anchor-box">
            <Text>Composer</Text>
          </View>
        </View>
      </View>,
    );

    const actionBarEl = host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar"]');
    const composerAnchorEl = host.querySelector<HTMLElement>('[data-testid="composer-anchor-box"]');
    expect(host.querySelector('[data-testid="main-chat-composer-enhancements"]')).toBeNull();
    expect(host.querySelector('[data-testid="main-chat-compact-dock"]')).toBeNull();
    expect(actionBarEl).toBeTruthy();
    expect(composerAnchorEl).toBeTruthy();

    const barRectBefore = actionBarEl!.getBoundingClientRect();
    const composerRectBefore = composerAnchorEl!.getBoundingClientRect();
    expect(barRectBefore.bottom).toBeLessThanOrEqual(composerRectBefore.top + 1);

    // Open NeedsYou drawer and confirm:
    // 1) Composer top stays anchored with 0px shift
    // 2) Floating overlay drawer renders cleanly above MainChatActionBar without overlap
    // 3) Structured Persona Ask Card renders question, detail, custom input, and Open entry
    const needsCapsule = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-capsule-needsYou"]',
    );
    expect(needsCapsule).toBeTruthy();
    act(() => {
      needsCapsule!.click();
    });

    const drawerEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-panel-needsYou"]',
    );
    expect(drawerEl).toBeTruthy();
    const composerRectAfter = composerAnchorEl!.getBoundingClientRect();
    const drawerRect = drawerEl!.getBoundingClientRect();
    expect(Math.abs(composerRectAfter.top - composerRectBefore.top)).toBeLessThanOrEqual(1);
    expect(drawerRect.bottom).toBeLessThanOrEqual(barRectBefore.top + 1);

    const questionEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-needs-ask-question-agent:srv_1:child_browser_1"]',
    );
    const detailEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-needs-ask-detail-agent:srv_1:child_browser_1"]',
    );
    await expect
      .poll(() => questionEl?.textContent)
      .toContain("请确认是否同步更新《发布说明与变更文档清单》？");
    await expect.poll(() => detailEl?.textContent).toContain("已完成前后端 4 处模块改造与单测");
  });

  it("renders MainChatCompactionBanner with real 1M window usage and side-by-side auto-compact toggle & compact button", () => {
    const overview = makeOverview({
      compaction: {
        status: "idle",
        estimatedTokens: 820_000,
        thresholdTokens: 800_000,
        contextWindowMaxTokens: 1_000_000,
        autoCompactEnabled: true,
        lastCompactedAt: null,
        lastError: null,
        summary: null,
      },
    });
    seedMainChatSession(overview);

    renderInBrowser(<MainChatCompactionBanner serverId="srv_1" mainAgentId="agent_main" />);

    const bannerEl = host.querySelector<HTMLElement>('[data-testid="main-chat-compaction-banner"]');
    const autoBtn = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-compaction-auto-toggle"]',
    );
    const compactBtn = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-compaction-action"]',
    );
    expect(bannerEl).toBeTruthy();
    expect(autoBtn).toBeTruthy();
    expect(compactBtn).toBeTruthy();
    expect(bannerEl!.textContent).toContain("82%");
    expect(bannerEl!.textContent).toContain("1M");

    // Both action buttons sit side-by-side on the same horizontal line without overlapping.
    const autoRect = autoBtn!.getBoundingClientRect();
    const compactRect = compactBtn!.getBoundingClientRect();
    expect(Math.abs(autoRect.top - compactRect.top)).toBeLessThanOrEqual(4);
    expect(autoRect.right).toBeLessThanOrEqual(compactRect.left + 1);
  });

  it("renders Claude { output: ... } wrapped task_plan card with visible task list and Start button in real Chromium", () => {
    seedMainChatSession(makeOverview());
    const planPayload = {
      output: [
        {
          type: "text",
          text: JSON.stringify({
            plan: {
              id: "plan_browser_claude",
              mainAgentId: "agent_main",
              status: "open",
              autoStarted: false,
              summary: "Claude 渠道计划卡恢复验证",
              createdAt: "2026-11-24T10:00:00.000Z",
              startedAt: null,
              cancelledAt: null,
              tasks: [
                {
                  id: "task_1",
                  title: "修复协议解包并恢复按钮",
                  goal: "恢复 Claude MCP 内联卡片渲染",
                  mode: "write",
                  isolation: "worktree",
                  workspaceId: "ws_repo",
                  cwd: "/repo/paseo-fork",
                  workspaceLabel: "paseo-fork",
                  reason: "需要完整展示任务列表",
                  doneWhen: ["开始执行按钮可见"],
                  outOfBounds: [],
                  provider: "claude",
                  modeId: null,
                  thinkingOptionId: null,
                  branchName: "feat/fix",
                  baseBranch: "main",
                  agentId: null,
                  startedAt: null,
                  startError: null,
                },
              ],
            },
          }),
        },
      ],
    };

    const card = renderMainChatInlineToolCard({
      serverId: "srv_1",
      agentId: "agent_main",
      toolName: "mcp__paseo__task_plan",
      toolStatus: "completed",
      toolInput: {},
      toolOutput: planPayload,
    });
    expect(card).toBeTruthy();
    renderInBrowser(card!);

    const cardEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-plan-card-plan_browser_claude"]',
    );
    const startBtn = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-plan-start-plan_browser_claude"]',
    );
    expect(cardEl).toBeTruthy();
    expect(startBtn).toBeTruthy();
    expect(cardEl!.textContent).toContain("修复协议解包并恢复按钮");
    expect(startBtn!.getBoundingClientRect().width).toBeGreaterThan(20);
    expect(startBtn!.getBoundingClientRect().height).toBeGreaterThan(20);
  });

  async function waitForLayoutFrame(): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }

  function expectAlignedToComposer(
    label: string,
    element: HTMLElement | null,
    composerRect: DOMRect,
  ): void {
    expect(element, `${label} must be rendered`).toBeTruthy();
    const rect = element!.getBoundingClientRect();
    expect(
      Math.abs(rect.left - composerRect.left),
      `${label} left (${rect.left}) should align with composer left (${composerRect.left})`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(rect.right - composerRect.right),
      `${label} right (${rect.right}) should align with composer right (${composerRect.right})`,
    ).toBeLessThanOrEqual(1);
  }

  function makeRailAlignmentOverview(): { overview: MainChatOverview; blockedChild: Agent } {
    const blockedChild = makeAgent({
      id: "child_browser_1",
      serverId: "srv_1",
      title: "修复底部 Rail 对齐与设置项",
      cwd: "/repo/paseo-fork",
    });
    const overview = makeOverview({
      nextStepSuggestions: [
        {
          id: "safe_summary",
          label: "汇总所有进行中任务最新进展",
          prompt: "请汇总进展",
          risky: false,
        },
        {
          id: "risky_deploy",
          label: "合并改动并触发发布流水线",
          prompt: "合并并发布",
          risky: true,
          reason: "涉及远端发布",
        },
      ],
      triages: [
        {
          agentId: "child_browser_1",
          workspaceId: "ws_repo",
          title: "修复底部 Rail 对齐与设置项",
          managedByMainChat: true,
          phase: "blocked_user",
          summary: "已完成底部各栏位外层 Rail 统一改造",
          waitReason: "请确认是否合并当前修改并继续验证？",
          suggestedAction: "查看差异并确认",
          triageSource: "rule",
          updatedAt: "2026-11-24T10:05:00.000Z",
        },
      ],
    });
    return { overview, blockedChild };
  }

  function renderRailAlignmentScene(drawerMode: "external" | "floating") {
    renderInBrowser(
      <View style={railTestStyles.surfaceRoot}>
        <ChatColumnRailSurface serverId="srv_1">
          <View style={railTestStyles.streamViewport}>
            {drawerMode === "external" ? (
              <MainChatActionBarDrawerOverlay serverId="srv_1" agentId="agent_main" />
            ) : null}
          </View>
          <View style={railTestStyles.bottomStack}>
            <MainChatComposerEnhancements serverId="srv_1" agentId="agent_main" />
            <MainChatActionBar serverId="srv_1" agentId="agent_main" drawerMode={drawerMode} />
            <MainChatRouteBanner target={RAIL_ALIGNMENT_ROUTE_TARGET} onClear={noopClearRoute} />
            <View style={railTestStyles.simulatedComposerOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
              <View
                style={railTestStyles.simulatedComposerInner}
                testID="simulated-composer-content"
              >
                <Text style={railTestStyles.simulatedComposerLabel}>
                  给主对话发消息…（模拟 Composer 对齐基准列）
                </Text>
              </View>
            </View>
          </View>
        </ChatColumnRailSurface>
      </View>,
    );
  }

  it("pixel-aligns all bottom Main Chat bars and drawer overlays with the Composer column on wide desktop (>=1200px) with active ChatColumnRailSurface", async () => {
    await page.viewport(1360, 860);
    host.style.width = "1280px";
    host.style.padding = "0px";
    host.style.margin = "0 auto";

    const { overview, blockedChild } = makeRailAlignmentOverview();
    seedMainChatSession(overview, [blockedChild], { enableChatOutlineRail: true });
    useMainChatQueueStore.getState().enqueue("agent_main", "先核验所有底部组件像素级对齐");
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "needsYou" },
      expandedByKey: {},
    });

    renderRailAlignmentScene("external");
    await waitForLayoutFrame();

    const activeSurface = host.querySelector<HTMLElement>('[data-chat-rail-active="true"]');
    expect(activeSurface).toBeTruthy();

    const composerEl = host.querySelector<HTMLElement>(
      '[data-testid="simulated-composer-content"]',
    );
    expect(composerEl).toBeTruthy();
    const composerRect = composerEl!.getBoundingClientRect();
    // On a 1280px wide surface with active rail, Composer column is centered well inside the pane.
    expect(composerRect.left).toBeGreaterThan(60);
    expect(composerRect.width).toBeGreaterThan(600);

    expectAlignedToComposer(
      "MainChatComposerEnhancements inner",
      host.querySelector<HTMLElement>('[data-testid="main-chat-composer-enhancements-inner"]'),
      composerRect,
    );
    expectAlignedToComposer(
      "MainChatQueuePanel card",
      host.querySelector<HTMLElement>('[data-testid="main-chat-queue-panel"]'),
      composerRect,
    );
    // Standalone floating + strip above the dock is gone (moved into Composer toolbar)
    expect(host.querySelector('[data-testid="main-chat-composer-attach-trigger"]')).toBeNull();

    expectAlignedToComposer(
      "MainChatActionBar inner",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-inner"]'),
      composerRect,
    );
    expectAlignedToComposer(
      "MainChatActionBarDrawerOverlay frame",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-drawer-frame"]'),
      composerRect,
    );
    expectAlignedToComposer(
      "MainChatActionBarDrawerOverlay panel",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-panel-needsYou"]'),
      composerRect,
    );
    expectAlignedToComposer(
      "MainChatRouteBanner",
      host.querySelector<HTMLElement>('[data-testid="main-chat-route-banner-child_browser_1"]'),
      composerRect,
    );

    if (SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/desktop-rail-aligned.png`,
      });
    }

    // Also verify floating drawerMode aligns floatingDrawerAnchor with the Composer column.
    renderRailAlignmentScene("floating");
    await waitForLayoutFrame();

    const composerFloatingRect = host
      .querySelector<HTMLElement>('[data-testid="simulated-composer-content"]')!
      .getBoundingClientRect();
    expectAlignedToComposer(
      "MainChatActionBar floatingDrawerAnchor frame",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-drawer-frame"]'),
      composerFloatingRect,
    );
  });

  it("pixel-aligns all bottom Main Chat bars and drawer overlay with the Composer column on narrow viewport (760px)", async () => {
    await page.viewport(820, 760);
    host.style.width = "760px";
    host.style.padding = "0px";

    const { overview, blockedChild } = makeRailAlignmentOverview();
    seedMainChatSession(overview, [blockedChild], { enableChatOutlineRail: true });
    useMainChatQueueStore.getState().enqueue("agent_main", "窄屏对齐核验消息");
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "needsYou" },
      expandedByKey: {},
    });

    renderRailAlignmentScene("external");
    await waitForLayoutFrame();

    expect(host.querySelector('[data-chat-rail-active="true"]')).toBeNull();

    const composerEl = host.querySelector<HTMLElement>(
      '[data-testid="simulated-composer-content"]',
    );
    expect(composerEl).toBeTruthy();
    const composerRect = composerEl!.getBoundingClientRect();
    expect(Math.abs(composerRect.width - (760 - 32))).toBeLessThanOrEqual(2);

    expectAlignedToComposer(
      "Narrow MainChatComposerEnhancements inner",
      host.querySelector<HTMLElement>('[data-testid="main-chat-composer-enhancements-inner"]'),
      composerRect,
    );
    expectAlignedToComposer(
      "Narrow MainChatQueuePanel card",
      host.querySelector<HTMLElement>('[data-testid="main-chat-queue-panel"]'),
      composerRect,
    );
    expect(host.querySelector('[data-testid="main-chat-composer-attach-trigger"]')).toBeNull();

    expectAlignedToComposer(
      "Narrow MainChatActionBar inner",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-inner"]'),
      composerRect,
    );
    expectAlignedToComposer(
      "Narrow MainChatActionBarDrawerOverlay frame",
      host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar-drawer-frame"]'),
      composerRect,
    );
    expectAlignedToComposer(
      "Narrow MainChatRouteBanner",
      host.querySelector<HTMLElement>('[data-testid="main-chat-route-banner-child_browser_1"]'),
      composerRect,
    );
  });

  it("renders MainChatFirstSetupView in Chromium with model, thinking intensity, and safety mode selectors linked to provider snapshot", async () => {
    await page.viewport(1280, 820);
    host.style.width = "100%";
    host.style.height = "720px";
    host.style.padding = "0px";

    const snapshotEntries: ProviderSnapshotEntry[] = [
      {
        provider: "claude",
        label: "Claude Code",
        enabled: true,
        status: "ready",
        defaultModeId: "acceptEdits",
        modes: [
          { id: "default", label: "Ask before editing", description: "执行写入和命令前先确认" },
          { id: "acceptEdits", label: "Edit automatically", description: "自动接受文件修改" },
          {
            id: "bypassPermissions",
            label: "Full access",
            description: "跳过权限确认直接执行",
          },
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
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
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
        label: "Minimal Local",
        enabled: true,
        status: "ready",
        modes: [],
        models: [
          {
            provider: "minimal",
            id: "local-fast",
            label: "Local Fast",
            isDefault: true,
          },
        ],
      },
    ];

    seedMainChatSession(makeOverview(), [], { enableProvidersSnapshot: true });
    queryClient.setQueryData(providersSnapshotQueryKey("srv_1", null), {
      entries: snapshotEntries,
      etag: "etag-1",
    });

    const onStart = vi.fn();
    renderInBrowser(
      <View style={railTestStyles.setupHost}>
        <MainChatFirstSetupView
          serverId="srv_1"
          title="主对话"
          starting={false}
          errorMessage={null}
          onStart={onStart}
          onOpenProviderSettings={vi.fn()}
        />
      </View>,
    );
    await waitForLayoutFrame();

    // Open CombinedModelSelector, pick provider "Claude Code", then pick "Claude Opus 5.5"
    const modelTrigger = host.querySelector<HTMLElement>('[data-testid="combined-model-selector"]');
    expect(modelTrigger).toBeTruthy();

    async function pickModelFromBrowser(providerLabel: string | null, modelLabel: string) {
      act(() => {
        modelTrigger!.click();
      });
      await waitForLayoutFrame();

      if (providerLabel) {
        const providerRow = Array.from(document.querySelectorAll<HTMLElement>("*")).find(
          (el) => el.childElementCount === 0 && el.textContent?.trim() === providerLabel,
        );
        if (providerRow) {
          act(() => {
            providerRow.click();
          });
          await waitForLayoutFrame();
        }
      }

      const modelOption = Array.from(document.querySelectorAll<HTMLElement>("*")).find(
        (el) => el.childElementCount === 0 && el.textContent?.trim() === modelLabel,
      );
      expect(modelOption, `Expected model option "${modelLabel}"`).toBeTruthy();
      act(() => {
        modelOption!.click();
      });
      await waitForLayoutFrame();
    }

    await pickModelFromBrowser("Claude Code", "Claude Opus 5.5");

    const thinkingTrigger = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-first-setup-thinking"]',
    );
    const modeTrigger = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-first-setup-mode"]',
    );
    expect(thinkingTrigger).toBeTruthy();
    expect(modeTrigger).toBeTruthy();
    expect(thinkingTrigger!.textContent).toContain("High");
    expect(modeTrigger!.textContent).toContain("Edit automatically");

    // Change thinking intensity to xhigh
    act(() => {
      thinkingTrigger!.click();
    });
    await waitForLayoutFrame();
    const xhighOption = document.querySelector<HTMLElement>(
      '[data-testid="main-chat-first-setup-thinking-option-xhigh"]',
    );
    expect(xhighOption).toBeTruthy();
    act(() => {
      xhighOption!.click();
    });
    await waitForLayoutFrame();

    // Change safety mode to bypassPermissions
    act(() => {
      modeTrigger!.click();
    });
    await waitForLayoutFrame();
    const fullAccessOption = document.querySelector<HTMLElement>(
      '[data-testid="main-chat-first-setup-mode-option-bypassPermissions"]',
    );
    expect(fullAccessOption).toBeTruthy();
    act(() => {
      fullAccessOption!.click();
    });
    await waitForLayoutFrame();

    expect(
      host.querySelector<HTMLElement>('[data-testid="main-chat-first-setup-mode"]')!.textContent,
    ).toContain("Full access");

    if (SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/first-setup-controls.png`,
      });
    }

    // Submit and verify thinkingOptionId + modeId are forwarded
    const startBtn = host.querySelector<HTMLElement>('[data-testid="main-chat-first-setup-start"]');
    expect(startBtn).toBeTruthy();
    act(() => {
      startBtn!.click();
    });
    expect(onStart).toHaveBeenCalledWith({
      provider: "claude",
      model: "claude-opus-5-5",
      thinkingOptionId: "xhigh",
      modeId: "bypassPermissions",
    });

    // Switch to model without thinkingOptions (same provider) -> thinking field hides cleanly
    await pickModelFromBrowser(null, "Claude Haiku Legacy");
    expect(host.querySelector('[data-testid="main-chat-first-setup-thinking-field"]')).toBeNull();
    expect(host.querySelector('[data-testid="main-chat-first-setup-mode-field"]')).toBeTruthy();

    // Switch to provider without modes -> both fields hide cleanly
    act(() => {
      modelTrigger!.click();
    });
    await waitForLayoutFrame();
    const backBtn = document.querySelector<HTMLElement>(
      '[aria-label*="Back"], [aria-label*="返回"]',
    );
    if (backBtn) {
      act(() => {
        backBtn.click();
      });
      await waitForLayoutFrame();
    }
    const minimalProvider = Array.from(document.querySelectorAll<HTMLElement>("*")).find(
      (el) => el.childElementCount === 0 && el.textContent?.trim() === "Minimal Local",
    );
    if (minimalProvider) {
      act(() => {
        minimalProvider.click();
      });
      await waitForLayoutFrame();
    }
    const minimalOption = Array.from(document.querySelectorAll<HTMLElement>("*")).find(
      (el) => el.childElementCount === 0 && el.textContent?.trim() === "Local Fast",
    );
    expect(minimalOption).toBeTruthy();
    act(() => {
      minimalOption!.click();
    });
    await waitForLayoutFrame();
    expect(host.querySelector('[data-testid="main-chat-first-setup-thinking-field"]')).toBeNull();
    expect(host.querySelector('[data-testid="main-chat-first-setup-mode-field"]')).toBeNull();
  });

  it("stretches all 5 inline Main Chat cards to 100% of an 860px conversation column (no 640px cap) with readable base typography", async () => {
    await page.viewport(1280, 960);
    host.style.width = "100%";
    host.style.padding = "0px";

    const runningChild = makeAgent({
      id: "child_running_1",
      serverId: "srv_1",
      title: "改造 5 类内联卡片宽度与阅读字号",
      status: "running",
      turn: {
        phase: "open",
        turnId: "turn_1",
        startedAt: new Date("2026-11-24T10:00:00.000Z"),
        cancellationRequestId: null,
      },
      cwd: "/repo/paseo-fork",
      workspaceId: "ws_repo",
    });
    seedMainChatSession(
      makeOverview({
        plans: [WIDE_STREAM_PLAN],
        decisions: [WIDE_STREAM_DECISION],
      }),
      [runningChild],
    );

    renderInBrowser(
      <View style={railTestStyles.streamSceneRoot}>
        <View style={railTestStyles.streamColumn860} testID="stream-column-860">
          <Text style={railTestStyles.streamBodyReference} testID="stream-body-reference">
            已按要求拆解本轮改造计划并启动首个子任务，请确认下方任务卡片与实时交接状态：
          </Text>
          <MainChatPlanCard serverId="srv_1" agentId="agent_main" plan={WIDE_STREAM_PLAN} />
          <MainChatHandoffCard
            serverId="srv_1"
            agentId="child_running_1"
            title="改造 5 类内联卡片宽度与阅读字号"
            workspaceId="ws_repo"
            workspaceLabel="paseo-fork"
            hostLabel="DevBox"
            mode="write"
            expectedMinutes={5}
          />
        </View>
      </View>,
    );
    await waitForLayoutFrame();

    const columnEl = host.querySelector<HTMLElement>('[data-testid="stream-column-860"]');
    const planCardEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-plan-card-plan_wide_860"]',
    );
    const handoffCardEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-handoff-card-child_running_1"]',
    );
    expect(columnEl).toBeTruthy();
    expect(planCardEl).toBeTruthy();
    expect(handoffCardEl).toBeTruthy();

    const colRect = columnEl!.getBoundingClientRect();
    expect(colRect.width).toBeGreaterThanOrEqual(858);

    const planRect = planCardEl!.getBoundingClientRect();
    expect(planRect.width).toBeGreaterThan(800);
    expect(Math.abs(planRect.left - colRect.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(planRect.right - colRect.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(planRect.width - colRect.width)).toBeLessThanOrEqual(1);

    const handoffRect = handoffCardEl!.getBoundingClientRect();
    expect(handoffRect.width).toBeGreaterThan(800);
    expect(Math.abs(handoffRect.left - colRect.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(handoffRect.right - colRect.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(handoffRect.width - colRect.width)).toBeLessThanOrEqual(1);

    // Verify upgraded readable typography (>= 14px primary text, >= 13px secondary metadata).
    const planGoalEl = Array.from(planCardEl!.querySelectorAll<HTMLElement>("*")).find(
      (el) =>
        el.childElementCount === 0 &&
        el.textContent?.includes("让计划卡、交接卡、决策卡、验收卡与返工卡 100% 撑满对话列宽"),
    );
    const handoffTitleEl = Array.from(handoffCardEl!.querySelectorAll<HTMLElement>("*")).find(
      (el) =>
        el.childElementCount === 0 && el.textContent?.trim() === "改造 5 类内联卡片宽度与阅读字号",
    );
    const handoffMetaEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-handoff-meta-child_running_1"]',
    );
    expect(planGoalEl).toBeTruthy();
    expect(handoffTitleEl).toBeTruthy();
    expect(handoffMetaEl).toBeTruthy();
    expect(parseFloat(window.getComputedStyle(planGoalEl!).fontSize)).toBeGreaterThanOrEqual(14);
    expect(parseFloat(window.getComputedStyle(handoffTitleEl!).fontSize)).toBeGreaterThanOrEqual(
      14,
    );
    expect(parseFloat(window.getComputedStyle(handoffMetaEl!).fontSize)).toBeGreaterThanOrEqual(13);

    if (SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/inline-cards-expanded.png`,
      });
    }

    // Also verify MainChatDecisionCard, MainChatReceiptCard, and MainChatReworkCard fill 100% of 860px.
    renderInBrowser(
      <View style={railTestStyles.streamSceneRoot}>
        <View style={railTestStyles.streamColumn860} testID="stream-column-860-others">
          <MainChatDecisionCard
            serverId="srv_1"
            agentId="agent_main"
            decision={WIDE_STREAM_DECISION}
            defaultExpanded
          />
          <MainChatReceiptCard
            serverId="srv_1"
            input={WIDE_STREAM_RECEIPT_INPUT}
            output={WIDE_STREAM_RECEIPT_OUTPUT}
            defaultExpanded
          />
          <MainChatReworkCard
            serverId="srv_1"
            input={WIDE_STREAM_REWORK_INPUT}
            output={WIDE_STREAM_REWORK_OUTPUT}
            defaultExpanded
          />
        </View>
      </View>,
    );
    await waitForLayoutFrame();

    const otherColRect = host
      .querySelector<HTMLElement>('[data-testid="stream-column-860-others"]')!
      .getBoundingClientRect();
    const decisionCardEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-decision-card-dec_wide_860"]',
    );
    const receiptCardEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-receipt-card-task_receipt_860"]',
    );
    const reworkCardEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-rework-card-child_running_1-1"]',
    );

    expectAlignedToComposer("DecisionCard (860px)", decisionCardEl, otherColRect);
    expectAlignedToComposer("ReceiptCard (860px)", receiptCardEl, otherColRect);
    expectAlignedToComposer("ReworkCard (860px)", reworkCardEl, otherColRect);
    expect(decisionCardEl!.getBoundingClientRect().width).toBeGreaterThan(800);
    expect(receiptCardEl!.getBoundingClientRect().width).toBeGreaterThan(800);
    expect(reworkCardEl!.getBoundingClientRect().width).toBeGreaterThan(800);

    const decisionOptionEl = Array.from(decisionCardEl!.querySelectorAll<HTMLElement>("*")).find(
      (el) =>
        el.childElementCount === 0 && el.textContent?.trim() === "采用 13px 搭配 19-20px 行高",
    );
    const receiptSummaryEl = Array.from(receiptCardEl!.querySelectorAll<HTMLElement>("*")).find(
      (el) =>
        el.childElementCount === 0 &&
        el.textContent?.includes("已完成 composer-enhancements、action-bar"),
    );
    const reworkGapEl = Array.from(reworkCardEl!.querySelectorAll<HTMLElement>("*")).find(
      (el) =>
        el.childElementCount === 0 &&
        el.textContent?.includes("移除 plan/handoff/decision/receipt/rework"),
    );
    expect(decisionOptionEl).toBeTruthy();
    expect(receiptSummaryEl).toBeTruthy();
    expect(reworkGapEl).toBeTruthy();
    expect(parseFloat(window.getComputedStyle(decisionOptionEl!).fontSize)).toBeGreaterThanOrEqual(
      14,
    );
    expect(parseFloat(window.getComputedStyle(receiptSummaryEl!).fontSize)).toBeGreaterThanOrEqual(
      14,
    );
    expect(parseFloat(window.getComputedStyle(reworkGapEl!).fontSize)).toBeGreaterThanOrEqual(14);
  });

  function seedSessionLinksAndCompactDockFixture() {
    const now = new Date("2026-11-24T10:15:00.000Z");
    const mainAgent = makeAgent({
      id: "agent_main",
      serverId: "srv_1",
      title: "主对话",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    const permChild = makeAgent({
      id: "ag_auth1234_full",
      serverId: "srv_1",
      title: "重构登录鉴权链路",
      status: "idle",
      requiresAttention: true,
      attentionReason: "permission",
      workspaceId: "ws_repo",
      cwd: "/repo/paseo-fork",
      updatedAt: now,
    });
    const runningChild1 = makeAgent({
      id: "ag_netw5678_unit",
      serverId: "srv_1",
      title: "补齐网络层单元测试",
      status: "running",
      turn: {
        phase: "open",
        turnId: "turn_net_1",
        startedAt: now,
        cancellationRequestId: null,
      },
      workspaceId: "ws_repo",
      cwd: "/repo/paseo-fork",
      updatedAt: now,
    });
    const runningChild2 = makeAgent({
      id: "ag_perf4321_query",
      serverId: "srv_1",
      title: "排查 /orders 接口慢查询",
      status: "running",
      turn: {
        phase: "open",
        turnId: "turn_perf_1",
        startedAt: now,
        cancellationRequestId: null,
      },
      workspaceId: "ws_repo",
      cwd: "/repo/paseo-fork",
      updatedAt: new Date("2026-11-24T10:12:00.000Z"),
    });
    const failedChild = makeAgent({
      id: "ag_fail9999_err",
      serverId: "srv_1",
      title: "设置页按钮对齐修复",
      status: "error",
      workspaceId: "ws_repo",
      cwd: "/repo/paseo-fork",
      updatedAt: new Date("2026-11-24T10:08:00.000Z"),
    });
    const remoteChild = makeAgent({
      id: "ag_gpu98765_eval",
      serverId: "srv_gpu",
      title: "跨机模型评测回归",
      status: "running",
      turn: {
        phase: "open",
        turnId: "turn_gpu_1",
        startedAt: now,
        cancellationRequestId: null,
      },
      workspaceId: "ws_gpu",
      cwd: "/srv/eval-suite",
      updatedAt: new Date("2026-11-24T10:14:00.000Z"),
    });

    const overview = makeOverview({
      decisions: [
        {
          id: "dec_cache_01",
          mainAgentId: "agent_main",
          taskId: null,
          title: "缓存层选型拍板",
          question: "生产环境会话快照缓存优先走内存 LRU 还是本地 SQLite 持久化？",
          options: [
            { id: "lru", label: "内存 LRU + 定期落盘（推荐）", recommended: true },
            { id: "sqlite", label: "纯 SQLite 同步落盘" },
          ],
          createdAt: "2026-11-24T10:13:00.000Z",
          answeredAt: null,
        } as unknown as MainChatDecisionRecord,
      ],
      plans: [
        {
          ...WIDE_STREAM_PLAN,
          id: "plan_heic_01",
          summary: "同步脚本支持 HEIC 照片转换与 EXIF 保留",
          createdAt: "2026-11-24T10:10:00.000Z",
        },
      ],
      tasks: [
        {
          id: "task_run_net",
          mainAgentId: "agent_main",
          planId: "plan_exec_1",
          serverId: "srv_1",
          workspaceId: "ws_repo",
          hostLabel: "DevBox",
          cwd: "/repo/paseo-fork",
          title: "补齐网络层单元测试",
          status: "running",
          activeAgentId: "ag_netw5678_unit",
          agentIds: ["ag_netw5678_unit"],
          brief: {
            goal: "补齐重试与超时边界单测",
            mode: "write",
            isolation: "worktree",
            doneWhen: ["vitest 全绿"],
            outOfBounds: [],
            scopeRevision: 1,
          },
          lastSummary: "正在补充超时重连与断网重放用例",
          createdAt: "2026-11-24T10:00:00.000Z",
          updatedAt: "2026-11-24T10:15:00.000Z",
          lastActivityAt: "2026-11-24T10:15:00.000Z",
          completedAt: null,
          supersededByTaskId: null,
          parkedReason: null,
        },
        {
          id: "task_run_perf",
          mainAgentId: "agent_main",
          planId: "plan_exec_1",
          serverId: "srv_1",
          workspaceId: "ws_repo",
          hostLabel: "DevBox",
          cwd: "/repo/paseo-fork",
          title: "排查 /orders 接口慢查询",
          status: "running",
          activeAgentId: "ag_perf4321_query",
          agentIds: ["ag_perf4321_query"],
          brief: {
            goal: "消除订单列表 N+1 查询",
            mode: "write",
            isolation: "worktree",
            doneWhen: ["P95 < 80ms"],
            outOfBounds: [],
            scopeRevision: 1,
          },
          lastSummary: "已定位订单明细 N+1，正在改成单次 JOIN",
          createdAt: "2026-11-24T09:50:00.000Z",
          updatedAt: "2026-11-24T10:12:00.000Z",
          lastActivityAt: "2026-11-24T10:12:00.000Z",
          completedAt: null,
          supersededByTaskId: null,
          parkedReason: null,
        },
        {
          id: "task_fail_ui",
          mainAgentId: "agent_main",
          planId: "plan_exec_1",
          serverId: "srv_1",
          workspaceId: "ws_repo",
          hostLabel: "DevBox",
          cwd: "/repo/paseo-fork",
          title: "设置页按钮对齐修复",
          status: "failed",
          activeAgentId: "ag_fail9999_err",
          agentIds: ["ag_fail9999_err"],
          brief: {
            goal: "对齐设置页底部操作按钮",
            mode: "write",
            isolation: "worktree",
            doneWhen: ["按钮对齐"],
            outOfBounds: [],
            scopeRevision: 1,
          },
          lastSummary: "rpc: connection closed",
          createdAt: "2026-11-24T09:40:00.000Z",
          updatedAt: "2026-11-24T10:08:00.000Z",
          lastActivityAt: "2026-11-24T10:08:00.000Z",
          completedAt: null,
          supersededByTaskId: null,
          parkedReason: null,
        },
      ] as unknown as MainChatOverview["tasks"],
    });

    const client = {
      getMainChatOverview: vi.fn(async () => ({ requestId: "r_ov", overview, error: null })),
      respondToPermission: vi.fn(async () => undefined),
    } as unknown as DaemonClient;

    const pendingPermissions = new Map([
      [
        "perm_auth_1",
        {
          key: "perm_auth_1",
          agentId: "ag_auth1234_full",
          request: {
            id: "req_auth_1",
            name: "Bash",
            title: "运行鉴权集成测试",
            description: "npm test --workspace=@getpaseo/server -- auth",
            kind: "tool",
          },
        },
      ],
    ]);

    useSessionStore.setState({
      sessions: {
        srv_1: {
          serverId: "srv_1",
          hasHydratedAgents: true,
          agents: new Map([
            [mainAgent.id, mainAgent],
            [permChild.id, permChild],
            [runningChild1.id, runningChild1],
            [runningChild2.id, runningChild2],
            [failedChild.id, failedChild],
          ]),
          agentDetails: new Map(),
          pendingPermissions,
          client,
          workspaces: new Map([
            [
              "ws_repo",
              {
                id: "ws_repo",
                projectDisplayName: "paseo-fork",
                workspaceDirectory: "/repo/paseo-fork",
              },
            ],
          ]),
          projects: [],
          serverInfo: {
            hostname: "DevBox",
            features: {
              agentTimelinePromptIndex: true,
              providersSnapshot: false,
            },
          },
        } as unknown as SessionState,
        srv_gpu: {
          serverId: "srv_gpu",
          hasHydratedAgents: true,
          agents: new Map([[remoteChild.id, remoteChild]]),
          agentDetails: new Map(),
          pendingPermissions: new Map(),
          client: null,
          workspaces: new Map([
            [
              "ws_gpu",
              {
                id: "ws_gpu",
                projectDisplayName: "eval-suite",
                workspaceDirectory: "/srv/eval-suite",
              },
            ],
          ]),
          projects: [],
          serverInfo: {
            hostname: "GPU-Node",
            features: {
              agentTimelinePromptIndex: false,
              providersSnapshot: false,
            },
          },
        } as unknown as SessionState,
      },
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_1", "agent_main")]: overview,
      },
      decisionsByKey: {},
    });
    useMainChatSettingsStore.setState({
      settingsByServerId: { srv_1: createDefaultMainChatSettings() },
    });
  }

  function renderSessionLinksAndDockScene(height: number) {
    const assistantReportMarkdown = [
      "当前全机态势已同步，以下会话可直接点击标题进入查看：",
      "",
      "- **等你处理**：[重构登录鉴权链路](paseo://agent/srv_1/ag_auth1234_full) 等待审批运行集成测试；另有「缓存层选型拍板」待你确认。",
      "- **正在执行**：[补齐网络层单元测试](paseo://agent/srv_1/ag_netw5678)（8 位短 ID 直达）与远端 [跨机模型评测回归](paseo://agent/ag_gpu98765_eval) 正常运行中。",
      "- **历史归档**：[已清理的旧会话](paseo://agent/srv_1/ag_missing_0000) 已不在当前活跃列表中。",
    ].join("\n");

    const rootHeightStyle =
      height === 844 ? railTestStyles.surfaceRoot844 : railTestStyles.surfaceRoot880;

    renderInBrowser(
      <MainChatShellProvider value={SESSION_LINK_SHELL_CONTEXT_VALUE}>
        <View style={rootHeightStyle}>
          <ChatColumnRailSurface serverId="srv_1">
            <View style={railTestStyles.streamViewport}>
              <View style={railTestStyles.messageOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
                <View style={railTestStyles.messageInner} testID="session-links-message-column">
                  <MarkdownRenderer text={assistantReportMarkdown} />
                </View>
              </View>
              <MainChatActionBarDrawerOverlay serverId="srv_1" agentId="agent_main" />
            </View>
            <View style={railTestStyles.bottomStack}>
              <MainChatActionBar serverId="srv_1" agentId="agent_main" drawerMode="external" />
              <View
                style={railTestStyles.simulatedComposerOuter}
                dataSet={CHAT_COLUMN_RAIL_DATASET}
              >
                <View
                  style={railTestStyles.simulatedComposerInner}
                  testID="simulated-composer-content"
                >
                  <Text style={railTestStyles.simulatedComposerLabel}>
                    给主对话发消息…（按 Enter 发送）
                  </Text>
                </View>
              </View>
            </View>
          </ChatColumnRailSurface>
        </View>
      </MainChatShellProvider>,
    );
  }

  it("verifies wide 1440x900 session links, 2-row compact dock <=96px, Persona layered drawers, Esc dismiss, pixel alignment <=1px, and 0px empty collapse", async () => {
    await page.viewport(1440, 900);
    host.style.width = "100%";
    host.style.padding = "0px";
    host.style.margin = "0";

    seedSessionLinksAndCompactDockFixture();
    useMainChatActionBarDrawerStore.getState().reset();

    renderSessionLinksAndDockScene(880);
    await waitForLayoutFrame();

    expect(host.querySelector('[data-chat-rail-active="true"]')).toBeTruthy();

    const composerEl = host.querySelector<HTMLElement>(
      '[data-testid="simulated-composer-content"]',
    );
    const actionBarInnerEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-inner"]',
    );
    expect(composerEl).toBeTruthy();
    expect(host.querySelector('[data-testid="main-chat-compact-dock"]')).toBeNull();
    expect(actionBarInnerEl).toBeTruthy();

    const composerRectBefore = composerEl!.getBoundingClientRect();

    // Pixel-level left/right alignment <= 1px against Composer
    expectAlignedToComposer("Wide ActionBar inner", actionBarInnerEl, composerRectBefore);

    // Screenshot 1: wide message session links + 2-row compact dock
    if (SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/01-wide-session-links-compact-dock.png`,
      });
    }

    // Session links inside MarkdownRenderer: restrained styling, in-app href, modifier pass-through, wide drawer open, 0-hit toast
    const sessionLinks = host.querySelectorAll<HTMLAnchorElement>('a[data-session-link="true"]');
    expect(sessionLinks.length).toBe(4);
    const exactLink = sessionLinks[0]!;
    const prefixLink = sessionLinks[1]!;
    const crossHostLink = sessionLinks[2]!;
    const missingLink = sessionLinks[3]!;

    expect(exactLink.childElementCount).toBe(0);
    expect(exactLink.getAttribute("href")).not.toContain("paseo://");
    expect(exactLink.getAttribute("href")).toContain("/h/srv_1/workspace/ws_repo");
    expect(prefixLink.getAttribute("data-session-link-status")).toBe("prefix");
    expect(crossHostLink.getAttribute("href")).toContain("/h/srv_gpu/workspace/ws_gpu");
    expect(missingLink.getAttribute("href")).not.toContain("paseo://");
    expect(window.getComputedStyle(exactLink).textUnderlineOffset).toBe("3px");
    expect(exactLink.style.textDecorationColor).toContain("0.38");

    // Modifier Cmd-click is NOT intercepted by the link component (passes through to browser)
    let modifierPreventedByLink: boolean | null = null;
    const stopIframeNav = (event: MouseEvent) => {
      modifierPreventedByLink = event.defaultPrevented;
      event.preventDefault();
    };
    host.addEventListener("click", stopIframeNav);
    const cmdClick = new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true });
    act(() => {
      exactLink.dispatchEvent(cmdClick);
    });
    host.removeEventListener("click", stopIframeNav);
    expect(modifierPreventedByLink).toBe(false);
    expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();

    // Plain click opens right-hand TaskPanelDrawer on wide screens (never navigates full-page)
    const plainClick = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      exactLink.dispatchEvent(plainClick);
    });
    expect(plainClick.defaultPrevented).toBe(true);
    expect(useMainChatDrawerStore.getState().activeTarget?.agentId).toBe("ag_auth1234_full");
    expect(navigateToAgentMock).not.toHaveBeenCalled();

    // 8-char prefix click resolves and opens right drawer
    act(() => {
      prefixLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(useMainChatDrawerStore.getState().activeTarget?.agentId).toBe("ag_netw5678_unit");

    // 0-hit link shows non-blocking error toast without navigating
    act(() => {
      missingLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(toastErrorMock).toHaveBeenCalledTimes(1);

    // Open Needs you drawer: compact dock hides, capsule inverts, Composer top shift === 0px, alignment <= 1px
    const needsCapsule = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-capsule-needsYou"]',
    )!;
    const unselectedBg = window.getComputedStyle(needsCapsule).backgroundColor;
    act(() => {
      needsCapsule.click();
    });
    await waitForLayoutFrame();

    expect(host.querySelector('[data-testid="main-chat-compact-dock"]')).toBeNull();
    expect(needsCapsule.getAttribute("data-selected")).toBe("true");
    expect(window.getComputedStyle(needsCapsule).backgroundColor).not.toBe(unselectedBg);

    const needsDrawerPanel = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-panel-needsYou"]',
    );
    const drawerFrameEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-drawer-frame"]',
    );
    expect(needsDrawerPanel).toBeTruthy();
    const composerRectDuringNeeds = composerEl!.getBoundingClientRect();
    expect(Math.abs(composerRectDuringNeeds.top - composerRectBefore.top)).toBeLessThanOrEqual(1);
    expectAlignedToComposer("Wide NeedsYou drawer frame", drawerFrameEl, composerRectDuringNeeds);
    expectAlignedToComposer(
      "Wide NeedsYou drawer panel",
      needsDrawerPanel,
      composerRectDuringNeeds,
    );

    // Screenshot 2: wide Needs you Persona soft-block drawer
    if (SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/02-wide-needs-you-drawer.png`,
      });
    }

    // Switch to In progress drawer: flat list with hairline dividers, Composer top shift === 0px
    const inProgressCapsule = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-capsule-inProgress"]',
    )!;
    act(() => {
      inProgressCapsule.click();
    });
    await waitForLayoutFrame();

    expect(inProgressCapsule.getAttribute("data-selected")).toBe("true");
    expect(needsCapsule.getAttribute("data-selected")).toBe("false");
    const inProgressPanel = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-panel-inProgress"]',
    );
    expect(inProgressPanel).toBeTruthy();
    const composerRectDuringInProgress = composerEl!.getBoundingClientRect();
    expect(Math.abs(composerRectDuringInProgress.top - composerRectBefore.top)).toBeLessThanOrEqual(
      1,
    );
    expectAlignedToComposer(
      "Wide InProgress drawer panel",
      inProgressPanel,
      composerRectDuringInProgress,
    );

    const inProgressRows = inProgressPanel!.querySelectorAll<HTMLElement>(
      '[data-testid^="main-chat-action-task-inProgress-"]',
    );
    expect(inProgressRows.length).toBeGreaterThanOrEqual(2);
    expect(window.getComputedStyle(inProgressRows[0]!).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(window.getComputedStyle(inProgressRows[1]!).borderTopWidth).toBe("1px");

    // Screenshot 3: wide In progress flat hairline-divider drawer
    if (SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/03-wide-in-progress-drawer.png`,
      });
    }

    // Escape closes the drawer on Web while keeping clean capsule bar (no CompactStatusDock)
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitForLayoutFrame();
    expect(host.querySelector('[data-testid="main-chat-action-panel-inProgress"]')).toBeNull();
    expect(host.querySelector('[data-testid="main-chat-compact-dock"]')).toBeNull();

    // Empty state: MainChatActionBar collapses to 0px height (unmounts cleanly)
    seedMainChatSession(makeOverview(), []);
    renderSessionLinksAndDockScene(880);
    await waitForLayoutFrame();
    expect(host.querySelector('[data-testid="main-chat-action-bar"]')).toBeNull();
    expect(host.querySelector('[data-testid="main-chat-compact-dock"]')).toBeNull();
  });

  it("verifies narrow 390x844 clean capsule dock, alignment <=1px, Composer 0px shift, and full-page navigation with CameFrom", async () => {
    await page.viewport(390, 844);
    host.style.width = "390px";
    host.style.padding = "0px";
    host.style.margin = "0";

    seedSessionLinksAndCompactDockFixture();
    useMainChatActionBarDrawerStore.getState().reset();
    useMainChatDrawerStore.getState().closeDrawer();
    useMainChatCameFromStore.getState().clearCameFrom();
    navigateToAgentMock.mockClear();

    renderSessionLinksAndDockScene(844);
    await waitForLayoutFrame();

    const composerEl = host.querySelector<HTMLElement>(
      '[data-testid="simulated-composer-content"]',
    )!;
    const actionBarInnerEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-bar-inner"]',
    )!;
    expect(host.querySelector('[data-testid="main-chat-compact-dock"]')).toBeNull();

    const composerRectBefore = composerEl.getBoundingClientRect();
    expectAlignedToComposer("Narrow 390 ActionBar inner", actionBarInnerEl, composerRectBefore);

    // Screenshot 4: narrow 390x844 1-row compact dock state
    if (SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/04-narrow-390-compact-dock.png`,
      });
    }

    // Open Needs you drawer on narrow screen: Composer top shift <= 1px and drawer aligned <= 1px
    const needsCapsule = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-capsule-needsYou"]',
    )!;
    act(() => {
      needsCapsule.click();
    });
    await waitForLayoutFrame();
    const drawerPanel = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-panel-needsYou"]',
    )!;
    expect(drawerPanel).toBeTruthy();
    const composerRectAfter = composerEl.getBoundingClientRect();
    expect(Math.abs(composerRectAfter.top - composerRectBefore.top)).toBeLessThanOrEqual(1);
    expectAlignedToComposer("Narrow 390 NeedsYou drawer", drawerPanel, composerRectAfter);

    // Close drawer before clicking message link
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    await waitForLayoutFrame();

    // Clicking a session link on narrow 390px navigates full-page and records CameFrom (no right drawer)
    const exactLink = host.querySelector<HTMLAnchorElement>('a[data-session-link="true"]')!;
    act(() => {
      exactLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(useMainChatDrawerStore.getState().activeTarget).toBeNull();
    expect(navigateToAgentMock).toHaveBeenCalledWith({
      serverId: "srv_1",
      agentId: "ag_auth1234_full",
      workspaceId: "ws_repo",
    });
    expect(useMainChatCameFromStore.getState().entry?.targetAgentId).toBe("ag_auth1234_full");
  });

  it("renders dark theme wide layout with session links, inverted capsule, and Persona NeedsYou drawer", async () => {
    await page.viewport(1440, 900);
    host.style.width = "100%";
    host.style.padding = "0px";
    host.style.margin = "0";
    document.body.style.backgroundColor = "#0a0a0a";
    UnistylesRuntime.setTheme("dark");

    seedSessionLinksAndCompactDockFixture();
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: { [overviewStoreKey("srv_1", "agent_main")]: "needsYou" },
      expandedByKey: {},
      compactDockCollapsedByKey: {},
      focusedNeedsIdByKey: {},
    });

    renderSessionLinksAndDockScene(880);
    await waitForLayoutFrame();

    const composerEl = host.querySelector<HTMLElement>(
      '[data-testid="simulated-composer-content"]',
    )!;
    const needsPanel = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-panel-needsYou"]',
    )!;
    const needsCapsule = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-capsule-needsYou"]',
    )!;
    expect(needsPanel).toBeTruthy();
    expect(needsCapsule.getAttribute("data-selected")).toBe("true");
    expectAlignedToComposer(
      "Dark NeedsYou drawer panel",
      needsPanel,
      composerEl.getBoundingClientRect(),
    );

    // Screenshot 5: dark theme wide state
    if (SCREENSHOT_DIR) {
      await page.screenshot({
        path: `${SCREENSHOT_DIR}/05-wide-dark-theme.png`,
      });
    }
  });
});

const railTestStyles = StyleSheet.create((theme) => ({
  streamSceneRoot: {
    width: "100%",
    alignItems: "center",
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
    backgroundColor: theme.colors.surface0,
  },
  streamColumn860: {
    width: 860,
    gap: theme.spacing[3],
  },
  streamBodyReference: {
    fontSize: theme.fontSize.content,
    lineHeight: 22,
    color: theme.colors.foreground,
  },
  surfaceRoot: {
    width: "100%",
    height: 680,
    backgroundColor: theme.colors.surface0,
  },
  surfaceRoot880: {
    width: "100%",
    height: 880,
    backgroundColor: theme.colors.surface0,
  },
  surfaceRoot844: {
    width: "100%",
    height: 844,
    backgroundColor: theme.colors.surface0,
  },
  streamViewport: {
    flex: 1,
    position: "relative",
    minHeight: 0,
  },
  messageOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[6],
  },
  messageInner: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    gap: theme.spacing[2],
  },
  bottomStack: {
    width: "100%",
    paddingBottom: theme.spacing[3],
  },
  simulatedComposerOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  simulatedComposerInner: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    minHeight: 72,
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    justifyContent: "center",
  },
  simulatedComposerLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  setupHost: {
    width: "100%",
    height: 680,
    backgroundColor: theme.colors.surface0,
  },
}));
