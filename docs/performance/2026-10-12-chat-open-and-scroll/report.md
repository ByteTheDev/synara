# Opening chats and reading older messages — 2026-10-12

Long chats now open faster, switch faster, and scroll into older messages without
the viewport re-anchoring under the reader. The full transcript still loads at once:
no paging protocol, cache or client history state was reintroduced.

| Change                                                                  | Where                                                                          | Effect                                                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Content-aware row height hints and a measured-height cache              | `timelineRowHeight.logic.ts`, `useTimelineRowHeightHints.ts`, LegendList patch | Scroll range is right from the first frame; anchor corrections while reading older messages drop 95–100% |
| Removed 23 Tailwind rules that force whole-document style recalculation | `group-has-*`, `has-*:*:`, `has-*:**:` usages, `index.css` variants            | No whole-document recalcs while reading a long chat (322 → 0); style work −61%                           |
| No second thread subscription at startup                                | `routes/__root.tsx`                                                            | 2 → 1 snapshot per reload of an open chat                                                                |
| Process-tree scan off the server event loop                             | `processTreeController.ts`                                                     | 85% less event-loop blocking from `ps` during provider probe teardown                                    |

## Method

- Apple M5 Pro, 48 GiB, macOS 27.0.1; Bun 1.4.2 server, production `vite build` of
  the web app, Playwright headless Chromium (software GPU).
- Isolated servers on ports 3899 (baseline `52f06318f`) and 3898 (this change), each
  with its own copy of a real Synara database (56 threads, 16,451 activities) plus two
  synthetic long threads cloned from real rows: 666 messages / 8,238 activities
  (2,031 in the snapshot) and 1,400 messages. No provider turns ran.
- [`apps/web/perf/chat-open-runner.mjs`](../../../apps/web/perf/chat-open-runner.mjs)
  measures cold open (in-app navigation to a thread not yet in the store), warm switch,
  wheel scrolling from the bottom to the first message, and full reloads. Three rounds,
  medians; each thread runs in a fresh browser context.
- Headless Chromium rasterizes in software, so frame intervals are bounded by raster,
  not by the app; scroll results use main-thread trace data instead of frame rates.
- [`apps/server/perf/threadDetailStages.perf.test.ts`](../../../apps/server/perf/threadDetailStages.perf.test.ts)
  splits snapshot delivery into SQL + decode, RPC encode, JSON and client decode.

## Findings

### 1. Older messages: every row was estimated at 90 px

Real rows average 330 px (assistant median 473 px, user 105 px, work 38 px). The list
laid unrendered history out at roughly a quarter of its height, and each row rendered
above the viewport corrected the scroll position: on a 111-message chat the scroll
range grew from 12,359 to 32,115 px while reading, with 17,890 px of anchor jumps.

`getEstimatedItemSize` (added to the existing LegendList patch) asks a text-layout
estimate per row, calibrated on 259 measured rows (median error 3%), and reuses the exact
height measured by any earlier mount of the same row. On the benchmark threads the first
frame's scroll range lands within −3% to +13% of the final height. Dedicated scroll run,
two rounds:

| Thread                      | Anchor jumps before | after, first visit | after, revisit | Initial range vs. final, before → after |
| --------------------------- | ------------------: | -----------------: | -------------: | --------------------------------------- |
| 666 msgs / 2,031 activities |          119,549 px |           2,513 px |         120 px | 29% → 99%                               |
| 1,400 msgs                  |            5,975 px |                  0 |              0 | 55% → 107%                              |
| 111 msgs / 1,373 activities |           17,890 px |             545 px |          24 px | 38% → 97%                               |
| 66 msgs / 1,475 activities  |            4,687 px |             583 px |          24 px | 52% → 97%                               |
| 68 msgs / 1,249 activities  |           11,101 px |              36 px |              0 | 44% → 108%                              |

### 2. Whole-document style recalculation on every row mount

Style recalculation was the largest main-thread cost while scrolling (482 ms of 1,465 ms
busy in an 80-tick profile) and a large part of opening a chat. 10% of recalculations
restyled the whole document (1,500–2,000 elements) even though only a row changed.

Deleting stylesheet rules in the running app isolated the cause to `:has()` placed inside
`:is()` together with a universal or child subject — what Tailwind emits for
`group-has-*`, `has-*:*:` and `has-*:**:` — and to non-subject `:has()` whose argument or
subject uses attributes common in transcript rows (`data-slot`, `data-size`). Any single
one of the 23 rules was enough. The same conditions written as `:where(group):has(…) .cls`,
`.cls:has(…) input`, or a CSS variable read by `*:` children stay local; specificity is
unchanged except where noted in the code.

| Wheel scroll, 111-message chat               |       Before |      After |
| -------------------------------------------- | -----------: | ---------: |
| Recalcs restyling > 500 elements (60 ticks)  |           30 |          8 |
| Elements restyled per recalc, p90 (60 ticks) |        1,537 |        253 |
| Style recalculation p90 (80 ticks)           |   5.6–5.9 ms | 1.5–1.6 ms |
| Tasks > 16 ms (80 ticks)                     |          6–8 |          3 |
| Main-thread time (80 ticks)                  | 994–1,019 ms | 886–919 ms |

`apps/web/src/hasSelectorVariants.test.ts` fails if these variants come back.

### 3. Startup subscribed to the open chat twice

The mount-time bootstrap subscribed to the open chat; the server welcome that arrived a
few milliseconds later on the same connection unsubscribed everything and subscribed
again, interrupting the first snapshot. Only the first welcome of the bootstrap's own
connection is now skipped; reconnect welcomes still resynchronize.

