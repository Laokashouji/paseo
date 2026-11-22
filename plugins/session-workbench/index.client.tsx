import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AGENT_PANEL_ID, WorkbenchAgentPanel } from "./client/agent-panel.js";
import { CornerWorkbenchCard } from "./client/corner-card.js";
import { WorkbenchOverviewScreen } from "./client/overview-screen.js";
import { WorkbenchSettingsScreen } from "./client/settings-screen.js";
import {
  OVERVIEW_SCREEN_ID,
  WorkbenchSidebarItem,
  WorkbenchWorkspaceRowBadge,
} from "./client/sidebar-entry.js";

const SETTINGS_SCREEN_ID = "settings";

export default function contribute(client: PluginClientContext) {
  const cleanups: Array<() => void | Promise<void>> = [];

  cleanups.push(
    client.addScreen({
      id: OVERVIEW_SCREEN_ID,
      title: "对话工作台",
      Component: WorkbenchOverviewScreen,
    }),
  );

  cleanups.push(
    client.addSidebarHeaderItem({
      id: "overview",
      title: "对话工作台",
      Component: WorkbenchSidebarItem,
    }),
  );

  cleanups.push(
    client.addWorkspaceRowBadgeItem({
      id: "status-badge",
      title: "对话工作台状态",
      icon: "ListTodo",
      Component: WorkbenchWorkspaceRowBadge,
    }),
  );

  cleanups.push(
    client.addAgentPanel({
      id: AGENT_PANEL_ID,
      title: "工作台",
      icon: "ListTodo",
      locations: ["explorer", "workspace"],
      Component: WorkbenchAgentPanel,
    }),
  );

  if (typeof client.addAgentCornerCard === "function") {
    cleanups.push(
      client.addAgentCornerCard({
        id: "corner-card",
        Component: (props) => (
          <CornerWorkbenchCard
            {...props}
            onPinToPanel={({ workspaceId, agentId }) => {
              client.openPanel(AGENT_PANEL_ID, {
                workspaceId,
                agentId,
                location: "explorer",
              });
            }}
            onOpenOverview={() => {
              client.openScreen({ screenId: OVERVIEW_SCREEN_ID });
            }}
          />
        ),
      }),
    );
  }

  cleanups.push(
    client.addCommandCenterItem({
      id: "open-overview",
      title: "打开对话工作台总览",
      icon: "ListTodo",
      keywords: ["workbench", "todo", "waiting", "status", "工作台", "待办", "等待"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: OVERVIEW_SCREEN_ID });
      },
    }),
  );

  cleanups.push(
    client.addCommandCenterItem({
      id: "open-agent-panel",
      title: "在侧栏固定当前对话工作台",
      icon: "PanelRight",
      keywords: ["workbench", "todo", "panel", "工作台", "待办"],
      context: "agent",
      onSelect({ openPanel }) {
        openPanel(AGENT_PANEL_ID, { location: "explorer" });
      },
    }),
  );

  cleanups.push(
    client.addSettingsScreen({
      id: SETTINGS_SCREEN_ID,
      title: "对话工作台",
      icon: "ListTodo",
      Component: WorkbenchSettingsScreen,
    }),
  );

  return () => {
    for (const cleanup of cleanups) {
      void cleanup();
    }
  };
}
