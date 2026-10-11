# Production-app worktree settings acceptance

Built from tree `bc1cf76b24f2fb862d9dd3e609fe4ffcca5694f1` (head `02cabbcbb69aee73c1915a2161f17010400df56a`). Chromium drives the normal app; the provider settings are disabled and no NativeApi is replaced. The check verifies default off, real settings-file persistence, reload retaining on, and persistence after reverting off. The PNGs show the actual settings page with empty inventory in both states.

Run after building web and server, from the repository root:

```sh
SYNARA_CHROMIUM_PATH=/path/to/chromium node docs/verification/worktree-settings-real-check.mjs
```

Actual merged cleanup is separately verified by `managedWorktrees.live.test.ts` and the [passing native Git/live GitHub workflow](https://github.com/Emanuele-web04/synara/actions/runs/38166682691). It uses real GitHub metadata, a native locked-worktree failure and retry, recovery snapshot verification, and native branch retention. The settings screenshots alone are not evidence of file removal.

After integrating main `52f06318fdb3c0b4b310a8d55d0083cba0bde1a0`, production web and CLI were rebuilt and this same actual-app persistence flow passed again. The default and enabled PNGs plus raw output now show the combined code. All 66 focused cleanup/Git/SQLite tests pass, including both newly integrated history checks and the cleanup delivery regression. Native managed cleanup also passes on head `81e3a917aa53c09053d0df15f070064c53fa5d33` in run [38175017444](https://github.com/Emanuele-web04/synara/actions/runs/38175017444).
