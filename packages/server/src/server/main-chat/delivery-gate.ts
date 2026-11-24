import path from "node:path";
import type {
  MainChatDeliveryCiState,
  MainChatDeliveryGatePolicy,
  MainChatDeliveryGateStatus,
  MainChatDeliveryPrState,
  MainChatSupervisionSignalKind,
  MainChatSupervisionUrgency,
  MainChatTaskDeliveryGate,
  MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import type { PullRequestCheck } from "../../services/forge-service.js";
import type { WorkspaceGitRuntimeSnapshot } from "../workspace-git-service.js";

const PR_OR_MR_URL_RE =
  /https?:\/\/[^\s<>()[\]"']+\/(?:pull|merge_requests)\/(\d+)(?:\/[^\s<>()[\]"']*)?/gi;

export interface DeliveryGateEvaluation {
  gate: MainChatTaskDeliveryGate;
  blocksAcceptance: boolean;
  warning: string | null;
}

export interface DeliveryGateSignalTransition {
  kind: Extract<
    MainChatSupervisionSignalKind,
    "pr_merged" | "pr_conflict" | "draft_pr" | "pr_event"
  >;
  urgency: MainChatSupervisionUrgency;
  taskId: string;
  agentId: string | null;
  serverId: string | null;
  conversationId: string | null;
  title: string;
  summary: string;
  fingerprintSeed: string;
  quiet: boolean;
  /** True when the PR moved to merged and downstream DAG dependents should be checked. */
  prJustMerged: boolean;
}

export class DeliveryGateBlockedError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly gate: MainChatTaskDeliveryGate,
    message: string,
  ) {
    super(message);
    this.name = "DeliveryGateBlockedError";
  }
}

export function normalizePrUrlKey(url: string | null | undefined): string {
  if (!url) return "";
  const trimmed = url.trim().replace(/[),.;]+$/, "");
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed);
    const prMatch = parsed.pathname.match(/^\/(.+?\/(?:pull|merge_requests)\/\d+)/i);
    const canonicalPath = prMatch ? `/${prMatch[1]}` : parsed.pathname.replace(/\/+$/, "");
    return `${parsed.host.toLowerCase()}${canonicalPath.toLowerCase()}`;
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

export function extractPrUrlFromText(text: string | null | undefined): {
  prUrl: string;
  prNumber: number | null;
} | null {
  if (!text) return null;
  PR_OR_MR_URL_RE.lastIndex = 0;
  let lastMatch: RegExpExecArray | null = null;
  for (let match = PR_OR_MR_URL_RE.exec(text); match !== null; match = PR_OR_MR_URL_RE.exec(text)) {
    lastMatch = match;
  }
  if (!lastMatch) return null;
  const rawUrl = lastMatch[0].replace(/[),.;]+$/, "");
  const num = Number.parseInt(lastMatch[1] ?? "", 10);
  return {
    prUrl: rawUrl,
    prNumber: Number.isFinite(num) && num > 0 ? num : null,
  };
}

function mapChecksToCiState(
  checksStatus: "none" | "pending" | "success" | "failure" | undefined,
  checks: readonly PullRequestCheck[] | undefined,
): { ciStatus: MainChatDeliveryCiState; ciSummary: string | null } {
  if (checksStatus === "failure") {
    const failedNames = (checks ?? [])
      .filter((check) => check.status === "failure")
      .map((check) => check.name)
      .slice(0, 3);
    return {
      ciStatus: "failing",
      ciSummary:
        failedNames.length > 0 ? `失败项：${failedNames.join("、")}` : "存在失败的 CI 检查",
    };
  }
  if (checksStatus === "pending") {
    const pendingCount = (checks ?? []).filter((check) => check.status === "pending").length;
    return {
      ciStatus: "pending",
      ciSummary: pendingCount > 0 ? `${pendingCount} 项检查运行中` : "CI 检查运行中",
    };
  }
  if (checksStatus === "success") {
    return {
      ciStatus: "passing",
      ciSummary: checks && checks.length > 0 ? `${checks.length} 项检查全部通过` : "CI 检查已通过",
    };
  }
  return { ciStatus: "unknown", ciSummary: null };
}

