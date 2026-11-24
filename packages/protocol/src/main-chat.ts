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

export const MAIN_CHAT_PROPOSABLE_SETTINGS_KEYS = [
  "title",
  "style",
  "autoCompactEnabled",
  "mainBackgroundFolded",
  "mainTasksQuiet",
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
  "profile.aboutMe",
  "profile.ownerAliases",
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

export const MainChatSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  autoCompactEnabled: z.boolean().optional(),
  compaction: MainChatCompactionConfigSchema.optional(),
  cacheKeepalive: MainChatCacheKeepaliveConfigSchema.optional(),
  limitFallbacks: z
    .array(MainChatLimitFallbackEntrySchema)
    .max(MAIN_CHAT_MAX_LIMIT_FALLBACKS)
    .optional(),
  mainBackgroundFolded: z.boolean().optional(),
  mainTasksQuiet: z.boolean().optional(),
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
  mainBackgroundFolded: z.boolean().optional(),
  mainTasksQuiet: z.boolean().optional(),
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
    mainBackgroundFolded: true,
    mainTasksQuiet: true,
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
  const shared = {
    enabled: isMainChatEnabled(current),
    autoCompactEnabled: isMainChatAutoCompactEnabled(current),
    compaction: currentCompaction,
    cacheKeepalive: currentCacheKeepalive,
    limitFallbacks: currentLimitFallbacks,
    mainBackgroundFolded: isMainChatBackgroundFolded(current),
    mainTasksQuiet: isMainChatTasksQuiet(current),
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
    enabled: patch.enabled ?? base.enabled ?? true,
    autoCompactEnabled: patch.autoCompactEnabled ?? base.autoCompactEnabled ?? true,
    compaction: mergeCompactionConfig(base, patch.compaction),
    cacheKeepalive: mergeCacheKeepaliveConfig(base, patch.cacheKeepalive),
    limitFallbacks: nextLimitFallbacks,
    mainBackgroundFolded: patch.mainBackgroundFolded ?? base.mainBackgroundFolded ?? true,
    mainTasksQuiet: patch.mainTasksQuiet ?? base.mainTasksQuiet ?? true,
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
});
export type MainChatReviewTaskRequest = z.infer<typeof MainChatReviewTaskRequestSchema>;

export const MainChatReviewTaskResponsePayloadSchema = z.object({
  requestId: z.string(),
  task: MainChatTaskRecordSchema.nullable(),
  receipt: MainChatTaskReceiptSchema.nullable(),
  rework: MainChatReworkRecordSchema.nullable(),
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
