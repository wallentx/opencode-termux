#!/usr/bin/env bun

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const OPENTUI_ANDROID_PATCH = "opencode-termux-android-v3-render-thread"
if (process.argv[2] === "--patch-only") {
  const file = process.argv[3]
  if (!file) throw new Error("Usage: opentui-android.ts --patch-only <build.zig>")
  patchOpenTUIBuild(path.resolve(file))
  if (process.argv[4]) patchOpenTUIClipboard(path.resolve(process.argv[4]))
  process.exit(0)
}
if (process.argv[2] === "--runtime-only") {
  const directory = process.argv[3]
  if (!directory) throw new Error("Usage: opentui-android.ts --runtime-only <core-directory>")
  patchOpenTUIRuntime(path.resolve(directory))
  process.exit(0)
}

const { $ } = await import("bun")
const dir = path.resolve(import.meta.dirname, "..")
const root = path.resolve(dir, "../..")
const pkg = await Bun.file(path.join(dir, "package.json")).json()
const top = await Bun.file(path.join(root, "package.json")).json()
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
const source = path.join(tmp, `opentui-v2-${version}-${head.slice(0, 12)}-${OPENTUI_ANDROID_PATCH}`)
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
patchOpenTUIClipboard(path.join(source, "packages/native/src/clipboard/host.zig"))
await $`sh scripts/prepare-zig-deps.sh`.cwd(path.join(source, "packages/native"))
await $`zig build -Dlibrary-target=aarch64-linux-android -Dandroid-lib-dir=${ndk.libDir} -Dandroid-include-dir=${path.join(ndk.sysroot, "usr/include")} -Dandroid-arch-include-dir=${ndk.sysInclude} -Doptimize=ReleaseFast --libc ${libc}`.cwd(
  path.join(source, "packages/native"),
)

const library = path.join(source, "packages/native/lib/aarch64-linux-android/libopentui.so")
if (!fs.existsSync(library)) throw new Error(`OpenTUI Android build did not produce ${library}`)

const name = "@opentui/core-android-arm64"
const native = path.join(core, "android-arm64")
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

patchOpenTUIRuntime(core)

