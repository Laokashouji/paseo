import { z } from "zod";
import {
  MainChatConversationRecordSchema,
  MainChatDecisionOptionSchema,
  MainChatDecisionRecordSchema,
  isMainChatLabels,
  type MainChatConversationKind,
  type MainChatConversationRecord,
  type MainChatDecisionOption,
  type MainChatDecisionRecord,
} from "@getpaseo/protocol/main-chat";
import type { ProviderPaseoToolsPolicy } from "@getpaseo/protocol/provider-config";
import { isPaseoToolEnabled } from "../agent/paseo-tool-policy.js";
import { addModelVisibleStructuredContent } from "../agent/tools/paseo-tool-serialization.js";
import { PaseoToolInputError, type PaseoToolDefinition } from "../agent/tools/types.js";
import { ensureValidJson } from "../json-utils.js";
import {
  ConversationTailMessageSchema,
  getMainChatConversationMetaFromLabels,
  type MainChatConversationManager,
} from "./conversations.js";

export const LEADER_CONVERSATION_TOOL_NAMES = [
  "conversation_new",
  "conversation_send",
  "conversation_read",
  "leader_progress",
  "ask_escalate",
] as const;

const DEFAULT_PAIR_WINDOW_MS = 10 * 60 * 1_000;
const DEFAULT_MAX_PAIR_MESSAGES_PER_WINDOW = 20;
const DEFAULT_PING_PONG_WINDOW_MS = 60 * 60 * 1_000;
const DEFAULT_MAX_PING_PONG_ROUNDS_PER_HOUR = 6;
const DEFAULT_READ_TAIL_LIMIT = 8;

export interface LeaderProgressReportInput {
  conversationId: string;
  conversationTitle: string;
  leaderAgentId: string;
  summary: string;
  completedItems: string[];
  activeCount: number | null;
  blockedItems: string[];
  reportedAt: string;
}

export interface LeaderProgressReportResult {
  delivered: boolean;
  throttled?: boolean;
  reportId?: string;
  notice?: string;
}

export interface EscalateDecisionToMainInput {
  fromConversationId: string;
  fromConversationTitle: string;
  fromAgentId: string;
  title: string;
  question: string;
  background: string;
  options: MainChatDecisionOption[];
  recommendedOptionId?: string;
  whyUserMustDecide: string;
  taskId?: string;
  agentId?: string;
}

export interface EscalatedDecisionReasonInput {
  fromConversationTitle: string;
  background: string;
  whyUserMustDecide: string;
}

export interface LeaderToolsAgentLookup {
  getAgent(id: string): { id: string; labels: Record<string, string> } | null;
}

export interface ConversationRelayGuardOptions {
  pairWindowMs?: number;
  maxPairMessagesPerWindow?: number;
  pingPongWindowMs?: number;
  maxPingPongRoundsPerWindow?: number;
  now?: () => number;
}

export interface ConversationRelayGuard {
  checkAndRecord(fromConversationId: string, toConversationId: string): void;
  resetForConversation(conversationId: string): void;
}

interface PairRelayState {
  timestamps: number[];
  lastSenderId: string | null;
  alternationTimestamps: number[];
}

export function createConversationRelayGuard(
  options?: ConversationRelayGuardOptions,
): ConversationRelayGuard {
  const pairWindowMs = options?.pairWindowMs ?? DEFAULT_PAIR_WINDOW_MS;
  const maxPairMessages = options?.maxPairMessagesPerWindow ?? DEFAULT_MAX_PAIR_MESSAGES_PER_WINDOW;
  const pingPongWindowMs = options?.pingPongWindowMs ?? DEFAULT_PING_PONG_WINDOW_MS;
  const maxPingPongRounds =
    options?.maxPingPongRoundsPerWindow ?? DEFAULT_MAX_PING_PONG_ROUNDS_PER_HOUR;
  const getNowMs = options?.now ?? (() => Date.now());
  const pairs = new Map<string, PairRelayState>();

  function pairKey(left: string, right: string): string {
    return left < right ? `${left}::${right}` : `${right}::${left}`;
  }

  return {
    checkAndRecord(fromConversationId, toConversationId) {
      const nowMs = getNowMs();
      const key = pairKey(fromConversationId, toConversationId);
      const state: PairRelayState = pairs.get(key) ?? {
        timestamps: [],
        lastSenderId: null,
        alternationTimestamps: [],
      };

      state.timestamps = state.timestamps.filter((ts) => nowMs - ts < pairWindowMs);
      state.alternationTimestamps = state.alternationTimestamps.filter(
        (ts) => nowMs - ts < pingPongWindowMs,
      );

      if (state.timestamps.length >= maxPairMessages) {
        throw new PaseoToolInputError(
          `对话间消息频率触发熔断（10 分钟内上限 ${maxPairMessages} 条），请合并信息后再发送或由用户介入。`,
        );
      }

      const isAlternation =
        state.lastSenderId !== null && state.lastSenderId !== fromConversationId;
      if (isAlternation && state.alternationTimestamps.length >= maxPingPongRounds) {
        throw new PaseoToolInputError(
          `对话间往返轮次已达上限（1 小时内 ${maxPingPongRounds} 轮），已暂停自动接力以防死循环，请等待用户发话解锁。`,
        );
      }

      state.timestamps.push(nowMs);
      if (isAlternation) {
        state.alternationTimestamps.push(nowMs);
      }
      state.lastSenderId = fromConversationId;
      pairs.set(key, state);
    },

    resetForConversation(conversationId) {
      for (const key of Array.from(pairs.keys())) {
        const [left, right] = key.split("::");
        if (left === conversationId || right === conversationId) {
          pairs.delete(key);
        }
      }
    },
  };
}

