import { router } from "expo-router";
import equal from "fast-deep-equal";
import { Ellipsis, Pencil, Radar, Settings, Shield, Sparkles, Zap } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { StatusRing } from "@/components/status-ring";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Modal } from "@/components/ui/modal";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import {
  navigateToWorkspace,
  useActiveWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import { selectMainChatSidebarSummary } from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";

const ThemedSparkles = withUnistyles(Sparkles);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedPencil = withUnistyles(Pencil);
const ThemedRadar = withUnistyles(Radar);
const ThemedSettings = withUnistyles(Settings);
const ThemedShield = withUnistyles(Shield);
const ThemedZap = withUnistyles(Zap);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const accentIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const renameIcon = <ThemedPencil size={14} uniProps={mutedIconMapping} />;
const patrolIcon = <ThemedRadar size={14} uniProps={mutedIconMapping} />;
const settingsIcon = <ThemedSettings size={14} uniProps={mutedIconMapping} />;
const conservativeIcon = <ThemedShield size={14} uniProps={mutedIconMapping} />;
const proactiveIcon = <ThemedZap size={14} uniProps={mutedIconMapping} />;

/** Returns true when at least one connected host supports the pinned Main Chat steward. */
export function useShouldShowPinnedMainChat(): boolean {
  const activeWorkspace = useActiveWorkspaceSelection();
  const preferredServerId = activeWorkspace?.serverId ?? null;
  return useSessionStore(
    useCallback(
      (state) => selectMainChatSidebarSummary(state, preferredServerId).supportsMainChat,
      [preferredServerId],
    ),
  );
}

export interface SidebarPinnedMainChatRowProps {
  onBeforeNavigate?: () => void;
}

function PinnedMainChatStatusMark({
  loading,
  running,
  needsYou,
  attention,
}: {
  loading: boolean;
  running: boolean;
  needsYou: boolean;
  attention: boolean;
}) {
  if (loading) {
    return <ThemedLoadingSpinner size="small" uniProps={mutedIconMapping} />;
  }
  if (running) {
    return (
      <View style={styles.ringWrap}>
        <StatusRing />
      </View>
    );
  }
  if (needsYou) {
    return <View style={styles.dotNeedsYou} />;
  }
  if (attention) {
    return <View style={styles.dotAttention} />;
  }
  return null;
}

const PinnedMainChatMenu = memo(function PinnedMainChatMenu({
  visible,
  open,
  onOpenChange,
  displayTitle,
  currentStyle,
  onTriggerPatrol,
  onBeginRename,
  onToggleStyle,
  onOpenSettings,
}: {
  visible: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayTitle: string;
  currentStyle: "conservative" | "proactive";
  onTriggerPatrol: () => void;
  onBeginRename: () => void;
  onToggleStyle: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={[styles.menuSlot, !visible && styles.menuSlotHidden]}>
      <DropdownMenu compactMode="sheet" open={open} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger
          hitSlop={8}
          style={styles.menuButton}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.pinnedMenuLabel")}
          testID="sidebar-pinned-main-chat-menu"
        >
          <ThemedEllipsis size={14} uniProps={mutedIconMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={220} sheetTitle={displayTitle}>
          <DropdownMenuItem
            leading={patrolIcon}
            onSelect={onTriggerPatrol}
            testID="sidebar-pinned-main-chat-patrol"
          >
            {t("mainChat.actions.triggerPatrol")}
          </DropdownMenuItem>
          <DropdownMenuItem
            leading={renameIcon}
            onSelect={onBeginRename}
            testID="sidebar-pinned-main-chat-rename"
          >
            {t("sidebar.workspace.actions.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem
            leading={currentStyle === "conservative" ? proactiveIcon : conservativeIcon}
            onSelect={onToggleStyle}
            testID="sidebar-pinned-main-chat-toggle-style"
          >
            {currentStyle === "conservative"
              ? t("mainChat.actions.switchToProactive")
              : t("mainChat.actions.switchToConservative")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            leading={settingsIcon}
            onSelect={onOpenSettings}
            testID="sidebar-pinned-main-chat-settings"
          >
            {t("mainChat.actions.openSettings")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
});

const PinnedMainChatRenameModal = memo(function PinnedMainChatRenameModal({
  visible,
  initialTitle,
  draft,
  saving,
  onChangeDraft,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  initialTitle: string;
  draft: string;
  saving: boolean;
  onChangeDraft: (text: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <PressHighlight
          style={styles.modalDismiss}
          highlightStyle={styles.modalDismiss}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("common.cancel")}
        >
          <View />
        </PressHighlight>
        <View style={styles.modalCard} testID="main-chat-rename-modal">
          <Text style={styles.modalTitle}>{t("mainChat.renameModal.title")}</Text>
          <Text style={styles.modalHint}>{t("mainChat.renameModal.hint")}</Text>
          <FormTextInput
            size="sm"
            style={styles.modalInput}
            initialValue={initialTitle}
            resetKey={visible ? `open:${initialTitle}` : "closed"}
            onChangeText={onChangeDraft}
            placeholder={t("mainChat.defaultTitle")}
            maxLength={40}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={onConfirm}
            testID="main-chat-rename-input"
          />
          <View style={styles.modalActions}>
            <Button variant="ghost" size="sm" onPress={onClose} disabled={saving}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="default"
              size="sm"
              onPress={onConfirm}
              disabled={saving || draft.trim().length === 0}
              testID="main-chat-rename-save"
            >
              {t("common.save")}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
});

function formatPinnedSubtitle(
  summary: ReturnType<typeof selectMainChatSidebarSummary>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (summary.needsYouCount > 0) {
    parts.push(t("mainChat.pinnedSubtitleNeedsYou", { count: summary.needsYouCount }));
  }
  if (summary.runningCount > 0) {
    parts.push(t("mainChat.pinnedSubtitleRunning", { count: summary.runningCount }));
  }
  if (summary.attentionCount > 0) {
    parts.push(t("mainChat.pinnedSubtitleAttention", { count: summary.attentionCount }));
  }
  if (parts.length === 0) {
    parts.push(
      summary.totalActiveCount > 0
        ? t("mainChat.pinnedSubtitleQuietActive", { count: summary.totalActiveCount })
        : t("mainChat.pinnedSubtitleIdle"),
    );
  }
  return summary.hostLabel ? `${summary.hostLabel} · ${parts.join(" · ")}` : parts.join(" · ");
}

function isStewardSelected(
  existing: ReturnType<typeof selectMainChatSidebarSummary>["existing"],
  activeWorkspace: ReturnType<typeof useActiveWorkspaceSelection>,
): boolean {
  if (!existing || !activeWorkspace) return false;
  return (
    activeWorkspace.serverId === existing.serverId &&
    activeWorkspace.workspaceId === existing.workspaceId
  );
}

function getStyleBadgeProps(
  style: "conservative" | "proactive",
  t: (key: string) => string,
): { variant: "warning" | "muted"; label: string } {
  if (style === "proactive") {
    return { variant: "warning", label: t("mainChat.style.proactiveShort") };
  }
  return { variant: "muted", label: t("mainChat.style.conservativeShort") };
}

/**
 * Permanent, non-archivable, non-unpinnable steward conversation pinned at the very top of
 * the sidebar's "Pinned" section.
 */
export const SidebarPinnedMainChatRow = memo(function SidebarPinnedMainChatRow({
  onBeforeNavigate,
}: SidebarPinnedMainChatRowProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const activeWorkspace = useActiveWorkspaceSelection();
  const preferredServerId = activeWorkspace?.serverId ?? null;

  const [isOpening, setIsOpening] = useState(false);
  const [isPatrolling, setIsPatrolling] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isRowHovered, setIsRowHovered] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [isSavingRename, setIsSavingRename] = useState(false);

  const summaryBase = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => selectMainChatSidebarSummary(state, preferredServerId),
      [preferredServerId],
    ),
    equal,
  );

  const targetServerId = summaryBase.targetServerId;
  const cachedSettings = useMainChatSettingsStore((state) =>
    targetServerId ? state.settingsByServerId[targetServerId] : undefined,
  );
  const loadSettings = useMainChatSettingsStore((state) => state.loadSettings);
  const updateSettings = useMainChatSettingsStore((state) => state.updateSettings);
  const triggerPatrol = useMainChatSettingsStore((state) => state.triggerPatrol);

  const client = useSessionStore((state) =>
    targetServerId ? (state.sessions[targetServerId]?.client ?? null) : null,
  );

  useEffect(() => {
    if (!targetServerId || !client || !summaryBase.supportsMainChat || cachedSettings) return;
    void loadSettings(targetServerId, client).catch(() => undefined);
  }, [cachedSettings, client, loadSettings, summaryBase.supportsMainChat, targetServerId]);

  const displayTitle = cachedSettings?.title?.trim() || summaryBase.displayTitle;
  const currentStyle = cachedSettings?.style ?? "conservative";
  const isSelected = isStewardSelected(summaryBase.existing, activeWorkspace);

  // Explicitly swallow workspace archive keyboard shortcut when the steward is selected.
  useKeyboardActionHandler({
    handlerId: "main-chat-archive-guard",
    actions: ["workspace.archive"],
    enabled: isSelected,
    priority: 100,
    handle: () => {
      toast.show(t("mainChat.cannotArchive"), { variant: "info" });
      return true;
    },
  });

  const handleOpen = useCallback(() => {
    if (isOpening) return;
    if (summaryBase.existing) {
      onBeforeNavigate?.();
      navigateToWorkspace({
        serverId: summaryBase.existing.serverId,
        workspaceId: summaryBase.existing.workspaceId,
        target: { kind: "agent", agentId: summaryBase.existing.agentId },
      });
      return;
    }

    if (!targetServerId || !client) return;
    setIsOpening(true);
    void (async () => {
      try {
        const result = await client.ensureMainChat();
        if (result.error || !result.agentId || !result.workspaceId) {
          toast.error(result.error ?? t("mainChat.openFailed"));
          return;
        }
        onBeforeNavigate?.();
        navigateToWorkspace({
          serverId: targetServerId,
          workspaceId: result.workspaceId,
          target: { kind: "agent", agentId: result.agentId },
        });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.openFailed"));
      } finally {
        setIsOpening(false);
      }
    })();
  }, [client, isOpening, onBeforeNavigate, summaryBase.existing, t, targetServerId, toast]);

  const handleBeginRename = useCallback(() => {
    setRenameDraft(displayTitle);
    setRenameModalOpen(true);
  }, [displayTitle]);

  const handleCloseRenameModal = useCallback(() => {
    setRenameModalOpen(false);
  }, []);

  const handleRowMouseEnter = useCallback(() => {
    setIsRowHovered(true);
  }, []);

  const handleRowMouseLeave = useCallback(() => {
    setIsRowHovered(false);
  }, []);

  const handleConfirmRename = useCallback(() => {
    const trimmed = renameDraft.trim();
    if (!trimmed || !targetServerId || !client || isSavingRename) return;
    setIsSavingRename(true);
    void updateSettings(targetServerId, { title: trimmed }, client)
      .then(() => {
        setRenameModalOpen(false);
        toast.show(t("mainChat.settings.renamedToast", { title: trimmed }), {
          variant: "success",
        });
        return trimmed;
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
      })
      .finally(() => {
        setIsSavingRename(false);
      });
  }, [client, isSavingRename, renameDraft, t, targetServerId, toast, updateSettings]);

  const handleTriggerPatrol = useCallback(() => {
    if (!targetServerId || !client || isPatrolling) return;
    setIsPatrolling(true);
    void (async () => {
      try {
        let mainAgentId = summaryBase.existing?.agentId;
        if (!mainAgentId) {
          const ensured = await client.ensureMainChat();
          mainAgentId = ensured.agentId ?? undefined;
        }
        const result = await triggerPatrol(targetServerId, client, {
          mainAgentId,
          forceWakeup: true,
        });
        toast.show(result.summary, { variant: "success" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.patrolFailed"));
      } finally {
        setIsPatrolling(false);
      }
    })();
  }, [
    client,
    isPatrolling,
    summaryBase.existing?.agentId,
    t,
    targetServerId,
    toast,
    triggerPatrol,
  ]);

  const handleToggleStyle = useCallback(() => {
    if (!targetServerId || !client) return;
    const nextStyle = currentStyle === "conservative" ? "proactive" : "conservative";
    void updateSettings(targetServerId, { applyPreset: nextStyle }, client)
      .then(() => {
        toast.show(
          nextStyle === "proactive"
            ? t("mainChat.settings.switchedProactiveToast")
            : t("mainChat.settings.switchedConservativeToast"),
          { variant: "success" },
        );
        return nextStyle;
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
      });
  }, [client, currentStyle, t, targetServerId, toast, updateSettings]);

  const handleOpenSettings = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSettingsSectionRoute("main-chat"));
  }, [onBeforeNavigate]);

  const subtitle = useMemo(() => formatPinnedSubtitle(summaryBase, t), [summaryBase, t]);

  if (!summaryBase.supportsMainChat) {
    return null;
  }

  const showMenuButton = isRowHovered || isMenuOpen || isSelected;
  const styleBadge = getStyleBadgeProps(currentStyle, t);
  const isBusy = isOpening || isPatrolling;
  const isRunning = summaryBase.isMainRunning || summaryBase.runningCount > 0;

  return (
    <>
      <View
        style={styles.outer}
        // @ts-expect-error react-native-web hover handlers
        onMouseEnter={handleRowMouseEnter}
        onMouseLeave={handleRowMouseLeave}
      >
        <PressHighlight
          onPress={handleOpen}
          style={[styles.row, isSelected && styles.rowSelected]}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={displayTitle}
          testID="sidebar-pinned-main-chat"
        >
          <View style={styles.iconBadge}>
            <ThemedSparkles size={14} uniProps={accentIconMapping} />
          </View>

          <View style={styles.body}>
            <View style={styles.titleLine}>
              <Text
                style={[styles.title, isSelected && styles.titleSelected]}
                numberOfLines={1}
                testID="sidebar-pinned-main-chat-title"
              >
                {displayTitle}
              </Text>
              <StatusBadge size="xs" variant={styleBadge.variant} label={styleBadge.label} />
            </View>
            <Text style={styles.subtitle} numberOfLines={1}>
              {subtitle}
            </Text>
          </View>

          <View style={styles.trailing}>
            <PinnedMainChatStatusMark
              loading={isBusy}
              running={isRunning}
              needsYou={summaryBase.needsYouCount > 0}
              attention={summaryBase.attentionCount > 0}
            />
            <PinnedMainChatMenu
              visible={showMenuButton}
              open={isMenuOpen}
              onOpenChange={setIsMenuOpen}
              displayTitle={displayTitle}
              currentStyle={currentStyle}
              onTriggerPatrol={handleTriggerPatrol}
              onBeginRename={handleBeginRename}
              onToggleStyle={handleToggleStyle}
              onOpenSettings={handleOpenSettings}
            />
          </View>
        </PressHighlight>
      </View>

      <PinnedMainChatRenameModal
        visible={renameModalOpen}
        initialTitle={displayTitle}
        draft={renameDraft}
        saving={isSavingRename}
        onChangeDraft={setRenameDraft}
        onClose={handleCloseRenameModal}
        onConfirm={handleConfirmRename}
      />
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  outer: {
    marginBottom: 2,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
  },
  rowSelected: {
    backgroundColor: theme.colors.surface2,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  iconBadge: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  body: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  title: {
    flexShrink: 1,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  titleSelected: {
    fontWeight: theme.fontWeight.semibold,
  },
  subtitle: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  ringWrap: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  dotNeedsYou: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: theme.colors.statusWarning,
  },
  dotAttention: {
    width: 7,
    height: 7,
    borderRadius: 999,
    backgroundColor: theme.colors.statusSuccess,
  },
  menuSlot: {
    opacity: 1,
  },
  menuSlotHidden: {
    opacity: 0.45,
  },
  menuButton: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0, 0, 0, 0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[4],
  },
  modalDismiss: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  modalCard: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
  },
  modalTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  modalHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  modalInput: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
