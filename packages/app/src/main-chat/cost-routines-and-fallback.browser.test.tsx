import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  mergeMainChatSettings,
  type MainChatCacheKeepaliveStatus,
  type MainChatConversationRecord,
  type MainChatLimitFallbackEvent,
  type MainChatRoutineRecord,
  type MainChatSettings,
  type MainChatSettingsPatch,
  type MainChatSettingsProposalRecord,
} from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, useCallback, useMemo, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { collapseTurns } from "@/agent-stream/turn-collapse/model";
import { TurnSummaryLine } from "@/agent-stream/turn-collapse/summary-line";
import { CHAT_COLUMN_RAIL_DATASET, ChatColumnRailSurface } from "@/chat-rail";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatCostControlPanel } from "@/screens/settings/main-chat/cost-control-panel";
import { MainChatLimitFallbacksPanel } from "@/screens/settings/main-chat/limit-fallbacks-panel";
import { MainChatRoutinesPanel } from "@/screens/settings/main-chat/routines-panel";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { useMainChatConversationsStore } from "./conversations-store";
import { useMainChatOverviewStore } from "./overview-store";
import { useMainChatSettingsStore } from "./settings-store";
import { renderMainChatInlineToolCard } from "./stream-card";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const browserToastApi = { show: vi.fn(), copied: vi.fn(), error: vi.fn(), dismiss: vi.fn() };

const SCREENSHOT_DIR =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_MAIN_CHAT_SCREENSHOT_DIR || "/tmp/main-chat-017526-screenshots";

function makeFixtureConversations(): MainChatConversationRecord[] {
  const now = "2026-11-25T02:00:00.000Z";
  return [
    {
      id: "conv_dir_cost",
      kind: "leader",
      agentId: "agent_dir_cost",
      workspaceId: "ws_main",
      title: "成本与缓存治理",
      directionSummary: "监控主对话上下文压缩窗口、Prompt Cache 保活与限额自动回退",
      notes: "- 压缩窗口封顶默认 400k，允许在设置中设为无上限\n- 限额自动切换严禁波及手动会话",
      parentConversationId: "conv_main",
      serverId: "srv_1",
      archivedAt: null,
      pinnedAsLeaderAt: now,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    },
  ];
}

function makeFixtureRoutines(): MainChatRoutineRecord[] {
  return [
    {
      id: "rt_morning_brief",
      name: "工作日晨间巡检简报",
      kind: "recurring",
      status: "active",
      cadence: { type: "cron", expression: "0 9 * * 1-5" },
      ownerKind: "main",
      conversationId: "conv_main",
      conversationTitle: "总控主对话",
      targetAgentId: "agent_main",
      prompt: "巡检昨晚所有后台任务、构建状态与未决审批项；无阻塞则回复 [SILENT]。",
      maxRuns: null,
      runCount: 14,
      nextRunAt: "2026-11-26T01:00:00.000Z",
      lastRunAt: "2026-11-25T01:00:00.000Z",
      pausedAt: null,
      expiresAt: null,
      lastRunStatus: "succeeded",
      lastRunOutput: null,
      lastRunError: null,
      createdAt: "2026-11-01T01:00:00.000Z",
      updatedAt: "2026-11-25T01:00:00.000Z",
    },
    {
      id: "rt_release_reminder",
      name: "Wave 2 验收复查提醒",
      kind: "one_shot",
      status: "active",
      cadence: { type: "every", everyMs: 3_600_000 },
      ownerKind: "leader",
      conversationId: "conv_dir_cost",
      conversationTitle: "成本与缓存治理",
      targetAgentId: "agent_dir_cost",
      prompt: "检查 Wave 2 真实 Chromium 截图与四包构建门禁是否全部通过。",
      maxRuns: 1,
      runCount: 0,
      nextRunAt: "2026-11-25T03:30:00.000Z",
      lastRunAt: null,
      pausedAt: null,
      expiresAt: null,
      lastRunStatus: null,
      lastRunOutput: null,
      lastRunError: null,
      createdAt: "2026-11-25T02:00:00.000Z",
      updatedAt: "2026-11-25T02:00:00.000Z",
    },
  ];
}

function makeFixtureKeepaliveStatus(): MainChatCacheKeepaliveStatus {
  return {
    enabled: true,
    activeTargets: 2,
    intervalMinutes: 4,
    maxRequests: 12,
    pingsSentTotal: 5,
    lastPingAt: "2026-11-25T02:12:00.000Z",
    lastYieldReason: null,
  };
}

