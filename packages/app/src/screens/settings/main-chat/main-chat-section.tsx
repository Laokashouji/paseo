import {
  createDefaultMainChatSettings,
  type MainChatBackgroundModelMode,
  type MainChatCapabilities,
  type MainChatIntervals,
  type MainChatSettings,
  type MainChatSettingsPatch,
  type MainChatStyle,
} from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import { Radar, Shield, Zap } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useMainChatSettingsStore } from "@/main-chat/settings-store";
import { StandingAuthPanel } from "@/main-chat/standing-auth-panel";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedShield = withUnistyles(Shield);
const ThemedZap = withUnistyles(Zap);
const ThemedRadar = withUnistyles(Radar);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const accentIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type IntervalFieldKey = keyof MainChatIntervals;
type CapabilityKey = keyof MainChatCapabilities;

interface IntervalFieldSpec {
  key: IntervalFieldKey;
  labelKey: string;
  hintKey: string;
  unitKey: string;
  min: number;
  max: number;
}

const INTERVAL_FIELDS: readonly IntervalFieldSpec[] = [
  {
    key: "patrolIntervalSec",
    labelKey: "mainChat.settings.intervals.patrolIntervalSec",
    hintKey: "mainChat.settings.intervals.patrolIntervalSecHint",
    unitKey: "mainChat.settings.units.seconds",
    min: 15,
    max: 3600,
  },
  {
    key: "triageSettleSec",
    labelKey: "mainChat.settings.intervals.triageSettleSec",
    hintKey: "mainChat.settings.intervals.triageSettleSecHint",
    unitKey: "mainChat.settings.units.seconds",
    min: 5,
    max: 300,
  },
  {
    key: "stalledThresholdMin",
    labelKey: "mainChat.settings.intervals.stalledThresholdMin",
    hintKey: "mainChat.settings.intervals.stalledThresholdMinHint",
    unitKey: "mainChat.settings.units.minutes",
    min: 2,
    max: 240,
  },
  {
    key: "noProgressThresholdMin",
    labelKey: "mainChat.settings.intervals.noProgressThresholdMin",
    hintKey: "mainChat.settings.intervals.noProgressThresholdMinHint",
    unitKey: "mainChat.settings.units.minutes",
    min: 2,
    max: 120,
  },
  {
    key: "needsYouEscalateMin",
    labelKey: "mainChat.settings.intervals.needsYouEscalateMin",
    hintKey: "mainChat.settings.intervals.needsYouEscalateMinHint",
    unitKey: "mainChat.settings.units.minutes",
    min: 1,
    max: 120,
  },
  {
    key: "wakeupCooldownMin",
    labelKey: "mainChat.settings.intervals.wakeupCooldownMin",
    hintKey: "mainChat.settings.intervals.wakeupCooldownMinHint",
    unitKey: "mainChat.settings.units.minutes",
    min: 1,
    max: 240,
  },
];

interface CapabilityFieldSpec {
  key: CapabilityKey;
  labelKey: string;
  hintKey: string;
}

const CAPABILITY_FIELDS: readonly CapabilityFieldSpec[] = [
  {
    key: "semanticTriageEnabled",
    labelKey: "mainChat.settings.capabilities.semanticTriage",
    hintKey: "mainChat.settings.capabilities.semanticTriageHint",
  },
  {
    key: "proactiveWakeupEnabled",
    labelKey: "mainChat.settings.capabilities.proactiveWakeup",
    hintKey: "mainChat.settings.capabilities.proactiveWakeupHint",
  },
  {
    key: "initialBriefingEnabled",
    labelKey: "mainChat.settings.capabilities.initialBriefing",
    hintKey: "mainChat.settings.capabilities.initialBriefingHint",
  },
  {
    key: "autoContinueManualErrors",
    labelKey: "mainChat.settings.capabilities.autoContinueManualErrors",
    hintKey: "mainChat.settings.capabilities.autoContinueManualErrorsHint",
  },
  {
    key: "autoDelegateManualQuestions",
    labelKey: "mainChat.settings.capabilities.autoDelegateManualQuestions",
    hintKey: "mainChat.settings.capabilities.autoDelegateManualQuestionsHint",
  },
  {
    key: "autoNudgeManualStalled",
    labelKey: "mainChat.settings.capabilities.autoNudgeManualStalled",
    hintKey: "mainChat.settings.capabilities.autoNudgeManualStalledHint",
  },
];

