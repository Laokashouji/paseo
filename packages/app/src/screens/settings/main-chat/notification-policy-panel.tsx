import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  MAIN_CHAT_NOTIFICATION_CATEGORIES,
  MAIN_CHAT_NOTIFICATION_TIERS,
  isCriticalPassthroughNotificationCategory,
  resolveMainChatNotificationPolicy,
  type MainChatNotificationCategory,
  type MainChatNotificationDeliveryStatus,
  type MainChatNotificationModePreset,
  type MainChatNotificationReceipt,
  type MainChatNotificationSummary,
  type MainChatNotificationTier,
  type MainChatSettings,
  type MainChatSettingsPatch,
} from "@getpaseo/protocol/main-chat";
import { Bell, BellOff, Check, CheckCircle2, Lock, RefreshCw } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { PressHighlight } from "@/components/ui/press-highlight";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { StatusBadge, type StatusBadgeVariant } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/contexts/toast-context";
import { useMainChatSettingsStore } from "@/main-chat/settings-store";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedBell = withUnistyles(Bell);
const ThemedBellOff = withUnistyles(BellOff);
const ThemedCheck = withUnistyles(Check);
const ThemedCheckCircle = withUnistyles(CheckCircle2);
const ThemedLock = withUnistyles(Lock);
const ThemedRefreshCw = withUnistyles(RefreshCw);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

const REFRESH_ICON = <ThemedRefreshCw size={13} uniProps={mutedIconMapping} />;
const CHECK_ALL_ICON = <ThemedCheckCircle size={13} uniProps={mutedIconMapping} />;
const CHECK_ICON = <ThemedCheck size={12} uniProps={mutedIconMapping} />;
const LOCK_ICON = <ThemedLock size={11} uniProps={dangerIconMapping} />;

const SELECTED_STATE = { selected: true } as const;
const UNSELECTED_STATE = { selected: false } as const;

const MODE_PRESETS: readonly MainChatNotificationModePreset[] = [
  "all",
  "balanced",
  "low_distraction",
];

function receiptStatusBadgeVariant(status: MainChatNotificationDeliveryStatus): StatusBadgeVariant {
  switch (status) {
    case "delivered":
      return "success";
    case "queued":
      return "warning";
    case "suppressed_quiet":
    case "suppressed_night":
    case "acknowledged":
    case "read":
      return "muted";
  }
}

export interface MainChatNotificationPolicyPanelProps {
  serverId: string;
  client: DaemonClient | null;
  settings: MainChatSettings;
  initialReceipts?: readonly MainChatNotificationReceipt[];
  initialSummary?: MainChatNotificationSummary | null;
  disabled?: boolean;
  onApplyPatch: (patch: MainChatSettingsPatch, successMessage?: string) => void;
}

const CategoryTierPill = memo(function CategoryTierPill({
  category,
  tier,
  selected,
  disabled,
  onSelect,
}: {
  category: MainChatNotificationCategory;
  tier: MainChatNotificationTier;
  selected: boolean;
  disabled: boolean;
  onSelect: (category: MainChatNotificationCategory, tier: MainChatNotificationTier) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    if (!disabled) onSelect(category, tier);
  }, [category, disabled, onSelect, tier]);

  return (
    <PressHighlight
      onPress={handlePress}
      disabled={disabled}
      style={[styles.tierPill, selected && styles.tierPillSelected]}
      highlightStyle={styles.rowPressed}
      accessibilityRole="button"
      accessibilityState={selected ? SELECTED_STATE : UNSELECTED_STATE}
      testID={`notify-category-${category}-tier-${tier}`}
    >
      <Text
        style={[styles.tierPillText, selected && styles.tierPillTextSelected]}
        numberOfLines={1}
      >
        {t(`mainChat.notificationPolicy.tiers.${tier}`)}
      </Text>
    </PressHighlight>
  );
});

