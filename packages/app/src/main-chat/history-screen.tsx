import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_CONVERSATION_KIND_LABEL,
  isFormerMainChatLabels,
  isMainChatAgent,
  type MainChatActivityEntry,
  type MainChatActivityKind,
  type MainChatActivityStatus,
  type MainChatConversationRecord,
  type MainChatOverview,
  type MainChatPatrolResult,
  type MainChatSessionTriage,
} from "@getpaseo/protocol/main-chat";
import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import equal from "fast-deep-equal";
import {
  Archive,
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Compass,
  MessageSquare,
  Pin,
  PinOff,
  Plus,
  Radar,
  RefreshCcw,
  RefreshCw,
  Sparkles,
} from "lucide-react-native";
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
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
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
import {
  EMPTY_CONVERSATIONS,
  sortConversationsByActivity,
  useMainChatConversationsStore,
} from "./conversations-store";
import { CreateConversationModal } from "./directions-tree";
import { openMainChatTaskTarget } from "./open-task-target";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import {
  selectMainChatDockTasks,
  selectMainChatSidebarSummary,
  type MainChatDockTaskItem,
} from "./selectors";
import { useMainChatSettingsStore } from "./settings-store";

const ThemedArchive = withUnistyles(Archive);
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedArrowUpRight = withUnistyles(ArrowUpRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCompass = withUnistyles(Compass);
const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const ThemedPlus = withUnistyles(Plus);
const ThemedRadar = withUnistyles(Radar);
const ThemedRefreshCcw = withUnistyles(RefreshCcw);
const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedSparkles = withUnistyles(Sparkles);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });

type HistoryTab = "conversations" | "activity";

export type MainChatActivityFilter =
  | "all"
  | "silent"
  | "preempted"
  | "compaction_handoff"
  | "missing_reply_recovery";

const ACTIVITY_FILTERS: readonly MainChatActivityFilter[] = [
  "all",
  "silent",
  "preempted",
  "compaction_handoff",
  "missing_reply_recovery",
];

export function filterMainChatActivityEntries(
  entries: readonly MainChatActivityEntry[],
  filter: MainChatActivityFilter,
): MainChatActivityEntry[] {
  if (filter === "all") return [...entries];
  return entries.filter((entry) => {
    switch (filter) {
      case "silent":
        return entry.kind === "silent_turn" || entry.silent;
      case "preempted":
        return (
          entry.kind === "preempted" ||
          entry.status === "preempted" ||
          entry.preemptedByUser === true
        );
      case "compaction_handoff":
        return entry.kind === "compaction" || entry.kind === "clear" || entry.kind === "handoff";
      case "missing_reply_recovery":
        return entry.kind === "missing_reply_recovery";
    }
  });
}

interface AssistantConversationListItem {
  serverId: string;
  agentId: string;
  title: string;
  archived: boolean;
  isActiveMain: boolean;
  isFormerMain: boolean;
  updatedAtMs: number;
}

