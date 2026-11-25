import type { Logger } from "pino";
import {
  FEISHU_BRIDGE_PLUGIN_ID,
  createEmptyFeishuBridgeStats,
  createUnavailableFeishuBridgeState,
  type FeishuBridgeAuditDirection,
  type FeishuBridgeAuditRecord,
  type FeishuBridgeConfigPatch,
  type FeishuBridgeConnectionTestResult,
  type FeishuBridgeReceiveIdType,
  type FeishuBridgeSendTestCardResult,
  type FeishuBridgeState,
  type FeishuBridgeStats,
  type MainChatDecisionRecord,
  type MainChatNotificationCategory,
  type MainChatNotificationTier,
  type MainChatSettings,
} from "@getpaseo/protocol/main-chat";
import type { AgentPermissionResponse } from "@getpaseo/protocol/agent-types";

export interface FeishuBridgePluginRpcCompletedEvent {
  pluginId: string;
  method: string;
  result: unknown;
}

export interface FeishuBridgePluginInvoker {
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  onPluginRpcCompleted?: (
    listener: (event: FeishuBridgePluginRpcCompletedEvent) => void,
  ) => () => void;
}

export type MainChatBridgeEvent =
  | {
      kind: "permission_requested";
      agentId: string;
      serverId: string | null;
      requestId: string;
      title: string;
      toolName: string;
      command: string | null;
      description: string | null;
      managed: boolean;
      isRedLine: boolean;
      redLineReason: string | null;
      taskId: string | null;
      conversationId: string | null;
    }
  | {
      kind: "permission_resolved";
      agentId: string;
      requestId: string;
      behavior: string;
      source?: "paseo" | "feishu";
    }
  | {
      kind: "decision_created";
      decisionId: string;
      title: string;
      question: string;
      options: ReadonlyArray<{ id: string; label: string; leadsTo: string }>;
      recommendedOptionId: string | null;
      reason: string | null;
      agentId: string | null;
      taskId: string | null;
      planId: string | null;
    }
  | {
      kind: "decision_answered";
      decisionId: string;
      optionId: string | null;
      answer: string;
      source?: "paseo" | "feishu";
    }
  | {
      kind: "notification_recorded";
      receiptId: string;
      category: MainChatNotificationCategory;
      tier: MainChatNotificationTier;
      status:
        | "queued"
        | "delivered"
        | "suppressed_quiet"
        | "suppressed_night"
        | "acknowledged"
        | "read";
      title: string;
      summary: string;
      reason: string | null;
      passthrough: boolean;
      taskId: string | null;
      agentId: string | null;
    };

export interface FeishuWebhookHttpRequest {
  rawBody: string;
  headers: {
    timestamp?: string | null;
    nonce?: string | null;
    signature?: string | null;
  };
}

export interface FeishuWebhookHttpResponse {
  httpStatus: number;
  body: Record<string, unknown>;
}

interface PluginWebhookActionIntent {
  kind: "permission_respond" | "decision_answer";
  agentId?: string;
  serverId?: string | null;
  permissionRequestId?: string;
  behavior?: "allow" | "deny";
  decisionId?: string;
  optionId?: string;
  answer?: string;
  messageId: string | null;
  actorOpenId: string;
  actionId: string;
  managedHint?: boolean | null;
  titleHint: string | null;
}

interface PluginWebhookProcessResult {
  httpStatus: number;
  body: Record<string, unknown>;
  actionIntent: PluginWebhookActionIntent | null;
  errorCode: string | null;
}

interface PluginCompleteCallbackResult {
  httpStatus: number;
  body: Record<string, unknown>;
  cardUpdated: boolean;
  error: string | null;
}

export interface FeishuBridgeSeamDependencies {
  pluginInvoker?: FeishuBridgePluginInvoker | null;
  resolveWebhookUrl?: () => string | null;
  getSettings: () => MainChatSettings;
  isManagedAgent: (agentId: string) => boolean;
  hasPendingPermission: (input: {
    agentId: string;
    serverId: string | null;
    permissionRequestId: string;
  }) => Promise<boolean>;
  respondToPermission: (input: {
    agentId: string;
    serverId: string | null;
    permissionRequestId: string;
    response: AgentPermissionResponse;
  }) => Promise<void>;
  getDecision: (decisionId: string) => Promise<MainChatDecisionRecord | null>;
  answerDecision: (input: {
    decisionId: string;
    optionId?: string;
    answer: string;
  }) => Promise<MainChatDecisionRecord>;
  logger: Logger;
}