const CategoryRow = memo(function CategoryRow({
  category,
  activeTier,
  isFirst,
  disabled,
  onChangeTier,
}: {
  category: MainChatNotificationCategory;
  activeTier: MainChatNotificationTier;
  isFirst: boolean;
  disabled: boolean;
  onChangeTier: (category: MainChatNotificationCategory, tier: MainChatNotificationTier) => void;
}): ReactElement {
  const { t } = useTranslation();
  const lockedCritical = isCriticalPassthroughNotificationCategory(category);

  return (
    <View
      style={[styles.categoryRow, !isFirst && styles.rowDivider]}
      testID={`notify-category-row-${category}`}
    >
      <Text style={styles.categoryTitle} numberOfLines={1}>
        {t(`mainChat.notificationPolicy.categories.${category}`)}
      </Text>

      {lockedCritical ? (
        <View testID={`notify-category-passthrough-${category}`}>
          <StatusBadge
            size="xs"
            variant="error"
            leading={LOCK_ICON}
            label={t("mainChat.notificationPolicy.passthroughLockBadge")}
          />
        </View>
      ) : (
        <View style={styles.tierPillsWrap}>
          {MAIN_CHAT_NOTIFICATION_TIERS.map((tier) => (
            <CategoryTierPill
              key={tier}
              category={category}
              tier={tier}
              selected={activeTier === tier}
              disabled={disabled}
              onSelect={onChangeTier}
            />
          ))}
        </View>
      )}
    </View>
  );
});

