import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  MAIN_CHAT_WORKSPACE_DIR_NAME,
  MainChatAutoStartRuleSchema,
  MainChatDecisionRecordSchema,
  MainChatMetricsSchema,
  MainChatPermissionRuleSchema,
  MainChatPlanRecordSchema,
  MainChatSessionTriageSchema,
  MainChatSettingsSchema,
  createDefaultMainChatSettings,
  mergeMainChatSettings,
  type MainChatAutoStartRule,
  type MainChatDecisionRecord,
  type MainChatMetrics,
  type MainChatPermissionRule,
  type MainChatPlanRecord,
  type MainChatSessionTriage,
  type MainChatSettings,
  type MainChatSettingsPatch,
  type MainChatTaskMode,
} from "@getpaseo/protocol/main-chat";

export type MainChatTrustRule = MainChatAutoStartRule;
export type MainChatFullMetrics = Required<MainChatMetrics>;
export type { MainChatMetrics, MainChatPermissionRule };

const PartialMetricsSchema = MainChatMetricsSchema.partial();

const DelegatedQuestionEntrySchema = z.object({
  text: z.string(),
  at: z.string(),
});
export type DelegatedQuestionEntry = z.infer<typeof DelegatedQuestionEntrySchema>;

const PersistedMainChatStateSchema = z.object({
  version: z.literal(1),
  settings: MainChatSettingsSchema.optional(),
  plans: z.record(z.string(), MainChatPlanRecordSchema).optional(),
  decisions: z.record(z.string(), MainChatDecisionRecordSchema).optional(),
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
  decisions: Record<string, MainChatDecisionRecord>;
  trustRules: MainChatAutoStartRule[];
  permissionRules: MainChatPermissionRule[];
  reworkRounds: Record<string, number>;
  triages: Record<string, MainChatSessionTriage>;
  delegatedQuestions: Record<string, DelegatedQuestionEntry[]>;
  lastPatrolAt: string | null;
  lastWakeupAt: string | null;
  metrics: MainChatFullMetrics;
}

const MAX_RETAINED_PLANS = 200;
const MAX_RETAINED_DECISIONS = 200;
const MAX_RETAINED_TRIAGES = 200;
const DELEGATED_QUESTION_TTL_MS = 24 * 60 * 60 * 1000;

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
  };
}

function emptyState(): MainChatStateFile {
  return {
    version: 1,
    settings: createDefaultMainChatSettings("conservative"),
    plans: {},
    decisions: {},
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

export interface MainChatStore {
  load(): Promise<void>;
  getSettings(): MainChatSettings;
  updateSettings(patch: MainChatSettingsPatch): Promise<MainChatSettings>;
  getPlan(planId: string): MainChatPlanRecord | null;
  listPlans(mainAgentId?: string): MainChatPlanRecord[];
  putPlan(plan: MainChatPlanRecord): Promise<void>;
  getDecision(decisionId: string): MainChatDecisionRecord | null;
  listDecisions(mainAgentId?: string): MainChatDecisionRecord[];
  putDecision(decision: MainChatDecisionRecord): Promise<void>;
  hasTrustRule(cwd: string, mode: MainChatTaskMode): boolean;
  addTrustRule(cwd: string, mode: MainChatTaskMode): Promise<MainChatAutoStartRule>;
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

export function createMainChatStore(paseoHome: string): MainChatStore {
  const dirPath = path.join(paseoHome, MAIN_CHAT_WORKSPACE_DIR_NAME);
  const filePath = path.join(dirPath, "state.json");
  let state: MainChatStateFile = emptyState();
  let loaded = false;
  let writeChain = Promise.resolve();

  async function persist(): Promise<void> {
    pruneMapByTimestamp(state.plans, MAX_RETAINED_PLANS, (entry) => entry.createdAt);
    pruneMapByTimestamp(state.decisions, MAX_RETAINED_DECISIONS, (entry) => entry.createdAt);
    pruneMapByTimestamp(state.triages, MAX_RETAINED_TRIAGES, (entry) => entry.updatedAt);
    pruneDelegatedQuestions(state.delegatedQuestions, Date.now());
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
          state = {
            version: 1,
            settings: parsed.data.settings ?? createDefaultMainChatSettings("conservative"),
            plans: parsed.data.plans ?? {},
            decisions: parsed.data.decisions ?? {},
            trustRules: parsed.data.trustRules ?? [],
            permissionRules: parsed.data.permissionRules ?? [],
            reworkRounds: parsed.data.reworkRounds ?? {},
            triages: parsed.data.triages ?? {},
            delegatedQuestions: parsed.data.delegatedQuestions ?? {},
            lastPatrolAt: parsed.data.lastPatrolAt ?? null,
            lastWakeupAt: parsed.data.lastWakeupAt ?? null,
            metrics: { ...emptyMetrics(), ...parsed.data.metrics },
          };
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

    hasTrustRule(cwd, mode) {
      const normalized = normalizeCwdKey(cwd);
      return state.trustRules.some(
        (rule) => normalizeCwdKey(rule.cwd) === normalized && rule.mode === mode,
      );
    },

    async addTrustRule(cwd, mode) {
      const normalized = normalizeCwdKey(cwd);
      const existing = state.trustRules.find(
        (rule) => normalizeCwdKey(rule.cwd) === normalized && rule.mode === mode,
      );
      if (existing) return existing;
      const rule: MainChatAutoStartRule = {
        id: makeRuleId("trust"),
        cwd: normalized,
        mode,
        createdAt: new Date().toISOString(),
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
