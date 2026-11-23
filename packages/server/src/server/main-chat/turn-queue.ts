import type { Logger } from "pino";
import {
  isMainChatInlineCardToolName,
  isMainChatLabels,
  type MainChatActivityEntry,
} from "@getpaseo/protocol/main-chat";
import type { AgentManager, AgentManagerEvent } from "../agent/agent-manager.js";
import type { AgentProvider, AgentUsage } from "../agent/agent-sdk-types.js";
import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import { sendPromptToAgent } from "../agent/agent-prompt.js";
import {
  buildMissingReplyRecoveryPrompt,
  isSilentBackgroundReply,
  shouldRecoverMissingFinalReply,
} from "../agent/agent-response-loop.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { MainChatStore } from "./store.js";

const DEFAULT_DRAIN_DELAY_MS = 25;
const FOREGROUND_CLAIM_WINDOW_MS = 15_000;
const MAX_TRACKED_RECOVERY_EPOCHS = 50;

export interface BackgroundTurnRequest {
  mainAgentId: string;
  dedupeKey: string;
  trigger: string;
  summary: string;
  priority?: number;
  /**
   * Produces the prompt immediately before dispatch (dequeue-time revalidation).
   * Returning `null` skips dispatch cleanly when signals are no longer relevant.
   */
  buildPrompt?: () => Promise<string | null> | string | null;
  /** Optional custom async runner (e.g. idle pre-compaction) instead of sending a prompt. */
  customExecute?: (signal: AbortSignal) => Promise<{
    summary?: string;
    silent?: boolean;
    detail?: string | null;
  }>;
  /** Re-enqueue this item when preempted by a foreground user message (default: true). */
  requeueOnPreempt?: boolean;
  onDispatched?: () => Promise<void> | void;
  onCompleted?: (outcome: { silent: boolean; assistantText: string }) => Promise<void> | void;
}

export interface EnqueueBackgroundResult {
  status: "dispatched" | "queued" | "skipped";
  activityId: string;
}

export interface MainChatTurnQueueDependencies {
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  store: MainChatStore;
  logger: Logger;
  now?: () => number;
  drainDelayMs?: number;
  /** Subscribe directly to agentManager on start() (default: true). */
  autoSubscribe?: boolean;
  onCompactionObserved?: (mainAgentId: string) => void;
  onMainAgentTurnCompleted?: (info: {
    agentId: string;
    kind: "foreground" | "background";
    provider: AgentProvider;
    model: string | null;
    usage: AgentUsage;
  }) => void;
}

export interface MainChatTurnQueue {
  start(): void;
  stop(): void;
  handleEvent(event: AgentManagerEvent): void;
  enqueueBackground(request: BackgroundTurnRequest): Promise<EnqueueBackgroundResult>;
  beginForegroundDispatch(mainAgentId: string): () => void;
  abortForegroundDispatch(mainAgentId: string): void;
  preemptForForegroundUser(mainAgentId: string): Promise<{ preempted: boolean }>;
  isForegroundActive(mainAgentId: string): boolean;
  isBackgroundBusy(mainAgentId: string): boolean;
  getQueuedCount(mainAgentId: string): number;
  getIdleDurationMs(mainAgentId: string): number;
  getLastActivityAtMs(mainAgentId: string): number;
  clearAgentState(mainAgentId: string): void;
}

interface QueuedBackgroundItem {
  request: BackgroundTurnRequest;
  priority: number;
  enqueuedSeq: number;
  activityId: string;
}

interface ActiveTurnState {
  kind: "foreground" | "background";
  startedAtMs: number;
  activityId: string | null;
  request: BackgroundTurnRequest | null;
  abortController: AbortController | null;
  preemptedByUser: boolean;
  hadToolCalls: boolean;
  hadUserFacingCardTool: boolean;
  assistantTexts: string[];
  isRecoveryTurn: boolean;
  userPromptEpoch: number;
  streamObserved: boolean;
}

