import { parseTaskCompleteToolPayload } from "@getpaseo/protocol/main-chat";
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
} from "lucide-react-native";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";
import { useOpenMainChatTaskTarget } from "./open-task-target";

const ThemedCheckIcon = withUnistyles(CheckCircle2);
const ThemedAlertIcon = withUnistyles(CircleAlert);
const ThemedArrowIcon = withUnistyles(ArrowUpRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface MainChatReceiptCardProps {
  serverId: string;
  input: unknown;
  output: unknown;
  /** Defaults to collapsed single-line summary in the Main Chat stream. */
  defaultExpanded?: boolean;
}

/**
 * Compact collapsible completion receipt row. Keeps the Main Chat stream concise by defaulting to
 * a single-line summary while letting the user expand verification checks and next steps on demand.
 */
export const MainChatReceiptCard = memo(function MainChatReceiptCard({
  serverId,
  input,
  output,
  defaultExpanded = false,
}: MainChatReceiptCardProps) {
  const { t } = useTranslation();
  const receipt = useMemo(() => parseTaskCompleteToolPayload(input, output), [input, output]);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const openMainChatTaskTarget = useOpenMainChatTaskTarget();

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleOpenChild = useCallback(() => {
    if (!receipt?.agentId) return;
    openMainChatTaskTarget({
      serverId,
      agentId: receipt.agentId,
      title: receipt.title,
      taskId: receipt.taskId ?? null,
    });
  }, [openMainChatTaskTarget, receipt?.agentId, receipt?.taskId, receipt?.title, serverId]);

  if (!receipt) return null;

  const hasDetails = receipt.checks.length > 0 || receipt.nextSteps.length > 0;

  return (
    <View style={styles.card} testID={`main-chat-receipt-card-${receipt.taskId ?? receipt.title}`}>
      <View style={styles.compactRow}>
        <PressHighlight
          onPress={handleToggle}
          style={styles.summaryToggle}
          highlightStyle={styles.rowPressed}
          accessibilityRole="button"
          accessibilityLabel={receipt.title}
          testID={`main-chat-receipt-toggle-${receipt.taskId ?? receipt.title}`}
        >
          {expanded ? (
            <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
          ) : (
            <ThemedChevronRight size={13} uniProps={mutedIconMapping} />
          )}
          <ThemedCheckIcon size={14} uniProps={successIconMapping} />
          <Text style={styles.summaryLine} numberOfLines={1}>
            {receipt.title}
            {receipt.summary ? ` · ${receipt.summary}` : ""}
          </Text>
          <StatusBadge variant="success" size="xs" label={t("mainChat.receiptCard.verified")} />
        </PressHighlight>

        {receipt.agentId ? (
          <PressHighlight
            onPress={handleOpenChild}
            style={styles.openLink}
            highlightStyle={styles.rowPressed}
            accessibilityRole="button"
            accessibilityLabel={t("mainChat.openChildAgent")}
            testID={`main-chat-receipt-open-${receipt.agentId}`}
          >
            <ThemedArrowIcon size={13} uniProps={mutedIconMapping} />
          </PressHighlight>
        ) : null}
      </View>

      {expanded ? (
        <View style={styles.detailsBody}>
          <Text style={styles.summary}>{receipt.summary}</Text>

          {hasDetails && receipt.checks.length > 0 ? (
            <View style={styles.checksList}>
              {receipt.checks.map((check) => (
                <View key={`${check.criterion}:${check.evidence}`} style={styles.checkRow}>
                  {check.met ? (
                    <ThemedCheckIcon size={13} uniProps={successIconMapping} />
                  ) : (
                    <ThemedAlertIcon size={13} uniProps={dangerIconMapping} />
                  )}
                  <View style={styles.checkTextCol}>
                    <Text style={styles.checkCriterion}>{check.criterion}</Text>
                    {check.evidence ? (
                      <Text style={styles.checkEvidence}>{check.evidence}</Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {receipt.nextSteps.length > 0 ? (
            <View style={styles.nextStepsBox}>
              <Text style={styles.nextStepsLabel}>{t("mainChat.receiptCard.nextSteps")}</Text>
              {receipt.nextSteps.map((step) => (
                <Text key={step} style={styles.nextStepItem}>
                  • {step}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create((theme) => ({
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    borderRadius: theme.borderRadius.lg,
    width: "100%",
    overflow: "hidden",
  },
  compactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  summaryToggle: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[0.5],
    borderRadius: theme.borderRadius.md,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  summaryLine: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  openLink: {
    width: 26,
    height: 26,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  detailsBody: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    gap: theme.spacing[2],
    backgroundColor: theme.colors.surface0,
  },
  summary: {
    fontSize: theme.fontSize.base,
    lineHeight: 21,
    color: theme.colors.foreground,
  },
  checksList: {
    gap: theme.spacing[2],
    paddingTop: theme.spacing[1.5],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  checkTextCol: {
    flex: 1,
    minWidth: 0,
    gap: theme.spacing[0.5],
  },
  checkCriterion: {
    fontSize: theme.fontSize.base,
    lineHeight: 20,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  checkEvidence: {
    fontSize: 13,
    lineHeight: 19,
    color: theme.colors.foregroundMuted,
  },
  nextStepsBox: {
    gap: theme.spacing[1],
    paddingTop: theme.spacing[1.5],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  nextStepsLabel: {
    fontSize: 13,
    lineHeight: 19,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  nextStepItem: {
    fontSize: 13,
    lineHeight: 20,
    color: theme.colors.foregroundMuted,
  },
}));
