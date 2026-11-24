import { z } from "zod";
import type {
  MainChatBackgroundModelConfig,
  MainChatSessionPhase,
} from "@getpaseo/protocol/main-chat";
import type { AgentManager } from "../agent/agent-manager.js";
import {
  generateStructuredAgentResponseWithFallback,
  type StructuredGenerationLogger,
  type StructuredGenerationProvider,
} from "../agent/agent-response-loop.js";
import type { AgentProvider, AgentUsage } from "../agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import {
  resolveStructuredGenerationProviders,
  type StructuredGenerationDaemonConfig,
} from "../agent/structured-generation-providers.js";

export type MainChatErrorClass = "transient" | "usage_limit" | "user";

const CANCELLED_TURN_PATTERNS = [
  /request was aborted/i,
  /\bturn (?:was )?(?:aborted|cancell?ed|interrupted)\b/i,
  /\b(?:aborted|cancell?ed) by (?:the )?user\b/i,
  /\binterrupted by (?:the )?user\b/i,
  /^(?:aborted|cancell?ed|interrupted)\.?$/i,
];

const USER_PATTERNS = [
  /failed to authenticate/i,
  /oauth token has expired/i,
  /invalid api key/i,
  /not logged in/i,
  /please run \/login/i,
  /\b(400|401|403|413)\b/,
  /invalid_request_error/i,
  /prompt is too long/i,
  /context (length|window)/i,
  /model .*(not found|unavailable|does not exist)/i,
  /request was aborted/i,
];

/**
 * Identifies user-initiated turn cancellations / aborts so the supervisor does not treat manual
 * stops or steers as unexpected failures or inflate user-interrupt counters.
 */
export function isCancelledTurnError(message: string): boolean {
  const trimmed = message.trim();
  if (!trimmed) return false;
  return CANCELLED_TURN_PATTERNS.some((pattern) => pattern.test(trimmed));
}

const USAGE_LIMIT_PATTERNS = [
  /usage limit/i,
  /usage_limit/i,
  /quota reached/i,
  /rate limit reset/i,
  /limit will reset/i,
  /resets? in \d+/i,
];

const TRANSIENT_PATTERNS = [
  /\b(408|429|500|502|503|504|529)\b/,
  /overloaded/i,
  /connection (error|lost|reset|closed)/i,
  /timed? ?out/i,
  /socket hang up/i,
  /ECONNRESET/,
  /ECONNREFUSED/,
  /ETIMEDOUT/,
  /fetch failed/i,
  /no eligible upstream/i,
  /upstream/i,
  /network error/i,
  /stream (ended|disconnected)/i,
];

const MIN_USAGE_LIMIT_DELAY_MS = 30_000;
const MAX_USAGE_LIMIT_DELAY_MS = 4 * 60 * 60 * 1000;
const DEFAULT_USAGE_LIMIT_DELAY_MS = 10 * 60 * 1000;

/**
 * Classifies turn failure messages so the supervisor auto-continues transient hiccups,
 * schedules delayed recovery on usage limits, and never loops on auth/user errors.
 */
export function classifyMainChatTurnError(message: string): MainChatErrorClass {
  if (USER_PATTERNS.some((pattern) => pattern.test(message))) return "user";
  if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) return "usage_limit";
  if (TRANSIENT_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
  return "user";
}

function clampUsageLimitDelay(ms: number): number {
  return Math.min(MAX_USAGE_LIMIT_DELAY_MS, Math.max(MIN_USAGE_LIMIT_DELAY_MS, ms));
}

export interface UsageLimitWakeSchedule {
  wakeAtMs: number;
  wakeAtIso: string;
  delayMs: number;
  parsedExplicitly: boolean;
}

const ISO_TIMESTAMP_RE =
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})/;
const CLOCK_TIME_RE =
  /(?:resets?\s+at|until|wake[_ ]?at|将于|将在|重置于|到)\s*[:=]?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i;

function parseAbsoluteUsageLimitWakeMs(message: string, nowMs: number): number | null {
  const isoMatch = ISO_TIMESTAMP_RE.exec(message);
  if (isoMatch) {
    const parsedMs = Date.parse(isoMatch[0]);
    if (Number.isFinite(parsedMs) && parsedMs > nowMs) {
      return parsedMs;
    }
  }

  const clockMatch = CLOCK_TIME_RE.exec(message);
  if (!clockMatch) return null;
  let hour = Number(clockMatch[1]);
  const minute = clockMatch[2] ? Number(clockMatch[2]) : 0;
  const meridiem = clockMatch[3]?.toLowerCase();
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23) return null;

  const target = new Date(nowMs);
  target.setSeconds(0, 0);
  target.setHours(hour, minute, 0, 0);
  if (target.getTime() <= nowMs) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

