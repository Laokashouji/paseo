import type { PluginClientContext } from "@getpaseo/plugin/client";
import { sessionArchiveCompletedSubscription } from "./shared/contracts.js";

export default function contribute(client: PluginClientContext) {
  if (typeof client.subscribe !== "function") {
    return () => {};
  }

  const subscription = client.subscribe(sessionArchiveCompletedSubscription, {}, (event) => {
    client.closeAgentTab?.({
      agentId: event.agentId,
      workspaceId: event.workspaceId,
    });
  });
  void subscription.ready?.catch(() => {});

  return () => {
    subscription();
  };
}
