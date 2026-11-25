#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

FORK_VERSION=""
OUTPUT_DIR="${REPO_ROOT}/release-ios"
SHOULD_UPLOAD=false
SKIP_APP_DEPS=false
SYNC_TESTFLIGHT=true
IOS_BUNDLE_ID="${IOS_BUNDLE_ID:-}"
IOS_APP_NAME="${IOS_APP_NAME:-Paseo Fork}"
IOS_URL_SCHEME="${IOS_URL_SCHEME:-paseo-fork}"
IOS_BUILD_NUMBER="${IOS_BUILD_NUMBER:-}"
IOS_EXPO_PROJECT_ID="${IOS_EXPO_PROJECT_ID:-}"
IOS_EXPO_OWNER="${IOS_EXPO_OWNER:-}"
IOS_TESTFLIGHT_GROUPS="${IOS_TESTFLIGHT_GROUPS:-}"
APPLE_TEAM_ID="${APPLE_TEAM_ID:-}"
APPLE_API_KEY_ID="${APPLE_API_KEY_ID:-}"
APPLE_API_ISSUER="${APPLE_API_ISSUER:-}"
APPLE_API_KEY="${APPLE_API_KEY:-}"
IOS_DIST_CERTIFICATE="${IOS_DIST_CERTIFICATE:-}"
IOS_DIST_CERTIFICATE_PASSWORD="${IOS_DIST_CERTIFICATE_PASSWORD:-}"
IOS_PROVISIONING_PROFILE="${IOS_PROVISIONING_PROFILE:-}"

usage() {
  cat <<'EOF'
Usage: ./scripts/fork/build-ios-ipa.sh [options]

Build, sign, verify, and optionally upload a personal Fork iOS TestFlight .ipa
on macOS without modifying upstream-tracked files in git.

Required environment variables:
  APPLE_TEAM_ID                   10-char Apple Developer Team ID
  IOS_BUNDLE_ID                   Personal reverse-DNS Bundle ID (not sh.paseo)
  IOS_DIST_CERTIFICATE            Apple Distribution .p12 (base64 single line)
  IOS_DIST_CERTIFICATE_PASSWORD   .p12 export password
  APPLE_API_KEY                   App Store Connect API Key .p8 (PEM or base64)
  APPLE_API_KEY_ID                App Store Connect API Key ID
  APPLE_API_ISSUER                App Store Connect Issuer UUID

Optional environment variables:
  IOS_PROVISIONING_PROFILE        Manual base64 .mobileprovision (auto-managed via ASC API if omitted)
  IOS_APP_NAME                    Display name on iPhone home screen (default: "Paseo Fork")
  IOS_URL_SCHEME                  Custom URL scheme (default: "paseo-fork")
  IOS_BUILD_NUMBER                Explicit CFBundleVersion override (auto collision-checked if omitted)
  IOS_EXPO_PROJECT_ID             Personal EAS projectId to enable native APNs push tokens
  IOS_EXPO_OWNER                  Personal Expo account owner
  IOS_TESTFLIGHT_GROUPS           Comma-separated TestFlight group names to attach after upload

Options:
  --version <X.Y.Z>               Fork version (default: packages/app/package.json version)
  --output-dir <dir>              Directory for exported .ipa and build logs (default: ./release-ios)
  --upload                        Upload signed .ipa to App Store Connect / TestFlight
  --no-sync-testflight            Skip post-upload TestFlight changelog / group sync
  --skip-app-deps                 Skip npm run build:app-deps if already built
  -h, --help                      Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      FORK_VERSION="${2:?missing value for --version}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:?missing value for --output-dir}"
      shift 2
      ;;
    --upload)
      SHOULD_UPLOAD=true
      shift
      ;;
    --no-sync-testflight)
      SYNC_TESTFLIGHT=false
      shift
      ;;
    --skip-app-deps)
      SKIP_APP_DEPS=true
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

for cmd in node npm xcodebuild security openssl plutil /usr/libexec/PlistBuddy pod; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Error: '$cmd' is required on macOS to build iOS .ipa." >&2
    exit 1
  }
done

if [[ -z "$FORK_VERSION" ]]; then
  FORK_VERSION="$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync("packages/app/package.json", "utf8")).version)')"
