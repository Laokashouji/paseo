import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  addTodoRpc,
  cardSubscription,
  forkTodoRpc,
  getCardRpc,
  getOverviewRpc,
  overviewSubscription,
  refreshSummaryRpc,
  removeTodoRpc,
  resolveExternalSignalRpc,
  resolveSuggestedTodoRpc,
  runTodoRpc,
  updateCardMetaRpc,
  updateTodoRpc,
} from "./shared/rpc.js";
import { DEFAULT_WORKBENCH_SETTINGS, workbenchSettings } from "./shared/settings.js";
import {
  evaluateAgentSettledConditions,
  forkTodoAction,
  handleTurnCompletedQueueAndTodos,
  resolveExternalSignalAction,
  runTodoAction,
} from "./server/actions.js";
import { createAgentMetadataSync, isHelperAgent, WorkbenchStore } from "./server/store.js";
import { provisionalTextFromPrompt, RollingSummarizer } from "./server/summarizer.js";
import {
  buildCardContextPrompt,
  createWorkbenchAgentTools,
  WORKBENCH_TOOLS_PROMPT,
} from "./server/tools.js";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(workbenchSettings);
  let activePaseo: PaseoApi | null = null;
  let hydrated = false;

  const store = new WorkbenchStore({
    syncMetadata: async (agentId, card) => {
      if (!activePaseo) return;
      await createAgentMetadataSync(activePaseo)(agentId, card);
    },
  });
  const summarizer = new RollingSummarizer(store, settings);

  async function ensureReady(paseo: PaseoApi): Promise<void> {
    activePaseo = paseo;
    await store.ensureLoaded();
    if (!hydrated) {
      hydrated = true;
      await store.hydrateFromDaemon(paseo);
    }
  }

  async function readConfig() {
    try {
      const state = await settings.read();
      if (state.status === "ready") return state.values;
    } catch {
      // Fallback to defaults.
    }
    return DEFAULT_WORKBENCH_SETTINGS;
  }

  const tools = createWorkbenchAgentTools(store, (agentId) => {
    if (!activePaseo) return;
    void evaluateAgentSettledConditions({
      store,
      paseo: activePaseo,
      settledAgentId: agentId,
      trigger: "marked_done",
    });
  });

  // RPC handlers
  server.handle(getCardRpc, async (input, { paseo }) => {
    await ensureReady(paseo);
    const existing = store.getCardIfPresent(input.agentId);
    if (!existing) {
      const fetched = await paseo.agents
        .ref(input.agentId)
        .refresh()
        .catch(() => null);
      if (fetched) {
        store.syncAgentSnapshot(fetched.agent);
      }
    }
    return {
      card: store.getOrCreateCard({
        agentId: input.agentId,
        workspaceId: input.workspaceId,
      }),
    };
  });

  server.handle(getOverviewRpc, async (input, { paseo }) => {
    await ensureReady(paseo);
    await store.hydrateFromDaemon(paseo);
    return store.getOverview({ includeArchived: input.includeArchived });
  });

  server.handle(updateCardMetaRpc, async (input, { paseo }) => {
    await ensureReady(paseo);
    const previous = store.getCardIfPresent(input.agentId);
    const card = store.updateCard(input.agentId, {
      workspaceId: input.workspaceId,
      topic: input.topic,
      topicLocked: input.topicLocked,
      currentWork: input.currentWork,
      workflowStatus: input.workflowStatus,
      statusNote: input.statusNote,
      waitCondition: input.waitCondition,
      advancePolicy: input.advancePolicy,
      clearConditionNotice: input.clearConditionNotice,
    });
    if (input.workflowStatus === "done" && previous?.workflowStatus !== "done") {
      void evaluateAgentSettledConditions({
        store,
        paseo,
        settledAgentId: input.agentId,
        trigger: "marked_done",
      });
    }
    return { card };
  });

  server.handle(addTodoRpc, async (input, { paseo }) => {
    await ensureReady(paseo);
    const { card, todo } = store.addTodo({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
      title: input.title,
      prompt: input.prompt,
      author: input.author ?? "user",
    });
    return { card, todoId: todo.id };
  });

  server.handle(updateTodoRpc, async (input, { paseo }) => {
    await ensureReady(paseo);
    const card = store.updateTodo(input.agentId, input.todoId, {
      title: input.title,
      prompt: input.prompt,
      status: input.status,
    });
    return { card };
  });

  server.handle(removeTodoRpc, async (input, { paseo }) => {
    await ensureReady(paseo);
    return { card: store.removeTodo(input.agentId, input.todoId) };
  });

  server.handle(resolveSuggestedTodoRpc, async (input, { paseo }) => {
    await ensureReady(paseo);
    return {
      card: store.resolveSuggestedTodo(input.agentId, input.suggestedId, input.action),
    };
  });

  server.handle(runTodoRpc, async (input, { paseo }) => {
    await ensureReady(paseo);
    return runTodoAction({
      store,
      paseo,
      agentId: input.agentId,
      todoId: input.todoId,
      mode: input.mode,
    });
  });

  server.handle(forkTodoRpc, async (input, { paseo }) => {
    await ensureReady(paseo);
    return forkTodoAction({
      store,
      settings,
      paseo,
      agentId: input.agentId,
      todoId: input.todoId,
      forkMode: input.forkMode,
      contextMode: input.contextMode,
      branchName: input.branchName,
    });
  });

  server.handle(refreshSummaryRpc, async (input, { paseo }) => {
    await ensureReady(paseo);
    const card = await summarizer.summarizeNow({
      agentId: input.agentId,
      paseo,
    });
    return { card };
  });

  server.handle(resolveExternalSignalRpc, async (input, { paseo }) => {
    await ensureReady(paseo);
    const card = await resolveExternalSignalAction({
      store,
      paseo,
      agentId: input.agentId,
      note: input.note,
    });
    return { card };
  });

  // Live subscriptions
  server.handle(cardSubscription, async (input, context) => {
    await ensureReady(context.paseo);
    const initial = store.getOrCreateCard({
      agentId: input.agentId,
      workspaceId: input.workspaceId,
    });
    void context.push({ card: initial }).catch(() => {});

    const unsubscribe = store.subscribeCard(input.agentId, (card) => {
      if (context.signal.aborted) return;
      void context.push({ card }).catch(() => {});
    });
    context.signal.addEventListener("abort", unsubscribe, { once: true });
  });

  server.handle(overviewSubscription, async (input, context) => {
    await ensureReady(context.paseo);
    await store.hydrateFromDaemon(context.paseo);
    void context.push(store.getOverview({ includeArchived: input.includeArchived })).catch(() => {});

    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsubscribe = store.subscribeOverview(() => {
      if (context.signal.aborted) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (context.signal.aborted) return;
        void context
          .push(store.getOverview({ includeArchived: input.includeArchived }))
          .catch(() => {});
      }, 120);
    });
    context.signal.addEventListener(
      "abort",
      () => {
        if (timer) clearTimeout(timer);
        unsubscribe();
      },
      { once: true },
    );
  });

  // Lifecycle hooks
  const removeOpenHook = server.addHook("agent.open.before", async ({ request }) => {
    await store.ensureLoaded();
    if (request.purpose !== "interactive" || isHelperAgent(request)) return undefined;
    const config = await readConfig();
    if (!config.enabled) return undefined;

    const card = store.getCardIfPresent(request.agentId);
    const appendSystemPrompt = [...(request.appendSystemPrompt ?? [])];
    const nextTools = [...request.tools];

    if (config.injectAgentTools) {
      const existingNames = new Set(nextTools.map((tool) => tool.name));
      for (const tool of tools) {
        if (!existingNames.has(tool.name)) {
          nextTools.push(tool);
        }
      }
      appendSystemPrompt.push(WORKBENCH_TOOLS_PROMPT);
    }

    if (config.injectCardContextPrompt) {
      const cardPrompt = buildCardContextPrompt(card);
      if (cardPrompt) {
        appendSystemPrompt.push(cardPrompt);
      }
    }

    return {
      ...request,
      tools: nextTools,
      appendSystemPrompt,
    };
  });

  const removeCreateHook = server.addHook("agent.create.after", async ({ agent }, { paseo }) => {
    if (isHelperAgent(agent)) return;
    await ensureReady(paseo);
    store.getOrCreateCard({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      agentTitle: agent.title,
      runtimeStatus: "initializing",
    });
    if (agent.title) {
      const existing = store.getCardIfPresent(agent.id);
      if (existing && !existing.topic) {
        store.updateCard(agent.id, { topic: agent.title });
      }
    }
  });

  const removeTurnBeforeHook = server.addHook("agent.turn.before", async ({ agent }, { paseo }) => {
    if (isHelperAgent(agent)) return;
    await ensureReady(paseo);
    const existing = store.getOrCreateCard({
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      agentTitle: agent.title,
      runtimeStatus: "running",
    });
    const fallbackTitle = agent.title ? provisionalTextFromPrompt(agent.title) : "";
    store.updateCard(agent.id, {
      runtimeStatus: "running",
      ...(!existing.topic && fallbackTitle ? { topic: fallbackTitle } : {}),
    });
  });

  const removeTurnAfterHook = server.addHook(
    "agent.turn.after",
    async ({ agent, turnId, outcome }, { paseo }) => {
      if (isHelperAgent(agent)) return;
      await ensureReady(paseo);
      store.updateCard(agent.id, {
        workspaceId: agent.workspaceId,
        agentTitle: agent.title,
        runtimeStatus: outcome.kind === "failed" ? "error" : "idle",
      });

      await handleTurnCompletedQueueAndTodos({
        store,
        paseo,
        agentId: agent.id,
        turnId,
        outcomeKind: outcome.kind,
      });

      if (outcome.kind === "completed") {
        await evaluateAgentSettledConditions({
          store,
          paseo,
          settledAgentId: agent.id,
          trigger: "turn_completed",
        });
        await summarizer.scheduleForTurn({
          agentId: agent.id,
          turnId,
          paseo,
        });
      }
    },
  );

  const removePermissionBeforeHook = server.addHook(
    "agent.permission.before",
    async ({ agent }, { paseo }) => {
      if (isHelperAgent(agent)) return;
      await ensureReady(paseo);
      const existing = store.getOrCreateCard({
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        agentTitle: agent.title,
      });
      if (existing.workflowStatus === "active") {
        store.updateCard(agent.id, {
          workflowStatus: "waiting_me",
          statusNote: existing.statusNote || "待确认权限请求",
        });
      }
    },
  );

  const removeArchiveHook = server.addHook("agent.archive.after", async ({ agent }, { paseo }) => {
    if (isHelperAgent(agent)) return;
    await ensureReady(paseo);
    store.updateCard(agent.id, {
      archived: true,
      runtimeStatus: "closed",
    });
    await evaluateAgentSettledConditions({
      store,
      paseo,
      settledAgentId: agent.id,
      trigger: "archived",
    });
  });

  return () => {
    removeOpenHook();
    removeCreateHook();
    removeTurnBeforeHook();
    removeTurnAfterHook();
    removePermissionBeforeHook();
    removeArchiveHook();
    summarizer.dispose();
    store.dispose();
  };
}
