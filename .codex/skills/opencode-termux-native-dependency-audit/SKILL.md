---
name: opencode-termux-native-dependency-audit
description: Audit opencode Android artifact dependencies for missing Android native packages, then add source-build or loader fixes. Use when maintaining Termux/Android CI artifacts in this repo.
---

# Opencode Termux Native Dependency Audit

## Workflow

1. Search package manifests and lockfile for native optional packages.
2. Check whether each dependency publishes an Android arm64 package.
3. For missing Android binaries, locate the source repo and pinned version or `gitHead`.
4. Add CI source-build steps for Android instead of wrappers when source is available.
5. Patch runtime loaders/import conditions so `process.platform === "android"` resolves the Android artifact or a safe fallback.
6. Validate with `git diff --check`, package syntax checks, focused `bun build` checks, and CI workflow YAML parsing.

## Evidence

Repeatable workflow from the Termux artifact repair.
