import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_SEMVER_RE = /^\d+\.\d+\.\d+$/;
const FORK_TAG_RE = /^fork-v\d+\.\d+\.\d+$/;

export const DAEMON_WORKSPACE_PACKAGES = [
  { name: "@getpaseo/protocol", dir: "packages/protocol" },
  { name: "@getpaseo/relay", dir: "packages/relay" },
  { name: "@getpaseo/highlight", dir: "packages/highlight" },
  { name: "@getpaseo/plugin", dir: "packages/plugin" },
  { name: "@getpaseo/client", dir: "packages/client" },
  { name: "@getpaseo/server", dir: "packages/server" },
  { name: "@getpaseo/cli", dir: "packages/cli" },
];

export function formatDaemonAssetName({ version, platform, arch }) {
  return `paseo-daemon-${version}-${platform}-${arch}.tar.gz`;
}

export function buildForkRuntimeMetadata({ repo, version, tag, platform, arch }) {
  return {
    schemaVersion: 1,
    repo,
    version,
    tag,
    platform,
    arch,
  };
}

export function buildDaemonTargetFragment({ repo, version, tag, platform, arch, sha256, size }) {
  const asset = formatDaemonAssetName({ version, platform, arch });
  return {
    schemaVersion: 1,
    repo,
    tag,
    version,
    targetKey: `${platform}-${arch}`,
    target: {
      asset,
      url: `https://github.com/${repo}/releases/download/${tag}/${asset}`,
      sha256: sha256.toLowerCase(),
      size,
    },
  };
}

export function renderLauncherScript() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'SOURCE="${BASH_SOURCE[0]}"',
    'while [[ -L "$SOURCE" ]]; do',
    '  DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"',
    '  SOURCE="$(readlink "$SOURCE")"',
    '  [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"',
    "done",
    'RUNTIME_DIR="$(cd -P "$(dirname "$SOURCE")/.." && pwd)"',
    'exec node --disable-warning=DEP0040 "${RUNTIME_DIR}/node_modules/@getpaseo/cli/bin/paseo" "$@"',
    "",
  ].join("\n");
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = options.capture
      ? `\nstdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`
      : "";
    throw new Error(
      `Command failed (exit ${result.status}): ${command} ${args.join(" ")}${detail}`,
    );
  }
  return result;
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function applyServerPatchesIfPresent(repoRoot, runtimeDir) {
  const patchesDir = path.join(repoRoot, "patches");
  const targetSdkDir = path.join(runtimeDir, "node_modules", "@opencode-ai", "sdk");
  if (!fs.existsSync(patchesDir) || !fs.existsSync(targetSdkDir)) {
    return;
  }

  const patchFiles = fs
    .readdirSync(patchesDir)
    .filter((file) => file.startsWith("@opencode-ai+sdk+") && file.endsWith(".patch"));
  if (patchFiles.length === 0) {
    return;
  }

  const patchBin = path.join(
    repoRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "patch-package.cmd" : "patch-package",
  );
  if (!fs.existsSync(patchBin)) {
    throw new Error(`Expected patch-package binary at ${patchBin}`);
  }

  const tmpPatchDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-daemon-patch-"));
  try {
    for (const file of patchFiles) {
      fs.copyFileSync(path.join(patchesDir, file), path.join(tmpPatchDir, file));
    }
    runChecked(
      patchBin,
      ["--patch-dir", path.relative(runtimeDir, tmpPatchDir), "--error-on-fail"],
      {
        cwd: runtimeDir,
        shell: process.platform === "win32",
      },
    );
  } finally {
    fs.rmSync(tmpPatchDir, { recursive: true, force: true });
  }
}

function assertWorkspaceVersions(repoRoot, version) {
  for (const pkg of DAEMON_WORKSPACE_PACKAGES) {
    const pkgJsonPath = path.join(repoRoot, pkg.dir, "package.json");
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
    if (pkgJson.version !== version) {
      throw new Error(
        `${pkg.dir}/package.json has version=${pkgJson.version}, expected ${version}. Run scripts/fork/version-utils.mjs apply --version ${version} first.`,
      );
    }
  }
}

function packWorkspacePackages(repoRoot, packsDir) {
  const packedPaths = {};
  for (const pkg of DAEMON_WORKSPACE_PACKAGES) {
    const packResult = runChecked(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", packsDir, "--json"],
      { cwd: path.join(repoRoot, pkg.dir), capture: true },
    );
    const parsed = JSON.parse(packResult.stdout);
    const filename = Array.isArray(parsed) ? parsed[0]?.filename : parsed?.filename;
    if (!filename) {
      throw new Error(`npm pack did not report filename for ${pkg.name}`);
    }
    packedPaths[pkg.name] = `file:${path.join(packsDir, filename)}`;
  }
  return packedPaths;
}

function verifyStagedRuntime(runtimeDir, launcherPath, expectedVersion) {
  const requiredPaths = [
    path.join(runtimeDir, "node_modules", "@getpaseo", "server", "package.json"),
    path.join(
      runtimeDir,
      "node_modules",
      "@getpaseo",
      "server",
      "dist",
      "server",
      "server",
      "daemon-worker.js",
    ),
    path.join(
      runtimeDir,
      "node_modules",
      "@getpaseo",
      "server",
      "dist",
      "scripts",
      "supervisor-entrypoint.js",
    ),
    path.join(runtimeDir, "node_modules", "@getpaseo", "cli", "bin", "paseo"),
  ];
  for (const required of requiredPaths) {
    if (!fs.existsSync(required)) {
      throw new Error(`Packaged runtime is missing required file: ${required}`);
    }
  }

  const versionCheck = runChecked(launcherPath, ["--version"], {
    cwd: runtimeDir,
    capture: true,
  });
  const reportedVersion = versionCheck.stdout.trim();
  if (reportedVersion !== expectedVersion) {
    throw new Error(
      `Packaged CLI reported version "${reportedVersion}", expected "${expectedVersion}".`,
    );
  }
}

