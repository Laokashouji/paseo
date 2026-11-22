import type { AgentAddress } from "@getpaseo/protocol/addresses";
import equal from "fast-deep-equal";
import { memo, useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { StatusRing } from "@/components/status-ring";
import { PressHighlight } from "@/components/ui/press-highlight";
import { composerPillStyles } from "@/composer/pill-styles";
import { useSessionStore } from "@/stores/session-store";
import type { SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { STATUS_INDICATOR_FILLED_DOT_SIZE } from "@/utils/status-indicator-geometry";
import { selectMainChatDockTasks, type MainChatDockTaskItem } from "./selectors";

const MAX_INLINE_TASK_PILLS = 4;

export interface MainChatTaskDockProps {
  serverId: string;
  agentId: string;
  onOpenSubagent: (address: AgentAddress) => void;
}

function DockMark({ bucket }: { bucket: SidebarStateBucket }) {
  if (bucket === "running") {
    return (
      <View style={styles.ringWrap}>
        <StatusRing />
      </View>
    );
  }
  switch (bucket) {
    case "needs_input":
      return <View style={styles.dotNeedsInput} />;
    case "failed":
      return <View style={styles.dotFailed} />;
    case "attention":
      return <View style={styles.dotAttention} />;
    case "done":
      return <View style={styles.dotDone} />;
  }
}

const TaskDockPill = memo(function TaskDockPill({
  task,
  onOpenSubagent,
}: {
  task: MainChatDockTaskItem;
  onOpenSubagent: (address: AgentAddress) => void;
}) {
  const { t } = useTranslation();
  const handlePress = useCallback(() => {
    onOpenSubagent({ serverId: task.serverId, agentId: task.agentId });
  }, [onOpenSubagent, task.agentId, task.serverId]);

  const isUrgent = task.bucket === "needs_input";
  const label = isUrgent ? `${task.title} · ${t("mainChat.taskStatus.needsYou")}` : task.title;
  const pillStyle = useMemo(
    () => [composerPillStyles.body, isUrgent && styles.urgentPill],
    [isUrgent],
  );
  const textStyle = useMemo(
    () => [composerPillStyles.label, styles.pillLabel, isUrgent && styles.urgentLabel],
    [isUrgent],
  );

  return (
    <PressHighlight
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={label}
      testID={`main-chat-task-pill-${task.agentId}`}
      style={pillStyle}
      highlightStyle={composerPillStyles.bodyActive}
    >
      <DockMark bucket={task.bucket} />
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
    </PressHighlight>
  );
});

/**
 * Renders per-task pills above the composer on the Main Chat screen, ordered by urgency
 * (`needs_input` -> `failed` -> `running` -> `attention` -> `done`), sitting right beside Paseo's
 * native `SubagentsTrack` ("all N") pill.
 */
export const MainChatTaskDock = memo(function MainChatTaskDock({
  serverId,
  agentId,
  onOpenSubagent,
}: MainChatTaskDockProps): ReactElement | null {
  const tasks = useStoreWithEqualityFn(
    useSessionStore,
    useCallback((state) => selectMainChatDockTasks(state, serverId, agentId), [agentId, serverId]),
    equal,
  );

  if (tasks.length === 0) return null;

  const visibleTasks = tasks.slice(0, MAX_INLINE_TASK_PILLS);
  return (
    <>
      {visibleTasks.map((task) => (
        <TaskDockPill
          key={`${task.serverId}:${task.agentId}`}
          task={task}
          onOpenSubagent={onOpenSubagent}
        />
      ))}
    </>
  );
});

const styles = StyleSheet.create((theme) => {
  const dot = (bucket: Exclude<SidebarStateBucket, "running">) => ({
    width: STATUS_INDICATOR_FILLED_DOT_SIZE,
    height: STATUS_INDICATOR_FILLED_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: getStatusDotColor({ theme, bucket, showDoneAsInactive: false }) ?? undefined,
  });

  return {
    urgentPill: {
      borderColor: theme.colors.statusWarning,
      backgroundColor: theme.colors.statusWarningTint,
    },
    pillLabel: {
      maxWidth: 200,
    },
    urgentLabel: {
      color: theme.colors.statusWarning,
      fontWeight: theme.fontWeight.medium,
    },
    ringWrap: {
      width: 14,
      height: 14,
      alignItems: "center",
      justifyContent: "center",
    },
    dotNeedsInput: dot("needs_input"),
    dotFailed: dot("failed"),
    dotAttention: dot("attention"),
    dotDone: dot("done"),
  };
});
