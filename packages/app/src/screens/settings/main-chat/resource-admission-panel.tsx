import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_MAX_CONCURRENT_PER_HOST,
  MAIN_CHAT_MAX_CPU_PERCENT,
  MAIN_CHAT_MAX_FREE_MEMORY_MB,
  MAIN_CHAT_MIN_CONCURRENT_PER_HOST,
  MAIN_CHAT_MIN_CPU_PERCENT,
  MAIN_CHAT_MIN_FREE_MEMORY_MB,
  MAIN_CHAT_TOOL_GROUP_IDS,
  isMainChatOnDemandToolLoadingEnabled,
  isMainChatStatelessBackgroundSupervisionEnabled,
  resolveMainChatResourceAdmissionPolicy,
  type MainChatAdmissionQueueEntry,
  type MainChatHostResourceSnapshot,
  type MainChatMetrics,
  type MainChatResourceAdmissionSnapshot,
  type MainChatSettings,
  type MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import { Cpu, Layers, Play, RefreshCw, Server, Trash2, Zap } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { hostResourceStatusBadgeVariant } from "@/main-chat/admission-ui";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedCpu = withUnistyles(Cpu);
const ThemedLayers = withUnistyles(Layers);
const ThemedPlay = withUnistyles(Play);
const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedServer = withUnistyles(Server);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedZap = withUnistyles(Zap);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const REFRESH_ICON = <ThemedRefreshCw size={13} uniProps={mutedIconMapping} />;
const PLAY_ICON = <ThemedPlay size={12} uniProps={mutedIconMapping} />;
const TRASH_ICON = <ThemedTrash2 size={12} uniProps={mutedIconMapping} />;

const DEFERRED_TOOL_GROUPS = MAIN_CHAT_TOOL_GROUP_IDS.filter((group) => group !== "core");

export interface MainChatResourceAdmissionPanelProps {
  serverId: string;
  client: DaemonClient | null;
  settings: MainChatSettings;
  metrics?: MainChatMetrics | null;
  initialSnapshot?: MainChatResourceAdmissionSnapshot | null;
  disabled?: boolean;
  onApplyPatch: (patch: MainChatSettingsPatch, successMessage?: string) => void;
}

function formatFreeMemoryText(host: MainChatHostResourceSnapshot, unavailable: string): string {
  if (host.freeMemoryMb === null) return unavailable;
  if (host.totalMemoryMb !== null) {
    return `${Math.round(host.freeMemoryMb)}/${Math.round(host.totalMemoryMb)} MB`;
  }
  return `${Math.round(host.freeMemoryMb)} MB`;
}

function formatHostMetrics(
  host: MainChatHostResourceSnapshot,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const unavailable = t("mainChat.resourceAdmission.metricUnavailable");
  const cpuText = host.cpuPercent !== null ? `${Math.round(host.cpuPercent)}%` : unavailable;
  const memText = formatFreeMemoryText(host, unavailable);
  return t("mainChat.resourceAdmission.hostMetricsLine", {
    active: host.activeManagedAgents,
    max: host.maxConcurrent,
    cpu: cpuText,
    mem: memText,
  });
}

const HostResourceCard = memo(function HostResourceCard({
  host,
  isFirst,
}: {
  host: MainChatHostResourceSnapshot;
  isFirst: boolean;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <View
      style={[styles.hostRow, !isFirst && styles.rowDivider]}
      testID={`admission-host-row-${host.serverId}`}
    >
      <View style={styles.hostHeaderRow}>
        <View style={styles.hostTitleWrap}>
          <ThemedServer size={13} uniProps={mutedIconMapping} />
          <Text style={styles.hostLabel} numberOfLines={1}>
            {host.hostLabel}
          </Text>
          <StatusBadge
            size="xs"
            variant="muted"
            label={t(
              host.isLocal
                ? "mainChat.resourceAdmission.localBadge"
                : "mainChat.resourceAdmission.remoteBadge",
            )}
          />
        </View>
        <StatusBadge
          size="xs"
          variant={hostResourceStatusBadgeVariant(host.status)}
          label={t(`mainChat.resourceAdmission.hostStatus.${host.status}`)}
        />
      </View>

      <Text style={styles.hostMetrics} numberOfLines={2}>
        {formatHostMetrics(host, t)}
      </Text>

      {host.pressureSummary ? (
        <Text style={styles.hostPressureText} numberOfLines={2}>
          {host.pressureSummary}
        </Text>
      ) : null}
    </View>
  );
});

