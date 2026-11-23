import equal from "fast-deep-equal";
import { Maximize2, X } from "lucide-react-native";
import { memo, useCallback, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { StatusRing } from "@/components/status-ring";
import { PressHighlight } from "@/components/ui/press-highlight";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import { MainChatAgentHost } from "./agent-host";
import type { MainChatDrawerTarget } from "./drawer-store";
import { useMainChatDrawerStore } from "./drawer-store";
import { useOpenMainChatTaskTarget } from "./open-task-target";
import { derivePlanTaskLiveBucket } from "./selectors";

const ThemedMaximize = withUnistyles(Maximize2);
const ThemedX = withUnistyles(X);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface TaskPanelDrawerProps {
  target: MainChatDrawerTarget;
  isFocused: boolean;
  onFocus: () => void;
}

function directoryBasename(dirPath: string): string {
  const trimmed = dirPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

function countPendingPermissionsForAgent(
  session: SessionStoreState["sessions"][string] | undefined,
  agentId: string,
  agentPendingCount: number,
): number {
  if (!session) return agentPendingCount;
  let counted = 0;
  for (const perm of session.pendingPermissions.values()) {
    if (perm.agentId === agentId) counted += 1;
  }
  return Math.max(counted, agentPendingCount);
}

function resolveDrawerWorkspaceName(
  session: SessionStoreState["sessions"][string] | undefined,
  workspaceId: string | null,
  agentCwd: string | undefined,
): string | null {
  const workspace = workspaceId ? session?.workspaces.get(workspaceId) : undefined;
  const trimmedName = workspace?.name?.trim();
  if (trimmedName) return trimmedName;
  const trimmedProject = workspace?.projectDisplayName?.trim();
  if (trimmedProject) return trimmedProject;
  return agentCwd ? directoryBasename(agentCwd) : null;
}

function selectDrawerAgentMeta(state: SessionStoreState, target: MainChatDrawerTarget) {
  const session = state.sessions[target.serverId];
  const agent = session?.agents.get(target.agentId) ?? session?.agentDetails.get(target.agentId);
  const pendingCount = countPendingPermissionsForAgent(
    session,
    target.agentId,
    agent?.pendingPermissions.length ?? 0,
  );
  const workspaceId = agent?.workspaceId ?? target.workspaceId ?? null;
  return {
    title: agent?.title?.trim() || target.title || null,
    workspaceId,
    workspaceName: resolveDrawerWorkspaceName(session, workspaceId, agent?.cwd),
    bucket: derivePlanTaskLiveBucket(agent, pendingCount),
  };
}

function DrawerStatusMark({ bucket }: { bucket: SidebarStateBucket | null }) {
  if (!bucket) return <View style={styles.dotDone} />;
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

/**
 * Wide-screen side-by-side task inspection drawer rendered beside the Main Chat column.
 * Mounts the selected child agent directly via `MainChatAgentHost` with one-tap full-page promotion.
 */
export const TaskPanelDrawer = memo(function TaskPanelDrawer({
  target,
  isFocused,
  onFocus,
}: TaskPanelDrawerProps): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const closeDrawer = useMainChatDrawerStore((state) => state.closeDrawer);
  const openTask = useMainChatDrawerStore((state) => state.openTask);
  const openMainChatTaskTarget = useOpenMainChatTaskTarget();

  const agentMeta = useStoreWithEqualityFn(
    useSessionStore,
    useCallback((state) => selectDrawerAgentMeta(state, target), [target]),
    equal,
  );

  const hostLabel =
    hosts.find((host) => host.serverId === target.serverId)?.label ?? target.serverId;
  const resolvedTitle = agentMeta.title || t("mainChat.drawer.titleFallback");
  const subtitle = agentMeta.workspaceName
    ? `${hostLabel} · ${agentMeta.workspaceName}`
    : hostLabel;
  const resolvedWorkspaceId = agentMeta.workspaceId ?? "";

  const handleOpenFullPage = useCallback(() => {
    openMainChatTaskTarget({
      serverId: target.serverId,
      agentId: target.agentId,
      workspaceId: agentMeta.workspaceId,
      title: resolvedTitle,
      forceFullPage: true,
    });
  }, [
    agentMeta.workspaceId,
    openMainChatTaskTarget,
    resolvedTitle,
    target.agentId,
    target.serverId,
  ]);

  const handleOpenNestedAgent = useCallback(
    (next: { serverId: string; agentId: string }) => {
      openTask({ serverId: next.serverId, agentId: next.agentId });
    },
    [openTask],
  );

  return (
    <View style={styles.drawer} testID="main-chat-task-drawer">
      <View style={styles.header} testID="main-chat-task-drawer-header">
        <View style={styles.headerLeft}>
          <DrawerStatusMark bucket={agentMeta.bucket} />
          <View style={styles.titleBlock}>
            <Text style={styles.title} numberOfLines={1} testID="main-chat-task-drawer-title">
              {resolvedTitle}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1} testID="main-chat-task-drawer-subtitle">
              {subtitle}
            </Text>
          </View>
        </View>

        <View style={styles.headerActions}>
          <PressHighlight
            onPress={handleOpenFullPage}
            style={styles.fullPageButton}
            highlightStyle={styles.actionPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.drawer.openFullPage")}
            testID="main-chat-task-drawer-open-full-page"
          >
            <ThemedMaximize size={13} uniProps={mutedIconMapping} />
            <Text style={styles.fullPageLabel} numberOfLines={1}>
              {t("mainChat.drawer.openFullPage")}
            </Text>
          </PressHighlight>
          <PressHighlight
            onPress={closeDrawer}
            style={styles.closeButton}
            highlightStyle={styles.actionPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.drawer.close")}
            testID="main-chat-task-drawer-close"
          >
            <ThemedX size={15} uniProps={mutedIconMapping} />
          </PressHighlight>
        </View>
      </View>

      <View style={styles.body}>
        <MainChatAgentHost
          key={`${target.serverId}:${target.agentId}`}
          sourceId={`main-chat-drawer:${target.serverId}:${target.agentId}`}
          serverId={target.serverId}
          workspaceId={resolvedWorkspaceId}
          agentId={target.agentId}
          isFocused={isFocused}
          onFocusPane={onFocus}
          onOpenAgentTarget={handleOpenNestedAgent}
        />
      </View>
    </View>
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
    drawer: {
      width: "42%",
      minWidth: 340,
      maxWidth: 640,
      borderLeftWidth: theme.borderWidth[1],
      borderLeftColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
      flexDirection: "column",
      minHeight: 0,
    },
    header: {
      height: HEADER_INNER_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    headerLeft: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    titleBlock: {
      flex: 1,
      minWidth: 0,
      gap: 1,
    },
    title: {
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
    },
    subtitle: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      flexShrink: 0,
    },
    fullPageButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      paddingHorizontal: theme.spacing[2],
      paddingVertical: theme.spacing[1],
      borderRadius: theme.borderRadius.md,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
    },
    fullPageLabel: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    closeButton: {
      width: 28,
      height: 28,
      borderRadius: theme.borderRadius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    actionPressed: {
      backgroundColor: theme.colors.surface2,
    },
    body: {
      flex: 1,
      minHeight: 0,
      minWidth: 0,
    },
    ringWrap: {
      width: 14,
      height: 14,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    dotNeedsInput: dot("needs_input"),
    dotFailed: dot("failed"),
    dotAttention: dot("attention"),
    dotDone: dot("done"),
  };
});
