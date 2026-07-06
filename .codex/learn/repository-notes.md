# Guidance

## Repository Notes

- `@opentui/core@0.3.4` has no published `@opentui/core-android-arm64` package. For Android artifacts, build `anomalyco/opentui` at the package `gitHead` with Zig target `aarch64-linux-android`, create an `@opentui/core-android-arm64` package containing `libopentui.so`, and patch the OpenTUI loader to handle `process.platform === "android"`.
- `@typescript/native-preview` has no Android optional package. The Linux arm64 `tsgo` binary crashes on Termux/Android with `SIGSYS` from `fanotify_init`; a working Termux `tsgo` needs a native source build from `microsoft/typescript-go` with Linux fanotify excluded for Android.
- `wallentx/opencode-termux` currently follows this branch layout: `dev` is the default branch for fork CI and release automation, `termux-target` carries the clean reusable Termux compatibility patch stack, `upstream-dev` mirrors `anomalyco/opencode:dev`, and `release-*` branches are release trains.
- Termux release workflows in this repo use `vars.APP_CLIENT_ID` and `secrets.APP_PRIVATE_KEY` for the GitHub App token, with fallback to `github.token`. `termux-release-watch.yml` uses `patch_branch=termux-target`; deploy and checkpoint workflows use `destination_branch=termux-target`.