function makeFixtureFallbackEvents(): MainChatLimitFallbackEvent[] {
  return [
    {
      id: "lfb_evt_1",
      createdAt: "2026-11-25T01:48:00.000Z",
      agentId: "agent_main",
      agentRole: "main",
      fromProvider: "claude",
      fromModel: "claude-opus-4-5",
      toProvider: "claude",
      toModel: "claude-sonnet-4-5",
      reason: "HTTP 429 rate limit exceeded",
    },
    {
      id: "lfb_evt_2",
      createdAt: "2026-11-25T01:55:00.000Z",
      agentId: "agent_task_7",
      agentRole: "managed_task",
      fromProvider: "claude",
      fromModel: "claude-sonnet-4-5",
      toProvider: "codex",
      toModel: "gpt-5.4",
      reason: "Usage quota reached",
    },
  ];
}

function makeFixtureSettingsProposal(
  overrides: Partial<MainChatSettingsProposalRecord> = {},
): MainChatSettingsProposalRecord {
  return {
    id: "prop_w2_live",
    mainAgentId: "agent_main",
    status: "pending",
    title: "收紧上下文压缩上限并开启缓存保活",
    reason:
      "当前主对话上下文已接近 380k tokens，建议将压缩窗口封顶调整为 320k 并开启 4 分钟 Prompt Cache 定时保活以降低重复输入成本。",
    patch: {
      compaction: { windowCapTokens: 320_000, idlePrecompactMinIdleMin: 12 },
      cacheKeepalive: { enabled: true, intervalMinutes: 4, maxRequests: 12 },
    },
    changes: [
      {
        key: "compaction.windowCapTokens",
        label: "上下文压缩窗口上限",
        beforeDisplay: "400k tokens",
        afterDisplay: "320k tokens",
      },
      {
        key: "compaction.idlePrecompactMinIdleMin",
        label: "空闲预压缩等待时长",
        beforeDisplay: "10 分钟",
        afterDisplay: "12 分钟",
      },
      {
        key: "cacheKeepalive.enabled",
        label: "Prompt Cache 定时保活",
        beforeDisplay: "关闭",
        afterDisplay: "开启（每 4 分钟 · 最多 12 次）",
      },
    ],
    createdAt: "2026-11-25T02:15:00.000Z",
    resolvedAt: null,
    resolvedNote: null,
    ...overrides,
  };
}

function makeFixtureClient(initialSettings: MainChatSettings): {
  client: DaemonClient;
  resolveMock: ReturnType<typeof vi.fn>;
} {
  let routines = makeFixtureRoutines();
  const resolveMock = vi.fn(
    async (input: { proposalId: string; decision: "approve" | "reject" }) => {
      const base = makeFixtureSettingsProposal({ id: input.proposalId });
      const resolved: MainChatSettingsProposalRecord = {
        ...base,
        status: input.decision === "approve" ? "approved" : "rejected",
        resolvedAt: "2026-11-25T02:18:00.000Z",
      };
      const nextSettings =
        input.decision === "approve"
          ? mergeMainChatSettings(initialSettings, base.patch)
          : undefined;
      return {
        requestId: "req_resolve_prop",
        proposal: resolved,
        settings: nextSettings,
        error: null,
      };
    },
  );

  const client = {
    listMainChatRoutines: vi.fn(async () => ({
      requestId: "req_rt_list",
      routines: [...routines],
      error: null,
    })),
    createMainChatRoutine: vi.fn(async (input) => {
      const created: MainChatRoutineRecord = {
        id: `rt_${routines.length + 1}`,
        name: input.name,
        prompt: input.prompt,
        kind: input.kind ?? "recurring",
        cadence: input.cadence ?? { type: "every", everyMs: 1_800_000 },
        status: "active",
        ownerKind: input.conversationId && input.conversationId !== "conv_main" ? "leader" : "main",
        conversationId: input.conversationId ?? "conv_main",
        conversationTitle: "总控主对话",
        targetAgentId: "agent_main",
        maxRuns: input.kind === "one_shot" ? 1 : null,
        runCount: 0,
        nextRunAt: "2026-11-25T03:00:00.000Z",
        lastRunAt: null,
        pausedAt: null,
        expiresAt: null,
        lastRunStatus: null,
        lastRunOutput: null,
        lastRunError: null,
        createdAt: "2026-11-25T02:20:00.000Z",
        updatedAt: "2026-11-25T02:20:00.000Z",
      };
      routines = [created, ...routines];
      return { requestId: "req_rt_create", routine: created, error: null };
    }),
    pauseMainChatRoutine: vi.fn(async (id: string) => {
      routines = routines.map((r) => (r.id === id ? { ...r, status: "paused" as const } : r));
      return {
        requestId: "req_rt_pause",
        routine: routines.find((r) => r.id === id) ?? null,
        error: null,
      };
    }),
    resumeMainChatRoutine: vi.fn(async (id: string) => {
      routines = routines.map((r) => (r.id === id ? { ...r, status: "active" as const } : r));
      return {
        requestId: "req_rt_resume",
        routine: routines.find((r) => r.id === id) ?? null,
        error: null,
      };
    }),
    runMainChatRoutineOnce: vi.fn(async (id: string) => {
      routines = routines.map((r) => (r.id === id ? { ...r, runCount: r.runCount + 1 } : r));
      return {
        requestId: "req_rt_run",
        routine: routines.find((r) => r.id === id) ?? null,
        error: null,
      };
    }),
    deleteMainChatRoutine: vi.fn(async (id: string) => {
      routines = routines.filter((r) => r.id !== id);
      return { requestId: "req_rt_del", deleted: true, error: null };
    }),
    resolveMainChatSettingsProposal: resolveMock,
    getMainChatOverview: vi.fn(async () => ({
      requestId: "req_ov",
      overview: null,
      error: null,
    })),
  } as unknown as DaemonClient;

  return { client, resolveMock };
}

