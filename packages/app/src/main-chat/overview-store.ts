import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MainChatCompactionReason,
  MainChatCompactionState,
  MainChatDecisionRecord,
  MainChatOverview,
  MainChatPlanRecord,
  MainChatReceiptCheck,
  MainChatRetryTaskWithFallbackResponsePayload,
  MainChatReviewTaskResponsePayload,
  MainChatRuleKind,
  MainChatSettingsProposalRecord,
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
  settingsProposalsByKey: Record<string, MainChatSettingsProposalRecord | undefined>;
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
  resolveSettingsProposal: (
    serverId: string,
    mainAgentId: string,
    input: { proposalId: string; decision: "approve" | "reject"; note?: string },
    client: DaemonClient,
  ) => Promise<MainChatSettingsProposalRecord>;
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
      bypassDeliveryGate?: boolean;
      bypassReason?: string;
    },
    client: DaemonClient,
  ) => Promise<MainChatReviewTaskResponsePayload>;
  startReadyTask: (
    serverId: string,
    mainAgentId: string,
    taskId: string,
    client: DaemonClient,
  ) => Promise<MainChatTaskRecord>;
  updateTaskDependencies: (
    serverId: string,
    mainAgentId: string,
    input: {
      taskId: string;
      partOf?: string | null;
      after?: string[];
      autoStartOnReady?: boolean;
    },
    client: DaemonClient,
  ) => Promise<MainChatTaskRecord>;
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
  retryTaskWithFallback: (
    serverId: string,
    mainAgentId: string,
    input: {
      taskId: string;
      targetProvider?: string;
      targetModel?: string | null;
      thinkingOptionId?: string | null;
      reason?: string;
    },
    client: DaemonClient,
  ) => Promise<MainChatRetryTaskWithFallbackResponsePayload>;
}

export function overviewStoreKey(serverId: string, mainAgentId: string): string {
  return `${serverId}:${mainAgentId}`;
}

export function decisionStoreKey(serverId: string, decisionId: string): string {
  return `${serverId}:${decisionId}`;
}

export function settingsProposalStoreKey(serverId: string, proposalId: string): string {
  return `${serverId}:${proposalId}`;
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

function indexSettingsProposals(
  serverId: string,
  proposals: readonly MainChatSettingsProposalRecord[] | undefined,
): Record<string, MainChatSettingsProposalRecord> {
  const map: Record<string, MainChatSettingsProposalRecord> = {};
  for (const proposal of proposals ?? []) {
    map[settingsProposalStoreKey(serverId, proposal.id)] = proposal;
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
  settingsProposalsByKey: {},
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
        .hydrateSettings(
          serverId,
          overview.settings,
          overview.nightModeStatus,
          overview.cacheKeepaliveStatus,
        );
    }
    if (
      overview.nightModeStatus ||
      overview.cacheKeepaliveStatus ||
      overview.tokenUsage ||
      overview.notificationSummary
    ) {
      useMainChatSettingsStore.getState().hydrateTelemetry(serverId, {
        nightModeStatus: overview.nightModeStatus,
        cacheKeepaliveStatus: overview.cacheKeepaliveStatus,
        tokenUsage: overview.tokenUsage,
        notificationSummary: overview.notificationSummary,
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
      settingsProposalsByKey: {
        ...state.settingsProposalsByKey,
        ...indexSettingsProposals(serverId, overview.settingsProposals),
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

  async resolveSettingsProposal(serverId, mainAgentId, input, client) {
    const response = await client.resolveMainChatSettingsProposal(input);
    if (response.error || !response.proposal) {
      throw new Error(response.error ?? "Failed to resolve settings proposal");
    }
    const updated = response.proposal;
    if (response.settings) {
      useMainChatSettingsStore
        .getState()
        .hydrateSettings(
          serverId,
          response.settings,
          response.nightModeStatus,
          response.cacheKeepaliveStatus,
        );
    }
    const key = overviewStoreKey(serverId, mainAgentId);
    set((state) => {
      const existingOverview = state.overviewsByKey[key];
      const existingProposals = existingOverview?.settingsProposals;
      let nextProposals: MainChatSettingsProposalRecord[];
      if (!existingProposals) {
        nextProposals = [updated];
      } else if (existingProposals.some((item) => item.id === updated.id)) {
        nextProposals = existingProposals.map((item) => (item.id === updated.id ? updated : item));
      } else {
        nextProposals = [updated, ...existingProposals];
      }
      const nextOverview = existingOverview
        ? {
            ...existingOverview,
            settingsProposals: nextProposals,
            ...(response.settings ? { settings: response.settings } : {}),
            ...(response.nightModeStatus ? { nightModeStatus: response.nightModeStatus } : {}),
            ...(response.cacheKeepaliveStatus
              ? { cacheKeepaliveStatus: response.cacheKeepaliveStatus }
              : {}),
          }
        : existingOverview;
      return {
        settingsProposalsByKey: {
          ...state.settingsProposalsByKey,
          [settingsProposalStoreKey(serverId, updated.id)]: updated,
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

  async startReadyTask(serverId, mainAgentId, taskId, client) {
    const response = await client.startMainChatReadyTask(taskId);
    if (response.error || !response.task) {
      throw new Error(response.error ?? "Failed to start ready task");
    }
    const updatedTask = response.task;
    const updatedPlan = response.plan;
    const key = overviewStoreKey(serverId, mainAgentId);
    set((state) => {
      const existingOverview = state.overviewsByKey[key];
      if (!existingOverview) return state;
      return {
        overviewsByKey: {
          ...state.overviewsByKey,
          [key]: {
            ...existingOverview,
            tasks: replaceTaskInList(existingOverview.tasks, updatedTask),
            ...(updatedPlan
              ? { plans: replacePlanInList(existingOverview.plans, updatedPlan) }
              : {}),
          },
        },
      };
    });
    if (updatedPlan) {
      useMainChatPlanStore.getState().upsertPlan(serverId, updatedPlan);
    }
    return updatedTask;
  },

  async updateTaskDependencies(serverId, mainAgentId, input, client) {
    const response = await client.updateMainChatTaskDependencies(input);
    if (response.error || !response.task) {
      throw new Error(response.error ?? "Failed to update task dependencies");
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

  async retryTaskWithFallback(serverId, mainAgentId, input, client) {
    const response = await client.retryMainChatTaskWithFallback(input);
    if (response.error || !response.task) {
      throw new Error(response.error ?? "Failed to retry task with fallback model");
    }
    const updatedTask = response.task;
    const key = overviewStoreKey(serverId, mainAgentId);
    set((state) => {
      const existingOverview = state.overviewsByKey[key];
      if (!existingOverview) return state;
      return {
        overviewsByKey: {
          ...state.overviewsByKey,
          [key]: {
            ...existingOverview,
            tasks: replaceTaskInList(existingOverview.tasks, updatedTask),
          },
        },
      };
    });
    return response;
  },
}));
