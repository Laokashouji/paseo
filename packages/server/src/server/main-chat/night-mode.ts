import {
  isMainChatEnabled,
  resolveMainChatNightMode,
  type MainChatNightModeConfig,
  type MainChatNightModeStatus,
  type MainChatSettings,
} from "@getpaseo/protocol/main-chat";

/** Maximum timer sleep chunk while hibernating so system sleep/clock jumps wake promptly. */
const MAX_HIBERNATE_SLEEP_CHUNK_MS = 15 * 60 * 1000;
const MIN_TIMER_DELAY_MS = 50;

export interface EvaluateNightModeInput {
  settings: MainChatSettings;
  nowMs: number;
  hasActiveFleetWork: boolean;
  lastActivityAtMs: number;
  lastUserForegroundAtMs: number | null;
  /** Optional test override for base patrol interval in ms. */
  basePatrolIntervalMsOverride?: number;
}

export interface MainChatNightModeEvaluation {
  status: MainChatNightModeStatus;
  allowPatrol: boolean;
  allowSemanticTriage: boolean;
  allowProactiveWakeup: boolean;
  allowUrgentWakeup: boolean;
  allowIdlePrecompaction: boolean;
  /** Next timer delay in ms for the supervisor loop, or null when disabled. */
  nextTimerDelayMs: number | null;
}

export function formatLocalHourLabel(hour: number): string {
  const normalized = ((Math.trunc(hour) % 24) + 24) % 24;
  return `${String(normalized).padStart(2, "0")}:00`;
}

/**
 * Checks whether `nowMs` (in daemon local time) falls inside `[startHour, endHour)`.
 * Supports crossing midnight (e.g. `23 -> 8`), same-day windows (e.g. `1 -> 6`),
 * and `startHour === endHour` (treated as always active).
 */
export function isWithinNightWindow(nowMs: number, startHour: number, endHour: number): boolean {
  const start = ((Math.trunc(startHour) % 24) + 24) % 24;
  const end = ((Math.trunc(endHour) % 24) + 24) % 24;
  if (start === end) return true;
  const hour = new Date(nowMs).getHours();
  if (start < end) {
    return hour >= start && hour < end;
  }
  return hour >= start || hour < end;
}

/**
 * Computes the next local-clock hour boundary when the night window either begins or ends.
 * Returns `null` when `startHour === endHour` (24-hour window with no boundary).
 */
export function computeNextWindowTransitionMs(
  nowMs: number,
  startHour: number,
  endHour: number,
  inNightWindow: boolean,
): number | null {
  const start = ((Math.trunc(startHour) % 24) + 24) % 24;
  const end = ((Math.trunc(endHour) % 24) + 24) % 24;
  if (start === end) return null;

  const targetHour = inNightWindow ? end : start;
  const candidate = new Date(nowMs);
  candidate.setHours(targetHour, 0, 0, 0);
  if (candidate.getTime() <= nowMs) {
    candidate.setDate(candidate.getDate() + 1);
  }
  return candidate.getTime();
}

function formatIntervalLabel(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    return `${seconds / 60} 分钟`;
  }
  return `${seconds} 秒`;
}

function evaluateInNightWindow(params: {
  settings: MainChatSettings;
  night: MainChatNightModeConfig;
  nowMs: number;
  basePatrolIntervalMs: number;
  hasActiveFleetWork: boolean;
  lastActivityAtMs: number;
  lastUserForegroundAtMs: number | null;
  nextTransitionMs: number | null;
  nextTransitionAt: string | null;
}): MainChatNightModeEvaluation {
  const {
    settings,
    night,
    nowMs,
    basePatrolIntervalMs,
    hasActiveFleetWork,
    lastActivityAtMs,
    lastUserForegroundAtMs,
    nextTransitionMs,
    nextTransitionAt,
  } = params;

  const latestReferenceMs = Math.max(lastActivityAtMs, lastUserForegroundAtMs ?? 0);
  const idleMs = Math.max(0, nowMs - latestReferenceMs);
  const autoHibernateMs = night.autoHibernateAfterIdleMin * 60 * 1000;
  const shouldAutoHibernate =
    night.behavior === "throttle" &&
    night.autoHibernateAfterIdleMin > 0 &&
    !hasActiveFleetWork &&
    idleMs >= autoHibernateMs;

  if (night.behavior === "hibernate" || shouldAutoHibernate) {
    const msUntilWake =
      nextTransitionMs !== null
        ? Math.max(MIN_TIMER_DELAY_MS, nextTransitionMs - nowMs)
        : MAX_HIBERNATE_SLEEP_CHUNK_MS;
    const nextTimerDelayMs = Math.min(MAX_HIBERNATE_SLEEP_CHUNK_MS, msUntilWake);
    const wakeHint =
      nextTransitionMs !== null ? `，将于 ${formatLocalHourLabel(night.endHour)} 自动恢复` : "";
    const reason =
      night.behavior === "hibernate"
        ? `夜间休眠中（已暂停后台巡检与语义分诊${wakeHint}）`
        : `夜间连续闲置满 ${night.autoHibernateAfterIdleMin} 分钟，已自动转入休眠${wakeHint}`;
    return {
      status: {
        state: "hibernating",
        inNightWindow: true,
        effectivePatrolIntervalSec: 0,
        nextTransitionAt,
        reason,
      },
      allowPatrol: false,
      allowSemanticTriage: false,
      allowProactiveWakeup: false,
      allowUrgentWakeup: settings.capabilities.proactiveWakeupEnabled && night.allowUrgentWakeups,
      allowIdlePrecompaction: false,
      nextTimerDelayMs,
    };
  }

  const throttledIntervalMs = Math.max(basePatrolIntervalMs, night.patrolIntervalSec * 1000);
  let nextTimerDelayMs = throttledIntervalMs;
  if (nextTransitionMs !== null) {
    nextTimerDelayMs = Math.min(
      nextTimerDelayMs,
      Math.max(MIN_TIMER_DELAY_MS, nextTransitionMs - nowMs),
    );
  }
  if (!hasActiveFleetWork && autoHibernateMs > 0 && idleMs < autoHibernateMs) {
    nextTimerDelayMs = Math.min(
      nextTimerDelayMs,
      Math.max(MIN_TIMER_DELAY_MS, autoHibernateMs - idleMs),
    );
  }

  const effectiveIntervalSec = Math.round(throttledIntervalMs / 1000);
  const intervalLabel = formatIntervalLabel(effectiveIntervalSec);

  return {
    status: {
      state: "throttled",
      inNightWindow: true,
      effectivePatrolIntervalSec: effectiveIntervalSec,
      nextTransitionAt,
      reason: `夜间降频中（每 ${intervalLabel} 巡检一次${night.disableSemanticTriage ? "，已暂停语义分诊" : ""}）`,
    },
    allowPatrol: true,
    allowSemanticTriage:
      settings.capabilities.semanticTriageEnabled && !night.disableSemanticTriage,
    allowProactiveWakeup:
      settings.capabilities.proactiveWakeupEnabled && !night.deferProactiveWakeups,
    allowUrgentWakeup:
      settings.capabilities.proactiveWakeupEnabled &&
      (!night.deferProactiveWakeups || night.allowUrgentWakeups),
    allowIdlePrecompaction: true,
    nextTimerDelayMs,
  };
}

