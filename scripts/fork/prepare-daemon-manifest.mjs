import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const STABLE_SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const SAFE_ASSET_RE = /^[A-Za-z0-9._-]+$/;

function validateTargetEntry(filePath, target) {
  if (!target || typeof target !== "object") {
    throw new Error(`${filePath}: missing target object`);
  }
  if (typeof target.asset !== "string" || !SAFE_ASSET_RE.test(target.asset)) {
    throw new Error(`${filePath}: invalid target.asset "${String(target.asset)}"`);
  }
  if (typeof target.url !== "string" || !target.url.startsWith("https://")) {
    throw new Error(`${filePath}: invalid target.url "${String(target.url)}"`);
  }
  if (typeof target.sha256 !== "string" || !SHA256_RE.test(target.sha256)) {
    throw new Error(`${filePath}: invalid target.sha256 "${String(target.sha256)}"`);
  }
  if (typeof target.size !== "number" || !Number.isInteger(target.size) || target.size <= 0) {
    throw new Error(`${filePath}: invalid target.size "${String(target.size)}"`);
  }
  return {
    asset: target.asset,
    url: target.url,
    sha256: target.sha256.toLowerCase(),
    size: target.size,
  };
}

function parseTargetFragment(filePath, { expectedRepo, expectedTag, expectedVersion }) {
  const doc = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!doc || typeof doc !== "object") {
    throw new Error(`${filePath}: target fragment did not parse to an object`);
  }
  if (doc.schemaVersion !== 1) {
    throw new Error(`${filePath}: unsupported schemaVersion ${String(doc.schemaVersion)}`);
  }

  const repo = typeof doc.repo === "string" ? doc.repo.trim() : "";
  const tag = typeof doc.tag === "string" ? doc.tag.trim() : "";
  const version = typeof doc.version === "string" ? doc.version.trim() : "";
  const targetKey = typeof doc.targetKey === "string" ? doc.targetKey.trim() : "";
  if (!repo || !tag || !STABLE_SEMVER_RE.test(version) || !targetKey) {
    throw new Error(`${filePath}: missing or invalid repo/tag/version/targetKey`);
  }

  if (expectedRepo && repo !== expectedRepo) {
    throw new Error(`${filePath}: repo=${repo}, expected ${expectedRepo}`);
  }
  if (expectedTag && tag !== expectedTag) {
    throw new Error(`${filePath}: tag=${tag}, expected ${expectedTag}`);
  }
  if (expectedVersion && version !== expectedVersion) {
    throw new Error(`${filePath}: version=${version}, expected ${expectedVersion}`);
  }

  return {
    repo,
    tag,
    version,
    targetKey,
    target: validateTargetEntry(filePath, doc.target),
  };
}

export function assembleDaemonManifest({
  inputPaths,
  outputPath,
  releaseDate,
  expectedVersion = null,
  expectedTag = null,
  expectedRepo = null,
}) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error("assembleDaemonManifest requires at least one input target fragment path");
  }
  if (!releaseDate || typeof releaseDate !== "string") {
    throw new Error("assembleDaemonManifest requires an ISO releaseDate string");
  }

  let header = null;
  const targets = {};

  for (const filePath of inputPaths) {
    const parsed = parseTargetFragment(filePath, { expectedRepo, expectedTag, expectedVersion });
    if (header === null) {
      header = { repo: parsed.repo, tag: parsed.tag, version: parsed.version };
    } else if (
      header.repo !== parsed.repo ||
      header.tag !== parsed.tag ||
      header.version !== parsed.version
    ) {
      throw new Error(
        `${filePath}: metadata mismatch (${parsed.repo}@${parsed.tag}/${parsed.version} vs ${header.repo}@${header.tag}/${header.version})`,
      );
    }
    if (Object.hasOwn(targets, parsed.targetKey)) {
      throw new Error(`${filePath}: duplicate targetKey "${parsed.targetKey}"`);
    }
    targets[parsed.targetKey] = parsed.target;
  }

  const sortedTargets = Object.fromEntries(
    Object.keys(targets)
      .sort()
      .map((key) => [key, targets[key]]),
  );

  const manifest = {
    schemaVersion: 1,
    repo: header.repo,
    tag: header.tag,
    version: header.version,
    releaseDate,
    targets: sortedTargets,
  };

  const rendered = `${JSON.stringify(manifest, null, 2)}\n`;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, rendered, "utf8");
  }
  return rendered;
}

function main(argv) {
  const inputPaths = [];
  let outputPath = null;
  let releaseDate = new Date().toISOString();
  let expectedVersion = null;
  let expectedTag = null;
  let expectedRepo = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") {
      inputPaths.push(argv[++i]);
    } else if (arg === "--output") {
      outputPath = argv[++i];
    } else if (arg === "--release-date") {
      releaseDate = argv[++i];
    } else if (arg === "--expected-version") {
      expectedVersion = argv[++i];
    } else if (arg === "--expected-tag") {
      expectedTag = argv[++i];
    } else if (arg === "--expected-repo") {
      expectedRepo = argv[++i];
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!outputPath) {
    throw new Error(
      "Usage: node scripts/fork/prepare-daemon-manifest.mjs --input <fragment.json> [--input ...] --output <latest-daemon.json> [--release-date <iso>] [--expected-version <X.Y.Z>] [--expected-tag <fork-vX.Y.Z>] [--expected-repo <owner/repo>]",
    );
  }

  assembleDaemonManifest({
    inputPaths,
    outputPath,
    releaseDate,
    expectedVersion,
    expectedTag,
    expectedRepo,
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2));
}