export interface FeishuBridgeSeam {
  /** Refreshes the default-off active flag from local plugin state (zero network traffic). */
  syncInitialActiveState(): Promise<void>;
  isActive(): boolean;
  getState(options?: { auditLimit?: number }): Promise<FeishuBridgeState>;
  updateConfig(patch: FeishuBridgeConfigPatch): Promise<FeishuBridgeState>;
  testConnection(options?: {
    forceRefreshToken?: boolean;
  }): Promise<FeishuBridgeConnectionTestResult>;
  sendTestCard(options?: {
    receiveId?: string;
    receiveIdType?: FeishuBridgeReceiveIdType;
    title?: string;
  }): Promise<FeishuBridgeSendTestCardResult>;
  listAudit(options?: {
    limit?: number;
    direction?: FeishuBridgeAuditDirection;
  }): Promise<{ records: FeishuBridgeAuditRecord[]; stats: FeishuBridgeStats }>;
  dispatchMainChatEvent(event: MainChatBridgeEvent): void;
  handleWebhookRequest(request: FeishuWebhookHttpRequest): Promise<FeishuWebhookHttpResponse>;
  stop(): void;
}

function isPluginUnavailableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("Plugin is not available") ||
    msg.includes("Plugin stopped") ||
    msg.includes("Unknown plugin")
  );
}

/**
 * Minimal, default-off seam between Main Chat core and the isolated built-in
 * `feishu-bot-bridge` plugin. Keeps all Feishu OpenAPI, card JSON, token cache,
 * encryption, and webhook verification logic inside `plugins/feishu-bot-bridge/`.
 */
