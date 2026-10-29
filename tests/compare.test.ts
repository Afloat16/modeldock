import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignLandmarks, alignModels, applyTransform, closestPointOnTriangle, composeTransforms, evaluateModels, identityTransform, inverseTransform, reportToCsv, reportToJson, validateTransform, type CompareModel, type RigidTransform, type Vec3 } from '../src/compare/index';

function cloud(points: number[][], id = 'cloud', origin?: Vec3): CompareModel {
  return { id, units: 'mm', origin, primitives: [{ mode: 'points', positions: new Float64Array(points.flat()) }] };
}
function mesh(triangles: number[], id = 'mesh'): CompareModel {
  return { id, units: 'mm', primitives: [{ mode: 'triangles', positions: new Float64Array(triangles) }] };
}
const tetra = [[0, 0, 0], [2, .1, 0], [0, 3, .2], [.3, .2, 4], [1, 1.2, .5], [1.7, 2.1, 2.8]];
function pose(angle = .13, translation: Vec3 = [.02, -.03, .01]): RigidTransform {
  return { rotation: [Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 1], translation };
}
function close(a: number, b: number, epsilon = 1e-9) { assert.ok(Math.abs(a - b) <= epsilon, `${a} != ${b} +/- ${epsilon}`); }

test('identical point clouds have exact zero, complete coverage, explicit metrics and deterministic reports', async () => {
  const report = await evaluateModels(cloud(tetra), cloud(tetra), { threshold: 0, sampleBudget: 32, includeDistances: true });
  close(report.accuracy.rmse, 0); close(report.completeness.rmse, 0);
  assert.equal(report.fScore, 1); assert.equal(report.chamfer.value, 0);
  assert.equal(report.source.sampling.queryCoverage, 'all-points');
  assert.equal(report.alignment.method, 'none'); assert.equal(report.alignment.applied, false);
  assert.equal(report.distances!.sourceToReference.length, tetra.length);
  assert.equal(JSON.parse(reportToJson(report)).schema, 'modeldock.comparison.v1');
  assert.match(reportToCsv(report), /approximateMax/);
});

test('identical mesh uses actual surface queries and exact target triangles', async () => {
  const triangle = mesh([0, 0, 0, 10, 0, 0, 0, 10, 0]);
  const report = await evaluateModels(triangle, triangle, { threshold: 1e-12, sampleBudget: 301, includeDistances: true });
  assert.ok(report.accuracy.rmse < 1e-12); assert.equal(report.fScore, 1);
  assert.equal(report.source.sampling.targetMethod, 'exact-triangle-bvh');
  assert.equal(report.source.sampling.queryCoverage, 'sampled-surface');
  assert.ok(report.distances!.sourcePoints[0] > 0 && report.distances!.sourcePoints[1] > 0);
});

test('triangle interiors use perpendicular surface distance instead of distances to vertices', async () => {
  const reference = mesh([0, 0, 0, 10, 0, 0, 0, 10, 0], 'stl-ground-truth');
  const source = cloud([[1, 1, 2], [2, 1, 2], [1, 2, 2]]);
  const report = await evaluateModels(source, reference, { threshold: 2, sampleBudget: 64 });
  close(report.accuracy.mean, 2); close(report.accuracy.rmse, 2); close(report.accuracy.p95, 2);
  assert.equal(report.precision, 1);
  const strict = await evaluateModels(source, reference, { threshold: 1.999, sampleBudget: 64 });
  assert.equal(strict.precision, 0);
  assert.deepEqual(closestPointOnTriangle([2, 0, 0], [0, 0, 0], [1, 0, 0], [0, 1, 0]), [1, 0, 0]);
  assert.deepEqual(closestPointOnTriangle([.5, 1, 0], [0, 0, 0], [1, 0, 0], [2, 0, 0]), [.5, 0, 0]);
});

