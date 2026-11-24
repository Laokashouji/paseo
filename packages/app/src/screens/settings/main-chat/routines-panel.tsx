import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { MainChatRoutineRecord } from "@getpaseo/protocol/main-chat";
import { Clock, Pause, Play, Plus, RefreshCw, Trash2, Zap } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { useToast } from "@/contexts/toast-context";
import {
  EMPTY_CONVERSATIONS,
  useMainChatConversationsStore,
} from "@/main-chat/conversations-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedClock = withUnistyles(Clock);
const ThemedPlus = withUnistyles(Plus);
const ThemedRefresh = withUnistyles(RefreshCw);
const ThemedPause = withUnistyles(Pause);
const ThemedPlay = withUnistyles(Play);
const ThemedZap = withUnistyles(Zap);
const ThemedTrash = withUnistyles(Trash2);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const REFRESH_ICON = <ThemedRefresh size={13} uniProps={mutedIconMapping} />;
const PLUS_ICON = <ThemedPlus size={13} uniProps={mutedIconMapping} />;
const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

type RoutineScheduleMode = "every" | "cron" | "one_shot";

function prependRoutine(
  list: readonly MainChatRoutineRecord[],
  created: MainChatRoutineRecord,
): MainChatRoutineRecord[] {
  return [created, ...list.filter((r) => r.id !== created.id)];
}

function replaceRoutine(
  list: readonly MainChatRoutineRecord[],
  updated: MainChatRoutineRecord,
): MainChatRoutineRecord[] {
  return list.map((r) => (r.id === updated.id ? updated : r));
}

function removeRoutine(
  list: readonly MainChatRoutineRecord[],
  routineId: string,
): MainChatRoutineRecord[] {
  return list.filter((r) => r.id !== routineId);
}

function buildRoutineCreatePayload(input: {
  scheduleMode: RoutineScheduleMode;
  nameDraft: string;
  promptDraft: string;
  everyMinDraft: string;
  cronDraft: string;
  delayMinDraft: string;
  ownerConversationId: string;
}):
  | { ok: true; payload: Parameters<DaemonClient["createMainChatRoutine"]>[0] }
  | { ok: false; errorKey: string } {
  const prompt = input.promptDraft.trim();
  if (!prompt) return { ok: false, errorKey: "mainChat.routines.invalidPrompt" };

  const baseInput = {
    ...(input.nameDraft.trim() ? { name: input.nameDraft.trim() } : {}),
    prompt,
    ...(input.ownerConversationId && input.ownerConversationId !== "conv_main"
      ? { conversationId: input.ownerConversationId }
      : {}),
  };

  if (input.scheduleMode === "one_shot") {
    const delayMinutes = Number.parseInt(input.delayMinDraft.trim(), 10);
    if (!Number.isFinite(delayMinutes) || delayMinutes <= 0) {
      return { ok: false, errorKey: "mainChat.routines.invalidInterval" };
    }
    return { ok: true, payload: { ...baseInput, kind: "one_shot", delayMinutes } };
  }
  if (input.scheduleMode === "cron") {
    const expression = input.cronDraft.trim();
    if (!expression) return { ok: false, errorKey: "mainChat.routines.invalidCron" };
    return {
      ok: true,
      payload: { ...baseInput, kind: "recurring", cadence: { type: "cron", expression } },
    };
  }
  const minutes = Number.parseInt(input.everyMinDraft.trim(), 10);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    return { ok: false, errorKey: "mainChat.routines.invalidInterval" };
  }
  return {
    ok: true,
    payload: {
      ...baseInput,
      kind: "recurring",
      cadence: { type: "every", everyMs: minutes * 60_000 },
    },
  };
}

