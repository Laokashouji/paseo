// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_QUIET_LABEL,
  createDefaultMainChatSettings,
  mergeMainChatSettings,
  type MainChatConversationRecord,
  type MainChatMemoryFileContent,
  type MainChatMemoryFileMeta,
  type MainChatSettings,
  type MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collapseTurns } from "@/agent-stream/turn-collapse/model";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatSettingsSection } from "@/screens/settings/main-chat/main-chat-section";
import { MainChatMemoryProfilePanel } from "@/screens/settings/main-chat/memory-profile-panel";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import type { StreamItem } from "@/types/stream";
import { useMainChatConversationsStore } from "./conversations-store";
import { selectMainChatSidebarSummary } from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";

const mockHosts = vi.hoisted(() => [{ serverId: "srv_1", label: "DevBox" }]);

vi.mock("expo-router", () => ({
  router: {
    push: vi.fn(),
    replace: vi.fn(),
    navigate: vi.fn(),
  },
  usePathname: () => "/settings",
}));

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

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => mockHosts,
  useHostRuntimeIsConnected: () => true,
  getHostRuntimeStore: () => ({ getState: () => ({ hosts: mockHosts }) }),
}));

vi.mock("@/hooks/use-providers-snapshot", () => ({
  useProvidersSnapshot: () => ({
    data: [],
    isLoading: false,
    isFetching: false,
    isRefreshing: false,
    refetch: vi.fn(),
  }),
  providersSnapshotQueryKey: () => ["providers"],
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useActiveWorkspaceSelection: () => null,
}));

function makeConversation(
  overrides: Partial<MainChatConversationRecord> & { id: string; title: string },
): MainChatConversationRecord {
  const now = "2026-11-24T12:00:00.000Z";
  return {
    kind: "leader",
    agentId: `agent_${overrides.id}`,
    workspaceId: "ws_main",
    directionSummary: "方向职责摘要",
    notes: null,
    parentConversationId: "conv_main",
    serverId: "srv_1",
    archivedAt: null,
    pinnedAsLeaderAt: now,
    createdAt: now,
    updatedAt: now,
    lastMessageAt: now,
    ...overrides,
  };
}

function makeFakeAgent(overrides: Partial<Agent> & { id: string }): Agent {
  const now = new Date("2026-11-24T12:00:00.000Z");
  return {
    serverId: "srv_1",
    workspaceId: "ws_1",
    provider: "claude",
    status: "idle",
    lifecycle: "idle",
    cwd: "/repo/paseo-fork",
    title: overrides.id,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    labels: {},
    pendingPermissions: [],
    availableModes: [],
    currentModeId: null,
    turn: { phase: "idle", turnId: null, startedAt: null },
    background: false,
    internal: false,
    ...overrides,
  } as Agent;
}

const noopToastApi = {
  show: vi.fn(),
  copied: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
};

function makeMockMemoryClient(
  memoryStore: Map<string, MainChatMemoryFileContent>,
  leaderA: MainChatConversationRecord,
  leaderB: MainChatConversationRecord,
  updateConversationSpy: ReturnType<typeof vi.fn>,
): DaemonClient {
  return {
    listMainChatConversations: vi.fn(async () => ({
      requestId: "req_c",
      conversations: [leaderA, leaderB],
      error: null,
    })),
    updateMainChatConversation: updateConversationSpy,
    listMainChatMemoryFiles: vi.fn(async () => ({
      requestId: "req_ml",
      files: Array.from(memoryStore.values()).map(({ path, bytes, updatedAt }) => ({
        path,
        bytes,
        updatedAt,
      })),
      error: null,
    })),
    readMainChatMemoryFile: vi.fn(async (filePath: string) => {
      const hit = memoryStore.get(filePath);
      return hit
        ? { requestId: "req_mr", file: hit, error: null }
        : { requestId: "req_mr", file: null, error: "not found" };
    }),
    writeMainChatMemoryFile: vi.fn(async (filePath: string, content: string) => {
      if (filePath.includes("..")) {
        return { requestId: "req_mw", file: null, error: "记忆文件路径禁止包含路径穿越段" };
      }
      const meta: MainChatMemoryFileMeta = {
        path: filePath,
        bytes: content.length,
        updatedAt: "2026-11-24T12:05:00.000Z",
      };
      memoryStore.set(filePath, { ...meta, content });
      return { requestId: "req_mw", file: meta, error: null };
    }),
    deleteMainChatMemoryFile: vi.fn(async (filePath: string) => {
      const existed = memoryStore.delete(filePath);
      return { requestId: "req_md", deleted: existed, error: null };
    }),
  } as unknown as DaemonClient;
}

