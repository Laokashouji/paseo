import crypto from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  MAIN_CHAT_LESSONS_FRESH_DAYS,
  MAIN_CHAT_LESSONS_INJECT_BUDGET_BYTES,
  MAIN_CHAT_LESSONS_INJECT_MAX_COUNT,
  MAIN_CHAT_LESSONS_INJECT_PER_KIND_MAX,
  MAIN_CHAT_LESSONS_MAX_SOURCES,
  MAIN_CHAT_LESSONS_PER_TASK_MAX,
  MAIN_CHAT_LESSON_KINDS,
  MAIN_CHAT_LESSON_PROJECT_KEY_MAX_CHARS,
  MAIN_CHAT_LESSON_PROJECT_LABEL_MAX_CHARS,
  MAIN_CHAT_LESSON_TEXT_MAX_CHARS,
  MAIN_CHAT_WORKSPACE_DIR_NAME,
  MainChatProjectLessonSchema,
  type MainChatLessonKind,
  type MainChatLessonOrigin,
  type MainChatProjectLesson,
  type MainChatProjectLessonGroup,
  type MainChatReceiptCheck,
  type MainChatTaskRecord,
} from "@getpaseo/protocol/main-chat";
import {
  deriveProjectSlug,
  parseGitHubRepoFromRemote,
  parseGitHubRepoNameFromRemote,
} from "../workspace-git-metadata.js";

const LESSONS_FILE_NAME = "project-lessons.json";
const MAX_RETAINED_LESSONS = 600;
const MAX_RETAINED_RETIRED_KEYS = 600;
const FRESH_WINDOW_MS = MAIN_CHAT_LESSONS_FRESH_DAYS * 24 * 60 * 60 * 1000;

const RetiredLessonTombstoneSchema = z.object({
  lessonId: z.string(),
  projectKey: z.string(),
  dedupeKey: z.string(),
  text: z.string(),
  retiredAt: z.string(),
});
type RetiredLessonTombstone = z.infer<typeof RetiredLessonTombstoneSchema>;

const ProjectLessonsFileSchema = z.object({
  version: z.literal(1),
  lessons: z.array(MainChatProjectLessonSchema),
  retired: z.array(RetiredLessonTombstoneSchema).optional(),
});

interface ProjectLessonsState {
  version: 1;
  lessons: MainChatProjectLesson[];
  retired: RetiredLessonTombstone[];
}

export interface ProjectLessonTargetContext {
  cwd?: string | null;
  projectRoot?: string | null;
  remoteUrl?: string | null;
  projectLabel?: string | null;
}

export interface ResolvedProjectLessonIdentity {
  projectKey: string;
  projectLabel: string;
  aliasKeys: string[];
}

export interface AddProjectLessonInput {
  projectKey: string;
  projectLabel?: string | null;
  kind: MainChatLessonKind;
  text: string;
  origin?: MainChatLessonOrigin;
  taskId?: string | null;
  allowUnretire?: boolean;
}

export interface AddProjectLessonResult {
  lesson: MainChatProjectLesson | null;
  deduplicated: boolean;
  skippedRetired: boolean;
}

export interface DistillTaskLessonsInput {
  task: MainChatTaskRecord;
  trigger: "rework" | "accept";
  gaps?: readonly string[];
  checks?: readonly MainChatReceiptCheck[];
  nextSteps?: readonly string[];
  note?: string | null;
  summary?: string | null;
  projectContext?: ProjectLessonTargetContext;
}

export interface FormattedProjectLessonsBlock {
  text: string;
  byteLength: number;
  includedCount: number;
  truncated: boolean;
  lessons: MainChatProjectLesson[];
}

const LESSON_KIND_PROMPT_LABELS: Record<MainChatLessonKind, string> = {
  repeated_mistake: "重复踩坑",
  missing_context: "背景缺口",
  wasted_step: "无效步骤",
  improvement: "改进建议",
};

