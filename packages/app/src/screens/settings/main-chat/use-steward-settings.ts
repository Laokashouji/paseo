import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  resolveMainChatFleetScope,
  type MainChatFleetScopeMode,
  type MainChatSettings,
} from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useToast } from "@/contexts/toast-context";
import { EMPTY_FLEET_HOSTS, useMainChatConversationsStore } from "@/main-chat/conversations-store";
import {
  buildExpectedTargetDescriptions,
  syncHostRegistrationIdempotent,
} from "@/main-chat/host-sync-banner";
import { useMainChatSettingsStore } from "@/main-chat/settings-store";
import {
  detectStewardHostConflicts,
  resolveStewardAllowedServerIds,
  useMainChatStewardStore,
} from "@/main-chat/steward-store";
import { useMainChatRosterSync, useMainChatStewardRoster } from "@/main-chat/use-steward-roster";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { FleetScopeCandidateHost } from "./fleet-scope-panel";
import type { StewardRosterHostEntry } from "./steward-roster-panel";

async function listDaemonExistingHosts(client: DaemonClient) {
  if (typeof client.listHosts !== "function") return undefined;
  try {
    const directory = await client.listHosts();
    return Array.isArray(directory?.hosts) ? directory.hosts : undefined;
  } catch {
    return undefined;
  }
}

