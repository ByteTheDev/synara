# PR #1862: height ownership and preservation checks

This isolated branch qualifies the repaired source without changing the feature branch. It does not merge main or change application files at runtime.

## Exact source and unchanged controls

| Side | Commit | Complete application tree |
| --- | --- | --- |
| Before: author head | `9b5e6efcd2c580312bafbb5b7ad708ee2fa3e5f8` | `01df816bb51bfd68bf8446a4e0f5ca82d8d21d90` |
| After: reviewed repair | `3f9919cc2220ff79e96d6f1ecd0e72034a49baf7` | `52973d90178abdde583bc697145e4cb5dbadf398` |

Both sources receive two new, untracked test copies whose bytes are read from the immutable driver Git tree: the complete final 16-case height-logic fixture and the complete three-case hook fixture. Their hashes and byte lengths are in `pins.json`; no production file or canonical test is overwritten. The original author's four full MessagesTimeline scroll/reveal cases are run unchanged from each application checkout, including the 960/430px overflow cases, actual attached/reader scrolling, and strict remount reveal. No test-name filter drops an assertion.

The unit counterexample requires the original four height cases to remain passing on both sources. The Before fixture must retain an actual failing outcome among the added controls; the After fixture must pass all 16. The paired browser run requires all three added ownership controls to fail Before and pass After, while all four original scroll/reveal cases pass on both. A mismatch remains a diagnostic failure, not a reason to change a test expectation.

Each Before Vitest command must actually exit 1, and the job remains failed. Its separate verification receipt may confirm the intended counterexample, but never converts that exit to success. After requires actual exit 0 and all selected assertions passing. Both unit and browser commands are attempted and retained even when the first command fails.

## Scope of the browser and performance claims

The hook cases mount the actual hook in React and obtain real Chromium DOM widths. Item heights are controlled inputs to the hook's item-size callback. They test unknown-width refusal, writes after a real width change, and refusal after the measured row disappears. They do not benchmark a full virtualizer or prove a native Electron performance improvement.

The original full MessagesTimeline cases are preserved component-behavior checks. Any automatic failure screenshots are diagnostic output from those actual tests, not the requested finished Before/After visual evidence. This driver records no interaction video and does not manufacture a visual performance comparison. The author's M6/60Hz timing report and measurements remain author-reported until separately reproduced.

## Static checks and format recovery

The separate After job runs the canonical scoped formatter, full web/server type checks, all cases in the three named web preservation suites, the complete processTreeController suite, and the unchanged brand-identity check. Existing platform-conditional skips in preservation suites are reported explicitly; they do not satisfy the strict 16 + 3 + 4 comparison counts.

The current source was reviewed while the local executor was unavailable. No local formatter, type, Node, or browser success is asserted. To make an actual formatter failure actionable, the static job also applies canonical Oxfmt to private copies beneath the exact application configuration. It retains the actual formatter/diff exits, byte hashes, and complete patches. A format-check failure remains a failure even when a proposal was produced. No proposal is applied to the feature source.

The original author's Static Checks failure at run `38201366483`, job `114655289188`, reported the legacy `t3` identifier in the performance test. The focused source repair changes those timing variable names without changing any elapsed-time expression or expected value. Native process coverage keeps the author's assertions and waits for the owned finite shell fixture to finish naturally.

## Ownership and evidence integrity

The workflow checks out exact source and setup-action hashes and uses the unchanged full frozen workspace setup. The driver verifies the full application Git tree, every tracked file's raw bytes and mode, expected source blobs, every created fixture, and all seven driver files. Tracked staged or unstaged modifications fail the guard. Created fixture removal requires its exact original bytes.

The command observer is copied byte-for-byte from the independently reviewed module identified in `pins.json`. It owns only its ChildProcess handle, records actual root exit, pipe close, errors, deadline, output cap and cutoff separately, and does not infer descendant termination. A timeout or error remains a failed result even if the root eventually exits.

Live JSON reports and console logs are held under a private runner-temporary directory. Browser screenshots are written only to a separate owned application-workspace directory allowed by the existing browser configuration. The artifact directory is never a live child-writer target. Before parsing or hashing, regular-file snapshots are bounded, read through an owned nonblocking/no-follow descriptor, and checked against both the original and ending pathname identity, size, mode and timestamps. Hidden entries, symlinks, oversized data, changed paths, growth, truncation, destination collisions and unexpected files fail verification. Snapshots record their cutoff; output after that cutoff is not described as observed.

The stable snapshot helper follows the previously reviewed root evidence helper at `e7ea6a83362bc11270ecce170eba3c5cd873bee1`, adding mode to file identity, nonblocking/no-follow open flags, and hidden-entry rejection. No local filesystem race execution is claimed for this derivative. Whole source guards run before/after qualification phases and again after removing only the owned test copies. Actual failures, command receipts, reports, automatic screenshots and a complete fixed-file manifest are retained for independent review.
