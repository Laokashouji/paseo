import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { clampCommentBody } from "./format";
import { MAX_QUOTE_STACK_ITEMS, type DraftQuote, type QuoteAuthorRole } from "./types";

export const EMPTY_DRAFT_QUOTES: readonly DraftQuote[] = Object.freeze([]);

const DraftQuoteSchema: z.ZodType<DraftQuote> = z.strictObject({
  id: z.string().min(1),
  text: z.string(),
  role: z.enum(["user", "assistant"]).optional(),
  from: z.string().optional(),
  ts: z.number().optional(),
  sourceItemId: z.string().optional(),
  comment: z
    .strictObject({
      body: z.string(),
    })
    .optional(),
});

const ChatQuotePersistedStateSchema = z.strictObject({
  quotesByDraftKey: z.record(z.string(), z.array(DraftQuoteSchema)),
});

type ChatQuotePersistedState = z.infer<typeof ChatQuotePersistedStateSchema>;

export interface AddQuoteInput {
  draftKey: string;
  text: string;
  role?: QuoteAuthorRole;
  from?: string;
  ts?: number;
  sourceItemId?: string;
}

export interface AddCommentInput {
  draftKey: string;
  text: string;
  body?: string;
  role?: QuoteAuthorRole;
  from?: string;
  ts?: number;
  sourceItemId?: string;
}

interface ChatQuoteStoreState extends ChatQuotePersistedState {
  editingQuoteIdByDraftKey: Record<string, string | null>;
  focusRequestByDraftKey: Record<string, number>;
  getQuotes: (draftKey: string) => readonly DraftQuote[];
  addQuote: (input: AddQuoteInput) => DraftQuote | null;
  addComment: (input: AddCommentInput) => DraftQuote | null;
  updateCommentBody: (input: { draftKey: string; id: string; body: string }) => void;
  setEditingQuoteId: (input: { draftKey: string; id: string | null }) => void;
  finishCommentEdit: (input: { draftKey: string; id: string; cancel?: boolean }) => void;
  removeQuote: (input: { draftKey: string; id: string }) => void;
  clearQuotes: (draftKey: string) => void;
  restoreQuotes: (draftKey: string, quotes: readonly DraftQuote[]) => void;
}

let quoteIdCounter = 0;

function nextQuoteId(): string {
  quoteIdCounter += 1;
  return `quote_${Date.now().toString(36)}_${quoteIdCounter.toString(36)}`;
}

const chatQuotePersistStorage = createValidatedPersistStorage<ChatQuotePersistedState>(
  AsyncStorage,
  ChatQuotePersistedStateSchema,
  { skipUnchanged: true },
);

export function selectDraftQuotes(
  state: ChatQuoteStoreState,
  draftKey: string,
): readonly DraftQuote[] {
  return state.quotesByDraftKey[draftKey] ?? EMPTY_DRAFT_QUOTES;
}

export function selectEditingQuoteId(state: ChatQuoteStoreState, draftKey: string): string | null {
  return state.editingQuoteIdByDraftKey[draftKey] ?? null;
}

export function selectQuoteFocusRequest(state: ChatQuoteStoreState, draftKey: string): number {
  return state.focusRequestByDraftKey[draftKey] ?? 0;
}

