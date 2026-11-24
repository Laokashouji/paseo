import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  isMainChatEnabled,
  type MainChatNightModeStatus,
  type MainChatSettings,
} from "@getpaseo/protocol/main-chat";
import { router, usePathname } from "expo-router";
import equal from "fast-deep-equal";
import {
  ChevronDown,
  ChevronRight,
  Ellipsis,
  History,
  Moon,
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  type MenuPageDefinition,
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
import type { StewardAccentTone } from "./steward-store";
import {
  buildMainChatStylePresetItems,
  findActiveMainChatStylePresetItem,
  formatSwitchedMainChatPresetToast,
  type MainChatStylePresetListItem,
} from "./style-presets";
import {
  useMainChatRosterSync,
  useMainChatStewardRoster,
  type MainChatStewardRosterItemWithActivity,
} from "./use-steward-roster";

const ThemedSparkles = withUnistyles(Sparkles);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedHistory = withUnistyles(History);
const ThemedMoon = withUnistyles(Moon);
const ThemedPencil = withUnistyles(Pencil);
const ThemedRadar = withUnistyles(Radar);
const ThemedSettings = withUnistyles(Settings);
const ThemedShield = withUnistyles(Shield);
const ThemedZap = withUnistyles(Zap);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const accentForegroundIconMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const accentColorIconMapping = (theme: Theme) => ({ color: theme.colors.accent });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const renameIcon = <ThemedPencil size={14} uniProps={mutedIconMapping} />;
const patrolIcon = <ThemedRadar size={14} uniProps={mutedIconMapping} />;
const historyIcon = <ThemedHistory size={14} uniProps={mutedIconMapping} />;
const settingsIcon = <ThemedSettings size={14} uniProps={mutedIconMapping} />;
const conservativeIcon = <ThemedShield size={14} uniProps={mutedIconMapping} />;
const proactiveIcon = <ThemedZap size={14} uniProps={mutedIconMapping} />;

const SELECTED_STATE = { selected: true } as const;
const ARCHIVE_GUARD_ACTIONS = ["workspace.archive"] as const;

/** Returns true when at least one connected host has an enabled Main Chat steward. */
export function useShouldShowMainChatHero(): boolean {
  const activeWorkspace = useActiveWorkspaceSelection();
  const lastWorkspace = useLastWorkspaceSelection();
  const preferredServerId = activeWorkspace?.serverId ?? lastWorkspace?.serverId ?? null;
  const { roster, activeServerId } = useMainChatStewardRoster({
    fallbackPreferredServerId: preferredServerId,
  });
  const effectivePreferred = activeServerId ?? preferredServerId;
  const hostState = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => {
        const summary = selectMainChatSidebarSummary(state, effectivePreferred);
        return {
          supportsMainChat: summary.supportsMainChat,
          targetServerId: summary.targetServerId,
        };
      },
      [effectivePreferred],
    ),
    equal,
  );
  const client = useSessionStore((state) =>
    hostState.targetServerId ? (state.sessions[hostState.targetServerId]?.client ?? null) : null,
  );
  const settings = useMainChatSettingsStore((state) =>
    hostState.targetServerId ? state.settingsByServerId[hostState.targetServerId] : undefined,
  );
  const isLoading = useMainChatSettingsStore((state) =>
    hostState.targetServerId ? Boolean(state.loadingByServerId[hostState.targetServerId]) : false,
  );
  const loadSettings = useMainChatSettingsStore((state) => state.loadSettings);

  useEffect(() => {
    if (
      !hostState.supportsMainChat ||
      !hostState.targetServerId ||
      !client ||
      settings ||
      isLoading
    ) {
      return;
    }
    void loadSettings(hostState.targetServerId, client).catch(() => undefined);
  }, [
    client,
    hostState.supportsMainChat,
    hostState.targetServerId,
    isLoading,
    loadSettings,
    settings,
  ]);

  if (roster.length > 0) {
    return true;
  }
  return hostState.supportsMainChat && isMainChatEnabled(settings);
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

