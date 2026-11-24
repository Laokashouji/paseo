import { z } from "zod";

export const INTERACTIVE_CARD_FENCE_LANGUAGE = "paseo-view" as const;

export const INTERACTIVE_CARD_MAX_BYTES = 65_536;
export const INTERACTIVE_CARD_MAX_INLINE_PER_MESSAGE = 3;
export const INTERACTIVE_CARD_MAX_LIVE_PER_AGENT = 200;
export const INTERACTIVE_CARD_MAX_PAGES = 8;
export const INTERACTIVE_CARD_MAX_PAGE_DEPTH = 4;
export const INTERACTIVE_CARD_MAX_SECTIONS = 16;
export const INTERACTIVE_CARD_MAX_ITEMS_PER_SECTION = 50;
export const INTERACTIVE_CARD_MAX_FALLBACK_CHARS = 2_000;
export const INTERACTIVE_CARD_MAX_REPLY_CHARS = 1_000;
export const INTERACTIVE_CARD_MAX_FIELD_VALUE_CHARS = 4_000;
export const INTERACTIVE_CARD_MAX_TABLE_COLUMNS = 8;
export const INTERACTIVE_CARD_MAX_TABLE_ROWS = 100;
export const INTERACTIVE_CARD_MAX_CHART_SERIES = 4;
export const INTERACTIVE_CARD_MAX_CHART_POINTS = 120;
export const INTERACTIVE_CARD_MAX_CHART_SLICES = 8;
export const INTERACTIVE_CARD_MAX_STAT_GRID_ITEMS = 6;
export const INTERACTIVE_CARD_MAX_CAROUSEL_ITEMS = 12;
export const INTERACTIVE_CARD_MAX_FILE_TREE_NODES = 100;
export const INTERACTIVE_CARD_MAX_CHECKLIST_ITEMS = 40;
export const INTERACTIVE_CARD_MAX_FIELD_OPTIONS = 50;

export const INTERACTIVE_CARD_TOOL_NAMES = {
  show: "view_show",
  update: "view_update",
  get: "view_get",
} as const;

export type InteractiveCardToolKind = "view_show" | "view_update" | "view_get";

// ============================================================================
// Pure Wire Schemas (zod-aot compatible: no .transform / .catch / .preprocess)
// ============================================================================

export const CardToneSchema = z.enum([
  "default",
  "muted",
  "accent",
  "success",
  "warning",
  "danger",
]);
export type CardTone = z.infer<typeof CardToneSchema>;

export const CardBadgeSchema = z.object({
  label: z.string().min(1).max(80),
  tone: CardToneSchema.optional(),
});
export type CardBadge = z.infer<typeof CardBadgeSchema>;

export const CardReplyActionSchema = z.object({
  kind: z.literal("reply"),
  id: z.string().min(1).max(80),
  reply: z.string().min(1).max(INTERACTIVE_CARD_MAX_REPLY_CHARS),
  submit: z.boolean().optional(),
  requireFields: z.array(z.string().min(1).max(80)).max(32).optional(),
  confirm: z.string().min(1).max(400).optional(),
});
export type CardReplyAction = z.infer<typeof CardReplyActionSchema>;

export const CardPushPageActionSchema = z.object({
  kind: z.literal("push_page"),
  id: z.string().min(1).max(80),
  page: z.string().min(1).max(80),
});
export type CardPushPageAction = z.infer<typeof CardPushPageActionSchema>;

export const CardPopPageActionSchema = z.object({
  kind: z.literal("pop_page"),
  id: z.string().min(1).max(80),
});
export type CardPopPageAction = z.infer<typeof CardPopPageActionSchema>;

export const CardOpenActionSchema = z.object({
  kind: z.literal("open"),
  id: z.string().min(1).max(80),
  url: z.string().min(1).max(2_000),
});
export type CardOpenAction = z.infer<typeof CardOpenActionSchema>;

export const CardActionSchema = z.discriminatedUnion("kind", [
  CardReplyActionSchema,
  CardPushPageActionSchema,
  CardPopPageActionSchema,
  CardOpenActionSchema,
]);
export type CardAction = z.infer<typeof CardActionSchema>;

export const CardFieldOptionSchema = z.object({
  value: z.string().min(1).max(200),
  label: z.string().min(1).max(160).optional(),
  description: z.string().max(240).optional(),
});
export type CardFieldOption = z.infer<typeof CardFieldOptionSchema>;

export const CardFieldKindSchema = z.enum([
  "toggle",
  "choice",
  "multichoice",
  "text",
  "multiline",
  "number",
  "date",
  "time",
  "datetime",
]);
export type CardFieldKind = z.infer<typeof CardFieldKindSchema>;

export const CardDividerItemSchema = z.object({
  type: z.literal("divider"),
  key: z.string().max(80).optional(),
  label: z.string().max(80).optional(),
});

export const CardEmptyItemSchema = z.object({
  type: z.literal("empty"),
  key: z.string().max(80).optional(),
  icon: z.string().max(40).optional(),
  title: z.string().min(1).max(160),
  description: z.string().max(500).optional(),
  action: CardActionSchema.optional(),
  actionLabel: z.string().max(80).optional(),
});

export const CardLoadingItemSchema = z.object({
  type: z.literal("loading"),
  key: z.string().max(80).optional(),
  label: z.string().max(160).optional(),
});

export const CardTextItemSchema = z.object({
  type: z.literal("text"),
  key: z.string().max(80).optional(),
  text: z.string().min(1).max(4_000),
  tone: CardToneSchema.optional(),
  size: z.enum(["sm", "md", "lg"]).optional(),
  mono: z.boolean().optional(),
});

