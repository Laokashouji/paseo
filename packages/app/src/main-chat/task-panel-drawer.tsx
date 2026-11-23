import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MainChatTaskRecord } from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileDiff,
  Maximize2,
  MessageSquare,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Terminal as TerminalIcon,
  X,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { StatusRing } from "@/components/status-ring";
import { TerminalPane } from "@/components/terminal-pane";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import { EditingTextInput } from "@/components/ui/text-input";
import { HEADER_INNER_HEIGHT } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { ChangesSurface } from "@/git/diff-pane";
import { useHosts } from "@/runtime/host-runtime";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import type { WorkspaceFileOpenRequest } from "@/workspace/file-open";
import { MainChatAgentHost } from "./agent-host";
import type { MainChatDrawerTarget } from "./drawer-store";
import { useMainChatDrawerStore } from "./drawer-store";
import { useOpenMainChatTaskTarget } from "./open-task-target";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { derivePlanTaskLiveBucket } from "./selectors";

const ThemedCheckIcon = withUnistyles(CheckCircle2);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);
const ThemedFileDiff = withUnistyles(FileDiff);
const ThemedMaximize = withUnistyles(Maximize2);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedPlus = withUnistyles(Plus);
const ThemedRework = withUnistyles(RotateCcw);
const ThemedTerminal = withUnistyles(TerminalIcon);
const ThemedX = withUnistyles(X);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function renderChatTabIcon(props: { color: string; size: number }) {
  return <MessageSquare color={props.color} size={props.size} />;
}

function renderDiffTabIcon(props: { color: string; size: number }) {
  return <FileDiff color={props.color} size={props.size} />;
}

function renderTerminalTabIcon(props: { color: string; size: number }) {
  return <TerminalIcon color={props.color} size={props.size} />;
}

export type TaskDrawerSegment = "chat" | "diff" | "terminal";

export interface TaskDrawerAgentTab {
  agentId: string;
  isActive: boolean;
  isSelected: boolean;
}

export function resolveTaskRecordForDrawer(
  tasks: readonly MainChatTaskRecord[] | undefined,
  target: Pick<MainChatDrawerTarget, "agentId" | "taskId">,
): MainChatTaskRecord | null {
  if (!tasks || tasks.length === 0) return null;
  if (target.taskId) {
    const byId = tasks.find((task) => task.id === target.taskId);
    if (byId) return byId;
  }
  const byActive = tasks.find((task) => task.activeAgentId === target.agentId);
  if (byActive) return byActive;
  const byLineage = tasks.find((task) => task.agentIds.includes(target.agentId));
  return byLineage ?? null;
}

