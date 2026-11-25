import {
  FEISHU_CRITICAL_PASSTHROUGH_CATEGORIES,
  FEISHU_PLUGIN_ID,
  FEISHU_WEBHOOK_PATH,
  type FeishuAuditDirection,
  type FeishuAuditRecord,
  type FeishuBridgeEvent,
  type FeishuBridgeState,
  type FeishuCompleteCallbackActionResult,
  type FeishuConfigPatch,
  type FeishuConnectionTestResult,
  type FeishuDispatchEventResult,
  type FeishuForwardTier,
  type FeishuReceiveIdType,
  type FeishuSendTestCardResult,
  type FeishuStats,
  type FeishuWebhookActionIntent,
  type FeishuWebhookProcessResult,
  resolveApiBaseUrl,
} from "../shared/contracts.js";
import {
  buildDecisionCard,
  buildNotificationCard,
  buildPermissionApprovalCard,
  buildResolvedCard,
  buildTestConnectivityCard,
} from "./cards.js";
import { FeishuBridgeConfigStore, isBridgeConfiguredForOutbound } from "./config-store.js";
import { FeishuOpenApiClient, FeishuOpenApiError } from "./openapi-client.js";
import {
  collectConfiguredSecrets,
  redactSecretsFromText,
  toRedactedConfig,
  type StoredFeishuBridgeConfig,
} from "./redaction.js";
import {
  FeishuTenantTokenManager,
  FeishuTokenError,
  type FeishuTokenCredentials,
} from "./token-manager.js";
import {
  FeishuIdempotencyGuard,
  type FeishuWebhookHeaders,
  verifyAndParseFeishuWebhook,
} from "./webhook-security.js";

interface TrackedOutboundCard {
  messageId: string;
  title: string;
  kind: "permission" | "decision";
  createdAtMs: number;
}

const MAX_TRACKED_CARDS = 200;

export interface FeishuBridgeEngineOptions {
  dataDirectory?: string;
  fetchImpl?: typeof fetch;
  nowMs?: () => number;
}

export class FeishuBridgeEngine {
  private readonly store: FeishuBridgeConfigStore;
  private readonly tokenManager: FeishuTenantTokenManager;
  private readonly apiClient: FeishuOpenApiClient;
  private readonly idempotency: FeishuIdempotencyGuard;
  private readonly trackedCards = new Map<string, TrackedOutboundCard>();
  private readonly nowFn: () => number;

  constructor(options: FeishuBridgeEngineOptions = {}) {
    this.nowFn = options.nowMs ?? (() => Date.now());
    this.store = new FeishuBridgeConfigStore(options.dataDirectory);
    this.tokenManager = new FeishuTenantTokenManager({
      fetchImpl: options.fetchImpl,
      nowMs: this.nowFn,
    });
    this.apiClient = new FeishuOpenApiClient(this.tokenManager, {
      fetchImpl: options.fetchImpl,
      nowMs: this.nowFn,
    });
    this.idempotency = new FeishuIdempotencyGuard(undefined, this.nowFn);
  }

  private nowIso(): string {
    return new Date(this.nowFn()).toISOString();
  }

  private resolveCredentials(config: StoredFeishuBridgeConfig): FeishuTokenCredentials | null {
    const apiBaseUrl = resolveApiBaseUrl(config.domainPreset, config.customApiBaseUrl);
    if (!apiBaseUrl || !config.appId.trim() || !config.appSecret) {
      return null;
    }
    return {
      apiBaseUrl,
      appId: config.appId.trim(),
      appSecret: config.appSecret,
    };
  }

  private trackCard(key: string, record: TrackedOutboundCard): void {
    this.trackedCards.set(key, record);
    while (this.trackedCards.size > MAX_TRACKED_CARDS) {
      const oldest = this.trackedCards.keys().next().value;
      if (!oldest) break;
      this.trackedCards.delete(oldest);
    }
  }

