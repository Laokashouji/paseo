import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { InteractiveCardView } from "@getpaseo/protocol/interactive-cards";
import {
  applyAgentCardsSnapshot,
  applyAgentCardsUpdate,
  getAgentCardsBucket,
  getCardDraft,
  popCardDraftPage,
  pushCardDraftPage,
  resetInteractiveCardsStore,
  setCardDraftFieldValue,
  submitInteractiveCardAction,
} from "./store";

const SAMPLE_VIEW: InteractiveCardView = {
  version: 1,
  title: "Demo",
  fallback: "Fallback",
  sections: [
    {
      items: [
        { type: "field", name: "flag", label: "Flag", kind: "toggle", value: "true" },
        {
          type: "button",
          label: "Submit",
          action: { kind: "reply", id: "go", reply: "Go", submit: true },
        },
      ],
    },
  ],
};

describe("interactive-cards store", () => {
  beforeEach(() => {
    resetInteractiveCardsStore();
  });

  it("drops stale view versions and stale action revisions", () => {
    applyAgentCardsSnapshot("srv-1", "ag-1", {
      views: [
        {
          id: "view_aaaaaaaaaaaa",
          agentId: "ag-1",
          version: 3,
          view: SAMPLE_VIEW,
          createdAt: "2026-11-24T00:00:00.000Z",
          updatedAt: "2026-11-24T00:00:00.000Z",
        },
      ],
      inlineBlockKeys: ["inline:0123456789abcdef/0"],
      actions: [],
    });

    applyAgentCardsUpdate("srv-1", {
      agentId: "ag-1",
      kind: "view_upserted",
      view: {
        id: "view_aaaaaaaaaaaa",
        agentId: "ag-1",
        version: 2,
        view: { ...SAMPLE_VIEW, title: "Stale" },
        createdAt: "2026-11-24T00:00:00.000Z",
        updatedAt: "2026-11-24T00:00:00.000Z",
      },
    });

    expect(getAgentCardsBucket("srv-1", "ag-1").views["view_aaaaaaaaaaaa"]?.version).toBe(3);
  });

  it("reuses clientMessageId across failed retries and preserves draft on view_changed", async () => {
    const submitMock = vi.fn<DaemonClient["submitAgentCard"]>();
    const client = { submitAgentCard: submitMock };

    setCardDraftFieldValue("srv-1", "ag-1", "view_bbbbbbbbbbbb", "flag", "false");

    // 1. Live card changed underneath -> preserves draft & updates view
    submitMock.mockResolvedValueOnce({
      requestId: "r1",
      agentId: "ag-1",
      cardKey: "view_bbbbbbbbbbbb",
      ok: false,
      code: "view_changed",
      view: {
        id: "view_bbbbbbbbbbbb",
        agentId: "ag-1",
        version: 2,
        view: { ...SAMPLE_VIEW, title: "Updated v2" },
        createdAt: "2026-11-24T00:00:00.000Z",
        updatedAt: "2026-11-24T00:00:00.000Z",
      },
    });

    const changed = await submitInteractiveCardAction({
      client,
      serverId: "srv-1",
      agentId: "ag-1",
      cardKey: "view_bbbbbbbbbbbb",
      actionId: "go",
      page: "",
      values: { flag: "false" },
      expectedVersion: 1,
      confirmed: false,
    });
    expect(changed).toBe("view_changed");
    expect(getCardDraft("srv-1", "ag-1", "view_bbbbbbbbbbbb")?.changed).toBe(true);
    expect(getCardDraft("srv-1", "ag-1", "view_bbbbbbbbbbbb")?.values.flag).toBe("false");
    expect(getAgentCardsBucket("srv-1", "ag-1").views["view_bbbbbbbbbbbb"]?.version).toBe(2);

    // 2. Network failure -> retry reuses exact same clientMessageId
    submitMock.mockRejectedValueOnce(new Error("offline"));
    const failed = await submitInteractiveCardAction({
      client,
      serverId: "srv-1",
      agentId: "ag-1",
      cardKey: "view_bbbbbbbbbbbb",
      actionId: "go",
      page: "",
      values: { flag: "false" },
      expectedVersion: 2,
      confirmed: true,
    });
    expect(failed).toBe("failed");
    const firstId = submitMock.mock.calls[1]?.[0].clientMessageId;
    expect(firstId).toBeTruthy();

    submitMock.mockResolvedValueOnce({
      requestId: "r3",
      agentId: "ag-1",
      cardKey: "view_bbbbbbbbbbbb",
      ok: true,
      action: {
        cardKey: "view_bbbbbbbbbbbb",
        actionId: "go",
        version: 2,
        clientMessageId: firstId!,
        text: "Go",
        status: "sent",
        revision: 2,
        createdAt: "2026-11-24T00:00:00.000Z",
        updatedAt: "2026-11-24T00:00:00.000Z",
      },
    });
    const retried = await submitInteractiveCardAction({
      client,
      serverId: "srv-1",
      agentId: "ag-1",
      cardKey: "view_bbbbbbbbbbbb",
      actionId: "go",
      page: "",
      values: { flag: "false" },
      expectedVersion: 2,
      confirmed: true,
    });
    expect(retried).toBe("sent");
    expect(submitMock.mock.calls[2]?.[0].clientMessageId).toBe(firstId);
  });

  it("enforces max page stack depth and pop semantics", () => {
    pushCardDraftPage("s", "a", "k", "p1", 2);
    pushCardDraftPage("s", "a", "k", "p2", 2);
    pushCardDraftPage("s", "a", "k", "p3", 2);
    expect(getCardDraft("s", "a", "k")?.pageStack).toEqual(["p1", "p2"]);
    popCardDraftPage("s", "a", "k");
    expect(getCardDraft("s", "a", "k")?.pageStack).toEqual(["p1"]);
  });
});
