// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
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
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collapseTurns } from "@/agent-stream/turn-collapse/model";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import {
  MainChatCostControlPanel,
  parseCustomCompactionCapTokens,
} from "@/screens/settings/main-chat/cost-control-panel";
import { MainChatLimitFallbacksPanel } from "@/screens/settings/main-chat/limit-fallbacks-panel";
import { MainChatRoutinesPanel } from "@/screens/settings/main-chat/routines-panel";
import { useSessionStore, type SessionState } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { useMainChatConversationsStore } from "./conversations-store";
import { useMainChatOverviewStore } from "./overview-store";
import { useMainChatSettingsStore } from "./settings-store";
import { renderMainChatInlineToolCard } from "./stream-card";

const stableTranslate = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key;
const stableI18n = { language: "zh-CN" };

vi.mock("react-i18next", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-i18next")>();
  return {
    ...actual,
    useTranslation: () => ({
      t: stableTranslate,
      i18n: stableI18n,
    }),
  };
});

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    disabled,
    onValueChange,
    testID,
  }: {
    value: boolean;
    disabled?: boolean;
    onValueChange?: (next: boolean) => void;
    testID?: string;
  }) =>
    React.createElement("input", {
      type: "checkbox",
      checked: value,
      disabled,
      "data-testid": testID,
      onChange: () => onValueChange?.(!value),
    }),
}));

vi.mock("@/constants/layout", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/constants/layout")>();
  return {
    ...actual,
    useIsCompactFormFactor: () => false,
  };
});

vi.mock("@/hooks/use-shortcut-keys", () => ({
  useShortcutKeys: () => null,
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    entries: [],
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    refetch: vi.fn(),
  }),
  providersSnapshotQueryKey: () => ["providers"],
}));

const toastApi = {
  show: vi.fn(),
  copied: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
};

function wrap(node: React.ReactElement): React.ReactElement {
  return (
    <ToastApiProvider api={toastApi}>
      <KeyboardActionDispatcherProvider>{node}</KeyboardActionDispatcherProvider>
    </ToastApiProvider>
  );
}

function makeProposal(
  overrides: Partial<MainChatSettingsProposalRecord> = {},
): MainChatSettingsProposalRecord {
  return {
    id: "prop_w2_1",
    mainAgentId: "agent_main",
    status: "pending",
    title: "调整压缩窗口上限并开启缓存保活",
    reason: "长对话上下文已接近 400k 阈值，建议收紧压缩窗口并在短空闲期内保活 Prompt Cache",
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
        key: "cacheKeepalive.enabled",
        label: "Prompt Cache 定时保活",
        beforeDisplay: "关闭",
        afterDisplay: "开启",
      },
    ],
    createdAt: "2026-11-25T02:00:00.000Z",
    resolvedAt: null,
    resolvedNote: null,
    ...overrides,
  };
}

function makeRoutine(overrides: Partial<MainChatRoutineRecord> = {}): MainChatRoutineRecord {
  return {
    id: "rt_morning",
    name: "每日巡检简报",
    kind: "recurring",
    status: "active",
    cadence: { type: "cron", expression: "0 9 * * *" },
    ownerKind: "main",
    conversationId: "conv_main",
    conversationTitle: "总控主对话",
    targetAgentId: "agent_main",
    prompt: "汇总昨晚所有后台任务与代码变更，有阻塞才提醒。",
    maxRuns: null,
    runCount: 3,
    nextRunAt: "2026-11-26T01:00:00.000Z",
    lastRunAt: "2026-11-25T01:00:00.000Z",
    pausedAt: null,
    expiresAt: null,
    lastRunStatus: "succeeded",
    lastRunOutput: null,
    lastRunError: null,
    createdAt: "2026-11-20T01:00:00.000Z",
    updatedAt: "2026-11-25T01:00:00.000Z",
    ...overrides,
  };
}

function makeLeaderConversation(): MainChatConversationRecord {
  const now = "2026-11-25T01:00:00.000Z";
  return {
    id: "conv_leader_1",
    kind: "leader",
    agentId: "agent_leader_1",
    workspaceId: "ws_main",
    title: "服务端可靠性",
    directionSummary: "监控服务端异常与定时任务稳定性",
    notes: null,
    parentConversationId: "conv_main",
    serverId: "srv_1",
    archivedAt: null,
    pinnedAsLeaderAt: now,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
  };
}

