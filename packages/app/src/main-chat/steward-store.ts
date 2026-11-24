import {
  MAIN_CHAT_DEFAULT_TITLE,
  MainChatFleetScopeSchema,
  isMainChatEnabled,
  normalizeMainChatFleetScope,
  resolveMainChatFleetScope,
  type MainChatFleetHostStatus,
  type MainChatFleetScope,
  type MainChatSettings,
} from "@getpaseo/protocol/main-chat";
import AsyncStorage from "@react-native-async-storage/async-storage";
import equal from "fast-deep-equal";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import type { HostProfile } from "@/types/host-connection";

export const MAIN_CHAT_STEWARD_PERSIST_KEY = "paseo:main-chat-steward-ui";

export const CachedMainChatStewardMetaSchema = z.object({
  title: z.string(),
  hostname: z.string(),
  fleetScope: MainChatFleetScopeSchema.optional(),
  managedHostIds: z.array(z.string()),
  lastSeenAt: z.string(),
});
export type CachedMainChatStewardMeta = z.infer<typeof CachedMainChatStewardMetaSchema>;

export const MainChatStewardPersistedStateSchema = z.strictObject({
  activeStewardServerId: z.string().nullable(),
  defaultStewardServerId: z.string().nullable(),
  filterWorkspacesByActiveSteward: z.boolean(),
  cachedStewardsByServerId: z.record(z.string(), CachedMainChatStewardMetaSchema),
});
export type MainChatStewardPersistedState = z.infer<typeof MainChatStewardPersistedStateSchema>;

export type StewardAccentTone = "accent" | "blue" | "green" | "orange" | "pink" | "indigo";

const NON_DEFAULT_ACCENT_TONES: readonly Exclude<StewardAccentTone, "accent">[] = [
  "blue",
  "green",
  "orange",
  "pink",
  "indigo",
];

/**
 * Computes a deterministic identity tone matching Persona's multi-manager avatar palette:
 * the default steward keeps the primary accent color while other stewards take one of five
 * stable hues derived from the UTF-8 byte sum of their `serverId`.
 */
export function resolveStewardAccentTone(serverId: string, isDefault: boolean): StewardAccentTone {
  if (isDefault) return "accent";
  let sum = 0;
  for (let index = 0; index < serverId.length; index += 1) {
    sum += serverId.charCodeAt(index);
  }
  return NON_DEFAULT_ACCENT_TONES[sum % NON_DEFAULT_ACCENT_TONES.length] ?? "blue";
}

export interface ResolveStewardAllowedServerIdsInput {
  stewardServerId: string | null | undefined;
  settings?: Pick<MainChatSettings, "fleetScope"> | null;
  fleetHosts?: readonly MainChatFleetHostStatus[] | null;
  cachedManagedHostIds?: readonly string[] | null;
  /**
   * Optional fallback server IDs when `fleetScope` is `all_connected` and the daemon has not
   * yet reported `fleetHosts` (preserves legacy single-host hydration behavior).
   */
  fallbackAllServerIds?: readonly string[] | null;
}

/**
 * Returns the exact set of host `serverId`s that a steward is allowed to observe and manage.
 * Always includes the steward's own host `serverId`.
 */
export function resolveStewardAllowedServerIds(
  input: ResolveStewardAllowedServerIdsInput,
): Set<string> {
  const allowed = new Set<string>();
  const stewardId = input.stewardServerId?.trim();
  if (!stewardId) return allowed;
  allowed.add(stewardId);

  const scope = resolveMainChatFleetScope(input.settings, stewardId);
  if (scope.mode === "local_only") {
    return allowed;
  }

  if (scope.mode === "allowlist") {
    for (const hostId of scope.hostServerIds) {
      const trimmed = hostId.trim();
      if (trimmed) allowed.add(trimmed);
    }
    return allowed;
  }

  // mode === "all_connected"
  if (input.fleetHosts && input.fleetHosts.length > 0) {
    for (const host of input.fleetHosts) {
      if (host.serverId.trim()) allowed.add(host.serverId.trim());
    }
    return allowed;
  }

  if (input.cachedManagedHostIds && input.cachedManagedHostIds.length > 0) {
    for (const hostId of input.cachedManagedHostIds) {
      if (hostId.trim()) allowed.add(hostId.trim());
    }
    return allowed;
  }

  if (input.fallbackAllServerIds) {
    for (const hostId of input.fallbackAllServerIds) {
      if (hostId.trim()) allowed.add(hostId.trim());
    }
  }

  return allowed;
}

