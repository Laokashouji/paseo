import {
  getMainChatBackgroundTurnMetadata,
  isMainChatInlineCardToolName,
  type MainChatBackgroundTurnMetadata,
} from "@getpaseo/protocol/main-chat";
import { isTurnBoundary, isTurnTrigger } from "../turn-membership";
import {
  getStreamItemMessageId,
  type StreamItem,
  type ThoughtItem,
  type TimelinePosition,
  type ToolCallItem,
  type TurnSummaryItem,
} from "@/types/stream";
import { summarizeToolCalls, type OverviewSummary } from "@/tool-calls/detail-level/overview/model";

export interface TurnCollapse {
  tail: StreamItem[];
  /** Rows of expanded turns, which render inside the turn's indent rail. */
  nestedItemIds: ReadonlySet<string>;
  /** The host of the turn a folded message belongs to, for surfaces that must reveal it. */
  hostIdByFoldedMessageId: ReadonlyMap<string, string>;
  /** Mounted rows replaced by a closed turn's host, for preserving the reading position. */
  hostIdByHiddenRowId: ReadonlyMap<string, string>;
  /**
   * The summary rows by host. A mounted row renders again only when its item changes, so a fold
   * keeps the previous row object for a turn whose work and open state are unchanged.
   */
  summaryRowsByHostId: ReadonlyMap<string, TurnSummaryItem>;
}

export interface CollapseTurnsInput {
  tail: StreamItem[];
  /** The latest turn is still producing output, so it stays unfolded. */
  isLatestTurnOpen: boolean;
  expandedHostIds: ReadonlySet<string>;
  /** The calls a tool-call group row stands for; undefined for a single call. */
  getGroupedCalls: (itemId: string) => readonly (ToolCallItem | ThoughtItem)[] | undefined;
  /** The previous fold of the same history, whose unchanged summary rows are reused. */
  previousSummaryRowsByHostId: ReadonlyMap<string, TurnSummaryItem>;
  /** Fold normal user-initiated turns behind a summary row (default: true). */
  collapseNormalTurns?: boolean;
  /** Collapse system-injected Main Chat background turns into a compact single line and hide silent rounds. */
  collapseBackgroundTurns?: boolean;
}

const EMPTY_IDS: ReadonlySet<string> = new Set();
const EMPTY_ROWS: ReadonlyMap<string, TurnSummaryItem> = new Map();
const EMPTY_HOSTS: ReadonlyMap<string, string> = new Map();

const EXPLICIT_SILENT_SENTINEL_RE =
  /^(?:`*(?:\[silent\]|silent|no_action|\[no_action\]|<silent\s*\/>|<silent>\s*<\/silent>)`*)[.。!！\s]*$/i;

const PLACEHOLDER_EMPTY_REPLY_RE =
  /^(?:\(no content\)|no content|no response requested|no response needed|no_response|\[no_response\])[.。!！\s]*$/i;

const MISSING_REPLY_RECOVERY_MARKER = "系统自动补答提醒";
const MAX_BACKGROUND_LABEL_CHARS = 36;

const LEGACY_BACKGROUND_ENVELOPE_RE = /^<paseo-system>\n([\s\S]*)\n<\/paseo-system>$/;
const LEGACY_BACKGROUND_ENVELOPE_MARKERS = [
  "📋 督办 · 主动巡检唤醒：",
  "👋 首次就绪简报：",
  "【系统自动补答提醒】",
  "【后台空闲预压缩检查点】",
  "【主对话上下文压缩检查点】",
] as const;

/**
 * Recognizes legacy Main Chat system prompts that older daemons accidentally persisted as
 * `user_message` items (either wrapped in `<paseo-system>...</paseo-system>` or carrying the
 * exact multi-line daemon system header + system-event disclaimer).
 */
function extractLegacyMainChatUserMessageSystemText(text: string): string | null {
  const trimmed = text.trim();
  const envelopeMatch = LEGACY_BACKGROUND_ENVELOPE_RE.exec(trimmed);
  if (envelopeMatch) {
    const inner = envelopeMatch[1]!.trimStart();
    if (LEGACY_BACKGROUND_ENVELOPE_MARKERS.some((marker) => inner.startsWith(marker))) {
      return envelopeMatch[1]!;
    }
    return null;
  }
  if (
    trimmed.startsWith("📋 督办 · 主动巡检唤醒：") &&
    (trimmed.includes("（这是 Paseo 后台巡检事件，不是用户手打消息") ||
      trimmed.includes("（这是 Paseo 后台督办与巡检事件，不是用户手打消息"))
  ) {
    return trimmed;
  }
  if (
    trimmed.startsWith("👋 首次就绪简报：") &&
    trimmed.includes("（这是 Paseo 自动触发的首次态势简报")
  ) {
    return trimmed;
  }
  if (
    trimmed.startsWith("【系统自动补答提醒】") &&
    trimmed.includes("上一轮你在响应用户消息时调用了工具")
  ) {
    return trimmed;
  }
  if (
    (trimmed.startsWith("【后台空闲预压缩检查点】") ||
      trimmed.startsWith("【主对话上下文压缩检查点】")) &&
    trimmed.includes("以下是最新的结构化上下文交接摘要")
  ) {
    return trimmed;
  }
  return null;
}

