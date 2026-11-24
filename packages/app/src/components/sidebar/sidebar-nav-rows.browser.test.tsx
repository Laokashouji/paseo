import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Text, View } from "react-native";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { i18n as testI18n } from "@/i18n/i18next";
import type { PluginSidebarGroup } from "@/plugins/sidebar-groups";
import type { SidebarNavItem } from "@/sidebar-nav/model";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSidebarNavLayoutStore } from "@/stores/sidebar-nav-layout-store";

const mockPush = vi.fn();
let mockPathname = "/workspace/test";
let mockNavItems: SidebarNavItem<"header">[] = [];

vi.mock("expo-router", () => ({
  router: {
    push: (...args: unknown[]) => mockPush(...args),
  },
  usePathname: () => mockPathname,
  useGlobalSearchParams: () => ({}),
  useLocalSearchParams: () => ({}),
}));

vi.mock("@/sidebar-nav/use-sidebar-nav-items", () => ({
  useSidebarNavItems: () => ({
    items: mockNavItems,
    setVisible: vi.fn(),
    move: vi.fn(),
  }),
}));

let SidebarNavRows: typeof import("./sidebar-nav-rows").SidebarNavRows;
let SidebarNavScroll: typeof import("./sidebar-nav-scroll").SidebarNavScroll;

beforeAll(async () => {
  // Set desktop viewport before importing modules whose StyleSheet.create reads window.innerWidth
  // through the Unistyles browser test stub.
  await page.viewport(1280, 900);
  ({ SidebarNavRows } = await import("./sidebar-nav-rows"));
  ({ SidebarNavScroll } = await import("./sidebar-nav-scroll"));
});

function makeLegacyPluginItem(id: string, title: string, icon: string): SidebarNavItem<"header"> {
  const group: PluginSidebarGroup = {
    kind: "legacy",
    key: `plugin:demo:${id}`,
    pluginId: "demo",
    contributionId: id,
    title,
    icon,
    targets: [
      {
        plugin: {
          serverId: "local",
          id: "demo",
        } as unknown as Extract<
          PluginSidebarGroup,
          { kind: "legacy" }
        >["targets"][number]["plugin"],
        item: {
          id,
          title,
          icon,
        } as unknown as Extract<PluginSidebarGroup, { kind: "legacy" }>["targets"][number]["item"],
      },
    ],
  };
  return {
    kind: "plugin",
    key: group.key,
    group,
    visible: true,
  };
}

function makeTwelveNavItems(): SidebarNavItem<"header">[] {
  return [
    { kind: "builtin", key: "new-workspace", id: "new-workspace", visible: true },
    { kind: "builtin", key: "history", id: "history", visible: true },
    { kind: "builtin", key: "search", id: "search", visible: true },
    { kind: "builtin", key: "schedules", id: "schedules", visible: true },
    makeLegacyPluginItem("feishu", "飞书", "MessageSquare"),
    makeLegacyPluginItem("mew", "Mew", "Inbox"),
    makeLegacyPluginItem("drama", "短剧创作中心", "Film"),
    makeLegacyPluginItem("theme", "皮肤", "Layers"),
    makeLegacyPluginItem("ai-settings", "ai-native 插件设置", "Settings"),
    makeLegacyPluginItem("tasks", "任务", "Folder"),
    makeLegacyPluginItem("ai-cap", "AI 能力", "Blocks"),
    makeLegacyPluginItem("e2e", "E2E 用例", "Activity"),
  ];
}

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function queryTestId(testID: string): HTMLElement | null {
  const node = document.querySelector(`[data-testid="${testID}"]`);
  return node instanceof HTMLElement ? node : null;
}

function requireTestId(testID: string): HTMLElement {
  const node = queryTestId(testID);
  if (!node) throw new Error(`Expected data-testid="${testID}" to be rendered`);
  return node;
}

async function waitForCondition(check: () => void, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      check();
      return;
    } catch (error) {
      lastError = error;
      await wait(25);
    }
  }
  throw lastError;
}

function dispatchPointerDrag(handle: HTMLElement, deltaY: number): void {
  const rect = handle.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const startY = rect.top + rect.height / 2;
  const pointerId = 1;

  act(() => {
    handle.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        cancelable: true,
        button: 0,
        pointerId,
        clientX,
        clientY: startY,
      }),
    );
  });

  const steps = 6;
  for (let i = 1; i <= steps; i += 1) {
    const nextY = startY + (deltaY * i) / steps;
    act(() => {
      window.dispatchEvent(
        new PointerEvent("pointermove", {
          bubbles: true,
          cancelable: true,
          pointerId,
          clientX,
          clientY: nextY,
        }),
      );
    });
  }

  act(() => {
    window.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId,
        clientX,
        clientY: startY + deltaY,
      }),
    );
  });
}

