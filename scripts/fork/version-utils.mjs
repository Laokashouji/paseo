import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_VERSION_RE =
  /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:-(?<prerelease>[0-9A-Za-z.-]+))?$/;
const STABLE_SEMVER_RE = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/;
const FORK_TAG_RE = /^fork-v(?<version>\d+\.\d+\.\d+)$/;

// Fork patch encoding: 10000 + upstreamPatch * 100 + forkRev (forkRev in 1..99).
// Examples:
//   upstream 0.16.2, rev 1 -> 0.16.10201
//   upstream 0.17.0-beta.1, rev 1 -> 0.17.10001
//   upstream 0.17.0, rev 2 -> 0.17.10002
//   upstream 0.17.1, rev 1 -> 0.17.10101
// Strictly monotonic across fork rebuilds and upstream releases, valid stable SemVer
// (compatible with electron-updater's default "latest" channel and plugin checks),
// and visually distinct from upstream patch numbers.
export const FORK_PATCH_BASE = 10_000;
export const FORK_PATCH_STRIDE = 100;
export const MAX_FORK_REV = 99;

export function parseUpstreamVersion(rawVersion) {
  const trimmed = String(rawVersion ?? "").trim();
  const match = trimmed.match(UPSTREAM_VERSION_RE);
  if (!match?.groups) {
    throw new Error(
      `Unsupported upstream version "${rawVersion}". Expected semver like 0.16.2 or 0.17.0-beta.1.`,
    );
  }
  const major = Number.parseInt(match.groups.major, 10);
  const minor = Number.parseInt(match.groups.minor, 10);
  const patch = Number.parseInt(match.groups.patch, 10);
  const prerelease = match.groups.prerelease ?? null;
  return {
    version: trimmed,
    major,
    minor,
    patch,
    prerelease,
    baseVersion: `${major}.${minor}.${patch}`,
  };
}

