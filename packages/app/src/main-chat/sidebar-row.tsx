import equal from "fast-deep-equal";
import { Sparkles } from "lucide-react-native";
import { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { SidebarHeaderRow } from "@/components/sidebar/sidebar-header-row";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { builtinSidebarNavLabelKey } from "@/sidebar-nav/model";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { selectMainChatSidebarSummary } from "./selectors";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const mutedSpinnerMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface SidebarMainChatRowProps {
  onBeforeNavigate?: () => void;
}

export const SidebarMainChatRow = memo(function SidebarMainChatRow({
  onBeforeNavigate,
}: SidebarMainChatRowProps) {
  const { t } = useTranslation();
  const [isOpening, setIsOpening] = useState(false);
  const activeWorkspace = useActiveWorkspaceSelection();
  const preferredServerId = activeWorkspace?.serverId ?? null;

  const summary = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => selectMainChatSidebarSummary(state, preferredServerId),
      [preferredServerId],
    ),
    equal,
  );

  const isActive = Boolean(
    summary.existing &&
    activeWorkspace?.serverId === summary.existing.serverId &&
    activeWorkspace.workspaceId === summary.existing.workspaceId,
  );

  const handlePress = useCallback(() => {
    if (isOpening) return;
    if (summary.existing) {
      onBeforeNavigate?.();
      navigateToWorkspace({
        serverId: summary.existing.serverId,
        workspaceId: summary.existing.workspaceId,
        target: { kind: "agent", agentId: summary.existing.agentId },
      });
      return;
    }

    const targetServerId = summary.targetServerId;
    if (!targetServerId) return;
    const client = useSessionStore.getState().sessions[targetServerId]?.client;
    if (!client) return;

    setIsOpening(true);
    void (async () => {
      try {
        const result = await client.ensureMainChat();
        if (result.error || !result.agentId || !result.workspaceId) {
          return;
        }
        onBeforeNavigate?.();
        navigateToWorkspace({
          serverId: targetServerId,
          workspaceId: result.workspaceId,
          target: { kind: "agent", agentId: result.agentId },
        });
      } catch {
        // Ignore transient network errors; the user can retry from the sidebar row.
      } finally {
        setIsOpening(false);
      }
    })();
  }, [isOpening, onBeforeNavigate, summary.existing, summary.targetServerId]);

  let trailing = null;
  if (isOpening) {
    trailing = (
      <View style={styles.trailingWrap}>
        <ThemedLoadingSpinner size="small" uniProps={mutedSpinnerMapping} />
      </View>
    );
  } else if (summary.needsYouCount > 0) {
    trailing = (
      <StatusBadge
        variant="warning"
        size="xs"
        label={t("mainChat.sidebarBadgeNeedsYou", { count: summary.needsYouCount })}
      />
    );
  } else if (summary.runningCount > 0) {
    trailing = (
      <StatusBadge
        variant="muted"
        size="xs"
        label={t("mainChat.sidebarBadgeRunning", { count: summary.runningCount })}
      />
    );
  }

  return (
    <SidebarHeaderRow
      icon={Sparkles}
      label={t(builtinSidebarNavLabelKey("main-chat"))}
      onPress={handlePress}
      isActive={isActive}
      testID="sidebar-main-chat"
      variant="compact"
      trailing={trailing}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  trailingWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
}));
