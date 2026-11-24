import {
  isMainChatEnabled,
  isMainChatLabels,
  resolveMainChatFleetScope,
  type MainChatFleetHostStatus,
} from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useToast } from "@/contexts/toast-context";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useMainChatConversationsStore } from "./conversations-store";
import {
  buildMainChatHostGroupsPartition,
  computeJoinGroupFleetScope,
  computeLeaveGroupFleetScope,
  ensureHostRegisteredOnOwnerDaemon,
  type HostGroupSessionSnapshot,
  type MainChatHostGroup,
  type MainChatHostGroupsPartition,
} from "./host-groups";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { findMainChatAgentOnHost } from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";
import { useMainChatStewardStore } from "./steward-store";
import { useMainChatRosterSync } from "./use-steward-roster";

export interface UseMainChatHostGroupsOptions {
  /** Overrides which group is highlighted as active (e.g. routeServerId on /main or edited host in Settings). */
  activeGroupServerId?: string | null;
  /** Optional overview mainAgentId for the current /main screen to fill in initial fleetHosts before RPC refresh. */
  activeMainAgentId?: string | null;
  /** Invoked when the user clicks a group header or creates a new group. */
  onSelectGroup?: (ownerServerId: string) => void;
}

export interface MainChatHostGroupsController {
  partition: MainChatHostGroupsPartition;
  activeGroupServerId: string | null;
  busyKey: string | null;
  refreshing: boolean;
  confirmDisbandGroupId: string | null;
  selectGroup: (ownerServerId: string) => void;
  promoteHostToMainChat: (serverId: string) => void;
  joinHostToGroup: (hostServerId: string, targetOwnerServerId: string) => void;
  requestLeaveGroup: (hostServerId: string, groupOwnerServerId: string) => void;
  confirmDisbandGroup: (groupOwnerServerId: string) => void;
  cancelDisbandGroup: () => void;
  resolveLegacyDisableLocal: (targetServerId: string, targetHostLabel: string) => void;
  resolveLegacyRemoveFromRemote: (
    stewardServerId: string,
    targetServerId: string,
    targetHostLabel: string,
    stewardHostLabel: string,
  ) => void;
  refreshAll: () => void;
}

function selectHostGroupSessions(
  state: ReturnType<typeof useSessionStore.getState>,
): Record<string, HostGroupSessionSnapshot> {
  const result: Record<string, HostGroupSessionSnapshot> = {};
  for (const [serverId, session] of Object.entries(state.sessions)) {
    const hasExistingMainChat = findMainChatAgentOnHost(session, serverId) !== null;
    const supportsMainChat = hasExistingMainChat || session.serverInfo?.features?.mainChat === true;
    const pendingAgentIds = new Set<string>();
    for (const perm of session.pendingPermissions.values()) {
      pendingAgentIds.add(perm.agentId);
    }

    let agentCount = 0;
    let needsAttentionCount = 0;
    for (const agent of session.agents.values()) {
      if (agent.archivedAt || agent.background) continue;
      if (isMainChatLabels(agent.labels)) continue;
      agentCount += 1;
      if (
        agent.requiresAttention ||
        pendingAgentIds.has(agent.id) ||
        agent.pendingPermissions.length > 0 ||
        agent.status === "error"
      ) {
        needsAttentionCount += 1;
      }
    }

    result[serverId] = {
      serverId,
      hostname: session.serverInfo?.hostname?.trim() || null,
      online: Boolean(session.client),
      supportsMainChat,
      hasExistingMainChat,
      agentCount,
      needsAttentionCount,
    };
  }
  return result;
}

