#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/release.sh <version>

Examples:
  scripts/release.sh 0.2.1
  scripts/release.sh patch
  scripts/release.sh minor

This script:
1. Verifies the git working tree is clean
2. Runs the test suite
3. Ensures you are logged into npm, prompting with `npm login` if needed
4. Runs `npm version <version>` to create the release commit and git tag
5. Pushes the commit and tag to `origin`
6. Publishes the package to npm
EOF
}

if [[ $# -ne 1 ]]; then
  usage >&2
  exit 1
fi

case "${1}" in
  -h|--help)
    usage
    exit 0
    ;;
esac

VERSION="$1"
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME=""
CURRENT_VERSION=""
RELEASE_VERSION=""
RELEASE_TAG=""

require_command() {
  local command_name="$1"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
}

ensure_clean_worktree() {
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "Git working tree is not clean. Commit or stash changes before releasing." >&2
    exit 1
  fi
}

ensure_npm_login() {
  if npm whoami >/dev/null 2>&1; then
    local username
    username="$(npm whoami)"
    echo "npm auth OK as $username"
    return
  fi

  if [[ ! -t 0 || ! -t 1 ]]; then
    echo "You are not logged into npm and this shell is not interactive." >&2
    echo "Run \`npm login\` manually, then retry the release." >&2
    exit 1
  fi

  echo "npm login required before publish."
  npm login

  if ! npm whoami >/dev/null 2>&1; then
    echo "npm login did not complete successfully." >&2
    exit 1
  fi

  echo "npm auth OK as $(npm whoami)"
}

package_field() {
  local field_name="$1"
  node -p "require('./package.json').${field_name}"
}

published_version() {
  npm view "$PACKAGE_NAME" version 2>/dev/null || true
}

prepare_release_version() {
  CURRENT_VERSION="$(package_field version)"

  if [[ "$VERSION" == "$CURRENT_VERSION" ]]; then
    RELEASE_VERSION="$CURRENT_VERSION"
    RELEASE_TAG="v$RELEASE_VERSION"

    if git rev-parse "$RELEASE_TAG" >/dev/null 2>&1; then
      echo "Version $RELEASE_VERSION is already tagged locally as $RELEASE_TAG. Resuming release."
      return
    fi

    echo "package.json is already at version $RELEASE_VERSION but git tag $RELEASE_TAG is missing." >&2
    echo "Create the missing tag or choose a new version before retrying." >&2
    exit 1
  fi

  echo "Creating release version $VERSION..."
  npm version "$VERSION"

  RELEASE_VERSION="$(package_field version)"
  RELEASE_TAG="v$RELEASE_VERSION"
}

cd "$ROOT_DIR"

require_command git
require_command npm

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This script must be run inside a git repository." >&2
  exit 1
fi

PACKAGE_NAME="$(package_field name)"

ensure_clean_worktree

echo "Running test suite..."
npm test

ensure_npm_login

prepare_release_version

if [[ "$(published_version)" == "$RELEASE_VERSION" ]]; then
  echo "$PACKAGE_NAME@$RELEASE_VERSION is already published on npm. Nothing to do."
  exit 0
fi

echo "Pushing release commit and tag to origin..."
git push origin HEAD --follow-tags

echo "Publishing $PACKAGE_NAME@$RELEASE_VERSION to npm..."
npm publish

echo "Release complete."
