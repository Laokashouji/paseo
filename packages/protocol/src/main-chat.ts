import { z } from "zod";
import type { AgentLabelSource } from "./agent-labels.js";

export const MAIN_CHAT_ROLE_LABEL = "paseo.role";
export const MAIN_CHAT_ROLE_VALUE = "main";
export const MAIN_CHAT_TASK_PLAN_ID_LABEL = "paseo.main-chat.plan-id";
export const MAIN_CHAT_TASK_ID_LABEL = "paseo.main-chat.task-id";
export const MAIN_CHAT_TASK_MODE_LABEL = "paseo.main-chat.mode";
export const MAIN_CHAT_TASK_GOAL_LABEL = "paseo.main-chat.goal";
export const MAIN_CHAT_WORKSPACE_DIR_NAME = "main-chat";
export const MAIN_CHAT_DEFAULT_TITLE = "主对话";

export const MainChatTaskModeSchema = z.enum(["readonly", "write"]);
export type MainChatTaskMode = z.infer<typeof MainChatTaskModeSchema>;

export const MainChatTaskIsolationSchema = z.enum(["local", "worktree"]);
export type MainChatTaskIsolation = z.infer<typeof MainChatTaskIsolationSchema>;

export const MainChatPlanStatusSchema = z.enum(["open", "started", "cancelled"]);
export type MainChatPlanStatus = z.infer<typeof MainChatPlanStatusSchema>;

export const MainChatPlannedTaskSchema = z.object({
  id: z.string(),
  title: z.string(),
  goal: z.string(),
  mode: MainChatTaskModeSchema,
  isolation: MainChatTaskIsolationSchema,
  cwd: z.string().nullable(),
  workspaceId: z.string().nullable(),
  workspaceLabel: z.string(),
  reason: z.string(),
  doneWhen: z.array(z.string()),
  outOfBounds: z.array(z.string()),
  provider: z.string().nullable(),
  modeId: z.string().nullable(),
  thinkingOptionId: z.string().nullable(),
  branchName: z.string().nullable(),
  baseBranch: z.string().nullable(),
  agentId: z.string().nullable(),
  startedAt: z.string().nullable(),
  startError: z.string().nullable(),
});
export type MainChatPlannedTask = z.infer<typeof MainChatPlannedTaskSchema>;

export const MainChatPlanRecordSchema = z.object({
  id: z.string(),
  mainAgentId: z.string(),
  status: MainChatPlanStatusSchema,
  autoStarted: z.boolean(),
  summary: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  tasks: z.array(MainChatPlannedTaskSchema),
});
export type MainChatPlanRecord = z.infer<typeof MainChatPlanRecordSchema>;

export const MainChatReceiptCheckSchema = z.object({
  criterion: z.string(),
  met: z.boolean(),
  evidence: z.string(),
});
export type MainChatReceiptCheck = z.infer<typeof MainChatReceiptCheckSchema>;

export const MainChatTaskReceiptSchema = z.object({
  title: z.string(),
  summary: z.string(),
  agentId: z.string().nullable(),
  planId: z.string().nullable(),
  taskId: z.string().nullable(),
  checks: z.array(MainChatReceiptCheckSchema),
  nextSteps: z.array(z.string()),
});
export type MainChatTaskReceipt = z.infer<typeof MainChatTaskReceiptSchema>;

export const MainChatReworkRecordSchema = z.object({
  title: z.string(),
  agentId: z.string(),
  planId: z.string().nullable(),
  taskId: z.string().nullable(),
  round: z.number().int().positive(),
  maxRounds: z.number().int().positive(),
  gaps: z.array(z.string()),
  note: z.string().nullable(),
});
export type MainChatReworkRecord = z.infer<typeof MainChatReworkRecordSchema>;

export const MainChatDecisionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  leadsTo: z.string(),
});
export type MainChatDecisionOption = z.infer<typeof MainChatDecisionOptionSchema>;

