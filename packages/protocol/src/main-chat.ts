import { z } from "zod";
import type { AgentLabelSource } from "./agent-labels.js";
import { ScheduleCadenceSchema, ScheduleStatusSchema } from "./schedule/types.js";

export const MAIN_CHAT_ROLE_LABEL = "paseo.role";
export const MAIN_CHAT_ROLE_VALUE = "main";
export const MAIN_CHAT_FORMER_ROLE_VALUE = "main-former";
export const MAIN_CHAT_CONVERSATION_ID_LABEL = "paseo.main-chat.conversation-id";
export const MAIN_CHAT_CONVERSATION_KIND_LABEL = "paseo.main-chat.conversation-kind";
export const MAIN_CHAT_REPLACED_BY_LABEL = "paseo.main-chat.replaced-by";
export const MAIN_CHAT_TASK_PLAN_ID_LABEL = "paseo.main-chat.plan-id";
export const MAIN_CHAT_TASK_ID_LABEL = "paseo.main-chat.task-id";
export const MAIN_CHAT_TASK_RECORD_ID_LABEL = "paseo.main-chat.task-record-id";
export const MAIN_CHAT_TASK_MODE_LABEL = "paseo.main-chat.mode";
export const MAIN_CHAT_TASK_GOAL_LABEL = "paseo.main-chat.goal";
export const MAIN_CHAT_TASK_QUIET_LABEL = "paseo.main-chat.quiet";
export const MAIN_CHAT_WORKSPACE_DIR_NAME = "main-chat";
export const MAIN_CHAT_MEMORY_DIR_NAME = "memory";
export const MAIN_CHAT_DEFAULT_TITLE = "对话管理";
export const MAIN_CHAT_COMPACT_WINDOW_RATIO = 0.8;
export const MAIN_CHAT_DEFAULT_COMPACT_WINDOW_CAP_TOKENS = 400_000;
export const MAIN_CHAT_MIN_COMPACT_WINDOW_CAP_TOKENS = 100_000;
export const MAIN_CHAT_MAX_COMPACT_WINDOW_CAP_TOKENS = 10_000_000;
export const MAIN_CHAT_DEFAULT_IDLE_PRECOMPACT_MINUTES = 10;
export const MAIN_CHAT_MIN_IDLE_PRECOMPACT_MINUTES = 1;
export const MAIN_CHAT_MAX_IDLE_PRECOMPACT_MINUTES = 240;
export const MAIN_CHAT_DEFAULT_CACHE_KEEPALIVE_INTERVAL_MIN = 55;
export const MAIN_CHAT_MIN_CACHE_KEEPALIVE_INTERVAL_MIN = 1;
export const MAIN_CHAT_MAX_CACHE_KEEPALIVE_INTERVAL_MIN = 55;
export const MAIN_CHAT_DEFAULT_CACHE_KEEPALIVE_MAX_REQUESTS = 24;
export const MAIN_CHAT_MIN_CACHE_KEEPALIVE_MAX_REQUESTS = 1;
export const MAIN_CHAT_MAX_CACHE_KEEPALIVE_MAX_REQUESTS = 144;
export const MAIN_CHAT_MAX_LIMIT_FALLBACKS = 8;
export const MAIN_CHAT_BACKGROUND_COMPACTION_MSG_PREFIX = "paseo-bg-compaction:";
export const MAIN_CHAT_ABOUT_ME_MAX_CHARS = 4000;
export const MAIN_CHAT_OWNER_ALIAS_MAX_CHARS = 40;
export const MAIN_CHAT_OWNER_ALIASES_MAX_COUNT = 12;
export const MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS = 4000;
export const MAIN_CHAT_MEMORY_PATH_MAX_CHARS = 180;
export const MAIN_CHAT_MEMORY_FILE_MAX_BYTES = 64 * 1024;
export const MAIN_CHAT_MEMORY_CONTEXT_TOTAL_BUDGET_BYTES = 12 * 1024;
export const MAIN_CHAT_MEMORY_PROFILE_BUDGET_BYTES = 4096;
export const MAIN_CHAT_MEMORY_DIRECTION_BUDGET_BYTES = 4096;
export const MAIN_CHAT_MEMORY_FILES_BUDGET_BYTES = 4096;
export const MAIN_CHAT_LESSON_TEXT_MAX_CHARS = 240;
export const MAIN_CHAT_LESSON_PROJECT_KEY_MAX_CHARS = 512;
export const MAIN_CHAT_LESSON_PROJECT_LABEL_MAX_CHARS = 120;
export const MAIN_CHAT_LESSONS_PER_TASK_MAX = 3;
export const MAIN_CHAT_LESSONS_INJECT_MAX_COUNT = 5;
export const MAIN_CHAT_LESSONS_INJECT_PER_KIND_MAX = 2;
export const MAIN_CHAT_LESSONS_INJECT_BUDGET_BYTES = 1800;
export const MAIN_CHAT_LESSONS_FRESH_DAYS = 90;
export const MAIN_CHAT_LESSONS_MAX_SOURCES = 5;
export const MAIN_CHAT_MODEL_PURPOSES = [
  "main",
  "directionLead",
  "subagentDefault",
  "subagentReadonly",
  "backgroundTriage",
] as const;
export const MAIN_CHAT_BUILTIN_MODEL_PROFILE_IDS = ["performance", "balanced", "economy"] as const;
export const MAIN_CHAT_MAX_CUSTOM_MODEL_PROFILES = 12;
export const MAIN_CHAT_MAX_MODEL_PROFILE_HISTORY = 20;
export const MAIN_CHAT_NOTIFICATION_TIERS = ["critical", "actionable", "digest", "silent"] as const;
export const MAIN_CHAT_NOTIFICATION_CATEGORIES = [
  "permission_approval",
  "decision_required",
  "task_failed",
  "delivery_gate_blocked",
  "task_review",
  "task_progress",
  "rule_diagnostic",
  "patrol_summary",
] as const;
export const MAIN_CHAT_CRITICAL_PASSTHROUGH_CATEGORIES = [
  "permission_approval",
  "decision_required",
  "task_failed",
  "delivery_gate_blocked",
] as const;
export const MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS = 120;
export const MAIN_CHAT_DEFAULT_MAX_CONCURRENT_PER_HOST = 6;
export const MAIN_CHAT_MIN_CONCURRENT_PER_HOST = 1;
export const MAIN_CHAT_MAX_CONCURRENT_PER_HOST = 64;
export const MAIN_CHAT_DEFAULT_MAX_CPU_PERCENT = 85;
export const MAIN_CHAT_MIN_CPU_PERCENT = 20;
export const MAIN_CHAT_MAX_CPU_PERCENT = 100;
export const MAIN_CHAT_DEFAULT_MIN_FREE_MEMORY_MB = 1024;
export const MAIN_CHAT_MIN_FREE_MEMORY_MB = 128;
export const MAIN_CHAT_MAX_FREE_MEMORY_MB = 262_144;
export const MAIN_CHAT_MAX_ADMISSION_QUEUE = 100;
export const MAIN_CHAT_TOOL_GROUP_IDS = [
  "core",
  "memory",
  "lessons",
  "routines",
  "dag",
  "settings",
  "conversations",
] as const;
export const MAIN_CHAT_DEFAULT_IDLE_ARCHIVE_THRESHOLD_MIN = 60;
export const MAIN_CHAT_MIN_IDLE_ARCHIVE_THRESHOLD_MIN = 5;
export const MAIN_CHAT_MAX_IDLE_ARCHIVE_THRESHOLD_MIN = 10_080;
export const MAIN_CHAT_DEFAULT_IDLE_ARCHIVE_SWEEP_INTERVAL_MIN = 15;
export const MAIN_CHAT_MIN_IDLE_ARCHIVE_SWEEP_INTERVAL_MIN = 5;
export const MAIN_CHAT_MAX_IDLE_ARCHIVE_SWEEP_INTERVAL_MIN = 1440;
export const MAIN_CHAT_DEFAULT_IDLE_ARCHIVE_MAX_PER_SWEEP = 10;
export const MAIN_CHAT_MIN_IDLE_ARCHIVE_MAX_PER_SWEEP = 1;
export const MAIN_CHAT_MAX_IDLE_ARCHIVE_MAX_PER_SWEEP = 50;
export const MAIN_CHAT_MAX_IDLE_ARCHIVE_AUDIT_RECORDS = 100;
export const MAIN_CHAT_MAX_CUSTOM_PROMPT_TEMPLATES = 80;
export const MAIN_CHAT_PROMPT_SLUG_MAX_CHARS = 40;
export const MAIN_CHAT_PROMPT_TITLE_MAX_CHARS = 60;
export const MAIN_CHAT_PROMPT_DESC_MAX_CHARS = 160;
export const MAIN_CHAT_PROMPT_CONTENT_MAX_CHARS = 4000;
export const MAIN_CHAT_PROMPT_RESERVED_SLUGS = ["exit", "quit", "q", "clear", "new"] as const;

export const FEISHU_BRIDGE_PLUGIN_ID = "feishu-bot-bridge";
export const FEISHU_BRIDGE_WEBHOOK_PATH = "/api/plugins/feishu-bot-bridge/webhook";
export const FEISHU_BRIDGE_DOMAIN_PRESETS = ["feishu", "lark", "custom"] as const;
export const FEISHU_BRIDGE_API_BASE_URLS = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
} as const;
export const FEISHU_BRIDGE_RECEIVE_ID_TYPES = ["chat_id", "open_id", "user_id"] as const;
export const FEISHU_BRIDGE_FORWARD_TIERS = ["critical", "actionable", "digest"] as const;
export const FEISHU_BRIDGE_DEFAULT_REPLAY_WINDOW_SEC = 300;
export const FEISHU_BRIDGE_MIN_REPLAY_WINDOW_SEC = 30;
export const FEISHU_BRIDGE_MAX_REPLAY_WINDOW_SEC = 3600;
export const FEISHU_BRIDGE_MAX_AUDIT_RECORDS = 100;

export const MAIN_CHAT_PROPOSABLE_SETTINGS_KEYS = [
  "title",
  "style",
  "autoCompactEnabled",
  "mainBackgroundFolded",
  "mainTasksQuiet",
  "taskLessonsEnabled",
  "deliveryGatePolicy",
  "compaction.windowCapTokens",
  "compaction.idlePrecompactMinIdleMin",
  "cacheKeepalive.enabled",
  "cacheKeepalive.intervalMinutes",
  "cacheKeepalive.maxRequests",
  "nightMode.enabled",
  "nightMode.startHour",
  "nightMode.endHour",
  "nightMode.behavior",
  "nightMode.patrolIntervalSec",
  "nightMode.autoHibernateAfterIdleMin",
  "intervals.patrolIntervalSec",
  "intervals.triageSettleSec",
  "intervals.stalledThresholdMin",
  "intervals.noProgressThresholdMin",
  "intervals.needsYouEscalateMin",
  "intervals.wakeupCooldownMin",
  "limitFallbacks",
  "modelConfig.activeProfileId",
  "modelConfig.slots",
  "notificationPolicy.lowDistractionEnabled",
  "notificationPolicy.mode",
  "notificationPolicy.foldLowPriorityToDigest",
  "notificationPolicy.categoryOverrides",
  "profile.aboutMe",
  "profile.ownerAliases",
  "resourceAdmission.enabled",
  "resourceAdmission.maxConcurrentPerHost",
  "resourceAdmission.maxCpuPercent",
  "resourceAdmission.minFreeMemoryMb",
  "resourceAdmission.queueWhenPressured",
  "statelessBackgroundSupervision",
  "onDemandToolLoading",
  "idleArchivePolicy.enabled",
  "idleArchivePolicy.idleThresholdMinutes",
  "idleArchivePolicy.sweepIntervalMinutes",
  "idleArchivePolicy.maxArchivePerSweep",
] as const;
export type MainChatProposableSettingKey = (typeof MAIN_CHAT_PROPOSABLE_SETTINGS_KEYS)[number];

export const MainChatBackgroundTurnKindSchema = z.enum([
  "patrol",
  "supervision",
  "relay",
  "briefing",
  "compaction",
  "routine",
  "cache_keepalive",
  "recovery",
  "system",
]);
export type MainChatBackgroundTurnKind = z.infer<typeof MainChatBackgroundTurnKindSchema>;

export const MainChatBackgroundTurnMetadataSchema = z.object({
  foldable: z.boolean(),
  kind: MainChatBackgroundTurnKindSchema,
  trigger: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  activityId: z.string().nullable().optional(),
  quiet: z.boolean().optional(),
});
export type MainChatBackgroundTurnMetadata = z.infer<typeof MainChatBackgroundTurnMetadataSchema>;

export const MainChatProfileSchema = z.object({
  aboutMe: z.string().max(MAIN_CHAT_ABOUT_ME_MAX_CHARS),
  ownerAliases: z
    .array(z.string().trim().min(1).max(MAIN_CHAT_OWNER_ALIAS_MAX_CHARS))
    .max(MAIN_CHAT_OWNER_ALIASES_MAX_COUNT),
  updatedAt: z.string().nullable().optional(),
});
export type MainChatProfile = z.infer<typeof MainChatProfileSchema>;

export const MainChatProfilePatchSchema = z.object({
  aboutMe: z.string().max(MAIN_CHAT_ABOUT_ME_MAX_CHARS).optional(),
  ownerAliases: z
    .array(z.string().trim().min(1).max(MAIN_CHAT_OWNER_ALIAS_MAX_CHARS))
    .max(MAIN_CHAT_OWNER_ALIASES_MAX_COUNT)
    .optional(),
});
export type MainChatProfilePatch = z.infer<typeof MainChatProfilePatchSchema>;

export const MainChatMemoryFileMetaSchema = z.object({
  path: z.string().min(1).max(MAIN_CHAT_MEMORY_PATH_MAX_CHARS),
  bytes: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type MainChatMemoryFileMeta = z.infer<typeof MainChatMemoryFileMetaSchema>;

export const MainChatMemoryFileContentSchema = MainChatMemoryFileMetaSchema.extend({
  content: z.string(),
});
export type MainChatMemoryFileContent = z.infer<typeof MainChatMemoryFileContentSchema>;

export const MainChatStyleSchema = z.enum(["conservative", "proactive"]);
export type MainChatStyle = z.infer<typeof MainChatStyleSchema>;

export const MainChatBackgroundModelModeSchema = z.enum(["auto", "main", "custom"]);
export type MainChatBackgroundModelMode = z.infer<typeof MainChatBackgroundModelModeSchema>;

export const MainChatBackgroundModelConfigSchema = z.object({
  mode: MainChatBackgroundModelModeSchema,
  provider: z.string().nullable(),
  model: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
});
export type MainChatBackgroundModelConfig = z.infer<typeof MainChatBackgroundModelConfigSchema>;

export const MainChatIntervalsSchema = z.object({
  patrolIntervalSec: z.number().int().min(15).max(3600),
  triageSettleSec: z.number().int().min(5).max(300),
  stalledThresholdMin: z.number().int().min(2).max(240),
  noProgressThresholdMin: z.number().int().min(2).max(120),
  needsYouEscalateMin: z.number().int().min(1).max(120),
  wakeupCooldownMin: z.number().int().min(1).max(240),
});
export type MainChatIntervals = z.infer<typeof MainChatIntervalsSchema>;

export const MainChatCapabilitiesSchema = z.object({
  semanticTriageEnabled: z.boolean(),
  proactiveWakeupEnabled: z.boolean(),
  initialBriefingEnabled: z.boolean(),
  autoContinueManualErrors: z.boolean(),
  autoDelegateManualQuestions: z.boolean(),
  autoNudgeManualStalled: z.boolean(),
});
export type MainChatCapabilities = z.infer<typeof MainChatCapabilitiesSchema>;

export const MainChatNightModeBehaviorSchema = z.enum(["throttle", "hibernate"]);
export type MainChatNightModeBehavior = z.infer<typeof MainChatNightModeBehaviorSchema>;

export const MainChatNightModeConfigSchema = z.object({
  enabled: z.boolean(),
  startHour: z.number().int().min(0).max(23),
  endHour: z.number().int().min(0).max(23),
  behavior: MainChatNightModeBehaviorSchema,
  patrolIntervalSec: z.number().int().min(60).max(7200),
  autoHibernateAfterIdleMin: z.number().int().min(0).max(480),
  disableSemanticTriage: z.boolean(),
  deferProactiveWakeups: z.boolean(),
  allowUrgentWakeups: z.boolean(),
});
export type MainChatNightModeConfig = z.infer<typeof MainChatNightModeConfigSchema>;

export const MainChatRuntimePowerStateSchema = z.enum([
  "active",
  "throttled",
  "hibernating",
  "disabled",
]);
export type MainChatRuntimePowerState = z.infer<typeof MainChatRuntimePowerStateSchema>;

export const MainChatNightModeStatusSchema = z.object({
  state: MainChatRuntimePowerStateSchema,
  inNightWindow: z.boolean(),
  effectivePatrolIntervalSec: z.number().int().nonnegative(),
  nextTransitionAt: z.string().nullable(),
  reason: z.string().nullable(),
});
export type MainChatNightModeStatus = z.infer<typeof MainChatNightModeStatusSchema>;

export const MainChatTokenUsageSourceSchema = z.enum([
  "foreground",
  "background",
  "direction",
  "triage",
]);
export type MainChatTokenUsageSource = z.infer<typeof MainChatTokenUsageSourceSchema>;

export const MainChatTokenUsageCountersSchema = z.object({
  turns: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
});
export type MainChatTokenUsageCounters = z.infer<typeof MainChatTokenUsageCountersSchema>;

export const MainChatTokenUsageBySourceSchema = z.object({
  foreground: MainChatTokenUsageCountersSchema,
  background: MainChatTokenUsageCountersSchema,
  direction: MainChatTokenUsageCountersSchema,
  triage: MainChatTokenUsageCountersSchema,
});
export type MainChatTokenUsageBySource = z.infer<typeof MainChatTokenUsageBySourceSchema>;

export const MainChatTokenUsageDayEntrySchema = MainChatTokenUsageCountersSchema.extend({
  date: z.string(),
  bySource: MainChatTokenUsageBySourceSchema,
});
export type MainChatTokenUsageDayEntry = z.infer<typeof MainChatTokenUsageDayEntrySchema>;

export const MainChatTokenUsageModelEntrySchema = MainChatTokenUsageCountersSchema.extend({
  provider: z.string(),
  model: z.string().nullable(),
});
export type MainChatTokenUsageModelEntry = z.infer<typeof MainChatTokenUsageModelEntrySchema>;

export const MainChatTokenUsageSummarySchema = z.object({
  today: MainChatTokenUsageCountersSchema,
  last7Days: MainChatTokenUsageCountersSchema,
  allTime: MainChatTokenUsageCountersSchema,
  bySource: MainChatTokenUsageBySourceSchema,
  byModel: z.array(MainChatTokenUsageModelEntrySchema),
  daily: z.array(MainChatTokenUsageDayEntrySchema),
  updatedAt: z.string().nullable(),
});
export type MainChatTokenUsageSummary = z.infer<typeof MainChatTokenUsageSummarySchema>;

export const MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS = 32;
export const MAIN_CHAT_MAX_FLEET_SCOPE_HOSTS = 64;

export const MainChatFleetScopeModeSchema = z.enum(["all_connected", "local_only", "allowlist"]);
export type MainChatFleetScopeMode = z.infer<typeof MainChatFleetScopeModeSchema>;

export const MainChatFleetScopeSchema = z.object({
  mode: MainChatFleetScopeModeSchema,
  hostServerIds: z.array(z.string().min(1)).max(MAIN_CHAT_MAX_FLEET_SCOPE_HOSTS),
});
export type MainChatFleetScope = z.infer<typeof MainChatFleetScopeSchema>;

export const MainChatFleetScopePatchSchema = z.object({
  mode: MainChatFleetScopeModeSchema.optional(),
  hostServerIds: z.array(z.string().min(1)).max(MAIN_CHAT_MAX_FLEET_SCOPE_HOSTS).optional(),
});
export type MainChatFleetScopePatch = z.infer<typeof MainChatFleetScopePatchSchema>;

export const MainChatCustomStylePresetSchema = z.object({
  id: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(32),
  description: z.string().trim().max(160).optional(),
  baseStyle: MainChatStyleSchema,
  customGuidance: z.string().trim().max(1200).optional(),
  intervals: MainChatIntervalsSchema,
  capabilities: MainChatCapabilitiesSchema,
  updatedAt: z.string().optional(),
});
export type MainChatCustomStylePreset = z.infer<typeof MainChatCustomStylePresetSchema>;

export const MainChatCompactionConfigSchema = z.object({
  windowCapTokens: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_COMPACT_WINDOW_CAP_TOKENS)
    .max(MAIN_CHAT_MAX_COMPACT_WINDOW_CAP_TOKENS)
    .nullable(),
  idlePrecompactMinIdleMin: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_IDLE_PRECOMPACT_MINUTES)
    .max(MAIN_CHAT_MAX_IDLE_PRECOMPACT_MINUTES),
});
export type MainChatCompactionConfig = z.infer<typeof MainChatCompactionConfigSchema>;

export const MainChatCompactionConfigPatchSchema = z.object({
  windowCapTokens: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_COMPACT_WINDOW_CAP_TOKENS)
    .max(MAIN_CHAT_MAX_COMPACT_WINDOW_CAP_TOKENS)
    .nullable()
    .optional(),
  idlePrecompactMinIdleMin: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_IDLE_PRECOMPACT_MINUTES)
    .max(MAIN_CHAT_MAX_IDLE_PRECOMPACT_MINUTES)
    .optional(),
});
export type MainChatCompactionConfigPatch = z.infer<typeof MainChatCompactionConfigPatchSchema>;

export const MainChatCacheKeepaliveConfigSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_CACHE_KEEPALIVE_INTERVAL_MIN)
    .max(MAIN_CHAT_MAX_CACHE_KEEPALIVE_INTERVAL_MIN),
  maxRequests: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_CACHE_KEEPALIVE_MAX_REQUESTS)
    .max(MAIN_CHAT_MAX_CACHE_KEEPALIVE_MAX_REQUESTS),
});
export type MainChatCacheKeepaliveConfig = z.infer<typeof MainChatCacheKeepaliveConfigSchema>;

export const MainChatCacheKeepaliveConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  intervalMinutes: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_CACHE_KEEPALIVE_INTERVAL_MIN)
    .max(MAIN_CHAT_MAX_CACHE_KEEPALIVE_INTERVAL_MIN)
    .optional(),
  maxRequests: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_CACHE_KEEPALIVE_MAX_REQUESTS)
    .max(MAIN_CHAT_MAX_CACHE_KEEPALIVE_MAX_REQUESTS)
    .optional(),
});
export type MainChatCacheKeepaliveConfigPatch = z.infer<
  typeof MainChatCacheKeepaliveConfigPatchSchema
>;

export const MainChatCacheKeepaliveStatusSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number().int().positive(),
  maxRequests: z.number().int().positive(),
  activeTargets: z.number().int().nonnegative(),
  pingsSentTotal: z.number().int().nonnegative(),
  lastPingAt: z.string().nullable(),
  lastYieldReason: z.string().nullable(),
});
export type MainChatCacheKeepaliveStatus = z.infer<typeof MainChatCacheKeepaliveStatusSchema>;

export const MainChatLimitFallbackEntrySchema = z.object({
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1).nullable().optional(),
  label: z.string().trim().max(80).nullable().optional(),
});
export type MainChatLimitFallbackEntry = z.infer<typeof MainChatLimitFallbackEntrySchema>;

export const MainChatLimitFallbackEventSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  agentRole: z.enum(["main", "managed_task"]),
  fromProvider: z.string(),
  fromModel: z.string().nullable(),
  toProvider: z.string(),
  toModel: z.string().nullable(),
  reason: z.string(),
  createdAt: z.string(),
});
export type MainChatLimitFallbackEvent = z.infer<typeof MainChatLimitFallbackEventSchema>;

export const MainChatDeliveryGatePolicySchema = z.enum(["off", "merged", "live"]);
export type MainChatDeliveryGatePolicy = z.infer<typeof MainChatDeliveryGatePolicySchema>;

export const MainChatDeliveryPrStateSchema = z.enum(["open", "merged", "closed"]);
export type MainChatDeliveryPrState = z.infer<typeof MainChatDeliveryPrStateSchema>;

export const MainChatDeliveryCiStateSchema = z.enum(["unknown", "pending", "passing", "failing"]);
export type MainChatDeliveryCiState = z.infer<typeof MainChatDeliveryCiStateSchema>;

export const MainChatDeliveryGateStatusSchema = z.enum([
  "clear",
  "draft",
  "conflict",
  "ci_failed",
  "awaiting_merge",
  "merged",
  "closed",
]);
export type MainChatDeliveryGateStatus = z.infer<typeof MainChatDeliveryGateStatusSchema>;

export const MainChatTaskDeliveryGateSchema = z.object({
  prUrl: z.string().nullable(),
  prNumber: z.number().int().positive().nullable().optional(),
  branch: z.string().nullable().optional(),
  prState: MainChatDeliveryPrStateSchema.nullable(),
  isDraft: z.boolean(),
  hasConflict: z.boolean(),
  ciStatus: MainChatDeliveryCiStateSchema,
  ciSummary: z.string().nullable().optional(),
  reviewDecision: z.string().nullable().optional(),
  headOid: z.string().nullable().optional(),
  gateStatus: MainChatDeliveryGateStatusSchema,
  blockingReasons: z.array(z.string()),
  followUpActive: z.boolean(),
  lastCheckedAt: z.string().nullable(),
  mergedAt: z.string().nullable().optional(),
});
export type MainChatTaskDeliveryGate = z.infer<typeof MainChatTaskDeliveryGateSchema>;

export const MainChatTaskDependencyStateSchema = z.enum(["none", "blocked", "ready"]);
export type MainChatTaskDependencyState = z.infer<typeof MainChatTaskDependencyStateSchema>;

export const MainChatLessonKindSchema = z.enum([
  "repeated_mistake",
  "missing_context",
  "wasted_step",
  "improvement",
]);
export type MainChatLessonKind = z.infer<typeof MainChatLessonKindSchema>;

export const MAIN_CHAT_LESSON_KINDS: readonly MainChatLessonKind[] = [
  "repeated_mistake",
  "missing_context",
  "wasted_step",
  "improvement",
];

export const MainChatLessonOriginSchema = z.enum(["auto_rework", "auto_review", "manual", "tool"]);
export type MainChatLessonOrigin = z.infer<typeof MainChatLessonOriginSchema>;

export const MainChatProjectLessonSchema = z.object({
  id: z.string(),
  projectKey: z.string().min(1).max(MAIN_CHAT_LESSON_PROJECT_KEY_MAX_CHARS),
  projectLabel: z.string().min(1).max(MAIN_CHAT_LESSON_PROJECT_LABEL_MAX_CHARS),
  kind: MainChatLessonKindSchema,
  text: z.string().min(1).max(MAIN_CHAT_LESSON_TEXT_MAX_CHARS),
  origin: MainChatLessonOriginSchema,
  seenCount: z.number().int().positive(),
  sourceTaskIds: z.array(z.string()),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  retiredAt: z.string().nullable().optional(),
});
export type MainChatProjectLesson = z.infer<typeof MainChatProjectLessonSchema>;

export const MainChatProjectLessonGroupSchema = z.object({
  projectKey: z.string(),
  projectLabel: z.string(),
  lessonCount: z.number().int().nonnegative(),
  lessons: z.array(MainChatProjectLessonSchema),
});
export type MainChatProjectLessonGroup = z.infer<typeof MainChatProjectLessonGroupSchema>;

// ============================================================================
// P1-4 Multi-Purpose Model Slots & Model Profiles Schemas
// ============================================================================

export const MainChatModelPurposeSchema = z.enum(MAIN_CHAT_MODEL_PURPOSES);
export type MainChatModelPurpose = z.infer<typeof MainChatModelPurposeSchema>;

export const MainChatBuiltinModelProfileIdSchema = z.enum(MAIN_CHAT_BUILTIN_MODEL_PROFILE_IDS);
export type MainChatBuiltinModelProfileId = z.infer<typeof MainChatBuiltinModelProfileIdSchema>;

export const MainChatModelSlotBindingSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  model: z.string().trim().min(1).max(120).nullable().optional(),
  thinkingOptionId: z.string().trim().min(1).max(64).nullable().optional(),
  label: z.string().trim().min(1).max(80).nullable().optional(),
});
export type MainChatModelSlotBinding = z.infer<typeof MainChatModelSlotBindingSchema>;

