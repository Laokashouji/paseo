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
  activeStewardServerId: string | null;
  lastTargetByStewardServerId: Record<string, MainChatDrawerTarget | undefined>;
  openTask: (input: OpenMainChatDrawerInput) => void;
  closeDrawer: () => void;
  toggleDrawer: (fallbackTarget?: OpenMainChatDrawerInput | null) => void;
  setActiveStewardContext: (
    stewardServerId: string | null,
    allowedServerIds?: ReadonlySet<string> | null,
  ) => void;
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
  activeStewardServerId: null,
  lastTargetByStewardServerId: {},

  openTask(input) {
    const target = normalizeDrawerTarget(input);
    if (!target) return;
    set((state) => ({
      activeTarget: target,
      lastTarget: target,
      ...(state.activeStewardServerId
        ? {
            lastTargetByStewardServerId: {
              ...state.lastTargetByStewardServerId,
              [state.activeStewardServerId]: target,
            },
          }
        : {}),
    }));
  },

  closeDrawer() {
    set((state) => (state.activeTarget === null ? state : { activeTarget: null }));
  },

  toggleDrawer(fallbackTarget) {
    set((state) => {
      if (state.activeTarget !== null) {
        return { activeTarget: null };
      }
      const stewardLast = state.activeStewardServerId
        ? state.lastTargetByStewardServerId[state.activeStewardServerId]
        : null;
      const next =
        stewardLast ??
        state.lastTarget ??
        (fallbackTarget ? normalizeDrawerTarget(fallbackTarget) : null);
      if (!next) {
        return state;
      }
      return {
        activeTarget: next,
        lastTarget: next,
      };
    });
  },

  setActiveStewardContext(stewardServerId, allowedServerIds) {
    const normalized = stewardServerId?.trim() || null;
    set((state) => {
      if (state.activeStewardServerId === normalized) {
        if (
          state.activeTarget &&
          allowedServerIds &&
          allowedServerIds.size > 0 &&
          !allowedServerIds.has(state.activeTarget.serverId)
        ) {
          return { activeTarget: null };
        }
        return state;
      }
      const shouldCloseActive =
        state.activeTarget !== null &&
        (!allowedServerIds ||
          allowedServerIds.size === 0 ||
          !allowedServerIds.has(state.activeTarget.serverId));
      const nextLast = normalized ? (state.lastTargetByStewardServerId[normalized] ?? null) : null;
      return {
        activeStewardServerId: normalized,
        activeTarget: shouldCloseActive ? null : state.activeTarget,
        lastTarget: nextLast,
      };
    });
  },

  reset() {
    set({
      activeTarget: null,
      lastTarget: null,
      activeStewardServerId: null,
      lastTargetByStewardServerId: {},
    });
  },
}));
