import type { Logger } from "pino";
import {
  isMainChatEnabled,
  isMainChatLabels,
  resolveMainChatCacheKeepaliveConfig,
  type MainChatCacheKeepaliveStatus,
  type MainChatConversationRecord,
  type MainChatNightModeStatus,
  type MainChatSettings,
} from "@getpaseo/protocol/main-chat";
import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { AgentManager, ManagedAgent } from "../agent/agent-manager.js";
import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import { AgentTurnBusyError, sendPreparedPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { MainChatStore } from "./store.js";
import type { MainChatTurnQueue } from "./turn-queue.js";

const DEFAULT_KEEPALIVE_CHECK_INTERVAL_MS = 60_000;
const CACHE_TTL_MAX_IDLE_MS = 60 * 60 * 1_000;

export interface CacheKeepaliveTarget {
  agentId: string;
  role: "main" | "leader";
  conversationId: string;
  title: string;
}

export interface CacheKeepalivePingOutcome {
  sent: boolean;
  detail?: string | null;
}

export type CacheKeepaliveRunner = (
  target: CacheKeepaliveTarget,
  signal?: AbortSignal,
) => Promise<CacheKeepalivePingOutcome>;

export interface MainChatCacheKeepaliveDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  store: MainChatStore;
  turnQueue: MainChatTurnQueue;
  getNightModeStatus: () => MainChatNightModeStatus;
  listActiveConversations: () => Promise<MainChatConversationRecord[]>;
  findMainChatAgentId: () => Promise<string | null>;
  logger: Logger;
  now?: () => number;
  checkIntervalMs?: number;
  runner?: CacheKeepaliveRunner;
}

export interface MainChatCacheKeepaliveScheduler {
  start(): void;
  stop(): void;
  tick(): Promise<number>;
  /** Records explicit foreground user activity (always resets idle keepalive stretch). */
  notifyRealActivity(agentId: string): void;
  /**
   * Records a `turn_completed` stream event on `agentId`. Ignored while this scheduler's own
   * keepalive turn is in flight on `agentId`; otherwise resets the idle keepalive stretch.
   */
  notifyTurnCompleted(agentId: string): void;
  isKeepaliveInFlight(agentId: string): boolean;
  clearAgent(agentId: string): void;
  getStatus(): MainChatCacheKeepaliveStatus;
}

interface TargetKeepaliveState {
  lastRealActivityAtMs: number;
  lastPingAtMs: number | null;
  pingsSinceLastRealTurn: number;
}

interface InFlightKeepaliveFlight {
  interruptedByRealActivity: boolean;
}

function makeActivityId(): string {
  return `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function isAgentEligibleForKeepalive(
  agent: ManagedAgent | null | undefined,
  role: "main" | "leader",
): agent is ManagedAgent {
  if (!agent) return false;
  if (agent.background || agent.internal) return false;
  if (getParentAgentIdFromLabels(agent.labels)) return false;
  if (role === "main" && !isMainChatLabels(agent.labels)) return false;
  return true;
}

function hasWarmContext(agent: ManagedAgent, agentManager: AgentManager): boolean {
  if (agent.lastUsage) {
    const used =
      (agent.lastUsage.contextWindowUsedTokens ?? 0) +
      (agent.lastUsage.inputTokens ?? 0) +
      (agent.lastUsage.cachedInputTokens ?? 0);
    if (used > 0) return true;
  }
  const timeline = agentManager.getTimeline(agent.id);
  return timeline.some((item) => item.type === "assistant_message");
}

function buildKeepaliveProbePrompt(target: CacheKeepaliveTarget): string {
  const roleLabel = target.role === "main" ? "主对话" : `方向主管「${target.title}」`;
  return formatSystemNotificationPrompt(
    `【Prompt Cache 定时保活】当前 ${roleLabel} 处于空闲态，本轮仅用于刷新提示词前缀缓存。请不要调用任何工具，直接只回复 \`[SILENT]\`。`,
    {
      kind: "cache_keepalive",
      trigger: "cache_keepalive",
      label: `缓存保活 · ${target.title}`,
      quiet: true,
    },
  );
}

/**
 * Periodically refreshes prompt caches for the active Main Chat and resident Direction Leaders
 * while idle, modeled after Persona's `cache_keepalive.go` eligibility and `cachewarm` bounds:
 * - Only active main + pinned leader conversations (never side chats, subagents, or manual sessions).
 * - Automatically yields during night-mode hibernation, foreground user activity, or running turns.
 * - Enforces configurable interval (1–55m) and consecutive ping cap (1–144) per idle stretch.
 */
