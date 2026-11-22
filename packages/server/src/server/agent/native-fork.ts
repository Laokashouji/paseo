import {
  forkLineageLabels,
  getForkRootAgentIdFromLabels,
  isOpenAgentTabLabel,
  PARENT_AGENT_ID_LABEL,
  PARENT_SERVER_ID_LABEL,
} from "@getpaseo/protocol/agent-labels";
import type { AgentSessionForkInput } from "./agent-sdk-types.js";
import type { AgentTimelineCursor, AgentTimelineRow } from "./agent-timeline-store-types.js";
import { projectTimelineRows } from "./timeline-projection.js";

export interface NativeForkBoundaryResolution {
  nextUserMessageId?: string;
  currentTurnUserMessageId?: string;
  boundaryAssistantMessageId?: string;
}

/**
 * Resolves a Paseo timeline boundary into provider-level fork arguments.
 *
 * - Omitting both `boundaryCursor` and `boundaryMessageId` forks the full conversation.
 * - Pointing at the latest completed turn (no subsequent `user_message` row exists) also forks
 *   the full committed session so trailing tool results or blocks are never dropped.
 * - Pointing at an earlier turn returns `nextUserMessageId` (the first user prompt strictly after
 *   the boundary), matching each provider's exclusive/rewind turn boundary, plus fallback turn
 *   anchors for inclusive providers.
 */
export function resolveNativeForkBoundary(input: {
  rows: readonly AgentTimelineRow[];
  timelineEpoch: string;
  boundaryCursor?: AgentTimelineCursor | null;
  boundaryMessageId?: string | null;
}): NativeForkBoundaryResolution {
  const boundaryCursor = input.boundaryCursor ?? null;
  const boundaryMessageId = input.boundaryMessageId?.trim() || null;
  if (!boundaryCursor && !boundaryMessageId) {
    return {};
  }

  if (boundaryCursor && boundaryCursor.epoch !== input.timelineEpoch) {
    throw new Error("Selected timeline position is no longer available.");
  }

  const projectedRows = projectTimelineRows({ rows: input.rows, mode: "projected" });
  const boundaryIndex = boundaryCursor
    ? projectedRows.findIndex((row) => row.seqEnd === boundaryCursor.seq)
    : projectedRows.findLastIndex(
        (row) => row.item.type === "assistant_message" && row.item.messageId === boundaryMessageId,
      );
  if (boundaryIndex < 0) {
    throw new Error(
      boundaryCursor
        ? "Selected timeline position is no longer available."
        : "Selected assistant message is no longer available.",
    );
  }

  const boundarySeq = projectedRows[boundaryIndex].seqEnd;
  let nextUserRow: AgentTimelineRow | null = null;
  let currentTurnUserRow: AgentTimelineRow | null = null;
  let boundaryAssistantRow: AgentTimelineRow | null = null;

  for (const row of input.rows) {
    if (row.seq <= boundarySeq) {
      if (row.item.type === "user_message") {
        currentTurnUserRow = row;
      } else if (row.item.type === "assistant_message") {
        boundaryAssistantRow = row;
      }
      continue;
    }
    if (row.item.type === "user_message") {
      nextUserRow = row;
      break;
    }
  }

  if (!nextUserRow) {
    return {};
  }

  if (
    nextUserRow.item.type === "user_message" &&
    nextUserRow.item.clientMessageId &&
    nextUserRow.item.messageId === nextUserRow.item.clientMessageId &&
    !nextUserRow.providerMessageId
  ) {
    throw new Error("Cannot fork before the provider acknowledges the following prompt.");
  }

  const nextUserMessageId =
    nextUserRow.providerMessageId ??
    (nextUserRow.item.type === "user_message" ? nextUserRow.item.messageId : undefined);
  const currentTurnUserMessageId =
    currentTurnUserRow?.providerMessageId ??
    (currentTurnUserRow?.item.type === "user_message"
      ? currentTurnUserRow.item.messageId
      : undefined);
  const boundaryAssistantMessageId =
    boundaryAssistantRow?.item.type === "assistant_message"
      ? boundaryAssistantRow.item.messageId
      : undefined;

  if (!nextUserMessageId && !currentTurnUserMessageId && !boundaryAssistantMessageId) {
    throw new Error("Selected turn cannot be resolved to a native provider message boundary.");
  }

  return {
    ...(nextUserMessageId ? { nextUserMessageId } : {}),
    ...(currentTurnUserMessageId ? { currentTurnUserMessageId } : {}),
    ...(boundaryAssistantMessageId ? { boundaryAssistantMessageId } : {}),
  };
}

export function buildNativeForkLabels(input: {
  sourceAgentId: string;
  sourceLabels?: Record<string, string> | null;
  extraLabels?: Record<string, string>;
}): Record<string, string> {
  const sanitizedExtra: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.extraLabels ?? {})) {
    if (
      key === PARENT_AGENT_ID_LABEL ||
      key === PARENT_SERVER_ID_LABEL ||
      isOpenAgentTabLabel(key)
    ) {
      continue;
    }
    sanitizedExtra[key] = value;
  }
  const rootAgentId = getForkRootAgentIdFromLabels(input.sourceLabels) ?? input.sourceAgentId;
  return {
    ...sanitizedExtra,
    ...forkLineageLabels({
      sourceAgentId: input.sourceAgentId,
      rootAgentId,
      mode: "native",
    }),
  };
}

export function resolveForkAgentTitle(input: {
  explicitTitle?: string | null;
  sourceTitle?: string | null;
}): string {
  const explicit = input.explicitTitle?.trim();
  if (explicit) {
    return explicit;
  }
  const source = input.sourceTitle?.trim();
  if (!source) {
    return "Forked conversation";
  }
  return `${source} (fork)`;
}

export function buildSessionForkInput(input: {
  boundary: NativeForkBoundaryResolution;
  targetCwd: string;
  title: string;
}): AgentSessionForkInput {
  return {
    ...input.boundary,
    targetCwd: input.targetCwd,
    title: input.title,
  };
}
