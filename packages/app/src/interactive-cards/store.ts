import { useEffect, useSyncExternalStore } from "react";
import type {
  AgentCardsUpdateEventPayload,
  InteractiveCardActionRecord,
  InteractiveLiveCardRecord,
} from "@getpaseo/protocol/interactive-cards";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export interface AgentCardsBucket {
  views: Record<string, InteractiveLiveCardRecord>;
  inlineBlockKeys: Record<string, true>;
  actions: Record<string, InteractiveCardActionRecord>;
  loaded: boolean;
  supported: boolean;
}

export interface PendingCardSubmission {
  actionId: string;
  page: string;
  values: Record<string, string>;
  expectedVersion: number;
  confirmed: boolean;
  clientMessageId: string;
  inFlight: boolean;
}

export interface CardDraftState {
  values: Record<string, string>;
  pageStack: string[];
  sending?: PendingCardSubmission;
  fieldErrors?: Record<string, string>;
  error?: string;
  changed?: boolean;
  elsewhere?: boolean;
}

interface InteractiveCardsStoreState {
  buckets: Record<string, AgentCardsBucket>;
  drafts: Record<string, CardDraftState>;
}

const EMPTY_BUCKET: AgentCardsBucket = {
  views: {},
  inlineBlockKeys: {},
  actions: {},
  loaded: false,
  supported: true,
};

let state: InteractiveCardsStoreState = {
  buckets: {},
  drafts: {},
};

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setState(next: InteractiveCardsStoreState): void {
  state = next;
  emitChange();
}

export function agentBucketKey(serverId: string, agentId: string): string {
  return `${serverId}\u0000${agentId}`;
}

export function cardDraftKey(serverId: string, agentId: string, cardKey: string): string {
  return `${serverId}\u0000${agentId}\u0000${cardKey}`;
}

export function getAgentCardsBucket(
  serverId: string,
  agentId: string,
  snapshot = state,
): AgentCardsBucket {
  return snapshot.buckets[agentBucketKey(serverId, agentId)] ?? EMPTY_BUCKET;
}

export function getCardDraft(
  serverId: string,
  agentId: string,
  cardKey: string,
  snapshot = state,
): CardDraftState | undefined {
  return snapshot.drafts[cardDraftKey(serverId, agentId, cardKey)];
}

export function useInteractiveCardsStore<T>(
  selector: (snapshot: InteractiveCardsStoreState) => T,
): T {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => selector(state),
    () => selector(state),
  );
}

function updateBucket(
  serverId: string,
  agentId: string,
  updater: (bucket: AgentCardsBucket) => AgentCardsBucket,
): void {
  const key = agentBucketKey(serverId, agentId);
  const current = state.buckets[key] ?? EMPTY_BUCKET;
  const next = updater(current);
  if (next === current) return;
  setState({
    ...state,
    buckets: {
      ...state.buckets,
      [key]: next,
    },
  });
}

export function updateCardDraft(
  serverId: string,
  agentId: string,
  cardKey: string,
  updater: (draft: CardDraftState) => CardDraftState,
): void {
  const key = cardDraftKey(serverId, agentId, cardKey);
  const current = state.drafts[key] ?? { values: {}, pageStack: [] };
  const next = updater(current);
  if (next === current) return;
  setState({
    ...state,
    drafts: {
      ...state.drafts,
      [key]: next,
    },
  });
}

export function setCardDraftFieldValue(
  serverId: string,
  agentId: string,
  cardKey: string,
  name: string,
  value: string,
): void {
  updateCardDraft(serverId, agentId, cardKey, (draft) => {
    const nextFieldErrors = draft.fieldErrors ? { ...draft.fieldErrors } : undefined;
    if (nextFieldErrors && name in nextFieldErrors) {
      delete nextFieldErrors[name];
    }
    return {
      ...draft,
      values: { ...draft.values, [name]: value },
      fieldErrors:
        nextFieldErrors && Object.keys(nextFieldErrors).length > 0 ? nextFieldErrors : undefined,
      error: undefined,
    };
  });
}

export function pushCardDraftPage(
  serverId: string,
  agentId: string,
  cardKey: string,
  page: string,
  maxDepth: number,
): void {
  updateCardDraft(serverId, agentId, cardKey, (draft) => {
    if (draft.pageStack.length >= maxDepth) return draft;
    if (draft.pageStack[draft.pageStack.length - 1] === page) return draft;
    return {
      ...draft,
      pageStack: [...draft.pageStack, page],
      fieldErrors: undefined,
      error: undefined,
    };
  });
}

export function popCardDraftPage(serverId: string, agentId: string, cardKey: string): void {
  updateCardDraft(serverId, agentId, cardKey, (draft) => {
    if (draft.pageStack.length === 0) return draft;
    return {
      ...draft,
      pageStack: draft.pageStack.slice(0, -1),
      fieldErrors: undefined,
      error: undefined,
    };
  });
}

