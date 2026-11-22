import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { MainChatService } from "./service.js";

export type MainChatSessionMessage = Extract<
  SessionInboundMessage,
  | { type: "main_chat.ensure.request" }
  | { type: "main_chat.list_plans.request" }
  | { type: "main_chat.start_plan.request" }
  | { type: "main_chat.cancel_plan.request" }
  | { type: "main_chat.get_overview.request" }
  | { type: "main_chat.answer_decision.request" }
  | { type: "main_chat.add_permission_rule.request" }
  | { type: "main_chat.remove_rule.request" }
>;

type SendFn = (response: SessionOutboundMessage) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendUnconfiguredError(msg: MainChatSessionMessage, send: SendFn): void {
  const error = "Main chat service is not configured on this daemon";
  switch (msg.type) {
    case "main_chat.ensure.request":
      send({
        type: "main_chat.ensure.response",
        payload: {
          requestId: msg.requestId,
          agentId: null,
          workspaceId: null,
          created: false,
          error,
        },
      });
      return;
    case "main_chat.list_plans.request":
      send({
        type: "main_chat.list_plans.response",
        payload: { requestId: msg.requestId, plans: [], error },
      });
      return;
    case "main_chat.start_plan.request":
      send({
        type: "main_chat.start_plan.response",
        payload: { requestId: msg.requestId, plan: null, error },
      });
      return;
    case "main_chat.cancel_plan.request":
      send({
        type: "main_chat.cancel_plan.response",
        payload: { requestId: msg.requestId, plan: null, error },
      });
      return;
    case "main_chat.get_overview.request":
      send({
        type: "main_chat.get_overview.response",
        payload: { requestId: msg.requestId, overview: null, error },
      });
      return;
    case "main_chat.answer_decision.request":
      send({
        type: "main_chat.answer_decision.response",
        payload: { requestId: msg.requestId, decision: null, error },
      });
      return;
    case "main_chat.add_permission_rule.request":
      send({
        type: "main_chat.add_permission_rule.response",
        payload: { requestId: msg.requestId, rule: null, error },
      });
      return;
    case "main_chat.remove_rule.request":
      send({
        type: "main_chat.remove_rule.response",
        payload: { requestId: msg.requestId, removed: false, error },
      });
      return;
  }
}

async function handlePlanMessages(
  service: MainChatService,
  msg: Extract<
    MainChatSessionMessage,
    | { type: "main_chat.ensure.request" }
    | { type: "main_chat.list_plans.request" }
    | { type: "main_chat.start_plan.request" }
    | { type: "main_chat.cancel_plan.request" }
  >,
  send: SendFn,
): Promise<void> {
  if (msg.type === "main_chat.ensure.request") {
    try {
      const result = await service.ensureMainChat({
        provider: msg.provider,
        model: msg.model,
        modeId: msg.modeId,
        thinkingOptionId: msg.thinkingOptionId,
      });
      send({
        type: "main_chat.ensure.response",
        payload: {
          requestId: msg.requestId,
          agentId: result.agentId,
          workspaceId: result.workspaceId,
          created: result.created,
          error: null,
        },
      });
    } catch (error) {
      send({
        type: "main_chat.ensure.response",
        payload: {
          requestId: msg.requestId,
          agentId: null,
          workspaceId: null,
          created: false,
          error: errorMessage(error),
        },
      });
    }
    return;
  }

  if (msg.type === "main_chat.list_plans.request") {
    try {
      const plans = service.listPlans(msg.mainAgentId);
      send({
        type: "main_chat.list_plans.response",
        payload: { requestId: msg.requestId, plans, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.list_plans.response",
        payload: { requestId: msg.requestId, plans: [], error: errorMessage(error) },
      });
    }
    return;
  }

  if (msg.type === "main_chat.start_plan.request") {
    try {
      const plan = await service.startPlan(msg.planId, {
        taskIds: msg.taskIds,
        rememberAutoStart: msg.rememberAutoStart,
      });
      send({
        type: "main_chat.start_plan.response",
        payload: { requestId: msg.requestId, plan, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.start_plan.response",
        payload: { requestId: msg.requestId, plan: null, error: errorMessage(error) },
      });
    }
    return;
  }

  try {
    const plan = await service.cancelPlan(msg.planId);
    send({
      type: "main_chat.cancel_plan.response",
      payload: { requestId: msg.requestId, plan, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.cancel_plan.response",
      payload: { requestId: msg.requestId, plan: null, error: errorMessage(error) },
    });
  }
}

async function handleGovernanceMessages(
  service: MainChatService,
  msg: Extract<
    MainChatSessionMessage,
    | { type: "main_chat.get_overview.request" }
    | { type: "main_chat.answer_decision.request" }
    | { type: "main_chat.add_permission_rule.request" }
    | { type: "main_chat.remove_rule.request" }
  >,
  send: SendFn,
): Promise<void> {
  if (msg.type === "main_chat.get_overview.request") {
    try {
      const overview = await service.getOverview(msg.mainAgentId);
      send({
        type: "main_chat.get_overview.response",
        payload: { requestId: msg.requestId, overview, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.get_overview.response",
        payload: { requestId: msg.requestId, overview: null, error: errorMessage(error) },
      });
    }
    return;
  }

  if (msg.type === "main_chat.answer_decision.request") {
    try {
      const decision = await service.answerDecision({
        decisionId: msg.decisionId,
        optionId: msg.optionId,
        answer: msg.answer,
      });
      send({
        type: "main_chat.answer_decision.response",
        payload: { requestId: msg.requestId, decision, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.answer_decision.response",
        payload: { requestId: msg.requestId, decision: null, error: errorMessage(error) },
      });
    }
    return;
  }

  if (msg.type === "main_chat.add_permission_rule.request") {
    try {
      const rule = await service.addPermissionRule({
        toolName: msg.toolName,
        commandPrefix: msg.commandPrefix ?? null,
        cwd: msg.cwd ?? null,
      });
      send({
        type: "main_chat.add_permission_rule.response",
        payload: { requestId: msg.requestId, rule, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.add_permission_rule.response",
        payload: { requestId: msg.requestId, rule: null, error: errorMessage(error) },
      });
    }
    return;
  }

  try {
    const removed = await service.removeRule(msg.kind, msg.ruleId);
    send({
      type: "main_chat.remove_rule.response",
      payload: { requestId: msg.requestId, removed, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.remove_rule.response",
      payload: { requestId: msg.requestId, removed: false, error: errorMessage(error) },
    });
  }
}

export async function handleMainChatSessionMessage(
  service: MainChatService | null,
  msg: MainChatSessionMessage,
  send: SendFn,
): Promise<void> {
  if (!service) {
    sendUnconfiguredError(msg, send);
    return;
  }

  switch (msg.type) {
    case "main_chat.ensure.request":
    case "main_chat.list_plans.request":
    case "main_chat.start_plan.request":
    case "main_chat.cancel_plan.request":
      await handlePlanMessages(service, msg, send);
      return;
    case "main_chat.get_overview.request":
    case "main_chat.answer_decision.request":
    case "main_chat.add_permission_rule.request":
    case "main_chat.remove_rule.request":
      await handleGovernanceMessages(service, msg, send);
      return;
  }
}