const INITIAL_PROFILE_SETTINGS: MainChatSettings = {
  ...createDefaultMainChatSettings(),
  enabled: true,
  profile: {
    aboutMe: "初始个人简介",
    ownerAliases: ["老卡"],
    updatedAt: null,
  },
};

describe("P0-1 & P0-2 App Unit Tests", () => {
  beforeEach(() => {
    useMainChatSettingsStore.setState({
      settingsByServerId: {},
      nightModeStatusByServerId: {},
      usageByServerId: {},
      usageLoadingByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
    useMainChatConversationsStore.getState().reset();
    useSessionStore.setState({ sessions: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it("edits About Me + aliases, switches Direction Notes, and performs Memory File CRUD in MainChatMemoryProfilePanel", async () => {
    const memoryStore = new Map<string, MainChatMemoryFileContent>([
      [
        "MEMORY.md",
        {
          path: "MEMORY.md",
          content: "# Core Rules\nAlways verify before claiming done.",
          bytes: 47,
          updatedAt: "2026-11-24T12:00:00.000Z",
        },
      ],
    ]);

    const leaderA = makeConversation({
      id: "conv_dir_a",
      title: "客户端体验",
      notes: "保持轨道对齐 <= 1px",
    });
    const leaderB = makeConversation({
      id: "conv_dir_b",
      title: "服务端督办",
      notes: "默认任务静默执行",
    });

    const updateConversationSpy = vi.fn(
      async (input: { conversationId: string; notes?: string | null }) => {
        const target = input.conversationId === leaderA.id ? leaderA : leaderB;
        const updated = { ...target, notes: input.notes ?? null };
        return { requestId: "req_u", conversation: updated, error: null };
      },
    );

    const mockClient = makeMockMemoryClient(memoryStore, leaderA, leaderB, updateConversationSpy);

    const onApplyPatch = vi.fn(async () => {});

    const view = render(
      <ToastApiProvider api={noopToastApi}>
        <MainChatMemoryProfilePanel
          serverId="srv_1"
          client={mockClient}
          settings={INITIAL_PROFILE_SETTINGS}
          disabled={false}
          onApplyPatch={onApplyPatch}
        />
      </ToastApiProvider>,
    );

    // 1. Add alias + edit About Me + save profile
    const aliasInput = view.getByTestId("memory-profile-alias-input");
    fireEvent.change(aliasInput, { target: { value: "Shaw" } });
    fireEvent.click(view.getByTestId("memory-profile-alias-add"));

    const aboutMeInput = view.getByTestId("memory-profile-about-me-input");
    fireEvent.change(aboutMeInput, { target: { value: "更新后的架构偏好与沟通口径" } });

    await act(async () => {
      fireEvent.click(view.getByTestId("memory-profile-save-button"));
    });
    expect(onApplyPatch).toHaveBeenCalledWith(
      {
        profile: {
          aboutMe: "更新后的架构偏好与沟通口径",
          ownerAliases: ["老卡", "Shaw"],
        },
      },
      "mainChat.memoryProfile.profileSavedToast",
    );

    // 2. Switch direction leader and save direction notes
    const pillB = await view.findByTestId("memory-profile-direction-pill-conv_dir_b");
    fireEvent.click(pillB);
    const notesInput = view.getByTestId("memory-profile-direction-notes-input");
    await waitFor(() => {
      expect((notesInput as HTMLTextAreaElement).value).toBe("默认任务静默执行");
    });
    fireEvent.change(notesInput, { target: { value: "服务端督办新笔记：严格校验路径穿越" } });
    await act(async () => {
      fireEvent.click(view.getByTestId("memory-profile-direction-notes-save"));
    });
    expect(updateConversationSpy).toHaveBeenCalledWith({
      conversationId: "conv_dir_b",
      notes: "服务端督办新笔记：严格校验路径穿越",
    });

    // 3. Memory files: open existing file, create new file, handle traversal error, delete file
    const openMemoryBtn = await view.findByTestId("memory-file-open-MEMORY.md");
    await act(async () => {
      fireEvent.click(openMemoryBtn);
    });
    const contentInput = await view.findByTestId("memory-file-content-input");
    expect((contentInput as HTMLTextAreaElement).value).toContain("Always verify");

    // Create a new file with traversal path -> error banner shown
    fireEvent.click(view.getByTestId("memory-files-new-button"));
    fireEvent.change(view.getByTestId("memory-file-path-input"), {
      target: { value: "../escape.md" },
    });
    fireEvent.change(view.getByTestId("memory-file-content-input"), {
      target: { value: "bad" },
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("memory-file-save-button"));
    });
    expect(await view.findByTestId("memory-files-error")).toBeTruthy();

    // Save valid new file
    fireEvent.change(view.getByTestId("memory-file-path-input"), {
      target: { value: "projects/paseo.md" },
    });
    fireEvent.change(view.getByTestId("memory-file-content-input"), {
      target: { value: "# Paseo Notes" },
    });
    await act(async () => {
      fireEvent.click(view.getByTestId("memory-file-save-button"));
    });
    expect(await view.findByTestId("memory-file-row-projects/paseo.md")).toBeTruthy();

    // Delete file via inline confirmation
    fireEvent.click(view.getByTestId("memory-file-delete-projects/paseo.md"));
    await act(async () => {
      fireEvent.click(view.getByTestId("memory-file-confirm-delete-projects/paseo.md"));
    });
    await waitFor(() => {
      expect(view.queryByTestId("memory-file-row-projects/paseo.md")).toBeNull();
    });
  });

  it("toggles mainBackgroundFolded and mainTasksQuiet in MainChatSettingsSection", async () => {
    let currentSettings: MainChatSettings = {
      ...createDefaultMainChatSettings(),
      enabled: true,
    };

    const updateSettingsMock = vi.fn(async (patch: MainChatSettingsPatch) => {
      currentSettings = mergeMainChatSettings(currentSettings, patch);
      return { requestId: "req_s", settings: currentSettings, error: null };
    });

    const fakeClient = {
      getMainChatSettings: vi.fn(async () => ({
        requestId: "req_g",
        settings: currentSettings,
        error: null,
      })),
      updateMainChatSettings: updateSettingsMock,
      getMainChatOverview: vi.fn(async () => ({
        requestId: "req_o",
        overview: null,
        error: null,
      })),
      listMainChatConversations: vi.fn(async () => ({
        requestId: "req_c",
        conversations: [],
        error: null,
      })),
      listMainChatMemoryFiles: vi.fn(async () => ({
        requestId: "req_m",
        files: [],
        error: null,
      })),
      getMainChatFleetHosts: vi.fn(async () => ({
        requestId: "req_f",
        localServerId: "srv_1",
        hosts: [],
        error: null,
      })),
    } as unknown as DaemonClient;

    useMainChatSettingsStore.getState().hydrateSettings("srv_1", currentSettings);
    useSessionStore.setState({
      sessions: {
        srv_1: {
          serverId: "srv_1",
          client: fakeClient,
          connectionStatus: "connected",
          serverInfo: {
            serverId: "srv_1",
            version: "0.17.525",
            features: { mainChat: true },
          },
          agents: new Map(),
          agentDetails: new Map(),
          pendingPermissions: new Map(),
          workspaces: new Map(),
          projects: new Map(),
        } as unknown as SessionState,
      },
    });

    const view = render(
      <KeyboardActionDispatcherProvider>
        <ToastApiProvider api={noopToastApi}>
          <MainChatSettingsSection />
        </ToastApiProvider>
      </KeyboardActionDispatcherProvider>,
    );

    const foldSwitch = await view.findByTestId("settings-main-chat-background-folded");
    const quietSwitch = await view.findByTestId("settings-main-chat-tasks-quiet");

    await act(async () => {
      fireEvent.click(foldSwitch);
    });
    await act(async () => {
      fireEvent.click(quietSwitch);
    });

    expect(updateSettingsMock).toHaveBeenCalledWith({ mainBackgroundFolded: false });
    expect(updateSettingsMock).toHaveBeenCalledWith({ mainTasksQuiet: false });
  });

  it("folds structured background supervision/patrol/relay turns by default and respects collapseBackgroundTurns=false", () => {
    const ts = new Date("2026-11-24T12:10:00.000Z");
    const tail: StreamItem[] = [
      {
        kind: "tool_call",
        id: "bg_patrol_1",
        timestamp: ts,
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "paseo-system:abc",
            name: "heartbeat",
            status: "completed",
            error: null,
            detail: { type: "plain_text", text: "📋 督办 · 主动巡检唤醒：发现 1 条待处理动态" },
            metadata: {
              mainChatBackground: {
                foldable: true,
                kind: "patrol",
                trigger: "patrol_wakeup",
                label: "巡检发现 1 条待处理动态",
                quiet: true,
              },
            },
          },
        },
      },
      {
        kind: "tool_call",
        id: "tool_inspect_1",
        timestamp: ts,
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "call_inspect_1",
            name: "get_agent_activity",
            status: "completed",
            error: null,
            detail: { type: "plain_text", text: "inspected child" },
          },
        },
      },
      {
        kind: "assistant_message",
        id: "msg_patrol_summary",
        timestamp: ts,
        text: "子任务已完成并核验通过。",
      },
      {
        kind: "tool_call",
        id: "bg_relay_1",
        timestamp: ts,
        payload: {
          source: "agent",
          data: {
            provider: "claude",
            callId: "paseo-agent-message:m1",
            name: "agent_message",
            status: "completed",
            error: null,
            detail: { type: "plain_text", text: "任务完成回传" },
            metadata: {
              mainChatBackground: {
                foldable: true,
                kind: "relay",
                trigger: "agent_notification:finished",
                label: "自动中继 · 修复单测",
              },
            },
          },
        },
      },
      {
        kind: "assistant_message",
        id: "msg_relay_reply",
        timestamp: ts,
        text: "已验收并关闭该任务。",
      },
    ];

    const folded = collapseTurns({
      tail,
      isLatestTurnOpen: false,
      expandedHostIds: new Set(),
      getGroupedCalls: () => undefined,
      previousSummaryRowsByHostId: new Map(),
      collapseNormalTurns: true,
      collapseBackgroundTurns: true,
    });

    expect(folded.tail.map((i) => i.id)).toEqual([
      "turn-summary:bg_patrol_1",
      "msg_patrol_summary",
      "turn-summary:bg_relay_1",
      "msg_relay_reply",
    ]);
    expect(folded.summaryRowsByHostId.get("bg_patrol_1")?.backgroundMeta).toEqual({
      label: "巡检发现 1 条待处理动态",
      running: false,
      kind: "patrol",
    });
    expect(folded.summaryRowsByHostId.get("bg_relay_1")?.backgroundMeta).toEqual({
      label: "自动中继 · 修复单测",
      running: false,
      kind: "relay",
    });

    // When mainBackgroundFolded=false -> collapseBackgroundTurns=false leaves background hosts uncollapsed
    const unfolded = collapseTurns({
      tail,
      isLatestTurnOpen: false,
      expandedHostIds: new Set(),
      getGroupedCalls: () => undefined,
      previousSummaryRowsByHostId: new Map(),
      collapseNormalTurns: false,
      collapseBackgroundTurns: false,
    });
    expect(unfolded.tail.map((i) => i.id)).toEqual(tail.map((i) => i.id));
  });

  it("suppresses unread attention count for quiet finished main-chat tasks while keeping non-quiet and permission/error tasks loud", () => {
    const mainAgent = makeFakeAgent({
      id: "agent_main",
      labels: { [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE },
    });
    const quietFinishedChild = makeFakeAgent({
      id: "child_quiet_done",
      requiresAttention: true,
      attentionReason: "finished",
      labels: { [MAIN_CHAT_TASK_QUIET_LABEL]: "true" },
    });
    const quietErrorChild = makeFakeAgent({
      id: "child_quiet_error",
      status: "error",
      requiresAttention: true,
      attentionReason: "error",
      labels: { [MAIN_CHAT_TASK_QUIET_LABEL]: "true" },
    });
    const loudFinishedChild = makeFakeAgent({
      id: "child_loud_done",
      requiresAttention: true,
      attentionReason: "finished",
      labels: { [MAIN_CHAT_TASK_QUIET_LABEL]: "false" },
    });

    useSessionStore.setState({
      sessions: {
        srv_1: {
          serverId: "srv_1",
          serverInfo: { capabilities: { mainChat: true } },
          agents: new Map([
            [mainAgent.id, mainAgent],
            [quietFinishedChild.id, quietFinishedChild],
            [quietErrorChild.id, quietErrorChild],
            [loudFinishedChild.id, loudFinishedChild],
          ]),
          agentDetails: new Map(),
          pendingPermissions: new Map(),
          workspaces: new Map(),
        } as unknown as SessionState,
      },
    });

    const summary = selectMainChatSidebarSummary(useSessionStore.getState(), "srv_1");
    // Only quietErrorChild + loudFinishedChild count towards attentionCount; quietFinishedChild is suppressed!
    expect(summary.attentionCount).toBe(2);
    expect(summary.totalActiveCount).toBe(3);
  });
});