  async getState(options?: {
    auditLimit?: number;
    webhookUrl?: string | null;
  }): Promise<FeishuBridgeState> {
    await this.store.load();
    const config = this.store.getConfigSnapshot();
    return {
      pluginAvailable: true,
      pluginId: FEISHU_PLUGIN_ID,
      active: isBridgeConfiguredForOutbound(config),
      webhookPath: FEISHU_WEBHOOK_PATH,
      webhookUrl: options?.webhookUrl ?? null,
      config: toRedactedConfig(config),
      stats: this.store.getStatsSnapshot(),
      recentAudit: this.store.listAudit(options?.auditLimit ?? 30),
    };
  }

  async updateConfig(
    patch: FeishuConfigPatch,
    options?: { webhookUrl?: string | null },
  ): Promise<FeishuBridgeState> {
    const updated = await this.store.updateConfig(patch, this.nowIso());
    // Always invalidate cached token when credentials or domain change
    if (
      patch.appId !== undefined ||
      patch.appSecret !== undefined ||
      patch.clearAppSecret === true ||
      patch.domainPreset !== undefined ||
      patch.apiBaseUrl !== undefined
    ) {
      this.tokenManager.invalidate();
    }
    return {
      pluginAvailable: true,
      pluginId: FEISHU_PLUGIN_ID,
      active: isBridgeConfiguredForOutbound(updated),
      webhookPath: FEISHU_WEBHOOK_PATH,
      webhookUrl: options?.webhookUrl ?? null,
      config: toRedactedConfig(updated),
      stats: this.store.getStatsSnapshot(),
      recentAudit: this.store.listAudit(30),
    };
  }

  async listAudit(options?: {
    limit?: number;
    direction?: FeishuAuditDirection;
  }): Promise<{ records: FeishuAuditRecord[]; stats: FeishuStats }> {
    await this.store.load();
    return {
      records: this.store.listAudit(options?.limit ?? 30, options?.direction),
      stats: this.store.getStatsSnapshot(),
    };
  }

  async testConnection(options?: {
    forceRefreshToken?: boolean;
  }): Promise<FeishuConnectionTestResult> {
    await this.store.load();
    const config = this.store.getConfigSnapshot();
    const apiBaseUrl = resolveApiBaseUrl(config.domainPreset, config.customApiBaseUrl);
    const testedAt = this.nowIso();

    if (!apiBaseUrl) {
      const result: FeishuConnectionTestResult = {
        ok: false,
        latencyMs: 0,
        apiBaseUrl: "",
        statusCode: null,
        tokenExpiresInSec: null,
        errorCode: "missing_api_base_url",
        message: "尚未配置飞书 API 地址",
        troubleshootingHint: "请选择飞书 / Lark 预设域名，或填写有效的自定义 apiBaseUrl。",
        testedAt,
      };
      await this.store.appendAudit({
        direction: "system",
        kind: "connection_test",
        status: "failed",
        title: "连通性测试失败",
        summary: result.message,
        errorCode: result.errorCode,
        latencyMs: 0,
        messageId: null,
        actorOpenId: null,
        eventOrActionId: null,
        tier: null,
        createdAt: testedAt,
      });
      return result;
    }

    const credentials = this.resolveCredentials(config);
    if (!credentials) {
      const result: FeishuConnectionTestResult = {
        ok: false,
        latencyMs: 0,
        apiBaseUrl,
        statusCode: null,
        tokenExpiresInSec: null,
        errorCode: "missing_credentials",
        message: "缺少 App ID 或 App Secret，无法请求 tenant_access_token",
        troubleshootingHint: "请先填写并保存飞书应用的 App ID 与 App Secret，再点击「测试连接」。",
        testedAt,
      };
      await this.store.appendAudit({
        direction: "system",
        kind: "connection_test",
        status: "failed",
        title: "连通性测试失败",
        summary: result.message,
        errorCode: result.errorCode,
        latencyMs: 0,
        messageId: null,
        actorOpenId: null,
        eventOrActionId: null,
        tier: null,
        createdAt: testedAt,
      });
      return result;
    }

    try {
      const grant = await this.tokenManager.getToken(credentials, {
        forceRefresh: options?.forceRefreshToken ?? false,
      });
      const result: FeishuConnectionTestResult = {
        ok: true,
        latencyMs: grant.latencyMs,
        apiBaseUrl,
        statusCode: grant.statusCode,
        tokenExpiresInSec: grant.expiresInSec,
        cachedTokenReused: grant.reused,
        errorCode: null,
        message: grant.reused
          ? `连接正常（已复用缓存凭证，剩余有效期约 ${grant.expiresInSec} 秒）`
          : `连接成功（已签发新 tenant_access_token，有效期 ${grant.expiresInSec} 秒）`,
        troubleshootingHint: null,
        testedAt,
      };
      await this.store.appendAudit(
        {
          direction: "system",
          kind: "connection_test",
          status: "succeeded",
          title: "连通性测试成功",
          summary: result.message,
          errorCode: null,
          latencyMs: grant.latencyMs,
          messageId: null,
          actorOpenId: null,
          eventOrActionId: null,
          tier: null,
          createdAt: testedAt,
        },
        [grant.token],
      );
      return result;
    } catch (error) {
      const errObj = error instanceof FeishuTokenError ? error : null;
      const safeMsg = redactSecretsFromText(
        error instanceof Error ? error.message : String(error),
        collectConfiguredSecrets(config),
      );
      const result: FeishuConnectionTestResult = {
        ok: false,
        latencyMs: errObj?.options.latencyMs ?? 0,
        apiBaseUrl,
        statusCode: errObj?.options.statusCode ?? null,
        tokenExpiresInSec: null,
        errorCode: errObj?.options.errorCode ?? "connection_failed",
        message: safeMsg,
        troubleshootingHint:
          errObj?.options.troubleshootingHint ?? "请检查应用凭证、域名与网络连通性。",
        testedAt,
      };
      await this.store.appendAudit({
        direction: "system",
        kind: "connection_test",
        status: "failed",
        title: "连通性测试失败",
        summary: `${result.message}（${result.troubleshootingHint}）`,
        errorCode: result.errorCode,
        latencyMs: result.latencyMs,
        messageId: null,
        actorOpenId: null,
        eventOrActionId: null,
        tier: null,
        createdAt: testedAt,
      });
      return result;
    }
  }

