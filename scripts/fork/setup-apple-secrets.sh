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
IOS_P12_PATH=""
IOS_P12_PASSWORD=""
IOS_BUNDLE_ID_ARG=""
IOS_PROFILE_PATH=""
IOS_APP_NAME_ARG=""
IOS_URL_SCHEME_ARG=""
IOS_EXPO_PROJECT_ID_ARG=""
IOS_EXPO_OWNER_ARG=""
IOS_TESTFLIGHT_GROUPS_ARG=""
CHECK_ONLY=false
CHECK_IOS_ONLY=false
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

IOS_REQUIRED_SECRETS=(
  IOS_DIST_CERTIFICATE
  IOS_DIST_CERTIFICATE_PASSWORD
  IOS_BUNDLE_ID
  APPLE_TEAM_ID
)

IOS_OPTIONAL_SECRETS=(
  IOS_PROVISIONING_PROFILE
  IOS_APP_NAME
  IOS_URL_SCHEME
  IOS_EXPO_PROJECT_ID
  IOS_EXPO_OWNER
  IOS_TESTFLIGHT_GROUPS
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
  --repo <owner/repo>              Target GitHub repo (default: inferred from origin)
  --check                          Check configured macOS and iOS TestFlight secrets
  --check-ios                      Exit non-zero unless iOS TestFlight secrets are complete
  --p12 <path>                     Path to exported "Developer ID Application" .p12 (macOS)
  --p8 <path>                      Path to App Store Connect API Key .p8 file
  --key-id <id>                    App Store Connect API Key ID (APPLE_API_KEY_ID)
  --issuer <uuid>                  App Store Connect Issuer ID (APPLE_API_ISSUER)
  --team-id <id>                   Apple Developer 10-char Team ID (APPLE_TEAM_ID)
  --ios-p12 <path>                 Path to exported "Apple Distribution" .p12 (iOS TestFlight)
  --ios-p12-password <pw>          Password for iOS Distribution .p12 (omit to prompt interactively)
  --ios-bundle-id <id>             Personal iOS Bundle ID (e.g. com.laokashouji.paseo)
  --ios-profile <path>             Optional manual .mobileprovision (auto-managed via ASC API if omitted)
  --ios-app-name <name>            Optional iOS display name (default: "Paseo Fork")
  --ios-url-scheme <scheme>        Optional iOS URL scheme (default: "paseo-fork")
  --ios-expo-project-id <uuid>     Optional personal EAS projectId for native APNs push
  --ios-expo-owner <owner>         Optional personal Expo account owner
  --ios-testflight-groups <csv>    Optional comma-separated TestFlight beta group names
  --non-interactive                Only upload values passed via flags, do not prompt
  --disable-upstream-workflows     Disable inherited upstream workflows on the fork
  -h, --help                       Show this help message
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
    --check-ios)
      CHECK_ONLY=true
      CHECK_IOS_ONLY=true
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
    --ios-p12)
      IOS_P12_PATH="${2:?missing value for --ios-p12}"
      shift 2
      ;;
    --ios-p12-password)
      IOS_P12_PASSWORD="${2:?missing value for --ios-p12-password}"
      shift 2
      ;;
    --ios-bundle-id)
      IOS_BUNDLE_ID_ARG="${2:?missing value for --ios-bundle-id}"
      shift 2
      ;;
    --ios-profile)
      IOS_PROFILE_PATH="${2:?missing value for --ios-profile}"
      shift 2
      ;;
    --ios-app-name)
      IOS_APP_NAME_ARG="${2:?missing value for --ios-app-name}"
      shift 2
      ;;
    --ios-url-scheme)
      IOS_URL_SCHEME_ARG="${2:?missing value for --ios-url-scheme}"
      shift 2
      ;;
    --ios-expo-project-id)
      IOS_EXPO_PROJECT_ID_ARG="${2:?missing value for --ios-expo-project-id}"
      shift 2
      ;;
    --ios-expo-owner)
      IOS_EXPO_OWNER_ARG="${2:?missing value for --ios-expo-owner}"
      shift 2
      ;;
    --ios-testflight-groups)
      IOS_TESTFLIGHT_GROUPS_ARG="${2:?missing value for --ios-testflight-groups}"
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
EXISTING_VARS="$(gh variable list --repo "$GH_REPO" 2>/dev/null | awk '{print $1}' || true)"

