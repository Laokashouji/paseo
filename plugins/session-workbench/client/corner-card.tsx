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

  const openBlockerCount = useMemo(
    () => card.blockers.filter((item) => item.status === "open").length,
    [card.blockers],
  );

  if (!settings.enabled) return null;

  const statusVisual = getWorkflowStatusVisual(card.workflowStatus);
  const statusColor = statusVisual.color(theme);

  if (!expanded) {
    const headline = card.topic || card.agentTitle || "工作台";
    return (
      <Pressable
        onPress={handleToggleExpanded}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 9,
          maxWidth: layout.compact ? 320 : 460,
          paddingHorizontal: 13,
          paddingVertical: 8,
          borderRadius: 999,
          backgroundColor: theme.colors.surface0,
          borderWidth: 1,
          borderColor:
            card.conditionMetNotice || openBlockerCount > 0
              ? withAlpha(theme.colors.statusWarning, 0.5)
              : statusVisual.tintBorder(theme),
          shadowColor: "#000000",
          shadowOpacity: 0.28,
          shadowRadius: 16,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 5,
            paddingHorizontal: 8,
            paddingVertical: 2,
            borderRadius: 999,
            backgroundColor: statusVisual.tintBg(theme),
          }}
        >
          <View
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              backgroundColor: statusColor,
            }}
          />
          <Text style={{ fontSize: 11, fontWeight: "700", color: statusColor }}>
            {statusVisual.shortLabel}
          </Text>
        </View>

        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, fontSize: 13, fontWeight: "700", color: theme.colors.foreground }}
        >
          {headline}
        </Text>

        {openBlockerCount > 0 ? (
          <View
            style={{
              paddingHorizontal: 7,
              paddingVertical: 2,
              borderRadius: 999,
              backgroundColor: withAlpha(theme.colors.statusWarning, 0.16),
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: "700", color: theme.colors.statusWarning }}>
              {openBlockerCount} 阻塞
            </Text>
          </View>
        ) : null}

        {openTodoCount > 0 ? (
          <View
            style={{
              paddingHorizontal: 7,
              paddingVertical: 2,
              borderRadius: 999,
              backgroundColor: statusVisual.tintBg(theme),
            }}
          >
            <Text style={{ fontSize: 11, fontWeight: "700", color: statusColor }}>
              {openTodoCount} 待办
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
        width: layout.compact ? "100%" : 428,
        maxWidth: layout.compact ? 428 : 428,
        borderRadius: 16,
        backgroundColor: theme.colors.surface0,
        borderWidth: 1,
        borderColor: card.conditionMetNotice
          ? withAlpha(theme.colors.statusWarning, 0.55)
          : withAlpha(theme.colors.foreground, 0.14),
        overflow: "hidden",
        shadowColor: "#000000",
        shadowOpacity: 0.36,
        shadowRadius: 24,
        shadowOffset: { width: 0, height: 10 },
        elevation: 10,
      }}
    >
      {/* Subtle top status ambient edge */}
      <View
        style={{
          height: 3,
          width: "100%",
          backgroundColor: openBlockerCount > 0 ? theme.colors.statusWarning : statusColor,
          opacity: 0.85,
        }}
      />
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
