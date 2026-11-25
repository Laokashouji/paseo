import { buildConversationActionBarModel } from "./conversation-action-bar-model";
export {
  filterOverviewForConversation,
  buildConversationActionBarModel,
} from "./conversation-action-bar-model";
import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
import {
  MAIN_CHAT_CONVERSATION_KIND_LABEL,
  getManagedConversationId,
  isMainChatAgent,
  type MainChatConversationKind,
  type MainChatConversationRecord,
} from "@getpaseo/protocol/main-chat";
import { router } from "expo-router";
import { useIsFocused } from "expo-router/react-navigation";
import equal from "fast-deep-equal";
import {
  Archive,
  ArrowLeft,
  AtSign,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Compass,
  History,
  MessageSquare,
  Pause,
  Pencil,
  Pin,
  PinOff,
  Play,
  RefreshCcw,
  X,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { StatusRing } from "@/components/status-ring";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import { useHosts } from "@/runtime/host-runtime";
import { useLastWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import {
  buildMainChatConversationRoute,
  buildMainChatHistoryRoute,
  buildMainChatRoute,
} from "@/utils/host-routes";
import {
  type ActionBarBucketKey,
  type ActionBarLiveAgentSnapshot,
  type ActionBarNeedsYouItem,
  type ActionBarPendingPermissionInput,
  type ActionBarTaskItem,
  type MainChatActionBarModel,
} from "./action-bar-model";
import { MainChatAgentHost } from "./agent-host";
import {
  findConversationInRecords,
  selectConversationRecordFromStore,
  useMainChatConversationsStore,
} from "./conversations-store";
import { EditConversationModal } from "./directions-tree";
import { MainChatShell } from "./main-chat-shell";
import { NeedsYouInlineBody } from "./action-bar";
import {
  selectActionBarSessionSnapshot,
  useMainChatActionBarDrawerStore,
  needsYouDismissSignature,
  filterDismissedRequests,
  EMPTY_DISMISSED_NEEDS_MAP,
} from "./action-bar-state";
import { useOpenMainChatTaskTarget } from "./open-task-target";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { useMainChatRouteStore } from "./route-store";
import { selectMainChatSidebarSummary } from "./selectors";
import { useMainChatStewardRoster, useStewardAllowedServerIds } from "./use-steward-roster";

const ThemedArchive = withUnistyles(Archive);
const ThemedArrowLeft = withUnistyles(ArrowLeft);
const ThemedAtSign = withUnistyles(AtSign);
const ThemedCheckCircle = withUnistyles(CheckCircle2);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCompass = withUnistyles(Compass);
const ThemedHistory = withUnistyles(History);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedPause = withUnistyles(Pause);
const ThemedPencil = withUnistyles(Pencil);
const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);
const ThemedPlay = withUnistyles(Play);
const ThemedRefreshCcw = withUnistyles(RefreshCcw);
const ThemedX = withUnistyles(X);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const pinLeaderIcon = <ThemedPin size={14} uniProps={primaryIconMapping} />;
const unpinLeaderIcon = <ThemedPinOff size={14} uniProps={mutedIconMapping} />;
const editConversationIcon = <ThemedPencil size={14} uniProps={mutedIconMapping} />;
const archiveConversationIcon = <ThemedArchive size={14} uniProps={dangerIconMapping} />;
const restoreConversationIcon = <ThemedRefreshCcw size={14} uniProps={mutedIconMapping} />;
const leaderBadgeLeading = <ThemedCompass size={11} uniProps={successIconMapping} />;
const sideBadgeLeading = <ThemedMessageSquare size={11} uniProps={mutedIconMapping} />;

export interface MainChatConversationScreenProps {
  conversationId: string;
  serverId?: string | null;
}

interface ResolvedConversation {
  serverId: string;
  agentId: string;
  workspaceId: string;
  title: string;
  kind: MainChatConversationKind;
  directionSummary: string | null;
  archivedAt: string | null;
  isRunning: boolean;
  record: MainChatConversationRecord | null;
}

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

interface ConversationScopedSessionData {
  agentWorkspaceId: string;
  agentTitle: string | null;
  isRunning: boolean;
  liveAgents: ActionBarLiveAgentSnapshot[];
  pendingPermissions: ActionBarPendingPermissionInput[];
}

type HostSessionEntry = SessionStoreState["sessions"][string];
type SessionAgentEntry = NonNullable<ReturnType<HostSessionEntry["agents"]["get"]>>;

function resolveFallbackConversationKind(agent: SessionAgentEntry) {
  return agent.labels?.[MAIN_CHAT_CONVERSATION_KIND_LABEL] === "leader" ? "leader" : "side";
}

function toResolvedSessionAgent(serverId: string, agent: SessionAgentEntry): ResolvedConversation {
  return {
    serverId,
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? "",
    title: agent.title?.trim() || agent.id,
    kind: isMainChatAgent(agent) ? "main" : resolveFallbackConversationKind(agent),
    directionSummary: null,
    archivedAt: agent.archivedAt ? agent.archivedAt.toISOString() : null,
    isRunning:
      agent.turn.phase === "open" ||
      isAgentRunning({ status: agent.status, backgroundWork: agent.backgroundWork }),
    record: null,
  };
}

function resolveSessionAgentFallback(
  state: SessionStoreState,
  conversationId: string,
): ResolvedConversation | null {
  const trimmed = conversationId.trim();
  if (!trimmed) return null;

  const separator = trimmed.indexOf(":");
  if (separator > 0 && separator < trimmed.length - 1) {
    const serverId = trimmed.slice(0, separator);
    const agentId = trimmed.slice(separator + 1);
    const session = state.sessions[serverId];
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    if (agent) return toResolvedSessionAgent(serverId, agent);
  }

  for (const [serverId, session] of Object.entries(state.sessions)) {
    const agent = session.agents.get(trimmed) ?? session.agentDetails.get(trimmed);
    if (agent) return toResolvedSessionAgent(serverId, agent);
    for (const candidate of session.agents.values()) {
      if (getManagedConversationId(candidate.labels) === trimmed)
        return toResolvedSessionAgent(serverId, candidate);
    }
  }
  return null;
}

function selectConversationScopedSessionData(
  state: Pick<SessionStoreState, "sessions">,
  serverId: string | null,
  conversationAgentId: string | null,
  allowedServerIds?: ReadonlySet<string> | null,
): ConversationScopedSessionData {
  if (!serverId || !conversationAgentId) {
    return {
      agentWorkspaceId: "",
      agentTitle: null,
      isRunning: false,
      liveAgents: [],
      pendingPermissions: [],
    };
  }

  const hostSession = state.sessions[serverId];
  const convAgent =
    hostSession?.agents.get(conversationAgentId) ??
    hostSession?.agentDetails.get(conversationAgentId);

  const { liveAgents, pendingPermissions } = selectActionBarSessionSnapshot(
    state,
    serverId,
    conversationAgentId,
    allowedServerIds,
    "conversation",
  );

  const isRunning = Boolean(
    convAgent &&
    (convAgent.turn.phase === "open" ||
      isAgentRunning({ status: convAgent.status, backgroundWork: convAgent.backgroundWork })),
  );

  return {
    agentWorkspaceId: convAgent?.workspaceId ?? "",
    agentTitle: convAgent?.title?.trim() || null,
    isRunning,
    liveAgents,
    pendingPermissions,
  };
}

const ConversationContextBar = memo(function ConversationContextBar({
  kind,
  directionSummary,
  archivedAt,
}: {
  kind: MainChatConversationKind;
  directionSummary: string | null;
  archivedAt: string | null;
}) {
  const { t } = useTranslation();
  const [summaryExpanded, setSummaryExpanded] = useState(true);
  const toggleSummary = useCallback(() => setSummaryExpanded((prev) => !prev), []);

  const isLeader = kind === "leader";
  const trimmedSummary = directionSummary?.trim() || null;

  return (
    <View style={styles.contextBar} testID="main-chat-conversation-context-bar">
      <View style={styles.contextHeaderRow}>
        <View style={styles.roleBadgesRow}>
          <View
            testID={isLeader ? "conversation-role-badge-leader" : "conversation-role-badge-side"}
          >
            <StatusBadge
              size="xs"
              variant={isLeader ? "success" : "muted"}
              leading={isLeader ? leaderBadgeLeading : sideBadgeLeading}
              label={
                isLeader
                  ? t("mainChat.directions.roleLeaderBadge")
                  : t("mainChat.directions.roleSideBadge")
              }
            />
          </View>
          {archivedAt ? (
            <StatusBadge
              size="xs"
              variant="warning"
              label={t("mainChat.directions.roleArchivedBadge")}
            />
          ) : null}
        </View>

        {trimmedSummary ? (
          <PressHighlight
            onPress={toggleSummary}
            style={styles.summaryToggleButton}
            highlightStyle={styles.controlPressed}
            accessibilityRole="button"
            accessibilityLabel={
              summaryExpanded
                ? t("mainChat.directions.collapseSummary")
                : t("mainChat.directions.expandSummary")
            }
            testID="conversation-direction-summary-toggle"
          >
            <Text style={styles.summaryToggleLabel}>
              {t("mainChat.directions.directionSummaryLabel")}
            </Text>
            {summaryExpanded ? (
              <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
            ) : (
              <ThemedChevronRight size={13} uniProps={mutedIconMapping} />
            )}
          </PressHighlight>
        ) : null}
      </View>

      {trimmedSummary ? (
        <View style={styles.summaryBox} testID="conversation-direction-summary-bar">
          <Text
            style={styles.summaryText}
            numberOfLines={summaryExpanded ? undefined : 1}
            testID="conversation-direction-summary-text"
          >
            {trimmedSummary}
          </Text>
        </View>
      ) : null}
    </View>
  );
});

const ConversationNeedsYouRow = memo(function ConversationNeedsYouRow({
  item,
  mainServerId,
  mainAgentId,
  expanded,
  onToggle,
  onOpenTarget,
}: {
  item: ActionBarNeedsYouItem;
  mainServerId: string;
  mainAgentId: string;
  expanded: boolean;
  onToggle: (id: string) => void;
  onOpenTarget: (target: {
    serverId: string;
    agentId: string;
    workspaceId?: string | null;
    title?: string | null;
    taskId?: string | null;
  }) => void;
}) {
  const dismiss = useMainChatActionBarDrawerStore((state) => state.dismissNeedsItem);
  const handleDismiss = useCallback(
    (entry: ActionBarNeedsYouItem) =>
      dismiss(overviewStoreKey(mainServerId, mainAgentId), needsYouDismissSignature(entry)),
    [dismiss, mainAgentId, mainServerId],
  );
  const handleToggle = useCallback(() => onToggle(item.id), [item.id, onToggle]);
  return (
    <View style={styles.trayRowCard} testID={`conversation-action-needs-row-${item.id}`}>
      <PressHighlight
        onPress={handleToggle}
        style={styles.trayRowHeader}
        highlightStyle={styles.controlPressed}
        accessibilityRole="button"
        testID={`conversation-action-needs-toggle-${item.id}`}
      >
        {expanded ? (
          <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
        ) : (
          <ThemedChevronRight size={13} uniProps={mutedIconMapping} />
        )}
        <View style={styles.dotNeedsYou} />
        <Text style={styles.trayRowTitle} numberOfLines={1}>
          {item.title}
        </Text>
        {item.hostLabel ? <Text style={styles.trayRowHost}>[{item.hostLabel}]</Text> : null}
      </PressHighlight>

      {expanded ? (
        <View style={styles.trayRowBody}>
          {[item, ...(item.relatedRequests ?? [])].map((request) => (
            <NeedsYouInlineBody
              key={request.id}
              item={request}
              mainServerId={mainServerId}
              mainAgentId={mainAgentId}
              isRetrying={false}
              onOpenTarget={onOpenTarget}
              onDismiss={handleDismiss}
              onSubmitted={handleToggle}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const ConversationTaskRow = memo(function ConversationTaskRow({
  bucket,
  item,
  busyTaskId,
  onOpenTask,
  onDirectRoute,
  onParkTask,
  onAcceptReview,
}: {
  bucket: Exclude<ActionBarBucketKey, "needsYou">;
  item: ActionBarTaskItem;
  busyTaskId: string | null;
  onOpenTask: (item: ActionBarTaskItem) => void;
  onDirectRoute: (item: ActionBarTaskItem) => void;
  onParkTask: (taskId: string, parked: boolean) => void;
  onAcceptReview: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const handleOpen = useCallback(() => onOpenTask(item), [item, onOpenTask]);
  const handleDirectRoute = useCallback(() => onDirectRoute(item), [item, onDirectRoute]);
  const handlePause = useCallback(() => {
    if (item.taskId) onParkTask(item.taskId, true);
  }, [item.taskId, onParkTask]);
  const handleResume = useCallback(() => {
    if (item.taskId) onParkTask(item.taskId, false);
  }, [item.taskId, onParkTask]);
  const handleAccept = useCallback(() => {
    if (item.taskId) onAcceptReview(item.taskId);
  }, [item.taskId, onAcceptReview]);

  const isBusy = Boolean(item.taskId && busyTaskId === item.taskId);

  return (
    <View style={styles.trayTaskRow} testID={`conversation-action-task-${item.id}`}>
      <PressHighlight
        onPress={handleOpen}
        disabled={!item.agentId}
        style={styles.trayTaskMain}
        highlightStyle={styles.controlPressed}
        accessibilityRole="button"
      >
        {item.isLiveRunning ? (
          <View style={styles.ringWrap}>
            <StatusRing />
          </View>
        ) : (
          <View style={styles.dotMuted} />
        )}
        <Text style={styles.trayRowTitle} numberOfLines={1}>
          {item.title}
        </Text>
        {item.hostLabel ? <Text style={styles.trayRowHost}>[{item.hostLabel}]</Text> : null}
      </PressHighlight>

      <View style={styles.trayTaskActions}>
        {bucket === "inProgress" && item.taskId ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={ThemedPause}
            disabled={isBusy}
            onPress={handlePause}
          >
            {t("mainChat.actionBar.pauseAction")}
          </Button>
        ) : null}
        {bucket === "parked" && item.taskId ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={ThemedPlay}
            disabled={isBusy}
            onPress={handleResume}
          >
            {t("mainChat.actionBar.resumeAction")}
          </Button>
        ) : null}
        {bucket === "awaitingReview" && item.taskId ? (
          <Button
            variant="secondary"
            size="sm"
            leftIcon={ThemedCheckCircle}
            disabled={isBusy}
            onPress={handleAccept}
          >
            {t("mainChat.actionBar.acceptAction")}
          </Button>
        ) : null}
        {item.agentId ? (
          <Button
            variant="ghost"
            size="sm"
            leftIcon={ThemedAtSign}
            onPress={handleDirectRoute}
            testID={`conversation-action-direct-${item.id}`}
          >
            {t("mainChat.board.talkDirectly")}
          </Button>
        ) : null}
      </View>
    </View>
  );
});

function resolveBucketCapsuleLabel(
  bucket: ActionBarBucketKey,
  count: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (bucket) {
    case "needsYou":
      return t("mainChat.actionBar.capsuleNeedsYou", { count });
    case "inProgress":
      return t("mainChat.actionBar.capsuleInProgress", { count });
    case "awaitingReview":
      return t("mainChat.actionBar.capsuleAwaitingReview", { count });
    case "parked":
      return t("mainChat.actionBar.capsuleParked", { count });
    case "completed24h":
      return t("mainChat.actionBar.capsuleCompleted", { count });
  }
}

function resolveBucketTitleKey(bucket: ActionBarBucketKey): string {
  switch (bucket) {
    case "needsYou":
      return "mainChat.actionBar.panelNeedsYou";
    case "inProgress":
      return "mainChat.actionBar.panelInProgress";
    case "awaitingReview":
      return "mainChat.actionBar.panelAwaitingReview";
    case "parked":
      return "mainChat.actionBar.panelParked";
    case "completed24h":
      return "mainChat.actionBar.panelCompleted";
  }
}

const BUCKET_ORDER: readonly ActionBarBucketKey[] = [
  "needsYou",
  "inProgress",
  "awaitingReview",
  "parked",
  "completed24h",
];

function getTasksForBucket(
  model: MainChatActionBarModel,
  bucket: ActionBarBucketKey | null,
): readonly ActionBarTaskItem[] {
  switch (bucket) {
    case "inProgress":
      return model.inProgress.all;
    case "awaitingReview":
      return model.awaitingReview;
    case "parked":
      return model.parked;
    case "completed24h":
      return model.completed24h;
    default:
      return [];
  }
}

const ConversationCapsuleButton = memo(function ConversationCapsuleButton({
  bucket,
  count,
  selected,
  onSelect,
}: {
  bucket: ActionBarBucketKey;
  count: number;
  selected: boolean;
  onSelect: (bucket: ActionBarBucketKey) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onSelect(bucket), [bucket, onSelect]);

  return (
    <PressHighlight
      onPress={handlePress}
      style={[
        styles.capsulePill,
        bucket === "needsYou" && styles.capsulePillNeedsYou,
        selected && styles.capsulePillSelected,
      ]}
      highlightStyle={styles.controlPressed}
      accessibilityRole="button"
      testID={`conversation-action-capsule-${bucket}`}
    >
      <Text
        style={[styles.capsulePillText, bucket === "needsYou" && styles.capsulePillTextNeedsYou]}
      >
        {resolveBucketCapsuleLabel(bucket, count, t)}
      </Text>
    </PressHighlight>
  );
});

const ConversationActionBar = memo(function ConversationActionBar({
  serverId,
  conversationAgentId,
  overviewMainAgentId,
  model,
}: {
  serverId: string;
  conversationAgentId: string;
  overviewMainAgentId: string;
  model: MainChatActionBarModel;
}): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const openMainChatTaskTarget = useOpenMainChatTaskTarget();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const parkTask = useMainChatOverviewStore((state) => state.parkTask);
  const reviewTask = useMainChatOverviewStore((state) => state.reviewTask);
  const setRouteTarget = useMainChatRouteStore((state) => state.setTarget);

  const [openBucket, setOpenBucket] = useState<ActionBarBucketKey | null>(null);
  const [expandedNeedsIds, setExpandedNeedsIds] = useState<ReadonlySet<string>>(() => new Set());
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (openBucket && model.counts[openBucket] === 0) {
      setOpenBucket(null);
    }
  }, [model.counts, openBucket]);

  const handleToggleNeedsRow = useCallback((id: string) => {
    setExpandedNeedsIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectBucket = useCallback(
    (bucket: ActionBarBucketKey) => {
      setOpenBucket((current) => {
        if (current === bucket) return null;
        if (bucket === "needsYou" && model.needsYou.length === 1) {
          setExpandedNeedsIds(new Set([model.needsYou[0]!.id]));
        }
        return bucket;
      });
    },
    [model.needsYou],
  );

  const handleCloseDrawer = useCallback(() => setOpenBucket(null), []);

  const handleOpenTarget = useCallback(
    (target: {
      serverId: string;
      agentId: string;
      workspaceId?: string | null;
      title?: string | null;
      taskId?: string | null;
    }) => {
      openMainChatTaskTarget(target);
    },
    [openMainChatTaskTarget],
  );

  const handleOpenTaskItem = useCallback(
    (item: ActionBarTaskItem) => {
      if (!item.agentId) return;
      openMainChatTaskTarget({
        serverId: item.serverId,
        agentId: item.agentId,
        workspaceId: item.workspaceId,
        title: item.title,
        taskId: item.taskId,
      });
    },
    [openMainChatTaskTarget],
  );

  const handleDirectRouteTaskItem = useCallback(
    (item: ActionBarTaskItem) => {
      if (!item.agentId) return;
      setRouteTarget(serverId, conversationAgentId, {
        targetServerId: item.serverId,
        targetAgentId: item.agentId,
        targetTitle: item.title,
      });
      setOpenBucket(null);
    },
    [conversationAgentId, serverId, setRouteTarget],
  );

  const handleParkTask = useCallback(
    (taskId: string, parked: boolean) => {
      if (!client || busyTaskId) return;
      setBusyTaskId(taskId);
      void parkTask(serverId, overviewMainAgentId, { taskId, parked }, client)
        .then(() => {
          toast.show(
            parked ? t("mainChat.actionBar.pausedToast") : t("mainChat.actionBar.resumedToast"),
            { variant: "success" },
          );
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("mainChat.actionBar.actionFailed"),
          );
        })
        .finally(() => setBusyTaskId(null));
    },
    [busyTaskId, client, overviewMainAgentId, parkTask, serverId, t, toast],
  );

  const handleAcceptReview = useCallback(
    (taskId: string) => {
      if (!client || busyTaskId) return;
      setBusyTaskId(taskId);
      void reviewTask(serverId, overviewMainAgentId, { taskId, verdict: "accept" }, client)
        .then(() => {
          toast.show(t("mainChat.actionBar.acceptedToast"), { variant: "success" });
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("mainChat.actionBar.actionFailed"),
          );
        })
        .finally(() => setBusyTaskId(null));
    },
    [busyTaskId, client, overviewMainAgentId, reviewTask, serverId, t, toast],
  );

  if (model.counts.total === 0) {
    return null;
  }

  const visibleBuckets = BUCKET_ORDER.filter((bucket) => model.counts[bucket] > 0);
  const bucketTasks = getTasksForBucket(model, openBucket);

  return (
    <View style={styles.actionBarOuter} testID="conversation-action-bar">
      {openBucket ? (
        <View style={styles.actionDrawer} testID={`conversation-action-panel-${openBucket}`}>
          <View style={styles.actionDrawerHeader}>
            <Text style={styles.actionDrawerTitle}>{t(resolveBucketTitleKey(openBucket))}</Text>
            <PressHighlight
              onPress={handleCloseDrawer}
              style={styles.closeIconButton}
              highlightStyle={styles.controlPressed}
              accessibilityRole="button"
              accessibilityLabel={t("common.actions.close")}
              testID="conversation-action-panel-close"
            >
              <ThemedX size={13} uniProps={mutedIconMapping} />
            </PressHighlight>
          </View>

          <ScrollView
            style={styles.actionDrawerScroll}
            contentContainerStyle={styles.actionDrawerContent}
          >
            {openBucket === "needsYou"
              ? model.needsYou.map((item) => (
                  <ConversationNeedsYouRow
                    key={item.id}
                    item={item}
                    mainServerId={serverId}
                    mainAgentId={overviewMainAgentId}
                    expanded={expandedNeedsIds.has(item.id)}
                    onToggle={handleToggleNeedsRow}
                    onOpenTarget={handleOpenTarget}
                  />
                ))
              : bucketTasks.map((item) => (
                  <ConversationTaskRow
                    key={item.id}
                    bucket={openBucket}
                    item={item}
                    busyTaskId={busyTaskId}
                    onOpenTask={handleOpenTaskItem}
                    onDirectRoute={handleDirectRouteTaskItem}
                    onParkTask={handleParkTask}
                    onAcceptReview={handleAcceptReview}
                  />
                ))}
          </ScrollView>
        </View>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.capsuleStrip}
      >
        {visibleBuckets.map((bucket) => (
          <ConversationCapsuleButton
            key={bucket}
            bucket={bucket}
            count={model.counts[bucket]}
            selected={openBucket === bucket}
            onSelect={handleSelectBucket}
          />
        ))}
      </ScrollView>
    </View>
  );
});

/**
 * Assistant direction leader / side conversation route (`/main/c/[conversationId]`).
 * Reuses `MainChatShell` with a `← 主对话` header back action, role badge & collapsible direction
 * summary bar, conversation-specific menu actions, and a direction-scoped five-state action bar.
 */
export function MainChatConversationScreen({
  conversationId,
  serverId,
}: MainChatConversationScreenProps): ReactElement {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={styles.inactiveContainer} />;
  }

  return (
    <MainChatConversationScreenContent
      conversationId={conversationId}
      serverId={serverId ?? null}
    />
  );
}

function buildResolvedConversation(
  matchedRecordHit: { serverId: string; record: MainChatConversationRecord } | null,
  scopedSession: ConversationScopedSessionData,
  fallbackFromSession: ResolvedConversation | null,
): ResolvedConversation | null {
  if (!matchedRecordHit) return fallbackFromSession;
  const rec = matchedRecordHit.record;
  return {
    serverId: matchedRecordHit.serverId,
    agentId: rec.agentId,
    workspaceId: rec.workspaceId ?? scopedSession.agentWorkspaceId,
    title: rec.title.trim() || scopedSession.agentTitle || rec.id,
    kind: rec.kind,
    directionSummary: rec.directionSummary,
    archivedAt: rec.archivedAt,
    isRunning: scopedSession.isRunning,
    record: rec,
  };
}

function useConversationAutoFetch(input: {
  conversationId: string;
  hasMatch: boolean;
  targetServerId: string | null;
  client: ReturnType<typeof useSessionStore.getState>["sessions"][string]["client"] | null;
}): "idle" | "loading" | "settled" {
  const { conversationId, hasMatch, targetServerId, client } = input;
  const refreshConversations = useMainChatConversationsStore((state) => state.refreshConversations);
  const [fetchStatus, setFetchStatus] = useState<"idle" | "loading" | "settled">("idle");
  const fetchedConversationIdRef = useRef<string | null>(null);

  useEffect(() => {
    const trimmed = conversationId.trim();
    if (!trimmed || hasMatch) {
      setFetchStatus("settled");
      return;
    }
    if (!targetServerId || !client || typeof client.listMainChatConversations !== "function") {
      setFetchStatus("settled");
      return;
    }
    const fetchKey = `${targetServerId}:${trimmed}`;
    if (fetchedConversationIdRef.current === fetchKey) return;
    fetchedConversationIdRef.current = fetchKey;

    let cancelled = false;
    setFetchStatus("loading");
    void refreshConversations(targetServerId, client, { includeArchived: true })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setFetchStatus("settled");
      });
    return () => {
      cancelled = true;
    };
  }, [client, conversationId, hasMatch, refreshConversations, targetServerId]);

  return fetchStatus;
}

function useConversationRecordLookup(
  conversationId: string,
  preferredServerId: string | null,
  strictServerId: boolean,
) {
  const mainSummary = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) =>
        selectMainChatSidebarSummary(state, preferredServerId, null, {
          strictServerId,
        }),
      [preferredServerId, strictServerId],
    ),
    equal,
  );
  const targetServerId = mainSummary.existing?.serverId ?? mainSummary.targetServerId;
  const rootMainAgentId = mainSummary.existing?.agentId ?? null;

  const storeHit = useStoreWithEqualityFn(
    useMainChatConversationsStore,
    useCallback(
      (state) => selectConversationRecordFromStore(state, conversationId, targetServerId),
      [conversationId, targetServerId],
    ),
    equal,
  );

  const overviewKey =
    targetServerId && rootMainAgentId ? overviewStoreKey(targetServerId, rootMainAgentId) : null;
  const overview = useMainChatOverviewStore((state) =>
    overviewKey ? (state.overviewsByKey[overviewKey] ?? null) : null,
  );

  const overviewHit = useMemo(() => {
    if (!overview?.conversations) return null;
    const match = findConversationInRecords(overview.conversations, conversationId);
    return match ? { serverId: match.serverId ?? targetServerId ?? "", record: match } : null;
  }, [conversationId, overview?.conversations, targetServerId]);

  const matchedRecordHit = storeHit ?? overviewHit;

  const fallbackFromSession = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => (matchedRecordHit ? null : resolveSessionAgentFallback(state, conversationId)),
      [conversationId, matchedRecordHit],
    ),
    equal,
  );

  return {
    targetServerId,
    rootMainAgentId,
    overview,
    matchedRecordHit,
    fallbackFromSession,
  };
}

