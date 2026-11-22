#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${UPSTREAM_REPO:?UPSTREAM_REPO is required}"
: "${REQUESTED_TAG?REQUESTED_TAG is required}"
: "${BYPASS_PRIOR_RELEASE_TRAIN:?BYPASS_PRIOR_RELEASE_TRAIN is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"
: "${RELEASE_MAJOR:=1}"

case "${RELEASE_MAJOR}" in
  1|2) ;;
  *) echo "::error::Unsupported release major: ${RELEASE_MAJOR}" >&2; exit 1 ;;
esac

skip() {
  echo "$1"
  echo 'selected=false' >> "${GITHUB_OUTPUT}"
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    printf '%s\n' "$1" >> "${GITHUB_STEP_SUMMARY}"
  fi
  exit 0
}

latest_stable_tag() {
  # Request only the tag and publication flags. A repo's Latest badge, release
  # order and other packages' tags do not identify the newest version in a major.
  # shellcheck disable=SC2016 # The GraphQL server interprets the variables.
  gh api graphql --paginate -f owner="${UPSTREAM_REPO%%/*}" -f name="${UPSTREAM_REPO#*/}" -f query='
    query($owner: String!, $name: String!, $endCursor: String) {
      repository(owner: $owner, name: $name) {
        releases(first: 100, after: $endCursor) {
          nodes { tagName isDraft isPrerelease }
          pageInfo { hasNextPage endCursor }
        }
      }
    }' |
    jq -r --arg major "${RELEASE_MAJOR}" '
      .data.repository.releases.nodes[]
      | select(.isDraft == false and .isPrerelease == false)
      | .tagName | select(test("^v" + $major + "\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$"))
    ' | LC_ALL=C sort -V | tail -n 1
}

if [[ -n "${REQUESTED_TAG}" ]]; then
  tag="${REQUESTED_TAG#refs/tags/}"
  tag="v${tag#v}"
  tag="${tag%-termux}"
  # V1 dispatches can also resume historical prerelease trains.
  if [[ ! "${tag}" =~ ^v(1|2)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]]; then
    echo "::error::Unsupported release tag: ${REQUESTED_TAG}" >&2
    exit 1
  fi
  [[ "${tag}" == v"${RELEASE_MAJOR}".* ]] || skip "${tag} belongs to another major."
else
  tag="$(latest_stable_tag)"
  [[ -n "${tag}" ]] || skip "No published stable v${RELEASE_MAJOR} release found."
fi

if [[ "${DISCOVERY_ONLY:-false}" == true && -z "${REQUESTED_TAG}" ]]; then
  printf 'selected=true\nupstream_tag=%s\n' "${tag}" >> "${GITHUB_OUTPUT}"
  exit 0
fi

release="$(gh api --method GET "repos/${UPSTREAM_REPO}/releases/tags/${tag}")"
jq -e --arg tag "${tag}" '
  .tag_name == $tag and .draft == false and (.prerelease | type) == "boolean"
' <<< "${release}" >/dev/null || { echo "::error::Expected a published release for ${tag}." >&2; exit 1; }
prerelease="$(jq -r .prerelease <<< "${release}")"
if [[ "${RELEASE_MAJOR}" == 2 || -z "${REQUESTED_TAG}" ]]; then
  if [[ "${tag}" == *-* || "${prerelease}" != false ]]; then
    echo "::error::Expected a full v${RELEASE_MAJOR} release for ${tag}." >&2
    exit 1
  fi
fi

termux_tag="${tag}-termux"
# An absent release is a successful GraphQL null. Auth, rate-limit and API
# errors must stop discovery instead of authorizing a new publication.
# shellcheck disable=SC2016 # The GraphQL server interprets the variables.
mirror="$(gh api graphql -f owner="${GITHUB_REPOSITORY%%/*}" -f name="${GITHUB_REPOSITORY#*/}" -f tag="${termux_tag}" -f query='
  query($owner: String!, $name: String!, $tag: String!) {
    repository(owner: $owner, name: $name) { release(tagName: $tag) { isDraft isPrerelease } }
  }' | jq -c '
    .data.repository | if type == "object" and has("release") then .release else error("Missing repository") end
  ')"
