import type { MainChatNextStepSuggestion, MainChatOverview } from "@getpaseo/protocol/main-chat";
import type { TFunction } from "i18next";
import { AlertTriangle, ArrowUpRight, Sparkles } from "lucide-react-native";
import { memo, useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PressHighlight } from "@/components/ui/press-highlight";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import { useSettings } from "@/hooks/use-settings";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { buildDraftStoreKey } from "@/stores/draft-keys";
import { useDraftStore } from "@/stores/draft-store";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { overviewStoreKey, useMainChatOverviewStore } from "./overview-store";
import { dispatchMainChatPromptText } from "./queue-panel";

const ThemedAlertTriangle = withUnistyles(AlertTriangle);
const ThemedSend = withUnistyles(ArrowUpRight);
const ThemedSparkles = withUnistyles(Sparkles);
const ThemedSpinner = withUnistyles(LoadingSpinner);

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const primaryIconMapping = (theme: Theme) => ({ color: theme.colors.primary });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const MAX_NEXT_STEP_SUGGESTIONS = 4;

const RISKY_NEXT_STEP_PATTERN =
  /\b(merge|push|deploy|publish|delete|remove|drop|reset|rebase|force|rewrite|write|modify|mutate|dispatch|start\s+plan|apply)\b|(合并|推送|发布|部署|删除|重置|强推|强制|修改|写改|派发|启动执行|执行变更)/i;

export function isRiskyNextStepPrompt(text: string): boolean {
  return RISKY_NEXT_STEP_PATTERN.test(text);
}

/**
 * Resolves up to 4 compact next-step suggestion chips. Prefers daemon-computed
 * `overview.nextStepSuggestions` and falls back to lightweight overview-driven suggestions when
 * the server has not provided any yet.
 */
export function resolveMainChatNextStepSuggestions(input: {
  overview: MainChatOverview | null | undefined;
  explicitSuggestions?: readonly MainChatNextStepSuggestion[];
  t: TFunction;
  maxItems?: number;
}): MainChatNextStepSuggestion[] {
  const maxItems = Math.max(1, input.maxItems ?? MAX_NEXT_STEP_SUGGESTIONS);
  const direct = input.explicitSuggestions ?? input.overview?.nextStepSuggestions;
  if (direct && direct.length > 0) {
    return direct.slice(0, maxItems);
  }

  const overview = input.overview;
  if (!overview) return [];

  const fallbacks: MainChatNextStepSuggestion[] = [];
  const tasks = overview.tasks ?? [];
  const activeCount = tasks.filter(
    (task) => task.status === "running" || task.status === "open" || task.status === "needs_you",
  ).length;
  const awaitingReviewCount = tasks.filter((task) => task.status === "awaiting_review").length;
  const hasOpenPlan = overview.plans.some((plan) => plan.status === "open");

  if (activeCount > 0) {
    fallbacks.push({
      id: "fallback:summarize-active",
      label: input.t("mainChat.composer.nextSteps.fallbackSummarizeActive"),
      prompt: input.t("mainChat.composer.nextSteps.fallbackSummarizeActivePrompt"),
      risky: false,
    });
  }

  if (awaitingReviewCount > 0) {
    fallbacks.push({
      id: "fallback:review-awaiting",
      label: input.t("mainChat.composer.nextSteps.fallbackReviewAwaiting"),
      prompt: input.t("mainChat.composer.nextSteps.fallbackReviewAwaitingPrompt"),
      risky: false,
    });
  }

  if (hasOpenPlan) {
    fallbacks.push({
      id: "fallback:start-open-plan",
      label: input.t("mainChat.composer.nextSteps.fallbackStartOpenPlan"),
      prompt: input.t("mainChat.composer.nextSteps.fallbackStartOpenPlanPrompt"),
      risky: true,
    });
  }

  const receipts = overview.recentReceipts ?? [];
  for (let i = 0; i < receipts.length && fallbacks.length < maxItems; i += 1) {
    const firstStep = receipts[i]?.nextSteps.find((step) => step.trim().length > 0);
    if (!firstStep) continue;
    const trimmed = firstStep.trim();
    fallbacks.push({
      id: `fallback:receipt-step:${i}`,
      label: trimmed.length > 26 ? `${trimmed.slice(0, 26)}…` : trimmed,
      prompt: trimmed,
      risky: isRiskyNextStepPrompt(trimmed),
    });
  }

  if (fallbacks.length === 0) {
    fallbacks.push({
      id: "fallback:patrol-fleet",
      label: input.t("mainChat.composer.nextSteps.fallbackPatrolFleet"),
      prompt: input.t("mainChat.composer.nextSteps.fallbackPatrolFleetPrompt"),
      risky: false,
    });
  }

  return fallbacks.slice(0, maxItems);
}

