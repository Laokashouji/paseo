#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BOOKMARK="fork"
REMOTE="origin"
EXPLICIT_VERSION=""
DO_PUSH=false
SKIP_SECRET_CHECK=false
ALLOW_MISSING_CHANGELOG=false

usage() {
  cat <<'EOF'
Usage: ./scripts/fork/release.sh [options]

Cut a signed Paseo Fork desktop release by pushing the fork bookmark and a
monotonic "fork-vX.Y.Z" tag to GitHub (triggering .github/workflows/fork-release.yml).

By default this script runs in DRY-RUN mode and makes no changes. Pass --push
to actually create the git tag and push to GitHub.

Options:
  --push                      Create git tag and push bookmark + tag to origin
  --version <X.Y.Z>           Override computed version (must be stable semver X.Y.Z)
  --bookmark <name>           Bookmark to release (default: fork)
  --remote <name>             Git remote to push to (default: origin)
  --skip-secret-check         Skip checking required Apple GitHub Secrets via gh
  --allow-missing-changelog   Allow --push even if FORK_CHANGELOG.md has no entry for the next version
  -h, --help                  Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push)
      DO_PUSH=true
      shift
      ;;
    --version)
      EXPLICIT_VERSION="${2:?missing value for --version}"
      shift 2
      ;;
    --bookmark)
      BOOKMARK="${2:?missing value for --bookmark}"
      shift 2
      ;;
    --remote)
      REMOTE="${2:?missing value for --remote}"
      shift 2
      ;;
    --skip-secret-check)
      SKIP_SECRET_CHECK=true
      shift
      ;;
    --allow-missing-changelog)
      ALLOW_MISSING_CHANGELOG=true
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

for cmd in jj git node; do
  command -v "$cmd" >/dev/null 2>&1 || {
    echo "Error: $cmd not found in PATH." >&2
    exit 1
  }
done

FORK_SHA="$(jj log -r "present($BOOKMARK)" --no-graph -T 'commit_id')"
if [[ -z "$FORK_SHA" ]]; then
  echo "Error: jj bookmark '$BOOKMARK' does not exist." >&2
  exit 1
fi

# Block release if any ancestor of the fork bookmark has unresolved conflicts.
CONFLICTS="$(jj log -r "conflicts() & ::$BOOKMARK" --no-graph -T 'change_id.short() ++ " " ++ description.first_line() ++ "\n"' | sed '/^$/d' || true)"
if [[ -n "$CONFLICTS" ]]; then
  echo "Error: unresolved conflicts exist in ::$BOOKMARK:" >&2
  echo "$CONFLICTS" >&2
  exit 1
fi

# Warn if current working copy has non-empty changes not included in $BOOKMARK.
UNINCLUDED="$(jj log -r "@ & ~empty() & ~::$BOOKMARK" --no-graph -T 'change_id.short() ++ " " ++ description.first_line() ++ "\n"' | sed '/^$/d' || true)"
if [[ -n "$UNINCLUDED" ]]; then
  echo "Error: current working copy (@) has non-empty changes not included in bookmark '$BOOKMARK':" >&2
  echo "  $UNINCLUDED" >&2
  echo "Move '$BOOKMARK' (jj bookmark set $BOOKMARK -r @) or clean up '@' before releasing." >&2
  exit 1
fi

# Read existing fork-v* tags from both local and remote so revision never collides.
EXISTING_TAGS="$(
  {
    git tag -l 'fork-v*'
    git ls-remote --tags "$REMOTE" 'refs/tags/fork-v*' 2>/dev/null \
      | awk '{print $2}' \
      | sed 's#^refs/tags/##; s#\^{}$##'
  } | sort -u
)"

UPSTREAM_PKG_VERSION="$(git show "${FORK_SHA}:package.json" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).version)')"

NEXT_ARGS=(scripts/fork/version-utils.mjs next --upstream-version "$UPSTREAM_PKG_VERSION" --tags-stdin)
if [[ -n "$EXPLICIT_VERSION" ]]; then
  NEXT_ARGS+=(--explicit-version "$EXPLICIT_VERSION")