export const MainChatModelSlotsSchema = z.object({
  main: MainChatModelSlotBindingSchema.nullable().optional(),
  directionLead: MainChatModelSlotBindingSchema.nullable().optional(),
  subagentDefault: MainChatModelSlotBindingSchema.nullable().optional(),
  subagentReadonly: MainChatModelSlotBindingSchema.nullable().optional(),
  backgroundTriage: MainChatModelSlotBindingSchema.nullable().optional(),
});
export type MainChatModelSlots = z.infer<typeof MainChatModelSlotsSchema>;

export const MainChatModelProfileSchema = z.object({
  id: z.string().trim().min(1).max(48),
  name: z.string().trim().min(1).max(48),
  description: z.string().trim().max(240).optional(),
  builtin: z.boolean().optional(),
  slots: MainChatModelSlotsSchema,
  updatedAt: z.string().optional(),
});
export type MainChatModelProfile = z.infer<typeof MainChatModelProfileSchema>;

export const MainChatModelProfileSwitchEventSchema = z.object({
  id: z.string(),
  action: z.enum(["switch", "rollback"]),
  fromProfileId: z.string().nullable(),
  toProfileId: z.string().nullable(),
  changedSlots: z.array(MainChatModelPurposeSchema),
  actor: z.enum(["user", "proposal", "tool"]),
  createdAt: z.string(),
});
export type MainChatModelProfileSwitchEvent = z.infer<typeof MainChatModelProfileSwitchEventSchema>;

export const MainChatModelProfileRollbackSchema = z.object({
  profileId: z.string().nullable(),
  slots: MainChatModelSlotsSchema,
  savedAt: z.string(),
});
export type MainChatModelProfileRollback = z.infer<typeof MainChatModelProfileRollbackSchema>;

export const MainChatModelConfigSchema = z.object({
  activeProfileId: z.string().trim().min(1).max(48).nullable().optional(),
  slots: MainChatModelSlotsSchema.optional(),
  customProfiles: z
    .array(MainChatModelProfileSchema)
    .max(MAIN_CHAT_MAX_CUSTOM_MODEL_PROFILES)
    .optional(),
  rollbackSnapshot: MainChatModelProfileRollbackSchema.nullable().optional(),
  switchHistory: z
    .array(MainChatModelProfileSwitchEventSchema)
    .max(MAIN_CHAT_MAX_MODEL_PROFILE_HISTORY)
    .optional(),
});
export type MainChatModelConfig = z.infer<typeof MainChatModelConfigSchema>;

export const MainChatModelConfigPatchSchema = z.object({
  activeProfileId: z.string().trim().min(1).max(48).nullable().optional(),
  applyProfileId: z.string().trim().min(1).max(48).optional(),
  rollbackProfile: z.boolean().optional(),
  slots: MainChatModelSlotsSchema.optional(),
  upsertCustomProfile: MainChatModelProfileSchema.optional(),
  deleteCustomProfileId: z.string().trim().min(1).max(48).optional(),
  customProfiles: z
    .array(MainChatModelProfileSchema)
    .max(MAIN_CHAT_MAX_CUSTOM_MODEL_PROFILES)
    .optional(),
});
export type MainChatModelConfigPatch = z.infer<typeof MainChatModelConfigPatchSchema>;

// ============================================================================
// P1-5 Notification Tiering, Low-Distraction Policy & Delivery Receipts
// ============================================================================

export const MainChatNotificationTierSchema = z.enum(MAIN_CHAT_NOTIFICATION_TIERS);
export type MainChatNotificationTier = z.infer<typeof MainChatNotificationTierSchema>;

export const MainChatNotificationCategorySchema = z.enum(MAIN_CHAT_NOTIFICATION_CATEGORIES);
export type MainChatNotificationCategory = z.infer<typeof MainChatNotificationCategorySchema>;

export const MainChatNotificationModePresetSchema = z.enum(["all", "balanced", "low_distraction"]);
export type MainChatNotificationModePreset = z.infer<typeof MainChatNotificationModePresetSchema>;

export const MainChatNotificationPolicySchema = z.object({
  lowDistractionEnabled: z.boolean(),
  mode: MainChatNotificationModePresetSchema.optional(),
  foldLowPriorityToDigest: z.boolean(),
  categoryOverrides: z.record(z.string(), MainChatNotificationTierSchema).optional(),
});
export type MainChatNotificationPolicy = z.infer<typeof MainChatNotificationPolicySchema>;

export const MainChatNotificationPolicyPatchSchema = z.object({
  lowDistractionEnabled: z.boolean().optional(),
  mode: MainChatNotificationModePresetSchema.optional(),
  foldLowPriorityToDigest: z.boolean().optional(),
  categoryOverrides: z.record(z.string(), MainChatNotificationTierSchema.nullable()).optional(),
});
export type MainChatNotificationPolicyPatch = z.infer<typeof MainChatNotificationPolicyPatchSchema>;

export const MainChatNotificationDeliveryStatusSchema = z.enum([
  "queued",
  "delivered",
  "suppressed_quiet",
  "suppressed_night",
  "acknowledged",
  "read",
]);
export type MainChatNotificationDeliveryStatus = z.infer<
  typeof MainChatNotificationDeliveryStatusSchema
>;

export const MainChatNotificationChannelSchema = z.enum([
  "main_chat",
  "push",
  "badge",
  "digest",
  "drawer",
]);
export type MainChatNotificationChannel = z.infer<typeof MainChatNotificationChannelSchema>;

export const MainChatNotificationSummarySchema = z.object({
  lowDistractionEnabled: z.boolean(),
  mode: MainChatNotificationModePresetSchema,
  unreadCount: z.number().int().nonnegative(),
  deliveredCount: z.number().int().nonnegative(),
  suppressedQuietCount: z.number().int().nonnegative(),
  suppressedNightCount: z.number().int().nonnegative(),
  foldedDigestCount: z.number().int().nonnegative(),
  criticalPassthroughCount: z.number().int().nonnegative(),
  latestReceiptAt: z.string().nullable(),
});
export type MainChatNotificationSummary = z.infer<typeof MainChatNotificationSummarySchema>;

// ============================================================================
// P1-6 Zero-Token Deterministic Rule Diagnostics
// ============================================================================

export const MainChatRuleDiagnosticKindSchema = z.enum([
  "read_without_reply",
  "missing_wrap_up",
  "tool_loop",
]);
export type MainChatRuleDiagnosticKind = z.infer<typeof MainChatRuleDiagnosticKindSchema>;

export const MainChatToolLoopPatternSchema = z.enum([
  "exact_repeat",
  "alternating_ab",
  "repeated_error",
]);
export type MainChatToolLoopPattern = z.infer<typeof MainChatToolLoopPatternSchema>;

export const MainChatRuleDiagnosticSeveritySchema = z.enum(["warning", "critical"]);
export type MainChatRuleDiagnosticSeverity = z.infer<typeof MainChatRuleDiagnosticSeveritySchema>;

export const MainChatRuleDiagnosticSchema = z.object({
  kind: MainChatRuleDiagnosticKindSchema,
  severity: MainChatRuleDiagnosticSeveritySchema,
  summary: z.string(),
  detail: z.string().nullable().optional(),
  detectedAt: z.string(),
  toolName: z.string().nullable().optional(),
  repeatCount: z.number().int().positive().nullable().optional(),
  pattern: MainChatToolLoopPatternSchema.nullable().optional(),
  errorExcerpt: z.string().nullable().optional(),
  missingItems: z.array(z.string()).optional(),
});
export type MainChatRuleDiagnostic = z.infer<typeof MainChatRuleDiagnosticSchema>;

// ============================================================================
// P2-2 Cross-Host Resource Admission Schemas
// ============================================================================

export const MainChatResourceAdmissionPolicySchema = z.object({
  enabled: z.boolean(),
  maxConcurrentPerHost: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_CONCURRENT_PER_HOST)
    .max(MAIN_CHAT_MAX_CONCURRENT_PER_HOST),
  maxCpuPercent: z.number().int().min(MAIN_CHAT_MIN_CPU_PERCENT).max(MAIN_CHAT_MAX_CPU_PERCENT),
  minFreeMemoryMb: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_FREE_MEMORY_MB)
    .max(MAIN_CHAT_MAX_FREE_MEMORY_MB),
  queueWhenPressured: z.boolean(),
});
export type MainChatResourceAdmissionPolicy = z.infer<typeof MainChatResourceAdmissionPolicySchema>;

export const MainChatResourceAdmissionPolicyPatchSchema =
  MainChatResourceAdmissionPolicySchema.partial();
export type MainChatResourceAdmissionPolicyPatch = z.infer<
  typeof MainChatResourceAdmissionPolicyPatchSchema
>;

export const MainChatResourcePressureReasonSchema = z.enum([
  "concurrency_limit",
  "cpu_high",
  "memory_low",
  "host_offline",
  "host_degraded",
]);
export type MainChatResourcePressureReason = z.infer<typeof MainChatResourcePressureReasonSchema>;

export const MainChatHostResourceStatusSchema = z.enum([
  "healthy",
  "pressured",
  "offline",
  "degraded",
]);
export type MainChatHostResourceStatus = z.infer<typeof MainChatHostResourceStatusSchema>;

export const MainChatHostResourceSnapshotSchema = z.object({
  serverId: z.string(),
  hostLabel: z.string(),
  isLocal: z.boolean(),
  status: MainChatHostResourceStatusSchema,
  cpuPercent: z.number().min(0).max(1000).nullable(),
  loadAvg1m: z.number().min(0).nullable(),
  cpuCores: z.number().int().positive().nullable(),
  freeMemoryMb: z.number().min(0).nullable(),
  totalMemoryMb: z.number().min(0).nullable(),
  activeManagedAgents: z.number().int().nonnegative(),
  maxConcurrent: z.number().int().positive(),
  pressureReasons: z.array(MainChatResourcePressureReasonSchema),
  pressureSummary: z.string().nullable(),
  sampledAt: z.string(),
});
export type MainChatHostResourceSnapshot = z.infer<typeof MainChatHostResourceSnapshotSchema>;

export const MainChatAdmissionQueueEntrySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  planId: z.string().nullable(),
  plannedTaskId: z.string().nullable(),
  mainAgentId: z.string(),
  conversationId: z.string().nullable(),
  title: z.string(),
  targetServerId: z.string(),
  hostLabel: z.string(),
  reasonCode: MainChatResourcePressureReasonSchema,
  reason: z.string(),
  suggestion: z.string().nullable(),
  position: z.number().int().positive(),
  enqueuedAt: z.string(),
  attempts: z.number().int().nonnegative(),
  lastEvaluatedAt: z.string(),
});
export type MainChatAdmissionQueueEntry = z.infer<typeof MainChatAdmissionQueueEntrySchema>;

export const MainChatTaskAdmissionStatusSchema = z.enum(["queued", "rejected", "dispatched"]);
export type MainChatTaskAdmissionStatus = z.infer<typeof MainChatTaskAdmissionStatusSchema>;

export const MainChatTaskAdmissionStateSchema = z.object({
  status: MainChatTaskAdmissionStatusSchema,
  queueId: z.string().nullable(),
  position: z.number().int().positive().nullable(),
  targetServerId: z.string().nullable(),
  hostLabel: z.string().nullable(),
  reasonCode: MainChatResourcePressureReasonSchema.nullable(),
  reason: z.string().nullable(),
  suggestion: z.string().nullable(),
  updatedAt: z.string(),
});
export type MainChatTaskAdmissionState = z.infer<typeof MainChatTaskAdmissionStateSchema>;

export const MainChatResourceAdmissionSummarySchema = z.object({
  enabled: z.boolean(),
  totalHosts: z.number().int().nonnegative(),
  healthyHosts: z.number().int().nonnegative(),
  pressuredHosts: z.number().int().nonnegative(),
  offlineHosts: z.number().int().nonnegative(),
  queuedCount: z.number().int().nonnegative(),
  totalActiveManagedAgents: z.number().int().nonnegative(),
});
export type MainChatResourceAdmissionSummary = z.infer<
  typeof MainChatResourceAdmissionSummarySchema
>;

export const MainChatResourceAdmissionSnapshotSchema = z.object({
  policy: MainChatResourceAdmissionPolicySchema,
  hosts: z.array(MainChatHostResourceSnapshotSchema),
  queue: z.array(MainChatAdmissionQueueEntrySchema),
  summary: MainChatResourceAdmissionSummarySchema,
  updatedAt: z.string(),
});
export type MainChatResourceAdmissionSnapshot = z.infer<
  typeof MainChatResourceAdmissionSnapshotSchema
>;

export const MainChatDrainAdmissionActionSchema = z.enum([
  "drain",
  "force_dispatch",
  "clear",
  "remove",
]);
export type MainChatDrainAdmissionAction = z.infer<typeof MainChatDrainAdmissionActionSchema>;

// ============================================================================
// P2-3 Stateless Background Supervision & On-Demand Tool Loading Schemas
// ============================================================================

export const MainChatToolGroupIdSchema = z.enum(MAIN_CHAT_TOOL_GROUP_IDS);
export type MainChatToolGroupId = z.infer<typeof MainChatToolGroupIdSchema>;

export const MainChatStatelessSupervisionDecisionSchema = z.enum([
  "silent",
  "log_only",
  "escalate_main",
]);
export type MainChatStatelessSupervisionDecision = z.infer<
  typeof MainChatStatelessSupervisionDecisionSchema
>;

// ============================================================================
// P2-4 Idle Subagent Auto-Archive & Prompt Library Schemas
// ============================================================================

export const MainChatIdleArchivePolicySchema = z.object({
  enabled: z.boolean(),
  idleThresholdMinutes: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_IDLE_ARCHIVE_THRESHOLD_MIN)
    .max(MAIN_CHAT_MAX_IDLE_ARCHIVE_THRESHOLD_MIN),
  sweepIntervalMinutes: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_IDLE_ARCHIVE_SWEEP_INTERVAL_MIN)
    .max(MAIN_CHAT_MAX_IDLE_ARCHIVE_SWEEP_INTERVAL_MIN),
  maxArchivePerSweep: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_IDLE_ARCHIVE_MAX_PER_SWEEP)
    .max(MAIN_CHAT_MAX_IDLE_ARCHIVE_MAX_PER_SWEEP),
});
export type MainChatIdleArchivePolicy = z.infer<typeof MainChatIdleArchivePolicySchema>;

export const MainChatIdleArchivePolicyPatchSchema = MainChatIdleArchivePolicySchema.partial();
export type MainChatIdleArchivePolicyPatch = z.infer<typeof MainChatIdleArchivePolicyPatchSchema>;

export const MainChatIdleArchiveRefusalCodeSchema = z.enum([
  "is_main_chat",
  "is_direction_leader",
  "is_manual_session",
  "already_archived",
  "is_running",
  "has_pending_permission",
  "has_open_decision",
  "has_unclosed_task",
  "has_active_pr_followup",
  "awaits_reply",
  "below_idle_threshold",
]);
export type MainChatIdleArchiveRefusalCode = z.infer<typeof MainChatIdleArchiveRefusalCodeSchema>;

export const MainChatIdleArchiveOutcomeSchema = z.enum([
  "archived",
  "eligible",
  "refused",
  "failed",
]);
export type MainChatIdleArchiveOutcome = z.infer<typeof MainChatIdleArchiveOutcomeSchema>;

export const MainChatIdleArchiveAuditRecordSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  serverId: z.string(),
  title: z.string(),
  taskId: z.string().nullable(),
  idleMinutes: z.number().nonnegative(),
  outcome: MainChatIdleArchiveOutcomeSchema,
  refusalCode: MainChatIdleArchiveRefusalCodeSchema.nullable(),
  reason: z.string(),
  sweptAt: z.string(),
  trigger: z.enum(["scheduled", "manual"]),
});
export type MainChatIdleArchiveAuditRecord = z.infer<typeof MainChatIdleArchiveAuditRecordSchema>;

export const MainChatIdleArchiveSweepResultSchema = z.object({
  dryRun: z.boolean(),
  evaluatedCount: z.number().int().nonnegative(),
  eligibleCount: z.number().int().nonnegative(),
  archivedCount: z.number().int().nonnegative(),
  refusedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  archived: z.array(MainChatIdleArchiveAuditRecordSchema),
  eligible: z.array(MainChatIdleArchiveAuditRecordSchema),
  refused: z.array(MainChatIdleArchiveAuditRecordSchema),
  auditLog: z.array(MainChatIdleArchiveAuditRecordSchema),
  sweptAt: z.string(),
});
export type MainChatIdleArchiveSweepResult = z.infer<typeof MainChatIdleArchiveSweepResultSchema>;

export const MainChatPromptTemplateCategorySchema = z.enum([
  "workflow",
  "review",
  "debug",
  "planning",
  "custom",
]);
export type MainChatPromptTemplateCategory = z.infer<typeof MainChatPromptTemplateCategorySchema>;

export const MainChatPromptTemplateSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1).max(MAIN_CHAT_PROMPT_SLUG_MAX_CHARS),
  title: z.string().min(1).max(MAIN_CHAT_PROMPT_TITLE_MAX_CHARS),
  description: z.string().max(MAIN_CHAT_PROMPT_DESC_MAX_CHARS),
  content: z.string().min(1).max(MAIN_CHAT_PROMPT_CONTENT_MAX_CHARS),
  argumentHint: z.string().max(80).nullable().optional(),
  builtin: z.boolean(),
  category: MainChatPromptTemplateCategorySchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MainChatPromptTemplate = z.infer<typeof MainChatPromptTemplateSchema>;

export const MainChatPromptTemplateInputSchema = z.object({
  id: z.string().min(1).optional(),
  slug: z.string().trim().min(1).max(MAIN_CHAT_PROMPT_SLUG_MAX_CHARS),
  title: z.string().trim().min(1).max(MAIN_CHAT_PROMPT_TITLE_MAX_CHARS),
  description: z.string().trim().max(MAIN_CHAT_PROMPT_DESC_MAX_CHARS).optional(),
  content: z.string().trim().min(1).max(MAIN_CHAT_PROMPT_CONTENT_MAX_CHARS),
  argumentHint: z.string().trim().max(80).nullable().optional(),
  category: MainChatPromptTemplateCategorySchema.optional(),
});
export type MainChatPromptTemplateInput = z.infer<typeof MainChatPromptTemplateInputSchema>;

export const MainChatSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  autoCompactEnabled: z.boolean().optional(),
  compaction: MainChatCompactionConfigSchema.optional(),
  cacheKeepalive: MainChatCacheKeepaliveConfigSchema.optional(),
  limitFallbacks: z
    .array(MainChatLimitFallbackEntrySchema)
    .max(MAIN_CHAT_MAX_LIMIT_FALLBACKS)
    .optional(),
  modelConfig: MainChatModelConfigSchema.optional(),
  notificationPolicy: MainChatNotificationPolicySchema.optional(),
  resourceAdmission: MainChatResourceAdmissionPolicySchema.optional(),
  statelessBackgroundSupervision: z.boolean().optional(),
  onDemandToolLoading: z.boolean().optional(),
  idleArchivePolicy: MainChatIdleArchivePolicySchema.optional(),
  mainBackgroundFolded: z.boolean().optional(),
  mainTasksQuiet: z.boolean().optional(),
  taskLessonsEnabled: z.boolean().optional(),
  deliveryGatePolicy: MainChatDeliveryGatePolicySchema.optional(),
  profile: MainChatProfileSchema.optional(),
  title: z.string().trim().min(1).max(40),
  style: MainChatStyleSchema,
  activePresetId: z.string().trim().min(1).max(64).optional(),
  customPresets: z
    .array(MainChatCustomStylePresetSchema)
    .max(MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS)
    .optional(),
  backgroundModel: MainChatBackgroundModelConfigSchema,
  intervals: MainChatIntervalsSchema,
  capabilities: MainChatCapabilitiesSchema,
  nightMode: MainChatNightModeConfigSchema.optional(),
  fleetScope: MainChatFleetScopeSchema.optional(),
});
export type MainChatSettings = z.infer<typeof MainChatSettingsSchema>;

export const MainChatSettingsPatchSchema = z.object({
  applyPreset: MainChatStyleSchema.optional(),
  applyPresetId: z.string().trim().min(1).max(64).optional(),
  upsertCustomPreset: MainChatCustomStylePresetSchema.optional(),
  deleteCustomPresetId: z.string().trim().min(1).max(64).optional(),
  customPresets: z
    .array(MainChatCustomStylePresetSchema)
    .max(MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS)
    .optional(),
  resetStyleToDefault: z.boolean().optional(),
  enabled: z.boolean().optional(),
  autoCompactEnabled: z.boolean().optional(),
  compaction: MainChatCompactionConfigPatchSchema.optional(),
  cacheKeepalive: MainChatCacheKeepaliveConfigPatchSchema.optional(),
  limitFallbacks: z
    .array(MainChatLimitFallbackEntrySchema)
    .max(MAIN_CHAT_MAX_LIMIT_FALLBACKS)
    .optional(),
  modelConfig: MainChatModelConfigPatchSchema.optional(),
  notificationPolicy: MainChatNotificationPolicyPatchSchema.optional(),
  resourceAdmission: MainChatResourceAdmissionPolicyPatchSchema.optional(),
  statelessBackgroundSupervision: z.boolean().optional(),
  onDemandToolLoading: z.boolean().optional(),
  idleArchivePolicy: MainChatIdleArchivePolicyPatchSchema.optional(),
  mainBackgroundFolded: z.boolean().optional(),
  mainTasksQuiet: z.boolean().optional(),
  taskLessonsEnabled: z.boolean().optional(),
  deliveryGatePolicy: MainChatDeliveryGatePolicySchema.optional(),
  profile: MainChatProfilePatchSchema.optional(),
  title: z.string().trim().min(1).max(40).optional(),
  style: MainChatStyleSchema.optional(),
  backgroundModel: MainChatBackgroundModelConfigSchema.partial().optional(),
  intervals: MainChatIntervalsSchema.partial().optional(),
  capabilities: MainChatCapabilitiesSchema.partial().optional(),
  nightMode: MainChatNightModeConfigSchema.partial().optional(),
  fleetScope: MainChatFleetScopePatchSchema.optional(),
});
export type MainChatSettingsPatch = z.infer<typeof MainChatSettingsPatchSchema>;

export const MainChatSettingsProposalStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type MainChatSettingsProposalStatus = z.infer<typeof MainChatSettingsProposalStatusSchema>;

export const MainChatSettingsProposalChangeSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  beforeDisplay: z.string(),
  afterDisplay: z.string(),
});
export type MainChatSettingsProposalChange = z.infer<typeof MainChatSettingsProposalChangeSchema>;

export const MainChatSettingsProposalRecordSchema = z.object({
  id: z.string(),
  mainAgentId: z.string(),
  title: z.string(),
  reason: z.string(),
  patch: MainChatSettingsPatchSchema,
  changes: z.array(MainChatSettingsProposalChangeSchema).min(1),
  status: MainChatSettingsProposalStatusSchema,
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedNote: z.string().nullable().optional(),
  appliedError: z.string().nullable().optional(),
});
export type MainChatSettingsProposalRecord = z.infer<typeof MainChatSettingsProposalRecordSchema>;

export const MainChatRoutineKindSchema = z.enum(["recurring", "one_shot"]);
export type MainChatRoutineKind = z.infer<typeof MainChatRoutineKindSchema>;

export const MainChatRoutineOwnerKindSchema = z.enum(["main", "leader"]);
export type MainChatRoutineOwnerKind = z.infer<typeof MainChatRoutineOwnerKindSchema>;

export const MainChatRoutineRecordSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  prompt: z.string().min(1),
  kind: MainChatRoutineKindSchema,
  cadence: ScheduleCadenceSchema,
  status: ScheduleStatusSchema,
  ownerKind: MainChatRoutineOwnerKindSchema,
  conversationId: z.string(),
  conversationTitle: z.string(),
  targetAgentId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  pausedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  maxRuns: z.number().int().positive().nullable(),
  runCount: z.number().int().nonnegative(),
  lastRunStatus: z.enum(["running", "succeeded", "failed"]).nullable(),
  lastRunOutput: z.string().nullable(),
  lastRunError: z.string().nullable(),
});
export type MainChatRoutineRecord = z.infer<typeof MainChatRoutineRecordSchema>;

export const MainChatSessionPhaseSchema = z.enum([
  "working",
  "done",
  "blocked_user",
  "blocked_external",
  "interrupted",
  "stalled",
  "no_progress",
  "unsure",
]);
export type MainChatSessionPhase = z.infer<typeof MainChatSessionPhaseSchema>;

export const MainChatSessionTriageSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  title: z.string(),
  managedByMainChat: z.boolean(),
  phase: MainChatSessionPhaseSchema,
  summary: z.string(),
  waitReason: z.string().nullable(),
  suggestedAction: z.string().nullable(),
  triageSource: z.enum(["rule", "model"]),
  updatedAt: z.string(),
  ruleDiagnostic: MainChatRuleDiagnosticSchema.nullable().optional(),
  ruleDiagnostics: z.array(MainChatRuleDiagnosticSchema).optional(),
});
export type MainChatSessionTriage = z.infer<typeof MainChatSessionTriageSchema>;

export const MainChatPatrolResultSchema = z.object({
  scannedSessions: z.number().int().nonnegative(),
  signalsFound: z.number().int().nonnegative(),
  wokeMainChat: z.boolean(),
  summary: z.string(),
  patrolledAt: z.string(),
});
export type MainChatPatrolResult = z.infer<typeof MainChatPatrolResultSchema>;

export interface MainChatStylePreset {
  style: MainChatStyle;
  intervals: MainChatIntervals;
  capabilities: MainChatCapabilities;
  backgroundModel: MainChatBackgroundModelConfig;
}

export const MAIN_CHAT_STYLE_PRESETS: Record<MainChatStyle, MainChatStylePreset> = {
  conservative: {
    style: "conservative",
    intervals: {
      patrolIntervalSec: 60,
      triageSettleSec: 20,
      stalledThresholdMin: 15,
      noProgressThresholdMin: 10,
      needsYouEscalateMin: 5,
      wakeupCooldownMin: 10,
    },
    capabilities: {
      semanticTriageEnabled: true,
      proactiveWakeupEnabled: true,
      initialBriefingEnabled: true,
      autoContinueManualErrors: true,
      autoDelegateManualQuestions: false,
      autoNudgeManualStalled: false,
    },
    backgroundModel: {
      mode: "auto",
      provider: null,
      model: null,
      thinkingOptionId: null,
    },
  },
  proactive: {
    style: "proactive",
    intervals: {
      patrolIntervalSec: 30,
      triageSettleSec: 15,
      stalledThresholdMin: 10,
      noProgressThresholdMin: 6,
      needsYouEscalateMin: 3,
      wakeupCooldownMin: 3,
    },
    capabilities: {
      semanticTriageEnabled: true,
      proactiveWakeupEnabled: true,
      initialBriefingEnabled: true,
      autoContinueManualErrors: true,
      autoDelegateManualQuestions: true,
      autoNudgeManualStalled: true,
    },
    backgroundModel: {
      mode: "auto",
      provider: null,
      model: null,
      thinkingOptionId: null,
    },
  },
};

export function getMainChatStylePreset(style: MainChatStyle): MainChatStylePreset {
  const preset = MAIN_CHAT_STYLE_PRESETS[style];
  return {
    style: preset.style,
    intervals: { ...preset.intervals },
    capabilities: { ...preset.capabilities },
    backgroundModel: { ...preset.backgroundModel },
  };
}

export function createDefaultMainChatNightMode(): MainChatNightModeConfig {
  return {
    enabled: false,
    startHour: 23,
    endHour: 8,
    behavior: "throttle",
    patrolIntervalSec: 600,
    autoHibernateAfterIdleMin: 30,
    disableSemanticTriage: true,
    deferProactiveWakeups: true,
    allowUrgentWakeups: false,
  };
}

export function isMainChatEnabled(
  settings: Pick<MainChatSettings, "enabled"> | null | undefined,
): boolean {
  if (!settings) return false;
  return settings.enabled !== false;
}

export function isMainChatAutoCompactEnabled(
  settings: Pick<MainChatSettings, "autoCompactEnabled"> | null | undefined,
): boolean {
  return settings?.autoCompactEnabled !== false;
}

export function isMainChatBackgroundFolded(
  settings: Pick<MainChatSettings, "mainBackgroundFolded"> | null | undefined,
): boolean {
  return settings?.mainBackgroundFolded !== false;
}

export function isMainChatTasksQuiet(
  settings: Pick<MainChatSettings, "mainTasksQuiet"> | null | undefined,
): boolean {
  return settings?.mainTasksQuiet !== false;
}

export function isMainChatTaskLessonsEnabled(
  settings: Pick<MainChatSettings, "taskLessonsEnabled"> | null | undefined,
): boolean {
  return settings?.taskLessonsEnabled !== false;
}

