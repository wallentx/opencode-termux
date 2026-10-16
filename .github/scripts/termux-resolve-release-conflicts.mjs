#!/usr/bin/env node

import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"

const BUILD_SCRIPT = "packages/opencode/script/build.ts"
const INSTALLATION = "packages/opencode/src/installation/index.ts"
const INSTALLATION_TEST = "packages/opencode/test/installation/installation.test.ts"

// Complete-arm SHA256 after CRLF-to-LF normalization. These fail closed when
// either upstream or the reviewed Termux patch changes.
const fingerprints = {
  gitignoreTermuxLocalTools: "2e7d315be4c68c19e0c9fb2355628331fd3a2a66bebe470f6cd77745e8cd8c10",
  gitignoreUpstreamArtifacts: "defc758c6720f3e63dbe47182a9c485a47eeed2999b3903f8dbfbdca4c906499",
  installerTermuxLatestRelease: "a0cc325d1a592cce88d11292d41e61adbdcd005c0c56ca89168c06c5d6a68bd9",
  installerUpstreamV1Discovery: "6d389d6266234651c3ba596129e881f70819d99e83d5c3e2ad3e04b0b19a57b2",
  installerTermuxTaggedRelease: "48076b4de77125971de4d282ab17ff319923da8fb94d34228d6f2243c82bd507",
  installerUpstreamTaggedRelease: "d574ed13519d1d8c29922c91f12b82aa784b989b187b18556c5f1bb42f701beb",
  installationTermuxPerMethodLatest: "c88b8dfdb7d323fe0841a4bbf070362aba9c26728866860fabc53eece638b59d",
  installationUpstreamV1Latest: "3a94b8223ad3356dd7bfe0bd599277d02d1709ca6c768c2d502b8a58b2179fb9",
  testsObsoletePerMethodLatest: "6e6d6eaf08a364c58c659ae1aa24a3cc589413e69d32c1d704c8dca2a7d03523",
  testsUpstreamUpdatePolicy: "04835dd6286f16ba17565453a59f3939f7781755852471c5348acb9ed206a2a4",
}

const supported = new Set([BUILD_SCRIPT, ".gitignore", "install", INSTALLATION, INSTALLATION_TEST])

function normalize(value) {
  return value.replaceAll("\r\n", "\n")
}

function sha256(value) {
  return createHash("sha256").update(normalize(value)).digest("hex")
}

function requireFingerprint(path, description, arm, expected) {
  const actual = sha256(arm)
  if (actual !== expected) throw new Error(`${path}: unsupported ${description} arm (SHA256 ${actual})`)
}

function requireBoundary(path, value, expected, description, mode = "endsWith") {
  const normalized = normalize(value)
  if (mode === "equals" ? normalized !== expected : !normalized.endsWith(expected)) {
    throw new Error(`${path}: expected exact ${description} anchor`)
  }
}

function replaceExactly(path, source, from, to, description) {
  const first = source.indexOf(from)
  if (first === -1 || source.indexOf(from, first + from.length) !== -1) {
    throw new Error(`${path}: expected exactly one ${description} anchor`)
  }
  return source.slice(0, first) + to + source.slice(first + from.length)
}

function requireNoMarkers(path, source) {
  if (/^(<<<<<<<|\|\|\|\|\|\|\||=======|>>>>>>>)/m.test(source)) {
    throw new Error(`${path}: conflict marker remains after resolution`)
  }
}

function parseConflicts(path, source) {
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const conflicts = []
  let state = "outside"
  let offset = 0
  let conflict

  for (const line of lines) {
    const marker = line.replace(/\r?\n$/, "")
    const markerLike =
      marker.startsWith("<<<<<<<") ||
      marker.startsWith("|||||||") ||
      marker === "=======" ||
      marker.startsWith(">>>>>>>")

    if (marker.startsWith("<<<<<<<")) {
      if (!/^<<<<<<< .+$/.test(marker) || state !== "outside") throw new Error(`${path}: malformed conflict start`)
      conflict = { start: offset, current: "", incoming: "" }
      state = "current"
    } else if (marker === "=======") {
      if (state !== "current") throw new Error(`${path}: malformed conflict separator`)
      state = "incoming"
    } else if (marker.startsWith(">>>>>>>")) {
      if (!/^>>>>>>> .+$/.test(marker) || state !== "incoming") throw new Error(`${path}: malformed conflict end`)
      conflict.end = offset + line.length
      conflicts.push(conflict)
      conflict = undefined
      state = "outside"
    } else if (markerLike) {
      throw new Error(`${path}: unsupported or malformed conflict marker`)
    } else if (state === "current") {
      conflict.current += line
    } else if (state === "incoming") {
      conflict.incoming += line
    }
    offset += line.length
  }

  if (state !== "outside") throw new Error(`${path}: unterminated conflict`)
  if (conflicts.length === 0) throw new Error(`${path}: expected at least one conflict`)
  return conflicts
}

