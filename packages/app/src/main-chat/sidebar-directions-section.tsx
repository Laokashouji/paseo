import { router, usePathname } from "expo-router";
import equal from "fast-deep-equal";
import { Compass, History, Plus } from "lucide-react-native";
import { memo, useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { create } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { PressHighlight } from "@/components/ui/press-highlight";
import {
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import {
  buildMainChatConversationRoute,
  buildMainChatHistoryRoute,
  parseMainChatConversationIdFromPathname,
} from "@/utils/host-routes";
import { selectMainChatSidebarSummary } from "./selectors";

const ThemedPlus = withUnistyles(Plus);
const ThemedHistory = withUnistyles(History);
const ThemedCompass = withUnistyles(Compass);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export interface MainChatDirectionEntry {
  conversationId: string;
  title: string;
  runningCount: number;
  needsYouCount: number;
}

interface DirectionsSectionStoreState {
  collapsed: boolean;
  toggleCollapsed: () => void;
  setCollapsed: (collapsed: boolean) => void;
}

export const useMainChatDirectionsSectionStore = create<DirectionsSectionStoreState>((set) => ({
  collapsed: false,
  toggleCollapsed() {
    set((state) => ({ collapsed: !state.collapsed }));
  },
  setCollapsed(collapsed) {
    set({ collapsed });
  },
}));

export interface SidebarDirectionsSectionProps {
  onBeforeNavigate?: () => void;
  /** Direction / side conversations provided by M4; empty in M1 displays history & guidance. */
  directions?: readonly MainChatDirectionEntry[];
}

function formatCollapsedCounts(
  runningCount: number,
  needsYouCount: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (needsYouCount > 0 && runningCount > 0) {
    return t("mainChat.directions.summaryNeedsYouRunning", {
      needsYou: needsYouCount,
      running: runningCount,
    });
  }
  if (needsYouCount > 0) {
    return t("mainChat.directions.summaryNeedsYou", { count: needsYouCount });
  }
  if (runningCount > 0) {
    return t("mainChat.directions.summaryRunning", { count: runningCount });
  }
  return null;
}

const DirectionRow = memo(function DirectionRow({
  entry,
  isSelected,
  onSelect,
}: {
  entry: MainChatDirectionEntry;
  isSelected: boolean;
  onSelect: (conversationId: string) => void;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(() => {
    onSelect(entry.conversationId);
  }, [entry.conversationId, onSelect]);

  const countsLabel = formatCollapsedCounts(entry.runningCount, entry.needsYouCount, t);
  const isHighlighted = isHovered || isSelected;

  return (
    <View
      style={[styles.rowEnvelope, isHighlighted && styles.rowHighlighted]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        onPress={handlePress}
        style={styles.rowButton}
        highlightStyle={styles.rowPressed}
        accessibilityRole="button"
        accessibilityLabel={entry.title}
        testID={`sidebar-direction-row-${entry.conversationId}`}
      >
        <ThemedCompass
          size={14}
          uniProps={isHighlighted ? foregroundIconMapping : mutedIconMapping}
        />
        <Text
          style={[styles.rowTitle, isHighlighted && styles.rowTitleHighlighted]}
          numberOfLines={1}
        >
          {entry.title}
        </Text>
        {countsLabel ? (
          <Text style={styles.rowCounts} numberOfLines={1}>
            {countsLabel}
          </Text>
        ) : null}
      </PressHighlight>
    </View>
  );
});

/**
 * Dedicated "Conversations & directions" section positioned between the sticky Main Chat hero
 * entry and the regular coding Workspaces list. Ready for M4 to populate Leader / Side threads.
 */
export const SidebarDirectionsSection = memo(function SidebarDirectionsSection({
  onBeforeNavigate,
  directions = EMPTY_DIRECTIONS,
}: SidebarDirectionsSectionProps): ReactElement | null {
  const { t } = useTranslation();
  const pathname = usePathname();
  const activeWorkspace = useActiveWorkspaceSelection();
  const lastWorkspace = useLastWorkspaceSelection();
  const preferredServerId = activeWorkspace?.serverId ?? lastWorkspace?.serverId ?? null;

  const collapsed = useMainChatDirectionsSectionStore((state) => state.collapsed);
  const toggleCollapsed = useMainChatDirectionsSectionStore((state) => state.toggleCollapsed);

  const [isHistoryHovered, setIsHistoryHovered] = useState(false);
  const handleHistoryPointerEnter = useCallback(() => setIsHistoryHovered(true), []);
  const handleHistoryPointerLeave = useCallback(() => setIsHistoryHovered(false), []);

  const summary = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => {
        const result = selectMainChatSidebarSummary(state, preferredServerId);
        return {
          supportsMainChat: result.supportsMainChat,
          runningCount: result.runningCount,
          needsYouCount: result.needsYouCount,
        };
      },
      [preferredServerId],
    ),
    equal,
  );

  const handleOpenHistory = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildMainChatHistoryRoute());
  }, [onBeforeNavigate]);

  const handleOpenDirection = useCallback(
    (conversationId: string) => {
      onBeforeNavigate?.();
      router.push(buildMainChatConversationRoute(conversationId));
    },
    [onBeforeNavigate],
  );

  if (!summary.supportsMainChat) {
    return null;
  }

  const collapsedSummary = collapsed
    ? formatCollapsedCounts(summary.runningCount, summary.needsYouCount, t)
    : null;
  const activeConversationId = parseMainChatConversationIdFromPathname(pathname);
  const isHistoryActive = pathname === buildMainChatHistoryRoute();
  const isHistoryHighlighted = isHistoryHovered || isHistoryActive;

  return (
    <>
      <View style={styles.section} testID="sidebar-directions-section">
        <SidebarSectionHeader
          title={t("mainChat.directions.title")}
          collapsed={collapsed}
          onToggle={toggleCollapsed}
          testID="sidebar-directions-section-header"
        >
          {collapsedSummary ? (
            <View style={styles.collapsedSummaryPill} testID="sidebar-directions-collapsed-summary">
              {summary.needsYouCount > 0 ? <View style={styles.dotNeedsYou} /> : null}
              {summary.runningCount > 0 && summary.needsYouCount === 0 ? (
                <View style={styles.dotRunning} />
              ) : null}
              <Text style={styles.collapsedSummaryText} numberOfLines={1}>
                {collapsedSummary}
              </Text>
            </View>
          ) : null}
          <PressHighlight
            onPress={handleOpenHistory}
            style={styles.addButton}
            highlightStyle={styles.addButtonPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.directions.addLabel")}
            testID="sidebar-directions-add"
          >
            <ThemedPlus size={14} uniProps={mutedIconMapping} />
          </PressHighlight>
        </SidebarSectionHeader>

        {collapsed ? null : (
          <View style={styles.body} testID="sidebar-directions-list">
            {directions.length > 0 ? (
              directions.map((entry) => (
                <DirectionRow
                  key={entry.conversationId}
                  entry={entry}
                  isSelected={activeConversationId === entry.conversationId}
                  onSelect={handleOpenDirection}
                />
              ))
            ) : (
              <View style={styles.emptyBlock} testID="sidebar-directions-empty">
                <View
                  style={[styles.rowEnvelope, isHistoryHighlighted && styles.rowHighlighted]}
                  onPointerEnter={handleHistoryPointerEnter}
                  onPointerLeave={handleHistoryPointerLeave}
                >
                  <PressHighlight
                    onPress={handleOpenHistory}
                    style={styles.rowButton}
                    highlightStyle={styles.rowPressed}
                    accessibilityRole="button"
                    accessibilityLabel={t("mainChat.directions.historyEntry")}
                    testID="sidebar-directions-history-entry"
                  >
                    <ThemedHistory
                      size={14}
                      uniProps={isHistoryHighlighted ? foregroundIconMapping : mutedIconMapping}
                    />
                    <Text
                      style={[styles.rowTitle, isHistoryHighlighted && styles.rowTitleHighlighted]}
                      numberOfLines={1}
                    >
                      {t("mainChat.directions.historyEntry")}
                    </Text>
                  </PressHighlight>
                </View>
                <Text style={styles.emptyHint} numberOfLines={1}>
                  {t("mainChat.directions.emptyHint")}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
      <SidebarSeparator testID="sidebar-directions-separator" />
    </>
  );
});

const EMPTY_DIRECTIONS: readonly MainChatDirectionEntry[] = [];

const styles = StyleSheet.create((theme) => ({
  section: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[1.5],
    gap: 2,
  },
  body: {
    gap: 2,
  },
  emptyBlock: {
    gap: theme.spacing[1],
  },
  emptyHint: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[0.5],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
  collapsedSummaryPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    maxWidth: 132,
  },
  collapsedSummaryText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  dotNeedsYou: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusWarning,
  },
  dotRunning: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.primary,
  },
  addButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  addButtonPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowEnvelope: {
    position: "relative",
    minHeight: 30,
    borderRadius: theme.borderRadius.md,
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowButton: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  rowTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  rowTitleHighlighted: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  rowCounts: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
    flexShrink: 0,
  },
}));
