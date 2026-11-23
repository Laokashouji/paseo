import type {
  MainChatTokenUsageCounters,
  MainChatTokenUsageSource,
  MainChatTokenUsageSummary,
} from "@getpaseo/protocol/main-chat";
import { Activity, RefreshCw, RotateCcw } from "lucide-react-native";
import { memo, useCallback, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { formatCompactTokenCount, formatTokenCostUsd } from "@/main-chat/usage-format";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";

const ThemedActivity = withUnistyles(Activity);
const ThemedRefreshCw = withUnistyles(RefreshCw);
const ThemedRotateCcw = withUnistyles(RotateCcw);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const spinnerIcon = <ThemedSpinner size="small" uniProps={mutedIconMapping} />;
const refreshIcon = <ThemedRefreshCw size={13} uniProps={mutedIconMapping} />;
const resetIcon = <ThemedRotateCcw size={13} uniProps={mutedIconMapping} />;

const SOURCE_ORDER: readonly MainChatTokenUsageSource[] = [
  "foreground",
  "background",
  "direction",
  "triage",
];

function sourceLabelKey(source: MainChatTokenUsageSource): string {
  switch (source) {
    case "foreground":
      return "mainChat.usage.sources.foreground";
    case "background":
      return "mainChat.usage.sources.background";
    case "direction":
      return "mainChat.usage.sources.direction";
    case "triage":
      return "mainChat.usage.sources.triage";
  }
}

const UsageKpiTile = memo(function UsageKpiTile({
  label,
  counters,
  testID,
}: {
  label: string;
  counters: MainChatTokenUsageCounters;
  testID: string;
}) {
  const { t } = useTranslation();
  const hasCost = counters.costUsd > 0;
  return (
    <View style={styles.kpiTile} testID={testID}>
      <Text style={styles.kpiLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.kpiValue} numberOfLines={1}>
        {formatCompactTokenCount(counters.totalTokens)}
      </Text>
      <Text style={styles.kpiMeta} numberOfLines={1}>
        {hasCost
          ? `${t("mainChat.usage.turnsCount", { count: counters.turns })} · ${formatTokenCostUsd(counters.costUsd)}`
          : t("mainChat.usage.turnsCount", { count: counters.turns })}
      </Text>
      <Text style={styles.kpiBreakdown} numberOfLines={1}>
        {t("mainChat.usage.ioBreakdown", {
          input: formatCompactTokenCount(counters.inputTokens),
          cached: formatCompactTokenCount(counters.cachedInputTokens),
          output: formatCompactTokenCount(counters.outputTokens),
        })}
      </Text>
    </View>
  );
});

const SourceBarRow = memo(function SourceBarRow({
  source,
  counters,
  totalTokens,
}: {
  source: MainChatTokenUsageSource;
  counters: MainChatTokenUsageCounters;
  totalTokens: number;
}) {
  const { t } = useTranslation();
  const ratio = totalTokens > 0 ? Math.min(1, counters.totalTokens / totalTokens) : 0;
  const percent = totalTokens > 0 ? Math.round(ratio * 100) : 0;
  return (
    <View style={styles.sourceRow} testID={`settings-main-chat-usage-source-${source}`}>
      <View style={styles.sourceRowHeader}>
        <Text style={styles.sourceLabel} numberOfLines={1}>
          {t(sourceLabelKey(source))}
        </Text>
        <Text style={styles.sourceNumbers} numberOfLines={1}>
          {`${formatCompactTokenCount(counters.totalTokens)} (${percent}%) · ${t("mainChat.usage.turnsCount", { count: counters.turns })}`}
        </Text>
      </View>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            source === "foreground" && styles.barFillForeground,
            source === "background" && styles.barFillBackground,
            source === "direction" && styles.barFillDirection,
            source === "triage" && styles.barFillTriage,
            { width: `${Math.max(counters.totalTokens > 0 ? 2 : 0, Math.round(ratio * 100))}%` },
          ]}
        />
      </View>
    </View>
  );
});