function isAssistantConversationAgent(agent: { labels: Record<string, unknown> }): boolean {
  if (isMainChatAgent(agent) || isFormerMainChatLabels(agent.labels)) return true;
  const kind = agent.labels[MAIN_CHAT_CONVERSATION_KIND_LABEL];
  return kind === "main" || kind === "leader" || kind === "side";
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
      if (seen.has(key) || !isAssistantConversationAgent(agent)) continue;
      seen.add(key);
      const isFormerMain = isFormerMainChatLabels(agent.labels);
      items.push({
        serverId,
        agentId: agent.id,
        title: agent.title?.trim() || agent.id,
        archived: agent.archivedAt !== null || isFormerMain,
        isActiveMain:
          activeMain !== null &&
          activeMain.serverId === serverId &&
          activeMain.agentId === agent.id &&
          agent.archivedAt === null &&
          !isFormerMain,
        isFormerMain,
        updatedAtMs: agent.updatedAt.getTime(),
      });
    }
  }

  items.sort((left, right) => {
    if (left.isActiveMain !== right.isActiveMain) return left.isActiveMain ? -1 : 1;
    if (left.archived !== right.archived) return left.archived ? 1 : -1;
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

function formatIsoTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return iso;
  return formatUpdatedTime(ms);
}

function resolveActivityStatusVariant(status: MainChatActivityStatus): StatusBadgeVariant {
  switch (status) {
    case "completed":
      return "success";
    case "running":
    case "queued":
    case "preempted":
      return "warning";
    case "failed":
      return "error";
    case "skipped":
      return "muted";
  }
}

function resolveActivityKindKey(kind: MainChatActivityKind): string {
  switch (kind) {
    case "background_turn":
      return "mainChat.history.activityKind.backgroundTurn";
    case "silent_turn":
      return "mainChat.history.activityKind.silentTurn";
    case "preempted":
      return "mainChat.history.activityKind.preempted";
    case "compaction":
      return "mainChat.history.activityKind.compaction";
    case "clear":
      return "mainChat.history.activityKind.clear";
    case "handoff":
      return "mainChat.history.activityKind.handoff";
    case "missing_reply_recovery":
      return "mainChat.history.activityKind.missingReplyRecovery";
  }
}

function resolveActivityStatusKey(status: MainChatActivityStatus): string {
  switch (status) {
    case "queued":
      return "mainChat.history.activityStatus.queued";
    case "running":
      return "mainChat.history.activityStatus.running";
    case "completed":
      return "mainChat.history.activityStatus.completed";
    case "preempted":
      return "mainChat.history.activityStatus.preempted";
    case "failed":
      return "mainChat.history.activityStatus.failed";
    case "skipped":
      return "mainChat.history.activityStatus.skipped";
  }
}

function resolveActivityFilterKey(filter: MainChatActivityFilter): string {
  switch (filter) {
    case "all":
      return "mainChat.history.filters.all";
    case "silent":
      return "mainChat.history.filters.silent";
    case "preempted":
      return "mainChat.history.filters.preempted";
    case "compaction_handoff":
      return "mainChat.history.filters.compactionHandoff";
    case "missing_reply_recovery":
      return "mainChat.history.filters.missingReplyRecovery";
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

const ManagedConversationCard = memo(function ManagedConversationCard({
  record,
  canMutate,
  busy,
  onOpen,
  onToggleLeader,
  onToggleArchive,
}: {
  record: MainChatConversationRecord;
  canMutate: boolean;
  busy: boolean;
  onOpen: (record: MainChatConversationRecord) => void;
  onToggleLeader: (record: MainChatConversationRecord) => void;
  onToggleArchive: (record: MainChatConversationRecord) => void;
}) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => onOpen(record), [onOpen, record]);
  const handleToggleLeader = useCallback(() => onToggleLeader(record), [onToggleLeader, record]);
  const handleToggleArchive = useCallback(() => onToggleArchive(record), [onToggleArchive, record]);

  const isLeader = record.kind === "leader";
  const isArchived = record.archivedAt !== null;
  const updatedMs = Date.parse(record.lastMessageAt ?? record.updatedAt) || 0;

  return (
    <View style={styles.managedCard} testID={`main-chat-history-managed-${record.id}`}>
      <PressHighlight
        onPress={handleOpen}
        style={styles.managedCardMain}
        highlightStyle={styles.itemCardPressed}
        accessibilityRole="button"
        accessibilityLabel={record.title}
        testID={`main-chat-history-managed-open-${record.id}`}
      >
        <View style={styles.itemLeading}>
          {isLeader ? (
            <ThemedCompass size={15} uniProps={primaryIconMapping} />
          ) : (
            <ThemedMessageSquare size={15} uniProps={mutedIconMapping} />
          )}
        </View>
        <View style={styles.itemBody}>
          <View style={styles.itemTitleRow}>
            <Text style={styles.itemTitle} numberOfLines={1}>
              {record.title}
            </Text>
            <StatusBadge
              size="xs"
              variant={isLeader ? "success" : "muted"}
              label={
                isLeader
                  ? t("mainChat.directions.roleLeaderBadge")
                  : t("mainChat.directions.roleSideBadge")
              }
            />
            {isArchived ? (
              <StatusBadge
                size="xs"
                variant="warning"
                label={t("mainChat.directions.roleArchivedBadge")}
              />
            ) : null}
          </View>
          {record.directionSummary ? (
            <Text style={styles.managedSummary} numberOfLines={2}>
              {record.directionSummary}
            </Text>
          ) : null}
          <Text style={styles.itemMeta} numberOfLines={1}>
            {formatUpdatedTime(updatedMs)}
          </Text>
        </View>
        <ThemedArrowUpRight size={14} uniProps={mutedIconMapping} />
      </PressHighlight>

      {canMutate ? (
        <View style={styles.managedCardActions}>
          {!isArchived ? (
            <Button
              variant="ghost"
              size="sm"
              leftIcon={isLeader ? ThemedPinOff : ThemedPin}
              disabled={busy}
              onPress={handleToggleLeader}
              testID={`main-chat-history-toggle-leader-${record.id}`}
            >
              {isLeader
                ? t("mainChat.directions.historySection.demoteShort")
                : t("mainChat.directions.historySection.promoteShort")}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            leftIcon={isArchived ? ThemedRefreshCcw : ThemedArchive}
            disabled={busy}
            onPress={handleToggleArchive}
            testID={`main-chat-history-archive-${record.id}`}
          >
            {isArchived
              ? t("mainChat.directions.historySection.unarchiveShort")
              : t("mainChat.directions.historySection.archiveShort")}
          </Button>
        </View>
      ) : null}
    </View>
  );
});

const HistoryConversationsTab = memo(function HistoryConversationsTab({
  managedConversations,
  conversations,
  dockTasks,
  hostLabelByServerId,
  canCreateConversation,
  canMutateConversation,
  busyConversationId,
  onOpenCreateModal,
  onOpenManagedConversation,
  onToggleManagedLeader,
  onToggleManagedArchive,
  onOpenConversation,
  onOpenTask,
}: {
  managedConversations: readonly MainChatConversationRecord[];
  conversations: readonly AssistantConversationListItem[];
  dockTasks: readonly MainChatDockTaskItem[];
  hostLabelByServerId: ReadonlyMap<string, string>;
  canCreateConversation: boolean;
  canMutateConversation: boolean;
  busyConversationId: string | null;
  onOpenCreateModal: () => void;
  onOpenManagedConversation: (record: MainChatConversationRecord) => void;
  onToggleManagedLeader: (record: MainChatConversationRecord) => void;
  onToggleManagedArchive: (record: MainChatConversationRecord) => void;
  onOpenConversation: (item: AssistantConversationListItem) => void;
  onOpenTask: (task: MainChatDockTaskItem) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.sectionStack} testID="main-chat-history-conversations">
      <View style={styles.sectionBlock} testID="main-chat-history-managed-conversations">
        <View style={styles.sectionHeaderRow}>
          <Text style={styles.sectionTitle}>
            {t("mainChat.directions.historySection.managedHeading")}
          </Text>
          {canCreateConversation ? (
            <Button
              variant="outline"
              size="sm"
              leftIcon={ThemedPlus}
              onPress={onOpenCreateModal}
              testID="main-chat-history-create-conversation"
            >
              {t("mainChat.directions.actions.createNew")}
            </Button>
          ) : null}
        </View>

        {managedConversations.length > 0 ? (
          <View style={styles.cardList}>
            {managedConversations.map((record) => (
              <ManagedConversationCard
                key={record.id}
                record={record}
                canMutate={canMutateConversation}
                busy={busyConversationId === record.id}
                onOpen={onOpenManagedConversation}
                onToggleLeader={onToggleManagedLeader}
                onToggleArchive={onToggleManagedArchive}
              />
            ))}
          </View>
        ) : (
          <Text style={styles.emptyText}>
            {t("mainChat.directions.historySection.emptyManaged")}
          </Text>
        )}
      </View>

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

const ActivityFilterPill = memo(function ActivityFilterPill({
  filter,
  count,
  selected,
  onSelect,
}: {
  filter: MainChatActivityFilter;
  count: number;
  selected: boolean;
  onSelect: (filter: MainChatActivityFilter) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(filter), [filter, onSelect]);
  const pillStyle = useMemo(
    () => [styles.filterPill, selected && styles.filterPillSelected],
    [selected],
  );
  const labelStyle = useMemo(
    () => [styles.filterPillLabel, selected && styles.filterPillLabelSelected],
    [selected],
  );

  return (
    <PressHighlight
      onPress={handlePress}
      style={pillStyle}
      highlightStyle={styles.itemCardPressed}
      accessibilityRole="button"
      accessibilityLabel={t(resolveActivityFilterKey(filter))}
      testID={`main-chat-activity-filter-${filter}`}
    >
      <Text style={labelStyle} numberOfLines={1}>
        {t(resolveActivityFilterKey(filter))} ({count})
      </Text>
    </PressHighlight>
  );
});

const ActivityAuditCard = memo(function ActivityAuditCard({
  entry,
  expanded,
  onToggleExpand,
  onOpenRelatedAgent,
}: {
  entry: MainChatActivityEntry;
  expanded: boolean;
  onToggleExpand: (entryId: string) => void;
  onOpenRelatedAgent?: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const handleToggle = useCallback(() => onToggleExpand(entry.id), [entry.id, onToggleExpand]);
  const handleOpenRelated = useCallback(() => {
    if (entry.relatedAgentId) onOpenRelatedAgent?.(entry.relatedAgentId);
  }, [entry.relatedAgentId, onOpenRelatedAgent]);

  const hasDetail = Boolean(entry.detail?.trim() || entry.completedAt || entry.relatedAgentId);
  const timestamp = formatIsoTime(entry.createdAt);

  return (
    <View style={styles.auditCard} testID={`main-chat-activity-entry-${entry.id}`}>
      <PressHighlight
        onPress={handleToggle}
        style={styles.auditHeaderRow}
        highlightStyle={styles.itemCardPressed}
        accessibilityRole="button"
        accessibilityLabel={entry.summary}
        testID={`main-chat-activity-toggle-${entry.id}`}
      >
        <View style={styles.auditChevron}>
          {expanded ? (
            <ThemedChevronDown size={14} uniProps={mutedIconMapping} />
          ) : (
            <ThemedChevronRight size={14} uniProps={mutedIconMapping} />
          )}
        </View>
        <View style={styles.itemBody}>
          <View style={styles.itemTitleRow}>
            <StatusBadge size="xs" variant="muted" label={t(resolveActivityKindKey(entry.kind))} />
            <StatusBadge
              size="xs"
              variant={resolveActivityStatusVariant(entry.status)}
              label={t(resolveActivityStatusKey(entry.status))}
            />
            {entry.silent ? (
              <StatusBadge size="xs" variant="muted" label={t("mainChat.history.silentBadge")} />
            ) : null}
            {entry.preemptedByUser ? (
              <StatusBadge
                size="xs"
                variant="warning"
                label={t("mainChat.history.preemptedByUserBadge")}
              />
            ) : null}
          </View>
          <Text style={styles.itemTitle} numberOfLines={expanded ? undefined : 2}>
            {entry.summary}
          </Text>
          <Text style={styles.itemMeta} numberOfLines={1}>
            {t("mainChat.history.triggerMeta", { trigger: entry.trigger })}
            {timestamp ? ` · ${timestamp}` : ""}
          </Text>
        </View>
      </PressHighlight>

      {expanded && hasDetail ? (
        <View style={styles.auditDetailBox} testID={`main-chat-activity-detail-${entry.id}`}>
          {entry.detail?.trim() ? <Text style={styles.auditDetailText}>{entry.detail}</Text> : null}
          {entry.completedAt ? (
            <Text style={styles.itemMeta}>
              {t("mainChat.history.completedAtMeta", { time: formatIsoTime(entry.completedAt) })}
            </Text>
          ) : null}
          {entry.relatedAgentId && onOpenRelatedAgent ? (
            <PressHighlight
              onPress={handleOpenRelated}
              style={styles.relatedLink}
              highlightStyle={styles.itemCardPressed}
              accessibilityRole="button"
              accessibilityLabel={t("mainChat.openChildAgent")}
              testID={`main-chat-activity-open-agent-${entry.id}`}
            >
              <Text style={styles.relatedLinkText}>{t("mainChat.openChildAgent")}</Text>
              <ThemedArrowUpRight size={12} uniProps={mutedIconMapping} />
            </PressHighlight>
          ) : null}
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
  activities,
  isLoadingActivities,
  activitiesError,
  activeFilter,
  onSelectFilter,
  onRefreshActivities,
  onOpenRelatedAgent,
}: {
  overview: MainChatOverview | null;
  lastPatrol: MainChatPatrolResult | null;
  activities: readonly MainChatActivityEntry[];
  isLoadingActivities: boolean;
  activitiesError: string | null;
  activeFilter: MainChatActivityFilter;
  onSelectFilter: (filter: MainChatActivityFilter) => void;
  onRefreshActivities: () => void;
  onOpenRelatedAgent?: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());

  const handleToggleExpand = useCallback((entryId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }, []);

  const filteredActivities = useMemo(
    () => filterMainChatActivityEntries(activities, activeFilter),
    [activities, activeFilter],
  );

  const countsByFilter = useMemo(() => {
    const map: Record<MainChatActivityFilter, number> = {
      all: activities.length,
      silent: 0,
      preempted: 0,
      compaction_handoff: 0,
      missing_reply_recovery: 0,
    };
    for (const filter of ACTIVITY_FILTERS) {
      if (filter === "all") continue;
      map[filter] = filterMainChatActivityEntries(activities, filter).length;
    }
    return map;
  }, [activities]);

  const metrics = overview?.metrics ?? null;
  const triages = overview?.triages ?? [];

  return (
    <View style={styles.sectionStack} testID="main-chat-history-activity">
      <View style={styles.sectionBlock}>
        <View style={styles.auditHeaderBar}>
          <Text style={styles.sectionTitle}>{t("mainChat.history.auditHeading")}</Text>
          <Button
            variant="outline"
            size="sm"
            leftIcon={ThemedRefreshCw}
            loading={isLoadingActivities}
            onPress={onRefreshActivities}
            testID="main-chat-activity-refresh"
          >
            {t("mainChat.history.refreshActivity")}
          </Button>
        </View>

        <View style={styles.filterRow} testID="main-chat-activity-filters">
          {ACTIVITY_FILTERS.map((filter) => (
            <ActivityFilterPill
              key={filter}
              filter={filter}
              count={countsByFilter[filter]}
              selected={activeFilter === filter}
              onSelect={onSelectFilter}
            />
          ))}
        </View>

        {activitiesError ? (
          <View style={styles.infoCard} testID="main-chat-activity-error">
            <Text style={styles.errorText}>{activitiesError}</Text>
          </View>
        ) : null}

        {filteredActivities.length > 0 ? (
          <View style={styles.cardList} testID="main-chat-activity-list">
            {filteredActivities.map((entry) => (
              <ActivityAuditCard
                key={entry.id}
                entry={entry}
                expanded={expandedIds.has(entry.id)}
                onToggleExpand={handleToggleExpand}
                onOpenRelatedAgent={onOpenRelatedAgent}
              />
            ))}
          </View>
        ) : null}
        {filteredActivities.length === 0 && !isLoadingActivities ? (
          <Text style={styles.emptyText} testID="main-chat-activity-empty">
            {activities.length === 0
              ? t("mainChat.history.emptyAuditLog")
              : t("mainChat.history.emptyFilteredAuditLog")}
          </Text>
        ) : null}
      </View>

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

        {triages.length === 0 && !lastPatrol && !metrics && activities.length === 0 ? (
          <Text style={styles.emptyText}>{t("mainChat.history.emptyActivity")}</Text>
        ) : null}
      </View>
    </View>
  );
});

function useMainChatActivityAudit(input: {
  client: DaemonClient | null;
  mainAgentId: string | undefined;
  enabled: boolean;
}) {
  const { client, mainAgentId, enabled } = input;
  const { t } = useTranslation();
  const [activities, setActivities] = useState<MainChatActivityEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadFailedMessage = t("mainChat.history.loadAuditFailed");

  const load = useCallback(async () => {
    if (!client) return;
    setIsLoading(true);
    setError(null);
    try {
      const response = await client.listMainChatActivity({
        ...(mainAgentId ? { mainAgentId } : {}),
        includeSilent: true,
        limit: 100,
      });
      if (response.error) {
        setError(response.error);
        return;
      }
      setActivities(response.activities);
    } catch (err) {
      setError(err instanceof Error ? err.message : loadFailedMessage);
    } finally {
      setIsLoading(false);
    }
  }, [client, loadFailedMessage, mainAgentId]);

  useEffect(() => {
    if (!enabled || !client) return;
    void load();
  }, [client, enabled, load]);

  return {
    activities,
    isLoading,
    error,
    refresh: load,
  };
}

/**
 * `/main/history` — Assistant conversation history and M2 background activity audit view.
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
  const [activityFilter, setActivityFilter] = useState<MainChatActivityFilter>("all");
  const [isPatrolling, setIsPatrolling] = useState(false);
  const [createModalVisible, setCreateModalVisible] = useState(false);
  const [busyConversationId, setBusyConversationId] = useState<string | null>(null);

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

  const conversationsFromStore = useStoreWithEqualityFn(
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
  const storeConversations = useMainChatConversationsStore((state) =>
    targetServerId ? (state.conversationsByServerId[targetServerId] ?? null) : null,
  );
  const hydrateFromOverview = useMainChatConversationsStore((state) => state.hydrateFromOverview);
  const refreshConversations = useMainChatConversationsStore((state) => state.refreshConversations);
  const createConversation = useMainChatConversationsStore((state) => state.createConversation);
  const promoteToLeader = useMainChatConversationsStore((state) => state.promoteToLeader);
  const demoteToSide = useMainChatConversationsStore((state) => state.demoteToSide);
  const archiveConversation = useMainChatConversationsStore((state) => state.archiveConversation);

  useEffect(() => {
    if (!activeMainRef || !client) return;
    void loadOverview(activeMainRef.serverId, activeMainRef.agentId, client).then((loaded) => {
      if (loaded) hydrateFromOverview(activeMainRef.serverId, loaded);
      return loaded;
    });
  }, [activeMainRef, client, hydrateFromOverview, loadOverview]);

  useEffect(() => {
    if (!targetServerId || !client || typeof client.listMainChatConversations !== "function") {
      return;
    }
    void refreshConversations(targetServerId, client, { includeArchived: true }).catch(
      () => undefined,
    );
  }, [client, refreshConversations, targetServerId]);

  const managedConversations = useMemo(() => {
    const raw = storeConversations ?? overview?.conversations ?? EMPTY_CONVERSATIONS;
    return sortConversationsByActivity(raw.filter((record) => record.kind !== "main"));
  }, [overview?.conversations, storeConversations]);

  const audit = useMainChatActivityAudit({
    client,
    mainAgentId: activeMainRef?.agentId,
    enabled: activeTab === "activity",
  });

  const conversations = useMemo(() => {
    if (!overview?.conversations || overview.conversations.length === 0) {
      return conversationsFromStore;
    }
    const existingKeys = new Set(
      conversationsFromStore.map((item) => `${item.serverId}:${item.agentId}`),
    );
    const merged = [...conversationsFromStore];
    for (const conv of overview.conversations) {
      const srvId = conv.serverId ?? targetServerId ?? "";
      if (!srvId) continue;
      const key = `${srvId}:${conv.agentId}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);
      merged.push({
        serverId: srvId,
        agentId: conv.agentId,
        title: conv.title,
        archived: conv.archivedAt !== null,
        isActiveMain:
          conv.kind === "main" &&
          conv.archivedAt === null &&
          activeMainRef?.agentId === conv.agentId,
        isFormerMain: conv.kind === "main" && conv.archivedAt !== null,
        updatedAtMs: Date.parse(conv.updatedAt) || 0,
      });
    }
    return merged;
  }, [activeMainRef?.agentId, conversationsFromStore, overview?.conversations, targetServerId]);

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
        const tasks: Promise<unknown>[] = [];
        if (activeMainRef) {
          tasks.push(loadOverview(activeMainRef.serverId, activeMainRef.agentId, client));
        }
        if (activeTab === "activity") {
          tasks.push(audit.refresh());
        }
        return Promise.all(tasks);
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t("mainChat.patrolFailed"));
      })
      .finally(() => {
        setIsPatrolling(false);
      });
  }, [
    activeMainRef,
    activeTab,
    audit,
    client,
    isPatrolling,
    loadOverview,
    t,
    targetServerId,
    toast,
    triggerPatrol,
  ]);

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

  const handleOpenRelatedAgent = useCallback(
    (agentId: string) => {
      if (!targetServerId) return;
      const mode = openMainChatTaskTarget({
        serverId: targetServerId,
        agentId,
        isCompact,
        inMainChatRoute: true,
        originRoute: buildMainChatHistoryRoute(),
        originTitle: t("mainChat.history.title"),
      });
      if (mode === "drawer") {
        router.push(buildMainChatRoute());
      }
    },
    [isCompact, t, targetServerId],
  );

  const handleRefreshActivities = useCallback(() => {
    void audit.refresh();
  }, [audit]);

  const handleOpenCreateModal = useCallback(() => {
    setCreateModalVisible(true);
  }, []);

  const handleCloseCreateModal = useCallback(() => {
    setCreateModalVisible(false);
  }, []);

  const handleConversationCreated = useCallback(
    (created: MainChatConversationRecord) => {
      setCreateModalVisible(false);
      toast.show(t("mainChat.directions.toasts.created", { title: created.title }), {
        variant: "success",
      });
      router.push(buildMainChatConversationRoute(created.id));
    },
    [t, toast],
  );

  const handleOpenManagedConversation = useCallback((record: MainChatConversationRecord) => {
    router.push(buildMainChatConversationRoute(record.id));
  }, []);

  const handleToggleManagedLeader = useCallback(
    (record: MainChatConversationRecord) => {
      if (!targetServerId || !client || busyConversationId) return;
      const promoting = record.kind !== "leader";
      setBusyConversationId(record.id);
      const task = promoting
        ? promoteToLeader(targetServerId, record.id, client)
        : demoteToSide(targetServerId, record.id, client);
      void task
        .then(() => {
          toast.show(
            promoting
              ? t("mainChat.directions.toasts.promoted")
              : t("mainChat.directions.toasts.demoted"),
            { variant: "success" },
          );
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("mainChat.directions.toasts.actionFailed"),
          );
        })
        .finally(() => setBusyConversationId(null));
    },
    [busyConversationId, client, demoteToSide, promoteToLeader, t, targetServerId, toast],
  );

  const handleToggleManagedArchive = useCallback(
    (record: MainChatConversationRecord) => {
      if (!targetServerId || !client || busyConversationId) return;
      const archiving = record.archivedAt === null;
      setBusyConversationId(record.id);
      void archiveConversation(targetServerId, record.id, client, archiving)
        .then(() => {
          toast.show(
            archiving
              ? t("mainChat.directions.toasts.archived")
              : t("mainChat.directions.toasts.unarchived"),
            { variant: "success" },
          );
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("mainChat.directions.toasts.actionFailed"),
          );
        })
        .finally(() => setBusyConversationId(null));
    },
    [archiveConversation, busyConversationId, client, t, targetServerId, toast],
  );

  const canCreateConversation = Boolean(
    targetServerId && client && typeof client.createMainChatConversation === "function",
  );
  const canMutateConversation = Boolean(
    targetServerId && client && typeof client.updateMainChatConversation === "function",
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
              managedConversations={managedConversations}
              conversations={conversations}
              dockTasks={dockTasks}
              hostLabelByServerId={hostLabelByServerId}
              canCreateConversation={canCreateConversation}
              canMutateConversation={canMutateConversation}
              busyConversationId={busyConversationId}
              onOpenCreateModal={handleOpenCreateModal}
              onOpenManagedConversation={handleOpenManagedConversation}
              onToggleManagedLeader={handleToggleManagedLeader}
              onToggleManagedArchive={handleToggleManagedArchive}
              onOpenConversation={handleOpenConversation}
              onOpenTask={handleOpenTask}
            />
          ) : (
            <HistoryActivityTab
              overview={overview}
              lastPatrol={lastPatrol}
              activities={audit.activities}
              isLoadingActivities={audit.isLoading}
              activitiesError={audit.error}
              activeFilter={activityFilter}
              onSelectFilter={setActivityFilter}
              onRefreshActivities={handleRefreshActivities}
              onOpenRelatedAgent={targetServerId ? handleOpenRelatedAgent : undefined}
            />
          )}
        </View>
      </ScrollView>

      <CreateConversationModal
        visible={createModalVisible}
        serverId={targetServerId}
        client={client}
        onCreate={createConversation}
        onCreated={handleConversationCreated}
        onClose={handleCloseCreateModal}
      />
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
  auditHeaderBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  filterRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  filterPill: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  filterPillSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface2,
  },
  filterPillLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  filterPillLabelSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  cardList: {
    gap: theme.spacing[2],
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
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
  managedCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  managedCardMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  managedSummary: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  managedCardActions: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  auditCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  auditHeaderRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  auditChevron: {
    paddingTop: 2,
    flexShrink: 0,
  },
  auditDetailBox: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  auditDetailText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 19,
  },
  relatedLink: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  relatedLinkText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
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
    gap: theme.spacing[1.5],
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
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    paddingVertical: theme.spacing[2],
  },
}));
