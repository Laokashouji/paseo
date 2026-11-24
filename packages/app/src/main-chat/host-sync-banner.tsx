import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  normalizeHostPort,
  parseHostPort,
  serializeConnectionUriForStorage,
  serializeRelayConnectionUri,
} from "@getpaseo/protocol/daemon-endpoints";
import type { HostDirectory, HostSummary } from "@getpaseo/protocol/hosts";
import {
  resolveMainChatFleetScope,
  type MainChatFleetHostStatus,
  type MainChatFleetScope,
} from "@getpaseo/protocol/main-chat";
import { router } from "expo-router";
import { ChevronDown, ChevronRight, Link2, RefreshCw, Server, Settings } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
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
import { useMainChatSettingsStore } from "./settings-store";

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedLink2 = withUnistyles(Link2);
const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedServer = withUnistyles(Server);
const ThemedSettings = withUnistyles(Settings);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "::"]);
export const MAIN_CHAT_SYNC_SOURCE_KEY_PREFIX = "main-chat-sync:";

export function buildMainChatSyncSourceKey(serverId: string): string {
  return `${MAIN_CHAT_SYNC_SOURCE_KEY_PREFIX}${serverId.trim()}`;
}

export function buildMainChatSyncMetadata(serverId: string): Record<string, string> {
  return { mainChatSyncServerId: serverId.trim() };
}

function extractRelayTargetServerId(targetDesc: string | undefined): string | null {
  const trimmed = targetDesc?.trim();
  if (!trimmed || !trimmed.startsWith("relay://")) return null;
  const rest = trimmed.slice("relay://".length);
  const slashIndex = rest.indexOf("/");
  if (slashIndex < 0) return null;
  const rawId = rest.slice(slashIndex + 1).trim();
  if (!rawId) return null;
  try {
    return decodeURIComponent(rawId).trim() || rawId;
  } catch {
    return rawId;
  }
}

export function extractExpectedServerIdFromHostSummary(
  summary: Pick<HostSummary, "serverId" | "metadata" | "source" | "targetDescription">,
): string | null {
  const pinned = summary.serverId?.trim();
  if (pinned) return pinned;

  const metaId = summary.metadata?.mainChatSyncServerId?.trim();
  if (metaId) return metaId;

  const sourceKey = summary.source?.key?.trim();
  if (sourceKey && sourceKey.startsWith(MAIN_CHAT_SYNC_SOURCE_KEY_PREFIX)) {
    const extracted = sourceKey.slice(MAIN_CHAT_SYNC_SOURCE_KEY_PREFIX.length).trim();
    if (extracted) return extracted;
  }

  return extractRelayTargetServerId(summary.targetDescription);
}

export function buildExpectedTargetDescriptions(host: HostProfile): string[] {
  if (!Array.isArray(host.connections)) return [];
  const descriptions: string[] = [];
  for (const conn of host.connections) {
    if (conn.type === "relay") {
      const endpoint = conn.relayEndpoint.trim();
      if (!endpoint || !host.serverId) continue;
      try {
        const normalized = normalizeHostPort(endpoint);
        descriptions.push(`relay://${normalized}/${encodeURIComponent(host.serverId)}`);
      } catch {
        descriptions.push(`relay://${endpoint}/${encodeURIComponent(host.serverId)}`);
      }
    } else if (conn.type === "directTcp") {
      const endpoint = conn.endpoint.trim();
      if (!endpoint) continue;
      try {
        const parts = parseHostPort(endpoint);
        if (isLoopbackAddress(parts.host)) continue;
        const normalized = normalizeHostPort(
          `${parts.isIpv6 ? `[${parts.host}]` : parts.host}:${parts.port}`,
        );
        descriptions.push(`tcp://${normalized}`);
      } catch {
        continue;
      }
    }
  }
  return descriptions;
}

function isSourceConflictError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object" && "code" in error && error.code === "source_conflict") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /source_conflict|source key already exists/i.test(message);
}