fi

NEXT_JSON="$(printf '%s\n' "$EXISTING_TAGS" | node "${NEXT_ARGS[@]}")"
NEXT_VERSION="$(printf '%s' "$NEXT_JSON" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).version)')"
NEXT_TAG="$(printf '%s' "$NEXT_JSON" | node -e 'console.log(JSON.parse(require("node:fs").readFileSync(0,"utf8")).tag)')"

if printf '%s\n' "$EXISTING_TAGS" | grep -Fxq "$NEXT_TAG"; then
  echo "Error: tag '$NEXT_TAG' already exists locally or on '$REMOTE'." >&2
  exit 1
fi

# Determine GitHub owner/repo from remote URL for secret verification.
REMOTE_URL="$(git remote get-url "$REMOTE")"
GH_REPO="$(printf '%s' "$REMOTE_URL" | sed -E 's#^(https://github\.com/|git@github\.com:)##; s#\.git$##')"

echo "=== Paseo Fork Release Plan ==="
echo "  Repository      : $GH_REPO ($REMOTE)"
echo "  Bookmark        : $BOOKMARK -> ${FORK_SHA:0:12}"
echo "  Upstream base   : $UPSTREAM_PKG_VERSION"
echo "  Fork version    : $NEXT_VERSION"
echo "  Release tag     : $NEXT_TAG"
echo ""
echo "Commits above trunk():"
jj log -r "trunk()..$BOOKMARK" --limit 30

# Verify FORK_CHANGELOG.md in the target bookmark contains an entry for NEXT_VERSION.
CHANGELOG_MISSING=false
FORK_CHANGELOG_CONTENT="$(git show "${FORK_SHA}:FORK_CHANGELOG.md" 2>/dev/null || true)"
CHANGELOG_CHECK_JSON=""
if [[ -n "$FORK_CHANGELOG_CONTENT" ]] &&
  CHANGELOG_CHECK_JSON="$(printf '%s' "$FORK_CHANGELOG_CONTENT" | node scripts/fork/changelog-utils.mjs check --version "$NEXT_VERSION" --stdin 2>/dev/null)"; then
  echo ""
  echo "Fork changelog entry verified (FORK_CHANGELOG.md -> ${NEXT_VERSION}):"
  printf '%s' "$CHANGELOG_CHECK_JSON" | node -e '
    const data = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const header = data.entry.date ? `## ${data.entry.version} - ${data.entry.date}` : `## ${data.entry.version}`;
    console.log(`  ${header}`);
    for (const line of data.entry.bodyLines) {
      console.log(`  ${line}`);
    }
  '
else
  CHANGELOG_MISSING=true
  PREV_FORK_TAG="$(git tag --merged "$FORK_SHA" -l 'fork-v*' --sort=-version:refname | grep -Fxv "$NEXT_TAG" | head -n 1 || true)"
  if [[ -n "$PREV_FORK_TAG" ]]; then
    DRAFT_COMMITS="$(git log --no-merges --format='%s' "${PREV_FORK_TAG}..${FORK_SHA}" 2>/dev/null || true)"
  else
    DRAFT_COMMITS="$(jj log -r "trunk()..$BOOKMARK" --no-graph -T 'description.first_line() ++ "\n"' 2>/dev/null || true)"
  fi
  TODAY_UTC="$(date -u +%Y-%m-%d)"
  DRAFT_ENTRY="$(printf '%s\n' "$DRAFT_COMMITS" | node scripts/fork/changelog-utils.mjs draft --version "$NEXT_VERSION" --date "$TODAY_UTC" --commits-stdin)"

  echo ""
  echo "WARNING: FORK_CHANGELOG.md in '$BOOKMARK' has no entry for version $NEXT_VERSION."
  echo "         Add an entry before pushing so the in-app What's New dialog and GitHub Release show your changes."
  echo ""
  echo "Suggested FORK_CHANGELOG.md entry draft:"
  printf '%s\n' "$DRAFT_ENTRY" | sed 's/^/  /'
fi