function useConversationDismissals(
  resolved: ResolvedConversation | null,
  rootMainAgentId: string | null,
) {
  const key = overviewStoreKey(
    resolved?.serverId ?? "",
    rootMainAgentId ?? resolved?.agentId ?? "",
  );
  return useMainChatActionBarDrawerStore(
    (state) => state.dismissedNeedsSignaturesByKey[key] ?? EMPTY_DISMISSED_NEEDS_MAP,
  );
}

function useResolvedConversationData(conversationId: string, routeServerId: string | null) {
  const hosts = useHosts();
  const lastWorkspace = useLastWorkspaceSelection();
  const fallbackPreferredServerId = lastWorkspace?.serverId ?? hosts[0]?.serverId ?? null;
  const { activeServerId, roster, hasMultipleStewards, selectSteward } = useMainChatStewardRoster({
    routeServerId,
    fallbackPreferredServerId,
  });
  const preferredServerId = activeServerId ?? fallbackPreferredServerId;
  const strictServerId = Boolean(routeServerId || roster.length > 0);

  useEffect(() => {
    if (routeServerId) {
      selectSteward(routeServerId);
    }
  }, [routeServerId, selectSteward]);

  const { targetServerId, rootMainAgentId, overview, matchedRecordHit, fallbackFromSession } =
    useConversationRecordLookup(conversationId, preferredServerId, strictServerId);

  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);
  const hydrateFromOverview = useMainChatConversationsStore((state) => state.hydrateFromOverview);

  const resolvedServerId =
    matchedRecordHit?.serverId || fallbackFromSession?.serverId || targetServerId;
  const resolvedAgentId = matchedRecordHit?.record.agentId ?? fallbackFromSession?.agentId ?? null;
  const allowedServerIds = useStewardAllowedServerIds(resolvedServerId);

  const sessions = useSessionStore((state) => state.sessions);
  const scopedSession = useMemo(
    () =>
      selectConversationScopedSessionData(
        { sessions },
        resolvedServerId,
        resolvedAgentId,
        allowedServerIds,
      ),
    [sessions, resolvedServerId, resolvedAgentId, allowedServerIds],
  );

  const client = useSessionStore((state) =>
    resolvedServerId ? (state.sessions[resolvedServerId]?.client ?? null) : null,
  );

  useEffect(() => {
    if (!resolvedServerId || !overview) return;
    hydrateFromOverview(resolvedServerId, overview);
  }, [hydrateFromOverview, overview, resolvedServerId]);

  useEffect(() => {
    if (!resolvedServerId || !rootMainAgentId || !client) return;
    void loadOverview(resolvedServerId, rootMainAgentId, client);
  }, [client, loadOverview, resolvedServerId, rootMainAgentId]);

  const fetchStatus = useConversationAutoFetch({
    conversationId,
    hasMatch: Boolean(matchedRecordHit || fallbackFromSession),
    targetServerId,
    client,
  });

  const resolved = useMemo(
    () => buildResolvedConversation(matchedRecordHit, scopedSession, fallbackFromSession),
    [fallbackFromSession, matchedRecordHit, scopedSession],
  );

  const hostLabelsByServerId = useMemo(
    () => Object.fromEntries(hosts.map((host) => [host.serverId, host.label])),
    [hosts],
  );

  const dismissed = useConversationDismissals(resolved, rootMainAgentId);
  const actionBarModel = useMemo(
    () =>
      resolved
        ? filterDismissedRequests(
            buildConversationActionBarModel({
              serverId: resolved.serverId,
              conversationId: resolved.record?.id ?? conversationId,
              conversationAgentId: resolved.agentId,
              overview,
              liveAgents: scopedSession.liveAgents,
              pendingPermissions: scopedSession.pendingPermissions,
              hostLabelsByServerId,
            }),
            dismissed,
          )
        : null,
    [
      conversationId,
      dismissed,
      hostLabelsByServerId,
      overview,
      resolved,
      scopedSession.liveAgents,
      scopedSession.pendingPermissions,
    ],
  );

  return {
    resolved,
    rootMainAgentId,
    client,
    actionBarModel,
    isLoading: !resolved && fetchStatus === "loading",
    hasMultipleStewards,
  };
}

