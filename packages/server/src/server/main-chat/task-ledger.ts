import path from "node:path";
import type {
  MainChatAutoStartRule,
  MainChatDurationSample,
  MainChatPlannedTask,
  MainChatSessionTriage,
  MainChatTaskBrief,
  MainChatTaskDecisionActor,
  MainChatTaskDecisionEntry,
  MainChatTaskMode,
  MainChatTaskRecord,
  MainChatTaskStatus,
} from "@getpaseo/protocol/main-chat";
import type { ManagedAgent } from "../agent/agent-manager.js";

export const MAX_RETAINED_TASKS = 500;
export const MAX_RETAINED_RECEIPTS = 100;
export const MAX_RETAINED_DURATION_SAMPLES = 256;
export const DURATION_SAMPLE_WINDOW_DAYS = 90;
export const DURATION_SAMPLE_WINDOW_MS = DURATION_SAMPLE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const DURATION_MIN_SAMPLES_FOR_ESTIMATE = 5;
export const DURATION_MEDIAN_RECENT_WINDOW = 32;

export class TaskBriefValidationError extends Error {
  constructor(
    public readonly field: "goal" | "doneWhen" | "scope",
    public readonly mode: MainChatTaskMode,
    message: string,
  ) {
    super(message);
    this.name = "TaskBriefValidationError";
  }
}

export interface ValidatedTaskBriefFields {
  goal: string;
  doneWhen: string[];
  outOfBounds: string[];
}

export interface TaskBriefInput {
  title?: string;
  goal: string;
  mode: MainChatTaskMode;
  doneWhen?: readonly string[];
  outOfBounds?: readonly string[];
}

export interface TaskScopePatchInput {
  goal?: string;
  doneWhen?: readonly string[];
  outOfBounds?: readonly string[];
  reason?: string;
}

export interface TrustRuleMatchInput {
  cwd: string;
  mode: MainChatTaskMode;
  serverId?: string | null;
  localServerId?: string | null;
}

export interface DurationEstimateQuery {
  serverId?: string | null;
  cwd?: string | null;
  mode: MainChatTaskMode;
  provider?: string | null;
}

export interface CreateTaskRecordFromPlanInput {
  id: string;
  mainAgentId: string;
  conversationId?: string | null;
  planId: string;
  plannedTask: MainChatPlannedTask;
  agentId: string | null;
  cwd: string | null;
  workspaceId: string | null;
  serverId?: string | null;
  hostLabel?: string | null;
  nowIso: string;
}

export interface AttachContinuationAgentInput {
  planId: string;
  newAgentId: string;
  cwd?: string | null;
  workspaceId?: string | null;
  workspaceLabel?: string | null;
  serverId?: string | null;
  hostLabel?: string | null;
  continuesWhy?: string | null;
  nowIso: string;
}

export interface AppendTaskDecisionInput {
  id?: string;
  question: string;
  answer: string;
  decidedBy: MainChatTaskDecisionActor;
  nowIso: string;
}

export interface ResolveEffectiveTaskStatusInput {
  task: MainChatTaskRecord;
  liveAgent?: ManagedAgent | null;
  storedStatus?: string | null;
  triage?: MainChatSessionTriage | null;
  hasOpenDecision?: boolean;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((entry) => entry.trim()).filter(Boolean);
}

function makeLedgerId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeTrustCwd(cwd: string): string {
  return path.resolve(cwd.trim());
}

export function normalizeDurationProvider(provider: string | null | undefined): string | null {
  const trimmed = normalizeOptionalString(provider);
  if (!trimmed) return null;
  const slashIndex = trimmed.indexOf("/");
  const base = slashIndex > 0 ? trimmed.slice(0, slashIndex) : trimmed;
  const normalized = base.trim().toLowerCase();
  return normalized || null;
}

/**
 * Checks whether `targetCwd` equals `ruleCwd` or sits strictly beneath `ruleCwd` on a real path
 * separator boundary (`/repo` covers `/repo/packages/app`, never `/repo-other`).
 */
