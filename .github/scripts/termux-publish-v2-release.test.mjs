import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
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

function publish(t, state, corrupt, existingTag = state && !state.isDraft ? "matching" : "missing") {
  const dir = mkdtempSync(join(tmpdir(), "v2-publish-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const remote = join(dir, "mirror.git")
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ALLOW_PROTOCOL: "file",
  }
  const git = (cwd, args, input) => execFileSync("git", args, { cwd, input, env: gitEnv, encoding: "utf8" }).trim()
  git(dir, ["init", "--quiet"])
  git(dir, ["init", "--quiet", "--bare", remote])
  git(dir, ["remote", "add", "origin", remote])
  git(dir, ["config", "url." + remote + ".insteadOf", "https://github.com/anomalyco/opencode.git"])
  git(remote, ["config", "user.name", "Release Test"])
  git(remote, ["config", "user.email", "release-test@example.invalid"])
  const tree = git(remote, ["hash-object", "-w", "-t", "tree", "--stdin"], "")
  const source = git(remote, ["commit-tree", tree, "-m", "V2 release source"])
  const other = git(remote, ["commit-tree", tree, "-m", "Other source"])
  git(remote, ["tag", "-a", tag, "-m", "Upstream release", corrupt === "upstream" ? other : source])
  if (existingTag === "annotated") git(remote, ["tag", "-a", release, "-m", "Fork release", source])
  if (existingTag === "matching" || existingTag === "conflict") {
    git(remote, ["tag", release, existingTag === "matching" ? source : other])
  }
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
      source_sha: corrupt === "source" ? "different commit" : source,
    }),
  )
  // Only GitHub responses are stubbed. Bash runs the real checksum and provenance checks.
  const mock = `gh() {
    if [[ "$1 $2" == "api graphql" ]]; then
      [[ "$API_FAILURE" != true ]] || return 1
      printf '%s\\n' "$RESPONSE"
    elif [[ "$1" == api ]]; then
      [[ "$*" == "api --method POST repos/$GITHUB_REPOSITORY/git/refs -f ref=refs/tags/$RELEASE_TAG -f sha=$SOURCE_SHA" ]] || return 2
      git --git-dir="$REMOTE" update-ref "refs/tags/$RELEASE_TAG" "$SOURCE_SHA" 0000000000000000000000000000000000000000
    else
      printf '%s\\n' "gh $*"
    fi
  }
  source "$1"`
  const result = spawnSync("bash", ["-c", mock, "publish-test", script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...gitEnv,
      REMOTE: remote,
      GITHUB_REPOSITORY: "test/fork",
      RUNNER_TEMP: dir,
      UPSTREAM_TAG: tag,
      RELEASE_TAG: release,
      BUILD_VERSION: "2.3.2-termux",
      AUTOMATION_SHA: "automation",
      SOURCE_SHA: source,
      RESPONSE: JSON.stringify({ data: { repository: { release: state } } }),
      API_FAILURE: String(state === "api failure"),
    },
  })
  if (result.status === 0) assert.equal(git(remote, ["rev-parse", release + "^{commit}"]), source)
  return result
}

test("a missing V2 release gets all tested assets, the upstream title and full release flags", (t) => {
  const result = publish(t, null)
  assert.equal(result.status, 0, result.stderr)
  assert.match(
    result.stdout,
    /gh release create v2\.3\.2-termux opencode-android-arm64\.tar\.gz opencode-android-arm64\.tar\.gz\.sha256 provenance\.json /,
  )
  assert.match(result.stdout, / --title v2\.3\.2 /)
  assert.match(result.stdout, / --verify-tag /)
  assert.match(result.stdout, / --latest=false\n/)
  assert.doesNotMatch(result.stdout, /--prerelease|--draft/)
})

test("an interrupted draft is uploaded before it becomes a full release", (t) => {
  const result = publish(t, { isDraft: true, isPrerelease: true }, undefined, "annotated")
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /gh release upload v2\.3\.2-termux .*--clobber\ngh release edit v2\.3\.2-termux /)
  assert.match(result.stdout, / --title v2\.3\.2 .*--latest=false --prerelease=false --draft=false/)
})

test("existing tags must peel to the tested upstream commit", (t) => {
  const matching = publish(t, null, undefined, "matching")
  assert.equal(matching.status, 0, matching.stderr)
  for (const result of [publish(t, null, undefined, "conflict"), publish(t, null, "upstream")]) {
    assert.notEqual(result.status, 0)
    assert.doesNotMatch(result.stdout, /gh release /)
    assert.match(result.stderr, /Fork tag|Upstream tag/)
  }
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
