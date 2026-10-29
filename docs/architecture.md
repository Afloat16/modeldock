# Architecture and extension points

## One viewer, host-owned file access

`mountViewer(container, config)` is the shared boundary for VS Code, standalone CLI, DeepSeek Harness and OpenAI file-entrypoint hosts. `ModelSource` carries a name and authorized `data`, `blob`, URL or bounded `readRange` callback, with size, revision and source identity where available. The viewer never enumerates the workspace. `ViewerHandle.load` replaces a normal session, or updates one source with `preserveView`; `add` appends another model. Native file selection can be provided through `config.pickFiles`, while the local File picker remains available in every host.

| Layer                   | Files                             | Responsibility                                                                                 |
| ----------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------- |
| Shared contracts        | `src/shared/`                     | Formats, limits, source and geometry contracts                                                 |
| Ordinary parser Worker  | `src/core/`                       | PLY/STL/OBJ/OFF/XYZ/PCD and OpenCascade conversion                                             |
| Large preview           | `src/large/`                      | Random-access sources, bounded binary PLY/STL sampling, rebased origins and provenance         |
| Comparison              | `src/compare/`                    | Deterministic sampling, spatial indices, rigid alignment, directional metrics and reports      |
| Viewer                  | `src/viewer/`                     | Three.js scene, comparison session, synchronized views, controls, cancellation and disposal    |
| Authorized native reads | `src/host/`                       | Selected-file metadata and revision-guarded bounded reads                                      |
| VS Code                 | `src/extension/`                  | Read-only custom editor, source IDs, native chooser and exact-file watcher                     |
| Standalone              | `src/cli/`                        | Tokenized loopback serving, HTTP byte ranges and revision polling                              |
| Harness                 | `adapters/deepseek-harness/`      | Native renderer, authorized workspace stat/range API and content revisions                     |
| OpenAI                  | `src/openai/`, `adapters/openai/` | MCP App, desktop file entrypoint, selected-resource metadata/ranges and resource subscriptions |

## Ordinary parsing and bounded large previews

The source ceiling defaults to 8 GiB in all four adapters. It is independent of the 128 MiB ordinary full-input parsing boundary. Large binary PLY/STL files use random-access sampling, including source sizes of at least 5 GiB; other large formats are rejected with an actionable boundary rather than passed to an enormous WASM allocation.

`src/large/` reads bounded blocks and returns typed geometry plus `origin` and `preview` metadata. The viewer caps this representation at 300,000 points / 100,000 triangles and 128 MiB of reads per preview. Large PLY mesh faces are currently omitted: the result is explicitly a sampled point representation, not a reduced triangle mesh. Binary STL can retain sampled surface triangles. Provenance includes original/displayed counts, sampled coverage, read bytes/calls, representation, omitted topology and whether the entire source was validated. Cancellation and revision checks apply to bounded work.

Ordinary non-glTF files parse in a fresh classic Web Worker. The main thread transfers a private input buffer and receives transferable typed arrays. OpenCascade initializes only for STEP/IGES/BREP. A newer load, cancellation, teardown or 120-second timeout terminates the worker and revokes its URL, releasing the WASM heap. Native ordinary range sources are assembled with reads no larger than 4 MiB before decoding; Harness further subdivides its host requests into 512 KiB reads.

Self-contained glTF uses Three.js GLTFLoader because scenes include node transforms, embedded textures and material graphs. Preflight validation rejects external URLs, unsupported codecs, invalid ranges, oversized accessors and cyclic node graphs. Parsing runs on the main thread and can briefly block; this is not a worker-based glTF pipeline.

These paths do not implement exhaustive out-of-core rendering, octree LOD or multi-gigabyte CAD tessellation. CAD can allocate additional memory before output counts become known. Host transfer ceilings and authorization apply before the viewer's own limits.

## Shared coordinate frame and comparison session

Each model retains its original coordinates and optional double-precision source origin. One common scene anchor frames the combined bounds, avoiding independent model centering that would erase meaningful offsets. GPU vertex attributes remain Float32. Manual rigid transforms act in source coordinates; optional scale is explicit, separately recorded, and never silently introduced by rigid ICP.

