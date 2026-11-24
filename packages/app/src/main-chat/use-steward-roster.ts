import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { isMainChatEnabled, resolveMainChatFleetScope } from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useMainChatConversationsStore } from "./conversations-store";
import { useMainChatDrawerStore } from "./drawer-store";
import { findMainChatAgentOnHost, selectStewardActivitySummary } from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";
import {
  buildStewardRoster,
  resolveActiveStewardServerId,
  resolveStewardAllowedServerIds,
  useMainChatStewardStore,
  type MainChatStewardRosterCandidateHost,
  type MainChatStewardRosterItem,
} from "./steward-store";

export interface MainChatStewardRosterItemWithActivity extends MainChatStewardRosterItem {
  isMainRunning: boolean;
  needsYouCount: number;
  runningCount: number;
  attentionCount: number;
  totalActiveCount: number;
}

interface CapableSessionEntry {
  serverId: string;
  hostname: string | null;
  online: boolean;
  supportsMainChat: boolean;
  hasExistingMainChat: boolean;
}

/**
 * Hydrates `MainChatSettings` and `fleetHosts` across every connected host that advertises
 * `features.mainChat === true`, and mirrors enabled stewards into the persisted offline cache.
 */
export function useMainChatRosterSync(): void {
  const hosts = useHosts();
  const settingsByServerId = useMainChatSettingsStore((state) => state.settingsByServerId);
  const loadingSettingsByServerId = useMainChatSettingsStore((state) => state.loadingByServerId);
  const loadSettings = useMainChatSettingsStore((state) => state.loadSettings);
  const fleetHostsByServerId = useMainChatConversationsStore((state) => state.fleetHostsByServerId);
  const loadingFleetHostsByServerId = useMainChatConversationsStore(
    (state) => state.loadingFleetHostsByServerId,
  );
  const refreshFleetHosts = useMainChatConversationsStore((state) => state.refreshFleetHosts);
  const upsertCachedSteward = useMainChatStewardStore((state) => state.upsertCachedSteward);
  const removeCachedSteward = useMainChatStewardStore((state) => state.removeCachedSteward);

  const capableEntries = useStoreWithEqualityFn(
    useSessionStore,
    useCallback((state): CapableSessionEntry[] => {
      const entries: CapableSessionEntry[] = [];
      for (const [serverId, session] of Object.entries(state.sessions)) {
        const hasExistingMainChat = findMainChatAgentOnHost(session, serverId) !== null;
        const supportsMainChat =
          hasExistingMainChat || session.serverInfo?.features?.mainChat === true;
        if (!supportsMainChat) continue;
        entries.push({
          serverId,
          hostname: session.serverInfo?.hostname?.trim() || null,
          online: Boolean(session.client),
          supportsMainChat,
          hasExistingMainChat,
        });
      }
      return entries;
    }, []),
    equal,
  );

  const syncedSettingsClientsRef = useRef<Map<string, DaemonClient>>(new Map());
  const syncedFleetClientsRef = useRef<Map<string, DaemonClient>>(new Map());

  useEffect(() => {
    const sessions = useSessionStore.getState().sessions;
    for (const entry of capableEntries) {
      if (!entry.online) continue;
      const client = sessions[entry.serverId]?.client;
      if (!client) continue;

      const hasSettings = Boolean(settingsByServerId[entry.serverId]);
      const isLoadingSettings = Boolean(loadingSettingsByServerId[entry.serverId]);
      if (
        !hasSettings &&
        !isLoadingSettings &&
        syncedSettingsClientsRef.current.get(entry.serverId) !== client &&
        typeof client.getMainChatSettings === "function"
      ) {
        syncedSettingsClientsRef.current.set(entry.serverId, client);
        void loadSettings(entry.serverId, client).catch(() => {
          syncedSettingsClientsRef.current.delete(entry.serverId);
        });
      }

      const settings = settingsByServerId[entry.serverId];
      const enabled = isMainChatEnabled(settings);
      const hasFleetHosts = Boolean(fleetHostsByServerId[entry.serverId]);
      const isLoadingFleetHosts = Boolean(loadingFleetHostsByServerId[entry.serverId]);
      if (
        enabled &&
        !hasFleetHosts &&
        !isLoadingFleetHosts &&
        syncedFleetClientsRef.current.get(entry.serverId) !== client &&
        typeof client.getMainChatFleetHosts === "function"
      ) {
        syncedFleetClientsRef.current.set(entry.serverId, client);
        void refreshFleetHosts(entry.serverId, client).catch(() => {
          syncedFleetClientsRef.current.delete(entry.serverId);
        });
      }
    }
  }, [
    capableEntries,
    fleetHostsByServerId,
    loadSettings,
    loadingFleetHostsByServerId,
    loadingSettingsByServerId,
    refreshFleetHosts,
    settingsByServerId,
  ]);

  const hostLabelByServerId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const host of hosts) {
      if (host.label.trim()) map[host.serverId] = host.label.trim();
    }
    return map;
  }, [hosts]);

  useEffect(() => {
    for (const entry of capableEntries) {
      const settings = settingsByServerId[entry.serverId];
      if (!settings) continue;
      if (!isMainChatEnabled(settings)) {
        removeCachedSteward(entry.serverId);
        continue;
      }
      const fleetHosts = fleetHostsByServerId[entry.serverId];
      const allowed = resolveStewardAllowedServerIds({
        stewardServerId: entry.serverId,
        settings,
        fleetHosts,
        fallbackAllServerIds: null,
      });
      upsertCachedSteward(entry.serverId, {
        title: settings.title,
        hostname: hostLabelByServerId[entry.serverId] || entry.hostname || entry.serverId,
        fleetScope: resolveMainChatFleetScope(settings, entry.serverId),
        managedHostIds: Array.from(allowed),
        lastSeenAt: new Date().toISOString(),
      });
    }
  }, [
    capableEntries,
    fleetHostsByServerId,
    hostLabelByServerId,
    removeCachedSteward,
    settingsByServerId,
    upsertCachedSteward,
  ]);
}