function getStructuredBackgroundTurnMeta(item: StreamItem): MainChatBackgroundTurnMetadata | null {
  if (item.kind !== "tool_call" || item.payload.source !== "agent") return null;
  return getMainChatBackgroundTurnMetadata(item.payload.data.metadata);
}

export function isSystemBackgroundTrigger(item: StreamItem): boolean {
  if (item.kind === "user_message") {
    return extractLegacyMainChatUserMessageSystemText(item.text) !== null;
  }
  if (item.kind !== "tool_call") return false;
  const structuredMeta = getStructuredBackgroundTurnMeta(item);
  if (structuredMeta?.foldable) {
    return true;
  }
  if (item.payload.source === "agent") {
    return (
      item.payload.data.name === "heartbeat" || item.payload.data.callId.startsWith("paseo-system:")
    );
  }
  return item.payload.data.toolName === "heartbeat";
}

function extractSystemBackgroundText(item: StreamItem): string {
  if (item.kind === "user_message") {
    return extractLegacyMainChatUserMessageSystemText(item.text) ?? "";
  }
  if (item.kind !== "tool_call") return "";
  if (item.payload.source === "agent") {
    const detail = item.payload.data.detail;
    if (detail.type === "plain_text") return detail.text ?? "";
    if (detail.type === "unknown" && typeof detail.input === "string") return detail.input;
    return "";
  }
  return typeof item.payload.data.arguments === "string" ? item.payload.data.arguments : "";
}

function isMissingReplyRecoveryTrigger(item: StreamItem): boolean {
  const structuredMeta = getStructuredBackgroundTurnMeta(item);
  if (structuredMeta?.kind === "recovery") return true;
  return extractSystemBackgroundText(item).includes(MISSING_REPLY_RECOVERY_MARKER);
}

