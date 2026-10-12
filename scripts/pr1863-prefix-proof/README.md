# PR 1863: native diff-prefix qualification

This isolated diagnostic qualifies the author’s focused prefix repair without changing a feature branch.

| Variant | Exact source | Production |
| --- | --- | --- |
| Before | `d4509644c8b7c2ba419680f7da8c2441f230d67e` | Current main, with the three complete authored test files overlaid byte-for-byte |
| After | `04f25e61fe8e6ff68b9a72218741300cee732cff` | The unchanged author head, including those identical tests |

The author head is directly based on that main. Its six-file diff affects parsed, applied, or stored patches in GitCore, CheckpointStore, and the local GitHub diff fallback. Existing untracked-patch prefixes remain intact. This diagnostic does not include the separate #1847 status, ownership, or unusual-filename changes.

## Canonical assertions

Ubuntu runs the full three original test files through the checked-in server test script: 190 cases. Windows runs the three specific prefix regressions from exactly those files and explicitly records the remaining 187 cases as unselected. This is a bounded Windows prefix check, not a complete GitCore Windows result. The existing 190 assertions are not edited. The GitHubCli file mocks its process runner, so its API/merge test names never issue real GitHub commands.

Before must preserve its actual three failing regressions and process exit 1. After requires their actual pass and exit 0. Missing tests, extra failures, deadlines, incomplete output, or other mismatches remain failed diagnostic evidence. The raw assertion messages must be inspected before treating a failure as causal proof.

## Native operations and UI inputs

An additive observer calls the actual source GitCoreLive, CheckpointStoreLive, and checkpoint summary parser. It creates fresh owned repositories for normal prefixes, diff.noprefix, mnemonic prefixes, custom source/destination prefixes without slashes, and forced color. Each repository pins local LF behavior solely to make content comparisons deterministic; the canonical authored tests above retain their original repository setup and runner Git settings.

The observer reads all five panel patch variants, copies tracked text and binary changes to a real detached worktree, records the actual snapshot patch, captures and parses a real two-file checkpoint diff, and applies its actual reverse diff. It records every result and retains failures while continuing through the remaining configurations. The normal-prefix scenario is a positive control. Each owned runtime is disposed before its repository is removed, and cleanup failures remain visible. Root exit or successful deletion does not establish arbitrary descendant exit.

The exact noprefix checkpoint patch and parser summary are copied into a small, hashed UI payload. A later, separately reviewed browser capture may replay those exact native bytes through the existing DiffPanel transport fixture. This driver produces no screenshot and makes no browser, live-provider, GitHub API, signed-package, or native UI claim.

## Evidence and integrity

Both checkouts are materialized from their committed index before installation using a command-local autocrlf=false setting. Runtime Git configuration is not changed globally. The checked-in frozen runtime setup and its lifecycle hooks run normally.

Every tracked source byte, committed/index mode, and exact test overlay is checked before and after each command; POSIX executable bits are also checked, while Windows filesystem mode limitations are explicit. Unexpected untracked source is refused. The additive probe has its own exact blob guard. Before fixtures and the probe are restored or removed only while their current hashes still match the diagnostic’s owned bytes.

The owned ChildProcess observer is byte-identical to the independently accepted #1147/#1804 observer. Real root exit/signal, pipe close, deadline, error, output cap, and cutoff remain distinct. Live logs and JSON stay outside the uploaded tree; bounded descriptor snapshots record identity, size and timestamp stability before the fixed copies are parsed or hashed. An expected Before failure is never converted into a successful job.

The local executor was unavailable during preparation. No local parse, typecheck, formatter, or native execution result is claimed. The first actual hosted results must be retained, including any source-guard or fixture-platform failure.