interface NextStepChipProps {
  suggestion: MainChatNextStepSuggestion;
  isSending: boolean;
  disabled: boolean;
  onPress: (suggestion: MainChatNextStepSuggestion) => void;
}

function renderChipIcon(input: {
  isSending: boolean;
  risky: boolean;
  suggestionId: string;
}): ReactElement {
  if (input.isSending) {
    return <ThemedSpinner size="small" uniProps={primaryIconMapping} />;
  }
  if (input.risky) {
    return (
      <ThemedAlertTriangle
        size={12}
        uniProps={warningIconMapping}
        testID={`main-chat-next-step-risky-icon-${input.suggestionId}`}
      />
    );
  }
  return <ThemedSend size={11} uniProps={primaryIconMapping} />;
}

const NextStepChip = memo(function NextStepChip({
  suggestion,
  isSending,
  disabled,
  onPress,
}: NextStepChipProps): ReactElement {
  const { t } = useTranslation();
  const handlePress = useCallback(() => onPress(suggestion), [onPress, suggestion]);

  return (
    <PressHighlight
      onPress={handlePress}
      disabled={disabled}
      style={[styles.chip, suggestion.risky ? styles.chipRisky : styles.chipSafe]}
      highlightStyle={styles.chipPressed}
      accessibilityRole="button"
      accessibilityLabel={suggestion.label}
      testID={`main-chat-next-step-${suggestion.id}`}
    >
      <View style={styles.chipIcon}>
        {renderChipIcon({ isSending, risky: suggestion.risky, suggestionId: suggestion.id })}
      </View>
      <Text
        style={[styles.chipLabel, suggestion.risky && styles.chipLabelRisky]}
        numberOfLines={1}
        ellipsizeMode="tail"
      >
        {suggestion.label}
      </Text>
      {suggestion.risky ? (
        <Text
          style={styles.riskyBadge}
          numberOfLines={1}
          testID={`main-chat-next-step-risky-badge-${suggestion.id}`}
        >
          {t("mainChat.composer.nextSteps.riskyBadge")}
        </Text>
      ) : null}
    </PressHighlight>
  );
});

export interface MainChatNextStepsBarProps {
  serverId: string;
  agentId: string;
  /** Optional explicit suggestions override (useful for unit tests and custom hosts). */
  suggestions?: readonly MainChatNextStepSuggestion[];
  /** Called for `risky === false` suggestions. Defaults to sending directly to `(serverId, agentId)`. */
  onSendSafePrompt?: (prompt: string, suggestion: MainChatNextStepSuggestion) => Promise<void>;
  /**
   * Called for `risky === true` suggestions. Hard safety invariant: risky items NEVER auto-send;
   * they only prefill the composer input and focus it for explicit user review.
   */
  onPrefillRiskyPrompt?: (prompt: string, suggestion: MainChatNextStepSuggestion) => void;
}

