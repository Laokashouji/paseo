import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create } from "zustand";
import { toErrorMessage } from "@/utils/error-messages";

export interface SideQuestionTurnEntry {
  id: string;
  question: string;
  response: string | null;
  status: "pending" | "done" | "error";
  error: string | null;
  model: string | null;
  createdAt: number;
}

export interface SideQuestionThreadState {
  turns: SideQuestionTurnEntry[];
  isOpen: boolean;
}

interface SideQuestionStoreState {
  threads: Record<string, SideQuestionThreadState>;
  askQuestion: (input: {
    serverId: string;
    agentId: string;
    question: string;
    client: Pick<DaemonClient, "askAgentSideQuestion"> | null;
    disconnectedMessage: string;
  }) => Promise<void>;
  retryTurn: (input: {
    serverId: string;
    agentId: string;
    turnId: string;
    client: Pick<DaemonClient, "askAgentSideQuestion"> | null;
    disconnectedMessage: string;
  }) => Promise<void>;
  minimize: (serverId: string, agentId: string) => void;
  reopen: (serverId: string, agentId: string) => void;
  dismiss: (serverId: string, agentId: string) => void;
}

let nextTurnSequence = 0;

export function buildSideQuestionThreadKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

function collectCompletedHistory(
  turns: readonly SideQuestionTurnEntry[],
  stopBeforeId?: string,
): Array<{ question: string; response: string }> {
  const history: Array<{ question: string; response: string }> = [];
  for (const turn of turns) {
    if (stopBeforeId && turn.id === stopBeforeId) {
      break;
    }
    if (turn.status === "done" && turn.response !== null) {
      history.push({ question: turn.question, response: turn.response });
    }
  }
  return history;
}

export const useSideQuestionStore = create<SideQuestionStoreState>((set, get) => ({
  threads: {},

  askQuestion: async ({ serverId, agentId, question, client, disconnectedMessage }) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    const key = buildSideQuestionThreadKey(serverId, agentId);
    const existing = get().threads[key];
    const history = existing ? collectCompletedHistory(existing.turns) : [];
    const turnId = `btw-${Date.now()}-${++nextTurnSequence}`;

    const pendingEntry: SideQuestionTurnEntry = {
      id: turnId,
      question: trimmed,
      response: null,
      status: client ? "pending" : "error",
      error: client ? null : disconnectedMessage,
      model: null,
      createdAt: Date.now(),
    };

    set((state) => ({
      threads: {
        ...state.threads,
        [key]: {
          isOpen: true,
          turns: [...(state.threads[key]?.turns ?? []), pendingEntry],
        },
      },
    }));

    if (!client) {
      return;
    }

    try {
      const result = await client.askAgentSideQuestion(agentId, trimmed, {
        ...(history.length > 0 ? { history } : {}),
      });
      set((state) => {
        const thread = state.threads[key];
        if (!thread) return state;
        return {
          threads: {
            ...state.threads,
            [key]: {
              ...thread,
              turns: thread.turns.map((turn) =>
                turn.id === turnId
                  ? {
                      ...turn,
                      response: result.response,
                      model: result.model ?? null,
                      status: "done",
                      error: null,
                    }
                  : turn,
              ),
            },
          },
        };
      });
    } catch (error) {
      const message = toErrorMessage(error) || "Failed to ask side question";
      set((state) => {
        const thread = state.threads[key];
        if (!thread) return state;
        return {
          threads: {
            ...state.threads,
            [key]: {
              ...thread,
              turns: thread.turns.map((turn) =>
                turn.id === turnId
                  ? {
                      ...turn,
                      status: "error",
                      error: message,
                    }
                  : turn,
              ),
            },
          },
        };
      });
    }
  },

  retryTurn: async ({ serverId, agentId, turnId, client, disconnectedMessage }) => {
    const key = buildSideQuestionThreadKey(serverId, agentId);
    const thread = get().threads[key];
    const target = thread?.turns.find((turn) => turn.id === turnId);
    if (!thread || !target) return;

    const history = collectCompletedHistory(thread.turns, turnId);
    set((state) => {
      const current = state.threads[key];
      if (!current) return state;
      return {
        threads: {
          ...state.threads,
          [key]: {
            ...current,
            isOpen: true,
            turns: current.turns.map((turn) =>
              turn.id === turnId
                ? {
                    ...turn,
                    status: client ? "pending" : "error",
                    error: client ? null : disconnectedMessage,
                  }
                : turn,
            ),
          },
        },
      };
    });

    if (!client) return;

    try {
      const result = await client.askAgentSideQuestion(agentId, target.question, {
        ...(history.length > 0 ? { history } : {}),
      });
      set((state) => {
        const current = state.threads[key];
        if (!current) return state;
        return {
          threads: {
            ...state.threads,
            [key]: {
              ...current,
              turns: current.turns.map((turn) =>
                turn.id === turnId
                  ? {
                      ...turn,
                      response: result.response,
                      model: result.model ?? null,
                      status: "done",
                      error: null,
                    }
                  : turn,
              ),
            },
          },
        };
      });
    } catch (error) {
      const message = toErrorMessage(error) || "Failed to ask side question";
      set((state) => {
        const current = state.threads[key];
        if (!current) return state;
        return {
          threads: {
            ...state.threads,
            [key]: {
              ...current,
              turns: current.turns.map((turn) =>
                turn.id === turnId
                  ? {
                      ...turn,
                      status: "error",
                      error: message,
                    }
                  : turn,
              ),
            },
          },
        };
      });
    }
  },

  minimize: (serverId, agentId) => {
    const key = buildSideQuestionThreadKey(serverId, agentId);
    set((state) => {
      const thread = state.threads[key];
      if (!thread) return state;
      return {
        threads: {
          ...state.threads,
          [key]: { ...thread, isOpen: false },
        },
      };
    });
  },

  reopen: (serverId, agentId) => {
    const key = buildSideQuestionThreadKey(serverId, agentId);
    set((state) => {
      const thread = state.threads[key];
      if (!thread) return state;
      return {
        threads: {
          ...state.threads,
          [key]: { ...thread, isOpen: true },
        },
      };
    });
  },

  dismiss: (serverId, agentId) => {
    const key = buildSideQuestionThreadKey(serverId, agentId);
    set((state) => {
      if (!(key in state.threads)) return state;
      const { [key]: _removed, ...threads } = state.threads;
      return { threads };
    });
  },
}));