test('BVH branches find the correct facet among separated triangle targets', async () => {
  const triangles = Array.from({ length: 24 }, (_, i) => [10 * i, 0, 0, 10 * i + 4, 0, 0, 10 * i, 4, 0]).flat();
  const report = await evaluateModels(cloud([[1, 1, .5], [111, 1, .75], [231, 1, 1.25]]), mesh(triangles), { threshold: 1, sampleBudget: 64 });
  close(report.accuracy.mean, 2.5 / 3);
  close(report.accuracy.rmse, Math.sqrt((.25 + .5625 + 1.5625) / 3));
  close(report.accuracy.approximateMax, 1.25);
  close(report.precision, 2 / 3);
});

test('KD-tree nearest distances agree with exhaustive search across both branches', async () => {
  const source = Array.from({ length: 53 }, (_, i) => [Math.sin(i * 2.13) * 7, Math.cos(i * .71) * 3, (i % 9) / 2]);
  const reference = Array.from({ length: 79 }, (_, i) => [Math.cos(i * 1.47) * 5, Math.sin(i * .91) * 4, (i % 11) / 3]);
  const expected = source.map(p => Math.min(...reference.map(q => Math.hypot(...p.map((v, k) => v - q[k])))));
  const report = await evaluateModels(cloud(source), cloud(reference), { threshold: .75, sampleBudget: 128, includeDistances: true });
  report.distances!.sourceToReference.forEach((value, i) => close(value, expected[i]));
  close(report.accuracy.mean, expected.reduce((a, b) => a + b, 0) / expected.length);
});

test('surface sampling is area-weighted across triangles, deterministic, and bounded', async () => {
  const model = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 12, 0, 0, 10, 2, 0]);
  const a = await evaluateModels(model, model, { threshold: 1e-10, sampleBudget: 1000, seed: 19, includeDistances: true });
  const b = await evaluateModels(model, model, { threshold: 1e-10, sampleBudget: 1000, seed: 19, includeDistances: true });
  const x = a.distances!.sourcePoints.filter((_, i) => i % 3 === 0);
  assert.equal(x.filter(v => v > 9).length, 800);
  assert.deepEqual(a.distances, b.distances);
  assert.equal(a.accuracy.count, 1000);
});

test('accuracy, completeness, Chamfer and threshold F-score use their stated direction and definition', async () => {
  const report = await evaluateModels(cloud([[0, 0, 0], [1, 0, 0]]), cloud([[0, 0, 0], [1, 0, 0], [2, 0, 0]]), { threshold: .1, sampleBudget: 10 });
  close(report.precision, 1); close(report.recall, 2 / 3); close(report.fScore, .8);
  close(report.chamfer.value, 1 / 6);
  close(report.completeness.mean, 1 / 3);
});

test('rigid landmark fit recovers rotation and translation without scale', () => {
  const transform = pose(.8, [3, -7, 4]), moved = tetra.map(p => applyTransform(p, transform));
  const recovered = alignLandmarks(moved, tetra);
  moved.forEach((p, i) => applyTransform(p, recovered).forEach((v, k) => close(v, tetra[i][k])));
  validateTransform(recovered);
  const composed = composeTransforms(recovered, transform);
  tetra.forEach(p => applyTransform(p, composed).forEach((v, k) => close(v, p[k])));
  tetra.forEach(p => applyTransform(applyTransform(p, transform), inverseTransform(transform)).forEach((v, k) => close(v, p[k])));
});

test('three non-collinear planar landmarks recover a rotation around multiple axes', () => {
  const transform: RigidTransform = { rotation: [0, 0, 1, 1, 0, 0, 0, 1, 0], translation: [5, -8, 11] };
  const points = [[0, 0, 0], [2, 0, 0], [.25, 3, 0]], moved = points.map(p => applyTransform(p, transform));
  const fit = alignLandmarks(moved, points);
  moved.forEach((p, i) => applyTransform(p, fit).forEach((v, k) => close(v, points[i][k])));
});

