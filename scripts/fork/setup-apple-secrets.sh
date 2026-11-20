#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

REMOTE_URL="$(git remote get-url origin 2>/dev/null || echo 'https://github.com/Laokashouji/paseo.git')"
GH_REPO="$(printf '%s' "$REMOTE_URL" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"
P12_PATH=""
P8_PATH=""
API_KEY_ID=""
API_ISSUER=""
TEAM_ID_ARG=""
CHECK_ONLY=false
NON_INTERACTIVE=false
DISABLE_UPSTREAM_WORKFLOWS=false

SIGNING_SECRETS=(
  APPLE_CERTIFICATE
  APPLE_CERTIFICATE_PASSWORD
)

API_KEY_SECRETS=(
  APPLE_API_KEY
  APPLE_API_KEY_ID
  APPLE_API_ISSUER
)

APPLE_ID_SECRETS=(
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

Check or upload Apple Developer signing & notarization secrets to your fork
repository on GitHub, and optionally disable noisy upstream workflows.

Notarization supports either:
  1. App Store Connect API Key (recommended):
     APPLE_API_KEY (.p8), APPLE_API_KEY_ID, APPLE_API_ISSUER
  2. Apple ID + App-Specific Password (legacy):
     APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID

Options:
  --repo <owner/repo>           Target GitHub repo (default: inferred from origin)
  --check                       Only check which required secrets are configured
  --p12 <path>                  Path to exported "Developer ID Application" .p12 file
  --p8 <path>                   Path to App Store Connect API Key .p8 file
  --key-id <id>                 App Store Connect API Key ID (APPLE_API_KEY_ID)
  --issuer <uuid>               App Store Connect Issuer ID (APPLE_API_ISSUER)
  --team-id <id>                Apple Developer 10-char Team ID (APPLE_TEAM_ID)
  --non-interactive             Only upload values passed via flags, do not prompt
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
    --p8)
      P8_PATH="${2:?missing value for --p8}"
      shift 2
      ;;
    --key-id)
      API_KEY_ID="${2:?missing value for --key-id}"
      shift 2
      ;;
    --issuer)
      API_ISSUER="${2:?missing value for --issuer}"
      shift 2
      ;;
    --team-id)
      TEAM_ID_ARG="${2:?missing value for --team-id}"
      shift 2
      ;;
    --non-interactive)
      NON_INTERACTIVE=true
      shift
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

has_secret() {
  printf '%s\n' "$EXISTING_SECRETS" | grep -Fxq "$1"
}

echo "=== Apple Signing & Notarization Secrets on ${GH_REPO} ==="
SIGNING_MISSING=()
echo "Code signing (required):"
for key in "${SIGNING_SECRETS[@]}"; do
  if has_secret "$key"; then
    echo "  [OK]      $key"
  else
    echo "  [MISSING] $key"
    SIGNING_MISSING+=("$key")
  fi
done

API_KEY_COMPLETE=true
echo "Notarization Option 1 — App Store Connect API Key (recommended):"
for key in "${API_KEY_SECRETS[@]}"; do
  if has_secret "$key"; then
    echo "  [OK]      $key"
  else
    echo "  [MISSING] $key"
    API_KEY_COMPLETE=false
  fi
done

APPLE_ID_COMPLETE=true
echo "Notarization Option 2 — Apple ID + App-Specific Password (alternative):"
for key in "${APPLE_ID_SECRETS[@]}"; do
  if has_secret "$key"; then
    echo "  [OK]      $key"
  else
    echo "  [MISSING] $key"
    APPLE_ID_COMPLETE=false
  fi
done

