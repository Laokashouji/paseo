import { z } from "zod";
import {
  MainChatDecisionOptionSchema,
  MainChatDecisionRecordSchema,
  MainChatPlanRecordSchema,
  MainChatReceiptCheckSchema,
  MainChatReworkRecordSchema,
  MainChatTaskIsolationSchema,
  MainChatTaskModeSchema,
  MainChatTaskReceiptSchema,
  MainChatTaskRecordSchema,
  MainChatTaskReviewVerdictSchema,
  isMainChatLabels,
} from "@getpaseo/protocol/main-chat";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import type { AgentManager } from "../agent/agent-manager.js";
import { isPaseoToolEnabled } from "../agent/paseo-tool-policy.js";
import { ensureValidJson } from "../json-utils.js";
import { addModelVisibleStructuredContent } from "../agent/tools/paseo-tool-serialization.js";
import type { PaseoToolDefinition } from "../agent/tools/types.js";
import { getMainChatConversationMetaFromLabels } from "./conversations.js";
import { formatEscalatedDecisionReason, registerLeaderConversationTools } from "./leader-tools.js";
import type { MainChatService } from "./service.js";

const TaskPlanItemInputSchema = z.object({
  title: z.string().trim().min(1).describe("简短明确的中文任务标题（建议 15 字以内）。"),
  goal: z.string().trim().min(1).describe("一句话说明任务要达成的目标。"),
  mode: MainChatTaskModeSchema.optional().describe(
    "readonly 表示只读调研/排查（默认自动开工）；write 表示涉及修改（默认先出计划卡等用户确认）。",
  ),
  isolation: MainChatTaskIsolationSchema.optional().describe(
    "local 复用目标目录或现有工作区；worktree 为改动任务创建独立隔离工作区。",
  ),
  cwd: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("目标项目或目录路径（与 workspaceId 二选一）。"),
  workspaceId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("已有 Paseo workspaceId（与 cwd 二选一）。"),
  reason: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("一句简短的推断理由，向用户解释为什么这样派发。"),
  doneWhen: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("可验证的验收标准列表；write 任务必填至少 1 条。"),
  outOfBounds: z
    .array(z.string().trim().min(1))
    .optional()
    .describe("需要子 Agent 遵守的额外边界。"),
  provider: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("可选 provider/model 覆盖；默认继承主对话当前模型。"),
  modeId: z.string().trim().min(1).optional().describe("可选权限模式覆盖。"),
  thinkingOptionId: z.string().trim().min(1).optional().describe("可选思考强度覆盖。"),
  branchName: z.string().trim().min(1).optional().describe("worktree 隔离时的新分支名。"),
  baseBranch: z.string().trim().min(1).optional().describe("worktree 隔离时的基线分支。"),
  serverId: z.string().trim().min(1).optional().describe("目标主机 serverId；缺省表示本地主机。"),
  hostLabel: z.string().trim().min(1).optional().describe("可选目标主机展示名。"),
  continuesTaskId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "续接已有任务时填写原任务 ID：系统会自动停止原运行中 Agent，将新 Agent 挂载到原任务卡并沿用原 Brief 与历史决策表，不产生重复任务卡。",
    ),
  continuesWhy: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("简短说明为什么要换新 Agent 续接原任务。"),
  quiet: z
    .boolean()
    .optional()
    .default(true)
    .describe("静默任务标记，默认为 true（减少后台过程打扰，仅在需要拍板或验收时提醒）。"),
});