export function extractBackgroundTurnLabel(item: StreamItem): string | null {
  const structuredMeta = getStructuredBackgroundTurnMeta(item);
  const explicitLabel = structuredMeta?.label?.replace(/\s+/g, " ").trim();
  if (explicitLabel) {
    return explicitLabel.length > MAX_BACKGROUND_LABEL_CHARS
      ? `${explicitLabel.slice(0, MAX_BACKGROUND_LABEL_CHARS - 1)}…`
      : explicitLabel;
  }
  const raw = extractSystemBackgroundText(item);
  if (!raw.trim()) return null;
  for (const line of raw.split(/\r?\n/)) {
    const cleaned = line
      .replace(/^[#>*\-\s【[]+/, "")
      .replace(/[】\]\s]+$/, "")
      .trim();
    if (!cleaned || cleaned.startsWith("<")) continue;
    return cleaned.length > MAX_BACKGROUND_LABEL_CHARS
      ? `${cleaned.slice(0, MAX_BACKGROUND_LABEL_CHARS - 1)}…`
      : cleaned;
  }
  return null;
}

function getToolCallName(item: ToolCallItem): string {
  return item.payload.source === "agent" ? item.payload.data.name : item.payload.data.toolName;
}

function hasExplicitSilentReplyOnly(
  bodyItems: readonly StreamItem[],
  getGroupedCalls: CollapseTurnsInput["getGroupedCalls"],
): boolean {
  const assistantTexts: string[] = [];
  for (const item of bodyItems) {
    if (item.kind === "tool_call" || item.kind === "thought") {
      const expanded = getGroupedCalls(item.id) ?? [item];
      for (const call of expanded) {
        if (call.kind === "tool_call" && isMainChatInlineCardToolName(getToolCallName(call))) {
          return false;
        }
      }
      continue;
    }
    if (item.kind === "assistant_message") {
      assistantTexts.push(item.text);
      continue;
    }
    if (item.kind === "plugin" && item.sourceKind === "assistant_message") {
      return false;
    }
  }
  const combined = assistantTexts
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (combined.length === 0) return false;
  return EXPLICIT_SILENT_SENTINEL_RE.test(combined);
}

export function isSilentBackgroundTurn(
  bodyItems: readonly StreamItem[],
  getGroupedCalls: CollapseTurnsInput["getGroupedCalls"],
): boolean {
  const assistantTexts: string[] = [];
  for (const item of bodyItems) {
    if (item.kind === "tool_call" || item.kind === "thought") {
      const expanded = getGroupedCalls(item.id) ?? [item];
      for (const call of expanded) {
        if (call.kind === "tool_call" && isMainChatInlineCardToolName(getToolCallName(call))) {
          return false;
        }
      }
      continue;
    }
    if (item.kind === "assistant_message") {
      assistantTexts.push(item.text);
      continue;
    }
    if (item.kind === "plugin" && item.sourceKind === "assistant_message") {
      return false;
    }
  }
  const combined = assistantTexts
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  if (combined.length === 0) return true;
  return EXPLICIT_SILENT_SENTINEL_RE.test(combined) || PLACEHOLDER_EMPTY_REPLY_RE.test(combined);
}

function summarizeTurn(
  items: readonly StreamItem[],
  getGroupedCalls: CollapseTurnsInput["getGroupedCalls"],
): OverviewSummary {
  const calls: (ToolCallItem | ThoughtItem)[] = [];
  for (const item of items) {
    if ((item.kind === "tool_call" || item.kind === "thought") && !isTurnTrigger(item))
      calls.push(...(getGroupedCalls(item.id) ?? [item]));
  }
  return summarizeToolCalls(calls);
}

function hasWork(tools: OverviewSummary): boolean {
  const { paseoActions, thoughtCount: _thoughtCount, ...counts } = tools;
  return Object.keys(paseoActions).length > 0 || Object.values(counts).some((count) => count > 0);
}

function hasSameWork(a: OverviewSummary, b: OverviewSummary): boolean {
  const { paseoActions: actionsA, ...countsA } = a;
  const { paseoActions: actionsB, ...countsB } = b;
  return hasSameCounts(countsA, countsB) && hasSameCounts(actionsA, actionsB);
}

function hasSamePosition(a: TimelinePosition | undefined, b: TimelinePosition | undefined) {
  return a === b || (a !== undefined && b !== undefined && a.epoch === b.epoch && a.seq === b.seq);
}

function hasSameCounts(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function hasSameBackgroundMeta(
  a: TurnSummaryItem["backgroundMeta"],
  b: TurnSummaryItem["backgroundMeta"],
): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.label === b.label &&
      a.running === b.running &&
      a.kind === b.kind)
  );
}

function summaryRow(
  host: StreamItem,
  expanded: boolean,
  tools: OverviewSummary,
  previous: TurnSummaryItem | undefined,
  options?: {
    variant?: "default" | "background";
    backgroundMeta?: TurnSummaryItem["backgroundMeta"];
  },
): TurnSummaryItem {
  const variant = options?.variant;
  const backgroundMeta = options?.backgroundMeta;
  if (
    previous &&
    previous.expanded === expanded &&
    previous.variant === variant &&
    hasSameBackgroundMeta(previous.backgroundMeta, backgroundMeta) &&
    hasSameWork(previous.tools, tools) &&
    hasSamePosition(previous.timelineCursor, host.timelineCursor)
  ) {
    return previous;
  }
  return {
    kind: "turn_summary",
    id: `turn-summary:${host.id}`,
    // The row stands at its host's place in the timeline, so the reading position over it
    // still resolves to the turn's prompt.
    ...(host.timelineCursor !== undefined ? { timelineCursor: host.timelineCursor } : {}),
    ...(host.turnId !== undefined ? { turnId: host.turnId } : {}),
    timestamp: host.timestamp,
    hostId: host.id,
    expanded,
    tools,
    ...(variant ? { variant } : {}),
    ...(backgroundMeta ? { backgroundMeta } : {}),
  };
}

function staysVisibleWhenCollapsed(item: StreamItem): boolean {
  if (isTurnTrigger(item) || item.kind === "compaction") return true;
  if (item.kind === "tool_call") {
    return isMainChatInlineCardToolName(getToolCallName(item));
  }
  return false;
}

function staysVisibleInCollapsedBackgroundTurn(item: StreamItem): boolean {
  if (item.kind === "compaction") return true;
  if (item.kind === "tool_call") {
    return isMainChatInlineCardToolName(getToolCallName(item));
  }
  return false;
}

