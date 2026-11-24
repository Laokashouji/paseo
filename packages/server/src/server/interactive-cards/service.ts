import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import {
  computeInlineCardKey,
  extractFencedCardBlocks,
  INTERACTIVE_CARD_MAX_FIELD_VALUE_CHARS,
  INTERACTIVE_CARD_MAX_INLINE_PER_MESSAGE,
  INTERACTIVE_CARD_MAX_LIVE_PER_AGENT,
  isInlineCardKey,
  isLiveCardKey,
  resolveCardPageSurface,
  sha256HexSync,
  validateInteractiveCardView,
  type AgentCardsUpdateEventPayload,
  type CardItem,
  type CardReplyAction,
  type InteractiveCardActionRecord,
  type InteractiveCardSubmitErrorCode,
  type InteractiveCardView,
  type InteractiveLiveCardRecord,
} from "@getpaseo/protocol/interactive-cards";
import { InteractiveCardsStore } from "./store.js";

const UPDATE_BROADCAST_COALESCE_MS = 1_000;
const MAX_VALIDATION_ERRORS_STORED = 10;

export interface DeliverCardReplyInput {
  agentId: string;
  text: string;
  clientMessageId: string;
}

export interface InteractiveCardsServiceOptions {
  paseoHome: string;
  logger: Logger;
  deliverUserReply: (input: DeliverCardReplyInput) => Promise<void>;
  isAgentArchived?: (agentId: string) => boolean | Promise<boolean>;
  updateBroadcastCoalesceMs?: number;
}

export interface AgentCardsSnapshot {
  views: InteractiveLiveCardRecord[];
  inlineBlockKeys: string[];
  actions: InteractiveCardActionRecord[];
}

export type ShowLiveCardResult =
  | { ok: true; card: InteractiveLiveCardRecord }
  | { ok: false; errors: string[] };

export type UpdateLiveCardResult =
  | { ok: true; card: InteractiveLiveCardRecord }
  | {
      ok: false;
      code: "not_found" | "forbidden" | "version_conflict" | "validation_failed";
      errors: string[];
      currentVersion?: number;
    };

export type GetLiveCardResult =
  | { ok: true; card: InteractiveLiveCardRecord; action: InteractiveCardActionRecord | null }
  | { ok: false; code: "not_found" | "forbidden"; error: string };

export interface SubmitCardActionInput {
  agentId: string;
  cardKey: string;
  actionId: string;
  page?: string;
  values?: Record<string, string>;
  expectedVersion: number;
  clientMessageId: string;
  confirmed?: boolean;
}

export interface SubmitCardActionResult {
  ok: boolean;
  action?: InteractiveCardActionRecord;
  view?: InteractiveLiveCardRecord;
  code?: InteractiveCardSubmitErrorCode;
  error?: string;
  fieldErrors?: Record<string, string>;
}

type UpdateListener = (event: AgentCardsUpdateEventPayload) => void;

type SurfaceField = Extract<CardItem, { type: "field" | "segmented" }>;

function parseMultichoiceRaw(raw: string): string[] | null {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed) && parsed.every((v): v is string => typeof v === "string")) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function formatSingleSubmittedField(name: string, field: SurfaceField, raw: string): string {
  const label = field.label || name;
  if (field.type === "segmented") {
    const matched = field.options.find((o) => o.value === raw);
    return `- ${label}: ${matched?.label ? `${matched.label} (${raw})` : raw}`;
  }
  if (field.kind === "toggle") {
    return `- ${label}: ${raw === "true" ? "开启 (true)" : "关闭 (false)"}`;
  }
  if (field.kind === "choice" && field.options) {
    const matched = field.options.find((o) => o.value === raw);
    return `- ${label}: ${matched?.label ? `${matched.label} (${raw})` : raw}`;
  }
  if (field.kind === "multichoice" && field.options) {
    const selected = parseMultichoiceRaw(raw) ?? (raw ? [raw] : []);
    const optionMap = new Map(field.options.map((o) => [o.value, o.label ?? o.value]));
    const rendered = selected.map((v) => optionMap.get(v) ?? v).join(", ");
    return `- ${label}: ${rendered || "(未选择)"}`;
  }
  return `- ${label}: ${raw}`;
}

