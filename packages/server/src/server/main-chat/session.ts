import {
  createEmptyFeishuBridgeStats,
  createUnavailableFeishuBridgeState,
  type MainChatNotificationSummary,
} from "@getpaseo/protocol/main-chat";
import type { SessionInboundMessage, SessionOutboundMessage } from "../messages.js";
import type { MainChatService } from "./service.js";

const EMPTY_NOTIFICATION_SUMMARY: MainChatNotificationSummary = {
  lowDistractionEnabled: false,
  mode: "balanced",
  unreadCount: 0,
  deliveredCount: 0,
  suppressedQuietCount: 0,
  suppressedNightCount: 0,
  foldedDigestCount: 0,
  criticalPassthroughCount: 0,
  latestReceiptAt: null,
};

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
  | { type: "main_chat.get_settings.request" }
  | { type: "main_chat.update_settings.request" }
  | { type: "main_chat.trigger_patrol.request" }
  | { type: "main_chat.compact.request" }
  | { type: "main_chat.clear.request" }
  | { type: "main_chat.new_session.request" }
  | { type: "main_chat.list_activity.request" }
  | { type: "main_chat.update_plan_task.request" }
  | { type: "main_chat.withdraw_plan.request" }
  | { type: "main_chat.list_tasks.request" }
  | { type: "main_chat.update_task_scope.request" }
  | { type: "main_chat.park_task.request" }
  | { type: "main_chat.review_task.request" }
  | { type: "main_chat.list_conversations.request" }
  | { type: "main_chat.create_conversation.request" }
  | { type: "main_chat.update_conversation.request" }
  | { type: "main_chat.get_fleet_hosts.request" }
  | { type: "main_chat.clarify_permission.request" }
  | { type: "main_chat.list_standing_authorizations.request" }
  | { type: "main_chat.grant_standing_authorization.request" }
  | { type: "main_chat.revoke_standing_authorization.request" }
  | { type: "main_chat.dismiss_rule_suggestion.request" }
  | { type: "main_chat.get_usage.request" }
  | { type: "main_chat.reset_usage.request" }
  | { type: "main_chat.memory_list.request" }
  | { type: "main_chat.memory_read.request" }
  | { type: "main_chat.memory_write.request" }
  | { type: "main_chat.memory_delete.request" }
  | { type: "main_chat.routines_list.request" }
  | { type: "main_chat.routines_create.request" }
  | { type: "main_chat.routines_pause.request" }
  | { type: "main_chat.routines_resume.request" }
  | { type: "main_chat.routines_run_once.request" }
  | { type: "main_chat.routines_delete.request" }
  | { type: "main_chat.list_settings_proposals.request" }
  | { type: "main_chat.resolve_settings_proposal.request" }
  | { type: "main_chat.lessons_list.request" }
  | { type: "main_chat.lessons_add.request" }
  | { type: "main_chat.lessons_delete.request" }
  | { type: "main_chat.start_ready_task.request" }
  | { type: "main_chat.update_task_dependencies.request" }
  | { type: "main_chat.switch_model_profile.request" }
  | { type: "main_chat.retry_task_with_fallback.request" }
  | { type: "main_chat.list_notification_receipts.request" }
  | { type: "main_chat.ack_notification_receipt.request" }
  | { type: "main_chat.get_resource_admission.request" }
  | { type: "main_chat.drain_admission_queue.request" }
  | { type: "main_chat.sweep_idle_subagents.request" }
  | { type: "main_chat.list_prompt_library.request" }
  | { type: "main_chat.save_prompt_template.request" }
  | { type: "main_chat.delete_prompt_template.request" }
  | { type: "main_chat.feishu_bridge_get_state.request" }
  | { type: "main_chat.feishu_bridge_update_config.request" }
  | { type: "main_chat.feishu_bridge_test_connection.request" }
  | { type: "main_chat.feishu_bridge_send_test_card.request" }
  | { type: "main_chat.feishu_bridge_list_audit.request" }
>;

const MAIN_CHAT_SESSION_MESSAGE_TYPES: ReadonlySet<string> = new Set<
  MainChatSessionMessage["type"]
>([
  "main_chat.ensure.request",
  "main_chat.list_plans.request",
  "main_chat.start_plan.request",
  "main_chat.cancel_plan.request",
  "main_chat.get_overview.request",
  "main_chat.answer_decision.request",
  "main_chat.add_permission_rule.request",
  "main_chat.remove_rule.request",
  "main_chat.get_settings.request",
  "main_chat.update_settings.request",
  "main_chat.trigger_patrol.request",
  "main_chat.compact.request",
  "main_chat.clear.request",
  "main_chat.new_session.request",
  "main_chat.list_activity.request",
  "main_chat.update_plan_task.request",
  "main_chat.withdraw_plan.request",
  "main_chat.list_tasks.request",
  "main_chat.update_task_scope.request",
  "main_chat.park_task.request",
  "main_chat.review_task.request",
  "main_chat.list_conversations.request",
  "main_chat.create_conversation.request",
  "main_chat.update_conversation.request",
  "main_chat.get_fleet_hosts.request",
  "main_chat.clarify_permission.request",
  "main_chat.list_standing_authorizations.request",
  "main_chat.grant_standing_authorization.request",
  "main_chat.revoke_standing_authorization.request",
  "main_chat.dismiss_rule_suggestion.request",
  "main_chat.get_usage.request",
  "main_chat.reset_usage.request",
  "main_chat.memory_list.request",
  "main_chat.memory_read.request",
  "main_chat.memory_write.request",
  "main_chat.memory_delete.request",
  "main_chat.routines_list.request",
  "main_chat.routines_create.request",
  "main_chat.routines_pause.request",
  "main_chat.routines_resume.request",
  "main_chat.routines_run_once.request",
  "main_chat.routines_delete.request",
  "main_chat.list_settings_proposals.request",
  "main_chat.resolve_settings_proposal.request",
  "main_chat.lessons_list.request",
  "main_chat.lessons_add.request",
  "main_chat.lessons_delete.request",
  "main_chat.start_ready_task.request",
  "main_chat.update_task_dependencies.request",
  "main_chat.switch_model_profile.request",
  "main_chat.retry_task_with_fallback.request",
  "main_chat.list_notification_receipts.request",
  "main_chat.ack_notification_receipt.request",
  "main_chat.get_resource_admission.request",
  "main_chat.drain_admission_queue.request",
  "main_chat.sweep_idle_subagents.request",
  "main_chat.list_prompt_library.request",
  "main_chat.save_prompt_template.request",
  "main_chat.delete_prompt_template.request",
  "main_chat.feishu_bridge_get_state.request",
  "main_chat.feishu_bridge_update_config.request",
  "main_chat.feishu_bridge_test_connection.request",
  "main_chat.feishu_bridge_send_test_card.request",
  "main_chat.feishu_bridge_list_audit.request",
]);

export function isMainChatSessionMessage(
  msg: SessionInboundMessage,
): msg is MainChatSessionMessage {
  return MAIN_CHAT_SESSION_MESSAGE_TYPES.has(msg.type);
}

type SendFn = (response: SessionOutboundMessage) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type UnconfiguredResponseBuilderMap = {
  [K in MainChatSessionMessage["type"]]: (
    msg: Extract<MainChatSessionMessage, { type: K }>,
    error: string,
  ) => SessionOutboundMessage;
};

