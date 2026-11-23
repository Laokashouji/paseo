import type {
  MainChatDecisionRecord,
  MainChatOverview,
  MainChatPlanRecord,
  MainChatSessionTriage,
  MainChatTaskMode,
  MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import type { PendingPermission } from "@/types/shared";

export const STALE_IN_PROGRESS_THRESHOLD_MS = 48 * 60 * 60 * 1000;
export const COMPLETED_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ActionBarBucketKey =
  | "needsYou"
  | "inProgress"
  | "awaitingReview"
  | "parked"
  | "completed24h";

export interface ActionBarLiveAgentSnapshot {
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  title: string;
  cwd: string | null;
  status: string;
  turnPhase: "idle" | "open";
  hasBackgroundWork: boolean;
  requiresAttention: boolean;
  attentionReason: string | null;
  archived: boolean;
  background: boolean;
  isMainChat: boolean;
  managedByMainChat: boolean;
  mode: MainChatTaskMode | null;
  taskRecordId: string | null;
  planId: string | null;
  updatedAtMs: number;
  lastActivityAtMs: number;
}

export interface ActionBarPendingPermissionInput {
  serverId: string;
  permission: PendingPermission;
  sourceAgentTitle?: string | null;
  sourceAgentCwd?: string | null;
}

export interface BuildActionBarModelInput {
  serverId: string;
  mainAgentId: string;
  overview: MainChatOverview | null;
  liveAgents: readonly ActionBarLiveAgentSnapshot[];
  pendingPermissions: readonly ActionBarPendingPermissionInput[];
  hostLabelsByServerId?: Readonly<Record<string, string>>;
  nowMs?: number;
}

export interface ActionBarPermissionNeedsYouItem {
  kind: "permission";
  id: string;
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  taskId: string | null;
  title: string;
  hostLabel: string | null;
  cwd: string | null;
  reason: string | null;
  permission: PendingPermission;
  permissions: readonly PendingPermission[];
  taskRecord: MainChatTaskRecord | null;
  updatedAtMs: number;
}

export interface ActionBarDecisionNeedsYouItem {
  kind: "decision";
  id: string;
  serverId: string;
  agentId: string | null;
  workspaceId: string | null;
  taskId: string | null;
  title: string;
  hostLabel: string | null;
  reason: string | null;
  decision: MainChatDecisionRecord;
  taskRecord: MainChatTaskRecord | null;
  updatedAtMs: number;
}

export interface ActionBarPlanNeedsYouItem {
  kind: "plan";
  id: string;
  serverId: string;
  agentId: null;
  workspaceId: string | null;
  taskId: string | null;
  title: string;
  hostLabel: string | null;
  reason: string | null;
  plan: MainChatPlanRecord;
  updatedAtMs: number;
}

export interface ActionBarTaskNeedsYouItem {
  kind: "task";
  id: string;
  serverId: string;
  agentId: string | null;
  workspaceId: string | null;
  taskId: string | null;
  title: string;
  hostLabel: string | null;
  workspaceLabel: string | null;
  mode: MainChatTaskMode | null;
  reason: string | null;
  isFailed: boolean;
  taskRecord: MainChatTaskRecord | null;
  updatedAtMs: number;
}

export type ActionBarNeedsYouItem =
  | ActionBarPermissionNeedsYouItem
  | ActionBarDecisionNeedsYouItem
  | ActionBarPlanNeedsYouItem
  | ActionBarTaskNeedsYouItem;

export interface ActionBarTaskItem {
  id: string;
  serverId: string;
  agentId: string | null;
  workspaceId: string | null;
  taskId: string | null;
  title: string;
  hostLabel: string | null;
  workspaceLabel: string | null;
  mode: MainChatTaskMode | null;
  summary: string | null;
  stale48h: boolean;
  isLiveRunning: boolean;
  lastActivityAtMs: number;
  completedAtMs: number | null;
  parkedReason: string | null;
  taskRecord: MainChatTaskRecord | null;
}

export interface ActionBarInProgressBucket {
  active: ActionBarTaskItem[];
  stale: ActionBarTaskItem[];
  all: ActionBarTaskItem[];
}

export interface ActionBarCounts {
  needsYou: number;
  inProgress: number;
  inProgressActive: number;
  inProgressStale: number;
  awaitingReview: number;
  parked: number;
  completed24h: number;
  total: number;
}

export interface MainChatActionBarModel {
  needsYou: ActionBarNeedsYouItem[];
  inProgress: ActionBarInProgressBucket;
  awaitingReview: ActionBarTaskItem[];
  parked: ActionBarTaskItem[];
  completed24h: ActionBarTaskItem[];
  counts: ActionBarCounts;
}

function directoryBasename(dirPath: string | null | undefined): string | null {
  if (!dirPath) return null;
  const trimmed = dirPath.replace(/[\\/]+$/, "");
  if (!trimmed) return null;
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function parseTimestampMs(iso: string | null | undefined, fallbackMs = 0): number {
  if (!iso) return fallbackMs;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? fallbackMs : parsed;
}

function agentScopeKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

function isLiveAgentRunning(agent: ActionBarLiveAgentSnapshot | undefined): boolean {
  if (!agent) return false;
  return agent.turnPhase === "open" || agent.status === "running" || agent.hasBackgroundWork;
}

function resolveTaskServerId(task: MainChatTaskRecord, defaultServerId: string): string {
  return task.serverId?.trim() || defaultServerId;
}

function resolveTaskPrimaryAgentId(task: MainChatTaskRecord): string | null {
  if (task.activeAgentId?.trim()) return task.activeAgentId.trim();
  const last = task.agentIds.at(-1);
  return last?.trim() || null;
}

function resolveTaskHostLabel(
  task: MainChatTaskRecord,
  serverId: string,
  hostLabelsByServerId?: Readonly<Record<string, string>>,
): string | null {
  return task.hostLabel?.trim() || hostLabelsByServerId?.[serverId] || null;
}

function resolveAllTaskAgentIds(task: MainChatTaskRecord): string[] {
  const ids = new Set<string>();
  if (task.activeAgentId?.trim()) ids.add(task.activeAgentId.trim());
  for (const id of task.agentIds) {
    if (id.trim()) ids.add(id.trim());
  }
  return [...ids];
}

function isPlanAlreadyStarted(plan: MainChatPlanRecord): boolean {
  if (plan.status !== "open") return true;
  return plan.tasks.some((task) => Boolean(task.agentId));
}

function dedupePendingPermissions(
  inputs: readonly ActionBarPendingPermissionInput[],
): ActionBarPendingPermissionInput[] {
  const seenRequestKeys = new Set<string>();
  const seenPermKeys = new Set<string>();
  const result: ActionBarPendingPermissionInput[] = [];
  for (const entry of inputs) {
    const requestKey = `${entry.serverId}:${entry.permission.agentId}:${entry.permission.request.id}`;
    const permKey = `${entry.serverId}:${entry.permission.key}`;
    if (seenRequestKeys.has(requestKey) || seenPermKeys.has(permKey)) continue;
    seenRequestKeys.add(requestKey);
    seenPermKeys.add(permKey);
    result.push(entry);
  }
  return result;
}

function sortByRecencyDesc<T extends { updatedAtMs: number }>(items: T[]): T[] {
  return items.sort((left, right) => right.updatedAtMs - left.updatedAtMs);
}

function sortTasksByActivityDesc(items: ActionBarTaskItem[]): ActionBarTaskItem[] {
  return items.sort((left, right) => right.lastActivityAtMs - left.lastActivityAtMs);
}

interface ActionBarBuildContext {
  readonly input: BuildActionBarModelInput;
  readonly nowMs: number;
  readonly tasks: readonly MainChatTaskRecord[];
  readonly plans: readonly MainChatPlanRecord[];
  readonly decisions: readonly MainChatDecisionRecord[];
  readonly liveAgentByKey: Map<string, ActionBarLiveAgentSnapshot>;
  readonly liveAgentById: Map<string, ActionBarLiveAgentSnapshot>;
  readonly triageByAgentId: Map<string, MainChatSessionTriage>;
  readonly taskById: Map<string, MainChatTaskRecord>;
  readonly taskByAgentId: Map<string, MainChatTaskRecord>;
  readonly awaitingReviewAgentIds: Set<string>;
  readonly parkedAgentIds: Set<string>;
  readonly terminalExcludedAgentIds: Set<string>;
  readonly claimedAgentKeys: Set<string>;
  readonly claimedAgentIds: Set<string>;
  readonly claimedTaskIds: Set<string>;
  readonly claimedDecisionIds: Set<string>;
  readonly claimedPlanIds: Set<string>;
  readonly needsYou: ActionBarNeedsYouItem[];
  readonly awaitingReview: ActionBarTaskItem[];
  readonly parked: ActionBarTaskItem[];
  readonly inProgressActive: ActionBarTaskItem[];
  readonly inProgressStale: ActionBarTaskItem[];
  readonly completed24h: ActionBarTaskItem[];
}

function createActionBarBuildContext(input: BuildActionBarModelInput): ActionBarBuildContext {
  const nowMs = input.nowMs ?? Date.now();
  const tasks = input.overview?.tasks ?? [];
  const plans = input.overview?.plans ?? [];
  const decisions = input.overview?.decisions ?? [];
  const triages = input.overview?.triages ?? [];

  const liveAgentByKey = new Map<string, ActionBarLiveAgentSnapshot>();
  const liveAgentById = new Map<string, ActionBarLiveAgentSnapshot>();
  for (const agent of input.liveAgents) {
    liveAgentByKey.set(agentScopeKey(agent.serverId, agent.agentId), agent);
    if (!liveAgentById.has(agent.agentId) || agent.serverId === input.serverId) {
      liveAgentById.set(agent.agentId, agent);
    }
  }

  const triageByAgentId = new Map<string, MainChatSessionTriage>();
  for (const triage of triages) {
    triageByAgentId.set(triage.agentId, triage);
  }

  const taskById = new Map<string, MainChatTaskRecord>();
  const taskByAgentId = new Map<string, MainChatTaskRecord>();
  const awaitingReviewAgentIds = new Set<string>();
  const parkedAgentIds = new Set<string>();
  const terminalExcludedAgentIds = new Set<string>();

  for (const task of tasks) {
    taskById.set(task.id, task);
    indexTaskAgents(task, {
      taskByAgentId,
      awaitingReviewAgentIds,
      parkedAgentIds,
      terminalExcludedAgentIds,
    });
  }

  return {
    input,
    nowMs,
    tasks,
    plans,
    decisions,
    liveAgentByKey,
    liveAgentById,
    triageByAgentId,
    taskById,
    taskByAgentId,
    awaitingReviewAgentIds,
    parkedAgentIds,
    terminalExcludedAgentIds,
    claimedAgentKeys: new Set<string>(),
    claimedAgentIds: new Set<string>(),
    claimedTaskIds: new Set<string>(),
    claimedDecisionIds: new Set<string>(),
    claimedPlanIds: new Set<string>(),
    needsYou: [],
    awaitingReview: [],
    parked: [],
    inProgressActive: [],
    inProgressStale: [],
    completed24h: [],
  };
}

function indexTaskAgents(
  task: MainChatTaskRecord,
  maps: {
    taskByAgentId: Map<string, MainChatTaskRecord>;
    awaitingReviewAgentIds: Set<string>;
    parkedAgentIds: Set<string>;
    terminalExcludedAgentIds: Set<string>;
  },
): void {
  const isTerminal = task.status === "cancelled" || Boolean(task.supersededByTaskId);
  for (const agentId of resolveAllTaskAgentIds(task)) {
    const existing = maps.taskByAgentId.get(agentId);
    if (!existing || existing.supersededByTaskId || existing.status === "completed") {
      maps.taskByAgentId.set(agentId, task);
    }
    if (task.status === "awaiting_review") {
      maps.awaitingReviewAgentIds.add(agentId);
    } else if (task.status === "parked") {
      maps.parkedAgentIds.add(agentId);
    } else if (isTerminal) {
      maps.terminalExcludedAgentIds.add(agentId);
    }
  }
}

function claimAgent(
  ctx: ActionBarBuildContext,
  serverId: string,
  agentId: string | null | undefined,
): void {
  if (!agentId) return;
  ctx.claimedAgentKeys.add(agentScopeKey(serverId, agentId));
  ctx.claimedAgentIds.add(agentId);
}

function isAgentClaimed(
  ctx: ActionBarBuildContext,
  serverId: string,
  agentId: string | null | undefined,
): boolean {
  if (!agentId) return false;
  return (
    ctx.claimedAgentKeys.has(agentScopeKey(serverId, agentId)) || ctx.claimedAgentIds.has(agentId)
  );
}

function claimTask(ctx: ActionBarBuildContext, task: MainChatTaskRecord | null | undefined): void {
  if (!task) return;
  ctx.claimedTaskIds.add(task.id);
  const srvId = resolveTaskServerId(task, ctx.input.serverId);
  for (const agentId of resolveAllTaskAgentIds(task)) {
    claimAgent(ctx, srvId, agentId);
  }
}

function lookupLiveAgent(
  ctx: ActionBarBuildContext,
  serverId: string,
  agentId: string | null | undefined,
): ActionBarLiveAgentSnapshot | undefined {
  if (!agentId) return undefined;
  return ctx.liveAgentByKey.get(agentScopeKey(serverId, agentId)) ?? ctx.liveAgentById.get(agentId);
}

function resolveLinkedTaskForAgent(
  ctx: ActionBarBuildContext,
  agentId: string | null | undefined,
  explicitTaskId?: string | null,
): MainChatTaskRecord | null {
  if (explicitTaskId) {
    const byId = ctx.taskById.get(explicitTaskId);
    if (byId) return byId;
  }
  if (!agentId) return null;
  const live = ctx.liveAgentById.get(agentId);
  if (live?.taskRecordId) {
    const byRecord = ctx.taskById.get(live.taskRecordId);
    if (byRecord) return byRecord;
  }
  return ctx.taskByAgentId.get(agentId) ?? null;
}

function resolveTaskActivityMs(
  task: MainChatTaskRecord,
  live: ActionBarLiveAgentSnapshot | undefined,
  primaryTimestamp?: string | null,
): number {
  const baseMs = parseTimestampMs(task.lastActivityAt, parseTimestampMs(task.updatedAt));
  const taskMs = primaryTimestamp ? parseTimestampMs(primaryTimestamp, baseMs) : baseMs;
  return Math.max(taskMs, live?.lastActivityAtMs ?? 0);
}

function buildTaskItemBase(
  ctx: ActionBarBuildContext,
  task: MainChatTaskRecord,
  srvId: string,
  primaryAgentId: string | null,
  live: ActionBarLiveAgentSnapshot | undefined,
  overrides: {
    summary: string | null;
    stale48h: boolean;
    isLiveRunning: boolean;
    lastActivityAtMs: number;
    completedAtMs: number | null;
    parkedReason: string | null;
  },
): ActionBarTaskItem {
  return {
    id: `task:${task.id}`,
    serverId: srvId,
    agentId: primaryAgentId,
    workspaceId: live?.workspaceId ?? task.workspaceId ?? null,
    taskId: task.id,
    title: task.title,
    hostLabel: resolveTaskHostLabel(task, srvId, ctx.input.hostLabelsByServerId),
    workspaceLabel: task.workspaceLabel || directoryBasename(task.cwd),
    mode: task.mode,
    taskRecord: task,
    ...overrides,
  };
}

function collectAwaitingReviewTasks(ctx: ActionBarBuildContext): void {
  for (const task of ctx.tasks) {
    if (task.supersededByTaskId || task.status !== "awaiting_review") continue;
    if (ctx.claimedTaskIds.has(task.id)) continue;
    const srvId = resolveTaskServerId(task, ctx.input.serverId);
    const primaryAgentId = resolveTaskPrimaryAgentId(task);
    if (isAgentClaimed(ctx, srvId, primaryAgentId)) continue;
    const live = lookupLiveAgent(ctx, srvId, primaryAgentId);
    const triage = primaryAgentId ? ctx.triageByAgentId.get(primaryAgentId) : undefined;
    ctx.awaitingReview.push(
      buildTaskItemBase(ctx, task, srvId, primaryAgentId, live, {
        summary: task.latestReceipt?.summary ?? triage?.summary ?? task.brief.goal ?? null,
        stale48h: false,
        isLiveRunning: false,
        lastActivityAtMs: resolveTaskActivityMs(task, live),
        completedAtMs: null,
        parkedReason: null,
      }),
    );
    claimTask(ctx, task);
  }
}

function collectPermissionNeedsYou(ctx: ActionBarBuildContext): void {
  const dedupedPerms = dedupePendingPermissions(ctx.input.pendingPermissions);
  const permsByAgentKey = new Map<
    string,
    { serverId: string; agentId: string; entries: ActionBarPendingPermissionInput[] }
  >();
  for (const entry of dedupedPerms) {
    const permAgentId = entry.permission.agentId;
    const live = lookupLiveAgent(ctx, entry.serverId, permAgentId);
    if (live && (live.archived || live.background) && permAgentId !== ctx.input.mainAgentId) {
      continue;
    }
    const linkedTask = resolveLinkedTaskForAgent(ctx, permAgentId);
    if (linkedTask?.status === "awaiting_review" || ctx.awaitingReviewAgentIds.has(permAgentId)) {
      continue;
    }
    const key = agentScopeKey(entry.serverId, permAgentId);
    const group = permsByAgentKey.get(key);
    if (group) {
      group.entries.push(entry);
    } else {
      permsByAgentKey.set(key, {
        serverId: entry.serverId,
        agentId: permAgentId,
        entries: [entry],
      });
    }
  }

  for (const group of permsByAgentKey.values()) {
    pushPermissionGroup(ctx, group);
  }
}

function firstNonEmptyText(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return null;
}

function resolveNeedsYouHostLabel(
  ctx: ActionBarBuildContext,
  srvId: string,
  linkedTask: MainChatTaskRecord | null,
): string | null {
  if (linkedTask) {
    return resolveTaskHostLabel(linkedTask, srvId, ctx.input.hostLabelsByServerId);
  }
  return ctx.input.hostLabelsByServerId?.[srvId] ?? null;
}

function pushPermissionGroup(
  ctx: ActionBarBuildContext,
  group: { serverId: string; agentId: string; entries: ActionBarPendingPermissionInput[] },
): void {
  if (isAgentClaimed(ctx, group.serverId, group.agentId)) return;
  const first = group.entries[0];
  if (!first) return;
  const linkedTask = resolveLinkedTaskForAgent(ctx, group.agentId);
  if (linkedTask && ctx.claimedTaskIds.has(linkedTask.id)) return;
  const live = lookupLiveAgent(ctx, group.serverId, group.agentId);
  const permissions = group.entries.map((entry) => entry.permission);
  const req = first.permission.request;

  ctx.needsYou.push({
    kind: "permission",
    id: `perm:${group.serverId}:${group.agentId}`,
    serverId: group.serverId,
    agentId: group.agentId,
    workspaceId: firstNonEmptyText(live?.workspaceId, linkedTask?.workspaceId),
    taskId: linkedTask ? linkedTask.id : null,
    title:
      firstNonEmptyText(linkedTask?.title, first.sourceAgentTitle, live?.title) ?? group.agentId,
    hostLabel: resolveNeedsYouHostLabel(ctx, group.serverId, linkedTask),
    cwd: firstNonEmptyText(first.sourceAgentCwd, live?.cwd, linkedTask?.cwd),
    reason: firstNonEmptyText(req.title, req.description, req.name),
    permission: permissions[0]!,
    permissions,
    taskRecord: linkedTask,
    updatedAtMs: Math.max(live?.updatedAtMs ?? 0, ctx.nowMs),
  });
  claimAgent(ctx, group.serverId, group.agentId);
  claimTask(ctx, linkedTask);
}

function collectDecisionNeedsYou(ctx: ActionBarBuildContext): void {
  for (const decision of ctx.decisions) {
    if (decision.answeredAt || ctx.claimedDecisionIds.has(decision.id)) continue;
    const linkedTask = resolveLinkedTaskForAgent(ctx, decision.agentId, decision.taskId);
    if (linkedTask?.status === "awaiting_review") continue;
    const srvId = linkedTask
      ? resolveTaskServerId(linkedTask, ctx.input.serverId)
      : ctx.input.serverId;
    if (isAgentClaimed(ctx, srvId, decision.agentId)) continue;
    if (linkedTask && ctx.claimedTaskIds.has(linkedTask.id)) continue;
    const live = lookupLiveAgent(ctx, srvId, decision.agentId);

    ctx.needsYou.push({
      kind: "decision",
      id: `decision:${decision.id}`,
      serverId: srvId,
      agentId: decision.agentId,
      workspaceId: firstNonEmptyText(live?.workspaceId, linkedTask?.workspaceId),
      taskId: firstNonEmptyText(linkedTask?.id, decision.taskId),
      title: firstNonEmptyText(decision.title, linkedTask?.title, decision.question) ?? decision.id,
      hostLabel: resolveNeedsYouHostLabel(ctx, srvId, linkedTask),
      reason: decision.question,
      decision,
      taskRecord: linkedTask,
      updatedAtMs: parseTimestampMs(decision.createdAt, ctx.nowMs),
    });
    ctx.claimedDecisionIds.add(decision.id);
    claimAgent(ctx, srvId, decision.agentId);
    claimTask(ctx, linkedTask);
  }
}

function collectPlanNeedsYou(ctx: ActionBarBuildContext): void {
  for (const plan of ctx.plans) {
    if (isPlanAlreadyStarted(plan) || ctx.claimedPlanIds.has(plan.id)) continue;
    const firstTask = plan.tasks[0];
    const planServerId = firstNonEmptyText(firstTask?.serverId) ?? ctx.input.serverId;

    ctx.needsYou.push({
      kind: "plan",
      id: `plan:${plan.id}`,
      serverId: planServerId,
      agentId: null,
      workspaceId: firstTask?.workspaceId ?? null,
      taskId: firstTask?.taskRecordId ?? null,
      title: firstNonEmptyText(plan.summary, firstTask?.title) ?? plan.id,
      hostLabel: firstNonEmptyText(
        firstTask?.hostLabel,
        ctx.input.hostLabelsByServerId?.[planServerId],
      ),
      reason: firstNonEmptyText(plan.summary, firstTask?.goal),
      plan,
      updatedAtMs: parseTimestampMs(plan.createdAt, ctx.nowMs),
    });
    ctx.claimedPlanIds.add(plan.id);
    for (const plannedTask of plan.tasks) {
      if (plannedTask.taskRecordId) {
        ctx.claimedTaskIds.add(plannedTask.taskRecordId);
      }
    }
  }
}

function collectTaskNeedsYou(ctx: ActionBarBuildContext): void {
  for (const task of ctx.tasks) {
    if (task.supersededByTaskId) continue;
    if (task.status !== "needs_you" && task.status !== "failed") continue;
    if (ctx.claimedTaskIds.has(task.id)) continue;
    const srvId = resolveTaskServerId(task, ctx.input.serverId);
    const primaryAgentId = resolveTaskPrimaryAgentId(task);
    if (isAgentClaimed(ctx, srvId, primaryAgentId)) continue;
    const live = lookupLiveAgent(ctx, srvId, primaryAgentId);
    const triage = primaryAgentId ? ctx.triageByAgentId.get(primaryAgentId) : undefined;

    ctx.needsYou.push({
      kind: "task",
      id: `task:${task.id}`,
      serverId: srvId,
      agentId: primaryAgentId,
      workspaceId: firstNonEmptyText(live?.workspaceId, task.workspaceId),
      taskId: task.id,
      title: task.title,
      hostLabel: resolveTaskHostLabel(task, srvId, ctx.input.hostLabelsByServerId),
      workspaceLabel: task.workspaceLabel || directoryBasename(task.cwd),
      mode: task.mode,
      reason: firstNonEmptyText(triage?.waitReason, triage?.summary, task.brief.goal),
      isFailed: task.status === "failed" || live?.status === "error",
      taskRecord: task,
      updatedAtMs: resolveTaskActivityMs(task, live),
    });
    claimTask(ctx, task);
  }
}

function isLiveAgentExcludedFromNeedsYou(
  ctx: ActionBarBuildContext,
  agent: ActionBarLiveAgentSnapshot,
  linkedTask: MainChatTaskRecord | null,
): boolean {
  if (
    ctx.awaitingReviewAgentIds.has(agent.agentId) ||
    ctx.parkedAgentIds.has(agent.agentId) ||
    ctx.terminalExcludedAgentIds.has(agent.agentId)
  ) {
    return true;
  }
  if (!linkedTask) return false;
  return (
    ctx.claimedTaskIds.has(linkedTask.id) ||
    linkedTask.status === "awaiting_review" ||
    linkedTask.status === "parked" ||
    linkedTask.status === "completed" ||
    linkedTask.status === "cancelled"
  );
}

function isLiveAgentBlockedForUser(
  agent: ActionBarLiveAgentSnapshot,
  triage: MainChatSessionTriage | undefined,
): boolean {
  return (
    agent.attentionReason === "permission" ||
    agent.status === "error" ||
    triage?.phase === "blocked_user"
  );
}

function collectLiveAgentNeedsYou(ctx: ActionBarBuildContext): void {
  for (const agent of ctx.input.liveAgents) {
    if (agent.archived || agent.background || agent.isMainChat) continue;
    if (isAgentClaimed(ctx, agent.serverId, agent.agentId)) continue;
    const linkedTask = resolveLinkedTaskForAgent(ctx, agent.agentId);
    if (isLiveAgentExcludedFromNeedsYou(ctx, agent, linkedTask)) continue;

    const triage = ctx.triageByAgentId.get(agent.agentId);
    if (!isLiveAgentBlockedForUser(agent, triage)) continue;

    ctx.needsYou.push({
      kind: "task",
      id: `agent:${agent.serverId}:${agent.agentId}`,
      serverId: agent.serverId,
      agentId: agent.agentId,
      workspaceId: agent.workspaceId,
      taskId: linkedTask ? linkedTask.id : null,
      title:
        firstNonEmptyText(linkedTask?.title, agent.title, directoryBasename(agent.cwd)) ??
        agent.agentId,
      hostLabel: ctx.input.hostLabelsByServerId?.[agent.serverId] ?? null,
      workspaceLabel: firstNonEmptyText(linkedTask?.workspaceLabel, directoryBasename(agent.cwd)),
      mode: linkedTask ? linkedTask.mode : agent.mode,
      reason: firstNonEmptyText(triage?.waitReason, triage?.summary),
      isFailed: agent.status === "error",
      taskRecord: linkedTask,
      updatedAtMs: agent.updatedAtMs,
    });
    claimAgent(ctx, agent.serverId, agent.agentId);
    claimTask(ctx, linkedTask);
  }
}

function collectParkedTasks(ctx: ActionBarBuildContext): void {
  for (const task of ctx.tasks) {
    if (task.supersededByTaskId || task.status !== "parked") continue;
    if (ctx.claimedTaskIds.has(task.id)) continue;
    const srvId = resolveTaskServerId(task, ctx.input.serverId);
    const primaryAgentId = resolveTaskPrimaryAgentId(task);
    if (isAgentClaimed(ctx, srvId, primaryAgentId)) continue;
    const live = lookupLiveAgent(ctx, srvId, primaryAgentId);
    ctx.parked.push(
      buildTaskItemBase(ctx, task, srvId, primaryAgentId, live, {
        summary: task.parkedReason ?? task.brief.goal ?? null,
        stale48h: false,
        isLiveRunning: false,
        lastActivityAtMs: resolveTaskActivityMs(task, live, task.parkedAt),
        completedAtMs: null,
        parkedReason: task.parkedReason ?? null,
      }),
    );
    claimTask(ctx, task);
  }
}

function collectInProgressTasks(ctx: ActionBarBuildContext): void {
  for (const task of ctx.tasks) {
    if (task.supersededByTaskId) continue;
    if (task.status !== "running" && task.status !== "open") continue;
    if (ctx.claimedTaskIds.has(task.id)) continue;
    const srvId = resolveTaskServerId(task, ctx.input.serverId);
    const primaryAgentId = resolveTaskPrimaryAgentId(task);
    if (isAgentClaimed(ctx, srvId, primaryAgentId)) continue;
    const live = lookupLiveAgent(ctx, srvId, primaryAgentId);
    const lastActivityAtMs = resolveTaskActivityMs(task, live);
    const stale48h =
      lastActivityAtMs > 0 && ctx.nowMs - lastActivityAtMs >= STALE_IN_PROGRESS_THRESHOLD_MS;
    const triage = primaryAgentId ? ctx.triageByAgentId.get(primaryAgentId) : undefined;
    const item = buildTaskItemBase(ctx, task, srvId, primaryAgentId, live, {
      summary: triage?.summary ?? task.brief.goal ?? null,
      stale48h,
      isLiveRunning: isLiveAgentRunning(live) || (task.status === "running" && !stale48h),
      lastActivityAtMs,
      completedAtMs: null,
      parkedReason: null,
    });
    if (stale48h) ctx.inProgressStale.push(item);
    else ctx.inProgressActive.push(item);
    claimTask(ctx, task);
  }
}

function collectTerminalTasks(ctx: ActionBarBuildContext): void {
  for (const task of ctx.tasks) {
    if (ctx.claimedTaskIds.has(task.id)) continue;
    if (task.supersededByTaskId || task.status === "cancelled") {
      claimTask(ctx, task);
      continue;
    }
    if (task.status !== "completed") continue;
    const completedAtMs = parseTimestampMs(task.completedAt, parseTimestampMs(task.updatedAt));
    const withinWindow = completedAtMs > 0 && ctx.nowMs - completedAtMs <= COMPLETED_WINDOW_MS;
    const srvId = resolveTaskServerId(task, ctx.input.serverId);
    const primaryAgentId = resolveTaskPrimaryAgentId(task);
    if (withinWindow && !isAgentClaimed(ctx, srvId, primaryAgentId)) {
      const live = lookupLiveAgent(ctx, srvId, primaryAgentId);
      ctx.completed24h.push(
        buildTaskItemBase(ctx, task, srvId, primaryAgentId, live, {
          summary: task.latestReceipt?.summary ?? task.brief.goal ?? null,
          stale48h: false,
          isLiveRunning: false,
          lastActivityAtMs: completedAtMs,
          completedAtMs,
          parkedReason: null,
        }),
      );
    }
    claimTask(ctx, task);
  }
}

function buildFallbackAgentTaskItem(
  ctx: ActionBarBuildContext,
  agent: ActionBarLiveAgentSnapshot,
  triage: MainChatSessionTriage | undefined,
  overrides: {
    stale48h: boolean;
    isLiveRunning: boolean;
    lastActivityAtMs: number;
    completedAtMs: number | null;
  },
): ActionBarTaskItem {
  return {
    id: `agent:${agent.serverId}:${agent.agentId}`,
    serverId: agent.serverId,
    agentId: agent.agentId,
    workspaceId: agent.workspaceId,
    taskId: null,
    title: agent.title || directoryBasename(agent.cwd) || agent.agentId,
    hostLabel: ctx.input.hostLabelsByServerId?.[agent.serverId] ?? null,
    workspaceLabel: directoryBasename(agent.cwd),
    mode: agent.mode,
    summary: triage?.summary ?? null,
    parkedReason: null,
    taskRecord: null,
    ...overrides,
  };
}

function collectFallbackLiveAgents(ctx: ActionBarBuildContext): void {
  for (const agent of ctx.input.liveAgents) {
    if (agent.archived || agent.background || agent.isMainChat) continue;
    if (isAgentClaimed(ctx, agent.serverId, agent.agentId)) continue;
    const triage = ctx.triageByAgentId.get(agent.agentId);
    const lastActivityAtMs = agent.lastActivityAtMs || agent.updatedAtMs;

    if (isLiveAgentRunning(agent)) {
      const stale48h =
        lastActivityAtMs > 0 && ctx.nowMs - lastActivityAtMs >= STALE_IN_PROGRESS_THRESHOLD_MS;
      const item = buildFallbackAgentTaskItem(ctx, agent, triage, {
        stale48h,
        isLiveRunning: !stale48h,
        lastActivityAtMs,
        completedAtMs: null,
      });
      if (stale48h) ctx.inProgressStale.push(item);
      else ctx.inProgressActive.push(item);
      claimAgent(ctx, agent.serverId, agent.agentId);
      continue;
    }

    if (
      agent.managedByMainChat &&
      agent.updatedAtMs > 0 &&
      ctx.nowMs - agent.updatedAtMs <= COMPLETED_WINDOW_MS
    ) {
      ctx.completed24h.push(
        buildFallbackAgentTaskItem(ctx, agent, triage, {
          stale48h: false,
          isLiveRunning: false,
          lastActivityAtMs: agent.updatedAtMs,
          completedAtMs: agent.updatedAtMs,
        }),
      );
      claimAgent(ctx, agent.serverId, agent.agentId);
    }
  }
}

/**
 * Pure, cross-platform five-state deduplicated view-model for `MainChatActionBar`.
 *
 * Guarantees:
 * - Every `agentId`, `taskId`, `permission.request.id`, `decision.id`, and `plan.id` is owned by
 *   at most ONE row across all five buckets (`needsYou`, `inProgress`, `awaitingReview`, `parked`,
 *   `completed24h`).
 * - `awaiting_review` tasks are NEVER mixed into `needsYou`; they always stay in `awaitingReview`.
 * - `inProgress` splits by last activity into normal (`stale48h: false`) and >=48h inactive
 *   (`stale48h: true`).
 * - `completed24h` includes only tasks completed within the last 24 hours; older completed or
 *   cancelled tasks are excluded and their agents never leak back via live agent snapshots.
 */
export function buildMainChatActionBarModel(
  input: BuildActionBarModelInput,
): MainChatActionBarModel {
  const ctx = createActionBarBuildContext(input);

  // 0. Pre-claim awaiting_review tasks into Bucket 3 (NEVER mixed into needsYou).
  collectAwaitingReviewTasks(ctx);
  // 1. Bucket 1 — Needs you (Permissions -> Decisions -> Open Plans -> Needs-you Tasks/Agents).
  collectPermissionNeedsYou(ctx);
  collectDecisionNeedsYou(ctx);
  collectPlanNeedsYou(ctx);
  collectTaskNeedsYou(ctx);
  collectLiveAgentNeedsYou(ctx);
  // 2. Bucket 4 — Parked tasks.
  collectParkedTasks(ctx);
  // 3. Bucket 2 — In progress (normal active vs >=48h stale).
  collectInProgressTasks(ctx);
  // 4. Bucket 5 — Completed (24h window) & claim terminal tasks.
  collectTerminalTasks(ctx);
  // 5. Fallback for live agents without a ledger task record.
  collectFallbackLiveAgents(ctx);

  sortByRecencyDesc(ctx.needsYou);
  sortTasksByActivityDesc(ctx.inProgressActive);
  sortTasksByActivityDesc(ctx.inProgressStale);
  sortTasksByActivityDesc(ctx.awaitingReview);
  sortTasksByActivityDesc(ctx.parked);
  sortTasksByActivityDesc(ctx.completed24h);

  const inProgressAll = [...ctx.inProgressActive, ...ctx.inProgressStale];

  return {
    needsYou: ctx.needsYou,
    inProgress: {
      active: ctx.inProgressActive,
      stale: ctx.inProgressStale,
      all: inProgressAll,
    },
    awaitingReview: ctx.awaitingReview,
    parked: ctx.parked,
    completed24h: ctx.completed24h,
    counts: {
      needsYou: ctx.needsYou.length,
      inProgress: inProgressAll.length,
      inProgressActive: ctx.inProgressActive.length,
      inProgressStale: ctx.inProgressStale.length,
      awaitingReview: ctx.awaitingReview.length,
      parked: ctx.parked.length,
      completed24h: ctx.completed24h.length,
      total:
        ctx.needsYou.length +
        inProgressAll.length +
        ctx.awaitingReview.length +
        ctx.parked.length +
        ctx.completed24h.length,
    },
  };
}
