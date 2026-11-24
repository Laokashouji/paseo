import {
  resolveMainChatFleetScope,
  type MainChatFleetHostStatus,
  type MainChatFleetScope,
  type MainChatFleetScopeMode,
} from "@getpaseo/protocol/main-chat";
import { CheckSquare, Link2, Server, Square } from "lucide-react-native";
import { memo, useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { buildSyncConnectionString } from "@/main-chat/host-sync-banner";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";

const ThemedCheckSquare = withUnistyles(CheckSquare);
const ThemedSquare = withUnistyles(Square);
const ThemedServer = withUnistyles(Server);
const ThemedLink2 = withUnistyles(Link2);

const accentIconMapping = (theme: Theme) => ({ color: theme.colors.accent });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface FleetScopeCandidateHost {
  serverId: string;
  label: string;
  linkedOnDaemon: boolean;
  status: MainChatFleetHostStatus["status"] | "client_only";
  syncConnection: string | null;
  otherStewardNames: string[];
}

function isRoutedViaServer(host: HostProfile, originServerId: string): boolean {
  if (!Array.isArray(host.connections)) return false;
  const routedId = `via:${originServerId}`;
  return host.connections.some(
    (conn) =>
      (conn.type === "routed" && conn.originServerId === originServerId) || conn.id === routedId,
  );
}

function appendClientOnlyCandidates(
  byId: Map<string, FleetScopeCandidateHost>,
  selectedServerId: string,
  clientHosts: readonly HostProfile[],
  otherOwnerNamesByTargetServerId: Readonly<Record<string, readonly string[] | undefined>>,
): void {
  for (const clientHost of clientHosts) {
    if (!clientHost.serverId || clientHost.serverId === selectedServerId) continue;
    if (byId.has(clientHost.serverId)) continue;
    if (isRoutedViaServer(clientHost, selectedServerId)) continue;
    byId.set(clientHost.serverId, {
      serverId: clientHost.serverId,
      label: clientHost.label.trim() || clientHost.serverId,
      linkedOnDaemon: false,
      status: "client_only",
      syncConnection: buildSyncConnectionString(clientHost),
      otherStewardNames: [...(otherOwnerNamesByTargetServerId[clientHost.serverId] ?? [])],
    });
  }
}

function appendConfiguredAllowlistCandidates(
  byId: Map<string, FleetScopeCandidateHost>,
  selectedServerId: string,
  configuredAllowlistIds: readonly string[],
  otherOwnerNamesByTargetServerId: Readonly<Record<string, readonly string[] | undefined>>,
): void {
  for (const id of configuredAllowlistIds) {
    const trimmed = id.trim();
    if (!trimmed || trimmed === selectedServerId || byId.has(trimmed)) continue;
    byId.set(trimmed, {
      serverId: trimmed,
      label: trimmed,
      linkedOnDaemon: false,
      status: "offline",
      syncConnection: null,
      otherStewardNames: [...(otherOwnerNamesByTargetServerId[trimmed] ?? [])],
    });
  }
}

export function buildFleetScopeCandidateHosts(input: {
  selectedServerId: string;
  availableRemoteHosts: readonly MainChatFleetHostStatus[];
  inScopeHosts: readonly MainChatFleetHostStatus[];
  clientHosts: readonly HostProfile[];
  configuredAllowlistIds: readonly string[];
  otherOwnerNamesByTargetServerId: Readonly<Record<string, readonly string[] | undefined>>;
}): FleetScopeCandidateHost[] {
  const byId = new Map<string, FleetScopeCandidateHost>();
  const clientById = new Map<string, HostProfile>();
  for (const clientHost of input.clientHosts) {
    clientById.set(clientHost.serverId, clientHost);
  }

  const daemonRemotes =
    input.availableRemoteHosts.length > 0
      ? input.availableRemoteHosts
      : input.inScopeHosts.filter(
          (host) => !host.isLocal && host.serverId !== input.selectedServerId,
        );

  for (const remote of daemonRemotes) {
    if (!remote.serverId || remote.serverId === input.selectedServerId) continue;
    const clientMatch = clientById.get(remote.serverId);
    byId.set(remote.serverId, {
      serverId: remote.serverId,
      label: clientMatch?.label.trim() || remote.label.trim() || remote.serverId,
      linkedOnDaemon: true,
      status: remote.status,
      syncConnection: clientMatch ? buildSyncConnectionString(clientMatch) : null,
      otherStewardNames: [...(input.otherOwnerNamesByTargetServerId[remote.serverId] ?? [])],
    });
  }

  appendClientOnlyCandidates(
    byId,
    input.selectedServerId,
    input.clientHosts,
    input.otherOwnerNamesByTargetServerId,
  );
  appendConfiguredAllowlistCandidates(
    byId,
    input.selectedServerId,
    input.configuredAllowlistIds,
    input.otherOwnerNamesByTargetServerId,
  );

  return Array.from(byId.values()).sort((left, right) => {
    if (left.linkedOnDaemon !== right.linkedOnDaemon) return left.linkedOnDaemon ? -1 : 1;
    return left.label.localeCompare(right.label);
  });
}

function resolveStatusVariant(status: FleetScopeCandidateHost["status"]): StatusBadgeVariant {
  switch (status) {
    case "online":
      return "success";
    case "connecting":
    case "degraded":
      return "warning";
    case "error":
      return "error";
    default:
      return "muted";
  }
}

function resolveCandidateHintText(
  candidate: FleetScopeCandidateHost,
  t: (key: string) => string,
): string {
  if (candidate.linkedOnDaemon) {
    return t("mainChat.stewards.scope.linkedConnectedHint");
  }
  if (candidate.syncConnection) {
    return t("mainChat.stewards.scope.clientOnlyHint");
  }
  return t("mainChat.stewards.scope.clientManualOnlyHint");
}

const CandidateHostRow = memo(function CandidateHostRow({
  candidate,
  checked,
  interactive,
  disabled,
  onToggle,
}: {
  candidate: FleetScopeCandidateHost;
  checked: boolean;
  interactive: boolean;
  disabled: boolean;
  onToggle: (candidate: FleetScopeCandidateHost, nextChecked: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();

  const handlePress = useCallback(() => {
    if (!interactive || disabled) return;
    onToggle(candidate, !checked);
  }, [candidate, checked, disabled, interactive, onToggle]);

  const hintText = resolveCandidateHintText(candidate, t);
  const accessibilityState = useMemo(
    () => (interactive ? { checked, disabled } : undefined),
    [checked, disabled, interactive],
  );

  return (
    <PressHighlight
      onPress={handlePress}
      disabled={!interactive || disabled}
      style={[
        settingsStyles.row,
        settingsStyles.rowBorder,
        styles.hostRow,
        !interactive && styles.hostRowReadonly,
      ]}
      highlightStyle={styles.hostRowPressed}
      accessibilityRole={interactive ? "checkbox" : undefined}
      accessibilityState={accessibilityState}
      testID={`settings-fleet-scope-host-${candidate.serverId}`}
    >
      <View style={styles.checkIconSlot}>
        {checked ? (
          <ThemedCheckSquare size={16} uniProps={accentIconMapping} />
        ) : (
          <ThemedSquare size={16} uniProps={mutedIconMapping} />
        )}
      </View>
      <View style={styles.hostRowText}>
        <View style={styles.hostTitleLine}>
          <Text style={settingsStyles.rowTitle} numberOfLines={1}>
            {candidate.label}
          </Text>
          {candidate.status === "client_only" ? (
            <View style={styles.clientOnlyPill}>
              <ThemedLink2 size={10} uniProps={mutedIconMapping} />
              <Text style={styles.clientOnlyPillText}>{t("mainChat.fleetSync.readOnlyBadge")}</Text>
            </View>
          ) : (
            <StatusBadge
              size="xs"
              variant={resolveStatusVariant(candidate.status)}
              label={t(`mainChat.fleetSync.status.${candidate.status}`)}
            />
          )}
          {candidate.otherStewardNames.map((name) => (
            <StatusBadge
              key={name}
              size="xs"
              variant="warning"
              label={t("mainChat.stewards.scope.otherOwnerBadge", { steward: name })}
            />
          ))}
        </View>
        <Text style={settingsStyles.rowHint}>{hintText}</Text>
      </View>
    </PressHighlight>
  );
});

const RemoteCandidateListSection = memo(function RemoteCandidateListSection({
  mode,
  candidates,
  allowlistSet,
  saving,
  onToggleRemoteHost,
}: {
  mode: MainChatFleetScopeMode;
  candidates: readonly FleetScopeCandidateHost[];
  allowlistSet: ReadonlySet<string>;
  saving: boolean;
  onToggleRemoteHost: (candidate: FleetScopeCandidateHost, nextChecked: boolean) => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (mode === "local_only") {
    return null;
  }
  if (candidates.length === 0) {
    return (
      <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
        <Text style={settingsStyles.rowHint}>{t("mainChat.stewards.scope.emptyRemoteHosts")}</Text>
      </View>
    );
  }
  const isAllowlistMode = mode === "allowlist";
  return (
    <>
      {candidates.map((candidate) => (
        <CandidateHostRow
          key={candidate.serverId}
          candidate={candidate}
          checked={
            isAllowlistMode ? allowlistSet.has(candidate.serverId) : candidate.linkedOnDaemon
          }
          interactive={isAllowlistMode}
          disabled={saving}
          onToggle={onToggleRemoteHost}
        />
      ))}
    </>
  );
});

export interface MainChatFleetScopePanelProps {
  selectedServerId: string;
  selectedHostLabel: string;
  fleetScope: MainChatFleetScope | undefined;
  availableRemoteHosts: readonly MainChatFleetHostStatus[];
  inScopeHosts: readonly MainChatFleetHostStatus[];
  clientHosts: readonly HostProfile[];
  otherOwnerNamesByTargetServerId: Readonly<Record<string, readonly string[] | undefined>>;
  saving: boolean;
  onChangeMode: (mode: MainChatFleetScopeMode) => void;
  onToggleRemoteHost: (candidate: FleetScopeCandidateHost, nextChecked: boolean) => void;
}

export const MainChatFleetScopePanel = memo(function MainChatFleetScopePanel({
  selectedServerId,
  selectedHostLabel,
  fleetScope,
  availableRemoteHosts,
  inScopeHosts,
  clientHosts,
  otherOwnerNamesByTargetServerId,
  saving,
  onChangeMode,
  onToggleRemoteHost,
}: MainChatFleetScopePanelProps): ReactElement {
  const { t } = useTranslation();
  const resolvedScope = useMemo(
    () => resolveMainChatFleetScope({ fleetScope }, selectedServerId),
    [fleetScope, selectedServerId],
  );

  const modeOptions = useMemo<SegmentedControlOption<MainChatFleetScopeMode>[]>(
    () => [
      {
        value: "local_only",
        label: t("mainChat.stewards.scope.modeLocalOnly"),
        disabled: saving,
        testID: "settings-fleet-scope-mode-local_only",
      },
      {
        value: "allowlist",
        label: t("mainChat.stewards.scope.modeAllowlist"),
        disabled: saving,
        testID: "settings-fleet-scope-mode-allowlist",
      },
      {
        value: "all_connected",
        label: t("mainChat.stewards.scope.modeAllConnected"),
        disabled: saving,
        testID: "settings-fleet-scope-mode-all_connected",
      },
    ],
    [saving, t],
  );

  const modeHint = useMemo(() => {
    switch (resolvedScope.mode) {
      case "local_only":
        return t("mainChat.stewards.scope.modeLocalOnlyHint", { host: selectedHostLabel });
      case "allowlist":
        return t("mainChat.stewards.scope.modeAllowlistHint");
      case "all_connected":
        return t("mainChat.stewards.scope.modeAllConnectedHint");
    }
  }, [resolvedScope.mode, selectedHostLabel, t]);

  const allowlistSet = useMemo(
    () => new Set(resolvedScope.hostServerIds),
    [resolvedScope.hostServerIds],
  );

  const candidates = useMemo(
    () =>
      buildFleetScopeCandidateHosts({
        selectedServerId,
        availableRemoteHosts,
        inScopeHosts,
        clientHosts,
        configuredAllowlistIds: resolvedScope.hostServerIds,
        otherOwnerNamesByTargetServerId,
      }),
    [
      availableRemoteHosts,
      clientHosts,
      inScopeHosts,
      otherOwnerNamesByTargetServerId,
      resolvedScope.hostServerIds,
      selectedServerId,
    ],
  );

  return (
    <View style={settingsStyles.card} testID="settings-main-chat-fleet-scope-card">
      <View style={[settingsStyles.row, styles.modeSection]}>
        <SegmentedControl
          options={modeOptions}
          value={resolvedScope.mode}
          onValueChange={onChangeMode}
          testID="settings-main-chat-fleet-scope-mode"
        />
        <Text style={settingsStyles.rowHint}>{modeHint}</Text>
      </View>

      <View
        style={[
          settingsStyles.row,
          settingsStyles.rowBorder,
          styles.hostRow,
          styles.hostRowReadonly,
        ]}
        testID={`settings-fleet-scope-local-${selectedServerId}`}
      >
        <View style={styles.checkIconSlot}>
          <ThemedCheckSquare size={16} uniProps={accentIconMapping} />
        </View>
        <View style={styles.hostRowText}>
          <View style={styles.hostTitleLine}>
            <ThemedServer size={13} uniProps={mutedIconMapping} />
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {selectedHostLabel}
            </Text>
            <StatusBadge size="xs" variant="muted" label={t("mainChat.fleetSync.localBadge")} />
          </View>
          <Text style={settingsStyles.rowHint}>{t("mainChat.stewards.scope.localLockedHint")}</Text>
        </View>
      </View>

      <RemoteCandidateListSection
        mode={resolvedScope.mode}
        candidates={candidates}
        allowlistSet={allowlistSet}
        saving={saving}
        onToggleRemoteHost={onToggleRemoteHost}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  modeSection: {
    gap: theme.spacing[2],
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  hostRowReadonly: {
    opacity: 0.85,
  },
  hostRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  checkIconSlot: {
    paddingTop: 2,
  },
  hostRowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  hostTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  clientOnlyPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1.5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
  },
  clientOnlyPillText: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
  },
}));
