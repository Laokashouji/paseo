import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

export const FORK_SUPERVISOR_RELEASE_DIR_ENV = "PASEO_FORK_SUPERVISOR_RELEASE_DIR";

const FORK_RUNTIME_METADATA_FILENAME = "fork-runtime.json";
const FORK_RUNTIME_RELEASES_DIR = "releases";
const FORK_RUNTIME_CURRENT_LINK = "current";

function safeRealpath(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

/**
 * Walks up from a script running inside a managed Fork release layout
 * (`<runtimeBase>/releases/<version>/...`) and returns the resolved release directory.
 */
export function resolveForkReleaseDir(scriptPath: string): string | null {
  let currentDir = path.dirname(safeRealpath(scriptPath));

  while (true) {
    const metadataPath = path.join(currentDir, FORK_RUNTIME_METADATA_FILENAME);
    if (existsSync(metadataPath)) {
      const releasesDir = path.dirname(currentDir);
      if (path.basename(releasesDir) === FORK_RUNTIME_RELEASES_DIR) {
        return currentDir;
      }
      return null;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Resolves the latest daemon worker entrypoint through `<runtimeBase>/current` so
 * a running supervisor seamlessly loads newly installed Fork releases on worker respawn.
 */
export function resolveManagedForkCurrentWorkerEntry(scriptPath: string): string | null {
  const releaseDir = resolveForkReleaseDir(scriptPath);
  if (!releaseDir) {
    return null;
  }

  const runtimeBaseDir = path.dirname(path.dirname(releaseDir));
  const currentLinkDir = path.join(runtimeBaseDir, FORK_RUNTIME_CURRENT_LINK);
  if (!existsSync(path.join(currentLinkDir, FORK_RUNTIME_METADATA_FILENAME))) {
    return null;
  }

  const workerEntry = path.join(
    currentLinkDir,
    "node_modules",
    "@getpaseo",
    "server",
    "dist",
    "server",
    "server",
    "daemon-worker.js",
  );
  if (!existsSync(workerEntry)) {
    return null;
  }

  return safeRealpath(workerEntry);
}
