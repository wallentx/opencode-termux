#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

cleanup_limit="${CLEANUP_LIMIT:-100}"
cleanup_matched_checkpoint=false

append_cleanup_summary() {
  local outcome="$1"
  local release_branch="${2:-}"
  local detail="${3:-}"

  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0

  {
    echo "## Termux release branch cleanup"
    echo
    echo "- Outcome: ${outcome}"
    if [[ -n "${release_branch}" ]]; then
      echo "- Release branch: \`${release_branch}\`"
    fi
    if [[ -n "${detail}" ]]; then
      echo "- Detail: ${detail}"
    fi
  } >> "${GITHUB_STEP_SUMMARY}"
}

checkpoint_source_branch() {
  jq -r '
    [
      (.body // "")
      | split("\n")[]
      | try capture("^- Source branch: `(?<branch>[^`]+)`").branch catch empty
    ][0] // ""
  ' <<< "$1"
}

checkpoint_has_label() {
  local checkpoint_json="$1"
  local label="$2"

  jq -e --arg label "${label}" '[.labels[]?.name] | index($label) != null' <<< "${checkpoint_json}" >/dev/null
}

release_branch_is_valid() {
  [[ "$1" =~ ^release-[A-Za-z0-9._-]+$ ]]
}

open_prs_using_branch() {
  local release_branch="$1"

  gh pr list \
    --repo "${GITHUB_REPOSITORY}" \
    --state open \
    --limit 200 \
    --json number,title,url,headRefName,baseRefName,headRepository \
    | jq \
      --arg branch "${release_branch}" \
      --arg repo "${GITHUB_REPOSITORY}" \
      '
      [
        .[]
        | select(
            .baseRefName == $branch
            or (
              .headRefName == $branch
              and ((.headRepository.nameWithOwner // "") == $repo)
            )
          )
      ]
    '
}

delete_release_branch_if_unused() {
  local release_branch="$1"
  local checkpoint_url="$2"
  local open_prs
  local branch_sha

  if ! release_branch_is_valid "${release_branch}"; then
    echo "::warning::Refusing to delete unexpected release branch name: ${release_branch}"
    append_cleanup_summary "skipped" "${release_branch}" "branch name did not match release-* cleanup policy"
    return 0
  fi

  if ! branch_sha="$(gh api --method GET "repos/${GITHUB_REPOSITORY}/git/ref/heads/${release_branch}" --jq '.object.sha' 2>/dev/null)"; then
    echo "${release_branch} no longer exists on ${GITHUB_REPOSITORY}."
    append_cleanup_summary "already deleted" "${release_branch}" "remote branch was not found"
    return 0
  fi

  open_prs="$(open_prs_using_branch "${release_branch}")"
  if [[ "$(jq 'length' <<< "${open_prs}")" != "0" ]]; then
    echo "Leaving ${release_branch} in place because open PRs still use it as a source or target:"
    jq -r '.[] | "- #\(.number) \(.title) (\(.url))"' <<< "${open_prs}"
    append_cleanup_summary "skipped" "${release_branch}" "open PRs still use this branch"
    return 0
  fi

  gh api --silent --method DELETE "repos/${GITHUB_REPOSITORY}/git/refs/heads/${release_branch}"
  echo "Deleted ${release_branch} at ${branch_sha} after merged checkpoint ${checkpoint_url}."
  append_cleanup_summary "deleted" "${release_branch}" "checkpoint ${checkpoint_url} merged and no open PRs use the branch"
}

cleanup_checkpoint_pr() {
  local checkpoint_json="$1"
  local checkpoint_url
  local release_branch

  checkpoint_url="$(jq -r '.url // empty' <<< "${checkpoint_json}")"

  if [[ "$(jq -r '.mergedAt // empty' <<< "${checkpoint_json}")" == "" ]]; then
    echo "Checkpoint PR ${checkpoint_url:-unknown} is not merged yet; release branch cleanup is deferred."
    append_cleanup_summary "deferred" "" "checkpoint PR is not merged yet"
    return 0
  fi

  if ! checkpoint_has_label "${checkpoint_json}" "checkpoint" || ! checkpoint_has_label "${checkpoint_json}" "termux-release"; then
    echo "Skipping ${checkpoint_url:-checkpoint PR}; it is not labeled as a Termux checkpoint."
    return 0
  fi

  release_branch="$(checkpoint_source_branch "${checkpoint_json}")"
  if [[ -z "${release_branch}" ]]; then
    echo "::warning::Could not find release source branch in checkpoint PR ${checkpoint_url}."
    append_cleanup_summary "skipped" "" "checkpoint PR did not include a source branch"
    return 0
  fi

  if [[ -n "${SOURCE_BRANCH:-}" && "${release_branch}" != "${SOURCE_BRANCH}" ]]; then
    echo "Skipping ${checkpoint_url}; source branch ${release_branch} does not match requested ${SOURCE_BRANCH}."
    return 0
  fi

  cleanup_matched_checkpoint=true
  delete_release_branch_if_unused "${release_branch}" "${checkpoint_url}"
}

if [[ -n "${CHECKPOINT_PR:-}" ]]; then
  cleanup_checkpoint_pr "$(
    gh pr view "${CHECKPOINT_PR}" \
      --repo "${GITHUB_REPOSITORY}" \
      --json number,title,body,baseRefName,headRefName,labels,mergedAt,state,url
  )"
  exit 0
fi

while IFS= read -r checkpoint_json; do
  cleanup_checkpoint_pr "${checkpoint_json}"
done < <(
  gh pr list \
    --repo "${GITHUB_REPOSITORY}" \
    --state merged \
    --limit "${cleanup_limit}" \
    --json number,title,body,baseRefName,headRefName,labels,mergedAt,state,url \
    | jq -c '
      .[]
      | select(([.labels[]?.name] | index("checkpoint") != null))
      | select(([.labels[]?.name] | index("termux-release") != null))
    '
)

if [[ "${cleanup_matched_checkpoint}" == "false" ]]; then
  if [[ -n "${SOURCE_BRANCH:-}" ]]; then
    echo "No merged Termux checkpoint PR found for ${SOURCE_BRANCH} in the most recent ${cleanup_limit} merged PRs."
    append_cleanup_summary "skipped" "${SOURCE_BRANCH}" "no merged checkpoint PR found"
    exit 0
  fi

  echo "No merged Termux checkpoint PRs found in the most recent ${cleanup_limit} merged PRs."
  append_cleanup_summary "skipped" "" "no merged checkpoint PRs found"
fi