export const MainChatDecisionRecordSchema = z.object({
  id: z.string(),
  mainAgentId: z.string(),
  title: z.string(),
  question: z.string(),
  agentId: z.string().nullable(),
  planId: z.string().nullable(),
  taskId: z.string().nullable(),
  options: z.array(MainChatDecisionOptionSchema),
  recommendedOptionId: z.string().nullable(),
  reason: z.string().nullable(),
  answer: z.string().nullable(),
  answeredOptionId: z.string().nullable(),
  answeredAt: z.string().nullable(),
  createdAt: z.string(),
});
export type MainChatDecisionRecord = z.infer<typeof MainChatDecisionRecordSchema>;

export const MainChatAutoStartRuleSchema = z.object({
  id: z.string(),
  cwd: z.string(),
  mode: MainChatTaskModeSchema,
  createdAt: z.string(),
});
export type MainChatAutoStartRule = z.infer<typeof MainChatAutoStartRuleSchema>;

export const MainChatPermissionRuleSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  commandPrefix: z.string().nullable(),
  cwd: z.string().nullable(),
  createdAt: z.string(),
});
export type MainChatPermissionRule = z.infer<typeof MainChatPermissionRuleSchema>;

export const MainChatRuleKindSchema = z.enum(["auto_start", "permission"]);
export type MainChatRuleKind = z.infer<typeof MainChatRuleKindSchema>;

export const MainChatMetricsSchema = z.object({
  autoContinued: z.number().int().nonnegative(),
  plansCreated: z.number().int().nonnegative(),
  plansAutoStarted: z.number().int().nonnegative(),
  plansStarted: z.number().int().nonnegative(),
  plansCancelled: z.number().int().nonnegative(),
  receiptsRecorded: z.number().int().nonnegative(),
  interrupts: z.number().int().nonnegative(),
  supervisorHeld: z.number().int().nonnegative(),
  reworkCount: z.number().int().nonnegative(),
  stalledNudges: z.number().int().nonnegative(),
  usageLimitRetries: z.number().int().nonnegative(),
});
export type MainChatMetrics = z.infer<typeof MainChatMetricsSchema>;

export const MainChatOverviewSchema = z.object({
  plans: z.array(MainChatPlanRecordSchema),
  decisions: z.array(MainChatDecisionRecordSchema),
  autoStartRules: z.array(MainChatAutoStartRuleSchema),
  permissionRules: z.array(MainChatPermissionRuleSchema),
  metrics: MainChatMetricsSchema,
});
export type MainChatOverview = z.infer<typeof MainChatOverviewSchema>;

// ============================================================================
// Main Chat RPC Schemas
// ============================================================================

export const MainChatEnsureRequestSchema = z.object({
  type: z.literal("main_chat.ensure.request"),
  requestId: z.string(),
  provider: z.string().optional(),
  model: z.string().optional(),
  modeId: z.string().optional(),
  thinkingOptionId: z.string().optional(),
});
export type MainChatEnsureRequest = z.infer<typeof MainChatEnsureRequestSchema>;

export const MainChatEnsureResponsePayloadSchema = z.object({
  requestId: z.string(),
  agentId: z.string().nullable(),
  workspaceId: z.string().nullable(),
  created: z.boolean(),
  error: z.string().nullable(),
});
export type MainChatEnsureResponsePayload = z.infer<typeof MainChatEnsureResponsePayloadSchema>;

export const MainChatEnsureResponseSchema = z.object({
  type: z.literal("main_chat.ensure.response"),
  payload: MainChatEnsureResponsePayloadSchema,
});
export type MainChatEnsureResponse = z.infer<typeof MainChatEnsureResponseSchema>;

