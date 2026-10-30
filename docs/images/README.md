# Screenshot provenance

These screenshots were captured on **2026-10-30** from the actual **ModelDock v0.2.0 shared viewer**, launched with the local CLI and rendered by Three.js/WebGL in Chromium through Playwright. They show the shared viewer interface, **not the DeepSeek Harness host interface**. The images are direct browser screenshots without compositing or UI changes.

| Image            | Running state                                                                                                                                                                                            |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preview.jpg`    | The original `fixtures/demo-arch-cloud.ply`: 48,000 colored points, isometric view, 2 px point size, geometry/display inspector visible.                                                                 |
| `comparison.jpg` | The same cloud as target and original `fixtures/demo-arch-mesh.ply` as reference: synchronized side-by-side views, evaluated sample-deviation heatmap, approximate metrics and JSON/CSV export controls. |

The comparison keeps the fixtures' source coordinates and applies no ICP or manual alignment. Both demo coordinate-unit labels were explicitly set to `m`, with tolerance `0.025` and 10,000 evaluation samples per direction. These synthetic fixtures demonstrate the workflow; the unit selection does not establish physical calibration or a performance benchmark. The fixture geometry and colors are the repository's original MIT-licensed demo assets.

Both JPEGs were captured at **1360 × 960**, JPEG quality **80**. Browser errors were checked during capture. Build preparation used the repository lockfile (`npm ci`) and `npm run build`; The capture browser was Chromium Headless Shell 134, with Noto Sans CJK SC available for the viewer's bilingual labels. No product source code was changed to make the screenshots.

Suggested caption: **ModelDock shared viewer running locally: colored point-cloud preview and synchronized point-cloud/mesh comparison.**

中文说明：截图来自本地 CLI 启动的 ModelDock 共享查看器，展示真实点云预览与同步并排比较；不是 DeepSeek Harness 宿主界面截图。
