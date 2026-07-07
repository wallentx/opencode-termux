#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${UPSTREAM_REPO:?UPSTREAM_REPO is required}"
: "${REQUESTED_TAG?REQUESTED_TAG is required}"
: "${BYPASS_PRIOR_RELEASE_TRAIN:?BYPASS_PRIOR_RELEASE_TRAIN is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

normalize_tag_version() {
  local tag="$1"
  local version="${tag#v}"
  version="${version%-termux}"
  printf '%s\n' "${version}"
}

requested_upstream_tag() {
  local requested="${1#refs/tags/}"
  printf 'v%s\n' "$(normalize_tag_version "${requested}")"
}

release_train_for_tag() {
  local version
  version="$(normalize_tag_version "$1")"
  printf '%s\n' "${version%%-*}"
}

release_branch_for_tag() {
  printf 'release-%s\n' "$(release_train_for_tag "$1")"
}

work_branch_for_tag() {
  printf 'termux-%s\n' "$(release_train_for_tag "$1")"
}

termux_tag_for_tag() {
  printf '%s-termux\n' "$1"
}

latest_release_json() {
  gh api --method GET "repos/${UPSTREAM_REPO}/releases?per_page=1" \
    | jq -c '
      .[0] // empty
      | select(type == "object")
      | {
        tagName: (.tag_name // .tagName // ""),
        name: (.name // .tag_name // .tagName // ""),
        body: (.body // ""),
        url: (.html_url // .url // ""),
        isPrerelease: (.prerelease // .isPrerelease // false),
        targetCommitish: (.target_commitish // .targetCommitish // ""),
        databaseId: (.id // .databaseId // "")
      }
    '
}

release_json_for_tag() {
  local tag="$1"
  gh api --method GET "repos/${UPSTREAM_REPO}/releases/tags/${tag}" \
    | jq -c '{
      tagName: (.tag_name // .tagName // ""),
      name: (.name // .tag_name // .tagName // ""),
      body: (.body // ""),
      url: (.html_url // .url // ""),
      isPrerelease: (.prerelease // .isPrerelease // false),
      targetCommitish: (.target_commitish // .targetCommitish // ""),
      databaseId: (.id // .databaseId // "")
    }'
}

open_prs_json() {
  gh pr list \
    --repo "${GITHUB_REPOSITORY}" \
    --state open \
    --limit 200 \
    --json number,title,body,headRefName,baseRefName,url
}

release_branch_current_tag() {
  git show "origin/$1:.github/termux-release.json" 2>/dev/null \
    | jq -r '.upstream_tag // empty' 2>/dev/null \
    || true
}

version_is_newer() {
  local candidate="$1"
  local current="$2"
  local candidate_version
  local current_version
  local newest

  if [[ -z "${current}" ]]; then
    return 0
  fi

  candidate_version="$(normalize_tag_version "${candidate}")"
  current_version="$(normalize_tag_version "${current}")"
  newest="$(printf '%s\n%s\n' "${current_version}" "${candidate_version}" | sort -V | tail -n 1)"
  [[ "${newest}" == "${candidate_version}" && "${candidate_version}" != "${current_version}" ]]
}

latest_mirrored_termux_tag() {
  local release_train="${1:-}"
  local newest_tag=""
  local tag
  local tag_train

  while IFS= read -r tag; do
    [[ -n "${tag}" ]] || continue
    [[ "${tag}" == v*-termux ]] || continue
    if [[ -n "${release_train}" ]]; then
      tag_train="$(release_train_for_tag "${tag}")"
      [[ "${tag_train}" == "${release_train}" ]] || continue
    fi
    if [[ -z "${newest_tag}" ]] || version_is_newer "${tag}" "${newest_tag}"; then
      newest_tag="${tag}"
    fi
  done < <(
    gh release list \
      --repo "${GITHUB_REPOSITORY}" \
      --exclude-drafts \
      --limit 200 \
      --json tagName \
      --jq '.[].tagName'
  )

  printf '%s\n' "${newest_tag}"
}

latest_mirrored_termux_tag_for_train() {
  latest_mirrored_termux_tag "$1"
}

open_release_train_pr_for_branch() {
  local release_branch="$1"
  open_prs_json \
    | jq -c \
      --arg release_branch "${release_branch}" \
      '
        [
          .[]
          | select(.baseRefName == $release_branch)
          | select(
              ((.title // "") | startswith("Termux v"))
              and ((.body // "") | contains("Release branch: `" + $release_branch + "`"))
            )
          | . + {
              upstreamTag: (
                (.body // "")
                | try capture("- Upstream tag: `(?<tag>v[^`]+)`").tag catch ""
              )
            }
        ]
        | sort_by(.number)
        | reverse
        | .[0] // empty
      '
}

open_other_release_train_prs() {
  local release_branch="$1"
  open_prs_json \
    | jq -r \
      --arg release_branch "${release_branch}" \
      '
        .[]
        | select(.baseRefName != $release_branch)
        | select(
            ((.title // "") | startswith("Termux v"))
            and ((.body // "") | contains("Release branch: `release-"))
          )
        | "- #\(.number) \(.title) (\(.url))"
      '
}

append_selection_summary() {
  local selected="$1"
  local upstream_tag="${2:-}"
  local release_branch="${3:-}"
  local work_branch="${4:-}"
  local termux_tag="${5:-}"

  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0

  {
    echo "## Termux release selection"
    echo
    echo "- Repository: \`${GITHUB_REPOSITORY}\`"
    echo "- Upstream repository: \`${UPSTREAM_REPO}\`"
    if [[ "${selected}" == "true" ]]; then
      echo "- Selected upstream tag: \`${upstream_tag}\`"
      echo "- Release branch: \`${release_branch}\`"
      echo "- Work branch: \`${work_branch}\`"
      echo "- Termux tag: \`${termux_tag}\`"
    else
      echo "- Selected: no"
    fi
  } >> "${GITHUB_STEP_SUMMARY}"
}

emit_selected_release() {
  local release_json="$1"
  local release_branch="$2"
  local work_branch="$3"
  local termux_tag="$4"
  local upstream_tag
  local upstream_body

  upstream_tag="$(jq -r '.tagName' <<< "${release_json}")"
  upstream_body="$(jq -r '.body // ""' <<< "${release_json}")"

  {
    echo "selected=true"
    echo "upstream_tag=${upstream_tag}"
    echo "upstream_name=$(jq -r '.name' <<< "${release_json}")"
    echo "upstream_html_url=$(jq -r '.url' <<< "${release_json}")"
    echo "upstream_prerelease=$(jq -r '.isPrerelease' <<< "${release_json}")"
    echo "upstream_target=$(jq -r '.targetCommitish' <<< "${release_json}")"
    echo "upstream_id=$(jq -r '.databaseId' <<< "${release_json}")"
    echo "release_train=$(release_train_for_tag "${upstream_tag}")"
    echo "release_branch=${release_branch}"
    echo "work_branch=${work_branch}"
    echo "termux_tag=${termux_tag}"
  } >> "${GITHUB_OUTPUT}"

  body_delimiter="termux_release_body_$(date +%s%N)_${RANDOM}_${RANDOM}"
  while grep -qxF "${body_delimiter}" <<< "${upstream_body}"; do
    body_delimiter="termux_release_body_$(date +%s%N)_${RANDOM}_${RANDOM}"
  done
  {
    echo "body<<${body_delimiter}"
    printf '%s\n' "${upstream_body}"
    echo "${body_delimiter}"
  } >> "${GITHUB_OUTPUT}"

  append_selection_summary "true" "${upstream_tag}" "${release_branch}" "${work_branch}" "${termux_tag}"
}

maybe_select_release() {
  local release_json="$1"
  local selection_mode="${2:-latest}"
  local upstream_tag
  local release_train
  local release_branch
  local work_branch
  local termux_tag
  local current_tag
  local mirrored_tag
  local open_pr_json
  local open_pr_tag
  local pending_other_prs

  upstream_tag="$(jq -r '.tagName // empty' <<< "${release_json}")"
  [[ "${upstream_tag}" == v* ]] || return 1

  release_train="$(release_train_for_tag "${upstream_tag}")"
  release_branch="$(release_branch_for_tag "${upstream_tag}")"
  work_branch="$(work_branch_for_tag "${upstream_tag}")"
  termux_tag="$(termux_tag_for_tag "${upstream_tag}")"

  if gh release view "${termux_tag}" --repo "${GITHUB_REPOSITORY}" >/dev/null 2>&1; then
    echo "${termux_tag} already exists; nothing to do."
    return 1
  fi

  open_pr_json="$(open_release_train_pr_for_branch "${release_branch}")"
  if [[ -n "${open_pr_json}" ]]; then
    open_pr_tag="$(jq -r '.upstreamTag // empty' <<< "${open_pr_json}")"
    work_branch="$(jq -r '.headRefName' <<< "${open_pr_json}")"
    if [[ "${open_pr_tag}" == "${upstream_tag}" && "${selection_mode}" == "requested" ]]; then
      emit_selected_release "${release_json}" "${release_branch}" "${work_branch}" "${termux_tag}"
      return 0
    fi
    if [[ "${open_pr_tag}" == "${upstream_tag}" ]]; then
      echo "${upstream_tag} already has open release PR $(jq -r '.url' <<< "${open_pr_json}"); nothing to do."
      return 1
    fi
    if [[ "${selection_mode}" != "requested" ]] && ! version_is_newer "${upstream_tag}" "${open_pr_tag}"; then
      echo "${upstream_tag} is not newer than open PR tag ${open_pr_tag}; nothing to do."
      return 1
    fi
  fi

  if [[ "${selection_mode}" != "requested" ]]; then
    current_tag="$(release_branch_current_tag "${release_branch}")"
    if ! version_is_newer "${upstream_tag}" "${current_tag}"; then
      echo "${upstream_tag} is not newer than ${current_tag} already recorded on ${release_branch}; nothing to do."
      return 1
    fi

    mirrored_tag="$(latest_mirrored_termux_tag)"
    if ! version_is_newer "${upstream_tag}" "${mirrored_tag}"; then
      echo "${upstream_tag} is not newer than ${mirrored_tag} already mirrored; nothing to do."
      return 1
    fi

    mirrored_tag="$(latest_mirrored_termux_tag_for_train "${release_train}")"
    if ! version_is_newer "${upstream_tag}" "${mirrored_tag}"; then
      echo "${upstream_tag} is not newer than ${mirrored_tag} already mirrored for ${release_train}; nothing to do."
      return 1
    fi

    if [[ "${BYPASS_PRIOR_RELEASE_TRAIN}" != "true" ]]; then
      pending_other_prs="$(open_other_release_train_prs "${release_branch}")"
      if [[ -n "${pending_other_prs}" ]]; then
        echo "${upstream_tag} is newer, but another release train PR is open."
        printf '%s\n' "${pending_other_prs}"
        return 1
      fi
    fi
  fi

  emit_selected_release "${release_json}" "${release_branch}" "${work_branch}" "${termux_tag}"
}

if [[ -n "${REQUESTED_TAG}" ]]; then
  requested_tag="$(requested_upstream_tag "${REQUESTED_TAG}")"
  if ! release_json="$(release_json_for_tag "${requested_tag}")"; then
    echo "Requested upstream release ${requested_tag} does not exist remotely."
  elif maybe_select_release "${release_json}" "requested"; then
    exit 0
  else
    echo "Requested upstream release ${requested_tag} does not need a Termux mirror."
  fi
else
  if release_json="$(latest_release_json)" && [[ -n "${release_json}" ]] && maybe_select_release "${release_json}"; then
    exit 0
  fi
fi

echo "No upstream release needs a Termux mirror."
echo "selected=false" >> "${GITHUB_OUTPUT}"
append_selection_summary "false"