function buildWave2StreamTimeline(proposal: MainChatSettingsProposalRecord): StreamItem[] {
  const t1 = new Date("2026-11-25T02:05:00.000Z");
  const t2 = new Date("2026-11-25T02:10:00.000Z");
  const t3 = new Date("2026-11-25T02:15:00.000Z");
  return [
    {
      kind: "tool_call",
      id: "bg_compact_host",
      timestamp: t1,
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          error: null,
          callId: "bg_compact_host",
          name: "main_chat_background_trigger",
          status: "completed",
          detail: {
            type: "plain_text",
            text: "空闲预压缩完成：已使用原生 /compact 压缩上下文（有效窗口上限 400k tokens，当前释放约 62% 上下文占用）。",
          },
          metadata: {
            mainChatBackground: {
              foldable: true,
              kind: "compaction",
              trigger: "idle_precompact",
              label: "空闲预压缩完成 · 400k 上限（释放 62% 上下文）",
            },
          },
        },
      },
    },
    {
      kind: "assistant_message",
      id: "bg_compact_silent_reply",
      timestamp: t1,
      text: "[SILENT]",
    },
    {
      kind: "tool_call",
      id: "bg_routine_host",
      timestamp: t2,
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          error: null,
          callId: "bg_routine_host",
          name: "main_chat_background_trigger",
          status: "completed",
          detail: {
            type: "plain_text",
            text: "例行任务「工作日晨间巡检简报」触发，已完成后台任务与构建状态核验。",
          },
          metadata: {
            mainChatBackground: {
              foldable: true,
              kind: "routine",
              trigger: "routine:rt_morning_brief",
              label: "例行任务 · 工作日晨间巡检简报",
            },
          },
        },
      },
    },
    {
      kind: "assistant_message",
      id: "bg_routine_reply",
      timestamp: t2,
      text: "晨间巡检完成：protocol / client / server 构建绿色，未发现阻塞任务。",
    },
    {
      kind: "user_message",
      id: "user_ask_settings",
      timestamp: t3,
      text: "帮我把压缩窗口封顶改成 320k，并打开 Prompt Cache 定时保活，先给我确认再改。",
    },
    {
      kind: "tool_call",
      id: "tool_settings_propose_1",
      timestamp: t3,
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          error: null,
          callId: "tool_settings_propose_1",
          name: "mcp__paseo__settings_propose_patch",
          status: "completed",
          detail: {
            type: "unknown",
            input: { patch: proposal.patch },
            output: { proposal },
          },
        },
      },
    },
  ];
}

