import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MAIN_CHAT_BACKGROUND_COMPACTION_MSG_PREFIX,
  MainChatBackgroundTurnKindSchema,
  type MainChatBackgroundTurnKind,
  type MainChatBackgroundTurnMetadata,
} from "@getpaseo/protocol/main-chat";
import type {
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentTimelineItem,
} from "../agent-sdk-types.js";

const agentIdSchema = z.string().min(1);
const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("change-request-update"),
    url: z.url({ protocol: /^https?$/ }),
  }),
  z.object({
    kind: z.literal("agent-message"),
    agentId: agentIdSchema,
    serverId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("agent-notification"),
    agentId: agentIdSchema,
    serverId: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    event: z.enum(["finished", "errored", "permission-required", "closed"]),
  }),
]);
export type AgentPromptSource = z.infer<typeof sourceSchema>;

interface AgentMessage {
  id: string;
  source: AgentPromptSource | null;
  text: string;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

function unescapeXml(value: string): string | null {
  if (/[<>]|&(?!amp;|lt;|gt;|quot;|apos;)/.test(value)) return null;
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    switch (entity) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      default:
        return "'";
    }
  });
}

export function formatAgentMessage(message: AgentMessage): string {
  const { source } = message;
  if (source?.kind === "change-request-update") {
    return `<paseo-system version="1" kind="change-request-update" source-url="${escapeXml(source.url)}" message-id="${escapeXml(message.id)}">\n${escapeXml(message.text)}\n</paseo-system>`;
  }
  const attributes = source
    ? `kind="${source.kind}" source-agent-id="${escapeXml(source.agentId)}"`
    : 'kind="user-message"';
  const server = source?.serverId ? ` source-server-id="${escapeXml(source.serverId)}"` : "";
  const title = source?.title ? ` source-agent-title="${escapeXml(source.title)}"` : "";
  const event = source?.kind === "agent-notification" ? ` event="${source.event}"` : "";
  return `<paseo-system version="1" ${attributes} message-id="${escapeXml(message.id)}"${server}${title}${event}>\n${escapeXml(message.text)}\n</paseo-system>`;
}

export function parseAgentMessage(text: string): AgentMessage | null {
  const envelope = /^<paseo-system((?:\s+[a-z-]+="[^"<>]*")+)>\n([\s\S]*)\n<\/paseo-system>$/.exec(
    text,
  );
  if (!envelope) return null;
  const attributes = new Map<string, string>();
  for (const match of envelope[1].matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
    const value = unescapeXml(match[2]);
    if (value === null || attributes.has(match[1])) return null;
    attributes.set(match[1], value);
  }
  if (attributes.get("version") !== "1") return null;
  const id = attributes.get("message-id");
  const body = unescapeXml(envelope[2]);
  if (!id || body === null) return null;
  if (attributes.get("kind") === "user-message") {
    if (attributes.has("source-agent-id") || attributes.has("event")) return null;
    return { id, source: null, text: body };
  }
  const source = sourceSchema.safeParse({
    kind: attributes.get("kind"),
    agentId: attributes.get("source-agent-id"),
    serverId: attributes.get("source-server-id"),
    event: attributes.get("event"),
    title: attributes.get("source-agent-title"),
    url: attributes.get("source-url"),
  });
  if (!source.success) return null;
  return { id, source: source.data, text: body };
}

/** Accept only a complete sequence of envelopes; prose around them stays user text. */
export function parseAgentMessages(text: string): AgentMessage[] | null {
  // Bodies are XML escaped, so a literal closing tag unambiguously ends an entry.
  const parts = text.split(/(?<=<\/paseo-system>)\n+(?=<paseo-system )/);
  const messages = parts.map(parseAgentMessage);
  return messages.every((message) => message !== null) ? messages : null;
}

function renderMessageText(block: AgentPromptContentBlock): string[] {
  if (block.type === "image") return [];
  if (block.type === "text") return [block.text];
  return [renderPromptAttachmentAsText(block)];
}

