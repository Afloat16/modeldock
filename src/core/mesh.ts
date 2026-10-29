import type { DecodeOptions, ModelPrimitive, ParsedModel } from '../shared/types';
import { count, finite, makeModel, srgbToLinear, TokenCursor, triangulatePolygon } from './common';

export function parseStl(buffer: ArrayBuffer, options: DecodeOptions): ParsedModel {
  const view = new DataView(buffer);
  const triangles = buffer.byteLength >= 84 ? view.getUint32(80, true) : 0;
  // Binary STL files are allowed to start with the word "solid".
  const binary = buffer.byteLength >= 84 && (84 + triangles * 50 === buffer.byteLength || !new TextDecoder().decode(buffer.slice(0, 80)).trimStart().startsWith('solid'));
  if (binary) {
    count(triangles, 'STL triangle count', options.maxTriangles);
    if (triangles * 3 > options.maxVertices) throw new Error('STL exceeds the configured vertex limit.');
    if (!triangles || buffer.byteLength < 84 + triangles * 50) throw new Error('Binary STL is empty or truncated.');
    const positions = new Float32Array(triangles * 9), normals = new Float32Array(triangles * 9);
    for (let i = 0; i < triangles; i++) {
      const at = 84 + i * 50;
      for (let k = 0; k < 9; k++) {
        positions[i * 9 + k] = finite(view.getFloat32(at + 12 + k * 4, true), 'STL vertex');
        normals[i * 9 + k] = finite(view.getFloat32(at + (k % 3) * 4, true), 'STL normal');
      }
    }
    return makeModel([{ name: 'STL surface', mode: 'triangles', positions, normals: normals.some(value => value !== 0) ? normals : undefined }], 'STL', ['STL carries no reliable units. Non-standard binary STL colours are ignored.']);
  }
  const text = new TextDecoder().decode(buffer);
  const cursor = new TokenCursor(text);
  const positions: number[] = [], normals: number[] = [];
  let token: string | undefined, triangleCount = 0;
  // Solid names can contain spaces; only facet sections describe geometry.
  const facetPattern = /\bfacet\s+normal\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)\s+outer\s+loop\s+([\s\S]*?)\s+endloop\s+endfacet\b/gi;
  for (const match of text.matchAll(facetPattern)) {
    triangleCount++;
    if (triangleCount > options.maxTriangles || triangleCount * 3 > options.maxVertices) throw new Error('STL exceeds the configured geometry limit.');
    const normal = [finite(match[1], 'STL normal'), finite(match[2], 'STL normal'), finite(match[3], 'STL normal')];
    const vertices = new TokenCursor(match[4]);
    for (let vertex = 0; vertex < 3; vertex++) {
      if (vertices.next()?.toLowerCase() !== 'vertex') throw new Error('Malformed ASCII STL facet.');
      positions.push(vertices.number('STL vertex'), vertices.number('STL vertex'), vertices.number('STL vertex'));
      normals.push(...normal);
    }
    if (vertices.next() !== undefined) throw new Error('ASCII STL facets must contain exactly three vertices.');
  }
  if (!triangleCount || !/^\s*solid(?:\s|$)/i.test(text) || !/\bendsolid\b/i.test(text)) throw new Error('Invalid or empty ASCII STL.');
  // Reject partial success, e.g. a valid first facet followed by a truncated one.
  let declaredFacets = 0;
  while ((token = cursor.next()) !== undefined) if (token.toLowerCase() === 'facet') declaredFacets++;
  if (declaredFacets !== triangleCount) throw new Error('ASCII STL contains a malformed or truncated facet.');
  return makeModel([{ name: 'STL surface', mode: 'triangles', positions: new Float32Array(positions), normals: normals.some(value => value !== 0) ? new Float32Array(normals) : undefined }], 'STL', ['STL carries no reliable units.']);
}

