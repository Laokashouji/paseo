import type { AgentTimelineRow } from "./agent-timeline-store-types.js";

const PROMPT_PREVIEW_MAX_LENGTH = 120;

const PASEO_SYSTEM_ENVELOPE_RE = /^<paseo-system(?:\s[^>]*)?>[\s\S]*<\/paseo-system>$/;
const LEGACY_BACKGROUND_PROMPTS: ReadonlyArray<{
  prefix: string;
  marker: string;
}> = [
  {
    prefix: "📋 督办 · 主动巡检唤醒：",
    marker: "（这是 Paseo 后台",
  },
  {
    prefix: "👋 首次就绪简报：",
    marker: "（这是 Paseo 自动触发的首次态势简报",
  },
  {
    prefix: "【系统自动补答提醒】",
    marker: "上一轮你在响应用户消息时调用了工具",
  },
  {
    prefix: "【后台空闲预压缩检查点】",
    marker: "以下是最新的结构化上下文交接摘要",
  },
  {
    prefix: "【主对话上下文压缩检查点】",
    marker: "以下是最新的结构化上下文交接摘要",
  },
];

export interface TimelinePromptIndexEntry {
  seq: number;
  timestamp: string;
  preview: string;
}

export interface TimelinePromptIndex {
  epoch: string;
  prompts: TimelinePromptIndexEntry[];
}

/**
 * Filters daemon-injected `<paseo-system>` background patrol/keepalive/relay envelopes
 * (and legacy unwrapped main-chat patrol prompts) out of the user prompt outline index.
 */
export function isHiddenSystemTimelinePrompt(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  if (PASEO_SYSTEM_ENVELOPE_RE.test(trimmed)) {
    return true;
  }
  return LEGACY_BACKGROUND_PROMPTS.some(
    ({ prefix, marker }) => trimmed.startsWith(prefix) && trimmed.includes(marker),
  );
}

function stripLeadingStructuredQuoteBlocks(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (!normalized.startsWith(">")) {
    return normalized;
  }
  const lines = normalized.split("\n");
  let cursor = 0;
  let consumed = 0;
  while (cursor < lines.length) {
    const start = cursor;
    while (cursor < lines.length && (lines[cursor] ?? "").trim().length > 0) {
      cursor += 1;
    }
    const block = lines.slice(start, cursor);
    const allQuoted = block.length > 0 && block.every((line) => /^ {0,3}>/.test(line));
    const firstInner = allQuoted ? (block[0] ?? "").replace(/^ {0,3}> ?/, "").trim() : "";
    const isStructuredQuote =
      /^Quote(?:\s*·\s*.+)?$/.test(firstInner) || /^Comment\s+\d+(?:\s*·\s*.+)?$/.test(firstInner);
    if (!isStructuredQuote) {
      cursor = start;
      break;
    }
    consumed += 1;
    while (cursor < lines.length && (lines[cursor] ?? "").trim().length === 0) {
      cursor += 1;
    }
  }
  if (consumed === 0) {
    return normalized;
  }
  const remainder = lines.slice(cursor).join("\n").trim();
  return remainder.length > 0 ? remainder : normalized;
}

function promptPreview(text: string): string {
  const candidate = stripLeadingStructuredQuoteBlocks(text);
  const collapsed = candidate.replace(/\s+/g, " ").trim();
  if (collapsed.length <= PROMPT_PREVIEW_MAX_LENGTH) {
    return collapsed;
  }
  return `${collapsed.slice(0, PROMPT_PREVIEW_MAX_LENGTH - 1)}…`;
}

export function buildTimelinePromptIndex(
  epoch: string,
  rows: readonly AgentTimelineRow[],
): TimelinePromptIndex {
  return {
    epoch,
    prompts: rows.flatMap((row) =>
      row.item.type === "user_message" && !isHiddenSystemTimelinePrompt(row.item.text)
        ? [
            {
              seq: row.seq,
              timestamp: row.timestamp,
              preview: promptPreview(row.item.text),
            },
          ]
        : [],
    ),
  };
}
