import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "../support/fixtures";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { clickNewChat } from "../support/helpers/launcher";
import {
  expectComposerVisible,
  openAttachmentMenu,
  removeAttachmentPill,
} from "../support/helpers/composer";

const PLUGIN_ID = "attachment-selection-e2e";
const SEARCH_PLACEHOLDER = "Search fixture issues";
const selectedItem = {
  id: "beta",
  identifier: "ISSUE-2",
  title: "Beta issue",
  subtitle: "Open",
  url: "https://example.com/issues/beta",
  text: "Beta issue details",
  resourceType: "issue",
};

const SHARED_SOURCE = `import {
  defineRpc, PluginAttachmentItemSchema, PluginAttachmentSearchPayloadSchema,
} from "@getpaseo/plugin";
import { z } from "zod";
export const search = defineRpc({
  name: "issues.search", input: z.object({ query: z.string() }),
  output: PluginAttachmentSearchPayloadSchema,
});
export const remember = defineRpc({
  name: "issues.remember", input: PluginAttachmentItemSchema, output: z.object({}),
});
export const state = defineRpc({
  name: "issues.state", input: z.object({}),
  output: z.object({ selected: z.array(PluginAttachmentItemSchema), pending: z.boolean() }),
});
export const release = defineRpc({
  name: "issues.release", input: z.object({}), output: z.object({}),
});`;

const SERVER_SOURCE = `import { search, remember, state, release } from "./shared/issues";
export default function contribute(server) {
  const selected = [];
  let pending = false;
  let unblock;
  const gate = new Promise(resolve => { unblock = resolve; });
  const items = [
    { id: "alpha", identifier: "ISSUE-1", title: "Alpha issue", url: "https://example.com/issues/alpha", text: "Alpha issue details", resourceType: "issue" },
    ${JSON.stringify(selectedItem)},
  ];
  server.handle(search, ({ query }) => ({ items: items
    .filter(item => item.title.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Number(b.id === selected.at(-1)?.id) - Number(a.id === selected.at(-1)?.id))
  }));
  server.handle(remember, async item => {
    pending = true;
    await gate;
    selected.push(item);
    pending = false;
    return {};
  });
  server.handle(state, () => ({ selected, pending }));
  server.handle(release, () => { unblock(); return {}; });
  return () => { unblock(); };
}`;

const CLIENT_SOURCE = `import { search, remember } from "./shared/issues";
export default function contribute(client) {
  const source = {
    icon: "CircleDot", pickerTitle: "Attach fixture issue",
    searchPlaceholder: "${SEARCH_PLACEHOLDER}", search,
  };
  client.addAttachmentSource({ ...source, id: "recent", title: "Recent issues",
    async onSelect(item) {
      await client.rpc(remember, item);
      item.title = "Changed by callback";
    },
  });
  client.addAttachmentSource({ ...source, id: "sync", title: "Sync failure",
    onSelect() { throw new Error("selection sync failure"); },
  });
  client.addAttachmentSource({ ...source, id: "async", title: "Async failure",
    async onSelect() { throw new Error("selection async failure"); },
  });
  client.addAttachmentSource({ ...source, id: "legacy", title: "Legacy issues" });
  return () => {};
}`;

async function openPicker(page: Page, title = "Recent issues") {
  await openAttachmentMenu(page);
  await page.getByRole("menuitem", { name: `Attach ${title}`, exact: true }).click();
  await expect(page.getByPlaceholder(SEARCH_PLACEHOLDER)).toBeVisible();
  await expect(page.getByText("ISSUE-2 Beta issue", { exact: true })).toBeVisible();
}

