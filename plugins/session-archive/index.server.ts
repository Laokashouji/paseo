import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  getSessionArchiveStateRpc,
  sessionArchiveCompletedSubscription,
  triggerSessionArchiveRpc,
  watchSessionArchiveStateSubscription,
} from "./shared/contracts.js";
import { ARCHIVE_FINISH_TOOL_PROMPT, SessionArchiveManager } from "./server/manager.js";

export default function contribute(server: PluginServerContext) {
  const manager = new SessionArchiveManager();
  const finishTool = manager.createFinishArchiveTool();

  server.handle(triggerSessionArchiveRpc, async (input, { paseo }) => {
    return manager.trigger(input, paseo);
  });

  server.handle(getSessionArchiveStateRpc, (input) => {
    return { state: manager.getState(input.agentId) };
  });

  // Subscriptions must return void synchronously so the stream stays open.
  server.handle(watchSessionArchiveStateSubscription, (input, context) => {
    void context
      .push({ agentId: input.agentId, state: manager.getState(input.agentId) })
      .catch(() => {});
    const unsubscribe = manager.subscribeState(input.agentId, (state) => {
      if (context.signal.aborted) return;
      void context.push({ agentId: input.agentId, state }).catch(() => {});
    });
    context.signal.addEventListener("abort", unsubscribe, { once: true });
  });

  server.handle(sessionArchiveCompletedSubscription, (_input, context) => {
    const unsubscribe = manager.subscribeCompleted((event) => {
      if (context.signal.aborted) return;
      void context.push(event).catch(() => {});
    });
    context.signal.addEventListener("abort", unsubscribe, { once: true });
  });

  const removeOpenHook = server.addHook("agent.open.before", async ({ request }) => {
    if (request.purpose !== "interactive" || request.background) return undefined;
    const hasTool = request.tools.some((tool) => tool.name === finishTool.name);
    return {
      ...request,
      tools: hasTool ? request.tools : [...request.tools, finishTool],
      appendSystemPrompt: [...(request.appendSystemPrompt ?? []), ARCHIVE_FINISH_TOOL_PROMPT],
    };
  });

  const removeTurnAfterHook = server.addHook(
    "agent.turn.after",
    async ({ agent, outcome }, { paseo }) => {
      if (agent.background) return;
      await manager.onTurnAfter(
        {
          agentId: agent.id,
          workspaceId: agent.workspaceId ?? null,
          outcomeKind: outcome.kind,
        },
        paseo,
      );
    },
  );

  const removeArchiveAfterHook = server.addHook("agent.archive.after", async ({ agent }) => {
    if (agent.background) return;
    manager.onArchiveAfter(agent.id);
  });

  return () => {
    removeOpenHook();
    removeTurnAfterHook();
    removeArchiveAfterHook();
    manager.dispose();
  };
}
