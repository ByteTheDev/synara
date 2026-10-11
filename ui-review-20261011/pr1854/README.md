# PR 1854 — actual Beta source-launcher icon Before Vs After

This evidence supports the author-preserving continuation of [PR 1849](https://github.com/Emanuele-web04/synara/pull/1849), [PR 1854](https://github.com/Emanuele-web04/synara/pull/1854). Both images are unchanged PNGs rendered by macOS AppKit from actual generated `Synara Beta.app` bundles. The source launcher compiled the checked-in Icon Composer catalog with `actool`, signed the resulting bundle ad hoc, and registered it with Launch Services before `NSWorkspace.icon(forFile:)` read its icon.

| Before — exact main `9e01962e0b1e8fec9fb0e17f17a64017bc4eaf94` | After — exact feature `4f7c61fe6f028d69ef187c9437286e7830628da4` |
| --- | --- |
| ![Before: Beta source launcher displays the white production tile and black mark](before/source-bundle-icon.png) | ![After: Beta source launcher displays the blue Beta tile and white mark](after/source-bundle-icon.png) |

Both captures use macOS 26.6.2, Xcode 26.6, ARM64, Aqua appearance and an unchanged 1024×1024 observer. There is no image editing or canvas substitution. Each source ran in a separate fresh hosted job in [run 38181306809](https://github.com/Emanuele-web04/synara/actions/runs/38181306809), attempt 1, with the same immutable evidence driver `5c713a700b398e63519a5938e82f0641d2ff17ed`.

## What passed

- Before job `114594264256` and After job `114594264151` both succeeded. The source commit, complete Git tree, tracked and untracked cleanliness, driver blobs and all six original catalog assets were checked. Source guards passed before installation, after installation, before and after native work, and at finalization.
- Both jobs used the real production `buildMacLauncher` function and native `ditto`, `plutil`, `actool`, `codesign` and Launch Services commands. Before compiled `assets/prod/Synara.icon`; After compiled `assets/beta/Synara.icon`. The output retained the Beta name and bundle identifier, and the generated signature passed strict verification.
- A second call reused each verified cache without any additional native commands. Its signed material and metadata stayed byte-identical. The original installed Electron binary and plist stayed unchanged. The fresh After metadata records the selected Beta catalog path.
- The After job ran all 22 unchanged canonical launcher assertions successfully on macOS, with zero failed, pending or skipped cases. These tests include injected command fixtures for failure, fallback, stale-cache, permissions and reopen behavior; they do not imply that every such branch executed against native utilities. The separate real native build above proves the actual compiled-catalog path and fresh-cache reuse.
- Fresh-runner preflight found no installed or running Synara app. No app was launched. Final owned-bundle unregister and removal succeeded on both jobs.

The launcher metadata records application version `1.0.3`. The copied Electron 43.4.1 bundle retains `CFBundleVersion` and `CFBundleShortVersionString` `43.4.1`; this evidence does not describe a packaged Synara release. Bun was 1.4.2 and the external Node executable was 24.20.0. Bun's reported Node-compatibility version is recorded separately in the provenance.

## Retained nonzero commands and limits

Each original source launcher first tried `lsregister -u` for its newly created bundle and received status 1 / error `-10814`. The existing source treats this preliminary unregister as best effort. Both raw command records are retained without alteration; subsequent registration, strict signature verification, actual rendering and final cleanup all succeeded. Of 142 recorded commands, these are the only two nonzero exits. No test or native assertion was removed to obtain the result.

These are actual AppKit bundle-icon renders, not screenshots of a live Dock, app picker or running application. The run does not establish live Dock lifecycle, TCC reset, signed release behavior, native flat-icon fallback, or migration of an already-existing launcher cache. The original author's macOS 27 images remain separate author-provided evidence in the PR body. The visual result here is the production-to-Beta artwork change on the explicitly pinned macOS 26 source-launcher path.

## Artifact integrity

| Artifact | Bytes | ZIP SHA-256 |
| --- | ---: | --- |
| `11718511095` — `source-icon-before-attempt-1` | 218,820 | `2f2c720d1d80d5f8bf3d123940e0b0d39a0fea43c79c093a40d40f9743fde0e1` |
| `11718102474` — `source-icon-after-attempt-1` | 519,731 | `c21fb06c0a7ade319d944991d93ce6816a40f1db590d7835eb52cbd757162875` |

Both ZIPs were downloaded and checked against GitHub's byte count and SHA-256, with unsafe archive paths, duplicate entries and symlinks rejected. All 187 files declared by the original two manifests, plus the manifests themselves, were independently rehashed after extraction. The same 187 portable receipt/media/source files are copied here unchanged; only the two compiled `render-source-icon` observer executables are excluded from this review branch. Their original bytes and hashes remain verified in the artifact records, and their exact Swift source is included. Nothing else from either artifact is omitted.

`origins.json` maps every copied file back to its actual artifact member and records the two explicit binary exclusions. `qualification.json` records the independent predicates, original nonzero commands, source IDs and image hashes. `artifact-metadata.json`, `run-and-jobs.json` and each phase's original `manifest.json`, native result, command receipts, source guards, test output and cleanup receipt preserve the evidence. `file-manifest.json` binds all review-branch evidence files except itself. The GitHub source and feature branches were not changed to create this evidence.
