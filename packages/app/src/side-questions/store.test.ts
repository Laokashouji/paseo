import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSideQuestionThreadKey, useSideQuestionStore } from "./store";

beforeEach(() => {
  useSideQuestionStore.setState({ threads: {} });
});

describe("useSideQuestionStore", () => {
  it("appends ephemeral turns, forwards prior Q&A history, and supports minimize/reopen/dismiss", async () => {
    const askAgentSideQuestion = vi
      .fn()
      .mockResolvedValueOnce({ response: "MANGO-42", synthetic: false, model: "claude-opus" })
      .mockResolvedValueOnce({ response: "Mango", synthetic: false, model: "claude-opus" });

    await useSideQuestionStore.getState().askQuestion({
      serverId: "srv-1",
      agentId: "agent-1",
      question: "What is the secret code?",
      client: { askAgentSideQuestion },
      disconnectedMessage: "Disconnected",
    });

    const key = buildSideQuestionThreadKey("srv-1", "agent-1");
    expect(askAgentSideQuestion).toHaveBeenNthCalledWith(1, "agent-1", "What is the secret code?", {});
    expect(useSideQuestionStore.getState().threads[key]).toMatchObject({
      isOpen: true,
      turns: [
        {
          question: "What is the secret code?",
          response: "MANGO-42",
          status: "done",
          error: null,
          model: "claude-opus",
        },
      ],
    });

    await useSideQuestionStore.getState().askQuestion({
      serverId: "srv-1",
      agentId: "agent-1",
      question: "Which fruit?",
      client: { askAgentSideQuestion },
      disconnectedMessage: "Disconnected",
    });

    expect(askAgentSideQuestion).toHaveBeenNthCalledWith(2, "agent-1", "Which fruit?", {
      history: [{ question: "What is the secret code?", response: "MANGO-42" }],
    });

    useSideQuestionStore.getState().minimize("srv-1", "agent-1");
    expect(useSideQuestionStore.getState().threads[key]?.isOpen).toBe(false);

    useSideQuestionStore.getState().reopen("srv-1", "agent-1");
    expect(useSideQuestionStore.getState().threads[key]?.isOpen).toBe(true);

    useSideQuestionStore.getState().dismiss("srv-1", "agent-1");
    expect(useSideQuestionStore.getState().threads[key]).toBeUndefined();
  });

  it("records errors and retries failed turns cleanly", async () => {
    const askAgentSideQuestion = vi
      .fn()
      .mockRejectedValueOnce(new Error("Temporary network error"))
      .mockResolvedValueOnce({ response: "Recovered answer", model: "claude-sonnet" });

    await useSideQuestionStore.getState().askQuestion({
      serverId: "srv-1",
      agentId: "agent-1",
      question: "Check status?",
      client: { askAgentSideQuestion },
      disconnectedMessage: "Disconnected",
    });

    const key = buildSideQuestionThreadKey("srv-1", "agent-1");
    const failedTurn = useSideQuestionStore.getState().threads[key]!.turns[0]!;
    expect(failedTurn.status).toBe("error");
    expect(failedTurn.error).toBe("Temporary network error");

    await useSideQuestionStore.getState().retryTurn({
      serverId: "srv-1",
      agentId: "agent-1",
      turnId: failedTurn.id,
      client: { askAgentSideQuestion },
      disconnectedMessage: "Disconnected",
    });

    const retried = useSideQuestionStore.getState().threads[key]!.turns[0]!;
    expect(retried.status).toBe("done");
    expect(retried.response).toBe("Recovered answer");
  });
});
