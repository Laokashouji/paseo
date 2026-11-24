import {
  createDefaultMainChatSettings,
  isMainChatEnabled,
  resolveMainChatNightMode,
  type MainChatBackgroundModelMode,
  type MainChatIntervals,
  type MainChatMetrics,
  type MainChatNightModeConfig,
  type MainChatNightModeStatus,
  type MainChatSettings,
  type MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import equal from "fast-deep-equal";
import { Power, Radar } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { SelectField, type SelectFieldOption } from "@/components/ui/select-field";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { overviewStoreKey, useMainChatOverviewStore } from "@/main-chat/overview-store";
import { findMainChatAgentOnHost } from "@/main-chat/selectors";
import { useMainChatSettingsStore } from "@/main-chat/settings-store";
import { StandingAuthPanel } from "@/main-chat/standing-auth-panel";
import {
  MAIN_CHAT_CAPABILITY_FIELDS,
  MAIN_CHAT_INTERVAL_FIELDS,
  type MainChatCapabilityFieldKey,
  type MainChatCapabilityFieldSpec,
  type MainChatIntervalFieldKey,
  type MainChatIntervalFieldSpec,
} from "@/main-chat/style-presets";
import { useHosts } from "@/runtime/host-runtime";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { MainChatFleetScopePanel } from "./fleet-scope-panel";
import { MainChatNightModePanel } from "./night-mode-panel";
import { MainChatStewardConflictsBanner, MainChatStewardRosterPanel } from "./steward-roster-panel";
import { MainChatStylePresetPanel } from "./style-preset-panel";
import { MainChatTokenUsagePanel } from "./token-usage-panel";
import { useMainChatSettingsMultiSteward } from "./use-steward-settings";

const ThemedPower = withUnistyles(Power);
const ThemedRadar = withUnistyles(Radar);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

type IntervalFieldKey = MainChatIntervalFieldKey;
type CapabilityKey = MainChatCapabilityFieldKey;
type IntervalFieldSpec = MainChatIntervalFieldSpec;
type CapabilityFieldSpec = MainChatCapabilityFieldSpec;

const INTERVAL_FIELDS = MAIN_CHAT_INTERVAL_FIELDS;
const CAPABILITY_FIELDS = MAIN_CHAT_CAPABILITY_FIELDS;

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

function resolveMasterStatusBadge(
  mainChatEnabled: boolean,
  nightModeStatus: MainChatNightModeStatus | undefined,
): { variant: StatusBadgeVariant; labelKey: string } {
  if (!mainChatEnabled) {
    return { variant: "muted", labelKey: "mainChat.settings.master.stateDisabled" };
  }
  if (nightModeStatus?.state === "hibernating") {
    return { variant: "muted", labelKey: "mainChat.nightMode.stateHibernating" };
  }
  if (nightModeStatus?.state === "throttled") {
    return { variant: "warning", labelKey: "mainChat.nightMode.stateThrottled" };
  }
  return { variant: "success", labelKey: "mainChat.settings.master.stateActive" };
}

function useMainChatSettingsHostState() {
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
  const nightModeStatus = useMainChatSettingsStore((state) =>
    selectedServerId ? state.nightModeStatusByServerId[selectedServerId] : undefined,
  );
  const usageSummary = useMainChatSettingsStore((state) =>
    selectedServerId ? (state.usageByServerId[selectedServerId] ?? null) : null,
  );
  const usageLoading = useMainChatSettingsStore((state) =>
    selectedServerId ? Boolean(state.usageLoadingByServerId[selectedServerId]) : false,
  );
  const isLoading = useMainChatSettingsStore((state) =>
    selectedServerId ? Boolean(state.loadingByServerId[selectedServerId]) : false,
  );
  const lastPatrol = useMainChatSettingsStore((state) =>
    selectedServerId ? state.lastPatrolByServerId[selectedServerId] : undefined,
  );
  const loadSettings = useMainChatSettingsStore((state) => state.loadSettings);
  const updateSettings = useMainChatSettingsStore((state) => state.updateSettings);
  const loadUsage = useMainChatSettingsStore((state) => state.loadUsage);
  const resetUsage = useMainChatSettingsStore((state) => state.resetUsage);
  const triggerPatrol = useMainChatSettingsStore((state) => state.triggerPatrol);

  const settings: MainChatSettings = useMemo(
    () => storedSettings ?? createDefaultMainChatSettings("conservative"),
    [storedSettings],
  );

  useEffect(() => {
    if (!selectedServerId || !client) return;
    void loadSettings(selectedServerId, client).catch(() => undefined);
    void loadUsage(selectedServerId, client).catch(() => undefined);
  }, [client, loadSettings, loadUsage, selectedServerId]);

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

  const selectedHostDisplay = useMemo(() => {
    if (!selectedServerId) return null;
    const label =
      capableHosts.find((host) => host.serverId === selectedServerId)?.label ?? selectedServerId;
    return { label };
  }, [capableHosts, selectedServerId]);

  return {
    capableHosts,
    selectedServerId,
    setSelectedServerId,
    client,
    settings,
    nightModeStatus,
    usageSummary,
    usageLoading,
    isLoading,
    lastPatrol,
    loadUsage,
    resetUsage,
    updateSettings,
    triggerPatrol,
    hostOptions,
    hostLabelsByServerId,
    selectedHostDisplay,
  };
}

function useMainChatBackgroundModelSelector(
  selectedServerId: string | null,
  backgroundModel: MainChatSettings["backgroundModel"],
) {
  const { t } = useTranslation();
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
      enabledProviders.find((entry) => entry.provider === backgroundModel.provider) ??
      enabledProviders[0] ??
      null,
    [enabledProviders, backgroundModel.provider],
  );

  const selectedModelDef = useMemo(() => {
    const models = selectedProviderEntry?.models ?? [];
    return (
      models.find((model) => model.id === backgroundModel.model) ??
      models.find((model) => model.isDefault) ??
      models[0] ??
      null
    );
  }, [selectedProviderEntry, backgroundModel.model]);

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
        thinkingOptions.find((opt) => opt.value === (backgroundModel.thinkingOptionId ?? ""))
          ?.label ?? t("mainChat.settings.backgroundModel.thinkingDefault"),
    }),
    [backgroundModel.thinkingOptionId, t, thinkingOptions],
  );

  return {
    providersLoading,
    enabledProviders,
    selectedProviderEntry,
    selectedModelDef,
    providerOptions,
    modelOptions,
    thinkingOptions,
    selectedProviderDisplay,
    selectedModelDisplay,
    selectedThinkingDisplay,
    showThinkingSelect: (selectedModelDef?.thinkingOptions?.length ?? 0) > 0,
  };
}

