import * as Linking from "expo-linking";
import { router, usePathname } from "expo-router";
import { Bot, ChevronRight, Ellipsis, ExternalLink, RotateCw, Settings } from "lucide-react-native";
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
import { formatPersonaHubDisplayHost, normalizePersonaHubUrl } from "./settings";
import { usePersonaEmbedSettings } from "./use-persona-settings";

const ThemedBot = withUnistyles(Bot);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedSettings = withUnistyles(Settings);

const accentForegroundIconMapping = (theme: Theme) => ({ color: theme.colors.accentForeground });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const reloadIcon = <ThemedRotateCw size={14} uniProps={mutedIconMapping} />;
const openExternalIcon = <ThemedExternalLink size={14} uniProps={mutedIconMapping} />;
const settingsIcon = <ThemedSettings size={14} uniProps={mutedIconMapping} />;

const SELECTED_STATE = { selected: true } as const;

export function useShouldShowPersonaHero(): boolean {
  return usePersonaEmbedSettings().enabled;
}

interface PersonaHeroMenuProps {
  visible: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasDisplayHost: boolean;
  onReload: () => void;
  onOpenExternal: () => void;
  onOpenSettings: () => void;
}

const PersonaHeroMenu = memo(function PersonaHeroMenu({
  visible,
  open,
  onOpenChange,
  hasDisplayHost,
  onReload,
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
  const shortcutKeys = useShortcutKeys("open-main-chat");

  const [isRowHovered, setIsRowHovered] = useState(false);
  const [isRowPressed, setIsRowPressed] = useState(false);

  const isSelected = isPersonaPathname(pathname);
  const displayHost = useMemo(
    () => formatPersonaHubDisplayHost(personaSettings.hubUrl),
    [personaSettings.hubUrl],
  );
  const subtitle = displayHost ?? t("personaEmbed.sidebar.subtitleUnconfigured");

  const { showKebab, menuProps } = useOpenKebabMenuVisibility(
    isRowHovered || isNative || isCompact || isSelected,
  );

  const handlePointerEnter = useCallback(() => setIsRowHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsRowHovered(false), []);
  const handlePressIn = useCallback(() => setIsRowPressed(true), []);
  const handlePressOut = useCallback(() => setIsRowPressed(false), []);

  const handleOpen = useCallback(() => {
    onBeforeNavigate?.();
    const targetRoute = buildPersonaRoute();
    if (isPersonaPathname(pathname)) {
      return;
    }
    router.push(targetRoute);
  }, [onBeforeNavigate, pathname]);

  const handleReload = useCallback(() => {
    reloadResidentPersonaWebview();
    if (!isPersonaPathname(pathname)) {
      onBeforeNavigate?.();
      router.push(buildPersonaRoute());
    }
  }, [onBeforeNavigate, pathname]);

  const handleOpenExternal = useCallback(() => {
    const normalized = normalizePersonaHubUrl(personaSettings.hubUrl);
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
  }, [personaSettings.hubUrl]);

  const handleOpenSettings = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSettingsSectionRoute("persona"));
  }, [onBeforeNavigate]);

  if (!personaSettings.enabled) {
    return null;
  }

  const isHighlighted = isSelected || isRowHovered;
  const showShortcut = personaSettings.hideBuiltInMainChatWhenEnabled && Boolean(shortcutKeys);

  return (
    <>
      <View style={styles.stickyWrapper} testID="sidebar-persona-hero-container">
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
              accessibilityLabel={t("personaEmbed.sidebar.accessibilityLabel")}
              accessibilityState={isSelected ? SELECTED_STATE : undefined}
              testID="sidebar-persona-hero"
            >
              <View style={[styles.iconBadge, isSelected && styles.iconBadgeSelected]}>
                <ThemedBot size={18} uniProps={accentForegroundIconMapping} />
              </View>
              <View style={styles.textBlock}>
                <Text numberOfLines={1} ellipsizeMode="tail" style={styles.title}>
                  {t("personaEmbed.sidebar.title")}
                </Text>
                <Text numberOfLines={1} ellipsizeMode="middle" style={styles.subtitle}>
                  {subtitle}
                </Text>
              </View>
            </PressHighlight>

            <View style={styles.trailing}>
              {showShortcut && shortcutKeys ? (
                <View style={styles.shortcutSlot}>
                  <Shortcut chord={shortcutKeys} />
                </View>
              ) : (
                <ThemedChevronRight size={14} uniProps={mutedIconMapping} />
              )}
              <PersonaHeroMenu
                visible={showKebab}
                open={menuProps.open}
                onOpenChange={menuProps.onOpenChange}
                hasDisplayHost={Boolean(displayHost)}
                onReload={handleReload}
                onOpenExternal={handleOpenExternal}
                onOpenSettings={handleOpenSettings}
              />
            </View>
          </View>
          {trailingAccessory ? <View style={styles.accessorySlot}>{trailingAccessory}</View> : null}
        </View>
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
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
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
}));
