import { PressHighlight as Pressable } from "@/components/ui/press-highlight";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { HEADER_INNER_HEIGHT, HEADER_INNER_HEIGHT_MOBILE } from "@/constants/layout";
import { DensityIcon } from "@/components/ui/density-icon";
import { Shortcut } from "@/components/ui/shortcut";
import { isWeb } from "@/constants/platform";
import { density, densityIconBox } from "@/styles/density";
import type { ShortcutKey } from "@/utils/format-shortcut";

/**
 * Set to `true` inside the sidebar nav overflow menu so rows use popover-surface
 * hover fills (`surface2` on `surface1`) and participate in menu keyboard navigation.
 */
export const SidebarHeaderRowInMenuContext = createContext(false);

const MENU_ITEM_DATASET = { menuItem: "true" } as const;

type SidebarHeaderRowVariant = "header" | "compact" | "inline";

export type SidebarRowIcon = ComponentType<{ size: number; color: string }>;

interface SidebarHeaderRowProps {
  icon: SidebarRowIcon | null;
  label: string;
  onPress: () => void;
  isActive?: boolean;
  expanded?: boolean;
  testID?: string;
  nativeID?: string;
  accessibilityLabel?: string;
  /**
   * "header" (default): a sidebar-height row with its own bottom separator —
   * the lone header at the top of a sidebar (settings "Back to workspace").
   * "compact": a row with no separator, for entries that
   * sit in a header group whose wrapper owns the single divider.
   * "inline": a full-width row with no inset, for a row inside a padded container such as the
   * sidebar footer.
   */
  variant?: SidebarHeaderRowVariant;
  /** Shown in the right slot while the row is hovered, when `trailing` is not set. */
  shortcutKeys?: ShortcutKey[][] | null;
  /**
   * The right slot. A sibling of the row's button, never inside it (web cannot nest buttons). A
   * press on the slot presses the row; a button inside it presses on its own.
   */
  trailing?: ReactNode;
  rowRef?: Ref<View>;
}

