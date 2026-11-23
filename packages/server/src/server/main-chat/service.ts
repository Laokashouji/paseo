import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import {
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
  getMainChatTaskMetaFromLabels,
  isMainChatLabels,
  type MainChatActivityEntry,
  type MainChatActivityKind,
  type MainChatCompactionReason,
  type MainChatCompactionState,
  type MainChatCompactionStatus,
  type MainChatCompactionStrategy,
  type MainChatConversationRecord,
  type MainChatDecisionOption,
  type MainChatDecisionRecord,
  type MainChatFleetHostStatus,
  type MainChatOverview,
  type MainChatPatrolResult,
  type MainChatPermissionRule,
  type MainChatPlanRecord,
  type MainChatPlanTaskPatch,
  type MainChatPlannedTask,
  type MainChatReceiptCheck,
  type MainChatReworkRecord,
  type MainChatRuleKind,
  type MainChatSettings,
  type MainChatSettingsPatch,
  type MainChatTaskDecisionActor,
  type MainChatTaskDecisionEntry,
  type MainChatTaskIsolation,
  type MainChatTaskMode,
  type MainChatTaskReceipt,
  type MainChatTaskRecord,
  type MainChatTaskReviewVerdict,
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
import type { AgentPromptInput, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { StructuredGenerationDaemonConfig } from "../agent/structured-generation-providers.js";
import type { TerminalManager } from "../../terminal/terminal-manager.js";
import type { PersistedWorkspaceRecord, WorkspaceRegistry } from "../workspace-registry.js";
import type { CreatePaseoWorktreeWorkflowFn } from "../worktree-session.js";
import { createAgentCommand, type EnsureWorkspaceForCreate } from "../agent/create-agent/create.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import { createPaseoWorktreeCommand } from "../worktree/commands.js";
import { expandUserPath } from "../path-utils.js";
import {
  createMainChatContextSnapshotBuilder,
  type FleetSnapshotSummary,
} from "./context-snapshot.js";
import {
  buildMainChatCompactionCheckpointPrompt,
  buildMainChatHandoffSummary,
  buildWorkerInitialPrompt,
} from "./prompts.js";
import { createMainChatStore, type MainChatMetrics, type MainChatStore } from "./store.js";
import { createMainChatSupervisor } from "./supervisor.js";
import {
  appendTaskDecision,
  applyTaskScopeUpdate,
  attachContinuationAgentToTask,
  buildScopeRevisionNoticePrompt,
  computeTaskDurationMinutes,
  createTaskRecordFromPlannedTask,
  estimateExpectedMinutes,
  formatTaskDecisionsPromptSection,
  resolveEffectiveTaskStatus,
  validateTaskBriefInput,
} from "./task-ledger.js";
import { createMainChatTurnQueue } from "./turn-queue.js";
import type { RunSemanticTriageInput, SemanticTriageOutput } from "./triage.js";

const MAX_REWORK_ROUNDS = 2;
export const DEFAULT_MAIN_CHAT_COMPACT_THRESHOLD_TOKENS = 400_000;
const IDLE_PRECOMPACT_RATIO = 0.75;
const DEFAULT_IDLE_PRECOMPACT_MIN_IDLE_MS = 10 * 60 * 1_000;
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
  ensureWorkspaceForCreate?: EnsureWorkspaceForCreate;
  createPaseoWorktree?: CreatePaseoWorktreeWorkflowFn;
  finishSubscriptions?: () => FinishSubscriptions;
  terminalManager?: TerminalManager | null;
  logger: Logger;
  transientRetryDelayMs?: number;
  usageLimitRetryDelayMs?: number;
  stalledThresholdMs?: number;
  stalledCheckIntervalMs?: number;
  triageSettleMs?: number;
  noProgressThresholdMs?: number;
  needsYouEscalateMs?: number;
  wakeupCooldownMs?: number;
  now?: () => number;
  snapshotCacheTtlMs?: number;
  snapshotForegroundTimeoutMs?: number;
  turnQueueDrainDelayMs?: number;
  compactThresholdTokens?: number;
  idlePrecompactMinIdleMs?: number;
  idlePrecompactCheckIntervalMs?: number;
}

export interface MainChatCompactOptions {
  reason?: MainChatCompactionReason;
  instructions?: string;
}

export interface MainChatCompactResult {
  mainAgentId: string;
  compaction: MainChatCompactionState;
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
  updateSettings(patch: MainChatSettingsPatch): Promise<MainChatSettings>;
  triggerPatrol(options?: {
    mainAgentId?: string;
    forceWakeup?: boolean;
  }): Promise<MainChatPatrolResult>;
  beginForegroundUserSend(agentId: string): (() => void) | null;
  abortForegroundUserSend(agentId: string): void;
  prepareUserPromptForMainChat(
    agentId: string,
    prompt: AgentPromptInput,
  ): Promise<AgentPromptInput>;
  getCompactionState(mainAgentId?: string): Promise<MainChatCompactionState>;
  compactMainChat(
    mainAgentId?: string,
    options?: MainChatCompactOptions,
  ): Promise<MainChatCompactResult>;
  checkIdlePrecompaction(mainAgentId?: string): Promise<boolean>;
  clearMainChatContext(mainAgentId?: string): Promise<MainChatClearResult>;
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
  }): Promise<{
    task: MainChatTaskRecord;
    receipt: MainChatTaskReceipt | null;
    rework: MainChatReworkRecord | null;
  }>;
  // M4 Multi-Conversation & Cross-Host Fleet contract (implemented by Wave 2 M4 backend)
  listConversations?(options?: {
    includeArchived?: boolean;
  }): Promise<MainChatConversationRecord[]>;
  createConversation?(input: {
    kind: "side" | "leader";
    title: string;
    directionSummary?: string | null;
    initialPrompt?: string;
    provider?: string;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
  }): Promise<MainChatConversationRecord>;
  updateConversation?(input: {
    conversationId: string;
    title?: string;
    directionSummary?: string | null;
    kind?: "side" | "leader";
    archived?: boolean;
  }): Promise<MainChatConversationRecord>;
  getFleetHosts?(options?: { forceRefresh?: boolean }): Promise<{
    localServerId: string | null;
    hosts: MainChatFleetHostStatus[];
  }>;
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

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function trimOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function trimList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((entry) => entry.trim()).filter(Boolean);
}

