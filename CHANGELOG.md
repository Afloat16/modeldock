# Changelog

## 0.2.0 — 2026-10-29

- Added multi-model sessions with preserved source coordinates, STL/mesh/point-cloud references, visibility/opacity, overlays and synchronized side-by-side views.
- Added explicit coordinate-unit confirmation, local rigid ICP, manual translation/rotation/scale, transform reset, pair and each-to-reference evaluation, sampled deviation heatmaps and approximate geometric metrics. JSON/CSV exports include transforms, explicit scale, seeds and sampling provenance.
- Raised the default selected-source ceiling to 8 GiB across all four hosts. Binary PLY/STL above 128 MiB use bounded previews for sources of at least 5 GiB, capped at 300,000 points / 100,000 triangles in the viewer. Large PLY meshes are explicitly vertex-only with topology omitted. Other formats retain the 128 MiB full-input parsing boundary; this release does not promise multi-gigabyte CAD conversion.
- Added revision-guarded selected-file/range transport: VS Code source IDs and native selection; CLI HTTP 206 ranges; Harness renderer-owned 512 KiB workspace reads; OpenAI app-only selected-file metadata and up-to-4 MiB range tools using official host-injected file context. The OpenAI legacy resource fallback remains bounded to 128 MiB.
- Preserve secondary models, reference, chosen units and transforms when a mounted primary source refreshes. Bound comparison sessions to 16 models / 512 MiB geometry and cancel obsolete loading/evaluation work.
- Added known-answer geometry, large-source, host-range and real-browser comparison coverage. Actual host validation and remaining acceptance steps are recorded in `docs/validation.md`; simulated OpenAI delivery is not a claim of real Desktop installation.
- Added verified fetching of pinned corresponding CAD source archives instead of vendoring the approximately 52 MB archives into Git. Complete release ZIPs include the verified matching sources.

- Verified native VS Code in GitHub CI and the actual installed Harness Web adapter with sparse PLY/STL sources above 5 GiB. Browser, comparison and range tests are release gates.
- Updated test tooling and scoped vulnerable Zod/MSAL transitive dependencies; dependency audit reports zero known vulnerabilities at release validation. Generated license inventories are rebuilt after dependency changes.

## 0.1.0 — 2026-10-29

Initial open-source release candidate. Added the shared point-cloud/mesh/CAD viewer; VS Code custom editor; DeepSeek Harness document preview; OpenAI desktop file entrypoint; tokenized local viewer; automatic reload; navigation, display controls, clipping and approximate measurement; original fixtures, tests, CI and release packaging.

This is a first release, not a claim of production validation across every host, graphics driver or CAD exporter. See the validation record and supported-format boundaries.
