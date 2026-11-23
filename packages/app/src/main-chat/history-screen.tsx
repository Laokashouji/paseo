import {
  isMainChatAgent,
  type MainChatOverview,
  type MainChatPatrolResult,
  type MainChatSessionTriage,
} from "@getpaseo/protocol/main-chat";
import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import equal from "fast-deep-equal";
import { ArrowLeft, ArrowUpRight, Radar, Sparkles } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { TitlebarDragRegion } from "@/components/desktop/titlebar-drag-region";
import { SidebarMenuToggle } from "@/components/headers/sidebar-menu-toggle";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import {
  HEADER_INNER_HEIGHT,
  HEADER_INNER_HEIGHT_MOBILE,
  HEADER_TOP_PADDING_MOBILE,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { useHosts } from "@/runtime/host-runtime";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { WindowChromeSafeArea } from "@/utils/desktop-window";
import {
  buildMainChatConversationRoute,
  buildMainChatHistoryRoute,
  buildMainChatRoute,
} from "@/utils/host-routes";
import { openMainChatTaskTarget } from "./open-task-target";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import {
  selectMainChatDockTasks,
  selectMainChatSidebarSummary,
  type MainChatDockTaskItem,
} from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";

const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedArrowUpRight = withUnistyles(ArrowUpRight);
const ThemedRadar = withUnistyles(Radar);
const ThemedSparkles = withUnistyles(Sparkles);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });

type HistoryTab = "conversations" | "activity";

interface AssistantConversationListItem {
  serverId: string;
  agentId: string;
  title: string;
  archived: boolean;
  isActiveMain: boolean;
  updatedAtMs: number;
}

function selectAssistantConversations(
  state: ReturnType<typeof useSessionStore.getState>,
  activeMain: { serverId: string; agentId: string } | null,
): AssistantConversationListItem[] {
  const items: AssistantConversationListItem[] = [];
  const seen = new Set<string>();

  for (const [serverId, session] of Object.entries(state.sessions)) {
    const candidates = [...session.agents.values(), ...session.agentDetails.values()];
    for (const agent of candidates) {
      const key = `${serverId}:${agent.id}`;
      if (seen.has(key) || !isMainChatAgent(agent)) continue;
      seen.add(key);
      items.push({
        serverId,
        agentId: agent.id,
        title: agent.title?.trim() || agent.id,
        archived: agent.archivedAt !== null,
        isActiveMain:
          activeMain !== null &&
          activeMain.serverId === serverId &&
          activeMain.agentId === agent.id &&
          agent.archivedAt === null,
        updatedAtMs: agent.updatedAt.getTime(),
      });
    }
  }

  items.sort((left, right) => {
    if (left.isActiveMain !== right.isActiveMain) return left.isActiveMain ? -1 : 1;
    return right.updatedAtMs - left.updatedAtMs;
  });
  return items;
}

function formatUpdatedTime(timestampMs: number): string {
  try {
    return new Date(timestampMs).toLocaleString();
  } catch {
    return "";
  }
}

const HistoryHeader = memo(function HistoryHeader({
  isCompact,
  canPatrol,
  isPatrolling,
  onBackToMain,
  onPatrolNow,
}: {
  isCompact: boolean;
  canPatrol: boolean;
  isPatrolling: boolean;
  onBackToMain: () => void;
  onPatrolNow: () => void;
}) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const headerInnerStyle = useMemo(
    () => [
      styles.headerInner,
      { paddingTop: insets.top + (isCompact ? HEADER_TOP_PADDING_MOBILE : 0) },
    ],
    [insets.top, isCompact],
  );
  const horizontalPadding = isCompact ? 8 : 12;

  return (
    <View style={styles.headerContainer}>
      <View style={headerInnerStyle}>
        <WindowChromeSafeArea
          placement="inline"
          horizontalPadding={horizontalPadding}
          style={styles.headerRow}
        >
          <TitlebarDragRegion />
          <View style={styles.headerLeft}>
            <SidebarMenuToggle />
            <PressHighlight
              onPress={onBackToMain}
              style={styles.backButton}
              highlightStyle={styles.controlPressed}
              accessibilityRole="button"
              accessibilityLabel={t("mainChat.shell.backToMainLabel")}
              testID="main-chat-history-back"
            >
              <ThemedArrowLeft size={14} uniProps={mutedIconMapping} />
              <Text style={styles.backLabel}>{t("mainChat.shell.backToMain")}</Text>
            </PressHighlight>
            <Text style={styles.headerTitle} numberOfLines={1}>
              {t("mainChat.history.title")}
            </Text>
          </View>

          <View style={styles.headerRight}>
            {canPatrol ? (
              <Button
                variant="outline"
                size="sm"
                leftIcon={ThemedRadar}
                loading={isPatrolling}
                onPress={onPatrolNow}
                testID="main-chat-history-patrol"
              >
                {t("mainChat.actions.triggerPatrolShort")}
              </Button>
            ) : null}
          </View>
        </WindowChromeSafeArea>
      </View>
    </View>
  );
});

