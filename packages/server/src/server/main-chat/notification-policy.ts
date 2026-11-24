import {
  isCriticalPassthroughNotificationCategory,
  resolveMainChatNotificationPolicy,
  type MainChatNotificationCategory,
  type MainChatNotificationChannel,
  type MainChatNotificationDeliveryStatus,
  type MainChatNotificationPolicy,
  type MainChatNotificationReceipt,
  type MainChatNotificationSummary,
  type MainChatNotificationTier,
  type MainChatSettings,
  type MainChatSupervisionSignalKind,
} from "@getpaseo/protocol/main-chat";
import type { MainChatNightModeEvaluation } from "./night-mode.js";

const DEFAULT_CATEGORY_TIERS: Record<MainChatNotificationCategory, MainChatNotificationTier> = {
  permission_approval: "critical",
  decision_required: "critical",
  task_failed: "critical",
  delivery_gate_blocked: "critical",
  task_review: "actionable",
  rule_diagnostic: "actionable",
  task_progress: "digest",
  patrol_summary: "digest",
};

export interface ClassifyNotificationCategoryInput {
  signalKind: MainChatSupervisionSignalKind;
  fingerprintSeed?: string | null;
  isRedLine?: boolean;
  escalatedToUser?: boolean;
  isDeliveryGateBlocked?: boolean;
}

export interface EvaluateNotificationDispatchInput extends ClassifyNotificationCategoryInput {
  settings: MainChatSettings;
  nightModeEval?: MainChatNightModeEvaluation | null;
  quietTask?: boolean;
}

export interface NotificationDispatchDecision {
  category: MainChatNotificationCategory;
  tier: MainChatNotificationTier;
  status: Extract<
    MainChatNotificationDeliveryStatus,
    "queued" | "suppressed_quiet" | "suppressed_night"
  >;
  channel: MainChatNotificationChannel;
  deliverNow: boolean;
  passthrough: boolean;
  reason: string | null;
}

const SIGNAL_KIND_CATEGORY_MAP: Partial<
  Record<MainChatSupervisionSignalKind, MainChatNotificationCategory>
> = {
  ask: "permission_approval",
  decide: "decision_required",
  escalated: "decision_required",
  failed: "task_failed",
  orphaned: "task_failed",
  leader_stuck: "task_failed",
  pr_conflict: "delivery_gate_blocked",
  draft_pr: "delivery_gate_blocked",
  review: "task_review",
  parent_closeout: "task_review",
  pr_merged: "task_review",
  decision_reply: "task_review",
  stalled: "rule_diagnostic",
  no_progress: "rule_diagnostic",
  timed_out: "rule_diagnostic",
  interrupted: "rule_diagnostic",
  unjudged: "rule_diagnostic",
  idle: "rule_diagnostic",
  all_stopped: "patrol_summary",
  check: "patrol_summary",
};

/**
 * Maps a supervision signal + risk metadata into a user-facing notification category.
 */
export function classifySupervisionNotificationCategory(
  input: ClassifyNotificationCategoryInput,
): MainChatNotificationCategory {
  if (input.isDeliveryGateBlocked) {
    return "delivery_gate_blocked";
  }
  if (input.signalKind === "needs_you") {
    if (
      input.fingerprintSeed?.startsWith("perm:") ||
      input.fingerprintSeed?.startsWith("escalate:")
    ) {
      return "permission_approval";
    }
    return "decision_required";
  }
  const mapped = SIGNAL_KIND_CATEGORY_MAP[input.signalKind];
  if (mapped) {
    return mapped;
  }
  return input.isRedLine ? "decision_required" : "task_progress";
}

export function resolveEffectiveNotificationTier(
  category: MainChatNotificationCategory,
  policy: MainChatNotificationPolicy,
  options?: { isRedLine?: boolean; escalatedToUser?: boolean },
): { tier: MainChatNotificationTier; mandatoryPassthrough: boolean } {
  const mandatoryPassthrough =
    isCriticalPassthroughNotificationCategory(category) ||
    Boolean(options?.isRedLine) ||
    Boolean(options?.escalatedToUser);

  if (mandatoryPassthrough) {
    return { tier: "critical", mandatoryPassthrough: true };
  }

  const override = policy.categoryOverrides?.[category];
  if (override) {
    return { tier: override, mandatoryPassthrough: false };
  }

  const fallback = DEFAULT_CATEGORY_TIERS[category];
  if (policy.mode === "all" && fallback === "digest") {
    return { tier: "actionable", mandatoryPassthrough: false };
  }
  return { tier: fallback, mandatoryPassthrough: false };
}

/**
 * Evaluates how a supervision notification should be dispatched under the current
 * notification tiering policy, low-distraction mode, and night mode.
 *
 * Guarantees:
 * - Critical passthrough categories (`permission_approval`, `decision_required`, `task_failed`,
 *   `delivery_gate_blocked`) ALWAYS penetrate low-distraction mode (`passthrough: true`).
 * - Low-priority signals under low-distraction or night-mode deferrals are cleanly folded
 *   (`suppressed_quiet` / `suppressed_night`) with an explicit reason for the delivery receipt ledger.
 */