export function createMainChatCacheKeepaliveScheduler(
  deps: MainChatCacheKeepaliveDependencies,
): MainChatCacheKeepaliveScheduler {
  const getNowMs = deps.now ?? (() => Date.now());
  const checkIntervalMs = deps.checkIntervalMs ?? DEFAULT_KEEPALIVE_CHECK_INTERVAL_MS;
  const targetStates = new Map<string, TargetKeepaliveState>();
  const inFlightKeepaliveByAgent = new Map<string, InFlightKeepaliveFlight>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;
  let pingsSentTotal = 0;
  let lastPingAt: string | null = null;
  let lastYieldReason: string | null = null;
  let lastActiveTargets = 0;

  async function resolveEligibleTargets(): Promise<CacheKeepaliveTarget[]> {
    const targets: CacheKeepaliveTarget[] = [];
    const seen = new Set<string>();

    const mainAgentId = await deps.findMainChatAgentId();
    if (mainAgentId) {
      const stored = await deps.agentStorage.get(mainAgentId);
      const live = deps.agentManager.getAgent(mainAgentId);
      if (!stored?.archivedAt && isAgentEligibleForKeepalive(live, "main")) {
        seen.add(mainAgentId);
        targets.push({
          agentId: mainAgentId,
          role: "main",
          conversationId: "conv_main",
          title: live.config.title?.trim() || "主对话",
        });
      }
    }

    const conversations = await deps.listActiveConversations();
    for (const conv of conversations) {
      if (conv.kind !== "leader" || conv.archivedAt) continue;
      if (seen.has(conv.agentId)) continue;
      const stored = await deps.agentStorage.get(conv.agentId);
      const live = deps.agentManager.getAgent(conv.agentId);
      if (!stored?.archivedAt && isAgentEligibleForKeepalive(live, "leader")) {
        seen.add(conv.agentId);
        targets.push({
          agentId: conv.agentId,
          role: "leader",
          conversationId: conv.id,
          title: conv.title,
        });
      }
    }

    lastActiveTargets = targets.length;
    return targets;
  }

  function isTargetBusy(target: CacheKeepaliveTarget, live: ManagedAgent): boolean {
    if (live.lifecycle === "running" || deps.agentManager.hasInFlightRun(target.agentId)) {
      return true;
    }
    if (target.role === "main") {
      if (
        deps.turnQueue.isForegroundActive(target.agentId) ||
        deps.turnQueue.isBackgroundBusy(target.agentId)
      ) {
        return true;
      }
    }
    return false;
  }

  async function waitForKeepaliveTurnToSettle(agentId: string): Promise<void> {
    if (typeof deps.agentManager.waitForAgentEvent !== "function") {
      return;
    }
    const live = deps.agentManager.getAgent(agentId);
    if (live?.lifecycle === "running" || deps.agentManager.hasInFlightRun(agentId)) {
      await deps.agentManager
        .waitForAgentEvent(agentId, { waitForActive: true })
        .catch(() => undefined);
    }
  }

  async function dispatchKeepalivePing(
    target: CacheKeepaliveTarget,
    signal?: AbortSignal,
  ): Promise<CacheKeepalivePingOutcome> {
    if (signal?.aborted) {
      return { sent: false, detail: "用户恢复活跃，缓存保活已让路" };
    }
    const flight: InFlightKeepaliveFlight = { interruptedByRealActivity: false };
    inFlightKeepaliveByAgent.set(target.agentId, flight);
    try {
      if (deps.runner) {
        const outcome = await deps.runner(target, signal);
        return {
          sent: outcome.sent && !flight.interruptedByRealActivity && !signal?.aborted,
          detail: outcome.detail ?? null,
        };
      }
      const prompt = buildKeepaliveProbePrompt(target);
      let dispatch: Awaited<ReturnType<typeof sendPreparedPromptToAgent>>;
      try {
        dispatch = await sendPreparedPromptToAgent({
          agentId: target.agentId,
          prompt,
          agentManager: deps.agentManager,
          agentStorage: deps.agentStorage,
          logger: deps.logger,
          unarchive: false,
          idleOnly: true,
        });
      } catch (error) {
        if (error instanceof AgentTurnBusyError) {
          return { sent: false, detail: "目标会话忙，缓存保活已让路" };
        }
        throw error;
      }
      if (dispatch.disposition === "turn_started") {
        await dispatch.started;
        await waitForKeepaliveTurnToSettle(target.agentId);
      }
      return {
        sent: !flight.interruptedByRealActivity && !signal?.aborted,
        detail: `已刷新 ${target.role === "main" ? "主对话" : `方向「${target.title}」`} Prompt Cache`,
      };
    } finally {
      // Flush one microtask turn so any async subscriber processing this keepalive's own
      // turn_completed still sees the agent marked as in-flight before we clear it.
      await Promise.resolve();
      if (inFlightKeepaliveByAgent.get(target.agentId) === flight) {
        inFlightKeepaliveByAgent.delete(target.agentId);
      }
    }
  }

  async function dispatchKeepaliveForTarget(target: CacheKeepaliveTarget): Promise<boolean> {
    if (target.role === "main") {
      let sent = false;
      const enqueued = await deps.turnQueue.enqueueBackground({
        mainAgentId: target.agentId,
        dedupeKey: `cache_keepalive:${target.agentId}`,
        trigger: "cache_keepalive",
        priority: 0,
        summary: `Prompt Cache 定时保活（${target.title}）`,
        requeueOnPreempt: false,
        customExecute: async (signal) => {
          if (signal.aborted || deps.turnQueue.isForegroundActive(target.agentId)) {
            lastYieldReason = "user_active";
            return { summary: "用户恢复活跃，缓存保活已让路", silent: true };
          }
          const outcome = await dispatchKeepalivePing(target, signal);
          sent = outcome.sent;
          return {
            summary: outcome.sent ? `缓存保活完成（${target.title}）` : "缓存保活已让路",
            silent: true,
            detail: outcome.detail ?? null,
          };
        },
      });
      if (enqueued.status !== "dispatched" && !sent) {
        lastYieldReason = "user_active";
        return false;
      }
      return sent;
    }

    const outcome = await dispatchKeepalivePing(target);
    if (!outcome.sent) return false;
    const nowIso = new Date(getNowMs()).toISOString();
    const mainId = (await deps.findMainChatAgentId()) ?? target.agentId;
    await deps.store
      .appendActivity({
        id: makeActivityId(),
        mainAgentId: mainId,
        kind: "silent_turn",
        trigger: "cache_keepalive",
        summary: `方向「${target.title}」Prompt Cache 保活完成`,
        silent: true,
        status: "completed",
        createdAt: nowIso,
        completedAt: nowIso,
        relatedAgentId: target.agentId,
        detail: outcome.detail ?? null,
      })
      .catch(() => undefined);
    return true;
  }

  async function runSingleTargetPing(
    target: CacheKeepaliveTarget,
    settings: MainChatSettings,
  ): Promise<boolean> {
    const config = resolveMainChatCacheKeepaliveConfig(settings);
    const live = deps.agentManager.getAgent(target.agentId);
    if (!isAgentEligibleForKeepalive(live, target.role)) {
      targetStates.delete(target.agentId);
      inFlightKeepaliveByAgent.delete(target.agentId);
      return false;
    }

    // Never treat our own in-flight keepalive turn as user activity or reset pingsSinceLastRealTurn.
    if (inFlightKeepaliveByAgent.has(target.agentId)) {
      return false;
    }

    const nowMs = getNowMs();
    const fallbackActivityMs =
      target.role === "main"
        ? Math.max(deps.turnQueue.getLastActivityAtMs(target.agentId), live.updatedAt.getTime())
        : live.updatedAt.getTime();
    const state: TargetKeepaliveState = targetStates.get(target.agentId) ?? {
      lastRealActivityAtMs: fallbackActivityMs,
      lastPingAtMs: null,
      pingsSinceLastRealTurn: 0,
    };
    targetStates.set(target.agentId, state);

    if (isTargetBusy(target, live)) {
      state.lastRealActivityAtMs = nowMs;
      state.lastPingAtMs = null;
      state.pingsSinceLastRealTurn = 0;
      lastYieldReason = "user_active";
      return false;
    }

    if (!hasWarmContext(live, deps.agentManager)) {
      lastYieldReason = "no_warm_context";
      return false;
    }

    if (state.pingsSinceLastRealTurn >= config.maxRequests) {
      lastYieldReason = "max_requests_reached";
      return false;
    }

    const intervalMs = config.intervalMinutes * 60_000;
    const referenceMs = state.lastPingAtMs ?? state.lastRealActivityAtMs;
    const elapsedMs = Math.max(0, nowMs - referenceMs);
    if (elapsedMs < intervalMs) {
      return false;
    }

    // If the last cache write is vastly stale (> 2h), let the next real turn rebuild cache instead.
    if (
      state.lastPingAtMs === null &&
      intervalMs < CACHE_TTL_MAX_IDLE_MS &&
      elapsedMs >= 2 * CACHE_TTL_MAX_IDLE_MS
    ) {
      lastYieldReason = "cache_expired";
      return false;
    }

    const sent = await dispatchKeepaliveForTarget(target);
    if (!sent) {
      return false;
    }

    const doneMs = getNowMs();
    const latestState = targetStates.get(target.agentId) ?? state;
    latestState.lastPingAtMs = doneMs;
    latestState.pingsSinceLastRealTurn += 1;
    targetStates.set(target.agentId, latestState);
    pingsSentTotal += 1;
    lastPingAt = new Date(doneMs).toISOString();
    lastYieldReason = null;
    deps.logger.debug(
      {
        agentId: target.agentId,
        role: target.role,
        pingsSinceLastRealTurn: latestState.pingsSinceLastRealTurn,
        maxRequests: config.maxRequests,
      },
      "Main-chat prompt cache keepalive ping completed",
    );
    return true;
  }

  async function tickInternal(): Promise<number> {
    if (ticking) return 0;
    ticking = true;
    try {
      await deps.store.load();
      const settings = deps.store.getSettings();
      const config = resolveMainChatCacheKeepaliveConfig(settings);
      if (!isMainChatEnabled(settings) || !config.enabled) {
        lastYieldReason = "disabled";
        lastActiveTargets = 0;
        return 0;
      }
      if (deps.getNightModeStatus().state === "hibernating") {
        lastYieldReason = "night_hibernating";
        return 0;
      }

      const targets = await resolveEligibleTargets();
      let sentCount = 0;
      for (const target of targets) {
        if (deps.getNightModeStatus().state === "hibernating") {
          lastYieldReason = "night_hibernating";
          break;
        }
        try {
          if (await runSingleTargetPing(target, settings)) {
            sentCount += 1;
          }
        } catch (error) {
          deps.logger.warn(
            { err: error, agentId: target.agentId, role: target.role },
            "Prompt cache keepalive ping failed",
          );
        }
      }
      return sentCount;
    } finally {
      ticking = false;
    }
  }

  return {
    start() {
      if (timer || checkIntervalMs <= 0) return;
      timer = setInterval(() => {
        void tickInternal().catch((error) => {
          deps.logger.warn({ err: error }, "Cache keepalive scheduler tick failed");
        });
      }, checkIntervalMs);
      timer.unref?.();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    tick: tickInternal,

    notifyRealActivity(agentId) {
      const flight = inFlightKeepaliveByAgent.get(agentId);
      if (flight) {
        flight.interruptedByRealActivity = true;
      }
      const nowMs = getNowMs();
      targetStates.set(agentId, {
        lastRealActivityAtMs: nowMs,
        lastPingAtMs: null,
        pingsSinceLastRealTurn: 0,
      });
    },

    notifyTurnCompleted(agentId) {
      // Never let a keepalive turn's own turn_completed reset pingsSinceLastRealTurn / lastPingAtMs.
      if (inFlightKeepaliveByAgent.has(agentId)) {
        return;
      }
      const nowMs = getNowMs();
      targetStates.set(agentId, {
        lastRealActivityAtMs: nowMs,
        lastPingAtMs: null,
        pingsSinceLastRealTurn: 0,
      });
    },

    isKeepaliveInFlight(agentId) {
      return inFlightKeepaliveByAgent.has(agentId);
    },

    clearAgent(agentId) {
      targetStates.delete(agentId);
      inFlightKeepaliveByAgent.delete(agentId);
    },

    getStatus() {
      const settings = deps.store.getSettings();
      const config = resolveMainChatCacheKeepaliveConfig(settings);
      return {
        enabled: isMainChatEnabled(settings) && config.enabled,
        intervalMinutes: config.intervalMinutes,
        maxRequests: config.maxRequests,
        activeTargets: lastActiveTargets,
        pingsSentTotal,
        lastPingAt,
        lastYieldReason,
      };
    },
  };
}