function formatSubmittedValues(
  surfaceFields: Map<string, SurfaceField>,
  values: Record<string, string>,
): string[] {
  const lines: string[] = [];
  for (const [name, field] of surfaceFields.entries()) {
    if (name in values) {
      lines.push(formatSingleSubmittedField(name, field, values[name] ?? ""));
    }
  }
  return lines;
}

function validateMultichoiceField(
  field: Extract<CardItem, { type: "field" }>,
  rawValue: string,
  hasValue: boolean,
  isRequired: boolean,
  submitAll: boolean,
): { value?: string; error?: string } {
  const list = parseMultichoiceRaw(rawValue);
  if (list === null) {
    return { error: "Multichoice value must be a JSON string array" };
  }
  if (isRequired && list.length === 0) {
    return { error: "Select at least one option" };
  }
  const allowed = new Set((field.options ?? []).map((o) => o.value));
  const invalid = list.find((v) => !allowed.has(v));
  if (invalid !== undefined) {
    return { error: `Option "${invalid}" is not allowed` };
  }
  return hasValue || submitAll ? { value: JSON.stringify(Array.from(new Set(list))) } : {};
}

function validateNumberField(
  field: Extract<CardItem, { type: "field" }>,
  rawValue: string,
  isRequired: boolean,
): { value?: string; error?: string } {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return isRequired ? { error: "Required" } : {};
  }
  const num = Number(trimmed);
  if (!Number.isFinite(num)) {
    return { error: "Must be a valid number" };
  }
  if (field.min !== undefined && num < field.min) {
    return { error: `Must be >= ${field.min}` };
  }
  if (field.max !== undefined && num > field.max) {
    return { error: `Must be <= ${field.max}` };
  }
  return { value: trimmed };
}

function validateChoiceOrToggleField(
  field: Extract<CardItem, { type: "field" }>,
  rawValue: string,
  hasValue: boolean,
  isRequired: boolean,
  submitAll: boolean,
): { value?: string; error?: string } {
  if (field.kind === "toggle") {
    if (!hasValue) {
      return submitAll ? { value: field.value === "true" ? "true" : "false" } : {};
    }
    return rawValue === "true" || rawValue === "false"
      ? { value: rawValue }
      : { error: 'Toggle value must be "true" or "false"' };
  }
  if (!rawValue) return isRequired ? { error: "Required" } : {};
  const allowed = new Set((field.options ?? []).map((o) => o.value));
  return allowed.has(rawValue)
    ? { value: rawValue }
    : { error: "Selected value is not in allowed options" };
}

function validateSingleField(
  field: SurfaceField,
  rawValue: string,
  hasValue: boolean,
  isRequired: boolean,
  submitAll: boolean,
): { value?: string; error?: string } {
  if (rawValue.length > INTERACTIVE_CARD_MAX_FIELD_VALUE_CHARS) {
    return { error: `Exceeds max length (${INTERACTIVE_CARD_MAX_FIELD_VALUE_CHARS})` };
  }
  if (field.type === "segmented") {
    if (!hasValue && !isRequired) return {};
    const allowed = new Set(field.options.map((o) => o.value));
    return allowed.has(rawValue)
      ? { value: rawValue }
      : { error: "Selected value is not in allowed options" };
  }
  if (field.kind === "toggle" || field.kind === "choice") {
    return validateChoiceOrToggleField(field, rawValue, hasValue, isRequired, submitAll);
  }
  if (field.kind === "multichoice") {
    return validateMultichoiceField(field, rawValue, hasValue, isRequired, submitAll);
  }
  if (field.kind === "number") {
    return validateNumberField(field, rawValue, isRequired);
  }
  if (!rawValue.trim()) {
    return isRequired ? { error: "Required" } : {};
  }
  if (field.maxLength !== undefined && rawValue.length > field.maxLength) {
    return { error: `Must be at most ${field.maxLength} characters` };
  }
  return { value: rawValue };
}

