# Source-pinned Before Vs After evidence for #1857 and #1860

This diagnostic runs four immutable application checkouts under the same Ubuntu Chromium environment. The driver is separately checked out at the Actions run's full commit. It has read-only repository permissions, never modifies tracked application files, and does not replace canonical CI.

| Target                       | Application commit                         | Application tree                           | Expected selected result                                                   |
| ---------------------------- | ------------------------------------------ | ------------------------------------------ | -------------------------------------------------------------------------- |
| Image provenance Before      | `9e01962e0b1e8fec9fb0e17f17a64017bc4eaf94` | `81b2ce105b3362e1266bb15916e0b16633f3843d` | Ingestion 1 pass / 1 fail; full ChatView 1 pass / 1 fail                   |
| Image provenance After #1857 | `00d069ea71154ae11b87944a542bb845878b7050` | `eeeb0b2796614b2680ea36ed27c77f3bdd161303` | Ingestion 2 pass; full ChatView 2 pass                                     |
| Settings Before              | `9e01962e0b1e8fec9fb0e17f17a64017bc4eaf94` | `81b2ce105b3362e1266bb15916e0b16633f3843d` | Canonical new launch-argument case fails because the field is absent       |
| Settings After #1860         | `638e419bc952566932bbf7cddf0b129bafc4d434` | `f3534dbf68d6550206470e7614e9d477ccb5e837` | The identical case passes, preserving raw arguments and both account paths |

## What is actually observed

The image cases persist controlled provider events into the production SQLite runtime journal and use actual `ProviderRuntimeIngestion` to produce the database thread detail. Both sources receive the same semantic sequence: a completed text answer followed by either an old unmarked `imageView` event or a generated-image event, then turn completion. A checked-in 180px Beta PNG is copied unchanged inside the actual allowlisted image root. This is a fixture image, not newly generated artwork or a live Codex session.

The resulting raw projection, original events, command read model and exact image bytes are retained. The real production `ChatView` receives the database thread detail with its actual project/space shell through the complete canonical controlled RPC fixture. Message and activity content is never rewritten. A narrowly labelled HTTP seam returns only the exact fixture PNG for its exact source-produced local-image path. The native local-image HTTP route and packaged Electron are not exercised. The Before image-view result wrongly renders that PNG; After must omit it. Both genuine generation controls must still render it. Captures occur before the same correctness assertions, so the wrong Before UI is retained as an actual failed result.

The settings case is the exact additive browser test committed to #1860, appended unchanged to the full main fixture. Reversible observer insertions capture the real Codex account group before input and, After only, after the original assertions. It edits `-c model_provider="api token" -- --value trailing\`, blurs the field and requires the exact raw patch while leaving the binary and home inputs unchanged. Controlled native/status fixtures are explicit; no live authentication, CLI process launch or packaged account claim is made.

## Integrity and failure handling

Preparation and verification enforce the full application commit/tree, a clean tracked source tree, selected production/test blobs, the exact driver commit/tree, and hashes of every copied observer fixture. All canonical fixture bytes remain recoverable by reversing only the observer additions. Filtered canonical cases are recorded as unselected, never passes.

The workflow retains actual Vitest process and tee exits. Before diagnostics deliberately return nonzero and remain failed assertions in their raw reports. Only the final verifier may accept those exact expected failures after checking actual observations and media; unexpected failures, missing exports, missing screenshots or missing video fail the job. After diagnostics must return zero. Canonical PR CI remains independently required.

Reports, logs, exits and raw projections are written to owned runner-temp paths. Browser PNG/WebM writers use an isolated owned application-workspace directory that Vite permits, separate from the artifact tree; the Vite allowlist is unchanged. The driver opens only regular non-symlink files, checks size before bounded allocation, and freezes exact copies with stable descriptor/path identity, size and timestamps. Projections are frozen before the browser fixture consumes them; verification consumes only frozen reports and media. Every snapshot records its cutoff. Missing files, concurrent changes, timeout or cancellation make verification incomplete, and later live writes cannot alter the retained copies.

The artifact contains original logs and exit receipts, complete copied fixtures, raw SQLite projections, provenance and command receipts, PNGs, original WebMs, and an exhaustive SHA256/Git-blob manifest. Hidden members under the owned output tree are included in upload. Screenshots retain the actual 960×1100 viewport pixels produced by the stated controlled fixtures. The workflow also requires normal completion of both diagnostic steps; a killed or timed-out process is never accepted merely because it happened to leave an expected-looking report.
