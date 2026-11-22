import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { PluginAgentCornerCardProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { WorkbenchCardBody } from "./card-body.js";
import { useWorkbenchCard, useWorkbenchSettingsValues } from "./hooks.js";
import { getWorkflowStatusVisual, withAlpha } from "./status-meta.js";

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

  const handlePinToPanel = useCallback(() => {
    onPinToPanel({ workspaceId, agentId });
  }, [agentId, onPinToPanel, workspaceId]);

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
    const headline = card.topic || card.agentTitle || "工作台";
    const subline = card.currentWork || "";
    return (
      <Pressable
        onPress={handleToggleExpanded}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          maxWidth: layout.compact ? 300 : 420,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderRadius: 999,
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor: card.conditionMetNotice
            ? theme.colors.statusWarning
            : statusVisual.tintBorder(theme),
          shadowColor: "#000000",
          shadowOpacity: 0.22,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 3 },
          elevation: 5,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingHorizontal: 7,
            paddingVertical: 2,
            borderRadius: 999,
            backgroundColor: card.conditionMetNotice
              ? withAlpha(theme.colors.statusWarning, 0.16)
              : statusVisual.tintBg(theme),
          }}
        >
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              backgroundColor: card.conditionMetNotice ? theme.colors.statusWarning : statusColor,
            }}
          />
          <Text
            style={{
              fontSize: 11,
              fontWeight: "700",
              color: card.conditionMetNotice ? theme.colors.statusWarning : statusColor,
            }}
          >
            {statusVisual.shortLabel}
          </Text>
        </View>

        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, fontSize: 12, fontWeight: "600", color: theme.colors.foreground }}
        >
          {subline ? `${headline} · ${subline}` : headline}
        </Text>

        {openTodoCount > 0 ? (
          <View
            style={{
              paddingHorizontal: 7,
              paddingVertical: 2,
              borderRadius: 999,
              backgroundColor: withAlpha(theme.colors.accent, 0.16),
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.foreground }}>
              {openTodoCount}
            </Text>
          </View>
        ) : null}

        <Icon name="ChevronDown" size={14} color={theme.colors.foregroundMuted} />
      </Pressable>
    );
  }

  return (
    <View
      style={{
        width: layout.compact ? "100%" : 392,
        maxWidth: layout.compact ? 420 : 392,
        borderRadius: 14,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: card.conditionMetNotice ? theme.colors.statusWarning : theme.colors.border,
        padding: 14,
        shadowColor: "#000000",
        shadowOpacity: 0.28,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 6 },
        elevation: 8,
      }}
    >
      <WorkbenchCardBody
        agentId={agentId}
        workspaceId={workspaceId}
        card={card}
        theme={theme}
        variant="corner"
        onOpenAgent={handleOpenAgent}
        onOpenOverview={onOpenOverview}
        onPinToPanel={handlePinToPanel}
        onCollapse={handleToggleExpanded}
      />
    </View>
  );
}
