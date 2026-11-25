import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  FEISHU_BRIDGE_PLUGIN_ID,
  FEISHU_BRIDGE_WEBHOOK_PATH,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  createDefaultMainChatSettings,
  type FeishuBridgeAuditRecord,
  type FeishuBridgeConnectionTestResult,
  type FeishuBridgeSendTestCardResult,
  type FeishuBridgeState,
  type MainChatOverview,
  type MainChatSettings,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { CHAT_COLUMN_RAIL_DATASET, ChatColumnRailSurface } from "@/chat-rail";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { i18n } from "@/i18n/i18next";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatFeishuBridgePanel } from "@/screens/settings/main-chat/feishu-bridge-panel";
import { MainChatNotificationPolicyPanel } from "@/screens/settings/main-chat/notification-policy-panel";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import {
  MainChatActionBar,
  MainChatActionBarDrawerOverlay,
  useMainChatActionBarDrawerStore,
} from "./action-bar";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { useMainChatSettingsStore } from "./settings-store";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const browserToastApi = { show: vi.fn(), copied: vi.fn(), error: vi.fn(), dismiss: vi.fn() };
const noopFn = () => undefined;

const SCREENSHOT_DIR =
  (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env
    ?.VITE_MAIN_CHAT_SCREENSHOT_DIR || "/tmp/main-chat-017530-screenshots";

const WAVE6_AUDIT_RECORDS: readonly FeishuBridgeAuditRecord[] = [
  {
    id: "faud_w6_1",
    direction: "outbound",
    kind: "outbound_permission_card",
    status: "succeeded",
    title: "推送权限审批卡：API 发布门禁核验",
    summary: "工具 Bash（npm run db:check），已附带「批准执行 / 拒绝请求」回调按钮",
    errorCode: null,
    latencyMs: 36,
    messageId: "om_w6_perm_001",
    actorOpenId: null,
    eventOrActionId: "perm_w6_001",
    tier: "critical",
    createdAt: "2026-11-25T09:12:00.000Z",
  },
  {
    id: "faud_w6_2",
    direction: "inbound",
    kind: "inbound_permission_action",
    status: "succeeded",
    title: "飞书权限审批回写：已批准",
    summary: "SHA-256 签名与白名单校验通过，已回写批准并更新飞书卡片为终态",
    errorCode: null,
    latencyMs: 18,
    messageId: "om_w6_perm_001",
    actorOpenId: "ou_owner_main",
    eventOrActionId: "perm:agent_child:perm_w6_001:allow",
    tier: "critical",
    createdAt: "2026-11-25T09:12:14.000Z",
  },
  {
    id: "faud_w6_3",
    direction: "inbound",
    kind: "inbound_deduplicated",
    status: "deduplicated",
    title: "重复回调已幂等去重",
    summary: "已忽略重复点击事件 perm:agent_child:perm_w6_001:allow，零重复执行",
    errorCode: "deduplicated",
    latencyMs: null,
    messageId: "om_w6_perm_001",
    actorOpenId: "ou_owner_main",
    eventOrActionId: "perm:agent_child:perm_w6_001:allow",
    tier: null,
    createdAt: "2026-11-25T09:12:16.000Z",
  },
  {
    id: "faud_w6_4",
    direction: "inbound",
    kind: "inbound_rejected",
    status: "rejected",
    title: "拒绝异常飞书回调（sender_not_allowed）",
    summary: "操作人 ou_unknown_99 不在允许操作人 Open ID 白名单中",
    errorCode: "sender_not_allowed",
    latencyMs: null,
    messageId: null,
    actorOpenId: "ou_unknown_99",
    eventOrActionId: "evt_unauth_99",
    tier: null,
    createdAt: "2026-11-25T09:13:00.000Z",
  },
];

function makeWave6BridgeState(): FeishuBridgeState {
  return {
    pluginAvailable: true,
    pluginId: FEISHU_BRIDGE_PLUGIN_ID,
    active: true,
    webhookPath: FEISHU_BRIDGE_WEBHOOK_PATH,
    webhookUrl: `http://127.0.0.1:6768${FEISHU_BRIDGE_WEBHOOK_PATH}`,
    config: {
      enabled: true,
      domainPreset: "feishu",
      apiBaseUrl: "https://open.feishu.cn",
      appId: "cli_paseo_feishu_bridge",
      hasAppSecret: true,
      appSecretMask: "••••4a9f",
      hasVerificationToken: true,
      verificationTokenMask: "••••8c21",
      hasEncryptKey: true,
      encryptKeyMask: "••••7d0e",
      receiveIdType: "chat_id",
      receiveId: "oc_paseo_ops_room_01",
      allowedOpenIds: ["ou_owner_main", "ou_release_lead"],
      forwardTiers: ["critical", "actionable"],
      respectLowDistraction: true,
      replayWindowSeconds: 300,
      requireSignature: true,
      updatedAt: "2026-11-25T09:10:00.000Z",
    },
    stats: {
      outboundSent: 6,
      outboundFailed: 0,
      inboundProcessed: 3,
      inboundRejected: 1,
      inboundDeduplicated: 1,
      lastOutboundAt: "2026-11-25T09:12:00.000Z",
      lastInboundAt: "2026-11-25T09:13:00.000Z",
    },
    recentAudit: [...WAVE6_AUDIT_RECORDS],
  };
}

function makeWave6ConnectionResult(): FeishuBridgeConnectionTestResult {
  return {
    ok: true,
    latencyMs: 28,
    apiBaseUrl: "https://open.feishu.cn",
    statusCode: 200,
    tokenExpiresInSec: 7180,
    cachedTokenReused: false,
    errorCode: null,
    message: "连接成功（已签发新 tenant_access_token，有效期 7180 秒；全链路脱敏）",
    troubleshootingHint: null,
    testedAt: "2026-11-25T09:14:00.000Z",
  };
}

function makeWave6TestCardResult(): FeishuBridgeSendTestCardResult {
  return {
    ok: true,
    latencyMs: 42,
    messageId: "om_w6_test_card_008",
    receiveId: "oc_paseo_ops_room_01",
    receiveIdType: "chat_id",
    errorCode: null,
    message: "测试卡片发送成功（message_id: om_w6_test_card_008）",
    troubleshootingHint: null,
    sentAt: "2026-11-25T09:14:04.000Z",
  };
}

function makeWave6Settings(): MainChatSettings {
  const base = createDefaultMainChatSettings();
  return {
    ...base,
    enabled: true,
    style: "conservative",
    notificationPolicy: {
      mode: "low_distraction",
      lowDistractionEnabled: true,
      foldLowPriorityToDigest: true,
      categoryOverrides: {},
    },
  };
}

function makeWave6Tasks(): MainChatTaskRecord[] {
  const now = "2026-11-25T09:12:00.000Z";
  return [
    {
      id: "task_w6_running",
      mainAgentId: "agent_main",
      planId: "plan_w6",
      plannedTaskId: "pt_w6_1",
      title: "API 发布门禁核验（飞书已批准）",
      goal: "完成数据库迁移检查并汇总验证报告",
      mode: "write",
      isolation: "worktree",
      status: "running",
      serverId: "srv_1",
      hostLabel: "DevBox-Main",
      cwd: "/repo/paseo-fork",
      workspaceId: "ws_1",
      activeAgentId: "agent_w6_child",
      agentIds: ["agent_w6_child"],
      brief: {
        goal: "完成数据库迁移检查",
        doneWhen: ["db:check 绿灯", "飞书卡片收敛终态"],
        outOfBounds: ["不触碰生产库"],
        scopeRevision: 1,
        updatedAt: now,
      },
      decisions: [],
      quiet: false,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    } as unknown as MainChatTaskRecord,
  ];
}

function makeAgent(
  id: string,
  title: string,
  status: Agent["status"],
  labels: Record<string, string>,
): Agent {
  const now = new Date("2026-11-25T09:15:00.000Z");
  return {
    serverId: "srv_1",
    id,
    workspaceId: "ws_1",
    provider: "claude",
    status,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    title,
    cwd: "/repo/paseo-fork",
    model: "claude-sonnet-4-6",
    requiresAttention: false,
    attentionReason: null,
    parentAgentId: null,
    labels,
    metadata: {},
    turn: { phase: "idle" },
    backgroundWork: { count: 0 },
  } as unknown as Agent;
}

function Wave6MainChatColumn({ compact = false }: { compact?: boolean }): ReactElement {
  return (
    <View
      style={compact ? sceneStyles.narrowMainScene : sceneStyles.wideMainColumn}
      testID="wave6-main-column"
    >
      <ChatColumnRailSurface serverId="srv_1">
        <View style={sceneStyles.streamSurface} testID="wave6-stream-surface">
          <View style={sceneStyles.streamTranscriptOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
            <View style={sceneStyles.streamTranscript}>
              <View style={sceneStyles.messageBubble} testID="wave6-message-column">
                <Text style={sceneStyles.messageHeading}>
                  总控主对话 · Wave 6 飞书机器人插件桥接（feishu-bot-bridge）
                </Text>
                <Text style={sceneStyles.messageBody}>
                  权限审批卡「API 发布门禁核验」已推送至飞书群聊并由白名单操作人 ou_owner_main
                  验签批准，卡片已自动更新至终态；未启用时零后台轮询，所有密钥与 Token
                  全链路脱敏且严守保守模式 A 红线。
                </Text>
              </View>
            </View>
          </View>
          <MainChatActionBarDrawerOverlay serverId="srv_1" agentId="agent_main" />
        </View>

        <View style={sceneStyles.bottomStack}>
          <MainChatActionBar serverId="srv_1" agentId="agent_main" drawerMode="external" />
          <View style={sceneStyles.composerOuter} dataSet={CHAT_COLUMN_RAIL_DATASET}>
            <View style={sceneStyles.composerInner} testID="wave6-composer-baseline">
              <Text style={sceneStyles.composerHint}>向总控主对话发送指令或查看飞书桥接回执…</Text>
            </View>
          </View>
        </View>
      </ChatColumnRailSurface>
    </View>
  );
}

describe("Wave 6 (P2-1) Feishu Bot Bridge real Chromium visual & layout verification", () => {
  let host: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let fixtureSettings: MainChatSettings;
  let fixtureBridgeState: FeishuBridgeState;
  let fixtureClient: DaemonClient;
  let fixtureOverview: MainChatOverview;

  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
    UnistylesRuntime.setTheme("light");
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    document.body.style.margin = "0";
    document.body.style.padding = "0";
    host = document.createElement("div");
    host.style.width = "100%";
    host.style.boxSizing = "border-box";
    document.body.appendChild(host);
    root = createRoot(host);

    fixtureSettings = makeWave6Settings();
    fixtureBridgeState = makeWave6BridgeState();
    const tasks = makeWave6Tasks();
    fixtureClient = {
      getMainChatFeishuBridgeState: vi.fn(async () => ({
        requestId: "req_1",
        state: fixtureBridgeState,
        error: null,
      })),
      updateMainChatFeishuBridgeConfig: vi.fn(async () => ({
        requestId: "req_2",
        state: fixtureBridgeState,
        error: null,
      })),
      testMainChatFeishuBridgeConnection: vi.fn(async () => ({
        requestId: "req_3",
        result: makeWave6ConnectionResult(),
        error: null,
      })),
      sendMainChatFeishuBridgeTestCard: vi.fn(async () => ({
        requestId: "req_4",
        result: makeWave6TestCardResult(),
        error: null,
      })),
      listMainChatFeishuBridgeAudit: vi.fn(async () => ({
        requestId: "req_5",
        records: [...WAVE6_AUDIT_RECORDS],
        stats: fixtureBridgeState.stats,
        error: null,
      })),
      listMainChatNotificationReceipts: vi.fn(async () => ({
        requestId: "req_n1",
        receipts: [],
        summary: {
          lowDistractionEnabled: true,
          mode: "low_distraction" as const,
          unreadCount: 0,
          deliveredCount: 4,
          suppressedQuietCount: 5,
          suppressedNightCount: 0,
          foldedDigestCount: 5,
          criticalPassthroughCount: 2,
          latestReceiptAt: "2026-11-25T09:12:00.000Z",
        },
        error: null,
      })),
    } as unknown as DaemonClient;

    fixtureOverview = {
      plans: [],
      decisions: [],
      autoStartRules: [],
      permissionRules: [],
      metrics: {
        autoContinued: 3,
        plansCreated: 1,
        plansAutoStarted: 0,
        plansStarted: 1,
        plansCancelled: 0,
        receiptsRecorded: 4,
        interrupts: 1,
        supervisorHeld: 0,
        reworkCount: 0,
        stalledNudges: 0,
        usageLimitRetries: 0,
        patrolRuns: 4,
        triageRuleCount: 6,
        triageModelCount: 0,
      },
      settings: fixtureSettings,
      triages: [],
      lastPatrolAt: "2026-11-25T09:10:00.000Z",
      lastWakeupAt: "2026-11-25T09:12:00.000Z",
      recentActivityCount: 4,
      tasks,
      conversations: [],
      fleetHosts: [],
      standingAuthorizations: [],
      ruleSuggestions: [],
      pendingClarifications: [],
      nextStepSuggestions: [],
      recentReceipts: [],
      settingsProposals: [],
      projectLessons: [],
      recentLimitFallbacks: [],
    };

    useSessionStore.setState({
      sessions: {
        srv_1: {
          client: fixtureClient,
          agents: new Map([
            [
              "agent_main",
              makeAgent("agent_main", "总控主对话", "idle", {
                [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE,
              }),
            ],
            ["agent_w6_child", makeAgent("agent_w6_child", tasks[0]!.title, "running", {})],
          ]),
          agentDetails: new Map(),
          workspaces: new Map(),
          pendingPermissions: new Map(),
        } as unknown as SessionState,
      },
    });
    useMainChatOverviewStore.setState({
      overviewsByKey: {
        [overviewStoreKey("srv_1", "agent_main")]: fixtureOverview,
      },
      decisionsByKey: {},
      settingsProposalsByKey: {},
      activeAgentOverrideByServerId: {},
    });
    useMainChatSettingsStore.setState({
      settingsByServerId: { srv_1: fixtureSettings },
      nightModeStatusByServerId: {},
      cacheKeepaliveStatusByServerId: {},
      notificationSummaryByServerId: {},
      usageByServerId: {},
      usageLoadingByServerId: {},
      loadingByServerId: {},
      lastPatrolByServerId: {},
    });
    useMainChatActionBarDrawerStore.setState({
      openBucketByKey: {},
      expandedByKey: {},
      focusedNeedsIdByKey: {},
      compactDockCollapsedByKey: {},
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    queryClient.clear();
  });

  function renderInBrowser(node: ReactElement): void {
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <KeyboardActionDispatcherProvider>
            <ToastApiProvider api={browserToastApi}>{node}</ToastApiProvider>
          </KeyboardActionDispatcherProvider>
        </QueryClientProvider>,
      );
    });
  }

  async function waitForLayoutFrame(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 70));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
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

  function assertRailAligned(container: HTMLElement, label: string): void {
    const composer = container.querySelector<HTMLElement>(
      "[data-testid='wave6-composer-baseline']",
    );
    const message = container.querySelector<HTMLElement>("[data-testid='wave6-message-column']");
    const actionBar = container.querySelector<HTMLElement>(
      "[data-testid='main-chat-action-bar-inner']",
    );
    expect(composer, `${label}: composer baseline missing`).toBeTruthy();
    expect(message, `${label}: message column missing`).toBeTruthy();
    expect(actionBar, `${label}: action bar inner rail missing`).toBeTruthy();
    const baseRect = composer!.getBoundingClientRect();
    const msgRect = message!.getBoundingClientRect();
    const barRect = actionBar!.getBoundingClientRect();
    expect(Math.abs(msgRect.left - baseRect.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(msgRect.right - baseRect.right)).toBeLessThanOrEqual(1);
    expect(Math.abs(barRect.left - baseRect.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(barRect.right - baseRect.right)).toBeLessThanOrEqual(1);
    expect(baseRect.width).toBeGreaterThan(200);
  }

  it("01: renders wide 1440x900 light Settings -> Feishu Bot Bridge (Plugin) configuration & Notification Policy cleanly", async () => {
    await page.viewport(1440, 900);

    renderInBrowser(
      <View style={sceneStyles.settingsDualGrid} testID="wave6-settings-shell">
        <View style={sceneStyles.settingsCol}>
          <SettingsSection
            title="飞书机器人桥接（插件）"
            info="由独立内置插件 feishu-bot-bridge 隔离承载，默认关闭且零后台轮询；密钥全链路脱敏。"
            testID="settings-main-chat-feishu-bridge"
          >
            <MainChatFeishuBridgePanel
              serverId="srv_1"
              client={fixtureClient}
              initialState={fixtureBridgeState}
            />
          </SettingsSection>
        </View>
        <View style={sceneStyles.settingsCol}>
          <SettingsSection
            title="通知分级与低打扰策略"
            info="飞书桥接自动遵循 Wave 4 通知分级、低打扰折叠与关键审批/故障穿透规则。"
            testID="settings-main-chat-notification-policy"
          >
            <MainChatNotificationPolicyPanel
              serverId="srv_1"
              client={fixtureClient}
              settings={fixtureSettings}
              initialReceipts={[]}
              onApplyPatch={noopFn}
            />
          </SettingsSection>
        </View>
      </View>,
    );
    await waitForLayoutFrame();

    const shell = host.querySelector<HTMLElement>("[data-testid='wave6-settings-shell']")!;
    expect(shell.textContent).toContain("飞书机器人桥接（插件）");
    expect(shell.textContent).toContain("••••4a9f");
    expect(shell.textContent).toContain("保守模式 A 守卫");
    expect(shell.textContent).not.toContain("mainChat.feishuBridge.");
    assertNoHorizontalOverflow(shell, "01 Wide 1440x900 Settings Feishu Bridge");

    await page.viewport(1440, Math.max(900, Math.ceil(shell.scrollHeight)));
    await waitForLayoutFrame();
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-wide-settings-feishu-bridge.png`,
    });
  });

  it("02: renders wide 1440x900 light Connectivity Test, Test Card Result, Audit Ledger & aligned Main Chat Rail", async () => {
    await page.viewport(1440, 900);

    renderInBrowser(
      <View style={sceneStyles.viewportSplitWide} testID="wave6-test-audit-shell">
        <View style={sceneStyles.wideLeftMain}>
          <Wave6MainChatColumn />
        </View>
        <ScrollView style={sceneStyles.wideRightScroll} testID="wave6-right-scroll">
          <View style={sceneStyles.wideRightInner}>
            <SettingsSection
              title="飞书连通性测试与出站/入站审计"
              info="验证 tenant_access_token 鉴权、交互发卡回执与带签名防重放校验的回调审计。"
              testID="settings-feishu-diagnostics"
            >
              <MainChatFeishuBridgePanel
                serverId="srv_1"
                client={fixtureClient}
                initialState={fixtureBridgeState}
                initialConnectionResult={makeWave6ConnectionResult()}
                initialTestCardResult={makeWave6TestCardResult()}
              />
            </SettingsSection>
          </View>
        </ScrollView>
      </View>,
    );
    await waitForLayoutFrame();

    // Scroll right settings pane to show Webhook URL + Save/Test buttons + Diagnostics + Audit Ledger clearly
    const scrollEl = host.querySelector<HTMLElement>("[data-testid='wave6-right-scroll']")!;
    const webhookBox = host.querySelector<HTMLElement>("[data-testid='feishu-webhook-url-box']");
    if (webhookBox) {
      const topDelta =
        webhookBox.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - 48;
      scrollEl.scrollTop = Math.max(0, topDelta);
    }
    await waitForLayoutFrame();

    const shell = host.querySelector<HTMLElement>("[data-testid='wave6-test-audit-shell']")!;
    expect(shell.textContent).toContain("om_w6_test_card_008");
    expect(shell.textContent).toContain("飞书权限审批回写：已批准");
    expect(shell.textContent).toContain("重复回调已幂等去重");
    expect(shell.textContent).toContain("sender_not_allowed");
    expect(shell.textContent).not.toContain("mainChat.feishuBridge.");
    assertNoHorizontalOverflow(shell, "02 Wide 1440x900 Test & Audit");
    assertRailAligned(shell, "02 Wide Main Chat Rail");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-wide-feishu-test-and-audit.png`,
      element: shell,
    });
  });

  it("03: renders narrow 390x844 mobile light Wave 6 Feishu Bridge & compact Main Chat Rail without overflow", async () => {
    await page.viewport(390, 844);

    renderInBrowser(
      <View style={sceneStyles.viewportFrameNarrow} testID="wave6-narrow-shell">
        <Wave6MainChatColumn compact />
        <ScrollView style={sceneStyles.narrowSettingsScroll} testID="wave6-narrow-scroll">
          <View style={sceneStyles.narrowSettingsWrap}>
            <SettingsSection
              title="飞书机器人桥接（插件）"
              info="移动端窄屏响应布局与脱敏密钥管理。"
              testID="settings-main-chat-feishu-bridge-narrow"
            >
              <MainChatFeishuBridgePanel
                serverId="srv_1"
                client={fixtureClient}
                initialState={fixtureBridgeState}
                initialConnectionResult={makeWave6ConnectionResult()}
                initialTestCardResult={makeWave6TestCardResult()}
              />
            </SettingsSection>
          </View>
        </ScrollView>
      </View>,
    );
    await waitForLayoutFrame();

    const shell = host.querySelector<HTMLElement>("[data-testid='wave6-narrow-shell']")!;
    expect(shell.textContent).toContain("飞书机器人桥接（插件）");
    expect(shell.textContent).toContain("om_w6_test_card_008");
    expect(shell.textContent).not.toContain("mainChat.feishuBridge.");
    assertNoHorizontalOverflow(shell, "03 Narrow 390x844 Wave 6");
    assertRailAligned(shell, "03 Narrow Main Chat Rail");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-narrow-390-wave6.png`,
      element: shell,
    });
  });

  it("04: renders wide 1440x900 dark theme Wave 6 Feishu Bridge, Diagnostics, Audit Ledger & Main Chat cleanly", async () => {
    await page.viewport(1440, 900);
    UnistylesRuntime.setTheme("dark");

    renderInBrowser(
      <View style={sceneStyles.viewportSplitWide} testID="wave6-dark-shell">
        <View style={sceneStyles.wideLeftMain}>
          <Wave6MainChatColumn />
        </View>
        <ScrollView style={sceneStyles.wideRightScroll} testID="wave6-dark-scroll">
          <View style={sceneStyles.wideRightInner}>
            <SettingsSection
              title="飞书机器人桥接（插件）"
              info="暗色主题下核验脱敏凭据状态、连通性诊断与回调审计可读性。"
              testID="settings-main-chat-feishu-bridge-dark"
            >
              <MainChatFeishuBridgePanel
                serverId="srv_1"
                client={fixtureClient}
                initialState={fixtureBridgeState}
                initialConnectionResult={makeWave6ConnectionResult()}
                initialTestCardResult={makeWave6TestCardResult()}
              />
            </SettingsSection>
          </View>
        </ScrollView>
      </View>,
    );
    await waitForLayoutFrame();

    // Scroll dark pane to show Webhook URL + Action Buttons + Diagnostics + Audit Ledger clearly
    const scrollEl = host.querySelector<HTMLElement>("[data-testid='wave6-dark-scroll']")!;
    const webhookBox = host.querySelector<HTMLElement>("[data-testid='feishu-webhook-url-box']");
    if (webhookBox) {
      const topDelta =
        webhookBox.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - 48;
      scrollEl.scrollTop = Math.max(0, topDelta);
    }
    await waitForLayoutFrame();

    const shell = host.querySelector<HTMLElement>("[data-testid='wave6-dark-shell']")!;
    expect(shell.textContent).toContain("飞书机器人桥接（插件）");
    expect(shell.textContent).toContain("••••4a9f");
    expect(shell.textContent).toContain("om_w6_test_card_008");
    expect(shell.textContent).not.toContain("mainChat.feishuBridge.");
    assertNoHorizontalOverflow(shell, "04 Wide 1440x900 Dark Wave 6");
    assertRailAligned(shell, "04 Dark Main Chat Rail");

    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-wide-dark-wave6.png`,
      element: shell,
    });
  });
});

