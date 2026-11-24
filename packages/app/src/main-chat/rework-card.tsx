import { parseTaskReworkToolPayload } from "@getpaseo/protocol/main-chat";
import { ArrowUpRight, ChevronDown, ChevronRight, RotateCcw } from "lucide-react-native";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { PressHighlight } from "@/components/ui/press-highlight";
import { StatusBadge } from "@/components/ui/status-badge";
import { useSessionStore } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { useOpenMainChatTaskTarget } from "./open-task-target";

const ThemedReworkIcon = withUnistyles(RotateCcw);
const ThemedArrowIcon = withUnistyles(ArrowUpRight);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedChevronRight = withUnistyles(ChevronRight);

const warningIconMapping = (theme: Theme) => ({ color: theme.colors.statusWarning });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export interface MainChatReworkCardProps {
  serverId: string;
  input: unknown;
  output: unknown;
  defaultExpanded?: boolean;
}

/**
 * Compact collapsible rework row for Main Chat's `task_rework` / `task_review(rework)` tool.
 * Defaults to a single line in the stream and automatically neutralizes its accent once the
 * child agent has finished or been archived.
 */
export const MainChatReworkCard = memo(function MainChatReworkCard({
  serverId,
  input,
  output,
  defaultExpanded = false,
}: MainChatReworkCardProps) {
  const { t } = useTranslation();
  const rework = useMemo(() => parseTaskReworkToolPayload(input, output), [input, output]);
  const [expanded, setExpanded] = useState(defaultExpanded);

  const isResolved = useSessionStore((state) => {
    if (!rework?.agentId) return false;
    const session = state.sessions[serverId];
    const agent = session?.agents.get(rework.agentId) ?? session?.agentDetails.get(rework.agentId);
    if (!agent) return false;
    return Boolean(agent.archivedAt) || (agent.status === "idle" && agent.turn.phase === "idle");
  });

  const openMainChatTaskTarget = useOpenMainChatTaskTarget();

  const handleToggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const handleOpenChild = useCallback(() => {
    if (!rework?.agentId) return;
    openMainChatTaskTarget({
      serverId,
      agentId: rework.agentId,
      title: rework.title,
      taskId: rework.taskId ?? null,
    });
  }, [openMainChatTaskTarget, rework?.agentId, rework?.taskId, rework?.title, serverId]);

  if (!rework) return null;

  return (
    <View style={styles.card} testID={`main-chat-rework-card-${rework.agentId}-${rework.round}`}>
      <View style={styles.compactRow}>
        <PressHighlight
          onPress={handleToggle}
          style={styles.summaryToggle}
          highlightStyle={styles.openLinkPressed}
          accessibilityRole="button"
          accessibilityLabel={rework.title}
          testID={`main-chat-rework-toggle-${rework.agentId}-${rework.round}`}
        >
          {expanded ? (
            <ThemedChevronDown size={13} uniProps={mutedIconMapping} />
          ) : (
            <ThemedChevronRight size={13} uniProps={mutedIconMapping} />
          )}
          <ThemedReworkIcon
            size={13}
            uniProps={isResolved ? mutedIconMapping : warningIconMapping}
          />
          <Text style={[styles.title, isResolved && styles.titleMuted]} numberOfLines={1}>
            {rework.title}
          </Text>
          <StatusBadge
            variant={isResolved ? "muted" : "warning"}
            size="xs"
            label={t("mainChat.reworkCard.roundBadge", {
              round: rework.round,
              maxRounds: rework.maxRounds,
            })}
          />
        </PressHighlight>

        <PressHighlight
          onPress={handleOpenChild}
          style={styles.openLink}
          highlightStyle={styles.openLinkPressed}
          accessibilityRole="button"
          accessibilityLabel={t("mainChat.openChildAgent")}
        >
          <ThemedArrowIcon size={13} uniProps={mutedIconMapping} />
        </PressHighlight>
      </View>

      {expanded ? (
        <View style={styles.detailsBody}>
          <View style={styles.gapList}>
            {rework.gaps.map((gap) => (
              <Text key={gap} style={styles.gapItem}>
                • {gap}
              </Text>
            ))}
          </View>
          {rework.note ? <Text style={styles.note}>{rework.note}</Text> : null}
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
    maxWidth: 640,
    width: "100%",
    overflow: "hidden",
  },
  compactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
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
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    flex: 1,
    minWidth: 0,
  },
  titleMuted: {
    color: theme.colors.foregroundMuted,
  },
  openLink: {
    width: 26,
    height: 26,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  openLinkPressed: {
    backgroundColor: theme.colors.surface2,
  },
  detailsBody: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1.5],
    backgroundColor: theme.colors.surface0,
  },
  gapList: {
    gap: theme.spacing[1],
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
