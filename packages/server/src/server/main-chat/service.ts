import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import {
  MAIN_CHAT_ROLE_LABEL,
  MAIN_CHAT_ROLE_VALUE,
  MAIN_CHAT_TASK_GOAL_LABEL,
  MAIN_CHAT_TASK_ID_LABEL,
  MAIN_CHAT_TASK_MODE_LABEL,
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
  MAIN_CHAT_WORKSPACE_DIR_NAME,
  getMainChatTaskMetaFromLabels,
  isMainChatLabels,
  type MainChatDecisionOption,
  type MainChatDecisionRecord,
  type MainChatOverview,
  type MainChatPatrolResult,
  type MainChatPermissionRule,
  type MainChatPlanRecord,
  type MainChatPlannedTask,
  type MainChatReworkRecord,
  type MainChatRuleKind,
  type MainChatSettings,
  type MainChatSettingsPatch,
  type MainChatTaskIsolation,
  type MainChatTaskMode,
  type MainChatTaskReceipt,
} from "@getpaseo/protocol/main-chat";
import {
  PARENT_AGENT_ID_LABEL,
  PARENT_SERVER_ID_LABEL,
  getParentAgentIdFromLabels,
} from "@getpaseo/protocol/agent-labels";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { FinishSubscriptions } from "../agent/finish-subscriptions/index.js";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { wrapMainChatContextBlock } from "../agent/agent-messages/index.js";
import type { AgentPromptInput } from "../agent/agent-sdk-types.js";
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
import { buildWorkerInitialPrompt } from "./prompts.js";
import { createMainChatStore, type MainChatMetrics, type MainChatStore } from "./store.js";
import { createMainChatSupervisor } from "./supervisor.js";
import type { RunSemanticTriageInput, SemanticTriageOutput } from "./triage.js";

const MAX_REWORK_ROUNDS = 2;

export interface CreateMainChatPlanTaskInput {
  title: string;
  goal: string;
  mode?: MainChatTaskMode;
  isolation?: MainChatTaskIsolation;
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
}