export function formatLeaderProgressMessage(input: LeaderProgressReportInput): string {
  const lines: string[] = [
    `[方向主管进度汇报 · ${input.conversationTitle} (${input.conversationId})]`,
    `摘要：${input.summary}`,
  ];
  if (input.activeCount !== null) {
    lines.push(`当前运行中任务数：${input.activeCount}`);
  }
  if (input.completedItems.length > 0) {
    lines.push("本阶段已完成：");
    for (const item of input.completedItems) {
      lines.push(`- ${item}`);
    }
  }
  if (input.blockedItems.length > 0) {
    lines.push("当前阻塞/关注点：");
    for (const item of input.blockedItems) {
      lines.push(`- ${item}`);
    }
  }
  return lines.join("\n");
}

export function formatEscalatedDecisionReason(input: EscalatedDecisionReasonInput): string {
  return [
    `来自方向主管「${input.fromConversationTitle}」升级`,
    `背景：${input.background}`,
    `需用户拍板原因：${input.whyUserMustDecide}`,
  ].join("\n");
}

export interface RegisterLeaderConversationToolsDeps {
  agentManager: LeaderToolsAgentLookup;
  conversationManager?: MainChatConversationManager | null;
  callerAgentId?: string;
  scope: "agent" | "top-level";
  tools: Map<string, PaseoToolDefinition>;
  builtinNames: Set<string>;
  policy?: ProviderPaseoToolsPolicy;
  relayGuard?: ConversationRelayGuard;
  progressCooldownMs?: number;
  reportLeaderProgress?: (
    input: LeaderProgressReportInput,
  ) => Promise<LeaderProgressReportResult | void>;
  escalateDecisionToMain?: (input: EscalateDecisionToMainInput) => Promise<MainChatDecisionRecord>;
  now?: () => number;
}

const ConversationNewInputSchema = z.object({
  kind: z
    .enum(["side", "leader"])
    .describe("对话类型：side 为专题侧对话；leader 为常驻方向主管对话（上限 20 个）。"),
  title: z.string().trim().min(1).max(80).describe("对话或方向标题。"),
  directionSummary: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .describe("方向定位或讨论议题说明（可选）。"),
  initialPrompt: z
    .string()
    .trim()
    .max(8000)
    .optional()
    .describe("创建完成后立即投递的首轮消息（可选）。"),
});

const ConversationSendInputSchema = z.object({
  conversationId: z.string().trim().min(1).describe("目标对话 ID。"),
  message: z.string().trim().min(1).max(8000).describe("要发送给目标对话的指示、结论或问题。"),
});