test('landmarks are stable near large double precision coordinate origins', () => {
  const origin = [1e12, -2e12, 3e12], points = tetra.map(p => p.map((v, k) => v + origin[k]));
  const moved = points.map(p => p.map((v, k) => v + [5, -7, 9][k]));
  const fit = alignLandmarks(moved, points);
  moved.forEach((p, i) => applyTransform(p, fit).forEach((v, k) => close(v, points[i][k], .002)));
});

test('proper rigid fitting does not silently reflect or scale a reconstruction', async () => {
  const reflected = tetra.map(p => [-p[0], p[1], p[2]]), fit = alignLandmarks(reflected, tetra);
  const report = await evaluateModels(cloud(reflected), cloud(tetra), { threshold: .001, sourceTransform: fit, alignment: 'landmarks', sampleBudget: 16 });
  assert.ok(report.accuracy.rmse > .1);
  assert.equal(report.alignment.scale, 1);
  assert.throws(() => validateTransform({ rotation: [-1, 0, 0, 0, 1, 0, 0, 0, 1], translation: [0, 0, 0] }), /reflections/);
  assert.throws(() => validateTransform({ rotation: [2, 0, 0, 0, 2, 0, 0, 0, 2], translation: [0, 0, 0] }), /scale/);
});

test('local ICP recovers a known rigid pose and preserves an independent unaligned baseline', async () => {
  const moved = tetra.map(p => applyTransform(p, pose()));
  const source = cloud(moved), reference = cloud(tetra);
  const before = await evaluateModels(source, reference, { threshold: .001, sampleBudget: 32 });
  const result = await alignModels(source, reference, { sampleBudget: 32, maxCorrespondenceDistance: 1 });
  assert.equal(result.converged, true); assert.ok(result.finalRmse < 1e-9);
  const after = await evaluateModels(source, reference, { threshold: .001, sampleBudget: 32, sourceTransform: result.transform, alignment: 'rigid-icp' });
  assert.ok(before.accuracy.rmse > .1); assert.ok(after.accuracy.rmse < 1e-9);
  assert.equal(after.alignment.applied, true); assert.equal(after.alignment.method, 'rigid-icp');
  assert.deepEqual(source.primitives[0].positions, new Float64Array(moved.flat()));
});

test('deformation remains measurable after rigid alignment', async () => {
  const deformed = tetra.map(p => [...p]); deformed[3][2] += 1;
  const fit = alignLandmarks(deformed, tetra);
  const report = await evaluateModels(cloud(deformed), cloud(tetra), { threshold: .01, sampleBudget: 32, sourceTransform: fit, alignment: 'landmarks' });
  assert.ok(report.accuracy.rmse > .1); assert.ok(report.fScore < 1);
});

test('ICP rejects nonoverlap and low reverse overlap instead of teleporting the source', async () => {
  const moved = tetra.map(p => p.map(v => v + 100));
  await assert.rejects(alignModels(cloud(moved), cloud(tetra), { sampleBudget: 32 }), /insufficient overlap/);
  const large = [...tetra, ...Array.from({ length: 100 }, (_, i) => [100 + i, i % 7, i % 11])];
  await assert.rejects(alignModels(cloud(tetra), cloud(large), { sampleBudget: 200, maxCorrespondenceDistance: .1 }), /insufficient overlap/);
});

test('origin offsets preserve common coordinates and equal units do not normalize geometry', async () => {
  const a = cloud(tetra, 'a', [1e9, -1e9, 1e9]);
  const b = cloud(tetra, 'b', [1e9 + 2, -1e9, 1e9]);
  const before = await evaluateModels(a, b, { threshold: .1, sampleBudget: 32 });
  assert.ok(before.accuracy.mean > .5);
  const transformed = { ...identityTransform(), translation: [2, 0, 0] as Vec3 };
  const after = await evaluateModels(a, b, { threshold: 0, sampleBudget: 32, sourceTransform: transformed });
  close(after.accuracy.rmse, 0);
});