export interface MainChatStewardRosterCandidateHost {
  serverId: string;
  label: string;
  hostname: string | null;
  online: boolean;
  supportsMainChat: boolean;
  hasExistingMainChat: boolean;
}

export interface MainChatStewardRosterItem {
  serverId: string;
  title: string;
  hostLabel: string;
  online: boolean;
  isDefault: boolean;
  fleetScope: MainChatFleetScope;
  managedHostIds: string[];
  managedHostLabels: string[];
  lastSeenAt: string | null;
  accentTone: StewardAccentTone;
}

function buildRosterHostLabelMap(input: {
  hosts: readonly MainChatStewardRosterCandidateHost[];
  fleetHostsByServerId: Readonly<Record<string, readonly MainChatFleetHostStatus[] | undefined>>;
  hostLabelsByServerId?: Readonly<Record<string, string | undefined>>;
}): Map<string, string> {
  const hostLabelMap = new Map<string, string>();
  if (input.hostLabelsByServerId) {
    for (const [id, label] of Object.entries(input.hostLabelsByServerId)) {
      if (label?.trim()) hostLabelMap.set(id, label.trim());
    }
  }
  for (const host of input.hosts) {
    const resolved = host.label.trim() || host.hostname?.trim() || host.serverId;
    if (resolved && !hostLabelMap.has(host.serverId)) {
      hostLabelMap.set(host.serverId, resolved);
    }
  }
  for (const fleetList of Object.values(input.fleetHostsByServerId)) {
    if (!fleetList) continue;
    for (const fleetHost of fleetList) {
      if (fleetHost.label.trim() && !hostLabelMap.has(fleetHost.serverId)) {
        hostLabelMap.set(fleetHost.serverId, fleetHost.label.trim());
      }
    }
  }
  return hostLabelMap;
}

function collectRosterServerIds(
  hosts: readonly MainChatStewardRosterCandidateHost[],
  candidateById: ReadonlyMap<string, MainChatStewardRosterCandidateHost>,
  cachedStewardsByServerId: Readonly<Record<string, CachedMainChatStewardMeta | undefined>>,
): Set<string> {
  const serverIds = new Set<string>();
  for (const host of hosts) {
    if (host.supportsMainChat || host.hasExistingMainChat) {
      serverIds.add(host.serverId);
    }
  }
  for (const cachedId of Object.keys(cachedStewardsByServerId)) {
    if (candidateById.has(cachedId)) {
      serverIds.add(cachedId);
    }
  }
  return serverIds;
}

function resolveRosterItemDisplay(input: {
  serverId: string;
  candidate: MainChatStewardRosterCandidateHost | undefined;
  settings: MainChatSettings | undefined;
  cached: CachedMainChatStewardMeta | undefined;
  hostLabelMap: ReadonlyMap<string, string>;
}): { title: string; hostLabel: string } {
  const hostLabel =
    input.hostLabelMap.get(input.serverId) ??
    input.candidate?.hostname?.trim() ??
    input.cached?.hostname?.trim() ??
    input.serverId;
  const title =
    input.settings?.title?.trim() || input.cached?.title?.trim() || MAIN_CHAT_DEFAULT_TITLE;
  return { title, hostLabel };
}

function resolveRosterItemScope(input: {
  serverId: string;
  settings: MainChatSettings | undefined;
  cached: CachedMainChatStewardMeta | undefined;
  fleetHosts: readonly MainChatFleetHostStatus[] | undefined;
}): { fleetScope: MainChatFleetScope; managedHostIds: string[] } {
  const fleetScope = input.settings
    ? resolveMainChatFleetScope(input.settings, input.serverId)
    : normalizeMainChatFleetScope(input.cached?.fleetScope, input.serverId);
  const scopeSettings =
    input.settings ??
    (input.cached?.fleetScope ? { fleetScope: input.cached.fleetScope } : undefined);
  const allowedSet = resolveStewardAllowedServerIds({
    stewardServerId: input.serverId,
    settings: scopeSettings,
    fleetHosts: input.fleetHosts,
    cachedManagedHostIds: input.cached?.managedHostIds,
    fallbackAllServerIds: null,
  });
  return { fleetScope, managedHostIds: Array.from(allowedSet) };
}

