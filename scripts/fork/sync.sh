#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BASE_REV="main@upstream"
BOOKMARK="fork"
DO_FETCH=true
AUTO_RESOLVE=false
DRY_RUN=false
ALL_MUTABLE=false

usage() {
  cat <<'EOF'
Usage: ./scripts/fork/sync.sh [options]

Fetch upstream (getpaseo/paseo) and rebase the fork stack via jj + mergiraf.

Options:
  --base <rev>       Target upstream revision (default: main@upstream; e.g. v0.16.2)
  --bookmark <name>  Tip bookmark of the fork stack (default: fork)
  --all-mutable      Rebase all mutable roots (not just ancestors of --bookmark)
  --no-fetch         Skip fetching upstream before rebasing
  --auto-resolve     Run "jj resolve --tool mergiraf" on conflicted revisions after rebase
  --dry-run          Fetch and show what would be rebased without modifying commits
  -h, --help         Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      BASE_REV="${2:?missing value for --base}"
      shift 2
      ;;
    --bookmark)
      BOOKMARK="${2:?missing value for --bookmark}"
      shift 2
      ;;
    --all-mutable)
      ALL_MUTABLE=true
      shift
      ;;
    --no-fetch)
      DO_FETCH=false
      shift
      ;;
    --auto-resolve)
      AUTO_RESOLVE=true
      shift
      ;;
    --dry-run)
      DRY_RUN=true
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

command -v jj >/dev/null 2>&1 || {
  echo "Error: jj not found in PATH." >&2
  exit 1
}

if [[ "$DO_FETCH" == "true" ]]; then
  echo "==> Fetching upstream (main + tags)..."
  jj git fetch --remote upstream
fi

# Verify target base rev exists in jj
BASE_SUMMARY="$(jj log -r "$BASE_REV" --no-graph -T 'commit_id.short(10) ++ " " ++ description.first_line()')"
if [[ -z "$BASE_SUMMARY" ]]; then
  echo "Error: target base revision '$BASE_REV' not found." >&2
  exit 1
fi
echo "==> Target base ($BASE_REV): $BASE_SUMMARY"

if [[ "$ALL_MUTABLE" == "true" ]]; then
  ROOTS_REVSET="roots(mutable())"
  STACK_REVSET="mutable()"
else
  HAS_BOOKMARK="$(jj log -r "present($BOOKMARK)" --no-graph -T 'change_id.short()')"
  if [[ -n "$HAS_BOOKMARK" ]]; then
    ROOTS_REVSET="roots(mutable() & ::present($BOOKMARK))"
    STACK_REVSET="mutable() & ::present($BOOKMARK)"
  else
    ROOTS_REVSET="roots(mutable() & ::@)"
    STACK_REVSET="mutable() & ::@"
  fi
fi

ROOT_COUNT="$(jj log -r "$ROOTS_REVSET" --no-graph -T 'change_id.short() ++ "\n"' | sed '/^$/d' | wc -l | tr -d ' ')"
if [[ "$ROOT_COUNT" == "0" ]]; then
  echo "No mutable fork commits found for revset '$ROOTS_REVSET'. Nothing to rebase."
  exit 0
fi

echo "==> Fork commits to rebase ($ROOT_COUNT root branch(es)):"
jj log -r "$STACK_REVSET" --limit 50

# Check if already based on target
NEEDS_REBASE="$(jj log -r "parents($ROOTS_REVSET) ~ ($BASE_REV)" --no-graph -T 'commit_id.short() ++ "\n"' | sed '/^$/d' || true)"
if [[ -z "$NEEDS_REBASE" ]]; then
  echo "==> Fork stack is already based directly on $BASE_REV."
  exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "==> [dry-run] Would run: jj rebase -s '$ROOTS_REVSET' -d '$BASE_REV'"
  exit 0
fi

echo "==> Rebasing onto $BASE_REV (use 'jj undo' anytime to revert)..."
jj rebase -s "$ROOTS_REVSET" -d "$BASE_REV"

CONFLICTED="$(jj log -r "conflicts() & mutable()" --no-graph -T 'change_id.short() ++ "\n"' | sed '/^$/d' || true)"
if [[ -n "$CONFLICTED" && "$AUTO_RESOLVE" == "true" ]]; then
  if command -v mergiraf >/dev/null 2>&1; then
    echo "==> Attempting syntax-aware auto-resolution with mergiraf..."
    while IFS= read -r cid; do
      [[ -n "$cid" ]] || continue
      echo "  -> Resolving $cid with mergiraf..."
      jj resolve --tool mergiraf -r "$cid" || true
    done <<< "$CONFLICTED"
    CONFLICTED="$(jj log -r "conflicts() & mutable()" --no-graph -T 'change_id.short() ++ "\n"' | sed '/^$/d' || true)"
  else
    echo "Warning: mergiraf not found in PATH; skipping --auto-resolve." >&2
  fi
fi

echo "==> Updated fork stack:"
jj log -r "($BASE_REV) | ($STACK_REVSET)" --limit 50

if [[ -n "$CONFLICTED" ]]; then
  echo ""
  echo "WARNING: Unresolved conflicts remain in:"
  jj log -r "conflicts() & mutable()" --no-graph -T '"  - " ++ change_id.short() ++ " " ++ description.first_line() ++ "\n"'
  echo ""
  echo "Resolve them with:"
  echo "  jj edit <change_id>"
  echo "  jj resolve --tool mergiraf   # or edit conflict markers directly"
  echo "  jj st"
  exit 1
fi

echo "==> Sync complete with zero conflicts."
