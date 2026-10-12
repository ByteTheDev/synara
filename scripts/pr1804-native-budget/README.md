# PR #1804 — exact native startup, checkpoint and ownership observations

This isolated diagnostic measures the production startup-grace feature and a separately reviewed Windows readiness dependency. It does not publish or restack a feature branch, change a production deadline, send a provider prompt, or merge anything into main.

## Immutable sources

| Side | Exact source | Git tree | Tracked files |
| --- | --- | --- | --- |
| Before | `e32a73c59ac4ffef6e8367406914f514610e0dbb` | `2821b44a7a892178ecfff12874cce4256fe0684a` | 9,025 |
| After | `a06d5b2bbf704e19aeeb027762f59a4a1dbad066` | `7ed7570f4849bfd7797439048ec8b6974c5d98e7` | 9,025 |

Before is the exact published #1804 feature. After has ordered parents [Before, `879dc7b2c727d781995a012c509bccd2cf7af505`] and only six byte-identical files from the independently reviewed #1848 Windows preparation/readiness feature. The #1804 production reactor and all its canonical test bytes are identical on both sides. Every other tracked byte and mode is checked against its immutable tree before and after each command and after restoration.

Both sources run on Ubuntu 24.04 and Windows Server 2022. Each job checks all eight diagnostic files against its own immutable HEAD before and after execution. Windows uses process-scoped Git LF checkout settings; it verifies raw source bytes and Git modes without claiming POSIX execute-permission semantics.

## Actual provider boundary and integrity

The exact official OpenCode CLI 2.0.25 Linux/Windows archives are pinned to the already reviewed read-only registry metadata observation: driver `1bf02db1fe4e14172816978ad50dfcc206c81825`, run `38164333685`, artifact `11711667971`, SHA256 `7f7a4d32f44a5106ef3a153fdbd1e8fa03b832f89cdbaceb1af826846bc871df`. Full archive size, SHA1, SHA256 and SHA512, platform/package/version fields, and exactly two regular package members must match. The archive request permits only HTTPS registry.npmjs.org, no redirect or credentials, with a five-minute body bound. The extractor is the unchanged reviewed `d55c4f64eaf0b030572ebe9f7934f73b1f67e79b` source.

The actual executable must return `opencode v2.0.25`, and its full size/SHA256 is checked again after execution. The source's installed-client manifest must specify `@opencode/client: 2.0.25`.

The CLI and native cases receive only PATH, PATHEXT, SYSTEMROOT, WINDIR, COMSPEC, LANG, LC_ALL, TERM and CI from the job, plus fresh private home/temp/XDG/AppData directories and the named diagnostic flags. Receipts publish inherited variable names, not environment values. No real account secrets, proxy credentials, PSModulePath or arbitrary inherited provider settings are injected.

The diagnostic uses the real production managed native server, OpenCode adapter, durable ProviderService, reactor, Git/checkpoint coordinator and actual SQLite journal. It deliberately raises the same visible typed diagnostic refusal immediately before the adapter's prompt write. The observed model label is configuration only: there is no native model generation, credentialed provider answer, UI capture, whole-app shutdown, or user interaction claim.

## Three identical native cases

1. **Cold admission, checkpoint prelude, adapter stop, warm reuse and final exit.** A real local Git repository contains 512 files of 4,096 bytes each, with 256 modified files. Production Git/checkpoint and startup paths run. After the first admitted session and persisted prompt-boundary refusal, the real adapter runtime stops while the actual managed server remains running. A second admission reuses that same native process. Final cleanup must succeed through the unchanged production scope and actual owned root exit observations.
2. **Thirty-second lease during an explicitly controlled checkpoint holder.** The real checkpoint store captures the bounded repository while a deliberately held coordinator lease blocks admission. The original 30,000 ms lease refuses the contender before native admission or a prompt boundary. The holder is released, the actual durable delivery is observed, and a subsequent admission must work. This is controlled contention, not a claim that Git naturally requires thirty seconds.
3. **Cancellation after a real successful native readiness response, before session admission.** A fetch observer delegates actual HTTP readiness before holding only its response. The original cancellation path interrupts that operation. No session admission or prompt write is permitted, and the real owned cleanup must finish.

All three original native case names, bounded waits, failure propagation, workspace fingerprint and assertions remain. The existing canonical 481 cases and all their assertions remain byte-exact outside explicit opt-in harness substitutions; they are unselected by the native name filter and are covered by the exact feature's separate canonical CI. This diagnostic adds an actual persisted-delivery observation/assertion and real production-scope receipts. It never treats an unselected test as executed.

