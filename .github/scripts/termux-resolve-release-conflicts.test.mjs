import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { stripTypeScriptTypes } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import { resolveFile } from "./termux-resolve-release-conflicts.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, "fixtures/release-conflicts")
const helper = path.join(here, "termux-resolve-release-conflicts.mjs")
const shell = path.join(here, "termux-resolve-release-conflicts.sh")
const readFixture = (name) => readFile(path.join(fixtures, name), "utf8")

function conflict(current, incoming) {
  return "<<<<<<< HEAD\n" + current + "=======\n" + incoming + ">>>>>>> origin/release-1.19.3\n"
}

async function inputs() {
  return {
    gitignore: await readFixture("gitignore.full"),
    install: await readFixture("install.full"),
    index: await readFixture("installation-index.full"),
    tests: await readFixture("installation-test.full"),
  }
}

test("resolves all reviewed release conflicts and retains both sides' behavior", async () => {
  const source = await inputs()
  const output = [
    resolveFile(".gitignore", source.gitignore),
    resolveFile("install", source.install),
    resolveFile("packages/opencode/src/installation/index.ts", source.index),
    resolveFile("packages/opencode/test/installation/installation.test.ts", source.tests),
    resolveFile(
      "packages/opencode/script/build.ts",
      'async function build() {\n<<<<<<< HEAD\n  if (item.os === "android") {\n    await patchAndroidElf(binary)\n=======\n  if (item.os === "darwin" && process.platform === "darwin") {\n    await $`codesign --force --sign - ${binary}`\n>>>>>>> upstream\n  }\n}\n',
    ),
  ]
  for (const value of output) assert.doesNotMatch(value, /^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/m)
  assert.match(output[0], /\.codex\/\n\/artifacts\/\n$/)
  assert.match(output[1], /registry\.npmjs\.org\/opencode-ai\/latest/)
  assert.match(output[1], /github\.com\/\$\{release_repo\}\/releases\/download/)
  assert.match(output[2], /releaseRepo\(\) !== UPSTREAM_RELEASE_REPO/)
  assert.match(output[2], /OpenCode 2 can't be installed automatically/)
  assert.match(output[3], /only counts newer releases in the installed major version/)
  assert.match(output[3], /custom fork releases/)
  assert.match(output[4], /codesign --force --sign -/)
  assert.match(output[4], /patchAndroidElf/)
  assert.doesNotThrow(() => stripTypeScriptTypes(output[2]))
  assert.doesNotThrow(() => stripTypeScriptTypes(output[3]))
  assert.doesNotThrow(() => stripTypeScriptTypes(output[4]))
})

test("rejects unknown, malformed, reversed, altered, and extra conflict data", async () => {
  const value = await readFixture("gitignore.conflict")
  assert.throws(() => resolveFile("unknown", value), /Unsupported release merge conflict/)
  assert.throws(() => resolveFile(".gitignore", value.replace("<<<<<<< HEAD", "<<<<<<<")), /malformed conflict start/)
  assert.throws(
    () => resolveFile(".gitignore", "tsconfig.tsbuildinfo\n" + conflict("/artifacts/\n", ".codex/\n")),
    /unsupported Termux local-tool ignore arm/,
  )
  assert.throws(
    () => resolveFile(".gitignore", "tsconfig.tsbuildinfo\n" + value.replace(".codex/", ".cache/")),
    /unsupported Termux local-tool ignore arm/,
  )
  assert.throws(() => resolveFile(".gitignore", "tsconfig.tsbuildinfo\n" + value + value), /expected one conflict/)
  assert.throws(
    () => resolveFile(".gitignore", "tsconfig.tsbuildinfo\n" + value + "||||||| base\n"),
    /unsupported or malformed conflict marker/,
  )
})

test("preserves CRLF and does not write an earlier valid file when a later input fails", async () => {
  const source = await inputs()
  const crlf = resolveFile("install", source.install.replaceAll("\n", "\r\n"))
  assert.doesNotMatch(crlf, /\r\r\n/)
  const dir = await mkdtemp(path.join(tmpdir(), "resolver-test-"))
  try {
    await writeFile(path.join(dir, ".gitignore"), source.gitignore)
    await mkdir(path.join(dir, "packages/opencode/src/installation"), { recursive: true })
    const altered = source.index.replace("const detectedMethod", "const changedMethod")
    await writeFile(path.join(dir, "packages/opencode/src/installation/index.ts"), altered)
    const result = spawnSync(process.execPath, [helper, ".gitignore", "packages/opencode/src/installation/index.ts"], {
      cwd: dir,
      encoding: "utf8",
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /unsupported Termux per-method latest arm/)
    assert.equal(await readFile(path.join(dir, ".gitignore"), "utf8"), source.gitignore)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("shell resolver stages a known subset from a seeded worktree without a helper", async () => {
  const source = await inputs()
  const dir = await mkdtemp(path.join(tmpdir(), "resolver-shell-"))
  const git = (args, options = {}) => execFileSync("git", args, { cwd: dir, encoding: "utf8", ...options })
  try {
    git(["init", "--quiet"])
    await writeFile(path.join(dir, ".gitignore"), source.gitignore)
    const object = (value) => git(["hash-object", "-w", "--stdin"], { input: value }).trim()
    git(["update-index", "--force-remove", "--", ".gitignore"])
    git(["update-index", "--index-info"], {
      input: "100644 " + object("ours\n") + " 2\t.gitignore\n100644 " + object("theirs\n") + " 3\t.gitignore\n",
    })
    const result = spawnSync("bash", [shell], { cwd: dir, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(git(["diff", "--name-only", "--diff-filter=U"]), "")
    assert.equal(git(["show", ":0:.gitignore"]), resolveFile(".gitignore", source.gitignore))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