export interface CreateMainChatPlanInput {
  summary?: string;
  autoStart?: boolean;
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
  prepareUserPromptForMainChat(
    agentId: string,
    prompt: AgentPromptInput,
  ): Promise<AgentPromptInput>;
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
  getOverview(mainAgentId: string): Promise<MainChatOverview>;
  addPermissionRule(input: {
    toolName: string;
    commandPrefix?: string | null;
    cwd?: string | null;
  }): Promise<MainChatPermissionRule>;
  removeRule(kind: MainChatRuleKind, ruleId: string): Promise<boolean>;
  recordReceipt(receipt: MainChatTaskReceipt): Promise<MainChatTaskReceipt>;
  getMetrics(): MainChatMetrics;
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
  const store: MainChatStore = createMainChatStore(deps.paseoHome);
  const contextSnapshots = createMainChatContextSnapshotBuilder({
    agentManager: deps.agentManager,
    agentStorage: deps.agentStorage,
    store,
  });
  const supervisor = createMainChatSupervisor({
    agentManager: deps.agentManager,
    agentStorage: deps.agentStorage,
    store,
    contextSnapshots,
    logger,
    providerSnapshotManager: deps.providerSnapshotManager,
    readDaemonConfig: deps.readDaemonConfig,
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
  const planLocks = new Map<string, Promise<unknown>>();

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
    if (!(await isExistingDirectory(cwd))) {
      throw new Error(`任务「${title}」指定的目录不存在：${cwd}`);
    }
    return {
      workspaceId: null,
      cwd,
      workspaceLabel: path.basename(cwd) || cwd,
    };
  }

  async function buildPlannedTask(
    item: CreateMainChatPlanTaskInput,
    index: number,
  ): Promise<{ task: MainChatPlannedTask; autoStartEligible: boolean }> {
    const mode: MainChatTaskMode = item.mode ?? "write";
    const isolation: MainChatTaskIsolation = item.isolation ?? "local";
    const title = item.title.trim();
    const goal = item.goal.trim();
    if (!title || !goal) {
      throw new Error(`第 ${index + 1} 个任务缺少 title 或 goal`);
    }

    const doneWhen = trimList(item.doneWhen);
    if (mode === "write" && doneWhen.length === 0) {
      throw new Error(`写操作任务「${title}」必须至少提供 1 条验收标准 doneWhen`);
    }

    const location = await resolvePlannedTaskLocation(title, item.workspaceId, item.cwd);
    const defaultReason =
      mode === "readonly" ? "只读分析任务，自动在目标目录开工" : "涉及改动，建议确认后开始";

    const task: MainChatPlannedTask = {
      id: makeId("task"),
      title,
      goal,
      mode,
      isolation,
      cwd: location.cwd,
      workspaceId: location.workspaceId,
      workspaceLabel: location.workspaceLabel,
      reason: trimOptional(item.reason) ?? defaultReason,
      doneWhen,
      outOfBounds: trimList(item.outOfBounds),
      provider: trimOptional(item.provider),
      modeId: trimOptional(item.modeId),
      thinkingOptionId: trimOptional(item.thinkingOptionId),
      branchName: trimOptional(item.branchName),
      baseBranch: trimOptional(item.baseBranch),
      agentId: null,
      startedAt: null,
      startError: null,
    };

    const autoStartEligible = mode === "readonly" || store.hasTrustRule(location.cwd, mode);
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

  async function spawnTasksForPlan(
    plan: MainChatPlanRecord,
    selectedTaskIds?: ReadonlySet<string>,
  ): Promise<MainChatPlanRecord> {
    const mainAgent = await resolveMainAgentSnapshot(plan.mainAgentId);
    const updatedTasks: MainChatPlannedTask[] = [];
    const nowIso = new Date().toISOString();

    for (const task of plan.tasks) {
      if (task.agentId || (selectedTaskIds && !selectedTaskIds.has(task.id))) {
        updatedTasks.push(task);
        continue;
      }
      try {
        const target = await resolveTaskWorkspaceTarget(task);
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
            title: task.title,
            initialPrompt: buildWorkerInitialPrompt(task),
            cwd: target.cwd,
            workspaceId: target.workspaceId,
            thinking: task.thinkingOptionId ?? mainAgent.thinkingOptionId ?? undefined,
            mode: task.modeId ?? mainAgent.modeId ?? undefined,
            labels: {
              [PARENT_AGENT_ID_LABEL]: plan.mainAgentId,
              [PARENT_SERVER_ID_LABEL]: deps.serverId,
              [MAIN_CHAT_TASK_PLAN_ID_LABEL]: plan.id,
              [MAIN_CHAT_TASK_ID_LABEL]: task.id,
              [MAIN_CHAT_TASK_MODE_LABEL]: task.mode,
              [MAIN_CHAT_TASK_GOAL_LABEL]: task.goal.slice(0, 200),
            },
            promptFailure: "throw",
            notifyOnFinish: true,
            background: false,
            detached: false,
            callerAgentId: plan.mainAgentId,
          },
        );
        updatedTasks.push({
          ...task,
          cwd: target.cwd,
          workspaceId: snapshot.workspaceId ?? target.workspaceId,
          agentId: snapshot.id,
          startedAt: nowIso,
          startError: null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ err: error, planId: plan.id, taskId: task.id }, "Failed to start plan task");
        updatedTasks.push({
          ...task,
          startError: message,
        });
      }
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

  return {
    async start() {
      await store.load();
      supervisor.start();
    },

    stop() {
      supervisor.stop();
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

    async prepareUserPromptForMainChat(agentId, prompt) {
      const live = deps.agentManager.getAgent(agentId);
      const stored = live ? null : await deps.agentStorage.get(agentId);
      const labels = live?.labels ?? stored?.labels;
      if (!isMainChatLabels(labels)) {
        return prompt;
      }
      await store.load();
      const snapshot = await contextSnapshots.buildTurnContext(agentId);
      const prefix = `${wrapMainChatContextBlock(snapshot)}\n\n`;
      if (typeof prompt === "string") {
        return `${prefix}${prompt}`;
      }
      return [{ type: "text", text: prefix }, ...prompt];
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

      const plannedTasks: MainChatPlannedTask[] = [];
      let allEligibleForAutoStart = true;

      for (let index = 0; index < input.tasks.length; index += 1) {
        const built = await buildPlannedTask(input.tasks[index]!, index);
        plannedTasks.push(built.task);
        if (!built.autoStartEligible && input.autoStart !== true) {
          allEligibleForAutoStart = false;
        }
      }

      const plan: MainChatPlanRecord = {
        id: makeId("plan"),
        mainAgentId,
        status: "open",
        autoStarted: allEligibleForAutoStart,
        summary: input.summary?.trim() || null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        cancelledAt: null,
        tasks: plannedTasks,
      };
      await store.putPlan(plan);
      await store.incrementMetric("plansCreated");

      if (allEligibleForAutoStart) {
        const started = await spawnTasksForPlan(plan);
        await store.incrementMetric("plansAutoStarted");
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
        const selected = options?.taskIds?.length ? new Set(options.taskIds) : undefined;
        if (options?.rememberAutoStart) {
          for (const task of existing.tasks) {
            if (selected && !selected.has(task.id)) continue;
            if (task.cwd) {
              await store.addTrustRule(task.cwd, task.mode);
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
        if (existing.status === "cancelled") {
          return existing;
        }
        const cancelled: MainChatPlanRecord = {
          ...existing,
          status: "cancelled",
          cancelledAt: new Date().toISOString(),
        };
        await store.putPlan(cancelled);
        await store.incrementMetric("plansCancelled");
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
      if (store.getReworkRound(input.agentId) >= MAX_REWORK_ROUNDS) {
        throw new Error(
          `该任务已达到返工上限（${MAX_REWORK_ROUNDS} 轮），请不要继续退回，请改用 task_ask_user 向用户汇报现状并请用户拍板。`,
        );
      }

      const targetMeta = await resolveReworkTargetMeta(input);
      const round = await store.incrementReworkRound(input.agentId);
      await store.incrementMetric("reworkCount");

      const note = trimOptional(input.note);
      const promptLines = [
        `【主对话复核退回 · 第 ${round}/${MAX_REWORK_ROUNDS} 轮返工】`,
        "对照验收标准，以下缺口尚未满足，请逐项补齐并给出可核验的证据：",
        ...gaps.map((gap, index) => `${index + 1}. ${gap}`),
        ...(note ? [`【补充说明】${note}`] : []),
      ];

      await sendPromptToAgent({
        agentId: input.agentId,
        prompt: promptLines.join("\n"),
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger,
        unarchive: false,
      });

      return {
        title: targetMeta.title,
        agentId: input.agentId,
        planId: targetMeta.planId,
        taskId: targetMeta.taskId,
        round,
        maxRounds: MAX_REWORK_ROUNDS,
        gaps,
        note,
      };
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
        createdAt: new Date().toISOString(),
      };
      await store.putDecision(decision);
      await store.incrementMetric("interrupts");
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

      const updated: MainChatDecisionRecord = {
        ...existing,
        answer,
        answeredOptionId: trimOptional(input.optionId),
        answeredAt: new Date().toISOString(),
      };
      await store.putDecision(updated);

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
      return {
        plans: store.listPlans(mainAgentId),
        decisions: store.listDecisions(mainAgentId),
        autoStartRules: store.listTrustRules(),
        permissionRules: store.listPermissionRules(),
        metrics: store.getMetrics(),
        settings: store.getSettings(),
        triages: store.listTriages(),
        lastPatrolAt: store.getLastPatrolAt(),
        lastWakeupAt: store.getLastWakeupAt(),
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

    async recordReceipt(receipt) {
      await store.load();
      await store.incrementMetric("receiptsRecorded");
      return receipt;
    },

    getMetrics() {
      return store.getMetrics();
    },
  };
}
