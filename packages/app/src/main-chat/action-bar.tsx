import { getParentAddressFromLabels } from "@getpaseo/protocol/agent-labels";
import { isAgentRunning } from "@getpaseo/protocol/agent-state-bucket";
import {
  MAIN_CHAT_TASK_RECORD_ID_LABEL,
  getMainChatTaskMetaFromLabels,
  isMainChatAgent,
} from "@getpaseo/protocol/main-chat";
import { router } from "expo-router";
import equal from "fast-deep-equal";
import {
  ArrowUpRight,
  AtSign,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  CornerDownRight,
  Lock,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  RefreshCw,
  RotateCcw,
  X,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { create } from "zustand";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { PermissionRequestCard } from "@/agent-stream/view";
import { CHAT_COLUMN_RAIL_DATASET } from "@/chat-rail";
import { StatusRing } from "@/components/status-ring";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { EditingTextInput } from "@/components/ui/text-input";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import { buildSettingsSectionRoute } from "@/utils/host-routes";
import {
  buildMainChatActionBarModel,
  selectCompactDockEntries,
  type ActionBarBucketKey,
  type ActionBarLiveAgentSnapshot,
  type ActionBarNeedsYouItem,
  type ActionBarPendingPermissionInput,
  type ActionBarTaskItem,
  type CompactDockEntry,
} from "./action-bar-model";
import { ChildPermissionWrapper } from "./child-permission-wrapper";
import { MainChatDecisionCard } from "./decision-card";
import { useIsCompactMainChatLayout, useOpenMainChatTaskTarget } from "./open-task-target";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { MainChatPlanCard } from "./plan-card";
import { useMainChatRouteStore } from "./route-store";
import { deriveDeliveryGateBadge } from "./task-dag-ui";
import { useStewardAllowedServerIds } from "./use-steward-roster";
import { deriveZeroTokenDiagnosticBadge } from "./zero-token-diagnostic-ui";

const ThemedArrowIcon = withUnistyles(ArrowUpRight);
const ThemedAtIcon = withUnistyles(AtSign);
const ThemedBookIcon = withUnistyles(BookOpen);
const ThemedCheckIcon = withUnistyles(CheckCircle2);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedChevronUp = withUnistyles(ChevronUp);
const ThemedClockIcon = withUnistyles(Clock);
const ThemedCornerDownRight = withUnistyles(CornerDownRight);
const ThemedLockIcon = withUnistyles(Lock);
const ThemedMaximizeIcon = withUnistyles(Maximize2);
const ThemedMinimizeIcon = withUnistyles(Minimize2);
const ThemedPauseIcon = withUnistyles(Pause);
const ThemedPlayIcon = withUnistyles(Play);
const ThemedRefreshIcon = withUnistyles(RefreshCw);
const ThemedReworkIcon = withUnistyles(RotateCcw);
const ThemedXIcon = withUnistyles(X);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const invertedIconMapping = (theme: Theme) => ({ color: theme.colors.surface0 });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

interface ActionBarSessionSnapshot {
  isMainChat: boolean;
  liveAgents: ActionBarLiveAgentSnapshot[];
  pendingPermissions: ActionBarPendingPermissionInput[];
}

type HostSessionEntry = SessionStoreState["sessions"][string];
type SessionAgentEntry = ReturnType<HostSessionEntry["agents"]["get"]> & object;

function extractTaskRecordId(labels: Record<string, string | undefined>): string | null {
  const rawRecordId = labels[MAIN_CHAT_TASK_RECORD_ID_LABEL];
  return typeof rawRecordId === "string" && rawRecordId.trim().length > 0
    ? rawRecordId.trim()
    : null;
}

function buildLiveAgentSnapshot(
  hostId: string,
  agent: SessionAgentEntry,
  serverId: string,
  mainAgentId: string,
): ActionBarLiveAgentSnapshot {
  const parent = getParentAddressFromLabels(agent.labels, hostId);
  const managedByMainChat = parent?.serverId === serverId && parent.agentId === mainAgentId;
  const meta = getMainChatTaskMetaFromLabels(agent.labels);
  const running = isAgentRunning({
    status: agent.status,
    backgroundWork: agent.backgroundWork,
  });
  const effectiveStatus = running && agent.status !== "error" ? "running" : agent.status;
  const trimmedTitle = agent.title?.trim();

  return {
    serverId: hostId,
    agentId: agent.id,
    workspaceId: agent.workspaceId ?? null,
    title: trimmedTitle || meta?.goal || agent.id,
    cwd: agent.cwd || null,
    status: effectiveStatus,
    turnPhase: agent.turn.phase === "open" ? "open" : "idle",
    hasBackgroundWork: (agent.backgroundWork?.count ?? 0) > 0,
    requiresAttention: Boolean(agent.requiresAttention),
    attentionReason: agent.attentionReason ?? null,
    archived: Boolean(agent.archivedAt),
    background: Boolean(agent.background),
    isMainChat: isMainChatAgent(agent),
    managedByMainChat,
    mode: meta?.mode ?? null,
    taskRecordId: extractTaskRecordId(agent.labels),
    planId: meta?.planId ?? null,
    updatedAtMs: agent.updatedAt.getTime(),
    lastActivityAtMs: (agent.lastActivityAt ?? agent.updatedAt).getTime(),
  };
}

function collectHostPendingPermissions(
  hostId: string,
  hostSession: HostSessionEntry,
  mainAgentId: string,
  target: ActionBarPendingPermissionInput[],
): void {
  for (const perm of hostSession.pendingPermissions.values()) {
    const sourceAgent =
      hostSession.agents.get(perm.agentId) ?? hostSession.agentDetails.get(perm.agentId);
    const isHiddenNonMain =
      Boolean(sourceAgent && (sourceAgent.archivedAt || sourceAgent.background)) &&
      perm.agentId !== mainAgentId;
    if (isHiddenNonMain) continue;
    if (sourceAgent && isMainChatAgent(sourceAgent) && perm.agentId !== mainAgentId) {
      continue;
    }
    target.push({
      serverId: hostId,
      permission: perm,
      sourceAgentTitle: sourceAgent?.title?.trim() || perm.agentId,
      sourceAgentCwd: sourceAgent?.cwd ?? null,
    });
  }
}

function selectActionBarSessionSnapshot(
  state: SessionStoreState,
  serverId: string,
  mainAgentId: string,
  allowedServerIds?: ReadonlySet<string> | null,
): ActionBarSessionSnapshot {
  const mainSession = state.sessions[serverId];
  const currentAgent =
    mainSession?.agents.get(mainAgentId) ?? mainSession?.agentDetails.get(mainAgentId);
  if (!isMainChatAgent(currentAgent)) {
    return { isMainChat: false, liveAgents: [], pendingPermissions: [] };
  }

  const liveAgents: ActionBarLiveAgentSnapshot[] = [];
  const pendingPermissions: ActionBarPendingPermissionInput[] = [];

  for (const [hostId, hostSession] of Object.entries(state.sessions)) {
    if (allowedServerIds && allowedServerIds.size > 0 && !allowedServerIds.has(hostId)) {
      continue;
    }
    for (const agent of hostSession.agents.values()) {
      liveAgents.push(buildLiveAgentSnapshot(hostId, agent, serverId, mainAgentId));
    }
    collectHostPendingPermissions(hostId, hostSession, mainAgentId, pendingPermissions);
  }

  return { isMainChat: true, liveAgents, pendingPermissions };
}

export interface MainChatActionBarProps {
  serverId: string;
  agentId: string;
  /**
   * `"external"` renders only the fixed-height capsule strip while the pane mounts
   * `<MainChatActionBarDrawerOverlay />` over the transcript stream (zero layout shift).
   * `"floating"` (default) renders the drawer in an absolute floating layer above the strip.
   */
  drawerMode?: "floating" | "external";
}

interface MainChatActionBarDrawerStoreState {
  openBucketByKey: Record<string, ActionBarBucketKey | null>;
  expandedByKey: Record<string, boolean>;
  compactDockCollapsedByKey: Record<string, boolean>;
  focusedNeedsIdByKey: Record<string, string | null>;
  toggleBucket: (key: string, bucket: ActionBarBucketKey) => void;
  openBucketWithFocus: (
    key: string,
    bucket: ActionBarBucketKey,
    focusNeedsId?: string | null,
  ) => void;
  consumeFocusedNeedsId: (key: string) => void;
  setCompactDockCollapsed: (key: string, collapsed: boolean) => void;
  closeDrawer: (key: string) => void;
  toggleExpanded: (key: string) => void;
  reset: () => void;
}

export const useMainChatActionBarDrawerStore = create<MainChatActionBarDrawerStoreState>((set) => ({
  openBucketByKey: {},
  expandedByKey: {},
  compactDockCollapsedByKey: {},
  focusedNeedsIdByKey: {},
  toggleBucket(key, bucket) {
    set((state) => {
      const current = state.openBucketByKey[key] ?? null;
      const next = current === bucket ? null : bucket;
      return {
        openBucketByKey: { ...state.openBucketByKey, [key]: next },
        focusedNeedsIdByKey: { ...state.focusedNeedsIdByKey, [key]: null },
        ...(next === null ? { expandedByKey: { ...state.expandedByKey, [key]: false } } : {}),
      };
    });
  },
  openBucketWithFocus(key, bucket, focusNeedsId = null) {
    set((state) => ({
      openBucketByKey: { ...state.openBucketByKey, [key]: bucket },
      focusedNeedsIdByKey: { ...state.focusedNeedsIdByKey, [key]: focusNeedsId },
    }));
  },
  consumeFocusedNeedsId(key) {
    set((state) => {
      if (!state.focusedNeedsIdByKey?.[key]) return state;
      return {
        focusedNeedsIdByKey: { ...state.focusedNeedsIdByKey, [key]: null },
      };
    });
  },
  setCompactDockCollapsed(key, collapsed) {
    set((state) => ({
      compactDockCollapsedByKey: { ...state.compactDockCollapsedByKey, [key]: collapsed },
    }));
  },
  closeDrawer(key) {
    set((state) => {
      if (
        (state.openBucketByKey[key] ?? null) === null &&
        !state.expandedByKey[key] &&
        !state.focusedNeedsIdByKey?.[key]
      ) {
        return state;
      }
      return {
        openBucketByKey: { ...state.openBucketByKey, [key]: null },
        expandedByKey: { ...state.expandedByKey, [key]: false },
        focusedNeedsIdByKey: { ...state.focusedNeedsIdByKey, [key]: null },
      };
    });
  },
  toggleExpanded(key) {
    set((state) => ({
      expandedByKey: { ...state.expandedByKey, [key]: !state.expandedByKey[key] },
    }));
  },
  reset() {
    set({
      openBucketByKey: {},
      expandedByKey: {},
      compactDockCollapsedByKey: {},
      focusedNeedsIdByKey: {},
    });
  },
}));

const SELECTED_ACCESSIBILITY_STATE = { selected: true } as const;
const UNSELECTED_ACCESSIBILITY_STATE = { selected: false } as const;

const CapsuleButton = memo(function CapsuleButton({
  bucket,
  count,
  selected,
  isRunning,
  onPress,
}: {
  bucket: ActionBarBucketKey;
  count: number;
  selected: boolean;
  isRunning?: boolean;
  onPress: (bucket: ActionBarBucketKey) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(bucket), [bucket, onPress]);

  let label: string;
  let leading: ReactElement;
  switch (bucket) {
    case "needsYou":
      label = t("mainChat.actionBar.capsuleNeedsYou", { count });
      leading = <View style={styles.dotNeedsYou} />;
      break;
    case "inProgress":
      label = t("mainChat.actionBar.capsuleInProgress", { count });
      leading = isRunning ? <View style={styles.dotRunning} /> : <View style={styles.dotMuted} />;
      break;
    case "awaitingReview":
      label = t("mainChat.actionBar.capsuleAwaitingReview", { count });
      leading = <View style={selected ? styles.dotInvertedMuted : styles.dotReviewNeutral} />;
      break;
    case "parked":
      label = t("mainChat.actionBar.capsuleParked", { count });
      leading = (
        <ThemedPauseIcon size={11} uniProps={selected ? invertedIconMapping : mutedIconMapping} />
      );
      break;
    case "completed24h":
      label = t("mainChat.actionBar.capsuleCompleted", { count });
      leading = <ThemedCheckIcon size={12} uniProps={successIconMapping} />;
      break;
  }

  const pillStyle = useMemo(() => [styles.capsule, selected && styles.capsuleSelected], [selected]);
  const textStyle = useMemo(
    () => [styles.capsuleText, selected && styles.capsuleTextSelected],
    [selected],
  );
  const dataSet = useMemo(() => ({ selected: selected ? "true" : "false" }), [selected]);

  return (
    <PressHighlight
      onPress={handlePress}
      style={pillStyle}
      highlightStyle={selected ? styles.capsuleSelectedPressed : styles.rowPressed}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected ? SELECTED_ACCESSIBILITY_STATE : UNSELECTED_ACCESSIBILITY_STATE}
      dataSet={dataSet}
      testID={`main-chat-action-capsule-${bucket}`}
    >
      {leading}
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
});

function resolveCompactDockStatusLabel(
  entry: CompactDockEntry,
  dockGateBadge: ReturnType<typeof deriveDeliveryGateBadge>,
  t: (key: string) => string,
): string {
  if (entry.kind === "needsYou") {
    return t(resolveNeedsYouKindKey(entry.item));
  }
  if (entry.item.dependencyState === "blocked") {
    return t("mainChat.taskDag.blockedBadge");
  }
  if (entry.item.dependencyState === "ready") {
    return t("mainChat.taskDag.readyBadge");
  }
  if (entry.item.allChildrenDone) {
    return t("mainChat.taskDag.parentCloseoutReady");
  }
  if (dockGateBadge?.isBlocked) {
    return `${dockGateBadge.prRef} ${t(dockGateBadge.statusKey)}`;
  }
  return t("mainChat.actionBar.compactDockStatusWorking");
}

function renderCompactDockLeadingIndicator(
  entry: CompactDockEntry,
  isFailed: boolean,
): ReactElement {
  if (entry.kind === "needsYou") {
    return (
      <View style={isFailed ? styles.haloFailedOuter : styles.haloNeedsYouOuter}>
        <View style={isFailed ? styles.haloFailedInner : styles.haloNeedsYouInner} />
      </View>
    );
  }
  if (entry.item.dependencyState === "blocked") {
    return <ThemedLockIcon size={12} uniProps={warningIconMapping} />;
  }
  if (entry.item.dependencyState === "ready") {
    return <ThemedPlayIcon size={12} uniProps={successIconMapping} />;
  }
  return (
    <View style={styles.ringWrap}>
      <StatusRing />
    </View>
  );
}

function resolveDockRuleDiagnostic(entry: CompactDockEntry) {
  if (entry.kind === "inProgress") return entry.item.ruleDiagnostic;
  return entry.item.kind === "task" ? entry.item.ruleDiagnostic : null;
}

function resolveDockRetryTaskId(entry: CompactDockEntry): string | null {
  if (entry.kind !== "needsYou" || entry.item.kind !== "task") return null;
  return entry.item.canRetryWithFallback && entry.item.taskId ? entry.item.taskId : null;
}

function resolveDockRetryButtonLabel(
  isRetrying: boolean,
  isCompact: boolean,
  t: (key: string) => string,
): string {
  if (isRetrying) return t("mainChat.modelProfiles.retryFallback.retrying");
  if (isCompact) return t("mainChat.modelProfiles.retryFallback.buttonCompact");
  return t("mainChat.modelProfiles.retryFallback.buttonShort");
}

const CompactStatusDockRow = memo(function CompactStatusDockRow({
  entry,
  isFirst,
  isCompact,
  hiddenCountBadge,
  busyTaskId,
  onPressNeedsYou,
  onPressInProgress,
  onRetryWithFallback,
  onDismiss,
}: {
  entry: CompactDockEntry;
  isFirst: boolean;
  isCompact: boolean;
  hiddenCountBadge: number;
  busyTaskId: string | null;
  onPressNeedsYou: (item: ActionBarNeedsYouItem) => void;
  onPressInProgress: (item: ActionBarTaskItem) => void;
  onRetryWithFallback?: (taskId: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();

  const handlePress = useCallback(() => {
    if (entry.kind === "needsYou") {
      onPressNeedsYou(entry.item);
    } else {
      onPressInProgress(entry.item);
    }
  }, [entry, onPressInProgress, onPressNeedsYou]);

  const isNeedsYou = entry.kind === "needsYou";
  const isFailed = isNeedsYou && entry.item.kind === "task" && entry.item.isFailed;
  const retryTaskId = resolveDockRetryTaskId(entry);
  const isRetrying = retryTaskId !== null && busyTaskId === retryTaskId;
  const handleRetry = useCallback(() => {
    if (retryTaskId && onRetryWithFallback) {
      onRetryWithFallback(retryTaskId);
    }
  }, [onRetryWithFallback, retryTaskId]);
  const inProgressItem = entry.kind === "inProgress" ? entry.item : null;
  const dockGateBadge = inProgressItem
    ? deriveDeliveryGateBadge(inProgressItem.deliveryGate)
    : null;
  const dockRuleBadge = deriveZeroTokenDiagnosticBadge(resolveDockRuleDiagnostic(entry));
  const title = entry.item.title;
  const secondaryText = useMemo(() => {
    if (isCompact) return null;
    if (entry.kind === "needsYou") {
      const candidate = entry.item.reason ?? entry.item.hostLabel;
      return candidate ? candidate.replace(/\s+/g, " ").trim() : null;
    }
    if (entry.item.dependencyState === "blocked" && entry.item.blockedByTitles.length > 0) {
      return t("mainChat.taskDag.blockedMeta", {
        deps: entry.item.blockedByTitles.slice(0, 2).join("、"),
      });
    }
    const candidate = entry.item.summary ?? entry.item.workspaceLabel ?? entry.item.hostLabel;
    return candidate ? candidate.replace(/\s+/g, " ").trim() : null;
  }, [entry, isCompact, t]);

  const statusLabel = resolveCompactDockStatusLabel(entry, dockGateBadge, t);
  const leadingIndicator = renderCompactDockLeadingIndicator(entry, isFailed);
  const retryLabel = resolveDockRetryButtonLabel(isRetrying, isCompact, t);

  const rowContainerStyle = useMemo(
    () => [styles.compactDockRow, !isFirst && styles.compactDockRowDivider],
    [isFirst],
  );
  const statusTextStyle = useMemo(
    () => [
      styles.compactDockStatus,
      isNeedsYou && (isFailed ? styles.compactDockStatusFailed : styles.compactDockStatusNeedsYou),
      !isNeedsYou && dockGateBadge?.isBlocked && styles.compactDockStatusFailed,
      !isNeedsYou &&
        inProgressItem?.dependencyState === "blocked" &&
        styles.compactDockStatusNeedsYou,
    ],
    [dockGateBadge?.isBlocked, inProgressItem?.dependencyState, isFailed, isNeedsYou],
  );

  return (
    <View
      style={rowContainerStyle}
      testID={`main-chat-compact-dock-row-${entry.kind}-${entry.item.id}`}
    >
      <PressHighlight
        onPress={handlePress}
        style={styles.compactDockRowPress}
        highlightStyle={styles.rowPressed}
        accessibilityRole="button"
        accessibilityLabel={title}
        testID={`main-chat-compact-dock-trigger-${entry.kind}-${entry.item.id}`}
      >
        {leadingIndicator}

        <View style={styles.compactDockTextRun}>
          <Text style={styles.compactDockTitle} numberOfLines={1} ellipsizeMode="tail">
            {title}
          </Text>
          {secondaryText ? (
            <Text style={styles.compactDockMeta} numberOfLines={1} ellipsizeMode="tail">
              {`· ${secondaryText}`}
            </Text>
          ) : null}
        </View>

        <View style={styles.compactDockTrailing}>
          {dockRuleBadge ? (
            <View testID={`main-chat-compact-dock-rule-badge-${entry.item.id}`}>
              <StatusBadge
                size="xs"
                variant={dockRuleBadge.variant}
                label={t(dockRuleBadge.labelKey)}
              />
            </View>
          ) : null}
          {!isCompact && dockGateBadge && !dockGateBadge.isBlocked ? (
            <StatusBadge
              size="xs"
              variant={dockGateBadge.variant}
              label={`${dockGateBadge.prRef} ${t(dockGateBadge.statusKey)}`}
            />
          ) : null}
          <Text style={statusTextStyle} numberOfLines={1}>
            {statusLabel}
          </Text>
          {hiddenCountBadge > 0 ? (
            <Text style={styles.compactDockMore} numberOfLines={1}>
              {t("mainChat.actionBar.compactDockMore", { count: hiddenCountBadge })}
            </Text>
          ) : null}
          <ThemedChevronRight size={13} uniProps={mutedIconMapping} />
        </View>
      </PressHighlight>

      {retryTaskId && onRetryWithFallback ? (
        <PressHighlight
          onPress={handleRetry}
          disabled={isRetrying}
          style={styles.compactDockRetryBtn}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.modelProfiles.retryFallback.button")}
          testID={`main-chat-compact-dock-retry-${retryTaskId}`}
        >
          <ThemedRefreshIcon size={11} uniProps={dangerIconMapping} />
          <Text style={styles.compactDockRetryText} numberOfLines={1}>
            {retryLabel}
          </Text>
        </PressHighlight>
      ) : null}

      {isFirst ? (
        <PressHighlight
          onPress={onDismiss}
          style={styles.compactDockDismissBtn}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.actionBar.compactDockCollapse")}
          testID="main-chat-compact-dock-dismiss"
        >
          <ThemedXIcon size={13} uniProps={mutedIconMapping} />
        </PressHighlight>
      ) : null}
    </View>
  );
});

const CompactStatusDock = memo(function CompactStatusDock({
  entries,
  hiddenCount,
  isCompact,
  busyTaskId,
  onPressNeedsYou,
  onPressInProgress,
  onRetryWithFallback,
  onDismiss,
}: {
  entries: readonly CompactDockEntry[];
  hiddenCount: number;
  isCompact: boolean;
  busyTaskId: string | null;
  onPressNeedsYou: (item: ActionBarNeedsYouItem) => void;
  onPressInProgress: (item: ActionBarTaskItem) => void;
  onRetryWithFallback?: (taskId: string) => void;
  onDismiss: () => void;
}) {
  if (entries.length === 0) return null;

  return (
    <View style={styles.compactDockCard} testID="main-chat-compact-dock">
      {entries.map((entry, index) => (
        <CompactStatusDockRow
          key={`${entry.kind}:${entry.item.id}`}
          entry={entry}
          isFirst={index === 0}
          isCompact={isCompact}
          hiddenCountBadge={index === entries.length - 1 ? hiddenCount : 0}
          busyTaskId={busyTaskId}
          onPressNeedsYou={onPressNeedsYou}
          onPressInProgress={onPressInProgress}
          onRetryWithFallback={onRetryWithFallback}
          onDismiss={onDismiss}
        />
      ))}
    </View>
  );
});

function resolveNeedsYouKindKey(item: ActionBarNeedsYouItem): string {
  switch (item.kind) {
    case "permission":
      return "mainChat.actionBar.needsKindPermission";
    case "decision":
      return "mainChat.actionBar.needsKindDecision";
    case "plan":
      return "mainChat.actionBar.needsKindPlan";
    case "task":
      return item.isFailed ? "mainChat.taskStatus.failed" : "mainChat.taskStatus.needsYou";
  }
}

function normalizeCompareText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function isRedundantText(
  candidate: string | null | undefined,
  existingList: readonly (string | null | undefined)[],
): boolean {
  const normCandidate = normalizeCompareText(candidate);
  if (!normCandidate) return true;
  for (const existing of existingList) {
    const normExisting = normalizeCompareText(existing);
    if (!normExisting) continue;
    if (normExisting === normCandidate || normExisting.includes(normCandidate)) {
      return true;
    }
  }
  return false;
}

const NeedsYouInlineBody = memo(function NeedsYouInlineBody({
  item,
  mainServerId,
  mainAgentId,
  targetClient,
  isRetrying,
  onOpen,
  onDirectRoute,
  onRetryWithFallback,
}: {
  item: ActionBarNeedsYouItem;
  mainServerId: string;
  mainAgentId: string;
  targetClient: ReturnType<typeof useSessionStore.getState>["sessions"][string]["client"] | null;
  isRetrying: boolean;
  onOpen: () => void;
  onDirectRoute: () => void;
  onRetryWithFallback?: () => void;
}) {
  const { t } = useTranslation();

  if (item.kind === "permission") {
    return (
      <View style={styles.inlineStack}>
        {item.permissions.map((perm) => {
          const permCard = (
            <PermissionRequestCard key={perm.key} permission={perm} client={targetClient} />
          );
          if (perm.agentId === mainAgentId && item.serverId === mainServerId) {
            return permCard;
          }
          return (
            <ChildPermissionWrapper
              key={perm.key}
              serverId={item.serverId}
              mainAgentId={mainAgentId}
              permission={perm}
              client={targetClient}
              sourceAgentId={item.agentId}
              sourceAgentTitle={item.title}
              sourceAgentCwd={item.cwd}
            >
              {permCard}
            </ChildPermissionWrapper>
          );
        })}
      </View>
    );
  }
  if (item.kind === "decision") {
    return (
      <MainChatDecisionCard
        serverId={mainServerId}
        agentId={mainAgentId}
        decision={item.decision}
        defaultExpanded
      />
    );
  }
  if (item.kind === "plan") {
    return <MainChatPlanCard serverId={mainServerId} agentId={mainAgentId} plan={item.plan} />;
  }

  const locationParts = [item.hostLabel, item.workspaceLabel ?? item.cwd].filter(
    (part): part is string => Boolean(part && part.trim().length > 0),
  );
  const locationText = locationParts.length > 0 ? locationParts.join(" · ") : null;
  const primaryText = item.reason;
  const showSummary = !isRedundantText(item.summary, [primaryText]);
  const showGoal = !isRedundantText(item.goal, [primaryText, showSummary ? item.summary : null]);
  const showSuggestedAction = !isRedundantText(item.suggestedAction, [
    primaryText,
    showSummary ? item.summary : null,
  ]);

  return (
    <View style={styles.taskNeedsInline}>
      {locationText ? (
        <Text style={styles.inlineContextMeta} numberOfLines={1}>
          {locationText}
        </Text>
      ) : null}

      {primaryText ? (
        <View style={styles.inlineDetailBlock}>
          <Text style={styles.inlineDetailLabel}>
            {t(
              item.isFailed
                ? "mainChat.actionBar.needsDetailFailureLabel"
                : "mainChat.actionBar.needsDetailQuestionLabel",
            )}
          </Text>
          <Text
            style={styles.inlineDetailText}
            testID={`main-chat-action-needs-question-${item.id}`}
          >
            {primaryText}
          </Text>
        </View>
      ) : null}

      {showSummary && item.summary ? (
        <View style={styles.inlineDetailBlock}>
          <Text style={styles.inlineDetailLabel}>
            {t("mainChat.actionBar.needsDetailSummaryLabel")}
          </Text>
          <Text
            style={styles.inlineSecondaryText}
            testID={`main-chat-action-needs-summary-${item.id}`}
          >
            {item.summary}
          </Text>
        </View>
      ) : null}

      {showGoal && item.goal ? (
        <View style={styles.inlineDetailBlock}>
          <Text style={styles.inlineDetailLabel}>
            {t("mainChat.actionBar.needsDetailGoalLabel")}
          </Text>
          <Text style={styles.inlineSecondaryText}>{item.goal}</Text>
        </View>
      ) : null}

      {showSuggestedAction && item.suggestedAction ? (
        <View style={styles.inlineDetailBlock}>
          <Text style={styles.inlineDetailLabel}>
            {t("mainChat.actionBar.needsDetailSuggestionLabel")}
          </Text>
          <Text
            style={styles.inlineSuggestionText}
            testID={`main-chat-action-needs-suggestion-${item.id}`}
          >
            {item.suggestedAction}
          </Text>
        </View>
      ) : null}

      <NeedsYouTaskRuleAndActions
        item={item}
        isRetrying={isRetrying}
        onOpen={onOpen}
        onDirectRoute={onDirectRoute}
        onRetryWithFallback={onRetryWithFallback}
      />
    </View>
  );
});

const NeedsYouTaskRuleAndActions = memo(function NeedsYouTaskRuleAndActions({
  item,
  isRetrying,
  onOpen,
  onDirectRoute,
  onRetryWithFallback,
}: {
  item: Extract<ActionBarNeedsYouItem, { kind: "task" }>;
  isRetrying: boolean;
  onOpen: () => void;
  onDirectRoute: () => void;
  onRetryWithFallback?: () => void;
}) {
  const { t } = useTranslation();
  const showRetry = Boolean(item.canRetryWithFallback && item.taskId && onRetryWithFallback);
  const showActionRow = Boolean(item.agentId || showRetry);

  return (
    <>
      {item.ruleDiagnostic ? (
        <View
          style={styles.inlineRuleDetailBox}
          testID={`main-chat-action-needs-rule-detail-${item.id}`}
        >
          <Text style={styles.inlineDetailLabel}>{t("mainChat.zeroTokenRules.sectionLabel")}</Text>
          <Text style={styles.inlineRuleDetailText}>{item.ruleDiagnostic.summary}</Text>
          {item.ruleDiagnostic.errorExcerpt ? (
            <Text style={styles.inlineSecondaryText} numberOfLines={2}>
              {`${t("mainChat.zeroTokenRules.errorExcerptLabel")}：${item.ruleDiagnostic.errorExcerpt}`}
            </Text>
          ) : null}
        </View>
      ) : null}

      {showActionRow ? (
        <View style={styles.inlineActionRow}>
          {showRetry && item.taskId ? (
            <Button
              variant="default"
              size="sm"
              leftIcon={ThemedRefreshIcon}
              loading={isRetrying}
              disabled={isRetrying}
              onPress={onRetryWithFallback}
              testID={`main-chat-action-needs-inline-retry-${item.taskId}`}
            >
              {t("mainChat.modelProfiles.retryFallback.button")}
            </Button>
          ) : null}
          {item.agentId ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                leftIcon={ThemedArrowIcon}
                onPress={onOpen}
                testID={`main-chat-action-needs-task-open-${item.id}`}
              >
                {t("mainChat.openChildAgent")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                leftIcon={ThemedAtIcon}
                onPress={onDirectRoute}
                testID={`main-chat-action-needs-task-direct-${item.id}`}
              >
                {t("mainChat.board.talkDirectly")}
              </Button>
            </>
          ) : null}
        </View>
      ) : null}
    </>
  );
});

interface ActionBarDirectTarget {
  serverId: string;
  agentId: string;
  title: string;
}

const NeedsYouRowHeaderActions = memo(function NeedsYouRowHeaderActions({
  item,
  retryTaskId,
  isRetrying,
  onRetry,
  onDirectRoute,
  onOpen,
}: {
  item: ActionBarNeedsYouItem;
  retryTaskId: string | null;
  isRetrying: boolean;
  onRetry?: () => void;
  onDirectRoute: () => void;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  if (!item.agentId && !(retryTaskId && onRetry)) return null;

  return (
    <View style={styles.taskRowActions}>
      {retryTaskId && onRetry ? (
        <PressHighlight
          onPress={onRetry}
          disabled={isRetrying}
          style={styles.inlineRetryBtn}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.modelProfiles.retryFallback.button")}
          testID={`main-chat-action-retry-fallback-${retryTaskId}`}
        >
          <ThemedRefreshIcon size={12} uniProps={dangerIconMapping} />
          <Text style={styles.inlineRetryLabel}>
            {isRetrying
              ? t("mainChat.modelProfiles.retryFallback.retrying")
              : t("mainChat.modelProfiles.retryFallback.buttonShort")}
          </Text>
        </PressHighlight>
      ) : null}
      {item.agentId ? (
        <>
          <PressHighlight
            onPress={onDirectRoute}
            style={styles.inlineActionBtn}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.board.talkDirectly")}
            testID={`main-chat-action-direct-${item.id}`}
          >
            <ThemedAtIcon size={12} uniProps={mutedIconMapping} />
            <Text style={styles.inlineActionLabel}>{t("mainChat.board.talkDirectly")}</Text>
          </PressHighlight>
          <PressHighlight
            onPress={onOpen}
            style={styles.smallIconButton}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.openChildAgent")}
            testID={`main-chat-action-needs-open-${item.id}`}
          >
            <ThemedArrowIcon size={13} uniProps={mutedIconMapping} />
          </PressHighlight>
        </>
      ) : null}
    </View>
  );
});

function resolveNeedsYouRowMetaText(item: ActionBarNeedsYouItem): string | null {
  if (!item.reason) return null;
  const compactReason = item.reason.replace(/\s+/g, " ").trim();
  return item.hostLabel ? `${item.hostLabel} · ${compactReason}` : compactReason;
}

function resolveNeedsYouRetryTaskId(item: ActionBarNeedsYouItem): string | null {
  if (item.kind !== "task" || !item.canRetryWithFallback) return null;
  return item.taskId ?? null;
}

const NeedsYouRow = memo(function NeedsYouRow({
  item,
  mainServerId,
  mainAgentId,
  expanded,
  busyTaskId,
  onToggleExpand,
  onOpenTask,
  onDirectRoute,
  onRetryWithFallback,
}: {
  item: ActionBarNeedsYouItem;
  mainServerId: string;
  mainAgentId: string;
  expanded: boolean;
  busyTaskId: string | null;
  onToggleExpand: (id: string) => void;
  onOpenTask: (target: {
    serverId: string;
    agentId: string;
    workspaceId?: string | null;
    title?: string | null;
    taskId?: string | null;
  }) => void;
  onDirectRoute: (target: ActionBarDirectTarget) => void;
  onRetryWithFallback?: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const targetClient = useSessionStore((state) => state.sessions[item.serverId]?.client ?? null);
  const handleToggle = useCallback(() => onToggleExpand(item.id), [item.id, onToggleExpand]);
  const handleOpen = useCallback(() => {
    if (!item.agentId) return;
    onOpenTask({
      serverId: item.serverId,
      agentId: item.agentId,
      workspaceId: item.workspaceId,
      title: item.title,
      taskId: item.taskId,
    });
  }, [item.agentId, item.serverId, item.taskId, item.title, item.workspaceId, onOpenTask]);
  const handleDirectRoute = useCallback(() => {
    if (!item.agentId) return;
    onDirectRoute({
      serverId: item.serverId,
      agentId: item.agentId,
      title: item.title,
    });
  }, [item.agentId, item.serverId, item.title, onDirectRoute]);

  const retryTaskId = resolveNeedsYouRetryTaskId(item);
  const isRetrying = retryTaskId !== null && busyTaskId === retryTaskId;
  const handleRetry = useCallback(() => {
    if (retryTaskId && onRetryWithFallback) {
      onRetryWithFallback(retryTaskId);
    }
  }, [onRetryWithFallback, retryTaskId]);
  const ruleBadge =
    item.kind === "task" ? deriveZeroTokenDiagnosticBadge(item.ruleDiagnostic) : null;

  const kindLabel = t(resolveNeedsYouKindKey(item));
  const isFailedTask = item.kind === "task" && item.isFailed;
  const metaText = resolveNeedsYouRowMetaText(item);

  const cardStyle = useMemo(
    () => [styles.needsCard, isFailedTask && styles.needsCardFailed],
    [isFailedTask],
  );
  const statusTextStyle = useMemo(
    () => [styles.needsKindText, isFailedTask && styles.needsKindTextFailed],
    [isFailedTask],
  );

  return (
    <View style={cardStyle} testID={`main-chat-action-needs-item-${item.id}`}>
      <View style={styles.needsRowHeader}>
        <PressHighlight
          onPress={handleToggle}
          style={styles.needsRowToggle}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={item.title}
          testID={`main-chat-action-needs-toggle-${item.id}`}
        >
          <View style={isFailedTask ? styles.haloFailedOuter : styles.haloNeedsYouOuter}>
            <View style={isFailedTask ? styles.haloFailedInner : styles.haloNeedsYouInner} />
          </View>
          <View style={styles.rowTextCol}>
            <View style={styles.rowTitleLine}>
              <Text style={styles.needsRowTitle} numberOfLines={1}>
                {item.title}
              </Text>
              {item.kind === "permission" && item.permissions.length > 1 ? (
                <StatusBadge size="xs" variant="muted" label={`${item.permissions.length}`} />
              ) : null}
              {ruleBadge ? (
                <View testID={`main-chat-action-needs-rule-badge-${item.id}`}>
                  <StatusBadge
                    size="xs"
                    variant={ruleBadge.variant}
                    label={t(ruleBadge.labelKey)}
                  />
                </View>
              ) : null}
            </View>
            {metaText ? (
              <Text style={styles.rowMeta} numberOfLines={1}>
                {metaText}
              </Text>
            ) : null}
          </View>
          <View style={styles.needsTrailingStatus}>
            <Text style={statusTextStyle} numberOfLines={1}>
              {kindLabel}
            </Text>
            {expanded ? (
              <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
            ) : (
              <ThemedChevronRight size={13} uniProps={mutedIconMapping} />
            )}
          </View>
        </PressHighlight>

        <NeedsYouRowHeaderActions
          item={item}
          retryTaskId={retryTaskId}
          isRetrying={isRetrying}
          onRetry={retryTaskId && onRetryWithFallback ? handleRetry : undefined}
          onDirectRoute={handleDirectRoute}
          onOpen={handleOpen}
        />
      </View>

      {expanded ? (
        <View style={styles.inlineBody} testID={`main-chat-action-needs-inline-${item.id}`}>
          <NeedsYouInlineBody
            item={item}
            mainServerId={mainServerId}
            mainAgentId={mainAgentId}
            targetClient={targetClient}
            isRetrying={isRetrying}
            onOpen={handleOpen}
            onDirectRoute={handleDirectRoute}
            onRetryWithFallback={retryTaskId && onRetryWithFallback ? handleRetry : undefined}
          />
        </View>
      ) : null}
    </View>
  );
});

function renderTaskBucketLeadingMark(
  bucket: Exclude<ActionBarBucketKey, "needsYou">,
  item: ActionBarTaskItem,
): ReactElement {
  if (bucket === "inProgress") {
    if (item.dependencyState === "blocked") {
      return <ThemedLockIcon size={13} uniProps={warningIconMapping} />;
    }
    if (item.dependencyState === "ready") {
      return <ThemedPlayIcon size={13} uniProps={successIconMapping} />;
    }
    if (item.stale48h) return <ThemedClockIcon size={13} uniProps={warningIconMapping} />;
    if (item.isLiveRunning) {
      return (
        <View style={styles.ringWrap}>
          <StatusRing />
        </View>
      );
    }
    return <View style={styles.dotMuted} />;
  }
  if (bucket === "awaitingReview") {
    return <View style={styles.dotReviewNeutral} />;
  }
  if (bucket === "parked") {
    return <ThemedPauseIcon size={13} uniProps={mutedIconMapping} />;
  }
  return <ThemedCheckIcon size={13} uniProps={successIconMapping} />;
}

const TaskBucketRowBadges = memo(function TaskBucketRowBadges({
  item,
}: {
  item: ActionBarTaskItem;
}) {
  const { t } = useTranslation();
  const gateBadge = deriveDeliveryGateBadge(item.deliveryGate);
  const ruleBadge = deriveZeroTokenDiagnosticBadge(item.ruleDiagnostic);

  return (
    <>
      {ruleBadge ? (
        <View testID={`main-chat-action-task-rule-badge-${item.id}`}>
          <StatusBadge size="xs" variant={ruleBadge.variant} label={t(ruleBadge.labelKey)} />
        </View>
      ) : null}
      {item.childrenTotal > 0 ? (
        <StatusBadge
          size="xs"
          variant={item.allChildrenDone ? "success" : "muted"}
          label={
            item.allChildrenDone
              ? t("mainChat.taskDag.parentCloseoutReady")
              : t("mainChat.taskDag.childrenProgress", {
                  done: item.childrenCompleted,
                  total: item.childrenTotal,
                })
          }
        />
      ) : null}
      {item.dependencyState === "blocked" ? (
        <StatusBadge size="xs" variant="warning" label={t("mainChat.taskDag.blockedBadge")} />
      ) : null}
      {item.dependencyState === "ready" ? (
        <StatusBadge size="xs" variant="success" label={t("mainChat.taskDag.readyBadge")} />
      ) : null}
      {gateBadge ? (
        <View testID={`main-chat-action-delivery-gate-${item.id}`}>
          <StatusBadge
            size="xs"
            variant={gateBadge.variant}
            label={`${gateBadge.prRef} ${t(gateBadge.statusKey)}`}
          />
        </View>
      ) : null}
      {gateBadge?.followUpActive && !gateBadge.isMerged ? (
        <StatusBadge size="xs" variant="muted" label={t("mainChat.deliveryGate.followUpBadge")} />
      ) : null}
    </>
  );
});

const TaskBucketRowActions = memo(function TaskBucketRowActions({
  bucket,
  item,
  isBusy,
  onOpen,
  onDirectRoute,
  onPause,
  onResume,
  onStartReady,
  onAccept,
  onToggleRework,
}: {
  bucket: Exclude<ActionBarBucketKey, "needsYou">;
  item: ActionBarTaskItem;
  isBusy: boolean;
  onOpen: () => void;
  onDirectRoute: () => void;
  onPause: () => void;
  onResume: () => void;
  onStartReady: () => void;
  onAccept: () => void;
  onToggleRework: () => void;
}) {
  const { t } = useTranslation();

  return (
    <View style={styles.taskRowActions}>
      {item.canStartReady && item.taskId ? (
        <PressHighlight
          onPress={onStartReady}
          disabled={isBusy}
          style={styles.inlineActionBtn}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.taskDag.startReadyFullAction")}
          testID={`main-chat-action-start-ready-${item.taskId}`}
        >
          <ThemedPlayIcon size={12} uniProps={successIconMapping} />
          <Text style={styles.inlineActionLabel}>{t("mainChat.taskDag.startReadyAction")}</Text>
        </PressHighlight>
      ) : null}

      {bucket === "inProgress" && item.taskId && !item.canStartReady ? (
        <PressHighlight
          onPress={onPause}
          disabled={isBusy}
          style={styles.inlineActionBtn}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.actionBar.pauseAction")}
          testID={`main-chat-action-park-${item.taskId}`}
        >
          <ThemedPauseIcon size={12} uniProps={mutedIconMapping} />
          <Text style={styles.inlineActionLabel}>{t("mainChat.actionBar.pauseAction")}</Text>
        </PressHighlight>
      ) : null}

      {bucket === "parked" && item.taskId ? (
        <PressHighlight
          onPress={onResume}
          disabled={isBusy}
          style={styles.inlineActionBtn}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.actionBar.resumeAction")}
          testID={`main-chat-action-resume-${item.taskId}`}
        >
          <ThemedPlayIcon size={12} uniProps={mutedIconMapping} />
          <Text style={styles.inlineActionLabel}>{t("mainChat.actionBar.resumeAction")}</Text>
        </PressHighlight>
      ) : null}

      {bucket === "awaitingReview" && item.taskId ? (
        <>
          <PressHighlight
            onPress={onAccept}
            disabled={isBusy}
            style={styles.inlineActionBtn}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.actionBar.acceptAction")}
            testID={`main-chat-action-accept-${item.taskId}`}
          >
            <ThemedCheckIcon size={12} uniProps={successIconMapping} />
            <Text style={styles.inlineActionLabel}>{t("mainChat.actionBar.acceptAction")}</Text>
          </PressHighlight>
          <PressHighlight
            onPress={onToggleRework}
            disabled={isBusy}
            style={styles.inlineActionBtn}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.actionBar.reworkAction")}
            testID={`main-chat-action-rework-toggle-${item.taskId}`}
          >
            <ThemedReworkIcon size={12} uniProps={mutedIconMapping} />
            <Text style={styles.inlineActionLabel}>{t("mainChat.actionBar.reworkAction")}</Text>
          </PressHighlight>
        </>
      ) : null}

      {item.agentId ? (
        <>
          <PressHighlight
            onPress={onDirectRoute}
            style={styles.inlineActionBtn}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.board.talkDirectly")}
            testID={`main-chat-action-direct-${item.id}`}
          >
            <ThemedAtIcon size={12} uniProps={mutedIconMapping} />
            <Text style={styles.inlineActionLabel}>{t("mainChat.board.talkDirectly")}</Text>
          </PressHighlight>
          <PressHighlight
            onPress={onOpen}
            style={styles.smallIconButton}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.openChildAgent")}
          >
            <ThemedArrowIcon size={13} uniProps={mutedIconMapping} />
          </PressHighlight>
        </>
      ) : null}
    </View>
  );
});

function resolveTaskRowDagMeta(
  item: ActionBarTaskItem,
  t: (key: string, params?: Record<string, unknown>) => string,
): string | null {
  if (item.dependencyState === "blocked" && item.blockedByTitles.length > 0) {
    return t("mainChat.taskDag.blockedMeta", { deps: item.blockedByTitles.join("、") });
  }
  if (item.dependencyState === "ready") {
    return t("mainChat.taskDag.readyMeta");
  }
  if (item.parentTitle) {
    return t("mainChat.taskDag.partOfLabel", { title: item.parentTitle });
  }
  return null;
}

const TaskBucketRow = memo(function TaskBucketRow({
  bucket,
  item,
  showTopDivider,
  busyTaskId,
  onOpenTask,
  onDirectRoute,
  onParkTask,
  onStartReadyTask,
  onAcceptReview,
  onSubmitRework,
}: {
  bucket: Exclude<ActionBarBucketKey, "needsYou">;
  item: ActionBarTaskItem;
  showTopDivider: boolean;
  busyTaskId: string | null;
  onOpenTask: (item: ActionBarTaskItem) => void;
  onDirectRoute: (target: ActionBarDirectTarget) => void;
  onParkTask: (taskId: string, parked: boolean) => void;
  onStartReadyTask: (taskId: string) => void;
  onAcceptReview: (taskId: string) => void;
  onSubmitRework: (taskId: string, gapText: string) => void;
}) {
  const { t } = useTranslation();
  const [reworkOpen, setReworkOpen] = useState(false);
  const [reworkDraft, setReworkDraft] = useState("");

  const isBusy = item.taskId !== null && busyTaskId === item.taskId;
  const handleOpen = useCallback(() => onOpenTask(item), [item, onOpenTask]);
  const handleDirectRoute = useCallback(() => {
    if (!item.agentId) return;
    onDirectRoute({
      serverId: item.serverId,
      agentId: item.agentId,
      title: item.title,
    });
  }, [item.agentId, item.serverId, item.title, onDirectRoute]);
  const handlePause = useCallback(() => {
    if (item.taskId) onParkTask(item.taskId, true);
  }, [item.taskId, onParkTask]);
  const handleResume = useCallback(() => {
    if (item.taskId) onParkTask(item.taskId, false);
  }, [item.taskId, onParkTask]);
  const handleStartReady = useCallback(() => {
    if (item.taskId) onStartReadyTask(item.taskId);
  }, [item.taskId, onStartReadyTask]);
  const handleAccept = useCallback(() => {
    if (item.taskId) onAcceptReview(item.taskId);
  }, [item.taskId, onAcceptReview]);
  const handleToggleRework = useCallback(() => {
    setReworkOpen((prev) => !prev);
  }, []);
  const handleConfirmRework = useCallback(() => {
    if (!item.taskId || !reworkDraft.trim()) return;
    onSubmitRework(item.taskId, reworkDraft.trim());
    setReworkDraft("");
    setReworkOpen(false);
  }, [item.taskId, onSubmitRework, reworkDraft]);

  const dagMetaText = resolveTaskRowDagMeta(item, t);

  const metaParts = [
    dagMetaText,
    item.hostLabel,
    item.workspaceLabel,
    bucket === "parked" && item.parkedReason ? item.parkedReason : item.summary,
  ].filter(Boolean);

  const rowStyle = useMemo(
    () => [
      styles.taskRowListItem,
      showTopDivider && styles.taskRowDivider,
      item.hierarchyDepth === 1 && styles.taskRowIndented,
    ],
    [item.hierarchyDepth, showTopDivider],
  );

  return (
    <View style={rowStyle} testID={`main-chat-action-task-${bucket}-${item.id}`}>
      <View style={styles.taskRowMain}>
        <PressHighlight
          onPress={handleOpen}
          disabled={!item.agentId}
          style={styles.taskRowPress}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={item.title}
          testID={`main-chat-action-task-open-${item.id}`}
        >
          {item.hierarchyDepth === 1 ? (
            <View style={styles.hierarchyBranchIcon} testID={`main-chat-action-child-${item.id}`}>
              <ThemedCornerDownRight size={12} uniProps={mutedIconMapping} />
            </View>
          ) : null}
          {renderTaskBucketLeadingMark(bucket, item)}

          <View style={styles.rowTextCol}>
            <View style={styles.rowTitleLine}>
              <Text style={styles.rowTitle} numberOfLines={1}>
                {item.title}
              </Text>
              <TaskBucketRowBadges item={item} />
              {item.stale48h ? (
                <StatusBadge
                  size="xs"
                  variant="muted"
                  label={t("mainChat.actionBar.stale48hBadge")}
                />
              ) : null}
              {item.mode ? (
                <StatusBadge
                  size="xs"
                  variant={item.mode === "readonly" ? "success" : "muted"}
                  label={
                    item.mode === "readonly"
                      ? t("mainChat.mode.readonly")
                      : t("mainChat.mode.write")
                  }
                />
              ) : null}
            </View>
            {metaParts.length > 0 ? (
              <Text style={styles.rowMeta} numberOfLines={1}>
                {metaParts.join(" · ")}
              </Text>
            ) : null}
          </View>
        </PressHighlight>

        <TaskBucketRowActions
          bucket={bucket}
          item={item}
          isBusy={isBusy}
          onOpen={handleOpen}
          onDirectRoute={handleDirectRoute}
          onPause={handlePause}
          onResume={handleResume}
          onStartReady={handleStartReady}
          onAccept={handleAccept}
          onToggleRework={handleToggleRework}
        />
      </View>

      {reworkOpen && bucket === "awaitingReview" && item.taskId ? (
        <View style={styles.reworkInputRow} testID={`main-chat-action-rework-form-${item.taskId}`}>
          <EditingTextInput
            initialValue={reworkDraft}
            onChangeText={setReworkDraft}
            style={styles.reworkInput}
            placeholder={t("mainChat.actionBar.reworkPlaceholder")}
            testID={`main-chat-action-rework-input-${item.taskId}`}
          />
          <Button
            variant="secondary"
            size="sm"
            loading={isBusy}
            disabled={isBusy || reworkDraft.trim().length === 0}
            onPress={handleConfirmRework}
            testID={`main-chat-action-rework-submit-${item.taskId}`}
          >
            {t("mainChat.actionBar.reworkConfirm")}
          </Button>
        </View>
      ) : null}
    </View>
  );
});

function resolveActionBarPanelTitleKey(bucket: ActionBarBucketKey): string {
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

const InProgressBucketContent = memo(function InProgressBucketContent({
  activeItems,
  staleItems,
  staleExpanded,
  busyTaskId,
  onToggleStale,
  onOpenTask,
  onDirectRoute,
  onParkTask,
  onStartReadyTask,
  onAcceptReview,
  onSubmitRework,
}: {
  activeItems: readonly ActionBarTaskItem[];
  staleItems: readonly ActionBarTaskItem[];
  staleExpanded: boolean;
  busyTaskId: string | null;
  onToggleStale: () => void;
  onOpenTask: (item: ActionBarTaskItem) => void;
  onDirectRoute: (target: ActionBarDirectTarget) => void;
  onParkTask: (taskId: string, parked: boolean) => void;
  onStartReadyTask: (taskId: string) => void;
  onAcceptReview: (taskId: string) => void;
  onSubmitRework: (taskId: string, gapText: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      {activeItems.map((item, index) => (
        <TaskBucketRow
          key={item.id}
          bucket="inProgress"
          item={item}
          showTopDivider={index > 0}
          busyTaskId={busyTaskId}
          onOpenTask={onOpenTask}
          onDirectRoute={onDirectRoute}
          onParkTask={onParkTask}
          onStartReadyTask={onStartReadyTask}
          onAcceptReview={onAcceptReview}
          onSubmitRework={onSubmitRework}
        />
      ))}
      {staleItems.length > 0 ? (
        <View
          style={[styles.staleGroup, activeItems.length > 0 && styles.taskRowDivider]}
          testID="main-chat-action-stale-section"
        >
          <PressHighlight
            onPress={onToggleStale}
            style={styles.staleHeader}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            testID="main-chat-action-stale-toggle"
          >
            {staleExpanded ? (
              <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
            ) : (
              <ThemedChevronRight size={13} uniProps={mutedIconMapping} />
            )}
            <ThemedClockIcon size={12} uniProps={warningIconMapping} />
            <Text style={styles.staleHeaderText}>
              {t("mainChat.actionBar.stale48hSectionTitle", {
                count: staleItems.length,
              })}
            </Text>
          </PressHighlight>
          {staleExpanded
            ? staleItems.map((item, index) => (
                <TaskBucketRow
                  key={item.id}
                  bucket="inProgress"
                  item={item}
                  showTopDivider={index > 0}
                  busyTaskId={busyTaskId}
                  onOpenTask={onOpenTask}
                  onDirectRoute={onDirectRoute}
                  onParkTask={onParkTask}
                  onStartReadyTask={onStartReadyTask}
                  onAcceptReview={onAcceptReview}
                  onSubmitRework={onSubmitRework}
                />
              ))
            : null}
        </View>
      ) : null}
    </>
  );
});

const ActionBarDrawerPanel = memo(function ActionBarDrawerPanel({
  openBucket,
  model,
  serverId,
  agentId,
  drawerExpanded,
  expandedNeedsIds,
  staleExpanded,
  busyTaskId,
  onToggleDrawerExpand,
  onOpenLessons,
  onClose,
  onToggleNeedsRow,
  onToggleStale,
  onOpenTarget,
  onOpenTaskItem,
  onDirectRoute,
  onParkTask,
  onStartReadyTask,
  onRetryWithFallback,
  onAcceptReview,
  onSubmitRework,
}: {
  openBucket: ActionBarBucketKey;
  model: ReturnType<typeof buildMainChatActionBarModel>;
  serverId: string;
  agentId: string;
  drawerExpanded: boolean;
  expandedNeedsIds: ReadonlySet<string>;
  staleExpanded: boolean;
  busyTaskId: string | null;
  onToggleDrawerExpand: () => void;
  onOpenLessons: () => void;
  onClose: () => void;
  onToggleNeedsRow: (id: string) => void;
  onToggleStale: () => void;
  onOpenTarget: (target: {
    serverId: string;
    agentId: string;
    workspaceId?: string | null;
    title?: string | null;
    taskId?: string | null;
  }) => void;
  onOpenTaskItem: (item: ActionBarTaskItem) => void;
  onDirectRoute: (target: ActionBarDirectTarget) => void;
  onParkTask: (taskId: string, parked: boolean) => void;
  onStartReadyTask: (taskId: string) => void;
  onRetryWithFallback: (taskId: string) => void;
  onAcceptReview: (taskId: string) => void;
  onSubmitRework: (taskId: string, gapText: string) => void;
}) {
  const { t } = useTranslation();
  let simpleBucketItems: readonly ActionBarTaskItem[] | null = null;
  if (openBucket === "awaitingReview") {
    simpleBucketItems = model.awaitingReview;
  } else if (openBucket === "parked") {
    simpleBucketItems = model.parked;
  } else if (openBucket === "completed24h") {
    simpleBucketItems = model.completed24h;
  }

  return (
    <View
      style={drawerExpanded ? styles.drawerExpanded : styles.drawer}
      testID={`main-chat-action-panel-${openBucket}`}
    >
      <View style={styles.drawerHeader}>
        <Text style={styles.drawerTitle}>{t(resolveActionBarPanelTitleKey(openBucket))}</Text>
        <View style={styles.drawerHeaderActions}>
          <PressHighlight
            onPress={onOpenLessons}
            style={styles.inlineActionBtn}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.projectLessons.sectionTitle")}
            testID="main-chat-action-open-lessons"
          >
            <ThemedBookIcon size={12} uniProps={mutedIconMapping} />
            <Text style={styles.inlineActionLabel}>
              {model.projectLessonsCount > 0
                ? t("mainChat.projectLessons.entryButtonWithCount", {
                    count: model.projectLessonsCount,
                  })
                : t("mainChat.projectLessons.entryButton")}
            </Text>
          </PressHighlight>
          <PressHighlight
            onPress={onToggleDrawerExpand}
            style={styles.smallIconButton}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={
              drawerExpanded ? t("turnSummary.showLess") : t("turnSummary.showMore")
            }
            testID="main-chat-action-panel-expand"
          >
            {drawerExpanded ? (
              <ThemedMinimizeIcon size={13} uniProps={mutedIconMapping} />
            ) : (
              <ThemedMaximizeIcon size={13} uniProps={mutedIconMapping} />
            )}
          </PressHighlight>
          <PressHighlight
            onPress={onClose}
            style={styles.smallIconButton}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={t("common.actions.close")}
            testID="main-chat-action-panel-close"
          >
            <ThemedXIcon size={14} uniProps={mutedIconMapping} />
          </PressHighlight>
        </View>
      </View>

      <ScrollView
        style={drawerExpanded ? styles.drawerScrollExpanded : styles.drawerScroll}
        contentContainerStyle={
          openBucket === "needsYou"
            ? styles.drawerScrollContentNeeds
            : styles.drawerScrollContentLight
        }
        keyboardShouldPersistTaps="handled"
      >
        {openBucket === "needsYou"
          ? model.needsYou.map((item) => (
              <NeedsYouRow
                key={item.id}
                item={item}
                mainServerId={serverId}
                mainAgentId={agentId}
                expanded={expandedNeedsIds.has(item.id)}
                busyTaskId={busyTaskId}
                onToggleExpand={onToggleNeedsRow}
                onOpenTask={onOpenTarget}
                onDirectRoute={onDirectRoute}
                onRetryWithFallback={onRetryWithFallback}
              />
            ))
          : null}

        {openBucket === "inProgress" ? (
          <InProgressBucketContent
            activeItems={model.inProgress.active}
            staleItems={model.inProgress.stale}
            staleExpanded={staleExpanded}
            busyTaskId={busyTaskId}
            onToggleStale={onToggleStale}
            onOpenTask={onOpenTaskItem}
            onDirectRoute={onDirectRoute}
            onParkTask={onParkTask}
            onStartReadyTask={onStartReadyTask}
            onAcceptReview={onAcceptReview}
            onSubmitRework={onSubmitRework}
          />
        ) : null}

        {simpleBucketItems &&
        (openBucket === "awaitingReview" ||
          openBucket === "parked" ||
          openBucket === "completed24h")
          ? simpleBucketItems.map((item, index) => (
              <TaskBucketRow
                key={item.id}
                bucket={openBucket}
                item={item}
                showTopDivider={index > 0}
                busyTaskId={busyTaskId}
                onOpenTask={onOpenTaskItem}
                onDirectRoute={onDirectRoute}
                onParkTask={onParkTask}
                onStartReadyTask={onStartReadyTask}
                onAcceptReview={onAcceptReview}
                onSubmitRework={onSubmitRework}
              />
            ))
          : null}
      </ScrollView>
    </View>
  );
});

function useMainChatActionBarData(serverId: string, agentId: string) {
  const hosts = useHosts();
  const allowedServerIds = useStewardAllowedServerIds(serverId);

  const sessionSnapshot = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => selectActionBarSessionSnapshot(state, serverId, agentId, allowedServerIds),
      [agentId, allowedServerIds, serverId],
    ),
    equal,
  );

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const overviewKey = overviewStoreKey(serverId, agentId);
  const overview = useMainChatOverviewStore((state) => state.overviewsByKey[overviewKey] ?? null);
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);
  const parkTask = useMainChatOverviewStore((state) => state.parkTask);
  const startReadyTask = useMainChatOverviewStore((state) => state.startReadyTask);
  const reviewTask = useMainChatOverviewStore((state) => state.reviewTask);
  const retryTaskWithFallback = useMainChatOverviewStore((state) => state.retryTaskWithFallback);

  const hostLabelsByServerId = useMemo(
    () => Object.fromEntries(hosts.map((host) => [host.serverId, host.label])),
    [hosts],
  );

  const model = useMemo(
    () =>
      sessionSnapshot.isMainChat
        ? buildMainChatActionBarModel({
            serverId,
            mainAgentId: agentId,
            overview,
            liveAgents: sessionSnapshot.liveAgents,
            pendingPermissions: sessionSnapshot.pendingPermissions,
            hostLabelsByServerId,
          })
        : null,
    [
      agentId,
      hostLabelsByServerId,
      overview,
      serverId,
      sessionSnapshot.isMainChat,
      sessionSnapshot.liveAgents,
      sessionSnapshot.pendingPermissions,
    ],
  );

  return {
    client,
    overviewKey,
    overview,
    loadOverview,
    parkTask,
    startReadyTask,
    reviewTask,
    retryTaskWithFallback,
    sessionSnapshot,
    model,
  };
}

function useMainChatActionBarSilentRefresh(input: {
  serverId: string;
  agentId: string;
  overviewKey: string;
  openBucket: ActionBarBucketKey | null;
  sessionSnapshot: ActionBarSessionSnapshot;
  client: ReturnType<typeof useSessionStore.getState>["sessions"][string]["client"] | null;
  loadOverview: ReturnType<typeof useMainChatOverviewStore.getState>["loadOverview"];
}): void {
  const { serverId, agentId, overviewKey, openBucket, sessionSnapshot, client, loadOverview } =
    input;
  const overviewRefreshInFlightRef = useRef(false);
  const overviewRefreshPendingRef = useRef(false);
  const mountedRef = useRef(true);
  const prevLiveStateSignatureRef = useRef<string | null>(null);
  const prevOverviewKeyRef = useRef<string>(overviewKey);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshOverviewSilently = useCallback(() => {
    if (
      !sessionSnapshot.isMainChat ||
      !client ||
      typeof client.getMainChatOverview !== "function"
    ) {
      return;
    }
    if (overviewRefreshInFlightRef.current) {
      overviewRefreshPendingRef.current = true;
      return;
    }

    const run = () => {
      if (!mountedRef.current) return;
      overviewRefreshInFlightRef.current = true;
      overviewRefreshPendingRef.current = false;
      void loadOverview(serverId, agentId, client)
        .catch(() => undefined)
        .finally(() => {
          overviewRefreshInFlightRef.current = false;
          if (overviewRefreshPendingRef.current && mountedRef.current) {
            overviewRefreshPendingRef.current = false;
            run();
          }
        });
    };

    run();
  }, [agentId, client, loadOverview, serverId, sessionSnapshot.isMainChat]);

  // Refresh overview whenever the user opens or switches a tray drawer (no one-shot cache gate).
  useEffect(() => {
    if (!openBucket) return;
    refreshOverviewSilently();
  }, [openBucket, refreshOverviewSilently]);

  // Also trigger silent overview refreshes when any observed child session's status/archive/attention
  // or pending permission state changes so resolved items disappear in real time.
  const liveStateSignature = useMemo(() => {
    if (!sessionSnapshot.isMainChat) return "";
    const agentParts = sessionSnapshot.liveAgents
      .filter((agent) => !agent.isMainChat && !agent.background)
      .map(
        (agent) =>
          `${agent.serverId}:${agent.agentId}:${agent.status}:${agent.turnPhase}:${agent.archived ? 1 : 0}:${agent.attentionReason ?? ""}`,
      )
      .sort()
      .join("|");
    const permParts = sessionSnapshot.pendingPermissions
      .map(
        (entry) => `${entry.serverId}:${entry.permission.agentId}:${entry.permission.request.id}`,
      )
      .sort()
      .join("|");
    return `${agentParts}#${permParts}`;
  }, [sessionSnapshot.isMainChat, sessionSnapshot.liveAgents, sessionSnapshot.pendingPermissions]);

  useEffect(() => {
    if (prevOverviewKeyRef.current !== overviewKey) {
      prevOverviewKeyRef.current = overviewKey;
      prevLiveStateSignatureRef.current = null;
    }
    if (!sessionSnapshot.isMainChat) return;
    if (prevLiveStateSignatureRef.current === null) {
      prevLiveStateSignatureRef.current = liveStateSignature;
      return;
    }
    if (prevLiveStateSignatureRef.current === liveStateSignature) return;
    prevLiveStateSignatureRef.current = liveStateSignature;
    refreshOverviewSilently();
  }, [liveStateSignature, overviewKey, refreshOverviewSilently, sessionSnapshot.isMainChat]);
}

const MainChatActionBarDrawerContent = memo(function MainChatActionBarDrawerContent({
  serverId,
  agentId,
  openBucket,
}: {
  serverId: string;
  agentId: string;
  openBucket: ActionBarBucketKey;
}): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const openMainChatTaskTarget = useOpenMainChatTaskTarget();
  const {
    client,
    overviewKey,
    parkTask,
    startReadyTask,
    reviewTask,
    retryTaskWithFallback,
    model,
  } = useMainChatActionBarData(serverId, agentId);
  const setRouteTarget = useMainChatRouteStore((state) => state.setTarget);
  const drawerExpanded = useMainChatActionBarDrawerStore((state) =>
    Boolean(state.expandedByKey[overviewKey]),
  );
  const focusedNeedsId = useMainChatActionBarDrawerStore(
    (state) => state.focusedNeedsIdByKey?.[overviewKey] ?? null,
  );
  const consumeFocusedNeedsId = useMainChatActionBarDrawerStore(
    (state) => state.consumeFocusedNeedsId,
  );
  const closeDrawer = useMainChatActionBarDrawerStore((state) => state.closeDrawer);
  const toggleExpanded = useMainChatActionBarDrawerStore((state) => state.toggleExpanded);

  const [expandedNeedsIds, setExpandedNeedsIds] = useState<ReadonlySet<string>>(() => new Set());
  const [staleExpanded, setStaleExpanded] = useState(false);
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  useEffect(() => {
    if (openBucket === "needsYou" && focusedNeedsId) {
      setExpandedNeedsIds((prev) => {
        if (prev.has(focusedNeedsId)) return prev;
        const next = new Set(prev);
        next.add(focusedNeedsId);
        return next;
      });
      consumeFocusedNeedsId(overviewKey);
      return;
    }
    if (openBucket === "needsYou" && model && model.needsYou.length === 1) {
      const onlyId = model.needsYou[0]!.id;
      setExpandedNeedsIds((prev) => (prev.has(onlyId) ? prev : new Set([onlyId])));
    }
  }, [consumeFocusedNeedsId, focusedNeedsId, model, openBucket, overviewKey]);

  useEffect(() => {
    if (!model) return;
    if (model.counts[openBucket] === 0) {
      closeDrawer(overviewKey);
    }
  }, [closeDrawer, model, openBucket, overviewKey]);

  useEffect(() => {
    if (!isWeb || typeof window === "undefined") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeDrawer(overviewKey);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [closeDrawer, overviewKey]);

  const handleCloseDrawer = useCallback(() => {
    closeDrawer(overviewKey);
  }, [closeDrawer, overviewKey]);

  const handleToggleDrawerExpand = useCallback(() => {
    toggleExpanded(overviewKey);
  }, [overviewKey, toggleExpanded]);

  const handleDirectRoute = useCallback(
    (target: ActionBarDirectTarget) => {
      setRouteTarget(serverId, agentId, {
        targetServerId: target.serverId,
        targetAgentId: target.agentId,
        targetTitle: target.title,
      });
      closeDrawer(overviewKey);
    },
    [agentId, closeDrawer, overviewKey, serverId, setRouteTarget],
  );

  const handleToggleNeedsRow = useCallback((id: string) => {
    setExpandedNeedsIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleOpenTarget = useCallback(
    (target: {
      serverId: string;
      agentId: string;
      workspaceId?: string | null;
      title?: string | null;
      taskId?: string | null;
    }) => {
      openMainChatTaskTarget({
        serverId: target.serverId,
        agentId: target.agentId,
        workspaceId: target.workspaceId,
        title: target.title,
        taskId: target.taskId,
      });
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

  const handleParkTask = useCallback(
    (taskId: string, parked: boolean) => {
      if (!client || busyTaskId) return;
      setBusyTaskId(taskId);
      void parkTask(serverId, agentId, { taskId, parked }, client)
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
        .finally(() => {
          setBusyTaskId(null);
        });
    },
    [agentId, busyTaskId, client, parkTask, serverId, t, toast],
  );

  const handleAcceptReview = useCallback(
    (taskId: string) => {
      if (!client || busyTaskId) return;
      setBusyTaskId(taskId);
      void reviewTask(serverId, agentId, { taskId, verdict: "accept" }, client)
        .then(() => {
          toast.show(t("mainChat.actionBar.acceptedToast"), { variant: "success" });
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("mainChat.actionBar.actionFailed"),
          );
        })
        .finally(() => {
          setBusyTaskId(null);
        });
    },
    [agentId, busyTaskId, client, reviewTask, serverId, t, toast],
  );

  const handleSubmitRework = useCallback(
    (taskId: string, gapText: string) => {
      if (!client || busyTaskId) return;
      const gaps = gapText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      if (gaps.length === 0) return;
      setBusyTaskId(taskId);
      void reviewTask(serverId, agentId, { taskId, verdict: "rework", gaps, note: gapText }, client)
        .then(() => {
          toast.show(t("mainChat.actionBar.reworkSentToast"), { variant: "success" });
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("mainChat.actionBar.actionFailed"),
          );
        })
        .finally(() => {
          setBusyTaskId(null);
        });
    },
    [agentId, busyTaskId, client, reviewTask, serverId, t, toast],
  );

  const handleOpenLessons = useCallback(() => {
    closeDrawer(overviewKey);
    router.push(buildSettingsSectionRoute("main-chat"));
  }, [closeDrawer, overviewKey]);

  const handleStartReadyTask = useCallback(
    (taskId: string) => {
      if (!client || busyTaskId) return;
      setBusyTaskId(taskId);
      void startReadyTask(serverId, agentId, taskId, client)
        .then(() => {
          toast.show(t("mainChat.taskDag.startedReadyToast"), { variant: "success" });
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error ? error.message : t("mainChat.actionBar.actionFailed"),
          );
        })
        .finally(() => {
          setBusyTaskId(null);
        });
    },
    [agentId, busyTaskId, client, serverId, startReadyTask, t, toast],
  );

  const handleRetryWithFallback = useCallback(
    (taskId: string) => {
      if (!client || busyTaskId) return;
      setBusyTaskId(taskId);
      void retryTaskWithFallback(serverId, agentId, { taskId }, client)
        .then((res) => {
          toast.show(
            t("mainChat.modelProfiles.retryFallback.successToast", {
              target: res.toModelSpec ?? "",
            }),
            { variant: "success" },
          );
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : t("mainChat.modelProfiles.retryFallback.failedToast"),
          );
        })
        .finally(() => {
          setBusyTaskId(null);
        });
    },
    [agentId, busyTaskId, client, retryTaskWithFallback, serverId, t, toast],
  );

  const handleToggleStale = useCallback(() => {
    setStaleExpanded((prev) => !prev);
  }, []);

  if (!model || model.counts[openBucket] === 0) {
    return null;
  }

  return (
    <ActionBarDrawerPanel
      openBucket={openBucket}
      model={model}
      serverId={serverId}
      agentId={agentId}
      drawerExpanded={drawerExpanded}
      expandedNeedsIds={expandedNeedsIds}
      staleExpanded={staleExpanded}
      busyTaskId={busyTaskId}
      onToggleDrawerExpand={handleToggleDrawerExpand}
      onOpenLessons={handleOpenLessons}
      onClose={handleCloseDrawer}
      onToggleNeedsRow={handleToggleNeedsRow}
      onToggleStale={handleToggleStale}
      onOpenTarget={handleOpenTarget}
      onOpenTaskItem={handleOpenTaskItem}
      onDirectRoute={handleDirectRoute}
      onParkTask={handleParkTask}
      onStartReadyTask={handleStartReadyTask}
      onRetryWithFallback={handleRetryWithFallback}
      onAcceptReview={handleAcceptReview}
      onSubmitRework={handleSubmitRework}
    />
  );
});

/**
 * Floating drawer overlay for `MainChatActionBar`. Mount inside the transcript viewport container
 * (alongside `SideQuestionCard` / `AgentTracks`) so opening a bucket floats over the bottom of
 * the timeline without changing composer height or causing messages to jump.
 */
export const MainChatActionBarDrawerOverlay = memo(function MainChatActionBarDrawerOverlay({
  serverId,
  agentId,
}: {
  serverId: string;
  agentId: string;
}): ReactElement | null {
  const overviewKey = overviewStoreKey(serverId, agentId);
  const openBucket = useMainChatActionBarDrawerStore(
    (state) => state.openBucketByKey[overviewKey] ?? null,
  );

  if (!openBucket) {
    return null;
  }

  return (
    <View
      style={styles.streamDrawerOverlay}
      dataSet={CHAT_COLUMN_RAIL_DATASET}
      pointerEvents="box-none"
      testID="main-chat-action-bar-drawer-overlay"
    >
      <View
        style={styles.drawerWidthConstraint}
        pointerEvents="box-none"
        testID="main-chat-action-bar-drawer-frame"
      >
        <MainChatActionBarDrawerContent
          serverId={serverId}
          agentId={agentId}
          openBucket={openBucket}
        />
      </View>
    </View>
  );
});

/**
 * Five-state deduplicated action bar anchored directly above the Main Chat composer.
 * Stays as a compact fixed-height single-row summary bar; opening any bucket renders its panel
 * in a floating overlay without shifting the transcript or composer layout.
 */
export const MainChatActionBar = memo(function MainChatActionBar({
  serverId,
  agentId,
  drawerMode = "floating",
}: MainChatActionBarProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const isCompact = useIsCompactMainChatLayout();
  const openMainChatTaskTarget = useOpenMainChatTaskTarget();
  const { client, overviewKey, loadOverview, retryTaskWithFallback, sessionSnapshot, model } =
    useMainChatActionBarData(serverId, agentId);
  const [busyDockTaskId, setBusyDockTaskId] = useState<string | null>(null);
  const openBucket = useMainChatActionBarDrawerStore(
    (state) => state.openBucketByKey[overviewKey] ?? null,
  );
  const compactDockCollapsed = useMainChatActionBarDrawerStore((state) =>
    Boolean(state.compactDockCollapsedByKey?.[overviewKey]),
  );
  const toggleBucket = useMainChatActionBarDrawerStore((state) => state.toggleBucket);
  const openBucketWithFocus = useMainChatActionBarDrawerStore((state) => state.openBucketWithFocus);
  const setCompactDockCollapsed = useMainChatActionBarDrawerStore(
    (state) => state.setCompactDockCollapsed,
  );
  const closeDrawer = useMainChatActionBarDrawerStore((state) => state.closeDrawer);

  useMainChatActionBarSilentRefresh({
    serverId,
    agentId,
    overviewKey,
    openBucket,
    sessionSnapshot,
    client,
    loadOverview,
  });

  useEffect(() => {
    if (!model || !openBucket) return;
    if (model.counts[openBucket] === 0) {
      closeDrawer(overviewKey);
    }
  }, [closeDrawer, model, openBucket, overviewKey]);

  const handleSelectBucket = useCallback(
    (bucket: ActionBarBucketKey) => {
      toggleBucket(overviewKey, bucket);
    },
    [overviewKey, toggleBucket],
  );

  const handlePressDockNeedsYou = useCallback(
    (item: ActionBarNeedsYouItem) => {
      openBucketWithFocus(overviewKey, "needsYou", item.id);
    },
    [openBucketWithFocus, overviewKey],
  );

  const handlePressDockInProgress = useCallback(
    (item: ActionBarTaskItem) => {
      if (item.agentId) {
        openMainChatTaskTarget({
          serverId: item.serverId,
          agentId: item.agentId,
          workspaceId: item.workspaceId,
          title: item.title,
          taskId: item.taskId,
        });
        return;
      }
      openBucketWithFocus(overviewKey, "inProgress", null);
    },
    [openBucketWithFocus, openMainChatTaskTarget, overviewKey],
  );

  const handleDismissCompactDock = useCallback(() => {
    setCompactDockCollapsed(overviewKey, true);
  }, [overviewKey, setCompactDockCollapsed]);

  const handleRestoreCompactDock = useCallback(() => {
    setCompactDockCollapsed(overviewKey, false);
  }, [overviewKey, setCompactDockCollapsed]);

  const handleDockRetryWithFallback = useCallback(
    (taskId: string) => {
      if (!client || busyDockTaskId) return;
      setBusyDockTaskId(taskId);
      void retryTaskWithFallback(serverId, agentId, { taskId }, client)
        .then((res) => {
          toast.show(
            t("mainChat.modelProfiles.retryFallback.successToast", {
              target: res.toModelSpec ?? "",
            }),
            { variant: "success" },
          );
          return null;
        })
        .catch((error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : t("mainChat.modelProfiles.retryFallback.failedToast"),
          );
        })
        .finally(() => {
          setBusyDockTaskId(null);
        });
    },
    [agentId, busyDockTaskId, client, retryTaskWithFallback, serverId, t, toast],
  );

  const dockMaxRows = isCompact ? 1 : 2;
  const dockSelection = useMemo(
    () => selectCompactDockEntries(model, dockMaxRows),
    [dockMaxRows, model],
  );

  if (!model || model.counts.total === 0) {
    return null;
  }

  const visibleCapsules = (
    ["needsYou", "inProgress", "awaitingReview", "parked", "completed24h"] as const
  ).filter((bucket) => model.counts[bucket] > 0);
  const hasEligibleDock = dockSelection.entries.length > 0;
  const showCompactDock = hasEligibleDock && !compactDockCollapsed && openBucket === null;

  return (
    <View style={styles.outer} dataSet={CHAT_COLUMN_RAIL_DATASET} testID="main-chat-action-bar">
      {drawerMode === "floating" && openBucket ? (
        <View
          style={styles.floatingDrawerAnchor}
          dataSet={CHAT_COLUMN_RAIL_DATASET}
          pointerEvents="box-none"
          testID="main-chat-action-bar-drawer-overlay"
        >
          <View
            style={styles.drawerWidthConstraint}
            pointerEvents="box-none"
            testID="main-chat-action-bar-drawer-frame"
          >
            <MainChatActionBarDrawerContent
              serverId={serverId}
              agentId={agentId}
              openBucket={openBucket}
            />
          </View>
        </View>
      ) : null}

      <View style={styles.inner} testID="main-chat-action-bar-inner">
        {showCompactDock ? (
          <CompactStatusDock
            entries={dockSelection.entries}
            hiddenCount={dockSelection.hiddenCount}
            isCompact={isCompact}
            busyTaskId={busyDockTaskId}
            onPressNeedsYou={handlePressDockNeedsYou}
            onPressInProgress={handlePressDockInProgress}
            onRetryWithFallback={client ? handleDockRetryWithFallback : undefined}
            onDismiss={handleDismissCompactDock}
          />
        ) : null}

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.capsuleRow}
          testID="main-chat-action-bar-capsules"
        >
          {visibleCapsules.map((bucket) => (
            <CapsuleButton
              key={bucket}
              bucket={bucket}
              count={model.counts[bucket]}
              selected={openBucket === bucket}
              isRunning={bucket === "inProgress" && model.counts.inProgressActive > 0}
              onPress={handleSelectBucket}
            />
          ))}
          {hasEligibleDock && compactDockCollapsed && openBucket === null ? (
            <PressHighlight
              onPress={handleRestoreCompactDock}
              style={styles.compactDockRestoreBtn}
              highlightStyle={styles.rowPressed}
              accessibilityRole="button"
              accessibilityLabel={t("mainChat.actionBar.compactDockExpand")}
              testID="main-chat-compact-dock-restore"
            >
              <ThemedChevronUp size={13} uniProps={mutedIconMapping} />
            </PressHighlight>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  outer: {
    position: "relative",
    width: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingTop: theme.spacing[1],
    paddingBottom: theme.spacing[1],
    zIndex: 25,
  },
  floatingDrawerAnchor: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: "100%",
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    paddingBottom: theme.spacing[1.5],
    zIndex: 30,
  },
  streamDrawerOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: theme.spacing[2],
    alignItems: "center",
    paddingHorizontal: theme.spacing[4],
    zIndex: 25,
  },
  drawerWidthConstraint: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
  },
  inner: {
    width: "100%",
    maxWidth: theme.contentMaxWidth,
    gap: theme.spacing[1.5],
  },
  compactDockCard: {
    width: "100%",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
    ...theme.shadow.sm,
  },
  compactDockRow: {
    height: 38,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 10,
    paddingRight: theme.spacing[2],
    gap: theme.spacing[1],
  },
  compactDockRowDivider: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  compactDockRowPress: {
    flex: 1,
    minWidth: 0,
    height: "100%",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  compactDockTextRun: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    overflow: "hidden",
  },
  compactDockTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
  },
  compactDockMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 2,
    minWidth: 0,
  },
  compactDockTrailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  compactDockStatus: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  compactDockStatusNeedsYou: {
    color: theme.colors.statusWarning,
  },
  compactDockStatusFailed: {
    color: theme.colors.statusDanger,
  },
  compactDockMore: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  compactDockDismissBtn: {
    width: 24,
    height: 24,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  compactDockRestoreBtn: {
    width: 28,
    height: 30,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  capsuleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  capsule: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    height: 30,
    paddingHorizontal: 10,
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
    backgroundColor: theme.colors.surface2,
  },
  capsuleSelected: {
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.foreground,
  },
  capsuleSelectedPressed: {
    opacity: 0.88,
  },
  capsuleText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  capsuleTextSelected: {
    color: theme.colors.surface0,
    fontWeight: theme.fontWeight.semibold,
  },
  drawer: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
    maxHeight: 380,
    ...theme.shadow.lg,
  },
  drawerExpanded: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
    maxHeight: 540,
    ...theme.shadow.lg,
  },
  drawerHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 14,
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  drawerHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  drawerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  drawerScroll: {
    maxHeight: 326,
  },
  drawerScrollExpanded: {
    maxHeight: 486,
  },
  drawerScrollContentNeeds: {
    paddingHorizontal: theme.spacing[3],
    paddingTop: 2,
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[2],
  },
  drawerScrollContentLight: {
    paddingHorizontal: 14,
    paddingTop: 2,
    paddingBottom: 10,
    gap: 0,
  },
  needsCard: {
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  needsCardFailed: {
    backgroundColor: theme.colors.statusDangerTint,
  },
  needsRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
  },
  needsRowToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  needsRowTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  needsTrailingStatus: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  needsKindText: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusWarning,
  },
  needsKindTextFailed: {
    color: theme.colors.statusDanger,
  },
  inlineBody: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
    backgroundColor: theme.colors.surface1,
  },
  inlineStack: {
    gap: theme.spacing[2],
  },
  taskNeedsInline: {
    gap: theme.spacing[2],
    alignItems: "stretch",
  },
  inlineContextMeta: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  inlineDetailBlock: {
    gap: theme.spacing[0.5],
  },
  inlineDetailLabel: {
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  inlineDetailText: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
  inlineSecondaryText: {
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
  },
  inlineSuggestionText: {
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
    color: theme.colors.statusWarning,
  },
  inlineActionRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
    paddingTop: theme.spacing[0.5],
  },
  compactDockRetryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusDanger,
    backgroundColor: theme.colors.statusDangerTint,
    flexShrink: 0,
  },
  compactDockRetryText: {
    fontSize: 11,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusDanger,
  },
  inlineRetryBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusDanger,
    backgroundColor: theme.colors.statusDangerTint,
    flexShrink: 0,
  },
  inlineRetryLabel: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.statusDanger,
  },
  inlineRuleDetailBox: {
    gap: theme.spacing[0.5],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.statusWarningTint,
  },
  inlineRuleDetailText: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  taskRowListItem: {
    backgroundColor: "transparent",
    paddingVertical: 10,
    gap: 6,
  },
  taskRowDivider: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  taskRowIndented: {
    paddingLeft: theme.spacing[4],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    marginLeft: theme.spacing[2],
  },
  hierarchyBranchIcon: {
    flexShrink: 0,
    opacity: 0.75,
  },
  taskRowMain: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  taskRowPress: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
  },
  taskRowActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  inlineActionBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  inlineActionLabel: {
    fontSize: 12,
    color: theme.colors.foreground,
  },
  smallIconButton: {
    width: 26,
    height: 26,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface3,
  },
  rowTextCol: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowTitleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexWrap: "wrap",
  },
  rowTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  rowMeta: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  staleGroup: {
    gap: 0,
    paddingTop: theme.spacing[1],
  },
  staleHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  staleHeaderText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  reworkInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[1.5],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  reworkInput: {
    flex: 1,
    minWidth: 0,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    fontSize: theme.fontSize.sm,
  },
  ringWrap: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  haloNeedsYouOuter: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusWarningTint,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  haloNeedsYouInner: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusWarning,
  },
  haloFailedOuter: {
    width: 16,
    height: 16,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDangerTint,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  haloFailedInner: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDanger,
  },
  dotNeedsYou: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusWarning,
    flexShrink: 0,
  },
  dotRunning: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.statusDotRunning,
    flexShrink: 0,
  },
  dotReviewNeutral: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  dotInvertedMuted: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface0,
    flexShrink: 0,
  },
  dotMuted: {
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
    flexShrink: 0,
  },
}));
