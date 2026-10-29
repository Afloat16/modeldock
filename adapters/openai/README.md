# ModelDock for OpenAI Desktop file viewers

This package registers a **native file entrypoint** for supported 3D formats. A compatible Desktop host opens the MCP App when the user opens a matching file. The viewer subscribes to the opaque resource URI supplied by that host. App-only metadata/range tools read only the selected file authorized through host-injected `_meta['openai/resource'].path`; tool arguments never accept a local model path.

原生桌面文件预览适配器：点击 PLY / 网格 / CAD 文件后，宿主通过文件资源接口提供数据，ModelDock 在内嵌界面中渲染。是否能直接打开，取决于该桌面版本是否实现官方的 file entrypoint 和 `openai/resource` 能力；终端 CLI 本身没有三维画布。

## Build and run

Build from the repository root:

```sh
npm ci
npm run build
node dist/mcp.cjs --help
```

The build copies `dist/mcp.cjs` and `dist/openai/viewer.html` into this plugin's `dist/` directory. The resulting package includes the viewer, decoder worker, OpenCascade JavaScript/WASM, and required license notices. The runtime needs Node.js 22 or newer, available as `node` on the Desktop host's PATH. No API key is needed by ModelDock.

## Install through a local plugin marketplace

For the **complete source release**, use the repository root as the marketplace root. It includes `.agents/plugins/marketplace.json`. For another checkout, merge `marketplace.example.json` into that file. Its `source.path` is relative to the repository root, so keep `./adapters/openai` while using this checkout layout.

Then register the repository with the current Codex CLI:

```sh
codex plugin marketplace add /absolute/path/to/modeldock
```

For the **standalone `modeldock-openai-0.2.0.zip`**, extract it and register the extracted `modeldock-openai` directory instead. That directory includes its own `.agents/plugins/marketplace.json` pointing to `./`, and already contains the built server and HTML:

```sh
codex plugin marketplace add /absolute/path/to/modeldock-openai
```

Use one of these local marketplace layouts. Do not replace the standalone catalog with the full-repository example, because their relative paths differ.

Restart the supported Desktop application, open the Plugins Directory, select **ModelDock Local**, and install **ModelDock · 3D & CAD**. Open a `.ply`, `.stl`, `.obj`, `.off`, `.xyz`, `.pcd`, `.glb`, `.gltf`, `.step`, `.stp`, `.iges`, `.igs`, `.brep`, or `.brp` file in its file viewer. If the host offers multiple viewers, choose ModelDock.

Keep the plugin folder in place. Some Desktop versions copy local plugins to a cache on install: after rebuilding, refresh/reinstall the local plugin and restart the host so it uses the new build. This package includes portable `plugin.json` / `mcp.json` and compatibility manifests for hosts that still use the older layout.

## Alternative: direct local MCP registration

For a host whose native file-viewer integration discovers entrypoints from configured MCP servers:

```sh
codex mcp add modeldock -- node /absolute/path/to/modeldock/dist/mcp.cjs
codex mcp list
```

Restart that Desktop host after registration. This command registers the server; it cannot add a graphical preview or file-entrypoint capability to an unsupported CLI, web client, or older Desktop version. Use one installation route to avoid duplicate registrations. Remove a directly registered server with `codex mcp remove modeldock`.

## Runtime requirements and limits

- Requires OpenAI's file entrypoint extension and host-managed `openai/resource` capability. Ordinary MCP tool support alone is insufficient. The app explicitly reports a missing capability.
- Codex inside VS Code should use ModelDock's VS Code extension. Codex CLI can launch the local browser viewer with `node dist/cli.cjs model.ply`; it has no native 3D canvas.
- The default source ceiling is **8 GiB**. `modeldock_file_info` obtains selected-file size/revision and `modeldock_read_range` reads at most **4 MiB** per call. These app-only tools require official selected-file metadata from the host and reject arbitrary path arguments. Binary PLY/STL above 128 MiB use bounded sampled previews, including sources of at least **5 GiB**, without whole-file allocation.
- Large previews are capped at 300,000 points / 100,000 triangles. Large PLY mesh faces are omitted and explicitly labeled point-only; STL retains sampled surfaces. Other formats, including CAD, remain on the **128 MiB** full-input route. No full 5 GiB CAD conversion is promised.
- Hosts without selected-file metadata can use the legacy authorized-resource fallback up to **128 MiB**, checked before decoding. If a host cannot transport a large file, **Add models** can select it directly as a local File/Blob. Host permissions and transport limits still apply.
- File update notifications preserve the camera, added models, reference and transforms for the same resource. If the host rejects subscriptions, the app offers **Reload file**.
- The HTML is self-contained and includes a gzip-compressed application so its MCP resource response fits the standard stdio buffer. Startup requires `DecompressionStream`, local Blob scripts, workers and fetches. Blob resources are declared in its resource CSP; CAD decoding additionally requires WebAssembly. The bootstrap preserves an injected script nonce and reports missing decompression support. A host's sandbox can disallow these capabilities; the package does not override host policy. Test the intended Desktop version before claiming native-host CAD compatibility.
- No write tools, workspace enumeration, model uploads, telemetry, CDN downloads, LLM requests, or automatic provider configuration are implemented.
- The server is a local stdio MCP server. Open-source distribution on GitHub is separate from approval for the public OpenAI Plugin Directory. As of the inspected official guide, public local-MCP submissions require approved-partner access.

## Compare reconstructions

Use **Add models → Reference / ground truth → Align → Compare**. Add PLY reconstructions and an STL or other reference; inspect colored overlays or synchronized side-by-side views, with per-model visibility and opacity. Source coordinates are preserved and no alignment runs automatically. Confirm actual coordinate units, then explicitly choose rigid ICP or manual translation/rotation/scale when needed. Unit labels do not convert coordinate values.

Pair and each-to-reference evaluation show sampled heatmaps, approximate RMSE/P95/maximum, Chamfer and tolerance precision/recall/F-score. JSON/CSV record transforms, explicit scale and sampling provenance. Sessions are limited to 16 models / 512 MiB geometry. Sample maxima are not exact Hausdorff distances; point-only previews are not exact surface ground truth.

Protocol and controller tests live in `tests/openai.test.ts`. See `docs/openai-integration.md` in the source repository for the contract and the exact validation boundary. The built stdio test verifies the real protocol transport. The separate range browser test runs the actual app and MCP SDK with selected sparse PLY and STL sources over 5 GiB inside a simulated Desktop carrier. A successful protocol/browser test does not prove installation in a particular Desktop build; real OpenAI Desktop installation remains an unexecuted acceptance step unless the validation record states otherwise.

## Official references

- [Plugin file entrypoints](https://developers.openai.com/plugins/build/extensions)
- [OpenAI MCP extensions specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)
- [Package a plugin and install a local marketplace](https://developers.openai.com/plugins/build/plugins)
- [Local stdio packaging and Desktop-only directory submission](https://developers.openai.com/plugins/deploy/desktop-only)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp)

MIT applies to original ModelDock code. Bundled dependencies retain their licenses; see `THIRD_PARTY_NOTICES.md` and `licenses/`.
