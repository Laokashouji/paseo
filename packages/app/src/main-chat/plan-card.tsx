import type { TFunction } from "i18next";
import {
  MAIN_CHAT_TASK_PLAN_ID_LABEL,
  type MainChatPlanRecord,
  type MainChatPlanTaskPatch,
  type MainChatPlannedTask,
  type MainChatTaskIsolation,
  type MainChatTaskMode,
  parseTaskPlanToolOutput,
} from "@getpaseo/protocol/main-chat";
import { CheckSquare, FolderGit2, Layers, Pencil, Play, Square, X } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { EditingTextInput } from "@/components/ui/text-input";
import { useSessionStore, type Agent } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { MainChatHandoffCard } from "./handoff-card";
import { useMainChatOverviewStore } from "./overview-store";
import { planStoreKey, useMainChatPlanStore } from "./plan-store";

const ThemedLayersIcon = withUnistyles(Layers);
const ThemedFolderIcon = withUnistyles(FolderGit2);
const ThemedPencilIcon = withUnistyles(Pencil);
const ThemedPlayIcon = withUnistyles(Play);
const ThemedXIcon = withUnistyles(X);
const ThemedCheckedBoxIcon = withUnistyles(CheckSquare);
const ThemedUncheckedBoxIcon = withUnistyles(Square);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

export interface MainChatPlanCardProps {
  serverId: string;
  agentId: string;
  toolStatus?: string;
  output?: unknown;
  error?: unknown;
  /** Optional plan record passed directly (e.g. inline inside MainChatActionBar). */
  plan?: MainChatPlanRecord;
  onPlanUpdated?: (plan: MainChatPlanRecord) => void;
}

type PlanActionKind = "start" | "cancel";

interface TaskEditDraft {
  title: string;
  goal: string;
  doneWhenText: string;
  outOfBoundsText: string;
  mode: MainChatTaskMode;
  isolation: MainChatTaskIsolation;
  cwd: string;
  branchName: string;
}

function createDraftFromTask(task: MainChatPlannedTask): TaskEditDraft {
  return {
    title: task.title,
    goal: task.goal,
    doneWhenText: task.doneWhen.join("\n"),
    outOfBoundsText: task.outOfBounds.join("\n"),
    mode: task.mode,
    isolation: task.isolation,
    cwd: task.cwd ?? "",
    branchName: task.branchName ?? "",
  };
}

function parseLineList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/^[•\-*]\s*/, "").trim())
    .filter(Boolean);
}

function resolveLoadingTitle(t: TFunction, toolStatus: string, error: unknown): string {
  if (toolStatus === "running" || toolStatus === "executing") {
    return t("mainChat.planCard.planning");
  }
  if (error) return t("mainChat.planCard.failed");
  return t("mainChat.planCard.title");
}

