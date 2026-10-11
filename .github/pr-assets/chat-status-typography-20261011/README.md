# Working status and chat typography evidence

These are two separate feature comparisons captured from immutable application sources in Chromium. The images come from actual production React components and styles, with visibly labelled controlled conversation/content. They do not represent a native desktop session or a live provider conversation.

- [Working status, #1824 / original #174](pr1824/README.md): inline Synara mark, shared shimmer, reduced motion, and retained-row font/status propagation. Includes genuine failing Before controls and passing repaired controls.
- [Chat typography, #1826 / original #175](pr1826/README.md): primary/supporting/process hierarchy, default code wrapping and reversible wrap controls, quotes/tables, and explicit RTL alerts in both themes and widths.

Original PNG and WebM bytes are preserved. `clips.json` records the source video hash, exact time range and output hash for each short MP4. Clips use time trimming and H.264 encoding only: no crop, speed change, graphic overlays, or synthesized frames. The full 1280×900 recording frame is retained, including visible browser-recorder padding around smaller fixtures. Each source directory contains its original logs, exit receipt and file-hashed provenance. A separate `artifact-digests.json` records the downloaded GitHub ZIP identities and verified SHA256 digests.