has_secret() {
  printf '%s\n' "$EXISTING_SECRETS" | grep -Fxq "$1"
}

has_secret_or_var() {
  has_secret "$1" || printf '%s\n' "$EXISTING_VARS" | grep -Fxq "$1"
}

echo "=== Apple Signing & Notarization Secrets on ${GH_REPO} ==="
SIGNING_MISSING=()
echo "macOS Desktop code signing (required):"
for key in "${SIGNING_SECRETS[@]}"; do
  if has_secret "$key"; then
    echo "  [OK]      $key"
  else
    echo "  [MISSING] $key"
    SIGNING_MISSING+=("$key")
  fi
done

API_KEY_COMPLETE=true
echo "App Store Connect API Key (recommended for macOS notarization & iOS TestFlight):"
for key in "${API_KEY_SECRETS[@]}"; do
  if has_secret "$key"; then
    echo "  [OK]      $key"
  else
    echo "  [MISSING] $key"
    API_KEY_COMPLETE=false
  fi
done

APPLE_ID_COMPLETE=true
echo "macOS Notarization Option 2 — Apple ID + App-Specific Password (alternative):"
for key in "${APPLE_ID_SECRETS[@]}"; do
  if has_secret "$key"; then
    echo "  [OK]      $key"
  else
    echo "  [MISSING] $key"
    APPLE_ID_COMPLETE=false
  fi
done

IOS_MISSING=()
echo "iOS TestFlight signing (optional; enables automatic build-ios job):"
for key in "${IOS_REQUIRED_SECRETS[@]}"; do
  if [[ "$key" == "IOS_BUNDLE_ID" ]]; then
    if has_secret_or_var "$key"; then
      echo "  [OK]      $key"
    else
      echo "  [MISSING] $key"
      IOS_MISSING+=("$key")
    fi
  else
    if has_secret "$key"; then
      echo "  [OK]      $key"
    else
      echo "  [MISSING] $key"
      IOS_MISSING+=("$key")
    fi
  fi
done
if [[ "$API_KEY_COMPLETE" != "true" ]]; then
  IOS_MISSING+=("APPLE_API_KEY+APPLE_API_KEY_ID+APPLE_API_ISSUER")
fi
for key in "${IOS_OPTIONAL_SECRETS[@]}"; do
  if has_secret_or_var "$key"; then
    echo "  [OK]      $key (optional)"
  else
    echo "  [UNSET]   $key (optional)"
  fi
done