export function useMainChatSettingsMultiSteward(input: {
  capableHosts: ReadonlyArray<{ serverId: string; label: string }>;
  selectedServerId: string | null;
  selectedClient: DaemonClient | null;
  selectedSettings: MainChatSettings;
  onApplyPatch: (
    patch: { fleetScope: { mode: MainChatFleetScopeMode; hostServerIds: string[] } },
    toastMsg?: string,
  ) => Promise<void>;
}) {
  const { capableHosts, selectedServerId, selectedClient, selectedSettings, onApplyPatch } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const clientHosts = useHosts();

  useMainChatRosterSync();

  const { roster, activeServerId } = useMainChatStewardRoster();
  const settingsByServerId = useMainChatSettingsStore((state) => state.settingsByServerId);
  const updateSettings = useMainChatSettingsStore((state) => state.updateSettings);
  const fleetHostsByServerId = useMainChatConversationsStore((state) => state.fleetHostsByServerId);
  const availableRemoteHostsByServerId = useMainChatConversationsStore(
    (state) => state.availableRemoteHostsByServerId,
  );
  const refreshFleetHosts = useMainChatConversationsStore((state) => state.refreshFleetHosts);
  const filterWorkspacesByActiveSteward = useMainChatStewardStore(
    (state) => state.filterWorkspacesByActiveSteward,
  );
  const setFilterWorkspacesByActiveSteward = useMainChatStewardStore(
    (state) => state.setFilterWorkspacesByActiveSteward,
  );
  const setDefaultStewardServerId = useMainChatStewardStore(
    (state) => state.setDefaultStewardServerId,
  );

  const [conflictBusyKey, setConflictBusyKey] = useState<string | null>(null);
  const [scopeBusy, setScopeBusy] = useState(false);

  useEffect(() => {
    if (!selectedServerId || !selectedClient) return;
    if (typeof selectedClient.getMainChatFleetHosts !== "function") return;
    void refreshFleetHosts(selectedServerId, selectedClient).catch(() => undefined);
  }, [refreshFleetHosts, selectedClient, selectedServerId]);

  const sessionMetaByServerId = useStoreWithEqualityFn(
    useSessionStore,
    useCallback((state) => {
      const map: Record<string, { online: boolean; hostname: string | undefined }> = {};
      for (const [id, session] of Object.entries(state.sessions)) {
        map[id] = {
          online: Boolean(session.client),
          hostname: session.serverInfo?.hostname?.trim() || undefined,
        };
      }
      return map;
    }, []),
    equal,
  );

  const capableServerIdSet = useMemo(
    () => new Set(capableHosts.map((host) => host.serverId)),
    [capableHosts],
  );

  const rosterByServerId = useMemo(
    () => new Map(roster.map((item) => [item.serverId, item])),
    [roster],
  );

  const rosterEntries = useMemo<StewardRosterHostEntry[]>(
    () =>
      capableHosts.map((host) => ({
        serverId: host.serverId,
        label: host.label,
        online: sessionMetaByServerId[host.serverId]?.online ?? true,
        settings: settingsByServerId[host.serverId],
        rosterItem: rosterByServerId.get(host.serverId) ?? null,
      })),
    [capableHosts, rosterByServerId, sessionMetaByServerId, settingsByServerId],
  );

  const sessionHostnamesByServerId = useMemo(() => {
    const map: Record<string, string | undefined> = {};
    for (const [id, meta] of Object.entries(sessionMetaByServerId)) {
      map[id] = meta.hostname;
    }
    return map;
  }, [sessionMetaByServerId]);

  const conflicts = useMemo(
    () =>
      detectStewardHostConflicts({
        hosts: clientHosts,
        capableServerIds: capableServerIdSet,
        settingsByServerId,
        fleetHostsByServerId,
        sessionHostnamesByServerId,
      }),
    [
      capableServerIdSet,
      clientHosts,
      fleetHostsByServerId,
      sessionHostnamesByServerId,
      settingsByServerId,
    ],
  );

  const otherOwnerNamesByTargetServerId = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const item of roster) {
      if (item.serverId === selectedServerId) continue;
      for (const hostId of item.managedHostIds) {
        const list = map[hostId] ?? [];
        if (!list.includes(item.title)) {
          list.push(item.title);
        }
        map[hostId] = list;
      }
    }
    return map;
  }, [roster, selectedServerId]);

  const handleSetDefault = useCallback(
    (serverId: string, title: string) => {
      setDefaultStewardServerId(serverId);
      toast.show(t("mainChat.stewards.setDefaultToast", { title }), { variant: "success" });
    },
    [setDefaultStewardServerId, t, toast],
  );

  const handleChangeFleetScopeMode = useCallback(
    (mode: MainChatFleetScopeMode) => {
      if (!selectedServerId) return;
      const currentScope = resolveMainChatFleetScope(selectedSettings, selectedServerId);
      setScopeBusy(true);
      void onApplyPatch(
        {
          fleetScope: {
            mode,
            hostServerIds: currentScope.hostServerIds,
          },
        },
        t("mainChat.stewards.scope.savedToast"),
      )
        .then(async () => {
          if (selectedClient && typeof selectedClient.getMainChatFleetHosts === "function") {
            await refreshFleetHosts(selectedServerId, selectedClient, { forceRefresh: true }).catch(
              () => undefined,
            );
          }
          return true;
        })
        .finally(() => {
          setScopeBusy(false);
        });
    },
    [onApplyPatch, refreshFleetHosts, selectedClient, selectedServerId, selectedSettings, t],
  );

  const handleToggleRemoteHost = useCallback(
    (candidate: FleetScopeCandidateHost, nextChecked: boolean) => {
      if (!selectedServerId || !selectedClient || scopeBusy) return;
      const currentScope = resolveMainChatFleetScope(selectedSettings, selectedServerId);
      const nextIds = nextChecked
        ? Array.from(new Set([...currentScope.hostServerIds, candidate.serverId]))
        : currentScope.hostServerIds.filter((id) => id !== candidate.serverId);

      setScopeBusy(true);
      void (async () => {
        try {
          let syncedRemote = false;
          if (nextChecked && !candidate.linkedOnDaemon) {
            if (!candidate.syncConnection || typeof selectedClient.addHost !== "function") {
              toast.error(
                t("mainChat.stewards.scope.syncFailedToast", {
                  host: candidate.label,
                  error: t("mainChat.stewards.scope.clientManualOnlyHint"),
                }),
              );
              return;
            }
            const existingHosts = await listDaemonExistingHosts(selectedClient);
            const matchedProfile = clientHosts.find((host) => host.serverId === candidate.serverId);
            const syncResult = await syncHostRegistrationIdempotent({
              client: selectedClient,
              candidate: {
                serverId: candidate.serverId,
                label: candidate.label,
                syncConnection: candidate.syncConnection,
                targetDescriptions: matchedProfile
                  ? buildExpectedTargetDescriptions(matchedProfile)
                  : undefined,
              },
              existingHosts,
            });
            if (syncResult.error) {
              toast.error(
                t("mainChat.stewards.scope.syncFailedToast", {
                  host: candidate.label,
                  error: syncResult.error,
                }),
              );
              return;
            }
            syncedRemote = syncResult.status === "added";
          }

          await updateSettings(
            selectedServerId,
            {
              fleetScope: {
                mode: "allowlist",
                hostServerIds: nextIds,
              },
            },
            selectedClient,
          );
          if (typeof selectedClient.getMainChatFleetHosts === "function") {
            await refreshFleetHosts(selectedServerId, selectedClient, { forceRefresh: true }).catch(
              () => undefined,
            );
          }
          toast.show(
            syncedRemote
              ? t("mainChat.stewards.scope.syncedAndAddedToast", { host: candidate.label })
              : t("mainChat.stewards.scope.savedToast"),
            { variant: "success" },
          );
        } catch (error) {
          toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
        } finally {
          setScopeBusy(false);
        }
      })();
    },
    [
      clientHosts,
      refreshFleetHosts,
      scopeBusy,
      selectedClient,
      selectedServerId,
      selectedSettings,
      t,
      toast,
      updateSettings,
    ],
  );

  const handleDisableLocalSteward = useCallback(
    (targetServerId: string, hostLabel: string) => {
      const targetClient = useSessionStore.getState().sessions[targetServerId]?.client ?? null;
      if (!targetClient) return;
      setConflictBusyKey(`disable:${targetServerId}`);
      void updateSettings(targetServerId, { enabled: false }, targetClient)
        .then(() => {
          toast.show(t("mainChat.stewards.conflicts.resolvedDisableToast", { host: hostLabel }), {
            variant: "success",
          });
          return true;
        })
        .catch((error) => {
          toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
        })
        .finally(() => {
          setConflictBusyKey(null);
        });
    },
    [t, toast, updateSettings],
  );

  const handleRemoveFromRemoteSteward = useCallback(
    (stewardServerId: string, stewardTitle: string, targetServerId: string, hostLabel: string) => {
      const stewardClient = useSessionStore.getState().sessions[stewardServerId]?.client ?? null;
      if (!stewardClient) return;
      const stewardSettings = settingsByServerId[stewardServerId];
      const currentManaged = resolveStewardAllowedServerIds({
        stewardServerId,
        settings: stewardSettings,
        fleetHosts: fleetHostsByServerId[stewardServerId],
        fallbackAllServerIds: null,
      });
      const remainingRemoteIds = Array.from(currentManaged).filter(
        (id) => id !== stewardServerId && id !== targetServerId,
      );
      const nextMode: MainChatFleetScopeMode =
        remainingRemoteIds.length === 0 ? "local_only" : "allowlist";

      setConflictBusyKey(`remove:${stewardServerId}:${targetServerId}`);
      void updateSettings(
        stewardServerId,
        {
          fleetScope: {
            mode: nextMode,
            hostServerIds: remainingRemoteIds,
          },
        },
        stewardClient,
      )
        .then(async () => {
          if (typeof stewardClient.getMainChatFleetHosts === "function") {
            await refreshFleetHosts(stewardServerId, stewardClient, { forceRefresh: true }).catch(
              () => undefined,
            );
          }
          toast.show(
            t("mainChat.stewards.conflicts.resolvedRemoveToast", {
              host: hostLabel,
              steward: stewardTitle,
            }),
            { variant: "success" },
          );
          return true;
        })
        .catch((error) => {
          toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
        })
        .finally(() => {
          setConflictBusyKey(null);
        });
    },
    [fleetHostsByServerId, refreshFleetHosts, settingsByServerId, t, toast, updateSettings],
  );

  const selectedInScopeHosts =
    (selectedServerId ? fleetHostsByServerId[selectedServerId] : undefined) ?? EMPTY_FLEET_HOSTS;
  const selectedAvailableRemoteHosts =
    (selectedServerId ? availableRemoteHostsByServerId[selectedServerId] : undefined) ??
    EMPTY_FLEET_HOSTS;

  return {
    clientHosts,
    rosterEntries,
    activeStewardServerId: activeServerId,
    conflicts,
    conflictBusyKey,
    scopeBusy,
    filterWorkspacesByActiveSteward,
    setFilterWorkspacesByActiveSteward,
    otherOwnerNamesByTargetServerId,
    selectedInScopeHosts,
    selectedAvailableRemoteHosts,
    handleSetDefault,
    handleChangeFleetScopeMode,
    handleToggleRemoteHost,
    handleDisableLocalSteward,
    handleRemoveFromRemoteSteward,
  };
}
