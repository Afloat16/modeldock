import type { DecodeOptions, ParsedModel } from '../shared/types';
import { count, finite, makeModel, srgbToLinear, TokenCursor, triangulatePolygon } from './common';

type Scalar = { bytes: number; read: (v: DataView, o: number, le: boolean) => number; integer: boolean; min: number; max: number };
const scalar: Record<string, Scalar> = {};
function define(names: string[], bytes: number, read: Scalar['read'], min: number, max: number, integer = true): void {
  for (const name of names) scalar[name] = { bytes, read, min, max, integer };
}
define(['char', 'int8'], 1, (v, o) => v.getInt8(o), -128, 127);
define(['uchar', 'uint8'], 1, (v, o) => v.getUint8(o), 0, 255);
define(['short', 'int16'], 2, (v, o, le) => v.getInt16(o, le), -32768, 32767);
define(['ushort', 'uint16'], 2, (v, o, le) => v.getUint16(o, le), 0, 65535);
define(['int', 'int32'], 4, (v, o, le) => v.getInt32(o, le), -2147483648, 2147483647);
define(['uint', 'uint32'], 4, (v, o, le) => v.getUint32(o, le), 0, 4294967295);
define(['float', 'float32'], 4, (v, o, le) => v.getFloat32(o, le), -3.402823466e38, 3.402823466e38, false);
define(['double', 'float64'], 8, (v, o, le) => v.getFloat64(o, le), -Number.MAX_VALUE, Number.MAX_VALUE, false);
type Property = { name: string; type: Scalar; listCount?: Scalar };
type Element = { name: string; count: number; properties: Property[] };