export function buildTaskDrawerAgentTabs(
  task: MainChatTaskRecord | null,
  selectedAgentId: string,
): TaskDrawerAgentTab[] {
  if (!task) return [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  const addId = (id: string | null | undefined) => {
    const trimmed = id?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };
  if (task.activeAgentId) addId(task.activeAgentId);
  for (let i = task.agentIds.length - 1; i >= 0; i -= 1) {
    addId(task.agentIds[i]);
  }
  if (ordered.length < 2) return [];
  return ordered.map((agentId) => ({
    agentId,
    isActive: task.activeAgentId === agentId,
    isSelected: selectedAgentId === agentId,
  }));
}

export interface TaskPanelDrawerProps {
  target: MainChatDrawerTarget;
  mainServerId?: string | null;
  mainAgentId?: string | null;
  taskRecord?: MainChatTaskRecord | null;
  isFocused: boolean;
  onFocus: () => void;
}

function directoryBasename(dirPath: string): string {
  const trimmed = dirPath.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

type SessionStoreState = ReturnType<typeof useSessionStore.getState>;

function countPendingPermissionsForAgent(
  session: SessionStoreState["sessions"][string] | undefined,
  agentId: string,
  agentPendingCount: number,
): number {
  if (!session) return agentPendingCount;
  let counted = 0;
  for (const perm of session.pendingPermissions.values()) {
    if (perm.agentId === agentId) counted += 1;
  }
  return Math.max(counted, agentPendingCount);
}

function resolveDrawerWorkspaceName(
  session: SessionStoreState["sessions"][string] | undefined,
  workspaceId: string | null,
  agentCwd: string | undefined,
): string | null {
  const workspace = workspaceId ? session?.workspaces.get(workspaceId) : undefined;
  const trimmedName = workspace?.name?.trim();
  if (trimmedName) return trimmedName;
  const trimmedProject = workspace?.projectDisplayName?.trim();
  if (trimmedProject) return trimmedProject;
  return agentCwd ? directoryBasename(agentCwd) : null;
}

function selectDrawerAgentMeta(state: SessionStoreState, target: MainChatDrawerTarget) {
  const session = state.sessions[target.serverId];
  const agent = session?.agents.get(target.agentId) ?? session?.agentDetails.get(target.agentId);
  const pendingCount = countPendingPermissionsForAgent(
    session,
    target.agentId,
    agent?.pendingPermissions.length ?? 0,
  );
  const workspaceId = agent?.workspaceId ?? target.workspaceId ?? null;
  const workspace = workspaceId ? session?.workspaces.get(workspaceId) : undefined;
  const cwd = agent?.cwd || workspace?.workspaceDirectory || null;
  return {
    title: agent?.title?.trim() || target.title || null,
    workspaceId,
    cwd,
    workspaceName: resolveDrawerWorkspaceName(session, workspaceId, agent?.cwd),
    bucket: derivePlanTaskLiveBucket(agent, pendingCount),
  };
}

function selectAgentTitlesById(
  state: SessionStoreState,
  serverId: string,
  agentIds: readonly string[],
): Record<string, string> {
  const session = state.sessions[serverId];
  const titles: Record<string, string> = {};
  for (const agentId of agentIds) {
    const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
    if (agent?.title?.trim()) {
      titles[agentId] = agent.title.trim();
    }
  }
  return titles;
}

function DrawerStatusMark({ bucket }: { bucket: SidebarStateBucket | null }) {
  if (!bucket) return <View style={styles.dotDone} />;
  if (bucket === "running") {
    return (
      <View style={styles.ringWrap}>
        <StatusRing />
      </View>
    );
  }
  switch (bucket) {
    case "needs_input":
      return <View style={styles.dotNeedsInput} />;
    case "failed":
      return <View style={styles.dotFailed} />;
    case "attention":
      return <View style={styles.dotAttention} />;
    case "done":
      return <View style={styles.dotDone} />;
  }
}

const DrawerBriefStrip = memo(function DrawerBriefStrip({
  task,
  expanded,
  onToggle,
}: {
  task: MainChatTaskRecord;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const summaryParts = [
    t("mainChat.planCard.briefRevisionBadge", { revision: task.brief.scopeRevision }),
    task.brief.doneWhen.length > 0
      ? t("mainChat.drawer.doneWhenCount", { count: task.brief.doneWhen.length })
      : null,
    task.expectedMinutes
      ? t("mainChat.planCard.expectedMinutesShort", { minutes: task.expectedMinutes })
      : null,
  ].filter(Boolean);

  return (
    <View style={styles.briefBox} testID="main-chat-task-drawer-brief">
      <PressHighlight
        onPress={onToggle}
        style={styles.briefHeader}
        highlightStyle={styles.actionPressed}
        accessibilityRole="button"
        accessibilityLabel={t("mainChat.drawer.briefToggleLabel")}
        testID="main-chat-task-drawer-brief-toggle"
      >
        {expanded ? (
          <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
        ) : (
          <ThemedChevronRight size={13} uniProps={mutedIconMapping} />
        )}
        <Text style={styles.briefSummaryText} numberOfLines={1}>
          {summaryParts.join(" · ")}
        </Text>
      </PressHighlight>

      {expanded ? (
        <View style={styles.briefDetails} testID="main-chat-task-drawer-brief-details">
          {task.brief.goal ? <Text style={styles.briefGoal}>{task.brief.goal}</Text> : null}
          {task.brief.doneWhen.length > 0 ? (
            <View style={styles.briefList}>
              <Text style={styles.briefListHeading}>{t("mainChat.planCard.doneWhenHeading")}</Text>
              {task.brief.doneWhen.map((item) => (
                <Text key={item} style={styles.briefListItem}>
                  • {item}
                </Text>
              ))}
            </View>
          ) : null}
          {task.brief.outOfBounds.length > 0 ? (
            <View style={styles.briefList}>
              <Text style={styles.briefListHeading}>
                {t("mainChat.planCard.outOfBoundsHeading")}
              </Text>
              {task.brief.outOfBounds.map((item) => (
                <Text key={item} style={styles.briefListItem}>
                  • {item}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const DrawerAgentTabChip = memo(function DrawerAgentTabChip({
  tab,
  display,
  onSelectAgent,
}: {
  tab: TaskDrawerAgentTab;
  display: string;
  onSelectAgent: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onSelectAgent(tab.agentId);
  }, [onSelectAgent, tab.agentId]);

  return (
    <PressHighlight
      onPress={handlePress}
      style={[styles.agentTab, tab.isSelected && styles.agentTabSelected]}
      highlightStyle={styles.actionPressed}
      accessibilityRole="button"
      accessibilityLabel={display}
      testID={`main-chat-task-drawer-agent-tab-${tab.agentId}`}
    >
      <Text
        style={[styles.agentTabLabel, tab.isSelected && styles.agentTabLabelSelected]}
        numberOfLines={1}
      >
        {display}
      </Text>
      <StatusBadge
        size="xs"
        variant={tab.isActive ? "success" : "muted"}
        label={
          tab.isActive
            ? t("mainChat.drawer.activeAgentBadge")
            : t("mainChat.drawer.historicalAgentBadge")
        }
      />
    </PressHighlight>
  );
});

const DrawerAgentSwitcher = memo(function DrawerAgentSwitcher({
  tabs,
  titlesById,
  onSelectAgent,
}: {
  tabs: readonly TaskDrawerAgentTab[];
  titlesById: Readonly<Record<string, string>>;
  onSelectAgent: (agentId: string) => void;
}) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.agentSwitcherScroll}
      contentContainerStyle={styles.agentSwitcherContent}
      testID="main-chat-task-drawer-agent-switcher"
    >
      {tabs.map((tab, index) => (
        <DrawerAgentTabChip
          key={tab.agentId}
          tab={tab}
          display={titlesById[tab.agentId] || `#${index + 1} (${tab.agentId.slice(0, 8)})`}
          onSelectAgent={onSelectAgent}
        />
      ))}
    </ScrollView>
  );
});

interface TerminalListEntry {
  id: string;
  name: string;
}

const TerminalTabChip = memo(function TerminalTabChip({
  term,
  selected,
  onSelect,
}: {
  term: TerminalListEntry;
  selected: boolean;
  onSelect: (terminalId: string) => void;
}) {
  const handlePress = useCallback(() => {
    onSelect(term.id);
  }, [onSelect, term.id]);

  return (
    <PressHighlight
      onPress={handlePress}
      style={[styles.agentTab, selected && styles.agentTabSelected]}
      highlightStyle={styles.actionPressed}
    >
      <Text
        style={[styles.agentTabLabel, selected && styles.agentTabLabelSelected]}
        numberOfLines={1}
      >
        {term.name}
      </Text>
    </PressHighlight>
  );
});

function pickNextTerminalId(
  currentId: string | null,
  list: readonly TerminalListEntry[],
): string | null {
  if (currentId && list.some((item) => item.id === currentId)) {
    return currentId;
  }
  return list[0]?.id ?? null;
}

function prependTerminalEntry(
  prev: readonly TerminalListEntry[],
  created: TerminalListEntry,
): TerminalListEntry[] {
  return [created, ...prev.filter((item) => item.id !== created.id)];
}

const DrawerTerminalSegment = memo(function DrawerTerminalSegment({
  serverId,
  workspaceId,
  cwd,
  agentId,
  client,
  isFocused,
  onOpenFullPage,
}: {
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  agentId: string;
  client: DaemonClient | null;
  isFocused: boolean;
  onOpenFullPage: () => void;
}) {
  const { t } = useTranslation();
  const [terminals, setTerminals] = useState<TerminalListEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFailedMessage = t("mainChat.drawer.terminalLoadFailed");

  useEffect(() => {
    if (!client || !cwd) return;
    let cancelled = false;
    const loadTerminals = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await client.listTerminals(cwd, undefined, {
          workspaceId: workspaceId || undefined,
        });
        if (cancelled) return;
        const list: TerminalListEntry[] = [];
        for (const entry of res.terminals) {
          list.push({
            id: entry.id,
            name: entry.title?.trim() || entry.name?.trim() || entry.id,
          });
        }
        setTerminals(list);
        setSelectedId((prev) => pickNextTerminalId(prev, list));
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : loadFailedMessage);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void loadTerminals();
    return () => {
      cancelled = true;
    };
  }, [client, cwd, loadFailedMessage, workspaceId]);

  const handleCreateTerminal = useCallback(() => {
    if (!client || !cwd || creating) return;
    const create = async () => {
      setCreating(true);
      setError(null);
      try {
        const res = await client.createTerminal(cwd, undefined, undefined, {
          agentId,
          workspaceId: workspaceId || undefined,
        });
        if (res.error || !res.terminal) {
          throw new Error(res.error ?? t("mainChat.drawer.terminalCreateFailed"));
        }
        const created: TerminalListEntry = {
          id: res.terminal.id,
          name: res.terminal.title?.trim() || res.terminal.name?.trim() || res.terminal.id,
        };
        setTerminals((prev) => prependTerminalEntry(prev, created));
        setSelectedId(created.id);
      } catch (err) {
        setError(err instanceof Error ? err.message : t("mainChat.drawer.terminalCreateFailed"));
      } finally {
        setCreating(false);
      }
    };
    void create();
  }, [agentId, client, creating, cwd, t, workspaceId]);

  const handleOpenWorkspaceFile = useCallback(
    (request: WorkspaceFileOpenRequest) => {
      if (!workspaceId) return;
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "file", path: request.location.path },
      });
    },
    [serverId, workspaceId],
  );

  if (!cwd || !client) {
    return (
      <View style={styles.segmentFallback} testID="main-chat-task-drawer-terminal-fallback">
        <ThemedTerminal size={22} uniProps={mutedIconMapping} />
        <Text style={styles.fallbackText}>{t("mainChat.drawer.terminalUnavailable")}</Text>
        <Button variant="outline" size="sm" onPress={onOpenFullPage}>
          {t("mainChat.drawer.openInWorkspace")}
        </Button>
      </View>
    );
  }

  if (!selectedId) {
    return (
      <View style={styles.segmentFallback} testID="main-chat-task-drawer-terminal-empty">
        <ThemedTerminal size={22} uniProps={mutedIconMapping} />
        <Text style={styles.fallbackText}>
          {loading
            ? t("mainChat.drawer.terminalLoading")
            : (error ?? t("mainChat.drawer.terminalEmpty"))}
        </Text>
        <View style={styles.fallbackActions}>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={ThemedPlus}
            loading={creating}
            disabled={creating}
            onPress={handleCreateTerminal}
            testID="main-chat-task-drawer-terminal-create"
          >
            {t("mainChat.drawer.newTerminal")}
          </Button>
          <Button variant="outline" size="sm" onPress={onOpenFullPage}>
            {t("mainChat.drawer.openInWorkspace")}
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.segmentBody} testID="main-chat-task-drawer-terminal-pane">
      {terminals.length > 1 ? (
        <View style={styles.terminalBar}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View style={styles.terminalTabRow}>
              {terminals.map((term) => (
                <TerminalTabChip
                  key={term.id}
                  term={term}
                  selected={term.id === selectedId}
                  onSelect={setSelectedId}
                />
              ))}
            </View>
          </ScrollView>
        </View>
      ) : null}
      <RetainedPanelActivity active>
        <TerminalPane
          serverId={serverId}
          cwd={cwd}
          terminalId={selectedId}
          isWorkspaceFocused
          isPaneFocused={isFocused}
          onOpenFileExplorer={onOpenFullPage}
          onOpenWorkspaceFile={handleOpenWorkspaceFile}
        />
      </RetainedPanelActivity>
    </View>
  );
});

const DrawerDiffSegment = memo(function DrawerDiffSegment({
  serverId,
  workspaceId,
  cwd,
  onOpenFullPage,
}: {
  serverId: string;
  workspaceId: string;
  cwd: string | null;
  onOpenFullPage: () => void;
}) {
  const { t } = useTranslation();

  const handleOpenFile = useCallback(
    (path: string) => {
      if (!workspaceId) return;
      navigateToWorkspace({
        serverId,
        workspaceId,
        target: { kind: "file", path },
      });
    },
    [serverId, workspaceId],
  );

  if (!cwd || !workspaceId) {
    return (
      <View style={styles.segmentFallback} testID="main-chat-task-drawer-diff-fallback">
        <ThemedFileDiff size={22} uniProps={mutedIconMapping} />
        <Text style={styles.fallbackText}>{t("mainChat.drawer.diffUnavailable")}</Text>
        <Button variant="outline" size="sm" onPress={onOpenFullPage}>
          {t("mainChat.drawer.openInWorkspace")}
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.segmentBody} testID="main-chat-task-drawer-diff-pane">
      <RetainedPanelActivity active>
        <ChangesSurface
          serverId={serverId}
          workspaceId={workspaceId}
          cwd={cwd}
          enabled
          presentation="combined"
          onOpenFile={handleOpenFile}
        />
      </RetainedPanelActivity>
    </View>
  );
});

const DrawerHeader = memo(function DrawerHeader({
  bucket,
  displayTitle,
  subtitle,
  matchedTask,
  canManageTask,
  isMutatingTask,
  onTogglePark,
  onOpenFullPage,
  onClose,
}: {
  bucket: SidebarStateBucket | null;
  displayTitle: string;
  subtitle: string;
  matchedTask: MainChatTaskRecord | null;
  canManageTask: boolean;
  isMutatingTask: boolean;
  onTogglePark: () => void;
  onOpenFullPage: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const isParked = matchedTask?.status === "parked";
  const parkLabel = isParked
    ? t("mainChat.actionBar.resumeAction")
    : t("mainChat.actionBar.pauseAction");

  return (
    <View style={styles.header}>
      <View style={styles.headerLeft}>
        <DrawerStatusMark bucket={bucket} />
        <View style={styles.titleBlock}>
          <View style={styles.titleRow}>
            <Text style={styles.title} numberOfLines={1} testID="main-chat-task-drawer-title">
              {displayTitle}
            </Text>
            {matchedTask?.status === "awaiting_review" ? (
              <StatusBadge
                size="xs"
                variant="muted"
                label={t("mainChat.actionBar.panelAwaitingReview")}
              />
            ) : null}
            {isParked ? (
              <StatusBadge size="xs" variant="muted" label={t("mainChat.actionBar.panelParked")} />
            ) : null}
          </View>
          <Text style={styles.subtitle} numberOfLines={1} testID="main-chat-task-drawer-subtitle">
            {subtitle}
          </Text>
        </View>
      </View>

      <View style={styles.headerActions}>
        {canManageTask && matchedTask ? (
          <PressHighlight
            onPress={onTogglePark}
            disabled={isMutatingTask}
            style={styles.actionChip}
            highlightStyle={styles.actionPressed}
            accessibilityRole="button"
            accessibilityLabel={parkLabel}
            testID="main-chat-task-drawer-park-toggle"
          >
            {isParked ? (
              <ThemedPlay size={12} uniProps={mutedIconMapping} />
            ) : (
              <ThemedPause size={12} uniProps={mutedIconMapping} />
            )}
            <Text style={styles.fullPageLabel} numberOfLines={1}>
              {parkLabel}
            </Text>
          </PressHighlight>
        ) : null}

        <PressHighlight
          onPress={onOpenFullPage}
          style={styles.fullPageButton}
          highlightStyle={styles.actionPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.drawer.openFullPage")}
          testID="main-chat-task-drawer-open-full-page"
        >
          <ThemedMaximize size={13} uniProps={mutedIconMapping} />
          <Text style={styles.fullPageLabel} numberOfLines={1}>
            {t("mainChat.drawer.openFullPage")}
          </Text>
        </PressHighlight>
        <PressHighlight
          onPress={onClose}
          style={styles.closeButton}
          highlightStyle={styles.actionPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.drawer.close")}
          testID="main-chat-task-drawer-close"
        >
          <ThemedX size={15} uniProps={mutedIconMapping} />
        </PressHighlight>
      </View>
    </View>
  );
});

const DrawerReviewStrip = memo(function DrawerReviewStrip({
  isMutatingTask,
  reworkOpen,
  reworkDraft,
  onAcceptReview,
  onToggleRework,
  onChangeReworkDraft,
  onConfirmRework,
}: {
  isMutatingTask: boolean;
  reworkOpen: boolean;
  reworkDraft: string;
  onAcceptReview: () => void;
  onToggleRework: () => void;
  onChangeReworkDraft: (text: string) => void;
  onConfirmRework: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.reviewStrip} testID="main-chat-task-drawer-review-bar">
      <View style={styles.reviewStripRow}>
        <Text style={styles.reviewStripText} numberOfLines={1}>
          {t("mainChat.drawer.awaitingReviewBanner")}
        </Text>
        <View style={styles.reviewActions}>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={ThemedCheckIcon}
            loading={isMutatingTask}
            disabled={isMutatingTask}
            onPress={onAcceptReview}
            testID="main-chat-task-drawer-accept"
          >
            {t("mainChat.actionBar.acceptAction")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            leftIcon={ThemedRework}
            disabled={isMutatingTask}
            onPress={onToggleRework}
            testID="main-chat-task-drawer-rework-toggle"
          >
            {t("mainChat.actionBar.reworkAction")}
          </Button>
        </View>
      </View>
      {reworkOpen ? (
        <View style={styles.reworkRow}>
          <EditingTextInput
            initialValue={reworkDraft}
            onChangeText={onChangeReworkDraft}
            style={styles.reworkInput}
            placeholder={t("mainChat.actionBar.reworkPlaceholder")}
            testID="main-chat-task-drawer-rework-input"
          />
          <Button
            variant="default"
            size="sm"
            loading={isMutatingTask}
            disabled={isMutatingTask || reworkDraft.trim().length === 0}
            onPress={onConfirmRework}
            testID="main-chat-task-drawer-rework-submit"
          >
            {t("mainChat.actionBar.reworkConfirm")}
          </Button>
        </View>
      ) : null}
    </View>
  );
});

const DrawerSegmentBody = memo(function DrawerSegmentBody({
  activeSegment,
  target,
  resolvedWorkspaceId,
  resolvedCwd,
  targetClient,
  isFocused,
  onFocus,
  onOpenNestedAgent,
  onOpenFullPage,
}: {
  activeSegment: TaskDrawerSegment;
  target: MainChatDrawerTarget;
  resolvedWorkspaceId: string;
  resolvedCwd: string | null;
  targetClient: DaemonClient | null;
  isFocused: boolean;
  onFocus: () => void;
  onOpenNestedAgent: (nested: { serverId: string; agentId: string }) => void;
  onOpenFullPage: () => void;
}) {
  if (activeSegment === "chat") {
    return (
      <MainChatAgentHost
        key={`${target.serverId}:${target.agentId}`}
        sourceId={`main-chat-drawer:${target.serverId}:${target.agentId}`}
        serverId={target.serverId}
        workspaceId={resolvedWorkspaceId}
        agentId={target.agentId}
        isFocused={isFocused}
        onFocusPane={onFocus}
        onOpenAgentTarget={onOpenNestedAgent}
      />
    );
  }
  if (activeSegment === "diff") {
    return (
      <DrawerDiffSegment
        serverId={target.serverId}
        workspaceId={resolvedWorkspaceId}
        cwd={resolvedCwd}
        onOpenFullPage={onOpenFullPage}
      />
    );
  }
  return (
    <DrawerTerminalSegment
      serverId={target.serverId}
      workspaceId={resolvedWorkspaceId}
      cwd={resolvedCwd}
      agentId={target.agentId}
      client={targetClient}
      isFocused={isFocused}
      onOpenFullPage={onOpenFullPage}
    />
  );
});

function useTaskDrawerMutations({
  matchedTask,
  resolvedMainServerId,
  mainAgentId,
  mainClient,
}: {
  matchedTask: MainChatTaskRecord | null;
  resolvedMainServerId: string;
  mainAgentId: string | null | undefined;
  mainClient: DaemonClient | null;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const parkTask = useMainChatOverviewStore((state) => state.parkTask);
  const reviewTask = useMainChatOverviewStore((state) => state.reviewTask);
  const [reworkOpen, setReworkOpen] = useState(false);
  const [reworkDraft, setReworkDraft] = useState("");
  const [isMutatingTask, setIsMutatingTask] = useState(false);

  const handleToggleRework = useCallback(() => {
    setReworkOpen((prev) => !prev);
  }, []);

  const handleTogglePark = useCallback(() => {
    if (!matchedTask || !mainClient || !mainAgentId || isMutatingTask) return;
    const nextParked = matchedTask.status !== "parked";
    setIsMutatingTask(true);
    void parkTask(
      resolvedMainServerId,
      mainAgentId,
      { taskId: matchedTask.id, parked: nextParked },
      mainClient,
    )
      .then(() => {
        toast.show(
          nextParked ? t("mainChat.actionBar.pausedToast") : t("mainChat.actionBar.resumedToast"),
          { variant: "success" },
        );
        return null;
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t("mainChat.actionBar.actionFailed"));
      })
      .finally(() => {
        setIsMutatingTask(false);
      });
  }, [
    isMutatingTask,
    mainAgentId,
    mainClient,
    matchedTask,
    parkTask,
    resolvedMainServerId,
    t,
    toast,
  ]);

  const handleAcceptReview = useCallback(() => {
    if (!matchedTask || !mainClient || !mainAgentId || isMutatingTask) return;
    setIsMutatingTask(true);
    void reviewTask(
      resolvedMainServerId,
      mainAgentId,
      { taskId: matchedTask.id, verdict: "accept" },
      mainClient,
    )
      .then(() => {
        toast.show(t("mainChat.actionBar.acceptedToast"), { variant: "success" });
        return null;
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t("mainChat.actionBar.actionFailed"));
      })
      .finally(() => {
        setIsMutatingTask(false);
      });
  }, [
    isMutatingTask,
    mainAgentId,
    mainClient,
    matchedTask,
    resolvedMainServerId,
    reviewTask,
    t,
    toast,
  ]);

  const handleConfirmRework = useCallback(() => {
    if (!matchedTask || !mainClient || !mainAgentId || isMutatingTask) return;
    const trimmed = reworkDraft.trim();
    if (!trimmed) return;
    setIsMutatingTask(true);
    void reviewTask(
      resolvedMainServerId,
      mainAgentId,
      {
        taskId: matchedTask.id,
        verdict: "rework",
        gaps: trimmed
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean),
        note: trimmed,
      },
      mainClient,
    )
      .then(() => {
        setReworkDraft("");
        setReworkOpen(false);
        toast.show(t("mainChat.actionBar.reworkSentToast"), { variant: "success" });
        return null;
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t("mainChat.actionBar.actionFailed"));
      })
      .finally(() => {
        setIsMutatingTask(false);
      });
  }, [
    isMutatingTask,
    mainAgentId,
    mainClient,
    matchedTask,
    resolvedMainServerId,
    reviewTask,
    reworkDraft,
    t,
    toast,
  ]);

  return {
    reworkOpen,
    reworkDraft,
    setReworkDraft,
    isMutatingTask,
    handleToggleRework,
    handleTogglePark,
    handleAcceptReview,
    handleConfirmRework,
  };
}

function resolveTaskDrawerFlags(
  matchedTask: MainChatTaskRecord | null,
  mainClient: DaemonClient | null,
  mainAgentId: string | null | undefined,
): { canManageTask: boolean; showReviewStrip: boolean } {
  if (!matchedTask || !mainClient || !mainAgentId) {
    return { canManageTask: false, showReviewStrip: false };
  }
  const status = matchedTask.status;
  return {
    canManageTask: status !== "completed" && status !== "cancelled",
    showReviewStrip: status === "awaiting_review",
  };
}

function resolveTaskDrawerViewData(input: {
  target: MainChatDrawerTarget;
  matchedTask: MainChatTaskRecord | null;
  meta: ReturnType<typeof selectDrawerAgentMeta>;
  hosts: readonly { serverId: string; label: string }[];
  mainClient: DaemonClient | null;
  mainAgentId: string | null | undefined;
  titleFallback: string;
}) {
  const { target, matchedTask, meta, hosts, mainClient, mainAgentId, titleFallback } = input;
  const hostEntry = hosts.find((host) => host.serverId === target.serverId);
  const rawTaskHost = matchedTask?.hostLabel ?? "";
  const taskHostLabel = rawTaskHost.trim();
  const hostLabel = taskHostLabel || hostEntry?.label || target.serverId;
  const displayTitle = (matchedTask ? matchedTask.title : "") || meta.title || titleFallback;
  const resolvedWorkspaceId =
    meta.workspaceId ?? (matchedTask ? matchedTask.workspaceId : null) ?? "";
  const resolvedCwd = meta.cwd ?? (matchedTask ? matchedTask.cwd : null);
  const workspaceDisplay = meta.workspaceName ?? (matchedTask ? matchedTask.workspaceLabel : null);
  const subtitle = workspaceDisplay ? `${hostLabel} · ${workspaceDisplay}` : hostLabel;
  const flags = resolveTaskDrawerFlags(matchedTask, mainClient, mainAgentId);

  return {
    displayTitle,
    resolvedWorkspaceId,
    resolvedCwd,
    subtitle,
    canManageTask: flags.canManageTask,
    showReviewStrip: flags.showReviewStrip,
  };
}

/**
 * Wide-screen side-by-side task inspection drawer rendered beside the Main Chat column.
 * Supports matched `MainChatTaskRecord` Brief summary, status controls (pause/resume, accept/rework),
 * multi-agent lineage switching, and lightweight inline Chat / Diff / Terminal segments without
 * leaking workspace chrome into the Main Chat column.
 */
export const TaskPanelDrawer = memo(function TaskPanelDrawer({
  target,
  mainServerId,
  mainAgentId,
  taskRecord,
  isFocused,
  onFocus,
}: TaskPanelDrawerProps): ReactElement {
  const { t } = useTranslation();
  const hosts = useHosts();
  const closeDrawer = useMainChatDrawerStore((state) => state.closeDrawer);
  const openDrawerTask = useMainChatDrawerStore((state) => state.openTask);
  const openTask = useOpenMainChatTaskTarget();

  const resolvedMainServerId = mainServerId ?? target.serverId;
  const overviewKey = mainAgentId ? overviewStoreKey(resolvedMainServerId, mainAgentId) : null;
  const overviewTasks = useMainChatOverviewStore((state) =>
    overviewKey ? state.overviewsByKey[overviewKey]?.tasks : undefined,
  );
  const mainClient = useSessionStore(
    (state) => state.sessions[resolvedMainServerId]?.client ?? null,
  );
  const targetClient = useSessionStore((state) => state.sessions[target.serverId]?.client ?? null);

  const matchedTask = useMemo(
    () => taskRecord ?? resolveTaskRecordForDrawer(overviewTasks, target),
    [overviewTasks, target, taskRecord],
  );

  const meta = useStoreWithEqualityFn(
    useSessionStore,
    useCallback((state) => selectDrawerAgentMeta(state, target), [target]),
    equal,
  );

  const agentTabs = useMemo(
    () => buildTaskDrawerAgentTabs(matchedTask, target.agentId),
    [matchedTask, target.agentId],
  );
  const agentTabIds = useMemo(() => agentTabs.map((tab) => tab.agentId), [agentTabs]);
  const agentTitlesById = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) => selectAgentTitlesById(state, target.serverId, agentTabIds),
      [agentTabIds, target.serverId],
    ),
    equal,
  );

  const [activeSegment, setActiveSegment] = useState<TaskDrawerSegment>("chat");
  const [briefExpanded, setBriefExpanded] = useState(false);

  const mutations = useTaskDrawerMutations({
    matchedTask,
    resolvedMainServerId,
    mainAgentId,
    mainClient,
  });

  const viewData = resolveTaskDrawerViewData({
    target,
    matchedTask,
    meta,
    hosts,
    mainClient,
    mainAgentId,
    titleFallback: t("mainChat.drawer.titleFallback"),
  });

  const segmentOptions = useMemo<SegmentedControlOption<TaskDrawerSegment>[]>(
    () => [
      {
        value: "chat",
        label: t("mainChat.drawer.tabChat"),
        icon: renderChatTabIcon,
        testID: "main-chat-task-drawer-tab-chat",
      },
      {
        value: "diff",
        label: t("mainChat.drawer.tabDiff"),
        icon: renderDiffTabIcon,
        testID: "main-chat-task-drawer-tab-diff",
      },
      {
        value: "terminal",
        label: t("mainChat.drawer.tabTerminal"),
        icon: renderTerminalTabIcon,
        testID: "main-chat-task-drawer-tab-terminal",
      },
    ],
    [t],
  );

  const resolvedTaskId = matchedTask?.id ?? target.taskId;
  const resolvedWorkspaceParam = viewData.resolvedWorkspaceId || null;

  const handleOpenFullPage = useCallback(() => {
    openTask({
      serverId: target.serverId,
      agentId: target.agentId,
      workspaceId: resolvedWorkspaceParam,
      title: viewData.displayTitle,
      taskId: resolvedTaskId,
      forceFullPage: true,
    });
  }, [
    openTask,
    resolvedTaskId,
    resolvedWorkspaceParam,
    target.agentId,
    target.serverId,
    viewData.displayTitle,
  ]);

  const handleOpenNestedAgent = useCallback(
    (nested: { serverId: string; agentId: string }) => {
      openTask({ serverId: nested.serverId, agentId: nested.agentId });
    },
    [openTask],
  );

  const handleSelectAgentTab = useCallback(
    (nextAgentId: string) => {
      if (nextAgentId === target.agentId) return;
      openDrawerTask({
        serverId: target.serverId,
        agentId: nextAgentId,
        workspaceId: resolvedWorkspaceParam,
        title: viewData.displayTitle,
        taskId: resolvedTaskId,
      });
    },
    [
      openDrawerTask,
      resolvedTaskId,
      resolvedWorkspaceParam,
      target.agentId,
      target.serverId,
      viewData.displayTitle,
    ],
  );

  const handleToggleBrief = useCallback(() => {
    setBriefExpanded((prev) => !prev);
  }, []);

  const handleResponderCapture = useCallback(() => {
    onFocus();
    return false;
  }, [onFocus]);

  return (
    <View
      style={styles.drawer}
      onStartShouldSetResponderCapture={handleResponderCapture}
      testID="main-chat-task-drawer"
    >
      <DrawerHeader
        bucket={meta.bucket}
        displayTitle={viewData.displayTitle}
        subtitle={viewData.subtitle}
        matchedTask={matchedTask}
        canManageTask={viewData.canManageTask}
        isMutatingTask={mutations.isMutatingTask}
        onTogglePark={mutations.handleTogglePark}
        onOpenFullPage={handleOpenFullPage}
        onClose={closeDrawer}
      />

      {viewData.showReviewStrip ? (
        <DrawerReviewStrip
          isMutatingTask={mutations.isMutatingTask}
          reworkOpen={mutations.reworkOpen}
          reworkDraft={mutations.reworkDraft}
          onAcceptReview={mutations.handleAcceptReview}
          onToggleRework={mutations.handleToggleRework}
          onChangeReworkDraft={mutations.setReworkDraft}
          onConfirmRework={mutations.handleConfirmRework}
        />
      ) : null}

      {matchedTask ? (
        <DrawerBriefStrip
          task={matchedTask}
          expanded={briefExpanded}
          onToggle={handleToggleBrief}
        />
      ) : null}

      {agentTabs.length > 1 ? (
        <DrawerAgentSwitcher
          tabs={agentTabs}
          titlesById={agentTitlesById}
          onSelectAgent={handleSelectAgentTab}
        />
      ) : null}

      <View style={styles.segmentBar}>
        <SegmentedControl
          size="sm"
          options={segmentOptions}
          value={activeSegment}
          onValueChange={setActiveSegment}
          testID="main-chat-task-drawer-segments"
        />
      </View>

      <View style={styles.body}>
        <DrawerSegmentBody
          activeSegment={activeSegment}
          target={target}
          resolvedWorkspaceId={viewData.resolvedWorkspaceId}
          resolvedCwd={viewData.resolvedCwd}
          targetClient={targetClient}
          isFocused={isFocused}
          onFocus={onFocus}
          onOpenNestedAgent={handleOpenNestedAgent}
          onOpenFullPage={handleOpenFullPage}
        />
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => {
  const dot = (bucket: Exclude<SidebarStateBucket, "running">) => ({
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket, showDoneAsInactive: false }) ?? undefined,
    flexShrink: 0,
  });

  return {
    drawer: {
      width: "42%",
      minWidth: 340,
      maxWidth: 640,
      borderLeftWidth: theme.borderWidth[1],
      borderLeftColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
      flexDirection: "column",
      minHeight: 0,
    },
    header: {
      height: HEADER_INNER_HEIGHT,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing[2],
      paddingHorizontal: theme.spacing[3],
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    headerLeft: {
      flex: 1,
      minWidth: 0,
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    titleBlock: {
      flex: 1,
      minWidth: 0,
      gap: 1,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
    },
    title: {
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      flexShrink: 1,
    },
    subtitle: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      flexShrink: 0,
    },
    actionChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      paddingHorizontal: theme.spacing[2],
      paddingVertical: theme.spacing[1],
      borderRadius: theme.borderRadius.md,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
    },
    fullPageButton: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1],
      paddingHorizontal: theme.spacing[2],
      paddingVertical: theme.spacing[1],
      borderRadius: theme.borderRadius.md,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
    },
    fullPageLabel: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    closeButton: {
      width: 28,
      height: 28,
      borderRadius: theme.borderRadius.md,
      alignItems: "center",
      justifyContent: "center",
    },
    actionPressed: {
      backgroundColor: theme.colors.surface2,
    },
    reviewStrip: {
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      gap: theme.spacing[2],
    },
    reviewStripRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing[2],
      flexWrap: "wrap",
    },
    reviewStripText: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
      flex: 1,
      minWidth: 0,
    },
    reviewActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
      flexShrink: 0,
    },
    reworkRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    reworkInput: {
      flex: 1,
      minWidth: 0,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.md,
      backgroundColor: theme.colors.surface0,
      color: theme.colors.foreground,
      paddingHorizontal: theme.spacing[2],
      paddingVertical: theme.spacing[1.5],
      fontSize: theme.fontSize.sm,
    },
    briefBox: {
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    briefHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[1.5],
    },
    briefSummaryText: {
      flex: 1,
      minWidth: 0,
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    briefDetails: {
      paddingHorizontal: theme.spacing[3],
      paddingBottom: theme.spacing[2],
      gap: theme.spacing[1.5],
    },
    briefGoal: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foreground,
    },
    briefList: {
      gap: theme.spacing[0.5],
    },
    briefListHeading: {
      fontSize: theme.fontSize.sm,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foregroundMuted,
    },
    briefListItem: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    agentSwitcherScroll: {
      maxHeight: 40,
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
    },
    agentSwitcherContent: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[1.5],
    },
    agentTab: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
      paddingHorizontal: theme.spacing[2],
      paddingVertical: theme.spacing[0.5],
      borderRadius: theme.borderRadius.md,
      borderWidth: theme.borderWidth[1],
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
      maxWidth: 200,
    },
    agentTabSelected: {
      borderColor: theme.colors.primary,
      backgroundColor: theme.colors.surface2,
    },
    agentTabLabel: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
      flexShrink: 1,
    },
    agentTabLabelSelected: {
      color: theme.colors.foreground,
      fontWeight: theme.fontWeight.medium,
    },
    segmentBar: {
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[1.5],
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
      backgroundColor: theme.colors.surface0,
    },
    body: {
      flex: 1,
      minHeight: 0,
      minWidth: 0,
    },
    segmentBody: {
      flex: 1,
      minHeight: 0,
      minWidth: 0,
    },
    terminalBar: {
      borderBottomWidth: theme.borderWidth[1],
      borderBottomColor: theme.colors.border,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[1],
    },
    terminalTabRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
    },
    segmentFallback: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: theme.spacing[6],
      gap: theme.spacing[3],
    },
    fallbackText: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
      textAlign: "center",
    },
    fallbackActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    ringWrap: {
      width: 14,
      height: 14,
      alignItems: "center",
      justifyContent: "center",
      flexShrink: 0,
    },
    dotNeedsInput: dot("needs_input"),
    dotFailed: dot("failed"),
    dotAttention: dot("attention"),
    dotDone: dot("done"),
  };
});