export function SidebarHeaderRow({
  icon,
  label,
  onPress,
  isActive = false,
  expanded,
  testID,
  nativeID,
  accessibilityLabel,
  variant = "header",
  shortcutKeys = null,
  trailing,
  rowRef,
}: SidebarHeaderRowProps) {
  const inMenu = useContext(SidebarHeaderRowInMenuContext);
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const [isFocused, setIsFocused] = useState(false);
  const handleFocus = useCallback(() => setIsFocused(true), []);
  const handleBlur = useCallback(() => setIsFocused(false), []);
  // The button and its trailing slot are siblings, so the row owns the pressed fill for both.
  const [isPressed, setIsPressed] = useState(false);
  const handlePressIn = useCallback(() => setIsPressed(true), []);
  const handlePressOut = useCallback(() => setIsPressed(false), []);
  const isHighlighted = isRowHighlighted({ isHovered, isActive, inMenu, isFocused });
  const iconSize = variant === "header" ? "md" : "sm";
  const accessibilityState = useMemo(
    () => resolveRowAccessibilityState(isActive, expanded),
    [expanded, isActive],
  );
  const webExpandedProp = resolveWebExpandedProp(expanded);
  const menuButtonProps = resolveMenuButtonProps(inMenu, handleFocus, handleBlur);
  const right = resolveTrailingContent(trailing, shortcutKeys, isHovered);

  return (
    <View ref={rowRef} collapsable={false} style={getContainerStyle(variant, inMenu)}>
      <View
        style={getRowStyle(isHighlighted, isPressed, inMenu)}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <Pressable
          {...webExpandedProp}
          {...menuButtonProps}
          onPress={onPress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          testID={testID}
          nativeID={nativeID}
          accessible
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityState={accessibilityState}
          aria-selected={isActive}
          style={inMenu ? styles.buttonInMenu : styles.button}
        >
          {icon ? (
            <DensityIcon
              icon={icon}
              size={iconSize}
              color={isHighlighted ? "foreground" : "foregroundMuted"}
            />
          ) : (
            <View style={variant === "header" ? styles.iconSpacer : styles.iconSpacerCompact} />
          )}
          <Text style={[styles.label, isHighlighted && styles.labelHighlighted]}>{label}</Text>
        </Pressable>
        {right === null ? null : (
          <Pressable
            onPress={onPress}
            onPressIn={handlePressIn}
            onPressOut={handlePressOut}
            accessible={false}
            focusable={false}
            style={styles.trailing}
          >
            {right}
          </Pressable>
        )}
      </View>
    </View>
  );
}

const SELECTED_STATE = { selected: true } as const;

const styles = StyleSheet.create((theme) => ({
  container: {
    height: {
      xs: HEADER_INNER_HEIGHT_MOBILE,
      md: HEADER_INNER_HEIGHT,
    },
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    userSelect: "none",
  },
  containerCompact: {
    paddingHorizontal: theme.spacing[2],
    justifyContent: "center",
    userSelect: "none",
  },
  containerInMenu: {
    paddingHorizontal: theme.spacing[1],
    justifyContent: "center",
    userSelect: "none",
  },
  containerInline: {
    width: "100%",
    justifyContent: "center",
    userSelect: "none",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    // Same row geometry as the settings sidebar items. Shorter than the header
    // strip so the hover highlight clears the strip's bottom separator.
    minHeight: density.tightRowHeight,
    borderRadius: theme.borderRadius.lg,
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  // Popover surfaces sit on `surface1`, where `surfaceSidebarHover` can match the background.
  rowHighlightedInMenu: {
    backgroundColor: theme.colors.surface2,
  },
  // The workspace rows' pressed fill.
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  button: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: density.tightRowHeight,
    paddingVertical: theme.spacing[1],
    // Match the project rows' inner padding so the icons align on one vertical
    // edge with the list below.
    paddingHorizontal: theme.spacing[2],
  },
  buttonInMenu: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: density.tightRowHeight,
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  iconSpacer: { width: densityIconBox("md"), height: densityIconBox("md") },
  iconSpacerCompact: { width: densityIconBox("sm"), height: densityIconBox("sm") },
  label: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
  },
  labelHighlighted: {
    color: theme.colors.foreground,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
  },
}));

function isRowHighlighted(input: {
  isHovered: boolean;
  isActive: boolean;
  inMenu: boolean;
  isFocused: boolean;
}): boolean {
  return input.isHovered || input.isActive || (input.inMenu && input.isFocused);
}

function getRowStyle(isHighlighted: boolean, isPressed: boolean, inMenu: boolean) {
  return [
    styles.row,
    isHighlighted && (inMenu ? styles.rowHighlightedInMenu : styles.rowHighlighted),
    isPressed && styles.rowPressed,
  ];
}

function resolveMenuButtonProps(inMenu: boolean, onFocus: () => void, onBlur: () => void) {
  if (!inMenu) return null;
  return {
    dataSet: MENU_ITEM_DATASET,
    onFocus,
    onBlur,
  } as const;
}

function resolveTrailingContent(
  trailing: ReactNode,
  shortcutKeys: ShortcutKey[][] | null,
  isHovered: boolean,
): ReactNode {
  if (trailing !== undefined && trailing !== null) {
    return trailing;
  }
  return shortcutKeys && isHovered ? <Shortcut chord={shortcutKeys} /> : null;
}

function resolveRowAccessibilityState(isActive: boolean, expanded: boolean | undefined) {
  if (expanded !== undefined) {
    return isActive ? { selected: true, expanded } : { expanded };
  }
  return isActive ? SELECTED_STATE : undefined;
}

function resolveWebExpandedProp(expanded: boolean | undefined) {
  return isWeb && expanded !== undefined ? ({ "aria-expanded": expanded } as const) : null;
}

function getContainerStyle(variant: SidebarHeaderRowVariant, inMenu: boolean) {
  if (inMenu && variant === "compact") {
    return styles.containerInMenu;
  }
  switch (variant) {
    case "header":
      return styles.container;
    case "compact":
      return styles.containerCompact;
    case "inline":
      return styles.containerInline;
  }
}