export const MainChatListPlansRequestSchema = z.object({
  type: z.literal("main_chat.list_plans.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
});
export type MainChatListPlansRequest = z.infer<typeof MainChatListPlansRequestSchema>;

export const MainChatListPlansResponsePayloadSchema = z.object({
  requestId: z.string(),
  plans: z.array(MainChatPlanRecordSchema),
  error: z.string().nullable(),
});
export type MainChatListPlansResponsePayload = z.infer<
  typeof MainChatListPlansResponsePayloadSchema
>;

export const MainChatListPlansResponseSchema = z.object({
  type: z.literal("main_chat.list_plans.response"),
  payload: MainChatListPlansResponsePayloadSchema,
});
export type MainChatListPlansResponse = z.infer<typeof MainChatListPlansResponseSchema>;

export const MainChatStartPlanRequestSchema = z.object({
  type: z.literal("main_chat.start_plan.request"),
  requestId: z.string(),
  planId: z.string(),
  taskIds: z.array(z.string()).optional(),
  rememberAutoStart: z.boolean().optional(),
});
export type MainChatStartPlanRequest = z.infer<typeof MainChatStartPlanRequestSchema>;

export const MainChatStartPlanResponsePayloadSchema = z.object({
  requestId: z.string(),
  plan: MainChatPlanRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatStartPlanResponsePayload = z.infer<
  typeof MainChatStartPlanResponsePayloadSchema
>;

export const MainChatStartPlanResponseSchema = z.object({
  type: z.literal("main_chat.start_plan.response"),
  payload: MainChatStartPlanResponsePayloadSchema,
});
export type MainChatStartPlanResponse = z.infer<typeof MainChatStartPlanResponseSchema>;

export const MainChatCancelPlanRequestSchema = z.object({
  type: z.literal("main_chat.cancel_plan.request"),
  requestId: z.string(),
  planId: z.string(),
});
export type MainChatCancelPlanRequest = z.infer<typeof MainChatCancelPlanRequestSchema>;

export const MainChatCancelPlanResponsePayloadSchema = z.object({
  requestId: z.string(),
  plan: MainChatPlanRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatCancelPlanResponsePayload = z.infer<
  typeof MainChatCancelPlanResponsePayloadSchema
>;

export const MainChatCancelPlanResponseSchema = z.object({
  type: z.literal("main_chat.cancel_plan.response"),
  payload: MainChatCancelPlanResponsePayloadSchema,
});
export type MainChatCancelPlanResponse = z.infer<typeof MainChatCancelPlanResponseSchema>;

export const MainChatGetOverviewRequestSchema = z.object({
  type: z.literal("main_chat.get_overview.request"),
  requestId: z.string(),
  mainAgentId: z.string(),
});
export type MainChatGetOverviewRequest = z.infer<typeof MainChatGetOverviewRequestSchema>;

export const MainChatGetOverviewResponsePayloadSchema = z.object({
  requestId: z.string(),
  overview: MainChatOverviewSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatGetOverviewResponsePayload = z.infer<
  typeof MainChatGetOverviewResponsePayloadSchema
>;

export const MainChatGetOverviewResponseSchema = z.object({
  type: z.literal("main_chat.get_overview.response"),
  payload: MainChatGetOverviewResponsePayloadSchema,
});
export type MainChatGetOverviewResponse = z.infer<typeof MainChatGetOverviewResponseSchema>;

export const MainChatAnswerDecisionRequestSchema = z.object({
  type: z.literal("main_chat.answer_decision.request"),
  requestId: z.string(),
  decisionId: z.string(),
  optionId: z.string().optional(),
  answer: z.string(),
});
export type MainChatAnswerDecisionRequest = z.infer<typeof MainChatAnswerDecisionRequestSchema>;

export const MainChatAnswerDecisionResponsePayloadSchema = z.object({
  requestId: z.string(),
  decision: MainChatDecisionRecordSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatAnswerDecisionResponsePayload = z.infer<
  typeof MainChatAnswerDecisionResponsePayloadSchema
>;

export const MainChatAnswerDecisionResponseSchema = z.object({
  type: z.literal("main_chat.answer_decision.response"),
  payload: MainChatAnswerDecisionResponsePayloadSchema,
});
export type MainChatAnswerDecisionResponse = z.infer<typeof MainChatAnswerDecisionResponseSchema>;

export const MainChatAddPermissionRuleRequestSchema = z.object({
  type: z.literal("main_chat.add_permission_rule.request"),
  requestId: z.string(),
  toolName: z.string(),
  commandPrefix: z.string().nullable().optional(),
  cwd: z.string().nullable().optional(),
});
export type MainChatAddPermissionRuleRequest = z.infer<
  typeof MainChatAddPermissionRuleRequestSchema
>;

export const MainChatAddPermissionRuleResponsePayloadSchema = z.object({
  requestId: z.string(),
  rule: MainChatPermissionRuleSchema.nullable(),
  error: z.string().nullable(),
});
export type MainChatAddPermissionRuleResponsePayload = z.infer<
  typeof MainChatAddPermissionRuleResponsePayloadSchema
>;

export const MainChatAddPermissionRuleResponseSchema = z.object({
  type: z.literal("main_chat.add_permission_rule.response"),
  payload: MainChatAddPermissionRuleResponsePayloadSchema,
});
export type MainChatAddPermissionRuleResponse = z.infer<
  typeof MainChatAddPermissionRuleResponseSchema
>;

export const MainChatRemoveRuleRequestSchema = z.object({
  type: z.literal("main_chat.remove_rule.request"),
  requestId: z.string(),
  kind: MainChatRuleKindSchema,
  ruleId: z.string(),
});
export type MainChatRemoveRuleRequest = z.infer<typeof MainChatRemoveRuleRequestSchema>;

export const MainChatRemoveRuleResponsePayloadSchema = z.object({
  requestId: z.string(),
  removed: z.boolean(),
  error: z.string().nullable(),
});
export type MainChatRemoveRuleResponsePayload = z.infer<
  typeof MainChatRemoveRuleResponsePayloadSchema
>;

export const MainChatRemoveRuleResponseSchema = z.object({
  type: z.literal("main_chat.remove_rule.response"),
  payload: MainChatRemoveRuleResponsePayloadSchema,
});
export type MainChatRemoveRuleResponse = z.infer<typeof MainChatRemoveRuleResponseSchema>;

export interface MainChatTaskLabelsMeta {
  planId: string | null;
  taskId: string | null;
  mode: MainChatTaskMode | null;
  goal: string | null;
}

export function isMainChatLabels(labels: Record<string, unknown> | null | undefined): boolean {
  return labels?.[MAIN_CHAT_ROLE_LABEL] === MAIN_CHAT_ROLE_VALUE;
}

export function isMainChatAgent(agent: AgentLabelSource | null | undefined): boolean {
  return Boolean(agent && isMainChatLabels(agent.labels));
}

export function getMainChatTaskMetaFromLabels(
  labels: Record<string, unknown> | null | undefined,
): MainChatTaskLabelsMeta | null {
  if (!labels) return null;
  const planId =
    typeof labels[MAIN_CHAT_TASK_PLAN_ID_LABEL] === "string" &&
    labels[MAIN_CHAT_TASK_PLAN_ID_LABEL].trim().length > 0
      ? labels[MAIN_CHAT_TASK_PLAN_ID_LABEL].trim()
      : null;
  const taskId =
    typeof labels[MAIN_CHAT_TASK_ID_LABEL] === "string" &&
    labels[MAIN_CHAT_TASK_ID_LABEL].trim().length > 0
      ? labels[MAIN_CHAT_TASK_ID_LABEL].trim()
      : null;
  const rawMode = labels[MAIN_CHAT_TASK_MODE_LABEL];
  const mode: MainChatTaskMode | null =
    rawMode === "readonly" || rawMode === "write" ? rawMode : null;
  const goal =
    typeof labels[MAIN_CHAT_TASK_GOAL_LABEL] === "string" &&
    labels[MAIN_CHAT_TASK_GOAL_LABEL].trim().length > 0
      ? labels[MAIN_CHAT_TASK_GOAL_LABEL].trim()
      : null;
  if (!planId && !taskId && !mode && !goal) return null;
  return { planId, taskId, mode, goal };
}

export function normalizeMainChatToolName(name: string): string {
  const normalized = name.trim().toLowerCase();
  const mcpSeparator = normalized.lastIndexOf("__");
  return mcpSeparator >= 0 ? normalized.slice(mcpSeparator + 2) : normalized;
}

export function isTaskPlanToolName(name: string): boolean {
  return normalizeMainChatToolName(name) === "task_plan";
}

export function isTaskCompleteToolName(name: string): boolean {
  return normalizeMainChatToolName(name) === "task_complete";
}

export function isTaskReworkToolName(name: string): boolean {
  return normalizeMainChatToolName(name) === "task_rework";
}

export function isTaskAskUserToolName(name: string): boolean {
  return normalizeMainChatToolName(name) === "task_ask_user";
}

export function isMainChatInlineCardToolName(name: string): boolean {
  return (
    isTaskPlanToolName(name) ||
    isTaskCompleteToolName(name) ||
    isTaskReworkToolName(name) ||
    isTaskAskUserToolName(name)
  );
}

function tryParseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function unwrapArrayPayload(entries: readonly unknown[]): Record<string, unknown> | null {
  for (const entry of entries) {
    if (typeof entry === "object" && entry !== null) {
      const record = entry as Record<string, unknown>;
      if (typeof record.text === "string") {
        const parsed = unwrapToolPayloadObject(record.text);
        if (parsed) return parsed;
      }
    }
    const parsed = unwrapToolPayloadObject(entry);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * MCP tool outputs arrive differently across providers (structured object, JSON text string, or
 * `{ content: [{ type: "text", text: "..." }] }`). Unwrap all of those shapes cleanly.
 */
export function unwrapToolPayloadObject(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    return unwrapToolPayloadObject(tryParseJsonString(raw));
  }
  if (Array.isArray(raw)) {
    return unwrapArrayPayload(raw);
  }
  if (typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.structuredContent === "object" && obj.structuredContent !== null) {
    const nested = unwrapToolPayloadObject(obj.structuredContent);
    if (nested) return nested;
  }
  if (Array.isArray(obj.content)) {
    const fromContent = unwrapArrayPayload(obj.content);
    if (fromContent) return fromContent;
  }
  if (typeof obj.text === "string") {
    const fromText = unwrapToolPayloadObject(obj.text);
    if (fromText) return fromText;
  }
  return obj;
}

export function parseTaskPlanToolOutput(output: unknown): MainChatPlanRecord | null {
  const obj = unwrapToolPayloadObject(output);
  if (!obj) return null;
  const candidate = obj.plan ?? obj;
  const parsed = MainChatPlanRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function parseTaskCompleteToolPayload(
  input: unknown,
  output: unknown,
): MainChatTaskReceipt | null {
  const outputObj = unwrapToolPayloadObject(output);
  const receiptFromOutput = outputObj?.receipt ?? outputObj;
  const parsedOutput = MainChatTaskReceiptSchema.safeParse(receiptFromOutput);
  if (parsedOutput.success) return parsedOutput.data;

  const inputObj = unwrapToolPayloadObject(input);
  if (!inputObj || typeof inputObj.title !== "string" || typeof inputObj.summary !== "string") {
    return null;
  }
  const checks = Array.isArray(inputObj.checks)
    ? inputObj.checks.flatMap((entry) => {
        const parsed = MainChatReceiptCheckSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  const nextSteps = Array.isArray(inputObj.nextSteps)
    ? inputObj.nextSteps.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    title: inputObj.title,
    summary: inputObj.summary,
    agentId: typeof inputObj.agentId === "string" ? inputObj.agentId : null,
    planId: typeof inputObj.planId === "string" ? inputObj.planId : null,
    taskId: typeof inputObj.taskId === "string" ? inputObj.taskId : null,
    checks,
    nextSteps,
  };
}

export function parseTaskReworkToolPayload(
  input: unknown,
  output: unknown,
): MainChatReworkRecord | null {
  const outputObj = unwrapToolPayloadObject(output);
  const candidate = outputObj?.rework ?? outputObj;
  const parsedOutput = MainChatReworkRecordSchema.safeParse(candidate);
  if (parsedOutput.success) return parsedOutput.data;

  const inputObj = unwrapToolPayloadObject(input);
  if (!inputObj || typeof inputObj.agentId !== "string") return null;
  const gaps = Array.isArray(inputObj.gaps)
    ? inputObj.gaps.filter((entry): entry is string => typeof entry === "string")
    : [];
  if (gaps.length === 0) return null;
  return {
    title: typeof inputObj.title === "string" ? inputObj.title : inputObj.agentId,
    agentId: inputObj.agentId,
    planId: typeof inputObj.planId === "string" ? inputObj.planId : null,
    taskId: typeof inputObj.taskId === "string" ? inputObj.taskId : null,
    round: 1,
    maxRounds: 2,
    gaps,
    note: typeof inputObj.note === "string" ? inputObj.note : null,
  };
}

export function parseTaskAskUserToolPayload(output: unknown): MainChatDecisionRecord | null {
  const outputObj = unwrapToolPayloadObject(output);
  if (!outputObj) return null;
  const candidate = outputObj.decision ?? outputObj;
  const parsed = MainChatDecisionRecordSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

const COMPOUND_COMMAND_RUNNERS = new Set([
  "npm",
  "pnpm",
  "yarn",
  "npx",
  "bun",
  "deno",
  "git",
  "jj",
  "cargo",
  "go",
  "python",
  "python3",
  "pytest",
  "uv",
  "docker",
  "kubectl",
  "make",
  "gh",
  "lark-cli",
]);

const UNSAFE_SHELL_METACHAR_RE = /[;&|><`$()]/;

const DISALLOWED_AUTO_APPROVE_COMMANDS = new Set([
  "rm",
  "sudo",
  "su",
  "dd",
  "mkfs",
  "chmod",
  "chown",
  "kill",
  "killall",
  "shutdown",
  "reboot",
]);

const DISALLOWED_AUTO_APPROVE_PREFIXES = new Set([
  "git push",
  "git reset",
  "git clean",
  "git rebase",
  "jj git",
  "npm publish",
  "pnpm publish",
]);

export interface MainChatPermissionRuleCandidate {
  toolName: string;
  commandPrefix: string | null;
}

function readRawCommandFromInput(input: Record<string, unknown> | null | undefined): string | null {
  if (!input) return null;
  const raw = input.command ?? input.cmd;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractSafeCommandPrefix(command: string): string | null {
  if (UNSAFE_SHELL_METACHAR_RE.test(command)) return null;
  const tokens = command.split(/\s+/).filter(Boolean);
  const first = tokens[0]?.toLowerCase();
  if (!first || DISALLOWED_AUTO_APPROVE_COMMANDS.has(first)) return null;
  const second = tokens[1];
  if (COMPOUND_COMMAND_RUNNERS.has(first) && second && !second.startsWith("-")) {
    const pair = `${first} ${second.toLowerCase()}`;
    return DISALLOWED_AUTO_APPROVE_PREFIXES.has(pair) ? null : pair;
  }
  return first;
}

/**
 * Extracts a conservative, deterministic permission-rule key shared by the daemon supervisor and
 * the UI's "Approve & Remember Similar" button. Chained shell commands or destructive operations
 * return `null` so they always require explicit user confirmation.
 */
export function extractMainChatPermissionRuleCandidate(request: {
  kind?: string | null;
  name?: string | null;
  title?: string | null;
  input?: Record<string, unknown> | null;
}): MainChatPermissionRuleCandidate | null {
  if (request.kind === "question" || request.kind === "plan") return null;
  const toolName = (request.name ?? request.title ?? "").trim();
  if (!toolName) return null;
  const rawCommand = readRawCommandFromInput(request.input);
  if (rawCommand !== null) {
    const commandPrefix = extractSafeCommandPrefix(rawCommand);
    if (!commandPrefix) return null;
    return { toolName, commandPrefix };
  }
  return { toolName, commandPrefix: null };
}
