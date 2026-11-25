import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  getMainChatTaskMetaFromLabels,
  isFormerMainChatLabels,
  isMainChatLabels,
  type MainChatDecisionRecord,
  type MainChatIdleArchiveAuditRecord,
  type MainChatIdleArchiveRefusalCode,
  type MainChatIdleArchiveSweepResult,
  type MainChatPlanRecord,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { getMainChatConversationMetaFromLabels } from "./conversations.js";

export interface IdleArchiveAgentCandidate {
  id: string;
  serverId: string;
  title: string;
  lifecycle: string;
  archivedAt: string | null;
  requiresAttention: boolean;
  hasBackgroundWork: boolean;
  pendingPermissionCount: number;
  updatedAtMs: number;
  labels: Record<string, string>;
}

export interface IdleArchiveEvaluationContext {
  nowMs: number;
  idleThresholdMinutes: number;
  mainAgentId: string | null;
  conversationAgentIds: ReadonlySet<string>;
  tasksByAgentId: ReadonlyMap<string, MainChatTaskRecord>;
  openPlans: readonly MainChatPlanRecord[];
  openDecisions: readonly MainChatDecisionRecord[];
  queuedTaskIds: ReadonlySet<string>;
}

export interface IdleArchiveEligibilityDecision {
  eligible: boolean;
  refusalCode: MainChatIdleArchiveRefusalCode | null;
  reason: string;
  taskId: string | null;
  idleMinutes: number;
}