beforeEach(() => {
  toastApi.show.mockReset();
  toastApi.error.mockReset();
  useMainChatSettingsStore.setState({
    settingsByServerId: {},
    nightModeStatusByServerId: {},
    cacheKeepaliveStatusByServerId: {},
    loadingByServerId: {},
    usageByServerId: {},
    usageLoadingByServerId: {},
    lastPatrolByServerId: {},
  });
  useMainChatOverviewStore.setState({
    overviewsByKey: {},
    decisionsByKey: {},
    settingsProposalsByKey: {},
  });
  useMainChatConversationsStore.getState().reset();
  useSessionStore.setState({ sessions: {} });
});

afterEach(() => {
  cleanup();
});

describe("Wave 2 — turn-collapse compaction & routine background turns", () => {
  it("renders idle compaction background turn as a compact single-line expandable summary even when silent", () => {
    const items: StreamItem[] = [
      {
        kind: "tool_call",
        id: "bg_compact_1",
        timestamp: new Date("2026-11-25T01:10:00.000Z"),
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            error: null,
            callId: "bg_compact_1",
            name: "main_chat_background_trigger",
            status: "completed",
            detail: { type: "unknown", input: null, output: null },
            metadata: {
              mainChatBackground: {
                foldable: true,
                kind: "compaction",
                trigger: "idle_precompact",
                label: "空闲预压缩完成（320k 窗口）",
              },
            },
          },
        },
      },
      {
        kind: "assistant_message",
        id: "bg_compact_reply_1",
        timestamp: new Date("2026-11-25T01:10:05.000Z"),
        text: "[SILENT]",
      },
    ];

    const collapsed = collapseTurns({
      tail: items,
      isLatestTurnOpen: false,
      expandedHostIds: new Set(),
      previousSummaryRowsByHostId: new Map(),
      getGroupedCalls: () => undefined,
      collapseBackgroundTurns: true,
    });
    expect(collapsed.tail).toHaveLength(1);
    const entry = collapsed.tail[0];
    expect(entry?.kind).toBe("turn_summary");
    if (entry?.kind === "turn_summary") {
      expect(entry.variant).toBe("background");
      expect(entry.backgroundMeta?.kind).toBe("compaction");
      expect(entry.backgroundMeta?.label).toBe("空闲预压缩完成（320k 窗口）");
      expect(entry.expanded).toBe(false);
    }

    // Expanding reveals the folded host + body cleanly in place
    const expanded = collapseTurns({
      tail: items,
      isLatestTurnOpen: false,
      expandedHostIds: new Set(["bg_compact_1"]),
      previousSummaryRowsByHostId: new Map(),
      getGroupedCalls: () => undefined,
      collapseBackgroundTurns: true,
    });
    expect(expanded.tail[0]?.kind).toBe("turn_summary");
    expect(expanded.tail.length).toBeGreaterThan(1);
    expect(expanded.nestedItemIds.size).toBeGreaterThan(0);
  });

  it("folds routine background turns while keeping substantive conclusion and suppressing silent routine runs", () => {
    const items: StreamItem[] = [
      {
        kind: "tool_call",
        id: "bg_rt_silent",
        timestamp: new Date("2026-11-25T01:20:00.000Z"),
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            error: null,
            callId: "bg_rt_silent",
            name: "main_chat_background_trigger",
            status: "completed",
            detail: { type: "unknown", input: null, output: null },
            metadata: {
              mainChatBackground: {
                foldable: true,
                kind: "routine",
                trigger: "routine:rt_silent",
                label: "例行巡检：无异常",
              },
            },
          },
        },
      },
      {
        kind: "assistant_message",
        id: "bg_rt_silent_reply",
        timestamp: new Date("2026-11-25T01:20:02.000Z"),
        text: "[SILENT]",
      },
      {
        kind: "tool_call",
        id: "bg_rt_report",
        timestamp: new Date("2026-11-25T01:30:00.000Z"),
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            error: null,
            callId: "bg_rt_report",
            name: "main_chat_background_trigger",
            status: "completed",
            detail: { type: "unknown", input: null, output: null },
            metadata: {
              mainChatBackground: {
                foldable: true,
                kind: "routine",
                trigger: "routine:rt_morning",
                label: "例行任务：每日巡检简报",
              },
            },
          },
        },
      },
      {
        kind: "assistant_message",
        id: "bg_rt_report_reply",
        timestamp: new Date("2026-11-25T01:30:05.000Z"),
        text: "昨晚 3 个后台任务已全部通过，CI 绿色。",
      },
    ];

    const collapsed = collapseTurns({
      tail: items,
      isLatestTurnOpen: false,
      expandedHostIds: new Set(),
      previousSummaryRowsByHostId: new Map(),
      getGroupedCalls: () => undefined,
      collapseBackgroundTurns: true,
    });
    // Silent routine is suppressed; substantive routine yields 1 summary line + 1 assistant conclusion.
    expect(collapsed.tail).toHaveLength(2);
    expect(collapsed.tail[0]?.kind).toBe("turn_summary");
    if (collapsed.tail[0]?.kind === "turn_summary") {
      expect(collapsed.tail[0].backgroundMeta?.kind).toBe("routine");
    }
    expect(collapsed.tail[1]?.kind).toBe("assistant_message");
  });
});

