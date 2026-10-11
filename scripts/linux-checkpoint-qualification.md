# Linux package and checkpoint qualification

This evidence-only workflow invokes the unchanged reusable packaging workflow at each independently reviewed feature head. It never publishes a release, writes a tag, passes signing secrets or changes application source.

| Separate strategy | Exact source                               | Declared native formats                                                |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| PR 1652           | `5512c114e3d97c7db79127ca9d9a7946b1bc7359` | AppImage and Debian, retaining this alternative's Debian mirror policy |
| PR 1720           | `5107bcccc6eff36672d878958fc75ce4fe61bc05` | AppImage and Debian, AppImage-only updater authority                   |
| PR 1823           | `5b6b0c427863018f65f4b1113f4e1ad4076e1dab` | AppImage, Debian and RPM, AppImage-only updater authority              |

Each source runs separately for `production` and `beta`, selected only by one of six explicit `cleanup/20261011/pr-N-linux-checkpoint-FLAVOR` branches. Each run therefore has a single Linux package artifact and checkpoint name. Production uses the source's actual server version; Beta uses the next patch with `-beta.1`. These are unsigned build identities, not release tags. All three sources currently contain version 1.0.2 and have current-main-compatible feature bytes; later main 9e01962's version 1.0.3 does not change the source pins or qualify these builds as that release.

## Actual first attempt

The workflow verifies the exact source commit, complete tree identity, tracked cleanliness and core source-file hashes. Portable JavaScript and Cua preparation follow the repository's frozen build commands. The selected immutable `release-platform.yml` performs real native packaging, provenance generation and its original startup smoke assertions. PR 1652's canonical startup is AppImage-only; PRs 1720 and 1823 additionally inspect, safely extract and start each declared native package.

A fresh verification job downloads only this run's qualified artifact. With no workspace dependency installation, it calls that exact source's checkpoint verifier, verifies every declared payload and updater byte hash, queries the actual Debian/RPM name, version and architecture, and retains provenance and all command exit/signal/error observations. Native package query tools do not execute maintainer scripts. This diagnostic does not repeat the earlier apt/DNF install/upgrade/remove qualification; that earlier evidence remains tied to its earlier source.

The job independently obtains actual jobs from this run and attempt through the Actions API. It requires successful canonical startup/upload and proves that dependency installation, native preparation, collection and provenance actually ran. Missing, ambiguous, skipped or failed evidence fails the diagnostic. No check or source assertion is removed.

## Deliberate second attempt

Only after all first-attempt validations pass does the diagnostic retain the verified real package bytes under the candidate-checkpoint name. A normal rerun of the same workflow run then exercises the source's existing same-run checkpoint restore path. This is a deliberately seeded replay of a successful build, not a naturally failed release or a release-speed measurement.

The second attempt must demonstrate actual checkpoint lookup/download/identity verification and native startup success while dependency installation, portable restoration and native rebuild steps are skipped. The strict Debian/RPM alternatives must run their restore-only package inspection prerequisites. A fresh verification job again proves the actual bytes and metadata without a workspace install. Both attempts retain their own source receipts, raw workflow-step observations and SHA-256 evidence inventories. Failed attempts stay failed and remain visible.

## Boundaries

Ubuntu 24.04 x64 only; no signing, publication, authenticated providers or other-distribution claim. The canonical workflow owns application processes and their original cleanup. The small metadata helper runs only fixed read-only Git/dpkg/rpm commands with timeout/error/exit recording, then hashes fixed artifacts. The actual hosted results, complete artifact ZIP identities and receipt inventories must be inspected before claiming success.
