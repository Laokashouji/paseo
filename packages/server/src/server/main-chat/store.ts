import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  MAIN_CHAT_MAX_ADMISSION_QUEUE,
  MAIN_CHAT_MAX_CUSTOM_PROMPT_TEMPLATES,
  MAIN_CHAT_MAX_IDLE_ARCHIVE_AUDIT_RECORDS,
  MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS,
  MAIN_CHAT_WORKSPACE_DIR_NAME,
  MainChatActivityEntrySchema,
  MainChatAdmissionQueueEntrySchema,
  MainChatApprovalClarificationSchema,
  MainChatAutoStartRuleSchema,
  MainChatCompactionReasonSchema,
  MainChatCompactionStrategySchema,
  MainChatDecisionRecordSchema,
  MainChatDurationSampleSchema,
  MainChatIdleArchiveAuditRecordSchema,
  MainChatLimitFallbackEventSchema,
  MainChatMetricsSchema,
  MainChatNotificationReceiptSchema,
  MainChatPermissionRuleSchema,
  MainChatPlanRecordSchema,
  MainChatPromptTemplateSchema,
  MainChatRuleSuggestionSchema,
  MainChatSessionTriageSchema,
  MainChatSettingsProposalRecordSchema,
  MainChatSettingsSchema,
  MainChatStandingAuthorizationSchema,
  MainChatStandingAuthorizationScopeSchema,
  MainChatTaskModeSchema,
  MainChatTaskReceiptSchema,
  MainChatTaskRecordSchema,
  MainChatTokenUsageBySourceSchema,
  MainChatTokenUsageCountersSchema,
  MainChatTokenUsageDayEntrySchema,
  MainChatTokenUsageModelEntrySchema,
  createDefaultMainChatSettings,
  createEmptyMainChatTokenUsageBySource,
  createEmptyMainChatTokenUsageCounters,
  isMainChatAutoCompactEnabled,
  isMainChatBackgroundFolded,
  isMainChatEnabled,
  isMainChatOnDemandToolLoadingEnabled,
  isMainChatStatelessBackgroundSupervisionEnabled,
  isMainChatTaskLessonsEnabled,
  isMainChatTasksQuiet,
  mergeMainChatSettings,
  resolveActiveMainChatStylePresetId,
  resolveMainChatCacheKeepaliveConfig,
  resolveMainChatCompactionConfig,
  resolveMainChatCustomPresets,
  resolveMainChatDeliveryGatePolicy,
  resolveMainChatIdleArchivePolicy,
  resolveMainChatLimitFallbacks,
  resolveMainChatModelConfig,
  resolveMainChatNightMode,
  resolveMainChatNotificationPolicy,
  resolveMainChatProfile,
  resolveMainChatResourceAdmissionPolicy,
  type MainChatActivityEntry,
  type MainChatActivityKind,
  type MainChatAdmissionQueueEntry,
  type MainChatApprovalClarification,
  type MainChatAutoStartRule,
  type MainChatCompactionReason,
  type MainChatCompactionStrategy,
  type MainChatDecisionRecord,
  type MainChatDurationSample,
  type MainChatIdleArchiveAuditRecord,
  type MainChatLimitFallbackEvent,
  type MainChatMetrics,
  type MainChatNotificationCategory,
  type MainChatNotificationDeliveryStatus,
  type MainChatNotificationReceipt,
  type MainChatNotificationSummary,
  type MainChatPermissionRule,
  type MainChatPlanRecord,
  type MainChatPromptTemplate,
  type MainChatRuleSuggestion,
  type MainChatSessionTriage,
  type MainChatSettings,
  type MainChatSettingsPatch,
  type MainChatSettingsProposalRecord,
  type MainChatStandingAuthorization,
  type MainChatTaskMode,
  type MainChatTaskReceipt,
  type MainChatTaskRecord,
  type MainChatTokenUsageBySource,
  type MainChatTokenUsageCounters,
  type MainChatTokenUsageDayEntry,
  type MainChatTokenUsageSource,
  type MainChatTokenUsageSummary,
} from "@getpaseo/protocol/main-chat";
import { recalculateAdmissionQueuePositions } from "./resource-admission.js";
import { computeMainChatNotificationSummary } from "./notification-policy.js";
import {
  buildStandingAuthorizationLabel,
  matchStandingAuthorization,
  type ManualApprovalObservation,
} from "./safety.js";
import {
  MAX_RETAINED_RECEIPTS,
  MAX_RETAINED_TASKS,
  normalizeTrustCwd,
  pruneDurationSamples,
  pruneTaskRecordList,
} from "./task-ledger.js";
import {
  PersistedZeroTokenAgentWindowSchema,
  type PersistedZeroTokenAgentWindow,
} from "./zero-token-rules.js";

export type MainChatTrustRule = MainChatAutoStartRule;
export type MainChatFullMetrics = Required<MainChatMetrics>;
export type { MainChatMetrics, MainChatPermissionRule };

const PartialMetricsSchema = MainChatMetricsSchema.partial();

const DelegatedQuestionEntrySchema = z.object({
  text: z.string(),
  at: z.string(),
});
export type DelegatedQuestionEntry = z.infer<typeof DelegatedQuestionEntrySchema>;

const PersistedMainChatReceiptSchema = MainChatTaskReceiptSchema.extend({
  mainAgentId: z.string().nullable().optional(),
  recordedAt: z.string(),
});
export type PersistedMainChatReceipt = z.infer<typeof PersistedMainChatReceiptSchema>;

const PersistedMainChatCompactionMetaSchema = z.object({
  lastCompactedAt: z.string().nullable(),
  lastError: z.string().nullable(),
  summary: z.string().nullable(),
  reason: MainChatCompactionReasonSchema.nullable().optional(),
  strategy: MainChatCompactionStrategySchema.nullable().optional(),
});
export interface PersistedMainChatCompactionMeta {
  lastCompactedAt: string | null;
  lastError: string | null;
  summary: string | null;
  reason: MainChatCompactionReason | null;
  strategy: MainChatCompactionStrategy | null;
}

const ManualApprovalObservationSchema = z.object({
  key: z.string(),
  scope: MainChatStandingAuthorizationScopeSchema,
  serverId: z.string().nullable(),
  cwd: z.string().nullable(),
  toolName: z.string().nullable(),
  commandPrefix: z.string().nullable(),
  mode: MainChatTaskModeSchema.nullable(),
  count: z.number().int().positive(),
  lastObservedAt: z.string(),
});

const PersistedMainChatTokenUsageSchema = z.object({
  allTime: MainChatTokenUsageCountersSchema,
  bySource: MainChatTokenUsageBySourceSchema,
  byModel: z.array(MainChatTokenUsageModelEntrySchema),
  daily: z.array(MainChatTokenUsageDayEntrySchema),
  updatedAt: z.string().nullable(),
});
type PersistedMainChatTokenUsage = z.infer<typeof PersistedMainChatTokenUsageSchema>;

const PersistedMainChatStateSchema = z.object({
  version: z.literal(1),
  optInMigrated: z.boolean().optional(),
  settings: MainChatSettingsSchema.optional(),
  plans: z.record(z.string(), MainChatPlanRecordSchema).optional(),
  tasks: z.array(MainChatTaskRecordSchema).optional(),
  decisions: z.record(z.string(), MainChatDecisionRecordSchema).optional(),
  receipts: z.array(PersistedMainChatReceiptSchema).optional(),
  durationSamples: z.array(MainChatDurationSampleSchema).optional(),
  activities: z.array(MainChatActivityEntrySchema).optional(),
  compactionByMainAgent: z.record(z.string(), PersistedMainChatCompactionMetaSchema).optional(),
  pendingHandoffByMainAgent: z.record(z.string(), z.string()).optional(),
  trustRules: z.array(MainChatAutoStartRuleSchema).optional(),
  permissionRules: z.array(MainChatPermissionRuleSchema).optional(),
  standingAuthorizations: z.array(MainChatStandingAuthorizationSchema).optional(),
  ruleSuggestions: z.array(MainChatRuleSuggestionSchema).optional(),
  pendingClarifications: z.array(MainChatApprovalClarificationSchema).optional(),
  manualApprovalObservations: z.record(z.string(), ManualApprovalObservationSchema).optional(),
  suppressedQuietBadgeCount: z.number().int().nonnegative().optional(),
  reworkRounds: z.record(z.string(), z.number().int().nonnegative()).optional(),
  triages: z.record(z.string(), MainChatSessionTriageSchema).optional(),
  delegatedQuestions: z.record(z.string(), z.array(DelegatedQuestionEntrySchema)).optional(),
  lastPatrolAt: z.string().nullable().optional(),
  lastWakeupAt: z.string().nullable().optional(),
  metrics: PartialMetricsSchema.optional(),
  tokenUsage: PersistedMainChatTokenUsageSchema.optional(),
  settingsProposals: z.record(z.string(), MainChatSettingsProposalRecordSchema).optional(),
  limitFallbackEvents: z.array(MainChatLimitFallbackEventSchema).optional(),
  dagWakeMarkers: z.record(z.string(), z.string()).optional(),
  notificationReceipts: z.array(MainChatNotificationReceiptSchema).optional(),
  zeroTokenRuleState: z.record(z.string(), PersistedZeroTokenAgentWindowSchema).optional(),
  admissionQueue: z.array(MainChatAdmissionQueueEntrySchema).optional(),
  idleArchiveAudit: z.array(MainChatIdleArchiveAuditRecordSchema).optional(),
  lastIdleArchiveSweepAt: z.string().nullable().optional(),
  promptTemplates: z.array(MainChatPromptTemplateSchema).optional(),
});

