export * from './types';
export { applyTransform, composeTransforms, inverseTransform, alignLandmarks, validateTransform } from './math';
export { closestPointOnTriangle } from './spatial';
import { applyTransform, composeTransforms, inverseTransform, alignLandmarks, validateTransform } from './math';
import { collectTriangles, inspectGeometry, sampleGeometry, type GeometryInfo } from './sampling';
import { SpatialIndex } from './spatial';
import { checkpoint, identityTransform, validateBudget, type AlignmentOptions, type AlignmentResult, type CompareModel, type ComparisonReport, type DistanceSummary, type EvaluationOptions, type RigidTransform, type SamplingInfo, type Vec3, type WorkOptions } from './types';

function seedValue(seed?: number): number {
  if (seed !== undefined && (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff)) throw new Error('Seed must be an unsigned 32-bit integer.');
  return seed ?? 1729;
}
function coordinates(data: Float64Array, i: number): Vec3 { return [data[i * 3], data[i * 3 + 1], data[i * 3 + 2]]; }
function unitsFor(source: CompareModel, reference: CompareModel, unit?: string): string {
  if (unit !== undefined) { if (!unit.trim()) throw new Error('Comparison unit must be nonempty.'); return unit.trim(); }
  const a = source.unit ?? source.units, b = reference.unit ?? reference.units;
  if (!a || !b || a !== b || /^(model units|unknown|unspecified)$/i.test(a)) throw new Error('Confirm a shared coordinate unit before comparison. Units are never inferred or automatically converted.');
  return a;
}
interface Target { index: SpatialIndex; method: SamplingInfo['targetMethod']; count: number }
async function makeTarget(model: CompareModel, info: GeometryInfo, budget: number, maxTriangles: number, seed: number, options: WorkOptions): Promise<Target> {
  if (info.kind === 'surface' && info.triangles <= maxTriangles) {
    return { index: await SpatialIndex.build(await collectTriangles(model, info, options), true, options), method: 'exact-triangle-bvh', count: info.triangles };
  }
  const data = await sampleGeometry(model, info, budget, seed, options);
  return { index: await SpatialIndex.build(data, false, options), method: info.kind === 'surface' ? 'sampled-surface-kdtree' : info.points <= budget ? 'all-points-kdtree' : 'sampled-points-kdtree', count: data.length / 3 };
}
function describe(model: CompareModel, info: GeometryInfo, count: number, target: Target): SamplingInfo {
  return { method: info.kind === 'surface' ? 'area-weighted-surface' : 'uniform-point-subset', queries: count, availablePoints: info.points, availableTriangles: info.triangles, queryCoverage: info.kind === 'surface' ? 'sampled-surface' : count === info.points ? 'all-points' : 'sampled-points', targetMethod: target.method, targetCount: target.count, ...(model.preview ? { sourcePreview: model.preview } : {}) };
}
function summary(values: Float64Array, threshold: number): DistanceSummary {
  const ordered = values.slice().sort(), count = values.length;
  let mean = 0, squareMean = 0, within = 0;
  // Incremental mean avoids overflow from summing many moderately large distances.
  for (let i = 0; i < count; i++) { mean += (values[i] - mean) / (i + 1); squareMean += (values[i] ** 2 - squareMean) / (i + 1); if (values[i] <= threshold) within++; }
  function quantile(p: number): number { const x = (count - 1) * p, lo = Math.floor(x); return ordered[lo] + (ordered[Math.ceil(x)] - ordered[lo]) * (x - lo); }
  return { count, mean, rmse: Math.sqrt(squareMean), median: quantile(.5), p95: quantile(.95), approximateMax: ordered[count - 1], withinThreshold: within };
}

