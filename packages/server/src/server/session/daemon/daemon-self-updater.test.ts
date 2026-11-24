import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  DaemonSelfUpdateInProgressError,
  DaemonSelfUpdater,
  type DaemonSelfUpdatePhase,
  type DaemonSelfUpdateRuntime,
} from "./daemon-self-updater.js";
import {
  DefaultForkReleaseUpdater,
  FORK_RUNTIME_METADATA_FILENAME,
  FORK_SUPERVISOR_RELEASE_DIR_ENV,
  FORK_UPDATE_MANIFEST_URL_ENV,
  type ForkDaemonManifest,
  type ForkReleaseUpdater,
  type ManagedForkRuntime,
} from "./fork-release-updater.js";

interface TestLogger {
  errors: Array<{ obj: object; msg?: string }>;
  warnings: Array<{ obj: object; msg?: string }>;
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

function createLogger(): TestLogger {
  return {
    errors: [],
    warnings: [],
    error(obj, msg) {
      this.errors.push({ obj, msg });
    },
    warn(obj, msg) {
      this.warnings.push({ obj, msg });
    },
  };
}

function createReleaseTree(
  releaseDir: string,
  version: string,
  options: {
    repo?: string;
    serverPackageVersion?: string;
    omitWorker?: boolean;
  } = {},
): { serverPackageRoot: string } {
  const serverPackageRoot = path.join(releaseDir, "node_modules", "@getpaseo", "server");
  const workerEntry = path.join(serverPackageRoot, "dist", "server", "server", "daemon-worker.js");
  const cliEntry = path.join(releaseDir, "bin", "paseo");

  mkdirSync(path.dirname(workerEntry), { recursive: true });
  mkdirSync(path.dirname(cliEntry), { recursive: true });

  writeFileSync(
    path.join(releaseDir, FORK_RUNTIME_METADATA_FILENAME),
    JSON.stringify({
      schemaVersion: 1,
      repo: options.repo ?? "Laokashouji/paseo",
      version,
      tag: `fork-v${version}`,
      platform: process.platform,
      arch: process.arch,
    }),
  );
  writeFileSync(
    path.join(serverPackageRoot, "package.json"),
    JSON.stringify({
      name: "@getpaseo/server",
      version: options.serverPackageVersion ?? version,
    }),
  );
  if (!options.omitWorker) {
    writeFileSync(workerEntry, `// worker ${version}\n`);
  }
  writeFileSync(cliEntry, "#!/bin/sh\necho ok\n");
  chmodSync(cliEntry, 0o755);

  return { serverPackageRoot };
}

function createReleaseTarball(
  workDir: string,
  version: string,
  options?: { serverPackageVersion?: string; omitWorker?: boolean },
): { tarballPath: string; sha256: string; size: number; assetName: string } {
  const srcDir = path.join(workDir, `tar-src-${version}-${Date.now()}`);
  mkdirSync(srcDir, { recursive: true });
  createReleaseTree(srcDir, version, options);

  const assetName = `paseo-daemon-${version}-${process.platform}-${process.arch}.tar.gz`;
  const tarballPath = path.join(workDir, assetName);
  execFileSync("tar", ["-czf", tarballPath, "-C", srcDir, "."]);

  const bytes = readFileSync(tarballPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { tarballPath, sha256, size: bytes.byteLength, assetName };
}

async function startFixtureServer(
  routes: Record<string, { status?: number; body: Buffer | string }>,
) {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const entry = routes[pathname];
    if (!entry) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(entry.status ?? 200, {
      "Content-Type": pathname.endsWith(".json") ? "application/json" : "application/octet-stream",
    });
    res.end(entry.body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind fixture HTTP server");
  }
  onTestFinished(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

describe("DaemonSelfUpdater (Fork GitHub Release)", () => {
  test("downloads, verifies SHA-256, atomically flips current symlink, and prunes old releases while keeping supervisor dir", async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "fork-self-update-"));
    onTestFinished(() => rmSync(tmpRoot, { recursive: true, force: true }));

    const runtimeBase = path.join(tmpRoot, "runtime");
    const supervisorReleaseDir = path.join(runtimeBase, "releases", "0.17.510");
    const veryOldReleaseDir = path.join(runtimeBase, "releases", "0.17.511");
    const prevReleaseDir = path.join(runtimeBase, "releases", "0.17.515");
    const currentReleaseDir = path.join(runtimeBase, "releases", "0.17.517");
    createReleaseTree(supervisorReleaseDir, "0.17.510");
    createReleaseTree(veryOldReleaseDir, "0.17.511");
    createReleaseTree(prevReleaseDir, "0.17.515");
    const { serverPackageRoot } = createReleaseTree(currentReleaseDir, "0.17.517");
    const currentLink = path.join(runtimeBase, "current");
    symlinkSync(path.join("releases", "0.17.517"), currentLink, "dir");

    const archive = createReleaseTarball(tmpRoot, "0.17.518");
    const targetKey = `${process.platform}-${process.arch}`;
    let baseUrl = "";
    const manifest: ForkDaemonManifest = {
      schemaVersion: 1,
      repo: "Laokashouji/paseo",
      tag: "fork-v0.17.518",
      version: "0.17.518",
      releaseDate: "2026-11-24T06:00:00.000Z",
      targets: {
        [targetKey]: {
          asset: archive.assetName,
          url: "http://placeholder",
          sha256: archive.sha256,
          size: archive.size,
        },
      },
    };

    const archiveBytes = readFileSync(archive.tarballPath);
    baseUrl = await startFixtureServer({
      "/latest-daemon.json": {
        body: JSON.stringify({
          ...manifest,
          targets: {
            [targetKey]: {
              ...manifest.targets[targetKey],
              url: "",
            },
          },
        }),
      },
      [`/${archive.assetName}`]: { body: archiveBytes },
    });

    // Re-register with actual bound URL via dynamic server
    const actualManifest: ForkDaemonManifest = {
      ...manifest,
      targets: {
        [targetKey]: {
          ...manifest.targets[targetKey],
          url: `${baseUrl}/${archive.assetName}`,
        },
      },
    };
    const manifestServerUrl = await startFixtureServer({
      "/latest-daemon.json": { body: JSON.stringify(actualManifest) },
    });

    const phases: DaemonSelfUpdatePhase[] = [];
    const logger = createLogger();
    const updater = new DaemonSelfUpdater({
      forkRelease: new DefaultForkReleaseUpdater(),
      installOrigin: {
        resolveCurrentServerPackageRoot: () => serverPackageRoot,
      },
      env: {
        ...process.env,
        [FORK_UPDATE_MANIFEST_URL_ENV]: `${manifestServerUrl}/latest-daemon.json`,
        [FORK_SUPERVISOR_RELEASE_DIR_ENV]: supervisorReleaseDir,
      },
    });

    const result = await updater.update({
      daemonVersion: "0.17.517",
      desktopManaged: false,
      onProgress: (phase) => phases.push(phase),
      logger,
    });

    expect(result).toEqual({
      success: true,
      error: null,
      newVersion: "0.17.518",
    });
    expect(phases).toEqual(["starting", "downloading", "installing", "complete"]);
    expect(realpathSync(currentLink)).toBe(
      realpathSync(path.join(runtimeBase, "releases", "0.17.518")),
    );
    // Live supervisor dir, current worker dir, and 1 rollback dir stay intact; oldest unprotected dir is pruned.
    expect(existsSync(supervisorReleaseDir)).toBe(true);
    expect(existsSync(currentReleaseDir)).toBe(true);
    expect(existsSync(prevReleaseDir)).toBe(true);
    expect(existsSync(veryOldReleaseDir)).toBe(false);
  });

  test("rejects SHA-256 mismatch and leaves current symlink untouched", async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "fork-bad-sha-"));
    onTestFinished(() => rmSync(tmpRoot, { recursive: true, force: true }));

    const runtimeBase = path.join(tmpRoot, "runtime");
    const currentReleaseDir = path.join(runtimeBase, "releases", "0.17.517");
    const { serverPackageRoot } = createReleaseTree(currentReleaseDir, "0.17.517");
    const currentLink = path.join(runtimeBase, "current");
    symlinkSync(path.join("releases", "0.17.517"), currentLink, "dir");

    const archive = createReleaseTarball(tmpRoot, "0.17.518");
    const targetKey = `${process.platform}-${process.arch}`;
    const assetServer = await startFixtureServer({
      [`/${archive.assetName}`]: { body: readFileSync(archive.tarballPath) },
    });
    const manifestServer = await startFixtureServer({
      "/latest-daemon.json": {
        body: JSON.stringify({
          schemaVersion: 1,
          repo: "Laokashouji/paseo",
          tag: "fork-v0.17.518",
          version: "0.17.518",
          targets: {
            [targetKey]: {
              asset: archive.assetName,
              url: `${assetServer}/${archive.assetName}`,
              sha256: "0".repeat(64),
              size: archive.size,
            },
          },
        }),
      },
    });

    const updater = new DaemonSelfUpdater({
      forkRelease: new DefaultForkReleaseUpdater(),
      installOrigin: { resolveCurrentServerPackageRoot: () => serverPackageRoot },
      env: {
        ...process.env,
        [FORK_UPDATE_MANIFEST_URL_ENV]: `${manifestServer}/latest-daemon.json`,
      },
    });

    const result = await updater.update({
      daemonVersion: "0.17.517",
      desktopManaged: false,
      onProgress: () => {},
      logger: createLogger(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("SHA-256 mismatch");
    expect(realpathSync(currentLink)).toBe(realpathSync(currentReleaseDir));
    expect(existsSync(path.join(runtimeBase, "releases", "0.17.518"))).toBe(false);
  });

  test("rejects archives whose extracted @getpaseo/server version mismatches manifest", async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "fork-bad-pkg-"));
    onTestFinished(() => rmSync(tmpRoot, { recursive: true, force: true }));

    const runtimeBase = path.join(tmpRoot, "runtime");
    const currentReleaseDir = path.join(runtimeBase, "releases", "0.17.517");
    const { serverPackageRoot } = createReleaseTree(currentReleaseDir, "0.17.517");
    const currentLink = path.join(runtimeBase, "current");
    symlinkSync(path.join("releases", "0.17.517"), currentLink, "dir");

    const archive = createReleaseTarball(tmpRoot, "0.17.518", {
      serverPackageVersion: "0.17.0-beta.1",
    });
    const targetKey = `${process.platform}-${process.arch}`;
    const assetServer = await startFixtureServer({
      [`/${archive.assetName}`]: { body: readFileSync(archive.tarballPath) },
    });
    const manifestServer = await startFixtureServer({
      "/latest-daemon.json": {
        body: JSON.stringify({
          schemaVersion: 1,
          repo: "Laokashouji/paseo",
          tag: "fork-v0.17.518",
          version: "0.17.518",
          targets: {
            [targetKey]: {
              asset: archive.assetName,
              url: `${assetServer}/${archive.assetName}`,
              sha256: archive.sha256,
              size: archive.size,
            },
          },
        }),
      },
    });

    const updater = new DaemonSelfUpdater({
      forkRelease: new DefaultForkReleaseUpdater(),
      installOrigin: { resolveCurrentServerPackageRoot: () => serverPackageRoot },
      env: {
        ...process.env,
        [FORK_UPDATE_MANIFEST_URL_ENV]: `${manifestServer}/latest-daemon.json`,
      },
    });

    const result = await updater.update({
      daemonVersion: "0.17.517",
      desktopManaged: false,
      onProgress: () => {},
      logger: createLogger(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("does not match expected version 0.17.518");
    expect(realpathSync(currentLink)).toBe(realpathSync(currentReleaseDir));
  });

  test("refuses update when already running latest or newer Fork release", async () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), "fork-latest-"));
    onTestFinished(() => rmSync(tmpRoot, { recursive: true, force: true }));

