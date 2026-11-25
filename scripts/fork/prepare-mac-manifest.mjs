import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Matches upstream scripts/merge-mac-manifest.mjs (Darwin 22 = macOS 13 Ventura).
export const MACOS_MINIMUM_DARWIN_VERSION = "22.0.0";

function loadJsYaml() {
  const require = createRequire(import.meta.url);
  const candidates = ["js-yaml"];
  const extraPaths = (process.env.NODE_PATH ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const dir of extraPaths) {
    candidates.push(path.join(dir, "js-yaml"));
  }

  let lastError = null;
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      lastError = error;
    }
  }

  throw new Error(
    `Unable to load js-yaml (checked standard resolution and NODE_PATH): ${lastError?.message ?? lastError}`,
  );
}

function collectManifestFiles(parsedManifests, version) {
  const files = [];
  const seenUrls = new Set();
  for (const { filePath, doc } of parsedManifests) {
    if (doc.version !== version) {
      throw new Error(`${filePath}: version mismatch (${doc.version} vs ${version})`);
    }
    if (!Array.isArray(doc.files) || doc.files.length === 0) {
      throw new Error(`${filePath}: missing non-empty files array`);
    }
    for (const entry of doc.files) {
      if (!entry || typeof entry.url !== "string" || !entry.url) {
        throw new Error(`${filePath}: file entry missing url`);
      }
      if (typeof entry.sha512 !== "string" || !entry.sha512) {
        throw new Error(`${filePath}: file entry "${entry.url}" missing sha512`);
      }
      if (typeof entry.size !== "number" || !Number.isFinite(entry.size) || entry.size <= 0) {
        throw new Error(`${filePath}: file entry "${entry.url}" has invalid size ${entry.size}`);
      }
      if (!seenUrls.has(entry.url)) {
        seenUrls.add(entry.url);
        files.push(entry);
      }
    }
  }

  return files;
}

function manifestVersion({ doc, filePath }, expectedVersion) {
  const version = typeof doc.version === "string" ? doc.version.trim() : "";
  if (!version) {
    throw new Error(`${filePath}: missing or invalid version`);
  }
  if (expectedVersion && version !== expectedVersion) {
    throw new Error(`${filePath}: version=${version}, expected ${expectedVersion}`);
  }

  return version;
}

export function assembleMacManifest({
  inputPaths,
  outputPath,
  releaseDate,
  rolloutHours = 0,
  expectedVersion = null,
}) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) {
    throw new Error("assembleMacManifest requires at least one input manifest path");
  }
  if (!releaseDate || typeof releaseDate !== "string") {
    throw new Error("assembleMacManifest requires an ISO releaseDate string");
  }
  if (!Number.isFinite(rolloutHours) || rolloutHours < 0) {
    throw new Error(`rolloutHours must be a non-negative number, got ${rolloutHours}`);
  }

  const { load, dump } = loadJsYaml();
  const parsedManifests = inputPaths.map((filePath) => {
    const raw = fs.readFileSync(filePath, "utf8");
    const doc = load(raw);
    if (!doc || typeof doc !== "object") {
      throw new Error(`${filePath}: manifest did not parse to an object`);
    }
    return { filePath, doc };
  });

  const primary = parsedManifests[0].doc;
  const version = manifestVersion(parsedManifests[0], expectedVersion);
  const files = collectManifestFiles(parsedManifests, version);

  const merged = {
    ...primary,
    version,
    files,
    minimumSystemVersion: MACOS_MINIMUM_DARWIN_VERSION,
    releaseDate,
    rolloutHours,
  };

  if (typeof merged.path !== "string" || merged.path.length === 0) {
    throw new Error("Merged manifest is missing top-level path");
  }
  if (typeof merged.sha512 !== "string" || merged.sha512.length === 0) {
    throw new Error("Merged manifest is missing top-level sha512");
  }

  const yamlText = dump(merged, { lineWidth: -1, noRefs: true });

  // Round-trip validation so malformed YAML can never be uploaded.
  const roundTripped = load(yamlText);
  if (roundTripped.version !== version) {
    throw new Error(`Round-trip validation failed: version=${roundTripped.version}`);
  }
  if (roundTripped.minimumSystemVersion !== MACOS_MINIMUM_DARWIN_VERSION) {
    throw new Error(
      `Round-trip validation failed: minimumSystemVersion=${roundTripped.minimumSystemVersion}`,
    );
  }
  if (roundTripped.releaseDate !== releaseDate) {
    throw new Error(`Round-trip validation failed: releaseDate=${roundTripped.releaseDate}`);
  }
  if (roundTripped.rolloutHours !== rolloutHours) {
    throw new Error(`Round-trip validation failed: rolloutHours=${roundTripped.rolloutHours}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, yamlText);
  return yamlText;
}

function parseArgs(argv) {
  const inputPaths = [];
  let outputPath = "";
  let releaseDate = new Date().toISOString();
  let rolloutHours = 0;
  let expectedVersion = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") {
      inputPaths.push(argv[++i]);
    } else if (arg === "--output") {
      outputPath = argv[++i];
    } else if (arg === "--release-date") {
      releaseDate = argv[++i];
    } else if (arg === "--rollout-hours") {
      rolloutHours = Number(argv[++i]);
    } else if (arg === "--expected-version") {
      expectedVersion = argv[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (inputPaths.length === 0 || !outputPath) {
    throw new Error(
      "Usage: node scripts/fork/prepare-mac-manifest.mjs --input <yml> [--input <yml>] --output <out.yml> [--release-date <iso>] [--rollout-hours <n>] [--expected-version <ver>]",
    );
  }

  return { inputPaths, outputPath, releaseDate, rolloutHours, expectedVersion };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = parseArgs(process.argv.slice(2));
  assembleMacManifest(args);
}