const MainChatMasterCard = memo(function MainChatMasterCard({
  hasMultipleHosts,
  selectedServerId,
  selectedHostDisplay,
  hostOptions,
  onSelectHost,
  mainChatEnabled,
  nightModeStatus,
  saving,
  onToggleEnabled,
}: {
  hasMultipleHosts: boolean;
  selectedServerId: string | null;
  selectedHostDisplay: { label: string } | null;
  hostOptions: SelectFieldOption<string>[];
  onSelectHost: (value: string) => void;
  mainChatEnabled: boolean;
  nightModeStatus: MainChatNightModeStatus | undefined;
  saving: boolean;
  onToggleEnabled: (enabled: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const masterBadge = resolveMasterStatusBadge(mainChatEnabled, nightModeStatus);
  return (
    <View style={settingsStyles.card}>
      {hasMultipleHosts ? (
        <View style={[settingsStyles.row, styles.stackedRow]}>
          <SelectField
            label={t("mainChat.settings.hostLabel")}
            value={selectedServerId}
            selectedDisplay={selectedHostDisplay}
            options={hostOptions}
            onChange={onSelectHost}
            placeholder={t("mainChat.settings.hostLabel")}
            emptyText={t("mainChat.settings.noCapableHost")}
          />
        </View>
      ) : null}

      <View
        style={[
          settingsStyles.row,
          hasMultipleHosts ? settingsStyles.rowBorder : null,
          styles.switchRow,
        ]}
      >
        <View style={styles.rowText}>
          <View style={styles.masterTitleRow}>
            <ThemedPower size={15} uniProps={mutedIconMapping} />
            <Text style={settingsStyles.rowTitle}>{t("mainChat.settings.master.switchLabel")}</Text>
            <StatusBadge size="xs" variant={masterBadge.variant} label={t(masterBadge.labelKey)} />
          </View>
          <Text style={settingsStyles.rowHint}>
            {mainChatEnabled
              ? (nightModeStatus?.reason ?? t("mainChat.settings.master.enabledHint"))
              : t("mainChat.settings.master.disabledHint")}
          </Text>
        </View>
        <Switch
          value={mainChatEnabled}
          disabled={saving}
          onValueChange={onToggleEnabled}
          testID="settings-main-chat-enabled-toggle"
        />
      </View>
    </View>
  );
});

function useMainChatSettingsOverviewMetrics(input: {
  selectedServerId: string | null;
  mainChatEnabled: boolean;
  client: ReturnType<typeof useMainChatSettingsHostState>["client"];
}): {
  mainChatAgentId: string | null;
  supervisorMetrics: MainChatMetrics | null;
  refreshOverview: (targetAgentId?: string | null) => void;
} {
  const { selectedServerId, mainChatEnabled, client } = input;
  const mainChatAgentId = useSessionStore((state) =>
    selectedServerId
      ? (findMainChatAgentOnHost(state.sessions[selectedServerId], selectedServerId)?.agentId ??
        null)
      : null,
  );
  const overviewKey =
    selectedServerId && mainChatAgentId ? overviewStoreKey(selectedServerId, mainChatAgentId) : "";
  const overview = useMainChatOverviewStore((state) =>
    overviewKey ? (state.overviewsByKey[overviewKey] ?? null) : null,
  );
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);

  const refreshOverview = useCallback(
    (overrideAgentId?: string | null) => {
      const targetAgentId = overrideAgentId ?? mainChatAgentId;
      if (
        !selectedServerId ||
        !targetAgentId ||
        !client ||
        typeof client.getMainChatOverview !== "function"
      ) {
        return;
      }
      void loadOverview(selectedServerId, targetAgentId, client).catch(() => undefined);
    },
    [client, loadOverview, mainChatAgentId, selectedServerId],
  );

  useEffect(() => {
    if (!mainChatEnabled) return;
    refreshOverview();
  }, [mainChatEnabled, refreshOverview]);

  return {
    mainChatAgentId,
    supervisorMetrics: overview?.metrics ?? null,
    refreshOverview,
  };
}

const SupervisorMetricsRow = memo(function SupervisorMetricsRow({
  metrics,
}: {
  metrics: MainChatMetrics | null;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!metrics) return null;
  return (
    <View
      style={[settingsStyles.row, settingsStyles.rowBorder, styles.actionRow]}
      testID="settings-main-chat-supervisor-metrics"
    >
      <View style={styles.rowText}>
        <Text style={settingsStyles.rowTitle}>{t("mainChat.board.briefHeading")}</Text>
        <Text style={settingsStyles.rowHint}>
          {t("mainChat.board.supervisorMetrics", {
            held: metrics.supervisorHeld,
            autoContinued: metrics.autoContinued,
            rework: metrics.reworkCount,
            interrupts: metrics.interrupts,
          })}
        </Text>
      </View>
    </View>
  );
});

const MainChatStewardTopSections = memo(function MainChatStewardTopSections({
  multiSteward,
  selectedServerId,
  onSelectHost,
}: {
  multiSteward: ReturnType<typeof useMainChatSettingsMultiSteward>;
  selectedServerId: string | null;
  onSelectHost: (serverId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <MainChatStewardConflictsBanner
        conflicts={multiSteward.conflicts}
        busyKey={multiSteward.conflictBusyKey}
        onDisableLocalSteward={multiSteward.handleDisableLocalSteward}
        onRemoveFromRemoteSteward={multiSteward.handleRemoveFromRemoteSteward}
      />

      {multiSteward.rosterEntries.length > 1 ? (
        <SettingsSection
          title={t("mainChat.stewards.roster.sectionTitle")}
          info={t("mainChat.stewards.roster.sectionDescription")}
          testID="settings-main-chat-steward-roster"
        >
          <MainChatStewardRosterPanel
            entries={multiSteward.rosterEntries}
            selectedServerId={selectedServerId}
            activeStewardServerId={multiSteward.activeStewardServerId}
            filterWorkspacesByActiveSteward={multiSteward.filterWorkspacesByActiveSteward}
            onSelectHost={onSelectHost}
            onSetDefault={multiSteward.handleSetDefault}
            onToggleFilterWorkspaces={multiSteward.setFilterWorkspacesByActiveSteward}
          />
        </SettingsSection>
      ) : null}
    </>
  );
});

const MainChatFleetScopeSection = memo(function MainChatFleetScopeSection({
  visible,
  selectedServerId,
  selectedHostLabel,
  fleetScope,
  multiSteward,
  saving,
}: {
  visible: boolean;
  selectedServerId: string | null;
  selectedHostLabel: string | undefined;
  fleetScope: MainChatSettings["fleetScope"];
  multiSteward: ReturnType<typeof useMainChatSettingsMultiSteward>;
  saving: boolean;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!visible || !selectedServerId) return null;
  return (
    <SettingsSection
      title={t("mainChat.stewards.scope.sectionTitle")}
      info={t("mainChat.stewards.scope.sectionDescription")}
      testID="settings-main-chat-fleet-scope"
    >
      <MainChatFleetScopePanel
        selectedServerId={selectedServerId}
        selectedHostLabel={selectedHostLabel ?? selectedServerId}
        fleetScope={fleetScope}
        availableRemoteHosts={multiSteward.selectedAvailableRemoteHosts}
        inScopeHosts={multiSteward.selectedInScopeHosts}
        clientHosts={multiSteward.clientHosts}
        otherOwnerNamesByTargetServerId={multiSteward.otherOwnerNamesByTargetServerId}
        saving={saving || multiSteward.scopeBusy}
        onChangeMode={multiSteward.handleChangeFleetScopeMode}
        onToggleRemoteHost={multiSteward.handleToggleRemoteHost}
      />
    </SettingsSection>
  );
});

export function MainChatSettingsSection(): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const {
    capableHosts,
    selectedServerId,
    setSelectedServerId,
    client,
    settings,
    nightModeStatus,
    usageSummary,
    usageLoading,
    isLoading,
    lastPatrol,
    loadUsage,
    resetUsage,
    updateSettings,
    triggerPatrol,
    hostOptions,
    hostLabelsByServerId,
    selectedHostDisplay,
  } = useMainChatSettingsHostState();

  const mainChatEnabled = isMainChatEnabled(settings);
  const nightModeConfig = useMemo(() => resolveMainChatNightMode(settings), [settings]);
  const { mainChatAgentId, supervisorMetrics, refreshOverview } =
    useMainChatSettingsOverviewMetrics({
      selectedServerId,
      mainChatEnabled,
      client,
    });

  const [titleDraft, setTitleDraft] = useState(settings.title);
  const [intervalDrafts, setIntervalDrafts] = useState<Record<IntervalFieldKey, string>>(() =>
    toIntervalDrafts(settings.intervals),
  );
  const [saving, setSaving] = useState(false);
  const [patrolling, setPatrolling] = useState(false);
  const [resettingUsage, setResettingUsage] = useState(false);

  useEffect(() => {
    setTitleDraft(settings.title);
    setIntervalDrafts(toIntervalDrafts(settings.intervals));
  }, [settings]);

  const {
    providersLoading,
    enabledProviders,
    selectedProviderEntry,
    selectedModelDef,
    providerOptions,
    modelOptions,
    thinkingOptions,
    selectedProviderDisplay,
    selectedModelDisplay,
    selectedThinkingDisplay,
    showThinkingSelect,
  } = useMainChatBackgroundModelSelector(selectedServerId, settings.backgroundModel);

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

  const multiSteward = useMainChatSettingsMultiSteward({
    capableHosts,
    selectedServerId,
    selectedClient: client,
    selectedSettings: settings,
    onApplyPatch: applyPatch,
  });

  const handleSaveTitle = useCallback(() => {
    const trimmed = titleDraft.trim();
    if (!trimmed) return;
    void applyPatch({ title: trimmed }, t("mainChat.settings.renamedToast", { title: trimmed }));
  }, [applyPatch, t, titleDraft]);

  const handleToggleMasterEnabled = useCallback(
    (enabled: boolean) => {
      void applyPatch(
        { enabled },
        enabled ? t("mainChat.settings.enabledToast") : t("mainChat.settings.disabledToast"),
      );
    },
    [applyPatch, t],
  );

  const handleUpdateNightMode = useCallback(
    (patch: Partial<MainChatNightModeConfig>, successMessage?: string) => {
      void applyPatch({ nightMode: patch }, successMessage);
    },
    [applyPatch],
  );

  const handleRefreshUsage = useCallback(() => {
    if (!selectedServerId || !client) return;
    void loadUsage(selectedServerId, client).catch((error) => {
      toast.error(error instanceof Error ? error.message : t("mainChat.usage.loadFailed"));
    });
  }, [client, loadUsage, selectedServerId, t, toast]);

  const handleResetUsage = useCallback(() => {
    if (!selectedServerId || !client || resettingUsage) return;
    setResettingUsage(true);
    void resetUsage(selectedServerId, client)
      .then(() => {
        toast.show(t("mainChat.usage.resetToast"), { variant: "success" });
        return true;
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t("mainChat.usage.resetFailed"));
      })
      .finally(() => {
        setResettingUsage(false);
      });
  }, [client, resetUsage, resettingUsage, selectedServerId, t, toast]);

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
        refreshOverview(ensured.agentId ?? null);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : t("mainChat.patrolFailed"));
      } finally {
        setPatrolling(false);
      }
    })();
  }, [client, patrolling, refreshOverview, selectedServerId, t, toast, triggerPatrol]);

  const modelModeOptions = useMemo<SegmentedControlOption<MainChatBackgroundModelMode>[]>(
    () => [
      { value: "auto", label: t("mainChat.settings.backgroundModel.modeAuto") },
      { value: "main", label: t("mainChat.settings.backgroundModel.modeMain") },
      { value: "custom", label: t("mainChat.settings.backgroundModel.modeCustom") },
    ],
    [t],
  );

  const handleSelectHost = useCallback(
    (value: string) => {
      setSelectedServerId(value);
    },
    [setSelectedServerId],
  );

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
      <MainChatStewardTopSections
        multiSteward={multiSteward}
        selectedServerId={selectedServerId}
        onSelectHost={handleSelectHost}
      />

      <SettingsSection
        title={t("mainChat.settings.master.title")}
        info={t("mainChat.settings.master.description")}
        testID="settings-main-chat-master"
      >
        <MainChatMasterCard
          hasMultipleHosts={hasMultipleHosts}
          selectedServerId={selectedServerId}
          selectedHostDisplay={selectedHostDisplay}
          hostOptions={hostOptions}
          onSelectHost={handleSelectHost}
          mainChatEnabled={mainChatEnabled}
          nightModeStatus={nightModeStatus}
          saving={saving}
          onToggleEnabled={handleToggleMasterEnabled}
        />
      </SettingsSection>

      <MainChatFleetScopeSection
        visible={mainChatEnabled}
        selectedServerId={selectedServerId}
        selectedHostLabel={selectedHostDisplay?.label}
        fleetScope={settings.fleetScope}
        multiSteward={multiSteward}
        saving={saving}
      />

      <SettingsSection
        title={t("mainChat.usage.sectionTitle")}
        info={t("mainChat.usage.sectionDescription")}
        testID="settings-main-chat-token-usage"
      >
        <MainChatTokenUsagePanel
          usage={usageSummary}
          loading={usageLoading}
          resetting={resettingUsage}
          onRefresh={handleRefreshUsage}
          onReset={handleResetUsage}
        />
      </SettingsSection>

      {mainChatEnabled ? (
        <>
          <SettingsSection
            title={t("mainChat.nightMode.sectionTitle")}
            info={t("mainChat.nightMode.sectionDescription")}
            testID="settings-main-chat-night-mode"
          >
            <MainChatNightModePanel
              serverId={selectedServerId ?? ""}
              nightMode={nightModeConfig}
              status={nightModeStatus}
              disabled={saving}
              onUpdateNightMode={handleUpdateNightMode}
            />
          </SettingsSection>

          <SettingsSection
            title={t("mainChat.settings.identity.title")}
            info={t("mainChat.settings.identity.description")}
            testID="settings-main-chat-identity"
          >
            <View style={settingsStyles.card}>
              <View style={[settingsStyles.row, styles.nameRow]}>
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

              <SupervisorMetricsRow metrics={supervisorMetrics} />
            </View>
          </SettingsSection>

          <SettingsSection
            title={t("mainChat.settings.style.title")}
            info={t("mainChat.settings.style.description")}
            testID="settings-main-chat-style"
          >
            <MainChatStylePresetPanel
              settings={settings}
              disabled={saving}
              onApplyPatch={applyPatch}
            />
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
                mainAgentId={mainChatAgentId}
                client={client}
                hostLabelsByServerId={hostLabelsByServerId}
                variant="settings"
              />
            </View>
          </SettingsSection>
        </>
      ) : null}
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
  masterTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexWrap: "wrap",
  },
  switchRow: {
    justifyContent: "space-between",
    gap: theme.spacing[3],
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
