import {
  agentScopeKey,
  type ActionBarNeedsYouItem,
  type ActionBarLiveAgentSnapshot,
} from "./action-bar-model";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type {
  MainChatConversationRecord,
  MainChatTaskRecord,
  MainChatTaskStatus,
} from "@getpaseo/protocol/main-chat";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Compass,
  Ellipsis,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useOpenKebabMenuVisibility } from "@/components/sidebar/use-open-kebab-menu-visibility";
import { StatusRing } from "@/components/status-ring";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Modal } from "@/components/ui/modal";
import { PressHighlight } from "@/components/ui/press-highlight";
import { EditingTextInput } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import type { Theme } from "@/styles/theme";
import {
  partitionActiveConversations,
  type CreateMainChatConversationInput,
  type UpdateMainChatConversationInput,
} from "./conversations-store";

const ThemedArchive = withUnistyles(Archive);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedCompass = withUnistyles(Compass);
const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedMessageSquare = withUnistyles(MessageSquare);
const ThemedPencil = withUnistyles(Pencil);
const ThemedPin = withUnistyles(Pin);
const ThemedPinOff = withUnistyles(PinOff);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const renameMenuIcon = <ThemedPencil size={14} uniProps={mutedIconMapping} />;
const promoteMenuIcon = <ThemedPin size={14} uniProps={primaryIconMapping} />;
const demoteMenuIcon = <ThemedPinOff size={14} uniProps={mutedIconMapping} />;
const archiveMenuIcon = <ThemedArchive size={14} uniProps={dangerIconMapping} />;

export const MAX_VISIBLE_RECENT_SIDES = 5;

export interface DirectionTreeFallbackEntry {
  conversationId: string;
  title: string;
  runningCount: number;
  needsYouCount: number;
}

export type DirectionAgentBucket = "needs_you" | "failed" | "running" | "done";
export type DirectionTaskBucket =
  | "failed"
  | "needs_you"
  | "running"
  | "awaiting_review"
  | "parked"
  | "done";

export interface DirectionAgentNode {
  agentId: string;
  serverId: string;
  workspaceId: string | null;
  title: string;
  hostLabel: string | null;
  isRemoteHost: boolean;
  bucket: DirectionAgentBucket;
}

export interface DirectionTaskNode {
  taskId: string;
  title: string;
  status: MainChatTaskStatus;
  bucket: DirectionTaskBucket;
  serverId: string;
  hostLabel: string | null;
  primaryAgentId: string | null;
  primaryWorkspaceId: string | null;
  agents: DirectionAgentNode[];
}

export interface DirectionLeaderNode {
  conversationId: string;
  agentId: string;
  title: string;
  directionSummary: string | null;
  runningCount: number;
  needsYouCount: number;
  tasks: DirectionTaskNode[];
  record: MainChatConversationRecord | null;
}

export interface DirectionSideNode {
  conversationId: string;
  agentId: string;
  title: string;
  directionSummary: string | null;
  record: MainChatConversationRecord;
}

export interface DirectionsTreeModel {
  leaders: DirectionLeaderNode[];
  sides: DirectionSideNode[];
}

export interface BuildDirectionsTreeInput {
  conversations: readonly MainChatConversationRecord[];
  tasks: readonly MainChatTaskRecord[];
  liveAgents: readonly ActionBarLiveAgentSnapshot[];
  requests: ReadonlyMap<string, readonly ActionBarNeedsYouItem[]>;
  hostLabelsByServerId: Readonly<Record<string, string>>;
  mainServerId: string | null;
  fallbackDirections?: readonly DirectionTreeFallbackEntry[];
}

function resolveAgentBucket(
  agent: ActionBarLiveAgentSnapshot | undefined,
  needsYou: boolean,
): DirectionAgentBucket {
  if (needsYou) return "needs_you";
  if (agent?.status === "error") return "failed";
  if (
    agent &&
    (agent.turnPhase === "open" || agent.status === "running" || agent.hasBackgroundWork)
  )
    return "running";
  return "done";
}

function resolveTaskBucket(
  status: MainChatTaskStatus,
  agents: readonly DirectionAgentNode[],
  needsYou: boolean,
): DirectionTaskBucket {
  if (needsYou || agents.some((agent) => agent.bucket === "needs_you")) return "needs_you";
  if (status === "failed" || agents.some((agent) => agent.bucket === "failed")) return "failed";
  if (status === "awaiting_review") return "awaiting_review";
  if (status === "parked") return "parked";
  if (status === "running" || status === "open" || agents.some((a) => a.bucket === "running")) {
    return "running";
  }
  return "done";
}

function collectTaskAgentIds(task: MainChatTaskRecord): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null | undefined) => {
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };
  for (const id of task.agentIds) push(id);
  push(task.activeAgentId);
  return ordered;
}