export function isCwdCoveredByTrustRule(
  ruleCwd: string,
  targetCwd: string,
  allowSubdirectories = true,
): boolean {
  const normalizedRule = normalizeTrustCwd(ruleCwd);
  const normalizedTarget = normalizeTrustCwd(targetCwd);
  if (normalizedTarget === normalizedRule) return true;
  if (!allowSubdirectories) return false;
  const prefix = normalizedRule.endsWith(path.sep)
    ? normalizedRule
    : `${normalizedRule}${path.sep}`;
  return normalizedTarget.startsWith(prefix);
}

export function matchesTrustRule(rule: MainChatAutoStartRule, input: TrustRuleMatchInput): boolean {
  if (rule.mode !== input.mode) return false;

  const ruleServer = normalizeOptionalString(rule.serverId);
  const targetServer = normalizeOptionalString(input.serverId);
  const localServer = normalizeOptionalString(input.localServerId);

  const targetIsLocal =
    targetServer === null || (localServer !== null && targetServer === localServer);
  const ruleIsLocal = ruleServer === null || (localServer !== null && ruleServer === localServer);

  if (targetIsLocal) {
    if (!ruleIsLocal) return false;
  } else if (ruleServer === null || ruleServer !== targetServer) {
    return false;
  }

  return isCwdCoveredByTrustRule(rule.cwd, input.cwd, rule.allowSubdirectories !== false);
}

export function findMatchingTrustRule(
  rules: readonly MainChatAutoStartRule[],
  input: TrustRuleMatchInput,
): MainChatAutoStartRule | null {
  return rules.find((rule) => matchesTrustRule(rule, input)) ?? null;
}

export function validateTaskBriefInput(input: TaskBriefInput): ValidatedTaskBriefFields {
  const label = input.title?.trim() || "未命名任务";
  const goal = input.goal.trim();
  const doneWhen = normalizeStringList(input.doneWhen);
  const outOfBounds = normalizeStringList(input.outOfBounds);

  if (!goal) {
    throw new TaskBriefValidationError("goal", input.mode, `任务「${label}」必须提供非空目标 goal`);
  }
  if (input.mode === "write" && doneWhen.length === 0) {
    throw new TaskBriefValidationError(
      "doneWhen",
      input.mode,
      `写操作任务「${label}」必须至少提供 1 条非空验收标准 doneWhen`,
    );
  }

  return { goal, doneWhen, outOfBounds };
}

export function createInitialTaskBrief(
  input: TaskBriefInput & { nowIso: string; scopeRevision?: number },
): MainChatTaskBrief {
  const validated = validateTaskBriefInput(input);
  return {
    goal: validated.goal,
    doneWhen: validated.doneWhen,
    outOfBounds: validated.outOfBounds,
    scopeRevision: input.scopeRevision && input.scopeRevision >= 1 ? input.scopeRevision : 1,
    updatedAt: input.nowIso,
  };
}

export function applyTaskScopeUpdate(
  task: MainChatTaskRecord,
  patch: TaskScopePatchInput,
  nowIso: string,
): {
  task: MainChatTaskRecord;
  changedFields: Array<"goal" | "doneWhen" | "outOfBounds">;
} {
  const hasGoal = patch.goal !== undefined;
  const hasDoneWhen = patch.doneWhen !== undefined;
  const hasOutOfBounds = patch.outOfBounds !== undefined;

  if (!hasGoal && !hasDoneWhen && !hasOutOfBounds) {
    throw new TaskBriefValidationError(
      "scope",
      task.mode,
      "updateTaskScope 至少需要提供 goal、doneWhen 或 outOfBounds 中的一项",
    );
  }

  const validated = validateTaskBriefInput({
    title: task.title,
    mode: task.mode,
    goal: hasGoal ? patch.goal! : task.brief.goal,
    doneWhen: hasDoneWhen ? patch.doneWhen : task.brief.doneWhen,
    outOfBounds: hasOutOfBounds ? patch.outOfBounds : task.brief.outOfBounds,
  });

  const changedFields: Array<"goal" | "doneWhen" | "outOfBounds"> = [];
  if (hasGoal) changedFields.push("goal");
  if (hasDoneWhen) changedFields.push("doneWhen");
  if (hasOutOfBounds) changedFields.push("outOfBounds");

  const nextBrief: MainChatTaskBrief = {
    goal: validated.goal,
    doneWhen: validated.doneWhen,
    outOfBounds: validated.outOfBounds,
    scopeRevision: task.brief.scopeRevision + 1,
    updatedAt: nowIso,
  };

  return {
    task: {
      ...task,
      brief: nextBrief,
      updatedAt: nowIso,
      lastActivityAt: nowIso,
    },
    changedFields,
  };
}

