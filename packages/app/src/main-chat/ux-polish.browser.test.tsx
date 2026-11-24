import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  type MainChatNextStepSuggestion,
  type MainChatOverview,
} from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import {
  MainChatActionBar,
  MainChatActionBarDrawerOverlay,
  useMainChatActionBarDrawerStore,
} from "./action-bar";
import { MainChatCompactionBanner } from "./compaction-banner";
import { MainChatComposerEnhancements } from "./composer-enhancements";
import { MainChatNextStepsBar } from "./next-steps-bar";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { useMainChatSettingsStore } from "./settings-store";
import { renderMainChatInlineToolCard } from "./stream-card";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const BROWSER_SHELL_STYLE = { height: 520, flexDirection: "column" as const };
const BROWSER_STREAM_VIEWPORT_STYLE = { flex: 1, position: "relative" as const };

const toastApi: ComponentProps<typeof ToastApiProvider>["api"] = {
  show: () => () => undefined,
  error: () => () => undefined,
  copied: () => () => undefined,
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

function seedMainChatSession(overview: MainChatOverview, extraAgents: Agent[] = []): void {
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
        workspaces: [],
        projects: [],
        serverInfo: null,
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
    useSessionStore.setState({ sessions: {} });
    useMainChatOverviewStore.setState({ overviewsByKey: {}, decisionsByKey: {} });
    useMainChatSettingsStore.setState({ settingsByServerId: {} });
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  function renderInBrowser(node: React.ReactElement): void {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastApiProvider api={toastApi}>{node}</ToastApiProvider>
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

  it("positions MainChatComposerEnhancements directly above MainChatActionBar without overlapping its expanded drawer and renders full NeedsYou context", () => {
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

    useMainChatActionBarDrawerStore.setState({ openBucketByKey: {}, expandedByKey: {} });
    renderInBrowser(
      <View style={BROWSER_SHELL_STYLE}>
        <View style={BROWSER_STREAM_VIEWPORT_STYLE}>
          <MainChatActionBarDrawerOverlay serverId="srv_1" agentId="agent_main" />
        </View>
        <View>
          <MainChatComposerEnhancements serverId="srv_1" agentId="agent_main" />
          <MainChatActionBar serverId="srv_1" agentId="agent_main" drawerMode="external" />
        </View>
      </View>,
    );

    const enhancementsEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-composer-enhancements"]',
    );
    const actionBarEl = host.querySelector<HTMLElement>('[data-testid="main-chat-action-bar"]');
    expect(enhancementsEl).toBeTruthy();
    expect(actionBarEl).toBeTruthy();

    const enhRectBefore = enhancementsEl!.getBoundingClientRect();
    const barRectBefore = actionBarEl!.getBoundingClientRect();
    expect(enhRectBefore.bottom).toBeLessThanOrEqual(barRectBefore.top + 1);

    // Open NeedsYou drawer and confirm the floating overlay drawer renders cleanly above
    // MainChatComposerEnhancements with zero overlap and zero layout shift.
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
    const enhRectAfter = enhancementsEl!.getBoundingClientRect();
    const barRectAfter = actionBarEl!.getBoundingClientRect();
    const drawerRect = drawerEl!.getBoundingClientRect();
    expect(Math.abs(enhRectAfter.top - enhRectBefore.top)).toBeLessThanOrEqual(1);
    expect(Math.abs(barRectAfter.top - barRectBefore.top)).toBeLessThanOrEqual(1);
    expect(drawerRect.bottom).toBeLessThanOrEqual(enhRectAfter.top + 1);

    const questionEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-needs-question-agent:srv_1:child_browser_1"]',
    );
    const summaryEl = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-action-needs-summary-agent:srv_1:child_browser_1"]',
    );
    expect(questionEl?.textContent).toContain("请确认是否同步更新《发布说明与变更文档清单》？");
    expect(summaryEl?.textContent).toContain("已完成前后端 4 处模块改造与单测");
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
});