export function isHostAlreadyRegisteredOnDaemon(
  candidate: { serverId: string; targetDescriptions?: readonly string[] },
  existingHosts: readonly HostSummary[],
): boolean {
  const sourceKey = buildMainChatSyncSourceKey(candidate.serverId);
  const targetSet = new Set(candidate.targetDescriptions ?? []);
  for (const row of existingHosts) {
    if (row.serverId === candidate.serverId) return true;
    if (extractExpectedServerIdFromHostSummary(row) === candidate.serverId) return true;
    if (row.source?.key === sourceKey) return true;
    if (targetSet.size > 0 && row.targetDescription && targetSet.has(row.targetDescription)) {
      return true;
    }
  }
  return false;
}

export async function syncHostRegistrationIdempotent(input: {
  client: DaemonClient;
  candidate: {
    serverId: string;
    label: string;
    syncConnection: string;
    targetDescriptions?: readonly string[];
  };
  existingHosts?: readonly HostSummary[];
}): Promise<{ status: "added" | "already_linked"; error?: string }> {
  if (
    input.existingHosts &&
    isHostAlreadyRegisteredOnDaemon(input.candidate, input.existingHosts)
  ) {
    return { status: "already_linked" };
  }
  try {
    const result = (await input.client.addHost({
      connection: input.candidate.syncConnection,
      label: input.candidate.label,
      sourceKey: buildMainChatSyncSourceKey(input.candidate.serverId),
      metadata: buildMainChatSyncMetadata(input.candidate.serverId),
    })) as HostSummary & { error?: string };
    if (result && typeof result.error === "string" && result.error.length > 0) {
      if (isSourceConflictError(result.error)) {
        return { status: "already_linked" };
      }
      return { status: "added", error: result.error };
    }
    return { status: "added" };
  } catch (error) {
    if (isSourceConflictError(error)) {
      return { status: "already_linked" };
    }
    throw error;
  }
}

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
  if (!Array.isArray(host.connections)) return null;
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
  if (!Array.isArray(host.connections)) return null;
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
  if (!Array.isArray(host.connections)) return false;
  const routedId = `via:${mainServerId}`;
  return host.connections.some(
    (conn) =>
      (conn.type === "routed" && conn.originServerId === mainServerId) || conn.id === routedId,
  );
}

function fleetHostPriority(host: MainChatFleetHostStatus): number {
  if (host.isLocal) return 6;
  if (host.status === "online") return 5;
  if (!host.serverId.startsWith("hst_")) return 4;
  switch (host.status) {
    case "connecting":
      return 3;
    case "degraded":
    case "offline":
      return 2;
    case "error":
      return 1;
  }
}

function buildFleetHostDedupKey(
  host: MainChatFleetHostStatus,
  observed: HostSummary | undefined,
): string {
  if (host.isLocal) return `local:${host.serverId}`;
  const resolvedExpectedId =
    host.expectedServerId ??
    (observed ? extractExpectedServerIdFromHostSummary(observed) : null) ??
    (!host.serverId.startsWith("hst_") ? host.serverId : null);
  if (resolvedExpectedId) return `srv:${resolvedExpectedId}`;
  const resolvedTarget = host.targetDescription ?? observed?.targetDescription ?? null;
  if (resolvedTarget) return `target:${resolvedTarget}`;
  return `reg:${host.serverId}`;
}

export function deduplicateFleetHostStatuses(
  fleetHosts: readonly MainChatFleetHostStatus[],
  observedConnectedHosts?: readonly HostSummary[] | null,
): MainChatFleetHostStatus[] {
  if (fleetHosts.length <= 1) return [...fleetHosts];
  const observedByRegistrationId = new Map<string, HostSummary>();
  if (observedConnectedHosts) {
    for (const row of observedConnectedHosts) {
      observedByRegistrationId.set(row.registrationId, row);
    }
  }

  const deduped = new Map<string, MainChatFleetHostStatus>();
  for (const host of fleetHosts) {
    const observed = observedByRegistrationId.get(host.registrationId ?? host.serverId);
    const dedupKey = buildFleetHostDedupKey(host, observed);
    const existing = deduped.get(dedupKey);
    if (!existing || fleetHostPriority(host) > fleetHostPriority(existing)) {
      deduped.set(dedupKey, host);
    }
  }

  return Array.from(deduped.values());
}

