import type { Logger } from "pino";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import {
  extractMainChatPermissionRuleCandidate,
  getMainChatTaskMetaFromLabels,
} from "@getpaseo/protocol/main-chat";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "../agent/agent-manager.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import type { MainChatStore } from "./store.js";
import { classifyMainChatTurnError, parseUsageLimitResetDelayMs } from "./triage.js";

const MAX_TRANSIENT_AUTO_RETRIES = 2;
const DEFAULT_TRANSIENT_RETRY_DELAY_MS = 3_000;
const DEFAULT_STALLED_THRESHOLD_MS = 10 * 60 * 1000;
const DEFAULT_STALLED_CHECK_INTERVAL_MS = 60 * 1000;

export interface MainChatSupervisorDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  store: MainChatStore;
  logger: Logger;
  transientRetryDelayMs?: number;
  usageLimitRetryDelayMs?: number;
  stalledThresholdMs?: number;
  stalledCheckIntervalMs?: number;
}

export interface MainChatSupervisor {
  start(): void;
  stop(): void;
}

function isSupervisedChildAgent(agent: ManagedAgent | null | undefined): agent is ManagedAgent {
  if (!agent || agent.background) return false;
  const parentId = getParentAgentIdFromLabels(agent.labels);
  const taskMeta = getMainChatTaskMetaFromLabels(agent.labels);
  return Boolean(parentId && taskMeta?.planId);
}

/**
 * Autonomous daemon-side supervisor for Main Chat child agents:
 * - auto-approves child permission requests matching saved conservative permission rules,
 * - auto-continues transient provider/network hiccups (up to 2 retries),
 * - schedules one delayed resume when hitting a provider usage limit,
 * - nudges stalled running child agents once if silent past the threshold.
 */
