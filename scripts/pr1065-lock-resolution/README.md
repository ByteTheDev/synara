# PR 1065 dependency resolution diagnostic

This isolated workflow prepares a dependency graph for the still-open remote-host feature in [#1065](https://github.com/Emanuele-web04/synara/pull/1065). It does not publish application source, run deployments, execute lifecycle scripts, or establish native or end-to-end behavior.

## Exact inputs

- Current source: `d4509644c8b7c2ba419680f7da8c2441f230d67e`, tree `877444c1badcb38871bd6ac38ebe401e81022212`.
- Original feature: `df7c59d65b6747c54e765fd387260fdfb92ba0bc`; original merge base: `bbae09b75364a0dc0f860cf029fc9b488abcd0d1`.
- Bun: `1.4.2`, required by the unchanged current root manifest.
- Fourteen byte-pinned seed files: eight current manifests, current lock and install configuration, and all four current patches.
- Nine manifest overlays: six exact author-added workspaces, plus the original additions to the current server, web and shared package manifests. The current root, catalog, overrides, patches, versions, scripts and unrelated fields remain intact.
- The current lock uses schema 3. The earlier author's schema-1 lock is not copied over it. Prior semantic inspection found 26 conflicting esbuild-related package entries; this workflow asks the actual package manager to resolve the declared graph and records every resulting package tuple change for review.

The graph was recomputed through the GitHub connector from exact original/base/current manifest bytes while the local executor was unavailable. It is a dependency-only candidate. It does not claim byte identity with the unread local integration worktree. Input hashes, exact field additions and this distinction are retained in `inputs.json`.

## Execution and evidence

A new private runner-temp directory contains only manifests, lock, install configuration and patch files. Both real Bun commands retain their separate Bun and tee exits:

1. `bun install --lockfile-only --ignore-scripts`
2. `bun install --frozen-lockfile --ignore-scripts`

The first result must retain all current root lock settings and all fourteen declared workspace dependency entries. Every added, removed or changed package tuple is recorded. The second command must leave that resolved lock and every input manifest unchanged. Source and diagnostic checkouts have strict tracked and untracked cleanliness checks before and after the work.

Logs and exit receipts are live only in private runner-temp paths. The final step uses the unchanged previously reviewed bounded snapshot helper from handoff driver `a8e31e6a897ccdfa7babd66275798925fe904553` (blob `3f6c01bbc83d6741767253fe75392b178caaee6e`). It freezes each regular file once before parsing or hashing uploaded evidence. Missing, oversized, changing or replaced files remain failures. Actual workflow step outcomes are checked separately from command exits. No failed phase uses `continue-on-error`.

The twelve- and twenty-minute step limits and forty-five-minute job limit are hosted execution bounds. Missing timeout exit receipts are reported as missing, never synthesized as successful exits. A bounded snapshot does not assert that every descendant's eventual log tail was captured.

A successful diagnostic qualifies only dependency resolution and the scripts-disabled graph install on this disposable Ubuntu runner. It does not establish a full source install, prepare hooks, generated application files, database migrations, browser behavior, a real two-host connection, authenticated services or deployments. The lock is a review artifact until its complete tuple changes and compatibility with the repaired source are reviewed.

## Preparation record

The earlier local driver was written and initial Node syntax checked, but its formatter/final-manifest step returned an executor transport failure. This remotely reconstructed driver is a separately frozen packet; no local syntax, formatting, install or hosted success is claimed for it before an actual run.
