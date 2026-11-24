import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MainChatConversationRecord,
  MainChatFleetHostStatus,
  MainChatFleetScope,
  MainChatOverview,
} from "@getpaseo/protocol/main-chat";
import AsyncStorage from "@react-native-async-storage/async-storage";
import equal from "fast-deep-equal";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

export const MAIN_CHAT_DIRECTIONS_PERSIST_KEY = "paseo:main-chat-directions-ui";

export const MainChatDirectionsPersistedStateSchema = z.strictObject({
  expandedDirectionIds: z.record(z.string(), z.boolean()),
  sectionCollapsed: z.boolean(),
  recentSideCollapsed: z.boolean(),
  dismissedFleetSyncNotice: z.boolean(),
  dismissedFleetSyncNoticeByServerId: z.record(z.string(), z.boolean()).optional(),
});

export type MainChatDirectionsPersistedState = z.infer<
  typeof MainChatDirectionsPersistedStateSchema
>;

export interface CreateMainChatConversationInput {
  kind: "side" | "leader";
  title: string;
  directionSummary?: string | null;
  initialPrompt?: string;
  provider?: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
}

export interface UpdateMainChatConversationInput {
  conversationId: string;
  title?: string;
  directionSummary?: string | null;
  kind?: "side" | "leader";
  archived?: boolean;
}

export interface RefreshFleetHostsResult {
  localServerId: string | null;
  hosts: MainChatFleetHostStatus[];
  fleetScope?: MainChatFleetScope;
  availableRemoteHosts?: MainChatFleetHostStatus[];
}

export interface MainChatConversationsStoreState {
  conversationsByServerId: Record<string, MainChatConversationRecord[] | undefined>;
  loadingConversationsByServerId: Record<string, boolean | undefined>;
  conversationsErrorByServerId: Record<string, string | null | undefined>;
  fleetHostsByServerId: Record<string, MainChatFleetHostStatus[] | undefined>;
  availableRemoteHostsByServerId: Record<string, MainChatFleetHostStatus[] | undefined>;
  fleetScopeByServerId: Record<string, MainChatFleetScope | undefined>;
  localServerIdByServerId: Record<string, string | null | undefined>;
  loadingFleetHostsByServerId: Record<string, boolean | undefined>;
  fleetHostsErrorByServerId: Record<string, string | null | undefined>;
  expandedDirectionIds: Record<string, boolean>;
  sectionCollapsed: boolean;
  recentSideCollapsed: boolean;
  dismissedFleetSyncNotice: boolean;
  dismissedFleetSyncNoticeByServerId: Record<string, boolean>;

  hydrateFromOverview: (serverId: string, overview: MainChatOverview | null | undefined) => void;
  refreshConversations: (
    serverId: string,
    client: DaemonClient,
    options?: { includeArchived?: boolean },
  ) => Promise<MainChatConversationRecord[]>;
  createConversation: (
    serverId: string,
    input: CreateMainChatConversationInput,
    client: DaemonClient,
  ) => Promise<MainChatConversationRecord>;
  updateConversation: (
    serverId: string,
    input: UpdateMainChatConversationInput,
    client: DaemonClient,
  ) => Promise<MainChatConversationRecord>;
  promoteToLeader: (
    serverId: string,
    conversationId: string,
    client: DaemonClient,
    options?: { directionSummary?: string | null },
  ) => Promise<MainChatConversationRecord>;
  demoteToSide: (
    serverId: string,
    conversationId: string,
    client: DaemonClient,
  ) => Promise<MainChatConversationRecord>;
  archiveConversation: (
    serverId: string,
    conversationId: string,
    client: DaemonClient,
    archived?: boolean,
  ) => Promise<MainChatConversationRecord>;
  refreshFleetHosts: (
    serverId: string,
    client: DaemonClient,
    options?: { forceRefresh?: boolean },
  ) => Promise<RefreshFleetHostsResult>;

