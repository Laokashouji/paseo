import type { MainChatFleetHostStatus } from "@getpaseo/protocol/main-chat";
import { AlertTriangle, ChevronDown } from "lucide-react-native";
import { memo, useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";
import type {
  MainChatGroupHostItem,
  MainChatHostGroup,
  MainChatUnmanagedHostItem,
} from "./host-groups";
import type { StewardAccentTone, StewardHostConflict } from "./steward-store";
import type { MainChatHostGroupsController } from "./use-host-groups";

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedChevronDown = withUnistyles(ChevronDown);

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

function resolveStatusVariant(status: MainChatFleetHostStatus["status"]): StatusBadgeVariant {
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

function resolveStatusKey(status: MainChatFleetHostStatus["status"]): string {
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

function resolveToneDotStyle(tone: StewardAccentTone) {
  switch (tone) {
    case "blue":
      return styles.dotBlue;
    case "green":
      return styles.dotGreen;
    case "orange":
      return styles.dotOrange;
    case "pink":
      return styles.dotPink;
    case "indigo":
      return styles.dotIndigo;
    default:
      return styles.dotAccent;
  }
}

const LegacyConflictRemoveButton = memo(function LegacyConflictRemoveButton({
  stewardServerId,
  stewardHostLabel,
  targetServerId,
  targetHostLabel,
  busyKey,
  onRemoveFromRemote,
}: {
  stewardServerId: string;
  stewardHostLabel: string;
  targetServerId: string;
  targetHostLabel: string;
  busyKey: string | null;
  onRemoveFromRemote: (
    stewardServerId: string,
    targetServerId: string,
    targetHostLabel: string,
    stewardHostLabel: string,
  ) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onRemoveFromRemote(stewardServerId, targetServerId, targetHostLabel, stewardHostLabel);
  }, [onRemoveFromRemote, stewardHostLabel, stewardServerId, targetHostLabel, targetServerId]);

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busyKey !== null}
      loading={busyKey === `legacy-remove:${stewardServerId}:${targetServerId}`}
      onPress={handlePress}
      testID={`main-chat-conflict-remove-${stewardServerId}-${targetServerId}`}
    >
      {t("mainChat.stewards.conflicts.removeFromRemoteButton", {
        steward: stewardHostLabel,
      })}
    </Button>
  );
});

const LegacyConflictCard = memo(function LegacyConflictCard({
  conflict,
  busyKey,
  onDisableLocal,
  onRemoveFromRemote,
}: {
  conflict: StewardHostConflict;
  busyKey: string | null;
  onDisableLocal: (targetServerId: string, targetHostLabel: string) => void;
  onRemoveFromRemote: (
    stewardServerId: string,
    targetServerId: string,
    targetHostLabel: string,
    stewardHostLabel: string,
  ) => void;
}): ReactElement {
  const { t } = useTranslation();
  const remoteOwners = conflict.owners.filter((owner) => !owner.isLocalOwner);
  const stewardsText = (
    conflict.kind === "local_and_remote_steward" ? remoteOwners : conflict.owners
  )
    .map((owner) => owner.stewardHostLabel)
    .join("、");

  const handleDisableLocal = useCallback(() => {
    onDisableLocal(conflict.targetServerId, conflict.targetHostLabel);
  }, [conflict.targetHostLabel, conflict.targetServerId, onDisableLocal]);

  return (
    <View
      style={styles.conflictCard}
      testID={`main-chat-legacy-conflict-${conflict.targetServerId}`}
    >
      <View style={styles.conflictHeader}>
        <ThemedAlertTriangle size={14} uniProps={warningIconMapping} />
        <Text style={styles.conflictTitle}>{t("mainChat.stewards.conflicts.title")}</Text>
      </View>
      <Text style={styles.conflictDesc}>
        {conflict.kind === "local_and_remote_steward"
          ? t("mainChat.stewards.conflicts.localAndRemoteDescription", {
              host: conflict.targetHostLabel,
              stewards: stewardsText,
            })
          : t("mainChat.stewards.conflicts.duplicateManagedDescription", {
              host: conflict.targetHostLabel,
              stewards: stewardsText,
            })}
      </Text>
      <View style={styles.conflictActions}>
        {conflict.kind === "local_and_remote_steward" ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={busyKey !== null}
            loading={busyKey === `legacy-disable:${conflict.targetServerId}`}
            onPress={handleDisableLocal}
            testID={`main-chat-conflict-disable-${conflict.targetServerId}`}
          >
            {t("mainChat.stewards.conflicts.disableLocalButton", {
              host: conflict.targetHostLabel,
            })}
          </Button>
        ) : null}
        {remoteOwners.map((owner) => (
          <LegacyConflictRemoveButton
            key={owner.stewardServerId}
            stewardServerId={owner.stewardServerId}
            stewardHostLabel={owner.stewardHostLabel}
            targetServerId={conflict.targetServerId}
            targetHostLabel={conflict.targetHostLabel}
            busyKey={busyKey}
            onRemoveFromRemote={onRemoveFromRemote}
          />
        ))}
      </View>
    </View>
  );
});