function parseRelativeUsageLimitDelayMs(message: string): number | null {
  const hourMatch = /(\d+)\s*(?:h|hr|hrs|hour|hours|小时)/i.exec(message);
  const minuteMatch = /(\d+)\s*(?:m|min|mins|minute|minutes|分钟|分)/i.exec(message);
  const secondMatch = /(\d+)\s*(?:s|sec|secs|second|seconds|秒)/i.exec(message);

  const hours = hourMatch ? Number(hourMatch[1]) : 0;
  const minutes = minuteMatch ? Number(minuteMatch[1]) : 0;
  const seconds = secondMatch ? Number(secondMatch[1]) : 0;

  const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
  return totalMs > 0 ? totalMs : null;
}

/**
 * Parses provider usage-limit reset instructions into an exact `wake_at` timestamp and clamped
 * delay. Supports ISO timestamps, `wake_at`, clock times ("Resets at 3:30 PM", "将于 18:00 重置"),
 * and relative countdowns ("Resets in 2h 15m", "30分钟后重置").
 */
export function parseUsageLimitWakeAt(
  message: string,
  nowMs: number = Date.now(),
  fallbackMs: number = DEFAULT_USAGE_LIMIT_DELAY_MS,
): UsageLimitWakeSchedule {
  const absoluteMs = parseAbsoluteUsageLimitWakeMs(message, nowMs);
  if (absoluteMs !== null) {
    const delayMs = clampUsageLimitDelay(absoluteMs - nowMs);
    const wakeAtMs = nowMs + delayMs;
    return {
      wakeAtMs,
      wakeAtIso: new Date(wakeAtMs).toISOString(),
      delayMs,
      parsedExplicitly: true,
    };
  }

  const relativeMs = parseRelativeUsageLimitDelayMs(message);
  if (relativeMs !== null) {
    const delayMs = clampUsageLimitDelay(relativeMs);
    const wakeAtMs = nowMs + delayMs;
    return {
      wakeAtMs,
      wakeAtIso: new Date(wakeAtMs).toISOString(),
      delayMs,
      parsedExplicitly: true,
    };
  }

  const delayMs = clampUsageLimitDelay(fallbackMs);
  const wakeAtMs = nowMs + delayMs;
  return {
    wakeAtMs,
    wakeAtIso: new Date(wakeAtMs).toISOString(),
    delayMs,
    parsedExplicitly: false,
  };
}

/**
 * Extracts a reset countdown from provider usage-limit error text (e.g. "Resets in 2h 15m",
 * "retry in 45m", "30分钟后重置", "Resets at 2026-11-23T15:30:00Z") and clamps it to a safe
 * scheduling window.
 */
export function parseUsageLimitResetDelayMs(
  message: string,
  fallbackMs: number = DEFAULT_USAGE_LIMIT_DELAY_MS,
  nowMs: number = Date.now(),
): number {
  return parseUsageLimitWakeAt(message, nowMs, fallbackMs).delayMs;
}

// ============================================================================
// No-progress loop classification & delegation anti-repeat helpers
// ============================================================================

const SUBSTANTIVE_TOOL_PATTERNS = [
  /^(edit|write|notebookedit|apply_patch|patch|multi_edit|replace|create_file|delete_file)$/i,
  /^task_(plan|start|rework|complete|ask_user)$/i,
];

const WAIT_OR_POLL_COMMAND_PATTERN =
  /\b(sleep|wait|watch|tail\s+-f|git\s+status|gh\s+run\s+(watch|view|list)|kubectl\s+get|ps\s+aux|curl\s+-s)\b/i;

const NO_PROGRESS_TOOL_PATTERNS = [
  /^(schedulewakeup|monitor|sleep|wait|get_agent_activity|task_list)$/i,
];

export function isSubstantiveProgressToolCall(
  toolName: string,
  detailText?: string | null,
): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (SUBSTANTIVE_TOOL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (
    (normalized === "bash" || normalized === "shell" || normalized === "terminal") &&
    detailText
  ) {
    if (
      /\b(git\s+(commit|push|merge|cherry-pick)|jj\s+(commit|describe|squash)|npm\s+run\s+(build|test)|vitest|pytest|cargo\s+test|go\s+test)\b/i.test(
        detailText,
      )
    ) {
      return !WAIT_OR_POLL_COMMAND_PATTERN.test(detailText);
    }
  }
  return false;
}