### 4. Synchronous `ps` scans blocked the server

Each provider probe teardown ran `ps -eo pid,ppid,lstart,command` with `spawnSync`
(40–50 ms with ~1,000 processes) on the event loop that serves snapshots. The scan now
runs asynchronously with the same command, parser, retries and results.

| 30 full app loads, server CPU profile | Before |  After |
| ------------------------------------- | -----: | -----: |
| `spawnSync` (event loop blocked)      | 2.07 s | 0.32 s |
| Total server CPU samples              | 22,563 | 17,633 |

### Snapshot delivery (unchanged)

| Thread                      | Snapshot | SQL + decode | RPC encode | JSON | Client parse + decode |
| --------------------------- | -------: | -----------: | ---------: | ---: | --------------------: |
| 666 msgs / 2,031 activities |   3.2 MB |        64 ms |      16 ms | 6 ms |                 21 ms |
| 66 msgs / 1,475 activities  |   2.9 MB |        32 ms |      12 ms | 5 ms |                 16 ms |
| 18 msgs / 449 activities    |   0.4 MB |         9 ms |       4 ms | 1 ms |                  4 ms |

SQL is 6–8 ms of a 25–30 ms snapshot for real threads; the rest is row decoding and
schema validation. Deep `Schema.Json` validation of activity payloads is ~65% of the
client decode; switching it off is a contract decision and was left out.

## Paired results

Baseline `52f06318f` vs. this change, same machine and database, three rounds each,
medians. Raw values: [measurements.json](measurements.json).

| Thread                                  | Cold open → at bottom | Warm switch → at bottom | Full reload → first row | Thread snapshots per reload |
| --------------------------------------- | --------------------: | ----------------------: | ----------------------: | --------------------------: |
| 666 msgs / 2,031 activities (synthetic) |   317 → 274 ms (-14%) |      109 → 62 ms (-43%) |      638 → 588 ms (-8%) |                       2 → 1 |
| 1,400 msgs (synthetic)                  |   176 → 129 ms (-27%) |       93 → 45 ms (-51%) |      478 → 512 ms (+7%) |                       2 → 1 |
| 111 msgs / 1,373 activities             |   232 → 186 ms (-20%) |      104 → 61 ms (-42%) |      564 → 520 ms (-8%) |                       2 → 1 |
| 66 msgs / 1,475 activities              |   230 → 195 ms (-16%) |       93 → 47 ms (-49%) |      561 → 560 ms (-0%) |                       2 → 1 |
| 68 msgs / 1,249 activities              |   228 → 182 ms (-20%) |       99 → 43 ms (-57%) |      544 → 512 ms (-6%) |                       2 → 1 |
| 18 msgs / 449 activities                |   128 → 108 ms (-16%) |       77 → 40 ms (-49%) |      486 → 496 ms (+2%) |                       2 → 1 |

| Wheel from the bottom to the first message |       Anchor jumps |   Style recalculation | Whole-document recalcs |       Main-thread tasks | Initial / final scroll range |
| ------------------------------------------ | -----------------: | --------------------: | ---------------------: | ----------------------: | ---------------------------: |
| 666 msgs / 2,031 activities (synthetic)    | 119,637 → 2,783 px | 2,278 → 899 ms (-61%) |                322 → 0 | 6,561 → 5,270 ms (-20%) |                    28% → 99% |
| 1,400 msgs (synthetic)                     |       5,975 → 0 px |    91 → 113 ms (+24%) |                17 → 30 |     272 → 368 ms (+35%) |                   55% → 107% |
| 111 msgs / 1,373 activities                |    18,146 → 547 px |   430 → 284 ms (-34%) |                62 → 28 |  1,250 → 1,211 ms (-3%) |                    39% → 97% |
| 66 msgs / 1,475 activities                 |     4,687 → 585 px |     93 → 72 ms (-23%) |                18 → 13 |      250 → 248 ms (-1%) |                    52% → 97% |
| 68 msgs / 1,249 activities                 |     11,101 → 36 px |    264 → 247 ms (-6%) |                40 → 38 |      715 → 777 ms (+9%) |                   44% → 108% |
| 18 msgs / 449 activities                   |           0 → 0 px |    10 → 36 ms (+260%) |                  0 → 0 |     49 → 103 ms (+110%) |                  100% → 113% |

- Opening is faster on every thread, mostly because fewer rows mount before the list
  settles at the bottom and each mount restyles less of the document.
- Full reloads are within noise (−8% to +7%) apart from the second snapshot, which is gone.
- On short or light threads the rows that no longer mount at open mount while scrolling
  instead: the 18-message chat spends 54 ms more main-thread time over 15 wheel ticks and
  the 1,400-message chat 96 ms more over its whole history. Heavy threads win outright.

## Not changed

- Paging the transcript (removed in `52f06318f`) was not reintroduced. The list already
  mounts only the rows in view; what remains of a cold open is mostly snapshot delivery
  (55–175 ms for 0.4–3.2 MB here) and rendering those rows.
- Frame rates while scrolling are not claimed; see Method.
- Real provider processes, packaged Electron and Windows were not measured. The
  process-tree change keeps Windows on its existing CIM path.

## Reproduce

```bash
node apps/web/perf/chat-open-runner.mjs http://127.0.0.1:3899 <neutral-thread> <thread>... --rounds=3 --out=before.json
```

Run it against an isolated server (see the verify skill) with a copied database, once
per build.
