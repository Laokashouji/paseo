import path from "node:path";
import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  MAIN_CHAT_TASK_QUIET_LABEL,
  getMainChatTaskMetaFromLabels,
  isMainChatEnabled,
  isMainChatLabels,
  resolveMainChatNightMode,
  type MainChatNightModeStatus,
  type MainChatPatrolResult,
  type MainChatSessionTriage,
  type MainChatSupervisionSignal,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentProvider, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { StructuredGenerationDaemonConfig } from "../agent/structured-generation-providers.js";
import type { MainChatContextSnapshotBuilder } from "./context-snapshot.js";
import { evaluateMainChatNightMode, type MainChatNightModeEvaluation } from "./night-mode.js";
import {
  buildMainChatInitialBriefingPrompt,
  buildMainChatSupervisionWakeupPrompt,
} from "./prompts.js";
import {
  checkDuplicateQuestionGuard,
  checkRedLineGuard,
  createApprovalInterceptionTracker,
  matchStandingAuthorization,
  recordManualApprovalObservation,
  type ApprovalEscalationEvent,
  type ApprovalEscalationTier,
  type ApprovalInterceptionEntry,
  type ApprovalInterceptionTracker,
} from "./safety.js";
import {
  ALL_STOPPED_THRESHOLD_MS,
  SUPERVISE_GATHER_MS,
  SUPERVISE_NORMAL_COOLDOWN_MS,
  SUPERVISE_URGENT_COOLDOWN_MS,
  createSupervisionSignalQueue,
  detectAllStoppedTasks,
  formatSupervisionDigest,
  isSignalQuietSuppressible,
  type DeliverSupervisionBatchPayload,
  type EnqueueSupervisionSignalInput,
  type EnqueueSupervisionSignalResult,
  type SignalRevalidationOutcome,
} from "./signal-queue.js";
import type { MainChatStore } from "./store.js";
import type { MainChatTurnQueue } from "./turn-queue.js";
import {
  classifyMainChatTurnError,
  heuristicTriageAssistantReply,
  isCancelledTurnError,
  isNoProgressToolCall,
  isSubstantiveProgressToolCall,
  parseUsageLimitWakeAt,
  resolveMainChatBackgroundProviders,
  runMainChatSemanticTriage,
  type RunSemanticTriageInput,
  type SemanticTriageOutput,
} from "./triage.js";

const DEFAULT_MAX_TRANSIENT_AUTO_RETRIES = 2;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 3_000;
const MIN_NO_PROGRESS_TOOL_CALLS = 3;

export interface SupervisionConversationTarget {
  agentId: string;
  label?: string | null;
}

export interface MainChatSupervisorDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  store: MainChatStore;
  contextSnapshots: MainChatContextSnapshotBuilder;
  turnQueue: MainChatTurnQueue;
  logger: Logger;
  serverId?: string;
  now?: () => number;
  providerSnapshotManager?: Pick<ProviderSnapshotManager, "listProviders">;
  readDaemonConfig?: () => StructuredGenerationDaemonConfig | null;
  resolveMainAgentId?: () => Promise<string | null>;
  resolveConversationTarget?: (
    conversationId: string | null,
  ) => Promise<SupervisionConversationTarget | null>;
  isLeaderConversationActive?: (conversationId: string) => boolean;
  onPatrolTick?: () => Promise<void> | void;
  onAgentEvent?: (event: AgentManagerEvent) => void;
  semanticTriageRunner?: (input: RunSemanticTriageInput) => Promise<SemanticTriageOutput | null>;
  transientRetryDelayMs?: number;
  maxTransientAutoRetries?: number;
  usageLimitRetryDelayMs?: number;
  stalledThresholdMs?: number;
  stalledCheckIntervalMs?: number;
  triageSettleMs?: number;
  noProgressThresholdMs?: number;
  needsYouEscalateMs?: number;
  wakeupCooldownMs?: number;
  superviseGatherMs?: number;
  normalCooldownMs?: number;
  urgentCooldownMs?: number;
  allStoppedThresholdMs?: number;
  supervisorIdleEscalateMs?: number;
  supervisorBusyMaxHoldMs?: number;
  permissionHardDeadlineMs?: number;
  ruleSuggestionThreshold?: number;
}

export interface MainChatSupervisor {
  start(): void;
  stop(): void;
  refreshSchedule(): void;
  getNightModeStatus(): MainChatNightModeStatus;
  notifyUserForegroundActivity(atMs?: number): void;
  runPatrol(options?: {
    mainAgentId?: string | null;
    forceWakeup?: boolean;
    manualTrigger?: boolean;
  }): Promise<MainChatPatrolResult>;
  dispatchInitialBriefing(mainAgentId: string): Promise<boolean>;
  enqueueSignal(
    input: EnqueueSupervisionSignalInput & {
      quiet?: boolean;
      isRedLine?: boolean;
      escalatedToUser?: boolean;
    },
  ): EnqueueSupervisionSignalResult;
  listPendingSignals(conversationId?: string | null): MainChatSupervisionSignal[];
  getPendingSignalCount(conversationId?: string | null): number;
  pausePermissionForClarification(input: {
    agentId: string;
    serverId?: string | null;
    permissionRequestId: string;
    label?: string;
    taskId?: string | null;
    conversationId?: string | null;
  }): { pausedDeadlineAt: string };
  getApprovalTracker(): ApprovalInterceptionTracker;
}

interface AgentToolLoopTracker {
  lastSubstantiveAt: number;
  noProgressSinceAt: number | null;
  noProgressCalls: number;
  totalCallsSinceSubstantive: number;
  lastToolSignature: string | null;
  repeatedSignatureCount: number;
  nudgedAt: number | null;
}

interface PendingPermissionMeta {
  agentId: string;
  cwd: string;
  serverId: string | null;
  request: AgentPermissionRequest;
}

function isManagedChildAgent(agent: ManagedAgent | null | undefined): boolean {
  if (!agent || agent.internal || agent.background || isMainChatLabels(agent.labels)) return false;
  const parentId = getParentAgentIdFromLabels(agent.labels);
  const taskMeta = getMainChatTaskMetaFromLabels(agent.labels);
  return Boolean(parentId && taskMeta?.planId);
}

function isObservedFleetAgent(agent: ManagedAgent | null | undefined): agent is ManagedAgent {
  if (!agent || agent.internal || agent.background || isMainChatLabels(agent.labels)) return false;
  return true;
}

function isQuietManagedAgent(
  agent: ManagedAgent | null | undefined,
  task: MainChatTaskRecord | null,
): boolean {
  if (task) return task.quiet !== false;
  if (!isManagedChildAgent(agent)) return false;
  return agent?.labels[MAIN_CHAT_TASK_QUIET_LABEL] !== "false";
}

function basenameOf(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return path.basename(trimmed) || trimmed;
}

function extractCommandFromPermissionInput(
  input: Record<string, unknown> | null | undefined,
): string | null {
  if (!input) return null;
  const raw = input.command ?? input.cmd;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractToolDetailText(detail: unknown): string | null {
  if (!detail || typeof detail !== "object") return null;
  const record = detail as Record<string, unknown>;
  if (typeof record.command === "string") return record.command;
  if (typeof record.text === "string") return record.text;
  if (typeof record.path === "string") return record.path;
  if (record.input && typeof record.input === "object") {
    const inputRecord = record.input as Record<string, unknown>;
    if (typeof inputRecord.command === "string") return inputRecord.command;
    if (typeof inputRecord.cmd === "string") return inputRecord.cmd;
  }
  return null;
}

function extractLastAssistantTextFromTimeline(items: readonly AgentTimelineItem[]): string {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item && item.type === "assistant_message" && item.text.trim().length > 0) {
      return item.text.trim();
    }
  }
  return "";
}

const COMPLETED_TASK_STALE_SIGNAL_KINDS = new Set<MainChatSupervisionSignal["kind"]>([
  "review",
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
  "check",
  "decide",
]);

const RUNNING_AGENT_STALE_SIGNAL_KINDS = new Set<MainChatSupervisionSignal["kind"]>([
  "review",
  "idle",
  "unjudged",
  "all_stopped",
  "timed_out",
  "interrupted",
  "failed",
]);

const ARCHIVED_ALLOWED_SIGNAL_KINDS = new Set<MainChatSupervisionSignal["kind"]>([
  "parent_closeout",
  "pr_merged",
  "orphaned",
  "failed",
]);

function checkTaskBasedSignalValidity(
  signal: MainChatSupervisionSignal,
  task: MainChatTaskRecord,
  liveAgent: ManagedAgent | null,
): SignalRevalidationOutcome | null {
  if (
    (task.status === "completed" || task.status === "cancelled") &&
    COMPLETED_TASK_STALE_SIGNAL_KINDS.has(signal.kind)
  ) {
    return { valid: false, reason: `task_${task.status}` };
  }
  if (
    task.status === "parked" &&
    (signal.kind === "review" ||
      signal.kind === "stalled" ||
      signal.kind === "no_progress" ||
      signal.kind === "all_stopped")
  ) {
    return { valid: false, reason: "task_parked" };
  }
  if (
    signal.agentId &&
    task.activeAgentId &&
    task.activeAgentId !== signal.agentId &&
    COMPLETED_TASK_STALE_SIGNAL_KINDS.has(signal.kind)
  ) {
    return { valid: false, reason: "agent_superseded" };
  }
  if (signal.kind === "all_stopped" && liveAgent?.lifecycle === "running") {
    return { valid: false, reason: "agent_resumed" };
  }
  return null;
}

function checkPermissionOrDecisionSignalValidity(
  signal: MainChatSupervisionSignal,
  liveAgent: ManagedAgent | null,
  triage: MainChatSessionTriage | null,
  hasOpenDecision: boolean,
): SignalRevalidationOutcome | null {
  if (signal.kind === "needs_you" || signal.kind === "ask") {
    const hasPendingPerm = (liveAgent?.pendingPermissions.size ?? 0) > 0;
    const isBlockedUser = triage?.phase === "blocked_user";
    if (!hasPendingPerm && !isBlockedUser && !hasOpenDecision) {
      return { valid: false, reason: "permission_or_question_resolved" };
    }
  }
  if (signal.kind === "decide" && !hasOpenDecision) {
    return { valid: false, reason: "decision_answered" };
  }
  return null;
}

