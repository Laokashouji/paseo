import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  MAIN_CHAT_WORKSPACE_DIR_NAME,
  MainChatActivityEntrySchema,
  MainChatAutoStartRuleSchema,
  MainChatCompactionReasonSchema,
  MainChatCompactionStrategySchema,
  MainChatDecisionRecordSchema,
  MainChatDurationSampleSchema,
  MainChatMetricsSchema,
  MainChatPermissionRuleSchema,
  MainChatPlanRecordSchema,
  MainChatSessionTriageSchema,
  MainChatSettingsSchema,
  MainChatTaskReceiptSchema,
  MainChatTaskRecordSchema,
  createDefaultMainChatSettings,
  mergeMainChatSettings,
  type MainChatActivityEntry,
  type MainChatActivityKind,
  type MainChatAutoStartRule,
  type MainChatCompactionReason,
  type MainChatCompactionStrategy,
  type MainChatDecisionRecord,
  type MainChatDurationSample,
  type MainChatMetrics,
  type MainChatPermissionRule,
  type MainChatPlanRecord,
  type MainChatSessionTriage,
  type MainChatSettings,
  type MainChatSettingsPatch,
  type MainChatTaskMode,
  type MainChatTaskReceipt,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import {
  MAX_RETAINED_RECEIPTS,
  MAX_RETAINED_TASKS,
  matchesTrustRule,
  normalizeTrustCwd,
  pruneDurationSamples,
  pruneTaskRecordList,
} from "./task-ledger.js";

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

const PersistedMainChatStateSchema = z.object({
  version: z.literal(1),
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
  reworkRounds: z.record(z.string(), z.number().int().nonnegative()).optional(),
  triages: z.record(z.string(), MainChatSessionTriageSchema).optional(),
  delegatedQuestions: z.record(z.string(), z.array(DelegatedQuestionEntrySchema)).optional(),
  lastPatrolAt: z.string().nullable().optional(),
  lastWakeupAt: z.string().nullable().optional(),
  metrics: PartialMetricsSchema.optional(),
});

interface MainChatStateFile {
  version: 1;
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
  reworkRounds: Record<string, number>;
  triages: Record<string, MainChatSessionTriage>;
  delegatedQuestions: Record<string, DelegatedQuestionEntry[]>;
  lastPatrolAt: string | null;
  lastWakeupAt: string | null;
  metrics: MainChatFullMetrics;
}

export const MAX_RETAINED_ACTIVITIES = 200;
const MAX_RETAINED_PLANS = 200;
const MAX_RETAINED_DECISIONS = 200;
const MAX_RETAINED_TRIAGES = 200;
const DELEGATED_QUESTION_TTL_MS = 24 * 60 * 60 * 1000;

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
  };
}

function emptyState(): MainChatStateFile {
  return {
    version: 1,
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
    reworkRounds: {},
    triages: {},
    delegatedQuestions: {},
    lastPatrolAt: null,
    lastWakeupAt: null,
    metrics: emptyMetrics(),
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

export interface MainChatStore {
  load(): Promise<void>;
  getSettings(): MainChatSettings;
  updateSettings(patch: MainChatSettingsPatch): Promise<MainChatSettings>;
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
}

function hydratePersistedState(
  data: z.infer<typeof PersistedMainChatStateSchema>,
  nowMs: number,
): MainChatStateFile {
  const compactionByMainAgent: Record<string, PersistedMainChatCompactionMeta> = {};
  for (const [key, value] of Object.entries(data.compactionByMainAgent ?? {})) {
    compactionByMainAgent[key] = {
      lastCompactedAt: value.lastCompactedAt,
      lastError: value.lastError,
      summary: value.summary,
      reason: value.reason ?? null,
      strategy: value.strategy ?? null,
    };
  }
  return {
    version: 1,
    settings: data.settings ?? createDefaultMainChatSettings("conservative"),
    plans: data.plans ?? {},
    tasks: pruneTaskRecordList(data.tasks ?? [], MAX_RETAINED_TASKS),
    decisions: data.decisions ?? {},
    receipts: (data.receipts ?? []).slice(-MAX_RETAINED_RECEIPTS),
    durationSamples: pruneDurationSamples(data.durationSamples ?? [], nowMs),
    activities: data.activities ?? [],
    compactionByMainAgent,
    pendingHandoffByMainAgent: data.pendingHandoffByMainAgent ?? {},
    trustRules: data.trustRules ?? [],
    permissionRules: data.permissionRules ?? [],
    reworkRounds: data.reworkRounds ?? {},
    triages: data.triages ?? {},
    delegatedQuestions: data.delegatedQuestions ?? {},
    lastPatrolAt: data.lastPatrolAt ?? null,
    lastWakeupAt: data.lastWakeupAt ?? null,
    metrics: { ...emptyMetrics(), ...data.metrics },
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
    pruneMapByTimestamp(state.triages, MAX_RETAINED_TRIAGES, (entry) => entry.updatedAt);
    state.tasks = pruneTaskRecordList(state.tasks, MAX_RETAINED_TASKS);
    state.durationSamples = pruneDurationSamples(state.durationSamples, nowMs);
    if (state.receipts.length > MAX_RETAINED_RECEIPTS) {
      state.receipts = state.receipts.slice(-MAX_RETAINED_RECEIPTS);
    }
    if (state.activities.length > MAX_RETAINED_ACTIVITIES) {
      state.activities = state.activities.slice(-MAX_RETAINED_ACTIVITIES);
    }
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

    getSettings() {
      return {
        ...state.settings,
        backgroundModel: { ...state.settings.backgroundModel },
        intervals: { ...state.settings.intervals },
        capabilities: { ...state.settings.capabilities },
      };
    },

    async updateSettings(patch) {
      state.settings = mergeMainChatSettings(state.settings, patch);
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
      return state.trustRules.some((rule) =>
        matchesTrustRule(rule, {
          cwd,
          mode,
          serverId: options?.serverId,
          localServerId: options?.localServerId,
        }),
      );
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
      await persist();
      return rule;
    },

    async removeTrustRule(ruleId) {
      const before = state.trustRules.length;
      state.trustRules = state.trustRules.filter((rule) => rule.id !== ruleId);
      if (state.trustRules.length === before) return false;
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
        createdAt: new Date().toISOString(),
      };
      state.permissionRules.push(rule);
      await persist();
      return rule;
    },

    async removePermissionRule(ruleId) {
      const before = state.permissionRules.length;
      state.permissionRules = state.permissionRules.filter((rule) => rule.id !== ruleId);
      if (state.permissionRules.length === before) return false;
      await persist();
      return true;
    },

    listPermissionRules() {
      return [...state.permissionRules];
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

    listRecentDelegatedQuestions(agentId, nowMs = Date.now()) {
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
      list.push({ text: trimmed, at: new Date().toISOString() });
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
  };
}