function buildTaskNode(
  task: MainChatTaskRecord,
  agentIndex: ReadonlyMap<string, ActionBarLiveAgentSnapshot>,
  requests: readonly ActionBarNeedsYouItem[],
  hostLabelsByServerId: Readonly<Record<string, string>>,
  mainServerId: string | null,
): DirectionTaskNode {
  const taskServerId = task.serverId ?? mainServerId ?? "";
  const agentIds = collectTaskAgentIds(task);
  const agents: DirectionAgentNode[] = agentIds.map((agentId) => {
    const live = agentIndex.get(agentScopeKey(taskServerId, agentId));
    const needsYou = requests.some(
      (item) =>
        item.serverId === taskServerId &&
        (item.agentId === agentId ||
          (item.kind === "permission" && item.permissions.some((p) => p.agentId === agentId))),
    );
    const agentServerId = live?.serverId ?? taskServerId;
    const hostLabel =
      (agentServerId ? hostLabelsByServerId[agentServerId] : undefined) ??
      task.hostLabel?.trim() ??
      null;
    const isRemoteHost = Boolean(agentServerId && mainServerId && agentServerId !== mainServerId);

    return {
      agentId,
      serverId: agentServerId,
      workspaceId: live?.workspaceId ?? task.workspaceId ?? null,
      title: live?.title?.trim() || agentId,
      hostLabel,
      isRemoteHost,
      bucket: resolveAgentBucket(live, needsYou),
    };
  });

  const primaryAgent =
    agents.find((agent) => agent.agentId === task.activeAgentId) ?? agents[0] ?? null;

  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    bucket: resolveTaskBucket(
      task.status,
      agents,
      requests.some((item) => item.taskId === task.id),
    ),
    serverId: primaryAgent?.serverId ?? taskServerId,
    hostLabel:
      task.hostLabel?.trim() || (taskServerId ? hostLabelsByServerId[taskServerId] : null) || null,
    primaryAgentId: primaryAgent?.agentId ?? task.activeAgentId ?? null,
    primaryWorkspaceId: primaryAgent?.workspaceId ?? task.workspaceId ?? null,
    agents,
  };
}

export function buildDirectionsTreeModel(input: BuildDirectionsTreeInput): DirectionsTreeModel {
  const { leaders: leaderRecords, sides: sideRecords } = partitionActiveConversations(
    input.conversations,
  );
  const agentIndex = new Map(
    input.liveAgents
      .filter((a) => !a.archived && !a.background)
      .map((a) => [agentScopeKey(a.serverId, a.agentId), a]),
  );

  const activeTasks = input.tasks.filter(
    (task) => task.status !== "completed" && task.status !== "cancelled",
  );

  const leaderIds = new Set<string>();
  const leaders: DirectionLeaderNode[] = leaderRecords.map((record) => {
    leaderIds.add(record.id);
    const groups = input.requests.get(record.id) ?? [];
    const requests = groups.flatMap((item) => [item, ...(item.relatedRequests ?? [])]);
    const ownedTasks = activeTasks
      .filter((task) => task.conversationId === record.id || task.mainAgentId === record.agentId)
      .map((task) =>
        buildTaskNode(task, agentIndex, requests, input.hostLabelsByServerId, input.mainServerId),
      );

    const runningCount = ownedTasks.filter((task) => task.bucket === "running").length;
    const needsYouCount = groups.length;

    return {
      conversationId: record.id,
      agentId: record.agentId,
      title: record.title,
      directionSummary: record.directionSummary,
      runningCount,
      needsYouCount,
      tasks: ownedTasks,
      record,
    };
  });

  if (input.fallbackDirections) {
    for (const entry of input.fallbackDirections) {
      if (leaderIds.has(entry.conversationId)) continue;
      leaders.push({
        conversationId: entry.conversationId,
        agentId: entry.conversationId,
        title: entry.title,
        directionSummary: null,
        runningCount: entry.runningCount,
        needsYouCount: entry.needsYouCount,
        tasks: [],
        record: null,
      });
    }
  }

  const sides: DirectionSideNode[] = sideRecords.map((record) => ({
    conversationId: record.id,
    agentId: record.agentId,
    title: record.title,
    directionSummary: record.directionSummary,
    record,
  }));

  return { leaders, sides };
}

