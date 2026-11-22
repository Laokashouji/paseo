import { z } from "zod";

export const PLUGIN_ID = "session-workbench";
export const WORKBENCH_METADATA_KEY = "session-workbench";
export const HELPER_LABEL_KEY = "paseo.session-workbench.helper";
export const HELPER_LABEL_VALUE = "summarizer";

export const WorkflowStatusSchema = z.enum([
  "active",
  "waiting_me",
  "waiting_external",
  "waiting_dependency",
  "snoozed",
  "done",
]);
export type WorkflowStatus = z.infer<typeof WorkflowStatusSchema>;

export const TodoAuthorSchema = z.enum(["user", "agent", "summarizer"]);
export type TodoAuthor = z.infer<typeof TodoAuthorSchema>;

export const TodoStatusSchema = z.enum([
  "open",
  "queued",
  "running",
  "forked",
  "done",
  "dismissed",
]);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const ForkModeSchema = z.enum(["same_workspace", "new_worktree"]);
export type ForkMode = z.infer<typeof ForkModeSchema>;

export const ForkContextModeSchema = z.enum(["summary", "full_history"]);
export type ForkContextMode = z.infer<typeof ForkContextModeSchema>;

export const WaitConditionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("manual"),
    reason: z.string(),
    remindAt: z.string().optional(),
  }),
  z.object({
    kind: z.literal("agent_settled"),
    targetAgentId: z.string().min(1),
    targetLabel: z.string().optional(),
    expect: z.enum(["idle", "done"]).default("idle"),
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal("external_signal"),
    source: z.enum(["feishu", "pr", "ci", "webhook", "custom"]),
    ref: z.string(),
    reason: z.string(),
  }),
]);
export type WaitCondition = z.infer<typeof WaitConditionSchema>;

export const AdvancePolicySchema = z.object({
  mode: z
    .enum(["notify_only", "auto_run_next_todo", "auto_send_prompt", "delegate_to_master"])
    .default("notify_only"),
  prompt: z.string().optional(),
});
export type AdvancePolicy = z.infer<typeof AdvancePolicySchema>;

export const TodoItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string().optional(),
  author: TodoAuthorSchema,
  status: TodoStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  linkedTurnId: z.string().optional(),
  forkedAgentId: z.string().optional(),
  forkedWorkspaceId: z.string().optional(),
  forkMode: ForkModeSchema.optional(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const SuggestedTodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string().optional(),
  createdAt: z.string(),
});
export type SuggestedTodo = z.infer<typeof SuggestedTodoSchema>;

export const BlockerKindSchema = z.enum(["external", "dependency", "decision"]);
export type BlockerKind = z.infer<typeof BlockerKindSchema>;

export const BlockerStatusSchema = z.enum(["open", "resolved"]);
export type BlockerStatus = z.infer<typeof BlockerStatusSchema>;

export const BlockerItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  kind: BlockerKindSchema.default("external"),
  author: TodoAuthorSchema.default("user"),
  status: BlockerStatusSchema.default("open"),
  targetAgentId: z.string().optional(),
  targetLabel: z.string().optional(),
  expect: z.enum(["idle", "done"]).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BlockerItem = z.infer<typeof BlockerItemSchema>;

export const RuntimeStatusSchema = z.enum([
  "initializing",
  "idle",
  "running",
  "error",
  "closed",
  "unknown",
]);
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;

export const ArchiveStateSchema = z.enum(["idle", "queued", "running", "pending_archive"]);
export type ArchiveState = z.infer<typeof ArchiveStateSchema>;

export const ArchiveCompletedEventSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  archivedAt: z.string(),
  summary: z.string().nullable(),
});
export type ArchiveCompletedEvent = z.infer<typeof ArchiveCompletedEventSchema>;

export const SessionWorkbenchCardSchema = z.object({
  agentId: z.string(),
  workspaceId: z.string().nullable(),
  agentTitle: z.string().nullable(),
  runtimeStatus: RuntimeStatusSchema,
  topic: z.string(),
  topicLocked: z.boolean(),
  currentWork: z.string(),
  workflowStatus: WorkflowStatusSchema,
  statusNote: z.string(),
  waitCondition: WaitConditionSchema.nullable(),
  advancePolicy: AdvancePolicySchema,
  conditionMetNotice: z.string().nullable(),
  blockers: z.array(BlockerItemSchema).default([]),
  todos: z.array(TodoItemSchema),
  suggestedTodos: z.array(SuggestedTodoSchema),
  summaryState: z.enum(["idle", "running", "error"]),
  summaryError: z.string().nullable(),
  summaryModel: z.string().nullable().default(null),
  lastSummarizedAt: z.string().nullable(),
  lastSummarizedTurnId: z.string().nullable(),
  forkedFromAgentId: z.string().nullable(),
  forkedFromTodoId: z.string().nullable(),
  archiveState: ArchiveStateSchema.default("idle"),
  archiveSummary: z.string().nullable().default(null),
  updatedAt: z.string(),
  archived: z.boolean(),
});
export type SessionWorkbenchCard = z.infer<typeof SessionWorkbenchCardSchema>;