const ReceiptRow = memo(function ReceiptRow({
  receipt,
  isFirst,
  acking,
  disabled,
  onMarkRead,
}: {
  receipt: MainChatNotificationReceipt;
  isFirst: boolean;
  acking: boolean;
  disabled: boolean;
  onMarkRead: (receiptId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const isRead = receipt.status === "read";
  const handleMarkRead = useCallback(() => onMarkRead(receipt.id), [onMarkRead, receipt.id]);

  return (
    <View
      style={[styles.receiptRow, !isFirst && styles.rowDivider]}
      testID={`notify-receipt-row-${receipt.id}`}
    >
      <View style={styles.receiptBody}>
        <View style={styles.receiptBadgeLine}>
          <StatusBadge
            size="xs"
            variant={receiptStatusBadgeVariant(receipt.status)}
            label={t(`mainChat.notificationPolicy.receiptStatus.${receipt.status}`)}
          />
          <StatusBadge
            size="xs"
            variant="muted"
            label={t(`mainChat.notificationPolicy.receiptChannels.${receipt.channel}`)}
          />
          {receipt.passthrough ? (
            <StatusBadge
              size="xs"
              variant="error"
              label={t("mainChat.notificationPolicy.tiers.critical")}
            />
          ) : null}
        </View>
        <Text style={styles.receiptTitle} numberOfLines={1}>
          {receipt.title}
        </Text>
        <Text style={styles.receiptReason} numberOfLines={2}>
          {receipt.summary || receipt.reason}
        </Text>
      </View>

      {!isRead ? (
        <Button
          variant="outline"
          size="sm"
          leftIcon={CHECK_ICON}
          loading={acking}
          disabled={disabled || acking}
          onPress={handleMarkRead}
          testID={`notify-receipt-ack-${receipt.id}`}
        >
          {t("mainChat.notificationPolicy.receiptMarkRead")}
        </Button>
      ) : null}
    </View>
  );
});

function markSingleReceiptAsRead(
  receipts: readonly MainChatNotificationReceipt[],
  receiptId: string,
  nowIso: string,
): MainChatNotificationReceipt[] {
  return receipts.map((item) =>
    item.id === receiptId ? { ...item, status: "read", readAt: nowIso } : item,
  );
}

function markAllReceiptsAsRead(
  receipts: readonly MainChatNotificationReceipt[],
  nowIso: string,
): MainChatNotificationReceipt[] {
  return receipts.map((item) => ({ ...item, status: "read", readAt: item.readAt ?? nowIso }));
}

export const MainChatNotificationPolicyPanel = memo(function MainChatNotificationPolicyPanel({
  serverId,
  client,
  settings,
  initialReceipts,
  initialSummary,
  disabled = false,
  onApplyPatch,
}: MainChatNotificationPolicyPanelProps): ReactElement {
  const { t } = useTranslation();
  const toast = useToast();
  const hydrateTelemetry = useMainChatSettingsStore((state) => state.hydrateTelemetry);
  const policy = useMemo(() => resolveMainChatNotificationPolicy(settings), [settings]);
  const [receipts, setReceipts] = useState<readonly MainChatNotificationReceipt[]>(
    () => initialReceipts ?? [],
  );
  const [summary, setSummary] = useState<MainChatNotificationSummary | null>(
    () => initialSummary ?? null,
  );
  const [loadingReceipts, setLoadingReceipts] = useState(false);
  const [ackingId, setAckingId] = useState<string | null>(null);
  const [ackingAll, setAckingAll] = useState(false);

  const loadReceipts = useCallback(async () => {
    if (!client || typeof client.listMainChatNotificationReceipts !== "function") return;
    setLoadingReceipts(true);
    try {
      const response = await client.listMainChatNotificationReceipts({ limit: 12 });
      if (response.error) {
        toast.error(response.error);
        return;
      }
      setReceipts(response.receipts ?? []);
      if (response.summary) {
        setSummary(response.summary);
        hydrateTelemetry(serverId, { notificationSummary: response.summary });
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("mainChat.notificationPolicy.receiptLoadFailed"),
      );
    } finally {
      setLoadingReceipts(false);
    }
  }, [client, hydrateTelemetry, serverId, t, toast]);

  useEffect(() => {
    void loadReceipts();
  }, [loadReceipts]);

  const modeOptions = useMemo<SegmentedControlOption<MainChatNotificationModePreset>[]>(
    () =>
      MODE_PRESETS.map((mode) => ({
        value: mode,
        label: t(`mainChat.notificationPolicy.modes.${mode}`),
        disabled,
      })),
    [disabled, t],
  );

  const handleSelectMode = useCallback(
    (mode: MainChatNotificationModePreset) => {
      if (disabled || mode === policy.mode) return;
      onApplyPatch(
        {
          notificationPolicy: {
            mode,
            lowDistractionEnabled: mode === "low_distraction",
            foldLowPriorityToDigest: mode === "low_distraction",
          },
        },
        t("mainChat.notificationPolicy.savedToast"),
      );
    },
    [disabled, onApplyPatch, policy.mode, t],
  );

  const handleToggleLowDistraction = useCallback(
    (lowDistractionEnabled: boolean) => {
      onApplyPatch(
        {
          notificationPolicy: {
            lowDistractionEnabled,
            mode: lowDistractionEnabled ? "low_distraction" : "balanced",
            ...(lowDistractionEnabled ? { foldLowPriorityToDigest: true } : {}),
          },
        },
        t("mainChat.notificationPolicy.savedToast"),
      );
    },
    [onApplyPatch, t],
  );

  const handleToggleFoldDigest = useCallback(
    (foldLowPriorityToDigest: boolean) => {
      onApplyPatch(
        {
          notificationPolicy: { foldLowPriorityToDigest },
        },
        t("mainChat.notificationPolicy.savedToast"),
      );
    },
    [onApplyPatch, t],
  );

  const handleChangeCategoryTier = useCallback(
    (category: MainChatNotificationCategory, tier: MainChatNotificationTier) => {
      if (isCriticalPassthroughNotificationCategory(category)) return;
      onApplyPatch(
        {
          notificationPolicy: {
            categoryOverrides: {
              ...policy.categoryOverrides,
              [category]: tier,
            },
          },
        },
        t("mainChat.notificationPolicy.savedToast"),
      );
    },
    [onApplyPatch, policy.categoryOverrides, t],
  );

  const runMarkSingleRead = useCallback(
    async (receiptId: string) => {
      if (!client || typeof client.ackMainChatNotificationReceipt !== "function") return;
      setAckingId(receiptId);
      try {
        const response = await client.ackMainChatNotificationReceipt({ receiptId, status: "read" });
        if (response.error) throw new Error(response.error);
        const nowIso = new Date().toISOString();
        setReceipts((prev) => markSingleReceiptAsRead(prev, receiptId, nowIso));
        if (response.summary) {
          setSummary(response.summary);
          hydrateTelemetry(serverId, { notificationSummary: response.summary });
        }
        toast.show(t("mainChat.notificationPolicy.receiptMarkedReadToast"), {
          variant: "success",
        });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("mainChat.notificationPolicy.saveFailed"),
        );
      } finally {
        setAckingId(null);
      }
    },
    [client, hydrateTelemetry, serverId, t, toast],
  );

  const handleMarkRead = useCallback(
    (receiptId: string) => {
      if (ackingId) return;
      void runMarkSingleRead(receiptId);
    },
    [ackingId, runMarkSingleRead],
  );

  const runMarkAllRead = useCallback(async () => {
    if (!client || typeof client.ackMainChatNotificationReceipt !== "function") return;
    setAckingAll(true);
    try {
      const response = await client.ackMainChatNotificationReceipt({
        markAll: true,
        status: "read",
      });
      if (response.error) throw new Error(response.error);
      const nowIso = new Date().toISOString();
      setReceipts((prev) => markAllReceiptsAsRead(prev, nowIso));
      if (response.summary) {
        setSummary(response.summary);
        hydrateTelemetry(serverId, { notificationSummary: response.summary });
      }
      toast.show(
        t("mainChat.notificationPolicy.receiptAllReadToast", {
          count: response.updatedCount ?? 0,
        }),
        { variant: "success" },
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("mainChat.notificationPolicy.saveFailed"),
      );
    } finally {
      setAckingAll(false);
    }
  }, [client, hydrateTelemetry, serverId, t, toast]);

  const handleMarkAllRead = useCallback(() => {
    if (ackingAll) return;
    void runMarkAllRead();
  }, [ackingAll, runMarkAllRead]);

  const handleRefresh = useCallback(() => {
    void loadReceipts();
  }, [loadReceipts]);

  const unreadCount = summary?.unreadCount ?? receipts.filter((r) => r.status !== "read").length;

  return (
    <View style={settingsStyles.card} testID="settings-main-chat-notification-policy-panel">
      <View style={[settingsStyles.row, styles.stackedRow]}>
        <View style={styles.headerLine}>
          <View style={styles.titleIconRow}>
            {policy.lowDistractionEnabled ? (
              <ThemedBellOff size={14} uniProps={mutedIconMapping} />
            ) : (
              <ThemedBell size={14} uniProps={mutedIconMapping} />
            )}
            <Text style={settingsStyles.rowTitle}>
              {t("mainChat.notificationPolicy.modeLabel")}
            </Text>
          </View>
          {summary ? (
            <Text
              style={styles.summaryStats}
              numberOfLines={1}
              testID="notify-policy-summary-stats"
            >
              {t("mainChat.notificationPolicy.summaryStatsLine", {
                unread: summary.unreadCount,
                quiet: summary.suppressedQuietCount,
                night: summary.suppressedNightCount,
              })}
            </Text>
          ) : null}
        </View>

        <SegmentedControl
          options={modeOptions}
          value={policy.mode ?? "balanced"}
          onValueChange={handleSelectMode}
          testID="notify-policy-mode-segment"
        />
      </View>

      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.switchRow]}>
        <View style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>
            {t("mainChat.notificationPolicy.lowDistractionSwitchLabel")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("mainChat.notificationPolicy.lowDistractionSwitchHint")}
          </Text>
        </View>
        <Switch
          value={policy.lowDistractionEnabled}
          onValueChange={handleToggleLowDistraction}
          disabled={disabled}
          accessibilityLabel={t("mainChat.notificationPolicy.lowDistractionSwitchLabel")}
          testID="notify-policy-low-distraction-switch"
        />
      </View>

      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.switchRow]}>
        <View style={styles.rowText}>
          <Text style={settingsStyles.rowTitle}>
            {t("mainChat.notificationPolicy.foldDigestSwitchLabel")}
          </Text>
          <Text style={settingsStyles.rowHint}>
            {t("mainChat.notificationPolicy.foldDigestSwitchHint")}
          </Text>
        </View>
        <Switch
          value={policy.foldLowPriorityToDigest}
          onValueChange={handleToggleFoldDigest}
          disabled={disabled}
          accessibilityLabel={t("mainChat.notificationPolicy.foldDigestSwitchLabel")}
          testID="notify-policy-fold-digest-switch"
        />
      </View>

      <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.stackedRow]}>
        <Text style={settingsStyles.rowTitle}>
          {t("mainChat.notificationPolicy.categoriesHeading")}
        </Text>
        <View style={styles.listBox}>
          {MAIN_CHAT_NOTIFICATION_CATEGORIES.map((category, index) => (
            <CategoryRow
              key={category}
              category={category}
              activeTier={policy.categoryOverrides?.[category] ?? "actionable"}
              isFirst={index === 0}
              disabled={disabled}
              onChangeTier={handleChangeCategoryTier}
            />
          ))}
        </View>
      </View>

      <View
        style={[settingsStyles.row, settingsStyles.rowBorder, styles.stackedRow]}
        testID="notify-receipts-section"
      >
        <View style={styles.headerLine}>
          <Text style={settingsStyles.rowTitle}>
            {t("mainChat.notificationPolicy.receiptsHeading")}
          </Text>
          <View style={styles.receiptActions}>
            <Button
              variant="outline"
              size="sm"
              leftIcon={REFRESH_ICON}
              loading={loadingReceipts}
              disabled={!client || loadingReceipts}
              onPress={handleRefresh}
              testID="notify-receipts-refresh"
            >
              {t("mainChat.notificationPolicy.receiptsRefresh")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              leftIcon={CHECK_ALL_ICON}
              loading={ackingAll}
              disabled={!client || ackingAll || unreadCount === 0}
              onPress={handleMarkAllRead}
              testID="notify-receipts-mark-all-read"
            >
              {t("mainChat.notificationPolicy.receiptsMarkAllRead")}
            </Button>
          </View>
        </View>

        {receipts.length === 0 ? (
          <Text style={settingsStyles.rowHint} testID="notify-receipts-empty">
            {t("mainChat.notificationPolicy.receiptsEmpty")}
          </Text>
        ) : (
          <View style={styles.listBox}>
            {receipts.map((receipt, index) => (
              <ReceiptRow
                key={receipt.id}
                receipt={receipt}
                isFirst={index === 0}
                acking={ackingId === receipt.id}
                disabled={disabled || !client}
                onMarkRead={handleMarkRead}
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  stackedRow: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[3],
  },
  rowText: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  headerLine: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  titleIconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
    flexShrink: 1,
  },
  summaryStats: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  listBox: {
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    overflow: "hidden",
  },
  rowDivider: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  categoryRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  categoryTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 110,
  },
  tierPillsWrap: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  tierPill: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
  },
  tierPillSelected: {
    borderColor: theme.colors.primary,
    backgroundColor: theme.colors.surface2,
  },
  tierPillText: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
  tierPillTextSelected: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  rowPressed: {
    opacity: 0.72,
  },
  receiptActions: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1.5],
  },
  receiptRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  receiptBody: {
    flex: 1,
    minWidth: 160,
    gap: theme.spacing[1],
  },
  receiptBadgeLine: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[1],
  },
  receiptTitle: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  receiptReason: {
    fontSize: 12,
    color: theme.colors.foregroundMuted,
  },
}));
