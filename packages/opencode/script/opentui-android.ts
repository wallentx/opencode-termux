#!/usr/bin/env bun

import { $ } from "bun"
import fs from "fs"
import os from "os"
import path from "path"
import pkg from "../package.json"
import top from "../../../package.json"

const dir = path.resolve(import.meta.dirname, "..")
const root = path.resolve(dir, "../..")
const dep = pkg.dependencies["@opentui/core"]
const ver = dep === "catalog:" ? top.workspaces.catalog["@opentui/core"] : dep

if (!ver || ver.includes(":")) {
  throw new Error(`Cannot resolve @opentui/core version from ${dep}`)
}

const core = [path.join(dir, "node_modules/@opentui/core"), path.join(root, "node_modules/@opentui/core")].find((item) =>
  fs.existsSync(item),
)

if (!core) {
  throw new Error("Cannot find installed @opentui/core")
}

const name = "@opentui/core-android-arm64"
const native = path.join(path.dirname(core), "core-android-arm64")
const head = JSON.parse((await $`npm view @opentui/core@${ver} gitHead --json`.text()).trim())

if (!head) {
  throw new Error(`Cannot resolve @opentui/core@${ver} gitHead`)
}

const tmp = process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? os.tmpdir()
const src = path.join(tmp, `opentui-${ver}-${head.slice(0, 12)}`)
const sysroot = androidNdkSysroot()

if (!fs.existsSync(path.join(src, "packages/core/src/zig/build.zig"))) {
  fs.mkdirSync(src, { recursive: true })
  await $`git init`.cwd(src)
  await $`git remote add origin https://github.com/anomalyco/opentui`.cwd(src)
  await $`git fetch --depth 1 origin ${head}`.cwd(src)
  await $`git checkout --detach FETCH_HEAD`.cwd(src)
}

await $`zig build -Dtarget=aarch64-linux-android -Doptimize=ReleaseFast --sysroot ${sysroot}`.cwd(
  path.join(src, "packages/core/src/zig"),
)

const lib = path.join(src, "packages/core/src/zig/lib/aarch64-linux-android/libopentui.so")

if (!fs.existsSync(lib)) {
  throw new Error(`OpenTUI Android build did not produce ${lib}`)
}

fs.rmSync(native, { recursive: true, force: true })
fs.mkdirSync(native, { recursive: true })
fs.copyFileSync(lib, path.join(native, "libopentui.so"))
fs.chmodSync(path.join(native, "libopentui.so"), 0o755)

await Bun.write(
  path.join(native, "index.js"),
  `import { fileURLToPath } from "node:url"

export default fileURLToPath(new URL("./libopentui.so", import.meta.url))
`,
)
await Bun.write(
  path.join(native, "index.bun.js"),
  `const module = await import("./libopentui.so", { with: { type: "file" } })

export default module.default
`,
)
await Bun.write(path.join(native, "index.d.ts"), "declare const path: string\nexport default path\n")
await Bun.write(
  path.join(native, "package.json"),
  JSON.stringify(
    {
      name,
      version: ver,
      description: `Prebuilt android-arm64 binaries for @opentui/core`,
      type: "module",
      main: "index.js",
      module: "index.js",
      types: "index.d.ts",
      license: "MIT",
      repository: {
        type: "git",
        url: "https://github.com/anomalyco/opentui",
        directory: "packages/core",
      },
      keywords: ["prebuild", "prebuilt"],
      exports: {
        ".": {
          bun: "./index.bun.js",
          import: "./index.js",
          types: "./index.d.ts",
        },
      },
      os: ["android"],
      cpu: ["arm64"],
    },
    null,
    2,
  ) + "\n",
)
await Bun.write(path.join(native, "README.md"), `## ${name}\n\n> Prebuilt android-arm64 binaries for \`@opentui/core\`.\n`)

const license = path.join(src, "LICENSE")
if (fs.existsSync(license)) {
  fs.copyFileSync(license, path.join(native, "LICENSE"))
}

const block = `  if (process.platform === "android") {
    if (process.arch === "arm64") return await import("${name}")
  }

`
let patched = 0

for (const file of fs.readdirSync(core)) {
  if (!file.endsWith(".js")) continue

  const target = path.join(core, file)
  const text = fs.readFileSync(target, "utf8")

  if (text.includes(name)) continue
  if (!text.includes('@opentui/core-linux-arm64')) continue

  const next = text.replace('  if (process.platform === "linux") {\n', block + '  if (process.platform === "linux") {\n')
  if (next === text) continue

  fs.writeFileSync(target, next)
  patched++
}

if (patched === 0) {
  throw new Error("Did not patch @opentui/core native loader for Android")
}

function androidNdkSysroot() {
  const roots = [
    process.env.ANDROID_NDK_ROOT,
    process.env.ANDROID_NDK_HOME,
    process.env.NDK_ROOT,
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, "ndk") : undefined,
    process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, "ndk") : undefined,
    "/usr/local/lib/android/sdk/ndk",
  ].filter((item): item is string => item !== undefined && item.length > 0)

  const ndkRoots = roots.flatMap((item) => {
    if (!fs.existsSync(item)) return []
    if (fs.existsSync(path.join(item, "toolchains/llvm/prebuilt"))) return [item]
    return fs
      .readdirSync(item, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(item, entry.name))
      .sort()
      .reverse()
  })
  const sysroot = ndkRoots
    .flatMap((item) => {
      const prebuilt = path.join(item, "toolchains/llvm/prebuilt")
      if (!fs.existsSync(prebuilt)) return []
      return fs
        .readdirSync(prebuilt, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(prebuilt, entry.name, "sysroot"))
    })
    .find(
      (item) =>
        fs.existsSync(path.join(item, "usr/include")) &&
        fs.existsSync(path.join(item, "usr/lib/aarch64-linux-android")),
    )

  if (!sysroot) {
    throw new Error("Cannot find Android NDK sysroot. Set ANDROID_NDK_ROOT or ANDROID_NDK_HOME.")
  }

  return sysroot
}
