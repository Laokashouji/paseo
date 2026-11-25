import { z } from "zod";
import {
  MainChatStatelessSupervisionDecisionSchema,
  isMainChatStatelessBackgroundSupervisionEnabled,
  type MainChatSettings,
  type MainChatStatelessSupervisionDecision,
  type MainChatSupervisionSignal,
  type MainChatSupervisionSignalKind,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import type { AgentManager } from "../agent/agent-manager.js";
import {
  generateStructuredAgentResponseWithFallback,
  type StructuredGenerationLogger,
  type StructuredGenerationProvider,
} from "../agent/agent-response-loop.js";
import type { AgentProvider, AgentUsage } from "../agent/agent-sdk-types.js";

export const StatelessSupervisionDispositionSchema = z.object({
  signalId: z.string(),
  action: z.enum(["held", "noted", "escalate"]),
  note: z.string().max(180),
});

export const StatelessSupervisionOutcomeSchema = z.object({
  decision: MainChatStatelessSupervisionDecisionSchema,
  summary: z.string().trim().min(1).max(320),
  escalationReason: z.string().trim().max(240).nullable().optional(),
  recommendedAction: z.string().trim().max(240).nullable().optional(),
  signalDispositions: z.array(StatelessSupervisionDispositionSchema).optional(),
});
export type StatelessSupervisionOutcome = z.infer<typeof StatelessSupervisionOutcomeSchema>;

export interface StatelessSupervisionPacketInput {
  signals: readonly MainChatSupervisionSignal[];
  relatedTasks: readonly MainChatTaskRecord[];
  conversationLabel?: string | null;
  fleetCounts?: {
    totalActive: number;
    running: number;
    needsYou: number;
    problematic: number;
  } | null;
}

export interface StatelessSupervisionRunnerInput {
  cwd: string;
  packet: string;
  signals: readonly MainChatSupervisionSignal[];
  relatedTasks: readonly MainChatTaskRecord[];
  providers: readonly StructuredGenerationProvider[];
}

export type StatelessSupervisionRunner = (input: StatelessSupervisionRunnerInput) => Promise<{
  outcome: StatelessSupervisionOutcome;
  usage?: AgentUsage;
  provider?: AgentProvider;
  model?: string | null;
} | null>;

const HARD_MAIN_ESCALATION_KINDS: ReadonlySet<MainChatSupervisionSignalKind> = new Set([
  "ask",
  "needs_you",
  "decide",
  "escalated",
  "decision_reply",
]);

const RULE_ESCALATION_KINDS: ReadonlySet<MainChatSupervisionSignalKind> = new Set([
  "ask",
  "needs_you",
  "decide",
  "escalated",
  "decision_reply",
  "failed",
  "timed_out",
  "all_stopped",
  "leader_stuck",
  "todo_ready",
  "parent_closeout",
  "review",
  "pr_conflict",
]);

function clipOneLine(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

export interface StatelessSupervisionEligibility {
  eligible: boolean;
  reason: string;
}

/**
 * Determines whether a supervision batch can be evaluated in a compact stateless single round
 * instead of waking the full interactive main-chat session and disturbing its Prompt Cache.
 */
export function shouldRunStatelessSupervisionRound(input: {
  settings: Pick<MainChatSettings, "statelessBackgroundSupervision">;
  signals: readonly MainChatSupervisionSignal[];
  forced: boolean;
  hasPassthroughSignal: boolean;
}): StatelessSupervisionEligibility {
  if (!isMainChatStatelessBackgroundSupervisionEnabled(input.settings)) {
    return { eligible: false, reason: "feature_disabled" };
  }
  if (input.forced) {
    return { eligible: false, reason: "manual_patrol_trigger" };
  }
  if (input.hasPassthroughSignal) {
    return { eligible: false, reason: "critical_passthrough_signal" };
  }
  if (input.signals.length === 0) {
    return { eligible: false, reason: "empty_batch" };
  }
  for (const signal of input.signals) {
    if (HARD_MAIN_ESCALATION_KINDS.has(signal.kind)) {
      return { eligible: false, reason: `hard_main_signal:${signal.kind}` };
    }
  }
  return { eligible: true, reason: "routine_low_risk_batch" };
}

/**
 * Builds a strictly bounded single-round stateless supervision packet without dragging
 * main-chat conversation history.
 */
export function buildCompactStatelessSupervisionPacket(
  input: StatelessSupervisionPacketInput,
): string {
  const lines: string[] = [
    "你是 Paseo 的无状态单轮后台督办评估器（不携带主对话历史，不调用任何工具）。",
    "请仅依据下方紧凑信号与关联任务摘要，判断本批动态是否可静默留档，还是必须升级唤醒主对话处理。",
    "",
    "判定规则：",
    "- decision='silent'：所有信号均属例行心跳、无异常变化或已自愈，静默记录即可。",
    "- decision='log_only'：低风险进展汇报、常规状态变更或可延后查收的信息，结构化记入后台折叠流与活动台账，不打断主对话。",
    "- decision='escalate_main'：存在需要用户拍板、多轮编排验收、任务阻塞/失败恢复、或下游解锁需拉起子任务的情况，必须升级到主对话处理。",
    "- 安全红线：涉及权限审批、外部副作用、用户拍板或方向决策时，必须返回 escalate_main，禁止私下吞掉。",
  ];

  if (input.conversationLabel?.trim()) {
    lines.push("", `目标会话：${clipOneLine(input.conversationLabel, 60)}`);
  }

  if (input.fleetCounts) {
    lines.push(
      `全局紧凑态势：活跃 ${input.fleetCounts.totalActive} · 运行中 ${input.fleetCounts.running} · 待你 ${input.fleetCounts.needsYou} · 异常 ${input.fleetCounts.problematic}`,
    );
  }

  lines.push("", `本轮待评估信号（${input.signals.length} 条）：`);
  for (const signal of input.signals.slice(0, 12)) {
    const taskPart = signal.taskId ? ` task=${signal.taskId}` : "";
    const agentPart = signal.agentId ? ` agent=${signal.agentId.slice(0, 12)}` : "";
    lines.push(
      `- [${signal.id}] (${signal.kind}/${signal.urgency}${taskPart}${agentPart}) 「${clipOneLine(signal.title, 48)}」：${clipOneLine(signal.summary, 160)}`,
    );
  }

  if (input.relatedTasks.length > 0) {
    lines.push("", "关联任务摘要（仅最近验收与当前状态）：");
    for (const task of input.relatedTasks.slice(0, 8)) {
      const lastReview = task.latestReceipt
        ? ` 最近验收：${clipOneLine(task.latestReceipt.summary, 120)}`
        : "";
      const gatePart = task.deliveryGate?.prUrl
        ? ` PR#${task.deliveryGate.prNumber ?? "?"}=${task.deliveryGate.prState ?? "open"}`
        : "";
      lines.push(
        `- [${task.id}] 「${clipOneLine(task.title, 48)}」status=${task.status} mode=${task.mode}${gatePart}${lastReview}`,
      );
    }
  }

  return lines.join("\n");
}

export function evaluateStatelessSupervisionDeterministicFallback(
  signals: readonly MainChatSupervisionSignal[],
): StatelessSupervisionOutcome {
  const escalateSignals = signals.filter((sig) => RULE_ESCALATION_KINDS.has(sig.kind));
  if (escalateSignals.length > 0) {
    const titles = escalateSignals
      .slice(0, 3)
      .map((sig) => `「${clipOneLine(sig.title, 28)}」(${sig.kind})`)
      .join("、");
    return {
      decision: "escalate_main",
      summary: `无状态单轮督办检测到 ${escalateSignals.length} 条需主对话编排或验收的信号：${titles}`,
      escalationReason: `包含需主对话介入的信号类型：${Array.from(
        new Set(escalateSignals.map((sig) => sig.kind)),
      ).join(", ")}`,
      recommendedAction: "已升级转交主对话做进一步复核或向用户汇报",
      signalDispositions: signals.map((sig) => ({
        signalId: sig.id,
        action: RULE_ESCALATION_KINDS.has(sig.kind) ? "escalate" : "noted",
        note: clipOneLine(sig.summary, 120),
      })),
    };
  }

  const allChecks = signals.every((sig) => sig.kind === "check");
  const decision: MainChatStatelessSupervisionDecision = allChecks ? "silent" : "log_only";
  const leadTitles = signals
    .slice(0, 3)
    .map((sig) => `「${clipOneLine(sig.title, 28)}」`)
    .join("、");
  return {
    decision,
    summary:
      decision === "silent"
        ? `无状态单轮例行检查完成（${signals.length} 条），无异常需打扰主对话`
        : `无状态单轮已留档 ${signals.length} 条低风险动态（${leadTitles}），主对话上下文与 Prompt Cache 未受打扰`,
    escalationReason: null,
    recommendedAction: null,
    signalDispositions: signals.map((sig) => ({
      signalId: sig.id,
      action: decision === "silent" ? "held" : "noted",
      note: clipOneLine(sig.summary, 120),
    })),
  };
}

export interface RunStatelessSupervisionRoundResult {
  outcome: StatelessSupervisionOutcome;
  source: "model" | "rule";
  packet: string;
  packetChars: number;
}

export async function runStatelessBackgroundSupervisionRound(input: {
  agentManager: AgentManager;
  cwd: string;
  signals: readonly MainChatSupervisionSignal[];
  relatedTasks: readonly MainChatTaskRecord[];
  conversationLabel?: string | null;
  fleetCounts?: StatelessSupervisionPacketInput["fleetCounts"];
  providers: readonly StructuredGenerationProvider[];
  runner?: StatelessSupervisionRunner;
  logger?: StructuredGenerationLogger;
  onUsage?: (usage: AgentUsage, meta: { provider: AgentProvider; model: string | null }) => void;
}): Promise<RunStatelessSupervisionRoundResult> {
  const packet = buildCompactStatelessSupervisionPacket({
    signals: input.signals,
    relatedTasks: input.relatedTasks,
    conversationLabel: input.conversationLabel,
    fleetCounts: input.fleetCounts,
  });

  if (input.runner) {
    try {
      const custom = await input.runner({
        cwd: input.cwd,
        packet,
        signals: input.signals,
        relatedTasks: input.relatedTasks,
        providers: input.providers,
      });
      const parsed = custom?.outcome
        ? StatelessSupervisionOutcomeSchema.safeParse(custom.outcome)
        : null;
      if (parsed?.success) {
        if (custom?.usage && custom.provider) {
          input.onUsage?.(custom.usage, {
            provider: custom.provider,
            model: custom.model ?? null,
          });
        }
        return {
          outcome: parsed.data,
          source: "model",
          packet,
          packetChars: packet.length,
        };
      }
    } catch (error) {
      input.logger?.warn?.(
        { err: error },
        "Custom stateless supervision runner failed; falling back to deterministic classifier",
      );
    }
  } else if (input.providers.length > 0) {
    try {
      const generated = await generateStructuredAgentResponseWithFallback({
        manager: input.agentManager,
        cwd: input.cwd,
        prompt: packet,
        schema: StatelessSupervisionOutcomeSchema,
        providers: input.providers,
        persistSession: false,
        logger: input.logger,
        onUsage: input.onUsage,
      });
      if (generated) {
        return {
          outcome: generated,
          source: "model",
          packet,
          packetChars: packet.length,
        };
      }
    } catch (error) {
      input.logger?.warn?.(
        { err: error },
        "Stateless background supervision model call failed; falling back to deterministic rules",
      );
    }
  }

  return {
    outcome: evaluateStatelessSupervisionDeterministicFallback(input.signals),
    source: "rule",
    packet,
    packetChars: packet.length,
  };
}
