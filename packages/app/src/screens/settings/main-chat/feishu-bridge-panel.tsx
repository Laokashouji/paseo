import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  FEISHU_BRIDGE_DEFAULT_REPLAY_WINDOW_SEC,
  FEISHU_BRIDGE_FORWARD_TIERS,
  FEISHU_BRIDGE_MAX_REPLAY_WINDOW_SEC,
  FEISHU_BRIDGE_MIN_REPLAY_WINDOW_SEC,
  FEISHU_BRIDGE_WEBHOOK_PATH,
  createUnavailableFeishuBridgeState,
  resolveFeishuBridgeApiBaseUrl,
  type FeishuBridgeAuditDirection,
  type FeishuBridgeAuditRecord,
  type FeishuBridgeAuditStatus,
  type FeishuBridgeConfigPatch,
  type FeishuBridgeConnectionTestResult,
  type FeishuBridgeDomainPreset,
  type FeishuBridgeForwardTier,
  type FeishuBridgeReceiveIdType,
  type FeishuBridgeSendTestCardResult,
  type FeishuBridgeState,
} from "@getpaseo/protocol/main-chat";
import {
  Bot,
  CheckCircle2,
  Copy,
  Link2,
  Lock,
  Plug,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  Zap,
} from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { copyToClipboard } from "@/utils/copy-to-clipboard";

const ThemedBot = withUnistyles(Bot);
const ThemedCheckCircle2 = withUnistyles(CheckCircle2);
const ThemedCopy = withUnistyles(Copy);
const ThemedLink2 = withUnistyles(Link2);
const ThemedLock = withUnistyles(Lock);
const ThemedPlug = withUnistyles(Plug);
const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedShieldAlert = withUnistyles(ShieldAlert);
const ThemedShieldCheck = withUnistyles(ShieldCheck);
const ThemedTrash2 = withUnistyles(Trash2);
const ThemedZap = withUnistyles(Zap);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const BOT_ICON = <ThemedBot size={12} uniProps={mutedIconMapping} />;
const SHIELD_OK_ICON = <ThemedShieldCheck size={12} uniProps={successIconMapping} />;
const SHIELD_WARN_ICON = <ThemedShieldAlert size={12} uniProps={dangerIconMapping} />;
const LOCK_ICON = <ThemedLock size={11} uniProps={mutedIconMapping} />;
const PLUG_ICON = <ThemedPlug size={13} uniProps={mutedIconMapping} />;
const ZAP_ICON = <ThemedZap size={13} uniProps={mutedIconMapping} />;
const COPY_ICON = <ThemedCopy size={12} uniProps={mutedIconMapping} />;
const REFRESH_ICON = <ThemedRefreshCw size={12} uniProps={mutedIconMapping} />;
const TRASH_ICON = <ThemedTrash2 size={12} uniProps={mutedIconMapping} />;
const LINK_ICON = <ThemedLink2 size={12} uniProps={mutedIconMapping} />;
const CHECK_ICON = <ThemedCheckCircle2 size={12} uniProps={successIconMapping} />;

const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

type AuditFilterValue = "all" | "outbound" | "inbound";

const AUDIT_FILTERS: readonly AuditFilterValue[] = ["all", "outbound", "inbound"];

function auditStatusBadgeVariant(status: FeishuBridgeAuditStatus): StatusBadgeVariant {
  switch (status) {
    case "succeeded":
      return "success";
    case "failed":
    case "rejected":
      return "error";
    case "deduplicated":
      return "warning";
    case "filtered":
      return "muted";
  }
}

function auditDirectionBadgeVariant(direction: FeishuBridgeAuditDirection): StatusBadgeVariant {
  switch (direction) {
    case "outbound":
      return "muted";
    case "inbound":
      return "warning";
    case "system":
      return "muted";
  }
}

function parseOpenIdList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[\n,;\s]+/)) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function formatOpenIdList(ids: readonly string[]): string {
  return ids.join(", ");
}

function formatShortTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

export interface MainChatFeishuBridgePanelProps {
  serverId: string;
  client: DaemonClient | null;
  disabled?: boolean;
  initialState?: FeishuBridgeState | null;
  initialConnectionResult?: FeishuBridgeConnectionTestResult | null;
  initialTestCardResult?: FeishuBridgeSendTestCardResult | null;
}

interface SecretFieldRowProps {
  fieldKey: "appSecret" | "verificationToken" | "encryptKey";
  label: string;
  hasConfigured: boolean;
  mask: string | null;
  resetKey: string;
  pendingClear: boolean;
  disabled: boolean;
  onChangeText: (value: string) => void;
  onToggleClear: () => void;
}

function renderSecretStatusBadge(params: {
  fieldKey: string;
  pendingClear: boolean;
  hasConfigured: boolean;
  mask: string | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
}): ReactElement {
  const { fieldKey, pendingClear, hasConfigured, mask, t } = params;
  if (pendingClear) {
    return (
      <View testID={`feishu-secret-pending-clear-${fieldKey}`}>
        <StatusBadge
          size="xs"
          variant="warning"
          label={t("mainChat.feishuBridge.pendingClearBadge")}
        />
      </View>
    );
  }
  if (hasConfigured) {
    return (
      <View testID={`feishu-secret-configured-${fieldKey}`}>
        <StatusBadge
          size="xs"
          variant="success"
          leading={LOCK_ICON}
          label={t("mainChat.feishuBridge.secretConfiguredBadge", {
            mask: mask ?? "••••",
          })}
        />
      </View>
    );
  }
  return (
    <View testID={`feishu-secret-unconfigured-${fieldKey}`}>
      <StatusBadge
        size="xs"
        variant="muted"
        label={t("mainChat.feishuBridge.secretUnconfiguredBadge")}
      />
    </View>
  );
}