fi

missing_vars=()
[[ -n "$APPLE_TEAM_ID" ]] || missing_vars+=(APPLE_TEAM_ID)
[[ -n "$IOS_BUNDLE_ID" ]] || missing_vars+=(IOS_BUNDLE_ID)
[[ -n "$IOS_DIST_CERTIFICATE" ]] || missing_vars+=(IOS_DIST_CERTIFICATE)
[[ -n "$IOS_DIST_CERTIFICATE_PASSWORD" ]] || missing_vars+=(IOS_DIST_CERTIFICATE_PASSWORD)
if [[ -z "$IOS_PROVISIONING_PROFILE" || "$SHOULD_UPLOAD" == "true" ]]; then
  [[ -n "$APPLE_API_KEY" ]] || missing_vars+=(APPLE_API_KEY)
  [[ -n "$APPLE_API_KEY_ID" ]] || missing_vars+=(APPLE_API_KEY_ID)
  [[ -n "$APPLE_API_ISSUER" ]] || missing_vars+=(APPLE_API_ISSUER)
fi

if (( ${#missing_vars[@]} > 0 )); then
  echo "Error: missing required environment variables for iOS signing/upload: ${missing_vars[*]}" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
WORK_DIR="$(mktemp -d)"
KEYCHAIN_PATH="${WORK_DIR}/fork-ios-build.keychain-db"
KEYCHAIN_PASS="$(openssl rand -hex 24)"
ORIG_KEYCHAINS=()
while IFS= read -r kc; do
  kc="${kc#"${kc%%[![:space:]]*}"}"
  kc="${kc%\"}"
  kc="${kc#\"}"
  [[ -n "$kc" ]] && ORIG_KEYCHAINS+=("$kc")
done < <(security list-keychains -d user)

ASC_PRIVATE_KEY_INSTALLED=""

cleanup() {
  local exit_code=$?
  if [[ -n "$ASC_PRIVATE_KEY_INSTALLED" && -f "$ASC_PRIVATE_KEY_INSTALLED" ]]; then
    rm -f "$ASC_PRIVATE_KEY_INSTALLED"
  fi
  if [[ -f "$KEYCHAIN_PATH" ]]; then
    if (( ${#ORIG_KEYCHAINS[@]} > 0 )); then
      security list-keychains -d user -s "${ORIG_KEYCHAINS[@]}" >/dev/null 2>&1 || true
    fi
    security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  fi
  # Always restore ephemeral app.config.js wrapper if local developer ran this script.
  node "${REPO_ROOT}/scripts/fork/prepare-ios-config.mjs" --restore >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR"
  exit "$exit_code"
}
trap cleanup EXIT

echo "=== Fork iOS TestFlight Build ==="
echo "  Version    : ${FORK_VERSION}"
echo "  Bundle ID  : ${IOS_BUNDLE_ID}"
echo "  App Name   : ${IOS_APP_NAME}"
echo "  URL Scheme : ${IOS_URL_SCHEME}"
echo "  Team ID    : ${APPLE_TEAM_ID}"
echo "  Upload     : ${SHOULD_UPLOAD}"
echo "  Xcode      : $(xcodebuild -version | tr '\n' ' ')"
echo "  CocoaPods  : $(pod --version)"

# 1. Decode Apple Distribution .p12 into an isolated temporary keychain.
P12_FILE="${WORK_DIR}/ios-dist.p12"
printf '%s' "$IOS_DIST_CERTIFICATE" | tr -d '\r\n' | base64 --decode > "$P12_FILE"
chmod 600 "$P12_FILE"

security create-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 3600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASS" "$KEYCHAIN_PATH"
security import "$P12_FILE" \
  -k "$KEYCHAIN_PATH" \
  -P "$IOS_DIST_CERTIFICATE_PASSWORD" \
  -T /usr/bin/codesign \
  -T /usr/bin/security \
  -T /usr/bin/xcodebuild \
  >/dev/null
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASS" "$KEYCHAIN_PATH" >/dev/null
security list-keychains -d user -s "$KEYCHAIN_PATH" "${ORIG_KEYCHAINS[@]}"

SIGNING_IDENTITY="$(
  security find-identity -v -p codesigning "$KEYCHAIN_PATH" \
    | sed -nE 's/^[[:space:]]*[0-9]+\) [0-9A-F]{40} "([^"]+)".*/\1/p' \
    | head -n 1
)"
if [[ -z "$SIGNING_IDENTITY" ]]; then
  echo "Error: no valid codesigning identity found inside IOS_DIST_CERTIFICATE." >&2
  security find-identity -v -p codesigning "$KEYCHAIN_PATH" >&2 || true
  exit 1
fi
echo "  Signing ID : ${SIGNING_IDENTITY}"

# Extract certificate serial number (fallback to -legacy for OpenSSL 3 + legacy RC2 .p12 exports).
extract_cert_pem() {
  if openssl pkcs12 -in "$P12_FILE" -nokeys -clcerts -passin env:IOS_DIST_CERTIFICATE_PASSWORD 2>/dev/null; then
    return 0
  fi
  openssl pkcs12 -legacy -in "$P12_FILE" -nokeys -clcerts -passin env:IOS_DIST_CERTIFICATE_PASSWORD 2>/dev/null
}
CERT_SERIAL="$(extract_cert_pem | openssl x509 -noout -serial | sed 's/^serial=//I')"
if [[ -z "$CERT_SERIAL" ]]; then
  echo "Error: failed to extract certificate serial number from IOS_DIST_CERTIFICATE." >&2
  exit 1
fi
echo "  Cert Serial: ${CERT_SERIAL}"

# 2. Obtain & install IOS_APP_STORE provisioning profile (manual override or ASC API auto-sync).
PROFILES_DIR="${HOME}/Library/MobileDevice/Provisioning Profiles"
mkdir -p "$PROFILES_DIR"
PROFILE_FILE="${WORK_DIR}/profile.mobileprovision"
PROFILE_JSON=""
APP_APPLE_ID=""

if [[ -n "$IOS_PROVISIONING_PROFILE" ]]; then
  echo "==> Using manual IOS_PROVISIONING_PROFILE..."
  printf '%s' "$IOS_PROVISIONING_PROFILE" | tr -d '\r\n' | base64 --decode > "$PROFILE_FILE"
  PROFILE_JSON="$(node scripts/fork/ios-asc-api.mjs inspect-profile --profile-file "$PROFILE_FILE")"
  PROFILE_UUID="$(printf '%s' "$PROFILE_JSON" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).uuid)')"
  cp "$PROFILE_FILE" "${PROFILES_DIR}/${PROFILE_UUID}.mobileprovision"
else
  echo "==> Syncing IOS_APP_STORE provisioning profile via App Store Connect API..."
  PROFILE_JSON="$(
    APPLE_API_KEY="$APPLE_API_KEY" \
    APPLE_API_KEY_ID="$APPLE_API_KEY_ID" \
    APPLE_API_ISSUER="$APPLE_API_ISSUER" \
    node scripts/fork/ios-asc-api.mjs ensure-profile \
      --bundle-id "$IOS_BUNDLE_ID" \
      --cert-serial "$CERT_SERIAL" \
      --output "$PROFILE_FILE" \
      --install-dir "$PROFILES_DIR"
  )"
fi

PROFILE_UUID="$(printf '%s' "$PROFILE_JSON" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).uuid)')"
PROFILE_NAME="$(printf '%s' "$PROFILE_JSON" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).name)')"
PROFILE_TEAM_ID="$(printf '%s' "$PROFILE_JSON" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).teamId)')"
PROFILE_BUNDLE_ID="$(printf '%s' "$PROFILE_JSON" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).bundleId ?? "")')"
PROFILE_APS_ENV="$(printf '%s' "$PROFILE_JSON" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).apsEnvironment)')"
APP_APPLE_ID="$(printf '%s' "$PROFILE_JSON" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).appAppleId ?? "")')"

echo "  Profile    : ${PROFILE_NAME} (${PROFILE_UUID})"
echo "  APS Env    : ${PROFILE_APS_ENV}"

if [[ "$PROFILE_TEAM_ID" != "$APPLE_TEAM_ID" ]]; then
  echo "Error: provisioning profile Team ID (${PROFILE_TEAM_ID}) does not match APPLE_TEAM_ID (${APPLE_TEAM_ID})." >&2
  exit 1
fi
if [[ "$PROFILE_BUNDLE_ID" != "$IOS_BUNDLE_ID" ]]; then
  echo "Error: provisioning profile Bundle ID (${PROFILE_BUNDLE_ID}) does not match IOS_BUNDLE_ID (${IOS_BUNDLE_ID})." >&2
  exit 1
fi

# 3. Compute collision-free CFBundleVersion (checks ASC when API key is configured).
BASE_BUILD_NUMBER="$(
  node -e '
    const { getNativeReleaseVersion } = require("./packages/app/native-release-version.js");
    console.log(getNativeReleaseVersion(process.argv[1]).iosBuildNumber);
  ' "$FORK_VERSION"
)"

RESOLVED_BUILD_NUMBER="$BASE_BUILD_NUMBER"
if [[ -n "$IOS_BUILD_NUMBER" ]]; then
  RESOLVED_BUILD_NUMBER="$IOS_BUILD_NUMBER"
elif [[ -n "$APPLE_API_KEY" && -n "$APPLE_API_KEY_ID" && -n "$APPLE_API_ISSUER" ]]; then
  if BUILD_RESOLVE_JSON="$(
    APPLE_API_KEY="$APPLE_API_KEY" \
    APPLE_API_KEY_ID="$APPLE_API_KEY_ID" \
    APPLE_API_ISSUER="$APPLE_API_ISSUER" \
    node scripts/fork/ios-asc-api.mjs resolve-build \
      --bundle-id "$IOS_BUNDLE_ID" \
      --app-version "$FORK_VERSION" \
      --base-build-number "$BASE_BUILD_NUMBER" 2>/dev/null
  )"; then
    RESOLVED_BUILD_NUMBER="$(printf '%s' "$BUILD_RESOLVE_JSON" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).nextBuildNumber)')"
    APP_APPLE_ID="$(printf '%s' "$BUILD_RESOLVE_JSON" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).appAppleId ?? "")')"
  elif [[ "$SHOULD_UPLOAD" == "true" ]]; then
    echo "Error: failed to resolve App Store Connect app record for ${IOS_BUNDLE_ID}. Ensure the app exists in App Store Connect -> Apps." >&2
    exit 1
  fi
fi
echo "  Build Num  : ${RESOLVED_BUILD_NUMBER} (base: ${BASE_BUILD_NUMBER}, ASC App ID: ${APP_APPLE_ID:-n/a})"

# 4. Ephemerally apply Fork iOS icon + Expo config overlay.
echo "==> Applying fork blueprint iOS icon (1024x1024 RGB, no alpha)..."
node scripts/fork/apply-ios-icon.mjs

echo "==> Applying ephemeral fork iOS Expo config overlay..."
CONFIG_ARGS=(
  --bundle-id "$IOS_BUNDLE_ID"
  --app-name "$IOS_APP_NAME"
  --scheme "$IOS_URL_SCHEME"
  --aps-environment "$PROFILE_APS_ENV"
  --build-number "$RESOLVED_BUILD_NUMBER"
)
if [[ -n "$IOS_EXPO_PROJECT_ID" ]]; then
  CONFIG_ARGS+=(--expo-project-id "$IOS_EXPO_PROJECT_ID")
fi
if [[ -n "$IOS_EXPO_OWNER" ]]; then
  CONFIG_ARGS+=(--expo-owner "$IOS_EXPO_OWNER")
fi
node scripts/fork/prepare-ios-config.mjs "${CONFIG_ARGS[@]}"

# 5. Build monorepo app dependencies & generate native Xcode project.
if [[ "$SKIP_APP_DEPS" != "true" ]]; then
  echo "==> Building workspace app dependencies..."
  npm run build:app-deps
fi

echo "==> Running Expo prebuild for iOS..."
(
  cd "${REPO_ROOT}/packages/app"
  APP_VARIANT=production CI=1 npx expo prebuild --platform ios --clean --no-install --non-interactive
)

echo "==> Installing CocoaPods dependencies..."
(
  cd "${REPO_ROOT}/packages/app/ios"
  LANG=en_US.UTF-8 COCOAPODS_DISABLE_STATS=1 pod install --ansi
)

# 6. Discover generated Xcode workspace/project/scheme and patch manual signing on the main target only.
WORKSPACE_PATH="$(find "${REPO_ROOT}/packages/app/ios" -maxdepth 1 -name '*.xcworkspace' -print | head -n 1)"
XCODEPROJ_PATH="$(find "${REPO_ROOT}/packages/app/ios" -maxdepth 1 -name '*.xcodeproj' -print | head -n 1)"
if [[ -z "$WORKSPACE_PATH" || -z "$XCODEPROJ_PATH" ]]; then
  echo "Error: Expo prebuild / pod install did not generate .xcworkspace and .xcodeproj in packages/app/ios." >&2
  exit 1
fi

SCHEME_NAME="$(
  xcodebuild -list -json -workspace "$WORKSPACE_PATH" \
    | node -e '
      const data = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      const schemes = data.workspace?.schemes ?? [];
      const fallback = process.argv[1];
      const exact = schemes.find((s) => s === fallback);
      const nonPod = schemes.find((s) => !s.startsWith("Pods-") && !s.endsWith("Tests"));
      console.log(exact || nonPod || schemes[0] || "");
    ' "$(basename "$XCODEPROJ_PATH" .xcodeproj)"
)"
if [[ -z "$SCHEME_NAME" ]]; then
  echo "Error: unable to determine Xcode scheme from ${WORKSPACE_PATH}." >&2
  exit 1
fi

echo "==> Patching manual distribution signing onto main app target (scheme: ${SCHEME_NAME})..."
node scripts/fork/patch-ios-signing.mjs \
  --pbxproj "${XCODEPROJ_PATH}/project.pbxproj" \
  --team-id "$APPLE_TEAM_ID" \
  --bundle-id "$IOS_BUNDLE_ID" \
  --profile-name "$PROFILE_NAME" \
  --profile-uuid "$PROFILE_UUID" \
  --signing-identity "$SIGNING_IDENTITY"

# 7. Archive and export signed .ipa.
ARCHIVE_PATH="${WORK_DIR}/PaseoFork.xcarchive"
EXPORT_DIR="${WORK_DIR}/export"
ARCHIVE_LOG="${OUTPUT_DIR}/xcodebuild-archive.log"
EXPORT_LOG="${OUTPUT_DIR}/xcodebuild-export.log"
NODE_BIN_PATH="$(command -v node)"

echo "==> Archiving Release iOS build (full log: ${ARCHIVE_LOG})..."
set +e
APP_VARIANT=production \
CI=1 \
NODE_BINARY="$NODE_BIN_PATH" \
xcodebuild archive \
  -workspace "$WORKSPACE_PATH" \
  -scheme "$SCHEME_NAME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE_PATH" \
  COMPILER_INDEX_STORE_ENABLE=NO \
  >"$ARCHIVE_LOG" 2>&1
archive_status=$?
set -e

if [[ "$archive_status" -ne 0 ]]; then
  echo "::error::xcodebuild archive failed (exit ${archive_status}). Last 150 lines:" >&2
  tail -n 150 "$ARCHIVE_LOG" >&2
  exit "$archive_status"
fi
echo "Archive succeeded: ${ARCHIVE_PATH}"

EXPORT_OPTIONS_PLIST="${WORK_DIR}/ExportOptions.plist"
cat > "$EXPORT_OPTIONS_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>destination</key>
  <string>export</string>
  <key>method</key>
  <string>app-store-connect</string>
  <key>signingStyle</key>
  <string>manual</string>
  <key>signingCertificate</key>
  <string>Apple Distribution</string>
  <key>teamID</key>
  <string>${APPLE_TEAM_ID}</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>${IOS_BUNDLE_ID}</key>
    <string>${PROFILE_NAME}</string>
  </dict>
  <key>stripSwiftSymbols</key>
  <true/>
  <key>uploadSymbols</key>
  <true/>
</dict>
</plist>
EOF

echo "==> Exporting signed .ipa (full log: ${EXPORT_LOG})..."
set +e
xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportOptionsPlist "$EXPORT_OPTIONS_PLIST" \
  -exportPath "$EXPORT_DIR" \
  >"$EXPORT_LOG" 2>&1
export_status=$?
set -e

if [[ "$export_status" -ne 0 ]]; then
  echo "::error::xcodebuild -exportArchive failed (exit ${export_status}). Last 120 lines:" >&2
  tail -n 120 "$EXPORT_LOG" >&2
  exit "$export_status"
fi

RAW_IPA_PATH="$(find "$EXPORT_DIR" -maxdepth 1 -name '*.ipa' -print | head -n 1)"
if [[ -z "$RAW_IPA_PATH" || ! -f "$RAW_IPA_PATH" ]]; then
  echo "Error: xcodebuild -exportArchive did not produce an .ipa in ${EXPORT_DIR}." >&2
  exit 1
fi

FINAL_IPA_PATH="${OUTPUT_DIR}/PaseoFork-${FORK_VERSION}-${RESOLVED_BUILD_NUMBER}.ipa"
cp "$RAW_IPA_PATH" "$FINAL_IPA_PATH"
echo "Exported signed IPA: ${FINAL_IPA_PATH}"

# 8. Verify packaged .ipa metadata and signature.
echo "==> Verifying exported .ipa Info.plist and code signature..."
VERIFY_DIR="${WORK_DIR}/verify-ipa"
mkdir -p "$VERIFY_DIR"
unzip -q "$FINAL_IPA_PATH" -d "$VERIFY_DIR"
APP_BUNDLE_PATH="$(find "${VERIFY_DIR}/Payload" -maxdepth 1 -name '*.app' -print | head -n 1)"
if [[ -z "$APP_BUNDLE_PATH" ]]; then
  echo "Error: no Payload/*.app found inside ${FINAL_IPA_PATH}." >&2
  exit 1
fi

INFO_PLIST="${APP_BUNDLE_PATH}/Info.plist"
ACTUAL_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST")"
ACTUAL_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")"
ACTUAL_BUILD_NUM="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$INFO_PLIST")"
ACTUAL_DISPLAY_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$INFO_PLIST" 2>/dev/null || true)"
ACTUAL_EXEMPT_ENC="$(/usr/libexec/PlistBuddy -c 'Print :ITSAppUsesNonExemptEncryption' "$INFO_PLIST" 2>/dev/null || true)"

