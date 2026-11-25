import type { TFunction } from "i18next";
import type { ActionBarDecisionNeedsYouItem, ActionBarTaskNeedsYouItem } from "./action-bar-model";

export interface NeedsYouAskOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
  action: "send" | "dismiss" | "retry_fallback";
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

interface ParsedOptionEntry {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ParsedQuestionOptionsResult {
  questionLead: string;
  options: ParsedOptionEntry[];
}

const MAX_PARSED_OPTIONS = 4;

const RECOMMENDED_SUFFIX_RE = /(?:\s*[(（[]\s*(?:推荐|建议|recommended|default)\s*[)）\]])+\s*$/i;

const CIRCLED_DIGIT_MAP: Record<string, number> = {
  "①": 1,
  "②": 2,
  "③": 3,
  "④": 4,
  "⑤": 5,
  "⑥": 6,
};

const MULTILINE_OPTION_RE =
  /^\s*(?:[-*•]\s*)?(?:(?:选项|方案|option)\s*)?(?:\(?([1-6]|[A-Da-d])\)?[.)、:：]|([①②③④⑤⑥]))\s*(.+?)\s*$/i;

const INLINE_OPTION_MARKER_RE = /(?:^|[\s，,；;：:])(?:\(?([1-4])\)?[.)、]|([①②③④]))\s*/g;

function normalizeSpaces(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function parseOptionLabelAndDescription(rawText: string): {
  label: string;
  description?: string;
  recommended?: boolean;
} {
  let text = rawText.replace(/[；;]+$/, "").trim();
  let recommended = false;

  if (RECOMMENDED_SUFFIX_RE.test(text)) {
    recommended = true;
    text = text.replace(RECOMMENDED_SUFFIX_RE, "").trim();
  }

  const splitMatch = /^(.{2,38}?)(?:\s*[—–]\s*|\s+-\s+|[：:]\s*)(.{3,})$/.exec(text);
  if (splitMatch) {
    let label = splitMatch[1]!.trim();
    const description = splitMatch[2]!.trim();
    if (RECOMMENDED_SUFFIX_RE.test(label)) {
      recommended = true;
      label = label.replace(RECOMMENDED_SUFFIX_RE, "").trim();
    }
    if (label.length > 0 && description.length > 0) {
      return { label, description, recommended };
    }
  }

  return { label: text, recommended };
}

function resolveOptionKeyToken(alphaNum: string | undefined, circled: string | undefined): string {
  if (alphaNum) return alphaNum.toLowerCase();
  if (circled && CIRCLED_DIGIT_MAP[circled] !== undefined) {
    return String(CIRCLED_DIGIT_MAP[circled]);
  }
  return "";
}

function parseMultilineOptionLine(
  trimmed: string,
  fallbackIndex: number,
): ParsedOptionEntry | null {
  const match = MULTILINE_OPTION_RE.exec(trimmed);
  if (!match) return null;
  const content = (match[3] ?? "").trim();
  if (!content) return null;
  const { label, description, recommended } = parseOptionLabelAndDescription(content);
  if (!label) return null;
  const keyToken = resolveOptionKeyToken(match[1], match[2]);
  return {
    id: `parsed-${keyToken || fallbackIndex}`,
    label,
    description,
    recommended,
  };
}

function parseMultilineOptions(text: string): ParsedQuestionOptionsResult | null {
  const lines = text.split(/\r?\n/);
  const leadLines: string[] = [];
  const parsed: ParsedOptionEntry[] = [];
  let inOptions = false;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      if (!inOptions && leadLines.length > 0) leadLines.push("");
      continue;
    }

    const option = parseMultilineOptionLine(trimmed, parsed.length + 1);
    if (option) {
      inOptions = true;
      parsed.push(option);
      if (parsed.length >= MAX_PARSED_OPTIONS) break;
      continue;
    }

    if (!inOptions) {
      leadLines.push(trimmed);
      continue;
    }

    const last = parsed[parsed.length - 1];
    if (last && !last.description && trimmed.length <= 120) {
      last.description = trimmed;
    }
  }

  if (parsed.length < 2) return null;
  return { questionLead: leadLines.join("\n").trim(), options: parsed };
}

function parseInlineMarkerNumber(digit: string | undefined, circled: string | undefined): number {
  if (digit) return Number(digit);
  if (circled && CIRCLED_DIGIT_MAP[circled] !== undefined) {
    return CIRCLED_DIGIT_MAP[circled];
  }
  return Number.NaN;
}