const UNCONFIGURED_RESPONSES: UnconfiguredResponseBuilderMap = {
  "main_chat.ensure.request": (msg, error) => ({
    type: "main_chat.ensure.response",
    payload: {
      requestId: msg.requestId,
      agentId: null,
      workspaceId: null,
      created: false,
      error,
    },
  }),
  "main_chat.list_plans.request": (msg, error) => ({
    type: "main_chat.list_plans.response",
    payload: { requestId: msg.requestId, plans: [], error },
  }),
  "main_chat.start_plan.request": (msg, error) => ({
    type: "main_chat.start_plan.response",
    payload: { requestId: msg.requestId, plan: null, error },
  }),
  "main_chat.cancel_plan.request": (msg, error) => ({
    type: "main_chat.cancel_plan.response",
    payload: { requestId: msg.requestId, plan: null, error },
  }),
  "main_chat.get_overview.request": (msg, error) => ({
    type: "main_chat.get_overview.response",
    payload: { requestId: msg.requestId, overview: null, error },
  }),
  "main_chat.answer_decision.request": (msg, error) => ({
    type: "main_chat.answer_decision.response",
    payload: { requestId: msg.requestId, decision: null, error },
  }),
  "main_chat.add_permission_rule.request": (msg, error) => ({
    type: "main_chat.add_permission_rule.response",
    payload: { requestId: msg.requestId, rule: null, error },
  }),
  "main_chat.remove_rule.request": (msg, error) => ({
    type: "main_chat.remove_rule.response",
    payload: { requestId: msg.requestId, removed: false, error },
  }),
  "main_chat.get_settings.request": (msg, error) => ({
    type: "main_chat.get_settings.response",
    payload: { requestId: msg.requestId, settings: null, error },
  }),
  "main_chat.update_settings.request": (msg, error) => ({
    type: "main_chat.update_settings.response",
    payload: { requestId: msg.requestId, settings: null, error },
  }),
  "main_chat.trigger_patrol.request": (msg, error) => ({
    type: "main_chat.trigger_patrol.response",
    payload: { requestId: msg.requestId, result: null, error },
  }),
  "main_chat.compact.request": (msg, error) => ({
    type: "main_chat.compact.response",
    payload: {
      requestId: msg.requestId,
      mainAgentId: msg.mainAgentId ?? null,
      compaction: null,
      error,
    },
  }),
  "main_chat.clear.request": (msg, error) => ({
    type: "main_chat.clear.response",
    payload: {
      requestId: msg.requestId,
      previousAgentId: null,
      agentId: null,
      workspaceId: null,
      migratedPlans: 0,
      migratedDecisions: 0,
      migratedChildAgents: 0,
      error,
    },
  }),
  "main_chat.new_session.request": (msg, error) => ({
    type: "main_chat.new_session.response",
    payload: {
      requestId: msg.requestId,
      previousAgentId: null,
      agentId: null,
      workspaceId: null,
      handoffSummary: null,
      migratedPlans: 0,
      migratedDecisions: 0,
      migratedChildAgents: 0,
      error,
    },
  }),
  "main_chat.list_activity.request": (msg, error) => ({
    type: "main_chat.list_activity.response",
    payload: {
      requestId: msg.requestId,
      activities: [],
      total: 0,
      error,
    },
  }),
  "main_chat.update_plan_task.request": (msg, error) => ({
    type: "main_chat.update_plan_task.response",
    payload: { requestId: msg.requestId, plan: null, error },
  }),
  "main_chat.withdraw_plan.request": (msg, error) => ({
    type: "main_chat.withdraw_plan.response",
    payload: { requestId: msg.requestId, plan: null, error },
  }),
  "main_chat.list_tasks.request": (msg, error) => ({
    type: "main_chat.list_tasks.response",
    payload: { requestId: msg.requestId, tasks: [], error },
  }),
  "main_chat.update_task_scope.request": (msg, error) => ({
    type: "main_chat.update_task_scope.response",
    payload: { requestId: msg.requestId, task: null, error },
  }),
  "main_chat.park_task.request": (msg, error) => ({
    type: "main_chat.park_task.response",
    payload: { requestId: msg.requestId, task: null, error },
  }),
  "main_chat.review_task.request": (msg, error) => ({
    type: "main_chat.review_task.response",
    payload: { requestId: msg.requestId, task: null, receipt: null, rework: null, error },
  }),
  "main_chat.list_conversations.request": (msg, error) => ({
    type: "main_chat.list_conversations.response",
    payload: { requestId: msg.requestId, conversations: [], error },
  }),
  "main_chat.create_conversation.request": (msg, error) => ({
    type: "main_chat.create_conversation.response",
    payload: { requestId: msg.requestId, conversation: null, error },
  }),
  "main_chat.update_conversation.request": (msg, error) => ({
    type: "main_chat.update_conversation.response",
    payload: { requestId: msg.requestId, conversation: null, error },
  }),
  "main_chat.get_fleet_hosts.request": (msg, error) => ({
    type: "main_chat.get_fleet_hosts.response",
    payload: { requestId: msg.requestId, localServerId: null, hosts: [], error },
  }),
  "main_chat.clarify_permission.request": (msg, error) => ({
    type: "main_chat.clarify_permission.response",
    payload: { requestId: msg.requestId, clarification: null, error },
  }),
  "main_chat.list_standing_authorizations.request": (msg, error) => ({
    type: "main_chat.list_standing_authorizations.response",
    payload: { requestId: msg.requestId, authorizations: [], suggestions: [], error },
  }),
  "main_chat.grant_standing_authorization.request": (msg, error) => ({
    type: "main_chat.grant_standing_authorization.response",
    payload: { requestId: msg.requestId, authorization: null, error },
  }),
  "main_chat.revoke_standing_authorization.request": (msg, error) => ({
    type: "main_chat.revoke_standing_authorization.response",
    payload: { requestId: msg.requestId, revoked: false, authorization: null, error },
  }),
  "main_chat.dismiss_rule_suggestion.request": (msg, error) => ({
    type: "main_chat.dismiss_rule_suggestion.response",
    payload: { requestId: msg.requestId, dismissed: false, error },
  }),
  "main_chat.get_usage.request": (msg, error) => ({
    type: "main_chat.get_usage.response",
    payload: { requestId: msg.requestId, usage: null, nightModeStatus: null, error },
  }),
  "main_chat.reset_usage.request": (msg, error) => ({
    type: "main_chat.reset_usage.response",
    payload: { requestId: msg.requestId, usage: null, error },
  }),
  "main_chat.memory_list.request": (msg, error) => ({
    type: "main_chat.memory_list.response",
    payload: { requestId: msg.requestId, files: [], error },
  }),
  "main_chat.memory_read.request": (msg, error) => ({
    type: "main_chat.memory_read.response",
    payload: { requestId: msg.requestId, file: null, error },
  }),
  "main_chat.memory_write.request": (msg, error) => ({
    type: "main_chat.memory_write.response",
    payload: { requestId: msg.requestId, file: null, error },
  }),
  "main_chat.memory_delete.request": (msg, error) => ({
    type: "main_chat.memory_delete.response",
    payload: { requestId: msg.requestId, deleted: false, error },
  }),
  "main_chat.routines_list.request": (msg, error) => ({
    type: "main_chat.routines_list.response",
    payload: { requestId: msg.requestId, routines: [], error },
  }),
  "main_chat.routines_create.request": (msg, error) => ({
    type: "main_chat.routines_create.response",
    payload: { requestId: msg.requestId, routine: null, error },
  }),
  "main_chat.routines_pause.request": (msg, error) => ({
    type: "main_chat.routines_pause.response",
    payload: { requestId: msg.requestId, routine: null, error },
  }),
  "main_chat.routines_resume.request": (msg, error) => ({
    type: "main_chat.routines_resume.response",
    payload: { requestId: msg.requestId, routine: null, error },
  }),
  "main_chat.routines_run_once.request": (msg, error) => ({
    type: "main_chat.routines_run_once.response",
    payload: { requestId: msg.requestId, routine: null, error },
  }),
  "main_chat.routines_delete.request": (msg, error) => ({
    type: "main_chat.routines_delete.response",
    payload: { requestId: msg.requestId, routineId: msg.routineId, deleted: false, error },
  }),
  "main_chat.list_settings_proposals.request": (msg, error) => ({
    type: "main_chat.list_settings_proposals.response",
    payload: { requestId: msg.requestId, proposals: [], error },
  }),
  "main_chat.resolve_settings_proposal.request": (msg, error) => ({
    type: "main_chat.resolve_settings_proposal.response",
    payload: { requestId: msg.requestId, proposal: null, settings: null, error },
  }),
  "main_chat.lessons_list.request": (msg, error) => ({
    type: "main_chat.lessons_list.response",
    payload: { requestId: msg.requestId, groups: [], lessons: [], error },
  }),
  "main_chat.lessons_add.request": (msg, error) => ({
    type: "main_chat.lessons_add.response",
    payload: { requestId: msg.requestId, lesson: null, deduplicated: false, error },
  }),
  "main_chat.lessons_delete.request": (msg, error) => ({
    type: "main_chat.lessons_delete.response",
    payload: { requestId: msg.requestId, lessonId: msg.lessonId, deleted: false, error },
  }),
  "main_chat.start_ready_task.request": (msg, error) => ({
    type: "main_chat.start_ready_task.response",
    payload: { requestId: msg.requestId, task: null, plan: null, error },
  }),
  "main_chat.update_task_dependencies.request": (msg, error) => ({
    type: "main_chat.update_task_dependencies.response",
    payload: { requestId: msg.requestId, task: null, error },
  }),
  "main_chat.switch_model_profile.request": (msg, error) => ({
    type: "main_chat.switch_model_profile.response",
    payload: {
      requestId: msg.requestId,
      settings: null,
      activeProfileId: null,
      changedSlots: [],
      event: null,
      error,
    },
  }),
  "main_chat.retry_task_with_fallback.request": (msg, error) => ({
    type: "main_chat.retry_task_with_fallback.response",
    payload: {
      requestId: msg.requestId,
      task: null,
      previousAgentId: null,
      newAgentId: null,
      fromModelSpec: null,
      toModelSpec: null,
      fallbackEvent: null,
      error,
    },
  }),
  "main_chat.list_notification_receipts.request": (msg, error) => ({
    type: "main_chat.list_notification_receipts.response",
    payload: {
      requestId: msg.requestId,
      receipts: [],
      summary: EMPTY_NOTIFICATION_SUMMARY,
      error,
    },
  }),
  "main_chat.ack_notification_receipt.request": (msg, error) => ({
    type: "main_chat.ack_notification_receipt.response",
    payload: {
      requestId: msg.requestId,
      updatedCount: 0,
      receipts: [],
      summary: EMPTY_NOTIFICATION_SUMMARY,
      error,
    },
  }),
  "main_chat.get_resource_admission.request": (msg, error) => ({
    type: "main_chat.get_resource_admission.response",
    payload: {
      requestId: msg.requestId,
      snapshot: null,
      error,
    },
  }),
  "main_chat.drain_admission_queue.request": (msg, error) => ({
    type: "main_chat.drain_admission_queue.response",
    payload: {
      requestId: msg.requestId,
      action: msg.action ?? "drain",
      dispatchedCount: 0,
      removedCount: 0,
      remainingCount: 0,
      snapshot: null,
      error,
    },
  }),
  "main_chat.sweep_idle_subagents.request": (msg, error) => ({
    type: "main_chat.sweep_idle_subagents.response",
    payload: {
      requestId: msg.requestId,
      result: null,
      error,
    },
  }),
  "main_chat.list_prompt_library.request": (msg, error) => ({
    type: "main_chat.list_prompt_library.response",
    payload: {
      requestId: msg.requestId,
      templates: [],
      builtinCount: 0,
      customCount: 0,
      error,
    },
  }),
  "main_chat.save_prompt_template.request": (msg, error) => ({
    type: "main_chat.save_prompt_template.response",
    payload: {
      requestId: msg.requestId,
      template: null,
      templates: [],
      error,
    },
  }),
  "main_chat.delete_prompt_template.request": (msg, error) => ({
    type: "main_chat.delete_prompt_template.response",
    payload: {
      requestId: msg.requestId,
      deleted: false,
      templates: [],
      error,
    },
  }),
  "main_chat.feishu_bridge_get_state.request": (msg, error) => ({
    type: "main_chat.feishu_bridge_get_state.response",
    payload: {
      requestId: msg.requestId,
      state: createUnavailableFeishuBridgeState(null),
      error,
    },
  }),
  "main_chat.feishu_bridge_update_config.request": (msg, error) => ({
    type: "main_chat.feishu_bridge_update_config.response",
    payload: {
      requestId: msg.requestId,
      state: null,
      error,
    },
  }),
  "main_chat.feishu_bridge_test_connection.request": (msg, error) => ({
    type: "main_chat.feishu_bridge_test_connection.response",
    payload: {
      requestId: msg.requestId,
      result: {
        ok: false,
        latencyMs: 0,
        apiBaseUrl: "",
        statusCode: null,
        tokenExpiresInSec: null,
        errorCode: "service_unconfigured",
        message: error,
        troubleshootingHint: null,
        testedAt: new Date().toISOString(),
      },
      error,
    },
  }),
  "main_chat.feishu_bridge_send_test_card.request": (msg, error) => ({
    type: "main_chat.feishu_bridge_send_test_card.response",
    payload: {
      requestId: msg.requestId,
      result: {
        ok: false,
        latencyMs: 0,
        messageId: null,
        receiveId: "",
        receiveIdType: "chat_id",
        errorCode: "service_unconfigured",
        message: error,
        troubleshootingHint: null,
        sentAt: new Date().toISOString(),
      },
      error,
    },
  }),
  "main_chat.feishu_bridge_list_audit.request": (msg, error) => ({
    type: "main_chat.feishu_bridge_list_audit.response",
    payload: {
      requestId: msg.requestId,
      records: [],
      stats: createEmptyFeishuBridgeStats(),
      error,
    },
  }),
};

