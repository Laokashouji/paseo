import type { Agent } from "@/stores/session-store";

export type CloseAgentTabPolicy = { kind: "archive-on-close" } | { kind: "layout-only" };

export function resolveCloseAgentTabPolicy(
  agent: (Pick<Agent, "parentAgentId"> & { labels?: Agent["labels"] }) | null | undefined,
): CloseAgentTabPolicy {
  if (agent?.parentAgentId || agent?.labels?.["paseo.role"] === "main") {
    return { kind: "layout-only" };
  }

  return { kind: "archive-on-close" };
}