function validateSubmittedFieldValues(
  action: CardReplyAction,
  surfaceFields: Map<string, SurfaceField>,
  incomingValues: Record<string, string> | undefined,
):
  | { ok: true; sanitized: Record<string, string> }
  | { ok: false; fieldErrors: Record<string, string> } {
  const values = incomingValues ?? {};
  const fieldErrors: Record<string, string> = {};
  const sanitized: Record<string, string> = {};

  for (const key of Object.keys(values)) {
    if (!surfaceFields.has(key)) {
      fieldErrors[key] = `Unknown field "${key}"`;
    }
  }

  const requiredSet = new Set<string>(action.requireFields ?? []);
  for (const [name, field] of surfaceFields.entries()) {
    if (field.type === "field" && field.required) {
      requiredSet.add(name);
    }
  }

  if (!action.submit && Object.keys(values).length === 0) {
    return Object.keys(fieldErrors).length > 0
      ? { ok: false, fieldErrors }
      : { ok: true, sanitized };
  }

  for (const [name, field] of surfaceFields.entries()) {
    const hasValue = Object.prototype.hasOwnProperty.call(values, name);
    const res = validateSingleField(
      field,
      hasValue ? values[name]! : "",
      hasValue,
      requiredSet.has(name),
      Boolean(action.submit),
    );
    if (res.error) {
      fieldErrors[name] = res.error;
    } else if (res.value !== undefined) {
      sanitized[name] = res.value;
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, sanitized };
}

export class InteractiveCardsService {
  private readonly store: InteractiveCardsStore;
  private readonly logger: Logger;
  private readonly deliverUserReply: (input: DeliverCardReplyInput) => Promise<void>;
  private readonly isAgentArchived?: (agentId: string) => boolean | Promise<boolean>;
  private readonly coalesceMs: number;
  private readonly listeners = new Set<UpdateListener>();
  private readonly pendingViewTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingViewEvents = new Map<string, AgentCardsUpdateEventPayload>();
  private readonly lastViewBroadcastAt = new Map<string, number>();

  constructor(options: InteractiveCardsServiceOptions) {
    this.store = new InteractiveCardsStore(options.paseoHome);
    this.logger = options.logger.child({ module: "interactive-cards" });
    this.deliverUserReply = options.deliverUserReply;
    this.isAgentArchived = options.isAgentArchived;
    this.coalesceMs = options.updateBroadcastCoalesceMs ?? UPDATE_BROADCAST_COALESCE_MS;
  }

  subscribe(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: AgentCardsUpdateEventPayload): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        this.logger.warn(
          { err, eventType: event.kind, agentId: event.agentId },
          "Interactive card listener threw",
        );
      }
    }
  }

  private emitViewUpsertedCoalesced(card: InteractiveLiveCardRecord, immediate: boolean): void {
    const event: AgentCardsUpdateEventPayload = {
      agentId: card.agentId,
      kind: "view_upserted",
      view: card,
    };
    const key = `${card.agentId}\0${card.id}`;
    if (immediate || this.coalesceMs <= 0) {
      const existingTimer = this.pendingViewTimers.get(key);
      if (existingTimer) {
        clearTimeout(existingTimer);
        this.pendingViewTimers.delete(key);
      }
      this.pendingViewEvents.delete(key);
      this.lastViewBroadcastAt.set(key, Date.now());
      this.emit(event);
      return;
    }

    const now = Date.now();
    const lastSent = this.lastViewBroadcastAt.get(key) ?? 0;
    const elapsed = now - lastSent;
    if (elapsed >= this.coalesceMs && !this.pendingViewTimers.has(key)) {
      this.lastViewBroadcastAt.set(key, now);
      this.emit(event);
      return;
    }

    this.pendingViewEvents.set(key, event);
    if (!this.pendingViewTimers.has(key)) {
      const delay = Math.max(0, this.coalesceMs - elapsed);
      const timer = setTimeout(() => {
        this.pendingViewTimers.delete(key);
        const latest = this.pendingViewEvents.get(key);
        this.pendingViewEvents.delete(key);
        if (latest) {
          this.lastViewBroadcastAt.set(key, Date.now());
          this.emit(latest);
        }
      }, delay);
      this.pendingViewTimers.set(key, timer);
    }
  }

  flushPendingBroadcasts(): void {
    for (const [key, timer] of this.pendingViewTimers.entries()) {
      clearTimeout(timer);
      this.pendingViewTimers.delete(key);
      const latest = this.pendingViewEvents.get(key);
      this.pendingViewEvents.delete(key);
      if (latest) {
        this.lastViewBroadcastAt.set(key, Date.now());
        this.emit(latest);
      }
    }
  }

  dispose(): void {
    for (const timer of this.pendingViewTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingViewTimers.clear();
    this.pendingViewEvents.clear();
    this.listeners.clear();
  }

  async listAgentCards(agentId: string): Promise<AgentCardsSnapshot> {
    const state = await this.store.load(agentId);
    const views = Object.values(state.views).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const inlineBlockKeys = Object.keys(state.inlineBlocks).sort();
    const actions = Object.values(state.actions).sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.cardKey.localeCompare(b.cardKey),
    );
    return { views, inlineBlockKeys, actions };
  }

  async deleteAgent(agentId: string): Promise<void> {
    for (const [key, timer] of this.pendingViewTimers.entries()) {
      if (key.startsWith(`${agentId}\0`)) {
        clearTimeout(timer);
        this.pendingViewTimers.delete(key);
        this.pendingViewEvents.delete(key);
        this.lastViewBroadcastAt.delete(key);
      }
    }
    await this.store.deleteAgent(agentId);
  }

  /**
   * Scans trusted `assistant_message` texts to register valid inline `paseo-view` cards and
   * record field-level validation issues for broken blocks. Never call with `user_message` text.
   */
  async scanAssistantMessages(agentId: string, messages: readonly string[]): Promise<void> {
    if (messages.length === 0) return;
    const candidateMessages = messages.filter((text) => text.toLowerCase().includes("paseo-view"));
    if (candidateMessages.length === 0) return;

    const newlyRegisteredKeys: string[] = [];

    await this.store.withAgentLock(agentId, async () => {
      const state = await this.store.load(agentId);
      let dirty = false;
      const now = new Date().toISOString();

      for (const messageText of candidateMessages) {
        const blocks = extractFencedCardBlocks(messageText);
        if (blocks.length === 0) continue;

        const messageHash = sha256HexSync(messageText).slice(0, 16);
        const messageErrors: string[] = [];

        for (const block of blocks) {
          if (!block.complete) continue;
          if (block.blockIndex >= INTERACTIVE_CARD_MAX_INLINE_PER_MESSAGE) {
            messageErrors.push(
              `block #${block.blockIndex}: exceeds maximum ${INTERACTIVE_CARD_MAX_INLINE_PER_MESSAGE} cards per reply`,
            );
            continue;
          }
          const key = computeInlineCardKey(messageText, block.blockIndex);
          if (state.inlineBlocks[key]) continue;

          let parsedJson: unknown;
          try {
            parsedJson = JSON.parse(block.raw);
          } catch (err) {
            messageErrors.push(
              `block #${block.blockIndex}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
            );
            continue;
          }

          const validated = validateInteractiveCardView(parsedJson);
          if (!validated.ok) {
            for (const errLine of validated.errors.slice(0, 6)) {
              messageErrors.push(`block #${block.blockIndex}: ${errLine}`);
            }
            continue;
          }

          state.inlineBlocks[key] = {
            key,
            view: validated.view,
            registeredAt: now,
          };
          newlyRegisteredKeys.push(key);
          dirty = true;
        }

        if (messageErrors.length > 0) {
          const alreadyLogged = state.validationErrors.some((e) => e.messageHash === messageHash);
          if (!alreadyLogged) {
            state.validationErrors.push({
              messageHash,
              errors: messageErrors.slice(0, 8),
              createdAt: now,
              reported: false,
            });
            if (state.validationErrors.length > MAX_VALIDATION_ERRORS_STORED) {
              state.validationErrors = state.validationErrors.slice(-MAX_VALIDATION_ERRORS_STORED);
            }
            dirty = true;
          }
        }
      }

      if (dirty) {
        await this.store.save(state);
      }
    });

    for (const inlineBlockKey of newlyRegisteredKeys) {
      this.emit({
        agentId,
        kind: "inline_registered",
        inlineBlockKey,
      });
    }
  }

  /**
   * Consumes up to 2 recent unreported inline validation errors to include as a non-authoritative
   * repair hint on the next user prompt, if needed.
   */
  async consumePendingValidationFeedback(agentId: string): Promise<string | null> {
    return this.store.withAgentLock(agentId, async () => {
      const state = await this.store.load(agentId);
      const pending = state.validationErrors.filter((entry) => !entry.reported);
      if (pending.length === 0) return null;

      const selected = pending.slice(-2);
      for (const entry of state.validationErrors) {
        entry.reported = true;
      }
      await this.store.save(state);

      const lines = [
        "<paseo-view-errors>",
        "系统卡片校验提示（不是用户请求，不要因此重做已完成的操作）：你上一条回复里的 paseo-view 卡片未通过校验，前端已降级显示纯文本 fallback：",
        ...selected.flatMap((entry) => entry.errors.map((err) => `- ${err}`)),
        "下次输出卡片时按以上原因修正，并确保携带纯文本 fallback。",
        "</paseo-view-errors>",
      ];
      return lines.join("\n");
    });
  }

  async showLiveCard(input: {
    agentId: string;
    callId?: string;
    view: unknown;
  }): Promise<ShowLiveCardResult> {
    const validated = validateInteractiveCardView(input.view);
    if (!validated.ok) {
      return { ok: false, errors: validated.errors };
    }

    const created = await this.store.withAgentLock(input.agentId, async () => {
      const state = await this.store.load(input.agentId);
      const count = Object.keys(state.views).length;
      if (count >= INTERACTIVE_CARD_MAX_LIVE_PER_AGENT) {
        return {
          ok: false as const,
          errors: [
            `conversation has reached maximum of ${INTERACTIVE_CARD_MAX_LIVE_PER_AGENT} live cards`,
          ],
        };
      }

      let id = `view_${randomBytes(6).toString("hex")}`;
      while (state.views[id]) {
        id = `view_${randomBytes(6).toString("hex")}`;
      }
      const now = new Date().toISOString();
      const card: InteractiveLiveCardRecord = {
        id,
        agentId: input.agentId,
        ...(input.callId ? { callId: input.callId } : {}),
        version: 1,
        view: validated.view,
        createdAt: now,
        updatedAt: now,
      };
      state.views[id] = card;
      await this.store.save(state);
      return { ok: true as const, card };
    });

    if (created.ok) {
      this.emitViewUpsertedCoalesced(created.card, true);
    }
    return created;
  }

  async updateLiveCard(input: {
    agentId: string;
    id: string;
    view: unknown;
    expectedVersion?: number;
  }): Promise<UpdateLiveCardResult> {
    if (!isLiveCardKey(input.id)) {
      return { ok: false, code: "not_found", errors: [`invalid live card id "${input.id}"`] };
    }
    const validated = validateInteractiveCardView(input.view);
    if (!validated.ok) {
      return { ok: false, code: "validation_failed", errors: validated.errors };
    }

    const updated = await this.store.withAgentLock(input.agentId, async () => {
      const state = await this.store.load(input.agentId);
      const existing = state.views[input.id];
      if (!existing) {
        return {
          ok: false as const,
          code: "not_found" as const,
          errors: [`live card "${input.id}" not found in this agent conversation`],
        };
      }
      if (existing.agentId !== input.agentId) {
        return {
          ok: false as const,
          code: "forbidden" as const,
          errors: ["cannot modify a live card created by another conversation"],
        };
      }
      if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
        return {
          ok: false as const,
          code: "version_conflict" as const,
          errors: [
            `version conflict: expected ${input.expectedVersion}, current version is ${existing.version}`,
          ],
          currentVersion: existing.version,
        };
      }

      const nextCard: InteractiveLiveCardRecord = {
        ...existing,
        version: existing.version + 1,
        view: validated.view,
        updatedAt: new Date().toISOString(),
      };
      state.views[input.id] = nextCard;
      await this.store.save(state);
      return { ok: true as const, card: nextCard };
    });

    if (updated.ok) {
      this.emitViewUpsertedCoalesced(updated.card, false);
    }
    return updated;
  }

  async getLiveCard(input: { agentId: string; id: string }): Promise<GetLiveCardResult> {
    if (!isLiveCardKey(input.id)) {
      return { ok: false, code: "not_found", error: `invalid live card id "${input.id}"` };
    }
    const state = await this.store.load(input.agentId);
    const card = state.views[input.id];
    if (!card) {
      return {
        ok: false,
        code: "not_found",
        error: `live card "${input.id}" not found in this agent conversation`,
      };
    }
    if (card.agentId !== input.agentId) {
      return {
        ok: false,
        code: "forbidden",
        error: "cannot access a live card created by another conversation",
      };
    }
    return {
      ok: true,
      card,
      action: state.actions[input.id] ?? null,
    };
  }

  private resolveTargetCardForSubmit(
    state: Awaited<ReturnType<InteractiveCardsStore["load"]>>,
    cardKey: string,
  ):
    | {
        ok: true;
        view: InteractiveCardView;
        currentVersion: number;
        liveCard?: InteractiveLiveCardRecord;
      }
    | { ok: false; result: SubmitCardActionResult } {
    if (isLiveCardKey(cardKey)) {
      const liveCard = state.views[cardKey];
      if (!liveCard) {
        return {
          ok: false,
          result: { ok: false, code: "not_found", error: "Live card not found." },
        };
      }
      return { ok: true, view: liveCard.view, currentVersion: liveCard.version, liveCard };
    }
    if (isInlineCardKey(cardKey)) {
      const inlineBlock = state.inlineBlocks[cardKey];
      if (!inlineBlock) {
        return {
          ok: false,
          result: {
            ok: false,
            code: "unregistered_card",
            error: "This card has not been registered from a trusted assistant reply.",
          },
        };
      }
      return { ok: true, view: inlineBlock.view, currentVersion: 1 };
    }
    return {
      ok: false,
      result: { ok: false, code: "unregistered_card", error: "Invalid card key." },
    };
  }

  async submitCardAction(input: SubmitCardActionInput): Promise<SubmitCardActionResult> {
    if (await this.isAgentArchived?.(input.agentId)) {
      return {
        ok: false,
        code: "agent_archived",
        error: "Cannot submit an interactive card on an archived conversation.",
      };
    }

    type PreparedSubmission =
      | { kind: "done"; result: SubmitCardActionResult }
      | { kind: "deliver"; record: InteractiveCardActionRecord };

    const prepared = await this.store.withAgentLock<PreparedSubmission>(input.agentId, async () => {
      const state = await this.store.load(input.agentId);
      const target = this.resolveTargetCardForSubmit(state, input.cardKey);
      if (!target.ok) {
        return { kind: "done", result: target.result };
      }
      const { view, currentVersion, liveCard } = target;

      // 2. Check once-per-card idempotency / retry semantics.
      const existingAction = state.actions[input.cardKey];
      if (existingAction) {
        if (existingAction.clientMessageId !== input.clientMessageId) {
          return {
            kind: "done",
            result: {
              ok: false,
              code: "already_answered",
              action: existingAction,
              error: "This card has already been answered.",
            },
          };
        }
        if (existingAction.status === "sent" || existingAction.status === "pending") {
          return { kind: "done", result: { ok: true, action: existingAction } };
        }
        const retrying: InteractiveCardActionRecord = {
          ...existingAction,
          status: "pending",
          error: undefined,
          revision: existingAction.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        state.actions[input.cardKey] = retrying;
        await this.store.save(state);
        return { kind: "deliver", record: retrying };
      }

      // 3. Optimistic version check (never silently submit against a newer live card).
      if (input.expectedVersion !== currentVersion) {
        return {
          kind: "done",
          result: {
            ok: false,
            code: "view_changed",
            view: liveCard,
            error:
              "The card changed before your submission. Review the latest content and try again.",
          },
        };
      }

      // 4. Resolve and validate action & fields against the server-stored View.
      const page = input.page?.trim() || undefined;
      const surface = resolveCardPageSurface(view, page);
      const action = surface?.actions.get(input.actionId);
      if (!surface || !action || action.kind !== "reply") {
        return {
          kind: "done",
          result: {
            ok: false,
            code: "validation_failed",
            error: `Reply action "${input.actionId}" not found on this card.`,
          },
        };
      }
      if (action.confirm && !input.confirmed) {
        return {
          kind: "done",
          result: {
            ok: false,
            code: "validation_failed",
            error: "Explicit confirmation is required for this action.",
          },
        };
      }

      const validatedValues = validateSubmittedFieldValues(action, surface.fields, input.values);
      if (!validatedValues.ok) {
        return {
          kind: "done",
          result: {
            ok: false,
            code: "validation_failed",
            fieldErrors: validatedValues.fieldErrors,
            error: "Please fix invalid or missing fields.",
          },
        };
      }

      const valueLines = formatSubmittedValues(surface.fields, validatedValues.sanitized);
      const text =
        valueLines.length > 0 ? `${action.reply}\n${valueLines.join("\n")}` : action.reply;
      const now = new Date().toISOString();
      const record: InteractiveCardActionRecord = {
        cardKey: input.cardKey,
        actionId: input.actionId,
        ...(page ? { page } : {}),
        ...(Object.keys(validatedValues.sanitized).length > 0
          ? { values: validatedValues.sanitized }
          : {}),
        version: currentVersion,
        clientMessageId: input.clientMessageId,
        text,
        status: "pending",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      };
      state.actions[input.cardKey] = record;
      await this.store.save(state);
      return { kind: "deliver", record };
    });

    if (prepared.kind === "done") {
      return prepared.result;
    }

    this.emit({
      agentId: input.agentId,
      kind: "action_updated",
      action: prepared.record,
    });

    // 6. Deliver durable outbox reply to the agent outside the per-agent storage lock.
    try {
      await this.deliverUserReply({
        agentId: input.agentId,
        text: prepared.record.text,
        clientMessageId: prepared.record.clientMessageId,
      });

      const sentRecord = await this.store.withAgentLock(input.agentId, async () => {
        const state = await this.store.load(input.agentId);
        const current = state.actions[input.cardKey] ?? prepared.record;
        const next: InteractiveCardActionRecord = {
          ...current,
          status: "sent",
          error: undefined,
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        state.actions[input.cardKey] = next;
        await this.store.save(state);
        return next;
      });

      this.emit({
        agentId: input.agentId,
        kind: "action_updated",
        action: sentRecord,
      });
      return { ok: true, action: sentRecord };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        { err, agentId: input.agentId, cardKey: input.cardKey },
        "Failed to deliver interactive card reply",
      );
      const failedRecord = await this.store.withAgentLock(input.agentId, async () => {
        const state = await this.store.load(input.agentId);
        const current = state.actions[input.cardKey] ?? prepared.record;
        const next: InteractiveCardActionRecord = {
          ...current,
          status: "failed",
          error: errorMessage.slice(0, 500),
          revision: current.revision + 1,
          updatedAt: new Date().toISOString(),
        };
        state.actions[input.cardKey] = next;
        await this.store.save(state);
        return next;
      });

      this.emit({
        agentId: input.agentId,
        kind: "action_updated",
        action: failedRecord,
      });
      return {
        ok: false,
        code: "delivery_failed",
        action: failedRecord,
        error: errorMessage,
      };
    }
  }

  /** Helper for tests to verify persistence across daemon restarts. */
  clearMemoryCache(): void {
    this.store.clearMemoryCache();
  }
}
