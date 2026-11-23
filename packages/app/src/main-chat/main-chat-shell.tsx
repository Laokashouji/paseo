import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { router } from "expo-router";
import {
  ArrowLeft,
  Compass,
  Ellipsis,
  History,
  PanelRight,
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarMenuToggle } from "@/components/headers/sidebar-menu-toggle";
import { StatusRing } from "@/components/status-ring";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import {
  buildMainChatHistoryRoute,
  buildMainChatRoute,
  buildSettingsSectionRoute,
} from "@/utils/host-routes";
import { useMainChatCameFromStore } from "./came-from-store";
import { MainChatCompactionBanner } from "./compaction-banner";
import { useMainChatDrawerStore } from "./drawer-store";
import {
  MainChatLifecycleConfirmModal,
  MainChatLifecycleMenuItems,
  useMainChatLifecycleActions,
} from "./lifecycle-actions";
import { selectMainChatDockTasks } from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";
import { MainChatShellProvider } from "./shell-context";
import { TaskPanelDrawer } from "./task-panel-drawer";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedCompass = withUnistyles(Compass);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedHistory = withUnistyles(History);
const ThemedPanelRight = withUnistyles(PanelRight);
const ThemedRadar = withUnistyles(Radar);
const ThemedSettings = withUnistyles(Settings);
const ThemedShield = withUnistyles(Shield);
const ThemedSparkles = withUnistyles(Sparkles);
const ThemedZap = withUnistyles(Zap);

const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

const patrolMenuIcon = <ThemedRadar size={14} uniProps={mutedIconMapping} />;
const drawerMenuIcon = <ThemedPanelRight size={14} uniProps={mutedIconMapping} />;
const historyMenuIcon = <ThemedHistory size={14} uniProps={mutedIconMapping} />;
const settingsMenuIcon = <ThemedSettings size={14} uniProps={mutedIconMapping} />;

export interface MainChatShellProps {
  variant: "main" | "conversation";
  title: string;
  serverId: string | null;
  mainAgentId?: string | null;
  originRoute: string;
  isRunning?: boolean;
  needsYouCount?: number;
  runningCount?: number;
  onActivePaneChange?: (pane: "main" | "drawer") => void;
  activePane?: "main" | "drawer";
  extraMenuItems?: ReactNode;
  children: ReactNode;
}