export function evaluateNotificationDispatch(
  input: EvaluateNotificationDispatchInput,
): NotificationDispatchDecision {
  const policy = resolveMainChatNotificationPolicy(input.settings);
  const category = classifySupervisionNotificationCategory(input);
  const { tier, mandatoryPassthrough } = resolveEffectiveNotificationTier(category, policy, {
    isRedLine: input.isRedLine,
    escalatedToUser: input.escalatedToUser,
  });

  // 1. Night-mode check: only suppress non-passthrough signals, OR suppress urgent signals when
  // night mode explicitly hibernates/defers urgent wakeups AND the category is not a mandatory
  // passthrough under active night allowance.
  const nightEval = input.nightModeEval;
  if (nightEval && nightEval.status.inNightWindow) {
    const isCritical = tier === "critical";
    const allowedInNight = isCritical
      ? nightEval.allowUrgentWakeup || mandatoryPassthrough
      : nightEval.allowProactiveWakeup;
    if (!allowedInNight) {
      return {
        category,
        tier,
        status: "suppressed_night",
        channel: "digest",
        deliverNow: false,
        passthrough: false,
        reason: nightEval.status.reason ?? "夜间节能模式已静默折叠该通知",
      };
    }
  }

  // 2. Mandatory critical passthrough ALWAYS penetrates low-distraction mode.
  if (mandatoryPassthrough || tier === "critical") {
    let reason: string | null = null;
    if (mandatoryPassthrough) {
      reason = policy.lowDistractionEnabled
        ? "关键审批/拍板/故障/门禁阻断，已穿透低打扰模式"
        : "关键事件直达提醒";
    }
    return {
      category,
      tier: "critical",
      status: "queued",
      channel: input.escalatedToUser ? "push" : "main_chat",
      deliverNow: true,
      passthrough: mandatoryPassthrough,
      reason,
    };
  }

  // 3. Explicit silent tier never interrupts.
  if (tier === "silent") {
    return {
      category,
      tier,
      status: "suppressed_quiet",
      channel: "badge",
      deliverNow: false,
      passthrough: false,
      reason: "该类别已设为静默，仅记录送达回执不主动打断",
    };
  }

  // 4. Low-distraction mode folds digest (and actionable when foldLowPriorityToDigest is on).
  if (policy.lowDistractionEnabled) {
    if (tier === "digest" || policy.foldLowPriorityToDigest) {
      return {
        category,
        tier,
        status: "suppressed_quiet",
        channel: "digest",
        deliverNow: false,
        passthrough: false,
        reason: "低打扰模式已折叠低优先级通知至汇总台账",
      };
    }
  } else if (tier === "digest" && policy.foldLowPriorityToDigest) {
    return {
      category,
      tier,
      status: "suppressed_quiet",
      channel: "digest",
      deliverNow: false,
      passthrough: false,
      reason: "摘要级通知已折叠至汇总，未主动打断主对话",
    };
  }

  return {
    category,
    tier,
    status: "queued",
    channel: input.quietTask ? "main_chat" : "main_chat",
    deliverNow: true,
    passthrough: false,
    reason: null,
  };
}

export function createNotificationReceiptId(): string {
  return `nrec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function computeMainChatNotificationSummary(
  receipts: readonly MainChatNotificationReceipt[],
  settings: Pick<MainChatSettings, "notificationPolicy"> | null | undefined,
): MainChatNotificationSummary {
  const policy = resolveMainChatNotificationPolicy(settings);
  let unreadCount = 0;
  let deliveredCount = 0;
  let suppressedQuietCount = 0;
  let suppressedNightCount = 0;
  let foldedDigestCount = 0;
  let criticalPassthroughCount = 0;
  let latestReceiptAt: string | null = null;

  for (const receipt of receipts) {
    if (!latestReceiptAt || receipt.updatedAt > latestReceiptAt) {
      latestReceiptAt = receipt.updatedAt;
    }
    if (receipt.status !== "read" && receipt.status !== "acknowledged") {
      unreadCount += 1;
    }
    if (receipt.status === "delivered") {
      deliveredCount += 1;
    } else if (receipt.status === "suppressed_quiet") {
      suppressedQuietCount += 1;
    } else if (receipt.status === "suppressed_night") {
      suppressedNightCount += 1;
    }
    if (
      receipt.channel === "digest" &&
      (receipt.status === "suppressed_quiet" || receipt.status === "suppressed_night")
    ) {
      foldedDigestCount += 1;
    }
    if (receipt.passthrough) {
      criticalPassthroughCount += 1;
    }
  }

  return {
    lowDistractionEnabled: policy.lowDistractionEnabled,
    mode: policy.mode ?? (policy.lowDistractionEnabled ? "low_distraction" : "balanced"),
    unreadCount,
    deliveredCount,
    suppressedQuietCount,
    suppressedNightCount,
    foldedDigestCount,
    criticalPassthroughCount,
    latestReceiptAt,
  };
}
