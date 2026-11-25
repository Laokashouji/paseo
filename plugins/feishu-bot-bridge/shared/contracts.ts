import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const FEISHU_PLUGIN_ID = "feishu-bot-bridge";
export const FEISHU_WEBHOOK_PATH = "/api/plugins/feishu-bot-bridge/webhook";

export const FEISHU_DOMAIN_PRESETS = ["feishu", "lark", "custom"] as const;
export const FEISHU_API_BASE_URLS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
} as const;

export const FEISHU_RECEIVE_ID_TYPES = ["chat_id", "open_id", "user_id"] as const;
export const FEISHU_FORWARD_TIERS = ["critical", "actionable", "digest"] as const;
export const FEISHU_NOTIFICATION_TIERS = ["critical", "actionable", "digest", "silent"] as const;
export const FEISHU_NOTIFICATION_CATEGORIES = [
  "permission_approval",
  "decision_required",
  "task_failed",
  "delivery_gate_blocked",
  "task_review",
  "task_progress",
  "rule_diagnostic",
  "patrol_summary",
] as const;

export const FEISHU_CRITICAL_PASSTHROUGH_CATEGORIES = new Set<string>([
  "permission_approval",
  "decision_required",
  "task_failed",
  "delivery_gate_blocked",
]);

export const FEISHU_DEFAULT_REPLAY_WINDOW_SEC = 300;
export const FEISHU_MIN_REPLAY_WINDOW_SEC = 30;
export const FEISHU_MAX_REPLAY_WINDOW_SEC = 3600;
export const FEISHU_MAX_AUDIT_RECORDS = 100;

export const FeishuDomainPresetSchema = z.enum(FEISHU_DOMAIN_PRESETS);
export type FeishuDomainPreset = z.infer<typeof FeishuDomainPresetSchema>;

export const FeishuReceiveIdTypeSchema = z.enum(FEISHU_RECEIVE_ID_TYPES);
export type FeishuReceiveIdType = z.infer<typeof FeishuReceiveIdTypeSchema>;

export const FeishuForwardTierSchema = z.enum(FEISHU_FORWARD_TIERS);
export type FeishuForwardTier = z.infer<typeof FeishuForwardTierSchema>;

export const FeishuNotificationTierSchema = z.enum(FEISHU_NOTIFICATION_TIERS);
export type FeishuNotificationTier = z.infer<typeof FeishuNotificationTierSchema>;

export const FeishuNotificationCategorySchema = z.enum(FEISHU_NOTIFICATION_CATEGORIES);
export type FeishuNotificationCategory = z.infer<typeof FeishuNotificationCategorySchema>;

export const FeishuRedactedConfigSchema = z.object({
  enabled: z.boolean(),
  domainPreset: FeishuDomainPresetSchema,
  apiBaseUrl: z.string(),
  appId: z.string(),
  hasAppSecret: z.boolean(),
  appSecretMask: z.string().nullable(),
  hasVerificationToken: z.boolean(),
  verificationTokenMask: z.string().nullable(),
  hasEncryptKey: z.boolean(),
  encryptKeyMask: z.string().nullable(),
  receiveIdType: FeishuReceiveIdTypeSchema,
  receiveId: z.string(),
  allowedOpenIds: z.array(z.string()),
  forwardTiers: z.array(FeishuForwardTierSchema),
  respectLowDistraction: z.boolean(),
  replayWindowSeconds: z
    .number()
    .int()
    .min(FEISHU_MIN_REPLAY_WINDOW_SEC)
    .max(FEISHU_MAX_REPLAY_WINDOW_SEC),
  requireSignature: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type FeishuRedactedConfig = z.infer<typeof FeishuRedactedConfigSchema>;

export const FeishuConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  domainPreset: FeishuDomainPresetSchema.optional(),
  apiBaseUrl: z.string().max(512).optional(),
  appId: z.string().max(128).optional(),
  appSecret: z.string().max(512).optional(),
  clearAppSecret: z.boolean().optional(),
  verificationToken: z.string().max(512).optional(),
  clearVerificationToken: z.boolean().optional(),
  encryptKey: z.string().max(512).optional(),
  clearEncryptKey: z.boolean().optional(),
  receiveIdType: FeishuReceiveIdTypeSchema.optional(),
  receiveId: z.string().max(256).optional(),
  allowedOpenIds: z.array(z.string().max(128)).max(100).optional(),
  forwardTiers: z.array(FeishuForwardTierSchema).max(3).optional(),
  respectLowDistraction: z.boolean().optional(),
  replayWindowSeconds: z
    .number()
    .int()
    .min(FEISHU_MIN_REPLAY_WINDOW_SEC)
    .max(FEISHU_MAX_REPLAY_WINDOW_SEC)
    .optional(),
  requireSignature: z.boolean().optional(),
});
export type FeishuConfigPatch = z.infer<typeof FeishuConfigPatchSchema>;