function recordObservedHostMatcher(
  row: HostSummary,
  linkedIds: Set<string>,
  linkedTargets: Set<string>,
): void {
  if (row.serverId) linkedIds.add(row.serverId);
  const expected = extractExpectedServerIdFromHostSummary(row);
  if (expected) linkedIds.add(expected);
  const desc = row.targetDescription?.trim();
  if (desc) linkedTargets.add(desc);
}

function isLegacyUnpinnedConnectingHost(host: MainChatFleetHostStatus): boolean {
  return (
    host.serverId.startsWith("hst_") &&
    !host.expectedServerId &&
    !host.targetDescription &&
    host.status === "connecting"
  );
}

function collectLinkedHostMatchers(
  mainServerId: string,
  mainDaemonFleetHosts: readonly MainChatFleetHostStatus[],
  observedConnectedHosts?: readonly HostSummary[] | null,
): {
  linkedIds: Set<string>;
  linkedTargets: Set<string>;
  legacyPendingLabels: Set<string>;
} {
  const linkedIds = new Set<string>([mainServerId]);
  const linkedTargets = new Set<string>();
  const legacyPendingLabels = new Set<string>();
  const observedByRegistrationId = new Map<string, HostSummary>();

  for (const row of observedConnectedHosts ?? []) {
    observedByRegistrationId.set(row.registrationId, row);
    recordObservedHostMatcher(row, linkedIds, linkedTargets);
  }

  for (const host of mainDaemonFleetHosts) {
    linkedIds.add(host.serverId);
    if (host.expectedServerId) linkedIds.add(host.expectedServerId);
    const hostDesc = host.targetDescription?.trim();
    if (hostDesc) linkedTargets.add(hostDesc);
    const observed = observedByRegistrationId.get(host.registrationId ?? host.serverId);
    if (observed) {
      recordObservedHostMatcher(observed, linkedIds, linkedTargets);
      continue;
    }
    if (isLegacyUnpinnedConnectingHost(host) && host.label.trim()) {
      // COMPAT(fleetHostExpectedServerId): added in v0.17.520, remove after 2027-05-24 once
      // daemon floor >= v0.17.520 includes expectedServerId on MainChatFleetHostStatus.
      legacyPendingLabels.add(host.label.trim().toLowerCase());
    }
  }

  return { linkedIds, linkedTargets, legacyPendingLabels };
}

/**
 * Computes frontend-only hosts present in `HostRuntimeStore` that are not yet linked to the Main
 * Chat daemon's `ConnectedHosts` fleet. Always excludes the main daemon itself and `via:<main>`
 * routed hosts. Matches pinned `serverId`, pre-handshake `expectedServerId`, `targetDescription`,
 * and live `observedConnectedHosts` so newly added `connecting` hosts never render twice.
 */