function resolveStewardToneBadgeStyle(tone: StewardAccentTone | undefined) {
  switch (tone) {
    case "blue":
      return styles.iconBadgeToneBlue;
    case "green":
      return styles.iconBadgeToneGreen;
    case "orange":
      return styles.iconBadgeToneOrange;
    case "pink":
      return styles.iconBadgeTonePink;
    case "indigo":
      return styles.iconBadgeToneIndigo;
    default:
      return null;
  }
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
  nightPowerState,
  accentTone,
  otherNeedsYouCount,
}: {
  displayTitle: string;
  isSelected: boolean;
  isPatrolling: boolean;
  isRunning: boolean;
  needsYouCount: number;
  attentionCount: number;
  hasUnsentDraft: boolean;
  secondLineText: string;
  nightPowerState: MainChatNightModeStatus["state"] | undefined;
  accentTone?: StewardAccentTone;
  otherNeedsYouCount?: number;
}) {
  const isNightQuiet = nightPowerState === "throttled" || nightPowerState === "hibernating";
  const toneStyle = resolveStewardToneBadgeStyle(accentTone);
  const showOtherStewardAlert = (otherNeedsYouCount ?? 0) > 0;
  return (
    <>
      <View style={[styles.iconBadge, toneStyle, isSelected && styles.iconBadgeSelected]}>
        <ThemedSparkles size={18} uniProps={accentForegroundIconMapping} />
        {showOtherStewardAlert ? (
          <View style={styles.otherStewardAlertDot} testID="sidebar-main-chat-other-steward-dot" />
        ) : null}
        <View style={[styles.iconStatusOverlay, isSelected && styles.iconStatusOverlaySelected]}>
          {isNightQuiet && !isRunning && needsYouCount === 0 ? (
            <ThemedMoon size={9} uniProps={accentColorIconMapping} />
          ) : (
            <HeroStatusMark
              loading={isPatrolling}
              running={isRunning}
              needsYou={needsYouCount > 0}
              attention={attentionCount > 0}
            />
          )}
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
          <HeroTitleBadge
            needsYouCount={needsYouCount}
            isNightQuiet={isNightQuiet}
            nightPowerState={nightPowerState}
          />
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

const HeroTitleBadge = memo(function HeroTitleBadge({
  needsYouCount,
  isNightQuiet,
  nightPowerState,
}: {
  needsYouCount: number;
  isNightQuiet: boolean;
  nightPowerState: MainChatNightModeStatus["state"] | undefined;
}): ReactElement {
  const { t } = useTranslation();
  if (needsYouCount > 0) {
    return (
      <View testID="sidebar-main-chat-hero-needs-you">
        <StatusBadge
          size="xs"
          variant="warning"
          label={t("mainChat.hero.needsYouBadge", { count: needsYouCount })}
        />
      </View>
    );
  }
  if (isNightQuiet) {
    return (
      <View style={styles.nightPill} testID="sidebar-main-chat-hero-night-badge">
        <ThemedMoon size={10} uniProps={mutedIconMapping} />
        <Text style={styles.nightPillText} numberOfLines={1}>
          {nightPowerState === "hibernating"
            ? t("mainChat.nightMode.badgeHibernating")
            : t("mainChat.nightMode.badgeThrottled")}
        </Text>
      </View>
    );
  }
  return (
    <View style={styles.rolePill}>
      <Text style={styles.rolePillText} numberOfLines={1}>
        {t("mainChat.hero.rolePill")}
      </Text>
    </View>
  );
});

const HeroStylePresetMenuItem = memo(function HeroStylePresetMenuItem({
  preset,
  selected,
  showDescription,
  onSelectPreset,
}: {
  preset: MainChatStylePresetListItem;
  selected: boolean;
  showDescription: boolean;
  onSelectPreset: (presetId: string, presetName: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => {
    onSelectPreset(preset.id, preset.name);
  }, [onSelectPreset, preset.id, preset.name]);

  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      description={showDescription ? preset.description : undefined}
      onSelect={handleSelect}
      testID={`sidebar-main-chat-hero-style-${preset.id}`}
    >
      {preset.name}
    </DropdownMenuItem>
  );
});

const STYLE_PRESETS_PAGE_ID = "main-chat-style-presets";

const MainChatHeroMenu = memo(function MainChatHeroMenu({
  visible,
  open,
  onOpenChange,
  displayTitle,
  settings,
  canRunLifecycle,
  onTriggerPatrol,
  onOpenHistory,
  onBeginRename,
  onSelectPreset,
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
  settings: MainChatSettings | undefined;
  canRunLifecycle: boolean;
  onTriggerPatrol: () => void;
  onOpenHistory: () => void;
  onBeginRename: () => void;
  onSelectPreset: (presetId: string, presetName: string) => void;
  onCompact: () => void;
  onClear: () => void;
  onNewSession: () => void;
  onOpenSettings: () => void;
  extraMenuItems?: ReactNode;
}) {
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
  const currentStyle = settings?.style ?? "conservative";
  const hasCustomPresets = customPresets.length > 0;

  const handleQuickToggleBuiltIn = useCallback(() => {
    const nextId = currentStyle === "conservative" ? "proactive" : "conservative";
    const nextItem = allPresets.find((entry) => entry.id === nextId);
    onSelectPreset(nextId, nextItem?.name ?? nextId);
  }, [allPresets, currentStyle, onSelectPreset]);

  const pages = useMemo<MenuPageDefinition[] | undefined>(() => {
    if (!hasCustomPresets) return undefined;
    return [
      {
        id: STYLE_PRESETS_PAGE_ID,
        title: t("mainChat.actions.switchStyle"),
        content: (
          <>
            <DropdownMenuLabel>{t("mainChat.settings.style.builtinGroupLabel")}</DropdownMenuLabel>
            {builtinPresets.map((preset) => (
              <HeroStylePresetMenuItem
                key={preset.id}
                preset={preset}
                selected={preset.id === activePreset.id}
                showDescription={false}
                onSelectPreset={onSelectPreset}
              />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("mainChat.settings.style.customGroupLabel")}</DropdownMenuLabel>
            {customPresets.map((preset) => (
              <HeroStylePresetMenuItem
                key={preset.id}
                preset={preset}
                selected={preset.id === activePreset.id}
                showDescription
                onSelectPreset={onSelectPreset}
              />
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              leading={settingsIcon}
              onSelect={onOpenSettings}
              testID="sidebar-main-chat-hero-style-manage"
            >
              {t("mainChat.actions.manageStylePresets")}
            </DropdownMenuItem>
          </>
        ),
      },
    ];
  }, [
    activePreset.id,
    builtinPresets,
    customPresets,
    hasCustomPresets,
    onOpenSettings,
    onSelectPreset,
    t,
  ]);

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
        <DropdownMenuContent align="end" width={248} sheetTitle={displayTitle} pages={pages}>
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
          {hasCustomPresets ? (
            <DropdownMenuSubTrigger
              id={STYLE_PRESETS_PAGE_ID}
              leading={currentStyle === "proactive" ? proactiveIcon : conservativeIcon}
              value={activePreset.shortName}
              testID="sidebar-main-chat-hero-style-submenu"
            >
              {t("mainChat.actions.switchStyle")}
            </DropdownMenuSubTrigger>
          ) : (
            <DropdownMenuItem
              leading={currentStyle === "conservative" ? proactiveIcon : conservativeIcon}
              onSelect={handleQuickToggleBuiltIn}
              testID="sidebar-main-chat-hero-toggle-style"
            >
              {currentStyle === "conservative"
                ? t("mainChat.actions.switchToProactive")
                : t("mainChat.actions.switchToConservative")}
            </DropdownMenuItem>
          )}
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
}) {
  const { targetServerId, client, existingAgentId, displayTitle } = input;
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

  const selectPreset = useCallback(
    (presetId: string, presetName: string) => {
      if (!targetServerId || !client) return;
      void updateSettings(targetServerId, { applyPresetId: presetId }, client)
        .then(() => {
          toast.show(formatSwitchedMainChatPresetToast(presetId, presetName, t), {
            variant: "success",
          });
          return presetId;
        })
        .catch((error) => {
          toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
        });
    },
    [client, t, targetServerId, toast, updateSettings],
  );

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
    selectPreset,
  };
}

function formatStewardRosterItemDescription(
  item: MainChatStewardRosterItemWithActivity,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (!item.online) {
    parts.push(t("mainChat.stewards.offlineBadge"));
  }
  if (item.managedHostLabels.length <= 1) {
    parts.push(t("mainChat.stewards.localOnlySummary", { host: item.hostLabel }));
  } else {
    parts.push(
      t("mainChat.stewards.managedHostsSummary", {
        hosts: item.managedHostLabels.join(" · "),
      }),
    );
  }
  if (item.needsYouCount > 0) {
    parts.push(t("mainChat.stewards.needsYouCount", { count: item.needsYouCount }));
  }
  return parts.join(" · ");
}

const StewardSwitcherItem = memo(function StewardSwitcherItem({
  item,
  selected,
  onSelectSteward,
}: {
  item: MainChatStewardRosterItemWithActivity;
  selected: boolean;
  onSelectSteward: (item: MainChatStewardRosterItemWithActivity) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => {
    onSelectSteward(item);
  }, [item, onSelectSteward]);

  const dotStyle = resolveStewardToneBadgeStyle(item.accentTone);
  const titleWithTags = item.isDefault
    ? `${item.title} · ${t("mainChat.stewards.defaultBadge")}`
    : item.title;
  const leading = useMemo(
    () => (
      <View
        style={[styles.stewardAvatarDot, dotStyle, !item.online && styles.stewardAvatarDotOffline]}
      >
        <Text style={styles.stewardAvatarLetter}>{item.title.slice(0, 1) || "管"}</Text>
      </View>
    ),
    [dotStyle, item.online, item.title],
  );

  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      leading={leading}
      description={formatStewardRosterItemDescription(item, t)}
      onSelect={handleSelect}
      testID={`steward-switcher-item-${item.serverId}`}
    >
      {titleWithTags}
    </DropdownMenuItem>
  );
});

const StewardSwitcherMenu = memo(function StewardSwitcherMenu({
  roster,
  activeServerId,
  otherNeedsYouCount,
  onSelectSteward,
  onOpenSettings,
}: {
  roster: readonly MainChatStewardRosterItemWithActivity[];
  activeServerId: string | null;
  otherNeedsYouCount: number;
  onSelectSteward: (item: MainChatStewardRosterItemWithActivity) => void;
  onOpenSettings: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        hitSlop={6}
        style={styles.switcherButton}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.stewards.switcherLabel")}
        testID="sidebar-main-chat-steward-switcher"
      >
        <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
        {otherNeedsYouCount > 0 ? (
          <View style={styles.switcherBadge} testID="sidebar-main-chat-switcher-other-count">
            <Text style={styles.switcherBadgeText}>
              {otherNeedsYouCount > 99 ? "99+" : `+${otherNeedsYouCount}`}
            </Text>
          </View>
        ) : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        width={268}
        sheetTitle={t("mainChat.stewards.switcherHeading")}
      >
        <DropdownMenuLabel>{t("mainChat.stewards.switcherHeading")}</DropdownMenuLabel>
        {roster.map((item) => (
          <StewardSwitcherItem
            key={item.serverId}
            item={item}
            selected={item.serverId === activeServerId}
            onSelectSteward={onSelectSteward}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          leading={settingsIcon}
          onSelect={onOpenSettings}
          testID="steward-switcher-manage"
        >
          {t("mainChat.stewards.manageAction")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

function useMainChatHeroData() {
  useMainChatRosterSync();

  const activeWorkspace = useActiveWorkspaceSelection();
  const lastWorkspace = useLastWorkspaceSelection();
  const fallbackPreferredServerId = activeWorkspace?.serverId ?? lastWorkspace?.serverId ?? null;
  const {
    roster,
    activeServerId,
    activeSteward,
    activeAllowedServerIds,
    hasMultipleStewards,
    otherNeedsYouCount,
    selectSteward,
  } = useMainChatStewardRoster({
    fallbackPreferredServerId,
  });

  const preferredServerId = activeServerId ?? fallbackPreferredServerId;
  const strictServerId = roster.length > 0;

  const summaryBase = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) =>
        selectMainChatSidebarSummary(state, preferredServerId, null, {
          allowedServerIds: activeAllowedServerIds,
          strictServerId,
        }),
      [activeAllowedServerIds, preferredServerId, strictServerId],
    ),
    equal,
  );

  const targetServerId = activeServerId ?? summaryBase.targetServerId;
  const client = useSessionStore((state) =>
    targetServerId ? (state.sessions[targetServerId]?.client ?? null) : null,
  );
  const settings = useMainChatSettingsStore((state) =>
    targetServerId ? state.settingsByServerId[targetServerId] : undefined,
  );
  const nightModeStatus = useMainChatSettingsStore((state) =>
    targetServerId ? state.nightModeStatusByServerId[targetServerId] : undefined,
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

  const displayTitle = settings?.title?.trim() || activeSteward?.title || summaryBase.displayTitle;

  return {
    summaryBase,
    targetServerId,
    client,
    settings,
    unsentDraftText,
    enabled: roster.length > 0 ? true : isMainChatEnabled(settings),
    supportsAnySteward: roster.length > 0 || summaryBase.supportsMainChat,
    nightPowerState: nightModeStatus?.state,
    displayTitle,
    roster,
    activeSteward,
    hasMultipleStewards,
    otherNeedsYouCount,
    selectSteward,
  };
}

const HeroTrailingPrimary = memo(function HeroTrailingPrimary({
  hasMultipleStewards,
  roster,
  activeServerId,
  otherNeedsYouCount,
  shortcutKeys,
  onSelectSteward,
  onOpenSettings,
}: {
  hasMultipleStewards: boolean;
  roster: readonly MainChatStewardRosterItemWithActivity[];
  activeServerId: string | null;
  otherNeedsYouCount: number;
  shortcutKeys: ReturnType<typeof useShortcutKeys>;
  onSelectSteward: (item: MainChatStewardRosterItemWithActivity) => void;
  onOpenSettings: () => void;
}): ReactElement {
  if (hasMultipleStewards) {
    return (
      <StewardSwitcherMenu
        roster={roster}
        activeServerId={activeServerId}
        otherNeedsYouCount={otherNeedsYouCount}
        onSelectSteward={onSelectSteward}
        onOpenSettings={onOpenSettings}
      />
    );
  }
  if (shortcutKeys) {
    return (
      <View style={styles.shortcutSlot}>
        <Shortcut chord={shortcutKeys} />
      </View>
    );
  }
  return <ThemedChevronRight size={14} uniProps={mutedIconMapping} />;
});

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

  const {
    summaryBase,
    targetServerId,
    client,
    settings,
    unsentDraftText,
    enabled,
    supportsAnySteward,
    nightPowerState,
    displayTitle,
    roster,
    activeSteward,
    hasMultipleStewards,
    otherNeedsYouCount,
    selectSteward,
  } = useMainChatHeroData();
  const isSelected = isMainChatPathname(pathname);

  const actions = useMainChatHeroActions({
    targetServerId,
    client,
    existingAgentId: summaryBase.existing?.agentId,
    displayTitle,
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
    const targetRoute = hasMultipleStewards
      ? buildMainChatRoute(targetServerId)
      : buildMainChatRoute();
    if (!hasMultipleStewards && pathname === targetRoute) return;
    router.push(targetRoute);
  }, [hasMultipleStewards, onBeforeNavigate, pathname, targetServerId]);

  const handleSelectSteward = useCallback(
    (item: MainChatStewardRosterItemWithActivity) => {
      selectSteward(item.serverId);
      toast.show(t("mainChat.stewards.switchedToast", { title: item.title }), { variant: "info" });
      if (isSelected) {
        onBeforeNavigate?.();
        router.push(buildMainChatRoute(item.serverId));
      }
    },
    [isSelected, onBeforeNavigate, selectSteward, t, toast],
  );

  const handleOpenHistory = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildMainChatHistoryRoute(hasMultipleStewards ? targetServerId : undefined));
  }, [hasMultipleStewards, onBeforeNavigate, targetServerId]);

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

  const subtitle = useMemo(() => {
    const baseStatus = formatHeroSubtitle(summaryBase, t);
    if (!hasMultipleStewards || !activeSteward) {
      return baseStatus;
    }
    const scopeChip =
      activeSteward.managedHostLabels.length <= 1
        ? activeSteward.hostLabel
        : activeSteward.managedHostLabels.slice(0, 2).join(" · ");
    if (!activeSteward.online) {
      return `${scopeChip} · ${t("mainChat.stewards.offlineBadge")}`;
    }
    if (summaryBase.totalActiveCount === 0 && summaryBase.needsYouCount === 0) {
      return scopeChip;
    }
    return `${scopeChip} · ${baseStatus}`;
  }, [activeSteward, hasMultipleStewards, summaryBase, t]);

  if (!supportsAnySteward || !enabled) {
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
            <View style={[styles.accentRail, isSelected && styles.accentRailSelected]} />
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
                nightPowerState={nightPowerState}
                accentTone={hasMultipleStewards ? activeSteward?.accentTone : undefined}
                otherNeedsYouCount={hasMultipleStewards ? otherNeedsYouCount : 0}
              />
            </PressHighlight>

            <View style={styles.trailing}>
              <HeroTrailingPrimary
                hasMultipleStewards={hasMultipleStewards}
                roster={roster}
                activeServerId={targetServerId}
                otherNeedsYouCount={otherNeedsYouCount}
                shortcutKeys={shortcutKeys}
                onSelectSteward={handleSelectSteward}
                onOpenSettings={handleOpenSettings}
              />
              <MainChatHeroMenu
                visible={showKebab}
                open={menuProps.open}
                onOpenChange={menuProps.onOpenChange}
                displayTitle={displayTitle}
                settings={settings}
                canRunLifecycle={lifecycle.canRunLifecycle}
                onTriggerPatrol={actions.runPatrol}
                onOpenHistory={handleOpenHistory}
                onBeginRename={actions.beginRename}
                onSelectPreset={actions.selectPreset}
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
    paddingTop: theme.spacing[2],
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
    minHeight: 58,
    flexDirection: "row",
    alignItems: "center",
    overflow: "hidden",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.xl,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  accentRail: {
    position: "absolute",
    left: 0,
    top: 8,
    bottom: 8,
    width: 3,
    borderTopRightRadius: theme.borderRadius.full,
    borderBottomRightRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    opacity: 0.85,
  },
  accentRailSelected: {
    top: 0,
    bottom: 0,
    width: 3.5,
    borderTopRightRadius: 0,
    borderBottomRightRadius: 0,
    opacity: 1,
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.accent,
  },
  rowSelected: {
    backgroundColor: theme.colors.statusSuccessTint,
    borderColor: theme.colors.accent,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  mainButton: {
    flex: 1,
    minWidth: 0,
    minHeight: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.xl,
  },
  mainButtonPressed: {
    backgroundColor: "transparent",
  },
  iconBadge: {
    position: "relative",
    width: 36,
    height: 36,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  iconBadgeSelected: {
    backgroundColor: theme.colors.accentBright,
  },
  iconBadgeToneBlue: {
    backgroundColor: "#2563eb",
  },
  iconBadgeToneGreen: {
    backgroundColor: "#16a34a",
  },
  iconBadgeToneOrange: {
    backgroundColor: "#ea580c",
  },
  iconBadgeTonePink: {
    backgroundColor: "#db2777",
  },
  iconBadgeToneIndigo: {
    backgroundColor: "#4f46e5",
  },
  otherStewardAlertDot: {
    position: "absolute",
    right: -3,
    top: -3,
    width: 9,
    height: 9,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDanger,
    borderWidth: 1.5,
    borderColor: theme.colors.surface2,
  },
  switcherButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface3,
  },
  switcherBadge: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDanger,
  },
  switcherBadgeText: {
    fontSize: 9,
    fontWeight: theme.fontWeight.bold,
    color: "#ffffff",
  },
  stewardAvatarDot: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  stewardAvatarDotOffline: {
    opacity: 0.45,
  },
  stewardAvatarLetter: {
    fontSize: 10,
    fontWeight: theme.fontWeight.bold,
    color: "#ffffff",
  },
  iconStatusOverlay: {
    position: "absolute",
    right: -3,
    bottom: -3,
    width: 14,
    height: 14,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1.5,
    borderColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
  },
  iconStatusOverlaySelected: {
    backgroundColor: theme.colors.surface1,
    borderColor: theme.colors.surface1,
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
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  titleSelected: {
    fontWeight: theme.fontWeight.bold,
  },
  rolePill: {
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusSuccessTint,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.accent,
    flexShrink: 0,
  },
  rolePillText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.accent,
  },
  nightPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 1.5,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    flexShrink: 0,
  },
  nightPillText: {
    fontSize: 10,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
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