const FIXTURE_KEEPALIVE_STATUS: MainChatCacheKeepaliveStatus = {
  enabled: true,
  activeTargets: 2,
  intervalMinutes: 4,
  maxRequests: 12,
  pingsSentTotal: 3,
  lastPingAt: "2026-11-25T01:40:00.000Z",
  lastYieldReason: null,
};

function createFakeRoutinesClient(initial: MainChatRoutineRecord[]): DaemonClient {
  let routines = [...initial];
  return {
    listMainChatRoutines: vi.fn(async () => ({
      requestId: "req_list",
      routines: [...routines],
      error: null,
    })),
    createMainChatRoutine: vi.fn(async (input) => {
      const created = makeRoutine({
        id: `rt_${routines.length + 1}`,
        name: input.name,
        prompt: input.prompt,
        kind: input.kind ?? "recurring",
        cadence: input.cadence ?? { type: "every", everyMs: 1_800_000 },
        maxRuns: input.kind === "one_shot" ? 1 : null,
      });
      routines = [created, ...routines];
      return { requestId: "req_create", routine: created, error: null };
    }),
    pauseMainChatRoutine: vi.fn(async (id: string) => {
      routines = routines.map((item) =>
        item.id === id ? { ...item, status: "paused" as const } : item,
      );
      return {
        requestId: "req_pause",
        routine: routines.find((item) => item.id === id) ?? null,
        error: null,
      };
    }),
    resumeMainChatRoutine: vi.fn(async (id: string) => {
      routines = routines.map((item) =>
        item.id === id ? { ...item, status: "active" as const } : item,
      );
      return {
        requestId: "req_resume",
        routine: routines.find((item) => item.id === id) ?? null,
        error: null,
      };
    }),
    runMainChatRoutineOnce: vi.fn(async (id: string) => {
      routines = routines.map((item) =>
        item.id === id ? { ...item, runCount: item.runCount + 1 } : item,
      );
      return {
        requestId: "req_run",
        routine: routines.find((item) => item.id === id) ?? null,
        error: null,
      };
    }),
    deleteMainChatRoutine: vi.fn(async (id: string) => {
      routines = routines.filter((item) => item.id !== id);
      return { requestId: "req_del", deleted: true, error: null };
    }),
  } as unknown as DaemonClient;
}