function normalizePrState(
  rawState: string | null | undefined,
  isMerged: boolean | undefined,
): MainChatDeliveryPrState | null {
  if (isMerged) return "merged";
  const lowered = rawState?.trim().toLowerCase();
  if (lowered === "merged") return "merged";
  if (lowered === "closed") return "closed";
  if (lowered === "open" || lowered === "opened") return "open";
  return null;
}

export function computeDeliveryGateStatusAndBlockers(input: {
  prUrl: string | null;
  prState: MainChatDeliveryPrState | null;
  isDraft: boolean;
  hasConflict: boolean;
  ciStatus: MainChatDeliveryCiState;
  ciSummary?: string | null;
  reviewDecision?: string | null;
}): {
  gateStatus: MainChatDeliveryGateStatus;
  blockingReasons: string[];
} {
  if (!input.prUrl && !input.prState) {
    return { gateStatus: "clear", blockingReasons: [] };
  }
  if (input.prState === "merged") {
    return { gateStatus: "merged", blockingReasons: [] };
  }
  if (input.prState === "closed") {
    return { gateStatus: "closed", blockingReasons: [] };
  }

  const blockingReasons: string[] = [];
  if (input.isDraft) {
    blockingReasons.push("PR 仍为草稿（Draft）状态，尚未转为 Ready for Review");
  }
  if (input.hasConflict) {
    blockingReasons.push("PR 存在合并冲突（CONFLICTING），需先解决冲突");
  }
  if (input.ciStatus === "failing") {
    blockingReasons.push(
      input.ciSummary?.trim()
        ? `PR CI 检查失败（${input.ciSummary.trim()}）`
        : "PR CI 检查未通过，存在失败项",
    );
  }

  let gateStatus: MainChatDeliveryGateStatus = "awaiting_merge";
  if (input.hasConflict) {
    gateStatus = "conflict";
  } else if (input.ciStatus === "failing") {
    gateStatus = "ci_failed";
  } else if (input.isDraft) {
    gateStatus = "draft";
  }

  return { gateStatus, blockingReasons };
}

/**
 * Builds a normalized `MainChatTaskDeliveryGate` from a `WorkspaceGitRuntimeSnapshot`
 * (reusing Paseo's workspace git/forge runtime facts; strictly read-only, never merges or pushes).
 */
export function buildDeliveryGateFromGitSnapshot(input: {
  snapshot: WorkspaceGitRuntimeSnapshot;
  existing?: MainChatTaskDeliveryGate | null;
  nowIso: string;
}): MainChatTaskDeliveryGate | null {
  const pr = input.snapshot.forge.pullRequest;
  if (!pr) {
    return input.existing ?? null;
  }

  const prState = normalizePrState(pr.state, pr.isMerged);
  const isDraft = pr.isDraft === true;
  const hasConflict = pr.mergeable === "CONFLICTING";
  const { ciStatus, ciSummary } = mapChecksToCiState(pr.checksStatus, pr.checks);
  const { gateStatus, blockingReasons } = computeDeliveryGateStatusAndBlockers({
    prUrl: pr.url,
    prState,
    isDraft,
    hasConflict,
    ciStatus,
    ciSummary,
    reviewDecision: pr.reviewDecision ?? null,
  });

  const mergedAt = prState === "merged" ? (input.existing?.mergedAt ?? input.nowIso) : null;
  const followUpActive = prState === "open";

  return {
    prUrl: pr.url,
    prNumber: pr.number ?? input.existing?.prNumber ?? null,
    branch: pr.headRefName || input.snapshot.git.currentBranch || input.existing?.branch || null,
    prState,
    isDraft,
    hasConflict,
    ciStatus,
    ciSummary,
    reviewDecision: pr.reviewDecision ?? null,
    headOid: pr.headSha ?? input.snapshot.git.headSha ?? input.existing?.headOid ?? null,
    gateStatus,
    blockingReasons,
    followUpActive,
    lastCheckedAt: input.nowIso,
    mergedAt,
  };
}

