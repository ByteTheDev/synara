# PR1866: actual backend projections in ChatView

This isolated driver qualifies the visible lifecycle effect of original PR #1147 and its author-preserving continuation #1866. It runs on two separate Ubuntu 24.04 workers. No product source or feature ref is changed by the workflow.

| Observation | Exact source | Git tree |
| --- | --- | --- |
| Before | d4509644c8b7c2ba419680f7da8c2441f230d67e | 877444c1badcb38871bd6ac38ebe401e81022212 |
| After | 4c31e23b888e40d21868fa8325a8641b0424c517 | 720a114ad765645b93d7ed984e2e6665c404167f |

## What actually runs

The same added backend observation case starts the production Codex adapter through the original isolated Node app-server protocol peer. The test harness owns real temporary Synara/Codex state, SQLite, Git, orchestration, provider transport and reconciliation. The configured executable and both Codex home paths are asserted before spawning. It cannot silently fall through to a real Codex CLI or personal home.

The backend obtains two actual `ProjectionSnapshotQuery.getSnapshot()` results: the live manual turn, then the result of reconciliation after advancing **only reconciliation's observation clock by 46 minutes**. Adapter and watchdog clocks remain real. The provider service must still report native turn `fixture-turn-1` before and after reconciliation, and the peer log must contain exactly its one actual start.

Before is expected to expose the existing discrepancy: the projection becomes interrupted and loses its active turn while the adapter still owns it. After must preserve the running projection and null completion time. Both observation cases are expected to pass their explicit side-specific predicates; this pair is **not** a new failing-test control. The separately retained original lifecycle/paging RED controls and the repaired 375-case run remain the causal regression evidence.

Before receives only the reviewed current harness as an exact tracked test overlay, plus the unchanged original protocol peer and new observation case. After already contains the exact harness/peer. No production file is overlaid on either side. The two original manual/automation native tests are byte-identical in the feature and are exercised separately on Ubuntu and Windows; this capture does not replace them.

## Browser boundary and screenshots

The backend JSON is copied byte-for-byte into an owned generated fixture after the backend command has actually exited. The browser decodes each read model through the real contracts schema. It mounts the real ChatView in the canonical application/browser harness, with the actual project/thread identifiers, then delivers the second exact projection through the existing read-model boundary.

No lifecycle status, timestamp, message, sequence, turn identity or completion time is invented by the browser fixture. Its RPC transport is controlled, so the capture does not claim a live browser-to-server socket, native Electron interaction, credentialed model inference, or 46 minutes of wall-clock execution. Any displayed duration follows the preserved server timestamps and the real browser clock; the observation offset is identified separately.

Each side must produce `00-live.png`, `01-reconciled.png`, and one complete 960×1100 page recording. The live header must remain visible for the initial state on both sides and for the repaired reconciled state; it must disappear for the Before interrupted projection. The actual assistant text and full composer are checked. The original canonical ChatView cases are preserved byte-for-byte in the copied fixture and are unselected in this capture; they are covered by the separate exact-head canonical CI.

The runner matches every browser observation to the corresponding retained server snapshot, validates all PNG chunk CRCs and bounded decoded dimensions, and runs the actual ffprobe against the retained WebM. Images and video still need independent visual inspection before publication as reviewed PR media.

## Execution, source and failure evidence

- Every tracked source blob, POSIX mode, HEAD and Git tree is verified before/after each owned process. Staged and unstaged differences must equal the explicit harness overlay. Only the exact added test/config/JSON paths, this side's media directory and separately verified driver checkout may appear as untracked files; ignored dependency caches are not described as source.
- All eight driver paths are compared to their immutable Git objects before and after execution. The added canonical fixture reverses to every original byte. Cleanup restores/removes only the exact owned bytes, refusing to overwrite an unexpected change.
- The full `observeCommand` body is byte-identical to the independently reviewed Windows/server-shard observer. It delegates actual child creation and only adds the named diagnostic environment values. Backend, browser, both workspace typechecks and ffprobe have finite bounds. Root exit, pipe close, errors, deadline, cap and forced output cutoff remain separate fields; descendant exit is never inferred.
- Processes write only to private live locations. Reports, logs, backend JSON and media are copied once through bounded regular-file descriptors; capture time, observed sizes, hashes and possible tails are recorded. Only these frozen byte copies are parsed or uploaded. A changing/capped/missing snapshot is a failure; hidden or symlink evidence is refused.
- Actual nonzero commands and incomplete artifacts stay visible. The workflow uploads frozen evidence with `if: always()`. The driver never rewrites a report to turn a failed test into a pass, and never formats product source in place.
- Backend and browser reports each require the exact one selected case to pass. The backend requires zero skipped/pending/todo cases. The browser separately records unselected canonical cases and refuses unexpected executed cases. Final server/web typechecks include the new fixtures. Source acceptance and V8 parse checks do not claim those hosted commands already ran.

The local executor was unavailable when this driver was authored. Actual Node syntax, frozen dependency installation, fixtures, types, Chromium, media and source restoration are hosted gates. All production changes and branch publication remain separately reviewed; this branch only adds the eight evidence files.
