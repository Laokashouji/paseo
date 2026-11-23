import {
  parseTaskAskUserToolPayload,
  type MainChatDecisionOption,
  type MainChatDecisionRecord,
} from "@getpaseo/protocol/main-chat";
import { ArrowUpRight, CheckCircle2, HelpCircle } from "lucide-react-native";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { useOpenMainChatTaskTarget } from "./open-task-target";
import { decisionStoreKey, useMainChatOverviewStore } from "./overview-store";

const ThemedHelpIcon = withUnistyles(HelpCircle);
const ThemedCheckIcon = withUnistyles(CheckCircle2);
const ThemedArrowIcon = withUnistyles(ArrowUpRight);

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface MainChatDecisionCardProps {
  serverId: string;
  agentId: string;
  output: unknown;
}

const DecisionOptionRow = memo(function DecisionOptionRow({
  option,
  isRecommended,
  disabled,
  onSelect,
}: {
  option: MainChatDecisionOption;
  isRecommended: boolean;
  disabled: boolean;
  onSelect: (option: MainChatDecisionOption) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onSelect(option);
  }, [onSelect, option]);

  const rowStyle = useMemo(
    () => [styles.optionRow, isRecommended && styles.optionRowRecommended],
    [isRecommended],
  );

  return (
    <PressHighlight
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={option.label}
      testID={`main-chat-decision-option-${option.id}`}
      style={rowStyle}
      highlightStyle={styles.optionRowPressed}
    >
      <View style={styles.optionHeader}>
        <Text style={styles.optionLabel}>{option.label}</Text>
        {isRecommended ? (
          <StatusBadge variant="success" size="xs" label={t("mainChat.decisionCard.recommended")} />
        ) : null}
      </View>
      <Text style={styles.optionLeadsTo}>{option.leadsTo}</Text>
    </PressHighlight>
  );
});

/**
 * Renders the native decision card for Main Chat's `task_ask_user` tool. Clicking an option
 * records the answer on the daemon, dispatches it straight to the child agent, and collapses the
 * card to a quiet answered receipt row.
 */
export const MainChatDecisionCard = memo(function MainChatDecisionCard({
  serverId,
  agentId,
  output,
}: MainChatDecisionCardProps) {
  const { t } = useTranslation();
  const parsed = useMemo(() => parseTaskAskUserToolPayload(output), [output]);
  const decisionId = parsed?.id ?? null;

  const storedDecision = useMainChatOverviewStore((state) =>
    decisionId ? (state.decisionsByKey[decisionStoreKey(serverId, decisionId)] ?? null) : null,
  );
  const loadOverview = useMainChatOverviewStore((state) => state.loadOverview);
  const answerDecision = useMainChatOverviewStore((state) => state.answerDecision);
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!client || !decisionId || storedDecision) return;
    void loadOverview(serverId, agentId, client);
  }, [agentId, client, decisionId, loadOverview, serverId, storedDecision]);

  const effective: MainChatDecisionRecord | null = storedDecision ?? parsed;

  const openMainChatTaskTarget = useOpenMainChatTaskTarget();

  const handleOpenChild = useCallback(() => {
    if (!effective?.agentId) return;
    openMainChatTaskTarget({ serverId, agentId: effective.agentId, title: effective.title });
  }, [effective?.agentId, effective?.title, openMainChatTaskTarget, serverId]);

  const handleSelectOption = useCallback(
    (option: MainChatDecisionOption) => {
      if (!effective || !client || submittingId || effective.answeredAt) return;
      setSubmittingId(option.id);
      setSubmitError(null);
      void answerDecision(
        serverId,
        agentId,
        {
          decisionId: effective.id,
          optionId: option.id,
          answer: `${option.label}（${option.leadsTo}）`,
        },
        client,
      )
        .catch((error) => {
          setSubmitError(error instanceof Error ? error.message : String(error));
        })
        .finally(() => {
          setSubmittingId(null);
        });
    },
    [agentId, answerDecision, client, effective, serverId, submittingId],
  );

  if (!effective) return null;

  if (effective.answeredAt && effective.answer) {
    return (
      <View style={styles.compactCard} testID={`main-chat-decision-answered-${effective.id}`}>
        <ThemedCheckIcon size={14} uniProps={successIconMapping} />
        <Text style={styles.compactText} numberOfLines={2}>
          {t("mainChat.decisionCard.answeredSummary", {
            title: effective.title,
            answer: effective.answer,
          })}
        </Text>
        {effective.agentId ? (
          <PressHighlight
            onPress={handleOpenChild}
            style={styles.openLink}
            highlightStyle={styles.openLinkPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.openChildAgent")}
          >
            <Text style={styles.openLinkText}>{t("mainChat.openChildAgent")}</Text>
            <ThemedArrowIcon size={12} uniProps={mutedIconMapping} />
          </PressHighlight>
        ) : null}
      </View>
    );
  }

  return (
    <View style={styles.card} testID={`main-chat-decision-card-${effective.id}`}>
      <View style={styles.headerRow}>
        <ThemedHelpIcon size={14} uniProps={warningIconMapping} />
        <Text style={styles.title} numberOfLines={2}>
          {effective.title}
        </Text>
        <StatusBadge variant="warning" size="xs" label={t("mainChat.decisionCard.needsDecision")} />
        {effective.agentId ? (
          <PressHighlight
            onPress={handleOpenChild}
            style={styles.openLink}
            highlightStyle={styles.openLinkPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.openChildAgent")}
          >
            <Text style={styles.openLinkText}>{t("mainChat.openChildAgent")}</Text>
            <ThemedArrowIcon size={12} uniProps={mutedIconMapping} />
          </PressHighlight>
        ) : null}
      </View>

      <Text style={styles.question}>{effective.question}</Text>
      {effective.reason ? <Text style={styles.reason}>{effective.reason}</Text> : null}

      <View style={styles.optionsList}>
        {effective.options.map((option) => (
          <DecisionOptionRow
            key={option.id}
            option={option}
            isRecommended={effective.recommendedOptionId === option.id}
            disabled={submittingId !== null || !client}
            onSelect={handleSelectOption}
          />
        ))}
      </View>

      {submitError ? <Text style={styles.errorText}>{submitError}</Text> : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    maxWidth: 640,
    width: "100%",
  },
  compactCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    maxWidth: 640,
    width: "100%",
  },
  compactText: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  title: {
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  openLink: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
  },
  openLinkPressed: {
    backgroundColor: theme.colors.surface2,
  },
  openLinkText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  question: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
  reason: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  optionsList: {
    gap: theme.spacing[1.5],
  },
  optionRow: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[0.5],
  },
  optionRowRecommended: {
    borderColor: theme.colors.statusSuccess,
  },
  optionRowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  optionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
  optionLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  optionLeadsTo: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  errorText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.statusDanger,
  },
}));
