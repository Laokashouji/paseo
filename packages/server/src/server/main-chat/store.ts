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
  type MainChatAutoStartRule,
  type MainChatDecisionRecord,
  type MainChatMetrics,
  type MainChatPermissionRule,
  type MainChatPlanRecord,
  type MainChatTaskMode,
} from "@getpaseo/protocol/main-chat";

export type MainChatTrustRule = MainChatAutoStartRule;
export type { MainChatMetrics, MainChatPermissionRule };

const PartialMetricsSchema = MainChatMetricsSchema.partial();

const PersistedMainChatStateSchema = z.object({
  version: z.literal(1),
  plans: z.record(z.string(), MainChatPlanRecordSchema).optional(),
  decisions: z.record(z.string(), MainChatDecisionRecordSchema).optional(),
  trustRules: z.array(MainChatAutoStartRuleSchema).optional(),
  permissionRules: z.array(MainChatPermissionRuleSchema).optional(),
  reworkRounds: z.record(z.string(), z.number().int().nonnegative()).optional(),
  metrics: PartialMetricsSchema.optional(),
});

interface MainChatStateFile {
  version: 1;
  plans: Record<string, MainChatPlanRecord>;
  decisions: Record<string, MainChatDecisionRecord>;
  trustRules: MainChatAutoStartRule[];
  permissionRules: MainChatPermissionRule[];
  reworkRounds: Record<string, number>;
  metrics: MainChatMetrics;
}

const MAX_RETAINED_PLANS = 200;
const MAX_RETAINED_DECISIONS = 200;

function emptyMetrics(): MainChatMetrics {
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
  };
}

function emptyState(): MainChatStateFile {
  return {
    version: 1,
    plans: {},
    decisions: {},
    trustRules: [],
    permissionRules: [],
    reworkRounds: {},
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

function pruneMapByCreatedAt<T extends { id: string; createdAt: string }>(
  map: Record<string, T>,
  maxEntries: number,
): void {
  const entries = Object.values(map);
  if (entries.length <= maxEntries) return;
  entries.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const keep = new Set(entries.slice(0, maxEntries).map((item) => item.id));
  for (const id of Object.keys(map)) {
    if (!keep.has(id)) delete map[id];
  }
}

export interface MainChatPermissionRuleLookup {
  toolName: string;
  commandPrefix: string | null;
  cwd?: string | null;
}

export interface MainChatStore {
  load(): Promise<void>;
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
  getMetrics(): MainChatMetrics;
  incrementMetric(key: keyof MainChatMetrics): Promise<void>;
}

export function createMainChatStore(paseoHome: string): MainChatStore {
  const dirPath = path.join(paseoHome, MAIN_CHAT_WORKSPACE_DIR_NAME);
  const filePath = path.join(dirPath, "state.json");
  let state: MainChatStateFile = emptyState();
  let loaded = false;
  let writeChain = Promise.resolve();

  async function persist(): Promise<void> {
    pruneMapByCreatedAt(state.plans, MAX_RETAINED_PLANS);
    pruneMapByCreatedAt(state.decisions, MAX_RETAINED_DECISIONS);
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
            plans: parsed.data.plans ?? {},
            decisions: parsed.data.decisions ?? {},
            trustRules: parsed.data.trustRules ?? [],
            permissionRules: parsed.data.permissionRules ?? [],
            reworkRounds: parsed.data.reworkRounds ?? {},
            metrics: { ...emptyMetrics(), ...parsed.data.metrics },
          };
        }
      } catch {
        // Missing or unreadable state starts clean.
      }
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

    getMetrics() {
      return { ...state.metrics };
    },

    async incrementMetric(key) {
      state.metrics[key] += 1;
      await persist();
    },
  };
}