function sendUnconfiguredError(msg: MainChatSessionMessage, send: SendFn): void {
  const error = "Main chat service is not configured on this daemon";
  const builder = UNCONFIGURED_RESPONSES[msg.type] as (
    message: MainChatSessionMessage,
    err: string,
  ) => SessionOutboundMessage;
  send(builder(msg, error));
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

async function handleStewardConfigMessages(
  service: MainChatService,
  msg: Extract<
    MainChatSessionMessage,
    | { type: "main_chat.get_settings.request" }
    | { type: "main_chat.update_settings.request" }
    | { type: "main_chat.trigger_patrol.request" }
  >,
  send: SendFn,
): Promise<void> {
  if (msg.type === "main_chat.get_settings.request") {
    try {
      const settings = await service.getSettings();
      const nightModeStatus = service.getNightModeStatus();
      const cacheKeepaliveStatus = service.getCacheKeepaliveStatus();
      send({
        type: "main_chat.get_settings.response",
        payload: {
          requestId: msg.requestId,
          settings,
          nightModeStatus,
          cacheKeepaliveStatus,
          error: null,
        },
      });
    } catch (error) {
      send({
        type: "main_chat.get_settings.response",
        payload: { requestId: msg.requestId, settings: null, error: errorMessage(error) },
      });
    }
    return;
  }

  if (msg.type === "main_chat.update_settings.request") {
    try {
      const settings = await service.updateSettings(msg.patch);
      const nightModeStatus = service.getNightModeStatus();
      const cacheKeepaliveStatus = service.getCacheKeepaliveStatus();
      send({
        type: "main_chat.update_settings.response",
        payload: {
          requestId: msg.requestId,
          settings,
          nightModeStatus,
          cacheKeepaliveStatus,
          error: null,
        },
      });
    } catch (error) {
      send({
        type: "main_chat.update_settings.response",
        payload: { requestId: msg.requestId, settings: null, error: errorMessage(error) },
      });
    }
    return;
  }

  try {
    const result = await service.triggerPatrol({
      mainAgentId: msg.mainAgentId,
      forceWakeup: msg.forceWakeup ?? true,
    });
    send({
      type: "main_chat.trigger_patrol.response",
      payload: { requestId: msg.requestId, result, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.trigger_patrol.response",
      payload: { requestId: msg.requestId, result: null, error: errorMessage(error) },
    });
  }
}

async function handleLifecycleMessages(
  service: MainChatService,
  msg: Extract<
    MainChatSessionMessage,
    | { type: "main_chat.compact.request" }
    | { type: "main_chat.clear.request" }
    | { type: "main_chat.new_session.request" }
    | { type: "main_chat.list_activity.request" }
  >,
  send: SendFn,
): Promise<void> {
  if (msg.type === "main_chat.compact.request") {
    try {
      const result = await service.compactMainChat(msg.mainAgentId, {
        reason: msg.reason,
        instructions: msg.instructions,
      });
      send({
        type: "main_chat.compact.response",
        payload: {
          requestId: msg.requestId,
          mainAgentId: result.mainAgentId,
          compaction: result.compaction,
          error: null,
        },
      });
    } catch (error) {
      const compaction = await service.getCompactionState(msg.mainAgentId).catch(() => null);
      send({
        type: "main_chat.compact.response",
        payload: {
          requestId: msg.requestId,
          mainAgentId: msg.mainAgentId ?? null,
          compaction,
          error: errorMessage(error),
        },
      });
    }
    return;
  }

  if (msg.type === "main_chat.clear.request") {
    try {
      const result = await service.clearMainChatContext(msg.mainAgentId, {
        provider: msg.provider,
        model: msg.model,
        modeId: msg.modeId,
        thinkingOptionId: msg.thinkingOptionId,
      });
      send({
        type: "main_chat.clear.response",
        payload: {
          requestId: msg.requestId,
          previousAgentId: result.previousAgentId,
          agentId: result.agentId,
          workspaceId: result.workspaceId,
          migratedPlans: result.migratedPlans,
          migratedDecisions: result.migratedDecisions,
          migratedChildAgents: result.migratedChildAgents,
          error: null,
        },
      });
    } catch (error) {
      send({
        type: "main_chat.clear.response",
        payload: {
          requestId: msg.requestId,
          previousAgentId: null,
          agentId: null,
          workspaceId: null,
          migratedPlans: 0,
          migratedDecisions: 0,
          migratedChildAgents: 0,
          error: errorMessage(error),
        },
      });
    }
    return;
  }

  if (msg.type === "main_chat.new_session.request") {
    try {
      const result = await service.startNewMainChatSession(msg.mainAgentId, {
        carryHandoffSummary: msg.carryHandoffSummary,
        title: msg.title,
        provider: msg.provider,
        model: msg.model,
        modeId: msg.modeId,
        thinkingOptionId: msg.thinkingOptionId,
      });
      send({
        type: "main_chat.new_session.response",
        payload: {
          requestId: msg.requestId,
          previousAgentId: result.previousAgentId,
          agentId: result.agentId,
          workspaceId: result.workspaceId,
          handoffSummary: result.handoffSummary,
          migratedPlans: result.migratedPlans,
          migratedDecisions: result.migratedDecisions,
          migratedChildAgents: result.migratedChildAgents,
          error: null,
        },
      });
    } catch (error) {
      send({
        type: "main_chat.new_session.response",
        payload: {
          requestId: msg.requestId,
          previousAgentId: null,
          agentId: null,
          workspaceId: null,
          handoffSummary: null,
          migratedPlans: 0,
          migratedDecisions: 0,
          migratedChildAgents: 0,
          error: errorMessage(error),
        },
      });
    }
    return;
  }

  try {
    const result = await service.listActivity({
      mainAgentId: msg.mainAgentId,
      limit: msg.limit,
      includeSilent: msg.includeSilent,
      kind: msg.kind,
    });
    send({
      type: "main_chat.list_activity.response",
      payload: {
        requestId: msg.requestId,
        activities: result.activities,
        total: result.total,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.list_activity.response",
      payload: {
        requestId: msg.requestId,
        activities: [],
        total: 0,
        error: errorMessage(error),
      },
    });
  }
}

async function handleTaskLedgerMessages(
  service: MainChatService,
  msg: Extract<
    MainChatSessionMessage,
    | { type: "main_chat.update_plan_task.request" }
    | { type: "main_chat.withdraw_plan.request" }
    | { type: "main_chat.list_tasks.request" }
    | { type: "main_chat.update_task_scope.request" }
    | { type: "main_chat.park_task.request" }
    | { type: "main_chat.review_task.request" }
  >,
  send: SendFn,
): Promise<void> {
  const unsupported = "Task ledger operation is not enabled on this daemon";

  if (msg.type === "main_chat.update_plan_task.request") {
    if (!service.updatePlanTask) {
      send({
        type: "main_chat.update_plan_task.response",
        payload: { requestId: msg.requestId, plan: null, error: unsupported },
      });
      return;
    }
    try {
      const plan = await service.updatePlanTask(msg.planId, msg.taskId, msg.patch);
      send({
        type: "main_chat.update_plan_task.response",
        payload: { requestId: msg.requestId, plan, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.update_plan_task.response",
        payload: { requestId: msg.requestId, plan: null, error: errorMessage(error) },
      });
    }
    return;
  }

  if (msg.type === "main_chat.withdraw_plan.request") {
    if (!service.withdrawPlan) {
      send({
        type: "main_chat.withdraw_plan.response",
        payload: { requestId: msg.requestId, plan: null, error: unsupported },
      });
      return;
    }
    try {
      const plan = await service.withdrawPlan(msg.planId, msg.reason);
      send({
        type: "main_chat.withdraw_plan.response",
        payload: { requestId: msg.requestId, plan, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.withdraw_plan.response",
        payload: { requestId: msg.requestId, plan: null, error: errorMessage(error) },
      });
    }
    return;
  }

  if (msg.type === "main_chat.list_tasks.request") {
    if (!service.listTaskRecords) {
      send({
        type: "main_chat.list_tasks.response",
        payload: { requestId: msg.requestId, tasks: [], error: unsupported },
      });
      return;
    }
    try {
      const tasks = await service.listTaskRecords({
        mainAgentId: msg.mainAgentId,
        conversationId: msg.conversationId,
        includeCompleted: msg.includeCompleted,
      });
      send({
        type: "main_chat.list_tasks.response",
        payload: { requestId: msg.requestId, tasks, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.list_tasks.response",
        payload: { requestId: msg.requestId, tasks: [], error: errorMessage(error) },
      });
    }
    return;
  }

  if (msg.type === "main_chat.update_task_scope.request") {
    if (!service.updateTaskScope) {
      send({
        type: "main_chat.update_task_scope.response",
        payload: { requestId: msg.requestId, task: null, error: unsupported },
      });
      return;
    }
    try {
      const task = await service.updateTaskScope({
        taskId: msg.taskId,
        goal: msg.goal,
        doneWhen: msg.doneWhen,
        outOfBounds: msg.outOfBounds,
        reason: msg.reason,
      });
      send({
        type: "main_chat.update_task_scope.response",
        payload: { requestId: msg.requestId, task, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.update_task_scope.response",
        payload: { requestId: msg.requestId, task: null, error: errorMessage(error) },
      });
    }
    return;
  }

  if (msg.type === "main_chat.park_task.request") {
    if (!service.parkTask) {
      send({
        type: "main_chat.park_task.response",
        payload: { requestId: msg.requestId, task: null, error: unsupported },
      });
      return;
    }
    try {
      const task = await service.parkTask({
        taskId: msg.taskId,
        parked: msg.parked,
        reason: msg.reason,
      });
      send({
        type: "main_chat.park_task.response",
        payload: { requestId: msg.requestId, task, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.park_task.response",
        payload: { requestId: msg.requestId, task: null, error: errorMessage(error) },
      });
    }
    return;
  }

  if (!service.reviewTask) {
    send({
      type: "main_chat.review_task.response",
      payload: {
        requestId: msg.requestId,
        task: null,
        receipt: null,
        rework: null,
        error: unsupported,
      },
    });
    return;
  }
  try {
    const result = await service.reviewTask({
      taskId: msg.taskId,
      verdict: msg.verdict,
      summary: msg.summary,
      gaps: msg.gaps,
      checks: msg.checks,
      nextSteps: msg.nextSteps,
      note: msg.note,
      bypassDeliveryGate: msg.bypassDeliveryGate,
      bypassReason: msg.bypassReason,
    });
    send({
      type: "main_chat.review_task.response",
      payload: {
        requestId: msg.requestId,
        task: result.task,
        receipt: result.receipt,
        rework: result.rework,
        deliveryGateWarning: result.deliveryGateWarning ?? null,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.review_task.response",
      payload: {
        requestId: msg.requestId,
        task: null,
        receipt: null,
        rework: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleMultiConversationAndFleetMessages(
  service: MainChatService,
  msg: Extract<
    MainChatSessionMessage,
    | { type: "main_chat.list_conversations.request" }
    | { type: "main_chat.create_conversation.request" }
    | { type: "main_chat.update_conversation.request" }
    | { type: "main_chat.get_fleet_hosts.request" }
  >,
  send: SendFn,
): Promise<void> {
  const unsupported = "Multi-conversation/fleet operation is not enabled on this daemon";

  if (msg.type === "main_chat.list_conversations.request") {
    if (!service.listConversations) {
      send({
        type: "main_chat.list_conversations.response",
        payload: { requestId: msg.requestId, conversations: [], error: unsupported },
      });
      return;
    }
    try {
      const conversations = await service.listConversations({
        includeArchived: msg.includeArchived,
      });
      send({
        type: "main_chat.list_conversations.response",
        payload: { requestId: msg.requestId, conversations, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.list_conversations.response",
        payload: { requestId: msg.requestId, conversations: [], error: errorMessage(error) },
      });
    }
    return;
  }

  if (msg.type === "main_chat.create_conversation.request") {
    if (!service.createConversation) {
      send({
        type: "main_chat.create_conversation.response",
        payload: { requestId: msg.requestId, conversation: null, error: unsupported },
      });
      return;
    }
    try {
      const conversation = await service.createConversation({
        kind: msg.kind,
        title: msg.title,
        directionSummary: msg.directionSummary,
        notes: msg.notes,
        initialPrompt: msg.initialPrompt,
        provider: msg.provider,
        model: msg.model,
        modeId: msg.modeId,
        thinkingOptionId: msg.thinkingOptionId,
      });
      send({
        type: "main_chat.create_conversation.response",
        payload: { requestId: msg.requestId, conversation, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.create_conversation.response",
        payload: { requestId: msg.requestId, conversation: null, error: errorMessage(error) },
      });
    }
    return;
  }

  if (msg.type === "main_chat.update_conversation.request") {
    if (!service.updateConversation) {
      send({
        type: "main_chat.update_conversation.response",
        payload: { requestId: msg.requestId, conversation: null, error: unsupported },
      });
      return;
    }
    try {
      const conversation = await service.updateConversation({
        conversationId: msg.conversationId,
        title: msg.title,
        directionSummary: msg.directionSummary,
        notes: msg.notes,
        kind: msg.kind,
        archived: msg.archived,
      });
      send({
        type: "main_chat.update_conversation.response",
        payload: { requestId: msg.requestId, conversation, error: null },
      });
    } catch (error) {
      send({
        type: "main_chat.update_conversation.response",
        payload: { requestId: msg.requestId, conversation: null, error: errorMessage(error) },
      });
    }
    return;
  }

  if (!service.getFleetHosts) {
    send({
      type: "main_chat.get_fleet_hosts.response",
      payload: { requestId: msg.requestId, localServerId: null, hosts: [], error: unsupported },
    });
    return;
  }
  try {
    const result = await service.getFleetHosts({ forceRefresh: msg.forceRefresh });
    send({
      type: "main_chat.get_fleet_hosts.response",
      payload: {
        requestId: msg.requestId,
        localServerId: result.localServerId,
        hosts: result.hosts,
        ...(result.fleetScope ? { fleetScope: result.fleetScope } : {}),
        ...(result.availableRemoteHosts
          ? { availableRemoteHosts: result.availableRemoteHosts }
          : {}),
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.get_fleet_hosts.response",
      payload: {
        requestId: msg.requestId,
        localServerId: null,
        hosts: [],
        error: errorMessage(error),
      },
    });
  }
}

type SessionHandlerMap = {
  [K in MainChatSessionMessage["type"]]: (
    service: MainChatService,
    msg: Extract<MainChatSessionMessage, { type: K }>,
    send: SendFn,
  ) => Promise<void>;
};

async function handleClarifyPermission(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.clarify_permission.request" }>,
  send: SendFn,
): Promise<void> {
  if (!service.clarifyPermission) {
    send({
      type: "main_chat.clarify_permission.response",
      payload: {
        requestId: msg.requestId,
        clarification: null,
        error: "Permission clarification is not enabled on this daemon",
      },
    });
    return;
  }
  try {
    const clarification = await service.clarifyPermission({
      agentId: msg.agentId,
      serverId: msg.serverId,
      permissionRequestId: msg.permissionRequestId,
      question: msg.question,
    });
    send({
      type: "main_chat.clarify_permission.response",
      payload: { requestId: msg.requestId, clarification, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.clarify_permission.response",
      payload: { requestId: msg.requestId, clarification: null, error: errorMessage(error) },
    });
  }
}

async function handleListStandingAuthorizations(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.list_standing_authorizations.request" }>,
  send: SendFn,
): Promise<void> {
  if (!service.listStandingAuthorizations) {
    send({
      type: "main_chat.list_standing_authorizations.response",
      payload: {
        requestId: msg.requestId,
        authorizations: [],
        suggestions: [],
        error: "Standing authorizations are not enabled on this daemon",
      },
    });
    return;
  }
  try {
    const result = await service.listStandingAuthorizations({
      includeRevoked: msg.includeRevoked,
    });
    send({
      type: "main_chat.list_standing_authorizations.response",
      payload: {
        requestId: msg.requestId,
        authorizations: result.authorizations,
        suggestions: result.suggestions,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.list_standing_authorizations.response",
      payload: {
        requestId: msg.requestId,
        authorizations: [],
        suggestions: [],
        error: errorMessage(error),
      },
    });
  }
}

async function handleGrantStandingAuthorization(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.grant_standing_authorization.request" }>,
  send: SendFn,
): Promise<void> {
  if (!service.grantStandingAuthorization) {
    send({
      type: "main_chat.grant_standing_authorization.response",
      payload: {
        requestId: msg.requestId,
        authorization: null,
        error: "Standing authorizations are not enabled on this daemon",
      },
    });
    return;
  }
  try {
    const authorization = await service.grantStandingAuthorization({
      scope: msg.scope,
      serverId: msg.serverId,
      cwd: msg.cwd,
      allowSubdirectories: msg.allowSubdirectories,
      toolName: msg.toolName,
      commandPrefix: msg.commandPrefix,
      mode: msg.mode,
      label: msg.label,
      reason: msg.reason,
      suggestionId: msg.suggestionId,
      expiresAt: msg.expiresAt,
    });
    send({
      type: "main_chat.grant_standing_authorization.response",
      payload: { requestId: msg.requestId, authorization, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.grant_standing_authorization.response",
      payload: { requestId: msg.requestId, authorization: null, error: errorMessage(error) },
    });
  }
}

async function handleRevokeStandingAuthorization(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.revoke_standing_authorization.request" }>,
  send: SendFn,
): Promise<void> {
  if (!service.revokeStandingAuthorization) {
    send({
      type: "main_chat.revoke_standing_authorization.response",
      payload: {
        requestId: msg.requestId,
        revoked: false,
        authorization: null,
        error: "Standing authorizations are not enabled on this daemon",
      },
    });
    return;
  }
  try {
    const result = await service.revokeStandingAuthorization(msg.authorizationId);
    send({
      type: "main_chat.revoke_standing_authorization.response",
      payload: {
        requestId: msg.requestId,
        revoked: result.revoked,
        authorization: result.authorization,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.revoke_standing_authorization.response",
      payload: {
        requestId: msg.requestId,
        revoked: false,
        authorization: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleDismissRuleSuggestion(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.dismiss_rule_suggestion.request" }>,
  send: SendFn,
): Promise<void> {
  if (!service.dismissRuleSuggestion) {
    send({
      type: "main_chat.dismiss_rule_suggestion.response",
      payload: {
        requestId: msg.requestId,
        dismissed: false,
        error: "Standing authorizations are not enabled on this daemon",
      },
    });
    return;
  }
  try {
    const dismissed = await service.dismissRuleSuggestion(msg.suggestionId);
    send({
      type: "main_chat.dismiss_rule_suggestion.response",
      payload: { requestId: msg.requestId, dismissed, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.dismiss_rule_suggestion.response",
      payload: { requestId: msg.requestId, dismissed: false, error: errorMessage(error) },
    });
  }
}

async function handleGetUsage(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.get_usage.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const usage = await service.getTokenUsage();
    const nightModeStatus = service.getNightModeStatus();
    send({
      type: "main_chat.get_usage.response",
      payload: { requestId: msg.requestId, usage, nightModeStatus, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.get_usage.response",
      payload: {
        requestId: msg.requestId,
        usage: null,
        nightModeStatus: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleResetUsage(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.reset_usage.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const usage = await service.resetTokenUsage();
    send({
      type: "main_chat.reset_usage.response",
      payload: { requestId: msg.requestId, usage, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.reset_usage.response",
      payload: { requestId: msg.requestId, usage: null, error: errorMessage(error) },
    });
  }
}

async function handleMemoryList(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.memory_list.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const files = await service.listMemoryFiles();
    send({
      type: "main_chat.memory_list.response",
      payload: { requestId: msg.requestId, files, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.memory_list.response",
      payload: { requestId: msg.requestId, files: [], error: errorMessage(error) },
    });
  }
}

async function handleMemoryRead(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.memory_read.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const file = await service.readMemoryFile(msg.path);
    send({
      type: "main_chat.memory_read.response",
      payload: { requestId: msg.requestId, file, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.memory_read.response",
      payload: { requestId: msg.requestId, file: null, error: errorMessage(error) },
    });
  }
}

async function handleMemoryWrite(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.memory_write.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const file = await service.writeMemoryFile(msg.path, msg.content);
    send({
      type: "main_chat.memory_write.response",
      payload: { requestId: msg.requestId, file, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.memory_write.response",
      payload: { requestId: msg.requestId, file: null, error: errorMessage(error) },
    });
  }
}

async function handleMemoryDelete(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.memory_delete.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.deleteMemoryFile(msg.path);
    send({
      type: "main_chat.memory_delete.response",
      payload: { requestId: msg.requestId, deleted: result.deleted, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.memory_delete.response",
      payload: { requestId: msg.requestId, deleted: false, error: errorMessage(error) },
    });
  }
}

async function handleRoutinesList(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.routines_list.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const routines = await service.listRoutines({
      conversationId: msg.conversationId,
      includeCompleted: msg.includeCompleted,
    });
    send({
      type: "main_chat.routines_list.response",
      payload: { requestId: msg.requestId, routines, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.routines_list.response",
      payload: { requestId: msg.requestId, routines: [], error: errorMessage(error) },
    });
  }
}

async function handleRoutinesCreate(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.routines_create.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const routine = await service.createRoutine({
      name: msg.name,
      prompt: msg.prompt,
      kind: msg.kind,
      cadence: msg.cadence,
      runAt: msg.runAt,
      delayMinutes: msg.delayMinutes,
      conversationId: msg.conversationId,
      maxRuns: msg.maxRuns,
      expiresAt: msg.expiresAt,
      runOnCreate: msg.runOnCreate,
    });
    send({
      type: "main_chat.routines_create.response",
      payload: { requestId: msg.requestId, routine, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.routines_create.response",
      payload: { requestId: msg.requestId, routine: null, error: errorMessage(error) },
    });
  }
}

async function handleRoutinesPause(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.routines_pause.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const routine = await service.pauseRoutine(msg.routineId);
    send({
      type: "main_chat.routines_pause.response",
      payload: { requestId: msg.requestId, routine, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.routines_pause.response",
      payload: { requestId: msg.requestId, routine: null, error: errorMessage(error) },
    });
  }
}

async function handleRoutinesResume(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.routines_resume.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const routine = await service.resumeRoutine(msg.routineId);
    send({
      type: "main_chat.routines_resume.response",
      payload: { requestId: msg.requestId, routine, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.routines_resume.response",
      payload: { requestId: msg.requestId, routine: null, error: errorMessage(error) },
    });
  }
}

async function handleRoutinesRunOnce(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.routines_run_once.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const routine = await service.runRoutineOnce(msg.routineId);
    send({
      type: "main_chat.routines_run_once.response",
      payload: { requestId: msg.requestId, routine, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.routines_run_once.response",
      payload: { requestId: msg.requestId, routine: null, error: errorMessage(error) },
    });
  }
}

async function handleRoutinesDelete(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.routines_delete.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.deleteRoutine(msg.routineId);
    send({
      type: "main_chat.routines_delete.response",
      payload: {
        requestId: msg.requestId,
        routineId: msg.routineId,
        deleted: result.deleted,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.routines_delete.response",
      payload: {
        requestId: msg.requestId,
        routineId: msg.routineId,
        deleted: false,
        error: errorMessage(error),
      },
    });
  }
}

async function handleListSettingsProposals(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.list_settings_proposals.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const proposals = await service.listSettingsProposals({
      mainAgentId: msg.mainAgentId,
      includeResolved: msg.includeResolved,
    });
    send({
      type: "main_chat.list_settings_proposals.response",
      payload: { requestId: msg.requestId, proposals, error: null },
    });
  } catch (error) {
    send({
      type: "main_chat.list_settings_proposals.response",
      payload: { requestId: msg.requestId, proposals: [], error: errorMessage(error) },
    });
  }
}

async function handleResolveSettingsProposal(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.resolve_settings_proposal.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.resolveSettingsProposal({
      proposalId: msg.proposalId,
      decision: msg.decision,
      note: msg.note,
    });
    send({
      type: "main_chat.resolve_settings_proposal.response",
      payload: {
        requestId: msg.requestId,
        proposal: result.proposal,
        settings: result.settings,
        nightModeStatus: result.nightModeStatus,
        cacheKeepaliveStatus: result.cacheKeepaliveStatus,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.resolve_settings_proposal.response",
      payload: {
        requestId: msg.requestId,
        proposal: null,
        settings: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleLessonsList(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.lessons_list.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.listLessons({ projectKey: msg.projectKey });
    send({
      type: "main_chat.lessons_list.response",
      payload: {
        requestId: msg.requestId,
        groups: result.groups,
        lessons: result.lessons,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.lessons_list.response",
      payload: { requestId: msg.requestId, groups: [], lessons: [], error: errorMessage(error) },
    });
  }
}

async function handleLessonsAdd(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.lessons_add.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.addLesson({
      projectKey: msg.projectKey,
      projectLabel: msg.projectLabel,
      kind: msg.kind,
      text: msg.text,
      origin: "manual",
      taskId: msg.taskId,
    });
    send({
      type: "main_chat.lessons_add.response",
      payload: {
        requestId: msg.requestId,
        lesson: result.lesson,
        deduplicated: result.deduplicated,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.lessons_add.response",
      payload: {
        requestId: msg.requestId,
        lesson: null,
        deduplicated: false,
        error: errorMessage(error),
      },
    });
  }
}

async function handleLessonsDelete(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.lessons_delete.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.deleteLesson(msg.lessonId);
    send({
      type: "main_chat.lessons_delete.response",
      payload: {
        requestId: msg.requestId,
        lessonId: msg.lessonId,
        deleted: result.deleted,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.lessons_delete.response",
      payload: {
        requestId: msg.requestId,
        lessonId: msg.lessonId,
        deleted: false,
        error: errorMessage(error),
      },
    });
  }
}

async function handleStartReadyTask(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.start_ready_task.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.startReadyTask(msg.taskId);
    send({
      type: "main_chat.start_ready_task.response",
      payload: {
        requestId: msg.requestId,
        task: result.task,
        plan: result.plan,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.start_ready_task.response",
      payload: {
        requestId: msg.requestId,
        task: null,
        plan: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleUpdateTaskDependencies(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.update_task_dependencies.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const task = await service.updateTaskDependencies({
      taskId: msg.taskId,
      partOf: msg.partOf,
      after: msg.after,
      autoStartOnReady: msg.autoStartOnReady,
    });
    send({
      type: "main_chat.update_task_dependencies.response",
      payload: {
        requestId: msg.requestId,
        task,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.update_task_dependencies.response",
      payload: {
        requestId: msg.requestId,
        task: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleSwitchModelProfile(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.switch_model_profile.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.switchModelProfile({
      profileId: msg.profileId,
      rollback: msg.rollback,
      actor: "user",
    });
    send({
      type: "main_chat.switch_model_profile.response",
      payload: {
        requestId: msg.requestId,
        settings: result.settings,
        activeProfileId: result.activeProfileId,
        changedSlots: result.changedSlots,
        event: result.event,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.switch_model_profile.response",
      payload: {
        requestId: msg.requestId,
        settings: null,
        activeProfileId: null,
        changedSlots: [],
        event: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleRetryTaskWithFallback(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.retry_task_with_fallback.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.retryTaskWithFallback({
      taskId: msg.taskId,
      provider: msg.provider,
      model: msg.model,
      thinkingOptionId: msg.thinkingOptionId,
      reason: msg.reason,
    });
    send({
      type: "main_chat.retry_task_with_fallback.response",
      payload: {
        requestId: msg.requestId,
        task: result.task,
        previousAgentId: result.previousAgentId,
        newAgentId: result.newAgentId,
        fromModelSpec: result.fromModelSpec,
        toModelSpec: result.toModelSpec,
        fallbackEvent: result.fallbackEvent,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.retry_task_with_fallback.response",
      payload: {
        requestId: msg.requestId,
        task: null,
        previousAgentId: null,
        newAgentId: null,
        fromModelSpec: null,
        toModelSpec: null,
        fallbackEvent: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleListNotificationReceipts(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.list_notification_receipts.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.listNotificationReceipts({
      status: msg.status,
      category: msg.category,
      unreadOnly: msg.unreadOnly,
      limit: msg.limit,
    });
    send({
      type: "main_chat.list_notification_receipts.response",
      payload: {
        requestId: msg.requestId,
        receipts: result.receipts,
        summary: result.summary,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.list_notification_receipts.response",
      payload: {
        requestId: msg.requestId,
        receipts: [],
        summary: EMPTY_NOTIFICATION_SUMMARY,
        error: errorMessage(error),
      },
    });
  }
}

async function handleAckNotificationReceipt(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.ack_notification_receipt.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.ackNotificationReceipt({
      receiptId: msg.receiptId,
      receiptIds: msg.receiptIds,
      markAll: msg.markAll,
      status: msg.status,
    });
    send({
      type: "main_chat.ack_notification_receipt.response",
      payload: {
        requestId: msg.requestId,
        updatedCount: result.updatedCount,
        receipts: result.receipts,
        summary: result.summary,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.ack_notification_receipt.response",
      payload: {
        requestId: msg.requestId,
        updatedCount: 0,
        receipts: [],
        summary: EMPTY_NOTIFICATION_SUMMARY,
        error: errorMessage(error),
      },
    });
  }
}

async function handleGetResourceAdmission(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.get_resource_admission.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const snapshot = await service.getResourceAdmission({ forceRefresh: msg.forceRefresh });
    send({
      type: "main_chat.get_resource_admission.response",
      payload: {
        requestId: msg.requestId,
        snapshot,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.get_resource_admission.response",
      payload: {
        requestId: msg.requestId,
        snapshot: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleDrainAdmissionQueue(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.drain_admission_queue.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.drainAdmissionQueue({
      action: msg.action,
      queueId: msg.queueId,
      serverId: msg.serverId,
    });
    send({
      type: "main_chat.drain_admission_queue.response",
      payload: {
        requestId: msg.requestId,
        action: result.action,
        dispatchedCount: result.dispatchedCount,
        removedCount: result.removedCount,
        remainingCount: result.remainingCount,
        snapshot: result.snapshot,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.drain_admission_queue.response",
      payload: {
        requestId: msg.requestId,
        action: msg.action ?? "drain",
        dispatchedCount: 0,
        removedCount: 0,
        remainingCount: 0,
        snapshot: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleSweepIdleSubagents(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.sweep_idle_subagents.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.sweepIdleSubagents({
      dryRun: msg.dryRun,
      idleThresholdMinutes: msg.idleThresholdMinutes,
      limit: msg.limit,
      trigger: "manual",
    });
    send({
      type: "main_chat.sweep_idle_subagents.response",
      payload: {
        requestId: msg.requestId,
        result,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.sweep_idle_subagents.response",
      payload: {
        requestId: msg.requestId,
        result: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleListPromptLibrary(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.list_prompt_library.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.listPromptLibrary();
    send({
      type: "main_chat.list_prompt_library.response",
      payload: {
        requestId: msg.requestId,
        templates: result.templates,
        builtinCount: result.builtinCount,
        customCount: result.customCount,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.list_prompt_library.response",
      payload: {
        requestId: msg.requestId,
        templates: [],
        builtinCount: 0,
        customCount: 0,
        error: errorMessage(error),
      },
    });
  }
}

async function handleSavePromptTemplate(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.save_prompt_template.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.savePromptTemplate(msg.template);
    send({
      type: "main_chat.save_prompt_template.response",
      payload: {
        requestId: msg.requestId,
        template: result.template,
        templates: result.templates,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.save_prompt_template.response",
      payload: {
        requestId: msg.requestId,
        template: null,
        templates: [],
        error: errorMessage(error),
      },
    });
  }
}

async function handleDeletePromptTemplate(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.delete_prompt_template.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.deletePromptTemplate({
      id: msg.id,
      slug: msg.slug,
    });
    send({
      type: "main_chat.delete_prompt_template.response",
      payload: {
        requestId: msg.requestId,
        deleted: result.deleted,
        templates: result.templates,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.delete_prompt_template.response",
      payload: {
        requestId: msg.requestId,
        deleted: false,
        templates: [],
        error: errorMessage(error),
      },
    });
  }
}

async function handleFeishuBridgeGetState(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.feishu_bridge_get_state.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const state = await service.getFeishuBridgeState({ auditLimit: msg.auditLimit });
    send({
      type: "main_chat.feishu_bridge_get_state.response",
      payload: {
        requestId: msg.requestId,
        state,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.feishu_bridge_get_state.response",
      payload: {
        requestId: msg.requestId,
        state: createUnavailableFeishuBridgeState(null),
        error: errorMessage(error),
      },
    });
  }
}

async function handleFeishuBridgeUpdateConfig(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.feishu_bridge_update_config.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const state = await service.updateFeishuBridgeConfig(msg.patch);
    send({
      type: "main_chat.feishu_bridge_update_config.response",
      payload: {
        requestId: msg.requestId,
        state,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.feishu_bridge_update_config.response",
      payload: {
        requestId: msg.requestId,
        state: null,
        error: errorMessage(error),
      },
    });
  }
}

async function handleFeishuBridgeTestConnection(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.feishu_bridge_test_connection.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.testFeishuBridgeConnection({
      forceRefreshToken: msg.forceRefreshToken,
    });
    send({
      type: "main_chat.feishu_bridge_test_connection.response",
      payload: {
        requestId: msg.requestId,
        result,
        error: null,
      },
    });
  } catch (error) {
    const errText = errorMessage(error);
    send({
      type: "main_chat.feishu_bridge_test_connection.response",
      payload: {
        requestId: msg.requestId,
        result: {
          ok: false,
          latencyMs: 0,
          apiBaseUrl: "",
          statusCode: null,
          tokenExpiresInSec: null,
          errorCode: "test_connection_failed",
          message: errText,
          troubleshootingHint: null,
          testedAt: new Date().toISOString(),
        },
        error: errText,
      },
    });
  }
}

async function handleFeishuBridgeSendTestCard(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.feishu_bridge_send_test_card.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.sendFeishuBridgeTestCard({
      receiveId: msg.receiveId,
      receiveIdType: msg.receiveIdType,
      title: msg.title,
    });
    send({
      type: "main_chat.feishu_bridge_send_test_card.response",
      payload: {
        requestId: msg.requestId,
        result,
        error: null,
      },
    });
  } catch (error) {
    const errText = errorMessage(error);
    send({
      type: "main_chat.feishu_bridge_send_test_card.response",
      payload: {
        requestId: msg.requestId,
        result: {
          ok: false,
          latencyMs: 0,
          messageId: null,
          receiveId: msg.receiveId ?? "",
          receiveIdType: msg.receiveIdType ?? "chat_id",
          errorCode: "send_test_card_failed",
          message: errText,
          troubleshootingHint: null,
          sentAt: new Date().toISOString(),
        },
        error: errText,
      },
    });
  }
}

async function handleFeishuBridgeListAudit(
  service: MainChatService,
  msg: Extract<MainChatSessionMessage, { type: "main_chat.feishu_bridge_list_audit.request" }>,
  send: SendFn,
): Promise<void> {
  try {
    const result = await service.listFeishuBridgeAudit({
      limit: msg.limit,
      direction: msg.direction,
    });
    send({
      type: "main_chat.feishu_bridge_list_audit.response",
      payload: {
        requestId: msg.requestId,
        records: result.records,
        stats: result.stats,
        error: null,
      },
    });
  } catch (error) {
    send({
      type: "main_chat.feishu_bridge_list_audit.response",
      payload: {
        requestId: msg.requestId,
        records: [],
        stats: createEmptyFeishuBridgeStats(),
        error: errorMessage(error),
      },
    });
  }
}

const MAIN_CHAT_MESSAGE_HANDLERS: SessionHandlerMap = {
  "main_chat.ensure.request": handlePlanMessages,
  "main_chat.list_plans.request": handlePlanMessages,
  "main_chat.start_plan.request": handlePlanMessages,
  "main_chat.cancel_plan.request": handlePlanMessages,
  "main_chat.get_overview.request": handleGovernanceMessages,
  "main_chat.answer_decision.request": handleGovernanceMessages,
  "main_chat.add_permission_rule.request": handleGovernanceMessages,
  "main_chat.remove_rule.request": handleGovernanceMessages,
  "main_chat.get_settings.request": handleStewardConfigMessages,
  "main_chat.update_settings.request": handleStewardConfigMessages,
  "main_chat.trigger_patrol.request": handleStewardConfigMessages,
  "main_chat.compact.request": handleLifecycleMessages,
  "main_chat.clear.request": handleLifecycleMessages,
  "main_chat.new_session.request": handleLifecycleMessages,
  "main_chat.list_activity.request": handleLifecycleMessages,
  "main_chat.update_plan_task.request": handleTaskLedgerMessages,
  "main_chat.withdraw_plan.request": handleTaskLedgerMessages,
  "main_chat.list_tasks.request": handleTaskLedgerMessages,
  "main_chat.update_task_scope.request": handleTaskLedgerMessages,
  "main_chat.park_task.request": handleTaskLedgerMessages,
  "main_chat.review_task.request": handleTaskLedgerMessages,
  "main_chat.list_conversations.request": handleMultiConversationAndFleetMessages,
  "main_chat.create_conversation.request": handleMultiConversationAndFleetMessages,
  "main_chat.update_conversation.request": handleMultiConversationAndFleetMessages,
  "main_chat.get_fleet_hosts.request": handleMultiConversationAndFleetMessages,
  "main_chat.clarify_permission.request": handleClarifyPermission,
  "main_chat.list_standing_authorizations.request": handleListStandingAuthorizations,
  "main_chat.grant_standing_authorization.request": handleGrantStandingAuthorization,
  "main_chat.revoke_standing_authorization.request": handleRevokeStandingAuthorization,
  "main_chat.dismiss_rule_suggestion.request": handleDismissRuleSuggestion,
  "main_chat.get_usage.request": handleGetUsage,
  "main_chat.reset_usage.request": handleResetUsage,
  "main_chat.memory_list.request": handleMemoryList,
  "main_chat.memory_read.request": handleMemoryRead,
  "main_chat.memory_write.request": handleMemoryWrite,
  "main_chat.memory_delete.request": handleMemoryDelete,
  "main_chat.routines_list.request": handleRoutinesList,
  "main_chat.routines_create.request": handleRoutinesCreate,
  "main_chat.routines_pause.request": handleRoutinesPause,
  "main_chat.routines_resume.request": handleRoutinesResume,
  "main_chat.routines_run_once.request": handleRoutinesRunOnce,
  "main_chat.routines_delete.request": handleRoutinesDelete,
  "main_chat.list_settings_proposals.request": handleListSettingsProposals,
  "main_chat.resolve_settings_proposal.request": handleResolveSettingsProposal,
  "main_chat.lessons_list.request": handleLessonsList,
  "main_chat.lessons_add.request": handleLessonsAdd,
  "main_chat.lessons_delete.request": handleLessonsDelete,
  "main_chat.start_ready_task.request": handleStartReadyTask,
  "main_chat.update_task_dependencies.request": handleUpdateTaskDependencies,
  "main_chat.switch_model_profile.request": handleSwitchModelProfile,
  "main_chat.retry_task_with_fallback.request": handleRetryTaskWithFallback,
  "main_chat.list_notification_receipts.request": handleListNotificationReceipts,
  "main_chat.ack_notification_receipt.request": handleAckNotificationReceipt,
  "main_chat.get_resource_admission.request": handleGetResourceAdmission,
  "main_chat.drain_admission_queue.request": handleDrainAdmissionQueue,
  "main_chat.sweep_idle_subagents.request": handleSweepIdleSubagents,
  "main_chat.list_prompt_library.request": handleListPromptLibrary,
  "main_chat.save_prompt_template.request": handleSavePromptTemplate,
  "main_chat.delete_prompt_template.request": handleDeletePromptTemplate,
  "main_chat.feishu_bridge_get_state.request": handleFeishuBridgeGetState,
  "main_chat.feishu_bridge_update_config.request": handleFeishuBridgeUpdateConfig,
  "main_chat.feishu_bridge_test_connection.request": handleFeishuBridgeTestConnection,
  "main_chat.feishu_bridge_send_test_card.request": handleFeishuBridgeSendTestCard,
  "main_chat.feishu_bridge_list_audit.request": handleFeishuBridgeListAudit,
};

export async function handleMainChatSessionMessage(
  service: MainChatService | null,
  msg: MainChatSessionMessage,
  send: SendFn,
): Promise<void> {
  if (!service) {
    sendUnconfiguredError(msg, send);
    return;
  }

  const handler = MAIN_CHAT_MESSAGE_HANDLERS[msg.type] as (
    svc: MainChatService,
    message: MainChatSessionMessage,
    respond: SendFn,
  ) => Promise<void>;
  await handler(service, msg, send);
}
