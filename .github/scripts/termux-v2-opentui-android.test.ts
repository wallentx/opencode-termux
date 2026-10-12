import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const directories: string[] = []
const script = path.join(import.meta.dirname, "termux-v2-opentui-android.ts")
const upstream = `const LIB_NAME = "opentui";
const ROOT_SOURCE_FILE = "src/lib.zig";
const GHOSTTY_VT_VERSION = "0.1.0-dev+b988efcf";

pub fn build(b: *std.Build) void {
    const gpa_safe_stats = b.option(bool, "gpa-safe-stats", "Enable GPA safety checks for trustworthy allocator stats") orelse false;
    const macos_sdk_path = resolveMacOSSDKPath(b);
}

fn addTranslatedCImports(b: *std.Build, module: *std.Build.Module, optimize: std.builtin.OptimizeMode, target: std.Build.ResolvedTarget) void {
    const miniaudio_translate = b.addTranslateC(.{});
    miniaudio_translate.addIncludePath(b.path("src"));
    module.addImport("miniaudio", miniaudio_translate.createModule());

    const yoga_dep = b.dependency("yoga", .{});
    const yoga_translate = b.addTranslateC(.{
        .root_source_file = yoga_dep.path("yoga/Yoga.h"),
        .target = target,
        .optimize = optimize,
    });
    yoga_translate.addIncludePath(yoga_dep.path(""));
    module.addImport("yoga", yoga_translate.createModule());
}

fn addNativeAudioDependencies(b: *std.Build, module: *std.Build.Module, target: std.Build.ResolvedTarget) void {
    switch (target.result.os.tag) {
        .linux => {
            module.linkSystemLibrary("dl", .{});
            module.linkSystemLibrary("pthread", .{});
            module.linkSystemLibrary("m", .{});
        },
        else => {},
    }
}
`
const clipboard = `extern "c" fn pthread_mach_thread_np(thread: std.c.pthread_t) std.c.mach_port_t;
extern "c" fn pthread_tryjoin_np(thread: std.Thread.Handle, result: ?*?*anyopaque) c_int;
extern "c" fn pthread_peekjoin_np(thread: std.Thread.Handle, result: ?*?*anyopaque) c_int;

fn tryJoinThread(thread: std.Thread) bool {
    return switch (builtin.os.tag) {
        .linux => switch (pthread_tryjoin_np(thread.getHandle(), null)) {
            0 => true,
            @intFromEnum(std.posix.E.BUSY) => false,
            else => false,
        },
        else => false,
    };
}
`
const runtime = `var NATIVE_FILE_NAMES = {
  darwin: "libopentui.dylib"
};
async function resolveNativeLibraryPath() {
  if (process.platform === "darwin") {
    return "darwin";
  }
}
function configureRenderer(config) {
    if (process.platform === "linux")
      config.useThread = false;
}
`

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("OpenTUI Android build patch", () => {
  test("adds Android translation compatibility once", async () => {
    const file = await fixture(upstream)
    const host = await fixture(clipboard)
    expect(await patch(file, host)).toEqual({ code: 0, stderr: "" })

    const first = await readFile(file, "utf8")
    expect(first.match(/defineCMacro\("_Nullable", ""\)/g)).toHaveLength(2)
    expect(first.match(/opencode-termux-android-v3-render-thread/g)).toHaveLength(1)
    expect(first).toContain("if (target.result.abi == .android) {\n        // Zig translate-c rejects")
    expect(first).toContain("if (target.result.abi == .android) {\n        // Keep Android header translation")
    const firstHost = await readFile(host, "utf8")
    expect(firstHost).toContain("opencode-termux-android-pthread-join")
    expect(firstHost).toContain(".linux => switch (builtin.abi)")
    expect(firstHost).toContain("pthread_gettid_np(thread.getHandle())")

    expect(await patch(file, host)).toEqual({ code: 0, stderr: "" })
    expect(await readFile(file, "utf8")).toBe(first)
    expect(await readFile(host, "utf8")).toBe(firstHost)
  })

  test("rejects a stale cached patch", async () => {
    const file = await fixture("// android-lib-dir\n")
    const result = await patch(file)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("outdated Android patch")
  })

  test("adds Android runtime loading and disables render threads", async () => {
    const directory = await fixtureDirectory()
    const file = path.join(directory, "chunk.js")
    await writeFile(file, runtime)
    expect(await patchRuntime(directory)).toEqual({ code: 0, stderr: "" })

    const first = await readFile(file, "utf8")
    expect(first).toContain(`android: "libopentui.so"`)
    expect(first).toContain(`import("./android-arm64/index.bun.js")`)
    expect(first).toContain(`process.platform === "linux" || process.platform === "android"`)

    expect(await patchRuntime(directory)).toEqual({ code: 0, stderr: "" })
    expect(await readFile(file, "utf8")).toBe(first)
  })
})

async function fixture(contents: string) {
  const directory = await fixtureDirectory()
  const file = path.join(directory, "build.zig")
  await writeFile(file, contents)
  return file
}

async function fixtureDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opentui-android-patch-"))
  directories.push(directory)
  return directory
}

async function patch(file: string, host?: string) {
  const child = Bun.spawn([process.execPath, script, "--patch-only", file, ...(host ? [host] : [])], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { code, stderr }
}

async function patchRuntime(directory: string) {
  const child = Bun.spawn([process.execPath, script, "--runtime-only", directory], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { code, stderr }
}
