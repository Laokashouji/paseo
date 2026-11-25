import crypto from "node:crypto";
import { z } from "zod";
import {
  MainChatRuleDiagnosticSchema,
  type MainChatRuleDiagnostic,
  type MainChatSessionPhase,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import { isNoProgressToolCall, isSubstantiveProgressToolCall } from "./triage.js";

const MAX_CALL_WINDOW_PER_AGENT = 24;
const MAX_PERSISTED_AGENT_WINDOWS = 120;
const EXACT_REPEAT_THRESHOLD = 4;
const ALTERNATING_CYCLES_THRESHOLD = 3;
const REPEATED_ERROR_THRESHOLD = 3;
const SLOW_POLLING_GAP_MS = 30_000;

export const PersistedZeroTokenToolEntrySchema = z.object({
  callId: z.string().nullable().optional(),
  tool: z.string(),
  inputHash: z.string(),
  errorSig: z.string().nullable(),
  errorExcerpt: z.string().nullable(),
  isError: z.boolean(),
  isWrite: z.boolean(),
  isVerify: z.boolean(),
  isRead: z.boolean(),
  isPolling: z.boolean(),
  atMs: z.number().int().nonnegative(),
});
export type PersistedZeroTokenToolEntry = z.infer<typeof PersistedZeroTokenToolEntrySchema>;

export const PersistedZeroTokenAgentWindowSchema = z.object({
  calls: z.array(PersistedZeroTokenToolEntrySchema),
  hadWriteInTurn: z.boolean(),
  hadVerifyAfterWrite: z.boolean(),
  hadReadInTurn: z.boolean(),
  turnStartedAtMs: z.number().int().nonnegative().nullable(),
  lastReportedLoopKey: z.string().nullable(),
  lastDiagnostic: MainChatRuleDiagnosticSchema.nullable(),
  updatedAtMs: z.number().int().nonnegative(),
});
export type PersistedZeroTokenAgentWindow = z.infer<typeof PersistedZeroTokenAgentWindowSchema>;

const WRITE_TOOL_RE =
  /\b(write|edit|patch|notebook_edit|create_file|delete_file|replace_file|multi_edit|str_replace|apply_patch)\b/i;
const READ_TOOL_RE = /\b(read|grep|glob|search|find|list|inspect|view|get_file|cat|ls)\b/i;
const SHELL_TOOL_RE = /\b(bash|shell|exec|terminal|command|run)\b/i;
const VERIFY_CMD_RE =
  /\b(vitest|jest|pytest|mocha|cargo\s+test|go\s+test|npm\s+(?:run\s+)?(?:test|typecheck|lint|build|check|format:check)|tsc|tsgo|oxlint|eslint|biome|playwright|maestro)\b/i;
const SHELL_WRITE_RE =
  /(?:>>?|tee\s|sed\s+-i|perl\s+-i|mv\s|cp\s|rm\s|mkdir\s|touch\s|git\s+(?:apply|commit|checkout|merge|rebase))/i;

const PLEASANTRY_ONLY_PATTERNS = [
  /^(?:好(?:的|嘞|呀|吧)?|收到(?:了)?|明白(?:了)?|了解(?:了)?|知道(?:了)?|行(?:的)?|没问题|可以|嗯(?:嗯)?|已读|已收到|正在(?:看|处理|排查|查看)|我(?:先)?看(?:一下|看)|我(?:来|马上去)?(?:查|看|处理)(?:一下)?|稍等(?:一下)?|马上处理)[！!。.~～，,\s]*$/i,
  /^(?:ok(?:ay)?|sure|got\s+it|understood|roger|noted|ack(?:nowledged)?|thanks|thank\s+you|will\s+do|on\s+it|checking(?:\s+now)?|looking\s+into\s+(?:it|this)|let\s+me\s+(?:check|take\s+a\s+look|look\s+into\s+(?:it|this))|i(?:'ll| will)\s+(?:check|take\s+a\s+look|look\s+into\s+(?:it|this)))[!.\s,~]*$/i,
];

const SUBSTANTIVE_ANSWER_HINTS =
  /```|\/[\w.-]+\/[\w.-]+|\b(?:fixed|completed|resolved|passed|failed|updated|implemented|verified|tests?\s+pass|typecheck|lint|build|pr\s*#\d+)\b|已完成|已修复|已修改|已更新|已实现|已验证|测试通过|结论如下|原因如下|排查结果|改动如下/i;

const VERIFICATION_EVIDENCE_RE =
  /\b(test(?:s|ed|ing)?|vitest|jest|pytest|typecheck|tsc|tsgo|lint|oxlint|eslint|build|compiled|verified|verification|screenshot|playwright|passed|pass(?:ing)?|0\s+errors?|0\s+warnings?|exit\s+code\s+0)\b|测试|单测|验证|构建|类型检查|截图|通过|全绿|复核|回归|已核验|检查通过|输出如下|证据/i;

const WRAP_UP_SUMMARY_STUB_RE =
  /^(?:改好了|好了|搞定|完成了|已修改|已更新|done|fixed|updated|finished|all\s+set|ready)[！!。.~～\s]*$/i;

function stableHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

const TOOL_OUTPUT_ONLY_KEYS = new Set([
  "output",
  "result",
  "stdout",
  "stderr",
  "filePaths",
  "webResults",
  "annotations",
  "numFiles",
  "numMatches",
  "durationMs",
  "durationSeconds",
  "truncated",
  "exitCode",
  "code",
  "codeText",
  "bytes",
  "log",
  "actions",
  "unifiedDiff",
  "status",
  "error",
  "timestamp",
  "atMs",
  "icon",
]);

const DETAIL_META_ONLY_KEYS = new Set(["type", "toolName"]);

const ARGUMENT_TEXT_KEYS = [
  "command",
  "cmd",
  "filePath",
  "file_path",
  "path",
  "target_file",
  "pattern",
  "query",
  "glob",
  "regex",
  "url",
  "uri",
  "description",
  "text",
] as const;

function tryParseJsonRecord(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

const NESTED_ARG_CONTAINER_KEYS = new Set(["input", "arguments", "args", "params"]);

function shouldSkipArgKey(key: string, detailType: string, depth: number): boolean {
  if (TOOL_OUTPUT_ONLY_KEYS.has(key)) return true;
  if (key === "content" && (detailType === "read" || detailType === "search")) return true;
  return depth === 0 && DETAIL_META_ONLY_KEYS.has(key);
}

function normalizeArgRecord(record: Record<string, unknown>, depth: number): unknown {
  const detailType = typeof record.type === "string" ? record.type.toLowerCase() : "";
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (shouldSkipArgKey(key, detailType, depth)) continue;
    const raw = NESTED_ARG_CONTAINER_KEYS.has(key) ? tryParseJsonRecord(record[key]) : record[key];
    const norm = normalizeArgValue(raw, depth + 1);
    if (norm !== undefined) {
      out[key] = norm;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeArgValue(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[max-depth]";
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.length > 2000 ? `${trimmed.slice(0, 1000)}…${trimmed.slice(-500)}` : trimmed;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 50)
      .map((item) => normalizeArgValue(item, depth + 1))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === "object") {
    return normalizeArgRecord(value as Record<string, unknown>, depth);
  }
  return String(value);
}

export function canonicalizeDetailForHash(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  const parsed = tryParseJsonRecord(detail);
  const normalized = normalizeArgValue(parsed, 0);
  if (normalized === undefined) return "";
  if (typeof normalized === "string") return normalized;
  try {
    return JSON.stringify(normalized);
  } catch {
    return String(detail).slice(0, 1000);
  }
}

function extractTextFromArgRecord(record: Record<string, unknown>): string {
  for (const key of ARGUMENT_TEXT_KEYS) {
    const val = record[key];
    if (typeof val === "string" && val.trim().length > 0) {
      return val.trim();
    }
  }
  return "";
}

function extractDetailText(detail: unknown): string {
  if (!detail) return "";
  const parsed = tryParseJsonRecord(detail);
  if (typeof parsed === "string") return parsed.trim();
  if (typeof parsed !== "object" || parsed === null) return "";
  const record = parsed as Record<string, unknown>;
  const direct = extractTextFromArgRecord(record);
  if (direct) return direct;
  for (const nestedKey of ["input", "arguments", "args", "params"] as const) {
    const nested = tryParseJsonRecord(record[nestedKey]);
    if (typeof nested === "string" && nested.trim().length > 0) {
      return nested.trim();
    }
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      const fromNested = extractTextFromArgRecord(nested as Record<string, unknown>);
      if (fromNested) return fromNested;
    }
  }
  return "";
}

export function extractErrorExcerpt(error: unknown): string | null {
  if (error === null || error === undefined) return null;
  let raw = "";
  if (typeof error === "string") {
    raw = error;
  } else if (error instanceof Error) {
    raw = error.message;
  } else if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string") raw = record.message;
    else if (typeof record.error === "string") raw = record.error;
    else {
      try {
        raw = JSON.stringify(error);
      } catch {
        raw = String(error);
      }
    }
  } else {
    raw = String(error);
  }
  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) return null;
  return compact.length > 120 ? `${compact.slice(0, 119)}…` : compact;
}

export function normalizeErrorSignature(errorExcerpt: string | null): string | null {
  if (!errorExcerpt) return null;
  const normalized = errorExcerpt
    .toLowerCase()
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27}\b/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g, "<ts>")
    .replace(/\b\d{4,}\b/g, "<num>")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return null;
  return stableHash(normalized);
}

function classifyToolAction(
  toolName: string,
  detailText: string,
): {
  isWrite: boolean;
  isVerify: boolean;
  isRead: boolean;
  isPolling: boolean;
} {
  const lowerTool = toolName.trim().toLowerCase();
  const isShell = SHELL_TOOL_RE.test(lowerTool);
  const isVerify = isShell && VERIFY_CMD_RE.test(detailText);
  const isWrite =
    WRITE_TOOL_RE.test(lowerTool) ||
    (isShell && SHELL_WRITE_RE.test(detailText) && !isVerify) ||
    (!isShell && isSubstantiveProgressToolCall(toolName, detailText));
  const isRead = READ_TOOL_RE.test(lowerTool);
  const isPolling = isNoProgressToolCall(toolName, detailText);
  return { isWrite, isVerify, isRead, isPolling };
}

/**
 * Zero-token Detector #1: Read-Without-Reply (`read_without_reply`).
 * Identifies turns where the session read an instruction/context yet finished with empty text
 * or only a brief pleasantry/acknowledgement without any substantive answer or result.
 */
export function detectReadWithoutReply(input: {
  replyText: string;
  hadReadOrInspectTool?: boolean;
  hadWriteTool?: boolean;
  hasExplicitQuestion?: boolean;
  nowIso: string;
}): MainChatRuleDiagnostic | null {
  if (input.hasExplicitQuestion) return null;
  const trimmed = input.replyText.trim();

  if (trimmed.length === 0) {
    return {
      kind: "read_without_reply",
      severity: "warning",
      summary: input.hadReadOrInspectTool
        ? "已读未回：已读取上下文但本轮结束时未产出文本答复"
        : "已读未回：本轮结束时未产出任何实质文本答复",
      detail: input.hadReadOrInspectTool
        ? "会话执行了只读查看/检索工具，但最终未向用户输出结论或后续动作。"
        : "会话已结束本轮，但输出为空，可能未完成作答或提前静默退出。",
      detectedAt: input.nowIso,
      toolName: null,
      repeatCount: null,
      pattern: null,
      errorExcerpt: null,
    };
  }

  // Never flag replies containing real technical answers, paths, code blocks, or concrete outcomes.
  if (SUBSTANTIVE_ANSWER_HINTS.test(trimmed)) {
    return null;
  }
  if (trimmed.length > 60) {
    return null;
  }
  if (/[？?]\s*$/.test(trimmed)) {
    return null;
  }

  const singleLine = trimmed.replace(/\s+/g, " ");
  const clauses = singleLine
    .split(/[,，、;；。.!！~～]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const isPleasantryOnly =
    PLEASANTRY_ONLY_PATTERNS.some((pattern) => pattern.test(singleLine)) ||
    (clauses.length > 0 &&
      clauses.length <= 3 &&
      clauses.every((clause) => PLEASANTRY_ONLY_PATTERNS.some((pattern) => pattern.test(clause))));
  if (!isPleasantryOnly) {
    return null;
  }

  return {
    kind: "read_without_reply",
    severity: "warning",
    summary: `已读未回：仅回复「${singleLine.slice(0, 24)}」，未给出实质答复`,
    detail: input.hadWriteTool
      ? "仅输出简短寒暄/确认语，未交代改动内容或结果。"
      : "仅输出简短寒暄/确认语便结束本轮，未产出结论、排查结果或可执行回复。",
    detectedAt: input.nowIso,
    toolName: null,
    repeatCount: null,
    pattern: null,
    errorExcerpt: null,
  };
}

/**
 * Zero-token Detector #2: Missing Wrap-Up (`missing_wrap_up`).
 * Identifies turns where substantive write modifications happened, yet the final reply lacks
 * verification evidence, summary, or `doneWhen` closeout confirmation.
 */
export function detectMissingWrapUp(input: {
  replyText: string;
  hadWriteInTurn: boolean;
  hadVerifyAfterWrite: boolean;
  phase?: MainChatSessionPhase;
  task?: Pick<MainChatTaskRecord, "mode" | "brief"> | null;
  nowIso: string;
}): MainChatRuleDiagnostic | null {
  if (!input.hadWriteInTurn) return null;
  if (input.phase === "blocked_user" || input.phase === "blocked_external") return null;

  const trimmed = input.replyText.trim();
  if (!trimmed) return null;

  const hasVerificationMention = VERIFICATION_EVIDENCE_RE.test(trimmed);
  const isStubReply = WRAP_UP_SUMMARY_STUB_RE.test(trimmed) || trimmed.length < 28;
  const doneWhenItems = input.task?.brief?.doneWhen ?? [];

  const missingItems: string[] = [];
  if (!input.hadVerifyAfterWrite && !hasVerificationMention) {
    missingItems.push("缺少写入后的验证证据（单测 / typecheck / lint / 运行结果）");
  }
  if (isStubReply) {
    missingItems.push("缺少清晰的改动总结与收尾说明");
  }
  if (
    doneWhenItems.length > 0 &&
    !hasVerificationMention &&
    (!input.hadVerifyAfterWrite || isStubReply)
  ) {
    for (const criterion of doneWhenItems.slice(0, 2)) {
      missingItems.push(`未逐条交代验收项：${criterion.slice(0, 60)}`);
    }
  }

  if (missingItems.length === 0) {
    return null;
  }

  return {
    kind: "missing_wrap_up",
    severity: "warning",
    summary:
      !input.hadVerifyAfterWrite && !hasVerificationMention
        ? "漏收尾：已产生写入改动但缺少验证证据与收尾总结"
        : "漏收尾：写入后收尾总结过简，未完整交代验收情况",
    detail: missingItems.join("；"),
    detectedAt: input.nowIso,
    toolName: null,
    repeatCount: null,
    pattern: null,
    errorExcerpt: null,
    missingItems,
  };
}

function isSlowPollingGap(
  prev: PersistedZeroTokenToolEntry,
  next: PersistedZeroTokenToolEntry,
): boolean {
  const delta = next.atMs - prev.atMs;
  if (delta < 0) return false;
  return (prev.isPolling || next.isPolling) && delta >= SLOW_POLLING_GAP_MS;
}

function sameCallSignature(
  left: PersistedZeroTokenToolEntry,
  right: PersistedZeroTokenToolEntry,
): boolean {
  // Missing / unpopulated tool arguments must never match as identical-parameter repeats.
  if (!left.inputHash || !right.inputHash) return false;
  return left.tool === right.tool && left.inputHash === right.inputHash;
}

/**
 * Zero-token Detector #3: Tool Loop (`tool_loop`).
 * Detects:
 * 1. `repeated_error`: >= 3 consecutive tool calls failing with the same normalized error signature.
 * 2. `exact_repeat`: >= 4 consecutive identical tool + canonicalized input calls (excluding slow polling).
 * 3. `alternating_ab`: period-2 or period-3 alternating loops (e.g. A-B-A-B-A-B, >= 3 full cycles).
 */
function detectRepeatedErrorLoop(
  calls: readonly PersistedZeroTokenToolEntry[],
  last: PersistedZeroTokenToolEntry,
  nowIso: string,
): { diagnostic: MainChatRuleDiagnostic; loopKey: string } | null {
  if (!last.isError || !last.errorSig) return null;
  let errorCount = 1;
  for (let i = calls.length - 2; i >= 0; i -= 1) {
    const prev = calls[i]!;
    const next = calls[i + 1]!;
    if (isSlowPollingGap(prev, next)) break;
    if (prev.isError && prev.errorSig === last.errorSig) {
      errorCount += 1;
    } else {
      break;
    }
  }
  if (errorCount < REPEATED_ERROR_THRESHOLD) return null;
  const excerpt = last.errorExcerpt ?? "相同错误重复出现";
  return {
    loopKey: `repeated_error:${last.tool}:${last.errorSig}`,
    diagnostic: {
      kind: "tool_loop",
      severity: "critical",
      summary: `工具循环：${last.tool} 连续 ${errorCount} 次触发相同报错`,
      detail: `报错摘录：${excerpt}`,
      detectedAt: nowIso,
      toolName: last.tool,
      repeatCount: errorCount,
      pattern: "repeated_error",
      errorExcerpt: excerpt,
    },
  };
}

function detectExactRepeatLoop(
  calls: readonly PersistedZeroTokenToolEntry[],
  last: PersistedZeroTokenToolEntry,
  nowIso: string,
): { diagnostic: MainChatRuleDiagnostic; loopKey: string } | null {
  if (last.isPolling) return null;
  let exactCount = 1;
  for (let i = calls.length - 2; i >= 0; i -= 1) {
    const prev = calls[i]!;
    const next = calls[i + 1]!;
    if (prev.isPolling || isSlowPollingGap(prev, next)) break;
    if (sameCallSignature(prev, last)) {
      exactCount += 1;
    } else {
      break;
    }
  }
  if (exactCount < EXACT_REPEAT_THRESHOLD) return null;
  return {
    loopKey: `exact_repeat:${last.tool}:${last.inputHash}`,
    diagnostic: {
      kind: "tool_loop",
      severity: "critical",
      summary: `工具循环：连续 ${exactCount} 次重复调用 ${last.tool}（相同参数）`,
      detail: last.errorExcerpt
        ? `工具 ${last.tool} 参数完全一致重复 ${exactCount} 次；最近报错：${last.errorExcerpt}`
        : `工具 ${last.tool} 使用相同参数连续重复调用 ${exactCount} 次，疑似陷入无进展死循环。`,
      detectedAt: nowIso,
      toolName: last.tool,
      repeatCount: exactCount,
      pattern: "exact_repeat",
      errorExcerpt: last.errorExcerpt,
    },
  };
}

function detectAlternatingLoop(
  calls: readonly PersistedZeroTokenToolEntry[],
  last: PersistedZeroTokenToolEntry,
  nowIso: string,
): { diagnostic: MainChatRuleDiagnostic; loopKey: string } | null {
  for (const period of [2, 3] as const) {
    const minLen = period * ALTERNATING_CYCLES_THRESHOLD;
    if (calls.length < minLen) continue;
    let matched = 0;
    let blockedByPolling = false;
    for (let offset = 0; offset < calls.length; offset += 1) {
      const idx = calls.length - 1 - offset;
      const entry = calls[idx]!;
      if (entry.isPolling) {
        blockedByPolling = true;
        break;
      }
      if (idx + 1 < calls.length && isSlowPollingGap(entry, calls[idx + 1]!)) {
        break;
      }
      const refEntry = calls[calls.length - 1 - (offset % period)]!;
      if (!sameCallSignature(entry, refEntry)) {
        break;
      }
      matched += 1;
    }
    if (blockedByPolling || matched < minLen) continue;

    const cycleEntries = calls.slice(calls.length - period);
    const distinctKeys = new Set(cycleEntries.map((entry) => `${entry.tool}:${entry.inputHash}`));
    if (distinctKeys.size < 2) continue;

    const toolChain = cycleEntries.map((entry) => entry.tool).join(" ↔ ");
    const cycles = Math.floor(matched / period);
    const cycleKey = cycleEntries.map((entry) => `${entry.tool}:${entry.inputHash}`).join("|");
    return {
      loopKey: `alternating:${period}:${stableHash(cycleKey)}`,
      diagnostic: {
        kind: "tool_loop",
        severity: "critical",
        summary: `工具循环：${toolChain} 交替重复 ${cycles} 轮（共 ${matched} 次）`,
        detail: `检测到 ${toolChain} 按固定周期交替死循环，疑似未取得实质进展。`,
        detectedAt: nowIso,
        toolName: toolChain,
        repeatCount: matched,
        pattern: "alternating_ab",
        errorExcerpt: last.errorExcerpt,
      },
    };
  }
  return null;
}

export function detectToolLoopFromCalls(
  calls: readonly PersistedZeroTokenToolEntry[],
  nowIso: string,
): { diagnostic: MainChatRuleDiagnostic; loopKey: string } | null {
  if (calls.length === 0) return null;
  const last = calls[calls.length - 1]!;
  return (
    detectRepeatedErrorLoop(calls, last, nowIso) ??
    detectExactRepeatLoop(calls, last, nowIso) ??
    detectAlternatingLoop(calls, last, nowIso)
  );
}

export interface ZeroTokenToolEventInput {
  callId?: string | null;
  toolName: string;
  detail: unknown;
  status?: "running" | "completed" | "failed" | "canceled";
  error?: unknown;
  nowMs: number;
}

export interface ZeroTokenRuleWindowManager {
  recordTurnStarted(agentId: string, nowMs: number): void;
  recordToolEvent(
    agentId: string,
    event: ZeroTokenToolEventInput,
  ): {
    diagnostic: MainChatRuleDiagnostic | null;
    isNewTrigger: boolean;
    changed: boolean;
  };
  evaluateCompletedTurn(
    agentId: string,
    input: {
      replyText: string;
      phase: MainChatSessionPhase;
      task?: Pick<MainChatTaskRecord, "mode" | "brief"> | null;
      nowMs: number;
    },
  ): {
    diagnostic: MainChatRuleDiagnostic | null;
    changed: boolean;
  };
  getWindow(agentId: string): PersistedZeroTokenAgentWindow | null;
  clearAgent(agentId: string): boolean;
  exportState(): Record<string, PersistedZeroTokenAgentWindow>;
}

function createEmptyWindow(nowMs: number): PersistedZeroTokenAgentWindow {
  return {
    calls: [],
    hadWriteInTurn: false,
    hadVerifyAfterWrite: false,
    hadReadInTurn: false,
    turnStartedAtMs: nowMs,
    lastReportedLoopKey: null,
    lastDiagnostic: null,
    updatedAtMs: nowMs,
  };
}

/**
 * Stateful zero-token detector window manager with JSON-serializable state so restarts never lose
 * in-progress tool-loop history, write-without-wrapup flags, or alert deduplication markers.
 */
export function createZeroTokenRuleWindowManager(
  initialState?: Record<string, PersistedZeroTokenAgentWindow> | null,
): ZeroTokenRuleWindowManager {
  const windows = new Map<string, PersistedZeroTokenAgentWindow>();
  if (initialState) {
    for (const [agentId, win] of Object.entries(initialState)) {
      if (!agentId.trim()) continue;
      windows.set(agentId, {
        ...win,
        calls: [...win.calls].slice(-MAX_CALL_WINDOW_PER_AGENT),
      });
    }
  }

  function pruneOldWindows(): void {
    if (windows.size <= MAX_PERSISTED_AGENT_WINDOWS) return;
    const entries = Array.from(windows.entries()).sort(
      (left, right) => right[1].updatedAtMs - left[1].updatedAtMs,
    );
    windows.clear();
    for (const [id, win] of entries.slice(0, MAX_PERSISTED_AGENT_WINDOWS)) {
      windows.set(id, win);
    }
  }

  function appendOrUpdateCallEntry(
    win: PersistedZeroTokenAgentWindow,
    entry: PersistedZeroTokenToolEntry,
  ): void {
    const existingIdx = entry.callId
      ? win.calls.findIndex((item) => item.callId === entry.callId)
      : -1;
    if (existingIdx >= 0) {
      const existing = win.calls[existingIdx]!;
      win.calls[existingIdx] = {
        ...existing,
        tool: entry.tool && entry.tool !== "tool" ? entry.tool : existing.tool,
        inputHash: entry.inputHash || existing.inputHash,
        isError: existing.isError || entry.isError,
        errorExcerpt: entry.errorExcerpt ?? existing.errorExcerpt,
        errorSig: entry.errorSig ?? existing.errorSig,
        isWrite: existing.isWrite || entry.isWrite,
        isVerify: existing.isVerify || entry.isVerify,
        isRead: existing.isRead || entry.isRead,
        isPolling: entry.inputHash ? entry.isPolling : existing.isPolling || entry.isPolling,
      };
      return;
    }
    win.calls.push(entry);
    if (win.calls.length > MAX_CALL_WINDOW_PER_AGENT) {
      win.calls = win.calls.slice(-MAX_CALL_WINDOW_PER_AGENT);
    }
  }

  return {
    recordTurnStarted(agentId, nowMs) {
      const next = createEmptyWindow(nowMs);
      windows.set(agentId, next);
      pruneOldWindows();
    },

    recordToolEvent(agentId, event) {
      const win = windows.get(agentId) ?? createEmptyWindow(event.nowMs);
      windows.set(agentId, win);

      const detailText = extractDetailText(event.detail);
      const canonicalInput = canonicalizeDetailForHash(event.detail) || detailText;
      const inputHash = canonicalInput ? stableHash(canonicalInput) : "";
      const action = classifyToolAction(event.toolName, detailText);
      const isError = event.status === "failed" || Boolean(event.error);
      const errorExcerpt = isError ? extractErrorExcerpt(event.error) : null;
      const errorSig = isError ? normalizeErrorSignature(errorExcerpt) : null;

      if (action.isWrite) {
        win.hadWriteInTurn = true;
        win.hadVerifyAfterWrite = false;
      } else if (action.isVerify && win.hadWriteInTurn && !isError) {
        win.hadVerifyAfterWrite = true;
      }
      if (action.isRead) {
        win.hadReadInTurn = true;
      }

      appendOrUpdateCallEntry(win, {
        callId: event.callId?.trim() || null,
        tool: event.toolName.trim() || "tool",
        inputHash,
        errorSig,
        errorExcerpt,
        isError,
        isWrite: action.isWrite,
        isVerify: action.isVerify,
        isRead: action.isRead,
        isPolling: action.isPolling,
        atMs: event.nowMs,
      });

      win.updatedAtMs = event.nowMs;
      pruneOldWindows();

      const nowIso = new Date(event.nowMs).toISOString();
      const detected = detectToolLoopFromCalls(win.calls, nowIso);
      if (!detected) {
        return { diagnostic: null, isNewTrigger: false, changed: true };
      }

      const isNewTrigger = win.lastReportedLoopKey !== detected.loopKey;
      win.lastReportedLoopKey = detected.loopKey;
      win.lastDiagnostic = detected.diagnostic;
      return { diagnostic: detected.diagnostic, isNewTrigger, changed: true };
    },

    evaluateCompletedTurn(agentId, input) {
      const win = windows.get(agentId) ?? createEmptyWindow(input.nowMs);
      const nowIso = new Date(input.nowMs).toISOString();

      const readWithoutReply = detectReadWithoutReply({
        replyText: input.replyText,
        hadReadOrInspectTool: win.hadReadInTurn,
        hadWriteTool: win.hadWriteInTurn,
        hasExplicitQuestion: input.phase === "blocked_user",
        nowIso,
      });
      if (readWithoutReply) {
        win.lastDiagnostic = readWithoutReply;
        win.updatedAtMs = input.nowMs;
        windows.set(agentId, win);
        return { diagnostic: readWithoutReply, changed: true };
      }

      const missingWrapUp = detectMissingWrapUp({
        replyText: input.replyText,
        hadWriteInTurn: win.hadWriteInTurn,
        hadVerifyAfterWrite: win.hadVerifyAfterWrite,
        phase: input.phase,
        task: input.task,
        nowIso,
      });
      if (missingWrapUp) {
        win.lastDiagnostic = missingWrapUp;
        win.updatedAtMs = input.nowMs;
        windows.set(agentId, win);
        return { diagnostic: missingWrapUp, changed: true };
      }

      // Clean completed turn clears prior diagnostic state for this agent window.
      win.lastDiagnostic = null;
      win.updatedAtMs = input.nowMs;
      windows.set(agentId, win);
      return { diagnostic: null, changed: true };
    },

    getWindow(agentId) {
      return windows.get(agentId) ?? null;
    },

    clearAgent(agentId) {
      return windows.delete(agentId);
    },

    exportState() {
      const out: Record<string, PersistedZeroTokenAgentWindow> = {};
      for (const [agentId, win] of windows) {
        out[agentId] = {
          ...win,
          calls: [...win.calls],
        };
      }
      return out;
    },
  };
}