/**
 * Returns the exact set of host `serverId`s visible to a given steward.
 * Returns `null` when `stewardServerId` is empty or when `fleetScope.mode === "all_connected"`
 * and neither `fleetHosts` nor cached managed hosts have hydrated yet (legacy single-host fallback).
 */
export function useStewardAllowedServerIds(
  stewardServerId: string | null | undefined,
): ReadonlySet<string> | null {
  const normalizedId = stewardServerId?.trim() || null;
  const settings = useMainChatSettingsStore((state) =>
    normalizedId ? state.settingsByServerId[normalizedId] : undefined,
  );
  const fleetHosts = useMainChatConversationsStore((state) =>
    normalizedId ? state.fleetHostsByServerId[normalizedId] : undefined,
  );
  const cached = useMainChatStewardStore((state) =>
    normalizedId ? state.cachedStewardsByServerId[normalizedId] : undefined,
  );

  const idsKey = useMemo(() => {
    if (!normalizedId) return "";
    const scope = resolveMainChatFleetScope(settings, normalizedId);
    if (
      scope.mode === "all_connected" &&
      (!fleetHosts || fleetHosts.length === 0) &&
      (!cached?.managedHostIds || cached.managedHostIds.length === 0)
    ) {
      return "";
    }
    const resolved = resolveStewardAllowedServerIds({
      stewardServerId: normalizedId,
      settings,
      fleetHosts,
      cachedManagedHostIds: cached?.managedHostIds,
      fallbackAllServerIds: null,
    });
    return Array.from(resolved).sort().join("\u0000");
  }, [cached?.managedHostIds, fleetHosts, normalizedId, settings]);

  return useMemo(() => {
    if (!idsKey) return null;
    return new Set(idsKey.split("\u0000"));
  }, [idsKey]);
}

