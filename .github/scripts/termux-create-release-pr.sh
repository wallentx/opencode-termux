#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${UPSTREAM_REPO:?UPSTREAM_REPO is required}"
: "${UPSTREAM_TAG:?UPSTREAM_TAG is required}"
: "${UPSTREAM_NAME?UPSTREAM_NAME is required}"
: "${UPSTREAM_HTML_URL:?UPSTREAM_HTML_URL is required}"
: "${UPSTREAM_PRERELEASE:?UPSTREAM_PRERELEASE is required}"
: "${UPSTREAM_TARGET?UPSTREAM_TARGET is required}"
: "${UPSTREAM_ID?UPSTREAM_ID is required}"
: "${RELEASE_TRAIN:?RELEASE_TRAIN is required}"
: "${RELEASE_BRANCH:?RELEASE_BRANCH is required}"
: "${WORK_BRANCH:?WORK_BRANCH is required}"
: "${TERMUX_TAG:?TERMUX_TAG is required}"
: "${PATCH_BRANCH:?PATCH_BRANCH is required}"
: "${REVIEWER?REVIEWER is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
automation_root="$(cd -- "${script_dir}/../.." && pwd)"
# shellcheck source=.github/scripts/termux-release-paths.sh
source "${script_dir}/termux-release-paths.sh"

pr_title="Termux ${UPSTREAM_TAG}"
seed_dir="${RUNNER_TEMP}/termux-release-seed"

capture_seeded_release_files() {
  local seeded_path

  for seeded_path in "${TERMUX_RELEASE_AUTOMATION_PATHS[@]}"; do
    mkdir -p "${seed_dir}/$(dirname "${seeded_path}")"
    cp "${automation_root}/${seeded_path}" "${seed_dir}/${seeded_path}"
  done
}

