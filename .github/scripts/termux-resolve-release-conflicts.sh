#!/usr/bin/env bash

set -euo pipefail

resolver_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
readonly resolver="${resolver_dir}/termux-resolve-release-conflicts.mjs"
mapfile -d '' -t conflicts < <(git diff --name-only --diff-filter=U -z)

if [[ "${#conflicts[@]}" -eq 0 ]]; then
  echo "::error::No release merge conflicts were found." >&2
  exit 1
fi

node "${resolver}" "${conflicts[@]}"

# The resolver preflights every output, including residual markers, before writing.
# Stage only after it succeeds, so a rejected shape leaves the index alone.
git add -- "${conflicts[@]}"
printf 'Automatically resolved %s\n' "${conflicts[@]}"
