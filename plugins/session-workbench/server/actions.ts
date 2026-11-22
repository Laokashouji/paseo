import type { PluginSettings } from "@getpaseo/plugin/server";
import type { PaseoApi } from "./paseo-types.js";
import type {
  ForkContextMode,
  ForkMode,
  SessionWorkbenchCard,
  TodoItem,
} from "../shared/schema.js";
import {
  DEFAULT_WORKBENCH_SETTINGS,
  type WorkbenchSettings,
  type workbenchSettingsSchema,
} from "../shared/settings.js";
import type { WorkbenchStore } from "./store.js";
import { readRecentExcerpts } from "./summarizer.js";

function sanitizeBranchSlug(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const suffix = Date.now().toString(36).slice(-4);
  return `workbench/${ascii || "task"}-${suffix}`;
}

async function readSettings(
  settings: PluginSettings<typeof workbenchSettingsSchema>,
): Promise<WorkbenchSettings> {
  try {
    const state = await settings.read();
    if (state.status === "ready") return state.values;
  } catch {
    // Fallback to defaults.
  }
  return DEFAULT_WORKBENCH_SETTINGS;
}

function resolveTodoPrompt(todo: TodoItem): string {
  return todo.prompt?.trim() || todo.title;
}

export async function runTodoAction(input: {
  store: WorkbenchStore;
  paseo: PaseoApi;
  agentId: string;
  todoId: string;
  mode: "send_now" | "queue_next";
}): Promise<{ card: SessionWorkbenchCard; dispatched: "sent" | "queued" }> {
  const card = input.store.getOrCreateCard({ agentId: input.agentId });
  const todo = card.todos.find((item) => item.id === input.todoId);
  if (!todo) {
    throw new Error(`未找到待办: ${input.todoId}`);
  }

  const handle = input.paseo.agents.ref(input.agentId);
  const refreshed = await handle.refresh().catch(() => null);
  if (refreshed) {
    input.store.syncAgentSnapshot(refreshed.agent);
  }
  const currentStatus = refreshed?.agent.status ?? card.runtimeStatus;
  const shouldQueue = input.mode === "queue_next" || currentStatus === "running";

  if (shouldQueue) {
    const updated = input.store.updateTodo(input.agentId, input.todoId, { status: "queued" });
    return { card: updated, dispatched: "queued" };
  }

  await handle.send(resolveTodoPrompt(todo));
  const updated = input.store.updateTodo(input.agentId, input.todoId, { status: "running" });
  input.store.updateCard(input.agentId, {
    currentWork: todo.title,
    workflowStatus: "active",
    clearConditionNotice: true,
  });
  return { card: input.store.getOrCreateCard({ agentId: input.agentId }), dispatched: "sent" };
}

export async function handleTurnCompletedQueueAndTodos(input: {
  store: WorkbenchStore;
  paseo: PaseoApi;
  agentId: string;
  turnId: string | null;
  outcomeKind: "completed" | "failed" | "canceled";
}): Promise<void> {
  const card = input.store.getCardIfPresent(input.agentId);
  if (!card) return;

  // Mark the currently running workbench todo as done when the turn succeeded.
  if (input.outcomeKind === "completed") {
    const runningTodo = card.todos.find((item) => item.status === "running");
    if (runningTodo) {
      input.store.updateTodo(input.agentId, runningTodo.id, {
        status: "done",
        ...(input.turnId ? { linkedTurnId: input.turnId } : {}),
      });
    }
  }

  if (input.outcomeKind !== "completed") return;

  const refreshedCard = input.store.getCardIfPresent(input.agentId);
  const nextQueued = refreshedCard?.todos.find((item) => item.status === "queued");
  if (!nextQueued) return;

  const handle = input.paseo.agents.ref(input.agentId);
  const latest = await handle.refresh().catch(() => null);
  if (!latest) return;
  if (
    latest.agent.status !== "idle" ||
    latest.agent.pendingPermissions.length > 0 ||
    latest.agent.lastError
  ) {
    return;
  }

  await handle.send(resolveTodoPrompt(nextQueued));
  input.store.updateTodo(input.agentId, nextQueued.id, { status: "running" });
  input.store.updateCard(input.agentId, {
    currentWork: nextQueued.title,
    workflowStatus: "active",
  });
}