describe("Wave 2 — MainChatCostControlPanel (P0-3)", () => {
  it("updates compaction cap presets, custom idle wait minutes, and cache keepalive settings", async () => {
    const appliedPatches: MainChatSettingsPatch[] = [];
    const settings: MainChatSettings = mergeMainChatSettings(
      createDefaultMainChatSettings("conservative"),
      { cacheKeepalive: { enabled: true, intervalMinutes: 4, maxRequests: 12 } },
    );

    const onApplyPatch = vi.fn(async (patch: MainChatSettingsPatch) => {
      appliedPatches.push(patch);
    });

    const view = render(
      wrap(
        <MainChatCostControlPanel
          serverId="srv_1"
          settings={settings}
          cacheKeepaliveStatus={FIXTURE_KEEPALIVE_STATUS}
          disabled={false}
          onApplyPatch={onApplyPatch}
        />,
      ),
    );

    // Click uncapped preset
    fireEvent.click(view.getByTestId("cost-control-cap-preset-uncapped"));
    expect(appliedPatches[0]).toEqual({ compaction: { windowCapTokens: null } });

    // Click 200k preset
    fireEvent.click(view.getByTestId("cost-control-cap-preset-200k"));
    expect(appliedPatches[1]).toEqual({ compaction: { windowCapTokens: 200_000 } });

    // Unit label "k tokens" is rendered beside custom cap input
    expect(view.getByTestId("cost-control-cap-unit").textContent).toBe(
      "mainChat.costControl.windowCapUnit",
    );

    // Edit custom cap (k-unit) & apply
    fireEvent.change(view.getByTestId("cost-control-cap-input"), { target: { value: "350" } });
    fireEvent.click(view.getByTestId("cost-control-cap-apply"));
    expect(appliedPatches[2]).toEqual({
      compaction: { windowCapTokens: 350_000 },
    });

    // Also supports entering full raw token count (e.g. 320000 -> 320k tokens) without error
    fireEvent.change(view.getByTestId("cost-control-cap-input"), { target: { value: "320000" } });
    fireEvent.click(view.getByTestId("cost-control-cap-apply"));
    expect(appliedPatches[3]).toEqual({
      compaction: { windowCapTokens: 320_000 },
    });

    // Edit idle precompact wait minutes & save
    fireEvent.change(view.getByTestId("cost-control-idle-minutes-input"), {
      target: { value: "15" },
    });
    fireEvent.click(view.getByTestId("cost-control-idle-minutes-save"));
    expect(appliedPatches[4]).toEqual({
      compaction: { idlePrecompactMinIdleMin: 15 },
    });

    // Toggle cache keepalive switch off
    fireEvent.click(view.getByTestId("cost-control-keepalive-switch"));
    expect(appliedPatches[5]).toEqual({ cacheKeepalive: { enabled: false } });

    // Save cache keepalive interval & max pings
    fireEvent.change(view.getByTestId("cost-control-keepalive-interval-input"), {
      target: { value: "6" },
    });
    fireEvent.change(view.getByTestId("cost-control-keepalive-max-input"), {
      target: { value: "20" },
    });
    fireEvent.click(view.getByTestId("cost-control-keepalive-save"));
    expect(appliedPatches[6]).toEqual({
      cacheKeepalive: { intervalMinutes: 6, maxRequests: 20 },
    });

    // Status pill is displayed
    expect(view.getByTestId("cost-control-keepalive-status")).toBeTruthy();
  });

  it("parses custom compaction cap in k-units, explicit k suffix, full token count, empty uncapped, and rejects out-of-range inputs", () => {
    expect(parseCustomCompactionCapTokens("")).toBeNull();
    expect(parseCustomCompactionCapTokens("   ")).toBeNull();
    expect(parseCustomCompactionCapTokens("320")).toBe(320_000);
    expect(parseCustomCompactionCapTokens("320k")).toBe(320_000);
    expect(parseCustomCompactionCapTokens("400K")).toBe(400_000);
    expect(parseCustomCompactionCapTokens("320000")).toBe(320_000);
    expect(parseCustomCompactionCapTokens("320,000")).toBe(320_000);
    expect(parseCustomCompactionCapTokens("1000000")).toBe(1_000_000);
    expect(parseCustomCompactionCapTokens("50")).toBe("invalid");
    expect(parseCustomCompactionCapTokens("50000")).toBe("invalid");
    expect(parseCustomCompactionCapTokens("99999999")).toBe("invalid");
    expect(parseCustomCompactionCapTokens("abc")).toBe("invalid");
  });
});