export function buildScopeRevisionNoticePrompt(
  task: MainChatTaskRecord,
  reason?: string | null,
): string {
  const lines: string[] = [
    `【范围变更通知 · Scope Revision #${task.brief.scopeRevision}】`,
    `任务「${task.title}」的 Brief 已升级至 Revision #${task.brief.scopeRevision}，请立即切换到以下最新口径，停止按旧范围继续执行：`,
    "",
    `最新目标：${task.brief.goal}`,
  ];

  if (task.brief.doneWhen.length > 0) {
    lines.push("", "## 最新验收标准");
    for (const criterion of task.brief.doneWhen) {
      lines.push(`- ${criterion}`);
    }
  }

  if (task.brief.outOfBounds.length > 0) {
    lines.push("", "## 最新边界约束");
    for (const rule of task.brief.outOfBounds) {
      lines.push(`- ${rule}`);
    }
  }

  const trimmedReason = normalizeOptionalString(reason);
  if (trimmedReason) {
    lines.push("", `变更原因：${trimmedReason}`);
  }

  lines.push("", "请按上述最新范围继续推进，完成后逐条给出对应验收标准的真实证据。");
  return lines.join("\n");
}

export function createTaskRecordFromPlannedTask(
  input: CreateTaskRecordFromPlanInput,
): MainChatTaskRecord {
  const { plannedTask, agentId, nowIso } = input;
  const brief = createInitialTaskBrief({
    title: plannedTask.title,
    goal: plannedTask.goal,
    mode: plannedTask.mode,
    doneWhen: plannedTask.doneWhen,
    outOfBounds: plannedTask.outOfBounds,
    scopeRevision: plannedTask.scopeRevision ?? 1,
    nowIso,
  });

  let status: MainChatTaskStatus = "open";
  if (agentId) {
    status = "running";
  } else if (plannedTask.startError) {
    status = "failed";
  }

  return {
    id: input.id,
    mainAgentId: input.mainAgentId,
    conversationId: input.conversationId ?? null,
    planId: input.planId,
    title: plannedTask.title,
    mode: plannedTask.mode,
    isolation: plannedTask.isolation,
    serverId: input.serverId ?? plannedTask.serverId ?? null,
    hostLabel: input.hostLabel ?? plannedTask.hostLabel ?? null,
    cwd: input.cwd,
    workspaceId: input.workspaceId,
    workspaceLabel: plannedTask.workspaceLabel,
    status,
    brief,
    agentIds: agentId ? [agentId] : [],
    activeAgentId: agentId,
    continuesTaskId: plannedTask.continuesTaskId ?? null,
    continuesWhy: plannedTask.continuesWhy ?? null,
    supersededByTaskId: null,
    expectedMinutes: plannedTask.expectedMinutes ?? null,
    actualMinutes: null,
    quiet: plannedTask.quiet ?? true,
    parkedAt: null,
    parkedReason: null,
    completedAt: null,
    lastActivityAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
    decisions: [],
    latestReceipt: null,
    reworkCount: 0,
  };
}

/**
 * Mounts a replacement agent onto an existing task record without creating a duplicate card,
 * preserving the original Brief, settled decision table, and creation timestamp.
 */
export function attachContinuationAgentToTask(
  task: MainChatTaskRecord,
  input: AttachContinuationAgentInput,
): MainChatTaskRecord {
  const nextAgentIds = task.agentIds.includes(input.newAgentId)
    ? [...task.agentIds]
    : [...task.agentIds, input.newAgentId];

  return {
    ...task,
    planId: input.planId,
    cwd: input.cwd !== undefined ? input.cwd : task.cwd,
    workspaceId: input.workspaceId !== undefined ? input.workspaceId : task.workspaceId,
    workspaceLabel: input.workspaceLabel?.trim() || task.workspaceLabel,
    serverId: input.serverId !== undefined ? input.serverId : (task.serverId ?? null),
    hostLabel: input.hostLabel !== undefined ? input.hostLabel : (task.hostLabel ?? null),
    status: "running",
    agentIds: nextAgentIds,
    activeAgentId: input.newAgentId,
    continuesWhy: input.continuesWhy ?? task.continuesWhy ?? null,
    parkedAt: null,
    parkedReason: null,
    completedAt: null,
    lastActivityAt: input.nowIso,
    updatedAt: input.nowIso,
  };
}

