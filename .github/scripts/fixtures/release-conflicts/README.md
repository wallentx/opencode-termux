# Release conflict fixtures

These fixtures cover the four conflict shapes observed while merging
`origin/release-1.19.3` into the Termux release branch on 2026-10-16:

- `.gitignore`
- `install`
- `packages/opencode/src/installation/index.ts`
- `packages/opencode/test/installation/installation.test.ts`

The fixtures preserve the exact reviewed arms and boundary anchors used by the
resolver. They are pinned to Termux target
`e060931f85a3a471bd676f174b7011842edfe1fc` and incoming release
`844bc0502b6e584e35878935c27e383142c20308` (upstream `v1.19.3`).