function buildSingleRosterItem(input: {
  serverId: string;
  candidate: MainChatStewardRosterCandidateHost | undefined;
  settings: MainChatSettings | undefined;
  cached: CachedMainChatStewardMeta | undefined;
  fleetHosts: readonly MainChatFleetHostStatus[] | undefined;
  hostLabelMap: ReadonlyMap<string, string>;
}): MainChatStewardRosterItem | null {
  const { serverId, candidate, settings, cached, fleetHosts, hostLabelMap } = input;
  if (settings !== undefined && !isMainChatEnabled(settings)) {
    return null;
  }
  const online = Boolean(candidate?.online);
  if (!online && !cached && !candidate?.hasExistingMainChat) {
    return null;
  }

  const { fleetScope, managedHostIds } = resolveRosterItemScope({
    serverId,
    settings,
    cached,
    fleetHosts,
  });
  const managedHostLabels = managedHostIds.map((id) => hostLabelMap.get(id) ?? id);
  const { title, hostLabel } = resolveRosterItemDisplay({
    serverId,
    candidate,
    settings,
    cached,
    hostLabelMap,
  });

  return {
    serverId,
    title,
    hostLabel,
    online,
    isDefault: false,
    fleetScope,
    managedHostIds,
    managedHostLabels,
    lastSeenAt: cached?.lastSeenAt ?? null,
    accentTone: resolveStewardAccentTone(serverId, false),
  };
}

export function buildStewardRoster(input: {
  hosts: readonly MainChatStewardRosterCandidateHost[];
  settingsByServerId: Readonly<Record<string, MainChatSettings | undefined>>;
  fleetHostsByServerId: Readonly<Record<string, readonly MainChatFleetHostStatus[] | undefined>>;
  cachedStewardsByServerId: Readonly<Record<string, CachedMainChatStewardMeta | undefined>>;
  defaultStewardServerId: string | null;
  hostLabelsByServerId?: Readonly<Record<string, string | undefined>>;
}): MainChatStewardRosterItem[] {
  const hostLabelMap = buildRosterHostLabelMap(input);
  const candidateById = new Map<string, MainChatStewardRosterCandidateHost>();
  for (const host of input.hosts) {
    candidateById.set(host.serverId, host);
  }
  const serverIds = collectRosterServerIds(
    input.hosts,
    candidateById,
    input.cachedStewardsByServerId,
  );

  const items: MainChatStewardRosterItem[] = [];
  for (const serverId of serverIds) {
    const item = buildSingleRosterItem({
      serverId,
      candidate: candidateById.get(serverId),
      settings: input.settingsByServerId[serverId],
      cached: input.cachedStewardsByServerId[serverId],
      fleetHosts: input.fleetHostsByServerId[serverId],
      hostLabelMap,
    });
    if (item) items.push(item);
  }

  const explicitDefaultExists = Boolean(
    input.defaultStewardServerId &&
    items.some((item) => item.serverId === input.defaultStewardServerId),
  );
  const effectiveDefaultId = explicitDefaultExists
    ? input.defaultStewardServerId
    : (items.find((item) => item.online)?.serverId ?? items[0]?.serverId ?? null);

  for (const item of items) {
    const isDefault = item.serverId === effectiveDefaultId;
    item.isDefault = isDefault;
    item.accentTone = resolveStewardAccentTone(item.serverId, isDefault);
  }

  items.sort((left, right) => {
    const leftDefault = left.isDefault ? 0 : 1;
    const rightDefault = right.isDefault ? 0 : 1;
    if (leftDefault !== rightDefault) return leftDefault - rightDefault;
    const leftOnline = left.online ? 0 : 1;
    const rightOnline = right.online ? 0 : 1;
    if (leftOnline !== rightOnline) return leftOnline - rightOnline;
    return left.title.localeCompare(right.title);
  });

  return items;
}

export function resolveActiveStewardServerId(input: {
  routeServerId?: string | null;
  activeStewardServerId: string | null;
  defaultStewardServerId: string | null;
  roster: readonly MainChatStewardRosterItem[];
  fallbackServerId?: string | null;
}): string | null {
  const routeId = input.routeServerId?.trim() || null;
  if (routeId) {
    return routeId;
  }
  if (
    input.activeStewardServerId &&
    input.roster.some((item) => item.serverId === input.activeStewardServerId)
  ) {
    return input.activeStewardServerId;
  }
  if (
    input.defaultStewardServerId &&
    input.roster.some((item) => item.serverId === input.defaultStewardServerId)
  ) {
    return input.defaultStewardServerId;
  }
  const firstOnline = input.roster.find((item) => item.online);
  if (firstOnline) return firstOnline.serverId;
  if (input.roster[0]) return input.roster[0].serverId;
  return input.fallbackServerId ?? null;
}