function isAssistantReply(item: StreamItem): boolean {
  return (
    item.kind === "assistant_message" ||
    (item.kind === "plugin" && item.sourceKind === "assistant_message")
  );
}

function findLastReplyIndex(tail: StreamItem[], start: number, end: number): number {
  for (let index = end - 1; index >= start; index -= 1) {
    const item = tail[index]!;
    if (!isAssistantReply(item)) continue;
    const messageId = getStreamItemMessageId(item);
    // A transformer can split one reply into several cards; keep the whole reply visible.
    while (index > start) {
      const previous = tail[index - 1]!;
      if (!isAssistantReply(previous) || getStreamItemMessageId(previous) !== messageId) break;
      index -= 1;
    }
    return index;
  }
  return -1;
}

/**
 * Folds each answered turn behind a summary row under its user message: everything the agent
 * did before its last message collapses into that row, and the last message stays in the chat.
 * A turn folds only once it is complete, its user message is loaded, and it sent messages or
 * called tools before its reply. Reasoning is revealed only when the turn opens.
 *
 * When `collapseBackgroundTurns` is enabled (Main Chat), system-injected background turns fold
 * into a single compact expandable row and completed silent rounds are suppressed from the stream.
 */
export function collapseTurns(input: CollapseTurnsInput): TurnCollapse {
  const { tail } = input;
  const collapseNormal = input.collapseNormalTurns ?? true;
  const collapseBackground = input.collapseBackgroundTurns === true;

  const output: StreamItem[] = [];
  const summaryRowsByHostId = new Map<string, TurnSummaryItem>();
  const nestedItemIds = new Set<string>();
  const hostIdByFoldedMessageId = new Map<string, string>();
  const hostIdByHiddenRowId = new Map<string, string>();
  let mutatedTail = false;

  const expandCalls = (items: readonly StreamItem[]): StreamItem[] =>
    items.flatMap<StreamItem>((item) =>
      item.kind === "tool_call" || item.kind === "thought"
        ? [...(input.getGroupedCalls(item.id) ?? [item])]
        : [item],
    );

  const flushCompactionBackgroundRun = (
    host: StreamItem,
    body: StreamItem[],
    isClosed: boolean,
  ) => {
    const tools = summarizeTurn(body, input.getGroupedCalls);
    const expanded = input.expandedHostIds.has(host.id);
    const summary = summaryRow(
      host,
      expanded,
      tools,
      input.previousSummaryRowsByHostId.get(host.id),
      {
        variant: "background",
        backgroundMeta: {
          label: extractBackgroundTurnLabel(host),
          running: !isClosed,
          kind: "compaction",
        },
      },
    );
    summaryRowsByHostId.set(host.id, summary);

    const revealedItems = [host, ...(expanded ? expandCalls(body) : body)];
    for (const item of revealedItems) {
      hostIdByFoldedMessageId.set(getStreamItemMessageId(item), host.id);
      if (expanded) nestedItemIds.add(item.id);
      else hostIdByHiddenRowId.set(item.id, host.id);
    }
    output.push(summary, ...(expanded ? revealedItems : []));
  };

  const shouldSuppressSilentBackgroundRun = (body: StreamItem[], isClosed: boolean): boolean =>
    (isClosed && isSilentBackgroundTurn(body, input.getGroupedCalls)) ||
    hasExplicitSilentReplyOnly(body, input.getGroupedCalls);

  const flushBackgroundRun = (host: StreamItem, body: StreamItem[], isClosed: boolean) => {
    // Remove the host item that the boundary loop just pushed before this run.
    if (output.length > 0 && output[output.length - 1] === host) {
      output.pop();
    }
    mutatedTail = true;

    if (isMissingReplyRecoveryTrigger(host)) {
      // Keep the recovered assistant answer visible while suppressing the internal recovery prompt.
      if (isClosed && isSilentBackgroundTurn(body, input.getGroupedCalls)) {
        return;
      }
      output.push(...body);
      return;
    }

    const structuredMeta = getStructuredBackgroundTurnMeta(host);

    // Compaction turns (native idle_precompact /compact or checkpoint summaries) always render as a
    // single compact summary bar that expands in place, never hanging raw /compact or silent replies.
    if (structuredMeta?.kind === "compaction") {
      flushCompactionBackgroundRun(host, body, isClosed);
      return;
    }

    if (shouldSuppressSilentBackgroundRun(body, isClosed)) {
      // Silent rounds stay in the `/main/history` activity audit view and are completely hidden in chat.
      return;
    }

    const replyIndex = findLastReplyIndex(body, 0, body.length);
    const processItems = replyIndex >= 0 ? body.slice(0, replyIndex) : body;
    const conclusionItems = replyIndex >= 0 ? body.slice(replyIndex) : [];

    const tools = summarizeTurn(processItems, input.getGroupedCalls);
    const expanded = input.expandedHostIds.has(host.id);
    const summary = summaryRow(
      host,
      expanded,
      tools,
      input.previousSummaryRowsByHostId.get(host.id),
      {
        variant: "background",
        backgroundMeta: {
          label: extractBackgroundTurnLabel(host),
          running: !isClosed,
          ...(structuredMeta?.kind ? { kind: structuredMeta.kind } : {}),
        },
      },
    );
    summaryRowsByHostId.set(host.id, summary);

    // Hide the system trigger bubble and intermediate process behind the lightweight gray tag,
    // while keeping the steward's substantive conclusion directly readable in the main chat stream.
    const revealedProcess = [host, ...(expanded ? expandCalls(processItems) : processItems)];
    for (const item of revealedProcess) {
      if (item !== host && staysVisibleInCollapsedBackgroundTurn(item)) continue;
      hostIdByFoldedMessageId.set(getStreamItemMessageId(item), host.id);
      if (expanded) nestedItemIds.add(item.id);
      else hostIdByHiddenRowId.set(item.id, host.id);
    }
    output.push(
      summary,
      ...(expanded
        ? revealedProcess
        : processItems.filter((item) => staysVisibleInCollapsedBackgroundTurn(item))),
      ...conclusionItems,
    );
  };

  const flushNormalRun = (host: StreamItem | undefined, runEnd: number, isClosed: boolean) => {
    const replyIndex = findLastReplyIndex(tail, runStart, runEnd);
    const isCollapsibleHost =
      host !== undefined && (host.kind === "user_message" || host.kind === "tool_call");
    if (!isCollapsibleHost || !isClosed || replyIndex <= runStart) {
      output.push(...tail.slice(runStart, runEnd));
      return;
    }
    const folded = tail.slice(runStart, replyIndex);
    const tools = summarizeTurn(folded, input.getGroupedCalls);
    if (!hasWork(tools) && !folded.some(isAssistantReply)) {
      output.push(...tail.slice(runStart, runEnd));
      return;
    }
    const expanded = input.expandedHostIds.has(host.id);
    const summary = summaryRow(
      host,
      expanded,
      tools,
      input.previousSummaryRowsByHostId.get(host.id),
    );
    summaryRowsByHostId.set(host.id, summary);
    mutatedTail = true;
    const revealed = expanded ? expandCalls(folded) : folded;
    for (const item of revealed) {
      if (staysVisibleWhenCollapsed(item)) continue;
      hostIdByFoldedMessageId.set(getStreamItemMessageId(item), host.id);
      if (expanded) nestedItemIds.add(item.id);
      else hostIdByHiddenRowId.set(item.id, host.id);
    }
    output.push(
      summary,
      ...(expanded ? revealed : folded.filter((item) => staysVisibleWhenCollapsed(item))),
    );
    output.push(...tail.slice(replyIndex, runEnd));
  };

  let runStart = 0;
  const flushRun = (runEnd: number) => {
    const host = tail[runStart - 1];
    const isClosed = runEnd < tail.length || !input.isLatestTurnOpen;

    if (collapseBackground && host && isSystemBackgroundTrigger(host)) {
      flushBackgroundRun(host, tail.slice(runStart, runEnd), isClosed);
      return;
    }
    if (!collapseNormal) {
      output.push(...tail.slice(runStart, runEnd));
      return;
    }
    flushNormalRun(host, runEnd, isClosed);
  };

  for (let index = 0; index < tail.length; index += 1) {
    if (
      !(index === 0 && isTurnTrigger(tail[index]!)) &&
      !isTurnBoundary(tail[index - 1] ?? null, tail[index] ?? null)
    )
      continue;
    flushRun(index);
    output.push(tail[index]!);
    runStart = index + 1;
  }
  flushRun(tail.length);

  if (summaryRowsByHostId.size === 0 && !mutatedTail) {
    return {
      tail,
      nestedItemIds: EMPTY_IDS,
      hostIdByFoldedMessageId: EMPTY_HOSTS,
      hostIdByHiddenRowId: EMPTY_HOSTS,
      summaryRowsByHostId: EMPTY_ROWS,
    };
  }
  return {
    tail: output,
    nestedItemIds,
    hostIdByFoldedMessageId,
    hostIdByHiddenRowId,
    summaryRowsByHostId,
  };
}
