import type { TFunction } from "i18next";
import {
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
  type MainChatPlanRecord,
  type MainChatPlannedTask,
  parseTaskPlanToolOutput,
} from "@getpaseo/protocol/main-chat";
import {
  ArrowUpRight,
  CheckCircle2,
  CheckSquare,
  FolderGit2,
  Layers,
  Play,
  Square,
  X,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { StatusRing } from "@/components/status-ring";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import { planStoreKey, useMainChatPlanStore } from "./plan-store";
import { derivePlanTaskLiveBucket } from "./selectors";

const ThemedLayersIcon = withUnistyles(Layers);
const ThemedFolderIcon = withUnistyles(FolderGit2);
const ThemedArrowIcon = withUnistyles(ArrowUpRight);
const ThemedPlayIcon = withUnistyles(Play);
const ThemedXIcon = withUnistyles(X);
const ThemedCheckIcon = withUnistyles(CheckCircle2);
const ThemedCheckedBoxIcon = withUnistyles(CheckSquare);
const ThemedUncheckedBoxIcon = withUnistyles(Square);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

export interface MainChatPlanCardProps {
  serverId: string;
  agentId: string;
  toolStatus: string;
  output: unknown;
  error?: unknown;
}

type PlanActionKind = "start" | "remember" | "cancel";

function resolveLoadingTitle(t: TFunction, toolStatus: string, error: unknown): string {
  if (toolStatus === "running" || toolStatus === "executing") {
    return t("mainChat.planCard.planning");
  }
  if (error) return t("mainChat.planCard.failed");
  return t("mainChat.planCard.title");
}

function resolveLiveTaskStatusText(
  t: TFunction,
  task: MainChatPlannedTask,
  bucket: SidebarStateBucket | null,
): string {
  if (task.startError) return t("mainChat.taskStatus.startFailed");
  switch (bucket) {
    case "needs_input":
      return t("mainChat.taskStatus.needsYou");
    case "failed":
      return t("mainChat.taskStatus.failed");
    case "running":
      return t("mainChat.taskStatus.working");
    case "attention":
    case "done":
      return t("mainChat.taskStatus.done");
    default:
      return t("mainChat.taskStatus.starting");
  }
}

function StatusMark({ bucket }: { bucket: SidebarStateBucket | null }) {
  if (!bucket) return <View style={styles.dotIdle} />;
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

const StartedPlanCard = memo(function StartedPlanCard({
  plan,
  agentsMap,
  liveAgentsByTaskId,
  pendingCountsByAgentId,
  onOpenTaskAgent,
}: {
  plan: MainChatPlanRecord;
  agentsMap: ReadonlyMap<string, Agent> | undefined;
  liveAgentsByTaskId: ReadonlyMap<string, Agent>;
  pendingCountsByAgentId: ReadonlyMap<string, number>;
  onOpenTaskAgent: (agentId: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <View style={styles.card} testID={`main-chat-plan-card-${plan.id}`}>
      <View style={styles.headerRow}>
        <ThemedCheckIcon size={14} uniProps={successIconMapping} />
        <Text style={styles.headerTitle}>
          {plan.autoStarted
            ? t("mainChat.planCard.autoStartedTitle")
            : t("mainChat.planCard.startedTitle")}
        </Text>
        {plan.summary ? (
          <Text style={styles.headerSummary} numberOfLines={1}>
            {plan.summary}
          </Text>
        ) : null}
      </View>

      <View style={styles.liveTaskList}>
        {plan.tasks.map((task, index) => {
          const liveAgent =
            (task.agentId ? agentsMap?.get(task.agentId) : undefined) ??
            liveAgentsByTaskId.get(task.id);
          const targetAgentId = liveAgent?.id ?? task.agentId;
          const pendingCount = targetAgentId ? (pendingCountsByAgentId.get(targetAgentId) ?? 0) : 0;
          const bucket = derivePlanTaskLiveBucket(liveAgent, pendingCount);
          const statusText = resolveLiveTaskStatusText(t, task, bucket);

          return (
            <LivePlanTaskRow
              key={task.id}
              task={task}
              isFirst={index === 0}
              bucket={bucket}
              statusText={statusText}
              targetAgentId={targetAgentId}
              onOpen={onOpenTaskAgent}
            />
          );
        })}
      </View>
    </View>
  );
});

const SelectablePlannedTaskRow = memo(function SelectablePlannedTaskRow({
  task,
  isFirst,
  selectable,
  selected,
  onToggle,
}: {
  task: MainChatPlannedTask;
  isFirst: boolean;
  selectable: boolean;
  selected: boolean;
  onToggle: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const handleToggle = useCallback(() => {
    onToggle(task.id);
  }, [onToggle, task.id]);
  const rowStyle = useMemo(
    () => [
      styles.plannedTaskRow,
      !isFirst && styles.plannedTaskRowBorder,
      selectable && !selected && styles.plannedTaskUnselected,
    ],
    [isFirst, selectable, selected],
  );
  const metaSuffix = [
    task.branchName ? `branch: ${task.branchName}` : null,
    task.provider ? task.provider : null,
    task.reason || null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={rowStyle}>
      <View style={styles.taskHeaderRow}>
        <View style={styles.taskTitleWrap}>
          {selectable ? (
            <PressHighlight
              onPress={handleToggle}
              style={styles.checkboxButton}
              highlightStyle={styles.liveTaskRowPressed}
              accessibilityRole="checkbox"
              accessibilityLabel={task.title}
              testID={`main-chat-plan-toggle-${task.id}`}
            >
              {selected ? (
                <ThemedCheckedBoxIcon size={15} uniProps={foregroundIconMapping} />
              ) : (
                <ThemedUncheckedBoxIcon size={15} uniProps={mutedIconMapping} />
              )}
            </PressHighlight>
          ) : null}
          <Text style={styles.taskTitle} numberOfLines={2}>
            {task.title}
          </Text>
        </View>
        <View style={styles.badgesRow}>
          <StatusBadge
            size="xs"
            variant={task.mode === "readonly" ? "success" : "warning"}
            label={
              task.mode === "readonly" ? t("mainChat.mode.readonly") : t("mainChat.mode.write")
            }
          />
          <StatusBadge
            size="xs"
            variant="muted"
            label={
              task.isolation === "worktree"
                ? t("mainChat.isolation.worktree")
                : t("mainChat.isolation.local")
            }
          />
        </View>
      </View>

      <Text style={styles.taskGoal}>{task.goal}</Text>

      <View style={styles.metaRow}>
        <ThemedFolderIcon size={12} uniProps={mutedIconMapping} />
        <Text style={styles.metaText} numberOfLines={1}>
          {task.workspaceLabel}
          {metaSuffix ? ` · ${metaSuffix}` : ""}
        </Text>
      </View>

      {task.doneWhen.length > 0 ? (
        <View style={styles.criteriaBox}>
          {task.doneWhen.map((criterion) => (
            <Text key={criterion} style={styles.criteriaItem}>
              • {criterion}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
});

const OpenPlanCard = memo(function OpenPlanCard({
  plan,
  selectedIds,
  busyAction,
  actionError,
  disabled,
  onToggleTask,
  onStartPress,
  onStartAndRememberPress,
  onCancelPress,
}: {
  plan: MainChatPlanRecord;
  selectedIds: ReadonlySet<string>;
  busyAction: PlanActionKind | null;
  actionError: string | null;
  disabled: boolean;
  onToggleTask: (taskId: string) => void;
  onStartPress: () => void;
  onStartAndRememberPress: () => void;
  onCancelPress: () => void;
}) {
  const { t } = useTranslation();
  const selectable = plan.tasks.length > 1;
  const selectedCount = selectedIds.size;
  const startDisabled = disabled || selectedCount === 0;
  const startLabel =
    selectable && selectedCount < plan.tasks.length
      ? `${t("mainChat.planCard.start")} (${selectedCount}/${plan.tasks.length})`
      : t("mainChat.planCard.start");

  return (
    <View style={styles.card} testID={`main-chat-plan-card-${plan.id}`}>
      <View style={styles.headerRow}>
        <ThemedLayersIcon size={14} uniProps={foregroundIconMapping} />
        <Text style={styles.headerTitle}>{t("mainChat.planCard.title")}</Text>
        <StatusBadge variant="warning" size="xs" label={t("mainChat.planCard.awaitingApproval")} />
      </View>

      {plan.summary ? <Text style={styles.summaryText}>{plan.summary}</Text> : null}

      <View style={styles.taskList}>
        {plan.tasks.map((task, index) => (
          <SelectablePlannedTaskRow
            key={task.id}
            task={task}
            isFirst={index === 0}
            selectable={selectable}
            selected={selectedIds.has(task.id)}
            onToggle={onToggleTask}
          />
        ))}
      </View>

      {actionError ? <Text style={styles.errorText}>{actionError}</Text> : null}

      <View style={styles.actionsRow}>
        <Button
          variant="default"
          size="sm"
          loading={busyAction === "start"}
          disabled={startDisabled}
          leftIcon={ThemedPlayIcon}
          onPress={onStartPress}
          testID={`main-chat-plan-start-${plan.id}`}
        >
          {startLabel}
        </Button>
        <Button
          variant="outline"
          size="sm"
          loading={busyAction === "remember"}
          disabled={startDisabled}
          onPress={onStartAndRememberPress}
          testID={`main-chat-plan-remember-${plan.id}`}
        >
          {t("mainChat.planCard.startAndRemember")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          loading={busyAction === "cancel"}
          disabled={disabled}
          leftIcon={ThemedXIcon}
          onPress={onCancelPress}
          testID={`main-chat-plan-cancel-${plan.id}`}
        >
          {t("mainChat.planCard.cancel")}
        </Button>
      </View>
    </View>
  );
});

export const MainChatPlanCard = memo(function MainChatPlanCard({
  serverId,
  agentId,
  toolStatus,
  output,
  error,
}: MainChatPlanCardProps) {
  const { t } = useTranslation();
  const parsedPlan = useMemo(() => parseTaskPlanToolOutput(output), [output]);
  const planId = parsedPlan?.id ?? null;

  const storedPlan = useMainChatPlanStore((state) =>
    planId ? (state.plansByKey[planStoreKey(serverId, planId)] ?? null) : null,
  );
  const loadPlansForAgent = useMainChatPlanStore((state) => state.loadPlansForAgent);
  const startPlan = useMainChatPlanStore((state) => state.startPlan);
  const cancelPlan = useMainChatPlanStore((state) => state.cancelPlan);

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const agentsMap = useSessionStore((state) => state.sessions[serverId]?.agents);
  const pendingPermissions = useSessionStore(
    (state) => state.sessions[serverId]?.pendingPermissions,
  );

  const [busyAction, setBusyAction] = useState<PlanActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deselectedIds, setDeselectedIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    if (!client || !planId) return;
    void loadPlansForAgent(serverId, agentId, client);
  }, [agentId, client, loadPlansForAgent, planId, serverId]);

  const effectivePlan: MainChatPlanRecord | null = storedPlan ?? parsedPlan;

  const selectedIds = useMemo(() => {
    const ids = new Set<string>();
    if (!effectivePlan) return ids;
    for (const task of effectivePlan.tasks) {
      if (!deselectedIds.has(task.id)) ids.add(task.id);
    }
    return ids;
  }, [deselectedIds, effectivePlan]);

  const handleToggleTask = useCallback((taskId: string) => {
    setDeselectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const liveAgentsByTaskId = useMemo(() => {
    const map = new Map<string, Agent>();
    if (!effectivePlan || !agentsMap) return map;
    for (const candidate of agentsMap.values()) {
      if (candidate.archivedAt) continue;
      if (candidate.labels[MAIN_CHAT_TASK_PLAN_ID_LABEL] === effectivePlan.id) {
        const taskId = candidate.labels["paseo.main-chat.task-id"];
        if (taskId) map.set(taskId, candidate);
      }
    }
    return map;
  }, [agentsMap, effectivePlan]);

  const pendingCountsByAgentId = useMemo(() => {
    const counts = new Map<string, number>();
    if (!pendingPermissions) return counts;
    for (const perm of pendingPermissions.values()) {
      counts.set(perm.agentId, (counts.get(perm.agentId) ?? 0) + 1);
    }
    return counts;
  }, [pendingPermissions]);

  const runStart = useCallback(
    async (rememberAutoStart: boolean) => {
      if (!effectivePlan || !client || busyAction) return;
      const chosenIds = effectivePlan.tasks
        .filter((task) => selectedIds.has(task.id))
        .map((task) => task.id);
      if (chosenIds.length === 0) return;
      const taskIds = chosenIds.length < effectivePlan.tasks.length ? chosenIds : undefined;
      setBusyAction(rememberAutoStart ? "remember" : "start");
      setActionError(null);
      try {
        await startPlan(serverId, effectivePlan.id, client, { taskIds, rememberAutoStart });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    },
    [busyAction, client, effectivePlan, selectedIds, serverId, startPlan],
  );

  const handleStartPress = useCallback(() => {
    void runStart(false);
  }, [runStart]);

  const handleStartAndRememberPress = useCallback(() => {
    void runStart(true);
  }, [runStart]);

  const handleCancelPress = useCallback(() => {
    if (!effectivePlan || !client || busyAction) return;
    setBusyAction("cancel");
    setActionError(null);
    void (async () => {
      try {
        await cancelPlan(serverId, effectivePlan.id, client);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    })();
  }, [busyAction, cancelPlan, client, effectivePlan, serverId]);

  const handleOpenTaskAgent = useCallback(
    (targetAgentId: string) => {
      navigateToAgent({ serverId, agentId: targetAgentId });
    },
    [serverId],
  );

  if (!effectivePlan) {
    return (
      <View style={styles.card} testID="main-chat-plan-card-loading">
        <View style={styles.headerRow}>
          <ThemedLayersIcon size={14} uniProps={mutedIconMapping} />
          <Text style={styles.headerTitle}>{resolveLoadingTitle(t, toolStatus, error)}</Text>
        </View>
        {error ? (
          <Text style={styles.errorText}>
            {typeof error === "string" ? error : JSON.stringify(error)}
          </Text>
        ) : null}
      </View>
    );
  }

  const hasSpawnedAgents =
    effectivePlan.tasks.some((task) => Boolean(task.agentId)) || liveAgentsByTaskId.size > 0;
  const resolvedStatus =
    effectivePlan.status === "open" && hasSpawnedAgents ? "started" : effectivePlan.status;

  if (resolvedStatus === "cancelled") {
    return (
      <View style={styles.compactCard} testID={`main-chat-plan-card-${effectivePlan.id}`}>
        <ThemedLayersIcon size={14} uniProps={mutedIconMapping} />
        <Text style={styles.compactMutedText} numberOfLines={1}>
          {t("mainChat.planCard.cancelledSummary", { count: effectivePlan.tasks.length })}
        </Text>
      </View>
    );
  }

  if (resolvedStatus === "started") {
    return (
      <StartedPlanCard
        plan={effectivePlan}
        agentsMap={agentsMap}
        liveAgentsByTaskId={liveAgentsByTaskId}
        pendingCountsByAgentId={pendingCountsByAgentId}
        onOpenTaskAgent={handleOpenTaskAgent}
      />
    );
  }

  return (
    <OpenPlanCard
      plan={effectivePlan}
      selectedIds={selectedIds}
      busyAction={busyAction}
      actionError={actionError}
      disabled={busyAction !== null || !client}
      onToggleTask={handleToggleTask}
      onStartPress={handleStartPress}
      onStartAndRememberPress={handleStartAndRememberPress}
      onCancelPress={handleCancelPress}
    />
  );
});

const LivePlanTaskRow = memo(function LivePlanTaskRow({
  task,
  isFirst,
  bucket,
  statusText,
  targetAgentId,
  onOpen,
}: {
  task: MainChatPlannedTask;
  isFirst: boolean;
  bucket: SidebarStateBucket | null;
  statusText: string;
  targetAgentId: string | null;
  onOpen: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (targetAgentId) onOpen(targetAgentId);
  }, [onOpen, targetAgentId]);

  const rowContent = (
    <View style={styles.liveTaskInner}>
      <StatusMark bucket={bucket} />
      <View style={styles.liveTaskTextCol}>
        <Text style={styles.liveTaskTitle} numberOfLines={1}>
          {task.title}
        </Text>
        <Text style={styles.liveTaskSub} numberOfLines={1}>
          {task.startError ? task.startError : `${task.workspaceLabel} · ${statusText}`}
        </Text>
      </View>
      <StatusBadge
        size="xs"
        variant={task.mode === "readonly" ? "success" : "muted"}
        label={task.mode === "readonly" ? t("mainChat.mode.readonly") : t("mainChat.mode.write")}
      />
      {targetAgentId ? <ThemedArrowIcon size={14} uniProps={mutedIconMapping} /> : null}
    </View>
  );

  if (!targetAgentId) {
    return (
      <View style={[styles.liveTaskRow, !isFirst && styles.plannedTaskRowBorder]}>
        {rowContent}
      </View>
    );
  }

  return (
    <PressHighlight
      onPress={handlePress}
      style={[styles.liveTaskRow, !isFirst && styles.plannedTaskRowBorder]}
      highlightStyle={styles.liveTaskRowPressed}
      accessibilityRole="button"
      accessibilityLabel={task.title}
      testID={`main-chat-live-task-${targetAgentId}`}
    >
      {rowContent}
    </PressHighlight>
  );
});

const styles = StyleSheet.create((theme) => {
  const dot = (bucket: Exclude<SidebarStateBucket, "running">) => ({
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket, showDoneAsInactive: false }) ?? undefined,
  });

  return {
    card: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      borderRadius: theme.borderRadius.xl,
      padding: theme.spacing[3],
      gap: theme.spacing[2],
      maxWidth: 640,
      width: "100%",
    },
    compactCard: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      borderWidth: 1,
      borderColor: theme.colors.border,
      backgroundColor: theme.colors.surface1,
      borderRadius: theme.borderRadius.lg,
      paddingHorizontal: theme.spacing[3],
      paddingVertical: theme.spacing[2],
      maxWidth: 640,
      width: "100%",
    },
    compactMutedText: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
      flex: 1,
    },
    headerRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      flexWrap: "wrap",
    },
    headerTitle: {
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
    },
    headerSummary: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
      flex: 1,
      minWidth: 0,
    },
    summaryText: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    taskList: {
      gap: 0,
    },
    plannedTaskRow: {
      paddingVertical: theme.spacing[2],
      gap: theme.spacing[1.5],
    },
    plannedTaskRowBorder: {
      borderTopWidth: 1,
      borderTopColor: theme.colors.border,
    },
    plannedTaskUnselected: {
      opacity: 0.55,
    },
    taskTitleWrap: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
      flexShrink: 1,
    },
    checkboxButton: {
      padding: 2,
      borderRadius: theme.borderRadius.sm,
    },
    taskHeaderRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: theme.spacing[2],
      flexWrap: "wrap",
    },
    taskTitle: {
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
      flexShrink: 1,
    },
    badgesRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
    },
    taskGoal: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foreground,
    },
    metaRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[1.5],
    },
    metaText: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
      flex: 1,
      minWidth: 0,
    },
    criteriaBox: {
      paddingLeft: theme.spacing[2],
      gap: theme.spacing[0.5],
    },
    criteriaItem: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    actionsRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
      flexWrap: "wrap",
      paddingTop: theme.spacing[1],
    },
    errorText: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.statusDanger,
    },
    liveTaskList: {
      gap: 0,
    },
    liveTaskRow: {
      paddingVertical: theme.spacing[2],
      paddingHorizontal: theme.spacing[1.5],
      borderRadius: theme.borderRadius.md,
    },
    liveTaskRowPressed: {
      backgroundColor: theme.colors.surface2,
    },
    liveTaskInner: {
      flexDirection: "row",
      alignItems: "center",
      gap: theme.spacing[2],
    },
    liveTaskTextCol: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    liveTaskTitle: {
      fontSize: theme.fontSize.base,
      fontWeight: theme.fontWeight.medium,
      color: theme.colors.foreground,
    },
    liveTaskSub: {
      fontSize: theme.fontSize.sm,
      color: theme.colors.foregroundMuted,
    },
    ringWrap: {
      width: 14,
      height: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    dotIdle: {
      width: STATUS_INDICATOR_FILLED_DOT_SIZE,
      height: STATUS_INDICATOR_FILLED_DOT_SIZE,
      borderRadius: theme.borderRadius.full,
      backgroundColor: theme.colors.foregroundMuted,
    },
    dotNeedsInput: dot("needs_input"),
    dotFailed: dot("failed"),
    dotAttention: dot("attention"),
    dotDone: dot("done"),
  };
});