for (const viewport of [
  { width: 1100, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`attachment selection notifications at ${viewport.width}px`, async ({
    page,
    withWorkspace,
  }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-attachment-selection-"));
    const client = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "attachment-selection",
    });
    const previousConfig = await client.getDaemonConfig();
    const readState = () => client.invokePluginRpc(PLUGIN_ID, "issues.state", {});
    const pill = page.getByTestId("composer-plugin-resource-attachment-pill");
    const warnings: string[] = [];
    const pageErrors: string[] = [];
    page.on("console", (message) => {
      if (
        message.type() === "warning" &&
        message.text().includes("Attachment selection callback failed")
      ) {
        warnings.push(message.text());
      }
    });
    page.on("pageerror", (error) => pageErrors.push(error.message));

    try {
      await writeFile(
        path.join(directory, "paseo-plugin.json"),
        JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
      );
      await mkdir(path.join(directory, "shared"));
      await writeFile(path.join(directory, "shared/issues.ts"), SHARED_SOURCE);
      await writeFile(path.join(directory, "index.server.ts"), SERVER_SOURCE);
      await writeFile(path.join(directory, "index.client.ts"), CLIENT_SOURCE);
      await client.patchDaemonConfig({ pluginsEnabled: true });
      await client.installDirectoryPlugin(directory);
      const workspace = await withWorkspace({ prefix: "attachment-selection-" });
      await workspace.navigateTo();
      await clickNewChat(page);
      await expectComposerVisible(page);
      await page.setViewportSize(viewport);

      await test.step("search and cancellation do not notify", async () => {
        await openPicker(page);
        await page.getByPlaceholder(SEARCH_PLACEHOLDER).fill("Beta");
        await expect(page.getByText("ISSUE-1 Alpha issue", { exact: true })).not.toBeVisible();
        if (viewport.width === 390) {
          await page
            .getByRole("button", { name: "Bottom sheet backdrop", exact: true })
            .last()
            .click({ position: { x: 10, y: 10 } });
        } else {
          await page.keyboard.press("Escape");
        }
        await expect(page.getByPlaceholder(SEARCH_PLACEHOLDER)).not.toBeVisible();
        expect(await readState()).toEqual({ selected: [], pending: false });
        await expect(pill).toHaveCount(0);
      });

      await test.step("attachment completes while notification is pending", async () => {
        await openPicker(page);
        await page.getByText("ISSUE-2 Beta issue", { exact: true }).click();
        await expect(pill).toContainText("Beta issue");
        await expect(page.getByPlaceholder(SEARCH_PLACEHOLDER)).not.toBeVisible();
        await expect.poll(readState).toEqual({ selected: [], pending: true });
        await client.invokePluginRpc(PLUGIN_ID, "issues.release", {});
        await expect.poll(readState).toEqual({ selected: [selectedItem], pending: false });
        await expect(pill).toContainText("Beta issue");
      });

      await test.step("successful notification refreshes ranking; toggling off does not notify", async () => {
        await openPicker(page);
        await expect(page.getByText(/^ISSUE-[12] (Alpha|Beta) issue$/).first()).toHaveText(
          "ISSUE-2 Beta issue",
        );
        await page.getByText("ISSUE-2 Beta issue", { exact: true }).click();
        await expect(pill).toHaveCount(0);
        expect(await readState()).toEqual({ selected: [selectedItem], pending: false });
        await openPicker(page);
        await page.getByText("ISSUE-2 Beta issue", { exact: true }).click();
        await expect
          .poll(readState)
          .toEqual({ selected: [selectedItem, selectedItem], pending: false });
        await removeAttachmentPill(
          page,
          "composer-plugin-resource-attachment-pill",
          "Remove Recent issues ISSUE-2",
        );
        await expect(pill).toHaveCount(0);
        expect(await readState()).toEqual({
          selected: [selectedItem, selectedItem],
          pending: false,
        });
      });

      await test.step("sync failures, async failures, and sources without callbacks still attach", async () => {
        for (const title of ["Sync failure", "Async failure", "Legacy issues"]) {
          await openPicker(page, title);
          await page.getByText("ISSUE-2 Beta issue", { exact: true }).click();
          await expect(pill).toContainText("Beta issue");
          await expect(page.getByPlaceholder(SEARCH_PLACEHOLDER)).not.toBeVisible();
          await removeAttachmentPill(
            page,
            "composer-plugin-resource-attachment-pill",
            `Remove ${title} ISSUE-2`,
          );
        }
        await expect.poll(() => warnings.length).toBe(2);
        expect(pageErrors).toEqual([]);
        expect(await readState()).toEqual({
          selected: [selectedItem, selectedItem],
          pending: false,
        });
      });
    } finally {
      await client.removePlugin(PLUGIN_ID).catch(() => undefined);
      await client
        .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
        .catch(() => undefined);
      await client.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
}
