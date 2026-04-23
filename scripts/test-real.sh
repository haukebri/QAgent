#!/usr/bin/env bash
set -u -o pipefail

usage() {
  cat <<'EOF'
Usage: scripts/test-real.sh [options]

Run real QAgent integration smoke tests against public websites using the actual
vendor CLIs and agent-browser. These tests can consume vendor tokens and may
take several minutes.

Options:
  --vendors <list>   Comma-separated vendors to test (default: claude,codex)
  --vendor <name>    Add one vendor to the selection (repeatable)
  --headed           Run Chrome in headed mode
  --skip-build       Reuse the existing dist/ build
  --skip-doctor      Skip qagent doctor preflight checks
  --output-dir <dir> Write logs and workspaces there
  --timeout-ms <ms>  Per-goal timeout passed to qagent (default: 300000)
  -h, --help         Show this help

Environment:
  QAGENT_REAL_USE_GLOBAL=1   Use qagent from PATH instead of node dist/cli.js

Examples:
  scripts/test-real.sh
  scripts/test-real.sh --vendor claude
  scripts/test-real.sh --vendors codex --headed
  npm run test:real -- --vendor codex
EOF
}

ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TIMESTAMP="$(date +"%Y%m%d-%H%M%S")"
OUTPUT_DIR="${ROOT_DIR}/.qagent/real-smoke/${TIMESTAMP}"
TIMEOUT_MS="300000"
HEADED=0
SKIP_BUILD=0
SKIP_DOCTOR=0
CASE_RETRIES=1

declare -a SELECTED_VENDORS=()
declare -a PASS_CASES=()
declare -a FAIL_CASES=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --vendors)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --vendors" >&2
        exit 1
      fi
      IFS=',' read -r -a SELECTED_VENDORS <<<"$2"
      shift 2
      ;;
    --vendor)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --vendor" >&2
        exit 1
      fi
      SELECTED_VENDORS+=("$2")
      shift 2
      ;;
    --headed)
      HEADED=1
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --skip-doctor)
      SKIP_DOCTOR=1
      shift
      ;;
    --output-dir)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --output-dir" >&2
        exit 1
      fi
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --timeout-ms)
      if [[ $# -lt 2 ]]; then
        echo "Missing value for --timeout-ms" >&2
        exit 1
      fi
      TIMEOUT_MS="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ ${#SELECTED_VENDORS[@]} -eq 0 ]]; then
  SELECTED_VENDORS=("claude" "codex")
fi

normalize_vendors() {
  local vendor
  local normalized=()
  local seen=""

  for vendor in "${SELECTED_VENDORS[@]}"; do
    vendor="$(printf '%s' "$vendor" | tr '[:upper:]' '[:lower:]' | xargs)"
    case "$vendor" in
      claude|codex)
        if [[ ",$seen," != *",$vendor,"* ]]; then
          normalized+=("$vendor")
          seen="${seen},${vendor}"
        fi
        ;;
      "")
        ;;
      *)
        echo "Unsupported vendor: $vendor" >&2
        exit 1
        ;;
    esac
  done

  SELECTED_VENDORS=("${normalized[@]}")
}

require_command() {
  local command_name="$1"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Missing required command: $command_name" >&2
    exit 1
  fi
}

slugify() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-'
}

verify_workspace_artifacts() {
  local workspace="$1"
  local runs_root="${workspace}/.qagent/runs"
  local result_path=""

  if [[ ! -d "$runs_root" ]]; then
    echo "Expected QAgent to create ${runs_root}, but it does not exist." >&2
    return 1
  fi

  result_path="$(find "$runs_root" -type f -name 'result.json' -print -quit)"
  if [[ -z "$result_path" ]]; then
    echo "Expected at least one result.json under ${runs_root}, but none was found." >&2
    return 1
  fi

  return 0
}

run_command_case() {
  local name="$1"
  local workspace="$2"
  shift 2

  local log_path="${OUTPUT_DIR}/logs/$(slugify "$name").log"
  local attempt=1
  local max_attempts=$((CASE_RETRIES + 1))
  mkdir -p "$workspace" "$(dirname "$log_path")"

  echo
  echo "==> ${name}"
  echo "Workspace: ${workspace}"
  echo "Log: ${log_path}"

  : >"$log_path"

  while true; do
    if [[ "$attempt" -gt 1 ]]; then
      echo "[real-smoke] Retrying ${name} (attempt ${attempt}/${max_attempts})..." | tee -a "$log_path"
    fi

    if (
      cd "$workspace" &&
      "$@"
    ) 2>&1 | tee -a "$log_path"; then
      PASS_CASES+=("${name} :: ${log_path}")
      echo "-- PASS ${name}"
      return 0
    fi

    if [[ "$attempt" -ge "$max_attempts" ]]; then
      FAIL_CASES+=("${name} :: ${log_path}")
      echo "-- FAIL ${name}"
      return 1
    fi

    attempt=$((attempt + 1))
    sleep 2
  done
}