function makeLessonId(): string {
  return `lesson_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeWhitespaceOneLine(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

function clipText(raw: string, maxChars: number): string {
  const normalized = normalizeWhitespaceOneLine(raw);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * Reduces a lesson sentence to lower-case Unicode letters and digits (matching Persona's
 * `kb.LessonKey`) so spacing, punctuation, and capitalization never create duplicate entries.
 */
export function computeLessonDedupeKey(text: string): string {
  const lowered = text.toLowerCase();
  const matches = lowered.match(/[\p{L}\p{N}]+/gu);
  return matches ? matches.join("") : "";
}

/**
 * Normalizes a filesystem path or git repository identifier into a stable project key.
 * Strips trailing slashes, resolves relative segments, and normalizes drive letter casing.
 */
export function normalizeProjectLessonPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  if (/^[a-z]+:\/\//i.test(trimmed) || /^repo:/i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
  const resolved = path.resolve(trimmed);
  const stripped = resolved.length > 1 ? resolved.replace(/[\\/]+$/, "") : resolved;
  return stripped.slice(0, MAIN_CHAT_LESSON_PROJECT_KEY_MAX_CHARS);
}

/**
 * Resolves the canonical project key and human-readable label for a task/workspace.
 * Prefers `projectRoot` (main repo root for worktrees) over `cwd`, while returning alias keys so
 * lookups from either worktree or repo root hit the same project lessons.
 */
function collectProjectLessonAliasKeys(
  projectKey: string,
  context: ProjectLessonTargetContext,
  repoFromRemote: string | null,
): string[] {
  const aliasKeys = new Set<string>([projectKey]);
  for (const rawPath of [context.cwd, context.projectRoot]) {
    const trimmed = rawPath?.trim();
    if (!trimmed) continue;
    const normalized = normalizeProjectLessonPath(trimmed);
    if (normalized) aliasKeys.add(normalized);
  }
  if (repoFromRemote) {
    aliasKeys.add(`repo:${repoFromRemote.toLowerCase()}`);
  }
  return Array.from(aliasKeys);
}

function resolveProjectLessonLabel(
  context: ProjectLessonTargetContext,
  projectKey: string,
  primaryRaw: string,
  repoNameFromRemote: string | null,
): string {
  const candidates = [
    context.projectLabel?.trim(),
    repoNameFromRemote,
    primaryRaw ? path.basename(normalizeProjectLessonPath(primaryRaw)) : "",
    primaryRaw ? deriveProjectSlug(primaryRaw, context.remoteUrl ?? null) : "",
    projectKey,
  ];
  const chosen = candidates.find((value): value is string => Boolean(value)) ?? "project";
  return clipText(chosen, MAIN_CHAT_LESSON_PROJECT_LABEL_MAX_CHARS);
}

export function resolveProjectLessonIdentity(
  context: ProjectLessonTargetContext,
): ResolvedProjectLessonIdentity | null {
  const primaryRaw = context.projectRoot?.trim() || context.cwd?.trim() || "";
  const trimmedRemote = context.remoteUrl?.trim() ?? "";
  const repoFromRemote = trimmedRemote ? parseGitHubRepoFromRemote(trimmedRemote) : null;
  const repoNameFromRemote = trimmedRemote ? parseGitHubRepoNameFromRemote(trimmedRemote) : null;

  let projectKey = primaryRaw ? normalizeProjectLessonPath(primaryRaw) : "";
  if (!projectKey && repoFromRemote) {
    projectKey = `repo:${repoFromRemote.toLowerCase()}`;
  }
  if (!projectKey) return null;

  return {
    projectKey,
    projectLabel: resolveProjectLessonLabel(context, projectKey, primaryRaw, repoNameFromRemote),
    aliasKeys: collectProjectLessonAliasKeys(projectKey, context, repoFromRemote),
  };
}

function classifyCandidateLessonKind(
  text: string,
  fallback: MainChatLessonKind,
): MainChatLessonKind {
  const lowered = text.toLowerCase();
  if (
    /(缺少|缺失|未提供|漏了|背景|上下文|约束|环境变量|配置|文档|规范|missing|context|spec|requirement|env|config|convention)/i.test(
      lowered,
    )
  ) {
    return "missing_context";
  }
  if (
    /(无效|白跑|多余|绕路|重复查|浪费|不要轮询|别跑全量|wasted|unnecessary|redundant|wrong path|duplicate step)/i.test(
      lowered,
    )
  ) {
    return "wasted_step";
  }
  if (
    /(建议|优先|下次|最好|改为|提前|改进|应该先|recommend|prefer|improve|better to|should first)/i.test(
      lowered,
    )
  ) {
    return "improvement";
  }
  if (
    /(返工|失败|报错|回归|溢出|裁切|遗漏|未通过|不匹配|错误|bug|fail|error|regression|mismatch|lint|typecheck|overflow)/i.test(
      lowered,
    )
  ) {
    return "repeated_mistake";
  }
  return fallback;
}

function normalizeCandidateLessonSentence(raw: string, prefix?: string): string {
  const cleaned = normalizeWhitespaceOneLine(raw)
    .replace(/^[-*•\d.)、\s]+/, "")
    .trim();
  if (!cleaned) return "";
  const combined = prefix ? `${prefix}${cleaned}` : cleaned;
  return clipText(combined, MAIN_CHAT_LESSON_TEXT_MAX_CHARS);
}

/**
 * Deterministically distills 1–3 concise, actionable lessons when a task experiences friction
 * (rework gaps, unmet checks, corrective review note, scope revisions, or substantial overrun).
 * Smooth acceptances without friction return an empty list.
 */
type PushLessonCandidateFn = (
  raw: string,
  fallbackKind: MainChatLessonKind,
  prefix?: string,
) => void;

function hasTaskOverrun(task: MainChatTaskRecord): boolean {
  return (
    typeof task.expectedMinutes === "number" &&
    task.expectedMinutes > 0 &&
    typeof task.actualMinutes === "number" &&
    task.actualMinutes >= task.expectedMinutes * 2
  );
}

function pushReworkFallbackLesson(
  input: DistillTaskLessonsInput,
  pushCandidate: PushLessonCandidateFn,
): void {
  const decisionHint = input.task.decisions?.at(-1)?.answer ?? null;
  if (decisionHint) {
    pushCandidate(
      `任务「${input.task.title}」返工 ${input.task.reworkCount} 轮后通过，关键口径：${decisionHint}`,
      "missing_context",
    );
    return;
  }
  const summary = input.summary?.trim();
  if (summary) {
    pushCandidate(`任务「${input.task.title}」经返工后收口：${summary}`, "repeated_mistake");
    return;
  }
  pushCandidate(
    `执行「${input.task.title}」同类改动前先逐条核对验收标准与构建门禁，减少返工`,
    "repeated_mistake",
  );
}

function pushAcceptFallbackLesson(
  input: DistillTaskLessonsInput,
  flags: { hadRework: boolean; hadScopeChanges: boolean; hadOverrun: boolean },
  pushCandidate: PushLessonCandidateFn,
): void {
  if (flags.hadRework) {
    pushReworkFallbackLesson(input, pushCandidate);
  } else if (flags.hadScopeChanges) {
    pushCandidate(
      `「${input.task.title}」中途调整范围至 Revision #${input.task.brief.scopeRevision}，开工前先确认完整边界与验收标准`,
      "missing_context",
    );
  } else if (flags.hadOverrun) {
    pushCandidate(
      `「${input.task.title}」实际耗时显著超过预估（${input.task.actualMinutes}m vs ${input.task.expectedMinutes}m），先做小范围定向验证再扩展`,
      "wasted_step",
    );
  }
}

