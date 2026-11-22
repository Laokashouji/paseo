import {
  isTaskAskUserToolName,
  isTaskCompleteToolName,
  isTaskPlanToolName,
  isTaskReworkToolName,
} from "@getpaseo/protocol/main-chat";
import type { ReactElement } from "react";
import { MainChatDecisionCard } from "./decision-card";
import { MainChatPlanCard } from "./plan-card";
import { MainChatReceiptCard } from "./receipt-card";
import { MainChatReworkCard } from "./rework-card";

/**
 * Renders the appropriate native Main Chat inline card when a tool call belongs to the Main Chat
 * orchestration suite, or returns `null` to fall back to Paseo's standard `ToolCallSlot`.
 */
export function renderMainChatInlineToolCard(input: {
  serverId: string;
  agentId: string;
  toolName: string;
  toolStatus: string;
  toolInput: unknown;
  toolOutput: unknown;
  error?: unknown;
}): ReactElement | null {
  if (isTaskPlanToolName(input.toolName)) {
    return (
      <MainChatPlanCard
        serverId={input.serverId}
        agentId={input.agentId}
        toolStatus={input.toolStatus}
        output={input.toolOutput}
        error={input.error}
      />
    );
  }
  if (isTaskCompleteToolName(input.toolName)) {
    return (
      <MainChatReceiptCard
        serverId={input.serverId}
        input={input.toolInput}
        output={input.toolOutput}
      />
    );
  }
  if (isTaskReworkToolName(input.toolName)) {
    return (
      <MainChatReworkCard
        serverId={input.serverId}
        input={input.toolInput}
        output={input.toolOutput}
      />
    );
  }
  if (isTaskAskUserToolName(input.toolName)) {
    return (
      <MainChatDecisionCard
        serverId={input.serverId}
        agentId={input.agentId}
        output={input.toolOutput}
      />
    );
  }
  return null;
}