function InteractiveWave2Stream({
  proposal,
  initialExpandedHostIds = [],
  compact = false,
}: {
  proposal: MainChatSettingsProposalRecord;
  initialExpandedHostIds?: string[];
  compact?: boolean;
}): ReactElement {
  const [expandedHostIds, setExpandedHostIds] = useState<ReadonlySet<string>>(
    () => new Set(initialExpandedHostIds),
  );
  const items = useMemo(() => buildWave2StreamTimeline(proposal), [proposal]);
  const collapsed = useMemo(
    () =>
      collapseTurns({
        tail: items,
        isLatestTurnOpen: false,
        expandedHostIds,
        getGroupedCalls: () => undefined,
        previousSummaryRowsByHostId: new Map(),
        collapseNormalTurns: true,
        collapseBackgroundTurns: true,
      }),
    [expandedHostIds, items],
  );

  const handleExpandedChange = useCallback((hostId: string, expanded: boolean) => {
    setExpandedHostIds((prev) => {
      const next = new Set(prev);
      if (expanded) next.add(hostId);
      else next.delete(hostId);
      return next;
    });
  }, []);

  return (
    <View
      style={compact ? sceneStyles.streamSurfaceCompact : sceneStyles.streamSurface}
      testID="wave2-stream-surface"
    >
      <ChatColumnRailSurface serverId="srv_1">
        <View style={compact ? sceneStyles.streamViewportCompact : sceneStyles.streamViewport}>
          <View style={sceneStyles.railOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
            <View style={sceneStyles.railInner} testID="wave2-message-column">
              {collapsed.tail.map((item) => {
                const isNested = collapsed.nestedItemIds.has(item.id);
                if (item.kind === "turn_summary") {
                  return (
                    <View key={item.id} style={sceneStyles.rowFullWidth}>
                      <TurnSummaryLine item={item} onExpandedChange={handleExpandedChange} />
                    </View>
                  );
                }
                if (item.kind === "user_message") {
                  return (
                    <View
                      key={item.id}
                      style={sceneStyles.userBubble}
                      testID={`stream-msg-${item.id}`}
                    >
                      <Text style={sceneStyles.userBubbleText}>{item.text}</Text>
                    </View>
                  );
                }
                if (item.kind === "assistant_message") {
                  return (
                    <View
                      key={item.id}
                      style={sceneStyles.assistantRow}
                      testID={`stream-msg-${item.id}`}
                    >
                      <Text style={sceneStyles.assistantText}>{item.text}</Text>
                    </View>
                  );
                }
                if (item.kind === "tool_call" && item.payload.source === "agent") {
                  const detail = item.payload.data.detail;
                  const inlineCard = renderMainChatInlineToolCard({
                    serverId: "srv_1",
                    agentId: "agent_main",
                    toolName: item.payload.data.name,
                    toolStatus: item.payload.data.status,
                    toolInput: detail.type === "unknown" ? detail.input : undefined,
                    toolOutput: detail.type === "unknown" ? detail.output : undefined,
                  });
                  if (inlineCard) {
                    return (
                      <View key={item.id} style={sceneStyles.rowFullWidth}>
                        {inlineCard}
                      </View>
                    );
                  }
                  const detailText = detail.type === "plain_text" ? (detail.text ?? "") : "";
                  return (
                    <View
                      key={item.id}
                      style={[
                        sceneStyles.expandedDetailRow,
                        isNested ? sceneStyles.nestedIndentRow : null,
                      ]}
                      testID={`expanded-detail-${item.id}`}
                    >
                      <Text style={sceneStyles.expandedDetailTitle}>{item.payload.data.name}</Text>
                      <Text style={sceneStyles.expandedDetailBody}>{detailText}</Text>
                    </View>
                  );
                }
                return null;
              })}
            </View>
          </View>
        </View>
        <View style={sceneStyles.composerStack}>
          <View style={sceneStyles.railOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
            <View style={sceneStyles.composerCard} testID="wave2-composer-baseline">
              <Text style={sceneStyles.composerPlaceholder}>
                给主对话发消息…（Enter 发送，配置修改需经审批卡确认）
              </Text>
            </View>
          </View>
        </View>
      </ChatColumnRailSurface>
    </View>
  );
}

function InteractiveWave2Settings({
  client,
  initialSettings,
  keepaliveStatus,
  recentFallbackEvents,
  twoColumn = false,
  compact = false,
}: {
  client: DaemonClient;
  initialSettings: MainChatSettings;
  keepaliveStatus: MainChatCacheKeepaliveStatus;
  recentFallbackEvents: readonly MainChatLimitFallbackEvent[];
  twoColumn?: boolean;
  compact?: boolean;
}): ReactElement {
  const [settings, setSettings] = useState<MainChatSettings>(initialSettings);

  const handleApplyPatch = useCallback((patch: MainChatSettingsPatch) => {
    setSettings((prev) => mergeMainChatSettings(prev, patch));
  }, []);

  const costSection = (
    <SettingsSection
      title="上下文压缩与缓存保活"
      info="控制主对话上下文压缩窗口封顶、空闲预压缩等待时间，以及 Prompt Cache 定时保活策略。"
      testID="settings-main-chat-cost-control"
    >
      <MainChatCostControlPanel
        serverId="srv_1"
        settings={settings}
        cacheKeepaliveStatus={keepaliveStatus}
        disabled={false}
        onApplyPatch={handleApplyPatch}
      />
    </SettingsSection>
  );

  const fallbacksSection = (
    <SettingsSection
      title="限额自动切备用模型（Fallback）"
      info="主对话或受控子任务命中 rate limit / quota 限额时按顺序防环自动切换备用模型；手动会话严禁自动切换。"
      testID="settings-main-chat-limit-fallbacks"
    >
      <MainChatLimitFallbacksPanel
        serverId="srv_1"
        settings={settings}
        recentEvents={recentFallbackEvents}
        disabled={false}
        onApplyPatch={handleApplyPatch}
      />
    </SettingsSection>
  );

  const routinesSection = (
    <SettingsSection
      title="定时例行任务（Routines）"
      info="复用 Paseo Schedule / Heartbeat 触发周期巡检与一次性提醒，结果收敛在后台折叠流。"
      testID="settings-main-chat-routines"
    >
      <MainChatRoutinesPanel serverId="srv_1" client={client} disabled={false} />
    </SettingsSection>
  );

  if (twoColumn) {
    return (
      <View style={sceneStyles.wideTwoColSettings} testID="wave2-settings-container">
        <View style={sceneStyles.wideLeftCol}>{costSection}</View>
        <View style={sceneStyles.wideRightCol}>
          {routinesSection}
          {fallbacksSection}
        </View>
      </View>
    );
  }

  return (
    <View
      style={compact ? sceneStyles.compactSettingsStack : sceneStyles.settingsPage}
      testID="wave2-settings-container"
    >
      {compact ? null : costSection}
      {fallbacksSection}
      {compact ? null : routinesSection}
    </View>
  );
}

describe("Wave 2 (P0-3 / P0-4 / P0-5) real Chromium visual & layout verification", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fixtureSettings: MainChatSettings;
  let fixtureClient: DaemonClient;
  let resolveProposalMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    UnistylesRuntime.setTheme("light");
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    document.body.style.margin = "0";
    document.body.style.padding = "0";
    host = document.createElement("div");
    host.style.width = "100%";
    host.style.boxSizing = "border-box";
    document.body.appendChild(host);
    root = createRoot(host);

    fixtureSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      enabled: true,
      compaction: {
        windowCapTokens: 400_000,
        idlePrecompactMinIdleMin: 10,
      },
      cacheKeepalive: {
        enabled: true,
        intervalMinutes: 4,
        maxRequests: 12,
      },
      limitFallbacks: [
        { provider: "claude", model: "claude-sonnet-4-5", label: "Claude Sonnet 4.5（首选备机）" },
        { provider: "codex", model: "gpt-5.4", label: "Codex GPT-5.4（跨厂商备机）" },
      ],
    });

    const fixture = makeFixtureClient(fixtureSettings);
    fixtureClient = fixture.client;
    resolveProposalMock = fixture.resolveMock;

    const now = new Date("2026-11-25T02:00:00.000Z");
    const mainAgent = {
      id: "agent_main",
      serverId: "srv_1",
      workspaceId: "ws_main",
      provider: "claude",
      status: "idle",
      lifecycle: "idle",
      cwd: "/home/dev/.paseo/main-chat",
      title: "总控主对话",
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
      archivedAt: null,
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
      pendingPermissions: [],
      availableModes: [],
      currentModeId: null,
      turn: { phase: "idle", turnId: null, startedAt: null },
      background: false,
      internal: false,
    } as unknown as Agent;

    useSessionStore.setState({
      sessions: {
        srv_1: {
          serverId: "srv_1",
          client: fixtureClient,
          agents: new Map([[mainAgent.id, mainAgent]]),
          agentDetails: new Map([[mainAgent.id, mainAgent]]),
          pendingPermissions: new Map(),
          workspaces: new Map(),
          serverInfo: {
            features: {
              mainChat: true,
              agentTimelinePromptIndex: true,
            },
          },
        } as unknown as SessionState,
      },
    });

    useMainChatSettingsStore
      .getState()
      .hydrateSettings("srv_1", fixtureSettings, undefined, makeFixtureKeepaliveStatus());
    useMainChatOverviewStore.setState({
      overviewsByKey: {},
      decisionsByKey: {},
      settingsProposalsByKey: {},
    });
    useMainChatConversationsStore.setState({
      conversationsByServerId: { srv_1: makeFixtureConversations() },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    host.remove();
    UnistylesRuntime.setTheme("light");
    document.body.style.backgroundColor = "";
  });

  function renderInBrowser(element: ReactElement): void {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastApiProvider api={browserToastApi}>
            <KeyboardActionDispatcherProvider>{element}</KeyboardActionDispatcherProvider>
          </ToastApiProvider>
        </QueryClientProvider>,
      );
    });
  }

  async function waitForLayoutFrame(): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    });
  }

  function assertNoHorizontalOverflow(container: HTMLElement, label: string): void {
    expect(
      container.scrollWidth,
      `${label} must not horizontally overflow (scrollWidth=${container.scrollWidth}, clientWidth=${container.clientWidth})`,
    ).toBeLessThanOrEqual(container.clientWidth + 1);
    const containerRect = container.getBoundingClientRect();
    const interactive = container.querySelectorAll<HTMLElement>(
      "input, textarea, button, [role='button'], [role='switch']",
    );
    for (const el of interactive) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      expect(
        rect.right,
        `${label} child ${el.getAttribute("data-testid") ?? el.tagName} right (${rect.right}) exceeds container right (${containerRect.right})`,
      ).toBeLessThanOrEqual(containerRect.right + 1);
    }
  }

  function assertEdgeAligned(label: string, target: HTMLElement | null, baseline: DOMRect): void {
    expect(target, `${label} must exist`).toBeTruthy();
    const rect = target!.getBoundingClientRect();
    expect(
      Math.abs(rect.left - baseline.left),
      `${label} left (${rect.left}) must align with baseline (${baseline.left}) within 1px`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(rect.right - baseline.right),
      `${label} right (${rect.right}) must align with baseline (${baseline.right}) within 1px`,
    ).toBeLessThanOrEqual(1);
    expect(rect.width).toBeGreaterThan(200);
  }

  it("01: renders wide 1440x900 light settings showing Cost Control, Limit Fallbacks, and Routines panels cleanly", async () => {
    await page.viewport(1440, 900);

    renderInBrowser(
      <View style={sceneStyles.wideSettingsShell} testID="wave2-wide-settings-shell">
        <InteractiveWave2Settings
          client={fixtureClient}
          initialSettings={fixtureSettings}
          keepaliveStatus={makeFixtureKeepaliveStatus()}
          recentFallbackEvents={makeFixtureFallbackEvents()}
          twoColumn
        />
      </View>,
    );
    await waitForLayoutFrame();

    expect(host.querySelector('[data-testid="main-chat-cost-control-panel"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="cost-control-cap-unit"]')?.textContent).toBe(
      "k tokens",
    );
    expect(host.querySelector('[data-testid="main-chat-limit-fallbacks-panel"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="main-chat-routines-panel"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="routine-row-rt_morning_brief"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="limit-fallback-row-0"]')).toBeTruthy();

    const container = host.querySelector<HTMLElement>('[data-testid="wave2-settings-container"]')!;
    assertNoHorizontalOverflow(container, "Wide 1440x900 Wave 2 Settings");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-wide-settings-cost-routines.png`,
    });
  });

  it("02: renders wide 1440x900 light stream with compaction fold bar + native Settings Proposal Card aligned <= 1px to Composer rail", async () => {
    await page.viewport(1440, 900);
    const proposal = makeFixtureSettingsProposal();

    renderInBrowser(<InteractiveWave2Stream proposal={proposal} />);
    await waitForLayoutFrame();

    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="wave2-composer-baseline"]')!
      .getBoundingClientRect();
    const messageColumnBaseline = host
      .querySelector<HTMLElement>('[data-testid="wave2-message-column"]')!
      .getBoundingClientRect();

    const compactBar = host.querySelector<HTMLElement>(
      '[data-testid="background-turn-summary-bg_compact_host"]',
    );
    const routineBar = host.querySelector<HTMLElement>(
      '[data-testid="background-turn-summary-bg_routine_host"]',
    );
    const proposalCard = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-settings-proposal-card-prop_w2_live"]',
    );

    // Verify <= 1px alignment against BOTH Composer rail and message stream column
    assertEdgeAligned("Wide Compaction single-line bar vs Composer", compactBar, composerBaseline);
    assertEdgeAligned(
      "Wide Compaction single-line bar vs Stream",
      compactBar,
      messageColumnBaseline,
    );
    assertEdgeAligned("Wide Routine fold bar vs Composer", routineBar, composerBaseline);
    assertEdgeAligned("Wide Settings Proposal Card vs Composer", proposalCard, composerBaseline);
    assertEdgeAligned("Wide Settings Proposal Card vs Stream", proposalCard, messageColumnBaseline);

    const streamSurface = host.querySelector<HTMLElement>('[data-testid="wave2-stream-surface"]')!;
    assertNoHorizontalOverflow(streamSurface, "Wide 1440x900 Wave 2 Stream");

    // Capture clean screenshot with collapsed single-line compaction bar + expanded pending approval card
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-wide-stream-settings-approval-and-compact.png`,
    });

    // Verify clicking compaction bar expands in place and stays <= 1px aligned
    act(() => {
      compactBar!.click();
    });
    await waitForLayoutFrame();
    expect(compactBar!.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[data-testid="expanded-detail-bg_compact_host"]')).toBeTruthy();
    assertEdgeAligned(
      "Expanded compaction detail vs Composer",
      host.querySelector<HTMLElement>('[data-testid="expanded-detail-bg_compact_host"]'),
      composerBaseline,
    );

    // Verify clicking Approve on Settings Proposal Card calls RPC and updates store
    const approveBtn = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-settings-proposal-approve-prop_w2_live"]',
    );
    expect(approveBtn).toBeTruthy();
    act(() => {
      approveBtn!.click();
    });
    await waitForLayoutFrame();
    expect(resolveProposalMock).toHaveBeenCalledWith({
      proposalId: "prop_w2_live",
      decision: "approve",
    });
    expect(
      useMainChatSettingsStore.getState().settingsByServerId.srv_1?.compaction?.windowCapTokens,
    ).toBe(320_000);
  });

  it("03: renders narrow 390x844 mobile viewport with zero overflow and <= 1px rail alignment", async () => {
    await page.viewport(390, 844);
    const proposal = makeFixtureSettingsProposal({
      id: "prop_w2_narrow",
      reason: "收紧上下文压缩上限并开启 4 分钟 Prompt Cache 定时保活。",
      changes: [
        {
          key: "compaction.windowCapTokens",
          label: "上下文压缩窗口上限",
          beforeDisplay: "400k tokens",
          afterDisplay: "320k tokens",
        },
        {
          key: "cacheKeepalive.enabled",
          label: "Prompt Cache 定时保活",
          beforeDisplay: "关闭",
          afterDisplay: "开启（4 分钟）",
        },
      ],
    });

    renderInBrowser(
      <View style={sceneStyles.narrowStack} testID="wave2-narrow-root">
        <View style={sceneStyles.narrowStreamBox}>
          <InteractiveWave2Stream proposal={proposal} compact />
        </View>
        <InteractiveWave2Settings
          client={fixtureClient}
          initialSettings={fixtureSettings}
          keepaliveStatus={makeFixtureKeepaliveStatus()}
          recentFallbackEvents={makeFixtureFallbackEvents().slice(0, 1)}
          compact
        />
      </View>,
    );
    await waitForLayoutFrame();

    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="wave2-composer-baseline"]')!
      .getBoundingClientRect();
    const compactBar = host.querySelector<HTMLElement>(
      '[data-testid="background-turn-summary-bg_compact_host"]',
    );
    const proposalCard = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-settings-proposal-card-prop_w2_narrow"]',
    );

    assertEdgeAligned("Narrow 390px Compaction bar vs Composer", compactBar, composerBaseline);
    assertEdgeAligned(
      "Narrow 390px Settings Proposal Card vs Composer",
      proposalCard,
      composerBaseline,
    );

    const narrowRoot = host.querySelector<HTMLElement>('[data-testid="wave2-narrow-root"]')!;
    assertNoHorizontalOverflow(narrowRoot, "Narrow 390x844 Wave 2 Root");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-narrow-390-wave2.png`,
    });
  });

  it("04: renders wide 1440x900 dark theme showing aligned stream approval card + compaction bar + Cost/Fallback panels", async () => {
    await page.viewport(1440, 900);
    UnistylesRuntime.setTheme("dark");
    document.body.style.backgroundColor = "#18181b";

    const proposal = makeFixtureSettingsProposal({ id: "prop_w2_dark" });

    renderInBrowser(
      <View style={sceneStyles.darkShowcaseGrid} testID="wave2-dark-root">
        <View style={sceneStyles.darkStreamPane}>
          <InteractiveWave2Stream proposal={proposal} />
        </View>
        <View style={sceneStyles.darkSettingsPane} testID="wave2-dark-settings-pane">
          <SettingsSection
            title="上下文压缩与缓存保活"
            testID="settings-main-chat-cost-control-dark"
          >
            <MainChatCostControlPanel
              serverId="srv_1"
              settings={fixtureSettings}
              cacheKeepaliveStatus={makeFixtureKeepaliveStatus()}
              disabled={false}
              onApplyPatch={vi.fn()}
            />
          </SettingsSection>
          <SettingsSection
            title="限额自动切备用模型（Fallback）"
            testID="settings-main-chat-limit-fallbacks-dark"
          >
            <MainChatLimitFallbacksPanel
              serverId="srv_1"
              settings={fixtureSettings}
              recentEvents={makeFixtureFallbackEvents().slice(0, 1)}
              disabled={false}
              onApplyPatch={vi.fn()}
            />
          </SettingsSection>
        </View>
      </View>,
    );
    await waitForLayoutFrame();

    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="wave2-composer-baseline"]')!
      .getBoundingClientRect();
    const compactBar = host.querySelector<HTMLElement>(
      '[data-testid="background-turn-summary-bg_compact_host"]',
    );
    const proposalCard = host.querySelector<HTMLElement>(
      '[data-testid="main-chat-settings-proposal-card-prop_w2_dark"]',
    );

    assertEdgeAligned("Dark theme Compaction bar vs Composer", compactBar, composerBaseline);
    assertEdgeAligned(
      "Dark theme Settings Proposal Card vs Composer",
      proposalCard,
      composerBaseline,
    );

    const darkSettingsPane = host.querySelector<HTMLElement>(
      '[data-testid="wave2-dark-settings-pane"]',
    )!;
    assertNoHorizontalOverflow(darkSettingsPane, "Dark theme Wave 2 Settings Pane");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-wide-dark-wave2.png`,
    });
  });
});

