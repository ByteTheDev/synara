# Linux package and checkpoint qualification

This evidence-only workflow invokes the unchanged reusable packaging workflow at each independently reviewed feature head. It never publishes a release, writes a tag, passes signing secrets or changes application source.

| Separate strategy | Exact source                               | Declared native formats                                                |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| PR 1652           | `82f099ec3ed6dc698e76dac17c93ef4354141f5e` | AppImage and Debian, retaining this alternative's Debian mirror policy |
| PR 1720           | `4dced2d4a099b4186a2275c261886dfb55f9f325` | AppImage and Debian, AppImage-only updater authority                   |
| PR 1823           | `d514181370aa7d673afe267948c42b85ba3f3e28` | AppImage, Debian and RPM, AppImage-only updater authority              |

Each source runs separately for `production` and `beta`, selected only by one of six explicit `cleanup/20261011/pr-N-linux-checkpoint-FLAVOR` branches. Each run therefore has a single Linux package artifact and checkpoint name. Production uses the source's actual server version; Beta uses the next patch with `-beta.1`. These are unsigned build identities, not release tags. All three exact sources incorporate current main 1.0.3 metadata and the separately reviewed PR 1852 formatting prerequisite, preserving every previously reviewed feature blob. Production builds use 1.0.3 and Beta builds use 1.0.4-beta.1. Earlier 1.0.2 source checks remain separately labelled.

## Actual first attempt

The workflow verifies the exact source commit, complete tree identity, tracked cleanliness and core source-file hashes. Portable JavaScript and Cua preparation follow the repository's frozen build commands. The selected immutable `release-platform.yml` performs real native packaging, provenance generation and its original startup smoke assertions. PR 1652's canonical startup is AppImage-only; PRs 1720 and 1823 additionally inspect, safely extract and start each declared native package.

A fresh verification job downloads only this run's qualified artifact. With no workspace dependency installation, it calls that exact source's checkpoint verifier, verifies every declared payload and updater byte hash, queries the actual Debian/RPM name, version and architecture, and retains provenance and all command exit/signal/error observations. Native package query tools do not execute maintainer scripts. This diagnostic does not repeat the earlier apt/DNF install/upgrade/remove qualification; that earlier evidence remains tied to its earlier source.

The job independently obtains actual jobs from this run and attempt through the Actions API. It requires successful canonical startup/upload and proves that dependency installation, native preparation, collection and provenance actually ran. Missing, ambiguous, skipped or failed evidence fails the diagnostic. No check or source assertion is removed.

## Deliberate second attempt

Only after all first-attempt validations pass does the diagnostic retain the verified real package bytes under the candidate-checkpoint name. A normal rerun of the same workflow run then exercises the source's existing same-run checkpoint restore path. This is a deliberately seeded replay of a successful build, not a naturally failed release or a release-speed measurement.

The second attempt must demonstrate actual checkpoint lookup/download/identity verification and native startup success while dependency installation, portable restoration and native rebuild steps are skipped. The strict Debian/RPM alternatives must run their restore-only package inspection prerequisites. A fresh verification job again proves the actual bytes and metadata without a workspace install. Both attempts retain their own source receipts, raw workflow-step observations and SHA-256 evidence inventories. Failed attempts stay failed and remain visible.

## Boundaries

Ubuntu 24.04 x64 only; no signing, publication, authenticated providers or other-distribution claim. The canonical workflow owns application processes and their original cleanup. The small metadata helper runs only fixed read-only Git/dpkg/rpm commands with timeout/error/exit recording, then hashes fixed artifacts. The actual hosted results, complete artifact ZIP identities and receipt inventories must be inspected before claiming success.
