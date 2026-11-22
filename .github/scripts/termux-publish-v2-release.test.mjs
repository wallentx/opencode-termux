import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("./termux-publish-v2-release.sh", import.meta.url))
const archive = "opencode-android-arm64.tar.gz"
const tag = "v2.3.2"
const release = tag + "-termux"

function publish(t, state, corrupt) {
  const dir = mkdtempSync(join(tmpdir(), "v2-publish-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const checksum = createHash("sha256").update("tested archive").digest("hex")
  writeFileSync(join(dir, archive), corrupt === "archive" ? "different archive" : "tested archive")
  writeFileSync(join(dir, archive + ".sha256"), checksum + "  " + archive + "\n")
  writeFileSync(
    join(dir, "provenance.json"),
    JSON.stringify({
      source_repository: "https://github.com/anomalyco/opencode",
      source_ref: tag,
      release_tag: release,
      build_version: "2.3.2-termux",
      automation_sha: "automation",
      source_sha: corrupt === "source" ? "different commit" : "source",
    }),
  )
  // Only GitHub responses are stubbed. Bash runs the real checksum and provenance checks.
  const mock = `gh() {
    if [[ "$1" == api ]]; then
      [[ "$API_FAILURE" != true ]] || return 1
      printf '%s\\n' "$RESPONSE"
    else
      printf '%s\\n' "gh $*"
    fi
  }
  source "$1"`
  return spawnSync("bash", ["-c", mock, "publish-test", script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "test/fork",
      RUNNER_TEMP: dir,
      UPSTREAM_TAG: tag,
      RELEASE_TAG: release,
      BUILD_VERSION: "2.3.2-termux",
      AUTOMATION_SHA: "automation",
      SOURCE_SHA: "source",
      RESPONSE: JSON.stringify({ data: { repository: { release: state } } }),
      API_FAILURE: String(state === "api failure"),
    },
  })
}

test("a missing V2 release gets all tested assets, the upstream title and full release flags", (t) => {
  const result = publish(t, null)
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /gh release create v2\.3\.2-termux opencode-android-arm64\.tar\.gz opencode-android-arm64\.tar\.gz\.sha256 provenance\.json /,
  )
  assert.match(result.stdout, / --title v2\.3\.2 /)
  assert.match(result.stdout, / --latest=false\n/)
  assert.doesNotMatch(result.stdout, /--prerelease|--draft/)
})

test("an interrupted draft is uploaded before it becomes a full release", (t) => {
  const result = publish(t, { isDraft: true, isPrerelease: true })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /gh release upload v2\.3\.2-termux .*--clobber\ngh release edit v2\.3\.2-termux /)
  assert.match(result.stdout, / --title v2\.3\.2 .*--latest=false --prerelease=false --draft=false/)
})

test("a published mirror is a no-op and a conflicting prerelease fails", (t) => {
  for (const isPrerelease of [false, true]) {
    const result = publish(t, { isDraft: false, isPrerelease })
    assert.equal(result.status === 0, !isPrerelease)
    assert.doesNotMatch(result.stdout, /gh release /)
  }
})

test("failed lookups and mismatched artifacts never publish", (t) => {
  for (const result of [publish(t, "api failure"), publish(t, null, "archive"), publish(t, null, "source")]) {
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /gh release /)
  }
})