test('empty, NaN, bad indices, degenerate landmarks and unsafe options fail clearly', async () => {
  const valid = cloud(tetra);
  await assert.rejects(evaluateModels(cloud([]), valid, { threshold: 1 }), /Empty/);
  await assert.rejects(evaluateModels(cloud([[NaN, 0, 0]]), valid, { threshold: 1 }), /non-finite/);
  const bad = mesh([0, 0, 0, 1, 0, 0, 0, 1, 0]); bad.primitives[0].indices = new Uint32Array([0, 1, 99]);
  await assert.rejects(evaluateModels(bad, valid, { threshold: 1 }), /outside/);
  await assert.rejects(evaluateModels(mesh([0, 0, 0, 1, 0, 0, 2, 0, 0]), valid, { threshold: 1 }), /Degenerate/);
  assert.throws(() => alignLandmarks([[0, 0, 0], [1, 0, 0], [2, 0, 0]], [[0, 0, 0], [1, 0, 0], [2, 0, 0]]), /collinear/);
  assert.throws(() => alignLandmarks([[0, 0, 0]], [[0, 0, 0]]), /three/);
  await assert.rejects(evaluateModels(valid, valid, { threshold: -1 }), /Threshold/);
  await assert.rejects(evaluateModels(valid, valid, { threshold: 1, sampleBudget: 200001 }), /budget/);
  await assert.rejects(evaluateModels(valid, valid, { threshold: 1, alignment: 'rigid-icp' }), /explicit source transform/);
});

test('unknown or mismatching units require explicit coordinate-unit acknowledgment', async () => {
  const a = cloud(tetra), b = { ...cloud(tetra), units: 'm' };
  await assert.rejects(evaluateModels(a, b, { threshold: 1 }), /shared coordinate unit/);
  await assert.rejects(alignModels(a, b), /shared coordinate unit/);
  const report = await evaluateModels(a, b, { threshold: .1, unit: 'mm', sampleBudget: 8 });
  assert.equal(report.unit, 'mm'); assert.equal(report.fScore, 1);
});

test('bounded surface fallback and input preview provenance are disclosed in reports', async () => {
  const triangles = Array.from({ length: 4 }, (_, i) => [i * 2, 0, 0, i * 2 + 1, 0, 0, i * 2, 1, 0]).flat();
  const model = mesh(triangles);
  model.preview = { sampling: 'stratified-blocks', topologyOmitted: true, originalTriangles: 1e8, fullyValidated: false };
  const report = await evaluateModels(model, model, { threshold: .1, sampleBudget: 32, targetPointBudget: 32, maxSurfaceTriangles: 3 });
  assert.equal(report.reference.sampling.targetMethod, 'sampled-surface-kdtree');
  assert.deepEqual(report.reference.sampling.sourcePreview, model.preview);
  assert.match(report.warnings.join(' '), /not the complete source file/);
  assert.match(report.warnings.join(' '), /overestimate/);
});

test('cancellation is honored before work and during asynchronous progress', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(evaluateModels(cloud(tetra), cloud(tetra), { threshold: 1, signal: controller.signal }), { name: 'AbortError' });
  const running = new AbortController();
  await assert.rejects(evaluateModels(cloud(tetra), cloud(tetra), { threshold: 1, signal: running.signal, onProgress(p) { if (p.stage === 'accuracy distances') running.abort(); } }), { name: 'AbortError' });
});

test('CSV exported user names cannot execute spreadsheet formulas', async () => {
  const model = { ...cloud(tetra), name: '=HYPERLINK("bad")' };
  const csv = reportToCsv(await evaluateModels(model, model, { threshold: 1, sampleBudget: 8 }));
  assert.match(csv, /'=HYPERLINK/);
});