interface MainChatStateFile {
  version: 1;
  optInMigrated: boolean;
  settings: MainChatSettings;
  plans: Record<string, MainChatPlanRecord>;
  tasks: MainChatTaskRecord[];
  decisions: Record<string, MainChatDecisionRecord>;
  receipts: PersistedMainChatReceipt[];
  durationSamples: MainChatDurationSample[];
  activities: MainChatActivityEntry[];
  compactionByMainAgent: Record<string, PersistedMainChatCompactionMeta>;
  pendingHandoffByMainAgent: Record<string, string>;
  trustRules: MainChatAutoStartRule[];
  permissionRules: MainChatPermissionRule[];
  standingAuthorizations: MainChatStandingAuthorization[];
  ruleSuggestions: MainChatRuleSuggestion[];
  pendingClarifications: MainChatApprovalClarification[];
  manualApprovalObservations: Record<string, ManualApprovalObservation>;
  suppressedQuietBadgeCount: number;
  reworkRounds: Record<string, number>;
  triages: Record<string, MainChatSessionTriage>;
  delegatedQuestions: Record<string, DelegatedQuestionEntry[]>;
  lastPatrolAt: string | null;
  lastWakeupAt: string | null;
  metrics: MainChatFullMetrics;
  tokenUsage: PersistedMainChatTokenUsage;
  settingsProposals: Record<string, MainChatSettingsProposalRecord>;
  limitFallbackEvents: MainChatLimitFallbackEvent[];
  dagWakeMarkers: Record<string, string>;
  notificationReceipts: MainChatNotificationReceipt[];
  zeroTokenRuleState: Record<string, PersistedZeroTokenAgentWindow>;
  admissionQueue: MainChatAdmissionQueueEntry[];
  idleArchiveAudit: MainChatIdleArchiveAuditRecord[];
  lastIdleArchiveSweepAt: string | null;
  promptTemplates: MainChatPromptTemplate[];
}

export const MAX_RETAINED_ACTIVITIES = 200;
const MAX_RETAINED_PLANS = 200;
const MAX_RETAINED_DECISIONS = 200;
const MAX_RETAINED_SETTINGS_PROPOSALS = 100;
const MAX_RETAINED_LIMIT_FALLBACK_EVENTS = 50;
const MAX_RETAINED_TRIAGES = 200;
const MAX_RETAINED_STANDING_AUTHS = 300;
const MAX_RETAINED_RULE_SUGGESTIONS = 100;
const MAX_RETAINED_CLARIFICATIONS = 100;
const MAX_RETAINED_OBSERVATIONS = 300;
const MAX_RETAINED_USAGE_DAYS = 30;
const MAX_RETAINED_USAGE_MODELS = 100;
const DELEGATED_QUESTION_TTL_MS = 24 * 60 * 60 * 1000;

function emptyPersistedTokenUsage(): PersistedMainChatTokenUsage {
  return {
    allTime: createEmptyMainChatTokenUsageCounters(),
    bySource: createEmptyMainChatTokenUsageBySource(),
    byModel: [],
    daily: [],
    updatedAt: null,
  };
}