const ConversationReadInputSchema = z.object({
  conversationId: z.string().trim().min(1).describe("目标对话 ID。"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(30)
    .default(DEFAULT_READ_TAIL_LIMIT)
    .describe("读取最近几轮消息（默认 8，上限 30，自动按上下文预算受控截断）。"),
});

const LeaderProgressInputSchema = z.object({
  summary: z
    .string()
    .trim()
    .min(1)
    .max(1200)
    .describe("本方向阶段性里程碑汇总（1-3 句话，结论先行）。"),
  completedItems: z
    .array(z.string().trim().min(1).max(200))
    .max(10)
    .default([])
    .describe("本阶段已完成的关键事项列表（可选）。"),
  activeCount: z
    .number()
    .int()
    .min(0)
    .max(200)
    .optional()
    .describe("本方向当前仍在推进中的任务或子 Agent 数量（可选）。"),
  blockedItems: z
    .array(z.string().trim().min(1).max(200))
    .max(10)
    .default([])
    .describe("当前受阻事项（可选；需用户拍板的红线项请改用 ask_escalate）。"),
});

const AskEscalateInputSchema = z.object({
  title: z.string().trim().min(1).max(120).describe("需要升级拍板的事项或关联任务标题。"),
  question: z.string().trim().min(1).max(1000).describe("一句话清晰描述必须由用户拍板的问题。"),
  background: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("精简必要的背景事实与已核查结论，让用户无需翻日志即可做决定。"),
  options: z
    .array(MainChatDecisionOptionSchema)
    .min(2)
    .max(4)
    .describe("2-4 个互斥清晰的可选方案，每项包含 id、label、leadsTo。"),
  recommendedOptionId: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("你推荐的选项 id（必须存在于 options 中）。"),
  whyUserMustDecide: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .describe("明确说明为何该事项触及红线、产品取舍或超出主管权限，必须由用户拍板。"),
  taskId: z.string().trim().min(1).optional().describe("关联的任务 ID（可选）。"),
  agentId: z.string().trim().min(1).optional().describe("关联的子 Agent ID（可选）。"),
});

function parseOrThrow<T extends z.ZodType>(
  schema: T,
  rawInput: unknown,
  toolName: string,
): z.infer<T> {
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    throw new PaseoToolInputError(
      `Invalid input for ${toolName}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

function resolveInitialCallerKind(
  callerAgent: { id: string; labels: Record<string, string> } | null,
  callerConversation: MainChatConversationRecord | null,
): MainChatConversationKind | null {
  if (callerConversation) {
    return callerConversation.kind;
  }
  if (!callerAgent) {
    return null;
  }
  if (isMainChatLabels(callerAgent.labels)) {
    return "main";
  }
  return getMainChatConversationMetaFromLabels(callerAgent.labels)?.kind ?? null;
}

function validateEscalationOptions(
  options: readonly MainChatDecisionOption[],
  recommendedOptionId: string | undefined,
): void {
  const seenIds = new Set<string>();
  for (const option of options) {
    const id = option.id.trim();
    const label = option.label.trim();
    const leadsTo = option.leadsTo.trim();
    if (!id || !label || !leadsTo) {
      throw new PaseoToolInputError("ask_escalate 的每个选项都必须包含非空的 id、label、leadsTo。");
    }
    if (seenIds.has(id)) {
      throw new PaseoToolInputError(`ask_escalate 存在重复的选项 id：${id}`);
    }
    seenIds.add(id);
  }
  if (recommendedOptionId && !seenIds.has(recommendedOptionId)) {
    throw new PaseoToolInputError(
      `recommendedOptionId「${recommendedOptionId}」不在 options 列表中。`,
    );
  }
}

export function registerLeaderConversationTools(deps: RegisterLeaderConversationToolsDeps): void {
  const { agentManager, conversationManager, callerAgentId, scope, tools, builtinNames, policy } =
    deps;
  if (!conversationManager || scope !== "agent" || !callerAgentId) return;

  const callerAgent = agentManager.getAgent(callerAgentId);
  const initialConversation = conversationManager.getConversationByAgentId(callerAgentId);
  const callerKind = resolveInitialCallerKind(callerAgent, initialConversation);
  if (!callerKind) return;

  const getNowMs = deps.now ?? (() => Date.now());
  const relayGuard = deps.relayGuard ?? createConversationRelayGuard({ now: getNowMs });
  const progressCooldownMs = Math.max(0, deps.progressCooldownMs ?? 0);
  const lastProgressReportedAtByConversation = new Map<string, number>();

  const register = (def: PaseoToolDefinition) => {
    builtinNames.add(def.name);
    if (!isPaseoToolEnabled(policy, def.name)) return;
    tools.set(def.name, def);
  };

  function resolveLiveCallerConversation(): MainChatConversationRecord | null {
    return conversationManager!.getConversationByAgentId(callerAgentId!);
  }

  function requireActiveLeaderConversation(toolName: string): MainChatConversationRecord {
    const current = resolveLiveCallerConversation();
    if (!current || current.kind !== "leader" || current.archivedAt !== null) {
      throw new PaseoToolInputError(`仅活跃的常驻方向主管（leader）对话可调用 ${toolName}。`);
    }
    return current;
  }

  register({
    name: "conversation_new",
    title: "Create a side or leader conversation",
    description:
      "创建一条新的专题侧对话（side）或常驻方向主管对话（leader，最多 20 个）。可选传入 initialPrompt 立即发送首轮任务或议题说明。",
    inputSchema: ConversationNewInputSchema,
    outputSchema: {
      conversation: MainChatConversationRecordSchema,
      guidance: z.string(),
    },
    async handler(rawInput) {
      const input = parseOrThrow(ConversationNewInputSchema, rawInput, "conversation_new");
      const callerConv = resolveLiveCallerConversation();
      const conversation = await conversationManager.createConversation({
        kind: input.kind,
        title: input.title,
        directionSummary: input.directionSummary || null,
        initialPrompt: input.initialPrompt || undefined,
        parentConversationId: callerConv?.id ?? undefined,
      });
      const kindLabel = conversation.kind === "leader" ? "常驻方向主管对话" : "专题侧对话";
      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          conversation,
          guidance: `已创建${kindLabel}「${conversation.title}」（id=${conversation.id}）${input.initialPrompt ? "并投递首轮消息" : ""}。`,
        }),
      });
    },
  });

  register({
    name: "conversation_send",
    title: "Send a message to another conversation",
    description:
      "向指定 conversationId 的主对话、方向主管或侧对话发送指示、结论或协作问题。禁止给自己发消息以防止自发死循环。",
    inputSchema: ConversationSendInputSchema,
    outputSchema: {
      conversation: MainChatConversationRecordSchema,
      deliveredAt: z.string(),
      guidance: z.string(),
    },
    async handler(rawInput) {
      const input = parseOrThrow(ConversationSendInputSchema, rawInput, "conversation_send");
      const target = conversationManager.getConversation(input.conversationId);
      const callerConv = resolveLiveCallerConversation();
      const callerLabelMeta = getMainChatConversationMetaFromLabels(
        agentManager.getAgent(callerAgentId)?.labels,
      );

      const isSelfTarget =
        (callerConv !== null && callerConv.id === input.conversationId) ||
        (callerLabelMeta?.conversationId !== null &&
          callerLabelMeta?.conversationId === input.conversationId) ||
        (target !== null && target.agentId === callerAgentId);

      if (isSelfTarget) {
        throw new PaseoToolInputError("禁止向当前对话自身发送消息（防止自发死循环）。");
      }

      const senderId = callerConv?.id ?? callerLabelMeta?.conversationId ?? callerAgentId;
      relayGuard.checkAndRecord(senderId, input.conversationId);

      const sent = await conversationManager.sendToConversation(
        input.conversationId,
        input.message,
        {
          fromConversationId: callerConv?.id ?? null,
          fromTitle: callerConv?.title ?? null,
        },
      );

      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          conversation: sent.conversation,
          deliveredAt: sent.deliveredAt,
          guidance: `已将消息投递给对话「${sent.conversation.title}」（id=${sent.conversation.id}）。`,
        }),
      });
    },
  });

  register({
    name: "conversation_read",
    title: "Read recent turns and status of a conversation",
    description:
      "读取目标对话的元信息、当前运行状态及最近几轮摘要（默认 8 条，自动受控截断避免顶爆上下文）。",
    inputSchema: ConversationReadInputSchema,
    outputSchema: {
      conversation: MainChatConversationRecordSchema,
      lifecycle: z.string(),
      messages: z.array(ConversationTailMessageSchema),
      truncated: z.boolean(),
      summary: z.string(),
    },
    async handler(rawInput) {
      const input = parseOrThrow(ConversationReadInputSchema, rawInput, "conversation_read");
      const tail = await conversationManager.readConversationTail(input.conversationId, {
        limit: input.limit,
      });
      const truncationSuffix = tail.truncated ? "（内容已按上下文预算截断）" : "";
      const summary = `对话「${tail.conversation.title}」(${tail.conversation.kind}) 当前运行态 ${tail.lifecycle}，返回最近 ${tail.messages.length} 条记录${truncationSuffix}。`;

      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          conversation: tail.conversation,
          lifecycle: tail.lifecycle,
          messages: tail.messages,
          truncated: tail.truncated,
          summary,
        }),
      });
    },
  });

  if (callerKind !== "leader") {
    return;
  }

  register({
    name: "leader_progress",
    title: "Report direction milestone progress to main chat",
    description:
      "供常驻方向主管调用：将本方向的阶段性里程碑、完成事项、运行中任务数与受阻项简洁汇总上报给主对话（走受控回报通道，避免刷屏）。",
    inputSchema: LeaderProgressInputSchema,
    outputSchema: {
      delivered: z.boolean(),
      throttled: z.boolean(),
      conversationId: z.string(),
      reportedAt: z.string(),
      guidance: z.string(),
    },
    async handler(rawInput) {
      const input = parseOrThrow(LeaderProgressInputSchema, rawInput, "leader_progress");
      const leaderConv = requireActiveLeaderConversation("leader_progress");
      const nowMs = getNowMs();
      const reportedAt = new Date(nowMs).toISOString();

      const lastReportedAtMs = lastProgressReportedAtByConversation.get(leaderConv.id);
      const isNonUrgent = input.blockedItems.length === 0;
      if (
        progressCooldownMs > 0 &&
        isNonUrgent &&
        lastReportedAtMs !== undefined &&
        nowMs - lastReportedAtMs < progressCooldownMs
      ) {
        return addModelVisibleStructuredContent({
          content: [],
          structuredContent: ensureValidJson({
            delivered: false,
            throttled: true,
            conversationId: leaderConv.id,
            reportedAt,
            guidance:
              "距离上次常规进度回报间隔过短，已触发防刷屏节流；请等待本阶段有新里程碑后再上报。",
          }),
        });
      }

      const payload: LeaderProgressReportInput = {
        conversationId: leaderConv.id,
        conversationTitle: leaderConv.title,
        leaderAgentId: callerAgentId,
        summary: input.summary,
        completedItems: input.completedItems,
        activeCount: input.activeCount ?? null,
        blockedItems: input.blockedItems,
        reportedAt,
      };

      let delivered = true;
      let throttled = false;
      let customNotice: string | undefined;

      if (deps.reportLeaderProgress) {
        const result = await deps.reportLeaderProgress(payload);
        if (result) {
          delivered = result.delivered;
          throttled = result.throttled === true;
          customNotice = result.notice;
        }
      } else {
        const allConversations = await conversationManager.listConversations();
        const mainConv = allConversations.find((entry) => entry.kind === "main");
        if (!mainConv) {
          throw new PaseoToolInputError("未找到主对话根记录，无法投递方向主管进度回报。");
        }
        await conversationManager.sendToConversation(
          mainConv.id,
          formatLeaderProgressMessage(payload),
          {
            fromConversationId: leaderConv.id,
            fromTitle: leaderConv.title,
          },
        );
      }

      if (delivered) {
        lastProgressReportedAtByConversation.set(leaderConv.id, nowMs);
      }

      const guidance =
        customNotice ??
        (throttled
          ? "回报已进入主对话节流队列，无需重复发送。"
          : "已将阶段性里程碑汇总上报至主对话，请继续独立推进本方向后续任务。");

      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          delivered,
          throttled,
          conversationId: leaderConv.id,
          reportedAt,
          guidance,
        }),
      });
    },
  });

  register({
    name: "ask_escalate",
    title: "Escalate a high-risk or user-only decision to main chat",
    description:
      "供常驻方向主管调用：将触及红线、产品取舍、架构分叉或必须由用户拍板的事项一次性结构化升级为主对话待拍板卡。",
    inputSchema: AskEscalateInputSchema,
    outputSchema: {
      decision: MainChatDecisionRecordSchema,
      escalatedFromConversationId: z.string(),
      guidance: z.string(),
    },
    async handler(rawInput) {
      const input = parseOrThrow(AskEscalateInputSchema, rawInput, "ask_escalate");
      const leaderConv = requireActiveLeaderConversation("ask_escalate");
      validateEscalationOptions(input.options, input.recommendedOptionId);

      if (!deps.escalateDecisionToMain) {
        throw new PaseoToolInputError(
          "未配置主对话升级拍板通道（escalateDecisionToMain），无法创建待拍板卡。",
        );
      }

      const rawDecision = await deps.escalateDecisionToMain({
        fromConversationId: leaderConv.id,
        fromConversationTitle: leaderConv.title,
        fromAgentId: callerAgentId,
        title: input.title,
        question: input.question,
        background: input.background,
        options: input.options,
        recommendedOptionId: input.recommendedOptionId,
        whyUserMustDecide: input.whyUserMustDecide,
        taskId: input.taskId,
        agentId: input.agentId,
      });
      const decision = MainChatDecisionRecordSchema.parse(rawDecision);

      return addModelVisibleStructuredContent({
        content: [],
        structuredContent: ensureValidJson({
          decision,
          escalatedFromConversationId: leaderConv.id,
          guidance:
            "已将该事项结构化升级为主对话待拍板卡并通知主对话，请暂停高风险动作并等待用户结论。",
        }),
      });
    },
  });
}
