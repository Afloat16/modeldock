# ModelDock

**Open a 3D model as naturally as opening a source file.**

[GitHub](https://github.com/Afloat16/modeldock) · [Releases](https://github.com/Afloat16/modeldock/releases) · [简体中文](README.zh-CN.md) · [Architecture](docs/architecture.md) · [DeepSeek Harness](docs/harness-integration.md) · [OpenAI desktop](docs/openai-integration.md) · [Validation](docs/validation.md)

ModelDock is a local 3D preview toolkit for AI-assisted reconstruction and CAD workflows. It includes a VS Code custom editor, a native DeepSeek Harness document-preview plugin, an OpenAI desktop file-entrypoint plugin, and a standalone local viewer. They share the same renderer, parsers, large-file preview pipeline, and comparison core.

Generate a model, click the file, and inspect it. For reconstruction evaluation, use **Add models → choose reference / ground truth → align if needed → compare**. A reference can be a CAD-derived STL or another mesh/point cloud. Source coordinates stay intact; models are never aligned automatically.

## What it does

- Click a supported file in VS Code to open an interactive editor tab. The extension also works beside Codex in VS Code; compatible forks require their own installation check.
- Register native document previews in DeepSeek Harness and native file entrypoints in supported OpenAI desktop hosts.
- Orbit, pan, zoom to cursor, frame the model, and switch front/right/top/isometric views.
- Switch perspective/orthographic projection and Y-up/Z-up navigation.
- Inspect colored point clouds, meshes, parts, dimensions, vertex/triangle counts, and model units.
- Toggle solid/wireframe/points/normals, grid, axes, bounding box and part visibility.
- Use an axis-aligned section plane or pick two surface points for approximate distances.
- Refresh files rewritten by an agent while preserving the camera. A failed rewrite in an existing preview keeps the last valid model visible; see the Harness remount limitation below.
- Parse PLY and other reconstruction/CAD formats locally in a cancellable Web Worker, with a bundled WebAssembly CAD kernel. Self-contained glTF uses a validated main-thread loader. ModelDock has no model upload, telemetry, API key, CDN dependency, or cloud conversion.
- Load several models into one session, choose target and reference, and inspect a colored overlay or synchronized side-by-side view. Each model has visibility, opacity, coordinate-unit, and removal controls.
- Apply explicit rigid ICP or manual translation/rotation/scale, reset the transform, and compare one pair or every model against the reference.
- Display approximate sampled deviation heatmaps, RMSE, P95, sampled maximum, Chamfer distance, precision, recall and F-score at a chosen tolerance. Export JSON/CSV with transforms, explicit scale and sampling provenance.
- Preview binary PLY/STL files of at least 5 GiB through bounded byte-range reads, with original/displayed counts and sampling warnings. The default source ceiling is 8 GiB; this does not promise full-file rendering or multi-gigabyte CAD conversion.
- English and Simplified Chinese UI.

## Formats and boundaries

| Format         | Support                                                                                                      | Boundaries                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PLY            | ASCII, binary little/big endian; mesh or point cloud; vertex color and normals; bounded large binary preview | Gaussian PLY is a centroid point preview, **not** a full Gaussian splat renderer. Large PLY meshes currently become a sampled vertex-only preview with topology explicitly omitted. |
| STL            | ASCII and binary; bounded large binary surface preview                                                       | Geometry only; invalid/zero normals are recomputed.                                                                                                                                 |
| OBJ            | Meshes, groups, points, lines; negative indices                                                              | MTL and external textures are not loaded.                                                                                                                                           |
| OFF            | Polygon meshes                                                                                               | Standard geometry and supported vertex color records.                                                                                                                               |
| XYZ            | Text point clouds with optional RGB                                                                          | No automatic geospatial coordinate rebasing.                                                                                                                                        |
| PCD            | ASCII, binary, binary_compressed/LZF                                                                         | Standard XYZ and packed/separate RGB fields.                                                                                                                                        |
| GLB / glTF 2.0 | Self-contained scene, embedded buffers/textures, node transforms                                             | Export uncompressed GLB. External sidecars, Draco, Meshopt, KTX2 and GPU-instancing extensions are not supported. Animation stays in its initial pose.                              |
| STEP / STP     | Local OpenCascade tessellation, part names and colors                                                        | Read-only triangulated preview; output coordinates are mm.                                                                                                                          |
| IGES / IGS     | Local OpenCascade tessellation                                                                               | Output coordinates are mm.                                                                                                                                                          |
| BREP / BRP     | Local OpenCascade tessellation                                                                               | Source coordinate units are retained; the file has no reliable unit metadata.                                                                                                       |

DWG, DXF, native SolidWorks/Creo/CATIA/Inventor files, FCStd, USD and LAS/LAZ are not supported in this release. Export STEP for CAD or PLY/GLB/STL for reconstruction. “CAD preview” means visualizing tessellated surfaces; it does not provide parametric editing, constraints, topology editing, or exact CAD metrology. Face-level CAD color and an editable assembly tree are not preserved.

## Install in VS Code

1. Download `modeldock-0.2.0.vsix` from the [release assets](https://github.com/Afloat16/modeldock/releases).
2. In Extensions, choose **… → Install from VSIX…** and select the file.
3. Click `fixtures/demo-arch-cloud.ply` or `fixtures/mounting-bracket.step`.
4. If another extension owns the format, choose **Reopen Editor With… → ModelDock 3D Preview → Set as Default**.

Or install from a terminal:

```sh
code --install-extension releases/modeldock-0.2.0.vsix
```

The command palette also includes **ModelDock: Open 3D Preview** and **ModelDock: Reopen as Text**. The viewer is read-only and never rewrites the original model. Supported filenames are case-insensitive, including `.Ply` and `.Step`.

For Remote SSH/WSL/dev containers, install the extension in the workspace extension host. File reads use VS Code's `workspace.fs`, exact selected-resource IDs, and bounded native reads; this path is implemented but needs validation against your remote provider. `vscode.dev` is not a declared target: this package has a Node extension entry, not a browser extension entry.

## OpenAI desktop / Codex

Use the VSIX beside Codex in VS Code. For a desktop host supporting OpenAI file entrypoints, install the portable plugin in `adapters/openai`; it declares `.ply`, `.step`, and the other supported extensions. The host supplies an opaque resource URI and selected-file authorization. App-only metadata and range tools read only the path injected by the host through official selected-resource metadata; their arguments never accept a filesystem path. Older hosts can use a bounded 128 MiB resource-read fallback. If a host cannot provide ranges, **Add models** can select a local file directly.

See [the exact installation and verification steps](docs/openai-integration.md). **A stdio MCP connection alone does not guarantee that a client displays a file viewer.** Desktop file-entrypoint support is required. Plain Codex CLI has no graphical canvas; use the local viewer below, or open the workspace in VS Code. Work Web and mobile are not declared native-file-entrypoint targets in the protocol version used here.

## DeepSeek Harness

The native package is `adapters/deepseek-harness`, targeting the documented `0.2.2-alpha.2` preview contract. It registers a document renderer for existing right-sidebar file tabs. Its renderer obtains metadata and bounded byte ranges through the host's authorized workspace-file remote API. It does not ask Harness to deliver the whole large file first.

Install the packaged `dsh-plugin-modeldock-0.2.0.tgz` following [the version-specific guide](adapters/deepseek-harness/README.md). Harness currently requires a newer Node runtime than the standalone viewer. Preview APIs can change; check [the pinned integration contract](docs/harness-integration.md) when upgrading. The adapter uses `loading: 'renderer'`, observes content revisions, and preserves the existing comparison session on same-resource refreshes while mounted. A bounded per-resource camera cache covers host remounts; a remount retains camera state, rather than complete comparison geometry.

## Standalone local viewer

The release source package includes prebuilt `dist/` files. Node.js 22+ is sufficient for the local viewer; you do not need to install npm dependencies just to run those prebuilt files.

```sh
node dist/cli.cjs ./fixtures/demo-arch-cloud.ply --open
node dist/cli.cjs ./fixtures/mounting-bracket.step --open
node dist/cli.cjs ./result.ply --max-size-mb 8192 --port 3210
node dist/cli.cjs --help
```

Without a filename, the viewer provides a file picker and drag/drop. With a filename, it watches the selected model through local revision polling. It binds only to `127.0.0.1` and prints an unguessable local URL. No public listener, directory browser, or upload route is created. The process must remain running while you use the URL. `--open` explicitly launches your default browser; otherwise open the printed URL in a browser or a compatible in-app browser.

You can have an agent end a reconstruction task with this command to remove the repeated import/export step. Remote machines need your normal SSH port forwarding; a remote `127.0.0.1` URL is not automatically reachable from your desktop.

## Controls

| Action                     | Mouse / shortcut                                |
| -------------------------- | ----------------------------------------------- |
| Orbit                      | Left drag; one-finger drag                      |
| Pan                        | Right drag or Shift + left drag; two-finger pan |
| Zoom                       | Wheel / pinch; zoom follows the cursor          |
| Set orbit pivot            | Double-click a surface                          |
| Fit / reset                | `F` / `R`                                       |
| Front / right / top        | `1` / `3` / `7`                                 |
| Perspective / orthographic | `5`                                             |
| Grid / bounds / axes       | `G` / `B` / `A`                                 |
| Wireframe                  | `W`                                             |
| Two-point measurement      | `M`, then click twice; `Esc` exits              |

Click the viewport before keyboard shortcuts. Measurements use tessellated geometry or point selection and display the model's units. They are approximate. Unitless PLY/STL/OBJ dimensions must not be assumed to be millimetres.

## Comparing reconstruction results

1. Open a model, then choose **Add models** to load the reconstructions and an STL/mesh/point-cloud reference. Adding a model retains the original watched file and its refresh behavior; using the ordinary Open action replaces the session.
2. Select **Reference / ground truth** and **Target**. Choose each model's actual coordinate unit. PLY/STL files generally do not establish physical units. A unit label confirms what the coordinates mean; it does not convert values.
3. Inspect the overlay or synchronized side-by-side view. Leave the source coordinates untouched for evaluation of an already registered reconstruction. Use **Rigid ICP** only when registration is intended. ICP is a local method and needs a reasonable initial pose; manual translation/rotation can provide one. Explicit scale is available under the manual controls and is recorded in exports.
4. Enter a distance tolerance in the confirmed coordinate unit, choose **Compare pair** or **Each → reference**, and export JSON/CSV if needed. Changing models, units, transforms or tolerance invalidates the old result.

Heatmap dots represent evaluated samples. The maximum is a sampled maximum, rather than an exact Hausdorff distance. Surface targets use triangle distances when the comparison budget permits; larger targets can use a bounded approximation, identified in the report. Precision measures the target samples within tolerance of the reference; recall measures reference samples covered by the target. The reported Chamfer distance is the mean of the two directional mean distances, without squaring. These are approximate geometric comparisons, not signed-distance, watertightness, normal, volume or exact CAD measurements. A sampled point-only PLY preview cannot supply exact surface ground truth.

## Large files and resource limits

| Boundary                    | Default / behavior                                                                                                           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Selected source size        | **8 GiB** in VS Code, CLI, Harness and OpenAI adapters; host authorization/transport limits still apply.                     |
| Ordinary full-input parsing | Up to **128 MiB**. ASCII and other non-random-access formats remain on this route.                                           |
| Large binary PLY/STL        | Bounded sampled preview above 128 MiB, including files of at least **5 GiB**. No whole-file `ArrayBuffer` is required.       |
| Large preview geometry      | At most **300,000 points / 100,000 triangles** in the shared renderer; preview metadata records what was read and displayed. |
| Large preview reads         | Up to **128 MiB** read per preview by default, using bounded chunks and revision guards.                                     |
| Ordinary geometry           | Up to 10 million vertices / 10 million triangles, subject to decoding and memory limits.                                     |
| Comparison session          | Up to **16 models / 512 MiB of retained geometry**, with an explicit error before exceeding the session guard.               |

Large binary PLY meshes currently omit faces and display sampled vertices; this is labeled as point-only and carried into comparison reports. Large STL retains sampled triangles. The preview may inspect only a subset of records, so it cannot certify the complete file's validity. This pipeline is bounded sampling, without octree LOD or an exhaustive billion-point renderer. A 5 GiB source preview is not a promise to load every point, triangle, material, or CAD entity into GPU/WASM memory. Large STEP/IGES/BREP, GLB/glTF, OBJ and other full-input formats remain limited to the ordinary route.

The 120-second decoder-worker timeout and explicit cancellation apply to ordinary non-glTF decoding. New loads terminate the previous worker. GLB/glTF uses a bounded, validated main-thread loader and may briefly block while parsing; large-file range reads and comparison calculations check cancellation between work batches. CAD tessellation can allocate additional memory before output counts become available. All counts and file limits are guardrails, not frame-rate guarantees.

Source origins are retained in double precision, and the common display anchor keeps the models in one coordinate frame. GPU vertex attributes remain Float32, so extreme coordinates and very small features still require care. The tool never assumes a PLY/STL unit or silently rescales models.

## Build and test

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:openai-stdio
npx playwright install chromium
npm run test:browser
npm run test:openai-browser
npm run test:comparison
npm run test:large
npm run test:openai-range
npm run test:extension
npm run package:vsix
npm run package:release
```

Browser tests use a real WebGL canvas and the bundled WASM. `MODELDOCK_BROWSER=/absolute/path/to/chromium` can select an existing test browser. Native extension tests require a display or Xvfb on Linux and download a pinned VS Code build. See [validation.md](docs/validation.md) for what was actually executed and for the distinction between core tests, protocol/contract checks and native-host tests.

Generated original fixtures are included. `node scripts/generate-demo.mjs` recreates the arch cloud/mesh and textured glTF examples. `fixtures/generate.py` recreates small parser samples; CAD fixture regeneration needs optional CadQuery/OCP, which is not required to build or run ModelDock.

## Publish your fork

For a fork, replace the local VS Code publisher placeholder `modeldock-dev` with your registered publisher before Marketplace publication, add your repository URL/author, choose your public package names, and rerun the release build. Installing the local VSIX does not require Marketplace publication.

GitHub Actions build/typecheck/test/package the project. A release workflow builds artifacts when you publish a release; it does not auto-publish to Marketplace or npm. Keep dependency licenses and corresponding CAD source materials with binary distributions. `node scripts/fetch-cad-source.mjs` downloads the pinned corresponding-source archives and verifies their size and SHA-256; these approximately 52 MB archives are not vendored into Git. `npm run package:release` fetches/verifies them automatically and includes them in the complete release ZIP. Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and [CAD source provenance](docs/cad-source.md).

## License

Original ModelDock code and original fixtures: MIT. The OpenCascade / occt-import-js CAD component retains its LGPL licensing; the WASM is unmodified and its JavaScript glue carries a documented no-eval compatibility patch. Dependencies are not relicensed by the main project. The builds keep the standalone CAD runtime replaceable and include the source/build procedure needed to rebuild embedded adapters.