export function resolveMainChatDeliveryGatePolicy(
  settings: Pick<MainChatSettings, "deliveryGatePolicy"> | null | undefined,
): MainChatDeliveryGatePolicy {
  return settings?.deliveryGatePolicy ?? "merged";
}

export function createDefaultMainChatProfile(): MainChatProfile {
  return {
    aboutMe: "",
    ownerAliases: [],
    updatedAt: null,
  };
}

export function normalizeMainChatProfile(
  profile: Partial<MainChatProfile> | null | undefined,
): MainChatProfile {
  const rawAboutMe = typeof profile?.aboutMe === "string" ? profile.aboutMe : "";
  const aboutMe =
    rawAboutMe.length > MAIN_CHAT_ABOUT_ME_MAX_CHARS
      ? rawAboutMe.slice(0, MAIN_CHAT_ABOUT_ME_MAX_CHARS)
      : rawAboutMe;
  const seen = new Set<string>();
  const ownerAliases: string[] = [];
  for (const rawAlias of profile?.ownerAliases ?? []) {
    if (typeof rawAlias !== "string") continue;
    const trimmed = rawAlias.trim().slice(0, MAIN_CHAT_OWNER_ALIAS_MAX_CHARS);
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    ownerAliases.push(trimmed);
    if (ownerAliases.length >= MAIN_CHAT_OWNER_ALIASES_MAX_COUNT) break;
  }
  const updatedAt =
    typeof profile?.updatedAt === "string" && profile.updatedAt.trim().length > 0
      ? profile.updatedAt.trim()
      : null;
  return {
    aboutMe,
    ownerAliases,
    updatedAt,
  };
}

export function resolveMainChatProfile(
  settings: Pick<MainChatSettings, "profile"> | null | undefined,
): MainChatProfile {
  return normalizeMainChatProfile(settings?.profile);
}

export function resolveMainChatNightMode(
  settings: Pick<MainChatSettings, "nightMode"> | null | undefined,
): MainChatNightModeConfig {
  return {
    ...createDefaultMainChatNightMode(),
    ...settings?.nightMode,
  };
}

export function createEmptyMainChatTokenUsageCounters(): MainChatTokenUsageCounters {
  return {
    turns: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };
}

export function createEmptyMainChatTokenUsageBySource(): MainChatTokenUsageBySource {
  return {
    foreground: createEmptyMainChatTokenUsageCounters(),
    background: createEmptyMainChatTokenUsageCounters(),
    direction: createEmptyMainChatTokenUsageCounters(),
    triage: createEmptyMainChatTokenUsageCounters(),
  };
}

export function createEmptyMainChatTokenUsageSummary(): MainChatTokenUsageSummary {
  return {
    today: createEmptyMainChatTokenUsageCounters(),
    last7Days: createEmptyMainChatTokenUsageCounters(),
    allTime: createEmptyMainChatTokenUsageCounters(),
    bySource: createEmptyMainChatTokenUsageBySource(),
    byModel: [],
    daily: [],
    updatedAt: null,
  };
}

export interface MainChatResolvedStylePreset {
  id: string;
  kind: "builtin" | "custom";
  name?: string;
  description?: string;
  baseStyle: MainChatStyle;
  customGuidance?: string;
  intervals: MainChatIntervals;
  capabilities: MainChatCapabilities;
  updatedAt?: string;
}

export function isBuiltInMainChatStylePresetId(id: string): id is MainChatStyle {
  return id === "conservative" || id === "proactive";
}

function normalizeCustomStylePreset(preset: MainChatCustomStylePreset): MainChatCustomStylePreset {
  const description = preset.description?.trim();
  const customGuidance = preset.customGuidance?.trim();
  const updatedAt = preset.updatedAt?.trim();
  return {
    id: preset.id.trim(),
    name: preset.name.trim(),
    ...(description ? { description } : {}),
    baseStyle: preset.baseStyle,
    ...(customGuidance ? { customGuidance } : {}),
    intervals: { ...preset.intervals },
    capabilities: { ...preset.capabilities },
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function sanitizeCustomStylePresets(
  raw: readonly MainChatCustomStylePreset[] | null | undefined,
): MainChatCustomStylePreset[] {
  if (!raw || raw.length === 0) return [];
  const seen = new Set<string>();
  const result: MainChatCustomStylePreset[] = [];
  for (const entry of raw) {
    const normalized = normalizeCustomStylePreset(entry);
    if (!normalized.id || !normalized.name) continue;
    if (isBuiltInMainChatStylePresetId(normalized.id)) continue;
    if (seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    result.push(normalized);
    if (result.length >= MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS) break;
  }
  return result;
}

export function resolveMainChatCustomPresets(
  settings: Pick<MainChatSettings, "customPresets"> | null | undefined,
): MainChatCustomStylePreset[] {
  return sanitizeCustomStylePresets(settings?.customPresets);
}

export function resolveActiveMainChatStylePresetId(
  settings: Pick<MainChatSettings, "style" | "activePresetId" | "customPresets"> | null | undefined,
): string {
  const fallbackStyle = settings?.style ?? "conservative";
  const candidate = settings?.activePresetId?.trim();
  if (!candidate) return fallbackStyle;
  if (isBuiltInMainChatStylePresetId(candidate)) return candidate;
  const customPresets = resolveMainChatCustomPresets(settings);
  if (customPresets.some((preset) => preset.id === candidate)) {
    return candidate;
  }
  return fallbackStyle;
}

export function resolveActiveMainChatStylePreset(
  settings: Pick<MainChatSettings, "style" | "activePresetId" | "customPresets"> | null | undefined,
): MainChatResolvedStylePreset {
  const activeId = resolveActiveMainChatStylePresetId(settings);
  if (isBuiltInMainChatStylePresetId(activeId)) {
    const builtin = getMainChatStylePreset(activeId);
    return {
      id: activeId,
      kind: "builtin",
      baseStyle: builtin.style,
      intervals: builtin.intervals,
      capabilities: builtin.capabilities,
    };
  }
  const custom = resolveMainChatCustomPresets(settings).find((entry) => entry.id === activeId);
  if (custom) {
    return {
      id: custom.id,
      kind: "custom",
      name: custom.name,
      description: custom.description,
      baseStyle: custom.baseStyle,
      customGuidance: custom.customGuidance,
      intervals: { ...custom.intervals },
      capabilities: { ...custom.capabilities },
      updatedAt: custom.updatedAt,
    };
  }
  const fallbackStyle = settings?.style ?? "conservative";
  const builtin = getMainChatStylePreset(fallbackStyle);
  return {
    id: fallbackStyle,
    kind: "builtin",
    baseStyle: builtin.style,
    intervals: builtin.intervals,
    capabilities: builtin.capabilities,
  };
}

function intervalsEqual(left: MainChatIntervals, right: MainChatIntervals): boolean {
  return (
    left.patrolIntervalSec === right.patrolIntervalSec &&
    left.triageSettleSec === right.triageSettleSec &&
    left.stalledThresholdMin === right.stalledThresholdMin &&
    left.noProgressThresholdMin === right.noProgressThresholdMin &&
    left.needsYouEscalateMin === right.needsYouEscalateMin &&
    left.wakeupCooldownMin === right.wakeupCooldownMin
  );
}

function capabilitiesEqual(left: MainChatCapabilities, right: MainChatCapabilities): boolean {
  return (
    left.semanticTriageEnabled === right.semanticTriageEnabled &&
    left.proactiveWakeupEnabled === right.proactiveWakeupEnabled &&
    left.initialBriefingEnabled === right.initialBriefingEnabled &&
    left.autoContinueManualErrors === right.autoContinueManualErrors &&
    left.autoDelegateManualQuestions === right.autoDelegateManualQuestions &&
    left.autoNudgeManualStalled === right.autoNudgeManualStalled
  );
}

export function isMainChatStyleModified(
  settings:
    | Pick<
        MainChatSettings,
        "style" | "activePresetId" | "customPresets" | "intervals" | "capabilities"
      >
    | null
    | undefined,
): boolean {
  if (!settings) return false;
  const preset = resolveActiveMainChatStylePreset(settings);
  return (
    settings.style !== preset.baseStyle ||
    !intervalsEqual(settings.intervals, preset.intervals) ||
    !capabilitiesEqual(settings.capabilities, preset.capabilities)
  );
}

export function isMainChatStyleFactoryDefault(
  settings:
    | Pick<
        MainChatSettings,
        "style" | "activePresetId" | "customPresets" | "intervals" | "capabilities"
      >
    | null
    | undefined,
): boolean {
  if (!settings) return true;
  const activeId = resolveActiveMainChatStylePresetId(settings);
  if (activeId !== "conservative" || settings.style !== "conservative") return false;
  const factory = MAIN_CHAT_STYLE_PRESETS.conservative;
  return (
    intervalsEqual(settings.intervals, factory.intervals) &&
    capabilitiesEqual(settings.capabilities, factory.capabilities)
  );
}

export function createMainChatCustomPresetId(
  name: string,
  existingIds: readonly string[] = [],
): string {
  const taken = new Set(existingIds);
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const prefix = slug ? `custom-${slug}` : "custom-style";
  if (!taken.has(prefix) && !isBuiltInMainChatStylePresetId(prefix)) {
    return prefix;
  }
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${prefix}-${suffix}`.slice(0, 64);
    if (!taken.has(candidate) && !isBuiltInMainChatStylePresetId(candidate)) {
      return candidate;
    }
  }
  return `custom-${Date.now().toString(36)}`;
}

export function createDefaultMainChatFleetScope(): MainChatFleetScope {
  return {
    mode: "local_only",
    hostServerIds: [],
  };
}

export function normalizeMainChatFleetScope(
  scope: Partial<MainChatFleetScope> | null | undefined,
  localServerId?: string | null,
): MainChatFleetScope {
  const mode: MainChatFleetScopeMode =
    scope?.mode === "local_only" || scope?.mode === "allowlist" || scope?.mode === "all_connected"
      ? scope.mode
      : "local_only";
  const normalizedLocalId = localServerId?.trim() || null;
  const seen = new Set<string>();
  const hostServerIds: string[] = [];
  for (const rawId of scope?.hostServerIds ?? []) {
    const trimmed = rawId.trim();
    if (!trimmed) continue;
    if (normalizedLocalId && trimmed === normalizedLocalId) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    hostServerIds.push(trimmed);
    if (hostServerIds.length >= MAIN_CHAT_MAX_FLEET_SCOPE_HOSTS) break;
  }
  return {
    mode,
    hostServerIds,
  };
}

export function resolveMainChatFleetScope(
  settings: Pick<MainChatSettings, "fleetScope"> | null | undefined,
  localServerId?: string | null,
): MainChatFleetScope {
  return normalizeMainChatFleetScope(settings?.fleetScope, localServerId);
}

export function isHostAllowedInFleetScope(
  scope: MainChatFleetScope | null | undefined,
  localServerId: string | null | undefined,
  targetServerId: string | null | undefined,
): boolean {
  const normalizedTarget = targetServerId?.trim() || null;
  if (!normalizedTarget) return false;
  const normalizedLocal = localServerId?.trim() || null;
  if (normalizedLocal && normalizedTarget === normalizedLocal) {
    return true;
  }
  const resolved = normalizeMainChatFleetScope(scope, normalizedLocal);
  switch (resolved.mode) {
    case "local_only":
      return false;
    case "allowlist":
      return resolved.hostServerIds.includes(normalizedTarget);
    case "all_connected":
      return true;
  }
}

export function createDefaultMainChatCompactionConfig(): MainChatCompactionConfig {
  return {
    windowCapTokens: MAIN_CHAT_DEFAULT_COMPACT_WINDOW_CAP_TOKENS,
    idlePrecompactMinIdleMin: MAIN_CHAT_DEFAULT_IDLE_PRECOMPACT_MINUTES,
  };
}

export function resolveMainChatCompactionConfig(
  settings: Pick<MainChatSettings, "compaction"> | null | undefined,
): MainChatCompactionConfig {
  const defaults = createDefaultMainChatCompactionConfig();
  const raw = settings?.compaction;
  if (!raw) return defaults;
  let windowCapTokens: number | null = defaults.windowCapTokens;
  if (raw.windowCapTokens === null) {
    windowCapTokens = null;
  } else if (
    typeof raw.windowCapTokens === "number" &&
    Number.isFinite(raw.windowCapTokens) &&
    raw.windowCapTokens >= MAIN_CHAT_MIN_COMPACT_WINDOW_CAP_TOKENS &&
    raw.windowCapTokens <= MAIN_CHAT_MAX_COMPACT_WINDOW_CAP_TOKENS
  ) {
    windowCapTokens = Math.round(raw.windowCapTokens);
  }
  const idlePrecompactMinIdleMin =
    typeof raw.idlePrecompactMinIdleMin === "number" &&
    Number.isFinite(raw.idlePrecompactMinIdleMin) &&
    raw.idlePrecompactMinIdleMin >= MAIN_CHAT_MIN_IDLE_PRECOMPACT_MINUTES &&
    raw.idlePrecompactMinIdleMin <= MAIN_CHAT_MAX_IDLE_PRECOMPACT_MINUTES
      ? Math.round(raw.idlePrecompactMinIdleMin)
      : defaults.idlePrecompactMinIdleMin;
  return { windowCapTokens, idlePrecompactMinIdleMin };
}

/**
 * Computes the effective compaction window given the model's native window and optional cap.
 * When `windowCapTokens` is null, the cap is disabled and the full model window applies.
 */
export function computeEffectiveCompactionWindowTokens(
  modelWindowMaxTokens: number | null | undefined,
  windowCapTokens: number | null | undefined,
): number | null {
  const modelMax =
    typeof modelWindowMaxTokens === "number" &&
    Number.isFinite(modelWindowMaxTokens) &&
    modelWindowMaxTokens > 0
      ? Math.round(modelWindowMaxTokens)
      : null;
  const cap =
    typeof windowCapTokens === "number" && Number.isFinite(windowCapTokens) && windowCapTokens > 0
      ? Math.round(windowCapTokens)
      : null;
  if (modelMax !== null && cap !== null) {
    return Math.min(modelMax, cap);
  }
  if (modelMax !== null) return modelMax;
  if (cap !== null) return cap;
  return null;
}

export function createDefaultMainChatCacheKeepaliveConfig(): MainChatCacheKeepaliveConfig {
  return {
    enabled: true,
    intervalMinutes: MAIN_CHAT_DEFAULT_CACHE_KEEPALIVE_INTERVAL_MIN,
    maxRequests: MAIN_CHAT_DEFAULT_CACHE_KEEPALIVE_MAX_REQUESTS,
  };
}

export function resolveMainChatCacheKeepaliveConfig(
  settings: Pick<MainChatSettings, "cacheKeepalive"> | null | undefined,
): MainChatCacheKeepaliveConfig {
  const defaults = createDefaultMainChatCacheKeepaliveConfig();
  const raw = settings?.cacheKeepalive;
  if (!raw) return defaults;
  const intervalMinutes =
    typeof raw.intervalMinutes === "number" &&
    Number.isFinite(raw.intervalMinutes) &&
    raw.intervalMinutes >= MAIN_CHAT_MIN_CACHE_KEEPALIVE_INTERVAL_MIN &&
    raw.intervalMinutes <= MAIN_CHAT_MAX_CACHE_KEEPALIVE_INTERVAL_MIN
      ? Math.round(raw.intervalMinutes)
      : defaults.intervalMinutes;
  const maxRequests =
    typeof raw.maxRequests === "number" &&
    Number.isFinite(raw.maxRequests) &&
    raw.maxRequests >= MAIN_CHAT_MIN_CACHE_KEEPALIVE_MAX_REQUESTS &&
    raw.maxRequests <= MAIN_CHAT_MAX_CACHE_KEEPALIVE_MAX_REQUESTS
      ? Math.round(raw.maxRequests)
      : defaults.maxRequests;
  return {
    enabled: raw.enabled !== false,
    intervalMinutes,
    maxRequests,
  };
}

export function formatMainChatModelSpec(provider: string, model?: string | null): string {
  const trimmedProvider = provider.trim();
  const trimmedModel = model?.trim();
  return trimmedModel ? `${trimmedProvider}/${trimmedModel}` : trimmedProvider;
}

export function normalizeMainChatLimitFallbacks(
  entries: ReadonlyArray<Partial<MainChatLimitFallbackEntry>> | null | undefined,
): MainChatLimitFallbackEntry[] {
  const seen = new Set<string>();
  const normalized: MainChatLimitFallbackEntry[] = [];
  for (const raw of entries ?? []) {
    const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
    if (!provider) continue;
    const model =
      typeof raw.model === "string" && raw.model.trim().length > 0 ? raw.model.trim() : null;
    const label =
      typeof raw.label === "string" && raw.label.trim().length > 0
        ? raw.label.trim().slice(0, 80)
        : null;
    const dedupeKey = `${provider.toLowerCase()}::${(model ?? "").toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({
      provider,
      ...(model !== null ? { model } : { model: null }),
      ...(label !== null ? { label } : {}),
    });
    if (normalized.length >= MAIN_CHAT_MAX_LIMIT_FALLBACKS) break;
  }
  return normalized;
}

export function resolveMainChatLimitFallbacks(
  settings: Pick<MainChatSettings, "limitFallbacks"> | null | undefined,
): MainChatLimitFallbackEntry[] {
  return normalizeMainChatLimitFallbacks(settings?.limitFallbacks);
}

export function createDefaultMainChatModelConfig(): MainChatModelConfig {
  return {
    activeProfileId: "balanced",
    slots: {},
    customProfiles: [],
    rollbackSnapshot: null,
    switchHistory: [],
  };
}

export function isBuiltinMainChatModelProfileId(
  value: string | null | undefined,
): value is MainChatBuiltinModelProfileId {
  return value === "performance" || value === "balanced" || value === "economy";
}

function normalizeModelSlotBinding(
  binding: MainChatModelSlotBinding | null | undefined,
): MainChatModelSlotBinding | null {
  if (!binding) return null;
  const provider = binding.provider?.trim();
  if (!provider) return null;
  const model = binding.model?.trim() || null;
  const thinkingOptionId = binding.thinkingOptionId?.trim() || null;
  const label = binding.label?.trim() || null;
  return {
    provider,
    model,
    thinkingOptionId,
    ...(label ? { label } : {}),
  };
}

export function normalizeMainChatModelSlots(
  slots: MainChatModelSlots | null | undefined,
): MainChatModelSlots {
  if (!slots) return {};
  const result: MainChatModelSlots = {};
  for (const purpose of MAIN_CHAT_MODEL_PURPOSES) {
    if (Object.prototype.hasOwnProperty.call(slots, purpose)) {
      const normalized = normalizeModelSlotBinding(slots[purpose]);
      if (normalized) {
        result[purpose] = normalized;
      }
    }
  }
  return result;
}

function resolveBuiltinModelTierNames(
  provider: string,
  fallbackModel: string | null,
): { strongModel: string | null; midModel: string | null; fastModel: string | null } {
  if (provider === "claude") {
    return {
      strongModel: "claude-opus-4-6",
      midModel: "claude-sonnet-4-6",
      fastModel: "claude-haiku-4-5",
    };
  }
  if (provider === "codex") {
    return {
      strongModel: "gpt-5.3-codex",
      midModel: "gpt-5.3-codex",
      fastModel: "gpt-5.1-codex-mini",
    };
  }
  return { strongModel: fallbackModel, midModel: fallbackModel, fastModel: fallbackModel };
}

export function resolveBuiltinMainChatModelProfiles(
  baseBinding?: Pick<MainChatModelSlotBinding, "provider" | "model" | "thinkingOptionId"> | null,
): MainChatModelProfile[] {
  const provider = baseBinding?.provider?.trim() || "claude";
  const fallbackModel = baseBinding?.model?.trim() || null;
  const { strongModel, midModel, fastModel } = resolveBuiltinModelTierNames(
    provider,
    fallbackModel,
  );

  return [
    {
      id: "performance",
      name: "性能优先",
      description: "主对话、方向主管与默认子任务全部优先高推理模型，后台分诊使用轻量模型。",
      builtin: true,
      slots: {
        main: { provider, model: strongModel, thinkingOptionId: "high" },
        directionLead: { provider, model: strongModel, thinkingOptionId: "high" },
        subagentDefault: { provider, model: strongModel, thinkingOptionId: "medium" },
        subagentReadonly: { provider, model: midModel, thinkingOptionId: "low" },
        backgroundTriage: { provider, model: fastModel, thinkingOptionId: "off" },
      },
    },
    {
      id: "balanced",
      name: "均衡推荐",
      description: "主对话与方向主管用强模型把关，默认子任务用均衡模型，只读与分诊走轻量模型。",
      builtin: true,
      slots: {
        main: { provider, model: strongModel, thinkingOptionId: "medium" },
        directionLead: { provider, model: midModel, thinkingOptionId: "medium" },
        subagentDefault: { provider, model: midModel, thinkingOptionId: "low" },
        subagentReadonly: { provider, model: fastModel, thinkingOptionId: "off" },
        backgroundTriage: { provider, model: fastModel, thinkingOptionId: "off" },
      },
    },
    {
      id: "economy",
      name: "经济省额",
      description: "全槽位优先经济快速模型并降低思考强度，适合额度紧张或大批量常规任务。",
      builtin: true,
      slots: {
        main: { provider, model: midModel, thinkingOptionId: "low" },
        directionLead: { provider, model: midModel, thinkingOptionId: "off" },
        subagentDefault: { provider, model: fastModel, thinkingOptionId: "off" },
        subagentReadonly: { provider, model: fastModel, thinkingOptionId: "off" },
        backgroundTriage: { provider, model: fastModel, thinkingOptionId: "off" },
      },
    },
  ];
}

function normalizeCustomModelProfile(
  profile: MainChatModelProfile,
  fallbackUpdatedAt?: string,
): MainChatModelProfile {
  return {
    id: profile.id.trim(),
    name: profile.name.trim(),
    description: profile.description,
    builtin: false,
    slots: normalizeMainChatModelSlots(profile.slots),
    updatedAt: profile.updatedAt ?? fallbackUpdatedAt,
  };
}

export function resolveMainChatModelConfig(
  settings: Pick<MainChatSettings, "modelConfig"> | null | undefined,
): MainChatModelConfig {
  const raw = settings?.modelConfig;
  if (!raw) return createDefaultMainChatModelConfig();
  return {
    activeProfileId: raw.activeProfileId?.trim() || null,
    slots: normalizeMainChatModelSlots(raw.slots),
    customProfiles: (raw.customProfiles ?? [])
      .slice(0, MAIN_CHAT_MAX_CUSTOM_MODEL_PROFILES)
      .map((profile) => normalizeCustomModelProfile(profile)),
    rollbackSnapshot: raw.rollbackSnapshot
      ? {
          profileId: raw.rollbackSnapshot.profileId ?? null,
          slots: normalizeMainChatModelSlots(raw.rollbackSnapshot.slots),
          savedAt: raw.rollbackSnapshot.savedAt,
        }
      : null,
    switchHistory: (raw.switchHistory ?? []).slice(0, MAIN_CHAT_MAX_MODEL_PROFILE_HISTORY),
  };
}

export interface ResolvedMainChatModelSlot {
  purpose: MainChatModelPurpose;
  binding: MainChatModelSlotBinding | null;
  source: "explicit" | "inherited" | "background_model" | "live_main" | "auto";
  inheritedFrom: MainChatModelPurpose | "background_model" | "live_main" | null;
}

const SLOT_INHERITANCE_CHAIN: Record<MainChatModelPurpose, readonly MainChatModelPurpose[]> = {
  main: [],
  directionLead: ["main"],
  subagentDefault: ["main"],
  subagentReadonly: ["subagentDefault", "main"],
  backgroundTriage: ["subagentReadonly", "main"],
};

function resolveBackgroundTriageFallbackSlot(
  settings: Pick<MainChatSettings, "backgroundModel"> | null | undefined,
): ResolvedMainChatModelSlot | null {
  const bg = settings?.backgroundModel;
  if (bg?.mode === "custom" && bg.provider?.trim()) {
    return {
      purpose: "backgroundTriage",
      binding: {
        provider: bg.provider.trim(),
        model: bg.model?.trim() || null,
        thinkingOptionId: bg.thinkingOptionId?.trim() || null,
      },
      source: "background_model",
      inheritedFrom: "background_model",
    };
  }
  if (bg?.mode === "auto") {
    return {
      purpose: "backgroundTriage",
      binding: null,
      source: "auto",
      inheritedFrom: null,
    };
  }
  return null;
}

function normalizeLiveMainBinding(
  liveMainBinding:
    | Pick<MainChatModelSlotBinding, "provider" | "model" | "thinkingOptionId">
    | null
    | undefined,
): MainChatModelSlotBinding | null {
  if (!liveMainBinding?.provider?.trim()) return null;
  return normalizeModelSlotBinding({
    provider: liveMainBinding.provider,
    model: liveMainBinding.model ?? null,
    thinkingOptionId: liveMainBinding.thinkingOptionId ?? null,
  });
}

export function resolveMainChatModelSlot(input: {
  purpose: MainChatModelPurpose;
  settings: Pick<MainChatSettings, "modelConfig" | "backgroundModel"> | null | undefined;
  liveMainBinding?: Pick<
    MainChatModelSlotBinding,
    "provider" | "model" | "thinkingOptionId"
  > | null;
}): ResolvedMainChatModelSlot {
  const config = resolveMainChatModelConfig(input.settings);
  const slots = config.slots ?? {};
  const explicit = normalizeModelSlotBinding(slots[input.purpose]);
  if (explicit) {
    return { purpose: input.purpose, binding: explicit, source: "explicit", inheritedFrom: null };
  }

  if (input.purpose === "backgroundTriage") {
    const bgOverride = resolveBackgroundTriageFallbackSlot(input.settings);
    if (bgOverride) return bgOverride;
  }

  for (const parent of SLOT_INHERITANCE_CHAIN[input.purpose]) {
    const inherited = normalizeModelSlotBinding(slots[parent]);
    if (inherited) {
      return {
        purpose: input.purpose,
        binding: inherited,
        source: "inherited",
        inheritedFrom: parent,
      };
    }
  }

  const liveMain = normalizeLiveMainBinding(input.liveMainBinding);
  if (liveMain) {
    return {
      purpose: input.purpose,
      binding: liveMain,
      source: "live_main",
      inheritedFrom: "live_main",
    };
  }

  return { purpose: input.purpose, binding: null, source: "auto", inheritedFrom: null };
}

export function isCriticalPassthroughNotificationCategory(
  category: MainChatNotificationCategory,
): boolean {
  return (MAIN_CHAT_CRITICAL_PASSTHROUGH_CATEGORIES as readonly string[]).includes(category);
}

export function createDefaultMainChatNotificationPolicy(): MainChatNotificationPolicy {
  return {
    lowDistractionEnabled: false,
    mode: "balanced",
    foldLowPriorityToDigest: false,
    categoryOverrides: {},
  };
}

export function normalizeMainChatNotificationPolicy(
  policy: Partial<MainChatNotificationPolicy> | null | undefined,
): MainChatNotificationPolicy {
  const defaults = createDefaultMainChatNotificationPolicy();
  const mode = policy?.mode ?? (policy?.lowDistractionEnabled ? "low_distraction" : defaults.mode);
  const lowDistractionEnabled =
    policy?.lowDistractionEnabled !== undefined
      ? Boolean(policy.lowDistractionEnabled)
      : mode === "low_distraction";
  const foldLowPriorityToDigest =
    policy?.foldLowPriorityToDigest !== undefined
      ? Boolean(policy.foldLowPriorityToDigest)
      : lowDistractionEnabled;

  const overrides: Record<string, MainChatNotificationTier> = {};
  if (policy?.categoryOverrides) {
    for (const [key, value] of Object.entries(policy.categoryOverrides)) {
      if (
        (MAIN_CHAT_NOTIFICATION_CATEGORIES as readonly string[]).includes(key) &&
        (MAIN_CHAT_NOTIFICATION_TIERS as readonly string[]).includes(value)
      ) {
        // Critical passthrough categories can never be downgraded below critical.
        if (isCriticalPassthroughNotificationCategory(key as MainChatNotificationCategory)) {
          overrides[key] = "critical";
        } else {
          overrides[key] = value;
        }
      }
    }
  }

  return {
    lowDistractionEnabled,
    mode,
    foldLowPriorityToDigest,
    categoryOverrides: overrides,
  };
}

export function resolveMainChatNotificationPolicy(
  settings: Pick<MainChatSettings, "notificationPolicy"> | null | undefined,
): MainChatNotificationPolicy {
  return normalizeMainChatNotificationPolicy(settings?.notificationPolicy);
}

export function createDefaultMainChatResourceAdmissionPolicy(): MainChatResourceAdmissionPolicy {
  return {
    enabled: false,
    maxConcurrentPerHost: MAIN_CHAT_DEFAULT_MAX_CONCURRENT_PER_HOST,
    maxCpuPercent: MAIN_CHAT_DEFAULT_MAX_CPU_PERCENT,
    minFreeMemoryMb: MAIN_CHAT_DEFAULT_MIN_FREE_MEMORY_MB,
    queueWhenPressured: true,
  };
}

export function normalizeMainChatResourceAdmissionPolicy(
  raw: Partial<MainChatResourceAdmissionPolicy> | null | undefined,
): MainChatResourceAdmissionPolicy {
  const defaults = createDefaultMainChatResourceAdmissionPolicy();
  if (!raw) return defaults;
  const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  };
  return {
    enabled: raw.enabled === true,
    maxConcurrentPerHost: clampInt(
      raw.maxConcurrentPerHost,
      MAIN_CHAT_MIN_CONCURRENT_PER_HOST,
      MAIN_CHAT_MAX_CONCURRENT_PER_HOST,
      defaults.maxConcurrentPerHost,
    ),
    maxCpuPercent: clampInt(
      raw.maxCpuPercent,
      MAIN_CHAT_MIN_CPU_PERCENT,
      MAIN_CHAT_MAX_CPU_PERCENT,
      defaults.maxCpuPercent,
    ),
    minFreeMemoryMb: clampInt(
      raw.minFreeMemoryMb,
      MAIN_CHAT_MIN_FREE_MEMORY_MB,
      MAIN_CHAT_MAX_FREE_MEMORY_MB,
      defaults.minFreeMemoryMb,
    ),
    queueWhenPressured: raw.queueWhenPressured !== false,
  };
}

export function resolveMainChatResourceAdmissionPolicy(
  settings: Pick<MainChatSettings, "resourceAdmission"> | null | undefined,
): MainChatResourceAdmissionPolicy {
  return normalizeMainChatResourceAdmissionPolicy(settings?.resourceAdmission);
}

export function isMainChatStatelessBackgroundSupervisionEnabled(
  settings: Pick<MainChatSettings, "statelessBackgroundSupervision"> | null | undefined,
): boolean {
  return settings?.statelessBackgroundSupervision === true;
}

export function isMainChatOnDemandToolLoadingEnabled(
  settings: Pick<MainChatSettings, "onDemandToolLoading"> | null | undefined,
): boolean {
  return settings?.onDemandToolLoading === true;
}

export function createDefaultMainChatIdleArchivePolicy(): MainChatIdleArchivePolicy {
  return {
    enabled: false,
    idleThresholdMinutes: MAIN_CHAT_DEFAULT_IDLE_ARCHIVE_THRESHOLD_MIN,
    sweepIntervalMinutes: MAIN_CHAT_DEFAULT_IDLE_ARCHIVE_SWEEP_INTERVAL_MIN,
    maxArchivePerSweep: MAIN_CHAT_DEFAULT_IDLE_ARCHIVE_MAX_PER_SWEEP,
  };
}

export function normalizeMainChatIdleArchivePolicy(
  raw: Partial<MainChatIdleArchivePolicy> | null | undefined,
): MainChatIdleArchivePolicy {
  const defaults = createDefaultMainChatIdleArchivePolicy();
  if (!raw) return defaults;
  const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, Math.round(value)));
  };
  return {
    enabled: raw.enabled === true,
    idleThresholdMinutes: clampInt(
      raw.idleThresholdMinutes,
      MAIN_CHAT_MIN_IDLE_ARCHIVE_THRESHOLD_MIN,
      MAIN_CHAT_MAX_IDLE_ARCHIVE_THRESHOLD_MIN,
      defaults.idleThresholdMinutes,
    ),
    sweepIntervalMinutes: clampInt(
      raw.sweepIntervalMinutes,
      MAIN_CHAT_MIN_IDLE_ARCHIVE_SWEEP_INTERVAL_MIN,
      MAIN_CHAT_MAX_IDLE_ARCHIVE_SWEEP_INTERVAL_MIN,
      defaults.sweepIntervalMinutes,
    ),
    maxArchivePerSweep: clampInt(
      raw.maxArchivePerSweep,
      MAIN_CHAT_MIN_IDLE_ARCHIVE_MAX_PER_SWEEP,
      MAIN_CHAT_MAX_IDLE_ARCHIVE_MAX_PER_SWEEP,
      defaults.maxArchivePerSweep,
    ),
  };
}