export const CardMarkdownItemSchema = z.object({
  type: z.literal("markdown"),
  key: z.string().max(80).optional(),
  content: z.string().min(1).max(16_000),
});

export const CardMetricEntrySchema = z.object({
  key: z.string().max(80).optional(),
  label: z.string().min(1).max(120),
  value: z.string().min(1).max(80),
  unit: z.string().max(32).optional(),
  delta: z.string().max(60).optional(),
  trend: z.enum(["up", "down", "flat"]).optional(),
  tone: CardToneSchema.optional(),
  sparkline: z.array(z.number().finite()).max(60).optional(),
});
export type CardMetricEntry = z.infer<typeof CardMetricEntrySchema>;

export const CardMetricItemSchema = CardMetricEntrySchema.extend({
  type: z.literal("metric"),
});

export const CardStatGridItemSchema = z.object({
  type: z.literal("stat_grid"),
  key: z.string().max(80).optional(),
  items: z.array(CardMetricEntrySchema).min(1).max(INTERACTIVE_CARD_MAX_STAT_GRID_ITEMS),
});

export const CardProgressItemSchema = z.object({
  type: z.literal("progress"),
  key: z.string().max(80).optional(),
  label: z.string().max(160).optional(),
  value: z.number().finite().min(0),
  max: z.number().finite().positive().optional(),
  displayValue: z.string().max(60).optional(),
  tone: CardToneSchema.optional(),
  indeterminate: z.boolean().optional(),
});

export const CardChecklistEntrySchema = z.object({
  id: z.string().max(80).optional(),
  label: z.string().min(1).max(240),
  detail: z.string().max(400).optional(),
  status: z.enum(["pending", "in_progress", "done", "failed", "skipped"]),
  badge: CardBadgeSchema.optional(),
});
export type CardChecklistEntry = z.infer<typeof CardChecklistEntrySchema>;

export const CardChecklistItemSchema = z.object({
  type: z.literal("checklist"),
  key: z.string().max(80).optional(),
  variant: z.enum(["list", "steps"]).optional(),
  items: z.array(CardChecklistEntrySchema).min(1).max(INTERACTIVE_CARD_MAX_CHECKLIST_ITEMS),
});

export const CardTableColumnSchema = z.object({
  key: z.string().min(1).max(60),
  label: z.string().min(1).max(80),
  align: z.enum(["left", "center", "right"]).optional(),
  sortable: z.boolean().optional(),
});
export type CardTableColumn = z.infer<typeof CardTableColumnSchema>;

export const CardTableCellSchema = z.union([
  z.string().max(400),
  z.number().finite(),
  z.object({
    text: z.string().max(400),
    tone: CardToneSchema.optional(),
    badge: z.boolean().optional(),
    mono: z.boolean().optional(),
  }),
]);
export type CardTableCell = z.infer<typeof CardTableCellSchema>;

export const CardTableItemSchema = z.object({
  type: z.literal("table"),
  key: z.string().max(80).optional(),
  columns: z.array(CardTableColumnSchema).min(1).max(INTERACTIVE_CARD_MAX_TABLE_COLUMNS),
  rows: z.array(z.record(z.string(), CardTableCellSchema)).max(INTERACTIVE_CARD_MAX_TABLE_ROWS),
  caption: z.string().max(240).optional(),
});

export const CardChartSeriesSchema = z.object({
  name: z.string().min(1).max(80),
  values: z.array(z.number().finite()).min(1).max(INTERACTIVE_CARD_MAX_CHART_POINTS),
  tone: CardToneSchema.optional(),
});
export type CardChartSeries = z.infer<typeof CardChartSeriesSchema>;

export const CardChartSliceSchema = z.object({
  label: z.string().min(1).max(80),
  value: z.number().finite().min(0),
  tone: CardToneSchema.optional(),
});
export type CardChartSlice = z.infer<typeof CardChartSliceSchema>;

export const CardChartItemSchema = z.object({
  type: z.literal("chart"),
  key: z.string().max(80).optional(),
  chartType: z.enum(["bar", "line", "pie", "donut"]),
  title: z.string().max(160).optional(),
  caption: z.string().max(240).optional(),
  unit: z.string().max(32).optional(),
  categories: z.array(z.string().max(60)).max(INTERACTIVE_CARD_MAX_CHART_POINTS).optional(),
  series: z.array(CardChartSeriesSchema).max(INTERACTIVE_CARD_MAX_CHART_SERIES).optional(),
  slices: z.array(CardChartSliceSchema).max(32).optional(),
  stacked: z.boolean().optional(),
  area: z.boolean().optional(),
  center: z
    .object({
      value: z.string().min(1).max(40),
      label: z.string().max(80).optional(),
    })
    .optional(),
});

export const CardCodeItemSchema = z.object({
  type: z.literal("code"),
  key: z.string().max(80).optional(),
  title: z.string().max(160).optional(),
  language: z.string().max(40).optional(),
  code: z.string().max(24_000),
  maxLines: z.number().int().min(1).max(200).optional(),
});

export const CardDiffItemSchema = z.object({
  type: z.literal("diff"),
  key: z.string().max(80).optional(),
  title: z.string().max(160).optional(),
  filePath: z.string().max(400).optional(),
  diff: z.string().max(32_000),
});

export const CardFileTreeNodeSchema = z.object({
  path: z.string().min(1).max(400),
  label: z.string().max(160).optional(),
  kind: z.enum(["file", "dir"]).optional(),
  status: z.enum(["added", "modified", "deleted", "renamed", "untracked"]).optional(),
  detail: z.string().max(120).optional(),
});
export type CardFileTreeNode = z.infer<typeof CardFileTreeNodeSchema>;