function toIntervalDrafts(intervals: MainChatIntervals): Record<IntervalFieldKey, string> {
  return {
    patrolIntervalSec: String(intervals.patrolIntervalSec),
    triageSettleSec: String(intervals.triageSettleSec),
    stalledThresholdMin: String(intervals.stalledThresholdMin),
    noProgressThresholdMin: String(intervals.noProgressThresholdMin),
    needsYouEscalateMin: String(intervals.needsYouEscalateMin),
    wakeupCooldownMin: String(intervals.wakeupCooldownMin),
  };
}

function getBackgroundModelModeHintKey(mode: MainChatBackgroundModelMode): string {
  switch (mode) {
    case "auto":
      return "mainChat.settings.backgroundModel.modeAutoHint";
    case "main":
      return "mainChat.settings.backgroundModel.modeMainHint";
    case "custom":
      return "mainChat.settings.backgroundModel.modeCustomHint";
  }
}

const StylePresetCard = memo(function StylePresetCard({
  styleKind,
  active,
  disabled,
  onSelect,
}: {
  styleKind: MainChatStyle;
  active: boolean;
  disabled: boolean;
  onSelect: (style: MainChatStyle) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onSelect(styleKind);
  }, [onSelect, styleKind]);

  const isProactive = styleKind === "proactive";
  return (
    <PressHighlight
      onPress={handlePress}
      disabled={disabled}
      style={[styles.presetCard, active && styles.presetCardActive]}
      highlightStyle={styles.presetCardPressed}
      testID={`settings-main-chat-preset-${styleKind}`}
    >
      <View style={styles.presetHeader}>
        <View style={styles.presetTitleRow}>
          {isProactive ? (
            <ThemedZap size={16} uniProps={warningIconMapping} />
          ) : (
            <ThemedShield size={16} uniProps={accentIconMapping} />
          )}
          <Text style={styles.presetTitle}>
            {t(
              isProactive
                ? "mainChat.settings.style.proactiveTitle"
                : "mainChat.settings.style.conservativeTitle",
            )}
          </Text>
        </View>
        {active ? (
          <StatusBadge
            size="xs"
            variant={isProactive ? "warning" : "success"}
            label={t("mainChat.settings.style.activeBadge")}
          />
        ) : null}
      </View>
      <Text style={styles.presetDesc}>
        {t(
          isProactive
            ? "mainChat.settings.style.proactiveDescription"
            : "mainChat.settings.style.conservativeDescription",
        )}
      </Text>
      <Text style={styles.presetMeta}>
        {t(
          isProactive
            ? "mainChat.settings.style.proactiveIntervalsSummary"
            : "mainChat.settings.style.conservativeIntervalsSummary",
        )}
      </Text>
    </PressHighlight>
  );
});

const IntervalFieldRow = memo(function IntervalFieldRow({
  field,
  index,
  committedValue,
  resetScope,
  onChange,
}: {
  field: IntervalFieldSpec;
  index: number;
  committedValue: number;
  resetScope: string;
  onChange: (key: IntervalFieldKey, text: string) => void;
}) {
  const { t } = useTranslation();
  const handleChangeText = useCallback(
    (text: string) => {
      onChange(field.key, text.replace(/[^0-9]/g, ""));
    },
    [field.key, onChange],
  );

  return (
    <View
      style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null, styles.intervalRow]}
    >
      <View style={styles.rowText}>
        <Text style={settingsStyles.rowTitle}>{t(field.labelKey)}</Text>
        <Text style={settingsStyles.rowHint}>{t(field.hintKey)}</Text>
      </View>
      <View style={styles.intervalInputWrap}>
        <FormTextInput
          size="sm"
          style={styles.numberInput}
          initialValue={String(committedValue)}
          resetKey={`${resetScope}:${committedValue}`}
          onChangeText={handleChangeText}
          keyboardType="number-pad"
          maxLength={4}
          testID={`settings-main-chat-interval-${field.key}`}
        />
        <Text style={styles.unitLabel}>{t(field.unitKey)}</Text>
      </View>
    </View>
  );
});