  toggleDirectionExpanded: (conversationId: string) => void;
  setDirectionExpanded: (conversationId: string, expanded: boolean) => void;
  toggleSectionCollapsed: () => void;
  setSectionCollapsed: (collapsed: boolean) => void;
  toggleRecentSideCollapsed: () => void;
  setRecentSideCollapsed: (collapsed: boolean) => void;
  setDismissedFleetSyncNotice: (dismissed: boolean, serverId?: string | null) => void;
  reset: () => void;
}

export const EMPTY_CONVERSATIONS: readonly MainChatConversationRecord[] = [];
export const EMPTY_FLEET_HOSTS: readonly MainChatFleetHostStatus[] = [];

const INITIAL_PERSISTED_STATE: Omit<
  MainChatDirectionsPersistedState,
  "dismissedFleetSyncNoticeByServerId"
> & { dismissedFleetSyncNoticeByServerId: Record<string, boolean> } = {
  expandedDirectionIds: {},
  sectionCollapsed: false,
  recentSideCollapsed: false,
  dismissedFleetSyncNotice: false,
  dismissedFleetSyncNoticeByServerId: {},
};

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function conversationActivityMs(record: MainChatConversationRecord): number {
  return Math.max(
    parseTimestampMs(record.lastMessageAt),
    parseTimestampMs(record.updatedAt),
    parseTimestampMs(record.createdAt),
  );
}

export function sortConversationsByActivity(
  conversations: readonly MainChatConversationRecord[],
): MainChatConversationRecord[] {
  return [...conversations].sort((left, right) => {
    const activityDiff = conversationActivityMs(right) - conversationActivityMs(left);
    if (activityDiff !== 0) return activityDiff;
    return left.id.localeCompare(right.id);
  });
}

export function partitionActiveConversations(
  conversations: readonly MainChatConversationRecord[],
): {
  leaders: MainChatConversationRecord[];
  sides: MainChatConversationRecord[];
} {
  const leaders: MainChatConversationRecord[] = [];
  const sides: MainChatConversationRecord[] = [];

  for (const record of conversations) {
    if (record.archivedAt !== null || record.kind === "main") continue;
    if (record.kind === "leader") {
      leaders.push(record);
    } else if (record.kind === "side") {
      sides.push(record);
    }
  }

  leaders.sort((left, right) => {
    const activityDiff = conversationActivityMs(right) - conversationActivityMs(left);
    if (activityDiff !== 0) return activityDiff;
    const pinnedDiff =
      parseTimestampMs(right.pinnedAsLeaderAt) - parseTimestampMs(left.pinnedAsLeaderAt);
    if (pinnedDiff !== 0) return pinnedDiff;
    return left.title.localeCompare(right.title);
  });

  sides.sort((left, right) => {
    const activityDiff = conversationActivityMs(right) - conversationActivityMs(left);
    if (activityDiff !== 0) return activityDiff;
    return left.title.localeCompare(right.title);
  });

  return { leaders, sides };
}

export function findConversationInRecords(
  conversations: readonly MainChatConversationRecord[] | undefined,
  conversationIdOrAgentId: string,
): MainChatConversationRecord | null {
  if (!conversations || conversations.length === 0) return null;
  const trimmed = conversationIdOrAgentId.trim();
  if (!trimmed) return null;

  const byId = conversations.find((record) => record.id === trimmed);
  if (byId) return byId;

  const byAgentId = conversations.find((record) => record.agentId === trimmed);
  if (byAgentId) return byAgentId;

  const separator = trimmed.indexOf(":");
  if (separator > 0 && separator < trimmed.length - 1) {
    const agentId = trimmed.slice(separator + 1);
    return conversations.find((record) => record.agentId === agentId) ?? null;
  }

  return null;
}

export function selectConversationRecordFromStore(
  state: MainChatConversationsStoreState,
  conversationId: string,
  preferredServerId: string | null,
): { serverId: string; record: MainChatConversationRecord } | null {
  const trimmed = conversationId.trim();
  if (!trimmed) return null;

  if (preferredServerId) {
    const hit = findConversationInRecords(
      state.conversationsByServerId[preferredServerId],
      trimmed,
    );
    if (hit) {
      return { serverId: hit.serverId ?? preferredServerId, record: hit };
    }
  }

  for (const [serverId, records] of Object.entries(state.conversationsByServerId)) {
    const hit = findConversationInRecords(records, trimmed);
    if (hit) {
      return { serverId: hit.serverId ?? serverId, record: hit };
    }
  }

  return null;
}

