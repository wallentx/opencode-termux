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

if [[ ! "${UPSTREAM_TAG}" =~ ^v2\.[0-9]+\.[0-9]+$ || "${RELEASE_TAG}" != "${UPSTREAM_TAG}-termux" ]]; then
  echo "::error::Invalid V2 release tag pair: ${UPSTREAM_TAG}, ${RELEASE_TAG}" >&2
  exit 1
fi

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

# The GitHub source archive for the fork tag must match the commit that passed smoke.
git fetch --quiet --no-tags --depth=1 https://github.com/anomalyco/opencode.git "refs/tags/${UPSTREAM_TAG}"
if [[ "$(git rev-parse --verify 'FETCH_HEAD^{commit}')" != "${SOURCE_SHA}" ]]; then
  echo "::error::Upstream tag ${UPSTREAM_TAG} no longer matches the tested source ${SOURCE_SHA}." >&2
  exit 1
fi
ref="refs/tags/${RELEASE_TAG}"
existing="$(git ls-remote --tags origin "${ref}" "${ref}^{}")"
if [[ -n "${existing}" ]]; then
  # An annotated tag's peeled object is advertised separately from its tag object.
  target="$(awk -v ref="${ref}" '$2 == ref {target=$1} $2 == ref "^{}" {peeled=$1} END {print peeled ? peeled : target}' <<< "${existing}")"
  if [[ "${target}" != "${SOURCE_SHA}" ]]; then
    echo "::error::Fork tag ${RELEASE_TAG} points to ${target}, expected ${SOURCE_SHA}." >&2
    exit 1
  fi
elif [[ "${state}" == published ]]; then
  echo "::error::Published release ${RELEASE_TAG} has no matching Git tag." >&2
  exit 1
else
  # Forks share the upstream Git object network. Create the reference without
  # updating existing tags, including one created concurrently after our lookup.
  gh api --method POST "repos/${GITHUB_REPOSITORY}/git/refs" -f ref="${ref}" -f sha="${SOURCE_SHA}" >/dev/null
fi
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

metadata=(--repo "${GITHUB_REPOSITORY}" --verify-tag --title "${UPSTREAM_TAG}" --notes-file "${notes}" --latest=false)
if [[ "${state}" == draft ]]; then
  gh release upload "${RELEASE_TAG}" "${assets[@]}" --repo "${GITHUB_REPOSITORY}" --clobber
  gh release edit "${RELEASE_TAG}" --tag "${RELEASE_TAG}" "${metadata[@]}" --prerelease=false --draft=false
  exit 0
fi

gh release create "${RELEASE_TAG}" "${assets[@]}" "${metadata[@]}"
