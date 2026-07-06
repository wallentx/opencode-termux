#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${DESTINATION_BRANCH:?DESTINATION_BRANCH is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/termux-release-paths.sh
source "${script_dir}/termux-release-paths.sh"

source_branch="${SOURCE_BRANCH:-${REQUESTED_SOURCE_BRANCH:-${GITHUB_REF_NAME:-}}}"
source_sha="${SOURCE_SHA:-${REQUESTED_SOURCE_SHA:-}}"
if [[ -z "${source_branch}" ]]; then
  echo "SOURCE_BRANCH is required." >&2
  exit 1
fi
if [[ -z "${source_sha}" ]]; then
  source_sha="$(git rev-parse "origin/${source_branch}")"
fi

short_sha="${source_sha:0:12}"
checkpoint_branch="checkpoint-${short_sha}"
pr_title="checkpoint: ${source_branch} into ${DESTINATION_BRANCH} @ ${short_sha}"
merge_conflicted=false
conflict_summary=""

existing_pr="$(
  gh pr list \
    --repo "${GITHUB_REPOSITORY}" \
    --head "${checkpoint_branch}" \
    --state all \
    --json body,number,state,mergedAt,url \
    --jq '[.[] | select(.state == "OPEN" or .mergedAt != null)] | .[0] // empty'
)"
if [[ -n "${existing_pr}" ]]; then
  existing_url="$(jq -r '.url' <<< "${existing_pr}")"
  echo "Checkpoint PR already exists for ${checkpoint_branch}: ${existing_url}."
  echo "pr_url=${existing_url}" >> "${GITHUB_OUTPUT:-/dev/null}"
  exit 0
fi

git fetch origin "${DESTINATION_BRANCH}" "${source_branch}"
git checkout -B "${checkpoint_branch}" "origin/${DESTINATION_BRANCH}"

if ! git merge --no-ff --no-edit "${source_sha}"; then
  mapfile -t conflicted_paths < <(git diff --name-only --diff-filter=U)
  for conflicted_path in "${conflicted_paths[@]}"; do
    if termux_is_checkpoint_release_only_path "${conflicted_path}"; then
      echo "Auto-resolving release-only checkpoint conflict in ${conflicted_path} by keeping ${DESTINATION_BRANCH}."
      if git cat-file -e "HEAD:${conflicted_path}" 2>/dev/null; then
        git checkout --ours -- "${conflicted_path}"
        git add "${conflicted_path}"
      else
        git rm -f --ignore-unmatch "${conflicted_path}"
      fi
    fi
  done

  mapfile -t remaining_conflicts < <(git diff --name-only --diff-filter=U)
  if [[ "${#remaining_conflicts[@]}" -eq 0 ]]; then
    git commit --no-edit
  else
    merge_conflicted=true
    conflict_summary="$(printf '%s\n' "${remaining_conflicts[@]}" | awk '{ print "- `" $0 "`" }')"
    echo "Automatic checkpoint merge failed; creating a manual-resolution PR." >&2
    if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
      git merge --abort
    fi
    git checkout -B "${checkpoint_branch}" "${source_sha}"
  fi
fi

for release_only_path in "${TERMUX_CHECKPOINT_RELEASE_ONLY_PATHS[@]}"; do
  if git cat-file -e "origin/${DESTINATION_BRANCH}:${release_only_path}" 2>/dev/null; then
    git checkout "origin/${DESTINATION_BRANCH}" -- "${release_only_path}"
  else
    git rm -f --ignore-unmatch -- "${release_only_path}"
  fi
done

if ! git diff --quiet || ! git diff --cached --quiet; then
  git add -A
  if [[ "${merge_conflicted}" == "true" ]]; then
    git commit -m "checkpoint: prepare ${source_branch} for ${DESTINATION_BRANCH}"
  else
    git commit --amend --no-edit
  fi
fi

if git diff --quiet "origin/${DESTINATION_BRANCH}" HEAD; then
  echo "Checkpoint merge produced no destination changes after release-only files were restored."
  exit 0
fi

git push --force-with-lease origin "${checkpoint_branch}"

body_path="${RUNNER_TEMP}/termux-checkpoint-pr.md"
{
  echo "## Termux release checkpoint"
  echo
  echo "- Source branch: \`${source_branch}\`"
  echo "- Source hash: \`${source_sha}\`"
  echo "- Destination branch: \`${DESTINATION_BRANCH}\`"
  echo
  echo "This PR carries release-train conflict fixes and follow-up changes back into the reusable Termux patch branch. Release metadata is removed before opening the PR."
  if [[ "${merge_conflicted}" == "true" ]]; then
    echo
    echo "## Merge conflicts"
    echo
    echo "GitHub Actions could not create the checkpoint merge commit automatically, so this PR was created from the release branch state for manual conflict resolution."
    echo
    printf '%s\n' "${conflict_summary:-"- Conflict details unavailable"}"
  fi
} > "${body_path}"

pr_url="$(
  gh pr create \
    --repo "${GITHUB_REPOSITORY}" \
    --base "${DESTINATION_BRANCH}" \
    --head "${checkpoint_branch}" \
    --title "${pr_title}" \
    --body-file "${body_path}"
)"
if [[ -n "${REVIEWER:-}" ]]; then
  gh pr edit "${pr_url}" --repo "${GITHUB_REPOSITORY}" --add-reviewer "${REVIEWER}" || true
fi
gh label create checkpoint --repo "${GITHUB_REPOSITORY}" --color c5def5 --description "Checkpoint merge" --force
gh label create termux-release --repo "${GITHUB_REPOSITORY}" --color 0e8a16 --description "Termux release automation" --force
gh pr edit "${pr_url}" --repo "${GITHUB_REPOSITORY}" --add-label "checkpoint" --add-label "termux-release"

if [[ "${merge_conflicted}" != "true" ]]; then
  pr_head_sha="$(gh pr view "${pr_url}" --repo "${GITHUB_REPOSITORY}" --json headRefOid --jq '.headRefOid')"
  gh pr merge "${pr_url}" \
    --repo "${GITHUB_REPOSITORY}" \
    --merge \
    --auto \
    --delete-branch \
    --match-head-commit "${pr_head_sha}" \
    || echo "::warning::Could not enable checkpoint auto-merge for ${pr_url}."
fi

echo "pr_url=${pr_url}" >> "${GITHUB_OUTPUT:-/dev/null}"