seed_release_automation_files() {
  local seeded_path

  for seeded_path in "${TERMUX_RELEASE_AUTOMATION_PATHS[@]}"; do
    mkdir -p "$(dirname "${seeded_path}")"
    cp "${seed_dir}/${seeded_path}" "${seeded_path}"
    case "${seeded_path}" in
      .github/scripts/*.sh)
        chmod +x "${seeded_path}"
        ;;
    esac
  done
}

normalize_workspace_versions() {
  local version="${UPSTREAM_TAG#v}"
  version="${version%-termux}"

  OPENCODE_UPSTREAM_VERSION="${version}" node <<'NODE'
const fs = require("fs")
const path = require("path")

const version = process.env.OPENCODE_UPSTREAM_VERSION

function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      visit(full)
      continue
    }
    if (entry.name !== "package.json") continue
    const text = fs.readFileSync(full, "utf8")
    const pkg = JSON.parse(text)
    if (!pkg.version) continue
    if (pkg.name !== "opencode" && !String(pkg.name || "").startsWith("@opencode-ai/")) continue
    pkg.version = version
    fs.writeFileSync(full, `${JSON.stringify(pkg, null, 2)}\n`)
  }
}

visit("packages")
NODE

  if command -v bun >/dev/null 2>&1; then
    bun install --lockfile-only --ignore-scripts
  else
    echo "::warning::bun is unavailable; package versions were normalized but bun.lock was not refreshed."
  fi
}

open_prs_json() {
  gh pr list \
    --repo "${GITHUB_REPOSITORY}" \
    --state open \
    --limit 200 \
    --json number,title,body,headRefName,baseRefName,url
}

existing_open_release_pr() {
  open_prs_json \
    | jq -c \
      --arg release_branch "${RELEASE_BRANCH}" \
      '
        [
          .[]
          | select(.baseRefName == $release_branch)
          | select(
              ((.title // "") | startswith("Termux v"))
              and ((.body // "") | contains("Release branch: `" + $release_branch + "`"))
            )
        ]
        | sort_by(.number)
        | reverse
        | .[0] // empty
      '
}

enable_release_pr_automerge() {
  local pr_url="$1"
  local pr_info

  if ! pr_info="$(gh pr view "${pr_url}" --repo "${GITHUB_REPOSITORY}" --json headRefOid,mergeStateStatus,mergeable,state,url)"; then
    echo "::warning::Could not inspect ${pr_url}; leaving auto-merge disabled."
    return 0
  fi

  if [[ "$(jq -r '.state' <<< "${pr_info}")" != "OPEN" ]]; then
    return 0
  fi

  if [[ "$(jq -r '.mergeable // ""' <<< "${pr_info}")" == "CONFLICTING" || "$(jq -r '.mergeStateStatus // ""' <<< "${pr_info}")" == "DIRTY" ]]; then
    echo "Skipping auto-merge for ${pr_url}; GitHub reports conflicts."
    return 0
  fi

  gh pr merge "${pr_url}" \
    --repo "${GITHUB_REPOSITORY}" \
    --squash \
    --auto \
    --delete-branch \
    --match-head-commit "$(jq -r '.headRefOid' <<< "${pr_info}")" \
    || echo "::warning::Could not enable auto-merge for ${pr_url}."
}

append_pr_summary() {
  local outcome="$1"
  local pr_url="${2:-}"

  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0

  {
    echo "## Termux release PR"
    echo
    echo "- Outcome: ${outcome}"
    echo "- Upstream tag: \`${UPSTREAM_TAG}\`"
    echo "- Termux tag: \`${TERMUX_TAG}\`"
    echo "- Release branch: \`${RELEASE_BRANCH}\`"
    echo "- Work branch: \`${WORK_BRANCH}\`"
    echo "- Patch branch: \`${PATCH_BRANCH}\`"
    if [[ -n "${pr_url}" ]]; then
      echo "- PR: ${pr_url}"
    fi
  } >> "${GITHUB_STEP_SUMMARY}"
}

capture_seeded_release_files

release_branch_exists=false
if git ls-remote --exit-code --heads origin "${RELEASE_BRANCH}" >/dev/null 2>&1; then
  release_branch_exists=true
  git fetch origin "${RELEASE_BRANCH}"
fi

if [[ "${release_branch_exists}" == "false" ]]; then
  git checkout -B "${RELEASE_BRANCH}" "refs/tags/${UPSTREAM_TAG}"
  seed_release_automation_files
  git add -- "${TERMUX_RELEASE_AUTOMATION_PATHS[@]}"
  if ! git diff --cached --quiet; then
    git commit -m "chore(termux): seed release automation"
  fi
  git push origin "${RELEASE_BRANCH}"
fi

git fetch origin "${RELEASE_BRANCH}"
existing_pr="$(existing_open_release_pr)"
if [[ -n "${existing_pr}" && "$(jq -r '.headRefName' <<< "${existing_pr}")" != "${WORK_BRANCH}" ]]; then
  WORK_BRANCH="$(jq -r '.headRefName' <<< "${existing_pr}")"
fi

if git ls-remote --exit-code --heads origin "${WORK_BRANCH}" >/dev/null 2>&1; then
  git fetch origin "${WORK_BRANCH}"
  git checkout -B "${WORK_BRANCH}" "origin/${WORK_BRANCH}"
else
  git checkout -B "${WORK_BRANCH}" "origin/${PATCH_BRANCH}"
fi

seed_release_automation_files
normalize_workspace_versions

mkdir -p .github
jq -n \
  --arg upstream_repo "${UPSTREAM_REPO}" \
  --arg upstream_tag "${UPSTREAM_TAG}" \
  --arg upstream_name "${UPSTREAM_NAME}" \
  --arg upstream_html_url "${UPSTREAM_HTML_URL}" \
  --arg upstream_target "${UPSTREAM_TARGET}" \
  --arg upstream_release_id "${UPSTREAM_ID}" \
  --arg release_train "${RELEASE_TRAIN}" \
  --arg release_branch "${RELEASE_BRANCH}" \
  --arg work_branch "${WORK_BRANCH}" \
  --arg patch_branch "${PATCH_BRANCH}" \
  --arg patch_source_sha "$(git rev-parse "origin/${PATCH_BRANCH}")" \
  --arg termux_tag "${TERMUX_TAG}" \
  --argjson upstream_prerelease "${UPSTREAM_PRERELEASE}" \
  '{
    upstream_repo: $upstream_repo,
    upstream_tag: $upstream_tag,
    upstream_name: $upstream_name,
    upstream_html_url: $upstream_html_url,
    upstream_target: $upstream_target,
    upstream_release_id: $upstream_release_id,
    upstream_prerelease: $upstream_prerelease,
    release_train: $release_train,
    release_branch: $release_branch,
    work_branch: $work_branch,
    patch_branch: $patch_branch,
    patch_source_sha: $patch_source_sha,
    termux_tag: $termux_tag
  }' > .github/termux-release.json

git add -A
if git diff --cached --quiet; then
  echo "No changes to propose for ${UPSTREAM_TAG}."
  append_pr_summary "no changes to propose"
  exit 0
fi

git commit -m "chore(termux): prepare ${UPSTREAM_TAG}"
git push --force-with-lease origin "${WORK_BRANCH}"

body_path="${RUNNER_TEMP}/termux-release-pr.md"
{
  echo "## Termux release train"
  echo
  echo "- Upstream release: ${UPSTREAM_HTML_URL}"
  echo "- Upstream tag: \`${UPSTREAM_TAG}\`"
  echo "- Termux release tag: \`${TERMUX_TAG}\`"
  echo "- Release branch: \`${RELEASE_BRANCH}\`"
  echo "- Patch source: \`${PATCH_BRANCH}\`"
  echo
  echo "This PR carries the Termux patch branch onto the upstream release tag. If GitHub reports conflicts, resolve them by keeping upstream release code and preserving the Termux compatibility fixes."
  echo
  echo "After this PR merges, the Termux deploy workflow builds \`opencode-android-arm64\` under a GitHub Deployment, mirrors the release asset to \`${TERMUX_TAG}\`, and opens a checkpoint PR back to \`${PATCH_BRANCH}\`."
  echo
  echo "## Upstream notes"
  echo
  printf '%s\n' "${UPSTREAM_BODY}"
} > "${body_path}"

if [[ -n "${existing_pr}" ]]; then
  pr_url="$(jq -r '.url' <<< "${existing_pr}")"
  gh pr edit "${pr_url}" --repo "${GITHUB_REPOSITORY}" --title "${pr_title}" --body-file "${body_path}"
  pr_action="updated"
else
  pr_url="$(
    gh pr create \
      --repo "${GITHUB_REPOSITORY}" \
      --base "${RELEASE_BRANCH}" \
      --head "${WORK_BRANCH}" \
      --title "${pr_title}" \
      --body-file "${body_path}"
  )"
  pr_action="created"
fi

if [[ -n "${REVIEWER}" ]]; then
  gh pr edit "${pr_url}" --repo "${GITHUB_REPOSITORY}" --add-reviewer "${REVIEWER}" || true
fi
gh label create termux-release --repo "${GITHUB_REPOSITORY}" --color 0e8a16 --description "Termux release automation" --force
gh label create release-train --repo "${GITHUB_REPOSITORY}" --color 1d76db --description "Release train PR" --force
gh pr edit "${pr_url}" --repo "${GITHUB_REPOSITORY}" --add-label "termux-release" --add-label "release-train"
enable_release_pr_automerge "${pr_url}"
echo "pr_url=${pr_url}" >> "${GITHUB_OUTPUT}"
append_pr_summary "${pr_action} release train PR" "${pr_url}"
