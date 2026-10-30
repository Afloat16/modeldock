# ModelDock — local 3D previews and reconstruction comparison with Three.js

Submitted to the [three.js Showcase category](https://discourse.threejs.org/c/showcase/7) on **2026-10-30**. **Status: awaiting moderator approval; no public post URL yet.** The forum confirmed “Post Needs Approval” and one pending post.

---

We built **ModelDock**, an open-source viewer for inspecting reconstruction results and CAD output inside the coding workflow. The idea came from a recurring task: an agent generates a model, and checking every revision means opening it in another application again.

ModelDock uses a shared Three.js viewer across a VS Code custom editor, a native DeepSeek Harness Web document-preview plugin, an adapter for compatible OpenAI file-entrypoint hosts, and a local CLI viewer.

Some features we would love people to try:

- Orbit, pan, cursor zoom, standard views, section planes and approximate measurements.
- PLY/STL, point-cloud and mesh previews, plus local STEP/IGES/BREP tessellation.
- **Bounded, sampled previews of binary PLY/STL sources above 5 GiB**, with an 8 GiB default source ceiling.
- Colored multi-model overlays and synchronized side-by-side views.
- Explicit local rigid ICP or manual transforms, STL references, sampled deviation heatmaps, RMSE, P95, Chamfer distance and tolerance-based F-score.
- JSON/CSV reports that retain transforms and sampling provenance.

Model parsing, rendering and comparisons stay local. The controls are available in English and Chinese.

These are real screenshots of the shared viewer through the local CLI, using the repository's original arch fixtures:

![ModelDock point-cloud preview](https://raw.githubusercontent.com/Afloat16/modeldock/main/docs/images/preview.jpg)

![ModelDock synchronized comparison of a point cloud and mesh](https://raw.githubusercontent.com/Afloat16/modeldock/main/docs/images/comparison.jpg)

**[Source and installation](https://github.com/Afloat16/modeldock)** · **[Download v0.2.0](https://github.com/Afloat16/modeldock/releases/tag/v0.2.0)**

If you work with reconstruction outputs, please try your own PLY/STL files. We would especially appreciate feedback on file compatibility, navigation, aligning a reconstruction to a reference, and the comparison workflow. Share your experience here or in our [testing and feedback thread](https://github.com/Afloat16/modeldock/issues/1). For a reproducible issue, include the host, OS, format, file size and steps; a minimal non-private sample helps.

Original ModelDock code and fixtures are MIT licensed; dependencies retain their respective licenses.
