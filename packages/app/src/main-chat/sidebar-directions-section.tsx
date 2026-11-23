import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
import { isMainChatEnabled, type MainChatConversationRecord } from "@getpaseo/protocol/main-chat";
import { router, usePathname } from "expo-router";
import equal from "fast-deep-equal";
import { History, Plus, X } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { SidebarSectionHeader } from "@/components/sidebar/sidebar-section-header";
import { SidebarSeparator } from "@/components/sidebar/sidebar-separator";
import { PressHighlight } from "@/components/ui/press-highlight";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import {
  buildMainChatConversationRoute,
  buildMainChatHistoryRoute,
  isMainChatPathname,
  parseMainChatConversationIdFromPathname,
} from "@/utils/host-routes";
import {
  EMPTY_CONVERSATIONS,
  EMPTY_FLEET_HOSTS,
  useMainChatConversationsStore,
} from "./conversations-store";
import {
  CreateConversationModal,
  DirectionsTree,
  EditConversationModal,
  buildDirectionsTreeModel,
  type DirectionTreeLiveAgent,
  type OpenDirectionAgentTargetInput,
} from "./directions-tree";
import { openMainChatTaskTarget } from "./open-task-target";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { selectMainChatSidebarSummary } from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";

const ThemedPlus = withUnistyles(Plus);
const ThemedHistory = withUnistyles(History);
const ThemedX = withUnistyles(X);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export interface MainChatDirectionEntry {
  conversationId: string;
  title: string;
  runningCount: number;
  needsYouCount: number;
}

interface DirectionsSectionStoreSnapshot {
  collapsed: boolean;
  toggleCollapsed: () => void;
  setCollapsed: (collapsed: boolean) => void;
}

/**
 * Compatibility facade preserving the M1 `useMainChatDirectionsSectionStore` API while backing
 * collapse state with the device-persisted `useMainChatConversationsStore`.
 */
export const useMainChatDirectionsSectionStore = {
  getState(): DirectionsSectionStoreSnapshot {
    const state = useMainChatConversationsStore.getState();
    return {
      collapsed: state.sectionCollapsed,
      toggleCollapsed: state.toggleSectionCollapsed,
      setCollapsed: state.setSectionCollapsed,
    };
  },
  subscribe: useMainChatConversationsStore.subscribe,
};