export function registerMainChatTools(options: {
  agentManager: AgentManager;
  mainChatService?: MainChatService | null;
  callerAgentId?: string;
  scope: "agent" | "top-level";
  tools: Map<string, PaseoToolDefinition>;
  builtinNames: Set<string>;
  policy?: ProviderPaseoToolsPolicy;
}): void {
  const { agentManager, mainChatService, callerAgentId, scope, tools, builtinNames, policy } =
    options;
  if (!mainChatService || scope !== "agent" || !callerAgentId) return;

  const caller = agentManager.getAgent(callerAgentId);
  if (!caller) return;

  const conversationManager = mainChatService.getConversationManager();
  registerLeaderConversationTools({
    agentManager,
    conversationManager,
    callerAgentId,
    scope,
    tools,
    builtinNames,
    policy,
    reportLeaderProgress: (input) => mainChatService.reportLeaderProgress(input),
    escalateDecisionToMain: async (input) => {
      const mainEnsure = await mainChatService.ensureMainChat();
      return mainChatService.askUserDecision(mainEnsure.agentId, {
        title: input.title,
        question: input.question,
        options: input.options,
        recommendedOptionId: input.recommendedOptionId,
        reason: formatEscalatedDecisionReason({
          fromConversationTitle: input.fromConversationTitle,
          background: input.background,
          whyUserMustDecide: input.whyUserMustDecide,
        }),
        taskId: input.taskId,
        agentId: input.agentId,
      });
    },
  });

  const conversationMeta = getMainChatConversationMetaFromLabels(caller.labels);
  const isLeaderCaller = conversationMeta?.kind === "leader";
  if (!isMainChatLabels(caller.labels) && !isLeaderCaller) return;

  const register = (def: PaseoToolDefinition) => {
    builtinNames.add(def.name);
    if (!isPaseoToolEnabled(policy, def.name)) return;
    tools.set(def.name, def);
  };

  register({
    name: "task_plan",
    title: "Plan and dispatch tasks",
    description:
      "为用户的意图拆解并创建任务计划。全部为 readonly 任务（或命中同类信任规则）时立即自动开工；包含 write 任务时生成原生计划卡等待用户点击开始或口头确认。",
    inputSchema: z.object({
      summary: z.string().trim().min(1).optional().describe("对本批任务计划的一句话概述。"),
      autoStart: z
        .boolean()
        .optional()
        .describe("仅在用户明确要求立刻直接执行且无需确认时设为 true。"),
      tasks: z.array(TaskPlanItemInputSchema).min(1).max(8),
    }),
    outputSchema: {
      plan: MainChatPlanRecordSchema,
      guidance: z.string(),
    },
    async handler(rawInput) {
      const input = rawInput as {
        summary?: string;
        autoStart?: boolean;
        tasks: Array<z.infer<typeof TaskPlanItemInputSchema>>;
      };
      const plan = await mainChatService.createPlan(callerAgentId, input);
      const guidance =
        plan.status === "started"
          ? "计划中的任务已全部开工，子 Agent 完成、出错或请求权限时会自动通知你，请不要轮询。"
          : "计划卡已展示给用户等待点击「开始执行」。请简短说明本计划并结束本轮，如果用户口头确认再调用 task_start。";
      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({ plan, guidance }),
      });
    },
  });

  register({
    name: "task_start",
    title: "Start a planned task batch",
    description: "当用户口头确认开始某个待执行的任务计划时调用，拉起计划中的子 Agent。",
    inputSchema: z.object({
      planId: z.string().trim().min(1),
      taskIds: z.array(z.string().trim().min(1)).optional(),
      rememberAutoStart: z
        .boolean()
        .optional()
        .describe("当用户明确说以后同类任务直接开始时设为 true。"),
    }),
    outputSchema: {
      plan: MainChatPlanRecordSchema,
      guidance: z.string(),
    },
    async handler(rawInput) {
      const input = rawInput as {
        planId: string;
        taskIds?: string[];
        rememberAutoStart?: boolean;
      };
      const plan = await mainChatService.startPlan(input.planId, {
        taskIds: input.taskIds,
        rememberAutoStart: input.rememberAutoStart,
      });
      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          plan,
          guidance: "任务已开工，等待子 Agent 完成或需要权限时的自动通知，请不要轮询。",
        }),
      });
    },
  });

  register({
    name: "task_list",
    title: "List main-chat tasks, plans, and fleet sessions",
    description:
      "查看当前管家名下所有任务计划、子 Agent 以及全机其他手动会话的实时状态与最新分诊结论。",
    inputSchema: z.object({}),
    async handler() {
      const tasks = await mainChatService.listTasks(callerAgentId);
      const taskRecords = await mainChatService.listTaskRecords({
        mainAgentId: callerAgentId,
        includeCompleted: true,
      });
      const plans = mainChatService.listPlans(callerAgentId);
      const fleet = await mainChatService.listFleetSessions(callerAgentId);
      const settings = await mainChatService.getSettings();
      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          settings,
          tasks,
          taskRecords,
          plans,
          fleet,
          metrics: mainChatService.getMetrics(),
        }),
      });
    },
  });

  register({
    name: "task_rework",
    title: "Send structured rework gaps to a child agent",
    description:
      "独立复核子 Agent 的结果后若发现未满足验收标准，调用此工具把具体缺口退回同一个子 Agent 返工（自动限流最多 2 轮）。",
    inputSchema: z.object({
      agentId: z.string().trim().min(1).describe("需要返工的子 Agent ID。"),
      title: z.string().trim().min(1).optional().describe("任务标题（用于主对话流卡片展示）。"),
      planId: z.string().trim().min(1).optional().describe("关联的计划 ID。"),
      taskId: z.string().trim().min(1).optional().describe("关联的任务 ID。"),
      gaps: z
        .array(z.string().trim().min(1))
        .min(1)
        .max(8)
        .describe("具体缺失的验收项或验证缺口列表。"),
      note: z.string().trim().min(1).optional().describe("可选的补充说明或优先修复建议。"),
    }),
    outputSchema: {
      rework: MainChatReworkRecordSchema,
      guidance: z.string(),
    },
    async handler(rawInput) {
      const input = rawInput as {
        agentId: string;
        title?: string;
        planId?: string;
        taskId?: string;
        gaps: string[];
        note?: string;
      };
      const rework = await mainChatService.reworkTask(callerAgentId, input);
      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          rework,
          guidance: `已将第 ${rework.round}/${rework.maxRounds} 轮返工要求发给子 Agent，等待其完成后的自动通知即可。`,
        }),
      });
    },
  });

  register({
    name: "task_ask_user",
    title: "Ask the user to make a structured decision",
    description:
      "当遇到只有用户能拍板的产品取舍、架构分叉、高风险操作或返工 2 轮仍需决定时调用，在主对话流生成原生决策卡；用户选择后系统会自动转达给子 Agent。",
    inputSchema: z.object({
      title: z.string().trim().min(1).describe("关联任务或决策主题标题。"),
      question: z.string().trim().min(1).describe("一句话清晰描述需要用户拍板的问题。"),
      agentId: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe("关联的子 Agent ID（用户回答后自动发给它）。"),
      planId: z.string().trim().min(1).optional().describe("关联的计划 ID。"),
      taskId: z.string().trim().min(1).optional().describe("关联的任务 ID。"),
      options: z
        .array(MainChatDecisionOptionSchema)
        .min(2)
        .max(4)
        .describe("2-4 个互斥清晰的可选方案，每个包含 id、label、leadsTo。"),
      recommendedOptionId: z.string().trim().min(1).optional().describe("你推荐的选项 id。"),
      reason: z.string().trim().min(1).optional().describe("为什么这件事需要用户决定。"),
    }),
    outputSchema: {
      decision: MainChatDecisionRecordSchema,
      guidance: z.string(),
    },
    async handler(rawInput) {
      const input = rawInput as {
        title: string;
        question: string;
        agentId?: string;
        planId?: string;
        taskId?: string;
        options: Array<z.infer<typeof MainChatDecisionOptionSchema>>;
        recommendedOptionId?: string;
        reason?: string;
      };
      const decision = await mainChatService.askUserDecision(callerAgentId, input);
      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          decision,
          guidance:
            "决策卡已展示给用户等待选择。请简短总结问题并结束本轮，用户点击选项后系统会自动把结论发给对应子 Agent。",
        }),
      });
    },
  });

  register({
    name: "task_complete",
    title: "Record verified task receipt",
    description:
      "在独立复核子 Agent 的真实结果并确认逐条通过验收标准后调用，向主对话流输出一张原生完成回执卡片。",
    inputSchema: z.object({
      title: z.string().trim().min(1).describe("已完成的任务标题。"),
      summary: z.string().trim().min(1).describe("简明写出改了什么或得出了什么结论。"),
      agentId: z.string().trim().min(1).optional().describe("关联的子 Agent ID。"),
      planId: z.string().trim().min(1).optional().describe("关联的计划 ID。"),
      taskId: z.string().trim().min(1).optional().describe("关联的任务 ID。"),
      checks: z.array(MainChatReceiptCheckSchema).default([]).describe("逐条验收核对结果与证据。"),
      nextSteps: z.array(z.string().trim().min(1)).default([]).describe("可选的下一步建议。"),
    }),
    outputSchema: {
      receipt: MainChatTaskReceiptSchema,
    },
    async handler(rawInput) {
      const input = rawInput as {
        title: string;
        summary: string;
        agentId?: string;
        planId?: string;
        taskId?: string;
        checks?: Array<z.infer<typeof MainChatReceiptCheckSchema>>;
        nextSteps?: string[];
      };
      const receipt = await mainChatService.recordReceipt(
        {
          title: input.title,
          summary: input.summary,
          agentId: input.agentId ?? null,
          planId: input.planId ?? null,
          taskId: input.taskId ?? null,
          checks: input.checks ?? [],
          nextSteps: input.nextSteps ?? [],
        },
        callerAgentId,
      );
      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({ receipt }),
      });
    },
  });

  register({
    name: "task_plan_withdraw",
    title: "Withdraw an unstarted task plan",
    description:
      "当尚未开始的 open 状态计划卡已经过时、需求已变化或已在别处完成时，主动调用此工具写明原因将其撤回，避免留下僵尸计划卡。",
    inputSchema: z.object({
      planId: z.string().trim().min(1).describe("要撤回的 open 状态计划 ID。"),
      reason: z.string().trim().min(1).max(500).describe("撤回该计划的具体理由。"),
    }),
    outputSchema: {
      plan: MainChatPlanRecordSchema,
      guidance: z.string(),
    },
    async handler(rawInput) {
      const input = rawInput as {
        planId: string;
        reason: string;
      };
      const plan = await mainChatService.withdrawPlan(input.planId, input.reason);
      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          plan,
          guidance: `计划 ${plan.id} 已撤回（原因：${plan.withdrawReason ?? input.reason}）。`,
        }),
      });
    },
  });

  register({
    name: "task_scope",
    title: "Update task brief scope revision",
    description:
      "任务进行中目标、验收标准或边界约束变更时调用。会严格递增 brief.scopeRevision 并更新时间戳；若任务当前有活跃子 Agent，系统会自动向其注入范围变更通知，防止按旧口径继续执行。",
    inputSchema: z.object({
      taskId: z.string().trim().min(1).describe("要更新范围的任务 ID。"),
      goal: z.string().trim().min(1).max(4000).optional().describe("更新后的任务目标。"),
      doneWhen: z
        .array(z.string().trim().min(1))
        .optional()
        .describe("更新后的验收标准列表（write 任务仍须至少 1 条）。"),
      outOfBounds: z.array(z.string().trim().min(1)).optional().describe("更新后的边界约束列表。"),
      reason: z.string().trim().min(1).max(500).optional().describe("范围变更原因说明。"),
    }),
    outputSchema: {
      task: MainChatTaskRecordSchema,
      guidance: z.string(),
    },
    async handler(rawInput) {
      const input = rawInput as {
        taskId: string;
        goal?: string;
        doneWhen?: string[];
        outOfBounds?: string[];
        reason?: string;
      };
      const task = await mainChatService.updateTaskScope(input);
      const guidance = task.activeAgentId
        ? `任务「${task.title}」范围已升级至 Scope Revision #${task.brief.scopeRevision}，并已自动通知活跃子 Agent（${task.activeAgentId}）。`
        : `任务「${task.title}」范围已升级至 Scope Revision #${task.brief.scopeRevision}。`;
      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({ task, guidance }),
      });
    },
  });

  register({
    name: "task_review",
    title: "Accept or send structured rework on a task",
    description:
      "独立复核子 Agent 的真实结果后调用：verdict='accept' 标记任务完成、写入耗时自学习样本并落完成回执；verdict='rework' 携带具体缺口打回子 Agent 返工（自动附带已拍板决策清单并受返工轮次上限保护）。",
    inputSchema: z.object({
      taskId: z.string().trim().min(1).describe("要验收或打回返工的任务 ID。"),
      verdict: MainChatTaskReviewVerdictSchema.describe(
        "accept 表示验收通过；rework 表示退回子 Agent 返工。",
      ),
      summary: z.string().trim().min(1).max(4000).optional().describe("验收通过时的结果摘要。"),
      gaps: z
        .array(z.string().trim().min(1))
        .optional()
        .describe("verdict='rework' 时必填，列出未满足的具体验收缺口。"),
      checks: z
        .array(MainChatReceiptCheckSchema)
        .optional()
        .describe("verdict='accept' 时的逐条验收核对结果与证据。"),
      nextSteps: z
        .array(z.string().trim().min(1))
        .optional()
        .describe("verdict='accept' 时的可选下一步建议。"),
      note: z.string().trim().min(1).max(2000).optional().describe("补充说明或返工优先修复建议。"),
    }),
    outputSchema: {
      task: MainChatTaskRecordSchema,
      receipt: MainChatTaskReceiptSchema.nullable(),
      rework: MainChatReworkRecordSchema.nullable(),
      guidance: z.string(),
    },
    async handler(rawInput) {
      const input = rawInput as {
        taskId: string;
        verdict: "accept" | "rework";
        summary?: string;
        gaps?: string[];
        checks?: Array<z.infer<typeof MainChatReceiptCheckSchema>>;
        nextSteps?: string[];
        note?: string;
      };
      const outcome = await mainChatService.reviewTask(input);
      const guidance =
        input.verdict === "accept"
          ? `任务「${outcome.task.title}」已验收完成并记录完成回执与耗时样本，请用一两句话向用户同步结论。`
          : `已向子 Agent 发起第 ${outcome.rework?.round ?? 1}/${outcome.rework?.maxRounds ?? 2} 轮返工并切回运行中，等待自动通知即可。`;
      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          task: outcome.task,
          receipt: outcome.receipt,
          rework: outcome.rework,
          guidance,
        }),
      });
    },
  });
}
