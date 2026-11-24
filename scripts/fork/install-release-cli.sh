#!/usr/bin/env bash
set -euo pipefail

REPO="Laokashouji/paseo"
TAG=""
FROM_TARBALL=""
SWITCH_DEFAULT=false
RESTORE_OFFICIAL=false

BIN_DIR="${HOME}/.local/bin"
RUNTIME_BASE="${PASEO_FORK_RUNTIME_BASE:-${HOME}/.local/share/paseo-fork}"
RELEASES_DIR="${RUNTIME_BASE}/releases"
CURRENT_LINK="${RUNTIME_BASE}/current"
FORK_WRAPPER="${BIN_DIR}/paseo-fork"
DEFAULT_BIN="${BIN_DIR}/paseo"
BACKUP_FILE="${RUNTIME_BASE}/official-paseo-target"

usage() {
  cat <<'EOF'
Usage: ./scripts/fork/install-release-cli.sh [options]

Install a self-updating Paseo Fork CLI + daemon runtime from GitHub Releases
(Laokashouji/paseo) into ~/.local/share/paseo-fork/releases/<version> with an
atomic "current" symlink, enabling one-click "Update daemon" inside Paseo App.

Options:
  --repo <owner/repo>    GitHub repository (default: Laokashouji/paseo)
  --tag <fork-vX.Y.Z>    Install a specific Fork release tag (default: latest)
  --from-tarball <path>  Install directly from a local daemon release tarball
  --switch-default       Point ~/.local/bin/paseo to ~/.local/bin/paseo-fork
  --restore-official     Restore ~/.local/bin/paseo to its backed-up official npm target
  -h, --help             Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      REPO="${2:?missing value for --repo}"
      shift 2
      ;;
    --tag)
      TAG="${2:?missing value for --tag}"
      shift 2
      ;;
    --from-tarball)
      FROM_TARBALL="${2:?missing value for --from-tarball}"
      shift 2
      ;;
    --switch-default)
      SWITCH_DEFAULT=true
      shift
      ;;
    --restore-official)
      RESTORE_OFFICIAL=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

mkdir -p "$BIN_DIR" "$RUNTIME_BASE" "$RELEASES_DIR"

if [[ "$RESTORE_OFFICIAL" == "true" ]]; then
  if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "Error: no backed-up official paseo target found at $BACKUP_FILE" >&2
    exit 1
  fi
  ORIG_TARGET="$(cat "$BACKUP_FILE")"
  ln -sfn "$ORIG_TARGET" "$DEFAULT_BIN"
  echo "Restored $DEFAULT_BIN -> $ORIG_TARGET"
  "$DEFAULT_BIN" --version || true
  echo "Note: restart your daemon service (e.g. 'systemctl --user restart paseo-daemon.service') to reload the official supervisor."
  exit 0
fi

for cmd in node tar; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Error: required command '$cmd' not found in PATH." >&2
    exit 1
  }
done

TMP_DIR="$(mktemp -d "${RUNTIME_BASE}/.install-XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

TARBALL_PATH=""
EXPECTED_VERSION=""

if [[ -n "$FROM_TARBALL" ]]; then
  if [[ ! -f "$FROM_TARBALL" ]]; then
    echo "Error: tarball not found: $FROM_TARBALL" >&2
    exit 1
  fi
  TARBALL_PATH="$FROM_TARBALL"
else
  PLATFORM="$(node -p 'process.platform')"
  ARCH="$(node -p 'process.arch')"
  TARGET_KEY="${PLATFORM}-${ARCH}"

  if [[ -n "$TAG" ]]; then
    MANIFEST_URL="https://github.com/${REPO}/releases/download/${TAG}/latest-daemon.json"
  else
    MANIFEST_URL="https://github.com/${REPO}/releases/latest/download/latest-daemon.json"
  fi

  echo "==> Fetching Fork daemon manifest (${MANIFEST_URL})..."
  TARBALL_PATH="${TMP_DIR}/daemon-release.tar.gz"
  EXPECTED_VERSION="$(
    node - "$MANIFEST_URL" "$TARGET_KEY" "$TARBALL_PATH" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");

const [manifestUrl, targetKey, destPath] = process.argv.slice(2);

