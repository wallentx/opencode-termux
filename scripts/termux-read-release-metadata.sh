#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

metadata=".github/termux-release.json"
if [[ ! -f "${metadata}" ]]; then
  echo "No ${metadata}; this is not a Termux release deployment."
  echo "deploy=false" >> "${GITHUB_OUTPUT}"
  exit 0
fi

upstream_tag="$(jq -r '.upstream_tag // empty' "${metadata}")"
upstream_name="$(jq -r '.upstream_name // .upstream_tag // empty' "${metadata}")"
termux_tag="$(jq -r '.termux_tag // empty' "${metadata}")"
upstream_prerelease="$(jq -r '.upstream_prerelease // false' "${metadata}")"
upstream_html_url="$(jq -r '.upstream_html_url // ""' "${metadata}")"
upstream_repo="$(jq -r '.upstream_repo // "anomalyco/opencode"' "${metadata}")"
release_train="$(jq -r '.release_train // ""' "${metadata}")"

if [[ -z "${upstream_tag}" || -z "${termux_tag}" ]]; then
  echo "Missing upstream_tag or termux_tag in ${metadata}" >&2
  exit 1
fi

release_exists=false
asset_exists=false
if gh release view "${termux_tag}" --repo "${GITHUB_REPOSITORY}" >/dev/null 2>&1; then
  release_exists=true
  if [[ "$(
    gh release view "${termux_tag}" \
      --repo "${GITHUB_REPOSITORY}" \
      --json assets \
      --jq '.assets | map(.name) | any(. == "opencode-android-arm64.tar.gz")'
  )" == "true" ]]; then
    asset_exists=true
  fi
fi

{
  echo "deploy=true"
  echo "upstream_tag=${upstream_tag}"
  echo "upstream_name=${upstream_name}"
  echo "termux_tag=${termux_tag}"
  echo "build_version=${termux_tag#v}"
  echo "upstream_prerelease=${upstream_prerelease}"
  echo "upstream_html_url=${upstream_html_url}"
  echo "upstream_repo=${upstream_repo}"
  echo "release_train=${release_train}"
  echo "release_exists=${release_exists}"
  echo "asset_exists=${asset_exists}"
} >> "${GITHUB_OUTPUT}"