  async sendTestCard(options?: {
    receiveId?: string;
    receiveIdType?: FeishuReceiveIdType;
    title?: string;
  }): Promise<FeishuSendTestCardResult> {
    await this.store.load();
    const config = this.store.getConfigSnapshot();
    const sentAt = this.nowIso();
    const receiveId = (options?.receiveId ?? config.receiveId).trim();
    const receiveIdType = options?.receiveIdType ?? config.receiveIdType;
    const credentials = this.resolveCredentials(config);

    if (!credentials || !receiveId) {
      const result: FeishuSendTestCardResult = {
        ok: false,
        latencyMs: 0,
        messageId: null,
        receiveId,
        receiveIdType,
        errorCode: !credentials ? "missing_credentials" : "missing_receive_id",
        message: !credentials
          ? "缺少 App ID / App Secret 或 API 地址，无法发送测试卡片"
          : "尚未填写目标群/用户 ID（receive_id）",
        troubleshootingHint: !credentials
          ? "请先保存应用凭证并通过「测试连接」。"
          : "请填写目标群聊 chat_id 或接收人 open_id 后重试。",
        sentAt,
      };
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_test_card",
        status: "failed",
        title: "发送测试卡片失败",
        summary: result.message,
        errorCode: result.errorCode,
        latencyMs: 0,
        messageId: null,
        actorOpenId: null,
        eventOrActionId: null,
        tier: null,
        createdAt: sentAt,
      });
      return result;
    }

    const card = buildTestConnectivityCard({
      title: options?.title,
      sentAtIso: sentAt,
      apiBaseUrl: credentials.apiBaseUrl,
    });

    try {
      const sent = await this.apiClient.sendInteractiveCard({
        credentials,
        receiveIdType,
        receiveId,
        card,
      });
      const result: FeishuSendTestCardResult = {
        ok: true,
        latencyMs: sent.latencyMs,
        messageId: sent.messageId,
        receiveId,
        receiveIdType,
        errorCode: null,
        message: `测试卡片发送成功（message_id: ${sent.messageId}）`,
        troubleshootingHint: null,
        sentAt,
      };
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_test_card",
        status: "succeeded",
        title: "测试卡片已送达",
        summary: result.message,
        errorCode: null,
        latencyMs: sent.latencyMs,
        messageId: sent.messageId,
        actorOpenId: null,
        eventOrActionId: null,
        tier: null,
        createdAt: sentAt,
      });
      return result;
    } catch (error) {
      const apiErr = error instanceof FeishuOpenApiError ? error : null;
      const safeMsg = redactSecretsFromText(
        error instanceof Error ? error.message : String(error),
        collectConfiguredSecrets(config),
      );
      const result: FeishuSendTestCardResult = {
        ok: false,
        latencyMs: apiErr?.options.latencyMs ?? 0,
        messageId: null,
        receiveId,
        receiveIdType,
        errorCode: apiErr?.options.errorCode ?? "send_test_card_failed",
        message: safeMsg,
        troubleshootingHint:
          apiErr?.options.troubleshootingHint ?? "请核对机器人是否已在目标群聊且拥有发消息权限。",
        sentAt,
      };
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_test_card",
        status: "failed",
        title: "发送测试卡片失败",
        summary: `${result.message}（${result.troubleshootingHint}）`,
        errorCode: result.errorCode,
        latencyMs: result.latencyMs,
        messageId: null,
        actorOpenId: null,
        eventOrActionId: null,
        tier: null,
        createdAt: sentAt,
      });
      return result;
    }
  }

  async dispatchEvent(event: FeishuBridgeEvent): Promise<FeishuDispatchEventResult> {
    await this.store.load();
    const config = this.store.getConfigSnapshot();
    if (!isBridgeConfiguredForOutbound(config)) {
      return {
        dispatched: false,
        filtered: true,
        reason: "bridge_disabled_or_unconfigured",
        messageId: null,
        error: null,
      };
    }

    const credentials = this.resolveCredentials(config);
    if (!credentials) {
      return {
        dispatched: false,
        filtered: true,
        reason: "missing_credentials",
        messageId: null,
        error: null,
      };
    }

    if (event.kind === "permission_requested") {
      return this.dispatchPermissionCard(config, credentials, event);
    }
    if (event.kind === "permission_resolved") {
      return this.updateResolvedTrackedCard(
        config,
        credentials,
        `perm:${event.agentId}:${event.requestId}`,
        event.behavior === "allow" ? "已批准" : "已拒绝",
        event.source === "feishu"
          ? "已通过飞书卡片完成审批回写"
          : `已在 Paseo 端处理（${event.behavior === "allow" ? "批准" : "拒绝"}）`,
        event.behavior === "allow",
      );
    }
    if (event.kind === "decision_created") {
      return this.dispatchDecisionCard(config, credentials, event);
    }
    if (event.kind === "decision_answered") {
      return this.updateResolvedTrackedCard(
        config,
        credentials,
        `decision:${event.decisionId}`,
        "已拍板",
        event.source === "feishu"
          ? `已通过飞书选择：${event.answer}`
          : `已在 Paseo 端拍板：${event.answer}`,
        true,
      );
    }
    return this.dispatchNotificationCard(config, credentials, event);
  }

  private async dispatchPermissionCard(
    config: StoredFeishuBridgeConfig,
    credentials: FeishuTokenCredentials,
    event: Extract<FeishuBridgeEvent, { kind: "permission_requested" }>,
  ): Promise<FeishuDispatchEventResult> {
    const secrets = collectConfiguredSecrets(config);
    const card = buildPermissionApprovalCard({
      agentId: event.agentId,
      serverId: event.serverId ?? null,
      requestId: event.requestId,
      title: redactSecretsFromText(event.title, secrets),
      toolName: redactSecretsFromText(event.toolName, secrets),
      command: event.command ? redactSecretsFromText(event.command, secrets) : null,
      description: event.description ? redactSecretsFromText(event.description, secrets) : null,
      managed: event.managed,
      isRedLine: event.isRedLine,
      redLineReason: event.redLineReason
        ? redactSecretsFromText(event.redLineReason, secrets)
        : null,
      actionPrefix: `perm:${event.agentId}:${event.requestId}`,
    });

    try {
      const sent = await this.apiClient.sendInteractiveCard({
        credentials,
        receiveIdType: config.receiveIdType,
        receiveId: config.receiveId,
        card,
        uuid: `paseo-perm-${event.requestId}`.slice(0, 50),
      });
      this.trackCard(`perm:${event.agentId}:${event.requestId}`, {
        messageId: sent.messageId,
        title: event.title,
        kind: "permission",
        createdAtMs: this.nowFn(),
      });
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_permission_card",
        status: "succeeded",
        title: `推送权限审批卡：${event.title}`,
        summary: `工具 ${event.toolName}${event.isRedLine ? "（红线高危）" : ""}`,
        errorCode: null,
        latencyMs: sent.latencyMs,
        messageId: sent.messageId,
        actorOpenId: null,
        eventOrActionId: event.requestId,
        tier: "critical",
      });
      return {
        dispatched: true,
        filtered: false,
        reason: null,
        messageId: sent.messageId,
        error: null,
      };
    } catch (error) {
      const apiErr = error instanceof FeishuOpenApiError ? error : null;
      const safeMsg = redactSecretsFromText(
        error instanceof Error ? error.message : String(error),
        secrets,
      );
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_permission_card",
        status: "failed",
        title: `推送权限审批卡失败：${event.title}`,
        summary: safeMsg,
        errorCode: apiErr?.options.errorCode ?? "outbound_failed",
        latencyMs: apiErr?.options.latencyMs ?? null,
        messageId: null,
        actorOpenId: null,
        eventOrActionId: event.requestId,
        tier: "critical",
      });
      return {
        dispatched: false,
        filtered: false,
        reason: null,
        messageId: null,
        error: safeMsg,
      };
    }
  }

  private async dispatchDecisionCard(
    config: StoredFeishuBridgeConfig,
    credentials: FeishuTokenCredentials,
    event: Extract<FeishuBridgeEvent, { kind: "decision_created" }>,
  ): Promise<FeishuDispatchEventResult> {
    const secrets = collectConfiguredSecrets(config);
    const card = buildDecisionCard({
      decisionId: event.decisionId,
      title: redactSecretsFromText(event.title, secrets),
      question: redactSecretsFromText(event.question, secrets),
      options: event.options.map((option) => ({
        id: option.id,
        label: redactSecretsFromText(option.label, secrets),
        leadsTo: redactSecretsFromText(option.leadsTo, secrets),
      })),
      recommendedOptionId: event.recommendedOptionId ?? null,
      reason: event.reason ? redactSecretsFromText(event.reason, secrets) : null,
      actionPrefix: `decide:${event.decisionId}`,
    });

    try {
      const sent = await this.apiClient.sendInteractiveCard({
        credentials,
        receiveIdType: config.receiveIdType,
        receiveId: config.receiveId,
        card,
        uuid: `paseo-dec-${event.decisionId}`.slice(0, 50),
      });
      this.trackCard(`decision:${event.decisionId}`, {
        messageId: sent.messageId,
        title: event.title,
        kind: "decision",
        createdAtMs: this.nowFn(),
      });
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_decision_card",
        status: "succeeded",
        title: `推送拍板决策卡：${event.title}`,
        summary: event.question,
        errorCode: null,
        latencyMs: sent.latencyMs,
        messageId: sent.messageId,
        actorOpenId: null,
        eventOrActionId: event.decisionId,
        tier: "critical",
      });
      return {
        dispatched: true,
        filtered: false,
        reason: null,
        messageId: sent.messageId,
        error: null,
      };
    } catch (error) {
      const apiErr = error instanceof FeishuOpenApiError ? error : null;
      const safeMsg = redactSecretsFromText(
        error instanceof Error ? error.message : String(error),
        secrets,
      );
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_decision_card",
        status: "failed",
        title: `推送拍板决策卡失败：${event.title}`,
        summary: safeMsg,
        errorCode: apiErr?.options.errorCode ?? "outbound_failed",
        latencyMs: apiErr?.options.latencyMs ?? null,
        messageId: null,
        actorOpenId: null,
        eventOrActionId: event.decisionId,
        tier: "critical",
      });
      return {
        dispatched: false,
        filtered: false,
        reason: null,
        messageId: null,
        error: safeMsg,
      };
    }
  }

  private async dispatchNotificationCard(
    config: StoredFeishuBridgeConfig,
    credentials: FeishuTokenCredentials,
    event: Extract<FeishuBridgeEvent, { kind: "notification_recorded" }>,
  ): Promise<FeishuDispatchEventResult> {
    // Dedicated permission/decision cards already handle permission_approval & decision_required
    if (event.category === "permission_approval" || event.category === "decision_required") {
      return {
        dispatched: false,
        filtered: true,
        reason: "handled_by_interactive_card",
        messageId: null,
        error: null,
      };
    }

    const isCriticalPassthrough =
      Boolean(event.passthrough) || FEISHU_CRITICAL_PASSTHROUGH_CATEGORIES.has(event.category);

    // Wave 4 low-distraction & night mode suppression filter
    if (
      config.respectLowDistraction &&
      !isCriticalPassthrough &&
      (event.status === "suppressed_quiet" || event.status === "suppressed_night")
    ) {
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_notification_card",
        status: "filtered",
        title: `低打扰已过滤：${event.title}`,
        summary: event.reason ?? "遵循 Wave 4 低打扰/夜间静默策略未推送至飞书",
        errorCode: null,
        latencyMs: null,
        messageId: null,
        actorOpenId: null,
        eventOrActionId: event.receiptId,
        tier: event.tier,
      });
      return {
        dispatched: false,
        filtered: true,
        reason: "filtered_low_distraction",
        messageId: null,
        error: null,
      };
    }

    if (event.tier === "silent") {
      return {
        dispatched: false,
        filtered: true,
        reason: "filtered_silent_tier",
        messageId: null,
        error: null,
      };
    }

    const tierAllowed =
      isCriticalPassthrough || config.forwardTiers.includes(event.tier as FeishuForwardTier);
    if (!tierAllowed) {
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_notification_card",
        status: "filtered",
        title: `未勾选分级已过滤：${event.title}`,
        summary: `当前未启用 ${event.tier} 分级转发`,
        errorCode: null,
        latencyMs: null,
        messageId: null,
        actorOpenId: null,
        eventOrActionId: event.receiptId,
        tier: event.tier,
      });
      return {
        dispatched: false,
        filtered: true,
        reason: `filtered_tier_${event.tier}`,
        messageId: null,
        error: null,
      };
    }

    const secrets = collectConfiguredSecrets(config);
    const card = buildNotificationCard({
      category: event.category,
      tier: event.tier,
      title: redactSecretsFromText(event.title, secrets),
      summary: redactSecretsFromText(event.summary, secrets),
      reason: event.reason ? redactSecretsFromText(event.reason, secrets) : null,
      passthrough: isCriticalPassthrough,
    });

    try {
      const sent = await this.apiClient.sendInteractiveCard({
        credentials,
        receiveIdType: config.receiveIdType,
        receiveId: config.receiveId,
        card,
        uuid: `paseo-n-${event.receiptId}`.slice(0, 50),
      });
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_notification_card",
        status: "succeeded",
        title: `推送通知卡：${event.title}`,
        summary: event.summary,
        errorCode: null,
        latencyMs: sent.latencyMs,
        messageId: sent.messageId,
        actorOpenId: null,
        eventOrActionId: event.receiptId,
        tier: event.tier,
      });
      return {
        dispatched: true,
        filtered: false,
        reason: null,
        messageId: sent.messageId,
        error: null,
      };
    } catch (error) {
      const apiErr = error instanceof FeishuOpenApiError ? error : null;
      const safeMsg = redactSecretsFromText(
        error instanceof Error ? error.message : String(error),
        secrets,
      );
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_notification_card",
        status: "failed",
        title: `推送通知卡失败：${event.title}`,
        summary: safeMsg,
        errorCode: apiErr?.options.errorCode ?? "outbound_failed",
        latencyMs: apiErr?.options.latencyMs ?? null,
        messageId: null,
        actorOpenId: null,
        eventOrActionId: event.receiptId,
        tier: event.tier,
      });
      return {
        dispatched: false,
        filtered: false,
        reason: null,
        messageId: null,
        error: safeMsg,
      };
    }
  }

  private async updateResolvedTrackedCard(
    config: StoredFeishuBridgeConfig,
    credentials: FeishuTokenCredentials,
    trackKey: string,
    outcomeLabel: string,
    detailMessage: string,
    succeeded: boolean,
  ): Promise<FeishuDispatchEventResult> {
    const tracked = this.trackedCards.get(trackKey);
    if (!tracked) {
      return {
        dispatched: false,
        filtered: true,
        reason: "no_tracked_card",
        messageId: null,
        error: null,
      };
    }
    this.trackedCards.delete(trackKey);
    const card = buildResolvedCard({
      title: tracked.title,
      outcomeLabel,
      detailMessage,
      actorOpenId: null,
      resolvedAtIso: this.nowIso(),
      succeeded,
    });
    try {
      const updated = await this.apiClient.updateInteractiveCard({
        credentials,
        messageId: tracked.messageId,
        card,
      });
      await this.store.appendAudit({
        direction: "outbound",
        kind: "outbound_card_update",
        status: "succeeded",
        title: `卡片终态更新：${tracked.title}`,
        summary: `${outcomeLabel} · ${detailMessage}`,
        errorCode: null,
        latencyMs: updated.latencyMs,
        messageId: tracked.messageId,
        actorOpenId: null,
        eventOrActionId: trackKey,
        tier: "critical",
      });
      return {
        dispatched: true,
        filtered: false,
        reason: null,
        messageId: tracked.messageId,
        error: null,
      };
    } catch (error) {
      const safeMsg = redactSecretsFromText(
        error instanceof Error ? error.message : String(error),
        collectConfiguredSecrets(config),
      );
      return {
        dispatched: false,
        filtered: false,
        reason: null,
        messageId: tracked.messageId,
        error: safeMsg,
      };
    }
  }

  async handleWebhook(input: {
    rawBody: string;
    headers: FeishuWebhookHeaders;
  }): Promise<FeishuWebhookProcessResult> {
    await this.store.load();
    const config = this.store.getConfigSnapshot();
    const verified = verifyAndParseFeishuWebhook({
      rawBody: input.rawBody,
      headers: input.headers,
      config,
      idempotency: this.idempotency,
      nowMs: this.nowFn(),
    });

    if (verified.kind === "challenge") {
      await this.store.appendAudit({
        direction: "inbound",
        kind: "inbound_challenge",
        status: "succeeded",
        title: "飞书 Webhook URL 验证通过",
        summary: "已通过验签并回显 url_verification challenge",
        errorCode: null,
        latencyMs: null,
        messageId: null,
        actorOpenId: null,
        eventOrActionId: null,
        tier: null,
      });
      return {
        httpStatus: 200,
        body: { challenge: verified.challenge },
        actionIntent: null,
        errorCode: null,
      };
    }

    if (verified.kind === "deduplicated") {
      await this.store.appendAudit({
        direction: "inbound",
        kind: "inbound_deduplicated",
        status: "deduplicated",
        title: "重复回调已幂等去重",
        summary: `已忽略重复事件/动作 ${verified.dedupeKey}`,
        errorCode: "deduplicated",
        latencyMs: null,
        messageId: null,
        actorOpenId: verified.actorOpenId,
        eventOrActionId: verified.dedupeKey,
        tier: null,
      });
      return {
        httpStatus: 200,
        body: {
          toast: {
            type: "info",
            content: "该操作已处理，无需重复点击",
          },
        },
        actionIntent: null,
        errorCode: "deduplicated",
      };
    }

    if (verified.kind === "rejected") {
      await this.store.appendAudit({
        direction: "inbound",
        kind: "inbound_rejected",
        status: "rejected",
        title: `拒绝异常飞书回调（${verified.errorCode}）`,
        summary: verified.reason,
        errorCode: verified.errorCode,
        latencyMs: null,
        messageId: null,
        actorOpenId: verified.actorOpenId,
        eventOrActionId: verified.eventOrActionId,
        tier: null,
      });
      return {
        httpStatus: verified.httpStatus,
        body: {
          error: verified.reason,
          code: verified.errorCode,
        },
        actionIntent: null,
        errorCode: verified.errorCode,
      };
    }

    // Verified action intent -> hand off to Core Daemon seam for Conservative Mode A guarded execution
    return {
      httpStatus: 200,
      body: { ok: true },
      actionIntent: verified.intent,
      errorCode: null,
    };
  }

  private buildCallbackCompletionResponse(params: {
    succeeded: boolean;
    outcomeLabel: string;
    safeDetail: string;
    errorCode?: string | null;
    updatedCard: ReturnType<typeof buildResolvedCard>;
    cardUpdated: boolean;
    updateError: string | null;
  }): FeishuCompleteCallbackActionResult {
    return {
      httpStatus: params.succeeded ? 200 : 403,
      body: params.succeeded
        ? {
            toast: {
              type: "success",
              content: `${params.outcomeLabel}：${params.safeDetail}`.slice(0, 120),
            },
            card: {
              type: "raw",
              data: params.updatedCard,
            },
          }
        : {
            toast: {
              type: "error",
              content: params.safeDetail.slice(0, 120),
            },
            error: params.safeDetail,
            code: params.errorCode ?? "action_rejected",
          },
      cardUpdated: params.cardUpdated,
      error: params.updateError,
    };
  }

  async completeCallbackAction(input: {
    intent: FeishuWebhookActionIntent;
    succeeded: boolean;
    outcomeLabel: string;
    detailMessage: string;
    errorCode?: string | null;
  }): Promise<FeishuCompleteCallbackActionResult> {
    await this.store.load();
    const config = this.store.getConfigSnapshot();
    const secrets = collectConfiguredSecrets(config);
    const safeDetail = redactSecretsFromText(input.detailMessage, secrets);
    const isPermission = input.intent.kind === "permission_respond";
    const trackKey =
      input.intent.kind === "permission_respond"
        ? `perm:${input.intent.agentId}:${input.intent.permissionRequestId}`
        : `decision:${input.intent.decisionId}`;
    const tracked = this.trackedCards.get(trackKey);
    const targetMessageId = input.intent.messageId ?? tracked?.messageId ?? null;
    const title = tracked?.title ?? input.intent.titleHint ?? "Paseo 交互卡片";

    if (input.succeeded) {
      this.trackedCards.delete(trackKey);
    }

    const updatedCard = buildResolvedCard({
      title: redactSecretsFromText(title, secrets),
      outcomeLabel: input.outcomeLabel,
      detailMessage: safeDetail,
      actorOpenId: input.intent.actorOpenId,
      resolvedAtIso: this.nowIso(),
      succeeded: input.succeeded,
    });

    let cardUpdated = false;
    let updateError: string | null = null;
    const credentials = this.resolveCredentials(config);
    if (input.succeeded && targetMessageId && credentials) {
      try {
        await this.apiClient.updateInteractiveCard({
          credentials,
          messageId: targetMessageId,
          card: updatedCard,
        });
        cardUpdated = true;
      } catch (error) {
        updateError = redactSecretsFromText(
          error instanceof Error ? error.message : String(error),
          secrets,
        );
      }
    }

    await this.store.appendAudit({
      direction: "inbound",
      kind: isPermission ? "inbound_permission_action" : "inbound_decision_action",
      status: input.succeeded ? "succeeded" : "rejected",
      title: isPermission
        ? `飞书权限审批回写：${input.outcomeLabel}`
        : `飞书拍板回写：${input.outcomeLabel}`,
      summary: safeDetail,
      errorCode: input.errorCode ?? null,
      latencyMs: null,
      messageId: targetMessageId,
      actorOpenId: input.intent.actorOpenId,
      eventOrActionId: input.intent.actionId,
      tier: "critical",
    });

    return this.buildCallbackCompletionResponse({
      succeeded: input.succeeded,
      outcomeLabel: input.outcomeLabel,
      safeDetail,
      errorCode: input.errorCode,
      updatedCard,
      cardUpdated,
      updateError,
    });
  }

  dispose(): void {
    this.tokenManager.invalidate();
    this.idempotency.clear();
    this.trackedCards.clear();
  }
}
