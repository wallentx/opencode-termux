#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${PR_NUMBER:?PR_NUMBER is required}"
: "${PR_HEAD_SHA:?PR_HEAD_SHA is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"

artifact_name="opencode-android-arm64-pr-${PR_NUMBER}-${PR_HEAD_SHA}"
artifact_json="$(
  gh api --method GET "repos/${GITHUB_REPOSITORY}/actions/artifacts?name=${artifact_name}&per_page=100" \
    --jq '[.artifacts[] | select(.expired == false)] | sort_by(.created_at) | reverse | .[0] // empty'
)"

if [[ -z "${artifact_json}" ]]; then
  {
    echo "found=false"
    echo "artifact_name=${artifact_name}"
  } >> "${GITHUB_OUTPUT}"
  exit 0
fi

artifact_id="$(jq -r '.id' <<< "${artifact_json}")"
run_id="$(jq -r '.workflow_run.id' <<< "${artifact_json}")"
run_json="$(gh api --method GET "repos/${GITHUB_REPOSITORY}/actions/runs/${run_id}")"

if ! jq -e \
  --arg head_ref "${PR_HEAD_REF:-}" \
  --arg head_sha "${PR_HEAD_SHA}" \
  '
    .event == "pull_request"
    and .status == "completed"
    and .conclusion == "success"
    and .path == ".github/workflows/termux-release-ci.yml"
    and .head_sha == $head_sha
    and ($head_ref == "" or .head_branch == $head_ref)
  ' <<< "${run_json}" >/dev/null; then
  echo "::warning::Artifact ${artifact_name} came from release CI run ${run_id}, but that run is not a successful check for PR ${PR_NUMBER}."
  {
    echo "found=false"
    echo "artifact_name=${artifact_name}"
  } >> "${GITHUB_OUTPUT}"
  exit 0
fi

{
  echo "found=true"
  echo "artifact_id=${artifact_id}"
  echo "artifact_name=${artifact_name}"
  echo "run_id=${run_id}"
} >> "${GITHUB_OUTPUT}"
