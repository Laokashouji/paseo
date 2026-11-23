import crypto from "node:crypto";
import path from "node:path";
import {
  extractMainChatPermissionRuleCandidate,
  type MainChatApprovalClarification,
  type MainChatDecisionRecord,
  type MainChatNextStepSuggestion,
  type MainChatPlanRecord,
  type MainChatRuleSuggestion,
  type MainChatSessionTriage,
  type MainChatStandingAuthorization,
  type MainChatStandingAuthorizationScope,
  type MainChatTaskMode,
  type MainChatTaskReceipt,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { isCwdCoveredByTrustRule, normalizeTrustCwd } from "./task-ledger.js";

export const SUPERVISOR_IDLE_ESCALATE_MS = 5 * 60_000;
export const SUPERVISOR_BUSY_MAX_HOLD_MS = 60 * 60_000;
export const PERMISSION_HARD_DEADLINE_MS = 15 * 60_000;
export const DUPLICATE_QUESTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const DUPLICATE_QUESTION_SIMILARITY_THRESHOLD = 0.8;
export const DEFAULT_RULE_SUGGESTION_THRESHOLD = 2;
export const MAX_NEXT_STEP_SUGGESTIONS = 4;

// ============================================================================
// 1. Hardcoded Deterministic Red-Line Guard
// ============================================================================

export type RedLineCategory =
  | "external_message"
  | "destructive_delete"
  | "git_remote_or_merge"
  | "production_deploy_or_secret"
  | "permission_or_system_config"
  | "chained_shell_command";

export interface RedLineGuardInput {
  kind?: string | null;
  toolName?: string | null;
  command?: string | null;
  question?: string | null;
  answer?: string | null;
  target?: string | null;
}

export interface RedLineGuardResult {
  blocked: boolean;
  category: RedLineCategory | null;
  reason: string | null;
  matchedRule: string | null;
}

interface RedLineRule {
  id: string;
  category: RedLineCategory;
  pattern: RegExp;
  reason: string;
}

const UNSAFE_SHELL_METACHAR_RE = /[;&|><`$()]/;

const RED_LINE_RULES: readonly RedLineRule[] = [
  {
    id: "external_message_channel",
    category: "external_message",
    pattern:
      /\b(lark[-_]?cli|lark[_-]?im|feishu|send[_-]?email|mail[_-]?send|send[_-]?message|post[_-]?comment|inbox[_-]?post|slack[_-]?post|im\s+send|gh\s+(pr|issue)\s+comment)\b|发飞书|飞书群|飞书消息|发消息|发送消息|发邮件|发送邮件|回复邮件|群聊|对外发送|发评论|发表评论|微信通知|钉钉通知/i,
    reason: "命中红线：禁止自动代答或放行对外发送消息、邮件、群聊或评论操作",
  },
  {
    id: "destructive_delete_ops",
    category: "destructive_delete",
    pattern:
      /\b(rm\s+-[a-z]*[rf][a-z]*|drop\s+(table|database|schema|index)|truncate\s+table|delete\s+from|mkfs(\.[a-z0-9]+)?|dd\s+if=|shred|git\s+clean\s+-[a-z]*f|git\s+reset\s+--hard)\b|删库|删表|清空数据库|清空表|不可逆删除|强制删除|彻底删除|递归删除/i,
    reason: "命中红线：禁止自动代答或放行删库、删表、rm -rf 或不可逆删除操作",
  },
  {
    id: "git_remote_push_or_merge",
    category: "git_remote_or_merge",
    pattern:
      /\b(git\s+push|force\s+push|jj\s+git\s+push|gh\s+pr\s+merge|github[_-]?merge|git\s+merge\b[^\n]*\b(main|master|prod|production|release)|merge\s+(into|to)\s+(main|master|prod))\b|--force-with-lease|强推|推送到?(远端|远程|主分支|main|master)|合入主分支|合并\s*(pr|mr|主分支|到\s*main|到\s*master)/i,
    reason: "命中红线：禁止自动代答或放行 git push、强推或合入主分支操作",
  },
  {
    id: "production_deploy_and_secrets",
    category: "production_deploy_or_secret",
    pattern:
      /\b((npm|pnpm|yarn)\s+publish|kubectl\s+(apply|delete|rollout|patch)|terraform\s+(apply|destroy)|deploy[_-]?prod|release[_-]?prod|rotate[_-]?(secret|key|token))\b|\b(deploy|release)\b[^\n]*\b(prod|production|live)\b|(修改|更新|写入|导出|删除|轮换|旋转)\s*(凭据|凭证|密钥|私钥|密码|secret|credential|api[_-]?key|access[_-]?token)|(\.ssh\/|\.aws\/credentials|\.env\.prod(uction)?|\/id_rsa\b)|生产发布|线上发布|发布上线|生产部署|部署到?(生产|线上|prod)/i,
    reason: "命中红线：禁止自动代答或放行生产发布、部署或修改凭据密钥操作",
  },
  {
    id: "permission_and_system_config",
    category: "permission_or_system_config",
    pattern:
      /\b(sudo|su\s+-|chmod|chown|visudo|useradd|usermod|systemctl|launchctl|iptables|ufw|shutdown|reboot)\b|\/etc\/(passwd|shadow|sudoers|hosts|ssh)|修改权限|变更权限|提权|修改系统配置|更改系统配置|修改防火墙|修改授权策略/i,
    reason: "命中红线：禁止自动代答或放行修改权限、提权或修改系统配置操作",
  },
];

const ANSWER_NEGATION_RE =
  /(暂不|不要|先不|无需|不用|切勿|do\s+not|don't)\s*(推送|强推|合并|合入|发布|部署|删除|发送|发消息|发邮件|修改权限|push|merge|deploy|publish|delete|send)/gi;

function stripShortAnswerNegations(answer: string): string {
  return answer.replace(ANSWER_NEGATION_RE, " ");
}

function collectGuardFragments(input: RedLineGuardInput): string[] {
  const fragments: string[] = [];
  if (input.toolName?.trim()) fragments.push(input.toolName.trim());
  if (input.command?.trim()) fragments.push(input.command.trim());
  if (input.question?.trim()) fragments.push(input.question.trim());
  if (input.target?.trim()) fragments.push(input.target.trim());
  if (input.answer?.trim()) {
    const cleanedAnswer = stripShortAnswerNegations(input.answer.trim());
    if (cleanedAnswer.trim()) fragments.push(cleanedAnswer.trim());
  }
  return fragments;
}

/**
 * Deterministic hardcoded safety guard. Never delegates safety classification to model judgment.
 */
export function checkRedLineGuard(input: RedLineGuardInput): RedLineGuardResult {
  const combined = collectGuardFragments(input).join("\n");
  if (combined.length > 0) {
    for (const rule of RED_LINE_RULES) {
      if (rule.pattern.test(combined)) {
        return {
          blocked: true,
          category: rule.category,
          reason: rule.reason,
          matchedRule: rule.id,
        };
      }
    }
  }

  const rawCommand = input.command?.trim() ?? "";
  if (rawCommand.length > 0 && UNSAFE_SHELL_METACHAR_RE.test(rawCommand)) {
    return {
      blocked: true,
      category: "chained_shell_command",
      reason: "命中安全限制：包含复合 Shell 连接符、管道或重定向的命令禁止自动放行",
      matchedRule: "unsafe_shell_metachar",
    };
  }

  return {
    blocked: false,
    category: null,
    reason: null,
    matchedRule: null,
  };
}

// ============================================================================
// 2. 24-Hour Duplicate Question Guard
// ============================================================================

export interface RecentQuestionRecord {
  text: string;
  at: string;
  taskId?: string | null;
  agentId?: string | null;
}

export interface DuplicateQuestionGuardInput {
  question: string;
  recentQuestions: readonly RecentQuestionRecord[];
  nowMs?: number;
  windowMs?: number;
  similarityThreshold?: number;
}

export interface DuplicateQuestionGuardResult {
  isDuplicate: boolean;
  similarity: number;
  matchedQuestion: string | null;
  matchedAt: string | null;
}

const QUESTION_FILLER_PREFIX_RE =
  /^(请问|麻烦确认|请确认一下|请确认|要不要|是否需要|能不能|可以吗|should\s+i|could\s+you|would\s+you\s+like\s+me\s+to|please\s+confirm)\s*/i;

export function normalizeQuestionForGuard(text: string): string {
  return text
    .trim()
    .replace(QUESTION_FILLER_PREFIX_RE, "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .trim();
}

function buildCharBigrams(normalized: string): Set<string> {
  const bigrams = new Set<string>();
  if (normalized.length < 2) {
    if (normalized.length === 1) bigrams.add(normalized);
    return bigrams;
  }
  for (let i = 0; i < normalized.length - 1; i += 1) {
    bigrams.add(normalized.slice(i, i + 2));
  }
  return bigrams;
}

function extractKeyFeatureTokens(raw: string): Set<string> {
  const matches = raw.toLowerCase().match(/[a-z0-9_./:-]{2,}/g) ?? [];
  return new Set(matches);
}

function computeDiceCoefficient(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  const denominator = left.size + right.size;
  if (denominator === 0) return 0;
  let intersection = 0;
  for (const item of left) {
    if (right.has(item)) intersection += 1;
  }
  return (2 * intersection) / denominator;
}

function scoreQuestionPairSimilarity(
  candidateNorm: string,
  candidateBigrams: ReadonlySet<string>,
  candidateFeatures: ReadonlySet<string>,
  prevRaw: string,
): number {
  const prevNorm = normalizeQuestionForGuard(prevRaw);
  if (!prevNorm) return 0;
  if (prevNorm === candidateNorm) return 1;

  const prevBigrams = buildCharBigrams(prevNorm);
  const bigramDice = computeDiceCoefficient(candidateBigrams, prevBigrams);
  if (bigramDice >= DUPLICATE_QUESTION_SIMILARITY_THRESHOLD) {
    return bigramDice;
  }

  if (candidateFeatures.size >= 2) {
    const prevFeatures = extractKeyFeatureTokens(prevRaw);
    const featureDice = computeDiceCoefficient(candidateFeatures, prevFeatures);
    if (featureDice >= 0.85 && bigramDice >= 0.6) {
      return Math.max(bigramDice, 0.82);
    }
  }
  return bigramDice;
}

/**
 * Blocks repeated questions for the same agent/task within a 24h sliding window using
 * normalized stem + character bigrams + key technical feature tokens.
 */
export function checkDuplicateQuestionGuard(
  input: DuplicateQuestionGuardInput,
): DuplicateQuestionGuardResult {
  const candidateNorm = normalizeQuestionForGuard(input.question);
  if (!candidateNorm) {
    return { isDuplicate: false, similarity: 0, matchedQuestion: null, matchedAt: null };
  }

  const nowMs = input.nowMs ?? Date.now();
  const windowMs = input.windowMs ?? DUPLICATE_QUESTION_WINDOW_MS;
  const threshold = input.similarityThreshold ?? DUPLICATE_QUESTION_SIMILARITY_THRESHOLD;
  const candidateBigrams = buildCharBigrams(candidateNorm);
  const candidateFeatures = extractKeyFeatureTokens(input.question);

  let bestSimilarity = 0;
  let bestEntry: RecentQuestionRecord | null = null;

  for (const entry of input.recentQuestions) {
    const ts = Date.parse(entry.at);
    if (!Number.isFinite(ts)) continue;
    if (nowMs - ts > windowMs || ts > nowMs + 60_000) continue;

    const similarity = scoreQuestionPairSimilarity(
      candidateNorm,
      candidateBigrams,
      candidateFeatures,
      entry.text,
    );
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestEntry = entry;
    }
  }

  if (bestEntry && bestSimilarity >= threshold) {
    return {
      isDuplicate: true,
      similarity: bestSimilarity,
      matchedQuestion: bestEntry.text,
      matchedAt: bestEntry.at,
    };
  }
  return {
    isDuplicate: false,
    similarity: bestSimilarity,
    matchedQuestion: null,
    matchedAt: null,
  };
}

// ============================================================================
// 3. Supervision-First Interception + Non-Resettable Hard Timeout Clock
// ============================================================================

export type ApprovalEscalationTier = "leader" | "main" | "user";
export type ApprovalRequestCategory = "permission" | "plan" | "question";
export type ApprovalEscalationReason =
  | "supervisor_idle"
  | "supervisor_busy_timeout"
  | "hard_deadline";

export interface ApprovalInterceptionEntry {
  key: string;
  agentId: string;
  serverId: string | null;
  requestId: string;
  taskId: string | null;
  conversationId: string | null;
  category: ApprovalRequestCategory;
  label: string;
  tier: ApprovalEscalationTier;
  createdAtMs: number;
  tierEnteredAtMs: number;
  supervisorIdleAccumulatedMs: number;
  supervisorBusySinceMs: number | null;
  lastTickAtMs: number;
  /** Immutable hard deadline for permission & plan approvals (never reset on tier escalation). */
  hardDeadlineAtMs: number | null;
  pausedForClarification: boolean;
  pausedAtMs: number | null;
  pausedDeadlineAtIso: string | null;
  escalatedToUserAtMs: number | null;
}

export interface TrackApprovalInput {
  agentId: string;
  serverId?: string | null;
  requestId: string;
  taskId?: string | null;
  conversationId?: string | null;
  category: ApprovalRequestCategory;
  label: string;
  initialTier: ApprovalEscalationTier;
  nowMs?: number;
}

export interface ApprovalEscalationEvent {
  entry: ApprovalInterceptionEntry;
  fromTier: ApprovalEscalationTier;
  toTier: ApprovalEscalationTier;
  reason: ApprovalEscalationReason;
  atMs: number;
}

export interface ApprovalInterceptionTrackerOptions {
  supervisorIdleEscalateMs?: number;
  supervisorBusyMaxHoldMs?: number;
  permissionHardDeadlineMs?: number;
  now?: () => number;
}

export interface ApprovalInterceptionTracker {
  track(input: TrackApprovalInput): ApprovalInterceptionEntry;
  get(agentId: string, requestId: string): ApprovalInterceptionEntry | null;
  list(): ApprovalInterceptionEntry[];
  resolve(agentId: string, requestId: string): boolean;
  resolveAllForAgent(agentId: string): number;
  pauseForClarification(input: {
    agentId: string;
    serverId?: string | null;
    requestId: string;
    label?: string;
    taskId?: string | null;
    conversationId?: string | null;
    nowMs?: number;
  }): { entry: ApprovalInterceptionEntry; pausedDeadlineAt: string };
  resumeAfterClarification(agentId: string, requestId: string, nowMs?: number): boolean;
  evaluateTick(
    nowMs: number,
    isSupervisorBusy: (entry: ApprovalInterceptionEntry) => boolean,
  ): ApprovalEscalationEvent[];
}

function makeApprovalKey(agentId: string, requestId: string): string {
  return `${agentId}:${requestId}`;
}

function nextEscalationTier(tier: ApprovalEscalationTier): ApprovalEscalationTier {
  if (tier === "leader") return "main";
  return "user";
}

function applyTierEscalation(
  entry: ApprovalInterceptionEntry,
  toTier: ApprovalEscalationTier,
  reason: ApprovalEscalationReason,
  nowMs: number,
): ApprovalEscalationEvent {
  const fromTier = entry.tier;
  entry.tier = toTier;
  entry.tierEnteredAtMs = nowMs;
  entry.supervisorIdleAccumulatedMs = 0;
  entry.supervisorBusySinceMs = null;
  entry.lastTickAtMs = nowMs;
  if (toTier === "user") {
    entry.escalatedToUserAtMs = nowMs;
  }
  return { entry: { ...entry }, fromTier, toTier, reason, atMs: nowMs };
}

function evaluateSingleApprovalEntry(
  entry: ApprovalInterceptionEntry,
  nowMs: number,
  isSupervisorBusy: (entry: ApprovalInterceptionEntry) => boolean,
  limits: {
    idleEscalateMs: number;
    busyMaxHoldMs: number;
  },
): ApprovalEscalationEvent | null {
  if (entry.tier === "user") {
    entry.lastTickAtMs = nowMs;
    return null;
  }

  if (entry.pausedForClarification) {
    entry.lastTickAtMs = nowMs;
    return null;
  }

  if (entry.hardDeadlineAtMs !== null && nowMs >= entry.hardDeadlineAtMs) {
    return applyTierEscalation(entry, "user", "hard_deadline", nowMs);
  }

  const deltaMs = Math.max(0, nowMs - entry.lastTickAtMs);
  if (isSupervisorBusy(entry)) {
    if (entry.supervisorBusySinceMs === null) {
      entry.supervisorBusySinceMs = entry.lastTickAtMs;
    }
    entry.lastTickAtMs = nowMs;
    if (nowMs - entry.supervisorBusySinceMs >= limits.busyMaxHoldMs) {
      return applyTierEscalation(
        entry,
        nextEscalationTier(entry.tier),
        "supervisor_busy_timeout",
        nowMs,
      );
    }
    return null;
  }

  entry.supervisorBusySinceMs = null;
  entry.supervisorIdleAccumulatedMs += deltaMs;
  entry.lastTickAtMs = nowMs;
  if (entry.supervisorIdleAccumulatedMs >= limits.idleEscalateMs) {
    return applyTierEscalation(entry, nextEscalationTier(entry.tier), "supervisor_idle", nowMs);
  }
  return null;
}

export function createApprovalInterceptionTracker(
  options: ApprovalInterceptionTrackerOptions = {},
): ApprovalInterceptionTracker {
  const idleEscalateMs = options.supervisorIdleEscalateMs ?? SUPERVISOR_IDLE_ESCALATE_MS;
  const busyMaxHoldMs = options.supervisorBusyMaxHoldMs ?? SUPERVISOR_BUSY_MAX_HOLD_MS;
  const hardDeadlineMs = options.permissionHardDeadlineMs ?? PERMISSION_HARD_DEADLINE_MS;
  const getNowMs = options.now ?? (() => Date.now());
  const entries = new Map<string, ApprovalInterceptionEntry>();

  return {
    track(input) {
      const key = makeApprovalKey(input.agentId, input.requestId);
      const existing = entries.get(key);
      if (existing) {
        return { ...existing };
      }
      const nowMs = input.nowMs ?? getNowMs();
      const hasHardDeadline = input.category === "permission" || input.category === "plan";
      const created: ApprovalInterceptionEntry = {
        key,
        agentId: input.agentId,
        serverId: input.serverId ?? null,
        requestId: input.requestId,
        taskId: input.taskId ?? null,
        conversationId: input.conversationId ?? null,
        category: input.category,
        label: input.label,
        tier: input.initialTier,
        createdAtMs: nowMs,
        tierEnteredAtMs: nowMs,
        supervisorIdleAccumulatedMs: 0,
        supervisorBusySinceMs: null,
        lastTickAtMs: nowMs,
        hardDeadlineAtMs: hasHardDeadline ? nowMs + hardDeadlineMs : null,
        pausedForClarification: false,
        pausedAtMs: null,
        pausedDeadlineAtIso: null,
        escalatedToUserAtMs: input.initialTier === "user" ? nowMs : null,
      };
      entries.set(key, created);
      return { ...created };
    },

    get(agentId, requestId) {
      const entry = entries.get(makeApprovalKey(agentId, requestId));
      return entry ? { ...entry } : null;
    },

    list() {
      const result: ApprovalInterceptionEntry[] = [];
      for (const entry of entries.values()) {
        result.push({ ...entry });
      }
      return result;
    },

    resolve(agentId, requestId) {
      return entries.delete(makeApprovalKey(agentId, requestId));
    },

    resolveAllForAgent(agentId) {
      let removed = 0;
      for (const [key, entry] of entries) {
        if (entry.agentId === agentId) {
          entries.delete(key);
          removed += 1;
        }
      }
      return removed;
    },

    pauseForClarification(input) {
      const nowMs = input.nowMs ?? getNowMs();
      const key = makeApprovalKey(input.agentId, input.requestId);
      let entry = entries.get(key);
      if (!entry) {
        entry = {
          key,
          agentId: input.agentId,
          serverId: input.serverId ?? null,
          requestId: input.requestId,
          taskId: input.taskId ?? null,
          conversationId: input.conversationId ?? null,
          category: "permission",
          label: input.label?.trim() || "待审批请求",
          tier: "main",
          createdAtMs: nowMs,
          tierEnteredAtMs: nowMs,
          supervisorIdleAccumulatedMs: 0,
          supervisorBusySinceMs: null,
          lastTickAtMs: nowMs,
          hardDeadlineAtMs: nowMs + hardDeadlineMs,
          pausedForClarification: false,
          pausedAtMs: null,
          pausedDeadlineAtIso: null,
          escalatedToUserAtMs: null,
        };
        entries.set(key, entry);
      }
      const deadlineMs = entry.hardDeadlineAtMs ?? nowMs + hardDeadlineMs;
      const pausedDeadlineAt = new Date(deadlineMs).toISOString();
      entry.pausedForClarification = true;
      entry.pausedAtMs = nowMs;
      entry.lastTickAtMs = nowMs;
      entry.pausedDeadlineAtIso = pausedDeadlineAt;
      return { entry: { ...entry }, pausedDeadlineAt };
    },

    resumeAfterClarification(agentId, requestId, nowMs) {
      const entry = entries.get(makeApprovalKey(agentId, requestId));
      if (!entry || !entry.pausedForClarification) return false;
      entry.pausedForClarification = false;
      entry.pausedAtMs = null;
      entry.lastTickAtMs = nowMs ?? getNowMs();
      return true;
    },

    evaluateTick(nowMs, isSupervisorBusy) {
      const escalations: ApprovalEscalationEvent[] = [];
      for (const entry of entries.values()) {
        const event = evaluateSingleApprovalEntry(entry, nowMs, isSupervisorBusy, {
          idleEscalateMs,
          busyMaxHoldMs,
        });
        if (event) {
          escalations.push(event);
        }
      }
      return escalations;
    },
  };
}

// ============================================================================
// 4. Approval Clarification & One-Time Anti-Replay Proof Token
// ============================================================================

export interface ClarificationProofMetadata {
  token: string;
  agentId: string;
  permissionRequestId: string;
  createdAt: string;
}

export interface ClarificationProofStore {
  issue(input: { agentId: string; permissionRequestId: string; nowIso: string }): string;
  consume(token: string, expected?: { agentId?: string; permissionRequestId?: string }): boolean;
  hasActive(token: string): boolean;
  revokeForPermission(agentId: string, permissionRequestId: string): number;
}

export function createClarificationProofStore(): ClarificationProofStore {
  const activeTokens = new Map<string, ClarificationProofMetadata>();

  return {
    issue(input) {
      const token = `prf_${crypto.randomBytes(16).toString("hex")}`;
      activeTokens.set(token, {
        token,
        agentId: input.agentId,
        permissionRequestId: input.permissionRequestId,
        createdAt: input.nowIso,
      });
      return token;
    },

    consume(token, expected) {
      const record = activeTokens.get(token);
      if (!record) return false;
      if (expected?.agentId && record.agentId !== expected.agentId) return false;
      if (
        expected?.permissionRequestId &&
        record.permissionRequestId !== expected.permissionRequestId
      ) {
        return false;
      }
      activeTokens.delete(token);
      return true;
    },

    hasActive(token) {
      return activeTokens.has(token);
    },

    revokeForPermission(agentId, permissionRequestId) {
      let removed = 0;
      for (const [token, record] of activeTokens) {
        if (record.agentId === agentId && record.permissionRequestId === permissionRequestId) {
          activeTokens.delete(token);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

export interface BuildClarificationAnswerInput {
  question: string;
  toolName: string;
  toolTitle?: string | null;
  description?: string | null;
  command?: string | null;
  inputSummary?: string | null;
  task?: Pick<MainChatTaskRecord, "title" | "mode" | "brief"> | null;
  recentAssistantText?: string | null;
  redLine: RedLineGuardResult;
}

function summarizeInputForClarification(input: BuildClarificationAnswerInput): string {
  if (input.command?.trim()) {
    return `命令 \`${input.command.trim().slice(0, 140)}\``;
  }
  if (input.inputSummary?.trim()) {
    return input.inputSummary.trim().slice(0, 140);
  }
  if (input.description?.trim()) {
    return input.description.trim().slice(0, 140);
  }
  return input.toolTitle?.trim() || input.toolName;
}

