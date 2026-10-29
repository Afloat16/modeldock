# ModelDock for DeepSeek Harness

在 DeepSeek Harness 的文件树或对话文件链接中打开模型，直接在右侧 Document Preview 中查看。它复用 ModelDock 的三维查看器，支持鼠标旋转、平移、缩放，并跟随宿主的文件更新自动重载。

This is a **native Document Preview renderer**, using Harness's public `documentPreviews` and `sidebar.right.tab.document` extension points. It does not launch a separate viewer program.

## Install a release

Use Node.js **24.9.0 or newer**, as required by the inspected Harness CLI release. Install the built `.tgz` release into the profile you actually use:

```sh
npx @deepseek-ai/dsh@0.2.2-alpha.2 plugin --profile web add ./dsh-plugin-modeldock-0.2.0.tgz
npx @deepseek-ai/dsh@0.2.2-alpha.2 --profile web
```

Restart an already running Harness instance, choose your workspace, and open a `.ply`, `.stl`, `.obj`, `.off`, `.xyz`, `.pcd`, `.glb`, `.gltf`, `.step`, `.stp`, `.iges`, `.igs`, `.brep`, or `.brp` file. When multiple renderers match, choose **ModelDock · 3D** in the file preview's renderer selector. The host owns the current workspace, file-read permissions, reload control, and file subscription.

For a Desktop profile, replace `web` with that profile's actual name. The renderer uses the shared Web client contracts; Desktop installation and CSP behavior must be checked on the target Desktop build. This package does not silently alter another profile or loosen host permissions.

## Build from the ModelDock repository

Build from the repository root first. The adapter is not a separate source-only npm project: the root build embeds the shared viewer and parser assets in its publishable payload.

```sh
npm ci
npm run build
cd adapters/deepseek-harness
npm pack
```

The root build must produce `lib/index.js` and `lib/client.js`, and copy the applicable license/notice files into this package. The client bundle contains the worker, OpenCascade JavaScript, and WebAssembly bytes. It needs no model upload and no runtime CDN download. Install the resulting tarball with the release command above.

## Implementation boundary

- Inspected source contract: DeepSeek Harness **0.2.2-alpha.2**, commit `f3803c96974ad4a94195fb97e5c637e9c2a3afe3` (2026-10-27).
- DSH is a developer preview. The declared `engines.dsh` range is an API compatibility boundary, not a claim that every later release has been tested. Keep the pinned install command for reproducible testing.
- `loading: 'renderer'` receives the selected resource identity and content revision. `remote.workspaceFiles.stat/readBytes` supplies authorized metadata and byte ranges, at most 512 KiB per host read, with revision checks. The large preview does not require Harness to transfer the complete file first.
- Preview assets are generated as local Blob URLs, shared between open tabs, and revoked when no longer used. A host that blocks Blob workers or WebAssembly can prevent rendering; the viewer reports initialization errors. Do not weaken a managed host's policy to work around this.
- The default source ceiling is **8 GiB**. Binary PLY/STL sources above 128 MiB use bounded sampled previews, including files of at least **5 GiB**. Large previews show at most 300,000 points / 100,000 triangles. Large PLY meshes omit surface topology and are explicitly point-only; sampled STL retains surfaces. Other formats remain limited to **128 MiB** ordinary parsing; no full 5 GiB CAD conversion is claimed. Host workspace permissions still apply.
- CAD data is tessellated for display. Native CAD editing, parametric history, DWG, and proprietary application project files are outside this package's scope.
- A shadow root isolates viewer styles from the conversation and from other file previews.
- Same-resource revisions preserve the camera, secondary models, chosen reference and transforms while the viewer remains mounted. A 32-file camera cache covers host remounts, retaining no model bytes or GPU objects; a full remount cannot restore the complete comparison scene or keep discarded geometry visible.

## Compare models

Use **Add models → Reference / ground truth → Align → Compare**. Local multi-select and additive drops load additional reconstructions or an STL reference into the same scene. Source coordinates are preserved; registration is explicit. Choose actual units before comparison, use local rigid ICP or manual translation/rotation/scale when intended, then evaluate a pair or every model against the reference. A unit label does not convert coordinates.

The shared viewer provides colored overlays, synchronized side-by-side views, visibility/opacity, sampled deviation heatmaps and approximate metrics, with JSON/CSV transforms and sampling provenance. Comparison sessions stop at 16 models / 512 MiB geometry. Sampled maxima are not exact Hausdorff distances, and point-only previews cannot supply exact surface ground truth.

See `docs/harness-integration.md` in the repository for the native Web smoke procedure and the release test report for executed results. Desktop has a separate carrier and still requires validation on the intended build. When replacing a local development tarball, use a new version or distinct tarball filename: the host's package manager can cache an older package by its version/path even when that file is overwritten.

## Remove

```sh
npx @deepseek-ai/dsh@0.2.2-alpha.2 plugin --profile web remove dsh-plugin-modeldock
```

## Authoritative integration references

- [Right Sidebar and Document renderers](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/sidebar-right)
- [Document Preview package](https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/client/ui-sidebar-documentpreview/README.md)
- [Client module protocol](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/client-modules)
- [Package and install a plugin](https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish)

MIT applies to the original ModelDock code. Bundled dependencies retain their own licenses; see `THIRD_PARTY_NOTICES.md`.
