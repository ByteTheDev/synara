# Production worktree settings verification

The production app at `c19986ee0` was driven through actual Chromium in a disposable home on 12 October 2026. Every provider was disabled; no NativeApi was replaced. The test passed default-off, real settings-file persistence, reload retaining on, and reverting off. The adjacent default/enabled PNGs are from that run.

After building web and server, run from the repository root:

```sh
node docs/verification/worktree-settings-real-check.mjs
```

The separate `SYNARA_LIVE_GITHUB=1 bun run --cwd apps/server test src/managedWorktrees.live.test.ts` also passed against native Git and live GitHub metadata, including locked removal refusal, snapshot preservation, retry, and retained branches. The settings screenshots alone do not prove file removal.