export function createMainChatSupervisor(deps: MainChatSupervisorDependencies): MainChatSupervisor {
  const transientRetriesByAgent = new Map<string, number>();
  const usageLimitRetriedAgents = new Set<string>();
  const pendingRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastActivityAtByAgent = new Map<string, number>();
  const stalledNudgedAtByAgent = new Map<string, number>();
  let unsubscribeEvents: (() => void) | null = null;
  let stalledTimer: ReturnType<typeof setInterval> | null = null;

  const transientDelayMs = deps.transientRetryDelayMs ?? DEFAULT_TRANSIENT_RETRY_DELAY_MS;
  const stalledThresholdMs = deps.stalledThresholdMs ?? DEFAULT_STALLED_THRESHOLD_MS;
  const stalledCheckIntervalMs = deps.stalledCheckIntervalMs ?? DEFAULT_STALLED_CHECK_INTERVAL_MS;

  function clearRetryTimer(agentId: string): void {
    const existing = pendingRetryTimers.get(agentId);
    if (existing) {
      clearTimeout(existing);
      pendingRetryTimers.delete(agentId);
    }
  }

  function clearAgentState(agentId: string): void {
    clearRetryTimer(agentId);
    transientRetriesByAgent.delete(agentId);
    usageLimitRetriedAgents.delete(agentId);
    lastActivityAtByAgent.delete(agentId);
    stalledNudgedAtByAgent.delete(agentId);
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

  function scheduleTransientRetry(agentId: string, errorMessage: string): void {
    const retries = transientRetriesByAgent.get(agentId) ?? 0;
    if (retries >= MAX_TRANSIENT_AUTO_RETRIES) return;
    const attempt = retries + 1;
    transientRetriesByAgent.set(agentId, attempt);
    deps.logger.info(
      { agentId, attempt, error: errorMessage },
      "Scheduling automatic retry for main-chat child agent after transient turn failure",
    );
    dispatchDelayedResume({
      agentId,
      delayMs: transientDelayMs,
      prompt: "刚才遇到了临时服务或网络错误，请从中断处继续完成当前任务。",
      logReason: "transient retry",
      onDispatched: async () => {
        await deps.store.incrementMetric("autoContinued");
      },
    });
  }

  function scheduleUsageLimitRetry(agentId: string, errorMessage: string): void {
    if (usageLimitRetriedAgents.has(agentId)) return;
    usageLimitRetriedAgents.add(agentId);
    const delayMs = deps.usageLimitRetryDelayMs ?? parseUsageLimitResetDelayMs(errorMessage);
    deps.logger.info(
      { agentId, delayMs, error: errorMessage },
      "Scheduling delayed resume for main-chat child agent after usage limit",
    );
    dispatchDelayedResume({
      agentId,
      delayMs,
      prompt: "额度限流窗口已等待结束，请从中断处继续推进并完成当前任务。",
      logReason: "usage-limit retry",
      onDispatched: async () => {
        await deps.store.incrementMetric("usageLimitRetries");
        await deps.store.incrementMetric("autoContinued");
      },
    });
  }

  function handlePermissionRequested(agent: ManagedAgent, request: AgentPermissionRequest): void {
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

    if (!matched) {
      void deps.store.incrementMetric("interrupts").catch(() => undefined);
      return;
    }

    deps.logger.info(
      { agentId: agent.id, requestId: request.id, ruleId: matched.id, toolName: matched.toolName },
      "Auto-approving child agent permission request from saved main-chat rule",
    );
    void deps.agentManager
      .respondToPermission(agent.id, request.id, { behavior: "allow" })
      .then(() => deps.store.incrementMetric("supervisorHeld"))
      .catch((error) => {
        deps.logger.warn(
          { err: error, agentId: agent.id, requestId: request.id },
          "Supervisor auto-approval failed; leaving request for user",
        );
      });
  }

  function handleTurnFailed(agent: ManagedAgent, errorMessage: string): void {
    const errorClass = classifyMainChatTurnError(errorMessage);
    if (errorClass === "transient") {
      scheduleTransientRetry(agent.id, errorMessage);
      return;
    }
    if (errorClass === "usage_limit") {
      scheduleUsageLimitRetry(agent.id, errorMessage);
      return;
    }
    void deps.store.incrementMetric("interrupts").catch(() => undefined);
  }

  function handleManagerEvent(event: AgentManagerEvent): void {
    if (event.type === "agent_removed") {
      clearAgentState(event.agentId);
      return;
    }
    if (event.type === "agent_state") {
      if (event.agent.lifecycle === "running" && !lastActivityAtByAgent.has(event.agent.id)) {
        lastActivityAtByAgent.set(event.agent.id, Date.now());
      }
      return;
    }
    if (event.type !== "agent_stream") return;

    lastActivityAtByAgent.set(event.agentId, Date.now());
    stalledNudgedAtByAgent.delete(event.agentId);

    if (event.event.type === "turn_completed") {
      clearRetryTimer(event.agentId);
      transientRetriesByAgent.delete(event.agentId);
      usageLimitRetriedAgents.delete(event.agentId);
      return;
    }

    const agent = deps.agentManager.getAgent(event.agentId);
    if (!isSupervisedChildAgent(agent)) return;

    if (event.event.type === "turn_failed") {
      handleTurnFailed(agent, event.event.error);
      return;
    }
    if (event.event.type === "permission_requested") {
      handlePermissionRequested(agent, event.event.request);
    }
  }

  function checkStalledChildAgents(): void {
    const now = Date.now();
    for (const agent of deps.agentManager.listAgents()) {
      if (!isSupervisedChildAgent(agent)) continue;
      if (agent.lifecycle !== "running" || agent.pendingPermissions.size > 0) continue;
      const lastActivity = lastActivityAtByAgent.get(agent.id) ?? agent.updatedAt.getTime();
      if (now - lastActivity < stalledThresholdMs) continue;
      if (stalledNudgedAtByAgent.has(agent.id)) continue;

      stalledNudgedAtByAgent.set(agent.id, now);
      deps.logger.info(
        { agentId: agent.id, idleMs: now - lastActivity },
        "Nudging quiet running main-chat child agent",
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
    }
  }

  return {
    start() {
      if (unsubscribeEvents) return;
      unsubscribeEvents = deps.agentManager.subscribe(handleManagerEvent);
      stalledTimer = setInterval(checkStalledChildAgents, stalledCheckIntervalMs);
      stalledTimer.unref?.();
    },

    stop() {
      unsubscribeEvents?.();
      unsubscribeEvents = null;
      if (stalledTimer) {
        clearInterval(stalledTimer);
        stalledTimer = null;
      }
      for (const timer of pendingRetryTimers.values()) {
        clearTimeout(timer);
      }
      pendingRetryTimers.clear();
    },
  };
}