function patchOpenTUIRuntime(directory: string) {
  let descriptorFound = false
  let loaderFound = false
  let threadPolicyFound = false
  for (const file of fs.readdirSync(directory)) {
    if (!file.endsWith(".js")) continue

    const target = path.join(directory, file)
    const original = fs.readFileSync(target, "utf8")
    const withDescriptor = original.includes(`android: "libopentui.so"`)
      ? original
      : original.replace(
          `var NATIVE_FILE_NAMES = {\n  darwin:`,
          `var NATIVE_FILE_NAMES = {\n  android: "libopentui.so",\n  darwin:`,
        )
    const withLoader = withDescriptor.includes("./android-arm64/index.bun.js")
      ? withDescriptor
      : withDescriptor.replace(
          `  if (process.platform === "darwin") {`,
          `  if (process.platform === "android" && process.arch === "arm64") {\n    return (await import("./android-arm64/index.bun.js")).default;\n  }\n  if (process.platform === "darwin") {`,
        )
    const patched = withLoader.includes(`process.platform === "linux" || process.platform === "android"`)
      ? withLoader
      : withLoader.replace(
          `    if (process.platform === "linux")\n      config.useThread = false;`,
          `    if (process.platform === "linux" || process.platform === "android")\n      config.useThread = false;`,
        )
    descriptorFound ||= patched.includes(`android: "libopentui.so"`)
    loaderFound ||= patched.includes("./android-arm64/index.bun.js")
    threadPolicyFound ||= patched.includes(`process.platform === "linux" || process.platform === "android"`)
    if (patched !== original) fs.writeFileSync(target, patched)
  }

  if (!descriptorFound || !loaderFound || !threadPolicyFound)
    throw new Error(
      `Did not patch @opentui/core Android runtime: descriptor=${descriptorFound}, loader=${loaderFound}, thread=${threadPolicyFound}`,
    )
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
  const original = fs.readFileSync(file, "utf8")
  if (original.includes(OPENTUI_ANDROID_PATCH)) return
  if (original.includes("android-lib-dir")) {
    throw new Error(`Cached OpenTUI source contains an outdated Android patch: ${file}`)
  }

  const pathsBefore = `const LIB_NAME = "opentui";
const ROOT_SOURCE_FILE = "src/lib.zig";
const GHOSTTY_VT_VERSION = "0.1.0-dev+b988efcf";`
  const pathsAfter = `const LIB_NAME = "opentui";
const ROOT_SOURCE_FILE = "src/lib.zig";
const GHOSTTY_VT_VERSION = "0.1.0-dev+b988efcf";

// ${OPENTUI_ANDROID_PATCH}
const AndroidPaths = struct {
    library: ?[]const u8 = null,
    include: ?[]const u8 = null,
    arch_include: ?[]const u8 = null,
};
var android_paths = AndroidPaths{};`
  const optionsBefore = `    const gpa_safe_stats = b.option(bool, "gpa-safe-stats", "Enable GPA safety checks for trustworthy allocator stats") orelse false;
    const macos_sdk_path = resolveMacOSSDKPath(b);`
  const optionsAfter = `    const gpa_safe_stats = b.option(bool, "gpa-safe-stats", "Enable GPA safety checks for trustworthy allocator stats") orelse false;
    android_paths = .{
        .library = b.option([]const u8, "android-lib-dir", "Android NDK library directory"),
        .include = b.option([]const u8, "android-include-dir", "Android NDK system include directory"),
        .arch_include = b.option([]const u8, "android-arch-include-dir", "Android NDK architecture include directory"),
    };
    const macos_sdk_path = resolveMacOSSDKPath(b);`
  const translatedBefore = `    miniaudio_translate.addIncludePath(b.path("src"));
    module.addImport("miniaudio", miniaudio_translate.createModule());

    const yoga_dep = b.dependency("yoga", .{});
    const yoga_translate = b.addTranslateC(.{
        .root_source_file = yoga_dep.path("yoga/Yoga.h"),
        .target = target,
        .optimize = optimize,
    });
    yoga_translate.addIncludePath(yoga_dep.path(""));`
  const translatedAfter = `    miniaudio_translate.addIncludePath(b.path("src"));
    if (target.result.abi == .android) {
        // Zig translate-c rejects NDK array-parameter nullability.
        miniaudio_translate.defineCMacro("_Nullable", "");
        if (android_paths.include) |include_path| {
            miniaudio_translate.addSystemIncludePath(.{ .cwd_relative = include_path });
        }
        if (android_paths.arch_include) |include_path| {
            miniaudio_translate.addSystemIncludePath(.{ .cwd_relative = include_path });
        }
    }
    module.addImport("miniaudio", miniaudio_translate.createModule());

    const yoga_dep = b.dependency("yoga", .{});
    const yoga_translate = b.addTranslateC(.{
        .root_source_file = yoga_dep.path("yoga/Yoga.h"),
        .target = target,
        .optimize = optimize,
    });
    yoga_translate.addIncludePath(yoga_dep.path(""));
    if (target.result.abi == .android) {
        // Keep Android header translation consistent with miniaudio.
        yoga_translate.defineCMacro("_Nullable", "");
        if (android_paths.include) |include_path| {
            yoga_translate.addSystemIncludePath(.{ .cwd_relative = include_path });
        }
        if (android_paths.arch_include) |include_path| {
            yoga_translate.addSystemIncludePath(.{ .cwd_relative = include_path });
        }
    }`
  const before = `        .linux => {
            module.linkSystemLibrary("dl", .{});
            module.linkSystemLibrary("pthread", .{});
            module.linkSystemLibrary("m", .{});
        },`
  const after = `        .linux => {
            if (target.result.abi == .android) {
                if (android_paths.library) |lib_path| {
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
  if (!original.includes(pathsBefore)) throw new Error("Cannot add OpenTUI Android path storage")
  if (!original.includes(optionsBefore)) throw new Error("Cannot add OpenTUI Android build options")
  if (!original.includes(translatedBefore)) throw new Error("Cannot patch OpenTUI Android C translation includes")
  if (!original.includes(before)) throw new Error("Cannot patch OpenTUI Android system library handling")
  fs.writeFileSync(
    file,
    original
      .replace(pathsBefore, pathsAfter)
      .replace(optionsBefore, optionsAfter)
      .replace(translatedBefore, translatedAfter)
      .replace(before, after),
  )
}

function patchOpenTUIClipboard(file: string) {
  const marker = "opencode-termux-android-pthread-join"
  const original = fs.readFileSync(file, "utf8")
  if (original.includes(marker)) return

  const declarationsBefore = `extern "c" fn pthread_mach_thread_np(thread: std.c.pthread_t) std.c.mach_port_t;
extern "c" fn pthread_tryjoin_np(thread: std.Thread.Handle, result: ?*?*anyopaque) c_int;
extern "c" fn pthread_peekjoin_np(thread: std.Thread.Handle, result: ?*?*anyopaque) c_int;`
  const declarationsAfter = `extern "c" fn pthread_mach_thread_np(thread: std.c.pthread_t) std.c.mach_port_t;
extern "c" fn pthread_tryjoin_np(thread: std.Thread.Handle, result: ?*?*anyopaque) c_int;
extern "c" fn pthread_peekjoin_np(thread: std.Thread.Handle, result: ?*?*anyopaque) c_int;
// ${marker}
extern "c" fn pthread_gettid_np(thread: std.Thread.Handle) c_int;`
  const joinBefore = `        .linux => switch (pthread_tryjoin_np(thread.getHandle(), null)) {
            0 => true,
            @intFromEnum(std.posix.E.BUSY) => false,
            else => false,
        },`
  const joinAfter = `        .linux => switch (builtin.abi) {
            .android => blk: {
                if (pthread_gettid_np(thread.getHandle()) != 0) break :blk false;
                thread.join();
                break :blk true;
            },
            else => switch (pthread_tryjoin_np(thread.getHandle(), null)) {
                0 => true,
                @intFromEnum(std.posix.E.BUSY) => false,
                else => false,
            },
        },`

  if (!original.includes(declarationsBefore)) throw new Error("Cannot patch OpenTUI Android pthread declarations")
  if (!original.includes(joinBefore)) throw new Error("Cannot patch OpenTUI Android thread join")
  fs.writeFileSync(file, original.replace(declarationsBefore, declarationsAfter).replace(joinBefore, joinAfter))
}