const ConversationCard = memo(function ConversationCard({
  item,
  hostLabel,
  onOpen,
}: {
  item: AssistantConversationListItem;
  hostLabel: string;
  onOpen: (item: AssistantConversationListItem) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onOpen(item), [item, onOpen]);

  return (
    <PressHighlight
      onPress={handlePress}
      style={styles.itemCard}
      highlightStyle={styles.itemCardPressed}
      accessibilityRole="button"
      accessibilityLabel={item.title}
      testID={`main-chat-history-conv-${item.agentId}`}
    >
      <View style={styles.itemLeading}>
        <ThemedSparkles size={15} uniProps={primaryIconMapping} />
      </View>
      <View style={styles.itemBody}>
        <View style={styles.itemTitleRow}>
          <Text style={styles.itemTitle} numberOfLines={1}>
            {item.title}
          </Text>
          {item.isActiveMain ? (
            <StatusBadge
              size="xs"
              variant="success"
              label={t("mainChat.history.activeMainBadge")}
            />
          ) : null}
          {item.archived ? (
            <StatusBadge size="xs" variant="muted" label={t("mainChat.history.archivedBadge")} />
          ) : null}
        </View>
        <Text style={styles.itemMeta} numberOfLines={1}>
          {hostLabel} · {formatUpdatedTime(item.updatedAtMs)}
        </Text>
      </View>
      <ThemedArrowUpRight size={14} uniProps={mutedIconMapping} />
    </PressHighlight>
  );
});

const ManagedTaskCard = memo(function ManagedTaskCard({
  task,
  hostLabel,
  onOpen,
}: {
  task: MainChatDockTaskItem;
  hostLabel: string;
  onOpen: (task: MainChatDockTaskItem) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onOpen(task), [onOpen, task]);

  return (
    <PressHighlight
      onPress={handlePress}
      style={styles.itemCard}
      highlightStyle={styles.itemCardPressed}
      accessibilityRole="button"
      accessibilityLabel={task.title}
      testID={`main-chat-history-task-${task.agentId}`}
    >
      <View style={styles.itemBody}>
        <View style={styles.itemTitleRow}>
          <Text style={styles.itemTitle} numberOfLines={1}>
            {task.title}
          </Text>
          {!task.managedByMainChat ? (
            <StatusBadge size="xs" variant="muted" label={t("mainChat.board.manualSessionBadge")} />
          ) : null}
        </View>
        <Text style={styles.itemMeta} numberOfLines={1}>
          {hostLabel} · {formatUpdatedTime(task.updatedAtMs)}
        </Text>
      </View>
      <ThemedArrowUpRight size={14} uniProps={mutedIconMapping} />
    </PressHighlight>
  );
});

const HistoryConversationsTab = memo(function HistoryConversationsTab({
  conversations,
  dockTasks,
  hostLabelByServerId,
  onOpenConversation,
  onOpenTask,
}: {
  conversations: readonly AssistantConversationListItem[];
  dockTasks: readonly MainChatDockTaskItem[];
  hostLabelByServerId: ReadonlyMap<string, string>;
  onOpenConversation: (item: AssistantConversationListItem) => void;
  onOpenTask: (task: MainChatDockTaskItem) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.sectionStack} testID="main-chat-history-conversations">
      <View style={styles.sectionBlock}>
        <Text style={styles.sectionTitle}>{t("mainChat.history.conversationsHeading")}</Text>
        {conversations.length > 0 ? (
          <View style={styles.cardList}>
            {conversations.map((item) => (
              <ConversationCard
                key={`${item.serverId}:${item.agentId}`}
                item={item}
                hostLabel={hostLabelByServerId.get(item.serverId) ?? item.serverId}
                onOpen={onOpenConversation}
              />
            ))}
          </View>
        ) : (
          <Text style={styles.emptyText}>{t("mainChat.history.emptyConversations")}</Text>
        )}
      </View>

      {dockTasks.length > 0 ? (
        <View style={styles.sectionBlock}>
          <Text style={styles.sectionTitle}>{t("mainChat.history.managedTasksHeading")}</Text>
          <View style={styles.cardList}>
            {dockTasks.map((task) => (
              <ManagedTaskCard
                key={`${task.serverId}:${task.agentId}`}
                task={task}
                hostLabel={hostLabelByServerId.get(task.serverId) ?? task.serverId}
                onOpen={onOpenTask}
              />
            ))}
          </View>
        </View>
      ) : null}
    </View>
  );
});

