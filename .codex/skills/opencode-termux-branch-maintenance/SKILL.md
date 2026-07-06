---
name: opencode-termux-branch-maintenance
description: Maintain the opencode-termux fork branch split between dev automation, termux-target compatibility patches, and upstream-dev mirror. Use when repairing branch layout, checkpoint targets, or fork-local PR views.
---

# Opencode Termux Branch Maintenance

## Workflow

1. Check `git status --short --branch` and verify the effective git author before commits or pushes.
2. Fetch `origin` and `upstream`; ensure `origin` points to `wallentx/opencode-termux`.
3. Preserve the split:
   - `dev`: fork CI and release automation.
   - `termux-target`: minimal upstream-reviewable Termux source/runtime changes.
   - `upstream-dev`: exact mirror of `anomalyco/opencode:dev`.
4. Mirror `upstream/dev` to `upstream-dev`.
5. Keep release workflow defaults pointed at `termux-target`.
6. Build or repair `termux-target` from the upstream mirror by applying only selected Android source/runtime changes.
7. Open a fork-local PR from `termux-target` to `upstream-dev`.
8. Close stale checkpoint PRs that target obsolete mixed branches.
9. Delete obsolete branches only after `git ls-remote` proves the work is retained elsewhere.
10. Finish by verifying the default branch, branch list, PR shape, local tracking, and `origin/HEAD`.

## Guardrails

- Do not let fork automation, release helper scripts, `.codex` learning files, AGENTS changes, or downloaded artifacts leak into `termux-target`.
- Checkpoint PRs must target `termux-target`, not the automation branch.

## Evidence

This sequence successfully converted the fork from the old mixed `termux` layout to `dev`, `termux-target`, and `upstream-dev` while preserving release automation and clean compatibility review.