export const FeishuAuditDirectionSchema = z.enum(["outbound", "inbound", "system"]);
export type FeishuAuditDirection = z.infer<typeof FeishuAuditDirectionSchema>;

export const FeishuAuditKindSchema = z.enum([
  "outbound_permission_card",
  "outbound_decision_card",
  "outbound_notification_card",
  "outbound_test_card",
  "outbound_card_update",
  "inbound_challenge",
  "inbound_permission_action",
  "inbound_decision_action",
  "inbound_rejected",
  "inbound_deduplicated",
  "connection_test",
]);
export type FeishuAuditKind = z.infer<typeof FeishuAuditKindSchema>;

export const FeishuAuditStatusSchema = z.enum([
  "succeeded",
  "failed",
  "rejected",
  "deduplicated",
  "filtered",
]);
export type FeishuAuditStatus = z.infer<typeof FeishuAuditStatusSchema>;

export const FeishuAuditRecordSchema = z.object({
  id: z.string(),
  direction: FeishuAuditDirectionSchema,
  kind: FeishuAuditKindSchema,
  status: FeishuAuditStatusSchema,
  title: z.string(),
  summary: z.string(),
  errorCode: z.string().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  messageId: z.string().nullable(),
  actorOpenId: z.string().nullable(),
  eventOrActionId: z.string().nullable(),
  tier: FeishuNotificationTierSchema.nullable(),
  createdAt: z.string(),
});
export type FeishuAuditRecord = z.infer<typeof FeishuAuditRecordSchema>;

export const FeishuStatsSchema = z.object({
  outboundSent: z.number().int().nonnegative(),
  outboundFailed: z.number().int().nonnegative(),
  inboundProcessed: z.number().int().nonnegative(),
  inboundRejected: z.number().int().nonnegative(),
  inboundDeduplicated: z.number().int().nonnegative(),
  lastOutboundAt: z.string().nullable(),
  lastInboundAt: z.string().nullable(),
});
export type FeishuStats = z.infer<typeof FeishuStatsSchema>;

export const FeishuBridgeStateSchema = z.object({
  pluginAvailable: z.boolean(),
  pluginId: z.string(),
  active: z.boolean(),
  webhookPath: z.string(),
  webhookUrl: z.string().nullable(),
  config: FeishuRedactedConfigSchema,
  stats: FeishuStatsSchema,
  recentAudit: z.array(FeishuAuditRecordSchema),
});
export type FeishuBridgeState = z.infer<typeof FeishuBridgeStateSchema>;

export const FeishuConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  apiBaseUrl: z.string(),
  statusCode: z.number().int().nullable(),
  tokenExpiresInSec: z.number().int().nonnegative().nullable(),
  cachedTokenReused: z.boolean().optional(),
  errorCode: z.string().nullable(),
  message: z.string(),
  troubleshootingHint: z.string().nullable(),
  testedAt: z.string(),
});
export type FeishuConnectionTestResult = z.infer<typeof FeishuConnectionTestResultSchema>;

export const FeishuSendTestCardResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  messageId: z.string().nullable(),
  receiveId: z.string(),
  receiveIdType: FeishuReceiveIdTypeSchema,
  errorCode: z.string().nullable(),
  message: z.string(),
  troubleshootingHint: z.string().nullable(),
  sentAt: z.string(),
});
export type FeishuSendTestCardResult = z.infer<typeof FeishuSendTestCardResultSchema>;

export const FeishuBridgeEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("permission_requested"),
    agentId: z.string(),
    serverId: z.string().nullable().optional(),
    requestId: z.string(),
    title: z.string(),
    toolName: z.string(),
    command: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    managed: z.boolean(),
    isRedLine: z.boolean(),
    redLineReason: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
    conversationId: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal("permission_resolved"),
    agentId: z.string(),
    requestId: z.string(),
    behavior: z.string(),
    source: z.enum(["paseo", "feishu"]).optional(),
  }),
  z.object({
    kind: z.literal("decision_created"),
    decisionId: z.string(),
    title: z.string(),
    question: z.string(),
    options: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        leadsTo: z.string(),
      }),
    ),
    recommendedOptionId: z.string().nullable().optional(),
    reason: z.string().nullable().optional(),
    agentId: z.string().nullable().optional(),
    taskId: z.string().nullable().optional(),
    planId: z.string().nullable().optional(),
  }),
  z.object({
    kind: z.literal("decision_answered"),
    decisionId: z.string(),
    optionId: z.string().nullable().optional(),
    answer: z.string(),
    source: z.enum(["paseo", "feishu"]).optional(),
  }),
  z.object({
    kind: z.literal("notification_recorded"),
    receiptId: z.string(),
    category: FeishuNotificationCategorySchema,
    tier: FeishuNotificationTierSchema,
    status: z.enum([
      "queued",
      "delivered",
      "suppressed_quiet",
      "suppressed_night",
      "acknowledged",
      "read",
    ]),
    title: z.string(),
    summary: z.string(),
    reason: z.string().nullable().optional(),
    passthrough: z.boolean().optional(),
    taskId: z.string().nullable().optional(),
    agentId: z.string().nullable().optional(),
  }),
]);
export type FeishuBridgeEvent = z.infer<typeof FeishuBridgeEventSchema>;