export const CardFileTreeItemSchema = z.object({
  type: z.literal("file_tree"),
  key: z.string().max(80).optional(),
  title: z.string().max(160).optional(),
  nodes: z.array(CardFileTreeNodeSchema).min(1).max(INTERACTIVE_CARD_MAX_FILE_TREE_NODES),
});

export const CardImageItemSchema = z.object({
  type: z.literal("image"),
  key: z.string().max(80).optional(),
  src: z.string().min(1).max(2_000),
  alt: z.string().max(200).optional(),
  caption: z.string().max(240).optional(),
  aspectRatio: z.number().finite().positive().max(10).optional(),
});

export const CardRowItemSchema = z.object({
  type: z.literal("row"),
  key: z.string().max(80).optional(),
  icon: z.string().max(40).optional(),
  iconTone: CardToneSchema.optional(),
  title: z.string().min(1).max(200),
  subtitle: z.string().max(400).optional(),
  value: z.string().max(120).optional(),
  badge: CardBadgeSchema.optional(),
  sparkline: z.array(z.number().finite()).max(60).optional(),
  action: CardActionSchema.optional(),
});

export const CardButtonItemSchema = z.object({
  type: z.literal("button"),
  key: z.string().max(80).optional(),
  label: z.string().min(1).max(80),
  variant: z.enum(["primary", "secondary", "danger", "ghost"]).optional(),
  icon: z.string().max(40).optional(),
  action: CardActionSchema,
});

export const CardLinkItemSchema = z.object({
  type: z.literal("link"),
  key: z.string().max(80).optional(),
  label: z.string().min(1).max(160),
  subtitle: z.string().max(240).optional(),
  url: z.string().min(1).max(2_000),
});

export const CardSegmentedItemSchema = z.object({
  type: z.literal("segmented"),
  key: z.string().max(80).optional(),
  name: z.string().min(1).max(80),
  label: z.string().max(160).optional(),
  value: z.string().max(200).optional(),
  options: z.array(CardFieldOptionSchema).min(2).max(5),
  action: CardActionSchema.optional(),
});