function parseInlineNumberedOptions(text: string): ParsedQuestionOptionsResult | null {
  const compact = text.replace(/\s+/g, " ").trim();
  const matches: Array<{ index: number; end: number; num: number }> = [];
  INLINE_OPTION_MARKER_RE.lastIndex = 0;

  let m = INLINE_OPTION_MARKER_RE.exec(compact);
  while (m !== null) {
    const rawNum = parseInlineMarkerNumber(m[1], m[2]);
    if (Number.isFinite(rawNum)) {
      matches.push({ index: m.index, end: m.index + m[0].length, num: rawNum });
    }
    m = INLINE_OPTION_MARKER_RE.exec(compact);
  }

  const startIdx = matches.findIndex((entry) => entry.num === 1);
  if (startIdx < 0) return null;

  const sequence: Array<{ index: number; end: number; num: number }> = [];
  let expected = 1;
  for (let i = startIdx; i < matches.length && sequence.length < MAX_PARSED_OPTIONS; i += 1) {
    if (matches[i]!.num === expected) {
      sequence.push(matches[i]!);
      expected += 1;
    }
  }
  if (sequence.length < 2) return null;

  const questionLead = compact
    .slice(0, sequence[0]!.index)
    .replace(/[：:；;，,]+$/, "")
    .trim();

  const options: ParsedOptionEntry[] = [];
  for (let i = 0; i < sequence.length; i += 1) {
    const segStart = sequence[i]!.end;
    const segEnd = i + 1 < sequence.length ? sequence[i + 1]!.index : compact.length;
    const rawSegment = compact.slice(segStart, segEnd).trim();
    if (!rawSegment) continue;
    const { label, description, recommended } = parseOptionLabelAndDescription(rawSegment);
    if (!label) continue;
    options.push({
      id: `parsed-${sequence[i]!.num}`,
      label,
      description,
      recommended,
    });
  }

  if (options.length < 2) return null;
  return { questionLead, options };
}

/**
 * Extracts structured 1/2/3 or A/B/C selectable choices from a manual session question or summary.
 */
export function extractQuestionOptionsFromText(text: string): ParsedQuestionOptionsResult | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return parseMultilineOptions(trimmed) ?? parseInlineNumberedOptions(trimmed);
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

function makeIgnoreOption(t: TFunction): NeedsYouAskOption {
  return {
    id: "dismiss",
    label: t("mainChat.actionBar.askCard.optionIgnore"),
    description: t("mainChat.actionBar.askCard.optionIgnoreDesc"),
    action: "dismiss",
  };
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
  options.push(makeIgnoreOption(t));

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
  options.push({
    id: "handled_continue",
    label: t("mainChat.actionBar.askCard.optionHandledContinue"),
    description: t("mainChat.actionBar.askCard.optionHandledContinueDesc"),
    recommended: !item.canRetryWithFallback,
    action: "send",
    sendText: t("mainChat.actionBar.askCard.optionHandledContinuePrompt"),
  });
  options.push(makeIgnoreOption(t));

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

function findFirstParsedQuestionSource(
  item: ActionBarTaskNeedsYouItem,
): { parsed: ParsedQuestionOptionsResult; sourceText: string } | null {
  const sources = [item.reason, item.summary, item.suggestedAction];
  for (const raw of sources) {
    if (typeof raw !== "string" || raw.trim().length === 0) continue;
    const extracted = extractQuestionOptionsFromText(raw);
    if (extracted) {
      return { parsed: extracted, sourceText: raw };
    }
  }
  return null;
}

function buildDefaultQuickReplyOptions(t: TFunction): NeedsYouAskOption[] {
  return [
    {
      id: "quick_proceed",
      label: t("mainChat.actionBar.askCard.optionProceedRecommended"),
      description: t("mainChat.actionBar.askCard.optionProceedRecommendedDesc"),
      recommended: true,
      action: "send",
      sendText: t("mainChat.actionBar.askCard.optionProceedRecommendedPrompt"),
    },
    {
      id: "quick_list_options",
      label: t("mainChat.actionBar.askCard.optionListOptions"),
      description: t("mainChat.actionBar.askCard.optionListOptionsDesc"),
      action: "send",
      sendText: t("mainChat.actionBar.askCard.optionListOptionsPrompt"),
    },
  ];
}

/**
 * Builds the Persona-aligned structured Ask Card model for a `task` or manual session Needs You item.
 */
export function buildTaskAskCardModel(
  item: ActionBarTaskNeedsYouItem,
  t: TFunction,
): NeedsYouAskCardModel {
  if (item.isFailed || item.ruleDiagnostic !== null) {
    return buildErrorTaskAskCardModel(item, t);
  }

  const parsedHit = findFirstParsedQuestionSource(item);
  const fallbackQuestion =
    item.reason?.trim() ||
    item.summary?.trim() ||
    item.goal?.trim() ||
    t("mainChat.actionBar.askCard.fallbackQuestion");

  const question =
    parsedHit && parsedHit.parsed.questionLead.length > 0
      ? parsedHit.parsed.questionLead
      : fallbackQuestion;

  const secondaryCandidate =
    item.summary && item.summary !== parsedHit?.sourceText ? item.summary.trim() : null;
  const detail =
    secondaryCandidate && !isDuplicateText(secondaryCandidate, question)
      ? secondaryCandidate
      : null;

  const options: NeedsYouAskOption[] = [];
  if (parsedHit) {
    for (const opt of parsedHit.parsed.options) {
      options.push({
        id: opt.id,
        label: opt.label,
        description: opt.description,
        recommended: opt.recommended,
        action: "send",
        sendText: opt.label,
      });
    }
  } else {
    options.push(...buildDefaultQuickReplyOptions(t));
  }
  options.push(makeIgnoreOption(t));

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
