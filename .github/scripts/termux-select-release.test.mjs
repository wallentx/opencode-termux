import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const selector = fileURLToPath(new URL("./termux-select-release.sh", import.meta.url))
const gh = `#!/usr/bin/env bash
set -eu
case "$*" in
  "api graphql --paginate "*)
    if [[ "$FAIL_API" = pages ]]; then exit 1; fi
    printf '%s\\n' "$PAGES"
    ;;
  "api graphql "*)
    if [[ "$FAIL_API" = mirror ]]; then exit 1; fi
    case "$*" in
      *"tag=$EXPECTED_TAG-termux "*) printf '{"data":{"repository":{"release":%s}}}\\n' "$MIRROR";;
      *) exit 2;;
    esac
    ;;
  "api --method GET repos/example/upstream/releases/tags/$EXPECTED_TAG")
    jq -nc --arg tag "$EXPECTED_TAG" '{tag_name:$tag,name:$tag,html_url:"example",body:"notes",target_commitish:"dev",id:123,draft:false,prerelease:false}'
    ;;
  "pr list "*)
    [[ "$RELEASE_MAJOR" = 1 ]]
    printf '%s\\n' "$PRS"
    ;;
  *) exit 2;;
esac
`
const release = (tagName, flags = {}) => ({ tagName, isDraft: false, isPrerelease: false, ...flags })
const pages = [
  [
    release("process-daemon-v9.0.0"),
    release("v1.20.0", { isDraft: true }),
    release("v2.10.0", { isPrerelease: true }),
    release("v2.9.0-beta.1"),
    release("v1.8.9"),
  ],
  [release("v2.3.2"), release("v1.19.6"), release("v2.2.10")],
]
  .map((nodes) => JSON.stringify({ data: { repository: { releases: { nodes } } } }))
  .join("\n")

function select(major, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "select-release-"))
  try {
    const output = path.join(dir, "output")
    writeFileSync(output, "")
    writeFileSync(path.join(dir, "gh"), gh, { mode: 0o755 })
    const result = spawnSync("bash", [selector], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: dir + path.delimiter + process.env.PATH,
        GITHUB_REPOSITORY: "example/fork",
        UPSTREAM_REPO: "example/upstream",
        GH_TOKEN: "fixture",
        RELEASE_MAJOR: String(major),
        REQUESTED_TAG: "",
        BYPASS_PRIOR_RELEASE_TRAIN: "false",
        DISCOVERY_ONLY: "false",
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: "",
        EXPECTED_TAG: major === 1 ? "v1.19.6" : "v2.3.2",
        PAGES: pages,
        MIRROR: "null",
        FAIL_API: "",
        PRS: "[]",
        ...overrides,
      },
    })
    assert.ifError(result.error)
    return { ...result, output: readFileSync(output, "utf8") }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

for (const [major, tag] of [
  [1, "v1.19.6"],
  [2, "v2.3.2"],
]) {
  test(`selects the newest full release in major ${major} across pages`, () => {
    const result = select(major)
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.output.includes(`termux_tag=${tag}-termux\n`))
    assert.match(result.output, /^upstream_prerelease=false$/m)
    const existing = select(major, { MIRROR: '{"isDraft":false,"isPrerelease":false}' })
    assert.equal(existing.status, 0, existing.stderr)
    assert.match(existing.output, /^selected=false$/m)
  })
}

test("an open V1 train only postpones the V1 mirror", () => {
  const PRS = JSON.stringify([
    {
      number: 10,
      baseRefName: "release-1.19.5",
      headRefName: "termux-1.19.5",
      title: "Termux v1.19.5",
      body: "Release branch: `release-1.19.5`",
    },
  ])
  for (const major of [1, 2]) {
    const result = select(major, { PRS })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.output.includes(`selected=${major === 2}\n`))
  }
})

test("explicit V2 dispatch skips V1 and uses the requested tag", () => {
  const requested = { REQUESTED_TAG: "refs/tags/v2.3.1", EXPECTED_TAG: "v2.3.1", FAIL_API: "pages" }
  assert.match(select(1, requested).output, /^selected=false$/m)
  const result = select(2, requested)
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.output, /^upstream_tag=v2\.3\.1$/m)
})

test("API errors never select a release for publication", () => {
  for (const FAIL_API of ["pages", "mirror"]) {
    const result = select(2, { FAIL_API })
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.output, /selected=true/)
  }
})