export const CardFieldItemSchema = z.object({
  type: z.literal("field"),
  key: z.string().max(80).optional(),
  name: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
  detail: z.string().max(320).optional(),
  kind: CardFieldKindSchema,
  value: z.string().max(INTERACTIVE_CARD_MAX_FIELD_VALUE_CHARS).optional(),
  placeholder: z.string().max(160).optional(),
  required: z.boolean().optional(),
  options: z.array(CardFieldOptionSchema).max(INTERACTIVE_CARD_MAX_FIELD_OPTIONS).optional(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  step: z.number().finite().positive().optional(),
  maxLength: z.number().int().positive().max(INTERACTIVE_CARD_MAX_FIELD_VALUE_CHARS).optional(),
});

export const CardGridChildSchema = z.discriminatedUnion("type", [
  CardTextItemSchema,
  CardMetricItemSchema,
  CardProgressItemSchema,
  CardImageItemSchema,
  CardRowItemSchema,
]);
export type CardGridChild = z.infer<typeof CardGridChildSchema>;

export const CardGridItemSchema = z.object({
  type: z.literal("grid"),
  key: z.string().max(80).optional(),
  columns: z.union([z.literal(2), z.literal(3)]).optional(),
  items: z.array(CardGridChildSchema).min(1).max(12),
});

export const CardCarouselEntrySchema = z.object({
  key: z.string().max(80).optional(),
  title: z.string().min(1).max(160),
  subtitle: z.string().max(240).optional(),
  value: z.string().max(80).optional(),
  image: z.string().max(2_000).optional(),
  badge: CardBadgeSchema.optional(),
  action: CardActionSchema.optional(),
});
export type CardCarouselEntry = z.infer<typeof CardCarouselEntrySchema>;

export const CardCarouselItemSchema = z.object({
  type: z.literal("carousel"),
  key: z.string().max(80).optional(),
  items: z.array(CardCarouselEntrySchema).min(1).max(INTERACTIVE_CARD_MAX_CAROUSEL_ITEMS),
});

export const CardItemSchema = z.discriminatedUnion("type", [
  CardDividerItemSchema,
  CardEmptyItemSchema,
  CardLoadingItemSchema,
  CardTextItemSchema,
  CardMarkdownItemSchema,
  CardMetricItemSchema,
  CardStatGridItemSchema,
  CardProgressItemSchema,
  CardChecklistItemSchema,
  CardTableItemSchema,
  CardChartItemSchema,
  CardCodeItemSchema,
  CardDiffItemSchema,
  CardFileTreeItemSchema,
  CardImageItemSchema,
  CardRowItemSchema,
  CardButtonItemSchema,
  CardLinkItemSchema,
  CardSegmentedItemSchema,
  CardFieldItemSchema,
  CardGridItemSchema,
  CardCarouselItemSchema,
]);
export type CardItem = z.infer<typeof CardItemSchema>;

export const CardSectionSchema = z.object({
  id: z.string().max(80).optional(),
  title: z.string().max(160).optional(),
  subtitle: z.string().max(300).optional(),
  footer: z.string().max(300).optional(),
  layout: z.enum(["stack", "grid"]).optional(),
  items: z.array(CardItemSchema).min(1).max(INTERACTIVE_CARD_MAX_ITEMS_PER_SECTION),
});
export type CardSection = z.infer<typeof CardSectionSchema>;

export const CardPageSchema = z.object({
  title: z.string().max(160).optional(),
  subtitle: z.string().max(300).optional(),
  fallback: z.string().max(INTERACTIVE_CARD_MAX_FALLBACK_CHARS).optional(),
  sections: z.array(CardSectionSchema).min(1).max(INTERACTIVE_CARD_MAX_SECTIONS),
});
export type CardPage = z.infer<typeof CardPageSchema>;

export const InteractiveCardViewSchema = z.object({
  version: z.literal(1).optional(),
  title: z.string().max(160).optional(),
  subtitle: z.string().max(300).optional(),
  fallback: z.string().min(1).max(INTERACTIVE_CARD_MAX_FALLBACK_CHARS),
  sections: z.array(CardSectionSchema).min(1).max(INTERACTIVE_CARD_MAX_SECTIONS),
  pages: z.record(z.string(), CardPageSchema).optional(),
});
export type InteractiveCardView = z.infer<typeof InteractiveCardViewSchema>;

// ============================================================================
// Runtime Records & WebSocket RPC Schemas
// ============================================================================

export const InteractiveLiveCardRecordSchema = z.object({
  id: z.string().min(1).max(80),
  agentId: z.string().min(1).max(160),
  callId: z.string().max(160).optional(),
  version: z.number().int().min(1),
  view: InteractiveCardViewSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InteractiveLiveCardRecord = z.infer<typeof InteractiveLiveCardRecordSchema>;

export const InteractiveCardActionStatusSchema = z.enum(["pending", "sent", "failed"]);
export type InteractiveCardActionStatus = z.infer<typeof InteractiveCardActionStatusSchema>;

export const InteractiveCardActionRecordSchema = z.object({
  cardKey: z.string().min(1).max(160),
  actionId: z.string().min(1).max(80),
  page: z.string().max(80).optional(),
  values: z.record(z.string(), z.string()).optional(),
  version: z.number().int().min(1),
  clientMessageId: z.string().min(1).max(160),
  text: z.string().max(8_000),
  status: InteractiveCardActionStatusSchema,
  error: z.string().max(500).optional(),
  revision: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InteractiveCardActionRecord = z.infer<typeof InteractiveCardActionRecordSchema>;

export const InteractiveCardSubmitErrorCodeSchema = z.enum([
  "already_answered",
  "view_changed",
  "validation_failed",
  "unregistered_card",
  "agent_archived",
  "delivery_failed",
  "not_found",
]);
export type InteractiveCardSubmitErrorCode = z.infer<typeof InteractiveCardSubmitErrorCodeSchema>;

export const AgentCardsListRequestSchema = z.object({
  type: z.literal("agent.cards.list.request"),
  requestId: z.string().min(1),
  agentId: z.string().min(1),
});
export type AgentCardsListRequest = z.infer<typeof AgentCardsListRequestSchema>;

export const AgentCardsListResponsePayloadSchema = z.object({
  requestId: z.string().min(1),
  agentId: z.string().min(1),
  views: z.array(InteractiveLiveCardRecordSchema),
  inlineBlockKeys: z.array(z.string()),
  actions: z.array(InteractiveCardActionRecordSchema),
  error: z.string().nullable().optional(),
});
export type AgentCardsListResponsePayload = z.infer<typeof AgentCardsListResponsePayloadSchema>;

export const AgentCardsListResponseSchema = z.object({
  type: z.literal("agent.cards.list.response"),
  payload: AgentCardsListResponsePayloadSchema,
});
export type AgentCardsListResponse = z.infer<typeof AgentCardsListResponseSchema>;

export const AgentCardsSubmitRequestSchema = z.object({
  type: z.literal("agent.cards.submit.request"),
  requestId: z.string().min(1),
  agentId: z.string().min(1),
  cardKey: z.string().min(1).max(160),
  actionId: z.string().min(1).max(80),
  page: z.string().max(80).optional(),
  values: z.record(z.string(), z.string()).optional(),
  expectedVersion: z.number().int().min(1),
  clientMessageId: z.string().min(1).max(160),
  confirmed: z.boolean().optional(),
});
export type AgentCardsSubmitRequest = z.infer<typeof AgentCardsSubmitRequestSchema>;

export const AgentCardsSubmitResponsePayloadSchema = z.object({
  requestId: z.string().min(1),
  agentId: z.string().min(1),
  cardKey: z.string().min(1),
  ok: z.boolean(),
  action: InteractiveCardActionRecordSchema.optional(),
  view: InteractiveLiveCardRecordSchema.optional(),
  code: InteractiveCardSubmitErrorCodeSchema.optional(),
  error: z.string().nullable().optional(),
  fieldErrors: z.record(z.string(), z.string()).optional(),
});
export type AgentCardsSubmitResponsePayload = z.infer<typeof AgentCardsSubmitResponsePayloadSchema>;

export const AgentCardsSubmitResponseSchema = z.object({
  type: z.literal("agent.cards.submit.response"),
  payload: AgentCardsSubmitResponsePayloadSchema,
});
export type AgentCardsSubmitResponse = z.infer<typeof AgentCardsSubmitResponseSchema>;

export const AgentCardsUpdateEventPayloadSchema = z.object({
  agentId: z.string().min(1),
  kind: z.enum(["view_upserted", "inline_registered", "action_updated"]),
  view: InteractiveLiveCardRecordSchema.optional(),
  inlineBlockKey: z.string().optional(),
  action: InteractiveCardActionRecordSchema.optional(),
});
export type AgentCardsUpdateEventPayload = z.infer<typeof AgentCardsUpdateEventPayloadSchema>;

export const AgentCardsUpdateEventSchema = z.object({
  type: z.literal("agent.cards.update"),
  payload: AgentCardsUpdateEventPayloadSchema,
});
export type AgentCardsUpdateEvent = z.infer<typeof AgentCardsUpdateEventSchema>;

// ============================================================================
// Shared Synchronous Pure-TS SHA-256 & Deterministic Card Key Helpers
// ============================================================================

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function utf8Bytes(input: string): Uint8Array {
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(input);
  }
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = ((code - 0xd800) << 10) + (next - 0xdc00) + 0x10000;
        i += 1;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/** Synchronous FIPS 180-4 SHA-256 hex digest that works identically in Node, Web, and Hermes. */
export function sha256HexSync(input: string): string {
  const data = utf8Bytes(input);
  const bitLen = data.length * 8;
  const paddedLen = Math.ceil((data.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(data);
  buf[data.length] = 0x80;
  const view = new DataView(buf.buffer);
  const highBits = Math.floor(bitLen / 0x1_0000_0000);
  const lowBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, highBits, false);
  view.setUint32(paddedLen - 4, lowBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^
        ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^
        (w[i - 15] >>> 3);
      const s1 =
        ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^
        ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^
        (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, "0"))
    .join("");
}

export function normalizeAssistantMessageForCardHash(messageText: string): string {
  return messageText.replace(/\r\n/g, "\n").trim();
}

export function computeInlineCardKey(messageText: string, blockIndex: number): string {
  const hash = sha256HexSync(normalizeAssistantMessageForCardHash(messageText)).slice(0, 16);
  return `inline:${hash}/${blockIndex}`;
}

export function isLiveCardKey(cardKey: string): boolean {
  return /^view_[a-f0-9]{8,32}$/.test(cardKey);
}

export function isInlineCardKey(cardKey: string): boolean {
  return /^inline:[a-f0-9]{16}\/[0-2]$/.test(cardKey);
}

export function isInteractiveCardToolName(toolName: string): InteractiveCardToolKind | null {
  const lower = toolName.trim().toLowerCase();
  if (lower === "view_show" || lower.endsWith("__view_show") || lower.endsWith(":view_show")) {
    return "view_show";
  }
  if (
    lower === "view_update" ||
    lower.endsWith("__view_update") ||
    lower.endsWith(":view_update")
  ) {
    return "view_update";
  }
  if (lower === "view_get" || lower.endsWith("__view_get") || lower.endsWith(":view_get")) {
    return "view_get";
  }
  return null;
}

// ============================================================================
// Fenced Block Extraction & Streaming Fallback Helper
// ============================================================================

export interface ExtractedCardFenceBlock {
  language: string;
  raw: string;
  complete: boolean;
  blockIndex: number;
  start: number;
  end: number;
}

/**
 * Extracts all fenced code blocks matching `paseo-view` from Markdown text.
 * Supports 3+ backtick/tilde fences and reports unclosed streaming blocks with `complete: false`.
 */
export function extractFencedCardBlocks(markdown: string): ExtractedCardFenceBlock[] {
  if (!markdown.toLowerCase().includes(INTERACTIVE_CARD_FENCE_LANGUAGE)) {
    return [];
  }

  const results: ExtractedCardFenceBlock[] = [];
  const len = markdown.length;
  let pos = 0;
  let blockIndex = 0;

  while (pos < len) {
    const lineStart = pos;
    let lineEnd = markdown.indexOf("\n", pos);
    const hasNewline = lineEnd !== -1;
    if (!hasNewline) lineEnd = len;
    const rawLine = markdown.slice(lineStart, lineEnd);
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    pos = hasNewline ? lineEnd + 1 : len;

    const openMatch = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(line);
    if (!openMatch) continue;

    const fence = openMatch[1];
    const fenceChar = fence[0];
    const fenceLen = fence.length;
    const info = openMatch[2].trim();
    const langToken = info.split(/\s+/)[0]?.toLowerCase() ?? "";

    const bodyStart = pos;
    let bodyEnd = len;
    let blockEnd = len;
    let complete = false;

    while (pos < len) {
      const scanStart = pos;
      let scanEnd = markdown.indexOf("\n", pos);
      const scanHasNewline = scanEnd !== -1;
      if (!scanHasNewline) scanEnd = len;
      const scanRawLine = markdown.slice(scanStart, scanEnd);
      const scanLine = scanRawLine.endsWith("\r") ? scanRawLine.slice(0, -1) : scanRawLine;
      pos = scanHasNewline ? scanEnd + 1 : len;

      const closeMatch = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(scanLine);
      if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
        bodyEnd = scanStart;
        blockEnd = pos;
        complete = true;
        break;
      }
    }

    if (langToken === INTERACTIVE_CARD_FENCE_LANGUAGE) {
      const raw = markdown.slice(bodyStart, bodyEnd).replace(/\r\n/g, "\n").trim();
      results.push({
        language: langToken,
        raw,
        complete,
        blockIndex,
        start: lineStart,
        end: blockEnd,
      });
      blockIndex += 1;
    }
  }

  return results;
}

/** Extracts the `"fallback"` string from complete or partial JSON so raw JSON never flashes. */
export function extractFallbackFromRawCardJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "fallback" in parsed &&
      typeof (parsed as { fallback?: unknown }).fallback === "string"
    ) {
      const text = (parsed as { fallback: string }).fallback.trim();
      if (text.length > 0) return text.slice(0, INTERACTIVE_CARD_MAX_FALLBACK_CHARS);
    }
  } catch {
    // Fall through to best-effort regex extraction for streaming/malformed JSON.
  }

  const match = /"fallback"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(trimmed);
  if (!match) return null;
  try {
    const decoded = JSON.parse(`"${match[1]}"`) as string;
    const text = decoded.trim();
    return text.length > 0 ? text.slice(0, INTERACTIVE_CARD_MAX_FALLBACK_CHARS) : null;
  } catch {
    return null;
  }
}

// ============================================================================
// URL Policy, Normalization, and Semantic Validation
// ============================================================================

const ALLOWED_PASEO_HOSTS = new Set(["agent", "file", "workspace"]);

export function isAllowedCardUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "https:") {
    return Boolean(parsed.hostname);
  }
  if (protocol === "paseo:") {
    return ALLOWED_PASEO_HOSTS.has(parsed.hostname.toLowerCase()) && parsed.pathname.length > 1;
  }
  return false;
}

