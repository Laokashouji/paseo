import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { InteractiveCardsService } from "./service.js";

export type InteractiveCardsSessionRequest = Extract<
  SessionInboundMessage,
  { type: "agent.cards.list.request" | "agent.cards.submit.request" }
>;

export async function handleInteractiveCardsSessionMessage(
  service: InteractiveCardsService | null | undefined,
  msg: InteractiveCardsSessionRequest,
  send: (response: SessionOutboundMessage) => void,
): Promise<void> {
  if (msg.type === "agent.cards.list.request") {
    if (!service) {
      send({
        type: "agent.cards.list.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          views: [],
          inlineBlockKeys: [],
          actions: [],
          error: "Interactive cards service is not available on this host.",
        },
      });
      return;
    }
    try {
      const snapshot = await service.listAgentCards(msg.agentId);
      send({
        type: "agent.cards.list.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          views: snapshot.views,
          inlineBlockKeys: snapshot.inlineBlockKeys,
          actions: snapshot.actions,
          error: null,
        },
      });
    } catch (err) {
      send({
        type: "agent.cards.list.response",
        payload: {
          requestId: msg.requestId,
          agentId: msg.agentId,
          views: [],
          inlineBlockKeys: [],
          actions: [],
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    return;
  }

  if (!service) {
    send({
      type: "agent.cards.submit.response",
      payload: {
        requestId: msg.requestId,
        agentId: msg.agentId,
        cardKey: msg.cardKey,
        ok: false,
        code: "not_found",
        error: "Interactive cards service is not available on this host.",
      },
    });
    return;
  }

  try {
    const result = await service.submitCardAction({
      agentId: msg.agentId,
      cardKey: msg.cardKey,
      actionId: msg.actionId,
      page: msg.page,
      values: msg.values,
      expectedVersion: msg.expectedVersion,
      clientMessageId: msg.clientMessageId,
      confirmed: msg.confirmed,
    });
    send({
      type: "agent.cards.submit.response",
      payload: {
        requestId: msg.requestId,
        agentId: msg.agentId,
        cardKey: msg.cardKey,
        ok: result.ok,
        ...(result.action ? { action: result.action } : {}),
        ...(result.view ? { view: result.view } : {}),
        ...(result.code ? { code: result.code } : {}),
        ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
        error: result.error ?? null,
      },
    });
  } catch (err) {
    send({
      type: "agent.cards.submit.response",
      payload: {
        requestId: msg.requestId,
        agentId: msg.agentId,
        cardKey: msg.cardKey,
        ok: false,
        code: "delivery_failed",
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
