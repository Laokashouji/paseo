import crypto from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import {
  MAIN_CHAT_BACKGROUND_COMPACTION_MSG_PREFIX,
  MAIN_CHAT_COMPACT_WINDOW_RATIO,
  MAIN_CHAT_CONVERSATION_ID_LABEL,
  MAIN_CHAT_FORMER_ROLE_VALUE,
  MAIN_CHAT_REPLACED_BY_LABEL,
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_GOAL_LABEL,
  MAIN_CHAT_TASK_ID_LABEL,
  MAIN_CHAT_TASK_MODE_LABEL,
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
  MAIN_CHAT_TASK_QUIET_LABEL,
  MAIN_CHAT_TASK_RECORD_ID_LABEL,
  MAIN_CHAT_WORKSPACE_DIR_NAME,
  computeEffectiveCompactionWindowTokens,
  extractMainChatPermissionRuleCandidate,
  formatMainChatModelSpec,
  getMainChatTaskMetaFromLabels,
  isFormerMainChatLabels,
  isHostAllowedInFleetScope,
  isMainChatAutoCompactEnabled,
  isMainChatEnabled,
  isMainChatLabels,
  isMainChatTaskLessonsEnabled,
  isMainChatTasksQuiet,
  normalizeMainChatFleetScope,
  resolveMainChatCompactionConfig,
  resolveMainChatDeliveryGatePolicy,
  resolveMainChatFleetScope,
  resolveMainChatIdleArchivePolicy,
  resolveMainChatModelConfig,
  resolveMainChatProfile,
  resolveMainChatResourceAdmissionPolicy,
  type MainChatActivityEntry,
  type MainChatActivityKind,
  type MainChatAdmissionQueueEntry,
  type MainChatApprovalClarification,
  type MainChatCacheKeepaliveStatus,
  type MainChatCompactionReason,
  type MainChatCompactionState,
  type MainChatCompactionStatus,
  type MainChatCompactionStrategy,
  type MainChatConversationRecord,
  type MainChatDecisionOption,
  type MainChatDecisionRecord,
  type MainChatDrainAdmissionAction,
  type MainChatFleetHostStatus,
  type MainChatFleetScope,
  type MainChatHostResourceSnapshot,
  type MainChatIdleArchiveSweepResult,
  type MainChatLimitFallbackEvent,
  type MainChatMemoryFileContent,
  type MainChatMemoryFileMeta,
  type MainChatModelProfileSwitchEvent,
  type MainChatModelPurpose,
  type MainChatNightModeStatus,
  type MainChatNotificationCategory,
  type MainChatNotificationDeliveryStatus,
  type MainChatNotificationReceipt,
  type MainChatNotificationSummary,
  type MainChatOverview,
  type MainChatPatrolResult,
  type MainChatPermissionRule,
  type MainChatPlanRecord,
  type MainChatPlanTaskPatch,
  type MainChatPlannedTask,
  type MainChatProjectLesson,
  type MainChatProjectLessonGroup,
  type MainChatPromptTemplate,
  type MainChatPromptTemplateInput,
  type MainChatReceiptCheck,
  type MainChatResourceAdmissionPolicy,
  type MainChatResourceAdmissionSnapshot,
  type MainChatReworkRecord,
  type MainChatRoutineRecord,
  type MainChatRuleKind,
  type MainChatRuleSuggestion,
  type MainChatSettings,
  type MainChatSettingsPatch,
  type MainChatSettingsProposalRecord,
  type MainChatStandingAuthorization,
  type MainChatStandingAuthorizationScope,
  type MainChatSupervisionSignal,
  type MainChatTaskDecisionActor,
  type MainChatTaskDecisionEntry,
  type MainChatTaskDeliveryGate,
  type MainChatTaskIsolation,
  type MainChatTaskMode,
  type MainChatTaskReceipt,
  type MainChatTaskRecord,
  type MainChatTaskReviewVerdict,
  type MainChatTokenUsageSource,
  type MainChatTokenUsageSummary,
  type FeishuBridgeAuditDirection,
  type FeishuBridgeAuditRecord,
  type FeishuBridgeConfigPatch,
  type FeishuBridgeConnectionTestResult,
  type FeishuBridgeReceiveIdType,
  type FeishuBridgeSendTestCardResult,
  type FeishuBridgeState,
  type FeishuBridgeStats,
} from "@getpaseo/protocol/main-chat";
import {
  PARENT_AGENT_ID_LABEL,
  PARENT_SERVER_ID_LABEL,
  getParentAgentIdFromLabels,
} from "@getpaseo/protocol/agent-labels";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { FinishSubscriptions } from "../agent/finish-subscriptions/index.js";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import {
  formatSystemNotificationPrompt,
  isSystemInjectedEnvelope,
  stripMainChatContextBlock,
  wrapMainChatContextBlock,
} from "../agent/agent-messages/index.js";
import type { AgentPromptInput, AgentTimelineItem, AgentUsage } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { StructuredGenerationDaemonConfig } from "../agent/structured-generation-providers.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowFn } from "../worktree-session.js";
import type { ScheduleService } from "../schedule/service.js";
import type { ScheduleExecutionResult, StoredSchedule } from "@getpaseo/protocol/schedule/types";
import { createAgentCommand, type EnsureWorkspaceForCreate } from "../agent/create-agent/create.js";
import { sendPreparedPromptToAgent, sendPromptToAgent } from "../agent/agent-prompt.js";
import { createPaseoWorktreeCommand } from "../worktree/commands.js";
import { expandUserPath } from "../path-utils.js";
import {
  createMainChatCacheKeepaliveScheduler,
  type CacheKeepaliveRunner,
} from "./cache-keepalive.js";
import {
  createMainChatContextSnapshotBuilder,
  type FleetSnapshotSummary,
} from "./context-snapshot.js";
import {
  createMainChatConversationManager,
  isMainChatConversationLabels,
  type MainChatConversationManager,
} from "./conversations.js";
import { createMainChatFleetAggregator, type FleetConnectedHosts } from "./fleet-aggregator.js";
import { createMainChatFleetBridge, type MainChatFleetBridge } from "./fleet-bridge.js";
import {
  createFeishuBridgeSeam,
  type FeishuBridgePluginInvoker,
  type FeishuBridgeSeam,
  type FeishuWebhookHttpRequest,
  type FeishuWebhookHttpResponse,
} from "./feishu-bridge-seam.js";
import {
  formatLeaderProgressMessage,
  type LeaderProgressReportInput,
  type LeaderProgressReportResult,
} from "./leader-tools.js";
import {
  createMainChatLimitFallbackController,
  hasHandoffBlockLabel,
  type LimitFallbackSwitchOutcome,
} from "./limit-fallback.js";
import {
  computeAtomicModelProfileSwitch,
  pickNextFallbackForFailedTask,
  resolveSlotModelForDispatch,
  validateModelSlotsAtomic,
  type AvailableProviderInfo,
} from "./model-profiles.js";
import { assembleMainChatMemoryContext, createMainChatMemoryStore } from "./memory.js";
import {
  buildMainChatCompactionCheckpointPrompt,
  buildMainChatHandoffSummary,
  buildWorkerInitialPrompt,
} from "./prompts.js";
import {
  createMainChatRoutinesManager,
  type CreateMainChatRoutineInput,
  type ListMainChatRoutinesOptions,
} from "./routines.js";
import {
  buildSettingsProposal,
  type BuiltSettingsProposalResult,
  type ProposeSettingsPatchInput,
} from "./settings-proposal.js";
import {
  buildDeterministicClarificationAnswer,
  buildNextStepSuggestions,
  buildStandingAuthorizationLabel,
  checkRedLineGuard,
  createApprovalClarificationRecord,
  createClarificationProofStore,
  recordManualApprovalObservation,
  type ApprovalInterceptionEntry,
  type BuildClarificationAnswerInput,
} from "./safety.js";
import { createMainChatStore, type MainChatMetrics, type MainChatStore } from "./store.js";
import { type IdleArchiveAgentCandidate, runIdleSubagentArchiveSweep } from "./idle-archive.js";
import {
  listMergedPromptTemplates,
  removeCustomPromptTemplate,
  upsertCustomPromptTemplate,
} from "./prompt-library.js";
import {
  MainChatAdmissionRejectedError,
  buildHostResourceSnapshot,
  buildResourceAdmissionSnapshot,
  createAdmissionQueueId,
  createTaskQueuedAdmissionState,
  createTaskRejectedAdmissionState,
  evaluateHostResourceAdmission,
  sampleLocalHostOsResources,
  type HostResourceSampler,
} from "./resource-admission.js";
import type { StatelessSupervisionRunner } from "./stateless-supervision.js";
import {
  createMainChatToolLoaderRegistry,
  type MainChatToolLoaderRegistry,
} from "./tool-loading.js";
import { createMainChatSupervisor } from "./supervisor.js";
import {
  DeliveryGateBlockedError,
  buildDeliveryGateFromDiscoveredPrUrl,
  buildDeliveryGateFromGitSnapshot,
  computeDeliveryGateStatusAndBlockers,
  diffDeliveryGateTransitions,
  evaluateTaskDeliveryGateForAcceptance,
  extractPrUrlFromText,
  matchTasksForGitSnapshot,
} from "./delivery-gate.js";
import {
  MainChatProjectLessonsStore,
  type AddProjectLessonInput,
  type AddProjectLessonResult,
  type ProjectLessonTargetContext,
} from "./lessons.js";
import {
  checkParentCloseoutCandidate,
  cleanTaskIdList,
  computeTaskDependencyState,
  findNewlyReadyDownstreamTasks,
  validateTaskDagBatch,
} from "./task-dag.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitService,
  WorkspaceGitSubscription,
} from "../workspace-git-service.js";
import {
  appendTaskDecision,
  applyTaskScopeUpdate,
  attachContinuationAgentToTask,
  buildScopeRevisionNoticePrompt,
  computeTaskDurationMinutes,
  createTaskRecordFromPlannedTask,
  estimateExpectedMinutes,
  formatTaskDecisionsPromptSection,
  normalizeTrustCwd,
  resolveEffectiveTaskStatus,
  validateTaskBriefInput,
} from "./task-ledger.js";
import { createMainChatTurnQueue } from "./turn-queue.js";
import type { RunSemanticTriageInput, SemanticTriageOutput } from "./triage.js";

const MAX_REWORK_ROUNDS = 2;
export const DEFAULT_MAIN_CHAT_COMPACT_THRESHOLD_TOKENS = 400_000;
const DEFAULT_IDLE_PRECOMPACT_CHECK_INTERVAL_MS = 60 * 1_000;

export interface CreateMainChatPlanTaskInput {
  title: string;
  goal: string;
  mode?: MainChatTaskMode;
  isolation?: MainChatTaskIsolation;
  serverId?: string;
  hostLabel?: string;
  cwd?: string;
  workspaceId?: string;
  reason?: string;
  doneWhen?: string[];
  outOfBounds?: string[];
  provider?: string;
  modeId?: string;
  thinkingOptionId?: string;
  branchName?: string;
  baseBranch?: string;
  continuesTaskId?: string;
  continuesWhy?: string;
  quiet?: boolean;
  refId?: string;
  partOf?: string;
  after?: string[];
  autoStartOnReady?: boolean;
}

export interface CreateMainChatPlanInput {
  summary?: string;
  autoStart?: boolean;
  conversationId?: string;
  tasks: CreateMainChatPlanTaskInput[];
}

