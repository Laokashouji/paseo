import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { compilePlugin } from "../../../../server/src/server/plugins/compiler";
import { closePluginAgentTab } from "../client-runtime";
import { runPluginClientBundle, type PluginClientRuntime } from "../evaluate";
import { isLucideIconName } from "../icons";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

function createRuntime() {
  const closeAgentTab = vi.fn();
  const subscriptions: Array<{
    name: string;
    onEvent: (event: unknown) => void;
    unsubscribed: boolean;
  }> = [];
  const runtime = {
    paseo: {},
    async rpc() {},
    openSettings() {},
    openScreen() {},
    openSurface() {},
    openPanel() {},
    closeAgentTab,
    subscribe(contract: { name: string }, _input: unknown, onEvent: (event: unknown) => void) {
      const entry = { name: contract.name, onEvent, unsubscribed: false };
      subscriptions.push(entry);
      const stop = () => {
        entry.unsubscribed = true;
      };
      return Object.assign(stop, {
        ready: Promise.resolve(),
        release: async () => {
          entry.unsubscribed = true;
        },
      });
    },
    addHeaderButton() {
      return { update() {}, remove() {} };
    },
    addComposerPill() {
      return { update() {}, remove() {} };
    },
  } as unknown as PluginClientRuntime;
  return { runtime, closeAgentTab, subscriptions };
}

describe("session-workbench builtin client bundle", () => {
  it("uses only valid Lucide icon names", () => {
    const iconNames = [
      "ListTodo",
      "PanelRight",
      "PanelsTopLeft",
      "Minimize",
      "ChevronDown",
      "ChevronRight",
      "Play",
      "CircleDot",
      "History",
      "GitMerge",
      "CircleSlash",
      "CheckCircle2",
      "Sparkles",
      "X",
      "RefreshCw",
      "Pin",
      "PinOff",
      "Pencil",
      "Split",
      "GitBranch",
      "RotateCw",
      "Circle",
      "SquarePen",
      "Trash2",
      "Plus",
      "Zap",
      "Search",
      "ArrowUpRight",
    ];
    const invalid = iconNames.filter((name) => !isLucideIconName(name));
    expect(invalid).toEqual([]);
  });

  it("compiles and evaluates inside Paseo app plugin host with all expected contributions", async () => {
    const pluginDir = path.join(repoRoot, "plugins", "session-workbench");
    const bundles = await compilePlugin({
      server: path.join(pluginDir, "index.server.ts"),
      client: path.join(pluginDir, "index.client.tsx"),
    });
    expect(bundles.clientBundle).toBeTruthy();

    const { runtime, subscriptions } = createRuntime();
    const evaluated = runPluginClientBundle("session-workbench", bundles.clientBundle!, runtime);
    expect(evaluated.surfaces.map((item) => item.id)).toEqual(["overview"]);
    expect(evaluated.sidebarItems.header.map((item) => item.id)).toEqual(["overview"]);
    expect(evaluated.workspaceRowBadgeItems.map((item) => item.id)).toEqual(["status-badge"]);
    expect(evaluated.workspacePanels.map((item) => item.id)).toEqual(["workbench-panel"]);
    expect(evaluated.agentCornerCards.map((item) => item.id)).toEqual(["corner-card"]);
    expect(evaluated.commandCenterItems.map((item) => item.id)).toEqual([
      "open-overview",
      "open-agent-panel",
    ]);
    expect(evaluated.settingsScreens.map((item) => item.id)).toEqual(["settings"]);
    expect(
      subscriptions.some((entry) => entry.name === "workbench.session.archive_completed"),
    ).toBe(false);

    await evaluated.cleanup();
    expect(evaluated.agentCornerCards).toEqual([]);
  });

  it("compiles and evaluates session-archive builtin bundle and closes agent tab on completion", async () => {
    const pluginDir = path.join(repoRoot, "plugins", "session-archive");
    const bundles = await compilePlugin({
      server: path.join(pluginDir, "index.server.ts"),
      client: path.join(pluginDir, "index.client.tsx"),
    });
    expect(bundles.clientBundle).toBeTruthy();

    const { runtime, closeAgentTab, subscriptions } = createRuntime();
    const evaluated = runPluginClientBundle("session-archive", bundles.clientBundle!, runtime);

    const archiveSub = subscriptions.find((entry) => entry.name === "session.archive.completed");
    expect(archiveSub).toBeDefined();
    archiveSub?.onEvent({
      agentId: "agent-1",
      workspaceId: "wks-1",
      archivedAt: "2026-11-22T12:00:00.000Z",
      summary: "清理完成",
    });
    expect(closeAgentTab).toHaveBeenCalledWith({ agentId: "agent-1", workspaceId: "wks-1" });

    await evaluated.cleanup();
    expect(archiveSub?.unsubscribed).toBe(true);
  });

  it("closePluginAgentTab closes the agent tab and its agent panel while preserving sibling tabs", () => {
    const serverId = "srv-close-test";
    const workspaceId = "wks-close-test";
    const workspaceKey = `${serverId}:${workspaceId}`;
    const store = useWorkspaceLayoutStore.getState();

    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-target" },
      intent: "reveal",
      pin: true,
    });
    store.openTab({
      workspaceKey,
      target: {
        kind: "plugin",
        pluginId: "session-workbench",
        panelId: "workbench-panel",
        context: "agent",
        agentId: "agent-target",
      },
      intent: "background",
    });
    store.openTab({
      workspaceKey,
      target: { kind: "agent", agentId: "agent-sibling" },
      intent: "background",
    });

    closePluginAgentTab({ serverId, workspaceId, agentId: "agent-target" });

    const next = useWorkspaceLayoutStore.getState();
    const remainingTabs = collectAllTabs(next.layoutByWorkspace[workspaceKey]!.root);
    expect(
      remainingTabs.some(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === "agent-target",
      ),
    ).toBe(false);
    expect(
      remainingTabs.some(
        (tab) =>
          tab.target.kind === "plugin" &&
          tab.target.context === "agent" &&
          tab.target.agentId === "agent-target",
      ),
    ).toBe(false);
    expect(
      remainingTabs.some(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === "agent-sibling",
      ),
    ).toBe(true);
    expect(next.pinnedAgentIdsByWorkspace[workspaceKey]?.has("agent-target") ?? false).toBe(false);
    expect(next.hiddenAgentIdsByWorkspace[workspaceKey]?.has("agent-target") ?? false).toBe(true);

    // Calling again is a safe no-op.
    expect(() =>
      closePluginAgentTab({ serverId, workspaceId, agentId: "agent-target" }),
    ).not.toThrow();
  });
});
