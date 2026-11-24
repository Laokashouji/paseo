import crypto from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import { z } from "zod";
import {
  MAIN_CHAT_CONVERSATION_ID_LABEL,
  MAIN_CHAT_CONVERSATION_KIND_LABEL,
  MAIN_CHAT_DEFAULT_TITLE,
  MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS,
  MAIN_CHAT_MEMORY_DIRECTION_BUDGET_BYTES,
  MainChatConversationKindSchema,
  MainChatConversationRecordSchema,
  type MainChatConversationKind,
  type MainChatConversationRecord,
} from "@getpaseo/protocol/main-chat";
import { assembleMainChatMemoryContext } from "./memory.js";

export const MAX_LEADER_CONVERSATIONS = 20;
export const MAIN_CONVERSATION_ID = "conv_main";
export const CONVERSATIONS_FILE_NAME = "main-chat-conversations.json";

const DEFAULT_TAIL_LIMIT = 8;
const MAX_TAIL_LIMIT = 50;
const DEFAULT_MAX_CHARS_PER_TAIL_MESSAGE = 800;
const DEFAULT_MAX_TOTAL_TAIL_CHARS = 4_000;
const MAX_TITLE_CHARS = 80;
const MAX_DIRECTION_SUMMARY_CHARS = 1_000;

export type MainChatConversationErrorCode =
  | "not_found"
  | "leader_limit_reached"
  | "cannot_archive_main"
  | "cannot_change_main_kind"
  | "conversation_archived"
  | "invalid_input"
  | "missing_sender"
  | "missing_tail_reader";

export class MainChatConversationError extends Error {
  readonly code: MainChatConversationErrorCode;
  readonly conversationId?: string;

