# DeepSeek Harness integration

ModelDock's DeepSeek Harness package is an installed native file preview renderer. The host continues to own file selection and authorization; the plugin receives the selected resource address and content revision, then requests authorized metadata and byte ranges through the host remote API.

## Contract pinned for this implementation

The adapter was written against official `deepseek-ai/deepseek-harness` source at commit `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`, package version `0.2.2-alpha.2`. The project declares that developer-preview releases can contain breaking changes. Exact source references:

- [Document content and renderer props](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/client/ui-sidebar-documentpreview/src/client/document/contract.ts)
- [Renderer registry](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/client/ui-sidebar-documentpreview/src/client/document/registry.ts)
- [Built-in image renderer registration](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/client/ui-sidebar-documentpreview/src/client/image/index.ts)
- [Browser bundle wrapper](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/client/tsdown.client.ts)
- [Client module routing and assets](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/client/modules/README.md)

`src/contract.ts` intentionally exposes a small structural subset of these contracts. It avoids installing the entire Harness workspace just to build a prebundled renderer; it is not a generated copy of the full Harness SDK.

## Native file-opening path

1. The package's `dsh.bundle` patch activates its empty Host entry.
2. Client Modules discovers `dsh.client` and its `./client` export.
3. The browser bundle registers `apply`/`inject` through `window.__ModuleLoader__.load`.
4. `inject = ['documentPreviews', 'slots', 'remote']` waits for the needed runtime services.
5. `documentPreviews.register` matches supported suffixes and selects `loading: 'renderer'`.
6. The keyed `sidebar.right.tab.document` body receives the resource address and renderer content revision.
7. `remote.workspaceFiles.stat` obtains the selected file size/revision. `readBytes` reads at most 512 KiB per host request, with revision checks and cancellation, under Harness workspace permissions.
8. The shared viewer uses ordinary parsing up to 128 MiB and bounded binary PLY/STL sampling for larger sources. The source ceiling is 8 GiB; no full-file host transfer is requested for a large preview.
9. Same-resource content revisions invoke `viewer.load` with `preserveView`, preserving the comparison session while mounted. The adapter calls the renderer lifecycle's loaded/failed callbacks. A 32-entry camera cache covers host disposal/remounts without retaining geometry or WebGL contexts.

All metadata and slot registrations are owned by `ctx.effect`. All preview resources, worker lifetime, and GPU objects belong to the viewer mount and are released when its React body unmounts. A shared per-plugin pool avoids duplicating the CAD runtime's Blob URLs for multiple tabs.

The camera cache contains only projection, position, target, up axis, zoom, and orthographic view height. It is keyed by the unchanged host resource address and cleared when the plugin unloads. It does not keep detached renderers, model arrays, or GPU memory alive. A mounted renderer can retain its previous valid geometry during an invalid update. If the host disposes the entire body, the camera cache can restore only the view once a valid replacement loads; it does not restore an entire comparison session. The v0.2 renderer loading strategy avoids requiring the host complete-byte pipeline and its full-file read cap.

## Root build contract

The root build bundles `adapters/deepseek-harness/src/client.tsx` as browser CommonJS with `react` and `react/jsx-runtime` external. Those are supplied by Harness's platform module table. Wrap the output using the documented lazy factory protocol:

```js
window.__ModuleLoader__.load({
  id: 'dsh-plugin-modeldock',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    // bundled CommonJS output
    return module.exports;
  },
});
```

Resolve `modeldock:embedded-assets` as a virtual module exporting `workerSource`, `occtSource`, and `occtWasmBase64`. Resolve `styles.css?inline` as text. Emit the empty Host entry as ESM at `lib/index.js`. Copy original-code license and all bundled dependency notices into the adapter before `npm pack`.

The upstream `/plugins/.../assets/` handler only accepts image suffixes. Therefore it cannot be used to serve the parser's `.wasm` or worker `.js` as generic package assets; the adapter embeds these as upstream's own PDF/Excel preview pipelines do. No unrelated file-serving route is added.

## Reproduce native Web validation

Use Node.js 24.9.0 or newer. Build and pack the adapter, then use a disposable host profile so the smoke test does not change your usual configuration:

```sh
npm ci
npm run build
npm pack ./adapters/deepseek-harness --pack-destination ./releases

export DSH_HOME="/absolute/path/to/isolated-harness-test-profile"
export DSH_AGENTS_HOME="/absolute/path/to/isolated-harness-test-agents"
export DSH_TELEMETRY_DISABLED=1
npx @deepseek-ai/dsh@0.2.2-alpha.2 plugin --profile web add ./releases/dsh-plugin-modeldock-0.2.0.tgz
npx @deepseek-ai/dsh@0.2.2-alpha.2 --profile web --host 127.0.0.1 --port 0 --no-open
```

The host prints a temporary local URL. In a second terminal, run:

```sh
MODELDOCK_HARNESS_URL='http://127.0.0.1:PORT/?token=TOKEN_PRINTED_BY_DSH' \
MODELDOCK_BROWSER='/absolute/path/to/chromium' \
node tests/harness-browser.mjs
```

`MODELDOCK_BROWSER` can be omitted when Playwright's managed Chromium is installed. The test uses the actual host UI: dismiss the optional sign-in prompt, select the ModelDock repository through the workspace chooser, open **Workspace files**, and click model files. No API key is entered and no chat message is sent. It creates its own temporary model under `test-results/`, replaces that model atomically, and removes the temporary file when done.

Use a fresh profile or one already selecting the ModelDock repository. Do not point this script at a normal working profile. The browser test expects the inspected host's English UI. Local development tarballs should use a new version or distinct filename after a rebuild: in the executed test, overwriting a same-name, same-version `.tgz` could leave the previous package in the package manager's cache. Comparing the installed `lib/client.js` SHA-256 with the build confirmed which bytes were running.

The test writes internal screenshots and a result JSON under `test-results/`. The v0.2 run passed eight grouped checks in the actual installed Web host: file-click routing, navigation, exact camera preservation on update, STEP, binary PLY/STL sources above 5 GiB, observed bounded native byte reads and absence of browser errors. The largest observed offset exceeded 5.36 billion bytes; no unbounded `readBytes` invocation occurred. See [validation.md](validation.md) for exact counts and the selected host build. Shared comparison and browser tests validate the common viewer separately from native-host transport.

The same viewer offers Add models, STL/reference selection, explicit units and alignment, synchronized comparison views, sampled metrics, and JSON/CSV export. Large previews show original/displayed counts and omitted topology; binary PLY mesh previews are point-only, while binary STL uses sampled surfaces. The renderer caps previews at 300,000 points / 100,000 triangles and comparison sessions at 16 models / 512 MiB geometry. Other formats remain on the 128 MiB full-input route; no 5 GiB CAD conversion is claimed.

Desktop and Web share renderer code but use different carriers and can have different CSP behavior. A successful Web test is not a claim that a Desktop installation has been executed. The release test report records the exact target and checks that passed.
