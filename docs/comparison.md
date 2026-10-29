# Scientific comparison and rigid alignment

ModelDock evaluates a reconstruction (the **source**) against a **reference**. The same APIs work with PLY point clouds, triangle meshes decoded from STL and other supported formats, and the loaded representations of large files. Evaluation never aligns or rescales geometry implicitly. Keep a report before alignment whenever global pose, calibration or reconstruction scale is part of the question being tested.

## Coordinates and units

`CompareModel` accepts decoder primitives directly, plus an `id`. Declare `unit` or `units`. Both models must declare the same known unit, or the caller must explicitly supply `options.unit` after confirming that the numeric coordinates share that unit. Choosing a label does **not** convert meters to millimeters. Convert coordinates deliberately before calling the API if the files use different numeric scales.

Positions retain their source coordinate system. A model's optional double precision `origin` is added to its position arrays; this allows large-file previews to keep small local offsets in `Float32Array` without discarding their common global location. Comparison does not center or independently normalize the two models. A rigid transform uses a row-major 3×3 rotation and a three-component translation:

```text
absolute point = model.origin + primitive position
aligned point = rotation * absolute point + translation
```

Only proper rotations and translations are accepted. Scale, shear, reflection and nonfinite matrices are rejected. `composeTransforms(a, b)` applies `b` first, then `a`. `inverseTransform` reverses a rigid transform. The viewer can display a local frame, but it must preserve this mathematical relationship when passing geometry to comparison.

## Sampling and nearest distances

Triangle meshes are sampled over their **surface area**, rather than over their vertices. The sampler measures each triangle in local coordinates, draws stratified samples from the cumulative area distribution, and samples uniform barycentric positions using the square-root construction. A triangle with four times the area receives four times the expected query samples. Zero-area triangles receive no surface query samples. The cumulative distribution is traversed in two passes with memory proportional to the query budget; it does not allocate one object per input triangle.

