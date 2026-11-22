import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MainChatDecisionRecord,
  MainChatOverview,
  MainChatRuleKind,
} from "@getpaseo/protocol/main-chat";
import { create } from "zustand";

interface MainChatOverviewStoreState {
  overviewsByKey: Record<string, MainChatOverview | undefined>;
  decisionsByKey: Record<string, MainChatDecisionRecord | undefined>;
  loadOverview: (
    serverId: string,
    mainAgentId: string,
    client: DaemonClient,
  ) => Promise<MainChatOverview | null>;
  answerDecision: (
    serverId: string,
    mainAgentId: string,
    input: { decisionId: string; optionId?: string; answer: string },
    client: DaemonClient,
  ) => Promise<MainChatDecisionRecord>;
  addPermissionRule: (
    serverId: string,
    mainAgentId: string,
    input: { toolName: string; commandPrefix?: string | null; cwd?: string | null },
    client: DaemonClient,
  ) => Promise<void>;
  removeRule: (
    serverId: string,
    mainAgentId: string,
    kind: MainChatRuleKind,
    ruleId: string,
    client: DaemonClient,
  ) => Promise<boolean>;
}

export function overviewStoreKey(serverId: string, mainAgentId: string): string {
  return `${serverId}:${mainAgentId}`;
}

export function decisionStoreKey(serverId: string, decisionId: string): string {
  return `${serverId}:${decisionId}`;
}

function indexDecisions(
  serverId: string,
  decisions: readonly MainChatDecisionRecord[],
): Record<string, MainChatDecisionRecord> {
  const map: Record<string, MainChatDecisionRecord> = {};
  for (const decision of decisions) {
    map[decisionStoreKey(serverId, decision.id)] = decision;
  }
  return map;
}

export const useMainChatOverviewStore = create<MainChatOverviewStoreState>((set) => ({
  overviewsByKey: {},
  decisionsByKey: {},

  async loadOverview(serverId, mainAgentId, client) {
    const response = await client.getMainChatOverview(mainAgentId);
    if (response.error || !response.overview) {
      return null;
    }
    const overview = response.overview;
    set((state) => ({
      overviewsByKey: {
        ...state.overviewsByKey,
        [overviewStoreKey(serverId, mainAgentId)]: overview,
      },
      decisionsByKey: {
        ...state.decisionsByKey,
        ...indexDecisions(serverId, overview.decisions),
      },
    }));
    return overview;
  },

  async answerDecision(serverId, mainAgentId, input, client) {
    const response = await client.answerMainChatDecision(input);
    if (response.error || !response.decision) {
      throw new Error(response.error ?? "Failed to record decision");
    }
    const updated = response.decision;
    const key = overviewStoreKey(serverId, mainAgentId);
    set((state) => {
      const existingOverview = state.overviewsByKey[key];
      const nextOverview = existingOverview
        ? {
            ...existingOverview,
            decisions: existingOverview.decisions.map((item) =>
              item.id === updated.id ? updated : item,
            ),
          }
        : existingOverview;
      return {
        decisionsByKey: {
          ...state.decisionsByKey,
          [decisionStoreKey(serverId, updated.id)]: updated,
        },
        ...(nextOverview
          ? {
              overviewsByKey: {
                ...state.overviewsByKey,
                [key]: nextOverview,
              },
            }
          : {}),
      };
    });
    return updated;
  },

  async addPermissionRule(serverId, mainAgentId, input, client) {
    const response = await client.addMainChatPermissionRule(input);
    if (response.error || !response.rule) {
      throw new Error(response.error ?? "Failed to save permission rule");
    }
    const rule = response.rule;
    const key = overviewStoreKey(serverId, mainAgentId);
    set((state) => {
      const existingOverview = state.overviewsByKey[key];
      if (!existingOverview) return state;
      const exists = existingOverview.permissionRules.some((item) => item.id === rule.id);
      if (exists) return state;
      return {
        overviewsByKey: {
          ...state.overviewsByKey,
          [key]: {
            ...existingOverview,
            permissionRules: [...existingOverview.permissionRules, rule],
          },
        },
      };
    });
  },

  async removeRule(serverId, mainAgentId, kind, ruleId, client) {
    const response = await client.removeMainChatRule(kind, ruleId);
    if (response.error) {
      throw new Error(response.error);
    }
    if (!response.removed) return false;
    const key = overviewStoreKey(serverId, mainAgentId);
    set((state) => {
      const existingOverview = state.overviewsByKey[key];
      if (!existingOverview) return state;
      return {
        overviewsByKey: {
          ...state.overviewsByKey,
          [key]: {
            ...existingOverview,
            autoStartRules:
              kind === "auto_start"
                ? existingOverview.autoStartRules.filter((rule) => rule.id !== ruleId)
                : existingOverview.autoStartRules,
            permissionRules:
              kind === "permission"
                ? existingOverview.permissionRules.filter((rule) => rule.id !== ruleId)
                : existingOverview.permissionRules,
          },
        },
      };
    });
    return true;
  },
}));
