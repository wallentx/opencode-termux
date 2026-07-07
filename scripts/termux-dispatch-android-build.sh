#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RELEASE_BRANCH:?RELEASE_BRANCH is required}"
: "${RELEASE_SHA:?RELEASE_SHA is required}"
: "${TERMUX_TAG:?TERMUX_TAG is required}"

promoted_dir="${PROMOTED_DIR:-promoted}"
build_version="${TERMUX_TAG#v}"

find_run_id() {
  gh run list \
    --repo "${GITHUB_REPOSITORY}" \
    --workflow publish.yml \
    --branch "${RELEASE_BRANCH}" \
    --event workflow_dispatch \
    --limit 20 \
    --json databaseId,headSha,createdAt \
    --jq "[.[] | select(.headSha == \"${RELEASE_SHA}\")] | sort_by(.createdAt) | reverse | .[0].databaseId // empty"
}

echo "Dispatching publish.yml android build for ${RELEASE_BRANCH}@${RELEASE_SHA} as ${build_version}."
gh workflow run publish.yml \
  --repo "${GITHUB_REPOSITORY}" \
  --ref "${RELEASE_BRANCH}" \
  -f target=android-arm64 \
  -f "version=${build_version}"

run_id=""
for _ in $(seq 1 20); do
  sleep 15
  run_id="$(find_run_id)"
  [[ -z "${run_id}" ]] || break
done

if [[ -z "${run_id}" ]]; then
  echo "Unable to find dispatched publish.yml run for ${RELEASE_BRANCH}@${RELEASE_SHA}." >&2
  exit 1
fi

echo "Waiting for publish.yml run ${run_id}."
while true; do
  run_json="$(gh run view "${run_id}" --repo "${GITHUB_REPOSITORY}" --json status,conclusion,url)"
  status="$(jq -r '.status' <<< "${run_json}")"
  conclusion="$(jq -r '.conclusion // ""' <<< "${run_json}")"
  url="$(jq -r '.url' <<< "${run_json}")"
  echo "publish.yml ${run_id}: status=${status} conclusion=${conclusion} ${url}"

  if [[ "${status}" == "completed" ]]; then
    if [[ "${conclusion}" != "success" ]]; then
      echo "publish.yml run ${run_id} failed with conclusion ${conclusion}." >&2
      exit 1
    fi
    break
  fi

  sleep 60
done

rm -rf "${promoted_dir}"
mkdir -p "${promoted_dir}"
gh run download "${run_id}" \
  --repo "${GITHUB_REPOSITORY}" \
  --name opencode-android-arm64 \
  --dir "${promoted_dir}"

if [[ ! -f "${promoted_dir}/opencode-android-arm64.tar.gz" ]]; then
  echo "Expected ${promoted_dir}/opencode-android-arm64.tar.gz in downloaded artifact." >&2
  find "${promoted_dir}" -maxdepth 3 -type f -print >&2
  exit 1
fi

sha256sum "${promoted_dir}/opencode-android-arm64.tar.gz"
