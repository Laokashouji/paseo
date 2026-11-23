import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  parseHostPort,
  serializeConnectionUriForStorage,
  serializeRelayConnectionUri,
} from "@getpaseo/protocol/daemon-endpoints";
import type { MainChatFleetHostStatus } from "@getpaseo/protocol/main-chat";
import { router } from "expo-router";
import {
  ChevronDown,
  ChevronRight,
  Link2,
  RefreshCw,
  Server,
  Settings,
  Unlink,
} from "lucide-react-native";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";
import { buildSettingsHostRoute } from "@/utils/host-routes";
import { EMPTY_FLEET_HOSTS, useMainChatConversationsStore } from "./conversations-store";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedLink2 = withUnistyles(Link2);
const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedServer = withUnistyles(Server);
const ThemedSettings = withUnistyles(Settings);
const ThemedUnlink = withUnistyles(Unlink);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"]);

export interface UnlinkedClientHostCandidate {
  host: HostProfile;
  serverId: string;
  label: string;
  syncConnection: string | null;
  canAutoSync: boolean;
}

function isLoopbackAddress(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  if (LOOPBACK_HOSTS.has(normalized)) return true;
  return normalized.startsWith("127.");
}

function serializeRelayHostConnection(host: HostProfile): string | null {
  for (const conn of host.connections) {
    if (conn.type !== "relay") continue;
    const endpoint = conn.relayEndpoint.trim();
    const key = conn.daemonPublicKeyB64.trim();
    if (!endpoint || !key) continue;
    try {
      return serializeRelayConnectionUri({
        offer: {
          v: 2,
          serverId: host.serverId,
          daemonPublicKeyB64: key,
          relay: {
            endpoint,
            ...(conn.useTls !== undefined ? { useTls: conn.useTls } : {}),
          },
          ...(conn.minimumSecurityMode ? { minimumSecurityMode: conn.minimumSecurityMode } : {}),
        },
        ...(host.password ? { password: host.password } : {}),
      });
    } catch {
      continue;
    }
  }
  return null;
}