READY=true
if (( ${#SIGNING_MISSING[@]} > 0 )); then
  READY=false
fi
if [[ "$API_KEY_COMPLETE" != "true" && "$APPLE_ID_COMPLETE" != "true" ]]; then
  READY=false
fi

IOS_READY=true
if (( ${#IOS_MISSING[@]} > 0 )); then
  IOS_READY=false
fi

if [[ "$CHECK_ONLY" == "true" ]]; then
  echo ""
  if [[ "$READY" == "true" ]]; then
    if [[ "$API_KEY_COMPLETE" == "true" ]]; then
      echo "macOS Status: READY (signing + App Store Connect API Key notarization)."
    else
      echo "macOS Status: READY (signing + Apple ID notarization)."
    fi
  else
    echo "macOS Status: INCOMPLETE (need signing secrets + at least one complete notarization option)."
  fi

  if [[ "$IOS_READY" == "true" ]]; then
    echo "iOS TestFlight Status: READY (Apple Distribution + ASC API Key + Bundle ID)."
  else
    echo "iOS TestFlight Status: NOT CONFIGURED (missing: ${IOS_MISSING[*]})."
  fi

  if [[ "$CHECK_IOS_ONLY" == "true" ]]; then
    [[ "$IOS_READY" == "true" ]] && exit 0 || exit 1
  fi
  [[ "$READY" == "true" ]] && exit 0 || exit 1
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

if [[ -n "$IOS_P12_PATH" ]]; then
  if [[ ! -f "$IOS_P12_PATH" ]]; then
    echo "Error: file not found: $IOS_P12_PATH" >&2
    exit 1
  fi
  echo "==> Uploading IOS_DIST_CERTIFICATE from $IOS_P12_PATH (base64, single line)..."
  base64 < "$IOS_P12_PATH" | tr -d '\r\n' | gh secret set IOS_DIST_CERTIFICATE --repo "$GH_REPO"
fi

if [[ -n "$IOS_P12_PASSWORD" ]]; then
  printf '%s' "$IOS_P12_PASSWORD" | gh secret set IOS_DIST_CERTIFICATE_PASSWORD --repo "$GH_REPO"
fi

if [[ -n "$IOS_BUNDLE_ID_ARG" ]]; then
  printf '%s' "$IOS_BUNDLE_ID_ARG" | gh secret set IOS_BUNDLE_ID --repo "$GH_REPO"
fi

if [[ -n "$IOS_PROFILE_PATH" ]]; then
  if [[ ! -f "$IOS_PROFILE_PATH" ]]; then
    echo "Error: file not found: $IOS_PROFILE_PATH" >&2
    exit 1
  fi
  echo "==> Uploading IOS_PROVISIONING_PROFILE from $IOS_PROFILE_PATH (base64, single line)..."
  base64 < "$IOS_PROFILE_PATH" | tr -d '\r\n' | gh secret set IOS_PROVISIONING_PROFILE --repo "$GH_REPO"
fi

if [[ -n "$IOS_APP_NAME_ARG" ]]; then
  printf '%s' "$IOS_APP_NAME_ARG" | gh secret set IOS_APP_NAME --repo "$GH_REPO"
fi

if [[ -n "$IOS_URL_SCHEME_ARG" ]]; then
  printf '%s' "$IOS_URL_SCHEME_ARG" | gh secret set IOS_URL_SCHEME --repo "$GH_REPO"
fi

if [[ -n "$IOS_EXPO_PROJECT_ID_ARG" ]]; then
  printf '%s' "$IOS_EXPO_PROJECT_ID_ARG" | gh secret set IOS_EXPO_PROJECT_ID --repo "$GH_REPO"
fi

if [[ -n "$IOS_EXPO_OWNER_ARG" ]]; then
  printf '%s' "$IOS_EXPO_OWNER_ARG" | gh secret set IOS_EXPO_OWNER --repo "$GH_REPO"
fi

if [[ -n "$IOS_TESTFLIGHT_GROUPS_ARG" ]]; then
  printf '%s' "$IOS_TESTFLIGHT_GROUPS_ARG" | gh secret set IOS_TESTFLIGHT_GROUPS --repo "$GH_REPO"
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

  if [[ -z "$IOS_P12_PATH" ]]; then
    read -rp "Path to Apple Distribution .p12 for iOS TestFlight (empty to skip): " IOS_P12_PATH
    if [[ -n "$IOS_P12_PATH" ]]; then
      if [[ ! -f "$IOS_P12_PATH" ]]; then
        echo "Error: file not found: $IOS_P12_PATH" >&2
        exit 1
      fi
      echo "==> Uploading IOS_DIST_CERTIFICATE from $IOS_P12_PATH (base64, single line)..."
      base64 < "$IOS_P12_PATH" | tr -d '\r\n' | gh secret set IOS_DIST_CERTIFICATE --repo "$GH_REPO"
    fi
  fi

  if [[ -z "$IOS_P12_PASSWORD" ]]; then
    read -rsp "IOS_DIST_CERTIFICATE_PASSWORD (iOS .p12 password, empty to skip): " IOS_CERT_PW
    echo ""
    if [[ -n "$IOS_CERT_PW" ]]; then
      printf '%s' "$IOS_CERT_PW" | gh secret set IOS_DIST_CERTIFICATE_PASSWORD --repo "$GH_REPO"
    fi
  fi

  if [[ -z "$IOS_BUNDLE_ID_ARG" ]]; then
    read -rp "IOS_BUNDLE_ID (personal iOS Bundle ID e.g. com.laokashouji.paseo, empty to skip): " IOS_BID
    if [[ -n "$IOS_BID" ]]; then
      printf '%s' "$IOS_BID" | gh secret set IOS_BUNDLE_ID --repo "$GH_REPO"
    fi
  fi
fi

echo ""
echo "==> Final secret status:"
"$0" --repo "$GH_REPO" --check || true
