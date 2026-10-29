import { ShapeUtils, Vector2 } from 'three';
import { DEFAULT_LIMITS, type DecodeOptions, type ModelPrimitive, type ParsedModel } from '../shared/types';

export function optionsWithDefaults(options: Partial<DecodeOptions> = {}): DecodeOptions {
  const result = { ...DEFAULT_LIMITS, ...options };
  for (const key of ['maxVertices', 'maxTriangles'] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] <= 0 || result[key] > 100_000_000) {
      throw new Error(`${key} must be an integer between 1 and 100,000,000.`);
    }
  }
  if (!['low', 'medium', 'high'].includes(result.cadQuality)) throw new Error('Invalid CAD quality.');
  return result;
}

export function count(value: string | number | undefined, label: string, maximum: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (value === undefined || !Number.isSafeInteger(n) || n < 0 || n > maximum) {
    throw new Error(`${label} is invalid or exceeds the configured limit (${maximum.toLocaleString('en-US')}).`);
  }
  return n;
}

export function finite(value: string | number | undefined, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (value === undefined || value === '' || !Number.isFinite(n) || Math.abs(n) > 3.402823466e38) {
    throw new Error(`${label} contains a non-finite or unsupported coordinate.`);
  }
  return n;
}

export function srgbToLinear(value: number): number {
  const c = Math.max(0, Math.min(1, value));
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Iterate a text payload without allocating an array of every token. */
export class TokenCursor {
  offset = 0;
  constructor(readonly text: string) {}
  next(): string | undefined {
    while (this.offset < this.text.length) {
      const c = this.text.charCodeAt(this.offset);
      if (c <= 32) { this.offset++; continue; }
      if (c === 35) { while (this.offset < this.text.length && this.text.charCodeAt(this.offset) !== 10) this.offset++; continue; }
      break;
    }
    if (this.offset >= this.text.length) return undefined;
    const start = this.offset;
    while (this.offset < this.text.length && this.text.charCodeAt(this.offset) > 32 && this.text.charCodeAt(this.offset) !== 35) this.offset++;
    return this.text.slice(start, this.offset);
  }
  number(label: string): number { return finite(this.next(), label); }
}

/** Convex and concave planar polygons; triangle input avoids triangulation overhead. */
export function triangulatePolygon(indices: readonly number[], positions: ArrayLike<number>): number[] {
  if (indices.length < 3) throw new Error('A face has fewer than three vertices.');
  if (indices.length === 3) return [...indices];
  if (indices.length > 100_000) throw new Error('A single polygon exceeds the 100,000-vertex safety limit.');
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < indices.length; i++) {
    const a = indices[i] * 3, b = indices[(i + 1) % indices.length] * 3;
    nx += (positions[a + 1] - positions[b + 1]) * (positions[a + 2] + positions[b + 2]);
    ny += (positions[a + 2] - positions[b + 2]) * (positions[a] + positions[b]);
    nz += (positions[a] - positions[b]) * (positions[a + 1] + positions[b + 1]);
  }
  const axis = Math.abs(nx) > Math.abs(ny) ? (Math.abs(nx) > Math.abs(nz) ? 0 : 2) : (Math.abs(ny) > Math.abs(nz) ? 1 : 2);
  const contour = indices.map(i => new Vector2(positions[i * 3 + (axis === 0 ? 1 : 0)], positions[i * 3 + (axis === 2 ? 1 : 2)]));
  const local = ShapeUtils.triangulateShape(contour, []);
  if (local.length !== indices.length - 2) throw new Error('A polygon could not be triangulated; check for repeated vertices, self-intersections or zero area.');
  return local.flatMap(triangle => triangle.map(index => indices[index]));
}

export function validateModel(model: ParsedModel, options: DecodeOptions): ParsedModel {
  let vertices = 0, triangles = 0;
  if (!model.primitives.length) throw new Error('The file contains no renderable geometry.');
  for (const primitive of model.primitives) {
    const { positions, normals, colors, indices, mode } = primitive;
    if (!positions.length || positions.length % 3) throw new Error('Invalid vertex array.');
    const n = positions.length / 3;
    vertices += n;
    if (vertices > options.maxVertices) throw new Error(`Model exceeds the vertex limit (${options.maxVertices.toLocaleString('en-US')}).`);
    for (let i = 0; i < positions.length; i++) if (!Number.isFinite(positions[i])) throw new Error('The model contains non-finite coordinates.');
    for (const attribute of [normals, colors]) {
      if (!attribute) continue;
      if (attribute.length !== positions.length) throw new Error('A vertex attribute has the wrong length.');
      for (let i = 0; i < attribute.length; i++) if (!Number.isFinite(attribute[i])) throw new Error('The model contains non-finite vertex attributes.');
    }
    if (indices) for (let i = 0; i < indices.length; i++) if (indices[i] >= n) throw new Error('A face references a vertex outside the file.');
    const elements = indices?.length ?? n;
    if (mode === 'triangles') {
      if (elements % 3) throw new Error('Invalid triangle index array.');
      triangles += elements / 3;
    } else if (mode === 'lines' && elements % 2) throw new Error('Invalid line index array.');
    if (triangles > options.maxTriangles) throw new Error(`Model exceeds the triangle limit (${options.maxTriangles.toLocaleString('en-US')}).`);
  }
  return model;
}

export function makeModel(primitives: ModelPrimitive[], sourceFormat: string, warnings: string[] = [], units = 'model units'): ParsedModel {
  return { primitives, sourceFormat, warnings, units };
}