const CapabilityToggleRow = memo(function CapabilityToggleRow({
  field,
  index,
  value,
  disabled,
  onToggle,
}: {
  field: CapabilityFieldSpec;
  index: number;
  value: boolean;
  disabled: boolean;
  onToggle: (key: CapabilityKey, nextValue: boolean) => void;
}) {
  const { t } = useTranslation();
  const handleValueChange = useCallback(
    (nextValue: boolean) => {
      onToggle(field.key, nextValue);
    },
    [field.key, onToggle],
  );

  return (
    <View
      style={[settingsStyles.row, index > 0 ? settingsStyles.rowBorder : null, styles.toggleRow]}
    >
      <View style={styles.rowText}>
        <Text style={settingsStyles.rowTitle}>{t(field.labelKey)}</Text>
        <Text style={settingsStyles.rowHint}>{t(field.hintKey)}</Text>
      </View>
      <Switch
        value={value}
        onValueChange={handleValueChange}
        disabled={disabled}
        accessibilityLabel={t(field.labelKey)}
        testID={`settings-main-chat-cap-${field.key}`}
      />
    </View>
  );
});

function pickPreferredServerId(
  capableHosts: ReadonlyArray<{ serverId: string }>,
  current: string | null,
  activeServerId: string | undefined,
): string | null {
  if (current && capableHosts.some((host) => host.serverId === current)) {
    return current;
  }
  if (activeServerId && capableHosts.some((host) => host.serverId === activeServerId)) {
    return activeServerId;
  }
  return capableHosts[0]?.serverId ?? null;
}

const patrolIconIdle = <ThemedRadar size={14} uniProps={mutedIconMapping} />;
const patrolIconBusy = <ThemedSpinner size="small" uniProps={mutedIconMapping} />;