/**
 * Merges a discovered PR URL (from agent output / review text) into a task's delivery gate
 * when no richer forge snapshot has overwritten it yet.
 */
export function buildDeliveryGateFromDiscoveredPrUrl(input: {
  prUrl: string;
  prNumber?: number | null;
  existing?: MainChatTaskDeliveryGate | null;
  nowIso: string;
}): MainChatTaskDeliveryGate {
  const existing = input.existing;
  const samePr = existing && normalizePrUrlKey(existing.prUrl) === normalizePrUrlKey(input.prUrl);
  if (samePr && existing) {
    return existing;
  }
  const { gateStatus, blockingReasons } = computeDeliveryGateStatusAndBlockers({
    prUrl: input.prUrl,
    prState: "open",
    isDraft: false,
    hasConflict: false,
    ciStatus: "unknown",
  });
  return {
    prUrl: input.prUrl,
    prNumber: input.prNumber ?? null,
    branch: existing?.branch ?? null,
    prState: "open",
    isDraft: false,
    hasConflict: false,
    ciStatus: "unknown",
    ciSummary: null,
    reviewDecision: null,
    headOid: existing?.headOid ?? null,
    gateStatus,
    blockingReasons,
    followUpActive: true,
    lastCheckedAt: input.nowIso,
    mergedAt: null,
  };
}

/**
 * Evaluates whether a task's delivery gate permits acceptance under the configured policy.
 * - `off`: never blocks acceptance, still returns informational gate summary.
 * - `merged` / `live`: blocks early acceptance when PR is draft, conflicting, or CI failing
 *   (unless explicitly bypassed); warns and enables post-closure PR follow-up when open & ready.
 */
export function evaluateTaskDeliveryGateForAcceptance(input: {
  task: MainChatTaskRecord;
  policy: MainChatDeliveryGatePolicy;
  gate: MainChatTaskDeliveryGate | null | undefined;
}): DeliveryGateEvaluation | null {
  const rawGate = input.gate ?? input.task.deliveryGate ?? null;
  if (!rawGate || (!rawGate.prUrl && !rawGate.prState)) {
    return null;
  }

  const computed = computeDeliveryGateStatusAndBlockers({
    prUrl: rawGate.prUrl,
    prState: rawGate.prState,
    isDraft: rawGate.isDraft,
    hasConflict: rawGate.hasConflict,
    ciStatus: rawGate.ciStatus,
    ciSummary: rawGate.ciSummary,
    reviewDecision: rawGate.reviewDecision,
  });

  const normalizedGate: MainChatTaskDeliveryGate = {
    ...rawGate,
    gateStatus: computed.gateStatus,
    blockingReasons: computed.blockingReasons,
    followUpActive: rawGate.prState === "open",
  };

  if (input.policy === "off") {
    return {
      gate: normalizedGate,
      blocksAcceptance: false,
      warning:
        computed.blockingReasons.length > 0
          ? `交付门禁当前已关闭（off），但检测到 PR 风险：${computed.blockingReasons.join("；")}`
          : null,
    };
  }

  if (computed.blockingReasons.length > 0) {
    return {
      gate: normalizedGate,
      blocksAcceptance: true,
      warning: `交付门禁拦截：${computed.blockingReasons.join("；")}`,
    };
  }

  if (normalizedGate.prState === "open") {
    const prRef = normalizedGate.prNumber ? `PR #${normalizedGate.prNumber}` : "关联 PR";
    const suffix =
      input.policy === "live"
        ? "（策略为 live：请跟进合并并确认上线实测）"
        : "（已开启结项后 PR 持续跟进，合并后将自动推送 pr_merged 提醒，严禁自动合入）";
    return {
      gate: {
        ...normalizedGate,
        followUpActive: true,
      },
      blocksAcceptance: false,
      warning: `${prRef} 仍处于待合并状态${suffix}`,
    };
  }

  return {
    gate: normalizedGate,
    blocksAcceptance: false,
    warning: null,
  };
}