if [[ "$CHANGELOG_MISSING" == "true" && "$DO_PUSH" == "true" && "$ALLOW_MISSING_CHANGELOG" != "true" ]]; then
  echo "Aborting --push because FORK_CHANGELOG.md is missing an entry for $NEXT_VERSION (pass --allow-missing-changelog to override)." >&2
  exit 1
fi

if [[ "$SKIP_SECRET_CHECK" != "true" ]] && command -v gh >/dev/null 2>&1; then
  SECRETS="$(gh secret list --repo "$GH_REPO" 2>/dev/null | awk '{print $1}' || true)"
  has_secret() {
    printf '%s\n' "$SECRETS" | grep -Fxq "$1"
  }

  MISSING=()
  has_secret APPLE_CERTIFICATE || MISSING+=(APPLE_CERTIFICATE)
  has_secret APPLE_CERTIFICATE_PASSWORD || MISSING+=(APPLE_CERTIFICATE_PASSWORD)

  NOTARIZE_MODE=""
  if has_secret APPLE_API_KEY && has_secret APPLE_API_KEY_ID && has_secret APPLE_API_ISSUER; then
    NOTARIZE_MODE="App Store Connect API Key"
  elif has_secret APPLE_ID && has_secret APPLE_PASSWORD && has_secret APPLE_TEAM_ID; then
    NOTARIZE_MODE="Apple ID"
  else
    if has_secret APPLE_API_KEY || has_secret APPLE_API_KEY_ID || has_secret APPLE_API_ISSUER; then
      has_secret APPLE_API_KEY || MISSING+=(APPLE_API_KEY)
      has_secret APPLE_API_KEY_ID || MISSING+=(APPLE_API_KEY_ID)
      has_secret APPLE_API_ISSUER || MISSING+=(APPLE_API_ISSUER)
    elif has_secret APPLE_ID || has_secret APPLE_PASSWORD; then
      has_secret APPLE_ID || MISSING+=(APPLE_ID)
      has_secret APPLE_PASSWORD || MISSING+=(APPLE_PASSWORD)
      has_secret APPLE_TEAM_ID || MISSING+=(APPLE_TEAM_ID)
    else
      MISSING+=("notarization credentials (APPLE_API_KEY+APPLE_API_KEY_ID+APPLE_API_ISSUER or APPLE_ID+APPLE_PASSWORD+APPLE_TEAM_ID)")
    fi
  fi

  if (( ${#MISSING[@]} > 0 )); then
    echo ""
    echo "WARNING: Missing GitHub Secrets on $GH_REPO: ${MISSING[*]}"
    echo "         Run ./scripts/fork/setup-apple-secrets.sh before pushing a signed release."
    if [[ "$DO_PUSH" == "true" ]]; then
      echo "Aborting --push (pass --skip-secret-check to override)." >&2
      exit 1
    fi
  else
    echo ""
    echo "Apple signing secrets verified on $GH_REPO (notarization: $NOTARIZE_MODE)."
  fi
fi

if [[ "$DO_PUSH" != "true" ]]; then
  echo ""
  echo "[dry-run] No tag created and nothing pushed."
  echo "To cut and publish this release, run:"
  echo "  ./scripts/fork/release.sh --push --version $NEXT_VERSION"
  exit 0
fi

echo ""
echo "==> Pushing bookmark '$BOOKMARK' to '$REMOTE'..."
jj git push --remote "$REMOTE" --bookmark "$BOOKMARK"

echo "==> Creating and pushing tag '$NEXT_TAG' at ${FORK_SHA:0:12}..."
git tag -a "$NEXT_TAG" "$FORK_SHA" -m "Paseo Fork $NEXT_TAG (upstream base $UPSTREAM_PKG_VERSION)"
git push "$REMOTE" "refs/tags/$NEXT_TAG"

echo ""
echo "==> Release tag '$NEXT_TAG' pushed! Monitor GitHub Actions with:"
echo "  gh run list --repo $GH_REPO --workflow fork-release.yml --limit 5"
echo "  gh run watch --repo $GH_REPO"
