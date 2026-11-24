import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import semver from "semver";
import { z } from "zod";
import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import { execCommand } from "../../../utils/spawn.js";

export const DEFAULT_FORK_GITHUB_REPO = "Laokashouji/paseo";
export const FORK_RUNTIME_METADATA_FILENAME = "fork-runtime.json";
export const FORK_DAEMON_MANIFEST_FILENAME = "latest-daemon.json";
export const FORK_RUNTIME_CURRENT_LINK = "current";
export const FORK_RUNTIME_RELEASES_DIR = "releases";
export const FORK_SUPERVISOR_RELEASE_DIR_ENV = "PASEO_FORK_SUPERVISOR_RELEASE_DIR";
export const FORK_UPDATE_MANIFEST_URL_ENV = "PASEO_FORK_UPDATE_MANIFEST_URL";
export const FORK_UPDATE_REPO_ENV = "PASEO_FORK_UPDATE_REPO";
export const FORK_RUNTIME_ROOT_ENV = "PASEO_FORK_RUNTIME_ROOT";

const MANIFEST_FETCH_TIMEOUT_MS = 20_000;
const TARBALL_DOWNLOAD_TIMEOUT_MS = 300_000;
const TAR_EXTRACT_TIMEOUT_MS = 120_000;
const TAR_MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const STABLE_SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SAFE_ASSET_NAME_RE = /^[A-Za-z0-9._-]+$/;

const ForkRuntimeMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    repo: z.string().min(1),
    version: z.string().min(1),
    tag: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
  })
  .passthrough();

const ForkDaemonManifestTargetSchema = z
  .object({
    asset: z.string().regex(SAFE_ASSET_NAME_RE, "Invalid release asset filename"),
    url: z.string().url(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/i, "Invalid SHA-256 digest"),
    size: z.number().int().positive(),
  })
  .passthrough();

const ForkDaemonManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    repo: z.string().min(1),
    tag: z.string().min(1),
    version: z.string().regex(STABLE_SEMVER_RE, "Expected stable semver X.Y.Z"),
    releaseDate: z.string().min(1).optional(),
    targets: z.record(z.string(), ForkDaemonManifestTargetSchema),
  })
  .passthrough();

const ServerPackageJsonSchema = z
  .object({
    name: z.string(),
    version: z.string().min(1),
  })
  .passthrough();

export type ForkRuntimeMetadata = z.infer<typeof ForkRuntimeMetadataSchema>;
export type ForkDaemonManifestTarget = z.infer<typeof ForkDaemonManifestTargetSchema>;
export type ForkDaemonManifest = z.infer<typeof ForkDaemonManifestSchema>;

export interface ManagedForkRuntime {
  runtimeBaseDir: string;
  releasesDir: string;
  releaseDir: string;
  currentLinkPath: string;
  metadata: ForkRuntimeMetadata;
}

export interface ForkReleaseInstallResult {
  version: string;
  releaseDir: string;
  currentLinkPath: string;
  prunedReleases: string[];
}

export interface ForkReleaseUpdaterLogger {
  warn(obj: object, msg?: string): void;
}

export interface ForkReleaseUpdater {
  inspectManagedRuntime(
    serverPackageRoot: string | null,
    env?: NodeJS.ProcessEnv,
  ): Promise<ManagedForkRuntime | null>;
  fetchManifest(input: { repo: string; overrideUrl?: string | null }): Promise<ForkDaemonManifest>;
  downloadTarball(input: {
    url: string;
    expectedSha256: string;
    expectedSize: number;
    destinationPath: string;
  }): Promise<void>;
  installTarball(input: {
    tarballPath: string;
    runtime: ManagedForkRuntime;
    expectedVersion: string;
    supervisorReleaseDir?: string | null;
    logger?: ForkReleaseUpdaterLogger;
  }): Promise<ForkReleaseInstallResult>;
}