export const OverviewCountsSchema = z.object({
  total: z.number(),
  active: z.number(),
  waitingMe: z.number(),
  waitingExternal: z.number(),
  waitingDependency: z.number(),
  snoozed: z.number(),
  done: z.number(),
  readyToAdvance: z.number(),
  openTodos: z.number(),
  openBlockers: z.number().default(0),
});
export type OverviewCounts = z.infer<typeof OverviewCountsSchema>;

export const OverviewSnapshotSchema = z.object({
  cards: z.array(SessionWorkbenchCardSchema),
  counts: OverviewCountsSchema,
});
export type OverviewSnapshot = z.infer<typeof OverviewSnapshotSchema>;

export function createEmptyCard(input: {
  agentId: string;
  workspaceId?: string | null;
  agentTitle?: string | null;
  runtimeStatus?: RuntimeStatus;
  now?: string;
}): SessionWorkbenchCard {
  const now = input.now ?? new Date().toISOString();
  return {
    agentId: input.agentId,
    workspaceId: input.workspaceId ?? null,
    agentTitle: input.agentTitle ?? null,
    runtimeStatus: input.runtimeStatus ?? "unknown",
    topic: "",
    topicLocked: false,
    currentWork: "",
    workflowStatus: "active",
    statusNote: "",
    waitCondition: null,
    advancePolicy: { mode: "notify_only" },
    conditionMetNotice: null,
    blockers: [],
    todos: [],
    suggestedTodos: [],
    summaryState: "idle",
    summaryError: null,
    summaryModel: null,
    lastSummarizedAt: null,
    lastSummarizedTurnId: null,
    forkedFromAgentId: null,
    forkedFromTodoId: null,
    archiveState: "idle",
    archiveSummary: null,
    updatedAt: now,
    archived: false,
  };
}

export function computeOverviewCounts(cards: readonly SessionWorkbenchCard[]): OverviewCounts {
  let active = 0;
  let waitingMe = 0;
  let waitingExternal = 0;
  let waitingDependency = 0;
  let snoozed = 0;
  let done = 0;
  let readyToAdvance = 0;
  let openTodos = 0;
  let openBlockers = 0;

  for (const card of cards) {
    if (card.archived) continue;
    switch (card.workflowStatus) {
      case "active":
        active += 1;
        break;
      case "waiting_me":
        waitingMe += 1;
        break;
      case "waiting_external":
        waitingExternal += 1;
        break;
      case "waiting_dependency":
        waitingDependency += 1;
        break;
      case "snoozed":
        snoozed += 1;
        break;
      case "done":
        done += 1;
        break;
    }
    if (card.conditionMetNotice) {
      readyToAdvance += 1;
    }
    for (const todo of card.todos) {
      if (todo.status === "open" || todo.status === "queued") {
        openTodos += 1;
      }
    }
    for (const blocker of card.blockers) {
      if (blocker.status === "open") {
        openBlockers += 1;
      }
    }
  }

  const visibleTotal = active + waitingMe + waitingExternal + waitingDependency + snoozed + done;
  return {
    total: visibleTotal,
    active,
    waitingMe,
    waitingExternal,
    waitingDependency,
    snoozed,
    done,
    readyToAdvance,
    openTodos,
    openBlockers,
  };
}

export function buildMetadataMirror(card: SessionWorkbenchCard) {
  let openTodoCount = 0;
  let queuedTodoCount = 0;
  let openBlockerCount = 0;
  for (const todo of card.todos) {
    if (todo.status === "open") openTodoCount += 1;
    else if (todo.status === "queued") queuedTodoCount += 1;
  }
  for (const blocker of card.blockers) {
    if (blocker.status === "open") openBlockerCount += 1;
  }
  return {
    workflowStatus: card.workflowStatus,
    topic: card.topic || null,
    currentWork: card.currentWork || null,
    statusNote: card.statusNote || null,
    openTodoCount,
    queuedTodoCount,
    openBlockerCount,
    conditionMet: Boolean(card.conditionMetNotice),
    updatedAt: card.updatedAt,
  };
}