[[ "$ACTUAL_BUNDLE_ID" == "$IOS_BUNDLE_ID" ]] || {
  echo "Error: CFBundleIdentifier=${ACTUAL_BUNDLE_ID}, expected ${IOS_BUNDLE_ID}" >&2
  exit 1
}
[[ "$ACTUAL_VERSION" == "$FORK_VERSION" ]] || {
  echo "Error: CFBundleShortVersionString=${ACTUAL_VERSION}, expected ${FORK_VERSION}" >&2
  exit 1
}
[[ "$ACTUAL_BUILD_NUM" == "$RESOLVED_BUILD_NUMBER" ]] || {
  echo "Error: CFBundleVersion=${ACTUAL_BUILD_NUM}, expected ${RESOLVED_BUILD_NUMBER}" >&2
  exit 1
}
[[ "$ACTUAL_EXEMPT_ENC" == "false" ]] || {
  echo "Error: ITSAppUsesNonExemptEncryption=${ACTUAL_EXEMPT_ENC}, expected false" >&2
  exit 1
}

codesign --verify --deep --strict "$APP_BUNDLE_PATH"
echo "Verified IPA: bundleId=${ACTUAL_BUNDLE_ID}, version=${ACTUAL_VERSION} (${ACTUAL_BUILD_NUM}), displayName=${ACTUAL_DISPLAY_NAME}"