export function computeUnlinkedClientHosts(
  clientHosts: readonly HostProfile[],
  mainDaemonFleetHosts: readonly MainChatFleetHostStatus[],
  mainServerId: string | null,
  fleetScope?: MainChatFleetScope | null,
  observedConnectedHosts?: readonly HostSummary[] | null,
): UnlinkedClientHostCandidate[] {
  if (!mainServerId || fleetScope?.mode === "local_only") {
    return [];
  }

  const allowlistSet = fleetScope?.mode === "allowlist" ? new Set(fleetScope.hostServerIds) : null;
  const { linkedIds, linkedTargets, legacyPendingLabels } = collectLinkedHostMatchers(
    mainServerId,
    mainDaemonFleetHosts,
    observedConnectedHosts,
  );

  const unlinked: UnlinkedClientHostCandidate[] = [];
  for (const host of clientHosts) {
    if (!host.serverId || linkedIds.has(host.serverId)) continue;
    if (allowlistSet && !allowlistSet.has(host.serverId)) continue;
    if (isRoutedViaMainHost(host, mainServerId)) continue;
    if (buildExpectedTargetDescriptions(host).some((target) => linkedTargets.has(target))) continue;
    const label = host.label.trim() || host.serverId;
    if (legacyPendingLabels.has(label.toLowerCase())) continue;
    const syncConnection = buildSyncConnectionString(host);
    unlinked.push({
      host,
      serverId: host.serverId,
      label,
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
  mainHostLabel,
  unlinkedHosts,
  syncing,
  savingScope,
  syncError,
  hasAutoSyncable,
  hasManualOnly,
  onSyncNow,
  onSetLocalOnly,
  onOpenSettings,
  onDismiss,
}: {
  mainHostLabel: string;
  unlinkedHosts: readonly UnlinkedClientHostCandidate[];
  syncing: boolean;
  savingScope: boolean;
  syncError: string | null;
  hasAutoSyncable: boolean;
  hasManualOnly: boolean;
  onSyncNow: () => void;
  onSetLocalOnly: () => void;
  onOpenSettings: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const names = unlinkedHosts.map((item) => item.label).join("、");
  const busy = syncing || savingScope;

  return (
    <View style={styles.unlinkedBanner} testID="main-chat-unlinked-hosts-banner">
      <View style={styles.unlinkedHeader}>
        <ThemedServer size={14} uniProps={primaryIconMapping} />
        <Text style={styles.unlinkedTitle} numberOfLines={1}>
          {t("mainChat.fleetSync.unlinkedTitle", { count: unlinkedHosts.length })}
        </Text>
      </View>

      <Text style={styles.unlinkedDescription}>
        {t("mainChat.fleetSync.unlinkedDescription", {
          count: unlinkedHosts.length,
          mainHost: mainHostLabel,
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
          disabled={busy}
          onPress={onSyncNow}
          testID="main-chat-fleet-sync-now"
        >
          {t("mainChat.fleetSync.syncNowButton", { count: unlinkedHosts.length })}
        </Button>

        <Button
          variant="outline"
          size="sm"
          loading={savingScope}
          disabled={busy}
          onPress={onSetLocalOnly}
          testID="main-chat-fleet-local-only"
        >
          {t("mainChat.fleetSync.localOnlyButton")}
        </Button>

        {hasManualOnly && hasAutoSyncable ? (
          <Button
            variant="outline"
            size="sm"
            leftIcon={ThemedSettings}
            disabled={busy}
            onPress={onOpenSettings}
            testID="main-chat-fleet-open-settings"
          >
            {t("mainChat.fleetSync.openSettingsButton")}
          </Button>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onPress={onDismiss}
          testID="main-chat-fleet-dismiss"
        >
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
  observedConnectedHosts?: readonly HostSummary[];
  refreshFleetHosts: (
    serverId: string,
    client: DaemonClient,
    options?: { forceRefresh?: boolean },
  ) => Promise<unknown>;
}): Promise<{ syncedCount: number; alreadyLinkedCount: number; lastError: string | null }> {
  let syncedCount = 0;
  let alreadyLinkedCount = 0;
  let lastError: string | null = null;

  let existingHosts: readonly HostSummary[] = input.observedConnectedHosts ?? [];
  if (typeof input.client.listHosts === "function") {
    try {
      const directory = await input.client.listHosts();
      if (Array.isArray(directory?.hosts)) {
        existingHosts = directory.hosts;
      }
    } catch {
      // Fall back to observed hosts or deterministic sourceKey deduplication.
    }
  }

  for (const candidate of input.candidates) {
    if (!candidate.syncConnection) continue;
    try {
      const result = await syncHostRegistrationIdempotent({
        client: input.client,
        candidate: {
          serverId: candidate.serverId,
          label: candidate.label,
          syncConnection: candidate.syncConnection,
          targetDescriptions: buildExpectedTargetDescriptions(candidate.host),
        },
        existingHosts,
      });
      if (result.error) {
        lastError = result.error;
      } else if (result.status === "already_linked") {
        alreadyLinkedCount += 1;
      } else {
        syncedCount += 1;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : input.fallbackError;
    }
  }

  if (
    (syncedCount > 0 || alreadyLinkedCount > 0) &&
    typeof input.client.getMainChatFleetHosts === "function"
  ) {
    try {
      await input.refreshFleetHosts(input.serverId, input.client, { forceRefresh: true });
    } catch {
      // Fleet status refresh failure does not undo already-registered hosts.
    }
  }

  return { syncedCount, alreadyLinkedCount, lastError };
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
  const storeSettings = useMainChatSettingsStore((state) =>
    serverId ? state.settingsByServerId[serverId] : undefined,
  );
  const storeFleetScope = useMainChatConversationsStore((state) =>
    serverId ? state.fleetScopeByServerId[serverId] : undefined,
  );
  const loadingFleetHosts = useMainChatConversationsStore((state) =>
    serverId ? Boolean(state.loadingFleetHostsByServerId[serverId]) : false,
  );
  const dismissedNotice = useMainChatConversationsStore((state) =>
    serverId
      ? Boolean(
          state.dismissedFleetSyncNoticeByServerId[serverId] ?? state.dismissedFleetSyncNotice,
        )
      : state.dismissedFleetSyncNotice,
  );
  const setDismissedNotice = useMainChatConversationsStore(
    (state) => state.setDismissedFleetSyncNotice,
  );
  const refreshFleetHosts = useMainChatConversationsStore((state) => state.refreshFleetHosts);
  const updateSettings = useMainChatSettingsStore((state) => state.updateSettings);

  const [expanded, setExpanded] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [savingScope, setSavingScope] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [observedConnectedHosts, setObservedConnectedHosts] = useState<readonly HostSummary[]>([]);

  useEffect(() => {
    setObservedConnectedHosts([]);
    if (
      !serverId ||
      !client ||
      connectedHostsFeature === false ||
      typeof client.observeHosts !== "function"
    ) {
      return;
    }

    let cancelled = false;
    const observation = client.observeHosts();
    const applyDirectory = (directory: HostDirectory, shouldRefreshFleet: boolean) => {
      if (cancelled) return;
      if (Array.isArray(directory?.hosts)) {
        setObservedConnectedHosts(directory.hosts);
      }
      if (shouldRefreshFleet && typeof client.getMainChatFleetHosts === "function") {
        void refreshFleetHosts(serverId, client, { forceRefresh: true }).catch(() => undefined);
      }
    };

    const unsubscribe = observation.subscribe({
      snapshot: (directory) => applyDirectory(directory, false),
      update: (message) => {
        if (message.type === "hosts.changed") {
          applyDirectory(message.payload.directory, true);
        }
      },
    });
    void observation.ready
      .then((directory) => applyDirectory(directory, false))
      .catch(() => undefined);

    return () => {
      cancelled = true;
      unsubscribe();
      void observation.release().catch(() => undefined);
    };
  }, [client, connectedHostsFeature, refreshFleetHosts, serverId]);

  const rawFleetHosts = storeFleetHosts ?? overviewFleetHosts ?? EMPTY_FLEET_HOSTS;
  const fleetHosts = useMemo(
    () => deduplicateFleetHostStatuses(rawFleetHosts, observedConnectedHosts),
    [observedConnectedHosts, rawFleetHosts],
  );
  const effectiveMainServerId = localServerId ?? serverId;
  const mainHostLabel = useMemo(() => {
    const localFleet = fleetHosts.find((host) => host.isLocal);
    if (localFleet?.label.trim()) return localFleet.label.trim();
    const matchedClient = clientHosts.find((host) => host.serverId === effectiveMainServerId);
    if (matchedClient?.label.trim()) return matchedClient.label.trim();
    return effectiveMainServerId ?? "";
  }, [clientHosts, effectiveMainServerId, fleetHosts]);

  const effectiveFleetScope = useMemo(
    () =>
      storeFleetScope ??
      (storeSettings ? resolveMainChatFleetScope(storeSettings, effectiveMainServerId) : null),
    [effectiveMainServerId, storeFleetScope, storeSettings],
  );

  const unlinkedHosts = useMemo(
    () =>
      computeUnlinkedClientHosts(
        clientHosts,
        fleetHosts,
        effectiveMainServerId,
        effectiveFleetScope,
        observedConnectedHosts,
      ),
    [clientHosts, effectiveFleetScope, effectiveMainServerId, fleetHosts, observedConnectedHosts],
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
    setDismissedNotice(true, serverId);
  }, [serverId, setDismissedNotice]);

  const handleReopenNotice = useCallback(() => {
    setDismissedNotice(false, serverId);
  }, [serverId, setDismissedNotice]);

  const handleSetLocalOnly = useCallback(() => {
    if (!serverId || !client || savingScope) return;
    setSavingScope(true);
    setSyncError(null);
    const applyLocalOnly = async () => {
      try {
        await updateSettings(
          serverId,
          {
            fleetScope: {
              mode: "local_only",
              hostServerIds: effectiveFleetScope?.hostServerIds ?? [],
            },
          },
          client,
        );
        if (typeof client.getMainChatFleetHosts === "function") {
          try {
            await refreshFleetHosts(serverId, client, { forceRefresh: true });
          } catch {
            // Fleet refresh failure does not undo the saved local_only scope.
          }
        }
        toast.show(t("mainChat.fleetSync.localOnlySuccessToast"), { variant: "success" });
      } catch (error) {
        const message = error instanceof Error ? error.message : t("mainChat.fleetSync.syncFailed");
        setSyncError(message);
        toast.error(message);
      } finally {
        setSavingScope(false);
      }
    };
    void applyLocalOnly();
  }, [
    client,
    effectiveFleetScope?.hostServerIds,
    refreshFleetHosts,
    savingScope,
    serverId,
    t,
    toast,
    updateSettings,
  ]);

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
      observedConnectedHosts,
      refreshFleetHosts,
    })
      .then(({ syncedCount, alreadyLinkedCount, lastError }) => {
        const handledCount = syncedCount + alreadyLinkedCount;
        const remainingCount = unlinkedHosts.length - handledCount;
        if (syncedCount > 0 && remainingCount === 0) {
          toast.show(
            t("mainChat.fleetSync.syncSuccessToast", {
              count: syncedCount,
              mainHost: mainHostLabel,
            }),
            { variant: "success" },
          );
        } else if (syncedCount === 0 && alreadyLinkedCount > 0 && remainingCount === 0) {
          toast.show(t("mainChat.fleetSync.syncAlreadyLinkedToast"), { variant: "info" });
        } else if (handledCount > 0 && remainingCount > 0) {
          toast.show(
            t("mainChat.fleetSync.syncPartialToast", {
              synced: handledCount,
              remaining: remainingCount,
            }),
            { variant: "info" },
          );
          if (lastError) setSyncError(lastError);
        } else if (lastError) {
          setSyncError(lastError);
          toast.error(lastError);
        }
        return handledCount;
      })
      .finally(() => {
        setSyncing(false);
      });
  }, [
    autoSyncableHosts,
    client,
    connectedHostsFeature,
    mainHostLabel,
    observedConnectedHosts,
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
                  variant="muted"
                  label={t("mainChat.fleetSync.readOnlyBadge")}
                />
              </View>
            </View>
          ))}
        </View>
      ) : null}

      {unlinkedHosts.length > 0 && !dismissedNotice ? (
        <UnlinkedClientHostNotice
          mainHostLabel={mainHostLabel}
          unlinkedHosts={unlinkedHosts}
          syncing={syncing}
          savingScope={savingScope}
          syncError={syncError}
          hasAutoSyncable={autoSyncableHosts.length > 0}
          hasManualOnly={manualOnlyHosts.length > 0}
          onSyncNow={handleSyncNow}
          onSetLocalOnly={handleSetLocalOnly}
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
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  unlinkedChipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
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
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
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
    color: theme.colors.foreground,
    flex: 1,
  },
  unlinkedDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
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