export const FeishuDispatchEventResultSchema = z.object({
  dispatched: z.boolean(),
  filtered: z.boolean(),
  reason: z.string().nullable(),
  messageId: z.string().nullable(),
  error: z.string().nullable(),
});
export type FeishuDispatchEventResult = z.infer<typeof FeishuDispatchEventResultSchema>;

export const FeishuWebhookActionIntentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("permission_respond"),
    agentId: z.string(),
    serverId: z.string().nullable(),
    permissionRequestId: z.string(),
    behavior: z.enum(["allow", "deny"]),
    messageId: z.string().nullable(),
    actorOpenId: z.string(),
    actionId: z.string(),
    managedHint: z.boolean().nullable(),
    titleHint: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("decision_answer"),
    decisionId: z.string(),
    optionId: z.string(),
    answer: z.string(),
    messageId: z.string().nullable(),
    actorOpenId: z.string(),
    actionId: z.string(),
    titleHint: z.string().nullable(),
  }),
]);
export type FeishuWebhookActionIntent = z.infer<typeof FeishuWebhookActionIntentSchema>;

export const FeishuWebhookProcessResultSchema = z.object({
  httpStatus: z.number().int(),
  body: z.record(z.string(), z.unknown()),
  actionIntent: FeishuWebhookActionIntentSchema.nullable(),
  errorCode: z.string().nullable(),
});
export type FeishuWebhookProcessResult = z.infer<typeof FeishuWebhookProcessResultSchema>;

export const FeishuCompleteCallbackActionResultSchema = z.object({
  httpStatus: z.number().int(),
  body: z.record(z.string(), z.unknown()),
  cardUpdated: z.boolean(),
  error: z.string().nullable(),
});
export type FeishuCompleteCallbackActionResult = z.infer<
  typeof FeishuCompleteCallbackActionResultSchema
>;

export function resolveApiBaseUrl(
  preset: FeishuDomainPreset,
  customApiBaseUrl?: string | null,
): string {
  if (preset === "feishu") return FEISHU_API_BASE_URLS.feishu;
  if (preset === "lark") return FEISHU_API_BASE_URLS.lark;
  return (customApiBaseUrl ?? "").trim().replace(/\/+$/, "");
}

export const feishuGetStateRpc = defineRpc({
  name: "feishu.get_state",
  input: z.object({
    auditLimit: z.number().int().min(1).max(FEISHU_MAX_AUDIT_RECORDS).optional(),
    webhookUrl: z.string().nullable().optional(),
  }),
  output: FeishuBridgeStateSchema,
});

export const feishuUpdateConfigRpc = defineRpc({
  name: "feishu.update_config",
  input: z.object({
    patch: FeishuConfigPatchSchema,
    webhookUrl: z.string().nullable().optional(),
  }),
  output: FeishuBridgeStateSchema,
});

export const feishuTestConnectionRpc = defineRpc({
  name: "feishu.test_connection",
  input: z.object({
    forceRefreshToken: z.boolean().optional(),
  }),
  output: FeishuConnectionTestResultSchema,
});

export const feishuSendTestCardRpc = defineRpc({
  name: "feishu.send_test_card",
  input: z.object({
    receiveId: z.string().max(256).optional(),
    receiveIdType: FeishuReceiveIdTypeSchema.optional(),
    title: z.string().max(120).optional(),
  }),
  output: FeishuSendTestCardResultSchema,
});

export const feishuListAuditRpc = defineRpc({
  name: "feishu.list_audit",
  input: z.object({
    limit: z.number().int().min(1).max(FEISHU_MAX_AUDIT_RECORDS).optional(),
    direction: FeishuAuditDirectionSchema.optional(),
  }),
  output: z.object({
    records: z.array(FeishuAuditRecordSchema),
    stats: FeishuStatsSchema,
  }),
});

export const feishuDispatchEventRpc = defineRpc({
  name: "feishu.dispatch_event",
  input: FeishuBridgeEventSchema,
  output: FeishuDispatchEventResultSchema,
});

export const feishuHandleWebhookRpc = defineRpc({
  name: "feishu.handle_webhook",
  input: z.object({
    rawBody: z.string(),
    headers: z.object({
      timestamp: z.string().nullable().optional(),
      nonce: z.string().nullable().optional(),
      signature: z.string().nullable().optional(),
    }),
  }),
  output: FeishuWebhookProcessResultSchema,
});

export const feishuCompleteCallbackActionRpc = defineRpc({
  name: "feishu.complete_callback_action",
  input: z.object({
    intent: FeishuWebhookActionIntentSchema,
    succeeded: z.boolean(),
    outcomeLabel: z.string(),
    detailMessage: z.string(),
    errorCode: z.string().nullable().optional(),
  }),
  output: FeishuCompleteCallbackActionResultSchema,
});