const SecretFieldRow = memo(function SecretFieldRow({
  fieldKey,
  label,
  hasConfigured,
  mask,
  resetKey,
  pendingClear,
  disabled,
  onChangeText,
  onToggleClear,
}: SecretFieldRowProps): ReactElement {
  const { t } = useTranslation();

  return (
    <View style={styles.fieldGroup} testID={`feishu-secret-row-${fieldKey}`}>
      <View style={styles.fieldHeaderRow}>
        <Text style={styles.fieldLabel}>{label}</Text>
        <View style={styles.badgeCluster}>
          {renderSecretStatusBadge({ fieldKey, pendingClear, hasConfigured, mask, t })}
          {hasConfigured ? (
            <Button
              size="sm"
              variant="ghost"
              leftIcon={TRASH_ICON}
              onPress={onToggleClear}
              disabled={disabled}
              testID={`feishu-secret-clear-${fieldKey}`}
            >
              {t("mainChat.feishuBridge.clearSecretButton")}
            </Button>
          ) : null}
        </View>
      </View>
      <FormTextInput
        size="sm"
        initialValue=""
        resetKey={resetKey}
        onChangeText={onChangeText}
        placeholder={
          hasConfigured
            ? t("mainChat.feishuBridge.secretKeepPlaceholder")
            : t("mainChat.feishuBridge.secretEmptyPlaceholder")
        }
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        accessibilityLabel={label}
        testID={`feishu-input-${fieldKey}`}
      />
    </View>
  );
});

const ForwardTierPill = memo(function ForwardTierPill({
  tier,
  selected,
  locked,
  disabled,
  onToggle,
}: {
  tier: FeishuBridgeForwardTier;
  selected: boolean;
  locked: boolean;
  disabled: boolean;
  onToggle: (tier: FeishuBridgeForwardTier) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (!disabled && !locked) {
      onToggle(tier);
    }
  }, [disabled, locked, onToggle, tier]);

  return (
    <PressHighlight
      onPress={handlePress}
      disabled={disabled || locked}
      style={[styles.pillButton, selected && styles.pillButtonSelected]}
      highlightStyle={styles.rowPressed}
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      testID={`feishu-tier-pill-${tier}`}
    >
      <Text
        style={[styles.pillButtonText, selected && styles.pillButtonTextSelected]}
        numberOfLines={1}
      >
        {t(`mainChat.feishuBridge.tiers.${tier}`)}
      </Text>
    </PressHighlight>
  );
});

const AuditFilterPill = memo(function AuditFilterPill({
  value,
  selected,
  onSelect,
}: {
  value: AuditFilterValue;
  selected: boolean;
  onSelect: (value: AuditFilterValue) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onSelect(value);
  }, [onSelect, value]);

  return (
    <PressHighlight
      onPress={handlePress}
      style={[styles.pillButton, selected && styles.pillButtonSelected]}
      highlightStyle={styles.rowPressed}
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      testID={`feishu-audit-filter-${value}`}
    >
      <Text
        style={[styles.pillButtonText, selected && styles.pillButtonTextSelected]}
        numberOfLines={1}
      >
        {t(`mainChat.feishuBridge.auditFilters.${value}`)}
      </Text>
    </PressHighlight>
  );
});

const FeishuAuditRow = memo(function FeishuAuditRow({
  record,
  isFirst,
}: {
  record: FeishuBridgeAuditRecord;
  isFirst: boolean;
}): ReactElement {
  const { t } = useTranslation();

  const metaParts: string[] = [formatShortTime(record.createdAt)];
  if (record.latencyMs !== null) {
    metaParts.push(t("mainChat.feishuBridge.latencyMeta", { ms: record.latencyMs }));
  }
  if (record.messageId) {
    metaParts.push(t("mainChat.feishuBridge.messageIdMeta", { id: record.messageId }));
  }
  if (record.actorOpenId) {
    metaParts.push(t("mainChat.feishuBridge.auditActorMeta", { openId: record.actorOpenId }));
  }
  if (record.errorCode) {
    metaParts.push(record.errorCode);
  }

  return (
    <View
      style={[styles.auditRow, !isFirst && styles.rowDivider]}
      testID={`feishu-audit-row-${record.id}`}
    >
      <View style={styles.auditTopLine}>
        <StatusBadge
          size="xs"
          variant={auditDirectionBadgeVariant(record.direction)}
          label={t(`mainChat.feishuBridge.auditDirections.${record.direction}`)}
        />
        <StatusBadge
          size="xs"
          variant={auditStatusBadgeVariant(record.status)}
          label={t(`mainChat.feishuBridge.auditStatuses.${record.status}`)}
        />
        <Text style={styles.auditTitle} numberOfLines={1}>
          {record.title}
        </Text>
      </View>
      <Text style={styles.auditSummary} numberOfLines={3}>
        {record.summary}
      </Text>
      <Text style={styles.auditMeta} numberOfLines={2}>
        {metaParts.join(" · ")}
      </Text>
    </View>
  );
});

function resolveBridgeStatusBadge(
  bridgeState: FeishuBridgeState,
  enabledDraft: boolean,
  t: (key: string) => string,
): { variant: "success" | "warning" | "muted"; label: string } {
  if (!bridgeState.pluginAvailable) {
    return { variant: "muted", label: t("mainChat.feishuBridge.statusUnavailable") };
  }
  if (bridgeState.active) {
    return { variant: "success", label: t("mainChat.feishuBridge.statusActive") };
  }
  if (enabledDraft) {
    return { variant: "warning", label: t("mainChat.feishuBridge.statusIncomplete") };
  }
  return { variant: "muted", label: t("mainChat.feishuBridge.statusDisabled") };
}