The overlay recipe pins both the exact 900,871-byte original test (`63f278db4c20784074a92d494402f167cba1a290`) and the 915,424-byte overlaid test (`43e021400637f4f96c3d7911dbd48c122aa55984`). The runner reverses every edit byte-for-byte before installing it. The diagnostic-only probe is `266b1423632ceeca8f462bc55bea52958db0d8cb`. Only the declared test overlay and added probe can differ, and cleanup refuses to overwrite any unexpected mutation.

## Default production preparation and cleanup stay active

Earlier probes injected a teardown wrapper. Production intentionally treats that injection as a reason not to construct the default Windows preparation observer, so that older wrapper cannot qualify the new readiness dependency.

This probe supplies **neither a teardown option nor a preparation option**. A scope-owned observer delegates each real default process-tree signal exactly once, even if diagnostic logging throws, and is restored after the production runtime scope. Snapshot capture, identity validation, signaling, deadlines and outcomes remain actual production behavior.

The fresh teardown proof remains **3,000 ms**. The independently reviewed dependency initializes the actual observer within the existing startup budget before creating the provider process. No cleanup deadline is enlarged. Success requires actual default production scope completion, terminal codes from every owned native root, and complete first pre-signal owned-tree captures. A failed proof, scope cleanup or exit observation remains a real failure.

`production-scope-close-*` timing includes harness/provider cleanup; it is not relabelled as the duration of a single native teardown call. The observer's root exit and pipe close are retained separately and never imply descendant exit by themselves.

## Durable settlement, phase timings and single-owner coverage

The probe records actual phase start/end pairs for provider and adapter admission, native connect/readiness, Git operations, checkpoint capture, thread/workspace lease wait-and-hold, adapter stop and startup cancellation. Four actual engine dispatch responses are paired with their own persisted delivery records, including event sequence, claim fields, attempt count, completion/update timestamps and state. Each must settle as `succeeded` through the normal handling of the deliberate visible refusal. These are actual database observations, not inferred from a prompt counter.

Dispatch-to-settlement-observation intervals include the test's drain/polling overhead. The complete raw NDJSON and phase summaries expose that boundary. Measurements apply to this bounded workload/platform/run. They cannot establish a universal sufficient timeout.

The managed server's unchanged **300,000 ms** idle pool hold is recorded as a constant. The warm-reuse case observes a still-running server and later real disposal. It does not wait five minutes or substitute adapter stop for final owned-runtime exit.

All **14 original DatabaseLifecycleLock tests** run separately and unmodified on each source/platform. They cover owner-token enforcement, dead-owner/reaper recovery, refusal of live/unknown owners, concurrent recovery admission, symlink refusal and actual SQLite server-versus-recovery exclusion. Full named case counts, raw output and actual exit are required. This file-backed qualification is explicitly separate from the in-memory SQLite native reactor harness; the harness is not presented as a multi-process database-lock proof.

## Retained outcomes and bounded evidence

All subprocess commands use the unchanged independently reviewed owned-root observer (`e484cd5e71d42c7d17fc71fcce4d5a0d44a11f33`). It records actual root exit, signal, close, deadline, errors, output cap and any forced tail cutoff separately. A deadline signals only the live owned ChildProcess handle; ten seconds of bounded pipe drain follow. Runner/CI cleanup of unknown descendants is not claimed as proven.

Live logs, Vitest reports and native observations are written outside the upload tree. Each is admitted with lstat as a regular file, opened nonblocking/no-follow, and checked against pathname/descriptor identity, mode, size and nanosecond timestamps before and after capture. A missing, replaced, growing, capped, short or partial snapshot is retained as failed evidence. The manifest hashes only fixed readonly snapshots. Hidden inventory entries and symlinks are refused. Failed native tests remain failed; Before receives no success conversion.

The upload includes raw command output, actual process receipts, full Vitest JSON/accounting, complete source/driver guards, official archive/executable integrity, the exact diagnostic overlay/probe, raw NDJSON, durable delivery observations, phase summaries and final failures. Full server typechecking also runs with the diagnostic overlay. No source formatter mutates the original test or production files.

The original #1804 checkpoint-retry control remains separate: Before one pass/one failure; After 481 passes at `beb3f13af6377783ad6b32f47c29976d682cc6b9`, with the original formatter failure retained. The normal formatter-only child `e32` has separate current canonical CI. Earlier native Windows failures and the older Ubuntu observations remain pinned to their actual source/driver; this new combined pair cannot retroactively change them. The original empirical startup-budget requirement stays pending until these actual outputs are reviewed and interpreted.
