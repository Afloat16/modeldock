import { checkpoint, type Vec3, type WorkOptions } from './types';

interface Node { min: Vec3; max: Vec3; start: number; end: number; left: number; right: number }
export interface Nearest { distanceSquared: number; point: Vec3; index: number }
function squared(a: readonly number[], b: readonly number[]): number { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; }
function segmentClosest(p: readonly number[], a: Vec3, b: Vec3): Vec3 {
  const d = b.map((v, k) => v - a[k]), length = d.reduce((s, v) => s + v * v, 0);
  const t = length ? Math.max(0, Math.min(1, d.reduce((s, v, k) => s + v * (p[k] - a[k]), 0) / length)) : 0;
  return a.map((v, k) => v + t * d[k]) as Vec3;
}
/** Closest point from triangle Voronoi regions, including segment/point degeneracies. */
export function closestPointOnTriangle(p: readonly number[], a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = b.map((v, k) => v - a[k]), ac = c.map((v, k) => v - a[k]);
  const cross2 = (ab[1] * ac[2] - ab[2] * ac[1]) ** 2 + (ab[2] * ac[0] - ab[0] * ac[2]) ** 2 + (ab[0] * ac[1] - ab[1] * ac[0]) ** 2;
  if (cross2 <= 1e-28 * Math.max(ab.reduce((s, v) => s + v * v, 0), ac.reduce((s, v) => s + v * v, 0)) ** 2) {
    return [segmentClosest(p, a, b), segmentClosest(p, a, c), segmentClosest(p, b, c)].sort((x, y) => squared(p, x) - squared(p, y))[0];
  }
  const dot = (u: number[], v: number[]) => u.reduce((s, value, k) => s + value * v[k], 0);
  const ap = a.map((v, k) => p[k] - v), d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = b.map((v, k) => p[k] - v), d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return a.map((x, k) => x + v * ab[k]) as Vec3; }
  const cp = c.map((v, k) => p[k] - v), d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return a.map((x, k) => x + w * ac[k]) as Vec3; }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return b.map((x, k) => x + w * (c[k] - x)) as Vec3; }
  const denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
  return a.map((x, k) => x + ab[k] * v + ac[k] * w) as Vec3;
}
function boxDistance(p: readonly number[], node: Node): number {
  let d = 0;
  for (let k = 0; k < 3; k++) d += (p[k] < node.min[k] ? node.min[k] - p[k] : p[k] > node.max[k] ? p[k] - node.max[k] : 0) ** 2;
  return d;
}

/** Median-partition KD tree for points, bounding-volume tree for triangle targets. */
export class SpatialIndex {
  private readonly order: Uint32Array;
  private readonly nodes: Node[] = [];
  private constructor(readonly data: Float64Array, readonly triangles: boolean) {
    this.order = Uint32Array.from({ length: data.length / (triangles ? 9 : 3) }, (_, i) => i);
  }
  private center(index: number, axis: number): number {
    const offset = index * (this.triangles ? 9 : 3);
    return this.triangles ? this.data[offset + axis] / 3 + this.data[offset + axis + 3] / 3 + this.data[offset + axis + 6] / 3 : this.data[offset + axis];
  }
  private select(start: number, end: number, nth: number, axis: number): void {
    // Hoare-style quickselect; middle-value pivot avoids sorted-input quadratic behavior.
    let low = start, high = end - 1;
    while (low < high) {
      const pivot = this.center(this.order[(low + high) >>> 1], axis);
      let i = low, j = high;
      while (i <= j) {
        while (this.center(this.order[i], axis) < pivot) i++;
        while (this.center(this.order[j], axis) > pivot) j--;
        if (i <= j) { const value = this.order[i]; this.order[i++] = this.order[j]; this.order[j--] = value; }
      }
      if (nth <= j) high = j; else if (nth >= i) low = i; else return;
    }
  }
  static async build(data: Float64Array, triangles: boolean, options: WorkOptions): Promise<SpatialIndex> {
    const tree = new SpatialIndex(data, triangles);
    if (!tree.order.length) throw new Error('Cannot index empty geometry.');
    const pending = [{ start: 0, end: tree.order.length, parent: -1, side: 'left' as 'left' | 'right' }];
    let work = 0;
    while (pending.length) {
      const { start, end, parent, side } = pending.pop()!;
      const node: Node = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], start, end, left: -1, right: -1 };
      const id = tree.nodes.push(node) - 1;
      if (parent >= 0) tree.nodes[parent][side] = id;
      for (let i = start; i < end; i++) {
        const offset = tree.order[i] * (triangles ? 9 : 3);
        for (let vertex = 0; vertex < (triangles ? 3 : 1); vertex++) for (let k = 0; k < 3; k++) {
          const value = data[offset + vertex * 3 + k]; node.min[k] = Math.min(node.min[k], value); node.max[k] = Math.max(node.max[k], value);
        }
        if (++work % 65536 === 0) await checkpoint(options, 'build spatial index', id, tree.order.length);
      }
      if (end - start > 8) {
        let axis = 0;
        for (let k = 1; k < 3; k++) if (node.max[k] - node.min[k] > node.max[axis] - node.min[axis]) axis = k;
        const mid = (start + end) >>> 1;
        tree.select(start, end, mid, axis);
        pending.push({ start: mid, end, parent: id, side: 'right' }, { start, end: mid, parent: id, side: 'left' });
      }
    }
    await checkpoint(options, 'spatial index ready', tree.order.length, tree.order.length);
    return tree;
  }
  nearest(p: readonly number[]): Nearest {
    let best: Nearest = { distanceSquared: Infinity, point: [0, 0, 0], index: -1 };
    const stack = [0];
    while (stack.length) {
      const node = this.nodes[stack.pop()!];
      if (boxDistance(p, node) >= best.distanceSquared) continue;
      if (node.left >= 0) {
        const left = boxDistance(p, this.nodes[node.left]), right = boxDistance(p, this.nodes[node.right]);
        if (left < right) { if (right < best.distanceSquared) stack.push(node.right); if (left < best.distanceSquared) stack.push(node.left); }
        else { if (left < best.distanceSquared) stack.push(node.left); if (right < best.distanceSquared) stack.push(node.right); }
      } else for (let i = node.start; i < node.end; i++) {
        const index = this.order[i], offset = index * (this.triangles ? 9 : 3), d = this.data;
        const point: Vec3 = this.triangles ? closestPointOnTriangle(p, [d[offset], d[offset + 1], d[offset + 2]], [d[offset + 3], d[offset + 4], d[offset + 5]], [d[offset + 6], d[offset + 7], d[offset + 8]]) : [d[offset], d[offset + 1], d[offset + 2]];
        const distanceSquared = squared(p, point);
        if (distanceSquared < best.distanceSquared) best = { distanceSquared, point, index };
      }
    }
    return best;
  }
}