const FeishuDiagnosticsCard = memo(function FeishuDiagnosticsCard({
  connectionResult,
  testCardResult,
}: {
  connectionResult: FeishuBridgeConnectionTestResult | null;
  testCardResult: FeishuBridgeSendTestCardResult | null;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!connectionResult && !testCardResult) return null;

  return (
    <View style={settingsStyles.card} testID="feishu-bridge-diagnostics-card">
      {connectionResult ? (
        <View
          style={[settingsStyles.row, styles.stackedRow]}
          testID="feishu-connection-test-result"
        >
          <View style={styles.fieldHeaderRow}>
            <Text style={settingsStyles.rowTitle}>
              {t("mainChat.feishuBridge.testConnectionTitle")}
            </Text>
            <View style={styles.badgeCluster}>
              <StatusBadge
                size="xs"
                variant={connectionResult.ok ? "success" : "error"}
                leading={connectionResult.ok ? CHECK_ICON : SHIELD_WARN_ICON}
                label={
                  connectionResult.ok
                    ? t("mainChat.feishuBridge.resultPassBadge")
                    : t("mainChat.feishuBridge.resultFailBadge")
                }
              />
              <StatusBadge
                size="xs"
                variant="muted"
                label={t("mainChat.feishuBridge.latencyMeta", {
                  ms: connectionResult.latencyMs,
                })}
              />
              {connectionResult.tokenExpiresInSec !== null ? (
                <StatusBadge
                  size="xs"
                  variant="muted"
                  label={t("mainChat.feishuBridge.tokenTtlMeta", {
                    sec: connectionResult.tokenExpiresInSec,
                  })}
                />
              ) : null}
              {connectionResult.cachedTokenReused ? (
                <StatusBadge
                  size="xs"
                  variant="muted"
                  label={t("mainChat.feishuBridge.tokenCachedMeta")}
                />
              ) : null}
            </View>
          </View>
          <Text style={styles.diagnosticMessage}>{connectionResult.message}</Text>
          {connectionResult.troubleshootingHint ? (
            <View style={styles.troubleshootBox} testID="feishu-connection-troubleshoot">
              <Text style={styles.troubleshootText}>
                {`${t("mainChat.feishuBridge.troubleshootingPrefix")}${connectionResult.troubleshootingHint}`}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {testCardResult ? (
        <View
          style={[
            settingsStyles.row,
            connectionResult ? styles.rowDivider : null,
            styles.stackedRow,
          ]}
          testID="feishu-test-card-result"
        >
          <View style={styles.fieldHeaderRow}>
            <Text style={settingsStyles.rowTitle}>{t("mainChat.feishuBridge.testCardTitle")}</Text>
            <View style={styles.badgeCluster}>
              <StatusBadge
                size="xs"
                variant={testCardResult.ok ? "success" : "error"}
                leading={testCardResult.ok ? CHECK_ICON : SHIELD_WARN_ICON}
                label={
                  testCardResult.ok
                    ? t("mainChat.feishuBridge.resultPassBadge")
                    : t("mainChat.feishuBridge.resultFailBadge")
                }
              />
              <StatusBadge
                size="xs"
                variant="muted"
                label={t("mainChat.feishuBridge.latencyMeta", {
                  ms: testCardResult.latencyMs,
                })}
              />
            </View>
          </View>
          <Text style={styles.diagnosticMessage}>{testCardResult.message}</Text>
          {testCardResult.troubleshootingHint ? (
            <View style={styles.troubleshootBox} testID="feishu-test-card-troubleshoot">
              <Text style={styles.troubleshootText}>
                {`${t("mainChat.feishuBridge.troubleshootingPrefix")}${testCardResult.troubleshootingHint}`}
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const FeishuAuditLedgerCard = memo(function FeishuAuditLedgerCard({
  stats,
  records,
  auditFilter,
  refreshing,
  hasClient,
  onSelectFilter,
  onRefresh,
}: {
  stats: FeishuBridgeState["stats"];
  records: readonly FeishuBridgeAuditRecord[];
  auditFilter: AuditFilterValue;
  refreshing: boolean;
  hasClient: boolean;
  onSelectFilter: (value: AuditFilterValue) => void;
  onRefresh: () => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <View style={settingsStyles.card} testID="feishu-bridge-audit-card">
      <View style={[settingsStyles.row, styles.stackedRow]}>
        <View style={styles.fieldHeaderRow}>
          <Text style={settingsStyles.rowTitle}>{t("mainChat.feishuBridge.auditTitle")}</Text>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={REFRESH_ICON}
            onPress={onRefresh}
            disabled={refreshing || !hasClient}
            testID="feishu-bridge-audit-refresh"
          >
            {t("mainChat.feishuBridge.auditRefreshButton")}
          </Button>
        </View>
        <Text style={settingsStyles.rowHint} testID="feishu-bridge-audit-stats">
          {t("mainChat.feishuBridge.auditStatsSummary", {
            outOk: stats.outboundSent,
            outFail: stats.outboundFailed,
            inOk: stats.inboundProcessed,
            inReject: stats.inboundRejected,
            inDedupe: stats.inboundDeduplicated,
          })}
        </Text>
        <View style={styles.pillRow}>
          {AUDIT_FILTERS.map((filterValue) => (
            <AuditFilterPill
              key={filterValue}
              value={filterValue}
              selected={auditFilter === filterValue}
              onSelect={onSelectFilter}
            />
          ))}
        </View>
      </View>

      {records.length === 0 ? (
        <View style={[settingsStyles.row, styles.rowDivider]}>
          <Text style={settingsStyles.rowHint}>{t("mainChat.feishuBridge.auditEmpty")}</Text>
        </View>
      ) : (
        <View style={styles.rowDivider}>
          {records.slice(0, 12).map((record, index) => (
            <FeishuAuditRow key={record.id} record={record} isFirst={index === 0} />
          ))}
        </View>
      )}
    </View>
  );
});

export function MainChatFeishuBridgePanel({
  serverId,
  client,
  disabled = false,
  initialState = null,
  initialConnectionResult = null,
  initialTestCardResult = null,
}: MainChatFeishuBridgePanelProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();

  const [bridgeState, setBridgeState] = useState<FeishuBridgeState>(
    () => initialState ?? createUnavailableFeishuBridgeState(null),
  );
  const [formRevision, setFormRevision] = useState(0);
  const [secretResetCounter, setSecretResetCounter] = useState(0);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [sendingTestCard, setSendingTestCard] = useState(false);
  const [refreshingAudit, setRefreshingAudit] = useState(false);
  const [auditFilter, setAuditFilter] = useState<AuditFilterValue>("all");

  // Form drafts (secrets are write-only, never pre-populated from server!)
  const [enabledDraft, setEnabledDraft] = useState(() => initialState?.config.enabled ?? false);
  const [domainPresetDraft, setDomainPresetDraft] = useState<FeishuBridgeDomainPreset>(
    () => initialState?.config.domainPreset ?? "feishu",
  );
  const [customApiBaseUrlDraft, setCustomApiBaseUrlDraft] = useState(
    () => initialState?.config.apiBaseUrl ?? "",
  );
  const [appIdDraft, setAppIdDraft] = useState(() => initialState?.config.appId ?? "");
  const [appSecretDraft, setAppSecretDraft] = useState("");
  const [clearAppSecret, setClearAppSecret] = useState(false);
  const [verificationTokenDraft, setVerificationTokenDraft] = useState("");
  const [clearVerificationToken, setClearVerificationToken] = useState(false);
  const [encryptKeyDraft, setEncryptKeyDraft] = useState("");
  const [clearEncryptKey, setClearEncryptKey] = useState(false);
  const [receiveIdTypeDraft, setReceiveIdTypeDraft] = useState<FeishuBridgeReceiveIdType>(
    () => initialState?.config.receiveIdType ?? "chat_id",
  );
  const [receiveIdDraft, setReceiveIdDraft] = useState(() => initialState?.config.receiveId ?? "");
  const [allowedOpenIdsDraft, setAllowedOpenIdsDraft] = useState(() =>
    formatOpenIdList(initialState?.config.allowedOpenIds ?? []),
  );
  const [forwardTiersDraft, setForwardTiersDraft] = useState<FeishuBridgeForwardTier[]>(
    () => initialState?.config.forwardTiers ?? ["critical", "actionable"],
  );
  const [respectLowDistractionDraft, setRespectLowDistractionDraft] = useState(
    () => initialState?.config.respectLowDistraction ?? true,
  );
  const [requireSignatureDraft, setRequireSignatureDraft] = useState(
    () => initialState?.config.requireSignature ?? true,
  );
  const [replayWindowDraft, setReplayWindowDraft] = useState(() =>
    String(initialState?.config.replayWindowSeconds ?? FEISHU_BRIDGE_DEFAULT_REPLAY_WINDOW_SEC),
  );

  const [connectionResult, setConnectionResult] = useState<FeishuBridgeConnectionTestResult | null>(
    initialConnectionResult,
  );
  const [testCardResult, setTestCardResult] = useState<FeishuBridgeSendTestCardResult | null>(
    initialTestCardResult,
  );

  const syncFormFromState = useCallback((next: FeishuBridgeState) => {
    setBridgeState(next);
    setEnabledDraft(next.config.enabled);
    setDomainPresetDraft(next.config.domainPreset);
    setCustomApiBaseUrlDraft(next.config.apiBaseUrl);
    setAppIdDraft(next.config.appId);
    setAppSecretDraft("");
    setClearAppSecret(false);
    setVerificationTokenDraft("");
    setClearVerificationToken(false);
    setEncryptKeyDraft("");
    setClearEncryptKey(false);
    setReceiveIdTypeDraft(next.config.receiveIdType);
    setReceiveIdDraft(next.config.receiveId);
    setAllowedOpenIdsDraft(formatOpenIdList(next.config.allowedOpenIds));
    setForwardTiersDraft(next.config.forwardTiers);
    setRespectLowDistractionDraft(next.config.respectLowDistraction);
    setRequireSignatureDraft(next.config.requireSignature);
    setReplayWindowDraft(String(next.config.replayWindowSeconds));
    setFormRevision((rev) => rev + 1);
    setSecretResetCounter((rev) => rev + 1);
  }, []);

  useEffect(() => {
    if (!client || initialState) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await client.getMainChatFeishuBridgeState({ auditLimit: 25 });
        if (cancelled) return;
        if (res.error) {
          toast.error(`${t("mainChat.feishuBridge.loadFailed")}: ${res.error}`);
          return;
        }
        syncFormFromState(res.state);
      } catch (error) {
        if (cancelled) return;
        toast.error(
          `${t("mainChat.feishuBridge.loadFailed")}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, initialState, serverId, syncFormFromState, t, toast]);

  const controlsDisabled = disabled || loading || saving;

  const domainOptions = useMemo<SegmentedControlOption<FeishuBridgeDomainPreset>[]>(
    () => [
      {
        value: "feishu",
        label: t("mainChat.feishuBridge.domainPresets.feishu"),
        disabled: controlsDisabled,
      },
      {
        value: "lark",
        label: t("mainChat.feishuBridge.domainPresets.lark"),
        disabled: controlsDisabled,
      },
      {
        value: "custom",
        label: t("mainChat.feishuBridge.domainPresets.custom"),
        disabled: controlsDisabled,
      },
    ],
    [controlsDisabled, t],
  );

  const receiveIdTypeOptions = useMemo<SegmentedControlOption<FeishuBridgeReceiveIdType>[]>(
    () => [
      {
        value: "chat_id",
        label: t("mainChat.feishuBridge.receiveIdTypes.chat_id"),
        disabled: controlsDisabled,
      },
      {
        value: "open_id",
        label: t("mainChat.feishuBridge.receiveIdTypes.open_id"),
        disabled: controlsDisabled,
      },
      {
        value: "user_id",
        label: t("mainChat.feishuBridge.receiveIdTypes.user_id"),
        disabled: controlsDisabled,
      },
    ],
    [controlsDisabled, t],
  );

  const parsedWhitelist = useMemo(
    () => parseOpenIdList(allowedOpenIdsDraft),
    [allowedOpenIdsDraft],
  );

  const resolvedApiBaseUrl = useMemo(
    () => resolveFeishuBridgeApiBaseUrl(domainPresetDraft, customApiBaseUrlDraft),
    [customApiBaseUrlDraft, domainPresetDraft],
  );

  const webhookDisplayUrl =
    bridgeState.webhookUrl ?? bridgeState.webhookPath ?? FEISHU_BRIDGE_WEBHOOK_PATH;

  const filteredAudit = useMemo(() => {
    if (auditFilter === "all") return bridgeState.recentAudit;
    return bridgeState.recentAudit.filter((entry) => entry.direction === auditFilter);
  }, [auditFilter, bridgeState.recentAudit]);

  const buildConfigPatch = useCallback((): FeishuBridgeConfigPatch => {
    const parsedReplay = Number.parseInt(replayWindowDraft.trim(), 10);
    const replayWindowSeconds = Number.isFinite(parsedReplay)
      ? Math.max(
          FEISHU_BRIDGE_MIN_REPLAY_WINDOW_SEC,
          Math.min(FEISHU_BRIDGE_MAX_REPLAY_WINDOW_SEC, parsedReplay),
        )
      : FEISHU_BRIDGE_DEFAULT_REPLAY_WINDOW_SEC;

    const patch: FeishuBridgeConfigPatch = {
      enabled: enabledDraft,
      domainPreset: domainPresetDraft,
      appId: appIdDraft.trim(),
      receiveIdType: receiveIdTypeDraft,
      receiveId: receiveIdDraft.trim(),
      allowedOpenIds: parseOpenIdList(allowedOpenIdsDraft),
      forwardTiers: forwardTiersDraft,
      respectLowDistraction: respectLowDistractionDraft,
      requireSignature: requireSignatureDraft,
      replayWindowSeconds,
    };
    if (domainPresetDraft === "custom") {
      patch.apiBaseUrl = customApiBaseUrlDraft.trim();
    }
    if (clearAppSecret) {
      patch.clearAppSecret = true;
    } else if (appSecretDraft.trim()) {
      patch.appSecret = appSecretDraft.trim();
    }
    if (clearVerificationToken) {
      patch.clearVerificationToken = true;
    } else if (verificationTokenDraft.trim()) {
      patch.verificationToken = verificationTokenDraft.trim();
    }
    if (clearEncryptKey) {
      patch.clearEncryptKey = true;
    } else if (encryptKeyDraft.trim()) {
      patch.encryptKey = encryptKeyDraft.trim();
    }
    return patch;
  }, [
    allowedOpenIdsDraft,
    appIdDraft,
    appSecretDraft,
    clearAppSecret,
    clearEncryptKey,
    clearVerificationToken,
    customApiBaseUrlDraft,
    domainPresetDraft,
    enabledDraft,
    encryptKeyDraft,
    forwardTiersDraft,
    receiveIdDraft,
    receiveIdTypeDraft,
    replayWindowDraft,
    requireSignatureDraft,
    respectLowDistractionDraft,
    verificationTokenDraft,
  ]);

  const handleToggleTier = useCallback((tier: FeishuBridgeForwardTier) => {
    if (tier === "critical") return;
    setForwardTiersDraft((current) => {
      if (current.includes(tier)) {
        return current.filter((item) => item !== tier);
      }
      return FEISHU_BRIDGE_FORWARD_TIERS.filter((item) => item === tier || current.includes(item));
    });
  }, []);

  const handleToggleClearAppSecret = useCallback(() => {
    setClearAppSecret((prev) => !prev);
    setAppSecretDraft("");
    setSecretResetCounter((rev) => rev + 1);
  }, []);

  const handleToggleClearVerificationToken = useCallback(() => {
    setClearVerificationToken((prev) => !prev);
    setVerificationTokenDraft("");
    setSecretResetCounter((rev) => rev + 1);
  }, []);

  const handleToggleClearEncryptKey = useCallback(() => {
    setClearEncryptKey((prev) => !prev);
    setEncryptKeyDraft("");
    setSecretResetCounter((rev) => rev + 1);
  }, []);

  const handleChangeAppSecret = useCallback((text: string) => {
    setAppSecretDraft(text);
    if (text.trim()) setClearAppSecret(false);
  }, []);

  const handleChangeVerificationToken = useCallback((text: string) => {
    setVerificationTokenDraft(text);
    if (text.trim()) setClearVerificationToken(false);
  }, []);

  const handleChangeEncryptKey = useCallback((text: string) => {
    setEncryptKeyDraft(text);
    if (text.trim()) setClearEncryptKey(false);
  }, []);

  const handleRefreshAudit = useCallback(async () => {
    if (!client) return;
    setRefreshingAudit(true);
    try {
      const res = await client.listMainChatFeishuBridgeAudit({ limit: 30 });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      setBridgeState((prev) => ({
        ...prev,
        stats: res.stats,
        recentAudit: res.records,
      }));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRefreshingAudit(false);
    }
  }, [client, toast]);

  const handleSaveConfig = useCallback(async () => {
    if (!client) return;
    setSaving(true);
    try {
      const res = await client.updateMainChatFeishuBridgeConfig(buildConfigPatch());
      if (res.error || !res.state) {
        toast.error(`${t("mainChat.feishuBridge.saveFailed")}: ${res.error ?? ""}`);
        return;
      }
      syncFormFromState(res.state);
      toast.show(t("mainChat.feishuBridge.savedToast"));
    } catch (error) {
      toast.error(
        `${t("mainChat.feishuBridge.saveFailed")}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setSaving(false);
    }
  }, [buildConfigPatch, client, syncFormFromState, t, toast]);

  const handleTestConnection = useCallback(async () => {
    if (!client) return;
    setTestingConnection(true);
    try {
      const res = await client.testMainChatFeishuBridgeConnection({ forceRefreshToken: false });
      setConnectionResult(res.result);
      if (res.result.ok) {
        toast.show(res.result.message);
      } else {
        toast.error(res.result.message);
      }
      await handleRefreshAudit();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setTestingConnection(false);
    }
  }, [client, handleRefreshAudit, toast]);

  const handleSendTestCard = useCallback(async () => {
    if (!client) return;
    setSendingTestCard(true);
    try {
      const res = await client.sendMainChatFeishuBridgeTestCard({
        receiveId: receiveIdDraft.trim() || undefined,
        receiveIdType: receiveIdTypeDraft,
      });
      setTestCardResult(res.result);
      if (res.result.ok) {
        toast.show(res.result.message);
      } else {
        toast.error(res.result.message);
      }
      await handleRefreshAudit();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSendingTestCard(false);
    }
  }, [client, handleRefreshAudit, receiveIdDraft, receiveIdTypeDraft, toast]);

  const handleCopyWebhookUrl = useCallback(async () => {
    try {
      await copyToClipboard(webhookDisplayUrl);
      toast.copied(t("mainChat.feishuBridge.webhookCopiedToast"));
    } catch {
      toast.error(t("mainChat.feishuBridge.webhookCopyFailed"));
    }
  }, [t, toast, webhookDisplayUrl]);

  const statusBadge = resolveBridgeStatusBadge(bridgeState, enabledDraft, t);

  const formKeyPrefix = `${serverId}:${formRevision}`;
  const secretKeyPrefix = `${serverId}:${secretResetCounter}`;

  return (
    <View style={styles.container} testID="feishu-bridge-panel">
      {/* Card 1: Status, isolation badges, master switch & domain preset */}
      <View style={settingsStyles.card}>
        <View style={[settingsStyles.row, styles.stackedRow]}>
          <View style={styles.badgeCluster}>
            <View testID="feishu-bridge-status-badge">
              <StatusBadge size="xs" variant={statusBadge.variant} label={statusBadge.label} />
            </View>
            <StatusBadge
              size="xs"
              variant="muted"
              leading={BOT_ICON}
              label={t("mainChat.feishuBridge.pluginIsolatedBadge")}
            />
            <StatusBadge
              size="xs"
              variant="success"
              leading={SHIELD_OK_ICON}
              label={t("mainChat.feishuBridge.conservativeGuardBadge")}
            />
          </View>
        </View>

        <View style={[settingsStyles.row, styles.rowDivider, styles.switchRow]}>
          <View style={styles.rowText}>
            <Text style={settingsStyles.rowTitle}>{t("mainChat.feishuBridge.enableLabel")}</Text>
            <Text style={settingsStyles.rowHint}>{t("mainChat.feishuBridge.enableHint")}</Text>
          </View>
          <Switch
            value={enabledDraft}
            onValueChange={setEnabledDraft}
            disabled={controlsDisabled}
            accessibilityLabel={t("mainChat.feishuBridge.enableLabel")}
            testID="feishu-bridge-enable-switch"
          />
        </View>

        <View style={[settingsStyles.row, styles.rowDivider, styles.stackedRow]}>
          <View style={styles.rowText}>
            <Text style={settingsStyles.rowTitle}>
              {t("mainChat.feishuBridge.domainPresetLabel")}
            </Text>
            {domainPresetDraft !== "custom" ? (
              <Text style={settingsStyles.rowHint}>
                {t("mainChat.feishuBridge.resolvedDomainMeta", { url: resolvedApiBaseUrl })}
              </Text>
            ) : null}
          </View>
          <SegmentedControl
            size="sm"
            value={domainPresetDraft}
            options={domainOptions}
            onValueChange={setDomainPresetDraft}
            testID="feishu-bridge-domain-preset"
          />
          {domainPresetDraft === "custom" ? (
            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>{t("mainChat.feishuBridge.apiBaseUrlLabel")}</Text>
              <FormTextInput
                size="sm"
                initialValue={customApiBaseUrlDraft}
                resetKey={`${formKeyPrefix}:apiBaseUrl`}
                onChangeText={setCustomApiBaseUrlDraft}
                placeholder={t("mainChat.feishuBridge.apiBaseUrlPlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!controlsDisabled}
                accessibilityLabel={t("mainChat.feishuBridge.apiBaseUrlLabel")}
                testID="feishu-input-apiBaseUrl"
              />
              <Text style={settingsStyles.rowHint}>
                {t("mainChat.feishuBridge.apiBaseUrlHint")}
              </Text>
            </View>
          ) : null}
        </View>
      </View>

      {/* Card 2: App Credentials & Masked Secrets */}
      <View style={settingsStyles.card}>
        <View style={[settingsStyles.row, styles.stackedRow]}>
          <Text style={settingsStyles.rowTitle}>{t("mainChat.feishuBridge.credentialsTitle")}</Text>
          <Text style={settingsStyles.rowHint}>
            {t("mainChat.feishuBridge.credentialsRedactionNote")}
          </Text>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>{t("mainChat.feishuBridge.appIdLabel")}</Text>
            <FormTextInput
              size="sm"
              initialValue={appIdDraft}
              resetKey={`${formKeyPrefix}:appId`}
              onChangeText={setAppIdDraft}
              placeholder={t("mainChat.feishuBridge.appIdPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!controlsDisabled}
              accessibilityLabel={t("mainChat.feishuBridge.appIdLabel")}
              testID="feishu-input-appId"
            />
          </View>

          <SecretFieldRow
            fieldKey="appSecret"
            label={t("mainChat.feishuBridge.appSecretLabel")}
            hasConfigured={bridgeState.config.hasAppSecret}
            mask={bridgeState.config.appSecretMask}
            resetKey={`${secretKeyPrefix}:appSecret`}
            pendingClear={clearAppSecret}
            disabled={controlsDisabled}
            onChangeText={handleChangeAppSecret}
            onToggleClear={handleToggleClearAppSecret}
          />

          <SecretFieldRow
            fieldKey="verificationToken"
            label={t("mainChat.feishuBridge.verificationTokenLabel")}
            hasConfigured={bridgeState.config.hasVerificationToken}
            mask={bridgeState.config.verificationTokenMask}
            resetKey={`${secretKeyPrefix}:verificationToken`}
            pendingClear={clearVerificationToken}
            disabled={controlsDisabled}
            onChangeText={handleChangeVerificationToken}
            onToggleClear={handleToggleClearVerificationToken}
          />

          <SecretFieldRow
            fieldKey="encryptKey"
            label={t("mainChat.feishuBridge.encryptKeyLabel")}
            hasConfigured={bridgeState.config.hasEncryptKey}
            mask={bridgeState.config.encryptKeyMask}
            resetKey={`${secretKeyPrefix}:encryptKey`}
            pendingClear={clearEncryptKey}
            disabled={controlsDisabled}
            onChangeText={handleChangeEncryptKey}
            onToggleClear={handleToggleClearEncryptKey}
          />
        </View>
      </View>

      {/* Card 3: Target, Whitelist, Tier Filters, Webhook URL & Actions */}
      <View style={settingsStyles.card}>
        <View style={[settingsStyles.row, styles.stackedRow]}>
          <Text style={settingsStyles.rowTitle}>{t("mainChat.feishuBridge.targetTitle")}</Text>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>{t("mainChat.feishuBridge.receiveIdTypeLabel")}</Text>
            <SegmentedControl
              size="sm"
              value={receiveIdTypeDraft}
              options={receiveIdTypeOptions}
              onValueChange={setReceiveIdTypeDraft}
              testID="feishu-bridge-receive-id-type"
            />
          </View>

          <View style={styles.fieldGroup}>
            <Text style={styles.fieldLabel}>{t("mainChat.feishuBridge.receiveIdLabel")}</Text>
            <FormTextInput
              size="sm"
              initialValue={receiveIdDraft}
              resetKey={`${formKeyPrefix}:receiveId`}
              onChangeText={setReceiveIdDraft}
              placeholder={t("mainChat.feishuBridge.receiveIdPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!controlsDisabled}
              accessibilityLabel={t("mainChat.feishuBridge.receiveIdLabel")}
              testID="feishu-input-receiveId"
            />
          </View>

          <View style={styles.fieldGroup}>
            <View style={styles.fieldHeaderRow}>
              <Text style={styles.fieldLabel}>
                {t("mainChat.feishuBridge.allowedOpenIdsLabel")}
              </Text>
              {parsedWhitelist.length === 0 ? (
                <View testID="feishu-whitelist-empty-badge">
                  <StatusBadge
                    size="xs"
                    variant="warning"
                    leading={SHIELD_WARN_ICON}
                    label={t("mainChat.feishuBridge.whitelistEmptyBadge")}
                  />
                </View>
              ) : (
                <View testID="feishu-whitelist-count-badge">
                  <StatusBadge
                    size="xs"
                    variant="success"
                    leading={SHIELD_OK_ICON}
                    label={t("mainChat.feishuBridge.whitelistCountBadge", {
                      count: parsedWhitelist.length,
                    })}
                  />
                </View>
              )}
            </View>
            <FormTextInput
              size="sm"
              initialValue={allowedOpenIdsDraft}
              resetKey={`${formKeyPrefix}:allowedOpenIds`}
              onChangeText={setAllowedOpenIdsDraft}
              placeholder={t("mainChat.feishuBridge.allowedOpenIdsPlaceholder")}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!controlsDisabled}
              accessibilityLabel={t("mainChat.feishuBridge.allowedOpenIdsLabel")}
              testID="feishu-input-allowedOpenIds"
            />
            <Text style={settingsStyles.rowHint}>
              {t("mainChat.feishuBridge.allowedOpenIdsHint")}
            </Text>
          </View>
        </View>

        <View style={[settingsStyles.row, styles.rowDivider, styles.stackedRow]}>
          <View style={styles.rowText}>
            <Text style={settingsStyles.rowTitle}>
              {t("mainChat.feishuBridge.forwardTiersLabel")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("mainChat.feishuBridge.forwardTiersHint")}
            </Text>
          </View>
          <View style={styles.pillRow}>
            {FEISHU_BRIDGE_FORWARD_TIERS.map((tier) => (
              <ForwardTierPill
                key={tier}
                tier={tier}
                selected={tier === "critical" || forwardTiersDraft.includes(tier)}
                locked={tier === "critical"}
                disabled={controlsDisabled}
                onToggle={handleToggleTier}
              />
            ))}
          </View>
        </View>

        <View style={[settingsStyles.row, styles.rowDivider, styles.switchRow]}>
          <View style={styles.rowText}>
            <Text style={settingsStyles.rowTitle}>
              {t("mainChat.feishuBridge.respectLowDistractionLabel")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("mainChat.feishuBridge.respectLowDistractionHint")}
            </Text>
          </View>
          <Switch
            value={respectLowDistractionDraft}
            onValueChange={setRespectLowDistractionDraft}
            disabled={controlsDisabled}
            accessibilityLabel={t("mainChat.feishuBridge.respectLowDistractionLabel")}
            testID="feishu-bridge-low-distraction-switch"
          />
        </View>

        <View style={[settingsStyles.row, styles.rowDivider, styles.switchRow]}>
          <View style={styles.rowText}>
            <Text style={settingsStyles.rowTitle}>
              {t("mainChat.feishuBridge.requireSignatureLabel")}
            </Text>
            <Text style={settingsStyles.rowHint}>
              {t("mainChat.feishuBridge.requireSignatureHint")}
            </Text>
          </View>
          <Switch
            value={requireSignatureDraft}
            onValueChange={setRequireSignatureDraft}
            disabled={controlsDisabled}
            accessibilityLabel={t("mainChat.feishuBridge.requireSignatureLabel")}
            testID="feishu-bridge-require-signature-switch"
          />
        </View>

        <View style={[settingsStyles.row, styles.rowDivider, styles.inlineNumberRow]}>
          <Text style={styles.fieldLabel}>{t("mainChat.feishuBridge.replayWindowLabel")}</Text>
          <FormTextInput
            size="sm"
            initialValue={replayWindowDraft}
            resetKey={`${formKeyPrefix}:replayWindow`}
            onChangeText={setReplayWindowDraft}
            keyboardType="numeric"
            editable={!controlsDisabled}
            style={styles.replayWindowInput}
            accessibilityLabel={t("mainChat.feishuBridge.replayWindowLabel")}
            testID="feishu-input-replayWindowSeconds"
          />
        </View>

        {/* Webhook callback URL display */}
        <View style={[settingsStyles.row, styles.rowDivider, styles.stackedRow]}>
          <View style={styles.fieldHeaderRow}>
            <View style={styles.inlineTitleRow}>
              {LINK_ICON}
              <Text style={settingsStyles.rowTitle}>{t("mainChat.feishuBridge.webhookTitle")}</Text>
            </View>
            <Button
              size="sm"
              variant="secondary"
              leftIcon={COPY_ICON}
              onPress={handleCopyWebhookUrl}
              testID="feishu-copy-webhook-url"
            >
              {t("mainChat.feishuBridge.webhookCopyButton")}
            </Button>
          </View>
          <View style={styles.webhookBox} testID="feishu-webhook-url-box">
            <Text style={styles.webhookUrlText} selectable numberOfLines={2}>
              {webhookDisplayUrl}
            </Text>
          </View>
          <Text style={settingsStyles.rowHint}>{t("mainChat.feishuBridge.webhookHint")}</Text>
        </View>

        {/* Save + Test Connection + Send Test Card */}
        <View style={[settingsStyles.row, styles.rowDivider, styles.actionFooter]}>
          <Button
            size="sm"
            variant="default"
            onPress={handleSaveConfig}
            disabled={controlsDisabled || !client}
            testID="feishu-bridge-save-button"
          >
            {saving
              ? t("mainChat.feishuBridge.savingButton")
              : t("mainChat.feishuBridge.saveButton")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={PLUG_ICON}
            onPress={handleTestConnection}
            disabled={disabled || testingConnection || !client}
            testID="feishu-bridge-test-connection-button"
          >
            {testingConnection
              ? t("mainChat.feishuBridge.testingConnectionButton")
              : t("mainChat.feishuBridge.testConnectionButton")}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            leftIcon={ZAP_ICON}
            onPress={handleSendTestCard}
            disabled={disabled || sendingTestCard || !client}
            testID="feishu-bridge-send-test-card-button"
          >
            {sendingTestCard
              ? t("mainChat.feishuBridge.sendingTestCardButton")
              : t("mainChat.feishuBridge.sendTestCardButton")}
          </Button>
        </View>
      </View>

      {/* Card 4: Connectivity & Test Card Diagnostic Results */}
      <FeishuDiagnosticsCard connectionResult={connectionResult} testCardResult={testCardResult} />

      {/* Card 5: Recent Outbound Delivery & Inbound Callback Audit Ledger */}
      <FeishuAuditLedgerCard
        stats={bridgeState.stats}
        records={filteredAudit}
        auditFilter={auditFilter}
        refreshing={refreshingAudit}
        hasClient={Boolean(client)}
        onSelectFilter={setAuditFilter}
        onRefresh={handleRefreshAudit}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  stackedRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  switchRow: {
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  inlineNumberRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
    flexWrap: "wrap",
  },
  replayWindowInput: {
    width: 92,
  },
  rowDivider: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  inlineTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
    flexShrink: 1,
  },
  fieldGroup: {
    gap: theme.spacing[1.5],
    minWidth: 0,
  },
  fieldHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  badgeCluster: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  pillRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  pillButton: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  pillButtonSelected: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
  },
  pillButtonText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    fontWeight: theme.fontWeight.medium,
  },
  pillButtonTextSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  rowPressed: {
    opacity: 0.78,
  },
  webhookBox: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  webhookUrlText: {
    fontSize: 12,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foreground,
  },
  actionFooter: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  diagnosticMessage: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    lineHeight: 20,
  },
  troubleshootBox: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  troubleshootText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  auditRow: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[1],
  },
  auditTopLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  auditTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
  },
  auditSummary: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
    lineHeight: 18,
  },
  auditMeta: {
    fontSize: 11,
    fontFamily: theme.fontFamily.mono,
    color: theme.colors.foregroundMuted,
  },
}));