async function buildSummaryContextAttachment(input: {
  card: SessionWorkbenchCard;
  paseo: PaseoApi;
  agentId: string;
}) {
  const lines: string[] = [
    `[来自源对话的工作台上下文]`,
    `源对话 ID: ${input.agentId}`,
    ...(input.card.topic ? [`主题工作: ${input.card.topic}`] : []),
    ...(input.card.currentWork ? [`当前进展: ${input.card.currentWork}`] : []),
    ...(input.card.statusNote ? [`状态备注: ${input.card.statusNote}`] : []),
  ];

  try {
    const excerpts = await readRecentExcerpts(input.paseo.agents.ref(input.agentId).timeline, {
      fallbackRounds: 2,
    });
    if (excerpts.length > 0) {
      lines.push("", "最近关键对话片段:");
      for (const item of excerpts) {
        lines.push(`${item.role === "user" ? "用户" : "助手"}: ${item.text.slice(0, 1200)}`);
      }
    }
  } catch {
    // Timeline excerpt is optional when card summary is already present.
  }

  return {
    type: "text" as const,
    mimeType: "text/plain" as const,
    contextKind: "chat_history" as const,
    title: input.card.topic ? `Fork 摘要: ${input.card.topic}` : "Fork 上下文摘要",
    text: lines.join("\n"),
  };
}

export async function forkTodoAction(input: {
  store: WorkbenchStore;
  settings: PluginSettings<typeof workbenchSettingsSchema>;
  paseo: PaseoApi;
  agentId: string;
  todoId: string;
  forkMode: ForkMode;
  contextMode?: ForkContextMode;
  branchName?: string;
}): Promise<{
  card: SessionWorkbenchCard;
  newAgentId: string;
  newWorkspaceId: string | null;
}> {
  const card = input.store.getOrCreateCard({ agentId: input.agentId });
  const todo = card.todos.find((item) => item.id === input.todoId);
  if (!todo) {
    throw new Error(`未找到待办: ${input.todoId}`);
  }

  const sourceHandle = input.paseo.agents.ref(input.agentId);
  const refreshed = await sourceHandle.refresh();
  if (!refreshed) {
    throw new Error("源对话不存在或已被移除");
  }
  const sourceAgent = refreshed.agent;
  const config = await readSettings(input.settings);
  const contextMode = input.contextMode ?? config.defaultForkContextMode;

  let attachment = await buildSummaryContextAttachment({
    card,
    paseo: input.paseo,
    agentId: input.agentId,
  });

  if (contextMode === "full_history" && typeof sourceHandle.buildForkContext === "function") {
    try {
      const forkContext = await sourceHandle.buildForkContext();
      if (forkContext.attachment) {
        attachment = {
          type: "text",
          mimeType: "text/plain",
          contextKind: "chat_history",
          title: forkContext.attachment.title ?? attachment.title,
          text: forkContext.attachment.text,
        };
      }
    } catch {
      // Fallback gracefully to summary context when host/agent fork context fails.
    }
  }

  const providerSpec = sourceAgent.model
    ? `${sourceAgent.provider}/${sourceAgent.model}`
    : sourceAgent.provider;

  const agentConfig = {
    provider: providerSpec,
    ...(sourceAgent.currentModeId ? { modeId: sourceAgent.currentModeId } : {}),
    ...(sourceAgent.thinkingOptionId ? { thinkingOptionId: sourceAgent.thinkingOptionId } : {}),
    ...(sourceAgent.options ? { options: sourceAgent.options } : {}),
  };

  const promptText = resolveTodoPrompt(todo);
  const metadata = {
    "session-workbench": {
      forkedFromAgentId: input.agentId,
      forkedFromTodoId: todo.id,
      workflowStatus: "active",
      topic: todo.title,
    },
  };

  let createdHandle;
  if (input.forkMode === "new_worktree") {
    const sourceCwd = refreshed.project?.checkout?.cwd || sourceAgent.cwd;
    const branch = input.branchName?.trim() || sanitizeBranchSlug(todo.title);
    createdHandle = await input.paseo.agents.create({
      cwd: sourceCwd,
      title: todo.title.slice(0, 60),
      prompt: promptText,
      attachments: [attachment],
      worktree: {
        mode: "branch-off",
        newBranch: branch,
      },
      config: agentConfig,
      metadata,
    });
  } else {
    if (!sourceAgent.workspaceId) {
      throw new Error("源对话没有关联工作区，无法在同工作区 Fork");
    }
    createdHandle = await input.paseo.workspaces.ref(sourceAgent.workspaceId).agents.create({
      title: todo.title.slice(0, 60),
      prompt: promptText,
      attachments: [attachment],
      config: agentConfig,
      metadata,
    });
  }

  const newWorkspaceId =
    createdHandle.workspaceId ??
    (input.forkMode === "same_workspace" ? (sourceAgent.workspaceId ?? null) : null);

  // Initialize the forked agent's own workbench card immediately so both sides link together.
  input.store.updateCard(createdHandle.id, {
    workspaceId: newWorkspaceId,
    agentTitle: todo.title.slice(0, 60),
    runtimeStatus: "running",
    topic: todo.title,
    currentWork: todo.title,
    workflowStatus: "active",
    forkedFromAgentId: input.agentId,
    forkedFromTodoId: todo.id,
  });

  const updatedSource = input.store.updateTodo(input.agentId, todo.id, {
    status: "forked",
    forkedAgentId: createdHandle.id,
    ...(newWorkspaceId ? { forkedWorkspaceId: newWorkspaceId } : {}),
    forkMode: input.forkMode,
  });

  return {
    card: updatedSource,
    newAgentId: createdHandle.id,
    newWorkspaceId,
  };
}

