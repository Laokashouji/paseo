import { router, usePathname } from "expo-router";
import {
  CalendarClock,
  ChevronRight,
  History,
  MoreHorizontal,
  Plus,
  Search,
} from "lucide-react-native";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Text,
  View,
  useWindowDimensions,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  SidebarHeaderRow,
  SidebarHeaderRowInMenuContext,
} from "@/components/sidebar/sidebar-header-row";
import {
  partitionSidebarNavItems,
  resolveDefaultSidebarNavMaxHeight,
  resolveEffectiveSidebarNavMaxHeight,
  resolveSidebarNavBounds,
  resolveSidebarNavMetrics,
  resolveUnitRowHeight,
} from "@/components/sidebar/sidebar-nav-overflow-layout";
import {
  useSidebarNavSectionContext,
  type SidebarNavLayoutSnapshot,
} from "@/components/sidebar/sidebar-nav-section-context";
import { controlSizingForLayout } from "@/components/ui/control-geometry";
import { DensityIcon } from "@/components/ui/density-icon";
import { MenuRoot, MenuSurface, useMenuContext } from "@/components/ui/menu";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { buildPluginSurfaceRoute } from "@/plugins/routes";
import { PluginSidebarItem } from "@/plugins/sidebar-items";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import {
  builtinSidebarNavLabelKey,
  builtinSidebarNavShortcutAction,
  type BuiltinSidebarNavId,
  type SidebarNavItem,
} from "@/sidebar-nav/model";
import { useSidebarNavItems } from "@/sidebar-nav/use-sidebar-nav-items";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useSidebarNavLayoutStore } from "@/stores/sidebar-nav-layout-store";
import {
  buildNewWorkspaceRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
} from "@/utils/host-routes";

interface SidebarNavRowProps {
  onBeforeNavigate?: () => void;
  /** Called before opening Command Center from the overflow menu so the menu closes first. */
  onBeforeOpenSearch?: () => void;
}

interface SidebarNavRowsProps {
  onBeforeNavigate?: () => void;
  /** Style for the group wrapper, which the sidebar owns. */
  style?: StyleProp<ViewStyle>;
  /** Sits to the right of the first row, which shrinks to make room. */
  firstRowTrailing?: ReactNode;
}

/** The top-level items the user keeps visible, in display order. */
export function useVisibleSidebarNavItems() {
  const { items } = useSidebarNavItems("header");
  return useMemo(() => items.filter((item) => item.visible), [items]);
}

function isSidebarNavItemActive(item: SidebarNavItem<"header">, pathname: string): boolean {
  if (item.kind === "builtin") {
    if (item.id === "history") return pathname.includes("/sessions");
    if (item.id === "schedules") return pathname.includes("/schedules");
    return false;
  }
  if (item.group.kind === "legacy") {
    const identity = { kind: "sidebar", id: item.group.contributionId } as const;
    return item.group.targets.some(
      (candidate) =>
        pathname ===
        buildPluginSurfaceRoute(candidate.plugin.serverId, item.group.pluginId, identity),
    );
  }
  return false;
}

function renderNavItem(
  item: SidebarNavItem<"header">,
  options: {
    fallbackAnchorRef: RefObject<View | null>;
    onBeforeNavigate?: () => void;
    onBeforeOpenSearch?: () => void;
  },
) {
  if (item.kind === "plugin") {
    return (
      <PluginSidebarItem
        key={item.key}
        group={item.group}
        section="header"
        fallbackAnchorRef={options.fallbackAnchorRef}
        onBeforeNavigate={options.onBeforeNavigate}
      />
    );
  }
  const Row = BUILTIN_ROWS[item.id];
  return (
    <Row
      key={item.key}
      onBeforeNavigate={options.onBeforeNavigate}
      onBeforeOpenSearch={options.onBeforeOpenSearch}
    />
  );
}

const MeasuredNavItem = memo(function MeasuredNavItem({
  itemKey,
  onMeasure,
  children,
}: {
  itemKey: string;
  onMeasure: (key: string, height: number) => void;
  children: ReactNode;
}) {
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const nextHeight = Math.ceil(event.nativeEvent.layout.height);
      onMeasure(itemKey, nextHeight);
    },
    [itemKey, onMeasure],
  );

  return (
    <View collapsable={false} onLayout={handleLayout}>
      {children}
    </View>
  );
});

/**
 * Top-level sidebar navigation, ordered and filtered by the user's
 * `sidebarNavItems` preference. Caps height to the user's dragged height (or a
 * sensible default) and moves remaining items into a secondary "More" menu so
 * long plugin lists never crowd out workspaces.
 */