export function createMainChatService(deps: MainChatServiceDependencies): MainChatService {
  const logger = deps.logger.child({ module: "main-chat" });
  const getNowMs = deps.now ?? (() => Date.now());
  const configuredCompactThresholdTokens =
    deps.compactThresholdTokens ?? DEFAULT_MAIN_CHAT_COMPACT_THRESHOLD_TOKENS;
  const idlePrecompactMinIdleMs =
    deps.idlePrecompactMinIdleMs ?? DEFAULT_IDLE_PRECOMPACT_MIN_IDLE_MS;
  const idlePrecompactCheckIntervalMs =
    deps.idlePrecompactCheckIntervalMs ?? DEFAULT_IDLE_PRECOMPACT_CHECK_INTERVAL_MS;

  const store: MainChatStore = createMainChatStore(deps.paseoHome, { now: getNowMs });
  const contextSnapshots = createMainChatContextSnapshotBuilder({
    agentManager: deps.agentManager,
    agentStorage: deps.agentStorage,
    store,
    now: getNowMs,
    cacheTtlMs: deps.snapshotCacheTtlMs,
    foregroundTimeoutMs: deps.snapshotForegroundTimeoutMs,
  });

  const compactionStatusByAgent = new Map<string, MainChatCompactionStatus>();
  const compactionInFlightByAgent = new Map<string, Promise<MainChatCompactResult>>();
  const lastPrecompactWatermarkByAgent = new Map<string, number>();

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
  });

  const supervisor = createMainChatSupervisor({
    agentManager: deps.agentManager,
    agentStorage: deps.agentStorage,
    store,
    contextSnapshots,
    turnQueue,
    logger,
    providerSnapshotManager: deps.providerSnapshotManager,
    readDaemonConfig: deps.readDaemonConfig,
    onPatrolTick: async () => {
      await checkIdlePrecompactionInternal();
    },
    semanticTriageRunner: deps.semanticTriageRunner,
    transientRetryDelayMs: deps.transientRetryDelayMs,
    usageLimitRetryDelayMs: deps.usageLimitRetryDelayMs,
    stalledThresholdMs: deps.stalledThresholdMs,
    stalledCheckIntervalMs: deps.stalledCheckIntervalMs,
    triageSettleMs: deps.triageSettleMs,
    noProgressThresholdMs: deps.noProgressThresholdMs,
    needsYouEscalateMs: deps.needsYouEscalateMs,
    wakeupCooldownMs: deps.wakeupCooldownMs,
  });
  let ensureInFlight: Promise<EnsureMainChatResult> | null = null;
  let lifecycleLock: Promise<unknown> = Promise.resolve();
  let idlePrecompactTimer: ReturnType<typeof setInterval> | null = null;
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

  async function resolveDefaultMainChatProviderConfig(
    homeDir: string,
    requested?: EnsureMainChatInput,
  ): Promise<{
    provider: AgentProvider;
    model?: string;
    modeId?: string;
    thinkingOptionId?: string;
  }> {
    if (requested?.provider) {
      const parsed = parseProviderSpec(requested.provider);
      return {
        provider: parsed.provider,
        model: requested.model ?? parsed.model,
        modeId: requested.modeId,
        thinkingOptionId: requested.thinkingOptionId,
      };
    }

    const storedAgents = await deps.agentStorage.listActive();
    const recentCandidate = storedAgents
      .filter((record) => !record.archivedAt && !record.background)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (recentCandidate) {
      return {
        provider: recentCandidate.provider as AgentProvider,
        model: recentCandidate.config?.model ?? recentCandidate.runtimeInfo?.model ?? undefined,
        modeId: recentCandidate.config?.modeId ?? recentCandidate.lastModeId ?? undefined,
        thinkingOptionId: recentCandidate.config?.thinkingOptionId ?? undefined,
      };
    }

    return resolveSnapshotDefaultProvider(homeDir);
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
      if (decision.taskId === task.id) return true;
      if (decision.agentId === null) return false;
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
    conversationId?: string;
    includeCompleted?: boolean;
  }): Promise<MainChatTaskRecord[]> {
    await store.load();
    const includeCompleted = options?.includeCompleted ?? true;
    const mainAgentId = options?.mainAgentId?.trim() || undefined;
    const rawTasks = store.listTasks({
      mainAgentId,
      conversationId: options?.conversationId?.trim() || undefined,
      includeCompleted: true,
    });
    const openDecisions = store
      .listDecisions(mainAgentId)
      .filter((decision) => !decision.answeredAt);

    const resolved: MainChatTaskRecord[] = [];
    for (const task of rawTasks) {
      const liveAgent = task.activeAgentId ? deps.agentManager.getAgent(task.activeAgentId) : null;
      const storedStatus = liveAgent
        ? null
        : await resolveStoredAgentLastStatus(task.activeAgentId);
      const triage = task.activeAgentId ? store.getTriage(task.activeAgentId) : null;
      const effectiveStatus = resolveEffectiveTaskStatus({
        task,
        liveAgent,
        storedStatus,
        triage,
        hasOpenDecision: taskHasOpenDecision(task, openDecisions),
      });
      const isTerminal = effectiveStatus === "completed" || effectiveStatus === "cancelled";
      if (!includeCompleted && isTerminal) continue;
      resolved.push(effectiveStatus === task.status ? task : { ...task, status: effectiveStatus });
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
      quiet: item.quiet ?? true,
      scopeRevision: continuedTask?.brief.scopeRevision ?? 1,
      taskRecordId: continuedTask?.id ?? null,
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

  async function ensureMainChatInternal(
    input?: EnsureMainChatInput,
  ): Promise<EnsureMainChatResult> {
    await store.load();
    const existing = await findExistingMainChat();
    if (existing) return existing;

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

    return {
      agentId: snapshot.id,
      workspaceId: snapshot.workspaceId ?? workspace.workspaceId,
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
    workspaceId: string;
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
      await store.putTask(updatedRecord);
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
    await store.putTask(createdRecord);
  }

  function prepareSpawnTaskPromptAndLabels(input: {
    plan: MainChatPlanRecord;
    task: MainChatPlannedTask;
    continuedTask: MainChatTaskRecord | null;
    previousAgentId: string | null;
  }): {
    resolvedTaskRecordId: string;
    existingRecord: MainChatTaskRecord | null;
    preExistingDecisions: MainChatTaskDecisionEntry[];
    initialPrompt: string;
    labels: Record<string, string>;
    title: string;
  } {
    const { plan, task, continuedTask, previousAgentId } = input;
    const resolvedTaskRecordId = continuedTask ? continuedTask.id : (task.taskRecordId ?? task.id);
    const existingRecord = continuedTask ?? store.getTask(resolvedTaskRecordId);
    const preExistingDecisions =
      existingRecord?.decisions ??
      collectPreExistingDecisionsForTask(plan.mainAgentId, resolvedTaskRecordId);
    const activeBrief = existingRecord ? existingRecord.brief : null;
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
        brief: activeBrief,
        decisions: preExistingDecisions,
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
  }): Promise<MainChatPlannedTask> {
    const { plan, task, mainAgent, nowIso } = input;
    const continuedTask = task.continuesTaskId ? store.getTask(task.continuesTaskId) : null;
    let stoppedPreviousAgent = false;
    try {
      if (task.continuesTaskId && !continuedTask) {
        throw new Error(`找不到要续接的原任务：${task.continuesTaskId}`);
      }

      const previousAgentId = continuedTask ? continuedTask.activeAgentId : null;
      if (previousAgentId) {
        await stopPreviousTaskAgent(previousAgentId);
        stoppedPreviousAgent = true;
      }

      const target = await resolveTaskWorkspaceTarget(task);
      const prepared = prepareSpawnTaskPromptAndLabels({
        plan,
        task,
        continuedTask,
        previousAgentId,
      });
      const providerSpec =
        task.provider ?? formatProviderModel(mainAgent.provider, mainAgent.model);

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
          thinking: task.thinkingOptionId ?? mainAgent.thinkingOptionId ?? undefined,
          mode: task.modeId ?? mainAgent.modeId ?? undefined,
          labels: prepared.labels,
          promptFailure: "throw",
          notifyOnFinish: true,
          background: false,
          detached: false,
          callerAgentId: plan.mainAgentId,
        },
      );

      const resolvedWorkspaceId = snapshot.workspaceId ?? target.workspaceId;
      await persistSpawnedTaskRecord({
        plan,
        task,
        continuedTask,
        existingRecord: prepared.existingRecord,
        resolvedTaskRecordId: prepared.resolvedTaskRecordId,
        preExistingDecisions: prepared.preExistingDecisions,
        agentId: snapshot.id,
        cwd: target.cwd,
        workspaceId: resolvedWorkspaceId,
        nowIso,
      });

      return {
        ...task,
        cwd: target.cwd,
        workspaceId: resolvedWorkspaceId,
        agentId: snapshot.id,
        startedAt: nowIso,
        startError: null,
        taskRecordId: prepared.resolvedTaskRecordId,
      };
    } catch (error) {
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
      return { ...task, startError: message };
    }
  }

  async function spawnTasksForPlan(
    plan: MainChatPlanRecord,
    selectedTaskIds?: ReadonlySet<string>,
  ): Promise<MainChatPlanRecord> {
    const mainAgent = await resolveMainAgentSnapshot(plan.mainAgentId);
    const updatedTasks: MainChatPlannedTask[] = [];
    const nowIso = new Date(getNowMs()).toISOString();

    for (const task of plan.tasks) {
      if (task.agentId || (selectedTaskIds && !selectedTaskIds.has(task.id))) {
        updatedTasks.push(task);
        continue;
      }
      updatedTasks.push(await spawnSinglePlannedTask({ plan, task, mainAgent, nowIso }));
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

  async function syncTaskRecordCompleted(
    task: MainChatTaskRecord,
    receipt: MainChatTaskReceipt,
    nowIso: string,
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

    const completedTask: MainChatTaskRecord = {
      ...task,
      status: "completed",
      completedAt: nowIso,
      actualMinutes,
      parkedAt: null,
      parkedReason: null,
      latestReceipt: receipt,
      updatedAt: nowIso,
      lastActivityAt: nowIso,
    };
    await store.putTask(completedTask);
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

  function resolveCompactThresholdTokens(mainAgentId: string): number {
    const live = deps.agentManager.getAgent(mainAgentId);
    const maxTokens = live?.lastUsage?.contextWindowMaxTokens;
    if (typeof maxTokens === "number" && maxTokens > 0) {
      return Math.max(
        1_000,
        Math.min(configuredCompactThresholdTokens, Math.floor(maxTokens * 0.85)),
      );
    }
    return Math.max(1_000, configuredCompactThresholdTokens);
  }

  function buildCompactionState(mainAgentId: string | null): MainChatCompactionState {
    if (!mainAgentId) {
      return {
        status: "idle",
        estimatedTokens: 0,
        thresholdTokens: Math.max(1_000, configuredCompactThresholdTokens),
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
    return {
      status: derivedStatus,
      estimatedTokens: estimateContextTokens(mainAgentId),
      thresholdTokens: resolveCompactThresholdTokens(mainAgentId),
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
          const command = instructions?.trim() ? `/compact ${instructions.trim()}` : "/compact";
          const dispatch = await sendPromptToAgent({
            agentId: mainAgentId,
            prompt: command,
            agentManager: deps.agentManager,
            agentStorage: deps.agentStorage,
            logger,
            unarchive: false,
          });
          if (dispatch.disposition === "turn_started") {
            await dispatch.started;
          }
          summary = instructions?.trim()
            ? `已通过底层引擎原生 /compact 完成上下文压缩（${instructions.trim().slice(0, 80)}）`
            : "已通过底层引擎原生 /compact 完成上下文压缩";
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
          const dispatch = await sendPromptToAgent({
            agentId: mainAgentId,
            prompt: formatSystemNotificationPrompt(checkpointPrompt),
            agentManager: deps.agentManager,
            agentStorage: deps.agentStorage,
            logger,
            unarchive: false,
          });
          if (dispatch.disposition === "turn_started") {
            await dispatch.started;
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

  async function checkIdlePrecompactionInternal(requestedMainAgentId?: string): Promise<boolean> {
    await store.load();
    const mainAgentId = requestedMainAgentId ?? (await findExistingMainChat())?.agentId ?? null;
    if (!mainAgentId) return false;
    if (compactionInFlightByAgent.has(mainAgentId)) return false;
    if (turnQueue.isForegroundActive(mainAgentId) || turnQueue.isBackgroundBusy(mainAgentId)) {
      return false;
    }
    if (deps.agentManager.hasInFlightRun(mainAgentId)) {
      return false;
    }

    const live = deps.agentManager.getAgent(mainAgentId);
    if (!live || live.lifecycle === "running") return false;

    const lastActivityAtMs = turnQueue.getLastActivityAtMs(mainAgentId);
    const idleMs =
      lastActivityAtMs > 0
        ? turnQueue.getIdleDurationMs(mainAgentId)
        : Math.max(0, getNowMs() - live.updatedAt.getTime());
    if (idleMs < idlePrecompactMinIdleMs) {
      return false;
    }

    const watermark = lastPrecompactWatermarkByAgent.get(mainAgentId);
    if (watermark !== undefined && watermark === lastActivityAtMs) {
      return false;
    }

    const estimated = estimateContextTokens(mainAgentId);
    const threshold = resolveCompactThresholdTokens(mainAgentId);
    if (estimated < Math.floor(threshold * IDLE_PRECOMPACT_RATIO)) {
      return false;
    }

    const result = await turnQueue.enqueueBackground({
      mainAgentId,
      dedupeKey: "compaction:idle_precompact",
      trigger: "idle_precompact",
      priority: 1,
      summary: `上下文估算已达 ${estimated}/${threshold} tokens，后台静默执行空闲预压缩`,
      requeueOnPreempt: false,
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

  async function replaceMainChatSession(input: {
    requestedMainAgentId?: string;
    mode: "clear" | "handoff";
    carryHandoffSummary: boolean;
    title?: string;
  }): Promise<MainChatNewSessionResult> {
    return runWithLifecycleLock(async () => {
      await store.load();
      const existing = input.requestedMainAgentId?.trim()
        ? {
            agentId: input.requestedMainAgentId.trim(),
            workspaceId:
              deps.agentManager.getAgent(input.requestedMainAgentId.trim())?.workspaceId ??
              (await deps.agentStorage.get(input.requestedMainAgentId.trim()))?.workspaceId ??
              (await resolveMainChatWorkspace()).workspaceId,
          }
        : await findExistingMainChat();

      if (!existing) {
        const ensured = await ensureMainChatInternal();
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

      // Create replacement main chat first so any creation failure leaves old main chat intact.
      const created = await createCleanMainChatAgent({
        workspaceId: existing.workspaceId || workspace.workspaceId,
        cwd: oldSnapshot.cwd || workspace.cwd,
        title: nextTitle,
        provider: oldSnapshot.provider as AgentProvider,
        model: oldSnapshot.model,
        modeId: oldSnapshot.modeId,
        thinkingOptionId: oldSnapshot.thinkingOptionId,
      });

      const migratedChildAgents = await migrateChildAgents(oldMainAgentId, created.agentId);
      const storeMigration = await store.migrateMainAgent(oldMainAgentId, created.agentId);

      if (handoffSummary) {
        await store.setPendingHandoffSummary(created.agentId, handoffSummary);
      }

      turnQueue.clearAgentState(oldMainAgentId);
      compactionStatusByAgent.delete(oldMainAgentId);
      lastPrecompactWatermarkByAgent.delete(oldMainAgentId);
      contextSnapshots.resetDelta(oldMainAgentId);
      contextSnapshots.resetDelta(created.agentId);
      contextSnapshots.invalidateCache();

      await archiveReplacedMainChatAgent(oldMainAgentId, created.agentId);

      const nowIso = new Date(getNowMs()).toISOString();
      let activityTrigger = "new_session";
      let activitySummary = `已开启全新主对话并完成督办权转移（迁移 ${migratedChildAgents} 个子会话）`;
      if (input.mode === "clear") {
        activityTrigger = "user_clear";
        activitySummary = `已原位清空上下文并归档旧会话，迁移 ${storeMigration.migratedPlans} 个计划、${storeMigration.migratedTasks} 个任务、${storeMigration.migratedDecisions} 个决策与 ${migratedChildAgents} 个子会话`;
      } else if (input.carryHandoffSummary) {
        activityTrigger = "new_session_with_handoff";
        activitySummary = `已开启新主对话并完成交接摘要与督办权转移（迁移 ${storeMigration.migratedTasks} 个任务与 ${migratedChildAgents} 个子会话）`;
      }
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

  return {
    async start() {
      await store.load();
      turnQueue.start();
      supervisor.start();
      if (!idlePrecompactTimer && idlePrecompactCheckIntervalMs > 0) {
        idlePrecompactTimer = setInterval(() => {
          void checkIdlePrecompactionInternal().catch((error) => {
            logger.warn({ err: error }, "Idle pre-compaction check failed");
          });
        }, idlePrecompactCheckIntervalMs);
        idlePrecompactTimer.unref?.();
      }
    },

    stop() {
      if (idlePrecompactTimer) {
        clearInterval(idlePrecompactTimer);
        idlePrecompactTimer = null;
      }
      supervisor.stop();
      turnQueue.stop();
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

    async updateSettings(patch) {
      await store.load();
      const previous = store.getSettings();
      const updated = await store.updateSettings(patch);
      supervisor.refreshSchedule();

      const existing = await findExistingMainChat();
      if (!existing) return updated;

      contextSnapshots.resetDelta(existing.agentId);
      if (updated.title !== previous.title || patch.title !== undefined) {
        try {
          await deps.agentManager.updateAgentMetadata(existing.agentId, {
            title: updated.title,
          });
        } catch (error) {
          logger.warn(
            { err: error, agentId: existing.agentId },
            "Failed to sync steward title to agent metadata",
          );
        }
        if (deps.workspaceRegistry.update) {
          try {
            const updatedWorkspace = await deps.workspaceRegistry.update(
              existing.workspaceId,
              (record) => ({
                ...record,
                title: updated.title,
                updatedAt: new Date().toISOString(),
              }),
            );
            if (updatedWorkspace && deps.emitWorkspaceUpdates) {
              await deps.emitWorkspaceUpdates([existing.workspaceId]);
            }
          } catch (error) {
            logger.warn(
              { err: error, workspaceId: existing.workspaceId },
              "Failed to sync steward title to workspace record",
            );
          }
        }
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
      const live = deps.agentManager.getAgent(agentId);
      if (live && !isMainChatLabels(live.labels)) {
        return null;
      }
      return turnQueue.beginForegroundDispatch(agentId);
    },

    abortForegroundUserSend(agentId) {
      turnQueue.abortForegroundDispatch(agentId);
    },

    async prepareUserPromptForMainChat(agentId, prompt) {
      const live = deps.agentManager.getAgent(agentId);
      const stored = live ? null : await deps.agentStorage.get(agentId);
      const labels = live?.labels ?? stored?.labels;
      if (!isMainChatLabels(labels)) {
        return prompt;
      }
      await store.load();
      await turnQueue.preemptForForegroundUser(agentId);
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

    async clearMainChatContext(mainAgentId) {
      const result = await replaceMainChatSession({
        requestedMainAgentId: mainAgentId,
        mode: "clear",
        carryHandoffSummary: false,
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
        tasks: plannedTasks,
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
        if (options?.rememberAutoStart) {
          for (const task of existing.tasks) {
            if (selected && !selected.has(task.id)) continue;
            if (task.cwd) {
              await store.addTrustRule(task.cwd, task.mode, {
                serverId: task.serverId ?? deps.serverId,
                hostLabel: task.hostLabel ?? null,
                allowSubdirectories: true,
              });
            }
          }
        }
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

      contextSnapshots.invalidateCache();
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
      await recordTaskDecisionEntry(
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

      return updated;
    },

    async getOverview(mainAgentId) {
      await store.load();
      const resolvedMainAgentId =
        mainAgentId?.trim() || (await findExistingMainChat())?.agentId || undefined;
      const activityListing = store.listActivities({
        mainAgentId: resolvedMainAgentId,
        limit: 200,
        includeSilent: true,
      });
      const tasks = await listTaskRecordsInternal({
        mainAgentId: resolvedMainAgentId,
        includeCompleted: true,
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
      return {
        plans: store.listPlans(resolvedMainAgentId),
        decisions: store.listDecisions(resolvedMainAgentId),
        autoStartRules: store.listTrustRules(),
        permissionRules: store.listPermissionRules(),
        metrics: store.getMetrics(),
        settings: store.getSettings(),
        triages: store.listTriages(),
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
        recentReceipts,
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
        const completedTask = await syncTaskRecordCompleted(existing, receipt, nowIso);
        contextSnapshots.invalidateCache();
        return {
          task: completedTask,
          receipt,
          rework: null,
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
      };
    },
  };
}