describe("Wave 2 — MainChatRoutinesPanel (P0-4)", () => {
  it("lists, creates, pauses, resumes, runs once, and deletes routines", async () => {
    const client = createFakeRoutinesClient([makeRoutine()]);

    useMainChatConversationsStore.setState({
      conversationsByServerId: { srv_1: [makeLeaderConversation()] },
    });

    const view = render(
      wrap(<MainChatRoutinesPanel serverId="srv_1" client={client} disabled={false} />),
    );

    await waitFor(() => {
      expect(view.getByTestId("routine-row-rt_morning")).toBeTruthy();
    });

    // Open create form and submit a recurring routine
    fireEvent.click(view.getByTestId("routines-new-button"));
    fireEvent.change(view.getByTestId("routines-name-input"), {
      target: { value: "每半小时健康检查" },
    });
    fireEvent.change(view.getByTestId("routines-every-minutes-input"), {
      target: { value: "30" },
    });
    fireEvent.change(view.getByTestId("routines-prompt-input"), {
      target: { value: "检查 CI 队列并在失败时汇报。" },
    });
    fireEvent.click(view.getByTestId("routines-create-submit"));

    await waitFor(() => {
      expect(client.createMainChatRoutine).toHaveBeenCalledTimes(1);
    });

    // Pause -> Resume -> Run once -> Delete original routine
    fireEvent.click(view.getByTestId("routine-toggle-pause-rt_morning"));
    await waitFor(() => {
      expect(client.pauseMainChatRoutine).toHaveBeenCalledWith("rt_morning");
      expect(view.getByTestId("routine-toggle-pause-rt_morning").textContent).toContain(
        "mainChat.routines.resumeButton",
      );
    });

    fireEvent.click(view.getByTestId("routine-toggle-pause-rt_morning"));
    await waitFor(() => {
      expect(client.resumeMainChatRoutine).toHaveBeenCalledWith("rt_morning");
      expect(view.getByTestId("routine-toggle-pause-rt_morning").textContent).toContain(
        "mainChat.routines.pauseButton",
      );
    });

    fireEvent.click(view.getByTestId("routine-run-once-rt_morning"));
    await waitFor(() => {
      expect(client.runMainChatRoutineOnce).toHaveBeenCalledWith("rt_morning");
    });

    await waitFor(() => {
      expect(view.getByTestId("routine-delete-rt_morning").getAttribute("aria-disabled")).not.toBe(
        "true",
      );
    });
    fireEvent.click(view.getByTestId("routine-delete-rt_morning"));
    fireEvent.click(view.getByTestId("routine-confirm-delete-rt_morning"));
    await waitFor(() => {
      expect(client.deleteMainChatRoutine).toHaveBeenCalledWith("rt_morning");
    });
  });
});

describe("Wave 2 — MainChatSettingsProposalCard & inline tool rendering (P0-5)", () => {
  it("renders approval card from settings_propose_patch tool output and applies settings only on Approve", async () => {
    const proposal = makeProposal();
    const initialSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      cacheKeepalive: { enabled: false },
    });
    const updatedSettings = mergeMainChatSettings(initialSettings, proposal.patch);
    useMainChatSettingsStore.getState().hydrateSettings("srv_1", initialSettings);

    const resolveMainChatSettingsProposal = vi.fn(
      async (input: { proposalId: string; decision: "approve" | "reject" }) => ({
        requestId: "req_resolve",
        proposal: {
          ...proposal,
          status: input.decision === "approve" ? ("approved" as const) : ("rejected" as const),
          resolvedAt: "2026-11-25T02:05:00.000Z",
        },
        settings: input.decision === "approve" ? updatedSettings : undefined,
        error: null,
      }),
    );

    const fakeClient = {
      resolveMainChatSettingsProposal,
      getMainChatOverview: vi.fn(async () => ({
        requestId: "req_ov",
        overview: null,
        error: null,
      })),
    } as unknown as DaemonClient;

    useSessionStore.setState({
      sessions: {
        srv_1: {
          serverId: "srv_1",
          client: fakeClient,
        } as unknown as SessionState,
      },
    });

    const cardEl = renderMainChatInlineToolCard({
      serverId: "srv_1",
      agentId: "agent_main",
      toolName: "mcp__paseo__settings_propose_patch",
      toolStatus: "completed",
      toolInput: {},
      toolOutput: { proposal },
    });
    expect(cardEl).not.toBeNull();

    const view = render(wrap(cardEl!));
    expect(view.getByTestId("main-chat-settings-proposal-card-prop_w2_1")).toBeTruthy();
    expect(view.getByTestId("settings-proposal-change-compaction.windowCapTokens")).toBeTruthy();
    expect(view.getByTestId("settings-proposal-change-cacheKeepalive.enabled")).toBeTruthy();

    await act(async () => {
      fireEvent.click(view.getByTestId("main-chat-settings-proposal-approve-prop_w2_1"));
    });

    await waitFor(() => {
      expect(resolveMainChatSettingsProposal).toHaveBeenCalledWith({
        proposalId: "prop_w2_1",
        decision: "approve",
      });
    });

    // Hydrated updated settings into settings store after approval
    const stored = useMainChatSettingsStore.getState().settingsByServerId.srv_1;
    expect(stored?.compaction?.windowCapTokens).toBe(320_000);
    expect(stored?.cacheKeepalive?.enabled).toBe(true);
  });

  it("rejects proposal without mutating settings store", async () => {
    const proposal = makeProposal({ id: "prop_w2_reject" });
    const initialSettings = mergeMainChatSettings(createDefaultMainChatSettings("conservative"), {
      cacheKeepalive: { enabled: false },
    });
    useMainChatSettingsStore.getState().hydrateSettings("srv_1", initialSettings);

    const resolveMainChatSettingsProposal = vi.fn(async () => ({
      requestId: "req_reject",
      proposal: {
        ...proposal,
        status: "rejected" as const,
        resolvedAt: "2026-11-25T02:06:00.000Z",
      },
      error: null,
    }));

    const fakeClient = {
      resolveMainChatSettingsProposal,
      getMainChatOverview: vi.fn(async () => ({
        requestId: "req_ov",
        overview: null,
        error: null,
      })),
    } as unknown as DaemonClient;

    useSessionStore.setState({
      sessions: {
        srv_1: {
          serverId: "srv_1",
          client: fakeClient,
        } as unknown as SessionState,
      },
    });

    const cardEl = renderMainChatInlineToolCard({
      serverId: "srv_1",
      agentId: "agent_main",
      toolName: "settings_propose_patch",
      toolStatus: "completed",
      toolInput: {},
      toolOutput: { proposal },
    });
    expect(cardEl).not.toBeNull();

    const view = render(wrap(cardEl!));
    await act(async () => {
      fireEvent.click(view.getByTestId("main-chat-settings-proposal-reject-prop_w2_reject"));
    });

    await waitFor(() => {
      expect(resolveMainChatSettingsProposal).toHaveBeenCalledWith({
        proposalId: "prop_w2_reject",
        decision: "reject",
      });
    });

    // Settings store remains completely untouched
    const stored = useMainChatSettingsStore.getState().settingsByServerId.srv_1;
    expect(stored?.compaction?.windowCapTokens).toBe(400_000);
    expect(stored?.cacheKeepalive?.enabled).toBe(false);
  });
});

