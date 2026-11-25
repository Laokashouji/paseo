// @vitest-environment jsdom

import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  FEISHU_BRIDGE_PLUGIN_ID,
  FEISHU_BRIDGE_WEBHOOK_PATH,
  type FeishuBridgeAuditRecord,
  type FeishuBridgeConnectionTestResult,
  type FeishuBridgeSendTestCardResult,
  type FeishuBridgeState,
} from "@getpaseo/protocol/main-chat";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { KeyboardActionDispatcherProvider } from "@/keyboard/keyboard-action-dispatcher-context";
import { MainChatFeishuBridgePanel } from "@/screens/settings/main-chat/feishu-bridge-panel";

const clipboardMock = vi.fn(async (_text: string) => undefined);

vi.mock("@/utils/copy-to-clipboard", () => ({
  copyToClipboard: (text: string) => clipboardMock(text),
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

const toastApi = {
  show: vi.fn(),
  copied: vi.fn(),
  error: vi.fn(),
  dismiss: vi.fn(),
};

function wrap(node: React.ReactElement) {
  return (
    <KeyboardActionDispatcherProvider>
      <ToastApiProvider api={toastApi}>{node}</ToastApiProvider>
    </KeyboardActionDispatcherProvider>
  );
}

const SAMPLE_AUDIT: readonly FeishuBridgeAuditRecord[] = [
  {
    id: "faud_out_1",
    direction: "outbound",
    kind: "outbound_permission_card",
    status: "succeeded",
    title: "推送权限审批卡：API 修复子任务",
    summary: "工具 Bash（已发送批准/拒绝卡片）",
    errorCode: null,
    latencyMs: 38,
    messageId: "om_mock_101",
    actorOpenId: null,
    eventOrActionId: "perm_101",
    tier: "critical",
    createdAt: "2026-11-25T09:10:00.000Z",
  },
  {
    id: "faud_in_1",
    direction: "inbound",
    kind: "inbound_permission_action",
    status: "succeeded",
    title: "飞书权限审批回写：已批准",
    summary: "已通过飞书卡片批准本次工具权限请求并更新卡片终态",
    errorCode: null,
    latencyMs: null,
    messageId: "om_mock_101",
    actorOpenId: "ou_owner_01",
    eventOrActionId: "perm:agent_1:perm_101:allow",
    tier: "critical",
    createdAt: "2026-11-25T09:10:15.000Z",
  },
  {
    id: "faud_in_2",
    direction: "inbound",
    kind: "inbound_rejected",
    status: "rejected",
    title: "拒绝异常飞书回调（sender_not_allowed）",
    summary: "操作人 ou_intruder 不在允许操作人 Open ID 白名单中",
    errorCode: "sender_not_allowed",
    latencyMs: null,
    messageId: null,
    actorOpenId: "ou_intruder",
    eventOrActionId: "act_unauth_2",
    tier: null,
    createdAt: "2026-11-25T09:11:00.000Z",
  },
];

function makeConfiguredState(overrides?: Partial<FeishuBridgeState>): FeishuBridgeState {
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
      appId: "cli_mock_demo_01",
      hasAppSecret: true,
      appSecretMask: "••••8f9a",
      hasVerificationToken: true,
      verificationTokenMask: "••••3c2d",
      hasEncryptKey: true,
      encryptKeyMask: "••••7e1b",
      receiveIdType: "chat_id",
      receiveId: "oc_mock_group_01",
      allowedOpenIds: ["ou_owner_01", "ou_owner_02"],
      forwardTiers: ["critical", "actionable"],
      respectLowDistraction: true,
      replayWindowSeconds: 300,
      requireSignature: true,
      updatedAt: "2026-11-25T09:05:00.000Z",
    },
    stats: {
      outboundSent: 4,
      outboundFailed: 0,
      inboundProcessed: 2,
      inboundRejected: 1,
      inboundDeduplicated: 1,
      lastOutboundAt: "2026-11-25T09:10:00.000Z",
      lastInboundAt: "2026-11-25T09:11:00.000Z",
    },
    recentAudit: [...SAMPLE_AUDIT],
    ...overrides,
  };
}

function createMockClient(overrides: Record<string, unknown>): DaemonClient {
  return overrides as unknown as DaemonClient;
}

describe("Wave 6 (P2-1) MainChatFeishuBridgePanel unit tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders masked secret status without plaintext, supports clear/replace save patch, and copies webhook URL", async () => {
    const initialState = makeConfiguredState();
    const updateMock = vi.fn(async (patch: Record<string, unknown>) => ({
      requestId: "req_u1",
      state: {
        ...initialState,
        config: {
          ...initialState.config,
          ...(patch.clearVerificationToken
            ? { hasVerificationToken: false, verificationTokenMask: null }
            : {}),
        },
      },
      error: null,
    }));

    const client = createMockClient({
      getMainChatFeishuBridgeState: vi.fn(async () => ({
        requestId: "req_g1",
        state: initialState,
        error: null,
      })),
      updateMainChatFeishuBridgeConfig: updateMock,
      testMainChatFeishuBridgeConnection: vi.fn(),
      sendMainChatFeishuBridgeTestCard: vi.fn(),
      listMainChatFeishuBridgeAudit: vi.fn(async () => ({
        requestId: "req_a1",
        records: [...SAMPLE_AUDIT],
        stats: initialState.stats,
        error: null,
      })),
    });

    const view = render(
      wrap(
        <MainChatFeishuBridgePanel serverId="srv_1" client={client} initialState={initialState} />,
      ),
    );

    // Configured mask badges rendered, password inputs start empty (never echoing plaintext)
    expect(view.getByTestId("feishu-secret-configured-appSecret").textContent).toContain(
      "••••8f9a",
    );
    expect(view.getByTestId("feishu-secret-configured-verificationToken").textContent).toContain(
      "••••3c2d",
    );
    expect(view.getByTestId("feishu-secret-configured-encryptKey").textContent).toContain(
      "••••7e1b",
    );
    expect((view.getByTestId("feishu-input-appSecret") as HTMLInputElement).value).toBe("");

    // Mark verificationToken for clearing, type replacement appSecret, toggle digest tier, and save
    fireEvent.click(view.getByTestId("feishu-secret-clear-verificationToken"));
    expect(view.getByTestId("feishu-secret-pending-clear-verificationToken")).toBeTruthy();

    const replacementInput = ["rep", "secret", "demo", "value"].join("_");
    fireEvent.change(view.getByTestId("feishu-input-appSecret"), {
      target: { value: replacementInput },
    });
    fireEvent.click(view.getByTestId("feishu-tier-pill-digest"));
    fireEvent.click(view.getByTestId("feishu-bridge-save-button"));

    await waitFor(() => {
      expect(updateMock).toHaveBeenCalledTimes(1);
    });
    const sentPatch = updateMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(sentPatch.clearVerificationToken).toBe(true);
    expect(sentPatch.appSecret).toBe(replacementInput);
    expect(sentPatch.forwardTiers).toEqual(["critical", "actionable", "digest"]);
    expect(sentPatch.allowedOpenIds).toEqual(["ou_owner_01", "ou_owner_02"]);

    // Copy webhook URL
    fireEvent.click(view.getByTestId("feishu-copy-webhook-url"));
    await waitFor(() => {
      expect(clipboardMock).toHaveBeenCalledWith(
        `http://127.0.0.1:6768${FEISHU_BRIDGE_WEBHOOK_PATH}`,
      );
    });
    expect(toastApi.copied).toHaveBeenCalledTimes(1);
  });

  it("displays connectivity test success/failure troubleshooting hints, test card result, and filters audit records", async () => {
    const initialState = makeConfiguredState();
    const failConnResult: FeishuBridgeConnectionTestResult = {
      ok: false,
      latencyMs: 24,
      apiBaseUrl: "https://open.feishu.cn",
      statusCode: 400,
      tokenExpiresInSec: null,
      errorCode: "feishu_10014",
      message: "获取 tenant_access_token 失败：invalid app_secret",
      troubleshootingHint: "请检查飞书开放平台应用凭证：确认 App ID 与 App Secret 填写正确。",
      testedAt: "2026-11-25T09:12:00.000Z",
    };
    const okCardResult: FeishuBridgeSendTestCardResult = {
      ok: true,
      latencyMs: 41,
      messageId: "om_test_card_99",
      receiveId: "oc_mock_group_01",
      receiveIdType: "chat_id",
      errorCode: null,
      message: "测试卡片发送成功（message_id: om_test_card_99）",
      troubleshootingHint: null,
      sentAt: "2026-11-25T09:12:05.000Z",
    };

    const client = createMockClient({
      testMainChatFeishuBridgeConnection: vi.fn(async () => ({
        requestId: "req_tc",
        result: failConnResult,
        error: null,
      })),
      sendMainChatFeishuBridgeTestCard: vi.fn(async () => ({
        requestId: "req_sc",
        result: okCardResult,
        error: null,
      })),
      listMainChatFeishuBridgeAudit: vi.fn(async () => ({
        requestId: "req_la",
        records: [...SAMPLE_AUDIT],
        stats: initialState.stats,
        error: null,
      })),
    });

    const view = render(
      wrap(
        <MainChatFeishuBridgePanel serverId="srv_1" client={client} initialState={initialState} />,
      ),
    );

    // Run connection test -> failure troubleshooting hint rendered
    fireEvent.click(view.getByTestId("feishu-bridge-test-connection-button"));
    await waitFor(() => {
      expect(view.getByTestId("feishu-connection-test-result")).toBeTruthy();
    });
    expect(view.getByTestId("feishu-connection-troubleshoot").textContent).toContain("App ID");

    // Run send test card -> message_id rendered
    fireEvent.click(view.getByTestId("feishu-bridge-send-test-card-button"));
    await waitFor(() => {
      expect(view.getByTestId("feishu-test-card-result")).toBeTruthy();
    });
    expect(view.getByTestId("feishu-test-card-result").textContent).toContain("om_test_card_99");

    // Filter audit records by inbound vs outbound
    expect(view.queryByTestId("feishu-audit-row-faud_out_1")).toBeTruthy();
    expect(view.queryByTestId("feishu-audit-row-faud_in_1")).toBeTruthy();

    fireEvent.click(view.getByTestId("feishu-audit-filter-inbound"));
    expect(view.queryByTestId("feishu-audit-row-faud_out_1")).toBeNull();
    expect(view.queryByTestId("feishu-audit-row-faud_in_1")).toBeTruthy();
    expect(view.queryByTestId("feishu-audit-row-faud_in_2")).toBeTruthy();

    fireEvent.click(view.getByTestId("feishu-audit-filter-outbound"));
    expect(view.queryByTestId("feishu-audit-row-faud_out_1")).toBeTruthy();
    expect(view.queryByTestId("feishu-audit-row-faud_in_1")).toBeNull();
  });
});