export function createFeishuBridgeSeam(deps: FeishuBridgeSeamDependencies): FeishuBridgeSeam {
  const logger = deps.logger.child({ module: "feishu-bridge-seam" });
  let active = false;
  let unsubscribeRpcCompleted: (() => void) | null = null;
  const bridgedPermissionKeys = new Set<string>();
  const feishuResolvedKeys = new Set<string>();

  function syncActiveFromUpdateConfigResult(result: unknown): void {
    if (
      typeof result === "object" &&
      result !== null &&
      "active" in result &&
      typeof (result as { active: unknown }).active === "boolean"
    ) {
      active = (result as { active: boolean }).active;
    }
  }

  function ensureRpcCompletedSubscription(): void {
    if (unsubscribeRpcCompleted || !deps.pluginInvoker?.onPluginRpcCompleted) return;
    unsubscribeRpcCompleted = deps.pluginInvoker.onPluginRpcCompleted((event) => {
      if (event.pluginId !== FEISHU_BRIDGE_PLUGIN_ID) return;
      if (event.method !== "feishu.update_config") return;
      syncActiveFromUpdateConfigResult(event.result);
    });
  }

  ensureRpcCompletedSubscription();

  function webhookUrl(): string | null {
    return deps.resolveWebhookUrl?.() ?? null;
  }

  function rememberKey(set: Set<string>, key: string): void {
    set.add(key);
    if (set.size > 300) {
      const oldest = set.values().next().value;
      if (oldest) set.delete(oldest);
    }
  }

  async function invokePlugin<T>(method: string, input: unknown): Promise<T> {
    if (!deps.pluginInvoker) {
      throw new Error(`Plugin is not available: ${FEISHU_BRIDGE_PLUGIN_ID}`);
    }
    return (await deps.pluginInvoker.invokePluginRpc(FEISHU_BRIDGE_PLUGIN_ID, method, input)) as T;
  }

  async function syncInitialActiveState(): Promise<void> {
    if (!deps.pluginInvoker) {
      active = false;
      return;
    }
    ensureRpcCompletedSubscription();
    try {
      const state = await invokePlugin<FeishuBridgeState>("feishu.get_state", {
        auditLimit: 1,
        webhookUrl: webhookUrl(),
      });
      active = Boolean(state.active);
    } catch (error) {
      active = false;
      if (!isPluginUnavailableError(error)) {
        logger.warn({ err: error }, "Failed to read initial Feishu bridge plugin state");
      }
    }
  }

  async function getState(options?: { auditLimit?: number }): Promise<FeishuBridgeState> {
    const url = webhookUrl();
    if (!deps.pluginInvoker) {
      active = false;
      return createUnavailableFeishuBridgeState(url);
    }
    try {
      const state = await invokePlugin<FeishuBridgeState>("feishu.get_state", {
        auditLimit: options?.auditLimit,
        webhookUrl: url,
      });
      active = Boolean(state.active);
      return state;
    } catch (error) {
      if (isPluginUnavailableError(error)) {
        active = false;
        return createUnavailableFeishuBridgeState(url);
      }
      throw error;
    }
  }

  async function updateConfig(patch: FeishuBridgeConfigPatch): Promise<FeishuBridgeState> {
    const state = await invokePlugin<FeishuBridgeState>("feishu.update_config", {
      patch,
      webhookUrl: webhookUrl(),
    });
    active = Boolean(state.active);
    return state;
  }

  async function testConnection(options?: {
    forceRefreshToken?: boolean;
  }): Promise<FeishuBridgeConnectionTestResult> {
    if (!deps.pluginInvoker) {
      return {
        ok: false,
        latencyMs: 0,
        apiBaseUrl: "",
        statusCode: null,
        tokenExpiresInSec: null,
        errorCode: "plugin_unavailable",
        message: "内置飞书机器人桥接插件未启动",
        troubleshootingHint: "请确认 Daemon 已加载内置插件 feishu-bot-bridge。",
        testedAt: new Date().toISOString(),
      };
    }
    return invokePlugin<FeishuBridgeConnectionTestResult>("feishu.test_connection", {
      forceRefreshToken: options?.forceRefreshToken,
    });
  }

  async function sendTestCard(options?: {
    receiveId?: string;
    receiveIdType?: FeishuBridgeReceiveIdType;
    title?: string;
  }): Promise<FeishuBridgeSendTestCardResult> {
    if (!deps.pluginInvoker) {
      return {
        ok: false,
        latencyMs: 0,
        messageId: null,
        receiveId: options?.receiveId ?? "",
        receiveIdType: options?.receiveIdType ?? "chat_id",
        errorCode: "plugin_unavailable",
        message: "内置飞书机器人桥接插件未启动",
        troubleshootingHint: "请确认 Daemon 已加载内置插件 feishu-bot-bridge。",
        sentAt: new Date().toISOString(),
      };
    }
    return invokePlugin<FeishuBridgeSendTestCardResult>("feishu.send_test_card", {
      receiveId: options?.receiveId,
      receiveIdType: options?.receiveIdType,
      title: options?.title,
    });
  }

  async function listAudit(options?: {
    limit?: number;
    direction?: FeishuBridgeAuditDirection;
  }): Promise<{ records: FeishuBridgeAuditRecord[]; stats: FeishuBridgeStats }> {
    if (!deps.pluginInvoker) {
      return { records: [], stats: createEmptyFeishuBridgeStats() };
    }
    try {
      return await invokePlugin<{ records: FeishuBridgeAuditRecord[]; stats: FeishuBridgeStats }>(
        "feishu.list_audit",
        {
          limit: options?.limit,
          direction: options?.direction,
        },
      );
    } catch (error) {
      if (isPluginUnavailableError(error)) {
        return { records: [], stats: createEmptyFeishuBridgeStats() };
      }
      throw error;
    }
  }

  function dispatchMainChatEvent(event: MainChatBridgeEvent): void {
    // Default-off zero-overhead guard: zero RPC calls, zero network, zero timers when inactive.
    if (!active || !deps.pluginInvoker) return;

    if (event.kind === "permission_requested") {
      rememberKey(bridgedPermissionKeys, `${event.agentId}:${event.requestId}`);
    } else if (event.kind === "permission_resolved") {
      const key = `perm:${event.agentId}:${event.requestId}`;
      if (feishuResolvedKeys.delete(key)) {
        // Already updated by complete_callback_action on the Feishu callback path.
        return;
      }
      bridgedPermissionKeys.delete(`${event.agentId}:${event.requestId}`);
    } else if (event.kind === "decision_answered") {
      const key = `decision:${event.decisionId}`;
      if (feishuResolvedKeys.delete(key)) {
        return;
      }
    }

    void invokePlugin("feishu.dispatch_event", event).catch((error) => {
      if (!isPluginUnavailableError(error)) {
        logger.warn(
          { err: error, eventKind: event.kind },
          "Feishu bridge plugin failed to dispatch main-chat event",
        );
      }
    });
  }

  interface ActionExecutionResult {
    succeeded: boolean;
    outcomeLabel: string;
    detailMessage: string;
    errorCode: string | null;
  }

  async function executePermissionAction(
    intent: PluginWebhookActionIntent,
    isConservativeModeA: boolean,
  ): Promise<ActionExecutionResult> {
    const agentId = intent.agentId ?? "";
    const permissionRequestId = intent.permissionRequestId ?? "";
    const serverId = intent.serverId ?? null;
    const behavior = intent.behavior === "allow" ? "allow" : "deny";
    const permKey = `${agentId}:${permissionRequestId}`;
    const isManaged = deps.isManagedAgent(agentId);

    // Conservative Mode A: never accept unbridged or unsolicited operations on manual user sessions.
    if (isConservativeModeA && !isManaged && !bridgedPermissionKeys.has(permKey)) {
      return {
        succeeded: false,
        outcomeLabel: "保守模式已拦截",
        detailMessage:
          "保守模式 A 禁止通过飞书回调操作未受管的用户手动会话，请回到 Paseo 本地会话确认。",
        errorCode: "conservative_mode_blocked",
      };
    }

    const pending = await deps.hasPendingPermission({
      agentId,
      serverId,
      permissionRequestId,
    });
    if (!pending) {
      return {
        succeeded: false,
        outcomeLabel: "请求已失效",
        detailMessage: "该权限审批请求已处理或不存在，无需重复操作。",
        errorCode: "permission_not_pending",
      };
    }

    rememberKey(feishuResolvedKeys, `perm:${agentId}:${permissionRequestId}`);
    bridgedPermissionKeys.delete(permKey);
    await deps.respondToPermission({
      agentId,
      serverId,
      permissionRequestId,
      response:
        behavior === "allow"
          ? { behavior: "allow" }
          : { behavior: "deny", message: `Denied via Feishu card by ${intent.actorOpenId}` },
    });

    return {
      succeeded: true,
      outcomeLabel: behavior === "allow" ? "已批准" : "已拒绝",
      detailMessage:
        behavior === "allow"
          ? "已通过飞书卡片批准本次工具权限请求"
          : "已通过飞书卡片拒绝本次工具权限请求",
      errorCode: null,
    };
  }

  async function executeDecisionAction(
    intent: PluginWebhookActionIntent,
  ): Promise<ActionExecutionResult> {
    const decisionId = intent.decisionId ?? "";
    const decision = await deps.getDecision(decisionId);
    if (!decision) {
      return {
        succeeded: false,
        outcomeLabel: "决策卡不存在",
        detailMessage: `找不到待拍板决策记录：${decisionId}`,
        errorCode: "decision_not_found",
      };
    }
    if (decision.answeredAt) {
      return {
        succeeded: false,
        outcomeLabel: "已由其他端处理",
        detailMessage: `该决策卡此前已拍板：${decision.answer ?? ""}`,
        errorCode: "decision_already_answered",
      };
    }

    // Conservative Mode A: NEVER send business prompts/commands to a user's manual session.
    const targetAgentId = decision.agentId ?? decision.mainAgentId;
    if (targetAgentId && !deps.isManagedAgent(targetAgentId)) {
      return {
        succeeded: false,
        outcomeLabel: "保守模式已拦截",
        detailMessage:
          "保守模式 A 严禁通过飞书回调向用户手动会话下发业务命令，请在 Paseo 内直接操作。",
        errorCode: "conservative_mode_blocked",
      };
    }

    rememberKey(feishuResolvedKeys, `decision:${decisionId}`);
    const answered = await deps.answerDecision({
      decisionId,
      optionId: intent.optionId,
      answer: intent.answer ?? "",
    });

    return {
      succeeded: true,
      outcomeLabel: "已拍板",
      detailMessage: `已回写选择「${answered.answer ?? intent.answer ?? ""}」并通知受管会话继续推进`,
      errorCode: null,
    };
  }

  async function executeActionIntent(
    intent: PluginWebhookActionIntent,
  ): Promise<ActionExecutionResult> {
    const settings = deps.getSettings();
    const isConservativeModeA = settings.style !== "proactive";

    if (intent.kind === "permission_respond") {
      return executePermissionAction(intent, isConservativeModeA);
    }
    if (intent.kind === "decision_answer") {
      return executeDecisionAction(intent);
    }

    return {
      succeeded: false,
      outcomeLabel: "不支持的回调动作",
      detailMessage: "飞书桥接仅支持权限审批与拍板决策回写，拒绝其他动作。",
      errorCode: "unsupported_action",
    };
  }

  async function handleWebhookRequest(
    request: FeishuWebhookHttpRequest,
  ): Promise<FeishuWebhookHttpResponse> {
    if (!deps.pluginInvoker) {
      return {
        httpStatus: 503,
        body: { error: "Feishu bot bridge plugin is unavailable", code: "plugin_unavailable" },
      };
    }

    let processed: PluginWebhookProcessResult;
    try {
      processed = await invokePlugin<PluginWebhookProcessResult>("feishu.handle_webhook", {
        rawBody: request.rawBody,
        headers: request.headers,
      });
    } catch (error) {
      if (isPluginUnavailableError(error)) {
        return {
          httpStatus: 503,
          body: { error: "Feishu bot bridge plugin is unavailable", code: "plugin_unavailable" },
        };
      }
      logger.warn({ err: error }, "Feishu webhook plugin invocation failed");
      return {
        httpStatus: 500,
        body: { error: "Feishu webhook handler failed", code: "internal_error" },
      };
    }

    if (!processed.actionIntent) {
      return {
        httpStatus: processed.httpStatus,
        body: processed.body,
      };
    }

    let outcome: {
      succeeded: boolean;
      outcomeLabel: string;
      detailMessage: string;
      errorCode: string | null;
    };
    try {
      outcome = await executeActionIntent(processed.actionIntent);
    } catch (error) {
      outcome = {
        succeeded: false,
        outcomeLabel: "执行失败",
        detailMessage: error instanceof Error ? error.message : String(error),
        errorCode: "execution_failed",
      };
    }

    try {
      const completed = await invokePlugin<PluginCompleteCallbackResult>(
        "feishu.complete_callback_action",
        {
          intent: processed.actionIntent,
          succeeded: outcome.succeeded,
          outcomeLabel: outcome.outcomeLabel,
          detailMessage: outcome.detailMessage,
          errorCode: outcome.errorCode,
        },
      );
      return {
        httpStatus: completed.httpStatus,
        body: completed.body,
      };
    } catch (error) {
      logger.warn({ err: error }, "Failed to finalize Feishu callback action in plugin");
      return {
        httpStatus: outcome.succeeded ? 200 : 500,
        body: outcome.succeeded
          ? { toast: { type: "success", content: outcome.detailMessage } }
          : { error: outcome.detailMessage, code: outcome.errorCode ?? "finalize_failed" },
      };
    }
  }

  function stop(): void {
    unsubscribeRpcCompleted?.();
    unsubscribeRpcCompleted = null;
  }

  return {
    syncInitialActiveState,
    isActive: () => active,
    getState,
    updateConfig,
    testConnection,
    sendTestCard,
    listAudit,
    dispatchMainChatEvent,
    handleWebhookRequest,
    stop,
  };
}