const StartedPlanHandoffList = memo(function StartedPlanHandoffList({
  serverId,
  plan,
  agentsMap,
  liveAgentsByTaskId,
}: {
  serverId: string;
  plan: MainChatPlanRecord;
  agentsMap: ReadonlyMap<string, Agent> | undefined;
  liveAgentsByTaskId: ReadonlyMap<string, Agent>;
}) {
  const { t } = useTranslation();

  // Deduplicate by spawned agentId so each agent produces at most one compact HandoffCard.
  const entries = useMemo(() => {
    const seenAgentIds = new Set<string>();
    const result: Array<{
      key: string;
      task: MainChatPlannedTask;
      targetServerId: string;
      targetAgentId: string | null;
      workspaceId: string | null;
    }> = [];

    for (const task of plan.tasks) {
      const liveAgent =
        (task.agentId ? agentsMap?.get(task.agentId) : undefined) ??
        liveAgentsByTaskId.get(task.id);
      const targetAgentId = liveAgent?.id ?? task.agentId ?? null;
      const targetServerId = task.serverId ?? serverId;

      if (targetAgentId) {
        const dedupeKey = `${targetServerId}:${targetAgentId}`;
        if (seenAgentIds.has(dedupeKey)) continue;
        seenAgentIds.add(dedupeKey);
        result.push({
          key: dedupeKey,
          task,
          targetServerId,
          targetAgentId,
          workspaceId: liveAgent?.workspaceId ?? task.workspaceId ?? null,
        });
      } else {
        result.push({
          key: `task:${task.id}`,
          task,
          targetServerId,
          targetAgentId: null,
          workspaceId: task.workspaceId ?? null,
        });
      }
    }
    return result;
  }, [agentsMap, liveAgentsByTaskId, plan.tasks, serverId]);

  return (
    <View style={styles.handoffStack} testID={`main-chat-plan-card-${plan.id}`}>
      {entries.map((entry) =>
        entry.targetAgentId ? (
          <MainChatHandoffCard
            key={entry.key}
            serverId={entry.targetServerId}
            agentId={entry.targetAgentId}
            title={entry.task.title}
            workspaceId={entry.workspaceId}
            workspaceLabel={entry.task.workspaceLabel}
            hostLabel={entry.task.hostLabel ?? null}
            mode={entry.task.mode}
            isolation={entry.task.isolation}
            taskId={entry.task.taskRecordId ?? null}
            sourceKind={entry.task.continuesTaskId ? "continuation" : "new"}
            startError={entry.task.startError}
            expectedMinutes={entry.task.expectedMinutes ?? null}
            scopeRevision={entry.task.scopeRevision ?? null}
          />
        ) : (
          <View
            key={entry.key}
            style={styles.compactCard}
            testID={`main-chat-plan-task-pending-${entry.task.id}`}
          >
            <ThemedLayersIcon size={13} uniProps={mutedIconMapping} />
            <Text style={styles.compactMutedText} numberOfLines={1}>
              {entry.task.title} · {entry.task.startError ?? t("mainChat.taskStatus.starting")}
            </Text>
          </View>
        ),
      )}
    </View>
  );
});

