import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSideQuestionForkDraft,
  buildSideQuestionForkTitle,
  buildSideQuestionThreadKey,
  useSideQuestionStore,
} from "./store";

beforeEach(() => {
  useSideQuestionStore.setState({ threads: {} });
});

describe("useSideQuestionStore", () => {
  it("appends ephemeral turns, forwards prior Q&A history, and supports minimize/close/reopen/clear", async () => {
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
      displayMode: "open",
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
    expect(useSideQuestionStore.getState().threads[key]?.displayMode).toBe("minimized");
    expect(useSideQuestionStore.getState().threads[key]?.turns).toHaveLength(2);

    useSideQuestionStore.getState().close("srv-1", "agent-1");
    expect(useSideQuestionStore.getState().threads[key]?.displayMode).toBe("closed");
    expect(useSideQuestionStore.getState().threads[key]?.turns).toHaveLength(2);

    useSideQuestionStore.getState().reopen("srv-1", "agent-1");
    expect(useSideQuestionStore.getState().threads[key]?.displayMode).toBe("open");
    expect(useSideQuestionStore.getState().threads[key]?.turns).toHaveLength(2);

    useSideQuestionStore.getState().clear("srv-1", "agent-1");
    expect(useSideQuestionStore.getState().threads[key]).toEqual({
      turns: [],
      displayMode: "open",
    });

    useSideQuestionStore.getState().close("srv-1", "agent-1");
    expect(useSideQuestionStore.getState().threads[key]).toBeUndefined();
  });

  it("opens an empty panel via open/toggle and cleans it up when closed empty", () => {
    const key = buildSideQuestionThreadKey("srv-1", "agent-2");

    useSideQuestionStore.getState().toggle("srv-1", "agent-2");
    expect(useSideQuestionStore.getState().threads[key]).toEqual({
      turns: [],
      displayMode: "open",
    });

    useSideQuestionStore.getState().toggle("srv-1", "agent-2");
    expect(useSideQuestionStore.getState().threads[key]).toBeUndefined();

    useSideQuestionStore.getState().open("srv-1", "agent-2");
    expect(useSideQuestionStore.getState().threads[key]?.displayMode).toBe("open");

    useSideQuestionStore.getState().minimize("srv-1", "agent-2");
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

  it("builds branch title and handoff draft for completed and failed turns", () => {
    expect(buildSideQuestionForkTitle({ question: "  检查   config.json   是否兼容  " })).toBe(
      "检查 config.json 是否兼容",
    );
    expect(
      buildSideQuestionForkTitle({
        question: "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常长的问题标题",
      })?.length,
    ).toBeLessThanOrEqual(48);

    expect(
      buildSideQuestionForkDraft({
        question: "为什么会超时？",
        response: "因为默认超时只有 1500ms。",
        status: "done",
      }),
    ).toContain("Q: 为什么会超时？\n\nA: 因为默认超时只有 1500ms。");

    expect(
      buildSideQuestionForkDraft({
        question: "帮我跑一下单测",
        response: null,
        status: "error",
      }),
    ).toBe("帮我跑一下单测");
  });
});
