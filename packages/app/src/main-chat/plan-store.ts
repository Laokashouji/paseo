import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MainChatPlanRecord } from "@getpaseo/protocol/main-chat";
import { create } from "zustand";

interface MainChatPlanStoreState {
  plansByKey: Record<string, MainChatPlanRecord>;
  loadedAgents: Record<string, boolean>;
  upsertPlans: (serverId: string, plans: readonly MainChatPlanRecord[]) => void;
  upsertPlan: (serverId: string, plan: MainChatPlanRecord) => void;
  loadPlansForAgent: (serverId: string, mainAgentId: string, client: DaemonClient) => Promise<void>;
  startPlan: (
    serverId: string,
    planId: string,
    client: DaemonClient,
    options?: { taskIds?: string[]; rememberAutoStart?: boolean },
  ) => Promise<MainChatPlanRecord>;
  cancelPlan: (
    serverId: string,
    planId: string,
    client: DaemonClient,
  ) => Promise<MainChatPlanRecord>;
}

export function planStoreKey(serverId: string, planId: string): string {
  return `${serverId}:${planId}`;
}

const inFlightLoads = new Map<string, Promise<void>>();

export const useMainChatPlanStore = create<MainChatPlanStoreState>((set) => ({
  plansByKey: {},
  loadedAgents: {},

  upsertPlans(serverId, plans) {
    if (plans.length === 0) return;
    set((state) => {
      const next = { ...state.plansByKey };
      for (const plan of plans) {
        next[planStoreKey(serverId, plan.id)] = plan;
      }
      return { plansByKey: next };
    });
  },

  upsertPlan(serverId, plan) {
    set((state) => ({
      plansByKey: {
        ...state.plansByKey,
        [planStoreKey(serverId, plan.id)]: plan,
      },
    }));
  },

  async loadPlansForAgent(serverId, mainAgentId, client) {
    const loadKey = `${serverId}:${mainAgentId}`;
    const existing = inFlightLoads.get(loadKey);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const result = await client.listMainChatPlans(mainAgentId);
        if (result.error) return;
        set((state) => {
          const next = { ...state.plansByKey };
          for (const plan of result.plans) {
            next[planStoreKey(serverId, plan.id)] = plan;
          }
          return {
            plansByKey: next,
            loadedAgents: { ...state.loadedAgents, [loadKey]: true },
          };
        });
      } catch {
        // Older daemon or transient disconnect; card falls back to tool output + live child agents.
      } finally {
        inFlightLoads.delete(loadKey);
      }
    })();

    inFlightLoads.set(loadKey, promise);
    return promise;
  },

  async startPlan(serverId, planId, client, options) {
    const result = await client.startMainChatPlan(planId, options);
    if (result.error || !result.plan) {
      throw new Error(result.error ?? "启动计划失败");
    }
    const plan = result.plan;
    set((state) => ({
      plansByKey: {
        ...state.plansByKey,
        [planStoreKey(serverId, plan.id)]: plan,
      },
    }));
    return plan;
  },

  async cancelPlan(serverId, planId, client) {
    const result = await client.cancelMainChatPlan(planId);
    if (result.error || !result.plan) {
      throw new Error(result.error ?? "取消计划失败");
    }
    const plan = result.plan;
    set((state) => ({
      plansByKey: {
        ...state.plansByKey,
        [planStoreKey(serverId, plan.id)]: plan,
      },
    }));
    return plan;
  },
}));
