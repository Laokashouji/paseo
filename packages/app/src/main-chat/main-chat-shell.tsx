import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MainChatNightModeStatus, MainChatSettings } from "@getpaseo/protocol/main-chat";
import { router } from "expo-router";
import {
  Activity,
  ArrowLeft,
  ChevronDown,
  Compass,
  Ellipsis,
  History,
  Moon,
  PanelRight,
  Radar,
  Settings,
  Shield,
  ShieldCheck,
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
  DropdownMenuLabel,
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
import { DiffDocumentWorkspaceCacheProvider } from "@/git/diff-document/workspace-cache";
import { useHosts } from "@/runtime/host-runtime";
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
import { StandingAuthModal } from "./standing-auth-panel";
import {
  buildMainChatStylePresetItems,
  findActiveMainChatStylePresetItem,
  formatSwitchedMainChatPresetToast,
  type MainChatStylePresetListItem,
} from "./style-presets";
import { TaskPanelDrawer } from "./task-panel-drawer";
import { formatCompactTokenCount } from "./usage-format";

const ThemedActivity = withUnistyles(Activity);
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedCompass = withUnistyles(Compass);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedHistory = withUnistyles(History);
const ThemedMoon = withUnistyles(Moon);
const ThemedPanelRight = withUnistyles(PanelRight);
const ThemedRadar = withUnistyles(Radar);
const ThemedSettings = withUnistyles(Settings);
const ThemedShield = withUnistyles(Shield);
const ThemedShieldCheck = withUnistyles(ShieldCheck);
const ThemedSparkles = withUnistyles(Sparkles);
const ThemedZap = withUnistyles(Zap);

const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });

