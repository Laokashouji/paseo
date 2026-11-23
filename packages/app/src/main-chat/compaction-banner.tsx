import type { MainChatCompactionState } from "@getpaseo/protocol/main-chat";
import { AlertTriangle, Minimize2, RefreshCw } from "lucide-react-native";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";

export const COMPACTION_WARNING_RATIO = 0.7;

const ThemedAlertIcon = withUnistyles(AlertTriangle);
const ThemedMinimizeIcon = withUnistyles(Minimize2);
const ThemedRefreshIcon = withUnistyles(RefreshCw);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function computeCompactionUsageRatio(
  compaction:
    | Pick<MainChatCompactionState, "estimatedTokens" | "thresholdTokens">
    | null
    | undefined,
): number {
  if (!compaction || compaction.thresholdTokens <= 0) return 0;
  return Math.max(0, compaction.estimatedTokens / compaction.thresholdTokens);
}

export function shouldShowCompactionBanner(
  compaction: MainChatCompactionState | null | undefined,
): boolean {
  if (!compaction) return false;
  if (compaction.status === "running" || compaction.status === "failed") {
    return true;
  }
  return computeCompactionUsageRatio(compaction) >= COMPACTION_WARNING_RATIO;
}

export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens < 0) return "0";
  if (tokens >= 1000) {
    const thousands = tokens / 1000;
    return `${thousands >= 100 ? Math.round(thousands) : Number(thousands.toFixed(1))}k`;
  }
  return String(Math.round(tokens));
}

function formatCompactedTime(iso: string | null): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  try {
    return new Date(parsed).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

function renderCompactionLeadingIcon(isRunning: boolean, isFailed: boolean): ReactElement {
  if (isRunning) {
    return <ThemedLoadingSpinner size="small" uniProps={mutedIconMapping} />;
  }
  if (isFailed) {
    return <ThemedAlertIcon size={14} uniProps={dangerIconMapping} />;
  }
  return <ThemedMinimizeIcon size={14} uniProps={warningIconMapping} />;
}

function buildCompactionHeadline(
  compaction: MainChatCompactionState,
  isRunning: boolean,
  isFailed: boolean,
  ratioPct: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  if (isRunning) {
    return t("mainChat.compaction.runningTitle");
  }
  if (isFailed) {
    const trimmedError = compaction.lastError?.trim();
    return trimmedError
      ? t("mainChat.compaction.failedWithError", { error: trimmedError })
      : t("mainChat.compaction.failedTitle");
  }
  return t("mainChat.compaction.highUsageTitle", { percent: ratioPct });
}

export interface MainChatCompactionBannerProps {
  serverId: string | null;
  mainAgentId: string | null | undefined;
  /** Optional explicit compaction state override (primarily for tests/previews). */
  compactionOverride?: MainChatCompactionState | null;
}

/**
 * Compact context-compaction status strip shown below the Main Chat shell header only when
 * compaction is running, failed, or estimated token usage reaches >= 70% of the threshold.
 */
export const MainChatCompactionBanner = memo(function MainChatCompactionBanner({
  serverId,
  mainAgentId,
  compactionOverride,
}: MainChatCompactionBannerProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();

  const overviewKey = serverId && mainAgentId ? overviewStoreKey(serverId, mainAgentId) : null;
  const storeCompaction = useMainChatOverviewStore((state) =>
    overviewKey ? (state.overviewsByKey[overviewKey]?.compaction ?? null) : null,
  );
  const compactMainChat = useMainChatOverviewStore((state) => state.compactMainChat);
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);
  const client = useSessionStore((state) =>
    serverId ? (state.sessions[serverId]?.client ?? null) : null,
  );

  const [submitting, setSubmitting] = useState(false);

  const compaction = compactionOverride !== undefined ? compactionOverride : storeCompaction;
  const visible = shouldShowCompactionBanner(compaction);

  const handleCompact = useCallback(() => {
    if (!serverId || !mainAgentId || !client || submitting) return;
    setSubmitting(true);
    void compactMainChat(serverId, mainAgentId, client, { reason: "manual" })
      .then((result) => {
        toast.show(result?.summary?.trim() || t("mainChat.compaction.successToast"), {
          variant: "success",
        });
        return loadOverview(serverId, mainAgentId, client);
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : t("mainChat.compaction.failedToast"));
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [client, compactMainChat, loadOverview, mainAgentId, serverId, submitting, t, toast]);

  const isRunning = compaction?.status === "running" || submitting;
  const isFailed = !isRunning && compaction?.status === "failed";

  const bannerStyle = useMemo(
    () => [styles.banner, isFailed ? styles.bannerFailed : styles.bannerWarning],
    [isFailed],
  );

  if (!visible || !compaction) {
    return null;
  }

  const ratioPct = Math.min(999, Math.round(computeCompactionUsageRatio(compaction) * 100));
  const tokensText = t("mainChat.compaction.usageTokens", {
    used: formatTokenCount(compaction.estimatedTokens),
    threshold: formatTokenCount(compaction.thresholdTokens),
    percent: ratioPct,
  });
  const lastTime = formatCompactedTime(compaction.lastCompactedAt);
  const headline = buildCompactionHeadline(compaction, isRunning, isFailed, ratioPct, t);
  const metaParts = [
    tokensText,
    lastTime ? t("mainChat.compaction.lastCompactedAt", { time: lastTime }) : null,
  ].filter(Boolean);
  const actionDisabled = isRunning || !client || !serverId || !mainAgentId;

  return (
    <View style={bannerStyle} testID="main-chat-compaction-banner">
      <View style={styles.leading}>{renderCompactionLeadingIcon(isRunning, isFailed)}</View>

      <View style={styles.textCol}>
        <Text
          style={[styles.headline, isFailed && styles.headlineFailed]}
          numberOfLines={1}
          testID="main-chat-compaction-headline"
        >
          {headline}
        </Text>
        <Text style={styles.meta} numberOfLines={1} testID="main-chat-compaction-meta">
          {metaParts.join(" · ")}
        </Text>
      </View>

      <Button
        variant={isFailed ? "outline" : "secondary"}
        size="sm"
        loading={isRunning}
        disabled={actionDisabled}
        leftIcon={isFailed ? ThemedRefreshIcon : ThemedMinimizeIcon}
        onPress={handleCompact}
        testID="main-chat-compaction-action"
      >
        {isFailed ? t("mainChat.compaction.retryButton") : t("mainChat.compaction.compactButton")}
      </Button>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  bannerWarning: {
    backgroundColor: theme.colors.statusWarningTint,
  },
  bannerFailed: {
    backgroundColor: theme.colors.statusDangerTint,
  },
  leading: {
    width: 18,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  textCol: {
    flex: 1,
    minWidth: 0,
    gap: 1,
  },
  headline: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  headlineFailed: {
    color: theme.colors.statusDanger,
  },
  meta: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
