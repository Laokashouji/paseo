import path from "node:path";
import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  extractMainChatPermissionRuleCandidate,
  getMainChatTaskMetaFromLabels,
  isMainChatLabels,
  type MainChatPatrolResult,
  type MainChatSessionTriage,
} from "@getpaseo/protocol/main-chat";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentProvider, AgentTimelineItem } from "../agent/agent-sdk-types.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { StructuredGenerationDaemonConfig } from "../agent/structured-generation-providers.js";
import type { MainChatContextSnapshotBuilder } from "./context-snapshot.js";
import {
  buildMainChatInitialBriefingPrompt,
  buildMainChatPatrolWakeupPrompt,
  type MainChatPatrolSignalItem,
} from "./prompts.js";
import type { MainChatStore } from "./store.js";
import type { MainChatTurnQueue } from "./turn-queue.js";
import {
  classifyMainChatTurnError,
  heuristicTriageAssistantReply,
  isNoProgressToolCall,
  isSimilarDelegatedQuestion,
  isSubstantiveProgressToolCall,
  parseUsageLimitResetDelayMs,
  resolveMainChatBackgroundProviders,
  runMainChatSemanticTriage,
  type RunSemanticTriageInput,
  type SemanticTriageOutput,
} from "./triage.js";

const MAX_TRANSIENT_AUTO_RETRIES = 2;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 3_000;
const MIN_NO_PROGRESS_TOOL_CALLS = 3;

export interface MainChatSupervisorDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  store: MainChatStore;
  contextSnapshots: MainChatContextSnapshotBuilder;
  turnQueue: MainChatTurnQueue;
  logger: Logger;
  providerSnapshotManager?: Pick<ProviderSnapshotManager, "listProviders">;
  readDaemonConfig?: () => StructuredGenerationDaemonConfig | null;
  resolveMainAgentId?: () => Promise<string | null>;
  onPatrolTick?: () => Promise<void> | void;
  semanticTriageRunner?: (input: RunSemanticTriageInput) => Promise<SemanticTriageOutput | null>;
  transientRetryDelayMs?: number;
  usageLimitRetryDelayMs?: number;
  stalledThresholdMs?: number;
  stalledCheckIntervalMs?: number;
  triageSettleMs?: number;
  noProgressThresholdMs?: number;
  needsYouEscalateMs?: number;
  wakeupCooldownMs?: number;
}

