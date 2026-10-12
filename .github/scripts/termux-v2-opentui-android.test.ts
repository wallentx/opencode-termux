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

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe("OpenTUI Android build patch", () => {
  test("adds Android translation compatibility once", async () => {
    const file = await fixture(upstream)
    expect(await patch(file)).toEqual({ code: 0, stderr: "" })

    const first = await readFile(file, "utf8")
    expect(first.match(/defineCMacro\("_Nullable", ""\)/g)).toHaveLength(2)
    expect(first.match(/opencode-termux-android-v1-nullability/g)).toHaveLength(1)
    expect(first).toContain("if (target.result.abi == .android) {\n        // Zig translate-c rejects")
    expect(first).toContain("if (target.result.abi == .android) {\n        // Keep Android header translation")

    expect(await patch(file)).toEqual({ code: 0, stderr: "" })
    expect(await readFile(file, "utf8")).toBe(first)
  })

  test("rejects a stale cached patch", async () => {
    const file = await fixture("// android-lib-dir\n")
    const result = await patch(file)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain("outdated Android patch")
  })
})

async function fixture(contents: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opentui-android-patch-"))
  directories.push(directory)
  const file = path.join(directory, "build.zig")
  await writeFile(file, contents)
  return file
}

async function patch(file: string) {
  const child = Bun.spawn([process.execPath, script, "--patch-only", file], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  return { code, stderr }
}