function dispatchDoubleTap(handle: HTMLElement): void {
  const rect = handle.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  for (const pointerId of [2, 3]) {
    act(() => {
      handle.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId,
          clientX,
          clientY,
        }),
      );
      window.dispatchEvent(
        new PointerEvent("pointerup", {
          bubbles: true,
          cancelable: true,
          pointerId,
          clientX,
          clientY,
        }),
      );
    });
  }
}

const TEST_ROOT_STYLE = { flex: 1 } as const;
const TEST_NAV_GROUP_STYLE = { gap: 2, paddingBottom: 6 } as const;
const TEST_WORKSPACES_STYLE = { flex: 1, padding: 12 } as const;
const TEST_WORKSPACES_TEXT_STYLE = { color: "#666666" } as const;

async function mountSidebarNav(items: SidebarNavItem<"header">[]) {
  mockNavItems = items;
  await testI18n.changeLanguage("zh-CN");

  const container = document.createElement("div");
  container.style.width = "280px";
  container.style.height = "840px";
  container.style.display = "flex";
  container.style.flexDirection = "column";
  container.style.backgroundColor = "#f4f4f5";
  container.style.borderRight = "1px solid #e4e4e7";
  document.body.style.margin = "0";
  document.body.style.backgroundColor = "#ffffff";
  document.body.appendChild(container);

  const onBeforeNavigate = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <View style={TEST_ROOT_STYLE}>
          <SidebarNavScroll windowContent>
            <SidebarNavRows style={TEST_NAV_GROUP_STYLE} onBeforeNavigate={onBeforeNavigate} />
          </SidebarNavScroll>
          <View style={TEST_WORKSPACES_STYLE}>
            <Text style={TEST_WORKSPACES_TEXT_STYLE}>已置顶 / Workspaces</Text>
          </View>
        </View>
      </QueryClientProvider>,
    );
  });
  mounted.push({ root, container });
  await wait(80);
  return { container, onBeforeNavigate };
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  mockPush.mockReset();
  mockPathname = "/workspace/test";
  useSidebarNavLayoutStore.setState({ maxHeight: null });
  useKeyboardShortcutsStore.setState({ commandCenterOpen: false });
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  await testI18n.changeLanguage("en");
});