function collectAcceptFrictionLessons(
  input: DistillTaskLessonsInput,
  candidateCount: () => number,
  pushCandidate: PushLessonCandidateFn,
): void {
  const unmetChecks = (input.checks ?? []).filter((check) => !check.met);
  const correctiveNote = input.note?.trim() ?? "";
  const nextSteps = (input.nextSteps ?? []).map((step) => step.trim()).filter(Boolean);
  const flags = {
    hadRework: (input.task.reworkCount ?? 0) > 0,
    hadScopeChanges: input.task.brief.scopeRevision > 1,
    hadOverrun: hasTaskOverrun(input.task),
  };

  const hasExplicitFriction =
    unmetChecks.length > 0 || Boolean(correctiveNote) || nextSteps.length > 0;
  if (!hasExplicitFriction && !flags.hadRework && !flags.hadScopeChanges && !flags.hadOverrun) {
    return;
  }

  for (const check of unmetChecks) {
    const evidence = check.evidence?.trim();
    const detail = evidence ? `${check.criterion}（${evidence}）` : check.criterion;
    pushCandidate(detail, "repeated_mistake", "验收前务必核对：");
  }

  if (correctiveNote) {
    pushCandidate(correctiveNote, "improvement", "复盘纠偏：");
  }

  for (const step of nextSteps) {
    pushCandidate(step, "improvement");
  }

  if (candidateCount() === 0) {
    pushAcceptFallbackLesson(input, flags, pushCandidate);
  }
}

