import {
  isSettingsProposePatchToolName,
  isTaskAskUserToolName,
  isTaskCompleteToolName,
  isTaskPlanToolName,
  isTaskReworkToolName,
  normalizeMainChatToolName,
  parseTaskCompleteToolPayload,
  parseTaskReworkToolPayload,
  unwrapToolPayloadObject,
  type MainChatTaskMode,
} from "@getpaseo/protocol/main-chat";
import type { ReactElement } from "react";
import { MainChatDecisionCard } from "./decision-card";
import { MainChatHandoffCard } from "./handoff-card";
import { MainChatPlanCard } from "./plan-card";
import { MainChatReceiptCard } from "./receipt-card";
import { MainChatReworkCard } from "./rework-card";
import { MainChatSettingsProposalCard } from "./settings-proposal-card";

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function parseDirectSpawnHandoff(
  toolInput: unknown,
  toolOutput: unknown,
): {
  agentId: string;
  serverId?: string;
  workspaceId?: string | null;
  workspaceLabel?: string | null;
  hostLabel?: string | null;
  title: string;
  mode?: MainChatTaskMode | null;
  taskId?: string | null;
  continuesTaskId?: string | null;
} | null {
  const out = unwrapToolPayloadObject(toolOutput);
  if (!out) return null;
  const taskObj: Record<string, unknown> =
    typeof out.task === "object" && out.task !== null ? (out.task as Record<string, unknown>) : {};
  const agentId = firstNonEmptyString(out.agentId, taskObj.activeAgentId);
  if (!agentId) return null;

  const inp: Record<string, unknown> = unwrapToolPayloadObject(toolInput) ?? {};
  const title = firstNonEmptyString(taskObj.title, out.title, inp.title) ?? agentId;
  const rawMode = taskObj.mode ?? out.mode ?? inp.mode;
  const mode: MainChatTaskMode | null =
    rawMode === "readonly" || rawMode === "write" ? rawMode : null;
  const serverId = firstString(taskObj.serverId, out.serverId) ?? undefined;

  return {
    agentId,
    serverId,
    workspaceId: firstString(taskObj.workspaceId, out.workspaceId),
    workspaceLabel: firstString(taskObj.workspaceLabel, out.workspaceLabel),
    hostLabel: firstString(taskObj.hostLabel, out.hostLabel),
    title,
    mode,
    taskId: firstString(taskObj.id),
    continuesTaskId: firstString(taskObj.continuesTaskId),
  };
}

/**
 * Renders the appropriate native Main Chat inline card when a tool call belongs to the Main Chat
 * orchestration suite, or returns `null` to fall back to Paseo's standard `ToolCallSlot`.
 *
 * Follows M3 chat-stream subtraction:
 * - Open plans render inline-editable `MainChatPlanCard`; started plans converge into compact
 *   per-agent `MainChatHandoffCard` rows; cancelled/withdrawn plans collapse to one muted line.
 * - Direct task spawns render one compact `MainChatHandoffCard`.
 * - Historical receipts, rework cards, and decisions default to single-line collapsible summaries
 *   in the stream while pending items live cleanly in `MainChatActionBar`.
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
        defaultExpanded={false}
      />
    );
  }
  if (isTaskReworkToolName(input.toolName)) {
    return (
      <MainChatReworkCard
        serverId={input.serverId}
        input={input.toolInput}
        output={input.toolOutput}
        defaultExpanded={false}
      />
    );
  }
  if (isTaskAskUserToolName(input.toolName)) {
    return (
      <MainChatDecisionCard
        serverId={input.serverId}
        agentId={input.agentId}
        output={input.toolOutput}
        defaultExpanded={false}
      />
    );
  }
  if (isSettingsProposePatchToolName(input.toolName)) {
    return (
      <MainChatSettingsProposalCard
        serverId={input.serverId}
        agentId={input.agentId}
        output={input.toolOutput}
      />
    );
  }

  const normalized = normalizeMainChatToolName(input.toolName);
  if (normalized === "task_review") {
    if (parseTaskReworkToolPayload(input.toolInput, input.toolOutput)) {
      return (
        <MainChatReworkCard
          serverId={input.serverId}
          input={input.toolInput}
          output={input.toolOutput}
          defaultExpanded={false}
        />
      );
    }
    if (parseTaskCompleteToolPayload(input.toolInput, input.toolOutput)) {
      return (
        <MainChatReceiptCard
          serverId={input.serverId}
          input={input.toolInput}
          output={input.toolOutput}
          defaultExpanded={false}
        />
      );
    }
  }
  if (normalized === "task_spawn") {
    const handoff = parseDirectSpawnHandoff(input.toolInput, input.toolOutput);
    if (handoff) {
      return (
        <MainChatHandoffCard
          serverId={handoff.serverId ?? input.serverId}
          agentId={handoff.agentId}
          title={handoff.title}
          workspaceId={handoff.workspaceId}
          workspaceLabel={handoff.workspaceLabel}
          hostLabel={handoff.hostLabel}
          mode={handoff.mode}
          taskId={handoff.taskId}
          sourceKind={handoff.continuesTaskId ? "continuation" : "new"}
        />
      );
    }
  }

  return null;
}
