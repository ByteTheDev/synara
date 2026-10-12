# PR1866 exact-head Windows protocol verification

The original #1147 process integration cases are outside canonical CI's selected Windows list. This isolated workflow runs those **same two unchanged author cases** against final reviewed source `4c31e23b888e40d21868fa8325a8641b0424c517`, tree `720a114ad765645b93d7ed984e2e6665c404167f`, on `windows-latest`.

## Scope

The actual production Codex adapter/process transport, SQLite orchestration/projection, automation queue, MCP authorization and teardown run against the author's isolated `node app-server` protocol peer. Its executable and Codex home guards are unchanged. Both legacy-interruption choices must pass, with the original exact turn IDs, queue order, completion and authorization assertions. No live model or account credentials are used.

No test/production overlay, skipped case, alternative assertion, retry, longer production deadline, formatter or source edit is applied. The process-scoped Git configuration preserves normal LF bytes on Windows before checkout. POSIX executable permissions cannot be observed on that platform; the Git tree modes, exact raw tracked bytes and complete tracked diff remain checked.

The owned observer is byte-identical to the independently reviewed #1147/#1804 observer. A 25-minute diagnostic root deadline and 10-second observation drain bound failures; root exit/close and deadline/output errors are recorded separately. Root-only termination is not descendant-exit proof. Output lives outside uploaded evidence while the child runs, then bounded immutable prefix snapshots are copied and hashed. Missing, growing, truncated, unexpected or failed output remains a failed result.

## Provenance

`pins.json` records all 16 reviewed feature blobs, both original fixture blobs, source tree and setup action. The driver hashes its own five files and all 9,027 tracked application files before and after the test process, including unchanged-source restoration. The final artifact contains the actual verbose log, JSON assertions, process exit, raw source proofs and manifest. It must report exactly two passed, zero failed/skipped/todo cases; there is no baseline-status inversion.

The earlier Ubuntu **375/375** suite belongs to `27737496…`; final `4c31e23b…` changes only its actual formatter output. This Windows job adds platform coverage at the exact final head. It does not replace the original failed formatting job, canonical CI, or the separately planned backend-projection ChatView capture.