export function isAllowedCardImageSrc(rawSrc: string): boolean {
  const trimmed = rawSrc.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^https:\/\//i.test(trimmed)) {
    return isAllowedCardUrl(trimmed);
  }
  // Allow clean relative workspace paths without scheme or traversal outside root
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return false;
  }
  if (trimmed.startsWith("//") || trimmed.includes("..")) {
    return false;
  }
  return true;
}

const SINGLE_ITEM_TYPES = new Set([
  "divider",
  "empty",
  "loading",
  "text",
  "markdown",
  "metric",
  "stat_grid",
  "progress",
  "checklist",
  "steps",
  "table",
  "chart",
  "code",
  "diff",
  "file_tree",
  "image",
  "row",
  "button",
  "link",
  "segmented",
  "field",
  "grid",
  "carousel",
]);

function normalizeItemObject(rawItem: unknown): unknown {
  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) {
    return rawItem;
  }
  const obj = { ...(rawItem as Record<string, unknown>) };

  // Support friendly "steps" alias -> checklist(variant: "steps")
  if (obj.type === "steps") {
    obj.type = "checklist";
    if (obj.variant === undefined) {
      obj.variant = "steps";
    }
    if (obj.items === undefined && Array.isArray(obj.steps)) {
      obj.items = obj.steps;
      delete obj.steps;
    }
  }

  // Normalize string choice options ["a", "b"] -> [{ value: "a", label: "a" }]
  if ((obj.type === "field" || obj.type === "segmented") && Array.isArray(obj.options)) {
    obj.options = obj.options.map((opt) =>
      typeof opt === "string" ? { value: opt, label: opt } : opt,
    );
  }
  if (obj.type === "field" && obj.options === undefined && Array.isArray(obj.choices)) {
    obj.options = (obj.choices as unknown[]).map((opt) =>
      typeof opt === "string" ? { value: opt, label: opt } : opt,
    );
    delete obj.choices;
  }
  if (obj.type === "field" && typeof obj.value === "boolean") {
    obj.value = obj.value ? "true" : "false";
  }
  if (obj.type === "field" && typeof obj.value === "number") {
    obj.value = String(obj.value);
  }

  return obj;
}