export function extractLessonsFromTaskFriction(
  input: DistillTaskLessonsInput,
): Array<{ kind: MainChatLessonKind; text: string; origin: MainChatLessonOrigin }> {
  const origin: MainChatLessonOrigin = input.trigger === "rework" ? "auto_rework" : "auto_review";
  const candidates: Array<{
    kind: MainChatLessonKind;
    text: string;
    origin: MainChatLessonOrigin;
  }> = [];
  const seenKeys = new Set<string>();

  const pushCandidate: PushLessonCandidateFn = (raw, fallbackKind, prefix) => {
    if (candidates.length >= MAIN_CHAT_LESSONS_PER_TASK_MAX) return;
    const text = normalizeCandidateLessonSentence(raw, prefix);
    if (text.length < 4) return;
    const dedupeKey = computeLessonDedupeKey(text);
    if (!dedupeKey || seenKeys.has(dedupeKey)) return;
    seenKeys.add(dedupeKey);
    candidates.push({
      kind: classifyCandidateLessonKind(text, fallbackKind),
      text,
      origin,
    });
  };

  if (input.trigger === "rework") {
    for (const gap of input.gaps ?? []) {
      pushCandidate(gap, "repeated_mistake", "避免同类返工：");
    }
    if (input.note?.trim()) {
      pushCandidate(input.note, "improvement", "纠偏要点：");
    }
    return candidates;
  }

  collectAcceptFrictionLessons(input, () => candidates.length, pushCandidate);
  return candidates.slice(0, MAIN_CHAT_LESSONS_PER_TASK_MAX);
}

function lessonLastSeenMs(lesson: MainChatProjectLesson): number {
  const lastSeen = Date.parse(lesson.lastSeenAt);
  if (Number.isFinite(lastSeen)) return lastSeen;
  const updated = Date.parse(lesson.updatedAt);
  return Number.isFinite(updated) ? updated : 0;
}

export function isProjectLessonFresh(lesson: MainChatProjectLesson, nowMs: number): boolean {
  if (lesson.retiredAt) return false;
  const seenMs = lessonLastSeenMs(lesson);
  if (seenMs <= 0) return false;
  return nowMs - seenMs <= FRESH_WINDOW_MS;
}

export function sortProjectLessons(
  lessons: readonly MainChatProjectLesson[],
): MainChatProjectLesson[] {
  return [...lessons].sort((left, right) => {
    if (right.seenCount !== left.seenCount) {
      return right.seenCount - left.seenCount;
    }
    const rightSeen = lessonLastSeenMs(right);
    const leftSeen = lessonLastSeenMs(left);
    if (rightSeen !== leftSeen) {
      return rightSeen - leftSeen;
    }
    return left.id.localeCompare(right.id);
  });
}

function truncateUtf8ToByteBudget(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const ellipsis = "…";
  const ellipsisBytes = Buffer.byteLength(ellipsis, "utf8");
  const targetBytes = Math.max(0, maxBytes - ellipsisBytes);
  let out = "";
  let used = 0;
  for (const ch of text) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (used + chBytes > targetBytes) break;
    out += ch;
    used += chBytes;
  }
  return out ? `${out}${ellipsis}` : "";
}

/**
 * Formats a deterministic, byte-budgeted "项目历史教训" context block for child-agent dispatch.
 * Selects fresh live lessons ordered by seenCount desc -> lastSeenAt desc -> id asc, capping
 * per-kind count, total count, and exact UTF-8 byte budget.
 */
