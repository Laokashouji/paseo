import crypto from "node:crypto";
import type {
  MainChatSupervisionSignal,
  MainChatSupervisionSignalKind,
  MainChatSupervisionUrgency,
  MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";

export const SUPERVISE_GATHER_MS = 15_000;
export const SUPERVISE_NORMAL_COOLDOWN_MS = 10 * 60_000;
export const SUPERVISE_URGENT_COOLDOWN_MS = 2 * 60_000;
export const ALL_STOPPED_THRESHOLD_MS = 30 * 60_000;

const MAIN_CONVERSATION_BUCKET_KEY = "__main__";

export const ALL_SUPERVISION_SIGNAL_KINDS: readonly MainChatSupervisionSignalKind[] = [
  "review",
  "parent_closeout",
  "pr_merged",
  "report",
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
  "pr_conflict",
  "draft_pr",
  "pr_event",
  "todo_ready",
  "decision_reply",
  "check",
  "escalated",
  "decide",
  "leader_stuck",
  "usage_limit_wake",
  "transient_retry",
];

export interface SupervisionSignalKindMeta {
  kind: MainChatSupervisionSignalKind;
  label: string;
  defaultUrgency: MainChatSupervisionUrgency;
  quietSuppressible: boolean;
}

export const SUPERVISION_SIGNAL_META: Record<
  MainChatSupervisionSignalKind,
  SupervisionSignalKindMeta
> = {
  review: { kind: "review", label: "待验收", defaultUrgency: "normal", quietSuppressible: true },
  parent_closeout: {
    kind: "parent_closeout",
    label: "子任务全部完工",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
  pr_merged: {
    kind: "pr_merged",
    label: "PR 已合并",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
  report: { kind: "report", label: "进度上报", defaultUrgency: "normal", quietSuppressible: true },
  idle: { kind: "idle", label: "停止未完工", defaultUrgency: "normal", quietSuppressible: true },
  unjudged: {
    kind: "unjudged",
    label: "结果待判别",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
  needs_you: {
    kind: "needs_you",
    label: "需要你拍板",
    defaultUrgency: "urgent",
    quietSuppressible: false,
  },
  ask: { kind: "ask", label: "拦截提问/审批", defaultUrgency: "urgent", quietSuppressible: true },
  stalled: {
    kind: "stalled",
    label: "运行停滞",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
  no_progress: {
    kind: "no_progress",
    label: "疑似空转",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
  all_stopped: {
    kind: "all_stopped",
    label: "全员停滞超30分钟",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
  timed_out: {
    kind: "timed_out",
    label: "执行超时",
    defaultUrgency: "urgent",
    quietSuppressible: true,
  },
  interrupted: {
    kind: "interrupted",
    label: "异常中断",
    defaultUrgency: "urgent",
    quietSuppressible: true,
  },
  failed: {
    kind: "failed",
    label: "启动失败",
    defaultUrgency: "immediate",
    quietSuppressible: false,
  },
  orphaned: {
    kind: "orphaned",
    label: "关联会话离线",
    defaultUrgency: "urgent",
    quietSuppressible: false,
  },
  pr_conflict: {
    kind: "pr_conflict",
    label: "PR 合并冲突",
    defaultUrgency: "urgent",
    quietSuppressible: true,
  },
  draft_pr: {
    kind: "draft_pr",
    label: "PR 仍为草稿",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
  pr_event: {
    kind: "pr_event",
    label: "PR 动态更新",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
  todo_ready: {
    kind: "todo_ready",
    label: "前置依赖就绪",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
  decision_reply: {
    kind: "decision_reply",
    label: "决策已回复",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
  check: { kind: "check", label: "周期检查", defaultUrgency: "normal", quietSuppressible: true },
  escalated: {
    kind: "escalated",
    label: "主管升级汇报",
    defaultUrgency: "urgent",
    quietSuppressible: false,
  },
  decide: {
    kind: "decide",
    label: "待拍板事项",
    defaultUrgency: "urgent",
    quietSuppressible: false,
  },
  leader_stuck: {
    kind: "leader_stuck",
    label: "方向主管停滞",
    defaultUrgency: "urgent",
    quietSuppressible: false,
  },
  usage_limit_wake: {
    kind: "usage_limit_wake",
    label: "限额重置唤醒",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
  transient_retry: {
    kind: "transient_retry",
    label: "瞬时异常续跑",
    defaultUrgency: "normal",
    quietSuppressible: true,
  },
};

export function getSupervisionSignalMeta(
  kind: MainChatSupervisionSignalKind,
): SupervisionSignalKindMeta {
  return SUPERVISION_SIGNAL_META[kind];
}

export function isSignalQuietSuppressible(
  kind: MainChatSupervisionSignalKind,
  options?: { isRedLine?: boolean; escalatedToUser?: boolean },
): boolean {
  if (options?.isRedLine || options?.escalatedToUser) {
    return false;
  }
  return SUPERVISION_SIGNAL_META[kind].quietSuppressible;
}

export function formatSupervisionDigest(
  signals: readonly MainChatSupervisionSignal[],
  options?: { conversationLabel?: string | null },
): string {
  const headerTarget = options?.conversationLabel?.trim()
    ? `（${options.conversationLabel.trim()}）`
    : "";
  const header = `📋 督办${headerTarget}：汇总 ${signals.length} 条最新有效动态`;
  if (signals.length === 0) {
    return `${header}\n（无待处理信号）`;
  }
  const lines = signals.map((signal, index) => {
    const meta = SUPERVISION_SIGNAL_META[signal.kind];
    let urgencyTag = "";
    if (signal.urgency === "immediate") {
      urgencyTag = "[立即]";
    } else if (signal.urgency === "urgent") {
      urgencyTag = "[紧急]";
    }
    const refs: string[] = [];
    if (signal.taskId) refs.push(`task=${signal.taskId}`);
    if (signal.agentId) refs.push(`agent=${signal.agentId}`);
    if (signal.serverId) refs.push(`host=${signal.serverId}`);
    const refText = refs.length > 0 ? `（${refs.join(" · ")}）` : "";
    return `${index + 1}. ${urgencyTag}[${signal.kind}·${meta.label}]「${signal.title}」${refText}：${signal.summary}`;
  });
  return [header, ...lines].join("\n");
}

// ============================================================================
// 30-Minute All-Stopped Task Detection
// ============================================================================

export interface AllStoppedTaskCandidate {
  task: MainChatTaskRecord;
  stoppedMinutes: number;
  latestActivityMs: number;
  agentIds: string[];
}

export interface DetectAllStoppedTasksInput {
  tasks: readonly MainChatTaskRecord[];
  getLiveAgentState: (agentId: string) => { lifecycle: string; updatedAtMs: number } | null;
  hasPendingRetry?: (agentId: string) => boolean;
  nowMs: number;
  thresholdMs?: number;
}

function collectTaskAgentIds(task: MainChatTaskRecord): string[] {
  const ids = new Set<string>();
  for (const id of task.agentIds) {
    if (id.trim()) ids.add(id.trim());
  }
  if (task.activeAgentId?.trim()) {
    ids.add(task.activeAgentId.trim());
  }
  return Array.from(ids);
}

function isTaskCandidateForAllStopped(task: MainChatTaskRecord): boolean {
  return task.status !== "completed" && task.status !== "cancelled" && task.status !== "parked";
}

/**
 * Finds active tasks where every linked child agent is stopped/idle (none running and none
 * waiting on a scheduled retry timer) for at least `thresholdMs` (default 30 minutes).
 */
export function detectAllStoppedTasks(
  input: DetectAllStoppedTasksInput,
): AllStoppedTaskCandidate[] {
  const thresholdMs = input.thresholdMs ?? ALL_STOPPED_THRESHOLD_MS;
  const results: AllStoppedTaskCandidate[] = [];

  for (const task of input.tasks) {
    if (!isTaskCandidateForAllStopped(task)) continue;
    const agentIds = collectTaskAgentIds(task);
    if (agentIds.length === 0) continue;

    let anyRunningOrScheduled = false;
    let latestActivityMs = Date.parse(task.lastActivityAt);
    if (!Number.isFinite(latestActivityMs)) {
      latestActivityMs = Date.parse(task.updatedAt);
    }

    for (const agentId of agentIds) {
      if (input.hasPendingRetry?.(agentId)) {
        anyRunningOrScheduled = true;
        break;
      }
      const live = input.getLiveAgentState(agentId);
      if (!live) continue;
      if (live.lifecycle === "running") {
        anyRunningOrScheduled = true;
        break;
      }
      if (Number.isFinite(live.updatedAtMs) && live.updatedAtMs > latestActivityMs) {
        latestActivityMs = live.updatedAtMs;
      }
    }

    if (anyRunningOrScheduled || !Number.isFinite(latestActivityMs)) continue;
    const elapsedMs = input.nowMs - latestActivityMs;
    if (elapsedMs >= thresholdMs) {
      results.push({
        task,
        stoppedMinutes: Math.max(1, Math.round(elapsedMs / 60_000)),
        latestActivityMs,
        agentIds,
      });
    }
  }

  return results;
}

// ============================================================================
// Structured Supervision Signal Queue
// ============================================================================

export interface EnqueueSupervisionSignalInput {
  id?: string;
  kind: MainChatSupervisionSignalKind;
  urgency?: MainChatSupervisionUrgency;
  taskId?: string | null;
  agentId?: string | null;
  serverId?: string | null;
  conversationId?: string | null;
  title: string;
  summary: string;
  createdAt?: string;
  dedupeKey?: string;
  fingerprintSeed?: string;
  allowDuplicate?: boolean;
}

export type SignalRevalidationOutcome = boolean | { valid: boolean; reason?: string };

export interface DeliverSupervisionBatchPayload {
  conversationId: string | null;
  signals: MainChatSupervisionSignal[];
  digest: string;
  hasUrgent: boolean;
  hasImmediate: boolean;
  droppedStaleCount: number;
}

export interface SupervisionSignalQueueDependencies {
  revalidateSignal: (
    signal: MainChatSupervisionSignal,
  ) => Promise<SignalRevalidationOutcome> | SignalRevalidationOutcome;
  onDeliver: (batch: DeliverSupervisionBatchPayload) => Promise<boolean> | boolean;
  getGatherMs?: () => number;
  getNormalCooldownMs?: () => number;
  getUrgentCooldownMs?: () => number;
  now?: () => number;
  autoScheduleTimers?: boolean;
}

export interface DroppedSupervisionSignal {
  signal: MainChatSupervisionSignal;
  reason: string | null;
}

export interface FlushBucketResult {
  conversationId: string | null;
  delivered: boolean;
  skippedAllStale: boolean;
  deferredUntilMs: number | null;
  deliveredSignals: MainChatSupervisionSignal[];
  droppedSignals: DroppedSupervisionSignal[];
  digest: string | null;
}

export interface EnqueueSupervisionSignalResult {
  queued: boolean;
  signal: MainChatSupervisionSignal | null;
  immediateFlushPromise?: Promise<FlushBucketResult>;
}

export interface SupervisionSignalQueue {
  enqueue(input: EnqueueSupervisionSignalInput): EnqueueSupervisionSignalResult;
  flushBucket(
    conversationId: string | null,
    options?: { force?: boolean; skipGather?: boolean },
  ): Promise<FlushBucketResult>;
  flushAll(options?: { force?: boolean }): Promise<FlushBucketResult[]>;
  listPending(conversationId?: string | null): MainChatSupervisionSignal[];
  getPendingCount(conversationId?: string | null): number;
  getBucketLastDeliveredAtMs(conversationId: string | null): number;
  removeByAgentId(agentId: string): number;
  removeByTaskId(taskId: string): number;
  clearBucket(conversationId: string | null): void;
  start(): void;
  stop(): void;
}

interface PendingEntry {
  key: string;
  fingerprint: string;
  signal: MainChatSupervisionSignal;
}

interface ConversationBucket {
  conversationId: string | null;
  pending: Map<string, PendingEntry>;
  lastDeliveredFingerprintByKey: Map<string, string>;
  gatherOpenedAtMs: number | null;
  lastDeliveredAtMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  flushing: boolean;
}

function normalizeConversationId(conversationId: string | null | undefined): string | null {
  const trimmed = conversationId?.trim();
  return trimmed ? trimmed : null;
}

function toBucketKey(conversationId: string | null | undefined): string {
  return normalizeConversationId(conversationId) ?? MAIN_CONVERSATION_BUCKET_KEY;
}

function makeSignalId(): string {
  return `sig_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function resolveDefaultDedupeKey(input: EnqueueSupervisionSignalInput): string {
  if (input.dedupeKey?.trim()) return input.dedupeKey.trim();
  const anchor = input.agentId?.trim() || input.taskId?.trim() || "global";
  return `${anchor}:${input.kind}`;
}

function interpretRevalidationOutcome(outcome: SignalRevalidationOutcome): {
  valid: boolean;
  reason: string | null;
} {
  if (typeof outcome === "boolean") {
    return { valid: outcome, reason: outcome ? null : "stale" };
  }
  return { valid: outcome.valid, reason: outcome.reason ?? null };
}

function urgencyRank(urgency: MainChatSupervisionUrgency): number {
  if (urgency === "immediate") return 3;
  if (urgency === "urgent") return 2;
  return 1;
}

function sortSignalsForDigest(entries: readonly PendingEntry[]): PendingEntry[] {
  return [...entries].sort((left, right) => {
    const rankDiff = urgencyRank(right.signal.urgency) - urgencyRank(left.signal.urgency);
    if (rankDiff !== 0) return rankDiff;
    return left.signal.createdAt.localeCompare(right.signal.createdAt);
  });
}

export function createSupervisionSignalQueue(
  deps: SupervisionSignalQueueDependencies,
): SupervisionSignalQueue {
  const getNowMs = deps.now ?? (() => Date.now());
  const getGatherMs = deps.getGatherMs ?? (() => SUPERVISE_GATHER_MS);
  const getNormalCooldownMs = deps.getNormalCooldownMs ?? (() => SUPERVISE_NORMAL_COOLDOWN_MS);
  const getUrgentCooldownMs = deps.getUrgentCooldownMs ?? (() => SUPERVISE_URGENT_COOLDOWN_MS);
  const autoScheduleTimers = deps.autoScheduleTimers ?? true;
  const buckets = new Map<string, ConversationBucket>();
  let stopped = false;

  function getOrCreateBucket(conversationId: string | null): ConversationBucket {
    const bucketKey = toBucketKey(conversationId);
    const existing = buckets.get(bucketKey);
    if (existing) return existing;
    const created: ConversationBucket = {
      conversationId,
      pending: new Map(),
      lastDeliveredFingerprintByKey: new Map(),
      gatherOpenedAtMs: null,
      lastDeliveredAtMs: 0,
      timer: null,
      flushing: false,
    };
    buckets.set(bucketKey, created);
    return created;
  }

  function clearBucketTimer(bucket: ConversationBucket): void {
    if (bucket.timer) {
      clearTimeout(bucket.timer);
      bucket.timer = null;
    }
  }

  function computeNextEligibleAtMs(
    bucket: ConversationBucket,
    nowMs: number,
    skipGather = false,
  ): number {
    let hasImmediate = false;
    let hasUrgent = false;
    for (const entry of bucket.pending.values()) {
      if (entry.signal.urgency === "immediate") hasImmediate = true;
      if (entry.signal.urgency === "urgent") hasUrgent = true;
    }
    if (hasImmediate) return nowMs;

    const gatherMs = Math.max(0, getGatherMs());
    const gatherReadyAt =
      !skipGather && bucket.gatherOpenedAtMs !== null ? bucket.gatherOpenedAtMs + gatherMs : nowMs;
    const cooldownMs = Math.max(0, hasUrgent ? getUrgentCooldownMs() : getNormalCooldownMs());
    const cooldownReadyAt =
      bucket.lastDeliveredAtMs > 0 ? bucket.lastDeliveredAtMs + cooldownMs : 0;

    return Math.max(gatherReadyAt, cooldownReadyAt);
  }

  function armBucketTimer(bucket: ConversationBucket): void {
    clearBucketTimer(bucket);
    if (stopped || !autoScheduleTimers || bucket.pending.size === 0) return;

    const nowMs = getNowMs();
    const readyAtMs = computeNextEligibleAtMs(bucket, nowMs);
    const delayMs = Math.max(0, readyAtMs - nowMs);
    bucket.timer = setTimeout(() => {
      bucket.timer = null;
      void flushBucketInternal(bucket, { force: false });
    }, delayMs);
    bucket.timer.unref?.();
  }

  async function revalidateBucketEntries(
    bucket: ConversationBucket,
    snapshot: readonly PendingEntry[],
  ): Promise<{
    validEntries: PendingEntry[];
    droppedSignals: DroppedSupervisionSignal[];
  }> {
    const validEntries: PendingEntry[] = [];
    const droppedSignals: DroppedSupervisionSignal[] = [];

    for (const entry of snapshot) {
      const outcome = interpretRevalidationOutcome(await deps.revalidateSignal(entry.signal));
      if (outcome.valid) {
        validEntries.push(entry);
      } else {
        droppedSignals.push({ signal: entry.signal, reason: outcome.reason });
        const current = bucket.pending.get(entry.key);
        if (current && current.fingerprint === entry.fingerprint) {
          bucket.pending.delete(entry.key);
        }
      }
    }
    return { validEntries, droppedSignals };
  }

  async function flushBucketInternal(
    bucket: ConversationBucket,
    options?: { force?: boolean; skipGather?: boolean },
  ): Promise<FlushBucketResult> {
    if (stopped || bucket.flushing || bucket.pending.size === 0) {
      return {
        conversationId: bucket.conversationId,
        delivered: false,
        skippedAllStale: false,
        deferredUntilMs: null,
        deliveredSignals: [],
        droppedSignals: [],
        digest: null,
      };
    }

    const nowMs = getNowMs();
    const readyAtMs = computeNextEligibleAtMs(bucket, nowMs, options?.skipGather === true);
    if (options?.force !== true && readyAtMs > nowMs) {
      armBucketTimer(bucket);
      return {
        conversationId: bucket.conversationId,
        delivered: false,
        skippedAllStale: false,
        deferredUntilMs: readyAtMs,
        deliveredSignals: [],
        droppedSignals: [],
        digest: null,
      };
    }

    clearBucketTimer(bucket);
    bucket.flushing = true;
    try {
      const snapshot = sortSignalsForDigest(Array.from(bucket.pending.values()));
      const { validEntries, droppedSignals } = await revalidateBucketEntries(bucket, snapshot);

      if (validEntries.length === 0) {
        if (bucket.pending.size === 0) {
          bucket.gatherOpenedAtMs = null;
        } else {
          armBucketTimer(bucket);
        }
        return {
          conversationId: bucket.conversationId,
          delivered: false,
          skippedAllStale: droppedSignals.length > 0,
          deferredUntilMs: null,
          deliveredSignals: [],
          droppedSignals,
          digest: null,
        };
      }

      const deliveredSignals = validEntries.map((entry) => entry.signal);
      const hasUrgent = deliveredSignals.some(
        (signal) => signal.urgency === "urgent" || signal.urgency === "immediate",
      );
      const hasImmediate = deliveredSignals.some((signal) => signal.urgency === "immediate");
      const digest = formatSupervisionDigest(deliveredSignals);

      const accepted = await deps.onDeliver({
        conversationId: bucket.conversationId,
        signals: deliveredSignals,
        digest,
        hasUrgent,
        hasImmediate,
        droppedStaleCount: droppedSignals.length,
      });

      if (accepted) {
        bucket.lastDeliveredAtMs = getNowMs();
        for (const entry of validEntries) {
          bucket.lastDeliveredFingerprintByKey.set(entry.key, entry.fingerprint);
          const current = bucket.pending.get(entry.key);
          if (current && current.fingerprint === entry.fingerprint) {
            bucket.pending.delete(entry.key);
          }
        }
        bucket.gatherOpenedAtMs = bucket.pending.size > 0 ? getNowMs() : null;
      }

      if (bucket.pending.size > 0) {
        armBucketTimer(bucket);
      }

      return {
        conversationId: bucket.conversationId,
        delivered: accepted,
        skippedAllStale: false,
        deferredUntilMs: null,
        deliveredSignals: accepted ? deliveredSignals : [],
        droppedSignals,
        digest: accepted ? digest : null,
      };
    } finally {
      bucket.flushing = false;
    }
  }

  return {
    enqueue(input) {
      if (stopped) {
        return { queued: false, signal: null };
      }
      const conversationId = normalizeConversationId(input.conversationId);
      const bucket = getOrCreateBucket(conversationId);
      const key = resolveDefaultDedupeKey(input);
      const fingerprintSeed = input.fingerprintSeed?.trim() || input.summary.trim().slice(0, 80);
      const fingerprint = `${key}:${fingerprintSeed}`;

      if (!input.allowDuplicate && bucket.lastDeliveredFingerprintByKey.get(key) === fingerprint) {
        return { queued: false, signal: null };
      }

      const nowMs = getNowMs();
      const meta = SUPERVISION_SIGNAL_META[input.kind];
      const signal: MainChatSupervisionSignal = {
        id: input.id?.trim() || makeSignalId(),
        kind: input.kind,
        urgency: input.urgency ?? meta.defaultUrgency,
        taskId: normalizeConversationId(input.taskId),
        agentId: normalizeConversationId(input.agentId),
        serverId: normalizeConversationId(input.serverId),
        conversationId,
        title: input.title.trim() || input.agentId || input.taskId || meta.label,
        summary: input.summary.trim() || meta.label,
        createdAt: input.createdAt ?? new Date(nowMs).toISOString(),
      };

      bucket.pending.set(key, { key, fingerprint, signal });
      if (bucket.gatherOpenedAtMs === null) {
        bucket.gatherOpenedAtMs = nowMs;
      }

      if (signal.urgency === "immediate") {
        clearBucketTimer(bucket);
        const immediateFlushPromise = flushBucketInternal(bucket, { force: true });
        return { queued: true, signal, immediateFlushPromise };
      }

      armBucketTimer(bucket);
      return { queued: true, signal };
    },

    async flushBucket(conversationId, options) {
      const bucket = buckets.get(toBucketKey(conversationId));
      if (!bucket) {
        return {
          conversationId: normalizeConversationId(conversationId),
          delivered: false,
          skippedAllStale: false,
          deferredUntilMs: null,
          deliveredSignals: [],
          droppedSignals: [],
          digest: null,
        };
      }
      return flushBucketInternal(bucket, options);
    },

    async flushAll(options) {
      const results: FlushBucketResult[] = [];
      for (const bucket of buckets.values()) {
        if (bucket.pending.size === 0) continue;
        results.push(await flushBucketInternal(bucket, options));
      }
      return results;
    },

    listPending(conversationId) {
      if (conversationId !== undefined) {
        const bucket = buckets.get(toBucketKey(conversationId));
        if (!bucket) return [];
        return sortSignalsForDigest(Array.from(bucket.pending.values())).map(
          (entry) => entry.signal,
        );
      }
      const all: PendingEntry[] = [];
      for (const bucket of buckets.values()) {
        all.push(...bucket.pending.values());
      }
      return sortSignalsForDigest(all).map((entry) => entry.signal);
    },

    getPendingCount(conversationId) {
      if (conversationId !== undefined) {
        return buckets.get(toBucketKey(conversationId))?.pending.size ?? 0;
      }
      let total = 0;
      for (const bucket of buckets.values()) {
        total += bucket.pending.size;
      }
      return total;
    },

    getBucketLastDeliveredAtMs(conversationId) {
      return buckets.get(toBucketKey(conversationId))?.lastDeliveredAtMs ?? 0;
    },

    removeByAgentId(agentId) {
      let removed = 0;
      for (const bucket of buckets.values()) {
        for (const [key, entry] of bucket.pending) {
          if (entry.signal.agentId === agentId) {
            bucket.pending.delete(key);
            removed += 1;
          }
        }
        if (bucket.pending.size === 0) {
          clearBucketTimer(bucket);
          bucket.gatherOpenedAtMs = null;
        }
      }
      return removed;
    },

    removeByTaskId(taskId) {
      let removed = 0;
      for (const bucket of buckets.values()) {
        for (const [key, entry] of bucket.pending) {
          if (entry.signal.taskId === taskId) {
            bucket.pending.delete(key);
            removed += 1;
          }
        }
        if (bucket.pending.size === 0) {
          clearBucketTimer(bucket);
          bucket.gatherOpenedAtMs = null;
        }
      }
      return removed;
    },

    clearBucket(conversationId) {
      const bucket = buckets.get(toBucketKey(conversationId));
      if (!bucket) return;
      clearBucketTimer(bucket);
      bucket.pending.clear();
      bucket.gatherOpenedAtMs = null;
    },

    start() {
      if (!stopped) return;
      stopped = false;
      for (const bucket of buckets.values()) {
        if (bucket.pending.size > 0) {
          armBucketTimer(bucket);
        }
      }
    },

    stop() {
      stopped = true;
      for (const bucket of buckets.values()) {
        clearBucketTimer(bucket);
      }
    },
  };
}