function serializeDirectTcpHostConnection(host: HostProfile): string | null {
  for (const conn of host.connections) {
    if (conn.type !== "directTcp") continue;
    const endpoint = conn.endpoint.trim();
    if (!endpoint) continue;
    try {
      const parts = parseHostPort(endpoint);
      if (isLoopbackAddress(parts.host)) continue;
      return serializeConnectionUriForStorage({
        host: parts.host,
        port: parts.port,
        isIpv6: parts.isIpv6,
        useTls: Boolean(conn.useTls),
        ...(host.password ? { password: host.password } : {}),
      });
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Builds a portable connection string (`relay://` preferred, then non-loopback `tcp://`) suitable
 * for registering a client-paired host into the Main Chat daemon's `ConnectedHosts`. Returns `null`
 * when only local/routed/loopback connections exist so the UI guides the user to host settings.
 */
export function buildSyncConnectionString(host: HostProfile): string | null {
  return serializeRelayHostConnection(host) ?? serializeDirectTcpHostConnection(host);
}

function isRoutedViaMainHost(host: HostProfile, mainServerId: string): boolean {
  const routedId = `via:${mainServerId}`;
  return host.connections.some(
    (conn) =>
      (conn.type === "routed" && conn.originServerId === mainServerId) || conn.id === routedId,
  );
}

/**
 * Computes frontend-only hosts present in `HostRuntimeStore` that are not yet linked to the Main
 * Chat daemon's `ConnectedHosts` fleet. Always excludes the main daemon itself and `via:<main>`
 * routed hosts.
 */
export function computeUnlinkedClientHosts(
  clientHosts: readonly HostProfile[],
  mainDaemonFleetHosts: readonly MainChatFleetHostStatus[],
  mainServerId: string | null,
): UnlinkedClientHostCandidate[] {
  if (!mainServerId) return [];

  const linkedIds = new Set<string>([mainServerId]);
  for (const host of mainDaemonFleetHosts) {
    linkedIds.add(host.serverId);
  }

  const unlinked: UnlinkedClientHostCandidate[] = [];
  for (const host of clientHosts) {
    if (!host.serverId || linkedIds.has(host.serverId)) continue;
    if (isRoutedViaMainHost(host, mainServerId)) continue;
    const syncConnection = buildSyncConnectionString(host);
    unlinked.push({
      host,
      serverId: host.serverId,
      label: host.label.trim() || host.serverId,
      syncConnection,
      canAutoSync: syncConnection !== null,
    });
  }

  return unlinked;
}

function resolveFleetStatusVariant(status: MainChatFleetHostStatus["status"]): StatusBadgeVariant {
  switch (status) {
    case "online":
      return "success";
    case "connecting":
    case "degraded":
      return "warning";
    case "error":
      return "error";
    case "offline":
      return "muted";
  }
}

function resolveFleetStatusKey(status: MainChatFleetHostStatus["status"]): string {
  switch (status) {
    case "online":
      return "mainChat.fleetSync.status.online";
    case "connecting":
      return "mainChat.fleetSync.status.connecting";
    case "degraded":
      return "mainChat.fleetSync.status.degraded";
    case "error":
      return "mainChat.fleetSync.status.error";
    case "offline":
      return "mainChat.fleetSync.status.offline";
  }
}

const FleetHostStatusRow = memo(function FleetHostStatusRow({
  host,
}: {
  host: MainChatFleetHostStatus;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.hostRow} testID={`main-chat-fleet-host-${host.serverId}`}>
      <View style={styles.hostRowMain}>
        <View style={styles.hostTitleRow}>
          <Text style={styles.hostLabel} numberOfLines={1}>
            {host.label || host.serverId}
          </Text>
          {host.isLocal ? (
            <StatusBadge size="xs" variant="muted" label={t("mainChat.fleetSync.localBadge")} />
          ) : null}
          <StatusBadge
            size="sm"
            variant={resolveFleetStatusVariant(host.status)}
            label={t(resolveFleetStatusKey(host.status))}
          />
        </View>
        {host.error ? (
          <Text style={styles.hostError} numberOfLines={1}>
            {host.error}
          </Text>
        ) : null}
      </View>

      <View style={styles.hostMetrics}>
        <Text style={styles.hostMetricText}>
          {t("mainChat.fleetSync.agentCount", { count: host.agentCount })}
        </Text>
        {host.needsAttentionCount > 0 ? (
          <StatusBadge
            size="sm"
            variant="warning"
            label={t("mainChat.fleetSync.attentionCount", { count: host.needsAttentionCount })}
          />
        ) : null}
      </View>
    </View>
  );
});

const UnlinkedClientHostNotice = memo(function UnlinkedClientHostNotice({
  unlinkedHosts,
  syncing,
  syncError,
  hasAutoSyncable,
  hasManualOnly,
  onSyncNow,
  onOpenSettings,
  onDismiss,
}: {
  unlinkedHosts: readonly UnlinkedClientHostCandidate[];
  syncing: boolean;
  syncError: string | null;
  hasAutoSyncable: boolean;
  hasManualOnly: boolean;
  onSyncNow: () => void;
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const names = unlinkedHosts.map((item) => item.label).join("、");

  return (
    <View style={styles.unlinkedBanner} testID="main-chat-unlinked-hosts-banner">
      <View style={styles.unlinkedHeader}>
        <ThemedUnlink size={14} uniProps={warningIconMapping} />
        <Text style={styles.unlinkedTitle} numberOfLines={1}>
          {t("mainChat.fleetSync.unlinkedTitle", { count: unlinkedHosts.length })}
        </Text>
      </View>

      <Text style={styles.unlinkedDescription}>
        {t("mainChat.fleetSync.unlinkedDescription", {
          count: unlinkedHosts.length,
          names,
        })}
      </Text>

      {syncError ? (
        <Text style={styles.syncErrorText} testID="main-chat-fleet-sync-error">
          {syncError}
        </Text>
      ) : null}

      <View style={styles.unlinkedActions}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={ThemedLink2}
          loading={syncing}
          disabled={syncing}
          onPress={onSyncNow}
          testID="main-chat-fleet-sync-now"
        >
          {t("mainChat.fleetSync.syncNowButton")}
        </Button>

        {hasManualOnly && hasAutoSyncable ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={ThemedSettings}
            disabled={syncing}
            onPress={onOpenSettings}
            testID="main-chat-fleet-open-settings"
          >
            {t("mainChat.fleetSync.openSettingsButton")}
          </Button>
        ) : null}

        <Button variant="ghost" size="sm" onPress={onDismiss} testID="main-chat-fleet-dismiss">
          {t("mainChat.fleetSync.dismissButton")}
        </Button>
      </View>
    </View>
  );
});

async function syncAutoCandidatesToMainDaemon(input: {
  serverId: string;
  client: DaemonClient;
  candidates: readonly UnlinkedClientHostCandidate[];
  fallbackError: string;
  refreshFleetHosts: (
    serverId: string,
    client: DaemonClient,
    options?: { forceRefresh?: boolean },
  ) => Promise<unknown>;
}): Promise<{ syncedCount: number; lastError: string | null }> {
  let syncedCount = 0;
  let lastError: string | null = null;

  for (const candidate of input.candidates) {
    if (!candidate.syncConnection) continue;
    try {
      await input.client.addHost({
        connection: candidate.syncConnection,
        label: candidate.label,
      });
      syncedCount += 1;
    } catch (error) {
      lastError = error instanceof Error ? error.message : input.fallbackError;
    }
  }

  if (syncedCount > 0 && typeof input.client.getMainChatFleetHosts === "function") {
    try {
      await input.refreshFleetHosts(input.serverId, input.client, { forceRefresh: true });
    } catch {
      // Fleet status refresh failure does not undo already-registered hosts.
    }
  }

  return { syncedCount, lastError };
}

export interface HostSyncBannerProps {
  serverId: string | null;
  mainAgentId?: string | null;
}

/**
 * Multi-host fleet overview capsule bar & non-blocking guidance banner for client-paired hosts
 * that have not yet been linked into the Main Chat daemon's `ConnectedHosts`.
 */
export const HostSyncBanner = memo(function HostSyncBanner({
  serverId,
  mainAgentId,
}: HostSyncBannerProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const clientHosts = useHosts();

  const client = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client ?? null) : null,
  );
  const connectedHostsFeature = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.serverInfo?.features?.connectedHosts : undefined,
  );

  const overviewKey = serverId && mainAgentId ? overviewStoreKey(serverId, mainAgentId) : null;
  const overviewFleetHosts = useMainChatOverviewStore((state) =>
    overviewKey ? (state.overviewsByKey[overviewKey]?.fleetHosts ?? null) : null,
  );
  const storeFleetHosts = useMainChatConversationsStore((state) =>
    serverId ? (state.fleetHostsByServerId[serverId] ?? null) : null,
  );
  const localServerId = useMainChatConversationsStore((state) =>
    serverId ? (state.localServerIdByServerId[serverId] ?? null) : null,
  );
  const loadingFleetHosts = useMainChatConversationsStore((state) =>
    serverId ? Boolean(state.loadingFleetHostsByServerId[serverId]) : false,
  );
  const dismissedNotice = useMainChatConversationsStore((state) => state.dismissedFleetSyncNotice);
  const setDismissedNotice = useMainChatConversationsStore(
    (state) => state.setDismissedFleetSyncNotice,
  );
  const refreshFleetHosts = useMainChatConversationsStore((state) => state.refreshFleetHosts);

  const [expanded, setExpanded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const fleetHosts = storeFleetHosts ?? overviewFleetHosts ?? EMPTY_FLEET_HOSTS;
  const effectiveMainServerId = localServerId ?? serverId;

  const unlinkedHosts = useMemo(
    () => computeUnlinkedClientHosts(clientHosts, fleetHosts, effectiveMainServerId),
    [clientHosts, effectiveMainServerId, fleetHosts],
  );

  const onlineCount = useMemo(
    () => fleetHosts.filter((host) => host.status === "online").length,
    [fleetHosts],
  );

  const autoSyncableHosts = useMemo(
    () => unlinkedHosts.filter((item) => item.canAutoSync),
    [unlinkedHosts],
  );
  const manualOnlyHosts = useMemo(
    () => unlinkedHosts.filter((item) => !item.canAutoSync),
    [unlinkedHosts],
  );

  const handleToggleExpanded = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleRefreshFleet = useCallback(() => {
    if (!serverId || !client || loadingFleetHosts) return;
    if (typeof client.getMainChatFleetHosts !== "function") return;
    void refreshFleetHosts(serverId, client, { forceRefresh: true }).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("mainChat.fleetSync.syncFailed"));
    });
  }, [client, loadingFleetHosts, refreshFleetHosts, serverId, t, toast]);

  const handleOpenSettings = useCallback(() => {
    if (!serverId) return;
    router.push(buildSettingsHostRoute(serverId));
  }, [serverId]);

  const handleDismiss = useCallback(() => {
    setDismissedNotice(true);
  }, [setDismissedNotice]);

  const handleReopenNotice = useCallback(() => {
    setDismissedNotice(false);
  }, [setDismissedNotice]);

  const handleSyncNow = useCallback(() => {
    if (!serverId || syncing) return;
    const canCallAddHost =
      client !== null &&
      typeof client.addHost === "function" &&
      connectedHostsFeature !== false &&
      autoSyncableHosts.length > 0;

    if (!canCallAddHost) {
      toast.show(t("mainChat.fleetSync.syncNeedsManualToast"), { variant: "info" });
      router.push(buildSettingsHostRoute(serverId));
      return;
    }

    setSyncing(true);
    setSyncError(null);

    void syncAutoCandidatesToMainDaemon({
      serverId,
      client,
      candidates: autoSyncableHosts,
      fallbackError: t("mainChat.fleetSync.syncFailed"),
      refreshFleetHosts,
    })
      .then(({ syncedCount, lastError }) => {
        const remainingCount = unlinkedHosts.length - syncedCount;
        if (syncedCount > 0 && remainingCount === 0) {
          toast.show(t("mainChat.fleetSync.syncSuccessToast", { count: syncedCount }), {
            variant: "success",
          });
        } else if (syncedCount > 0 && remainingCount > 0) {
          toast.show(
            t("mainChat.fleetSync.syncPartialToast", {
              synced: syncedCount,
              remaining: remainingCount,
            }),
            { variant: "info" },
          );
          if (lastError) setSyncError(lastError);
        } else if (lastError) {
          setSyncError(lastError);
          toast.error(lastError);
        }
        return syncedCount;
      })
      .finally(() => {
        setSyncing(false);
      });
  }, [
    autoSyncableHosts,
    client,
    connectedHostsFeature,
    refreshFleetHosts,
    serverId,
    syncing,
    t,
    toast,
    unlinkedHosts.length,
  ]);

  if (!serverId || (fleetHosts.length === 0 && unlinkedHosts.length === 0)) {
    return null;
  }

  return (
    <View style={styles.container} testID="main-chat-host-sync-banner">
      <View style={styles.capsuleRow} testID="main-chat-fleet-capsule-bar">
        <PressHighlight
          onPress={handleToggleExpanded}
          style={styles.capsuleButton}
          highlightStyle={styles.controlPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.fleetSync.expandLabel")}
          testID="main-chat-fleet-capsule-toggle"
        >
          <ThemedServer size={13} uniProps={mutedIconMapping} />
          <View
            style={[
              styles.statusDot,
              onlineCount > 0 ? styles.statusDotOnline : styles.statusDotOffline,
            ]}
          />
          <Text style={styles.capsuleText} numberOfLines={1}>
            {t("mainChat.fleetSync.capsuleSummary", {
              total: fleetHosts.length,
              online: onlineCount,
            })}
          </Text>
          {expanded ? (
            <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
          ) : (
            <ThemedChevronRight size={13} uniProps={mutedIconMapping} />
          )}
        </PressHighlight>

        <View style={styles.capsuleTrailing}>
          {unlinkedHosts.length > 0 && dismissedNotice ? (
            <PressHighlight
              onPress={handleReopenNotice}
              style={styles.unlinkedChip}
              highlightStyle={styles.controlPressed}
              accessibilityRole="button"
              testID="main-chat-fleet-reopen-unlinked"
            >
              <Text style={styles.unlinkedChipText} numberOfLines={1}>
                {t("mainChat.fleetSync.unlinkedPill", { count: unlinkedHosts.length })}
              </Text>
            </PressHighlight>
          ) : null}

          <PressHighlight
            onPress={handleRefreshFleet}
            disabled={loadingFleetHosts || !client}
            style={styles.refreshButton}
            highlightStyle={styles.controlPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.fleetSync.refreshLabel")}
            testID="main-chat-fleet-refresh"
          >
            <ThemedRefreshCw size={13} uniProps={mutedIconMapping} />
          </PressHighlight>
        </View>
      </View>

      {expanded ? (
        <View style={styles.hostList} testID="main-chat-fleet-host-list">
          {fleetHosts.map((host) => (
            <FleetHostStatusRow key={host.serverId} host={host} />
          ))}
          {unlinkedHosts.map((candidate) => (
            <View
              key={`unlinked:${candidate.serverId}`}
              style={styles.hostRow}
              testID={`main-chat-fleet-unlinked-row-${candidate.serverId}`}
            >
              <View style={styles.hostTitleRow}>
                <Text style={styles.hostLabel} numberOfLines={1}>
                  {candidate.label}
                </Text>
                <StatusBadge
                  size="sm"
                  variant="warning"
                  label={t("mainChat.fleetSync.readOnlyBadge")}
                />
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {unlinkedHosts.length > 0 && !dismissedNotice ? (
        <UnlinkedClientHostNotice
          unlinkedHosts={unlinkedHosts}
          syncing={syncing}
          syncError={syncError}
          hasAutoSyncable={autoSyncableHosts.length > 0}
          hasManualOnly={manualOnlyHosts.length > 0}
          onSyncNow={handleSyncNow}
          onOpenSettings={handleOpenSettings}
          onDismiss={handleDismiss}
        />
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    gap: theme.spacing[2],
  },
  capsuleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  capsuleButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    flexShrink: 1,
  },
  capsuleText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  capsuleTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexShrink: 0,
  },
  unlinkedChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusWarningTint,
  },
  unlinkedChipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusWarning,
    fontWeight: theme.fontWeight.medium,
  },
  refreshButton: {
    width: 26,
    height: 26,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  controlPressed: {
    backgroundColor: theme.colors.surface2,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
  },
  statusDotOnline: {
    backgroundColor: theme.colors.statusSuccess,
  },
  statusDotOffline: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  hostList: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    gap: theme.spacing[1.5],
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  hostRowMain: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  hostTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexWrap: "wrap",
  },
  hostLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  hostError: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  hostMetrics: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexShrink: 0,
  },
  hostMetricText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  unlinkedBanner: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.statusWarningTint,
    padding: theme.spacing[3],
    gap: theme.spacing[1.5],
  },
  unlinkedHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  unlinkedTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.statusWarning,
    flex: 1,
  },
  unlinkedDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
  syncErrorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  unlinkedActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    marginTop: 2,
  },
}));