const sceneStyles = StyleSheet.create((theme) => ({
  settingsDualGrid: {
    width: "100%",
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 20,
    padding: 20,
    backgroundColor: theme.colors.surface0,
  },
  settingsCol: {
    flex: 1,
    minWidth: 0,
  },
  viewportSplitWide: {
    width: "100%",
    height: 900,
    flexDirection: "row",
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
  },
  wideLeftMain: {
    width: 600,
    height: "100%",
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
  },
  wideMainColumn: {
    flex: 1,
    minWidth: 0,
    height: "100%",
  },
  wideRightScroll: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    backgroundColor: theme.colors.surface0,
  },
  wideRightInner: {
    padding: 20,
    backgroundColor: theme.colors.surface0,
  },
  viewportFrameNarrow: {
    width: "100%",
    height: 844,
    overflow: "hidden",
    flexDirection: "column",
    backgroundColor: theme.colors.surface0,
  },
  narrowMainScene: {
    width: "100%",
    height: 306,
    flexDirection: "column",
    backgroundColor: theme.colors.surface0,
  },
  narrowSettingsScroll: {
    flex: 1,
    minHeight: 0,
    width: "100%",
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  narrowSettingsWrap: {
    padding: 12,
    backgroundColor: theme.colors.surface0,
  },
  streamSurface: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
    backgroundColor: theme.colors.surface0,
  },
  streamTranscriptOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[4],
  },
  streamTranscript: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  messageBubble: {
    width: "100%",
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[1.5],
  },
  messageHeading: {
    fontSize: 13,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  messageBody: {
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  bottomStack: {
    width: "100%",
    alignItems: "stretch",
    backgroundColor: theme.colors.surface0,
  },
  composerOuter: {
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[3],
    paddingTop: theme.spacing[1],
  },
  composerInner: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    minHeight: 46,
    justifyContent: "center",
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  composerHint: {
    fontSize: 13,
    color: theme.colors.foregroundMuted,
  },
}));
