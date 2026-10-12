# PR1858 retained server 3/3 diagnostic

The canonical job [114612552287](https://github.com/Emanuele-web04/synara/actions/runs/38187373364/job/114612552287) failed at exact feature head `b7fd69812cb169c60a5b9fac17b05b6ff81b5322`. Its log could not be decoded through the available connector: three bounded requests across two readers returned `Transport closed`. The original failure remains a failure.

This isolated workflow checks out that exact source tree `6b5e0bc1756d8f0586aa67b9bf1c30ea266cd158`, uses the canonical Ubuntu 24.04 setup action and defaults, and executes the unchanged command:

```sh
bunx turbo run test --filter=@synara/cli -- --shard=3/3
```

No production or test file is changed. Before and after guards check every tracked source byte and executable mode against the pinned Git tree. The driver lives in a separately checked out directory. The setup action, dependency lock and all test assertions remain those of the source head.

The observer records actual root exit, pipe close, errors, deadline and any forced truncation separately. It permits 30 minutes for this command, then signals only its own still-live root ChildProcess handle and permits 10 seconds to drain pipes. It never signals numerical PIDs or claims that descendant processes exited. The surrounding job has 40 minutes for setup, execution and upload. A deadline, incomplete output, capped 32 MiB log, source change, or nonzero actual command result remains a failed diagnostic.

Only immutable observed log bytes and receipts are uploaded. No live log directory or environment values are included. A green result in this independent job would establish that this separate execution passed; it would not erase or explain the original canonical failure.
