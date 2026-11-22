import { parseTaskCompleteToolPayload } from "@getpaseo/protocol/main-chat";
import { ArrowUpRight, CheckCircle2, CircleAlert } from "lucide-react-native";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";
import { navigateToAgent } from "@/utils/navigate-to-agent";

const ThemedCheckIcon = withUnistyles(CheckCircle2);
const ThemedAlertIcon = withUnistyles(CircleAlert);
const ThemedArrowIcon = withUnistyles(ArrowUpRight);

const successIconMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

export interface MainChatReceiptCardProps {
  serverId: string;
  input: unknown;
  output: unknown;
}

export const MainChatReceiptCard = memo(function MainChatReceiptCard({
  serverId,
  input,
  output,
}: MainChatReceiptCardProps) {
  const { t } = useTranslation();
  const receipt = useMemo(() => parseTaskCompleteToolPayload(input, output), [input, output]);

  const handleOpenChild = useCallback(() => {
    if (!receipt?.agentId) return;
    navigateToAgent({ serverId, agentId: receipt.agentId });
  }, [receipt?.agentId, serverId]);

  if (!receipt) return null;

  return (
    <View style={styles.card} testID={`main-chat-receipt-card-${receipt.taskId ?? receipt.title}`}>
      <View style={styles.headerRow}>
        <ThemedCheckIcon size={15} uniProps={successIconMapping} />
        <Text style={styles.title} numberOfLines={2}>
          {receipt.title}
        </Text>
        <StatusBadge variant="success" size="xs" label={t("mainChat.receiptCard.verified")} />
      </View>

      <Text style={styles.summary}>{receipt.summary}</Text>

      {receipt.checks.length > 0 ? (
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
                {check.evidence ? <Text style={styles.checkEvidence}>{check.evidence}</Text> : null}
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

      {receipt.agentId ? (
        <View style={styles.footerRow}>
          <Button
            variant="outline"
            size="sm"
            leftIcon={ThemedArrowIcon}
            onPress={handleOpenChild}
            testID={`main-chat-receipt-open-${receipt.agentId}`}
          >
            {t("mainChat.openChildAgent")}
          </Button>
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
    borderRadius: theme.borderRadius.xl,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    maxWidth: 640,
    width: "100%",
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
  summary: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  checksList: {
    gap: theme.spacing[1.5],
    paddingTop: theme.spacing[1],
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
    gap: 2,
  },
  checkCriterion: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  checkEvidence: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  nextStepsBox: {
    gap: theme.spacing[0.5],
    paddingTop: theme.spacing[1],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  nextStepsLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  nextStepItem: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  footerRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: theme.spacing[1],
  },
}));