export function resolveMainChatIdleArchivePolicy(
  settings: Pick<MainChatSettings, "idleArchivePolicy"> | null | undefined,
): MainChatIdleArchivePolicy {
  return normalizeMainChatIdleArchivePolicy(settings?.idleArchivePolicy);
}

const BUILTIN_PROMPT_EPOCH = "2026-01-01T00:00:00.000Z";

export const BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES: readonly MainChatPromptTemplate[] = [
  {
    id: "builtin_review",
    slug: "review",
    title: "代码审阅与风险核查",
    description: "针对指定改动或 PR 执行缺陷、边界与回归风险核查",
    content:
      "请对 {{arg}} 进行系统化代码审阅：按严重程度列出真实缺陷、边界条件与回归风险，给出具体文件行号和最小修复建议，不要泛泛点评风格。",
    argumentHint: "<PR/分支/模块>",
    builtin: true,
    category: "review",
    createdAt: BUILTIN_PROMPT_EPOCH,
    updatedAt: BUILTIN_PROMPT_EPOCH,
  },
  {
    id: "builtin_bugfix",
    slug: "bugfix",
    title: "根因定位与最小修复",
    description: "先复现并确认根因，再实施最小范围修复与回归验证",
    content:
      "请排查并修复以下问题：{{arg}}。要求先用最小复现或测试定位根因，再执行最小侵入修复，并附上真实测试验证结果。",
    argumentHint: "<故障现象或报错>",
    builtin: true,
    category: "debug",
    createdAt: BUILTIN_PROMPT_EPOCH,
    updatedAt: BUILTIN_PROMPT_EPOCH,
  },
  {
    id: "builtin_plan",
    slug: "plan",
    title: "拆解可执行任务计划",
    description: "将目标拆解为带验收标准和依赖顺序的任务切片",
    content:
      "请为以下目标拆解可执行计划：{{arg}}。明确每个子任务的目标、读写模式、依赖顺序与可验证验收标准，涉及改动先出计划卡待我确认。",
    argumentHint: "<需求或重构目标>",
    builtin: true,
    category: "planning",
    createdAt: BUILTIN_PROMPT_EPOCH,
    updatedAt: BUILTIN_PROMPT_EPOCH,
  },
  {
    id: "builtin_brief",
    slug: "brief",
    title: "全局态势与阻塞简报",
    description: "汇总当前所有活跃任务、待拍板事项与优先下一步",
    content:
      "请给我一份精简的全局进展简报：列出当前所有活跃任务与会话状态、待我拍板或审批的阻塞点、以及你建议的下一步优先动作{{arg}}。",
    argumentHint: "[聚焦范围]",
    builtin: true,
    category: "workflow",
    createdAt: BUILTIN_PROMPT_EPOCH,
    updatedAt: BUILTIN_PROMPT_EPOCH,
  },
  {
    id: "builtin_qa",
    slug: "qa",
    title: "回归验证与证据清单",
    description: "执行构建、类型检查、单测与端到端检查并逐条回报证据",
    content:
      "请围绕 {{arg}} 执行完整回归验收：运行类型检查、lint、相关单元与集成测试，逐条给出真实命令输出与遗留风险。",
    argumentHint: "<改动模块或 PR>",
    builtin: true,
    category: "review",
    createdAt: BUILTIN_PROMPT_EPOCH,
    updatedAt: BUILTIN_PROMPT_EPOCH,
  },
];

const RESERVED_PROMPT_SLUG_SET: ReadonlySet<string> = new Set(MAIN_CHAT_PROMPT_RESERVED_SLUGS);
const BUILTIN_PROMPT_SLUG_SET: ReadonlySet<string> = new Set(
  BUILTIN_MAIN_CHAT_PROMPT_TEMPLATES.map((item) => item.slug),
);

export function normalizeMainChatPromptSlug(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAIN_CHAT_PROMPT_SLUG_MAX_CHARS);
}

export function isReservedMainChatPromptSlug(slug: string): boolean {
  return RESERVED_PROMPT_SLUG_SET.has(normalizeMainChatPromptSlug(slug));
}

export function isBuiltinMainChatPromptSlug(slug: string): boolean {
  return BUILTIN_PROMPT_SLUG_SET.has(normalizeMainChatPromptSlug(slug));
}

const PROMPT_ARG_PLACEHOLDER_RE = /\{\{\s*arg\s*\}\}/gi;

export function promptTemplateHasArgPlaceholder(content: string): boolean {
  PROMPT_ARG_PLACEHOLDER_RE.lastIndex = 0;
  return PROMPT_ARG_PLACEHOLDER_RE.test(content);
}

export function expandMainChatPromptTemplate(content: string, argText = ""): string {
  const trimmedArg = argText.trim();
  const hasPlaceholder = promptTemplateHasArgPlaceholder(content);
  if (hasPlaceholder) {
    return content
      .replace(PROMPT_ARG_PLACEHOLDER_RE, trimmedArg)
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }
  if (!trimmedArg) return content.trim();
  return `${content.trim()}\n\n${trimmedArg}`;
}

export interface ResolvedPromptTemplateSlashInvocation {
  template: MainChatPromptTemplate;
  args: string;
  expandedText: string;
}

export function resolvePromptTemplateSlashInvocation(input: {
  text: string;
  templates: readonly MainChatPromptTemplate[];
  hasAttachments?: boolean;
}): ResolvedPromptTemplateSlashInvocation | null {
  const trimmed = input.text.trim();
  if (!trimmed.startsWith("/")) return null;
  const match = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const slug = match[1]!.toLowerCase();
  if (RESERVED_PROMPT_SLUG_SET.has(slug)) return null;
  const matched = input.templates.find((item) => item.slug.toLowerCase() === slug);
  if (!matched) return null;
  const args = (match[2] ?? "").trim();
  return {
    template: matched,
    args,
    expandedText: expandMainChatPromptTemplate(matched.content, args),
  };
}

export function createDefaultMainChatSettings(
  style: MainChatStyle = "conservative",
): MainChatSettings {
  const preset = getMainChatStylePreset(style);
  return {
    enabled: false,
    autoCompactEnabled: true,
    compaction: createDefaultMainChatCompactionConfig(),
    cacheKeepalive: createDefaultMainChatCacheKeepaliveConfig(),
    limitFallbacks: [],
    modelConfig: createDefaultMainChatModelConfig(),
    notificationPolicy: createDefaultMainChatNotificationPolicy(),
    resourceAdmission: createDefaultMainChatResourceAdmissionPolicy(),
    statelessBackgroundSupervision: false,
    onDemandToolLoading: false,
    idleArchivePolicy: createDefaultMainChatIdleArchivePolicy(),
    mainBackgroundFolded: true,
    mainTasksQuiet: true,
    taskLessonsEnabled: true,
    deliveryGatePolicy: "merged",
    profile: createDefaultMainChatProfile(),
    title: MAIN_CHAT_DEFAULT_TITLE,
    style: preset.style,
    activePresetId: preset.style,
    customPresets: [],
    backgroundModel: preset.backgroundModel,
    intervals: preset.intervals,
    capabilities: preset.capabilities,
    nightMode: createDefaultMainChatNightMode(),
    fleetScope: createDefaultMainChatFleetScope(),
  };
}

function applyCustomPresetMutations(
  current: MainChatSettings,
  patch: MainChatSettingsPatch,
): MainChatCustomStylePreset[] {
  let nextCustomPresets =
    patch.customPresets !== undefined
      ? sanitizeCustomStylePresets(patch.customPresets)
      : resolveMainChatCustomPresets(current);

  if (patch.upsertCustomPreset) {
    const parsedPreset = MainChatCustomStylePresetSchema.parse(patch.upsertCustomPreset);
    const normalized = normalizeCustomStylePreset(parsedPreset);
    if (isBuiltInMainChatStylePresetId(normalized.id)) {
      throw new Error(`Cannot overwrite built-in style preset "${normalized.id}"`);
    }
    const existingIndex = nextCustomPresets.findIndex((entry) => entry.id === normalized.id);
    if (existingIndex >= 0) {
      nextCustomPresets = nextCustomPresets.map((entry, idx) =>
        idx === existingIndex ? normalized : entry,
      );
    } else {
      if (nextCustomPresets.length >= MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS) {
        throw new Error(
          `Custom style preset limit reached (${MAIN_CHAT_MAX_CUSTOM_STYLE_PRESETS})`,
        );
      }
      nextCustomPresets = [...nextCustomPresets, normalized];
    }
  }

  if (patch.deleteCustomPresetId) {
    const targetId = patch.deleteCustomPresetId.trim();
    if (targetId && !isBuiltInMainChatStylePresetId(targetId)) {
      nextCustomPresets = nextCustomPresets.filter((entry) => entry.id !== targetId);
    }
  }

  return nextCustomPresets;
}

function resolveMergeBaseSettings(
  current: MainChatSettings,
  patch: MainChatSettingsPatch,
  nextCustomPresets: MainChatCustomStylePreset[],
): MainChatSettings {
  const currentNightMode = resolveMainChatNightMode(current);
  const currentFleetScope = resolveMainChatFleetScope(current);
  const currentProfile = resolveMainChatProfile(current);
  const currentCompaction = resolveMainChatCompactionConfig(current);
  const currentCacheKeepalive = resolveMainChatCacheKeepaliveConfig(current);
  const currentLimitFallbacks = resolveMainChatLimitFallbacks(current);
  const currentModelConfig = resolveMainChatModelConfig(current);
  const currentNotificationPolicy = resolveMainChatNotificationPolicy(current);
  const currentResourceAdmission = resolveMainChatResourceAdmissionPolicy(current);
  const currentIdleArchivePolicy = resolveMainChatIdleArchivePolicy(current);
  const shared = {
    enabled: isMainChatEnabled(current),
    autoCompactEnabled: isMainChatAutoCompactEnabled(current),
    compaction: currentCompaction,
    cacheKeepalive: currentCacheKeepalive,
    limitFallbacks: currentLimitFallbacks,
    modelConfig: currentModelConfig,
    notificationPolicy: currentNotificationPolicy,
    resourceAdmission: currentResourceAdmission,
    statelessBackgroundSupervision: isMainChatStatelessBackgroundSupervisionEnabled(current),
    onDemandToolLoading: isMainChatOnDemandToolLoadingEnabled(current),
    idleArchivePolicy: currentIdleArchivePolicy,
    mainBackgroundFolded: isMainChatBackgroundFolded(current),
    mainTasksQuiet: isMainChatTasksQuiet(current),
    taskLessonsEnabled: isMainChatTaskLessonsEnabled(current),
    deliveryGatePolicy: resolveMainChatDeliveryGatePolicy(current),
    profile: currentProfile,
    customPresets: nextCustomPresets,
    nightMode: currentNightMode,
    fleetScope: currentFleetScope,
  };

  const requestedPresetId = patch.resetStyleToDefault
    ? "conservative"
    : patch.applyPresetId?.trim() || patch.applyPreset || null;

  if (!requestedPresetId) {
    const resolvedActiveId = resolveActiveMainChatStylePresetId({
      style: current.style,
      activePresetId: current.activePresetId,
      customPresets: nextCustomPresets,
    });
    return {
      ...current,
      ...shared,
      activePresetId: resolvedActiveId,
    };
  }

  if (isBuiltInMainChatStylePresetId(requestedPresetId)) {
    const builtin = getMainChatStylePreset(requestedPresetId);
    return {
      ...shared,
      title: current.title,
      style: builtin.style,
      activePresetId: requestedPresetId,
      backgroundModel: { ...current.backgroundModel },
      intervals: builtin.intervals,
      capabilities: builtin.capabilities,
    };
  }

  const custom = nextCustomPresets.find((entry) => entry.id === requestedPresetId);
  if (!custom) {
    throw new Error(`Style preset "${requestedPresetId}" not found`);
  }
  return {
    ...shared,
    title: current.title,
    style: custom.baseStyle,
    activePresetId: custom.id,
    backgroundModel: { ...current.backgroundModel },
    intervals: { ...custom.intervals },
    capabilities: { ...custom.capabilities },
  };
}

function mergeCompactionConfig(
  base: MainChatSettings,
  patch: MainChatSettingsPatch["compaction"],
): MainChatCompactionConfig {
  const current = resolveMainChatCompactionConfig(base);
  if (!patch) return current;
  return {
    windowCapTokens:
      patch.windowCapTokens !== undefined ? patch.windowCapTokens : current.windowCapTokens,
    idlePrecompactMinIdleMin:
      patch.idlePrecompactMinIdleMin !== undefined
        ? patch.idlePrecompactMinIdleMin
        : current.idlePrecompactMinIdleMin,
  };
}

function mergeCacheKeepaliveConfig(
  base: MainChatSettings,
  patch: MainChatSettingsPatch["cacheKeepalive"],
): MainChatCacheKeepaliveConfig {
  const current = resolveMainChatCacheKeepaliveConfig(base);
  if (!patch) return current;
  return {
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    intervalMinutes:
      patch.intervalMinutes !== undefined ? patch.intervalMinutes : current.intervalMinutes,
    maxRequests: patch.maxRequests !== undefined ? patch.maxRequests : current.maxRequests,
  };
}

function mergeProfileConfig(
  current: MainChatSettings,
  base: MainChatSettings,
  patch: MainChatSettingsPatch["profile"],
): MainChatProfile {
  if (!patch) return resolveMainChatProfile(base);
  const currentProfile = resolveMainChatProfile(current);
  return normalizeMainChatProfile({
    aboutMe: patch.aboutMe ?? currentProfile.aboutMe,
    ownerAliases: patch.ownerAliases ?? currentProfile.ownerAliases,
    updatedAt: new Date().toISOString(),
  });
}

function mergeMainChatToggleAndGovernanceFields(
  base: MainChatSettings,
  patch: MainChatSettingsPatch,
) {
  return {
    enabled: patch.enabled ?? base.enabled ?? true,
    autoCompactEnabled: patch.autoCompactEnabled ?? base.autoCompactEnabled ?? true,
    mainBackgroundFolded: patch.mainBackgroundFolded ?? base.mainBackgroundFolded ?? true,
    mainTasksQuiet: patch.mainTasksQuiet ?? base.mainTasksQuiet ?? true,
    taskLessonsEnabled: patch.taskLessonsEnabled ?? base.taskLessonsEnabled ?? true,
    deliveryGatePolicy: patch.deliveryGatePolicy ?? base.deliveryGatePolicy ?? "merged",
    statelessBackgroundSupervision:
      patch.statelessBackgroundSupervision ?? base.statelessBackgroundSupervision ?? false,
    onDemandToolLoading: patch.onDemandToolLoading ?? base.onDemandToolLoading ?? false,
  };
}