describe("Wave 2 — MainChatLimitFallbacksPanel (P0-5)", () => {
  it("adds, reorders, and removes ordered limitFallbacks and shows recent switch events", () => {
    const appliedPatches: MainChatSettingsPatch[] = [];
    const settings: MainChatSettings = mergeMainChatSettings(
      createDefaultMainChatSettings("conservative"),
      {
        limitFallbacks: [
          { provider: "claude", model: "claude-sonnet-4-5" },
          { provider: "codex", model: "gpt-5.4" },
        ],
      },
    );
    const recentEvents: MainChatLimitFallbackEvent[] = [
      {
        id: "lfb_ev_1",
        createdAt: "2026-11-25T01:55:00.000Z",
        agentId: "agent_main",
        agentRole: "main",
        fromProvider: "claude",
        fromModel: "claude-opus-4-5",
        toProvider: "claude",
        toModel: "claude-sonnet-4-5",
        reason: "HTTP 429 rate limit exceeded",
      },
    ];

    const onApplyPatch = vi.fn((patch: MainChatSettingsPatch) => {
      appliedPatches.push(patch);
    });

    const view = render(
      wrap(
        <MainChatLimitFallbacksPanel
          serverId="srv_1"
          settings={settings}
          recentEvents={recentEvents}
          disabled={false}
          onApplyPatch={onApplyPatch}
        />,
      ),
    );

    expect(view.getByTestId("limit-fallback-row-0")).toBeTruthy();
    expect(view.getByTestId("limit-fallback-row-1")).toBeTruthy();
    expect(view.getByTestId("limit-fallbacks-recent")).toBeTruthy();

    // Move second item up
    fireEvent.click(view.getByTestId("limit-fallback-up-1"));
    expect(appliedPatches[0]).toEqual({
      limitFallbacks: [
        { provider: "codex", model: "gpt-5.4" },
        { provider: "claude", model: "claude-sonnet-4-5" },
      ],
    });

    // Add a custom spec
    fireEvent.change(view.getByTestId("limit-fallbacks-custom-input"), {
      target: { value: "opencode/gpt-5.4-mini" },
    });
    fireEvent.click(view.getByTestId("limit-fallbacks-add-button"));
    expect(appliedPatches[1]).toEqual({
      limitFallbacks: [
        { provider: "claude", model: "claude-sonnet-4-5" },
        { provider: "codex", model: "gpt-5.4" },
        { provider: "opencode", model: "gpt-5.4-mini" },
      ],
    });

    // Remove first item
    fireEvent.click(view.getByTestId("limit-fallback-remove-0"));
    expect(appliedPatches[2]).toEqual({
      limitFallbacks: [{ provider: "codex", model: "gpt-5.4" }],
    });
  });
});