function normalizeSectionObject(rawSection: unknown): unknown {
  if (!rawSection || typeof rawSection !== "object" || Array.isArray(rawSection)) {
    return rawSection;
  }
  const section = { ...(rawSection as Record<string, unknown>) };
  if (Array.isArray(section.items)) {
    section.items = section.items.map(normalizeItemObject);
  }
  return section;
}

const KEEP_ITEM_TITLE_TYPES = new Set(["chart", "row", "empty", "code", "diff", "file_tree"]);

function normalizeSingleItemShorthand(raw: Record<string, unknown>): Record<string, unknown> {
  const itemCopy = { ...raw };
  const title = typeof itemCopy.title === "string" ? itemCopy.title : undefined;
  const subtitle = typeof itemCopy.subtitle === "string" ? itemCopy.subtitle : undefined;
  const fallback = typeof itemCopy.fallback === "string" ? itemCopy.fallback : undefined;
  delete itemCopy.fallback;
  delete itemCopy.subtitle;
  if (typeof raw.type === "string" && !KEEP_ITEM_TITLE_TYPES.has(raw.type)) {
    delete itemCopy.title;
  }
  return {
    version: 1,
    ...(title ? { title } : {}),
    ...(subtitle ? { subtitle } : {}),
    ...(fallback !== undefined ? { fallback } : {}),
    sections: [{ items: [normalizeItemObject(itemCopy)] }],
  };
}

function normalizePagesRecord(pages: Record<string, unknown>): Record<string, unknown> {
  const nextPages: Record<string, unknown> = {};
  for (const [pageKey, pageVal] of Object.entries(pages)) {
    if (!pageVal || typeof pageVal !== "object" || Array.isArray(pageVal)) {
      nextPages[pageKey] = pageVal;
      continue;
    }
    const pageObj = { ...(pageVal as Record<string, unknown>) };
    if (Array.isArray(pageObj.sections)) {
      pageObj.sections = pageObj.sections.map(normalizeSectionObject);
    }
    nextPages[pageKey] = pageObj;
  }
  return nextPages;
}

/**
 * Explicit normalization pass (kept outside Zod wire schemas for zod-aot compatibility).
 * Wraps single-component shorthand objects into a standard `InteractiveCardView` and normalizes
 * minor aliases (`steps` -> `checklist`, string options -> `{ value, label }`).
 */
export function normalizeInteractiveCardViewInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return input;
  }
  const raw = input as Record<string, unknown>;
  if (
    !Array.isArray(raw.sections) &&
    typeof raw.type === "string" &&
    SINGLE_ITEM_TYPES.has(raw.type)
  ) {
    return normalizeSingleItemShorthand(raw);
  }

  const normalized: Record<string, unknown> = { ...raw };
  if (Array.isArray(normalized.sections)) {
    normalized.sections = normalized.sections.map(normalizeSectionObject);
  }
  if (
    normalized.pages &&
    typeof normalized.pages === "object" &&
    !Array.isArray(normalized.pages)
  ) {
    normalized.pages = normalizePagesRecord(normalized.pages as Record<string, unknown>);
  }
  return normalized;
}

export type InteractiveCardValidationResult =
  | { ok: true; view: InteractiveCardView }
  | { ok: false; errors: string[] };