if [[ "${mirror}" != null ]]; then
  if jq -e --argjson prerelease "${prerelease}" '.isDraft == false and .isPrerelease == $prerelease' <<< "${mirror}" >/dev/null; then
    skip "${termux_tag} already has a matching published release."
  fi
  if [[ "${RELEASE_MAJOR}" == 2 ]] && jq -e '.isDraft == true' <<< "${mirror}" >/dev/null; then
    echo "Resuming draft V2 release ${termux_tag}."
  else
    echo "::error::${termux_tag} exists with different publication flags; inspect the release before retrying." >&2
    exit 1
  fi
fi

version="${tag#v}"
train="${version%%-*}"
release_branch="release-${train}"
work_branch="termux-${train}"

if [[ "${RELEASE_MAJOR}" == 1 ]]; then
  # V1 shares a compatibility branch across its release PRs and checkpoints.
  prs="$(gh pr list --repo "${GITHUB_REPOSITORY}" --state open --limit 200 --json number,title,body,headRefName,baseRefName,url |
    jq -c '[.[] | select((.baseRefName | startswith("release-1.")) and (.title | startswith("Termux v")) and
      (. as $pr | .body | contains("Release branch: `" + $pr.baseRefName + "`")))]')"
  current_pr="$(jq -c --arg base "${release_branch}" '[.[] | select(.baseRefName == $base)] | max_by(.number) // empty' <<< "${prs}")"
  if [[ -n "${current_pr}" ]]; then
    work_branch="$(jq -r .headRefName <<< "${current_pr}")"
    if [[ -z "${REQUESTED_TAG}" ]]; then
      open_tag="$(jq -r '.body | (capture("- Upstream tag: `(?<tag>v[^`]+)`").tag // empty)' <<< "${current_pr}")"
      if [[ "${open_tag}" == "${tag}" ]]; then
        skip "${tag} already has an open release PR for ${release_branch}."
      fi
      # A stable cut supersedes an earlier prerelease on the same train.
    fi
  fi
  if [[ -z "${REQUESTED_TAG}" && "${BYPASS_PRIOR_RELEASE_TRAIN}" != true ]] &&
     jq -e --arg base "${release_branch}" 'any(.[]; .baseRefName != $base)' <<< "${prs}" >/dev/null; then
    skip "Another V1 release train is still open."
  fi
fi

{
  echo "selected=true"
  echo "upstream_tag=${tag}"
  echo "upstream_prerelease=${prerelease}"
  echo "release_train=${train}"
  echo "release_branch=${release_branch}"
  echo "work_branch=${work_branch}"
  echo "termux_tag=${termux_tag}"
} >> "${GITHUB_OUTPUT}"

# Release names and descriptions are upstream-controlled, potentially multiline.
for field in upstream_name upstream_html_url upstream_target upstream_id body; do
  case "${field}" in
    upstream_name) value="$(jq -r '.name // .tag_name' <<< "${release}")" ;;
    upstream_html_url) value="$(jq -r .html_url <<< "${release}")" ;;
    upstream_target) value="$(jq -r .target_commitish <<< "${release}")" ;;
    upstream_id) value="$(jq -r .id <<< "${release}")" ;;
    body) value="$(jq -r '.body // ""' <<< "${release}")" ;;
  esac
  delimiter="termux_release_${RANDOM}_${RANDOM}_${RANDOM}"
  while grep -qxF "${delimiter}" <<< "${value}"; do delimiter+="${RANDOM}"; done
  printf '%s<<%s\n%s\n%s\n' "${field}" "${delimiter}" "${value}" "${delimiter}" >> "${GITHUB_OUTPUT}"
done

echo "Selected ${tag} for ${termux_tag}."
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf 'Selected %s for %s.\n' "${tag}" "${termux_tag}" >> "${GITHUB_STEP_SUMMARY}"
fi