export function parseObj(buffer: ArrayBuffer, options: DecodeOptions): ParsedModel {
  const vertices: number[] = [], vertexColors: number[] = [], vertexNormals: number[] = [];
  const primitives: ModelPrimitive[] = [], warnings: string[] = [];
  let name = 'OBJ geometry', positions: number[] = [], normals: number[] = [], colors: number[] = [], linePositions: number[] = [], pointPositions: number[] = [];
  let allNormals = true, anyColor = false, emittedVertices = 0, triangles = 0, referencedGeometry = false;
  const flush = () => {
    if (positions.length) primitives.push({ name, mode: 'triangles', positions: new Float32Array(positions), normals: allNormals ? new Float32Array(normals) : undefined, colors: anyColor ? new Float32Array(colors) : undefined });
    if (linePositions.length) primitives.push({ name: `${name} lines`, mode: 'lines', positions: new Float32Array(linePositions) });
    if (pointPositions.length) primitives.push({ name: `${name} points`, mode: 'points', positions: new Float32Array(pointPositions) });
    positions = []; normals = []; colors = []; linePositions = []; pointPositions = []; allNormals = true; anyColor = false;
  };
  const vertexIndex = (token: string, n: number, what: string): number => {
    if (!/^[+-]?\d+$/.test(token)) throw new Error(`Invalid OBJ ${what} index.`);
    const raw = Number(token), i = raw > 0 ? raw - 1 : n + raw;
    if (!Number.isInteger(raw) || raw === 0 || i < 0 || i >= n) throw new Error(`OBJ ${what} index is outside the file.`);
    return i;
  };
  const addBudget = (n: number) => {
    emittedVertices += n;
    if (emittedVertices > options.maxVertices) throw new Error('OBJ expanded geometry exceeds the configured vertex limit.');
  };
  for (const raw of new TextDecoder().decode(buffer).split(/\r?\n/)) {
    const text = raw.split('#', 1)[0].trim();
    if (!text) continue;
    const fields = text.split(/\s+/), kind = fields.shift()!;
    if (kind === 'v') {
      if (vertices.length / 3 >= options.maxVertices) throw new Error('OBJ exceeds the configured vertex limit.');
      vertices.push(finite(fields[0], 'OBJ vertex'), finite(fields[1], 'OBJ vertex'), finite(fields[2], 'OBJ vertex'));
      if (fields.length >= 6) {
        const rgb = fields.slice(fields.length === 7 ? 4 : 3, fields.length === 7 ? 7 : 6).map(c => finite(c, 'OBJ color'));
        const scale = rgb.some(c => c > 1) ? 255 : 1;
        vertexColors.push(...rgb.map(c => srgbToLinear(c / scale)));
      } else vertexColors.push(NaN, NaN, NaN);
    } else if (kind === 'vn') {
      if (vertexNormals.length / 3 >= options.maxVertices) throw new Error('OBJ exceeds the configured normal limit.');
      vertexNormals.push(finite(fields[0], 'OBJ normal'), finite(fields[1], 'OBJ normal'), finite(fields[2], 'OBJ normal'));
    } else if (kind === 'g' || kind === 'o') { flush(); name = fields.join(' ') || 'OBJ geometry'; }
    else if (kind === 'f') {
      referencedGeometry = true;
      if (fields.length < 3) throw new Error('OBJ face has fewer than three vertices.');
      triangles += fields.length - 2;
      if (triangles > options.maxTriangles) throw new Error('OBJ exceeds the configured triangle limit.');
      const refs = fields.map(field => {
        const parts = field.split('/');
        return { vertex: vertexIndex(parts[0], vertices.length / 3, 'vertex'), normal: parts[2] ? vertexIndex(parts[2], vertexNormals.length / 3, 'normal') : undefined };
      });
      // Triangulate local corner numbers so differing normals on one vertex survive.
      const cornerPositions = refs.flatMap(ref => vertices.slice(ref.vertex * 3, ref.vertex * 3 + 3));
      const faceTriangles = triangulatePolygon(refs.map((_, i) => i), cornerPositions);
      addBudget(faceTriangles.length);
      for (const i of faceTriangles) {
        const ref = refs[i];
        positions.push(...vertices.slice(ref.vertex * 3, ref.vertex * 3 + 3));
        if (ref.normal !== undefined) normals.push(...vertexNormals.slice(ref.normal * 3, ref.normal * 3 + 3));
        else { allNormals = false; normals.push(0, 0, 0); }
        const color = vertexColors.slice(ref.vertex * 3, ref.vertex * 3 + 3);
        if (color.every(Number.isFinite)) { anyColor = true; colors.push(...color); } else colors.push(1, 1, 1);
      }
    } else if (kind === 'l') {
      referencedGeometry = true;
      if (fields.length < 2) throw new Error('OBJ line has fewer than two vertices.');
      const refs = fields.map(field => vertexIndex(field.split('/')[0], vertices.length / 3, 'line'));
      addBudget((refs.length - 1) * 2);
      for (let i = 1; i < refs.length; i++) linePositions.push(...vertices.slice(refs[i - 1] * 3, refs[i - 1] * 3 + 3), ...vertices.slice(refs[i] * 3, refs[i] * 3 + 3));
    } else if (kind === 'p') {
      referencedGeometry = true; addBudget(fields.length);
      for (const field of fields) { const i = vertexIndex(field, vertices.length / 3, 'point'); pointPositions.push(...vertices.slice(i * 3, i * 3 + 3)); }
    } else if (kind === 'mtllib' || kind === 'usemtl') {
      if (!warnings.length) warnings.push('OBJ material libraries and external textures are not loaded. Geometry and vertex colours are shown.');
    }
  }
  flush();
  if (!referencedGeometry && vertices.length) primitives.push({ name: 'OBJ vertices', mode: 'points', positions: new Float32Array(vertices), colors: vertexColors.every(Number.isFinite) ? new Float32Array(vertexColors) : undefined });
  return makeModel(primitives, 'OBJ', warnings);
}