export async function evaluateAgentSettledConditions(input: {
  store: WorkbenchStore;
  paseo: PaseoApi;
  settledAgentId: string;
  trigger: "turn_completed" | "marked_done" | "archived";
}): Promise<string[]> {
  const settledCard = input.store.getCardIfPresent(input.settledAgentId);
  const settledLabel =
    settledCard?.topic || settledCard?.agentTitle || input.settledAgentId.slice(0, 10);

  const triggeredAgentIds: string[] = [];
  for (const waitingCard of input.store.listCards({ includeArchived: false })) {
    const matchingBlockers = waitingCard.blockers.filter((item) => {
      if (item.status !== "open" || item.kind !== "dependency") return false;
      if (item.targetAgentId !== input.settledAgentId) return false;
      const expect = item.expect ?? "idle";
      return expect === "idle"
        ? input.trigger === "turn_completed" ||
            input.trigger === "marked_done" ||
            input.trigger === "archived"
        : input.trigger === "marked_done" || input.trigger === "archived";
    });
    for (const blocker of matchingBlockers) {
      input.store.resolveBlocker(waitingCard.agentId, blocker.id);
    }

    const condition = waitingCard.waitCondition;
    const conditionMatches =
      condition?.kind === "agent_settled" &&
      condition.targetAgentId === input.settledAgentId &&
      (condition.expect === "idle"
        ? input.trigger === "turn_completed" ||
          input.trigger === "marked_done" ||
          input.trigger === "archived"
        : input.trigger === "marked_done" || input.trigger === "archived");

    if (!conditionMatches && matchingBlockers.length === 0) continue;

    triggeredAgentIds.push(waitingCard.agentId);
    const label =
      (condition?.kind === "agent_settled" ? condition.targetLabel : undefined) ||
      matchingBlockers[0]?.targetLabel ||
      settledLabel;
    const notice = `依赖对话「${label}」已${
      input.trigger === "turn_completed" ? "完成本轮执行" : "标记完成"
    }`;

    const refreshedWaiting = input.store.getCardIfPresent(waitingCard.agentId) ?? waitingCard;
    const hasOtherOpenBlockers = refreshedWaiting.blockers.some((item) => item.status === "open");
    if (hasOtherOpenBlockers) {
      input.store.updateCard(waitingCard.agentId, { conditionMetNotice: notice });
      continue;
    }

    await applyConditionMetAdvance({
      store: input.store,
      paseo: input.paseo,
      waitingCard: refreshedWaiting,
      notice,
      contextSummary: settledCard?.currentWork || settledCard?.topic || "",
    });
  }
  return triggeredAgentIds;
}

