import * as Linking from "expo-linking";
import { router, usePathname } from "expo-router";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Columns2,
  Ellipsis,
  ExternalLink,
  RotateCw,
  Settings,
} from "lucide-react-native";
import { memo, useCallback, useMemo, useState, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PressHighlight } from "@/components/ui/press-highlight";
import { Shortcut } from "@/components/ui/shortcut";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { getDesktopHost } from "@/desktop/host";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import type { Theme } from "@/styles/theme";
import {
  buildPersonaRoute,
  buildSettingsSectionRoute,
  isPersonaPathname,
} from "@/utils/host-routes";
import { reloadResidentPersonaWebview } from "./resident-persona-webview";
import {
  formatPersonaHubDisplayHost,
  getActivePersonaHub,
  getSecondaryPersonaHub,
  normalizePersonaHubUrl,
  openPersonaHubInRightSplit,
  selectActivePersonaHub,
  togglePersonaSplitMode,
  type PersonaHubProfile,
} from "./settings";
import { usePersonaEmbedSettings, useUpdatePersonaEmbedSettings } from "./use-persona-settings";

const ThemedBot = withUnistyles(Bot);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedColumns = withUnistyles(Columns2);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedSettings = withUnistyles(Settings);

const accentForegroundIconMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const accentIconMapping = (theme: Theme) => ({ color: theme.colors.accent });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const reloadIcon = <ThemedRotateCw size={14} uniProps={mutedIconMapping} />;
const splitIcon = <ThemedColumns size={14} uniProps={mutedIconMapping} />;
const openExternalIcon = <ThemedExternalLink size={14} uniProps={mutedIconMapping} />;
const settingsIcon = <ThemedSettings size={14} uniProps={mutedIconMapping} />;

const SELECTED_STATE = { selected: true } as const;
const EXPANDED_STATE = { expanded: true } as const;
const COLLAPSED_STATE = { expanded: false } as const;

export function useShouldShowPersonaHero(): boolean {
  return usePersonaEmbedSettings().enabled;
}

interface PersonaHeroMenuProps {
  visible: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasDisplayHost: boolean;
  canToggleSplit: boolean;
  splitEnabled: boolean;
  onReload: () => void;
  onToggleSplit: () => void;
  onOpenExternal: () => void;
  onOpenSettings: () => void;
}