export type StewardHostConflictKind = "duplicate_managed" | "local_and_remote_steward";

export interface StewardHostConflictOwner {
  stewardServerId: string;
  stewardTitle: string;
  stewardHostLabel: string;
  isLocalOwner: boolean;
}

export interface StewardHostConflict {
  id: string;
  kind: StewardHostConflictKind;
  targetServerId: string;
  targetHostLabel: string;
  owners: StewardHostConflictOwner[];
}

function buildConflictHostLabels(input: {
  hosts: readonly Pick<HostProfile, "serverId" | "label">[];
  fleetHostsByServerId: Readonly<Record<string, readonly MainChatFleetHostStatus[] | undefined>>;
  sessionHostnamesByServerId?: Readonly<Record<string, string | undefined>>;
}): Map<string, string> {
  const hostLabels = new Map<string, string>();
  for (const host of input.hosts) {
    const label =
      host.label.trim() ||
      input.sessionHostnamesByServerId?.[host.serverId]?.trim() ||
      host.serverId;
    hostLabels.set(host.serverId, label);
  }
  for (const fleetList of Object.values(input.fleetHostsByServerId)) {
    if (!fleetList) continue;
    for (const entry of fleetList) {
      if (entry.label.trim() && !hostLabels.has(entry.serverId)) {
        hostLabels.set(entry.serverId, entry.label.trim());
      }
    }
  }
  return hostLabels;
}

/**
 * Cross-checks all enabled stewards to detect hosts claimed by more than one steward:
 * 1. `local_and_remote_steward`: host runs its own enabled local steward while also inside
 *    another enabled steward's fleet scope (e.g. MacBook running local steward while managed by DevBox).
 * 2. `duplicate_managed`: host is managed remotely by two or more enabled stewards simultaneously.
 */
export function detectStewardHostConflicts(input: {
  hosts: readonly Pick<HostProfile, "serverId" | "label">[];
  capableServerIds: ReadonlySet<string>;
  settingsByServerId: Readonly<Record<string, MainChatSettings | undefined>>;
  fleetHostsByServerId: Readonly<Record<string, readonly MainChatFleetHostStatus[] | undefined>>;
  sessionHostnamesByServerId?: Readonly<Record<string, string | undefined>>;
}): StewardHostConflict[] {
  const hostLabels = buildConflictHostLabels(input);
  const ownersByTarget = new Map<string, StewardHostConflictOwner[]>();
  let enabledCount = 0;

  for (const serverId of input.capableServerIds) {
    const settings = input.settingsByServerId[serverId];
    if (settings !== undefined && !isMainChatEnabled(settings)) continue;
    enabledCount += 1;
    const managedIds = resolveStewardAllowedServerIds({
      stewardServerId: serverId,
      settings,
      fleetHosts: input.fleetHostsByServerId[serverId],
      fallbackAllServerIds: null,
    });
    const stewardTitle = settings?.title?.trim() || MAIN_CHAT_DEFAULT_TITLE;
    const stewardHostLabel = hostLabels.get(serverId) ?? serverId;

    for (const targetId of managedIds) {
      const list = ownersByTarget.get(targetId) ?? [];
      list.push({
        stewardServerId: serverId,
        stewardTitle,
        stewardHostLabel,
        isLocalOwner: serverId === targetId,
      });
      ownersByTarget.set(targetId, list);
    }
  }

  if (enabledCount <= 1) return [];

  const conflicts: StewardHostConflict[] = [];
  for (const [targetServerId, owners] of ownersByTarget.entries()) {
    if (owners.length < 2) continue;
    const kind: StewardHostConflictKind = owners.some((owner) => owner.isLocalOwner)
      ? "local_and_remote_steward"
      : "duplicate_managed";
    conflicts.push({
      id: `${kind}:${targetServerId}`,
      kind,
      targetServerId,
      targetHostLabel: hostLabels.get(targetServerId) ?? targetServerId,
      owners,
    });
  }

  conflicts.sort((left, right) => left.targetHostLabel.localeCompare(right.targetHostLabel));
  return conflicts;
}