export function applyAgentCardsSnapshot(
  serverId: string,
  agentId: string,
  snapshot: {
    views: InteractiveLiveCardRecord[];
    inlineBlockKeys: string[];
    actions: InteractiveCardActionRecord[];
  },
): void {
  updateBucket(serverId, agentId, (current) => {
    const views: Record<string, InteractiveLiveCardRecord> = { ...current.views };
    for (const view of snapshot.views) {
      const existing = views[view.id];
      if (!existing || view.version >= existing.version) {
        views[view.id] = view;
      }
    }
    const inlineBlockKeys: Record<string, true> = { ...current.inlineBlockKeys };
    for (const key of snapshot.inlineBlockKeys) {
      inlineBlockKeys[key] = true;
    }
    const actions: Record<string, InteractiveCardActionRecord> = { ...current.actions };
    for (const action of snapshot.actions) {
      const existing = actions[action.cardKey];
      if (!existing || action.revision >= existing.revision) {
        actions[action.cardKey] = action;
      }
    }
    return {
      views,
      inlineBlockKeys,
      actions,
      loaded: true,
      supported: true,
    };
  });
}

export function applyAgentCardsUpdate(
  serverId: string,
  payload: AgentCardsUpdateEventPayload,
): void {
  const { agentId } = payload;
  if (payload.kind === "view_upserted" && payload.view) {
    const incoming = payload.view;
    updateBucket(serverId, agentId, (current) => {
      const existing = current.views[incoming.id];
      if (existing && incoming.version < existing.version) return current;
      return {
        ...current,
        views: {
          ...current.views,
          [incoming.id]: incoming,
        },
      };
    });
    return;
  }

  if (payload.kind === "inline_registered" && payload.inlineBlockKey) {
    const blockKey = payload.inlineBlockKey;
    updateBucket(serverId, agentId, (current) => {
      if (current.inlineBlockKeys[blockKey]) return current;
      return {
        ...current,
        inlineBlockKeys: {
          ...current.inlineBlockKeys,
          [blockKey]: true,
        },
      };
    });
    return;
  }

  if (payload.kind === "action_updated" && payload.action) {
    const incoming = payload.action;
    updateBucket(serverId, agentId, (current) => {
      const existing = current.actions[incoming.cardKey];
      if (existing && incoming.revision < existing.revision) return current;
      return {
        ...current,
        actions: {
          ...current.actions,
          [incoming.cardKey]: incoming,
        },
      };
    });
  }
}

export function markAgentCardsUnsupported(serverId: string, agentId: string): void {
  updateBucket(serverId, agentId, (current) => ({
    ...current,
    loaded: true,
    supported: false,
  }));
}