export function parsePly(buffer: ArrayBuffer, options: DecodeOptions): ParsedModel {
  const bytes = new Uint8Array(buffer);
  let headerEnd = -1, lineStart = 0;
  for (let i = 0; i < Math.min(bytes.length, 1024 * 1024); i++) {
    if (bytes[i] !== 10) continue;
    const line = new TextDecoder().decode(bytes.subarray(lineStart, i)).trim();
    if (line === 'end_header') { headerEnd = i + 1; break; }
    lineStart = i + 1;
  }
  if (headerEnd < 0) throw new Error('PLY header is missing end_header or exceeds 1 MiB.');
  const header = new TextDecoder().decode(bytes.subarray(0, headerEnd)).replace(/^\uFEFF/, '').split(/\r?\n/);
  if (header[0]?.trim() !== 'ply') throw new Error('Not a PLY file (missing ply signature).');
  const elements: Element[] = [];
  let format = '', current: Element | undefined;
  for (const raw of header.slice(1)) {
    const parts = raw.trim().split(/\s+/);
    switch (parts[0]) {
      case 'format':
        if (format || parts[2] !== '1.0' || !['ascii', 'binary_little_endian', 'binary_big_endian'].includes(parts[1])) throw new Error('Unsupported or duplicate PLY format declaration.');
        format = parts[1]; break;
      case 'element': {
        if (!parts[1] || elements.some(e => e.name === parts[1])) throw new Error('Missing or duplicate PLY element.');
        const limit = parts[1] === 'vertex' ? options.maxVertices : parts[1] === 'face' ? options.maxTriangles : Math.max(options.maxVertices, options.maxTriangles);
        current = { name: parts[1], count: count(parts[2], `PLY ${parts[1]} count`, limit), properties: [] };
        elements.push(current); break;
      }
      case 'property': {
        if (!current) throw new Error('PLY property appears before an element.');
        const isList = parts[1] === 'list';
        const name = parts[isList ? 4 : 2];
        const type = scalar[parts[isList ? 3 : 1]];
        const listCount = isList ? scalar[parts[2]] : undefined;
        if (!name || !type || (isList && (!listCount || !listCount.integer)) || current.properties.some(p => p.name === name)) throw new Error('Unsupported or duplicate PLY property.');
        current.properties.push({ name, type, listCount }); break;
      }
      case '': case 'comment': case 'obj_info': case 'end_header': break;
      default: throw new Error(`Unsupported PLY header directive: ${parts[0]}`);
    }
  }
  if (!format) throw new Error('PLY format declaration is missing.');
  const vertex = elements.find(e => e.name === 'vertex');
  if (!vertex?.count) throw new Error('PLY contains no vertices.');
  for (const name of ['x', 'y', 'z']) if (!vertex.properties.some(p => p.name === name && !p.listCount)) throw new Error(`PLY vertex property ${name} is missing.`);
  const has = (name: string) => vertex.properties.some(p => p.name === name && !p.listCount);
  const rgbNames = ['red', 'green', 'blue'].every(has) ? ['red', 'green', 'blue'] : ['diffuse_red', 'diffuse_green', 'diffuse_blue'].every(has) ? ['diffuse_red', 'diffuse_green', 'diffuse_blue'] : null;
  const gaussian = ['f_dc_0', 'f_dc_1', 'f_dc_2'].every(has);
  const hasNormals = ['nx', 'ny', 'nz'].every(has);
  const positions = new Float32Array(vertex.count * 3);
  const normals = hasNormals ? new Float32Array(vertex.count * 3) : undefined;
  const colors = rgbNames || gaussian ? new Float32Array(vertex.count * 3) : undefined;
  // Positions stay double precision until polygon projection has finished.
  const exactPositions = elements.some(e => e.name === 'face' && e.count) ? new Float64Array(vertex.count * 3) : null;
  const faces: number[][] = [];
  let triangleBudget = 0, offset = headerEnd;
  const view = new DataView(buffer);
  const cursor = format === 'ascii' ? new TokenCursor(new TextDecoder().decode(bytes.subarray(headerEnd))) : null;
  const read = (type: Scalar): number => {
    let value: number;
    if (cursor) {
      const token = cursor.next();
      if (token === undefined) throw new Error('PLY data is truncated.');
      value = Number(token);
      if (Number.isNaN(value) && !/^[-+]?nan$/i.test(token)) throw new Error('Invalid numeric value in PLY data.');
    } else {
      if (offset + type.bytes > bytes.length) throw new Error('PLY binary data is truncated.');
      value = type.read(view, offset, format === 'binary_little_endian'); offset += type.bytes;
    }
    if (type.integer && (!Number.isInteger(value) || value < type.min || value > type.max)) throw new Error('Invalid integer value in PLY data.');
    return value;
  };
  for (const element of elements) {
    if (!element.properties.length && element.count) throw new Error('PLY element has no properties.');
    for (let row = 0; row < element.count; row++) {
      for (const property of element.properties) {
        if (property.listCount) {
          const n = count(read(property.listCount), 'PLY list length', 1_000_000);
          const face = element.name === 'face' && ['vertex_indices', 'vertex_index'].includes(property.name);
          if (face && n < 3) throw new Error('A PLY face has fewer than three vertices.');
          if (face) {
            triangleBudget += n - 2;
            if (triangleBudget > options.maxTriangles) throw new Error('PLY faces exceed the configured triangle limit.');
          }
          const indices: number[] = [];
          for (let k = 0; k < n; k++) {
            const value = read(property.type);
            if (face) {
              if (!Number.isInteger(value) || value < 0 || value >= vertex.count) throw new Error('A PLY face references a vertex outside the file.');
              indices.push(value);
            }
          }
          if (face) faces.push(indices);
          continue;
        }
        const value = read(property.type);
        if (element.name !== 'vertex') continue;
        const axis = ['x', 'y', 'z'].indexOf(property.name);
        const normalAxis = ['nx', 'ny', 'nz'].indexOf(property.name);
        const colorAxis = rgbNames?.indexOf(property.name) ?? -1;
        const gaussianAxis = ['f_dc_0', 'f_dc_1', 'f_dc_2'].indexOf(property.name);
        if (axis >= 0) {
          positions[row * 3 + axis] = finite(value, 'PLY position');
          if (exactPositions) exactPositions[row * 3 + axis] = value;
        } else if (normals && normalAxis >= 0) normals[row * 3 + normalAxis] = finite(value, 'PLY normal');
        else if (colors && colorAxis >= 0) colors[row * 3 + colorAxis] = srgbToLinear(finite(value, 'PLY color') / (property.type.integer ? property.type.max : 1));
        else if (colors && !rgbNames && gaussianAxis >= 0) colors[row * 3 + gaussianAxis] = srgbToLinear(0.5 + 0.28209479177387814 * finite(value, 'PLY Gaussian color'));
      }
    }
  }
  const declaredFaces = elements.find(e => e.name === 'face')?.count ?? 0;
  if (declaredFaces && faces.length !== declaredFaces) throw new Error('PLY face vertex_indices property is missing or ambiguous.');
  const indices = faces.length ? new Uint32Array(triangleBudget * 3) : undefined;
  let indexOffset = 0;
  if (indices) for (const face of faces) {
    const triangle = triangulatePolygon(face, exactPositions ?? positions);
    indices.set(triangle, indexOffset); indexOffset += triangle.length;
  }
  const warnings: string[] = [];
  if (gaussian || has('scale_0') || has('opacity')) warnings.push('Gaussian-splat attributes are displayed as point centres only. Covariance, opacity, higher-order spherical harmonics and splat rendering are not supported.');
  if (has('alpha')) warnings.push('PLY per-vertex alpha is ignored.');
  return makeModel([{ name: 'PLY geometry', mode: indices ? 'triangles' : 'points', positions, normals, colors, indices }], 'PLY', warnings);
}