export const useChatQuoteStore = create<ChatQuoteStoreState>()(
  persist(
    (set, get) => ({
      quotesByDraftKey: {},
      editingQuoteIdByDraftKey: {},
      focusRequestByDraftKey: {},

      getQuotes: (draftKey) => get().quotesByDraftKey[draftKey] ?? EMPTY_DRAFT_QUOTES,

      addQuote: (input) => {
        const trimmed = input.text.trim();
        if (!trimmed) {
          return null;
        }
        const existing = get().quotesByDraftKey[input.draftKey] ?? [];
        const duplicate = existing.find(
          (entry) =>
            !entry.comment &&
            ((input.sourceItemId && entry.sourceItemId === input.sourceItemId) ||
              (!input.sourceItemId && entry.text === trimmed)),
        );
        if (duplicate) {
          set((state) => ({
            focusRequestByDraftKey: {
              ...state.focusRequestByDraftKey,
              [input.draftKey]: (state.focusRequestByDraftKey[input.draftKey] ?? 0) + 1,
            },
          }));
          return duplicate;
        }

        const entry: DraftQuote = {
          id: nextQuoteId(),
          text: trimmed,
          ...(input.role ? { role: input.role } : {}),
          ...(input.from ? { from: input.from } : {}),
          ...(typeof input.ts === "number" ? { ts: input.ts } : {}),
          ...(input.sourceItemId ? { sourceItemId: input.sourceItemId } : {}),
        };
        const nextList = [...existing, entry].slice(-MAX_QUOTE_STACK_ITEMS);
        set((state) => ({
          quotesByDraftKey: {
            ...state.quotesByDraftKey,
            [input.draftKey]: nextList,
          },
          focusRequestByDraftKey: {
            ...state.focusRequestByDraftKey,
            [input.draftKey]: (state.focusRequestByDraftKey[input.draftKey] ?? 0) + 1,
          },
        }));
        return entry;
      },

      addComment: (input) => {
        const trimmed = input.text.trim();
        if (!trimmed) {
          return null;
        }
        const existing = get().quotesByDraftKey[input.draftKey] ?? [];
        const entry: DraftQuote = {
          id: nextQuoteId(),
          text: trimmed,
          ...(input.role ? { role: input.role } : {}),
          ...(input.from ? { from: input.from } : {}),
          ...(typeof input.ts === "number" ? { ts: input.ts } : {}),
          ...(input.sourceItemId ? { sourceItemId: input.sourceItemId } : {}),
          comment: {
            body: clampCommentBody(input.body ?? ""),
          },
        };
        const nextList = [...existing, entry].slice(-MAX_QUOTE_STACK_ITEMS);
        set((state) => ({
          quotesByDraftKey: {
            ...state.quotesByDraftKey,
            [input.draftKey]: nextList,
          },
          editingQuoteIdByDraftKey: {
            ...state.editingQuoteIdByDraftKey,
            [input.draftKey]: entry.id,
          },
        }));
        return entry;
      },

      updateCommentBody: ({ draftKey, id, body }) => {
        const clamped = clampCommentBody(body);
        set((state) => {
          const list = state.quotesByDraftKey[draftKey];
          if (!list) return state;
          let changed = false;
          const nextList: DraftQuote[] = [];
          for (const entry of list) {
            if (entry.id !== id || !entry.comment || entry.comment.body === clamped) {
              nextList.push(entry);
              continue;
            }
            changed = true;
            nextList.push({
              ...entry,
              comment: { body: clamped },
            });
          }
          if (!changed) return state;
          return {
            quotesByDraftKey: {
              ...state.quotesByDraftKey,
              [draftKey]: nextList,
            },
          };
        });
      },

      setEditingQuoteId: ({ draftKey, id }) => {
        set((state) => {
          if ((state.editingQuoteIdByDraftKey[draftKey] ?? null) === id) {
            return state;
          }
          return {
            editingQuoteIdByDraftKey: {
              ...state.editingQuoteIdByDraftKey,
              [draftKey]: id,
            },
          };
        });
      },

      finishCommentEdit: ({ draftKey, id, cancel = false }) => {
        set((state) => {
          const list = state.quotesByDraftKey[draftKey] ?? [];
          const target = list.find((entry) => entry.id === id);
          const shouldDropEmpty =
            cancel && target?.comment && target.comment.body.trim().length === 0;
          const nextList = shouldDropEmpty ? list.filter((entry) => entry.id !== id) : list;
          const nextQuotesByDraftKey = { ...state.quotesByDraftKey };
          if (nextList.length === 0) {
            delete nextQuotesByDraftKey[draftKey];
          } else if (shouldDropEmpty) {
            nextQuotesByDraftKey[draftKey] = nextList;
          }

          return {
            ...(shouldDropEmpty ? { quotesByDraftKey: nextQuotesByDraftKey } : {}),
            editingQuoteIdByDraftKey: {
              ...state.editingQuoteIdByDraftKey,
              [draftKey]:
                state.editingQuoteIdByDraftKey[draftKey] === id
                  ? null
                  : (state.editingQuoteIdByDraftKey[draftKey] ?? null),
            },
          };
        });
      },

      removeQuote: ({ draftKey, id }) => {
        set((state) => {
          const list = state.quotesByDraftKey[draftKey];
          if (!list) return state;
          const nextList = list.filter((entry) => entry.id !== id);
          if (nextList.length === list.length) return state;
          const nextQuotesByDraftKey = { ...state.quotesByDraftKey };
          if (nextList.length === 0) {
            delete nextQuotesByDraftKey[draftKey];
          } else {
            nextQuotesByDraftKey[draftKey] = nextList;
          }
          const wasEditing = state.editingQuoteIdByDraftKey[draftKey] === id;
          return {
            quotesByDraftKey: nextQuotesByDraftKey,
            ...(wasEditing
              ? {
                  editingQuoteIdByDraftKey: {
                    ...state.editingQuoteIdByDraftKey,
                    [draftKey]: null,
                  },
                }
              : {}),
          };
        });
      },

      clearQuotes: (draftKey) => {
        set((state) => {
          if (!state.quotesByDraftKey[draftKey] && !state.editingQuoteIdByDraftKey[draftKey]) {
            return state;
          }
          const nextQuotesByDraftKey = { ...state.quotesByDraftKey };
          delete nextQuotesByDraftKey[draftKey];
          const nextEditing = { ...state.editingQuoteIdByDraftKey };
          delete nextEditing[draftKey];
          return {
            quotesByDraftKey: nextQuotesByDraftKey,
            editingQuoteIdByDraftKey: nextEditing,
          };
        });
      },

      restoreQuotes: (draftKey, quotes) => {
        if (quotes.length === 0) return;
        set((state) => ({
          quotesByDraftKey: {
            ...state.quotesByDraftKey,
            [draftKey]: [...quotes].slice(-MAX_QUOTE_STACK_ITEMS),
          },
        }));
      },
    }),
    {
      name: "paseo-chat-quotes",
      version: 1,
      storage: chatQuotePersistStorage,
      partialize: ({ quotesByDraftKey }) => ({ quotesByDraftKey }),
    },
  ),
);