const PersonaHeroMenu = memo(function PersonaHeroMenu({
  visible,
  open,
  onOpenChange,
  hasDisplayHost,
  canToggleSplit,
  splitEnabled,
  onReload,
  onToggleSplit,
  onOpenExternal,
  onOpenSettings,
}: PersonaHeroMenuProps): ReactElement | null {
  const { t } = useTranslation();
  if (!visible) {
    return null;
  }
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t("personaEmbed.sidebar.menu.settings")}
        style={styles.kebabButton}
        testID="sidebar-persona-hero-menu"
      >
        <ThemedEllipsis size={14} uniProps={mutedIconMapping} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onSelect={onReload}
          leading={reloadIcon}
          testID="sidebar-persona-menu-reload"
        >
          {t("personaEmbed.sidebar.menu.reload")}
        </DropdownMenuItem>
        {canToggleSplit ? (
          <DropdownMenuItem
            onSelect={onToggleSplit}
            leading={splitIcon}
            testID="sidebar-persona-menu-toggle-split"
          >
            {splitEnabled
              ? t("personaEmbed.sidebar.menu.disableSplit")
              : t("personaEmbed.sidebar.menu.enableSplit")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onSelect={onOpenExternal}
          disabled={!hasDisplayHost}
          leading={openExternalIcon}
          testID="sidebar-persona-menu-external"
        >
          {t("personaEmbed.sidebar.menu.openExternal")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={onOpenSettings}
          leading={settingsIcon}
          testID="sidebar-persona-menu-settings"
        >
          {t("personaEmbed.sidebar.menu.settings")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

interface PersonaHubSubRowProps {
  hub: PersonaHubProfile;
  isPrimary: boolean;
  isSecondaryInSplit: boolean;
  isSplitActive: boolean;
  isRouteSelected: boolean;
  isCompact: boolean;
  onSelectHub: (hubId: string) => void;
  onToggleRightSplit: (hubId: string) => void;
}

function resolveSubRowRoleTagKey(input: {
  isSplitActive: boolean;
  isPrimary: boolean;
  isSecondaryInSplit: boolean;
}):
  | "personaEmbed.sidebar.hubPrimaryTag"
  | "personaEmbed.sidebar.hubSecondaryTag"
  | "personaEmbed.sidebar.hubActiveTag"
  | null {
  if (input.isSplitActive) {
    if (input.isPrimary) return "personaEmbed.sidebar.hubPrimaryTag";
    if (input.isSecondaryInSplit) return "personaEmbed.sidebar.hubSecondaryTag";
    return null;
  }
  return input.isPrimary ? "personaEmbed.sidebar.hubActiveTag" : null;
}

function resolveSubRowDotStyle(input: {
  isValidUrl: boolean;
  isPrimary: boolean;
  isSecondaryInSplit: boolean;
}) {
  if (!input.isValidUrl) return styles.statusDotWarning;
  if (input.isPrimary) return styles.statusDotPrimary;
  if (input.isSecondaryInSplit) return styles.statusDotSecondary;
  return styles.statusDotIdle;
}

const PersonaHubSubRow = memo(function PersonaHubSubRow({
  hub,
  isPrimary,
  isSecondaryInSplit,
  isSplitActive,
  isRouteSelected,
  isCompact,
  onSelectHub,
  onToggleRightSplit,
}: PersonaHubSubRowProps): ReactElement {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);

  const displayHost = useMemo(() => formatPersonaHubDisplayHost(hub.hubUrl), [hub.hubUrl]);
  const isValidUrl = displayHost !== null;

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleSelect = useCallback(() => {
    onSelectHub(hub.id);
  }, [hub.id, onSelectHub]);
  const handleSplitPress = useCallback(() => {
    onToggleRightSplit(hub.id);
  }, [hub.id, onToggleRightSplit]);

  const roleTagKey = resolveSubRowRoleTagKey({ isSplitActive, isPrimary, isSecondaryInSplit });
  const roleTag = roleTagKey ? t(roleTagKey) : null;
  const dotStyle = resolveSubRowDotStyle({ isValidUrl, isPrimary, isSecondaryInSplit });
  const splitActionVisible = !isCompact && !isPrimary && isValidUrl;
  const isActiveVisual = isPrimary || isSecondaryInSplit;

  return (
    <View
      style={[
        styles.subRowEnvelope,
        isHovered && styles.subRowHovered,
        isActiveVisual && isRouteSelected && styles.subRowSelected,
      ]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      testID={`sidebar-persona-hub-row-${hub.id}`}
    >
      <PressHighlight
        onPress={handleSelect}
        style={styles.subRowMain}
        highlightStyle={styles.subRowPressed}
        accessibilityRole="button"
        accessibilityLabel={hub.name}
        accessibilityState={isPrimary && isRouteSelected ? SELECTED_STATE : undefined}
        testID={`sidebar-persona-hub-select-${hub.id}`}
      >
        <View style={[styles.statusDot, dotStyle]} />
        <View style={styles.subRowTextBlock}>
          <View style={styles.subRowTitleLine}>
            <Text
              numberOfLines={1}
              ellipsizeMode="tail"
              style={[styles.subRowTitle, isActiveVisual && styles.subRowTitleActive]}
            >
              {hub.name}
            </Text>
            {roleTag ? (
              <View
                style={[styles.roleBadge, isSecondaryInSplit && styles.roleBadgeSecondary]}
                testID={`sidebar-persona-hub-tag-${hub.id}`}
              >
                <Text style={styles.roleBadgeText}>{roleTag}</Text>
              </View>
            ) : null}
          </View>
          <Text numberOfLines={1} ellipsizeMode="middle" style={styles.subRowHost}>
            {displayHost ?? t("personaEmbed.sidebar.subtitleUnconfigured")}
          </Text>
        </View>
      </PressHighlight>

      {splitActionVisible ? (
        <PressHighlight
          onPress={handleSplitPress}
          style={[styles.subRowSplitButton, isSecondaryInSplit && styles.subRowSplitButtonActive]}
          highlightStyle={styles.subRowSplitButtonPressed}
          accessibilityRole="button"
          accessibilityLabel={
            isSecondaryInSplit
              ? t("personaEmbed.sidebar.removeFromRightSplit", { name: hub.name })
              : t("personaEmbed.sidebar.openInRightSplit", { name: hub.name })
          }
          testID={`sidebar-persona-hub-split-${hub.id}`}
        >
          <ThemedColumns
            size={13}
            uniProps={isSecondaryInSplit ? accentIconMapping : mutedIconMapping}
          />
        </PressHighlight>
      ) : null}
    </View>
  );
});

interface PersonaHeroMainContentProps {
  isSelected: boolean;
  isSplitActive: boolean;
  subtitle: string;
  onPress: () => void;
  onPressIn: () => void;
  onPressOut: () => void;
}

const PersonaHeroMainContent = memo(function PersonaHeroMainContent({
  isSelected,
  isSplitActive,
  subtitle,
  onPress,
  onPressIn,
  onPressOut,
}: PersonaHeroMainContentProps): ReactElement {
  const { t } = useTranslation();
  return (
    <PressHighlight
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={styles.mainButton}
      highlightStyle={styles.mainButtonPressed}
      accessibilityRole="button"
      accessibilityLabel={t("personaEmbed.sidebar.accessibilityLabel")}
      accessibilityState={isSelected ? SELECTED_STATE : undefined}
      testID="sidebar-persona-hero"
    >
      <View style={[styles.iconBadge, isSelected && styles.iconBadgeSelected]}>
        <ThemedBot size={18} uniProps={accentForegroundIconMapping} />
      </View>
      <View style={styles.textBlock}>
        <View style={styles.titleRow}>
          <Text numberOfLines={1} ellipsizeMode="tail" style={styles.title}>
            {t("personaEmbed.sidebar.title")}
          </Text>
          {isSplitActive ? (
            <View style={styles.splitBadge} testID="sidebar-persona-split-badge">
              <Text style={styles.splitBadgeText}>{t("personaEmbed.sidebar.splitBadge")}</Text>
            </View>
          ) : null}
        </View>
        <Text numberOfLines={1} ellipsizeMode="middle" style={styles.subtitle}>
          {subtitle}
        </Text>
      </View>
    </PressHighlight>
  );
});

interface PersonaHeroTrailingIndicatorProps {
  hasMultipleHubs: boolean;
  isExpanded: boolean;
  showShortcut: boolean;
  shortcutKeys: ReturnType<typeof useShortcutKeys>;
  onToggleExpand: () => void;
}

const PersonaHeroTrailingIndicator = memo(function PersonaHeroTrailingIndicator({
  hasMultipleHubs,
  isExpanded,
  showShortcut,
  shortcutKeys,
  onToggleExpand,
}: PersonaHeroTrailingIndicatorProps): ReactElement {
  const { t } = useTranslation();
  if (hasMultipleHubs) {
    return (
      <PressHighlight
        onPress={onToggleExpand}
        style={styles.expandButton}
        highlightStyle={styles.expandButtonPressed}
        accessibilityRole="button"
        accessibilityLabel={
          isExpanded ? t("personaEmbed.sidebar.collapseHubs") : t("personaEmbed.sidebar.expandHubs")
        }
        accessibilityState={isExpanded ? EXPANDED_STATE : COLLAPSED_STATE}
        testID="sidebar-persona-expand-toggle"
      >
        {isExpanded ? (
          <ThemedChevronDown size={14} uniProps={mutedIconMapping} />
        ) : (
          <ThemedChevronRight size={14} uniProps={mutedIconMapping} />
        )}
      </PressHighlight>
    );
  }
  if (showShortcut && shortcutKeys) {
    return (
      <View style={styles.shortcutSlot}>
        <Shortcut chord={shortcutKeys} />
      </View>
    );
  }
  return <ThemedChevronRight size={14} uniProps={mutedIconMapping} />;
});

function formatHeroSubtitle(input: {
  isSplitActive: boolean;
  hasMultipleHubs: boolean;
  activeHub: PersonaHubProfile | null;
  secondaryHub: PersonaHubProfile | null;
  displayHost: string | null;
  splitSummaryText: string;
  unconfiguredText: string;
}): string {
  if (input.isSplitActive && input.activeHub && input.secondaryHub) {
    return input.splitSummaryText;
  }
  if (!input.hasMultipleHubs) {
    return input.displayHost ?? input.unconfiguredText;
  }
  if (!input.activeHub) {
    return input.unconfiguredText;
  }
  if (input.displayHost && input.displayHost !== input.activeHub.name) {
    return `${input.activeHub.name} · ${input.displayHost}`;
  }
  return input.activeHub.name;
}

interface PersonaHeroExpandedHubListProps {
  hubs: readonly PersonaHubProfile[];
  activeHubId: string | undefined;
  secondaryHubId: string | undefined;
  isSplitActive: boolean;
  isRouteSelected: boolean;
  isCompact: boolean;
  onSelectHub: (hubId: string) => void;
  onToggleRightSplit: (hubId: string) => void;
}

const PersonaHeroExpandedHubList = memo(function PersonaHeroExpandedHubList({
  hubs,
  activeHubId,
  secondaryHubId,
  isSplitActive,
  isRouteSelected,
  isCompact,
  onSelectHub,
  onToggleRightSplit,
}: PersonaHeroExpandedHubListProps): ReactElement {
  return (
    <View style={styles.hubListContainer} testID="sidebar-persona-hub-list">
      {hubs.map((hub) => (
        <PersonaHubSubRow
          key={hub.id}
          hub={hub}
          isPrimary={hub.id === activeHubId}
          isSecondaryInSplit={isSplitActive && hub.id === secondaryHubId}
          isSplitActive={isSplitActive}
          isRouteSelected={isRouteSelected}
          isCompact={isCompact}
          onSelectHub={onSelectHub}
          onToggleRightSplit={onToggleRightSplit}
        />
      ))}
    </View>
  );
});

function openPersonaHubExternally(hubUrl: string | undefined): void {
  const normalized = normalizePersonaHubUrl(hubUrl ?? "");
  if (!normalized.ok) {
    return;
  }
  const desktopOpener = getDesktopHost()?.opener?.openUrl;
  if (desktopOpener) {
    void desktopOpener(normalized.url).catch(() => undefined);
    return;
  }
  if (typeof window !== "undefined" && typeof window.open === "function") {
    window.open(normalized.url, "_blank", "noopener,noreferrer");
    return;
  }
  void Linking.openURL(normalized.url).catch(() => undefined);
}

function toggleRightSplitForHub(
  current: ReturnType<typeof usePersonaEmbedSettings>,
  hubId: string,
) {
  if (current.splitEnabled && current.secondaryHubId === hubId) {
    return togglePersonaSplitMode(current, false);
  }
  return openPersonaHubInRightSplit(current, hubId);
}

function buildSplitSummaryLabel(
  activeHub: PersonaHubProfile | null,
  secondaryHub: PersonaHubProfile | null,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  if (!activeHub || !secondaryHub) {
    return "";
  }
  return t("personaEmbed.sidebar.splitActiveSummary", {
    primary: activeHub.name,
    secondary: secondaryHub.name,
  });
}

function deriveHeroDisplayState(input: {
  personaSettings: ReturnType<typeof usePersonaEmbedSettings>;
  pathname: string;
  isCompact: boolean;
  isRowHovered: boolean;
  hasShortcutKeys: boolean;
}) {
  const isSelected = isPersonaPathname(input.pathname);
  const hasMultipleHubs = input.personaSettings.hubs.length >= 2;
  const isExpanded = hasMultipleHubs && input.personaSettings.sidebarExpanded;
  const activeHub = getActivePersonaHub(input.personaSettings);
  const secondaryHub = getSecondaryPersonaHub(input.personaSettings);
  const isSplitActive =
    hasMultipleHubs &&
    !input.isCompact &&
    input.personaSettings.splitEnabled &&
    secondaryHub !== null;

  return {
    isSelected,
    hasMultipleHubs,
    isExpanded,
    activeHub,
    secondaryHub,
    activeHubId: activeHub?.id,
    activeHubUrl: activeHub?.hubUrl ?? "",
    secondaryHubId: secondaryHub?.id,
    isSplitActive,
    isHighlighted: isSelected || input.isRowHovered,
    kebabVisible: input.isRowHovered || isNative || input.isCompact || isSelected,
    showShortcut: input.personaSettings.hideBuiltInMainChatWhenEnabled && input.hasShortcutKeys,
    canToggleSplit: hasMultipleHubs && !input.isCompact,
  };
}

function buildRowEnvelopeStyle(isHighlighted: boolean, isSelected: boolean, isRowPressed: boolean) {
  return [
    styles.rowEnvelope,
    isHighlighted && styles.rowHighlighted,
    isSelected && styles.rowSelected,
    isRowPressed && styles.rowPressed,
  ];
}

export interface PersonaHeroRowProps {
  onBeforeNavigate?: () => void;
  trailingAccessory?: ReactNode;
}

export const PersonaHeroRow = memo(function PersonaHeroRow({
  onBeforeNavigate,
  trailingAccessory,
}: PersonaHeroRowProps): ReactElement | null {
  const { t } = useTranslation();
  const pathname = usePathname();
  const isCompact = useIsCompactFormFactor();
  const personaSettings = usePersonaEmbedSettings();
  const updatePersonaSettings = useUpdatePersonaEmbedSettings();
  const shortcutKeys = useShortcutKeys("open-main-chat");

  const [isRowHovered, setIsRowHovered] = useState(false);
  const [isRowPressed, setIsRowPressed] = useState(false);

  const viewState = useMemo(
    () =>
      deriveHeroDisplayState({
        personaSettings,
        pathname,
        isCompact,
        isRowHovered,
        hasShortcutKeys: Boolean(shortcutKeys),
      }),
    [isCompact, isRowHovered, pathname, personaSettings, shortcutKeys],
  );

  const displayHost = useMemo(
    () => formatPersonaHubDisplayHost(viewState.activeHubUrl),
    [viewState.activeHubUrl],
  );

  const subtitle = useMemo(
    () =>
      formatHeroSubtitle({
        isSplitActive: viewState.isSplitActive,
        hasMultipleHubs: viewState.hasMultipleHubs,
        activeHub: viewState.activeHub,
        secondaryHub: viewState.secondaryHub,
        displayHost,
        splitSummaryText: buildSplitSummaryLabel(viewState.activeHub, viewState.secondaryHub, t),
        unconfiguredText: t("personaEmbed.sidebar.subtitleUnconfigured"),
      }),
    [displayHost, t, viewState],
  );

  const { showKebab, menuProps } = useOpenKebabMenuVisibility(viewState.kebabVisible);

  const handlePointerEnter = useCallback(() => setIsRowHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsRowHovered(false), []);
  const handlePressIn = useCallback(() => setIsRowPressed(true), []);
  const handlePressOut = useCallback(() => setIsRowPressed(false), []);

  const navigateToPersonaIfNeeded = useCallback(() => {
    onBeforeNavigate?.();
    if (!isPersonaPathname(pathname)) {
      router.push(buildPersonaRoute());
    }
  }, [onBeforeNavigate, pathname]);

  const handleOpen = useCallback(() => {
    navigateToPersonaIfNeeded();
  }, [navigateToPersonaIfNeeded]);

  const handleToggleExpand = useCallback(() => {
    void updatePersonaSettings((current) => ({
      sidebarExpanded: !current.sidebarExpanded,
    }));
  }, [updatePersonaSettings]);

  const handleSelectHub = useCallback(
    (hubId: string) => {
      void updatePersonaSettings((current) => selectActivePersonaHub(current, hubId));
      navigateToPersonaIfNeeded();
    },
    [navigateToPersonaIfNeeded, updatePersonaSettings],
  );

  const handleToggleRightSplitForHub = useCallback(
    (hubId: string) => {
      void updatePersonaSettings((current) => toggleRightSplitForHub(current, hubId));
      navigateToPersonaIfNeeded();
    },
    [navigateToPersonaIfNeeded, updatePersonaSettings],
  );

  const handleToggleSplitFromMenu = useCallback(() => {
    void updatePersonaSettings((current) => togglePersonaSplitMode(current));
    navigateToPersonaIfNeeded();
  }, [navigateToPersonaIfNeeded, updatePersonaSettings]);

  const handleReload = useCallback(() => {
    reloadResidentPersonaWebview(viewState.activeHubId);
    navigateToPersonaIfNeeded();
  }, [navigateToPersonaIfNeeded, viewState.activeHubId]);

  const handleOpenExternal = useCallback(() => {
    openPersonaHubExternally(viewState.activeHubUrl);
  }, [viewState.activeHubUrl]);

  const handleOpenSettings = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSettingsSectionRoute("persona"));
  }, [onBeforeNavigate]);

  if (!personaSettings.enabled) {
    return null;
  }

  return (
    <>
      <View style={styles.stickyWrapper} testID="sidebar-persona-hero-container">
        <View style={styles.heroLine}>
          <View
            style={buildRowEnvelopeStyle(
              viewState.isHighlighted,
              viewState.isSelected,
              isRowPressed,
            )}
            onPointerEnter={handlePointerEnter}
            onPointerLeave={handlePointerLeave}
          >
            <View style={[styles.accentRail, viewState.isSelected && styles.accentRailSelected]} />
            <PersonaHeroMainContent
              isSelected={viewState.isSelected}
              isSplitActive={viewState.isSplitActive}
              subtitle={subtitle}
              onPress={handleOpen}
              onPressIn={handlePressIn}
              onPressOut={handlePressOut}
            />

            <View style={styles.trailing}>
              <PersonaHeroTrailingIndicator
                hasMultipleHubs={viewState.hasMultipleHubs}
                isExpanded={viewState.isExpanded}
                showShortcut={viewState.showShortcut}
                shortcutKeys={shortcutKeys}
                onToggleExpand={handleToggleExpand}
              />
              <PersonaHeroMenu
                visible={showKebab}
                open={menuProps.open}
                onOpenChange={menuProps.onOpenChange}
                hasDisplayHost={Boolean(displayHost)}
                canToggleSplit={viewState.canToggleSplit}
                splitEnabled={viewState.isSplitActive}
                onReload={handleReload}
                onToggleSplit={handleToggleSplitFromMenu}
                onOpenExternal={handleOpenExternal}
                onOpenSettings={handleOpenSettings}
              />
            </View>
          </View>
          {trailingAccessory ? <View style={styles.accessorySlot}>{trailingAccessory}</View> : null}
        </View>

        {viewState.isExpanded ? (
          <PersonaHeroExpandedHubList
            hubs={personaSettings.hubs}
            activeHubId={viewState.activeHubId}
            secondaryHubId={viewState.secondaryHubId}
            isSplitActive={viewState.isSplitActive}
            isRouteSelected={viewState.isSelected}
            isCompact={isCompact}
            onSelectHub={handleSelectHub}
            onToggleRightSplit={handleToggleRightSplitForHub}
          />
        ) : null}
      </View>
      <SidebarSeparator testID="sidebar-persona-hero-separator" />
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  stickyWrapper: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[1],
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
  textBlock: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
  },
  splitBadge: {
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
    borderWidth: 1,
    borderColor: theme.colors.accent,
    flexShrink: 0,
  },
  splitBadgeText: {
    color: theme.colors.accent,
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.code,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
    flexShrink: 0,
  },
  shortcutSlot: {
    opacity: 0.85,
  },
  expandButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  expandButtonPressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  kebabButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  accessorySlot: {
    flexShrink: 0,
  },
  hubListContainer: {
    paddingLeft: theme.spacing[3],
    paddingTop: 2,
    gap: 2,
  },
  subRowEnvelope: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: "transparent",
    backgroundColor: "transparent",
    overflow: "hidden",
  },
  subRowHovered: {
    backgroundColor: theme.colors.surface2,
  },
  subRowSelected: {
    backgroundColor: theme.colors.surface2,
    borderColor: theme.colors.border,
  },
  subRowMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 6,
    borderRadius: theme.borderRadius.lg,
  },
  subRowPressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
  },
  statusDotPrimary: {
    backgroundColor: theme.colors.accent,
  },
  statusDotSecondary: {
    backgroundColor: theme.colors.primary,
  },
  statusDotWarning: {
    backgroundColor: theme.colors.statusWarning,
  },
  statusDotIdle: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  subRowTextBlock: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  subRowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  subRowTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  subRowTitleActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  roleBadge: {
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface3,
    flexShrink: 0,
  },
  roleBadgeSecondary: {
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  roleBadgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    fontWeight: theme.fontWeight.medium,
  },
  subRowHost: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.code,
  },
  subRowSplitButton: {
    width: 26,
    height: 26,
    marginRight: 4,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  subRowSplitButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  subRowSplitButtonPressed: {
    backgroundColor: theme.colors.interactionHighlight,
  },
}));
