import AsyncStorage from "@react-native-async-storage/async-storage";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_DRAFT_QUOTES,
  selectDraftQuotes,
  selectEditingQuoteId,
  useChatQuoteStore,
} from "./store";

const memoryStorage = vi.hoisted(() => new Map<string, string>());

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => memoryStorage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      memoryStorage.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      memoryStorage.delete(key);
    }),
  },
}));

describe("useChatQuoteStore", () => {
  beforeEach(() => {
    memoryStorage.clear();
    useChatQuoteStore.setState({
      quotesByDraftKey: {},
      editingQuoteIdByDraftKey: {},
      focusRequestByDraftKey: {},
    });
  });

  it("returns a referentially stable empty array for drafts without quotes", () => {
    const state = useChatQuoteStore.getState();
    const first = selectDraftQuotes(state, "agent:srv-1:agent-a");
    const second = selectDraftQuotes(state, "agent:srv-1:agent-b");
    expect(first).toBe(EMPTY_DRAFT_QUOTES);
    expect(second).toBe(EMPTY_DRAFT_QUOTES);
  });

  it("stacks multiple message quotes, deduplicates same sourceItemId, and removes individually", () => {
    const draftKey = "agent:srv-1:main";
    const store = useChatQuoteStore.getState();

    const q1 = store.addQuote({
      draftKey,
      text: "First reply",
      role: "assistant",
      sourceItemId: "item-1",
    });
    const q1Dup = store.addQuote({
      draftKey,
      text: "First reply",
      role: "assistant",
      sourceItemId: "item-1",
    });
    const q2 = store.addQuote({
      draftKey,
      text: "Second reply",
      role: "user",
      sourceItemId: "item-2",
    });

    expect(q1?.id).toBeDefined();
    expect(q1Dup?.id).toBe(q1?.id);
    expect(q2?.id).not.toBe(q1?.id);
    expect(useChatQuoteStore.getState().getQuotes(draftKey)).toHaveLength(2);
    expect(useChatQuoteStore.getState().focusRequestByDraftKey[draftKey]).toBe(3);

    useChatQuoteStore.getState().removeQuote({ draftKey, id: q1!.id });
    const remaining = useChatQuoteStore.getState().getQuotes(draftKey);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(q2?.id);
  });

  it("manages selection comment editing lifecycle and drops blank comments on cancel", () => {
    const draftKey = "agent:srv-1:ws-1";
    const created = useChatQuoteStore.getState().addComment({
      draftKey,
      text: "highlighted passage",
      role: "assistant",
    });
    expect(created).not.toBeNull();
    expect(selectEditingQuoteId(useChatQuoteStore.getState(), draftKey)).toBe(created!.id);

    // Canceling while blank removes the temporary comment card.
    useChatQuoteStore.getState().finishCommentEdit({ draftKey, id: created!.id, cancel: true });
    expect(useChatQuoteStore.getState().getQuotes(draftKey)).toHaveLength(0);
    expect(selectEditingQuoteId(useChatQuoteStore.getState(), draftKey)).toBeNull();

    // Writing a note and committing keeps it in the stack.
    const kept = useChatQuoteStore.getState().addComment({
      draftKey,
      text: "another passage",
      role: "assistant",
    });
    useChatQuoteStore.getState().updateCommentBody({
      draftKey,
      id: kept!.id,
      body: "中文批注内容",
    });
    useChatQuoteStore.getState().finishCommentEdit({ draftKey, id: kept!.id, cancel: false });
    expect(useChatQuoteStore.getState().getQuotes(draftKey)).toHaveLength(1);
    expect(useChatQuoteStore.getState().getQuotes(draftKey)[0]?.comment?.body).toBe("中文批注内容");
    expect(selectEditingQuoteId(useChatQuoteStore.getState(), draftKey)).toBeNull();
  });

  it("isolates quotes across draft keys and persists/rehydrates cleanly", async () => {
    const mainDraftKey = "agent:srv-1:main-agent";
    const sideDraftKey = "agent:srv-1:workspace-agent";

    useChatQuoteStore.getState().addQuote({
      draftKey: mainDraftKey,
      text: "Main chat quote",
      role: "assistant",
      sourceItemId: "main-1",
    });
    useChatQuoteStore.getState().addComment({
      draftKey: sideDraftKey,
      text: "Workspace snippet",
      body: "Refactor this helper",
      role: "assistant",
    });

    expect(useChatQuoteStore.getState().getQuotes(mainDraftKey)).toHaveLength(1);
    expect(useChatQuoteStore.getState().getQuotes(sideDraftKey)).toHaveLength(1);

    // Wait for async persistence write to settle, then snapshot persisted payload.
    await vi.waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalled();
      expect(memoryStorage.has("paseo-chat-quotes")).toBe(true);
    });
    const persistedSnapshot = memoryStorage.get("paseo-chat-quotes")!;
    expect(persistedSnapshot).toContain("Main chat quote");
    expect(persistedSnapshot).toContain("Refactor this helper");

    // Simulate reload: wipe in-memory state, keep persisted storage intact, and rehydrate.
    useChatQuoteStore.setState({
      quotesByDraftKey: {},
      editingQuoteIdByDraftKey: {},
      focusRequestByDraftKey: {},
    });
    memoryStorage.set("paseo-chat-quotes", persistedSnapshot);
    await useChatQuoteStore.persist.rehydrate();

    expect(useChatQuoteStore.getState().getQuotes(mainDraftKey)[0]?.text).toBe("Main chat quote");
    expect(useChatQuoteStore.getState().getQuotes(sideDraftKey)[0]?.comment?.body).toBe(
      "Refactor this helper",
    );
    expect(selectEditingQuoteId(useChatQuoteStore.getState(), sideDraftKey)).toBeNull();
  });

  it("supports clearing and restoring quotes when message submission fails", () => {
    const draftKey = "agent:srv-1:retry";
    useChatQuoteStore.getState().addQuote({ draftKey, text: "Quote A", sourceItemId: "a" });
    useChatQuoteStore.getState().addComment({ draftKey, text: "Snippet B", body: "Note B" });
    const snapshot = [...useChatQuoteStore.getState().getQuotes(draftKey)];

    useChatQuoteStore.getState().clearQuotes(draftKey);
    expect(useChatQuoteStore.getState().getQuotes(draftKey)).toHaveLength(0);

    useChatQuoteStore.getState().restoreQuotes(draftKey, snapshot);
    expect(useChatQuoteStore.getState().getQuotes(draftKey)).toEqual(snapshot);
  });
});