function checkSectionsForForbiddenFeatures(raw: unknown, path: string, errors: string[]): void {
  if (!raw || typeof raw !== "object") return;
  if (Array.isArray(raw)) {
    raw.forEach((entry, idx) =>
      checkSectionsForForbiddenFeatures(entry, `${path}[${idx}]`, errors),
    );
    return;
  }
  const obj = raw as Record<string, unknown>;
  if (obj.type === "field" && (obj.kind === "secret" || obj.kind === "password")) {
    errors.push(`${path}.kind: secret/password fields are forbidden in interactive cards`);
  }
  if (obj.type === "html") {
    errors.push(`${path}.type: raw html components are not supported`);
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "pages" && path.startsWith("pages.")) {
      errors.push(`${path}.pages: nested pages are not allowed`);
      continue;
    }
    if (v && typeof v === "object") {
      checkSectionsForForbiddenFeatures(v, path ? `${path}.${k}` : k, errors);
    }
  }
}

function collectAction(
  action: CardAction,
  path: string,
  actionIds: Set<string>,
  pageNames: Set<string>,
  fieldNames: Set<string>,
  errors: string[],
): void {
  if (actionIds.has(action.id)) {
    errors.push(`${path}.id: duplicate action id "${action.id}"`);
  } else {
    actionIds.add(action.id);
  }
  if (action.kind === "open" && !isAllowedCardUrl(action.url)) {
    errors.push(`${path}.url: only https:// or paseo://agent|file|workspace URLs are allowed`);
  }
  if (action.kind === "push_page" && !pageNames.has(action.page)) {
    errors.push(`${path}.page: target page "${action.page}" is not defined in pages`);
  }
  if (action.kind === "reply" && action.requireFields) {
    for (const reqField of action.requireFields) {
      if (!fieldNames.has(reqField)) {
        errors.push(`${path}.requireFields: field "${reqField}" does not exist on this page`);
      }
    }
  }
}

function validateFieldSemantics(
  item: Extract<CardItem, { type: "field" }>,
  itemPath: string,
  errors: string[],
): void {
  if (
    (item.kind === "choice" || item.kind === "multichoice") &&
    (!item.options || item.options.length === 0)
  ) {
    errors.push(`${itemPath}.options: ${item.kind} field requires at least 1 option`);
  }
  if (
    item.kind === "toggle" &&
    item.value !== undefined &&
    item.value !== "true" &&
    item.value !== "false"
  ) {
    errors.push(`${itemPath}.value: toggle field value must be "true" or "false"`);
  }
  if (
    item.kind === "number" &&
    item.min !== undefined &&
    item.max !== undefined &&
    item.min > item.max
  ) {
    errors.push(`${itemPath}.min: min cannot be greater than max`);
  }
}

function validateChartSemantics(
  item: Extract<CardItem, { type: "chart" }>,
  itemPath: string,
  errors: string[],
): void {
  if (item.chartType === "pie" || item.chartType === "donut") {
    if (!item.slices || item.slices.length === 0) {
      errors.push(`${itemPath}.slices: ${item.chartType} chart requires non-empty slices`);
    }
    return;
  }
  if (!item.series || item.series.length === 0) {
    errors.push(`${itemPath}.series: ${item.chartType} chart requires non-empty series`);
    return;
  }
  const expectedLen = item.categories?.length ?? item.series[0].values.length;
  item.series.forEach((s, seriesIdx) => {
    if (s.values.length !== expectedLen) {
      errors.push(
        `${itemPath}.series[${seriesIdx}].values: length (${s.values.length}) must match categories/series length (${expectedLen})`,
      );
    }
  });
}

function validateTableSemantics(
  item: Extract<CardItem, { type: "table" }>,
  itemPath: string,
  errors: string[],
): void {
  const colKeys = new Set<string>();
  for (const col of item.columns) {
    if (colKeys.has(col.key)) {
      errors.push(`${itemPath}.columns: duplicate column key "${col.key}"`);
    }
    colKeys.add(col.key);
  }
}

function validateSingleCardItem(
  item: CardItem,
  itemPath: string,
  actionIds: Set<string>,
  pageNames: Set<string>,
  fieldNames: Set<string>,
  errors: string[],
): void {
  switch (item.type) {
    case "row":
    case "empty":
    case "segmented":
      if (item.action) {
        collectAction(item.action, `${itemPath}.action`, actionIds, pageNames, fieldNames, errors);
      }
      return;
    case "button":
      collectAction(item.action, `${itemPath}.action`, actionIds, pageNames, fieldNames, errors);
      return;
    case "link":
      if (!isAllowedCardUrl(item.url)) {
        errors.push(
          `${itemPath}.url: only https:// or paseo://agent|file|workspace URLs are allowed`,
        );
      }
      return;
    case "image":
      if (!isAllowedCardImageSrc(item.src)) {
        errors.push(
          `${itemPath}.src: only https:// or safe workspace relative image paths are allowed`,
        );
      }
      return;
    case "grid":
      item.items.forEach((child, cIdx) => {
        if (child.type === "image" && !isAllowedCardImageSrc(child.src)) {
          errors.push(`${itemPath}.items[${cIdx}].src: disallowed image src`);
        }
        if (child.type === "row" && child.action) {
          collectAction(
            child.action,
            `${itemPath}.items[${cIdx}].action`,
            actionIds,
            pageNames,
            fieldNames,
            errors,
          );
        }
      });
      return;
    case "carousel":
      item.items.forEach((entry, cIdx) => {
        if (entry.image && !isAllowedCardImageSrc(entry.image)) {
          errors.push(`${itemPath}.items[${cIdx}].image: disallowed image src`);
        }
        if (entry.action) {
          collectAction(
            entry.action,
            `${itemPath}.items[${cIdx}].action`,
            actionIds,
            pageNames,
            fieldNames,
            errors,
          );
        }
      });
      return;
    case "field":
      validateFieldSemantics(item, itemPath, errors);
      return;
    case "chart":
      validateChartSemantics(item, itemPath, errors);
      return;
    case "table":
      validateTableSemantics(item, itemPath, errors);
      return;
    default:
      return;
  }
}