function makeAuditId(): string {
  return `ia_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function hasOpenPlanReference(agentId: string, openPlans: readonly MainChatPlanRecord[]): boolean {
  for (const plan of openPlans) {
    if (plan.status !== "open" && plan.status !== "started") continue;
    for (const task of plan.tasks) {
      if (task.agentId === agentId) return true;
    }
  }
  return false;
}

function hasOpenDecisionReference(
  agentId: string,
  taskId: string | null,
  openDecisions: readonly MainChatDecisionRecord[],
): boolean {
  for (const decision of openDecisions) {
    if (decision.answeredAt !== null) continue;
    if (decision.agentId === agentId) return true;
    if (taskId && decision.taskId === taskId) return true;
  }
  return false;
}

function isManagedSubagentCandidate(
  agent: IdleArchiveAgentCandidate,
  linkedTask: MainChatTaskRecord | undefined,
  mainAgentId: string | null,
  conversationAgentIds: ReadonlySet<string>,
): boolean {
  if (linkedTask) return true;
  const taskMeta = getMainChatTaskMetaFromLabels(agent.labels);
  if (taskMeta?.planId || taskMeta?.taskId) return true;
  const parentId = getParentAgentIdFromLabels(agent.labels);
  if (parentId && (parentId === mainAgentId || conversationAgentIds.has(parentId))) {
    return true;
  }
  return false;
}

function resolveLastActivityMs(
  agent: IdleArchiveAgentCandidate,
  linkedTask: MainChatTaskRecord | undefined,
): number {
  let latest = agent.updatedAtMs;
  if (linkedTask?.completedAt) {
    const parsed = Date.parse(linkedTask.completedAt);
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  if (linkedTask?.updatedAt) {
    const parsed = Date.parse(linkedTask.updatedAt);
    if (Number.isFinite(parsed) && parsed > latest) latest = parsed;
  }
  return latest;
}

function evaluateProtectedSessionRefusal(
  agent: IdleArchiveAgentCandidate,
  linkedTask: MainChatTaskRecord | undefined,
  context: IdleArchiveEvaluationContext,
): { refusalCode: MainChatIdleArchiveRefusalCode; reason: string } | null {
  if (
    agent.id === context.mainAgentId ||
    isMainChatLabels(agent.labels) ||
    isFormerMainChatLabels(agent.labels)
  ) {
    return { refusalCode: "is_main_chat", reason: "主对话本身受红线保护，禁止自动归档" };
  }

  if (
    getMainChatConversationMetaFromLabels(agent.labels) !== null ||
    context.conversationAgentIds.has(agent.id)
  ) {
    return {
      refusalCode: "is_direction_leader",
      reason: "方向主管/分支对话受红线保护，禁止自动归档",
    };
  }

  if (agent.archivedAt !== null) {
    return { refusalCode: "already_archived", reason: "会话已处于归档状态" };
  }

  if (
    !isManagedSubagentCandidate(
      agent,
      linkedTask,
      context.mainAgentId,
      context.conversationAgentIds,
    )
  ) {
    return {
      refusalCode: "is_manual_session",
      reason: "用户手动会话受保守红线保护，禁止自动归档",
    };
  }

  if (
    agent.lifecycle === "running" ||
    agent.lifecycle === "initializing" ||
    agent.hasBackgroundWork
  ) {
    return {
      refusalCode: "is_running",
      reason: `子会话仍在运行或初始化中（${agent.lifecycle}），禁止自动归档`,
    };
  }

  if (agent.pendingPermissionCount > 0) {
    return {
      refusalCode: "has_pending_permission",
      reason: `存在 ${agent.pendingPermissionCount} 条待审批权限请求，禁止自动归档`,
    };
  }

  return null;
}

/**
 * Evaluates whether a session may be auto-archived by the idle subagent sweeper.
 * Enforces strict Conservative Mode A red lines: NEVER archives main chat, direction leaders,
 * user manual sessions, running sessions, pending permissions, open decisions, unclosed tasks,
 * active PR follow-ups (`deliveryGate.followUpActive`), or sessions awaiting reply.
 */
export function evaluateIdleSubagentArchiveEligibility(
  agent: IdleArchiveAgentCandidate,
  context: IdleArchiveEvaluationContext,
): IdleArchiveEligibilityDecision {
  const linkedTask = context.tasksByAgentId.get(agent.id);
  const taskId = linkedTask?.id ?? null;
  const lastActivityMs = resolveLastActivityMs(agent, linkedTask);
  const idleMinutes = Math.max(0, Math.round((context.nowMs - lastActivityMs) / 60_000));

  const protectedRefusal = evaluateProtectedSessionRefusal(agent, linkedTask, context);
  if (protectedRefusal) {
    return {
      eligible: false,
      refusalCode: protectedRefusal.refusalCode,
      reason: protectedRefusal.reason,
      taskId,
      idleMinutes,
    };
  }

  // Red line 7: Never archive sessions with open user decisions
  if (hasOpenDecisionReference(agent.id, taskId, context.openDecisions)) {
    return {
      eligible: false,
      refusalCode: "has_open_decision",
      reason: "存在待用户拍板的未决决策卡，禁止自动归档",
      taskId,
      idleMinutes,
    };
  }

  // Red line 8: Never archive sessions with unclosed tasks or queued dispatch
  if (linkedTask) {
    const isClosed = linkedTask.status === "completed" || linkedTask.status === "cancelled";
    if (!isClosed || context.queuedTaskIds.has(linkedTask.id)) {
      return {
        eligible: false,
        refusalCode: "has_unclosed_task",
        reason: `关联任务「${linkedTask.title}」尚未结项（status=${linkedTask.status}），禁止自动归档`,
        taskId,
        idleMinutes,
      };
    }
  } else if (hasOpenPlanReference(agent.id, context.openPlans)) {
    return {
      eligible: false,
      refusalCode: "has_unclosed_task",
      reason: "关联计划任务尚未结项，禁止自动归档",
      taskId,
      idleMinutes,
    };
  } else {
    return {
      eligible: false,
      refusalCode: "has_unclosed_task",
      reason: "未查到已结项任务记录，按保守策略拒绝自动归档",
      taskId,
      idleMinutes,
    };
  }

  // Red line 9: Never archive sessions with active PR merge follow-up
  if (linkedTask.deliveryGate?.followUpActive) {
    return {
      eligible: false,
      refusalCode: "has_active_pr_followup",
      reason: `关联任务仍有活跃 PR 跟进（${linkedTask.deliveryGate.prUrl ?? "PR 合并监控中"}），禁止自动归档`,
      taskId,
      idleMinutes,
    };
  }

  // Red line 10: Never archive sessions explicitly awaiting user attention/reply
  if (agent.requiresAttention) {
    return {
      eligible: false,
      refusalCode: "awaits_reply",
      reason: "会话仍有未读/待处理提醒，禁止自动归档",
      taskId,
      idleMinutes,
    };
  }

  // Red line 11: Must exceed idle threshold
  const idleMs = context.nowMs - lastActivityMs;
  const thresholdMs = context.idleThresholdMinutes * 60_000;
  if (idleMs < thresholdMs) {
    return {
      eligible: false,
      refusalCode: "below_idle_threshold",
      reason: `闲置时长 ${idleMinutes} 分钟未达到阈值 ${context.idleThresholdMinutes} 分钟`,
      taskId,
      idleMinutes,
    };
  }

  return {
    eligible: true,
    refusalCode: null,
    reason: `已结项子会话闲置 ${idleMinutes} 分钟（>= ${context.idleThresholdMinutes} 分钟），满足安全归档条件`,
    taskId,
    idleMinutes,
  };
}

export async function runIdleSubagentArchiveSweep(input: {
  candidates: readonly IdleArchiveAgentCandidate[];
  context: IdleArchiveEvaluationContext;
  dryRun: boolean;
  limit: number;
  trigger: "scheduled" | "manual";
  existingAuditLog: readonly MainChatIdleArchiveAuditRecord[];
  revalidateBeforeArchive?: (agentId: string) => IdleArchiveAgentCandidate | null;
  archiveAgent: (agentId: string) => Promise<void>;
  onArchived?: (record: MainChatIdleArchiveAuditRecord) => Promise<void> | void;
}): Promise<MainChatIdleArchiveSweepResult> {
  const sweptAt = new Date(input.context.nowMs).toISOString();
  const sorted = [...input.candidates].sort((a, b) => a.updatedAtMs - b.updatedAtMs);

  const eligible: MainChatIdleArchiveAuditRecord[] = [];
  const archived: MainChatIdleArchiveAuditRecord[] = [];
  const refused: MainChatIdleArchiveAuditRecord[] = [];
  let failedCount = 0;

  for (const candidate of sorted) {
    const decision = evaluateIdleSubagentArchiveEligibility(candidate, input.context);
    if (!decision.eligible) {
      refused.push({
        id: makeAuditId(),
        agentId: candidate.id,
        serverId: candidate.serverId,
        title: candidate.title,
        taskId: decision.taskId,
        idleMinutes: decision.idleMinutes,
        outcome: "refused",
        refusalCode: decision.refusalCode,
        reason: decision.reason,
        sweptAt,
        trigger: input.trigger,
      });
      continue;
    }

    if (input.dryRun) {
      if (eligible.length < input.limit) {
        eligible.push({
          id: makeAuditId(),
          agentId: candidate.id,
          serverId: candidate.serverId,
          title: candidate.title,
          taskId: decision.taskId,
          idleMinutes: decision.idleMinutes,
          outcome: "eligible",
          refusalCode: null,
          reason: decision.reason,
          sweptAt,
          trigger: input.trigger,
        });
      }
      continue;
    }

    if (archived.length >= input.limit) {
      continue;
    }

    // Revalidate immediately before archiving so concurrent activity/permission changes cannot be clobbered
    const latest = input.revalidateBeforeArchive
      ? input.revalidateBeforeArchive(candidate.id)
      : candidate;
    if (!latest) continue;
    const rechecked = evaluateIdleSubagentArchiveEligibility(latest, input.context);
    if (!rechecked.eligible) {
      refused.push({
        id: makeAuditId(),
        agentId: latest.id,
        serverId: latest.serverId,
        title: latest.title,
        taskId: rechecked.taskId,
        idleMinutes: rechecked.idleMinutes,
        outcome: "refused",
        refusalCode: rechecked.refusalCode,
        reason: rechecked.reason,
        sweptAt,
        trigger: input.trigger,
      });
      continue;
    }

    try {
      await input.archiveAgent(latest.id);
      const record: MainChatIdleArchiveAuditRecord = {
        id: makeAuditId(),
        agentId: latest.id,
        serverId: latest.serverId,
        title: latest.title,
        taskId: rechecked.taskId,
        idleMinutes: rechecked.idleMinutes,
        outcome: "archived",
        refusalCode: null,
        reason: rechecked.reason,
        sweptAt,
        trigger: input.trigger,
      };
      archived.push(record);
      await input.onArchived?.(record);
    } catch (error) {
      failedCount += 1;
      const msg = error instanceof Error ? error.message : String(error);
      const failedRecord: MainChatIdleArchiveAuditRecord = {
        id: makeAuditId(),
        agentId: latest.id,
        serverId: latest.serverId,
        title: latest.title,
        taskId: rechecked.taskId,
        idleMinutes: rechecked.idleMinutes,
        outcome: "failed",
        refusalCode: null,
        reason: `归档失败：${msg}`,
        sweptAt,
        trigger: input.trigger,
      };
      refused.push(failedRecord);
      await input.onArchived?.(failedRecord);
    }
  }

  return {
    dryRun: input.dryRun,
    evaluatedCount: sorted.length,
    eligibleCount: input.dryRun ? eligible.length : archived.length,
    archivedCount: archived.length,
    refusedCount: refused.filter((r) => r.outcome === "refused").length,
    failedCount,
    archived,
    eligible,
    refused,
    auditLog: [...archived, ...input.existingAuditLog].slice(0, 100),
    sweptAt,
  };
}