# Emit machine-readable summary JSON alongside the IPA.
node -e '
  const fs = require("node:fs");
  const [out, bundleId, version, buildNumber, displayName, apsEnvironment, appAppleId, ipaPath] = process.argv.slice(1);
  fs.writeFileSync(out, JSON.stringify({ bundleId, version, buildNumber, displayName, apsEnvironment, appAppleId, ipaPath }, null, 2) + "\n");
' "${OUTPUT_DIR}/ios-build-summary.json" \
  "$ACTUAL_BUNDLE_ID" "$ACTUAL_VERSION" "$ACTUAL_BUILD_NUM" \
  "$ACTUAL_DISPLAY_NAME" "$PROFILE_APS_ENV" "$APP_APPLE_ID" "$FINAL_IPA_PATH"

# 9. Upload to App Store Connect / TestFlight when requested.
if [[ "$SHOULD_UPLOAD" != "true" ]]; then
  echo "==> Upload skipped (--upload not passed). Signed IPA ready at ${FINAL_IPA_PATH}."
  exit 0
fi

echo "==> Uploading ${FINAL_IPA_PATH} to App Store Connect / TestFlight..."
PRIVATE_KEYS_DIR="${HOME}/.appstoreconnect/private_keys"
mkdir -p "$PRIVATE_KEYS_DIR"
ASC_PRIVATE_KEY_INSTALLED="${PRIVATE_KEYS_DIR}/AuthKey_${APPLE_API_KEY_ID}.p8"
APPLE_API_KEY="$APPLE_API_KEY" node scripts/fork/ios-asc-api.mjs write-key --output "$ASC_PRIVATE_KEY_INSTALLED"