function upsertConversationRecord(
  existing: readonly MainChatConversationRecord[] | undefined,
  updated: MainChatConversationRecord,
): MainChatConversationRecord[] {
  if (!existing || existing.length === 0) {
    return [updated];
  }
  const index = existing.findIndex((item) => item.id === updated.id);
  if (index < 0) {
    return sortConversationsByActivity([updated, ...existing]);
  }
  const next = existing.slice();
  next[index] = updated;
  return sortConversationsByActivity(next);
}

function mergeOverviewConversations(
  existing: readonly MainChatConversationRecord[] | undefined,
  incoming: readonly MainChatConversationRecord[],
): MainChatConversationRecord[] {
  if (!existing || existing.length === 0) {
    return sortConversationsByActivity(incoming);
  }
  if (incoming.length === 0) {
    return existing.slice();
  }
  const merged = new Map<string, MainChatConversationRecord>();
  for (const item of existing) {
    merged.set(item.id, item);
  }
  for (const item of incoming) {
    const prev = merged.get(item.id);
    if (!prev || conversationActivityMs(item) >= conversationActivityMs(prev)) {
      merged.set(item.id, item);
    }
  }
  return sortConversationsByActivity([...merged.values()]);
}

function mergePersistedDirectionsState(
  persistedState: unknown,
  currentState: MainChatConversationsStoreState,
): MainChatConversationsStoreState {
  const parsed = MainChatDirectionsPersistedStateSchema.safeParse(persistedState);
  if (!parsed.success) {
    return currentState;
  }
  return {
    ...currentState,
    expandedDirectionIds: parsed.data.expandedDirectionIds,
    sectionCollapsed: parsed.data.sectionCollapsed,
    recentSideCollapsed: parsed.data.recentSideCollapsed,
    dismissedFleetSyncNotice: parsed.data.dismissedFleetSyncNotice,
    dismissedFleetSyncNoticeByServerId: parsed.data.dismissedFleetSyncNoticeByServerId ?? {},
  };
}

