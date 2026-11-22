import { create } from "zustand";
import type { FileMentionRange } from "@/utils/file-mention-autocomplete";

export interface MainChatDirectRouteTarget {
  targetServerId: string;
  targetAgentId: string;
  targetTitle: string;
}

interface MainChatRouteStoreState {
  targetsByKey: Record<string, MainChatDirectRouteTarget | undefined>;
  setTarget: (serverId: string, mainAgentId: string, target: MainChatDirectRouteTarget) => void;
  clearTarget: (serverId: string, mainAgentId: string) => void;
}

export function routeStoreKey(serverId: string, mainAgentId: string): string {
  return `${serverId}:${mainAgentId}`;
}

export const useMainChatRouteStore = create<MainChatRouteStoreState>((set) => ({
  targetsByKey: {},

  setTarget(serverId, mainAgentId, target) {
    const key = routeStoreKey(serverId, mainAgentId);
    set((state) => ({
      targetsByKey: {
        ...state.targetsByKey,
        [key]: target,
      },
    }));
  },

  clearTarget(serverId, mainAgentId) {
    const key = routeStoreKey(serverId, mainAgentId);
    set((state) => {
      if (!(key in state.targetsByKey)) return state;
      const next = { ...state.targetsByKey };
      delete next[key];
      return { targetsByKey: next };
    });
  },
}));

/**
 * Removes the active `@query` mention span after selecting a child task from autocomplete,
 * keeping surrounding text tidy without leaving awkward double spaces.
 */
export function removeTaskMentionToken(text: string, mention: FileMentionRange): string {
  const before = text.slice(0, mention.start);
  const after = text.slice(mention.end);
  if (before.length === 0) {
    return after.replace(/^\s+/, "");
  }
  if (/\s$/.test(before) && /^\s/.test(after)) {
    return `${before}${after.replace(/^\s+/, "")}`;
  }
  return `${before}${after}`;
}