if [[ -n "$APP_APPLE_ID" ]]; then
  xcrun altool --upload-package "$FINAL_IPA_PATH" \
    --type ios \
    --asc-public-id "$APPLE_API_ISSUER" \
    --apple-id "$APP_APPLE_ID" \
    --bundle-version "$RESOLVED_BUILD_NUMBER" \
    --bundle-short-version-string "$FORK_VERSION" \
    --bundle-id "$IOS_BUNDLE_ID" \
    --apiKey "$APPLE_API_KEY_ID" \
    --apiIssuer "$APPLE_API_ISSUER"
else
  xcrun altool --upload-app \
    --type ios \
    --file "$FINAL_IPA_PATH" \
    --apiKey "$APPLE_API_KEY_ID" \
    --apiIssuer "$APPLE_API_ISSUER"
fi

echo "==> Upload to App Store Connect succeeded!"

# 10. Best-effort sync of TestFlight What's New notes (from FORK_CHANGELOG.md) & optional beta groups.
if [[ "$SYNC_TESTFLIGHT" == "true" ]]; then
  WHATS_NEW_FILE="${WORK_DIR}/testflight-whats-new.txt"
  if [[ -f "${REPO_ROOT}/FORK_CHANGELOG.md" ]] &&
    ENTRY_JSON="$(node scripts/fork/changelog-utils.mjs check --file "${REPO_ROOT}/FORK_CHANGELOG.md" --version "$FORK_VERSION" 2>/dev/null)"; then
    printf '%s' "$ENTRY_JSON" | node -e '
      const fs = require("node:fs");
      const data = JSON.parse(fs.readFileSync(0, "utf8"));
      const lines = (data.entry?.bodyLines ?? []).filter(Boolean);
      const header = `Paseo Fork v${data.entry.version}`;
      fs.writeFileSync(process.argv[1], [header, "", ...lines].join("\n") + "\n", "utf8");
    ' "$WHATS_NEW_FILE"
  else
    printf 'Paseo Fork v%s (build %s)\n' "$FORK_VERSION" "$RESOLVED_BUILD_NUMBER" > "$WHATS_NEW_FILE"
  fi

  echo "==> Syncing TestFlight metadata (waiting up to 180s for ASC processing; non-blocking on timeout)..."
  SYNC_ARGS=(
    sync-testflight
    --bundle-id "$IOS_BUNDLE_ID"
    --app-version "$FORK_VERSION"
    --build-number "$RESOLVED_BUILD_NUMBER"
    --whats-new-file "$WHATS_NEW_FILE"
    --timeout-sec 180
    --poll-interval-sec 15
  )
  if [[ -n "$IOS_TESTFLIGHT_GROUPS" ]]; then
    SYNC_ARGS+=(--groups "$IOS_TESTFLIGHT_GROUPS")
  fi
  if ! APPLE_API_KEY="$APPLE_API_KEY" \
       APPLE_API_KEY_ID="$APPLE_API_KEY_ID" \
       APPLE_API_ISSUER="$APPLE_API_ISSUER" \
       node scripts/fork/ios-asc-api.mjs "${SYNC_ARGS[@]}"; then
    echo "::warning::IPA was uploaded to App Store Connect, but optional TestFlight metadata sync did not finish cleanly."
  fi
fi
