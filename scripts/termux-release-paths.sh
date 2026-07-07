#!/usr/bin/env bash

set -euo pipefail

readonly -a TERMUX_RELEASE_WORKFLOW_PATHS=(
  .github/workflows/publish.yml
  .github/workflows/termux-release-checkpoint.yml
  .github/workflows/termux-release-deploy.yml
  .github/workflows/termux-release-watch.yml
)

readonly -a TERMUX_RELEASE_SCRIPT_PATHS=(
  scripts/termux-configure-git.sh
  scripts/termux-create-checkpoint-pr.sh
  scripts/termux-create-or-update-mirrored-release.sh
  scripts/termux-create-release-pr.sh
  scripts/termux-dispatch-android-build.sh
  scripts/termux-find-release-pr.sh
  scripts/termux-read-release-metadata.sh
  scripts/termux-release-paths.sh
  scripts/termux-resolve-release-ref.sh
  scripts/termux-select-release.sh
  scripts/termux-validate-gh-env.sh
)

readonly -a TERMUX_RELEASE_AUTOMATION_PATHS=(
  "${TERMUX_RELEASE_WORKFLOW_PATHS[@]}"
  "${TERMUX_RELEASE_SCRIPT_PATHS[@]}"
)

readonly -a TERMUX_CHECKPOINT_RELEASE_ONLY_PATHS=(
  "${TERMUX_RELEASE_AUTOMATION_PATHS[@]}"
  .github/termux-release.json
)

termux_path_in_list() {
  local candidate="$1"
  shift
  local listed_path

  for listed_path in "$@"; do
    [[ "${candidate}" != "${listed_path}" ]] || return 0
  done
  return 1
}

termux_is_checkpoint_release_only_path() {
  termux_path_in_list "$1" "${TERMUX_CHECKPOINT_RELEASE_ONLY_PATHS[@]}"
}