const sceneStyles = StyleSheet.create((theme) => ({
  wideSettingsShell: {
    width: "100%",
    minHeight: 900,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[4],
    alignItems: "center",
  },
  wideTwoColSettings: {
    width: "100%",
    maxWidth: 1340,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[6],
  },
  wideLeftCol: {
    width: 630,
    flexShrink: 0,
    gap: theme.spacing[2],
  },
  wideRightCol: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  settingsPage: {
    width: "100%",
    maxWidth: 780,
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  compactSettingsStack: {
    width: "100%",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  streamSurface: {
    width: "100%",
    minHeight: 820,
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  streamSurfaceCompact: {
    width: "100%",
    backgroundColor: theme.colors.surface0,
  },
  streamViewport: {
    flex: 1,
    paddingTop: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  streamViewportCompact: {
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  railOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
  },
  railInner: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    gap: theme.spacing[3],
  },
  rowFullWidth: {
    width: "100%",
    minWidth: 0,
  },
  userBubble: {
    alignSelf: "flex-end",
    maxWidth: "85%",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  userBubbleText: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  assistantRow: {
    width: "100%",
    paddingVertical: theme.spacing[1],
  },
  assistantText: {
    fontSize: theme.fontSize.base,
    lineHeight: 22,
    color: theme.colors.foreground,
  },
  expandedDetailRow: {
    width: "100%",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: 2,
  },
  nestedIndentRow: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.borderAccent,
  },
  expandedDetailTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  expandedDetailBody: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 19,
  },
  composerStack: {
    width: "100%",
    paddingBottom: theme.spacing[4],
  },
  composerCard: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    minHeight: 62,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    justifyContent: "center",
  },
  composerPlaceholder: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  narrowStack: {
    width: "100%",
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[4],
  },
  narrowStreamBox: {
    width: "100%",
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
  },
  darkShowcaseGrid: {
    width: "100%",
    minHeight: 900,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[6],
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
  },
  darkStreamPane: {
    flex: 1,
    minWidth: 0,
    minHeight: 840,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
  },
  darkSettingsPane: {
    width: 580,
    flexShrink: 0,
    gap: theme.spacing[1],
  },
}));
