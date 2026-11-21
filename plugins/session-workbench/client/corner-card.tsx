import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginAgentCornerCardProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { WorkbenchCardBody } from "./card-body.js";
import { useWorkbenchCard, useWorkbenchSettingsValues } from "./hooks.js";
import { getWorkflowStatusVisual } from "./status-meta.js";

export function CornerWorkbenchCard({
  agentId,
  workspaceId,
  theme,
  layout,
  navigation,
  onPinToPanel,
  onOpenOverview,
}: PluginAgentCornerCardProps & {
  onPinToPanel(input: { workspaceId: string; agentId: string }): void;
  onOpenOverview(): void;
}) {
  const settings = useWorkbenchSettingsValues();
  const { card } = useWorkbenchCard(agentId, workspaceId);
  const [expanded, setExpanded] = useState(() => !layout.compact && settings.defaultExpanded);
  const [userToggled, setUserToggled] = useState(false);

  useEffect(() => {
    if (!userToggled) {
      setExpanded(!layout.compact && settings.defaultExpanded);
    }
  }, [layout.compact, settings.defaultExpanded, userToggled]);

  const handleToggleExpanded = useCallback(() => {
    setUserToggled(true);
    setExpanded((value) => !value);
  }, []);

  const handleOpenAgent = useCallback(
    (targetAgentId: string) => {
      navigation?.openAgent({ agentId: targetAgentId });
    },
    [navigation],
  );

  const openTodoCount = useMemo(
    () =>
      card.todos.filter(
        (item) => item.status === "open" || item.status === "queued" || item.status === "running",
      ).length,
    [card.todos],
  );

  if (!settings.enabled) return null;

  const statusVisual = getWorkflowStatusVisual(card.workflowStatus);
  const statusColor = statusVisual.color(theme);

  if (!expanded) {
    return (
      <Pressable
        onPress={handleToggleExpanded}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          maxWidth: layout.compact ? 260 : 340,
          paddingHorizontal: 10,
          paddingVertical: 6,
          borderRadius: 999,
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor: card.conditionMetNotice ? theme.colors.statusWarning : theme.colors.border,
          shadowColor: "#000000",
          shadowOpacity: 0.14,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 2 },
          elevation: 4,
        }}
      >
        <View
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            backgroundColor: card.conditionMetNotice ? theme.colors.statusWarning : statusColor,
          }}
        />
        <Text style={{ fontSize: 12, fontWeight: "600", color: theme.colors.foreground }}>
          {statusVisual.shortLabel}
        </Text>
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, fontSize: 12, color: theme.colors.foregroundMuted }}
        >
          {card.currentWork || card.topic || card.agentTitle || "工作台"}
        </Text>
        {openTodoCount > 0 ? (
          <View
            style={{
              paddingHorizontal: 6,
              paddingVertical: 1,
              borderRadius: 999,
              backgroundColor: theme.colors.surface2,
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: "600", color: theme.colors.accent }}>
              {openTodoCount}
            </Text>
          </View>
        ) : null}
        <Icon name="ChevronDown" size={13} color={theme.colors.foregroundMuted} />
      </Pressable>
    );
  }

  return (
    <View
      style={{
        width: layout.compact ? "100%" : 320,
        maxWidth: layout.compact ? 360 : 320,
        borderRadius: 12,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: card.conditionMetNotice ? theme.colors.statusWarning : theme.colors.border,
        padding: 11,
        gap: 10,
        shadowColor: "#000000",
        shadowOpacity: 0.18,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: 4 },
        elevation: 6,
      }}
    >
      {/* Card header */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Icon name="ListTodo" size={14} color={theme.colors.accent} />
          <Text style={{ fontSize: 12, fontWeight: "700", color: theme.colors.foreground }}>
            对话工作台
          </Text>
        </View>

        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Pressable
            onPress={onOpenOverview}
            hitSlop={6}
            accessibilityLabel="打开全局状态总览"
            style={{
              padding: 4,
              borderRadius: 6,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <Icon name="PanelsTopLeft" size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Pressable
            onPress={() => onPinToPanel({ workspaceId, agentId })}
            hitSlop={6}
            accessibilityLabel="固定到侧栏完整视图"
            style={{
              padding: 4,
              borderRadius: 6,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <Icon name="PanelRight" size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
          <Pressable
            onPress={handleToggleExpanded}
            hitSlop={6}
            accessibilityLabel="收起工作台卡片"
            style={{
              padding: 4,
              borderRadius: 6,
              backgroundColor: theme.colors.surface1,
            }}
          >
            <Icon name="Minimize" size={13} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      </View>

      <WorkbenchCardBody
        agentId={agentId}
        workspaceId={workspaceId}
        card={card}
        theme={theme}
        variant="corner"
        onOpenAgent={handleOpenAgent}
      />
    </View>
  );
}