export function isNoProgressToolCall(toolName: string, detailText?: string | null): boolean {
  const normalized = toolName.trim().toLowerCase();
  if (NO_PROGRESS_TOOL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (
    (normalized === "bash" || normalized === "shell" || normalized === "terminal") &&
    detailText
  ) {
    return WAIT_OR_POLL_COMMAND_PATTERN.test(detailText);
  }
  return false;
}

function normalizeQuestionText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function buildBigrams(text: string): Set<string> {
  const set = new Set<string>();
  if (text.length < 2) {
    if (text.length === 1) set.add(text);
    return set;
  }
  for (let i = 0; i < text.length - 1; i += 1) {
    set.add(text.slice(i, i + 2));
  }
  return set;
}

/**
 * Returns true if the candidate question matches a previously delegated question (exact after
 * stripping spaces/punctuation, or bigram Dice similarity >= 0.8), preventing auto-answer loops.
 */
export function isSimilarDelegatedQuestion(
  candidate: string,
  previousQuestions: readonly string[],
): boolean {
  const normalizedCandidate = normalizeQuestionText(candidate);
  if (!normalizedCandidate) return false;
  const candidateBigrams = buildBigrams(normalizedCandidate);

  for (const prev of previousQuestions) {
    const normalizedPrev = normalizeQuestionText(prev);
    if (!normalizedPrev) continue;
    if (normalizedPrev === normalizedCandidate) return true;
    const prevBigrams = buildBigrams(normalizedPrev);
    let intersection = 0;
    for (const bg of candidateBigrams) {
      if (prevBigrams.has(bg)) intersection += 1;
    }
    const denominator = candidateBigrams.size + prevBigrams.size;
    if (denominator > 0 && (2 * intersection) / denominator >= 0.8) {
      return true;
    }
  }
  return false;
}

// ============================================================================
// Rule-first & Background-Model Semantic Triage
// ============================================================================

const RISKY_ACTION_PATTERN =
  /\b(git\s+push|force\s+push|publish|deploy|release|delete|drop\s+table|rm\s+-rf)\b|推送|发布|上线|删除|合并\s*(PR|MR)|发飞书|对外发送/i;

const EXPLICIT_QUESTION_PATTERN =
  /([？?]\s*$|请确认|请拍板|请决定|你选哪个|选哪一个|是否需要|要不要|需要你确认|let me know|please confirm|which option|should i\b)/i;

const EXTERNAL_WAIT_PATTERN =
  /(等待\s*(CI|构建|部署|流水线|审批|回复|重置)|waiting for (ci|deploy|build|review|reset|quota))/i;

const OPTIONAL_OFFER_TAIL_PATTERN =
  /(如果你需要|需要的话|如需继续|顺便.*吗[？?]?$|要不要我顺手.*吗[？?]?$|if you(?:'d| would) like|let me know if you want)/i;

export const SemanticTriageOptionSchema = z.object({
  label: z.string().trim().min(1).max(60),
  leadsTo: z.string().trim().min(1).max(120),
});

export const SemanticTriageOutputSchema = z.object({
  phase: z.enum(["done", "blocked_user", "blocked_external", "unsure"]),
  summary: z.string().trim().min(1).max(120),
  waitReason: z.string().trim().min(1).max(160).nullable(),
  needsUserDecision: z.boolean(),
  isLowRiskTechnicalQuestion: z.boolean(),
  riskyAction: z.boolean(),
  suggestedReply: z.string().trim().min(1).max(400).nullable(),
  options: z.array(SemanticTriageOptionSchema).max(4).optional(),
});
export type SemanticTriageOutput = z.infer<typeof SemanticTriageOutputSchema>;

function compactFirstSentence(text: string, maxLen = 80): string {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "本轮已结束";
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

/**
 * Deterministic zero-token triage fallback used when semantic model triage is disabled or
 * unavailable. Conservative by design: never fabricates questions or auto-delegates.
 */
export function heuristicTriageAssistantReply(replyText: string): {
  phase: MainChatSessionPhase;
  summary: string;
  waitReason: string | null;
  suggestedAction: string | null;
  riskyAction: boolean;
} {
  const trimmed = replyText.trim();
  if (!trimmed) {
    return {
      phase: "unsure",
      summary: "本轮已停止，暂无可读文本输出",
      waitReason: null,
      suggestedAction: "打开会话查看最新输出",
      riskyAction: false,
    };
  }
  const tail = trimmed.slice(-360);
  const riskyAction = RISKY_ACTION_PATTERN.test(tail);
  if (EXTERNAL_WAIT_PATTERN.test(tail) && !EXPLICIT_QUESTION_PATTERN.test(tail)) {
    return {
      phase: "blocked_external",
      summary: compactFirstSentence(trimmed),
      waitReason: "等待外部流程/状态变化",
      suggestedAction: "稍后复查等待前提是否满足",
      riskyAction,
    };
  }
  if (EXPLICIT_QUESTION_PATTERN.test(tail) && !OPTIONAL_OFFER_TAIL_PATTERN.test(tail)) {
    return {
      phase: "blocked_user",
      summary: compactFirstSentence(trimmed),
      waitReason: compactFirstSentence(tail, 90),
      suggestedAction: riskyAction ? "涉及高风险动作，请确认后再执行" : "查看会话并确认下一步",
      riskyAction,
    };
  }
  return {
    phase: "done",
    summary: compactFirstSentence(trimmed),
    waitReason: null,
    suggestedAction: null,
    riskyAction,
  };
}

export async function resolveMainChatBackgroundProviders(input: {
  backgroundModel: MainChatBackgroundModelConfig;
  cwd: string;
  providerSnapshotManager: Pick<ProviderSnapshotManager, "listProviders">;
  daemonConfig?: StructuredGenerationDaemonConfig | null;
  mainSelection?: {
    provider?: AgentProvider | null;
    model?: string | null;
    thinkingOptionId?: string | null;
  } | null;
}): Promise<StructuredGenerationProvider[]> {
  const { backgroundModel } = input;
  if (backgroundModel.mode === "custom" && backgroundModel.provider?.trim()) {
    return [
      {
        provider: backgroundModel.provider.trim() as AgentProvider,
        ...(backgroundModel.model?.trim() ? { model: backgroundModel.model.trim() } : {}),
        ...(backgroundModel.thinkingOptionId?.trim()
          ? { thinkingOptionId: backgroundModel.thinkingOptionId.trim() }
          : {}),
      },
    ];
  }
  if (backgroundModel.mode === "main" && input.mainSelection?.provider) {
    return [
      {
        provider: input.mainSelection.provider,
        ...(input.mainSelection.model ? { model: input.mainSelection.model } : {}),
        ...(input.mainSelection.thinkingOptionId
          ? { thinkingOptionId: input.mainSelection.thinkingOptionId }
          : {}),
      },
    ];
  }
  // Auto mode uses lightweight metadata models only and never silently falls back to the main
  // steward's high-quota model; when none are available/healthy, the supervisor falls back to
  // zero-token deterministic rules. Users who want the main model can choose mode="main".
  return resolveStructuredGenerationProviders({
    cwd: input.cwd,
    providerSnapshotManager: input.providerSnapshotManager,
    daemonConfig: input.daemonConfig,
  });
}

export interface RunSemanticTriageInput {
  agentManager: AgentManager;
  cwd: string;
  sessionTitle: string;
  projectName: string;
  lastAssistantReply: string;
  providers: readonly StructuredGenerationProvider[];
  logger?: StructuredGenerationLogger;
  generator?: typeof generateStructuredAgentResponseWithFallback;
  onUsage?: (usage: AgentUsage, meta: { provider: AgentProvider; model: string | null }) => void;
}

export async function runMainChatSemanticTriage(
  input: RunSemanticTriageInput,
): Promise<SemanticTriageOutput | null> {
  if (input.providers.length === 0) return null;
  const trimmedReply = input.lastAssistantReply.trim();
  if (!trimmedReply) return null;

  const excerpt = trimmedReply.length > 3500 ? `...${trimmedReply.slice(-3500)}` : trimmedReply;

  const prompt = [
    "你是 Paseo 对话管家的后台分诊器。请只根据下面这个 Coding Agent 刚刚结束这一轮的最后回复，判断它的真实工作状态，返回严格 JSON，不要调用任何工具，也不要执行任何命令。",
    "",
    "判定标准：",
    "- phase='done'：本轮工作已交付（修完、测完、调研出结论或回答完问题），无需用户再操作。末尾类似「需要的话我可以顺手…」的可选提议仍算 done。",
    "- phase='blocked_user'：明确在等待用户做选择、确认、授权、登录或补充信息，尚未回答。",
    "- phase='blocked_external'：在等待 CI、部署、外部回复、定时重置或其他 Agent 结果。",
    "- phase='unsure'：半截停止或无法判断。",
    "",
    "安全红线（极重要）：",
    "- 若涉及 git push、发布/上线、删除文件/数据、合并 PR/MR、对外发消息/飞书回复、或产品方向/方案拍板，必须设 riskyAction=true 且 isLowRiskTechnicalQuestion=false。",
    "- 仅当问题属于纯技术实现细节/默认值选择/是否重跑测试等无外部副作用的内部问题时，才可设 isLowRiskTechnicalQuestion=true，并给出简洁的 suggestedReply。",
    "",
    `会话标题：${input.sessionTitle}`,
    `所在目录：${input.projectName}`,
    "最后回复：",
    excerpt,
  ].join("\n");

  const run = input.generator ?? generateStructuredAgentResponseWithFallback;
  return run({
    manager: input.agentManager,
    cwd: input.cwd,
    prompt,
    schema: SemanticTriageOutputSchema,
    providers: input.providers,
    persistSession: false,
    maxRetries: 1,
    schemaName: "MainChatSemanticTriage",
    logger: input.logger,
    onUsage: input.onUsage,
    agentConfigOverrides: {
      title: "Main chat semantic triage",
      internal: true,
    },
  });
}
