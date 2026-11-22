import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compilePlugin } from "../../../../server/src/server/plugins/compiler";
import { runPluginClientBundle, type PluginClientRuntime } from "../evaluate";
import { isLucideIconName } from "../icons";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");

const runtime = {
  paseo: {},
  async rpc() {},
  openSettings() {},
  openScreen() {},
  openSurface() {},
  openPanel() {},
  addHeaderButton() {
    return { update() {}, remove() {} };
  },
  addComposerPill() {
    return { update() {}, remove() {} };
  },
} as unknown as PluginClientRuntime;

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

    await evaluated.cleanup();
    expect(evaluated.agentCornerCards).toEqual([]);
  });
});