export function buildDeterministicClarificationAnswer(
  input: BuildClarificationAnswerInput,
): string {
  const lines: string[] = [];
  const actionSummary = summarizeInputForClarification(input);
  lines.push(`待审批动作：工具「${input.toolName}」，涉及 ${actionSummary}。`);

  if (input.task) {
    const modeLabel = input.task.mode === "readonly" ? "只读任务" : "可写任务";
    lines.push(
      `所属任务：「${input.task.title}」（${modeLabel}），目标：${input.task.brief.goal.slice(0, 120)}。`,
    );
    if (input.task.brief.outOfBounds.length > 0) {
      lines.push(`任务边界红线：${input.task.brief.outOfBounds.slice(0, 2).join("；")}。`);
    }
  }

  if (input.recentAssistantText?.trim()) {
    const excerpt = input.recentAssistantText.replace(/\s+/g, " ").trim().slice(0, 120);
    lines.push(`最近上下文：${excerpt}。`);
  }

  if (input.redLine.blocked && input.redLine.reason) {
    lines.push(`安全评估：${input.redLine.reason}，建议逐项确认影响范围后再决定是否批准。`);
  } else {
    lines.push("安全评估：未命中自动代答红线；如需确认细节可继续追问，自动升级倒计时已为你暂停。");
  }

  lines.push(
    `针对你的问题「${input.question.trim().slice(0, 100)}」：请结合上述动作与任务范围判断是否放行。`,
  );
  return lines.join("\n");
}

