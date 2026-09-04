#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_SERVER_URL:?GITHUB_SERVER_URL is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RELEASE_BRANCH:?RELEASE_BRANCH is required}"
: "${RELEASE_SHA:?RELEASE_SHA is required}"
: "${TERMUX_TAG:?TERMUX_TAG is required}"

deployment_json="$(
  jq -n \
    --arg ref "${RELEASE_SHA}" \
    --arg termux_tag "${TERMUX_TAG}" \
    --arg release_branch "${RELEASE_BRANCH}" \
    '{
      ref: $ref,
      task: "build-android",
      auto_merge: false,
      required_contexts: [],
      environment: "termux-android",
      description: ("Build Android artifact for " + $termux_tag),
      transient_environment: true,
      production_environment: false,
      payload: {
        termux_tag: $termux_tag,
        release_branch: $release_branch
      }
    }' \
    | gh api --method POST "repos/${GITHUB_REPOSITORY}/deployments" --input -
)"

deployment_id="$(jq -r '.id' <<< "${deployment_json}")"
if [[ -z "${deployment_id}" || "${deployment_id}" == "null" ]]; then
  echo "GitHub did not return a deployment id." >&2
  echo "${deployment_json}" >&2
  exit 1
fi

gh api --method POST "repos/${GITHUB_REPOSITORY}/deployments/${deployment_id}/statuses" \
  --input - <<< "$(
    jq -n \
      --arg log_url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
      '{
        state: "in_progress",
        environment: "termux-android",
        log_url: $log_url,
        description: "Building Android artifact"
      }'
  )"

echo "deployment_id=${deployment_id}" >> "${GITHUB_OUTPUT}"