function makeProtocolSwitchEventId(): string {
  return `mps_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function areModelSlotBindingsEqual(
  left: MainChatModelSlotBinding | null | undefined,
  right: MainChatModelSlotBinding | null | undefined,
): boolean {
  const a = normalizeModelSlotBinding(left);
  const b = normalizeModelSlotBinding(right);
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.provider === b.provider &&
    (a.model ?? null) === (b.model ?? null) &&
    (a.thinkingOptionId ?? null) === (b.thinkingOptionId ?? null)
  );
}

function diffModelSlots(
  before: MainChatModelSlots,
  after: MainChatModelSlots,
): MainChatModelPurpose[] {
  const changed: MainChatModelPurpose[] = [];
  for (const purpose of MAIN_CHAT_MODEL_PURPOSES) {
    if (!areModelSlotBindingsEqual(before[purpose], after[purpose])) {
      changed.push(purpose);
    }
  }
  return changed;
}

function mergeCustomModelProfilesList(
  currentProfiles: readonly MainChatModelProfile[],
  patch: NonNullable<MainChatSettingsPatch["modelConfig"]>,
  nowIso: string,
): MainChatModelProfile[] {
  let next =
    patch.customProfiles !== undefined
      ? patch.customProfiles
          .slice(0, MAIN_CHAT_MAX_CUSTOM_MODEL_PROFILES)
          .map((p) => normalizeCustomModelProfile(MainChatModelProfileSchema.parse(p), nowIso))
      : [...currentProfiles];

  if (patch.upsertCustomProfile) {
    const parsed = MainChatModelProfileSchema.parse(patch.upsertCustomProfile);
    if (isBuiltinMainChatModelProfileId(parsed.id)) {
      throw new Error(`Cannot overwrite built-in model profile "${parsed.id}"`);
    }
    const normalized = normalizeCustomModelProfile(parsed, nowIso);
    const idx = next.findIndex((entry) => entry.id === normalized.id);
    if (idx >= 0) {
      next = next.map((entry, i) => (i === idx ? normalized : entry));
    } else {
      if (next.length >= MAIN_CHAT_MAX_CUSTOM_MODEL_PROFILES) {
        throw new Error(
          `Custom model profile limit reached (${MAIN_CHAT_MAX_CUSTOM_MODEL_PROFILES})`,
        );
      }
      next = [...next, normalized];
    }
  }

  if (patch.deleteCustomProfileId) {
    const targetId = patch.deleteCustomProfileId.trim();
    if (targetId && !isBuiltinMainChatModelProfileId(targetId)) {
      next = next.filter((entry) => entry.id !== targetId);
    }
  }
  return next;
}

function applyModelProfileRollbackTransition(
  current: MainChatModelConfig,
  currentSlots: MainChatModelSlots,
  baseHistory: NonNullable<MainChatModelConfig["switchHistory"]>,
  nowIso: string,
) {
  if (!current.rollbackSnapshot) {
    throw new Error("No previous model profile snapshot available to roll back");
  }
  const targetSlots = normalizeMainChatModelSlots(current.rollbackSnapshot.slots);
  const targetProfileId = current.rollbackSnapshot.profileId ?? null;
  const changedSlots = diffModelSlots(currentSlots, targetSlots);
  return {
    slots: targetSlots,
    activeProfileId: targetProfileId,
    rollbackSnapshot: {
      profileId: current.activeProfileId ?? null,
      slots: currentSlots,
      savedAt: nowIso,
    },
    switchHistory: [
      {
        id: makeProtocolSwitchEventId(),
        action: "rollback" as const,
        fromProfileId: current.activeProfileId ?? null,
        toProfileId: targetProfileId,
        changedSlots,
        actor: "user" as const,
        createdAt: nowIso,
      },
      ...baseHistory,
    ].slice(0, MAIN_CHAT_MAX_MODEL_PROFILE_HISTORY),
  };
}

function applyModelProfileTransitionPatch(input: {
  current: MainChatModelConfig;
  currentSlots: MainChatModelSlots;
  customProfiles: readonly MainChatModelProfile[];
  patch: NonNullable<MainChatSettingsPatch["modelConfig"]>;
  nowIso: string;
}): {
  slots: MainChatModelSlots;
  activeProfileId: string | null;
  rollbackSnapshot: MainChatModelConfig["rollbackSnapshot"];
  switchHistory: NonNullable<MainChatModelConfig["switchHistory"]>;
} {
  const { current, currentSlots, customProfiles, patch, nowIso } = input;
  const baseHistory = [...(current.switchHistory ?? [])];

  if (patch.rollbackProfile) {
    return applyModelProfileRollbackTransition(current, currentSlots, baseHistory, nowIso);
  }

  if (patch.applyProfileId) {
    const targetId = patch.applyProfileId.trim();
    const builtins = resolveBuiltinMainChatModelProfiles(currentSlots.main ?? null);
    const matched =
      builtins.find((p) => p.id === targetId) ??
      customProfiles.find((p) => p.id === targetId) ??
      null;
    if (!matched) {
      throw new Error(`Model profile "${targetId}" not found`);
    }
    const targetSlots = normalizeMainChatModelSlots(matched.slots);
    const changedSlots = diffModelSlots(currentSlots, targetSlots);
    const changed = changedSlots.length > 0 || (current.activeProfileId ?? null) !== matched.id;
    return {
      slots: targetSlots,
      activeProfileId: matched.id,
      rollbackSnapshot: changed
        ? { profileId: current.activeProfileId ?? null, slots: currentSlots, savedAt: nowIso }
        : (current.rollbackSnapshot ?? null),
      switchHistory: changed
        ? [
            {
              id: makeProtocolSwitchEventId(),
              action: "switch" as const,
              fromProfileId: current.activeProfileId ?? null,
              toProfileId: matched.id,
              changedSlots,
              actor: "user" as const,
              createdAt: nowIso,
            },
            ...baseHistory,
          ].slice(0, MAIN_CHAT_MAX_MODEL_PROFILE_HISTORY)
        : baseHistory,
    };
  }

  return {
    slots: { ...currentSlots },
    activeProfileId: current.activeProfileId ?? null,
    rollbackSnapshot: current.rollbackSnapshot ?? null,
    switchHistory: baseHistory,
  };
}

function mergeModelSlotsOverride(
  baseSlots: MainChatModelSlots,
  slotPatch: NonNullable<MainChatSettingsPatch["modelConfig"]>["slots"],
): MainChatModelSlots {
  if (!slotPatch) return baseSlots;
  const merged: MainChatModelSlots = { ...baseSlots };
  for (const purpose of MAIN_CHAT_MODEL_PURPOSES) {
    if (!Object.prototype.hasOwnProperty.call(slotPatch, purpose)) continue;
    const incoming = slotPatch[purpose];
    if (incoming === null) {
      delete merged[purpose];
    } else if (incoming !== undefined) {
      const normalized = normalizeModelSlotBinding(incoming);
      if (normalized) merged[purpose] = normalized;
      else delete merged[purpose];
    }
  }
  return merged;
}

function mergeModelConfig(
  base: MainChatSettings,
  patch: MainChatSettingsPatch["modelConfig"],
): MainChatModelConfig {
  const current = resolveMainChatModelConfig(base);
  if (!patch) return current;

  const nowIso = new Date().toISOString();
  const nextCustomProfiles = mergeCustomModelProfilesList(
    current.customProfiles ?? [],
    patch,
    nowIso,
  );
  const currentSlots = normalizeMainChatModelSlots(current.slots);
  const transitioned = applyModelProfileTransitionPatch({
    current,
    currentSlots,
    customProfiles: nextCustomProfiles,
    patch,
    nowIso,
  });
  const nextSlots = mergeModelSlotsOverride(transitioned.slots, patch.slots);
  let nextActiveProfileId = transitioned.activeProfileId;

  if (patch.activeProfileId !== undefined && !patch.applyProfileId && !patch.rollbackProfile) {
    nextActiveProfileId = patch.activeProfileId?.trim() || null;
  }
  if (
    nextActiveProfileId &&
    !isBuiltinMainChatModelProfileId(nextActiveProfileId) &&
    !nextCustomProfiles.some((entry) => entry.id === nextActiveProfileId)
  ) {
    nextActiveProfileId = null;
  }

  return {
    activeProfileId: nextActiveProfileId,
    slots: nextSlots,
    customProfiles: nextCustomProfiles,
    rollbackSnapshot: transitioned.rollbackSnapshot,
    switchHistory: transitioned.switchHistory,
  };
}

function mergeNotificationPolicy(
  base: MainChatSettings,
  patch: MainChatSettingsPatch["notificationPolicy"],
): MainChatNotificationPolicy {
  const current = resolveMainChatNotificationPolicy(base);
  if (!patch) return current;

  const nextOverrides: Record<string, MainChatNotificationTier> = {
    ...current.categoryOverrides,
  };
  if (patch.categoryOverrides) {
    for (const [key, value] of Object.entries(patch.categoryOverrides)) {
      if (value === null) {
        delete nextOverrides[key];
      } else if (value !== undefined) {
        nextOverrides[key] = value;
      }
    }
  }

  const nextMode = patch.mode ?? current.mode ?? "balanced";
  let nextLowDistraction = current.lowDistractionEnabled;
  let nextFold = current.foldLowPriorityToDigest;
  if (patch.mode !== undefined && patch.lowDistractionEnabled === undefined) {
    nextLowDistraction = patch.mode === "low_distraction";
  }
  if (patch.mode !== undefined && patch.foldLowPriorityToDigest === undefined) {
    nextFold = patch.mode === "low_distraction";
  }
  if (patch.lowDistractionEnabled !== undefined) {
    nextLowDistraction = patch.lowDistractionEnabled;
  }
  if (patch.foldLowPriorityToDigest !== undefined) {
    nextFold = patch.foldLowPriorityToDigest;
  }

  return normalizeMainChatNotificationPolicy({
    lowDistractionEnabled: nextLowDistraction,
    mode: nextMode,
    foldLowPriorityToDigest: nextFold,
    categoryOverrides: nextOverrides,
  });
}

function mergeResourceAdmissionPolicy(
  base: MainChatSettings,
  patch: MainChatSettingsPatch["resourceAdmission"],
): MainChatResourceAdmissionPolicy {
  const current = resolveMainChatResourceAdmissionPolicy(base);
  if (!patch) return current;
  return normalizeMainChatResourceAdmissionPolicy({
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    maxConcurrentPerHost:
      patch.maxConcurrentPerHost !== undefined
        ? patch.maxConcurrentPerHost
        : current.maxConcurrentPerHost,
    maxCpuPercent: patch.maxCpuPercent !== undefined ? patch.maxCpuPercent : current.maxCpuPercent,
    minFreeMemoryMb:
      patch.minFreeMemoryMb !== undefined ? patch.minFreeMemoryMb : current.minFreeMemoryMb,
    queueWhenPressured:
      patch.queueWhenPressured !== undefined
        ? patch.queueWhenPressured
        : current.queueWhenPressured,
  });
}

function mergeIdleArchivePolicy(
  base: MainChatSettings,
  patch: MainChatSettingsPatch["idleArchivePolicy"],
): MainChatIdleArchivePolicy {
  const current = resolveMainChatIdleArchivePolicy(base);
  if (!patch) return current;
  return normalizeMainChatIdleArchivePolicy({
    enabled: patch.enabled !== undefined ? patch.enabled : current.enabled,
    idleThresholdMinutes:
      patch.idleThresholdMinutes !== undefined
        ? patch.idleThresholdMinutes
        : current.idleThresholdMinutes,
    sweepIntervalMinutes:
      patch.sweepIntervalMinutes !== undefined
        ? patch.sweepIntervalMinutes
        : current.sweepIntervalMinutes,
    maxArchivePerSweep:
      patch.maxArchivePerSweep !== undefined
        ? patch.maxArchivePerSweep
        : current.maxArchivePerSweep,
  });
}

export function mergeMainChatSettings(
  current: MainChatSettings,
  patch: MainChatSettingsPatch,
): MainChatSettings {
  const nextCustomPresets = applyCustomPresetMutations(current, patch);
  const base = resolveMergeBaseSettings(current, patch, nextCustomPresets);
  const baseFleetScope = resolveMainChatFleetScope(base);
  const nextFleetScope = normalizeMainChatFleetScope({
    mode: patch.fleetScope?.mode ?? baseFleetScope.mode,
    hostServerIds: patch.fleetScope?.hostServerIds ?? baseFleetScope.hostServerIds,
  });
  const nextLimitFallbacks =
    patch.limitFallbacks !== undefined
      ? normalizeMainChatLimitFallbacks(patch.limitFallbacks)
      : resolveMainChatLimitFallbacks(base);

  return MainChatSettingsSchema.parse({
    ...mergeMainChatToggleAndGovernanceFields(base, patch),
    compaction: mergeCompactionConfig(base, patch.compaction),
    cacheKeepalive: mergeCacheKeepaliveConfig(base, patch.cacheKeepalive),
    limitFallbacks: nextLimitFallbacks,
    modelConfig: mergeModelConfig(base, patch.modelConfig),
    notificationPolicy: mergeNotificationPolicy(base, patch.notificationPolicy),
    resourceAdmission: mergeResourceAdmissionPolicy(base, patch.resourceAdmission),
    idleArchivePolicy: mergeIdleArchivePolicy(base, patch.idleArchivePolicy),
    profile: mergeProfileConfig(current, base, patch.profile),
    title: patch.title?.trim() || base.title || MAIN_CHAT_DEFAULT_TITLE,
    style: patch.style ?? base.style,
    activePresetId: base.activePresetId,
    customPresets: nextCustomPresets,
    backgroundModel: { ...base.backgroundModel, ...patch.backgroundModel },
    intervals: { ...base.intervals, ...patch.intervals },
    capabilities: { ...base.capabilities, ...patch.capabilities },
    nightMode: { ...resolveMainChatNightMode(base), ...patch.nightMode },
    fleetScope: nextFleetScope,
  });
}

export const MainChatTaskModeSchema = z.enum(["readonly", "write"]);
export type MainChatTaskMode = z.infer<typeof MainChatTaskModeSchema>;

export const MainChatTaskIsolationSchema = z.enum(["local", "worktree"]);
export type MainChatTaskIsolation = z.infer<typeof MainChatTaskIsolationSchema>;

export const MainChatPlanStatusSchema = z.enum(["open", "started", "cancelled", "withdrawn"]);
export type MainChatPlanStatus = z.infer<typeof MainChatPlanStatusSchema>;

export const MainChatTaskStatusSchema = z.enum([
  "open",
  "running",
  "needs_you",
  "awaiting_review",
  "parked",
  "completed",
  "cancelled",
  "failed",
]);
export type MainChatTaskStatus = z.infer<typeof MainChatTaskStatusSchema>;

export const MainChatTaskBriefSchema = z.object({
  goal: z.string(),
  doneWhen: z.array(z.string()),
  outOfBounds: z.array(z.string()),
  scopeRevision: z.number().int().positive(),
  updatedAt: z.string(),
});
export type MainChatTaskBrief = z.infer<typeof MainChatTaskBriefSchema>;

export const MainChatTaskDecisionActorSchema = z.enum(["user", "supervisor", "leader"]);
export type MainChatTaskDecisionActor = z.infer<typeof MainChatTaskDecisionActorSchema>;

export const MainChatTaskDecisionEntrySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  question: z.string(),
  answer: z.string(),
  decidedBy: MainChatTaskDecisionActorSchema,
  createdAt: z.string(),
});
export type MainChatTaskDecisionEntry = z.infer<typeof MainChatTaskDecisionEntrySchema>;

export const MainChatTaskReviewVerdictSchema = z.enum(["accept", "rework"]);
export type MainChatTaskReviewVerdict = z.infer<typeof MainChatTaskReviewVerdictSchema>;

export const MainChatDurationSampleSchema = z.object({
  id: z.string(),
  serverId: z.string().nullable(),
  cwd: z.string().nullable(),
  mode: MainChatTaskModeSchema,
  role: z.string().nullable(),
  provider: z.string().nullable(),
  durationMinutes: z.number().positive(),
  completedAt: z.string(),
});
export type MainChatDurationSample = z.infer<typeof MainChatDurationSampleSchema>;

export const MainChatConversationKindSchema = z.enum(["main", "leader", "side"]);
export type MainChatConversationKind = z.infer<typeof MainChatConversationKindSchema>;

export const MainChatConversationRecordSchema = z.object({
  id: z.string(),
  kind: MainChatConversationKindSchema,
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  title: z.string(),
  directionSummary: z.string().nullable(),
  notes: z.string().max(MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS).nullable().optional(),
  parentConversationId: z.string().nullable(),
  serverId: z.string().nullable(),
  archivedAt: z.string().nullable(),
  pinnedAsLeaderAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastMessageAt: z.string().nullable(),
});
export type MainChatConversationRecord = z.infer<typeof MainChatConversationRecordSchema>;

export const MainChatFleetHostStatusSchema = z.object({
  serverId: z.string(),
  label: z.string(),
  isLocal: z.boolean(),
  status: z.enum(["online", "connecting", "offline", "error", "degraded"]),
  agentCount: z.number().int().nonnegative(),
  needsAttentionCount: z.number().int().nonnegative(),
  lastSyncedAt: z.string().nullable(),
  error: z.string().nullable(),
  registrationId: z.string().optional(),
  expectedServerId: z.string().optional(),
  targetDescription: z.string().optional(),
});
export type MainChatFleetHostStatus = z.infer<typeof MainChatFleetHostStatusSchema>;

export const MainChatSupervisionSignalKindSchema = z.enum([
  "review",
  "parent_closeout",
  "pr_merged",
  "report",
  "idle",
  "unjudged",
  "needs_you",
  "ask",
  "stalled",
  "no_progress",
  "all_stopped",
  "timed_out",
  "interrupted",
  "failed",
  "orphaned",
  "pr_conflict",
  "draft_pr",
  "pr_event",
  "todo_ready",
  "decision_reply",
  "check",
  "escalated",
  "decide",
  "leader_stuck",
  "usage_limit_wake",
  "transient_retry",
]);
export type MainChatSupervisionSignalKind = z.infer<typeof MainChatSupervisionSignalKindSchema>;

export const MainChatSupervisionUrgencySchema = z.enum(["normal", "urgent", "immediate"]);
export type MainChatSupervisionUrgency = z.infer<typeof MainChatSupervisionUrgencySchema>;

export const MainChatSupervisionSignalSchema = z.object({
  id: z.string(),
  kind: MainChatSupervisionSignalKindSchema,
  urgency: MainChatSupervisionUrgencySchema,
  taskId: z.string().nullable(),
  agentId: z.string().nullable(),
  serverId: z.string().nullable(),
  conversationId: z.string().nullable(),
  title: z.string(),
  summary: z.string(),
  createdAt: z.string(),
});
export type MainChatSupervisionSignal = z.infer<typeof MainChatSupervisionSignalSchema>;

export const MainChatNotificationReceiptSchema = z.object({
  id: z.string(),
  category: MainChatNotificationCategorySchema,
  signalKind: MainChatSupervisionSignalKindSchema.nullable().optional(),
  tier: MainChatNotificationTierSchema,
  status: MainChatNotificationDeliveryStatusSchema,
  channel: MainChatNotificationChannelSchema,
  title: z.string(),
  summary: z.string(),
  reason: z.string().nullable(),
  taskId: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  conversationId: z.string().nullable().optional(),
  passthrough: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deliveredAt: z.string().nullable().optional(),
  acknowledgedAt: z.string().nullable().optional(),
  readAt: z.string().nullable().optional(),
});
export type MainChatNotificationReceipt = z.infer<typeof MainChatNotificationReceiptSchema>;

export const MainChatApprovalClarificationSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  serverId: z.string().nullable(),
  permissionRequestId: z.string(),
  question: z.string(),
  answer: z.string().nullable(),
  proofToken: z.string(),
  pausedDeadlineAt: z.string(),
  answeredAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MainChatApprovalClarification = z.infer<typeof MainChatApprovalClarificationSchema>;

export const MainChatStandingAuthorizationScopeSchema = z.enum(["permission", "auto_start"]);
export type MainChatStandingAuthorizationScope = z.infer<
  typeof MainChatStandingAuthorizationScopeSchema
>;

export const MainChatStandingAuthorizationSchema = z.object({
  id: z.string(),
  scope: MainChatStandingAuthorizationScopeSchema,
  serverId: z.string().nullable(),
  cwd: z.string().nullable(),
  allowSubdirectories: z.boolean().optional(),
  toolName: z.string().nullable(),
  commandPrefix: z.string().nullable(),
  mode: MainChatTaskModeSchema.nullable(),
  label: z.string(),
  reason: z.string().nullable(),
  createdAt: z.string(),
  lastMatchedAt: z.string().nullable(),
  matchCount: z.number().int().nonnegative(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type MainChatStandingAuthorization = z.infer<typeof MainChatStandingAuthorizationSchema>;

export const MainChatRuleSuggestionSchema = z.object({
  id: z.string(),
  scope: MainChatStandingAuthorizationScopeSchema,
  label: z.string(),
  reason: z.string(),
  serverId: z.string().nullable(),
  cwd: z.string().nullable(),
  toolName: z.string().nullable(),
  commandPrefix: z.string().nullable(),
  mode: MainChatTaskModeSchema.nullable(),
  observedCount: z.number().int().positive(),
  dismissedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MainChatRuleSuggestion = z.infer<typeof MainChatRuleSuggestionSchema>;

export const MainChatNextStepSuggestionSchema = z.object({
  id: z.string(),
  label: z.string(),
  prompt: z.string(),
  risky: z.boolean(),
  reason: z.string().nullable().optional(),
  targetAgentId: z.string().nullable().optional(),
  targetTaskId: z.string().nullable().optional(),
});
export type MainChatNextStepSuggestion = z.infer<typeof MainChatNextStepSuggestionSchema>;

export const MainChatPlannedTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  mode: MainChatTaskModeSchema,
  isolation: MainChatTaskIsolationSchema,
  serverId: z.string().nullable().optional(),
  hostLabel: z.string().nullable().optional(),
  cwd: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceLabel: z.string(),
  reason: z.string(),
  doneWhen: z.array(z.string()),
  outOfBounds: z.array(z.string()),
  provider: z.string().nullable(),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  branchName: z.string().nullable(),
  baseBranch: z.string().nullable(),
  agentId: z.string().nullable(),
  startedAt: z.string().nullable(),
  startError: z.string().nullable(),
  continuesTaskId: z.string().nullable().optional(),
  continuesWhy: z.string().nullable().optional(),
  expectedMinutes: z.number().positive().nullable().optional(),
  quiet: z.boolean().optional(),
  scopeRevision: z.number().int().positive().optional(),
  taskRecordId: z.string().nullable().optional(),
  refId: z.string().nullable().optional(),
  partOf: z.string().nullable().optional(),
  after: z.array(z.string()).optional(),
  autoStartOnReady: z.boolean().optional(),
});
export type MainChatPlannedTask = z.infer<typeof MainChatPlannedTaskSchema>;

export const MainChatPlanTaskPatchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  goal: z.string().min(1).max(4000).optional(),
  mode: MainChatTaskModeSchema.optional(),
  isolation: MainChatTaskIsolationSchema.optional(),
  serverId: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  doneWhen: z.array(z.string()).optional(),
  outOfBounds: z.array(z.string()).optional(),
  provider: z.string().nullable().optional(),
  modeId: z.string().nullable().optional(),
  thinkingOptionId: z.string().nullable().optional(),
  branchName: z.string().nullable().optional(),
  baseBranch: z.string().nullable().optional(),
  quiet: z.boolean().optional(),
  partOf: z.string().nullable().optional(),
  after: z.array(z.string()).optional(),
  autoStartOnReady: z.boolean().optional(),
});
export type MainChatPlanTaskPatch = z.infer<typeof MainChatPlanTaskPatchSchema>;

export const MainChatPlanRecordSchema = z.object({
  id: z.string(),
  mainAgentId: z.string(),
  conversationId: z.string().nullable().optional(),
  status: MainChatPlanStatusSchema,
  autoStarted: z.boolean(),
  summary: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  withdrawnAt: z.string().nullable().optional(),
  withdrawReason: z.string().nullable().optional(),
  tasks: z.array(MainChatPlannedTaskSchema),
});
export type MainChatPlanRecord = z.infer<typeof MainChatPlanRecordSchema>;

export const MainChatReceiptCheckSchema = z.object({
  criterion: z.string(),
  met: z.boolean(),
  evidence: z.string(),
});
export type MainChatReceiptCheck = z.infer<typeof MainChatReceiptCheckSchema>;

export const MainChatTaskReceiptSchema = z.object({
  title: z.string(),
  summary: z.string(),
  agentId: z.string().nullable(),
  planId: z.string().nullable(),
  taskId: z.string().nullable(),
  checks: z.array(MainChatReceiptCheckSchema),
  nextSteps: z.array(z.string()),
});
export type MainChatTaskReceipt = z.infer<typeof MainChatTaskReceiptSchema>;

export const MainChatReworkRecordSchema = z.object({
  title: z.string(),
  agentId: z.string(),
  planId: z.string().nullable(),
  taskId: z.string().nullable(),
  round: z.number().int().positive(),
  maxRounds: z.number().int().positive(),
  gaps: z.array(z.string()),
  note: z.string().nullable(),
});
export type MainChatReworkRecord = z.infer<typeof MainChatReworkRecordSchema>;

export const MainChatDecisionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  leadsTo: z.string(),
});
export type MainChatDecisionOption = z.infer<typeof MainChatDecisionOptionSchema>;

export const MainChatDecisionRecordSchema = z.object({
  id: z.string(),
  mainAgentId: z.string(),
  title: z.string(),
  question: z.string(),
  agentId: z.string().nullable(),
  planId: z.string().nullable(),
  taskId: z.string().nullable(),
  options: z.array(MainChatDecisionOptionSchema),
  recommendedOptionId: z.string().nullable(),
  reason: z.string().nullable(),
  answer: z.string().nullable(),
  answeredOptionId: z.string().nullable(),
  answeredAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MainChatDecisionRecord = z.infer<typeof MainChatDecisionRecordSchema>;

export const MainChatTaskRecordSchema = z.object({
  id: z.string(),
  mainAgentId: z.string(),
  conversationId: z.string().nullable().optional(),
  planId: z.string().nullable(),
  title: z.string(),
  mode: MainChatTaskModeSchema,
  isolation: MainChatTaskIsolationSchema,
  serverId: z.string().nullable().optional(),
  hostLabel: z.string().nullable().optional(),
  cwd: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceLabel: z.string(),
  status: MainChatTaskStatusSchema,
  brief: MainChatTaskBriefSchema,
  agentIds: z.array(z.string()),
  activeAgentId: z.string().nullable(),
  continuesTaskId: z.string().nullable().optional(),
  continuesWhy: z.string().nullable().optional(),
  supersededByTaskId: z.string().nullable().optional(),
  expectedMinutes: z.number().positive().nullable().optional(),
  actualMinutes: z.number().nonnegative().nullable().optional(),
  quiet: z.boolean().optional(),
  parkedAt: z.string().nullable().optional(),
  parkedReason: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  lastActivityAt: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  decisions: z.array(MainChatTaskDecisionEntrySchema).optional(),
  latestReceipt: MainChatTaskReceiptSchema.nullable().optional(),
  reworkCount: z.number().int().nonnegative().optional(),
  partOf: z.string().nullable().optional(),
  after: z.array(z.string()).optional(),
  dependencyState: MainChatTaskDependencyStateSchema.optional(),
  autoStartOnReady: z.boolean().optional(),
  deliveryGate: MainChatTaskDeliveryGateSchema.nullable().optional(),
  lastProvider: z.string().nullable().optional(),
  lastModel: z.string().nullable().optional(),
  lastThinkingOptionId: z.string().nullable().optional(),
  lastRuleDiagnostic: MainChatRuleDiagnosticSchema.nullable().optional(),
  admissionState: MainChatTaskAdmissionStateSchema.nullable().optional(),
});
export type MainChatTaskRecord = z.infer<typeof MainChatTaskRecordSchema>;

export const MainChatAutoStartRuleSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  mode: MainChatTaskModeSchema,
  serverId: z.string().nullable().optional(),
  hostLabel: z.string().nullable().optional(),
  allowSubdirectories: z.boolean().optional(),
  createdAt: z.string(),
});
export type MainChatAutoStartRule = z.infer<typeof MainChatAutoStartRuleSchema>;

export const MainChatPermissionRuleSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  commandPrefix: z.string().nullable(),
  cwd: z.string().nullable(),
  createdAt: z.string(),
});
export type MainChatPermissionRule = z.infer<typeof MainChatPermissionRuleSchema>;

export const MainChatRuleKindSchema = z.enum(["auto_start", "permission"]);
export type MainChatRuleKind = z.infer<typeof MainChatRuleKindSchema>;

export const MainChatActivityKindSchema = z.enum([
  "background_turn",
  "silent_turn",
  "preempted",
  "compaction",
  "clear",
  "handoff",
  "missing_reply_recovery",
]);
export type MainChatActivityKind = z.infer<typeof MainChatActivityKindSchema>;

export const MainChatActivityStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "preempted",
  "failed",
  "skipped",
]);
export type MainChatActivityStatus = z.infer<typeof MainChatActivityStatusSchema>;

export const MainChatActivityEntrySchema = z.object({
  id: z.string(),
  mainAgentId: z.string(),
  kind: MainChatActivityKindSchema,
  trigger: z.string(),
  summary: z.string(),
  silent: z.boolean(),
  status: MainChatActivityStatusSchema,
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  preemptedByUser: z.boolean().optional(),
  relatedAgentId: z.string().nullable().optional(),
  detail: z.string().nullable().optional(),
});
export type MainChatActivityEntry = z.infer<typeof MainChatActivityEntrySchema>;

export const MainChatCompactionStatusSchema = z.enum(["idle", "running", "succeeded", "failed"]);
export type MainChatCompactionStatus = z.infer<typeof MainChatCompactionStatusSchema>;

export const MainChatCompactionReasonSchema = z.enum(["manual", "idle_precompact"]);
export type MainChatCompactionReason = z.infer<typeof MainChatCompactionReasonSchema>;

export const MainChatCompactionStrategySchema = z.enum(["native", "handoff_summary"]);
export type MainChatCompactionStrategy = z.infer<typeof MainChatCompactionStrategySchema>;

export const MainChatCompactionStateSchema = z.object({
  status: MainChatCompactionStatusSchema,
  estimatedTokens: z.number().int().nonnegative(),
  thresholdTokens: z.number().int().positive(),
  contextWindowMaxTokens: z.number().int().positive().nullable().optional(),
  windowCapTokens: z.number().int().positive().nullable().optional(),
  effectiveWindowTokens: z.number().int().positive().nullable().optional(),
  idlePrecompactMinIdleMin: z.number().int().positive().optional(),
  autoCompactEnabled: z.boolean().optional(),
  lastCompactedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  summary: z.string().nullable(),
  reason: MainChatCompactionReasonSchema.nullable().optional(),
  strategy: MainChatCompactionStrategySchema.nullable().optional(),
});
export type MainChatCompactionState = z.infer<typeof MainChatCompactionStateSchema>;

export const MainChatMetricsSchema = z.object({
  autoContinued: z.number().int().nonnegative(),
  plansCreated: z.number().int().nonnegative(),
  plansAutoStarted: z.number().int().nonnegative(),
  plansStarted: z.number().int().nonnegative(),
  plansCancelled: z.number().int().nonnegative(),
  receiptsRecorded: z.number().int().nonnegative(),
  interrupts: z.number().int().nonnegative(),
  supervisorHeld: z.number().int().nonnegative(),
  reworkCount: z.number().int().nonnegative(),
  stalledNudges: z.number().int().nonnegative(),
  usageLimitRetries: z.number().int().nonnegative(),
  patrolRuns: z.number().int().nonnegative().optional(),
  triageRuleCount: z.number().int().nonnegative().optional(),
  triageModelCount: z.number().int().nonnegative().optional(),
  proactiveWakeups: z.number().int().nonnegative().optional(),
  autoDelegatedQuestions: z.number().int().nonnegative().optional(),
  noProgressNudges: z.number().int().nonnegative().optional(),
  preemptedTurns: z.number().int().nonnegative().optional(),
  silentTurns: z.number().int().nonnegative().optional(),
  missingReplyRecoveries: z.number().int().nonnegative().optional(),
  compactions: z.number().int().nonnegative().optional(),
  admissionQueued: z.number().int().nonnegative().optional(),
  admissionRejected: z.number().int().nonnegative().optional(),
  admissionDequeued: z.number().int().nonnegative().optional(),
  statelessSupervisionRounds: z.number().int().nonnegative().optional(),
  statelessSupervisionEscalations: z.number().int().nonnegative().optional(),
  idleSubagentsArchived: z.number().int().nonnegative().optional(),
});
export type MainChatMetrics = z.infer<typeof MainChatMetricsSchema>;

export const MainChatOverviewSchema = z.object({
  plans: z.array(MainChatPlanRecordSchema),
  decisions: z.array(MainChatDecisionRecordSchema),
  autoStartRules: z.array(MainChatAutoStartRuleSchema),
  permissionRules: z.array(MainChatPermissionRuleSchema),
  metrics: MainChatMetricsSchema,
  settings: MainChatSettingsSchema.optional(),
  triages: z.array(MainChatSessionTriageSchema).optional(),
  lastPatrolAt: z.string().nullable().optional(),
  lastWakeupAt: z.string().nullable().optional(),
  compaction: MainChatCompactionStateSchema.optional(),
  recentActivityCount: z.number().int().nonnegative().optional(),
  backgroundBusy: z.boolean().optional(),
  queuedBackgroundCount: z.number().int().nonnegative().optional(),
  tasks: z.array(MainChatTaskRecordSchema).optional(),
  conversations: z.array(MainChatConversationRecordSchema).optional(),
  fleetHosts: z.array(MainChatFleetHostStatusSchema).optional(),
  recentReceipts: z.array(MainChatTaskReceiptSchema).optional(),
  standingAuthorizations: z.array(MainChatStandingAuthorizationSchema).optional(),
  ruleSuggestions: z.array(MainChatRuleSuggestionSchema).optional(),
  pendingClarifications: z.array(MainChatApprovalClarificationSchema).optional(),
  nextStepSuggestions: z.array(MainChatNextStepSuggestionSchema).optional(),
  suppressedQuietBadgeCount: z.number().int().nonnegative().optional(),
  pendingSignalCount: z.number().int().nonnegative().optional(),
  nightModeStatus: MainChatNightModeStatusSchema.optional(),
  cacheKeepaliveStatus: MainChatCacheKeepaliveStatusSchema.optional(),
  tokenUsage: MainChatTokenUsageSummarySchema.optional(),
  settingsProposals: z.array(MainChatSettingsProposalRecordSchema).optional(),
  recentLimitFallbacks: z.array(MainChatLimitFallbackEventSchema).optional(),
  projectLessons: z.array(MainChatProjectLessonSchema).optional(),
  notificationSummary: MainChatNotificationSummarySchema.optional(),
  recentNotificationReceipts: z.array(MainChatNotificationReceiptSchema).optional(),
  resourceAdmission: MainChatResourceAdmissionSnapshotSchema.optional(),
  idleArchiveAudit: z.array(MainChatIdleArchiveAuditRecordSchema).optional(),
  promptLibraryCount: z.number().int().nonnegative().optional(),
});
export type MainChatOverview = z.infer<typeof MainChatOverviewSchema>;

// ============================================================================
// Main Chat RPC Schemas
// ============================================================================

export const MainChatEnsureRequestSchema = z.object({
  type: z.literal("main_chat.ensure.request"),
  requestId: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});
export type MainChatEnsureRequest = z.infer<typeof MainChatEnsureRequestSchema>;

export const MainChatEnsureResponsePayloadSchema = z.object({
  requestId: z.string(),
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  created: z.boolean(),
  error: z.string().nullable(),
});
export type MainChatEnsureResponsePayload = z.infer<typeof MainChatEnsureResponsePayloadSchema>;

export const MainChatEnsureResponseSchema = z.object({
  type: z.literal("main_chat.ensure.response"),
  payload: MainChatEnsureResponsePayloadSchema,
});
export type MainChatEnsureResponse = z.infer<typeof MainChatEnsureResponseSchema>;

export const MainChatListPlansRequestSchema = z.object({
  type: z.literal("main_chat.list_plans.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
});
export type MainChatListPlansRequest = z.infer<typeof MainChatListPlansRequestSchema>;

export const MainChatListPlansResponsePayloadSchema = z.object({
  requestId: z.string(),
  plans: z.array(MainChatPlanRecordSchema),
  error: z.string().nullable(),
});
export type MainChatListPlansResponsePayload = z.infer<
  typeof MainChatListPlansResponsePayloadSchema
>;

export const MainChatListPlansResponseSchema = z.object({
  type: z.literal("main_chat.list_plans.response"),
  payload: MainChatListPlansResponsePayloadSchema,
});
export type MainChatListPlansResponse = z.infer<typeof MainChatListPlansResponseSchema>;

export const MainChatStartPlanRequestSchema = z.object({
  type: z.literal("main_chat.start_plan.request"),
  requestId: z.string(),
  planId: z.string(),
  taskIds: z.array(z.string()).optional(),
  rememberAutoStart: z.boolean().optional(),
});
export type MainChatStartPlanRequest = z.infer<typeof MainChatStartPlanRequestSchema>;

export const MainChatStartPlanResponsePayloadSchema = z.object({
  requestId: z.string(),
  plan: MainChatPlanRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatStartPlanResponsePayload = z.infer<
  typeof MainChatStartPlanResponsePayloadSchema
>;

export const MainChatStartPlanResponseSchema = z.object({
  type: z.literal("main_chat.start_plan.response"),
  payload: MainChatStartPlanResponsePayloadSchema,
});
export type MainChatStartPlanResponse = z.infer<typeof MainChatStartPlanResponseSchema>;

export const MainChatCancelPlanRequestSchema = z.object({
  type: z.literal("main_chat.cancel_plan.request"),
  requestId: z.string(),
  planId: z.string(),
});
export type MainChatCancelPlanRequest = z.infer<typeof MainChatCancelPlanRequestSchema>;

export const MainChatCancelPlanResponsePayloadSchema = z.object({
  requestId: z.string(),
  plan: MainChatPlanRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatCancelPlanResponsePayload = z.infer<
  typeof MainChatCancelPlanResponsePayloadSchema
>;

export const MainChatCancelPlanResponseSchema = z.object({
  type: z.literal("main_chat.cancel_plan.response"),
  payload: MainChatCancelPlanResponsePayloadSchema,
});
export type MainChatCancelPlanResponse = z.infer<typeof MainChatCancelPlanResponseSchema>;

export const MainChatGetOverviewRequestSchema = z.object({
  type: z.literal("main_chat.get_overview.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
});
export type MainChatGetOverviewRequest = z.infer<typeof MainChatGetOverviewRequestSchema>;

export const MainChatGetOverviewResponsePayloadSchema = z.object({
  requestId: z.string(),
  overview: MainChatOverviewSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatGetOverviewResponsePayload = z.infer<
  typeof MainChatGetOverviewResponsePayloadSchema
>;

export const MainChatGetOverviewResponseSchema = z.object({
  type: z.literal("main_chat.get_overview.response"),
  payload: MainChatGetOverviewResponsePayloadSchema,
});
export type MainChatGetOverviewResponse = z.infer<typeof MainChatGetOverviewResponseSchema>;

export const MainChatAnswerDecisionRequestSchema = z.object({
  type: z.literal("main_chat.answer_decision.request"),
  requestId: z.string(),
  decisionId: z.string(),
  optionId: z.string().optional(),
  answer: z.string(),
});
export type MainChatAnswerDecisionRequest = z.infer<typeof MainChatAnswerDecisionRequestSchema>;

export const MainChatAnswerDecisionResponsePayloadSchema = z.object({
  requestId: z.string(),
  decision: MainChatDecisionRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatAnswerDecisionResponsePayload = z.infer<
  typeof MainChatAnswerDecisionResponsePayloadSchema
>;

export const MainChatAnswerDecisionResponseSchema = z.object({
  type: z.literal("main_chat.answer_decision.response"),
  payload: MainChatAnswerDecisionResponsePayloadSchema,
});
export type MainChatAnswerDecisionResponse = z.infer<typeof MainChatAnswerDecisionResponseSchema>;

export const MainChatAddPermissionRuleRequestSchema = z.object({
  type: z.literal("main_chat.add_permission_rule.request"),
  requestId: z.string(),
  toolName: z.string(),
  commandPrefix: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
});
export type MainChatAddPermissionRuleRequest = z.infer<
  typeof MainChatAddPermissionRuleRequestSchema
>;

export const MainChatAddPermissionRuleResponsePayloadSchema = z.object({
  requestId: z.string(),
  rule: MainChatPermissionRuleSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatAddPermissionRuleResponsePayload = z.infer<
  typeof MainChatAddPermissionRuleResponsePayloadSchema
>;

export const MainChatAddPermissionRuleResponseSchema = z.object({
  type: z.literal("main_chat.add_permission_rule.response"),
  payload: MainChatAddPermissionRuleResponsePayloadSchema,
});
export type MainChatAddPermissionRuleResponse = z.infer<
  typeof MainChatAddPermissionRuleResponseSchema
>;

export const MainChatRemoveRuleRequestSchema = z.object({
  type: z.literal("main_chat.remove_rule.request"),
  requestId: z.string(),
  kind: MainChatRuleKindSchema,
  ruleId: z.string(),
});
export type MainChatRemoveRuleRequest = z.infer<typeof MainChatRemoveRuleRequestSchema>;

export const MainChatRemoveRuleResponsePayloadSchema = z.object({
  requestId: z.string(),
  removed: z.boolean(),
  error: z.string().nullable(),
});
export type MainChatRemoveRuleResponsePayload = z.infer<
  typeof MainChatRemoveRuleResponsePayloadSchema
>;

export const MainChatRemoveRuleResponseSchema = z.object({
  type: z.literal("main_chat.remove_rule.response"),
  payload: MainChatRemoveRuleResponsePayloadSchema,
});
export type MainChatRemoveRuleResponse = z.infer<typeof MainChatRemoveRuleResponseSchema>;

export const MainChatGetSettingsRequestSchema = z.object({
  type: z.literal("main_chat.get_settings.request"),
  requestId: z.string(),
});
export type MainChatGetSettingsRequest = z.infer<typeof MainChatGetSettingsRequestSchema>;

export const MainChatGetSettingsResponsePayloadSchema = z.object({
  requestId: z.string(),
  settings: MainChatSettingsSchema.nullable(),
  nightModeStatus: MainChatNightModeStatusSchema.optional(),
  cacheKeepaliveStatus: MainChatCacheKeepaliveStatusSchema.optional(),
  error: z.string().nullable(),
});
export type MainChatGetSettingsResponsePayload = z.infer<
  typeof MainChatGetSettingsResponsePayloadSchema
>;

export const MainChatGetSettingsResponseSchema = z.object({
  type: z.literal("main_chat.get_settings.response"),
  payload: MainChatGetSettingsResponsePayloadSchema,
});
export type MainChatGetSettingsResponse = z.infer<typeof MainChatGetSettingsResponseSchema>;

export const MainChatUpdateSettingsRequestSchema = z.object({
  type: z.literal("main_chat.update_settings.request"),
  requestId: z.string(),
  patch: MainChatSettingsPatchSchema,
});
export type MainChatUpdateSettingsRequest = z.infer<typeof MainChatUpdateSettingsRequestSchema>;

export const MainChatUpdateSettingsResponsePayloadSchema = z.object({
  requestId: z.string(),
  settings: MainChatSettingsSchema.nullable(),
  nightModeStatus: MainChatNightModeStatusSchema.optional(),
  cacheKeepaliveStatus: MainChatCacheKeepaliveStatusSchema.optional(),
  error: z.string().nullable(),
});
export type MainChatUpdateSettingsResponsePayload = z.infer<
  typeof MainChatUpdateSettingsResponsePayloadSchema
>;

export const MainChatUpdateSettingsResponseSchema = z.object({
  type: z.literal("main_chat.update_settings.response"),
  payload: MainChatUpdateSettingsResponsePayloadSchema,
});
export type MainChatUpdateSettingsResponse = z.infer<typeof MainChatUpdateSettingsResponseSchema>;

export const MainChatTriggerPatrolRequestSchema = z.object({
  type: z.literal("main_chat.trigger_patrol.request"),
  requestId: z.string(),
  mainAgentId: z.string().optional(),
  forceWakeup: z.boolean().optional(),
});
export type MainChatTriggerPatrolRequest = z.infer<typeof MainChatTriggerPatrolRequestSchema>;

export const MainChatTriggerPatrolResponsePayloadSchema = z.object({
  requestId: z.string(),
  result: MainChatPatrolResultSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatTriggerPatrolResponsePayload = z.infer<
  typeof MainChatTriggerPatrolResponsePayloadSchema
>;

export const MainChatTriggerPatrolResponseSchema = z.object({
  type: z.literal("main_chat.trigger_patrol.response"),
  payload: MainChatTriggerPatrolResponsePayloadSchema,
});
export type MainChatTriggerPatrolResponse = z.infer<typeof MainChatTriggerPatrolResponseSchema>;

export const MainChatCompactRequestSchema = z.object({
  type: z.literal("main_chat.compact.request"),
  requestId: z.string(),
  mainAgentId: z.string().optional(),
  reason: MainChatCompactionReasonSchema.optional(),
  instructions: z.string().optional(),
});
export type MainChatCompactRequest = z.infer<typeof MainChatCompactRequestSchema>;

export const MainChatCompactResponsePayloadSchema = z.object({
  requestId: z.string(),
  mainAgentId: z.string().nullable(),
  compaction: MainChatCompactionStateSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatCompactResponsePayload = z.infer<typeof MainChatCompactResponsePayloadSchema>;

export const MainChatCompactResponseSchema = z.object({
  type: z.literal("main_chat.compact.response"),
  payload: MainChatCompactResponsePayloadSchema,
});
export type MainChatCompactResponse = z.infer<typeof MainChatCompactResponseSchema>;

export const MainChatClearRequestSchema = z.object({
  type: z.literal("main_chat.clear.request"),
  requestId: z.string(),
  mainAgentId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});
export type MainChatClearRequest = z.infer<typeof MainChatClearRequestSchema>;

export const MainChatClearResponsePayloadSchema = z.object({
  requestId: z.string(),
  previousAgentId: z.string().nullable(),
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  migratedPlans: z.number().int().nonnegative(),
  migratedDecisions: z.number().int().nonnegative(),
  migratedChildAgents: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type MainChatClearResponsePayload = z.infer<typeof MainChatClearResponsePayloadSchema>;

export const MainChatClearResponseSchema = z.object({
  type: z.literal("main_chat.clear.response"),
  payload: MainChatClearResponsePayloadSchema,
});
export type MainChatClearResponse = z.infer<typeof MainChatClearResponseSchema>;

export const MainChatNewSessionRequestSchema = z.object({
  type: z.literal("main_chat.new_session.request"),
  requestId: z.string(),
  mainAgentId: z.string().optional(),
  carryHandoffSummary: z.boolean().optional(),
  title: z.string().min(1).max(40).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});
export type MainChatNewSessionRequest = z.infer<typeof MainChatNewSessionRequestSchema>;

export const MainChatNewSessionResponsePayloadSchema = z.object({
  requestId: z.string(),
  previousAgentId: z.string().nullable(),
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  handoffSummary: z.string().nullable(),
  migratedPlans: z.number().int().nonnegative(),
  migratedDecisions: z.number().int().nonnegative(),
  migratedChildAgents: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type MainChatNewSessionResponsePayload = z.infer<
  typeof MainChatNewSessionResponsePayloadSchema
>;

export const MainChatNewSessionResponseSchema = z.object({
  type: z.literal("main_chat.new_session.response"),
  payload: MainChatNewSessionResponsePayloadSchema,
});
export type MainChatNewSessionResponse = z.infer<typeof MainChatNewSessionResponseSchema>;

export const MainChatListActivityRequestSchema = z.object({
  type: z.literal("main_chat.list_activity.request"),
  requestId: z.string(),
  mainAgentId: z.string().optional(),
  limit: z.number().int().min(1).max(200).optional(),
  includeSilent: z.boolean().optional(),
  kind: MainChatActivityKindSchema.optional(),
});
export type MainChatListActivityRequest = z.infer<typeof MainChatListActivityRequestSchema>;

export const MainChatListActivityResponsePayloadSchema = z.object({
  requestId: z.string(),
  activities: z.array(MainChatActivityEntrySchema),
  total: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type MainChatListActivityResponsePayload = z.infer<
  typeof MainChatListActivityResponsePayloadSchema
>;

export const MainChatListActivityResponseSchema = z.object({
  type: z.literal("main_chat.list_activity.response"),
  payload: MainChatListActivityResponsePayloadSchema,
});
export type MainChatListActivityResponse = z.infer<typeof MainChatListActivityResponseSchema>;

// ============================================================================
// M3 Task Ledger & Inline Plan Edit RPC Schemas
// ============================================================================

export const MainChatUpdatePlanTaskRequestSchema = z.object({
  type: z.literal("main_chat.update_plan_task.request"),
  requestId: z.string(),
  planId: z.string(),
  taskId: z.string(),
  patch: MainChatPlanTaskPatchSchema,
});
export type MainChatUpdatePlanTaskRequest = z.infer<typeof MainChatUpdatePlanTaskRequestSchema>;

export const MainChatUpdatePlanTaskResponsePayloadSchema = z.object({
  requestId: z.string(),
  plan: MainChatPlanRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatUpdatePlanTaskResponsePayload = z.infer<
  typeof MainChatUpdatePlanTaskResponsePayloadSchema
>;

export const MainChatUpdatePlanTaskResponseSchema = z.object({
  type: z.literal("main_chat.update_plan_task.response"),
  payload: MainChatUpdatePlanTaskResponsePayloadSchema,
});
export type MainChatUpdatePlanTaskResponse = z.infer<typeof MainChatUpdatePlanTaskResponseSchema>;

export const MainChatWithdrawPlanRequestSchema = z.object({
  type: z.literal("main_chat.withdraw_plan.request"),
  requestId: z.string(),
  planId: z.string(),
  reason: z.string().min(1).max(500),
});
export type MainChatWithdrawPlanRequest = z.infer<typeof MainChatWithdrawPlanRequestSchema>;

export const MainChatWithdrawPlanResponsePayloadSchema = z.object({
  requestId: z.string(),
  plan: MainChatPlanRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatWithdrawPlanResponsePayload = z.infer<
  typeof MainChatWithdrawPlanResponsePayloadSchema
>;

export const MainChatWithdrawPlanResponseSchema = z.object({
  type: z.literal("main_chat.withdraw_plan.response"),
  payload: MainChatWithdrawPlanResponsePayloadSchema,
});
export type MainChatWithdrawPlanResponse = z.infer<typeof MainChatWithdrawPlanResponseSchema>;

export const MainChatListTasksRequestSchema = z.object({
  type: z.literal("main_chat.list_tasks.request"),
  requestId: z.string(),
  mainAgentId: z.string().optional(),
  conversationId: z.string().optional(),
  includeCompleted: z.boolean().optional(),
});
export type MainChatListTasksRequest = z.infer<typeof MainChatListTasksRequestSchema>;

export const MainChatListTasksResponsePayloadSchema = z.object({
  requestId: z.string(),
  tasks: z.array(MainChatTaskRecordSchema),
  error: z.string().nullable(),
});
export type MainChatListTasksResponsePayload = z.infer<
  typeof MainChatListTasksResponsePayloadSchema
>;

export const MainChatListTasksResponseSchema = z.object({
  type: z.literal("main_chat.list_tasks.response"),
  payload: MainChatListTasksResponsePayloadSchema,
});
export type MainChatListTasksResponse = z.infer<typeof MainChatListTasksResponseSchema>;

export const MainChatUpdateTaskScopeRequestSchema = z.object({
  type: z.literal("main_chat.update_task_scope.request"),
  requestId: z.string(),
  taskId: z.string(),
  goal: z.string().min(1).max(4000).optional(),
  doneWhen: z.array(z.string()).optional(),
  outOfBounds: z.array(z.string()).optional(),
  reason: z.string().max(500).optional(),
});
export type MainChatUpdateTaskScopeRequest = z.infer<typeof MainChatUpdateTaskScopeRequestSchema>;

export const MainChatUpdateTaskScopeResponsePayloadSchema = z.object({
  requestId: z.string(),
  task: MainChatTaskRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatUpdateTaskScopeResponsePayload = z.infer<
  typeof MainChatUpdateTaskScopeResponsePayloadSchema
>;

export const MainChatUpdateTaskScopeResponseSchema = z.object({
  type: z.literal("main_chat.update_task_scope.response"),
  payload: MainChatUpdateTaskScopeResponsePayloadSchema,
});
export type MainChatUpdateTaskScopeResponse = z.infer<typeof MainChatUpdateTaskScopeResponseSchema>;

export const MainChatParkTaskRequestSchema = z.object({
  type: z.literal("main_chat.park_task.request"),
  requestId: z.string(),
  taskId: z.string(),
  parked: z.boolean(),
  reason: z.string().max(500).optional(),
});
export type MainChatParkTaskRequest = z.infer<typeof MainChatParkTaskRequestSchema>;

export const MainChatParkTaskResponsePayloadSchema = z.object({
  requestId: z.string(),
  task: MainChatTaskRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatParkTaskResponsePayload = z.infer<typeof MainChatParkTaskResponsePayloadSchema>;

export const MainChatParkTaskResponseSchema = z.object({
  type: z.literal("main_chat.park_task.response"),
  payload: MainChatParkTaskResponsePayloadSchema,
});
export type MainChatParkTaskResponse = z.infer<typeof MainChatParkTaskResponseSchema>;

export const MainChatReviewTaskRequestSchema = z.object({
  type: z.literal("main_chat.review_task.request"),
  requestId: z.string(),
  taskId: z.string(),
  verdict: MainChatTaskReviewVerdictSchema,
  summary: z.string().max(4000).optional(),
  gaps: z.array(z.string()).optional(),
  checks: z.array(MainChatReceiptCheckSchema).optional(),
  nextSteps: z.array(z.string()).optional(),
  note: z.string().max(2000).optional(),
  bypassDeliveryGate: z.boolean().optional(),
  bypassReason: z.string().max(500).optional(),
});
export type MainChatReviewTaskRequest = z.infer<typeof MainChatReviewTaskRequestSchema>;

export const MainChatReviewTaskResponsePayloadSchema = z.object({
  requestId: z.string(),
  task: MainChatTaskRecordSchema.nullable(),
  receipt: MainChatTaskReceiptSchema.nullable(),
  rework: MainChatReworkRecordSchema.nullable(),
  deliveryGateWarning: z.string().nullable().optional(),
  error: z.string().nullable(),
});
export type MainChatReviewTaskResponsePayload = z.infer<
  typeof MainChatReviewTaskResponsePayloadSchema
>;

export const MainChatReviewTaskResponseSchema = z.object({
  type: z.literal("main_chat.review_task.response"),
  payload: MainChatReviewTaskResponsePayloadSchema,
});
export type MainChatReviewTaskResponse = z.infer<typeof MainChatReviewTaskResponseSchema>;

// ============================================================================
// M4 Multi-Conversation (Leader / Side) & Cross-Host Fleet RPC Schemas
// ============================================================================

export const MainChatListConversationsRequestSchema = z.object({
  type: z.literal("main_chat.list_conversations.request"),
  requestId: z.string(),
  includeArchived: z.boolean().optional(),
});
export type MainChatListConversationsRequest = z.infer<
  typeof MainChatListConversationsRequestSchema
>;

export const MainChatListConversationsResponsePayloadSchema = z.object({
  requestId: z.string(),
  conversations: z.array(MainChatConversationRecordSchema),
  error: z.string().nullable(),
});
export type MainChatListConversationsResponsePayload = z.infer<
  typeof MainChatListConversationsResponsePayloadSchema
>;

export const MainChatListConversationsResponseSchema = z.object({
  type: z.literal("main_chat.list_conversations.response"),
  payload: MainChatListConversationsResponsePayloadSchema,
});
export type MainChatListConversationsResponse = z.infer<
  typeof MainChatListConversationsResponseSchema
>;

export const MainChatCreateConversationRequestSchema = z.object({
  type: z.literal("main_chat.create_conversation.request"),
  requestId: z.string(),
  kind: z.enum(["side", "leader"]),
  title: z.string().min(1).max(80),
  directionSummary: z.string().max(1000).nullable().optional(),
  notes: z.string().max(MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS).nullable().optional(),
  initialPrompt: z.string().max(8000).optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});
export type MainChatCreateConversationRequest = z.infer<
  typeof MainChatCreateConversationRequestSchema
>;

export const MainChatCreateConversationResponsePayloadSchema = z.object({
  requestId: z.string(),
  conversation: MainChatConversationRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatCreateConversationResponsePayload = z.infer<
  typeof MainChatCreateConversationResponsePayloadSchema
>;

export const MainChatCreateConversationResponseSchema = z.object({
  type: z.literal("main_chat.create_conversation.response"),
  payload: MainChatCreateConversationResponsePayloadSchema,
});
export type MainChatCreateConversationResponse = z.infer<
  typeof MainChatCreateConversationResponseSchema
>;

export const MainChatUpdateConversationRequestSchema = z.object({
  type: z.literal("main_chat.update_conversation.request"),
  requestId: z.string(),
  conversationId: z.string(),
  title: z.string().min(1).max(80).optional(),
  directionSummary: z.string().max(1000).nullable().optional(),
  notes: z.string().max(MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS).nullable().optional(),
  kind: z.enum(["side", "leader"]).optional(),
  archived: z.boolean().optional(),
});
export type MainChatUpdateConversationRequest = z.infer<
  typeof MainChatUpdateConversationRequestSchema
>;

export const MainChatUpdateConversationResponsePayloadSchema = z.object({
  requestId: z.string(),
  conversation: MainChatConversationRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatUpdateConversationResponsePayload = z.infer<
  typeof MainChatUpdateConversationResponsePayloadSchema
>;

export const MainChatUpdateConversationResponseSchema = z.object({
  type: z.literal("main_chat.update_conversation.response"),
  payload: MainChatUpdateConversationResponsePayloadSchema,
});
export type MainChatUpdateConversationResponse = z.infer<
  typeof MainChatUpdateConversationResponseSchema
>;

export const MainChatGetFleetHostsRequestSchema = z.object({
  type: z.literal("main_chat.get_fleet_hosts.request"),
  requestId: z.string(),
  forceRefresh: z.boolean().optional(),
});
export type MainChatGetFleetHostsRequest = z.infer<typeof MainChatGetFleetHostsRequestSchema>;

export const MainChatGetFleetHostsResponsePayloadSchema = z.object({
  requestId: z.string(),
  localServerId: z.string().nullable(),
  hosts: z.array(MainChatFleetHostStatusSchema),
  fleetScope: MainChatFleetScopeSchema.optional(),
  availableRemoteHosts: z.array(MainChatFleetHostStatusSchema).optional(),
  error: z.string().nullable(),
});
export type MainChatGetFleetHostsResponsePayload = z.infer<
  typeof MainChatGetFleetHostsResponsePayloadSchema
>;

export const MainChatGetFleetHostsResponseSchema = z.object({
  type: z.literal("main_chat.get_fleet_hosts.response"),
  payload: MainChatGetFleetHostsResponsePayloadSchema,
});
export type MainChatGetFleetHostsResponse = z.infer<typeof MainChatGetFleetHostsResponseSchema>;

// ============================================================================
// M5 Approval Clarification & Standing Authorizations RPC Schemas
// ============================================================================

export const MainChatClarifyPermissionRequestSchema = z.object({
  type: z.literal("main_chat.clarify_permission.request"),
  requestId: z.string(),
  agentId: z.string(),
  serverId: z.string().nullable().optional(),
  permissionRequestId: z.string(),
  question: z.string().min(1).max(2000),
});
export type MainChatClarifyPermissionRequest = z.infer<
  typeof MainChatClarifyPermissionRequestSchema
>;

export const MainChatClarifyPermissionResponsePayloadSchema = z.object({
  requestId: z.string(),
  clarification: MainChatApprovalClarificationSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatClarifyPermissionResponsePayload = z.infer<
  typeof MainChatClarifyPermissionResponsePayloadSchema
>;

export const MainChatClarifyPermissionResponseSchema = z.object({
  type: z.literal("main_chat.clarify_permission.response"),
  payload: MainChatClarifyPermissionResponsePayloadSchema,
});
export type MainChatClarifyPermissionResponse = z.infer<
  typeof MainChatClarifyPermissionResponseSchema
>;

export const MainChatListStandingAuthorizationsRequestSchema = z.object({
  type: z.literal("main_chat.list_standing_authorizations.request"),
  requestId: z.string(),
  includeRevoked: z.boolean().optional(),
});
export type MainChatListStandingAuthorizationsRequest = z.infer<
  typeof MainChatListStandingAuthorizationsRequestSchema
>;

export const MainChatListStandingAuthorizationsResponsePayloadSchema = z.object({
  requestId: z.string(),
  authorizations: z.array(MainChatStandingAuthorizationSchema),
  suggestions: z.array(MainChatRuleSuggestionSchema),
  error: z.string().nullable(),
});
export type MainChatListStandingAuthorizationsResponsePayload = z.infer<
  typeof MainChatListStandingAuthorizationsResponsePayloadSchema
>;

export const MainChatListStandingAuthorizationsResponseSchema = z.object({
  type: z.literal("main_chat.list_standing_authorizations.response"),
  payload: MainChatListStandingAuthorizationsResponsePayloadSchema,
});
export type MainChatListStandingAuthorizationsResponse = z.infer<
  typeof MainChatListStandingAuthorizationsResponseSchema
>;

export const MainChatGrantStandingAuthorizationRequestSchema = z.object({
  type: z.literal("main_chat.grant_standing_authorization.request"),
  requestId: z.string(),
  scope: MainChatStandingAuthorizationScopeSchema,
  serverId: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
  allowSubdirectories: z.boolean().optional(),
  toolName: z.string().nullable().optional(),
  commandPrefix: z.string().nullable().optional(),
  mode: MainChatTaskModeSchema.nullable().optional(),
  label: z.string().min(1).max(160).optional(),
  reason: z.string().max(500).nullable().optional(),
  suggestionId: z.string().optional(),
  expiresAt: z.string().nullable().optional(),
});
export type MainChatGrantStandingAuthorizationRequest = z.infer<
  typeof MainChatGrantStandingAuthorizationRequestSchema
>;

export const MainChatGrantStandingAuthorizationResponsePayloadSchema = z.object({
  requestId: z.string(),
  authorization: MainChatStandingAuthorizationSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatGrantStandingAuthorizationResponsePayload = z.infer<
  typeof MainChatGrantStandingAuthorizationResponsePayloadSchema
>;

export const MainChatGrantStandingAuthorizationResponseSchema = z.object({
  type: z.literal("main_chat.grant_standing_authorization.response"),
  payload: MainChatGrantStandingAuthorizationResponsePayloadSchema,
});
export type MainChatGrantStandingAuthorizationResponse = z.infer<
  typeof MainChatGrantStandingAuthorizationResponseSchema
>;

export const MainChatRevokeStandingAuthorizationRequestSchema = z.object({
  type: z.literal("main_chat.revoke_standing_authorization.request"),
  requestId: z.string(),
  authorizationId: z.string(),
});
export type MainChatRevokeStandingAuthorizationRequest = z.infer<
  typeof MainChatRevokeStandingAuthorizationRequestSchema
>;

export const MainChatRevokeStandingAuthorizationResponsePayloadSchema = z.object({
  requestId: z.string(),
  revoked: z.boolean(),
  authorization: MainChatStandingAuthorizationSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatRevokeStandingAuthorizationResponsePayload = z.infer<
  typeof MainChatRevokeStandingAuthorizationResponsePayloadSchema
>;

export const MainChatRevokeStandingAuthorizationResponseSchema = z.object({
  type: z.literal("main_chat.revoke_standing_authorization.response"),
  payload: MainChatRevokeStandingAuthorizationResponsePayloadSchema,
});
export type MainChatRevokeStandingAuthorizationResponse = z.infer<
  typeof MainChatRevokeStandingAuthorizationResponseSchema
>;

export const MainChatDismissRuleSuggestionRequestSchema = z.object({
  type: z.literal("main_chat.dismiss_rule_suggestion.request"),
  requestId: z.string(),
  suggestionId: z.string(),
});
export type MainChatDismissRuleSuggestionRequest = z.infer<
  typeof MainChatDismissRuleSuggestionRequestSchema
>;

export const MainChatDismissRuleSuggestionResponsePayloadSchema = z.object({
  requestId: z.string(),
  dismissed: z.boolean(),
  error: z.string().nullable(),
});
export type MainChatDismissRuleSuggestionResponsePayload = z.infer<
  typeof MainChatDismissRuleSuggestionResponsePayloadSchema
>;

export const MainChatDismissRuleSuggestionResponseSchema = z.object({
  type: z.literal("main_chat.dismiss_rule_suggestion.response"),
  payload: MainChatDismissRuleSuggestionResponsePayloadSchema,
});
export type MainChatDismissRuleSuggestionResponse = z.infer<
  typeof MainChatDismissRuleSuggestionResponseSchema
>;

export const MainChatGetUsageRequestSchema = z.object({
  type: z.literal("main_chat.get_usage.request"),
  requestId: z.string(),
});
export type MainChatGetUsageRequest = z.infer<typeof MainChatGetUsageRequestSchema>;

export const MainChatGetUsageResponsePayloadSchema = z.object({
  requestId: z.string(),
  usage: MainChatTokenUsageSummarySchema.nullable(),
  nightModeStatus: MainChatNightModeStatusSchema.nullable().optional(),
  error: z.string().nullable(),
});
export type MainChatGetUsageResponsePayload = z.infer<typeof MainChatGetUsageResponsePayloadSchema>;

export const MainChatGetUsageResponseSchema = z.object({
  type: z.literal("main_chat.get_usage.response"),
  payload: MainChatGetUsageResponsePayloadSchema,
});
export type MainChatGetUsageResponse = z.infer<typeof MainChatGetUsageResponseSchema>;

export const MainChatResetUsageRequestSchema = z.object({
  type: z.literal("main_chat.reset_usage.request"),
  requestId: z.string(),
});
export type MainChatResetUsageRequest = z.infer<typeof MainChatResetUsageRequestSchema>;

export const MainChatResetUsageResponsePayloadSchema = z.object({
  requestId: z.string(),
  usage: MainChatTokenUsageSummarySchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatResetUsageResponsePayload = z.infer<
  typeof MainChatResetUsageResponsePayloadSchema
>;

export const MainChatResetUsageResponseSchema = z.object({
  type: z.literal("main_chat.reset_usage.response"),
  payload: MainChatResetUsageResponsePayloadSchema,
});
export type MainChatResetUsageResponse = z.infer<typeof MainChatResetUsageResponseSchema>;

// ============================================================================
// P0-1 Memory Files CRUD RPC Schemas
// ============================================================================

export const MainChatMemoryListRequestSchema = z.object({
  type: z.literal("main_chat.memory_list.request"),
  requestId: z.string(),
});
export type MainChatMemoryListRequest = z.infer<typeof MainChatMemoryListRequestSchema>;

export const MainChatMemoryListResponsePayloadSchema = z.object({
  requestId: z.string(),
  files: z.array(MainChatMemoryFileMetaSchema),
  error: z.string().nullable(),
});
export type MainChatMemoryListResponsePayload = z.infer<
  typeof MainChatMemoryListResponsePayloadSchema
>;

export const MainChatMemoryListResponseSchema = z.object({
  type: z.literal("main_chat.memory_list.response"),
  payload: MainChatMemoryListResponsePayloadSchema,
});
export type MainChatMemoryListResponse = z.infer<typeof MainChatMemoryListResponseSchema>;

export const MainChatMemoryReadRequestSchema = z.object({
  type: z.literal("main_chat.memory_read.request"),
  requestId: z.string(),
  path: z.string().min(1).max(MAIN_CHAT_MEMORY_PATH_MAX_CHARS),
});
export type MainChatMemoryReadRequest = z.infer<typeof MainChatMemoryReadRequestSchema>;

export const MainChatMemoryReadResponsePayloadSchema = z.object({
  requestId: z.string(),
  file: MainChatMemoryFileContentSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatMemoryReadResponsePayload = z.infer<
  typeof MainChatMemoryReadResponsePayloadSchema
>;

export const MainChatMemoryReadResponseSchema = z.object({
  type: z.literal("main_chat.memory_read.response"),
  payload: MainChatMemoryReadResponsePayloadSchema,
});
export type MainChatMemoryReadResponse = z.infer<typeof MainChatMemoryReadResponseSchema>;

export const MainChatMemoryWriteRequestSchema = z.object({
  type: z.literal("main_chat.memory_write.request"),
  requestId: z.string(),
  path: z.string().min(1).max(MAIN_CHAT_MEMORY_PATH_MAX_CHARS),
  content: z.string(),
});
export type MainChatMemoryWriteRequest = z.infer<typeof MainChatMemoryWriteRequestSchema>;

export const MainChatMemoryWriteResponsePayloadSchema = z.object({
  requestId: z.string(),
  file: MainChatMemoryFileMetaSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatMemoryWriteResponsePayload = z.infer<
  typeof MainChatMemoryWriteResponsePayloadSchema
>;

export const MainChatMemoryWriteResponseSchema = z.object({
  type: z.literal("main_chat.memory_write.response"),
  payload: MainChatMemoryWriteResponsePayloadSchema,
});
export type MainChatMemoryWriteResponse = z.infer<typeof MainChatMemoryWriteResponseSchema>;

export const MainChatMemoryDeleteRequestSchema = z.object({
  type: z.literal("main_chat.memory_delete.request"),
  requestId: z.string(),
  path: z.string().min(1).max(MAIN_CHAT_MEMORY_PATH_MAX_CHARS),
});
export type MainChatMemoryDeleteRequest = z.infer<typeof MainChatMemoryDeleteRequestSchema>;

export const MainChatMemoryDeleteResponsePayloadSchema = z.object({
  requestId: z.string(),
  deleted: z.boolean(),
  error: z.string().nullable(),
});
export type MainChatMemoryDeleteResponsePayload = z.infer<
  typeof MainChatMemoryDeleteResponsePayloadSchema
>;

export const MainChatMemoryDeleteResponseSchema = z.object({
  type: z.literal("main_chat.memory_delete.response"),
  payload: MainChatMemoryDeleteResponsePayloadSchema,
});
export type MainChatMemoryDeleteResponse = z.infer<typeof MainChatMemoryDeleteResponseSchema>;

// ============================================================================
// P0-4 Routines (Schedule / Heartbeat Integration) RPC Schemas
// ============================================================================

export const MainChatRoutinesListRequestSchema = z.object({
  type: z.literal("main_chat.routines_list.request"),
  requestId: z.string(),
  conversationId: z.string().optional(),
  includeCompleted: z.boolean().optional(),
});
export type MainChatRoutinesListRequest = z.infer<typeof MainChatRoutinesListRequestSchema>;

export const MainChatRoutinesListResponsePayloadSchema = z.object({
  requestId: z.string(),
  routines: z.array(MainChatRoutineRecordSchema),
  error: z.string().nullable(),
});
export type MainChatRoutinesListResponsePayload = z.infer<
  typeof MainChatRoutinesListResponsePayloadSchema
>;

export const MainChatRoutinesListResponseSchema = z.object({
  type: z.literal("main_chat.routines_list.response"),
  payload: MainChatRoutinesListResponsePayloadSchema,
});
export type MainChatRoutinesListResponse = z.infer<typeof MainChatRoutinesListResponseSchema>;

export const MainChatRoutinesCreateRequestSchema = z.object({
  type: z.literal("main_chat.routines_create.request"),
  requestId: z.string(),
  name: z.string().trim().min(1).max(80).optional(),
  prompt: z.string().trim().min(1),
  kind: MainChatRoutineKindSchema.optional(),
  cadence: ScheduleCadenceSchema.optional(),
  runAt: z.string().trim().min(1).optional(),
  delayMinutes: z.number().int().positive().max(43_200).optional(),
  conversationId: z.string().trim().min(1).optional(),
  maxRuns: z.number().int().positive().nullable().optional(),
  expiresAt: z.string().nullable().optional(),
  runOnCreate: z.boolean().optional(),
});
export type MainChatRoutinesCreateRequest = z.infer<typeof MainChatRoutinesCreateRequestSchema>;

export const MainChatRoutinesCreateResponsePayloadSchema = z.object({
  requestId: z.string(),
  routine: MainChatRoutineRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatRoutinesCreateResponsePayload = z.infer<
  typeof MainChatRoutinesCreateResponsePayloadSchema
>;

export const MainChatRoutinesCreateResponseSchema = z.object({
  type: z.literal("main_chat.routines_create.response"),
  payload: MainChatRoutinesCreateResponsePayloadSchema,
});
export type MainChatRoutinesCreateResponse = z.infer<typeof MainChatRoutinesCreateResponseSchema>;

export const MainChatRoutinesPauseRequestSchema = z.object({
  type: z.literal("main_chat.routines_pause.request"),
  requestId: z.string(),
  routineId: z.string().min(1),
});
export type MainChatRoutinesPauseRequest = z.infer<typeof MainChatRoutinesPauseRequestSchema>;

export const MainChatRoutinesPauseResponsePayloadSchema = z.object({
  requestId: z.string(),
  routine: MainChatRoutineRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatRoutinesPauseResponsePayload = z.infer<
  typeof MainChatRoutinesPauseResponsePayloadSchema
>;

export const MainChatRoutinesPauseResponseSchema = z.object({
  type: z.literal("main_chat.routines_pause.response"),
  payload: MainChatRoutinesPauseResponsePayloadSchema,
});
export type MainChatRoutinesPauseResponse = z.infer<typeof MainChatRoutinesPauseResponseSchema>;

export const MainChatRoutinesResumeRequestSchema = z.object({
  type: z.literal("main_chat.routines_resume.request"),
  requestId: z.string(),
  routineId: z.string().min(1),
});
export type MainChatRoutinesResumeRequest = z.infer<typeof MainChatRoutinesResumeRequestSchema>;

export const MainChatRoutinesResumeResponsePayloadSchema = z.object({
  requestId: z.string(),
  routine: MainChatRoutineRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatRoutinesResumeResponsePayload = z.infer<
  typeof MainChatRoutinesResumeResponsePayloadSchema
>;

export const MainChatRoutinesResumeResponseSchema = z.object({
  type: z.literal("main_chat.routines_resume.response"),
  payload: MainChatRoutinesResumeResponsePayloadSchema,
});
export type MainChatRoutinesResumeResponse = z.infer<typeof MainChatRoutinesResumeResponseSchema>;

export const MainChatRoutinesRunOnceRequestSchema = z.object({
  type: z.literal("main_chat.routines_run_once.request"),
  requestId: z.string(),
  routineId: z.string().min(1),
});
export type MainChatRoutinesRunOnceRequest = z.infer<typeof MainChatRoutinesRunOnceRequestSchema>;

export const MainChatRoutinesRunOnceResponsePayloadSchema = z.object({
  requestId: z.string(),
  routine: MainChatRoutineRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatRoutinesRunOnceResponsePayload = z.infer<
  typeof MainChatRoutinesRunOnceResponsePayloadSchema
>;

export const MainChatRoutinesRunOnceResponseSchema = z.object({
  type: z.literal("main_chat.routines_run_once.response"),
  payload: MainChatRoutinesRunOnceResponsePayloadSchema,
});
export type MainChatRoutinesRunOnceResponse = z.infer<typeof MainChatRoutinesRunOnceResponseSchema>;

export const MainChatRoutinesDeleteRequestSchema = z.object({
  type: z.literal("main_chat.routines_delete.request"),
  requestId: z.string(),
  routineId: z.string().min(1),
});
export type MainChatRoutinesDeleteRequest = z.infer<typeof MainChatRoutinesDeleteRequestSchema>;

export const MainChatRoutinesDeleteResponsePayloadSchema = z.object({
  requestId: z.string(),
  routineId: z.string(),
  deleted: z.boolean(),
  error: z.string().nullable(),
});
export type MainChatRoutinesDeleteResponsePayload = z.infer<
  typeof MainChatRoutinesDeleteResponsePayloadSchema
>;

export const MainChatRoutinesDeleteResponseSchema = z.object({
  type: z.literal("main_chat.routines_delete.response"),
  payload: MainChatRoutinesDeleteResponsePayloadSchema,
});
export type MainChatRoutinesDeleteResponse = z.infer<typeof MainChatRoutinesDeleteResponseSchema>;

// ============================================================================
// P0-5 Self-Service Settings Proposal Approval RPC Schemas
// ============================================================================

export const MainChatListSettingsProposalsRequestSchema = z.object({
  type: z.literal("main_chat.list_settings_proposals.request"),
  requestId: z.string(),
  mainAgentId: z.string().optional(),
  includeResolved: z.boolean().optional(),
});
export type MainChatListSettingsProposalsRequest = z.infer<
  typeof MainChatListSettingsProposalsRequestSchema
>;

export const MainChatListSettingsProposalsResponsePayloadSchema = z.object({
  requestId: z.string(),
  proposals: z.array(MainChatSettingsProposalRecordSchema),
  error: z.string().nullable(),
});
export type MainChatListSettingsProposalsResponsePayload = z.infer<
  typeof MainChatListSettingsProposalsResponsePayloadSchema
>;

export const MainChatListSettingsProposalsResponseSchema = z.object({
  type: z.literal("main_chat.list_settings_proposals.response"),
  payload: MainChatListSettingsProposalsResponsePayloadSchema,
});
export type MainChatListSettingsProposalsResponse = z.infer<
  typeof MainChatListSettingsProposalsResponseSchema
>;

export const MainChatResolveSettingsProposalRequestSchema = z.object({
  type: z.literal("main_chat.resolve_settings_proposal.request"),
  requestId: z.string(),
  proposalId: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
  note: z.string().max(400).optional(),
});
export type MainChatResolveSettingsProposalRequest = z.infer<
  typeof MainChatResolveSettingsProposalRequestSchema
>;

export const MainChatResolveSettingsProposalResponsePayloadSchema = z.object({
  requestId: z.string(),
  proposal: MainChatSettingsProposalRecordSchema.nullable(),
  settings: MainChatSettingsSchema.nullable(),
  nightModeStatus: MainChatNightModeStatusSchema.optional(),
  cacheKeepaliveStatus: MainChatCacheKeepaliveStatusSchema.optional(),
  error: z.string().nullable(),
});
export type MainChatResolveSettingsProposalResponsePayload = z.infer<
  typeof MainChatResolveSettingsProposalResponsePayloadSchema
>;

export const MainChatResolveSettingsProposalResponseSchema = z.object({
  type: z.literal("main_chat.resolve_settings_proposal.response"),
  payload: MainChatResolveSettingsProposalResponsePayloadSchema,
});
export type MainChatResolveSettingsProposalResponse = z.infer<
  typeof MainChatResolveSettingsProposalResponseSchema
>;

// ============================================================================
// P1-1 Project Lessons CRUD RPC Schemas
// ============================================================================

export const MainChatLessonsListRequestSchema = z.object({
  type: z.literal("main_chat.lessons_list.request"),
  requestId: z.string(),
  projectKey: z.string().max(MAIN_CHAT_LESSON_PROJECT_KEY_MAX_CHARS).optional(),
});
export type MainChatLessonsListRequest = z.infer<typeof MainChatLessonsListRequestSchema>;

export const MainChatLessonsListResponsePayloadSchema = z.object({
  requestId: z.string(),
  groups: z.array(MainChatProjectLessonGroupSchema),
  lessons: z.array(MainChatProjectLessonSchema),
  error: z.string().nullable(),
});
export type MainChatLessonsListResponsePayload = z.infer<
  typeof MainChatLessonsListResponsePayloadSchema
>;

export const MainChatLessonsListResponseSchema = z.object({
  type: z.literal("main_chat.lessons_list.response"),
  payload: MainChatLessonsListResponsePayloadSchema,
});
export type MainChatLessonsListResponse = z.infer<typeof MainChatLessonsListResponseSchema>;

export const MainChatLessonsAddRequestSchema = z.object({
  type: z.literal("main_chat.lessons_add.request"),
  requestId: z.string(),
  projectKey: z.string().min(1).max(MAIN_CHAT_LESSON_PROJECT_KEY_MAX_CHARS),
  projectLabel: z.string().max(MAIN_CHAT_LESSON_PROJECT_LABEL_MAX_CHARS).optional(),
  kind: MainChatLessonKindSchema,
  text: z.string().min(1).max(MAIN_CHAT_LESSON_TEXT_MAX_CHARS),
  taskId: z.string().optional(),
});
export type MainChatLessonsAddRequest = z.infer<typeof MainChatLessonsAddRequestSchema>;

export const MainChatLessonsAddResponsePayloadSchema = z.object({
  requestId: z.string(),
  lesson: MainChatProjectLessonSchema.nullable(),
  deduplicated: z.boolean(),
  error: z.string().nullable(),
});
export type MainChatLessonsAddResponsePayload = z.infer<
  typeof MainChatLessonsAddResponsePayloadSchema
>;

export const MainChatLessonsAddResponseSchema = z.object({
  type: z.literal("main_chat.lessons_add.response"),
  payload: MainChatLessonsAddResponsePayloadSchema,
});
export type MainChatLessonsAddResponse = z.infer<typeof MainChatLessonsAddResponseSchema>;

export const MainChatLessonsDeleteRequestSchema = z.object({
  type: z.literal("main_chat.lessons_delete.request"),
  requestId: z.string(),
  lessonId: z.string().min(1),
});
export type MainChatLessonsDeleteRequest = z.infer<typeof MainChatLessonsDeleteRequestSchema>;

export const MainChatLessonsDeleteResponsePayloadSchema = z.object({
  requestId: z.string(),
  lessonId: z.string(),
  deleted: z.boolean(),
  error: z.string().nullable(),
});
export type MainChatLessonsDeleteResponsePayload = z.infer<
  typeof MainChatLessonsDeleteResponsePayloadSchema
>;

export const MainChatLessonsDeleteResponseSchema = z.object({
  type: z.literal("main_chat.lessons_delete.response"),
  payload: MainChatLessonsDeleteResponsePayloadSchema,
});
export type MainChatLessonsDeleteResponse = z.infer<typeof MainChatLessonsDeleteResponseSchema>;

// ============================================================================
// P1-3 Task DAG Dependencies & Start Ready Task RPC Schemas
// ============================================================================

export const MainChatStartReadyTaskRequestSchema = z.object({
  type: z.literal("main_chat.start_ready_task.request"),
  requestId: z.string(),
  taskId: z.string().min(1),
});
export type MainChatStartReadyTaskRequest = z.infer<typeof MainChatStartReadyTaskRequestSchema>;

export const MainChatStartReadyTaskResponsePayloadSchema = z.object({
  requestId: z.string(),
  task: MainChatTaskRecordSchema.nullable(),
  plan: MainChatPlanRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatStartReadyTaskResponsePayload = z.infer<
  typeof MainChatStartReadyTaskResponsePayloadSchema
>;

export const MainChatStartReadyTaskResponseSchema = z.object({
  type: z.literal("main_chat.start_ready_task.response"),
  payload: MainChatStartReadyTaskResponsePayloadSchema,
});
export type MainChatStartReadyTaskResponse = z.infer<typeof MainChatStartReadyTaskResponseSchema>;

export const MainChatUpdateTaskDependenciesRequestSchema = z.object({
  type: z.literal("main_chat.update_task_dependencies.request"),
  requestId: z.string(),
  taskId: z.string().min(1),
  partOf: z.string().nullable().optional(),
  after: z.array(z.string()).optional(),
  autoStartOnReady: z.boolean().optional(),
});
export type MainChatUpdateTaskDependenciesRequest = z.infer<
  typeof MainChatUpdateTaskDependenciesRequestSchema
>;

export const MainChatUpdateTaskDependenciesResponsePayloadSchema = z.object({
  requestId: z.string(),
  task: MainChatTaskRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatUpdateTaskDependenciesResponsePayload = z.infer<
  typeof MainChatUpdateTaskDependenciesResponsePayloadSchema
>;

export const MainChatUpdateTaskDependenciesResponseSchema = z.object({
  type: z.literal("main_chat.update_task_dependencies.response"),
  payload: MainChatUpdateTaskDependenciesResponsePayloadSchema,
});
export type MainChatUpdateTaskDependenciesResponse = z.infer<
  typeof MainChatUpdateTaskDependenciesResponseSchema
>;

// ============================================================================
// P1-4 Model Profile Atomic Switch & Failed Task Retry-With-Fallback RPC Schemas
// ============================================================================

export const MainChatSwitchModelProfileRequestSchema = z.object({
  type: z.literal("main_chat.switch_model_profile.request"),
  requestId: z.string(),
  profileId: z.string().trim().min(1).max(48).optional(),
  rollback: z.boolean().optional(),
});
export type MainChatSwitchModelProfileRequest = z.infer<
  typeof MainChatSwitchModelProfileRequestSchema
>;

export const MainChatSwitchModelProfileResponsePayloadSchema = z.object({
  requestId: z.string(),
  settings: MainChatSettingsSchema.nullable(),
  activeProfileId: z.string().nullable(),
  changedSlots: z.array(MainChatModelPurposeSchema),
  event: MainChatModelProfileSwitchEventSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatSwitchModelProfileResponsePayload = z.infer<
  typeof MainChatSwitchModelProfileResponsePayloadSchema
>;

export const MainChatSwitchModelProfileResponseSchema = z.object({
  type: z.literal("main_chat.switch_model_profile.response"),
  payload: MainChatSwitchModelProfileResponsePayloadSchema,
});
export type MainChatSwitchModelProfileResponse = z.infer<
  typeof MainChatSwitchModelProfileResponseSchema
>;

export const MainChatRetryTaskWithFallbackRequestSchema = z.object({
  type: z.literal("main_chat.retry_task_with_fallback.request"),
  requestId: z.string(),
  taskId: z.string().min(1),
  provider: z.string().trim().min(1).max(64).optional(),
  model: z.string().trim().min(1).max(120).nullable().optional(),
  thinkingOptionId: z.string().trim().min(1).max(64).nullable().optional(),
  reason: z.string().trim().max(300).optional(),
});
export type MainChatRetryTaskWithFallbackRequest = z.infer<
  typeof MainChatRetryTaskWithFallbackRequestSchema
>;

export const MainChatRetryTaskWithFallbackResponsePayloadSchema = z.object({
  requestId: z.string(),
  task: MainChatTaskRecordSchema.nullable(),
  previousAgentId: z.string().nullable(),
  newAgentId: z.string().nullable(),
  fromModelSpec: z.string().nullable(),
  toModelSpec: z.string().nullable(),
  fallbackEvent: MainChatLimitFallbackEventSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatRetryTaskWithFallbackResponsePayload = z.infer<
  typeof MainChatRetryTaskWithFallbackResponsePayloadSchema
>;

export const MainChatRetryTaskWithFallbackResponseSchema = z.object({
  type: z.literal("main_chat.retry_task_with_fallback.response"),
  payload: MainChatRetryTaskWithFallbackResponsePayloadSchema,
});
export type MainChatRetryTaskWithFallbackResponse = z.infer<
  typeof MainChatRetryTaskWithFallbackResponseSchema
>;

// ============================================================================
// P1-5 Notification Delivery Receipts RPC Schemas
// ============================================================================

export const MainChatListNotificationReceiptsRequestSchema = z.object({
  type: z.literal("main_chat.list_notification_receipts.request"),
  requestId: z.string(),
  status: MainChatNotificationDeliveryStatusSchema.optional(),
  category: MainChatNotificationCategorySchema.optional(),
  unreadOnly: z.boolean().optional(),
  limit: z.number().int().positive().max(MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS).optional(),
});
export type MainChatListNotificationReceiptsRequest = z.infer<
  typeof MainChatListNotificationReceiptsRequestSchema
>;

export const MainChatListNotificationReceiptsResponsePayloadSchema = z.object({
  requestId: z.string(),
  receipts: z.array(MainChatNotificationReceiptSchema),
  summary: MainChatNotificationSummarySchema,
  error: z.string().nullable(),
});
export type MainChatListNotificationReceiptsResponsePayload = z.infer<
  typeof MainChatListNotificationReceiptsResponsePayloadSchema
>;

export const MainChatListNotificationReceiptsResponseSchema = z.object({
  type: z.literal("main_chat.list_notification_receipts.response"),
  payload: MainChatListNotificationReceiptsResponsePayloadSchema,
});
export type MainChatListNotificationReceiptsResponse = z.infer<
  typeof MainChatListNotificationReceiptsResponseSchema
>;

export const MainChatAckNotificationReceiptRequestSchema = z.object({
  type: z.literal("main_chat.ack_notification_receipt.request"),
  requestId: z.string(),
  receiptId: z.string().min(1).optional(),
  receiptIds: z.array(z.string().min(1)).max(MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS).optional(),
  markAll: z.boolean().optional(),
  status: z.enum(["acknowledged", "read"]).optional(),
});
export type MainChatAckNotificationReceiptRequest = z.infer<
  typeof MainChatAckNotificationReceiptRequestSchema
>;

export const MainChatAckNotificationReceiptResponsePayloadSchema = z.object({
  requestId: z.string(),
  updatedCount: z.number().int().nonnegative(),
  receipts: z.array(MainChatNotificationReceiptSchema),
  summary: MainChatNotificationSummarySchema,
  error: z.string().nullable(),
});
export type MainChatAckNotificationReceiptResponsePayload = z.infer<
  typeof MainChatAckNotificationReceiptResponsePayloadSchema
>;

export const MainChatAckNotificationReceiptResponseSchema = z.object({
  type: z.literal("main_chat.ack_notification_receipt.response"),
  payload: MainChatAckNotificationReceiptResponsePayloadSchema,
});
export type MainChatAckNotificationReceiptResponse = z.infer<
  typeof MainChatAckNotificationReceiptResponseSchema
>;

// ============================================================================
// P2-2 Cross-Host Resource Admission RPC Schemas
// ============================================================================

export const MainChatGetResourceAdmissionRequestSchema = z.object({
  type: z.literal("main_chat.get_resource_admission.request"),
  requestId: z.string(),
  forceRefresh: z.boolean().optional(),
});
export type MainChatGetResourceAdmissionRequest = z.infer<
  typeof MainChatGetResourceAdmissionRequestSchema
>;

export const MainChatGetResourceAdmissionResponsePayloadSchema = z.object({
  requestId: z.string(),
  snapshot: MainChatResourceAdmissionSnapshotSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatGetResourceAdmissionResponsePayload = z.infer<
  typeof MainChatGetResourceAdmissionResponsePayloadSchema
>;

export const MainChatGetResourceAdmissionResponseSchema = z.object({
  type: z.literal("main_chat.get_resource_admission.response"),
  payload: MainChatGetResourceAdmissionResponsePayloadSchema,
});
export type MainChatGetResourceAdmissionResponse = z.infer<
  typeof MainChatGetResourceAdmissionResponseSchema
>;

export const MainChatDrainAdmissionQueueRequestSchema = z.object({
  type: z.literal("main_chat.drain_admission_queue.request"),
  requestId: z.string(),
  action: MainChatDrainAdmissionActionSchema.optional(),
  queueId: z.string().min(1).optional(),
  serverId: z.string().min(1).optional(),
});
export type MainChatDrainAdmissionQueueRequest = z.infer<
  typeof MainChatDrainAdmissionQueueRequestSchema
>;

export const MainChatDrainAdmissionQueueResponsePayloadSchema = z.object({
  requestId: z.string(),
  action: MainChatDrainAdmissionActionSchema,
  dispatchedCount: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative(),
  remainingCount: z.number().int().nonnegative(),
  snapshot: MainChatResourceAdmissionSnapshotSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatDrainAdmissionQueueResponsePayload = z.infer<
  typeof MainChatDrainAdmissionQueueResponsePayloadSchema
>;

export const MainChatDrainAdmissionQueueResponseSchema = z.object({
  type: z.literal("main_chat.drain_admission_queue.response"),
  payload: MainChatDrainAdmissionQueueResponsePayloadSchema,
});
export type MainChatDrainAdmissionQueueResponse = z.infer<
  typeof MainChatDrainAdmissionQueueResponseSchema
>;

// ============================================================================
// P2-4 Idle Subagent Auto-Archive & Prompt Library RPC Schemas
// ============================================================================

export const MainChatSweepIdleSubagentsRequestSchema = z.object({
  type: z.literal("main_chat.sweep_idle_subagents.request"),
  requestId: z.string(),
  dryRun: z.boolean().optional(),
  idleThresholdMinutes: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_IDLE_ARCHIVE_THRESHOLD_MIN)
    .max(MAIN_CHAT_MAX_IDLE_ARCHIVE_THRESHOLD_MIN)
    .optional(),
  limit: z
    .number()
    .int()
    .min(MAIN_CHAT_MIN_IDLE_ARCHIVE_MAX_PER_SWEEP)
    .max(MAIN_CHAT_MAX_IDLE_ARCHIVE_MAX_PER_SWEEP)
    .optional(),
});
export type MainChatSweepIdleSubagentsRequest = z.infer<
  typeof MainChatSweepIdleSubagentsRequestSchema
>;

export const MainChatSweepIdleSubagentsResponsePayloadSchema = z.object({
  requestId: z.string(),
  result: MainChatIdleArchiveSweepResultSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatSweepIdleSubagentsResponsePayload = z.infer<
  typeof MainChatSweepIdleSubagentsResponsePayloadSchema
>;

export const MainChatSweepIdleSubagentsResponseSchema = z.object({
  type: z.literal("main_chat.sweep_idle_subagents.response"),
  payload: MainChatSweepIdleSubagentsResponsePayloadSchema,
});
export type MainChatSweepIdleSubagentsResponse = z.infer<
  typeof MainChatSweepIdleSubagentsResponseSchema
>;

export const MainChatListPromptLibraryRequestSchema = z.object({
  type: z.literal("main_chat.list_prompt_library.request"),
  requestId: z.string(),
});
export type MainChatListPromptLibraryRequest = z.infer<
  typeof MainChatListPromptLibraryRequestSchema
>;

export const MainChatListPromptLibraryResponsePayloadSchema = z.object({
  requestId: z.string(),
  templates: z.array(MainChatPromptTemplateSchema),
  builtinCount: z.number().int().nonnegative(),
  customCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
});
export type MainChatListPromptLibraryResponsePayload = z.infer<
  typeof MainChatListPromptLibraryResponsePayloadSchema
>;

export const MainChatListPromptLibraryResponseSchema = z.object({
  type: z.literal("main_chat.list_prompt_library.response"),
  payload: MainChatListPromptLibraryResponsePayloadSchema,
});
export type MainChatListPromptLibraryResponse = z.infer<
  typeof MainChatListPromptLibraryResponseSchema
>;

export const MainChatSavePromptTemplateRequestSchema = z.object({
  type: z.literal("main_chat.save_prompt_template.request"),
  requestId: z.string(),
  template: MainChatPromptTemplateInputSchema,
});
export type MainChatSavePromptTemplateRequest = z.infer<
  typeof MainChatSavePromptTemplateRequestSchema
>;

export const MainChatSavePromptTemplateResponsePayloadSchema = z.object({
  requestId: z.string(),
  template: MainChatPromptTemplateSchema.nullable(),
  templates: z.array(MainChatPromptTemplateSchema),
  error: z.string().nullable(),
});
export type MainChatSavePromptTemplateResponsePayload = z.infer<
  typeof MainChatSavePromptTemplateResponsePayloadSchema
>;

export const MainChatSavePromptTemplateResponseSchema = z.object({
  type: z.literal("main_chat.save_prompt_template.response"),
  payload: MainChatSavePromptTemplateResponsePayloadSchema,
});
export type MainChatSavePromptTemplateResponse = z.infer<
  typeof MainChatSavePromptTemplateResponseSchema
>;

export const MainChatDeletePromptTemplateRequestSchema = z.object({
  type: z.literal("main_chat.delete_prompt_template.request"),
  requestId: z.string(),
  id: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
});
export type MainChatDeletePromptTemplateRequest = z.infer<
  typeof MainChatDeletePromptTemplateRequestSchema
>;

export const MainChatDeletePromptTemplateResponsePayloadSchema = z.object({
  requestId: z.string(),
  deleted: z.boolean(),
  templates: z.array(MainChatPromptTemplateSchema),
  error: z.string().nullable(),
});
export type MainChatDeletePromptTemplateResponsePayload = z.infer<
  typeof MainChatDeletePromptTemplateResponsePayloadSchema
>;

export const MainChatDeletePromptTemplateResponseSchema = z.object({
  type: z.literal("main_chat.delete_prompt_template.response"),
  payload: MainChatDeletePromptTemplateResponsePayloadSchema,
});
export type MainChatDeletePromptTemplateResponse = z.infer<
  typeof MainChatDeletePromptTemplateResponseSchema
>;

export interface MainChatTaskLabelsMeta {
  planId: string | null;
  taskId: string | null;
  mode: MainChatTaskMode | null;
  goal: string | null;
}

export function isMainChatLabels(labels: Record<string, unknown> | null | undefined): boolean {
  return labels?.[MAIN_CHAT_ROLE_LABEL] === MAIN_CHAT_ROLE_VALUE;
}

export function isFormerMainChatLabels(
  labels: Record<string, unknown> | null | undefined,
): boolean {
  return labels?.[MAIN_CHAT_ROLE_LABEL] === MAIN_CHAT_FORMER_ROLE_VALUE;
}

export function isMainChatAgent(agent: AgentLabelSource | null | undefined): boolean {
  return Boolean(agent && isMainChatLabels(agent.labels));
}

export function isMainChatTaskQuietLabels(
  labels: Record<string, unknown> | null | undefined,
): boolean {
  return labels?.[MAIN_CHAT_TASK_QUIET_LABEL] === "true";
}

export function getMainChatBackgroundTurnMetadata(
  metadata: Record<string, unknown> | null | undefined,
): MainChatBackgroundTurnMetadata | null {
  if (!metadata || typeof metadata !== "object") return null;
  const raw = metadata.mainChatBackground;
  if (!raw || typeof raw !== "object") return null;
  const parsed = MainChatBackgroundTurnMetadataSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * Matches the dedicated main-chat workspace directory (`<paseoHome>/main-chat`),
 * e.g. `/home/user/.paseo/main-chat` or `.dev/paseo-home/main-chat`.
 */
export function isMainChatWorkspaceDirectory(dirPath: string | null | undefined): boolean {
  if (!dirPath) return false;
  const normalized = dirPath.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized.endsWith(`/${MAIN_CHAT_WORKSPACE_DIR_NAME}`)) return false;
  const parent = normalized.slice(0, -(MAIN_CHAT_WORKSPACE_DIR_NAME.length + 1));
  const parentBase = parent.slice(parent.lastIndexOf("/") + 1).toLowerCase();
  return parentBase === ".paseo" || parentBase === "paseo-home" || parentBase.includes("paseo");
}

export function getMainChatTaskMetaFromLabels(
  labels: Record<string, unknown> | null | undefined,
): MainChatTaskLabelsMeta | null {
  if (!labels) return null;
  const planId =
    typeof labels[MAIN_CHAT_TASK_PLAN_ID_LABEL] === "string" &&
    labels[MAIN_CHAT_TASK_PLAN_ID_LABEL].trim().length > 0
      ? labels[MAIN_CHAT_TASK_PLAN_ID_LABEL].trim()
      : null;
  const taskId =
    typeof labels[MAIN_CHAT_TASK_ID_LABEL] === "string" &&
    labels[MAIN_CHAT_TASK_ID_LABEL].trim().length > 0
      ? labels[MAIN_CHAT_TASK_ID_LABEL].trim()
      : null;
  const rawMode = labels[MAIN_CHAT_TASK_MODE_LABEL];
  const mode: MainChatTaskMode | null =
    rawMode === "readonly" || rawMode === "write" ? rawMode : null;
  const goal =
    typeof labels[MAIN_CHAT_TASK_GOAL_LABEL] === "string" &&
    labels[MAIN_CHAT_TASK_GOAL_LABEL].trim().length > 0
      ? labels[MAIN_CHAT_TASK_GOAL_LABEL].trim()
      : null;
  if (!planId && !taskId && !mode && !goal) return null;
  return { planId, taskId, mode, goal };
}

export function normalizeMainChatToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const mcpSeparator = normalized.lastIndexOf("__");
  return mcpSeparator >= 0 ? normalized.slice(mcpSeparator + 2) : normalized;
}

export function isTaskPlanToolName(name: string): boolean {
  return normalizeMainChatToolName(name) === "task_plan";
}

export function isTaskCompleteToolName(name: string): boolean {
  return normalizeMainChatToolName(name) === "task_complete";
}

export function isTaskReworkToolName(name: string): boolean {
  return normalizeMainChatToolName(name) === "task_rework";
}

export function isTaskAskUserToolName(name: string): boolean {
  return normalizeMainChatToolName(name) === "task_ask_user";
}

export function isSettingsProposePatchToolName(name: string): boolean {
  return normalizeMainChatToolName(name) === "settings_propose_patch";
}

export function isMainChatInlineCardToolName(name: string): boolean {
  return (
    isTaskPlanToolName(name) ||
    isTaskCompleteToolName(name) ||
    isTaskReworkToolName(name) ||
    isTaskAskUserToolName(name) ||
    isSettingsProposePatchToolName(name)
  );
}

function tryParseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

const MAX_TOOL_PAYLOAD_UNWRAP_DEPTH = 8;

function unwrapArrayPayload(
  entries: readonly unknown[],
  depth: number,
): Record<string, unknown> | null {
  if (depth > MAX_TOOL_PAYLOAD_UNWRAP_DEPTH) return null;
  for (const entry of entries) {
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>;
      if (typeof record.text === "string") {
        const parsed = unwrapToolPayloadObjectInternal(record.text, depth + 1);
        if (parsed) return parsed;
      }
    }
    const parsed = unwrapToolPayloadObjectInternal(entry, depth + 1);
    if (parsed) return parsed;
  }
  return null;
}

function unwrapToolPayloadObjectInternal(
  raw: unknown,
  depth: number,
): Record<string, unknown> | null {
  if (raw == null || depth > MAX_TOOL_PAYLOAD_UNWRAP_DEPTH) return null;
  if (typeof raw === "string") {
    return unwrapToolPayloadObjectInternal(tryParseJsonString(raw), depth + 1);
  }
  if (Array.isArray(raw)) {
    return unwrapArrayPayload(raw, depth + 1);
  }
  if (typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.structuredContent === "object" && obj.structuredContent !== null) {
    const nested = unwrapToolPayloadObjectInternal(obj.structuredContent, depth + 1);
    if (nested) return nested;
  }
  if (Array.isArray(obj.content)) {
    const fromContent = unwrapArrayPayload(obj.content, depth + 1);
    if (fromContent) return fromContent;
  }
  if (typeof obj.text === "string") {
    const fromText = unwrapToolPayloadObjectInternal(obj.text, depth + 1);
    if (fromText) return fromText;
  }
  // Claude MCP tool results wrap the actual payload inside an extra `{ output: ... }` envelope.
  if (obj.output !== undefined && obj.output !== null) {
    const fromOutput = unwrapToolPayloadObjectInternal(obj.output, depth + 1);
    if (fromOutput) return fromOutput;
  }
  return obj;
}

/**
 * MCP tool outputs arrive differently across providers (structured object, JSON text string,
 * `{ content: [{ type: "text", text: "..." }] }`, or Claude's `{ output: ... }` wrapper).
 * Unwrap all of those shapes cleanly.
 */
export function unwrapToolPayloadObject(raw: unknown): Record<string, unknown> | null {
  return unwrapToolPayloadObjectInternal(raw, 0);
}

export function parseTaskPlanToolOutput(output: unknown): MainChatPlanRecord | null {
  const obj = unwrapToolPayloadObject(output);
  if (!obj) return null;
  const candidate = obj.plan ?? obj;
  const parsed = MainChatPlanRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function parseTaskCompleteToolPayload(
  input: unknown,
  output: unknown,
): MainChatTaskReceipt | null {
  const outputObj = unwrapToolPayloadObject(output);
  const receiptFromOutput = outputObj?.receipt ?? outputObj;
  const parsedOutput = MainChatTaskReceiptSchema.safeParse(receiptFromOutput);
  if (parsedOutput.success) return parsedOutput.data;

  const inputObj = unwrapToolPayloadObject(input);
  if (!inputObj || typeof inputObj.title !== "string" || typeof inputObj.summary !== "string") {
    return null;
  }
  const checks = Array.isArray(inputObj.checks)
    ? inputObj.checks.flatMap((entry) => {
        const parsed = MainChatReceiptCheckSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const nextSteps = Array.isArray(inputObj.nextSteps)
    ? inputObj.nextSteps.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    title: inputObj.title,
    summary: inputObj.summary,
    agentId: typeof inputObj.agentId === "string" ? inputObj.agentId : null,
    planId: typeof inputObj.planId === "string" ? inputObj.planId : null,
    taskId: typeof inputObj.taskId === "string" ? inputObj.taskId : null,
    checks,
    nextSteps,
  };
}

export function parseTaskReworkToolPayload(
  input: unknown,
  output: unknown,
): MainChatReworkRecord | null {
  const outputObj = unwrapToolPayloadObject(output);
  const candidate = outputObj?.rework ?? outputObj;
  const parsedOutput = MainChatReworkRecordSchema.safeParse(candidate);
  if (parsedOutput.success) return parsedOutput.data;

  const inputObj = unwrapToolPayloadObject(input);
  if (!inputObj || typeof inputObj.agentId !== "string") return null;
  const gaps = Array.isArray(inputObj.gaps)
    ? inputObj.gaps.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (gaps.length === 0) return null;
  return {
    title: typeof inputObj.title === "string" ? inputObj.title : inputObj.agentId,
    agentId: inputObj.agentId,
    planId: typeof inputObj.planId === "string" ? inputObj.planId : null,
    taskId: typeof inputObj.taskId === "string" ? inputObj.taskId : null,
    round: 1,
    maxRounds: 2,
    gaps,
    note: typeof inputObj.note === "string" ? inputObj.note : null,
  };
}

export function parseTaskAskUserToolPayload(output: unknown): MainChatDecisionRecord | null {
  const outputObj = unwrapToolPayloadObject(output);
  if (!outputObj) return null;
  const candidate = outputObj.decision ?? outputObj;
  const parsed = MainChatDecisionRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function parseSettingsProposePatchToolPayload(
  output: unknown,
): MainChatSettingsProposalRecord | null {
  const outputObj = unwrapToolPayloadObject(output);
  if (!outputObj) return null;
  const candidate = outputObj.proposal ?? outputObj;
  const parsed = MainChatSettingsProposalRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

const COMPOUND_COMMAND_RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "bun",
  "deno",
  "git",
  "jj",
  "cargo",
  "go",
  "python",
  "python3",
  "pytest",
  "uv",
  "docker",
  "kubectl",
  "make",
  "gh",
  "lark-cli",
]);

const UNSAFE_SHELL_METACHAR_RE = /[;&|><`$()]/;