async function run() {
  const manifestRes = await fetch(manifestUrl, {
    headers: { Accept: "application/json", "User-Agent": "paseo-fork-installer" },
    redirect: "follow",
  });
  if (manifestRes.status === 404) {
    throw new Error(
      `Manifest not found at ${manifestUrl}. Cut a Fork release that publishes latest-daemon.json first.`,
    );
  }
  if (!manifestRes.ok) {
    throw new Error(`Failed to fetch manifest (${manifestRes.status} ${manifestRes.statusText})`);
  }

  const manifest = await manifestRes.json();
  const target = manifest?.targets?.[targetKey];
  if (!target) {
    const avail = Object.keys(manifest?.targets || {}).join(", ") || "none";
    throw new Error(`Release ${manifest?.version ?? "unknown"} has no daemon build for ${targetKey} (available: ${avail})`);
  }

  process.stderr.write(`==> Downloading ${target.asset} (v${manifest.version})...\n`);
  const archiveRes = await fetch(target.url, {
    headers: { "User-Agent": "paseo-fork-installer" },
    redirect: "follow",
  });
  if (!archiveRes.ok || !archiveRes.body) {
    throw new Error(`Failed to download archive (${archiveRes.status} ${archiveRes.statusText})`);
  }

  const hash = crypto.createHash("sha256");
  const writer = fs.createWriteStream(destPath, { mode: 0o600 });
  const reader = archiveRes.body.getReader();
  let bytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    hash.update(chunk);
    bytes += chunk.byteLength;
    if (!writer.write(chunk)) {
      await new Promise((resolve, reject) => {
        writer.once("drain", resolve);
        writer.once("error", reject);
      });
    }
  }
  await new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.end(() => resolve());
  });

  if (typeof target.size === "number" && bytes !== target.size) {
    throw new Error(`Size mismatch: expected ${target.size}, got ${bytes}`);
  }
  const actualSha = hash.digest("hex").toLowerCase();
  if (actualSha !== String(target.sha256 || "").toLowerCase()) {
    throw new Error(`SHA-256 mismatch: expected ${target.sha256}, got ${actualSha}`);
  }
  process.stdout.write(String(manifest.version));
}

run().catch((err) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
NODE
  )"
fi

STAGE_DIR="${TMP_DIR}/stage"
mkdir -p "$STAGE_DIR"
tar -xzf "$TARBALL_PATH" -C "$STAGE_DIR"

VERSION="$(
  node - "$STAGE_DIR" "$EXPECTED_VERSION" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [stageDir, expected] = process.argv.slice(2);
const meta = JSON.parse(fs.readFileSync(path.join(stageDir, "fork-runtime.json"), "utf8"));
const serverPkg = JSON.parse(
  fs.readFileSync(path.join(stageDir, "node_modules", "@getpaseo", "server", "package.json"), "utf8"),
);
if (!meta.version || meta.version !== serverPkg.version) {
  throw new Error(`Metadata version (${meta.version}) != @getpaseo/server version (${serverPkg.version})`);
}
if (expected && meta.version !== expected) {
  throw new Error(`Extracted version (${meta.version}) != expected (${expected})`);
}
process.stdout.write(meta.version);
NODE
)"

TARGET_RELEASE_DIR="${RELEASES_DIR}/${VERSION}"
if [[ -e "$TARGET_RELEASE_DIR" ]]; then
  DISPLACED_DIR="${TMP_DIR}/replaced-${VERSION}"
  mv "$TARGET_RELEASE_DIR" "$DISPLACED_DIR"
fi
mv "$STAGE_DIR" "$TARGET_RELEASE_DIR"
chmod 0755 "${TARGET_RELEASE_DIR}/bin/paseo"

NEXT_LINK="${RUNTIME_BASE}/.current.next.$$"
ln -s "releases/${VERSION}" "$NEXT_LINK"
node -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' "$NEXT_LINK" "$CURRENT_LINK"

cat > "$FORK_WRAPPER" <<EOF
#!/usr/bin/env bash
exec "${CURRENT_LINK}/bin/paseo" "\$@"
EOF
chmod 0755 "$FORK_WRAPPER"

echo "==> Installed managed Fork daemon runtime: ${TARGET_RELEASE_DIR}"
echo "==> Active symlink: ${CURRENT_LINK} -> releases/${VERSION}"
echo "==> CLI wrapper:    ${FORK_WRAPPER}"
"$FORK_WRAPPER" --version

if [[ "$SWITCH_DEFAULT" == "true" ]]; then
  if [[ -L "$DEFAULT_BIN" ]]; then
    CURRENT_TARGET="$(readlink -f "$DEFAULT_BIN")"
    if [[ "$CURRENT_TARGET" != "$FORK_WRAPPER" ]]; then
      printf '%s\n' "$CURRENT_TARGET" > "$BACKUP_FILE"
      echo "Saved original paseo target to $BACKUP_FILE ($CURRENT_TARGET)"
    fi
  fi
  ln -sfn "$FORK_WRAPPER" "$DEFAULT_BIN"
  echo "==> Switched default $DEFAULT_BIN -> $FORK_WRAPPER"
  echo "Note: running daemon was NOT restarted automatically."
  echo "To switch the running supervisor onto the managed Fork runtime, run once:"
  echo "  systemctl --user restart paseo-daemon.service"
  echo "After that, future Fork updates can be applied directly with the in-app 'Update' button."
fi