export function SidebarNavRows({ style, onBeforeNavigate, firstRowTrailing }: SidebarNavRowsProps) {
  const visibleItems = useVisibleSidebarNavItems();
  const compact = useIsCompactFormFactor();
  const { height: windowHeight } = useWindowDimensions();
  const preferredMaxHeight = useSidebarNavLayoutStore((state) => state.maxHeight);
  const sectionContext = useSidebarNavSectionContext();
  const dragHeight = sectionContext?.dragHeight ?? null;

  const groupRef = useRef<View | null>(null);
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  const [measuredTriggerHeight, setMeasuredTriggerHeight] = useState<number | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);

  const handleMeasureItem = useCallback((key: string, height: number) => {
    setMeasuredHeights((current) => {
      if (current[key] === height) return current;
      return { ...current, [key]: height };
    });
  }, []);

  const handleMeasureTrigger = useCallback((height: number) => {
    setMeasuredTriggerHeight((current) => (current === height ? current : height));
  }, []);

  const handleDragStart = useCallback(() => {
    setOverflowOpen(false);
  }, []);

  const itemKeys = useMemo(() => visibleItems.map((item) => item.key), [visibleItems]);
  const touchSized = controlSizingForLayout(compact) === "touch";
  const metrics = useMemo(
    () => resolveSidebarNavMetrics({ compact, touchSized }),
    [compact, touchSized],
  );
  const unitRowHeight = useMemo(
    () =>
      resolveUnitRowHeight({
        itemKeys,
        measuredHeights,
        defaultRowHeight: metrics.defaultRowHeight,
      }),
    [itemKeys, measuredHeights, metrics.defaultRowHeight],
  );
  const overflowTriggerHeight = measuredTriggerHeight ?? unitRowHeight;
  const minHeight = metrics.paddingTop + overflowTriggerHeight + metrics.paddingBottom;
  const defaultMaxHeight = resolveDefaultSidebarNavMaxHeight({
    unitRowHeight,
    slotCount: metrics.defaultSlotCount,
    rowGap: metrics.rowGap,
    paddingTop: metrics.paddingTop,
    paddingBottom: metrics.paddingBottom,
  });

  // First pass to know full content height for viewport/drag bounds.
  const fullPartition = useMemo(
    () =>
      partitionSidebarNavItems({
        itemKeys,
        measuredHeights,
        defaultRowHeight: unitRowHeight,
        rowGap: metrics.rowGap,
        paddingTop: metrics.paddingTop,
        paddingBottom: metrics.paddingBottom,
        overflowTriggerHeight,
        maxHeight: Number.POSITIVE_INFINITY,
      }),
    [
      itemKeys,
      measuredHeights,
      metrics.paddingBottom,
      metrics.paddingTop,
      metrics.rowGap,
      overflowTriggerHeight,
      unitRowHeight,
    ],
  );

  const bounds = useMemo(
    () =>
      resolveSidebarNavBounds({
        viewportHeight: windowHeight,
        fullContentHeight: fullPartition.fullContentHeight,
        minHeight,
      }),
    [fullPartition.fullContentHeight, minHeight, windowHeight],
  );

  const effectiveMaxHeight =
    dragHeight !== null
      ? Math.max(bounds.minHeight, Math.min(bounds.maxDragHeight, dragHeight))
      : resolveEffectiveSidebarNavMaxHeight({
          preferredMaxHeight,
          defaultMaxHeight,
          minHeight: bounds.minHeight,
          viewportMaxHeight: bounds.viewportMaxHeight,
        });

  const partition = useMemo(
    () =>
      partitionSidebarNavItems({
        itemKeys,
        measuredHeights,
        defaultRowHeight: unitRowHeight,
        rowGap: metrics.rowGap,
        paddingTop: metrics.paddingTop,
        paddingBottom: metrics.paddingBottom,
        overflowTriggerHeight,
        maxHeight: effectiveMaxHeight,
      }),
    [
      effectiveMaxHeight,
      itemKeys,
      measuredHeights,
      metrics.paddingBottom,
      metrics.paddingTop,
      metrics.rowGap,
      overflowTriggerHeight,
      unitRowHeight,
    ],
  );

  const inlineItems = useMemo(
    () => visibleItems.slice(0, partition.visibleCount),
    [partition.visibleCount, visibleItems],
  );
  const overflowItems = useMemo(
    () => visibleItems.slice(partition.visibleCount),
    [partition.visibleCount, visibleItems],
  );

  useEffect(() => {
    if (overflowItems.length === 0 && overflowOpen) {
      setOverflowOpen(false);
    }
  }, [overflowItems.length, overflowOpen]);

  // Publish the latest layout metrics synchronously so resize drags always read fresh bounds.
  if (sectionContext) {
    const snapshot: SidebarNavLayoutSnapshot = {
      minHeight: bounds.minHeight,
      maxDragHeight: bounds.maxDragHeight,
      fittedHeight: partition.fittedHeight,
      resolveCommitHeight: (clampedHeight) => {
        const committed = partitionSidebarNavItems({
          itemKeys,
          measuredHeights,
          defaultRowHeight: unitRowHeight,
          rowGap: metrics.rowGap,
          paddingTop: metrics.paddingTop,
          paddingBottom: metrics.paddingBottom,
          overflowTriggerHeight,
          maxHeight: clampedHeight,
        });
        return committed.overflowCount === 0 ? committed.fullContentHeight : committed.fittedHeight;
      },
      onDragStart: handleDragStart,
    };
    sectionContext.snapshotRef.current = snapshot;
  }

  if (visibleItems.length === 0 && !firstRowTrailing) return null;

  const renderedInlineRows = inlineItems.map((item) => (
    <MeasuredNavItem key={item.key} itemKey={item.key} onMeasure={handleMeasureItem}>
      {renderNavItem(item, {
        fallbackAnchorRef: groupRef,
        onBeforeNavigate,
      })}
    </MeasuredNavItem>
  ));

  const overflowTrigger =
    overflowItems.length > 0 ? (
      <SidebarNavOverflowMenu
        items={overflowItems}
        open={overflowOpen}
        onOpenChange={setOverflowOpen}
        onBeforeNavigate={onBeforeNavigate}
        onMeasureTrigger={handleMeasureTrigger}
      />
    ) : null;

  const [firstInlineRow, ...restInlineRows] = renderedInlineRows;
  const firstRowContent = firstInlineRow ?? overflowTrigger;
  const trailingOverflowTrigger = firstInlineRow ? overflowTrigger : null;

  return (
    <View ref={groupRef} collapsable={false} style={style}>
      {firstRowTrailing ? (
        <View style={styles.firstRow}>
          <View style={styles.firstRowItem}>{firstRowContent}</View>
          {firstRowTrailing}
        </View>
      ) : (
        firstRowContent
      )}
      {restInlineRows}
      {trailingOverflowTrigger}
    </View>
  );
}