const DISALLOWED_AUTO_APPROVE_COMMANDS = new Set([
  "rm",
  "sudo",
  "su",
  "dd",
  "mkfs",
  "chmod",
  "chown",
  "kill",
  "killall",
  "shutdown",
  "reboot",
]);

const DISALLOWED_AUTO_APPROVE_PREFIXES = new Set([
  "git push",
  "git reset",
  "git clean",
  "git rebase",
  "jj git",
  "npm publish",
  "pnpm publish",
]);

export interface MainChatPermissionRuleCandidate {
  toolName: string;
  commandPrefix: string | null;
}

function readRawCommandFromInput(input: Record<string, unknown> | null | undefined): string | null {
  if (!input) return null;
  const raw = input.command ?? input.cmd;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractSafeCommandPrefix(command: string): string | null {
  if (UNSAFE_SHELL_METACHAR_RE.test(command)) return null;
  const tokens = command.split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();
  if (!first || DISALLOWED_AUTO_APPROVE_COMMANDS.has(first)) return null;
  const second = tokens[1];
  if (COMPOUND_COMMAND_RUNNERS.has(first) && second && !second.startsWith("-")) {
    const pair = `${first} ${second.toLowerCase()}`;
    return DISALLOWED_AUTO_APPROVE_PREFIXES.has(pair) ? null : pair;
  }
  return first;
}

/**
 * Extracts a conservative, deterministic permission-rule key shared by the daemon supervisor and
 * the UI's "Approve & Remember Similar" button. Chained shell commands or destructive operations
 * return `null` so they always require explicit user confirmation.
 */
export function extractMainChatPermissionRuleCandidate(request: {
  kind?: string | null;
  name?: string | null;
  title?: string | null;
  input?: Record<string, unknown> | null;
}): MainChatPermissionRuleCandidate | null {
  if (request.kind === "question" || request.kind === "plan") return null;
  const toolName = (request.name ?? request.title ?? "").trim();
  if (!toolName) return null;
  const rawCommand = readRawCommandFromInput(request.input);
  if (rawCommand !== null) {
    const commandPrefix = extractSafeCommandPrefix(rawCommand);
    if (!commandPrefix) return null;
    return { toolName, commandPrefix };
  }
  return { toolName, commandPrefix: null };
}

// ============================================================================
// Wave 6 (P2-1): Plugin-Based Feishu Bot Bridge Schemas & RPCs
// ============================================================================

export const FeishuBridgeDomainPresetSchema = z.enum(FEISHU_BRIDGE_DOMAIN_PRESETS);
export type FeishuBridgeDomainPreset = z.infer<typeof FeishuBridgeDomainPresetSchema>;

export const FeishuBridgeReceiveIdTypeSchema = z.enum(FEISHU_BRIDGE_RECEIVE_ID_TYPES);
export type FeishuBridgeReceiveIdType = z.infer<typeof FeishuBridgeReceiveIdTypeSchema>;

export const FeishuBridgeForwardTierSchema = z.enum(FEISHU_BRIDGE_FORWARD_TIERS);
export type FeishuBridgeForwardTier = z.infer<typeof FeishuBridgeForwardTierSchema>;

export const FeishuBridgeRedactedConfigSchema = z.object({
  enabled: z.boolean(),
  domainPreset: FeishuBridgeDomainPresetSchema,
  apiBaseUrl: z.string(),
  appId: z.string(),
  hasAppSecret: z.boolean(),
  appSecretMask: z.string().nullable(),
  hasVerificationToken: z.boolean(),
  verificationTokenMask: z.string().nullable(),
  hasEncryptKey: z.boolean(),
  encryptKeyMask: z.string().nullable(),
  receiveIdType: FeishuBridgeReceiveIdTypeSchema,
  receiveId: z.string(),
  allowedOpenIds: z.array(z.string()),
  forwardTiers: z.array(FeishuBridgeForwardTierSchema),
  respectLowDistraction: z.boolean(),
  replayWindowSeconds: z
    .number()
    .int()
    .min(FEISHU_BRIDGE_MIN_REPLAY_WINDOW_SEC)
    .max(FEISHU_BRIDGE_MAX_REPLAY_WINDOW_SEC),
  requireSignature: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type FeishuBridgeRedactedConfig = z.infer<typeof FeishuBridgeRedactedConfigSchema>;

export const FeishuBridgeConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  domainPreset: FeishuBridgeDomainPresetSchema.optional(),
  apiBaseUrl: z.string().max(512).optional(),
  appId: z.string().max(128).optional(),
  appSecret: z.string().max(512).optional(),
  clearAppSecret: z.boolean().optional(),
  verificationToken: z.string().max(512).optional(),
  clearVerificationToken: z.boolean().optional(),
  encryptKey: z.string().max(512).optional(),
  clearEncryptKey: z.boolean().optional(),
  receiveIdType: FeishuBridgeReceiveIdTypeSchema.optional(),
  receiveId: z.string().max(256).optional(),
  allowedOpenIds: z.array(z.string().max(128)).max(100).optional(),
  forwardTiers: z.array(FeishuBridgeForwardTierSchema).max(3).optional(),
  respectLowDistraction: z.boolean().optional(),
  replayWindowSeconds: z
    .number()
    .int()
    .min(FEISHU_BRIDGE_MIN_REPLAY_WINDOW_SEC)
    .max(FEISHU_BRIDGE_MAX_REPLAY_WINDOW_SEC)
    .optional(),
  requireSignature: z.boolean().optional(),
});
export type FeishuBridgeConfigPatch = z.infer<typeof FeishuBridgeConfigPatchSchema>;

export const FeishuBridgeAuditDirectionSchema = z.enum(["outbound", "inbound", "system"]);
export type FeishuBridgeAuditDirection = z.infer<typeof FeishuBridgeAuditDirectionSchema>;

export const FeishuBridgeAuditKindSchema = z.enum([
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
export type FeishuBridgeAuditKind = z.infer<typeof FeishuBridgeAuditKindSchema>;

export const FeishuBridgeAuditStatusSchema = z.enum([
  "succeeded",
  "failed",
  "rejected",
  "deduplicated",
  "filtered",
]);
export type FeishuBridgeAuditStatus = z.infer<typeof FeishuBridgeAuditStatusSchema>;

export const FeishuBridgeAuditRecordSchema = z.object({
  id: z.string(),
  direction: FeishuBridgeAuditDirectionSchema,
  kind: FeishuBridgeAuditKindSchema,
  status: FeishuBridgeAuditStatusSchema,
  title: z.string(),
  summary: z.string(),
  errorCode: z.string().nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  messageId: z.string().nullable(),
  actorOpenId: z.string().nullable(),
  eventOrActionId: z.string().nullable(),
  tier: MainChatNotificationTierSchema.nullable(),
  createdAt: z.string(),
});
export type FeishuBridgeAuditRecord = z.infer<typeof FeishuBridgeAuditRecordSchema>;

export const FeishuBridgeStatsSchema = z.object({
  outboundSent: z.number().int().nonnegative(),
  outboundFailed: z.number().int().nonnegative(),
  inboundProcessed: z.number().int().nonnegative(),
  inboundRejected: z.number().int().nonnegative(),
  inboundDeduplicated: z.number().int().nonnegative(),
  lastOutboundAt: z.string().nullable(),
  lastInboundAt: z.string().nullable(),
});
export type FeishuBridgeStats = z.infer<typeof FeishuBridgeStatsSchema>;

export const FeishuBridgeStateSchema = z.object({
  pluginAvailable: z.boolean(),
  pluginId: z.string(),
  active: z.boolean(),
  webhookPath: z.string(),
  webhookUrl: z.string().nullable(),
  config: FeishuBridgeRedactedConfigSchema,
  stats: FeishuBridgeStatsSchema,
  recentAudit: z.array(FeishuBridgeAuditRecordSchema),
});
export type FeishuBridgeState = z.infer<typeof FeishuBridgeStateSchema>;

export const FeishuBridgeConnectionTestResultSchema = z.object({
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
export type FeishuBridgeConnectionTestResult = z.infer<
  typeof FeishuBridgeConnectionTestResultSchema
>;

export const FeishuBridgeSendTestCardResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nonnegative(),
  messageId: z.string().nullable(),
  receiveId: z.string(),
  receiveIdType: FeishuBridgeReceiveIdTypeSchema,
  errorCode: z.string().nullable(),
  message: z.string(),
  troubleshootingHint: z.string().nullable(),
  sentAt: z.string(),
});
export type FeishuBridgeSendTestCardResult = z.infer<typeof FeishuBridgeSendTestCardResultSchema>;

export function resolveFeishuBridgeApiBaseUrl(
  preset: FeishuBridgeDomainPreset,
  customApiBaseUrl?: string | null,
): string {
  if (preset === "feishu") return FEISHU_BRIDGE_API_BASE_URLS.feishu;
  if (preset === "lark") return FEISHU_BRIDGE_API_BASE_URLS.lark;
  return (customApiBaseUrl ?? "").trim().replace(/\/+$/, "");
}

export function createDefaultFeishuBridgeRedactedConfig(): FeishuBridgeRedactedConfig {
  return {
    enabled: false,
    domainPreset: "feishu",
    apiBaseUrl: FEISHU_BRIDGE_API_BASE_URLS.feishu,
    appId: "",
    hasAppSecret: false,
    appSecretMask: null,
    hasVerificationToken: false,
    verificationTokenMask: null,
    hasEncryptKey: false,
    encryptKeyMask: null,
    receiveIdType: "chat_id",
    receiveId: "",
    allowedOpenIds: [],
    forwardTiers: ["critical", "actionable"],
    respectLowDistraction: true,
    replayWindowSeconds: FEISHU_BRIDGE_DEFAULT_REPLAY_WINDOW_SEC,
    requireSignature: true,
    updatedAt: null,
  };
}

export function createEmptyFeishuBridgeStats(): FeishuBridgeStats {
  return {
    outboundSent: 0,
    outboundFailed: 0,
    inboundProcessed: 0,
    inboundRejected: 0,
    inboundDeduplicated: 0,
    lastOutboundAt: null,
    lastInboundAt: null,
  };
}

export function createUnavailableFeishuBridgeState(
  webhookUrl: string | null = null,
): FeishuBridgeState {
  return {
    pluginAvailable: false,
    pluginId: FEISHU_BRIDGE_PLUGIN_ID,
    active: false,
    webhookPath: FEISHU_BRIDGE_WEBHOOK_PATH,
    webhookUrl,
    config: createDefaultFeishuBridgeRedactedConfig(),
    stats: createEmptyFeishuBridgeStats(),
    recentAudit: [],
  };
}

export const MainChatFeishuBridgeGetStateRequestSchema = z.object({
  type: z.literal("main_chat.feishu_bridge_get_state.request"),
  requestId: z.string(),
  auditLimit: z.number().int().min(1).max(FEISHU_BRIDGE_MAX_AUDIT_RECORDS).optional(),
});
export type MainChatFeishuBridgeGetStateRequest = z.infer<
  typeof MainChatFeishuBridgeGetStateRequestSchema
>;

export const MainChatFeishuBridgeGetStateResponsePayloadSchema = z.object({
  requestId: z.string(),
  state: FeishuBridgeStateSchema,
  error: z.string().nullable(),
});
export type MainChatFeishuBridgeGetStateResponsePayload = z.infer<
  typeof MainChatFeishuBridgeGetStateResponsePayloadSchema
>;

export const MainChatFeishuBridgeGetStateResponseSchema = z.object({
  type: z.literal("main_chat.feishu_bridge_get_state.response"),
  payload: MainChatFeishuBridgeGetStateResponsePayloadSchema,
});
export type MainChatFeishuBridgeGetStateResponse = z.infer<
  typeof MainChatFeishuBridgeGetStateResponseSchema
>;

export const MainChatFeishuBridgeUpdateConfigRequestSchema = z.object({
  type: z.literal("main_chat.feishu_bridge_update_config.request"),
  requestId: z.string(),
  patch: FeishuBridgeConfigPatchSchema,
});
export type MainChatFeishuBridgeUpdateConfigRequest = z.infer<
  typeof MainChatFeishuBridgeUpdateConfigRequestSchema
>;

export const MainChatFeishuBridgeUpdateConfigResponsePayloadSchema = z.object({
  requestId: z.string(),
  state: FeishuBridgeStateSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatFeishuBridgeUpdateConfigResponsePayload = z.infer<
  typeof MainChatFeishuBridgeUpdateConfigResponsePayloadSchema
>;

export const MainChatFeishuBridgeUpdateConfigResponseSchema = z.object({
  type: z.literal("main_chat.feishu_bridge_update_config.response"),
  payload: MainChatFeishuBridgeUpdateConfigResponsePayloadSchema,
});
export type MainChatFeishuBridgeUpdateConfigResponse = z.infer<
  typeof MainChatFeishuBridgeUpdateConfigResponseSchema
>;

export const MainChatFeishuBridgeTestConnectionRequestSchema = z.object({
  type: z.literal("main_chat.feishu_bridge_test_connection.request"),
  requestId: z.string(),
  forceRefreshToken: z.boolean().optional(),
});
export type MainChatFeishuBridgeTestConnectionRequest = z.infer<
  typeof MainChatFeishuBridgeTestConnectionRequestSchema
>;

export const MainChatFeishuBridgeTestConnectionResponsePayloadSchema = z.object({
  requestId: z.string(),
  result: FeishuBridgeConnectionTestResultSchema,
  error: z.string().nullable(),
});
export type MainChatFeishuBridgeTestConnectionResponsePayload = z.infer<
  typeof MainChatFeishuBridgeTestConnectionResponsePayloadSchema
>;

export const MainChatFeishuBridgeTestConnectionResponseSchema = z.object({
  type: z.literal("main_chat.feishu_bridge_test_connection.response"),
  payload: MainChatFeishuBridgeTestConnectionResponsePayloadSchema,
});
export type MainChatFeishuBridgeTestConnectionResponse = z.infer<
  typeof MainChatFeishuBridgeTestConnectionResponseSchema
>;

export const MainChatFeishuBridgeSendTestCardRequestSchema = z.object({
  type: z.literal("main_chat.feishu_bridge_send_test_card.request"),
  requestId: z.string(),
  receiveId: z.string().max(256).optional(),
  receiveIdType: FeishuBridgeReceiveIdTypeSchema.optional(),
  title: z.string().max(120).optional(),
});
export type MainChatFeishuBridgeSendTestCardRequest = z.infer<
  typeof MainChatFeishuBridgeSendTestCardRequestSchema
>;

export const MainChatFeishuBridgeSendTestCardResponsePayloadSchema = z.object({
  requestId: z.string(),
  result: FeishuBridgeSendTestCardResultSchema,
  error: z.string().nullable(),
});
export type MainChatFeishuBridgeSendTestCardResponsePayload = z.infer<
  typeof MainChatFeishuBridgeSendTestCardResponsePayloadSchema
>;

export const MainChatFeishuBridgeSendTestCardResponseSchema = z.object({
  type: z.literal("main_chat.feishu_bridge_send_test_card.response"),
  payload: MainChatFeishuBridgeSendTestCardResponsePayloadSchema,
});
export type MainChatFeishuBridgeSendTestCardResponse = z.infer<
  typeof MainChatFeishuBridgeSendTestCardResponseSchema
>;

export const MainChatFeishuBridgeListAuditRequestSchema = z.object({
  type: z.literal("main_chat.feishu_bridge_list_audit.request"),
  requestId: z.string(),
  limit: z.number().int().min(1).max(FEISHU_BRIDGE_MAX_AUDIT_RECORDS).optional(),
  direction: FeishuBridgeAuditDirectionSchema.optional(),
});
export type MainChatFeishuBridgeListAuditRequest = z.infer<
  typeof MainChatFeishuBridgeListAuditRequestSchema
>;

export const MainChatFeishuBridgeListAuditResponsePayloadSchema = z.object({
  requestId: z.string(),
  records: z.array(FeishuBridgeAuditRecordSchema),
  stats: FeishuBridgeStatsSchema,
  error: z.string().nullable(),
});
export type MainChatFeishuBridgeListAuditResponsePayload = z.infer<
  typeof MainChatFeishuBridgeListAuditResponsePayloadSchema
>;

export const MainChatFeishuBridgeListAuditResponseSchema = z.object({
  type: z.literal("main_chat.feishu_bridge_list_audit.response"),
  payload: MainChatFeishuBridgeListAuditResponsePayloadSchema,
});
export type MainChatFeishuBridgeListAuditResponse = z.infer<
  typeof MainChatFeishuBridgeListAuditResponseSchema
>;