export function prepareAgentMessage(
  prompt: AgentPromptInput,
  source?: AgentPromptSource,
  id?: string,
): { prompt: AgentPromptInput; messageId?: string } {
  if (!source) {
    const submittedText =
      typeof prompt === "string"
        ? prompt
        : prompt
            .flatMap((block) =>
              block.type === "text" && !("mimeType" in block) ? [block.text] : [],
            )
            .join("\n")
            .trim();
    // Quote reserved envelopes only when they arrived through the human send path.
    // This provenance must survive provider history, not only the accepted local row.
    if (!parseAgentMessages(submittedText) && !isSystemInjectedEnvelope(submittedText)) {
      return { prompt, messageId: id };
    }
  }
  const messageId = id ?? randomUUID();
  const text = typeof prompt === "string" ? prompt : prompt.flatMap(renderMessageText).join("\n\n");
  // Render textual attachments before wrapping, so provider replay still contains one
  // complete envelope instead of an envelope followed by provider-rendered context.
  const envelope = formatAgentMessage({ id: messageId, source: source ?? null, text });
  return {
    messageId,
    prompt:
      typeof prompt === "string"
        ? envelope
        : [{ type: "text", text: envelope }, ...prompt.filter((block) => block.type === "image")],
  };
}

/** The same projection owns provider echoes, acceptance, import, and replay. */
export function projectAgentMessages(item: AgentTimelineItem): AgentTimelineItem[] {
  if (item.type === "user_message") {
    const messages = parseAgentMessages(item.text);
    if (messages) {
      return messages.flatMap((message) => {
        const projected = projectAgentMessage({ ...item, text: formatAgentMessage(message) });
        return projected ? [projected] : [];
      });
    }
  }
  const projected = projectAgentMessage(item);
  return projected ? [projected] : [];
}

const MAIN_CHAT_CONTEXT_PREFIX_RE = /^<paseo-main-context>\n[\s\S]*?\n<\/paseo-main-context>\s*/;

export function wrapMainChatContextBlock(context: string): string {
  return `<paseo-main-context>\n${context.trim()}\n</paseo-main-context>`;
}

export function stripMainChatContextBlock(text: string): string {
  return text.replace(MAIN_CHAT_CONTEXT_PREFIX_RE, "");
}

const LEGACY_MAIN_CHAT_SYSTEM_PROMPT_MARKERS = [
  "📋 督办 · 主动巡检唤醒：",
  "👋 首次就绪简报：",
  "【系统自动补答提醒】",
  "【后台空闲预压缩检查点】",
  "【主对话上下文压缩检查点】",
] as const;

/**
 * Earlier builds passed `formatSystemNotificationPrompt(...)` through `sendPromptToAgent`,
 * which double-wrapped daemon-generated Main Chat patrol/recovery/compaction prompts inside
 * `kind="user-message"`. Match only strict `<paseo-system>` envelopes carrying one of those
 * exact daemon prefixes so genuine human-pasted envelopes still stay user messages.
 */
function extractLegacyMainChatSystemEnvelopeBody(text: string): string | null {
  if (!isSystemInjectedEnvelope(text)) return null;
  const inner = text.slice("<paseo-system>\n".length, -"\n</paseo-system>".length);
  const trimmed = inner.trimStart();
  if (!LEGACY_MAIN_CHAT_SYSTEM_PROMPT_MARKERS.some((marker) => trimmed.startsWith(marker))) {
    return null;
  }
  return inner;
}

export interface SystemNotificationMetadata {
  kind?: MainChatBackgroundTurnKind;
  trigger?: string | null;
  label?: string | null;
  activityId?: string | null;
  quiet?: boolean;
}

const ATTRIBUTED_BACKGROUND_ENVELOPE_PATTERN =
  /^<paseo-system\s+kind="main-chat-background"((?:\s+[a-z-]+="[^"<>]*")*)>\n([\s\S]*)\n<\/paseo-system>$/;

function inferMainChatBackgroundMetaFromBody(body: string): MainChatBackgroundTurnMetadata | null {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("📋 督办 · 主动巡检唤醒：")) {
    const isSupervision = trimmed.includes("后台督办");
    return {
      foldable: true,
      kind: isSupervision ? "supervision" : "patrol",
    };
  }
  if (trimmed.startsWith("👋 首次就绪简报：")) {
    return { foldable: true, kind: "briefing" };
  }
  if (trimmed.startsWith("【系统自动补答提醒】")) {
    return { foldable: true, kind: "recovery" };
  }
  if (
    trimmed.startsWith("【后台空闲预压缩检查点】") ||
    trimmed.startsWith("【主对话上下文压缩检查点】")
  ) {
    return { foldable: true, kind: "compaction" };
  }
  if (trimmed.startsWith("📣 方向进展汇报") || trimmed.startsWith("【方向进度汇报】")) {
    return { foldable: true, kind: "relay" };
  }
  if (trimmed.startsWith("⏰ 例行任务") || trimmed.startsWith("Schedule ")) {
    return { foldable: true, kind: "routine" };
  }
  return null;
}