export function appendTaskDecision(
  task: MainChatTaskRecord,
  input: AppendTaskDecisionInput,
): MainChatTaskRecord {
  const question = input.question.trim();
  const answer = input.answer.trim();
  if (!question || !answer) {
    throw new Error("任务决策记录必须包含非空 question 和 answer");
  }

  const existingDecisions = task.decisions ?? [];
  const entryId = input.id?.trim() || makeLedgerId("tdec");
  const entry: MainChatTaskDecisionEntry = {
    id: entryId,
    taskId: task.id,
    question,
    answer,
    decidedBy: input.decidedBy,
    createdAt: input.nowIso,
  };

  const existingIndex = existingDecisions.findIndex((item) => item.id === entryId);
  const nextDecisions =
    existingIndex >= 0
      ? existingDecisions.map((item, idx) => (idx === existingIndex ? entry : item))
      : [...existingDecisions, entry];

  return {
    ...task,
    decisions: nextDecisions,
    lastActivityAt: input.nowIso,
    updatedAt: input.nowIso,
  };
}

function formatDecisionActorLabel(actor: MainChatTaskDecisionActor): string {
  if (actor === "user") return "用户";
  if (actor === "leader") return "方向主管";
  return "督办";
}

export function formatTaskDecisionsPromptSection(
  decisions: readonly MainChatTaskDecisionEntry[] | undefined,
): string | null {
  if (!decisions || decisions.length === 0) return null;
  const lines: string[] = ["## 已拍板决策清单（以下问题已定案，请直接遵循，切勿重复追问）"];
  for (let index = 0; index < decisions.length; index += 1) {
    const entry = decisions[index]!;
    lines.push(
      `${index + 1}. [${formatDecisionActorLabel(entry.decidedBy)}] 问题：${entry.question} → 结论：${entry.answer}`,
    );
  }
  return lines.join("\n");
}

export function pruneDurationSamples(
  samples: readonly MainChatDurationSample[],
  nowMs = Date.now(),
): MainChatDurationSample[] {
  const fresh = samples.filter((sample) => {
    if (!Number.isFinite(sample.durationMinutes) || sample.durationMinutes <= 0) return false;
    const completedMs = Date.parse(sample.completedAt);
    return Number.isFinite(completedMs) && nowMs - completedMs <= DURATION_SAMPLE_WINDOW_MS;
  });

  fresh.sort((left, right) => Date.parse(left.completedAt) - Date.parse(right.completedAt));
  if (fresh.length <= MAX_RETAINED_DURATION_SAMPLES) {
    return fresh;
  }
  return fresh.slice(-MAX_RETAINED_DURATION_SAMPLES);
}

export function computeMedian(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error("Cannot compute median of an empty array");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle]!;
  }
  return (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function estimateFromBucket(bucket: readonly MainChatDurationSample[]): number | null {
  if (bucket.length < DURATION_MIN_SAMPLES_FOR_ESTIMATE) return null;
  const recent = [...bucket]
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))
    .slice(0, DURATION_MEDIAN_RECENT_WINDOW);
  const median = computeMedian(recent.map((sample) => sample.durationMinutes));
  return Math.max(1, Math.round(median));
}

/**
 * Estimates expected task duration in integer minutes using a strict 3-tier fallback over the
 * last 90 days of completed task samples (minimum 5 samples per tier, median of most recent 32):
 * 1. Same serverId + same cwd + same mode
 * 2. Same serverId + same mode
 * 3. Generic mode + provider
 */