/**
 * Compares previous vs. next `MainChatTaskDeliveryGate` for a task and emits deduplicated
 * supervision signal transitions (`pr_merged`, `pr_conflict`, `draft_pr`, `pr_event`).
 * Keeps conservative Mode A boundaries: never auto-merges or force-pushes.
 */
type DeliveryGateTransitionEmitter = (
  dedupeKey: string,
  transition: Omit<DeliveryGateSignalTransition, "fingerprintSeed">,
) => void;

interface DeliveryGateTransitionContext {
  taskId: string;
  title: string;
  agentId: string | null;
  serverId: string | null;
  conversationId: string | null;
  quiet: boolean;
  prKey: string;
  headTag: string;
  prRef: string;
  prUrl: string;
}

function collectOpenPrTransitions(
  next: MainChatTaskDeliveryGate,
  ctx: DeliveryGateTransitionContext,
  emitOnce: DeliveryGateTransitionEmitter,
): void {
  if (next.hasConflict) {
    emitOnce(`pr_conflict:${ctx.taskId}:${ctx.prKey}:${ctx.headTag}`, {
      kind: "pr_conflict",
      urgency: "urgent",
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      serverId: ctx.serverId,
      conversationId: ctx.conversationId,
      title: ctx.title,
      summary: `${ctx.prRef} 存在合并冲突（CONFLICTING，${ctx.prUrl}），需解决冲突后再验收或合并`,
      quiet: ctx.quiet,
      prJustMerged: false,
    });
  }

  if (next.isDraft) {
    emitOnce(`draft_pr:${ctx.taskId}:${ctx.prKey}:${ctx.headTag}`, {
      kind: "draft_pr",
      urgency: "normal",
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      serverId: ctx.serverId,
      conversationId: ctx.conversationId,
      title: ctx.title,
      summary: `${ctx.prRef} 仍处于草稿（Draft）状态（${ctx.prUrl}），待转为 Ready for Review`,
      quiet: ctx.quiet,
      prJustMerged: false,
    });
  }

  if (next.ciStatus === "failing") {
    const ciDetail = next.ciSummary?.trim() ? `（${next.ciSummary.trim()}）` : "";
    emitOnce(`pr_event:ci_fail:${ctx.taskId}:${ctx.prKey}:${ctx.headTag}`, {
      kind: "pr_event",
      urgency: "urgent",
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      serverId: ctx.serverId,
      conversationId: ctx.conversationId,
      title: ctx.title,
      summary: `${ctx.prRef} CI 检查失败${ciDetail}（${ctx.prUrl}），需先修复失败项`,
      quiet: ctx.quiet,
      prJustMerged: false,
    });
  }

  if (next.reviewDecision === "changes_requested") {
    emitOnce(`pr_event:changes_requested:${ctx.taskId}:${ctx.prKey}:${ctx.headTag}`, {
      kind: "pr_event",
      urgency: "urgent",
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      serverId: ctx.serverId,
      conversationId: ctx.conversationId,
      title: ctx.title,
      summary: `${ctx.prRef} 收到评审退回修改意见（changes_requested，${ctx.prUrl}）`,
      quiet: ctx.quiet,
      prJustMerged: false,
    });
  }
}