function buildBackgroundCompactionMetaFromMessageId(
  messageId: string | undefined,
  text: string,
): MainChatBackgroundTurnMetadata | null {
  if (!messageId || !messageId.startsWith(MAIN_CHAT_BACKGROUND_COMPACTION_MSG_PREFIX)) {
    return null;
  }
  const rest = messageId.slice(MAIN_CHAT_BACKGROUND_COMPACTION_MSG_PREFIX.length);
  const trigger = rest.startsWith("idle_precompact") ? "idle_precompact" : "manual";
  const trimmed = text.replace(/\s+/g, " ").trim();
  let label = "上下文压缩 · 原生 /compact";
  if (trigger === "idle_precompact") {
    label = "空闲自动压缩 · 原生 /compact";
  } else if (trimmed.length > "/compact".length) {
    label = `上下文压缩 · ${trimmed.slice(0, 48)}`;
  }
  return {
    foldable: true,
    kind: "compaction",
    trigger,
    label,
    quiet: true,
  };
}

function parseBooleanAttribute(raw: string | undefined): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}

function parseAttributedBackgroundEnvelope(
  text: string,
): { body: string; backgroundMeta: MainChatBackgroundTurnMetadata } | null {
  const match = ATTRIBUTED_BACKGROUND_ENVELOPE_PATTERN.exec(text);
  if (!match) return null;
  const attributes = new Map<string, string>();
  for (const attr of match[1].matchAll(/\s+([a-z-]+)="([^"<>]*)"/g)) {
    const value = unescapeXml(attr[2]);
    if (value === null || attributes.has(attr[1])) return null;
    attributes.set(attr[1], value);
  }
  const parsedKind = MainChatBackgroundTurnKindSchema.safeParse(attributes.get("bg-kind"));
  const kind: MainChatBackgroundTurnKind = parsedKind.success ? parsedKind.data : "system";
  const trigger = attributes.get("trigger") ?? null;
  const label = attributes.get("label") ?? null;
  const activityId = attributes.get("activity-id") ?? null;
  const quiet = parseBooleanAttribute(attributes.get("quiet"));
  return {
    body: match[2],
    backgroundMeta: {
      foldable: true,
      kind,
      ...(trigger ? { trigger } : {}),
      ...(label ? { label } : {}),
      ...(activityId ? { activityId } : {}),
      ...(quiet !== undefined ? { quiet } : {}),
    },
  };
}

function projectSystemNotificationToolCall(
  envelopeText: string,
  body: string,
  explicitBackgroundMeta?: MainChatBackgroundTurnMetadata | null,
): AgentTimelineItem {
  const backgroundMeta = explicitBackgroundMeta ?? inferMainChatBackgroundMetaFromBody(body);
  return {
    type: "tool_call",
    callId: `paseo-system:${createHash("sha256").update(envelopeText).digest("hex")}`,
    name: "heartbeat",
    status: "completed",
    error: null,
    detail: { type: "plain_text", text: body, icon: "sparkles" },
    ...(backgroundMeta ? { metadata: { mainChatBackground: backgroundMeta } } : {}),
  };
}

