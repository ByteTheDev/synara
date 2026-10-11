# Configured Claude models — full ChatView comparison

This isolated driver compares Sidebar prerequisite `101a3c9653f2feeab0c7bf3dbcbe163bf01d6869` (tree `dccbd99d1def4b2e9ad2efcc4c489895739ec39d`) with #1835, the independently reviewed #369 core continuation `9fb04ac2735b42efbdfd615efec723673395bab0` (tree `5347993312c4a6d7ec61edbd3827582fa102a812`). Both sources include main `3270dcf89bb60745ac568803a940cd7e7ac676a7` and the exact same Sidebar prerequisite; their 32-file difference isolates the model-capability work. The After includes the accepted three-line standalone TraitsPicker text-content assertion repair. No product/UI feature blob changed from the earlier reviewed core head. Earlier proposed or executed source pins are not relabelled.

The driver belongs only on `cleanup/20261011/claude-model-evidence`. It does not change feature sources or canonical CI.

## Actual UI and controlled inputs

The real full ChatView route, composer editor, model menu, provider catalog, trait resolution, draft actions, persistence, CSS and theme render in Chromium. The common original ChatView browser fixture is blob `2ecb7492036aae7f5cdb50e0a6f2a479e50f0a1c`, SHA-256 `ec34302f40f6e14470a3971d45b4c71d274ab2d2447e6720b39a6315b5ad9da5`, copied to a new untracked test filename on both sources. Its canonical MSW/orchestration/native API boundary remains controlled.

The sole fixture-response extension supplies explicit saved provider settings while the new scenarios run: default Claude has `personal-only`; account `claude_work` (“Work”) has `enterprise-model`; sibling `claude_empty` (“Empty”) has an empty custom list. Each instance is reported ready by the existing provider-status fixture. The normal contract-valid discovery reply remains an empty unsupported list, so the actual production catalog must derive optional controls from the selected account's saved configuration. No `isConfiguredCustomModel`, runtime descriptor, component result, hook result, DOM geometry or rendered pixel is injected.

Each scenario seeds a clearly controlled thread/project/draft selection and binds its ready Claude session to the same account. The existing `composerEffortSlider=false` setting selects production menu rows. All subsequent model-option choices use real pointer actions on **Change model and reasoning**, **Effort**, and **Auto-compact**; those are the actual labels of the integrated ChatView picker. This is separate from the standalone TraitsPicker regression suite in canonical CI; its three combined-label assertions were corrected to match exact text tokens separated by CSS gaps, with all original value and persistence checks retained.

## Three identical scenario tests

1. The Work account's configured custom model must expose Effort and Auto-compact, without inventing Thinking or Speed controls. Select High, select 200k, then select Auto (Claude Code). Assert actual draft state and the real persisted JSON omit effort while retaining exactly the 200k budget. Rehydrate those original saved bytes into cleared state, remount the full ChatView, and verify Auto/200k remain visible. Finally choose Ultrathink and assert the actual composer prompt receives `Ultrathink:\n`. No turn is sent.
2. The Empty sibling account must keep the same opaque `enterprise-model` hint without inheriting Work's optional controls.
3. Work's unknown `unknown-hint` selection must stay available without becoming configured merely because it was selected.

The three scenario tests and their assertions are byte-identical on both sources. The first captures the initial full thread and opened menu before asserting controls exist, so an actual missing-controls Before failure retains useful pixels. Negative cases continue independently. All 225 original common-fixture cases remain intact and are explicitly unselected by this focused driver; they are not counted as passes. The runner reconstructs the entire original fixture by reversing the exact setup extension and removing the two added snippets, and requires byte equality.

## Persistence boundary

This driver tests a new full component mount plus the production Zustand persistence parser/merge. It waits for the actual deferred storage write and saves those bytes unchanged, unmounts, clears in-memory draft state, flushes the clear through the existing pagehide listener, restores the exact prior saved bytes, and calls the actual `persist.rehydrate()` before remounting. It explicitly verifies empty state before restoration and the configured model/account plus omitted effort and 200k budget after restoration. No desired selection is manufactured in the saved JSON. This is not a browser-process or native-app restart; that limit is recorded in the observation as well as here.

## Exact execution and failure handling

The workflow checks out immutable source and driver commits, uses the source's unchanged frozen workspace setup, and installs Chromium plus FFmpeg. Before and after execution, complete source head/tree and both staged/unstaged tracked changes are checked. Relevant production, common-fixture, overlay and snippet hashes are recorded. The original and observed full fixture, overlay specification, complete Vitest log/report, actual Vitest/tee exits, screenshots, full context WebM and completed provenance survive failures.

A failed assertion remains a failed workflow and verifier result. No expected-failure inversion, retry, conditional assertion, selector relaxation or fabricated success is used. A successful run requires all three selected scenarios to pass, all thirteen unique screenshot phases at 960×1100, matching observation source/viewport, valid PNG/WebM headers and exactly one complete context video. Filtered cases are reported separately. Failed runs preserve whatever stages actually completed and keep their real exit code.

Both Playwright context and Vitest iframe use 960×1100. Output is inside the source workspace; upload includes the hidden output directory explicitly. Independent source review precedes driver publication. Actual screenshots, full recordings, failure boundaries and any short extracted clips require independent visual review after execution. Native desktop state, live proxy dispatch, model capacity, context consumption and remote account credentials are outside this controlled component comparison.

## Retained first failure and additive menu diagnostics

The first run `38165453277` used driver `b904cc8b67aed55985c365738f449f3945575a8c` at Before `8aabe73b6732adabaad7cf3480ca376700196656` / After `dd0c5ba49b69c06d3681d6d9fdb612a93c7c08f6`. Both configured cases failed at the original Search models visibility assertion after the real trigger click, before feature controls were asserted. Both actual Vitest exits were 1. That run's GitHub-digest-verified archives and complete failed logs are retained separately. The two negative cases were accidentally unselected because Vitest 4.1.10 quotes `$id` substitutions; the selector and receipt names now match the actual quoted names. No case or behavior assertion is removed.

A bounded, read-only observer now surrounds the same original trigger click and visibility assertion. It records actual pointer/mouse/focus events, document focus, trigger geometry/expanded state, search input presence/visibility, and subsequent DOM surface changes. It neither cancels nor dispatches events, changes focus, changes geometry, retries the click, remounts the component, nor changes the assertion or its timeout. It always removes its listeners and observer. A failed assertion retains its original error and attempts a diagnostic full-frame screenshot; screenshot failure cannot replace the original failure. The raw observer prefix is `PR_MODEL_MENU_OBSERVER` in the unchanged full log.

These observations diagnose the failed menu interaction. They do not establish a product defect or a repaired interaction until actual source-pinned results support that conclusion. The success gate remains all three cases and thirteen expected phases.