function formatDirectionRowCounts(
  runningCount: number,
  needsYouCount: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  if (runningCount > 0 && needsYouCount > 0) {
    return t("mainChat.directions.countsRunningNeedsYou", {
      running: runningCount,
      needsYou: needsYouCount,
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

function StatusDot({ bucket }: { bucket: DirectionAgentBucket | DirectionTaskBucket }) {
  if (bucket === "running") {
    return (
      <View style={styles.ringSlot}>
        <StatusRing />
      </View>
    );
  }
  if (bucket === "needs_you") {
    return <View style={[styles.statusDot, styles.dotNeedsYou]} />;
  }
  if (bucket === "failed") {
    return <View style={[styles.statusDot, styles.dotDanger]} />;
  }
  return <View style={[styles.statusDot, styles.dotMuted]} />;
}

export interface OpenDirectionAgentTargetInput {
  conversationId: string;
  conversationTitle: string;
  serverId: string;
  agentId: string;
  workspaceId: string | null;
  title: string;
  taskId: string;
}

const DirectionAgentRow = memo(function DirectionAgentRow({
  agent,
  taskId,
  conversationId,
  conversationTitle,
  onOpenAgent,
}: {
  agent: DirectionAgentNode;
  taskId: string;
  conversationId: string;
  conversationTitle: string;
  onOpenAgent: (input: OpenDirectionAgentTargetInput) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePress = useCallback(() => {
    onOpenAgent({
      conversationId,
      conversationTitle,
      serverId: agent.serverId,
      agentId: agent.agentId,
      workspaceId: agent.workspaceId,
      title: agent.title,
      taskId,
    });
  }, [agent, conversationId, conversationTitle, onOpenAgent, taskId]);

  return (
    <View
      style={[styles.agentEnvelope, isHovered && styles.rowHighlighted]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <PressHighlight
        onPress={handlePress}
        style={styles.agentButton}
        highlightStyle={styles.rowPressed}
        accessibilityRole="button"
        accessibilityLabel={agent.title}
        testID={`sidebar-direction-agent-${agent.agentId}`}
      >
        <StatusDot bucket={agent.bucket} />
        <Text style={styles.agentTitle} numberOfLines={1}>
          {agent.title}
        </Text>
        {agent.hostLabel ? (
          <View
            style={[styles.hostBadge, agent.isRemoteHost && styles.hostBadgeRemote]}
            testID={`sidebar-direction-agent-host-${agent.agentId}`}
          >
            <Text
              style={[styles.hostBadgeText, agent.isRemoteHost && styles.hostBadgeTextRemote]}
              numberOfLines={1}
            >
              [{agent.hostLabel}]
            </Text>
          </View>
        ) : null}
      </PressHighlight>
    </View>
  );
});

const DirectionTaskBranch = memo(function DirectionTaskBranch({
  task,
  conversationId,
  conversationTitle,
  onOpenAgent,
}: {
  task: DirectionTaskNode;
  conversationId: string;
  conversationTitle: string;
  onOpenAgent: (input: OpenDirectionAgentTargetInput) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handlePressTask = useCallback(() => {
    if (!task.primaryAgentId) return;
    onOpenAgent({
      conversationId,
      conversationTitle,
      serverId: task.serverId,
      agentId: task.primaryAgentId,
      workspaceId: task.primaryWorkspaceId,
      title: task.title,
      taskId: task.taskId,
    });
  }, [conversationId, conversationTitle, onOpenAgent, task]);

  return (
    <View style={styles.taskBranch}>
      <View
        style={[styles.taskEnvelope, isHovered && styles.rowHighlighted]}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <PressHighlight
          onPress={handlePressTask}
          disabled={!task.primaryAgentId}
          style={styles.taskButton}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={task.title}
          testID={`sidebar-direction-task-${task.taskId}`}
        >
          <StatusDot bucket={task.bucket} />
          <Text style={styles.taskTitle} numberOfLines={1}>
            {task.title}
          </Text>
        </PressHighlight>
      </View>

      {task.agents.length > 0 ? (
        <View style={styles.agentList}>
          {task.agents.map((agent) => (
            <DirectionAgentRow
              key={`${task.taskId}:${agent.serverId}:${agent.agentId}`}
              agent={agent}
              taskId={task.taskId}
              conversationId={conversationId}
              conversationTitle={conversationTitle}
              onOpenAgent={onOpenAgent}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
});

const DirectionLeaderRow = memo(function DirectionLeaderRow({
  node,
  isSelected,
  isExpanded,
  isCompact,
  busyConversationId,
  onToggleExpand,
  onSelectConversation,
  onOpenAgent,
  onRequestRename,
  onDemote,
  onArchive,
}: {
  node: DirectionLeaderNode;
  isSelected: boolean;
  isExpanded: boolean;
  isCompact: boolean;
  busyConversationId: string | null;
  onToggleExpand: (conversationId: string) => void;
  onSelectConversation: (conversationId: string) => void;
  onOpenAgent: (input: OpenDirectionAgentTargetInput) => void;
  onRequestRename: (record: MainChatConversationRecord) => void;
  onDemote: (record: MainChatConversationRecord) => void;
  onArchive: (record: MainChatConversationRecord) => void;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const { showKebab, menuProps } = useOpenKebabMenuVisibility(isHovered || isNative || isCompact);

  const handleToggle = useCallback(() => {
    onToggleExpand(node.conversationId);
  }, [node.conversationId, onToggleExpand]);

  const handleOpen = useCallback(() => {
    onSelectConversation(node.conversationId);
  }, [node.conversationId, onSelectConversation]);

  const handleRename = useCallback(() => {
    if (node.record) onRequestRename(node.record);
  }, [node.record, onRequestRename]);

  const handleDemote = useCallback(() => {
    if (node.record) onDemote(node.record);
  }, [node.record, onDemote]);

  const handleArchive = useCallback(() => {
    if (node.record) onArchive(node.record);
  }, [node.record, onArchive]);

  const countsLabel = formatDirectionRowCounts(node.runningCount, node.needsYouCount, t);
  const isHighlighted = isHovered || isSelected;
  const isBusy = busyConversationId === node.conversationId;

  return (
    <View style={styles.leaderBlock}>
      <View
        style={[styles.rowEnvelope, isHighlighted && styles.rowHighlighted]}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={handlePointerLeave}
      >
        <View style={styles.leaderRowLayout}>
          <PressHighlight
            onPress={handleToggle}
            style={styles.chevronButton}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.directions.toggleDirectionTree")}
            testID={`sidebar-direction-toggle-${node.conversationId}`}
          >
            {isExpanded ? (
              <ThemedChevronDown size={12} uniProps={mutedIconMapping} />
            ) : (
              <ThemedChevronRight size={12} uniProps={mutedIconMapping} />
            )}
          </PressHighlight>

          <PressHighlight
            onPress={handleOpen}
            style={styles.leaderMainButton}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={node.title}
            testID={`sidebar-direction-row-${node.conversationId}`}
          >
            <ThemedCompass
              size={14}
              uniProps={isHighlighted ? primaryIconMapping : mutedIconMapping}
            />
            <Text
              style={[styles.rowTitle, isHighlighted && styles.rowTitleHighlighted]}
              numberOfLines={1}
            >
              {node.title}
            </Text>
            {countsLabel ? (
              <Text
                style={[styles.rowCounts, node.needsYouCount > 0 && styles.rowCountsAttention]}
                numberOfLines={1}
                testID={`sidebar-direction-counts-${node.conversationId}`}
              >
                {countsLabel}
              </Text>
            ) : null}
          </PressHighlight>

          {node.record ? (
            <View
              style={[styles.kebabSlot, !showKebab && styles.kebabHidden]}
              pointerEvents={showKebab ? "auto" : "none"}
            >
              <DropdownMenu compactMode="sheet" {...menuProps}>
                <DropdownMenuTrigger
                  hitSlop={4}
                  style={styles.kebabTrigger}
                  accessibilityRole="button"
                  accessibilityLabel={t("mainChat.directions.rowMenuLabel")}
                  testID={`sidebar-direction-menu-${node.conversationId}`}
                >
                  <ThemedEllipsis size={13} uniProps={mutedIconMapping} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" width={220} sheetTitle={node.title}>
                  <DropdownMenuItem
                    leading={renameMenuIcon}
                    onSelect={handleRename}
                    disabled={isBusy}
                    testID={`sidebar-direction-menu-rename-${node.conversationId}`}
                  >
                    {t("mainChat.directions.actions.rename")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    leading={demoteMenuIcon}
                    onSelect={handleDemote}
                    disabled={isBusy}
                    testID={`sidebar-direction-menu-demote-${node.conversationId}`}
                  >
                    {t("mainChat.directions.actions.demoteToSide")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    leading={archiveMenuIcon}
                    onSelect={handleArchive}
                    disabled={isBusy}
                    testID={`sidebar-direction-menu-archive-${node.conversationId}`}
                  >
                    {t("mainChat.directions.actions.archive")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </View>
          ) : null}
        </View>
      </View>

      {isExpanded ? (
        <View style={styles.treeChildren} testID={`sidebar-direction-tree-${node.conversationId}`}>
          {node.tasks.length > 0 ? (
            node.tasks.map((task) => (
              <DirectionTaskBranch
                key={task.taskId}
                task={task}
                conversationId={node.conversationId}
                conversationTitle={node.title}
                onOpenAgent={onOpenAgent}
              />
            ))
          ) : (
            <Text style={styles.treeEmptyHint} numberOfLines={1}>
              {t("mainChat.directions.noActiveTasks")}
            </Text>
          )}
        </View>
      ) : null}
    </View>
  );
});

const SideConversationRow = memo(function SideConversationRow({
  node,
  isSelected,
  isCompact,
  busyConversationId,
  onSelectConversation,
  onPromote,
  onRequestRename,
  onArchive,
}: {
  node: DirectionSideNode;
  isSelected: boolean;
  isCompact: boolean;
  busyConversationId: string | null;
  onSelectConversation: (conversationId: string) => void;
  onPromote: (record: MainChatConversationRecord) => void;
  onRequestRename: (record: MainChatConversationRecord) => void;
  onArchive: (record: MainChatConversationRecord) => void;
}) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);

  const { showKebab, menuProps } = useOpenKebabMenuVisibility(isHovered || isNative || isCompact);

  const handleOpen = useCallback(() => {
    onSelectConversation(node.conversationId);
  }, [node.conversationId, onSelectConversation]);

  const handlePromote = useCallback(() => {
    onPromote(node.record);
  }, [node.record, onPromote]);

  const handleRename = useCallback(() => {
    onRequestRename(node.record);
  }, [node.record, onRequestRename]);

  const handleArchive = useCallback(() => {
    onArchive(node.record);
  }, [node.record, onArchive]);

  const isHighlighted = isHovered || isSelected;
  const isBusy = busyConversationId === node.conversationId;

  return (
    <View
      style={[styles.rowEnvelope, isHighlighted && styles.rowHighlighted]}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
    >
      <View style={styles.sideRowLayout}>
        <PressHighlight
          onPress={handleOpen}
          style={styles.sideMainButton}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={node.title}
          testID={`sidebar-side-row-${node.conversationId}`}
        >
          <ThemedMessageSquare
            size={13}
            uniProps={isHighlighted ? foregroundIconMapping : mutedIconMapping}
          />
          <Text
            style={[styles.rowTitle, isHighlighted && styles.rowTitleHighlighted]}
            numberOfLines={1}
          >
            {node.title}
          </Text>
        </PressHighlight>

        <View
          style={[styles.kebabSlot, !showKebab && styles.kebabHidden]}
          pointerEvents={showKebab ? "auto" : "none"}
        >
          <DropdownMenu compactMode="sheet" {...menuProps}>
            <DropdownMenuTrigger
              hitSlop={4}
              style={styles.kebabTrigger}
              accessibilityRole="button"
              accessibilityLabel={t("mainChat.directions.rowMenuLabel")}
              testID={`sidebar-side-menu-${node.conversationId}`}
            >
              <ThemedEllipsis size={13} uniProps={mutedIconMapping} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" width={220} sheetTitle={node.title}>
              <DropdownMenuItem
                leading={promoteMenuIcon}
                onSelect={handlePromote}
                disabled={isBusy}
                testID={`sidebar-side-menu-promote-${node.conversationId}`}
              >
                {t("mainChat.directions.actions.promoteToLeader")}
              </DropdownMenuItem>
              <DropdownMenuItem
                leading={renameMenuIcon}
                onSelect={handleRename}
                disabled={isBusy}
                testID={`sidebar-side-menu-rename-${node.conversationId}`}
              >
                {t("mainChat.directions.actions.rename")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                leading={archiveMenuIcon}
                onSelect={handleArchive}
                disabled={isBusy}
                testID={`sidebar-side-menu-archive-${node.conversationId}`}
              >
                {t("mainChat.directions.actions.archive")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </View>
      </View>
    </View>
  );
});

export interface DirectionsTreeProps {
  model: DirectionsTreeModel;
  activeConversationId: string | null;
  expandedDirectionIds: Readonly<Record<string, boolean>>;
  recentSideCollapsed: boolean;
  busyConversationId: string | null;
  onToggleDirectionExpanded: (conversationId: string) => void;
  onToggleRecentSideCollapsed: () => void;
  onSelectConversation: (conversationId: string) => void;
  onOpenAgent: (input: OpenDirectionAgentTargetInput) => void;
  onOpenHistory: () => void;
  onPromote: (record: MainChatConversationRecord) => void;
  onDemote: (record: MainChatConversationRecord) => void;
  onRequestRename: (record: MainChatConversationRecord) => void;
  onArchive: (record: MainChatConversationRecord) => void;
}

export const DirectionsTree = memo(function DirectionsTree({
  model,
  activeConversationId,
  expandedDirectionIds,
  recentSideCollapsed,
  busyConversationId,
  onToggleDirectionExpanded,
  onToggleRecentSideCollapsed,
  onSelectConversation,
  onOpenAgent,
  onOpenHistory,
  onPromote,
  onDemote,
  onRequestRename,
  onArchive,
}: DirectionsTreeProps): ReactElement {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const [showAllSides, setShowAllSides] = useState(false);

  const visibleSides = useMemo(
    () => (showAllSides ? model.sides : model.sides.slice(0, MAX_VISIBLE_RECENT_SIDES)),
    [model.sides, showAllSides],
  );
  const hasOverflowSides = model.sides.length > MAX_VISIBLE_RECENT_SIDES;

  const handleToggleShowAllSides = useCallback(() => {
    setShowAllSides((prev) => !prev);
  }, []);

  return (
    <View style={styles.treeRoot} testID="sidebar-directions-tree">
      {model.leaders.length > 0 ? (
        <View style={styles.groupBlock} testID="sidebar-directions-leaders-group">
          <Text style={styles.groupHeading}>{t("mainChat.directions.leadersGroupTitle")}</Text>
          {model.leaders.map((node) => (
            <DirectionLeaderRow
              key={node.conversationId}
              node={node}
              isSelected={activeConversationId === node.conversationId}
              isExpanded={Boolean(expandedDirectionIds[node.conversationId])}
              isCompact={isCompact}
              busyConversationId={busyConversationId}
              onToggleExpand={onToggleDirectionExpanded}
              onSelectConversation={onSelectConversation}
              onOpenAgent={onOpenAgent}
              onRequestRename={onRequestRename}
              onDemote={onDemote}
              onArchive={onArchive}
            />
          ))}
        </View>
      ) : null}

      {model.sides.length > 0 ? (
        <View style={styles.groupBlock} testID="sidebar-directions-sides-group">
          <PressHighlight
            onPress={onToggleRecentSideCollapsed}
            style={styles.groupToggleHeader}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            testID="sidebar-directions-sides-toggle"
          >
            {recentSideCollapsed ? (
              <ThemedChevronRight size={11} uniProps={mutedIconMapping} />
            ) : (
              <ThemedChevronDown size={11} uniProps={mutedIconMapping} />
            )}
            <Text style={styles.groupHeading}>
              {t("mainChat.directions.recentSidesGroupTitle")}
            </Text>
          </PressHighlight>

          {recentSideCollapsed ? null : (
            <View style={styles.sidesList}>
              {visibleSides.map((node) => (
                <SideConversationRow
                  key={node.conversationId}
                  node={node}
                  isSelected={activeConversationId === node.conversationId}
                  isCompact={isCompact}
                  busyConversationId={busyConversationId}
                  onSelectConversation={onSelectConversation}
                  onPromote={onPromote}
                  onRequestRename={onRequestRename}
                  onArchive={onArchive}
                />
              ))}

              {hasOverflowSides ? (
                <View style={styles.overflowActionsRow}>
                  <PressHighlight
                    onPress={handleToggleShowAllSides}
                    style={styles.overflowButton}
                    highlightStyle={styles.rowPressed}
                    accessibilityRole="button"
                    testID="sidebar-directions-sides-show-all"
                  >
                    <Text style={styles.overflowButtonText}>
                      {showAllSides
                        ? t("mainChat.directions.showFewerSides")
                        : t("mainChat.directions.showAllSides", { count: model.sides.length })}
                    </Text>
                  </PressHighlight>
                  <PressHighlight
                    onPress={onOpenHistory}
                    style={styles.overflowButton}
                    highlightStyle={styles.rowPressed}
                    accessibilityRole="button"
                    testID="sidebar-directions-sides-view-history"
                  >
                    <Text style={styles.overflowButtonText}>
                      {t("mainChat.directions.viewAllInHistory")}
                    </Text>
                  </PressHighlight>
                </View>
              ) : null}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
});

const KindOptionCard = memo(function KindOptionCard({
  selected,
  iconKind,
  title,
  hint,
  testID,
  onPress,
}: {
  selected: boolean;
  iconKind: "side" | "leader";
  title: string;
  hint: string;
  testID: string;
  onPress: () => void;
}) {
  const iconMapping = selected ? primaryIconMapping : mutedIconMapping;
  return (
    <PressHighlight
      onPress={onPress}
      style={[styles.kindOption, selected && styles.kindOptionActive]}
      highlightStyle={styles.rowPressed}
      accessibilityRole="button"
      testID={testID}
    >
      <View style={styles.kindOptionHeader}>
        {iconKind === "leader" ? (
          <ThemedCompass size={13} uniProps={iconMapping} />
        ) : (
          <ThemedMessageSquare size={13} uniProps={iconMapping} />
        )}
        <Text style={[styles.kindOptionTitle, selected && styles.kindOptionTitleActive]}>
          {title}
        </Text>
      </View>
      <Text style={styles.kindOptionHint} numberOfLines={2}>
        {hint}
      </Text>
    </PressHighlight>
  );
});

export interface CreateConversationModalProps {
  visible: boolean;
  serverId: string | null;
  client: DaemonClient | null;
  defaultKind?: "side" | "leader";
  onCreate: (
    serverId: string,
    input: CreateMainChatConversationInput,
    client: DaemonClient,
  ) => Promise<MainChatConversationRecord>;
  onCreated: (conversation: MainChatConversationRecord) => void;
  onClose: () => void;
}

export const CreateConversationModal = memo(function CreateConversationModal({
  visible,
  serverId,
  client,
  defaultKind = "side",
  onCreate,
  onCreated,
  onClose,
}: CreateConversationModalProps): ReactElement | null {
  const { t } = useTranslation();
  const [kind, setKind] = useState<"side" | "leader">(defaultKind);
  const [title, setTitle] = useState("");
  const [directionSummary, setDirectionSummary] = useState("");
  const [initialPrompt, setInitialPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setKind(defaultKind);
    setTitle("");
    setDirectionSummary("");
    setInitialPrompt("");
    setSubmitting(false);
    setErrorMessage(null);
  }, [defaultKind, visible]);

  const selectSide = useCallback(() => setKind("side"), []);
  const selectLeader = useCallback(() => setKind("leader"), []);

  const handleSubmit = useCallback(() => {
    if (submitting) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setErrorMessage(t("mainChat.directions.createModal.titleRequired"));
      return;
    }
    if (!serverId || !client) {
      setErrorMessage(t("mainChat.directions.createModal.createFailed"));
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);

    const trimmedSummary = directionSummary.trim();
    const trimmedPrompt = initialPrompt.trim();

    void onCreate(
      serverId,
      {
        kind,
        title: trimmedTitle,
        ...(trimmedSummary ? { directionSummary: trimmedSummary } : {}),
        ...(trimmedPrompt ? { initialPrompt: trimmedPrompt } : {}),
      },
      client,
    )
      .then((created) => {
        onCreated(created);
        return created;
      })
      .catch((error) => {
        setErrorMessage(
          error instanceof Error
            ? error.message
            : t("mainChat.directions.createModal.createFailed"),
        );
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [
    client,
    directionSummary,
    initialPrompt,
    kind,
    onCreate,
    onCreated,
    serverId,
    submitting,
    t,
    title,
  ]);

  if (!visible) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop} testID="main-chat-create-conversation-modal">
        <PressHighlight
          style={styles.modalDismiss}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("common.actions.cancel")}
        />
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{t("mainChat.directions.createModal.title")}</Text>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>{t("mainChat.directions.createModal.kindLabel")}</Text>
            <View style={styles.kindOptionsRow}>
              <KindOptionCard
                selected={kind === "side"}
                iconKind="side"
                title={t("mainChat.directions.createModal.kindSide")}
                hint={t("mainChat.directions.createModal.kindSideHint")}
                testID="main-chat-create-conv-kind-side"
                onPress={selectSide}
              />
              <KindOptionCard
                selected={kind === "leader"}
                iconKind="leader"
                title={t("mainChat.directions.createModal.kindLeader")}
                hint={t("mainChat.directions.createModal.kindLeaderHint")}
                testID="main-chat-create-conv-kind-leader"
                onPress={selectLeader}
              />
            </View>
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>{t("mainChat.directions.createModal.titleLabel")}</Text>
            <EditingTextInput
              initialValue={title}
              onChangeText={setTitle}
              style={styles.textInput}
              placeholder={t("mainChat.directions.createModal.titlePlaceholder")}
              testID="main-chat-create-conv-title"
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>
              {t("mainChat.directions.createModal.summaryLabel")}
            </Text>
            <EditingTextInput
              initialValue={directionSummary}
              onChangeText={setDirectionSummary}
              style={[styles.textInput, styles.multilineInput]}
              multiline
              placeholder={t("mainChat.directions.createModal.summaryPlaceholder")}
              testID="main-chat-create-conv-summary"
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>
              {t("mainChat.directions.createModal.initialPromptLabel")}
            </Text>
            <EditingTextInput
              initialValue={initialPrompt}
              onChangeText={setInitialPrompt}
              style={[styles.textInput, styles.multilineInput]}
              multiline
              placeholder={t("mainChat.directions.createModal.initialPromptPlaceholder")}
              testID="main-chat-create-conv-prompt"
            />
          </View>

          {errorMessage ? (
            <Text style={styles.errorText} testID="main-chat-create-conv-error">
              {errorMessage}
            </Text>
          ) : null}

          <View style={styles.modalActions}>
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onPress={onClose}
              testID="main-chat-create-conv-cancel"
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="default"
              size="sm"
              loading={submitting}
              disabled={submitting}
              onPress={handleSubmit}
              testID="main-chat-create-conv-submit"
            >
              {t("mainChat.directions.createModal.submitButton")}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
});

export interface EditConversationModalProps {
  conversation: MainChatConversationRecord | null;
  serverId: string | null;
  client: DaemonClient | null;
  onUpdate: (
    serverId: string,
    input: UpdateMainChatConversationInput,
    client: DaemonClient,
  ) => Promise<MainChatConversationRecord>;
  onUpdated?: (conversation: MainChatConversationRecord) => void;
  onClose: () => void;
}

export const EditConversationModal = memo(function EditConversationModal({
  conversation,
  serverId,
  client,
  onUpdate,
  onUpdated,
  onClose,
}: EditConversationModalProps): ReactElement | null {
  const { t } = useTranslation();
  const [title, setTitle] = useState(conversation?.title ?? "");
  const [directionSummary, setDirectionSummary] = useState(conversation?.directionSummary ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!conversation) return;
    setTitle(conversation.title);
    setDirectionSummary(conversation.directionSummary ?? "");
    setSubmitting(false);
    setErrorMessage(null);
  }, [conversation]);

  const handleSave = useCallback(() => {
    if (!conversation || submitting) return;
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setErrorMessage(t("mainChat.directions.editModal.titleRequired"));
      return;
    }
    if (!serverId || !client) {
      setErrorMessage(t("mainChat.directions.editModal.saveFailed"));
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    const trimmedSummary = directionSummary.trim();

    void onUpdate(
      serverId,
      {
        conversationId: conversation.id,
        title: trimmedTitle,
        directionSummary: trimmedSummary.length > 0 ? trimmedSummary : null,
      },
      client,
    )
      .then((updated) => {
        onUpdated?.(updated);
        onClose();
        return updated;
      })
      .catch((error) => {
        setErrorMessage(
          error instanceof Error ? error.message : t("mainChat.directions.editModal.saveFailed"),
        );
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [
    client,
    conversation,
    directionSummary,
    onClose,
    onUpdate,
    onUpdated,
    serverId,
    submitting,
    t,
    title,
  ]);

  if (!conversation) return null;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.modalBackdrop} testID="main-chat-edit-conversation-modal">
        <PressHighlight
          style={styles.modalDismiss}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={t("common.actions.cancel")}
        />
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>{t("mainChat.directions.editModal.title")}</Text>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>{t("mainChat.directions.editModal.titleLabel")}</Text>
            <EditingTextInput
              key={`edit-title-${conversation.id}`}
              initialValue={title}
              onChangeText={setTitle}
              style={styles.textInput}
              placeholder={t("mainChat.directions.editModal.titlePlaceholder")}
              testID="main-chat-edit-conv-title"
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>{t("mainChat.directions.editModal.summaryLabel")}</Text>
            <EditingTextInput
              key={`edit-summary-${conversation.id}`}
              initialValue={directionSummary}
              onChangeText={setDirectionSummary}
              style={[styles.textInput, styles.multilineInput]}
              multiline
              placeholder={t("mainChat.directions.editModal.summaryPlaceholder")}
              testID="main-chat-edit-conv-summary"
            />
          </View>

          {errorMessage ? (
            <Text style={styles.errorText} testID="main-chat-edit-conv-error">
              {errorMessage}
            </Text>
          ) : null}

          <View style={styles.modalActions}>
            <Button
              variant="ghost"
              size="sm"
              disabled={submitting}
              onPress={onClose}
              testID="main-chat-edit-conv-cancel"
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              variant="default"
              size="sm"
              loading={submitting}
              disabled={submitting}
              onPress={handleSave}
              testID="main-chat-edit-conv-submit"
            >
              {t("mainChat.directions.editModal.saveButton")}
            </Button>
          </View>
        </View>
      </View>
    </Modal>
  );
});

const styles = StyleSheet.create((theme) => ({
  treeRoot: {
    gap: theme.spacing[1.5],
  },
  groupBlock: {
    gap: 2,
  },
  groupHeading: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundExtraMuted,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  groupToggleHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
  },
  leaderBlock: {
    gap: 2,
  },
  rowEnvelope: {
    position: "relative",
    minHeight: 30,
    borderRadius: theme.borderRadius.md,
  },
  rowHighlighted: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  leaderRowLayout: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
  },
  chevronButton: {
    width: 22,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    flexShrink: 0,
  },
  leaderMainButton: {
    flex: 1,
    minWidth: 0,
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  sideRowLayout: {
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
  },
  sideMainButton: {
    flex: 1,
    minWidth: 0,
    minHeight: 30,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
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
  rowCountsAttention: {
    color: theme.colors.statusWarning,
    fontWeight: theme.fontWeight.medium,
  },
  kebabSlot: {
    width: 24,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  kebabHidden: {
    opacity: 0,
  },
  kebabTrigger: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  treeChildren: {
    paddingLeft: theme.spacing[4],
    gap: 2,
  },
  treeEmptyHint: {
    paddingLeft: theme.spacing[2],
    paddingVertical: 3,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
  taskBranch: {
    gap: 1,
  },
  taskEnvelope: {
    position: "relative",
    minHeight: 26,
    borderRadius: theme.borderRadius.sm,
  },
  taskButton: {
    minHeight: 26,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.sm,
  },
  taskTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  agentList: {
    paddingLeft: theme.spacing[3],
    gap: 1,
  },
  agentEnvelope: {
    position: "relative",
    minHeight: 24,
    borderRadius: theme.borderRadius.sm,
  },
  agentButton: {
    minHeight: 24,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: 2,
    borderRadius: theme.borderRadius.sm,
  },
  agentTitle: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  hostBadge: {
    paddingHorizontal: theme.spacing[1],
    paddingVertical: 1,
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    flexShrink: 0,
  },
  hostBadgeRemote: {
    backgroundColor: theme.colors.surface3,
  },
  hostBadgeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  hostBadgeTextRemote: {
    color: theme.colors.primary,
    fontWeight: theme.fontWeight.medium,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    flexShrink: 0,
  },
  dotNeedsYou: {
    backgroundColor: theme.colors.statusWarning,
  },
  dotDanger: {
    backgroundColor: theme.colors.statusDanger,
  },
  dotMuted: {
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  ringSlot: {
    width: 10,
    height: 10,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  sidesList: {
    gap: 2,
  },
  overflowActionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingTop: 2,
  },
  overflowButton: {
    paddingVertical: 2,
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
  },
  overflowButtonText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
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
    maxWidth: 440,
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
  fieldGroup: {
    gap: theme.spacing[1],
  },
  fieldLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  kindOptionsRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  kindOption: {
    flex: 1,
    padding: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    gap: theme.spacing[1],
  },
  kindOptionActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface2,
  },
  kindOptionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  kindOptionTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  kindOptionTitleActive: {
    color: theme.colors.foreground,
  },
  kindOptionHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
    lineHeight: 16,
  },
  textInput: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  multilineInput: {
    minHeight: 64,
    textAlignVertical: "top",
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
  modalActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[1],
  },
}));