describe("SidebarNavRows overflow menu and resize handle", () => {
  it("caps 12 items by default and opens overflowed items in a secondary menu", async () => {
    const { onBeforeNavigate } = await mountSidebarNav(makeTwelveNavItems());

    await waitForCondition(() => {
      expect(queryTestId("sidebar-global-new-workspace")).not.toBeNull();
      expect(queryTestId("plugin-sidebar-demo-feishu")).not.toBeNull();
      expect(queryTestId("plugin-sidebar-demo-mew")).toBeNull();
      const trigger = requireTestId("sidebar-nav-overflow-trigger");
      expect(trigger.textContent).toContain("更多");
      expect(trigger.parentElement?.textContent).toContain("7");
    });

    const navRect = requireTestId("sidebar-nav-scroll").getBoundingClientRect();
    expect(navRect.height).toBeLessThanOrEqual(220);

    // Click "更多" trigger to open secondary menu on the right.
    const trigger = requireTestId("sidebar-nav-overflow-trigger");
    act(() => {
      trigger.click();
    });

    await waitForCondition(() => {
      const menu = requireTestId("sidebar-nav-overflow-menu");
      expect(menu.textContent).toContain("Mew");
      expect(menu.textContent).toContain("短剧创作中心");
      expect(menu.textContent).toContain("E2E 用例");
      const menuRect = menu.getBoundingClientRect();
      const triggerRect = trigger.getBoundingClientRect();
      expect(menuRect.left).toBeGreaterThanOrEqual(triggerRect.right - 2);
    });

    // Clicking an item inside the secondary menu navigates and closes the menu.
    const mewRow = requireTestId("plugin-sidebar-demo-mew");
    act(() => {
      mewRow.click();
    });

    await waitForCondition(() => {
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(onBeforeNavigate).toHaveBeenCalledTimes(1);
      expect(queryTestId("sidebar-nav-overflow-menu")).toBeNull();
    });
  });

  it("supports dragging the divider down to expand, up to collapse, and double-click to reset", async () => {
    await mountSidebarNav(makeTwelveNavItems());

    const handle = requireTestId("sidebar-nav-resize-handle");
    const rowHeight = Math.ceil(
      requireTestId("sidebar-global-new-workspace").getBoundingClientRect().height,
    );
    const rowPitch = rowHeight + 2;

    // Drag down by 3 rows: reveals Mew, 短剧创作中心, 皮肤 and leaves 4 in More.
    dispatchPointerDrag(handle, rowPitch * 3 + 6);
    await waitForCondition(() => {
      expect(queryTestId("plugin-sidebar-demo-mew")).not.toBeNull();
      expect(queryTestId("plugin-sidebar-demo-drama")).not.toBeNull();
      expect(queryTestId("plugin-sidebar-demo-theme")).not.toBeNull();
      expect(queryTestId("plugin-sidebar-demo-ai-settings")).toBeNull();
      expect(requireTestId("sidebar-nav-overflow-trigger").parentElement?.textContent).toContain(
        "4",
      );
      expect(useSidebarNavLayoutStore.getState().maxHeight).not.toBeNull();
    });

    // Drag all the way down: all 12 items show inline and the More button disappears.
    dispatchPointerDrag(requireTestId("sidebar-nav-resize-handle"), rowPitch * 6);
    await waitForCondition(() => {
      expect(queryTestId("plugin-sidebar-demo-e2e")).not.toBeNull();
      expect(queryTestId("sidebar-nav-overflow-trigger")).toBeNull();
    });

    // Drag all the way up: collapses to 0 inline items + More (12).
    dispatchPointerDrag(requireTestId("sidebar-nav-resize-handle"), -500);
    await waitForCondition(() => {
      expect(queryTestId("sidebar-global-new-workspace")).toBeNull();
      expect(requireTestId("sidebar-nav-overflow-trigger").parentElement?.textContent).toContain(
        "12",
      );
    });

    // Opening More now exposes Search, which closes the overflow menu and opens Command Center.
    act(() => {
      requireTestId("sidebar-nav-overflow-trigger").click();
    });
    await waitForCondition(() => {
      expect(queryTestId("sidebar-search")).not.toBeNull();
    });
    act(() => {
      requireTestId("sidebar-search").click();
    });
    await waitForCondition(() => {
      expect(useKeyboardShortcutsStore.getState().commandCenterOpen).toBe(true);
      expect(queryTestId("sidebar-nav-overflow-menu")).toBeNull();
    });

    // Double-clicking the handle resets height back to default (5 inline + More 7).
    dispatchDoubleTap(requireTestId("sidebar-nav-resize-handle"));
    await waitForCondition(() => {
      expect(useSidebarNavLayoutStore.getState().maxHeight).toBeNull();
      expect(queryTestId("plugin-sidebar-demo-feishu")).not.toBeNull();
      expect(queryTestId("plugin-sidebar-demo-mew")).toBeNull();
      expect(requireTestId("sidebar-nav-overflow-trigger").parentElement?.textContent).toContain(
        "7",
      );
    });
  });

  it("shows no More button when all items fit within the default cap", async () => {
    await mountSidebarNav(makeTwelveNavItems().slice(0, 6));

    await waitForCondition(() => {
      expect(queryTestId("plugin-sidebar-demo-mew")).not.toBeNull();
      expect(queryTestId("sidebar-nav-overflow-trigger")).toBeNull();
    });
  });

  it("shows hover highlight on the resize handle and closes the secondary menu on Escape", async () => {
    await mountSidebarNav(makeTwelveNavItems());

    const handle = requireTestId("sidebar-nav-resize-handle");
    expect(queryTestId("sidebar-nav-resize-handle-highlight")).toBeNull();

    await userEvent.hover(handle);
    await waitForCondition(() => {
      expect(queryTestId("sidebar-nav-resize-handle-highlight")).not.toBeNull();
    });

    await userEvent.unhover(handle);
    await waitForCondition(() => {
      expect(queryTestId("sidebar-nav-resize-handle-highlight")).toBeNull();
    });

    // Open secondary menu and verify menu items carry data-menu-item="true" and Escape dismisses it.
    act(() => {
      requireTestId("sidebar-nav-overflow-trigger").click();
    });
    await waitForCondition(() => {
      const menu = requireTestId("sidebar-nav-overflow-menu");
      expect(menu.querySelectorAll('[data-menu-item="true"]').length).toBe(7);
    });

    await userEvent.keyboard("{Escape}");
    await waitForCondition(() => {
      expect(queryTestId("sidebar-nav-overflow-menu")).toBeNull();
    });
  });
});
