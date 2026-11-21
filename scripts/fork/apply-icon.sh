#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOURCE_PNG="${REPO_ROOT}/packages/desktop/assets/icon-dev.png"
ASSETS_DIR="${REPO_ROOT}/packages/desktop/assets"

usage() {
  cat <<'EOF'
Usage: ./scripts/fork/apply-icon.sh [options]

Ephemerally replace desktop icon assets (icon.icns and resized PNGs) using a
source PNG before packaging on macOS. Defaults to packages/desktop/assets/icon-dev.png
(the built-in blueprint blue Paseo icon) so fork builds stay visually distinct
from official Paseo without modifying upstream-tracked files in git.

Options:
  --source <path>      Source square PNG path (default: packages/desktop/assets/icon-dev.png)
  --assets-dir <dir>   Target desktop assets dir (default: packages/desktop/assets)
  -h, --help           Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source)
      SOURCE_PNG="${2:?missing value for --source}"
      shift 2
      ;;
    --assets-dir)
      ASSETS_DIR="${2:?missing value for --assets-dir}"
      shift 2
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

for cmd in sips iconutil; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Error: '$cmd' not found in PATH. This script must run on macOS." >&2
    exit 1
  }
done

if [[ ! -f "$SOURCE_PNG" ]]; then
  echo "Error: source icon not found: $SOURCE_PNG" >&2
  exit 1
fi

if [[ ! -d "$ASSETS_DIR" ]]; then
  echo "Error: desktop assets directory not found: $ASSETS_DIR" >&2
  exit 1
fi

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "unknown"
  fi
}

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

iconset_dir="${work_dir}/Paseo.iconset"
mkdir -p "$iconset_dir"

# Generate each distinct icon size once with macOS sips, preserving RGBA alpha.
for size in 16 32 64 128 256 512 1024; do
  sips -s format png -z "$size" "$size" "$SOURCE_PNG" --out "${work_dir}/icon_${size}.png" >/dev/null
done

# Populate all 10 standard Apple .iconset slots required by iconutil.
cp "${work_dir}/icon_16.png"   "${iconset_dir}/icon_16x16.png"
cp "${work_dir}/icon_32.png"   "${iconset_dir}/icon_16x16@2x.png"
cp "${work_dir}/icon_32.png"   "${iconset_dir}/icon_32x32.png"
cp "${work_dir}/icon_64.png"   "${iconset_dir}/icon_32x32@2x.png"
cp "${work_dir}/icon_128.png"  "${iconset_dir}/icon_128x128.png"
cp "${work_dir}/icon_256.png"  "${iconset_dir}/icon_128x128@2x.png"
cp "${work_dir}/icon_256.png"  "${iconset_dir}/icon_256x256.png"
cp "${work_dir}/icon_512.png"  "${iconset_dir}/icon_256x256@2x.png"
cp "${work_dir}/icon_512.png"  "${iconset_dir}/icon_512x512.png"
cp "${work_dir}/icon_1024.png" "${iconset_dir}/icon_512x512@2x.png"

tmp_icns="${work_dir}/icon.icns"
iconutil -c icns "$iconset_dir" -o "$tmp_icns"

# Verify generated file starts with the 4-byte ICNS magic header ("icns" = 69636e73).
magic_hex="$(od -An -tx1 -N4 "$tmp_icns" | tr -d ' \n')"
if [[ ! -s "$tmp_icns" || "$magic_hex" != "69636e73" ]]; then
  echo "Error: iconutil did not produce a valid ICNS file (magic=$magic_hex)" >&2
  exit 1
fi

cp "$tmp_icns" "${ASSETS_DIR}/icon.icns"
cp "${work_dir}/icon_512.png" "${ASSETS_DIR}/icon.png"

# Keep companion PNG sizes in sync when present in assets dir.
for pair in "32x32.png:32" "64x64.png:64" "128x128.png:128" "128x128@2x.png:256"; do
  target_name="${pair%%:*}"
  src_size="${pair#*:}"
  if [[ -f "${ASSETS_DIR}/${target_name}" ]]; then
    cp "${work_dir}/icon_${src_size}.png" "${ASSETS_DIR}/${target_name}"
  fi
done

echo "Applied fork desktop icon from: $SOURCE_PNG"
echo "  icon.icns sha256: $(sha256_file "${ASSETS_DIR}/icon.icns")"
echo "  icon.png  sha256: $(sha256_file "${ASSETS_DIR}/icon.png")"