const UsageResetControls = memo(function UsageResetControls({
  visible,
  confirmingReset,
  resetting,
  onResetPress,
  onCancelReset,
}: {
  visible: boolean;
  confirmingReset: boolean;
  resetting: boolean;
  onResetPress: () => void;
  onCancelReset: () => void;
}): ReactElement | null {
  const { t } = useTranslation();
  if (!visible) return null;
  if (confirmingReset) {
    return (
      <>
        <Button variant="ghost" size="sm" onPress={onCancelReset} disabled={resetting}>
          {t("common.cancel")}
        </Button>
        <Button
          variant="destructive"
          size="sm"
          onPress={onResetPress}
          disabled={resetting}
          testID="settings-main-chat-usage-reset-confirm"
        >
          {t("mainChat.usage.confirmResetButton")}
        </Button>
      </>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      leftIcon={resetIcon}
      onPress={onResetPress}
      disabled={resetting}
      testID="settings-main-chat-usage-reset"
    >
      {t("mainChat.usage.resetButton")}
    </Button>
  );
});

export interface MainChatTokenUsagePanelProps {
  usage: MainChatTokenUsageSummary | null;
  loading: boolean;
  resetting: boolean;
  onRefresh: () => void;
  onReset: () => void;
}

export const MainChatTokenUsagePanel = memo(function MainChatTokenUsagePanel({
  usage,
  loading,
  resetting,
  onRefresh,
  onReset,
}: MainChatTokenUsagePanelProps): ReactElement {
  const { t } = useTranslation();
  const [confirmingReset, setConfirmingReset] = useState(false);

  const handleResetPress = useCallback(() => {
    if (!confirmingReset) {
      setConfirmingReset(true);
      return;
    }
    setConfirmingReset(false);
    onReset();
  }, [confirmingReset, onReset]);

  const handleCancelReset = useCallback(() => {
    setConfirmingReset(false);
  }, []);

  const totalAllTime = usage?.allTime.totalTokens ?? 0;
  const recentDaily = (usage?.daily ?? []).slice(-7).toReversed();
  const maxDailyTokens = recentDaily.reduce((max, entry) => Math.max(max, entry.totalTokens), 0);
  const topModels = (usage?.byModel ?? []).slice(0, 6);

  return (
    <View style={settingsStyles.card} testID="settings-main-chat-usage-card">
      <View style={[settingsStyles.row, styles.headerRow]}>
        <View style={styles.headerTitleGroup}>
          <ThemedActivity size={16} uniProps={mutedIconMapping} />
          <Text style={settingsStyles.rowTitle}>{t("mainChat.usage.cardTitle")}</Text>
        </View>
        <View style={styles.headerActions}>
          <Button
            variant="ghost"
            size="sm"
            leftIcon={loading ? spinnerIcon : refreshIcon}
            onPress={onRefresh}
            disabled={loading}
            testID="settings-main-chat-usage-refresh"
          >
            {t("mainChat.usage.refreshButton")}
          </Button>
          <UsageResetControls
            visible={totalAllTime > 0}
            confirmingReset={confirmingReset}
            resetting={resetting}
            onResetPress={handleResetPress}
            onCancelReset={handleCancelReset}
          />
        </View>
      </View>

      {usage ? (
        <>
          <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.kpiGrid]}>
            <UsageKpiTile
              label={t("mainChat.usage.todayLabel")}
              counters={usage.today}
              testID="settings-main-chat-usage-today"
            />
            <UsageKpiTile
              label={t("mainChat.usage.last7DaysLabel")}
              counters={usage.last7Days}
              testID="settings-main-chat-usage-7d"
            />
            <UsageKpiTile
              label={t("mainChat.usage.allTimeLabel")}
              counters={usage.allTime}
              testID="settings-main-chat-usage-all"
            />
          </View>

          {totalAllTime > 0 ? (
            <>
              <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.stackedSection]}>
                <Text style={styles.subsectionTitle}>{t("mainChat.usage.bySourceTitle")}</Text>
                {SOURCE_ORDER.map((source) => (
                  <SourceBarRow
                    key={source}
                    source={source}
                    counters={usage.bySource[source]}
                    totalTokens={totalAllTime}
                  />
                ))}
              </View>

              {topModels.length > 0 ? (
                <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.stackedSection]}>
                  <Text style={styles.subsectionTitle}>{t("mainChat.usage.byModelTitle")}</Text>
                  {topModels.map((entry) => (
                    <View key={`${entry.provider}:${entry.model ?? ""}`} style={styles.detailRow}>
                      <Text style={styles.detailName} numberOfLines={1}>
                        {entry.model ? `${entry.provider} / ${entry.model}` : entry.provider}
                      </Text>
                      <Text style={styles.detailMetric} numberOfLines={1}>
                        {entry.costUsd > 0
                          ? `${formatCompactTokenCount(entry.totalTokens)} · ${t("mainChat.usage.turnsCount", { count: entry.turns })} · ${formatTokenCostUsd(entry.costUsd)}`
                          : `${formatCompactTokenCount(entry.totalTokens)} · ${t("mainChat.usage.turnsCount", { count: entry.turns })}`}
                      </Text>
                    </View>
                  ))}
                </View>
              ) : null}

              {recentDaily.length > 0 ? (
                <View style={[settingsStyles.row, settingsStyles.rowBorder, styles.stackedSection]}>
                  <Text style={styles.subsectionTitle}>{t("mainChat.usage.dailyTitle")}</Text>
                  {recentDaily.map((entry) => {
                    const widthPct =
                      maxDailyTokens > 0
                        ? Math.max(4, Math.round((entry.totalTokens / maxDailyTokens) * 100))
                        : 0;
                    return (
                      <View key={entry.date} style={styles.dailyRow}>
                        <Text style={styles.dailyDate}>{entry.date}</Text>
                        <View style={styles.dailyBarTrack}>
                          <View style={[styles.dailyBarFill, { width: `${widthPct}%` }]} />
                        </View>
                        <Text style={styles.dailyValue} numberOfLines={1}>
                          {formatCompactTokenCount(entry.totalTokens)}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </>
          ) : (
            <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
              <Text style={styles.emptyHint}>{t("mainChat.usage.emptyHint")}</Text>
            </View>
          )}
        </>
      ) : (
        <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
          <Text style={styles.emptyHint}>
            {loading ? t("common.states.loading") : t("mainChat.usage.emptyHint")}
          </Text>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  headerRow: {
    flexWrap: "wrap",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  headerTitleGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  kpiTile: {
    flex: 1,
    minWidth: 140,
    backgroundColor: theme.colors.surface1,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    padding: theme.spacing[3],
    gap: 3,
  },
  kpiLabel: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  kpiValue: {
    fontSize: theme.fontSize.xl,
    fontWeight: theme.fontWeight.bold,
    color: theme.colors.foreground,
  },
  kpiMeta: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  kpiBreakdown: {
    fontSize: 11,
    color: theme.colors.foregroundExtraMuted,
  },
  stackedSection: {
    flexDirection: "column",
    alignItems: "stretch",
    gap: theme.spacing[2],
  },
  subsectionTitle: {
    fontSize: 11,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  sourceRow: {
    gap: 4,
  },
  sourceRowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  sourceLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  sourceNumbers: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  barTrack: {
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  barFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  barFillForeground: {
    backgroundColor: theme.colors.accent,
  },
  barFillBackground: {
    backgroundColor: theme.colors.statusWarning,
  },
  barFillDirection: {
    backgroundColor: theme.colors.statusDotRunning,
  },
  barFillTriage: {
    backgroundColor: theme.colors.foregroundMuted,
  },
  detailRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  detailName: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  detailMetric: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    flexShrink: 0,
  },
  dailyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  dailyDate: {
    width: 82,
    fontSize: 11,
    color: theme.colors.foregroundMuted,
  },
  dailyBarTrack: {
    flex: 1,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
  },
  dailyBarFill: {
    height: "100%",
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  dailyValue: {
    width: 58,
    textAlign: "right",
    fontSize: 11,
    color: theme.colors.foreground,
  },
  emptyHint: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