function SidebarNavOverflowMenu({
  items,
  open,
  onOpenChange,
  onBeforeNavigate,
  onMeasureTrigger,
}: {
  items: readonly SidebarNavItem<"header">[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBeforeNavigate?: () => void;
  onMeasureTrigger: (height: number) => void;
}) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const overflowListRef = useRef<View | null>(null);

  const hasActiveItem = useMemo(
    () => items.some((item) => isSidebarNavItemActive(item, pathname)),
    [items, pathname],
  );

  const handleToggle = useCallback(() => {
    onOpenChange(!open);
  }, [onOpenChange, open]);

  const handleOverflowBeforeNavigate = useCallback(() => {
    onOpenChange(false);
    onBeforeNavigate?.();
  }, [onBeforeNavigate, onOpenChange]);

  const handleOverflowBeforeSearch = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  const handleTriggerLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onMeasureTrigger(Math.ceil(event.nativeEvent.layout.height));
    },
    [onMeasureTrigger],
  );

  return (
    <MenuRoot compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      <SidebarNavOverflowTriggerRow
        count={items.length}
        open={open}
        hasActiveItem={hasActiveItem}
        onPress={handleToggle}
        onLayout={handleTriggerLayout}
      />
      <MenuSurface
        side="right"
        align="start"
        offset={8}
        minWidth={220}
        maxWidth={300}
        maxHeight={440}
        scrollable
        sheetTitle={t("sidebar.nav.more")}
        testID="sidebar-nav-overflow-menu"
      >
        <SidebarHeaderRowInMenuContext.Provider value={true}>
          <View ref={overflowListRef} collapsable={false} style={styles.overflowMenuList}>
            {items.map((item) =>
              renderNavItem(item, {
                fallbackAnchorRef: overflowListRef,
                onBeforeNavigate: handleOverflowBeforeNavigate,
                onBeforeOpenSearch: handleOverflowBeforeSearch,
              }),
            )}
          </View>
        </SidebarHeaderRowInMenuContext.Provider>
      </MenuSurface>
    </MenuRoot>
  );
}