const TriageCard = memo(function TriageCard({ triage }: { triage: MainChatSessionTriage }) {
  return (
    <View style={styles.infoCard} testID={`main-chat-history-triage-${triage.agentId}`}>
      <View style={styles.itemTitleRow}>
        <Text style={styles.itemTitle} numberOfLines={1}>
          {triage.title}
        </Text>
        <StatusBadge size="xs" variant="muted" label={triage.phase} />
      </View>
      <Text style={styles.infoCardLine}>{triage.summary}</Text>
      {triage.waitReason ? <Text style={styles.itemMeta}>{triage.waitReason}</Text> : null}
    </View>
  );
});

const HistoryActivityTab = memo(function HistoryActivityTab({
  overview,
  lastPatrol,
}: {
  overview: MainChatOverview | null;
  lastPatrol: MainChatPatrolResult | null;
}) {
  const { t } = useTranslation();
  const metrics = overview?.metrics ?? null;
  const triages = overview?.triages ?? [];

  return (
    <View style={styles.sectionStack} testID="main-chat-history-activity">
      <View style={styles.sectionBlock}>
        <Text style={styles.sectionTitle}>{t("mainChat.history.activityHeading")}</Text>

        {metrics ? (
          <View style={styles.infoCard}>
            <Text style={styles.infoCardLine}>
              {t("mainChat.board.supervisorMetrics", {
                held: metrics.supervisorHeld,
                autoContinued: metrics.autoContinued,
                rework: metrics.reworkCount,
                interrupts: metrics.interrupts,
              })}
            </Text>
          </View>
        ) : null}

        {lastPatrol ? (
          <View style={styles.infoCard} testID="main-chat-history-last-patrol">
            <Text style={styles.infoCardTitle}>{t("mainChat.history.lastPatrolTitle")}</Text>
            <Text style={styles.infoCardLine}>{lastPatrol.summary}</Text>
            <Text style={styles.itemMeta}>{lastPatrol.patrolledAt}</Text>
          </View>
        ) : null}

        {triages.length > 0 ? (
          <View style={styles.sectionBlock}>
            <Text style={styles.sectionTitle}>{t("mainChat.history.triagesHeading")}</Text>
            <View style={styles.cardList}>
              {triages.map((triage) => (
                <TriageCard key={`${triage.agentId}:${triage.updatedAt}`} triage={triage} />
              ))}
            </View>
          </View>
        ) : null}

        {triages.length === 0 && !lastPatrol && !metrics ? (
          <Text style={styles.emptyText}>{t("mainChat.history.emptyActivity")}</Text>
        ) : null}
      </View>
    </View>
  );
});

/**
 * `/main/history` — Assistant conversation history and background activity view.
 * Structured with segmented tabs (`conversations` | `activity`) so M2 background-turn logs and M4
 * direction/side conversation management plug straight in.
 */
export function MainChatHistoryScreen(): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.inactiveContainer} />;
  }

  return <MainChatHistoryScreenContent />;
}

