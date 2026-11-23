import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { router, usePathname } from "expo-router";
import equal from "fast-deep-equal";
import {
  Ellipsis,
  History,
  Pencil,
  Radar,
  Settings,
  Shield,
  Sparkles,
  Zap,
} from "lucide-react-native";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
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
import { Shortcut } from "@/components/ui/shortcut";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import {
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import {
  buildMainChatHistoryRoute,
  buildMainChatRoute,
  buildSettingsSectionRoute,
  isMainChatPathname,
} from "@/utils/host-routes";
import {
  MainChatLifecycleConfirmModal,
  MainChatLifecycleMenuItems,
  useMainChatLifecycleActions,
} from "./lifecycle-actions";
import { selectMainChatSidebarSummary } from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";

const ThemedSparkles = withUnistyles(Sparkles);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedHistory = withUnistyles(History);
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
const historyIcon = <ThemedHistory size={14} uniProps={mutedIconMapping} />;
const settingsIcon = <ThemedSettings size={14} uniProps={mutedIconMapping} />;
const conservativeIcon = <ThemedShield size={14} uniProps={mutedIconMapping} />;
const proactiveIcon = <ThemedZap size={14} uniProps={mutedIconMapping} />;

const SELECTED_STATE = { selected: true } as const;
const ARCHIVE_GUARD_ACTIONS = ["workspace.archive"] as const;

/** Returns true when at least one connected host supports the sticky Main Chat hero entry. */
export function useShouldShowMainChatHero(): boolean {
  const activeWorkspace = useActiveWorkspaceSelection();
  const lastWorkspace = useLastWorkspaceSelection();
  const preferredServerId = activeWorkspace?.serverId ?? lastWorkspace?.serverId ?? null;
  return useSessionStore(
    useCallback(
      (state) => selectMainChatSidebarSummary(state, preferredServerId).supportsMainChat,
      [preferredServerId],
    ),
  );
}

export interface MainChatHeroRowProps {
  onBeforeNavigate?: () => void;
  /** Optional mobile trailing control (e.g. sidebar close button) aligned beside the hero row. */
  trailingAccessory?: ReactNode;
  /** Reserved extension slot for M2 lifecycle menu actions (compress / clear / new main chat). */
  extraMenuItems?: ReactNode;
}

function HeroStatusMark({
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
  return <View style={styles.dotIdle} />;
}

const HeroRowContent = memo(function HeroRowContent({
  displayTitle,
  isSelected,
  isPatrolling,
  isRunning,
  needsYouCount,
  attentionCount,
  hasUnsentDraft,
  secondLineText,
}: {
  displayTitle: string;
  isSelected: boolean;
  isPatrolling: boolean;
  isRunning: boolean;
  needsYouCount: number;
  attentionCount: number;
  hasUnsentDraft: boolean;
  secondLineText: string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <View style={[styles.iconBadge, isSelected && styles.iconBadgeSelected]}>
        <ThemedSparkles size={15} uniProps={accentIconMapping} />
        <View style={styles.iconStatusOverlay}>
          <HeroStatusMark
            loading={isPatrolling}
            running={isRunning}
            needsYou={needsYouCount > 0}
            attention={attentionCount > 0}
          />
        </View>
      </View>

      <View style={styles.body}>
        <View style={styles.titleLine}>
          <Text
            style={[styles.title, isSelected && styles.titleSelected]}
            numberOfLines={1}
            testID="sidebar-main-chat-hero-title"
          >
            {displayTitle}
          </Text>
          {needsYouCount > 0 ? (
            <View testID="sidebar-main-chat-hero-needs-you">
              <StatusBadge
                size="xs"
                variant="warning"
                label={t("mainChat.hero.needsYouBadge", { count: needsYouCount })}
              />
            </View>
          ) : null}
        </View>
        <Text
          style={[styles.subtitle, hasUnsentDraft && styles.draftSubtitle]}
          numberOfLines={1}
          testID={
            hasUnsentDraft ? "sidebar-main-chat-hero-draft" : "sidebar-main-chat-hero-subtitle"
          }
        >
          {secondLineText}
        </Text>
      </View>
    </>
  );
});

const MainChatHeroMenu = memo(function MainChatHeroMenu({
  visible,
  open,
  onOpenChange,
  displayTitle,
  currentStyle,
  canRunLifecycle,
  onTriggerPatrol,
  onOpenHistory,
  onBeginRename,
  onToggleStyle,
  onCompact,
  onClear,
  onNewSession,
  onOpenSettings,
  extraMenuItems,
}: {
  visible: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  displayTitle: string;
  currentStyle: "conservative" | "proactive";
  canRunLifecycle: boolean;
  onTriggerPatrol: () => void;
  onOpenHistory: () => void;
  onBeginRename: () => void;
  onToggleStyle: () => void;
  onCompact: () => void;
  onClear: () => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  extraMenuItems?: ReactNode;
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
          testID="sidebar-main-chat-hero-menu"
        >
          <ThemedEllipsis size={14} uniProps={mutedIconMapping} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" width={248} sheetTitle={displayTitle}>
          <DropdownMenuItem
            leading={patrolIcon}
            onSelect={onTriggerPatrol}
            testID="sidebar-main-chat-hero-patrol"
          >
            {t("mainChat.actions.triggerPatrol")}
          </DropdownMenuItem>
          <DropdownMenuItem
            leading={historyIcon}
            onSelect={onOpenHistory}
            testID="sidebar-main-chat-hero-history"
          >
            {t("mainChat.hero.viewHistory")}
          </DropdownMenuItem>
          <DropdownMenuItem
            leading={renameIcon}
            onSelect={onBeginRename}
            testID="sidebar-main-chat-hero-rename"
          >
            {t("sidebar.workspace.actions.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem
            leading={currentStyle === "conservative" ? proactiveIcon : conservativeIcon}
            onSelect={onToggleStyle}
            testID="sidebar-main-chat-hero-toggle-style"
          >
            {currentStyle === "conservative"
              ? t("mainChat.actions.switchToProactive")
              : t("mainChat.actions.switchToConservative")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <MainChatLifecycleMenuItems
            testIdPrefix="sidebar-main-chat-hero"
            disabled={!canRunLifecycle}
            onCompact={onCompact}
            onClear={onClear}
            onNewSession={onNewSession}
          />
          {extraMenuItems ? (
            <>
              <DropdownMenuSeparator />
              {extraMenuItems}
            </>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            leading={settingsIcon}
            onSelect={onOpenSettings}
            testID="sidebar-main-chat-hero-settings"
          >
            {t("mainChat.actions.openSettings")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
  );
});

const MainChatRenameModal = memo(function MainChatRenameModal({
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

function formatHeroSubtitle(
  summary: ReturnType<typeof selectMainChatSidebarSummary>,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (summary.runningCount > 0) {
    parts.push(t("mainChat.pinnedSubtitleRunning", { count: summary.runningCount }));
  }
  if (summary.attentionCount > 0) {
    parts.push(t("mainChat.pinnedSubtitleAttention", { count: summary.attentionCount }));
  }
  if (parts.length > 0) {
    return parts.join(" · ");
  }
  if (summary.needsYouCount > 0) {
    return t("mainChat.pinnedSubtitleNeedsYou", { count: summary.needsYouCount });
  }
  return summary.totalActiveCount > 0
    ? t("mainChat.pinnedSubtitleQuietActive", { count: summary.totalActiveCount })
    : t("mainChat.pinnedSubtitleIdle");
}

function useMainChatHeroActions(input: {
  targetServerId: string | null;
  client: DaemonClient | null;
  existingAgentId: string | undefined;
  displayTitle: string;
  currentStyle: "conservative" | "proactive";
}) {
  const { targetServerId, client, existingAgentId, displayTitle, currentStyle } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const updateSettings = useMainChatSettingsStore((state) => state.updateSettings);
  const triggerPatrol = useMainChatSettingsStore((state) => state.triggerPatrol);

  const [isPatrolling, setIsPatrolling] = useState(false);
  const [renameModalOpen, setRenameModalOpen] = useState(false);
  const [renameDraft, setRenameDraft] = useState("");
  const [isSavingRename, setIsSavingRename] = useState(false);

  const beginRename = useCallback(() => {
    setRenameDraft(displayTitle);
    setRenameModalOpen(true);
  }, [displayTitle]);

  const closeRenameModal = useCallback(() => {
    setRenameModalOpen(false);
  }, []);

  const confirmRename = useCallback(() => {
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

  const runPatrol = useCallback(() => {
    if (!targetServerId || !client || isPatrolling) return;
    setIsPatrolling(true);
    void (async () => {
      try {
        let mainAgentId = existingAgentId;
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
  }, [client, existingAgentId, isPatrolling, t, targetServerId, toast, triggerPatrol]);

  const toggleStyle = useCallback(() => {
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

  return {
    isPatrolling,
    renameModalOpen,
    renameDraft,
    isSavingRename,
    setRenameDraft,
    beginRename,
    closeRenameModal,
    confirmRename,
    runPatrol,
    toggleStyle,
  };
}

function useMainChatHeroData() {
  const activeWorkspace = useActiveWorkspaceSelection();
  const lastWorkspace = useLastWorkspaceSelection();
  const preferredServerId = activeWorkspace?.serverId ?? lastWorkspace?.serverId ?? null;

  const summaryBase = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => selectMainChatSidebarSummary(state, preferredServerId),
      [preferredServerId],
    ),
    equal,
  );

  const targetServerId = summaryBase.targetServerId;
  const client = useSessionStore((state) =>
    targetServerId ? (state.sessions[targetServerId]?.client ?? null) : null,
  );
  const settings = useMainChatSettingsStore((state) =>
    targetServerId ? state.settingsByServerId[targetServerId] : undefined,
  );
  const loadSettings = useMainChatSettingsStore((state) => state.loadSettings);

  useEffect(() => {
    if (!targetServerId || !client || !summaryBase.supportsMainChat || settings) return;
    void loadSettings(targetServerId, client);
  }, [client, loadSettings, settings, summaryBase.supportsMainChat, targetServerId]);

  const draftKey = summaryBase.existing
    ? buildDraftStoreKey({
        serverId: summaryBase.existing.serverId,
        agentId: summaryBase.existing.agentId,
      })
    : null;
  const unsentDraftText = useDraftStore((state) => {
    if (!draftKey) return "";
    const record = state.drafts[draftKey];
    if (record?.lifecycle !== "active") return "";
    return record.input.text.replace(/\s+/g, " ").trim();
  });

  return {
    summaryBase,
    targetServerId,
    client,
    unsentDraftText,
    displayTitle: settings?.title?.trim() || summaryBase.displayTitle,
    currentStyle: settings?.style ?? ("conservative" as const),
  };
}

/**
 * Sticky, non-collapsible top-of-sidebar entry for the primary Main Chat assistant.
 * Lives outside `Pinned` and `Workspaces` so it never scrolls away or collapses with coding rooms.
 */
export const MainChatHeroRow = memo(function MainChatHeroRow({
  onBeforeNavigate,
  trailingAccessory,
  extraMenuItems,
}: MainChatHeroRowProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const pathname = usePathname();
  const isCompact = useIsCompactFormFactor();
  const shortcutKeys = useShortcutKeys("open-main-chat");

  const [isRowHovered, setIsRowHovered] = useState(false);
  const [isRowPressed, setIsRowPressed] = useState(false);

  const { summaryBase, targetServerId, client, unsentDraftText, displayTitle, currentStyle } =
    useMainChatHeroData();
  const isSelected = isMainChatPathname(pathname);

  const actions = useMainChatHeroActions({
    targetServerId,
    client,
    existingAgentId: summaryBase.existing?.agentId,
    displayTitle,
    currentStyle,
  });
  const lifecycle = useMainChatLifecycleActions({
    serverId: targetServerId,
    client,
    mainAgentId: summaryBase.existing?.agentId,
    navigateToMainOnSwitch: !isSelected,
    onBeforeNavigate,
  });

  useKeyboardActionHandler({
    handlerId: "main-chat-archive-guard",
    actions: ARCHIVE_GUARD_ACTIONS,
    priority: 100,
    enabled: isSelected,
    handle: () => {
      toast.show(t("mainChat.cannotArchive"), { variant: "info" });
      return true;
    },
  });

  const handleOpen = useCallback(() => {
    onBeforeNavigate?.();
    if (pathname === buildMainChatRoute()) return;
    router.push(buildMainChatRoute());
  }, [onBeforeNavigate, pathname]);

  const handleOpenHistory = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildMainChatHistoryRoute());
  }, [onBeforeNavigate]);

  const handleOpenSettings = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSettingsSectionRoute("main-chat"));
  }, [onBeforeNavigate]);

  const handlePointerEnter = useCallback(() => setIsRowHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsRowHovered(false), []);
  const handlePressIn = useCallback(() => setIsRowPressed(true), []);
  const handlePressOut = useCallback(() => setIsRowPressed(false), []);

  const { showKebab, menuProps } = useOpenKebabMenuVisibility(
    isRowHovered || isNative || isCompact || isSelected,
  );

  const subtitle = useMemo(() => formatHeroSubtitle(summaryBase, t), [summaryBase, t]);

  if (!summaryBase.supportsMainChat) {
    return null;
  }

  const hasUnsentDraft = unsentDraftText.length > 0;
  const secondLineText = hasUnsentDraft
    ? t("mainChat.hero.draftPreview", { text: unsentDraftText })
    : subtitle;
  const isRunning = summaryBase.isMainRunning || summaryBase.runningCount > 0;
  const isHighlighted = isSelected || isRowHovered;

  return (
    <>
      <View style={styles.stickyWrapper} testID="sidebar-main-chat-hero-container">
        <View style={styles.heroLine}>
          <View
            style={[
              styles.rowEnvelope,
              isHighlighted && styles.rowHighlighted,
              isSelected && styles.rowSelected,
              isRowPressed && styles.rowPressed,
            ]}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
          >
            <PressHighlight
              onPress={handleOpen}
              onPressIn={handlePressIn}
              onPressOut={handlePressOut}
              style={styles.mainButton}
              highlightStyle={styles.mainButtonPressed}
              accessibilityRole="button"
              accessibilityLabel={t("mainChat.hero.openMainChatLabel", { title: displayTitle })}
              accessibilityState={isSelected ? SELECTED_STATE : undefined}
              testID="sidebar-main-chat-hero"
            >
              <HeroRowContent
                displayTitle={displayTitle}
                isSelected={isSelected}
                isPatrolling={actions.isPatrolling}
                isRunning={isRunning}
                needsYouCount={summaryBase.needsYouCount}
                attentionCount={summaryBase.attentionCount}
                hasUnsentDraft={hasUnsentDraft}
                secondLineText={secondLineText}
              />
            </PressHighlight>

            <View style={styles.trailing}>
              {shortcutKeys ? (
                <View style={styles.shortcutSlot}>
                  <Shortcut chord={shortcutKeys} />
                </View>
              ) : null}
              <MainChatHeroMenu
                visible={showKebab}
                open={menuProps.open}
                onOpenChange={menuProps.onOpenChange}
                displayTitle={displayTitle}
                currentStyle={currentStyle}
                canRunLifecycle={lifecycle.canRunLifecycle}
                onTriggerPatrol={actions.runPatrol}
                onOpenHistory={handleOpenHistory}
                onBeginRename={actions.beginRename}
                onToggleStyle={actions.toggleStyle}
                onCompact={lifecycle.triggerCompact}
                onClear={lifecycle.requestClear}
                onNewSession={lifecycle.requestNewSession}
                onOpenSettings={handleOpenSettings}
                extraMenuItems={extraMenuItems}
              />
            </View>
          </View>
          {trailingAccessory ? <View style={styles.accessorySlot}>{trailingAccessory}</View> : null}
        </View>
      </View>
      <SidebarSeparator testID="sidebar-main-chat-hero-separator" />

      <MainChatRenameModal
        visible={actions.renameModalOpen}
        initialTitle={displayTitle}
        draft={actions.renameDraft}
        saving={actions.isSavingRename}
        onChangeDraft={actions.setRenameDraft}
        onClose={actions.closeRenameModal}
        onConfirm={actions.confirmRename}
      />

      <MainChatLifecycleConfirmModal
        confirmKind={lifecycle.confirmKind}
        busy={lifecycle.busyAction !== null}
        onCancel={lifecycle.cancelConfirm}
        onConfirm={lifecycle.confirmPendingAction}
      />
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  stickyWrapper: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1.5],
    paddingBottom: theme.spacing[2],
  },
  heroLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  rowEnvelope: {
    position: "relative",
    flex: 1,
    minWidth: 0,
    minHeight: 52,
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowSelected: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  mainButton: {
    flex: 1,
    minWidth: 0,
    minHeight: 50,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.lg,
  },
  mainButtonPressed: {
    backgroundColor: "transparent",
  },
  iconBadge: {
    position: "relative",
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface3,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  iconBadgeSelected: {
    backgroundColor: theme.colors.surface1,
  },
  iconStatusOverlay: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 12,
    height: 12,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surfaceSidebar,
    alignItems: "center",
    justifyContent: "center",
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
    fontSize: theme.fontSize.base,
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
  draftSubtitle: {
    color: theme.colors.primary,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[1.5],
    flexShrink: 0,
  },
  shortcutSlot: {
    flexShrink: 0,
  },
  ringWrap: {
    width: 11,
    height: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  dotNeedsYou: {
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusWarning,
  },
  dotAttention: {
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusSuccess,
  },
  dotIdle: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  menuSlot: {
    opacity: 1,
    pointerEvents: "auto",
  },
  menuSlotHidden: {
    opacity: 0,
    pointerEvents: "none",
  },
  menuButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  accessorySlot: {
    flexShrink: 0,
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
    borderWidth: theme.borderWidth[1],
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
    borderWidth: theme.borderWidth[1],
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