export interface SidebarDirectionsSectionProps {
  onBeforeNavigate?: () => void;
  /** Optional fallback direction entries (retained for M1 callers & tests). */
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

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

interface DirectionsSessionSnapshot {
  supportsMainChat: boolean;
  targetServerId: string | null;
  mainAgentId: string | null;
  runningCount: number;
  needsYouCount: number;
  liveAgents: DirectionTreeLiveAgent[];
  hostnamesByServerId: Record<string, string>;
}

function selectDirectionsSessionSnapshot(
  state: SessionStoreState,
  preferredServerId: string | null,
): DirectionsSessionSnapshot {
  const summary = selectMainChatSidebarSummary(state, preferredServerId);
  if (!summary.supportsMainChat) {
    return {
      supportsMainChat: false,
      targetServerId: null,
      mainAgentId: null,
      runningCount: 0,
      needsYouCount: 0,
      liveAgents: [],
      hostnamesByServerId: {},
    };
  }

  const liveAgents: DirectionTreeLiveAgent[] = [];
  const hostnamesByServerId: Record<string, string> = {};

  for (const [hostId, hostSession] of Object.entries(state.sessions)) {
    const hostname = hostSession.serverInfo?.hostname?.trim();
    if (hostname) {
      hostnamesByServerId[hostId] = hostname;
    }

    const pendingAgentIds = new Set<string>();
    for (const perm of hostSession.pendingPermissions.values()) {
      pendingAgentIds.add(perm.agentId);
    }

    for (const agent of hostSession.agents.values()) {
      if (agent.archivedAt || agent.background) continue;
      const isRunning =
        agent.turn.phase === "open" ||
        isAgentRunning({ status: agent.status, backgroundWork: agent.backgroundWork });
      const needsYou =
        pendingAgentIds.has(agent.id) ||
        agent.pendingPermissions.length > 0 ||
        agent.attentionReason === "permission";

      liveAgents.push({
        serverId: hostId,
        agentId: agent.id,
        workspaceId: agent.workspaceId ?? null,
        title: agent.title?.trim() || agent.id,
        isRunning,
        isFailed: agent.status === "error",
        needsYou,
      });
    }
  }

  return {
    supportsMainChat: true,
    targetServerId: summary.existing?.serverId ?? summary.targetServerId,
    mainAgentId: summary.existing?.agentId ?? null,
    runningCount: summary.runningCount,
    needsYouCount: summary.needsYouCount,
    liveAgents,
    hostnamesByServerId,
  };
}

const HistoryEntryRow = memo(function HistoryEntryRow({
  isActive,
  onPress,
}: {
  isActive: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const isHighlighted = isHovered || isActive;

  return (
    <View
      style={[styles.rowEnvelope, isHighlighted && styles.rowHighlighted]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        onPress={onPress}
        style={styles.rowButton}
        highlightStyle={styles.rowPressed}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.directions.historyEntry")}
        testID="sidebar-directions-history-entry"
      >
        <ThemedHistory
          size={14}
          uniProps={isHighlighted ? foregroundIconMapping : mutedIconMapping}
        />
        <Text
          style={[styles.rowTitle, isHighlighted && styles.rowTitleHighlighted]}
          numberOfLines={1}
        >
          {t("mainChat.directions.historyEntry")}
        </Text>
      </PressHighlight>
    </View>
  );
});

const EMPTY_DIRECTIONS: readonly MainChatDirectionEntry[] = [];

function useSidebarDirectionsState(
  preferredServerId: string | null,
  directions: readonly MainChatDirectionEntry[],
) {
  const snapshot = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => selectDirectionsSessionSnapshot(state, preferredServerId),
      [preferredServerId],
    ),
    equal,
  );

  const targetServerId = snapshot.targetServerId;
  const client = useSessionStore((state) =>
    targetServerId ? (state.sessions[targetServerId]?.client ?? null) : null,
  );

  const overviewKey =
    targetServerId && snapshot.mainAgentId
      ? overviewStoreKey(targetServerId, snapshot.mainAgentId)
      : null;
  const overview = useMainChatOverviewStore((state) =>
    overviewKey ? (state.overviewsByKey[overviewKey] ?? null) : null,
  );

  const storeConversations = useMainChatConversationsStore((state) =>
    targetServerId ? (state.conversationsByServerId[targetServerId] ?? null) : null,
  );
  const fleetHosts = useMainChatConversationsStore((state) =>
    targetServerId ? (state.fleetHostsByServerId[targetServerId] ?? null) : null,
  );
  const hydrateFromOverview = useMainChatConversationsStore((state) => state.hydrateFromOverview);
  const refreshConversations = useMainChatConversationsStore((state) => state.refreshConversations);
  const fetchedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!targetServerId || !overview) return;
    hydrateFromOverview(targetServerId, overview);
  }, [hydrateFromOverview, overview, targetServerId]);

  useEffect(() => {
    if (!targetServerId || !client || typeof client.listMainChatConversations !== "function") {
      return;
    }
    if (fetchedKeyRef.current === targetServerId && storeConversations !== null) return;
    fetchedKeyRef.current = targetServerId;
    void refreshConversations(targetServerId, client).catch(() => undefined);
  }, [client, refreshConversations, storeConversations, targetServerId]);

  const effectiveConversations =
    storeConversations ?? overview?.conversations ?? EMPTY_CONVERSATIONS;
  const effectiveFleetHosts = fleetHosts ?? overview?.fleetHosts ?? EMPTY_FLEET_HOSTS;

  const hostLabelsByServerId = useMemo(() => {
    const labels: Record<string, string> = { ...snapshot.hostnamesByServerId };
    for (const host of effectiveFleetHosts) {
      if (host.label.trim()) labels[host.serverId] = host.label.trim();
    }
    return labels;
  }, [effectiveFleetHosts, snapshot.hostnamesByServerId]);

  const treeModel = useMemo(
    () =>
      buildDirectionsTreeModel({
        conversations: effectiveConversations,
        tasks: overview?.tasks ?? [],
        liveAgents: snapshot.liveAgents,
        hostLabelsByServerId,
        mainServerId: targetServerId,
        fallbackDirections: directions,
      }),
    [
      directions,
      effectiveConversations,
      hostLabelsByServerId,
      overview?.tasks,
      snapshot.liveAgents,
      targetServerId,
    ],
  );

  return { snapshot, targetServerId, client, treeModel };
}

/**
 * Dedicated "Conversations & directions" section positioned between the sticky Main Chat hero
 * entry and the regular coding Workspaces list. Renders the three-level direction tree
 * (`Direction -> Task -> Cross-Host Agent`), recent side threads, and quick conversation creation.
 */