function replaceConflicts(source, conflicts, resolutions) {
  let cursor = 0
  const chunks = conflicts.map((conflict, index) => {
    const value = source.slice(cursor, conflict.start) + resolutions[index]
    cursor = conflict.end
    return value
  })
  return chunks.join("") + source.slice(cursor)
}

function resolveBuild(path, source, conflicts) {
  if (conflicts.length !== 1) throw new Error(`${path}: expected one build conflict, found ${conflicts.length}`)
  const conflict = conflicts[0]
  const android = conflict.current.includes('if (item.os === "android")') ? conflict.current : conflict.incoming
  const darwin = conflict.current.includes('if (item.os === "darwin" && process.platform === "darwin")')
    ? conflict.current
    : conflict.incoming

  if (android === darwin || !android.includes("patchAndroidElf") || !darwin.includes("codesign --force --sign -")) {
    throw new Error(`${path}: unsupported build conflict shape`)
  }

  const after = source.slice(conflict.end)
  const closing = after.match(/^(\s*}\r?\n)/)
  if (!closing) throw new Error(`${path}: expected a shared closing brace after the conflict`)
  const newline = source.includes("\r\n") ? "\r\n" : "\n"
  return source.slice(0, conflict.start) + darwin + closing[1] + newline + android + after
}

function resolveGitignore(path, source, conflicts) {
  if (conflicts.length !== 1) throw new Error(`${path}: expected one conflict, found ${conflicts.length}`)
  const conflict = conflicts[0]
  requireFingerprint(path, "Termux local-tool ignore", conflict.current, fingerprints.gitignoreTermuxLocalTools)
  requireFingerprint(path, "upstream artifacts ignore", conflict.incoming, fingerprints.gitignoreUpstreamArtifacts)
  requireBoundary(path, source.slice(0, conflict.start), "tsconfig.tsbuildinfo\n", "pre-conflict")
  requireBoundary(path, source.slice(conflict.end), "", "end-of-file", "equals")
  return replaceConflicts(source, conflicts, [conflict.current + conflict.incoming])
}

function indent(value, spaces) {
  const prefix = " ".repeat(spaces)
  return value
    .split(/(?<=\n)/)
    .map((line) => (line.trim() ? prefix + line : line))
    .join("")
}

function installerLatestResolution(incoming, newline) {
  const upstream = indent(normalize(incoming).replaceAll("anomalyco/opencode", "${release_repo}"), 4)
  return [
    '        if [ "$release_repo" != "anomalyco/opencode" ]; then',
    '            specific_version=$(curl -fsSL --max-time 10 "https://api.github.com/repos/${release_repo}/releases/latest" 2>/dev/null | sed -n \'s/.*"tag_name": *"v\\([^\"]*\\)".*/\\1/p\' || true)',
    '            if [[ "$specific_version" =~ ^1\\.[0-9]+\\.[0-9]+(-(alpha|beta|rc)\\.[0-9]+)?(-termux)?$ ]]; then',
    '                asset_status=$(curl -sIL --max-time 10 -o /dev/null -w "%{http_code}" "https://github.com/${release_repo}/releases/download/v${specific_version}/$filename" || true)',
    '                if [ "$asset_status" != "200" ]; then',
    '                    specific_version=""',
    "                fi",
    "            else",
    '                specific_version=""',
    "            fi",
    "        else",
    upstream.replace(/\n$/, ""),
    "        fi",
    "",
  ]
    .join("\n")
    .replaceAll("\n", newline)
}

function installerTaggedResolution(newline) {
  return (
    [
      "        # Strip leading 'v' if present",
      '        requested_version="${requested_version#v}"',
      '        url="https://github.com/${release_repo}/releases/download/v${requested_version}/$filename"',
      "        specific_version=$requested_version",
      "",
      "        # Verify the release asset exists before downloading. A release that is still publishing has none yet.",
      '        http_status=$(curl -sIL --max-time 10 -o /dev/null -w "%{http_code}" "$url" || true)',
      '        if [ "$http_status" = "404" ]; then',
      '            echo -e "${RED}Error: Release v${requested_version} not found. If it was just released, try again in a few minutes.${NC}"',
      '            echo -e "${MUTED}Available releases: https://github.com/${release_repo}/releases${NC}"',
    ]
      .join("\n")
      .replaceAll("\n", newline) + newline
  )
}

