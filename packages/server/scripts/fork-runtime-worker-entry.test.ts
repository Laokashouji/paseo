import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  resolveForkReleaseDir,
  resolveManagedForkCurrentWorkerEntry,
} from "./fork-runtime-worker-entry.js";

function createFakeForkRelease(
  runtimeBase: string,
  version: string,
): {
  releaseDir: string;
  supervisorPath: string;
  workerPath: string;
} {
  const releaseDir = path.join(runtimeBase, "releases", version);
  const supervisorPath = path.join(
    releaseDir,
    "node_modules",
    "@getpaseo",
    "server",
    "dist",
    "scripts",
    "supervisor-entrypoint.js",
  );
  const workerPath = path.join(
    releaseDir,
    "node_modules",
    "@getpaseo",
    "server",
    "dist",
    "server",
    "server",
    "daemon-worker.js",
  );
  mkdirSync(path.dirname(supervisorPath), { recursive: true });
  mkdirSync(path.dirname(workerPath), { recursive: true });
  writeFileSync(
    path.join(releaseDir, "fork-runtime.json"),
    JSON.stringify({
      schemaVersion: 1,
      repo: "Laokashouji/paseo",
      version,
      tag: `fork-v${version}`,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  writeFileSync(supervisorPath, "// supervisor");
  writeFileSync(workerPath, "// worker");
  return { releaseDir, supervisorPath, workerPath };
}

describe("fork-runtime-worker-entry", () => {
  test("resolves the worker dynamically through current symlink across Fork upgrades", () => {
    const runtimeBase = mkdtempSync(path.join(tmpdir(), "paseo-fork-sup-"));
    onTestFinished(() => rmSync(runtimeBase, { recursive: true, force: true }));

    const oldRelease = createFakeForkRelease(runtimeBase, "0.17.517");
    const newRelease = createFakeForkRelease(runtimeBase, "0.17.518");
    const currentLink = path.join(runtimeBase, "current");

    symlinkSync(path.join("releases", "0.17.517"), currentLink, "dir");

    expect(resolveForkReleaseDir(oldRelease.supervisorPath)).toBe(
      realpathSync(oldRelease.releaseDir),
    );
    expect(resolveManagedForkCurrentWorkerEntry(oldRelease.supervisorPath)).toBe(
      realpathSync(oldRelease.workerPath),
    );

    rmSync(currentLink, { force: true });
    symlinkSync(path.join("releases", "0.17.518"), currentLink, "dir");

    expect(resolveManagedForkCurrentWorkerEntry(oldRelease.supervisorPath)).toBe(
      realpathSync(newRelease.workerPath),
    );
  });

  test("returns null outside a managed Fork release layout", () => {
    const sourceCheckout = mkdtempSync(path.join(tmpdir(), "paseo-source-sup-"));
    onTestFinished(() => rmSync(sourceCheckout, { recursive: true, force: true }));

    const supervisorPath = path.join(
      sourceCheckout,
      "packages",
      "server",
      "dist",
      "scripts",
      "supervisor-entrypoint.js",
    );
    mkdirSync(path.dirname(supervisorPath), { recursive: true });
    writeFileSync(supervisorPath, "// source supervisor");

    expect(resolveForkReleaseDir(supervisorPath)).toBeNull();
    expect(resolveManagedForkCurrentWorkerEntry(supervisorPath)).toBeNull();
  });
});
