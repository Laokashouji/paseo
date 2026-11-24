import type { Logger } from "pino";
import type {
  MainChatConversationRecord,
  MainChatRoutineKind,
  MainChatRoutineOwnerKind,
  MainChatRoutineRecord,
} from "@getpaseo/protocol/main-chat";
import type {
  ScheduleCadence,
  ScheduleExecutionResult,
  StoredSchedule,
} from "@getpaseo/protocol/schedule/types";
import type { AgentManager } from "../agent/agent-manager.js";
import { formatSystemNotificationPrompt } from "../agent/agent-messages/index.js";
import { sendPreparedPromptToAgent } from "../agent/agent-prompt.js";
import type { AgentStorage } from "../agent/agent-storage.js";
import type { ScheduleService } from "../schedule/service.js";
import { ScheduleTargetGoneError } from "../schedule/service.js";
import { MAIN_CONVERSATION_ID } from "./conversations.js";
import type { MainChatStore } from "./store.js";
import type { MainChatTurnQueue } from "./turn-queue.js";

const MIN_ONE_SHOT_DELAY_MS = 1_000;
const MAX_ONE_SHOT_DELAY_MS = 30 * 24 * 60 * 60 * 1_000;

export interface CreateMainChatRoutineInput {
  name?: string | null;
  prompt: string;
  kind?: MainChatRoutineKind;
  cadence?: ScheduleCadence;
  runAt?: string | null;
  delayMinutes?: number | null;
  conversationId?: string | null;
  maxRuns?: number | null;
  expiresAt?: string | null;
  runOnCreate?: boolean;
}

export interface ListMainChatRoutinesOptions {
  conversationId?: string;
  includeCompleted?: boolean;
}

export interface MainChatRoutinesManagerDependencies {
  scheduleService: Pick<
    ScheduleService,
    "list" | "inspect" | "create" | "pause" | "resume" | "runOnce" | "delete" | "rebindAgentTarget"
  >;
  agentManager: AgentManager;
  agentStorage: AgentStorage;
  store: MainChatStore;
  turnQueue: MainChatTurnQueue;
  ensureMainChatAgentId: () => Promise<string>;
  findMainChatAgentId: () => Promise<string | null>;
  listConversations: () => Promise<MainChatConversationRecord[]>;
  logger: Logger;
  now?: () => number;
}

export interface MainChatRoutinesManager {
  listRoutines(options?: ListMainChatRoutinesOptions): Promise<MainChatRoutineRecord[]>;
  createRoutine(input: CreateMainChatRoutineInput): Promise<MainChatRoutineRecord>;
  pauseRoutine(routineId: string): Promise<MainChatRoutineRecord>;
  resumeRoutine(routineId: string): Promise<MainChatRoutineRecord>;
  runRoutineOnce(routineId: string): Promise<MainChatRoutineRecord>;
  deleteRoutine(routineId: string): Promise<{ deleted: boolean }>;
  rebindMainAgentRoutines(fromAgentId: string, toAgentId: string): Promise<number>;
  executeIfOwnedRoutine(
    schedule: StoredSchedule,
    runId: string,
  ): Promise<ScheduleExecutionResult | null>;
}

interface OwnerLookupEntry {
  ownerKind: MainChatRoutineOwnerKind;
  conversationId: string;
  conversationTitle: string;
  targetAgentId: string;
}