  constructor(
    code: MainChatConversationErrorCode,
    message: string,
    options?: { conversationId?: string; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "MainChatConversationError";
    this.code = code;
    this.conversationId = options?.conversationId;
  }
}

export interface MainChatConversationLabelsMeta {
  conversationId: string | null;
  kind: MainChatConversationKind | null;
}

export function isMainChatConversationLabels(
  labels: Record<string, unknown> | null | undefined,
): boolean {
  if (!labels) return false;
  const rawId = labels[MAIN_CHAT_CONVERSATION_ID_LABEL];
  if (typeof rawId === "string" && rawId.trim().length > 0) {
    return true;
  }
  const rawKind = labels[MAIN_CHAT_CONVERSATION_KIND_LABEL];
  return MainChatConversationKindSchema.safeParse(rawKind).success;
}

export function getMainChatConversationMetaFromLabels(
  labels: Record<string, unknown> | null | undefined,
): MainChatConversationLabelsMeta | null {
  if (!labels) return null;
  const rawId = labels[MAIN_CHAT_CONVERSATION_ID_LABEL];
  const conversationId = typeof rawId === "string" && rawId.trim().length > 0 ? rawId.trim() : null;
  const parsedKind = MainChatConversationKindSchema.safeParse(
    labels[MAIN_CHAT_CONVERSATION_KIND_LABEL],
  );
  const kind = parsedKind.success ? parsedKind.data : null;
  if (!conversationId && !kind) return null;
  return { conversationId, kind };
}

/**
 * Stamps conversation labels onto side/leader agents without setting `paseo.role=main`,
 * so root main-chat discovery stays unambiguous while fleet/workspace filters exclude them.
 */
export function buildConversationLabels(
  conversationId: string,
  kind: "side" | "leader",
): Record<string, string> {
  return {
    [MAIN_CHAT_CONVERSATION_ID_LABEL]: conversationId,
    [MAIN_CHAT_CONVERSATION_KIND_LABEL]: kind,
  };
}

export type StaticConversationPromptTarget = Pick<
  MainChatConversationRecord,
  "id" | "title" | "directionSummary"
> & {
  notes?: string | null;
};

/**
 * Static system prompt for a pinned direction leader conversation.
 * Dynamic fleet state is never embedded here so prompt-cache prefixes stay warm.
 */
export function buildLeaderSystemPrompt(conversation: StaticConversationPromptTarget): string {
  const sections: string[] = [
    `# 你是 Paseo 的常驻方向主管对话「${conversation.title}」`,
    `对话标识：${conversation.id}（角色：leader / 方向主管）`,
  ];

  const summary = conversation.directionSummary?.trim();
  if (summary) {
    sections.push("", "## 负责方向与目标范围", summary);
  }

  const notes = conversation.notes?.trim();
  if (notes) {
    const assembled = assembleMainChatMemoryContext({
      directionTitle: conversation.title,
      directionNotes: notes,
      budget: {
        totalMaxBytes: MAIN_CHAT_MEMORY_DIRECTION_BUDGET_BYTES,
        directionNotesMaxBytes: MAIN_CHAT_MEMORY_DIRECTION_BUDGET_BYTES,
      },
    });
    if (assembled.text) {
      sections.push("", assembled.text);
    }
  }

  sections.push(
    "",
    "## 核心职责与自治边界",
    "- 你独立负责该方向下的任务拆解、子 Agent 派发、进度跟进、常规异常处理、验收核对与返工闭环，为主对话卸载上下文与督办负担。",
    "- 属于本方向内部的技术实现细节、常规重试与可自证的验收返工，由你直接消化推进，不要把细枝末节转嫁给主对话。",
    "- 你自己不直接代替子 Agent 在主线大段改代码；需要改动仓库时通过任务工具派发隔离的子 Agent 并独立复核其真实结果。",
    "",
    "## 汇报与升级协议",
    "- 阶段性里程碑完成或方向关键状态变化时，调用 `leader_progress` 向主对话提交简洁汇总（结论先行，避免高频刷屏）。",
    "- 遇到产品取舍、架构分叉、范围变更、高风险操作（合并、发布、删除数据、对外发送消息）或超出本方向授权的红线事项时，必须调用 `ask_escalate` 一次性结构化升级为主对话待拍板卡，明确给出背景、2-4 个互斥方案、你的推荐项及必须由用户拍板的理由。",
    "- 需要与主对话或其他方向主管核对依赖时，使用 `conversation_read` 与 `conversation_send` 精简协作，不发无意义往返消息。",
    "- 本方向需要周期例行巡检或一次性提醒时，可使用 `routine_list` / `routine_create` / `routine_manage` 管理归属本方向的定时任务。",
  );

  return sections.join("\n");
}

/**
 * Static system prompt for a lightweight side conversation.
 * Dynamic fleet state is never embedded here so prompt-cache prefixes stay warm.
 */
export function buildSideConversationSystemPrompt(
  conversation: StaticConversationPromptTarget,
): string {
  const sections: string[] = [
    `# 你是 Paseo 的侧对话「${conversation.title}」`,
    `对话标识：${conversation.id}（角色：side / 专题讨论侧对话）`,
  ];

  const summary = conversation.directionSummary?.trim();
  if (summary) {
    sections.push("", "## 讨论议题与背景", summary);
  }

  sections.push(
    "",
    "## 协作方式与定位",
    "- 你用于围绕当前具体议题进行聚焦探讨、方案推演、信息梳理或快速验证，避免把长讨论污染进主对话。",
    "- 回复保持直接简洁、结论先行；需要核对主对话或其他方向进展时，可调用 `conversation_read` 查询。",
    "- 侧对话默认不独立承担长期任务督办；如果该议题演进为需持续推进的长期方向，可在侧栏升格为常驻方向主管（Leader），或调用 `conversation_send` 将明确结论同步回主对话。",
  );

  return sections.join("\n");
}

export const ConversationTailRoleSchema = z.enum([
  "user",
  "assistant",
  "tool",
  "error",
  "notification",
  "reasoning",
]);
export type ConversationTailRole = z.infer<typeof ConversationTailRoleSchema>;

export const ConversationTailMessageSchema = z.object({
  role: ConversationTailRoleSchema,
  text: z.string(),
  timestamp: z.string().nullable(),
  toolName: z.string().optional(),
  toolStatus: z.string().optional(),
});
export type ConversationTailMessage = z.infer<typeof ConversationTailMessageSchema>;

export interface ConversationTailSnapshot {
  conversation: MainChatConversationRecord;
  lifecycle: string;
  messages: ConversationTailMessage[];
  truncated: boolean;
}

export interface EnsureMainConversationInput {
  agentId: string;
  workspaceId: string | null;
  title?: string;
  serverId?: string | null;
}

export interface ListConversationsOptions {
  includeArchived?: boolean;
}

export interface CreateConversationInput {
  kind: "side" | "leader";
  title: string;
  directionSummary?: string | null;
  notes?: string | null;
  initialPrompt?: string;
  parentConversationId?: string | null;
  provider?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export interface UpdateConversationInput {
  conversationId: string;
  title?: string;
  directionSummary?: string | null;
  notes?: string | null;
  kind?: "side" | "leader";
  archived?: boolean;
}

export interface SendToConversationOptions {
  fromConversationId?: string | null;
  fromTitle?: string | null;
}

export interface SendToConversationResult {
  conversation: MainChatConversationRecord;
  deliveredAt: string;
}

export interface ReadConversationTailOptions {
  limit?: number;
  maxCharsPerMessage?: number;
  maxTotalChars?: number;
}

export interface ResolveSupervisingConversationInput {
  conversationId?: string | null;
  mainAgentId: string;
}

export type SupervisingFallbackReason = "unspecified" | "not_found" | "archived" | "not_leader";

export interface ResolvedSupervisingConversation {
  conversationId: string | null;
  kind: "main" | "leader";
  agentId: string;
  title: string;
  fallbackReason: SupervisingFallbackReason | null;
}

export interface CreateConversationAgentInput {
  conversationId: string;
  kind: "side" | "leader";
  title: string;
  directionSummary: string | null;
  labels: Record<string, string>;
  systemPrompt: string;
  provider?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export interface CreateConversationAgentResult {
  agentId: string;
  workspaceId: string | null;
  serverId?: string | null;
}

export interface SendConversationPromptInput {
  conversation: MainChatConversationRecord;
  prompt: string;
  fromConversationId: string | null;
  fromTitle: string | null;
}

export interface ReadConversationTailInput {
  conversation: MainChatConversationRecord;
  limit: number;
}

export interface ReadConversationTailResult {
  lifecycle?: string;
  messages: ConversationTailMessage[];
}

export interface SyncConversationAgentInput {
  conversation: MainChatConversationRecord;
  labels: Record<string, string>;
  systemPrompt: string;
}

export interface MainChatConversationManagerDeps {
  homeDir: string;
  defaultServerId?: string | null;
  now?: () => number;
  maxLeaderConversations?: number;
  logger?: Logger;
  createConversationAgent: (
    input: CreateConversationAgentInput,
  ) => Promise<CreateConversationAgentResult>;
  sendPromptToAgent?: (input: SendConversationPromptInput) => Promise<void>;
  readAgentTail?: (input: ReadConversationTailInput) => Promise<ReadConversationTailResult>;
  syncConversationAgent?: (input: SyncConversationAgentInput) => Promise<void>;
  archiveConversationAgent?: (conversation: MainChatConversationRecord) => Promise<void>;
}

export interface MainChatConversationManager {
  load(): Promise<void>;
  ensureMainConversationRecord(
    input: EnsureMainConversationInput,
  ): Promise<MainChatConversationRecord>;
  rebindMainConversationAgent(
    newAgentId: string,
    workspaceId?: string | null,
  ): Promise<MainChatConversationRecord>;
  listConversations(options?: ListConversationsOptions): Promise<MainChatConversationRecord[]>;
  getConversation(conversationId: string): MainChatConversationRecord | null;
  getConversationByAgentId(agentId: string): MainChatConversationRecord | null;
  listConversationAgentIds(options?: ListConversationsOptions): Set<string>;
  createConversation(input: CreateConversationInput): Promise<MainChatConversationRecord>;
  updateConversation(input: UpdateConversationInput): Promise<MainChatConversationRecord>;
  sendToConversation(
    conversationId: string,
    prompt: string,
    options?: SendToConversationOptions,
  ): Promise<SendToConversationResult>;
  readConversationTail(
    conversationId: string,
    options?: ReadConversationTailOptions,
  ): Promise<ConversationTailSnapshot>;
  resolveSupervisingConversation(
    input: ResolveSupervisingConversationInput,
  ): ResolvedSupervisingConversation;
}

const PersistedConversationsFileSchema = z.object({
  version: z.literal(1),
  conversations: z.record(z.string(), MainChatConversationRecordSchema),
});

interface PersistedConversationsFile {
  version: 1;
  conversations: Record<string, MainChatConversationRecord>;
}

function cloneRecord(record: MainChatConversationRecord): MainChatConversationRecord {
  return { ...record };
}

function makeConversationId(nowMs: number): string {
  const randomSuffix = crypto.randomBytes(4).toString("hex");
  return `conv_${nowMs.toString(36)}_${randomSuffix}`;
}

function isEnoentError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function normalizeTitle(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new MainChatConversationError("invalid_input", "对话标题不能为空。");
  }
  if (trimmed.length > MAX_TITLE_CHARS) {
    throw new MainChatConversationError(
      "invalid_input",
      `对话标题长度不能超过 ${MAX_TITLE_CHARS} 个字符。`,
    );
  }
  return trimmed;
}

function normalizeDirectionSummary(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_DIRECTION_SUMMARY_CHARS) {
    throw new MainChatConversationError(
      "invalid_input",
      `方向说明长度不能超过 ${MAX_DIRECTION_SUMMARY_CHARS} 个字符。`,
    );
  }
  return trimmed;
}

function normalizeDirectionNotes(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS) {
    throw new MainChatConversationError(
      "invalid_input",
      `方向笔记长度不能超过 ${MAIN_CHAT_DIRECTION_NOTES_MAX_CHARS} 个字符。`,
    );
  }
  return trimmed;
}