const ShellHeaderLeft = memo(function ShellHeaderLeft({
  variant,
  title,
  isCompact,
  showAvatar,
  isActiveRunning,
  needsYouCount,
  onBackToMain,
}: {
  variant: "main" | "conversation";
  title: string;
  isCompact: boolean;
  showAvatar: boolean;
  isActiveRunning: boolean;
  needsYouCount: number;
  onBackToMain: () => void;
}) {
  const { t } = useTranslation();
  const roleLabel =
    variant === "conversation"
      ? t("mainChat.shell.roleConversation")
      : t("mainChat.shell.roleMain");

  return (
    <View style={styles.headerLeft}>
      <SidebarMenuToggle />
      {variant === "conversation" ? (
        <PressHighlight
          onPress={onBackToMain}
          style={styles.backButton}
          highlightStyle={styles.controlPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.shell.backToMainLabel")}
          testID="main-chat-back-to-main"
        >
          <ThemedArrowLeft size={14} uniProps={mutedIconMapping} />
          <Text style={styles.backLabel} numberOfLines={1}>
            {t("mainChat.shell.backToMain")}
          </Text>
        </PressHighlight>
      ) : null}

      {showAvatar ? (
        <View style={styles.avatarBadge} testID="main-chat-header-avatar">
          {variant === "conversation" ? (
            <ThemedCompass size={14} uniProps={primaryIconMapping} />
          ) : (
            <ThemedSparkles size={14} uniProps={primaryIconMapping} />
          )}
          {isActiveRunning ? (
            <View style={styles.avatarRingOverlay}>
              <StatusRing />
            </View>
          ) : null}
        </View>
      ) : null}

      <Text style={styles.title} numberOfLines={1} testID="main-chat-shell-title">
        {title}
      </Text>

      {!isCompact ? <StatusBadge size="xs" variant="muted" label={roleLabel} /> : null}

      {needsYouCount > 0 ? (
        <StatusBadge
          size="xs"
          variant="warning"
          label={t("mainChat.hero.needsYouBadge", { count: needsYouCount })}
        />
      ) : null}
    </View>
  );
});

const ShellOverflowMenu = memo(function ShellOverflowMenu({
  variant,
  title,
  isCompact,
  canPatrol,
  canRunLifecycle,
  showRightDrawer,
  extraMenuItems,
  onTriggerPatrol,
  onToggleTaskDrawer,
  onOpenHistory,
  onCompact,
  onClear,
  onNewSession,
  onOpenSettings,
}: {
  variant: "main" | "conversation";
  title: string;
  isCompact: boolean;
  canPatrol: boolean;
  canRunLifecycle: boolean;
  showRightDrawer: boolean;
  extraMenuItems?: ReactNode;
  onTriggerPatrol: () => void;
  onToggleTaskDrawer: () => void;
  onOpenHistory: () => void;
  onCompact: () => void;
  onClear: () => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        hitSlop={6}
        style={styles.iconButton}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.shell.menuLabel")}
        testID="main-chat-header-menu"
      >
        <ThemedEllipsis size={16} uniProps={mutedIconMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" width={248} sheetTitle={title}>
        <DropdownMenuItem
          leading={patrolMenuIcon}
          onSelect={onTriggerPatrol}
          disabled={!canPatrol}
          testID="main-chat-header-patrol"
        >
          {t("mainChat.actions.triggerPatrol")}
        </DropdownMenuItem>
        {!isCompact ? (
          <DropdownMenuItem
            leading={drawerMenuIcon}
            onSelect={onToggleTaskDrawer}
            testID="main-chat-header-toggle-drawer"
          >
            {showRightDrawer
              ? t("mainChat.shell.drawerCloseMenu")
              : t("mainChat.shell.drawerOpenMenu")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          leading={historyMenuIcon}
          onSelect={onOpenHistory}
          testID="main-chat-header-menu-history"
        >
          {t("mainChat.hero.viewHistory")}
        </DropdownMenuItem>
        {variant === "main" ? (
          <>
            <DropdownMenuSeparator />
            <MainChatLifecycleMenuItems
              testIdPrefix="main-chat-header"
              disabled={!canRunLifecycle}
              onCompact={onCompact}
              onClear={onClear}
              onNewSession={onNewSession}
            />
          </>
        ) : null}
        {extraMenuItems ? (
          <>
            <DropdownMenuSeparator />
            {extraMenuItems}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={settingsMenuIcon}
          onSelect={onOpenSettings}
          testID="main-chat-header-settings"
        >
          {t("mainChat.actions.openSettings")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const ShellHeaderRight = memo(function ShellHeaderRight({
  variant,
  title,
  isCompact,
  canToggleStyle,
  isTogglingStyle,
  currentStyle,
  canPatrol,
  canRunLifecycle,
  showRightDrawer,
  extraMenuItems,
  onToggleStyle,
  onOpenHistory,
  onTriggerPatrol,
  onToggleTaskDrawer,
  onCompact,
  onClear,
  onNewSession,
  onOpenSettings,
}: {
  variant: "main" | "conversation";
  title: string;
  isCompact: boolean;
  canToggleStyle: boolean;
  isTogglingStyle: boolean;
  currentStyle: "conservative" | "proactive";
  canPatrol: boolean;
  canRunLifecycle: boolean;
  showRightDrawer: boolean;
  extraMenuItems?: ReactNode;
  onToggleStyle: () => void;
  onOpenHistory: () => void;
  onTriggerPatrol: () => void;
  onToggleTaskDrawer: () => void;
  onCompact: () => void;
  onClear: () => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const isProactive = currentStyle === "proactive";

  return (
    <View style={styles.headerRight}>
      {canToggleStyle ? (
        <PressHighlight
          onPress={onToggleStyle}
          disabled={isTogglingStyle}
          style={[styles.styleCapsule, isProactive && styles.styleCapsuleProactive]}
          highlightStyle={styles.controlPressed}
          accessibilityRole="button"
          accessibilityLabel={
            isProactive
              ? t("mainChat.actions.switchToConservative")
              : t("mainChat.actions.switchToProactive")
          }
          testID="main-chat-style-capsule"
        >
          {isProactive ? (
            <ThemedZap size={12} uniProps={warningIconMapping} />
          ) : (
            <ThemedShield size={12} uniProps={mutedIconMapping} />
          )}
          <Text
            style={[styles.styleCapsuleText, isProactive && styles.styleCapsuleTextProactive]}
            numberOfLines={1}
          >
            {isProactive
              ? t("mainChat.style.proactiveShort")
              : t("mainChat.style.conservativeShort")}
          </Text>
        </PressHighlight>
      ) : null}

      <PressHighlight
        onPress={onOpenHistory}
        style={styles.iconButton}
        highlightStyle={styles.controlPressed}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.shell.historyButtonLabel")}
        testID="main-chat-header-history"
      >
        <ThemedHistory size={16} uniProps={mutedIconMapping} />
      </PressHighlight>

      <ShellOverflowMenu
        variant={variant}
        title={title}
        isCompact={isCompact}
        canPatrol={canPatrol}
        canRunLifecycle={canRunLifecycle}
        showRightDrawer={showRightDrawer}
        extraMenuItems={extraMenuItems}
        onTriggerPatrol={onTriggerPatrol}
        onToggleTaskDrawer={onToggleTaskDrawer}
        onOpenHistory={onOpenHistory}
        onCompact={onCompact}
        onClear={onClear}
        onNewSession={onNewSession}
        onOpenSettings={onOpenSettings}
      />
    </View>
  );
});

function useShellHeaderActions(input: {
  serverId: string | null;
  client: DaemonClient | null;
  mainAgentId: string | null | undefined;
  currentStyle: "conservative" | "proactive";
  onActivePaneChange?: (pane: "main" | "drawer") => void;
}) {
  const { serverId, client, mainAgentId, currentStyle, onActivePaneChange } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const updateSettings = useMainChatSettingsStore((state) => state.updateSettings);
  const triggerPatrol = useMainChatSettingsStore((state) => state.triggerPatrol);
  const activeDrawerTarget = useMainChatDrawerStore((state) => state.activeTarget);
  const lastDrawerTarget = useMainChatDrawerStore((state) => state.lastTarget);
  const toggleDrawer = useMainChatDrawerStore((state) => state.toggleDrawer);

  const [isTogglingStyle, setIsTogglingStyle] = useState(false);
  const [isPatrolling, setIsPatrolling] = useState(false);

  const toggleStyle = useCallback(() => {
    if (!serverId || !client || isTogglingStyle) return;
    setIsTogglingStyle(true);
    const nextStyle = currentStyle === "conservative" ? "proactive" : "conservative";
    void updateSettings(serverId, { applyPreset: nextStyle }, client)
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
      })
      .finally(() => {
        setIsTogglingStyle(false);
      });
  }, [client, currentStyle, isTogglingStyle, serverId, t, toast, updateSettings]);

  const runPatrol = useCallback(() => {
    if (!serverId || !client || isPatrolling) return;
    setIsPatrolling(true);
    void (async () => {
      try {
        let resolvedMainAgentId = mainAgentId ?? undefined;
        if (!resolvedMainAgentId) {
          const ensured = await client.ensureMainChat();
          resolvedMainAgentId = ensured.agentId ?? undefined;
        }
        const result = await triggerPatrol(serverId, client, {
          mainAgentId: resolvedMainAgentId,
          forceWakeup: true,
        });
        toast.show(result.summary, { variant: "success" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.patrolFailed"));
      } finally {
        setIsPatrolling(false);
      }
    })();
  }, [client, isPatrolling, mainAgentId, serverId, t, toast, triggerPatrol]);

  const toggleTaskDrawer = useCallback(() => {
    if (activeDrawerTarget !== null) {
      toggleDrawer();
      onActivePaneChange?.("main");
      return;
    }
    if (lastDrawerTarget !== null) {
      toggleDrawer();
      onActivePaneChange?.("drawer");
      return;
    }
    if (serverId && mainAgentId) {
      const first = selectMainChatDockTasks(useSessionStore.getState(), serverId, mainAgentId)[0];
      if (first) {
        toggleDrawer({
          serverId: first.serverId,
          agentId: first.agentId,
          workspaceId: first.workspaceId,
          title: first.title,
        });
        onActivePaneChange?.("drawer");
        return;
      }
    }
    toast.show(t("mainChat.drawer.noActiveTask"), { variant: "info" });
  }, [
    activeDrawerTarget,
    lastDrawerTarget,
    mainAgentId,
    onActivePaneChange,
    serverId,
    t,
    toast,
    toggleDrawer,
  ]);

  return {
    activeDrawerTarget,
    isTogglingStyle,
    isPatrolling,
    toggleStyle,
    runPatrol,
    toggleTaskDrawer,
  };
}

/**
 * Exclusive minimalist assistant shell for `/main` and `/main/c/[conversationId]`.
 * Strips all WorkspaceScreen tabs, terminal, explorer, git, and script chrome; pairs the main
 * conversation column with an optional wide-screen side-by-side `TaskPanelDrawer`.
 */
export const MainChatShell = memo(function MainChatShell({
  variant,
  title,
  serverId,
  mainAgentId,
  originRoute,
  isRunning = false,
  needsYouCount = 0,
  runningCount = 0,
  onActivePaneChange,
  activePane = "main",
  extraMenuItems,
  children,
}: MainChatShellProps): ReactElement {
  const insets = useSafeAreaInsets();
  const isCompact = useIsCompactFormFactor();
  const isDesktopSidebarOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const clearCameFrom = useMainChatCameFromStore((state) => state.clearCameFrom);

  const client = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client ?? null) : null,
  );
  const settings = useMainChatSettingsStore((state) =>
    serverId ? state.settingsByServerId[serverId] : undefined,
  );
  const loadSettings = useMainChatSettingsStore((state) => state.loadSettings);

  useEffect(() => {
    clearCameFrom();
  }, [clearCameFrom]);

  useEffect(() => {
    if (!serverId || !client || settings) return;
    void loadSettings(serverId, client);
  }, [client, loadSettings, serverId, settings]);

  const currentStyle = settings?.style ?? "conservative";
  const actions = useShellHeaderActions({
    serverId,
    client,
    mainAgentId,
    currentStyle,
    onActivePaneChange,
  });
  const lifecycle = useMainChatLifecycleActions({
    serverId,
    client,
    mainAgentId,
  });

  const handleBackToMain = useCallback(() => router.push(buildMainChatRoute()), []);
  const handleOpenHistory = useCallback(() => router.push(buildMainChatHistoryRoute()), []);
  const handleOpenSettings = useCallback(
    () => router.push(buildSettingsSectionRoute("main-chat")),
    [],
  );
  const handleFocusDrawerPane = useCallback(
    () => onActivePaneChange?.("drawer"),
    [onActivePaneChange],
  );
  const handleMainColumnResponderCapture = useCallback(() => {
    onActivePaneChange?.("main");
    return false;
  }, [onActivePaneChange]);

  const shellContextValue = useMemo(
    () => ({
      inMainChatShell: true,
      originRoute,
      originTitle: title,
    }),
    [originRoute, title],
  );

  const headerInnerStyle = useMemo(
    () => [
      styles.headerInner,
      { paddingTop: insets.top + (isCompact ? HEADER_TOP_PADDING_MOBILE : 0) },
    ],
    [insets.top, isCompact],
  );

  const showHeaderAvatar = isCompact || !isDesktopSidebarOpen || variant === "conversation";
  const showRightDrawer = !isCompact && actions.activeDrawerTarget !== null;
  const headerHorizontalPadding = isCompact ? 8 : 12;

  return (
    <MainChatShellProvider value={shellContextValue}>
      <View style={styles.root} testID="main-chat-shell">
        <View style={styles.headerContainer} testID="main-chat-shell-header">
          <View style={headerInnerStyle}>
            <WindowChromeSafeArea
              placement="inline"
              horizontalPadding={headerHorizontalPadding}
              style={styles.headerRow}
            >
              <TitlebarDragRegion />
              <ShellHeaderLeft
                variant={variant}
                title={title}
                isCompact={isCompact}
                showAvatar={showHeaderAvatar}
                isActiveRunning={isRunning || runningCount > 0}
                needsYouCount={needsYouCount}
                onBackToMain={handleBackToMain}
              />
              <ShellHeaderRight
                variant={variant}
                title={title}
                isCompact={isCompact}
                canToggleStyle={Boolean(serverId && client)}
                isTogglingStyle={actions.isTogglingStyle}
                currentStyle={currentStyle}
                canPatrol={Boolean(serverId && client && !actions.isPatrolling)}
                canRunLifecycle={lifecycle.canRunLifecycle}
                showRightDrawer={showRightDrawer}
                extraMenuItems={extraMenuItems}
                onToggleStyle={actions.toggleStyle}
                onOpenHistory={handleOpenHistory}
                onTriggerPatrol={actions.runPatrol}
                onToggleTaskDrawer={actions.toggleTaskDrawer}
                onCompact={lifecycle.triggerCompact}
                onClear={lifecycle.requestClear}
                onNewSession={lifecycle.requestNewSession}
                onOpenSettings={handleOpenSettings}
              />
            </WindowChromeSafeArea>
          </View>
        </View>

        <View style={styles.workbench}>
          <View
            style={styles.mainColumn}
            onStartShouldSetResponderCapture={handleMainColumnResponderCapture}
            testID="main-chat-main-column"
          >
            {variant === "main" ? (
              <MainChatCompactionBanner serverId={serverId} mainAgentId={mainAgentId} />
            ) : null}
            {children}
          </View>

          {showRightDrawer && actions.activeDrawerTarget ? (
            <TaskPanelDrawer
              target={actions.activeDrawerTarget}
              mainServerId={serverId}
              mainAgentId={mainAgentId ?? null}
              isFocused={activePane === "drawer"}
              onFocus={handleFocusDrawerPane}
            />
          ) : null}
        </View>
      </View>

      <MainChatLifecycleConfirmModal
        confirmKind={lifecycle.confirmKind}
        busy={lifecycle.busyAction !== null}
        onCancel={lifecycle.cancelConfirm}
        onConfirm={lifecycle.confirmPendingAction}
      />
    </MainChatShellProvider>
  );
});

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    backgroundColor: theme.colors.surface0,
  },
  headerContainer: {
    backgroundColor: theme.colors.surface0,
  },
  headerInner: {},
  headerRow: {
    position: "relative",
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  headerLeft: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexShrink: 0,
  },
  backButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  backLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  avatarBadge: {
    position: "relative",
    width: 26,
    height: 26,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  avatarRingOverlay: {
    position: "absolute",
    right: -2,
    bottom: -2,
    width: 11,
    height: 11,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface0,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  styleCapsule: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    height: 28,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  styleCapsuleProactive: {
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.statusWarningTint,
  },
  styleCapsuleText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  styleCapsuleTextProactive: {
    color: theme.colors.statusWarning,
  },
  iconButton: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  controlPressed: {
    backgroundColor: theme.colors.surface2,
  },
  workbench: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
    flexDirection: "row",
  },
  mainColumn: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
}));