export function formatProjectLessonsForDispatch(input: {
  projectLabel: string;
  lessons: readonly MainChatProjectLesson[];
  nowMs?: number;
  maxCount?: number;
  maxPerKind?: number;
  budgetBytes?: number;
}): FormattedProjectLessonsBlock {
  const nowMs = input.nowMs ?? Date.now();
  const maxCount = input.maxCount ?? MAIN_CHAT_LESSONS_INJECT_MAX_COUNT;
  const maxPerKind = input.maxPerKind ?? MAIN_CHAT_LESSONS_INJECT_PER_KIND_MAX;
  const budgetBytes = Math.max(256, input.budgetBytes ?? MAIN_CHAT_LESSONS_INJECT_BUDGET_BYTES);

  const fresh = sortProjectLessons(
    input.lessons.filter((lesson) => isProjectLessonFresh(lesson, nowMs)),
  );
  if (fresh.length === 0) {
    return { text: "", byteLength: 0, includedCount: 0, truncated: false, lessons: [] };
  }

  const header = `## 项目历史教训（${clipText(input.projectLabel, 60)} · 派活前请优先规避）`;
  const lines: string[] = [header];
  let usedBytes = Buffer.byteLength(header, "utf8");
  const included: MainChatProjectLesson[] = [];
  const perKindCount = new Map<MainChatLessonKind, number>();
  let truncated = false;

  for (const lesson of fresh) {
    if (included.length >= maxCount) {
      truncated = true;
      break;
    }
    const currentKindCount = perKindCount.get(lesson.kind) ?? 0;
    if (currentKindCount >= maxPerKind) {
      continue;
    }
    const kindLabel = LESSON_KIND_PROMPT_LABELS[lesson.kind];
    const dateTag = lesson.lastSeenAt.slice(0, 10);
    const seenTag = lesson.seenCount > 1 ? ` · 命中 ${lesson.seenCount} 次` : "";
    const prefix = `- [${kindLabel}${seenTag} · ${dateTag}] `;
    const fullLine = `${prefix}${lesson.text}`;
    const lineBytes = Buffer.byteLength(`\n${fullLine}`, "utf8");

    if (usedBytes + lineBytes <= budgetBytes) {
      lines.push(fullLine);
      usedBytes += lineBytes;
      included.push(lesson);
      perKindCount.set(lesson.kind, currentKindCount + 1);
      continue;
    }

    const remainingBytes = budgetBytes - usedBytes - Buffer.byteLength(`\n${prefix}`, "utf8");
    if (included.length === 0 && remainingBytes >= 24) {
      const clipped = truncateUtf8ToByteBudget(lesson.text, remainingBytes);
      if (clipped) {
        const truncatedLine = `${prefix}${clipped}`;
        lines.push(truncatedLine);
        usedBytes += Buffer.byteLength(`\n${truncatedLine}`, "utf8");
        included.push(lesson);
        perKindCount.set(lesson.kind, currentKindCount + 1);
      }
    }
    truncated = true;
    break;
  }

  if (included.length === 0) {
    return { text: "", byteLength: 0, includedCount: 0, truncated: false, lessons: [] };
  }

  const text = lines.join("\n");
  return {
    text,
    byteLength: Buffer.byteLength(text, "utf8"),
    includedCount: included.length,
    truncated,
    lessons: included,
  };
}

export function groupProjectLessons(
  lessons: readonly MainChatProjectLesson[],
): MainChatProjectLessonGroup[] {
  const byProject = new Map<string, { projectLabel: string; lessons: MainChatProjectLesson[] }>();
  for (const lesson of lessons) {
    if (lesson.retiredAt) continue;
    const existing = byProject.get(lesson.projectKey);
    if (existing) {
      existing.lessons.push(lesson);
    } else {
      byProject.set(lesson.projectKey, {
        projectLabel: lesson.projectLabel,
        lessons: [lesson],
      });
    }
  }

  const groups: MainChatProjectLessonGroup[] = [];
  for (const [projectKey, entry] of byProject.entries()) {
    const sorted = sortProjectLessons(entry.lessons);
    groups.push({
      projectKey,
      projectLabel: entry.projectLabel,
      lessonCount: sorted.length,
      lessons: sorted,
    });
  }

  groups.sort((left, right) => {
    const rightLatest = right.lessons[0] ? lessonLastSeenMs(right.lessons[0]) : 0;
    const leftLatest = left.lessons[0] ? lessonLastSeenMs(left.lessons[0]) : 0;
    if (rightLatest !== leftLatest) return rightLatest - leftLatest;
    return left.projectLabel.localeCompare(right.projectLabel);
  });

  return groups;
}

export class MainChatProjectLessonsStore {
  private readonly filePath: string;
  private loaded = false;
  private state: ProjectLessonsState = { version: 1, lessons: [], retired: [] };
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(paseoHome: string, options?: { now?: () => number }) {
    this.filePath = path.join(paseoHome, MAIN_CHAT_WORKSPACE_DIR_NAME, LESSONS_FILE_NAME);
    this.now = options?.now ?? (() => Date.now());
  }

