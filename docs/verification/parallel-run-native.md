# Native production-app parallel-run acceptance

Chromium drove the built application through its normal connection, using actual OpenCode 1.19.0 and `opencode/mimo-v2.6-flash-free`. No NativeApi, provider transport, Git, SQLite, or provider response was replaced. The portable runner creates an empty Git repository and isolated provider directories without inherited credentials.

The final portable three-attempt run verified current composer selection, three distinct native session IDs, three real worktrees at one frozen base, three completed answers, a completed native comparison in a fourth thread/session, keeping one attempt, two archived siblings, and preservation of the source and all worktrees. Both real SQLite databases were read and exact transcript equality asserted for all three attempts. The reports pin the component source and actual rows. All four turns completed, with no tool approvals needed in this run. The PNGs were visually inspected.

The four `parallel-run-native-three-*.png` captures, `parallel-run-native-three-report.json`, and raw `parallel-run-native-three-check.txt` belong to this completed portable run. Earlier two-attempt captures/reports are separate and precede the final selection and transcript fixes. A second three-attempt run on the repaired production source also passed before the portable reproduction.

After building web and server, reproduce from the repository root:

```sh
OPENCODE_LIVE_BINARY=/absolute/path/to/opencode CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium python docs/verification/parallel-run-native-check.py
```

The runner requires Bun and Node.js 24 on PATH, launches a fresh isolated native CLI, and cleans it up. Free-model behavior/availability can change. Comparison uses the normal approval-required runtime. Only a short exact allowlist of read-only Git inspection requests against this synthetic repository may be approved once; every other request fails the check. The captured successful run requested no tool approvals. Completion is checked before Keep and then verified again in persisted SQLite.

Three component browser checks now pass using the actual Zustand store. These supplemental component tests substitute orchestration boundary functions and are not claimed as native acceptance. Server tests include four on-disk SQLite/Git cases plus deterministic automation/provider regression cases. All seven package compilers passed serially before the upstream release-only integration; final web types and production web/CLI builds pass. Full hosted CI on the published head supplies final-head qualification.

This establishes native OpenCode execution, not authenticated concurrency across every provider or packaged Electron behavior. No renderer capture is presented as native descendant-process termination proof.

The fourth-session integrity check also reads the actual native wire log: all four native session IDs are distinct, the complete comparison prompt follows the standard Synara harness prefix, and the saved comparison answer exactly matches the native generated answer. Run `python docs/verification/parallel-run-native-integrity-check.py` immediately after reproduction while the generated app fixture remains available. The free model's judgment is not graded by this fixture; it verifies prompt routing, completion, and transcript integrity.