export function diffDeliveryGateTransitions(input: {
  task: MainChatTaskRecord;
  previous: MainChatTaskDeliveryGate | null | undefined;
  next: MainChatTaskDeliveryGate;
  notifiedKeys: Set<string>;
  defaultServerId?: string | null;
}): DeliveryGateSignalTransition[] {
  const { task, previous, next, notifiedKeys } = input;
  if (!next.prUrl) return [];

  const ctx: DeliveryGateTransitionContext = {
    taskId: task.id,
    title: task.title,
    agentId: task.activeAgentId ?? task.agentIds.at(-1) ?? null,
    serverId: task.serverId ?? input.defaultServerId ?? null,
    conversationId: task.conversationId ?? null,
    quiet: task.quiet !== false,
    prKey: normalizePrUrlKey(next.prUrl),
    headTag: next.headOid?.trim() || next.branch?.trim() || "head",
    prRef: next.prNumber ? `PR #${next.prNumber}` : next.prUrl,
    prUrl: next.prUrl,
  };
  const transitions: DeliveryGateSignalTransition[] = [];

  const emitOnce: DeliveryGateTransitionEmitter = (dedupeKey, transition) => {
    if (notifiedKeys.has(dedupeKey)) return;
    notifiedKeys.add(dedupeKey);
    transitions.push({
      ...transition,
      fingerprintSeed: dedupeKey,
    });
  };

  // 1. PR merged transition (both active tasks and post-closure follow-up tasks)
  if (next.prState === "merged" && previous?.prState !== "merged") {
    emitOnce(`pr_merged:${ctx.taskId}:${ctx.prKey}`, {
      kind: "pr_merged",
      urgency: "normal",
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      serverId: ctx.serverId,
      conversationId: ctx.conversationId,
      title: ctx.title,
      summary: `${ctx.prRef} 已合并（${ctx.prUrl}），可进行收尾核验或解锁后续依赖任务`,
      quiet: ctx.quiet,
      prJustMerged: true,
    });
    return transitions;
  }

  // 2. PR closed without merge -> pr_event
  if (next.prState === "closed" && previous?.prState !== "closed") {
    emitOnce(`pr_event:closed:${ctx.taskId}:${ctx.prKey}`, {
      kind: "pr_event",
      urgency: "normal",
      taskId: ctx.taskId,
      agentId: ctx.agentId,
      serverId: ctx.serverId,
      conversationId: ctx.conversationId,
      title: ctx.title,
      summary: `${ctx.prRef} 已关闭但未合并（${ctx.prUrl}），请核对是否需要重新提 PR 或取消任务`,
      quiet: ctx.quiet,
      prJustMerged: false,
    });
    return transitions;
  }

  if (next.prState === "open") {
    collectOpenPrTransitions(next, ctx, emitOnce);
  }

  return transitions;
}

/**
 * Matches a `WorkspaceGitRuntimeSnapshot` back to tasks sharing that checkout `cwd` or PR URL.
 */
export function matchTasksForGitSnapshot(
  tasks: readonly MainChatTaskRecord[],
  snapshot: WorkspaceGitRuntimeSnapshot,
): MainChatTaskRecord[] {
  const normalizedSnapshotCwd = path.resolve(snapshot.cwd);
  const snapshotPrKey = normalizePrUrlKey(snapshot.forge.pullRequest?.url);
  const snapshotBranch = snapshot.git.currentBranch?.trim() || null;

  return tasks.filter((task) => {
    if (task.status === "cancelled") return false;
    const isCompletedWithoutFollowup =
      task.status === "completed" && !task.deliveryGate?.followUpActive;
    if (isCompletedWithoutFollowup) return false;

    const taskPrKey = normalizePrUrlKey(task.deliveryGate?.prUrl);
    if (snapshotPrKey && taskPrKey) {
      return taskPrKey === snapshotPrKey;
    }
    if (
      task.deliveryGate?.branch &&
      snapshotBranch &&
      task.deliveryGate.branch !== snapshotBranch
    ) {
      return false;
    }
    if (task.cwd && path.resolve(task.cwd) === normalizedSnapshotCwd) {
      return true;
    }
    return false;
  });
}