function truncateText(text: string, maxChars: number): { value: string; truncated: boolean } {
  const normalized = text.trim();
  if (normalized.length <= maxChars) {
    return { value: normalized, truncated: false };
  }
  return {
    value: `${normalized.slice(0, Math.max(1, maxChars - 1))}…`,
    truncated: true,
  };
}

function sortGroupRank(record: MainChatConversationRecord): number {
  if (record.archivedAt !== null) return 3;
  if (record.kind === "main") return 0;
  if (record.kind === "leader") return 1;
  return 2;
}

function compareConversationRecords(
  left: MainChatConversationRecord,
  right: MainChatConversationRecord,
): number {
  const leftRank = sortGroupRank(left);
  const rightRank = sortGroupRank(right);
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }

  if (leftRank === 0) {
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  }

  if (leftRank === 1) {
    const leftPin = left.pinnedAsLeaderAt ?? left.createdAt;
    const rightPin = right.pinnedAsLeaderAt ?? right.createdAt;
    const pinCompare = leftPin.localeCompare(rightPin);
    if (pinCompare !== 0) return pinCompare;
    return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
  }

  if (leftRank === 2) {
    const updatedCompare = right.updatedAt.localeCompare(left.updatedAt);
    if (updatedCompare !== 0) return updatedCompare;
    const createdCompare = right.createdAt.localeCompare(left.createdAt);
    if (createdCompare !== 0) return createdCompare;
    return left.id.localeCompare(right.id);
  }

  const leftArchived = left.archivedAt ?? left.updatedAt;
  const rightArchived = right.archivedAt ?? right.updatedAt;
  const archivedCompare = rightArchived.localeCompare(leftArchived);
  if (archivedCompare !== 0) return archivedCompare;
  return left.id.localeCompare(right.id);
}