function resolveInstaller(path, source, conflicts) {
  if (conflicts.length !== 2) throw new Error(`${path}: expected two conflicts, found ${conflicts.length}`)
  requireFingerprint(path, "Termux latest-release", conflicts[0].current, fingerprints.installerTermuxLatestRelease)
  requireFingerprint(path, "upstream V1 discovery", conflicts[0].incoming, fingerprints.installerUpstreamV1Discovery)
  requireFingerprint(path, "Termux tagged-release", conflicts[1].current, fingerprints.installerTermuxTaggedRelease)
  requireFingerprint(
    path,
    "upstream tagged-release",
    conflicts[1].incoming,
    fingerprints.installerUpstreamTaggedRelease,
  )
  requireBoundary(
    path,
    source.slice(0, conflicts[0].start),
    '    if [ -z "$requested_version" ]; then\n',
    "latest-release",
  )
  requireBoundary(path, source.slice(conflicts[0].end, conflicts[1].start), "    else\n", "tagged-release")

  const newline = source.includes("\r\n") ? "\r\n" : "\n"
  const resolved = replaceConflicts(source, conflicts, [
    installerLatestResolution(conflicts[0].incoming, newline),
    installerTaggedResolution(newline),
  ])
  return replaceExactly(
    path,
    resolved,
    '        url="https://github.com/anomalyco/opencode/releases/download/v${specific_version}/$filename"',
    '        url="https://github.com/${release_repo}/releases/download/v${specific_version}/$filename"',
    "resolved latest download URL",
  )
}

function installationLatestResolution(path, incoming) {
  const anchor = "        return yield* Effect.gen(function* () {\n"
  const fork =
    [
      '        if ((method === "curl" || method === "unknown") && releaseRepo() !== UPSTREAM_RELEASE_REPO) {',
      "          return yield* Effect.gen(function* () {",
      "            const response = yield* httpOk.execute(",
      "              HttpClientRequest.get(`https://api.github.com/repos/${releaseRepo()}/releases/latest`).pipe(",
      "                HttpClientRequest.acceptJson,",
      "              ),",
      "            )",
      "            const data = yield* HttpClientResponse.schemaBodyJson(",
      "              Schema.Struct({ tag_name: Schema.String }),",
      "            )(response)",
      '            const found = data.tag_name.replace(/^v/, "")',
      "            if (!isUpdate(InstallationVersion, found)) return InstallationVersion",
      "            return found",
      '          }).pipe(Effect.timeout("10 seconds"))',
      "        }",
      "",
    ].join("\n") + "\n"
  return replaceExactly(path, normalize(incoming), anchor, fork + anchor, "upstream npm latest")
}

function resolveInstallation(path, source, conflicts) {
  if (conflicts.length !== 1) throw new Error(`${path}: expected one conflict, found ${conflicts.length}`)
  const conflict = conflicts[0]
  requireFingerprint(path, "Termux per-method latest", conflict.current, fingerprints.installationTermuxPerMethodLatest)
  requireFingerprint(path, "upstream V1 latest", conflict.incoming, fingerprints.installationUpstreamV1Latest)
  requireBoundary(
    path,
    source.slice(0, conflict.start),
    '      latest: Effect.fn("Installation.latest")(function* (installMethod?: Method) {\n',
    "latest function",
  )

  const newline = source.includes("\r\n") ? "\r\n" : "\n"
  let resolved = replaceConflicts(source, conflicts, [
    installationLatestResolution(path, conflict.incoming).replaceAll("\n", newline),
  ])
  const from = [
    '      upgradeMajor: Effect.fn("Installation.upgradeMajor")(function* (m: Method) {',
    "        const outcome = yield* majorUpgrade(m)",
  ].join(newline)
  const to = [
    '      upgradeMajor: Effect.fn("Installation.upgradeMajor")(function* (m: Method) {',
    '        if (m === "curl" && releaseRepo() !== UPSTREAM_RELEASE_REPO)',
    "          return yield* new UpgradeFailedError({",
    "            stderr: `OpenCode 2 can't be installed automatically from ${releaseRepo()} with curl. See ${MAJOR_INSTRUCTIONS}`,",
    "          })",
    "        const outcome = yield* majorUpgrade(m)",
  ].join(newline)
  return replaceExactly(path, resolved, from, to, "custom-fork major-upgrade guard")
}

