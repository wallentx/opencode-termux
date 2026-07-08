#!/usr/bin/env bash

set -euo pipefail

readonly -a TERMUX_RELEASE_WORKFLOW_PATHS=(
  .github/actions/build-android-cli/action.yml
  .github/workflows/publish.yml
  .github/workflows/termux-release-branch-cleanup.yml
  .github/workflows/termux-release-checkpoint.yml
  .github/workflows/termux-release-deploy.yml
  .github/workflows/termux-release-watch.yml
)

readonly -a TERMUX_RELEASE_SCRIPT_PATHS=(
  .github/scripts/termux-configure-git.sh
  .github/scripts/termux-cleanup-release-branch.sh
  .github/scripts/termux-create-checkpoint-pr.sh
  .github/scripts/termux-create-android-build-deployment.sh
  .github/scripts/termux-create-or-update-mirrored-release.sh
  .github/scripts/termux-create-release-pr.sh
  .github/scripts/termux-find-release-pr.sh
  .github/scripts/termux-finish-android-build-deployment.sh
  .github/scripts/termux-read-release-metadata.sh
  .github/scripts/termux-release-paths.sh
  .github/scripts/termux-resolve-release-ref.sh
  .github/scripts/termux-select-release.sh
  .github/scripts/termux-validate-gh-env.sh
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
