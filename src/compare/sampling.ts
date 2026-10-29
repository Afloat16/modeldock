import { checkpoint, type CompareModel, type ComparePrimitive, type Vec3, type WorkOptions } from './types';

export interface GeometryInfo {
  kind: 'surface' | 'points';
  points: number;
  triangles: number;
  area: number;
  min: Vec3;
  max: Vec3;
  warnings: string[];
}
export function randomGenerator(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a += 0x6d2b79f5; let t = a; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function pointAt(primitive: ComparePrimitive, index: number, origin: Vec3): Vec3 {
  return [primitive.positions[index * 3] + origin[0], primitive.positions[index * 3 + 1] + origin[1], primitive.positions[index * 3 + 2] + origin[2]];
}
export function triangleAt(primitive: ComparePrimitive, offset: number, origin: Vec3): [Vec3, Vec3, Vec3] {
  return [0, 1, 2].map(i => pointAt(primitive, primitive.indices?.[offset + i] ?? offset + i, origin)) as [Vec3, Vec3, Vec3];
}
function triangleArea(primitive: ComparePrimitive, offset: number): number {
  // Compute locally before adding origin; translation must not alter area.
  const [a, b, c] = triangleAt(primitive, offset, [0, 0, 0]);
  const u = b.map((v, i) => v - a[i]), v = c.map((value, i) => value - a[i]);
  return Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
}
export async function inspectGeometry(model: CompareModel, options: WorkOptions): Promise<GeometryInfo> {
  const origin = model.origin ?? [0, 0, 0];
  if (origin.length !== 3 || !origin.every(Number.isFinite)) throw new Error('Model origin must contain three finite coordinates.');
  const result: GeometryInfo = { kind: 'points', points: 0, triangles: 0, area: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], warnings: [] };
  let cloudPoints = 0, lineCount = 0, scanned = 0;
  for (const primitive of model.primitives) {
    if (primitive.mode === 'lines') { lineCount++; continue; }
    const p = primitive.positions;
    if (p.length % 3) throw new Error('Position array length must be a multiple of three.');
    result.points += p.length / 3;
    if (primitive.mode === 'points') cloudPoints += p.length / 3;
    for (let i = 0; i < p.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        if (!Number.isFinite(p[i + k]) || !Number.isFinite(p[i + k] + origin[k])) throw new Error('Geometry contains a non-finite coordinate.');
        result.min[k] = Math.min(result.min[k], p[i + k] + origin[k]); result.max[k] = Math.max(result.max[k], p[i + k] + origin[k]);
      }
      if (++scanned % 32768 === 0) await checkpoint(options, 'validate geometry', scanned, result.points);
    }
    if (primitive.mode === 'triangles') {
      const count = primitive.indices?.length ?? p.length / 3;
      if (count % 3) throw new Error('Triangle index/vertex count must be a multiple of three.');
      if (primitive.indices) for (let i = 0; i < count; i++) {
        if (primitive.indices[i] >= p.length / 3) throw new Error('Triangle index outside vertex array.');
        if (i && i % 98304 === 0) await checkpoint(options, 'validate triangles', i, count);
      }
      for (let i = 0; i < count; i += 3) {
        result.area += triangleArea(primitive, i);
        if (i && i % 49152 === 0) await checkpoint(options, 'measure surface', i, count);
      }
      result.triangles += count / 3;
    }
  }
  if (!result.points) throw new Error('Empty geometry: comparison requires points or triangle surfaces.');
  if (result.triangles && cloudPoints) throw new Error('Mixed point and surface geometry needs separate comparison models so sampling weights are unambiguous.');
  if (result.triangles) {
    if (!(result.area > 0) || !Number.isFinite(result.area)) throw new Error('Degenerate surface has no finite positive triangle area.');
    result.kind = 'surface';
  }
  if (lineCount) result.warnings.push('Line primitives were excluded from comparison.');
  await checkpoint(options, 'validated geometry', result.points, result.points);
  return result;
}

/** Stratified area-CDF draws require O(budget) memory even for millions of triangles. */
export async function sampleGeometry(model: CompareModel, info: GeometryInfo, budget: number, seed: number, options: WorkOptions): Promise<Float64Array> {
  const origin = model.origin ?? [0, 0, 0], random = randomGenerator(seed);
  if (info.kind === 'points') {
    const count = Math.min(budget, info.points), values = new Float64Array(count * 3);
    // Floyd's uniform sampling without replacement, O(budget) memory/work.
    let selected = 0, base = 0;
    const chosen = new Set<number>();
    for (let j = info.points - count; j < info.points; j++) {
      const candidate = Math.floor(random() * (j + 1));
      chosen.add(chosen.has(candidate) ? j : candidate);
    }
    const indices = [...chosen].sort((a, b) => a - b);
    for (const primitive of model.primitives) {
      if (primitive.mode !== 'points') continue;
      const n = primitive.positions.length / 3;
      while (selected < count && indices[selected] < base + n) {
        values.set(pointAt(primitive, indices[selected] - base, origin), selected * 3);
        selected++;
        if (selected % 8192 === 0) await checkpoint(options, 'sample points', selected, count);
      }
      base += n;
    }
    return values;
  }
  const values = new Float64Array(budget * 3);
  const targets = new Float64Array(budget);
  for (let i = 0; i < budget; i++) targets[i] = (i + random()) * info.area / budget;
  let cumulative = 0, selected = 0, scanned = 0;
  for (const primitive of model.primitives) {
    if (primitive.mode !== 'triangles') continue;
    const count = primitive.indices?.length ?? primitive.positions.length / 3;
    for (let offset = 0; offset < count; offset += 3) {
      const area = triangleArea(primitive, offset);
      cumulative += area;
      if (area > 0 && selected < budget && targets[selected] <= cumulative) {
        const [a, b, c] = triangleAt(primitive, offset, [0, 0, 0]);
        while (selected < budget && targets[selected] <= cumulative) {
          const root = Math.sqrt(random()), t = random();
          for (let k = 0; k < 3; k++) values[selected * 3 + k] = a[k] + root * ((1 - t) * (b[k] - a[k]) + t * (c[k] - a[k])) + origin[k];
          selected++;
        }
      }
      if (++scanned % 16384 === 0) await checkpoint(options, 'sample surface', scanned, info.triangles);
    }
  }
  if (selected !== budget) throw new Error('Surface area sampling failed due to unstable geometry magnitudes.');
  return values;
}

/** Only called after a triangle-count bound is enforced by the caller. */
export async function collectTriangles(model: CompareModel, info: GeometryInfo, options: WorkOptions): Promise<Float64Array> {
  const triangles = new Float64Array(info.triangles * 9), origin = model.origin ?? [0, 0, 0];
  let index = 0;
  for (const primitive of model.primitives) {
    if (primitive.mode !== 'triangles') continue;
    const count = primitive.indices?.length ?? primitive.positions.length / 3;
    for (let offset = 0; offset < count; offset += 3) {
      for (const p of triangleAt(primitive, offset, origin)) { triangles.set(p, index); index += 3; }
      if (index % (8192 * 9) === 0) await checkpoint(options, 'prepare triangle target', index / 9, info.triangles);
    }
  }
  return triangles;
}
