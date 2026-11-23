import { create } from "zustand";

export interface MainChatCameFromEntry {
  originRoute: string;
  originTitle: string;
  targetServerId: string;
  targetWorkspaceId: string | null;
  targetAgentId: string;
  createdAtMs: number;
}

export interface SetMainChatCameFromInput {
  originRoute: string;
  originTitle: string;
  targetServerId: string;
  targetWorkspaceId?: string | null;
  targetAgentId: string;
  createdAtMs?: number;
}

interface MainChatCameFromStoreState {
  entry: MainChatCameFromEntry | null;
  setCameFrom: (input: SetMainChatCameFromInput) => void;
  clearCameFrom: () => void;
}

export function matchesCameFromTarget(
  entry: MainChatCameFromEntry | null,
  target: {
    serverId: string;
    workspaceId?: string | null;
    agentId?: string | null;
  },
): boolean {
  if (!entry) return false;
  if (entry.targetServerId !== target.serverId) return false;
  if (target.agentId && entry.targetAgentId === target.agentId) return true;
  if (entry.targetWorkspaceId && target.workspaceId) {
    return entry.targetWorkspaceId === target.workspaceId;
  }
  return entry.targetWorkspaceId === null;
}

export const useMainChatCameFromStore = create<MainChatCameFromStoreState>((set) => ({
  entry: null,

  setCameFrom(input) {
    const originRoute = input.originRoute.trim();
    const originTitle = input.originTitle.trim();
    const targetServerId = input.targetServerId.trim();
    const targetAgentId = input.targetAgentId.trim();
    if (!originRoute || !targetServerId || !targetAgentId) return;
    set({
      entry: {
        originRoute,
        originTitle,
        targetServerId,
        targetWorkspaceId: input.targetWorkspaceId?.trim() || null,
        targetAgentId,
        createdAtMs: input.createdAtMs ?? Date.now(),
      },
    });
  },

  clearCameFrom() {
    set((state) => (state.entry === null ? state : { entry: null }));
  },
}));
