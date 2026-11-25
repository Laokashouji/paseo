import type { MainChatOverview } from "@getpaseo/protocol/main-chat";
import {
  agentScopeKey,
  buildMainChatActionBarModel,
  type ActionBarLiveAgentSnapshot,
  type ActionBarPendingPermissionInput,
  type MainChatActionBarModel,
} from "./action-bar-model";

export interface ConversationScopedOverviewResult {
  overview: MainChatOverview | null;
  ownedAgentKeys: Set<string>;
}

/**
 * Filters a Main Chat overview down to only the tasks, plans, decisions, and triages owned by
 * a specific direction/side conversation so leader trays never mix with root Main Chat items.
 */
export function filterOverviewForConversation(
  overview: MainChatOverview | null,
  conversationId: string,
  conversationAgentId: string,
  serverId: string,
  liveAgents: readonly ActionBarLiveAgentSnapshot[] = [],
): ConversationScopedOverviewResult {
  const leader = agentScopeKey(serverId, conversationAgentId);
  const ownedAgentKeys = new Set([leader]);
  for (const agent of liveAgents) {
    if (
      agent.conversationId === conversationId ||
      (agent.parent && agentScopeKey(agent.parent.serverId, agent.parent.agentId) === leader)
    ) {
      ownedAgentKeys.add(agentScopeKey(agent.serverId, agent.agentId));
    }
  }
  if (!overview) {
    return { overview: null, ownedAgentKeys };
  }

  const ownedTasks = (overview.tasks ?? []).filter(
    (task) => task.conversationId === conversationId || task.mainAgentId === conversationAgentId,
  );
  const ownedTaskIds = new Set<string>();
  const ownedPlanIds = new Set<string>();

  for (const task of ownedTasks) {
    ownedTaskIds.add(task.id);
    if (task.planId) ownedPlanIds.add(task.planId);
    for (const id of task.agentIds)
      ownedAgentKeys.add(agentScopeKey(task.serverId ?? serverId, id));
    if (task.activeAgentId)
      ownedAgentKeys.add(agentScopeKey(task.serverId ?? serverId, task.activeAgentId));
  }

  const ownedPlans = overview.plans.filter(
    (plan) =>
      plan.conversationId === conversationId ||
      plan.mainAgentId === conversationAgentId ||
      ownedPlanIds.has(plan.id),
  );
  for (const plan of ownedPlans) {
    for (const plannedTask of plan.tasks) {
      if (plannedTask.agentId)
        ownedAgentKeys.add(agentScopeKey(plannedTask.serverId ?? serverId, plannedTask.agentId));
    }
  }

  const ownedDecisions = overview.decisions.filter(
    (decision) =>
      decision.mainAgentId === conversationAgentId ||
      (decision.planId !== null && ownedPlans.some((plan) => plan.id === decision.planId)) ||
      (decision.taskId !== null && ownedTaskIds.has(decision.taskId)) ||
      (decision.agentId !== null && ownedAgentKeys.has(agentScopeKey(serverId, decision.agentId))),
  );

  const ownedTriages = (overview.triages ?? []).filter((triage) =>
    ownedAgentKeys.has(agentScopeKey(serverId, triage.agentId)),
  );

  return {
    overview: {
      ...overview,
      plans: ownedPlans,
      decisions: ownedDecisions,
      tasks: ownedTasks,
      triages: ownedTriages,
    },
    ownedAgentKeys,
  };
}

export interface BuildConversationActionBarModelInput {
  serverId: string;
  conversationId: string;
  conversationAgentId: string;
  overview: MainChatOverview | null;
  liveAgents: readonly ActionBarLiveAgentSnapshot[];
  pendingPermissions: readonly ActionBarPendingPermissionInput[];
  hostLabelsByServerId?: Readonly<Record<string, string>>;
  nowMs?: number;
}

/**
 * Builds the five-state deduplicated action bar model strictly scoped to one direction/side
 * conversation.
 */
export function buildConversationActionBarModel(
  input: BuildConversationActionBarModelInput,
): MainChatActionBarModel {
  const { overview: scopedOverview, ownedAgentKeys } = filterOverviewForConversation(
    input.overview,
    input.conversationId,
    input.conversationAgentId,
    input.serverId,
    input.liveAgents,
  );

  const leader = agentScopeKey(input.serverId, input.conversationAgentId);
  const scopedLiveAgents = input.liveAgents.filter((agent) => {
    const address = agentScopeKey(agent.serverId, agent.agentId);
    return address !== leader && ownedAgentKeys.has(address);
  });
  const scopedPendingPermissions = input.pendingPermissions.filter((entry) => {
    const address = agentScopeKey(entry.serverId, entry.permission.agentId);
    return ownedAgentKeys.has(address);
  });

  return buildMainChatActionBarModel({
    serverId: input.serverId,
    mainAgentId: input.conversationAgentId,
    overview: scopedOverview,
    liveAgents: scopedLiveAgents,
    pendingPermissions: scopedPendingPermissions,
    hostLabelsByServerId: input.hostLabelsByServerId,
    nowMs: input.nowMs,
  });
}