function projectAgentMessage(item: AgentTimelineItem): AgentTimelineItem | null {
  if (item.type !== "user_message") return item;
  const cleanedText = stripMainChatContextBlock(item.text);
  const bgCompactionMeta = buildBackgroundCompactionMetaFromMessageId(
    item.clientMessageId,
    cleanedText,
  );
  if (bgCompactionMeta) {
    return projectSystemNotificationToolCall(
      `${item.clientMessageId}:${cleanedText}`,
      cleanedText,
      bgCompactionMeta,
    );
  }
  const message = parseAgentMessage(cleanedText);
  if (!message) {
    const attributed = parseAttributedBackgroundEnvelope(cleanedText);
    if (attributed) {
      return projectSystemNotificationToolCall(
        cleanedText,
        attributed.body,
        attributed.backgroundMeta,
      );
    }
    if (!isSystemInjectedEnvelope(cleanedText)) {
      return cleanedText === item.text ? item : { ...item, text: cleanedText };
    }
    // Schedule bodies include the run ID, keeping identity stable across replay.
    const text = cleanedText.slice("<paseo-system>\n".length, -"\n</paseo-system>".length);
    return projectSystemNotificationToolCall(cleanedText, text);
  }
  const { source } = message;
  if (!source) {
    const wrappedBgCompactionMeta = buildBackgroundCompactionMetaFromMessageId(
      message.id,
      message.text,
    );
    if (wrappedBgCompactionMeta) {
      return projectSystemNotificationToolCall(
        `${message.id}:${message.text}`,
        message.text,
        wrappedBgCompactionMeta,
      );
    }
    const attributedLegacy = parseAttributedBackgroundEnvelope(message.text);
    if (attributedLegacy) {
      return projectSystemNotificationToolCall(
        message.text,
        attributedLegacy.body,
        attributedLegacy.backgroundMeta,
      );
    }
    const legacySystemBody = extractLegacyMainChatSystemEnvelopeBody(message.text);
    if (legacySystemBody !== null) {
      return projectSystemNotificationToolCall(message.text, legacySystemBody);
    }
    return { ...item, text: message.text, clientMessageId: message.id };
  }
  if (source.kind === "change-request-update") {
    return {
      type: "tool_call",
      callId: `paseo-change-request:${message.id}`,
      name: "change_request_update",
      status: "completed",
      error: null,
      detail: { type: "plain_text", text: message.text },
    };
  }
  const relayMeta: MainChatBackgroundTurnMetadata | null =
    source.kind === "agent-notification"
      ? {
          foldable: true,
          kind: "relay",
          trigger: `agent_notification:${source.event}`,
          label: source.title?.trim() || source.agentId,
        }
      : null;
  return {
    type: "tool_call",
    callId: `paseo-agent-message:${message.id}`,
    agentMessage: {
      event: source.kind === "agent-message" ? "message" : source.event,
      sender: {
        id: source.agentId,
        ...(source.serverId ? { serverId: source.serverId } : {}),
        ...(source.title ? { title: source.title } : {}),
      },
      text: message.text,
    },
    // COMPAT(agentMessageToolEnvelope): added in v0.11.1; remove after 2027-04-08
    // once clients can accept a dedicated timeline variant. Older clients still
    // parse this existing shape and can expand the delivered body.
    name: "agent_message",
    status: "completed",
    error: null,
    detail: { type: "plain_text", text: message.text, icon: "bot" },
    ...(relayMeta ? { metadata: { mainChatBackground: relayMeta } } : {}),
  };
}

/**
 * Wrap a body in <paseo-system>…</paseo-system> so the receiving agent
 * recognizes the prompt as system-injected context — not a user turn.
 * Used by schedule fires and Main Chat background supervision/patrol/relay turns;
 * agent messages use the versioned envelope.
 */
export function formatSystemNotificationPrompt(
  reason: string,
  meta?: SystemNotificationMetadata,
): string {
  if (!meta) {
    return `<paseo-system>\n${reason}\n</paseo-system>`;
  }
  const attrs: string[] = ['kind="main-chat-background"'];
  if (meta.kind) {
    attrs.push(`bg-kind="${escapeXml(meta.kind)}"`);
  }
  if (meta.trigger?.trim()) {
    attrs.push(`trigger="${escapeXml(meta.trigger.trim().slice(0, 80))}"`);
  }
  if (meta.label?.trim()) {
    attrs.push(`label="${escapeXml(meta.label.replace(/\s+/g, " ").trim().slice(0, 120))}"`);
  }
  if (meta.activityId?.trim()) {
    attrs.push(`activity-id="${escapeXml(meta.activityId.trim().slice(0, 80))}"`);
  }
  if (typeof meta.quiet === "boolean") {
    attrs.push(`quiet="${meta.quiet ? "true" : "false"}"`);
  }
  return `<paseo-system ${attrs.join(" ")}>\n${reason}\n</paseo-system>`;
}

const SYSTEM_ENVELOPE_PATTERN = /^<paseo-system>\n[\s\S]*\n<\/paseo-system>$/;

export function isSystemInjectedEnvelope(text: string): boolean {
  return SYSTEM_ENVELOPE_PATTERN.test(text) || ATTRIBUTED_BACKGROUND_ENVELOPE_PATTERN.test(text);
}