function SidebarNavOverflowTriggerRow({
  count,
  open,
  hasActiveItem,
  onPress,
  onLayout,
}: {
  count: number;
  open: boolean;
  hasActiveItem: boolean;
  onPress: () => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const { t } = useTranslation();
  const { triggerRef } = useMenuContext("SidebarNavOverflowTriggerRow");

  const setTriggerNode = useCallback(
    (node: View | null) => {
      Object.assign(triggerRef, { current: node });
    },
    [triggerRef],
  );

  const trailing = useMemo(
    () => (
      <View style={styles.overflowTrailing}>
        {hasActiveItem ? <View style={styles.overflowActiveDot} /> : null}
        <Text style={[styles.overflowCount, open && styles.overflowCountActive]}>{count}</Text>
        <DensityIcon
          icon={ChevronRight}
          size="xs"
          color={open ? "foreground" : "foregroundMuted"}
        />
      </View>
    ),
    [count, hasActiveItem, open],
  );

  return (
    <View collapsable={false} onLayout={onLayout}>
      <SidebarHeaderRow
        rowRef={setTriggerNode}
        icon={MoreHorizontal}
        label={t("sidebar.nav.more")}
        accessibilityLabel={t("sidebar.nav.moreAccessibility", { count })}
        onPress={onPress}
        isActive={open}
        expanded={open}
        variant="compact"
        trailing={trailing}
        testID="sidebar-nav-overflow-trigger"
      />
    </View>
  );
}

const SidebarNewWorkspaceRow = memo(function SidebarNewWorkspaceRow({
  onBeforeNavigate,
}: SidebarNavRowProps) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("new-workspace"));
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const activeWorkspaceServerId = activeWorkspaceSelection?.serverId ?? null;
  const activeWorkspaceId = activeWorkspaceSelection?.workspaceId ?? null;
  const activeWorkspace = useWorkspace(activeWorkspaceServerId, activeWorkspaceId);
  const supportsWorkspaceMultiplicity = useHostFeature(
    activeWorkspaceServerId,
    "workspaceMultiplicity",
  );
  const canUseActiveWorkspaceContext = Boolean(
    activeWorkspace &&
    (supportsWorkspaceMultiplicity || canCreateWorktreeForProjectKind(activeWorkspace.projectKind)),
  );

  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(
      activeWorkspaceServerId
        ? buildNewWorkspaceRoute(
            activeWorkspace && canUseActiveWorkspaceContext
              ? {
                  serverId: activeWorkspaceServerId,
                  sourceDirectory: activeWorkspace.projectRootPath,
                  projectId: activeWorkspace.projectId,
                }
              : { serverId: activeWorkspaceServerId },
          )
        : buildNewWorkspaceRoute(),
    );
  }, [activeWorkspace, activeWorkspaceServerId, canUseActiveWorkspaceContext, onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={Plus}
      label={t(builtinSidebarNavLabelKey("new-workspace"))}
      onPress={handlePress}
      testID="sidebar-global-new-workspace"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
});

function SidebarHistoryRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSessionsRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={History}
      label={t(builtinSidebarNavLabelKey("history"))}
      onPress={handlePress}
      isActive={pathname.includes("/sessions")}
      testID="sidebar-sessions"
      variant="compact"
    />
  );
}

function SidebarSearchRow({ onBeforeOpenSearch }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const shortcutKeys = useShortcutKeys(builtinSidebarNavShortcutAction("search"));
  const setCommandCenterOpen = useKeyboardShortcutsStore((state) => state.setCommandCenterOpen);
  const handlePress = useCallback(() => {
    onBeforeOpenSearch?.();
    setCommandCenterOpen(true);
  }, [onBeforeOpenSearch, setCommandCenterOpen]);

  return (
    <SidebarHeaderRow
      icon={Search}
      label={t(builtinSidebarNavLabelKey("search"))}
      onPress={handlePress}
      testID="sidebar-search"
      variant="compact"
      shortcutKeys={shortcutKeys}
    />
  );
}

function SidebarSchedulesRow({ onBeforeNavigate }: SidebarNavRowProps) {
  const { t } = useTranslation();
  const pathname = usePathname();
  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildSchedulesRoute());
  }, [onBeforeNavigate]);

  return (
    <SidebarHeaderRow
      icon={CalendarClock}
      label={t(builtinSidebarNavLabelKey("schedules"))}
      onPress={handlePress}
      isActive={pathname.includes("/schedules")}
      testID="sidebar-schedules"
      variant="compact"
    />
  );
}

const BUILTIN_ROWS: Record<BuiltinSidebarNavId, ComponentType<SidebarNavRowProps>> = {
  "new-workspace": SidebarNewWorkspaceRow,
  history: SidebarHistoryRow,
  search: SidebarSearchRow,
  schedules: SidebarSchedulesRow,
};

const styles = StyleSheet.create((theme) => ({
  firstRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  firstRowItem: {
    flex: 1,
    minWidth: 0,
  },
  overflowTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  overflowActiveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.colors.accent,
  },
  overflowCount: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
  overflowCountActive: {
    color: theme.colors.foreground,
  },
  overflowMenuList: {
    gap: 2,
  },
}));