  getFilePath(): string {
    return this.filePath;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = ProjectLessonsFileSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        this.state = {
          version: 1,
          lessons: parsed.data.lessons.filter((entry) => !entry.retiredAt),
          retired: parsed.data.retired ?? [],
        };
      }
    } catch {
      this.state = { version: 1, lessons: [], retired: [] };
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    const snapshot: ProjectLessonsState = {
      version: 1,
      lessons: this.state.lessons.slice(0, MAX_RETAINED_LESSONS),
      retired: this.state.retired.slice(0, MAX_RETAINED_RETIRED_KEYS),
    };
    const nextWrite = this.writeQueue.then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
      await rename(tmpPath, this.filePath);
      return undefined;
    });
    this.writeQueue = nextWrite.catch(() => undefined);
    await nextWrite;
  }

  private cloneLesson(lesson: MainChatProjectLesson): MainChatProjectLesson {
    return {
      ...lesson,
      sourceTaskIds: [...lesson.sourceTaskIds],
    };
  }

  private validateAddLessonInput(input: AddProjectLessonInput): {
    projectKey: string;
    projectLabel: string;
    text: string;
    dedupeKey: string;
    origin: MainChatLessonOrigin;
    allowUnretire: boolean;
    taskId: string | null;
  } {
    const projectKey = normalizeProjectLessonPath(input.projectKey);
    if (!projectKey) {
      throw new Error("项目路径或标识 projectKey 不能为空");
    }
    if (!MAIN_CHAT_LESSON_KINDS.includes(input.kind)) {
      throw new Error(`不支持的教训分类：${input.kind}`);
    }
    const text = clipText(input.text, MAIN_CHAT_LESSON_TEXT_MAX_CHARS);
    if (!text) {
      throw new Error("教训内容不能为空");
    }
    const dedupeKey = computeLessonDedupeKey(text);
    if (!dedupeKey) {
      throw new Error("教训内容缺少有效文字");
    }
    const origin: MainChatLessonOrigin = input.origin ?? "manual";
    const projectLabel = clipText(
      input.projectLabel?.trim() || path.basename(projectKey) || projectKey,
      MAIN_CHAT_LESSON_PROJECT_LABEL_MAX_CHARS,
    );
    return {
      projectKey,
      projectLabel,
      text,
      dedupeKey,
      origin,
      allowUnretire: input.allowUnretire ?? (origin === "manual" || origin === "tool"),
      taskId: input.taskId?.trim() || null,
    };
  }

  listLessons(options?: {
    projectKey?: string | null;
    aliasKeys?: readonly string[];
  }): MainChatProjectLesson[] {
    const filterKeys = new Set<string>();
    if (options?.projectKey?.trim()) {
      filterKeys.add(normalizeProjectLessonPath(options.projectKey));
    }
    for (const alias of options?.aliasKeys ?? []) {
      const normalized = normalizeProjectLessonPath(alias);
      if (normalized) filterKeys.add(normalized);
    }

    const live = this.state.lessons.filter((lesson) => {
      if (lesson.retiredAt) return false;
      if (filterKeys.size === 0) return true;
      return filterKeys.has(lesson.projectKey);
    });
    return sortProjectLessons(live).map((lesson) => this.cloneLesson(lesson));
  }

  listGroups(options?: { projectKey?: string | null }): MainChatProjectLessonGroup[] {
    return groupProjectLessons(this.listLessons({ projectKey: options?.projectKey }));
  }

  async addLesson(input: AddProjectLessonInput): Promise<AddProjectLessonResult> {
    await this.load();
    const parsed = this.validateAddLessonInput(input);
    const retiredIdx = this.state.retired.findIndex(
      (entry) => entry.projectKey === parsed.projectKey && entry.dedupeKey === parsed.dedupeKey,
    );
    if (retiredIdx >= 0) {
      if (!parsed.allowUnretire) {
        return { lesson: null, deduplicated: false, skippedRetired: true };
      }
      this.state.retired.splice(retiredIdx, 1);
    }

    const nowIso = new Date(this.now()).toISOString();
    const existingIdx = this.state.lessons.findIndex(
      (entry) =>
        !entry.retiredAt &&
        entry.projectKey === parsed.projectKey &&
        computeLessonDedupeKey(entry.text) === parsed.dedupeKey,
    );

    if (existingIdx >= 0) {
      const existing = this.state.lessons[existingIdx]!;
      const alreadyRecordedForTask = Boolean(
        parsed.taskId && existing.sourceTaskIds.includes(parsed.taskId),
      );
      const nextSources =
        parsed.taskId && !alreadyRecordedForTask
          ? [...existing.sourceTaskIds, parsed.taskId].slice(-MAIN_CHAT_LESSONS_MAX_SOURCES)
          : [...existing.sourceTaskIds];
      const updated: MainChatProjectLesson = {
        ...existing,
        projectLabel: input.projectLabel?.trim() ? parsed.projectLabel : existing.projectLabel,
        seenCount: alreadyRecordedForTask ? existing.seenCount : existing.seenCount + 1,
        sourceTaskIds: nextSources,
        lastSeenAt: nowIso,
        updatedAt: nowIso,
      };
      this.state.lessons[existingIdx] = updated;
      await this.persist();
      return {
        lesson: this.cloneLesson(updated),
        deduplicated: true,
        skippedRetired: false,
      };
    }

    const created: MainChatProjectLesson = {
      id: makeLessonId(),
      projectKey: parsed.projectKey,
      projectLabel: parsed.projectLabel,
      kind: input.kind,
      text: parsed.text,
      origin: parsed.origin,
      seenCount: 1,
      sourceTaskIds: parsed.taskId ? [parsed.taskId] : [],
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso,
      retiredAt: null,
    };

    this.state.lessons.unshift(created);
    if (this.state.lessons.length > MAX_RETAINED_LESSONS) {
      this.state.lessons = sortProjectLessons(this.state.lessons).slice(0, MAX_RETAINED_LESSONS);
    }
    await this.persist();
    return {
      lesson: { ...created, sourceTaskIds: [...created.sourceTaskIds] },
      deduplicated: false,
      skippedRetired: false,
    };
  }

  async deleteLesson(
    lessonId: string,
  ): Promise<{ deleted: boolean; lesson: MainChatProjectLesson | null }> {
    await this.load();
    const targetId = lessonId.trim();
    const idx = this.state.lessons.findIndex((entry) => entry.id === targetId);
    if (idx < 0) {
      return { deleted: false, lesson: null };
    }
    const [removed] = this.state.lessons.splice(idx, 1);
    const nowIso = new Date(this.now()).toISOString();
    if (removed) {
      const dedupeKey = computeLessonDedupeKey(removed.text);
      if (dedupeKey) {
        this.state.retired = [
          {
            lessonId: removed.id,
            projectKey: removed.projectKey,
            dedupeKey,
            text: removed.text,
            retiredAt: nowIso,
          },
          ...this.state.retired.filter(
            (entry) => !(entry.projectKey === removed.projectKey && entry.dedupeKey === dedupeKey),
          ),
        ].slice(0, MAX_RETAINED_RETIRED_KEYS);
      }
    }
    await this.persist();
    return { deleted: true, lesson: removed ?? null };
  }

  async recordFromTaskFriction(input: DistillTaskLessonsInput): Promise<MainChatProjectLesson[]> {
    await this.load();
    const identity = resolveProjectLessonIdentity({
      cwd: input.projectContext?.cwd ?? input.task.cwd,
      projectRoot: input.projectContext?.projectRoot,
      remoteUrl: input.projectContext?.remoteUrl,
      projectLabel: input.projectContext?.projectLabel ?? input.task.workspaceLabel,
    });
    if (!identity) return [];

    const extracted = extractLessonsFromTaskFriction(input);
    if (extracted.length === 0) return [];

    const saved: MainChatProjectLesson[] = [];
    for (const candidate of extracted) {
      const result = await this.addLesson({
        projectKey: identity.projectKey,
        projectLabel: identity.projectLabel,
        kind: candidate.kind,
        text: candidate.text,
        origin: candidate.origin,
        taskId: input.task.id,
        allowUnretire: false,
      });
      if (result.lesson) {
        saved.push(result.lesson);
      }
    }
    return saved;
  }

  buildDispatchBlockForProject(
    context: ProjectLessonTargetContext,
    options?: {
      budgetBytes?: number;
      maxCount?: number;
      maxPerKind?: number;
    },
  ): FormattedProjectLessonsBlock {
    const identity = resolveProjectLessonIdentity(context);
    if (!identity) {
      return { text: "", byteLength: 0, includedCount: 0, truncated: false, lessons: [] };
    }
    const matched = this.listLessons({ aliasKeys: identity.aliasKeys });
    return formatProjectLessonsForDispatch({
      projectLabel: identity.projectLabel,
      lessons: matched,
      nowMs: this.now(),
      budgetBytes: options?.budgetBytes,
      maxCount: options?.maxCount,
      maxPerKind: options?.maxPerKind,
    });
  }
}
