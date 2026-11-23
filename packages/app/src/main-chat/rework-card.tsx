import { parseTaskReworkToolPayload } from "@getpaseo/protocol/main-chat";
import { ArrowUpRight, RotateCcw } from "lucide-react-native";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import type { Theme } from "@/styles/theme";
import { useOpenMainChatTaskTarget } from "./open-task-target";

const ThemedReworkIcon = withUnistyles(RotateCcw);
const ThemedArrowIcon = withUnistyles(ArrowUpRight);

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface MainChatReworkCardProps {
  serverId: string;
  input: unknown;
  output: unknown;
}

/**
 * Renders the native rework card for Main Chat's `task_rework` MCP tool, displaying which
 * verification gaps were sent back to the child agent and the current rework round.
 */
export const MainChatReworkCard = memo(function MainChatReworkCard({
  serverId,
  input,
  output,
}: MainChatReworkCardProps) {
  const { t } = useTranslation();
  const rework = useMemo(() => parseTaskReworkToolPayload(input, output), [input, output]);

  const openMainChatTaskTarget = useOpenMainChatTaskTarget();

  const handleOpenChild = useCallback(() => {
    if (!rework?.agentId) return;
    openMainChatTaskTarget({ serverId, agentId: rework.agentId, title: rework.title });
  }, [openMainChatTaskTarget, rework?.agentId, rework?.title, serverId]);

  if (!rework) return null;

  return (
    <View style={styles.card} testID={`main-chat-rework-card-${rework.agentId}-${rework.round}`}>
      <View style={styles.headerRow}>
        <ThemedReworkIcon size={14} uniProps={warningIconMapping} />
        <Text style={styles.title} numberOfLines={2}>
          {rework.title}
        </Text>
        <StatusBadge
          variant="warning"
          size="xs"
          label={t("mainChat.reworkCard.roundBadge", {
            round: rework.round,
            maxRounds: rework.maxRounds,
          })}
        />
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
      </View>

      <View style={styles.gapList}>
        {rework.gaps.map((gap) => (
          <Text key={gap} style={styles.gapItem}>
            • {gap}
          </Text>
        ))}
      </View>

      {rework.note ? <Text style={styles.note}>{rework.note}</Text> : null}
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
  gapList: {
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[1],
  },
  gapItem: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  note: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[1.5],
  },
}));
