# Validation record — ModelDock 0.2.0

Validation date: **2026-10-29**. These results establish behavior on the listed fixtures and hosts, not on every exporter, operating system, GPU or model. The source-size ceiling and the amount of geometry actually inspected are separate quantities.

## Executed checks

| Layer                                | Result                                         | Evidence and scope                                                                                                                                                        |
| ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                           | Passed                                         | Shared renderer, decoders, comparison core, native adapters and tests                                                                                                     |
| Automated tests                      | **105 passed; no failures or skips**           | `npm test`; original 63 cases, 20 comparison cases, 13 large-loader cases and 9 native-range cases                                                                        |
| Shared viewer                        | **15 browser groups passed**                   | Real Chromium WebGL, Worker and WASM; mouse input, file replacement, strict CSP and all ordinary supported formats                                                        |
| Comparison interface                 | **9 browser groups passed**                    | Multiple models, STL reference, units, overlay/split view, manual transforms, ICP, heatmap, batch reports and refresh preservation                                        |
| Actual files above 5 GiB             | Passed                                         | Real sparse binary PLY and STL through both Chromium File/Blob slices and HTTP 206 ranges; sentinels at the beginning, middle and end                                     |
| OpenAI stdio process                 | **6 operations passed**                        | Actual bundled server and unmodified MCP SDK transport; initialization, discovery, HTML read, viewer invocation and unknown-resource rejection                            |
| OpenAI legacy resource interface     | **7 browser groups passed**                    | Real bundled app/Worker/WebGL in a simulated Desktop host; ordinary PLY, STEP, updates, subscriptions and unsupported-host behavior                                       |
| OpenAI selected-file range interface | **6 browser groups passed**                    | Actual app plus real MCP SDK client/server; sparse PLY and STL above 5 GiB, revision changes, cancellation boundaries and bounded reads; Desktop carrier simulated        |
| DeepSeek Harness native Web host     | **8 browser groups passed**                    | Actual installed adapter in `@deepseek-ai/dsh@0.2.2-alpha.2`; single-click routing, interaction, refresh, STEP, >5 GiB PLY/STL and real byte-range transport              |
| VS Code native Electron              | Local execution blocked by unavailable display | Four-stage native acceptance is included in GitHub CI; see the current [Actions results](https://github.com/Afloat16/modeldock/actions) and the native-test section below |

Test runners write compact reports to `test-results`, which is excluded from Git and release source archives. CI uploads its reports separately. A recorded native or simulated result is identified explicitly; a mock transport does not establish an installed proprietary Desktop result.

## What the 5 GiB checks prove

A **5 GiB** source is 5,368,709,120 bytes, already larger than decimal 5 GB. The tests create valid binary PLY/STL files slightly above that boundary, without allocating an equally large buffer. Sparse filesystem holes contain zero-valued records; a few physical blocks hold headers and nonzero sentinels. The native VS Code fixtures, for example, occupy 8,192 allocated bytes each while their logical sizes exceed 5 GiB. Test fixtures are removed in cleanup and are not committed or packaged.

These are size, addressing, transport, sampling and rendering tests. They are **not dense 5 GiB disk-throughput or GPU performance benchmarks**. They verify offsets beyond both 4 GiB and the file's middle, exact sampling counts, bounded read sizes, retained endpoint geometry, and rejection of changed/truncated or unbounded responses.

All four entrances default to an **8 GiB selected-source ceiling**. Binary PLY/STL above the ordinary 128 MiB parsing boundary use a bounded representation: at most 300,000 points or 100,000 triangles in the viewer. Large PLY meshes currently provide sampled vertex points, with face topology explicitly omitted. Binary STL provides sampled whole triangle records. ASCII formats, GLB/glTF, PCD and in-memory OCCT CAD decoding do not gain full 5 GiB support merely from this higher source ceiling. See [large-files.md](large-files.md).

### OpenAI range observations

The actual bundled app and MCP server were connected through the official SDK, with a simulated host injecting only the selected path in trusted `_meta["openai/resource"]` metadata. The app supplied no filesystem path. Across initial loads, updates and the stale-version test:

- PLY source: **5,368,709,286 bytes**, rendering 300,000 sampled points.
- STL source: **5,368,709,284 bytes**, rendering 100,000 sampled triangles.
- **517** range requests, **26,665,620** requested bytes in total.
- Largest requested chunk: **56,256 bytes**; largest offset: **5,368,670,234**.
- **Zero whole-file `resources/read` calls**, and one deliberately rejected stale revision.
- A valid later update recovered and retained the camera; no uncaught page exceptions or external model/asset requests occurred.

These totals cover the whole scenario, not a single file load. Missing selected-file metadata falls back only to the bounded legacy resource route; it cannot silently turn a multi-gigabyte file into a single base64 response.

### Actual native Harness observations

An isolated profile installed the real `dsh-plugin-modeldock` package and opened the genuine Web host, without an API key, chat submission or model-provider request. The native file tree selected **ModelDock · 3D** on a single PLY click. Tests verified:

1. A 48,000-point cloud renders in the native shadow-root preview.
2. Rotation, right-button pan and wheel zoom change the expected camera values.
3. Atomic replacement updates the model to 4,096 triangles and preserves the exact front camera through renderer-owned reload.
4. The original STEP bracket tessellates to 1,280 vertices and 1,276 triangles.
5. A binary PLY above 5 GiB renders 300,000 sampled points.
6. A binary STL above 5 GiB renders 100,000 sampled triangles.
7. Observed native `workspaceFiles/readBytes` HTTP calls are explicitly ranged: **264 requests**, **13,843,812 requested bytes**, maximum chunk **524,288 bytes**, largest offset **5,368,670,184**, and **zero unbounded byte reads**.
8. No uncaught browser errors occur.

The initial v0.2 attempt exposed a genuine Cordis capability-declaration error. Declaring `remote.workspaceFiles` in the client injection list, in addition to the base remote service, fixed the native permission contract. The packaged adapter was rebuilt and reinstalled, the task-owned host restarted, and the complete native test rerun successfully. Unit mocks alone would not have caught this declaration failure.

Harness Desktop is a separate carrier and was not run. The native Web result applies to the pinned host version. See [harness-integration.md](harness-integration.md) for reproduction; preserve the private token in the host's printed local URL when running the test, and never publish that URL.

## Comparison accuracy and interface behavior

Core tests cover known triangle-interior/edge distances, area-weighted surface sampling, correct directional accuracy/completeness, threshold precision/recall/F-score, deterministic seeds, exact rigid landmark fits, local ICP, non-overlap rejection, deformation residuals, large coordinate origins, units, cancellation and nontrivial BVH/KD-tree searches. They reject implicit scale, reflections, shear and degenerate landmark configurations.

The browser workflow exercises a reconstruction offset by 0.03 mm from an STL reference. It verifies raw error, explicit manual correction, ICP recovery, both viewing modes, sampled error coloring, reports for every non-reference model, and JSON/CSV downloads. When the primary source changes from a 0.03 to a 0.04 offset, the stored correction remains and the residual becomes 0.01; the other models, selected reference, units and transformations survive refresh.

Reports distinguish raw versus aligned evaluation, manual scale, rigid transformations, coordinate origins, chosen units, threshold, seed, sample counts and preview provenance. Mesh target distances use triangle surfaces within the configured bound. Approximate maxima are not advertised as exact Hausdorff distances. The heatmap and metrics describe loaded/sampled geometry; they do not certify unobserved multi-gigabyte content. See [comparison.md](comparison.md) for formulas and remaining interpretation limits.

## Ordinary rendering, CAD and protocol regressions

The shared viewer checks colored clouds, both binary PLY endiannesses, both STL encodings, OBJ/OFF/XYZ/PCD, STEP/IGES/BREP and self-contained textured GLB/glTF. It also verifies orbit/pan/zoom, preset views, projection and up-axis changes, display modes, clipping, two-point measurement, Unicode filenames, narrow layouts, malformed-write recovery, and preserved camera state. External texture/model references are not fetched.

CAD is rendered by the actual OpenCascade WASM. The published upstream JavaScript glue originally required dynamic function generation, incompatible with a strict webview policy. ModelDock applies a deterministic, upstream-hash-guarded static-closure patch. Tests prove the unpatched glue fails with string-code generation disabled, then compare every output coordinate, normal, index, color, name and warning from patched versus original runtimes. A real strict-CSP Worker imports STEP, IGES and BREP; JavaScript `unsafe-eval` is not enabled. The WASM is unchanged. Matching source provenance, patch and rebuild instructions are in [cad-source.md](cad-source.md).

The bundled MCP server passed real stdio initialization, tool/resource discovery, complete HTML resource reading, viewer invocation and unknown-URI rejection. The measured resource JSON response was **6,119,853 bytes**, below the unchanged SDK default **10,485,760-byte** ceiling. A gzip/DecompressionStream bootstrap and a build-size guard keep the embedded CAD runtime within that transport budget. The browser test checks nonce propagation and an actionable message if decompression support is unavailable.

## Native-host boundaries

### VS Code

The portable native runner opens an isolated Extension Development Host and verifies default mixed-case associations, activation, read-only source access, actual WebGL mouse behavior, file-watch refresh, STEP, Reopen as Text, and both >5 GiB sparse files. Its large-file stages require exactly 300,000 PLY points and 100,000 STL triangles, visible sampling warnings, and 3 × 1 × 1 bounds established by far-end sentinels beyond 5 GiB. Input size, modification time and bounded first/last snapshots must remain unchanged.

Local Electron execution stopped at the missing-display guard. A previous system package-metadata update was rejected by automatic approval review because it would write outside the workspace; a workspace-only Xvfb attempt also lacked a fixed-path keyboard compiler. No system-path change was made. This environment limitation is not recorded as a native pass. On a normal Linux runner, use:

```sh
xvfb-run -a npm run test:extension
```

The GitHub workflow runs this gate and saves `test-results/vscode-native.json`. Consult the exact workflow run for subsequent CI evidence; the rest of this record separates executed local results from tests merely present in the repository.

### OpenAI/Codex Desktop

No proprietary Desktop installation was available for install-and-click acceptance. Actual SDK, stdio server and bundled-app tests passed, with the Desktop host simulated. A native target must implement file entrypoints, host-managed selected-file metadata/resources, Blob workers and WebAssembly for CAD. OpenAI's [official file-entrypoint specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#filesystem-access) documents server-tool filesystem access for large selected files. Work Web, mobile and a bare CLI are not claimed as native file-viewer hosts. The CLI browser viewer remains an independent fallback. See [openai-integration.md](openai-integration.md).

## Reproduction environment and exclusions

Local validation used Linux x86-64, Node.js 24.22.1, TypeScript 7.0.2, Three.js 0.186.1, Playwright 1.51.1 / Chromium 134 with software WebGL, occt-import-js 0.0.23 / OCCT 7.6.1, and DeepSeek Harness 0.2.2-alpha.2 Web. [releasing.md](releasing.md) lists the full test and release commands.

No Windows/macOS native-host matrix, dense multi-gigabyte throughput benchmark, complete out-of-core spatial LOD engine, Remote SSH/WSL acceptance run, proprietary CAD-format support, full Gaussian-splat rendering, exact full-file deviation calculation, or independent security audit is claimed. The CAD source build recipe is included; a full Emscripten recompilation was not performed here.