function formatLocalDateKey(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sanitizeTokenCount(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(value);
}

function sanitizeCostUsd(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function addCountersInto(
  target: MainChatTokenUsageCounters,
  delta: MainChatTokenUsageCounters,
): void {
  target.turns += delta.turns;
  target.inputTokens += delta.inputTokens;
  target.cachedInputTokens += delta.cachedInputTokens;
  target.outputTokens += delta.outputTokens;
  target.totalTokens += delta.totalTokens;
  target.costUsd = Number((target.costUsd + delta.costUsd).toFixed(6));
}

function cloneCounters(counters: MainChatTokenUsageCounters): MainChatTokenUsageCounters {
  return { ...counters };
}

function cloneBySource(bySource: MainChatTokenUsageBySource): MainChatTokenUsageBySource {
  return {
    foreground: cloneCounters(bySource.foreground),
    background: cloneCounters(bySource.background),
    direction: cloneCounters(bySource.direction),
    triage: cloneCounters(bySource.triage),
  };
}

function cloneDayEntry(entry: MainChatTokenUsageDayEntry): MainChatTokenUsageDayEntry {
  return {
    date: entry.date,
    turns: entry.turns,
    inputTokens: entry.inputTokens,
    cachedInputTokens: entry.cachedInputTokens,
    outputTokens: entry.outputTokens,
    totalTokens: entry.totalTokens,
    costUsd: entry.costUsd,
    bySource: cloneBySource(entry.bySource),
  };
}

function cloneModelEntry(
  entry: MainChatTokenUsageSummary["byModel"][number],
): MainChatTokenUsageSummary["byModel"][number] {
  return {
    provider: entry.provider,
    model: entry.model,
    turns: entry.turns,
    inputTokens: entry.inputTokens,
    cachedInputTokens: entry.cachedInputTokens,
    outputTokens: entry.outputTokens,
    totalTokens: entry.totalTokens,
    costUsd: entry.costUsd,
  };
}

function pruneDailyUsage(
  daily: readonly MainChatTokenUsageDayEntry[],
  nowMs: number,
): MainChatTokenUsageDayEntry[] {
  const cutoffDate = new Date(nowMs);
  cutoffDate.setHours(0, 0, 0, 0);
  cutoffDate.setDate(cutoffDate.getDate() - (MAX_RETAINED_USAGE_DAYS - 1));
  const cutoffKey = formatLocalDateKey(cutoffDate.getTime());
  return daily
    .filter((entry) => entry.date >= cutoffKey)
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-MAX_RETAINED_USAGE_DAYS)
    .map(cloneDayEntry);
}

function buildTokenUsageSummary(
  usage: PersistedMainChatTokenUsage,
  nowMs: number,
): MainChatTokenUsageSummary {
  const todayKey = formatLocalDateKey(nowMs);
  const weekStartDate = new Date(nowMs);
  weekStartDate.setHours(0, 0, 0, 0);
  weekStartDate.setDate(weekStartDate.getDate() - 6);
  const weekStartKey = formatLocalDateKey(weekStartDate.getTime());

  const today = createEmptyMainChatTokenUsageCounters();
  const last7Days = createEmptyMainChatTokenUsageCounters();
  const daily = pruneDailyUsage(usage.daily, nowMs);

  for (const entry of daily) {
    if (entry.date === todayKey) {
      addCountersInto(today, entry);
    }
    if (entry.date >= weekStartKey && entry.date <= todayKey) {
      addCountersInto(last7Days, entry);
    }
  }

  return {
    today,
    last7Days,
    allTime: cloneCounters(usage.allTime),
    bySource: cloneBySource(usage.bySource),
    byModel: usage.byModel
      .slice()
      .sort((left, right) => right.totalTokens - left.totalTokens || right.turns - left.turns)
      .map(cloneModelEntry),
    daily,
    updatedAt: usage.updatedAt,
  };
}

function emptyCompactionMeta(): PersistedMainChatCompactionMeta {
  return {
    lastCompactedAt: null,
    lastError: null,
    summary: null,
    reason: null,
    strategy: null,
  };
}

function emptyMetrics(): MainChatFullMetrics {
  return {
    autoContinued: 0,
    plansCreated: 0,
    plansAutoStarted: 0,
    plansStarted: 0,
    plansCancelled: 0,
    receiptsRecorded: 0,
    interrupts: 0,
    supervisorHeld: 0,
    reworkCount: 0,
    stalledNudges: 0,
    usageLimitRetries: 0,
    patrolRuns: 0,
    triageRuleCount: 0,
    triageModelCount: 0,
    proactiveWakeups: 0,
    autoDelegatedQuestions: 0,
    noProgressNudges: 0,
    preemptedTurns: 0,
    silentTurns: 0,
    missingReplyRecoveries: 0,
    compactions: 0,
    admissionQueued: 0,
    admissionRejected: 0,
    admissionDequeued: 0,
    statelessSupervisionRounds: 0,
    statelessSupervisionEscalations: 0,
    idleSubagentsArchived: 0,
  };
}

function emptyState(): MainChatStateFile {
  return {
    version: 1,
    optInMigrated: true,
    settings: createDefaultMainChatSettings("conservative"),
    plans: {},
    tasks: [],
    decisions: {},
    receipts: [],
    durationSamples: [],
    activities: [],
    compactionByMainAgent: {},
    pendingHandoffByMainAgent: {},
    trustRules: [],
    permissionRules: [],
    standingAuthorizations: [],
    ruleSuggestions: [],
    pendingClarifications: [],
    manualApprovalObservations: {},
    suppressedQuietBadgeCount: 0,
    reworkRounds: {},
    triages: {},
    delegatedQuestions: {},
    lastPatrolAt: null,
    lastWakeupAt: null,
    metrics: emptyMetrics(),
    tokenUsage: emptyPersistedTokenUsage(),
    settingsProposals: {},
    limitFallbackEvents: [],
    dagWakeMarkers: {},
    notificationReceipts: [],
    zeroTokenRuleState: {},
    admissionQueue: [],
    idleArchiveAudit: [],
    lastIdleArchiveSweepAt: null,
    promptTemplates: [],
  };
}

function normalizeCwdKey(cwd: string): string {
  return path.resolve(cwd);
}

function normalizeToolKey(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function normalizePrefixKey(prefix: string | null | undefined): string | null {
  const trimmed = prefix?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function makeRuleId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function pruneMapByTimestamp<T>(
  map: Record<string, T>,
  maxEntries: number,
  getTimestamp: (entry: T) => string,
): void {
  const entries = Object.entries(map);
  if (entries.length <= maxEntries) return;
  entries.sort((left, right) => getTimestamp(right[1]).localeCompare(getTimestamp(left[1])));
  const keep = new Set(entries.slice(0, maxEntries).map(([key]) => key));
  for (const key of Object.keys(map)) {
    if (!keep.has(key)) delete map[key];
  }
}

function pruneDelegatedQuestions(
  map: Record<string, DelegatedQuestionEntry[]>,
  nowMs: number,
): void {
  for (const [agentId, entries] of Object.entries(map)) {
    const fresh = entries.filter((entry) => {
      const ts = Date.parse(entry.at);
      return Number.isFinite(ts) && nowMs - ts <= DELEGATED_QUESTION_TTL_MS;
    });
    if (fresh.length === 0) {
      delete map[agentId];
    } else {
      map[agentId] = fresh.slice(-10);
    }
  }
}

export interface MainChatPermissionRuleLookup {
  toolName: string;
  commandPrefix: string | null;
  cwd?: string | null;
}

export interface MainChatActivityListOptions {
  mainAgentId?: string;
  limit?: number;
  includeSilent?: boolean;
  kind?: MainChatActivityKind;
}

export interface MainChatTaskListOptions {
  mainAgentId?: string;
  conversationId?: string;
  includeCompleted?: boolean;
}

export interface MainChatTrustRuleLookupOptions {
  serverId?: string | null;
  localServerId?: string | null;
}

export interface MainChatAddTrustRuleOptions {
  serverId?: string | null;
  hostLabel?: string | null;
  allowSubdirectories?: boolean;
}

export interface MainChatMigrationCounts {
  migratedPlans: number;
  migratedTasks: number;
  migratedDecisions: number;
  migratedReceipts: number;
  migratedActivities: number;
}

export interface RecordMainChatTokenUsageInput {
  source: MainChatTokenUsageSource;
  provider: string;
  model?: string | null;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  atMs?: number;
}

export interface MainChatStore {
  load(): Promise<void>;
  isOptInMigrated(): boolean;
  completeOptInMigration(options?: { disableDefault?: boolean }): Promise<MainChatSettings>;
  getSettings(): MainChatSettings;
  updateSettings(patch: MainChatSettingsPatch): Promise<MainChatSettings>;
  replaceSettings(next: MainChatSettings): Promise<MainChatSettings>;
  getPlan(planId: string): MainChatPlanRecord | null;
  listPlans(mainAgentId?: string): MainChatPlanRecord[];
  putPlan(plan: MainChatPlanRecord): Promise<void>;
  getTask(taskId: string): MainChatTaskRecord | null;
  findTaskByAgentId(agentId: string): MainChatTaskRecord | null;
  listTasks(options?: MainChatTaskListOptions): MainChatTaskRecord[];
  putTask(task: MainChatTaskRecord): Promise<void>;
  addDurationSample(sample: MainChatDurationSample): Promise<MainChatDurationSample>;
  listDurationSamples(nowMs?: number): MainChatDurationSample[];
  getDecision(decisionId: string): MainChatDecisionRecord | null;
  listDecisions(mainAgentId?: string): MainChatDecisionRecord[];
  putDecision(decision: MainChatDecisionRecord): Promise<void>;
  resolveOpenDecisionsForAgent(
    agentId: string,
    input: { answer: string; answeredAt?: string; taskId?: string | null },
  ): Promise<MainChatDecisionRecord[]>;
  addReceipt(
    receipt: MainChatTaskReceipt,
    mainAgentId?: string | null,
  ): Promise<PersistedMainChatReceipt>;
  listReceipts(mainAgentId?: string): PersistedMainChatReceipt[];
  appendActivity(entry: MainChatActivityEntry): Promise<MainChatActivityEntry>;
  updateActivity(
    id: string,
    patch: Partial<Omit<MainChatActivityEntry, "id" | "mainAgentId" | "createdAt">>,
  ): Promise<MainChatActivityEntry | null>;
  listActivities(options?: MainChatActivityListOptions): {
    activities: MainChatActivityEntry[];
    total: number;
  };
  getCompactionMeta(mainAgentId: string): PersistedMainChatCompactionMeta;
  setCompactionMeta(mainAgentId: string, meta: PersistedMainChatCompactionMeta): Promise<void>;
  getPendingHandoffSummary(mainAgentId: string): string | null;
  setPendingHandoffSummary(mainAgentId: string, summary: string | null): Promise<void>;
  consumePendingHandoffSummary(mainAgentId: string): Promise<string | null>;
  migrateMainAgent(
    fromMainAgentId: string,
    toMainAgentId: string,
  ): Promise<MainChatMigrationCounts>;
  hasTrustRule(
    cwd: string,
    mode: MainChatTaskMode,
    options?: MainChatTrustRuleLookupOptions,
  ): boolean;
  addTrustRule(
    cwd: string,
    mode: MainChatTaskMode,
    options?: MainChatAddTrustRuleOptions,
  ): Promise<MainChatAutoStartRule>;
  removeTrustRule(ruleId: string): Promise<boolean>;
  listTrustRules(): MainChatAutoStartRule[];
  findMatchingPermissionRule(lookup: MainChatPermissionRuleLookup): MainChatPermissionRule | null;
  addPermissionRule(input: {
    toolName: string;
    commandPrefix?: string | null;
    cwd?: string | null;
  }): Promise<MainChatPermissionRule>;
  removePermissionRule(ruleId: string): Promise<boolean>;
  listPermissionRules(): MainChatPermissionRule[];
  listStandingAuthorizations(options?: {
    includeRevoked?: boolean;
  }): MainChatStandingAuthorization[];
  getStandingAuthorization(id: string): MainChatStandingAuthorization | null;
  putStandingAuthorization(
    auth: MainChatStandingAuthorization,
  ): Promise<MainChatStandingAuthorization>;
  revokeStandingAuthorization(
    id: string,
    revokedAt?: string,
  ): Promise<{ revoked: boolean; authorization: MainChatStandingAuthorization | null }>;
  recordStandingAuthorizationMatch(
    id: string,
    matchedAt?: string,
  ): Promise<MainChatStandingAuthorization | null>;
  listRuleSuggestions(options?: { includeDismissed?: boolean }): MainChatRuleSuggestion[];
  getRuleSuggestion(id: string): MainChatRuleSuggestion | null;
  putRuleSuggestion(suggestion: MainChatRuleSuggestion): Promise<MainChatRuleSuggestion>;
  dismissRuleSuggestion(id: string, dismissedAt?: string): Promise<boolean>;
  removeRuleSuggestion(id: string): Promise<boolean>;
  getManualApprovalObservation(key: string): ManualApprovalObservation | null;
  putManualApprovalObservation(
    observation: ManualApprovalObservation,
  ): Promise<ManualApprovalObservation>;
  listPendingClarifications(): MainChatApprovalClarification[];
  putClarification(
    clarification: MainChatApprovalClarification,
  ): Promise<MainChatApprovalClarification>;
  removeClarificationsForPermission(agentId: string, permissionRequestId: string): Promise<number>;
  removeClarificationsForAgent(agentId: string): Promise<number>;
  getSuppressedQuietBadgeCount(): number;
  incrementSuppressedQuietBadgeCount(delta?: number): Promise<number>;
  getReworkRound(agentId: string): number;
  incrementReworkRound(agentId: string): Promise<number>;
  getTriage(agentId: string): MainChatSessionTriage | null;
  listTriages(): MainChatSessionTriage[];
  putTriage(triage: MainChatSessionTriage): Promise<void>;
  removeTriage(agentId: string): Promise<void>;
  listRecentDelegatedQuestions(agentId: string, nowMs?: number): DelegatedQuestionEntry[];
  recordDelegatedQuestion(agentId: string, text: string): Promise<void>;
  getLastPatrolAt(): string | null;
  setLastPatrolAt(iso: string): Promise<void>;
  getLastWakeupAt(): string | null;
  setLastWakeupAt(iso: string): Promise<void>;
  getMetrics(): MainChatFullMetrics;
  incrementMetric(key: keyof MainChatFullMetrics): Promise<void>;
  recordTokenUsage(input: RecordMainChatTokenUsageInput): Promise<MainChatTokenUsageSummary>;
  getTokenUsageSummary(nowMs?: number): MainChatTokenUsageSummary;
  resetTokenUsage(): Promise<MainChatTokenUsageSummary>;
  getSettingsProposal(proposalId: string): MainChatSettingsProposalRecord | null;
  listSettingsProposals(options?: {
    mainAgentId?: string;
    includeResolved?: boolean;
  }): MainChatSettingsProposalRecord[];
  putSettingsProposal(
    proposal: MainChatSettingsProposalRecord,
  ): Promise<MainChatSettingsProposalRecord>;
  appendLimitFallbackEvent(event: MainChatLimitFallbackEvent): Promise<MainChatLimitFallbackEvent>;
  listLimitFallbackEvents(limit?: number): MainChatLimitFallbackEvent[];
  hasDagWakeMarker(key: string): boolean;
  recordDagWakeMarker(key: string, atIso?: string): Promise<boolean>;
  clearDagWakeMarkersByPrefix(prefix: string): Promise<number>;
  recordNotificationReceipt(
    receipt: MainChatNotificationReceipt,
  ): Promise<MainChatNotificationReceipt>;
  updateNotificationReceiptStatus(
    id: string,
    patch: {
      status: MainChatNotificationDeliveryStatus;
      deliveredAt?: string | null;
      acknowledgedAt?: string | null;
      readAt?: string | null;
      reason?: string | null;
      updatedAt?: string;
    },
  ): Promise<MainChatNotificationReceipt | null>;
  listNotificationReceipts(options?: {
    status?: MainChatNotificationDeliveryStatus;
    category?: MainChatNotificationCategory;
    unreadOnly?: boolean;
    limit?: number;
  }): MainChatNotificationReceipt[];
  ackNotificationReceipts(input: {
    receiptId?: string;
    receiptIds?: readonly string[];
    markAll?: boolean;
    status?: "acknowledged" | "read";
    nowIso?: string;
  }): Promise<{ updatedCount: number; receipts: MainChatNotificationReceipt[] }>;
  getNotificationSummary(): MainChatNotificationSummary;
  getZeroTokenRuleState(): Record<string, PersistedZeroTokenAgentWindow>;
  setZeroTokenRuleState(next: Record<string, PersistedZeroTokenAgentWindow>): Promise<void>;
  listAdmissionQueue(): MainChatAdmissionQueueEntry[];
  setAdmissionQueue(
    entries: readonly MainChatAdmissionQueueEntry[],
  ): Promise<MainChatAdmissionQueueEntry[]>;
  enqueueAdmissionEntry(entry: MainChatAdmissionQueueEntry): Promise<MainChatAdmissionQueueEntry>;
  removeAdmissionEntry(queueId: string): Promise<boolean>;
  removeAdmissionEntriesByTaskId(taskId: string): Promise<number>;
  clearAdmissionQueue(serverId?: string): Promise<MainChatAdmissionQueueEntry[]>;
  listIdleArchiveAudit(limit?: number): MainChatIdleArchiveAuditRecord[];
  appendIdleArchiveAudit(record: MainChatIdleArchiveAuditRecord): Promise<void>;
  getLastIdleArchiveSweepAt(): string | null;
  setLastIdleArchiveSweepAt(iso: string): Promise<void>;
  listCustomPromptTemplates(): MainChatPromptTemplate[];
  setCustomPromptTemplates(
    templates: readonly MainChatPromptTemplate[],
  ): Promise<MainChatPromptTemplate[]>;
}

function standingAuthFromTrustRule(rule: MainChatAutoStartRule): MainChatStandingAuthorization {
  return {
    id: rule.id,
    scope: "auto_start",
    serverId: normalizeServerIdKey(rule.serverId),
    cwd: normalizeTrustCwd(rule.cwd),
    allowSubdirectories: rule.allowSubdirectories ?? true,
    toolName: null,
    commandPrefix: null,
    mode: rule.mode,
    label: buildStandingAuthorizationLabel({
      scope: "auto_start",
      mode: rule.mode,
      cwd: rule.cwd,
    }),
    reason: null,
    createdAt: rule.createdAt,
    lastMatchedAt: null,
    matchCount: 0,
    expiresAt: null,
    revokedAt: null,
  };
}

function standingAuthFromPermissionRule(
  rule: MainChatPermissionRule,
): MainChatStandingAuthorization {
  return {
    id: rule.id,
    scope: "permission",
    serverId: null,
    cwd: rule.cwd ? normalizeCwdKey(rule.cwd) : null,
    allowSubdirectories: false,
    toolName: rule.toolName,
    commandPrefix: normalizePrefixKey(rule.commandPrefix),
    mode: null,
    label: buildStandingAuthorizationLabel({
      scope: "permission",
      toolName: rule.toolName,
      commandPrefix: rule.commandPrefix,
      cwd: rule.cwd,
    }),
    reason: null,
    createdAt: rule.createdAt,
    lastMatchedAt: null,
    matchCount: 0,
    expiresAt: null,
    revokedAt: null,
  };
}

function mergeLegacyRulesIntoStandingAuthorizations(
  trustRules: readonly MainChatAutoStartRule[],
  permissionRules: readonly MainChatPermissionRule[],
  existing: readonly MainChatStandingAuthorization[],
): MainChatStandingAuthorization[] {
  const result = [...existing];
  const existingIds = new Set(result.map((entry) => entry.id));

  for (const rule of trustRules) {
    if (!existingIds.has(rule.id)) {
      result.push(standingAuthFromTrustRule(rule));
      existingIds.add(rule.id);
    }
  }
  for (const rule of permissionRules) {
    if (!existingIds.has(rule.id)) {
      result.push(standingAuthFromPermissionRule(rule));
      existingIds.add(rule.id);
    }
  }
  return result;
}

function syncStandingAuthToLegacyLists(
  state: MainChatStateFile,
  auth: MainChatStandingAuthorization,
): void {
  if (auth.revokedAt !== null) {
    state.trustRules = state.trustRules.filter((rule) => rule.id !== auth.id);
    state.permissionRules = state.permissionRules.filter((rule) => rule.id !== auth.id);
    return;
  }

  if (auth.scope === "auto_start" && auth.cwd && auth.mode) {
    const legacyTrust: MainChatAutoStartRule = {
      id: auth.id,
      cwd: normalizeTrustCwd(auth.cwd),
      mode: auth.mode,
      serverId: normalizeServerIdKey(auth.serverId),
      hostLabel: null,
      allowSubdirectories: auth.allowSubdirectories ?? true,
      createdAt: auth.createdAt,
    };
    const idx = state.trustRules.findIndex((rule) => rule.id === auth.id);
    if (idx >= 0) {
      state.trustRules[idx] = { ...state.trustRules[idx]!, ...legacyTrust };
    } else {
      state.trustRules.push(legacyTrust);
    }
    return;
  }

  if (auth.scope === "permission" && auth.toolName) {
    const legacyPerm: MainChatPermissionRule = {
      id: auth.id,
      toolName: auth.toolName,
      commandPrefix: normalizePrefixKey(auth.commandPrefix),
      cwd: auth.cwd ? normalizeCwdKey(auth.cwd) : null,
      createdAt: auth.createdAt,
    };
    const idx = state.permissionRules.findIndex((rule) => rule.id === auth.id);
    if (idx >= 0) {
      state.permissionRules[idx] = legacyPerm;
    } else {
      state.permissionRules.push(legacyPerm);
    }
  }
}

function cloneShallowArray<T extends object>(items: readonly T[]): T[] {
  const result: T[] = [];
  for (const item of items) {
    result.push({ ...item });
  }
  return result;
}

function hydrateCompactionMetaMap(
  raw: Record<string, z.infer<typeof PersistedMainChatCompactionMetaSchema>> | undefined,
): Record<string, PersistedMainChatCompactionMeta> {
  const map: Record<string, PersistedMainChatCompactionMeta> = {};
  if (!raw) return map;
  for (const [key, value] of Object.entries(raw)) {
    map[key] = {
      lastCompactedAt: value.lastCompactedAt,
      lastError: value.lastError,
      summary: value.summary,
      reason: value.reason ?? null,
      strategy: value.strategy ?? null,
    };
  }
  return map;
}

function hydrateM5SafetyFields(
  data: z.infer<typeof PersistedMainChatStateSchema>,
  trustRules: readonly MainChatAutoStartRule[],
  permissionRules: readonly MainChatPermissionRule[],
): Pick<
  MainChatStateFile,
  | "standingAuthorizations"
  | "ruleSuggestions"
  | "pendingClarifications"
  | "manualApprovalObservations"
  | "suppressedQuietBadgeCount"
> {
  const standingAuthorizations = mergeLegacyRulesIntoStandingAuthorizations(
    trustRules,
    permissionRules,
    data.standingAuthorizations ?? [],
  );
  return {
    standingAuthorizations: standingAuthorizations.slice(-MAX_RETAINED_STANDING_AUTHS),
    ruleSuggestions: (data.ruleSuggestions ?? []).slice(-MAX_RETAINED_RULE_SUGGESTIONS),
    pendingClarifications: (data.pendingClarifications ?? []).slice(-MAX_RETAINED_CLARIFICATIONS),
    manualApprovalObservations: data.manualApprovalObservations ?? {},
    suppressedQuietBadgeCount: data.suppressedQuietBadgeCount ?? 0,
  };
}

function hydrateSettings(raw: MainChatSettings | undefined): MainChatSettings {
  if (!raw) return createDefaultMainChatSettings("conservative");
  const customPresets = resolveMainChatCustomPresets(raw);
  const activePresetId = resolveActiveMainChatStylePresetId({
    style: raw.style,
    activePresetId: raw.activePresetId,
    customPresets,
  });
  return {
    ...raw,
    enabled: isMainChatEnabled(raw),
    autoCompactEnabled: isMainChatAutoCompactEnabled(raw),
    compaction: resolveMainChatCompactionConfig(raw),
    cacheKeepalive: resolveMainChatCacheKeepaliveConfig(raw),
    limitFallbacks: resolveMainChatLimitFallbacks(raw),
    modelConfig: resolveMainChatModelConfig(raw),
    notificationPolicy: resolveMainChatNotificationPolicy(raw),
    resourceAdmission: resolveMainChatResourceAdmissionPolicy(raw),
    statelessBackgroundSupervision: isMainChatStatelessBackgroundSupervisionEnabled(raw),
    onDemandToolLoading: isMainChatOnDemandToolLoadingEnabled(raw),
    idleArchivePolicy: resolveMainChatIdleArchivePolicy(raw),
    mainBackgroundFolded: isMainChatBackgroundFolded(raw),
    mainTasksQuiet: isMainChatTasksQuiet(raw),
    taskLessonsEnabled: isMainChatTaskLessonsEnabled(raw),
    deliveryGatePolicy: resolveMainChatDeliveryGatePolicy(raw),
    profile: resolveMainChatProfile(raw),
    activePresetId,
    customPresets,
    backgroundModel: { ...raw.backgroundModel },
    intervals: { ...raw.intervals },
    capabilities: { ...raw.capabilities },
    nightMode: resolveMainChatNightMode(raw),
  };
}

function hydrateTokenUsage(
  raw: PersistedMainChatTokenUsage | undefined,
  nowMs: number,
): PersistedMainChatTokenUsage {
  if (!raw) return emptyPersistedTokenUsage();
  return {
    allTime: cloneCounters(raw.allTime),
    bySource: cloneBySource(raw.bySource),
    byModel: raw.byModel.slice(0, MAX_RETAINED_USAGE_MODELS).map(cloneModelEntry),
    daily: pruneDailyUsage(raw.daily, nowMs),
    updatedAt: raw.updatedAt,
  };
}

function hydrateWave5PersistedFields(data: z.infer<typeof PersistedMainChatStateSchema>) {
  return {
    admissionQueue: recalculateAdmissionQueuePositions(
      (data.admissionQueue ?? []).slice(0, MAIN_CHAT_MAX_ADMISSION_QUEUE),
    ),
    idleArchiveAudit: (data.idleArchiveAudit ?? []).slice(
      0,
      MAIN_CHAT_MAX_IDLE_ARCHIVE_AUDIT_RECORDS,
    ),
    lastIdleArchiveSweepAt: data.lastIdleArchiveSweepAt ?? null,
    promptTemplates: (data.promptTemplates ?? [])
      .filter((entry) => !entry.builtin)
      .slice(0, MAIN_CHAT_MAX_CUSTOM_PROMPT_TEMPLATES),
  };
}

function hydratePersistedState(
  data: z.infer<typeof PersistedMainChatStateSchema>,
  nowMs: number,
): MainChatStateFile {
  const trustRules = data.trustRules ?? [];
  const permissionRules = data.permissionRules ?? [];
  return {
    version: 1,
    optInMigrated: data.optInMigrated === true,
    settings: hydrateSettings(data.settings),
    plans: data.plans ?? {},
    tasks: pruneTaskRecordList(data.tasks ?? [], MAX_RETAINED_TASKS),
    decisions: data.decisions ?? {},
    receipts: (data.receipts ?? []).slice(-MAX_RETAINED_RECEIPTS),
    durationSamples: pruneDurationSamples(data.durationSamples ?? [], nowMs),
    activities: data.activities ?? [],
    compactionByMainAgent: hydrateCompactionMetaMap(data.compactionByMainAgent),
    pendingHandoffByMainAgent: data.pendingHandoffByMainAgent ?? {},
    trustRules,
    permissionRules,
    ...hydrateM5SafetyFields(data, trustRules, permissionRules),
    reworkRounds: data.reworkRounds ?? {},
    triages: data.triages ?? {},
    delegatedQuestions: data.delegatedQuestions ?? {},
    lastPatrolAt: data.lastPatrolAt ?? null,
    lastWakeupAt: data.lastWakeupAt ?? null,
    metrics: { ...emptyMetrics(), ...data.metrics },
    tokenUsage: hydrateTokenUsage(data.tokenUsage, nowMs),
    settingsProposals: data.settingsProposals ?? {},
    limitFallbackEvents: (data.limitFallbackEvents ?? []).slice(
      -MAX_RETAINED_LIMIT_FALLBACK_EVENTS,
    ),
    dagWakeMarkers: { ...data.dagWakeMarkers },
    notificationReceipts: (data.notificationReceipts ?? []).slice(
      -MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS,
    ),
    zeroTokenRuleState: { ...data.zeroTokenRuleState },
    ...hydrateWave5PersistedFields(data),
  };
}

export interface MainChatStoreOptions {
  now?: () => number;
}

function normalizeServerIdKey(serverId: string | null | undefined): string | null {
  const trimmed = serverId?.trim();
  return trimmed ? trimmed : null;
}

export function createMainChatStore(
  paseoHome: string,
  storeOptions?: MainChatStoreOptions,
): MainChatStore {
  const dirPath = path.join(paseoHome, MAIN_CHAT_WORKSPACE_DIR_NAME);
  const filePath = path.join(dirPath, "state.json");
  const getNowMs = storeOptions?.now ?? (() => Date.now());
  let state: MainChatStateFile = emptyState();
  let loaded = false;
  let writeChain = Promise.resolve();

  async function persist(): Promise<void> {
    const nowMs = getNowMs();
    pruneMapByTimestamp(state.plans, MAX_RETAINED_PLANS, (entry) => entry.createdAt);
    pruneMapByTimestamp(state.decisions, MAX_RETAINED_DECISIONS, (entry) => entry.createdAt);
    pruneMapByTimestamp(
      state.settingsProposals,
      MAX_RETAINED_SETTINGS_PROPOSALS,
      (entry) => entry.createdAt,
    );
    pruneMapByTimestamp(state.triages, MAX_RETAINED_TRIAGES, (entry) => entry.updatedAt);
    if (state.limitFallbackEvents.length > MAX_RETAINED_LIMIT_FALLBACK_EVENTS) {
      state.limitFallbackEvents = state.limitFallbackEvents.slice(
        -MAX_RETAINED_LIMIT_FALLBACK_EVENTS,
      );
    }
    if (state.notificationReceipts.length > MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS) {
      state.notificationReceipts = state.notificationReceipts.slice(
        -MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS,
      );
    }
    state.tasks = pruneTaskRecordList(state.tasks, MAX_RETAINED_TASKS);
    state.durationSamples = pruneDurationSamples(state.durationSamples, nowMs);
    if (state.receipts.length > MAX_RETAINED_RECEIPTS) {
      state.receipts = state.receipts.slice(-MAX_RETAINED_RECEIPTS);
    }
    if (state.activities.length > MAX_RETAINED_ACTIVITIES) {
      state.activities = state.activities.slice(-MAX_RETAINED_ACTIVITIES);
    }
    if (state.standingAuthorizations.length > MAX_RETAINED_STANDING_AUTHS) {
      state.standingAuthorizations = state.standingAuthorizations.slice(
        -MAX_RETAINED_STANDING_AUTHS,
      );
    }
    if (state.ruleSuggestions.length > MAX_RETAINED_RULE_SUGGESTIONS) {
      state.ruleSuggestions = state.ruleSuggestions.slice(-MAX_RETAINED_RULE_SUGGESTIONS);
    }
    if (state.pendingClarifications.length > MAX_RETAINED_CLARIFICATIONS) {
      state.pendingClarifications = state.pendingClarifications.slice(-MAX_RETAINED_CLARIFICATIONS);
    }
    pruneMapByTimestamp(
      state.manualApprovalObservations,
      MAX_RETAINED_OBSERVATIONS,
      (entry) => entry.lastObservedAt,
    );
    pruneDelegatedQuestions(state.delegatedQuestions, nowMs);
    const snapshot = JSON.stringify(state, null, 2);
    const task = writeChain.then(async () => {
      await mkdir(dirPath, { recursive: true });
      const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tempPath, snapshot, "utf8");
      await rename(tempPath, filePath);
      return undefined;
    });
    writeChain = task.then(
      () => undefined,
      () => undefined,
    );
    await task;
  }

  return {
    async load() {
      if (loaded) return;
      loaded = true;
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = PersistedMainChatStateSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          state = hydratePersistedState(parsed.data, getNowMs());
        }
      } catch {
        // Missing or unreadable state starts clean.
      }
    },

    isOptInMigrated() {
      return state.optInMigrated;
    },

    async completeOptInMigration(options) {
      state.optInMigrated = true;
      if (options?.disableDefault) {
        state.settings = mergeMainChatSettings(state.settings, {
          enabled: false,
          fleetScope: { mode: "local_only", hostServerIds: [] },
        });
      }
      await persist();
      return this.getSettings();
    },

    getSettings() {
      const customPresets = resolveMainChatCustomPresets(state.settings);
      const activePresetId = resolveActiveMainChatStylePresetId({
        style: state.settings.style,
        activePresetId: state.settings.activePresetId,
        customPresets,
      });
      return {
        ...state.settings,
        enabled: isMainChatEnabled(state.settings),
        activePresetId,
        customPresets,
        modelConfig: resolveMainChatModelConfig(state.settings),
        notificationPolicy: resolveMainChatNotificationPolicy(state.settings),
        backgroundModel: { ...state.settings.backgroundModel },
        intervals: { ...state.settings.intervals },
        capabilities: { ...state.settings.capabilities },
        nightMode: resolveMainChatNightMode(state.settings),
      };
    },

    async updateSettings(patch) {
      state.optInMigrated = true;
      state.settings = mergeMainChatSettings(state.settings, patch);
      await persist();
      return this.getSettings();
    },

    async replaceSettings(next) {
      state.optInMigrated = true;
      state.settings = MainChatSettingsSchema.parse(next);
      await persist();
      return this.getSettings();
    },

    getPlan(planId) {
      return state.plans[planId] ?? null;
    },

    listPlans(mainAgentId) {
      const plans = Object.values(state.plans).filter(
        (plan) => !mainAgentId || plan.mainAgentId === mainAgentId,
      );
      plans.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return plans;
    },

    async putPlan(plan) {
      state.plans[plan.id] = plan;
      await persist();
    },

    getTask(taskId) {
      return state.tasks.find((task) => task.id === taskId) ?? null;
    },

    findTaskByAgentId(agentId) {
      const trimmed = agentId.trim();
      if (!trimmed) return null;
      const activeMatches = state.tasks.filter((task) => task.activeAgentId === trimmed);
      if (activeMatches.length > 0) {
        activeMatches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        return activeMatches[0]!;
      }
      const linkedMatches = state.tasks.filter((task) => task.agentIds.includes(trimmed));
      if (linkedMatches.length === 0) return null;
      linkedMatches.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return linkedMatches[0]!;
    },

    listTasks(options) {
      const includeCompleted = options?.includeCompleted ?? true;
      const filtered = state.tasks.filter((task) => {
        if (options?.mainAgentId && task.mainAgentId !== options.mainAgentId) return false;
        if (options?.conversationId && task.conversationId !== options.conversationId) return false;
        if (!includeCompleted && (task.status === "completed" || task.status === "cancelled")) {
          return false;
        }
        return true;
      });
      filtered.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return filtered;
    },

    async putTask(task) {
      const index = state.tasks.findIndex((entry) => entry.id === task.id);
      if (index >= 0) {
        state.tasks[index] = task;
      } else {
        state.tasks.push(task);
      }
      await persist();
    },

    async addDurationSample(sample) {
      state.durationSamples.push(sample);
      state.durationSamples = pruneDurationSamples(state.durationSamples, getNowMs());
      await persist();
      return sample;
    },

    listDurationSamples(nowMs = getNowMs()) {
      return pruneDurationSamples(state.durationSamples, nowMs);
    },

    getDecision(decisionId) {
      return state.decisions[decisionId] ?? null;
    },

    listDecisions(mainAgentId) {
      const decisions = Object.values(state.decisions).filter(
        (decision) => !mainAgentId || decision.mainAgentId === mainAgentId,
      );
      decisions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return decisions;
    },

    async putDecision(decision) {
      state.decisions[decision.id] = decision;
      await persist();
    },

    async resolveOpenDecisionsForAgent(agentId, input) {
      const answeredAt = input.answeredAt ?? new Date(getNowMs()).toISOString();
      const resolved: MainChatDecisionRecord[] = [];
      for (const decision of Object.values(state.decisions)) {
        if (decision.answeredAt !== null) continue;
        const matchesAgent = decision.agentId === agentId;
        const matchesTaskOnly =
          decision.agentId === null && Boolean(input.taskId) && decision.taskId === input.taskId;
        if (!matchesAgent && !matchesTaskOnly) continue;
        const updated: MainChatDecisionRecord = {
          ...decision,
          answer: input.answer,
          answeredAt,
        };
        state.decisions[decision.id] = updated;
        resolved.push(updated);
      }
      if (resolved.length > 0) {
        await persist();
      }
      return resolved;
    },

    async addReceipt(receipt, mainAgentId = null) {
      const entry: PersistedMainChatReceipt = {
        ...receipt,
        mainAgentId,
        recordedAt: new Date().toISOString(),
      };
      state.receipts.push(entry);
      if (state.receipts.length > MAX_RETAINED_RECEIPTS) {
        state.receipts = state.receipts.slice(-MAX_RETAINED_RECEIPTS);
      }
      await persist();
      return entry;
    },

    listReceipts(mainAgentId) {
      return state.receipts
        .filter((entry) => !mainAgentId || entry.mainAgentId === mainAgentId)
        .toReversed();
    },

    async appendActivity(entry) {
      state.activities.push(entry);
      if (state.activities.length > MAX_RETAINED_ACTIVITIES) {
        state.activities = state.activities.slice(-MAX_RETAINED_ACTIVITIES);
      }
      await persist();
      return entry;
    },

    async updateActivity(id, patch) {
      const index = state.activities.findIndex((entry) => entry.id === id);
      if (index < 0) return null;
      const updated: MainChatActivityEntry = {
        ...state.activities[index]!,
        ...patch,
      };
      state.activities[index] = updated;
      await persist();
      return updated;
    },

    listActivities(options) {
      const includeSilent = options?.includeSilent ?? true;
      const filtered = state.activities
        .filter((entry) => {
          if (options?.mainAgentId && entry.mainAgentId !== options.mainAgentId) return false;
          if (!includeSilent && entry.silent) return false;
          if (options?.kind && entry.kind !== options.kind) return false;
          return true;
        })
        .toReversed();
      const total = filtered.length;
      const limit = options?.limit
        ? Math.max(1, Math.min(MAX_RETAINED_ACTIVITIES, options.limit))
        : 50;
      return {
        activities: filtered.slice(0, limit),
        total,
      };
    },

    getCompactionMeta(mainAgentId) {
      const existing = state.compactionByMainAgent[mainAgentId];
      if (!existing) return emptyCompactionMeta();
      return { ...existing };
    },

    async setCompactionMeta(mainAgentId, meta) {
      state.compactionByMainAgent[mainAgentId] = { ...meta };
      await persist();
    },

    getPendingHandoffSummary(mainAgentId) {
      return state.pendingHandoffByMainAgent[mainAgentId] ?? null;
    },

    async setPendingHandoffSummary(mainAgentId, summary) {
      const trimmed = summary?.trim();
      if (trimmed) {
        state.pendingHandoffByMainAgent[mainAgentId] = trimmed;
      } else {
        delete state.pendingHandoffByMainAgent[mainAgentId];
      }
      await persist();
    },

    async consumePendingHandoffSummary(mainAgentId) {
      const existing = state.pendingHandoffByMainAgent[mainAgentId];
      if (!existing) return null;
      delete state.pendingHandoffByMainAgent[mainAgentId];
      await persist();
      return existing;
    },

    async migrateMainAgent(fromMainAgentId, toMainAgentId) {
      let migratedPlans = 0;
      let migratedTasks = 0;
      let migratedDecisions = 0;
      let migratedReceipts = 0;
      let migratedActivities = 0;

      for (const [planId, plan] of Object.entries(state.plans)) {
        if (plan.mainAgentId === fromMainAgentId) {
          state.plans[planId] = { ...plan, mainAgentId: toMainAgentId };
          migratedPlans += 1;
        }
      }
      state.tasks = state.tasks.map((task) => {
        if (task.mainAgentId === fromMainAgentId) {
          migratedTasks += 1;
          return { ...task, mainAgentId: toMainAgentId };
        }
        return task;
      });
      for (const [decisionId, decision] of Object.entries(state.decisions)) {
        if (decision.mainAgentId === fromMainAgentId) {
          state.decisions[decisionId] = { ...decision, mainAgentId: toMainAgentId };
          migratedDecisions += 1;
        }
      }
      for (const [proposalId, proposal] of Object.entries(state.settingsProposals)) {
        if (proposal.mainAgentId === fromMainAgentId) {
          state.settingsProposals[proposalId] = { ...proposal, mainAgentId: toMainAgentId };
        }
      }
      state.receipts = state.receipts.map((receipt) => {
        if (receipt.mainAgentId === fromMainAgentId) {
          migratedReceipts += 1;
          return { ...receipt, mainAgentId: toMainAgentId };
        }
        return receipt;
      });
      state.activities = state.activities.map((activity) => {
        if (activity.mainAgentId === fromMainAgentId) {
          migratedActivities += 1;
          return { ...activity, mainAgentId: toMainAgentId };
        }
        return activity;
      });
      delete state.compactionByMainAgent[fromMainAgentId];
      delete state.pendingHandoffByMainAgent[fromMainAgentId];

      await persist();
      return {
        migratedPlans,
        migratedTasks,
        migratedDecisions,
        migratedReceipts,
        migratedActivities,
      };
    },

    hasTrustRule(cwd, mode, options) {
      return matchStandingAuthorization(
        {
          scope: "auto_start",
          cwd,
          mode,
          serverId: options?.serverId,
          localServerId: options?.localServerId,
        },
        state.standingAuthorizations,
        getNowMs(),
      ).matched;
    },

    async addTrustRule(cwd, mode, options) {
      const normalized = normalizeTrustCwd(cwd);
      const serverId = normalizeServerIdKey(options?.serverId);
      const hostLabel = options?.hostLabel?.trim() || null;
      const allowSubdirectories = options?.allowSubdirectories ?? true;
      const existingIndex = state.trustRules.findIndex(
        (rule) =>
          normalizeTrustCwd(rule.cwd) === normalized &&
          rule.mode === mode &&
          normalizeServerIdKey(rule.serverId) === serverId,
      );
      if (existingIndex >= 0) {
        const existing = state.trustRules[existingIndex]!;
        const needsUpdate =
          (existing.allowSubdirectories ?? true) !== allowSubdirectories ||
          (hostLabel !== null && existing.hostLabel !== hostLabel);
        if (!needsUpdate) {
          return existing;
        }
        const updated: MainChatAutoStartRule = {
          ...existing,
          serverId,
          hostLabel: hostLabel ?? existing.hostLabel ?? null,
          allowSubdirectories,
        };
        state.trustRules[existingIndex] = updated;
        const authIdx = state.standingAuthorizations.findIndex((entry) => entry.id === updated.id);
        if (authIdx >= 0) {
          state.standingAuthorizations[authIdx] = {
            ...state.standingAuthorizations[authIdx]!,
            serverId,
            allowSubdirectories,
            revokedAt: null,
          };
        } else {
          state.standingAuthorizations.push(standingAuthFromTrustRule(updated));
        }
        await persist();
        return updated;
      }
      const rule: MainChatAutoStartRule = {
        id: makeRuleId("trust"),
        cwd: normalized,
        mode,
        serverId,
        hostLabel,
        allowSubdirectories,
        createdAt: new Date(getNowMs()).toISOString(),
      };
      state.trustRules.push(rule);
      state.standingAuthorizations.push(standingAuthFromTrustRule(rule));
      await persist();
      return rule;
    },

    async removeTrustRule(ruleId) {
      const before = state.trustRules.length;
      state.trustRules = state.trustRules.filter((rule) => rule.id !== ruleId);
      const auth = state.standingAuthorizations.find((entry) => entry.id === ruleId);
      if (auth && auth.revokedAt === null) {
        auth.revokedAt = new Date(getNowMs()).toISOString();
      }
      if (state.trustRules.length === before && !auth) return false;
      await persist();
      return true;
    },

    listTrustRules() {
      return [...state.trustRules];
    },

    findMatchingPermissionRule(lookup) {
      const toolKey = normalizeToolKey(lookup.toolName);
      const prefixKey = normalizePrefixKey(lookup.commandPrefix);
      const normalizedCwd = lookup.cwd ? normalizeCwdKey(lookup.cwd) : null;
      return (
        state.permissionRules.find((rule) => {
          if (normalizeToolKey(rule.toolName) !== toolKey) return false;
          if (normalizePrefixKey(rule.commandPrefix) !== prefixKey) return false;
          if (rule.cwd === null) return true;
          return normalizedCwd !== null && normalizeCwdKey(rule.cwd) === normalizedCwd;
        }) ?? null
      );
    },

    async addPermissionRule(input) {
      const toolName = input.toolName.trim();
      const commandPrefix = normalizePrefixKey(input.commandPrefix);
      const cwd = input.cwd?.trim() ? normalizeCwdKey(input.cwd.trim()) : null;
      const existing = state.permissionRules.find(
        (rule) =>
          normalizeToolKey(rule.toolName) === normalizeToolKey(toolName) &&
          normalizePrefixKey(rule.commandPrefix) === commandPrefix &&
          (rule.cwd === null ? cwd === null : cwd !== null && normalizeCwdKey(rule.cwd) === cwd),
      );
      if (existing) return existing;
      const rule: MainChatPermissionRule = {
        id: makeRuleId("perm"),
        toolName,
        commandPrefix,
        cwd,
        createdAt: new Date(getNowMs()).toISOString(),
      };
      state.permissionRules.push(rule);
      state.standingAuthorizations.push(standingAuthFromPermissionRule(rule));
      await persist();
      return rule;
    },

    async removePermissionRule(ruleId) {
      const before = state.permissionRules.length;
      state.permissionRules = state.permissionRules.filter((rule) => rule.id !== ruleId);
      const auth = state.standingAuthorizations.find((entry) => entry.id === ruleId);
      if (auth && auth.revokedAt === null) {
        auth.revokedAt = new Date(getNowMs()).toISOString();
      }
      if (state.permissionRules.length === before && !auth) return false;
      await persist();
      return true;
    },

    listPermissionRules() {
      return [...state.permissionRules];
    },

    listStandingAuthorizations(options) {
      const includeRevoked = options?.includeRevoked === true;
      const filtered = state.standingAuthorizations
        .filter((auth) => includeRevoked || auth.revokedAt === null)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return cloneShallowArray(filtered);
    },

    getStandingAuthorization(id) {
      const found = state.standingAuthorizations.find((auth) => auth.id === id);
      return found ? { ...found } : null;
    },

    async putStandingAuthorization(auth) {
      const idx = state.standingAuthorizations.findIndex((entry) => entry.id === auth.id);
      const copy: MainChatStandingAuthorization = { ...auth };
      if (idx >= 0) {
        state.standingAuthorizations[idx] = copy;
      } else {
        state.standingAuthorizations.push(copy);
      }
      syncStandingAuthToLegacyLists(state, copy);
      await persist();
      return { ...copy };
    },

    async revokeStandingAuthorization(id, revokedAt) {
      const idx = state.standingAuthorizations.findIndex((entry) => entry.id === id);
      if (idx < 0) {
        return { revoked: false, authorization: null };
      }
      const existing = state.standingAuthorizations[idx]!;
      if (existing.revokedAt !== null) {
        return { revoked: false, authorization: { ...existing } };
      }
      const updated: MainChatStandingAuthorization = {
        ...existing,
        revokedAt: revokedAt ?? new Date(getNowMs()).toISOString(),
      };
      state.standingAuthorizations[idx] = updated;
      syncStandingAuthToLegacyLists(state, updated);
      await persist();
      return { revoked: true, authorization: { ...updated } };
    },

    async recordStandingAuthorizationMatch(id, matchedAt) {
      const idx = state.standingAuthorizations.findIndex((entry) => entry.id === id);
      if (idx < 0) return null;
      const existing = state.standingAuthorizations[idx]!;
      const updated: MainChatStandingAuthorization = {
        ...existing,
        matchCount: existing.matchCount + 1,
        lastMatchedAt: matchedAt ?? new Date(getNowMs()).toISOString(),
      };
      state.standingAuthorizations[idx] = updated;
      await persist();
      return { ...updated };
    },

    listRuleSuggestions(options) {
      const includeDismissed = options?.includeDismissed === true;
      const filtered = state.ruleSuggestions
        .filter((item) => includeDismissed || item.dismissedAt === null)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return cloneShallowArray(filtered);
    },

    getRuleSuggestion(id) {
      const found = state.ruleSuggestions.find((item) => item.id === id);
      return found ? { ...found } : null;
    },

    async putRuleSuggestion(suggestion) {
      const idx = state.ruleSuggestions.findIndex((item) => item.id === suggestion.id);
      const copy: MainChatRuleSuggestion = { ...suggestion };
      if (idx >= 0) {
        state.ruleSuggestions[idx] = copy;
      } else {
        state.ruleSuggestions.push(copy);
      }
      await persist();
      return { ...copy };
    },

    async dismissRuleSuggestion(id, dismissedAt) {
      const idx = state.ruleSuggestions.findIndex((item) => item.id === id);
      if (idx < 0) return false;
      const existing = state.ruleSuggestions[idx]!;
      if (existing.dismissedAt !== null) return false;
      state.ruleSuggestions[idx] = {
        ...existing,
        dismissedAt: dismissedAt ?? new Date(getNowMs()).toISOString(),
      };
      await persist();
      return true;
    },

    async removeRuleSuggestion(id) {
      const before = state.ruleSuggestions.length;
      state.ruleSuggestions = state.ruleSuggestions.filter((item) => item.id !== id);
      if (state.ruleSuggestions.length === before) return false;
      await persist();
      return true;
    },

    getManualApprovalObservation(key) {
      const found = state.manualApprovalObservations[key];
      return found ? { ...found } : null;
    },

    async putManualApprovalObservation(observation) {
      state.manualApprovalObservations[observation.key] = { ...observation };
      await persist();
      return { ...observation };
    },

    listPendingClarifications() {
      const sorted = state.pendingClarifications
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      return cloneShallowArray(sorted);
    },

    async putClarification(clarification) {
      const idx = state.pendingClarifications.findIndex(
        (entry) =>
          entry.id === clarification.id ||
          (entry.agentId === clarification.agentId &&
            entry.permissionRequestId === clarification.permissionRequestId),
      );
      const copy: MainChatApprovalClarification = { ...clarification };
      if (idx >= 0) {
        state.pendingClarifications[idx] = copy;
      } else {
        state.pendingClarifications.push(copy);
      }
      await persist();
      return { ...copy };
    },

    async removeClarificationsForPermission(agentId, permissionRequestId) {
      const before = state.pendingClarifications.length;
      state.pendingClarifications = state.pendingClarifications.filter(
        (entry) =>
          !(entry.agentId === agentId && entry.permissionRequestId === permissionRequestId),
      );
      const removed = before - state.pendingClarifications.length;
      if (removed > 0) {
        await persist();
      }
      return removed;
    },

    async removeClarificationsForAgent(agentId) {
      const before = state.pendingClarifications.length;
      state.pendingClarifications = state.pendingClarifications.filter(
        (entry) => entry.agentId !== agentId,
      );
      const removed = before - state.pendingClarifications.length;
      if (removed > 0) {
        await persist();
      }
      return removed;
    },

    getSuppressedQuietBadgeCount() {
      return state.suppressedQuietBadgeCount;
    },

    async incrementSuppressedQuietBadgeCount(delta = 1) {
      state.suppressedQuietBadgeCount += Math.max(0, Math.trunc(delta));
      await persist();
      return state.suppressedQuietBadgeCount;
    },

    getReworkRound(agentId) {
      return state.reworkRounds[agentId] ?? 0;
    },

    async incrementReworkRound(agentId) {
      const next = (state.reworkRounds[agentId] ?? 0) + 1;
      state.reworkRounds[agentId] = next;
      await persist();
      return next;
    },

    getTriage(agentId) {
      return state.triages[agentId] ?? null;
    },

    listTriages() {
      const list = Object.values(state.triages);
      list.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      return list;
    },

    async putTriage(triage) {
      state.triages[triage.agentId] = triage;
      await persist();
    },

    async removeTriage(agentId) {
      if (!(agentId in state.triages)) return;
      delete state.triages[agentId];
      await persist();
    },

    listRecentDelegatedQuestions(agentId, nowMs = getNowMs()) {
      const entries = state.delegatedQuestions[agentId] ?? [];
      return entries.filter((entry) => {
        const ts = Date.parse(entry.at);
        return Number.isFinite(ts) && nowMs - ts <= DELEGATED_QUESTION_TTL_MS;
      });
    },

    async recordDelegatedQuestion(agentId, text) {
      const trimmed = text.trim();
      if (!trimmed) return;
      const list = state.delegatedQuestions[agentId] ?? [];
      list.push({ text: trimmed, at: new Date(getNowMs()).toISOString() });
      state.delegatedQuestions[agentId] = list.slice(-10);
      await persist();
    },

    getLastPatrolAt() {
      return state.lastPatrolAt;
    },

    async setLastPatrolAt(iso) {
      state.lastPatrolAt = iso;
      await persist();
    },

    getLastWakeupAt() {
      return state.lastWakeupAt;
    },

    async setLastWakeupAt(iso) {
      state.lastWakeupAt = iso;
      await persist();
    },

    getMetrics() {
      return { ...state.metrics };
    },

    async incrementMetric(key) {
      state.metrics[key] = (state.metrics[key] ?? 0) + 1;
      await persist();
    },

    async recordTokenUsage(input) {
      const nowMs = input.atMs ?? getNowMs();
      const inputTokens = sanitizeTokenCount(input.inputTokens);
      const cachedInputTokens = sanitizeTokenCount(input.cachedInputTokens);
      const outputTokens = sanitizeTokenCount(input.outputTokens);
      const costUsd = sanitizeCostUsd(input.costUsd);
      const totalTokens = inputTokens + cachedInputTokens + outputTokens;
      if (totalTokens === 0 && costUsd === 0) {
        return buildTokenUsageSummary(state.tokenUsage, nowMs);
      }

      const delta: MainChatTokenUsageCounters = {
        turns: 1,
        inputTokens,
        cachedInputTokens,
        outputTokens,
        totalTokens,
        costUsd,
      };

      addCountersInto(state.tokenUsage.allTime, delta);
      addCountersInto(state.tokenUsage.bySource[input.source], delta);

      const provider = input.provider.trim() || "unknown";
      const model = input.model?.trim() || null;
      const existingModel = state.tokenUsage.byModel.find(
        (entry) => entry.provider === provider && entry.model === model,
      );
      if (existingModel) {
        addCountersInto(existingModel, delta);
      } else {
        state.tokenUsage.byModel.push({
          provider,
          model,
          ...cloneCounters(delta),
        });
        if (state.tokenUsage.byModel.length > MAX_RETAINED_USAGE_MODELS) {
          state.tokenUsage.byModel.sort(
            (left, right) => right.totalTokens - left.totalTokens || right.turns - left.turns,
          );
          state.tokenUsage.byModel = state.tokenUsage.byModel.slice(0, MAX_RETAINED_USAGE_MODELS);
        }
      }

      const dateKey = formatLocalDateKey(nowMs);
      let dayEntry = state.tokenUsage.daily.find((entry) => entry.date === dateKey);
      if (!dayEntry) {
        dayEntry = {
          date: dateKey,
          ...createEmptyMainChatTokenUsageCounters(),
          bySource: createEmptyMainChatTokenUsageBySource(),
        };
        state.tokenUsage.daily.push(dayEntry);
      }
      addCountersInto(dayEntry, delta);
      addCountersInto(dayEntry.bySource[input.source], delta);
      state.tokenUsage.daily = pruneDailyUsage(state.tokenUsage.daily, nowMs);
      state.tokenUsage.updatedAt = new Date(nowMs).toISOString();

      await persist();
      return buildTokenUsageSummary(state.tokenUsage, nowMs);
    },

    getTokenUsageSummary(nowMs = getNowMs()) {
      return buildTokenUsageSummary(state.tokenUsage, nowMs);
    },

    async resetTokenUsage() {
      state.tokenUsage = emptyPersistedTokenUsage();
      await persist();
      return buildTokenUsageSummary(state.tokenUsage, getNowMs());
    },

    getSettingsProposal(proposalId) {
      const entry = state.settingsProposals[proposalId];
      return entry ? { ...entry, changes: [...entry.changes] } : null;
    },

    listSettingsProposals(options) {
      const includeResolved = options?.includeResolved !== false;
      const list = Object.values(state.settingsProposals).filter((entry) => {
        if (options?.mainAgentId && entry.mainAgentId !== options.mainAgentId) return false;
        if (!includeResolved && entry.status !== "pending") return false;
        return true;
      });
      list.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const cloned: MainChatSettingsProposalRecord[] = [];
      for (const entry of list) {
        cloned.push({ ...entry, changes: [...entry.changes] });
      }
      return cloned;
    },

    async putSettingsProposal(proposal) {
      state.settingsProposals[proposal.id] = {
        ...proposal,
        changes: [...proposal.changes],
      };
      await persist();
      return { ...proposal, changes: [...proposal.changes] };
    },

    async appendLimitFallbackEvent(event) {
      state.limitFallbackEvents.push({ ...event });
      if (state.limitFallbackEvents.length > MAX_RETAINED_LIMIT_FALLBACK_EVENTS) {
        state.limitFallbackEvents = state.limitFallbackEvents.slice(
          -MAX_RETAINED_LIMIT_FALLBACK_EVENTS,
        );
      }
      await persist();
      return { ...event };
    },

    listLimitFallbackEvents(limit = 20) {
      const clamped = Math.max(1, Math.min(MAX_RETAINED_LIMIT_FALLBACK_EVENTS, Math.trunc(limit)));
      const recent = state.limitFallbackEvents.slice(-clamped).toReversed();
      const cloned: MainChatLimitFallbackEvent[] = [];
      for (const entry of recent) {
        cloned.push({ ...entry });
      }
      return cloned;
    },

    hasDagWakeMarker(key) {
      return Boolean(state.dagWakeMarkers[key]);
    },

    async recordDagWakeMarker(key, atIso) {
      if (state.dagWakeMarkers[key]) return false;
      state.dagWakeMarkers[key] = atIso ?? new Date(getNowMs()).toISOString();
      const keys = Object.keys(state.dagWakeMarkers);
      if (keys.length > 500) {
        const sorted = keys.sort((left, right) =>
          (state.dagWakeMarkers[right] ?? "").localeCompare(state.dagWakeMarkers[left] ?? ""),
        );
        for (const staleKey of sorted.slice(500)) {
          delete state.dagWakeMarkers[staleKey];
        }
      }
      await persist();
      return true;
    },

    async clearDagWakeMarkersByPrefix(prefix) {
      let removed = 0;
      for (const key of Object.keys(state.dagWakeMarkers)) {
        if (key.startsWith(prefix)) {
          delete state.dagWakeMarkers[key];
          removed += 1;
        }
      }
      if (removed > 0) {
        await persist();
      }
      return removed;
    },

    async recordNotificationReceipt(receipt) {
      const copy: MainChatNotificationReceipt = { ...receipt };
      const existingIdx = state.notificationReceipts.findIndex((item) => item.id === copy.id);
      if (existingIdx >= 0) {
        state.notificationReceipts[existingIdx] = copy;
      } else {
        state.notificationReceipts.push(copy);
        if (state.notificationReceipts.length > MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS) {
          state.notificationReceipts = state.notificationReceipts.slice(
            -MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS,
          );
        }
      }
      await persist();
      return { ...copy };
    },

    async updateNotificationReceiptStatus(id, patch) {
      const idx = state.notificationReceipts.findIndex((item) => item.id === id);
      if (idx < 0) return null;
      const existing = state.notificationReceipts[idx]!;
      const nowIso = patch.updatedAt ?? new Date(getNowMs()).toISOString();
      const updated: MainChatNotificationReceipt = {
        ...existing,
        status: patch.status,
        updatedAt: nowIso,
        ...(patch.deliveredAt !== undefined ? { deliveredAt: patch.deliveredAt } : {}),
        ...(patch.acknowledgedAt !== undefined ? { acknowledgedAt: patch.acknowledgedAt } : {}),
        ...(patch.readAt !== undefined ? { readAt: patch.readAt } : {}),
        ...(patch.reason !== undefined ? { reason: patch.reason } : {}),
      };
      state.notificationReceipts[idx] = updated;
      await persist();
      return { ...updated };
    },

    listNotificationReceipts(options) {
      let list = state.notificationReceipts.slice();
      if (options?.status) {
        list = list.filter((item) => item.status === options.status);
      }
      if (options?.category) {
        list = list.filter((item) => item.category === options.category);
      }
      if (options?.unreadOnly) {
        list = list.filter((item) => item.status !== "read" && item.status !== "acknowledged");
      }
      list.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      const limit = options?.limit
        ? Math.max(1, Math.min(MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS, Math.trunc(options.limit)))
        : MAIN_CHAT_MAX_NOTIFICATION_RECEIPTS;
      return cloneShallowArray(list.slice(0, limit));
    },

    async ackNotificationReceipts(input) {
      const targetStatus = input.status ?? "read";
      const nowIso = input.nowIso ?? new Date(getNowMs()).toISOString();
      const targetIds = new Set<string>();
      if (input.receiptId?.trim()) targetIds.add(input.receiptId.trim());
      for (const id of input.receiptIds ?? []) {
        if (id.trim()) targetIds.add(id.trim());
      }

      let updatedCount = 0;
      const updatedList: MainChatNotificationReceipt[] = [];
      for (let i = 0; i < state.notificationReceipts.length; i += 1) {
        const entry = state.notificationReceipts[i]!;
        const matches =
          input.markAll === true
            ? entry.status !== "read" &&
              (targetStatus === "read" || entry.status !== "acknowledged")
            : targetIds.has(entry.id);
        if (!matches) continue;
        const next: MainChatNotificationReceipt = {
          ...entry,
          status: targetStatus,
          updatedAt: nowIso,
          acknowledgedAt: entry.acknowledgedAt ?? nowIso,
          readAt: targetStatus === "read" ? (entry.readAt ?? nowIso) : (entry.readAt ?? null),
        };
        state.notificationReceipts[i] = next;
        updatedList.push({ ...next });
        updatedCount += 1;
      }

      if (updatedCount > 0) {
        await persist();
      }
      return { updatedCount, receipts: updatedList };
    },

    getNotificationSummary() {
      return computeMainChatNotificationSummary(state.notificationReceipts, state.settings);
    },

    getZeroTokenRuleState() {
      const cloned: Record<string, PersistedZeroTokenAgentWindow> = {};
      for (const [agentId, win] of Object.entries(state.zeroTokenRuleState)) {
        cloned[agentId] = {
          ...win,
          calls: [...win.calls],
        };
      }
      return cloned;
    },

    async setZeroTokenRuleState(next) {
      const cloned: Record<string, PersistedZeroTokenAgentWindow> = {};
      for (const [agentId, win] of Object.entries(next)) {
        cloned[agentId] = {
          ...win,
          calls: [...win.calls],
        };
      }
      state.zeroTokenRuleState = cloned;
      await persist();
    },

    listAdmissionQueue() {
      return cloneShallowArray(recalculateAdmissionQueuePositions(state.admissionQueue));
    },

    async setAdmissionQueue(entries) {
      state.admissionQueue = recalculateAdmissionQueuePositions(
        cloneShallowArray(entries.slice(0, MAIN_CHAT_MAX_ADMISSION_QUEUE)),
      );
      await persist();
      return cloneShallowArray(state.admissionQueue);
    },

    async enqueueAdmissionEntry(entry) {
      const filtered = state.admissionQueue.filter(
        (existing) => existing.id !== entry.id && existing.taskId !== entry.taskId,
      );
      filtered.push({ ...entry });
      state.admissionQueue = recalculateAdmissionQueuePositions(
        filtered.slice(-MAIN_CHAT_MAX_ADMISSION_QUEUE),
      );
      await persist();
      const stored = state.admissionQueue.find((item) => item.id === entry.id) ?? entry;
      return { ...stored };
    },

    async removeAdmissionEntry(queueId) {
      const before = state.admissionQueue.length;
      state.admissionQueue = recalculateAdmissionQueuePositions(
        state.admissionQueue.filter((item) => item.id !== queueId),
      );
      if (state.admissionQueue.length === before) return false;
      await persist();
      return true;
    },

    async removeAdmissionEntriesByTaskId(taskId) {
      const before = state.admissionQueue.length;
      state.admissionQueue = recalculateAdmissionQueuePositions(
        state.admissionQueue.filter((item) => item.taskId !== taskId),
      );
      const removed = before - state.admissionQueue.length;
      if (removed > 0) await persist();
      return removed;
    },

    async clearAdmissionQueue(serverId) {
      const targetServerId = serverId?.trim() || null;
      const removed: MainChatAdmissionQueueEntry[] = [];
      const kept: MainChatAdmissionQueueEntry[] = [];
      for (const item of state.admissionQueue) {
        if (!targetServerId || item.targetServerId === targetServerId) {
          removed.push({ ...item });
        } else {
          kept.push(item);
        }
      }
      if (removed.length > 0) {
        state.admissionQueue = recalculateAdmissionQueuePositions(kept);
        await persist();
      }
      return removed;
    },

    listIdleArchiveAudit(limit = MAIN_CHAT_MAX_IDLE_ARCHIVE_AUDIT_RECORDS) {
      const clamped = Math.max(
        1,
        Math.min(MAIN_CHAT_MAX_IDLE_ARCHIVE_AUDIT_RECORDS, Math.trunc(limit)),
      );
      return cloneShallowArray(state.idleArchiveAudit.slice(0, clamped));
    },

    async appendIdleArchiveAudit(record) {
      state.idleArchiveAudit = [{ ...record }, ...state.idleArchiveAudit].slice(
        0,
        MAIN_CHAT_MAX_IDLE_ARCHIVE_AUDIT_RECORDS,
      );
      await persist();
    },

    getLastIdleArchiveSweepAt() {
      return state.lastIdleArchiveSweepAt;
    },

    async setLastIdleArchiveSweepAt(iso) {
      state.lastIdleArchiveSweepAt = iso;
      await persist();
    },

    listCustomPromptTemplates() {
      return cloneShallowArray(state.promptTemplates);
    },

    async setCustomPromptTemplates(templates) {
      state.promptTemplates = cloneShallowArray(
        templates.filter((entry) => !entry.builtin).slice(0, MAIN_CHAT_MAX_CUSTOM_PROMPT_TEMPLATES),
      );
      await persist();
      return cloneShallowArray(state.promptTemplates);
    },
  };
}
