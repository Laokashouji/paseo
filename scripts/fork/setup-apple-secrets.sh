#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

REMOTE_URL="$(git remote get-url origin 2>/dev/null || echo 'https://github.com/Laokashouji/paseo.git')"
GH_REPO="$(printf '%s' "$REMOTE_URL" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
P12_PATH=""
CHECK_ONLY=false
DISABLE_UPSTREAM_WORKFLOWS=false

REQUIRED_SECRETS=(
  APPLE_CERTIFICATE
  APPLE_CERTIFICATE_PASSWORD
  APPLE_ID
  APPLE_PASSWORD
  APPLE_TEAM_ID
)

UPSTREAM_WORKFLOWS_TO_DISABLE=(
  ci.yml
  deploy-app.yml
  deploy-relay.yml
  deploy-website.yml
  desktop-packages.yml
  desktop-release.yml
  desktop-rollout.yml
  android-apk-release.yml
  docker.yml
  nix.yml
  nix-update-hash.yml
  release-notes-sync.yml
)

usage() {
  cat <<'EOF'
Usage: ./scripts/fork/setup-apple-secrets.sh [options]

Check or upload the 5 Apple Developer signing & notarization secrets to your
fork repository on GitHub, and optionally disable noisy upstream workflows.

Options:
  --repo <owner/repo>           Target GitHub repo (default: inferred from origin)
  --check                       Only check which required secrets are configured
  --p12 <path>                  Path to exported "Developer ID Application" .p12 file
  --disable-upstream-workflows  Disable inherited upstream workflows on the fork
  -h, --help                    Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      GH_REPO="${2:?missing value for --repo}"
      shift 2
      ;;
    --check)
      CHECK_ONLY=true
      shift
      ;;
    --p12)
      P12_PATH="${2:?missing value for --p12}"
      shift 2
      ;;
    --disable-upstream-workflows)
      DISABLE_UPSTREAM_WORKFLOWS=true
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

command -v gh >/dev/null 2>&1 || {
  echo "Error: gh CLI not found in PATH." >&2
  exit 1
}

if [[ "$DISABLE_UPSTREAM_WORKFLOWS" == "true" ]]; then
  echo "==> Checking registered workflows on $GH_REPO..."
  EXISTING_WF="$(gh api "repos/${GH_REPO}/actions/workflows" --jq '.workflows[].path' 2>/dev/null || true)"
  if [[ -z "$EXISTING_WF" ]]; then
    echo "No workflows are registered on $GH_REPO yet."
    echo "If Actions on this fork have not been enabled, open:"
    echo "  https://github.com/${GH_REPO}/actions"
    echo "and click 'I understand my workflows, go ahead and enable them', then re-run this flag."
    exit 0
  fi

  for wf in "${UPSTREAM_WORKFLOWS_TO_DISABLE[@]}"; do
    if printf '%s\n' "$EXISTING_WF" | grep -Fxq ".github/workflows/${wf}"; then
      echo "  -> Disabling ${wf}..."
      gh workflow disable "$wf" --repo "$GH_REPO" || true
    fi
  done
  echo "==> Done. Fork workflow (.github/workflows/fork-release.yml) remains enabled."
  exit 0
fi

EXISTING_SECRETS="$(gh secret list --repo "$GH_REPO" | awk '{print $1}' || true)"

echo "=== Apple Signing Secrets on ${GH_REPO} ==="
MISSING=()
for key in "${REQUIRED_SECRETS[@]}"; do
  if printf '%s\n' "$EXISTING_SECRETS" | grep -Fxq "$key"; then
    echo "  [OK]      $key"
  else
    echo "  [MISSING] $key"
    MISSING+=("$key")
  fi
done

if [[ "$CHECK_ONLY" == "true" ]]; then
  if (( ${#MISSING[@]} > 0 )); then
    exit 1
  fi
  exit 0
fi

echo ""
echo "Interactive setup for ${GH_REPO} (leave any prompt empty to skip that secret)."

if [[ -z "$P12_PATH" ]]; then
  read -rp "Path to Developer ID Application .p12 file (or empty to skip): " P12_PATH
fi

if [[ -n "$P12_PATH" ]]; then
  if [[ ! -f "$P12_PATH" ]]; then
    echo "Error: file not found: $P12_PATH" >&2
    exit 1
  fi
  echo "==> Uploading APPLE_CERTIFICATE from $P12_PATH (base64, single line)..."
  base64 < "$P12_PATH" | tr -d '\r\n' | gh secret set APPLE_CERTIFICATE --repo "$GH_REPO"
fi

read -rsp "APPLE_CERTIFICATE_PASSWORD (.p12 export password, empty to skip): " CERT_PW
echo ""
if [[ -n "$CERT_PW" ]]; then
  printf '%s' "$CERT_PW" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$GH_REPO"
fi

read -rp "APPLE_ID (Apple Developer email, empty to skip): " APPLE_ID_VAL
if [[ -n "$APPLE_ID_VAL" ]]; then
  printf '%s' "$APPLE_ID_VAL" | gh secret set APPLE_ID --repo "$GH_REPO"
fi

read -rsp "APPLE_PASSWORD (App-Specific Password from account.apple.com, empty to skip): " APPLE_PW
echo ""
if [[ -n "$APPLE_PW" ]]; then
  printf '%s' "$APPLE_PW" | gh secret set APPLE_PASSWORD --repo "$GH_REPO"
fi

read -rp "APPLE_TEAM_ID (10-char Team ID from developer.apple.com/account, empty to skip): " TEAM_ID
if [[ -n "$TEAM_ID" ]]; then
  printf '%s' "$TEAM_ID" | gh secret set APPLE_TEAM_ID --repo "$GH_REPO"
fi

echo ""
echo "==> Final secret status:"
"$0" --repo "$GH_REPO" --check