export function parseOff(buffer: ArrayBuffer, options: DecodeOptions): ParsedModel {
  const cursor = new TokenCursor(new TextDecoder().decode(buffer));
  if (cursor.next() !== 'OFF') throw new Error('Only standard OFF geometry is supported; COFF/NOFF variants are not supported.');
  const vertices = count(cursor.next(), 'OFF vertex count', options.maxVertices), faces = count(cursor.next(), 'OFF face count', options.maxTriangles);
  count(cursor.next(), 'OFF edge count', 100_000_000);
  if (!vertices) throw new Error('OFF contains no vertices.');
  const positions = new Float32Array(vertices * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = cursor.number('OFF coordinate');
  const indices: number[] = [];
  for (let face = 0; face < faces; face++) {
    const n = count(cursor.next(), 'OFF polygon size', 100_000);
    if (n < 3 || indices.length / 3 + n - 2 > options.maxTriangles) throw new Error('OFF polygon is invalid or exceeds the triangle limit.');
    const polygon: number[] = [];
    for (let i = 0; i < n; i++) polygon.push(count(cursor.next(), 'OFF face index', vertices - 1));
    indices.push(...triangulatePolygon(polygon, positions));
  }
  if (cursor.next() !== undefined) throw new Error('OFF has additional data; per-face colour extensions are not supported.');
  return makeModel([{ name: 'OFF geometry', mode: faces ? 'triangles' : 'points', positions, indices: faces ? new Uint32Array(indices) : undefined }], 'OFF');
}

export function parseXyz(buffer: ArrayBuffer, options: DecodeOptions): ParsedModel {
  const positions: number[] = [], rawColors: number[] = [];
  let hasColor = false, colorByteRange = false;
  for (const raw of new TextDecoder().decode(buffer).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const parts = line.split(/[\s,;]+/);
    if (parts.length !== 3 && parts.length !== 6) throw new Error('XYZ expects one x y z or x y z r g b point per line.');
    if (positions.length / 3 >= options.maxVertices) throw new Error('XYZ exceeds the configured vertex limit.');
    positions.push(finite(parts[0], 'XYZ coordinate'), finite(parts[1], 'XYZ coordinate'), finite(parts[2], 'XYZ coordinate'));
    if (parts.length === 6) {
      hasColor = true;
      const rgb = parts.slice(3).map(c => finite(c, 'XYZ color'));
      if (rgb.some(c => c < 0 || c > 255)) throw new Error('XYZ colours must be in 0..1 or 0..255.');
      if (rgb.some(c => c > 1)) colorByteRange = true;
      rawColors.push(...rgb);
    } else rawColors.push(NaN, NaN, NaN);
  }
  const colors = hasColor ? new Float32Array(rawColors.map(c => Number.isFinite(c) ? srgbToLinear(c / (colorByteRange ? 255 : 1)) : 1)) : undefined;
  return makeModel([{ name: 'XYZ points', mode: 'points', positions: new Float32Array(positions), colors }], 'XYZ');
}
