import { rm } from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import {
  DEFAULT_FORK_GITHUB_REPO,
  FORK_SUPERVISOR_RELEASE_DIR_ENV,
  FORK_UPDATE_MANIFEST_URL_ENV,
  FORK_UPDATE_REPO_ENV,
  forkReleaseUpdater,
  resolvePlatformTargetKey,
  type ForkReleaseUpdater,
} from "./fork-release-updater.js";
import { daemonInstallOriginRuntime, type DaemonInstallOriginRuntime } from "./install-origin.js";

export type DaemonSelfUpdatePhase = "starting" | "downloading" | "installing" | "complete";

export interface DaemonSelfUpdateResult {
  success: boolean;
  error: string | null;
  newVersion: string | null;
}

export interface DaemonSelfUpdateInput {
  daemonVersion: string | null;
  desktopManaged: boolean;
  onProgress: (phase: DaemonSelfUpdatePhase) => void;
  logger: DaemonSelfUpdateLogger;
}

export interface DaemonSelfUpdateLogger {
  error(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface DaemonSelfUpdateRuntime {
  forkRelease: ForkReleaseUpdater;
  installOrigin: DaemonInstallOriginRuntime;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}

export class DaemonSelfUpdateInProgressError extends Error {
  constructor() {
    super("An update is already in progress");
    this.name = "DaemonSelfUpdateInProgressError";
  }
}

const defaultRuntime: DaemonSelfUpdateRuntime = {
  forkRelease: forkReleaseUpdater,
  installOrigin: daemonInstallOriginRuntime,
};

const DESKTOP_MANAGED_UPDATE_ERROR =
  "This daemon is managed by Paseo Desktop. Update Paseo Desktop on the host.";

const NOT_MANAGED_FORK_RUNTIME_ERROR =
  "This daemon is not running from a managed Fork release runtime. Install the Fork release runtime via ./scripts/fork/install-release-cli.sh --switch-default and restart the daemon service to enable one-click Fork updates.";

export class DaemonSelfUpdater {
  private inProgress = false;

  constructor(private readonly runtime: DaemonSelfUpdateRuntime = defaultRuntime) {}

  async update(input: DaemonSelfUpdateInput): Promise<DaemonSelfUpdateResult> {
    if (input.desktopManaged) {
      return { success: false, error: DESKTOP_MANAGED_UPDATE_ERROR, newVersion: null };
    }

    if (this.inProgress) {
      throw new DaemonSelfUpdateInProgressError();
    }

    this.inProgress = true;
    let tarballPath: string | null = null;
    try {
      input.onProgress("starting");
      const env = this.runtime.env ?? process.env;
      const serverPackageRoot = this.runtime.installOrigin.resolveCurrentServerPackageRoot();
      const managedRuntime = await this.runtime.forkRelease.inspectManagedRuntime(
        serverPackageRoot,
        env,
      );
      if (!managedRuntime) {
        return { success: false, error: NOT_MANAGED_FORK_RUNTIME_ERROR, newVersion: null };
      }

      const repo =
        env[FORK_UPDATE_REPO_ENV]?.trim() ||
        managedRuntime.metadata.repo ||
        DEFAULT_FORK_GITHUB_REPO;
      const manifest = await this.runtime.forkRelease.fetchManifest({
        repo,
        overrideUrl: env[FORK_UPDATE_MANIFEST_URL_ENV],
      });

      const currentVersion = input.daemonVersion ?? managedRuntime.metadata.version;
      if (currentVersion && semver.valid(currentVersion) && semver.valid(manifest.version)) {
        if (semver.lt(manifest.version, currentVersion)) {
          return {
            success: false,
            error: `Latest Fork release (${manifest.version}) is older than the running daemon (${currentVersion}).`,
            newVersion: null,
          };
        }
        if (semver.eq(manifest.version, currentVersion)) {
          return {
            success: false,
            error: `Daemon is already running the latest Fork release (v${currentVersion}).`,
            newVersion: null,
          };
        }
      }

      const targetKey = resolvePlatformTargetKey(this.runtime.platform, this.runtime.arch);
      const target = manifest.targets[targetKey];
      if (!target) {
        const availableTargets = Object.keys(manifest.targets).sort().join(", ") || "none";
        return {
          success: false,
          error: `Fork release ${manifest.version} does not include a daemon package for ${targetKey} (available: ${availableTargets}).`,
          newVersion: null,
        };
      }

      input.onProgress("downloading");
      tarballPath = path.join(
        managedRuntime.runtimeBaseDir,
        ".tmp",
        `${target.asset}.${process.pid}.${Date.now()}`,
      );
      await this.runtime.forkRelease.downloadTarball({
        url: target.url,
        expectedSha256: target.sha256,
        expectedSize: target.size,
        destinationPath: tarballPath,
      });

      input.onProgress("installing");
      const installed = await this.runtime.forkRelease.installTarball({
        tarballPath,
        runtime: managedRuntime,
        expectedVersion: manifest.version,
        supervisorReleaseDir: env[FORK_SUPERVISOR_RELEASE_DIR_ENV],
        logger: input.logger,
      });

      input.onProgress("complete");
      return { success: true, error: null, newVersion: installed.version };
    } catch (error) {
      input.logger.error({ err: error }, "Daemon self-update failed with exception");
      return { success: false, error: getErrorMessage(error), newVersion: null };
    } finally {
      if (tarballPath) {
        await rm(tarballPath, { force: true }).catch(() => {});
      }
      this.inProgress = false;
    }
  }
}

export const daemonSelfUpdater = new DaemonSelfUpdater();