const patrolMenuIcon = <ThemedRadar size={14} uniProps={mutedIconMapping} />;
const drawerMenuIcon = <ThemedPanelRight size={14} uniProps={mutedIconMapping} />;
const historyMenuIcon = <ThemedHistory size={14} uniProps={mutedIconMapping} />;
const standingAuthMenuIcon = <ThemedShieldCheck size={14} uniProps={mutedIconMapping} />;
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
  canManageStandingAuth,
  showRightDrawer,
  extraMenuItems,
  onTriggerPatrol,
  onToggleTaskDrawer,
  onOpenHistory,
  onCompact,
  onClear,
  onNewSession,
  onOpenStandingAuth,
  onOpenSettings,
}: {
  variant: "main" | "conversation";
  title: string;
  isCompact: boolean;
  canPatrol: boolean;
  canRunLifecycle: boolean;
  canManageStandingAuth: boolean;
  showRightDrawer: boolean;
  extraMenuItems?: ReactNode;
  onTriggerPatrol: () => void;
  onToggleTaskDrawer: () => void;
  onOpenHistory: () => void;
  onCompact: () => void;
  onClear: () => void;
  onNewSession: () => void;
  onOpenStandingAuth: () => void;
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
          leading={standingAuthMenuIcon}
          onSelect={onOpenStandingAuth}
          disabled={!canManageStandingAuth}
          testID="main-chat-header-standing-auth"
        >
          {t("mainChat.standingAuth.menuItem")}
        </DropdownMenuItem>
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

const StylePresetMenuOptionItem = memo(function StylePresetMenuOptionItem({
  preset,
  selected,
  onSelectPreset,
}: {
  preset: MainChatStylePresetListItem;
  selected: boolean;
  onSelectPreset: (presetId: string, presetName: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => {
    onSelectPreset(preset.id, preset.name);
  }, [onSelectPreset, preset.id, preset.name]);

  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      description={preset.kind === "custom" ? preset.description : undefined}
      onSelect={handleSelect}
      testID={`main-chat-style-option-${preset.id}`}
    >
      {preset.name}
    </DropdownMenuItem>
  );
});

function renderCapsuleStyleIcon(isCustom: boolean, isProactive: boolean): ReactElement {
  if (isCustom) {
    return (
      <ThemedSparkles size={12} uniProps={isProactive ? warningIconMapping : mutedIconMapping} />
    );
  }
  if (isProactive) {
    return <ThemedZap size={12} uniProps={warningIconMapping} />;
  }
  return <ThemedShield size={12} uniProps={mutedIconMapping} />;
}

const StylePresetCapsuleMenu = memo(function StylePresetCapsuleMenu({
  settings,
  disabled,
  onSelectPreset,
  onOpenSettings,
}: {
  settings: MainChatSettings | undefined;
  disabled: boolean;
  onSelectPreset: (presetId: string, presetName: string) => void;
  onOpenSettings: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const allPresets = useMemo(() => buildMainChatStylePresetItems(settings, t), [settings, t]);
  const activePreset = useMemo(() => findActiveMainChatStylePresetItem(settings, t), [settings, t]);
  const builtinPresets = useMemo(
    () => allPresets.filter((item) => item.kind === "builtin"),
    [allPresets],
  );
  const customPresets = useMemo(
    () => allPresets.filter((item) => item.kind === "custom"),
    [allPresets],
  );

  const isProactive = (settings?.style ?? activePreset.baseStyle) === "proactive";
  const isCustom = activePreset.kind === "custom";

  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        disabled={disabled}
        style={[styles.styleCapsule, isProactive && styles.styleCapsuleProactive]}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.actions.switchStyle")}
        testID="main-chat-style-capsule"
      >
        {renderCapsuleStyleIcon(isCustom, isProactive)}
        <Text
          style={[styles.styleCapsuleText, isProactive && styles.styleCapsuleTextProactive]}
          numberOfLines={1}
        >
          {activePreset.shortName}
        </Text>
        <ThemedChevronDown
          size={11}
          uniProps={isProactive ? warningIconMapping : mutedIconMapping}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        width={256}
        sheetTitle={t("mainChat.actions.switchStyle")}
      >
        <DropdownMenuLabel>{t("mainChat.settings.style.builtinGroupLabel")}</DropdownMenuLabel>
        {builtinPresets.map((preset) => (
          <StylePresetMenuOptionItem
            key={preset.id}
            preset={preset}
            selected={preset.id === activePreset.id}
            onSelectPreset={onSelectPreset}
          />
        ))}
        {customPresets.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("mainChat.settings.style.customGroupLabel")}</DropdownMenuLabel>
            {customPresets.map((preset) => (
              <StylePresetMenuOptionItem
                key={preset.id}
                preset={preset}
                selected={preset.id === activePreset.id}
                onSelectPreset={onSelectPreset}
              />
            ))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={settingsMenuIcon}
          onSelect={onOpenSettings}
          testID="main-chat-style-manage"
        >
          {t("mainChat.actions.manageStylePresets")}
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
  settings,
  nightPowerState,
  todayTokens,
  canPatrol,
  canRunLifecycle,
  showRightDrawer,
  extraMenuItems,
  onSelectPreset,
  onOpenHistory,
  onTriggerPatrol,
  onToggleTaskDrawer,
  onCompact,
  onClear,
  onNewSession,
  onOpenStandingAuth,
  onOpenSettings,
}: {
  variant: "main" | "conversation";
  title: string;
  isCompact: boolean;
  canToggleStyle: boolean;
  isTogglingStyle: boolean;
  settings: MainChatSettings | undefined;
  nightPowerState: MainChatNightModeStatus["state"] | undefined;
  todayTokens: number;
  canPatrol: boolean;
  canRunLifecycle: boolean;
  showRightDrawer: boolean;
  extraMenuItems?: ReactNode;
  onSelectPreset: (presetId: string, presetName: string) => void;
  onOpenHistory: () => void;
  onTriggerPatrol: () => void;
  onToggleTaskDrawer: () => void;
  onCompact: () => void;
  onClear: () => void;
  onNewSession: () => void;
  onOpenStandingAuth: () => void;
  onOpenSettings: () => void;
}) {
  const { t } = useTranslation();
  const isNightQuiet = nightPowerState === "throttled" || nightPowerState === "hibernating";

  return (
    <View style={styles.headerRight}>
      {isNightQuiet ? (
        <PressHighlight
          onPress={onOpenSettings}
          style={styles.telemetryCapsule}
          highlightStyle={styles.controlPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.nightMode.sectionTitle")}
          testID="main-chat-night-mode-capsule"
        >
          <ThemedMoon size={12} uniProps={mutedIconMapping} />
          <Text style={styles.telemetryCapsuleText} numberOfLines={1}>
            {nightPowerState === "hibernating"
              ? t("mainChat.nightMode.badgeHibernating")
              : t("mainChat.nightMode.badgeThrottled")}
          </Text>
        </PressHighlight>
      ) : null}

      {!isCompact && todayTokens > 0 ? (
        <PressHighlight
          onPress={onOpenSettings}
          style={styles.telemetryCapsule}
          highlightStyle={styles.controlPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.usage.sectionTitle")}
          testID="main-chat-usage-capsule"
        >
          <ThemedActivity size={12} uniProps={mutedIconMapping} />
          <Text style={styles.telemetryCapsuleText} numberOfLines={1}>
            {t("mainChat.usage.headerPill", { count: formatCompactTokenCount(todayTokens) })}
          </Text>
        </PressHighlight>
      ) : null}

      {canToggleStyle ? (
        <StylePresetCapsuleMenu
          settings={settings}
          disabled={isTogglingStyle}
          onSelectPreset={onSelectPreset}
          onOpenSettings={onOpenSettings}
        />
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
        canManageStandingAuth={canToggleStyle}
        showRightDrawer={showRightDrawer}
        extraMenuItems={extraMenuItems}
        onTriggerPatrol={onTriggerPatrol}
        onToggleTaskDrawer={onToggleTaskDrawer}
        onOpenHistory={onOpenHistory}
        onCompact={onCompact}
        onClear={onClear}
        onNewSession={onNewSession}
        onOpenStandingAuth={onOpenStandingAuth}
        onOpenSettings={onOpenSettings}
      />
    </View>
  );
});

function useShellHeaderActions(input: {
  serverId: string | null;
  client: DaemonClient | null;
  mainAgentId: string | null | undefined;
  onActivePaneChange?: (pane: "main" | "drawer") => void;
}) {
  const { serverId, client, mainAgentId, onActivePaneChange } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const updateSettings = useMainChatSettingsStore((state) => state.updateSettings);
  const triggerPatrol = useMainChatSettingsStore((state) => state.triggerPatrol);
  const activeDrawerTarget = useMainChatDrawerStore((state) => state.activeTarget);
  const lastDrawerTarget = useMainChatDrawerStore((state) => state.lastTarget);
  const toggleDrawer = useMainChatDrawerStore((state) => state.toggleDrawer);

  const [isTogglingStyle, setIsTogglingStyle] = useState(false);
  const [isPatrolling, setIsPatrolling] = useState(false);

  const selectPreset = useCallback(
    (presetId: string, presetName: string) => {
      if (!serverId || !client || isTogglingStyle) return;
      setIsTogglingStyle(true);
      void updateSettings(serverId, { applyPresetId: presetId }, client)
        .then(() => {
          toast.show(formatSwitchedMainChatPresetToast(presetId, presetName, t), {
            variant: "success",
          });
          return presetId;
        })
        .catch((error) => {
          toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
        })
        .finally(() => {
          setIsTogglingStyle(false);
        });
    },
    [client, isTogglingStyle, serverId, t, toast, updateSettings],
  );

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
    selectPreset,
    runPatrol,
    toggleTaskDrawer,
  };
}

function useHostLabelsByServerId(): Record<string, string> {
  const hosts = useHosts();
  return useMemo(() => {
    const labels: Record<string, string> = {};
    for (const host of hosts) {
      labels[host.serverId] = host.label;
    }
    return labels;
  }, [hosts]);
}

function useMainChatShellTelemetry(serverId: string | null) {
  const client = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client ?? null) : null,
  );
  const settings = useMainChatSettingsStore((state) =>
    serverId ? state.settingsByServerId[serverId] : undefined,
  );
  const nightModeStatus = useMainChatSettingsStore((state) =>
    serverId ? state.nightModeStatusByServerId[serverId] : undefined,
  );
  const usageSummary = useMainChatSettingsStore((state) =>
    serverId ? state.usageByServerId[serverId] : undefined,
  );
  const loadSettings = useMainChatSettingsStore((state) => state.loadSettings);
  const loadUsage = useMainChatSettingsStore((state) => state.loadUsage);

  useEffect(() => {
    if (!serverId || !client || settings) return;
    void loadSettings(serverId, client);
  }, [client, loadSettings, serverId, settings]);

  useEffect(() => {
    if (!serverId || !client || usageSummary) return;
    void loadUsage(serverId, client).catch(() => undefined);
  }, [client, loadUsage, serverId, usageSummary]);

  return {
    client,
    settings,
    nightPowerState: nightModeStatus?.state,
    todayTokens: usageSummary?.today.totalTokens ?? 0,
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
  const { client, settings, nightPowerState, todayTokens } = useMainChatShellTelemetry(serverId);

  useEffect(() => {
    clearCameFrom();
  }, [clearCameFrom]);
  const actions = useShellHeaderActions({
    serverId,
    client,
    mainAgentId,
    onActivePaneChange,
  });
  const lifecycle = useMainChatLifecycleActions({
    serverId,
    client,
    mainAgentId,
  });
  const hostLabelsByServerId = useHostLabelsByServerId();
  const [standingAuthModalOpen, setStandingAuthModalOpen] = useState(false);

  const handleBackToMain = useCallback(() => router.push(buildMainChatRoute()), []);
  const handleOpenHistory = useCallback(() => router.push(buildMainChatHistoryRoute()), []);
  const handleOpenStandingAuth = useCallback(() => setStandingAuthModalOpen(true), []);
  const handleCloseStandingAuth = useCallback(() => setStandingAuthModalOpen(false), []);
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
    <DiffDocumentWorkspaceCacheProvider>
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
                  settings={settings}
                  nightPowerState={nightPowerState}
                  todayTokens={todayTokens}
                  canPatrol={Boolean(serverId && client && !actions.isPatrolling)}
                  canRunLifecycle={lifecycle.canRunLifecycle}
                  showRightDrawer={showRightDrawer}
                  extraMenuItems={extraMenuItems}
                  onSelectPreset={actions.selectPreset}
                  onOpenHistory={handleOpenHistory}
                  onTriggerPatrol={actions.runPatrol}
                  onToggleTaskDrawer={actions.toggleTaskDrawer}
                  onCompact={lifecycle.triggerCompact}
                  onClear={lifecycle.requestClear}
                  onNewSession={lifecycle.requestNewSession}
                  onOpenStandingAuth={handleOpenStandingAuth}
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

        <StandingAuthModal
          visible={standingAuthModalOpen}
          serverId={serverId}
          mainAgentId={mainAgentId ?? null}
          client={client}
          hostLabelsByServerId={hostLabelsByServerId}
          onClose={handleCloseStandingAuth}
        />
      </MainChatShellProvider>
    </DiffDocumentWorkspaceCacheProvider>
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
    maxWidth: 112,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  styleCapsuleTextProactive: {
    color: theme.colors.statusWarning,
  },
  telemetryCapsule: {
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
  telemetryCapsuleText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
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