export function parseForkTag(rawTag) {
  const trimmed = String(rawTag ?? "")
    .trim()
    .replace(/^refs\/tags\//, "");
  const match = trimmed.match(FORK_TAG_RE);
  if (!match?.groups?.version) {
    throw new Error(
      `Unsupported fork tag "${rawTag}". Expected "fork-vX.Y.Z" (e.g. fork-v0.17.10001).`,
    );
  }
  return {
    sourceTag: trimmed,
    releaseTag: trimmed,
    version: match.groups.version,
    releaseType: "release",
    releaseChannel: "latest",
  };
}

export function decodeForkPatch(patch) {
  if (!Number.isInteger(patch) || patch < FORK_PATCH_BASE + 1) {
    return null;
  }
  const offset = patch - FORK_PATCH_BASE;
  const upstreamPatch = Math.floor(offset / FORK_PATCH_STRIDE);
  const forkRev = offset % FORK_PATCH_STRIDE;
  if (forkRev < 1 || forkRev > MAX_FORK_REV) {
    return null;
  }
  return { upstreamPatch, forkRev };
}

export function computeNextForkVersion({
  upstreamVersion,
  existingTags = [],
  explicitVersion = null,
}) {
  const upstream = parseUpstreamVersion(upstreamVersion);

  if (explicitVersion) {
    const trimmed = explicitVersion.trim().replace(/^v/, "");
    if (!STABLE_SEMVER_RE.test(trimmed)) {
      throw new Error(
        `Invalid explicit fork version "${explicitVersion}". Expected stable semver X.Y.Z without prerelease.`,
      );
    }
    return {
      version: trimmed,
      tag: `fork-v${trimmed}`,
      upstreamBase: upstream.baseVersion,
      forkRev: null,
    };
  }

  let maxRev = 0;
  for (const rawTag of existingTags) {
    let parsed;
    try {
      parsed = parseForkTag(rawTag);
    } catch {
      continue;
    }
    const parts = parsed.version.split(".").map((segment) => Number.parseInt(segment, 10));
    if (parts[0] !== upstream.major || parts[1] !== upstream.minor) {
      continue;
    }
    const decoded = decodeForkPatch(parts[2]);
    if (decoded && decoded.upstreamPatch === upstream.patch && decoded.forkRev > maxRev) {
      maxRev = decoded.forkRev;
    }
  }

  const nextRev = maxRev + 1;
  if (nextRev > MAX_FORK_REV) {
    throw new Error(
      `Fork revision overflow for upstream ${upstream.baseVersion}: max ${MAX_FORK_REV} revisions per upstream patch.`,
    );
  }

  const forkPatch = FORK_PATCH_BASE + upstream.patch * FORK_PATCH_STRIDE + nextRev;
  const version = `${upstream.major}.${upstream.minor}.${forkPatch}`;
  return {
    version,
    tag: `fork-v${version}`,
    upstreamBase: upstream.baseVersion,
    forkRev: nextRev,
  };
}

export function applyWorkspaceVersion(repoRoot, version) {
  const trimmed = String(version ?? "").trim();
  if (!STABLE_SEMVER_RE.test(trimmed)) {
    throw new Error(`Invalid version "${version}". Expected stable semver X.Y.Z.`);
  }

  const rootPkgPath = path.join(repoRoot, "package.json");
  const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
  rootPkg.version = trimmed;
  fs.writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);

  const syncScript = path.join(repoRoot, "scripts", "sync-workspace-versions.mjs");
  if (!fs.existsSync(syncScript)) {
    throw new Error(`Missing upstream workspace sync script: ${syncScript}`);
  }

  const result = spawnSync(process.execPath, [syncScript], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `sync-workspace-versions.mjs failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function readOption(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function main(argv) {
  const [command, ...rest] = argv;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

  if (command === "emit-env") {
    const tag = readOption(rest, "--tag");
    if (!tag) {
      throw new Error("Usage: node scripts/fork/version-utils.mjs emit-env --tag <fork-vX.Y.Z>");
    }
    const info = parseForkTag(tag);
    const lines = [
      `SOURCE_TAG=${info.sourceTag}`,
      `RELEASE_TAG=${info.releaseTag}`,
      `FORK_VERSION=${info.version}`,
      `DESKTOP_VERSION=${info.version}`,
      `RELEASE_TYPE=${info.releaseType}`,
      `RELEASE_CHANNEL=${info.releaseChannel}`,
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  if (command === "next") {
    const rootPkgPath = path.join(repoRoot, "package.json");
    const defaultUpstream = fs.existsSync(rootPkgPath)
      ? JSON.parse(fs.readFileSync(rootPkgPath, "utf8")).version
      : null;
    const upstreamVersion = readOption(rest, "--upstream-version") ?? defaultUpstream;
    const explicitVersion = readOption(rest, "--explicit-version");
    const format = readOption(rest, "--format") ?? "json";
    const readTagsFromStdin = rest.includes("--tags-stdin");

    const existingTags = readTagsFromStdin
      ? fs
          .readFileSync(0, "utf8")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      : [];

    const computed = computeNextForkVersion({
      upstreamVersion,
      existingTags,
      explicitVersion,
    });

    if (format === "tag") {
      process.stdout.write(`${computed.tag}\n`);
    } else if (format === "version") {
      process.stdout.write(`${computed.version}\n`);
    } else {
      process.stdout.write(`${JSON.stringify(computed, null, 2)}\n`);
    }
    return;
  }

  if (command === "apply") {
    const version = readOption(rest, "--version");
    if (!version) {
      throw new Error("Usage: node scripts/fork/version-utils.mjs apply --version <X.Y.Z>");
    }
    const output = applyWorkspaceVersion(repoRoot, version);
    if (output) process.stdout.write(output);
    return;
  }

  throw new Error(
    "Usage: node scripts/fork/version-utils.mjs <emit-env|next|apply> [options]",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
