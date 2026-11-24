import { isMainChatEnabled, type MainChatSettings } from "@getpaseo/protocol/main-chat";
import { AlertTriangle, Server, Star } from "lucide-react-native";
import { memo, useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import {
  resolveStewardAccentTone,
  type MainChatStewardRosterItem,
  type StewardAccentTone,
  type StewardHostConflict,
} from "@/main-chat/steward-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedServer = withUnistyles(Server);
const ThemedStar = withUnistyles(Star);

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface StewardRosterHostEntry {
  serverId: string;
  label: string;
  online: boolean;
  settings: MainChatSettings | undefined;
  rosterItem: MainChatStewardRosterItem | null;
}

function resolveToneDotStyle(tone: StewardAccentTone) {
  switch (tone) {
    case "blue":
      return styles.toneBlue;
    case "green":
      return styles.toneGreen;
    case "orange":
      return styles.toneOrange;
    case "pink":
      return styles.tonePink;
    case "indigo":
      return styles.toneIndigo;
    default:
      return styles.toneAccent;
  }
}

const ConflictRemoveOwnerButton = memo(function ConflictRemoveOwnerButton({
  owner,
  targetServerId,
  targetHostLabel,
  busyKey,
  onRemove,
}: {
  owner: StewardHostConflict["owners"][number];
  targetServerId: string;
  targetHostLabel: string;
  busyKey: string | null;
  onRemove: (
    stewardServerId: string,
    stewardTitle: string,
    targetServerId: string,
    hostLabel: string,
  ) => void;
}): ReactElement {
  const { t } = useTranslation();
  const actionKey = `remove:${owner.stewardServerId}:${targetServerId}`;
  const handlePress = useCallback(() => {
    onRemove(owner.stewardServerId, owner.stewardTitle, targetServerId, targetHostLabel);
  }, [onRemove, owner.stewardServerId, owner.stewardTitle, targetHostLabel, targetServerId]);

  return (
    <Button
      variant="outline"
      size="sm"
      loading={busyKey === actionKey}
      disabled={busyKey !== null}
      onPress={handlePress}
      testID={`settings-steward-conflict-remove-${owner.stewardServerId}-${targetServerId}`}
    >
      {t("mainChat.stewards.conflicts.removeFromRemoteButton", {
        steward: owner.stewardTitle,
      })}
    </Button>
  );
});

const StewardConflictCard = memo(function StewardConflictCard({
  conflict,
  busyKey,
  onDisableLocalSteward,
  onRemoveFromRemoteSteward,
}: {
  conflict: StewardHostConflict;
  busyKey: string | null;
  onDisableLocalSteward: (targetServerId: string, hostLabel: string) => void;
  onRemoveFromRemoteSteward: (
    stewardServerId: string,
    stewardTitle: string,
    targetServerId: string,
    hostLabel: string,
  ) => void;
}): ReactElement {
  const { t } = useTranslation();
  const remoteOwners = conflict.owners.filter((owner) => !owner.isLocalOwner);
  const stewardListText = remoteOwners
    .map((owner) => `「${owner.stewardTitle}」(${owner.stewardHostLabel})`)
    .join("、");

  const handleDisableLocal = useCallback(() => {
    onDisableLocalSteward(conflict.targetServerId, conflict.targetHostLabel);
  }, [conflict.targetHostLabel, conflict.targetServerId, onDisableLocalSteward]);

  const description =
    conflict.kind === "local_and_remote_steward"
      ? t("mainChat.stewards.conflicts.localAndRemoteDescription", {
          host: conflict.targetHostLabel,
          stewards: stewardListText,
        })
      : t("mainChat.stewards.conflicts.duplicateManagedDescription", {
          host: conflict.targetHostLabel,
          stewards: stewardListText,
        });

  return (
    <View
      style={styles.conflictItem}
      testID={`settings-steward-conflict-${conflict.targetServerId}`}
    >
      <View style={styles.conflictHeader}>
        <ThemedAlertTriangle size={14} uniProps={warningIconMapping} />
        <Text style={styles.conflictTitle}>{t("mainChat.stewards.conflicts.title")}</Text>
      </View>
      <Text style={styles.conflictDescription}>{description}</Text>
      <View style={styles.conflictActions}>
        {conflict.kind === "local_and_remote_steward" ? (
          <Button
            variant="default"
            size="sm"
            loading={busyKey === `disable:${conflict.targetServerId}`}
            disabled={busyKey !== null}
            onPress={handleDisableLocal}
            testID={`settings-steward-conflict-disable-${conflict.targetServerId}`}
          >
            {t("mainChat.stewards.conflicts.disableLocalButton", {
              host: conflict.targetHostLabel,
            })}
          </Button>
        ) : null}
        {remoteOwners.map((owner) => (
          <ConflictRemoveOwnerButton
            key={`remove:${owner.stewardServerId}:${conflict.targetServerId}`}
            owner={owner}
            targetServerId={conflict.targetServerId}
            targetHostLabel={conflict.targetHostLabel}
            busyKey={busyKey}
            onRemove={onRemoveFromRemoteSteward}
          />
        ))}
      </View>
    </View>
  );
});

export interface MainChatStewardConflictsBannerProps {
  conflicts: readonly StewardHostConflict[];
  busyKey: string | null;
  onDisableLocalSteward: (targetServerId: string, hostLabel: string) => void;
  onRemoveFromRemoteSteward: (
    stewardServerId: string,
    stewardTitle: string,
    targetServerId: string,
    hostLabel: string,
  ) => void;
}

export const MainChatStewardConflictsBanner = memo(function MainChatStewardConflictsBanner({
  conflicts,
  busyKey,
  onDisableLocalSteward,
  onRemoveFromRemoteSteward,
}: MainChatStewardConflictsBannerProps): ReactElement | null {
  if (conflicts.length === 0) return null;
  return (
    <View style={styles.conflictBanner} testID="settings-steward-conflicts-banner">
      {conflicts.map((conflict) => (
        <StewardConflictCard
          key={conflict.id}
          conflict={conflict}
          busyKey={busyKey}
          onDisableLocalSteward={onDisableLocalSteward}
          onRemoveFromRemoteSteward={onRemoveFromRemoteSteward}
        />
      ))}
    </View>
  );
});

function formatRosterScopeSummary(
  entry: StewardRosterHostEntry,
  enabled: boolean,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  if (!enabled) {
    return t("mainChat.stewards.roster.enableHint");
  }
  if (entry.rosterItem && entry.rosterItem.managedHostLabels.length > 1) {
    return t("mainChat.stewards.managedHostsSummary", {
      hosts: entry.rosterItem.managedHostLabels.join(" · "),
    });
  }
  return t("mainChat.stewards.localOnlySummary", { host: entry.label });
}

const StewardRosterBadges = memo(function StewardRosterBadges({
  enabled,
  online,
  isDefault,
  isActive,
  isEditing,
}: {
  enabled: boolean;
  online: boolean;
  isDefault: boolean;
  isActive: boolean;
  isEditing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      {isDefault && enabled ? (
        <StatusBadge size="xs" variant="muted" label={t("mainChat.stewards.defaultBadge")} />
      ) : null}
      {isActive && enabled ? (
        <StatusBadge
          size="xs"
          variant="success"
          label={t("mainChat.stewards.roster.activeBadge")}
        />
      ) : null}
      {isEditing ? (
        <StatusBadge
          size="xs"
          variant="muted"
          label={t("mainChat.stewards.roster.configuredBadge")}
        />
      ) : null}
      {!enabled ? (
        <StatusBadge size="xs" variant="muted" label={t("mainChat.stewards.disabledBadge")} />
      ) : null}
      {enabled && !online ? (
        <StatusBadge size="xs" variant="warning" label={t("mainChat.stewards.offlineBadge")} />
      ) : null}
    </>
  );
});

const StewardRosterRow = memo(function StewardRosterRow({
  entry,
  index,
  isEditing,
  isActive,
  onSelectHost,
  onSetDefault,
}: {
  entry: StewardRosterHostEntry;
  index: number;
  isEditing: boolean;
  isActive: boolean;
  onSelectHost: (serverId: string) => void;
  onSetDefault: (serverId: string, title: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const enabled = isMainChatEnabled(entry.settings);
  const isDefault = Boolean(entry.rosterItem?.isDefault);
  const title = entry.settings?.title?.trim() || entry.rosterItem?.title || entry.label;
  const tone = entry.rosterItem?.accentTone ?? resolveStewardAccentTone(entry.serverId, isDefault);
  const scopeSummary = formatRosterScopeSummary(entry, enabled, t);

  const handlePress = useCallback(() => {
    onSelectHost(entry.serverId);
  }, [entry.serverId, onSelectHost]);

  const handleSetDefault = useCallback(() => {
    onSetDefault(entry.serverId, title);
  }, [entry.serverId, onSetDefault, title]);

  return (
    <View
      style={[
        settingsStyles.row,
        index > 0 ? settingsStyles.rowBorder : null,
        styles.rosterRow,
        isEditing && styles.rosterRowEditing,
      ]}
      testID={`settings-steward-roster-row-${entry.serverId}`}
    >
      <PressHighlight
        onPress={handlePress}
        style={styles.rosterRowPress}
        highlightStyle={styles.rosterRowPressed}
        accessibilityRole="button"
        testID={`settings-steward-roster-select-${entry.serverId}`}
      >
        <View
          style={[
            styles.avatarBadge,
            enabled ? resolveToneDotStyle(tone) : styles.avatarBadgeDisabled,
          ]}
        >
          {enabled ? (
            <Text style={styles.avatarLetter}>{title.slice(0, 1) || "管"}</Text>
          ) : (
            <ThemedServer size={13} uniProps={mutedIconMapping} />
          )}
        </View>
        <View style={styles.rosterRowText}>
          <View style={styles.rosterTitleLine}>
            <Text style={settingsStyles.rowTitle} numberOfLines={1}>
              {title}
            </Text>
            <Text style={styles.hostTag} numberOfLines={1}>
              {entry.label}
            </Text>
            <StewardRosterBadges
              enabled={enabled}
              online={entry.online}
              isDefault={isDefault}
              isActive={isActive}
              isEditing={isEditing}
            />
          </View>
          <Text style={settingsStyles.rowHint} numberOfLines={2}>
            {scopeSummary}
          </Text>
        </View>
      </PressHighlight>

      {enabled && !isDefault ? (
        <Button
          variant="ghost"
          size="sm"
          leftIcon={ThemedStar}
          onPress={handleSetDefault}
          testID={`settings-steward-set-default-${entry.serverId}`}
        >
          {t("mainChat.stewards.setDefaultAction")}
        </Button>
      ) : null}
    </View>
  );
});

export interface MainChatStewardRosterPanelProps {
  entries: readonly StewardRosterHostEntry[];
  selectedServerId: string | null;
  activeStewardServerId: string | null;
  filterWorkspacesByActiveSteward: boolean;
  onSelectHost: (serverId: string) => void;
  onSetDefault: (serverId: string, title: string) => void;
  onToggleFilterWorkspaces: (enabled: boolean) => void;
}

export const MainChatStewardRosterPanel = memo(function MainChatStewardRosterPanel({
  entries,
  selectedServerId,
  activeStewardServerId,
  filterWorkspacesByActiveSteward,
  onSelectHost,
  onSetDefault,
  onToggleFilterWorkspaces,
}: MainChatStewardRosterPanelProps): ReactElement {
  const { t } = useTranslation();

  return (
    <View style={settingsStyles.card} testID="settings-steward-roster-card">
      {entries.map((entry, index) => (
        <StewardRosterRow
          key={entry.serverId}
          entry={entry}
          index={index}
          isEditing={entry.serverId === selectedServerId}
          isActive={entry.serverId === activeStewardServerId}
          onSelectHost={onSelectHost}
          onSetDefault={onSetDefault}
        />
      ))}

      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.preferenceRow]}>
        <View style={styles.preferenceText}>
          <Text style={settingsStyles.rowTitle}>
            {t("mainChat.stewards.roster.filterWorkspacesTitle")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("mainChat.stewards.roster.filterWorkspacesHint")}
          </Text>
        </View>
        <Switch
          value={filterWorkspacesByActiveSteward}
          onValueChange={onToggleFilterWorkspaces}
          accessibilityLabel={t("mainChat.stewards.roster.filterWorkspacesTitle")}
          testID="settings-steward-filter-workspaces"
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  conflictBanner: {
    gap: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  conflictItem: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusWarning,
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
  conflictDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  conflictActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  rosterRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  rosterRowEditing: {
    backgroundColor: theme.colors.surface2,
  },
  rosterRowPress: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  rosterRowPressed: {
    opacity: 0.8,
  },
  avatarBadge: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  avatarBadgeDisabled: {
    backgroundColor: theme.colors.surface3,
  },
  toneAccent: {
    backgroundColor: theme.colors.accent,
  },
  toneBlue: {
    backgroundColor: "#2563eb",
  },
  toneGreen: {
    backgroundColor: "#16a34a",
  },
  toneOrange: {
    backgroundColor: "#ea580c",
  },
  tonePink: {
    backgroundColor: "#db2777",
  },
  toneIndigo: {
    backgroundColor: "#4f46e5",
  },
  avatarLetter: {
    fontSize: 12,
    fontWeight: theme.fontWeight.bold,
    color: "#ffffff",
  },
  rosterRowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rosterTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  hostTag: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  preferenceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  preferenceText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
}));