export const MainChatNextStepsBar = memo(function MainChatNextStepsBar({
  serverId,
  agentId,
  suggestions: explicitSuggestions,
  onSendSafePrompt,
  onPrefillRiskyPrompt,
}: MainChatNextStepsBarProps): ReactElement | null {
  const { t } = useTranslation();
  const toast = useToast();
  const sendBehavior = useSettings((settings) => settings.sendBehavior);
  const runtimeClient = useHostRuntimeClient(serverId);
  const sessionClient = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const client = runtimeClient ?? sessionClient;

  const overviewKey = overviewStoreKey(serverId, agentId);
  const overview = useMainChatOverviewStore((state) => state.overviewsByKey[overviewKey]);
  const supportsForgeSearch = useSessionStore(
    (state) => state.sessions[serverId]?.serverInfo?.features?.forgeSearch === true,
  );

  const [sendingId, setSendingId] = useState<string | null>(null);

  const items = useMemo(
    () =>
      resolveMainChatNextStepSuggestions({
        overview,
        explicitSuggestions,
        t,
      }),
    [explicitSuggestions, overview, t],
  );

  const handlePressSuggestion = useCallback(
    (suggestion: MainChatNextStepSuggestion) => {
      // Hard safety boundary: risky suggestions MUST NEVER send directly.
      if (suggestion.risky) {
        if (onPrefillRiskyPrompt) {
          onPrefillRiskyPrompt(suggestion.prompt, suggestion);
        } else {
          const draftKey = buildDraftStoreKey({ serverId, agentId });
          useDraftStore.getState().replaceDraftText({ draftKey, text: suggestion.prompt });
        }
        toast.show(t("mainChat.composer.nextSteps.riskyPrefilledToast"), { variant: "info" });
        return;
      }

      if (sendingId !== null) return;
      if (!onSendSafePrompt && !client) {
        toast.error(t("workspace.terminal.hostDisconnected"));
        return;
      }

      setSendingId(suggestion.id);
      const sendTask = onSendSafePrompt
        ? onSendSafePrompt(suggestion.prompt, suggestion)
        : dispatchMainChatPromptText({
            serverId,
            agentId,
            text: suggestion.prompt,
            client: client!,
            sendBehavior: sendBehavior === "steer" ? "steer" : "interrupt",
            supportsForgeAttachments: supportsForgeSearch,
          });

      void sendTask
        .catch((error) => {
          toast.error(
            error instanceof Error
              ? error.message
              : t("mainChat.composer.nextSteps.sendFailedToast"),
          );
        })
        .finally(() => {
          setSendingId(null);
        });
    },
    [
      agentId,
      client,
      onPrefillRiskyPrompt,
      onSendSafePrompt,
      sendBehavior,
      sendingId,
      serverId,
      supportsForgeSearch,
      t,
      toast,
    ],
  );

  if (items.length === 0) {
    return null;
  }

  return (
    <View style={styles.container} testID="main-chat-next-steps-bar">
      <ThemedSparkles size={12} uniProps={mutedIconMapping} />
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {items.map((suggestion) => (
          <NextStepChip
            key={suggestion.id}
            suggestion={suggestion}
            isSending={sendingId === suggestion.id}
            disabled={!suggestion.risky && sendingId !== null}
            onPress={handlePressSuggestion}
          />
        ))}
      </ScrollView>
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
  scrollContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "nowrap",
    overflow: "hidden",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.full,
    borderWidth: theme.borderWidth[1],
    maxWidth: 240,
  },
  chipIcon: {
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  chipSafe: {
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  chipRisky: {
    borderColor: theme.colors.statusWarning,
    backgroundColor: theme.colors.statusWarningTint,
  },
  chipPressed: {
    backgroundColor: theme.colors.surface2,
  },
  chipLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
  },
  chipLabelRisky: {
    color: theme.colors.statusWarning,
  },
  riskyBadge: {
    fontSize: 10,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.statusWarning,
    flexShrink: 0,
    ...(isWeb ? { whiteSpace: "nowrap" } : null),
  },
}));