    const runtimeBase = path.join(tmpRoot, "runtime");
    const currentReleaseDir = path.join(runtimeBase, "releases", "0.17.518");
    const { serverPackageRoot } = createReleaseTree(currentReleaseDir, "0.17.518");

    const targetKey = `${process.platform}-${process.arch}`;
    const manifestServer = await startFixtureServer({
      "/latest-daemon.json": {
        body: JSON.stringify({
          schemaVersion: 1,
          repo: "Laokashouji/paseo",
          tag: "fork-v0.17.518",
          version: "0.17.518",
          targets: {
            [targetKey]: {
              asset: "paseo-daemon-0.17.518-linux-x64.tar.gz",
              url: "https://github.com/Laokashouji/paseo/releases/download/fork-v0.17.518/paseo-daemon-0.17.518-linux-x64.tar.gz",
              sha256: "a".repeat(64),
              size: 1024,
            },
          },
        }),
      },
    });

    const updater = new DaemonSelfUpdater({
      forkRelease: new DefaultForkReleaseUpdater(),
      installOrigin: { resolveCurrentServerPackageRoot: () => serverPackageRoot },
      env: {
        ...process.env,
        [FORK_UPDATE_MANIFEST_URL_ENV]: `${manifestServer}/latest-daemon.json`,
      },
    });

