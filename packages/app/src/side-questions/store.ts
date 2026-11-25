import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { create } from "zustand";
import { toErrorMessage } from "@/utils/error-messages";

export type SideQuestionDisplayMode = "open" | "minimized" | "closed";

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
  displayMode: SideQuestionDisplayMode;
}

interface SideQuestionStoreState {
  threads: Record<string, SideQuestionThreadState>;
  open: (serverId: string, agentId: string) => void;
  toggle: (serverId: string, agentId: string) => void;
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
  close: (serverId: string, agentId: string) => void;
  clear: (serverId: string, agentId: string) => void;
}

let nextTurnSequence = 0;

export function buildSideQuestionThreadKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function buildSideQuestionForkTitle(
  turn: Pick<SideQuestionTurnEntry, "question">,
): string | undefined {
  const singleLine = turn.question.replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length > 48 ? `${singleLine.slice(0, 47).trimEnd()}…` : singleLine;
}

export function buildSideQuestionForkDraft(
  turn: Pick<SideQuestionTurnEntry, "question" | "response" | "status">,
): string {
  const question = turn.question.trim();
  if (turn.status !== "done" || !turn.response?.trim()) {
    return question;
  }
  const answer = turn.response.trim();
  return [
    `[BTW 旁路提问记录]`,
    `Q: ${question}`,
    ``,
    `A: ${answer}`,
    ``,
    `请基于以上讨论继续处理：`,
  ].join("\n");
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

function updateTurn(
  turns: SideQuestionTurnEntry[],
  id: string,
  patch: Partial<SideQuestionTurnEntry>,
): SideQuestionTurnEntry[] {
  const index = turns.findIndex((turn) => turn.id === id);
  if (index < 0) return turns;
  const next = turns.slice();
  next[index] = { ...turns[index], ...patch };
  return next;
}

export const useSideQuestionStore = create<SideQuestionStoreState>((set, get) => ({
  threads: {},

  open: (serverId, agentId) => {
    const key = buildSideQuestionThreadKey(serverId, agentId);
    set((state) => {
      const existing = state.threads[key];
      return {
        threads: {
          ...state.threads,
          [key]: {
            turns: existing?.turns ?? [],
            displayMode: "open",
          },
        },
      };
    });
  },

  toggle: (serverId, agentId) => {
    const key = buildSideQuestionThreadKey(serverId, agentId);
    const existing = get().threads[key];
    if (existing?.displayMode === "open") {
      get().close(serverId, agentId);
      return;
    }
    get().open(serverId, agentId);
  },

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
          displayMode: "open",
          turns: [...(state.threads[key]?.turns ?? []), pendingEntry],
        },
      },
    }));

    if (!client) {
      return;
    }

    try {
      const result = await client.askAgentSideQuestion(
        agentId,
        trimmed,
        history.length > 0 ? { history } : {},
      );
      set((state) => {
        const thread = state.threads[key];
        if (!thread) return state;
        return {
          threads: {
            ...state.threads,
            [key]: {
              ...thread,
              turns: updateTurn(thread.turns, turnId, {
                response: result.response,
                model: result.model ?? null,
                status: "done",
                error: null,
              }),
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
              turns: updateTurn(thread.turns, turnId, {
                status: "error",
                error: message,
              }),
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
            displayMode: "open",
            turns: updateTurn(current.turns, turnId, {
              status: client ? "pending" : "error",
              error: client ? null : disconnectedMessage,
            }),
          },
        },
      };
    });

    if (!client) return;

    try {
      const result = await client.askAgentSideQuestion(
        agentId,
        target.question,
        history.length > 0 ? { history } : {},
      );
      set((state) => {
        const current = state.threads[key];
        if (!current) return state;
        return {
          threads: {
            ...state.threads,
            [key]: {
              ...current,
              turns: updateTurn(current.turns, turnId, {
                response: result.response,
                model: result.model ?? null,
                status: "done",
                error: null,
              }),
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
              turns: updateTurn(current.turns, turnId, {
                status: "error",
                error: message,
              }),
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
      if (thread.turns.length === 0) {
        const { [key]: _removed, ...threads } = state.threads;
        return { threads };
      }
      return {
        threads: {
          ...state.threads,
          [key]: { ...thread, displayMode: "minimized" },
        },
      };
    });
  },

  reopen: (serverId, agentId) => {
    get().open(serverId, agentId);
  },

  close: (serverId, agentId) => {
    const key = buildSideQuestionThreadKey(serverId, agentId);
    set((state) => {
      const thread = state.threads[key];
      if (!thread) return state;
      if (thread.turns.length === 0) {
        const { [key]: _removed, ...threads } = state.threads;
        return { threads };
      }
      return {
        threads: {
          ...state.threads,
          [key]: { ...thread, displayMode: "closed" },
        },
      };
    });
  },

  clear: (serverId, agentId) => {
    const key = buildSideQuestionThreadKey(serverId, agentId);
    set((state) => {
      const thread = state.threads[key];
      if (!thread) return state;
      if (thread.displayMode === "open") {
        return {
          threads: {
            ...state.threads,
            [key]: { turns: [], displayMode: "open" },
          },
        };
      }
      const { [key]: _removed, ...threads } = state.threads;
      return { threads };
    });
  },
}));
