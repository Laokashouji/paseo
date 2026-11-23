import type {
  MainChatNightModeBehavior,
  MainChatNightModeConfig,
  MainChatNightModeStatus,
} from "@getpaseo/protocol/main-chat";
import { Moon } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { formatNightWindowHours } from "@/main-chat/usage-format";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedMoon = withUnistyles(Moon);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

function resolveNightStatusBadge(status: MainChatNightModeStatus | undefined): {
  variant: StatusBadgeVariant;
  labelKey: string;
} {
  if (status?.state === "hibernating") {
    return { variant: "muted", labelKey: "mainChat.nightMode.stateHibernating" };
  }
  if (status?.state === "throttled") {
    return { variant: "warning", labelKey: "mainChat.nightMode.stateThrottled" };
  }
  return { variant: "success", labelKey: "mainChat.nightMode.stateActive" };
}

export interface MainChatNightModePanelProps {
  serverId: string;
  nightMode: MainChatNightModeConfig;
  status: MainChatNightModeStatus | undefined;
  disabled: boolean;
  onUpdateNightMode: (patch: Partial<MainChatNightModeConfig>, successMessage?: string) => void;
}

export const MainChatNightModePanel = memo(function MainChatNightModePanel({
  serverId,
  nightMode,
  status,
  disabled,
  onUpdateNightMode,
}: MainChatNightModePanelProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const [startHourDraft, setStartHourDraft] = useState(String(nightMode.startHour));
  const [endHourDraft, setEndHourDraft] = useState(String(nightMode.endHour));
  const [patrolSecDraft, setPatrolSecDraft] = useState(String(nightMode.patrolIntervalSec));
  const [idleHibernateMinDraft, setIdleHibernateMinDraft] = useState(
    String(nightMode.autoHibernateAfterIdleMin),
  );

  useEffect(() => {
    setStartHourDraft(String(nightMode.startHour));
    setEndHourDraft(String(nightMode.endHour));
    setPatrolSecDraft(String(nightMode.patrolIntervalSec));
    setIdleHibernateMinDraft(String(nightMode.autoHibernateAfterIdleMin));
  }, [nightMode]);

  const behaviorOptions = useMemo<SegmentedControlOption<MainChatNightModeBehavior>[]>(
    () => [
      { value: "throttle", label: t("mainChat.nightMode.behaviorThrottle"), disabled },
      { value: "hibernate", label: t("mainChat.nightMode.behaviorHibernate"), disabled },
    ],
    [disabled, t],
  );

  const handleToggleEnabled = useCallback(
    (enabled: boolean) => {
      onUpdateNightMode(
        { enabled },
        enabled ? t("mainChat.nightMode.enabledToast") : t("mainChat.nightMode.disabledToast"),
      );
    },
    [onUpdateNightMode, t],
  );

  const handleSelectBehavior = useCallback(
    (behavior: MainChatNightModeBehavior) => {
      if (disabled) return;
      onUpdateNightMode({ behavior }, t("mainChat.settings.savedToast"));
    },
    [disabled, onUpdateNightMode, t],
  );

  const handleToggleDisableTriage = useCallback(
    (disableSemanticTriage: boolean) => {
      onUpdateNightMode({ disableSemanticTriage });
    },
    [onUpdateNightMode],
  );

  const handleToggleDeferWakeups = useCallback(
    (deferProactiveWakeups: boolean) => {
      onUpdateNightMode({ deferProactiveWakeups });
    },
    [onUpdateNightMode],
  );

  const handleToggleAllowUrgent = useCallback(
    (allowUrgentWakeups: boolean) => {
      onUpdateNightMode({ allowUrgentWakeups });
    },
    [onUpdateNightMode],
  );

  const handleSaveSchedule = useCallback(() => {
    const startHour = Number.parseInt(startHourDraft, 10);
    const endHour = Number.parseInt(endHourDraft, 10);
    const patrolIntervalSec = Number.parseInt(patrolSecDraft, 10);
    const autoHibernateAfterIdleMin = Number.parseInt(idleHibernateMinDraft, 10);

    if (!Number.isFinite(startHour) || startHour < 0 || startHour > 23) {
      toast.error(t("mainChat.nightMode.invalidHourRange"));
      return;
    }
    if (!Number.isFinite(endHour) || endHour < 0 || endHour > 23) {
      toast.error(t("mainChat.nightMode.invalidHourRange"));
      return;
    }
    if (!Number.isFinite(patrolIntervalSec) || patrolIntervalSec < 60 || patrolIntervalSec > 7200) {
      toast.error(
        t("mainChat.settings.intervals.invalidRange", {
          label: t("mainChat.nightMode.patrolIntervalSecLabel"),
          min: 60,
          max: 7200,
        }),
      );
      return;
    }
    if (
      !Number.isFinite(autoHibernateAfterIdleMin) ||
      autoHibernateAfterIdleMin < 0 ||
      autoHibernateAfterIdleMin > 480
    ) {
      toast.error(
        t("mainChat.settings.intervals.invalidRange", {
          label: t("mainChat.nightMode.autoHibernateIdleLabel"),
          min: 0,
          max: 480,
        }),
      );
      return;
    }

    onUpdateNightMode(
      {
        startHour,
        endHour,
        patrolIntervalSec,
        autoHibernateAfterIdleMin,
      },
      t("mainChat.settings.savedToast"),
    );
  }, [
    endHourDraft,
    idleHibernateMinDraft,
    onUpdateNightMode,
    patrolSecDraft,
    startHourDraft,
    t,
    toast,
  ]);

  const { variant: badgeVariant, labelKey: stateLabelKey } = resolveNightStatusBadge(status);
  const stateLabel = t(stateLabelKey);

  return (
    <View style={settingsStyles.card} testID="settings-main-chat-night-mode-card">
      <View style={[settingsStyles.row, styles.switchRow]}>
        <View style={styles.rowText}>
          <View style={styles.titleWithBadge}>
            <ThemedMoon size={15} uniProps={mutedIconMapping} />
            <Text style={settingsStyles.rowTitle}>{t("mainChat.nightMode.enableTitle")}</Text>
            {nightMode.enabled ? (
              <StatusBadge size="xs" variant={badgeVariant} label={stateLabel} />
            ) : null}
          </View>
          <Text style={settingsStyles.rowHint}>
            {nightMode.enabled
              ? (status?.reason ??
                t("mainChat.nightMode.windowActiveSummary", {
                  window: formatNightWindowHours(nightMode.startHour, nightMode.endHour),
                }))
              : t("mainChat.nightMode.enableHint")}
          </Text>
        </View>
        <Switch
          value={nightMode.enabled}
          disabled={disabled}
          onValueChange={handleToggleEnabled}
          testID="settings-main-chat-night-enabled"
        />
      </View>

      {nightMode.enabled ? (
        <>
          <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.stackedRow]}>
            <Text style={settingsStyles.rowTitle}>{t("mainChat.nightMode.behaviorLabel")}</Text>
            <SegmentedControl
              value={nightMode.behavior}
              options={behaviorOptions}
              onValueChange={handleSelectBehavior}
              testID="settings-main-chat-night-behavior"
            />
            <Text style={settingsStyles.rowHint}>
              {nightMode.behavior === "hibernate"
                ? t("mainChat.nightMode.behaviorHibernateHint")
                : t("mainChat.nightMode.behaviorThrottleHint")}
            </Text>
          </View>

          <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.stackedRow]}>
            <View style={styles.numericRow}>
              <View style={styles.rowText}>
                <Text style={settingsStyles.rowTitle}>{t("mainChat.nightMode.windowLabel")}</Text>
                <Text style={settingsStyles.rowHint}>{t("mainChat.nightMode.windowHint")}</Text>
              </View>
              <View style={styles.windowInputs}>
                <FormTextInput
                  size="sm"
                  style={styles.hourInput}
                  initialValue={String(nightMode.startHour)}
                  resetKey={`${serverId}:night-start:${nightMode.startHour}`}
                  onChangeText={setStartHourDraft}
                  keyboardType="numeric"
                  maxLength={2}
                  testID="settings-main-chat-night-start-hour"
                />
                <Text style={styles.hourSep}>:00 —</Text>
                <FormTextInput
                  size="sm"
                  style={styles.hourInput}
                  initialValue={String(nightMode.endHour)}
                  resetKey={`${serverId}:night-end:${nightMode.endHour}`}
                  onChangeText={setEndHourDraft}
                  keyboardType="numeric"
                  maxLength={2}
                  testID="settings-main-chat-night-end-hour"
                />
                <Text style={styles.hourSep}>:00</Text>
              </View>
            </View>

            {nightMode.behavior === "throttle" ? (
              <>
                <View style={styles.numericRow}>
                  <View style={styles.rowText}>
                    <Text style={settingsStyles.rowTitle}>
                      {t("mainChat.nightMode.patrolIntervalSecLabel")}
                    </Text>
                    <Text style={settingsStyles.rowHint}>
                      {t("mainChat.nightMode.patrolIntervalSecHint")}
                    </Text>
                  </View>
                  <View style={styles.unitGroup}>
                    <FormTextInput
                      size="sm"
                      style={styles.numberInput}
                      initialValue={String(nightMode.patrolIntervalSec)}
                      resetKey={`${serverId}:night-patrol:${nightMode.patrolIntervalSec}`}
                      onChangeText={setPatrolSecDraft}
                      keyboardType="numeric"
                      maxLength={4}
                      testID="settings-main-chat-night-patrol-sec"
                    />
                    <Text style={styles.unitLabel}>{t("mainChat.settings.units.seconds")}</Text>
                  </View>
                </View>

                <View style={styles.numericRow}>
                  <View style={styles.rowText}>
                    <Text style={settingsStyles.rowTitle}>
                      {t("mainChat.nightMode.autoHibernateIdleLabel")}
                    </Text>
                    <Text style={settingsStyles.rowHint}>
                      {t("mainChat.nightMode.autoHibernateIdleHint")}
                    </Text>
                  </View>
                  <View style={styles.unitGroup}>
                    <FormTextInput
                      size="sm"
                      style={styles.numberInput}
                      initialValue={String(nightMode.autoHibernateAfterIdleMin)}
                      resetKey={`${serverId}:night-idle:${nightMode.autoHibernateAfterIdleMin}`}
                      onChangeText={setIdleHibernateMinDraft}
                      keyboardType="numeric"
                      maxLength={3}
                      testID="settings-main-chat-night-idle-min"
                    />
                    <Text style={styles.unitLabel}>{t("mainChat.settings.units.minutes")}</Text>
                  </View>
                </View>
              </>
            ) : null}

            <View style={styles.saveFooter}>
              <Button
                variant="secondary"
                size="sm"
                onPress={handleSaveSchedule}
                disabled={disabled}
                testID="settings-main-chat-night-save"
              >
                {t("mainChat.nightMode.saveScheduleButton")}
              </Button>
            </View>
          </View>

          {nightMode.behavior === "throttle" ? (
            <>
              <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.switchRow]}>
                <View style={styles.rowText}>
                  <Text style={settingsStyles.rowTitle}>
                    {t("mainChat.nightMode.disableTriageTitle")}
                  </Text>
                  <Text style={settingsStyles.rowHint}>
                    {t("mainChat.nightMode.disableTriageHint")}
                  </Text>
                </View>
                <Switch
                  value={nightMode.disableSemanticTriage}
                  disabled={disabled}
                  onValueChange={handleToggleDisableTriage}
                  testID="settings-main-chat-night-disable-triage"
                />
              </View>

              <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.switchRow]}>
                <View style={styles.rowText}>
                  <Text style={settingsStyles.rowTitle}>
                    {t("mainChat.nightMode.deferWakeupsTitle")}
                  </Text>
                  <Text style={settingsStyles.rowHint}>
                    {t("mainChat.nightMode.deferWakeupsHint")}
                  </Text>
                </View>
                <Switch
                  value={nightMode.deferProactiveWakeups}
                  disabled={disabled}
                  onValueChange={handleToggleDeferWakeups}
                  testID="settings-main-chat-night-defer-wakeups"
                />
              </View>
            </>
          ) : null}

          <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.switchRow]}>
            <View style={styles.rowText}>
              <Text style={settingsStyles.rowTitle}>
                {t("mainChat.nightMode.allowUrgentTitle")}
              </Text>
              <Text style={settingsStyles.rowHint}>{t("mainChat.nightMode.allowUrgentHint")}</Text>
            </View>
            <Switch
              value={nightMode.allowUrgentWakeups}
              disabled={disabled}
              onValueChange={handleToggleAllowUrgent}
              testID="settings-main-chat-night-allow-urgent"
            />
          </View>
        </>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  switchRow: {
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  titleWithBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexWrap: "wrap",
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  stackedRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: 10,
  },
  numericRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  windowInputs: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  hourInput: {
    width: 48,
    textAlign: "center",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[1.5],
  },
  hourSep: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  unitGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  numberInput: {
    width: 78,
    textAlign: "right",
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
  },
  unitLabel: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    minWidth: 28,
  },
  saveFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
}));
