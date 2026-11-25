import path from "node:path";
import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  MAIN_CHAT_TASK_QUIET_LABEL,
  getMainChatTaskMetaFromLabels,
  isFormerMainChatLabels,
  isMainChatEnabled,
  isMainChatLabels,
  resolveMainChatModelSlot,
  resolveMainChatNightMode,
  type MainChatConversationRecord,
  type MainChatNightModeStatus,
  type MainChatNotificationReceipt,
  type MainChatPatrolResult,
  type MainChatRuleDiagnostic,
  type MainChatSessionTriage,
  type MainChatSupervisionSignal,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
} from "@getpaseo/protocol/agent-types";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentProvider, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { StructuredGenerationDaemonConfig } from "../agent/structured-generation-providers.js";
import type { MainChatContextSnapshotBuilder } from "./context-snapshot.js";
import type { AggregatedHostAgent } from "./fleet-aggregator.js";
import type {
  FleetBridgeAgentsChangedEvent,
  FleetBridgePermissionRequestedEvent,
  FleetBridgePermissionResolvedEvent,
} from "./fleet-bridge.js";
import type { MainChatBridgeEvent } from "./feishu-bridge-seam.js";
import { hasHandoffBlockLabel } from "./limit-fallback.js";
import { evaluateMainChatNightMode, type MainChatNightModeEvaluation } from "./night-mode.js";
import {
  createNotificationReceiptId,
  evaluateNotificationDispatch,
} from "./notification-policy.js";
import {
  buildMainChatInitialBriefingPrompt,
  buildMainChatSupervisionWakeupPrompt,
} from "./prompts.js";
import {
  createZeroTokenRuleWindowManager,
  detectReadWithoutReply,
  type ZeroTokenRuleWindowManager,
} from "./zero-token-rules.js";
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
import {
  runStatelessBackgroundSupervisionRound,
  shouldRunStatelessSupervisionRound,
  type StatelessSupervisionRunner,
} from "./stateless-supervision.js";
import type { MainChatTurnQueue } from "./turn-queue.js";
import {
  classifyMainChatTurnError,
  heuristicTriageAssistantReply,
  isCancelledTurnError,
  isLimitFallbackError,
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
  listLeaderConversations?: () =>
    | Promise<MainChatConversationRecord[]>
    | MainChatConversationRecord[];
  isRemoteHostOffline?: (serverId: string) => boolean;
  sweepTaskDeliveryGates?: (nowMs: number) => Promise<number>;
  onTaskReplyPrDiscovered?: (agentId: string, replyText: string) => Promise<void> | void;
  onPatrolTick?: () => Promise<void> | void;
  onAgentEvent?: (event: AgentManagerEvent) => void;
  onTryLimitFallback?: (agent: ManagedAgent, errorMessage: string) => Promise<boolean>;
  onAgentTurnCompleted?: (agent: ManagedAgent) => void;
  onBridgeEvent?: (event: MainChatBridgeEvent) => void;
  isHostAllowed?: (serverId: string) => boolean;
  getRemoteAgent?: (serverId: string, agentId: string) => AggregatedHostAgent | null;
  listRemoteAgents?: () => AggregatedHostAgent[];
  respondRemotePermission?: (
    serverId: string,
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
  ) => Promise<void>;
  semanticTriageRunner?: (input: RunSemanticTriageInput) => Promise<SemanticTriageOutput | null>;
  statelessSupervisionRunner?: StatelessSupervisionRunner;
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
  timedOutMultiplier?: number;
  periodicCheckIntervalMs?: number;
  leaderStuckThresholdMs?: number;
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
  handleAgentArchived(agentId: string): Promise<void>;
  getApprovalTracker(): ApprovalInterceptionTracker;
  handleRemotePermissionRequested(event: FleetBridgePermissionRequestedEvent): void;
  handleRemotePermissionResolved(event: FleetBridgePermissionResolvedEvent): void;
  handleRemoteAgentsChanged(event: FleetBridgeAgentsChangedEvent): void;
  reconcileRemoteHostScope(): void;
}

interface AssistantTurnBuffer {
  currentMessageId: string | null;
  currentMessageText: string;
  segments: string[];
}

const MAX_ASSISTANT_TURN_BUFFER_CHARS = 20_000;
const STALE_BLOCKED_PHASES = new Set<MainChatSessionTriage["phase"]>([
  "blocked_user",
  "interrupted",
  "stalled",
  "no_progress",
  "unsure",
]);
const AUTO_RESOLVED_TURN_STARTED_ANSWER = "已在原会话继续处理，该待决策项已自动结项";
const AUTO_RESOLVED_ARCHIVED_ANSWER = "关联会话已归档，该待决策项已自动结项";

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
  // Walk back to the start of the latest turn so streaming chunks or multi-part replies are
  // reconstructed completely instead of returning only the last fragment.
  let turnStart = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i]?.type === "user_message") {
      turnStart = i + 1;
      break;
    }
  }

  const segments: string[] = [];
  let currentMessageId: string | null = null;
  let currentText = "";

  const flushCurrent = () => {
    const trimmed = currentText.trim();
    if (trimmed.length > 0) {
      segments.push(trimmed);
    }
    currentMessageId = null;
    currentText = "";
  };

  for (let i = turnStart; i < items.length; i += 1) {
    const item = items[i];
    if (!item) continue;
    if (item.type === "assistant_message") {
      const nextMessageId = item.messageId ?? null;
      if (nextMessageId && currentMessageId && nextMessageId !== currentMessageId) {
        flushCurrent();
      }
      if (!currentMessageId && nextMessageId) {
        currentMessageId = nextMessageId;
      }
      currentText += item.text;
    } else if (item.type === "tool_call") {
      flushCurrent();
    }
  }
  flushCurrent();

  if (segments.length > 0) {
    return segments.join("\n\n").slice(-MAX_ASSISTANT_TURN_BUFFER_CHARS).trim();
  }

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
  "interrupted",
  "failed",
]);

const ARCHIVED_ALLOWED_SIGNAL_KINDS = new Set<MainChatSupervisionSignal["kind"]>([
  "parent_closeout",
  "pr_merged",
  "pr_conflict",
  "draft_pr",
  "pr_event",
  "todo_ready",
  "decision_reply",
  "orphaned",
  "failed",
  "leader_stuck",
]);

const PARKED_TASK_STALE_SIGNAL_KINDS = new Set<MainChatSupervisionSignal["kind"]>([
  "review",
  "idle",
  "stalled",
  "no_progress",
  "all_stopped",
  "timed_out",
]);