const MainChatHistoryScreenContent = memo(function MainChatHistoryScreenContent(): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactFormFactor();
  const hosts = useHosts();
  const lastWorkspace = useLastWorkspaceSelection();
  const preferredServerId = lastWorkspace?.serverId ?? hosts[0]?.serverId ?? null;

  const [activeTab, setActiveTab] = useState<HistoryTab>("conversations");
  const [isPatrolling, setIsPatrolling] = useState(false);

  const summary = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => selectMainChatSidebarSummary(state, preferredServerId),
      [preferredServerId],
    ),
    equal,
  );

  const activeMainRef = summary.existing;
  const targetServerId = summary.targetServerId;
  const client = useSessionStore((state) =>
    targetServerId ? (state.sessions[targetServerId]?.client ?? null) : null,
  );

  const conversations = useStoreWithEqualityFn(
    useSessionStore,
    useCallback((state) => selectAssistantConversations(state, activeMainRef), [activeMainRef]),
    equal,
  );

  const dockTasks = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) =>
        activeMainRef
          ? selectMainChatDockTasks(state, activeMainRef.serverId, activeMainRef.agentId)
          : [],
      [activeMainRef],
    ),
    equal,
  );

  const overviewKey = activeMainRef
    ? overviewStoreKey(activeMainRef.serverId, activeMainRef.agentId)
    : null;
  const overview = useMainChatOverviewStore((state) =>
    overviewKey ? (state.overviewsByKey[overviewKey] ?? null) : null,
  );
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);
  const triggerPatrol = useMainChatSettingsStore((state) => state.triggerPatrol);
  const lastPatrol = useMainChatSettingsStore((state) =>
    targetServerId ? (state.lastPatrolByServerId[targetServerId] ?? null) : null,
  );

  useEffect(() => {
    if (!activeMainRef || !client) return;
    void loadOverview(activeMainRef.serverId, activeMainRef.agentId, client);
  }, [activeMainRef, client, loadOverview]);

  const hostLabelByServerId = useMemo(
    () => new Map(hosts.map((host) => [host.serverId, host.label])),
    [hosts],
  );

  const tabOptions = useMemo<SegmentedControlOption<HistoryTab>[]>(
    () => [
      {
        value: "conversations",
        label: t("mainChat.history.tabConversations"),
        testID: "main-chat-history-tab-conversations",
      },
      {
        value: "activity",
        label: t("mainChat.history.tabActivity"),
        testID: "main-chat-history-tab-activity",
      },
    ],
    [t],
  );

  const handleBackToMain = useCallback(() => router.push(buildMainChatRoute()), []);

  const handlePatrolNow = useCallback(() => {
    if (!targetServerId || !client || isPatrolling) return;
    setIsPatrolling(true);
    void triggerPatrol(targetServerId, client, {
      mainAgentId: activeMainRef?.agentId,
      forceWakeup: true,
    })
      .then((result) => {
        toast.show(result.summary, { variant: "success" });
        if (activeMainRef) {
          return loadOverview(activeMainRef.serverId, activeMainRef.agentId, client);
        }
        return null;
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t("mainChat.patrolFailed"));
      })
      .finally(() => {
        setIsPatrolling(false);
      });
  }, [activeMainRef, client, isPatrolling, loadOverview, t, targetServerId, toast, triggerPatrol]);

  const handleOpenConversation = useCallback((item: AssistantConversationListItem) => {
    if (item.isActiveMain) {
      router.push(buildMainChatRoute());
      return;
    }
    router.push(buildMainChatConversationRoute(`${item.serverId}:${item.agentId}`));
  }, []);

  const handleOpenTask = useCallback(
    (task: MainChatDockTaskItem) => {
      const mode = openMainChatTaskTarget({
        serverId: task.serverId,
        agentId: task.agentId,
        workspaceId: task.workspaceId,
        title: task.title,
        isCompact,
        inMainChatRoute: true,
        originRoute: buildMainChatHistoryRoute(),
        originTitle: t("mainChat.history.title"),
      });
      if (mode === "drawer") {
        router.push(buildMainChatRoute());
      }
    },
    [isCompact, t],
  );

  return (
    <View style={styles.root} testID="main-chat-history-screen">
      <HistoryHeader
        isCompact={isCompact}
        canPatrol={Boolean(targetServerId && client)}
        isPatrolling={isPatrolling}
        onBackToMain={handleBackToMain}
        onPatrolNow={handlePatrolNow}
      />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.container}>
          <View style={styles.tabRow}>
            <SegmentedControl
              size="sm"
              options={tabOptions}
              value={activeTab}
              onValueChange={setActiveTab}
              testID="main-chat-history-tabs"
            />
          </View>

          {activeTab === "conversations" ? (
            <HistoryConversationsTab
              conversations={conversations}
              dockTasks={dockTasks}
              hostLabelByServerId={hostLabelByServerId}
              onOpenConversation={handleOpenConversation}
              onOpenTask={handleOpenTask}
            />
          ) : (
            <HistoryActivityTab overview={overview} lastPatrol={lastPatrol} />
          )}
        </View>
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  inactiveContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  root: {
    flex: 1,
    minHeight: 0,
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
    gap: theme.spacing[2],
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
  controlPressed: {
    backgroundColor: theme.colors.surface2,
  },
  backLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  headerTitle: {
    flexShrink: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    padding: theme.spacing[4],
    alignItems: "center",
  },
  container: {
    width: "100%",
    maxWidth: 760,
    gap: theme.spacing[4],
  },
  tabRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  sectionStack: {
    gap: theme.spacing[4],
  },
  sectionBlock: {
    gap: theme.spacing[2],
  },
  sectionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  cardList: {
    gap: theme.spacing[2],
  },
  itemCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  itemCardPressed: {
    backgroundColor: theme.colors.surface2,
  },
  itemLeading: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  itemBody: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  itemTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  itemTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  itemMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  infoCard: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    gap: theme.spacing[1],
  },
  infoCardTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  infoCardLine: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingVertical: theme.spacing[2],
  },
}));
