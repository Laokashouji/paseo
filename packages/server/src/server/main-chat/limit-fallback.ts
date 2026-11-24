import type { Logger } from "pino";
import {
  MAIN_CHAT_REPLACED_BY_LABEL,
  formatMainChatModelSpec,
  getMainChatTaskMetaFromLabels,
  isFormerMainChatLabels,
  isMainChatEnabled,
  isMainChatLabels,
  resolveMainChatLimitFallbacks,
  type MainChatLimitFallbackEntry,
  type MainChatLimitFallbackEvent,
} from "@getpaseo/protocol/main-chat";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import { isCancelledTurnError, isLimitFallbackError } from "./triage.js";
import type { MainChatStore } from "./store.js";

const HANDOFF_BLOCK_LABEL_KEYS = [
  "paseo.handoff",
  "paseo.handoff.source-agent-id",
  "paseo.handoff.from",
  "paseo.handoff.interrupted",
  MAIN_CHAT_REPLACED_BY_LABEL,
] as const;

export type LimitFallbackAgentRole = "main" | "managed_task";

export type LimitFallbackEligibilityResult =
  | { eligible: true; role: LimitFallbackAgentRole; logicalKey: string }
  | { eligible: false; reason: string };

export interface LimitFallbackSwitchOutcome {
  switched: boolean;
  reason: string;
  event?: MainChatLimitFallbackEvent;
  newAgentId?: string;
}

interface FallbackEpisodeState {
  attemptedSpecs: Set<string>;
  switchCount: number;
  lastSwitchedAtMs: number;
}

export interface MainChatLimitFallbackDependencies {
  agentManager: AgentManager;
  providerSnapshotManager: ProviderSnapshotManager;
  store: MainChatStore;
  logger: Logger;
  now?: () => number;
  switchMainCrossProvider: (input: {
    mainAgentId: string;
    targetProvider: string;
    targetModel: string | null;
    reason: string;
  }) => Promise<{ agentId: string }>;
  resumeAfterFallback: (input: {
    agentId: string;
    role: LimitFallbackAgentRole;
    fromSpec: string;
    toSpec: string;
    reason: string;
  }) => Promise<void>;
  notifyLimitFallback?: (event: MainChatLimitFallbackEvent) => void;
}

export interface MainChatLimitFallbackController {
  handleTurnLimitError(
    agent: ManagedAgent,
    errorMessage: string,
  ): Promise<LimitFallbackSwitchOutcome>;
  handleTurnCompleted(agent: ManagedAgent): void;
  clearLogicalKey(logicalKey: string): void;
}

