# OpenAI native file-viewer integration

## Implemented contract

ModelDock supplies a local stdio MCP server and one self-contained MCP App resource. The viewer advertises OpenAI's file entrypoint, allowing a capable Desktop host to open supported model files in an embedded viewer. This is separate from the VS Code custom editor and standalone HTTP viewer.

| Contract                    | ModelDock value                                                                                |
| --------------------------- | ---------------------------------------------------------------------------------------------- |
| MCP server                  | `dist/mcp.cjs`                                                                                 |
| Viewer tool                 | `modeldock_viewer`                                                                             |
| UI resource                 | `ui://modeldock/viewer`                                                                        |
| UI MIME type                | `text/html;profile=mcp-app`                                                                    |
| File entrypoint             | `_meta['openai/ui'].entrypoints = [{type:'file', extensions:['.ply', ...]}]`                   |
| Entrypoint input            | `{file:{name,resourceUri}}`                                                                    |
| App-only metadata tool      | `modeldock_file_info` — selected name, size and revision                                       |
| App-only range tool         | `modeldock_read_range` — offset, length and revision; at most **4 MiB** per call               |
| Selected-file authorization | Host-injected `_meta['openai/resource'].path`, read using the official SDK's `getResourcePath` |
| Legacy resource fallback    | `OpenAIExtensions.resources.read({uri,representation:'blob'})`, bounded to **128 MiB**         |
| Live updates                | Resource subscribe/update/unsubscribe lifecycle                                                |
| Source ceiling              | **8 GiB**; large binary PLY/STL use bounded sampled previews                                   |

All tools are read-only, non-destructive, idempotent and closed-world. The range and metadata tools are visible to the app. Their strict input schemas accept no filesystem path. File suffixes are dot-prefixed as required by the published contract. The resource URI remains an opaque host identifier and is never decoded into a path or fetched as a remote HTTP URL.

The range server accesses only the host-selected local file supplied through official tool-call metadata. It checks supported format, selected-file properties, source size, requested range and revision before reading. Callers cannot request an arbitrary path through tool arguments. A generic MCP client without selected-file metadata cannot use these tools as a filesystem browser. The viewer adds no writes, uploads, enumeration or model-facing filesystem tool.

## File and range lifecycle

The app installs its tool-input handler before connecting, waits for the host capability handshake and subscribes to the selected opaque resource. It first attempts the app-only metadata/range route. A capable host supplies the selected path on the app's tool calls through `_meta['openai/resource'].path`. The server returns selected-file metadata, and subsequent bounded reads include the expected revision. A changed file is rejected rather than mixed into one preview.

Files up to 128 MiB use the ordinary parsing route, assembled from bounded reads when necessary. Larger binary PLY/STL use the shared random-access preview loader. The renderer caps the loaded representation at 300,000 points / 100,000 triangles and 128 MiB of sampled reads. Large PLY meshes currently show sampled vertices with surface topology explicitly omitted; binary STL can show sampled surface triangles. The UI and exported comparisons retain original/displayed counts, representation and sampling provenance. This supports source files of at least 5 GiB without allocating or transferring the whole source, and does not promise full-file rendering or 5 GiB CAD tessellation. Other formats remain on the 128 MiB full-input path.

If the host does not inject selected-file context, the app can use its legacy authorized-resource interface for files up to 128 MiB. Base64 size is checked before output allocation, decoded in bounded chunks, and matched to the exact selected URI. UTF-8 fallback checks encoded byte size. A host that provides neither a suitable range route nor sufficient legacy transfer can still use the viewer's **Add models** local picker; the selected `File` stays a range-readable browser Blob for large previews.

Updates trigger a new selected-file revision/read and preserve camera and comparison state for that source. Switching resources cancels or discards stale work. Serialized subscription operations prevent an old unsubscribe from cancelling a newer A → B → A subscription. If subscription setup fails, initial viewing can still succeed and **Reload file** remains available. Teardown releases subscriptions, handlers, workers, geometry, textures, temporary Blob URLs and active range work. Controller `ready` means the source was delivered to the viewer; it is not an independent certification of malformed geometry.

## Comparison workflow

Every host uses the same **Add models → Reference / ground truth → Align → Compare** controls. A user can choose an STL surface as reference, overlay multiple reconstructions or inspect a synchronized side-by-side pair, and adjust visibility/opacity. Source coordinates are preserved and no alignment runs automatically.

Unknown PLY/STL coordinate units require explicit confirmation. A unit label does not rescale numbers. Rigid ICP is explicit and local; manual translation/rotation can supply an initial pose, and optional scale is separately recorded. Pair and each-to-reference reports include approximate directional metrics, tolerance precision/recall/F-score, non-squared Chamfer distance, transforms, seed and sampling metadata. Heatmaps and maxima describe evaluated samples, not exact Hausdorff or CAD metrology. A point-only preview cannot be exact surface ground truth. Comparison sessions are limited to 16 models / 512 MiB retained geometry.

## Packaging and installation

The root build creates `dist/openai/viewer.html` and `dist/mcp.cjs`, then copies them into `adapters/openai/dist/`. The adapter includes portable `plugin.json` / `mcp.json` and compatibility `.codex-plugin/plugin.json` / `.mcp.json` files. `${PLUGIN_ROOT}` follows the official local stdio packaging contract.