function buildStaticPromptForNonMain(
  kind: "side" | "leader",
  target: StaticConversationPromptTarget,
): string {
  return kind === "leader"
    ? buildLeaderSystemPrompt(target)
    : buildSideConversationSystemPrompt(target);
}

function clipTailMessages(
  rawMessages: readonly ConversationTailMessage[],
  options: { limit: number; maxCharsPerMessage: number; maxTotalChars: number },
): { messages: ConversationTailMessage[]; truncated: boolean } {
  const sliced = rawMessages.slice(-options.limit);
  let truncated = rawMessages.length > sliced.length;

  // Walk newest-to-oldest so recent context is always preserved within the total character budget.
  const keptReversed: ConversationTailMessage[] = [];
  let usedChars = 0;

  for (let index = sliced.length - 1; index >= 0; index -= 1) {
    const entry = sliced[index];
    const remainingBudget = options.maxTotalChars - usedChars;
    if (remainingBudget <= 0) {
      truncated = true;
      break;
    }
    const perMessageLimit = Math.min(options.maxCharsPerMessage, remainingBudget);
    const clipped = truncateText(entry.text, perMessageLimit);
    if (clipped.truncated) {
      truncated = true;
    }
    usedChars += clipped.value.length;
    keptReversed.push({
      role: entry.role,
      text: clipped.value,
      timestamp: entry.timestamp,
      ...(entry.toolName ? { toolName: entry.toolName } : {}),
      ...(entry.toolStatus ? { toolStatus: entry.toolStatus } : {}),
    });
  }

  keptReversed.reverse();
  return { messages: keptReversed, truncated };
}

function assertConversationUpdateAllowed(
  existing: MainChatConversationRecord,
  input: UpdateConversationInput,
): void {
  if (existing.kind !== "main") return;
  if (input.archived === true) {
    throw new MainChatConversationError(
      "cannot_archive_main",
      "主对话为全局总控根会话，禁止归档。",
      { conversationId: existing.id },
    );
  }
  if (input.kind !== undefined) {
    throw new MainChatConversationError(
      "cannot_change_main_kind",
      "主对话不能修改为侧对话或方向主管。",
      { conversationId: existing.id },
    );
  }
}