export function MainChatSettingsSection(): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const hosts = useHosts();
  const activeWorkspace = useActiveWorkspaceSelection();

  const capableHosts = useStoreWithEqualityFn(
    useSessionStore,
    useCallback(
      (state) =>
        hosts
          .filter((host) => {
            const session = state.sessions[host.serverId];
            return Boolean(session?.client && session.serverInfo?.features?.mainChat === true);
          })
          .map((host) => ({
            serverId: host.serverId,
            label:
              host.label || state.sessions[host.serverId]?.serverInfo?.hostname || host.serverId,
          })),
      [hosts],
    ),
    equal,
  );

  const [selectedServerId, setSelectedServerId] = useState<string | null>(() =>
    pickPreferredServerId(capableHosts, null, activeWorkspace?.serverId),
  );

  useEffect(() => {
    const next = pickPreferredServerId(capableHosts, selectedServerId, activeWorkspace?.serverId);
    if (next !== selectedServerId) {
      setSelectedServerId(next);
    }
  }, [activeWorkspace?.serverId, capableHosts, selectedServerId]);

  const client = useSessionStore((state) =>
    selectedServerId ? (state.sessions[selectedServerId]?.client ?? null) : null,
  );
  const storedSettings = useMainChatSettingsStore((state) =>
    selectedServerId ? state.settingsByServerId[selectedServerId] : undefined,
  );
  const isLoading = useMainChatSettingsStore((state) =>
    selectedServerId ? Boolean(state.loadingByServerId[selectedServerId]) : false,
  );
  const lastPatrol = useMainChatSettingsStore((state) =>
    selectedServerId ? state.lastPatrolByServerId[selectedServerId] : undefined,
  );
  const loadSettings = useMainChatSettingsStore((state) => state.loadSettings);
  const updateSettings = useMainChatSettingsStore((state) => state.updateSettings);
  const triggerPatrol = useMainChatSettingsStore((state) => state.triggerPatrol);

  const settings: MainChatSettings = useMemo(
    () => storedSettings ?? createDefaultMainChatSettings("conservative"),
    [storedSettings],
  );

  const [titleDraft, setTitleDraft] = useState(settings.title);
  const [intervalDrafts, setIntervalDrafts] = useState<Record<IntervalFieldKey, string>>(() =>
    toIntervalDrafts(settings.intervals),
  );
  const [saving, setSaving] = useState(false);
  const [patrolling, setPatrolling] = useState(false);

  useEffect(() => {
    if (!selectedServerId || !client) return;
    void loadSettings(selectedServerId, client).catch(() => undefined);
  }, [client, loadSettings, selectedServerId]);

  useEffect(() => {
    setTitleDraft(settings.title);
    setIntervalDrafts(toIntervalDrafts(settings.intervals));
  }, [settings]);

  const { entries: providerEntries, isLoading: providersLoading } = useProvidersSnapshot(
    selectedServerId,
    { enabled: Boolean(selectedServerId) },
  );

  const enabledProviders = useMemo(
    () => (providerEntries ?? []).filter((entry) => entry.enabled),
    [providerEntries],
  );

  const selectedProviderEntry = useMemo(
    () =>
      enabledProviders.find((entry) => entry.provider === settings.backgroundModel.provider) ??
      enabledProviders[0] ??
      null,
    [enabledProviders, settings.backgroundModel.provider],
  );

  const selectedModelDef = useMemo(() => {
    const models = selectedProviderEntry?.models ?? [];
    return (
      models.find((model) => model.id === settings.backgroundModel.model) ??
      models.find((model) => model.isDefault) ??
      models[0] ??
      null
    );
  }, [selectedProviderEntry, settings.backgroundModel.model]);

  const applyPatch = useCallback(
    async (patch: MainChatSettingsPatch, successMessage?: string) => {
      if (!selectedServerId || !client) return;
      setSaving(true);
      try {
        await updateSettings(selectedServerId, patch, client);
        if (successMessage) toast.show(successMessage, { variant: "success" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.settings.saveFailed"));
      } finally {
        setSaving(false);
      }
    },
    [client, selectedServerId, t, toast, updateSettings],
  );

  const handleSaveTitle = useCallback(() => {
    const trimmed = titleDraft.trim();
    if (!trimmed) return;
    void applyPatch({ title: trimmed }, t("mainChat.settings.renamedToast", { title: trimmed }));
  }, [applyPatch, t, titleDraft]);

  const handleSelectPreset = useCallback(
    (style: MainChatStyle) => {
      void applyPatch(
        { applyPreset: style },
        style === "proactive"
          ? t("mainChat.settings.switchedProactiveToast")
          : t("mainChat.settings.switchedConservativeToast"),
      );
    },
    [applyPatch, t],
  );

  const handleSelectModelMode = useCallback(
    (mode: MainChatBackgroundModelMode) => {
      if (mode === "custom") {
        const provider = selectedProviderEntry?.provider ?? settings.backgroundModel.provider;
        const model = selectedModelDef?.id ?? settings.backgroundModel.model;
        void applyPatch({
          backgroundModel: {
            mode,
            provider: provider ?? null,
            model: model ?? null,
            thinkingOptionId: settings.backgroundModel.thinkingOptionId,
          },
        });
        return;
      }
      void applyPatch({
        backgroundModel: {
          mode,
        },
      });
    },
    [applyPatch, selectedModelDef, selectedProviderEntry, settings.backgroundModel],
  );

  const handleSaveIntervals = useCallback(() => {
    const next: Partial<MainChatIntervals> = {};
    for (const field of INTERVAL_FIELDS) {
      const parsed = Number.parseInt(intervalDrafts[field.key], 10);
      if (!Number.isFinite(parsed) || parsed < field.min || parsed > field.max) {
        toast.error(
          t("mainChat.settings.intervals.invalidRange", {
            label: t(field.labelKey),
            min: field.min,
            max: field.max,
          }),
        );
        return;
      }
      next[field.key] = parsed;
    }
    void applyPatch({ intervals: next }, t("mainChat.settings.savedToast"));
  }, [applyPatch, intervalDrafts, t, toast]);

  const handleTriggerPatrol = useCallback(() => {
    if (!selectedServerId || !client || patrolling) return;
    setPatrolling(true);
    void (async () => {
      try {
        const ensured = await client.ensureMainChat();
        const result = await triggerPatrol(selectedServerId, client, {
          mainAgentId: ensured.agentId ?? undefined,
          forceWakeup: true,
        });
        toast.show(result.summary, { variant: "success" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.patrolFailed"));
      } finally {
        setPatrolling(false);
      }
    })();
  }, [client, patrolling, selectedServerId, t, toast, triggerPatrol]);

  const modelModeOptions = useMemo<SegmentedControlOption<MainChatBackgroundModelMode>[]>(
    () => [
      { value: "auto", label: t("mainChat.settings.backgroundModel.modeAuto") },
      { value: "main", label: t("mainChat.settings.backgroundModel.modeMain") },
      { value: "custom", label: t("mainChat.settings.backgroundModel.modeCustom") },
    ],
    [t],
  );

  const hostOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      capableHosts.map((host) => ({
        id: host.serverId,
        value: host.serverId,
        label: host.label,
      })),
    [capableHosts],
  );

  const hostLabelsByServerId = useMemo<Record<string, string>>(() => {
    const map: Record<string, string> = {};
    for (const host of capableHosts) {
      map[host.serverId] = host.label;
    }
    return map;
  }, [capableHosts]);

  const providerOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      enabledProviders.map((entry) => ({
        id: entry.provider,
        value: entry.provider,
        label: entry.label || entry.provider,
      })),
    [enabledProviders],
  );

  const modelOptions = useMemo<SelectFieldOption<string>[]>(
    () =>
      (selectedProviderEntry?.models ?? []).map((model) => ({
        id: model.id,
        value: model.id,
        label: model.label || model.id,
        description: model.id !== model.label ? model.id : undefined,
      })),
    [selectedProviderEntry],
  );

  const thinkingOptions = useMemo<SelectFieldOption<string>[]>(() => {
    const raw = selectedModelDef?.thinkingOptions ?? [];
    return [
      {
        id: "__default__",
        value: "",
        label: t("mainChat.settings.backgroundModel.thinkingDefault"),
      },
      ...raw.map((option) => ({
        id: option.id,
        value: option.id,
        label: option.label,
      })),
    ];
  }, [selectedModelDef, t]);

  const selectedHostDisplay = useMemo(() => {
    if (!selectedServerId) return null;
    const label =
      capableHosts.find((host) => host.serverId === selectedServerId)?.label ?? selectedServerId;
    return { label };
  }, [capableHosts, selectedServerId]);

  const selectedProviderDisplay = useMemo(
    () =>
      selectedProviderEntry
        ? { label: selectedProviderEntry.label || selectedProviderEntry.provider }
        : null,
    [selectedProviderEntry],
  );

  const selectedModelDisplay = useMemo(
    () => (selectedModelDef ? { label: selectedModelDef.label || selectedModelDef.id } : null),
    [selectedModelDef],
  );

  const selectedThinkingDisplay = useMemo(
    () => ({
      label:
        thinkingOptions.find(
          (opt) => opt.value === (settings.backgroundModel.thinkingOptionId ?? ""),
        )?.label ?? t("mainChat.settings.backgroundModel.thinkingDefault"),
    }),
    [settings.backgroundModel.thinkingOptionId, t, thinkingOptions],
  );

  const handleSelectHost = useCallback((value: string) => {
    setSelectedServerId(value);
  }, []);

  const handleSelectProvider = useCallback(
    (provider: string) => {
      const nextEntry = enabledProviders.find((entry) => entry.provider === provider);
      const nextModel =
        nextEntry?.models?.find((model) => model.isDefault)?.id ??
        nextEntry?.models?.[0]?.id ??
        null;
      void applyPatch({
        backgroundModel: {
          mode: "custom",
          provider,
          model: nextModel,
          thinkingOptionId: null,
        },
      });
    },
    [applyPatch, enabledProviders],
  );

  const handleSelectModel = useCallback(
    (model: string) => {
      void applyPatch({
        backgroundModel: {
          mode: "custom",
          provider: selectedProviderEntry?.provider ?? null,
          model,
          thinkingOptionId: null,
        },
      });
    },
    [applyPatch, selectedProviderEntry],
  );

  const handleSelectThinking = useCallback(
    (value: string) => {
      void applyPatch({
        backgroundModel: {
          mode: "custom",
          provider: selectedProviderEntry?.provider ?? null,
          model: selectedModelDef?.id ?? null,
          thinkingOptionId: value || null,
        },
      });
    },
    [applyPatch, selectedModelDef, selectedProviderEntry],
  );

  const handleIntervalDraftChange = useCallback((key: IntervalFieldKey, text: string) => {
    setIntervalDrafts((prev) => ({ ...prev, [key]: text }));
  }, []);

  const handleCapabilityToggle = useCallback(
    (key: CapabilityKey, value: boolean) => {
      void applyPatch({ capabilities: { [key]: value } });
    },
    [applyPatch],
  );

  const titleSaveDisabled = useMemo(
    () => saving || titleDraft.trim().length === 0 || titleDraft.trim() === settings.title,
    [saving, settings.title, titleDraft],
  );
  const showThinkingSelect = (selectedModelDef?.thinkingOptions?.length ?? 0) > 0;
  const hasMultipleHosts = capableHosts.length > 1;
  const patrolDisabled = patrolling || isLoading;
  const isCustomBackgroundModel = settings.backgroundModel.mode === "custom";

  if (capableHosts.length === 0) {
    return (
      <SettingsSection
        title={t("mainChat.settings.title")}
        info={t("mainChat.settings.description")}
      >
        <View style={[settingsStyles.card, styles.emptyCard]}>
          <Text style={styles.emptyText}>{t("mainChat.settings.noCapableHost")}</Text>
        </View>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection
        title={t("mainChat.settings.identity.title")}
        info={t("mainChat.settings.identity.description")}
        testID="settings-main-chat-identity"
      >
        <View style={settingsStyles.card}>
          {hasMultipleHosts ? (
            <View style={[settingsStyles.row, styles.stackedRow]}>
              <SelectField
                label={t("mainChat.settings.hostLabel")}
                value={selectedServerId}
                selectedDisplay={selectedHostDisplay}
                options={hostOptions}
                onChange={handleSelectHost}
                placeholder={t("mainChat.settings.hostLabel")}
                emptyText={t("mainChat.settings.noCapableHost")}
              />
            </View>
          ) : null}

          <View
            style={[
              settingsStyles.row,
              hasMultipleHosts ? settingsStyles.rowBorder : null,
              styles.nameRow,
            ]}
          >
            <View style={styles.rowText}>
              <Text style={settingsStyles.rowTitle}>{t("mainChat.settings.nameLabel")}</Text>
              <Text style={settingsStyles.rowHint}>{t("mainChat.settings.nameHint")}</Text>
            </View>
            <View style={styles.nameControls}>
              <FormTextInput
                size="sm"
                style={styles.nameInput}
                initialValue={settings.title}
                resetKey={`${selectedServerId ?? ""}:${settings.title}`}
                onChangeText={setTitleDraft}
                placeholder={t("mainChat.defaultTitle")}
                maxLength={40}
                returnKeyType="done"
                onSubmitEditing={handleSaveTitle}
                testID="settings-main-chat-title-input"
              />
              <Button
                variant="secondary"
                size="sm"
                onPress={handleSaveTitle}
                disabled={titleSaveDisabled}
                testID="settings-main-chat-title-save"
              >
                {t("common.save")}
              </Button>
            </View>
          </View>

          <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.actionRow]}>
            <View style={styles.rowText}>
              <Text style={settingsStyles.rowTitle}>{t("mainChat.actions.triggerPatrol")}</Text>
              <Text style={settingsStyles.rowHint}>
                {lastPatrol?.summary ?? t("mainChat.settings.patrolNowHint")}
              </Text>
            </View>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={patrolling ? patrolIconBusy : patrolIconIdle}
              onPress={handleTriggerPatrol}
              disabled={patrolDisabled}
              testID="settings-main-chat-patrol-now"
            >
              {t("mainChat.actions.triggerPatrolShort")}
            </Button>
          </View>
        </View>
      </SettingsSection>

      <SettingsSection
        title={t("mainChat.settings.style.title")}
        info={t("mainChat.settings.style.description")}
        testID="settings-main-chat-style"
      >
        <View style={styles.presetGrid}>
          <StylePresetCard
            styleKind="conservative"
            active={settings.style === "conservative"}
            disabled={saving}
            onSelect={handleSelectPreset}
          />
          <StylePresetCard
            styleKind="proactive"
            active={settings.style === "proactive"}
            disabled={saving}
            onSelect={handleSelectPreset}
          />
        </View>
      </SettingsSection>

      <SettingsSection
        title={t("mainChat.settings.backgroundModel.title")}
        info={t("mainChat.settings.backgroundModel.description")}
        testID="settings-main-chat-background-model"
      >
        <View style={settingsStyles.card}>
          <View style={[settingsStyles.row, styles.stackedRow]}>
            <SegmentedControl
              options={modelModeOptions}
              value={settings.backgroundModel.mode}
              onValueChange={handleSelectModelMode}
              testID="settings-main-chat-model-mode"
            />
            <Text style={settingsStyles.rowHint}>
              {t(getBackgroundModelModeHintKey(settings.backgroundModel.mode))}
            </Text>
          </View>

          {isCustomBackgroundModel ? (
            <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.stackedRow]}>
              <SelectField
                label={t("mainChat.settings.backgroundModel.providerLabel")}
                value={selectedProviderEntry?.provider ?? null}
                selectedDisplay={selectedProviderDisplay}
                options={providerOptions}
                loading={providersLoading}
                onChange={handleSelectProvider}
                placeholder={t("mainChat.settings.backgroundModel.providerPlaceholder")}
                emptyText={t("mainChat.settings.backgroundModel.noProviders")}
              />

              <SelectField
                label={t("mainChat.settings.backgroundModel.modelLabel")}
                value={selectedModelDef?.id ?? null}
                selectedDisplay={selectedModelDisplay}
                options={modelOptions}
                loading={providersLoading}
                searchable
                onChange={handleSelectModel}
                placeholder={t("mainChat.settings.backgroundModel.modelPlaceholder")}
                emptyText={t("mainChat.settings.backgroundModel.noModels")}
              />

              {showThinkingSelect ? (
                <SelectField
                  label={t("mainChat.settings.backgroundModel.thinkingLabel")}
                  value={settings.backgroundModel.thinkingOptionId ?? ""}
                  selectedDisplay={selectedThinkingDisplay}
                  options={thinkingOptions}
                  onChange={handleSelectThinking}
                  placeholder={t("mainChat.settings.backgroundModel.thinkingDefault")}
                  emptyText={t("mainChat.settings.backgroundModel.thinkingDefault")}
                />
              ) : null}
            </View>
          ) : null}
        </View>
      </SettingsSection>

      <SettingsSection
        title={t("mainChat.settings.intervals.title")}
        info={t("mainChat.settings.intervals.description")}
        testID="settings-main-chat-intervals"
      >
        <View style={settingsStyles.card}>
          {INTERVAL_FIELDS.map((field, index) => (
            <IntervalFieldRow
              key={field.key}
              field={field}
              index={index}
              committedValue={settings.intervals[field.key]}
              resetScope={selectedServerId ?? ""}
              onChange={handleIntervalDraftChange}
            />
          ))}
          <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.saveFooter]}>
            <Button
              variant="default"
              size="sm"
              onPress={handleSaveIntervals}
              disabled={saving}
              testID="settings-main-chat-intervals-save"
            >
              {t("mainChat.settings.intervals.saveButton")}
            </Button>
          </View>
        </View>
      </SettingsSection>

      <SettingsSection
        title={t("mainChat.settings.capabilities.title")}
        info={t("mainChat.settings.capabilities.description")}
        testID="settings-main-chat-capabilities"
      >
        <View style={settingsStyles.card}>
          {CAPABILITY_FIELDS.map((field, index) => (
            <CapabilityToggleRow
              key={field.key}
              field={field}
              index={index}
              value={settings.capabilities[field.key]}
              disabled={saving}
              onToggle={handleCapabilityToggle}
            />
          ))}
        </View>
      </SettingsSection>

      <SettingsSection
        title={t("mainChat.standingAuth.sectionTitle")}
        info={t("mainChat.standingAuth.sectionDescription")}
        testID="settings-main-chat-standing-auth"
      >
        <View style={settingsStyles.card}>
          <StandingAuthPanel
            serverId={selectedServerId}
            client={client}
            hostLabelsByServerId={hostLabelsByServerId}
            variant="settings"
          />
        </View>
      </SettingsSection>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  emptyCard: {
    padding: theme.spacing[4],
  },
  emptyText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  stackedRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  nameRow: {
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  nameControls: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  nameInput: {
    minWidth: 160,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    fontSize: theme.fontSize.sm,
  },
  actionRow: {
    gap: theme.spacing[3],
  },
  presetGrid: {
    gap: theme.spacing[3],
  },
  presetCard: {
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3.5],
    gap: theme.spacing[1.5],
  },
  presetCardActive: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface2,
  },
  presetCardPressed: {
    backgroundColor: theme.colors.surface2,
  },
  presetHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  presetTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  presetTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
  },
  presetDesc: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  presetMeta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    opacity: 0.85,
  },
  intervalRow: {
    gap: theme.spacing[3],
  },
  intervalInputWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  numberInput: {
    width: 72,
    textAlign: "right",
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    fontSize: theme.fontSize.sm,
  },
  unitLabel: {
    width: 28,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  saveFooter: {
    justifyContent: "flex-end",
  },
  toggleRow: {
    gap: theme.spacing[3],
  },
}));
