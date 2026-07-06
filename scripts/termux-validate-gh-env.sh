#!/usr/bin/env bash

set -euo pipefail

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${GH_TOKEN:?GH_TOKEN is required}"

command -v gh
command -v jq
gh auth status --hostname github.com

printf 'GITHUB_REPOSITORY=%s\n' "${GITHUB_REPOSITORY}"
printf 'GITHUB_REF_NAME=%s\n' "${GITHUB_REF_NAME:-}"
