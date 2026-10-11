# PR #1841 — first window activation and the clicked picker

This isolated browser driver compares exact main `3270dcf89bb60745ac568803a940cd7e7ac676a7` (tree `3041a3cf0328b6e7e4d9b6c5027a2a1a09e33822`) with the independently reviewed two-file repair `cc8f74c746bcf120d0f0d953d4fb6ebd29d04983` (tree `9c8c0bbd5334220f7c6ce759dcdf8d201ccac224`). It belongs on `cleanup/20261011/window-focus-evidence`, separately from the feature branch and #1835's model capability work.

## Identical canonical controls

The complete After `ChatView.browser.tsx`, blob `5f913d0c0332a4adfec826ef66e5b9cd10935c07`, is copied to a new untracked filename on each source. Its two new canonical tests run unchanged on both production implementations: model picker and traits picker on first activation. All existing fixture cases and their assertions remain byte-for-byte intact; 223 other cases are unselected and cannot be counted as passes.

Each test actually focuses the same-origin Vitest parent document before mounting the production full ChatView. It requires the real application document to remain unfocused and its composer not to own focus, then performs exactly one real pointer click on the selected picker. The original tests require actual document activation, an expanded menu across four layout rounds, no composer focus, a visible real menu, and an actual Escape closing the menu. Parent tabindex is restored and the component unmounts in the original finally block. No focus result, event, requestAnimationFrame, component, hook, geometry, production callback or assertion is mocked or replaced.

This exercises real Chromium focus between the Vitest parent and application frame under the canonical controlled orchestration/native API fixture. It is not an OS-level application switching test, an Electron capture, or a live provider session. Its controlled frame setup makes the previously observed first-activation race deliberate; it does not establish the precise timing of an earlier historical run.

## Additive observations and images

A read-only helper records actual document/editor focus, active element identity, trigger expansion, visible menu text, source and viewport, then takes a full application-frame screenshot. Four additive calls surround the unchanged assertions: before the click, immediately after the click, after the four strict layout checks, and after Escape. The helper waits for real fonts/layout for capture and never dispatches events or changes focus. The original unfocused precondition is asserted again after its Before screenshot.

The original complete fixture is reconstructed by removing that helper and reversing two exact additive replacements. The runner requires byte equality with the reviewed canonical After fixture. Before and After use the same observed bytes. A Before failure keeps its actual exit, completed phases and full video; the verifier never converts an expected failure into success. A successful run requires both canonical cases to pass, all eight distinct full 960×1100 PNG phases, one complete context WebM and consistent source/viewport observations.

The workflow checks out immutable application and driver heads, uses the application's unchanged frozen workspace setup, and installs Chromium and FFmpeg. Full head/tree and staged/unstaged tracked source guards run before and after testing; production files, common fixture, overlay and helper hashes are recorded. Both actual Vitest and tee exits survive pipeline execution. Original and observed complete fixture bytes, raw test log/report, source provenance, valid media headers/hashes and full recordings are uploaded even after a real assertion failure.

Source and driver review precede publication. Actual hosted results, images and short clips require independent review after execution. Existing local 167/167 ChatView logic and native TypeScript passes qualify source compilation and existing helper logic only; they do not establish the new browser control outcome.
