import type { AgentAddress } from "@getpaseo/protocol/addresses";
import { useCallback, useMemo, type ReactElement } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { Archive, CornerDownRight, GitBranch, GitBranchPlus } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useProviderIcon } from "@/components/provider-icons";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { mutedIconColorMapping } from "@/components/ui/icon-button-chrome";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { ComposerTrackActions, ComposerTrackPill, ComposerTrackRow } from "@/composer/tracks";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useAgentFactsLine } from "@/panels/agent-facts-line";
import { getPanelManifest } from "@/panels/panel-manifest";
import {
  WorkspaceTabIcon,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { BranchRow } from "./select";
import {
  buildBranchPillPresentation,
  buildBranchRowPresentationData,
} from "./track-presentation";

const ThemedGitBranch = withUnistyles(GitBranch);
const ThemedGitBranchPlus = withUnistyles(GitBranchPlus);
const ThemedCornerDownRight = withUnistyles(CornerDownRight);
const ThemedArchive = withUnistyles(Archive);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});

const ROW_ICON_SIZE = 14;
const PILL_ICON_SIZE = 13;

export interface BranchesTrackProps {
  serverId: string;
  workspaceId: string;
  rows: BranchRow[];
  onOpenBranch: (address: AgentAddress) => void;
  onCreateBranch?: () => void;
  isCreatingBranch?: boolean;
  onArchiveBranch: (address: AgentAddress) => void;
}

function useBranchRowPresentation(row: BranchRow): WorkspaceTabPresentation {
  const icon = useProviderIcon(row.provider, row.address.serverId);
  const data = buildBranchRowPresentationData(row);
  return {
    ...data,
    subtitle: "",
    tooltip: data.label,
    modified: false,
    showCloseButton: getPanelManifest(data.kind).showCloseButton,
    icon,
  };
}

/**
 * Displays sibling/descendant forked conversations as a compact capsule above the composer,
 * matching the subagents track pill and panel chrome.
 */
export function BranchesTrack({
  serverId,
  workspaceId,
  rows,
  onOpenBranch,
  onCreateBranch,
  isCreatingBranch = false,
  onArchiveBranch,
}: BranchesTrackProps): ReactElement | null {
  const { t } = useTranslation();

  const leadingIcon = useMemo(
    () => <ThemedGitBranch size={PILL_ICON_SIZE} uniProps={foregroundMutedColorMapping} />,
    [],
  );

  if (rows.length <= 1) {
    return null;
  }

  const pill = buildBranchPillPresentation(t, rows);

  return (
    <ComposerTrackPill
      testID="branches-track-header"
      leadingIcon={leadingIcon}
      segments={pill.segments}
      accessibilityLabel={pill.accessibilityLabel}
      panelTitle={t("branches.title")}
    >
      {onCreateBranch ? (
        <ComposerTrackActions divided={rows.length > 0}>
          <CreateBranchRow isCreating={isCreatingBranch} onPress={onCreateBranch} />
        </ComposerTrackActions>
      ) : null}
      {rows.map((row) => (
        <BranchesTrackRow
          key={`${row.address.serverId}:${row.id}`}
          row={row}
          currentServerId={serverId}
          currentWorkspaceId={workspaceId}
          onOpenBranch={onOpenBranch}
          onArchiveBranch={onArchiveBranch}
        />
      ))}
    </ComposerTrackPill>
  );
}

