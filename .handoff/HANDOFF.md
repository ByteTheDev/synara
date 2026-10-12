# Handoff — chat open/scroll performance (continue on another machine)

Delete this `.handoff/` folder before opening the PR.

## State

All code changes are committed on `claude/chat-performance-loading-694d73`. Full
`bun run test` (6/6 workspaces), typecheck, lint, fmt, windows-runtime check and the
transcript/EventRouter/ChatView browser suites pass (ChatView: the `[geometry:linux]`
case and the horizontal-tab-drag timeout fail identically on the baseline checkout).

Changes: row height hints + measured-height cache (LegendList patch
`getEstimatedItemSize`), 23 costly `:has()` Tailwind rules rewritten (+ guard test),
single thread subscription at startup, async `ps` scan in process-tree teardown, and two
LegendList initial-scroll completion fixes (see below). Report:
`docs/performance/2026-10-12-chat-open-and-scroll/report.md` (numbers are from the
headless runner; replace with the real-Chrome results below).

## Real Chrome results (headed Google Chrome, Metal, 120 Hz; median of 3; ms)

`results/` has the raw per-session JSON and trace summaries (base = `52f06318f`).

| Step                                      | Base → candidate                |
| ----------------------------------------- | ------------------------------- |
| Cold open, 666 msgs / 2k activities       | 473 → 412 (−13%)                |
| Cold open, real 64 msgs / 1.2k activities | 307 → 257 (−16%)                |
| Cold open, 1,400 msgs                     | 247 → 205 (−17%)                |
| Cold open, real 111 msgs                  | 249 → 198 (−20%)                |
| Warm switch, 666 msgs                     | 157 → 108 (−32%)                |
| Warm switch, real 64 msgs                 | 124 → 81 (−35%)                 |
| Main-thread rendering per open            | −45% to −73%                    |
| Scroll: anchor jumps (666 msgs)           | 10,296 → 394 px                 |
| Scroll: whole-document style recalcs      | 44 → 1                          |
| Scroll frame rate                         | 120 fps in both (no regression) |

## Remaining

1. **Warm switch back to a chat that was scrolled up earlier** (step `warm:hero` in
   `user-session.mjs`): 138 → ~180 ms on the candidate in the full session flow,
   although the isolated `warm-probe.mjs` now reveals in 73 ms (base ~125 ms). Pattern:
   geometry final at +6 ms, list kept at `opacity: 0` (LegendList `readyToRender`) until
   ~180 ms. Two fixes already in the LegendList patch:
   - `isInstantInitialScrollAlreadyApplied` in `checkFinishedScrollFrame`;
   - `doScrollTo` schedules `checkFinishedScroll` when an instant initial scroll does not
     move the scroller.
     Still missing path: likely the bootstrap reveal (`evaluateBootstrapInitialScroll` /
     `queueBootstrapInitialScrollReevaluation`) or `checkFinishedScrollFallback`'s 100 ms
     retries. Instrument `setInitialRenderState`, `finishInitialScroll`, `finishScrollTo`
     and `checkFinishedScrollFallback` in an unminified build and replay the session flow.
     If it cannot be fixed safely, report it in the PR as a known trade-off.
2. Run `scripts/style-diff.mjs` (baseline vs candidate computed styles for the sidebar
   keyboard-focus reveal, Settings → terminal font autocomplete, Create project input
   groups). Expect identical output.
3. Re-run the A/B (`user-session.mjs`, 3× each, alternating), aggregate with
   `aggregate-user.py`, update the report tables with the real-Chrome numbers, remove
   `.handoff/`, open the PR.

## Reproduce on another Mac

Scripts use absolute paths from the original MacBook (`SCRATCH` =
`/private/tmp/claude-501/...`, repo worktree path); adjust them first.

1. Baseline checkout: `git worktree add -d <scratch>/baseline 52f06318f && (cd <scratch>/baseline && bun install)`.
2. DB copy: copy a `~/.synara/userdata/state.sqlite.backups/*.sqlite` to
   `<scratch>/perf/state.seeded.sqlite`, then `python3 -I scripts/seed_mega.py <db>`
   (it clones two long threads; the source thread ids are from the original machine's
   database — pick large threads from the local one), and un-archive/pin the threads the
   session clicks (`user-session.mjs` → `CHATS`).
3. Builds: `bun run build -- --outDir <scratch>/perf/web-base` (baseline) and
   `web-cand` (this branch). After pulling run `bun install` (LegendList patch changed)
   and delete `apps/web/node_modules/.vite`.
4. Servers: `scripts/server.sh <web-dir> <port> <home-name> [repo]` → 3899 baseline,
   3898 candidate.
5. Sessions: `node scripts/user-session.mjs base-1 3899 <out>` etc. (opens headed
   Google Chrome with a temporary profile), then `node scripts/analyze-trace.mjs` on each
   `*.trace.json` (traces open in Chrome DevTools → Performance → Load profile).
