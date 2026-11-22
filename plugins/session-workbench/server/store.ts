import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PaseoAgent, PaseoApi } from "./paseo-types.js";
import { z } from "zod";
import {
  buildMetadataMirror,
  computeOverviewCounts,
  createEmptyCard,
  HELPER_LABEL_KEY,
  SessionWorkbenchCardSchema,
  WORKBENCH_METADATA_KEY,
  type AdvancePolicy,
  type ForkMode,
  type OverviewSnapshot,
  type RuntimeStatus,
  type SessionWorkbenchCard,
  type SuggestedTodo,
  type TodoAuthor,
  type TodoItem,
  type TodoStatus,
  type WaitCondition,
  type WorkflowStatus,
} from "../shared/schema.js";

const PersistedStateSchema = z.object({
  version: z.literal(1),
  cards: z.record(z.string(), SessionWorkbenchCardSchema),
});

export function defaultDataDir(): string {
  const paseoHome = process.env.PASEO_HOME?.trim() || path.join(os.homedir(), ".paseo");
  return path.join(paseoHome, "plugin-data", "session-workbench");
}

export function isHelperAgent(input: {
  background?: boolean;
  labels?: Readonly<Record<string, string>>;
}): boolean {
  return Boolean(input.background) || Boolean(input.labels?.[HELPER_LABEL_KEY]);
}

function normalizeRuntimeStatus(status: string | null | undefined): RuntimeStatus {
  if (
    status === "initializing" ||
    status === "idle" ||
    status === "running" ||
    status === "error" ||
    status === "closed"
  ) {
    return status;
  }
  return "unknown";
}

export interface CardMetaPatch {
  workspaceId?: string | null;
  agentTitle?: string | null;
  runtimeStatus?: RuntimeStatus;
  topic?: string;
  topicLocked?: boolean;
  currentWork?: string;
  workflowStatus?: WorkflowStatus;
  statusNote?: string;
  waitCondition?: WaitCondition | null;
  advancePolicy?: AdvancePolicy;
  conditionMetNotice?: string | null;
  clearConditionNotice?: boolean;
  summaryState?: "idle" | "running" | "error";
  summaryError?: string | null;
  summaryModel?: string | null;
  lastSummarizedAt?: string | null;
  lastSummarizedTurnId?: string | null;
  forkedFromAgentId?: string | null;
  forkedFromTodoId?: string | null;
  archived?: boolean;
}

export interface WorkbenchStoreOptions {
  dataDir?: string;
  now?: () => string;
  syncMetadata?: (agentId: string, card: SessionWorkbenchCard) => Promise<void>;
}