function CreateBranchRow({
  isCreating,
  onPress,
}: {
  isCreating: boolean;
  onPress: () => void;
}): ReactElement {
  const { t } = useTranslation();

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        {isCreating ? (
          <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />
        ) : (
          <ThemedGitBranchPlus
            size={ROW_ICON_SIZE}
            uniProps={active ? foregroundColorMapping : foregroundMutedColorMapping}
          />
        )}
        <Text style={styles.rowLabel} numberOfLines={1}>
          {isCreating ? t("branches.creatingAction") : t("branches.newBranchAction")}
        </Text>
      </>
    ),
    [isCreating, t],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={t("branches.newBranchAction")}
      testID="branches-track-create"
      disabled={isCreating}
      closeOnSelect
      onPress={onPress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function BranchesTrackRow({
  row,
  currentServerId,
  currentWorkspaceId,
  onOpenBranch,
  onArchiveBranch,
}: {
  row: BranchRow;
  currentServerId: string;
  currentWorkspaceId: string;
  onOpenBranch: (address: AgentAddress) => void;
  onArchiveBranch: (address: AgentAddress) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const presentation = useBranchRowPresentation(row);
  const workspaceName = useSessionStore((state) => {
    if (!row.workspaceId || (row.address.serverId === currentServerId && row.workspaceId === currentWorkspaceId)) {
      return null;
    }
    const workspace = state.sessions[row.address.serverId]?.workspaces.get(row.workspaceId);
    return (
      workspace?.title?.trim() ||
      workspace?.worktreeSlug?.trim() ||
      workspace?.projectDisplayName?.trim() ||
      null
    );
  });
  const displayLabel =
    presentation.titleState === "loading"
      ? t("common.states.loading")
      : presentation.label;
  const handlePress = useCallback(() => {
    if (!row.isCurrent) {
      onOpenBranch(row.address);
    }
  }, [onOpenBranch, row.address, row.isCurrent]);
  const handleArchivePress = useCallback(() => {
    onArchiveBranch(row.address);
  }, [onArchiveBranch, row.address]);
  const actionsAlwaysVisible = isNative || isCompact;

  const indentStyle =
    row.depth === 1
      ? styles.indent1
      : row.depth === 2
        ? styles.indent2
        : row.depth >= 3
          ? styles.indent3
          : null;

  const renderRow = useCallback(
    ({ active }: { active: boolean }) => (
      <>
        {indentStyle ? (
          <View style={[styles.indentSlot, indentStyle]}>
            <ThemedCornerDownRight size={12} uniProps={foregroundMutedColorMapping} />
          </View>
        ) : null}
        <WorkspaceTabIcon presentation={presentation} backdrop={active ? "surface2" : "surface1"} />
        <View style={styles.rowText}>
          <View style={styles.rowTitleLine}>
            <Text
              style={[styles.rowTitle, row.isCurrent ? styles.rowTitleCurrent : null]}
              numberOfLines={1}
            >
              {displayLabel}
            </Text>
            {row.isCurrent ? (
              <View style={styles.currentBadge} testID={`branches-track-current-${row.id}`}>
                <Text style={styles.currentBadgeText}>{t("branches.currentBadge")}</Text>
              </View>
            ) : null}
            {row.isRoot && !row.isCurrent ? (
              <View style={styles.rootBadge}>
                <Text style={styles.rootBadgeText}>{t("branches.rootBadge")}</Text>
              </View>
            ) : null}
          </View>
          {workspaceName ? (
            <Text style={styles.rowFacts} numberOfLines={1}>
              {workspaceName}
            </Text>
          ) : null}
          <BranchFacts serverId={row.address.serverId} agentId={row.id} />
        </View>
        {!row.isCurrent ? (
          <View
            style={actionsAlwaysVisible || active ? styles.actionVisible : styles.actionHidden}
            pointerEvents={actionsAlwaysVisible || active ? "auto" : "none"}
          >
            <BranchArchiveButton
              label={t("branches.archiveAction", { label: displayLabel })}
              tooltipLabel={t("branches.archiveTooltip")}
              compact={isCompact}
              onPress={handleArchivePress}
              testID={`branches-track-archive-${row.id}`}
            />
          </View>
        ) : null}
      </>
    ),
    [
      actionsAlwaysVisible,
      displayLabel,
      handleArchivePress,
      indentStyle,
      isCompact,
      presentation,
      row.address.serverId,
      row.id,
      row.isCurrent,
      row.isRoot,
      t,
      workspaceName,
    ],
  );

  return (
    <ComposerTrackRow
      accessibilityLabel={displayLabel}
      testID={`branches-track-row-${row.id}`}
      onPress={handlePress}
    >
      {renderRow}
    </ComposerTrackRow>
  );
}

function BranchFacts({ serverId, agentId }: { serverId: string; agentId: string }) {
  const text = useAgentFactsLine(serverId, agentId);
  if (!text) return null;
  return (
    <Text style={styles.rowFacts} numberOfLines={1} testID={`branches-track-row-facts-${agentId}`}>
      {text}
    </Text>
  );
}

function BranchArchiveButton({
  label,
  tooltipLabel,
  compact,
  onPress,
  testID,
}: {
  label: string;
  tooltipLabel: string;
  compact: boolean;
  onPress: () => void;
  testID: string;
}): ReactElement {
  const iconSize = paneContentToolbarIconSize(compact);
  const tooltip = useMemo(
    () => <Text style={styles.tooltipText}>{tooltipLabel}</Text>,
    [tooltipLabel],
  );
  return (
    <ToolbarButton
      label={label}
      tooltip={tooltip}
      tooltipSide="top"
      compact={compact}
      onPress={onPress}
      testID={testID}
    >
      <ThemedArchive size={iconSize} uniProps={mutedIconColorMapping} />
    </ToolbarButton>
  );
}

const styles = StyleSheet.create((theme) => ({
  rowLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  indentSlot: {
    alignItems: "flex-end",
    justifyContent: "center",
    flexShrink: 0,
  },
  indent1: {
    width: 14,
  },
  indent2: {
    width: 26,
  },
  indent3: {
    width: 38,
  },
  rowText: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: "auto",
    minWidth: 0,
    gap: 1,
  },
  rowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
  },
  rowTitle: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  rowTitleCurrent: {
    fontWeight: theme.fontWeight.semibold,
  },
  currentBadge: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
    flexShrink: 0,
  },
  currentBadgeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  rootBadge: {
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    flexShrink: 0,
  },
  rootBadgeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowFacts: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  actionVisible: {
    flexDirection: "row",
    alignItems: "center",
    opacity: 1,
  },
  actionHidden: {
    flexDirection: "row",
    alignItems: "center",
    opacity: 0,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
