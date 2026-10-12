#!/usr/bin/env bun

import { $ } from "bun"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import pkg from "../package.json"
import top from "../../../package.json"

const dir = path.resolve(import.meta.dirname, "..")
const root = path.resolve(dir, "../..")
const dependency = pkg.dependencies["@opentui/core"]
const version = dependency === "catalog:" ? top.workspaces.catalog["@opentui/core"] : dependency

if (!version || version.includes(":")) throw new Error(`Cannot resolve @opentui/core version from ${dependency}`)

const core = [path.join(dir, "node_modules/@opentui/core"), path.join(root, "node_modules/@opentui/core")].find(
  fs.existsSync,
)
if (!core) throw new Error("Cannot find installed @opentui/core")

const head = JSON.parse((await $`npm view @opentui/core@${version} gitHead --json`.text()).trim())
if (typeof head !== "string" || !/^[0-9a-f]{40}$/.test(head)) {
  throw new Error(`Cannot resolve @opentui/core@${version} gitHead`)
}

const tmp = process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? os.tmpdir()
const source = path.join(tmp, `opentui-v2-${version}-${head.slice(0, 12)}`)
if (!fs.existsSync(path.join(source, "packages/native/build.zig"))) {
  fs.mkdirSync(source, { recursive: true })
  await $`git init`.cwd(source)
  await $`git remote add origin https://github.com/anomalyco/opentui`.cwd(source)
  await $`git fetch --depth 1 origin ${head}`.cwd(source)
  await $`git checkout --detach FETCH_HEAD`.cwd(source)
}

const ndk = androidNdk()
const libc = path.join(tmp, `android-ndk-${ndk.api}.libc`)
await Bun.write(
  libc,
  [
    `include_dir=${path.join(ndk.sysroot, "usr/include")}`,
    `sys_include_dir=${ndk.sysInclude}`,
    `crt_dir=${ndk.libDir}`,
    "msvc_lib_dir=",
    "kernel32_lib_dir=",
    "gcc_dir=",
    "",
  ].join("\n"),
)

patchOpenTUIBuild(path.join(source, "packages/native/build.zig"))
await $`sh scripts/prepare-zig-deps.sh`.cwd(path.join(source, "packages/native"))
await $`OPENCODE_ANDROID_NDK_LIBDIR=${ndk.libDir} zig build -Dlibrary-target=aarch64-linux-android -Doptimize=ReleaseFast --libc ${libc}`.cwd(
  path.join(source, "packages/native"),
)

const library = path.join(source, "packages/native/lib/aarch64-linux-android/libopentui.so")
if (!fs.existsSync(library)) throw new Error(`OpenTUI Android build did not produce ${library}`)

const name = "@opentui/core-android-arm64"
const native = path.join(path.dirname(core), "core-android-arm64")
fs.rmSync(native, { recursive: true, force: true })
fs.mkdirSync(native, { recursive: true })
fs.copyFileSync(library, path.join(native, "libopentui.so"))
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
      version,
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

const license = path.join(source, "LICENSE")
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(native, "LICENSE"))

let descriptors = 0
let loaders = 0
for (const file of fs.readdirSync(core)) {
  if (!file.endsWith(".js")) continue

  const target = path.join(core, file)
  const original = fs.readFileSync(target, "utf8")
  if (original.includes("@opentui/core-android-arm64")) continue

  const withDescriptor = original.replace(
    `var NATIVE_FILE_NAMES = {\n  darwin:`,
    `var NATIVE_FILE_NAMES = {\n  android: "libopentui.so",\n  darwin:`,
  )
  if (withDescriptor !== original) descriptors++

  const patched = withDescriptor.replace(
    `  if (process.platform === "darwin") {`,
    `  if (process.platform === "android" && process.arch === "arm64") {\n    return (await import("@opentui/core-android-arm64")).default;\n  }\n  if (process.platform === "darwin") {`,
  )
  if (patched !== withDescriptor) loaders++
  if (patched !== original) fs.writeFileSync(target, patched)
}

if (descriptors === 0 || loaders === 0) {
  throw new Error(`Did not patch @opentui/core Android runtime assets: descriptors=${descriptors}, loaders=${loaders}`)
}

function androidNdk() {
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
  if (!sysroot) throw new Error("Cannot find Android NDK sysroot. Set ANDROID_NDK_ROOT or ANDROID_NDK_HOME.")

  const libRoot = path.join(sysroot, "usr/lib/aarch64-linux-android")
  const requested = process.env.ANDROID_API_LEVEL ?? process.env.ANDROID_NDK_API ?? "24"
  const api = fs.existsSync(path.join(libRoot, requested, "libdl.so"))
    ? requested
    : fs
        .readdirSync(libRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
        .map((entry) => entry.name)
        .sort((a, b) => Number(a) - Number(b))
        .findLast((item) => fs.existsSync(path.join(libRoot, item, "libdl.so")))
  if (!api) throw new Error(`Cannot find Android NDK libraries under ${libRoot}`)

  const include = path.join(sysroot, "usr/include")
  const archInclude = path.join(include, "aarch64-linux-android")
  return {
    api,
    libDir: path.join(libRoot, api),
    sysroot,
    sysInclude: fs.existsSync(archInclude) ? archInclude : include,
  }
}

function patchOpenTUIBuild(file: string) {
  const marker = "OPENCODE_ANDROID_NDK_LIBDIR"
  const original = fs.readFileSync(file, "utf8")
  if (original.includes(marker)) return

  const before = `        .linux => {
            module.linkSystemLibrary("dl", .{});
            module.linkSystemLibrary("pthread", .{});
            module.linkSystemLibrary("m", .{});
        },`
  const after = `        .linux => {
            if (target.result.abi == .android) {
                if (b.graph.env_map.get("${marker}")) |lib_path| {
                    module.addLibraryPath(.{ .cwd_relative = lib_path });
                }
                module.linkSystemLibrary("dl", .{});
                module.linkSystemLibrary("m", .{});
            } else {
                module.linkSystemLibrary("dl", .{});
                module.linkSystemLibrary("pthread", .{});
                module.linkSystemLibrary("m", .{});
            }
        },`
  if (!original.includes(before)) throw new Error("Cannot patch OpenTUI Android system library handling")
  fs.writeFileSync(file, original.replace(before, after))
}