const forkLatestTests = `    for (const method of ["curl", "unknown"] as const) {
      const calls: string[] = []
      testEffect(
        testLayer((request) => {
          calls.push(request.url)
          return jsonResponse({ tag_name: "v1.99.0-termux" })
        }),
      ).effect(\`reads custom fork releases for \${method} installs\`, () =>
        Effect.gen(function* () {
          const original = process.env.OPENCODE_RELEASE_REPO
          process.env.OPENCODE_RELEASE_REPO = "wallentx/opencode-termux"
          try {
            calls.length = 0
            expect(yield* Installation.use.latest(method)).toBe("1.99.0-termux")
            expect(calls).toEqual(["https://api.github.com/repos/wallentx/opencode-termux/releases/latest"])
          } finally {
            if (original === undefined) delete process.env.OPENCODE_RELEASE_REPO
            else process.env.OPENCODE_RELEASE_REPO = original
          }
        }),
      )
    }

`

const forkMajorTest = `    const forkMajorCalls: string[] = []
    testEffect(
      testLayer(
        (request) => {
          forkMajorCalls.push(request.url)
          return new Response("unexpected", { status: 200 })
        },
        (cmd) => {
          forkMajorCalls.push(cmd)
          return ""
        },
      ),
    ).effect("refuses the upstream OpenCode 2 installer for custom curl releases", () =>
      Effect.gen(function* () {
        const original = process.env.OPENCODE_RELEASE_REPO
        process.env.OPENCODE_RELEASE_REPO = "wallentx/opencode-termux"
        try {
          forkMajorCalls.length = 0
          const error = yield* Effect.flip(Installation.use.upgradeMajor("curl"))
          expect(error).toBeInstanceOf(Installation.UpgradeFailedError)
          expect(error.stderr).toContain(Installation.MAJOR_INSTRUCTIONS)
          expect(forkMajorCalls).toEqual([])
        } finally {
          if (original === undefined) delete process.env.OPENCODE_RELEASE_REPO
          else process.env.OPENCODE_RELEASE_REPO = original
        }
      }),
    )

`

function resolveInstallationTests(path, source, conflicts) {
  if (conflicts.length !== 1) throw new Error(`${path}: expected one conflict, found ${conflicts.length}`)
  const conflict = conflicts[0]
  requireFingerprint(
    path,
    "obsolete per-method latest tests",
    conflict.current,
    fingerprints.testsObsoletePerMethodLatest,
  )
  requireFingerprint(path, "upstream update-policy tests", conflict.incoming, fingerprints.testsUpstreamUpdatePolicy)
  requireBoundary(path, source.slice(0, conflict.start), 'describe("installation", () => {\n', "installation describe")

  const newline = source.includes("\r\n") ? "\r\n" : "\n"
  let resolved = replaceConflicts(source, conflicts, [conflict.incoming])
  const latestAnchor =
    '    const methods = ["curl", "yarn", "unknown", "npm", "bun", "pnpm", "scoop", "choco"] as const\n'
  resolved = replaceExactly(
    path,
    resolved,
    latestAnchor.replaceAll("\n", newline),
    forkLatestTests.replaceAll("\n", newline) + latestAnchor.replaceAll("\n", newline),
    "custom-fork latest tests",
  )
  const majorAnchor = "    const chocoCalls: string[] = []\n"
  return replaceExactly(
    path,
    resolved,
    majorAnchor.replaceAll("\n", newline),
    forkMajorTest.replaceAll("\n", newline) + majorAnchor.replaceAll("\n", newline),
    "custom-fork major-upgrade test",
  )
}

export function resolveFile(path, source) {
  const normalizedPath = path.startsWith("./") ? path.slice(2) : path
  if (!supported.has(normalizedPath)) throw new Error(`Unsupported release merge conflict: ${path}`)
  const conflicts = parseConflicts(normalizedPath, source)
  const resolved =
    normalizedPath === BUILD_SCRIPT
      ? resolveBuild(normalizedPath, source, conflicts)
      : normalizedPath === ".gitignore"
        ? resolveGitignore(normalizedPath, source, conflicts)
        : normalizedPath === "install"
          ? resolveInstaller(normalizedPath, source, conflicts)
          : normalizedPath === INSTALLATION
            ? resolveInstallation(normalizedPath, source, conflicts)
            : resolveInstallationTests(normalizedPath, source, conflicts)
  requireNoMarkers(normalizedPath, resolved)
  return resolved
}

async function main(paths) {
  if (paths.length === 0) throw new Error("Expected at least one conflicted path")
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate conflicted paths are not supported")
  for (const path of paths) {
    const normalizedPath = path.startsWith("./") ? path.slice(2) : path
    if (!supported.has(normalizedPath)) throw new Error(`Unsupported release merge conflict: ${path}`)
  }

  // Compute the complete set before the first write.
  const resolutions = await Promise.all(
    paths.map(async (path) => ({ path, source: resolveFile(path, await readFile(path, "utf8")) })),
  )
  await Promise.all(resolutions.map((item) => writeFile(item.path, item.source)))
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