function makeEventId(): string {
  return `lfb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeModelSpecKey(provider: string, model?: string | null): string {
  return `${provider.trim().toLowerCase()}::${(model?.trim() ?? "").toLowerCase()}`;
}

function hasHandoffBlockLabel(labels: Record<string, string> | undefined): boolean {
  if (!labels) return false;
  for (const key of HANDOFF_BLOCK_LABEL_KEYS) {
    const val = labels[key];
    if (typeof val === "string" && val.trim().length > 0 && val.trim() !== "false") {
      return true;
    }
  }
  return false;
}

function isManagedSubtaskAgent(agent: ManagedAgent): boolean {
  if (agent.internal || agent.background || isMainChatLabels(agent.labels)) return false;
  const parentId = getParentAgentIdFromLabels(agent.labels);
  const taskMeta = getMainChatTaskMetaFromLabels(agent.labels);
  return Boolean(parentId && taskMeta?.planId);
}

/**
 * Strictly enforces limit-fallback scope:
 * - ONLY active Main Chat (`paseo.role=main`) and steward-managed subtasks (`planId` + `parentId`).
 * - STRICTLY FORBIDDEN for user manual sessions, handoff/replaced/former sessions, background/internal
 *   agents, or user-cancelled turns.
 */
export function evaluateLimitFallbackEligibility(
  agent: ManagedAgent | null | undefined,
  errorMessage: string,
): LimitFallbackEligibilityResult {
  if (!agent) {
    return { eligible: false, reason: "agent_missing" };
  }
  if (isCancelledTurnError(errorMessage)) {
    return { eligible: false, reason: "cancelled_turn" };
  }
  if (!isLimitFallbackError(errorMessage)) {
    return { eligible: false, reason: "not_limit_error" };
  }
  if (agent.background || agent.internal) {
    return { eligible: false, reason: "background_or_internal" };
  }
  if (isFormerMainChatLabels(agent.labels) || hasHandoffBlockLabel(agent.labels)) {
    return { eligible: false, reason: "handoff_or_replaced_session" };
  }
  if (isMainChatLabels(agent.labels)) {
    return { eligible: true, role: "main", logicalKey: "main" };
  }
  if (isManagedSubtaskAgent(agent)) {
    const taskMeta = getMainChatTaskMetaFromLabels(agent.labels);
    const logicalKey = taskMeta?.taskId ? `task:${taskMeta.taskId}` : `agent:${agent.id}`;
    return { eligible: true, role: "managed_task", logicalKey };
  }
  return { eligible: false, reason: "manual_user_session_forbidden" };
}

function isProviderHealthyInSnapshot(
  providerSnapshotManager: ProviderSnapshotManager,
  cwd: string,
  provider: string,
): boolean {
  try {
    const snapshot = providerSnapshotManager.getSnapshot(cwd);
    if (!snapshot.records || snapshot.records.length === 0) {
      // Snapshot not yet populated in minimal harnesses — allow attempting the configured fallback.
      return true;
    }
    const matched = snapshot.records
      .map((record) => record.entry)
      .find((entry) => entry.provider === provider);
    if (!matched) return true;
    return matched.enabled !== false;
  } catch {
    return true;
  }
}

function selectNextFallbackCandidate(input: {
  fallbacks: readonly MainChatLimitFallbackEntry[];
  attemptedSpecs: ReadonlySet<string>;
  currentProvider: string;
  role: LimitFallbackAgentRole;
  cwd: string;
  providerSnapshotManager: ProviderSnapshotManager;
}): MainChatLimitFallbackEntry | null {
  for (const candidate of input.fallbacks) {
    const key = normalizeModelSpecKey(candidate.provider, candidate.model ?? null);
    if (input.attemptedSpecs.has(key)) continue;
    // Managed subtasks switch models in-place via `setAgentModel`, which is same-provider;
    // Main Chat supports both same-provider `setAgentModel` and cross-provider handoff session switch.
    if (input.role === "managed_task" && candidate.provider !== input.currentProvider) {
      continue;
    }
    if (
      !isProviderHealthyInSnapshot(input.providerSnapshotManager, input.cwd, candidate.provider)
    ) {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * Anti-loop sequential fallback switcher for usage/rate/quota limits (429, quota, rate limit,
 * usage limit). Tracks tried models per logical session (`main` or `task:<id>`) so repeated
 * failures walk strictly forward through `settings.limitFallbacks` and never cycle.
 */
export function createMainChatLimitFallbackController(
  deps: MainChatLimitFallbackDependencies,
): MainChatLimitFallbackController {
  const getNowMs = deps.now ?? (() => Date.now());
  const episodes = new Map<string, FallbackEpisodeState>();
  const inFlightKeys = new Set<string>();

  async function recordAndResumeSwitch(input: {
    agent: ManagedAgent;
    role: "main" | "managed_task";
    logicalKey: string;
    targetAgentId: string;
    currentProvider: string;
    currentModel: string | null;
    targetProvider: string;
    targetModel: string | null;
    fromSpec: string;
    toSpec: string;
    switchCount: number;
    errorMessage: string;
  }): Promise<MainChatLimitFallbackEvent> {
    const nowIso = new Date(getNowMs()).toISOString();
    const event: MainChatLimitFallbackEvent = {
      id: makeEventId(),
      agentId: input.targetAgentId,
      agentRole: input.role,
      fromProvider: input.currentProvider,
      fromModel: input.currentModel,
      toProvider: input.targetProvider,
      toModel: input.targetModel,
      reason: input.errorMessage.slice(0, 180),
      createdAt: nowIso,
    };
    const roleSummary =
      input.role === "main"
        ? "主对话"
        : `子任务「${input.agent.config.title?.trim() || input.agent.id}」`;
    await deps.store.appendLimitFallbackEvent(event);
    await deps.store.appendActivity({
      id: `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      mainAgentId:
        input.role === "main"
          ? input.targetAgentId
          : (getParentAgentIdFromLabels(input.agent.labels) ?? input.targetAgentId),
      kind: "background_turn",
      trigger: "limit_fallback",
      summary: `${roleSummary}触发限额，已自动切换备用模型 ${input.fromSpec} → ${input.toSpec}`,
      silent: false,
      status: "completed",
      createdAt: nowIso,
      completedAt: nowIso,
      relatedAgentId: input.targetAgentId,
      detail: input.errorMessage.slice(0, 240),
    });

    deps.logger.info(
      {
        logicalKey: input.logicalKey,
        role: input.role,
        fromSpec: input.fromSpec,
        toSpec: input.toSpec,
        agentId: input.targetAgentId,
        switchCount: input.switchCount,
      },
      "Auto-switched agent to fallback model after limit error",
    );
    deps.notifyLimitFallback?.(event);

    await deps.resumeAfterFallback({
      agentId: input.targetAgentId,
      role: input.role,
      fromSpec: input.fromSpec,
      toSpec: input.toSpec,
      reason: input.errorMessage.slice(0, 160),
    });
    return event;
  }

  return {
    async handleTurnLimitError(agent, errorMessage) {
      const eligibility = evaluateLimitFallbackEligibility(agent, errorMessage);
      if (!eligibility.eligible) {
        return { switched: false, reason: eligibility.reason };
      }

      await deps.store.load();
      const settings = deps.store.getSettings();
      if (!isMainChatEnabled(settings)) {
        return { switched: false, reason: "main_chat_disabled" };
      }
      const fallbacks = resolveMainChatLimitFallbacks(settings);
      if (fallbacks.length === 0) {
        return { switched: false, reason: "no_limit_fallbacks_configured" };
      }
      if (inFlightKeys.has(eligibility.logicalKey)) {
        return { switched: false, reason: "fallback_switch_in_flight" };
      }

      const currentProvider = agent.provider;
      const currentModel = agent.runtimeInfo?.model ?? agent.config.model ?? null;
      const currentKey = normalizeModelSpecKey(currentProvider, currentModel);

      const episode: FallbackEpisodeState = episodes.get(eligibility.logicalKey) ?? {
        attemptedSpecs: new Set<string>(),
        switchCount: 0,
        lastSwitchedAtMs: 0,
      };
      episode.attemptedSpecs.add(currentKey);
      episodes.set(eligibility.logicalKey, episode);

      if (episode.switchCount >= fallbacks.length) {
        return { switched: false, reason: "limit_fallbacks_exhausted" };
      }

      const candidate = selectNextFallbackCandidate({
        fallbacks,
        attemptedSpecs: episode.attemptedSpecs,
        currentProvider,
        role: eligibility.role,
        cwd: agent.cwd,
        providerSnapshotManager: deps.providerSnapshotManager,
      });
      if (!candidate) {
        return { switched: false, reason: "no_remaining_eligible_fallback" };
      }

      const targetModel = candidate.model?.trim() || null;
      const fromSpec = formatMainChatModelSpec(currentProvider, currentModel);
      const toSpec = formatMainChatModelSpec(candidate.provider, targetModel);

      inFlightKeys.add(eligibility.logicalKey);
      try {
        // Mark attempted immediately before switching to prevent any concurrent or re-entrant loop.
        episode.attemptedSpecs.add(normalizeModelSpecKey(candidate.provider, targetModel));
        episode.switchCount += 1;
        episode.lastSwitchedAtMs = getNowMs();

        let targetAgentId = agent.id;
        if (candidate.provider === currentProvider) {
          if (typeof deps.agentManager.setAgentModel !== "function") {
            return { switched: false, reason: "set_agent_model_unsupported" };
          }
          await deps.agentManager.setAgentModel(agent.id, targetModel);
        } else {
          const switched = await deps.switchMainCrossProvider({
            mainAgentId: agent.id,
            targetProvider: candidate.provider,
            targetModel,
            reason: errorMessage.slice(0, 160),
          });
          targetAgentId = switched.agentId;
        }

        const event = await recordAndResumeSwitch({
          agent,
          role: eligibility.role,
          logicalKey: eligibility.logicalKey,
          targetAgentId,
          currentProvider,
          currentModel,
          targetProvider: candidate.provider,
          targetModel,
          fromSpec,
          toSpec,
          switchCount: episode.switchCount,
          errorMessage,
        });

        return { switched: true, reason: "switched", event, newAgentId: targetAgentId };
      } catch (error) {
        deps.logger.warn(
          { err: error, agentId: agent.id, fromSpec, toSpec },
          "Limit fallback model switch failed",
        );
        return {
          switched: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      } finally {
        inFlightKeys.delete(eligibility.logicalKey);
      }
    },

    handleTurnCompleted(agent) {
      if (isMainChatLabels(agent.labels)) {
        episodes.delete("main");
        return;
      }
      if (isManagedSubtaskAgent(agent)) {
        const taskMeta = getMainChatTaskMetaFromLabels(agent.labels);
        const key = taskMeta?.taskId ? `task:${taskMeta.taskId}` : `agent:${agent.id}`;
        episodes.delete(key);
      }
    },

    clearLogicalKey(logicalKey) {
      episodes.delete(logicalKey);
    },
  };
}