function checkDeliveryOrDagSignalValidity(
  signal: MainChatSupervisionSignal,
  task: MainChatTaskRecord,
): SignalRevalidationOutcome | null {
  if (signal.kind === "draft_pr") {
    if (!task.deliveryGate || task.deliveryGate.prState !== "open" || !task.deliveryGate.isDraft) {
      return { valid: false, reason: "pr_no_longer_draft" };
    }
  }
  if (signal.kind === "pr_conflict") {
    if (
      !task.deliveryGate ||
      task.deliveryGate.prState !== "open" ||
      !task.deliveryGate.hasConflict
    ) {
      return { valid: false, reason: "pr_conflict_resolved" };
    }
  }
  if (signal.kind === "todo_ready" && (task.status !== "open" || task.activeAgentId !== null)) {
    return { valid: false, reason: "task_already_started_or_closed" };
  }
  if (
    signal.kind === "parent_closeout" &&
    (task.status === "completed" || task.status === "cancelled")
  ) {
    return { valid: false, reason: "parent_already_closed" };
  }
  return null;
}

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
  if (task.status === "parked" && PARKED_TASK_STALE_SIGNAL_KINDS.has(signal.kind)) {
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
  if (signal.kind === "orphaned" && liveAgent?.lifecycle === "running") {
    return { valid: false, reason: "agent_recovered" };
  }
  return checkDeliveryOrDagSignalValidity(signal, task);
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
  const assistantTurnBufferByAgent = new Map<string, AssistantTurnBuffer>();
  const stalledNudgedAtByAgent = new Map<string, number>();
  const permissionFirstSeenAt = new Map<string, number>();
  const pendingPermissionRequestsByKey = new Map<string, PendingPermissionMeta>();
  const autoApprovedPermissionKeys = new Set<string>();
  const toolLoopByAgent = new Map<string, AgentToolLoopTracker>();
  const initialBriefingSentAgents = new Set<string>();
  const remoteErrorSigByAgentKey = new Map<string, string>();
  const remoteStalledNotifiedAtByKey = new Map<string, number>();
  const receiptIdBySignalId = new Map<string, string>();
  const passthroughSignalIds = new Set<string>();
  const suppressedReceiptFingerprints = new Map<string, number>();
  let zeroTokenRules: ZeroTokenRuleWindowManager | null = null;

  function getZeroTokenRules(): ZeroTokenRuleWindowManager {
    if (!zeroTokenRules) {
      zeroTokenRules = createZeroTokenRuleWindowManager(deps.store.getZeroTokenRuleState());
    }
    return zeroTokenRules;
  }

  function persistZeroTokenRules(): void {
    if (!zeroTokenRules) return;
    void deps.store.setZeroTokenRuleState(zeroTokenRules.exportState()).catch((error) => {
      deps.logger.warn({ err: error }, "Failed to persist zero-token rule window state");
    });
  }

  function isHandoffBlockedAgent(agent: ManagedAgent | null | undefined): boolean {
    if (!agent) return false;
    return isFormerMainChatLabels(agent.labels) || hasHandoffBlockLabel(agent.labels);
  }

  async function syncTaskRuleDiagnostic(
    agent: ManagedAgent,
    diagnostic: MainChatRuleDiagnostic | null,
  ): Promise<void> {
    const task = deps.store.findTaskByAgentId(agent.id);
    if (!task) return;
    const prev = task.lastRuleDiagnostic ?? null;
    if (
      prev?.kind === diagnostic?.kind &&
      prev?.summary === diagnostic?.summary &&
      prev?.repeatCount === diagnostic?.repeatCount &&
      prev?.errorExcerpt === diagnostic?.errorExcerpt
    ) {
      return;
    }
    await deps.store.putTask({
      ...task,
      lastRuleDiagnostic: diagnostic,
      updatedAt: new Date(getNowMs()).toISOString(),
    });
  }

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
    const localBusy = deps.agentManager
      .listAgents()
      .some(
        (agent) =>
          isObservedFleetAgent(agent) &&
          (agent.lifecycle === "running" || agent.pendingPermissions.size > 0),
      );
    if (localBusy) return true;
    const remoteAgents = deps.listRemoteAgents?.() ?? [];
    return remoteAgents.some(
      (agent) =>
        (!deps.isHostAllowed || deps.isHostAllowed(agent.serverId)) &&
        (agent.lifecycle === "running" || agent.pendingPermissions.length > 0),
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

  function revalidateRemoteSignal(signal: MainChatSupervisionSignal): SignalRevalidationOutcome {
    const serverId = signal.serverId;
    if (!serverId) return true;
    if (deps.isHostAllowed && !deps.isHostAllowed(serverId)) {
      return { valid: false, reason: "host_out_of_scope" };
    }
    const remoteAgent = signal.agentId
      ? (deps.getRemoteAgent?.(serverId, signal.agentId) ?? null)
      : null;
    if (!remoteAgent) return true;
    if (
      (signal.kind === "needs_you" || signal.kind === "ask") &&
      remoteAgent.pendingPermissions.length === 0 &&
      !hasOpenDecisionForSignal(signal)
    ) {
      return { valid: false, reason: "remote_permission_resolved" };
    }
    if (
      signal.kind === "interrupted" &&
      remoteAgent.lifecycle !== "error" &&
      !remoteAgent.lastError
    ) {
      return { valid: false, reason: "remote_error_recovered" };
    }
    if (signal.kind === "stalled" && remoteAgent.lifecycle !== "running") {
      return { valid: false, reason: "remote_no_longer_running" };
    }
    return true;
  }

  function isAllStoppedSignalStillValid(task: MainChatTaskRecord): boolean {
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
    return stillStopped.length > 0;
  }

  async function isSignalAgentArchived(signal: MainChatSupervisionSignal): Promise<boolean> {
    if (!signal.agentId || ARCHIVED_ALLOWED_SIGNAL_KINDS.has(signal.kind)) {
      return false;
    }
    const stored = await deps.agentStorage.get(signal.agentId).catch(() => null);
    return Boolean(stored?.archivedAt);
  }

  async function revalidateSignalLive(
    signal: MainChatSupervisionSignal,
  ): Promise<SignalRevalidationOutcome> {
    if (signal.serverId && signal.serverId !== deps.serverId) {
      return revalidateRemoteSignal(signal);
    }

    const task =
      (signal.taskId ? deps.store.getTask(signal.taskId) : null) ??
      (signal.agentId ? deps.store.findTaskByAgentId(signal.agentId) : null);
    const liveAgent = signal.agentId ? (deps.agentManager.getAgent(signal.agentId) ?? null) : null;

    if (task) {
      const taskVerdict = checkTaskBasedSignalValidity(signal, task, liveAgent);
      if (taskVerdict !== null) return taskVerdict;
    }

    if (await isSignalAgentArchived(signal)) {
      return { valid: false, reason: "agent_archived" };
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

    if (signal.kind === "all_stopped" && task && !isAllStoppedSignalStillValid(task)) {
      return { valid: false, reason: "task_no_longer_all_stopped" };
    }

    return true;
  }

  function canWakeForSupervisionBatch(
    batch: DeliverSupervisionBatchPayload,
    hasPassthroughSignal: boolean,
    settings: ReturnType<MainChatStore["getSettings"]>,
  ): boolean {
    const power = evaluatePowerState();
    if (hasPassthroughSignal) {
      return (
        power.allowUrgentWakeup ||
        !power.status.inNightWindow ||
        settings.capabilities.proactiveWakeupEnabled
      );
    }
    if (batch.hasUrgent || batch.hasImmediate) {
      return power.allowUrgentWakeup;
    }
    return power.allowProactiveWakeup;
  }

  async function tryHandleBatchWithStatelessRound(input: {
    batch: DeliverSupervisionBatchPayload;
    target: { agentId: string; label?: string | null };
    settings: ReturnType<MainChatStore["getSettings"]>;
  }): Promise<
    | { handled: true; delivered: boolean }
    | { handled: false; signalIds: string[]; escalationPreface: string }
  > {
    const validSignals: MainChatSupervisionSignal[] = [];
    for (const sig of input.batch.signals) {
      const outcome = await revalidateSignalLive(sig);
      const isValid = typeof outcome === "boolean" ? outcome : outcome.valid;
      if (isValid) validSignals.push(sig);
    }
    if (validSignals.length === 0) {
      return { handled: true, delivered: false };
    }

    const targetAgent = deps.agentManager.getAgent(input.target.agentId);
    const cwd = targetAgent?.cwd || process.cwd();
    const relatedTaskIds = new Set(
      validSignals.map((sig) => sig.taskId).filter((id): id is string => Boolean(id)),
    );
    const relatedAgentIds = new Set(
      validSignals.map((sig) => sig.agentId).filter((id): id is string => Boolean(id)),
    );
    const relatedTasks = deps.store
      .listTasks({ includeCompleted: true })
      .filter(
        (task) =>
          relatedTaskIds.has(task.id) ||
          (task.activeAgentId !== null && relatedAgentIds.has(task.activeAgentId)) ||
          task.agentIds.some((id) => relatedAgentIds.has(id)),
      );

    const allAgents = deps.agentManager.listAgents().filter((a) => !a.background && !a.internal);
    const fleetCounts = {
      totalActive: allAgents.length,
      running: allAgents.filter((a) => a.lifecycle === "running").length,
      needsYou: allAgents.filter(
        (a) => a.pendingPermissions.size > 0 || a.attention.requiresAttention,
      ).length,
      problematic: allAgents.filter((a) => a.lifecycle === "error").length,
    };

    const providers = targetAgent
      ? await resolveSemanticTriageProviders(targetAgent, input.settings)
      : [];
    const roundResult = await runStatelessBackgroundSupervisionRound({
      agentManager: deps.agentManager,
      cwd,
      signals: validSignals,
      relatedTasks,
      conversationLabel: input.target.label,
      fleetCounts,
      providers,
      runner: deps.statelessSupervisionRunner,
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
          .catch(() => undefined);
      },
    });

    const completedAt = new Date(getNowMs()).toISOString();
    await deps.store.incrementMetric("statelessSupervisionRounds");
    const escalated = roundResult.outcome.decision === "escalate_main";
    if (escalated) {
      await deps.store.incrementMetric("statelessSupervisionEscalations");
    }

    await deps.store.appendActivity({
      id: `act_ss_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      mainAgentId: input.target.agentId,
      kind: roundResult.outcome.decision === "silent" ? "silent_turn" : "background_turn",
      trigger: "stateless_supervision",
      summary: `[无状态督办·${roundResult.outcome.decision}] ${roundResult.outcome.summary}`,
      silent: !escalated,
      status: "completed",
      createdAt: completedAt,
      completedAt,
      relatedAgentId: validSignals[0]?.agentId ?? null,
      detail: JSON.stringify({
        mode: "stateless_single_round",
        decision: roundResult.outcome.decision,
        source: roundResult.source,
        packetChars: roundResult.packetChars,
        escalationReason: roundResult.outcome.escalationReason ?? null,
        recommendedAction: roundResult.outcome.recommendedAction ?? null,
        signalIds: validSignals.map((sig) => sig.id),
        dispositions: roundResult.outcome.signalDispositions ?? [],
      }),
    });

    if (!escalated) {
      await deps.store.incrementMetric("supervisorHeld");
      for (const sig of validSignals) {
        const receiptId = receiptIdBySignalId.get(sig.id);
        receiptIdBySignalId.delete(sig.id);
        passthroughSignalIds.delete(sig.id);
        if (receiptId) {
          await deps.store
            .updateNotificationReceiptStatus(receiptId, {
              status: "acknowledged",
              acknowledgedAt: completedAt,
              updatedAt: completedAt,
              reason: `无状态单轮督办已处理（${roundResult.outcome.decision}）`,
            })
            .catch(() => undefined);
        }
      }
      return { handled: true, delivered: true };
    }

    const reasonLine = roundResult.outcome.escalationReason
      ? `升级原因：${roundResult.outcome.escalationReason}`
      : `无状态评估摘要：${roundResult.outcome.summary}`;
    const actionLine = roundResult.outcome.recommendedAction
      ? `\n建议动作：${roundResult.outcome.recommendedAction}`
      : "";
    return {
      handled: false,
      signalIds: validSignals.map((sig) => sig.id),
      escalationPreface: `【无状态单轮后台督办升级】${reasonLine}${actionLine}`,
    };
  }

  async function deliverSupervisionBatch(batch: DeliverSupervisionBatchPayload): Promise<boolean> {
    const settings = deps.store.getSettings();
    const forced = manualFlushActive;
    if (!isMainChatEnabled(settings)) {
      return false;
    }
    const hasPassthroughSignal = batch.signals.some((sig) => passthroughSignalIds.has(sig.id));
    if (!forced && !canWakeForSupervisionBatch(batch, hasPassthroughSignal, settings)) {
      return false;
    }

    const target = await resolveTargetForConversation(batch.conversationId);
    if (!target) return false;

    const trigger = resolveSupervisionTrigger(forced, batch);
    const priority = resolveSupervisionPriority(forced, batch);
    const summary = forced
      ? `手动巡检并汇报（${batch.signals.length} 条动态）`
      : `后台督办唤醒（${batch.signals.length} 条动态）`;

    let dispatchedSignalIds: string[] = batch.signals.map((sig) => sig.id);
    let statelessEscalationPreface: string | null = null;

    const statelessCheck = shouldRunStatelessSupervisionRound({
      settings,
      signals: batch.signals,
      forced,
      hasPassthroughSignal,
    });

    if (statelessCheck.eligible) {
      const statelessResult = await tryHandleBatchWithStatelessRound({ batch, target, settings });
      if (statelessResult.handled) {
        return statelessResult.delivered;
      }
      dispatchedSignalIds = statelessResult.signalIds;
      statelessEscalationPreface = statelessResult.escalationPreface;
    }

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
          dispatchedSignalIds = finalValid.map((sig) => sig.id);
          const contextSnapshot = await deps.contextSnapshots.buildTurnContext(target.agentId, {
            forceFull: forced,
          });
          const digest =
            finalValid.length > 0
              ? formatSupervisionDigest(finalValid, { conversationLabel: target.label })
              : null;
          const basePrompt = buildMainChatSupervisionWakeupPrompt({
            settings: latestSettings,
            signals: finalValid,
            digest,
            contextSnapshot,
            manualTrigger: forced,
            conversationLabel: target.label,
          });
          return statelessEscalationPreface
            ? `${statelessEscalationPreface}\n\n${basePrompt}`
            : basePrompt;
        },
        onDispatched: async () => {
          const deliveredAt = new Date(getNowMs()).toISOString();
          await deps.store.setLastWakeupAt(deliveredAt);
          await deps.store.incrementMetric("proactiveWakeups");
          for (const signalId of dispatchedSignalIds) {
            const receiptId = receiptIdBySignalId.get(signalId);
            receiptIdBySignalId.delete(signalId);
            passthroughSignalIds.delete(signalId);
            if (receiptId) {
              await deps.store
                .updateNotificationReceiptStatus(receiptId, {
                  status: "delivered",
                  deliveredAt,
                  updatedAt: deliveredAt,
                })
                .catch(() => undefined);
            }
          }
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

  function recordSuppressedNotificationReceipt(
    input: EnqueueSupervisionSignalInput,
    dispatch: ReturnType<typeof evaluateNotificationDispatch>,
    nowMs: number,
    nowIso: string,
  ): void {
    const dedupeKey = `${dispatch.status}:${input.kind}:${input.taskId ?? ""}:${input.agentId ?? ""}:${input.fingerprintSeed ?? input.title}`;
    const lastRecordedAt = suppressedReceiptFingerprints.get(dedupeKey) ?? 0;
    if (nowMs - lastRecordedAt >= 5 * 60_000) {
      suppressedReceiptFingerprints.set(dedupeKey, nowMs);
      if (suppressedReceiptFingerprints.size > 200) {
        const oldestKey = suppressedReceiptFingerprints.keys().next().value;
        if (oldestKey) suppressedReceiptFingerprints.delete(oldestKey);
      }
      const suppressedReceipt: MainChatNotificationReceipt = {
        id: createNotificationReceiptId(),
        category: dispatch.category,
        signalKind: input.kind,
        tier: dispatch.tier,
        status: dispatch.status,
        channel: dispatch.channel,
        title: input.title,
        summary: input.summary,
        reason: dispatch.reason,
        taskId: input.taskId ?? null,
        agentId: input.agentId ?? null,
        conversationId: input.conversationId ?? null,
        passthrough: false,
        createdAt: nowIso,
        updatedAt: nowIso,
        deliveredAt: null,
        acknowledgedAt: null,
        readAt: null,
      };
      void deps.store.recordNotificationReceipt(suppressedReceipt).catch(() => undefined);
      deps.onBridgeEvent?.({
        kind: "notification_recorded",
        receiptId: suppressedReceipt.id,
        category: suppressedReceipt.category,
        tier: suppressedReceipt.tier,
        status: suppressedReceipt.status,
        title: suppressedReceipt.title,
        summary: suppressedReceipt.summary,
        reason: suppressedReceipt.reason,
        passthrough: false,
        taskId: suppressedReceipt.taskId ?? null,
        agentId: suppressedReceipt.agentId ?? null,
      });
    }
    if (dispatch.status === "suppressed_quiet") {
      void deps.store.incrementSuppressedQuietBadgeCount().catch(() => undefined);
    }
  }

  function recordQueuedNotificationReceipt(
    signalId: string,
    input: EnqueueSupervisionSignalInput,
    dispatch: ReturnType<typeof evaluateNotificationDispatch>,
    nowIso: string,
  ): void {
    const receiptId = createNotificationReceiptId();
    receiptIdBySignalId.set(signalId, receiptId);
    if (dispatch.passthrough) {
      passthroughSignalIds.add(signalId);
    }
    const queuedReceipt: MainChatNotificationReceipt = {
      id: receiptId,
      category: dispatch.category,
      signalKind: input.kind,
      tier: dispatch.tier,
      status: "queued",
      channel: dispatch.channel,
      title: input.title,
      summary: input.summary,
      reason: dispatch.reason,
      taskId: input.taskId ?? null,
      agentId: input.agentId ?? null,
      conversationId: input.conversationId ?? null,
      passthrough: dispatch.passthrough,
      createdAt: nowIso,
      updatedAt: nowIso,
      deliveredAt: null,
      acknowledgedAt: null,
      readAt: null,
    };
    void deps.store.recordNotificationReceipt(queuedReceipt).catch(() => undefined);
    deps.onBridgeEvent?.({
      kind: "notification_recorded",
      receiptId: queuedReceipt.id,
      category: queuedReceipt.category,
      tier: queuedReceipt.tier,
      status: queuedReceipt.status,
      title: queuedReceipt.title,
      summary: queuedReceipt.summary,
      reason: queuedReceipt.reason,
      passthrough: Boolean(queuedReceipt.passthrough),
      taskId: queuedReceipt.taskId ?? null,
      agentId: queuedReceipt.agentId ?? null,
    });
  }

  function enqueueStructuredSignal(
    input: EnqueueSupervisionSignalInput & {
      quiet?: boolean;
      isRedLine?: boolean;
      escalatedToUser?: boolean;
    },
  ): EnqueueSupervisionSignalResult {
    const nowMs = getNowMs();
    const nowIso = new Date(nowMs).toISOString();
    const settings = deps.store.getSettings();
    const dispatch = evaluateNotificationDispatch({
      signalKind: input.kind,
      fingerprintSeed: input.fingerprintSeed,
      isRedLine: input.isRedLine,
      escalatedToUser: input.escalatedToUser,
      isDeliveryGateBlocked: input.kind === "pr_conflict" || input.kind === "draft_pr",
      settings,
      nightModeEval: evaluatePowerState(),
      quietTask: input.quiet,
    });

    if (!dispatch.deliverNow) {
      recordSuppressedNotificationReceipt(input, dispatch, nowMs, nowIso);
      return { queued: false, signal: null };
    }

    const result = signalQueue.enqueue(input);
    if (result.queued && result.signal) {
      recordQueuedNotificationReceipt(result.signal.id, input, dispatch, nowIso);
    }
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

  function appendAssistantTextChunk(agentId: string, text: string, messageId?: string): void {
    if (text.length === 0) return;
    let buffer = assistantTurnBufferByAgent.get(agentId);
    if (!buffer) {
      buffer = { currentMessageId: messageId ?? null, currentMessageText: "", segments: [] };
      assistantTurnBufferByAgent.set(agentId, buffer);
    }
    if (messageId && buffer.currentMessageId && messageId !== buffer.currentMessageId) {
      const prev = buffer.currentMessageText.trim();
      if (prev.length > 0) {
        buffer.segments.push(prev);
      }
      buffer.currentMessageText = "";
      buffer.currentMessageId = messageId;
    } else if (!buffer.currentMessageId && messageId) {
      buffer.currentMessageId = messageId;
    }
    buffer.currentMessageText += text;
    if (buffer.currentMessageText.length > MAX_ASSISTANT_TURN_BUFFER_CHARS) {
      buffer.currentMessageText = buffer.currentMessageText.slice(-MAX_ASSISTANT_TURN_BUFFER_CHARS);
    }
  }

  function sealCurrentAssistantSegment(agentId: string): void {
    const buffer = assistantTurnBufferByAgent.get(agentId);
    if (!buffer) return;
    const trimmed = buffer.currentMessageText.trim();
    if (trimmed.length > 0) {
      buffer.segments.push(trimmed);
      if (buffer.segments.length > 12) {
        buffer.segments = buffer.segments.slice(-12);
      }
    }
    buffer.currentMessageText = "";
    buffer.currentMessageId = null;
  }

  function getAccumulatedAssistantReply(agentId: string): string {
    const buffer = assistantTurnBufferByAgent.get(agentId);
    if (!buffer) return "";
    const parts = [...buffer.segments];
    const tail = buffer.currentMessageText.trim();
    if (tail.length > 0) {
      parts.push(tail);
    }
    const combined = parts.join("\n\n").trim();
    return combined.length > MAX_ASSISTANT_TURN_BUFFER_CHARS
      ? combined.slice(-MAX_ASSISTANT_TURN_BUFFER_CHARS)
      : combined;
  }

  function clearAgentRuntimeState(agentId: string): void {
    clearTimerMapEntry(pendingRetryTimers, agentId);
    clearTimerMapEntry(pendingTriageTimers, agentId);
    transientRetriesByAgent.delete(agentId);
    transientEscalatedAgents.delete(agentId);
    usageLimitRetriedAgents.delete(agentId);
    usageLimitEscalatedAgents.delete(agentId);
    usageLimitWakeAtByAgent.delete(agentId);
    lastActivityAtByAgent.delete(agentId);
    assistantTurnBufferByAgent.delete(agentId);
    stalledNudgedAtByAgent.delete(agentId);
    permissionFirstSeenAt.delete(agentId);
    toolLoopByAgent.delete(agentId);
    if (getZeroTokenRules().clearAgent(agentId)) {
      persistZeroTokenRules();
    }
    approvalTracker.resolveAllForAgent(agentId);
    signalQueue.removeByAgentId(agentId);
    for (const [key, entry] of pendingPermissionRequestsByKey) {
      if (entry.agentId === agentId) {
        pendingPermissionRequestsByKey.delete(key);
        autoApprovedPermissionKeys.delete(key);
      }
    }
  }

  async function clearStaleNeedsYouForAgent(
    agentId: string,
    reason: "turn_started" | "archived",
  ): Promise<void> {
    const nowIso = new Date(getNowMs()).toISOString();
    const linkedTask = deps.store.findTaskByAgentId(agentId);
    const existingTriage = deps.store.getTriage(agentId);
    let mutated = false;

    if (reason === "archived") {
      if (existingTriage) {
        await deps.store.removeTriage(agentId);
        mutated = true;
      }
      await deps.store.removeClarificationsForAgent(agentId);
    } else if (existingTriage && STALE_BLOCKED_PHASES.has(existingTriage.phase)) {
      await deps.store.removeTriage(agentId);
      mutated = true;
    }

    const autoResolved = await deps.store.resolveOpenDecisionsForAgent(agentId, {
      answer:
        reason === "archived" ? AUTO_RESOLVED_ARCHIVED_ANSWER : AUTO_RESOLVED_TURN_STARTED_ANSWER,
      answeredAt: nowIso,
      taskId: linkedTask?.id ?? null,
    });
    if (autoResolved.length > 0) {
      mutated = true;
    }

    if (reason === "turn_started" && linkedTask && linkedTask.status === "needs_you") {
      const live = deps.agentManager.getAgent(agentId);
      if (!live || live.pendingPermissions.size === 0) {
        await deps.store.putTask({
          ...linkedTask,
          status: "running",
          updatedAt: nowIso,
        });
        mutated = true;
      }
    }

    signalQueue.removeByAgentId(agentId);
    if (mutated) {
      deps.contextSnapshots.invalidateCache();
    }
  }

  async function handleAgentArchivedInternal(agentId: string): Promise<void> {
    clearAgentRuntimeState(agentId);
    await clearStaleNeedsYouForAgent(agentId, "archived");
    deps.contextSnapshots.invalidateCache();
  }

  function hasTrackedStaleState(agentId: string): boolean {
    if (deps.store.getTriage(agentId)) return true;
    return deps.store
      .listDecisions()
      .some((decision) => decision.answeredAt === null && decision.agentId === agentId);
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

  function emitPendingPermissionToBridge(input: {
    agentId: string;
    serverId: string | null;
    request: AgentPermissionRequest;
    title: string;
    toolName: string;
    waitLabel: string;
    rawCommand: string | null;
    managed: boolean;
    redLine: { blocked: boolean; reason?: string | null };
    taskId: string | null;
    conversationId: string | null;
  }): void {
    deps.onBridgeEvent?.({
      kind: "permission_requested",
      agentId: input.agentId,
      serverId: input.serverId,
      requestId: input.request.id,
      title: input.title,
      toolName: input.toolName || input.waitLabel,
      command: input.rawCommand,
      description: input.request.description ?? null,
      managed: input.managed,
      isRedLine: input.redLine.blocked,
      redLineReason: input.redLine.reason ?? null,
      taskId: input.taskId,
      conversationId: input.conversationId,
    });
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

    emitPendingPermissionToBridge({
      agentId: agent.id,
      serverId,
      request,
      title,
      toolName,
      waitLabel,
      rawCommand,
      managed,
      redLine,
      taskId,
      conversationId: route.conversationId,
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
    deps.onBridgeEvent?.({
      kind: "permission_resolved",
      agentId,
      requestId,
      behavior,
      source: "paseo",
    });
  }

  function finalizeTurnFailed(agent: ManagedAgent, errorMessage: string): void {
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

  function handleTurnFailed(agent: ManagedAgent, errorMessage: string): void {
    if (isCancelledTurnError(errorMessage)) {
      clearTimerMapEntry(pendingRetryTimers, agent.id);
      return;
    }

    // Only steward-managed subtasks may attempt limitFallbacks; user manual sessions NEVER auto-switch models.
    if (
      deps.onTryLimitFallback &&
      isManagedChildAgent(agent) &&
      isLimitFallbackError(errorMessage)
    ) {
      void deps
        .onTryLimitFallback(agent, errorMessage)
        .then((switched) => {
          if (!switched) {
            finalizeTurnFailed(agent, errorMessage);
          }
          return switched;
        })
        .catch(() => {
          finalizeTurnFailed(agent, errorMessage);
        });
      return;
    }

    finalizeTurnFailed(agent, errorMessage);
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

  async function resolveSemanticTriageProviders(
    live: ManagedAgent,
    settings: ReturnType<MainChatStore["getSettings"]>,
  ): Promise<Array<{ provider: AgentProvider; model?: string; thinkingOptionId?: string }>> {
    const mainAgentId = await resolveMainAgentId();
    const mainSelection = resolveMainSelection(mainAgentId);
    const triageSlot = resolveMainChatModelSlot({
      purpose: "backgroundTriage",
      settings,
      liveMainBinding: mainSelection?.provider
        ? {
            provider: mainSelection.provider,
            model: mainSelection.model ?? null,
            thinkingOptionId: mainSelection.thinkingOptionId ?? null,
          }
        : null,
    });
    if (triageSlot.source === "explicit" && triageSlot.binding) {
      return [
        {
          provider: triageSlot.binding.provider as AgentProvider,
          ...(triageSlot.binding.model ? { model: triageSlot.binding.model } : {}),
          ...(triageSlot.binding.thinkingOptionId
            ? { thinkingOptionId: triageSlot.binding.thinkingOptionId }
            : {}),
        },
      ];
    }
    if (deps.semanticTriageRunner) {
      return [{ provider: live.provider }];
    }
    if (!deps.providerSnapshotManager) return [];
    return resolveMainChatBackgroundProviders({
      backgroundModel: settings.backgroundModel,
      cwd: live.cwd,
      providerSnapshotManager: deps.providerSnapshotManager,
      daemonConfig: deps.readDaemonConfig?.() ?? null,
      mainSelection,
    });
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
      const providers = await resolveSemanticTriageProviders(input.live, input.settings);
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

  function buildNonBlockedPostTriageSignal(
    agentId: string,
    triage: MainChatSessionTriage,
  ): {
    kind: MainChatSupervisionSignal["kind"];
    summary: string;
    fingerprintSeed: string;
  } | null {
    if (triage.phase === "done") {
      const summary =
        triage.ruleDiagnostic?.kind === "missing_wrap_up"
          ? `${triage.summary}（${triage.ruleDiagnostic.summary}）`
          : triage.summary;
      return {
        kind: "review",
        summary,
        fingerprintSeed: `done:${summary}`.slice(0, 80),
      };
    }
    if (triage.phase === "unsure") {
      return {
        kind: "unjudged",
        summary: triage.summary,
        fingerprintSeed: `unjudged:${triage.summary}`.slice(0, 80),
      };
    }
    if (triage.phase === "working" || triage.phase === "blocked_external") {
      const detail = triage.waitReason
        ? `${triage.summary}（等待：${triage.waitReason}）`
        : triage.summary;
      return {
        kind: "idle",
        summary: `子会话已停止但尚未完工：${detail}`,
        fingerprintSeed: `idle:${agentId}:${triage.updatedAt}`,
      };
    }
    return null;
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

    const mapped = buildNonBlockedPostTriageSignal(input.agent.id, triage);
    if (!mapped) return;
    enqueueStructuredSignal({
      kind: mapped.kind,
      urgency: "normal",
      taskId: route.task?.id ?? null,
      agentId: input.agent.id,
      serverId: deps.serverId ?? null,
      conversationId: route.conversationId,
      title: input.title,
      summary: mapped.summary,
      fingerprintSeed: mapped.fingerprintSeed,
      quiet: route.quiet,
    });
  }

  async function applyZeroTokenTurnEvaluation(input: {
    live: ManagedAgent;
    lastReply: string;
    outcome: Awaited<ReturnType<typeof buildTurnTriageOutcome>>;
  }): Promise<void> {
    const rules = getZeroTokenRules();
    const route = resolveTaskRouteForAgent(input.live);
    const zeroTokenEval = rules.evaluateCompletedTurn(input.live.id, {
      replyText: input.lastReply,
      phase: input.outcome.triage.phase,
      task: route.task,
      nowMs: getNowMs(),
    });
    if (zeroTokenEval.changed) {
      persistZeroTokenRules();
    }
    if (!zeroTokenEval.diagnostic) {
      await syncTaskRuleDiagnostic(input.live, null);
      return;
    }
    const diag = zeroTokenEval.diagnostic;
    input.outcome.triage = {
      ...input.outcome.triage,
      ruleDiagnostic: diag,
      ruleDiagnostics: [diag],
      ...(diag.kind === "read_without_reply"
        ? {
            phase: "unsure",
            summary: diag.summary,
            waitReason: diag.detail ?? diag.summary,
            suggestedAction: "查看会话确认是否漏答，或补充明确指示",
            triageSource: "rule" as const,
          }
        : {
            suggestedAction:
              input.outcome.triage.suggestedAction ?? "补齐验证证据与收尾总结后再验收",
          }),
    };
    await syncTaskRuleDiagnostic(input.live, diag);
  }

  async function maybeAutoDelegateAfterTriage(input: {
    live: ManagedAgent;
    title: string;
    managed: boolean;
    outcome: Awaited<ReturnType<typeof buildTurnTriageOutcome>>;
    settings: ReturnType<MainChatStore["getSettings"]>;
  }): Promise<boolean> {
    const { outcome, settings } = input;
    const canAutoDelegate =
      outcome.triage.phase === "blocked_user" &&
      !outcome.riskyAction &&
      outcome.isLowRiskTechQuestion &&
      Boolean(outcome.suggestedReply) &&
      settings.capabilities.autoDelegateManualQuestions;
    if (!canAutoDelegate || !outcome.suggestedReply) return false;
    return tryAutoDelegateLowRiskQuestion({
      agent: input.live,
      title: input.title,
      managed: input.managed,
      triage: outcome.triage,
      suggestedReply: outcome.suggestedReply,
      settings,
    });
  }

  function hasZeroTokenReadWithoutReply(
    agentId: string,
    lastReply: string,
    handoffBlocked: boolean,
  ): boolean {
    if (handoffBlocked) return false;
    const currentWin = getZeroTokenRules().getWindow(agentId);
    return (
      detectReadWithoutReply({
        replyText: lastReply,
        hadReadOrInspectTool: currentWin?.hadReadInTurn ?? false,
        hadWriteTool: currentWin?.hadWriteInTurn ?? false,
        nowIso: new Date(getNowMs()).toISOString(),
      }) !== null
    );
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
    const handoffBlocked = isHandoffBlockedAgent(live);
    const lastReply =
      getAccumulatedAssistantReply(agentId) ||
      extractLastAssistantTextFromTimeline(deps.agentManager.getTimeline(agentId));

    if (lastReply && deps.onTaskReplyPrDiscovered) {
      await Promise.resolve(deps.onTaskReplyPrDiscovered(agentId, lastReply)).catch((error) => {
        deps.logger.warn({ err: error, agentId }, "Task reply PR discovery hook failed");
      });
    }

    const skipSemantic = hasZeroTokenReadWithoutReply(agentId, lastReply, handoffBlocked);
    const semanticResult = skipSemantic
      ? null
      : await runOptionalSemanticTriage({ live, title, projectName, lastReply, settings });
    const outcome = await buildTurnTriageOutcome({
      live,
      title,
      managed,
      lastReply,
      semanticResult,
    });

    if (!handoffBlocked) {
      await applyZeroTokenTurnEvaluation({ live, lastReply, outcome });
    }
    if (await maybeAutoDelegateAfterTriage({ live, title, managed, outcome, settings })) {
      return;
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
        if (agent.pendingPermissions.size === 0 && hasTrackedStaleState(agent.id)) {
          void clearStaleNeedsYouForAgent(agent.id, "turn_started").catch(() => undefined);
        }
      }
    } else if (isObservedFleetAgent(agent) && hasTrackedStaleState(agent.id)) {
      // AgentManager emits `agent_state` without an explicit `archivedAt` field on ManagedAgent;
      // check storage when a tracked agent leaves running so archived sessions clear immediately.
      void deps.agentStorage
        .get(agent.id)
        .then((stored) => {
          if (stored?.archivedAt) {
            return handleAgentArchivedInternal(agent.id);
          }
          return undefined;
        })
        .catch(() => undefined);
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

  function handleMainChatStreamEvent(
    agent: ManagedAgent,
    streamEvent: Extract<AgentManagerEvent, { type: "agent_stream" }>["event"],
  ): void {
    if (streamEvent.type === "turn_completed") {
      deps.onAgentTurnCompleted?.(agent);
      return;
    }
    if (
      streamEvent.type === "turn_failed" &&
      deps.onTryLimitFallback &&
      isLimitFallbackError(streamEvent.error)
    ) {
      void deps.onTryLimitFallback(agent, streamEvent.error).catch(() => undefined);
    }
  }

  function handleObservedAgentToolCall(
    agent: ManagedAgent,
    item: Extract<AgentTimelineItem, { type: "tool_call" }>,
    now: number,
  ): void {
    sealCurrentAssistantSegment(agent.id);
    recordToolCallForLoopDetection(agent.id, item.name, extractToolDetailText(item.detail), now);
    if (isHandoffBlockedAgent(agent)) return;
    const loopResult = getZeroTokenRules().recordToolEvent(agent.id, {
      callId: item.callId,
      toolName: item.name,
      detail: item.detail,
      status: item.status,
      error: item.error,
      nowMs: now,
    });
    if (loopResult.changed) {
      persistZeroTokenRules();
    }
    if (!loopResult.diagnostic || !loopResult.isNewTrigger) return;
    const diag = loopResult.diagnostic;
    const title = agent.config.title?.trim() || basenameOf(agent.cwd);
    const managed = isManagedChildAgent(agent);
    const route = resolveTaskRouteForAgent(agent);
    const triage: MainChatSessionTriage = {
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      title,
      managedByMainChat: managed,
      phase: "no_progress",
      summary: diag.summary,
      waitReason: diag.detail ?? diag.summary,
      suggestedAction: managed
        ? "检查工具循环原因，必要时介入修正或切换模型续跑"
        : "保守模式已仅上报诊断，请查看会话并决定是否介入",
      triageSource: "rule",
      updatedAt: diag.detectedAt,
      ruleDiagnostic: diag,
      ruleDiagnostics: [diag],
    };
    void deps.store.putTriage(triage).catch(() => undefined);
    void syncTaskRuleDiagnostic(agent, diag).catch(() => undefined);
    // Strictly obey Conservative Mode A: NEVER send unsolicited business commands to
    // manual user sessions. Emit structured `no_progress` supervision signal instead.
    enqueueStructuredSignal({
      kind: "no_progress",
      urgency: "urgent",
      taskId: route.task?.id ?? null,
      agentId: agent.id,
      serverId: deps.serverId ?? null,
      conversationId: route.conversationId,
      title,
      summary: diag.detail ? `${diag.summary}（${diag.detail}）` : diag.summary,
      fingerprintSeed: `tool_loop:${agent.id}:${diag.pattern ?? "repeat"}:${diag.toolName ?? ""}`,
      quiet: route.quiet,
    });
  }

  function handleObservedAgentTurnStarted(agent: ManagedAgent, now: number): void {
    clearTimerMapEntry(pendingTriageTimers, agent.id);
    permissionFirstSeenAt.delete(agent.id);
    assistantTurnBufferByAgent.delete(agent.id);
    if (!isHandoffBlockedAgent(agent)) {
      getZeroTokenRules().recordTurnStarted(agent.id, now);
      persistZeroTokenRules();
    }
    void clearStaleNeedsYouForAgent(agent.id, "turn_started").catch(() => undefined);
  }

  function handleManagerEvent(event: AgentManagerEvent): void {
    deps.turnQueue.handleEvent(event);
    deps.onAgentEvent?.(event);
    const settings = deps.store.getSettings();
    if (!isMainChatEnabled(settings)) {
      return;
    }
    if (event.type === "agent_removed") {
      void handleAgentArchivedInternal(event.agentId).catch(() => undefined);
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
    if (agent && isMainChatLabels(agent.labels) && !agent.background && !agent.internal) {
      handleMainChatStreamEvent(agent, event.event);
      return;
    }
    if (!isObservedFleetAgent(agent)) return;
    lastFleetOrUserActivityAtMs = Math.max(lastFleetOrUserActivityAtMs, now);

    if (event.event.type === "turn_started") {
      handleObservedAgentTurnStarted(agent, now);
      return;
    }

    if (event.event.type === "timeline") {
      const item = event.event.item;
      if (item.type === "assistant_message") {
        appendAssistantTextChunk(event.agentId, item.text, item.messageId);
      } else if (item.type === "tool_call") {
        handleObservedAgentToolCall(agent, item, now);
      }
      return;
    }

    if (event.event.type === "turn_completed") {
      deps.onAgentTurnCompleted?.(agent);
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

  function resolveActiveLeaderConversationId(task: MainChatTaskRecord): string | null {
    return task.conversationId && deps.isLeaderConversationActive?.(task.conversationId)
      ? task.conversationId
      : null;
  }

  function buildTimedOutTaskSummary(
    task: MainChatTaskRecord,
    now: number,
    multiplier: number,
    minTimeoutMs: number,
  ): string | null {
    if (task.status !== "running" || !task.activeAgentId) return null;
    if (task.serverId && task.serverId !== deps.serverId) return null;
    const live = deps.agentManager.getAgent(task.activeAgentId);
    if (!live || live.lifecycle !== "running") return null;

    const hasExpected = typeof task.expectedMinutes === "number" && task.expectedMinutes > 0;
    const thresholdMs = hasExpected ? task.expectedMinutes! * 60_000 * multiplier : minTimeoutMs;
    const startedMs = Date.parse(task.createdAt);
    if (!Number.isFinite(startedMs) || now - startedMs < thresholdMs) return null;

    const elapsedMin = Math.max(1, Math.round((now - startedMs) / 60_000));
    return hasExpected
      ? `任务已持续运行 ${elapsedMin} 分钟，超过预期 ${task.expectedMinutes} 分钟的 ${multiplier} 倍超时阈值`
      : `任务已持续运行 ${elapsedMin} 分钟，超过默认超时阈值（${Math.round(minTimeoutMs / 60_000)} 分钟）`;
  }

  function inspectTimedOutTasks(now: number, stalledThresholdMs: number): number {
    const multiplier = deps.timedOutMultiplier ?? 2;
    const minTimeoutMs = Math.max(60_000, stalledThresholdMs * 2);
    let added = 0;

    for (const task of deps.store.listTasks({ includeCompleted: false })) {
      const timeoutDetail = buildTimedOutTaskSummary(task, now, multiplier, minTimeoutMs);
      if (!timeoutDetail || !task.activeAgentId) continue;
      const res = enqueueStructuredSignal({
        kind: "timed_out",
        urgency: "urgent",
        taskId: task.id,
        agentId: task.activeAgentId,
        serverId: task.serverId ?? deps.serverId ?? null,
        conversationId: resolveActiveLeaderConversationId(task),
        title: task.title,
        summary: timeoutDetail,
        fingerprintSeed: `timed_out:${task.id}:${task.activeAgentId}`,
        quiet: task.quiet !== false,
      });
      if (res.queued) added += 1;
    }
    return added;
  }

  async function detectOrphanReasonForTask(task: MainChatTaskRecord): Promise<string | null> {
    if (task.status === "parked" || task.status === "completed" || task.status === "cancelled") {
      return null;
    }
    if (!task.activeAgentId || pendingRetryTimers.has(task.activeAgentId)) {
      return null;
    }
    if (task.serverId && task.serverId !== deps.serverId) {
      if (deps.isRemoteHostOffline?.(task.serverId)) {
        return `关联远端主机 ${task.hostLabel ?? task.serverId} 已离线，子会话无法自动恢复`;
      }
      if (deps.getRemoteAgent && !deps.getRemoteAgent(task.serverId, task.activeAgentId)) {
        return `远端关联会话 ${task.activeAgentId} 已退出或失联`;
      }
      return null;
    }
    if (deps.agentManager.getAgent(task.activeAgentId)) {
      return null;
    }
    const stored = await deps.agentStorage.get(task.activeAgentId).catch(() => null);
    if (
      !stored ||
      stored.archivedAt ||
      stored.lastStatus === "closed" ||
      stored.lastStatus === "error"
    ) {
      return stored?.archivedAt
        ? `关联子会话 ${task.activeAgentId} 已归档，任务尚未结项`
        : `关联子会话 ${task.activeAgentId} 已离线或不再活跃`;
    }
    return null;
  }

  async function inspectOrphanedTasks(): Promise<number> {
    let added = 0;
    for (const task of deps.store.listTasks({ includeCompleted: false })) {
      const orphanReason = await detectOrphanReasonForTask(task);
      if (!orphanReason || !task.activeAgentId) continue;
      const res = enqueueStructuredSignal({
        kind: "orphaned",
        urgency: "urgent",
        taskId: task.id,
        agentId: task.activeAgentId,
        serverId: task.serverId ?? deps.serverId ?? null,
        conversationId: resolveActiveLeaderConversationId(task),
        title: task.title,
        summary: orphanReason,
        fingerprintSeed: `orphaned:${task.id}:${task.activeAgentId}:${orphanReason.slice(0, 32)}`,
        quiet: task.quiet !== false,
      });
      if (res.queued) added += 1;
    }
    return added;
  }

  function inspectOpenDecisions(now: number, needsYouEscalateMs: number): number {
    let added = 0;
    for (const decision of deps.store.listDecisions()) {
      if (decision.answeredAt !== null) continue;
      const createdMs = Date.parse(decision.createdAt);
      if (Number.isFinite(createdMs) && now - createdMs < needsYouEscalateMs) continue;
      const waitedMin = Number.isFinite(createdMs)
        ? Math.max(1, Math.round((now - createdMs) / 60_000))
        : 0;
      const res = enqueueStructuredSignal({
        kind: "decide",
        urgency: "urgent",
        taskId: decision.taskId,
        agentId: decision.agentId,
        serverId: deps.serverId ?? null,
        conversationId: null,
        title: decision.title,
        summary: `待拍板决策卡已等待 ${waitedMin} 分钟：${decision.question}`,
        fingerprintSeed: `decide:${decision.id}`,
        quiet: false,
        escalatedToUser: true,
      });
      if (res.queued) added += 1;
    }
    return added;
  }

  function evaluateScheduledCheckCandidate(
    task: MainChatTaskRecord,
    now: number,
    checkIntervalMs: number,
  ): { summary: string; windowBucket: number } | null {
    if (task.status !== "parked" && task.status !== "open") return null;
    if (task.status === "open" && task.dependencyState === "blocked") return null;

    const anchorIso = task.parkedAt ?? task.lastActivityAt ?? task.updatedAt;
    const anchorMs = Date.parse(anchorIso);
    if (!Number.isFinite(anchorMs) || now - anchorMs < checkIntervalMs) return null;

    const windowBucket = Math.floor((now - anchorMs) / checkIntervalMs);
    const elapsedMin = Math.max(1, Math.round((now - anchorMs) / 60_000));
    const summary =
      task.status === "parked"
        ? `挂起任务已满 ${elapsedMin} 分钟（原因：${task.parkedReason ?? "外部等待"}），执行周期检查`
        : `未启动任务已静默 ${elapsedMin} 分钟，请复核是否继续推进或撤回`;
    return { summary, windowBucket };
  }

  function inspectScheduledCheckTasks(now: number): number {
    const checkIntervalMs = deps.periodicCheckIntervalMs ?? 60 * 60 * 1000;
    if (checkIntervalMs <= 0) return 0;
    let added = 0;

    for (const task of deps.store.listTasks({ includeCompleted: false })) {
      const candidate = evaluateScheduledCheckCandidate(task, now, checkIntervalMs);
      if (!candidate) continue;
      const res = enqueueStructuredSignal({
        kind: "check",
        urgency: "normal",
        taskId: task.id,
        agentId: task.activeAgentId,
        serverId: task.serverId ?? deps.serverId ?? null,
        conversationId: resolveActiveLeaderConversationId(task),
        title: task.title,
        summary: candidate.summary,
        fingerprintSeed: `check:${task.id}:${candidate.windowBucket}`,
        quiet: task.quiet !== false,
      });
      if (res.queued) added += 1;
    }
    return added;
  }

  function detectStuckLeaderReason(
    leader: {
      id: string;
      agentId: string;
      lastMessageAt?: string | null;
      updatedAt: string;
    },
    liveLeader: ManagedAgent | null | undefined,
    leaderTaskCount: number,
    pendingForLeader: number,
    now: number,
    thresholdMs: number,
  ): string | null {
    if (liveLeader?.lifecycle === "error") {
      return `方向主管会话处于异常状态（${liveLeader.lastError?.slice(0, 80) ?? "运行出错"}）`;
    }
    if (leaderTaskCount === 0 && pendingForLeader === 0) {
      return null;
    }
    const lastActiveMs =
      lastActivityAtByAgent.get(leader.agentId) ??
      liveLeader?.updatedAt.getTime() ??
      Date.parse(leader.lastMessageAt ?? leader.updatedAt);
    if (!Number.isFinite(lastActiveMs) || now - lastActiveMs < thresholdMs) {
      return null;
    }
    const idleMin = Math.max(1, Math.round((now - lastActiveMs) / 60_000));
    return `方向主管已 ${idleMin} 分钟无新动态，名下仍有 ${leaderTaskCount} 个未结任务与 ${pendingForLeader} 条待处理督办信号`;
  }

  async function inspectStuckLeaders(now: number, stalledThresholdMs: number): Promise<number> {
    const leaders = (await deps.listLeaderConversations?.()) ?? [];
    if (leaders.length === 0) return 0;
    const thresholdMs = deps.leaderStuckThresholdMs ?? stalledThresholdMs;
    const openTasks = deps.store.listTasks({ includeCompleted: false });
    const dayBucket = new Date(now).toISOString().slice(0, 10);
    let added = 0;

    for (const leader of leaders) {
      if (leader.kind !== "leader" || leader.archivedAt) continue;
      const liveLeader = deps.agentManager.getAgent(leader.agentId);
      const leaderTasks = openTasks.filter((task) => task.conversationId === leader.id);
      const pendingForLeader = signalQueue.getPendingCount(leader.id);
      const stuckReason = detectStuckLeaderReason(
        leader,
        liveLeader,
        leaderTasks.length,
        pendingForLeader,
        now,
        thresholdMs,
      );
      if (!stuckReason) continue;

      const res = enqueueStructuredSignal({
        kind: "leader_stuck",
        urgency: "urgent",
        taskId: leaderTasks[0]?.id ?? null,
        agentId: leader.agentId,
        serverId: leader.serverId ?? deps.serverId ?? null,
        conversationId: null, // Always escalate leader_stuck to Main chat
        title: `方向「${leader.title}」`,
        summary: stuckReason,
        fingerprintSeed: `leader_stuck:${leader.id}:${dayBucket}`,
        quiet: false,
        escalatedToUser: true,
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

  function remoteAgentCompositeKey(serverId: string, agentId: string): string {
    return `${serverId}:${agentId}`;
  }

  function remotePermissionCompositeKey(
    serverId: string,
    agentId: string,
    requestId: string,
  ): string {
    return `remote:${serverId}:${agentId}:${requestId}`;
  }

  function isRemoteHostInScope(serverId: string): boolean {
    if (!serverId || serverId === deps.serverId) return false;
    return !deps.isHostAllowed || deps.isHostAllowed(serverId);
  }

  function formatRemoteAgentDisplayTitle(
    hostLabel: string,
    serverId: string,
    remoteAgent: AggregatedHostAgent | null,
    agentId: string,
  ): string {
    const hostTag = hostLabel.trim() || serverId;
    const rawTitle =
      remoteAgent?.title.trim() || (remoteAgent?.cwd ? basenameOf(remoteAgent.cwd) : agentId);
    return `[${hostTag}] ${rawTitle}`;
  }

  function resolveRemoteRoute(
    agentId: string,
    remoteAgent: AggregatedHostAgent | null,
  ): {
    managed: boolean;
    task: MainChatTaskRecord | null;
    conversationId: string | null;
    quiet: boolean;
  } {
    const task = deps.store.findTaskByAgentId(agentId);
    const parentId = remoteAgent ? getParentAgentIdFromLabels(remoteAgent.labels) : null;
    const taskMeta = remoteAgent ? getMainChatTaskMetaFromLabels(remoteAgent.labels) : null;
    const managed = Boolean(task || (parentId && taskMeta?.planId) || taskMeta?.taskId);
    const quiet = task
      ? task.quiet !== false
      : managed && remoteAgent?.labels[MAIN_CHAT_TASK_QUIET_LABEL] !== "false";
    return {
      managed,
      task,
      conversationId: task?.conversationId ?? null,
      quiet,
    };
  }

  function tryAutoApproveRemotePermission(params: {
    event: FleetBridgePermissionRequestedEvent;
    remoteAgent: AggregatedHostAgent | null;
    request: AgentPermissionRequest;
    route: ReturnType<typeof resolveRemoteRoute>;
    toolName: string;
    redLineBlocked: boolean;
    agentKey: string;
    permKey: string;
    nowMs: number;
  }): boolean {
    const {
      event,
      remoteAgent,
      request,
      route,
      toolName,
      redLineBlocked,
      agentKey,
      permKey,
      nowMs,
    } = params;
    if (!route.managed || redLineBlocked || !deps.respondRemotePermission || !remoteAgent) {
      return false;
    }
    const match = matchStandingAuthorization(
      {
        scope: "permission",
        serverId: event.serverId,
        localServerId: deps.serverId ?? null,
        cwd: remoteAgent.cwd,
        toolName,
        command: null,
        kind: request.kind,
        question: event.permission.description ?? null,
      },
      deps.store.listStandingAuthorizations({ includeRevoked: false }),
      nowMs,
    );
    if (!match.matched || !match.authorization) {
      return false;
    }
    const matchedAuth = match.authorization;
    autoApprovedPermissionKeys.add(permKey);
    void deps
      .respondRemotePermission(event.serverId, event.agentId, event.permission.requestId, {
        behavior: "allow",
      })
      .then(async () => {
        permissionFirstSeenAt.delete(agentKey);
        await deps.store.recordStandingAuthorizationMatch(
          matchedAuth.id,
          new Date(getNowMs()).toISOString(),
        );
        await deps.store.incrementMetric("supervisorHeld");
        if (route.quiet) {
          await deps.store.incrementSuppressedQuietBadgeCount();
        }
        return undefined;
      })
      .catch((error) => {
        autoApprovedPermissionKeys.delete(permKey);
        deps.logger.warn(
          { err: error, serverId: event.serverId, agentId: event.agentId },
          "Remote permission auto-approval failed; leaving request for user",
        );
      });
    return true;
  }

  function trackAndSignalRemotePermission(params: {
    event: FleetBridgePermissionRequestedEvent;
    remoteAgent: AggregatedHostAgent | null;
    request: AgentPermissionRequest;
    route: ReturnType<typeof resolveRemoteRoute>;
    title: string;
    redLine: ReturnType<typeof checkRedLineGuard>;
    nowMs: number;
  }): void {
    const { event, remoteAgent, request, route, title, redLine, nowMs } = params;
    const waitLabel =
      event.permission.title?.trim() || event.permission.name.trim() || "待审批请求";
    const initialTier = resolveInitialApprovalTier(
      route.managed,
      redLine.blocked,
      route.conversationId,
    );

    approvalTracker.track({
      agentId: event.agentId,
      serverId: event.serverId,
      requestId: event.permission.requestId,
      taskId: route.task?.id ?? null,
      conversationId: route.conversationId,
      category: resolveApprovalCategory(request.kind),
      label: waitLabel,
      initialTier,
      nowMs,
    });

    void deps.store
      .putTriage({
        agentId: event.agentId,
        workspaceId: remoteAgent?.workspaceId ?? null,
        title,
        managedByMainChat: route.managed,
        phase: "blocked_user",
        summary: redLine.blocked ? `等待红线审批：${waitLabel}` : `等待审批：${waitLabel}`,
        waitReason: redLine.reason ?? waitLabel,
        suggestedAction: "点击批准或打开远端会话处理",
        triageSource: "rule",
        updatedAt: new Date(nowMs).toISOString(),
      })
      .catch(() => undefined);
    void deps.store.incrementMetric("triageRuleCount").catch(() => undefined);

    if (route.quiet && !redLine.blocked && initialTier !== "user") {
      enqueueStructuredSignal({
        kind: "ask",
        urgency: "urgent",
        taskId: route.task?.id ?? null,
        agentId: event.agentId,
        serverId: event.serverId,
        conversationId: route.conversationId,
        title,
        summary: `拦截待处理审批：${waitLabel}（已启动 5m 空闲升级 / 15m 硬截止时钟）`,
        fingerprintSeed: `remote-ask:${event.serverId}:${event.permission.requestId}`,
        quiet: true,
      });
      return;
    }

    if (route.managed || redLine.blocked) {
      void deps.store.incrementMetric("interrupts").catch(() => undefined);
    }
    if (redLine.blocked) {
      enqueueStructuredSignal({
        kind: "needs_you",
        urgency: "urgent",
        taskId: route.task?.id ?? null,
        agentId: event.agentId,
        serverId: event.serverId,
        conversationId: null,
        title,
        summary: `高风险红线审批需你确认（${waitLabel}）：${redLine.reason}`,
        fingerprintSeed: `remote-redline:${event.serverId}:${event.permission.requestId}`,
        quiet: route.quiet,
        isRedLine: true,
        escalatedToUser: true,
      });
    }
  }

  function handleRemotePermissionRequested(event: FleetBridgePermissionRequestedEvent): void {
    if (event.isLocal || !isRemoteHostInScope(event.serverId)) return;
    if (!isMainChatEnabled(deps.store.getSettings())) return;

    const nowMs = getNowMs();
    lastFleetOrUserActivityAtMs = nowMs;
    const agentKey = remoteAgentCompositeKey(event.serverId, event.agentId);
    if (!permissionFirstSeenAt.has(agentKey)) {
      permissionFirstSeenAt.set(agentKey, nowMs);
    }

    const permKey = remotePermissionCompositeKey(
      event.serverId,
      event.agentId,
      event.permission.requestId,
    );
    if (pendingPermissionRequestsByKey.has(permKey)) {
      return;
    }

    const remoteAgent = deps.getRemoteAgent?.(event.serverId, event.agentId) ?? null;
    const request: AgentPermissionRequest = {
      id: event.permission.requestId,
      provider: "claude",
      name: event.permission.name,
      kind: event.permission.kind ?? "tool",
      title: event.permission.title ?? undefined,
      description: event.permission.description ?? undefined,
    };
    pendingPermissionRequestsByKey.set(permKey, {
      agentId: event.agentId,
      cwd: remoteAgent?.cwd ?? "",
      serverId: event.serverId,
      request,
    });

    const title = formatRemoteAgentDisplayTitle(
      event.hostLabel,
      event.serverId,
      remoteAgent,
      event.agentId,
    );
    const route = resolveRemoteRoute(event.agentId, remoteAgent);
    const toolName = event.permission.name || event.permission.title || "";
    const redLine = checkRedLineGuard({
      kind: request.kind,
      toolName,
      command: null,
      question: event.permission.description ?? null,
    });

    if (
      tryAutoApproveRemotePermission({
        event,
        remoteAgent,
        request,
        route,
        toolName,
        redLineBlocked: redLine.blocked,
        agentKey,
        permKey,
        nowMs,
      })
    ) {
      return;
    }

    trackAndSignalRemotePermission({
      event,
      remoteAgent,
      request,
      route,
      title,
      redLine,
      nowMs,
    });
  }

  function handleRemotePermissionResolved(event: FleetBridgePermissionResolvedEvent): void {
    const permKey = remotePermissionCompositeKey(event.serverId, event.agentId, event.requestId);
    approvalTracker.resolve(event.agentId, event.requestId);
    void deps.store
      .removeClarificationsForPermission(event.agentId, event.requestId)
      .catch(() => undefined);
    pendingPermissionRequestsByKey.delete(permKey);
    autoApprovedPermissionKeys.delete(permKey);

    const hasRemainingForAgent = Array.from(pendingPermissionRequestsByKey.values()).some(
      (meta) => meta.serverId === event.serverId && meta.agentId === event.agentId,
    );
    if (!hasRemainingForAgent) {
      permissionFirstSeenAt.delete(remoteAgentCompositeKey(event.serverId, event.agentId));
    }
  }

  function inspectRemoteAgentError(remoteAgent: AggregatedHostAgent, now: number): number {
    const agentKey = remoteAgentCompositeKey(remoteAgent.serverId, remoteAgent.agentId);
    const rawError = remoteAgent.lastError?.trim() || null;
    const isErrored = remoteAgent.lifecycle === "error" || Boolean(rawError);
    if (!isErrored) {
      remoteErrorSigByAgentKey.delete(agentKey);
      return 0;
    }

    const errorMessage = rawError ?? "远端会话异常中断";
    if (isCancelledTurnError(errorMessage)) {
      remoteErrorSigByAgentKey.delete(agentKey);
      return 0;
    }

    if (remoteErrorSigByAgentKey.get(agentKey) === errorMessage) {
      return 0;
    }
    remoteErrorSigByAgentKey.set(agentKey, errorMessage);

    const route = resolveRemoteRoute(remoteAgent.agentId, remoteAgent);
    const title = formatRemoteAgentDisplayTitle(
      remoteAgent.hostLabel,
      remoteAgent.serverId,
      remoteAgent,
      remoteAgent.agentId,
    );
    const errorClass = classifyMainChatTurnError(errorMessage);
    if (route.managed && (!route.quiet || errorClass === "user")) {
      void deps.store.incrementMetric("interrupts").catch(() => undefined);
    }
    void deps.store.incrementMetric("triageRuleCount").catch(() => undefined);

    const triage: MainChatSessionTriage = {
      agentId: remoteAgent.agentId,
      workspaceId: remoteAgent.workspaceId ?? null,
      title,
      managedByMainChat: route.managed,
      phase: errorClass === "user" ? "blocked_user" : "interrupted",
      summary: `远端异常中断：${errorMessage.slice(0, 90)}`,
      waitReason: errorMessage.slice(0, 140),
      suggestedAction: "打开远端会话处理错误或重试",
      triageSource: "rule",
      updatedAt: new Date(now).toISOString(),
    };
    void deps.store.putTriage(triage).catch(() => undefined);

    const res = enqueueStructuredSignal({
      kind: errorClass === "user" ? "needs_you" : "interrupted",
      urgency: "urgent",
      taskId: route.task?.id ?? null,
      agentId: remoteAgent.agentId,
      serverId: remoteAgent.serverId,
      conversationId: errorClass === "user" ? null : route.conversationId,
      title,
      summary: triage.summary,
      fingerprintSeed: `remote-error:${remoteAgent.serverId}:${errorMessage.slice(0, 80)}`,
      quiet: route.quiet,
    });
    return res.queued ? 1 : 0;
  }

  function handleRemoteAgentsChanged(event: FleetBridgeAgentsChangedEvent): void {
    if (!isRemoteHostInScope(event.serverId)) return;
    if (!isMainChatEnabled(deps.store.getSettings())) return;

    const now = getNowMs();
    lastFleetOrUserActivityAtMs = now;
    const candidates =
      event.agentIds && event.agentIds.length > 0
        ? event.agentIds
            .map((agentId) => deps.getRemoteAgent?.(event.serverId, agentId) ?? null)
            .filter((agent): agent is AggregatedHostAgent => agent !== null)
        : (deps.listRemoteAgents?.() ?? []).filter((agent) => agent.serverId === event.serverId);

    for (const remoteAgent of candidates) {
      inspectRemoteAgentError(remoteAgent, now);
      if (remoteAgent.lifecycle !== "running") {
        remoteStalledNotifiedAtByKey.delete(
          remoteAgentCompositeKey(remoteAgent.serverId, remoteAgent.agentId),
        );
      }
    }
  }

  function inspectRemoteAgentPendingPermission(
    remoteAgent: AggregatedHostAgent,
    route: ReturnType<typeof resolveRemoteRoute>,
    title: string,
    agentKey: string,
    now: number,
    needsYouEscalateMs: number,
  ): number {
    const firstSeen = permissionFirstSeenAt.get(agentKey) ?? now;
    permissionFirstSeenAt.set(agentKey, firstSeen);
    const firstPerm = remoteAgent.pendingPermissions[0];
    const waitLabel = firstPerm?.title?.trim() || firstPerm?.name.trim() || "待审批请求";
    if (now - firstSeen < needsYouEscalateMs) {
      return 0;
    }
    const waitedMin = Math.max(1, Math.round((now - firstSeen) / 60_000));
    const res = enqueueStructuredSignal({
      kind: "needs_you",
      urgency: "urgent",
      taskId: route.task?.id ?? null,
      agentId: remoteAgent.agentId,
      serverId: remoteAgent.serverId,
      conversationId: null,
      title,
      summary: `等待审批已超 ${waitedMin} 分钟：${waitLabel}`,
      fingerprintSeed: `remote-perm:${remoteAgent.serverId}:${firstPerm?.requestId ?? waitLabel}`,
      quiet: route.quiet,
      escalatedToUser: true,
    });
    return res.queued ? 1 : 0;
  }

  function inspectRemoteAgentStalled(
    remoteAgent: AggregatedHostAgent,
    route: ReturnType<typeof resolveRemoteRoute>,
    title: string,
    agentKey: string,
    now: number,
    stalledThresholdMs: number,
  ): number {
    if (remoteAgent.lifecycle !== "running") {
      remoteStalledNotifiedAtByKey.delete(agentKey);
      return 0;
    }
    const updatedAtMs = Date.parse(remoteAgent.updatedAtIso);
    if (
      !Number.isFinite(updatedAtMs) ||
      now - updatedAtMs < stalledThresholdMs ||
      remoteStalledNotifiedAtByKey.has(agentKey)
    ) {
      return 0;
    }
    remoteStalledNotifiedAtByKey.set(agentKey, now);
    const idleMin = Math.max(1, Math.round((now - updatedAtMs) / 60_000));
    const triage: MainChatSessionTriage = {
      agentId: remoteAgent.agentId,
      workspaceId: remoteAgent.workspaceId ?? null,
      title,
      managedByMainChat: route.managed,
      phase: "stalled",
      summary: `远端已静默运行 ${idleMin} 分钟无新动态`,
      waitReason: "长时间无新输出或状态变化",
      suggestedAction: "打开远端会话检查进程状态或提醒汇报",
      triageSource: "rule",
      updatedAt: new Date(now).toISOString(),
    };
    void deps.store.putTriage(triage).catch(() => undefined);
    const res = enqueueStructuredSignal({
      kind: "stalled",
      urgency: "normal",
      taskId: route.task?.id ?? null,
      agentId: remoteAgent.agentId,
      serverId: remoteAgent.serverId,
      conversationId: route.conversationId,
      title,
      summary: triage.summary,
      fingerprintSeed: `remote-stalled:${remoteAgent.serverId}:${remoteAgent.updatedAtIso}`,
      quiet: route.quiet,
    });
    return res.queued ? 1 : 0;
  }

  function inspectSingleRemoteFleetAgent(
    remoteAgent: AggregatedHostAgent,
    now: number,
    needsYouEscalateMs: number,
    stalledThresholdMs: number,
  ): number {
    const agentKey = remoteAgentCompositeKey(remoteAgent.serverId, remoteAgent.agentId);
    const route = resolveRemoteRoute(remoteAgent.agentId, remoteAgent);
    const title = formatRemoteAgentDisplayTitle(
      remoteAgent.hostLabel,
      remoteAgent.serverId,
      remoteAgent,
      remoteAgent.agentId,
    );

    if (remoteAgent.pendingPermissions.length > 0) {
      return inspectRemoteAgentPendingPermission(
        remoteAgent,
        route,
        title,
        agentKey,
        now,
        needsYouEscalateMs,
      );
    }

    const errorSignals = inspectRemoteAgentError(remoteAgent, now);
    const stalledSignals = inspectRemoteAgentStalled(
      remoteAgent,
      route,
      title,
      agentKey,
      now,
      stalledThresholdMs,
    );
    return errorSignals + stalledSignals;
  }

  function inspectRemoteFleetAgents(
    now: number,
    needsYouEscalateMs: number,
    stalledThresholdMs: number,
  ): { scannedRemote: number; signalsAdded: number } {
    const remoteAgents = (deps.listRemoteAgents?.() ?? []).filter((agent) =>
      isRemoteHostInScope(agent.serverId),
    );
    let signalsAdded = 0;

    for (const remoteAgent of remoteAgents) {
      signalsAdded += inspectSingleRemoteFleetAgent(
        remoteAgent,
        now,
        needsYouEscalateMs,
        stalledThresholdMs,
      );
    }

    return { scannedRemote: remoteAgents.length, signalsAdded };
  }

  function reconcileRemoteHostScope(): void {
    for (const entry of approvalTracker.list()) {
      if (
        entry.serverId &&
        entry.serverId !== deps.serverId &&
        !isRemoteHostInScope(entry.serverId)
      ) {
        approvalTracker.resolve(entry.agentId, entry.requestId);
      }
    }
    for (const [key, meta] of Array.from(pendingPermissionRequestsByKey.entries())) {
      if (meta.serverId && meta.serverId !== deps.serverId && !isRemoteHostInScope(meta.serverId)) {
        pendingPermissionRequestsByKey.delete(key);
        autoApprovedPermissionKeys.delete(key);
      }
    }
    for (const key of Array.from(permissionFirstSeenAt.keys())) {
      const sep = key.indexOf(":");
      if (sep > 0) {
        const hostId = key.slice(0, sep);
        if (!isRemoteHostInScope(hostId)) {
          permissionFirstSeenAt.delete(key);
        }
      }
    }
    for (const key of Array.from(remoteErrorSigByAgentKey.keys())) {
      const sep = key.indexOf(":");
      if (sep > 0 && !isRemoteHostInScope(key.slice(0, sep))) {
        remoteErrorSigByAgentKey.delete(key);
      }
    }
    for (const key of Array.from(remoteStalledNotifiedAtByKey.keys())) {
      const sep = key.indexOf(":");
      if (sep > 0 && !isRemoteHostInScope(key.slice(0, sep))) {
        remoteStalledNotifiedAtByKey.delete(key);
      }
    }
  }

  async function reconcileArchivedStaleState(): Promise<void> {
    const candidateAgentIds = new Set<string>();
    for (const triage of deps.store.listTriages()) {
      candidateAgentIds.add(triage.agentId);
    }
    for (const decision of deps.store.listDecisions()) {
      if (decision.answeredAt === null && decision.agentId) {
        candidateAgentIds.add(decision.agentId);
      }
    }
    for (const agentId of candidateAgentIds) {
      const stored = await deps.agentStorage.get(agentId).catch(() => null);
      if (stored?.archivedAt) {
        await handleAgentArchivedInternal(agentId);
      }
    }
  }

  async function scanFleetAndBuildSignals(): Promise<{
    scannedSessions: number;
    signalsFound: number;
  }> {
    await reconcileArchivedStaleState();
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
    newSignals += inspectTimedOutTasks(now, stalledThresholdMs);
    newSignals += await inspectOrphanedTasks();
    newSignals += inspectOpenDecisions(now, needsYouEscalateMs);
    newSignals += inspectScheduledCheckTasks(now);
    newSignals += await inspectStuckLeaders(now, stalledThresholdMs);
    if (deps.sweepTaskDeliveryGates) {
      newSignals += await deps.sweepTaskDeliveryGates(now).catch((error) => {
        deps.logger.warn({ err: error }, "Delivery gate PR follow-up sweep failed");
        return 0;
      });
    }

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

    const remoteScan = inspectRemoteFleetAgents(now, needsYouEscalateMs, stalledThresholdMs);
    newSignals += remoteScan.signalsAdded;

    return {
      scannedSessions: agents.length + remoteScan.scannedRemote,
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
      signalQueue.start();
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
      signalQueue.start();
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

    async handleAgentArchived(agentId) {
      await handleAgentArchivedInternal(agentId);
    },

    getApprovalTracker() {
      return approvalTracker;
    },

    handleRemotePermissionRequested,
    handleRemotePermissionResolved,
    handleRemoteAgentsChanged,
    reconcileRemoteHostScope,

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