export function useMainChatHostGroups(
  options: UseMainChatHostGroupsOptions = {},
): MainChatHostGroupsController {
  const { activeGroupServerId: overrideActiveId, activeMainAgentId, onSelectGroup } = options;
  const { t } = useTranslation();
  const toast = useToast();
  const clientHosts = useHosts();

  useMainChatRosterSync();

  const sessionsByServerId = useStoreWithEqualityFn(
    useSessionStore,
    selectHostGroupSessions,
    equal,
  );

  const settingsByServerId = useMainChatSettingsStore((state) => state.settingsByServerId);
  const updateSettings = useMainChatSettingsStore((state) => state.updateSettings);
  const storeFleetHostsByServerId = useMainChatConversationsStore(
    (state) => state.fleetHostsByServerId,
  );
  const availableRemoteHostsByServerId = useMainChatConversationsStore(
    (state) => state.availableRemoteHostsByServerId,
  );
  const refreshFleetHosts = useMainChatConversationsStore((state) => state.refreshFleetHosts);
  const storedActiveId = useMainChatStewardStore((state) => state.activeStewardServerId);
  const defaultStewardServerId = useMainChatStewardStore((state) => state.defaultStewardServerId);
  const cachedStewardsByServerId = useMainChatStewardStore(
    (state) => state.cachedStewardsByServerId,
  );
  const setActiveStewardServerId = useMainChatStewardStore(
    (state) => state.setActiveStewardServerId,
  );
  const removeCachedSteward = useMainChatStewardStore((state) => state.removeCachedSteward);

  const overviewKey =
    overrideActiveId && activeMainAgentId
      ? overviewStoreKey(overrideActiveId, activeMainAgentId)
      : null;
  const overviewFleetHosts = useMainChatOverviewStore((state) =>
    overviewKey ? (state.overviewsByKey[overviewKey]?.fleetHosts ?? null) : null,
  );

  const fleetHostsByServerId = useMemo<
    Record<string, readonly MainChatFleetHostStatus[] | undefined>
  >(() => {
    if (!overrideActiveId || !overviewFleetHosts || storeFleetHostsByServerId[overrideActiveId]) {
      return storeFleetHostsByServerId;
    }
    return {
      ...storeFleetHostsByServerId,
      [overrideActiveId]: overviewFleetHosts,
    };
  }, [overrideActiveId, overviewFleetHosts, storeFleetHostsByServerId]);

  const effectiveActiveId = overrideActiveId ?? storedActiveId ?? null;

  const partition = useMemo(
    () =>
      buildMainChatHostGroupsPartition({
        clientHosts,
        sessionsByServerId,
        settingsByServerId,
        fleetHostsByServerId,
        availableRemoteHostsByServerId,
        cachedStewardsByServerId,
        activeStewardServerId: effectiveActiveId,
        defaultStewardServerId,
      }),
    [
      availableRemoteHostsByServerId,
      cachedStewardsByServerId,
      clientHosts,
      defaultStewardServerId,
      effectiveActiveId,
      fleetHostsByServerId,
      sessionsByServerId,
      settingsByServerId,
    ],
  );

  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmDisbandGroupId, setConfirmDisbandGroupId] = useState<string | null>(null);

  const findHostLabel = useCallback(
    (serverId: string): string => {
      const fromGroup = partition.groups.find((g) => g.ownerServerId === serverId);
      if (fromGroup) return fromGroup.ownerHostLabel;
      for (const group of partition.groups) {
        const member = group.members.find((m) => m.serverId === serverId);
        if (member) return member.label;
      }
      const fromUnmanaged = partition.unmanaged.find((u) => u.serverId === serverId);
      if (fromUnmanaged) return fromUnmanaged.label;
      const fromClient = clientHosts.find((h) => h.serverId === serverId);
      return fromClient?.label.trim() || sessionsByServerId[serverId]?.hostname?.trim() || serverId;
    },
    [clientHosts, partition.groups, partition.unmanaged, sessionsByServerId],
  );

  const selectGroup = useCallback(
    (ownerServerId: string) => {
      setConfirmDisbandGroupId(null);
      setActiveStewardServerId(ownerServerId);
      onSelectGroup?.(ownerServerId);
    },
    [onSelectGroup, setActiveStewardServerId],
  );

  const executeDisbandGroup = useCallback(
    async (group: MainChatHostGroup) => {
      const ownerId = group.ownerServerId;
      const ownerClient = useSessionStore.getState().sessions[ownerId]?.client ?? null;
      if (!ownerClient) {
        toast.error(t("mainChat.groups.hostOfflineError", { host: group.ownerHostLabel }));
        return;
      }

      setBusyKey(`leave:${ownerId}:${ownerId}`);
      setConfirmDisbandGroupId(null);
      try {
        await updateSettings(
          ownerId,
          {
            enabled: false,
            fleetScope: { mode: "local_only", hostServerIds: [] },
          },
          ownerClient,
        );
        removeCachedSteward(ownerId);

        const nextGroup = partition.groups.find((g) => g.ownerServerId !== ownerId) ?? null;
        if (effectiveActiveId === ownerId) {
          setActiveStewardServerId(nextGroup?.ownerServerId ?? null);
          if (nextGroup) {
            onSelectGroup?.(nextGroup.ownerServerId);
          }
        }
        toast.show(t("mainChat.groups.disbandedToast", { host: group.ownerHostLabel }), {
          variant: "success",
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
      } finally {
        setBusyKey(null);
      }
    },
    [
      effectiveActiveId,
      onSelectGroup,
      partition.groups,
      removeCachedSteward,
      setActiveStewardServerId,
      t,
      toast,
      updateSettings,
    ],
  );

  const promoteHostToMainChat = useCallback(
    (serverId: string) => {
      if (busyKey) return;
      const hostLabel = findHostLabel(serverId);
      const client = useSessionStore.getState().sessions[serverId]?.client ?? null;
      if (!client) {
        toast.error(t("mainChat.groups.hostOfflineError", { host: hostLabel }));
        return;
      }

      setBusyKey(`promote:${serverId}`);
      setConfirmDisbandGroupId(null);
      void (async () => {
        try {
          // Defensively remove this host from any existing group's remote scope so partition stays strict.
          const sessions = useSessionStore.getState().sessions;
          const allSettings = useMainChatSettingsStore.getState().settingsByServerId;
          for (const group of partition.groups) {
            if (group.ownerServerId === serverId) continue;
            const ownerClient = sessions[group.ownerServerId]?.client ?? null;
            const ownerSettings = allSettings[group.ownerServerId];
            if (!ownerClient || !ownerSettings) continue;
            const scope = resolveMainChatFleetScope(ownerSettings, group.ownerServerId);
            const hasRemote = scope.mode === "allowlist" && scope.hostServerIds.includes(serverId);
            if (!hasRemote) continue;
            const nextScope = computeLeaveGroupFleetScope({
              ownerServerId: group.ownerServerId,
              currentScope: scope,
              currentRemoteMemberIds: group.members
                .filter((m) => !m.isOwner)
                .map((m) => m.serverId),
              targetHostServerId: serverId,
            });
            await updateSettings(group.ownerServerId, { fleetScope: nextScope }, ownerClient);
          }

          await updateSettings(
            serverId,
            {
              enabled: true,
              fleetScope: { mode: "local_only", hostServerIds: [] },
            },
            client,
          );
          if (typeof client.getMainChatFleetHosts === "function") {
            await refreshFleetHosts(serverId, client, { forceRefresh: true }).catch(
              () => undefined,
            );
          }
          setActiveStewardServerId(serverId);
          onSelectGroup?.(serverId);
          toast.show(t("mainChat.groups.promotedToast", { host: hostLabel }), {
            variant: "success",
          });
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
        } finally {
          setBusyKey(null);
        }
      })();
    },
    [
      busyKey,
      findHostLabel,
      onSelectGroup,
      partition.groups,
      refreshFleetHosts,
      setActiveStewardServerId,
      t,
      toast,
      updateSettings,
    ],
  );

  const joinHostToGroup = useCallback(
    (hostServerId: string, targetOwnerServerId: string) => {
      if (busyKey) return;
      const targetGroup = partition.groups.find((g) => g.ownerServerId === targetOwnerServerId);
      if (!targetGroup) return;

      const hostLabel = findHostLabel(hostServerId);
      const sessions = useSessionStore.getState().sessions;
      const ownerClient = sessions[targetOwnerServerId]?.client ?? null;
      if (!ownerClient) {
        toast.error(t("mainChat.groups.hostOfflineError", { host: targetGroup.ownerHostLabel }));
        return;
      }

      setBusyKey(`join:${hostServerId}`);
      setConfirmDisbandGroupId(null);
      void (async () => {
        try {
          const ownerFleet = fleetHostsByServerId[targetOwnerServerId] ?? [];
          const ownerAvailable = availableRemoteHostsByServerId[targetOwnerServerId] ?? [];
          const alreadyLinked =
            ownerFleet.some((h) => h.serverId === hostServerId) ||
            ownerAvailable.some((h) => h.serverId === hostServerId);

          let syncedRemote = false;
          if (!alreadyLinked) {
            const targetProfile = clientHosts.find((h) => h.serverId === hostServerId);
            const unmanagedItem = partition.unmanaged.find((u) => u.serverId === hostServerId);
            const syncConnection = unmanagedItem?.syncConnection ?? null;
            if (!syncConnection) {
              toast.error(
                t("mainChat.stewards.scope.syncFailedToast", {
                  host: hostLabel,
                  error: t("mainChat.stewards.scope.clientManualOnlyHint"),
                }),
              );
              return;
            }
            const syncResult = await ensureHostRegisteredOnOwnerDaemon({
              ownerClient,
              targetServerId: hostServerId,
              targetLabel: hostLabel,
              targetProfile,
              syncConnection,
            });
            if (syncResult.error) {
              toast.error(
                t("mainChat.stewards.scope.syncFailedToast", {
                  host: hostLabel,
                  error: syncResult.error,
                }),
              );
              return;
            }
            syncedRemote = syncResult.status === "added";
          }

          // If the joining host somehow still had a local steward enabled, disable it cleanly first.
          const joiningSettings =
            useMainChatSettingsStore.getState().settingsByServerId[hostServerId];
          const joiningClient = sessions[hostServerId]?.client ?? null;
          if (joiningClient && isMainChatEnabled(joiningSettings)) {
            await updateSettings(
              hostServerId,
              { enabled: false, fleetScope: { mode: "local_only", hostServerIds: [] } },
              joiningClient,
            );
            removeCachedSteward(hostServerId);
          }

          const ownerSettings =
            useMainChatSettingsStore.getState().settingsByServerId[targetOwnerServerId];
          const currentRemoteIds = targetGroup.members
            .filter((m) => !m.isOwner)
            .map((m) => m.serverId);
          const nextScope = computeJoinGroupFleetScope({
            ownerServerId: targetOwnerServerId,
            currentScope: ownerSettings?.fleetScope ?? targetGroup.fleetScope,
            currentRemoteMemberIds: currentRemoteIds,
            targetHostServerId: hostServerId,
          });

          await updateSettings(targetOwnerServerId, { fleetScope: nextScope }, ownerClient);
          if (typeof ownerClient.getMainChatFleetHosts === "function") {
            await refreshFleetHosts(targetOwnerServerId, ownerClient, { forceRefresh: true }).catch(
              () => undefined,
            );
          }
          toast.show(
            syncedRemote
              ? t("mainChat.groups.joinedAndSyncedToast", {
                  host: hostLabel,
                  target: targetGroup.ownerHostLabel,
                })
              : t("mainChat.groups.joinedToast", {
                  host: hostLabel,
                  target: targetGroup.ownerHostLabel,
                }),
            { variant: "success" },
          );
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
        } finally {
          setBusyKey(null);
        }
      })();
    },
    [
      availableRemoteHostsByServerId,
      busyKey,
      clientHosts,
      findHostLabel,
      fleetHostsByServerId,
      partition.groups,
      partition.unmanaged,
      refreshFleetHosts,
      removeCachedSteward,
      t,
      toast,
      updateSettings,
    ],
  );

  const requestLeaveGroup = useCallback(
    (hostServerId: string, groupOwnerServerId: string) => {
      if (busyKey) return;
      const group = partition.groups.find((g) => g.ownerServerId === groupOwnerServerId);
      if (!group) return;

      if (hostServerId === groupOwnerServerId) {
        const remoteMemberCount = group.members.filter((m) => !m.isOwner).length;
        if (remoteMemberCount > 0) {
          setConfirmDisbandGroupId(groupOwnerServerId);
          return;
        }
        void executeDisbandGroup(group);
        return;
      }

      const ownerClient = useSessionStore.getState().sessions[groupOwnerServerId]?.client ?? null;
      if (!ownerClient) {
        toast.error(t("mainChat.groups.hostOfflineError", { host: group.ownerHostLabel }));
        return;
      }

      const hostLabel = findHostLabel(hostServerId);
      setBusyKey(`leave:${groupOwnerServerId}:${hostServerId}`);
      setConfirmDisbandGroupId(null);
      void (async () => {
        try {
          const ownerSettings =
            useMainChatSettingsStore.getState().settingsByServerId[groupOwnerServerId];
          const currentRemoteIds = group.members.filter((m) => !m.isOwner).map((m) => m.serverId);
          const nextScope = computeLeaveGroupFleetScope({
            ownerServerId: groupOwnerServerId,
            currentScope: ownerSettings?.fleetScope ?? group.fleetScope,
            currentRemoteMemberIds: currentRemoteIds,
            targetHostServerId: hostServerId,
          });
          await updateSettings(groupOwnerServerId, { fleetScope: nextScope }, ownerClient);
          if (typeof ownerClient.getMainChatFleetHosts === "function") {
            await refreshFleetHosts(groupOwnerServerId, ownerClient, { forceRefresh: true }).catch(
              () => undefined,
            );
          }
          toast.show(
            t("mainChat.groups.leftToast", {
              host: hostLabel,
              group: group.ownerHostLabel,
            }),
            { variant: "success" },
          );
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
        } finally {
          setBusyKey(null);
        }
      })();
    },
    [
      busyKey,
      executeDisbandGroup,
      findHostLabel,
      partition.groups,
      refreshFleetHosts,
      t,
      toast,
      updateSettings,
    ],
  );

  const confirmDisbandGroup = useCallback(
    (groupOwnerServerId: string) => {
      if (busyKey) return;
      const group = partition.groups.find((g) => g.ownerServerId === groupOwnerServerId);
      if (!group) {
        setConfirmDisbandGroupId(null);
        return;
      }
      void executeDisbandGroup(group);
    },
    [busyKey, executeDisbandGroup, partition.groups],
  );

  const cancelDisbandGroup = useCallback(() => {
    setConfirmDisbandGroupId(null);
  }, []);

  const resolveLegacyDisableLocal = useCallback(
    (targetServerId: string, targetHostLabel: string) => {
      if (busyKey) return;
      const client = useSessionStore.getState().sessions[targetServerId]?.client ?? null;
      if (!client) {
        toast.error(t("mainChat.groups.hostOfflineError", { host: targetHostLabel }));
        return;
      }
      setBusyKey(`legacy-disable:${targetServerId}`);
      void updateSettings(
        targetServerId,
        { enabled: false, fleetScope: { mode: "local_only", hostServerIds: [] } },
        client,
      )
        .then(() => {
          removeCachedSteward(targetServerId);
          toast.show(
            t("mainChat.stewards.conflicts.resolvedDisableToast", { host: targetHostLabel }),
            { variant: "success" },
          );
          return true;
        })
        .catch((error) => {
          toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
        })
        .finally(() => {
          setBusyKey(null);
        });
    },
    [busyKey, removeCachedSteward, t, toast, updateSettings],
  );

  const resolveLegacyRemoveFromRemote = useCallback(
    (
      stewardServerId: string,
      targetServerId: string,
      targetHostLabel: string,
      stewardHostLabel: string,
    ) => {
      if (busyKey) return;
      const client = useSessionStore.getState().sessions[stewardServerId]?.client ?? null;
      if (!client) {
        toast.error(t("mainChat.groups.hostOfflineError", { host: stewardHostLabel }));
        return;
      }
      const settings = useMainChatSettingsStore.getState().settingsByServerId[stewardServerId];
      const fleetHosts = fleetHostsByServerId[stewardServerId] ?? [];
      const currentRemoteIds = fleetHosts
        .map((h) => h.serverId)
        .filter((id) => id !== stewardServerId);
      const nextScope = computeLeaveGroupFleetScope({
        ownerServerId: stewardServerId,
        currentScope: settings?.fleetScope,
        currentRemoteMemberIds: currentRemoteIds,
        targetHostServerId: targetServerId,
      });

      setBusyKey(`legacy-remove:${stewardServerId}:${targetServerId}`);
      void updateSettings(stewardServerId, { fleetScope: nextScope }, client)
        .then(async () => {
          if (typeof client.getMainChatFleetHosts === "function") {
            await refreshFleetHosts(stewardServerId, client, { forceRefresh: true }).catch(
              () => undefined,
            );
          }
          toast.show(
            t("mainChat.stewards.conflicts.resolvedRemoveToast", {
              host: targetHostLabel,
              steward: stewardHostLabel,
            }),
            { variant: "success" },
          );
          return true;
        })
        .catch((error) => {
          toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
        })
        .finally(() => {
          setBusyKey(null);
        });
    },
    [busyKey, fleetHostsByServerId, refreshFleetHosts, t, toast, updateSettings],
  );

  const refreshAll = useCallback(() => {
    if (refreshing) return;
    const sessions = useSessionStore.getState().sessions;
    const targets = partition.groups
      .map((g) => ({ serverId: g.ownerServerId, client: sessions[g.ownerServerId]?.client }))
      .filter((entry): entry is { serverId: string; client: NonNullable<typeof entry.client> } =>
        Boolean(entry.client && typeof entry.client.getMainChatFleetHosts === "function"),
      );
    if (targets.length === 0) return;

    setRefreshing(true);
    void Promise.allSettled(
      targets.map((entry) =>
        refreshFleetHosts(entry.serverId, entry.client, { forceRefresh: true }),
      ),
    ).finally(() => {
      setRefreshing(false);
    });
  }, [partition.groups, refreshFleetHosts, refreshing]);

  return {
    partition,
    activeGroupServerId: effectiveActiveId,
    busyKey,
    refreshing,
    confirmDisbandGroupId,
    selectGroup,
    promoteHostToMainChat,
    joinHostToGroup,
    requestLeaveGroup,
    confirmDisbandGroup,
    cancelDisbandGroup,
    resolveLegacyDisableLocal,
    resolveLegacyRemoveFromRemote,
    refreshAll,
  };
}