interface PerMainAgentState {
  activeTurn: ActiveTurnState | null;
  pendingRecoveryActivityId: string | null;
  foregroundDispatchInFlight: number;
  expectingForegroundTurnUntilMs: number;
  userPromptEpoch: number;
  recoveredEpochs: Set<number>;
  lastActivityAtMs: number;
  lastIdleAtMs: number;
  queue: QueuedBackgroundItem[];
  draining: boolean;
  drainTimer: ReturnType<typeof setTimeout> | null;
}

function makeActivityId(): string {
  return `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function combineAssistantTexts(texts: readonly string[]): string {
  return texts
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function createMainChatTurnQueue(deps: MainChatTurnQueueDependencies): MainChatTurnQueue {
  const getNowMs = deps.now ?? (() => Date.now());
  const drainDelayMs = Math.max(0, deps.drainDelayMs ?? DEFAULT_DRAIN_DELAY_MS);
  const stateByAgent = new Map<string, PerMainAgentState>();

  let unsubscribe: (() => void) | null = null;
  let nextSeq = 1;
  let stopped = false;

  function getOrCreateState(mainAgentId: string): PerMainAgentState {
    let state = stateByAgent.get(mainAgentId);
    if (!state) {
      const now = getNowMs();
      state = {
        activeTurn: null,
        pendingRecoveryActivityId: null,
        foregroundDispatchInFlight: 0,
        expectingForegroundTurnUntilMs: 0,
        userPromptEpoch: 0,
        recoveredEpochs: new Set(),
        lastActivityAtMs: now,
        lastIdleAtMs: now,
        queue: [],
        draining: false,
        drainTimer: null,
      };
      stateByAgent.set(mainAgentId, state);
    }
    return state;
  }

  function isMainChatAgentId(agentId: string): boolean {
    const live = deps.agentManager.getAgent(agentId);
    if (live) {
      return !live.background && !live.internal && isMainChatLabels(live.labels);
    }
    return stateByAgent.has(agentId);
  }

  function isForegroundBlocked(state: PerMainAgentState): boolean {
    if (state.foregroundDispatchInFlight > 0) return true;
    if (state.activeTurn?.kind === "foreground") return true;
    if (state.pendingRecoveryActivityId !== null) return true;
    if (state.expectingForegroundTurnUntilMs > getNowMs()) return true;
    return false;
  }

  function isAgentLiveRunning(mainAgentId: string): boolean {
    if (deps.agentManager.hasInFlightRun(mainAgentId)) return true;
    const live = deps.agentManager.getAgent(mainAgentId);
    return live?.lifecycle === "running";
  }

  function sortQueue(state: PerMainAgentState): void {
    state.queue.sort((left, right) => {
      if (right.priority !== left.priority) {
        return right.priority - left.priority;
      }
      return left.enqueuedSeq - right.enqueuedSeq;
    });
  }

  function clearDrainTimer(state: PerMainAgentState): void {
    if (state.drainTimer) {
      clearTimeout(state.drainTimer);
      state.drainTimer = null;
    }
  }

  function scheduleDrain(mainAgentId: string): void {
    if (stopped) return;
    const state = stateByAgent.get(mainAgentId);
    if (!state || state.queue.length === 0) return;
    if (isForegroundBlocked(state) || state.activeTurn !== null || state.draining) return;

    clearDrainTimer(state);
    state.drainTimer = setTimeout(() => {
      state.drainTimer = null;
      void drainNext(mainAgentId).catch((error) => {
        deps.logger.warn({ err: error, mainAgentId }, "Main chat background queue drain failed");
      });
    }, drainDelayMs);
    state.drainTimer.unref?.();
  }

  function insertQueuedItem(
    state: PerMainAgentState,
    request: BackgroundTurnRequest,
    existingActivityId?: string,
  ): { item: QueuedBackgroundItem; createdNew: boolean } {
    const priority = request.priority ?? 10;
    const existingIndex = state.queue.findIndex(
      (entry) => entry.request.dedupeKey === request.dedupeKey,
    );
    if (existingIndex >= 0) {
      const existing = state.queue[existingIndex]!;
      existing.request = request;
      existing.priority = Math.max(existing.priority, priority);
      sortQueue(state);
      return { item: existing, createdNew: false };
    }
    const item: QueuedBackgroundItem = {
      request,
      priority,
      enqueuedSeq: nextSeq++,
      activityId: existingActivityId ?? makeActivityId(),
    };
    state.queue.push(item);
    sortQueue(state);
    return { item, createdNew: true };
  }

  async function persistNewActivity(entry: MainChatActivityEntry): Promise<void> {
    await deps.store.appendActivity(entry).catch((error) => {
      deps.logger.warn({ err: error, activityId: entry.id }, "Failed to append main-chat activity");
    });
  }

  async function persistUpdateActivity(
    id: string,
    patch: Partial<Omit<MainChatActivityEntry, "id" | "mainAgentId" | "createdAt">>,
  ): Promise<void> {
    await deps.store.updateActivity(id, patch).catch((error) => {
      deps.logger.warn({ err: error, activityId: id }, "Failed to update main-chat activity");
    });
  }

  async function finalizeCompletedBackgroundTurn(
    mainAgentId: string,
    finished: ActiveTurnState,
  ): Promise<void> {
    if (finished.preemptedByUser) {
      return;
    }
    const nowIso = new Date(getNowMs()).toISOString();
    const combinedText = combineAssistantTexts(finished.assistantTexts);
    const silent = isSilentBackgroundReply({
      assistantTexts: finished.assistantTexts,
      hadUserFacingCardTool: finished.hadUserFacingCardTool,
    });

    if (finished.activityId) {
      if (silent) {
        await persistUpdateActivity(finished.activityId, {
          kind: "silent_turn",
          silent: true,
          status: "completed",
          completedAt: nowIso,
          detail: combinedText || null,
        });
        await deps.store.incrementMetric("silentTurns").catch(() => undefined);
      } else {
        await persistUpdateActivity(finished.activityId, {
          kind: "background_turn",
          silent: false,
          status: "completed",
          completedAt: nowIso,
          detail: combinedText.slice(0, 400),
        });
      }
    }

    if (silent && typeof deps.agentManager.clearAgentAttention === "function") {
      await deps.agentManager.clearAgentAttention(mainAgentId).catch(() => undefined);
    }

    if (finished.request?.onCompleted) {
      try {
        await finished.request.onCompleted({ silent, assistantText: combinedText });
      } catch (error) {
        deps.logger.warn(
          { err: error, mainAgentId },
          "Background turn onCompleted callback failed",
        );
      }
    }
  }

  async function triggerMissingReplyRecovery(
    mainAgentId: string,
    state: PerMainAgentState,
    userPromptEpoch: number,
  ): Promise<void> {
    if (stopped) return;
    if (state.recoveredEpochs.has(userPromptEpoch)) return;

    // Await storage lookup first so any synchronous turn_completed teardown finishes before
    // checking whether the agent is still idle.
    const record = await deps.agentStorage.get(mainAgentId);
    if (stopped || record?.archivedAt) return;
    if (state.recoveredEpochs.has(userPromptEpoch)) return;
    if (
      isForegroundBlocked(state) ||
      state.activeTurn !== null ||
      isAgentLiveRunning(mainAgentId)
    ) {
      return;
    }

    state.recoveredEpochs.add(userPromptEpoch);
    if (state.recoveredEpochs.size > MAX_TRACKED_RECOVERY_EPOCHS) {
      const oldest = state.recoveredEpochs.values().next().value;
      if (oldest !== undefined) state.recoveredEpochs.delete(oldest);
    }

    const activityId = makeActivityId();
    const nowIso = new Date(getNowMs()).toISOString();
    await persistNewActivity({
      id: activityId,
      mainAgentId,
      kind: "missing_reply_recovery",
      trigger: "missing_final_reply",
      summary: "前台轮次调用工具后未输出可见回复，已自动触发一次纯文本补答",
      silent: false,
      status: "running",
      createdAt: nowIso,
      completedAt: null,
    });
    await deps.store.incrementMetric("missingReplyRecoveries").catch(() => undefined);

    const recoveryTurn: ActiveTurnState = {
      kind: "foreground",
      startedAtMs: getNowMs(),
      activityId,
      request: null,
      abortController: null,
      preemptedByUser: false,
      hadToolCalls: false,
      hadUserFacingCardTool: false,
      assistantTexts: [],
      isRecoveryTurn: true,
      userPromptEpoch,
      streamObserved: false,
    };
    state.pendingRecoveryActivityId = activityId;
    state.activeTurn = recoveryTurn;

    try {
      const dispatch = await sendPromptToAgent({
        agentId: mainAgentId,
        prompt: formatSystemNotificationPrompt(buildMissingReplyRecoveryPrompt()),
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger: deps.logger,
        unarchive: false,
      });
      if (dispatch.disposition === "turn_started") {
        await dispatch.started.catch(() => undefined);
      }
      if (
        state.activeTurn === recoveryTurn &&
        !recoveryTurn.streamObserved &&
        !isAgentLiveRunning(mainAgentId)
      ) {
        state.activeTurn = null;
        state.pendingRecoveryActivityId = null;
        state.lastIdleAtMs = getNowMs();
        await persistUpdateActivity(activityId, {
          status: "completed",
          completedAt: new Date(getNowMs()).toISOString(),
        });
        scheduleDrain(mainAgentId);
      }
    } catch (error) {
      deps.logger.warn({ err: error, mainAgentId }, "Missing-reply recovery dispatch failed");
      if (state.activeTurn === recoveryTurn) {
        state.activeTurn = null;
      }
      state.pendingRecoveryActivityId = null;
      state.lastIdleAtMs = getNowMs();
      await persistUpdateActivity(activityId, {
        status: "failed",
        completedAt: new Date(getNowMs()).toISOString(),
        detail: error instanceof Error ? error.message : String(error),
      });
      scheduleDrain(mainAgentId);
    }
  }

  function canDispatchBackground(mainAgentId: string, state: PerMainAgentState): boolean {
    if (stopped) return false;
    return (
      !isForegroundBlocked(state) && state.activeTurn === null && !isAgentLiveRunning(mainAgentId)
    );
  }

  async function executeCustomBackgroundItem(
    mainAgentId: string,
    state: PerMainAgentState,
    item: QueuedBackgroundItem,
  ): Promise<EnqueueBackgroundResult> {
    const { request, activityId } = item;
    const abortController = new AbortController();
    const turn: ActiveTurnState = {
      kind: "background",
      startedAtMs: getNowMs(),
      activityId,
      request,
      abortController,
      preemptedByUser: false,
      hadToolCalls: false,
      hadUserFacingCardTool: false,
      assistantTexts: [],
      isRecoveryTurn: false,
      userPromptEpoch: state.userPromptEpoch,
      streamObserved: false,
    };
    state.activeTurn = turn;
    state.lastActivityAtMs = getNowMs();
    await persistUpdateActivity(activityId, { status: "running" });

    try {
      const outcome = await request.customExecute!(abortController.signal);
      if (!turn.preemptedByUser) {
        await persistUpdateActivity(activityId, {
          status: "completed",
          silent: outcome.silent ?? true,
          ...(outcome.summary ? { summary: outcome.summary } : {}),
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
          completedAt: new Date(getNowMs()).toISOString(),
        });
      }
    } catch (error) {
      if (!turn.preemptedByUser) {
        await persistUpdateActivity(activityId, {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
          completedAt: new Date(getNowMs()).toISOString(),
        });
      }
    } finally {
      if (state.activeTurn === turn) {
        state.activeTurn = null;
        state.lastIdleAtMs = getNowMs();
      }
    }
    scheduleDrain(mainAgentId);
    return { status: "dispatched", activityId };
  }

  async function dispatchPromptBackgroundItem(
    mainAgentId: string,
    state: PerMainAgentState,
    item: QueuedBackgroundItem,
  ): Promise<EnqueueBackgroundResult | null> {
    const { request, activityId } = item;
    let prompt: string | null = null;
    try {
      prompt = request.buildPrompt ? await request.buildPrompt() : null;
    } catch (error) {
      deps.logger.warn(
        { err: error, mainAgentId, trigger: request.trigger },
        "Failed to build background turn prompt",
      );
      await persistUpdateActivity(activityId, {
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
        completedAt: new Date(getNowMs()).toISOString(),
      });
      return null;
    }

    // Foreground user might have arrived while buildPrompt() was awaiting I/O.
    if (!canDispatchBackground(mainAgentId, state)) {
      insertQueuedItem(state, request, activityId);
      return { status: "queued", activityId };
    }

    if (!prompt || prompt.trim().length === 0) {
      await persistUpdateActivity(activityId, {
        status: "skipped",
        completedAt: new Date(getNowMs()).toISOString(),
        detail: "出队重验后无需要投递的新动态",
      });
      return null;
    }

    const turn: ActiveTurnState = {
      kind: "background",
      startedAtMs: getNowMs(),
      activityId,
      request,
      abortController: null,
      preemptedByUser: false,
      hadToolCalls: false,
      hadUserFacingCardTool: false,
      assistantTexts: [],
      isRecoveryTurn: false,
      userPromptEpoch: state.userPromptEpoch,
      streamObserved: false,
    };
    state.activeTurn = turn;
    state.lastActivityAtMs = getNowMs();
    await persistUpdateActivity(activityId, { status: "running" });

    try {
      const dispatch = await sendPromptToAgent({
        agentId: mainAgentId,
        prompt: formatSystemNotificationPrompt(prompt),
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger: deps.logger,
        unarchive: false,
      });
      if (request.onDispatched && !turn.preemptedByUser) {
        await request.onDispatched();
      }
      if (dispatch.disposition === "turn_started") {
        await dispatch.started.catch(() => undefined);
      }
      // For mock/non-streaming AgentManager implementations where streamAgent finishes without
      // emitting lifecycle events to subscribers, finalize the turn instead of staying stuck.
      if (state.activeTurn === turn && !turn.streamObserved && !isAgentLiveRunning(mainAgentId)) {
        state.activeTurn = null;
        state.lastIdleAtMs = getNowMs();
        await finalizeCompletedBackgroundTurn(mainAgentId, turn);
        scheduleDrain(mainAgentId);
      }
      return { status: "dispatched", activityId };
    } catch (error) {
      if (state.activeTurn === turn) {
        state.activeTurn = null;
        state.lastIdleAtMs = getNowMs();
      }
      if (!turn.preemptedByUser) {
        deps.logger.warn(
          { err: error, mainAgentId, trigger: request.trigger },
          "Background turn dispatch failed",
        );
        await persistUpdateActivity(activityId, {
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
          completedAt: new Date(getNowMs()).toISOString(),
        });
      }
      scheduleDrain(mainAgentId);
      return { status: "skipped", activityId };
    }
  }

  async function drainNext(mainAgentId: string): Promise<EnqueueBackgroundResult | null> {
    const state = stateByAgent.get(mainAgentId);
    if (!state || state.draining || state.queue.length === 0) return null;
    if (!canDispatchBackground(mainAgentId, state)) return null;

    state.draining = true;
    try {
      while (state.queue.length > 0) {
        if (!canDispatchBackground(mainAgentId, state)) {
          return null;
        }
        const next = state.queue.shift()!;
        const outcome = next.request.customExecute
          ? await executeCustomBackgroundItem(mainAgentId, state, next)
          : await dispatchPromptBackgroundItem(mainAgentId, state, next);
        if (outcome) {
          return outcome;
        }
      }
      return null;
    } finally {
      state.draining = false;
    }
  }

  function handleTurnStartedEvent(state: PerMainAgentState, now: number): void {
    state.lastActivityAtMs = now;
    if (state.activeTurn) {
      state.activeTurn.streamObserved = true;
      return;
    }
    const isRecovery = state.pendingRecoveryActivityId !== null;
    state.expectingForegroundTurnUntilMs = 0;
    if (!isRecovery) {
      state.userPromptEpoch += 1;
    }
    state.activeTurn = {
      kind: "foreground",
      startedAtMs: now,
      activityId: isRecovery ? state.pendingRecoveryActivityId : null,
      request: null,
      abortController: null,
      preemptedByUser: false,
      hadToolCalls: false,
      hadUserFacingCardTool: false,
      assistantTexts: [],
      isRecoveryTurn: isRecovery,
      userPromptEpoch: state.userPromptEpoch,
      streamObserved: true,
    };
  }

  function handleTimelineEvent(
    mainAgentId: string,
    state: PerMainAgentState,
    item: Extract<AgentManagerEvent, { type: "agent_stream" }>["event"] extends infer E
      ? E extends { type: "timeline"; item: infer I }
        ? I
        : never
      : never,
    now: number,
  ): void {
    state.lastActivityAtMs = now;
    if (item.type === "compaction" && item.status === "completed") {
      deps.onCompactionObserved?.(mainAgentId);
    }
    if (!state.activeTurn) return;
    state.activeTurn.streamObserved = true;
    if (item.type === "tool_call") {
      state.activeTurn.hadToolCalls = true;
      if (isMainChatInlineCardToolName(item.name)) {
        state.activeTurn.hadUserFacingCardTool = true;
      }
      return;
    }
    if (item.type === "assistant_message" && item.text.trim().length > 0) {
      state.activeTurn.assistantTexts.push(item.text);
    }
  }

  function handleTurnAbortedEvent(
    mainAgentId: string,
    state: PerMainAgentState,
    status: "skipped" | "failed",
    detail: string | undefined,
    now: number,
  ): void {
    const finished = state.activeTurn;
    state.activeTurn = null;
    state.pendingRecoveryActivityId = null;
    state.lastIdleAtMs = now;
    const shouldPersistBackground =
      finished?.kind === "background" && Boolean(finished.activityId) && !finished.preemptedByUser;
    const shouldPersistRecovery = Boolean(finished?.isRecoveryTurn && finished.activityId);
    if (finished?.activityId && (shouldPersistBackground || shouldPersistRecovery)) {
      void persistUpdateActivity(finished.activityId, {
        status,
        completedAt: new Date(now).toISOString(),
        ...(detail ? { detail } : {}),
      });
    }
    scheduleDrain(mainAgentId);
  }

  function handleTurnCompletedEvent(
    mainAgentId: string,
    state: PerMainAgentState,
    now: number,
    provider: AgentProvider,
    usage: AgentUsage | undefined,
  ): void {
    const finished = state.activeTurn;
    state.activeTurn = null;
    state.lastIdleAtMs = now;

    if (usage && deps.onMainAgentTurnCompleted) {
      const live = deps.agentManager.getAgent(mainAgentId);
      deps.onMainAgentTurnCompleted({
        agentId: mainAgentId,
        kind: finished?.kind === "background" ? "background" : "foreground",
        provider,
        model: live?.config.model ?? live?.runtimeInfo?.model ?? null,
        usage,
      });
    }

    if (!finished) {
      scheduleDrain(mainAgentId);
      return;
    }
    if (finished.kind === "background") {
      void finalizeCompletedBackgroundTurn(mainAgentId, finished).finally(() => {
        scheduleDrain(mainAgentId);
      });
      return;
    }
    if (finished.isRecoveryTurn) {
      const recoveryId = finished.activityId ?? state.pendingRecoveryActivityId;
      state.pendingRecoveryActivityId = null;
      if (recoveryId) {
        void persistUpdateActivity(recoveryId, {
          status: "completed",
          completedAt: new Date(now).toISOString(),
          detail: combineAssistantTexts(finished.assistantTexts).slice(0, 400) || null,
        });
      }
      scheduleDrain(mainAgentId);
      return;
    }

    const needsRecovery = shouldRecoverMissingFinalReply({
      hadToolCalls: finished.hadToolCalls,
      assistantTexts: finished.assistantTexts,
      canceled: false,
      failed: false,
      isBackground: false,
      isSilent: false,
      alreadyRecovered: state.recoveredEpochs.has(finished.userPromptEpoch),
    });
    if (needsRecovery) {
      void triggerMissingReplyRecovery(mainAgentId, state, finished.userPromptEpoch);
      return;
    }
    scheduleDrain(mainAgentId);
  }

  function handleAgentEvent(event: AgentManagerEvent): void {
    if (stopped) return;
    if (event.type === "agent_removed") {
      clearAgentState(event.agentId);
      return;
    }
    if (event.type !== "agent_stream" || !isMainChatAgentId(event.agentId)) return;

    const mainAgentId = event.agentId;
    const state = getOrCreateState(mainAgentId);
    const now = getNowMs();
    const stream = event.event;

    if (stream.type === "turn_started") {
      handleTurnStartedEvent(state, now);
    } else if (stream.type === "timeline") {
      handleTimelineEvent(mainAgentId, state, stream.item, now);
    } else if (stream.type === "turn_canceled") {
      handleTurnAbortedEvent(mainAgentId, state, "skipped", "后台轮次已取消", now);
    } else if (stream.type === "turn_failed") {
      handleTurnAbortedEvent(mainAgentId, state, "failed", stream.error, now);
    } else if (stream.type === "turn_completed") {
      handleTurnCompletedEvent(mainAgentId, state, now, stream.provider, stream.usage);
    }
  }

  function clearAgentState(mainAgentId: string): void {
    const state = stateByAgent.get(mainAgentId);
    if (!state) return;
    clearDrainTimer(state);
    state.activeTurn?.abortController?.abort();
    stateByAgent.delete(mainAgentId);
  }

  return {
    start() {
      stopped = false;
      if (deps.autoSubscribe === false) return;
      if (unsubscribe) return;
      unsubscribe = deps.agentManager.subscribe(handleAgentEvent);
    },

    stop() {
      stopped = true;
      unsubscribe?.();
      unsubscribe = null;
      for (const mainAgentId of Array.from(stateByAgent.keys())) {
        clearAgentState(mainAgentId);
      }
    },

    handleEvent: handleAgentEvent,

    async enqueueBackground(request) {
      const state = getOrCreateState(request.mainAgentId);
      const { item, createdNew } = insertQueuedItem(state, request);
      const nowIso = new Date(getNowMs()).toISOString();

      if (createdNew) {
        await persistNewActivity({
          id: item.activityId,
          mainAgentId: request.mainAgentId,
          kind: request.trigger === "idle_precompact" ? "compaction" : "background_turn",
          trigger: request.trigger,
          summary: request.summary,
          silent: request.trigger === "idle_precompact",
          status: "queued",
          createdAt: nowIso,
          completedAt: null,
        });
      } else {
        await persistUpdateActivity(item.activityId, {
          trigger: request.trigger,
          summary: request.summary,
          status: "queued",
        });
      }

      if (
        isForegroundBlocked(state) ||
        state.activeTurn !== null ||
        isAgentLiveRunning(request.mainAgentId)
      ) {
        return { status: "queued", activityId: item.activityId };
      }

      const drained = await drainNext(request.mainAgentId);
      return drained ?? { status: "queued", activityId: item.activityId };
    },

    beginForegroundDispatch(mainAgentId) {
      const state = getOrCreateState(mainAgentId);
      state.foregroundDispatchInFlight += 1;
      state.expectingForegroundTurnUntilMs = getNowMs() + FOREGROUND_CLAIM_WINDOW_MS;
      state.lastActivityAtMs = getNowMs();
      clearDrainTimer(state);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        state.foregroundDispatchInFlight = Math.max(0, state.foregroundDispatchInFlight - 1);
        if (state.foregroundDispatchInFlight === 0 && !state.activeTurn) {
          state.expectingForegroundTurnUntilMs = 0;
          scheduleDrain(mainAgentId);
        }
      };
    },

    abortForegroundDispatch(mainAgentId) {
      const state = stateByAgent.get(mainAgentId);
      if (!state) return;
      if (state.foregroundDispatchInFlight === 0 && !state.activeTurn) {
        state.expectingForegroundTurnUntilMs = 0;
        scheduleDrain(mainAgentId);
      }
    },

    async preemptForForegroundUser(mainAgentId) {
      const state = getOrCreateState(mainAgentId);
      const now = getNowMs();
      state.userPromptEpoch += 1;
      state.lastActivityAtMs = now;
      clearDrainTimer(state);

      const active = state.activeTurn;
      if (!active || active.kind !== "background") {
        // If an active foreground turn is being replaced/steered by a new user message,
        // reset its per-turn reply tracking for the new user prompt epoch.
        if (active?.kind === "foreground") {
          active.userPromptEpoch = state.userPromptEpoch;
          active.hadToolCalls = false;
          active.hadUserFacingCardTool = false;
          active.assistantTexts = [];
          active.isRecoveryTurn = false;
        }
        return { preempted: false };
      }

      // Hold a brief claim window while the preempted background turn cancels and the user's
      // foreground turn starts, preventing the re-queued item from racing ahead.
      state.expectingForegroundTurnUntilMs = now + FOREGROUND_CLAIM_WINDOW_MS;

      active.preemptedByUser = true;
      active.abortController?.abort();
      state.activeTurn = null;

      if (active.activityId) {
        await persistUpdateActivity(active.activityId, {
          kind: "preempted",
          status: "preempted",
          preemptedByUser: true,
          completedAt: new Date(now).toISOString(),
          summary: `${active.request?.summary ?? "后台轮次"}（已被用户消息抢占让路）`,
        });
      }
      await deps.store.incrementMetric("preemptedTurns").catch(() => undefined);

      if (typeof deps.agentManager.cancelAgentRun === "function") {
        try {
          await deps.agentManager.cancelAgentRun(mainAgentId);
        } catch (error) {
          deps.logger.debug(
            { err: error, mainAgentId },
            "Preemption cancelAgentRun returned error; continuing with foreground prompt",
          );
        }
      }

      if (active.request && active.request.requeueOnPreempt !== false) {
        const requeued = insertQueuedItem(state, {
          ...active.request,
          priority: Math.max(active.request.priority ?? 10, 15),
        });
        if (requeued.createdNew) {
          await persistNewActivity({
            id: requeued.item.activityId,
            mainAgentId,
            kind: active.request.trigger === "idle_precompact" ? "compaction" : "background_turn",
            trigger: active.request.trigger,
            summary: `${active.request.summary}（抢占后重新排队等待空闲投递）`,
            silent: active.request.trigger === "idle_precompact",
            status: "queued",
            createdAt: new Date(now).toISOString(),
            completedAt: null,
          });
        }
      }

      return { preempted: true };
    },

    isForegroundActive(mainAgentId) {
      const state = stateByAgent.get(mainAgentId);
      if (!state) return false;
      return isForegroundBlocked(state);
    },

    isBackgroundBusy(mainAgentId) {
      const state = stateByAgent.get(mainAgentId);
      if (!state) return false;
      return state.activeTurn?.kind === "background";
    },

    getQueuedCount(mainAgentId) {
      return stateByAgent.get(mainAgentId)?.queue.length ?? 0;
    },

    getIdleDurationMs(mainAgentId) {
      const state = stateByAgent.get(mainAgentId);
      if (!state) return 0;
      if (
        state.activeTurn !== null ||
        isForegroundBlocked(state) ||
        isAgentLiveRunning(mainAgentId)
      ) {
        return 0;
      }
      return Math.max(0, getNowMs() - Math.max(state.lastIdleAtMs, state.lastActivityAtMs));
    },

    getLastActivityAtMs(mainAgentId) {
      return stateByAgent.get(mainAgentId)?.lastActivityAtMs ?? 0;
    },

    clearAgentState,
  };
}
