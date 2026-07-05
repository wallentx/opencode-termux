# Guidance

## Repository Notes

- `@opentui/core@0.3.4` has no published `@opentui/core-android-arm64` package. For Android artifacts, build `anomalyco/opentui` at the package `gitHead` with Zig target `aarch64-linux-android`, create an `@opentui/core-android-arm64` package containing `libopentui.so`, and patch the OpenTUI loader to handle `process.platform === "android"`.
- `@typescript/native-preview` has no Android optional package. The Linux arm64 `tsgo` binary crashes on Termux/Android with `SIGSYS` from `fanotify_init`; a working Termux `tsgo` needs a native source build from `microsoft/typescript-go` with Linux fanotify excluded for Android.
