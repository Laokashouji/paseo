import { useCallback } from "react";
import { ScrollView, View } from "react-native";
import type { PluginAgentPanelProps } from "@getpaseo/plugin/client";
import { WorkbenchCardBody } from "./card-body.js";
import { useWorkbenchCard } from "./hooks.js";

export const AGENT_PANEL_ID = "workbench-panel";

export function WorkbenchAgentPanel({
  workspaceId,
  params,
  theme,
  navigation,
}: PluginAgentPanelProps) {
  const { card } = useWorkbenchCard(params.agentId, workspaceId);

  const handleOpenAgent = useCallback(
    (targetAgentId: string) => {
      navigation?.openAgent({ agentId: targetAgentId });
    },
    [navigation],
  );

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.colors.surface0 }}
      contentContainerStyle={{ padding: 14 }}
    >
      <View style={{ maxWidth: 640, width: "100%", alignSelf: "center" }}>
        <WorkbenchCardBody
          agentId={params.agentId}
          workspaceId={workspaceId}
          card={card}
          theme={theme}
          variant="panel"
          onOpenAgent={handleOpenAgent}
        />
      </View>
    </ScrollView>
  );
}