const AdmissionQueueRow = memo(function AdmissionQueueRow({
  entry,
  isFirst,
  busy,
  onForceDispatch,
}: {
  entry: MainChatAdmissionQueueEntry;
  isFirst: boolean;
  busy: boolean;
  onForceDispatch: (queueId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleForce = useCallback(() => {
    onForceDispatch(entry.id);
  }, [entry.id, onForceDispatch]);

  return (
    <View
      style={[styles.queueRow, !isFirst && styles.rowDivider]}
      testID={`admission-queue-row-${entry.id}`}
    >
      <View style={styles.queueBody}>
        <View style={styles.queueBadgeLine}>
          <StatusBadge
            size="xs"
            variant="warning"
            label={t("mainChat.resourceAdmission.rankBadge", { position: entry.position })}
          />
          <StatusBadge
            size="xs"
            variant="muted"
            label={t(`mainChat.resourceAdmission.reasonCodes.${entry.reasonCode}`)}
          />
          <Text style={styles.queueHostText} numberOfLines={1}>
            {entry.hostLabel}
          </Text>
        </View>
        <Text style={styles.queueTitle} numberOfLines={1}>
          {entry.title}
        </Text>
        <Text style={styles.queueReason} numberOfLines={2}>
          {entry.reason}
        </Text>
        {entry.suggestion ? (
          <Text style={styles.queueSuggestion} numberOfLines={2}>
            {t("mainChat.resourceAdmission.suggestionPrefix", { suggestion: entry.suggestion })}
          </Text>
        ) : null}
      </View>

      <Button
        variant="outline"
        size="sm"
        leftIcon={PLAY_ICON}
        disabled={busy}
        onPress={handleForce}
        testID={`admission-queue-force-${entry.id}`}
      >
        {t("mainChat.resourceAdmission.forceDispatchAction")}
      </Button>
    </View>
  );
});

const ThresholdInputsBlock = memo(function ThresholdInputsBlock({
  serverId,
  maxConcurrent,
  maxCpuPercent,
  minFreeMemoryMb,
  disabled,
  onSaveThresholds,
}: {
  serverId: string;
  maxConcurrent: number;
  maxCpuPercent: number;
  minFreeMemoryMb: number;
  disabled: boolean;
  onSaveThresholds: (drafts: {
    maxConcurrent: string;
    maxCpuPercent: string;
    minFreeMemoryMb: string;
  }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [concurrentDraft, setConcurrentDraft] = useState(String(maxConcurrent));
  const [cpuDraft, setCpuDraft] = useState(String(maxCpuPercent));
  const [memDraft, setMemDraft] = useState(String(minFreeMemoryMb));

  useEffect(() => {
    setConcurrentDraft(String(maxConcurrent));
    setCpuDraft(String(maxCpuPercent));
    setMemDraft(String(minFreeMemoryMb));
  }, [maxConcurrent, maxCpuPercent, minFreeMemoryMb, serverId]);

  const handleConcurrentChange = useCallback((value: string) => {
    setConcurrentDraft(value.replace(/[^0-9]/g, ""));
  }, []);
  const handleCpuChange = useCallback((value: string) => {
    setCpuDraft(value.replace(/[^0-9]/g, ""));
  }, []);
  const handleMemChange = useCallback((value: string) => {
    setMemDraft(value.replace(/[^0-9]/g, ""));
  }, []);
  const handleSave = useCallback(() => {
    onSaveThresholds({
      maxConcurrent: concurrentDraft,
      maxCpuPercent: cpuDraft,
      minFreeMemoryMb: memDraft,
    });
  }, [concurrentDraft, cpuDraft, memDraft, onSaveThresholds]);

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.thresholdSection]}>
      <View style={styles.thresholdGrid}>
        <View style={styles.thresholdField}>
          <Text style={styles.thresholdLabel}>
            {t("mainChat.resourceAdmission.maxConcurrentLabel")}
          </Text>
          <View style={styles.inputWithUnit}>
            <FormTextInput
              size="sm"
              style={styles.numberInput}
              initialValue={String(maxConcurrent)}
              resetKey={`${serverId}:conc:${maxConcurrent}`}
              onChangeText={handleConcurrentChange}
              keyboardType="number-pad"
              maxLength={3}
              testID="admission-threshold-concurrent"
            />
            <Text style={styles.unitLabel}>
              {t("mainChat.resourceAdmission.maxConcurrentUnit")}
            </Text>
          </View>
        </View>

        <View style={styles.thresholdField}>
          <Text style={styles.thresholdLabel}>{t("mainChat.resourceAdmission.maxCpuLabel")}</Text>
          <View style={styles.inputWithUnit}>
            <FormTextInput
              size="sm"
              style={styles.numberInput}
              initialValue={String(maxCpuPercent)}
              resetKey={`${serverId}:cpu:${maxCpuPercent}`}
              onChangeText={handleCpuChange}
              keyboardType="number-pad"
              maxLength={3}
              testID="admission-threshold-cpu"
            />
            <Text style={styles.unitLabel}>%</Text>
          </View>
        </View>

        <View style={styles.thresholdField}>
          <Text style={styles.thresholdLabel}>
            {t("mainChat.resourceAdmission.minFreeMemoryLabel")}
          </Text>
          <View style={styles.inputWithUnit}>
            <FormTextInput
              size="sm"
              style={styles.memoryInput}
              initialValue={String(minFreeMemoryMb)}
              resetKey={`${serverId}:mem:${minFreeMemoryMb}`}
              onChangeText={handleMemChange}
              keyboardType="number-pad"
              maxLength={6}
              testID="admission-threshold-memory"
            />
            <Text style={styles.unitLabel}>MB</Text>
          </View>
        </View>
      </View>

      <View style={styles.thresholdFooter}>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onPress={handleSave}
          testID="admission-thresholds-save"
        >
          {t("mainChat.resourceAdmission.saveThresholds")}
        </Button>
      </View>
    </View>
  );
});

const RuntimeOptimizationBlock = memo(function RuntimeOptimizationBlock({
  statelessEnabled,
  onDemandToolsEnabled,
  metrics,
  disabled,
  onToggleStateless,
  onToggleOnDemandTools,
}: {
  statelessEnabled: boolean;
  onDemandToolsEnabled: boolean;
  metrics?: MainChatMetrics | null;
  disabled: boolean;
  onToggleStateless: (value: boolean) => void;
  onToggleOnDemandTools: (value: boolean) => void;
}): ReactElement {
  const { t } = useTranslation();
  const statelessRounds = metrics?.statelessSupervisionRounds ?? 0;
  const statelessEscalations = metrics?.statelessSupervisionEscalations ?? 0;

  return (
    <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.blockColumn]}>
      <View style={styles.subHeadingRow}>
        <ThemedZap size={14} uniProps={mutedIconMapping} />
        <Text style={styles.subHeadingTitle}>{t("mainChat.runtimeOptimization.heading")}</Text>
      </View>

      <View style={styles.switchRow}>
        <View style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>
            {t("mainChat.runtimeOptimization.statelessLabel")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("mainChat.runtimeOptimization.statelessHint")}
          </Text>
          <Text style={styles.metricsMeta} testID="runtime-stateless-metrics">
            {t("mainChat.runtimeOptimization.statelessMetricsLine", {
              rounds: statelessRounds,
              escalations: statelessEscalations,
            })}
          </Text>
        </View>
        <Switch
          value={statelessEnabled}
          onValueChange={onToggleStateless}
          disabled={disabled}
          accessibilityLabel={t("mainChat.runtimeOptimization.statelessLabel")}
          testID="settings-main-chat-stateless-supervision"
        />
      </View>

      <View style={[styles.switchRow, styles.rowDividerTop]}>
        <View style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>
            {t("mainChat.runtimeOptimization.onDemandToolsLabel")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("mainChat.runtimeOptimization.onDemandToolsHint")}
          </Text>
          <View style={styles.toolGroupsWrap} testID="runtime-tool-groups-badges">
            <StatusBadge
              size="xs"
              variant="success"
              label={t("mainChat.runtimeOptimization.coreGroupBadge")}
            />
            {DEFERRED_TOOL_GROUPS.map((group) => (
              <StatusBadge key={group} size="xs" variant="muted" label={group} />
            ))}
          </View>
        </View>
        <Switch
          value={onDemandToolsEnabled}
          onValueChange={onToggleOnDemandTools}
          disabled={disabled}
          accessibilityLabel={t("mainChat.runtimeOptimization.onDemandToolsLabel")}
          testID="settings-main-chat-on-demand-tools"
        />
      </View>
    </View>
  );
});

