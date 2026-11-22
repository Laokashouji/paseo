import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { DaemonClient } from "../../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../../test-utils/paseo-daemon.js";
import { compilePlugin } from "../compiler.js";
import { BuiltinPluginLoader, resolveBuiltinPluginsRoot } from "./index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function copyIsolatedWorkbenchPlugin(): Promise<{
  builtinRoot: string;
  pluginDir: string;
}> {
  const sourceDir = path.join(resolveBuiltinPluginsRoot(), "session-workbench");
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-packaged-workbench-"));
  tempRoots.push(isolatedRoot);
  const builtinRoot = path.join(isolatedRoot, "builtin-plugins");
  const pluginDir = path.join(builtinRoot, "session-workbench");

  await cp(sourceDir, pluginDir, {
    recursive: true,
    filter: (source) =>
      !source.split(path.sep).some((segment) => segment === "node_modules" || segment === "test") &&
      !/\.(test|spec)\.[cm]?[jt]sx?$/.test(source) &&
      !source.endsWith(".tsbuildinfo"),
  });

  return { builtinRoot, pluginDir };
}

test("session-workbench compiles outside the monorepo without ancestor node_modules (packaged desktop layout)", async () => {
  const { pluginDir } = await copyIsolatedWorkbenchPlugin();

  const bundles = await compilePlugin({
    server: path.join(pluginDir, "index.server.ts"),
    client: path.join(pluginDir, "index.client.tsx"),
  });

  expect(bundles.serverBundle).toBeTruthy();
  expect(bundles.clientBundle).toBeTruthy();
});

test("session-workbench starts and publishes its client bundle when loaded from an isolated builtin-plugins directory", async () => {
  const { builtinRoot } = await copyIsolatedWorkbenchPlugin();
  const daemon = await createTestPaseoDaemon({
    daemonVersion: "0.17.504",
    pluginsEnabled: false,
    builtinPlugins: new BuiltinPluginLoader(builtinRoot, ["session-workbench"]),
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.17.504",
  });
  try {
    await client.connect();
    const catalog = await client.getPluginCatalog();
    const workbench = catalog.find((entry) => entry.id === "session-workbench");
    expect(workbench?.clientBundle).toBeTruthy();
  } finally {
    await client.close();
    await daemon.close();
  }
}, 60_000);
