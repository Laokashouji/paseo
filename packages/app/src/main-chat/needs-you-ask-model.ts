import type { TFunction } from "i18next";
import type { ActionBarDecisionNeedsYouItem, ActionBarTaskNeedsYouItem } from "./action-bar-model";

export interface NeedsYouAskOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  action: "send" | "retry_fallback";
  sendText?: string;
  decisionOptionId?: string;
}

export interface NeedsYouAskCardModel {
  categoryLabel: string;
  tone: "warning" | "danger";
  question: string;
  detail: string | null;
  options: NeedsYouAskOption[];
  allowCustomInput: boolean;
  canOpenTarget: boolean;
}

function normalizeSpaces(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function isDuplicateText(candidate: string | null | undefined, primary: string): boolean {
  const normCandidate = normalizeSpaces(candidate).toLowerCase();
  if (!normCandidate) return true;
  const normPrimary = normalizeSpaces(primary).toLowerCase();
  return normPrimary === normCandidate || normPrimary.includes(normCandidate);
}

function resolveErrorCategoryLabel(item: ActionBarTaskNeedsYouItem, t: TFunction): string {
  switch (item.ruleDiagnostic?.kind) {
    case "tool_loop":
      return t("mainChat.zeroTokenRules.badgeToolLoop");
    case "read_without_reply":
      return t("mainChat.zeroTokenRules.badgeReadWithoutReply");
    case "missing_wrap_up":
      return t("mainChat.zeroTokenRules.badgeMissingWrapUp");
    default:
      return t("mainChat.actionBar.askCard.categoryError");
  }
}

/**
 * Builds the Persona-aligned structured Ask Card model for a `decision` Needs You item.
 */
export function buildDecisionAskCardModel(
  item: ActionBarDecisionNeedsYouItem,
  t: TFunction,
): NeedsYouAskCardModel {
  const decision = item.decision;
  const question = decision.question.trim() || decision.title.trim();
  const detail =
    decision.reason && !isDuplicateText(decision.reason, question) ? decision.reason.trim() : null;

  const options: NeedsYouAskOption[] = [];
  for (const opt of decision.options) {
    const desc = opt.leadsTo.trim();
    options.push({
      id: `decision-opt:${opt.id}`,
      label: opt.label,
      description: desc || undefined,
      recommended: decision.recommendedOptionId === opt.id,
      action: "send",
      sendText: opt.label,
      decisionOptionId: opt.id,
    });
  }

  return {
    categoryLabel: t("mainChat.actionBar.askCard.categoryDecision"),
    tone: "warning",
    question,
    detail,
    options,
    allowCustomInput: true,
    canOpenTarget: Boolean(item.agentId),
  };
}

function buildErrorTaskAskCardModel(
  item: ActionBarTaskNeedsYouItem,
  t: TFunction,
): NeedsYouAskCardModel {
  const question =
    item.ruleDiagnostic?.summary?.trim() ||
    item.reason?.trim() ||
    item.summary?.trim() ||
    t("mainChat.actionBar.askCard.fallbackErrorQuestion");
  const rawDetail =
    item.ruleDiagnostic?.errorExcerpt?.trim() ||
    item.ruleDiagnostic?.detail?.trim() ||
    item.summary?.trim() ||
    null;
  const detail = rawDetail && !isDuplicateText(rawDetail, question) ? rawDetail : null;

  const options: NeedsYouAskOption[] = [];
  if (item.canRetryWithFallback && item.taskId) {
    options.push({
      id: "retry_fallback",
      label: t("mainChat.modelProfiles.retryFallback.button"),
      description: t("mainChat.actionBar.askCard.optionRetryFallbackDesc"),
      recommended: true,
      action: "retry_fallback",
    });
  }
  return {
    categoryLabel: resolveErrorCategoryLabel(item, t),
    tone: "danger",
    question,
    detail,
    options,
    allowCustomInput: Boolean(item.agentId),
    canOpenTarget: Boolean(item.agentId),
  };
}

export function buildTaskAskCardModel(
  item: ActionBarTaskNeedsYouItem,
  t: TFunction,
): NeedsYouAskCardModel {
  if (item.isFailed || item.ruleDiagnostic !== null) {
    return buildErrorTaskAskCardModel(item, t);
  }

  const question =
    item.reason?.trim() ||
    item.summary?.trim() ||
    item.goal?.trim() ||
    t("mainChat.actionBar.askCard.fallbackQuestion");
  const detail =
    item.summary && !isDuplicateText(item.summary, question) ? item.summary.trim() : null;
  const options: NeedsYouAskOption[] = [];

  return {
    categoryLabel: t("mainChat.actionBar.askCard.categoryQuestion"),
    tone: "warning",
    question,
    detail,
    options,
    allowCustomInput: Boolean(item.agentId),
    canOpenTarget: Boolean(item.agentId),
  };
}