/** Evaluate geometry in preserved source coordinates. Alignment is explicit and never performed here. */
export async function evaluateModels(source: CompareModel, reference: CompareModel, options: EvaluationOptions): Promise<ComparisonReport> {
  const unit = unitsFor(source, reference, options.unit);
  if (!Number.isFinite(options.threshold) || options.threshold < 0) throw new Error('Threshold must be a finite nonnegative distance in the selected unit.');
  const budget = validateBudget(options.sampleBudget, 10_000, 200_000, 'Sample budget'), targetBudget = validateBudget(options.targetPointBudget, 100_000, 500_000, 'Target point budget');
  const maxTriangles = validateBudget(options.maxSurfaceTriangles, 200_000, 500_000, 'Surface triangle budget');
  const seed = seedValue(options.seed), transform = options.sourceTransform ?? identityTransform();
  validateTransform(transform);
  if (options.alignment && options.alignment !== 'none' && !options.sourceTransform) throw new Error('An alignment method requires its explicit source transform.');
  const inverse = inverseTransform(transform);
  const sourceInfo = await inspectGeometry(source, options), referenceInfo = await inspectGeometry(reference, options);
  const sourcePoints = await sampleGeometry(source, sourceInfo, budget, seed, options), referencePoints = await sampleGeometry(reference, referenceInfo, budget, seed, options);
  const sourceTarget = await makeTarget(source, sourceInfo, targetBudget, maxTriangles, seed, options), referenceTarget = await makeTarget(reference, referenceInfo, targetBudget, maxTriangles, seed, options);
  const forward = new Float64Array(sourcePoints.length / 3), reverse = new Float64Array(referencePoints.length / 3);
  for (let i = 0; i < forward.length; i++) {
    const point = applyTransform(coordinates(sourcePoints, i), transform);
    sourcePoints.set(point, i * 3);
    forward[i] = Math.sqrt(referenceTarget.index.nearest(point).distanceSquared);
    if (!Number.isFinite(forward[i])) throw new Error('Coordinate magnitudes exceed stable comparison distance range.');
    if (i % 1024 === 0) await checkpoint(options, 'accuracy distances', i, forward.length);
  }
  for (let i = 0; i < reverse.length; i++) {
    reverse[i] = Math.sqrt(sourceTarget.index.nearest(applyTransform(coordinates(referencePoints, i), inverse)).distanceSquared);
    if (!Number.isFinite(reverse[i])) throw new Error('Coordinate magnitudes exceed stable comparison distance range.');
    if (i % 1024 === 0) await checkpoint(options, 'completeness distances', i, reverse.length);
  }
  const accuracy = summary(forward, options.threshold), completeness = summary(reverse, options.threshold);
  const precision = accuracy.withinThreshold / accuracy.count, recall = completeness.withinThreshold / completeness.count;
  const warnings = [...sourceInfo.warnings, ...referenceInfo.warnings, 'Maximum is over query samples, not the exact Hausdorff distance. No signed distance, watertightness, normal or volume test is performed.'];
  for (const [label, model, target, info] of [['Source', source, sourceTarget, sourceInfo], ['Reference', reference, referenceTarget, referenceInfo]] as const) {
    if (target.method.startsWith('sampled-')) warnings.push(`${label} target uses a bounded sample; nearest distances can overestimate distance to the complete ${info.kind === 'surface' ? 'surface' : 'cloud'}.`);
    if (model.preview) {
      const preview = model.preview as Record<string, unknown>;
      if (preview.sampling !== 'all' || preview.topologyOmitted || preview.fullyValidated === false) warnings.push(`${label} is a sampled or partially validated file preview. Metrics describe the loaded representation, not the complete source file; omitted mesh topology cannot serve as an exact surface ground truth.`);
    }
  }
  const applied = transform.rotation.some((x, i) => Math.abs(x - identityTransform().rotation[i]) > 1e-14) || transform.translation.some(x => x !== 0);
  if (applied && options.alignment === 'none') throw new Error('A nonidentity source transform cannot be labeled as unaligned.');
  const report: ComparisonReport = {
    schema: 'modeldock.comparison.v1', createdAt: new Date().toISOString(),
    source: { id: source.id, name: source.name, origin: source.origin ?? [0, 0, 0], sampling: describe(source, sourceInfo, forward.length, sourceTarget) },
    reference: { id: reference.id, name: reference.name, origin: reference.origin ?? [0, 0, 0], sampling: describe(reference, referenceInfo, reverse.length, referenceTarget) },
    unit, threshold: options.threshold, sampleBudget: budget, seed,
    alignment: { method: options.alignment ?? (options.sourceTransform ? 'manual' : 'none'), applied, transform, scale: 1 },
    accuracy, completeness,
    chamfer: { value: .5 * (accuracy.mean + completeness.mean), definition: '0.5 * (mean(source-to-reference distance) + mean(reference-to-source distance))', squared: false },
    precision, recall, fScore: precision + recall ? 2 * precision * recall / (precision + recall) : 0, warnings,
  };
  if (options.includeDistances) report.distances = { sourcePoints: Array.from(sourcePoints), sourceToReference: Array.from(forward), referencePoints: Array.from(referencePoints), referenceToSource: Array.from(reverse) };
  await checkpoint(options, 'comparison complete', 1, 1);
  return report;
}