function makeActivityId(): string {
  return `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function deriveRoutineKind(schedule: StoredSchedule): MainChatRoutineKind {
  return schedule.maxRuns === 1 ? "one_shot" : "recurring";
}

function toRoutineRecord(schedule: StoredSchedule, owner: OwnerLookupEntry): MainChatRoutineRecord {
  const lastRun = schedule.runs.length > 0 ? schedule.runs[schedule.runs.length - 1]! : null;
  return {
    id: schedule.id,
    name: schedule.name,
    prompt: schedule.prompt,
    kind: deriveRoutineKind(schedule),
    cadence: schedule.cadence,
    status: schedule.status,
    ownerKind: owner.ownerKind,
    conversationId: owner.conversationId,
    conversationTitle: owner.conversationTitle,
    targetAgentId: owner.targetAgentId,
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
    nextRunAt: schedule.nextRunAt,
    lastRunAt: schedule.lastRunAt,
    pausedAt: schedule.pausedAt,
    expiresAt: schedule.expiresAt,
    maxRuns: schedule.maxRuns,
    runCount: schedule.runs.length,
    lastRunStatus: lastRun?.status ?? null,
    lastRunOutput: lastRun?.output ?? null,
    lastRunError: lastRun?.error ?? null,
  };
}

function resolveCadenceForCreate(
  input: CreateMainChatRoutineInput,
  nowMs: number,
): { cadence: ScheduleCadence; maxRuns: number | null; runOnCreate: boolean } {
  const isOneShot =
    input.kind === "one_shot" ||
    Boolean(input.runAt?.trim()) ||
    (typeof input.delayMinutes === "number" && Number.isFinite(input.delayMinutes));

  if (isOneShot) {
    let everyMs: number | null = null;
    if (input.runAt?.trim()) {
      const targetMs = Date.parse(input.runAt.trim());
      if (!Number.isFinite(targetMs)) {
        throw new Error(`Invalid runAt timestamp: ${input.runAt}`);
      }
      const deltaMs = targetMs - nowMs;
      if (deltaMs < MIN_ONE_SHOT_DELAY_MS) {
        throw new Error("一次性提醒时间必须晚于当前时间");
      }
      if (deltaMs > MAX_ONE_SHOT_DELAY_MS) {
        throw new Error("一次性提醒时间不能超过 30 天");
      }
      everyMs = Math.round(deltaMs);
    } else if (typeof input.delayMinutes === "number" && Number.isFinite(input.delayMinutes)) {
      if (input.delayMinutes <= 0) {
        throw new Error("提醒延迟分钟数必须大于 0");
      }
      everyMs = Math.min(MAX_ONE_SHOT_DELAY_MS, Math.round(input.delayMinutes * 60_000));
    } else if (input.cadence) {
      return {
        cadence: input.cadence,
        maxRuns: 1,
        runOnCreate: input.runOnCreate ?? false,
      };
    } else {
      throw new Error("一次性提醒需要提供 delayMinutes、runAt 或 cadence");
    }

    return {
      cadence: { type: "every", everyMs },
      maxRuns: 1,
      runOnCreate: input.runOnCreate ?? false,
    };
  }

  if (!input.cadence) {
    throw new Error("周期例行任务需要提供 cadence（every 或 cron）");
  }
  return {
    cadence: input.cadence,
    maxRuns: input.maxRuns ?? null,
    runOnCreate: input.runOnCreate ?? false,
  };
}

function buildMainChatRoutineFirePrompt(
  schedule: StoredSchedule,
  owner: OwnerLookupEntry,
  runId: string,
): string {
  const routineKind = deriveRoutineKind(schedule);
  const title =
    schedule.name?.trim() || (routineKind === "one_shot" ? "一次性提醒" : "定时例行任务");
  const header =
    routineKind === "one_shot"
      ? `⏰ 例行任务 · 一次性提醒触发：「${title}」（id=${schedule.id}, run=${runId}）`
      : `⏰ 例行任务 · 周期调度触发：「${title}」（id=${schedule.id}, run=${runId}）`;
  const ownerNote =
    owner.ownerKind === "leader"
      ? `归属方向：${owner.conversationTitle}（${owner.conversationId}）`
      : "归属对话：主对话";
  const body = [
    header,
    `（这是 Paseo 定时例行任务自动触发，不是用户手打消息。${ownerNote}。）`,
    "",
    "任务指令：",
    schedule.prompt,
    "",
    "处理要求：",
    "- 直接执行核查或整理，结论先行、简明汇报真正值得用户关注的结果。",
    "- 如果本次例行检查未发现需要通知用户的变化，请直接只回复 `[SILENT]`，系统会自动收纳进后台记录。",
  ].join("\n");

  return formatSystemNotificationPrompt(body, {
    kind: "routine",
    trigger: `routine:${schedule.id}`,
    label: title,
    quiet: true,
  });
}

/**
 * Connects Paseo's file-backed `ScheduleService` with Main Chat and Direction Leader conversations,
 * exposing recurring routines and one-shot reminders (`maxRuns = 1`) whose runs land cleanly in
 * the background collapsed stream.
 */
export function createMainChatRoutinesManager(
  deps: MainChatRoutinesManagerDependencies,
): MainChatRoutinesManager {
  const getNowMs = deps.now ?? (() => Date.now());

  async function buildOwnerMap(): Promise<Map<string, OwnerLookupEntry>> {
    const owners = new Map<string, OwnerLookupEntry>();
    const mainAgentId = await deps.findMainChatAgentId();
    const conversations = await deps.listConversations();
    const mainConv = conversations.find(
      (conv) => conv.id === MAIN_CONVERSATION_ID || conv.kind === "main",
    );

    if (mainAgentId) {
      owners.set(mainAgentId, {
        ownerKind: "main",
        conversationId: mainConv?.id ?? MAIN_CONVERSATION_ID,
        conversationTitle: mainConv?.title ?? deps.store.getSettings().title,
        targetAgentId: mainAgentId,
      });
    }

    for (const conv of conversations) {
      if (conv.kind !== "leader" || conv.archivedAt) continue;
      if (owners.has(conv.agentId)) continue;
      owners.set(conv.agentId, {
        ownerKind: "leader",
        conversationId: conv.id,
        conversationTitle: conv.title,
        targetAgentId: conv.agentId,
      });
    }
    return owners;
  }

  async function resolveTargetOwner(conversationId?: string | null): Promise<OwnerLookupEntry> {
    const trimmedConvId = conversationId?.trim();
    if (!trimmedConvId || trimmedConvId === MAIN_CONVERSATION_ID) {
      const mainAgentId = await deps.ensureMainChatAgentId();
      const conversations = await deps.listConversations();
      const mainConv = conversations.find(
        (conv) => conv.id === MAIN_CONVERSATION_ID || conv.kind === "main",
      );
      return {
        ownerKind: "main",
        conversationId: mainConv?.id ?? MAIN_CONVERSATION_ID,
        conversationTitle: mainConv?.title ?? deps.store.getSettings().title,
        targetAgentId: mainAgentId,
      };
    }

    const conversations = await deps.listConversations();
    const match = conversations.find((conv) => conv.id === trimmedConvId);
    if (!match) {
      throw new Error(`未找到目标对话：${trimmedConvId}`);
    }
    if (match.archivedAt) {
      throw new Error(`目标对话「${match.title}」已归档，无法绑定例行任务`);
    }
    if (match.kind === "side") {
      throw new Error("例行任务仅支持绑定到主对话或常驻方向主管对话");
    }
    return {
      ownerKind: match.kind === "main" ? "main" : "leader",
      conversationId: match.id,
      conversationTitle: match.title,
      targetAgentId: match.agentId,
    };
  }

  async function requireOwnedSchedule(
    routineId: string,
  ): Promise<{ schedule: StoredSchedule; owner: OwnerLookupEntry }> {
    const schedule = await deps.scheduleService.inspect(routineId);
    if (schedule.target.type !== "agent") {
      throw new Error(`例行任务 ${routineId} 不属于主对话或方向主管`);
    }
    const owners = await buildOwnerMap();
    const owner = owners.get(schedule.target.agentId);
    if (!owner) {
      throw new Error(`例行任务 ${routineId} 不属于主对话或方向主管`);
    }
    return { schedule, owner };
  }

  async function executeOwnerRoutinePrompt(
    schedule: StoredSchedule,
    owner: OwnerLookupEntry,
    runId: string,
  ): Promise<ScheduleExecutionResult> {
    const record = await deps.agentStorage.get(owner.targetAgentId);
    if (!record) {
      throw new ScheduleTargetGoneError(`Agent ${owner.targetAgentId} no longer exists`);
    }
    if (record.archivedAt) {
      throw new ScheduleTargetGoneError(`Agent ${owner.targetAgentId} is archived`);
    }

    const wrappedPrompt = buildMainChatRoutineFirePrompt(schedule, owner, runId);
    const title = schedule.name?.trim() || "例行任务";

    if (owner.ownerKind === "main") {
      let capturedOutput: string | null = null;
      await deps.turnQueue.enqueueBackground({
        mainAgentId: owner.targetAgentId,
        dedupeKey: `routine:${schedule.id}:${runId}`,
        trigger: `routine:${schedule.id}`,
        priority: 8,
        summary: `例行任务：${title}`,
        requeueOnPreempt: true,
        customExecute: async (signal) => {
          if (signal.aborted) {
            return { summary: `例行任务「${title}」已因用户活跃暂缓`, silent: true };
          }
          const dispatch = await sendPreparedPromptToAgent({
            agentId: owner.targetAgentId,
            prompt: wrappedPrompt,
            agentManager: deps.agentManager,
            agentStorage: deps.agentStorage,
            logger: deps.logger,
            unarchive: false,
          });
          if (dispatch.disposition === "turn_started") {
            await dispatch.started;
          }
          if (typeof deps.agentManager.waitForAgentEvent === "function") {
            const live = deps.agentManager.getAgent(owner.targetAgentId);
            if (
              live?.lifecycle === "running" ||
              deps.agentManager.hasInFlightRun(owner.targetAgentId)
            ) {
              const waited = await deps.agentManager.waitForAgentEvent(owner.targetAgentId, {
                waitForActive: true,
              });
              if (waited.status === "error") {
                throw new Error(waited.lastMessage ?? `例行任务「${title}」执行失败`);
              }
              capturedOutput = waited.lastMessage?.trim() || null;
            }
          }
          return {
            summary: `例行任务「${title}」执行完成`,
            silent: false,
            detail: capturedOutput,
          };
        },
      });
      return {
        agentId: owner.targetAgentId,
        output: capturedOutput ?? `例行任务「${title}」已投递至主对话后台流`,
      };
    }

    // Leader conversation target: dispatch with structured mainChatBackground metadata and log activity.
    const startedIso = new Date(getNowMs()).toISOString();
    const activityId = makeActivityId();
    const mainAgentId = (await deps.findMainChatAgentId()) ?? owner.targetAgentId;
    await deps.store
      .appendActivity({
        id: activityId,
        mainAgentId,
        kind: "background_turn",
        trigger: `routine:${schedule.id}`,
        summary: `方向「${owner.conversationTitle}」例行任务：${title}`,
        silent: false,
        status: "running",
        createdAt: startedIso,
        completedAt: null,
        relatedAgentId: owner.targetAgentId,
      })
      .catch(() => undefined);

    try {
      const dispatch = await sendPreparedPromptToAgent({
        agentId: owner.targetAgentId,
        prompt: wrappedPrompt,
        agentManager: deps.agentManager,
        agentStorage: deps.agentStorage,
        logger: deps.logger,
        unarchive: false,
      });
      if (dispatch.disposition === "turn_started") {
        await dispatch.started;
      }
      let output: string | null = null;
      if (typeof deps.agentManager.waitForAgentEvent === "function") {
        const live = deps.agentManager.getAgent(owner.targetAgentId);
        if (
          live?.lifecycle === "running" ||
          deps.agentManager.hasInFlightRun(owner.targetAgentId)
        ) {
          const waited = await deps.agentManager.waitForAgentEvent(owner.targetAgentId, {
            waitForActive: true,
          });
          if (waited.status === "error") {
            throw new Error(waited.lastMessage ?? `方向例行任务「${title}」执行失败`);
          }
          output = waited.lastMessage?.trim() || null;
        }
      }
      await deps.store
        .updateActivity(activityId, {
          status: "completed",
          completedAt: new Date(getNowMs()).toISOString(),
          detail: output,
        })
        .catch(() => undefined);
      return {
        agentId: owner.targetAgentId,
        output: output ?? `例行任务「${title}」已投递至方向「${owner.conversationTitle}」`,
      };
    } catch (error) {
      await deps.store
        .updateActivity(activityId, {
          status: "failed",
          completedAt: new Date(getNowMs()).toISOString(),
          detail: error instanceof Error ? error.message : String(error),
        })
        .catch(() => undefined);
      throw error;
    }
  }

  return {
    async listRoutines(options) {
      const owners = await buildOwnerMap();
      const schedules = await deps.scheduleService.list();
      const includeCompleted = options?.includeCompleted !== false;
      const filterConversationId = options?.conversationId?.trim() || null;

      const routines: MainChatRoutineRecord[] = [];
      for (const schedule of schedules) {
        if (schedule.target.type !== "agent") continue;
        const owner = owners.get(schedule.target.agentId);
        if (!owner) continue;
        if (!includeCompleted && schedule.status === "completed") continue;
        if (filterConversationId && owner.conversationId !== filterConversationId) continue;
        routines.push(toRoutineRecord(schedule, owner));
      }

      return routines.sort((left, right) => {
        const rank = (status: MainChatRoutineRecord["status"]) => {
          if (status === "active") return 0;
          if (status === "paused") return 1;
          return 2;
        };
        const diff = rank(left.status) - rank(right.status);
        if (diff !== 0) return diff;
        return right.updatedAt.localeCompare(left.updatedAt);
      });
    },

    async createRoutine(input) {
      const prompt = input.prompt.trim();
      if (!prompt) {
        throw new Error("例行任务指令不能为空");
      }
      const owner = await resolveTargetOwner(input.conversationId);
      const { cadence, maxRuns, runOnCreate } = resolveCadenceForCreate(input, getNowMs());
      const created = await deps.scheduleService.create({
        name: input.name?.trim() || null,
        prompt,
        cadence,
        target: { type: "agent", agentId: owner.targetAgentId },
        maxRuns,
        expiresAt: input.expiresAt ?? null,
        runOnCreate,
      });
      return toRoutineRecord(created, owner);
    },

    async pauseRoutine(routineId) {
      const { owner } = await requireOwnedSchedule(routineId);
      const paused = await deps.scheduleService.pause(routineId);
      return toRoutineRecord(paused, owner);
    },

    async resumeRoutine(routineId) {
      const { owner } = await requireOwnedSchedule(routineId);
      const resumed = await deps.scheduleService.resume(routineId);
      return toRoutineRecord(resumed, owner);
    },

    async runRoutineOnce(routineId) {
      const { owner } = await requireOwnedSchedule(routineId);
      const ran = await deps.scheduleService.runOnce(routineId);
      return toRoutineRecord(ran, owner);
    },

    async deleteRoutine(routineId) {
      await requireOwnedSchedule(routineId);
      await deps.scheduleService.delete(routineId);
      return { deleted: true };
    },

    async rebindMainAgentRoutines(fromAgentId, toAgentId) {
      return deps.scheduleService.rebindAgentTarget(fromAgentId, toAgentId);
    },

    async executeIfOwnedRoutine(schedule, runId) {
      if (schedule.target.type !== "agent") {
        return null;
      }
      const owners = await buildOwnerMap();
      const owner = owners.get(schedule.target.agentId);
      if (!owner) {
        return null;
      }
      return executeOwnerRoutinePrompt(schedule, owner, runId);
    },
  };
}