export function evaluateMainChatNightMode(
  input: EvaluateNightModeInput,
): MainChatNightModeEvaluation {
  const { settings, nowMs, hasActiveFleetWork, lastActivityAtMs, lastUserForegroundAtMs } = input;
  const basePatrolIntervalMs = Math.max(
    MIN_TIMER_DELAY_MS,
    input.basePatrolIntervalMsOverride ?? settings.intervals.patrolIntervalSec * 1000,
  );

  if (!isMainChatEnabled(settings)) {
    return {
      status: {
        state: "disabled",
        inNightWindow: false,
        effectivePatrolIntervalSec: 0,
        nextTransitionAt: null,
        reason: "主对话功能已在设置中关闭",
      },
      allowPatrol: false,
      allowSemanticTriage: false,
      allowProactiveWakeup: false,
      allowUrgentWakeup: false,
      allowIdlePrecompaction: false,
      nextTimerDelayMs: null,
    };
  }

  const night = resolveMainChatNightMode(settings);
  if (!night.enabled) {
    return {
      status: {
        state: "active",
        inNightWindow: false,
        effectivePatrolIntervalSec: Math.round(basePatrolIntervalMs / 1000),
        nextTransitionAt: null,
        reason: null,
      },
      allowPatrol: true,
      allowSemanticTriage: settings.capabilities.semanticTriageEnabled,
      allowProactiveWakeup: settings.capabilities.proactiveWakeupEnabled,
      allowUrgentWakeup: settings.capabilities.proactiveWakeupEnabled,
      allowIdlePrecompaction: true,
      nextTimerDelayMs: basePatrolIntervalMs,
    };
  }

  const inNightWindow = isWithinNightWindow(nowMs, night.startHour, night.endHour);
  const nextTransitionMs = computeNextWindowTransitionMs(
    nowMs,
    night.startHour,
    night.endHour,
    inNightWindow,
  );
  const nextTransitionAt =
    nextTransitionMs !== null ? new Date(nextTransitionMs).toISOString() : null;

  if (!inNightWindow) {
    const msUntilNight =
      nextTransitionMs !== null ? Math.max(MIN_TIMER_DELAY_MS, nextTransitionMs - nowMs) : null;
    const nextTimerDelayMs =
      msUntilNight !== null ? Math.min(basePatrolIntervalMs, msUntilNight) : basePatrolIntervalMs;
    return {
      status: {
        state: "active",
        inNightWindow: false,
        effectivePatrolIntervalSec: Math.round(basePatrolIntervalMs / 1000),
        nextTransitionAt,
        reason: `将于 ${formatLocalHourLabel(night.startHour)} 进入夜间节能`,
      },
      allowPatrol: true,
      allowSemanticTriage: settings.capabilities.semanticTriageEnabled,
      allowProactiveWakeup: settings.capabilities.proactiveWakeupEnabled,
      allowUrgentWakeup: settings.capabilities.proactiveWakeupEnabled,
      allowIdlePrecompaction: true,
      nextTimerDelayMs,
    };
  }

  return evaluateInNightWindow({
    settings,
    night,
    nowMs,
    basePatrolIntervalMs,
    hasActiveFleetWork,
    lastActivityAtMs,
    lastUserForegroundAtMs,
    nextTransitionMs,
    nextTransitionAt,
  });
}
