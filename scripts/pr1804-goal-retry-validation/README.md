# Goal continuation after checkpoint contention

This isolated diagnostic validates a focused repair to original PR #1158 / continuation #1804. It does not complete the separate empirical startup-phase and 30-second lease-window requirements.

| Variant | Exact source | Meaning |
| --- | --- | --- |
| Before | `b7ce9417bda2d2b2da644cf43e5865a67a5f7a61` | Current-main integration of the reviewed grace repair, plus the same two new held-lease controls. No retry-map admission after goal lease acquisition times out. |
| After | `beb3f13af6377783ad6b32f47c29976d682cc6b9` | Identical source/tests with the reviewed four-line addition queuing the rejected goal continuation for later retry. |

The integration preserves original continuation head `392bc7e3614e35d59c42add5a1c1bf6f153dd76a` and current main `d4509644c8b7c2ba419680f7da8c2441f230d67e`. All 25 original reactor/test hunks replay exactly onto that main. The unchanged current-main ChatView fixture retains its updated Worked-for wording. The final comment-only child clarifies that queuing still runs under the original delivery ownership.

## Actual controls

Both variants contain exactly the same complete test file. There is no runtime source or fixture overlay. The new parameterized case holds a real `TurnCheckpointCoordinator` lease through the visible retryable delivery settlement, then releases that lease. The unpaused case must automatically start exactly one provider turn and preserve goal identity; the paused case must leave the goal paused and start no provider work. SQLite projection/delivery and checkpoint ownership are real; the provider service is the test harness fixture.

Before runs the two new cases and must preserve the unpaused failure plus a passing paused negative control, with actual process exit 1. Any other failure remains an explicit diagnostic failure. After runs the full, unfiltered reactor suite, including all 12 original grace/contention controls and every current-main case, then full server types, formatting of both feature files, scoped lint and the unchanged server synchronous-filesystem guard. No selected or unselected test is converted to a skip to obtain a pass.

These controls do not measure a live provider, native process launch, warm-pool lifetime, teardown duration, or sufficiency of a 30-second lease. Those remain distinct evidence and original requirements.

## Source and process evidence

The runner verifies every tracked file's raw Git blob and executable mode against the exact source tree before and after each command. It separately hashes all five diagnostic files against the diagnostic checkout. Dependencies are installed with the checked-in frozen workspace setup. Actual exit, signal, pipe close, deadline, output cap, errors and forced cutoff remain separate fields. A deadline signals only the still-live owned child handle, then observes a bounded ten-second pipe drain; it does not claim descendant exit.

The observer implementation and its original six real Node lifetime controls come from previously independently accepted diagnostic `0d46607f4d76be872d57a9b25562186d2f27a5cb`. Its complete body remains byte-identical to the accepted #1147 observer.

Each report/log is read once through an owned descriptor into a fixed byte-prefix snapshot outside the source workspace. The snapshot records initial/end size, capture times and hashes. Missing, capped, shortened or size-changing reports fail verification. Only frozen copies are parsed, hashed and uploaded; possible later descendant writes remain outside the artifact. Hidden and non-regular entries are refused.

If formatting fails, the real source stays untouched. The diagnostic formats separate owned copies with the exact checked-in formatter configuration and retains those bytes for a reviewed follow-up. The original formatting failure remains recorded.

The local executor was unavailable when this driver was authored. The diagnostic therefore makes no local execution claim. A hosted pass requires real completed commands, exact report assertions, source guards and all gate exits; its Before job remains failed.
