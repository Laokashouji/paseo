import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { PluginAgentCornerCardProps, PluginHostProps } from "@getpaseo/plugin/client";
import { useStreamTopOverlayInset } from "@/agent-stream/top-overlay";
import { usePluginHostNavigation } from "../host-navigation";
import { pluginThemeMapping, renderNothing, usePluginItemHost } from "../item-host";
import { PluginEnvironmentProvider } from "../popover";
import { useInstalledPlugins } from "../registry";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import type { InstalledPlugin, PluginAgentCornerCardContribution } from "../types";

interface AgentCornerCardTarget {
  plugin: InstalledPlugin;
  card: PluginAgentCornerCardContribution;
}

function useServerAgentCornerCards(serverId: string | null): AgentCornerCardTarget[] {
  const installed = useInstalledPlugins();
  return useMemo(
    () =>
      serverId === null
        ? []
        : installed
            .filter((plugin) => plugin.serverId === serverId && plugin.agentCornerCards.length > 0)
            .flatMap((plugin) => plugin.agentCornerCards.map((card) => ({ plugin, card }))),
    [installed, serverId],
  );
}

/**
 * Floating corner cards registered by plugins for an agent conversation view.
 * Positioned at the top-right of the chat column with pointerEvents="box-none" so surrounding
 * whitespace never blocks transcript scrolling or text selection.
 */
export function PluginAgentCornerCards({
  serverId,
  workspaceId,
  agentId,
}: {
  serverId: string | null;
  workspaceId: string | null | undefined;
  agentId: string | null | undefined;
}) {
  const targets = useServerAgentCornerCards(serverId);
  const topOverlayInset = useStreamTopOverlayInset();
  const overlayStyle = useMemo(
    () => [styles.overlay, topOverlayInset > 0 ? { top: topOverlayInset + 8 } : null],
    [topOverlayInset],
  );

  if (!serverId || !workspaceId || !agentId || targets.length === 0) return null;

  return (
    <View style={overlayStyle} pointerEvents="box-none" testID="plugin-agent-corner-cards">
      {targets.map(({ plugin, card }) => (
        <ThemedAgentCornerCardHost
          key={`${plugin.id}:${card.id}`}
          plugin={plugin}
          card={card}
          workspaceId={workspaceId}
          agentId={agentId}
          uniProps={pluginThemeMapping}
        />
      ))}
    </View>
  );
}

function AgentCornerCardHost({
  plugin,
  card,
  workspaceId,
  agentId,
  theme,
}: {
  plugin: InstalledPlugin;
  card: PluginAgentCornerCardContribution;
  workspaceId: string;
  agentId: string;
  theme: PluginHostProps["theme"];
}) {
  const { environment, props: hostProps } = usePluginItemHost(plugin, theme);
  const navigation = usePluginHostNavigation(plugin.serverId);
  const props = useMemo<PluginAgentCornerCardProps>(
    () => ({
      ...hostProps,
      navigation,
      workspaceId,
      agentId,
    }),
    [agentId, hostProps, navigation, workspaceId],
  );
  const Card = card.Component;
  return (
    <SurfaceErrorBoundary installation={plugin} Surface={Card} renderError={renderNothing}>
      <PluginEnvironmentProvider environment={environment}>
        <Card {...props} />
      </PluginEnvironmentProvider>
    </SurfaceErrorBoundary>
  );
}

const ThemedAgentCornerCardHost = withUnistyles(AgentCornerCardHost);

const styles = StyleSheet.create((theme) => ({
  overlay: {
    position: "absolute",
    top: theme.spacing[2],
    right: theme.spacing[3],
    left: theme.spacing[3],
    alignItems: "flex-end",
    gap: theme.spacing[2],
    zIndex: 12,
  },
}));