function resolveNextArchivedAt(
  existingArchivedAt: string | null,
  archived: boolean | undefined,
  timestamp: string,
): string | null {
  if (archived === true) return existingArchivedAt ?? timestamp;
  if (archived === false) return null;
  return existingArchivedAt;
}

function resolveNextPinnedAsLeaderAt(
  existing: MainChatConversationRecord,
  nextKind: MainChatConversationKind,
  timestamp: string,
): string | null {
  if (nextKind !== "leader") return null;
  if (existing.kind === "leader" && existing.pinnedAsLeaderAt) {
    return existing.pinnedAsLeaderAt;
  }
  return timestamp;
}

function buildUpdatedConversationRecord(
  existing: MainChatConversationRecord,
  input: UpdateConversationInput,
  timestamp: string,
): MainChatConversationRecord {
  const nextTitle = input.title !== undefined ? normalizeTitle(input.title) : existing.title;
  const nextDirectionSummary =
    input.directionSummary !== undefined
      ? normalizeDirectionSummary(input.directionSummary)
      : existing.directionSummary;
  const nextNotes =
    input.notes !== undefined ? normalizeDirectionNotes(input.notes) : (existing.notes ?? null);
  const nextKind: MainChatConversationKind =
    existing.kind === "main" ? "main" : (input.kind ?? existing.kind);
  const nextArchivedAt = resolveNextArchivedAt(existing.archivedAt, input.archived, timestamp);
  const nextPinnedAsLeaderAt = resolveNextPinnedAsLeaderAt(existing, nextKind, timestamp);

  return {
    ...existing,
    kind: nextKind,
    title: nextTitle,
    directionSummary: nextDirectionSummary,
    notes: nextNotes,
    archivedAt: nextArchivedAt,
    pinnedAsLeaderAt: nextPinnedAsLeaderAt,
    updatedAt: timestamp,
  };
}

function didConversationMetadataChange(
  previous: MainChatConversationRecord,
  next: MainChatConversationRecord,
): boolean {
  return (
    previous.kind !== next.kind ||
    previous.title !== next.title ||
    previous.directionSummary !== next.directionSummary ||
    (previous.notes ?? null) !== (next.notes ?? null)
  );
}