The self-contained HTML stores a gzip-compressed IIFE payload. Its bootstrap uses `DecompressionStream`, preserves an injected nonce, loads JavaScript through a local Blob URL and never uses `eval` or `new Function`. Compression keeps the UI resource response within the MCP SDK's default 10 MiB stdio read buffer; the build enforces a 9 MiB HTML budget and the stdio test checks the complete JSON-RPC response. Exact release byte counts belong in [validation.md](validation.md). A webview without decompression support receives an actionable update/alternate-viewer message.

For the complete source checkout, the local marketplace catalog points to `./adapters/openai` relative to the repository root:

```sh
codex plugin marketplace add /absolute/path/to/modeldock
```

For the standalone `modeldock-openai-0.2.0.zip`, extract it and register the contained `modeldock-openai` directory. Its own catalog points to `./`:

```sh
codex plugin marketplace add /absolute/path/to/modeldock-openai
```

Restart the supported Desktop app and install ModelDock from the local plugin source. Keep the folder in place and refresh/reinstall after rebuilding if the host caches packages. The two catalog layouts are not interchangeable. See [the adapter README](../adapters/openai/README.md) for the full installation sequence.

Direct `codex mcp add` is an alternative only for Desktop versions that discover file entrypoints from configured MCP servers. Registration alone does not prove native graphical viewing. A terminal has no 3D canvas; use the CLI local viewer or VS Code extension. Real OpenAI Desktop installation remains an unexecuted acceptance step unless the validation record explicitly states otherwise.

## Host compatibility and sandbox boundary

The inspected specification lists file entrypoints and managed resources as Desktop features. Ordinary MCP tool support does not imply those capabilities. The app checks host resource capabilities and reports unsupported delivery, while keeping explicit local-file selection available. Codex in VS Code uses the VS Code extension. Work Web/mobile are not declared native-file-entrypoint targets for this contract.

The MCP App requests local `blob:` resources/connections and includes no external asset domains. Startup requires local Blob scripts, workers and fetches; CAD also requires WebAssembly compilation. Resource-CSP domain lists are not a place for JavaScript policy keywords. A target Desktop sandbox may disallow required features, and the adapter does not override managed host policy. Native host limits apply first; the range route avoids the complete-file transport when available, while the legacy route remains in-memory and capped at 128 MiB.

## Validation and its limits

Unit/controller tests cover base64/UTF-8 boundaries, exact selected-resource matching, metadata and range validation, revisions, updates, cleanup, stale reads, rapid switching, and unsupported/subscription behavior. Host file tests cover offset/size/revision boundaries and selected-file access. Core comparison and large-loader tests validate geometry independently of the OpenAI carrier.

`npm run test:openai-stdio` starts the actual built server with real MCP SDK transports and the unchanged stdio buffer. The executed six-check suite covers initialization, app-only tool discovery and file-entrypoint metadata, resource discovery, the complete bundled HTML response, viewer invocation without arbitrary model-file access, and rejection of an unknown resource URI. Use [validation.md](validation.md) for exact grouped names and release results.

`MODELDOCK_BROWSER=/absolute/path/to/chromium node tests/openai-browser.mjs` runs a simulated MCP App host with real Chromium, the SDK bridge, bundled worker, and a strict sandbox allowing WebAssembly without JavaScript `unsafe-eval`. This legacy-resource suite covers ordinary PLY/STEP rendering, resource updates/camera preservation, bootstrap/nonce behavior, cleanup and unsupported-host handling.

`npm run test:openai-range` runs `tests/openai-range-browser.mjs` with the actual native app bundle and real MCP SDK client/server, inside a simulated Desktop carrier. Its six executed groups cover actual sparse PLY and STL sources over 5 GiB, 300,000-point / 100,000-triangle preview limits, fresh revisions and camera preservation, stale-revision rejection and recovery, and read authorization/bounds. It verifies offsets beyond 4 GiB, requests no larger than 4 MiB, no whole-file `resources.read`, no app-supplied filesystem paths, and no uncaught errors or external requests. Sparse files establish logical file-size/range behavior without requiring 5 GiB of disk allocation. The range route and legacy resource fallback are distinct tests.

The shared browser suite has 15 checks and the focused comparison browser suite has 9. These are real renderer tests. A simulated host validates protocol delivery and rendering but cannot certify installation, file-entrypoint discovery or CSP behavior in a proprietary Desktop release. No real OpenAI Desktop installation is claimed here. VS Code native acceptance and Harness native acceptance are separate host checks documented in the validation record.

## Authoritative references

The integration targets the official contracts inspected on 2026-10-29; these APIs can evolve.

- [Plugin Extensions](https://developers.openai.com/plugins/build/extensions)
- [OpenAI MCP Extensions specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)
- [OpenAI MCP Extensions TypeScript SDK](https://github.com/openai/mcp-extensions/blob/main/typescript/README.md)
- [Package plugins and local marketplaces](https://developers.openai.com/plugins/build/plugins)
- [Desktop-only stdio configuration](https://developers.openai.com/plugins/deploy/desktop-only)
- [MCP App resource CSP reference](https://developers.openai.com/plugins/reference)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)

Implementation versions are pinned by the lockfile. CAD dependency licensing, corresponding source and the generated no-eval compatibility patch are documented in [CAD source provenance](cad-source.md). This adapter creates no agent skill and makes no LLM request.