function stageRuntimeDirectory({
  repoRoot,
  runtimeDir,
  packsDir,
  version,
  tag,
  repo,
  platform,
  arch,
}) {
  const packedPaths = packWorkspacePackages(repoRoot, packsDir);
  const stagePkgJson = {
    name: "paseo-fork-daemon-runtime",
    private: true,
    version,
    dependencies: packedPaths,
    overrides: packedPaths,
  };
  fs.writeFileSync(
    path.join(runtimeDir, "package.json"),
    `${JSON.stringify(stagePkgJson, null, 2)}\n`,
  );

  runChecked("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--prefer-offline"], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      ONNXRUNTIME_NODE_INSTALL: "skip",
    },
  });

  applyServerPatchesIfPresent(repoRoot, runtimeDir);

  // Replace staging package.json with clean metadata (no temporary file: references)
  // and drop temporary lockfile.
  fs.rmSync(path.join(runtimeDir, "package-lock.json"), { force: true });
  fs.writeFileSync(
    path.join(runtimeDir, "package.json"),
    `${JSON.stringify({ name: "paseo-fork-daemon-runtime", private: true, version }, null, 2)}\n`,
  );

  const metadata = buildForkRuntimeMetadata({ repo, version, tag, platform, arch });
  fs.writeFileSync(
    path.join(runtimeDir, "fork-runtime.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );

  const binDir = path.join(runtimeDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const launcherPath = path.join(binDir, "paseo");
  fs.writeFileSync(launcherPath, renderLauncherScript(), { mode: 0o755 });
  fs.chmodSync(launcherPath, 0o755);

  verifyStagedRuntime(runtimeDir, launcherPath, version);
}

export function packageDaemonRelease({
  repoRoot,
  version,
  tag,
  repo,
  outputDir,
  platform = process.platform,
  arch = process.arch,
  skipBuild = false,
  skipWebUi = false,
}) {
  if (!STABLE_SEMVER_RE.test(version)) {
    throw new Error(`Invalid version "${version}". Expected stable semver X.Y.Z.`);
  }
  if (!FORK_TAG_RE.test(tag)) {
    throw new Error(`Invalid tag "${tag}". Expected fork-vX.Y.Z.`);
  }
  if (!repo || !repo.includes("/")) {
    throw new Error(`Invalid repo "${repo}". Expected owner/repo.`);
  }

  if (!skipBuild) {
    runChecked("npm", ["run", "build:server"], { cwd: repoRoot });
    if (!skipWebUi) {
      runChecked("npm", ["run", "build:daemon-web-ui"], { cwd: repoRoot });
    }
  }

  assertWorkspaceVersions(repoRoot, version);

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-daemon-pack-"));
  const packsDir = path.join(workDir, "packs");
  const runtimeDir = path.join(workDir, "runtime");
  fs.mkdirSync(packsDir, { recursive: true });
  fs.mkdirSync(runtimeDir, { recursive: true });

  try {
    stageRuntimeDirectory({
      repoRoot,
      runtimeDir,
      packsDir,
      version,
      tag,
      repo,
      platform,
      arch,
    });

    const assetsDir = path.join(outputDir, "assets");
    const manifestsDir = path.join(outputDir, "manifests");
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(manifestsDir, { recursive: true });

    const assetName = formatDaemonAssetName({ version, platform, arch });
    const tarballPath = path.join(assetsDir, assetName);
    runChecked("tar", ["-czf", tarballPath, "-C", runtimeDir, "."]);

    const sha256 = sha256File(tarballPath);
    const size = fs.statSync(tarballPath).size;
    const fragment = buildDaemonTargetFragment({
      repo,
      version,
      tag,
      platform,
      arch,
      sha256,
      size,
    });
    const fragmentPath = path.join(manifestsDir, `daemon-target-${platform}-${arch}.json`);
    fs.writeFileSync(fragmentPath, `${JSON.stringify(fragment, null, 2)}\n`);

    return {
      tarballPath,
      fragmentPath,
      fragment,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function readOption(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function main(argv) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const version = readOption(argv, "--version");
  const tag = readOption(argv, "--tag") ?? (version ? `fork-v${version}` : null);
  const repo = readOption(argv, "--repo") ?? "Laokashouji/paseo";
  const outputDir = readOption(argv, "--output-dir");
  const platform = readOption(argv, "--platform") ?? process.platform;
  const arch = readOption(argv, "--arch") ?? process.arch;
  const skipBuild = argv.includes("--skip-build");
  const skipWebUi = argv.includes("--skip-web-ui");

  if (!version || !tag || !outputDir) {
    throw new Error(
      "Usage: node scripts/fork/package-daemon-release.mjs --version <X.Y.Z> --tag <fork-vX.Y.Z> --repo <owner/repo> --output-dir <dir> [--platform <linux>] [--arch <x64>] [--skip-build] [--skip-web-ui]",
    );
  }

  const result = packageDaemonRelease({
    repoRoot,
    version,
    tag,
    repo,
    outputDir: path.resolve(outputDir),
    platform,
    arch,
    skipBuild,
    skipWebUi,
  });

  process.stdout.write(
    `Packaged Fork daemon archive:\n  tarball:  ${result.tarballPath}\n  manifest: ${result.fragmentPath}\n  sha256:   ${result.fragment.target.sha256}\n  size:     ${result.fragment.target.size}\n`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
