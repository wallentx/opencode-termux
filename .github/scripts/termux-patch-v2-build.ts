#!/usr/bin/env bun

import { copyFile, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(process.argv[2] ?? ".")
const buildFile = path.join(root, "packages/cli/script/build.ts")
const marker = "opencode-termux-v2-android"
let source = await readFile(buildFile, "utf8")
const serverFile = path.join(root, "packages/cli/src/services/server-connection.ts")
const serverMarker = "opencode-termux-android-standalone"
let serverSource = await readFile(serverFile, "utf8")

if (!serverSource.includes(serverMarker)) {
  const before = `  if (args.server !== undefined && args.standalone)
    return yield* Effect.fail(new Error("--server and --standalone cannot be combined"))
  if (args.server !== undefined) {`
  const after = `  if (args.server !== undefined && args.standalone)
    return yield* Effect.fail(new Error("--server and --standalone cannot be combined"))
  // ${serverMarker}
  const standalone = args.standalone || (process.platform === "android" && args.server === undefined)
  if (args.server !== undefined) {`
  const standaloneBefore = `  if (args.standalone || (yield* ServiceConfig.read()).disabled === true) {`
  if (!serverSource.includes(before)) throw new Error("Cannot patch Android standalone server selection")
  if (!serverSource.includes(standaloneBefore)) throw new Error("Cannot patch Android standalone server startup")
  serverSource = serverSource.replace(before, after)
  serverSource = serverSource.replace(
    standaloneBefore,
    `  if (standalone || (yield* ServiceConfig.read()).disabled === true) {`,
  )
  await writeFile(serverFile, serverSource)
}

if (source.includes(marker)) {
  console.log(`V2 Android build patch already applied to ${buildFile}`)
  process.exit(0)
}

function replace(before: string, after: string) {
  const matches = source.split(before).length - 1
  if (matches !== 1) throw new Error(`Expected one V2 build match, found ${matches}: ${before.slice(0, 80)}`)
  source = source.replace(before, () => after)
}

replace(
  `const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [`,
  `const allTargets: {
  os: string
  arch: "arm64" | "x64"
  abi?: "musl"
  avx2?: false
}[] = [
  // ${marker}
  { os: "android", arch: "arm64" },`,
)

replace(
  `if (!skipInstall)
  await $\`bun install --os="*" --cpu="*" @opentui/core@\${pkg.dependencies["@opentui/core"]} @opencode-ai/pty@\${pkg.dependencies["@opencode-ai/pty"]}\`
const appArchive = path.join(dir, ".cache", "bun-app-archive.bin")`,
  `if (!skipInstall)
  await $\`bun install --os="*" --cpu="*" @opentui/core@\${pkg.dependencies["@opentui/core"]} @opencode-ai/pty@\${pkg.dependencies["@opencode-ai/pty"]}\`
if (targets.some((item) => item.os === "android")) await import("./opentui-android")
const appArchive = path.join(dir, ".cache", "bun-app-archive.bin")`,
)

replace(
  `  const parcelWatcherPackage = \`@parcel/watcher-\${item.os}-\${item.arch}\${item.os === "linux" ? \`-\${item.abi ?? "glibc"}\` : ""}\`
  const parcelWatcherPlugin: BunPlugin = {
    name: "parcel-watcher-binding",
    setup(build) {
      build.onLoad({ filter: /filesystem[/\\\\]watcher-binding\\.ts$/ }, () => ({
        contents: \`export default () => require(\${JSON.stringify(parcelWatcherPackage)})\`,
        loader: "js",
      }))
    },
  }`,
  `  const parcelWatcherPackage =
    item.os === "android"
      ? undefined
      : \`@parcel/watcher-\${item.os}-\${item.arch}\${item.os === "linux" ? \`-\${item.abi ?? "glibc"}\` : ""}\`
  const parcelWatcherPlugin: BunPlugin = {
    name: "parcel-watcher-binding",
    setup(build) {
      build.onLoad({ filter: /filesystem[/\\\\]watcher-binding\\.ts$/ }, () => ({
        contents: parcelWatcherPackage
          ? \`export default () => require(\${JSON.stringify(parcelWatcherPackage)})\`
          : "export default () => undefined",
        loader: "js",
      }))
    },
  }`,
)

replace(
  `  const executablePath = await compileExecutable(item)
  console.log(\`building \${name}\`)`,
  `  const executablePath =
    item.os === "android" ? process.env.OPENCODE_ANDROID_BUN : await compileExecutable(item)
  if (item.os === "android" && !executablePath) throw new Error("OPENCODE_ANDROID_BUN is required")
  console.log(\`building \${name}\`)`,
)

replace(
  `    entrypoints: ["./src/index.ts"],
    tsconfig: "./tsconfig.json",`,
  `    entrypoints: ["./src/index.ts"],
    tsconfig: "./tsconfig.json",
    conditions: item.os === "android" ? ["android", "bun", "node"] : ["bun", "node"],`,
)

await writeFile(buildFile, source)
await copyFile(
  path.resolve(import.meta.dirname, "termux-v2-opentui-android.ts"),
  path.join(root, "packages/cli/script/opentui-android.ts"),
)
console.log(`Applied V2 Android build patch to ${buildFile}`)