const ConversationScreenBody = memo(function ConversationScreenBody({
  resolved,
  isLoading,
  rootMainAgentId,
  actionBarModel,
  activePane,
  onFocusMainPane,
  onBackToMain,
  onOpenHistory,
}: {
  resolved: ResolvedConversation | null;
  isLoading: boolean;
  rootMainAgentId: string | null;
  actionBarModel: MainChatActionBarModel | null;
  activePane: "main" | "drawer";
  onFocusMainPane: () => void;
  onBackToMain: () => void;
  onOpenHistory: () => void;
}): ReactElement {
  const { t } = useTranslation();

  if (resolved) {
    return (
      <View style={styles.conversationColumn}>
        {resolved.kind !== "main" ? (
          <ConversationContextBar
            kind={resolved.kind}
            directionSummary={resolved.directionSummary}
            archivedAt={resolved.archivedAt}
          />
        ) : null}

        <View style={styles.hostContainer}>
          <MainChatAgentHost
            key={`${resolved.serverId}:${resolved.agentId}`}
            sourceId={`main-chat-conversation:${resolved.serverId}:${resolved.agentId}`}
            serverId={resolved.serverId}
            workspaceId={resolved.workspaceId}
            agentId={resolved.agentId}
            isFocused={activePane === "main"}
            onFocusPane={onFocusMainPane}
          />
        </View>

        {actionBarModel ? (
          <ConversationActionBar
            serverId={resolved.serverId}
            conversationAgentId={resolved.agentId}
            overviewMainAgentId={rootMainAgentId ?? resolved.agentId}
            model={actionBarModel}
          />
        ) : null}
      </View>
    );
  }

  if (isLoading) {
    return (
      <View style={styles.centerState} testID="main-chat-conversation-loading">
        <ThemedLoadingSpinner size="small" />
        <Text style={styles.stateDescription}>{t("mainChat.directions.loadingConversation")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.centerState} testID="main-chat-conversation-not-found">
      <ThemedCompass size={28} uniProps={mutedIconMapping} />
      <Text style={styles.stateTitle}>{t("mainChat.shell.conversationNotFoundTitle")}</Text>
      <Text style={styles.stateDescription}>
        {t("mainChat.shell.conversationNotFoundDescription")}
      </Text>
      <View style={styles.actionsRow}>
        <Button
          variant="default"
          size="sm"
          leftIcon={ThemedArrowLeft}
          onPress={onBackToMain}
          testID="main-chat-conversation-return-main"
        >
          {t("mainChat.shell.returnToMainButton")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          leftIcon={ThemedHistory}
          onPress={onOpenHistory}
          testID="main-chat-conversation-open-history"
        >
          {t("mainChat.hero.viewHistory")}
        </Button>
      </View>
    </View>
  );
});

const ConversationExtraMenuItems = memo(function ConversationExtraMenuItems({
  record,
  disabled,
  onToggleLeader,
  onEdit,
  onToggleArchive,
}: {
  record: MainChatConversationRecord;
  disabled: boolean;
  onToggleLeader: () => void;
  onEdit: () => void;
  onToggleArchive: () => void;
}) {
  const { t } = useTranslation();
  const isLeader = record.kind === "leader";
  const isArchived = record.archivedAt !== null;

  return (
    <>
      <DropdownMenuItem
        leading={isLeader ? unpinLeaderIcon : pinLeaderIcon}
        onSelect={onToggleLeader}
        disabled={disabled}
        testID="conversation-menu-toggle-leader"
      >
        {isLeader
          ? t("mainChat.directions.actions.demoteToSide")
          : t("mainChat.directions.actions.promoteToLeader")}
      </DropdownMenuItem>
      <DropdownMenuItem
        leading={editConversationIcon}
        onSelect={onEdit}
        disabled={disabled}
        testID="conversation-menu-edit"
      >
        {t("mainChat.directions.actions.rename")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        leading={isArchived ? restoreConversationIcon : archiveConversationIcon}
        onSelect={onToggleArchive}
        disabled={disabled}
        testID="conversation-menu-archive"
      >
        {isArchived
          ? t("mainChat.directions.actions.unarchive")
          : t("mainChat.directions.actions.archive")}
      </DropdownMenuItem>
    </>
  );
});

function useConversationMutations(input: {
  resolved: ResolvedConversation | null;
  client: ReturnType<typeof useSessionStore.getState>["sessions"][string]["client"] | null;
  navServerId: string | undefined;
}) {
  const { resolved, client, navServerId } = input;
  const { t } = useTranslation();
  const toast = useToast();
  const [mutating, setMutating] = useState(false);

  const promoteToLeader = useMainChatConversationsStore((state) => state.promoteToLeader);
  const demoteToSide = useMainChatConversationsStore((state) => state.demoteToSide);
  const updateConversation = useMainChatConversationsStore((state) => state.updateConversation);
  const archiveConversation = useMainChatConversationsStore((state) => state.archiveConversation);

  const handleToggleLeader = useCallback(() => {
    if (!resolved?.record || !client || mutating) return;
    const record = resolved.record;
    const promoting = record.kind !== "leader";
    setMutating(true);
    const task = promoting
      ? promoteToLeader(resolved.serverId, record.id, client)
      : demoteToSide(resolved.serverId, record.id, client);

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
      .finally(() => setMutating(false));
  }, [client, demoteToSide, mutating, promoteToLeader, resolved, t, toast]);

  const handleToggleArchive = useCallback(() => {
    if (!resolved?.record || !client || mutating) return;
    const record = resolved.record;
    const archiving = record.archivedAt === null;
    setMutating(true);
    void archiveConversation(resolved.serverId, record.id, client, archiving)
      .then(() => {
        toast.show(
          archiving
            ? t("mainChat.directions.toasts.archived")
            : t("mainChat.directions.toasts.unarchived"),
          { variant: "success" },
        );
        if (archiving) {
          router.push(buildMainChatRoute(navServerId));
        }
        return null;
      })
      .catch((error) => {
        toast.error(
          error instanceof Error ? error.message : t("mainChat.directions.toasts.actionFailed"),
        );
      })
      .finally(() => setMutating(false));
  }, [archiveConversation, client, mutating, navServerId, resolved, t, toast]);

  const handleConversationUpdated = useCallback(() => {
    toast.show(t("mainChat.directions.toasts.updated"), { variant: "success" });
  }, [t, toast]);

  return {
    mutating,
    updateConversation,
    handleToggleLeader,
    handleToggleArchive,
    handleConversationUpdated,
  };
}

function resolveShellHeaderMeta(input: {
  conversationId: string;
  resolved: ResolvedConversation | null;
  rootMainAgentId: string | null;
  actionBarModel: MainChatActionBarModel | null;
  fallbackTitle: string;
  navServerId: string | undefined;
}) {
  const { conversationId, resolved, rootMainAgentId, actionBarModel, fallbackTitle, navServerId } =
    input;
  return {
    title: resolved ? resolved.title : fallbackTitle,
    serverId: resolved ? resolved.serverId : null,
    mainAgentId: rootMainAgentId ?? (resolved ? resolved.agentId : null),
    originRoute: conversationId.trim()
      ? buildMainChatConversationRoute(conversationId, navServerId)
      : buildMainChatRoute(navServerId),
    isRunning: resolved ? resolved.isRunning : false,
    needsYouCount: actionBarModel ? actionBarModel.counts.needsYou : 0,
    runningCount: actionBarModel ? actionBarModel.counts.inProgress : 0,
  };
}

function MainChatConversationScreenContent({
  conversationId,
  serverId,
}: MainChatConversationScreenProps): ReactElement {
  const { t } = useTranslation();
  const [activePane, setActivePane] = useState<"main" | "drawer">("main");
  const [editModalOpen, setEditModalOpen] = useState(false);

  const { resolved, rootMainAgentId, client, actionBarModel, isLoading, hasMultipleStewards } =
    useResolvedConversationData(conversationId, serverId ?? null);
  const effectiveServerId = resolved?.serverId ?? serverId ?? null;
  const navServerId =
    hasMultipleStewards || Boolean(serverId) ? (effectiveServerId ?? undefined) : undefined;
  const {
    mutating,
    updateConversation,
    handleToggleLeader,
    handleToggleArchive,
    handleConversationUpdated,
  } = useConversationMutations({ resolved, client, navServerId });

  const handleBackToMain = useCallback(
    () => router.push(buildMainChatRoute(navServerId)),
    [navServerId],
  );
  const handleOpenHistory = useCallback(
    () => router.push(buildMainChatHistoryRoute(navServerId)),
    [navServerId],
  );
  const handleFocusMainPane = useCallback(() => setActivePane("main"), []);
  const handleOpenEditModal = useCallback(() => setEditModalOpen(true), []);
  const handleCloseEditModal = useCallback(() => setEditModalOpen(false), []);

  const record = resolved ? resolved.record : null;
  const extraMenuItems = useMemo(() => {
    if (!record || record.kind === "main") return undefined;
    return (
      <ConversationExtraMenuItems
        record={record}
        disabled={mutating || !client}
        onToggleLeader={handleToggleLeader}
        onEdit={handleOpenEditModal}
        onToggleArchive={handleToggleArchive}
      />
    );
  }, [client, handleOpenEditModal, handleToggleArchive, handleToggleLeader, mutating, record]);

  const shellMeta = resolveShellHeaderMeta({
    conversationId,
    resolved,
    rootMainAgentId,
    actionBarModel,
    fallbackTitle: t("mainChat.shell.roleConversation"),
    navServerId,
  });

  return (
    <>
      <MainChatShell
        variant="conversation"
        title={shellMeta.title}
        serverId={shellMeta.serverId}
        routeServerId={navServerId}
        mainAgentId={shellMeta.mainAgentId}
        originRoute={shellMeta.originRoute}
        isRunning={shellMeta.isRunning}
        needsYouCount={shellMeta.needsYouCount}
        runningCount={shellMeta.runningCount}
        activePane={activePane}
        onActivePaneChange={setActivePane}
        extraMenuItems={extraMenuItems}
      >
        <ConversationScreenBody
          resolved={resolved}
          isLoading={isLoading}
          rootMainAgentId={rootMainAgentId}
          actionBarModel={actionBarModel}
          activePane={activePane}
          onFocusMainPane={handleFocusMainPane}
          onBackToMain={handleBackToMain}
          onOpenHistory={handleOpenHistory}
        />
      </MainChatShell>

      <EditConversationModal
        conversation={editModalOpen ? record : null}
        serverId={shellMeta.serverId}
        client={client}
        onUpdate={updateConversation}
        onUpdated={handleConversationUpdated}
        onClose={handleCloseEditModal}
      />
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  inactiveContainer: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  conversationColumn: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  hostContainer: {
    flex: 1,
    minHeight: 0,
    minWidth: 0,
  },
  contextBar: {
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    gap: theme.spacing[1],
  },
  contextHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  roleBadgesRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  summaryToggleButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
  },
  summaryToggleLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  summaryBox: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
  },
  summaryText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  actionBarOuter: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    gap: theme.spacing[1.5],
  },
  actionDrawer: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    maxHeight: 280,
    overflow: "hidden",
  },
  actionDrawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  actionDrawerTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  actionDrawerScroll: {
    maxHeight: 232,
  },
  actionDrawerContent: {
    padding: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  closeIconButton: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  capsuleStrip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  capsulePill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  capsulePillNeedsYou: {
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.statusWarningTint,
  },
  capsulePillSelected: {
    borderColor: theme.colors.primary,
  },
  capsulePillText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  capsulePillTextNeedsYou: {
    color: theme.colors.statusWarning,
  },
  trayRowCard: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  trayRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  trayRowBody: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  trayTaskRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  trayTaskMain: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: 2,
  },
  trayTaskActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  trayRowTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  trayRowHost: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  dotNeedsYou: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusWarning,
  },
  dotMuted: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  ringWrap: {
    width: 12,
    height: 12,
    alignItems: "center",
    justifyContent: "center",
  },
  controlPressed: {
    backgroundColor: theme.colors.surface2,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[3],
  },
  stateTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    textAlign: "center",
  },
  stateDescription: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    maxWidth: 420,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
}));
