import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { resolveFile } from "./termux-resolve-release-conflicts.mjs"

const source = resolveFile(
  "install",
  await readFile(new URL("./fixtures/release-conflicts/install.full", import.meta.url), "utf8"),
)
// Execute the actual version/asset selection block without downloading or installing a binary.
const start = source.indexOf('    filename="$APP-$target$archive_ext"\n')
const end = source.indexOf("    fi\nfi\n\nprint_message()", start)
assert.notEqual(start, -1)
assert.notEqual(end, -1)
const selection = source.slice(start, end + "    fi\n".length)

async function select(env = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "termux-install-selection-"))
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -eu
os="$TEST_OS"
APP=opencode
target="$TEST_OS-arm64"
archive_ext=.tar.gz
requested_version="$TEST_VERSION"
RED= MUTED= NC=
curl() {
  printf '%s\\n' "$*" >> "$TEST_CURL_LOG"
  case "$*" in
    *registry.npmjs.org*) printf '%s\\n' "$TEST_NPM_JSON" ;;
    *api.github.com*/releases/latest*) printf '%s\\n' "$TEST_FORK_JSON" ;;
    *api.github.com*/releases?per_page=100*) printf '%s\\n' "$TEST_RELEASES_JSON" ;;
    *'%{http_code}'*) printf '%s' "$TEST_ASSET_STATUS" ;;
    *) printf 'Unexpected curl call: %s\\n' "$*" >&2; return 1 ;;
  esac
}
${selection}
printf 'URL=%s\\nVERSION=%s\\n' "$url" "$specific_version"
`,
      ],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          OPENCODE_RELEASE_REPO: "",
          TEST_OS: "android",
          TEST_VERSION: "",
          TEST_FORK_JSON: '{"tag_name":"v1.19.3-termux"}',
          TEST_NPM_JSON: '{"version":"1.19.3"}',
          TEST_RELEASES_JSON: '[{"tag_name":"v2.0.27"},{"tag_name":"v1.19.2"}]',
          TEST_ASSET_STATUS: "200",
          ...env,
          TEST_CURL_LOG: path.join(dir, "curl.log"),
        },
      },
    )
    assert.ifError(result.error)
    return { ...result, calls: await readFile(path.join(dir, "curl.log"), "utf8") }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("Android latest selects and probes the exact Termux asset", async () => {
  const result = await select()
  const url =
    "https://github.com/wallentx/opencode-termux/releases/download/v1.19.3-termux/opencode-android-arm64.tar.gz"
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /VERSION=1\.19\.3-termux\n/)
  assert.ok(result.stdout.includes("URL=" + url))
  assert.ok(result.calls.includes("https://api.github.com/repos/wallentx/opencode-termux/releases/latest"))
  assert.ok(result.calls.includes(url))
  assert.doesNotMatch(result.calls, /registry\.npmjs|anomalyco\/opencode/)
})

test("explicit Termux tags probe the selected asset without latest discovery", async () => {
  const result = await select({ TEST_VERSION: "v1.19.3-termux" })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\/wallentx\/opencode-termux\/releases\/download\/v1\.19\.3-termux\//)
  assert.match(result.calls, /-sIL.*opencode-android-arm64\.tar\.gz/)
  assert.doesNotMatch(result.calls, /releases\/latest|releases\/tag|registry\.npmjs/)
})

test("custom fork latest rejects V2 and missing assets", async () => {
  const major = await select({ TEST_FORK_JSON: '{"tag_name":"v2.0.27"}' })
  assert.equal(major.status, 1)
  assert.doesNotMatch(major.stdout, /URL=/)
  assert.doesNotMatch(major.calls, /releases\/download/)
  const missing = await select({ TEST_ASSET_STATUS: "404" })
  assert.equal(missing.status, 1)
  assert.doesNotMatch(missing.stdout, /URL=/)
})

test("explicit missing assets report the fork release URL", async () => {
  const result = await select({ TEST_VERSION: "v1.19.3-termux", TEST_ASSET_STATUS: "404" })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /Available releases: https:\/\/github\.com\/wallentx\/opencode-termux\/releases/)
  assert.doesNotMatch(result.stdout, /anomalyco\/opencode|URL=/)
})

test("upstream keeps npm discovery and the V1 release-list fallback", async () => {
  const current = await select({ TEST_OS: "linux" })
  assert.equal(current.status, 0, current.stderr)
  assert.match(current.calls, /registry\.npmjs\.org\/opencode-ai\/latest/)
  assert.match(current.stdout, /anomalyco\/opencode\/releases\/download\/v1\.19\.3\/opencode-linux-arm64/)
  const pending = await select({ TEST_OS: "linux", TEST_ASSET_STATUS: "404" })
  assert.equal(pending.status, 0, pending.stderr)
  assert.match(pending.calls, /api\.github\.com\/repos\/anomalyco\/opencode\/releases\?per_page=100/)
  assert.match(pending.stdout, /VERSION=1\.19\.2\n/)
  assert.doesNotMatch(pending.calls, /releases\/latest/)
})

test("an explicit repository override remains authoritative", async () => {
  const result = await select({ OPENCODE_RELEASE_REPO: "example/opencode", TEST_FORK_JSON: '{"tag_name":"v1.19.3"}' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /example\/opencode\/releases\/download\/v1\.19\.3\//)
  assert.doesNotMatch(result.calls, /wallentx|anomalyco|registry\.npmjs/)
})