export interface MainChatStewardStoreState extends MainChatStewardPersistedState {
  setActiveStewardServerId: (serverId: string | null) => void;
  setDefaultStewardServerId: (serverId: string | null) => void;
  setFilterWorkspacesByActiveSteward: (enabled: boolean) => void;
  upsertCachedSteward: (serverId: string, meta: CachedMainChatStewardMeta) => void;
  removeCachedSteward: (serverId: string) => void;
  reset: () => void;
}

const INITIAL_PERSISTED_STATE: MainChatStewardPersistedState = {
  activeStewardServerId: null,
  defaultStewardServerId: null,
  filterWorkspacesByActiveSteward: false,
  cachedStewardsByServerId: {},
};

function mergePersistedStewardState(
  persistedState: unknown,
  currentState: MainChatStewardStoreState,
): MainChatStewardStoreState {
  const parsed = MainChatStewardPersistedStateSchema.safeParse(persistedState);
  if (!parsed.success) {
    return currentState;
  }
  return {
    ...currentState,
    activeStewardServerId: parsed.data.activeStewardServerId,
    defaultStewardServerId: parsed.data.defaultStewardServerId,
    filterWorkspacesByActiveSteward: parsed.data.filterWorkspacesByActiveSteward,
    cachedStewardsByServerId: parsed.data.cachedStewardsByServerId,
  };
}

export const useMainChatStewardStore = create<MainChatStewardStoreState>()(
  persist<MainChatStewardStoreState, [], [], MainChatStewardPersistedState>(
    (set) => ({
      ...INITIAL_PERSISTED_STATE,

      setActiveStewardServerId(serverId) {
        const normalized = serverId?.trim() || null;
        set((state) =>
          state.activeStewardServerId === normalized
            ? state
            : { activeStewardServerId: normalized },
        );
      },

      setDefaultStewardServerId(serverId) {
        const normalized = serverId?.trim() || null;
        set((state) =>
          state.defaultStewardServerId === normalized
            ? state
            : { defaultStewardServerId: normalized },
        );
      },

      setFilterWorkspacesByActiveSteward(enabled) {
        set((state) =>
          state.filterWorkspacesByActiveSteward === enabled
            ? state
            : { filterWorkspacesByActiveSteward: enabled },
        );
      },

      upsertCachedSteward(serverId, meta) {
        const normalizedId = serverId.trim();
        if (!normalizedId) return;
        set((state) => {
          const existing = state.cachedStewardsByServerId[normalizedId];
          if (
            existing &&
            existing.title === meta.title &&
            existing.hostname === meta.hostname &&
            equal(existing.fleetScope, meta.fleetScope) &&
            equal(existing.managedHostIds, meta.managedHostIds)
          ) {
            return state;
          }
          return {
            cachedStewardsByServerId: {
              ...state.cachedStewardsByServerId,
              [normalizedId]: meta,
            },
          };
        });
      },

      removeCachedSteward(serverId) {
        const normalizedId = serverId.trim();
        if (!normalizedId) return;
        set((state) => {
          if (!(normalizedId in state.cachedStewardsByServerId)) return state;
          const next = { ...state.cachedStewardsByServerId };
          delete next[normalizedId];
          return {
            cachedStewardsByServerId: next,
            ...(state.activeStewardServerId === normalizedId
              ? { activeStewardServerId: null }
              : {}),
            ...(state.defaultStewardServerId === normalizedId
              ? { defaultStewardServerId: null }
              : {}),
          };
        });
      },

      reset() {
        set({ ...INITIAL_PERSISTED_STATE });
      },
    }),
    {
      name: MAIN_CHAT_STEWARD_PERSIST_KEY,
      storage: createValidatedPersistStorage(AsyncStorage, MainChatStewardPersistedStateSchema),
      partialize: (state): MainChatStewardPersistedState => ({
        activeStewardServerId: state.activeStewardServerId,
        defaultStewardServerId: state.defaultStewardServerId,
        filterWorkspacesByActiveSteward: state.filterWorkspacesByActiveSteward,
        cachedStewardsByServerId: state.cachedStewardsByServerId,
      }),
      merge: mergePersistedStewardState,
    },
  ),
);
