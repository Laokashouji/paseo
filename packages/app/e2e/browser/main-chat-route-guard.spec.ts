import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect } from "@playwright/test";
import {
  buildHostAgentDetailRoute,
  buildHostWorkspaceRoute,
  buildMainChatHistoryRoute,
  buildSessionsRoute,
} from "@/utils/host-routes";
import { metroTest as test } from "../support/fixtures";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { buildCreateAgentPreferences, buildSeededHost } from "../support/helpers/daemon-registry";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { seedWorkspace } from "../support/helpers/seed-client";

const SCREENSHOT_DIR =
  process.env.MAIN_CHAT_ROUTE_GUARD_SCREENSHOT_DIR || "/tmp/main-chat-route-guard-screenshots";

type MainChatE2EClient = Pick<
  DaemonClient,
  | "connect"
  | "close"
  | "updateMainChatSettings"
  | "ensureMainChat"
  | "setWorkspaceTitle"
  | "updateAgent"
  | "fetchWorkspaces"
  | "fetchAgents"
>;

test.describe("Main Chat route guard, Sessions filtering, and title sync", () => {
  test("redirects regular workspace/agent routes to /main, filters Sessions, and syncs drifted legacy titles", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await mkdir(SCREENSHOT_DIR, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    const serverId = `srv_mc_guard_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const regularTitle = `常规开发会话-${randomUUID().slice(0, 6)}`;
    const daemon = await startIsolatedHostDaemon(serverId, {
      environment: {
        NODE_ENV: "development",
        PASEO_PASSWORD: "",
      },
    });
    let regularWorkspace: Awaited<ReturnType<typeof seedWorkspace>> | null = null;
    let client: MainChatE2EClient | null = null;

    try {
      client = await connectDaemonClient<MainChatE2EClient>({
        port: daemon.port,
        clientIdPrefix: "seed-main-chat-guard",
      });

      const settingsResult = await client.updateMainChatSettings({
        enabled: true,
        title: "对话管理",
      });
      expect(settingsResult.error).toBeNull();
      expect(settingsResult.settings?.title).toBe("对话管理");

      const ensured = await client.ensureMainChat({
        provider: "mock",
        model: "e2e-fast-stream",
        modeId: "load-test",
      });
      expect(ensured.error).toBeNull();
      const mainAgentId = ensured.agentId;
      const mainWorkspaceId = ensured.workspaceId;
      expect(mainAgentId).toBeTruthy();
      expect(mainWorkspaceId).toBeTruthy();
      if (!mainAgentId || !mainWorkspaceId) {
        throw new Error("ensureMainChat returned empty agentId or workspaceId");
      }

      // Drift underlying main-chat workspace & agent titles to legacy "主对话", then restart
      // the isolated daemon to verify startup auto-sync restores both to settings.title ("对话管理").
      await client.setWorkspaceTitle(mainWorkspaceId, "主对话");
      await client.updateAgent(mainAgentId, { name: "主对话" });
      await client.close();
      client = null;

      await daemon.restart();

      client = await connectDaemonClient<MainChatE2EClient>({
        port: daemon.port,
        clientIdPrefix: "verify-main-chat-guard",
      });
      const workspacesAfterRestart = await client.fetchWorkspaces();
      const syncedMainWs = workspacesAfterRestart.entries.find((ws) => ws.id === mainWorkspaceId);
      expect(syncedMainWs?.name).toBe("对话管理");

      const agentsAfterRestart = await client.fetchAgents({ scope: "active" });
      const syncedMainAgent = agentsAfterRestart.entries.find(
        (entry) => entry.agent.id === mainAgentId,
      );
      expect(syncedMainAgent?.agent.title).toBe("对话管理");

      // Seed a regular workspace and regular session on the same isolated daemon.
      regularWorkspace = await seedWorkspace({
        repoPrefix: "mc-guard-regular-",
        port: daemon.port,
      });
      await createMockIdleAgent(regularWorkspace.client, {
        cwd: regularWorkspace.workspaceDirectory,
        workspaceId: regularWorkspace.workspaceId,
        title: regularTitle,
      });

      const host = buildSeededHost({
        serverId,
        label: "Isolated DevBox",
        endpoint: `127.0.0.1:${daemon.port}`,
        nowIso: new Date().toISOString(),
      });

      // Block 6767 so the browser test never touches the developer daemon.
      await page.route(/:6767\b/, (route) => route.abort());
      await page.routeWebSocket(/:6767\b/, async (webSocket) => {
        await webSocket.close({ code: 1008, reason: "Blocked developer daemon during e2e." });
      });
      await page.addInitScript(
        ({ seededHost, preferences }) => {
          localStorage.setItem("@paseo:e2e", "1");
          localStorage.setItem("@paseo:daemon-registry", JSON.stringify([seededHost]));
          localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
          localStorage.setItem("@paseo:language", "zh-CN");
        },
        { seededHost: host, preferences: buildCreateAgentPreferences() },
      );

      // 1. Visiting the dedicated main-chat workspace via regular workspace route must redirect to /main.
      const workspaceRoute = buildHostWorkspaceRoute(serverId, mainWorkspaceId);
      await page.goto(workspaceRoute);
      await expect(page).toHaveURL(/\/main(\?|$)/, { timeout: 30_000 });
      await expect(page.getByTestId("main-chat-shell")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("main-chat-shell-title")).toContainText("对话管理", {
        timeout: 30_000,
      });
      await expect(page.getByTestId("workspace-new-tab-button")).toHaveCount(0);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "01-workspace-route-redirect-to-main.png"),
        fullPage: true,
      });

      // 2. Visiting the main-chat agent via regular host agent route must also redirect to /main.
      const agentRoute = buildHostAgentDetailRoute(serverId, mainAgentId);
      await page.goto(agentRoute);
      await expect(page).toHaveURL(/\/main(\?|$)/, { timeout: 30_000 });
      await expect(page.getByTestId("main-chat-shell")).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId("main-chat-shell-title")).toContainText("对话管理", {
        timeout: 30_000,
      });
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "02-agent-route-redirect-to-main.png"),
        fullPage: true,
      });

      // 3. Regular Sessions (/sessions) lists the regular session and does NOT leak main-chat agents.
      await page.goto(buildSessionsRoute());
      await expect(page.getByText(regularTitle)).toBeVisible({ timeout: 30_000 });
      const sessionsContent = await page.locator("body").innerText();
      // Main chat agent must not appear as a session row in the Sessions list
      const mainSessionButton = page.getByRole("button").filter({ hasText: /^(对话管理|主对话)$/ });
      await expect(mainSessionButton).toHaveCount(0);
      expect(sessionsContent).toContain(regularTitle);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "03-sessions-no-main-chat.png"),
        fullPage: true,
      });

      // 4. Main Chat history (/main/history) owns the main-chat record and displays settings.title ("对话管理").
      await page.goto(buildMainChatHistoryRoute(serverId));
      await expect(page.getByTestId("main-chat-history-screen")).toBeVisible({ timeout: 30_000 });
      const mainHistoryCard = page.getByTestId(`main-chat-history-conv-${mainAgentId}`);
      await expect(mainHistoryCard).toBeVisible({ timeout: 30_000 });
      await expect(mainHistoryCard).toContainText("对话管理");
      await expect(mainHistoryCard).not.toContainText("主对话");
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, "04-main-chat-history-title.png"),
        fullPage: true,
      });
    } finally {
      if (client) {
        await client.close().catch(() => undefined);
      }
      await regularWorkspace?.cleanup();
      await daemon.close();
    }
  });
});