export interface MainChatStewardRosterHookResult {
  roster: MainChatStewardRosterItemWithActivity[];
  activeServerId: string | null;
  activeSteward: MainChatStewardRosterItemWithActivity | null;
  activeAllowedServerIds: ReadonlySet<string> | null;
  hasMultipleStewards: boolean;
  otherNeedsYouCount: number;
  selectSteward: (serverId: string) => void;
}

function toRosterCandidateHost(
  serverId: string,
  session: ReturnType<typeof useSessionStore.getState>["sessions"][string] | undefined,
  preferredLabel?: string,
): MainChatStewardRosterCandidateHost {
  const hasExistingMainChat = findMainChatAgentOnHost(session, serverId) !== null;
  const hostname = session?.serverInfo?.hostname?.trim() || null;
  return {
    serverId,
    label: preferredLabel?.trim() || hostname || serverId,
    hostname,
    online: Boolean(session?.client),
    supportsMainChat: hasExistingMainChat || session?.serverInfo?.features?.mainChat === true,
    hasExistingMainChat,
  };
}

export function useMainChatStewardRoster(options?: {
  routeServerId?: string | null;
  fallbackPreferredServerId?: string | null;
}): MainChatStewardRosterHookResult {
  const hosts = useHosts();
  const settingsByServerId = useMainChatSettingsStore((state) => state.settingsByServerId);
  const fleetHostsByServerId = useMainChatConversationsStore((state) => state.fleetHostsByServerId);
  const activeStewardServerId = useMainChatStewardStore((state) => state.activeStewardServerId);
  const defaultStewardServerId = useMainChatStewardStore((state) => state.defaultStewardServerId);
  const cachedStewardsByServerId = useMainChatStewardStore(
    (state) => state.cachedStewardsByServerId,
  );
  const setActiveStewardServerId = useMainChatStewardStore(
    (state) => state.setActiveStewardServerId,
  );
  const setDrawerStewardContext = useMainChatDrawerStore((state) => state.setActiveStewardContext);

  const hostLabelsByServerId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const host of hosts) {
      if (host.label.trim()) map[host.serverId] = host.label.trim();
    }
    return map;
  }, [hosts]);

  const sessionHostEntries = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state): MainChatStewardRosterCandidateHost[] => {
        const seen = new Set<string>();
        const list: MainChatStewardRosterCandidateHost[] = [];
        for (const host of hosts) {
          seen.add(host.serverId);
          list.push(
            toRosterCandidateHost(host.serverId, state.sessions[host.serverId], host.label),
          );
        }
        for (const [serverId, session] of Object.entries(state.sessions)) {
          if (seen.has(serverId)) continue;
          list.push(toRosterCandidateHost(serverId, session));
        }
        return list;
      },
      [hosts],
    ),
    equal,
  );

  const baseRoster = useMemo(
    () =>
      buildStewardRoster({
        hosts: sessionHostEntries,
        settingsByServerId,
        fleetHostsByServerId,
        cachedStewardsByServerId,
        defaultStewardServerId,
        hostLabelsByServerId,
      }),
    [
      cachedStewardsByServerId,
      defaultStewardServerId,
      fleetHostsByServerId,
      hostLabelsByServerId,
      sessionHostEntries,
      settingsByServerId,
    ],
  );

  const activityBySteward = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => {
        const result: Record<
          string,
          {
            isMainRunning: boolean;
            needsYouCount: number;
            runningCount: number;
            attentionCount: number;
            totalActiveCount: number;
          }
        > = {};
        const singleLegacyAllConnected =
          baseRoster.length === 1 &&
          baseRoster[0]?.fleetScope.mode === "all_connected" &&
          !fleetHostsByServerId[baseRoster[0].serverId]?.length;

        for (const item of baseRoster) {
          const scopeSet = singleLegacyAllConnected ? null : new Set(item.managedHostIds);
          const summary = selectStewardActivitySummary(state, item.serverId, scopeSet);
          result[item.serverId] = {
            isMainRunning: summary.isMainRunning,
            needsYouCount: summary.needsYouCount,
            runningCount: summary.runningCount,
            attentionCount: summary.attentionCount,
            totalActiveCount: summary.totalActiveCount,
          };
        }
        return result;
      },
      [baseRoster, fleetHostsByServerId],
    ),
    equal,
  );

  const roster = useMemo<MainChatStewardRosterItemWithActivity[]>(
    () =>
      baseRoster.map((item) => {
        const activity = activityBySteward[item.serverId];
        return {
          ...item,
          isMainRunning: activity?.isMainRunning ?? false,
          needsYouCount: activity?.needsYouCount ?? 0,
          runningCount: activity?.runningCount ?? 0,
          attentionCount: activity?.attentionCount ?? 0,
          totalActiveCount: activity?.totalActiveCount ?? 0,
        };
      }),
    [activityBySteward, baseRoster],
  );

  const activeServerId = useMemo(
    () =>
      resolveActiveStewardServerId({
        routeServerId: options?.routeServerId,
        activeStewardServerId,
        defaultStewardServerId,
        roster,
        fallbackServerId: options?.fallbackPreferredServerId,
      }),
    [
      activeStewardServerId,
      defaultStewardServerId,
      options?.fallbackPreferredServerId,
      options?.routeServerId,
      roster,
    ],
  );

  const activeSteward = useMemo(
    () => roster.find((item) => item.serverId === activeServerId) ?? null,
    [activeServerId, roster],
  );

  const activeAllowedServerIds = useMemo<ReadonlySet<string> | null>(() => {
    if (!activeServerId) return null;
    if (activeSteward) {
      // Preserve single-steward legacy all_connected fallback before fleetHosts hydrates
      if (
        roster.length === 1 &&
        activeSteward.fleetScope.mode === "all_connected" &&
        !fleetHostsByServerId[activeServerId]?.length
      ) {
        return null;
      }
      return new Set(activeSteward.managedHostIds);
    }
    return new Set([activeServerId]);
  }, [activeServerId, activeSteward, fleetHostsByServerId, roster.length]);

  const otherNeedsYouCount = useMemo(() => {
    let total = 0;
    for (const item of roster) {
      if (item.serverId === activeServerId) continue;
      total += item.needsYouCount;
    }
    return total;
  }, [activeServerId, roster]);

  const selectSteward = useCallback(
    (serverId: string) => {
      const normalized = serverId.trim();
      if (!normalized) return;
      setActiveStewardServerId(normalized);
      const target = roster.find((item) => item.serverId === normalized);
      setDrawerStewardContext(
        normalized,
        target ? new Set(target.managedHostIds) : new Set([normalized]),
      );
    },
    [roster, setActiveStewardServerId, setDrawerStewardContext],
  );

  return {
    roster,
    activeServerId,
    activeSteward,
    activeAllowedServerIds,
    hasMultipleStewards: roster.length > 1,
    otherNeedsYouCount,
    selectSteward,
  };
}

/**
 * Optional workspace list host filter controlled by the user preference
 * `filterWorkspacesByActiveSteward` (off by default). Returns `undefined` when off so the sidebar
 * shows all connected hosts as usual.
 */
export function useStewardWorkspaceHostFilters(): readonly string[] | undefined {
  const filterEnabled = useMainChatStewardStore((state) => state.filterWorkspacesByActiveSteward);
  const { activeAllowedServerIds } = useMainChatStewardRoster();

  return useMemo(() => {
    if (!filterEnabled || !activeAllowedServerIds || activeAllowedServerIds.size === 0) {
      return undefined;
    }
    return Array.from(activeAllowedServerIds);
  }, [activeAllowedServerIds, filterEnabled]);
}
