#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}"
: "${GITHUB_SERVER_URL:?GITHUB_SERVER_URL is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${DEPLOYMENT_ID:?DEPLOYMENT_ID is required}"
: "${BUILD_RESULT:?BUILD_RESULT is required}"

state="success"
description="Android artifact build completed"
if [[ "${BUILD_RESULT}" != "success" ]]; then
  state="failure"
  description="Android artifact build failed"
fi

gh api --method POST "repos/${GITHUB_REPOSITORY}/deployments/${DEPLOYMENT_ID}/statuses" \
  --input - <<< "$(
    jq -n \
      --arg state "${state}" \
      --arg description "${description}" \
      --arg log_url "${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}" \
      '{
        state: $state,
        environment: "termux-android",
        log_url: $log_url,
        description: $description
      }'
  )"