function checkLiveAgentSignalValidity(
  signal: MainChatSupervisionSignal,
  liveAgent: ManagedAgent | null,
  lastActivityAtMs: number | undefined,
): SignalRevalidationOutcome | null {
  if (!liveAgent) return null;
  const signalCreatedAtMs = Date.parse(signal.createdAt);

  if (
    RUNNING_AGENT_STALE_SIGNAL_KINDS.has(signal.kind) &&
    liveAgent.lifecycle === "running" &&
    liveAgent.pendingPermissions.size === 0
  ) {
    return { valid: false, reason: "agent_running_again" };
  }

  if (signal.kind === "stalled" || signal.kind === "no_progress") {
    if (liveAgent.lifecycle !== "running") {
      return { valid: false, reason: "agent_not_running" };
    }
    if (
      lastActivityAtMs !== undefined &&
      Number.isFinite(signalCreatedAtMs) &&
      lastActivityAtMs > signalCreatedAtMs
    ) {
      return { valid: false, reason: "agent_made_progress" };
    }
  }
  return null;
}

function resolveSupervisionTrigger(forced: boolean, batch: DeliverSupervisionBatchPayload): string {
  if (forced) return "manual_patrol";
  if (batch.hasImmediate) return "immediate_supervision";
  if (batch.hasUrgent) return "urgent_supervision";
  return "patrol_wakeup";
}

function resolveSupervisionPriority(
  forced: boolean,
  batch: DeliverSupervisionBatchPayload,
): number {
  if (forced || batch.hasImmediate) return 30;
  if (batch.hasUrgent) return 20;
  return 10;
}

function resolveApprovalCategory(
  kind: AgentPermissionRequest["kind"],
): "permission" | "plan" | "question" {
  if (kind === "plan") return "plan";
  if (kind === "question") return "question";
  return "permission";
}

function resolveEscalationReasonText(reason: ApprovalEscalationEvent["reason"]): string {
  if (reason === "hard_deadline") return "已触达 15 分钟权限硬截止超时";
  if (reason === "supervisor_busy_timeout") return "督办长回合阻塞超 1 小时上限";
  return "督办空闲超 5 分钟未处理";
}

/**
 * Full-fleet proactive steward supervisor with M5 structured signal queue (26 signal kinds,
 * 15s gather, 10m normal / 2m urgent / immediate throttle, dequeue-time live revalidation),
 * 30m all-stopped detection, usage-limit wake_at & bounded transient retry, quiet-task badge
 * suppression, approval interception (5m idle / 15m hard deadline), hardcoded red-line guard,
 * 24h duplicate question guard, and progressive standing-authorization suggestions.
 */
