import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import type {
  PluginSidebarItemProps,
  PluginWorkspaceRowBadgeItemProps,
} from "@getpaseo/plugin/client";
import { SidebarRow, WorkspaceRowBadge } from "@getpaseo/plugin/client/ui";
import { useWorkbenchOverview, useWorkbenchSettingsValues } from "./hooks.js";

export const OVERVIEW_SCREEN_ID = "overview";

export function WorkbenchSidebarItem({
  theme,
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  const settings = useWorkbenchSettingsValues();
  const { snapshot } = useWorkbenchOverview(false);
  const open = useCallback(() => openScreen({ screenId: OVERVIEW_SCREEN_ID }), [openScreen]);

  if (!settings.enabled) return null;

  const { counts } = snapshot;
  const attentionCount = counts.readyToAdvance + counts.waitingMe;
  const waitingCount = counts.waitingExternal + counts.waitingDependency;

  const badgeText =
    attentionCount > 0
      ? `${attentionCount} 待推进`
      : waitingCount > 0
        ? `${waitingCount} 等待中`
        : counts.openTodos > 0
          ? `${counts.openTodos} 待办`
          : null;

  const badgeColor =
    attentionCount > 0
      ? theme.colors.statusWarning
      : waitingCount > 0
        ? theme.colors.accent
        : theme.colors.foregroundMuted;

  return (
    <SidebarRow
      icon="ListTodo"
      label="对话工作台"
      active={currentScreen?.screenId === OVERVIEW_SCREEN_ID}
      onPress={open}
      trailing={
        badgeText ? (
          <View
            style={{
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: 999,
              backgroundColor: theme.colors.surface2,
              borderWidth: 1,
              borderColor: theme.colors.border,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: "600", color: badgeColor }}>{badgeText}</Text>
          </View>
        ) : null
      }
    />
  );
}

export function WorkbenchWorkspaceRowBadge({ workspaceId }: PluginWorkspaceRowBadgeItemProps) {
  const settings = useWorkbenchSettingsValues();
  const { snapshot } = useWorkbenchOverview(false);

  const summary = useMemo(() => {
    let waiting = 0;
    let ready = 0;
    let openTodos = 0;
    for (const card of snapshot.cards) {
      if (card.archived || card.workspaceId !== workspaceId) continue;
      if (card.conditionMetNotice || card.workflowStatus === "waiting_me") {
        ready += 1;
      } else if (
        card.workflowStatus === "waiting_external" ||
        card.workflowStatus === "waiting_dependency"
      ) {
        waiting += 1;
      }
      for (const todo of card.todos) {
        if (todo.status === "open" || todo.status === "queued") openTodos += 1;
      }
    }
    return { waiting, ready, openTodos };
  }, [snapshot.cards, workspaceId]);

  if (!settings.enabled) return null;

  if (summary.ready > 0) {
    return <WorkspaceRowBadge icon="CircleDot" label={`${summary.ready} 待推进`} tone="warning" />;
  }
  if (summary.waiting > 0) {
    return <WorkspaceRowBadge icon="History" label={`${summary.waiting} 等待中`} tone="info" />;
  }
  if (summary.openTodos > 0) {
    return <WorkspaceRowBadge icon="ListTodo" label={`${summary.openTodos} 待办`} tone="muted" />;
  }
  return null;
}