    const alreadyLatest = await updater.update({
      daemonVersion: "0.17.518",
      desktopManaged: false,
      onProgress: () => {},
      logger: createLogger(),
    });
    expect(alreadyLatest).toEqual({
      success: false,
      error: "Daemon is already running the latest Fork release (v0.17.518).",
      newVersion: null,
    });

    const downgrade = await updater.update({
      daemonVersion: "0.17.519",
      desktopManaged: false,
      onProgress: () => {},
      logger: createLogger(),
    });
    expect(downgrade).toEqual({
      success: false,
      error: "Latest Fork release (0.17.518) is older than the running daemon (0.17.519).",
      newVersion: null,
    });
  });

  test("returns actionable error when running outside a managed Fork release runtime", async () => {
    const sourceRoot = mkdtempSync(path.join(tmpdir(), "fork-source-checkout-"));
    onTestFinished(() => rmSync(sourceRoot, { recursive: true, force: true }));

    const updater = new DaemonSelfUpdater({
      forkRelease: new DefaultForkReleaseUpdater(),
      installOrigin: {
        resolveCurrentServerPackageRoot: () => path.join(sourceRoot, "packages", "server"),
      },
      env: {},
    });

    const result = await updater.update({
      daemonVersion: "0.17.0-beta.1",
      desktopManaged: false,
      onProgress: () => {},
      logger: createLogger(),
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("install-release-cli.sh --switch-default");
  });

  test("rejects desktop-managed daemons and concurrent update requests", async () => {
    let downloadStartedResolve: (() => void) | null = null;
    let finishDownload: (() => void) | null = null;
    const downloadStarted = new Promise<void>((resolve) => {
      downloadStartedResolve = resolve;
    });

    const managedRuntime: ManagedForkRuntime = {
      runtimeBaseDir: "/tmp/paseo-fork",
      releasesDir: "/tmp/paseo-fork/releases",
      releaseDir: "/tmp/paseo-fork/releases/0.17.517",
      currentLinkPath: "/tmp/paseo-fork/current",
      metadata: {
        schemaVersion: 1,
        repo: "Laokashouji/paseo",
        version: "0.17.517",
        tag: "fork-v0.17.517",
        platform: "linux",
        arch: "x64",
      },
    };

    const forkRelease: ForkReleaseUpdater = {
      inspectManagedRuntime: async () => managedRuntime,
      fetchManifest: async () => ({
        schemaVersion: 1,
        repo: "Laokashouji/paseo",
        tag: "fork-v0.17.518",
        version: "0.17.518",
        targets: {
          "linux-x64": {
            asset: "paseo-daemon-0.17.518-linux-x64.tar.gz",
            url: "https://github.com/Laokashouji/paseo/releases/download/fork-v0.17.518/paseo-daemon-0.17.518-linux-x64.tar.gz",
            sha256: "b".repeat(64),
            size: 1234,
          },
        },
      }),
      downloadTarball: async () => {
        downloadStartedResolve?.();
        await new Promise<void>((resolve) => {
          finishDownload = resolve;
        });
      },
      installTarball: async () => ({
        version: "0.17.518",
        releaseDir: "/tmp/paseo-fork/releases/0.17.518",
        currentLinkPath: "/tmp/paseo-fork/current",
        prunedReleases: [],
      }),
    };

    const runtime: DaemonSelfUpdateRuntime = {
      forkRelease,
      installOrigin: {
        resolveCurrentServerPackageRoot: () =>
          "/tmp/paseo-fork/releases/0.17.517/node_modules/@getpaseo/server",
      },
      platform: "linux",
      arch: "x64",
      env: {},
    };
    const updater = new DaemonSelfUpdater(runtime);

    const desktopResult = await updater.update({
      daemonVersion: "0.17.517",
      desktopManaged: true,
      onProgress: () => {},
      logger: createLogger(),
    });
    expect(desktopResult).toEqual({
      success: false,
      error: "This daemon is managed by Paseo Desktop. Update Paseo Desktop on the host.",
      newVersion: null,
    });

    const first = updater.update({
      daemonVersion: "0.17.517",
      desktopManaged: false,
      onProgress: () => {},
      logger: createLogger(),
    });
    await downloadStarted;

    await expect(
      updater.update({
        daemonVersion: "0.17.517",
        desktopManaged: false,
        onProgress: () => {},
        logger: createLogger(),
      }),
    ).rejects.toBeInstanceOf(DaemonSelfUpdateInProgressError);

    finishDownload?.();
    await expect(first).resolves.toEqual({
      success: true,
      error: null,
      newVersion: "0.17.518",
    });
  });
});