export const MainChatResourceAdmissionPanel = memo(function MainChatResourceAdmissionPanel({
  serverId,
  client,
  settings,
  metrics,
  initialSnapshot = null,
  disabled = false,
  onApplyPatch,
}: MainChatResourceAdmissionPanelProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const policy = useMemo(() => resolveMainChatResourceAdmissionPolicy(settings), [settings]);
  const statelessEnabled = isMainChatStatelessBackgroundSupervisionEnabled(settings);
  const onDemandToolsEnabled = isMainChatOnDemandToolLoadingEnabled(settings);

  const [snapshot, setSnapshot] = useState<MainChatResourceAdmissionSnapshot | null>(
    initialSnapshot,
  );
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [mutatingQueue, setMutatingQueue] = useState(false);

  const refreshSnapshot = useCallback(async () => {
    if (!client || typeof client.getMainChatResourceAdmission !== "function") return;
    setLoadingSnapshot(true);
    try {
      const response = await client.getMainChatResourceAdmission();
      if (response.error) {
        throw new Error(response.error);
      }
      setSnapshot(response.snapshot);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("mainChat.resourceAdmission.actionFailed"),
      );
    } finally {
      setLoadingSnapshot(false);
    }
  }, [client, t, toast]);

  useEffect(() => {
    if (initialSnapshot) {
      setSnapshot(initialSnapshot);
      return;
    }
    if (!client || typeof client.getMainChatResourceAdmission !== "function") return;
    void refreshSnapshot();
  }, [client, initialSnapshot, refreshSnapshot, serverId]);

  const handleToggleEnabled = useCallback(
    (nextValue: boolean) => {
      onApplyPatch({ resourceAdmission: { enabled: nextValue } });
    },
    [onApplyPatch],
  );

  const handleToggleQueueWhenPressured = useCallback(
    (nextValue: boolean) => {
      onApplyPatch({ resourceAdmission: { queueWhenPressured: nextValue } });
    },
    [onApplyPatch],
  );

  const handleSaveThresholds = useCallback(
    (drafts: { maxConcurrent: string; maxCpuPercent: string; minFreeMemoryMb: string }) => {
      const maxConcurrentPerHost = Number.parseInt(drafts.maxConcurrent, 10);
      const maxCpuPercent = Number.parseInt(drafts.maxCpuPercent, 10);
      const minFreeMemoryMb = Number.parseInt(drafts.minFreeMemoryMb, 10);
      const valid =
        Number.isFinite(maxConcurrentPerHost) &&
        maxConcurrentPerHost >= MAIN_CHAT_MIN_CONCURRENT_PER_HOST &&
        maxConcurrentPerHost <= MAIN_CHAT_MAX_CONCURRENT_PER_HOST &&
        Number.isFinite(maxCpuPercent) &&
        maxCpuPercent >= MAIN_CHAT_MIN_CPU_PERCENT &&
        maxCpuPercent <= MAIN_CHAT_MAX_CPU_PERCENT &&
        Number.isFinite(minFreeMemoryMb) &&
        minFreeMemoryMb >= MAIN_CHAT_MIN_FREE_MEMORY_MB &&
        minFreeMemoryMb <= MAIN_CHAT_MAX_FREE_MEMORY_MB;
      if (!valid) {
        toast.error(t("mainChat.resourceAdmission.invalidThresholdError"));
        return;
      }
      onApplyPatch(
        {
          resourceAdmission: {
            maxConcurrentPerHost,
            maxCpuPercent,
            minFreeMemoryMb,
          },
        },
        t("mainChat.resourceAdmission.thresholdsSavedToast"),
      );
    },
    [onApplyPatch, t, toast],
  );

  const handleDrainAction = useCallback(
    async (action: "drain" | "force_dispatch" | "clear", queueId?: string) => {
      if (!client || typeof client.drainMainChatAdmissionQueue !== "function" || mutatingQueue) {
        return;
      }
      setMutatingQueue(true);
      try {
        const res = await client.drainMainChatAdmissionQueue({ action, queueId });
        if (res.error) throw new Error(res.error);
        if (res.snapshot) setSnapshot(res.snapshot);
        if (action === "force_dispatch") {
          toast.show(t("mainChat.resourceAdmission.forceDispatchedToast"), { variant: "success" });
        } else if (action === "clear") {
          toast.show(t("mainChat.resourceAdmission.clearedToast", { count: res.removedCount }), {
            variant: "success",
          });
        } else {
          toast.show(
            t("mainChat.resourceAdmission.drainedToast", {
              dispatched: res.dispatchedCount,
              remaining: res.remainingCount,
            }),
            { variant: "success" },
          );
        }
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("mainChat.resourceAdmission.actionFailed"),
        );
      } finally {
        setMutatingQueue(false);
      }
    },
    [client, mutatingQueue, t, toast],
  );

  const handleDrainAll = useCallback(() => {
    void handleDrainAction("drain");
  }, [handleDrainAction]);

  const handleClearQueue = useCallback(() => {
    void handleDrainAction("clear");
  }, [handleDrainAction]);

  const handleForceDispatch = useCallback(
    (queueId: string) => {
      void handleDrainAction("force_dispatch", queueId);
    },
    [handleDrainAction],
  );

  const handleRefreshPress = useCallback(() => {
    void refreshSnapshot();
  }, [refreshSnapshot]);

  const handleToggleStateless = useCallback(
    (nextValue: boolean) => {
      onApplyPatch(
        { statelessBackgroundSupervision: nextValue },
        t(
          nextValue
            ? "mainChat.runtimeOptimization.statelessEnabledToast"
            : "mainChat.runtimeOptimization.statelessDisabledToast",
        ),
      );
    },
    [onApplyPatch, t],
  );

  const handleToggleOnDemandTools = useCallback(
    (nextValue: boolean) => {
      onApplyPatch(
        { onDemandToolLoading: nextValue },
        t(
          nextValue
            ? "mainChat.runtimeOptimization.onDemandToolsEnabledToast"
            : "mainChat.runtimeOptimization.onDemandToolsDisabledToast",
        ),
      );
    },
    [onApplyPatch, t],
  );

  const hosts = snapshot?.hosts ?? [];
  const queue = snapshot?.queue ?? [];

  return (
    <View style={settingsStyles.card} testID="main-chat-resource-admission-panel">
      <View style={[settingsStyles.row, styles.switchRow]}>
        <View style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>{t("mainChat.resourceAdmission.enableLabel")}</Text>
          <Text style={settingsStyles.rowHint}>{t("mainChat.resourceAdmission.enableHint")}</Text>
        </View>
        <Switch
          value={policy.enabled}
          onValueChange={handleToggleEnabled}
          disabled={disabled}
          accessibilityLabel={t("mainChat.resourceAdmission.enableLabel")}
          testID="admission-toggle-enabled"
        />
      </View>

      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.switchRow]}>
        <View style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>
            {t("mainChat.resourceAdmission.queueWhenPressuredLabel")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("mainChat.resourceAdmission.queueWhenPressuredHint")}
          </Text>
        </View>
        <Switch
          value={policy.queueWhenPressured}
          onValueChange={handleToggleQueueWhenPressured}
          disabled={disabled}
          accessibilityLabel={t("mainChat.resourceAdmission.queueWhenPressuredLabel")}
          testID="admission-toggle-queue"
        />
      </View>

      <ThresholdInputsBlock
        serverId={serverId}
        maxConcurrent={policy.maxConcurrentPerHost}
        maxCpuPercent={policy.maxCpuPercent}
        minFreeMemoryMb={policy.minFreeMemoryMb}
        disabled={disabled}
        onSaveThresholds={handleSaveThresholds}
      />

      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.blockColumn]}>
        <View style={styles.headerActionBar}>
          <View style={styles.subHeadingRow}>
            <ThemedCpu size={14} uniProps={mutedIconMapping} />
            <Text style={styles.subHeadingTitle}>
              {t("mainChat.resourceAdmission.hostsHeading")}
            </Text>
          </View>
          <Button
            variant="outline"
            size="sm"
            leftIcon={REFRESH_ICON}
            loading={loadingSnapshot}
            disabled={loadingSnapshot || !client}
            onPress={handleRefreshPress}
            testID="admission-refresh-snapshot"
          >
            {t("mainChat.resourceAdmission.refreshAction")}
          </Button>
        </View>

        {hosts.length === 0 ? (
          <Text style={styles.emptyText} testID="admission-hosts-empty">
            {t("mainChat.resourceAdmission.hostsEmpty")}
          </Text>
        ) : (
          <View style={styles.listBox} testID="admission-hosts-list">
            {hosts.map((host, index) => (
              <HostResourceCard key={host.serverId} host={host} isFirst={index === 0} />
            ))}
          </View>
        )}
      </View>

      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.blockColumn]}>
        <View style={styles.headerActionBar}>
          <View style={styles.subHeadingRow}>
            <ThemedLayers size={14} uniProps={mutedIconMapping} />
            <Text style={styles.subHeadingTitle}>
              {t("mainChat.resourceAdmission.queueHeading", { count: queue.length })}
            </Text>
          </View>
          <View style={styles.queueHeaderActions}>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={PLAY_ICON}
              loading={mutatingQueue}
              disabled={mutatingQueue || queue.length === 0 || !client}
              onPress={handleDrainAll}
              testID="admission-queue-drain"
            >
              {t("mainChat.resourceAdmission.drainAction")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              leftIcon={TRASH_ICON}
              disabled={mutatingQueue || queue.length === 0 || !client}
              onPress={handleClearQueue}
              testID="admission-queue-clear"
            >
              {t("mainChat.resourceAdmission.clearQueueAction")}
            </Button>
          </View>
        </View>

        {queue.length === 0 ? (
          <Text style={styles.emptyText} testID="admission-queue-empty">
            {t("mainChat.resourceAdmission.queueEmpty")}
          </Text>
        ) : (
          <View style={styles.listBox} testID="admission-queue-list">
            {queue.map((entry, index) => (
              <AdmissionQueueRow
                key={entry.id}
                entry={entry}
                isFirst={index === 0}
                busy={mutatingQueue || disabled}
                onForceDispatch={handleForceDispatch}
              />
            ))}
          </View>
        )}
      </View>

      <RuntimeOptimizationBlock
        statelessEnabled={statelessEnabled}
        onDemandToolsEnabled={onDemandToolsEnabled}
        metrics={metrics}
        disabled={disabled}
        onToggleStateless={handleToggleStateless}
        onToggleOnDemandTools={handleToggleOnDemandTools}
      />
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  rowDivider: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  rowDividerTop: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  blockColumn: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  thresholdSection: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[3],
  },
  thresholdGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  thresholdField: {
    flexGrow: 1,
    flexBasis: 140,
    minWidth: 120,
    gap: theme.spacing[1],
  },
  thresholdLabel: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  inputWithUnit: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  numberInput: {
    width: 72,
    textAlign: "right",
  },
  memoryInput: {
    width: 96,
    textAlign: "right",
  },
  unitLabel: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  thresholdFooter: {
    flexDirection: "row",
    justifyContent: "flex-end",
  },
  headerActionBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  subHeadingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexShrink: 1,
    minWidth: 0,
  },
  subHeadingTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  queueHeaderActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  listBox: {
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  hostRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
  },
  hostHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  hostTitleWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flex: 1,
    minWidth: 0,
  },
  hostLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  hostMetrics: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  hostPressureText: {
    fontSize: 12,
    color: theme.colors.statusWarning,
  },
  queueRow: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  queueBody: {
    flex: 1,
    minWidth: 180,
    gap: 3,
  },
  queueBadgeLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  queueHostText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  queueTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  queueReason: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  queueSuggestion: {
    fontSize: 12,
    color: theme.colors.statusWarning,
  },
  metricsMeta: {
    marginTop: 4,
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
  },
  toolGroupsWrap: {
    marginTop: theme.spacing[1.5],
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  emptyText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
}));
