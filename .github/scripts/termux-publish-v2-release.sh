#!/usr/bin/env bash
set -euo pipefail

# Run from the artifact directory downloaded after Termux smoke tests passed.
assets=(opencode-android-arm64.tar.gz opencode-android-arm64.tar.gz.sha256 provenance.json)
sha256sum -c opencode-android-arm64.tar.gz.sha256
jq -e --arg tag "${UPSTREAM_TAG}" --arg release "${RELEASE_TAG}" --arg build "${BUILD_VERSION}" \
  --arg source "${SOURCE_SHA}" --arg automation "${AUTOMATION_SHA}" '
  .source_repository == "https://github.com/anomalyco/opencode" and
  .source_ref == $tag and .release_tag == $release and .build_version == $build and
  .source_sha == $source and .automation_sha == $automation
' provenance.json >/dev/null

# The same lookup finds published releases and drafts with a pending tag.
# shellcheck disable=SC2016 # Variables inside the query are interpreted by GitHub.
state="$(gh api graphql -f owner="${GITHUB_REPOSITORY%%/*}" -f name="${GITHUB_REPOSITORY#*/}" -f tag="${RELEASE_TAG}" -f query='
  query($owner: String!, $name: String!, $tag: String!) {
    repository(owner: $owner, name: $name) { release(tagName: $tag) { isDraft isPrerelease } }
  }' | jq -er '
    .data.repository | if type != "object" or (has("release") | not) then error("Missing repository")
    elif .release == null then "missing"
    elif .release.isDraft == true then "draft"
    elif .release.isDraft == false and .release.isPrerelease == false then "published"
    else error("Existing release has unexpected publication flags") end')"
if [[ "${state}" == published ]]; then
  echo "Release ${RELEASE_TAG} is already published."
  exit 0
fi

notes="${RUNNER_TEMP}/termux-v2-release-notes.md"
{
  echo "Termux Android build for https://github.com/anomalyco/opencode/releases/tag/${UPSTREAM_TAG}."
  echo
  echo "- Upstream source: \`${SOURCE_SHA}\`"
  echo "- Embedded version: \`${BUILD_VERSION}\`"
  echo "- Automation source: \`${AUTOMATION_SHA}\`"
  echo
  echo "The Android artifact passed ELF inspection and Termux TUI smoke tests."
  echo
  sed 's/^/`/' opencode-android-arm64.tar.gz.sha256 | sed 's/$/`/'
} > "${notes}"

metadata=(--repo "${GITHUB_REPOSITORY}" --target "${AUTOMATION_SHA}" --title "${UPSTREAM_TAG}" --notes-file "${notes}" --latest=false)
if [[ "${state}" == draft ]]; then
  gh release upload "${RELEASE_TAG}" "${assets[@]}" --repo "${GITHUB_REPOSITORY}" --clobber
  gh release edit "${RELEASE_TAG}" "${metadata[@]}" --prerelease=false --draft=false
  exit 0
fi

gh release create "${RELEASE_TAG}" "${assets[@]}" "${metadata[@]}"
