import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MainChatCompactionReason,
  MainChatCompactionState,
  MainChatDecisionRecord,
  MainChatOverview,
  MainChatPlanRecord,
  MainChatReceiptCheck,
  MainChatReviewTaskResponsePayload,
  MainChatRuleKind,
  MainChatTaskRecord,
  MainChatTaskReviewVerdict,
} from "@getpaseo/protocol/main-chat";
import { create } from "zustand";
import { useMainChatPlanStore } from "./plan-store";
import { useMainChatSettingsStore } from "./settings-store";

export interface MainChatActiveAgentOverride {
  serverId: string;
  agentId: string;
  workspaceId: string;
  previousAgentId: string | null;
}

interface MainChatOverviewStoreState {
  overviewsByKey: Record<string, MainChatOverview | undefined>;
  decisionsByKey: Record<string, MainChatDecisionRecord | undefined>;
  activeAgentOverrideByServerId: Record<string, MainChatActiveAgentOverride | undefined>;
  setActiveAgentOverride: (serverId: string, override: MainChatActiveAgentOverride) => void;
  clearActiveAgentOverride: (serverId: string) => void;
  upsertPlanInOverview: (serverId: string, mainAgentId: string, plan: MainChatPlanRecord) => void;
  loadOverview: (
    serverId: string,
    mainAgentId: string,
    client: DaemonClient,
  ) => Promise<MainChatOverview | null>;
  compactMainChat: (
    serverId: string,
    mainAgentId: string,
    client: DaemonClient,
    options?: { reason?: MainChatCompactionReason; instructions?: string },
  ) => Promise<MainChatCompactionState | null>;
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
  parkTask: (
    serverId: string,
    mainAgentId: string,
    input: { taskId: string; parked: boolean; reason?: string },
    client: DaemonClient,
  ) => Promise<MainChatTaskRecord>;
  reviewTask: (
    serverId: string,
    mainAgentId: string,
    input: {
      taskId: string;
      verdict: MainChatTaskReviewVerdict;
      summary?: string;
      gaps?: string[];
      checks?: MainChatReceiptCheck[];
      nextSteps?: string[];
      note?: string;
    },
    client: DaemonClient,
  ) => Promise<MainChatReviewTaskResponsePayload>;
  updateTaskScope: (
    serverId: string,
    mainAgentId: string,
    input: {
      taskId: string;
      goal?: string;
      doneWhen?: string[];
      outOfBounds?: string[];
      reason?: string;
    },
    client: DaemonClient,
  ) => Promise<MainChatTaskRecord>;
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

function replaceTaskInList(
  tasks: readonly MainChatTaskRecord[] | undefined,
  updated: MainChatTaskRecord,
): MainChatTaskRecord[] {
  if (!tasks || tasks.length === 0) return [updated];
  const exists = tasks.some((item) => item.id === updated.id);
  if (!exists) return [updated, ...tasks];
  return tasks.map((item) => (item.id === updated.id ? updated : item));
}

function replacePlanInList(
  plans: readonly MainChatPlanRecord[],
  updated: MainChatPlanRecord,
): MainChatPlanRecord[] {
  const exists = plans.some((item) => item.id === updated.id);
  if (!exists) return [updated, ...plans];
  return plans.map((item) => (item.id === updated.id ? updated : item));
}

export const useMainChatOverviewStore = create<MainChatOverviewStoreState>((set) => ({
  overviewsByKey: {},
  decisionsByKey: {},
  activeAgentOverrideByServerId: {},

  setActiveAgentOverride(serverId, override) {
    set((state) => ({
      activeAgentOverrideByServerId: {
        ...state.activeAgentOverrideByServerId,
        [serverId]: override,
      },
    }));
  },

  clearActiveAgentOverride(serverId) {
    set((state) => {
      if (!state.activeAgentOverrideByServerId[serverId]) return state;
      const next = { ...state.activeAgentOverrideByServerId };
      delete next[serverId];
      return { activeAgentOverrideByServerId: next };
    });
  },

  upsertPlanInOverview(serverId, mainAgentId, plan) {
    const key = overviewStoreKey(serverId, mainAgentId);
    set((state) => {
      const existing = state.overviewsByKey[key];
      if (!existing) return state;
      return {
        overviewsByKey: {
          ...state.overviewsByKey,
          [key]: {
            ...existing,
            plans: replacePlanInList(existing.plans, plan),
          },
        },
      };
    });
  },

  async loadOverview(serverId, mainAgentId, client) {
    const response = await client.getMainChatOverview(mainAgentId);
    if (response.error || !response.overview) {
      return null;
    }
    const overview = response.overview;
    if (overview.settings) {
      useMainChatSettingsStore
        .getState()
        .hydrateSettings(serverId, overview.settings, overview.nightModeStatus);
    }
    if (overview.nightModeStatus || overview.tokenUsage) {
      useMainChatSettingsStore.getState().hydrateTelemetry(serverId, {
        nightModeStatus: overview.nightModeStatus,
        tokenUsage: overview.tokenUsage,
      });
    }
    if (overview.plans.length > 0) {
      useMainChatPlanStore.getState().upsertPlans(serverId, overview.plans);
    }
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

  async compactMainChat(serverId, mainAgentId, client, options) {
    const key = overviewStoreKey(serverId, mainAgentId);
    set((state) => {
      const existing = state.overviewsByKey[key];
      if (!existing?.compaction) return state;
      return {
        overviewsByKey: {
          ...state.overviewsByKey,
          [key]: {
            ...existing,
            compaction: {
              ...existing.compaction,
              status: "running",
              lastError: null,
            },
          },
        },
      };
    });

    const response = await client.compactMainChat({
      mainAgentId,
      reason: options?.reason ?? "manual",
      ...(options?.instructions ? { instructions: options.instructions } : {}),
    });

    if (response.compaction) {
      const nextCompaction = response.compaction;
      set((state) => {
        const existing = state.overviewsByKey[key];
        if (!existing) return state;
        return {
          overviewsByKey: {
            ...state.overviewsByKey,
            [key]: {
              ...existing,
              compaction: nextCompaction,
            },
          },
        };
      });
    }

    if (response.error) {
      throw new Error(response.error);
    }

    return response.compaction;
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

  async parkTask(serverId, mainAgentId, input, client) {
    const response = await client.parkMainChatTask(input);
    if (response.error || !response.task) {
      throw new Error(response.error ?? "Failed to update task parked state");
    }
    const updated = response.task;
    const key = overviewStoreKey(serverId, mainAgentId);
    set((state) => {
      const existingOverview = state.overviewsByKey[key];
      if (!existingOverview) return state;
      return {
        overviewsByKey: {
          ...state.overviewsByKey,
          [key]: {
            ...existingOverview,
            tasks: replaceTaskInList(existingOverview.tasks, updated),
          },
        },
      };
    });
    return updated;
  },

  async reviewTask(serverId, mainAgentId, input, client) {
    const response = await client.reviewMainChatTask(input);
    if (response.error) {
      throw new Error(response.error);
    }
    const key = overviewStoreKey(serverId, mainAgentId);
    set((state) => {
      const existingOverview = state.overviewsByKey[key];
      if (!existingOverview) return state;
      return {
        overviewsByKey: {
          ...state.overviewsByKey,
          [key]: {
            ...existingOverview,
            ...(response.task
              ? { tasks: replaceTaskInList(existingOverview.tasks, response.task) }
              : {}),
            ...(response.receipt
              ? {
                  recentReceipts: [response.receipt, ...(existingOverview.recentReceipts ?? [])],
                }
              : {}),
          },
        },
      };
    });
    return response;
  },

  async updateTaskScope(serverId, mainAgentId, input, client) {
    const response = await client.updateMainChatTaskScope(input);
    if (response.error || !response.task) {
      throw new Error(response.error ?? "Failed to update task scope");
    }
    const updated = response.task;
    const key = overviewStoreKey(serverId, mainAgentId);
    set((state) => {
      const existingOverview = state.overviewsByKey[key];
      if (!existingOverview) return state;
      return {
        overviewsByKey: {
          ...state.overviewsByKey,
          [key]: {
            ...existingOverview,
            tasks: replaceTaskInList(existingOverview.tasks, updated),
          },
        },
      };
    });
    return updated;
  },
}));