export interface MainChatSupervisor {
  start(): void;
  stop(): void;
  refreshSchedule(): void;
  runPatrol(options?: {
    mainAgentId?: string | null;
    forceWakeup?: boolean;
    manualTrigger?: boolean;
  }): Promise<MainChatPatrolResult>;
  dispatchInitialBriefing(mainAgentId: string): Promise<boolean>;
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

function basenameOf(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return path.basename(trimmed) || trimmed;
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

/**
 * Full-fleet proactive steward supervisor:
 * - auto-approves managed child permission requests matching saved conservative rules,
 * - auto-continues transient provider/network hiccups and usage-limit resets (configurable for manual sessions),
 * - tracks silent stalls and `no_progress` polling loops across the whole fleet,
 * - runs settle-debounced two-tier triage (rules first, optional configurable background model second),
 * - in proactive style (B), auto-delegates non-redline low-risk technical questions (with 24h anti-repeat)
 *   and auto-nudges stalled/looping manual sessions,
 * - coalesces actionable signals into `<paseo-system>` proactive wakeups for the pinned steward chat.
 */
export function createMainChatSupervisor(deps: MainChatSupervisorDependencies): MainChatSupervisor {
  const transientRetriesByAgent = new Map<string, number>();
  const usageLimitRetriedAgents = new Set<string>();
  const pendingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingTriageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastActivityAtByAgent = new Map<string, number>();
  const lastAssistantTextByAgent = new Map<string, string>();
  const stalledNudgedAtByAgent = new Map<string, number>();
  const permissionFirstSeenAt = new Map<string, number>();
  const toolLoopByAgent = new Map<string, AgentToolLoopTracker>();
  const pendingSignals = new Map<
    string,
    { fingerprint: string; signal: MainChatPatrolSignalItem }
  >();
  const lastReportedFingerprintByKey = new Map<string, string>();
  const initialBriefingSentAgents = new Set<string>();

  let unsubscribeEvents: (() => void) | null = null;
  let patrolTimer: ReturnType<typeof setInterval> | null = null;
  let currentPatrolIntervalMs: number | null = null;
  let lastWakeupAtMs = 0;
  let wakeupInFlight = false;

  const transientDelayMs = deps.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS;

  function effectivePatrolIntervalMs(): number {
    if (deps.stalledCheckIntervalMs !== undefined) return deps.stalledCheckIntervalMs;
    return deps.store.getSettings().intervals.patrolIntervalSec * 1000;
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

  function effectiveWakeupCooldownMs(): number {
    if (deps.wakeupCooldownMs !== undefined) return deps.wakeupCooldownMs;
    return deps.store.getSettings().intervals.wakeupCooldownMin * 60 * 1000;
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

  function clearAgentState(agentId: string): void {
    clearTimerMapEntry(pendingRetryTimers, agentId);
    clearTimerMapEntry(pendingTriageTimers, agentId);
    transientRetriesByAgent.delete(agentId);
    usageLimitRetriedAgents.delete(agentId);
    lastActivityAtByAgent.delete(agentId);
    lastAssistantTextByAgent.delete(agentId);
    stalledNudgedAtByAgent.delete(agentId);
    permissionFirstSeenAt.delete(agentId);
    toolLoopByAgent.delete(agentId);
    for (const key of Array.from(pendingSignals.keys())) {
      if (key.startsWith(`${agentId}:`)) pendingSignals.delete(key);
    }
    void deps.store.removeTriage(agentId).catch(() => undefined);
  }

  function queueSignal(signal: MainChatPatrolSignalItem, fingerprintSeed: string): void {
    const key = `${signal.agentId}:${signal.kind}`;
    const fingerprint = `${key}:${fingerprintSeed}`;
    if (lastReportedFingerprintByKey.get(key) === fingerprint) return;
    pendingSignals.set(key, { fingerprint, signal });
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
    pendingRetryTimers.set(input.agentId, timer);
  }

  function scheduleTransientRetry(agent: ManagedAgent, errorMessage: string): void {
    const retries = transientRetriesByAgent.get(agent.id) ?? 0;
    if (retries >= MAX_TRANSIENT_AUTO_RETRIES) {
      void deps.store.incrementMetric("interrupts").catch(() => undefined);
      const triage: MainChatSessionTriage = {
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? null,
        title: agent.config.title?.trim() || basenameOf(agent.cwd),
        managedByMainChat: isManagedChildAgent(agent),
        phase: "interrupted",
        summary: `连续重试 ${MAX_TRANSIENT_AUTO_RETRIES} 次仍失败：${errorMessage.slice(0, 80)}`,
        waitReason: errorMessage.slice(0, 120),
        suggestedAction: "打开会话查看报错或稍后手动继续",
        triageSource: "rule",
        updatedAt: new Date().toISOString(),
      };
      void deps.store.putTriage(triage).catch(() => undefined);
      queueSignal(
        {
          agentId: agent.id,
          title: triage.title,
          projectName: basenameOf(agent.cwd),
          managedByMainChat: triage.managedByMainChat,
          kind: "interrupted",
          detail: triage.summary,
          suggestedAction: triage.suggestedAction,
        },
        `err:${errorMessage.slice(0, 60)}`,
      );
      return;
    }
    const attempt = retries + 1;
    transientRetriesByAgent.set(agent.id, attempt);
    deps.logger.info(
      { agentId: agent.id, attempt, error: errorMessage },
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
      },
    });
  }

  function scheduleUsageLimitRetry(agent: ManagedAgent, errorMessage: string): void {
    if (usageLimitRetriedAgents.has(agent.id)) {
      void deps.store.incrementMetric("interrupts").catch(() => undefined);
      return;
    }
    usageLimitRetriedAgents.add(agent.id);
    const delayMs = deps.usageLimitRetryDelayMs ?? parseUsageLimitResetDelayMs(errorMessage);
    const title = agent.config.title?.trim() || basenameOf(agent.cwd);
    const minutes = Math.max(1, Math.round(delayMs / 60_000));
    const triage: MainChatSessionTriage = {
      agentId: agent.id,
      workspaceId: agent.workspaceId ?? null,
      title,
      managedByMainChat: isManagedChildAgent(agent),
      phase: "blocked_external",
      summary: `触发模型额度上限，已排期约 ${minutes} 分钟后自动续跑`,
      waitReason: errorMessage.slice(0, 120),
      suggestedAction: "等待自动恢复或手动切换其他模型",
      triageSource: "rule",
      updatedAt: new Date().toISOString(),
    };
    void deps.store.putTriage(triage).catch(() => undefined);
    deps.logger.info(
      { agentId: agent.id, delayMs, error: errorMessage },
      "Scheduling delayed automatic continuation after usage limit",
    );
    dispatchDelayedResume({
      agentId: agent.id,
      delayMs,
      prompt: "模型额度已重置，请从之前中断的位置继续完成当前任务。",
      logReason: "usage-limit retry",
      onDispatched: async () => {
        await deps.store.incrementMetric("usageLimitRetries");
        await deps.store.incrementMetric("autoContinued");
        await deps.store.incrementMetric("supervisorHeld");
      },
    });
  }

  function handlePermissionRequested(agent: ManagedAgent, request: AgentPermissionRequest): void {
    if (!permissionFirstSeenAt.has(agent.id)) {
      permissionFirstSeenAt.set(agent.id, Date.now());
    }

    const title = agent.config.title?.trim() || basenameOf(agent.cwd);
    const managed = isManagedChildAgent(agent);

    if (managed) {
      const candidate = extractMainChatPermissionRuleCandidate({
        kind: request.kind,
        name: request.name,
        title: request.title,
        input: request.input ?? null,
      });
      const matched = candidate
        ? deps.store.findMatchingPermissionRule({
            toolName: candidate.toolName,
            commandPrefix: candidate.commandPrefix,
            cwd: agent.cwd,
          })
        : null;

      if (matched) {
        deps.logger.info(
          {
            agentId: agent.id,
            requestId: request.id,
            ruleId: matched.id,
            toolName: matched.toolName,
          },
          "Auto-approving child agent permission request from saved main-chat rule",
        );
        void deps.agentManager
          .respondToPermission(agent.id, request.id, { behavior: "allow" })
          .then(() => {
            permissionFirstSeenAt.delete(agent.id);
            return deps.store.incrementMetric("supervisorHeld");
          })
          .catch((error) => {
            deps.logger.warn(
              { err: error, agentId: agent.id, requestId: request.id },
              "Supervisor auto-approval failed; leaving request for user",
            );
          });
        return;
      }
    }

    const waitLabel = request.title?.trim() || request.name?.trim() || "待审批请求";
    void deps.store
      .putTriage({
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? null,
        title,
        managedByMainChat: managed,
        phase: "blocked_user",
        summary: `等待审批：${waitLabel}`,
        waitReason: waitLabel,
        suggestedAction: "点击批准或打开会话处理",
        triageSource: "rule",
        updatedAt: new Date().toISOString(),
      })
      .catch(() => undefined);
    void deps.store.incrementMetric("triageRuleCount").catch(() => undefined);
    void deps.store.incrementMetric("interrupts").catch(() => undefined);
  }

  function handleTurnFailed(agent: ManagedAgent, errorMessage: string): void {
    const settings = deps.store.getSettings();
    const managed = isManagedChildAgent(agent);
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

    void deps.store.incrementMetric("interrupts").catch(() => undefined);
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
      updatedAt: new Date().toISOString(),
    };
    void deps.store.putTriage(triage).catch(() => undefined);
    queueSignal(
      {
        agentId: agent.id,
        title,
        projectName: basenameOf(agent.cwd),
        managedByMainChat: managed,
        kind: "interrupted",
        detail: triage.summary,
        suggestedAction: triage.suggestedAction,
      },
      `failed:${errorMessage.slice(0, 60)}`,
    );
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
    if (!input.settings.capabilities.semanticTriageEnabled || input.lastReply.length === 0) {
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
    agentId: string;
    title: string;
    projectName: string;
    managed: boolean;
    triage: MainChatSessionTriage;
    suggestedReply: string;
    settings: ReturnType<MainChatStore["getSettings"]>;
  }): Promise<boolean> {
    const questionKey = input.triage.waitReason || input.triage.summary;
    const previous = deps.store
      .listRecentDelegatedQuestions(input.agentId)
      .map((entry) => entry.text);
    if (isSimilarDelegatedQuestion(questionKey, previous)) return false;

    try {
      await deps.store.recordDelegatedQuestion(input.agentId, questionKey);
      await sendPromptToAgent({
        agentId: input.agentId,
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
        updatedAt: new Date().toISOString(),
      });
      queueSignal(
        {
          agentId: input.agentId,
          title: input.title,
          projectName: input.projectName,
          managedByMainChat: input.managed,
          kind: "auto_delegated",
          detail: `已代答低风险技术问题并续跑：「${input.suggestedReply.slice(0, 80)}」`,
        },
        `delegated:${questionKey.slice(0, 50)}`,
      );
      return true;
    } catch (error) {
      deps.logger.warn(
        { err: error, agentId: input.agentId },
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
    const nowIso = new Date().toISOString();
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
    agentId: string;
    title: string;
    projectName: string;
    managed: boolean;
    triage: MainChatSessionTriage;
  }): void {
    const { triage } = input;
    if (triage.phase === "blocked_user") {
      queueSignal(
        {
          agentId: input.agentId,
          title: input.title,
          projectName: input.projectName,
          managedByMainChat: input.managed,
          kind: "blocked_user",
          detail: triage.waitReason
            ? `${triage.summary}（卡点：${triage.waitReason}）`
            : triage.summary,
          suggestedAction: triage.suggestedAction,
        },
        `blocked:${triage.waitReason ?? triage.summary}`.slice(0, 80),
      );
      void maybeWakeMainChat({ urgent: true });
      return;
    }
    if (triage.phase === "done") {
      queueSignal(
        {
          agentId: input.agentId,
          title: input.title,
          projectName: input.projectName,
          managedByMainChat: input.managed,
          kind: "done_review",
          detail: triage.summary,
          suggestedAction: input.managed ? "请对照验收标准复核并记录回执" : "可向用户简报交付结果",
        },
        `done:${triage.summary}`.slice(0, 80),
      );
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
        agentId,
        title,
        projectName,
        managed,
        triage: outcome.triage,
        suggestedReply: outcome.suggestedReply,
        settings,
      });
      if (delegated) return;
    }

    await deps.store.putTriage(outcome.triage);
    emitPostTriageSignal({ agentId, title, projectName, managed, triage: outcome.triage });
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
    pendingTriageTimers.set(agentId, timer);
  }

