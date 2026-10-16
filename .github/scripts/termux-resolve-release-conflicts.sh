#!/usr/bin/env bash

set -euo pipefail

readonly build_script=packages/opencode/script/build.ts
mapfile -t conflicts < <(git diff --name-only --diff-filter=U)

if [[ "${#conflicts[@]}" -ne 1 || "${conflicts[0]}" != "${build_script}" ]]; then
  echo "::error::Unsupported release merge conflicts:" >&2
  printf '  %s\n' "${conflicts[@]:-none}" >&2
  exit 1
fi

node - "${build_script}" <<'NODE'
const fs = require("fs")

const path = process.argv[2]
const source = fs.readFileSync(path, "utf8")
const conflicts = [...source.matchAll(/^<<<<<<< .*\n([\s\S]*?)^=======\n([\s\S]*?)^>>>>>>> .*\n/gm)]

if (conflicts.length !== 1) {
  throw new Error(`Expected one conflict in ${path}, found ${conflicts.length}`)
}

const conflict = conflicts[0]
const current = conflict[1]
const incoming = conflict[2]
const android = current.includes('if (item.os === "android")') ? current : incoming
const darwin = current.includes('if (item.os === "darwin" && process.platform === "darwin")') ? current : incoming

if (android === darwin || !android.includes("patchAndroidElf") || !darwin.includes("codesign --force --sign -")) {
  throw new Error(`Unsupported build conflict shape in ${path}`)
}

const before = source.slice(0, conflict.index)
const after = source.slice(conflict.index + conflict[0].length)
const closing = after.match(/^(\s*}\r?\n)/)

if (!closing) {
  throw new Error(`Expected a shared closing brace after the conflict in ${path}`)
}

fs.writeFileSync(path, before + darwin + closing[1] + "\n" + android + after)
NODE

if rg -n '^(<<<<<<<|=======|>>>>>>>)' "${build_script}"; then
  echo "::error::Conflict markers remain in ${build_script}." >&2
  exit 1
fi

git add -- "${build_script}"
echo "Automatically resolved ${build_script} by preserving the upstream macOS signing and Termux Android patching blocks."