function validatePageSections(
  sections: CardSection[],
  prefix: string,
  pageNames: Set<string>,
  errors: string[],
): void {
  const fieldNames = new Set<string>();
  const actionIds = new Set<string>();

  sections.forEach((section, sIdx) => {
    section.items.forEach((item, iIdx) => {
      if (item.type === "field" || item.type === "segmented") {
        if (fieldNames.has(item.name)) {
          errors.push(
            `${prefix}sections[${sIdx}].items[${iIdx}].name: duplicate field "${item.name}"`,
          );
        } else {
          fieldNames.add(item.name);
        }
      }
    });
  });

  sections.forEach((section, sIdx) => {
    section.items.forEach((item, iIdx) => {
      validateSingleCardItem(
        item,
        `${prefix}sections[${sIdx}].items[${iIdx}]`,
        actionIds,
        pageNames,
        fieldNames,
        errors,
      );
    });
  });
}

export function validateInteractiveCardView(input: unknown): InteractiveCardValidationResult {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    return { ok: false, errors: ["view must be JSON-serializable"] };
  }
  if (typeof serialized !== "string") {
    return { ok: false, errors: ["view must be an object"] };
  }
  const byteSize = utf8Bytes(serialized).byteLength;
  if (byteSize > INTERACTIVE_CARD_MAX_BYTES) {
    return {
      ok: false,
      errors: [
        `view exceeds maximum size of ${INTERACTIVE_CARD_MAX_BYTES} bytes (${byteSize} bytes)`,
      ],
    };
  }

  const forbiddenErrors: string[] = [];
  checkSectionsForForbiddenFeatures(input, "", forbiddenErrors);
  if (forbiddenErrors.length > 0) {
    return { ok: false, errors: forbiddenErrors };
  }

  const normalized = normalizeInteractiveCardViewInput(input);
  const parsed = InteractiveCardViewSchema.safeParse(normalized);
  if (!parsed.success) {
    const errors = parsed.error.issues.slice(0, 12).map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "view";
      return `${path}: ${issue.message}`;
    });
    return { ok: false, errors };
  }

  const view = parsed.data;
  const semanticErrors: string[] = [];
  const pageNames = new Set(Object.keys(view.pages ?? {}));
  if (pageNames.size > INTERACTIVE_CARD_MAX_PAGES) {
    semanticErrors.push(`pages: at most ${INTERACTIVE_CARD_MAX_PAGES} named pages allowed`);
  }

  validatePageSections(view.sections, "", pageNames, semanticErrors);
  if (view.pages) {
    for (const [pageName, pageDef] of Object.entries(view.pages)) {
      validatePageSections(pageDef.sections, `pages.${pageName}.`, pageNames, semanticErrors);
    }
  }

  if (semanticErrors.length > 0) {
    return { ok: false, errors: semanticErrors.slice(0, 16) };
  }

  return { ok: true, view };
}

function collectItemActions(item: CardItem, actions: Map<string, CardAction>): void {
  if (item.type === "button") {
    actions.set(item.action.id, item.action);
    return;
  }
  if ((item.type === "row" || item.type === "empty" || item.type === "segmented") && item.action) {
    actions.set(item.action.id, item.action);
    return;
  }
  if (item.type === "grid") {
    for (const child of item.items) {
      if (child.type === "row" && child.action) {
        actions.set(child.action.id, child.action);
      }
    }
    return;
  }
  if (item.type === "carousel") {
    for (const entry of item.items) {
      if (entry.action) {
        actions.set(entry.action.id, entry.action);
      }
    }
  }
}

/** Finds all fields & actions declared on a given page (empty/undefined = root page). */
export function resolveCardPageSurface(
  view: InteractiveCardView,
  page?: string,
): {
  sections: CardSection[];
  fields: Map<string, Extract<CardItem, { type: "field" | "segmented" }>>;
  actions: Map<string, CardAction>;
} | null {
  const sections = page ? view.pages?.[page]?.sections : view.sections;
  if (!sections) return null;
  const fields = new Map<string, Extract<CardItem, { type: "field" | "segmented" }>>();
  const actions = new Map<string, CardAction>();

  for (const section of sections) {
    for (const item of section.items) {
      if (item.type === "field" || item.type === "segmented") {
        fields.set(item.name, item);
      }
      collectItemActions(item, actions);
    }
  }
  return { sections, fields, actions };
}

export function extractDefaultFieldValues(
  view: InteractiveCardView,
  page?: string,
): Record<string, string> {
  const surface = resolveCardPageSurface(view, page);
  if (!surface) return {};
  const defaults: Record<string, string> = {};
  for (const [name, item] of surface.fields.entries()) {
    if (item.type === "field") {
      if (item.value !== undefined) {
        defaults[name] = item.value;
      } else if (item.kind === "toggle") {
        defaults[name] = "false";
      } else if (item.kind === "choice" && item.options && item.options.length > 0) {
        defaults[name] = item.options[0].value;
      } else if (item.kind === "multichoice") {
        defaults[name] = "[]";
      } else {
        defaults[name] = "";
      }
    } else if (item.type === "segmented") {
      defaults[name] = item.value ?? item.options[0]?.value ?? "";
    }
  }
  return defaults;
}
