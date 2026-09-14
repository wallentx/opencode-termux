#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

if [[ -n "${INPUT_PR_NUMBER:-}" || -n "${INPUT_PR_HEAD_SHA:-}" ]]; then
  if [[ -z "${INPUT_PR_NUMBER:-}" || -z "${INPUT_PR_HEAD_SHA:-}" ]]; then
    echo "workflow_dispatch inputs pr_number and pr_head_sha must be provided together." >&2
    exit 1
  fi
  pr_number="${INPUT_PR_NUMBER}"
  head_sha="${INPUT_PR_HEAD_SHA}"
  head_ref=""
else
  : "${RELEASE_BRANCH:?RELEASE_BRANCH is required}"
  : "${RELEASE_SHA:?RELEASE_SHA is required}"
  pr_json="$(
    gh pr list \
      --repo "${GITHUB_REPOSITORY}" \
      --base "${RELEASE_BRANCH}" \
      --state merged \
      --limit 100 \
      --json number,headRefOid,headRefName,mergeCommit \
      --jq "[.[] | select(.mergeCommit.oid == \"${RELEASE_SHA}\")] | sort_by(.number) | reverse | .[0] // empty"
  )"
  if [[ -z "${pr_json}" ]]; then
    echo "Unable to find merged PR for ${RELEASE_SHA} into ${RELEASE_BRANCH}" >&2
    exit 1
  fi
  pr_number="$(jq -r '.number' <<< "${pr_json}")"
  head_sha="$(jq -r '.headRefOid' <<< "${pr_json}")"
  head_ref="$(jq -r '.headRefName' <<< "${pr_json}")"
fi

{
  echo "number=${pr_number}"
  echo "head_sha=${head_sha}"
  echo "head_ref=${head_ref}"
} >> "${GITHUB_OUTPUT}"