Point clouds use deterministic uniform sampling without replacement (Floyd's sampling algorithm). If the budget covers the cloud, every point is queried. The default query budget is 10,000 samples per model, with an explicit maximum of 200,000. A seeded generator makes the sample set repeatable for unchanged inputs and options. Default seed: `1729`.

The query-sampling approximation is distinct from the target-distance approximation:

| Target representation | Distance searched | Default bound |
| --- | --- | --- |
| Triangle mesh within the triangle bound | Closest point on any loaded triangle, accelerated by a BVH | 200,000 triangles |
| Larger triangle mesh | Nearest area-weighted surface target sample, using a KD tree | 100,000 samples |
| Point cloud within its target budget | Nearest loaded point, using a KD tree | 100,000 points |
| Larger point cloud | Nearest deterministic target subset point, using a KD tree | 100,000 samples |

`maxSurfaceTriangles` and `targetPointBudget` can be raised to 500,000. These are memory/CPU bounds, not file-size promises. The exact triangle path includes triangle interiors and edges; it does not confuse a point in the middle of an STL facet with a point far from all facet vertices. Degenerate individual target triangles are treated as segments or points. A wholly degenerate surface is rejected.

For larger targets, distance to a subset can overestimate distance to the complete loaded surface or cloud. The report records the actual method, target size, query count, available point/triangle counts and query coverage for **each** model. Mesh query statistics remain sampled even when each query's target distance searches all triangles.

Large-file preview metadata is retained verbatim as `source.sampling.sourcePreview` and `reference.sampling.sourcePreview`. A bounded preview is a representation of its source file. Metrics on it are not a certification of the unobserved file contents. In particular, a PLY preview that omits faces and shows vertex points cannot be treated as a complete STL-style surface reference; its nearest distances use the cloud method, and the report warns about omitted topology or partial validation.

Line primitives are excluded and disclosed. A model mixing point and surface primitives is rejected: their relative scientific weighting requires a deliberate choice of separate models rather than an accidental weighting by primitive count.

## Report definitions

Let the sampled source queries be `S`, sampled reference queries be `R`, and `d(p,T)` be the nearest distance to the target representation `T` selected above.

| Quantity | Definition |
| --- | --- |
| Accuracy | Distribution of `d(s, reference)` over `s` in `S` |
| Completeness | Distribution of `d(r, source)` over `r` in `R` |
| Mean | Arithmetic mean of the directional distances |
| RMSE | Square root of the arithmetic mean of squared directional distances |
| Median / p95 | Linearly interpolated empirical 50th / 95th percentiles |
| Approximate maximum | Largest directional query distance; **not exact Hausdorff distance** |
| Symmetric Chamfer | `0.5 * (mean accuracy distance + mean completeness distance)`; unsquared, in the chosen unit |
| Precision at threshold `τ` | Fraction of source queries with distance **≤** `τ` to the reference |
| Recall at threshold `τ` | Fraction of reference queries with distance **≤** `τ` to the source |
| F-score | `2 * precision * recall / (precision + recall)`; zero if both are zero |

Thresholds are nonnegative finite distances in the selected coordinate unit. Fractions lie in `[0,1]`. Changing the threshold changes precision, recall and F-score; it does not change the underlying distance distributions. Distances use ordinary floating point arithmetic; exact-zero thresholds may expose numerical roundoff on triangle interiors or transformed coordinates. No tolerance is silently added to the selected threshold.

Reports include the seed, requested query budget, actual sampling methods, preview provenance, coordinate origins, timestamp and the applied transform. `alignment.method`, `alignment.applied` and fixed `alignment.scale: 1` distinguish raw comparisons from fitted comparisons. The optional `distances` field contains flattened absolute source sample coordinates **after** alignment, source-to-reference distances, absolute reference sample coordinates, and reverse distances for heatmaps. These are sample heatmaps; they do not imply a deviation measurement at every original vertex.

`reportToJson` preserves the typed report. `reportToCsv` exports directional statistics, thresholds, units, transforms and sampling metadata; user-provided names are quoted and formula-leading text is escaped for spreadsheet use.

Unsigned closest distances do not measure watertightness, normal consistency, self-intersections, volume agreement or whether a reconstruction is inside or outside its reference. Occlusion, intended partial coverage, sampling density and reference quality affect the interpretation of the scores. There is no single universal pass threshold.

## Alignment

`alignLandmarks(sourcePoints, referencePoints)` fits the proper least-squares rotation and translation to at least three paired non-collinear landmarks. It uses Horn's symmetric quaternion eigenproblem, with scale fixed at one. Coincident, collinear and nearly collinear configurations are rejected. Pair order is meaningful. Landmark placement noise and incorrect pairs remain the caller's responsibility.

`alignModels(source, reference, options)` performs local trimmed point-to-point rigid ICP on deterministic bounded samples. Each iteration finds nearest sampled target points, gates correspondences by distance, retains the closest requested fraction, and fits a proper rigid update. The default correspondence cutoff is 15% of the reference bounding-box diagonal. The default retained fraction is 90%. The default minimum overlap is 30% **in each direction**; insufficient overlap rejects the alignment rather than introducing a hidden centroid translation. No global search, automatic scale fit or centroid teleport is performed. Landmarks or an explicit `initialTransform` are appropriate for large initial pose differences.

ICP returns the cumulative transform, convergence flag, iteration count, initial/final trimmed inlier RMSE, minimum directional inlier fraction, seed, budget and diagnostic messages. The initial/final ICP RMSE is an optimization diagnostic; it is not the all-query accuracy RMSE in an evaluation report. Convergence means the local optimization stopped changing at the configured relative tolerance. It does not prove that a symmetric object, partial view, repeated structure or poor initial pose was registered correctly. An exhausted iteration limit returns `converged: false` and a candidate transform; callers should present that state before applying it.

Evaluate again with the returned transform to inspect both directional distributions and compare against the unaligned baseline. Rigid fitting can remove pose errors and redistribute deformation residuals; that is why registration status belongs alongside every metric.

## Async integration

The core has no DOM or Three.js dependency. It can run in a worker, or cooperatively yield during validation, sampling, tree construction, distance passes and ICP iterations on the main thread. Pass an `AbortSignal` for cancellation and `onProgress({stage, completed, total})` for progress. Progress restarts for each stage and each geometry; it is not a monotonic whole-job percentage. Budgets, iteration counts, fractions, thresholds, indices, coordinates and rigid transforms are validated. Memory is bounded by input geometry, target bounds and query bounds.

```ts
import { alignModels, evaluateModels, reportToJson } from './src/compare/index';

const raw = await evaluateModels(scan, groundTruth, {
  unit: 'mm', threshold: 0.5, sampleBudget: 10_000, seed: 1729,
});
const registration = await alignModels(scan, groundTruth, {
  unit: 'mm', maxCorrespondenceDistance: 5, signal,
});
if (registration.converged) {
  const fitted = await evaluateModels(scan, groundTruth, {
    unit: 'mm', threshold: 0.5,
    sourceTransform: registration.transform, alignment: 'rigid-icp',
  });
  const json = reportToJson(fitted);
  // Keep `raw` with `fitted` when interpreting pose-sensitive errors.
}
```

## Validation and primary references

`tests/compare.test.ts` covers known distances to triangle interiors/edges, identical models, area-weighted sampling, directional F-score definitions, deterministic sampling, recovered rotations/translations, large coordinate origins, refusal of reflections/scale, deformation residuals, low/nonoverlap rejection, units, invalid/degenerate geometry, preview provenance and cancellation. Synthetic tests establish implementation behavior on those fixtures; they do not establish clinical, metrological or task-specific acceptance thresholds.

- B. K. P. Horn, *Closed-form solution of absolute orientation using unit quaternions*, JOSA A 4(4), 629–642 (1987), [author's paper](https://people.csail.mit.edu/bkph/papers/Absolute_Orientation.pdf), [DOI](https://doi.org/10.1364/JOSAA.4.000629). The implementation uses its rotation formulation with fixed unit scale.
- S. Rusinkiewicz and M. Levoy, *Efficient Variants of the ICP Algorithm*, 3DIM (2001), [authors' publication page and paper](https://graphics.stanford.edu/papers/fasticp/). This documents ICP's dependence on an initial pose estimate and the role of correspondence/rejection/minimization choices. ModelDock implements the specific local point-to-point variant described above, not every variant in that work.