export interface EnsureMainChatInput {
  provider?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export interface EnsureMainChatResult {
  agentId: string;
  workspaceId: string;
  created: boolean;
}

export interface MainChatTaskLiveSummary {
  planId: string | null;
  taskId: string | null;
  title: string;
  goal: string | null;
  mode: MainChatTaskMode | null;
  agentId: string | null;
  status: string;
  pendingPermissions: number;
  cwd: string | null;
  workspaceId: string | null;
  planStatus: MainChatPlanRecord["status"] | null;
  startError: string | null;
}

export interface MainChatReworkInput {
  agentId: string;
  title?: string;
  planId?: string;
  taskId?: string;
  gaps: string[];
  note?: string;
}

export interface MainChatAskUserInput {
  title: string;
  question: string;
  agentId?: string;
  planId?: string;
  taskId?: string;
  options: MainChatDecisionOption[];
  recommendedOptionId?: string;
  reason?: string;
  escalatedFromTitle?: string;
}

export interface MainChatAnswerDecisionInput {
  decisionId: string;
  optionId?: string;
  answer: string;
}

export interface MainChatServiceDependencies {
  paseoHome: string;
  worktreesRoot?: string;
  serverId: string;
  hostLabel?: string;
  connectedHosts?: () => FleetConnectedHosts | null;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  providerSnapshotManager: ProviderSnapshotManager;
  workspaceRegistry: Pick<WorkspaceRegistry, "get" | "listActive"> &
    Partial<Pick<WorkspaceRegistry, "update">>;
  createDirectoryWorkspace: (
    cwd: string,
    title?: string | null,
    projectId?: string,
    context?: { background?: boolean; callerWorkspaceId?: string },
  ) => Promise<PersistedWorkspaceRecord>;
  emitWorkspaceUpdates?: (workspaceIds: Iterable<string>) => Promise<void>;
  readDaemonConfig?: () => StructuredGenerationDaemonConfig | null;
  semanticTriageRunner?: (input: RunSemanticTriageInput) => Promise<SemanticTriageOutput | null>;
  statelessSupervisionRunner?: StatelessSupervisionRunner;
  hostResourceSampler?: HostResourceSampler;
  ensureWorkspaceForCreate?: EnsureWorkspaceForCreate;
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  finishSubscriptions?: () => FinishSubscriptions;
  terminalManager?: TerminalManager | null;
  scheduleService?: Pick<
    ScheduleService,
    "list" | "inspect" | "create" | "pause" | "resume" | "runOnce" | "delete" | "rebindAgentTarget"
  > | null;
  workspaceGitService?: Pick<WorkspaceGitService, "onSnapshotUpdated" | "getSnapshot"> | null;
  cacheKeepaliveCheckIntervalMs?: number;
  cacheKeepaliveRunner?: CacheKeepaliveRunner;
  logger: Logger;
  transientRetryDelayMs?: number;
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
  maxTransientAutoRetries?: number;
  ruleSuggestionThreshold?: number;
  permissionClarifier?: (
    input: BuildClarificationAnswerInput,
  ) => Promise<string | null> | string | null;
  now?: () => number;
  snapshotCacheTtlMs?: number;
  snapshotForegroundTimeoutMs?: number;
  turnQueueDrainDelayMs?: number;
  compactThresholdTokens?: number;
  idlePrecompactMinIdleMs?: number;
  idlePrecompactCheckIntervalMs?: number;
  feishuPluginInvoker?: FeishuBridgePluginInvoker | null;
  resolveFeishuWebhookUrl?: () => string | null;
}

export interface MainChatCompactOptions {
  reason?: MainChatCompactionReason;
  instructions?: string;
}

export interface MainChatCompactResult {
  mainAgentId: string;
  compaction: MainChatCompactionState;
}

export interface MainChatClearOptions {
  provider?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export interface MainChatClearResult {
  previousAgentId: string | null;
  agentId: string;
  workspaceId: string;
  migratedPlans: number;
  migratedDecisions: number;
  migratedChildAgents: number;
}

export interface MainChatNewSessionOptions {
  carryHandoffSummary?: boolean;
  title?: string;
  provider?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export interface MainChatNewSessionResult extends MainChatClearResult {
  handoffSummary: string | null;
}

export interface MainChatListActivityOptions {
  mainAgentId?: string;
  limit?: number;
  includeSilent?: boolean;
  kind?: MainChatActivityKind;
}

export interface MainChatListActivityResult {
  activities: MainChatActivityEntry[];
  total: number;
}

export interface MainChatService {
  start(): Promise<void>;
  stop(): void;
  ensureMainChat(input?: EnsureMainChatInput): Promise<EnsureMainChatResult>;
  getSettings(): Promise<MainChatSettings>;
  getCurrentSettings(): MainChatSettings;
  getNightModeStatus(): MainChatNightModeStatus;
  getTokenUsage(): Promise<MainChatTokenUsageSummary>;
  resetTokenUsage(): Promise<MainChatTokenUsageSummary>;
  updateSettings(patch: MainChatSettingsPatch): Promise<MainChatSettings>;
  triggerPatrol(options?: {
    mainAgentId?: string;
    forceWakeup?: boolean;
  }): Promise<MainChatPatrolResult>;
  beginForegroundUserSend(agentId: string): (() => void) | null;
  abortForegroundUserSend(agentId: string): void;
  isCompacting(agentId: string): boolean;
  prepareUserPromptForMainChat(
    agentId: string,
    prompt: AgentPromptInput,
    options?: { onDeferredForCompaction?: () => void },
  ): Promise<AgentPromptInput>;
  getCompactionState(mainAgentId?: string): Promise<MainChatCompactionState>;
  compactMainChat(
    mainAgentId?: string,
    options?: MainChatCompactOptions,
  ): Promise<MainChatCompactResult>;
  checkIdlePrecompaction(mainAgentId?: string): Promise<boolean>;
  clearMainChatContext(
    mainAgentId?: string,
    options?: MainChatClearOptions,
  ): Promise<MainChatClearResult>;
  startNewMainChatSession(
    mainAgentId?: string,
    options?: MainChatNewSessionOptions,
  ): Promise<MainChatNewSessionResult>;
  listActivity(options?: MainChatListActivityOptions): Promise<MainChatListActivityResult>;
  listFleetSessions(mainAgentId?: string): Promise<FleetSnapshotSummary>;
  createPlan(mainAgentId: string, input: CreateMainChatPlanInput): Promise<MainChatPlanRecord>;
  startPlan(
    planId: string,
    options?: { taskIds?: string[]; rememberAutoStart?: boolean },
  ): Promise<MainChatPlanRecord>;
  cancelPlan(planId: string): Promise<MainChatPlanRecord>;
  getPlan(planId: string): MainChatPlanRecord | null;
  listPlans(mainAgentId: string): MainChatPlanRecord[];
  listTasks(mainAgentId: string): Promise<MainChatTaskLiveSummary[]>;
  reworkTask(mainAgentId: string, input: MainChatReworkInput): Promise<MainChatReworkRecord>;
  askUserDecision(
    mainAgentId: string,
    input: MainChatAskUserInput,
  ): Promise<MainChatDecisionRecord>;
  answerDecision(input: MainChatAnswerDecisionInput): Promise<MainChatDecisionRecord>;
  getOverview(mainAgentId?: string): Promise<MainChatOverview>;
  addPermissionRule(input: {
    toolName: string;
    commandPrefix?: string | null;
    cwd?: string | null;
  }): Promise<MainChatPermissionRule>;
  removeRule(kind: MainChatRuleKind, ruleId: string): Promise<boolean>;
  recordReceipt(receipt: MainChatTaskReceipt, mainAgentId?: string): Promise<MainChatTaskReceipt>;
  getMetrics(): MainChatMetrics;
  // M3 Task Ledger & Inline Plan Editing contract
  updatePlanTask(
    planId: string,
    taskId: string,
    patch: MainChatPlanTaskPatch,
  ): Promise<MainChatPlanRecord>;
  withdrawPlan(planId: string, reason: string): Promise<MainChatPlanRecord>;
  listTaskRecords(options?: {
    mainAgentId?: string;
    conversationId?: string;
    includeCompleted?: boolean;
  }): Promise<MainChatTaskRecord[]>;
  updateTaskScope(input: {
    taskId: string;
    goal?: string;
    doneWhen?: string[];
    outOfBounds?: string[];
    reason?: string;
  }): Promise<MainChatTaskRecord>;
  parkTask(input: {
    taskId: string;
    parked: boolean;
    reason?: string;
  }): Promise<MainChatTaskRecord>;
  reviewTask(input: {
    taskId: string;
    verdict: MainChatTaskReviewVerdict;
    summary?: string;
    gaps?: string[];
    checks?: MainChatReceiptCheck[];
    nextSteps?: string[];
    note?: string;
    bypassDeliveryGate?: boolean;
    bypassReason?: string;
  }): Promise<{
    task: MainChatTaskRecord;
    receipt: MainChatTaskReceipt | null;
    rework: MainChatReworkRecord | null;
    deliveryGateWarning?: string | null;
  }>;
  // Wave 3: Project Lessons, Delivery Gate & Task DAG
  listLessons(options?: { projectKey?: string }): Promise<{
    groups: MainChatProjectLessonGroup[];
    lessons: MainChatProjectLesson[];
  }>;
  addLesson(input: AddProjectLessonInput): Promise<AddProjectLessonResult>;
  deleteLesson(lessonId: string): Promise<{ deleted: boolean }>;
  startReadyTask(taskId: string): Promise<{
    task: MainChatTaskRecord;
    plan: MainChatPlanRecord | null;
  }>;
  updateTaskDependencies(input: {
    taskId: string;
    partOf?: string | null;
    after?: string[];
    autoStartOnReady?: boolean;
  }): Promise<MainChatTaskRecord>;
  syncTaskDeliveryGate(
    taskId: string,
    gatePatch: Partial<MainChatTaskDeliveryGate> & { prUrl?: string | null },
  ): Promise<MainChatTaskRecord>;
  handleWorkspaceGitSnapshot(snapshot: WorkspaceGitRuntimeSnapshot): Promise<number>;
  // M4 Multi-Conversation & Cross-Host Fleet contract
  getConversationManager(): MainChatConversationManager;
  getFleetBridge(): MainChatFleetBridge;
  reportLeaderProgress(input: LeaderProgressReportInput): Promise<LeaderProgressReportResult>;
  listConversations(options?: { includeArchived?: boolean }): Promise<MainChatConversationRecord[]>;
  createConversation(input: {
    kind: "side" | "leader";
    title: string;
    directionSummary?: string | null;
    notes?: string | null;
    initialPrompt?: string;
    provider?: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
  }): Promise<MainChatConversationRecord>;
  updateConversation(input: {
    conversationId: string;
    title?: string;
    directionSummary?: string | null;
    notes?: string | null;
    kind?: "side" | "leader";
    archived?: boolean;
  }): Promise<MainChatConversationRecord>;
  getFleetHosts(options?: { forceRefresh?: boolean }): Promise<{
    localServerId: string | null;
    hosts: MainChatFleetHostStatus[];
    fleetScope?: MainChatFleetScope;
    availableRemoteHosts?: MainChatFleetHostStatus[];
  }>;
  isManagedConversationAgent?(agentId: string): boolean;
  isHostAllowedForSteward?(targetServerId: string): boolean;
  // M5 Approval Clarification & Standing Authorizations
  clarifyPermission(input: {
    agentId: string;
    serverId?: string | null;
    permissionRequestId: string;
    question: string;
  }): Promise<MainChatApprovalClarification>;
  consumeClarificationProofToken(
    proofToken: string,
    expected?: { agentId?: string; permissionRequestId?: string },
  ): boolean;
  listStandingAuthorizations(options?: { includeRevoked?: boolean }): Promise<{
    authorizations: MainChatStandingAuthorization[];
    suggestions: MainChatRuleSuggestion[];
  }>;
  grantStandingAuthorization(input: {
    scope: MainChatStandingAuthorizationScope;
    serverId?: string | null;
    cwd?: string | null;
    allowSubdirectories?: boolean;
    toolName?: string | null;
    commandPrefix?: string | null;
    mode?: MainChatTaskMode | null;
    label?: string;
    reason?: string | null;
    suggestionId?: string;
    expiresAt?: string | null;
  }): Promise<MainChatStandingAuthorization>;
  revokeStandingAuthorization(authorizationId: string): Promise<{
    revoked: boolean;
    authorization: MainChatStandingAuthorization | null;
  }>;
  dismissRuleSuggestion(suggestionId: string): Promise<boolean>;
  listPendingSignals?: (conversationId?: string | null) => MainChatSupervisionSignal[];
  listTrackedApprovals?: () => ApprovalInterceptionEntry[];
  handleAgentArchived(agentId: string): Promise<void>;
  listMemoryFiles(): Promise<MainChatMemoryFileMeta[]>;
  readMemoryFile(relativePath: string): Promise<MainChatMemoryFileContent>;
  writeMemoryFile(relativePath: string, content: string): Promise<MainChatMemoryFileMeta>;
  deleteMemoryFile(relativePath: string): Promise<{ deleted: boolean }>;
  assembleMemoryContextForAgent(opening?: {
    purpose?: string;
    labels?: Record<string, string>;
  }): Promise<string | null>;
  // Wave 2: Cache Keepalive, Routines, Settings Proposals, and Limit Fallbacks
  getCacheKeepaliveStatus(): MainChatCacheKeepaliveStatus;
  checkCacheKeepalive(): Promise<number>;
  listRoutines(options?: ListMainChatRoutinesOptions): Promise<MainChatRoutineRecord[]>;
  createRoutine(input: CreateMainChatRoutineInput): Promise<MainChatRoutineRecord>;
  pauseRoutine(routineId: string): Promise<MainChatRoutineRecord>;
  resumeRoutine(routineId: string): Promise<MainChatRoutineRecord>;
  runRoutineOnce(routineId: string): Promise<MainChatRoutineRecord>;
  deleteRoutine(routineId: string): Promise<{ deleted: boolean }>;
  executeScheduledAgentRoutine(
    schedule: StoredSchedule,
    runId: string,
  ): Promise<ScheduleExecutionResult | null>;
  proposeSettingsPatch(
    input: Omit<ProposeSettingsPatchInput, "mainAgentId"> & { mainAgentId?: string },
  ): Promise<BuiltSettingsProposalResult>;
  listSettingsProposals(options?: {
    mainAgentId?: string;
    includeResolved?: boolean;
  }): Promise<MainChatSettingsProposalRecord[]>;
  resolveSettingsProposal(input: {
    proposalId: string;
    decision: "approve" | "reject";
    note?: string;
  }): Promise<{
    proposal: MainChatSettingsProposalRecord;
    settings: MainChatSettings;
    nightModeStatus: MainChatNightModeStatus;
    cacheKeepaliveStatus: MainChatCacheKeepaliveStatus;
  }>;
  listRecentLimitFallbacks(limit?: number): Promise<MainChatLimitFallbackEvent[]>;
  tryLimitFallbackForAgent(
    agentId: string,
    errorMessage: string,
  ): Promise<LimitFallbackSwitchOutcome>;
  // Wave 4: Multi-Purpose Model Profiles, Failed-Task Retry with Fallback, Notification Receipts
  switchModelProfile(input: {
    profileId?: string;
    rollback?: boolean;
    actor?: "user" | "proposal" | "tool";
  }): Promise<{
    settings: MainChatSettings;
    activeProfileId: string | null;
    changedSlots: MainChatModelPurpose[];
    event: MainChatModelProfileSwitchEvent | null;
  }>;
  retryTaskWithFallback(input: {
    taskId: string;
    provider?: string;
    model?: string | null;
    thinkingOptionId?: string | null;
    reason?: string;
  }): Promise<{
    task: MainChatTaskRecord;
    previousAgentId: string | null;
    newAgentId: string;
    fromModelSpec: string | null;
    toModelSpec: string;
    fallbackEvent: MainChatLimitFallbackEvent;
  }>;
  listNotificationReceipts(options?: {
    status?: MainChatNotificationDeliveryStatus;
    category?: MainChatNotificationCategory;
    unreadOnly?: boolean;
    limit?: number;
  }): Promise<{
    receipts: MainChatNotificationReceipt[];
    summary: MainChatNotificationSummary;
  }>;
  ackNotificationReceipt(input: {
    receiptId?: string;
    receiptIds?: string[];
    markAll?: boolean;
    status?: "acknowledged" | "read";
  }): Promise<{
    updatedCount: number;
    receipts: MainChatNotificationReceipt[];
    summary: MainChatNotificationSummary;
  }>;
  // Wave 5: Resource Admission, On-Demand Tool Loading, Idle Subagent Archive & Prompt Library
  getToolLoaderRegistry(): MainChatToolLoaderRegistry;
  getResourceAdmission(options?: {
    forceRefresh?: boolean;
  }): Promise<MainChatResourceAdmissionSnapshot>;
  drainAdmissionQueue(input?: {
    action?: MainChatDrainAdmissionAction;
    queueId?: string;
    serverId?: string;
  }): Promise<{
    action: MainChatDrainAdmissionAction;
    dispatchedCount: number;
    removedCount: number;
    remainingCount: number;
    snapshot: MainChatResourceAdmissionSnapshot;
  }>;
  sweepIdleSubagents(input?: {
    dryRun?: boolean;
    idleThresholdMinutes?: number;
    limit?: number;
    trigger?: "scheduled" | "manual";
  }): Promise<MainChatIdleArchiveSweepResult>;
  listPromptLibrary(): Promise<{
    templates: MainChatPromptTemplate[];
    builtinCount: number;
    customCount: number;
  }>;
  savePromptTemplate(template: MainChatPromptTemplateInput): Promise<{
    template: MainChatPromptTemplate;
    templates: MainChatPromptTemplate[];
  }>;
  deletePromptTemplate(input: { id?: string; slug?: string }): Promise<{
    deleted: boolean;
    templates: MainChatPromptTemplate[];
  }>;
  // Wave 6: Plugin-based Feishu Bot Bridge minimal seam
  getFeishuBridgeState(options?: { auditLimit?: number }): Promise<FeishuBridgeState>;
  updateFeishuBridgeConfig(patch: FeishuBridgeConfigPatch): Promise<FeishuBridgeState>;
  testFeishuBridgeConnection(options?: {
    forceRefreshToken?: boolean;
  }): Promise<FeishuBridgeConnectionTestResult>;
  sendFeishuBridgeTestCard(options?: {
    receiveId?: string;
    receiveIdType?: FeishuBridgeReceiveIdType;
    title?: string;
  }): Promise<FeishuBridgeSendTestCardResult>;
  listFeishuBridgeAudit(options?: {
    limit?: number;
    direction?: FeishuBridgeAuditDirection;
  }): Promise<{ records: FeishuBridgeAuditRecord[]; stats: FeishuBridgeStats }>;
  handleFeishuWebhook(request: FeishuWebhookHttpRequest): Promise<FeishuWebhookHttpResponse>;
}

async function isExistingDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

function parseProviderSpec(spec: string): { provider: AgentProvider; model?: string } {
  const trimmed = spec.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0) {
    return { provider: trimmed as AgentProvider };
  }
  const provider = trimmed.slice(0, slashIndex) as AgentProvider;
  const model = trimmed.slice(slashIndex + 1).trim();
  return model ? { provider, model } : { provider };
}

function formatProviderModel(provider: string, model?: string | null): string {
  const trimmedModel = model?.trim();
  return trimmedModel ? `${provider}/${trimmedModel}` : provider;
}

function formatCompactionCheckpointNotificationPrompt(
  checkpointPrompt: string,
  reason: MainChatCompactionReason,
): string {
  const label = reason === "idle_precompact" ? "后台空闲预压缩检查点" : "主对话上下文压缩检查点";
  return formatSystemNotificationPrompt(checkpointPrompt, {
    kind: "compaction",
    trigger: reason,
    label,
    quiet: true,
  });
}

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function trimOptional(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function trimList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((entry) => entry.trim()).filter(Boolean);
}

export function createMainChatService(deps: MainChatServiceDependencies): MainChatService {
  const logger = deps.logger.child({ module: "main-chat" });
  const getNowMs = deps.now ?? (() => Date.now());
  const explicitCompactThresholdTokens = deps.compactThresholdTokens;
  const configuredCompactThresholdTokens =
    deps.compactThresholdTokens ?? DEFAULT_MAIN_CHAT_COMPACT_THRESHOLD_TOKENS;
  const explicitIdlePrecompactMinIdleMs = deps.idlePrecompactMinIdleMs;
  let idlePrecompactMinIdlePatched = false;
  const idlePrecompactCheckIntervalMs =
    deps.idlePrecompactCheckIntervalMs ?? DEFAULT_IDLE_PRECOMPACT_CHECK_INTERVAL_MS;

  const store: MainChatStore = createMainChatStore(deps.paseoHome, { now: getNowMs });
  const memoryStore = createMainChatMemoryStore({ paseoHome: deps.paseoHome });

  const localHostLabel = deps.hostLabel?.trim() || deps.serverId;
  const connectedHostsProxy: FleetConnectedHosts | undefined = deps.connectedHosts
    ? {
        getSelfHost: () =>
          deps.connectedHosts?.()?.getSelfHost() ?? {
            serverId: deps.serverId,
            label: localHostLabel,
          },
        listKnownHosts: () => deps.connectedHosts?.()?.listKnownHosts() ?? [],
        listAcceptedHosts: () => deps.connectedHosts?.()?.listAcceptedHosts() ?? [],
        getAcceptedClient: (targetServerId) =>
          deps.connectedHosts?.()?.getAcceptedClient(targetServerId) ?? null,
        subscribeHostChanges: (listener) => {
          const target = deps.connectedHosts?.();
          if (target) {
            return target.subscribeHostChanges(listener);
          }
          return () => {};
        },
      }
    : undefined;

  function isHostAllowedForSteward(targetServerId: string): boolean {
    return isHostAllowedInFleetScope(store.getSettings().fleetScope, deps.serverId, targetServerId);
  }

  function isManagedConversationAgent(agentId: string): boolean {
    const trimmed = agentId.trim();
    if (!trimmed) return false;
    const live = deps.agentManager.getAgent(trimmed);
    if (live && (isMainChatLabels(live.labels) || isMainChatConversationLabels(live.labels))) {
      return true;
    }
    return conversationManager.getConversationByAgentId(trimmed) !== null;
  }

  function describeHostScope(): string {
    const scope = resolveMainChatFleetScope(store.getSettings(), deps.serverId);
    if (scope.mode === "local_only") {
      return `仅本机（${localHostLabel}）`;
    }
    const labelByServerId = new Map<string, string>();
    for (const host of connectedHostsProxy?.listKnownHosts() ?? []) {
      const id = host.serverId ?? host.registrationId;
      if (id && id !== deps.serverId) {
        labelByServerId.set(id, host.label?.trim() || host.targetDescription || id);
      }
    }
    for (const handle of connectedHostsProxy?.listAcceptedHosts() ?? []) {
      if (handle.serverId !== deps.serverId) {
        labelByServerId.set(handle.serverId, handle.label?.trim() || handle.serverId);
      }
    }
    if (scope.mode === "allowlist") {
      if (scope.hostServerIds.length === 0) {
        return `仅本机（${localHostLabel}）`;
      }
      const remoteLabels = scope.hostServerIds.map((id) => labelByServerId.get(id) ?? id);
      return `${localHostLabel}（本机）、${remoteLabels.join("、")}`;
    }
    const allRemoteLabels = Array.from(labelByServerId.values());
    if (allRemoteLabels.length === 0) {
      return `本机（${localHostLabel}）`;
    }
    return `${localHostLabel}（本机）及全部已连主机（${allRemoteLabels.join("、")}）`;
  }

  const fleetAggregator = createMainChatFleetAggregator({
    localServerId: deps.serverId,
    localLabel: localHostLabel,
    agentManager: deps.agentManager,
    agentStorage: deps.agentStorage,
    connectedHosts: connectedHostsProxy,
    isHostAllowed: isHostAllowedForSteward,
    logger,
  });

  const conversationManager = createMainChatConversationManager({
    homeDir: deps.paseoHome,
    defaultServerId: deps.serverId,
    now: getNowMs,
    logger,
    createConversationAgent: async (input) => {
      const workspace = await resolveMainChatWorkspace();
      const providerConfig = await resolveDefaultMainChatProviderConfig(workspace.cwd, {
        provider: input.provider,
        model: input.model,
        modeId: input.modeId,
        thinkingOptionId: input.thinkingOptionId,
      });
      const { snapshot } = await createAgentCommand(
        {
          agentManager: deps.agentManager,
          agentStorage: deps.agentStorage,
          finishSubscriptions: deps.finishSubscriptions?.(),
          logger,
          paseoHome: deps.paseoHome,
          worktreesRoot: deps.worktreesRoot,
          terminalManager: deps.terminalManager,
          providerSnapshotManager: deps.providerSnapshotManager,
          createPaseoWorktree: deps.createPaseoWorktree,
          ensureWorkspaceForCreate: deps.ensureWorkspaceForCreate,
        },
        {
          kind: "session",
          config: {
            provider: providerConfig.provider,
            cwd: workspace.cwd,
            title: input.title,
            systemPrompt: input.systemPrompt,
            ...(providerConfig.model ? { model: providerConfig.model } : {}),
            ...(providerConfig.modeId ? { modeId: providerConfig.modeId } : {}),
            ...(providerConfig.thinkingOptionId
              ? { thinkingOptionId: providerConfig.thinkingOptionId }
              : {}),
          },
          workspaceId: workspace.workspaceId,
          background: false,
          labels: input.labels,
          provisionalTitle: input.title,
          firstAgentContext: {},
        },
      );
      return {
        agentId: snapshot.id,
        workspaceId: snapshot.workspaceId ?? workspace.workspaceId,
        serverId: deps.serverId,
      };
    },
    sendPromptToAgent: async ({ conversation, prompt }) => {
      await sendPromptToAgent({
        agentId: conversation.agentId,
        prompt,
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger,
        unarchive: false,
      });
    },
    readAgentTail: async ({ conversation, limit }) => {
      const live = deps.agentManager.getAgent(conversation.agentId);
      const messages = await fleetAggregator.readHostAgentTail(
        deps.serverId,
        conversation.agentId,
        {
          limit,
        },
      );
      return {
        lifecycle: live?.lifecycle ?? "idle",
        messages,
      };
    },
    syncConversationAgent: async ({ conversation, labels }) => {
      try {
        await deps.agentManager.updateAgentMetadata(conversation.agentId, {
          title: conversation.title,
          labels,
        });
      } catch (error) {
        logger.debug(
          { err: error, conversationId: conversation.id },
          "Conversation agent metadata sync skipped",
        );
      }
    },
    archiveConversationAgent: async (conversation) => {
      try {
        await deps.agentManager.archiveAgent(conversation.agentId);
      } catch (error) {
        logger.debug(
          { err: error, conversationId: conversation.id },
          "Conversation agent archive skipped",
        );
      }
    },
  });

  const fleetBridge = createMainChatFleetBridge({
    localServerId: deps.serverId,
    fleetAggregator,
    listExcludedAgentIds: () =>
      conversationManager.listConversationAgentIds({ includeArchived: true }),
    getTriage: (agentId) => store.getTriage(agentId),
  });

  let unsubscribeFleetEvents: (() => void) | null = null;

  const contextSnapshots = createMainChatContextSnapshotBuilder({
    serverId: deps.serverId,
    agentManager: deps.agentManager,
    agentStorage: deps.agentStorage,
    store,
    collectMultiHostFleet: async (mainAgentId) => {
      const scope = resolveMainChatFleetScope(store.getSettings(), deps.serverId);
      if (scope.mode === "local_only") return null;
      const known = connectedHostsProxy?.listKnownHosts() ?? [];
      const accepted = connectedHostsProxy?.listAcceptedHosts() ?? [];
      const hasAllowedRemote =
        known.some((host) => {
          const id = host.serverId ?? host.registrationId;
          return id !== deps.serverId && isHostAllowedForSteward(id);
        }) ||
        accepted.some(
          (handle) => handle.serverId !== deps.serverId && isHostAllowedForSteward(handle.serverId),
        );
      if (!hasAllowedRemote) return null;
      const collection = await fleetBridge.collectMultiHostFleet({ mainAgentId });
      return collection.summary;
    },
    describeHostScope,
    now: getNowMs,
    cacheTtlMs: deps.snapshotCacheTtlMs,
    foregroundTimeoutMs: deps.snapshotForegroundTimeoutMs,
  });

  const compactionStatusByAgent = new Map<string, MainChatCompactionStatus>();
  const compactionInFlightByAgent = new Map<string, Promise<MainChatCompactResult>>();
  const lastPrecompactWatermarkByAgent = new Map<string, number>();
  const lastCumulativeCostByAgent = new Map<string, number>();

  function recordAgentTurnTokenUsage(input: {
    agentId: string;
    source: MainChatTokenUsageSource;
    provider: AgentProvider;
    model: string | null;
    usage: AgentUsage;
  }): void {
    let costUsd = input.usage.totalCostUsd;
    if (input.provider === "opencode" && typeof costUsd === "number" && Number.isFinite(costUsd)) {
      const prev = lastCumulativeCostByAgent.get(input.agentId) ?? 0;
      const delta = Math.max(0, costUsd - prev);
      lastCumulativeCostByAgent.set(input.agentId, Math.max(prev, costUsd));
      costUsd = delta;
    }
    void store
      .recordTokenUsage({
        source: input.source,
        provider: input.provider,
        model: input.model,
        inputTokens: input.usage.inputTokens,
        cachedInputTokens: input.usage.cachedInputTokens,
        outputTokens: input.usage.outputTokens,
        costUsd,
        atMs: getNowMs(),
      })
      .catch((error) => {
        logger.warn(
          { err: error, agentId: input.agentId, source: input.source },
          "Failed to record main-chat token usage",
        );
      });
  }

  const turnQueue = createMainChatTurnQueue({
    agentManager: deps.agentManager,
    agentStorage: deps.agentStorage,
    store,
    logger,
    now: getNowMs,
    drainDelayMs: deps.turnQueueDrainDelayMs,
    autoSubscribe: false,
    onCompactionObserved: (mainAgentId) => {
      contextSnapshots.resetDelta(mainAgentId);
      const nowIso = new Date(getNowMs()).toISOString();
      const prev = store.getCompactionMeta(mainAgentId);
      compactionStatusByAgent.set(mainAgentId, "succeeded");
      void store
        .setCompactionMeta(mainAgentId, {
          ...prev,
          lastCompactedAt: nowIso,
          lastError: null,
        })
        .catch(() => undefined);
    },
    onMainAgentTurnCompleted: (info) => {
      recordAgentTurnTokenUsage({
        agentId: info.agentId,
        source: info.kind,
        provider: info.provider,
        model: info.model,
        usage: info.usage,
      });
    },
  });

  const clarificationProofs = createClarificationProofStore();
  const lessonsStore = new MainChatProjectLessonsStore(deps.paseoHome, { now: getNowMs });
  const toolLoaderRegistry = createMainChatToolLoaderRegistry();
  const inFlightAdmissionByHost = new Map<string, number>();
  let admissionDrainPromise: Promise<void> | null = null;
  let admissionDrainPending = false;
  const deliveryNotifiedKeys = new Set<string>();
  let unsubscribeGitSnapshots: WorkspaceGitSubscription | null = null;
  let feishuBridgeRef: FeishuBridgeSeam | null = null;

  const supervisor = createMainChatSupervisor({
    agentManager: deps.agentManager,
    agentStorage: deps.agentStorage,
    store,
    contextSnapshots,
    turnQueue,
    logger,
    serverId: deps.serverId,
    now: getNowMs,
    providerSnapshotManager: deps.providerSnapshotManager,
    readDaemonConfig: deps.readDaemonConfig,
    onBridgeEvent: (event) => {
      feishuBridgeRef?.dispatchMainChatEvent(event);
    },
    resolveConversationTarget: async (conversationId) => {
      if (!conversationId) return null;
      await conversationManager.load();
      const conv = conversationManager.getConversation(conversationId);
      if (!conv || conv.archivedAt !== null) return null;
      return { agentId: conv.agentId, label: conv.title };
    },
    isLeaderConversationActive: (conversationId) => {
      const conv = conversationManager.getConversation(conversationId);
      return Boolean(conv && conv.kind === "leader" && conv.archivedAt === null);
    },
    listLeaderConversations: () =>
      conversationManager.listConversations({ includeArchived: false }),
    isRemoteHostOffline: (serverId) => {
      const host = fleetAggregator
        .listAvailableRemoteHosts()
        .find((entry) => entry.serverId === serverId);
      return Boolean(host && (host.status === "offline" || host.status === "error"));
    },
    sweepTaskDeliveryGates: async (nowMs) => sweepTaskDeliveryGatesInternal(nowMs),
    onTaskReplyPrDiscovered: async (agentId, replyText) => {
      await discoverTaskPrFromReply(agentId, replyText);
    },
    onPatrolTick: async () => {
      await checkIdlePrecompactionInternal();
      await cacheKeepalive.tick();
      await maybeRunScheduledIdleArchiveSweep();
      await drainAdmissionQueueInternal({ action: "drain" });
    },
    onTryLimitFallback: async (agent, errorMessage) => {
      const outcome = await limitFallbackController.handleTurnLimitError(agent, errorMessage);
      return outcome.switched;
    },
    onAgentTurnCompleted: (agent) => {
      limitFallbackController.handleTurnCompleted(agent);
      cacheKeepalive.notifyTurnCompleted(agent.id);
      scheduleAdmissionQueueDrain();
    },
    isHostAllowed: isHostAllowedForSteward,
    getRemoteAgent: (serverId, agentId) => fleetBridge.getCachedRemoteAgent(serverId, agentId),
    listRemoteAgents: () => fleetBridge.listCachedRemoteAgents(),
    respondRemotePermission: (serverId, agentId, requestId, response) =>
      fleetBridge.respondPermissionOnTargetHost(serverId, agentId, requestId, response),
    onAgentEvent: (event) => {
      if (event.type === "agent_removed") {
        lastCumulativeCostByAgent.delete(event.agentId);
        cacheKeepalive.clearAgent(event.agentId);
        toolLoaderRegistry.clearSession(event.agentId);
        scheduleAdmissionQueueDrain();
        return;
      }
      if (event.type === "agent_state") {
        if (
          event.agent.lifecycle === "idle" ||
          event.agent.lifecycle === "closed" ||
          event.agent.lifecycle === "error"
        ) {
          scheduleAdmissionQueueDrain();
        }
        return;
      }
      if (event.type !== "agent_stream" || event.event.type !== "turn_completed") return;
      const live = deps.agentManager.getAgent(event.agentId);
      if (!live || live.internal || isMainChatLabels(live.labels)) return;
      const hasConversationLabel = Boolean(live.labels[MAIN_CHAT_CONVERSATION_ID_LABEL]);
      const trackedConversation = conversationManager.getConversationByAgentId(event.agentId);
      if (!hasConversationLabel && (!trackedConversation || trackedConversation.kind === "main")) {
        return;
      }
      cacheKeepalive.notifyTurnCompleted(event.agentId);
      const usage = event.event.usage;
      if (!usage) return;
      recordAgentTurnTokenUsage({
        agentId: event.agentId,
        source: "direction",
        provider: event.event.provider,
        model: live.config.model ?? live.runtimeInfo?.model ?? null,
        usage,
      });
    },
    semanticTriageRunner: deps.semanticTriageRunner,
    statelessSupervisionRunner: deps.statelessSupervisionRunner,
    transientRetryDelayMs: deps.transientRetryDelayMs,
    maxTransientAutoRetries: deps.maxTransientAutoRetries,
    usageLimitRetryDelayMs: deps.usageLimitRetryDelayMs,
    stalledThresholdMs: deps.stalledThresholdMs,
    stalledCheckIntervalMs: deps.stalledCheckIntervalMs,
    triageSettleMs: deps.triageSettleMs,
    noProgressThresholdMs: deps.noProgressThresholdMs,
    needsYouEscalateMs: deps.needsYouEscalateMs,
    wakeupCooldownMs: deps.wakeupCooldownMs,
    superviseGatherMs: deps.superviseGatherMs,
    normalCooldownMs: deps.normalCooldownMs,
    urgentCooldownMs: deps.urgentCooldownMs,
    allStoppedThresholdMs: deps.allStoppedThresholdMs,
    timedOutMultiplier: deps.timedOutMultiplier,
    periodicCheckIntervalMs: deps.periodicCheckIntervalMs,
    leaderStuckThresholdMs: deps.leaderStuckThresholdMs,
    supervisorIdleEscalateMs: deps.supervisorIdleEscalateMs,
    supervisorBusyMaxHoldMs: deps.supervisorBusyMaxHoldMs,
    permissionHardDeadlineMs: deps.permissionHardDeadlineMs,
    ruleSuggestionThreshold: deps.ruleSuggestionThreshold,
  });

  const cacheKeepalive = createMainChatCacheKeepaliveScheduler({
    agentManager: deps.agentManager,
    agentStorage: deps.agentStorage,
    store,
    turnQueue,
    getNightModeStatus: () => supervisor.getNightModeStatus(),
    listActiveConversations: async () => {
      await conversationManager.load();
      return conversationManager.listConversations({ includeArchived: false });
    },
    findMainChatAgentId: async () => (await findExistingMainChat())?.agentId ?? null,
    logger,
    now: getNowMs,
    checkIntervalMs: deps.cacheKeepaliveCheckIntervalMs,
    runner: deps.cacheKeepaliveRunner,
  });

  const routinesManager = deps.scheduleService
    ? createMainChatRoutinesManager({
        scheduleService: deps.scheduleService,
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        store,
        turnQueue,
        ensureMainChatAgentId: async () => (await ensureMainChatInternal()).agentId,
        findMainChatAgentId: async () => (await findExistingMainChat())?.agentId ?? null,
        listConversations: async () => {
          await conversationManager.load();
          return conversationManager.listConversations({ includeArchived: false });
        },
        logger,
        now: getNowMs,
      })
    : null;

  const limitFallbackController = createMainChatLimitFallbackController({
    agentManager: deps.agentManager,
    providerSnapshotManager: deps.providerSnapshotManager,
    store,
    logger,
    now: getNowMs,
    switchMainCrossProvider: async (input) => {
      const replaced = await replaceMainChatSession({
        mode: "handoff",
        requestedMainAgentId: input.mainAgentId,
        carryHandoffSummary: true,
        provider: input.targetProvider,
        model: input.targetModel ?? undefined,
      });
      return { agentId: replaced.agentId };
    },
    resumeAfterFallback: async (input) => {
      if (input.role === "main") {
        await turnQueue.enqueueBackground({
          mainAgentId: input.agentId,
          dedupeKey: `limit_fallback:resume:${input.agentId}:${input.toSpec}`,
          trigger: "limit_fallback",
          priority: 12,
          summary: `限额自动切换备用模型 ${input.fromSpec} → ${input.toSpec}`,
          requeueOnPreempt: false,
          buildPrompt: () =>
            `【限额自动切换备用模型】上一个模型（${input.fromSpec}）触发限额（${input.reason}），系统已自动切换到备用模型 ${input.toSpec}。请简要向用户同步已无缝切换并继续推进未完成事项；若无待续动作请回复简短确认。`,
        });
        return;
      }
      await sendPromptToAgent({
        agentId: input.agentId,
        prompt: `上一个模型（${input.fromSpec}）触发限额，系统已自动切换到备用模型 ${input.toSpec}，请从之前中断的位置继续完成当前任务。`,
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger,
        unarchive: false,
      });
    },
    notifyLimitFallback: (event) => {
      const fromSpec = formatProviderModel(event.fromProvider, event.fromModel);
      const toSpec = formatProviderModel(event.toProvider, event.toModel);
      supervisor.enqueueSignal({
        kind: "usage_limit_wake",
        urgency: "normal",
        agentId: event.agentId,
        serverId: deps.serverId,
        title: event.agentRole === "main" ? store.getSettings().title : event.agentId,
        summary: `触发限额，已自动切换备用模型 ${fromSpec} → ${toSpec}`,
        fingerprintSeed: `limit_fallback:${event.id}`,
        quiet: false,
      });
    },
  });

  let ensureInFlight: Promise<EnsureMainChatResult> | null = null;
  let lifecycleLock: Promise<unknown> = Promise.resolve();
  let idlePrecompactTimer: ReturnType<typeof setInterval> | null = null;
  let serviceStarted = false;
  let runtimeActive = false;
  const planLocks = new Map<string, Promise<unknown>>();

  function runWithLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = lifecycleLock.then(fn, fn);
    lifecycleLock = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function runWithPlanLock<T>(planId: string, fn: () => Promise<T>): Promise<T> {
    const previous = planLocks.get(planId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    const cleanup = next.then(
      () => undefined,
      () => undefined,
    );
    planLocks.set(planId, cleanup);
    void cleanup.finally(() => {
      if (planLocks.get(planId) === cleanup) planLocks.delete(planId);
    });
    return next;
  }

  async function resolveMainChatWorkspace(): Promise<PersistedWorkspaceRecord> {
    const homeDir = path.join(deps.paseoHome, MAIN_CHAT_WORKSPACE_DIR_NAME);
    await mkdir(homeDir, { recursive: true });
    const resolvedHome = path.resolve(homeDir);
    const existingWorkspaces = await deps.workspaceRegistry.listActive();
    const matched = existingWorkspaces.find(
      (workspace) => path.resolve(workspace.cwd) === resolvedHome,
    );
    if (matched) return matched;
    const defaultTitle = store.getSettings().title;
    return deps.createDirectoryWorkspace(homeDir, defaultTitle, undefined, {
      background: false,
    });
  }

  function resolveSnapshotDefaultProvider(homeDir: string): {
    provider: AgentProvider;
    model?: string;
    modeId?: string;
  } {
    const snapshot = deps.providerSnapshotManager.getSnapshot(homeDir);
    const available = snapshot.records
      .map((record) => record.entry)
      .find((entry) => entry.enabled && entry.status !== "unavailable");
    if (!available) {
      throw new Error("没有可用的 Agent Provider，请先在设置中配置至少一个 Provider。");
    }
    const defaultModel =
      available.models?.find((model) => model.isDefault)?.id ?? available.models?.[0]?.id;
    const defaultMode = available.defaultModeId ?? available.modes?.[0]?.id;
    return {
      provider: available.provider as AgentProvider,
      ...(defaultModel ? { model: defaultModel } : {}),
      ...(defaultMode ? { modeId: defaultMode } : {}),
    };
  }

  function trimUndefined(value: string | undefined): string | undefined {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }

  async function resolveRecentAgentProviderConfig(): Promise<{
    provider: AgentProvider;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
  } | null> {
    const storedAgents = await deps.agentStorage.listActive();
    const recentCandidate = storedAgents
      .filter((record) => !record.archivedAt && !record.background)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!recentCandidate) {
      return null;
    }
    return {
      provider: recentCandidate.provider as AgentProvider,
      model: recentCandidate.config?.model ?? recentCandidate.runtimeInfo?.model ?? undefined,
      modeId: recentCandidate.config?.modeId ?? recentCandidate.lastModeId ?? undefined,
      thinkingOptionId: recentCandidate.config?.thinkingOptionId ?? undefined,
    };
  }

  async function resolveDefaultMainChatProviderConfig(
    homeDir: string,
    requested?: EnsureMainChatInput,
  ): Promise<{
    provider: AgentProvider;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
  }> {
    const requestedModel = trimUndefined(requested?.model);
    const requestedModeId = trimUndefined(requested?.modeId);
    const requestedThinkingOptionId = trimUndefined(requested?.thinkingOptionId);
    if (requested?.provider) {
      const parsed = parseProviderSpec(requested.provider);
      return {
        provider: parsed.provider,
        model: requestedModel ?? parsed.model,
        modeId: requestedModeId,
        thinkingOptionId: requestedThinkingOptionId,
      };
    }

    const base: {
      provider: AgentProvider;
      model?: string;
      modeId?: string;
      thinkingOptionId?: string;
    } = (await resolveRecentAgentProviderConfig()) ?? resolveSnapshotDefaultProvider(homeDir);
    return {
      provider: base.provider,
      model: requestedModel ?? base.model,
      modeId: requestedModeId ?? base.modeId,
      thinkingOptionId: requestedThinkingOptionId ?? base.thinkingOptionId,
    };
  }

  async function resolvePlannedTaskLocation(
    title: string,
    workspaceIdInput: string | undefined,
    cwdInput: string | undefined,
    targetServerId?: string | null,
  ): Promise<{ workspaceId: string | null; cwd: string; workspaceLabel: string }> {
    const workspaceId = workspaceIdInput?.trim() || null;
    if (workspaceId) {
      const workspace = await deps.workspaceRegistry.get(workspaceId);
      if (!workspace) {
        throw new Error(`任务「${title}」指定的工作区不存在：${workspaceId}`);
      }
      return {
        workspaceId,
        cwd: workspace.cwd,
        workspaceLabel: workspace.title?.trim() || path.basename(workspace.cwd) || workspace.cwd,
      };
    }

    const rawCwd = cwdInput?.trim();
    if (!rawCwd) {
      throw new Error(`任务「${title}」必须指定 workspaceId 或 cwd`);
    }
    const cwd = path.resolve(expandUserPath(rawCwd));
    const isRemoteHost = Boolean(targetServerId && targetServerId !== deps.serverId);
    if (!isRemoteHost && !(await isExistingDirectory(cwd))) {
      throw new Error(`任务「${title}」指定的目录不存在：${cwd}`);
    }
    return {
      workspaceId: null,
      cwd,
      workspaceLabel: path.basename(cwd) || cwd,
    };
  }

  function resolveTaskRecordByRef(ref: {
    taskId?: string | null;
    agentId?: string | null;
    planId?: string | null;
  }): MainChatTaskRecord | null {
    const taskId = ref.taskId?.trim() || null;
    if (taskId) {
      const direct = store.getTask(taskId);
      if (direct) return direct;
      for (const plan of store.listPlans()) {
        const planned = plan.tasks.find((item) => item.id === taskId);
        if (planned?.taskRecordId) {
          const linked = store.getTask(planned.taskRecordId);
          if (linked) return linked;
        }
      }
    }
    const agentId = ref.agentId?.trim() || null;
    if (agentId) {
      const byAgent = store.findTaskByAgentId(agentId);
      if (byAgent) return byAgent;
    }
    const planId = ref.planId?.trim() || null;
    if (planId) {
      const plan = store.getPlan(planId);
      if (plan && plan.tasks.length === 1) {
        const sole = plan.tasks[0]!;
        const linkedId = sole.taskRecordId ?? sole.id;
        const byPlan = store.getTask(linkedId);
        if (byPlan) return byPlan;
      }
    }
    return null;
  }

  async function stopPreviousTaskAgent(agentId: string): Promise<void> {
    const live = deps.agentManager.getAgent(agentId);
    if (!live || live.lifecycle === "closed") {
      return;
    }
    if (typeof deps.agentManager.cancelAgentRun !== "function") {
      return;
    }
    try {
      await deps.agentManager.cancelAgentRun(agentId);
    } catch (error) {
      logger.warn(
        { err: error, agentId },
        "Failed to cancel previous running agent before task continuation",
      );
    }
  }

  async function resolveAgentProviderName(
    agentId: string | null | undefined,
    fallbackSpec?: string | null,
  ): Promise<string | null> {
    if (agentId) {
      const live = deps.agentManager.getAgent(agentId);
      if (live?.provider) return live.provider;
      const stored = await deps.agentStorage.get(agentId);
      if (stored?.provider) return stored.provider;
    }
    return fallbackSpec?.trim() || null;
  }

  function resolveTaskStartIso(task: MainChatTaskRecord): string {
    if (task.planId) {
      const plan = store.getPlan(task.planId);
      const matched = plan?.tasks.find(
        (item) => item.taskRecordId === task.id || item.id === task.id,
      );
      if (matched?.startedAt && Number.isFinite(Date.parse(matched.startedAt))) {
        return matched.startedAt;
      }
    }
    return task.createdAt;
  }

  function collectPreExistingDecisionsForTask(
    mainAgentId: string,
    taskId: string,
  ): MainChatTaskDecisionEntry[] {
    return store
      .listDecisions(mainAgentId)
      .filter((decision) => decision.taskId === taskId && decision.answeredAt && decision.answer)
      .map((decision) => ({
        id: decision.id,
        taskId,
        question: decision.question,
        answer: decision.answer!,
        decidedBy: "user" as const,
        createdAt: decision.answeredAt!,
      }))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  function taskHasOpenDecision(
    task: MainChatTaskRecord,
    openDecisions: readonly MainChatDecisionRecord[],
  ): boolean {
    return openDecisions.some((decision) => {
      if (decision.taskId) return decision.taskId === task.id;
      if (
        decision.mainAgentId !== task.mainAgentId ||
        (task.serverId && task.serverId !== deps.serverId) ||
        decision.agentId === null
      )
        return false;
      return decision.agentId === task.activeAgentId || task.agentIds.includes(decision.agentId);
    });
  }

  async function resolveStoredAgentLastStatus(agentId: string | null): Promise<string | null> {
    if (!agentId) return null;
    const stored = await deps.agentStorage.get(agentId);
    return stored?.lastStatus ?? null;
  }

  async function listTaskRecordsInternal(options?: {
    mainAgentId?: string;
    ownerAgentIds?: ReadonlySet<string>;
    conversationId?: string;
    includeCompleted?: boolean;
  }): Promise<MainChatTaskRecord[]> {
    await store.load();
    const includeCompleted = options?.includeCompleted ?? true;
    const mainAgentId = options?.mainAgentId?.trim() || undefined;
    const rawTasks = store
      .listTasks({
        mainAgentId,
        conversationId: options?.conversationId?.trim() || undefined,
        includeCompleted: true,
      })
      .filter((task) => !options?.ownerAgentIds || options.ownerAgentIds.has(task.mainAgentId));
    const allTasksById = new Map(
      store.listTasks({ includeCompleted: true }).map((entry) => [entry.id, entry]),
    );
    const openDecisions = store
      .listDecisions(mainAgentId)
      .filter((decision) => !decision.answeredAt);

    const resolved: MainChatTaskRecord[] = [];
    for (const task of rawTasks) {
      const localAgentId =
        !task.serverId || task.serverId === deps.serverId ? task.activeAgentId : null;
      const liveAgent = localAgentId ? deps.agentManager.getAgent(localAgentId) : null;
      const storedStatus = liveAgent ? null : await resolveStoredAgentLastStatus(localAgentId);
      const triage = localAgentId ? store.getTriage(localAgentId) : null;
      const effectiveStatus = resolveEffectiveTaskStatus({
        task,
        liveAgent,
        storedStatus,
        triage,
        hasOpenDecision: taskHasOpenDecision(task, openDecisions),
      });
      const isTerminal = effectiveStatus === "completed" || effectiveStatus === "cancelled";
      if (!includeCompleted && isTerminal) continue;
      const liveDependencyState = computeTaskDependencyState(task, allTasksById);
      if (effectiveStatus === task.status && liveDependencyState === task.dependencyState) {
        resolved.push(task);
      } else {
        resolved.push({
          ...task,
          status: effectiveStatus,
          dependencyState: liveDependencyState,
        });
      }
    }

    resolved.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    return resolved;
  }

  function resolveInheritedContinuationInputs(
    item: CreateMainChatPlanTaskInput,
    continuedTask: MainChatTaskRecord | null,
  ): {
    rawGoal: string;
    rawDoneWhen: string[];
    rawOutOfBounds: string[];
    effectiveServerId: string;
    hostLabel: string | null;
    workspaceIdInput: string | undefined;
    cwdInput: string | undefined;
  } {
    const trimmedDoneWhen = trimList(item.doneWhen);
    if (!continuedTask) {
      return {
        rawGoal: item.goal.trim(),
        rawDoneWhen: trimmedDoneWhen,
        rawOutOfBounds: trimList(item.outOfBounds),
        effectiveServerId: trimOptional(item.serverId) ?? deps.serverId,
        hostLabel: trimOptional(item.hostLabel),
        workspaceIdInput: item.workspaceId,
        cwdInput: item.cwd,
      };
    }

    const rawDoneWhen = trimmedDoneWhen.length > 0 ? trimmedDoneWhen : continuedTask.brief.doneWhen;
    const rawOutOfBounds =
      item.outOfBounds !== undefined ? trimList(item.outOfBounds) : continuedTask.brief.outOfBounds;
    return {
      rawGoal: item.goal.trim() || continuedTask.brief.goal,
      rawDoneWhen,
      rawOutOfBounds,
      effectiveServerId: trimOptional(item.serverId) ?? continuedTask.serverId ?? deps.serverId,
      hostLabel: trimOptional(item.hostLabel) ?? continuedTask.hostLabel ?? null,
      workspaceIdInput:
        item.workspaceId ?? (item.cwd ? undefined : (continuedTask.workspaceId ?? undefined)),
      cwdInput: item.cwd ?? (item.workspaceId ? undefined : (continuedTask.cwd ?? undefined)),
    };
  }

  async function buildPlannedTask(
    item: CreateMainChatPlanTaskInput,
    index: number,
    context: { defaultProvider: string | null },
  ): Promise<{ task: MainChatPlannedTask; autoStartEligible: boolean }> {
    const mode: MainChatTaskMode = item.mode ?? "write";
    const isolation: MainChatTaskIsolation = item.isolation ?? "local";
    const title = item.title.trim();
    if (!title) {
      throw new Error(`第 ${index + 1} 个任务缺少 title`);
    }

    const continuesTaskId = trimOptional(item.continuesTaskId);
    const continuesWhy = trimOptional(item.continuesWhy);
    const continuedTask = continuesTaskId ? store.getTask(continuesTaskId) : null;
    if (continuesTaskId && !continuedTask) {
      throw new Error(`找不到要续接的原任务：${continuesTaskId}`);
    }

    const inherited = resolveInheritedContinuationInputs(item, continuedTask);
    const validatedBrief = validateTaskBriefInput({
      title,
      goal: inherited.rawGoal,
      mode,
      doneWhen: inherited.rawDoneWhen,
      outOfBounds: inherited.rawOutOfBounds,
    });
    const location = await resolvePlannedTaskLocation(
      title,
      inherited.workspaceIdInput,
      inherited.cwdInput,
      inherited.effectiveServerId,
    );
    const defaultReason =
      mode === "readonly" ? "只读分析任务，自动在目标目录开工" : "涉及改动，建议确认后开始";
    const providerSpec = trimOptional(item.provider);
    const nowMs = getNowMs();
    const expectedMinutes = estimateExpectedMinutes(
      store.listDurationSamples(nowMs),
      {
        serverId: inherited.effectiveServerId,
        cwd: location.cwd,
        mode,
        provider: providerSpec ?? context.defaultProvider,
      },
      nowMs,
    );

    const task: MainChatPlannedTask = {
      id: makeId("task"),
      title,
      goal: validatedBrief.goal,
      mode,
      isolation,
      serverId: inherited.effectiveServerId,
      hostLabel: inherited.hostLabel,
      cwd: location.cwd,
      workspaceId: location.workspaceId,
      workspaceLabel: location.workspaceLabel,
      reason: trimOptional(item.reason) ?? defaultReason,
      doneWhen: validatedBrief.doneWhen,
      outOfBounds: validatedBrief.outOfBounds,
      provider: providerSpec,
      modeId: trimOptional(item.modeId),
      thinkingOptionId: trimOptional(item.thinkingOptionId),
      branchName: trimOptional(item.branchName),
      baseBranch: trimOptional(item.baseBranch),
      agentId: null,
      startedAt: null,
      startError: null,
      continuesTaskId,
      continuesWhy,
      expectedMinutes,
      quiet: item.quiet ?? isMainChatTasksQuiet(store.getSettings()),
      scopeRevision: continuedTask?.brief.scopeRevision ?? 1,
      taskRecordId: continuedTask?.id ?? null,
      refId: trimOptional(item.refId),
      partOf: trimOptional(item.partOf),
      after: cleanTaskIdList(item.after),
      autoStartOnReady: item.autoStartOnReady ?? false,
    };

    const autoStartEligible =
      mode === "readonly" ||
      store.hasTrustRule(location.cwd, mode, {
        serverId: inherited.effectiveServerId,
        localServerId: deps.serverId,
      });
    return { task, autoStartEligible };
  }

  async function resolvePlannedTaskLiveStatus(
    plan: MainChatPlanRecord,
    task: MainChatPlannedTask,
  ): Promise<{ status: string; pendingPermissions: number }> {
    if (!task.agentId) {
      return { status: task.startError ? "start_failed" : plan.status, pendingPermissions: 0 };
    }
    const live = deps.agentManager.getAgent(task.agentId);
    if (live) {
      const pendingPermissions = live.pendingPermissions.size;
      return {
        status: pendingPermissions > 0 ? "needs_permission" : live.lifecycle,
        pendingPermissions,
      };
    }
    const stored = await deps.agentStorage.get(task.agentId);
    const status = stored?.archivedAt ? "archived" : (stored?.lastStatus ?? "closed");
    return { status, pendingPermissions: 0 };
  }

  async function findExistingMainChat(): Promise<EnsureMainChatResult | null> {
    const liveAgents = deps.agentManager.listAgents();
    const liveMain = liveAgents.find(
      (agent) => !agent.background && isMainChatLabels(agent.labels),
    );
    if (liveMain?.workspaceId) {
      return { agentId: liveMain.id, workspaceId: liveMain.workspaceId, created: false };
    }

    const storedAgents = await deps.agentStorage.listActive();
    const storedMain = storedAgents
      .filter(
        (record) => !record.archivedAt && !record.background && isMainChatLabels(record.labels),
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (storedMain) {
      const workspaceId = storedMain.workspaceId ?? (await resolveMainChatWorkspace()).workspaceId;
      return { agentId: storedMain.id, workspaceId, created: false };
    }
    return null;
  }

  async function resolveCurrentAgentTitle(agentId: string): Promise<string | null> {
    const stored = await deps.agentStorage.get(agentId);
    const storedTitle = stored?.title?.trim();
    if (storedTitle) {
      return storedTitle;
    }
    const live = deps.agentManager.getAgent(agentId);
    return live?.config?.title?.trim() || null;
  }

  async function resolveMainChatWorkspaceRecord(
    mainWorkspaceId: string | null,
  ): Promise<PersistedWorkspaceRecord | null> {
    if (mainWorkspaceId) {
      return deps.workspaceRegistry.get(mainWorkspaceId);
    }
    const resolvedHome = path.resolve(path.join(deps.paseoHome, MAIN_CHAT_WORKSPACE_DIR_NAME));
    const workspaces = await deps.workspaceRegistry.listActive();
    return workspaces.find((workspace) => path.resolve(workspace.cwd) === resolvedHome) ?? null;
  }

  async function syncMainChatWorkspaceTitle(
    mainWorkspaceId: string | null,
    desiredTitle: string,
    force: boolean,
  ): Promise<void> {
    if (!deps.workspaceRegistry.update) return;
    const targetWorkspace = await resolveMainChatWorkspaceRecord(mainWorkspaceId);
    if (!targetWorkspace) return;
    if (!force && targetWorkspace.title?.trim() === desiredTitle) return;

    try {
      const updatedWorkspace = await deps.workspaceRegistry.update(
        targetWorkspace.workspaceId,
        (record) => {
          if (!force && record.title?.trim() === desiredTitle) {
            return record;
          }
          return {
            ...record,
            title: desiredTitle,
            updatedAt: new Date().toISOString(),
          };
        },
      );
      if (updatedWorkspace && deps.emitWorkspaceUpdates) {
        await deps.emitWorkspaceUpdates([targetWorkspace.workspaceId]);
      }
    } catch (error) {
      logger.warn(
        { err: error, workspaceId: targetWorkspace.workspaceId },
        "Failed to sync steward title to workspace record",
      );
    }
  }

  async function syncMainChatTitlesToSettings(
    target?: Pick<EnsureMainChatResult, "agentId" | "workspaceId"> | null,
    options?: { force?: boolean },
  ): Promise<void> {
    const desiredTitle = store.getSettings().title?.trim();
    if (!desiredTitle) return;

    const force = options?.force === true;
    const existing = target ?? (await findExistingMainChat());

    if (existing) {
      const currentAgentTitle = await resolveCurrentAgentTitle(existing.agentId);
      if (force || currentAgentTitle !== desiredTitle) {
        try {
          await deps.agentManager.updateAgentMetadata(existing.agentId, {
            title: desiredTitle,
          });
        } catch (error) {
          logger.warn(
            { err: error, agentId: existing.agentId },
            "Failed to sync steward title to agent metadata",
          );
        }
      }
    }

    await syncMainChatWorkspaceTitle(existing?.workspaceId ?? null, desiredTitle, force);

    if (existing) {
      try {
        await conversationManager.load();
        await conversationManager.ensureMainConversationRecord({
          agentId: existing.agentId,
          workspaceId: existing.workspaceId,
          title: desiredTitle,
          serverId: deps.serverId,
        });
      } catch (error) {
        logger.warn(
          { err: error, agentId: existing.agentId },
          "Failed to sync steward title to conversation record",
        );
      }
    }
  }

  async function ensureMainChatInternal(
    input?: EnsureMainChatInput,
  ): Promise<EnsureMainChatResult> {
    await store.load();
    if (!isMainChatEnabled(store.getSettings())) {
      throw new Error("主对话功能已在设置中关闭，请先开启后再使用");
    }
    const existing = await findExistingMainChat();
    if (existing) {
      await syncMainChatTitlesToSettings(existing);
      return existing;
    }

    const workspace = await resolveMainChatWorkspace();
    const currentSettings = store.getSettings();
    const stewardTitle = currentSettings.title;
    const providerConfig = await resolveDefaultMainChatProviderConfig(workspace.cwd, input);
    const { snapshot } = await createAgentCommand(
      {
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        finishSubscriptions: deps.finishSubscriptions?.(),
        logger,
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
        terminalManager: deps.terminalManager,
        providerSnapshotManager: deps.providerSnapshotManager,
        createPaseoWorktree: deps.createPaseoWorktree,
        ensureWorkspaceForCreate: deps.ensureWorkspaceForCreate,
      },
      {
        kind: "session",
        config: {
          provider: providerConfig.provider,
          cwd: workspace.cwd,
          title: stewardTitle,
          ...(providerConfig.model ? { model: providerConfig.model } : {}),
          ...(providerConfig.modeId ? { modeId: providerConfig.modeId } : {}),
          ...(providerConfig.thinkingOptionId
            ? { thinkingOptionId: providerConfig.thinkingOptionId }
            : {}),
        },
        workspaceId: workspace.workspaceId,
        background: false,
        labels: {
          [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE,
        },
        provisionalTitle: stewardTitle,
        firstAgentContext: {},
      },
    );

    if (currentSettings.capabilities.initialBriefingEnabled) {
      void contextSnapshots
        .collectFleet(snapshot.id)
        .then((fleet) => {
          if (fleet.totalActive > 0) {
            return supervisor.dispatchInitialBriefing(snapshot.id);
          }
          return false;
        })
        .catch((error) => {
          logger.warn({ err: error, agentId: snapshot.id }, "Initial briefing dispatch failed");
        });
    }

    const createdTarget = {
      agentId: snapshot.id,
      workspaceId: snapshot.workspaceId ?? workspace.workspaceId,
    };
    await syncMainChatTitlesToSettings(createdTarget);

    return {
      agentId: createdTarget.agentId,
      workspaceId: createdTarget.workspaceId,
      created: true,
    };
  }

  async function resolveMainAgentSnapshot(mainAgentId: string): Promise<{
    provider: string;
    model: string | null;
    modeId: string | null;
    thinkingOptionId: string | null;
    cwd: string;
  }> {
    const live: ManagedAgent | null = deps.agentManager.getAgent(mainAgentId);
    if (live) {
      return {
        provider: live.provider,
        model: live.config.model ?? live.runtimeInfo?.model ?? null,
        modeId: live.currentModeId ?? live.config.modeId ?? null,
        thinkingOptionId: live.config.thinkingOptionId ?? null,
        cwd: live.cwd,
      };
    }
    const stored = await deps.agentStorage.get(mainAgentId);
    if (!stored) {
      throw new Error(`找不到主对话 Agent：${mainAgentId}`);
    }
    return {
      provider: stored.provider,
      model: stored.config?.model ?? stored.runtimeInfo?.model ?? null,
      modeId: stored.config?.modeId ?? stored.lastModeId ?? null,
      thinkingOptionId: stored.config?.thinkingOptionId ?? null,
      cwd: stored.cwd,
    };
  }

  async function resolveTaskWorkspaceTarget(
    task: MainChatPlannedTask,
  ): Promise<{ workspaceId: string; cwd: string }> {
    if (task.isolation === "worktree") {
      if (!deps.createPaseoWorktree) {
        throw new Error("当前 Daemon 未启用 worktree 创建能力");
      }
      let sourceCwd = task.cwd;
      if (!sourceCwd && task.workspaceId) {
        const ws = await deps.workspaceRegistry.get(task.workspaceId);
        sourceCwd = ws?.cwd ?? null;
      }
      if (!sourceCwd) {
        throw new Error(`任务「${task.title}」缺少 worktree 源目录`);
      }
      const worktreeResult = await createPaseoWorktreeCommand(
        {
          paseoHome: deps.paseoHome,
          worktreesRoot: deps.worktreesRoot,
          createPaseoWorktreeWorkflow: deps.createPaseoWorktree,
        },
        {
          cwd: sourceCwd,
          action: "branch-off",
          ...(task.branchName ? { branchName: task.branchName } : {}),
          ...(task.baseBranch ? { refName: task.baseBranch } : {}),
          title: task.title,
          background: false,
        },
      );
      if (!worktreeResult.ok) {
        throw worktreeResult.cause;
      }
      return {
        workspaceId: worktreeResult.createdWorktree.workspace.workspaceId,
        cwd: worktreeResult.createdWorktree.workspace.cwd,
      };
    }

    if (task.workspaceId) {
      const existing = await deps.workspaceRegistry.get(task.workspaceId);
      if (existing) {
        return { workspaceId: existing.workspaceId, cwd: existing.cwd };
      }
    }

    if (!task.cwd) {
      throw new Error(`任务「${task.title}」未指定目录或工作区`);
    }
    const resolvedCwd = path.resolve(task.cwd);
    const activeWorkspaces = await deps.workspaceRegistry.listActive();
    const matched = activeWorkspaces.find(
      (workspace) => !workspace.background && path.resolve(workspace.cwd) === resolvedCwd,
    );
    if (matched) {
      return { workspaceId: matched.workspaceId, cwd: matched.cwd };
    }
    const created = await deps.createDirectoryWorkspace(resolvedCwd, undefined, undefined, {
      background: false,
    });
    return { workspaceId: created.workspaceId, cwd: created.cwd };
  }

  function buildTaskAgentLabels(input: {
    plan: MainChatPlanRecord;
    task: MainChatPlannedTask;
    resolvedTaskRecordId: string;
    effectiveGoal: string;
  }): Record<string, string> {
    const labels: Record<string, string> = {
      [PARENT_AGENT_ID_LABEL]: input.plan.mainAgentId,
      [PARENT_SERVER_ID_LABEL]: deps.serverId,
      [MAIN_CHAT_TASK_PLAN_ID_LABEL]: input.plan.id,
      [MAIN_CHAT_TASK_ID_LABEL]: input.task.id,
      [MAIN_CHAT_TASK_RECORD_ID_LABEL]: input.resolvedTaskRecordId,
      [MAIN_CHAT_TASK_MODE_LABEL]: input.task.mode,
      [MAIN_CHAT_TASK_GOAL_LABEL]: input.effectiveGoal.slice(0, 200),
      [MAIN_CHAT_TASK_QUIET_LABEL]: input.task.quiet === false ? "false" : "true",
    };
    if (input.plan.conversationId) {
      labels[MAIN_CHAT_CONVERSATION_ID_LABEL] = input.plan.conversationId;
    }
    return labels;
  }

  async function persistSpawnedTaskRecord(input: {
    plan: MainChatPlanRecord;
    task: MainChatPlannedTask;
    continuedTask: MainChatTaskRecord | null;
    existingRecord: MainChatTaskRecord | null;
    resolvedTaskRecordId: string;
    preExistingDecisions: MainChatTaskDecisionEntry[];
    agentId: string;
    cwd: string;
    workspaceId: string | null;
    provider?: string | null;
    model?: string | null;
    thinkingOptionId?: string | null;
    nowIso: string;
  }): Promise<void> {
    const targetToAttach = input.continuedTask ?? input.existingRecord;
    if (targetToAttach) {
      const updatedRecord = attachContinuationAgentToTask(targetToAttach, {
        planId: input.plan.id,
        newAgentId: input.agentId,
        cwd: input.cwd,
        workspaceId: input.workspaceId,
        workspaceLabel: input.task.workspaceLabel,
        serverId: input.task.serverId ?? deps.serverId,
        hostLabel: input.task.hostLabel ?? null,
        continuesWhy: input.continuedTask ? (input.task.continuesWhy ?? null) : null,
        nowIso: input.nowIso,
      });
      await store.putTask({
        ...updatedRecord,
        lastProvider: input.provider ?? updatedRecord.lastProvider ?? null,
        lastModel: input.model !== undefined ? input.model : (updatedRecord.lastModel ?? null),
        lastThinkingOptionId:
          input.thinkingOptionId !== undefined
            ? input.thinkingOptionId
            : (updatedRecord.lastThinkingOptionId ?? null),
        lastRuleDiagnostic: null,
        admissionState: null,
      });
      await store.removeAdmissionEntriesByTaskId(updatedRecord.id);
      return;
    }

    const createdRecord = createTaskRecordFromPlannedTask({
      id: input.resolvedTaskRecordId,
      mainAgentId: input.plan.mainAgentId,
      conversationId: input.plan.conversationId ?? null,
      planId: input.plan.id,
      plannedTask: input.task,
      agentId: input.agentId,
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      serverId: input.task.serverId ?? deps.serverId,
      hostLabel: input.task.hostLabel ?? null,
      nowIso: input.nowIso,
    });
    if (input.preExistingDecisions.length > 0) {
      createdRecord.decisions = input.preExistingDecisions;
    }
    await store.putTask({
      ...createdRecord,
      lastProvider: input.provider ?? null,
      lastModel: input.model ?? null,
      lastThinkingOptionId: input.thinkingOptionId ?? null,
      lastRuleDiagnostic: null,
    });
  }

  function resolveDirectionNotesForPlan(
    conversationId: string | null | undefined,
  ): { title: string; notes: string } | null {
    if (!conversationId) return null;
    const conv = conversationManager.getConversation(conversationId);
    if (!conv?.notes?.trim()) return null;
    return { title: conv.title, notes: conv.notes };
  }

  function buildProjectLessonsBlockForSpawn(
    task: MainChatPlannedTask,
    projectContext: ProjectLessonTargetContext | undefined,
  ): string | null {
    if (!isMainChatTaskLessonsEnabled(store.getSettings())) return null;
    const effectiveCwd = projectContext?.cwd ?? task.cwd;
    if (!effectiveCwd) return null;
    const built = lessonsStore.buildDispatchBlockForProject({
      cwd: effectiveCwd,
      projectRoot: projectContext?.projectRoot,
      remoteUrl: projectContext?.remoteUrl,
      projectLabel: projectContext?.projectLabel ?? task.workspaceLabel,
    });
    return built.text || null;
  }

  function prepareSpawnTaskPromptAndLabels(input: {
    plan: MainChatPlanRecord;
    task: MainChatPlannedTask;
    continuedTask: MainChatTaskRecord | null;
    previousAgentId: string | null;
    projectContext?: ProjectLessonTargetContext;
  }): {
    resolvedTaskRecordId: string;
    existingRecord: MainChatTaskRecord | null;
    preExistingDecisions: MainChatTaskDecisionEntry[];
    initialPrompt: string;
    labels: Record<string, string>;
    title: string;
  } {
    const { plan, task, continuedTask, previousAgentId, projectContext } = input;
    const resolvedTaskRecordId = continuedTask ? continuedTask.id : (task.taskRecordId ?? task.id);
    const existingRecord = continuedTask ?? store.getTask(resolvedTaskRecordId);
    const preExistingDecisions =
      existingRecord?.decisions ??
      collectPreExistingDecisionsForTask(plan.mainAgentId, resolvedTaskRecordId);
    const continuesFrom = continuedTask
      ? {
          taskId: continuedTask.id,
          reason: task.continuesWhy ?? null,
          previousAgentId,
        }
      : null;

    return {
      resolvedTaskRecordId,
      existingRecord,
      preExistingDecisions,
      initialPrompt: buildWorkerInitialPrompt(task, {
        brief: existingRecord?.brief ?? null,
        decisions: preExistingDecisions,
        directionNotes: resolveDirectionNotesForPlan(plan.conversationId),
        projectLessonsBlock: buildProjectLessonsBlockForSpawn(task, projectContext),
        continuesFrom,
      }),
      labels: buildTaskAgentLabels({
        plan,
        task,
        resolvedTaskRecordId,
        effectiveGoal: continuedTask ? continuedTask.brief.goal : task.goal,
      }),
      title: continuedTask ? continuedTask.title : task.title,
    };
  }

  async function dispatchRemotePlannedTask(input: {
    serverId: string;
    providerSpec: string;
    plan: MainChatPlanRecord;
    task: MainChatPlannedTask;
    continuedTask: MainChatTaskRecord | null;
    prepared: ReturnType<typeof prepareSpawnTaskPromptAndLabels>;
    mainAgent: {
      modeId: string | null;
      thinkingOptionId: string | null;
    };
  }): Promise<{ agentId: string; workspaceId: string | null; cwd: string }> {
    const { serverId, providerSpec, plan, task, continuedTask, prepared, mainAgent } = input;
    const parsedRemoteProvider = parseProviderSpec(providerSpec);
    const remoteResult = await fleetBridge.dispatchTaskToTargetHost({
      serverId,
      cwd: task.cwd?.trim() || ".",
      title: prepared.title,
      provider: parsedRemoteProvider.provider,
      model: parsedRemoteProvider.model ?? null,
      modeId: task.modeId ?? mainAgent.modeId ?? null,
      thinkingOptionId: task.thinkingOptionId ?? mainAgent.thinkingOptionId ?? null,
      initialPrompt: prepared.initialPrompt,
      workspaceId: task.workspaceId ?? undefined,
      isolation: task.isolation,
      baseBranch: task.baseBranch ?? undefined,
      branchName: task.branchName ?? undefined,
      mainAgentId: plan.mainAgentId,
      planId: plan.id,
      taskId: task.id,
      taskRecordId: prepared.resolvedTaskRecordId,
      mode: task.mode,
      goal: continuedTask ? continuedTask.brief.goal : task.goal,
      quiet: task.quiet,
      labels: prepared.labels,
    });
    return {
      agentId: remoteResult.agentId,
      workspaceId: remoteResult.workspaceId,
      cwd: remoteResult.cwd,
    };
  }

  async function dispatchPreparedPlannedTask(input: {
    plan: MainChatPlanRecord;
    task: MainChatPlannedTask;
    continuedTask: MainChatTaskRecord | null;
    prepared: ReturnType<typeof prepareSpawnTaskPromptAndLabels>;
    mainAgent: {
      provider: string;
      model: string | null;
      modeId: string | null;
      thinkingOptionId: string | null;
    };
  }): Promise<{
    agentId: string;
    workspaceId: string | null;
    cwd: string;
    provider: string;
    model: string | null;
    thinkingOptionId: string | null;
  }> {
    const { plan, task, continuedTask, prepared, mainAgent } = input;
    const slotResolution = resolveSlotModelForDispatch({
      purpose: task.mode === "readonly" ? "subagentReadonly" : "subagentDefault",
      settings: store.getSettings(),
      liveMainBinding: {
        provider: mainAgent.provider,
        model: mainAgent.model,
        thinkingOptionId: mainAgent.thinkingOptionId,
      },
    });
    const providerSpec =
      task.provider ??
      slotResolution.providerSpec ??
      formatProviderModel(mainAgent.provider, mainAgent.model);
    const parsedEffective = parseProviderSpec(providerSpec);
    const effectiveThinking =
      task.thinkingOptionId ??
      slotResolution.thinkingOptionId ??
      mainAgent.thinkingOptionId ??
      null;

    if (task.serverId && task.serverId !== deps.serverId) {
      const remoteDispatched = await dispatchRemotePlannedTask({
        serverId: task.serverId,
        providerSpec,
        plan,
        task,
        continuedTask,
        prepared,
        mainAgent: {
          modeId: mainAgent.modeId,
          thinkingOptionId: effectiveThinking,
        },
      });
      return {
        ...remoteDispatched,
        provider: parsedEffective.provider,
        model: parsedEffective.model ?? null,
        thinkingOptionId: effectiveThinking,
      };
    }

    const target = await resolveTaskWorkspaceTarget(task);
    const { snapshot } = await createAgentCommand(
      {
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        finishSubscriptions: deps.finishSubscriptions?.(),
        logger,
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
        terminalManager: deps.terminalManager,
        providerSnapshotManager: deps.providerSnapshotManager,
        createPaseoWorktree: deps.createPaseoWorktree,
        ensureWorkspaceForCreate: deps.ensureWorkspaceForCreate,
      },
      {
        kind: "mcp",
        provider: providerSpec,
        title: prepared.title,
        initialPrompt: prepared.initialPrompt,
        cwd: target.cwd,
        workspaceId: target.workspaceId,
        thinking: effectiveThinking ?? undefined,
        mode: task.modeId ?? mainAgent.modeId ?? undefined,
        labels: prepared.labels,
        promptFailure: "throw",
        notifyOnFinish: true,
        background: false,
        detached: false,
        callerAgentId: plan.mainAgentId,
      },
    );
    return {
      agentId: snapshot.id,
      workspaceId: snapshot.workspaceId ?? target.workspaceId,
      cwd: target.cwd,
      provider: parsedEffective.provider,
      model: parsedEffective.model ?? null,
      thinkingOptionId: effectiveThinking,
    };
  }

  async function resolveWorkspaceCwdForTask(input: {
    cwd?: string | null;
    workspaceId?: string | null;
  }): Promise<string | null> {
    const trimmed = trimOptional(input.cwd);
    if (trimmed) return trimmed;
    if (input.workspaceId) {
      const workspace = await deps.workspaceRegistry.get(input.workspaceId).catch(() => null);
      if (workspace?.cwd?.trim()) {
        return workspace.cwd.trim();
      }
    }
    return null;
  }

  async function resolveProjectLessonContext(input: {
    cwd?: string | null;
    workspaceId?: string | null;
    workspaceLabel?: string | null;
  }): Promise<ProjectLessonTargetContext> {
    const resolvedCwd = await resolveWorkspaceCwdForTask({
      cwd: input.cwd,
      workspaceId: input.workspaceId,
    });
    const snapshot =
      resolvedCwd && deps.workspaceGitService
        ? await deps.workspaceGitService.getSnapshot(resolvedCwd).catch(() => null)
        : null;
    return {
      cwd: resolvedCwd ?? snapshot?.cwd ?? null,
      projectRoot: snapshot?.git.mainRepoRoot ?? snapshot?.git.repoRoot ?? snapshot?.cwd ?? null,
      remoteUrl: snapshot?.git.remoteUrl ?? null,
      projectLabel: input.workspaceLabel ?? null,
    };
  }

  function resolvePlanBatchDagLinks(tasks: MainChatPlannedTask[]): MainChatPlannedTask[] {
    const refMap = new Map<string, string>();
    for (const task of tasks) {
      const targetId = task.taskRecordId ?? task.id;
      refMap.set(task.id, targetId);
      const refId = trimOptional(task.refId);
      if (refId) {
        if (refMap.has(refId)) {
          throw new Error(`同一任务计划中存在重复的 refId：${refId}`);
        }
        refMap.set(refId, targetId);
      }
    }

    const resolveRef = (raw: string | null | undefined): string | null => {
      const trimmed = trimOptional(raw);
      if (!trimmed) return null;
      return refMap.get(trimmed) ?? trimmed;
    };

    const resolvedTasks = tasks.map((task) => {
      const partOf = resolveRef(task.partOf);
      const after = cleanTaskIdList((task.after ?? []).map((id) => resolveRef(id) ?? id));
      return {
        ...task,
        partOf,
        after,
      };
    });

    const hasAnyDagLinks = resolvedTasks.some(
      (task) => Boolean(task.partOf) || (task.after?.length ?? 0) > 0,
    );
    if (!hasAnyDagLinks) {
      return resolvedTasks;
    }

    const existingTasks = store.listTasks({ includeCompleted: true });
    const normalizedLinks = validateTaskDagBatch(
      existingTasks,
      resolvedTasks.map((task) => ({
        id: task.taskRecordId ?? task.id,
        partOf: task.partOf ?? null,
        after: task.after ?? [],
      })),
    );

    const updatedTasks: MainChatPlannedTask[] = [];
    for (const task of resolvedTasks) {
      const targetId = task.taskRecordId ?? task.id;
      const normalized = normalizedLinks.get(targetId);
      updatedTasks.push({
        ...task,
        partOf: normalized?.partOf ?? null,
        after: normalized?.after ?? [],
      });
    }
    return updatedTasks;
  }

  async function applyTaskDeliveryGate(
    task: MainChatTaskRecord,
    nextGate: MainChatTaskDeliveryGate,
    nowIso: string,
  ): Promise<{ task: MainChatTaskRecord; prJustMerged: boolean }> {
    const transitions = diffDeliveryGateTransitions({
      task,
      previous: task.deliveryGate,
      next: nextGate,
      notifiedKeys: deliveryNotifiedKeys,
      defaultServerId: deps.serverId,
    });

    const updatedTask: MainChatTaskRecord = {
      ...task,
      deliveryGate: nextGate,
      updatedAt: nowIso,
      lastActivityAt: nowIso,
    };
    await store.putTask(updatedTask);

    let prJustMerged = false;
    for (const transition of transitions) {
      if (transition.prJustMerged) {
        prJustMerged = true;
      }
      supervisor.enqueueSignal({
        kind: transition.kind,
        urgency: transition.urgency,
        taskId: transition.taskId,
        agentId: transition.agentId,
        serverId: transition.serverId,
        conversationId: transition.conversationId,
        title: transition.title,
        summary: transition.summary,
        fingerprintSeed: transition.fingerprintSeed,
        quiet: transition.quiet,
      });
    }

    if (prJustMerged) {
      await evaluateDagProgressAfterTaskChange(updatedTask, nowIso);
    }

    return { task: updatedTask, prJustMerged };
  }

  function isSameDeliveryGate(
    left: MainChatTaskDeliveryGate | null | undefined,
    right: MainChatTaskDeliveryGate | null | undefined,
  ): boolean {
    if (!left && !right) return true;
    if (!left || !right) return false;
    return (
      left.prUrl === right.prUrl &&
      left.prNumber === right.prNumber &&
      left.branch === right.branch &&
      left.prState === right.prState &&
      left.isDraft === right.isDraft &&
      left.hasConflict === right.hasConflict &&
      left.ciStatus === right.ciStatus &&
      left.ciSummary === right.ciSummary &&
      left.reviewDecision === right.reviewDecision &&
      left.headOid === right.headOid &&
      left.gateStatus === right.gateStatus &&
      left.followUpActive === right.followUpActive &&
      left.blockingReasons.join("|") === right.blockingReasons.join("|")
    );
  }

  async function handleWorkspaceGitSnapshotInternal(
    snapshot: WorkspaceGitRuntimeSnapshot,
  ): Promise<number> {
    await store.load();
    const candidates = matchTasksForGitSnapshot(
      store.listTasks({ includeCompleted: true }),
      snapshot,
    );
    if (candidates.length === 0) return 0;

    const nowIso = new Date(getNowMs()).toISOString();
    let updatedCount = 0;
    for (const task of candidates) {
      const nextGate = buildDeliveryGateFromGitSnapshot({
        snapshot,
        existing: task.deliveryGate,
        nowIso,
      });
      if (!nextGate) continue;
      if (isSameDeliveryGate(task.deliveryGate, nextGate)) {
        continue;
      }
      await applyTaskDeliveryGate(task, nextGate, nowIso);
      updatedCount += 1;
    }

    if (updatedCount > 0) {
      contextSnapshots.invalidateCache();
    }
    return updatedCount;
  }

  async function sweepTaskDeliveryGatesInternal(_nowMs: number): Promise<number> {
    if (!deps.workspaceGitService) return 0;
    await store.load();
    const cwds = new Set<string>();
    for (const task of store.listTasks({ includeCompleted: true })) {
      if (task.status === "cancelled") continue;
      if (task.status !== "completed" || task.deliveryGate?.followUpActive) {
        const cwd = await resolveWorkspaceCwdForTask({
          cwd: task.cwd,
          workspaceId: task.workspaceId,
        });
        if (cwd) {
          cwds.add(cwd);
        }
      }
    }
    let totalUpdated = 0;
    for (const cwd of cwds) {
      const snapshot = await deps.workspaceGitService.getSnapshot(cwd).catch(() => null);
      if (!snapshot) continue;
      totalUpdated += await handleWorkspaceGitSnapshotInternal(snapshot);
    }
    return totalUpdated;
  }

  async function discoverTaskPrFromReply(agentId: string, replyText: string): Promise<void> {
    const extracted = extractPrUrlFromText(replyText);
    if (!extracted) return;
    await store.load();
    const linkedTask = store.findTaskByAgentId(agentId);
    if (!linkedTask) return;

    const nowIso = new Date(getNowMs()).toISOString();
    const resolvedCwd = await resolveWorkspaceCwdForTask({
      cwd: linkedTask.cwd,
      workspaceId: linkedTask.workspaceId,
    });
    const snapshot =
      resolvedCwd && deps.workspaceGitService
        ? await deps.workspaceGitService.getSnapshot(resolvedCwd).catch(() => null)
        : null;
    const fromSnapshot = snapshot
      ? buildDeliveryGateFromGitSnapshot({
          snapshot,
          existing: linkedTask.deliveryGate,
          nowIso,
        })
      : null;
    const nextGate =
      fromSnapshot ??
      buildDeliveryGateFromDiscoveredPrUrl({
        prUrl: extracted.prUrl,
        prNumber: extracted.prNumber,
        existing: linkedTask.deliveryGate,
        nowIso,
      });
    if (!isSameDeliveryGate(linkedTask.deliveryGate, nextGate)) {
      await applyTaskDeliveryGate(linkedTask, nextGate, nowIso);
      contextSnapshots.invalidateCache();
    }
  }

  function buildSyntheticPlanForReadyTask(
    existing: MainChatTaskRecord,
    nowIso: string,
  ): MainChatPlanRecord {
    return {
      id: existing.planId ?? makeId("plan"),
      mainAgentId: existing.mainAgentId,
      conversationId: existing.conversationId ?? null,
      status: "started",
      autoStarted: false,
      summary: existing.title,
      createdAt: existing.createdAt,
      startedAt: nowIso,
      cancelledAt: null,
      withdrawnAt: null,
      withdrawReason: null,
      tasks: [],
    };
  }

  function buildSyntheticPlannedTaskForReadyTask(
    existing: MainChatTaskRecord,
  ): MainChatPlannedTask {
    return {
      id: existing.id,
      title: existing.title,
      goal: existing.brief.goal,
      mode: existing.mode,
      isolation: existing.isolation,
      serverId: existing.serverId ?? deps.serverId,
      hostLabel: existing.hostLabel ?? null,
      cwd: existing.cwd,
      workspaceId: existing.workspaceId,
      workspaceLabel: existing.workspaceLabel,
      doneWhen: existing.brief.doneWhen,
      outOfBounds: existing.brief.outOfBounds,
      provider: null,
      modeId: null,
      thinkingOptionId: null,
      branchName: null,
      baseBranch: null,
      reason: "前置依赖已满足，启动下游任务",
      agentId: null,
      startedAt: null,
      startError: null,
      expectedMinutes: existing.expectedMinutes ?? null,
      continuesTaskId: existing.continuesTaskId ?? null,
      continuesWhy: existing.continuesWhy ?? null,
      quiet: existing.quiet ?? true,
      scopeRevision: existing.brief.scopeRevision,
      taskRecordId: existing.id,
      refId: null,
      partOf: existing.partOf ?? null,
      after: existing.after ?? [],
      autoStartOnReady: existing.autoStartOnReady ?? false,
    };
  }

  function readAvailableProvidersForModelValidation(cwd?: string): AvailableProviderInfo[] {
    try {
      const targetCwd = cwd ?? path.join(deps.paseoHome, MAIN_CHAT_WORKSPACE_DIR_NAME);
      const snapshot = deps.providerSnapshotManager.getSnapshot(targetCwd);
      if (!snapshot?.records || snapshot.records.length === 0) {
        return [];
      }
      return snapshot.records.map((record) => ({
        provider: record.entry.provider,
        enabled: record.entry.enabled !== false,
      }));
    } catch {
      return [];
    }
  }

  async function startReadyTaskInternal(
    taskId: string,
  ): Promise<{ task: MainChatTaskRecord; plan: MainChatPlanRecord | null }> {
    await store.load();
    await lessonsStore.load();
    const existing = resolveTaskRecordByRef({ taskId });
    if (!existing) {
      throw new Error(`找不到要启动的就绪任务：${taskId}`);
    }
    if (existing.status === "completed" || existing.status === "cancelled") {
      throw new Error(`任务「${existing.title}」已结束（${existing.status}），无法启动`);
    }
    if (existing.activeAgentId) {
      throw new Error(
        `任务「${existing.title}」已有正在运行的子 Agent（${existing.activeAgentId}）`,
      );
    }

    const allTasksById = new Map(
      store.listTasks({ includeCompleted: true }).map((entry) => [entry.id, entry]),
    );
    if (computeTaskDependencyState(existing, allTasksById) === "blocked") {
      const pendingDeps = (existing.after ?? [])
        .map((depId) => {
          const dep = allTasksById.get(depId);
          return dep ? `${dep.title}（${dep.id}）` : depId;
        })
        .join("、");
      throw new Error(`任务「${existing.title}」的前置依赖尚未完成：${pendingDeps}`);
    }

    const nowIso = new Date(getNowMs()).toISOString();
    const mainAgent = await resolveMainAgentSnapshot(existing.mainAgentId);
    const linkedPlan = existing.planId ? store.getPlan(existing.planId) : null;
    const matchedPlannedTask = linkedPlan?.tasks.find(
      (item) => item.taskRecordId === existing.id || item.id === existing.id,
    );
    const spawnedTask = await spawnSinglePlannedTask({
      plan: linkedPlan ?? buildSyntheticPlanForReadyTask(existing, nowIso),
      task: matchedPlannedTask ?? buildSyntheticPlannedTaskForReadyTask(existing),
      mainAgent,
      nowIso,
    });

    let updatedPlan: MainChatPlanRecord | null = null;
    if (linkedPlan && matchedPlannedTask) {
      updatedPlan = {
        ...linkedPlan,
        status: "started",
        startedAt: linkedPlan.startedAt ?? nowIso,
        tasks: linkedPlan.tasks.map((item) =>
          item.id === matchedPlannedTask.id ? spawnedTask : item,
        ),
      };
      await store.putPlan(updatedPlan);
    }

    const refreshed = store.getTask(existing.id) ?? existing;
    contextSnapshots.invalidateCache();
    return { task: refreshed, plan: updatedPlan };
  }

  async function evaluateDagProgressAfterTaskChange(
    changedTask: MainChatTaskRecord,
    nowIso: string,
  ): Promise<void> {
    const allTasks = store.listTasks({ includeCompleted: true });
    const newlyReady = findNewlyReadyDownstreamTasks({
      allTasks,
      changedTaskId: changedTask.id,
    });

    for (const candidate of newlyReady) {
      if (candidate.task.dependencyState !== "ready") {
        await store.putTask({
          ...candidate.task,
          dependencyState: "ready",
          updatedAt: nowIso,
          lastActivityAt: nowIso,
        });
      }

      if (!deliveryNotifiedKeys.has(candidate.wakeKey)) {
        deliveryNotifiedKeys.add(candidate.wakeKey);
        const prereqSummary = candidate.satisfiedPrerequisites
          .map((item) => (item.prUrl ? `「${item.title}」(${item.prUrl})` : `「${item.title}」`))
          .join("、");
        supervisor.enqueueSignal({
          kind: "todo_ready",
          urgency: "normal",
          taskId: candidate.task.id,
          agentId: null,
          serverId: candidate.task.serverId ?? deps.serverId,
          conversationId: candidate.task.conversationId ?? null,
          title: candidate.task.title,
          summary: candidate.task.autoStartOnReady
            ? `前置任务 ${prereqSummary} 已满足，下游任务已自动拉起执行`
            : `前置任务 ${prereqSummary} 已满足，下游任务已解锁就绪，可一键启动`,
          fingerprintSeed: candidate.wakeKey,
          quiet: candidate.task.quiet !== false,
        });
      }

      if (candidate.task.autoStartOnReady) {
        try {
          await startReadyTaskInternal(candidate.task.id);
        } catch (error) {
          logger.warn(
            { err: error, taskId: candidate.task.id },
            "Failed to auto-start ready downstream task",
          );
        }
      }
    }

    const closeout = checkParentCloseoutCandidate({
      allTasks: store.listTasks({ includeCompleted: true }),
      completedChild: changedTask,
    });
    if (closeout && !deliveryNotifiedKeys.has(closeout.wakeKey)) {
      deliveryNotifiedKeys.add(closeout.wakeKey);
      const childSummary = closeout.children.map((child) => `「${child.title}」`).join("、");
      supervisor.enqueueSignal({
        kind: "parent_closeout",
        urgency: "normal",
        taskId: closeout.parent.id,
        agentId: closeout.parent.activeAgentId,
        serverId: closeout.parent.serverId ?? deps.serverId,
        conversationId: closeout.parent.conversationId ?? null,
        title: closeout.parent.title,
        summary: `父任务下全部 ${closeout.children.length} 个子片（${childSummary}）均已验收完成，请核验整体目标并完成父任务收尾`,
        fingerprintSeed: closeout.wakeKey,
        quiet: closeout.parent.quiet !== false,
      });
    }
  }

  function isActiveManagedAgentEntry(
    labels: Record<string, string>,
    agentId: string,
    lifecycle: string,
    managedTaskAgentIds: ReadonlySet<string>,
  ): boolean {
    if (isMainChatLabels(labels) || isMainChatConversationLabels(labels)) {
      return false;
    }
    if (lifecycle !== "running" && lifecycle !== "initializing") {
      return false;
    }
    return Boolean(getMainChatTaskMetaFromLabels(labels)) || managedTaskAgentIds.has(agentId);
  }

  function countActiveManagedConcurrencyForHost(serverId: string): number {
    const activeAgentIds = new Set<string>();
    const tasks = store.listTasks({ includeCompleted: false });
    const managedTaskAgentIds = new Set<string>();
    for (const task of tasks) {
      if ((task.serverId ?? deps.serverId) === serverId && task.activeAgentId) {
        managedTaskAgentIds.add(task.activeAgentId);
      }
    }

    if (serverId === deps.serverId) {
      for (const agent of deps.agentManager.listAgents()) {
        if (agent.background || agent.internal) continue;
        if (
          isActiveManagedAgentEntry(agent.labels, agent.id, agent.lifecycle, managedTaskAgentIds)
        ) {
          activeAgentIds.add(agent.id);
        }
      }
      return activeAgentIds.size;
    }

    for (const remote of fleetBridge.listCachedRemoteAgents()) {
      if (remote.serverId !== serverId) continue;
      if (
        isActiveManagedAgentEntry(
          remote.labels,
          remote.agentId,
          remote.lifecycle,
          managedTaskAgentIds,
        )
      ) {
        activeAgentIds.add(remote.agentId);
      }
    }
    // Include remote running tasks whose agent snapshot has not synced back yet
    for (const task of tasks) {
      const matchesRemote =
        (task.serverId ?? deps.serverId) === serverId &&
        task.status === "running" &&
        Boolean(task.activeAgentId);
      if (matchesRemote && !fleetBridge.getCachedRemoteAgent(serverId, task.activeAgentId!)) {
        activeAgentIds.add(task.activeAgentId!);
      }
    }
    return activeAgentIds.size;
  }

  async function collectHostResourceSnapshotsInternal(options?: {
    forceRefresh?: boolean;
  }): Promise<MainChatHostResourceSnapshot[]> {
    const policy = resolveMainChatResourceAdmissionPolicy(store.getSettings());
    const sampledAt = new Date(getNowMs()).toISOString();
    const fleetHostsRes = await fleetBridge
      .getFleetHosts({ forceRefresh: options?.forceRefresh })
      .catch(() => ({
        localServerId: deps.serverId,
        hosts: [] as MainChatFleetHostStatus[],
      }));

    const hostsById = new Map<string, MainChatFleetHostStatus>();
    for (const host of fleetHostsRes.hosts) {
      hostsById.set(host.serverId, host);
    }
    if (!hostsById.has(deps.serverId)) {
      hostsById.set(deps.serverId, {
        serverId: deps.serverId,
        label: deps.hostLabel?.trim() || "本机",
        isLocal: true,
        status: "online",
        agentCount: 0,
        needsAttentionCount: 0,
        lastSyncedAt: sampledAt,
        error: null,
      });
    }

    const snapshots: MainChatHostResourceSnapshot[] = [];
    for (const host of hostsById.values()) {
      const isLocal = host.isLocal || host.serverId === deps.serverId;
      let sample = null;
      if (deps.hostResourceSampler) {
        sample = await deps.hostResourceSampler({ serverId: host.serverId, isLocal });
      } else if (isLocal) {
        sample = sampleLocalHostOsResources();
      }
      const activeManagedAgents = countActiveManagedConcurrencyForHost(host.serverId);
      snapshots.push(
        buildHostResourceSnapshot({
          serverId: host.serverId,
          hostLabel: host.label || host.serverId,
          isLocal,
          connectivityStatus: isLocal ? "online" : host.status,
          activeManagedAgents,
          sample,
          policy,
          sampledAt,
        }),
      );
    }

    snapshots.sort((a, b) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1;
      return a.hostLabel.localeCompare(b.hostLabel);
    });
    return snapshots;
  }

  async function syncQueuePositionsToTaskRecords(
    queue: readonly MainChatAdmissionQueueEntry[],
  ): Promise<void> {
    const byTaskId = new Map<string, MainChatAdmissionQueueEntry>();
    for (const entry of queue) {
      byTaskId.set(entry.taskId, entry);
    }
    for (const entry of queue) {
      const task = store.getTask(entry.taskId);
      if (!task) continue;
      if (
        task.admissionState?.status === "queued" &&
        task.admissionState.queueId === entry.id &&
        task.admissionState.position === entry.position &&
        task.admissionState.reason === entry.reason
      ) {
        continue;
      }
      await store.putTask({
        ...task,
        admissionState: createTaskQueuedAdmissionState(entry),
      });
    }
    for (const task of store.listTasks({ includeCompleted: false })) {
      if (task.admissionState?.status === "queued" && !byTaskId.has(task.id)) {
        await store.putTask({
          ...task,
          admissionState: null,
        });
      }
    }
  }

  async function collectResourceAdmissionSnapshotInternal(options?: {
    forceRefresh?: boolean;
  }): Promise<MainChatResourceAdmissionSnapshot> {
    await store.load();
    const policy = resolveMainChatResourceAdmissionPolicy(store.getSettings());
    const hosts = await collectHostResourceSnapshotsInternal(options);
    const queue = store.listAdmissionQueue();
    return buildResourceAdmissionSnapshot({
      policy,
      hosts,
      queue,
      updatedAt: new Date(getNowMs()).toISOString(),
    });
  }

  async function clearTaskQueuedAdmissionState(taskId: string): Promise<void> {
    const task = store.getTask(taskId);
    if (task && task.admissionState?.status === "queued") {
      await store.putTask({ ...task, admissionState: null });
    }
  }

  function isQueuedTaskStillDispatchable(
    taskRecord: MainChatTaskRecord | null | undefined,
  ): taskRecord is MainChatTaskRecord {
    return Boolean(
      taskRecord &&
      taskRecord.activeAgentId === null &&
      taskRecord.status !== "completed" &&
      taskRecord.status !== "cancelled" &&
      taskRecord.status !== "parked",
    );
  }

  function resolveFallbackHostSnapshot(
    serverId: string,
    hostLabel: string,
    policy: MainChatResourceAdmissionPolicy,
    nowIso: string,
  ): MainChatHostResourceSnapshot {
    const isLocal = serverId === deps.serverId;
    return buildHostResourceSnapshot({
      serverId,
      hostLabel,
      isLocal,
      connectivityStatus: isLocal ? "online" : "offline",
      activeManagedAgents: countActiveManagedConcurrencyForHost(serverId),
      sample: null,
      policy,
      sampledAt: nowIso,
    });
  }

  async function dispatchQueuedAdmissionEntry(input: {
    entry: MainChatAdmissionQueueEntry;
    taskRecord: MainChatTaskRecord;
    action: MainChatDrainAdmissionAction;
    nowIso: string;
  }): Promise<boolean> {
    const { entry, taskRecord, action, nowIso } = input;
    const linkedPlan = entry.planId ? store.getPlan(entry.planId) : null;
    const matchedPlannedTask = linkedPlan?.tasks.find(
      (item) =>
        (entry.plannedTaskId && item.id === entry.plannedTaskId) ||
        item.taskRecordId === taskRecord.id ||
        item.id === taskRecord.id,
    );
    const mainAgent = await resolveMainAgentSnapshot(taskRecord.mainAgentId);
    const spawned = await spawnSinglePlannedTask({
      plan: linkedPlan ?? buildSyntheticPlanForReadyTask(taskRecord, nowIso),
      task: matchedPlannedTask ?? buildSyntheticPlannedTaskForReadyTask(taskRecord),
      mainAgent,
      nowIso,
      skipAdmissionCheck: true,
    });

    if (linkedPlan && matchedPlannedTask) {
      await store.putPlan({
        ...linkedPlan,
        status: "started",
        startedAt: linkedPlan.startedAt ?? nowIso,
        tasks: linkedPlan.tasks.map((item) => (item.id === matchedPlannedTask.id ? spawned : item)),
      });
    }

    if (!spawned.agentId) {
      return false;
    }

    await store.incrementMetric("admissionDequeued");
    await store.appendActivity({
      id: makeId("act"),
      mainAgentId: taskRecord.mainAgentId,
      kind: "background_turn",
      trigger: "resource_admission",
      summary:
        action === "force_dispatch"
          ? `资源排队手动放行：「${taskRecord.title}」已在「${entry.hostLabel}」启动`
          : `资源恢复自动出队：「${taskRecord.title}」已在「${entry.hostLabel}」启动`,
      silent: true,
      status: "completed",
      createdAt: nowIso,
      completedAt: nowIso,
      relatedAgentId: spawned.agentId,
      detail: entry.reason,
    });
    return true;
  }

  async function finalizeAdmissionDrainResponse(input: {
    action: MainChatDrainAdmissionAction;
    dispatchedCount: number;
    removedCount: number;
    remainingQueue: readonly MainChatAdmissionQueueEntry[];
  }): Promise<{
    action: MainChatDrainAdmissionAction;
    dispatchedCount: number;
    removedCount: number;
    remainingCount: number;
    snapshot: MainChatResourceAdmissionSnapshot;
  }> {
    await syncQueuePositionsToTaskRecords(input.remainingQueue);
    const snapshot = await collectResourceAdmissionSnapshotInternal();
    return {
      action: input.action,
      dispatchedCount: input.dispatchedCount,
      removedCount: input.removedCount,
      remainingCount: input.remainingQueue.length,
      snapshot,
    };
  }

  function matchesDrainFilter(
    entry: MainChatAdmissionQueueEntry,
    targetQueueId: string | null,
    targetServerId: string | null,
  ): boolean {
    if (targetQueueId && entry.id !== targetQueueId) return false;
    if (targetServerId && entry.targetServerId !== targetServerId) return false;
    return true;
  }

  function tryRequeueBlockedAdmissionEntry(input: {
    entry: MainChatAdmissionQueueEntry;
    hostsById: ReadonlyMap<string, MainChatHostResourceSnapshot>;
    policy: MainChatResourceAdmissionPolicy;
    reservedExtraByHost: ReadonlyMap<string, number>;
    nowIso: string;
  }): MainChatAdmissionQueueEntry | null {
    const { entry, hostsById, policy, reservedExtraByHost, nowIso } = input;
    const hostSnapshot =
      hostsById.get(entry.targetServerId) ??
      resolveFallbackHostSnapshot(entry.targetServerId, entry.hostLabel, policy, nowIso);
    const pendingReservations =
      (inFlightAdmissionByHost.get(entry.targetServerId) ?? 0) +
      (reservedExtraByHost.get(entry.targetServerId) ?? 0);
    const evaluation = evaluateHostResourceAdmission({
      host: hostSnapshot,
      policy,
      pendingReservations,
    });
    if (evaluation.verdict === "allow") return null;
    return {
      ...entry,
      reasonCode: evaluation.reasonCode,
      reason: evaluation.reason,
      suggestion: evaluation.suggestion,
      attempts: entry.attempts + 1,
      lastEvaluatedAt: nowIso,
    };
  }

  async function handleClearOrRemoveAdmissionAction(
    action: "clear" | "remove",
    targetQueueId: string | null,
    targetServerId: string | null,
  ) {
    if (action === "clear") {
      const removed = await store.clearAdmissionQueue(targetServerId ?? undefined);
      for (const entry of removed) await clearTaskQueuedAdmissionState(entry.taskId);
      return finalizeAdmissionDrainResponse({
        action,
        dispatchedCount: 0,
        removedCount: removed.length,
        remainingQueue: store.listAdmissionQueue(),
      });
    }

    const entry = targetQueueId
      ? store.listAdmissionQueue().find((item) => item.id === targetQueueId)
      : undefined;
    const didRemove = targetQueueId ? await store.removeAdmissionEntry(targetQueueId) : false;
    if (didRemove && entry) await clearTaskQueuedAdmissionState(entry.taskId);
    return finalizeAdmissionDrainResponse({
      action,
      dispatchedCount: 0,
      removedCount: didRemove ? 1 : 0,
      remainingQueue: store.listAdmissionQueue(),
    });
  }

  async function drainAdmissionQueueInternal(input?: {
    action?: MainChatDrainAdmissionAction;
    queueId?: string;
    serverId?: string;
  }): Promise<{
    action: MainChatDrainAdmissionAction;
    dispatchedCount: number;
    removedCount: number;
    remainingCount: number;
    snapshot: MainChatResourceAdmissionSnapshot;
  }> {
    await store.load();
    const action: MainChatDrainAdmissionAction = input?.action ?? "drain";
    const targetQueueId = input?.queueId?.trim() || null;
    const targetServerId = input?.serverId?.trim() || null;

    if (action === "clear" || action === "remove") {
      return handleClearOrRemoveAdmissionAction(action, targetQueueId, targetServerId);
    }

    const policy = resolveMainChatResourceAdmissionPolicy(store.getSettings());
    const hosts = await collectHostResourceSnapshotsInternal();
    const hostsById = new Map(hosts.map((host) => [host.serverId, host]));
    const nextQueue: MainChatAdmissionQueueEntry[] = [];
    const reservedExtraByHost = new Map<string, number>();
    let dispatchedCount = 0;
    let removedCount = 0;
    const nowIso = new Date(getNowMs()).toISOString();

    for (const entry of store.listAdmissionQueue()) {
      if (!matchesDrainFilter(entry, targetQueueId, targetServerId)) {
        nextQueue.push(entry);
        continue;
      }
      const taskRecord = store.getTask(entry.taskId);
      if (!isQueuedTaskStillDispatchable(taskRecord)) {
        removedCount += 1;
        continue;
      }
      if (action !== "force_dispatch") {
        const stillBlocked = tryRequeueBlockedAdmissionEntry({
          entry,
          hostsById,
          policy,
          reservedExtraByHost,
          nowIso,
        });
        if (stillBlocked) {
          nextQueue.push(stillBlocked);
          continue;
        }
      }

      reservedExtraByHost.set(
        entry.targetServerId,
        (reservedExtraByHost.get(entry.targetServerId) ?? 0) + 1,
      );
      const started = await dispatchQueuedAdmissionEntry({ entry, taskRecord, action, nowIso });
      if (started) dispatchedCount += 1;
      else removedCount += 1;
    }

    const persistedQueue = await store.setAdmissionQueue(nextQueue);
    contextSnapshots.invalidateCache();
    return finalizeAdmissionDrainResponse({
      action,
      dispatchedCount,
      removedCount,
      remainingQueue: persistedQueue,
    });
  }

  function scheduleAdmissionQueueDrain(): void {
    if (store.listAdmissionQueue().length === 0) return;
    if (admissionDrainPromise) {
      admissionDrainPending = true;
      return;
    }
    admissionDrainPromise = drainAdmissionQueueInternal({ action: "drain" })
      .catch((error) => {
        logger.warn({ err: error }, "Automatic resource admission queue drain failed");
      })
      .then(() => undefined)
      .finally(() => {
        admissionDrainPromise = null;
        if (admissionDrainPending) {
          admissionDrainPending = false;
          scheduleAdmissionQueueDrain();
        }
      });
  }

  async function sweepIdleSubagentsInternal(input?: {
    dryRun?: boolean;
    idleThresholdMinutes?: number;
    limit?: number;
    trigger?: "scheduled" | "manual";
  }): Promise<MainChatIdleArchiveSweepResult> {
    await store.load();
    await conversationManager.load();
    const policy = resolveMainChatIdleArchivePolicy(store.getSettings());
    const dryRun = input?.dryRun === true;
    const idleThresholdMinutes = input?.idleThresholdMinutes ?? policy.idleThresholdMinutes;
    const limit = input?.limit ?? policy.maxArchivePerSweep;
    const trigger = input?.trigger ?? "manual";
    const nowMs = getNowMs();

    const mainChat = await findExistingMainChat();
    const conversations = await conversationManager.listConversations({ includeArchived: true });
    const conversationAgentIds = new Set<string>(conversations.map((conv) => conv.agentId));

    const tasksByAgentId = new Map<string, MainChatTaskRecord>();
    for (const task of store.listTasks({ includeCompleted: true })) {
      if (task.activeAgentId) {
        tasksByAgentId.set(task.activeAgentId, task);
      }
      for (const agentId of task.agentIds) {
        if (!tasksByAgentId.has(agentId)) {
          tasksByAgentId.set(agentId, task);
        }
      }
    }

    const queuedTaskIds = new Set<string>(store.listAdmissionQueue().map((item) => item.taskId));
    const openPlans = store
      .listPlans()
      .filter((plan) => plan.status === "open" || plan.status === "started");
    const openDecisions = store.listDecisions().filter((decision) => decision.answeredAt === null);

    const storedArchivedById = new Map<string, string | null>();
    const liveAgents = deps.agentManager
      .listAgents()
      .filter((agent) => !agent.internal && !agent.background);
    for (const agent of liveAgents) {
      const stored = await deps.agentStorage.get(agent.id);
      storedArchivedById.set(agent.id, stored?.archivedAt ?? null);
    }

    const toCandidate = (agent: ManagedAgent): IdleArchiveAgentCandidate => ({
      id: agent.id,
      serverId: deps.serverId,
      title: agent.config.title?.trim() || agent.id,
      lifecycle: agent.lifecycle,
      archivedAt: storedArchivedById.get(agent.id) ?? null,
      requiresAttention: agent.attention.requiresAttention,
      hasBackgroundWork: agent.activeTurnId !== null,
      pendingPermissionCount: agent.pendingPermissions.size,
      updatedAtMs: agent.updatedAt.getTime(),
      labels: agent.labels,
    });

    const candidates = liveAgents.map(toCandidate);

    const result = await runIdleSubagentArchiveSweep({
      candidates,
      context: {
        nowMs,
        idleThresholdMinutes,
        mainAgentId: mainChat?.agentId ?? null,
        conversationAgentIds,
        tasksByAgentId,
        openPlans,
        openDecisions,
        queuedTaskIds,
      },
      dryRun,
      limit,
      trigger,
      existingAuditLog: store.listIdleArchiveAudit(),
      revalidateBeforeArchive: (agentId) => {
        const live = deps.agentManager.getAgent(agentId);
        return live ? toCandidate(live) : null;
      },
      archiveAgent: async (agentId) => {
        await deps.agentManager.archiveAgent(agentId);
        await supervisor.handleAgentArchived(agentId);
      },
      onArchived: async (record) => {
        await store.appendIdleArchiveAudit(record);
        if (record.outcome === "archived") {
          await store.incrementMetric("idleSubagentsArchived");
          if (mainChat) {
            await store.appendActivity({
              id: makeId("act"),
              mainAgentId: mainChat.agentId,
              kind: "silent_turn",
              trigger: "idle_archive",
              summary: `闲置子会话已安全归档：「${record.title}」（闲置 ${record.idleMinutes} 分钟）`,
              silent: true,
              status: "completed",
              createdAt: record.sweptAt,
              completedAt: record.sweptAt,
              relatedAgentId: record.agentId,
              detail: record.reason,
            });
          }
        }
      },
    });

    if (!dryRun) {
      await store.setLastIdleArchiveSweepAt(result.sweptAt);
      if (result.archivedCount > 0) {
        contextSnapshots.invalidateCache();
      }
    }

    return result;
  }

  async function maybeRunScheduledIdleArchiveSweep(): Promise<void> {
    const policy = resolveMainChatIdleArchivePolicy(store.getSettings());
    if (!policy.enabled) return;
    const nowMs = getNowMs();
    const lastIso = store.getLastIdleArchiveSweepAt();
    if (lastIso) {
      const lastMs = Date.parse(lastIso);
      if (Number.isFinite(lastMs) && nowMs - lastMs < policy.sweepIntervalMinutes * 60_000) {
        return;
      }
    }
    try {
      await sweepIdleSubagentsInternal({
        dryRun: false,
        idleThresholdMinutes: policy.idleThresholdMinutes,
        limit: policy.maxArchivePerSweep,
        trigger: "scheduled",
      });
    } catch (error) {
      logger.warn({ err: error }, "Scheduled idle subagent archive sweep failed");
    }
  }

  function getOrCreateTaskRecordForAdmission(input: {
    resolvedTaskId: string;
    plan: MainChatPlanRecord;
    task: MainChatPlannedTask;
    targetServerId: string;
    hostLabel: string;
    nowIso: string;
  }): MainChatTaskRecord {
    return (
      store.getTask(input.resolvedTaskId) ??
      createTaskRecordFromPlannedTask({
        id: input.resolvedTaskId,
        mainAgentId: input.plan.mainAgentId,
        conversationId: input.plan.conversationId ?? null,
        planId: input.plan.id,
        plannedTask: input.task,
        agentId: null,
        cwd: input.task.cwd,
        workspaceId: input.task.workspaceId,
        serverId: input.targetServerId,
        hostLabel: input.hostLabel,
        nowIso: input.nowIso,
      })
    );
  }

  async function evaluatePreDispatchAdmission(input: {
    plan: MainChatPlanRecord;
    task: MainChatPlannedTask;
    continuedTask: MainChatTaskRecord | null;
    targetServerId: string;
    nowIso: string;
  }): Promise<MainChatPlannedTask | null> {
    const admissionPolicy = resolveMainChatResourceAdmissionPolicy(store.getSettings());
    if (!admissionPolicy.enabled) return null;

    const { plan, task, continuedTask, targetServerId, nowIso } = input;
    const hostSnapshots = await collectHostResourceSnapshotsInternal();
    const targetHostSnapshot =
      hostSnapshots.find((item) => item.serverId === targetServerId) ??
      resolveFallbackHostSnapshot(
        targetServerId,
        task.hostLabel?.trim() || targetServerId,
        admissionPolicy,
        nowIso,
      );
    const evaluation = evaluateHostResourceAdmission({
      host: targetHostSnapshot,
      policy: admissionPolicy,
      pendingReservations: inFlightAdmissionByHost.get(targetServerId) ?? 0,
    });
    if (evaluation.verdict === "allow") return null;

    const resolvedTaskId = continuedTask?.id ?? task.taskRecordId ?? task.id;
    const record = getOrCreateTaskRecordForAdmission({
      resolvedTaskId,
      plan,
      task,
      targetServerId,
      hostLabel: targetHostSnapshot.hostLabel,
      nowIso,
    });

    if (evaluation.verdict === "queue") {
      const queuedEntry = await store.enqueueAdmissionEntry({
        id: createAdmissionQueueId(),
        taskId: resolvedTaskId,
        planId: plan.id,
        plannedTaskId: task.id,
        mainAgentId: plan.mainAgentId,
        conversationId: plan.conversationId ?? null,
        title: task.title,
        targetServerId,
        hostLabel: targetHostSnapshot.hostLabel,
        reasonCode: evaluation.reasonCode,
        reason: evaluation.reason,
        suggestion: evaluation.suggestion,
        position: store.listAdmissionQueue().length + 1,
        enqueuedAt: nowIso,
        attempts: 1,
        lastEvaluatedAt: nowIso,
      });
      await store.putTask({
        ...record,
        admissionState: createTaskQueuedAdmissionState(queuedEntry),
        updatedAt: nowIso,
      });
      await store.incrementMetric("admissionQueued");
      await store.appendActivity({
        id: makeId("act"),
        mainAgentId: plan.mainAgentId,
        kind: "background_turn",
        trigger: "resource_admission",
        summary: `资源准入排队 #${queuedEntry.position}：「${task.title}」等待主机「${targetHostSnapshot.hostLabel}」释放资源`,
        silent: true,
        status: "queued",
        createdAt: nowIso,
        completedAt: null,
        detail: `${evaluation.reason}（建议：${evaluation.suggestion}）`,
      });
      return { ...task, taskRecordId: resolvedTaskId, startError: null };
    }

    await store.putTask({
      ...record,
      admissionState: createTaskRejectedAdmissionState({
        targetServerId,
        hostLabel: targetHostSnapshot.hostLabel,
        reasonCode: evaluation.reasonCode,
        reason: evaluation.reason,
        suggestion: evaluation.suggestion,
        updatedAt: nowIso,
      }),
      updatedAt: nowIso,
    });
    await store.incrementMetric("admissionRejected");
    await store.appendActivity({
      id: makeId("act"),
      mainAgentId: plan.mainAgentId,
      kind: "background_turn",
      trigger: "resource_admission",
      summary: `资源准入拒绝：「${task.title}」未能派发到「${targetHostSnapshot.hostLabel}」`,
      silent: false,
      status: "failed",
      createdAt: nowIso,
      completedAt: nowIso,
      detail: `${evaluation.reason}（建议：${evaluation.suggestion}）`,
    });
    throw new MainChatAdmissionRejectedError({
      targetServerId,
      hostLabel: targetHostSnapshot.hostLabel,
      reasonCode: evaluation.reasonCode,
      reason: evaluation.reason,
      suggestion: evaluation.suggestion,
      hostSnapshot: evaluation.hostSnapshot,
    });
  }

  function releaseInFlightAdmissionSlot(serverId: string): void {
    const nextCount = Math.max(0, (inFlightAdmissionByHost.get(serverId) ?? 1) - 1);
    if (nextCount === 0) {
      inFlightAdmissionByHost.delete(serverId);
    } else {
      inFlightAdmissionByHost.set(serverId, nextCount);
    }
  }

  async function handleSpawnPlannedTaskFailure(input: {
    error: unknown;
    plan: MainChatPlanRecord;
    task: MainChatPlannedTask;
    continuedTask: MainChatTaskRecord | null;
    stoppedPreviousAgent: boolean;
    nowIso: string;
  }): Promise<MainChatPlannedTask> {
    const { error, plan, task, continuedTask, stoppedPreviousAgent, nowIso } = input;
    const message = error instanceof Error ? error.message : String(error);
    logger.warn({ err: error, planId: plan.id, taskId: task.id }, "Failed to start plan task");
    if (continuedTask && stoppedPreviousAgent) {
      await store.putTask({
        ...continuedTask,
        activeAgentId: null,
        status: "failed",
        updatedAt: nowIso,
        lastActivityAt: nowIso,
      });
    }
    const isRejected = error instanceof MainChatAdmissionRejectedError;
    supervisor.enqueueSignal({
      kind: "failed",
      urgency: "immediate",
      taskId: continuedTask?.id ?? task.taskRecordId ?? null,
      agentId: null,
      serverId: task.serverId ?? deps.serverId,
      conversationId: plan.conversationId ?? null,
      title: task.title,
      summary: isRejected
        ? `资源准入拒绝：${message.slice(0, 140)}`
        : `任务首次启动失败：${message.slice(0, 120)}`,
      fingerprintSeed: `start_fail:${plan.id}:${task.id}:${message.slice(0, 40)}`,
      quiet: task.quiet !== false,
      escalatedToUser: true,
    });
    return {
      ...task,
      taskRecordId: isRejected
        ? (continuedTask?.id ?? task.taskRecordId ?? task.id)
        : task.taskRecordId,
      startError: message,
    };
  }

  async function spawnSinglePlannedTask(input: {
    plan: MainChatPlanRecord;
    task: MainChatPlannedTask;
    mainAgent: {
      provider: string;
      model: string | null;
      modeId: string | null;
      thinkingOptionId: string | null;
    };
    nowIso: string;
    skipAdmissionCheck?: boolean;
  }): Promise<MainChatPlannedTask> {
    const { plan, task, mainAgent, nowIso, skipAdmissionCheck } = input;
    await lessonsStore.load();
    const continuedTask = task.continuesTaskId ? store.getTask(task.continuesTaskId) : null;
    const targetServerId = task.serverId?.trim() || deps.serverId;
    let slotReserved = false;
    let stoppedPreviousAgent = false;
    try {
      if (task.continuesTaskId && !continuedTask) {
        throw new Error(`找不到要续接的原任务：${task.continuesTaskId}`);
      }

      if (!skipAdmissionCheck) {
        const queuedResult = await evaluatePreDispatchAdmission({
          plan,
          task,
          continuedTask,
          targetServerId,
          nowIso,
        });
        if (queuedResult) return queuedResult;
      }

      inFlightAdmissionByHost.set(
        targetServerId,
        (inFlightAdmissionByHost.get(targetServerId) ?? 0) + 1,
      );
      slotReserved = true;

      const previousAgentId = continuedTask ? continuedTask.activeAgentId : null;
      if (previousAgentId) {
        await stopPreviousTaskAgent(previousAgentId);
        stoppedPreviousAgent = true;
      }

      const prepared = prepareSpawnTaskPromptAndLabels({
        plan,
        task,
        continuedTask,
        previousAgentId,
        projectContext: await resolveProjectLessonContext({
          cwd: task.cwd,
          workspaceId: task.workspaceId,
          workspaceLabel: task.workspaceLabel,
        }),
      });
      const dispatched = await dispatchPreparedPlannedTask({
        plan,
        task,
        continuedTask,
        prepared,
        mainAgent,
      });

      await persistSpawnedTaskRecord({
        plan,
        task,
        continuedTask,
        existingRecord: prepared.existingRecord,
        resolvedTaskRecordId: prepared.resolvedTaskRecordId,
        preExistingDecisions: prepared.preExistingDecisions,
        agentId: dispatched.agentId,
        cwd: dispatched.cwd,
        workspaceId: dispatched.workspaceId,
        provider: dispatched.provider,
        model: dispatched.model,
        thinkingOptionId: dispatched.thinkingOptionId,
        nowIso,
      });

      return {
        ...task,
        cwd: dispatched.cwd,
        workspaceId: dispatched.workspaceId,
        agentId: dispatched.agentId,
        startedAt: nowIso,
        startError: null,
        taskRecordId: prepared.resolvedTaskRecordId,
      };
    } catch (error) {
      return handleSpawnPlannedTaskFailure({
        error,
        plan,
        task,
        continuedTask,
        stoppedPreviousAgent,
        nowIso,
      });
    } finally {
      if (slotReserved) {
        releaseInFlightAdmissionSlot(targetServerId);
      }
    }
  }

  function collectParentIdsInPlan(tasks: readonly MainChatPlannedTask[]): Set<string> {
    const batchTaskIds = new Set(tasks.map((item) => item.taskRecordId ?? item.id));
    const parentIds = new Set<string>();
    for (const item of tasks) {
      if (item.partOf && batchTaskIds.has(item.partOf)) {
        parentIds.add(item.partOf);
      }
    }
    return parentIds;
  }

  function buildPlanTasksLookupMap(
    plan: MainChatPlanRecord,
    nowIso: string,
  ): Map<string, MainChatTaskRecord> {
    const tasksById = new Map(
      store.listTasks({ includeCompleted: true }).map((entry) => [entry.id, entry]),
    );
    for (const item of plan.tasks) {
      const recordId = item.taskRecordId ?? item.id;
      if (tasksById.has(recordId)) continue;
      tasksById.set(
        recordId,
        createTaskRecordFromPlannedTask({
          id: recordId,
          mainAgentId: plan.mainAgentId,
          conversationId: plan.conversationId ?? null,
          planId: plan.id,
          plannedTask: item,
          agentId: item.agentId,
          cwd: item.cwd,
          workspaceId: item.workspaceId,
          serverId: item.serverId ?? deps.serverId,
          hostLabel: item.hostLabel ?? null,
          nowIso,
        }),
      );
    }
    return tasksById;
  }

  async function ensureDeferredPlanTaskRecord(input: {
    plan: MainChatPlanRecord;
    task: MainChatPlannedTask;
    resolvedId: string;
    depState: MainChatTaskRecord["dependencyState"];
    tasksById: Map<string, MainChatTaskRecord>;
    nowIso: string;
  }): Promise<void> {
    if (store.getTask(input.resolvedId)) return;
    const pendingRecord = createTaskRecordFromPlannedTask({
      id: input.resolvedId,
      mainAgentId: input.plan.mainAgentId,
      conversationId: input.plan.conversationId ?? null,
      planId: input.plan.id,
      plannedTask: input.task,
      agentId: null,
      cwd: input.task.cwd,
      workspaceId: input.task.workspaceId,
      serverId: input.task.serverId ?? deps.serverId,
      hostLabel: input.task.hostLabel ?? null,
      dependencyState: input.depState,
      nowIso: input.nowIso,
    });
    await store.putTask(pendingRecord);
    input.tasksById.set(pendingRecord.id, pendingRecord);
  }

  async function spawnTasksForPlan(
    plan: MainChatPlanRecord,
    selectedTaskIds?: ReadonlySet<string>,
  ): Promise<MainChatPlanRecord> {
    const mainAgent = await resolveMainAgentSnapshot(plan.mainAgentId);
    const updatedTasks: MainChatPlannedTask[] = [];
    const nowIso = new Date(getNowMs()).toISOString();
    const parentIdsInPlan = collectParentIdsInPlan(plan.tasks);
    const tasksById = buildPlanTasksLookupMap(plan, nowIso);

    for (const task of plan.tasks) {
      if (task.agentId || (selectedTaskIds && !selectedTaskIds.has(task.id))) {
        updatedTasks.push(task);
        continue;
      }

      const resolvedId = task.taskRecordId ?? task.id;
      const depState = computeTaskDependencyState({ after: task.after ?? [] }, tasksById);
      const isParentContainer =
        parentIdsInPlan.has(resolvedId) &&
        !(selectedTaskIds && selectedTaskIds.size === 1 && selectedTaskIds.has(task.id));

      if (depState === "blocked" || isParentContainer) {
        await ensureDeferredPlanTaskRecord({
          plan,
          task,
          resolvedId,
          depState,
          tasksById,
          nowIso,
        });
        updatedTasks.push({ ...task, taskRecordId: resolvedId });
        continue;
      }

      const spawned = await spawnSinglePlannedTask({ plan, task, mainAgent, nowIso });
      const persisted = spawned.taskRecordId ? store.getTask(spawned.taskRecordId) : null;
      if (persisted) {
        tasksById.set(persisted.id, persisted);
      }
      updatedTasks.push(spawned);
    }

    const updatedPlan: MainChatPlanRecord = {
      ...plan,
      status: "started",
      startedAt: plan.startedAt ?? nowIso,
      tasks: updatedTasks,
    };
    await store.putPlan(updatedPlan);
    return updatedPlan;
  }

  async function resolveLatestDeliveryGateForReview(
    existing: MainChatTaskRecord,
    input: { summary?: string | null; note?: string | null },
    nowIso: string,
  ): Promise<MainChatTaskDeliveryGate | null> {
    let latestGate = existing.deliveryGate ?? null;
    const resolvedReviewCwd = await resolveWorkspaceCwdForTask({
      cwd: existing.cwd,
      workspaceId: existing.workspaceId,
    });
    if (resolvedReviewCwd && deps.workspaceGitService) {
      const snapshot = await deps.workspaceGitService
        .getSnapshot(resolvedReviewCwd)
        .catch(() => null);
      if (snapshot && matchTasksForGitSnapshot([existing], snapshot).length > 0) {
        const fromSnapshot = buildDeliveryGateFromGitSnapshot({
          snapshot,
          existing: latestGate,
          nowIso,
        });
        if (fromSnapshot) {
          latestGate = fromSnapshot;
        }
      }
    }
    if (!latestGate) {
      const discoveredPr = extractPrUrlFromText(input.summary) ?? extractPrUrlFromText(input.note);
      if (discoveredPr) {
        latestGate = buildDeliveryGateFromDiscoveredPrUrl({
          prUrl: discoveredPr.prUrl,
          prNumber: discoveredPr.prNumber,
          existing: null,
          nowIso,
        });
      }
    }
    return latestGate;
  }

  async function enforceAcceptanceDeliveryGate(
    existing: MainChatTaskRecord,
    latestGate: MainChatTaskDeliveryGate | null,
    input: { bypassDeliveryGate?: boolean; bypassReason?: string | null },
    nowIso: string,
  ): Promise<{ gate: MainChatTaskDeliveryGate | null; warning: string | null }> {
    const deliveryPolicy = resolveMainChatDeliveryGatePolicy(store.getSettings());
    const gateEval = evaluateTaskDeliveryGateForAcceptance({
      task: existing,
      policy: deliveryPolicy,
      gate: latestGate,
    });
    if (!gateEval?.blocksAcceptance) {
      return { gate: gateEval?.gate ?? latestGate, warning: gateEval?.warning ?? null };
    }

    if (!isSameDeliveryGate(existing.deliveryGate, gateEval.gate)) {
      await applyTaskDeliveryGate(existing, gateEval.gate, nowIso);
    }
    if (!input.bypassDeliveryGate) {
      throw new DeliveryGateBlockedError(
        existing.id,
        gateEval.gate,
        `${gateEval.warning}。请先处理 PR 阻塞项后再验收；若经人工确认确需放行，请显式传入 bypassDeliveryGate=true 并说明 bypassReason。`,
      );
    }
    const bypassReason = trimOptional(input.bypassReason);
    if (!bypassReason) {
      throw new Error("绕过交付门禁（bypassDeliveryGate）时必须提供 bypassReason 说明原因");
    }
    return {
      gate: gateEval.gate,
      warning: `${gateEval.warning}（已人工豁免：${bypassReason}）`,
    };
  }

  async function distillAcceptanceLessonsSafe(
    completedTask: MainChatTaskRecord,
    input: { checks?: MainChatReceiptCheck[]; note?: string | null },
    receipt: MainChatTaskReceipt,
  ): Promise<void> {
    if (!isMainChatTaskLessonsEnabled(store.getSettings())) return;
    try {
      await lessonsStore.recordFromTaskFriction({
        task: completedTask,
        trigger: "accept",
        checks: input.checks,
        nextSteps: receipt.nextSteps,
        note: trimOptional(input.note),
        summary: receipt.summary,
        projectContext: await resolveProjectLessonContext({
          cwd: completedTask.cwd,
          workspaceId: completedTask.workspaceId,
          workspaceLabel: completedTask.workspaceLabel,
        }),
      });
    } catch (error) {
      logger.warn({ err: error, taskId: completedTask.id }, "Failed to distill acceptance lessons");
    }
  }

  function mergeDeliveryGatePatch(
    prev: MainChatTaskDeliveryGate | null | undefined,
    gatePatch: Partial<MainChatTaskDeliveryGate>,
    nowIso: string,
  ): MainChatTaskDeliveryGate {
    const pick = <K extends keyof MainChatTaskDeliveryGate>(
      key: K,
      fallback: MainChatTaskDeliveryGate[K],
    ): MainChatTaskDeliveryGate[K] => {
      if (gatePatch[key] !== undefined) return gatePatch[key] as MainChatTaskDeliveryGate[K];
      if (prev && prev[key] !== undefined) return prev[key];
      return fallback;
    };

    const prUrl = pick("prUrl", null);
    const prState = pick("prState", prUrl ? "open" : null);
    const isDraft = pick("isDraft", false);
    const hasConflict = pick("hasConflict", false);
    const ciStatus = pick("ciStatus", "unknown");
    const ciSummary = pick("ciSummary", null);
    const reviewDecision = pick("reviewDecision", null);
    const computed = computeDeliveryGateStatusAndBlockers({
      prUrl,
      prState,
      isDraft,
      hasConflict,
      ciStatus,
      ciSummary,
      reviewDecision,
    });

    return {
      prUrl,
      prNumber: pick("prNumber", null),
      branch: pick("branch", null),
      prState,
      isDraft,
      hasConflict,
      ciStatus,
      ciSummary,
      reviewDecision,
      headOid: pick("headOid", null),
      gateStatus: computed.gateStatus,
      blockingReasons: computed.blockingReasons,
      followUpActive: gatePatch.followUpActive ?? prState === "open",
      lastCheckedAt: nowIso,
      mergedAt: prState === "merged" ? (gatePatch.mergedAt ?? prev?.mergedAt ?? nowIso) : null,
    };
  }

  async function syncTaskRecordCompleted(
    task: MainChatTaskRecord,
    receipt: MainChatTaskReceipt,
    nowIso: string,
    deliveryGateOverride?: MainChatTaskDeliveryGate | null,
  ): Promise<MainChatTaskRecord> {
    const startIso = resolveTaskStartIso(task);
    const { actualMinutes, sampleMinutes } = computeTaskDurationMinutes(startIso, nowIso);
    const linkedPlan = task.planId ? store.getPlan(task.planId) : null;
    const linkedPlannedTask = linkedPlan?.tasks.find(
      (item) => item.taskRecordId === task.id || item.id === task.id,
    );
    const resolvedProvider = await resolveAgentProviderName(
      receipt.agentId ?? task.activeAgentId ?? task.agentIds.at(-1) ?? null,
      linkedPlannedTask?.provider ?? null,
    );

    await store.addDurationSample({
      id: makeId("dur"),
      serverId: task.serverId ?? deps.serverId,
      cwd: task.cwd,
      mode: task.mode,
      role: "worker",
      provider: resolvedProvider,
      durationMinutes: sampleMinutes,
      completedAt: nowIso,
    });

    let effectiveGate =
      deliveryGateOverride !== undefined ? deliveryGateOverride : task.deliveryGate;
    if (!effectiveGate) {
      const extractedPr = extractPrUrlFromText(receipt.summary);
      if (extractedPr) {
        effectiveGate = buildDeliveryGateFromDiscoveredPrUrl({
          prUrl: extractedPr.prUrl,
          prNumber: extractedPr.prNumber,
          existing: null,
          nowIso,
        });
      }
    }

    const completedTask: MainChatTaskRecord = {
      ...task,
      status: "completed",
      completedAt: nowIso,
      actualMinutes,
      parkedAt: null,
      parkedReason: null,
      latestReceipt: receipt,
      deliveryGate: effectiveGate ?? null,
      updatedAt: nowIso,
      lastActivityAt: nowIso,
    };
    await store.putTask(completedTask);
    await evaluateDagProgressAfterTaskChange(completedTask, nowIso);
    return completedTask;
  }

  async function recordTaskDecisionEntry(
    decision: {
      id?: string;
      taskId?: string | null;
      agentId?: string | null;
      planId?: string | null;
      question: string;
      answer: string;
    },
    decidedBy: MainChatTaskDecisionActor,
    nowIso: string,
  ): Promise<MainChatTaskRecord | null> {
    const linked = resolveTaskRecordByRef({
      taskId: decision.taskId,
      agentId: decision.agentId,
      planId: decision.planId,
    });
    if (!linked) return null;

    let updated = appendTaskDecision(linked, {
      id: decision.id,
      question: decision.question,
      answer: decision.answer,
      decidedBy,
      nowIso,
    });
    if (updated.status === "needs_you") {
      updated = { ...updated, status: "running" };
    }
    await store.putTask(updated);
    return updated;
  }

  async function dispatchReworkForAgent(input: {
    agentId: string;
    title: string;
    planId: string | null;
    taskId: string | null;
    taskRecord: MainChatTaskRecord | null;
    gaps: string[];
    note: string | null;
  }): Promise<{ rework: MainChatReworkRecord; task: MainChatTaskRecord | null }> {
    const existingCount = Math.max(
      input.taskRecord?.reworkCount ?? 0,
      store.getReworkRound(input.agentId),
    );
    if (existingCount >= MAX_REWORK_ROUNDS) {
      throw new Error(
        `该任务已达到返工上限（${MAX_REWORK_ROUNDS} 轮），请不要继续退回，请改用 task_ask_user 向用户汇报现状并请用户拍板。`,
      );
    }

    const roundFromStore = await store.incrementReworkRound(input.agentId);
    const round = Math.max(roundFromStore, (input.taskRecord?.reworkCount ?? 0) + 1);
    await store.incrementMetric("reworkCount");

    const decisionsSection = formatTaskDecisionsPromptSection(input.taskRecord?.decisions);
    const scopeHint =
      input.taskRecord && input.taskRecord.brief.scopeRevision > 1
        ? `（Scope Revision #${input.taskRecord.brief.scopeRevision}）`
        : "";
    const promptLines = [
      `【主对话复核退回 · 第 ${round}/${MAX_REWORK_ROUNDS} 轮返工】`,
      `对照验收标准${scopeHint}，以下缺口尚未满足，请逐项补齐并给出可核验的证据：`,
      ...input.gaps.map((gap, index) => `${index + 1}. ${gap}`),
      ...(input.note ? [`【补充说明】${input.note}`] : []),
      ...(decisionsSection ? ["", decisionsSection] : []),
    ];

    await sendPromptToAgent({
      agentId: input.agentId,
      prompt: promptLines.join("\n"),
      agentManager: deps.agentManager,
      agentStorage: deps.agentStorage,
      logger,
      unarchive: false,
    });

    const nowIso = new Date(getNowMs()).toISOString();
    let updatedTask: MainChatTaskRecord | null = null;
    if (input.taskRecord) {
      updatedTask = {
        ...input.taskRecord,
        status: "running",
        activeAgentId: input.agentId,
        parkedAt: null,
        parkedReason: null,
        completedAt: null,
        reworkCount: round,
        updatedAt: nowIso,
        lastActivityAt: nowIso,
      };
      await store.putTask(updatedTask);
    }

    const lessonTarget = updatedTask ?? input.taskRecord;
    if (lessonTarget && isMainChatTaskLessonsEnabled(store.getSettings())) {
      try {
        await lessonsStore.recordFromTaskFriction({
          task: lessonTarget,
          trigger: "rework",
          gaps: input.gaps,
          note: input.note,
          projectContext: await resolveProjectLessonContext({
            cwd: lessonTarget.cwd,
            workspaceId: lessonTarget.workspaceId,
            workspaceLabel: lessonTarget.workspaceLabel,
          }),
        });
      } catch (error) {
        logger.warn({ err: error, taskId: lessonTarget.id }, "Failed to distill rework lessons");
      }
    }

    const rework: MainChatReworkRecord = {
      title: input.title,
      agentId: input.agentId,
      planId: input.planId,
      taskId: input.taskRecord?.id ?? input.taskId,
      round,
      maxRounds: MAX_REWORK_ROUNDS,
      gaps: input.gaps,
      note: input.note,
    };
    return { rework, task: updatedTask };
  }

  async function resolveReworkTargetMeta(
    input: MainChatReworkInput,
  ): Promise<{ title: string; planId: string | null; taskId: string | null }> {
    const live = deps.agentManager.getAgent(input.agentId);
    const stored = live ? null : await deps.agentStorage.get(input.agentId);
    if (!live && !stored) {
      throw new Error(`找不到要返工的子 Agent：${input.agentId}`);
    }
    const meta = getMainChatTaskMetaFromLabels(live?.labels ?? stored?.labels);
    const fallbackTitle = live?.config.title?.trim() || stored?.title?.trim() || input.agentId;
    return {
      title: trimOptional(input.title) ?? fallbackTitle,
      planId: trimOptional(input.planId) ?? meta?.planId ?? null,
      taskId: trimOptional(input.taskId) ?? meta?.taskId ?? null,
    };
  }

  function estimateTimelineItemTokens(item: AgentTimelineItem): number {
    if (
      item.type === "user_message" ||
      item.type === "assistant_message" ||
      item.type === "reasoning"
    ) {
      return Math.ceil(item.text.length / 3);
    }
    if (item.type === "tool_call") {
      const detail = item.detail ? JSON.stringify(item.detail).length : 0;
      return Math.ceil((item.name.length + detail) / 3);
    }
    return 0;
  }

  function estimateContextTokens(mainAgentId: string): number {
    const live = deps.agentManager.getAgent(mainAgentId);
    const usage = live?.lastUsage;
    if (usage) {
      if (typeof usage.contextWindowUsedTokens === "number" && usage.contextWindowUsedTokens > 0) {
        return Math.round(usage.contextWindowUsedTokens);
      }
      const summed =
        (usage.inputTokens ?? 0) + (usage.cachedInputTokens ?? 0) + (usage.outputTokens ?? 0);
      if (summed > 0) {
        return Math.round(summed);
      }
    }
    const timeline = deps.agentManager.getTimeline(mainAgentId);
    let total = 0;
    for (const item of timeline) {
      total += estimateTimelineItemTokens(item);
    }
    return total;
  }

  function toPositiveTokenCount(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.round(value)
      : null;
  }

  function findSnapshotModelContextWindow(
    models: ReadonlyArray<{
      id: string;
      aliases?: readonly string[];
      isDefault?: boolean;
      contextWindowMaxTokens?: number | null;
    }>,
    requestedModel: string | undefined,
  ): number | null {
    if (models.length === 0) return null;
    const matched = requestedModel
      ? models.find(
          (model) =>
            model.id === requestedModel ||
            (Array.isArray(model.aliases) && model.aliases.includes(requestedModel)),
        )
      : (models.find((model) => model.isDefault) ?? models[0]);
    return toPositiveTokenCount(matched?.contextWindowMaxTokens);
  }

  function resolveContextWindowMaxTokens(mainAgentId: string): number | null {
    const live = deps.agentManager.getAgent(mainAgentId);
    const liveMax = toPositiveTokenCount(live?.lastUsage?.contextWindowMaxTokens);
    if (liveMax !== null) return liveMax;
    if (!live) return null;
    try {
      const snapshot = deps.providerSnapshotManager.getSnapshot(
        live.cwd || path.join(deps.paseoHome, MAIN_CHAT_WORKSPACE_DIR_NAME),
      );
      const providerEntry = snapshot.records
        .map((record) => record.entry)
        .find((entry) => entry.provider === live.provider);
      return findSnapshotModelContextWindow(providerEntry?.models ?? [], live.config.model?.trim());
    } catch {
      // Provider snapshot may be unavailable in minimal harnesses or before initial scan.
      return null;
    }
  }

  function resolveEffectiveIdlePrecompactMinIdleMs(): number {
    if (explicitIdlePrecompactMinIdleMs !== undefined && !idlePrecompactMinIdlePatched) {
      return explicitIdlePrecompactMinIdleMs;
    }
    const cfg = resolveMainChatCompactionConfig(store.getSettings());
    return Math.max(60_000, cfg.idlePrecompactMinIdleMin * 60_000);
  }

  function resolveCompactThresholdTokens(
    mainAgentId: string,
    contextWindowMaxTokens?: number | null,
  ): number {
    const maxTokens =
      contextWindowMaxTokens !== undefined
        ? contextWindowMaxTokens
        : resolveContextWindowMaxTokens(mainAgentId);
    const compactionConfig = resolveMainChatCompactionConfig(store.getSettings());
    if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
      const effectiveWindow =
        computeEffectiveCompactionWindowTokens(maxTokens, compactionConfig.windowCapTokens) ??
        maxTokens;
      return Math.max(1_000, Math.floor(effectiveWindow * MAIN_CHAT_COMPACT_WINDOW_RATIO));
    }
    if (explicitCompactThresholdTokens !== undefined) {
      return Math.max(1_000, explicitCompactThresholdTokens);
    }
    if (compactionConfig.windowCapTokens !== null) {
      return Math.max(
        1_000,
        Math.floor(compactionConfig.windowCapTokens * MAIN_CHAT_COMPACT_WINDOW_RATIO),
      );
    }
    return Math.max(1_000, configuredCompactThresholdTokens);
  }

  function buildCompactionState(mainAgentId: string | null): MainChatCompactionState {
    const currentSettings = store.getSettings();
    const autoCompactEnabled = isMainChatAutoCompactEnabled(currentSettings);
    const compactionConfig = resolveMainChatCompactionConfig(currentSettings);
    if (!mainAgentId) {
      let thresholdTokens = Math.max(1_000, configuredCompactThresholdTokens);
      if (explicitCompactThresholdTokens !== undefined) {
        thresholdTokens = Math.max(1_000, explicitCompactThresholdTokens);
      } else if (compactionConfig.windowCapTokens !== null) {
        thresholdTokens = Math.max(
          1_000,
          Math.floor(compactionConfig.windowCapTokens * MAIN_CHAT_COMPACT_WINDOW_RATIO),
        );
      }
      return {
        status: "idle",
        estimatedTokens: 0,
        thresholdTokens,
        contextWindowMaxTokens: null,
        windowCapTokens: compactionConfig.windowCapTokens,
        effectiveWindowTokens: compactionConfig.windowCapTokens,
        idlePrecompactMinIdleMin: compactionConfig.idlePrecompactMinIdleMin,
        autoCompactEnabled,
        lastCompactedAt: null,
        lastError: null,
        summary: null,
        reason: null,
        strategy: null,
      };
    }
    const persisted = store.getCompactionMeta(mainAgentId);
    const liveStatus = compactionStatusByAgent.get(mainAgentId);
    let derivedStatus: MainChatCompactionStatus = "idle";
    if (liveStatus) {
      derivedStatus = liveStatus;
    } else if (persisted.lastError) {
      derivedStatus = "failed";
    } else if (persisted.lastCompactedAt) {
      derivedStatus = "succeeded";
    }
    const contextWindowMaxTokens = resolveContextWindowMaxTokens(mainAgentId);
    const effectiveWindowTokens = computeEffectiveCompactionWindowTokens(
      contextWindowMaxTokens,
      compactionConfig.windowCapTokens,
    );
    return {
      status: derivedStatus,
      estimatedTokens: estimateContextTokens(mainAgentId),
      thresholdTokens: resolveCompactThresholdTokens(mainAgentId, contextWindowMaxTokens),
      contextWindowMaxTokens,
      windowCapTokens: compactionConfig.windowCapTokens,
      effectiveWindowTokens,
      idlePrecompactMinIdleMin: compactionConfig.idlePrecompactMinIdleMin,
      autoCompactEnabled,
      lastCompactedAt: persisted.lastCompactedAt,
      lastError: persisted.lastError,
      summary: persisted.summary,
      reason: persisted.reason,
      strategy: persisted.strategy,
    };
  }

  function extractRecentTimelineMessages(
    mainAgentId: string,
  ): Array<{ role: "user" | "assistant"; text: string }> {
    const timeline = deps.agentManager.getTimeline(mainAgentId);
    const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
    for (const item of timeline) {
      if (item.type === "user_message") {
        const cleaned = stripMainChatContextBlock(item.text).trim();
        if (!cleaned || isSystemInjectedEnvelope(cleaned)) continue;
        messages.push({ role: "user", text: cleaned });
      } else if (item.type === "assistant_message") {
        const cleaned = item.text.trim();
        if (!cleaned) continue;
        messages.push({ role: "assistant", text: cleaned });
      }
    }
    return messages.slice(-6);
  }

  async function supportsNativeCompactCommand(mainAgentId: string): Promise<boolean> {
    const live = deps.agentManager.getAgent(mainAgentId);
    if (!live) return false;
    const session = (
      live as {
        session?: {
          listCommands?: () => Promise<Array<{ name: string }>>;
          tryHandleOutOfBand?: (prompt: string) => unknown;
        };
      }
    ).session;
    if (
      typeof session?.tryHandleOutOfBand === "function" &&
      session.tryHandleOutOfBand("/compact")
    ) {
      return true;
    }
    if (typeof session?.listCommands === "function") {
      try {
        const commands = await session.listCommands();
        return commands.some(
          (command) => command.name.trim().replace(/^\//, "").toLowerCase() === "compact",
        );
      } catch {
        return false;
      }
    }
    return false;
  }

  async function resolveRequiredMainAgentId(requestedMainAgentId?: string): Promise<string> {
    if (requestedMainAgentId?.trim()) {
      return requestedMainAgentId.trim();
    }
    const existing = await findExistingMainChat();
    if (!existing) {
      throw new Error("当前尚未初始化主对话，请先确保主对话已就绪");
    }
    return existing.agentId;
  }

  async function runCompactionExecution(
    mainAgentId: string,
    options: {
      reason: MainChatCompactionReason;
      instructions?: string;
      skipActivityLog?: boolean;
      signal?: AbortSignal;
    },
  ): Promise<MainChatCompactResult> {
    const { reason, instructions, skipActivityLog, signal } = options;
    const existingInFlight = compactionInFlightByAgent.get(mainAgentId);
    if (existingInFlight) {
      return existingInFlight;
    }

    async function executeNativeCompaction(
      compactionReason: "manual" | "idle_precompact",
      compactionInstructions: string | undefined,
      activityId: string | null,
    ): Promise<string> {
      const trimmedInstructions = compactionInstructions?.trim() ?? "";
      const command = trimmedInstructions ? `/compact ${trimmedInstructions}` : "/compact";
      const bgCompactionMessageId = `${MAIN_CHAT_BACKGROUND_COMPACTION_MSG_PREFIX}${compactionReason}:${makeId("cmp")}`;
      const dispatch = await sendPromptToAgent({
        agentId: mainAgentId,
        prompt: command,
        messageId: bgCompactionMessageId,
        runOptions: { clientMessageId: bgCompactionMessageId },
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger,
        unarchive: false,
      });
      if (dispatch.disposition === "turn_started") {
        await dispatch.started;
        // Wait for the native /compact turn to settle while turnQueue still holds the background
        // compaction slot so asynchronous events are never misclassified as a foreground turn.
        if (
          typeof deps.agentManager.waitForAgentEvent === "function" &&
          deps.agentManager.hasInFlightRun(mainAgentId)
        ) {
          await deps.agentManager
            .waitForAgentEvent(mainAgentId, { waitForActive: true })
            .catch(() => undefined);
        }
      }
      let summary = "已通过底层引擎原生 /compact 完成上下文压缩";
      if (trimmedInstructions) {
        summary = `已通过底层引擎原生 /compact 完成上下文压缩（${trimmedInstructions.slice(0, 80)}）`;
      } else if (compactionReason === "idle_precompact") {
        summary = "已完成后台空闲原生 /compact 上下文压缩";
      }
      if (
        dispatch.disposition === "out_of_band" &&
        typeof deps.agentManager.appendTimelineItem === "function"
      ) {
        const existingTimeline = deps.agentManager.getTimeline(mainAgentId);
        const hasStructuredCompactionRow = existingTimeline.some(
          (item) => item.type === "tool_call" && item.callId.includes(bgCompactionMessageId),
        );
        if (!hasStructuredCompactionRow) {
          await deps.agentManager
            .appendTimelineItem(mainAgentId, {
              type: "tool_call",
              callId: `paseo-system:compaction:${bgCompactionMessageId}`,
              name: "heartbeat",
              status: "completed",
              error: null,
              detail: { type: "plain_text", text: summary, icon: "sparkles" },
              metadata: {
                mainChatBackground: {
                  foldable: true,
                  kind: "compaction",
                  trigger: compactionReason,
                  label:
                    compactionReason === "idle_precompact"
                      ? "空闲自动压缩 · 原生 /compact"
                      : "上下文压缩 · 原生 /compact",
                  ...(activityId ? { activityId } : {}),
                  quiet: true,
                },
              },
            })
            .catch(() => undefined);
        }
      }
      return summary;
    }

    const execute = async (): Promise<MainChatCompactResult> => {
      await store.load();
      if (signal?.aborted) {
        throw new Error("后台预压缩已因用户活跃让路取消");
      }

      const startedIso = new Date(getNowMs()).toISOString();
      const activityId = skipActivityLog ? null : makeId("act");
      compactionStatusByAgent.set(mainAgentId, "running");

      if (activityId) {
        await store.appendActivity({
          id: activityId,
          mainAgentId,
          kind: "compaction",
          trigger: reason,
          summary: reason === "idle_precompact" ? "触发空闲预压缩" : "执行主对话上下文压缩",
          silent: reason === "idle_precompact",
          status: "running",
          createdAt: startedIso,
          completedAt: null,
        });
      }

      let strategy: MainChatCompactionStrategy = "handoff_summary";
      try {
        const nativeSupported = await supportsNativeCompactCommand(mainAgentId);
        if (signal?.aborted) {
          throw new Error("后台预压缩已因用户活跃让路取消");
        }

        let summary: string;
        if (nativeSupported) {
          strategy = "native";
          summary = await executeNativeCompaction(reason, instructions, activityId);
        } else {
          strategy = "handoff_summary";
          const fleet = await contextSnapshots.collectFleet(mainAgentId, { bypassCache: true });
          const plans = store.listPlans(mainAgentId);
          const openDecisions = store
            .listDecisions(mainAgentId)
            .filter((decision) => !decision.answeredAt);
          const recentMessages = extractRecentTimelineMessages(mainAgentId);
          summary = buildMainChatHandoffSummary({
            previousAgentId: mainAgentId,
            fleet,
            plans,
            openDecisions,
            recentMessages,
            instructions,
          });
          const checkpointPrompt = buildMainChatCompactionCheckpointPrompt({
            summary,
            reason,
            instructions,
          });
          const dispatch = await sendPreparedPromptToAgent({
            agentId: mainAgentId,
            prompt: formatCompactionCheckpointNotificationPrompt(checkpointPrompt, reason),
            agentManager: deps.agentManager,
            agentStorage: deps.agentStorage,
            logger,
            unarchive: false,
          });
          if (dispatch.disposition === "turn_started") {
            await dispatch.started;
            if (
              typeof deps.agentManager.waitForAgentEvent === "function" &&
              deps.agentManager.hasInFlightRun(mainAgentId)
            ) {
              await deps.agentManager
                .waitForAgentEvent(mainAgentId, { waitForActive: true })
                .catch(() => undefined);
            }
          }
        }

        const completedIso = new Date(getNowMs()).toISOString();
        contextSnapshots.resetDelta(mainAgentId);
        compactionStatusByAgent.set(mainAgentId, "succeeded");
        lastPrecompactWatermarkByAgent.set(mainAgentId, turnQueue.getLastActivityAtMs(mainAgentId));
        await store.setCompactionMeta(mainAgentId, {
          lastCompactedAt: completedIso,
          lastError: null,
          summary,
          reason,
          strategy,
        });
        await store.incrementMetric("compactions");

        if (activityId) {
          await store.updateActivity(activityId, {
            status: "completed",
            completedAt: completedIso,
            summary:
              strategy === "native" ? "已完成原生上下文压缩" : "已完成结构化交接摘要上下文压缩",
            detail: summary,
          });
        }

        return {
          mainAgentId,
          compaction: buildCompactionState(mainAgentId),
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failedIso = new Date(getNowMs()).toISOString();
        const prev = store.getCompactionMeta(mainAgentId);
        compactionStatusByAgent.set(mainAgentId, "failed");
        await store.setCompactionMeta(mainAgentId, {
          ...prev,
          lastError: message,
          reason,
          strategy,
        });
        if (activityId) {
          await store.updateActivity(activityId, {
            status: "failed",
            completedAt: failedIso,
            detail: message,
          });
        }
        throw error;
      }
    };

    const task = execute().finally(() => {
      if (compactionInFlightByAgent.get(mainAgentId) === task) {
        compactionInFlightByAgent.delete(mainAgentId);
      }
    });
    compactionInFlightByAgent.set(mainAgentId, task);
    return task;
  }

  function canRunIdlePrecompaction(mainAgentId: string): {
    allowed: boolean;
    lastActivityAtMs: number;
  } {
    if (
      compactionInFlightByAgent.has(mainAgentId) ||
      turnQueue.isForegroundActive(mainAgentId) ||
      turnQueue.isBackgroundBusy(mainAgentId) ||
      deps.agentManager.hasInFlightRun(mainAgentId)
    ) {
      return { allowed: false, lastActivityAtMs: 0 };
    }
    const live = deps.agentManager.getAgent(mainAgentId);
    if (!live || live.lifecycle === "running") {
      return { allowed: false, lastActivityAtMs: 0 };
    }
    const lastActivityAtMs = turnQueue.getLastActivityAtMs(mainAgentId);
    const idleMs =
      lastActivityAtMs > 0
        ? turnQueue.getIdleDurationMs(mainAgentId)
        : Math.max(0, getNowMs() - live.updatedAt.getTime());
    if (idleMs < resolveEffectiveIdlePrecompactMinIdleMs()) {
      return { allowed: false, lastActivityAtMs };
    }
    const watermark = lastPrecompactWatermarkByAgent.get(mainAgentId);
    if (watermark !== undefined && watermark === lastActivityAtMs) {
      return { allowed: false, lastActivityAtMs };
    }
    return { allowed: true, lastActivityAtMs };
  }

  async function checkIdlePrecompactionInternal(requestedMainAgentId?: string): Promise<boolean> {
    await store.load();
    const currentSettings = store.getSettings();
    if (!isMainChatEnabled(currentSettings) || !isMainChatAutoCompactEnabled(currentSettings)) {
      return false;
    }
    if (supervisor.getNightModeStatus().state === "hibernating") return false;
    const mainAgentId = requestedMainAgentId ?? (await findExistingMainChat())?.agentId ?? null;
    if (!mainAgentId) return false;
    if (!canRunIdlePrecompaction(mainAgentId).allowed) return false;

    const estimated = estimateContextTokens(mainAgentId);
    const contextWindowMaxTokens = resolveContextWindowMaxTokens(mainAgentId);
    const threshold = resolveCompactThresholdTokens(mainAgentId, contextWindowMaxTokens);
    if (estimated < threshold) {
      return false;
    }

    const windowLabel = contextWindowMaxTokens
      ? `${estimated}/${contextWindowMaxTokens} tokens（已达 80% 阈值 ${threshold}）`
      : `${estimated}/${threshold} tokens`;

    const result = await turnQueue.enqueueBackground({
      mainAgentId,
      dedupeKey: "compaction:idle_precompact",
      trigger: "idle_precompact",
      priority: 1,
      summary: `上下文占用已达 ${windowLabel}，后台静默执行空闲自动压缩`,
      requeueOnPreempt: false,
      preemptible: false,
      customExecute: async (signal) => {
        if (signal.aborted || turnQueue.isForegroundActive(mainAgentId)) {
          return { summary: "用户恢复活跃，空闲预压缩已让路", silent: true };
        }
        const compacted = await runCompactionExecution(mainAgentId, {
          reason: "idle_precompact",
          skipActivityLog: true,
          signal,
        });
        return {
          summary: "空闲预压缩完成",
          silent: true,
          detail: compacted.compaction.summary,
        };
      },
    });
    return result.status === "dispatched" || result.status === "queued";
  }

  async function createCleanMainChatAgent(input: {
    workspaceId: string;
    cwd: string;
    title: string;
    provider: AgentProvider;
    model?: string | null;
    modeId?: string | null;
    thinkingOptionId?: string | null;
  }): Promise<{ agentId: string; workspaceId: string }> {
    const { snapshot } = await createAgentCommand(
      {
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        finishSubscriptions: deps.finishSubscriptions?.(),
        logger,
        paseoHome: deps.paseoHome,
        worktreesRoot: deps.worktreesRoot,
        terminalManager: deps.terminalManager,
        providerSnapshotManager: deps.providerSnapshotManager,
        createPaseoWorktree: deps.createPaseoWorktree,
        ensureWorkspaceForCreate: deps.ensureWorkspaceForCreate,
      },
      {
        kind: "session",
        config: {
          provider: input.provider,
          cwd: input.cwd,
          title: input.title,
          ...(input.model ? { model: input.model } : {}),
          ...(input.modeId ? { modeId: input.modeId } : {}),
          ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
        },
        workspaceId: input.workspaceId,
        background: false,
        labels: {
          [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_ROLE_VALUE,
        },
        provisionalTitle: input.title,
        firstAgentContext: {},
      },
    );
    return {
      agentId: snapshot.id,
      workspaceId: snapshot.workspaceId ?? input.workspaceId,
    };
  }

  async function collectMigratableChildIds(
    fromMainAgentId: string,
    toMainAgentId: string,
  ): Promise<Set<string>> {
    const candidateChildIds = new Set<string>();
    const isExcluded = (id: string) => id === fromMainAgentId || id === toMainAgentId;

    for (const agent of deps.agentManager.listAgents()) {
      if (!isExcluded(agent.id) && getParentAgentIdFromLabels(agent.labels) === fromMainAgentId) {
        candidateChildIds.add(agent.id);
      }
    }

    const storedActive = await deps.agentStorage.listActive();
    for (const record of storedActive) {
      if (
        !record.archivedAt &&
        !isExcluded(record.id) &&
        getParentAgentIdFromLabels(record.labels) === fromMainAgentId
      ) {
        candidateChildIds.add(record.id);
      }
    }

    for (const plan of store.listPlans(fromMainAgentId)) {
      for (const task of plan.tasks) {
        if (!task.agentId || isExcluded(task.agentId)) continue;
        const live = deps.agentManager.getAgent(task.agentId);
        const stored = live ? null : await deps.agentStorage.get(task.agentId);
        if (stored?.archivedAt) continue;
        if (getParentAgentIdFromLabels(live?.labels ?? stored?.labels) === fromMainAgentId) {
          candidateChildIds.add(task.agentId);
        }
      }
    }

    return candidateChildIds;
  }

  async function reRegisterMigratedFinishSubscription(
    finishSubscriptions: FinishSubscriptions | undefined,
    toMainAgentId: string,
    childId: string,
  ): Promise<void> {
    if (!finishSubscriptions) return;
    const liveChild = deps.agentManager.getAgent(childId);
    if (!liveChild || liveChild.background || liveChild.internal) return;
    try {
      const registration = await finishSubscriptions.register({
        callerAgentId: toMainAgentId,
        childAgentId: childId,
        requireParentOwnership: true,
      });
      registration.accept();
    } catch (error) {
      logger.warn(
        { err: error, childId, newMainAgentId: toMainAgentId },
        "Failed to re-register finish subscription after main-chat migration",
      );
    }
  }

  async function migrateChildAgents(
    fromMainAgentId: string,
    toMainAgentId: string,
  ): Promise<number> {
    const candidateChildIds = await collectMigratableChildIds(fromMainAgentId, toMainAgentId);
    const finishSubscriptions = deps.finishSubscriptions?.();
    let migrated = 0;

    for (const childId of candidateChildIds) {
      await deps.agentManager.updateAgentMetadata(childId, {
        labels: {
          [PARENT_AGENT_ID_LABEL]: toMainAgentId,
        },
      });
      migrated += 1;
      await reRegisterMigratedFinishSubscription(finishSubscriptions, toMainAgentId, childId);
    }

    return migrated;
  }

  async function archiveReplacedMainChatAgent(
    oldMainAgentId: string,
    newMainAgentId: string,
  ): Promise<void> {
    // Demote role label before archiving so archive guards and active-main lookups only see the
    // replacement main chat, and children already reparented won't be cascade-archived.
    await deps.agentManager.updateAgentMetadata(oldMainAgentId, {
      labels: {
        [MAIN_CHAT_ROLE_LABEL]: MAIN_CHAT_FORMER_ROLE_VALUE,
        [MAIN_CHAT_REPLACED_BY_LABEL]: newMainAgentId,
      },
    });

    if (
      typeof deps.agentManager.hasInFlightRun === "function" &&
      deps.agentManager.hasInFlightRun(oldMainAgentId) &&
      typeof deps.agentManager.cancelAgentRun === "function"
    ) {
      await deps.agentManager.cancelAgentRun(oldMainAgentId).catch(() => undefined);
    }

    if (typeof deps.agentManager.clearAgentAttention === "function") {
      await deps.agentManager.clearAgentAttention(oldMainAgentId).catch(() => undefined);
    }

    const liveOld = deps.agentManager.getAgent(oldMainAgentId);
    if (liveOld && typeof deps.agentManager.archiveAgent === "function") {
      await deps.agentManager.archiveAgent(oldMainAgentId);
      return;
    }
    if (typeof deps.agentManager.archiveSnapshot === "function") {
      await deps.agentManager.archiveSnapshot(oldMainAgentId, new Date(getNowMs()).toISOString());
    }
  }

  function resolveReplacementProviderConfig(
    input: {
      provider?: string;
      model?: string;
      modeId?: string;
      thinkingOptionId?: string;
    },
    oldSnapshot: {
      provider: string;
      model: string | null;
      modeId: string | null;
      thinkingOptionId: string | null;
    },
  ): {
    provider: AgentProvider;
    providerChanged: boolean;
    model: string | null;
    modeId: string | null;
    thinkingOptionId: string | null;
  } {
    const parsedRequestedProvider = input.provider?.trim()
      ? parseProviderSpec(input.provider)
      : null;
    const nextProvider = (parsedRequestedProvider?.provider ??
      oldSnapshot.provider) as AgentProvider;
    const providerChanged = nextProvider !== oldSnapshot.provider;
    const requestedModel = input.model?.trim() || parsedRequestedProvider?.model?.trim() || null;

    let nextModel = requestedModel;
    if (!nextModel) {
      nextModel = providerChanged ? null : oldSnapshot.model;
    }

    let nextModeId: string | null;
    if (input.modeId !== undefined) {
      nextModeId = input.modeId.trim() || null;
    } else {
      nextModeId = providerChanged ? null : oldSnapshot.modeId;
    }

    let nextThinkingOptionId: string | null;
    if (input.thinkingOptionId !== undefined) {
      nextThinkingOptionId = input.thinkingOptionId.trim() || null;
    } else {
      nextThinkingOptionId = providerChanged ? null : oldSnapshot.thinkingOptionId;
    }

    return {
      provider: nextProvider,
      providerChanged,
      model: nextModel,
      modeId: nextModeId,
      thinkingOptionId: nextThinkingOptionId,
    };
  }

  function formatReplacementActivity(input: {
    mode: "clear" | "handoff";
    carryHandoffSummary: boolean;
    providerChanged: boolean;
    targetModelLabel: string;
    migratedPlans: number;
    migratedTasks: number;
    migratedDecisions: number;
    migratedChildAgents: number;
  }): { trigger: string; summary: string } {
    if (input.mode === "clear") {
      return {
        trigger: "user_clear",
        summary: input.providerChanged
          ? `已原位清空上下文并切换模型至 ${input.targetModelLabel}，迁移 ${input.migratedPlans} 个计划、${input.migratedTasks} 个任务、${input.migratedDecisions} 个决策与 ${input.migratedChildAgents} 个子会话`
          : `已原位清空上下文并归档旧会话，迁移 ${input.migratedPlans} 个计划、${input.migratedTasks} 个任务、${input.migratedDecisions} 个决策与 ${input.migratedChildAgents} 个子会话`,
      };
    }
    if (input.carryHandoffSummary) {
      return {
        trigger: input.providerChanged ? "provider_switch_handoff" : "new_session_with_handoff",
        summary: input.providerChanged
          ? `已切换主对话模型至 ${input.targetModelLabel} 并带入交接摘要（迁移 ${input.migratedTasks} 个任务与 ${input.migratedChildAgents} 个子会话）`
          : `已开启新主对话并完成交接摘要与督办权转移（迁移 ${input.migratedTasks} 个任务与 ${input.migratedChildAgents} 个子会话）`,
      };
    }
    return {
      trigger: "new_session",
      summary: input.providerChanged
        ? `已切换主对话模型至 ${input.targetModelLabel} 并完成督办权转移（迁移 ${input.migratedChildAgents} 个子会话）`
        : `已开启全新主对话并完成督办权转移（迁移 ${input.migratedChildAgents} 个子会话）`,
    };
  }

  async function resolveExistingMainChatForReplacement(requestedMainAgentId?: string) {
    const trimmed = requestedMainAgentId?.trim();
    if (!trimmed) return findExistingMainChat();
    const workspaceId =
      deps.agentManager.getAgent(trimmed)?.workspaceId ??
      (await deps.agentStorage.get(trimmed))?.workspaceId ??
      (await resolveMainChatWorkspace()).workspaceId;
    return { agentId: trimmed, workspaceId };
  }

  async function replaceMainChatSession(input: {
    requestedMainAgentId?: string;
    mode: "clear" | "handoff";
    carryHandoffSummary: boolean;
    title?: string;
    provider?: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
  }): Promise<MainChatNewSessionResult> {
    return runWithLifecycleLock(async () => {
      await store.load();
      const existing = await resolveExistingMainChatForReplacement(input.requestedMainAgentId);

      if (!existing) {
        const ensured = await ensureMainChatInternal({
          ...(input.provider ? { provider: input.provider } : {}),
          ...(input.model ? { model: input.model } : {}),
          ...(input.modeId ? { modeId: input.modeId } : {}),
          ...(input.thinkingOptionId ? { thinkingOptionId: input.thinkingOptionId } : {}),
        });
        return {
          previousAgentId: null,
          agentId: ensured.agentId,
          workspaceId: ensured.workspaceId,
          handoffSummary: null,
          migratedPlans: 0,
          migratedDecisions: 0,
          migratedChildAgents: 0,
        };
      }

      const oldMainAgentId = existing.agentId;
      const oldSnapshot = await resolveMainAgentSnapshot(oldMainAgentId);
      const workspace = await resolveMainChatWorkspace();
      const nextTitle = input.title?.trim() || store.getSettings().title;

      let handoffSummary: string | null = null;
      if (input.mode === "handoff" && input.carryHandoffSummary) {
        const fleet = await contextSnapshots.collectFleet(oldMainAgentId, { bypassCache: true });
        const plans = store.listPlans(oldMainAgentId);
        const openDecisions = store
          .listDecisions(oldMainAgentId)
          .filter((decision) => !decision.answeredAt);
        const recentMessages = extractRecentTimelineMessages(oldMainAgentId);
        handoffSummary = buildMainChatHandoffSummary({
          previousAgentId: oldMainAgentId,
          fleet,
          plans,
          openDecisions,
          recentMessages,
        });
      }

      const nextConfig = resolveReplacementProviderConfig(input, oldSnapshot);

      // Create replacement main chat first so any creation failure leaves old main chat intact.
      const created = await createCleanMainChatAgent({
        workspaceId: existing.workspaceId || workspace.workspaceId,
        cwd: oldSnapshot.cwd || workspace.cwd,
        title: nextTitle,
        provider: nextConfig.provider,
        model: nextConfig.model,
        modeId: nextConfig.modeId,
        thinkingOptionId: nextConfig.thinkingOptionId,
      });

      const migratedChildAgents = await migrateChildAgents(oldMainAgentId, created.agentId);
      const storeMigration = await store.migrateMainAgent(oldMainAgentId, created.agentId);
      await routinesManager
        ?.rebindMainAgentRoutines(oldMainAgentId, created.agentId)
        .catch((error) => {
          logger.warn(
            { err: error, oldMainAgentId, nextMainAgentId: created.agentId },
            "Failed to rebind main-chat routines to replacement agent",
          );
        });
      await conversationManager.load();
      await conversationManager.rebindMainConversationAgent(created.agentId, created.workspaceId);

      if (handoffSummary) {
        await store.setPendingHandoffSummary(created.agentId, handoffSummary);
      }

      turnQueue.clearAgentState(oldMainAgentId);
      cacheKeepalive.clearAgent(oldMainAgentId);
      compactionStatusByAgent.delete(oldMainAgentId);
      lastPrecompactWatermarkByAgent.delete(oldMainAgentId);
      contextSnapshots.resetDelta(oldMainAgentId);
      contextSnapshots.resetDelta(created.agentId);
      contextSnapshots.invalidateCache();

      await archiveReplacedMainChatAgent(oldMainAgentId, created.agentId);

      const nowIso = new Date(getNowMs()).toISOString();
      const { trigger: activityTrigger, summary: activitySummary } = formatReplacementActivity({
        mode: input.mode,
        carryHandoffSummary: input.carryHandoffSummary,
        providerChanged: nextConfig.providerChanged,
        targetModelLabel: formatProviderModel(nextConfig.provider, nextConfig.model),
        migratedPlans: storeMigration.migratedPlans,
        migratedTasks: storeMigration.migratedTasks,
        migratedDecisions: storeMigration.migratedDecisions,
        migratedChildAgents,
      });
      await store.appendActivity({
        id: makeId("act"),
        mainAgentId: created.agentId,
        kind: input.mode === "clear" ? "clear" : "handoff",
        trigger: activityTrigger,
        summary: activitySummary,
        silent: false,
        status: "completed",
        createdAt: nowIso,
        completedAt: nowIso,
        relatedAgentId: oldMainAgentId,
        detail: handoffSummary,
      });

      return {
        previousAgentId: oldMainAgentId,
        agentId: created.agentId,
        workspaceId: created.workspaceId,
        handoffSummary,
        migratedPlans: storeMigration.migratedPlans,
        migratedDecisions: storeMigration.migratedDecisions,
        migratedChildAgents,
      };
    });
  }

  function applyOptionalNullablePatch(
    patchValue: string | null | undefined,
    currentValue: string | null,
  ): string | null {
    if (patchValue === undefined) return currentValue;
    return patchValue?.trim() || null;
  }

  async function resolvePatchedPlannedTaskLocation(
    existing: MainChatPlannedTask,
    nextTitle: string,
    nextServerId: string | null,
    patchedCwd: string | null | undefined,
  ): Promise<{ cwd: string | null; workspaceId: string | null; workspaceLabel: string }> {
    if (patchedCwd === undefined) {
      return {
        cwd: existing.cwd,
        workspaceId: existing.workspaceId,
        workspaceLabel: existing.workspaceLabel,
      };
    }
    if (patchedCwd === null) {
      if (!existing.workspaceId) {
        throw new Error(`任务「${nextTitle}」必须保留有效的 cwd 或 workspaceId`);
      }
      return {
        cwd: null,
        workspaceId: existing.workspaceId,
        workspaceLabel: existing.workspaceLabel,
      };
    }
    const location = await resolvePlannedTaskLocation(
      nextTitle,
      undefined,
      patchedCwd,
      nextServerId,
    );
    const sameCwd = existing.cwd !== null && path.resolve(existing.cwd) === location.cwd;
    return {
      cwd: location.cwd,
      workspaceId: sameCwd ? existing.workspaceId : null,
      workspaceLabel: location.workspaceLabel,
    };
  }

  async function applyPatchToPlannedTask(
    planMainAgentId: string,
    existing: MainChatPlannedTask,
    patch: MainChatPlanTaskPatch,
  ): Promise<MainChatPlannedTask> {
    const nextTitle = patch.title !== undefined ? patch.title.trim() : existing.title;
    if (!nextTitle) {
      throw new Error("任务标题 title 不能为空");
    }
    const nextMode = patch.mode ?? existing.mode;
    const validatedBrief = validateTaskBriefInput({
      title: nextTitle,
      goal: patch.goal !== undefined ? patch.goal : existing.goal,
      mode: nextMode,
      doneWhen: patch.doneWhen !== undefined ? trimList(patch.doneWhen) : existing.doneWhen,
      outOfBounds:
        patch.outOfBounds !== undefined ? trimList(patch.outOfBounds) : existing.outOfBounds,
    });
    const nextServerId = applyOptionalNullablePatch(
      patch.serverId,
      existing.serverId ?? deps.serverId,
    );
    const location = await resolvePatchedPlannedTaskLocation(
      existing,
      nextTitle,
      nextServerId,
      patch.cwd,
    );
    const nextProvider = applyOptionalNullablePatch(patch.provider, existing.provider);
    const mainSnapshot = await resolveMainAgentSnapshot(planMainAgentId).catch(() => null);
    const nowMs = getNowMs();
    const expectedMinutes = estimateExpectedMinutes(
      store.listDurationSamples(nowMs),
      {
        serverId: nextServerId,
        cwd: location.cwd,
        mode: nextMode,
        provider: nextProvider ?? mainSnapshot?.provider ?? null,
      },
      nowMs,
    );

    return {
      ...existing,
      title: nextTitle,
      goal: validatedBrief.goal,
      mode: nextMode,
      isolation: patch.isolation ?? existing.isolation,
      serverId: nextServerId,
      cwd: location.cwd,
      workspaceId: location.workspaceId,
      workspaceLabel: location.workspaceLabel,
      doneWhen: validatedBrief.doneWhen,
      outOfBounds: validatedBrief.outOfBounds,
      provider: nextProvider,
      modeId: applyOptionalNullablePatch(patch.modeId, existing.modeId),
      thinkingOptionId: applyOptionalNullablePatch(
        patch.thinkingOptionId,
        existing.thinkingOptionId,
      ),
      branchName: applyOptionalNullablePatch(patch.branchName, existing.branchName),
      baseBranch: applyOptionalNullablePatch(patch.baseBranch, existing.baseBranch),
      quiet: patch.quiet !== undefined ? patch.quiet : existing.quiet,
      expectedMinutes,
    };
  }

  async function observeManualAutoStartApproval(task: MainChatPlannedTask): Promise<void> {
    if (!task.cwd || task.mode !== "write") return;
    const nowMs = getNowMs();
    const nowIso = new Date(nowMs).toISOString();
    const existingAuths = store.listStandingAuthorizations({ includeRevoked: false });
    const existingSuggestions = store.listRuleSuggestions({ includeDismissed: true });

    const preview = recordManualApprovalObservation({
      scope: "auto_start",
      serverId: task.serverId ?? deps.serverId,
      localServerId: deps.serverId,
      cwd: task.cwd,
      mode: task.mode,
      existingObservation: null,
      existingAuthorizations: existingAuths,
      existingSuggestions,
      threshold: deps.ruleSuggestionThreshold,
      nowIso,
      nowMs,
    });
    if (!preview.eligible || !preview.observationKey) return;

    const persisted = store.getManualApprovalObservation(preview.observationKey);
    const evaluated = recordManualApprovalObservation({
      scope: "auto_start",
      serverId: task.serverId ?? deps.serverId,
      localServerId: deps.serverId,
      cwd: task.cwd,
      mode: task.mode,
      existingObservation: persisted,
      existingAuthorizations: existingAuths,
      existingSuggestions,
      threshold: deps.ruleSuggestionThreshold,
      nowIso,
      nowMs,
    });
    if (evaluated.observation) {
      await store.putManualApprovalObservation(evaluated.observation);
    }
    if (evaluated.suggestion) {
      await store.putRuleSuggestion(evaluated.suggestion);
    }
  }

  async function recordPlanStartPreferences(
    plan: MainChatPlanRecord,
    selected: ReadonlySet<string> | undefined,
    rememberAutoStart: boolean,
  ): Promise<void> {
    if (rememberAutoStart) {
      for (const task of plan.tasks) {
        if (selected && !selected.has(task.id)) continue;
        if (!task.cwd) continue;
        await store.addTrustRule(task.cwd, task.mode, {
          serverId: task.serverId ?? deps.serverId,
          hostLabel: task.hostLabel ?? null,
          allowSubdirectories: true,
        });
      }
      return;
    }
    if (plan.status !== "open") return;
    for (const task of plan.tasks) {
      if (selected && !selected.has(task.id)) continue;
      await observeManualAutoStartApproval(task);
    }
  }

  interface ResolvedClarificationTarget {
    toolName: string;
    toolTitle: string | null;
    description: string | null;
    kind: string | null;
    command: string | null;
    inputSummary: string | null;
    serverId: string | null;
    recentAssistantText: string | null;
  }

  function formatPermissionInputSummary(input: Record<string, unknown> | null | undefined): {
    command: string | null;
    inputSummary: string | null;
  } {
    if (!input) return { command: null, inputSummary: null };
    const rawCommand = input.command ?? input.cmd;
    const command = typeof rawCommand === "string" && rawCommand.trim() ? rawCommand.trim() : null;
    try {
      const serialized = JSON.stringify(input);
      return { command, inputSummary: serialized.length > 2 ? serialized.slice(0, 180) : null };
    } catch {
      return { command, inputSummary: null };
    }
  }

  function extractRecentAssistantText(agentId: string): string | null {
    const timeline = deps.agentManager.getTimeline(agentId);
    for (let i = timeline.length - 1; i >= 0; i -= 1) {
      const item = timeline[i];
      if (item && item.type === "assistant_message" && item.text.trim()) {
        return item.text.trim().slice(-240);
      }
    }
    return null;
  }

  async function resolveClarificationTarget(input: {
    agentId: string;
    serverId?: string | null;
    permissionRequestId: string;
  }): Promise<ResolvedClarificationTarget> {
    const live = deps.agentManager.getAgent(input.agentId);
    const localPerm = live?.pendingPermissions.get(input.permissionRequestId);
    if (localPerm) {
      const { command, inputSummary } = formatPermissionInputSummary(localPerm.input ?? null);
      return {
        toolName: localPerm.name || localPerm.title || "待审批工具",
        toolTitle: localPerm.title ?? null,
        description: localPerm.description ?? null,
        kind: localPerm.kind ?? null,
        command,
        inputSummary,
        serverId: trimOptional(input.serverId) ?? deps.serverId,
        recentAssistantText: extractRecentAssistantText(input.agentId),
      };
    }

    const requestedServer = trimOptional(input.serverId);
    if (requestedServer && requestedServer !== deps.serverId) {
      const snapshot = await fleetAggregator.collectFleet().catch(() => null);
      const remoteAgent = snapshot?.agents.find(
        (entry) => entry.serverId === requestedServer && entry.agentId === input.agentId,
      );
      const remotePerm = remoteAgent?.pendingPermissions.find(
        (perm) => perm.requestId === input.permissionRequestId,
      );
      if (remotePerm) {
        return {
          toolName: remotePerm.name || remotePerm.title || "待审批工具",
          toolTitle: remotePerm.title,
          description: remotePerm.description,
          kind: remotePerm.kind ?? null,
          command: null,
          inputSummary: remotePerm.description,
          serverId: requestedServer,
          recentAssistantText: null,
        };
      }
    }

    throw new Error(
      `找不到待审批权限请求：agent=${input.agentId}, permissionRequestId=${input.permissionRequestId}`,
    );
  }

  function validateGrantStandingAuthorizationInput(input: {
    scope: MainChatStandingAuthorizationScope;
    serverId?: string | null;
    cwd?: string | null;
    allowSubdirectories?: boolean;
    toolName?: string | null;
    commandPrefix?: string | null;
    mode?: MainChatTaskMode | null;
    label?: string;
    reason?: string | null;
    expiresAt?: string | null;
  }): Omit<
    MainChatStandingAuthorization,
    "id" | "createdAt" | "lastMatchedAt" | "matchCount" | "revokedAt"
  > {
    const serverId = trimOptional(input.serverId);
    const rawCwd = trimOptional(input.cwd);
    const cwd = rawCwd ? normalizeTrustCwd(rawCwd) : null;
    const expiresAt = trimOptional(input.expiresAt);
    if (expiresAt !== null && !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error(`无效的过期时间 expiresAt：${expiresAt}`);
    }

    if (input.scope === "auto_start") {
      if (!cwd) {
        throw new Error("自动开工常驻授权（auto_start）必须指定目标目录 cwd");
      }
      if (!input.mode) {
        throw new Error("自动开工常驻授权（auto_start）必须指定任务模式 mode（readonly/write）");
      }
      return {
        scope: "auto_start",
        serverId,
        cwd,
        allowSubdirectories: input.allowSubdirectories ?? true,
        toolName: null,
        commandPrefix: null,
        mode: input.mode,
        label:
          trimOptional(input.label) ??
          buildStandingAuthorizationLabel({ scope: "auto_start", mode: input.mode, cwd }),
        reason: trimOptional(input.reason),
        expiresAt,
      };
    }

    const toolName = trimOptional(input.toolName);
    if (!toolName) {
      throw new Error("工具权限常驻授权（permission）必须指定 toolName");
    }
    const rawPrefix = trimOptional(input.commandPrefix);
    const redLine = checkRedLineGuard({
      kind: "tool",
      toolName,
      command: rawPrefix,
    });
    if (redLine.blocked) {
      throw new Error(redLine.reason ?? "命中安全红线，禁止创建该常驻授权");
    }
    let normalizedPrefix: string | null = null;
    if (rawPrefix !== null) {
      const candidate = extractMainChatPermissionRuleCandidate({
        kind: "tool",
        name: toolName,
        input: { command: rawPrefix },
      });
      if (!candidate || !candidate.commandPrefix) {
        throw new Error("包含复合连接符或高危命令前缀，禁止创建常驻授权");
      }
      normalizedPrefix = candidate.commandPrefix;
    }

    return {
      scope: "permission",
      serverId,
      cwd,
      allowSubdirectories: input.allowSubdirectories ?? false,
      toolName,
      commandPrefix: normalizedPrefix,
      mode: null,
      label:
        trimOptional(input.label) ??
        buildStandingAuthorizationLabel({
          scope: "permission",
          toolName,
          commandPrefix: normalizedPrefix,
          cwd,
        }),
      reason: trimOptional(input.reason),
      expiresAt,
    };
  }

  function startActiveRuntime(): void {
    if (runtimeActive) {
      supervisor.refreshSchedule();
      return;
    }
    runtimeActive = true;
    fleetAggregator.start();
    if (!unsubscribeFleetEvents) {
      unsubscribeFleetEvents = fleetBridge.subscribeFleetEvents({
        onInvalidateSnapshot: () => {
          contextSnapshots.invalidateCache();
        },
        onPermissionRequested: (event) => {
          if (!event.isLocal) {
            supervisor.handleRemotePermissionRequested(event);
          }
        },
        onPermissionResolved: (event) => {
          if (event.serverId !== deps.serverId) {
            supervisor.handleRemotePermissionResolved(event);
          }
        },
        onHostsChanged: () => {
          scheduleAdmissionQueueDrain();
        },
        onAgentsChanged: (event) => {
          if (event.serverId !== deps.serverId) {
            supervisor.handleRemoteAgentsChanged(event);
          }
          scheduleAdmissionQueueDrain();
        },
      });
    }
    if (!unsubscribeGitSnapshots && deps.workspaceGitService) {
      unsubscribeGitSnapshots = deps.workspaceGitService.onSnapshotUpdated((snapshot) => {
        void handleWorkspaceGitSnapshotInternal(snapshot).catch((error) => {
          logger.warn({ err: error }, "Failed to handle workspace git snapshot for delivery gate");
        });
      });
    }
    turnQueue.start();
    supervisor.start();
    cacheKeepalive.start();
    if (!idlePrecompactTimer && idlePrecompactCheckIntervalMs > 0) {
      idlePrecompactTimer = setInterval(() => {
        void checkIdlePrecompactionInternal().catch((error) => {
          logger.warn({ err: error }, "Idle pre-compaction check failed");
        });
      }, idlePrecompactCheckIntervalMs);
      idlePrecompactTimer.unref?.();
    }
  }

  function stopActiveRuntime(): void {
    runtimeActive = false;
    cacheKeepalive.stop();
    if (idlePrecompactTimer) {
      clearInterval(idlePrecompactTimer);
      idlePrecompactTimer = null;
    }
    unsubscribeGitSnapshots?.unsubscribe();
    unsubscribeGitSnapshots = null;
    unsubscribeFleetEvents?.();
    unsubscribeFleetEvents = null;
    fleetAggregator.stop();
    supervisor.stop();
    turnQueue.stop();
  }

  function syncRuntimeEnabledState(): void {
    if (!serviceStarted) return;
    if (isMainChatEnabled(store.getSettings())) {
      startActiveRuntime();
    } else {
      stopActiveRuntime();
    }
  }

  async function maybeMigrateLegacyDefaultOptIn(): Promise<void> {
    if (store.isOptInMigrated()) return;
    const settings = store.getSettings();
    const currentScope = resolveMainChatFleetScope(settings, deps.serverId);
    const hasExistingMainChat = (await findExistingMainChat()) !== null;
    const hasExplicitRemoteScope =
      currentScope.mode === "allowlist" && currentScope.hostServerIds.length > 0;
    const hasRealActivity =
      hasExistingMainChat ||
      hasExplicitRemoteScope ||
      store.listTasks({ includeCompleted: true }).length > 0 ||
      store.listPlans().length > 0 ||
      store.listReceipts().length > 0 ||
      store.getTokenUsageSummary(getNowMs()).allTime.turns > 0;

    if (isMainChatEnabled(settings) && !hasRealActivity) {
      await store.completeOptInMigration({ disableDefault: true });
      logger.info("Migrated unused legacy main-chat host to opt-in unmanaged state");
      return;
    }

    await store.completeOptInMigration({ disableDefault: false });
  }

  function extractLiveMainModelBinding(
    liveMain: ManagedAgent | null | undefined,
  ): { provider: string; model: string | null; thinkingOptionId: string | null } | null {
    if (!liveMain) return null;
    return {
      provider: liveMain.provider,
      model: liveMain.runtimeInfo?.model ?? liveMain.config.model ?? null,
      thinkingOptionId: liveMain.config.thinkingOptionId ?? null,
    };
  }

  async function validateModelConfigPatchAtomic(
    previous: MainChatSettings,
    patch: MainChatSettingsPatch,
  ): Promise<void> {
    if (!patch.modelConfig) return;
    const availableProviders = readAvailableProvidersForModelValidation();
    if (patch.modelConfig.slots) {
      validateModelSlotsAtomic(patch.modelConfig.slots, availableProviders);
    }
    if (!patch.modelConfig.applyProfileId && !patch.modelConfig.rollbackProfile) return;
    const existingMain = await findExistingMainChat();
    const liveMain = existingMain ? deps.agentManager.getAgent(existingMain.agentId) : null;
    computeAtomicModelProfileSwitch({
      currentSettings: previous,
      profileId: patch.modelConfig.applyProfileId,
      rollback: patch.modelConfig.rollbackProfile,
      actor: "user",
      liveMainBinding: extractLiveMainModelBinding(liveMain),
      availableProviders,
      nowIso: new Date(getNowMs()).toISOString(),
    });
  }

  async function syncLiveMainModelAfterProfileSwitch(
    liveMain: ManagedAgent | null | undefined,
    saved: MainChatSettings,
  ): Promise<void> {
    const nextMainSlot = resolveMainChatModelConfig(saved).slots?.main ?? null;
    if (
      !liveMain ||
      !nextMainSlot ||
      liveMain.provider !== nextMainSlot.provider ||
      liveMain.lifecycle === "running" ||
      typeof deps.agentManager.setAgentModel !== "function"
    ) {
      return;
    }
    try {
      await deps.agentManager.setAgentModel(liveMain.id, nextMainSlot.model ?? null);
    } catch (error) {
      logger.warn(
        { err: error, agentId: liveMain.id },
        "Failed to sync live Main Chat model after atomic profile switch",
      );
    }
  }

  function assertManagedTaskRecordRetryable(
    existing: MainChatTaskRecord | null,
    taskId: string,
  ): MainChatTaskRecord {
    if (!existing) {
      throw new Error(
        `找不到受管任务「${taskId}」：一键换模型重试仅支持主对话受管任务，严禁操作用户手动会话`,
      );
    }
    if (!existing.mainAgentId?.trim()) {
      throw new Error("该任务未归属主对话受管上下文，禁止执行换模型重试");
    }
    if (
      existing.status === "completed" ||
      existing.status === "cancelled" ||
      Boolean(existing.supersededByTaskId)
    ) {
      throw new Error(`任务「${existing.title}」已处于终态（${existing.status}），无法换模型重试`);
    }
    return existing;
  }

  function pickFirstNonEmptyString(
    candidates: readonly (string | null | undefined)[],
  ): string | null {
    for (const item of candidates) {
      if (item) return item;
    }
    return null;
  }

  function extractPreviousAgentModelSpec(
    livePrev: ManagedAgent | null | undefined,
    storedPrev: Awaited<ReturnType<AgentStorage["get"]>>,
    existing: MainChatTaskRecord,
  ): {
    currentProvider: string | null;
    currentModel: string | null;
    fromModelSpec: string | null;
  } {
    const currentProvider = pickFirstNonEmptyString([
      livePrev?.provider,
      storedPrev?.provider,
      existing.lastProvider,
    ]);
    const currentModel = pickFirstNonEmptyString([
      livePrev?.runtimeInfo?.model,
      livePrev?.config.model,
      storedPrev?.runtimeInfo?.model,
      storedPrev?.config?.model,
      existing.lastModel,
    ]);
    const fromModelSpec = currentProvider
      ? formatMainChatModelSpec(currentProvider, currentModel)
      : null;
    return { currentProvider, currentModel, fromModelSpec };
  }

  async function resolveManagedFailedTaskForRetry(taskId: string): Promise<{
    existing: MainChatTaskRecord;
    previousAgentId: string | null;
    currentProvider: string | null;
    currentModel: string | null;
    fromModelSpec: string | null;
  }> {
    const existing = assertManagedTaskRecordRetryable(resolveTaskRecordByRef({ taskId }), taskId);
    const previousAgentId = existing.activeAgentId ?? existing.agentIds.at(-1) ?? null;
    const livePrev = previousAgentId ? deps.agentManager.getAgent(previousAgentId) : null;
    const storedPrev =
      !livePrev && previousAgentId ? await deps.agentStorage.get(previousAgentId) : null;
    const prevLabels = livePrev?.labels ?? storedPrev?.labels;

    // Hard redline: NEVER touch Main Chat itself, former main chat, or handoff-interrupted sessions!
    if (
      isMainChatLabels(prevLabels) ||
      isFormerMainChatLabels(prevLabels) ||
      hasHandoffBlockLabel(prevLabels)
    ) {
      throw new Error(
        `任务「${existing.title}」关联会话属于 handoff 中断/替换或主对话自身，严禁一键换模型重试`,
      );
    }

    const isFailedOrError =
      existing.status === "failed" ||
      livePrev?.lifecycle === "error" ||
      storedPrev?.lastStatus === "error";
    if (!isFailedOrError) {
      throw new Error(
        `仅支持对失败/错误状态的主对话受管任务执行换模型重试（当前状态：${existing.status}）`,
      );
    }

    const modelInfo = extractPreviousAgentModelSpec(livePrev, storedPrev, existing);
    return { existing, previousAgentId, ...modelInfo };
  }

  function collectTaskAttemptedFallbackSpecs(existing: MainChatTaskRecord): Set<string> {
    const lineageAgentIds = new Set<string>(existing.agentIds);
    if (existing.activeAgentId) lineageAgentIds.add(existing.activeAgentId);
    const attemptedSpecs = new Set<string>();
    for (const evt of store.listLimitFallbackEvents(50)) {
      if (!lineageAgentIds.has(evt.agentId)) continue;
      attemptedSpecs.add(
        `${evt.fromProvider.trim().toLowerCase()}::${(evt.fromModel?.trim() ?? "").toLowerCase()}`,
      );
      attemptedSpecs.add(
        `${evt.toProvider.trim().toLowerCase()}::${(evt.toModel?.trim() ?? "").toLowerCase()}`,
      );
    }
    return attemptedSpecs;
  }

  async function persistRetryTaskFallbackArtifacts(input: {
    existing: MainChatTaskRecord;
    linkedPlan: MainChatPlanRecord | null;
    matchedPlannedTask: MainChatPlannedTask | undefined;
    spawnedTask: MainChatPlannedTask;
    previousAgentId: string | null;
    currentProvider: string | null;
    currentModel: string | null;
    fromModelSpec: string | null;
    toModelSpec: string;
    toProvider: string;
    toModel: string | null;
    retryReason: string;
    nowIso: string;
  }): Promise<MainChatLimitFallbackEvent> {
    if (input.linkedPlan && input.matchedPlannedTask) {
      await store.putPlan({
        ...input.linkedPlan,
        status: "started",
        startedAt: input.linkedPlan.startedAt ?? input.nowIso,
        tasks: input.linkedPlan.tasks.map((item) =>
          item.id === input.matchedPlannedTask?.id ? input.spawnedTask : item,
        ),
      });
    }
    if (input.previousAgentId) {
      await store.removeTriage(input.previousAgentId);
    }
    const fallbackEvent: MainChatLimitFallbackEvent = {
      id: makeId("lfb"),
      agentId: input.spawnedTask.agentId!,
      agentRole: "managed_task",
      fromProvider: input.currentProvider ?? "unknown",
      fromModel: input.currentModel,
      toProvider: input.toProvider,
      toModel: input.toModel,
      reason: input.retryReason.slice(0, 180),
      createdAt: input.nowIso,
    };
    await store.appendLimitFallbackEvent(fallbackEvent);
    await store.appendActivity({
      id: makeId("act"),
      mainAgentId: input.existing.mainAgentId,
      kind: "background_turn",
      trigger: "retry_task_with_fallback",
      summary: `受管任务「${input.existing.title}」已切换备用模型重试（${input.fromModelSpec ?? "原模型"} → ${input.toModelSpec}）`,
      silent: false,
      status: "completed",
      createdAt: input.nowIso,
      completedAt: input.nowIso,
      relatedAgentId: input.spawnedTask.agentId!,
      detail: input.retryReason,
    });
    return fallbackEvent;
  }

  function isManagedByMainChatOrTask(agentId: string): boolean {
    const trimmed = agentId.trim();
    if (!trimmed) return false;
    if (isManagedConversationAgent(trimmed)) return true;
    if (store.findTaskByAgentId(trimmed) !== null) return true;
    const live = deps.agentManager.getAgent(trimmed);
    if (live) {
      const parentId = getParentAgentIdFromLabels(live.labels);
      const taskMeta = getMainChatTaskMetaFromLabels(live.labels);
      if (parentId && taskMeta?.planId) return true;
    }
    return false;
  }

  const serviceInstance: MainChatService = {
    async start() {
      serviceStarted = true;
      await store.load();
      await lessonsStore.load();
      await conversationManager.load();
      await maybeMigrateLegacyDefaultOptIn();
      await syncMainChatTitlesToSettings();
      syncRuntimeEnabledState();
      await feishuBridge.syncInitialActiveState();
    },

    stop() {
      serviceStarted = false;
      stopActiveRuntime();
      feishuBridge.stop();
    },

    async ensureMainChat(input) {
      if (!ensureInFlight) {
        ensureInFlight = ensureMainChatInternal(input).finally(() => {
          ensureInFlight = null;
        });
      }
      return ensureInFlight;
    },

    async getSettings() {
      await store.load();
      return store.getSettings();
    },

    getCurrentSettings() {
      return store.getSettings();
    },

    getNightModeStatus() {
      return supervisor.getNightModeStatus();
    },

    async getTokenUsage() {
      await store.load();
      return store.getTokenUsageSummary(getNowMs());
    },

    async resetTokenUsage() {
      await store.load();
      lastCumulativeCostByAgent.clear();
      return store.resetTokenUsage();
    },

    async updateSettings(patch) {
      await store.load();
      if (patch.compaction?.idlePrecompactMinIdleMin !== undefined) {
        idlePrecompactMinIdlePatched = true;
      }
      const previous = store.getSettings();
      await validateModelConfigPatchAtomic(previous, patch);
      const previousScope = resolveMainChatFleetScope(previous, deps.serverId);
      const normalizedPatch: MainChatSettingsPatch = patch.fleetScope
        ? {
            ...patch,
            fleetScope: normalizeMainChatFleetScope(
              {
                mode: patch.fleetScope.mode ?? previousScope.mode,
                hostServerIds: patch.fleetScope.hostServerIds ?? previousScope.hostServerIds,
              },
              deps.serverId,
            ),
          }
        : patch;
      const updated = await store.updateSettings(normalizedPatch);
      const updatedScope = resolveMainChatFleetScope(updated, deps.serverId);
      const scopeChanged =
        previousScope.mode !== updatedScope.mode ||
        previousScope.hostServerIds.length !== updatedScope.hostServerIds.length ||
        previousScope.hostServerIds.some((id, index) => updatedScope.hostServerIds[index] !== id);

      if (scopeChanged) {
        fleetAggregator.reconcileScope();
        supervisor.reconcileRemoteHostScope();
        contextSnapshots.invalidateCache();
      }
      syncRuntimeEnabledState();
      supervisor.refreshSchedule();
      if (patch.resourceAdmission !== undefined) {
        scheduleAdmissionQueueDrain();
      }

      const existing = await findExistingMainChat();
      if (!existing) {
        if (updated.title !== previous.title || patch.title !== undefined) {
          await syncMainChatTitlesToSettings(null, { force: true });
        }
        return updated;
      }

      contextSnapshots.resetDelta(existing.agentId);
      if (updated.title !== previous.title || patch.title !== undefined) {
        await syncMainChatTitlesToSettings(existing, { force: true });
      }
      return updated;
    },

    async triggerPatrol(options) {
      await store.load();
      const existing = await findExistingMainChat();
      const mainAgentId = options?.mainAgentId ?? existing?.agentId ?? null;
      return supervisor.runPatrol({
        mainAgentId,
        forceWakeup: options?.forceWakeup ?? true,
        manualTrigger: true,
      });
    },

    beginForegroundUserSend(agentId) {
      if (!isMainChatEnabled(store.getSettings())) {
        return null;
      }
      const live = deps.agentManager.getAgent(agentId);
      if (live && !isMainChatLabels(live.labels)) {
        return null;
      }
      return turnQueue.beginForegroundDispatch(agentId);
    },

    abortForegroundUserSend(agentId) {
      turnQueue.abortForegroundDispatch(agentId);
    },

    isCompacting(agentId) {
      return compactionInFlightByAgent.has(agentId) || turnQueue.isCompacting(agentId);
    },

    async prepareUserPromptForMainChat(agentId, prompt, options) {
      const live = deps.agentManager.getAgent(agentId);
      const stored = live ? null : await deps.agentStorage.get(agentId);
      const labels = live?.labels ?? stored?.labels;
      if (!isMainChatLabels(labels)) {
        return prompt;
      }
      await store.load();
      if (!isMainChatEnabled(store.getSettings())) {
        return prompt;
      }
      supervisor.notifyUserForegroundActivity(getNowMs());
      cacheKeepalive.notifyRealActivity(agentId);
      const preemption = await turnQueue.preemptForForegroundUser(agentId);
      let pendingBackground = preemption.waitingForBackground ?? null;
      let pendingCompaction = compactionInFlightByAgent.get(agentId) ?? null;
      if (pendingBackground || pendingCompaction) {
        // 压缩进行中不强行取消，先通知调用方进入排队态并等待压缩完成再基于最新上下文发送。
        options?.onDeferredForCompaction?.();
        while (pendingBackground || pendingCompaction) {
          const currentBackground = pendingBackground;
          const currentCompaction = pendingCompaction;
          pendingBackground = null;
          await Promise.all([
            currentBackground?.catch(() => undefined),
            currentCompaction?.catch(() => undefined),
          ]);
          const nextCompaction = compactionInFlightByAgent.get(agentId) ?? null;
          pendingCompaction = nextCompaction === currentCompaction ? null : nextCompaction;
        }
        supervisor.notifyUserForegroundActivity(getNowMs());
        cacheKeepalive.notifyRealActivity(agentId);
      }
      const handoffSummary = await store.consumePendingHandoffSummary(agentId);
      const snapshot = await contextSnapshots.buildTurnContext(agentId, {
        foreground: true,
        forceFull: Boolean(handoffSummary),
        handoffSummary,
      });
      const prefix = `${wrapMainChatContextBlock(snapshot)}\n\n`;
      if (typeof prompt === "string") {
        return `${prefix}${prompt}`;
      }
      return [{ type: "text", text: prefix }, ...prompt];
    },

    async getCompactionState(mainAgentId) {
      await store.load();
      const targetId = mainAgentId?.trim() || (await findExistingMainChat())?.agentId || null;
      return buildCompactionState(targetId);
    },

    async compactMainChat(mainAgentId, options) {
      await store.load();
      const targetId = await resolveRequiredMainAgentId(mainAgentId);
      return runCompactionExecution(targetId, {
        reason: options?.reason ?? "manual",
        instructions: options?.instructions,
      });
    },

    async checkIdlePrecompaction(mainAgentId) {
      return checkIdlePrecompactionInternal(mainAgentId);
    },

    async clearMainChatContext(mainAgentId, options) {
      const result = await replaceMainChatSession({
        requestedMainAgentId: mainAgentId,
        mode: "clear",
        carryHandoffSummary: false,
        provider: options?.provider,
        model: options?.model,
        modeId: options?.modeId,
        thinkingOptionId: options?.thinkingOptionId,
      });
      return {
        previousAgentId: result.previousAgentId,
        agentId: result.agentId,
        workspaceId: result.workspaceId,
        migratedPlans: result.migratedPlans,
        migratedDecisions: result.migratedDecisions,
        migratedChildAgents: result.migratedChildAgents,
      };
    },

    async startNewMainChatSession(mainAgentId, options) {
      return replaceMainChatSession({
        requestedMainAgentId: mainAgentId,
        mode: "handoff",
        carryHandoffSummary: options?.carryHandoffSummary ?? true,
        title: options?.title,
        provider: options?.provider,
        model: options?.model,
        modeId: options?.modeId,
        thinkingOptionId: options?.thinkingOptionId,
      });
    },

    async listActivity(options) {
      await store.load();
      return store.listActivities(options);
    },

    async listFleetSessions(mainAgentId) {
      await store.load();
      return contextSnapshots.collectFleet(mainAgentId);
    },

    async createPlan(mainAgentId, input) {
      await store.load();
      if (!input.tasks || input.tasks.length === 0) {
        throw new Error("task_plan 至少需要包含 1 个任务");
      }

      const mainSnapshot = await resolveMainAgentSnapshot(mainAgentId).catch(() => null);
      const liveMain = deps.agentManager.getAgent(mainAgentId);
      const conversationId =
        trimOptional(input.conversationId) ??
        (typeof liveMain?.labels?.[MAIN_CHAT_CONVERSATION_ID_LABEL] === "string"
          ? liveMain.labels[MAIN_CHAT_CONVERSATION_ID_LABEL].trim() || null
          : null);

      const plannedTasks: MainChatPlannedTask[] = [];
      let allEligibleForAutoStart = true;

      for (let index = 0; index < input.tasks.length; index += 1) {
        const built = await buildPlannedTask(input.tasks[index]!, index, {
          defaultProvider: mainSnapshot?.provider ?? null,
        });
        plannedTasks.push(built.task);
        if (!built.autoStartEligible && input.autoStart !== true) {
          allEligibleForAutoStart = false;
        }
      }

      const validatedPlannedTasks = resolvePlanBatchDagLinks(plannedTasks);

      const plan: MainChatPlanRecord = {
        id: makeId("plan"),
        mainAgentId,
        conversationId,
        status: "open",
        autoStarted: allEligibleForAutoStart,
        summary: input.summary?.trim() || null,
        createdAt: new Date(getNowMs()).toISOString(),
        startedAt: null,
        cancelledAt: null,
        withdrawnAt: null,
        withdrawReason: null,
        tasks: validatedPlannedTasks,
      };
      await store.putPlan(plan);
      await store.incrementMetric("plansCreated");
      contextSnapshots.invalidateCache();

      if (allEligibleForAutoStart) {
        const started = await spawnTasksForPlan(plan);
        await store.incrementMetric("plansAutoStarted");
        contextSnapshots.invalidateCache();
        return started;
      }
      return plan;
    },

    async startPlan(planId, options) {
      await store.load();
      return runWithPlanLock(planId, async () => {
        const existing = store.getPlan(planId);
        if (!existing) {
          throw new Error(`找不到任务计划：${planId}`);
        }
        if (existing.status === "cancelled") {
          throw new Error("该任务计划已取消，无法启动");
        }
        if (existing.status === "withdrawn") {
          throw new Error("该任务计划已撤回，无法启动");
        }
        const selected = options?.taskIds?.length ? new Set(options.taskIds) : undefined;
        await recordPlanStartPreferences(existing, selected, options?.rememberAutoStart === true);
        if (existing.status === "started" && existing.tasks.every((task) => task.agentId)) {
          return existing;
        }
        const started = await spawnTasksForPlan(existing, selected);
        if (existing.status === "open") {
          await store.incrementMetric("plansStarted");
        }
        contextSnapshots.invalidateCache();
        return started;
      });
    },

    async cancelPlan(planId) {
      await store.load();
      return runWithPlanLock(planId, async () => {
        const existing = store.getPlan(planId);
        if (!existing) {
          throw new Error(`找不到任务计划：${planId}`);
        }
        if (existing.status === "started") {
          throw new Error("该任务计划已经开始，无法取消；请直接操作对应的子 Agent");
        }
        if (existing.status === "withdrawn") {
          throw new Error("该任务计划已撤回，无法取消");
        }
        if (existing.status === "cancelled") {
          return existing;
        }
        const cancelled: MainChatPlanRecord = {
          ...existing,
          status: "cancelled",
          cancelledAt: new Date(getNowMs()).toISOString(),
        };
        await store.putPlan(cancelled);
        await store.incrementMetric("plansCancelled");
        contextSnapshots.invalidateCache();
        return cancelled;
      });
    },

    getPlan(planId) {
      return store.getPlan(planId);
    },

    listPlans(mainAgentId) {
      return store.listPlans(mainAgentId);
    },

    async listTasks(mainAgentId) {
      await store.load();
      const plans = store.listPlans(mainAgentId);
      const summaries: MainChatTaskLiveSummary[] = [];
      const seenAgentIds = new Set<string>();

      for (const plan of plans) {
        for (const task of plan.tasks) {
          if (task.agentId) seenAgentIds.add(task.agentId);
          const liveStatus = await resolvePlannedTaskLiveStatus(plan, task);
          summaries.push({
            planId: plan.id,
            taskId: task.id,
            title: task.title,
            goal: task.goal,
            mode: task.mode,
            agentId: task.agentId,
            status: liveStatus.status,
            pendingPermissions: liveStatus.pendingPermissions,
            cwd: task.cwd,
            workspaceId: task.workspaceId,
            planStatus: plan.status,
            startError: task.startError,
          });
        }
      }

      for (const agent of deps.agentManager.listAgents()) {
        if (agent.background || seenAgentIds.has(agent.id)) continue;
        if (getParentAgentIdFromLabels(agent.labels) !== mainAgentId) continue;
        const meta = getMainChatTaskMetaFromLabels(agent.labels);
        const pendingPermissions = agent.pendingPermissions.size;
        summaries.push({
          planId: meta?.planId ?? null,
          taskId: meta?.taskId ?? null,
          title: agent.config.title?.trim() || agent.id,
          goal: meta?.goal ?? null,
          mode: meta?.mode ?? null,
          agentId: agent.id,
          status: pendingPermissions > 0 ? "needs_permission" : agent.lifecycle,
          pendingPermissions,
          cwd: agent.cwd,
          workspaceId: agent.workspaceId ?? null,
          planStatus: null,
          startError: null,
        });
      }

      return summaries;
    },

    async reworkTask(_mainAgentId, input) {
      await store.load();
      const gaps = trimList(input.gaps);
      if (gaps.length === 0) {
        throw new Error("task_rework 至少需要列出 1 条具体缺口 gaps");
      }

      const targetMeta = await resolveReworkTargetMeta(input);
      const taskRecord = resolveTaskRecordByRef({
        taskId: targetMeta.taskId,
        agentId: input.agentId,
        planId: targetMeta.planId,
      });

      const { rework } = await dispatchReworkForAgent({
        agentId: input.agentId,
        title: targetMeta.title,
        planId: targetMeta.planId,
        taskId: targetMeta.taskId,
        taskRecord,
        gaps,
        note: trimOptional(input.note),
      });
      contextSnapshots.invalidateCache();
      return rework;
    },

    async askUserDecision(mainAgentId, input) {
      await store.load();
      const title = input.title.trim();
      const question = input.question.trim();
      if (!title || !question) {
        throw new Error("task_ask_user 需要提供 title 和 question");
      }
      if (!input.options || input.options.length < 2) {
        throw new Error("task_ask_user 至少需要提供 2 个明确选项");
      }
      const nowIso = new Date(getNowMs()).toISOString();
      const decision: MainChatDecisionRecord = {
        id: makeId("decision"),
        mainAgentId,
        title,
        question,
        agentId: trimOptional(input.agentId),
        planId: trimOptional(input.planId),
        taskId: trimOptional(input.taskId),
        options: input.options.map((option) => ({
          id: option.id.trim(),
          label: option.label.trim(),
          leadsTo: option.leadsTo.trim(),
        })),
        recommendedOptionId: trimOptional(input.recommendedOptionId),
        reason: trimOptional(input.reason),
        answer: null,
        answeredOptionId: null,
        answeredAt: null,
        createdAt: nowIso,
      };
      await store.putDecision(decision);
      await store.incrementMetric("interrupts");

      const linkedTask = resolveTaskRecordByRef({
        taskId: decision.taskId,
        agentId: decision.agentId,
        planId: decision.planId,
      });
      if (
        linkedTask &&
        linkedTask.status !== "completed" &&
        linkedTask.status !== "cancelled" &&
        linkedTask.status !== "parked"
      ) {
        await store.putTask({
          ...linkedTask,
          status: "needs_you",
          updatedAt: nowIso,
          lastActivityAt: nowIso,
        });
      }

      const escalatedFromTitle = trimOptional(input.escalatedFromTitle);
      if (escalatedFromTitle) {
        supervisor.enqueueSignal({
          kind: "escalated",
          urgency: "urgent",
          taskId: linkedTask?.id ?? decision.taskId,
          agentId: decision.agentId,
          serverId: linkedTask?.serverId ?? deps.serverId,
          conversationId: null,
          title: decision.title,
          summary: `方向主管「${escalatedFromTitle}」已升级待拍板项「${decision.title}」：${decision.question.slice(0, 120)}`,
          fingerprintSeed: `escalated:${decision.id}`,
          quiet: false,
          escalatedToUser: true,
        });
      }

      contextSnapshots.invalidateCache();
      feishuBridgeRef?.dispatchMainChatEvent({
        kind: "decision_created",
        decisionId: decision.id,
        title: decision.title,
        question: decision.question,
        options: decision.options,
        recommendedOptionId: decision.recommendedOptionId ?? null,
        reason: decision.reason ?? null,
        agentId: decision.agentId ?? null,
        taskId: decision.taskId ?? null,
        planId: decision.planId ?? null,
      });
      return decision;
    },

    async answerDecision(input) {
      await store.load();
      const existing = store.getDecision(input.decisionId);
      if (!existing) {
        throw new Error(`找不到对应的决策卡：${input.decisionId}`);
      }
      const answer = input.answer.trim();
      if (!answer) {
        throw new Error("决策回答不能为空");
      }
      if (existing.answeredAt) {
        return existing;
      }

      const nowIso = new Date(getNowMs()).toISOString();
      const updated: MainChatDecisionRecord = {
        ...existing,
        answer,
        answeredOptionId: trimOptional(input.optionId),
        answeredAt: nowIso,
      };
      await store.putDecision(updated);
      const linkedTask = await recordTaskDecisionEntry(
        {
          id: updated.id,
          taskId: updated.taskId,
          agentId: updated.agentId,
          planId: updated.planId,
          question: updated.question,
          answer,
        },
        "user",
        nowIso,
      );
      contextSnapshots.invalidateCache();

      const targetAgentId = updated.agentId ?? updated.mainAgentId;
      const prompt = [
        `【用户已拍板】任务「${updated.title}」`,
        `问题：${updated.question}`,
        `用户选择：${updated.answer}`,
        "请按照用户的决策继续推进。",
      ].join("\n");

      await sendPromptToAgent({
        agentId: targetAgentId,
        prompt,
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger,
        unarchive: false,
      });

      supervisor.enqueueSignal({
        kind: "decision_reply",
        urgency: "urgent",
        taskId: linkedTask?.id ?? updated.taskId,
        agentId: updated.agentId,
        serverId: linkedTask?.serverId ?? deps.serverId,
        conversationId: linkedTask?.conversationId ?? null,
        title: updated.title,
        summary: `用户已回复拍板「${updated.title}」：${(updated.answer ?? input.answer).slice(0, 120)}`,
        fingerprintSeed: `decision_reply:${updated.id}`,
        quiet: false,
      });

      feishuBridgeRef?.dispatchMainChatEvent({
        kind: "decision_answered",
        decisionId: updated.id,
        optionId: updated.answeredOptionId ?? null,
        answer: updated.answer ?? answer,
        source: "paseo",
      });

      return updated;
    },

    async getOverview(mainAgentId) {
      await store.load();
      await lessonsStore.load();
      const resolvedMainAgentId =
        mainAgentId?.trim() || (await findExistingMainChat())?.agentId || undefined;
      const activityListing = store.listActivities({
        mainAgentId: resolvedMainAgentId,
        limit: 200,
        includeSilent: true,
      });
      const recentReceipts: MainChatTaskReceipt[] = store
        .listReceipts(resolvedMainAgentId)
        .map((entry) => ({
          title: entry.title,
          summary: entry.summary,
          agentId: entry.agentId,
          planId: entry.planId,
          taskId: entry.taskId,
          checks: entry.checks,
          nextSteps: entry.nextSteps,
        }));
      const [conversations, fleetHostsResult, resourceAdmission] = await Promise.all([
        conversationManager.listConversations({ includeArchived: false }),
        fleetBridge.getFleetHosts().catch(() => ({ localServerId: deps.serverId, hosts: [] })),
        collectResourceAdmissionSnapshotInternal().catch(() => undefined),
      ]);
      const promptLibraryListing = listMergedPromptTemplates(store.listCustomPromptTemplates());
      // A steward's tray includes actions created under its active direction and side agents.
      // An overview requested for a single conversation remains scoped to that owner.
      const isRoot = conversations.some(
        (record) => record.kind === "main" && record.agentId === resolvedMainAgentId,
      );
      const owners = isRoot ? new Set(conversations.map((record) => record.agentId)) : undefined;
      const ownerId = isRoot ? undefined : resolvedMainAgentId;
      const tasks = await listTaskRecordsInternal({
        mainAgentId: ownerId,
        ownerAgentIds: owners,
        includeCompleted: true,
      });
      const plans = store
        .listPlans(ownerId)
        .filter((plan) => !owners || owners.has(plan.mainAgentId));
      const decisions = store
        .listDecisions(ownerId)
        .filter((decision) => !owners || owners.has(decision.mainAgentId));
      const triages = store.listTriages();
      const standingAuthorizations = store.listStandingAuthorizations({ includeRevoked: false });
      const ruleSuggestions = store.listRuleSuggestions({ includeDismissed: false });
      const pendingClarifications = store.listPendingClarifications();
      const nextStepSuggestions = buildNextStepSuggestions({
        tasks,
        plans,
        decisions,
        triages,
        recentReceipts,
        pendingClarifications,
      });
      return {
        supervisorHeldPermissions: supervisor
          .getApprovalTracker()
          .list()
          .filter((entry) => entry.tier !== "user")
          .map(({ serverId, agentId, requestId }) => ({ serverId, agentId, requestId })),
        plans,
        decisions,
        autoStartRules: store.listTrustRules(),
        permissionRules: store.listPermissionRules(),
        metrics: store.getMetrics(),
        settings: store.getSettings(),
        triages,
        lastPatrolAt: store.getLastPatrolAt(),
        lastWakeupAt: store.getLastWakeupAt(),
        compaction: buildCompactionState(resolvedMainAgentId ?? null),
        recentActivityCount: activityListing.total,
        backgroundBusy: resolvedMainAgentId
          ? turnQueue.isBackgroundBusy(resolvedMainAgentId)
          : false,
        queuedBackgroundCount: resolvedMainAgentId
          ? turnQueue.getQueuedCount(resolvedMainAgentId)
          : 0,
        tasks,
        conversations,
        fleetHosts: fleetHostsResult.hosts,
        recentReceipts,
        standingAuthorizations,
        ruleSuggestions,
        pendingClarifications,
        nextStepSuggestions,
        suppressedQuietBadgeCount: store.getSuppressedQuietBadgeCount(),
        pendingSignalCount: supervisor.getPendingSignalCount(),
        nightModeStatus: supervisor.getNightModeStatus(),
        cacheKeepaliveStatus: cacheKeepalive.getStatus(),
        tokenUsage: store.getTokenUsageSummary(getNowMs()),
        settingsProposals: store.listSettingsProposals({
          mainAgentId: resolvedMainAgentId ?? undefined,
          includeResolved: true,
        }),
        recentLimitFallbacks: store.listLimitFallbackEvents(12),
        projectLessonGroups: lessonsStore.listGroups(),
        notificationSummary: store.getNotificationSummary(),
        recentNotificationReceipts: store.listNotificationReceipts({ limit: 30 }),
        ...(resourceAdmission ? { resourceAdmission } : {}),
        idleArchiveAudit: store.listIdleArchiveAudit(20),
        promptLibraryCount: promptLibraryListing.templates.length,
      };
    },

    async addPermissionRule(input) {
      await store.load();
      return store.addPermissionRule(input);
    },

    async removeRule(kind, ruleId) {
      await store.load();
      if (kind === "auto_start") {
        return store.removeTrustRule(ruleId);
      }
      return store.removePermissionRule(ruleId);
    },

    async recordReceipt(receipt, mainAgentId) {
      await store.load();
      const resolvedMainId = mainAgentId ?? (await findExistingMainChat())?.agentId ?? null;
      const nowIso = new Date(getNowMs()).toISOString();
      await store.addReceipt(receipt, resolvedMainId);
      await store.incrementMetric("receiptsRecorded");

      const linkedTask = resolveTaskRecordByRef({
        taskId: receipt.taskId,
        agentId: receipt.agentId,
        planId: receipt.planId,
      });
      if (linkedTask && linkedTask.status !== "completed") {
        await syncTaskRecordCompleted(linkedTask, receipt, nowIso);
      }

      contextSnapshots.invalidateCache();
      return receipt;
    },

    getMetrics() {
      return store.getMetrics();
    },

    async updatePlanTask(planId, taskId, patch) {
      await store.load();
      return runWithPlanLock(planId, async () => {
        const plan = store.getPlan(planId);
        if (!plan) {
          throw new Error(`找不到任务计划：${planId}`);
        }
        if (plan.status !== "open") {
          throw new Error(`仅允许修改待开始（open）状态的计划任务，当前计划状态为：${plan.status}`);
        }

        const taskIndex = plan.tasks.findIndex((item) => item.id === taskId);
        if (taskIndex < 0) {
          throw new Error(`计划 ${planId} 中找不到任务：${taskId}`);
        }
        const updatedTask = await applyPatchToPlannedTask(
          plan.mainAgentId,
          plan.tasks[taskIndex]!,
          patch,
        );
        const updatedPlan: MainChatPlanRecord = {
          ...plan,
          tasks: plan.tasks.map((item, idx) => (idx === taskIndex ? updatedTask : item)),
        };
        await store.putPlan(updatedPlan);
        contextSnapshots.invalidateCache();
        return updatedPlan;
      });
    },

    async withdrawPlan(planId, reason) {
      await store.load();
      return runWithPlanLock(planId, async () => {
        const existing = store.getPlan(planId);
        if (!existing) {
          throw new Error(`找不到任务计划：${planId}`);
        }
        const trimmedReason = reason.trim();
        if (!trimmedReason) {
          throw new Error("撤回计划必须说明原因 reason");
        }
        if (existing.status === "withdrawn") {
          return existing;
        }
        if (existing.status !== "open") {
          throw new Error(`仅允许撤回待开始（open）状态的计划，当前计划状态为：${existing.status}`);
        }

        const nowIso = new Date(getNowMs()).toISOString();
        const withdrawn: MainChatPlanRecord = {
          ...existing,
          status: "withdrawn",
          withdrawnAt: nowIso,
          withdrawReason: trimmedReason,
        };
        await store.putPlan(withdrawn);

        // Clean up any unstarted orphan task records linked solely to this withdrawn plan.
        for (const plannedTask of existing.tasks) {
          if (plannedTask.continuesTaskId) continue;
          const record = store.getTask(plannedTask.taskRecordId ?? plannedTask.id);
          if (
            record &&
            record.planId === existing.id &&
            record.status === "open" &&
            record.agentIds.length === 0
          ) {
            await store.putTask({
              ...record,
              status: "cancelled",
              updatedAt: nowIso,
              lastActivityAt: nowIso,
            });
          }
        }

        contextSnapshots.invalidateCache();
        return withdrawn;
      });
    },

    async listTaskRecords(options) {
      return listTaskRecordsInternal(options);
    },

    async updateTaskScope(input) {
      await store.load();
      const existing = resolveTaskRecordByRef({ taskId: input.taskId });
      if (!existing) {
        throw new Error(`找不到对应的任务：${input.taskId}`);
      }
      if (existing.status === "completed" || existing.status === "cancelled") {
        throw new Error(`任务「${existing.title}」已结束（${existing.status}），无法修改范围`);
      }

      const nowIso = new Date(getNowMs()).toISOString();
      const { task: updated } = applyTaskScopeUpdate(
        existing,
        {
          goal: input.goal,
          doneWhen: input.doneWhen,
          outOfBounds: input.outOfBounds,
          reason: input.reason,
        },
        nowIso,
      );
      await store.putTask(updated);

      if (updated.planId) {
        const plan = store.getPlan(updated.planId);
        if (plan) {
          const nextPlanTasks = plan.tasks.map((item) =>
            item.taskRecordId === updated.id || item.id === updated.id
              ? {
                  ...item,
                  goal: updated.brief.goal,
                  doneWhen: updated.brief.doneWhen,
                  outOfBounds: updated.brief.outOfBounds,
                  scopeRevision: updated.brief.scopeRevision,
                }
              : item,
          );
          await store.putPlan({ ...plan, tasks: nextPlanTasks });
        }
      }

      if (updated.activeAgentId && updated.status !== "parked") {
        const live = deps.agentManager.getAgent(updated.activeAgentId);
        if (live && live.lifecycle !== "closed") {
          const noticePrompt = buildScopeRevisionNoticePrompt(updated, input.reason);
          try {
            await sendPromptToAgent({
              agentId: updated.activeAgentId,
              prompt: noticePrompt,
              agentManager: deps.agentManager,
              agentStorage: deps.agentStorage,
              logger,
              unarchive: false,
            });
          } catch (error) {
            logger.warn(
              { err: error, taskId: updated.id, agentId: updated.activeAgentId },
              "Failed to deliver scope revision notice to active child agent",
            );
          }
        }
      }

      contextSnapshots.invalidateCache();
      return updated;
    },

    async parkTask(input) {
      await store.load();
      const existing = resolveTaskRecordByRef({ taskId: input.taskId });
      if (!existing) {
        throw new Error(`找不到对应的任务：${input.taskId}`);
      }
      if (existing.status === "completed" || existing.status === "cancelled") {
        throw new Error(`任务「${existing.title}」已结束（${existing.status}），无法挂起或恢复`);
      }

      const nowIso = new Date(getNowMs()).toISOString();
      let updated: MainChatTaskRecord;
      if (input.parked) {
        updated = {
          ...existing,
          status: "parked",
          parkedAt: existing.parkedAt ?? nowIso,
          parkedReason: trimOptional(input.reason) ?? existing.parkedReason ?? null,
          updatedAt: nowIso,
          lastActivityAt: nowIso,
        };
      } else {
        const baseStatus = existing.activeAgentId ? "running" : "open";
        const liveAgent = existing.activeAgentId
          ? deps.agentManager.getAgent(existing.activeAgentId)
          : null;
        const triage = existing.activeAgentId ? store.getTriage(existing.activeAgentId) : null;
        const openDecisions = store
          .listDecisions(existing.mainAgentId)
          .filter((decision) => !decision.answeredAt);
        const hasOpenDecision = openDecisions.some(
          (decision) =>
            decision.taskId === existing.id ||
            (decision.agentId !== null &&
              (decision.agentId === existing.activeAgentId ||
                existing.agentIds.includes(decision.agentId))),
        );
        const resumedStatus = resolveEffectiveTaskStatus({
          task: { ...existing, status: baseStatus },
          liveAgent,
          triage,
          hasOpenDecision,
        });
        updated = {
          ...existing,
          status: resumedStatus,
          parkedAt: null,
          parkedReason: null,
          updatedAt: nowIso,
          lastActivityAt: nowIso,
        };
      }

      await store.putTask(updated);
      contextSnapshots.invalidateCache();
      return updated;
    },

    async reviewTask(input) {
      await store.load();
      const existing = resolveTaskRecordByRef({ taskId: input.taskId });
      if (!existing) {
        throw new Error(`找不到要验收的任务：${input.taskId}`);
      }

      const nowIso = new Date(getNowMs()).toISOString();
      if (input.verdict === "accept") {
        const latestGate = await resolveLatestDeliveryGateForReview(existing, input, nowIso);
        const gateOutcome = await enforceAcceptanceDeliveryGate(
          existing,
          latestGate,
          input,
          nowIso,
        );

        const receipt: MainChatTaskReceipt = {
          title: existing.title,
          summary: trimOptional(input.summary) ?? `任务「${existing.title}」已通过验收`,
          agentId: existing.activeAgentId ?? existing.agentIds.at(-1) ?? null,
          planId: existing.planId,
          taskId: existing.id,
          checks: input.checks ?? [],
          nextSteps: trimList(input.nextSteps),
        };
        await store.addReceipt(receipt, existing.mainAgentId);
        await store.incrementMetric("receiptsRecorded");
        const completedTask = await syncTaskRecordCompleted(
          existing,
          receipt,
          nowIso,
          gateOutcome.gate,
        );
        await distillAcceptanceLessonsSafe(completedTask, input, receipt);
        contextSnapshots.invalidateCache();
        return {
          task: completedTask,
          receipt,
          rework: null,
          deliveryGateWarning: gateOutcome.warning,
        };
      }

      const gaps = trimList(input.gaps);
      if (gaps.length === 0) {
        throw new Error("task_review 打回返工时至少需要列出 1 条具体缺口 gaps");
      }
      const targetAgentId = existing.activeAgentId ?? existing.agentIds.at(-1) ?? null;
      if (!targetAgentId) {
        throw new Error(`任务「${existing.title}」没有可返工的关联子 Agent`);
      }

      const { rework, task: reworkedTask } = await dispatchReworkForAgent({
        agentId: targetAgentId,
        title: existing.title,
        planId: existing.planId,
        taskId: existing.id,
        taskRecord: existing,
        gaps,
        note: trimOptional(input.note),
      });
      contextSnapshots.invalidateCache();
      return {
        task: reworkedTask ?? existing,
        receipt: null,
        rework,
        deliveryGateWarning: null,
      };
    },

    getConversationManager() {
      return conversationManager;
    },

    getFleetBridge() {
      return fleetBridge;
    },

    async reportLeaderProgress(input) {
      await store.load();
      const existingMain = await findExistingMainChat();
      if (!existingMain) {
        return { delivered: false, notice: "主对话尚未初始化，进度回报已跳过" };
      }
      const message = formatLeaderProgressMessage(input);
      supervisor.enqueueSignal({
        kind: "report",
        urgency: input.blockedItems.length > 0 ? "urgent" : "normal",
        taskId: null,
        agentId: input.leaderAgentId,
        serverId: deps.serverId,
        conversationId: null,
        title: input.conversationTitle,
        summary: `方向「${input.conversationTitle}」进度汇报：${input.summary.slice(0, 120)}`,
        fingerprintSeed: `leader_report:${input.conversationId}:${input.reportedAt}`,
        quiet: input.blockedItems.length === 0,
      });
      const result = await turnQueue.enqueueBackground({
        mainAgentId: existingMain.agentId,
        dedupeKey: `leader-progress:${input.conversationId}`,
        trigger: "leader_progress",
        summary: `方向「${input.conversationTitle}」进度汇报：${input.summary.slice(0, 80)}`,
        priority: input.blockedItems.length > 0 ? 70 : 30,
        buildPrompt: () => message,
      });
      return {
        delivered: result.status !== "skipped",
        reportId: result.activityId,
      };
    },

    async listConversations(options) {
      await store.load();
      await conversationManager.load();
      const existingMain = await findExistingMainChat();
      if (existingMain) {
        await conversationManager.ensureMainConversationRecord({
          agentId: existingMain.agentId,
          workspaceId: existingMain.workspaceId,
          title: store.getSettings().title,
          serverId: deps.serverId,
        });
      }
      return conversationManager.listConversations(options);
    },

    async createConversation(input) {
      await store.load();
      await conversationManager.load();
      let enrichedInput = input;
      if (input.kind === "leader" && !input.provider) {
        const existingMain = await findExistingMainChat();
        const liveMain = existingMain ? deps.agentManager.getAgent(existingMain.agentId) : null;
        const slot = resolveSlotModelForDispatch({
          purpose: "directionLead",
          settings: store.getSettings(),
          liveMainBinding: liveMain
            ? {
                provider: liveMain.provider,
                model: liveMain.runtimeInfo?.model ?? liveMain.config.model ?? null,
                thinkingOptionId: liveMain.config.thinkingOptionId ?? null,
              }
            : null,
        });
        if (slot.provider) {
          enrichedInput = {
            ...input,
            provider: slot.provider,
            ...(input.model === undefined && slot.model ? { model: slot.model } : {}),
            ...(input.thinkingOptionId === undefined && slot.thinkingOptionId
              ? { thinkingOptionId: slot.thinkingOptionId }
              : {}),
          };
        }
      }
      const created = await conversationManager.createConversation(enrichedInput);
      contextSnapshots.invalidateCache();
      return created;
    },

    async updateConversation(input) {
      await store.load();
      await conversationManager.load();
      const updated = await conversationManager.updateConversation(input);
      contextSnapshots.invalidateCache();
      return updated;
    },

    async getFleetHosts(options) {
      await store.load();
      const result = await fleetBridge.getFleetHosts(options);
      return {
        ...result,
        fleetScope: resolveMainChatFleetScope(store.getSettings(), deps.serverId),
      };
    },

    isManagedConversationAgent,
    isHostAllowedForSteward,

    async clarifyPermission(input) {
      await store.load();
      const question = input.question.trim();
      if (!question) {
        throw new Error("澄清问题 question 不能为空");
      }
      const target = await resolveClarificationTarget({
        agentId: input.agentId,
        serverId: input.serverId,
        permissionRequestId: input.permissionRequestId,
      });
      const linkedTask = store.findTaskByAgentId(input.agentId);
      const { pausedDeadlineAt } = supervisor.pausePermissionForClarification({
        agentId: input.agentId,
        serverId: target.serverId,
        permissionRequestId: input.permissionRequestId,
        label: target.toolTitle ?? target.toolName,
        taskId: linkedTask?.id ?? null,
        conversationId: linkedTask?.conversationId ?? null,
      });

      const nowIso = new Date(getNowMs()).toISOString();
      const proofToken = clarificationProofs.issue({
        agentId: input.agentId,
        permissionRequestId: input.permissionRequestId,
        nowIso,
      });
      const redLine = checkRedLineGuard({
        kind: target.kind,
        toolName: target.toolName,
        command: target.command,
        question: target.description,
      });
      const answerContext: BuildClarificationAnswerInput = {
        question,
        toolName: target.toolName,
        toolTitle: target.toolTitle,
        description: target.description,
        command: target.command,
        inputSummary: target.inputSummary,
        task: linkedTask
          ? { title: linkedTask.title, mode: linkedTask.mode, brief: linkedTask.brief }
          : null,
        recentAssistantText: target.recentAssistantText,
        redLine,
      };

      let answer: string | null = null;
      if (deps.permissionClarifier) {
        try {
          const customAnswer = await deps.permissionClarifier(answerContext);
          if (customAnswer?.trim()) {
            answer = customAnswer.trim();
          }
        } catch (error) {
          logger.warn(
            { err: error, agentId: input.agentId, permissionRequestId: input.permissionRequestId },
            "Read-only permission clarifier failed; falling back to deterministic explanation",
          );
        }
      }
      if (!answer) {
        answer = buildDeterministicClarificationAnswer(answerContext);
      }

      const record = createApprovalClarificationRecord({
        agentId: input.agentId,
        serverId: target.serverId,
        permissionRequestId: input.permissionRequestId,
        question,
        answer,
        proofToken,
        pausedDeadlineAt,
        nowIso,
      });
      await store.putClarification(record);
      return record;
    },

    consumeClarificationProofToken(proofToken, expected) {
      return clarificationProofs.consume(proofToken, expected);
    },

    async listStandingAuthorizations(options) {
      await store.load();
      return {
        authorizations: store.listStandingAuthorizations(options),
        suggestions: store.listRuleSuggestions({ includeDismissed: false }),
      };
    },

    async grantStandingAuthorization(input) {
      await store.load();
      const validated = validateGrantStandingAuthorizationInput(input);
      const nowIso = new Date(getNowMs()).toISOString();
      const existing = store
        .listStandingAuthorizations({ includeRevoked: false })
        .find(
          (entry) =>
            entry.scope === validated.scope &&
            entry.serverId === validated.serverId &&
            entry.cwd === validated.cwd &&
            (entry.toolName?.toLowerCase() ?? null) ===
              (validated.toolName?.toLowerCase() ?? null) &&
            (entry.commandPrefix?.toLowerCase() ?? null) ===
              (validated.commandPrefix?.toLowerCase() ?? null) &&
            entry.mode === validated.mode,
        );

      const auth: MainChatStandingAuthorization = existing
        ? {
            ...existing,
            allowSubdirectories: validated.allowSubdirectories,
            label: validated.label,
            reason: validated.reason ?? existing.reason,
            expiresAt: validated.expiresAt,
            revokedAt: null,
          }
        : {
            id: `auth_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
            ...validated,
            createdAt: nowIso,
            lastMatchedAt: null,
            matchCount: 0,
            revokedAt: null,
          };

      const saved = await store.putStandingAuthorization(auth);
      if (input.suggestionId?.trim()) {
        await store.removeRuleSuggestion(input.suggestionId.trim());
      }
      contextSnapshots.invalidateCache();
      return saved;
    },

    async revokeStandingAuthorization(authorizationId) {
      await store.load();
      const result = await store.revokeStandingAuthorization(
        authorizationId,
        new Date(getNowMs()).toISOString(),
      );
      if (result.revoked) {
        contextSnapshots.invalidateCache();
      }
      return result;
    },

    async dismissRuleSuggestion(suggestionId) {
      await store.load();
      return store.dismissRuleSuggestion(suggestionId, new Date(getNowMs()).toISOString());
    },

    listPendingSignals(conversationId) {
      return supervisor.listPendingSignals(conversationId);
    },

    listTrackedApprovals() {
      return supervisor.getApprovalTracker().list();
    },

    async handleAgentArchived(agentId) {
      await store.load();
      await supervisor.handleAgentArchived(agentId);
    },

    async listMemoryFiles() {
      return memoryStore.listFiles();
    },

    async readMemoryFile(relativePath) {
      return memoryStore.readFile(relativePath);
    },

    async writeMemoryFile(relativePath, content) {
      return memoryStore.writeFile(relativePath, content);
    },

    async deleteMemoryFile(relativePath) {
      return memoryStore.deleteFile(relativePath);
    },

    async assembleMemoryContextForAgent(opening) {
      if ((opening?.purpose ?? "interactive") !== "interactive") {
        return null;
      }
      const labels = opening?.labels;
      if (!labels) return null;

      const isMain = isMainChatLabels(labels);
      const rawConvId =
        typeof labels[MAIN_CHAT_CONVERSATION_ID_LABEL] === "string"
          ? labels[MAIN_CHAT_CONVERSATION_ID_LABEL].trim()
          : "";
      const isManagedTask =
        typeof labels[MAIN_CHAT_TASK_ID_LABEL] === "string" ||
        typeof labels[MAIN_CHAT_TASK_PLAN_ID_LABEL] === "string";

      if (!isMain && !rawConvId) {
        return null;
      }

      await store.load();
      const settings = store.getSettings();
      const profile = resolveMainChatProfile(settings);

      if (isMain) {
        const memoryFiles = await memoryStore.readAllFilesForContext();
        const assembled = assembleMainChatMemoryContext({
          profile,
          memoryFiles,
        });
        return assembled.text || null;
      }

      await conversationManager.load();
      const conv = conversationManager.getConversation(rawConvId);
      if (!conv) return null;

      if (isManagedTask) {
        if (!conv.notes?.trim()) return null;
        const assembled = assembleMainChatMemoryContext({
          directionTitle: conv.title,
          directionNotes: conv.notes,
        });
        return assembled.text || null;
      }

      if (conv.kind === "leader") {
        // Direction notes are already injected via buildLeaderSystemPrompt on the leader's
        // static systemPrompt; append shared profile + persistent memory files here.
        const memoryFiles = await memoryStore.readAllFilesForContext();
        const assembled = assembleMainChatMemoryContext({
          profile,
          memoryFiles,
        });
        return assembled.text || null;
      }

      return null;
    },

    getCacheKeepaliveStatus() {
      return cacheKeepalive.getStatus();
    },

    async checkCacheKeepalive() {
      return cacheKeepalive.tick();
    },

    async listRoutines(options) {
      if (!routinesManager) return [];
      return routinesManager.listRoutines(options);
    },

    async createRoutine(input) {
      if (!routinesManager) {
        throw new Error("当前 Daemon 未启用定时任务调度服务，无法创建例行任务");
      }
      return routinesManager.createRoutine(input);
    },

    async pauseRoutine(routineId) {
      if (!routinesManager) {
        throw new Error("当前 Daemon 未启用定时任务调度服务");
      }
      return routinesManager.pauseRoutine(routineId);
    },

    async resumeRoutine(routineId) {
      if (!routinesManager) {
        throw new Error("当前 Daemon 未启用定时任务调度服务");
      }
      return routinesManager.resumeRoutine(routineId);
    },

    async runRoutineOnce(routineId) {
      if (!routinesManager) {
        throw new Error("当前 Daemon 未启用定时任务调度服务");
      }
      return routinesManager.runRoutineOnce(routineId);
    },

    async deleteRoutine(routineId) {
      if (!routinesManager) {
        throw new Error("当前 Daemon 未启用定时任务调度服务");
      }
      return routinesManager.deleteRoutine(routineId);
    },

    async executeScheduledAgentRoutine(schedule, runId) {
      if (!routinesManager) return null;
      return routinesManager.executeIfOwnedRoutine(schedule, runId);
    },

    async proposeSettingsPatch(input) {
      await store.load();
      const resolvedMainAgentId =
        input.mainAgentId?.trim() || (await findExistingMainChat())?.agentId || "main";
      const currentSettings = store.getSettings();
      const built = buildSettingsProposal(
        {
          mainAgentId: resolvedMainAgentId,
          title: input.title,
          reason: input.reason,
          changes: input.changes,
        },
        currentSettings,
        new Date(getNowMs()).toISOString(),
      );
      if (built.proposal) {
        await store.putSettingsProposal(built.proposal);
        contextSnapshots.invalidateCache();
      }
      return built;
    },

    async listSettingsProposals(options) {
      await store.load();
      return store.listSettingsProposals(options);
    },

    async resolveSettingsProposal(input) {
      await store.load();
      const existing = store.getSettingsProposal(input.proposalId);
      if (!existing) {
        throw new Error(`找不到配置变更提案：${input.proposalId}`);
      }
      if (existing.status !== "pending") {
        return {
          proposal: existing,
          settings: store.getSettings(),
          nightModeStatus: supervisor.getNightModeStatus(),
          cacheKeepaliveStatus: cacheKeepalive.getStatus(),
        };
      }

      const nowIso = new Date(getNowMs()).toISOString();
      const note = trimOptional(input.note);

      if (input.decision === "reject") {
        const rejected: MainChatSettingsProposalRecord = {
          ...existing,
          status: "rejected",
          resolvedAt: nowIso,
          resolvedNote: note,
          appliedError: null,
        };
        await store.putSettingsProposal(rejected);
        await store.appendActivity({
          id: makeId("act"),
          mainAgentId: existing.mainAgentId,
          kind: "background_turn",
          trigger: "settings_proposal_rejected",
          summary: `用户拒绝配置变更提案「${existing.title}」`,
          silent: true,
          status: "completed",
          createdAt: nowIso,
          completedAt: nowIso,
          detail: note,
        });
        contextSnapshots.invalidateCache();
        return {
          proposal: rejected,
          settings: store.getSettings(),
          nightModeStatus: supervisor.getNightModeStatus(),
          cacheKeepaliveStatus: cacheKeepalive.getStatus(),
        };
      }

      // Approve and apply validated patch.
      if (existing.patch.compaction?.idlePrecompactMinIdleMin !== undefined) {
        idlePrecompactMinIdlePatched = true;
      }
      const updatedSettings = await store.updateSettings(existing.patch);
      supervisor.refreshSchedule();
      syncRuntimeEnabledState();
      contextSnapshots.invalidateCache();

      const approved: MainChatSettingsProposalRecord = {
        ...existing,
        status: "approved",
        resolvedAt: nowIso,
        resolvedNote: note,
        appliedError: null,
      };
      await store.putSettingsProposal(approved);
      await store.appendActivity({
        id: makeId("act"),
        mainAgentId: existing.mainAgentId,
        kind: "background_turn",
        trigger: "settings_proposal_approved",
        summary: `用户确认应用配置变更「${existing.title}」`,
        silent: false,
        status: "completed",
        createdAt: nowIso,
        completedAt: nowIso,
        detail: existing.changes
          .map((c) => `${c.label}: ${c.beforeDisplay} → ${c.afterDisplay}`)
          .join("；"),
      });

      return {
        proposal: approved,
        settings: updatedSettings,
        nightModeStatus: supervisor.getNightModeStatus(),
        cacheKeepaliveStatus: cacheKeepalive.getStatus(),
      };
    },

    async listRecentLimitFallbacks(limit) {
      await store.load();
      return store.listLimitFallbackEvents(limit);
    },

    async tryLimitFallbackForAgent(agentId, errorMessage) {
      const live = deps.agentManager.getAgent(agentId);
      if (!live) {
        return { switched: false, reason: "agent_missing" };
      }
      return limitFallbackController.handleTurnLimitError(live, errorMessage);
    },

    async listLessons(options) {
      await lessonsStore.load();
      const projectKey = options?.projectKey?.trim() || undefined;
      return {
        groups: lessonsStore.listGroups({ projectKey }),
        lessons: lessonsStore.listLessons({ projectKey }),
      };
    },

    async addLesson(input) {
      await lessonsStore.load();
      const result = await lessonsStore.addLesson(input);
      contextSnapshots.invalidateCache();
      return result;
    },

    async deleteLesson(lessonId) {
      await lessonsStore.load();
      const result = await lessonsStore.deleteLesson(lessonId);
      if (result.deleted) {
        contextSnapshots.invalidateCache();
      }
      return { deleted: result.deleted };
    },

    async startReadyTask(taskId) {
      return startReadyTaskInternal(taskId);
    },

    async updateTaskDependencies(input) {
      await store.load();
      const existing = resolveTaskRecordByRef({ taskId: input.taskId });
      if (!existing) {
        throw new Error(`找不到要更新依赖的任务：${input.taskId}`);
      }
      if (existing.status === "completed" || existing.status === "cancelled") {
        throw new Error(`任务「${existing.title}」已结束（${existing.status}），无法修改依赖关系`);
      }

      const allTasks = store.listTasks({ includeCompleted: true });
      const normalized = validateTaskDagBatch(allTasks, [
        {
          id: existing.id,
          partOf: input.partOf !== undefined ? input.partOf : existing.partOf,
          after: input.after !== undefined ? input.after : existing.after,
        },
      ]);
      const links = normalized.get(existing.id)!;
      const nowIso = new Date(getNowMs()).toISOString();
      const tasksById = new Map(allTasks.map((entry) => [entry.id, entry]));
      const nextDepState = computeTaskDependencyState({ after: links.after }, tasksById);

      const updated: MainChatTaskRecord = {
        ...existing,
        partOf: links.partOf,
        after: links.after,
        dependencyState: nextDepState,
        autoStartOnReady:
          input.autoStartOnReady !== undefined
            ? input.autoStartOnReady
            : (existing.autoStartOnReady ?? false),
        updatedAt: nowIso,
        lastActivityAt: nowIso,
      };
      await store.putTask(updated);
      contextSnapshots.invalidateCache();
      return updated;
    },

    async syncTaskDeliveryGate(taskId, gatePatch) {
      await store.load();
      const existing = resolveTaskRecordByRef({ taskId });
      if (!existing) {
        throw new Error(`找不到对应的任务：${taskId}`);
      }
      const nowIso = new Date(getNowMs()).toISOString();
      const nextGate = mergeDeliveryGatePatch(existing.deliveryGate, gatePatch, nowIso);
      const { task } = await applyTaskDeliveryGate(existing, nextGate, nowIso);
      contextSnapshots.invalidateCache();
      return task;
    },

    async handleWorkspaceGitSnapshot(snapshot) {
      return handleWorkspaceGitSnapshotInternal(snapshot);
    },

    async switchModelProfile(input) {
      await store.load();
      const currentSettings = store.getSettings();
      const existingMain = await findExistingMainChat();
      const liveMain = existingMain ? deps.agentManager.getAgent(existingMain.agentId) : null;
      const availableProviders = readAvailableProvidersForModelValidation(liveMain?.cwd);
      const nowIso = new Date(getNowMs()).toISOString();

      const switched = computeAtomicModelProfileSwitch({
        currentSettings,
        profileId: input.profileId,
        rollback: input.rollback,
        actor: input.actor ?? "user",
        liveMainBinding: extractLiveMainModelBinding(liveMain),
        availableProviders,
        nowIso,
      });

      const saved = await store.replaceSettings(switched.nextSettings);
      supervisor.refreshSchedule();
      contextSnapshots.invalidateCache();
      await syncLiveMainModelAfterProfileSwitch(liveMain, saved);

      if (switched.event && existingMain) {
        const isRollback = switched.event.action === "rollback";
        const targetLabel = switched.activeProfileId ?? "自定义";
        await store.appendActivity({
          id: makeId("act"),
          mainAgentId: existingMain.agentId,
          kind: "background_turn",
          trigger: isRollback ? "model_profile_rollback" : "model_profile_switch",
          summary: isRollback
            ? `已回滚模型档位至「${targetLabel}」（影响 ${switched.changedSlots.length} 个槽位）`
            : `已原子切换模型档位至「${targetLabel}」（变更 ${switched.changedSlots.length} 个槽位）`,
          silent: false,
          status: "completed",
          createdAt: nowIso,
          completedAt: nowIso,
          detail: switched.changedSlots.join(", ") || null,
        });
      }

      return {
        settings: saved,
        activeProfileId: switched.activeProfileId,
        changedSlots: switched.changedSlots,
        event: switched.event,
      };
    },

    async retryTaskWithFallback(input) {
      await store.load();
      await lessonsStore.load();
      const { existing, previousAgentId, currentProvider, currentModel, fromModelSpec } =
        await resolveManagedFailedTaskForRetry(input.taskId);

      const picked = pickNextFallbackForFailedTask({
        currentProvider,
        currentModel,
        attemptedSpecs: collectTaskAttemptedFallbackSpecs(existing),
        settings: store.getSettings(),
        explicitOverride: input.provider
          ? {
              provider: input.provider,
              model: input.model ?? null,
              thinkingOptionId: input.thinkingOptionId ?? null,
            }
          : null,
        availableProviders: readAvailableProvidersForModelValidation(existing.cwd ?? undefined),
      });
      if (!picked) {
        throw new Error(
          "暂无可用的下一个备用模型：请在设置页「限额自动切备用模型」中添加备用模型，或手动指定目标模型",
        );
      }

      const toModelSpec = formatMainChatModelSpec(picked.provider, picked.model);
      const nowIso = new Date(getNowMs()).toISOString();
      const mainAgent = await resolveMainAgentSnapshot(existing.mainAgentId);
      const linkedPlan = existing.planId ? store.getPlan(existing.planId) : null;
      const matchedPlannedTask = linkedPlan?.tasks.find(
        (item) => item.taskRecordId === existing.id || item.id === existing.id,
      );
      const retryReason =
        input.reason?.trim() ||
        `失败任务一键切换模型续跑（${fromModelSpec ?? "原模型"} → ${toModelSpec}）`;
      const basePlannedTask = matchedPlannedTask ?? buildSyntheticPlannedTaskForReadyTask(existing);

      const spawnedTask = await spawnSinglePlannedTask({
        plan: linkedPlan ?? buildSyntheticPlanForReadyTask(existing, nowIso),
        task: {
          ...basePlannedTask,
          provider: toModelSpec,
          thinkingOptionId:
            picked.thinkingOptionId ?? input.thinkingOptionId ?? basePlannedTask.thinkingOptionId,
          continuesTaskId: existing.id,
          continuesWhy: retryReason,
          taskRecordId: existing.id,
        },
        mainAgent,
        nowIso,
      });
      if (!spawnedTask.agentId) {
        throw new Error(spawnedTask.startError ?? "切换备用模型重启子任务失败");
      }

      const fallbackEvent = await persistRetryTaskFallbackArtifacts({
        existing,
        linkedPlan,
        matchedPlannedTask,
        spawnedTask,
        previousAgentId,
        currentProvider,
        currentModel,
        fromModelSpec,
        toModelSpec,
        toProvider: picked.provider,
        toModel: picked.model,
        retryReason,
        nowIso,
      });

      const refreshedTask = store.getTask(existing.id) ?? existing;
      contextSnapshots.invalidateCache();
      return {
        task: refreshedTask,
        previousAgentId,
        newAgentId: spawnedTask.agentId,
        fromModelSpec,
        toModelSpec,
        fallbackEvent,
      };
    },

    async listNotificationReceipts(options) {
      await store.load();
      return {
        receipts: store.listNotificationReceipts(options),
        summary: store.getNotificationSummary(),
      };
    },

    async ackNotificationReceipt(input) {
      await store.load();
      const result = await store.ackNotificationReceipts({
        receiptId: input.receiptId,
        receiptIds: input.receiptIds,
        markAll: input.markAll,
        status: input.status ?? "read",
        nowIso: new Date(getNowMs()).toISOString(),
      });
      return {
        updatedCount: result.updatedCount,
        receipts: result.receipts,
        summary: store.getNotificationSummary(),
      };
    },

    getToolLoaderRegistry() {
      return toolLoaderRegistry;
    },

    async getResourceAdmission(options) {
      return collectResourceAdmissionSnapshotInternal(options);
    },

    async drainAdmissionQueue(input) {
      return drainAdmissionQueueInternal(input);
    },

    async sweepIdleSubagents(input) {
      return sweepIdleSubagentsInternal(input);
    },

    async listPromptLibrary() {
      await store.load();
      return listMergedPromptTemplates(store.listCustomPromptTemplates());
    },

    async savePromptTemplate(template) {
      await store.load();
      const existingCustom = store.listCustomPromptTemplates();
      const { saved, nextCustom } = upsertCustomPromptTemplate({
        template,
        existingCustom,
        nowIso: new Date(getNowMs()).toISOString(),
      });
      await store.setCustomPromptTemplates(nextCustom);
      const merged = listMergedPromptTemplates(nextCustom);
      return {
        template: saved,
        templates: merged.templates,
      };
    },

    async deletePromptTemplate(input) {
      await store.load();
      const existingCustom = store.listCustomPromptTemplates();
      const { deleted, nextCustom } = removeCustomPromptTemplate({
        id: input.id,
        slug: input.slug,
        existingCustom,
      });
      if (deleted) {
        await store.setCustomPromptTemplates(nextCustom);
      }
      const merged = listMergedPromptTemplates(nextCustom);
      return {
        deleted,
        templates: merged.templates,
      };
    },

    async getFeishuBridgeState(options) {
      return feishuBridge.getState(options);
    },

    async updateFeishuBridgeConfig(patch) {
      return feishuBridge.updateConfig(patch);
    },

    async testFeishuBridgeConnection(options) {
      return feishuBridge.testConnection(options);
    },

    async sendFeishuBridgeTestCard(options) {
      return feishuBridge.sendTestCard(options);
    },

    async listFeishuBridgeAudit(options) {
      return feishuBridge.listAudit(options);
    },

    async handleFeishuWebhook(request) {
      return feishuBridge.handleWebhookRequest(request);
    },
  };

  const feishuBridge = createFeishuBridgeSeam({
    pluginInvoker: deps.feishuPluginInvoker,
    resolveWebhookUrl: deps.resolveFeishuWebhookUrl,
    getSettings: () => store.getSettings(),
    isManagedAgent: isManagedByMainChatOrTask,
    hasPendingPermission: async ({ agentId, serverId, permissionRequestId }) => {
      const localLive = deps.agentManager.getAgent(agentId);
      if (localLive?.pendingPermissions.has(permissionRequestId)) {
        return true;
      }
      if (serverId && serverId !== deps.serverId) {
        const snapshot = await fleetAggregator.collectFleet().catch(() => null);
        const remoteAgent = snapshot?.agents.find(
          (entry) => entry.serverId === serverId && entry.agentId === agentId,
        );
        return Boolean(
          remoteAgent?.pendingPermissions.some((perm) => perm.requestId === permissionRequestId),
        );
      }
      return false;
    },
    respondToPermission: async ({ agentId, serverId, permissionRequestId, response }) => {
      if (serverId && serverId !== deps.serverId) {
        await fleetBridge.respondPermissionOnTargetHost(
          serverId,
          agentId,
          permissionRequestId,
          response,
        );
        return;
      }
      await deps.agentManager.respondToPermission(agentId, permissionRequestId, response);
    },
    getDecision: async (decisionId) => {
      await store.load();
      return store.getDecision(decisionId) ?? null;
    },
    answerDecision: (input) => serviceInstance.answerDecision(input),
    logger,
  });
  feishuBridgeRef = feishuBridge;

  return serviceInstance;
}
