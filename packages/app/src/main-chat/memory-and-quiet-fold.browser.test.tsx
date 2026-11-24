import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  isMainChatBackgroundFolded,
  isMainChatTasksQuiet,
  type MainChatConversationRecord,
  type MainChatMemoryFileContent,
  type MainChatMemoryFileMeta,
  type MainChatSettings,
  type MainChatSettingsPatch,
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
import { Switch } from "@/components/ui/switch";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import { MainChatMemoryProfilePanel } from "@/screens/settings/main-chat/memory-profile-panel";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import type { StreamItem } from "@/types/stream";
import { useMainChatConversationsStore } from "./conversations-store";
import { useMainChatSettingsStore } from "./settings-store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const browserToastApi = { show: vi.fn(), copied: vi.fn(), error: vi.fn(), dismiss: vi.fn() };
const noopBrowserHandler = vi.fn();

const SCREENSHOT_DIR =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_MAIN_CHAT_SCREENSHOT_DIR || "/tmp/main-chat-017525-screenshots";

function makeFixtureConversations(): MainChatConversationRecord[] {
  const now = "2026-11-24T12:00:00.000Z";
  return [
    {
      id: "conv_dir_ui",
      kind: "leader",
      agentId: "agent_dir_ui",
      workspaceId: "ws_main",
      title: "主对话交互与轨道对齐",
      directionSummary: "负责主对话流折叠条、设置面板与响应式布局验收",
      notes:
        "- 所有消息流条与底部 Composer 必须严格遵循 CHAT_COLUMN_RAIL_DATASET，左右边缘误差 <= 1px\n- Zustand selector 禁止返回新对象或新数组引用",
      parentConversationId: "conv_main",
      serverId: "srv_1",
      archivedAt: null,
      pinnedAsLeaderAt: now,
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
    },
    {
      id: "conv_dir_srv",
      kind: "leader",
      agentId: "agent_dir_srv",
      workspaceId: "ws_main",
      title: "服务端记忆与安全边界",
      directionSummary: "负责记忆文件目录穿越防护、确定性字节预算与任务静默继承",
      notes:
        "- 记忆目录严格限制在 ~/.paseo/main-chat/memory/，禁止 .. / 绝对路径 / 符号链接逃逸\n- task_plan 未显式传 quiet 时自动继承 mainTasksQuiet",
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

function makeFixtureMemoryClient(conversations: MainChatConversationRecord[]): DaemonClient {
  const files = new Map<string, MainChatMemoryFileContent>([
    [
      "MEMORY.md",
      {
        path: "MEMORY.md",
        content:
          "# 常驻工作偏好\n- 汇报结论先行，关键变更附可验证命令输出\n- 严禁重启 DevBox 6767 线上 Paseo Daemon",
        bytes: 124,
        updatedAt: "2026-11-24T12:00:00.000Z",
      },
    ],
    [
      "projects/paseo-wave1.md",
      {
        path: "projects/paseo-wave1.md",
        content: "# Wave 1 范围\n- P0-1 档案、方向笔记与轻量记忆 CRUD\n- P0-2 后台折叠与任务静默",
        bytes: 108,
        updatedAt: "2026-11-24T12:15:00.000Z",
      },
    ],
  ]);

  return {
    listMainChatConversations: vi.fn(async () => ({
      requestId: "req_conv_list",
      conversations,
      error: null,
    })),
    updateMainChatConversation: vi.fn(
      async (input: { conversationId: string; notes?: string | null }) => {
        const hit = conversations.find((c) => c.id === input.conversationId) ?? conversations[0]!;
        const updated = { ...hit, notes: input.notes ?? null };
        return { requestId: "req_conv_upd", conversation: updated, error: null };
      },
    ),
    listMainChatMemoryFiles: vi.fn(async () => ({
      requestId: "req_mem_list",
      files: Array.from(files.values()).map(
        ({ path, bytes, updatedAt }): MainChatMemoryFileMeta => ({ path, bytes, updatedAt }),
      ),
      error: null,
    })),
    readMainChatMemoryFile: vi.fn(async (filePath: string) => ({
      requestId: "req_mem_read",
      file: files.get(filePath) ?? null,
      error: files.has(filePath) ? null : `记忆文件不存在：${filePath}`,
    })),
    writeMainChatMemoryFile: vi.fn(async (filePath: string, content: string) => {
      const meta: MainChatMemoryFileMeta = {
        path: filePath,
        bytes: new TextEncoder().encode(content).byteLength,
        updatedAt: "2026-11-24T12:30:00.000Z",
      };
      files.set(filePath, { ...meta, content });
      return { requestId: "req_mem_write", file: meta, error: null };
    }),
    deleteMainChatMemoryFile: vi.fn(async (filePath: string) => ({
      requestId: "req_mem_del",
      deleted: files.delete(filePath),
      error: null,
    })),
  } as unknown as DaemonClient;
}

function buildBackgroundFoldTimeline(): StreamItem[] {
  const t1 = new Date("2026-11-24T12:01:00.000Z");
  const t2 = new Date("2026-11-24T12:05:00.000Z");
  const t3 = new Date("2026-11-24T12:08:00.000Z");
  return [
    {
      kind: "user_message",
      id: "user_1",
      timestamp: t1,
      text: "请持续看管 Wave 1 的服务端与前端子任务，正常进度保持静默，有阻塞或完成再汇报。",
    },
    {
      kind: "assistant_message",
      id: "asst_1",
      timestamp: t1,
      text: "收到，已开启后台静默督办模式。后续巡检与自动中继轮次会折叠为紧凑摘要条，需要你拍板时第一时间提醒。",
    },
    {
      kind: "tool_call",
      id: "bg_patrol_host",
      timestamp: t2,
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "paseo-system:patrol-1",
          name: "heartbeat",
          status: "completed",
          error: null,
          detail: {
            type: "plain_text",
            text: "📋 督办 · 主动巡检唤醒：扫描 3 个活跃子任务，发现 1 个已完成待复核",
          },
          metadata: {
            mainChatBackground: {
              foldable: true,
              kind: "patrol",
              trigger: "patrol_wakeup",
              label: "扫描 3 个子任务 · 1 项待复核",
              activityId: "act_patrol_1",
              quiet: true,
            },
          },
        },
      },
    },
    {
      kind: "tool_call",
      id: "tool_activity_check",
      timestamp: t2,
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "call_get_activity_1",
          name: "get_agent_activity",
          status: "completed",
          error: null,
          detail: {
            type: "plain_text",
            text: "已核验 memory.ts 单测 154/154 通过，路径穿越测试全部拒绝。",
          },
        },
      },
    },
    {
      kind: "assistant_message",
      id: "asst_patrol_reply",
      timestamp: t2,
      text: "后台巡检已独立复核 P0-1 服务端记忆模块：CRUD、路径穿越拦截与确定性字节预算单测全部通过。",
    },
    {
      kind: "tool_call",
      id: "bg_relay_host",
      timestamp: t3,
      payload: {
        source: "agent",
        data: {
          provider: "claude",
          callId: "paseo-agent-message:relay-1",
          name: "agent_message",
          status: "completed",
          error: null,
          detail: {
            type: "plain_text",
            text: "子任务「前端折叠条与设置面板」已提交完成回报",
          },
          metadata: {
            mainChatBackground: {
              foldable: true,
              kind: "relay",
              trigger: "agent_notification:finished",
              label: "自动中继 · 前端折叠条与设置面板已完成",
              quiet: true,
            },
          },
        },
      },
    },
    {
      kind: "assistant_message",
      id: "asst_relay_reply",
      timestamp: t3,
      text: "前端折叠条与设置面板已完成，正在执行宽/窄屏与暗色主题浏览器验收。",
    },
  ];
}