  function handleManagerEvent(event: AgentManagerEvent): void {
    deps.turnQueue.handleEvent(event);
    if (event.type === "agent_removed") {
      clearAgentState(event.agentId);
      deps.contextSnapshots.invalidateCache();
      return;
    }
    if (event.type === "agent_state") {
      const now = Date.now();
      if (event.agent.lifecycle === "running") {
        clearTimerMapEntry(pendingTriageTimers, event.agent.id);
        if (!lastActivityAtByAgent.has(event.agent.id)) {
          lastActivityAtByAgent.set(event.agent.id, now);
        }
      }
      if (event.agent.pendingPermissions.size === 0) {
        permissionFirstSeenAt.delete(event.agent.id);
      }
      return;
    }
    if (event.type !== "agent_stream") return;

    const now = Date.now();
    lastActivityAtByAgent.set(event.agentId, now);
    stalledNudgedAtByAgent.delete(event.agentId);

    const agent = deps.agentManager.getAgent(event.agentId);
    if (!isObservedFleetAgent(agent)) return;

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
      usageLimitRetriedAgents.delete(event.agentId);
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
    }
  }

  function canTriggerProactiveWakeup(
    settings: ReturnType<MainChatStore["getSettings"]>,
    options?: {
      forceWakeup?: boolean;
      manualTrigger?: boolean;
      urgent?: boolean;
    },
  ): boolean {
    const force = options?.forceWakeup === true || options?.manualTrigger === true;
    if (wakeupInFlight) return false;
    if (force) return true;
    if (!settings.capabilities.proactiveWakeupEnabled || pendingSignals.size === 0) return false;
    if (options?.urgent) return true;
    const cooldownMs = effectiveWakeupCooldownMs();
    return lastWakeupAtMs <= 0 || Date.now() - lastWakeupAtMs >= cooldownMs;
  }

  async function maybeWakeMainChat(options?: {
    mainAgentId?: string | null;
    forceWakeup?: boolean;
    manualTrigger?: boolean;
    urgent?: boolean;
  }): Promise<boolean> {
    const settings = deps.store.getSettings();
    const force = options?.forceWakeup === true || options?.manualTrigger === true;
    if (!canTriggerProactiveWakeup(settings, options)) return false;

    const mainAgentId = options?.mainAgentId ?? (await resolveMainAgentId());
    if (!mainAgentId) return false;

    wakeupInFlight = true;
    try {
      let capturedEntries: Array<
        [string, { fingerprint: string; signal: MainChatPatrolSignalItem }]
      > = [];
      let trigger = "patrol_wakeup";
      if (options?.manualTrigger) {
        trigger = "manual_patrol";
      } else if (options?.urgent) {
        trigger = "urgent_patrol";
      }
      const initialSignalCount = pendingSignals.size;
      const summary = options?.manualTrigger
        ? `手动巡检并汇报（${initialSignalCount} 条动态）`
        : `后台巡检唤醒（${initialSignalCount} 条动态）`;

      const queued = await deps.turnQueue.enqueueBackground({
        mainAgentId,
        dedupeKey: "patrol:wakeup",
        trigger,
        priority: options?.manualTrigger || options?.urgent ? 20 : 10,
        summary,
        requeueOnPreempt: true,
        buildPrompt: async () => {
          const latestSettings = deps.store.getSettings();
          capturedEntries = Array.from(pendingSignals.entries());
          if (!force && capturedEntries.length === 0) {
            return null;
          }
          const signals = capturedEntries.map(([, entry]) => entry.signal);
          const contextSnapshot = await deps.contextSnapshots.buildTurnContext(mainAgentId, {
            forceFull: options?.manualTrigger === true,
          });
          return buildMainChatPatrolWakeupPrompt({
            settings: latestSettings,
            signals,
            contextSnapshot,
            manualTrigger: options?.manualTrigger,
          });
        },
        onDispatched: async () => {
          lastWakeupAtMs = Date.now();
          await deps.store.setLastWakeupAt(new Date(lastWakeupAtMs).toISOString());
          await deps.store.incrementMetric("proactiveWakeups");
        },
        onCompleted: () => {
          for (const [key, entry] of capturedEntries) {
            lastReportedFingerprintByKey.set(key, entry.fingerprint);
            const current = pendingSignals.get(key);
            if (current && current.fingerprint === entry.fingerprint) {
              pendingSignals.delete(key);
            }
          }
        },
      });
      return queued.status === "dispatched";
    } catch (error) {
      deps.logger.warn({ err: error, mainAgentId }, "Proactive main-chat wakeup failed");
      return false;
    } finally {
      wakeupInFlight = false;
    }
  }

  function inspectPendingPermissions(
    agent: ManagedAgent,
    meta: { title: string; projectName: string; managed: boolean },
    now: number,
    needsYouEscalateMs: number,
  ): number {
    const firstSeen = permissionFirstSeenAt.get(agent.id) ?? agent.updatedAt.getTime();
    permissionFirstSeenAt.set(agent.id, firstSeen);
    if (now - firstSeen < needsYouEscalateMs) return 0;

    const waitedMin = Math.max(1, Math.round((now - firstSeen) / 60_000));
    const firstPerm = Array.from(agent.pendingPermissions.values())[0];
    const permLabel = firstPerm?.title?.trim() || firstPerm?.name?.trim() || "待审批请求";
    queueSignal(
      {
        agentId: agent.id,
        title: meta.title,
        projectName: meta.projectName,
        managedByMainChat: meta.managed,
        kind: "needs_you",
        detail: `等待权限审批已超过 ${waitedMin} 分钟（${permLabel}）`,
        suggestedAction: "请在主对话或对应会话处理审批",
      },
      `perm:${firstPerm?.id ?? permLabel}`,
    );
    return 1;
  }

  async function inspectNoProgressLoop(
    agent: ManagedAgent,
    meta: { title: string; projectName: string; managed: boolean },
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

    queueSignal(
      {
        agentId: agent.id,
        title: meta.title,
        projectName: meta.projectName,
        managedByMainChat: meta.managed,
        kind: "no_progress",
        detail: triage.summary,
        suggestedAction: "建议介入查看或让管家提醒继续",
      },
      `noprogress:${loopTracker.noProgressSinceAt}`,
    );
    return { handled: true, signalsAdded: 1 };
  }

  async function inspectSilentStalledAgent(
    agent: ManagedAgent,
    meta: { title: string; projectName: string; managed: boolean },
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

    queueSignal(
      {
        agentId: agent.id,
        title: meta.title,
        projectName: meta.projectName,
        managedByMainChat: meta.managed,
        kind: "stalled",
        detail: triage.summary,
        suggestedAction: "建议确认是否卡住或点开查看",
      },
      `stalled:${lastActivity}`,
    );
    return 1;
  }

  async function scanFleetAndBuildSignals(): Promise<{
    scannedSessions: number;
    signalsFound: number;
  }> {
    const now = Date.now();
    const settings = deps.store.getSettings();
    const stalledThresholdMs = effectiveStalledThresholdMs();
    const noProgressThresholdMs = effectiveNoProgressThresholdMs();
    const needsYouEscalateMs = effectiveNeedsYouEscalateMs();
    const agents = deps.agentManager.listAgents().filter(isObservedFleetAgent);
    let newSignals = 0;

    for (const agent of agents) {
      const meta = {
        title: agent.config.title?.trim() || basenameOf(agent.cwd),
        projectName: basenameOf(agent.cwd),
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

    return { scannedSessions: agents.length, signalsFound: pendingSignals.size + newSignals };
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
      return `已巡检 ${scannedSessions} 个活跃会话，记录 ${signalsFound} 条动态（等待冷却窗口汇总）`;
    }
    return `已巡检 ${scannedSessions} 个活跃会话，目前无新增异常动态`;
  }

  async function runPatrol(options?: {
    mainAgentId?: string | null;
    forceWakeup?: boolean;
    manualTrigger?: boolean;
  }): Promise<MainChatPatrolResult> {
    deps.contextSnapshots.invalidateCache();
    const { scannedSessions } = await scanFleetAndBuildSignals();
    const signalsFound = pendingSignals.size;
    const patrolledAt = new Date().toISOString();
    await deps.store.setLastPatrolAt(patrolledAt);
    await deps.store.incrementMetric("patrolRuns");

    const wokeMainChat = await maybeWakeMainChat({
      mainAgentId: options?.mainAgentId,
      forceWakeup: options?.forceWakeup,
      manualTrigger: options?.manualTrigger,
    });

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

  function armPatrolTimer(): void {
    const intervalMs = Math.max(50, effectivePatrolIntervalMs());
    if (patrolTimer && currentPatrolIntervalMs === intervalMs) return;
    if (patrolTimer) {
      clearInterval(patrolTimer);
      patrolTimer = null;
    }
    currentPatrolIntervalMs = intervalMs;
    patrolTimer = setInterval(() => {
      void runPatrol().catch((error) => {
        deps.logger.warn({ err: error }, "Periodic main-chat patrol failed");
      });
    }, intervalMs);
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
      if (patrolTimer) {
        clearInterval(patrolTimer);
        patrolTimer = null;
      }
      currentPatrolIntervalMs = null;
      for (const timer of pendingRetryTimers.values()) clearTimeout(timer);
      pendingRetryTimers.clear();
      for (const timer of pendingTriageTimers.values()) clearTimeout(timer);
      pendingTriageTimers.clear();
    },

    refreshSchedule() {
      if (!unsubscribeEvents) return;
      armPatrolTimer();
    },

    runPatrol,

    async dispatchInitialBriefing(mainAgentId) {
      const settings = deps.store.getSettings();
      if (!settings.capabilities.initialBriefingEnabled) return false;
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
            lastWakeupAtMs = Date.now();
            await deps.store.setLastWakeupAt(new Date(lastWakeupAtMs).toISOString());
            await deps.store.incrementMetric("proactiveWakeups");
          },
        });
        return queued.status === "dispatched";
      } catch (error) {
        deps.logger.warn({ err: error, mainAgentId }, "Initial main-chat briefing failed");
        return false;
      }
    },
  };
}
