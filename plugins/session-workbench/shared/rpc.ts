import { defineRpc, defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";
import {
  AdvancePolicySchema,
  ForkContextModeSchema,
  ForkModeSchema,
  OverviewSnapshotSchema,
  SessionWorkbenchCardSchema,
  TodoAuthorSchema,
  TodoStatusSchema,
  WaitConditionSchema,
  WorkflowStatusSchema,
} from "./schema.js";

export const getCardRpc = defineRpc({
  name: "workbench.card.get",
  input: z.object({
    agentId: z.string().min(1),
    workspaceId: z.string().nullable().optional(),
  }),
  output: z.object({
    card: SessionWorkbenchCardSchema,
  }),
});

export const getOverviewRpc = defineRpc({
  name: "workbench.overview.get",
  input: z.object({
    includeArchived: z.boolean().optional(),
  }),
  output: OverviewSnapshotSchema,
});

export const updateCardMetaRpc = defineRpc({
  name: "workbench.card.update",
  input: z.object({
    agentId: z.string().min(1),
    workspaceId: z.string().nullable().optional(),
    topic: z.string().optional(),
    topicLocked: z.boolean().optional(),
    currentWork: z.string().optional(),
    workflowStatus: WorkflowStatusSchema.optional(),
    statusNote: z.string().optional(),
    waitCondition: WaitConditionSchema.nullable().optional(),
    advancePolicy: AdvancePolicySchema.optional(),
    clearConditionNotice: z.boolean().optional(),
  }),
  output: z.object({
    card: SessionWorkbenchCardSchema,
  }),
});

export const addTodoRpc = defineRpc({
  name: "workbench.todo.add",
  input: z.object({
    agentId: z.string().min(1),
    workspaceId: z.string().nullable().optional(),
    title: z.string().trim().min(1).max(400),
    prompt: z.string().max(4000).optional(),
    author: TodoAuthorSchema.optional(),
  }),
  output: z.object({
    card: SessionWorkbenchCardSchema,
    todoId: z.string(),
  }),
});

export const updateTodoRpc = defineRpc({
  name: "workbench.todo.update",
  input: z.object({
    agentId: z.string().min(1),
    todoId: z.string().min(1),
    title: z.string().trim().min(1).max(400).optional(),
    prompt: z.string().max(4000).optional(),
    status: TodoStatusSchema.optional(),
  }),
  output: z.object({
    card: SessionWorkbenchCardSchema,
  }),
});

export const removeTodoRpc = defineRpc({
  name: "workbench.todo.remove",
  input: z.object({
    agentId: z.string().min(1),
    todoId: z.string().min(1),
  }),
  output: z.object({
    card: SessionWorkbenchCardSchema,
  }),
});

export const resolveSuggestedTodoRpc = defineRpc({
  name: "workbench.todo.resolve_suggested",
  input: z.object({
    agentId: z.string().min(1),
    suggestedId: z.string().min(1),
    action: z.enum(["accept", "dismiss"]),
  }),
  output: z.object({
    card: SessionWorkbenchCardSchema,
  }),
});

export const runTodoRpc = defineRpc({
  name: "workbench.todo.run",
  input: z.object({
    agentId: z.string().min(1),
    todoId: z.string().min(1),
    mode: z.enum(["send_now", "queue_next"]).default("send_now"),
  }),
  output: z.object({
    card: SessionWorkbenchCardSchema,
    dispatched: z.enum(["sent", "queued"]),
  }),
});

export const forkTodoRpc = defineRpc({
  name: "workbench.todo.fork",
  input: z.object({
    agentId: z.string().min(1),
    todoId: z.string().min(1),
    forkMode: ForkModeSchema.default("same_workspace"),
    contextMode: ForkContextModeSchema.optional(),
    branchName: z.string().trim().min(1).max(120).optional(),
  }),
  output: z.object({
    card: SessionWorkbenchCardSchema,
    newAgentId: z.string(),
    newWorkspaceId: z.string().nullable(),
  }),
});

export const refreshSummaryRpc = defineRpc({
  name: "workbench.summary.refresh",
  input: z.object({
    agentId: z.string().min(1),
    workspaceId: z.string().nullable().optional(),
  }),
  output: z.object({
    card: SessionWorkbenchCardSchema,
  }),
});

export const resolveExternalSignalRpc = defineRpc({
  name: "workbench.wait.resolve_signal",
  input: z.object({
    agentId: z.string().min(1),
    note: z.string().optional(),
  }),
  output: z.object({
    card: SessionWorkbenchCardSchema,
  }),
});

export const cardSubscription = defineSubscription({
  name: "workbench.card.watch",
  input: z.object({
    agentId: z.string().min(1),
    workspaceId: z.string().nullable().optional(),
  }),
  event: z.object({
    card: SessionWorkbenchCardSchema,
  }),
});

export const overviewSubscription = defineSubscription({
  name: "workbench.overview.watch",
  input: z.object({
    includeArchived: z.boolean().optional(),
  }),
  event: OverviewSnapshotSchema,
});
