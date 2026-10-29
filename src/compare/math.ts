import { identityTransform, type RigidTransform, type Vec3 } from './types';

export function applyTransform(point: readonly number[], transform: RigidTransform): Vec3 {
  const r = transform.rotation, t = transform.translation;
  return [r[0] * point[0] + r[1] * point[1] + r[2] * point[2] + t[0], r[3] * point[0] + r[4] * point[1] + r[5] * point[2] + t[1], r[6] * point[0] + r[7] * point[1] + r[8] * point[2] + t[2]];
}
/** Composition: apply b first, then a. */
export function composeTransforms(a: RigidTransform, b: RigidTransform): RigidTransform {
  const result = identityTransform();
  for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
    result.rotation[row * 3 + col] = 0;
    for (let k = 0; k < 3; k++) result.rotation[row * 3 + col] += a.rotation[row * 3 + k] * b.rotation[k * 3 + col];
  }
  result.translation = applyTransform(b.translation, a);
  return result;
}
export function inverseTransform(t: RigidTransform): RigidTransform {
  const r = t.rotation;
  const result: RigidTransform = { rotation: [r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]], translation: [0, 0, 0] };
  result.translation = applyTransform(t.translation.map(x => -x), result);
  return result;
}
export function validateTransform(transform: RigidTransform): void {
  const r = transform.rotation;
  if (r.length !== 9 || transform.translation.length !== 3 || ![...r, ...transform.translation].every(Number.isFinite)) throw new Error('Transform must contain finite rotation and translation values.');
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const dot = r[i * 3] * r[j * 3] + r[i * 3 + 1] * r[j * 3 + 1] + r[i * 3 + 2] * r[j * 3 + 2];
    if (Math.abs(dot - (i === j ? 1 : 0)) > 1e-6) throw new Error('Transform must be rigid: scale and shear are not accepted.');
  }
  const det = r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
  if (Math.abs(det - 1) > 1e-6) throw new Error('Transform must be a proper rotation; reflections are not accepted.');
}

/** Symmetric Jacobi eigensolver, columns of vectors are normalized eigenvectors. */
function eigenSymmetric(input: number[], n: number): { values: number[]; vectors: number[] } {
  const a = input.slice(), v: number[] = Array.from({ length: n * n }, (_, i) => Math.floor(i / n) === i % n ? 1 : 0);
  for (let iteration = 0; iteration < 100; iteration++) {
    let p = 0, q = 1, largest = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.abs(a[i * n + j]) > largest) { largest = Math.abs(a[i * n + j]); p = i; q = j; }
    const scale = Math.max(...Array.from({ length: n }, (_, i) => Math.abs(a[i * n + i])), 1e-300);
    if (largest <= scale * 1e-15) break;
    const angle = 0.5 * Math.atan2(2 * a[p * n + q], a[q * n + q] - a[p * n + p]);
    const c = Math.cos(angle), s = Math.sin(angle), app = a[p * n + p], aqq = a[q * n + q], apq = a[p * n + q];
    a[p * n + p] = c * c * app - 2 * s * c * apq + s * s * aqq;
    a[q * n + q] = s * s * app + 2 * s * c * apq + c * c * aqq;
    a[p * n + q] = a[q * n + p] = 0;
    for (let k = 0; k < n; k++) {
      if (k !== p && k !== q) {
        const kp = a[k * n + p], kq = a[k * n + q];
        a[k * n + p] = a[p * n + k] = c * kp - s * kq;
        a[k * n + q] = a[q * n + k] = s * kp + c * kq;
      }
      const vp = v[k * n + p], vq = v[k * n + q];
      v[k * n + p] = c * vp - s * vq; v[k * n + q] = s * vp + c * vq;
    }
  }
  return { values: Array.from({ length: n }, (_, i) => a[i * n + i]), vectors: v };
}
function centroid(points: readonly (readonly number[])[]): Vec3 {
  // Subtract a local anchor before summation to preserve offsets near large origins.
  const anchor = points[0], sum: Vec3 = [0, 0, 0];
  for (const point of points) for (let axis = 0; axis < 3; axis++) sum[axis] += point[axis] - anchor[axis];
  return sum.map((value, axis) => anchor[axis] + value / points.length) as Vec3;
}
function requireNoncollinear(points: readonly (readonly number[])[], center: Vec3): void {
  const covariance = new Array<number>(9).fill(0);
  let scale = 0;
  for (const p of points) for (let i = 0; i < 3; i++) scale = Math.max(scale, Math.abs(p[i] - center[i]));
  if (!(scale > 0)) throw new Error('Degenerate correspondences: coincident points cannot determine a rigid pose.');
  for (const p of points) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) covariance[i * 3 + j] += ((p[i] - center[i]) / scale) * ((p[j] - center[j]) / scale);
  const values = eigenSymmetric(covariance, 3).values.sort((a, b) => b - a);
  if (values[1] < values[0] * 1e-10) throw new Error('Degenerate correspondences: collinear or nearly collinear points cannot determine a stable rigid pose.');
}
/** Horn's absolute-orientation quaternion solution; three non-collinear pairs minimum. */
export function alignLandmarks(source: readonly (readonly number[])[], reference: readonly (readonly number[])[]): RigidTransform {
  if (source.length !== reference.length || source.length < 3) throw new Error('Rigid alignment needs at least three paired landmarks with equal counts.');
  if ([...source, ...reference].some(p => p.length !== 3 || !p.every(Number.isFinite))) throw new Error('Landmarks must be finite 3D coordinates.');
  const sc = centroid(source), rc = centroid(reference);
  requireNoncollinear(source, sc); requireNoncollinear(reference, rc);
  let scale = 0;
  for (let i = 0; i < source.length; i++) for (let k = 0; k < 3; k++) scale = Math.max(scale, Math.abs(source[i][k] - sc[k]), Math.abs(reference[i][k] - rc[k]));
  const m = new Array<number>(9).fill(0);
  for (let p = 0; p < source.length; p++) for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i * 3 + j] += ((source[p][i] - sc[i]) / scale) * ((reference[p][j] - rc[j]) / scale);
  const [xx, xy, xz, yx, yy, yz, zx, zy, zz] = m;
  const n = [xx + yy + zz, yz - zy, zx - xz, xy - yx, yz - zy, xx - yy - zz, xy + yx, zx + xz, zx - xz, xy + yx, -xx + yy - zz, yz + zy, xy - yx, zx + xz, yz + zy, -xx - yy + zz];
  const eig = eigenSymmetric(n, 4), largest = eig.values.indexOf(Math.max(...eig.values));
  const [w, x, y, z] = Array.from({ length: 4 }, (_, i) => eig.vectors[i * 4 + largest]);
  const result: RigidTransform = { rotation: [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)], translation: [0, 0, 0] };
  const rotated = applyTransform(sc, result);
  result.translation = rc.map((value, i) => value - rotated[i]) as Vec3;
  validateTransform(result);
  return result;
}
