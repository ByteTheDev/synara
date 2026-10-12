# PR #1147 — exact-source reconciliation validation

This isolated diagnostic records actual hosted results for a source repair that could not be executed locally while the shared executor was unavailable. It changes no product ref and performs no merge. Its source assertions, result checks, original nonzero exits, raw output, and failures remain visible.

## Source pins

| Role | Commit | Tree |
| --- | --- | --- |
| Original author head | aedf51d103f5449bd3aad07575d8e076ff45baab | See the preserved first-parent author history |
| Current main used for this integration | d4509644c8b7c2ba419680f7da8c2441f230d67e | 877444c1badcb38871bd6ac38ebe401e81022212 |
| Repaired source | 27737496cf058e851e3a8b74c61a62b2bbb5b8c7 | 4c47778249ad9e46150157d95addc6fa9faaacb7 |

The repaired source preserves the original author's two native protocol fixture files byte-for-byte. Its d4008d91 parent integrates the original author first and current main second. The normal child aligns the optional settings override across the harness's service layers and formats one new assertion. That settings change is consistency work, not a claimed reproduction of a real-Codex fallback.

All 16 source blobs and byte lengths are pinned in pins.json. The driver uses the unchanged setup-workspace blob 37d1f4325a3dc5eec69a4af4a6da293b49514fd2 and the same frozen installation command as canonical CI. It does not change production timing limits or any test assertion.

## Three separate observations

| Variant | Source and overlays | Execution and required interpretation |
| --- | --- | --- |
| before-original | Complete main d450 plus the exact repaired planner, projection, and gateway test files | Seven selected original-author assertions execute. At least one must actually fail to establish a usable defect control. Its raw failure messages still require independent causal review. Non-selected tests remain explicitly reported as unselected/pending; they are not counted as passes. |
| before-pagination | Complete repaired source, with only ProviderRuntimeReconciler.ts restored to the integrated pre-pagination blob f1a834753bdad1e9506ecd92f367a5980ebaf6b3 | The identical two new paging controls execute and must both fail. This is a one-production-file counterfactual control, not a representation of the complete original PR or main. |
| after | Complete repaired source without test or production overlays | Run all seven affected suites, require every test and both original native fixture cases to execute successfully, then run the full server typecheck, formatter over all 16 changed paths, lint over those paths, and the unchanged server synchronous-filesystem budget check. |

The seven After suites are the planner, reconciler, projection pipeline, snapshot query, agent gateway, automation service, and overlapping-turn integration suites. The new real-SQLite query case covers equal timestamps and deletion of the previous cursor row. The two reconciler cases cover a full page of healthy live owners, the later abandoned thread, and the bounded end-of-list wrap.

Both Before jobs preserve the actual failed test process's exit 1. They intentionally remain failed jobs when a defect is reproduced; the verification receipt distinguishes a complete, expected baseline failure from a setup error, timeout, missing assertion, or unrelated failure. There is no continue-on-error or exit inversion. The After job requires actual exit 0 for every gate.

## Actual process boundary

The original integration cases use the real Codex adapter and process transport against their deterministic, local Node JSON-RPC peer. Their assertions still require process.execPath and the isolated CODEX_HOME/CODEX_SQLITE_HOME values for provider launches. They cannot fall through to a real Codex binary or account. Both ordinary and legacy-interruption cases must execute; no live Codex service, native user session, or UI screenshot is claimed by this backend fixture.

The complete observeCommand body is byte-identical to the independently reviewed observer at 0d46607f4d76be872d57a9b25562186d2f27a5cb (runner blob 3747b9454ddb5665f590e365764d5c5a294d8a06). That original body had six real Node lifetime/error/cap controls. This reuse is a source-identity fact, not a claim that new driver execution has already happened.

The observer records actual root exit, signal, pipe closure, process errors, deadline, capped output, and observer status separately. It signals only a still-live owned child handle and allows ten seconds to drain after its diagnostic deadline. Root exit and pipe closure are not proof that every descendant exited. A timeout, forced cutoff, output cap, spawn error, or incomplete JSON report cannot pass the result gate.

## Immutable evidence and source guards

Before each command and after it, the driver verifies the exact source commit/tree and every tracked file's raw Git blob and executable mode. Only the explicit Before overlays are allowed. Their original bytes are retained in memory, restored after observation, and the complete source is checked again. The driver checkout has its own immutable head and all six executed/configuration files are rehashed against it.

Dependency/build caches and the nested sparse driver checkout are untracked; the exhaustive claim is limited to tracked product source and named overlays. The runner never formats or repairs product source in place.

All subprocess logs and the Vitest JSON report are written into a live directory outside the uploaded tree. After observation, bounded immutable byte-prefix copies are saved with initial/end sizes, capture times, SHA-256, and Git blob identities. A missing, truncated, changing-size, or short-read report fails verification. Only that retained report is parsed. Later live writes are not included in the manifest.

If the source formatter fails, a separate bounded formatter command may produce reviewable copies under the owned live directory using the exact repository formatter configuration. These copies and their raw formatter outcome are captured separately; they do not change the pinned source or make the failed formatter gate pass.

The exported inventory rejects hidden paths and non-regular files. The upload points only to the owned frozen directory and runs even when a command failed. The manifest covers every exported file except itself. Genuine failures, including incomplete or malformed diagnostics, remain visible.

No execution result is asserted by this README. Inspect the actual process receipts, test-verification.json, result.json, fixed logs/reports, source proofs, and manifest from the hosted run.