function createClientMessageId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `card_${crypto.randomUUID()}`;
  }
  return `card_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function stableRecordString(record: Record<string, string>): string {
  return JSON.stringify(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function isSameSubmission(
  a: Omit<PendingCardSubmission, "clientMessageId" | "inFlight">,
  b: Omit<PendingCardSubmission, "clientMessageId" | "inFlight">,
): boolean {
  return (
    a.actionId === b.actionId &&
    a.page === b.page &&
    a.expectedVersion === b.expectedVersion &&
    a.confirmed === b.confirmed &&
    stableRecordString(a.values) === stableRecordString(b.values)
  );
}

export type SubmitCardOutcome =
  | "sent"
  | "busy"
  | "already_answered"
  | "view_changed"
  | "validation_failed"
  | "failed";

export async function submitInteractiveCardAction(input: {
  client: Pick<DaemonClient, "submitAgentCard">;
  serverId: string;
  agentId: string;
  cardKey: string;
  actionId: string;
  page: string;
  values: Record<string, string>;
  expectedVersion: number;
  confirmed: boolean;
}): Promise<SubmitCardOutcome> {
  const { client, serverId, agentId, cardKey, actionId, page, values, expectedVersion, confirmed } =
    input;
  const draft = getCardDraft(serverId, agentId, cardKey);
  if (draft?.sending?.inFlight) return "busy";

  const bucket = getAgentCardsBucket(serverId, agentId);
  const existingAction = bucket.actions[cardKey];
  if (existingAction && existingAction.status !== "failed") {
    return "already_answered";
  }

  const reqBase = { actionId, page, values, expectedVersion, confirmed };
  let reuseId: string;
  if (existingAction?.status === "failed") {
    reuseId = existingAction.clientMessageId;
  } else if (draft?.sending && isSameSubmission(draft.sending, reqBase)) {
    reuseId = draft.sending.clientMessageId;
  } else {
    reuseId = createClientMessageId();
  }

  const sending: PendingCardSubmission = {
    ...reqBase,
    clientMessageId: reuseId,
    inFlight: true,
  };
  updateCardDraft(serverId, agentId, cardKey, (current) => ({
    ...current,
    sending,
    error: undefined,
    fieldErrors: undefined,
    elsewhere: false,
  }));

  try {
    const res = await client.submitAgentCard({
      agentId,
      cardKey,
      actionId,
      page: page || undefined,
      values,
      expectedVersion,
      clientMessageId: sending.clientMessageId,
      confirmed,
    });

    if (res.action) {
      applyAgentCardsUpdate(serverId, {
        agentId,
        kind: "action_updated",
        action: res.action,
      });
    }

    if (res.ok) {
      updateCardDraft(serverId, agentId, cardKey, (current) => ({
        ...current,
        sending: undefined,
        changed: false,
        error: undefined,
        fieldErrors: undefined,
      }));
      return "sent";
    }

    if (res.code === "already_answered") {
      updateCardDraft(serverId, agentId, cardKey, (current) => ({
        ...current,
        sending: undefined,
        elsewhere: true,
        error: undefined,
      }));
      return "already_answered";
    }

    if (res.code === "view_changed") {
      if (res.view) {
        applyAgentCardsUpdate(serverId, {
          agentId,
          kind: "view_upserted",
          view: res.view,
        });
      }
      updateCardDraft(serverId, agentId, cardKey, (current) => ({
        ...current,
        sending: undefined,
        changed: true,
        error: undefined,
      }));
      return "view_changed";
    }

    if (res.code === "validation_failed") {
      updateCardDraft(serverId, agentId, cardKey, (current) => ({
        ...current,
        sending: undefined,
        fieldErrors: res.fieldErrors,
        error: res.error ?? undefined,
      }));
      return "validation_failed";
    }

    // delivery_failed or transient error keeps sending.clientMessageId for safe idempotent retry
    updateCardDraft(serverId, agentId, cardKey, (current) => ({
      ...current,
      error: res.error ?? undefined,
      sending: current.sending ? { ...current.sending, inFlight: false } : undefined,
    }));
    return "failed";
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateCardDraft(serverId, agentId, cardKey, (current) => ({
      ...current,
      error: message,
      sending: current.sending ? { ...current.sending, inFlight: false } : undefined,
    }));
    return "failed";
  }
}

export function resetInteractiveCardsStore(): void {
  setState({ buckets: {}, drafts: {} });
}

// Reference-counted active subscriptions per (serverId, agentId)
const activeSyncRefs = new Map<string, { count: number; stop: () => void }>();

function startAgentCardsSync(serverId: string, agentId: string): () => void {
  const host = getHostRuntimeStore();
  let currentClient: DaemonClient | null = null;
  let releaseObservation: (() => void) | undefined;
  let disposed = false;

  const syncWithClient = () => {
    if (disposed) return;
    const candidate = host.getSnapshot(serverId)?.client ?? null;
    const nextClient = candidate?.getLastServerInfoMessage() ? candidate : null;
    if (nextClient === currentClient) return;

    const prevRelease = releaseObservation;
    currentClient = nextClient;
    releaseObservation = undefined;
    prevRelease?.();

    if (!currentClient) return;
    if (!currentClient.supportsInteractiveCards()) {
      markAgentCardsUnsupported(serverId, agentId);
      return;
    }

    const boundClient = currentClient;
    const refreshSnapshot = () => {
      void boundClient
        .listAgentCards(agentId)
        .then((res) => {
          if (!disposed && currentClient === boundClient) {
            applyAgentCardsSnapshot(serverId, agentId, {
              views: res.views,
              inlineBlockKeys: res.inlineBlockKeys,
              actions: res.actions,
            });
          }
          return undefined;
        })
        .catch(() => undefined);
    };

    const observation = boundClient.observeAgentCards();
    observation.subscribe({
      snapshot: () => {
        refreshSnapshot();
      },
      update: (message: SessionOutboundMessage) => {
        if (
          !disposed &&
          currentClient === boundClient &&
          message.type === "agent.cards.update" &&
          message.payload.agentId === agentId
        ) {
          applyAgentCardsUpdate(serverId, message.payload);
        }
      },
      error: () => undefined,
    });
    refreshSnapshot();

    releaseObservation = () => {
      void observation.release().catch(() => undefined);
    };
  };

  const unsubscribeHost = host.subscribe(serverId, syncWithClient);
  syncWithClient();

  return () => {
    disposed = true;
    unsubscribeHost();
    releaseObservation?.();
    releaseObservation = undefined;
    currentClient = null;
  };
}

/**
 * Keeps interactive card snapshots and live `agent.cards.update` pushes synchronized for a
 * visible agent conversation. Reference-counted so multiple cards share a single subscription.
 */
export function useAgentInteractiveCardsSync(
  serverId: string | undefined,
  agentId: string | undefined,
): void {
  useEffect(() => {
    if (!serverId || !agentId) return;
    const key = agentBucketKey(serverId, agentId);
    const existing = activeSyncRefs.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      activeSyncRefs.set(key, {
        count: 1,
        stop: startAgentCardsSync(serverId, agentId),
      });
    }
    return () => {
      const entry = activeSyncRefs.get(key);
      if (!entry) return;
      entry.count -= 1;
      if (entry.count <= 0) {
        activeSyncRefs.delete(key);
        entry.stop();
      }
    };
  }, [serverId, agentId]);
}