export const useMainChatConversationsStore = create<MainChatConversationsStoreState>()(
  persist<MainChatConversationsStoreState, [], [], MainChatDirectionsPersistedState>(
    (set, get) => ({
      conversationsByServerId: {},
      loadingConversationsByServerId: {},
      conversationsErrorByServerId: {},
      fleetHostsByServerId: {},
      availableRemoteHostsByServerId: {},
      fleetScopeByServerId: {},
      localServerIdByServerId: {},
      loadingFleetHostsByServerId: {},
      fleetHostsErrorByServerId: {},
      ...INITIAL_PERSISTED_STATE,

      hydrateFromOverview(serverId, overview) {
        if (!serverId || !overview) return;
        const incomingConversations = overview.conversations;
        const incomingFleetHosts = overview.fleetHosts;
        if (!incomingConversations && !incomingFleetHosts) return;

        set((state) => {
          let changed = false;
          let nextConversationsByServerId = state.conversationsByServerId;
          let nextFleetHostsByServerId = state.fleetHostsByServerId;
          let nextLocalServerIdByServerId = state.localServerIdByServerId;

          if (incomingConversations) {
            const merged = mergeOverviewConversations(
              state.conversationsByServerId[serverId],
              incomingConversations,
            );
            if (!equal(state.conversationsByServerId[serverId], merged)) {
              nextConversationsByServerId = {
                ...state.conversationsByServerId,
                [serverId]: merged,
              };
              changed = true;
            }
          }

          if (incomingFleetHosts && incomingFleetHosts.length > 0) {
            if (!equal(state.fleetHostsByServerId[serverId], incomingFleetHosts)) {
              nextFleetHostsByServerId = {
                ...state.fleetHostsByServerId,
                [serverId]: incomingFleetHosts,
              };
              changed = true;
            }
            const localHost = incomingFleetHosts.find((host) => host.isLocal);
            if (localHost && state.localServerIdByServerId[serverId] !== localHost.serverId) {
              nextLocalServerIdByServerId = {
                ...state.localServerIdByServerId,
                [serverId]: localHost.serverId,
              };
              changed = true;
            }
          }

          if (!changed) return state;
          return {
            conversationsByServerId: nextConversationsByServerId,
            fleetHostsByServerId: nextFleetHostsByServerId,
            localServerIdByServerId: nextLocalServerIdByServerId,
          };
        });
      },

      async refreshConversations(serverId, client, options) {
        set((state) => ({
          loadingConversationsByServerId: {
            ...state.loadingConversationsByServerId,
            [serverId]: true,
          },
          conversationsErrorByServerId: {
            ...state.conversationsErrorByServerId,
            [serverId]: null,
          },
        }));

        try {
          const response = await client.listMainChatConversations(options);
          if (response.error) {
            throw new Error(response.error);
          }
          const sorted = sortConversationsByActivity(response.conversations);
          set((state) => ({
            conversationsByServerId: {
              ...state.conversationsByServerId,
              [serverId]: sorted,
            },
            loadingConversationsByServerId: {
              ...state.loadingConversationsByServerId,
              [serverId]: false,
            },
            conversationsErrorByServerId: {
              ...state.conversationsErrorByServerId,
              [serverId]: null,
            },
          }));
          return sorted;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((state) => ({
            loadingConversationsByServerId: {
              ...state.loadingConversationsByServerId,
              [serverId]: false,
            },
            conversationsErrorByServerId: {
              ...state.conversationsErrorByServerId,
              [serverId]: message,
            },
          }));
          throw error;
        }
      },

      async createConversation(serverId, input, client) {
        const response = await client.createMainChatConversation(input);
        if (response.error || !response.conversation) {
          throw new Error(response.error ?? "Failed to create conversation");
        }
        const created = response.conversation;
        set((state) => ({
          conversationsByServerId: {
            ...state.conversationsByServerId,
            [serverId]: upsertConversationRecord(state.conversationsByServerId[serverId], created),
          },
        }));
        return created;
      },

      async updateConversation(serverId, input, client) {
        const response = await client.updateMainChatConversation(input);
        if (response.error || !response.conversation) {
          throw new Error(response.error ?? "Failed to update conversation");
        }
        const updated = response.conversation;
        set((state) => ({
          conversationsByServerId: {
            ...state.conversationsByServerId,
            [serverId]: upsertConversationRecord(state.conversationsByServerId[serverId], updated),
          },
        }));
        return updated;
      },

      async promoteToLeader(serverId, conversationId, client, options) {
        return get().updateConversation(
          serverId,
          {
            conversationId,
            kind: "leader",
            ...(options?.directionSummary !== undefined
              ? { directionSummary: options.directionSummary }
              : {}),
          },
          client,
        );
      },

      async demoteToSide(serverId, conversationId, client) {
        return get().updateConversation(
          serverId,
          {
            conversationId,
            kind: "side",
          },
          client,
        );
      },

      async archiveConversation(serverId, conversationId, client, archived = true) {
        return get().updateConversation(
          serverId,
          {
            conversationId,
            archived,
          },
          client,
        );
      },

      async refreshFleetHosts(serverId, client, options) {
        set((state) => ({
          loadingFleetHostsByServerId: {
            ...state.loadingFleetHostsByServerId,
            [serverId]: true,
          },
          fleetHostsErrorByServerId: {
            ...state.fleetHostsErrorByServerId,
            [serverId]: null,
          },
        }));

        try {
          const response = await client.getMainChatFleetHosts(options);
          if (response.error) {
            throw new Error(response.error);
          }
          const result: RefreshFleetHostsResult = {
            localServerId: response.localServerId,
            hosts: response.hosts,
            ...(response.fleetScope ? { fleetScope: response.fleetScope } : {}),
            ...(response.availableRemoteHosts
              ? { availableRemoteHosts: response.availableRemoteHosts }
              : {}),
          };
          set((state) => ({
            fleetHostsByServerId: {
              ...state.fleetHostsByServerId,
              [serverId]: response.hosts,
            },
            ...(response.availableRemoteHosts
              ? {
                  availableRemoteHostsByServerId: {
                    ...state.availableRemoteHostsByServerId,
                    [serverId]: response.availableRemoteHosts,
                  },
                }
              : {}),
            ...(response.fleetScope
              ? {
                  fleetScopeByServerId: {
                    ...state.fleetScopeByServerId,
                    [serverId]: response.fleetScope,
                  },
                }
              : {}),
            localServerIdByServerId: {
              ...state.localServerIdByServerId,
              [serverId]: response.localServerId,
            },
            loadingFleetHostsByServerId: {
              ...state.loadingFleetHostsByServerId,
              [serverId]: false,
            },
            fleetHostsErrorByServerId: {
              ...state.fleetHostsErrorByServerId,
              [serverId]: null,
            },
          }));
          return result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          set((state) => ({
            loadingFleetHostsByServerId: {
              ...state.loadingFleetHostsByServerId,
              [serverId]: false,
            },
            fleetHostsErrorByServerId: {
              ...state.fleetHostsErrorByServerId,
              [serverId]: message,
            },
          }));
          throw error;
        }
      },

      toggleDirectionExpanded(conversationId) {
        set((state) => ({
          expandedDirectionIds: {
            ...state.expandedDirectionIds,
            [conversationId]: !state.expandedDirectionIds[conversationId],
          },
        }));
      },

      setDirectionExpanded(conversationId, expanded) {
        set((state) => {
          if (Boolean(state.expandedDirectionIds[conversationId]) === expanded) {
            return state;
          }
          return {
            expandedDirectionIds: {
              ...state.expandedDirectionIds,
              [conversationId]: expanded,
            },
          };
        });
      },

      toggleSectionCollapsed() {
        set((state) => ({ sectionCollapsed: !state.sectionCollapsed }));
      },

      setSectionCollapsed(collapsed) {
        set((state) =>
          state.sectionCollapsed === collapsed ? state : { sectionCollapsed: collapsed },
        );
      },

      toggleRecentSideCollapsed() {
        set((state) => ({ recentSideCollapsed: !state.recentSideCollapsed }));
      },

      setRecentSideCollapsed(collapsed) {
        set((state) =>
          state.recentSideCollapsed === collapsed ? state : { recentSideCollapsed: collapsed },
        );
      },

      setDismissedFleetSyncNotice(dismissed, serverId) {
        if (serverId) {
          set((state) =>
            Boolean(state.dismissedFleetSyncNoticeByServerId[serverId]) === dismissed
              ? state
              : {
                  dismissedFleetSyncNoticeByServerId: {
                    ...state.dismissedFleetSyncNoticeByServerId,
                    [serverId]: dismissed,
                  },
                },
          );
          return;
        }
        set((state) =>
          state.dismissedFleetSyncNotice === dismissed
            ? state
            : { dismissedFleetSyncNotice: dismissed },
        );
      },

      reset() {
        set({
          conversationsByServerId: {},
          loadingConversationsByServerId: {},
          conversationsErrorByServerId: {},
          fleetHostsByServerId: {},
          availableRemoteHostsByServerId: {},
          fleetScopeByServerId: {},
          localServerIdByServerId: {},
          loadingFleetHostsByServerId: {},
          fleetHostsErrorByServerId: {},
          ...INITIAL_PERSISTED_STATE,
        });
      },
    }),
    {
      name: MAIN_CHAT_DIRECTIONS_PERSIST_KEY,
      storage: createValidatedPersistStorage(AsyncStorage, MainChatDirectionsPersistedStateSchema),
      partialize: (state): MainChatDirectionsPersistedState => ({
        expandedDirectionIds: state.expandedDirectionIds,
        sectionCollapsed: state.sectionCollapsed,
        recentSideCollapsed: state.recentSideCollapsed,
        dismissedFleetSyncNotice: state.dismissedFleetSyncNotice,
        dismissedFleetSyncNoticeByServerId: state.dismissedFleetSyncNoticeByServerId,
      }),
      merge: mergePersistedDirectionsState,
    },
  ),
);