export type TarballExtractor = (input: {
  tarballPath: string;
  destinationDir: string;
}) => Promise<void>;

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function safeRealpath(targetPath: string): Promise<string> {
  try {
    return await realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

export async function resolveForkReleaseRootFromServerPackage(
  serverPackageRoot: string,
): Promise<string | null> {
  let currentDir = await safeRealpath(serverPackageRoot);

  while (true) {
    const metadataPath = path.join(currentDir, FORK_RUNTIME_METADATA_FILENAME);
    if (await pathExists(metadataPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

async function parseManagedForkRuntimeFromReleaseDir(
  releaseDir: string,
): Promise<ManagedForkRuntime | null> {
  const resolvedReleaseDir = await safeRealpath(releaseDir);
  const metadataPath = path.join(resolvedReleaseDir, FORK_RUNTIME_METADATA_FILENAME);
  if (!(await pathExists(metadataPath))) {
    return null;
  }

  const releasesDir = path.dirname(resolvedReleaseDir);
  if (path.basename(releasesDir) !== FORK_RUNTIME_RELEASES_DIR) {
    return null;
  }

  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    return null;
  }

  const parsed = ForkRuntimeMetadataSchema.safeParse(parsedRaw);
  if (!parsed.success) {
    return null;
  }

  const runtimeBaseDir = path.dirname(releasesDir);
  return {
    runtimeBaseDir,
    releasesDir,
    releaseDir: resolvedReleaseDir,
    currentLinkPath: path.join(runtimeBaseDir, FORK_RUNTIME_CURRENT_LINK),
    metadata: parsed.data,
  };
}

export async function inspectManagedForkRuntime(
  serverPackageRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ManagedForkRuntime | null> {
  const overrideRoot = env[FORK_RUNTIME_ROOT_ENV]?.trim();
  if (overrideRoot) {
    return parseManagedForkRuntimeFromReleaseDir(overrideRoot);
  }

  if (!serverPackageRoot) {
    return null;
  }

  const releaseDir = await resolveForkReleaseRootFromServerPackage(serverPackageRoot);
  if (!releaseDir) {
    return null;
  }

  return parseManagedForkRuntimeFromReleaseDir(releaseDir);
}

export function resolveForkManifestUrl(input: {
  repo: string;
  overrideUrl?: string | null;
}): string {
  const override = input.overrideUrl?.trim();
  if (override) {
    return override;
  }
  const repo = input.repo.trim() || DEFAULT_FORK_GITHUB_REPO;
  return `https://github.com/${repo}/releases/latest/download/${FORK_DAEMON_MANIFEST_FILENAME}`;
}

export function resolvePlatformTargetKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  return `${platform}-${arch}`;
}

function assertAllowedDownloadUrl(rawUrl: string): void {
  const parsed = new URL(rawUrl);
  if (parsed.protocol === "https:") {
    return;
  }
  if (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "localhost" ||
      parsed.hostname === "::1")
  ) {
    return;
  }
  throw new Error(`Refusing to download Fork daemon archive from insecure URL: ${rawUrl}`);
}

export async function fetchForkDaemonManifest(input: {
  manifestUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<ForkDaemonManifest> {
  assertAllowedDownloadUrl(input.manifestUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  const response = await fetchImpl(input.manifestUrl, {
    headers: {
      Accept: "application/json",
      "User-Agent": "paseo-fork-daemon-updater",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(input.timeoutMs ?? MANIFEST_FETCH_TIMEOUT_MS),
  });

  if (response.status === 404) {
    throw new Error(
      `Fork daemon release manifest (${FORK_DAEMON_MANIFEST_FILENAME}) was not found at ${input.manifestUrl}. Cut a new fork release that publishes daemon artifacts first.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Fork daemon manifest (${response.status} ${response.statusText}) from ${input.manifestUrl}.`,
    );
  }

  let rawJson: unknown;
  try {
    rawJson = await response.json();
  } catch (error) {
    throw new Error(`Invalid JSON in Fork daemon manifest: ${getErrorMessage(error)}`, {
      cause: error,
    });
  }

  const parsed = ForkDaemonManifestSchema.safeParse(rawJson);
  if (!parsed.success) {
    throw new Error(`Invalid Fork daemon manifest schema: ${parsed.error.message}`);
  }
  return parsed.data;
}

export async function downloadAndVerifyTarball(input: {
  url: string;
  expectedSha256: string;
  expectedSize?: number;
  destinationPath: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  assertAllowedDownloadUrl(input.url);
  await mkdir(path.dirname(input.destinationPath), { recursive: true });
  const fetchImpl = input.fetchImpl ?? fetch;

  const response = await fetchImpl(input.url, {
    headers: {
      "User-Agent": "paseo-fork-daemon-updater",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(input.timeoutMs ?? TARBALL_DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download Fork daemon archive (${response.status} ${response.statusText}) from ${input.url}.`,
    );
  }

  const hash = createHash("sha256");
  let bytesWritten = 0;
  const writer = createWriteStream(input.destinationPath, { mode: 0o600 });
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      hash.update(chunk);
      bytesWritten += chunk.byteLength;
      if (!writer.write(chunk)) {
        await new Promise<void>((resolve, reject) => {
          writer.once("drain", resolve);
          writer.once("error", reject);
        });
      }
    }

    await new Promise<void>((resolve, reject) => {
      writer.once("error", reject);
      writer.end(() => resolve());
    });

    if (typeof input.expectedSize === "number" && bytesWritten !== input.expectedSize) {
      throw new Error(
        `Downloaded archive size mismatch (expected ${input.expectedSize} bytes, got ${bytesWritten} bytes).`,
      );
    }

    const actualSha256 = hash.digest("hex").toLowerCase();
    const expectedSha256 = input.expectedSha256.toLowerCase();
    if (actualSha256 !== expectedSha256) {
      throw new Error(
        `Downloaded archive SHA-256 mismatch (expected ${expectedSha256}, got ${actualSha256}).`,
      );
    }
  } catch (error) {
    writer.destroy();
    await rm(input.destinationPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function defaultExtractTarball(input: {
  tarballPath: string;
  destinationDir: string;
}): Promise<void> {
  await execCommand("tar", ["-xzf", input.tarballPath, "-C", input.destinationDir], {
    timeout: TAR_EXTRACT_TIMEOUT_MS,
    maxBuffer: TAR_MAX_BUFFER_BYTES,
  });
}

async function verifyExtractedForkRelease(
  stagingDir: string,
  expectedVersion: string,
): Promise<void> {
  const metadataPath = path.join(stagingDir, FORK_RUNTIME_METADATA_FILENAME);
  if (!(await pathExists(metadataPath))) {
    throw new Error(`Extracted archive is missing ${FORK_RUNTIME_METADATA_FILENAME}.`);
  }

  const metadata = ForkRuntimeMetadataSchema.parse(
    JSON.parse(await readFile(metadataPath, "utf8")),
  );
  if (metadata.version !== expectedVersion) {
    throw new Error(
      `Extracted archive metadata version ${metadata.version} does not match expected version ${expectedVersion}.`,
    );
  }

  const serverPackageJsonPath = path.join(
    stagingDir,
    "node_modules",
    "@getpaseo",
    "server",
    "package.json",
  );
  if (!(await pathExists(serverPackageJsonPath))) {
    throw new Error("Extracted archive is missing node_modules/@getpaseo/server/package.json.");
  }

  const serverPkg = ServerPackageJsonSchema.parse(
    JSON.parse(await readFile(serverPackageJsonPath, "utf8")),
  );
  if (serverPkg.name !== "@getpaseo/server" || serverPkg.version !== expectedVersion) {
    throw new Error(
      `Extracted @getpaseo/server version (${serverPkg.version}) does not match expected version ${expectedVersion}.`,
    );
  }

  const workerEntryPath = path.join(
    stagingDir,
    "node_modules",
    "@getpaseo",
    "server",
    "dist",
    "server",
    "server",
    "daemon-worker.js",
  );
  if (!(await pathExists(workerEntryPath))) {
    throw new Error("Extracted archive is missing compiled daemon-worker.js entrypoint.");
  }

  const cliEntryPath = path.join(stagingDir, "bin", "paseo");
  if (!(await pathExists(cliEntryPath))) {
    throw new Error("Extracted archive is missing bin/paseo launcher.");
  }
  await chmod(cliEntryPath, 0o755);
}

async function atomicallySwitchCurrentSymlink(input: {
  runtimeBaseDir: string;
  currentLinkPath: string;
  targetVersion: string;
}): Promise<void> {
  const relativeTarget = path.join(FORK_RUNTIME_RELEASES_DIR, input.targetVersion);
  const tempLinkPath = path.join(
    input.runtimeBaseDir,
    `.${FORK_RUNTIME_CURRENT_LINK}.next.${process.pid}.${Date.now()}`,
  );

  try {
    await symlink(relativeTarget, tempLinkPath, "dir");
    await rename(tempLinkPath, input.currentLinkPath);
  } catch (error) {
    await rm(tempLinkPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function pruneOldForkReleases(input: {
  releasesDir: string;
  protectedDirs: ReadonlyArray<string | null | undefined>;
  keepPreviousCount?: number;
  logger?: ForkReleaseUpdaterLogger;
}): Promise<string[]> {
  const keepPreviousCount = input.keepPreviousCount ?? 1;
  const protectedRealpaths = new Set<string>();
  for (const dir of input.protectedDirs) {
    if (dir && dir.trim().length > 0) {
      protectedRealpaths.add(await safeRealpath(dir));
    }
  }

  let entries: string[];
  try {
    entries = await readdir(input.releasesDir);
  } catch {
    return [];
  }

  const candidates: Array<{ name: string; fullPath: string; mtimeMs: number }> = [];
  for (const name of entries) {
    const fullPath = path.join(input.releasesDir, name);
    const resolved = await safeRealpath(fullPath);
    if (protectedRealpaths.has(resolved)) {
      continue;
    }
    try {
      const info = await stat(fullPath);
      if (!info.isDirectory()) {
        continue;
      }
      candidates.push({ name, fullPath, mtimeMs: info.mtimeMs });
    } catch {
      continue;
    }
  }

  candidates.sort((left, right) => {
    const leftValid = semver.valid(left.name);
    const rightValid = semver.valid(right.name);
    if (leftValid && rightValid) {
      return semver.rcompare(leftValid, rightValid);
    }
    return right.mtimeMs - left.mtimeMs;
  });

  const pruned: string[] = [];
  for (const candidate of candidates.slice(keepPreviousCount)) {
    try {
      await rm(candidate.fullPath, { recursive: true, force: true });
      pruned.push(candidate.name);
    } catch (error) {
      input.logger?.warn(
        { err: error, releaseDir: candidate.fullPath },
        "Failed to prune old Fork release directory",
      );
    }
  }

  return pruned;
}

export async function installForkReleaseTarball(input: {
  tarballPath: string;
  runtime: ManagedForkRuntime;
  expectedVersion: string;
  supervisorReleaseDir?: string | null;
  extractTarball?: TarballExtractor;
  logger?: ForkReleaseUpdaterLogger;
}): Promise<ForkReleaseInstallResult> {
  if (!STABLE_SEMVER_RE.test(input.expectedVersion)) {
    throw new Error(`Invalid Fork release version "${input.expectedVersion}".`);
  }

  const tmpRoot = path.join(input.runtime.runtimeBaseDir, ".tmp");
  const stagingDir = path.join(
    tmpRoot,
    `stage-${input.expectedVersion}-${process.pid}-${Date.now()}`,
  );
  await mkdir(input.runtime.releasesDir, { recursive: true });
  await mkdir(stagingDir, { recursive: true });

  const extractTarball = input.extractTarball ?? defaultExtractTarball;
  const targetReleaseDir = path.join(input.runtime.releasesDir, input.expectedVersion);
  let displacedReleaseDir: string | null = null;

  try {
    await extractTarball({
      tarballPath: input.tarballPath,
      destinationDir: stagingDir,
    });
    await verifyExtractedForkRelease(stagingDir, input.expectedVersion);

    if (await pathExists(targetReleaseDir)) {
      displacedReleaseDir = path.join(
        tmpRoot,
        `replaced-${input.expectedVersion}-${process.pid}-${Date.now()}`,
      );
      await rename(targetReleaseDir, displacedReleaseDir);
    }

    await rename(stagingDir, targetReleaseDir);

    await atomicallySwitchCurrentSymlink({
      runtimeBaseDir: input.runtime.runtimeBaseDir,
      currentLinkPath: input.runtime.currentLinkPath,
      targetVersion: input.expectedVersion,
    });
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (
      displacedReleaseDir &&
      (await pathExists(displacedReleaseDir)) &&
      !(await pathExists(targetReleaseDir))
    ) {
      await rename(displacedReleaseDir, targetReleaseDir).catch(() => {});
    }
    throw error;
  }

  const protectedDirs = [targetReleaseDir, input.runtime.releaseDir, input.supervisorReleaseDir];
  if (displacedReleaseDir) {
    const displacedResolved = await safeRealpath(displacedReleaseDir);
    const protectedRealpaths = await Promise.all(
      protectedDirs.filter((dir): dir is string => Boolean(dir)).map((dir) => safeRealpath(dir)),
    );
    if (!protectedRealpaths.includes(displacedResolved)) {
      await rm(displacedReleaseDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  const prunedReleases = await pruneOldForkReleases({
    releasesDir: input.runtime.releasesDir,
    protectedDirs,
    keepPreviousCount: 1,
    logger: input.logger,
  });

  return {
    version: input.expectedVersion,
    releaseDir: await safeRealpath(targetReleaseDir),
    currentLinkPath: input.runtime.currentLinkPath,
    prunedReleases,
  };
}

export class DefaultForkReleaseUpdater implements ForkReleaseUpdater {
  constructor(
    private readonly options: {
      fetchImpl?: typeof fetch;
      extractTarball?: TarballExtractor;
    } = {},
  ) {}

  inspectManagedRuntime(
    serverPackageRoot: string | null,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ManagedForkRuntime | null> {
    return inspectManagedForkRuntime(serverPackageRoot, env);
  }

  fetchManifest(input: { repo: string; overrideUrl?: string | null }): Promise<ForkDaemonManifest> {
    const manifestUrl = resolveForkManifestUrl(input);
    return fetchForkDaemonManifest({
      manifestUrl,
      fetchImpl: this.options.fetchImpl,
    });
  }

  downloadTarball(input: {
    url: string;
    expectedSha256: string;
    expectedSize: number;
    destinationPath: string;
  }): Promise<void> {
    return downloadAndVerifyTarball({
      url: input.url,
      expectedSha256: input.expectedSha256,
      expectedSize: input.expectedSize,
      destinationPath: input.destinationPath,
      fetchImpl: this.options.fetchImpl,
    });
  }

  installTarball(input: {
    tarballPath: string;
    runtime: ManagedForkRuntime;
    expectedVersion: string;
    supervisorReleaseDir?: string | null;
    logger?: ForkReleaseUpdaterLogger;
  }): Promise<ForkReleaseInstallResult> {
    return installForkReleaseTarball({
      tarballPath: input.tarballPath,
      runtime: input.runtime,
      expectedVersion: input.expectedVersion,
      supervisorReleaseDir: input.supervisorReleaseDir,
      extractTarball: this.options.extractTarball,
      logger: input.logger,
    });
  }
}

export const forkReleaseUpdater = new DefaultForkReleaseUpdater();
