---
name: opencode-termux-diverged-branch-recovery
description: Recover opencode termux branch pushes when local history is far ahead but remote has a few commits. Use when push says branch is behind and rebase would replay fork history.
---

# Opencode Termux Diverged Branch Recovery

## Workflow

1. Run `git status --short --branch`, fetch, and inspect `git rev-list --left-right --count HEAD...@{u}`.
2. If the branch is thousands of commits ahead and only a few behind, avoid a full rebase because it may replay the whole fork history.
3. Inspect remote-only commits with `git log --right-only HEAD...@{u}` and patch equivalence with `git cherry`.
4. If remote-only commits must be preserved, merge `origin/termux` into `termux` and resolve conflicts by keeping current dev-side files when remote touched obsolete paths.
5. Verify author identity before creating a merge commit, then push normally.

## Evidence

Repeatable branch recovery procedure from a failed push.