export function createMainChatConversationManager(
  deps: MainChatConversationManagerDeps,
): MainChatConversationManager {
  const filePath = path.join(deps.homeDir, CONVERSATIONS_FILE_NAME);
  const getNowMs = deps.now ?? (() => Date.now());
  const maxLeaders = deps.maxLeaderConversations ?? MAX_LEADER_CONVERSATIONS;

  const records = new Map<string, MainChatConversationRecord>();
  let loaded = false;
  let loadPromise: Promise<void> | null = null;
  let writeChain = Promise.resolve();
  let writeSeq = 0;

  function nowIso(): string {
    return new Date(getNowMs()).toISOString();
  }

  function findMainRecord(): MainChatConversationRecord | null {
    const byFixedId = records.get(MAIN_CONVERSATION_ID);
    if (byFixedId && byFixedId.kind === "main") {
      return byFixedId;
    }
    for (const record of records.values()) {
      if (record.kind === "main") {
        return record;
      }
    }
    return null;
  }

  function countActiveLeaders(): number {
    let count = 0;
    for (const record of records.values()) {
      if (record.kind === "leader" && record.archivedAt === null) {
        count += 1;
      }
    }
    return count;
  }

  function assertLeaderQuotaAvailable(conversationId?: string): void {
    if (countActiveLeaders() >= maxLeaders) {
      throw new MainChatConversationError(
        "leader_limit_reached",
        `常驻方向主管数量已达上限（${maxLeaders} 个），请先将其他方向主管降级为侧对话或归档后再新增。`,
        conversationId ? { conversationId } : undefined,
      );
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (loaded) return;
    if (loadPromise) {
      await loadPromise;
      return;
    }
    loadPromise = (async () => {
      try {
        const raw = await readFile(filePath, "utf8");
        const parsed = PersistedConversationsFileSchema.safeParse(JSON.parse(raw));
        if (parsed.success) {
          records.clear();
          for (const [key, record] of Object.entries(parsed.data.conversations)) {
            records.set(record.id || key, cloneRecord(record));
          }
        } else {
          deps.logger?.warn(
            { filePath, issues: parsed.error.issues },
            "main-chat-conversations.json failed schema validation; starting empty",
          );
        }
      } catch (error) {
        if (!isEnoentError(error)) {
          deps.logger?.warn(
            { filePath, err: error },
            "Failed to read main-chat-conversations.json; starting empty",
          );
        }
      } finally {
        loaded = true;
        loadPromise = null;
      }
    })();
    await loadPromise;
  }

  async function persist(): Promise<void> {
    const payload: PersistedConversationsFile = {
      version: 1,
      conversations: Object.fromEntries(
        Array.from(records.entries()).map(([id, record]) => [id, cloneRecord(record)]),
      ),
    };
    const serialized = JSON.stringify(payload, null, 2);

    const task = writeChain.then(async () => {
      await mkdir(path.dirname(filePath), { recursive: true });
      writeSeq += 1;
      const tempPath = `${filePath}.${process.pid}.${writeSeq}.tmp`;
      try {
        await writeFile(tempPath, serialized, "utf8");
        await rename(tempPath, filePath);
      } catch (error) {
        await unlink(tempPath).catch(() => undefined);
        throw error;
      }
      return undefined;
    });

    writeChain = task.then(
      () => undefined,
      () => undefined,
    );
    await task;
  }

  async function ensureMainConversationRecord(
    input: EnsureMainConversationInput,
  ): Promise<MainChatConversationRecord> {
    await ensureLoaded();
    const agentId = input.agentId.trim();
    if (!agentId) {
      throw new MainChatConversationError("invalid_input", "主对话 agentId 不能为空。");
    }

    const existing = findMainRecord();
    const timestamp = nowIso();

    if (existing) {
      const nextTitle = input.title?.trim()
        ? normalizeTitle(input.title)
        : existing.title || MAIN_CHAT_DEFAULT_TITLE;
      const nextServerId =
        input.serverId !== undefined
          ? input.serverId
          : (existing.serverId ?? deps.defaultServerId ?? null);

      const changed =
        existing.agentId !== agentId ||
        existing.workspaceId !== input.workspaceId ||
        existing.title !== nextTitle ||
        existing.serverId !== nextServerId ||
        existing.archivedAt !== null ||
        existing.pinnedAsLeaderAt !== null;

      if (changed) {
        const updated: MainChatConversationRecord = {
          ...existing,
          agentId,
          workspaceId: input.workspaceId,
          title: nextTitle,
          serverId: nextServerId,
          archivedAt: null,
          pinnedAsLeaderAt: null,
          updatedAt: timestamp,
        };
        records.set(updated.id, updated);
        await persist();
        return cloneRecord(updated);
      }
      return cloneRecord(existing);
    }

    const title = input.title?.trim() ? normalizeTitle(input.title) : MAIN_CHAT_DEFAULT_TITLE;
    const created: MainChatConversationRecord = {
      id: MAIN_CONVERSATION_ID,
      kind: "main",
      agentId,
      workspaceId: input.workspaceId,
      title,
      directionSummary: null,
      parentConversationId: null,
      serverId: input.serverId ?? deps.defaultServerId ?? null,
      archivedAt: null,
      pinnedAsLeaderAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastMessageAt: null,
    };
    records.set(created.id, created);
    await persist();
    return cloneRecord(created);
  }

  async function sendToConversation(
    conversationId: string,
    prompt: string,
    options?: SendToConversationOptions,
  ): Promise<SendToConversationResult> {
    await ensureLoaded();
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      throw new MainChatConversationError("invalid_input", "发送给对话的消息内容不能为空。", {
        conversationId,
      });
    }

    const target = records.get(conversationId);
    if (!target) {
      throw new MainChatConversationError("not_found", `未找到目标对话：${conversationId}`, {
        conversationId,
      });
    }
    if (target.archivedAt !== null) {
      throw new MainChatConversationError(
        "conversation_archived",
        `对话「${target.title}」已归档，无法继续发送消息。`,
        { conversationId },
      );
    }
    if (!deps.sendPromptToAgent) {
      throw new MainChatConversationError(
        "missing_sender",
        "未配置对话消息投递通道（sendPromptToAgent）。",
        { conversationId },
      );
    }

    await deps.sendPromptToAgent({
      conversation: cloneRecord(target),
      prompt: trimmedPrompt,
      fromConversationId: options?.fromConversationId ?? null,
      fromTitle: options?.fromTitle ?? null,
    });

    const deliveredAt = nowIso();
    const updated: MainChatConversationRecord = {
      ...target,
      lastMessageAt: deliveredAt,
      updatedAt: deliveredAt,
    };
    records.set(updated.id, updated);
    await persist();
    return { conversation: cloneRecord(updated), deliveredAt };
  }

  return {
    async load() {
      await ensureLoaded();
    },

    ensureMainConversationRecord,

    async rebindMainConversationAgent(newAgentId, workspaceId) {
      await ensureLoaded();
      const trimmedAgentId = newAgentId.trim();
      if (!trimmedAgentId) {
        throw new MainChatConversationError("invalid_input", "新主对话 agentId 不能为空。");
      }

      const existing = findMainRecord();
      if (!existing) {
        return ensureMainConversationRecord({
          agentId: trimmedAgentId,
          workspaceId: workspaceId ?? null,
        });
      }

      const updated: MainChatConversationRecord = {
        ...existing,
        agentId: trimmedAgentId,
        workspaceId: workspaceId !== undefined ? workspaceId : existing.workspaceId,
        archivedAt: null,
        pinnedAsLeaderAt: null,
        updatedAt: nowIso(),
      };
      records.set(updated.id, updated);
      await persist();
      return cloneRecord(updated);
    },

    async listConversations(options) {
      await ensureLoaded();
      const includeArchived = options?.includeArchived === true;
      const list = Array.from(records.values())
        .filter((record) => includeArchived || record.archivedAt === null)
        .sort(compareConversationRecords)
        .map(cloneRecord);
      return list;
    },

    getConversation(conversationId) {
      const record = records.get(conversationId);
      return record ? cloneRecord(record) : null;
    },

    getConversationByAgentId(agentId) {
      let archivedMatch: MainChatConversationRecord | null = null;
      for (const record of records.values()) {
        if (record.agentId !== agentId) continue;
        if (record.archivedAt === null) {
          return cloneRecord(record);
        }
        archivedMatch = record;
      }
      return archivedMatch ? cloneRecord(archivedMatch) : null;
    },

    listConversationAgentIds(options) {
      const includeArchived = options?.includeArchived === true;
      const agentIds = new Set<string>();
      for (const record of records.values()) {
        if (!includeArchived && record.archivedAt !== null) continue;
        agentIds.add(record.agentId);
      }
      return agentIds;
    },

    async createConversation(input) {
      await ensureLoaded();
      const title = normalizeTitle(input.title);
      const directionSummary = normalizeDirectionSummary(input.directionSummary);
      const notes = normalizeDirectionNotes(input.notes);
      const trimmedInitialPrompt = input.initialPrompt?.trim() ?? "";

      if (trimmedInitialPrompt.length > 0 && !deps.sendPromptToAgent) {
        throw new MainChatConversationError(
          "missing_sender",
          "创建对话携带了首轮消息，但未配置消息投递通道（sendPromptToAgent）。",
        );
      }

      if (input.kind === "leader") {
        assertLeaderQuotaAvailable();
      }

      const nowMs = getNowMs();
      const timestamp = new Date(nowMs).toISOString();
      const conversationId = makeConversationId(nowMs);
      const mainRecord = findMainRecord();
      const parentConversationId =
        input.parentConversationId !== undefined
          ? input.parentConversationId
          : (mainRecord?.id ?? null);

      const labels = buildConversationLabels(conversationId, input.kind);
      const systemPrompt = buildStaticPromptForNonMain(input.kind, {
        id: conversationId,
        title,
        directionSummary,
        notes,
      });

      const createdAgent = await deps.createConversationAgent({
        conversationId,
        kind: input.kind,
        title,
        directionSummary,
        labels,
        systemPrompt,
        provider: input.provider,
        model: input.model,
        modeId: input.modeId,
        thinkingOptionId: input.thinkingOptionId,
      });

      const record: MainChatConversationRecord = {
        id: conversationId,
        kind: input.kind,
        agentId: createdAgent.agentId,
        workspaceId: createdAgent.workspaceId,
        title,
        directionSummary,
        notes,
        parentConversationId,
        serverId: createdAgent.serverId ?? deps.defaultServerId ?? null,
        archivedAt: null,
        pinnedAsLeaderAt: input.kind === "leader" ? timestamp : null,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastMessageAt: null,
      };
      records.set(record.id, record);
      await persist();

      if (trimmedInitialPrompt.length > 0) {
        const parentRecord = parentConversationId
          ? (records.get(parentConversationId) ?? null)
          : null;
        const delivered = await sendToConversation(record.id, trimmedInitialPrompt, {
          fromConversationId: parentRecord?.id ?? null,
          fromTitle: parentRecord?.title ?? null,
        });
        return delivered.conversation;
      }

      return cloneRecord(record);
    },

    async updateConversation(input) {
      await ensureLoaded();
      const existing = records.get(input.conversationId);
      if (!existing) {
        throw new MainChatConversationError(
          "not_found",
          `未找到目标对话：${input.conversationId}`,
          { conversationId: input.conversationId },
        );
      }

      assertConversationUpdateAllowed(existing, input);

      const updated = buildUpdatedConversationRecord(existing, input, nowIso());
      const wasActiveLeader = existing.kind === "leader" && existing.archivedAt === null;
      const willBeActiveLeader = updated.kind === "leader" && updated.archivedAt === null;
      if (!wasActiveLeader && willBeActiveLeader) {
        assertLeaderQuotaAvailable(existing.id);
      }

      records.set(updated.id, updated);
      await persist();

      if (
        updated.kind !== "main" &&
        didConversationMetadataChange(existing, updated) &&
        deps.syncConversationAgent
      ) {
        await deps.syncConversationAgent({
          conversation: cloneRecord(updated),
          labels: buildConversationLabels(updated.id, updated.kind),
          systemPrompt: buildStaticPromptForNonMain(updated.kind, updated),
        });
      }

      const newlyArchived = existing.archivedAt === null && updated.archivedAt !== null;
      if (newlyArchived && deps.archiveConversationAgent) {
        await deps.archiveConversationAgent(cloneRecord(updated));
      }

      return cloneRecord(updated);
    },

    sendToConversation,

    async readConversationTail(conversationId, options) {
      await ensureLoaded();
      const target = records.get(conversationId);
      if (!target) {
        throw new MainChatConversationError("not_found", `未找到目标对话：${conversationId}`, {
          conversationId,
        });
      }
      if (!deps.readAgentTail) {
        throw new MainChatConversationError(
          "missing_tail_reader",
          "未配置对话记录读取通道（readAgentTail）。",
          { conversationId },
        );
      }

      const requestedLimit = options?.limit ?? DEFAULT_TAIL_LIMIT;
      const limit = Math.max(1, Math.min(MAX_TAIL_LIMIT, Math.floor(requestedLimit)));
      const maxCharsPerMessage = Math.max(
        40,
        options?.maxCharsPerMessage ?? DEFAULT_MAX_CHARS_PER_TAIL_MESSAGE,
      );
      const maxTotalChars = Math.max(
        maxCharsPerMessage,
        options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_TAIL_CHARS,
      );

      const raw = await deps.readAgentTail({
        conversation: cloneRecord(target),
        limit,
      });
      const clipped = clipTailMessages(raw.messages, {
        limit,
        maxCharsPerMessage,
        maxTotalChars,
      });

      return {
        conversation: cloneRecord(target),
        lifecycle: raw.lifecycle?.trim() || "idle",
        messages: clipped.messages,
        truncated: clipped.truncated,
      };
    },

    resolveSupervisingConversation(input) {
      const mainRecord = findMainRecord();
      const mainFallback = (
        fallbackReason: SupervisingFallbackReason | null,
      ): ResolvedSupervisingConversation => ({
        conversationId: mainRecord?.id ?? null,
        kind: "main",
        agentId: input.mainAgentId,
        title: mainRecord?.title ?? MAIN_CHAT_DEFAULT_TITLE,
        fallbackReason,
      });

      const requestedId = input.conversationId?.trim();
      if (!requestedId) {
        return mainFallback("unspecified");
      }

      const target = records.get(requestedId);
      if (!target) {
        return mainFallback("not_found");
      }
      if (target.kind === "main") {
        return {
          conversationId: target.id,
          kind: "main",
          agentId: input.mainAgentId || target.agentId,
          title: target.title,
          fallbackReason: null,
        };
      }
      if (target.archivedAt !== null) {
        return mainFallback("archived");
      }
      if (target.kind !== "leader") {
        return mainFallback("not_leader");
      }

      return {
        conversationId: target.id,
        kind: "leader",
        agentId: target.agentId,
        title: target.title,
        fallbackReason: null,
      };
    },
  };
}