export function estimateExpectedMinutes(
  samples: readonly MainChatDurationSample[],
  query: DurationEstimateQuery,
  nowMs = Date.now(),
): number | null {
  const windowSamples = pruneDurationSamples(samples, nowMs);
  if (windowSamples.length < DURATION_MIN_SAMPLES_FOR_ESTIMATE) {
    return null;
  }

  const targetServerId = normalizeOptionalString(query.serverId);
  const targetCwd = query.cwd?.trim() ? normalizeTrustCwd(query.cwd) : null;
  const targetProvider = normalizeDurationProvider(query.provider);

  // Tier 1: same serverId + same cwd + same mode
  if (targetCwd !== null) {
    const tier1 = windowSamples.filter(
      (sample) =>
        sample.mode === query.mode &&
        normalizeOptionalString(sample.serverId) === targetServerId &&
        sample.cwd !== null &&
        normalizeTrustCwd(sample.cwd) === targetCwd,
    );
    const tier1Estimate = estimateFromBucket(tier1);
    if (tier1Estimate !== null) return tier1Estimate;
  }

  // Tier 2: same serverId + same mode
  const tier2 = windowSamples.filter(
    (sample) =>
      sample.mode === query.mode && normalizeOptionalString(sample.serverId) === targetServerId,
  );
  const tier2Estimate = estimateFromBucket(tier2);
  if (tier2Estimate !== null) return tier2Estimate;

  // Tier 3: generic mode + provider
  const tier3 = windowSamples.filter((sample) => {
    if (sample.mode !== query.mode) return false;
    if (targetProvider === null) return true;
    return normalizeDurationProvider(sample.provider) === targetProvider;
  });
  return estimateFromBucket(tier3);
}

export function computeTaskDurationMinutes(
  startIso: string | null | undefined,
  endIso: string,
): { actualMinutes: number; sampleMinutes: number } {
  const endMs = Date.parse(endIso);
  const startMs = startIso ? Date.parse(startIso) : Number.NaN;
  const elapsedMs =
    Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
  const actualMinutes = Math.max(0, Number((elapsedMs / 60_000).toFixed(2)));
  const sampleMinutes = Math.max(0.1, actualMinutes);
  return { actualMinutes, sampleMinutes };
}

function resolveStatusFromTriage(triage: MainChatSessionTriage): MainChatTaskStatus | null {
  if (triage.phase === "blocked_user" || triage.phase === "blocked_external") {
    return "needs_you";
  }
  if (triage.phase === "interrupted") return "failed";
  if (triage.phase === "done") return "awaiting_review";
  return null;
}

function resolveStatusFromLiveAgent(
  liveAgent: ManagedAgent,
  triage: MainChatSessionTriage | null | undefined,
  fallbackStatus: MainChatTaskStatus,
): MainChatTaskStatus {
  if (liveAgent.pendingPermissions.size > 0) return "needs_you";
  if (liveAgent.lifecycle === "running" || liveAgent.lifecycle === "initializing") {
    return "running";
  }
  if (liveAgent.lifecycle === "error") return "failed";

  if (triage) {
    const triageStatus = resolveStatusFromTriage(triage);
    if (triageStatus) return triageStatus;
  }

  if (liveAgent.attention?.requiresAttention) {
    if (liveAgent.attention.attentionReason === "permission") return "needs_you";
    if (liveAgent.attention.attentionReason === "error") return "failed";
    if (liveAgent.attention.attentionReason === "finished") return "awaiting_review";
  }
  return fallbackStatus;
}

export function resolveEffectiveTaskStatus(
  input: ResolveEffectiveTaskStatusInput,
): MainChatTaskStatus {
  const { task, liveAgent, storedStatus, triage, hasOpenDecision } = input;

  if (task.status === "completed" || task.status === "cancelled" || task.status === "parked") {
    return task.status;
  }
  if (hasOpenDecision) {
    return "needs_you";
  }
  if (liveAgent) {
    return resolveStatusFromLiveAgent(liveAgent, triage, task.status);
  }
  if (storedStatus === "error") {
    return "failed";
  }
  return task.status;
}

export function pruneTaskRecordList(
  tasks: readonly MainChatTaskRecord[],
  maxEntries = MAX_RETAINED_TASKS,
): MainChatTaskRecord[] {
  if (tasks.length <= maxEntries) return [...tasks];

  const active: MainChatTaskRecord[] = [];
  const terminal: MainChatTaskRecord[] = [];
  for (const task of tasks) {
    if (task.status === "completed" || task.status === "cancelled") {
      terminal.push(task);
    } else {
      active.push(task);
    }
  }

  active.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  terminal.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  if (active.length >= maxEntries) {
    return active.slice(0, maxEntries);
  }
  return [...active, ...terminal.slice(0, maxEntries - active.length)];
}