function InteractiveBackgroundFoldStream({
  initialExpandedHostIds = [],
  compact = false,
}: {
  initialExpandedHostIds?: string[];
  compact?: boolean;
}): ReactElement {
  const [expandedHostIds, setExpandedHostIds] = useState<ReadonlySet<string>>(
    () => new Set(initialExpandedHostIds),
  );
  const items = useMemo(() => buildBackgroundFoldTimeline(), []);
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
      testID="p02-stream-surface"
    >
      <ChatColumnRailSurface serverId="srv_1">
        <View style={compact ? sceneStyles.streamViewportCompact : sceneStyles.streamViewport}>
          <View style={sceneStyles.railOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
            <View style={sceneStyles.railInner} testID="p02-message-column">
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
                if (item.kind === "tool_call") {
                  const detailText =
                    item.payload.source === "agent" &&
                    item.payload.data.detail.type === "plain_text"
                      ? (item.payload.data.detail.text ?? "")
                      : "";
                  return (
                    <View
                      key={item.id}
                      style={[
                        sceneStyles.expandedDetailRow,
                        isNested ? sceneStyles.nestedIndentRow : null,
                      ]}
                      testID={`expanded-detail-${item.id}`}
                    >
                      <Text style={sceneStyles.expandedDetailTitle}>
                        {item.payload.source === "agent" ? item.payload.data.name : "tool"}
                      </Text>
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
            <View style={sceneStyles.composerCard} testID="p02-composer-baseline">
              <Text style={sceneStyles.composerPlaceholder}>
                给主对话发消息…（Enter 发送，后台督办轮次默认折叠）
              </Text>
            </View>
          </View>
        </View>
      </ChatColumnRailSurface>
    </View>
  );
}

function InteractiveSettingsMemoryShowcase({
  client,
  initialSettings,
  twoColumn = false,
}: {
  client: DaemonClient;
  initialSettings: MainChatSettings;
  twoColumn?: boolean;
}): ReactElement {
  const [settings, setSettings] = useState<MainChatSettings>(initialSettings);

  const handlePatch = useCallback((patch: MainChatSettingsPatch) => {
    setSettings((prev) => ({
      ...prev,
      ...(patch.mainBackgroundFolded !== undefined
        ? { mainBackgroundFolded: patch.mainBackgroundFolded }
        : {}),
      ...(patch.mainTasksQuiet !== undefined ? { mainTasksQuiet: patch.mainTasksQuiet } : {}),
      ...(patch.profile
        ? {
            profile: {
              aboutMe: patch.profile.aboutMe ?? prev.profile?.aboutMe ?? "",
              ownerAliases: patch.profile.ownerAliases ?? prev.profile?.ownerAliases ?? [],
              updatedAt: new Date().toISOString(),
            },
          }
        : {}),
    }));
  }, []);

  const handleToggleBackgroundFolded = useCallback(
    (next: boolean) => handlePatch({ mainBackgroundFolded: next }),
    [handlePatch],
  );
  const handleToggleTasksQuiet = useCallback(
    (next: boolean) => handlePatch({ mainTasksQuiet: next }),
    [handlePatch],
  );

  const switchesSection = (
    <SettingsSection
      title="消息流折叠与静默策略"
      info="控制主对话后台督办/巡检轮次的展示方式，以及派发子任务时的默认静默提醒级别。"
      testID="settings-main-chat-quiet-fold"
    >
      <View style={settingsStyles.card}>
        <View style={[settingsStyles.row, sceneStyles.switchRow]}>
          <View style={sceneStyles.rowText}>
            <Text style={settingsStyles.rowTitle}>后台轮次默认折叠</Text>
            <Text style={settingsStyles.rowHint}>
              在主对话消息流中将后台督办、巡检与自动中继轮次默认折叠为紧凑单行摘要条，点击可原地展开。
            </Text>
          </View>
          <Switch
            value={isMainChatBackgroundFolded(settings)}
            onValueChange={handleToggleBackgroundFolded}
            testID="settings-main-chat-background-folded"
          />
        </View>
        <View style={[settingsStyles.row, settingsStyles.rowBorder, sceneStyles.switchRow]}>
          <View style={sceneStyles.rowText}>
            <Text style={settingsStyles.rowTitle}>主对话任务默认静默</Text>
            <Text style={settingsStyles.rowHint}>
              task_plan 未显式传 quiet 时继承此开关，抑制常规完成通知与未读红点。
            </Text>
          </View>
          <Switch
            value={isMainChatTasksQuiet(settings)}
            onValueChange={handleToggleTasksQuiet}
            testID="settings-main-chat-tasks-quiet"
          />
        </View>
      </View>
    </SettingsSection>
  );

  const memorySection = (
    <SettingsSection
      title="档案与记忆"
      info="维护个人档案、各方向主管独立笔记以及 ~/.paseo/main-chat/memory/ 下的轻量记忆文件。"
      testID="settings-main-chat-memory-profile"
    >
      <MainChatMemoryProfilePanel
        serverId="srv_1"
        client={client}
        settings={settings}
        disabled={false}
        onApplyPatch={handlePatch}
      />
    </SettingsSection>
  );

  if (twoColumn) {
    return (
      <View style={sceneStyles.wideTwoColSettings} testID="p01-settings-container">
        <View style={sceneStyles.wideLeftCol}>{switchesSection}</View>
        <View style={sceneStyles.wideRightCol}>{memorySection}</View>
      </View>
    );
  }

  return (
    <View style={sceneStyles.settingsPage} testID="p01-settings-container">
      {switchesSection}
      {memorySection}
    </View>
  );
}

describe("Wave 1 P0-1 & P0-2 real Chromium visual & layout verification", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;

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

    const now = new Date("2026-11-24T12:00:00.000Z");
    const mainAgent = {
      id: "agent_main",
      serverId: "srv_1",
      workspaceId: "ws_main",
      provider: "claude",
      status: "idle",
      lifecycle: "idle",
      cwd: "/home/dev/.paseo/main-chat",
      title: "对话管理",
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
    useMainChatSettingsStore.getState().hydrateSettings("srv_1", {
      ...createDefaultMainChatSettings(),
      enabled: true,
      mainBackgroundFolded: true,
      mainTasksQuiet: true,
      profile: {
        aboutMe:
          "## 工作偏好\n- 结论先行，附真实命令与实测证据\n- 严格遵循 TypeScript 与 Zustand selector 稳定性约束",
        ownerAliases: ["老卡", "Shaw"],
        updatedAt: "2026-11-24T12:00:00.000Z",
      },
    });
    useMainChatConversationsStore.getState().reset();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    queryClient.clear();
    host.remove();
    UnistylesRuntime.setTheme("light");
  });

  function renderInBrowser(element: ReactElement): void {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastApiProvider api={browserToastApi}>{element}</ToastApiProvider>
        </QueryClientProvider>,
      );
    });
  }

  async function waitForLayoutFrame(): Promise<void> {
    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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
      `${label} left (${rect.left}) must align with baseline (${baseline.left}) within <= 1px`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(rect.right - baseline.right),
      `${label} right (${rect.right}) must align with baseline (${baseline.right}) within <= 1px`,
    ).toBeLessThanOrEqual(1);
  }

  it("01: renders wide 1440x900 Settings Profile & Memory + Quiet/Fold toggles with zero overflow or clipping", async () => {
    await page.viewport(1440, 900);
    const conversations = makeFixtureConversations();
    const client = makeFixtureMemoryClient(conversations);
    const settings = useMainChatSettingsStore.getState().settingsByServerId.srv_1!;

    renderInBrowser(
      <View style={sceneStyles.wideSettingsShell}>
        <InteractiveSettingsMemoryShowcase client={client} initialSettings={settings} twoColumn />
      </View>,
    );
    await waitForLayoutFrame();

    const openBtn = host.querySelector<HTMLElement>('[data-testid="memory-file-open-MEMORY.md"]');
    expect(openBtn).toBeTruthy();

    const settingsContainer = host.querySelector<HTMLElement>(
      '[data-testid="p01-settings-container"]',
    )!;
    expect(settingsContainer).toBeTruthy();
    assertNoHorizontalOverflow(settingsContainer, "Wide 1440x900 Settings Memory Panel");

    // Verify full 1440x900 settings overview fits cleanly without bottom clipping
    const filesSection = host.querySelector<HTMLElement>(
      '[data-testid="memory-profile-files-section"]',
    )!;
    expect(filesSection).toBeTruthy();
    expect(filesSection.getBoundingClientRect().bottom).toBeLessThanOrEqual(900);

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-wide-settings-memory.png`,
    });

    // Also verify clicking a memory file opens the inline editor cleanly with zero overflow
    await act(async () => {
      openBtn!.click();
    });
    await waitForLayoutFrame();
    expect(host.querySelector('[data-testid="memory-file-editor"]')).toBeTruthy();
    assertNoHorizontalOverflow(
      settingsContainer,
      "Wide 1440x900 Settings Memory Panel (editor open)",
    );
  });

  it("02: renders wide 1440x900 Main Chat stream with Rail, verifies <=1px alignment and click expand/collapse in-place", async () => {
    await page.viewport(1440, 900);
    renderInBrowser(<InteractiveBackgroundFoldStream />);
    await waitForLayoutFrame();

    const activeRail = host.querySelector<HTMLElement>('[data-chat-rail-active="true"]');
    expect(activeRail).toBeTruthy();

    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="p02-composer-baseline"]')!
      .getBoundingClientRect();
    const messageColumn = host
      .querySelector<HTMLElement>('[data-testid="p02-message-column"]')!
      .getBoundingClientRect();
    const patrolBar = host.querySelector<HTMLElement>(
      '[data-testid="background-turn-summary-bg_patrol_host"]',
    );
    const relayBar = host.querySelector<HTMLElement>(
      '[data-testid="background-turn-summary-bg_relay_host"]',
    );

    assertEdgeAligned("Patrol fold bar vs Composer", patrolBar, composerBaseline);
    assertEdgeAligned("Patrol fold bar vs Message column", patrolBar, messageColumn);
    assertEdgeAligned("Relay fold bar vs Composer", relayBar, composerBaseline);
    expect(patrolBar!.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[data-testid="expanded-detail-tool_activity_check"]')).toBeNull();

    // Capture collapsed default state screenshot on 1440x900 wide screen
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-wide-stream-background-fold.png`,
    });

    // Click to expand in place
    await act(async () => {
      patrolBar!.click();
    });
    await waitForLayoutFrame();

    expect(patrolBar!.getAttribute("aria-expanded")).toBe("true");
    expect(host.querySelector('[data-testid="expanded-detail-bg_patrol_host"]')).toBeTruthy();
    expect(host.querySelector('[data-testid="expanded-detail-tool_activity_check"]')).toBeTruthy();
    assertEdgeAligned("Expanded patrol fold bar vs Composer", patrolBar, composerBaseline);

    // Click again to collapse back cleanly
    await act(async () => {
      patrolBar!.click();
    });
    await waitForLayoutFrame();

    expect(patrolBar!.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector('[data-testid="expanded-detail-tool_activity_check"]')).toBeNull();
  });

  it("03: renders narrow 390x844 mobile viewport for both background fold stream and settings memory panel with <=1px alignment and zero horizontal overflow", async () => {
    await page.viewport(390, 844);
    const conversations = makeFixtureConversations();
    const client = makeFixtureMemoryClient(conversations);
    const settings = useMainChatSettingsStore.getState().settingsByServerId.srv_1!;

    // First verify the full narrow 390x844 Settings Memory Panel renders with zero overflow or clipping
    renderInBrowser(
      <View style={sceneStyles.narrowStack} testID="p03-narrow-settings-root">
        <InteractiveSettingsMemoryShowcase client={client} initialSettings={settings} />
      </View>,
    );
    await waitForLayoutFrame();

    const narrowSettingsRoot = host.querySelector<HTMLElement>(
      '[data-testid="p03-narrow-settings-root"]',
    )!;
    const settingsContainer = host.querySelector<HTMLElement>(
      '[data-testid="p01-settings-container"]',
    )!;
    assertNoHorizontalOverflow(narrowSettingsRoot, "Narrow 390x844 settings root");
    assertNoHorizontalOverflow(settingsContainer, "Narrow 390x844 Settings Memory Panel");

    // Next render the combined narrow 390x844 UI (folded stream + composer + Quiet/Fold switches) fitting cleanly in 844px
    renderInBrowser(
      <View style={sceneStyles.narrowStack} testID="p03-narrow-root">
        <View style={sceneStyles.narrowStreamBox}>
          <InteractiveBackgroundFoldStream compact />
        </View>
        <SettingsSection
          title="消息流折叠与静默策略"
          info="控制主对话后台督办/巡检轮次的展示方式，以及派发子任务时的默认静默提醒级别。"
          testID="settings-main-chat-quiet-fold"
        >
          <View style={settingsStyles.card}>
            <View style={[settingsStyles.row, sceneStyles.switchRow]}>
              <View style={sceneStyles.rowText}>
                <Text style={settingsStyles.rowTitle}>后台轮次默认折叠</Text>
                <Text style={settingsStyles.rowHint}>
                  后台督办、巡检与自动中继默认折叠为单行摘要条。
                </Text>
              </View>
              <Switch
                value={isMainChatBackgroundFolded(settings)}
                onValueChange={noopBrowserHandler}
              />
            </View>
            <View style={[settingsStyles.row, settingsStyles.rowBorder, sceneStyles.switchRow]}>
              <View style={sceneStyles.rowText}>
                <Text style={settingsStyles.rowTitle}>主对话任务默认静默</Text>
                <Text style={settingsStyles.rowHint}>
                  未显式传 quiet 时默认静默，抑制常规完成提醒。
                </Text>
              </View>
              <Switch value={isMainChatTasksQuiet(settings)} onValueChange={noopBrowserHandler} />
            </View>
          </View>
        </SettingsSection>
      </View>,
    );
    await waitForLayoutFrame();

    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="p02-composer-baseline"]')!
      .getBoundingClientRect();
    const patrolBar = host.querySelector<HTMLElement>(
      '[data-testid="background-turn-summary-bg_patrol_host"]',
    );
    assertEdgeAligned("Narrow 390px Patrol fold bar vs Composer", patrolBar, composerBaseline);

    const narrowRoot = host.querySelector<HTMLElement>('[data-testid="p03-narrow-root"]')!;
    assertNoHorizontalOverflow(narrowRoot, "Narrow 390x844 root");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-narrow-390-ui.png`,
    });
  });

  it("04: renders wide 1440x900 dark theme showing expanded/collapsed background fold bars and Profile & Memory panel", async () => {
    await page.viewport(1440, 900);
    UnistylesRuntime.setTheme("dark");
    document.body.style.backgroundColor = "#18181b";

    const conversations = makeFixtureConversations();
    const client = makeFixtureMemoryClient(conversations);
    const settings = useMainChatSettingsStore.getState().settingsByServerId.srv_1!;

    renderInBrowser(
      <View style={sceneStyles.darkShowcaseGrid} testID="p04-dark-root">
        <View style={sceneStyles.darkStreamPane}>
          <InteractiveBackgroundFoldStream initialExpandedHostIds={["bg_patrol_host"]} />
        </View>
        <View style={sceneStyles.darkSettingsPane} testID="p01-settings-container">
          <SettingsSection
            title="档案与记忆"
            info="暗色主题下的个人档案、方向笔记与常驻记忆文件面板。"
            testID="settings-main-chat-memory-profile"
          >
            <MainChatMemoryProfilePanel
              serverId="srv_1"
              client={client}
              settings={settings}
              disabled={false}
              onApplyPatch={noopBrowserHandler}
            />
          </SettingsSection>
        </View>
      </View>,
    );
    await waitForLayoutFrame();

    const composerBaseline = host
      .querySelector<HTMLElement>('[data-testid="p02-composer-baseline"]')!
      .getBoundingClientRect();
    const patrolBar = host.querySelector<HTMLElement>(
      '[data-testid="background-turn-summary-bg_patrol_host"]',
    );
    const relayBar = host.querySelector<HTMLElement>(
      '[data-testid="background-turn-summary-bg_relay_host"]',
    );
    assertEdgeAligned("Dark theme expanded patrol bar vs Composer", patrolBar, composerBaseline);
    assertEdgeAligned("Dark theme collapsed relay bar vs Composer", relayBar, composerBaseline);
    expect(patrolBar!.getAttribute("aria-expanded")).toBe("true");
    expect(relayBar!.getAttribute("aria-expanded")).toBe("false");

    const settingsContainer = host.querySelector<HTMLElement>(
      '[data-testid="p01-settings-container"]',
    )!;
    assertNoHorizontalOverflow(settingsContainer, "Dark theme Settings Memory Panel");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-wide-dark-theme.png`,
    });
    document.body.style.backgroundColor = "";
  });
});

const sceneStyles = StyleSheet.create((theme) => ({
  wideSettingsShell: {
    width: "100%",
    height: 900,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[4],
    alignItems: "center",
    overflow: "hidden",
  },
  wideTwoColSettings: {
    width: "100%",
    maxWidth: 1320,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[6],
  },
  wideLeftCol: {
    width: 440,
    flexShrink: 0,
  },
  wideRightCol: {
    flex: 1,
    minWidth: 0,
  },
  settingsPage: {
    width: "100%",
    maxWidth: 780,
    gap: 0,
    backgroundColor: theme.colors.surface0,
  },
  switchRow: {
    justifyContent: "space-between",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  streamSurface: {
    width: "100%",
    minHeight: 740,
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  streamSurfaceCompact: {
    width: "100%",
    backgroundColor: theme.colors.surface0,
  },
  streamViewport: {
    flex: 1,
    paddingTop: theme.spacing[6],
    paddingBottom: theme.spacing[4],
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
    minHeight: 68,
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
    height: 900,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[6],
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[4],
    overflow: "hidden",
  },
  darkStreamPane: {
    flex: 1,
    minWidth: 0,
    height: 836,
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
  },
  darkSettingsPane: {
    width: 600,
    flexShrink: 0,
  },
}));