export function createMainChatSupervisor(deps: MainChatSupervisorDependencies): MainChatSupervisor {
  const getNowMs = deps.now ?? (() => Date.now());
  const transientRetriesByAgent = new Map<string, number>();
  const transientEscalatedAgents = new Set<string>();
  const usageLimitRetriedAgents = new Set<string>();
  const usageLimitEscalatedAgents = new Set<string>();
  const usageLimitWakeAtByAgent = new Map<string, string>();
  const pendingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingTriageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastActivityAtByAgent = new Map<string, number>();
  const lastAssistantTextByAgent = new Map<string, string>();
  const stalledNudgedAtByAgent = new Map<string, number>();
  const permissionFirstSeenAt = new Map<string, number>();
  const pendingPermissionRequestsByKey = new Map<string, PendingPermissionMeta>();
  const autoApprovedPermissionKeys = new Set<string>();
  const toolLoopByAgent = new Map<string, AgentToolLoopTracker>();
  const initialBriefingSentAgents = new Set<string>();

  let unsubscribeEvents: (() => void) | null = null;
  let patrolTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFleetOrUserActivityAtMs = getNowMs();
  let lastUserForegroundAtMs: number | null = null;
  let lastNightModeState: MainChatNightModeStatus["state"] = "active";
  let manualFlushActive = false;
  let manualTargetMainAgentId: string | null = null;

  const transientDelayMs = deps.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS;
  const maxTransientRetries = deps.maxTransientAutoRetries ?? DEFAULT_MAX_TRANSIENT_AUTO_RETRIES;

  const approvalTracker = createApprovalInterceptionTracker({
    supervisorIdleEscalateMs: deps.supervisorIdleEscalateMs,
    supervisorBusyMaxHoldMs: deps.supervisorBusyMaxHoldMs,
    permissionHardDeadlineMs: deps.permissionHardDeadlineMs,
    now: getNowMs,
  });

  function hasActiveFleetWorkNow(): boolean {
    return deps.agentManager
      .listAgents()
      .some(
        (agent) =>
          isObservedFleetAgent(agent) &&
          (agent.lifecycle === "running" || agent.pendingPermissions.size > 0),
      );
  }

  function evaluatePowerState(nowMs: number = getNowMs()): MainChatNightModeEvaluation {
    return evaluateMainChatNightMode({
      settings: deps.store.getSettings(),
      nowMs,
      hasActiveFleetWork: hasActiveFleetWorkNow(),
      lastActivityAtMs: lastFleetOrUserActivityAtMs,
      lastUserForegroundAtMs,
      basePatrolIntervalMsOverride: deps.stalledCheckIntervalMs,
    });
  }

  function effectiveStalledThresholdMs(): number {
    if (deps.stalledThresholdMs !== undefined) return deps.stalledThresholdMs;
    return deps.store.getSettings().intervals.stalledThresholdMin * 60 * 1000;
  }

  function effectiveNoProgressThresholdMs(): number {
    if (deps.noProgressThresholdMs !== undefined) return deps.noProgressThresholdMs;
    return deps.store.getSettings().intervals.noProgressThresholdMin * 60 * 1000;
  }

  function effectiveTriageSettleMs(): number {
    if (deps.triageSettleMs !== undefined) return deps.triageSettleMs;
    return deps.store.getSettings().intervals.triageSettleSec * 1000;
  }

  function effectiveNeedsYouEscalateMs(): number {
    if (deps.needsYouEscalateMs !== undefined) return deps.needsYouEscalateMs;
    return deps.store.getSettings().intervals.needsYouEscalateMin * 60 * 1000;
  }

  function effectiveGatherMs(): number {
    return deps.superviseGatherMs ?? SUPERVISE_GATHER_MS;
  }

  function effectiveNormalCooldownMs(): number {
    if (deps.normalCooldownMs !== undefined) return deps.normalCooldownMs;
    if (deps.wakeupCooldownMs !== undefined) return deps.wakeupCooldownMs;
    return SUPERVISE_NORMAL_COOLDOWN_MS;
  }

  function effectiveUrgentCooldownMs(): number {
    if (deps.urgentCooldownMs !== undefined) return deps.urgentCooldownMs;
    if (deps.wakeupCooldownMs !== undefined) {
      return Math.min(SUPERVISE_URGENT_COOLDOWN_MS, deps.wakeupCooldownMs);
    }
    return SUPERVISE_URGENT_COOLDOWN_MS;
  }

  function clearTimerMapEntry(
    map: Map<string, ReturnType<typeof setTimeout>>,
    agentId: string,
  ): void {
    const existing = map.get(agentId);
    if (existing) {
      clearTimeout(existing);
      map.delete(agentId);
    }
  }

  async function resolveMainAgentId(): Promise<string | null> {
    if (deps.resolveMainAgentId) {
      return deps.resolveMainAgentId();
    }
    const liveMain = deps.agentManager
      .listAgents()
      .find((agent) => !agent.background && isMainChatLabels(agent.labels));
    if (liveMain) return liveMain.id;
    const stored = await deps.agentStorage.listActive();
    const storedMain = stored
      .filter(
        (record) => !record.archivedAt && !record.background && isMainChatLabels(record.labels),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    return storedMain?.id ?? null;
  }

  async function resolveTargetForConversation(
    conversationId: string | null,
  ): Promise<SupervisionConversationTarget | null> {
    if (conversationId && deps.resolveConversationTarget) {
      const target = await deps.resolveConversationTarget(conversationId);
      if (target) return target;
    }
    const mainAgentId = manualTargetMainAgentId ?? (await resolveMainAgentId());
    if (!mainAgentId) return null;
    return { agentId: mainAgentId, label: null };
  }

  function hasOpenDecisionForSignal(signal: MainChatSupervisionSignal): boolean {
    const decisions = deps.store.listDecisions();
    return decisions.some(
      (decision) =>
        decision.answeredAt === null &&
        ((signal.taskId !== null && decision.taskId === signal.taskId) ||
          (signal.agentId !== null && decision.agentId === signal.agentId)),
    );
  }

  async function revalidateSignalLive(
    signal: MainChatSupervisionSignal,
  ): Promise<SignalRevalidationOutcome> {
    const task =
      (signal.taskId ? deps.store.getTask(signal.taskId) : null) ??
      (signal.agentId ? deps.store.findTaskByAgentId(signal.agentId) : null);
    const liveAgent = signal.agentId ? (deps.agentManager.getAgent(signal.agentId) ?? null) : null;

    if (task) {
      const taskVerdict = checkTaskBasedSignalValidity(signal, task, liveAgent);
      if (taskVerdict !== null) return taskVerdict;
    }

    if (signal.agentId && !ARCHIVED_ALLOWED_SIGNAL_KINDS.has(signal.kind)) {
      const stored = await deps.agentStorage.get(signal.agentId).catch(() => null);
      if (stored?.archivedAt) {
        return { valid: false, reason: "agent_archived" };
      }
    }

    const triage = signal.agentId ? deps.store.getTriage(signal.agentId) : null;
    const permVerdict = checkPermissionOrDecisionSignalValidity(
      signal,
      liveAgent,
      triage,
      hasOpenDecisionForSignal(signal),
    );
    if (permVerdict !== null) return permVerdict;

    const liveVerdict = checkLiveAgentSignalValidity(
      signal,
      liveAgent,
      signal.agentId ? lastActivityAtByAgent.get(signal.agentId) : undefined,
    );
    if (liveVerdict !== null) return liveVerdict;

    if (signal.kind === "all_stopped" && task) {
      const stillStopped = detectAllStoppedTasks({
        tasks: [task],
        getLiveAgentState: (agentId) => {
          const live = deps.agentManager.getAgent(agentId);
          return live ? { lifecycle: live.lifecycle, updatedAtMs: live.updatedAt.getTime() } : null;
        },
        hasPendingRetry: (agentId) => pendingRetryTimers.has(agentId),
        nowMs: getNowMs(),
        thresholdMs: deps.allStoppedThresholdMs ?? ALL_STOPPED_THRESHOLD_MS,
      });
      if (stillStopped.length === 0) {
        return { valid: false, reason: "task_no_longer_all_stopped" };
      }
    }

    return true;
  }

  async function deliverSupervisionBatch(batch: DeliverSupervisionBatchPayload): Promise<boolean> {
    const settings = deps.store.getSettings();
    const forced = manualFlushActive;
    if (!isMainChatEnabled(settings)) {
      return false;
    }
    if (!forced) {
      const power = evaluatePowerState();
      const canWake =
        batch.hasUrgent || batch.hasImmediate
          ? power.allowUrgentWakeup
          : power.allowProactiveWakeup;
      if (!canWake) {
        return false;
      }
    }

    const target = await resolveTargetForConversation(batch.conversationId);
    if (!target) return false;

    const trigger = resolveSupervisionTrigger(forced, batch);
    const priority = resolveSupervisionPriority(forced, batch);
    const summary = forced
      ? `手动巡检并汇报（${batch.signals.length} 条动态）`
      : `后台督办唤醒（${batch.signals.length} 条动态）`;

    try {
      const queued = await deps.turnQueue.enqueueBackground({
        mainAgentId: target.agentId,
        dedupeKey: batch.conversationId ? `supervise:${batch.conversationId}` : "patrol:wakeup",
        trigger,
        priority,
        summary,
        requeueOnPreempt: true,
        buildPrompt: async () => {
          const latestSettings = deps.store.getSettings();
          const finalValid: MainChatSupervisionSignal[] = [];
          for (const sig of batch.signals) {
            const outcome = await revalidateSignalLive(sig);
            const isValid = typeof outcome === "boolean" ? outcome : outcome.valid;
            if (isValid) finalValid.push(sig);
          }
          if (!forced && finalValid.length === 0) {
            return null;
          }
          const contextSnapshot = await deps.contextSnapshots.buildTurnContext(target.agentId, {
            forceFull: forced,
          });
          const digest =
            finalValid.length > 0
              ? formatSupervisionDigest(finalValid, { conversationLabel: target.label })
              : null;
          return buildMainChatSupervisionWakeupPrompt({
            settings: latestSettings,
            signals: finalValid,
            digest,
            contextSnapshot,
            manualTrigger: forced,
            conversationLabel: target.label,
          });
        },
        onDispatched: async () => {
          await deps.store.setLastWakeupAt(new Date(getNowMs()).toISOString());
          await deps.store.incrementMetric("proactiveWakeups");
        },
      });
      return queued.status === "dispatched" || queued.status === "queued";
    } catch (error) {
      deps.logger.warn(
        { err: error, targetAgentId: target.agentId, conversationId: batch.conversationId },
        "Proactive supervision wakeup failed",
      );
      return false;
    }
  }

  const signalQueue = createSupervisionSignalQueue({
    revalidateSignal: revalidateSignalLive,
    onDeliver: deliverSupervisionBatch,
    getGatherMs: effectiveGatherMs,
    getNormalCooldownMs: effectiveNormalCooldownMs,
    getUrgentCooldownMs: effectiveUrgentCooldownMs,
    now: getNowMs,
  });

  function enqueueStructuredSignal(
    input: EnqueueSupervisionSignalInput & {
      quiet?: boolean;
      isRedLine?: boolean;
      escalatedToUser?: boolean;
    },
  ): EnqueueSupervisionSignalResult {
    const result = signalQueue.enqueue(input);
    if (
      result.queued &&
      input.quiet === true &&
      isSignalQuietSuppressible(input.kind, {
        isRedLine: input.isRedLine,
        escalatedToUser: input.escalatedToUser,
      })
    ) {
      void deps.store.incrementSuppressedQuietBadgeCount().catch(() => undefined);
    }
    return result;
  }

  function clearAgentState(agentId: string): void {
    clearTimerMapEntry(pendingRetryTimers, agentId);
    clearTimerMapEntry(pendingTriageTimers, agentId);
    transientRetriesByAgent.delete(agentId);
    transientEscalatedAgents.delete(agentId);
    usageLimitRetriedAgents.delete(agentId);
    usageLimitEscalatedAgents.delete(agentId);
    usageLimitWakeAtByAgent.delete(agentId);
    lastActivityAtByAgent.delete(agentId);
    lastAssistantTextByAgent.delete(agentId);
    stalledNudgedAtByAgent.delete(agentId);
    permissionFirstSeenAt.delete(agentId);
    toolLoopByAgent.delete(agentId);
    approvalTracker.resolveAllForAgent(agentId);
    signalQueue.removeByAgentId(agentId);
    for (const [key, entry] of pendingPermissionRequestsByKey) {
      if (entry.agentId === agentId) {
        pendingPermissionRequestsByKey.delete(key);
        autoApprovedPermissionKeys.delete(key);
      }
    }
    void deps.store.removeClarificationsForAgent(agentId).catch(() => undefined);
    void deps.store.removeTriage(agentId).catch(() => undefined);
  }

  function resolveMainSelection(mainAgentId: string | null): {
    provider?: AgentProvider | null;
    model?: string | null;
    thinkingOptionId?: string | null;
  } | null {
    if (!mainAgentId) return null;
    const live = deps.agentManager.getAgent(mainAgentId);
    if (!live) return null;
    return {
      provider: live.provider,
      model: live.config.model ?? live.runtimeInfo?.model ?? null,
      thinkingOptionId: live.config.thinkingOptionId ?? null,
    };
  }

  function resolveTaskRouteForAgent(agent: ManagedAgent): {
    task: MainChatTaskRecord | null;
    conversationId: string | null;
    quiet: boolean;
  } {
    const task = deps.store.findTaskByAgentId(agent.id);
    const quiet = isQuietManagedAgent(agent, task);
    const hasActiveLeader =
      task?.conversationId && deps.isLeaderConversationActive?.(task.conversationId);
    return {
      task,
      conversationId: hasActiveLeader ? (task?.conversationId ?? null) : null,
      quiet,
    };
  }

  function dispatchDelayedResume(input: {
    agentId: string;
    delayMs: number;
    prompt: string;
    onDispatched: () => Promise<void>;
    logReason: string;
  }): void {
    if (pendingRetryTimers.has(input.agentId)) return;
    const timer = setTimeout(() => {
      pendingRetryTimers.delete(input.agentId);
      void (async () => {
        const record = await deps.agentStorage.get(input.agentId);
        if (record?.archivedAt) return;
        const linkedTask = deps.store.findTaskByAgentId(input.agentId);
        if (
          linkedTask &&
          (linkedTask.status === "completed" || linkedTask.status === "cancelled")
        ) {
          return;
        }
        const live = deps.agentManager.getAgent(input.agentId);
        if (live && live.lifecycle === "running") return;
        await sendPromptToAgent({
          agentId: input.agentId,
          prompt: input.prompt,
          agentManager: deps.agentManager,
          agentStorage: deps.agentStorage,
          logger: deps.logger,
          unarchive: false,
        });
        await input.onDispatched();
      })().catch((error) => {
        deps.logger.warn(
          { err: error, agentId: input.agentId },
          `Automatic ${input.logReason} failed`,
        );
      });
    }, input.delayMs);
    timer.unref?.();
    pendingRetryTimers.set(input.agentId, timer);
  }

  function scheduleTransientRetry(agent: ManagedAgent, errorMessage: string): void {
    const route = resolveTaskRouteForAgent(agent);
    const title = agent.config.title?.trim() || basenameOf(agent.cwd);
    const retries = transientRetriesByAgent.get(agent.id) ?? 0;

    if (retries >= maxTransientRetries) {
      if (!transientEscalatedAgents.has(agent.id)) {
        transientEscalatedAgents.add(agent.id);
        void deps.store.incrementMetric("interrupts").catch(() => undefined);
      }
      const triage: MainChatSessionTriage = {
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? null,
        title,
        managedByMainChat: isManagedChildAgent(agent),
        phase: "interrupted",
        summary: `连续重试 ${maxTransientRetries} 次仍失败：${errorMessage.slice(0, 80)}`,
        waitReason: errorMessage.slice(0, 120),
        suggestedAction: "打开会话查看报错或稍后手动继续",
        triageSource: "rule",
        updatedAt: new Date(getNowMs()).toISOString(),
      };
      void deps.store.putTriage(triage).catch(() => undefined);
      enqueueStructuredSignal({
        kind: "interrupted",
        urgency: "urgent",
        taskId: route.task?.id ?? null,
        agentId: agent.id,
        serverId: deps.serverId ?? null,
        conversationId: route.conversationId,
        title,
        summary: triage.summary,
        fingerprintSeed: `err:${errorMessage.slice(0, 60)}`,
        quiet: route.quiet,
        escalatedToUser: true,
      });
      return;
    }

    const attempt = retries + 1;
    transientRetriesByAgent.set(agent.id, attempt);
    deps.logger.info(
      { agentId: agent.id, attempt, maxRetries: maxTransientRetries, error: errorMessage },
      "Scheduling automatic continuation for transient agent error",
    );
    dispatchDelayedResume({
      agentId: agent.id,
      delayMs: transientDelayMs,
      prompt: `上一步遇到临时服务异常（${errorMessage.slice(0, 160)}），请从当前进度继续执行并完成任务。`,
      logReason: "transient retry",
      onDispatched: async () => {
        await deps.store.incrementMetric("autoContinued");
        await deps.store.incrementMetric("supervisorHeld");
        enqueueStructuredSignal({
          kind: "transient_retry",
          urgency: "normal",
          taskId: route.task?.id ?? null,
          agentId: agent.id,
          serverId: deps.serverId ?? null,
          conversationId: route.conversationId,
          title,
          summary: `瞬时报错后已自动续跑（第 ${attempt}/${maxTransientRetries} 次）：${errorMessage.slice(0, 60)}`,
          fingerprintSeed: `transient:${attempt}:${errorMessage.slice(0, 40)}`,
          quiet: route.quiet,
        });
      },
    });
  }

  function scheduleUsageLimitRetry(agent: ManagedAgent, errorMessage: string): void {
    const route = resolveTaskRouteForAgent(agent);
    const title = agent.config.title?.trim() || basenameOf(agent.cwd);

    if (usageLimitRetriedAgents.has(agent.id)) {
      if (!usageLimitEscalatedAgents.has(agent.id)) {
        usageLimitEscalatedAgents.add(agent.id);
        void deps.store.incrementMetric("interrupts").catch(() => undefined);
      }
      enqueueStructuredSignal({
        kind: "interrupted",
        urgency: "urgent",
        taskId: route.task?.id ?? null,
        agentId: agent.id,
        serverId: deps.serverId ?? null,
        conversationId: route.conversationId,
        title,
        summary: `限额恢复后再次触发额度上限：${errorMessage.slice(0, 80)}`,
        fingerprintSeed: `usage_limit_repeat:${errorMessage.slice(0, 40)}`,
        quiet: route.quiet,
        escalatedToUser: true,
      });
      return;
    }

    usageLimitRetriedAgents.add(agent.id);
    const nowMs = getNowMs();
    const wakeSchedule = parseUsageLimitWakeAt(errorMessage, nowMs);
    const delayMs = deps.usageLimitRetryDelayMs ?? wakeSchedule.delayMs;
    const wakeAtIso =
      deps.usageLimitRetryDelayMs !== undefined
        ? new Date(nowMs + delayMs).toISOString()
        : wakeSchedule.wakeAtIso;
    usageLimitWakeAtByAgent.set(agent.id, wakeAtIso);

    const minutes = Math.max(1, Math.round(delayMs / 60_000));
    const triage: MainChatSessionTriage = {
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      title,
      managedByMainChat: isManagedChildAgent(agent),
      phase: "blocked_external",
      summary: `触发模型额度上限，已排期约 ${minutes} 分钟后（${wakeAtIso}）自动续跑`,
      waitReason: errorMessage.slice(0, 120),
      suggestedAction: "等待自动恢复或手动切换其他模型",
      triageSource: "rule",
      updatedAt: new Date(nowMs).toISOString(),
    };
    void deps.store.putTriage(triage).catch(() => undefined);
    deps.logger.info(
      { agentId: agent.id, delayMs, wakeAtIso, error: errorMessage },
      "Scheduling delayed automatic continuation after usage limit",
    );
    dispatchDelayedResume({
      agentId: agent.id,
      delayMs,
      prompt: "模型额度已重置，请从之前中断的位置继续完成当前任务。",
      logReason: "usage-limit retry",
      onDispatched: async () => {
        usageLimitWakeAtByAgent.delete(agent.id);
        await deps.store.incrementMetric("usageLimitRetries");
        await deps.store.incrementMetric("autoContinued");
        await deps.store.incrementMetric("supervisorHeld");
        enqueueStructuredSignal({
          kind: "usage_limit_wake",
          urgency: "normal",
          taskId: route.task?.id ?? null,
          agentId: agent.id,
          serverId: deps.serverId ?? null,
          conversationId: route.conversationId,
          title,
          summary: `额度重置时间已到，已自动唤醒续跑（原计划 ${wakeAtIso}）`,
          fingerprintSeed: `usage_wake:${wakeAtIso}`,
          quiet: route.quiet,
        });
      },
    });
  }

  function observeManualPermissionApproval(meta: PendingPermissionMeta): void {
    const nowMs = getNowMs();
    const nowIso = new Date(nowMs).toISOString();
    const rawCommand = extractCommandFromPermissionInput(meta.request.input ?? null);
    const toolName = meta.request.name ?? meta.request.title ?? null;

    const existingAuths = deps.store.listStandingAuthorizations({ includeRevoked: false });
    const existingSuggestions = deps.store.listRuleSuggestions({ includeDismissed: true });

    const preview = recordManualApprovalObservation({
      scope: "permission",
      serverId: meta.serverId,
      localServerId: deps.serverId ?? null,
      cwd: meta.cwd,
      toolName,
      command: rawCommand,
      kind: meta.request.kind,
      existingObservation: null,
      existingAuthorizations: existingAuths,
      existingSuggestions,
      threshold: deps.ruleSuggestionThreshold,
      nowIso,
      nowMs,
    });
    if (!preview.eligible || !preview.observationKey) return;

    const persistedObs = deps.store.getManualApprovalObservation(preview.observationKey);
    const evaluated = recordManualApprovalObservation({
      scope: "permission",
      serverId: meta.serverId,
      localServerId: deps.serverId ?? null,
      cwd: meta.cwd,
      toolName,
      command: rawCommand,
      kind: meta.request.kind,
      existingObservation: persistedObs,
      existingAuthorizations: existingAuths,
      existingSuggestions,
      threshold: deps.ruleSuggestionThreshold,
      nowIso,
      nowMs,
    });
    if (evaluated.observation) {
      void deps.store.putManualApprovalObservation(evaluated.observation).catch(() => undefined);
    }
    if (evaluated.suggestion) {
      void deps.store.putRuleSuggestion(evaluated.suggestion).catch(() => undefined);
    }
  }

  async function executeAutoApprovePermission(input: {
    agentId: string;
    requestId: string;
    permKey: string;
    authorizationId: string;
    quiet: boolean;
  }): Promise<void> {
    try {
      await deps.agentManager.respondToPermission(input.agentId, input.requestId, {
        behavior: "allow",
      });
      permissionFirstSeenAt.delete(input.agentId);
      await deps.store.recordStandingAuthorizationMatch(
        input.authorizationId,
        new Date(getNowMs()).toISOString(),
      );
      await deps.store.incrementMetric("supervisorHeld");
      if (input.quiet) {
        await deps.store.incrementSuppressedQuietBadgeCount();
      }
    } catch (error) {
      autoApprovedPermissionKeys.delete(input.permKey);
      deps.logger.warn(
        { err: error, agentId: input.agentId, requestId: input.requestId },
        "Supervisor auto-approval failed; leaving request for user",
      );
    }
  }

  function tryAutoApproveManagedPermission(input: {
    agent: ManagedAgent;
    request: AgentPermissionRequest;
    permKey: string;
    toolName: string;
    rawCommand: string | null;
    quiet: boolean;
    nowMs: number;
  }): boolean {
    const match = matchStandingAuthorization(
      {
        scope: "permission",
        serverId: deps.serverId ?? null,
        localServerId: deps.serverId ?? null,
        cwd: input.agent.cwd,
        toolName: input.toolName,
        command: input.rawCommand,
        kind: input.request.kind,
        question: input.request.description ?? null,
      },
      deps.store.listStandingAuthorizations({ includeRevoked: false }),
      input.nowMs,
    );
    if (!match.matched || !match.authorization) return false;

    const matchedAuth = match.authorization;
    autoApprovedPermissionKeys.add(input.permKey);
    deps.logger.info(
      {
        agentId: input.agent.id,
        requestId: input.request.id,
        authorizationId: matchedAuth.id,
        toolName: matchedAuth.toolName,
      },
      "Auto-approving child agent permission request from standing authorization",
    );
    void executeAutoApprovePermission({
      agentId: input.agent.id,
      requestId: input.request.id,
      permKey: input.permKey,
      authorizationId: matchedAuth.id,
      quiet: input.quiet,
    });
    return true;
  }

  function resolveInitialApprovalTier(
    managed: boolean,
    redLineBlocked: boolean,
    conversationId: string | null,
  ): ApprovalEscalationTier {
    if (!managed || redLineBlocked) return "user";
    return conversationId ? "leader" : "main";
  }

  function trackAndSignalPendingPermission(input: {
    agent: ManagedAgent;
    request: AgentPermissionRequest;
    title: string;
    managed: boolean;
    route: { task: MainChatTaskRecord | null; conversationId: string | null; quiet: boolean };
    toolName: string;
    rawCommand: string | null;
    nowMs: number;
  }): void {
    const { agent, request, title, managed, route, toolName, rawCommand, nowMs } = input;
    const redLine = checkRedLineGuard({
      kind: request.kind,
      toolName,
      command: rawCommand,
      question: request.description ?? null,
    });
    const waitLabel = request.title?.trim() || request.name?.trim() || "待审批请求";
    const initialTier = resolveInitialApprovalTier(managed, redLine.blocked, route.conversationId);
    const taskId = route.task?.id ?? null;
    const serverId = deps.serverId ?? null;

    approvalTracker.track({
      agentId: agent.id,
      serverId,
      requestId: request.id,
      taskId,
      conversationId: route.conversationId,
      category: resolveApprovalCategory(request.kind),
      label: waitLabel,
      initialTier,
      nowMs,
    });

    void deps.store
      .putTriage({
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? null,
        title,
        managedByMainChat: managed,
        phase: "blocked_user",
        summary: redLine.blocked ? `等待红线审批：${waitLabel}` : `等待审批：${waitLabel}`,
        waitReason: redLine.reason ?? waitLabel,
        suggestedAction: "点击批准、提问澄清或打开会话处理",
        triageSource: "rule",
        updatedAt: new Date(nowMs).toISOString(),
      })
      .catch(() => undefined);
    void deps.store.incrementMetric("triageRuleCount").catch(() => undefined);

    if (route.quiet && !redLine.blocked && initialTier !== "user") {
      enqueueStructuredSignal({
        kind: "ask",
        urgency: "urgent",
        taskId,
        agentId: agent.id,
        serverId,
        conversationId: route.conversationId,
        title,
        summary: `拦截待处理审批：${waitLabel}（已启动 5m 空闲升级 / 15m 硬截止时钟）`,
        fingerprintSeed: `ask:${request.id}`,
        quiet: true,
      });
      return;
    }

    if (managed || redLine.blocked) {
      void deps.store.incrementMetric("interrupts").catch(() => undefined);
    }
    if (redLine.blocked) {
      enqueueStructuredSignal({
        kind: "needs_you",
        urgency: "urgent",
        taskId,
        agentId: agent.id,
        serverId,
        conversationId: null,
        title,
        summary: `高风险红线审批需你确认（${waitLabel}）：${redLine.reason}`,
        fingerprintSeed: `redline:${request.id}`,
        quiet: route.quiet,
        isRedLine: true,
        escalatedToUser: true,
      });
    }
  }

  function handlePermissionRequested(agent: ManagedAgent, request: AgentPermissionRequest): void {
    const nowMs = getNowMs();
    if (!permissionFirstSeenAt.has(agent.id)) {
      permissionFirstSeenAt.set(agent.id, nowMs);
    }

    const permKey = `${agent.id}:${request.id}`;
    if (pendingPermissionRequestsByKey.has(permKey)) {
      return;
    }
    pendingPermissionRequestsByKey.set(permKey, {
      agentId: agent.id,
      cwd: agent.cwd,
      serverId: deps.serverId ?? null,
      request,
    });

    const title = agent.config.title?.trim() || basenameOf(agent.cwd);
    const managed = isManagedChildAgent(agent);
    const route = resolveTaskRouteForAgent(agent);
    const rawCommand = extractCommandFromPermissionInput(request.input ?? null);
    const toolName = request.name ?? request.title ?? "";

    if (
      managed &&
      tryAutoApproveManagedPermission({
        agent,
        request,
        permKey,
        toolName,
        rawCommand,
        quiet: route.quiet,
        nowMs,
      })
    ) {
      return;
    }

    trackAndSignalPendingPermission({
      agent,
      request,
      title,
      managed,
      route,
      toolName,
      rawCommand,
      nowMs,
    });
  }

  function handlePermissionResolved(agentId: string, requestId: string, behavior: string): void {
    const permKey = `${agentId}:${requestId}`;
    approvalTracker.resolve(agentId, requestId);
    void deps.store.removeClarificationsForPermission(agentId, requestId).catch(() => undefined);

    const pendingMeta = pendingPermissionRequestsByKey.get(permKey);
    pendingPermissionRequestsByKey.delete(permKey);
    const wasAutoApproved = autoApprovedPermissionKeys.delete(permKey);

    if (!wasAutoApproved && behavior === "allow" && pendingMeta) {
      observeManualPermissionApproval(pendingMeta);
    }
  }

  function handleTurnFailed(agent: ManagedAgent, errorMessage: string): void {
    if (isCancelledTurnError(errorMessage)) {
      clearTimerMapEntry(pendingRetryTimers, agent.id);
      return;
    }

    const settings = deps.store.getSettings();
    const managed = isManagedChildAgent(agent);
    const route = resolveTaskRouteForAgent(agent);
    const canAutoContinue = managed || settings.capabilities.autoContinueManualErrors;
    const errorClass = classifyMainChatTurnError(errorMessage);
    const title = agent.config.title?.trim() || basenameOf(agent.cwd);

    if (errorClass === "transient" && canAutoContinue) {
      scheduleTransientRetry(agent, errorMessage);
      return;
    }
    if (errorClass === "usage_limit" && canAutoContinue) {
      scheduleUsageLimitRetry(agent, errorMessage);
      return;
    }

    if (managed && (!route.quiet || errorClass === "user")) {
      void deps.store.incrementMetric("interrupts").catch(() => undefined);
    }
    void deps.store.incrementMetric("triageRuleCount").catch(() => undefined);
    const triage: MainChatSessionTriage = {
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      title,
      managedByMainChat: managed,
      phase: errorClass === "user" ? "blocked_user" : "interrupted",
      summary: `本轮异常中断：${errorMessage.slice(0, 90)}`,
      waitReason: errorMessage.slice(0, 140),
      suggestedAction: "打开会话处理错误或重试",
      triageSource: "rule",
      updatedAt: new Date(getNowMs()).toISOString(),
    };
    void deps.store.putTriage(triage).catch(() => undefined);
    enqueueStructuredSignal({
      kind: errorClass === "user" ? "needs_you" : "interrupted",
      urgency: "urgent",
      taskId: route.task?.id ?? null,
      agentId: agent.id,
      serverId: deps.serverId ?? null,
      conversationId: errorClass === "user" ? null : route.conversationId,
      title,
      summary: triage.summary,
      fingerprintSeed: `failed:${errorMessage.slice(0, 60)}`,
      quiet: route.quiet,
      escalatedToUser: errorClass === "user",
    });
  }

  function recordToolCallForLoopDetection(
    agentId: string,
    toolName: string,
    detailText: string | null,
    now: number,
  ): void {
    const tracker: AgentToolLoopTracker = toolLoopByAgent.get(agentId) ?? {
      lastSubstantiveAt: now,
      noProgressSinceAt: null,
      noProgressCalls: 0,
      totalCallsSinceSubstantive: 0,
      lastToolSignature: null,
      repeatedSignatureCount: 0,
      nudgedAt: null,
    };

    if (isSubstantiveProgressToolCall(toolName, detailText)) {
      tracker.lastSubstantiveAt = now;
      tracker.noProgressSinceAt = null;
      tracker.noProgressCalls = 0;
      tracker.totalCallsSinceSubstantive = 0;
      tracker.lastToolSignature = null;
      tracker.repeatedSignatureCount = 0;
      tracker.nudgedAt = null;
      toolLoopByAgent.set(agentId, tracker);
      return;
    }

    tracker.totalCallsSinceSubstantive += 1;
    const signature = `${toolName.toLowerCase()}:${(detailText ?? "").trim().slice(0, 80)}`;
    if (signature === tracker.lastToolSignature) {
      tracker.repeatedSignatureCount += 1;
    } else {
      tracker.lastToolSignature = signature;
      tracker.repeatedSignatureCount = 1;
    }

    const isWaitCall =
      isNoProgressToolCall(toolName, detailText) || tracker.repeatedSignatureCount >= 3;
    if (isWaitCall) {
      if (tracker.noProgressSinceAt === null) {
        tracker.noProgressSinceAt = now;
      }
      tracker.noProgressCalls += 1;
    }

    toolLoopByAgent.set(agentId, tracker);
  }

  async function runOptionalSemanticTriage(input: {
    live: ManagedAgent;
    title: string;
    projectName: string;
    lastReply: string;
    settings: ReturnType<MainChatStore["getSettings"]>;
  }): Promise<SemanticTriageOutput | null> {
    const power = evaluatePowerState();
    if (!power.allowSemanticTriage || input.lastReply.length === 0) {
      return null;
    }
    try {
      const mainAgentId = await resolveMainAgentId();
      let providers: Array<{ provider: AgentProvider; model?: string; thinkingOptionId?: string }> =
        [];
      if (deps.semanticTriageRunner) {
        providers = [{ provider: input.live.provider }];
      } else if (deps.providerSnapshotManager) {
        providers = await resolveMainChatBackgroundProviders({
          backgroundModel: input.settings.backgroundModel,
          cwd: input.live.cwd,
          providerSnapshotManager: deps.providerSnapshotManager,
          daemonConfig: deps.readDaemonConfig?.() ?? null,
          mainSelection: resolveMainSelection(mainAgentId),
        });
      }
      if (providers.length === 0) return null;
      return await (deps.semanticTriageRunner ?? runMainChatSemanticTriage)({
        agentManager: deps.agentManager,
        cwd: input.live.cwd,
        sessionTitle: input.title,
        projectName: input.projectName,
        lastAssistantReply: input.lastReply,
        providers,
        logger: deps.logger,
        onUsage: (usage, meta) => {
          void deps.store
            .recordTokenUsage({
              source: "triage",
              provider: meta.provider,
              model: meta.model,
              inputTokens: usage.inputTokens,
              cachedInputTokens: usage.cachedInputTokens,
              outputTokens: usage.outputTokens,
              costUsd: usage.totalCostUsd,
              atMs: getNowMs(),
            })
            .catch((error) => {
              deps.logger.warn({ err: error }, "Failed to record semantic triage token usage");
            });
        },
      });
    } catch (error) {
      deps.logger.warn(
        { err: error, agentId: input.live.id },
        "Semantic triage failed; falling back to deterministic rules",
      );
      return null;
    }
  }

  async function tryAutoDelegateLowRiskQuestion(input: {
    agent: ManagedAgent;
    title: string;
    managed: boolean;
    triage: MainChatSessionTriage;
    suggestedReply: string;
    settings: ReturnType<MainChatStore["getSettings"]>;
  }): Promise<boolean> {
    const questionKey = input.triage.waitReason || input.triage.summary;
    const redLine = checkRedLineGuard({
      kind: "question",
      question: questionKey,
      answer: input.suggestedReply,
    });
    if (redLine.blocked) {
      deps.logger.info(
        { agentId: input.agent.id, category: redLine.category, rule: redLine.matchedRule },
        "Blocked auto-delegation by hardcoded red-line guard",
      );
      return false;
    }

    const route = resolveTaskRouteForAgent(input.agent);
    const nowMs = getNowMs();
    const recentRecords = deps.store.listRecentDelegatedQuestions(input.agent.id, nowMs);
    if (route.task) {
      recentRecords.push(
        ...deps.store.listRecentDelegatedQuestions(`task:${route.task.id}`, nowMs),
      );
    }
    const dupCheck = checkDuplicateQuestionGuard({
      question: questionKey,
      recentQuestions: recentRecords,
      nowMs,
    });
    if (dupCheck.isDuplicate) {
      deps.logger.info(
        { agentId: input.agent.id, similarity: dupCheck.similarity },
        "Blocked repeated question auto-delegation within 24h window",
      );
      return false;
    }

    try {
      await deps.store.recordDelegatedQuestion(input.agent.id, questionKey);
      if (route.task) {
        await deps.store.recordDelegatedQuestion(`task:${route.task.id}`, questionKey);
      }
      await sendPromptToAgent({
        agentId: input.agent.id,
        prompt: `（由「${input.settings.title}」代为确认，属低风险技术细节）${input.suggestedReply}`,
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger: deps.logger,
        unarchive: false,
      });
      await deps.store.incrementMetric("autoDelegatedQuestions");
      await deps.store.incrementMetric("supervisorHeld");
      await deps.store.putTriage({
        ...input.triage,
        phase: "working",
        summary: `管家已代答技术细节并继续推进：${input.suggestedReply.slice(0, 60)}`,
        waitReason: null,
        updatedAt: new Date(getNowMs()).toISOString(),
      });
      enqueueStructuredSignal({
        kind: "report",
        urgency: "normal",
        taskId: route.task?.id ?? null,
        agentId: input.agent.id,
        serverId: deps.serverId ?? null,
        conversationId: route.conversationId,
        title: input.title,
        summary: `已代答低风险技术问题并续跑：「${input.suggestedReply.slice(0, 80)}」`,
        fingerprintSeed: `delegated:${questionKey.slice(0, 50)}`,
        quiet: route.quiet,
      });
      return true;
    } catch (error) {
      deps.logger.warn(
        { err: error, agentId: input.agent.id },
        "Proactive auto-delegation failed; escalating to steward",
      );
      return false;
    }
  }

  async function buildTurnTriageOutcome(input: {
    live: ManagedAgent;
    title: string;
    managed: boolean;
    lastReply: string;
    semanticResult: SemanticTriageOutput | null;
  }): Promise<{
    triage: MainChatSessionTriage;
    riskyAction: boolean;
    isLowRiskTechQuestion: boolean;
    suggestedReply: string | null;
  }> {
    const nowIso = new Date(getNowMs()).toISOString();
    if (input.semanticResult) {
      await deps.store.incrementMetric("triageModelCount");
      return {
        riskyAction: input.semanticResult.riskyAction,
        isLowRiskTechQuestion: input.semanticResult.isLowRiskTechnicalQuestion,
        suggestedReply: input.semanticResult.suggestedReply,
        triage: {
          agentId: input.live.id,
          workspaceId: input.live.workspaceId ?? null,
          title: input.title,
          managedByMainChat: input.managed,
          phase: input.semanticResult.phase,
          summary: input.semanticResult.summary,
          waitReason: input.semanticResult.waitReason,
          suggestedAction:
            input.semanticResult.suggestedReply ??
            (input.semanticResult.needsUserDecision ? "需要用户确认下一步" : null),
          triageSource: "model",
          updatedAt: nowIso,
        },
      };
    }

    await deps.store.incrementMetric("triageRuleCount");
    const rule = heuristicTriageAssistantReply(input.lastReply);
    return {
      riskyAction: rule.riskyAction,
      isLowRiskTechQuestion: false,
      suggestedReply: null,
      triage: {
        agentId: input.live.id,
        workspaceId: input.live.workspaceId ?? null,
        title: input.title,
        managedByMainChat: input.managed,
        phase: rule.phase,
        summary: rule.summary,
        waitReason: rule.waitReason,
        suggestedAction: rule.suggestedAction,
        triageSource: "rule",
        updatedAt: nowIso,
      },
    };
  }

  function emitPostTriageSignal(input: {
    agent: ManagedAgent;
    title: string;
    managed: boolean;
    triage: MainChatSessionTriage;
    riskyAction: boolean;
  }): void {
    const { triage } = input;
    const route = resolveTaskRouteForAgent(input.agent);

    if (triage.phase === "blocked_user") {
      const detail = triage.waitReason
        ? `${triage.summary}（卡点：${triage.waitReason}）`
        : triage.summary;
      const targetConvId = input.riskyAction ? null : route.conversationId;
      enqueueStructuredSignal({
        kind: "needs_you",
        urgency: "urgent",
        taskId: route.task?.id ?? null,
        agentId: input.agent.id,
        serverId: deps.serverId ?? null,
        conversationId: targetConvId,
        title: input.title,
        summary: detail,
        fingerprintSeed: `blocked:${triage.waitReason ?? triage.summary}`.slice(0, 80),
        quiet: route.quiet,
        isRedLine: input.riskyAction,
        escalatedToUser: true,
      });
      // Triage already waited triageSettleMs after turn completion; flush immediately if urgent cooldown allows.
      void signalQueue.flushBucket(targetConvId, { skipGather: true });
      return;
    }

    if (triage.phase === "done") {
      enqueueStructuredSignal({
        kind: "review",
        urgency: "normal",
        taskId: route.task?.id ?? null,
        agentId: input.agent.id,
        serverId: deps.serverId ?? null,
        conversationId: route.conversationId,
        title: input.title,
        summary: triage.summary,
        fingerprintSeed: `done:${triage.summary}`.slice(0, 80),
        quiet: route.quiet,
      });
      return;
    }

    if (triage.phase === "unsure") {
      enqueueStructuredSignal({
        kind: "unjudged",
        urgency: "normal",
        taskId: route.task?.id ?? null,
        agentId: input.agent.id,
        serverId: deps.serverId ?? null,
        conversationId: route.conversationId,
        title: input.title,
        summary: triage.summary,
        fingerprintSeed: `unjudged:${triage.summary}`.slice(0, 80),
        quiet: route.quiet,
      });
    }
  }

  async function settleAndTriageCompletedTurn(agentId: string): Promise<void> {
    const live = deps.agentManager.getAgent(agentId);
    if (!isObservedFleetAgent(live)) return;
    if (live.lifecycle === "running" || live.pendingPermissions.size > 0) return;

    const record = await deps.agentStorage.get(agentId);
    if (record?.archivedAt) return;

    const settings = deps.store.getSettings();
    const title = live.config.title?.trim() || basenameOf(live.cwd);
    const projectName = basenameOf(live.cwd);
    const managed = isManagedChildAgent(live);
    const lastReply =
      lastAssistantTextByAgent.get(agentId)?.trim() ||
      extractLastAssistantTextFromTimeline(deps.agentManager.getTimeline(agentId));

    const semanticResult = await runOptionalSemanticTriage({
      live,
      title,
      projectName,
      lastReply,
      settings,
    });
    const outcome = await buildTurnTriageOutcome({
      live,
      title,
      managed,
      lastReply,
      semanticResult,
    });

    const canAutoDelegate =
      outcome.triage.phase === "blocked_user" &&
      !outcome.riskyAction &&
      outcome.isLowRiskTechQuestion &&
      Boolean(outcome.suggestedReply) &&
      settings.capabilities.autoDelegateManualQuestions;
    if (canAutoDelegate && outcome.suggestedReply) {
      const delegated = await tryAutoDelegateLowRiskQuestion({
        agent: live,
        title,
        managed,
        triage: outcome.triage,
        suggestedReply: outcome.suggestedReply,
        settings,
      });
      if (delegated) return;
    }

    await deps.store.putTriage(outcome.triage);
    emitPostTriageSignal({
      agent: live,
      title,
      managed,
      triage: outcome.triage,
      riskyAction: outcome.riskyAction,
    });
  }

  function scheduleCompletedTurnTriage(agentId: string): void {
    clearTimerMapEntry(pendingTriageTimers, agentId);
    const delayMs = effectiveTriageSettleMs();
    const timer = setTimeout(() => {
      pendingTriageTimers.delete(agentId);
      void settleAndTriageCompletedTurn(agentId).catch((error) => {
        deps.logger.warn({ err: error, agentId }, "Completed turn triage failed");
      });
    }, delayMs);
    timer.unref?.();
    pendingTriageTimers.set(agentId, timer);
  }

  function handleAgentStateEvent(
    agent: ManagedAgent,
    settings: ReturnType<MainChatStore["getSettings"]>,
  ): void {
    const now = getNowMs();
    if (agent.lifecycle === "running") {
      clearTimerMapEntry(pendingTriageTimers, agent.id);
      if (!lastActivityAtByAgent.has(agent.id)) {
        lastActivityAtByAgent.set(agent.id, now);
      }
      if (isObservedFleetAgent(agent)) {
        lastFleetOrUserActivityAtMs = Math.max(lastFleetOrUserActivityAtMs, now);
        if (
          lastNightModeState === "hibernating" &&
          resolveMainChatNightMode(settings).behavior === "throttle"
        ) {
          armPatrolTimer();
        }
      }
    }
    if (agent.pendingPermissions.size === 0) {
      permissionFirstSeenAt.delete(agent.id);
      approvalTracker.resolveAllForAgent(agent.id);
      for (const [key, entry] of pendingPermissionRequestsByKey) {
        if (entry.agentId === agent.id) {
          pendingPermissionRequestsByKey.delete(key);
          autoApprovedPermissionKeys.delete(key);
        }
      }
    }
  }

  function handleManagerEvent(event: AgentManagerEvent): void {
    deps.turnQueue.handleEvent(event);
    deps.onAgentEvent?.(event);
    const settings = deps.store.getSettings();
    if (!isMainChatEnabled(settings)) {
      return;
    }
    if (event.type === "agent_removed") {
      clearAgentState(event.agentId);
      deps.contextSnapshots.invalidateCache();
      return;
    }
    if (event.type === "agent_state") {
      handleAgentStateEvent(event.agent, settings);
      return;
    }
    if (event.type !== "agent_stream") return;

    const now = getNowMs();
    lastActivityAtByAgent.set(event.agentId, now);
    stalledNudgedAtByAgent.delete(event.agentId);

    const agent = deps.agentManager.getAgent(event.agentId);
    if (!isObservedFleetAgent(agent)) return;
    lastFleetOrUserActivityAtMs = Math.max(lastFleetOrUserActivityAtMs, now);

    if (event.event.type === "turn_started") {
      clearTimerMapEntry(pendingTriageTimers, event.agentId);
      permissionFirstSeenAt.delete(event.agentId);
      return;
    }

    if (event.event.type === "timeline") {
      const item = event.event.item;
      if (item.type === "assistant_message" && item.text.trim().length > 0) {
        lastAssistantTextByAgent.set(event.agentId, item.text.trim());
      } else if (item.type === "tool_call") {
        recordToolCallForLoopDetection(
          event.agentId,
          item.name,
          extractToolDetailText(item.detail),
          now,
        );
      }
      return;
    }

    if (event.event.type === "turn_completed") {
      clearTimerMapEntry(pendingRetryTimers, event.agentId);
      transientRetriesByAgent.delete(event.agentId);
      transientEscalatedAgents.delete(event.agentId);
      usageLimitRetriedAgents.delete(event.agentId);
      usageLimitEscalatedAgents.delete(event.agentId);
      usageLimitWakeAtByAgent.delete(event.agentId);
      toolLoopByAgent.delete(event.agentId);
      deps.contextSnapshots.invalidateCache();
      scheduleCompletedTurnTriage(event.agentId);
      return;
    }

    if (event.event.type === "turn_failed") {
      clearTimerMapEntry(pendingTriageTimers, event.agentId);
      deps.contextSnapshots.invalidateCache();
      handleTurnFailed(agent, event.event.error);
      return;
    }

    if (event.event.type === "permission_requested") {
      deps.contextSnapshots.invalidateCache();
      handlePermissionRequested(agent, event.event.request);
      return;
    }

    if (event.event.type === "permission_resolved") {
      deps.contextSnapshots.invalidateCache();
      handlePermissionResolved(
        event.agentId,
        event.event.requestId,
        event.event.resolution.behavior,
      );
    }
  }

  function isApprovalSupervisorBusy(entry: ApprovalInterceptionEntry): boolean {
    if (entry.tier === "main") {
      const liveMain = deps.agentManager
        .listAgents()
        .find((agent) => !agent.background && isMainChatLabels(agent.labels));
      if (!liveMain) return false;
      return (
        liveMain.lifecycle === "running" ||
        deps.turnQueue.isBackgroundBusy(liveMain.id) ||
        deps.turnQueue.isForegroundActive(liveMain.id)
      );
    }
    return false;
  }

  function handleApprovalEscalations(escalations: readonly ApprovalEscalationEvent[]): number {
    let added = 0;
    for (const event of escalations) {
      const live = deps.agentManager.getAgent(event.entry.agentId);
      const title = live?.config.title?.trim() || event.entry.label;
      if (event.toTier === "main") {
        enqueueStructuredSignal({
          kind: "escalated",
          urgency: "urgent",
          taskId: event.entry.taskId,
          agentId: event.entry.agentId,
          serverId: event.entry.serverId,
          conversationId: null,
          title,
          summary: `方向主管未及时处理待审批项「${event.entry.label}」，已自动升级给主对话`,
          fingerprintSeed: `escalate:main:${event.entry.requestId}`,
        });
        added += 1;
        continue;
      }

      if (event.toTier === "user") {
        void deps.store.incrementMetric("interrupts").catch(() => undefined);
        const reasonText = resolveEscalationReasonText(event.reason);
        enqueueStructuredSignal({
          kind: "needs_you",
          urgency: "urgent",
          taskId: event.entry.taskId,
          agentId: event.entry.agentId,
          serverId: event.entry.serverId,
          conversationId: null,
          title,
          summary: `待审批项「${event.entry.label}」${reasonText}，已升级交由你直接处理`,
          fingerprintSeed: `escalate:user:${event.entry.requestId}:${event.reason}`,
          escalatedToUser: true,
        });
        added += 1;
      }
    }
    return added;
  }

  function inspectAllStoppedTasks(now: number): number {
    const candidates = detectAllStoppedTasks({
      tasks: deps.store.listTasks({ includeCompleted: false }),
      getLiveAgentState: (agentId) => {
        const live = deps.agentManager.getAgent(agentId);
        return live ? { lifecycle: live.lifecycle, updatedAtMs: live.updatedAt.getTime() } : null;
      },
      hasPendingRetry: (agentId) => pendingRetryTimers.has(agentId),
      nowMs: now,
      thresholdMs: deps.allStoppedThresholdMs ?? ALL_STOPPED_THRESHOLD_MS,
    });

    let added = 0;
    for (const candidate of candidates) {
      const hasActiveLeader =
        candidate.task.conversationId &&
        deps.isLeaderConversationActive?.(candidate.task.conversationId);
      const res = enqueueStructuredSignal({
        kind: "all_stopped",
        urgency: "normal",
        taskId: candidate.task.id,
        agentId: candidate.task.activeAgentId ?? candidate.agentIds[0] ?? null,
        serverId: candidate.task.serverId ?? deps.serverId ?? null,
        conversationId: hasActiveLeader ? (candidate.task.conversationId ?? null) : null,
        title: candidate.task.title,
        summary: `关联的全部 ${candidate.agentIds.length} 个子 Agent 已停止运行超过 ${candidate.stoppedMinutes} 分钟且无后续唤醒`,
        fingerprintSeed: `all_stopped:${candidate.latestActivityMs}`,
        quiet: candidate.task.quiet !== false,
      });
      if (res.queued) added += 1;
    }
    return added;
  }

  function inspectPendingPermissions(
    agent: ManagedAgent,
    meta: { title: string; managed: boolean },
    now: number,
    needsYouEscalateMs: number,
  ): number {
    const firstSeen = permissionFirstSeenAt.get(agent.id) ?? agent.updatedAt.getTime();
    permissionFirstSeenAt.set(agent.id, firstSeen);
    if (now - firstSeen < needsYouEscalateMs) return 0;

    const firstPerm = Array.from(agent.pendingPermissions.values())[0];
    if (firstPerm) {
      const tracked = approvalTracker.get(agent.id, firstPerm.id);
      if (tracked?.pausedForClarification) {
        return 0;
      }
    }

    const waitedMin = Math.max(1, Math.round((now - firstSeen) / 60_000));
    const permLabel = firstPerm?.title?.trim() || firstPerm?.name?.trim() || "待审批请求";
    const route = resolveTaskRouteForAgent(agent);
    const res = enqueueStructuredSignal({
      kind: "needs_you",
      urgency: "urgent",
      taskId: route.task?.id ?? null,
      agentId: agent.id,
      serverId: deps.serverId ?? null,
      conversationId: null,
      title: meta.title,
      summary: `等待权限审批已超过 ${waitedMin} 分钟（${permLabel}）`,
      fingerprintSeed: `perm:${firstPerm?.id ?? permLabel}`,
      quiet: route.quiet,
      escalatedToUser: true,
    });
    return res.queued ? 1 : 0;
  }

  async function inspectNoProgressLoop(
    agent: ManagedAgent,
    meta: { title: string; managed: boolean },
    now: number,
    noProgressThresholdMs: number,
    canAutoNudge: boolean,
  ): Promise<{ handled: boolean; signalsAdded: number }> {
    const loopTracker = toolLoopByAgent.get(agent.id);
    if (
      !loopTracker ||
      loopTracker.noProgressSinceAt === null ||
      loopTracker.noProgressCalls < MIN_NO_PROGRESS_TOOL_CALLS ||
      now - loopTracker.noProgressSinceAt < noProgressThresholdMs ||
      loopTracker.nudgedAt !== null
    ) {
      return { handled: false, signalsAdded: 0 };
    }

    loopTracker.nudgedAt = now;
    const minutes = Math.max(1, Math.round((now - loopTracker.noProgressSinceAt) / 60_000));
    const triage: MainChatSessionTriage = {
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      title: meta.title,
      managedByMainChat: meta.managed,
      phase: "no_progress",
      summary: `连续 ${minutes} 分钟只执行等待/轮询类调用（${loopTracker.noProgressCalls} 次），未见实质推进`,
      waitReason: "疑似陷入轮询或重复检查循环",
      suggestedAction: "检查是否卡死或给出新的推进指令",
      triageSource: "rule",
      updatedAt: new Date(now).toISOString(),
    };
    await deps.store.putTriage(triage);

    if (canAutoNudge) {
      deps.logger.info(
        { agentId: agent.id, noProgressCalls: loopTracker.noProgressCalls, minutes },
        "Nudging no-progress looping agent",
      );
      void sendPromptToAgent({
        agentId: agent.id,
        prompt: `检测到你在过去 ${minutes} 分钟内连续执行了多次等待或重复查询且暂无实质文件/验证推进。请直接汇报当前真实阻塞点，或换一种方式推进任务。`,
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger: deps.logger,
        unarchive: false,
      })
        .then(() => deps.store.incrementMetric("noProgressNudges"))
        .then(() => deps.store.incrementMetric("supervisorHeld"))
        .catch((error) => {
          deps.logger.warn({ err: error, agentId: agent.id }, "No-progress nudge failed");
        });
      return { handled: true, signalsAdded: 0 };
    }

    const route = resolveTaskRouteForAgent(agent);
    const res = enqueueStructuredSignal({
      kind: "no_progress",
      urgency: "normal",
      taskId: route.task?.id ?? null,
      agentId: agent.id,
      serverId: deps.serverId ?? null,
      conversationId: route.conversationId,
      title: meta.title,
      summary: triage.summary,
      fingerprintSeed: `noprogress:${loopTracker.noProgressSinceAt}`,
      quiet: route.quiet,
    });
    return { handled: true, signalsAdded: res.queued ? 1 : 0 };
  }

  async function inspectSilentStalledAgent(
    agent: ManagedAgent,
    meta: { title: string; managed: boolean },
    now: number,
    stalledThresholdMs: number,
    canAutoNudge: boolean,
  ): Promise<number> {
    const lastActivity = lastActivityAtByAgent.get(agent.id) ?? agent.updatedAt.getTime();
    if (now - lastActivity < stalledThresholdMs || stalledNudgedAtByAgent.has(agent.id)) {
      return 0;
    }

    stalledNudgedAtByAgent.set(agent.id, now);
    const idleMin = Math.max(1, Math.round((now - lastActivity) / 60_000));
    const triage: MainChatSessionTriage = {
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      title: meta.title,
      managedByMainChat: meta.managed,
      phase: "stalled",
      summary: `已静默运行 ${idleMin} 分钟无新动态`,
      waitReason: "长时间无新输出或工具事件",
      suggestedAction: "提醒汇报进展或检查进程状态",
      triageSource: "rule",
      updatedAt: new Date(now).toISOString(),
    };
    await deps.store.putTriage(triage);

    if (canAutoNudge) {
      deps.logger.info(
        { agentId: agent.id, idleMs: now - lastActivity },
        "Nudging quiet running agent",
      );
      void sendPromptToAgent({
        agentId: agent.id,
        prompt: "检测到你已静默运行一段时间，请简要汇报当前进展，或直接继续推进并完成当前任务。",
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger: deps.logger,
        unarchive: false,
      })
        .then(() => deps.store.incrementMetric("stalledNudges"))
        .catch((error) => {
          deps.logger.warn({ err: error, agentId: agent.id }, "Stalled nudge failed");
        });
      return 0;
    }

    const route = resolveTaskRouteForAgent(agent);
    const res = enqueueStructuredSignal({
      kind: "stalled",
      urgency: "normal",
      taskId: route.task?.id ?? null,
      agentId: agent.id,
      serverId: deps.serverId ?? null,
      conversationId: route.conversationId,
      title: meta.title,
      summary: triage.summary,
      fingerprintSeed: `stalled:${lastActivity}`,
      quiet: route.quiet,
    });
    return res.queued ? 1 : 0;
  }

  async function scanFleetAndBuildSignals(): Promise<{
    scannedSessions: number;
    signalsFound: number;
  }> {
    const now = getNowMs();
    const settings = deps.store.getSettings();
    const stalledThresholdMs = effectiveStalledThresholdMs();
    const noProgressThresholdMs = effectiveNoProgressThresholdMs();
    const needsYouEscalateMs = effectiveNeedsYouEscalateMs();
    const agents = deps.agentManager.listAgents().filter(isObservedFleetAgent);
    let newSignals = 0;

    const escalations = approvalTracker.evaluateTick(now, isApprovalSupervisorBusy);
    newSignals += handleApprovalEscalations(escalations);
    newSignals += inspectAllStoppedTasks(now);

    for (const agent of agents) {
      const meta = {
        title: agent.config.title?.trim() || basenameOf(agent.cwd),
        managed: isManagedChildAgent(agent),
      };

      if (agent.pendingPermissions.size > 0) {
        newSignals += inspectPendingPermissions(agent, meta, now, needsYouEscalateMs);
        continue;
      }

      if (agent.lifecycle !== "running") continue;

      const canAutoNudge = meta.managed || settings.capabilities.autoNudgeManualStalled;
      const loopResult = await inspectNoProgressLoop(
        agent,
        meta,
        now,
        noProgressThresholdMs,
        canAutoNudge,
      );
      if (loopResult.handled) {
        newSignals += loopResult.signalsAdded;
        continue;
      }

      newSignals += await inspectSilentStalledAgent(
        agent,
        meta,
        now,
        stalledThresholdMs,
        canAutoNudge,
      );
    }

    return {
      scannedSessions: agents.length,
      signalsFound: signalQueue.getPendingCount() + newSignals,
    };
  }

  function formatPatrolSummary(
    scannedSessions: number,
    signalsFound: number,
    wokeMainChat: boolean,
  ): string {
    if (wokeMainChat) {
      return `已巡检 ${scannedSessions} 个活跃会话，发现 ${signalsFound} 条动态并唤醒管家汇报`;
    }
    if (signalsFound > 0) {
      return `已巡检 ${scannedSessions} 个活跃会话，记录 ${signalsFound} 条动态（等待聚拢/冷却窗口汇总）`;
    }
    return `已巡检 ${scannedSessions} 个活跃会话，目前无新增异常动态`;
  }

  async function dispatchEmptyManualPatrol(mainAgentId: string | null): Promise<boolean> {
    const targetId = mainAgentId ?? (await resolveMainAgentId());
    if (!targetId) return false;
    const queued = await deps.turnQueue.enqueueBackground({
      mainAgentId: targetId,
      dedupeKey: "patrol:wakeup",
      trigger: "manual_patrol",
      priority: 30,
      summary: "手动巡检并汇报（0 条新增异常）",
      requeueOnPreempt: true,
      buildPrompt: async () => {
        const latestSettings = deps.store.getSettings();
        const contextSnapshot = await deps.contextSnapshots.buildTurnContext(targetId, {
          forceFull: true,
        });
        return buildMainChatSupervisionWakeupPrompt({
          settings: latestSettings,
          signals: [],
          digest: null,
          contextSnapshot,
          manualTrigger: true,
        });
      },
      onDispatched: async () => {
        await deps.store.setLastWakeupAt(new Date(getNowMs()).toISOString());
        await deps.store.incrementMetric("proactiveWakeups");
      },
    });
    return queued.status === "dispatched" || queued.status === "queued";
  }

  async function runPatrol(options?: {
    mainAgentId?: string | null;
    forceWakeup?: boolean;
    manualTrigger?: boolean;
  }): Promise<MainChatPatrolResult> {
    const patrolledAt = new Date(getNowMs()).toISOString();
    const settings = deps.store.getSettings();
    if (!isMainChatEnabled(settings)) {
      return {
        scannedSessions: 0,
        signalsFound: 0,
        wokeMainChat: false,
        summary: "主对话功能已关闭，跳过巡检",
        patrolledAt,
      };
    }

    const force = options?.forceWakeup === true || options?.manualTrigger === true;
    const power = evaluatePowerState();
    lastNightModeState = power.status.state;
    if (!force && !power.allowPatrol) {
      return {
        scannedSessions: 0,
        signalsFound: signalQueue.getPendingCount(),
        wokeMainChat: false,
        summary: power.status.reason ?? "夜间休眠中，已暂停自动巡检",
        patrolledAt,
      };
    }

    deps.contextSnapshots.invalidateCache();
    const { scannedSessions } = await scanFleetAndBuildSignals();
    const signalsFound = signalQueue.getPendingCount();
    await deps.store.setLastPatrolAt(patrolledAt);
    await deps.store.incrementMetric("patrolRuns");

    manualFlushActive = force;
    manualTargetMainAgentId = options?.mainAgentId ?? null;
    let wokeMainChat = false;
    try {
      const flushResults = await signalQueue.flushAll({ force });
      wokeMainChat = flushResults.some((item) => item.delivered);
      if (!wokeMainChat && force) {
        wokeMainChat = await dispatchEmptyManualPatrol(options?.mainAgentId ?? null);
      }
    } finally {
      manualFlushActive = false;
      manualTargetMainAgentId = null;
    }

    if (deps.onPatrolTick) {
      await Promise.resolve(deps.onPatrolTick()).catch((error) => {
        deps.logger.warn({ err: error }, "Patrol tick maintenance hook failed");
      });
    }

    return {
      scannedSessions,
      signalsFound,
      wokeMainChat,
      summary: formatPatrolSummary(scannedSessions, signalsFound, wokeMainChat),
      patrolledAt,
    };
  }

  function clearAllPendingTimers(): void {
    if (patrolTimer) {
      clearTimeout(patrolTimer);
      patrolTimer = null;
    }
    signalQueue.stop();
    for (const timer of pendingRetryTimers.values()) clearTimeout(timer);
    pendingRetryTimers.clear();
    for (const timer of pendingTriageTimers.values()) clearTimeout(timer);
    pendingTriageTimers.clear();
  }

  function armPatrolTimer(): void {
    if (patrolTimer) {
      clearTimeout(patrolTimer);
      patrolTimer = null;
    }
    if (!unsubscribeEvents) return;
    const power = evaluatePowerState();
    lastNightModeState = power.status.state;
    if (power.nextTimerDelayMs === null) {
      return;
    }
    const delayMs = Math.max(50, power.nextTimerDelayMs);
    patrolTimer = setTimeout(() => {
      patrolTimer = null;
      void (async () => {
        try {
          const nextPower = evaluatePowerState();
          lastNightModeState = nextPower.status.state;
          if (nextPower.allowPatrol) {
            await runPatrol();
          }
        } catch (error) {
          deps.logger.warn({ err: error }, "Periodic main-chat patrol failed");
        } finally {
          armPatrolTimer();
        }
      })();
    }, delayMs);
    patrolTimer.unref?.();
  }

  return {
    start() {
      if (unsubscribeEvents) return;
      unsubscribeEvents = deps.agentManager.subscribe(handleManagerEvent);
      armPatrolTimer();
    },

    stop() {
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      clearAllPendingTimers();
    },

    refreshSchedule() {
      if (!isMainChatEnabled(deps.store.getSettings())) {
        clearAllPendingTimers();
        return;
      }
      if (!unsubscribeEvents) return;
      armPatrolTimer();
    },

    getNightModeStatus() {
      return evaluatePowerState().status;
    },

    notifyUserForegroundActivity(atMs) {
      const now = atMs ?? getNowMs();
      lastUserForegroundAtMs = now;
      lastFleetOrUserActivityAtMs = Math.max(lastFleetOrUserActivityAtMs, now);
      if (unsubscribeEvents && lastNightModeState === "hibernating") {
        armPatrolTimer();
      }
    },

    runPatrol,

    enqueueSignal(input) {
      return enqueueStructuredSignal(input);
    },

    listPendingSignals(conversationId) {
      return signalQueue.listPending(conversationId);
    },

    getPendingSignalCount(conversationId) {
      return signalQueue.getPendingCount(conversationId);
    },

    pausePermissionForClarification(input) {
      const paused = approvalTracker.pauseForClarification({
        agentId: input.agentId,
        serverId: input.serverId ?? deps.serverId ?? null,
        requestId: input.permissionRequestId,
        label: input.label,
        taskId: input.taskId,
        conversationId: input.conversationId,
        nowMs: getNowMs(),
      });
      return { pausedDeadlineAt: paused.pausedDeadlineAt };
    },

    getApprovalTracker() {
      return approvalTracker;
    },

    async dispatchInitialBriefing(mainAgentId) {
      const settings = deps.store.getSettings();
      if (!isMainChatEnabled(settings) || !settings.capabilities.initialBriefingEnabled) {
        return false;
      }
      if (initialBriefingSentAgents.has(mainAgentId)) return false;
      const existingTimeline = deps.agentManager.getTimeline(mainAgentId);
      if (existingTimeline.length > 0) {
        initialBriefingSentAgents.add(mainAgentId);
        return false;
      }
      initialBriefingSentAgents.add(mainAgentId);
      try {
        const queued = await deps.turnQueue.enqueueBackground({
          mainAgentId,
          dedupeKey: "initial:briefing",
          trigger: "initial_briefing",
          priority: 8,
          summary: "首次就绪简报",
          requeueOnPreempt: false,
          buildPrompt: async () => {
            if (deps.agentManager.getTimeline(mainAgentId).length > 0) {
              return null;
            }
            const contextSnapshot = await deps.contextSnapshots.buildTurnContext(mainAgentId, {
              forceFull: true,
            });
            return buildMainChatInitialBriefingPrompt({
              settings: deps.store.getSettings(),
              contextSnapshot,
            });
          },
          onDispatched: async () => {
            await deps.store.setLastWakeupAt(new Date(getNowMs()).toISOString());
          },
        });
        return queued.status !== "skipped";
      } catch (error) {
        deps.logger.warn(
          { err: error, mainAgentId },
          "Failed to dispatch initial main-chat briefing",
        );
        return false;
      }
    },
  };
}
