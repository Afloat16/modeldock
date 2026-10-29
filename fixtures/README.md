# Original test models

All models in this directory were created specifically for ModelDock and are
covered by the repository's MIT license. No user scans or downloaded CAD parts
are included.

- `colored-points.ply`: a coloured torus sampled as 2,048 points, with **no faces**.
- `colored-mesh.ply`: the same torus as 4,096 triangles.
- `triangle-little.ply` / `triangle-big.ply`: binary PLY endian fixtures.
- `triangle-ascii.stl` / `triangle-binary.stl`: the same triangle; the binary
  header deliberately starts with `solid` to test format detection.
- `pyramid.obj`, `triangle.off`, `points.xyz`, `points.pcd`: compact format checks.
- `cube.step`, `cube.iges`, `cube.brep`: the same 20 × 15 × 10 cube.
- `mounting-bracket.step`: a bored cylindrical boss on a mounting plate with four
  holes, for exercising real CAD tessellation.
- `demo-arch-cloud.ply`: an original architectural arch sampled into 48,000
  coloured points with deterministic, slight synthetic scan noise. Y is up.
- `demo-arch-mesh.ply`: the corresponding 6,594-vertex / 12,156-triangle surface.
- `textured-cube.glb` / `textured-cube.gltf`: a self-contained textured cube with an
  original checkerboard PNG, for testing embedded buffers and images.

`python3 fixtures/generate.py` regenerates the fixtures. CAD regeneration uses
the optional Python `cadquery` package; viewing and testing the checked-in CAD
files requires no Python installation. The checked-in files are intentionally
small; they are not a performance benchmark or a comprehensive CAD corpus.

`node scripts/generate-demo.mjs` regenerates the arch and embedded glTF examples
using the project's pinned JavaScript dependencies, with no network access.