The comparison session stores reference and target IDs, unit acknowledgments, visibility, opacity, transforms and scale. It supports a colored overlay or synchronized side-by-side rendering through two scissored passes on one WebGL renderer and shared camera state. Adding models retains the primary watched source. Same-source refresh replaces that source's geometry while preserving the rest of the session and its registration state. A normal Open action starts a replacement session.

Comparison begins only after explicit unit confirmation. Changing a unit label does not convert coordinates. The pure comparison core uses deterministic surface/point samples, triangle BVHs or point indices, and reports the selected target representation. Rigid ICP is a local, explicit operation with overlap/convergence diagnostics. Manual translation/rotation provides an initial pose for large offsets. Evaluation does not automatically align either model.

Reports contain directional accuracy/completeness summaries, non-squared Chamfer distance, tolerance precision/recall/F-score, a sampled maximum, transforms, seed, budget and preview provenance. Heatmaps display evaluated samples. Exact Hausdorff distance, signed distance, normal consistency, volume and watertightness are outside this evaluation. A point-only PLY preview cannot provide exact surface ground truth.

The viewer limits retained comparison geometry to 512 MiB and 16 models. Replaced/removed models dispose geometries, materials, textures and overlays. Changing the source, units, transform or tolerance invalidates prior results; pending comparison work can be cancelled. Rendering is requested on change, resize and damping updates, with no permanent idle render loop.

## File updates and lifetime

VS Code uses exact-file watcher events, including atomic replacement, and native source IDs with bounded reads. CLI metadata polling detects the selected source revision every 1.2 seconds; HTTP `206` ranges check the selected file and revision. Harness uses `loading: 'renderer'`, host content revisions and `remote.workspaceFiles.stat/readBytes`, avoiding the complete-file transport ceiling. OpenAI subscribes to the opaque resource and uses selected-file metadata plus bounded reads where the host provides official file context; otherwise a 128 MiB legacy resource-read path remains.

Within a mounted viewer, failed loads retain the last valid geometry. Same-resource updates preserve the camera and comparison state. Harness can still dispose/remount a preview body; its 32-entry camera cache restores small view snapshots, not detached WebGL contexts or full comparison geometry. A remount cannot preserve an already discarded scene during a malformed replacement. Ordinary local Open stops following the CLI's initial file, whereas Add models and additive drops keep it watched.

## Authorization and security boundaries

VS Code uses a restrictive webview CSP, nonce-based scripts and packaged asset roots. The extension maps opaque source IDs to specifically opened/chosen resources; app messages cannot select arbitrary filesystem paths. CLI binds only to IPv4 loopback and routes one selected model plus packaged assets. A random token, Host/Origin checks, exact routes, range validation, selected-file checks and revision-guarded file descriptors constrain access. No upload endpoint or directory browser is added.

Harness reads remain under the host's workspace permission checks. The OpenAI tools `modeldock_file_info` and `modeldock_read_range` are app-only and accept metadata/range arguments without a path. The server obtains the selected path solely from host-injected `_meta['openai/resource'].path`, through the official SDK helper. It does not interpret the opaque resource URI as a filesystem path and exposes no general filesystem read, write or workspace enumeration tool. Range requests are bounded to 4 MiB, checked against the selected revision and source ceiling. Legacy content accepts only the exact selected resource URI.

Embedded Worker/CAD code and WASM use local Blob URLs; no public asset service is required. Dependency notices and CAD source procedures accompany distribution. These boundaries do not guarantee that malformed CAD input or a graphics driver is infallible; see [SECURITY.md](../SECURITY.md) and [validation.md](validation.md).

## Adding a format or host

Add a real parser and explicit tests before extending the supported suffix registry and native manifests. A new large format also needs a bounded random-access strategy and honest representation/provenance; raising a size constant does not create one. Proprietary CAD formats require an appropriately licensed parser or an export workflow.

A new host should call `mountViewer`, dispose on unmount, preserve borrowed buffers, pass authorized sources and revisions, bound all reads, and document whether it supplies a native tab or an external URL. Validate that distinction in the actual host before claiming native support. Exact executed targets and outstanding host acceptance checks belong in [validation.md](validation.md).