const GroupMemberRow = memo(function GroupMemberRow({
  groupOwnerServerId,
  ownerOnline,
  member,
  isLast,
  busyKey,
  onLeave,
}: {
  groupOwnerServerId: string;
  ownerOnline: boolean;
  member: MainChatGroupHostItem;
  isLast: boolean;
  busyKey: string | null;
  onLeave: (hostServerId: string, groupOwnerServerId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const leaveKey = `leave:${groupOwnerServerId}:${member.serverId}`;
  const isLeaving = busyKey === leaveKey;

  const handleLeave = useCallback(() => {
    onLeave(member.serverId, groupOwnerServerId);
  }, [groupOwnerServerId, member.serverId, onLeave]);

  return (
    <View
      style={[styles.hostRow, !isLast && styles.hostRowBorder]}
      testID={`main-chat-group-host-${groupOwnerServerId}-${member.serverId}`}
    >
      <View style={styles.hostRowMain}>
        <View style={styles.hostTitleLine}>
          <Text style={styles.hostLabel} numberOfLines={1}>
            {member.label}
          </Text>
          {member.isOwner ? (
            <StatusBadge size="xs" variant="muted" label={t("mainChat.groups.ownerBadge")} />
          ) : null}
          <StatusBadge
            size="xs"
            variant={resolveStatusVariant(member.status)}
            label={t(resolveStatusKey(member.status))}
          />
        </View>
        {member.error ? (
          <Text style={styles.hostError} numberOfLines={1}>
            {member.error}
          </Text>
        ) : null}
      </View>

      <View style={styles.hostRowRight}>
        <View style={styles.metricsWrap}>
          <Text style={styles.metricText}>
            {t("mainChat.fleetSync.agentCount", { count: member.agentCount })}
          </Text>
          {member.needsAttentionCount > 0 ? (
            <StatusBadge
              size="xs"
              variant="warning"
              label={t("mainChat.fleetSync.attentionCount", { count: member.needsAttentionCount })}
            />
          ) : null}
        </View>

        <Button
          variant="ghost"
          size="sm"
          disabled={!ownerOnline || busyKey !== null}
          loading={isLeaving}
          onPress={handleLeave}
          testID={`main-chat-host-leave-${member.serverId}`}
        >
          {t("mainChat.groups.leaveAction")}
        </Button>
      </View>
    </View>
  );
});

const MainChatGroupCard = memo(function MainChatGroupCard({
  group,
  busyKey,
  showDisbandConfirm,
  onSelectGroup,
  onLeaveHost,
  onConfirmDisband,
  onCancelDisband,
}: {
  group: MainChatHostGroup;
  busyKey: string | null;
  showDisbandConfirm: boolean;
  onSelectGroup: (ownerServerId: string) => void;
  onLeaveHost: (hostServerId: string, groupOwnerServerId: string) => void;
  onConfirmDisband: (ownerServerId: string) => void;
  onCancelDisband: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const remoteMemberCount = group.members.filter((member) => !member.isOwner).length;

  const handleSelect = useCallback(() => {
    onSelectGroup(group.ownerServerId);
  }, [group.ownerServerId, onSelectGroup]);

  const handleConfirm = useCallback(() => {
    onConfirmDisband(group.ownerServerId);
  }, [group.ownerServerId, onConfirmDisband]);

  return (
    <View
      style={[styles.groupCard, group.isActive && styles.groupCardActive]}
      testID={`main-chat-group-card-${group.ownerServerId}`}
    >
      <PressHighlight
        onPress={handleSelect}
        style={[styles.groupHeader, group.isActive && styles.groupHeaderActive]}
        highlightStyle={styles.groupHeaderPressed}
        accessibilityRole="button"
        accessibilityState={group.isActive ? SELECTED_STATE : UNSELECTED_STATE}
        testID={`main-chat-group-header-${group.ownerServerId}`}
      >
        <View style={styles.groupHeaderLeft}>
          <View
            style={[
              styles.groupDot,
              resolveToneDotStyle(group.accentTone),
              !group.ownerOnline && styles.dotOffline,
            ]}
          />
          <Text style={styles.groupOwnerName} numberOfLines={1}>
            {group.ownerHostLabel}
          </Text>
          {group.customTitle ? (
            <Text style={styles.groupCustomTitle} numberOfLines={1}>
              {group.customTitle}
            </Text>
          ) : null}
          {group.isActive ? (
            <StatusBadge size="xs" variant="success" label={t("mainChat.groups.activeBadge")} />
          ) : null}
          {!group.ownerOnline ? (
            <StatusBadge size="xs" variant="muted" label={t("mainChat.stewards.offlineBadge")} />
          ) : null}
        </View>

        <Text style={styles.groupSummaryText} numberOfLines={1}>
          {t("mainChat.groups.groupHostCount", {
            total: group.totalCount,
            online: group.onlineCount,
          })}
        </Text>
      </PressHighlight>

      <View style={styles.memberList}>
        {group.members.map((member, index) => (
          <GroupMemberRow
            key={member.serverId}
            groupOwnerServerId={group.ownerServerId}
            ownerOnline={group.ownerOnline}
            member={member}
            isLast={index === group.members.length - 1}
            busyKey={busyKey}
            onLeave={onLeaveHost}
          />
        ))}
      </View>

      {showDisbandConfirm ? (
        <View
          style={styles.disbandBar}
          testID={`main-chat-group-disband-confirm-${group.ownerServerId}`}
        >
          <Text style={styles.disbandText}>
            {t("mainChat.groups.disbandConfirmText", {
              host: group.ownerHostLabel,
              count: remoteMemberCount,
            })}
          </Text>
          <View style={styles.disbandActions}>
            <Button
              variant="destructive"
              size="sm"
              disabled={busyKey !== null}
              loading={busyKey === `leave:${group.ownerServerId}:${group.ownerServerId}`}
              onPress={handleConfirm}
              testID={`main-chat-group-disband-yes-${group.ownerServerId}`}
            >
              {t("mainChat.groups.disbandConfirmButton")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busyKey !== null}
              onPress={onCancelDisband}
              testID={`main-chat-group-disband-cancel-${group.ownerServerId}`}
            >
              {t("common.cancel")}
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
});

const JoinGroupMenuItem = memo(function JoinGroupMenuItem({
  hostServerId,
  group,
  onJoinGroup,
}: {
  hostServerId: string;
  group: MainChatHostGroup;
  onJoinGroup: (hostServerId: string, targetOwnerServerId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onJoinGroup(hostServerId, group.ownerServerId);
  }, [group.ownerServerId, hostServerId, onJoinGroup]);

  const descParts: string[] = [];
  if (group.customTitle) descParts.push(group.customTitle);
  descParts.push(t("mainChat.groups.joinPickerHostCount", { count: group.totalCount }));
  if (!group.ownerOnline) {
    descParts.push(t("mainChat.stewards.offlineBadge"));
  }

  return (
    <DropdownMenuItem
      disabled={!group.ownerOnline}
      description={descParts.join(" · ")}
      onSelect={handleSelect}
      testID={`main-chat-host-join-${hostServerId}-${group.ownerServerId}`}
    >
      {group.ownerHostLabel}
    </DropdownMenuItem>
  );
});

const UnmanagedHostRow = memo(function UnmanagedHostRow({
  host,
  groups,
  isLast,
  busyKey,
  onJoinGroup,
  onPromoteHost,
}: {
  host: MainChatUnmanagedHostItem;
  groups: readonly MainChatHostGroup[];
  isLast: boolean;
  busyKey: string | null;
  onJoinGroup: (hostServerId: string, targetOwnerServerId: string) => void;
  onPromoteHost: (serverId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const singleGroup = groups.length === 1 ? groups[0] : null;
  const isJoining = busyKey === `join:${host.serverId}`;
  const isPromoting = busyKey === `promote:${host.serverId}`;

  const handleJoinSingle = useCallback(() => {
    if (!singleGroup) return;
    onJoinGroup(host.serverId, singleGroup.ownerServerId);
  }, [host.serverId, onJoinGroup, singleGroup]);

  const handlePromote = useCallback(() => {
    onPromoteHost(host.serverId);
  }, [host.serverId, onPromoteHost]);

  return (
    <View
      style={[styles.hostRow, !isLast && styles.hostRowBorder]}
      testID={`main-chat-unmanaged-host-${host.serverId}`}
    >
      <View style={styles.hostRowMain}>
        <View style={styles.hostTitleLine}>
          <Text style={styles.hostLabel} numberOfLines={1}>
            {host.label}
          </Text>
          <StatusBadge
            size="xs"
            variant={resolveStatusVariant(host.status)}
            label={t(resolveStatusKey(host.status))}
          />
        </View>
      </View>

      <View style={styles.hostRowRight}>
        {host.online ? (
          <Text style={styles.metricText}>
            {t("mainChat.fleetSync.agentCount", { count: host.agentCount })}
          </Text>
        ) : null}

        {singleGroup ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={!singleGroup.ownerOnline || busyKey !== null}
            loading={isJoining}
            onPress={handleJoinSingle}
            testID={`main-chat-host-join-${host.serverId}-${singleGroup.ownerServerId}`}
          >
            {t("mainChat.groups.joinSingleAction", { host: singleGroup.ownerHostLabel })}
          </Button>
        ) : null}

        {groups.length >= 2 ? (
          <DropdownMenu compactMode="sheet">
            <DropdownMenuTrigger
              disabled={busyKey !== null}
              style={styles.joinPickerTrigger}
              accessibilityRole="button"
              testID={`main-chat-host-join-picker-${host.serverId}`}
            >
              <Text style={styles.joinPickerText}>{t("mainChat.groups.joinPickerAction")}</Text>
              <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              width={230}
              sheetTitle={t("mainChat.groups.joinPickerHeading")}
            >
              <DropdownMenuLabel>{t("mainChat.groups.joinPickerHeading")}</DropdownMenuLabel>
              {groups.map((group) => (
                <JoinGroupMenuItem
                  key={group.ownerServerId}
                  hostServerId={host.serverId}
                  group={group}
                  onJoinGroup={onJoinGroup}
                />
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {host.supportsMainChat ? (
          <Button
            variant={groups.length === 0 ? "default" : "outline"}
            size="sm"
            disabled={!host.online || busyKey !== null}
            loading={isPromoting}
            onPress={handlePromote}
            testID={`main-chat-host-promote-${host.serverId}`}
          >
            {t("mainChat.groups.promoteAction")}
          </Button>
        ) : null}
      </View>
    </View>
  );
});

export interface MainChatHostGroupsPanelProps {
  controller: MainChatHostGroupsController;
  testID?: string;
}

/**
 * Unified grouped host organizer shared between `/main` top capsule and Settings → Main Chat.
 * Every enabled Main Chat host forms one card (identified by its host name); all remaining hosts
 * sit cleanly in the Unmanaged card below.
 */
export const MainChatHostGroupsPanel = memo(function MainChatHostGroupsPanel({
  controller,
  testID = "main-chat-host-groups-panel",
}: MainChatHostGroupsPanelProps): ReactElement {
  const { t } = useTranslation();
  const {
    partition,
    busyKey,
    confirmDisbandGroupId,
    selectGroup,
    promoteHostToMainChat,
    joinHostToGroup,
    requestLeaveGroup,
    confirmDisbandGroup,
    cancelDisbandGroup,
    resolveLegacyDisableLocal,
    resolveLegacyRemoveFromRemote,
  } = controller;

  const { groups, unmanaged, legacyConflicts } = partition;

  return (
    <View style={styles.container} testID={testID}>
      {legacyConflicts.map((conflict) => (
        <LegacyConflictCard
          key={conflict.id}
          conflict={conflict}
          busyKey={busyKey}
          onDisableLocal={resolveLegacyDisableLocal}
          onRemoveFromRemote={resolveLegacyRemoveFromRemote}
        />
      ))}

      {groups.map((group) => (
        <MainChatGroupCard
          key={group.ownerServerId}
          group={group}
          busyKey={busyKey}
          showDisbandConfirm={confirmDisbandGroupId === group.ownerServerId}
          onSelectGroup={selectGroup}
          onLeaveHost={requestLeaveGroup}
          onConfirmDisband={confirmDisbandGroup}
          onCancelDisband={cancelDisbandGroup}
        />
      ))}

      {unmanaged.length > 0 || groups.length === 0 ? (
        <View style={styles.unmanagedCard} testID="main-chat-unmanaged-group">
          <View style={styles.unmanagedHeader}>
            <View style={styles.unmanagedHeaderLeft}>
              <View style={styles.unmanagedDot} />
              <Text style={styles.unmanagedTitle}>{t("mainChat.groups.unmanagedTitle")}</Text>
              <Text style={styles.unmanagedCount}>
                {t("mainChat.groups.unmanagedCount", { count: unmanaged.length })}
              </Text>
            </View>
            <Text style={styles.unmanagedHint} numberOfLines={1}>
              {t("mainChat.groups.unmanagedHint")}
            </Text>
          </View>

          {unmanaged.length > 0 ? (
            <View style={styles.memberList}>
              {unmanaged.map((host, index) => (
                <UnmanagedHostRow
                  key={host.serverId}
                  host={host}
                  groups={groups}
                  isLast={index === unmanaged.length - 1}
                  busyKey={busyKey}
                  onJoinGroup={joinHostToGroup}
                  onPromoteHost={promoteHostToMainChat}
                />
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
  },
  conflictCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  conflictHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  conflictTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  conflictDesc: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  conflictActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  groupCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  groupCardActive: {
    borderColor: theme.colors.primary,
  },
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  groupHeaderActive: {
    backgroundColor: theme.colors.surface2,
  },
  groupHeaderPressed: {
    opacity: 0.85,
  },
  groupHeaderLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  groupDot: {
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
  },
  dotAccent: {
    backgroundColor: theme.colors.primary,
  },
  dotBlue: {
    backgroundColor: "#2563eb",
  },
  dotGreen: {
    backgroundColor: "#16a34a",
  },
  dotOrange: {
    backgroundColor: "#ea580c",
  },
  dotPink: {
    backgroundColor: "#db2777",
  },
  dotIndigo: {
    backgroundColor: "#4f46e5",
  },
  dotOffline: {
    opacity: 0.4,
  },
  groupOwnerName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  groupCustomTitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  groupSummaryText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  memberList: {
    paddingHorizontal: theme.spacing[3],
  },
  hostRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  hostRowBorder: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  hostRowMain: {
    flex: 1,
    minWidth: 140,
    gap: 2,
  },
  hostTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  hostLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  hostError: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  hostRowRight: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  metricsWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  metricText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  disbandBar: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.statusWarning,
    gap: theme.spacing[2],
  },
  disbandText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 18,
  },
  disbandActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  unmanagedCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderStyle: "dashed",
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  unmanagedHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  unmanagedHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  unmanagedDot: {
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
    opacity: 0.6,
  },
  unmanagedTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  unmanagedCount: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  unmanagedHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  joinPickerTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  joinPickerText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