export function createApprovalClarificationRecord(input: {
  agentId: string;
  serverId: string | null;
  permissionRequestId: string;
  question: string;
  answer: string | null;
  proofToken: string;
  pausedDeadlineAt: string;
  nowIso: string;
}): MainChatApprovalClarification {
  return {
    id: `clr_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
    agentId: input.agentId,
    serverId: input.serverId,
    permissionRequestId: input.permissionRequestId,
    question: input.question.trim(),
    answer: input.answer,
    proofToken: input.proofToken,
    pausedDeadlineAt: input.pausedDeadlineAt,
    answeredAt: input.answer !== null ? input.nowIso : null,
    createdAt: input.nowIso,
  };
}

// ============================================================================
// 5. Standing Authorizations Deterministic Matcher & Progressive Suggestions
// ============================================================================

export interface StandingAuthorizationMatchRequest {
  scope: MainChatStandingAuthorizationScope;
  serverId?: string | null;
  localServerId?: string | null;
  cwd?: string | null;
  toolName?: string | null;
  command?: string | null;
  commandPrefix?: string | null;
  kind?: string | null;
  mode?: MainChatTaskMode | null;
  question?: string | null;
}

export interface StandingAuthorizationMatchResult {
  matched: boolean;
  authorization: MainChatStandingAuthorization | null;
  blockedByRedLine: RedLineGuardResult | null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizeToolKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function normalizePrefixKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function isAuthorizationActive(auth: MainChatStandingAuthorization, nowMs: number): boolean {
  if (auth.revokedAt !== null) return false;
  if (auth.expiresAt === null) return true;
  const expiresAtMs = Date.parse(auth.expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs > nowMs;
}

function matchesServerScope(
  ruleServerId: string | null,
  targetServerId: string | null | undefined,
  localServerId: string | null | undefined,
): boolean {
  const ruleServer = normalizeOptionalString(ruleServerId);
  const targetServer = normalizeOptionalString(targetServerId);
  const localServer = normalizeOptionalString(localServerId);

  const targetIsLocal =
    targetServer === null || (localServer !== null && targetServer === localServer);
  const ruleIsLocal = ruleServer === null || (localServer !== null && ruleServer === localServer);

  if (targetIsLocal) {
    return ruleIsLocal;
  }
  return ruleServer !== null && ruleServer === targetServer;
}

function matchesCwdScope(
  auth: MainChatStandingAuthorization,
  targetCwd: string | null | undefined,
): boolean {
  if (auth.cwd === null) {
    return auth.scope === "permission";
  }
  const normalizedTarget = normalizeOptionalString(targetCwd);
  if (!normalizedTarget) return false;
  const allowSubdirs = auth.allowSubdirectories ?? auth.scope === "auto_start";
  return isCwdCoveredByTrustRule(auth.cwd, normalizedTarget, allowSubdirs);
}

function resolveRequestPermissionPrefix(request: StandingAuthorizationMatchRequest): {
  valid: boolean;
  toolKey: string | null;
  prefixKey: string | null;
} {
  if (request.kind === "question" || request.kind === "plan") {
    return { valid: false, toolKey: null, prefixKey: null };
  }
  const toolKey = normalizeToolKey(request.toolName);
  if (!toolKey) {
    return { valid: false, toolKey: null, prefixKey: null };
  }
  const rawCommand = normalizeOptionalString(request.command);
  if (rawCommand !== null) {
    const candidate = extractMainChatPermissionRuleCandidate({
      kind: request.kind ?? "tool",
      name: request.toolName,
      input: { command: rawCommand },
    });
    if (!candidate) {
      return { valid: false, toolKey: null, prefixKey: null };
    }
    return {
      valid: true,
      toolKey,
      prefixKey: normalizePrefixKey(candidate.commandPrefix),
    };
  }
  return {
    valid: true,
    toolKey,
    prefixKey: normalizePrefixKey(request.commandPrefix),
  };
}

function matchesSingleStandingAuthorization(
  auth: MainChatStandingAuthorization,
  request: StandingAuthorizationMatchRequest,
  nowMs: number,
  resolvedPerm: { valid: boolean; toolKey: string | null; prefixKey: string | null } | null,
): boolean {
  if (auth.scope !== request.scope) return false;
  if (!isAuthorizationActive(auth, nowMs)) return false;
  if (!matchesServerScope(auth.serverId, request.serverId, request.localServerId)) return false;
  if (!matchesCwdScope(auth, request.cwd)) return false;

  if (auth.scope === "permission") {
    if (!resolvedPerm?.valid) return false;
    if (normalizeToolKey(auth.toolName) !== resolvedPerm.toolKey) return false;
    return normalizePrefixKey(auth.commandPrefix) === resolvedPerm.prefixKey;
  }

  return auth.mode !== null && request.mode === auth.mode;
}

/**
 * Deterministic matcher for standing authorizations.
 * Enforces red-line guard BEFORE rule evaluation so even broad rules can never auto-allow red-line actions.
 */
export function matchStandingAuthorization(
  request: StandingAuthorizationMatchRequest,
  authorizations: readonly MainChatStandingAuthorization[],
  nowMs: number = Date.now(),
): StandingAuthorizationMatchResult {
  if (request.scope === "permission") {
    const redLine = checkRedLineGuard({
      kind: request.kind,
      toolName: request.toolName,
      command: request.command ?? request.commandPrefix,
      question: request.question,
    });
    if (redLine.blocked) {
      return { matched: false, authorization: null, blockedByRedLine: redLine };
    }
  }

  const resolvedPerm =
    request.scope === "permission" ? resolveRequestPermissionPrefix(request) : null;
  if (request.scope === "permission" && !resolvedPerm?.valid) {
    return { matched: false, authorization: null, blockedByRedLine: null };
  }

  for (const auth of authorizations) {
    if (matchesSingleStandingAuthorization(auth, request, nowMs, resolvedPerm)) {
      return { matched: true, authorization: auth, blockedByRedLine: null };
    }
  }

  return { matched: false, authorization: null, blockedByRedLine: null };
}

export function buildStandingAuthorizationLabel(input: {
  scope: MainChatStandingAuthorizationScope;
  toolName?: string | null;
  commandPrefix?: string | null;
  mode?: MainChatTaskMode | null;
  cwd?: string | null;
}): string {
  const dirLabel = input.cwd ? path.basename(normalizeTrustCwd(input.cwd)) || input.cwd : null;
  if (input.scope === "auto_start") {
    const modeText = input.mode === "readonly" ? "只读任务" : "可写任务";
    return dirLabel ? `${dirLabel} 自动开工（${modeText}）` : `自动开工（${modeText}）`;
  }
  const tool = input.toolName?.trim() || "工具";
  const prefix = input.commandPrefix?.trim();
  const base = prefix ? `${tool} (${prefix})` : tool;
  return dirLabel ? `自动放行 ${base} · ${dirLabel}` : `自动放行 ${base}`;
}

export interface ManualApprovalObservation {
  key: string;
  scope: MainChatStandingAuthorizationScope;
  serverId: string | null;
  cwd: string | null;
  toolName: string | null;
  commandPrefix: string | null;
  mode: MainChatTaskMode | null;
  count: number;
  lastObservedAt: string;
}

export interface ManualApprovalObservationInput {
  scope: MainChatStandingAuthorizationScope;
  serverId?: string | null;
  localServerId?: string | null;
  cwd?: string | null;
  toolName?: string | null;
  command?: string | null;
  commandPrefix?: string | null;
  kind?: string | null;
  mode?: MainChatTaskMode | null;
  existingObservation?: ManualApprovalObservation | null;
  existingAuthorizations: readonly MainChatStandingAuthorization[];
  existingSuggestions: readonly MainChatRuleSuggestion[];
  threshold?: number;
  nowIso?: string;
  nowMs?: number;
}

export interface ManualApprovalObservationResult {
  eligible: boolean;
  observationKey: string | null;
  observation: ManualApprovalObservation | null;
  suggestion: MainChatRuleSuggestion | null;
}

export function buildApprovalObservationKey(input: {
  scope: MainChatStandingAuthorizationScope;
  serverId?: string | null;
  cwd?: string | null;
  toolName?: string | null;
  commandPrefix?: string | null;
  mode?: MainChatTaskMode | null;
}): string {
  const normalizedCwd = input.cwd?.trim() ? normalizeTrustCwd(input.cwd) : "";
  return [
    input.scope,
    normalizeOptionalString(input.serverId) ?? "",
    normalizedCwd,
    normalizeToolKey(input.toolName) ?? "",
    normalizePrefixKey(input.commandPrefix) ?? "",
    input.mode ?? "",
  ].join("|");
}

function normalizeObservationPattern(input: ManualApprovalObservationInput): {
  serverId: string | null;
  cwd: string | null;
  toolName: string | null;
  commandPrefix: string | null;
  mode: MainChatTaskMode | null;
} | null {
  const serverId = normalizeOptionalString(input.serverId);
  const cwd = input.cwd?.trim() ? normalizeTrustCwd(input.cwd) : null;

  if (input.scope === "auto_start") {
    if (!cwd || !input.mode) return null;
    return { serverId, cwd, toolName: null, commandPrefix: null, mode: input.mode };
  }

  const redLine = checkRedLineGuard({
    kind: input.kind,
    toolName: input.toolName,
    command: input.command ?? input.commandPrefix,
  });
  if (redLine.blocked) return null;

  const candidate = input.command?.trim()
    ? extractMainChatPermissionRuleCandidate({
        kind: input.kind ?? "tool",
        name: input.toolName,
        input: { command: input.command },
      })
    : extractMainChatPermissionRuleCandidate({
        kind: input.kind ?? "tool",
        name: input.toolName,
        input: input.commandPrefix?.trim() ? { command: input.commandPrefix } : null,
      });
  if (!candidate) return null;

  return {
    serverId,
    cwd,
    toolName: candidate.toolName,
    commandPrefix: normalizePrefixKey(candidate.commandPrefix),
    mode: null,
  };
}

/**
 * Records a manual non-redline user approval observation and emits/updates a progressive
 * `MainChatRuleSuggestion` once observed count reaches `threshold` (default 2) and no active
 * rule or dismissed suggestion already covers the same pattern.
 */
export function recordManualApprovalObservation(
  input: ManualApprovalObservationInput,
): ManualApprovalObservationResult {
  const pattern = normalizeObservationPattern(input);
  if (!pattern) {
    return { eligible: false, observationKey: null, observation: null, suggestion: null };
  }

  const nowMs = input.nowMs ?? Date.now();
  const nowIso = input.nowIso ?? new Date(nowMs).toISOString();
  const threshold = Math.max(1, input.threshold ?? DEFAULT_RULE_SUGGESTION_THRESHOLD);
  const key = buildApprovalObservationKey({ scope: input.scope, ...pattern });

  const alreadyCovered = matchStandingAuthorization(
    {
      scope: input.scope,
      serverId: pattern.serverId,
      localServerId: input.localServerId,
      cwd: pattern.cwd,
      toolName: pattern.toolName,
      commandPrefix: pattern.commandPrefix,
      mode: pattern.mode,
    },
    input.existingAuthorizations,
    nowMs,
  );
  if (alreadyCovered.matched) {
    return { eligible: false, observationKey: key, observation: null, suggestion: null };
  }

  const matchingSuggestion = input.existingSuggestions.find(
    (item) =>
      buildApprovalObservationKey({
        scope: item.scope,
        serverId: item.serverId,
        cwd: item.cwd,
        toolName: item.toolName,
        commandPrefix: item.commandPrefix,
        mode: item.mode,
      }) === key,
  );
  if (matchingSuggestion?.dismissedAt !== null && matchingSuggestion !== undefined) {
    return { eligible: false, observationKey: key, observation: null, suggestion: null };
  }

  const nextCount = (input.existingObservation?.count ?? 0) + 1;
  const observation: ManualApprovalObservation = {
    key,
    scope: input.scope,
    serverId: pattern.serverId,
    cwd: pattern.cwd,
    toolName: pattern.toolName,
    commandPrefix: pattern.commandPrefix,
    mode: pattern.mode,
    count: nextCount,
    lastObservedAt: nowIso,
  };

  if (nextCount < threshold) {
    return { eligible: true, observationKey: key, observation, suggestion: null };
  }

  const label = buildStandingAuthorizationLabel({
    scope: input.scope,
    toolName: pattern.toolName,
    commandPrefix: pattern.commandPrefix,
    mode: pattern.mode,
    cwd: pattern.cwd,
  });
  const suggestion: MainChatRuleSuggestion = {
    id:
      matchingSuggestion?.id ??
      `sug_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`,
    scope: input.scope,
    label,
    reason: `你已连续 ${nextCount} 次手动批准同类安全操作，可转为常驻授权以减少打扰`,
    serverId: pattern.serverId,
    cwd: pattern.cwd,
    toolName: pattern.toolName,
    commandPrefix: pattern.commandPrefix,
    mode: pattern.mode,
    observedCount: nextCount,
    dismissedAt: null,
    createdAt: matchingSuggestion?.createdAt ?? nowIso,
  };

  return { eligible: true, observationKey: key, observation, suggestion };
}

// ============================================================================
// 6. Next-Step Suggestions Builder (with Risk Classification)
// ============================================================================

export interface BuildNextStepSuggestionsInput {
  tasks: readonly MainChatTaskRecord[];
  plans: readonly MainChatPlanRecord[];
  decisions: readonly MainChatDecisionRecord[];
  triages: readonly MainChatSessionTriage[];
  recentReceipts?: readonly MainChatTaskReceipt[];
  pendingClarifications?: readonly MainChatApprovalClarification[];
  maxItems?: number;
}

const SUGGESTION_RISKY_WORDS_RE =
  /\b(push|merge|delete|remove|reset|revert|deploy|release|publish|drop|force|send|apply\s+changes|start\s+write)\b|合并|合入|推送|强推|删除|清空|重置|回滚|发布|上线|部署|外发|发消息|发邮件|派发改动|启动可写|修改代码/i;

export function classifySuggestionRisk(prompt: string, explicitRisky = false): boolean {
  if (explicitRisky) return true;
  if (checkRedLineGuard({ question: prompt }).blocked) return true;
  return SUGGESTION_RISKY_WORDS_RE.test(prompt);
}

function clipLabel(text: string, maxChars = 22): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 1))}…`;
}

function pushUniqueSuggestion(
  list: MainChatNextStepSuggestion[],
  seenKeys: Set<string>,
  item: MainChatNextStepSuggestion,
  maxItems: number,
): void {
  if (list.length >= maxItems) return;
  const dedupeKey = `${item.targetTaskId ?? ""}|${item.targetAgentId ?? ""}|${item.label}`;
  if (seenKeys.has(dedupeKey)) return;
  seenKeys.add(dedupeKey);
  list.push(item);
}

function collectReviewAndPlanSuggestions(
  input: BuildNextStepSuggestionsInput,
  list: MainChatNextStepSuggestion[],
  seenKeys: Set<string>,
  maxItems: number,
): void {
  for (const task of input.tasks) {
    if (task.status !== "awaiting_review") continue;
    const prompt = `请复核任务「${task.title}」的交付结果与验证证据，确认是否满足验收标准。`;
    pushUniqueSuggestion(
      list,
      seenKeys,
      {
        id: `nxt_review_${task.id}`,
        label: `验收「${clipLabel(task.title, 16)}」`,
        prompt,
        risky: classifySuggestionRisk(prompt, false),
        reason: "任务已完工等待验收复核",
        targetAgentId: task.activeAgentId,
        targetTaskId: task.id,
      },
      maxItems,
    );
  }

  for (const plan of input.plans) {
    if (plan.status !== "open") continue;
    const hasWriteTask = plan.tasks.some((task) => task.mode === "write");
    const planName = (plan.summary ?? "").trim() || plan.tasks[0]?.title || plan.id;
    const prompt = hasWriteTask
      ? `请检查待开始计划「${planName}」并确认后派发改动任务。`
      : `请开始执行只读计划「${planName}」。`;
    pushUniqueSuggestion(
      list,
      seenKeys,
      {
        id: `nxt_plan_${plan.id}`,
        label: hasWriteTask
          ? `启动改动计划「${clipLabel(planName, 14)}」`
          : `开始只读「${clipLabel(planName, 14)}」`,
        prompt,
        risky: classifySuggestionRisk(prompt, hasWriteTask),
        reason: hasWriteTask ? "包含写代码任务，请核对后再发送" : "只读分析计划，可安全直接启动",
        targetAgentId: null,
        targetTaskId: plan.tasks[0]?.taskRecordId ?? null,
      },
      maxItems,
    );
  }
}

function collectStalledAndParkedSuggestions(
  input: BuildNextStepSuggestionsInput,
  list: MainChatNextStepSuggestion[],
  seenKeys: Set<string>,
  maxItems: number,
): void {
  for (const triage of input.triages) {
    if (
      triage.phase !== "stalled" &&
      triage.phase !== "no_progress" &&
      triage.phase !== "interrupted"
    ) {
      continue;
    }
    const prompt = `请查看会话「${triage.title}」的最新状态与输出，分析停滞或中断原因并给出推进建议。`;
    pushUniqueSuggestion(
      list,
      seenKeys,
      {
        id: `nxt_triage_${triage.agentId}`,
        label: `排查「${clipLabel(triage.title, 16)}」`,
        prompt,
        risky: classifySuggestionRisk(prompt, false),
        reason: triage.summary,
        targetAgentId: triage.agentId,
        targetTaskId: null,
      },
      maxItems,
    );
  }

  for (const task of input.tasks) {
    if (task.status !== "parked") continue;
    const prompt = `请评估搁置任务「${task.title}」的前置条件是否解除，并汇报是否适合恢复推进。`;
    pushUniqueSuggestion(
      list,
      seenKeys,
      {
        id: `nxt_parked_${task.id}`,
        label: `跟进搁置「${clipLabel(task.title, 14)}」`,
        prompt,
        risky: classifySuggestionRisk(prompt, false),
        reason: task.parkedReason ?? "任务当前处于搁置态",
        targetAgentId: task.activeAgentId,
        targetTaskId: task.id,
      },
      maxItems,
    );
  }
}

function collectDecisionAndReceiptSuggestions(
  input: BuildNextStepSuggestionsInput,
  list: MainChatNextStepSuggestion[],
  seenKeys: Set<string>,
  maxItems: number,
): void {
  for (const decision of input.decisions) {
    if (decision.answeredAt !== null) continue;
    const prompt = `请梳理待拍板项「${decision.title}」各选项利弊，并说明推荐方案。`;
    pushUniqueSuggestion(
      list,
      seenKeys,
      {
        id: `nxt_dec_${decision.id}`,
        label: `梳理拍板「${clipLabel(decision.title, 14)}」`,
        prompt,
        risky: classifySuggestionRisk(prompt, false),
        reason: decision.question.slice(0, 80),
        targetAgentId: decision.agentId,
        targetTaskId: decision.taskId,
      },
      maxItems,
    );
  }

  for (const receipt of input.recentReceipts ?? []) {
    const firstStep = receipt.nextSteps.find((step) => step.trim().length > 0)?.trim();
    if (!firstStep) continue;
    const risky = classifySuggestionRisk(firstStep, false);
    const prompt = `针对已完成任务「${receipt.title}」，下一步：${firstStep}`;
    pushUniqueSuggestion(
      list,
      seenKeys,
      {
        id: `nxt_rcpt_${receipt.taskId ?? receipt.agentId ?? receipt.title}`,
        label: clipLabel(firstStep, 20),
        prompt,
        risky,
        reason: risky ? "涉及高风险后续动作，仅填入输入框供确认" : "已完成任务的建议后续动作",
        targetAgentId: receipt.agentId,
        targetTaskId: receipt.taskId,
      },
      maxItems,
    );
  }
}

/**
 * Generates up to 4 compact next-step suggestions from live overview state.
 * Safe read/review items carry `risky: false`; merge/push/delete/write-dispatch items carry `risky: true`.
 */
export function buildNextStepSuggestions(
  input: BuildNextStepSuggestionsInput,
): MainChatNextStepSuggestion[] {
  const maxItems = Math.max(0, Math.min(input.maxItems ?? MAX_NEXT_STEP_SUGGESTIONS, 4));
  if (maxItems === 0) return [];

  const list: MainChatNextStepSuggestion[] = [];
  const seenKeys = new Set<string>();

  collectReviewAndPlanSuggestions(input, list, seenKeys, maxItems);
  collectStalledAndParkedSuggestions(input, list, seenKeys, maxItems);
  collectDecisionAndReceiptSuggestions(input, list, seenKeys, maxItems);

  return list;
}
