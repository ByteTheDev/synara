# Sidebar new-thread state — isolated evidence driver

This driver qualifies the actual full ChatView and Sidebar at two immutable sources: Before main `f73074c7a4e4145a8944292e2103964cdf83ecb8` and After prerequisite #1832 `4e1d1e040df853ddcaa8f30dabf8f913f67669ec`. It belongs only on `cleanup/20261011/sidebar-hydration-evidence`; no application or canonical workflow is instrumented.

## Original tests and controlled state

Both sources run the identical reviewed ChatView browser suite blob `2ecb7492036aae7f5cdb50e0a6f2a479e50f0a1c` (SHA-256 `ec34302f40f6e14470a3971d45b4c71d274ab2d2447e6720b39a6315b5ad9da5`) copied into a new untracked test filename. The original suite and all tracked source files remain untouched. Only these three existing cases are selected:

- Global New thread from Home preserves the saved project Worktree choice, visible checkbox, and draft context.
- Global New thread reopens the same stored Worktree draft despite a saved Local project choice, preserving the draft ID and prompt.
- Global New thread does not open Add project before project hydration completes; the original author's WebSocket fixture neutralization, Loading projects assertion, and initial/final route assertions remain intact.

These are production components, routing, CSS, theme, stores and hooks under the canonical MSW/native API fixtures. The two environment cases protect behavior already present in current main against the global-default override rejected in the original #369 review. Both may correctly pass; this driver never invents an expected red control. The hydration case sets controlled store/snapshot state. It does not inject or establish a specific historical click interleaving, start a live provider, or verify native desktop behavior.

## Additive observation boundary

`observer.json` identifies each original test boundary and six unique insertion sites. The runner requires every replacement to contain the original bytes intact, rejects duplicate/unknown boundaries, and writes the exact common original suite plus observed suite to the artifact. A read-only helper waits for fonts/layout, records source, route, hydration, project/draft environments, draft prompt and rendered checkbox/dialog state, then takes an actual screenshot. It changes no source, action, selector, test assertion, timing threshold, or outcome.

The six phases are before/after the project click, before/after reopening the stored draft, and before/after clicking during the existing controlled hydration case. Full context video records those interactions. Viewport is 960×1100 in both the test iframe and Playwright context so the raster is not scaled into Playwright's default context.

## Verification and truthful failures

The workflow checks out exact source and driver commits, uses the unchanged frozen workspace setup, and installs actual Chromium/FFmpeg. The runner verifies complete source head/tree and absence of tracked changes before and after execution; it also checks the common fixture and all recorded source/overlay hashes. Both staged and unstaged source edits are rejected.

Vitest and `tee` exit codes are retained. A failed test remains a failed workflow step and failed verifier result. Successful evidence requires all three selected original cases to pass, all six unique phases/960×1100 PNGs, and one complete WebM. Filtered tests are counted separately. PNG/WebM headers and file SHA-256 hashes are verified. Output stays in a workspace-owned untracked directory; artifact upload explicitly includes that hidden directory. Raw logs, JSON report, exit receipt, original fixture, observed fixture and provenance survive failures.

Passing execution still requires independent inspection of the original images and interaction frames before publication. Any screenshots are component/state qualification; CI on the feature head remains a separate gate.
