import type { MainChatTaskIsolation, MainChatTaskMode } from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import { CornerDownRight, PanelRight } from "lucide-react-native";
import { memo, useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { StatusRing } from "@/components/status-ring";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import { useOpenMainChatTaskTarget } from "./open-task-target";
import { derivePlanTaskLiveBucket } from "./selectors";

const ThemedCornerDownRight = withUnistyles(CornerDownRight);
const ThemedPanelRight = withUnistyles(PanelRight);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export type HandoffSourceKind = "new" | "active" | "resumed" | "continuation";

export interface MainChatHandoffCardProps {
  serverId: string;
  agentId: string;
  title: string;
  workspaceId?: string | null;
  workspaceLabel?: string | null;
  hostLabel?: string | null;
  mode?: MainChatTaskMode | null;
  isolation?: MainChatTaskIsolation | null;
  taskId?: string | null;
  sourceKind?: HandoffSourceKind;
  startError?: string | null;
  expectedMinutes?: number | null;
  scopeRevision?: number | null;
  onOpen?: (target: {
    serverId: string;
    agentId: string;
    workspaceId?: string | null;
    title?: string | null;
    taskId?: string | null;
  }) => void;
}

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

function directoryBasename(dirPath: string): string {
  const trimmed = dirPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function countSessionPendingPermissions(
  session: SessionStoreState["sessions"][string] | undefined,
  agentId: string,
): number {
  if (!session) return 0;
  let count = 0;
  for (const perm of session.pendingPermissions.values()) {
    if (perm.agentId === agentId) count += 1;
  }
  return count;
}

function resolveWorkspaceDisplayName(
  session: SessionStoreState["sessions"][string] | undefined,
  workspaceId: string | null,
  cwd: string | null | undefined,
): string | null {
  const workspace = workspaceId ? session?.workspaces.get(workspaceId) : undefined;
  const label = workspace?.name?.trim() || workspace?.projectDisplayName?.trim();
  if (label) return label;
  return cwd ? directoryBasename(cwd) : null;
}

function selectHandoffLiveMeta(state: SessionStoreState, serverId: string, agentId: string) {
  const session = state.sessions[serverId];
  const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
  const pendingCount = Math.max(
    countSessionPendingPermissions(session, agentId),
    agent?.pendingPermissions.length ?? 0,
  );
  const workspaceId = agent?.workspaceId ?? null;

  return {
    title: agent?.title?.trim() || null,
    workspaceId,
    workspaceName: resolveWorkspaceDisplayName(session, workspaceId, agent?.cwd),
    bucket: derivePlanTaskLiveBucket(agent, pendingCount),
    archived: Boolean(agent?.archivedAt),
  };
}

function HandoffStatusMark({
  bucket,
  hasError,
}: {
  bucket: SidebarStateBucket | null;
  hasError: boolean;
}) {
  if (hasError) {
    return <View style={styles.dotFailed} />;
  }
  if (!bucket) {
    return <View style={styles.dotIdle} />;
  }
  if (bucket === "running") {
    return (
      <View style={styles.ringWrap}>
        <StatusRing />
      </View>
    );
  }
  switch (bucket) {
    case "needs_input":
      return <View style={styles.dotNeedsInput} />;
    case "failed":
      return <View style={styles.dotFailed} />;
    case "attention":
      return <View style={styles.dotAttention} />;
    case "done":
      return <View style={styles.dotDone} />;
  }
}

function resolveStatusTextKey(bucket: SidebarStateBucket | null, hasError: boolean): string {
  if (hasError) return "mainChat.taskStatus.startFailed";
  switch (bucket) {
    case "needs_input":
      return "mainChat.taskStatus.needsYou";
    case "failed":
      return "mainChat.taskStatus.failed";
    case "running":
      return "mainChat.taskStatus.working";
    case "attention":
    case "done":
      return "mainChat.taskStatus.done";
    default:
      return "mainChat.taskStatus.starting";
  }
}

function resolveSourceBadgeKey(sourceKind: HandoffSourceKind): string {
  switch (sourceKind) {
    case "new":
      return "mainChat.handoffCard.sourceNew";
    case "active":
      return "mainChat.handoffCard.sourceActive";
    case "resumed":
      return "mainChat.handoffCard.sourceResumed";
    case "continuation":
      return "mainChat.handoffCard.sourceContinuation";
  }
}

function buildHandoffMetaLine(input: {
  hostLabel: string | null;
  workspaceLabel: string | null;
  statusText: string;
  expectedMinutes: number | null | undefined;
  scopeRevision: number | null | undefined;
  expectedMinutesLabel: string | null;
}): string {
  const parts: string[] = [];
  if (input.hostLabel) parts.push(input.hostLabel);
  if (input.workspaceLabel) parts.push(input.workspaceLabel);
  parts.push(input.statusText);
  if (input.expectedMinutes && input.expectedMinutesLabel) {
    parts.push(input.expectedMinutesLabel);
  }
  if (input.scopeRevision && input.scopeRevision > 1) {
    parts.push(`v${input.scopeRevision}`);
  }
  return parts.join(" · ");
}

/**
 * Compact per-agent handoff card rendered inside the Main Chat stream when a plan starts or a
 * task spawns directly. Keeps the stream concise while offering live status and one-tap opening
 * in the wide-screen right `TaskPanelDrawer`.
 */
export const MainChatHandoffCard = memo(function MainChatHandoffCard({
  serverId,
  agentId,
  title,
  workspaceId,
  workspaceLabel,
  hostLabel,
  mode,
  taskId,
  sourceKind = "new",
  startError,
  expectedMinutes,
  scopeRevision,
  onOpen,
}: MainChatHandoffCardProps): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const openMainChatTaskTarget = useOpenMainChatTaskTarget();

  const live = useStoreWithEqualityFn(
    useSessionStore,
    useCallback((state) => selectHandoffLiveMeta(state, serverId, agentId), [agentId, serverId]),
    equal,
  );

  const resolvedTitle = title.trim() || live.title || agentId;
  const resolvedWorkspaceId = workspaceId ?? live.workspaceId;
  const resolvedHostLabel =
    hostLabel?.trim() || hosts.find((host) => host.serverId === serverId)?.label || null;
  const resolvedWorkspaceLabel = workspaceLabel?.trim() || live.workspaceName;
  const trimmedStartError = startError?.trim() ?? "";
  const hasStartError = trimmedStartError.length > 0;
  const statusText = hasStartError
    ? trimmedStartError
    : t(resolveStatusTextKey(live.bucket, false));
  const metaLine = buildHandoffMetaLine({
    hostLabel: resolvedHostLabel,
    workspaceLabel: resolvedWorkspaceLabel,
    statusText,
    expectedMinutes,
    scopeRevision,
    expectedMinutesLabel: expectedMinutes
      ? t("mainChat.planCard.expectedMinutesShort", { minutes: expectedMinutes })
      : null,
  });

  const handleOpen = useCallback(() => {
    const payload = {
      serverId,
      agentId,
      workspaceId: resolvedWorkspaceId,
      title: resolvedTitle,
      taskId: taskId ?? null,
    };
    if (onOpen) {
      onOpen(payload);
      return;
    }
    openMainChatTaskTarget(payload);
  }, [
    agentId,
    onOpen,
    openMainChatTaskTarget,
    resolvedTitle,
    resolvedWorkspaceId,
    serverId,
    taskId,
  ]);

  return (
    <PressHighlight
      onPress={handleOpen}
      style={styles.card}
      highlightStyle={styles.cardPressed}
      accessibilityRole="button"
      accessibilityLabel={t("mainChat.handoffCard.openInDrawerLabel", { title: resolvedTitle })}
      testID={`main-chat-handoff-card-${agentId}`}
    >
      <View style={styles.leading}>
        <ThemedCornerDownRight size={13} uniProps={mutedIconMapping} />
        <HandoffStatusMark bucket={live.bucket} hasError={hasStartError} />
      </View>

      <View style={styles.body}>
        <View style={styles.topRow}>
          <Text style={styles.title} numberOfLines={1}>
            {resolvedTitle}
          </Text>
          <StatusBadge
            size="xs"
            variant={sourceKind === "continuation" ? "warning" : "muted"}
            label={t(resolveSourceBadgeKey(sourceKind))}
          />
          {mode ? (
            <StatusBadge
              size="xs"
              variant={mode === "readonly" ? "success" : "muted"}
              label={mode === "readonly" ? t("mainChat.mode.readonly") : t("mainChat.mode.write")}
            />
          ) : null}
        </View>
        <Text
          style={[styles.meta, hasStartError && styles.metaError]}
          numberOfLines={1}
          testID={`main-chat-handoff-meta-${agentId}`}
        >
          {metaLine}
        </Text>
      </View>

      <View style={styles.openChip}>
        <ThemedPanelRight size={13} uniProps={mutedIconMapping} />
        <Text style={styles.openChipText}>{t("mainChat.handoffCard.openDrawer")}</Text>
      </View>
    </PressHighlight>
  );
});

const styles = StyleSheet.create((theme) => {
  const dot = (bucket: Exclude<SidebarStateBucket, "running">) => ({
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket, showDoneAsInactive: false }) ?? undefined,
    flexShrink: 0,
  });

  return {
    card: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      borderRadius: theme.borderRadius.lg,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
      maxWidth: 640,
      width: "100%",
    },
    cardPressed: {
      backgroundColor: theme.colors.surface2,
    },
    leading: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
      flexShrink: 0,
    },
    body: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    topRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
      flexWrap: "wrap",
    },
    title: {
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
      flexShrink: 1,
    },
    meta: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    metaError: {
      color: theme.colors.statusDanger,
    },
    openChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      paddingHorizontal: theme.spacing[2],
      paddingVertical: theme.spacing[1],
      borderRadius: theme.borderRadius.md,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
      flexShrink: 0,
    },
    openChipText: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    ringWrap: {
      width: 14,
      height: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    dotIdle: {
      width: STATUS_INDICATOR_FILLED_DOT_SIZE,
      height: STATUS_INDICATOR_FILLED_DOT_SIZE,
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.foregroundMuted,
    },
    dotNeedsInput: dot("needs_input"),
    dotFailed: dot("failed"),
    dotAttention: dot("attention"),
    dotDone: dot("done"),
  };
});
