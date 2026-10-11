# Windows process snapshot phase diagnostic

This isolated diagnostic keeps source pinned to `e0dc656efd9f6b4e45999f7925d9122eadba1c06`, the reviewed Windows preparation candidate. The earlier runtime experiment at `428e8b746aa74f6683d13bedb6053b09c1dabae0` failed under both Node and Bun: no production snapshot completed, including the separate 15-second raw observation. Those failures remain unchanged in their original run and artifacts.

The new probe uses the same seven exact production source files, production worker/parser and scoped spawner. Bun 1.4.2 compiles the source once to an independently hashed Node-target bundle. Only Node executes this experiment. No package installation, provider session or teardown success is claimed.

| Case        | PowerShell script                                                                                                                            | Request stream                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| exact-open  | Actual unmodified production command captured from its owned child                                                                           | Production capture writes its original request; pipe remains open               |
| exact-eof   | Same unmodified production command                                                                                                           | Production capture writes its original request; then the same pipe receives EOF |
| phased-open | Reversible fixed stderr markers around command resolution, first row and query completion; explicit Get-Command resolves the same CIM cmdlet | Original request, pipe remains open                                             |
| phased-eof  | Identical instrumented script                                                                                                                | Original request followed by EOF                                                |

Instrumentation is an experiment, not a production repair. It can affect module warm-up and timing. Both actual script digests and the exact reverse-to-production check are retained. The default production observation policy remains 3 seconds; these four observations use the already qualified separate 15-second diagnostic bound and a 5-second owned-root close drain. A failed unchanged control remains a failed job even if an experimental case succeeds.

The worker's actual spawn/exit/close/error observations are separate from the capture result and explicit disposal request. Disposal never proves provider or descendant exit. The probe never signals a numerical PID. If the owned child does not close within the observation drain, it releases only its streams/handle reference, records forced output cutoff and fails the case; runner cleanup is not asserted.

A named environment allowlist, private profile/cwd and writable private PowerShell module cache match the preceding experiment. Receipts contain field presence, hashes, aggregate counts, fixed phase labels and actual exit classifications. Process rows, encoded command arguments and environment values are never published. Subprocess output is copied once from a separate live directory into bounded immutable snapshots before parsing and hashing. The complete pinned source/driver worktrees must stay clean.

Local controls exercise real Node stream fragmentation, oversized-row/unknown-phase rejection and the exact source-literal transformation. They are not Windows or CIM execution. Native results remain pending until the hosted run and artifact verification finish.
