import { create } from "zustand";

export type MainChatQueuePriority = "normal" | "high";

export interface MainChatQueuedMessage {
  id: string;
  text: string;
  priority: MainChatQueuePriority;
  createdAt: string;
  updatedAt: string;
}

export interface EnqueueMainChatMessageOptions {
  id?: string;
  priority?: MainChatQueuePriority;
  prepend?: boolean;
  now?: string;
}

interface MainChatQueueStoreState {
  queuesByAgentId: Record<string, MainChatQueuedMessage[] | undefined>;
  enqueue: (
    agentId: string,
    text: string,
    options?: EnqueueMainChatMessageOptions,
  ) => MainChatQueuedMessage | null;
  editItem: (agentId: string, itemId: string, nextText: string) => boolean;
  moveToFront: (agentId: string, itemId: string) => boolean;
  removeItem: (agentId: string, itemId: string) => boolean;
  shiftNext: (agentId: string) => MainChatQueuedMessage | null;
  clearQueue: (agentId: string) => void;
}

export const EMPTY_MAIN_CHAT_QUEUE: readonly MainChatQueuedMessage[] = [];

let queueSequence = 0;

function generateQueueItemId(): string {
  queueSequence += 1;
  return `mc_queue_${Date.now()}_${queueSequence}`;
}

function insertQueuedItem(
  existing: readonly MainChatQueuedMessage[],
  item: MainChatQueuedMessage,
  prepend: boolean,
): MainChatQueuedMessage[] {
  if (prepend) {
    return [item, ...existing];
  }
  if (item.priority === "high") {
    const firstNormalIndex = existing.findIndex((entry) => entry.priority !== "high");
    if (firstNormalIndex === -1) {
      return [...existing, item];
    }
    return [...existing.slice(0, firstNormalIndex), item, ...existing.slice(firstNormalIndex)];
  }
  return [...existing, item];
}

function omitAgentQueue(
  queuesByAgentId: Record<string, MainChatQueuedMessage[] | undefined>,
  agentId: string,
): Record<string, MainChatQueuedMessage[] | undefined> {
  if (!(agentId in queuesByAgentId)) {
    return queuesByAgentId;
  }
  const next = { ...queuesByAgentId };
  delete next[agentId];
  return next;
}

export const useMainChatQueueStore = create<MainChatQueueStoreState>((set, get) => ({
  queuesByAgentId: {},

  enqueue(agentId, text, options) {
    const trimmedAgentId = agentId.trim();
    const trimmedText = text.trim();
    if (!trimmedAgentId || !trimmedText) {
      return null;
    }

    const timestamp = options?.now ?? new Date().toISOString();
    const item: MainChatQueuedMessage = {
      id: options?.id ?? generateQueueItemId(),
      text: trimmedText,
      priority: options?.priority ?? "normal",
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    set((state) => {
      const existing = state.queuesByAgentId[trimmedAgentId] ?? [];
      const nextQueue = insertQueuedItem(existing, item, Boolean(options?.prepend));
      return {
        queuesByAgentId: {
          ...state.queuesByAgentId,
          [trimmedAgentId]: nextQueue,
        },
      };
    });

    return item;
  },

  editItem(agentId, itemId, nextText) {
    const trimmedText = nextText.trim();
    if (!trimmedText) {
      return false;
    }

    const current = get().queuesByAgentId[agentId];
    if (!current || !current.some((item) => item.id === itemId)) {
      return false;
    }

    const timestamp = new Date().toISOString();
    set((state) => {
      const existing = state.queuesByAgentId[agentId];
      if (!existing) return state;
      const idx = existing.findIndex((item) => item.id === itemId);
      if (idx === -1) return state;
      const target = existing[idx];
      if (!target) return state;
      const nextQueue = existing.slice();
      nextQueue[idx] = { ...target, text: trimmedText, updatedAt: timestamp };
      return {
        queuesByAgentId: {
          ...state.queuesByAgentId,
          [agentId]: nextQueue,
        },
      };
    });

    return true;
  },

  moveToFront(agentId, itemId) {
    const current = get().queuesByAgentId[agentId];
    if (!current) {
      return false;
    }
    const targetIndex = current.findIndex((item) => item.id === itemId);
    if (targetIndex === -1) {
      return false;
    }

    const timestamp = new Date().toISOString();
    set((state) => {
      const existing = state.queuesByAgentId[agentId];
      if (!existing) return state;
      const idx = existing.findIndex((item) => item.id === itemId);
      if (idx === -1) return state;
      const promoted: MainChatQueuedMessage = {
        ...existing[idx],
        priority: "high",
        updatedAt: timestamp,
      };
      const rest = existing.filter((item) => item.id !== itemId);
      return {
        queuesByAgentId: {
          ...state.queuesByAgentId,
          [agentId]: [promoted, ...rest],
        },
      };
    });

    return true;
  },

  removeItem(agentId, itemId) {
    const current = get().queuesByAgentId[agentId];
    if (!current || !current.some((item) => item.id === itemId)) {
      return false;
    }

    set((state) => {
      const existing = state.queuesByAgentId[agentId];
      if (!existing) return state;
      const remaining = existing.filter((item) => item.id !== itemId);
      if (remaining.length === 0) {
        return {
          queuesByAgentId: omitAgentQueue(state.queuesByAgentId, agentId),
        };
      }
      return {
        queuesByAgentId: {
          ...state.queuesByAgentId,
          [agentId]: remaining,
        },
      };
    });

    return true;
  },

  shiftNext(agentId) {
    const current = get().queuesByAgentId[agentId];
    if (!current || current.length === 0) {
      return null;
    }
    const head = current[0];
    set((state) => {
      const existing = state.queuesByAgentId[agentId];
      if (!existing || existing.length === 0) return state;
      const rest = existing.slice(1);
      if (rest.length === 0) {
        return {
          queuesByAgentId: omitAgentQueue(state.queuesByAgentId, agentId),
        };
      }
      return {
        queuesByAgentId: {
          ...state.queuesByAgentId,
          [agentId]: rest,
        },
      };
    });
    return head;
  },

  clearQueue(agentId) {
    set((state) => {
      const nextQueues = omitAgentQueue(state.queuesByAgentId, agentId);
      return nextQueues === state.queuesByAgentId ? state : { queuesByAgentId: nextQueues };
    });
  },
}));