READY=true
if (( ${#SIGNING_MISSING[@]} > 0 )); then
  READY=false
fi
if [[ "$API_KEY_COMPLETE" != "true" && "$APPLE_ID_COMPLETE" != "true" ]]; then
  READY=false
fi

if [[ "$CHECK_ONLY" == "true" ]]; then
  echo ""
  if [[ "$READY" == "true" ]]; then
    if [[ "$API_KEY_COMPLETE" == "true" ]]; then
      echo "Status: READY (signing + App Store Connect API Key notarization)."
    else
      echo "Status: READY (signing + Apple ID notarization)."
    fi
    exit 0
  fi
  echo "Status: INCOMPLETE (need signing secrets + at least one complete notarization option)."
  exit 1
fi

if [[ -n "$P12_PATH" ]]; then
  if [[ ! -f "$P12_PATH" ]]; then
    echo "Error: file not found: $P12_PATH" >&2
    exit 1
  fi
  echo "==> Uploading APPLE_CERTIFICATE from $P12_PATH (base64, single line)..."
  base64 < "$P12_PATH" | tr -d '\r\n' | gh secret set APPLE_CERTIFICATE --repo "$GH_REPO"
fi

if [[ -n "$P8_PATH" ]]; then
  if [[ ! -f "$P8_PATH" ]]; then
    echo "Error: file not found: $P8_PATH" >&2
    exit 1
  fi
  echo "==> Uploading APPLE_API_KEY from $P8_PATH (base64, single line)..."
  base64 < "$P8_PATH" | tr -d '\r\n' | gh secret set APPLE_API_KEY --repo "$GH_REPO"
fi

if [[ -n "$API_KEY_ID" ]]; then
  printf '%s' "$API_KEY_ID" | gh secret set APPLE_API_KEY_ID --repo "$GH_REPO"
fi

if [[ -n "$API_ISSUER" ]]; then
  printf '%s' "$API_ISSUER" | gh secret set APPLE_API_ISSUER --repo "$GH_REPO"
fi

if [[ -n "$TEAM_ID_ARG" ]]; then
  printf '%s' "$TEAM_ID_ARG" | gh secret set APPLE_TEAM_ID --repo "$GH_REPO"
fi

if [[ "$NON_INTERACTIVE" != "true" ]]; then
  echo ""
  echo "Interactive setup for ${GH_REPO} (leave any prompt empty to skip that secret)."

  if [[ -z "$P12_PATH" ]]; then
    read -rp "Path to Developer ID Application .p12 file (or empty to skip): " P12_PATH
    if [[ -n "$P12_PATH" ]]; then
      if [[ ! -f "$P12_PATH" ]]; then
        echo "Error: file not found: $P12_PATH" >&2
        exit 1
      fi
      echo "==> Uploading APPLE_CERTIFICATE from $P12_PATH (base64, single line)..."
      base64 < "$P12_PATH" | tr -d '\r\n' | gh secret set APPLE_CERTIFICATE --repo "$GH_REPO"
    fi
  fi

  read -rsp "APPLE_CERTIFICATE_PASSWORD (.p12 export password, empty to skip): " CERT_PW
  echo ""
  if [[ -n "$CERT_PW" ]]; then
    printf '%s' "$CERT_PW" | gh secret set APPLE_CERTIFICATE_PASSWORD --repo "$GH_REPO"
  fi

  if [[ -z "$P8_PATH" ]]; then
    read -rp "Path to App Store Connect API Key .p8 file (or empty to skip): " P8_PATH
    if [[ -n "$P8_PATH" ]]; then
      if [[ ! -f "$P8_PATH" ]]; then
        echo "Error: file not found: $P8_PATH" >&2
        exit 1
      fi
      echo "==> Uploading APPLE_API_KEY from $P8_PATH (base64, single line)..."
      base64 < "$P8_PATH" | tr -d '\r\n' | gh secret set APPLE_API_KEY --repo "$GH_REPO"
    fi
  fi

  if [[ -z "$API_KEY_ID" ]]; then
    read -rp "APPLE_API_KEY_ID (App Store Connect Key ID, empty to skip): " API_KEY_ID
    if [[ -n "$API_KEY_ID" ]]; then
      printf '%s' "$API_KEY_ID" | gh secret set APPLE_API_KEY_ID --repo "$GH_REPO"
    fi
  fi

  if [[ -z "$API_ISSUER" ]]; then
    read -rp "APPLE_API_ISSUER (App Store Connect Issuer UUID, empty to skip): " API_ISSUER
    if [[ -n "$API_ISSUER" ]]; then
      printf '%s' "$API_ISSUER" | gh secret set APPLE_API_ISSUER --repo "$GH_REPO"
    fi
  fi

  read -rp "APPLE_ID (Apple Developer email, only for Apple ID mode; empty to skip): " APPLE_ID_VAL
  if [[ -n "$APPLE_ID_VAL" ]]; then
    printf '%s' "$APPLE_ID_VAL" | gh secret set APPLE_ID --repo "$GH_REPO"
  fi

  read -rsp "APPLE_PASSWORD (App-Specific Password, only for Apple ID mode; empty to skip): " APPLE_PW
  echo ""
  if [[ -n "$APPLE_PW" ]]; then
    printf '%s' "$APPLE_PW" | gh secret set APPLE_PASSWORD --repo "$GH_REPO"
  fi

  if [[ -z "$TEAM_ID_ARG" ]]; then
    read -rp "APPLE_TEAM_ID (10-char Team ID, empty to skip): " TEAM_ID
    if [[ -n "$TEAM_ID" ]]; then
      printf '%s' "$TEAM_ID" | gh secret set APPLE_TEAM_ID --repo "$GH_REPO"
    fi
  fi
fi

echo ""
echo "==> Final secret status:"
"$0" --repo "$GH_REPO" --check || true