/** Local trimmed point-to-point rigid ICP. Use landmarks to initialize large pose differences. */
export async function alignModels(source: CompareModel, reference: CompareModel, options: AlignmentOptions = {}): Promise<AlignmentResult> {
  unitsFor(source, reference, options.unit);
  const budget = validateBudget(options.sampleBudget, 10_000, 200_000, 'Sample budget'), seed = seedValue(options.seed);
  const maxIterations = options.maxIterations ?? 50, tolerance = options.tolerance ?? 1e-7;
  const minimum = options.minInlierFraction ?? .3, trim = options.trimFraction ?? .9;
  if (!Number.isInteger(maxIterations) || maxIterations < 1 || maxIterations > 200) throw new Error('ICP iterations must be between 1 and 200.');
  if (!(minimum > 0 && minimum <= 1) || !(trim > 0 && trim <= 1) || !Number.isFinite(tolerance) || tolerance <= 0) throw new Error('ICP inlier/trim fractions must be in (0,1], and tolerance must be finite and positive.');
  let transform = options.initialTransform ?? identityTransform(); validateTransform(transform);
  const si = await inspectGeometry(source, options), ri = await inspectGeometry(reference, options);
  const sp = await sampleGeometry(source, si, budget, seed, options), rp = await sampleGeometry(reference, ri, budget, seed, options);
  // Early rejection of poses that inherently cannot be constrained.
  const initialPoints = Array.from({ length: sp.length / 3 }, (_, i) => coordinates(sp, i));
  alignLandmarks(initialPoints, initialPoints);
  const tree = await SpatialIndex.build(rp, false, options);
  const sourceTree = await SpatialIndex.build(sp, false, options);
  const diagonal = Math.hypot(...ri.max.map((v, i) => v - ri.min[i]));
  const cutoff = options.maxCorrespondenceDistance ?? diagonal * .15;
  if (!(cutoff > 0) || !Number.isFinite(cutoff)) throw new Error('ICP correspondence distance must be finite and positive.');
  let previous = Infinity, initialRmse = Infinity, inlierFraction = 0, finalRmse = Infinity;
  const diagnostics = ['ICP is a local best fit with fixed scale. Convergence does not establish correct correspondence or global registration. Evaluate and retain the unaligned baseline.'];
  async function pairs(current: RigidTransform) {
    const valid: { source: Vec3; reference: Vec3; d: number }[] = [];
    for (let i = 0; i < sp.length / 3; i++) {
      const p = applyTransform(coordinates(sp, i), current), n = tree.nearest(p);
      if (n.distanceSquared <= cutoff * cutoff) valid.push({ source: p, reference: n.point, d: n.distanceSquared });
      if (i % 2048 === 0) await checkpoint(options, 'ICP correspondences', i, sp.length / 3);
    }
    const inverse = inverseTransform(current);
    let reverseInliers = 0;
    for (let i = 0; i < rp.length / 3; i++) {
      if (sourceTree.nearest(applyTransform(coordinates(rp, i), inverse)).distanceSquared <= cutoff * cutoff) reverseInliers++;
      if (i % 2048 === 0) await checkpoint(options, 'ICP reverse overlap', i, rp.length / 3);
    }
    inlierFraction = Math.min(valid.length / (sp.length / 3), reverseInliers / (rp.length / 3));
    if (valid.length < 3 || inlierFraction < minimum) throw new Error(`ICP rejected insufficient overlap: ${(inlierFraction * 100).toFixed(1)}% inliers within ${cutoff}; need at least ${(minimum * 100).toFixed(1)}%. Use landmarks or a justified correspondence distance.`);
    valid.sort((a, b) => a.d - b.d);
    valid.length = Math.max(3, Math.floor(valid.length * trim));
    return { valid, rmse: Math.sqrt(valid.reduce((s, p) => s + p.d, 0) / valid.length) };
  }
  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const { valid, rmse } = await pairs(transform);
    if (iteration === 0) initialRmse = rmse;
    const delta = alignLandmarks(valid.map(p => p.source), valid.map(p => p.reference));
    transform = composeTransforms(delta, transform);
    const fitted = valid.reduce((s, p) => { const q = applyTransform(p.source, delta); return s + q.reduce((sum, value, k) => sum + (value - p.reference[k]) ** 2, 0); }, 0);
    finalRmse = Math.sqrt(fitted / valid.length);
    await checkpoint(options, 'ICP iteration', iteration + 1, maxIterations);
    // Tolerance is relative to reference extent, so unit choices do not change convergence.
    if (Math.abs(previous - rmse) <= tolerance * diagonal || finalRmse <= tolerance * diagonal) {
      finalRmse = (await pairs(transform)).rmse;
      return { transform, converged: true, iterations: iteration + 1, initialRmse, finalRmse, inlierFraction, diagnostics, sampleBudget: budget, seed };
    }
    previous = rmse;
  }
  finalRmse = (await pairs(transform)).rmse;
  diagnostics.push('Iteration limit reached; the candidate transform is not marked converged.');
  return { transform, converged: false, iterations: maxIterations, initialRmse, finalRmse, inlierFraction, diagnostics, sampleBudget: budget, seed };
}

