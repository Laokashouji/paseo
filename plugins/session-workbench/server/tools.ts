import { defineAgentTool, type AgentToolDefinition } from "@getpaseo/plugin/server";
import { z } from "zod";
import {
  BlockerKindSchema,
  TodoStatusSchema,
  WorkflowStatusSchema,
  type SessionWorkbenchCard,
} from "../shared/schema.js";
import type { WorkbenchStore } from "./store.js";

export function buildCardContextPrompt(card: SessionWorkbenchCard | null): string | null {
  if (!card) return null;
  const openTodos = card.todos.filter(
    (item) => item.status === "open" || item.status === "queued" || item.status === "running",
  );
  const openBlockers = card.blockers.filter((item) => item.status === "open");
  if (
    !card.topic &&
    !card.currentWork &&
    openTodos.length === 0 &&
    openBlockers.length === 0 &&
    !card.statusNote
  ) {
    return null;
  }
  const lines = ["[Paseo Session Workbench 状态]"];
  if (card.topic) lines.push(`- 主题工作: ${card.topic}`);
  if (card.currentWork) lines.push(`- 当前工作: ${card.currentWork}`);
  if (card.workflowStatus !== "active" || card.statusNote) {
    lines.push(`- 推进状态: ${card.workflowStatus}${card.statusNote ? ` (${card.statusNote})` : ""}`);
  }
  if (openBlockers.length > 0) {
    lines.push("- 当前阻塞项:");
    for (const blocker of openBlockers.slice(0, 6)) {
      lines.push(`  - [${blocker.id}] (${blocker.kind}) ${blocker.title}`);
    }
  }
  if (openTodos.length > 0) {
    lines.push("- 待办列表:");
    for (const todo of openTodos.slice(0, 8)) {
      lines.push(`  - [${todo.id}] (${todo.status}) ${todo.title}`);
    }
  }
  return lines.join("\n");
}

export const WORKBENCH_TOOLS_PROMPT = [
  "你拥有 Session Workbench 工具（workbench_add_todo / workbench_update_todo / workbench_add_blocker / workbench_set_status），用于与用户共同维护右上角工作台卡片。",
  "- 当发现值得稍后跟进的子任务或顺带修复项，且不适合打断当前主线时，可调用 workbench_add_todo 记录待办。",
  "- 完成卡片上的待办时，调用 workbench_update_todo 将其标记为 done。",
  "- 当遇到需要等待他人确认、外部流程或用户拍板的阻塞点时，调用 workbench_add_blocker 记一条阻塞项，或用 workbench_set_status 更新当前进展。",
].join("\n");

export function createWorkbenchAgentTools(
  store: WorkbenchStore,
  onMarkedDone?: (agentId: string) => void,
): AgentToolDefinition[] {
  return [
    defineAgentTool({
      name: "workbench_add_todo",
      title: "Workbench: 添加待办",
      description:
        "向当前对话右上角的工作台卡片添加一条后续待办事项，用户可稍后一键在当前对话继续执行或 Fork 新对话执行。",
      input: z.object({
        title: z.string().trim().min(1).max(200).describe("待办简短标题"),
        prompt: z
          .string()
          .trim()
          .max(2000)
          .optional()
          .describe("可选：点击执行时发送给 Agent 的更完整提示词"),
      }),
      async execute(input, context) {
        const { todo } = store.addTodo({
          agentId: context.agent.id,
          workspaceId: context.agent.workspaceId,
          title: input.title,
          prompt: input.prompt,
          author: "agent",
        });
        return {
          text: `已记录待办 [${todo.id}]: ${todo.title}`,
          structuredContent: { todoId: todo.id, title: todo.title },
        };
      },
    }),

    defineAgentTool({
      name: "workbench_update_todo",
      title: "Workbench: 更新待办状态",
      description: "更新当前对话工作台卡片中某条待办的状态（如 running / done / dismissed）。",
      input: z.object({
        todoId: z.string().trim().min(1).describe("待办 ID 或精确标题"),
        status: TodoStatusSchema.describe("目标状态"),
      }),
      async execute(input, context) {
        const matched = store.findTodoByIdOrTitle(context.agent.id, input.todoId);
        if (!matched) {
          return {
            isError: true,
            text: `未找到待办: ${input.todoId}`,
          };
        }
        store.updateTodo(context.agent.id, matched.id, { status: input.status });
        return {
          text: `已更新待办 [${matched.id}]「${matched.title}」状态为 ${input.status}`,
          structuredContent: { todoId: matched.id, status: input.status },
        };
      },
    }),

    defineAgentTool({
      name: "workbench_add_blocker",
      title: "Workbench: 记录阻塞项",
      description:
        "向当前对话右上角工作台卡片记录一条阻塞项（如等待外部确认、等待关联任务或待用户拍板），方便统一跟踪并在解除后一键推进。",
      input: z.object({
        title: z.string().trim().min(1).max(240).describe("阻塞原因简述"),
        kind: BlockerKindSchema.default("external").describe(
          "阻塞类型：external（等外部确认）/ decision（待用户拍板）/ dependency（等关联任务）",
        ),
      }),
      async execute(input, context) {
        const { blocker } = store.addBlocker({
          agentId: context.agent.id,
          workspaceId: context.agent.workspaceId,
          title: input.title,
          kind: input.kind,
          author: "agent",
        });
        return {
          text: `已记录阻塞项 [${blocker.id}] (${blocker.kind}): ${blocker.title}`,
          structuredContent: { blockerId: blocker.id, title: blocker.title, kind: blocker.kind },
        };
      },
    }),

    defineAgentTool({
      name: "workbench_set_status",
      title: "Workbench: 更新工作台状态",
      description:
        "更新当前对话的主题工作、当前在做的工作、推进状态（如 active / waiting_me / waiting_external / waiting_dependency / done）及简短备注。",
      input: z.object({
        topic: z.string().trim().max(80).optional().describe("主题工作（若用户已锁定则不会覆盖）"),
        currentWork: z.string().trim().max(140).optional().describe("当前正在做的具体工作"),
        workflowStatus: WorkflowStatusSchema.optional().describe("对话推进状态"),
        statusNote: z.string().trim().max(140).optional().describe("状态或等待原因简短备注"),
      }),
      async execute(input, context) {
        const current = store.getOrCreateCard({
          agentId: context.agent.id,
          workspaceId: context.agent.workspaceId,
          agentTitle: context.agent.title,
        });
        const nextTopic =
          input.topic !== undefined && !(current.topicLocked && current.topic)
            ? input.topic
            : undefined;
        const updated = store.updateCard(context.agent.id, {
          ...(nextTopic !== undefined ? { topic: nextTopic } : {}),
          ...(input.currentWork !== undefined ? { currentWork: input.currentWork } : {}),
          ...(input.workflowStatus !== undefined ? { workflowStatus: input.workflowStatus } : {}),
          ...(input.statusNote !== undefined ? { statusNote: input.statusNote } : {}),
        });
        if (input.workflowStatus === "done") {
          onMarkedDone?.(context.agent.id);
        }
        return {
          text: `已更新工作台：status=${updated.workflowStatus}, currentWork=${updated.currentWork || "-"}`,
          structuredContent: {
            workflowStatus: updated.workflowStatus,
            topic: updated.topic,
            currentWork: updated.currentWork,
          },
        };
      },
    }),
  ];
}