run_qagent_case() {
  local name="$1"
  local workspace="$2"
  shift 2

  local log_path="${OUTPUT_DIR}/logs/$(slugify "$name").log"
  local attempt=1
  local max_attempts=$((CASE_RETRIES + 1))
  mkdir -p "$workspace" "$(dirname "$log_path")"

  echo
  echo "==> ${name}"
  echo "Workspace: ${workspace}"
  echo "Log: ${log_path}"

  : >"$log_path"

  while true; do
    if [[ "$attempt" -gt 1 ]]; then
      echo "[real-smoke] Retrying ${name} (attempt ${attempt}/${max_attempts})..." | tee -a "$log_path"
    fi

    if (
      cd "$workspace" &&
      "$@"
    ) 2>&1 | tee -a "$log_path"; then
      if verify_workspace_artifacts "$workspace"; then
        PASS_CASES+=("${name} :: ${workspace}/.qagent/runs")
        echo "-- PASS ${name}"
        return 0
      fi

      if [[ "$attempt" -ge "$max_attempts" ]]; then
        FAIL_CASES+=("${name} :: artifact verification failed (${workspace}/.qagent/runs)")
        echo "-- FAIL ${name} (artifact verification failed)"
        return 1
      fi
    else
      if [[ "$attempt" -ge "$max_attempts" ]]; then
        FAIL_CASES+=("${name} :: ${log_path}")
        echo "-- FAIL ${name}"
        return 1
      fi
    fi

    attempt=$((attempt + 1))
    sleep 2
  done
}

write_suite_workspace() {
  local vendor="$1"
  local workspace="$2"

  mkdir -p "$workspace"

  cat >"${workspace}/qagent.config.json" <<EOF
{
  "vendor": "${vendor}",
  "baseUrl": "https://example.com",
  "goalsFile": "goals.json",
  "timeoutMs": ${TIMEOUT_MS}
}
EOF

  cat >"${workspace}/goals.json" <<'EOF'
[
  {
    "name": "headline-visible",
    "goal": "I can see the Example Domain headline."
  },
  {
    "name": "more-information-navigation",
    "goal": "I can follow the more information link and reach an IANA page that explains example domains."
  }
]
EOF
}

normalize_vendors

require_command node
require_command npm
require_command agent-browser

for vendor in "${SELECTED_VENDORS[@]}"; do
  require_command "$vendor"
done

if [[ "${QAGENT_REAL_USE_GLOBAL:-0}" == "1" ]]; then
  QAGENT_CMD=("qagent")
else
  QAGENT_CMD=("node" "${ROOT_DIR}/dist/cli.js")
fi

echo "Real integration smoke tests"
echo "Output directory: ${OUTPUT_DIR}"
echo "Vendors: ${SELECTED_VENDORS[*]}"
echo "QAgent command: ${QAGENT_CMD[*]}"

mkdir -p "${OUTPUT_DIR}/logs"

if [[ "${SKIP_BUILD}" -ne 1 && "${QAGENT_REAL_USE_GLOBAL:-0}" != "1" ]]; then
  echo
  echo "Building local CLI..."
  (
    cd "$ROOT_DIR" &&
    npm run build
  )
fi

COMMON_ARGS=(--timeout "$TIMEOUT_MS")
if [[ "$HEADED" -eq 1 ]]; then
  COMMON_ARGS+=(--headed)
fi

for vendor in "${SELECTED_VENDORS[@]}"; do
  if [[ "$SKIP_DOCTOR" -ne 1 ]]; then
    run_command_case "${vendor}-doctor" "${OUTPUT_DIR}/${vendor}/doctor" "${QAGENT_CMD[@]}" doctor --vendor "$vendor"
  fi

  if [[ "$vendor" == "claude" ]]; then
    run_qagent_case \
      "claude-default-one-off" \
      "${OUTPUT_DIR}/${vendor}/default-one-off" \
      "${QAGENT_CMD[@]}" \
      --url "https://example.com" \
      --goal "I can see the Example Domain headline." \
      "${COMMON_ARGS[@]}"

    run_qagent_case \
      "claude-github-one-off" \
      "${OUTPUT_DIR}/${vendor}/github-one-off" \
      "${QAGENT_CMD[@]}" \
      --url "https://github.com/haukebri/QAgent" \
      --goal "I can see the haukebri/QAgent repository name and its description that says it is a CLI that runs prose-written end-to-end goals against your web app." \
      "${COMMON_ARGS[@]}"
  else
    run_qagent_case \
      "${vendor}-one-off" \
      "${OUTPUT_DIR}/${vendor}/one-off" \
      "${QAGENT_CMD[@]}" \
      --vendor "$vendor" \
      --url "https://example.com" \
      --goal "I can see the Example Domain headline." \
      "${COMMON_ARGS[@]}"

    run_qagent_case \
      "${vendor}-github-one-off" \
      "${OUTPUT_DIR}/${vendor}/github-one-off" \
      "${QAGENT_CMD[@]}" \
      --vendor "$vendor" \
      --codex-sandbox danger-full-access \
      --url "https://github.com/haukebri/QAgent" \
      --goal "I can see the haukebri/QAgent repository name and its description that says it is a CLI that runs prose-written end-to-end goals against your web app." \
      "${COMMON_ARGS[@]}"
  fi

  suite_workspace="${OUTPUT_DIR}/${vendor}/project-suite"
  write_suite_workspace "$vendor" "$suite_workspace"
  run_qagent_case \
    "${vendor}-project-suite-parallel" \
    "$suite_workspace" \
    "${QAGENT_CMD[@]}" \
    --parallel
done

echo
echo "Real smoke summary"
echo "Output directory: ${OUTPUT_DIR}"
echo "Passed: ${#PASS_CASES[@]}"
echo "Failed: ${#FAIL_CASES[@]}"

if [[ ${#PASS_CASES[@]} -gt 0 ]]; then
  echo
  echo "Passed cases:"
  printf '  - %s\n' "${PASS_CASES[@]}"
fi

if [[ ${#FAIL_CASES[@]} -gt 0 ]]; then
  echo
  echo "Failed cases:"
  printf '  - %s\n' "${FAIL_CASES[@]}"
  exit 1
fi

exit 0
