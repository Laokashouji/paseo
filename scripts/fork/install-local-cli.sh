#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BIN_DIR="${HOME}/.local/bin"
STATE_DIR="${HOME}/.local/share/paseo-fork"
FORK_WRAPPER="${BIN_DIR}/paseo-fork"
DEFAULT_BIN="${BIN_DIR}/paseo"
BACKUP_FILE="${STATE_DIR}/official-paseo-target"

DO_INSTALL_DEPS=false
SWITCH_DEFAULT=false
RESTORE_OFFICIAL=false

usage() {
  cat <<'EOF'
Usage: ./scripts/fork/install-local-cli.sh [options]

Build Paseo CLI + daemon from this local fork checkout (ideal for Linux DevBox)
and install a side-by-side "paseo-fork" executable under ~/.local/bin.

Options:
  --install-deps      Run "npm ci" before building (auto-run if node_modules missing)
  --switch-default    Point ~/.local/bin/paseo to the fork build (backs up original symlink)
  --restore-official  Restore ~/.local/bin/paseo to its backed-up official npm target
  -h, --help          Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --install-deps)
      DO_INSTALL_DEPS=true
      shift
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

mkdir -p "$BIN_DIR" "$STATE_DIR"

if [[ "$RESTORE_OFFICIAL" == "true" ]]; then
  if [[ ! -f "$BACKUP_FILE" ]]; then
    echo "Error: no backed-up official paseo target found at $BACKUP_FILE" >&2
    exit 1
  fi
  ORIG_TARGET="$(cat "$BACKUP_FILE")"
  ln -sfn "$ORIG_TARGET" "$DEFAULT_BIN"
  echo "Restored $DEFAULT_BIN -> $ORIG_TARGET"
  "$DEFAULT_BIN" --version || true
  echo "Note: run 'paseo daemon restart' when ready to switch the running daemon."
  exit 0
fi

if [[ "$DO_INSTALL_DEPS" == "true" || ! -d "$REPO_ROOT/node_modules" ]]; then
  echo "==> Installing workspace dependencies (npm ci)..."
  ONNXRUNTIME_NODE_INSTALL=skip node scripts/npm-retry.mjs ci
fi

echo "==> Building @getpaseo/server and @getpaseo/cli from local fork..."
npm run build:server

cat > "$FORK_WRAPPER" <<EOF
#!/usr/bin/env bash
exec "${REPO_ROOT}/packages/cli/bin/paseo" "\$@"
EOF
chmod 0755 "$FORK_WRAPPER"

echo "==> Installed side-by-side CLI wrapper: $FORK_WRAPPER"
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
  echo "Note: running daemon was NOT restarted automatically. Restart manually with:"
  echo "  paseo daemon restart"
  echo "To revert to official npm Paseo anytime:"
  echo "  ./scripts/fork/install-local-cli.sh --restore-official"
fi