export class WorkbenchStore {
  readonly dataDir: string;
  readonly stateFile: string;
  private readonly now: () => string;
  private readonly syncMetadataFn?: (agentId: string, card: SessionWorkbenchCard) => Promise<void>;
  private readonly cards = new Map<string, SessionWorkbenchCard>();
  private readonly cardListeners = new Map<string, Set<(card: SessionWorkbenchCard) => void>>();
  private readonly overviewListeners = new Set<() => void>();
  private readonly metadataTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private loadPromise: Promise<void> | null = null;
  private persistChain: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(options: WorkbenchStoreOptions = {}) {
    this.dataDir = options.dataDir ?? defaultDataDir();
    this.stateFile = path.join(this.dataDir, "state.json");
    this.now = options.now ?? (() => new Date().toISOString());
    this.syncMetadataFn = options.syncMetadata;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk();
    }
    await this.loadPromise;
  }

  private async loadFromDisk(): Promise<void> {
    try {
      const raw = await readFile(this.stateFile, "utf8");
      const parsed = PersistedStateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) return;
      for (const [agentId, card] of Object.entries(parsed.data.cards)) {
        // Recover transient summary running states left over from a daemon crash.
        this.cards.set(agentId, {
          ...card,
          summaryState: card.summaryState === "running" ? "idle" : card.summaryState,
        });
      }
    } catch {
      // Missing or unreadable state file starts cleanly.
    }
  }

  private schedulePersist(): void {
    if (this.disposed) return;
    const snapshot = JSON.stringify(
      {
        version: 1,
        cards: Object.fromEntries(this.cards.entries()),
      },
      null,
      2,
    );
    this.persistChain = this.persistChain
      .then(async () => {
        if (this.disposed) return;
        await mkdir(this.dataDir, { recursive: true });
        if (this.disposed) return;
        const tempFile = `${this.stateFile}.tmp.${process.pid}.${randomUUID()}`;
        await writeFile(tempFile, snapshot, "utf8");
        await rename(tempFile, this.stateFile);
      })
      .catch(() => {
        // Persistence errors must not crash the plugin subprocess.
      });
  }

  async flush(): Promise<void> {
    await this.persistChain;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.metadataTimers.values()) {
      clearTimeout(timer);
    }
    this.metadataTimers.clear();
    this.cardListeners.clear();
    this.overviewListeners.clear();
  }

  getCardIfPresent(agentId: string): SessionWorkbenchCard | null {
    return this.cards.get(agentId) ?? null;
  }

  getOrCreateCard(input: {
    agentId: string;
    workspaceId?: string | null;
    agentTitle?: string | null;
    runtimeStatus?: RuntimeStatus;
  }): SessionWorkbenchCard {
    const existing = this.cards.get(input.agentId);
    if (existing) {
      let changed = false;
      const next = { ...existing };
      if (input.workspaceId !== undefined && input.workspaceId !== existing.workspaceId) {
        next.workspaceId = input.workspaceId;
        changed = true;
      }
      if (input.agentTitle !== undefined && input.agentTitle !== existing.agentTitle) {
        next.agentTitle = input.agentTitle;
        changed = true;
      }
      if (input.runtimeStatus !== undefined && input.runtimeStatus !== existing.runtimeStatus) {
        next.runtimeStatus = input.runtimeStatus;
        changed = true;
      }
      if (changed) {
        this.commit(next, { syncMeta: false });
        return next;
      }
      return existing;
    }
    const created = createEmptyCard({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      agentTitle: input.agentTitle,
      runtimeStatus: input.runtimeStatus,
      now: this.now(),
    });
    this.cards.set(input.agentId, created);
    return created;
  }

  syncAgentSnapshot(agent: Pick<PaseoAgent, "id" | "workspaceId" | "title" | "status" | "archivedAt" | "background" | "labels">): SessionWorkbenchCard | null {
    if (isHelperAgent({ background: agent.background, labels: agent.labels })) {
      return null;
    }
    const existing = this.cards.get(agent.id);
    const runtimeStatus = normalizeRuntimeStatus(agent.status);
    const archived = Boolean(agent.archivedAt);
    const agentTitle = agent.title ?? null;
    const workspaceId = agent.workspaceId ?? null;
    if (!existing) {
      const created = createEmptyCard({
        agentId: agent.id,
        workspaceId,
        agentTitle,
        runtimeStatus,
        now: this.now(),
      });
      created.archived = archived;
      if (agentTitle && !created.topic) {
        created.topic = agentTitle;
      }
      this.cards.set(agent.id, created);
      this.schedulePersist();
      this.notify(created);
      return created;
    }
    const next: SessionWorkbenchCard = {
      ...existing,
      workspaceId: workspaceId ?? existing.workspaceId,
      agentTitle: agentTitle ?? existing.agentTitle,
      runtimeStatus,
      archived,
      topic: existing.topic || agentTitle || "",
    };
    const changed =
      next.workspaceId !== existing.workspaceId ||
      next.agentTitle !== existing.agentTitle ||
      next.runtimeStatus !== existing.runtimeStatus ||
      next.archived !== existing.archived ||
      next.topic !== existing.topic;
    if (!changed) return existing;
    this.commit(next, { syncMeta: false });
    return next;
  }

  async hydrateFromDaemon(paseo: PaseoApi): Promise<void> {
    await this.ensureLoaded();
    try {
      const page = await paseo.agents.list({ page: { limit: 200 } });
      for (const entry of page.entries) {
        this.syncAgentSnapshot(entry.agent);
      }
    } catch {
      // Initial daemon hydration is best-effort.
    }
  }

  updateCard(agentId: string, patch: CardMetaPatch): SessionWorkbenchCard {
    const base = this.getOrCreateCard({
      agentId,
      workspaceId: patch.workspaceId,
      agentTitle: patch.agentTitle,
      runtimeStatus: patch.runtimeStatus,
    });
    const next: SessionWorkbenchCard = {
      ...base,
      ...(patch.workspaceId !== undefined ? { workspaceId: patch.workspaceId } : {}),
      ...(patch.agentTitle !== undefined ? { agentTitle: patch.agentTitle } : {}),
      ...(patch.runtimeStatus !== undefined ? { runtimeStatus: patch.runtimeStatus } : {}),
      ...(patch.topic !== undefined ? { topic: patch.topic.trim() } : {}),
      ...(patch.topicLocked !== undefined ? { topicLocked: patch.topicLocked } : {}),
      ...(patch.currentWork !== undefined ? { currentWork: patch.currentWork.trim() } : {}),
      ...(patch.workflowStatus !== undefined ? { workflowStatus: patch.workflowStatus } : {}),
      ...(patch.statusNote !== undefined ? { statusNote: patch.statusNote.trim() } : {}),
      ...(patch.waitCondition !== undefined ? { waitCondition: patch.waitCondition } : {}),
      ...(patch.advancePolicy !== undefined ? { advancePolicy: patch.advancePolicy } : {}),
      ...(patch.conditionMetNotice !== undefined
        ? { conditionMetNotice: patch.conditionMetNotice }
        : {}),
      ...(patch.clearConditionNotice ? { conditionMetNotice: null } : {}),
      ...(patch.summaryState !== undefined ? { summaryState: patch.summaryState } : {}),
      ...(patch.summaryError !== undefined ? { summaryError: patch.summaryError } : {}),
      ...(patch.summaryModel !== undefined ? { summaryModel: patch.summaryModel } : {}),
      ...(patch.lastSummarizedAt !== undefined ? { lastSummarizedAt: patch.lastSummarizedAt } : {}),
      ...(patch.lastSummarizedTurnId !== undefined
        ? { lastSummarizedTurnId: patch.lastSummarizedTurnId }
        : {}),
      ...(patch.forkedFromAgentId !== undefined
        ? { forkedFromAgentId: patch.forkedFromAgentId }
        : {}),
      ...(patch.forkedFromTodoId !== undefined ? { forkedFromTodoId: patch.forkedFromTodoId } : {}),
      ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
      updatedAt: this.now(),
    };
    this.commit(next, { syncMeta: true });
    return next;
  }

  addTodo(input: {
    agentId: string;
    workspaceId?: string | null;
    title: string;
    prompt?: string;
    author?: TodoAuthor;
    status?: TodoStatus;
  }): { card: SessionWorkbenchCard; todo: TodoItem } {
    const base = this.getOrCreateCard({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    });
    const timestamp = this.now();
    const trimmedTitle = input.title.trim();
    const trimmedPrompt = input.prompt?.trim();
    const todo: TodoItem = {
      id: `todo_${randomUUID().slice(0, 8)}`,
      title: trimmedTitle,
      ...(trimmedPrompt && trimmedPrompt !== trimmedTitle ? { prompt: trimmedPrompt } : {}),
      author: input.author ?? "user",
      status: input.status ?? "open",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const next: SessionWorkbenchCard = {
      ...base,
      todos: [...base.todos, todo],
      updatedAt: timestamp,
    };
    this.commit(next, { syncMeta: true });
    return { card: next, todo };
  }

  updateTodo(
    agentId: string,
    todoId: string,
    patch: {
      title?: string;
      prompt?: string;
      status?: TodoStatus;
      linkedTurnId?: string;
      forkedAgentId?: string;
      forkedWorkspaceId?: string;
      forkMode?: ForkMode;
    },
  ): SessionWorkbenchCard {
    const base = this.getOrCreateCard({ agentId });
    const timestamp = this.now();
    let matched = false;
    const todos = base.todos.map((item) => {
      if (item.id !== todoId) return item;
      matched = true;
      return {
        ...item,
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() || undefined } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.linkedTurnId !== undefined ? { linkedTurnId: patch.linkedTurnId } : {}),
        ...(patch.forkedAgentId !== undefined ? { forkedAgentId: patch.forkedAgentId } : {}),
        ...(patch.forkedWorkspaceId !== undefined
          ? { forkedWorkspaceId: patch.forkedWorkspaceId }
          : {}),
        ...(patch.forkMode !== undefined ? { forkMode: patch.forkMode } : {}),
        updatedAt: timestamp,
      };
    });
    if (!matched) {
      throw new Error(`Todo not found: ${todoId}`);
    }
    const next: SessionWorkbenchCard = {
      ...base,
      todos,
      updatedAt: timestamp,
    };
    this.commit(next, { syncMeta: true });
    return next;
  }

  findTodoByIdOrTitle(agentId: string, idOrTitle: string): TodoItem | null {
    const card = this.cards.get(agentId);
    if (!card) return null;
    const exactId = card.todos.find((item) => item.id === idOrTitle);
    if (exactId) return exactId;
    const normalized = idOrTitle.trim().toLowerCase();
    return card.todos.find((item) => item.title.trim().toLowerCase() === normalized) ?? null;
  }

  removeTodo(agentId: string, todoId: string): SessionWorkbenchCard {
    const base = this.getOrCreateCard({ agentId });
    const todos = base.todos.filter((item) => item.id !== todoId);
    const next: SessionWorkbenchCard = {
      ...base,
      todos,
      updatedAt: this.now(),
    };
    this.commit(next, { syncMeta: true });
    return next;
  }

  mergeSuggestedTodos(
    agentId: string,
    suggestions: readonly { title: string; prompt?: string }[],
  ): SessionWorkbenchCard {
    const base = this.getOrCreateCard({ agentId });
    if (suggestions.length === 0) return base;
    const existingKeys = new Set<string>([
      ...base.todos.map((item) => item.title.trim().toLowerCase()),
      ...base.suggestedTodos.map((item) => item.title.trim().toLowerCase()),
    ]);
    const timestamp = this.now();
    const appended: SuggestedTodo[] = [];
    for (const suggestion of suggestions) {
      const title = suggestion.title.trim();
      if (!title) continue;
      const key = title.toLowerCase();
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      appended.push({
        id: `sug_${randomUUID().slice(0, 8)}`,
        title: title.slice(0, 200),
        ...(suggestion.prompt?.trim() ? { prompt: suggestion.prompt.trim().slice(0, 1000) } : {}),
        createdAt: timestamp,
      });
    }
    if (appended.length === 0) return base;
    const next: SessionWorkbenchCard = {
      ...base,
      suggestedTodos: [...base.suggestedTodos, ...appended].slice(-8),
      updatedAt: timestamp,
    };
    this.commit(next, { syncMeta: false });
    return next;
  }

  resolveSuggestedTodo(
    agentId: string,
    suggestedId: string,
    action: "accept" | "dismiss",
  ): SessionWorkbenchCard {
    const base = this.getOrCreateCard({ agentId });
    const target = base.suggestedTodos.find((item) => item.id === suggestedId);
    const remaining = base.suggestedTodos.filter((item) => item.id !== suggestedId);
    const timestamp = this.now();
    if (!target || action === "dismiss") {
      const next: SessionWorkbenchCard = {
        ...base,
        suggestedTodos: remaining,
        updatedAt: timestamp,
      };
      this.commit(next, { syncMeta: false });
      return next;
    }
    const todo: TodoItem = {
      id: `todo_${randomUUID().slice(0, 8)}`,
      title: target.title,
      ...(target.prompt ? { prompt: target.prompt } : {}),
      author: "summarizer",
      status: "open",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const next: SessionWorkbenchCard = {
      ...base,
      suggestedTodos: remaining,
      todos: [...base.todos, todo],
      updatedAt: timestamp,
    };
    this.commit(next, { syncMeta: true });
    return next;
  }

  listCards(options: { includeArchived?: boolean } = {}): SessionWorkbenchCard[] {
    const includeArchived = options.includeArchived === true;
    return [...this.cards.values()]
      .filter((card) => includeArchived || !card.archived)
      .sort((a, b) => {
        const score = (card: SessionWorkbenchCard) => {
          if (card.conditionMetNotice) return 0;
          switch (card.workflowStatus) {
            case "waiting_me":
              return 1;
            case "waiting_external":
              return 2;
            case "waiting_dependency":
              return 3;
            case "active":
              return 4;
            case "snoozed":
              return 5;
            case "done":
              return 6;
          }
        };
        const diff = score(a) - score(b);
        if (diff !== 0) return diff;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }

  getOverview(options: { includeArchived?: boolean } = {}): OverviewSnapshot {
    const cards = this.listCards(options);
    return {
      cards,
      counts: computeOverviewCounts(cards),
    };
  }

  subscribeCard(agentId: string, listener: (card: SessionWorkbenchCard) => void): () => void {
    let set = this.cardListeners.get(agentId);
    if (!set) {
      set = new Set();
      this.cardListeners.set(agentId, set);
    }
    set.add(listener);
    return () => {
      const current = this.cardListeners.get(agentId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) this.cardListeners.delete(agentId);
    };
  }

  subscribeOverview(listener: () => void): () => void {
    this.overviewListeners.add(listener);
    return () => {
      this.overviewListeners.delete(listener);
    };
  }

  private commit(card: SessionWorkbenchCard, options: { syncMeta: boolean }): void {
    this.cards.set(card.agentId, card);
    this.schedulePersist();
    this.notify(card);
    if (options.syncMeta && this.syncMetadataFn && !this.disposed) {
      const existingTimer = this.metadataTimers.get(card.agentId);
      if (existingTimer) clearTimeout(existingTimer);
      const timer = setTimeout(() => {
        this.metadataTimers.delete(card.agentId);
        const latest = this.cards.get(card.agentId);
        if (!latest || this.disposed) return;
        void this.syncMetadataFn?.(card.agentId, latest).catch(() => {});
      }, 250);
      this.metadataTimers.set(card.agentId, timer);
    }
  }

  private notify(card: SessionWorkbenchCard): void {
    const listeners = this.cardListeners.get(card.agentId);
    if (listeners) {
      for (const listener of listeners) {
        listener(card);
      }
    }
    for (const listener of this.overviewListeners) {
      listener();
    }
  }
}

export function createAgentMetadataSync(paseo: PaseoApi) {
  return async (agentId: string, card: SessionWorkbenchCard) => {
    await paseo.agents.ref(agentId).setMetadata({
      [WORKBENCH_METADATA_KEY]: buildMetadataMirror(card),
    });
  };
}