export async function resolveBlockerAction(input: {
  store: WorkbenchStore;
  paseo: PaseoApi;
  agentId: string;
  blockerId: string;
}): Promise<SessionWorkbenchCard> {
  const { card, resolved, allCleared } = input.store.resolveBlocker(input.agentId, input.blockerId);
  if (!resolved || !allCleared) {
    return card;
  }
  if (
    card.advancePolicy.mode === "auto_run_next_todo" ||
    card.advancePolicy.mode === "auto_send_prompt"
  ) {
    const notice = `阻塞「${resolved.title}」已解除`;
    await applyConditionMetAdvance({
      store: input.store,
      paseo: input.paseo,
      waitingCard: card,
      notice,
      contextSummary: notice,
    });
    return input.store.getOrCreateCard({ agentId: input.agentId });
  }
  return card;
}

export async function resolveExternalSignalAction(input: {
  store: WorkbenchStore;
  paseo: PaseoApi;
  agentId: string;
  note?: string;
}): Promise<SessionWorkbenchCard> {
  const waitingCard = input.store.getOrCreateCard({ agentId: input.agentId });
  for (const blocker of waitingCard.blockers) {
    if (blocker.status === "open" && blocker.kind === "external") {
      input.store.resolveBlocker(input.agentId, blocker.id);
    }
  }
  const latestCard = input.store.getOrCreateCard({ agentId: input.agentId });
  const reason =
    input.note?.trim() ||
    (latestCard.waitCondition?.kind === "external_signal"
      ? `外部信号「${latestCard.waitCondition.reason || latestCard.waitCondition.ref}」已确认`
      : "外部确认已达成");
  await applyConditionMetAdvance({
    store: input.store,
    paseo: input.paseo,
    waitingCard: latestCard,
    notice: reason,
    contextSummary: reason,
  });
  return input.store.getOrCreateCard({ agentId: input.agentId });
}

async function applyConditionMetAdvance(input: {
  store: WorkbenchStore;
  paseo: PaseoApi;
  waitingCard: SessionWorkbenchCard;
  notice: string;
  contextSummary: string;
}): Promise<void> {
  const { store, paseo, waitingCard, notice, contextSummary } = input;
  const policy = waitingCard.advancePolicy;

  store.updateCard(waitingCard.agentId, {
    waitCondition: null,
    workflowStatus: "waiting_me",
    conditionMetNotice: notice,
  });

  if (policy.mode === "notify_only" || policy.mode === "delegate_to_master") {
    return;
  }

  const handle = paseo.agents.ref(waitingCard.agentId);
  const latest = await handle.refresh().catch(() => null);
  if (!latest || latest.agent.status !== "idle" || latest.agent.pendingPermissions.length > 0) {
    return;
  }

  if (policy.mode === "auto_run_next_todo") {
    const nextTodo = waitingCard.todos.find(
      (item) => item.status === "queued" || item.status === "open",
    );
    if (!nextTodo) return;
    const prefix = contextSummary
      ? `前置条件已达成（${notice}；对方进展：${contextSummary}）。请继续执行以下待办：\n`
      : `前置条件已达成（${notice}）。请继续执行以下待办：\n`;
    await handle.send(`${prefix}${resolveTodoPrompt(nextTodo)}`);
    store.updateTodo(waitingCard.agentId, nextTodo.id, { status: "running" });
    store.updateCard(waitingCard.agentId, {
      currentWork: nextTodo.title,
      workflowStatus: "active",
      conditionMetNotice: `${notice}，已自动续跑「${nextTodo.title}」`,
    });
    return;
  }

  if (policy.mode === "auto_send_prompt" && policy.prompt?.trim()) {
    const prompt = contextSummary
      ? `前置条件已达成（${notice}；对方进展：${contextSummary}）。\n${policy.prompt.trim()}`
      : `前置条件已达成（${notice}）。\n${policy.prompt.trim()}`;
    await handle.send(prompt);
    store.updateCard(waitingCard.agentId, {
      workflowStatus: "active",
      conditionMetNotice: `${notice}，已自动推进对话`,
    });
  }
}