const InlineTaskEditor = memo(function InlineTaskEditor({
  task,
  saving,
  saveError,
  onCancel,
  onSave,
}: {
  task: MainChatPlannedTask;
  saving: boolean;
  saveError: string | null;
  onCancel: () => void;
  onSave: (taskId: string, patch: MainChatPlanTaskPatch) => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<TaskEditDraft>(() => createDraftFromTask(task));

  const setField = useCallback(<K extends keyof TaskEditDraft>(key: K, value: TaskEditDraft[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleTitleChange = useCallback((value: string) => setField("title", value), [setField]);
  const handleGoalChange = useCallback((value: string) => setField("goal", value), [setField]);
  const handleModeReadonly = useCallback(() => setField("mode", "readonly"), [setField]);
  const handleModeWrite = useCallback(() => setField("mode", "write"), [setField]);
  const handleIsolationLocal = useCallback(() => setField("isolation", "local"), [setField]);
  const handleIsolationWorktree = useCallback(() => setField("isolation", "worktree"), [setField]);
  const handleCwdChange = useCallback((value: string) => setField("cwd", value), [setField]);
  const handleBranchChange = useCallback(
    (value: string) => setField("branchName", value),
    [setField],
  );
  const handleDoneWhenChange = useCallback(
    (value: string) => setField("doneWhenText", value),
    [setField],
  );
  const handleOutOfBoundsChange = useCallback(
    (value: string) => setField("outOfBoundsText", value),
    [setField],
  );

  const handleSave = useCallback(() => {
    const trimmedTitle = draft.title.trim();
    const trimmedGoal = draft.goal.trim();
    if (!trimmedTitle || !trimmedGoal || saving) return;
    const patch: MainChatPlanTaskPatch = {
      title: trimmedTitle,
      goal: trimmedGoal,
      doneWhen: parseLineList(draft.doneWhenText),
      outOfBounds: parseLineList(draft.outOfBoundsText),
      mode: draft.mode,
      isolation: draft.isolation,
      cwd: draft.cwd.trim() ? draft.cwd.trim() : null,
      branchName: draft.branchName.trim() ? draft.branchName.trim() : null,
    };
    onSave(task.id, patch);
  }, [draft, onSave, saving, task.id]);

  const canSave = draft.title.trim().length > 0 && draft.goal.trim().length > 0 && !saving;

  return (
    <View style={styles.editorBox} testID={`main-chat-plan-editor-${task.id}`}>
      <View style={styles.editorField}>
        <Text style={styles.editorLabel}>{t("mainChat.planCard.edit.titleLabel")}</Text>
        <EditingTextInput
          initialValue={draft.title}
          onChangeText={handleTitleChange}
          style={styles.editorInput}
          placeholder={t("mainChat.planCard.edit.titlePlaceholder")}
          testID={`main-chat-plan-edit-title-${task.id}`}
        />
      </View>

      <View style={styles.editorField}>
        <Text style={styles.editorLabel}>{t("mainChat.planCard.edit.goalLabel")}</Text>
        <EditingTextInput
          initialValue={draft.goal}
          onChangeText={handleGoalChange}
          style={[styles.editorInput, styles.editorMultiline]}
          multiline
          placeholder={t("mainChat.planCard.edit.goalPlaceholder")}
          testID={`main-chat-plan-edit-goal-${task.id}`}
        />
      </View>

      <View style={styles.editorToggleRow}>
        <View style={styles.editorToggleGroup}>
          <Text style={styles.editorLabel}>{t("mainChat.planCard.edit.modeLabel")}</Text>
          <View style={styles.pillToggleRow}>
            <PressHighlight
              onPress={handleModeReadonly}
              style={[styles.pillToggle, draft.mode === "readonly" && styles.pillToggleSelected]}
              highlightStyle={styles.liveTaskRowPressed}
              accessibilityRole="button"
              testID={`main-chat-plan-edit-mode-readonly-${task.id}`}
            >
              <Text
                style={[
                  styles.pillToggleText,
                  draft.mode === "readonly" && styles.pillToggleTextSelected,
                ]}
              >
                {t("mainChat.mode.readonly")}
              </Text>
            </PressHighlight>
            <PressHighlight
              onPress={handleModeWrite}
              style={[styles.pillToggle, draft.mode === "write" && styles.pillToggleSelected]}
              highlightStyle={styles.liveTaskRowPressed}
              accessibilityRole="button"
              testID={`main-chat-plan-edit-mode-write-${task.id}`}
            >
              <Text
                style={[
                  styles.pillToggleText,
                  draft.mode === "write" && styles.pillToggleTextSelected,
                ]}
              >
                {t("mainChat.mode.write")}
              </Text>
            </PressHighlight>
          </View>
        </View>

        <View style={styles.editorToggleGroup}>
          <Text style={styles.editorLabel}>{t("mainChat.planCard.edit.isolationLabel")}</Text>
          <View style={styles.pillToggleRow}>
            <PressHighlight
              onPress={handleIsolationLocal}
              style={[styles.pillToggle, draft.isolation === "local" && styles.pillToggleSelected]}
              highlightStyle={styles.liveTaskRowPressed}
              accessibilityRole="button"
              testID={`main-chat-plan-edit-isolation-local-${task.id}`}
            >
              <Text
                style={[
                  styles.pillToggleText,
                  draft.isolation === "local" && styles.pillToggleTextSelected,
                ]}
              >
                {t("mainChat.isolation.local")}
              </Text>
            </PressHighlight>
            <PressHighlight
              onPress={handleIsolationWorktree}
              style={[
                styles.pillToggle,
                draft.isolation === "worktree" && styles.pillToggleSelected,
              ]}
              highlightStyle={styles.liveTaskRowPressed}
              accessibilityRole="button"
              testID={`main-chat-plan-edit-isolation-worktree-${task.id}`}
            >
              <Text
                style={[
                  styles.pillToggleText,
                  draft.isolation === "worktree" && styles.pillToggleTextSelected,
                ]}
              >
                {t("mainChat.isolation.worktree")}
              </Text>
            </PressHighlight>
          </View>
        </View>
      </View>

      <View style={styles.editorTwoCol}>
        <View style={styles.editorHalfField}>
          <Text style={styles.editorLabel}>{t("mainChat.planCard.edit.cwdLabel")}</Text>
          <EditingTextInput
            initialValue={draft.cwd}
            onChangeText={handleCwdChange}
            style={styles.editorInput}
            placeholder={t("mainChat.planCard.edit.cwdPlaceholder")}
            testID={`main-chat-plan-edit-cwd-${task.id}`}
          />
        </View>
        <View style={styles.editorHalfField}>
          <Text style={styles.editorLabel}>{t("mainChat.planCard.edit.branchLabel")}</Text>
          <EditingTextInput
            initialValue={draft.branchName}
            onChangeText={handleBranchChange}
            style={styles.editorInput}
            placeholder={t("mainChat.planCard.edit.branchPlaceholder")}
            testID={`main-chat-plan-edit-branch-${task.id}`}
          />
        </View>
      </View>

      <View style={styles.editorField}>
        <Text style={styles.editorLabel}>{t("mainChat.planCard.edit.doneWhenLabel")}</Text>
        <EditingTextInput
          initialValue={draft.doneWhenText}
          onChangeText={handleDoneWhenChange}
          style={[styles.editorInput, styles.editorMultiline]}
          multiline
          placeholder={t("mainChat.planCard.edit.linePerItemPlaceholder")}
          testID={`main-chat-plan-edit-done-when-${task.id}`}
        />
      </View>

      <View style={styles.editorField}>
        <Text style={styles.editorLabel}>{t("mainChat.planCard.edit.outOfBoundsLabel")}</Text>
        <EditingTextInput
          initialValue={draft.outOfBoundsText}
          onChangeText={handleOutOfBoundsChange}
          style={[styles.editorInput, styles.editorMultiline]}
          multiline
          placeholder={t("mainChat.planCard.edit.linePerItemPlaceholder")}
          testID={`main-chat-plan-edit-out-of-bounds-${task.id}`}
        />
      </View>

      {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}

      <View style={styles.editorActions}>
        <Button
          variant="ghost"
          size="sm"
          disabled={saving}
          onPress={onCancel}
          testID={`main-chat-plan-edit-cancel-${task.id}`}
        >
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          loading={saving}
          disabled={!canSave}
          onPress={handleSave}
          testID={`main-chat-plan-edit-save-${task.id}`}
        >
          {t("common.actions.save")}
        </Button>
      </View>
    </View>
  );
});

const PlannedTaskBadges = memo(function PlannedTaskBadges({
  task,
  canEdit,
  isEditing,
  onEdit,
}: {
  task: MainChatPlannedTask;
  canEdit: boolean;
  isEditing: boolean;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.badgesRow}>
      <StatusBadge
        size="xs"
        variant={task.mode === "readonly" ? "success" : "warning"}
        label={task.mode === "readonly" ? t("mainChat.mode.readonly") : t("mainChat.mode.write")}
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
      {task.scopeRevision ? (
        <StatusBadge
          size="xs"
          variant="muted"
          label={t("mainChat.planCard.briefRevisionBadge", {
            revision: task.scopeRevision,
          })}
        />
      ) : null}
      {task.expectedMinutes ? (
        <StatusBadge
          size="xs"
          variant="muted"
          label={t("mainChat.planCard.expectedMinutesShort", {
            minutes: task.expectedMinutes,
          })}
        />
      ) : null}
      {task.continuesTaskId ? (
        <StatusBadge size="xs" variant="warning" label={t("mainChat.planCard.continuesBadge")} />
      ) : null}
      {canEdit && !isEditing ? (
        <PressHighlight
          onPress={onEdit}
          style={styles.editButton}
          highlightStyle={styles.liveTaskRowPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.planCard.editButton")}
          testID={`main-chat-plan-edit-open-${task.id}`}
        >
          <ThemedPencilIcon size={12} uniProps={mutedIconMapping} />
          <Text style={styles.editButtonLabel}>{t("mainChat.planCard.editButton")}</Text>
        </PressHighlight>
      ) : null}
    </View>
  );
});

const SelectablePlannedTaskRow = memo(function SelectablePlannedTaskRow({
  task,
  isFirst,
  selectable,
  selected,
  canEdit,
  isEditing,
  isSavingEdit,
  editError,
  onToggle,
  onBeginEdit,
  onCancelEdit,
  onSaveEdit,
}: {
  task: MainChatPlannedTask;
  isFirst: boolean;
  selectable: boolean;
  selected: boolean;
  canEdit: boolean;
  isEditing: boolean;
  isSavingEdit: boolean;
  editError: string | null;
  onToggle: (taskId: string) => void;
  onBeginEdit: (taskId: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (taskId: string, patch: MainChatPlanTaskPatch) => void;
}) {
  const { t } = useTranslation();
  const handleToggle = useCallback(() => {
    onToggle(task.id);
  }, [onToggle, task.id]);
  const handleEdit = useCallback(() => {
    onBeginEdit(task.id);
  }, [onBeginEdit, task.id]);

  const rowStyle = useMemo(
    () => [
      styles.plannedTaskRow,
      !isFirst && styles.plannedTaskRowBorder,
      selectable && !selected && styles.plannedTaskUnselected,
    ],
    [isFirst, selectable, selected],
  );
  const metaSuffix = [
    task.hostLabel || null,
    task.cwd || null,
    task.branchName ? `branch: ${task.branchName}` : null,
    task.provider || null,
    task.reason || null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <View style={rowStyle} testID={`main-chat-plan-task-${task.id}`}>
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
        <PlannedTaskBadges
          task={task}
          canEdit={canEdit}
          isEditing={isEditing}
          onEdit={handleEdit}
        />
      </View>

      {isEditing ? (
        <InlineTaskEditor
          task={task}
          saving={isSavingEdit}
          saveError={editError}
          onCancel={onCancelEdit}
          onSave={onSaveEdit}
        />
      ) : (
        <>
          <Text style={styles.taskGoal}>{task.goal}</Text>

          {task.continuesTaskId ? (
            <Text style={styles.continuesNote} testID={`main-chat-plan-continues-${task.id}`}>
              {task.continuesWhy?.trim()
                ? t("mainChat.planCard.continuesWithWhy", {
                    taskId: task.continuesTaskId,
                    why: task.continuesWhy.trim(),
                  })
                : t("mainChat.planCard.continuesRef", { taskId: task.continuesTaskId })}
            </Text>
          ) : null}

          <View style={styles.metaRow}>
            <ThemedFolderIcon size={12} uniProps={mutedIconMapping} />
            <Text style={styles.metaText} numberOfLines={1}>
              {task.workspaceLabel}
              {metaSuffix ? ` · ${metaSuffix}` : ""}
            </Text>
          </View>

          {task.doneWhen.length > 0 ? (
            <View style={styles.criteriaBox}>
              <Text style={styles.criteriaHeading}>{t("mainChat.planCard.doneWhenHeading")}</Text>
              {task.doneWhen.map((criterion) => (
                <Text key={criterion} style={styles.criteriaItem}>
                  • {criterion}
                </Text>
              ))}
            </View>
          ) : null}

          {task.outOfBounds.length > 0 ? (
            <View style={styles.criteriaBox}>
              <Text style={styles.criteriaHeading}>
                {t("mainChat.planCard.outOfBoundsHeading")}
              </Text>
              {task.outOfBounds.map((boundary) => (
                <Text key={boundary} style={styles.criteriaItem}>
                  • {boundary}
                </Text>
              ))}
            </View>
          ) : null}
        </>
      )}
    </View>
  );
});

const OpenPlanCard = memo(function OpenPlanCard({
  plan,
  selectedIds,
  rememberAutoStart,
  editingTaskId,
  isSavingEdit,
  editError,
  busyAction,
  actionError,
  disabled,
  canEdit,
  onToggleTask,
  onToggleRemember,
  onBeginEdit,
  onCancelEdit,
  onSaveEdit,
  onStartPress,
  onCancelPress,
}: {
  plan: MainChatPlanRecord;
  selectedIds: ReadonlySet<string>;
  rememberAutoStart: boolean;
  editingTaskId: string | null;
  isSavingEdit: boolean;
  editError: string | null;
  busyAction: PlanActionKind | null;
  actionError: string | null;
  disabled: boolean;
  canEdit: boolean;
  onToggleTask: (taskId: string) => void;
  onToggleRemember: () => void;
  onBeginEdit: (taskId: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (taskId: string, patch: MainChatPlanTaskPatch) => void;
  onStartPress: () => void;
  onCancelPress: () => void;
}) {
  const { t } = useTranslation();
  const selectable = plan.tasks.length > 1;
  const selectedCount = selectedIds.size;
  const startDisabled = disabled || selectedCount === 0 || editingTaskId !== null;
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
            canEdit={canEdit}
            isEditing={editingTaskId === task.id}
            isSavingEdit={isSavingEdit}
            editError={editingTaskId === task.id ? editError : null}
            onToggle={onToggleTask}
            onBeginEdit={onBeginEdit}
            onCancelEdit={onCancelEdit}
            onSaveEdit={onSaveEdit}
          />
        ))}
      </View>

      <PressHighlight
        onPress={onToggleRemember}
        disabled={disabled}
        style={styles.rememberRow}
        highlightStyle={styles.liveTaskRowPressed}
        accessibilityRole="checkbox"
        accessibilityLabel={t("mainChat.planCard.rememberAutoStartCheckbox")}
        testID={`main-chat-plan-remember-checkbox-${plan.id}`}
      >
        {rememberAutoStart ? (
          <ThemedCheckedBoxIcon size={15} uniProps={foregroundIconMapping} />
        ) : (
          <ThemedUncheckedBoxIcon size={15} uniProps={mutedIconMapping} />
        )}
        <Text style={styles.rememberLabel}>{t("mainChat.planCard.rememberAutoStartCheckbox")}</Text>
      </PressHighlight>

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

function resolveTerminalPlanSummary(
  plan: MainChatPlanRecord,
  resolvedStatus: MainChatPlanRecord["status"],
  t: TFunction,
): string | null {
  if (resolvedStatus === "withdrawn") {
    const trimmed = plan.withdrawReason?.trim();
    return trimmed
      ? t("mainChat.planCard.withdrawnWithReason", { reason: trimmed })
      : t("mainChat.planCard.withdrawnSummary", { count: plan.tasks.length });
  }
  if (resolvedStatus === "cancelled") {
    return t("mainChat.planCard.cancelledSummary", { count: plan.tasks.length });
  }
  return null;
}

export const MainChatPlanCard = memo(function MainChatPlanCard({
  serverId,
  agentId,
  toolStatus = "completed",
  output,
  error,
  plan: directPlan,
  onPlanUpdated,
}: MainChatPlanCardProps): ReactElement {
  const { t } = useTranslation();
  const parsedPlan = useMemo(
    () => (directPlan ? null : parseTaskPlanToolOutput(output)),
    [directPlan, output],
  );
  const planId = directPlan?.id ?? parsedPlan?.id ?? null;

  const storedPlan = useMainChatPlanStore((state) =>
    planId ? (state.plansByKey[planStoreKey(serverId, planId)] ?? null) : null,
  );
  const loadPlansForAgent = useMainChatPlanStore((state) => state.loadPlansForAgent);
  const startPlan = useMainChatPlanStore((state) => state.startPlan);
  const updatePlanTask = useMainChatPlanStore((state) => state.updatePlanTask);
  const cancelPlan = useMainChatPlanStore((state) => state.cancelPlan);
  const upsertPlanInOverview = useMainChatOverviewStore((state) => state.upsertPlanInOverview);
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);

  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const agentsMap = useSessionStore((state) => state.sessions[serverId]?.agents);

  const [busyAction, setBusyAction] = useState<PlanActionKind | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [deselectedIds, setDeselectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [rememberAutoStart, setRememberAutoStart] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !planId || directPlan) return;
    void loadPlansForAgent(serverId, agentId, client);
  }, [agentId, client, directPlan, loadPlansForAgent, planId, serverId]);

  const effectivePlan: MainChatPlanRecord | null = storedPlan ?? directPlan ?? parsedPlan;

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

  const handleToggleRemember = useCallback(() => {
    setRememberAutoStart((prev) => !prev);
  }, []);

  const handleBeginEdit = useCallback((taskId: string) => {
    setEditError(null);
    setEditingTaskId(taskId);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditError(null);
    setEditingTaskId(null);
  }, []);

  const handleSaveEdit = useCallback(
    (taskId: string, patch: MainChatPlanTaskPatch) => {
      if (!effectivePlan || !client || isSavingEdit) return;
      setIsSavingEdit(true);
      setEditError(null);
      void updatePlanTask(serverId, effectivePlan.id, taskId, patch, client)
        .then((updated) => {
          upsertPlanInOverview(serverId, agentId, updated);
          onPlanUpdated?.(updated);
          setEditingTaskId(null);
          return updated;
        })
        .catch((err) => {
          setEditError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          setIsSavingEdit(false);
        });
    },
    [
      agentId,
      client,
      effectivePlan,
      isSavingEdit,
      onPlanUpdated,
      serverId,
      updatePlanTask,
      upsertPlanInOverview,
    ],
  );

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

  const handleStartPress = useCallback(() => {
    if (!effectivePlan || !client || busyAction) return;
    const chosenIds = effectivePlan.tasks
      .filter((task) => selectedIds.has(task.id))
      .map((task) => task.id);
    if (chosenIds.length === 0) return;
    const taskIds = chosenIds.length < effectivePlan.tasks.length ? chosenIds : undefined;
    setBusyAction("start");
    setActionError(null);
    void (async () => {
      try {
        const updated = await startPlan(serverId, effectivePlan.id, client, {
          taskIds,
          rememberAutoStart,
        });
        upsertPlanInOverview(serverId, agentId, updated);
        onPlanUpdated?.(updated);
        try {
          await loadOverview(serverId, agentId, client);
        } catch {
          // Best-effort overview sync after plan start.
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    })();
  }, [
    agentId,
    busyAction,
    client,
    effectivePlan,
    loadOverview,
    onPlanUpdated,
    rememberAutoStart,
    selectedIds,
    serverId,
    startPlan,
    upsertPlanInOverview,
  ]);

  const handleCancelPress = useCallback(() => {
    if (!effectivePlan || !client || busyAction) return;
    setBusyAction("cancel");
    setActionError(null);
    void cancelPlan(serverId, effectivePlan.id, client)
      .then((updated) => {
        upsertPlanInOverview(serverId, agentId, updated);
        onPlanUpdated?.(updated);
        return updated;
      })
      .catch((err) => {
        setActionError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setBusyAction(null);
      });
  }, [
    agentId,
    busyAction,
    cancelPlan,
    client,
    effectivePlan,
    onPlanUpdated,
    serverId,
    upsertPlanInOverview,
  ]);

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

  const terminalSummary = resolveTerminalPlanSummary(effectivePlan, resolvedStatus, t);
  if (terminalSummary !== null) {
    return (
      <View style={styles.compactCard} testID={`main-chat-plan-card-${effectivePlan.id}`}>
        <ThemedLayersIcon size={14} uniProps={mutedIconMapping} />
        <Text
          style={styles.compactMutedText}
          numberOfLines={resolvedStatus === "withdrawn" ? 2 : 1}
        >
          {terminalSummary}
        </Text>
      </View>
    );
  }

  if (resolvedStatus === "started") {
    return (
      <StartedPlanHandoffList
        serverId={serverId}
        plan={effectivePlan}
        agentsMap={agentsMap}
        liveAgentsByTaskId={liveAgentsByTaskId}
      />
    );
  }

  return (
    <OpenPlanCard
      plan={effectivePlan}
      selectedIds={selectedIds}
      rememberAutoStart={rememberAutoStart}
      editingTaskId={editingTaskId}
      isSavingEdit={isSavingEdit}
      editError={editError}
      busyAction={busyAction}
      actionError={actionError}
      disabled={busyAction !== null || !client}
      canEdit={Boolean(client) && busyAction === null}
      onToggleTask={handleToggleTask}
      onToggleRemember={handleToggleRemember}
      onBeginEdit={handleBeginEdit}
      onCancelEdit={handleCancelEdit}
      onSaveEdit={handleSaveEdit}
      onStartPress={handleStartPress}
      onCancelPress={handleCancelPress}
    />
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[4],
    gap: theme.spacing[3],
    width: "100%",
  },
  handoffStack: {
    gap: theme.spacing[2],
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
    paddingHorizontal: theme.spacing[3.5],
    paddingVertical: theme.spacing[2],
    width: "100%",
  },
  compactMutedText: {
    fontSize: theme.fontSize.base,
    lineHeight: 20,
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
    lineHeight: 22,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  summaryText: {
    fontSize: theme.fontSize.base,
    lineHeight: 21,
    color: theme.colors.foregroundMuted,
  },
  taskList: {
    gap: 0,
  },
  plannedTaskRow: {
    paddingVertical: theme.spacing[3],
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
    lineHeight: 21,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  badgesRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexWrap: "wrap",
  },
  editButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
  },
  editButtonLabel: {
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
  },
  taskGoal: {
    fontSize: theme.fontSize.base,
    lineHeight: 21,
    color: theme.colors.foreground,
  },
  continuesNote: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.statusWarning,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  metaText: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
    flex: 1,
    minWidth: 0,
  },
  criteriaBox: {
    paddingLeft: theme.spacing[2],
    gap: theme.spacing[1],
  },
  criteriaHeading: {
    fontSize: 13,
    lineHeight: 19,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  criteriaItem: {
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  rememberRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  rememberLabel: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
    flex: 1,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
    paddingTop: theme.spacing[1],
  },
  errorText: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.statusDanger,
  },
  liveTaskRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  editorBox: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  editorField: {
    gap: theme.spacing[1],
  },
  editorHalfField: {
    flex: 1,
    minWidth: 140,
    gap: theme.spacing[1],
  },
  editorTwoCol: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  editorToggleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  editorToggleGroup: {
    gap: theme.spacing[1],
  },
  pillToggleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  pillToggle: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  pillToggleSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface2,
  },
  pillToggleText: {
    fontSize: 13,
    lineHeight: 18,
    color: theme.colors.foregroundMuted,
  },
  pillToggleTextSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  editorLabel: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  editorInput: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  editorMultiline: {
    minHeight: 56,
    textAlignVertical: "top",
  },
  editorActions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
