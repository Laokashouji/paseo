import { create } from "zustand";

export interface MainChatDrawerTarget {
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  title: string | null;
  taskId?: string | null;
}

export interface OpenMainChatDrawerInput {
  serverId: string;
  agentId: string;
  workspaceId?: string | null;
  title?: string | null;
  taskId?: string | null;
}

interface MainChatDrawerStoreState {
  activeTarget: MainChatDrawerTarget | null;
  lastTarget: MainChatDrawerTarget | null;
  openTask: (input: OpenMainChatDrawerInput) => void;
  closeDrawer: () => void;
  toggleDrawer: (fallbackTarget?: OpenMainChatDrawerInput | null) => void;
  reset: () => void;
}

function normalizeDrawerTarget(input: OpenMainChatDrawerInput): MainChatDrawerTarget | null {
  const serverId = input.serverId.trim();
  const agentId = input.agentId.trim();
  if (!serverId || !agentId) return null;
  const workspaceId = input.workspaceId?.trim() || null;
  const title = input.title?.trim() || null;
  const taskId = input.taskId?.trim() || null;
  return {
    serverId,
    agentId,
    workspaceId,
    title,
    ...(taskId ? { taskId } : {}),
  };
}

export const useMainChatDrawerStore = create<MainChatDrawerStoreState>((set) => ({
  activeTarget: null,
  lastTarget: null,

  openTask(input) {
    const target = normalizeDrawerTarget(input);
    if (!target) return;
    set({
      activeTarget: target,
      lastTarget: target,
    });
  },

  closeDrawer() {
    set((state) => (state.activeTarget === null ? state : { activeTarget: null }));
  },

  toggleDrawer(fallbackTarget) {
    set((state) => {
      if (state.activeTarget !== null) {
        return { activeTarget: null };
      }
      const next =
        state.lastTarget ?? (fallbackTarget ? normalizeDrawerTarget(fallbackTarget) : null);
      if (!next) {
        return state;
      }
      return {
        activeTarget: next,
        lastTarget: next,
      };
    });
  },

  reset() {
    set({ activeTarget: null, lastTarget: null });
  },
}));