export function reportToJson(report: ComparisonReport): string { return JSON.stringify(report, null, 2); }
export function reportToCsv(report: ComparisonReport): string {
  const rows: (string | number | boolean)[][] = [['metric', 'value', 'unit_or_definition'], ['schema', report.schema, ''], ['created_at', report.createdAt, 'ISO 8601'], ['source', report.source.name ?? report.source.id, ''], ['reference', report.reference.name ?? report.reference.id, ''], ['source_origin', JSON.stringify(report.source.origin), report.unit], ['reference_origin', JSON.stringify(report.reference.origin), report.unit], ['threshold', report.threshold, report.unit], ['seed', report.seed, ''], ['sample_budget', report.sampleBudget, ''], ['alignment_method', report.alignment.method, ''], ['alignment_applied', report.alignment.applied, ''], ['alignment_scale', report.alignment.scale, 'fixed'], ['transform_row_major_rotation', JSON.stringify(report.alignment.transform.rotation), ''], ['transform_translation', JSON.stringify(report.alignment.transform.translation), report.unit], ['source_sampling', JSON.stringify(report.source.sampling), ''], ['reference_sampling', JSON.stringify(report.reference.sampling), '']];
  for (const direction of ['accuracy', 'completeness'] as const) for (const metric of ['count', 'mean', 'rmse', 'median', 'p95', 'approximateMax', 'withinThreshold'] as const) rows.push([`${direction}.${metric}`, report[direction][metric], metric === 'count' || metric === 'withinThreshold' ? 'count' : report.unit]);
  rows.push(['chamfer', report.chamfer.value, report.chamfer.definition], ['precision', report.precision, 'fraction'], ['recall', report.recall, 'fraction'], ['f_score', report.fScore, 'fraction'], ['warnings', report.warnings.join(' '), '']);
  // Quote every cell; prefix formula-leading text for safe spreadsheet opening.
  return rows.map(row => row.map(value => { const raw = String(value), safe = typeof value === 'string' && /^[=+@-]/.test(raw) ? `'${raw}` : raw; return `"${safe.replaceAll('"', '""')}"`; }).join(',')).join('\r\n');
}