function formatShortTime(iso: string | null): string {
  if (!iso) return "—";
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  try {
    return new Date(parsed).toLocaleString([], {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatCadenceLabel(
  routine: MainChatRoutineRecord,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (routine.cadence.type === "cron") {
    return t("mainChat.routines.cadenceCron", { expression: routine.cadence.expression });
  }
  const minutes = Math.max(1, Math.round(routine.cadence.everyMs / 60_000));
  if (minutes >= 60 && minutes % 60 === 0) {
    return t("mainChat.routines.cadenceEveryHours", { hours: minutes / 60 });
  }
  return t("mainChat.routines.cadenceEveryMinutes", { minutes });
}

function statusBadgeVariantOf(status: MainChatRoutineRecord["status"]): StatusBadgeVariant {
  if (status === "active") return "success";
  if (status === "paused") return "warning";
  return "muted";
}

function statusLabelKeyOf(status: MainChatRoutineRecord["status"]): string {
  if (status === "active") return "mainChat.routines.statusActive";
  if (status === "paused") return "mainChat.routines.statusPaused";
  return "mainChat.routines.statusCompleted";
}

const OwnerChip = memo(function OwnerChip({
  id,
  label,
  selected,
  disabled,
  onSelect,
}: {
  id: string;
  label: string;
  selected: boolean;
  disabled: boolean;
  onSelect: (id: string) => void;
}): ReactElement {
  const handlePress = useCallback(() => {
    onSelect(id);
  }, [id, onSelect]);
  const chipStyle = useMemo(
    () => (selected ? [styles.ownerChip, styles.ownerChipActive] : styles.ownerChip),
    [selected],
  );
  const textStyle = useMemo(
    () => (selected ? [styles.ownerChipText, styles.ownerChipTextActive] : styles.ownerChipText),
    [selected],
  );

  return (
    <PressHighlight
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      style={chipStyle}
      highlightStyle={styles.subtleHighlight}
      testID={`routine-owner-chip-${id}`}
    >
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
});

const RoutineRow = memo(function RoutineRow({
  routine,
  index,
  busyId,
  confirmDeleteId,
  disabled,
  onPause,
  onResume,
  onRunOnce,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
}: {
  routine: MainChatRoutineRecord;
  index: number;
  busyId: string | null;
  confirmDeleteId: string | null;
  disabled: boolean;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRunOnce: (id: string) => void;
  onRequestDelete: (id: string) => void;
  onConfirmDelete: (id: string) => void;
  onCancelDelete: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const isBusy = busyId === routine.id;
  const isConfirmingDelete = confirmDeleteId === routine.id;
  const isCompleted = routine.status === "completed";
  const isPaused = routine.status === "paused";
  const displayTitle = routine.name?.trim() || routine.prompt.slice(0, 36);

  const handlePauseOrResume = useCallback(() => {
    if (isPaused) onResume(routine.id);
    else onPause(routine.id);
  }, [isPaused, onPause, onResume, routine.id]);

  const handleRunOnce = useCallback(() => {
    onRunOnce(routine.id);
  }, [onRunOnce, routine.id]);

  const handleRequestDelete = useCallback(() => {
    onRequestDelete(routine.id);
  }, [onRequestDelete, routine.id]);

  const handleConfirmDelete = useCallback(() => {
    onConfirmDelete(routine.id);
  }, [onConfirmDelete, routine.id]);

  return (
    <View
      style={[styles.routineRow, index > 0 && styles.routineRowBorder]}
      testID={`routine-row-${routine.id}`}
    >
      <View style={styles.routineHeader}>
        <View style={styles.routineTitleWrap}>
          <ThemedClock size={14} uniProps={mutedIconMapping} />
          <Text style={styles.routineTitle} numberOfLines={1} ellipsizeMode="tail">
            {displayTitle}
          </Text>
        </View>
        <View style={styles.badgesRow}>
          <StatusBadge
            variant={statusBadgeVariantOf(routine.status)}
            size="xs"
            label={t(statusLabelKeyOf(routine.status))}
          />
          <StatusBadge
            variant="muted"
            size="xs"
            label={
              routine.kind === "one_shot"
                ? t("mainChat.routines.kindOneShot")
                : t("mainChat.routines.kindRecurring")
            }
          />
          <StatusBadge
            variant="muted"
            size="xs"
            label={
              routine.ownerKind === "leader"
                ? routine.conversationTitle
                : t("mainChat.routines.ownerMain")
            }
          />
        </View>
      </View>

      <Text style={styles.routinePrompt} numberOfLines={2}>
        {routine.prompt}
      </Text>

      <View style={styles.metaRow}>
        <Text style={styles.metaText}>{formatCadenceLabel(routine, t)}</Text>
        {routine.nextRunAt ? (
          <Text style={styles.metaText}>
            {t("mainChat.routines.nextRunMeta", { time: formatShortTime(routine.nextRunAt) })}
          </Text>
        ) : null}
        {routine.lastRunAt ? (
          <Text style={styles.metaText}>
            {t("mainChat.routines.lastRunMeta", {
              time: formatShortTime(routine.lastRunAt),
              count: routine.runCount,
            })}
          </Text>
        ) : null}
        {!routine.lastRunAt && routine.runCount > 0 ? (
          <Text style={styles.metaText}>
            {t("mainChat.routines.runCountOnly", { count: routine.runCount })}
          </Text>
        ) : null}
      </View>

      <View style={styles.rowActions}>
        {!isCompleted ? (
          <PressHighlight
            onPress={handlePauseOrResume}
            disabled={disabled || isBusy}
            style={styles.actionChip}
            highlightStyle={styles.subtleHighlight}
            accessibilityRole="button"
            testID={`routine-toggle-pause-${routine.id}`}
          >
            {isPaused ? (
              <ThemedPlay size={12} uniProps={mutedIconMapping} />
            ) : (
              <ThemedPause size={12} uniProps={mutedIconMapping} />
            )}
            <Text style={styles.actionChipText}>
              {isPaused ? t("mainChat.routines.resumeButton") : t("mainChat.routines.pauseButton")}
            </Text>
          </PressHighlight>
        ) : null}

        {!isCompleted ? (
          <PressHighlight
            onPress={handleRunOnce}
            disabled={disabled || isBusy}
            style={styles.actionChip}
            highlightStyle={styles.subtleHighlight}
            accessibilityRole="button"
            testID={`routine-run-once-${routine.id}`}
          >
            <ThemedZap size={12} uniProps={mutedIconMapping} />
            <Text style={styles.actionChipText}>{t("mainChat.routines.runOnceButton")}</Text>
          </PressHighlight>
        ) : null}

        {isConfirmingDelete ? (
          <>
            <PressHighlight
              onPress={handleConfirmDelete}
              disabled={disabled || isBusy}
              style={[styles.actionChip, styles.actionChipDanger]}
              highlightStyle={styles.subtleHighlight}
              accessibilityRole="button"
              testID={`routine-confirm-delete-${routine.id}`}
            >
              <Text style={styles.actionChipDangerText}>
                {t("mainChat.routines.confirmDeleteButton")}
              </Text>
            </PressHighlight>
            <PressHighlight
              onPress={onCancelDelete}
              disabled={disabled || isBusy}
              style={styles.actionChip}
              highlightStyle={styles.subtleHighlight}
              accessibilityRole="button"
              testID={`routine-cancel-delete-${routine.id}`}
            >
              <Text style={styles.actionChipText}>{t("mainChat.routines.cancelButton")}</Text>
            </PressHighlight>
          </>
        ) : (
          <PressHighlight
            onPress={handleRequestDelete}
            disabled={disabled || isBusy}
            style={styles.actionChip}
            highlightStyle={styles.subtleHighlight}
            accessibilityRole="button"
            testID={`routine-delete-${routine.id}`}
          >
            <ThemedTrash size={12} uniProps={dangerIconMapping} />
            <Text style={styles.actionChipDangerText}>{t("mainChat.routines.deleteButton")}</Text>
          </PressHighlight>
        )}
      </View>
    </View>
  );
});

export interface MainChatRoutinesPanelProps {
  serverId: string;
  client: DaemonClient | null;
  disabled: boolean;
}

/**
 * Main Chat Settings panel for P0-4: manages recurring routines and one-shot reminders backed by
 * Paseo's Schedule / Heartbeat service (list, create, pause/resume, run once, delete).
 */
export const MainChatRoutinesPanel = memo(function MainChatRoutinesPanel({
  serverId,
  client,
  disabled,
}: MainChatRoutinesPanelProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const conversations = useMainChatConversationsStore(
    (state) => state.conversationsByServerId[serverId] ?? EMPTY_CONVERSATIONS,
  );
  const leaders = useMemo(
    () => conversations.filter((conv) => conv.kind === "leader" && !conv.archivedAt),
    [conversations],
  );

  const [routines, setRoutines] = useState<MainChatRoutineRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [creatingOpen, setCreatingOpen] = useState(false);
  const [submittingCreate, setSubmittingCreate] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [formResetNonce, setFormResetNonce] = useState(0);

  const [nameDraft, setNameDraft] = useState("");
  const [promptDraft, setPromptDraft] = useState("");
  const [scheduleMode, setScheduleMode] = useState<RoutineScheduleMode>("every");
  const [everyMinDraft, setEveryMinDraft] = useState("60");
  const [cronDraft, setCronDraft] = useState("0 9 * * 1-5");
  const [delayMinDraft, setDelayMinDraft] = useState("30");
  const [ownerConversationId, setOwnerConversationId] = useState("conv_main");

  const loadRoutines = useCallback(async () => {
    if (!client || typeof client.listMainChatRoutines !== "function") return;
    setLoading(true);
    try {
      const response = await client.listMainChatRoutines({ includeCompleted: true });
      if (response.error) {
        toast.error(response.error);
        return;
      }
      setRoutines(response.routines);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("mainChat.routines.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [client, t, toast]);

  useEffect(() => {
    void loadRoutines();
  }, [loadRoutines, serverId]);

  const handleOpenCreate = useCallback(() => {
    setCreatingOpen(true);
    setNameDraft("");
    setPromptDraft("");
    setScheduleMode("every");
    setEveryMinDraft("60");
    setCronDraft("0 9 * * 1-5");
    setDelayMinDraft("30");
    setOwnerConversationId("conv_main");
    setFormResetNonce((n) => n + 1);
  }, []);

  const handleCancelCreate = useCallback(() => {
    setCreatingOpen(false);
  }, []);

  const handleCreateSubmit = useCallback(async () => {
    if (!client || typeof client.createMainChatRoutine !== "function" || submittingCreate) return;
    const built = buildRoutineCreatePayload({
      scheduleMode,
      nameDraft,
      promptDraft,
      everyMinDraft,
      cronDraft,
      delayMinDraft,
      ownerConversationId,
    });
    if (!built.ok) {
      toast.error(t(built.errorKey));
      return;
    }

    setSubmittingCreate(true);
    try {
      const response = await client.createMainChatRoutine(built.payload);
      if (response.error || !response.routine) {
        throw new Error(response.error ?? t("mainChat.routines.actionFailed"));
      }
      const created = response.routine;
      setRoutines((prev) => prependRoutine(prev, created));
      setCreatingOpen(false);
      toast.show(t("mainChat.routines.createdToast", { name: created.name ?? created.id }), {
        variant: "success",
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("mainChat.routines.actionFailed"));
    } finally {
      setSubmittingCreate(false);
    }
  }, [
    client,
    cronDraft,
    delayMinDraft,
    everyMinDraft,
    nameDraft,
    ownerConversationId,
    promptDraft,
    scheduleMode,
    submittingCreate,
    t,
    toast,
  ]);

  const runRoutineMutation = useCallback(
    async (
      routineId: string,
      action: () => Promise<{ routine: MainChatRoutineRecord | null; error: string | null }>,
      successToastKey: string,
    ) => {
      setBusyId(routineId);
      try {
        const response = await action();
        if (response.error || !response.routine) {
          throw new Error(response.error ?? t("mainChat.routines.actionFailed"));
        }
        const updated = response.routine;
        setRoutines((prev) => replaceRoutine(prev, updated));
        toast.show(t(successToastKey), { variant: "success" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.routines.actionFailed"));
      } finally {
        setBusyId(null);
      }
    },
    [t, toast],
  );

  const handlePause = useCallback(
    (routineId: string) => {
      if (!client || typeof client.pauseMainChatRoutine !== "function") return;
      void runRoutineMutation(
        routineId,
        () => client.pauseMainChatRoutine(routineId),
        "mainChat.routines.pausedToast",
      );
    },
    [client, runRoutineMutation],
  );

  const handleResume = useCallback(
    (routineId: string) => {
      if (!client || typeof client.resumeMainChatRoutine !== "function") return;
      void runRoutineMutation(
        routineId,
        () => client.resumeMainChatRoutine(routineId),
        "mainChat.routines.resumedToast",
      );
    },
    [client, runRoutineMutation],
  );

  const handleRunOnce = useCallback(
    (routineId: string) => {
      if (!client || typeof client.runMainChatRoutineOnce !== "function") return;
      void runRoutineMutation(
        routineId,
        () => client.runMainChatRoutineOnce(routineId),
        "mainChat.routines.ranOnceToast",
      );
    },
    [client, runRoutineMutation],
  );

  const handleConfirmDelete = useCallback(
    async (routineId: string) => {
      if (!client || typeof client.deleteMainChatRoutine !== "function") return;
      setBusyId(routineId);
      try {
        const response = await client.deleteMainChatRoutine(routineId);
        if (response.error) {
          throw new Error(response.error);
        }
        setRoutines((prev) => removeRoutine(prev, routineId));
        setConfirmDeleteId(null);
        toast.show(t("mainChat.routines.deletedToast"), { variant: "success" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.routines.actionFailed"));
      } finally {
        setBusyId(null);
      }
    },
    [client, t, toast],
  );

  const handleCancelDelete = useCallback(() => {
    setConfirmDeleteId(null);
  }, []);

  const scheduleModeOptions = useMemo<SegmentedControlOption<RoutineScheduleMode>[]>(
    () => [
      { value: "every", label: t("mainChat.routines.scheduleTypeEvery") },
      { value: "cron", label: t("mainChat.routines.scheduleTypeCron") },
      { value: "one_shot", label: t("mainChat.routines.scheduleTypeOneShot") },
    ],
    [t],
  );

  return (
    <View style={settingsStyles.card} testID="main-chat-routines-panel">
      <View style={[settingsStyles.row, styles.headerBar]}>
        <View style={styles.headerActions}>
          <Button
            variant="secondary"
            size="sm"
            leftIcon={REFRESH_ICON}
            onPress={loadRoutines}
            disabled={disabled || loading || !client}
            testID="routines-refresh-button"
          >
            {t("mainChat.routines.refreshButton")}
          </Button>
          <Button
            variant="default"
            size="sm"
            leftIcon={PLUS_ICON}
            onPress={handleOpenCreate}
            disabled={disabled || !client}
            testID="routines-new-button"
          >
            {t("mainChat.routines.newButton")}
          </Button>
        </View>
      </View>

      {creatingOpen ? (
        <View
          style={[settingsStyles.row, settingsStyles.rowBorder, styles.createForm]}
          testID="routines-create-form"
        >
          <SegmentedControl
            size="sm"
            options={scheduleModeOptions}
            value={scheduleMode}
            onValueChange={setScheduleMode}
            testID="routines-schedule-mode"
          />

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>{t("mainChat.routines.nameLabel")}</Text>
            <FormTextInput
              size="sm"
              initialValue=""
              resetKey={`${serverId}:r-name:${formResetNonce}`}
              onChangeText={setNameDraft}
              placeholder={t("mainChat.routines.namePlaceholder")}
              maxLength={80}
              testID="routines-name-input"
            />
          </View>

          {scheduleMode === "every" ? (
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>{t("mainChat.routines.everyMinutesLabel")}</Text>
              <FormTextInput
                size="sm"
                style={styles.compactInput}
                initialValue="60"
                resetKey={`${serverId}:r-every:${formResetNonce}`}
                onChangeText={setEveryMinDraft}
                placeholder={t("mainChat.routines.everyMinutesPlaceholder")}
                keyboardType="number-pad"
                maxLength={5}
                testID="routines-every-minutes-input"
              />
            </View>
          ) : null}
          {scheduleMode === "cron" ? (
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>{t("mainChat.routines.cronExpressionLabel")}</Text>
              <FormTextInput
                size="sm"
                initialValue="0 9 * * 1-5"
                resetKey={`${serverId}:r-cron:${formResetNonce}`}
                onChangeText={setCronDraft}
                placeholder={t("mainChat.routines.cronExpressionPlaceholder")}
                testID="routines-cron-input"
              />
            </View>
          ) : null}
          {scheduleMode === "one_shot" ? (
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>{t("mainChat.routines.delayMinutesLabel")}</Text>
              <FormTextInput
                size="sm"
                style={styles.compactInput}
                initialValue="30"
                resetKey={`${serverId}:r-delay:${formResetNonce}`}
                onChangeText={setDelayMinDraft}
                placeholder={t("mainChat.routines.delayMinutesPlaceholder")}
                keyboardType="number-pad"
                maxLength={5}
                testID="routines-delay-minutes-input"
              />
            </View>
          ) : null}

          {leaders.length > 0 ? (
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>{t("mainChat.routines.ownerLabel")}</Text>
              <View style={styles.ownerChipsWrap}>
                <OwnerChip
                  id="conv_main"
                  label={t("mainChat.routines.ownerMain")}
                  selected={ownerConversationId === "conv_main"}
                  disabled={submittingCreate}
                  onSelect={setOwnerConversationId}
                />
                {leaders.map((leader) => (
                  <OwnerChip
                    key={leader.id}
                    id={leader.id}
                    label={leader.title}
                    selected={ownerConversationId === leader.id}
                    disabled={submittingCreate}
                    onSelect={setOwnerConversationId}
                  />
                ))}
              </View>
            </View>
          ) : null}

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>{t("mainChat.routines.promptLabel")}</Text>
            <FormTextInput
              size="sm"
              multiline
              style={styles.promptTextarea}
              initialValue=""
              resetKey={`${serverId}:r-prompt:${formResetNonce}`}
              onChangeText={setPromptDraft}
              placeholder={t("mainChat.routines.promptPlaceholder")}
              testID="routines-prompt-input"
            />
          </View>

          <View style={styles.formButtons}>
            <Button
              variant="default"
              size="sm"
              onPress={handleCreateSubmit}
              disabled={disabled || submittingCreate}
              loading={submittingCreate}
              testID="routines-create-submit"
            >
              {t("mainChat.routines.createSubmitButton")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onPress={handleCancelCreate}
              disabled={submittingCreate}
              testID="routines-create-cancel"
            >
              {t("mainChat.routines.cancelButton")}
            </Button>
          </View>
        </View>
      ) : null}

      {routines.length === 0 ? (
        <View
          style={[settingsStyles.row, settingsStyles.rowBorder, styles.emptyBox]}
          testID="routines-empty-state"
        >
          <Text style={styles.emptyText}>{t("mainChat.routines.emptyState")}</Text>
        </View>
      ) : (
        <View style={[styles.listWrap, settingsStyles.rowBorder]}>
          {routines.map((routine, index) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              index={index}
              busyId={busyId}
              confirmDeleteId={confirmDeleteId}
              disabled={disabled}
              onPause={handlePause}
              onResume={handleResume}
              onRunOnce={handleRunOnce}
              onRequestDelete={setConfirmDeleteId}
              onConfirmDelete={handleConfirmDelete}
              onCancelDelete={handleCancelDelete}
            />
          ))}
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  headerBar: {
    justifyContent: "flex-end",
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  createForm: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  fieldGroup: {
    gap: theme.spacing[1],
  },
  fieldLabel: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
  compactInput: {
    width: 140,
  },
  promptTextarea: {
    minHeight: 72,
    textAlignVertical: "top",
  },
  ownerChipsWrap: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  ownerChip: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  ownerChipActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface2,
  },
  ownerChipText: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
  ownerChipTextActive: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  formButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  emptyBox: {
    paddingVertical: theme.spacing[4],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
  listWrap: {
    width: "100%",
  },
  routineRow: {
    width: "100%",
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
  },
  routineRowBorder: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  routineHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  routineTitleWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flex: 1,
    minWidth: 0,
  },
  routineTitle: {
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  badgesRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  routinePrompt: {
    fontSize: theme.fontSize.sm,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  metaText: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.foregroundMuted,
  },
  rowActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  actionChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  actionChipDanger: {
    borderColor: theme.colors.destructive,
  },
  actionChipText: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.foreground,
  },
  actionChipDangerText: {
    fontSize: 12,
    lineHeight: 16,
    color: theme.colors.destructive,
  },
  subtleHighlight: {
    backgroundColor: theme.colors.surface2,
  },
}));