export const SidebarDirectionsSection = memo(function SidebarDirectionsSection({
  onBeforeNavigate,
  directions = EMPTY_DIRECTIONS,
}: SidebarDirectionsSectionProps): ReactElement | null {
  const { t } = useTranslation();
  const pathname = usePathname();
  const isCompact = useIsCompactFormFactor();
  const activeWorkspace = useActiveWorkspaceSelection();
  const lastWorkspace = useLastWorkspaceSelection();
  const preferredServerId = activeWorkspace?.serverId ?? lastWorkspace?.serverId ?? null;

  const { snapshot, targetServerId, client, treeModel } = useSidebarDirectionsState(
    preferredServerId,
    directions,
  );
  const mainChatSettings = useMainChatSettingsStore((state) =>
    targetServerId ? state.settingsByServerId[targetServerId] : undefined,
  );
  const isEnabled = isMainChatEnabled(mainChatSettings);

  const collapsed = useMainChatConversationsStore((state) => state.sectionCollapsed);
  const toggleCollapsed = useMainChatConversationsStore((state) => state.toggleSectionCollapsed);
  const recentSideCollapsed = useMainChatConversationsStore((state) => state.recentSideCollapsed);
  const toggleRecentSideCollapsed = useMainChatConversationsStore(
    (state) => state.toggleRecentSideCollapsed,
  );
  const expandedDirectionIds = useMainChatConversationsStore((state) => state.expandedDirectionIds);
  const toggleDirectionExpanded = useMainChatConversationsStore(
    (state) => state.toggleDirectionExpanded,
  );
  const createConversation = useMainChatConversationsStore((state) => state.createConversation);
  const updateConversation = useMainChatConversationsStore((state) => state.updateConversation);
  const promoteToLeader = useMainChatConversationsStore((state) => state.promoteToLeader);
  const demoteToSide = useMainChatConversationsStore((state) => state.demoteToSide);
  const archiveConversation = useMainChatConversationsStore((state) => state.archiveConversation);

  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [editingConversation, setEditingConversation] = useState<MainChatConversationRecord | null>(
    null,
  );
  const [busyConversationId, setBusyConversationId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleOpenHistory = useCallback(() => {
    onBeforeNavigate?.();
    router.push(buildMainChatHistoryRoute());
  }, [onBeforeNavigate]);

  const handlePressAdd = useCallback(() => {
    if (client && typeof client.createMainChatConversation === "function") {
      setCreateModalVisible(true);
      return;
    }
    handleOpenHistory();
  }, [client, handleOpenHistory]);

  const handleCloseCreateModal = useCallback(() => {
    setCreateModalVisible(false);
  }, []);

  const handleConversationCreated = useCallback(
    (created: MainChatConversationRecord) => {
      setCreateModalVisible(false);
      onBeforeNavigate?.();
      router.push(buildMainChatConversationRoute(created.id));
    },
    [onBeforeNavigate],
  );

  const handleOpenConversation = useCallback(
    (conversationId: string) => {
      onBeforeNavigate?.();
      router.push(buildMainChatConversationRoute(conversationId));
    },
    [onBeforeNavigate],
  );

  const handleOpenDirectionAgent = useCallback(
    (input: OpenDirectionAgentTargetInput) => {
      onBeforeNavigate?.();
      const directionRoute = buildMainChatConversationRoute(input.conversationId);
      const mode = openMainChatTaskTarget({
        serverId: input.serverId,
        agentId: input.agentId,
        workspaceId: input.workspaceId,
        title: input.title,
        taskId: input.taskId,
        isCompact,
        inMainChatRoute: true,
        originRoute: directionRoute,
        originTitle: input.conversationTitle,
      });
      if (mode === "drawer" && !isMainChatPathname(pathname)) {
        router.push(directionRoute);
      }
    },
    [isCompact, onBeforeNavigate, pathname],
  );

  const runRowMutation = useCallback(
    (conversationId: string, action: () => Promise<unknown>) => {
      if (busyConversationId) return;
      setBusyConversationId(conversationId);
      setActionError(null);
      void action()
        .catch((error) => {
          setActionError(
            error instanceof Error ? error.message : t("mainChat.directions.toasts.actionFailed"),
          );
        })
        .finally(() => {
          setBusyConversationId(null);
        });
    },
    [busyConversationId, t],
  );

  const handlePromote = useCallback(
    (record: MainChatConversationRecord) => {
      if (!targetServerId || !client) return;
      runRowMutation(record.id, () => promoteToLeader(targetServerId, record.id, client));
    },
    [client, promoteToLeader, runRowMutation, targetServerId],
  );

  const handleDemote = useCallback(
    (record: MainChatConversationRecord) => {
      if (!targetServerId || !client) return;
      runRowMutation(record.id, () => demoteToSide(targetServerId, record.id, client));
    },
    [client, demoteToSide, runRowMutation, targetServerId],
  );

  const handleArchive = useCallback(
    (record: MainChatConversationRecord) => {
      if (!targetServerId || !client) return;
      runRowMutation(record.id, () => archiveConversation(targetServerId, record.id, client, true));
    },
    [archiveConversation, client, runRowMutation, targetServerId],
  );

  const handleRequestRename = useCallback((record: MainChatConversationRecord) => {
    setEditingConversation(record);
  }, []);

  const handleCloseEditModal = useCallback(() => {
    setEditingConversation(null);
  }, []);

  const handleDismissError = useCallback(() => {
    setActionError(null);
  }, []);

  if (!snapshot.supportsMainChat || !isEnabled) {
    return null;
  }

  const collapsedSummary = collapsed
    ? formatCollapsedCounts(snapshot.runningCount, snapshot.needsYouCount, t)
    : null;
  const activeConversationId = parseMainChatConversationIdFromPathname(pathname);
  const isHistoryActive = pathname === buildMainChatHistoryRoute();
  const hasConversations = treeModel.leaders.length > 0 || treeModel.sides.length > 0;

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
              {snapshot.needsYouCount > 0 ? <View style={styles.dotNeedsYou} /> : null}
              {snapshot.runningCount > 0 && snapshot.needsYouCount === 0 ? (
                <View style={styles.dotRunning} />
              ) : null}
              <Text style={styles.collapsedSummaryText} numberOfLines={1}>
                {collapsedSummary}
              </Text>
            </View>
          ) : null}
          <PressHighlight
            onPress={handlePressAdd}
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
            {actionError ? (
              <View style={styles.errorBanner} testID="sidebar-directions-error">
                <Text style={styles.errorBannerText} numberOfLines={2}>
                  {actionError}
                </Text>
                <PressHighlight
                  onPress={handleDismissError}
                  style={styles.dismissErrorButton}
                  highlightStyle={styles.rowPressed}
                  accessibilityRole="button"
                  accessibilityLabel={t("common.actions.close")}
                >
                  <ThemedX size={12} uniProps={mutedIconMapping} />
                </PressHighlight>
              </View>
            ) : null}

            {hasConversations ? (
              <>
                <DirectionsTree
                  model={treeModel}
                  activeConversationId={activeConversationId}
                  expandedDirectionIds={expandedDirectionIds}
                  recentSideCollapsed={recentSideCollapsed}
                  busyConversationId={busyConversationId}
                  onToggleDirectionExpanded={toggleDirectionExpanded}
                  onToggleRecentSideCollapsed={toggleRecentSideCollapsed}
                  onSelectConversation={handleOpenConversation}
                  onOpenAgent={handleOpenDirectionAgent}
                  onOpenHistory={handleOpenHistory}
                  onPromote={handlePromote}
                  onDemote={handleDemote}
                  onRequestRename={handleRequestRename}
                  onArchive={handleArchive}
                />
                <HistoryEntryRow isActive={isHistoryActive} onPress={handleOpenHistory} />
              </>
            ) : (
              <View style={styles.emptyBlock} testID="sidebar-directions-empty">
                <HistoryEntryRow isActive={isHistoryActive} onPress={handleOpenHistory} />
                <Text style={styles.emptyHint} numberOfLines={1}>
                  {t("mainChat.directions.emptyHint")}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>

      <CreateConversationModal
        visible={createModalVisible}
        serverId={targetServerId}
        client={client}
        onCreate={createConversation}
        onCreated={handleConversationCreated}
        onClose={handleCloseCreateModal}
      />

      <EditConversationModal
        conversation={editingConversation}
        serverId={targetServerId}
        client={client}
        onUpdate={updateConversation}
        onClose={handleCloseEditModal}
      />

      <SidebarSeparator testID="sidebar-directions-separator" />
    </>
  );
});

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
  errorBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.statusDangerTint,
  },
  errorBannerText: {
    flex: 1,
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  dismissErrorButton: {
    width: 20,
    height: 20,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
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
}));
